'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const { createContext } = require('../core/context');
const { Accounts } = require('../core/auth/accounts');
const { Instances } = require('../core/instances');
const { createSources, searchAll, compatibleLoaders } = require('../core/sources');
const { ContentManager } = require('../core/content/manager');
const { Modpacks } = require('../core/content/modpacks');
const { BlockedWatcher } = require('../core/content/blocked');
const { exportMrpack, exportCurseForge, exportableEntries } = require('../core/content/export');
const { detectInstance, importInstance, scanLaunchers } = require('../core/content/importer');
const { listGameVersions } = require('../core/minecraft/versions');
const { listLoaderVersions, pickDefault, LOADER_NAMES } = require('../core/loaders');
const { prepareInstance, launch } = require('../core/minecraft/launch');
const { shortId } = require('../core/util');

const VERSION = require('../../package.json').version;
let win = null;
let ctx; let accounts; let instances; let sources; let content; let modpacks;
const running = new Map();
const blockedSessions = new Map();
let pendingOpenFiles = [];

// Instance pictures stored on disk are shown through junction-icon://<instance-id>/
protocol.registerSchemesAsPrivileged([{ scheme: 'junction-icon', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function dataRoot() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'JunctionData');
  const exeDir = path.dirname(app.getPath('exe'));
  if (fs.existsSync(path.join(exeDir, 'portable.txt'))) return path.join(exeDir, 'JunctionData');
  if (process.env.JUNCTION_DATA) return process.env.JUNCTION_DATA;
  return path.join(app.getPath('userData'), 'data');
}

let encryptionAvailable = false;
const osCrypto = {
  async encrypt(s) {
    if (encryptionAvailable) return `enc:${(await safeStorage.encryptStringAsync(String(s))).toString('base64')}`;
    return `b64:${Buffer.from(String(s), 'utf8').toString('base64')}`;
  },
  async decrypt(s) {
    s = String(s || '');
    if (s.startsWith('enc:')) return (await safeStorage.decryptStringAsync(Buffer.from(s.slice(4), 'base64'))).result;
    return Buffer.from(s.replace(/^b64:/, ''), 'base64').toString('utf8');
  },
};

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[${channel}]`, err);
      return { ok: false, error: String(err?.message || err), code: err?.code, manualUrl: err?.manualUrl };
    }
  });
}

function isHttpUrl(u) {
  try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; }
}

function startBlockedSession(instId, items) {
  if (!items?.length) return null;
  const sessionId = shortId(8);
  const w = new BlockedWatcher(content, instId, items, app.getPath('downloads'));
  w.on('update', (status) => send('blocked:update', { sessionId, status }));
  w.on('complete', () => { send('blocked:complete', { sessionId, instanceId: instId }); blockedSessions.delete(sessionId); });
  blockedSessions.set(sessionId, w);
  w.start();
  return { sessionId, status: w.status(), downloadsDir: app.getPath('downloads') };
}

function renderBody(project) {
  if (!project?.body) return '';
  const html = project.bodyFormat === 'markdown' ? marked.parse(project.body, { gfm: true, breaks: false }) : project.body;
  return html;
}

function registerIpc() {
  handle('app:info', async () => ({
    version: VERSION,
    dataDir: ctx.root,
    platform: process.platform,
    cfConfigured: sources.curseforge.configured(),
    msConfigured: Boolean(ctx.settings.get('msClientId')),
    encryption: encryptionAvailable,
    loaderNames: LOADER_NAMES,
  }));
  handle('settings:get', async () => ctx.settings.publicView());
  handle('settings:set', async (patch) => ctx.settings.update(patch));
  handle('tasks:list', async () => ctx.tasks.list());

  // --- versions & loaders
  handle('mc:versions', async (opts) => listGameVersions(ctx, opts || {}));
  handle('loader:versions', async (loader, mc) => {
    const list = await listLoaderVersions(ctx, loader, mc);
    return { list, default: pickDefault(list)?.version || null };
  });

  // --- instances
  const withState = (i) => ({
    ...i,
    running: running.has(i.id),
    state: running.get(i.id)?.state || null,
    iconSrc: typeof i.icon === 'string' && i.icon.startsWith('local:') ? `junction-icon://${i.id}/?v=${i.iconVersion || 0}` : (i.icon || null),
  });
  handle('inst:list', async () => (await instances.list()).map(withState));
  handle('inst:get', async (id) => withState(await instances.get(id)));
  handle('inst:pickIcon', async (id) => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a picture for this instance', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    if (r.canceled) return null;
    return withState(await instances.setIconFromFile(id, r.filePaths[0]));
  });
  handle('inst:setIcon', async (id, filePath) => withState(await instances.setIconFromFile(id, filePath)));
  handle('inst:clearIcon', async (id) => withState(await instances.clearIcon(id)));
  handle('inst:create', async (opts) => instances.create(opts));
  handle('inst:update', async (id, patch) => instances.update(id, patch));
  handle('inst:delete', async (id) => {
    if (running.has(id)) throw new Error('Stop the game before deleting this instance.');
    await instances.remove(id);
  });
  handle('inst:duplicate', async (id) => instances.duplicate(id));
  handle('inst:openFolder', async (id, sub) => {
    const p = sub ? path.join(instances.gameDir(id), sub) : instances.gameDir(id);
    fs.mkdirSync(p, { recursive: true });
    return shell.openPath(p);
  });
  handle('inst:log', async (id) => running.get(id)?.log || []);
  handle('inst:kill', async (id) => {
    const r = running.get(id);
    if (r?.child) r.child.kill();
  });
  handle('inst:launch', async (id) => {
    if (running.has(id)) throw new Error('This instance is already running.');
    const inst = await instances.get(id);
    const entry = { state: 'preparing', log: [], child: null };
    running.set(id, entry);
    send('inst:state', { id, state: 'preparing' });
    try {
      const creds = await accounts.launchCredentials();
      const prepared = await ctx.tasks.run(`Preparing ${inst.name}`, (t) => prepareInstance(ctx, inst, t.update), { instanceId: id });
      let pending = [];
      let flushTimer = null;
      const flush = () => { flushTimer = null; if (pending.length) { send('inst:log', { id, lines: pending }); pending = []; } };
      const onLog = (line) => {
        entry.log.push(line);
        if (entry.log.length > 8000) entry.log.splice(0, entry.log.length - 6000);
        pending.push(line);
        if (!flushTimer) flushTimer = setTimeout(flush, 150);
      };
      entry.child = await launch(ctx, inst, prepared, creds, {
        gameDir: instances.gameDir(id),
        onLog,
        onExit: async ({ code, crashReport, playedMs }) => {
          flush();
          running.delete(id);
          const cur = await instances.get(id).catch(() => null);
          if (cur) await instances.update(id, { playtimeMs: (cur.playtimeMs || 0) + playedMs });
          send('inst:state', { id, state: null, exit: { code, crashReport } });
          if (!win || win.isDestroyed()) {
            if (running.size === 0) app.quit(); // window was closed while playing
          } else if (ctx.settings.get('closeOnLaunch') && !win.isVisible()) {
            win.show();
          }
        },
      });
      entry.state = 'running';
      await instances.update(id, { lastPlayed: Date.now() });
      send('inst:state', { id, state: 'running' });
      if (ctx.settings.get('closeOnLaunch') && win) win.hide();
      return true;
    } catch (e) {
      running.delete(id);
      send('inst:state', { id, state: null, error: e.message });
      throw e;
    }
  });

  // --- content
  handle('content:list', async (id, type) => instances.listContent(id, type));
  handle('content:remove', async (id, rels) => content.removeFiles(id, rels));
  handle('content:toggle', async (id, rel, enabled) => content.setEnabled(id, rel, enabled));
  handle('content:pin', async (id, rel, pinned) => content.setPinned(id, rel, pinned));
  handle('content:addFiles', async (id, type) => {
    const filters = type === 'mod' ? [{ name: 'Mods', extensions: ['jar'] }] : [{ name: 'Packs', extensions: ['zip'] }];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
    if (r.canceled) return [];
    return ctx.tasks.run('Adding files', () => content.addLocalFiles(id, r.filePaths, type), { instanceId: id });
  });
  handle('content:identify', async (id) => ctx.tasks.run('Identifying files', (t) => content.identify(id, null, t.update), { instanceId: id }));
  handle('content:checkUpdates', async (id) => ctx.tasks.run('Checking for updates', () => content.checkUpdates(id), { instanceId: id }));
  handle('content:applyUpdates', async (id, updates) => {
    if (running.has(id)) throw new Error('Close the game before updating its mods.');
    const r = await ctx.tasks.run(`Updating ${updates.length} files`, (t) => content.applyUpdates(id, updates, t.update), { instanceId: id });
    return { ...r, blockedSession: startBlockedSession(id, r.blocked) };
  });
  handle('content:updateCandidates', async (id, q) => content.updateCandidates(id, q));
  handle('content:updateHistory', async (id) => content.updateHistory(id));
  handle('content:undoUpdate', async (id, stamp) => {
    if (running.has(id)) throw new Error('Close the game before undoing an update.');
    return ctx.tasks.run('Undoing update', () => content.undoUpdate(id, stamp), { instanceId: id });
  });
  handle('content:install', async (id, { source, projectId, type, versionId, title }) => {
    const r = await ctx.tasks.run(`Installing ${title || 'content'}`, (t) => content.installProject(id, { source, id: projectId }, type, { versionId, report: t.update }), { instanceId: id });
    return { ...r, blockedSession: startBlockedSession(id, r.blocked) };
  });
  handle('content:installed', async (id) => content.installedInfo(id));
  handle('content:compatible', async (id, source, projectId, type) => {
    const inst = await instances.get(id);
    return content.compatibleVersions(source, projectId, inst, type);
  });

  // --- browse
  handle('browse:search', async (params) => searchAll(ctx, sources, params));
  handle('browse:project', async (source, id) => {
    const p = source === 'modrinth' ? await sources.modrinth.project(id) : await sources.curseforge.project(id);
    return { ...p, bodyHtml: renderBody(p), body: undefined };
  });
  handle('browse:versions', async (source, id, filters = {}) => {
    const loaders = filters.loader ? (compatibleLoaders(filters.loader, filters.gameVersion).length ? compatibleLoaders(filters.loader, filters.gameVersion) : [filters.loader]) : undefined;
    const list = await sources[source].versions(id, { gameVersion: filters.gameVersion || undefined, loaders: filters.type === 'mod' ? loaders : undefined });
    return list.slice(0, 200).map((v) => ({ ...v, changelog: undefined }));
  });

  // --- modpacks
  handle('pack:installFromSource', async (opts) => {
    const r = await ctx.tasks.run(`Installing ${opts.title || 'modpack'}`, (t) => modpacks.installFromSource({ ...opts, report: t.update }));
    return { ...r, blockedSession: startBlockedSession(r.instance.id, r.blocked) };
  });
  handle('pack:importFile', async (filePath) => {
    let file = filePath;
    if (!file) {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Modpacks', extensions: ['mrpack', 'zip'] }] });
      if (r.canceled) return null;
      [file] = r.filePaths;
    }
    const r = await ctx.tasks.run(`Importing ${path.basename(file)}`, (t) => modpacks.installFile(file, { report: t.update }));
    return { ...r, blockedSession: startBlockedSession(r.instance.id, r.blocked) };
  });
  handle('pack:checkUpdate', async (id) => modpacks.checkPackUpdate(id));
  handle('pack:update', async (id, versionId) => {
    const inst = await instances.get(id);
    const r = await ctx.tasks.run(`Updating ${inst.name}`, (t) => modpacks.installFromSource({ source: inst.pack.source, projectId: inst.pack.projectId, versionId, instanceId: id, report: t.update }), { instanceId: id });
    return { ...r, blockedSession: startBlockedSession(id, r.blocked) };
  });

  // --- export / import
  handle('export:entries', async (id) => exportableEntries(instances.gameDir(id)));
  handle('export:run', async (id, format, opts) => {
    const inst = await instances.get(id);
    const ext = format === 'mrpack' ? 'mrpack' : 'zip';
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), `${(opts.name || inst.name).replace(/[\\/:*?"<>|]/g, '_')}-${opts.version || '1.0.0'}.${ext}`),
      filters: [{ name: format === 'mrpack' ? 'Modrinth modpack' : 'CurseForge modpack', extensions: [ext] }],
    });
    if (r.canceled) return null;
    const fn = format === 'mrpack' ? exportMrpack : exportCurseForge;
    const res = await ctx.tasks.run(`Exporting ${inst.name}`, () => fn({ instances, sources }, id, r.filePath, opts), { instanceId: id });
    shell.showItemInFolder(r.filePath);
    return res;
  });
  handle('import:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Pick an instance folder from another launcher' });
    if (r.canceled) return null;
    return detectInstance(r.filePaths[0]);
  });
  handle('import:scan', async () => {
    let knownVersions = null;
    try { knownVersions = new Set((await listGameVersions(ctx, { snapshots: true })).map((v) => v.id.toLowerCase())); } catch { /* offline: fall back to pattern checks */ }
    const [{ instances: found, notes }, mine] = await Promise.all([scanLaunchers({ knownVersions }), instances.list()]);
    const imported = new Set(mine.map((i) => i.importedFrom).filter(Boolean).map((p) => path.resolve(p)));
    // Instances imported before Junction recorded the source folder: match on name + version.
    const byName = new Set(mine.map((i) => `${i.name.toLowerCase()}|${i.mcVersion}`));
    return {
      notes,
      instances: found.map((f) => ({
        ...f,
        alreadyImported: imported.has(path.resolve(f.folder)) || byName.has(`${String(f.name).toLowerCase()}|${f.mcVersion}`),
      })),
    };
  });
  handle('import:detect', async (folder) => detectInstance(folder));
  handle('import:run', async (info, choices) => ctx.tasks.run(`Importing ${choices.name || info.name}`, (t) => importInstance({ instances, content }, info, choices, t.update)));

  // --- accounts
  handle('accounts:list', async () => ({ accounts: accounts.list(), canAddOffline: accounts.canAddOffline() }));
  handle('accounts:beginMs', async () => accounts.beginMicrosoftLogin());
  handle('accounts:completeMs', async (loginId) => accounts.completeMicrosoftLogin(loginId));
  handle('accounts:cancelMs', async (loginId) => accounts.cancelLogin(loginId));
  handle('accounts:addOffline', async (name) => accounts.addOffline(name));
  handle('accounts:setActive', async (id) => accounts.setActive(id));
  handle('accounts:remove', async (id) => accounts.remove(id));

  // --- blocked downloads helper
  handle('blocked:status', async (sid) => blockedSessions.get(sid)?.status() || null);
  handle('blocked:pickFiles', async (sid) => {
    const w = blockedSessions.get(sid);
    if (!w) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], defaultPath: app.getPath('downloads') });
    if (r.canceled) return w.status();
    return w.offer(r.filePaths);
  });
  handle('blocked:offer', async (sid, paths) => blockedSessions.get(sid)?.offer(paths) || null);
  handle('blocked:cancel', async (sid) => { blockedSessions.get(sid)?.stop(); blockedSessions.delete(sid); });

  // --- shell
  handle('shell:open', async (url) => { if (isHttpUrl(url)) await shell.openExternal(url); });
  handle('shell:openPath', async (p) => shell.openPath(p));
  handle('shell:openData', async () => shell.openPath(ctx.root));
  handle('dialog:pickJava', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], title: 'Pick java / javaw executable' });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:pendingFiles', async () => { const f = pendingOpenFiles; pendingOpenFiles = []; return f; });
}

function packFilesFromArgv(argv) {
  return argv.filter((a) => /\.(mrpack)$/i.test(a) && fs.existsSync(a));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#111317',
    title: 'Junction',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (isHttpUrl(url)) shell.openExternal(url); }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.JUNCTION_SCREENSHOT) {
    // Used by the automated UI smoke test.
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.JUNCTION_SCREENSHOT_JS) {
          await win.webContents.executeJavaScript(process.env.JUNCTION_SCREENSHOT_JS).catch((e) => console.error(e));
          await new Promise((r) => setTimeout(r, Number(process.env.JUNCTION_SCREENSHOT_WAIT || 1500)));
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.JUNCTION_SCREENSHOT, img.toPNG());
        app.quit();
      }, Number(process.env.JUNCTION_SCREENSHOT_DELAY || 2500));
    });
  }
}

app.on('second-instance', (_e, argv) => {
  const files = packFilesFromArgv(argv);
  if (files.length) { pendingOpenFiles.push(...files); send('app:openFiles', files); }
  if (!win || win.isDestroyed()) { if (ctx) createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.on('open-file', (e, file) => {
  e.preventDefault();
  pendingOpenFiles.push(file);
  send('app:openFiles', [file]);
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable().catch(() => false);
  // Dev hook for automated UI screenshots: swap in a fake network.
  const fetchImpl = process.env.JUNCTION_FETCH_MOCK ? require(process.env.JUNCTION_FETCH_MOCK) : undefined;
  ctx = await createContext(dataRoot(), { crypto: osCrypto, fetchImpl });
  accounts = await new Accounts(ctx).load();
  instances = new Instances(ctx);
  sources = createSources(ctx);
  content = new ContentManager(ctx, instances, sources);
  modpacks = new Modpacks(ctx, instances, content, sources);
  ctx.tasks.on('update', (t) => send('task:update', t));
  protocol.handle('junction-icon', async (req) => {
    const id = new URL(req.url).hostname;
    const file = /^[a-z0-9-]+$/.test(id) ? await instances.iconFile(id) : null;
    if (!file) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  pendingOpenFiles.push(...packFilesFromArgv(process.argv));
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  // Keep running if a game is open so its log and playtime are still tracked.
  if (running.size === 0) app.quit();
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
