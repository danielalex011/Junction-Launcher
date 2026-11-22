'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, protocol, net, nativeImage, clipboard, Notification } = require('electron');
const os = require('os');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const { createContext } = require('../core/context');
const { Accounts } = require('../core/auth/accounts');
const { Instances, isLinkedPack } = require('../core/instances');
const { createSources, searchAll, compatibleLoaders } = require('../core/sources');
const { News } = require('../core/news');
const { DEFAULT_APPEARANCE, BG_FILE } = require('../core/appearance');
const { Home } = require('../core/home');
const { composeHead } = require('../core/skin');
const { Skins } = require('../core/skins');
const { compareSources } = require('../core/sources/choose');
const { ErrorLog } = require('../core/errorlog');
const { ContentManager } = require('../core/content/manager');
const { Modpacks } = require('../core/content/modpacks');
const { PackLink } = require('../core/content/packlink');
const { BlockedWatcher, waitForDownload } = require('../core/content/blocked');
const { exportMrpack, exportCurseForge, exportableEntries } = require('../core/content/export');
const { detectInstance, importInstance, scanLaunchers } = require('../core/content/importer');
const { listGameVersions } = require('../core/minecraft/versions');
const { listLoaderVersions, pickDefault, LOADER_NAMES } = require('../core/loaders');
const { prepareInstance, launch } = require('../core/minecraft/launch');
const { shortId, sniffImage } = require('../core/util');
const { loadBuildConfig } = require('../core/build-config');
const { HttpError, describeError } = require('../core/http');
const { findJavas, testJava } = require('../core/javafinder');
const { runtimeRows, downloadRuntime, removeRuntime } = require('../core/minecraft/javainfo');
const { cacheInfo, clearCache } = require('../core/storage');
const { diskSpace, checkSpace, MIN_FREE_BYTES, MIN_FREE_PERCENT } = require('../core/space');
const { inspectSource, planCopy, copyFrom, compareWorld } = require('../core/content/worldcopy');
const { Templates } = require('../core/content/templates');
const { buildDebugInfo } = require('../core/debuginfo');
const { readLicenses } = require('../core/licenses');
const { notificationFor } = require('../core/notify');

const VERSION = require('../../package.json').version;
let win = null;
const bgDir = () => path.join(ctx.root, 'appearance'); // the chosen background picture (copied here)
let ctx; let accounts; let skins; let instances; let sources; let content; let templates; let modpacks; let home; let news; let packlink; let errorLog;
const running = new Map();
const blockedSessions = new Map();
let pendingOpenFiles = [];

// Instance pictures stored on disk are shown through junction-icon://<instance-id>/
protocol.registerSchemesAsPrivileged([
  { scheme: 'junction-icon', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'junction-bg', privileges: { standard: true, secure: true, supportFetchAPI: true } }, // the chosen background picture: junction-bg://bg/?v=<n>
  { scheme: 'junction-skin', privileges: { standard: true, secure: true, supportFetchAPI: true } }, // account heads: junction-skin://<account-id>/
]);

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

/** The cropped face + hat of an account's cached skin as a PNG (made on first use, then kept next to the skin). */
function accountHead(id) {
  try {
    const head = accounts.headFile(id);
    const raw = accounts.skinFile(id);
    if (!fs.existsSync(raw)) return null;
    if (fs.existsSync(head) && fs.statSync(head).mtimeMs >= fs.statSync(raw).mtimeMs) return fs.readFileSync(head);
    const img = nativeImage.createFromBuffer(fs.readFileSync(raw));
    const { width, height } = img.getSize();
    const bmp = composeHead(img.toBitmap(), width, height, 8);
    const png = nativeImage.createFromBitmap(bmp, { width: 64, height: 64 }).toPNG();
    fs.writeFileSync(head, png);
    return png;
  } catch { return null; }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[${channel}]`, err);
      // Download-server errors can carry whole HTML pages: show a plain sentence instead.
      return { ok: false, error: err instanceof HttpError ? describeError(err) : String(err?.message || err), code: err?.code, manualUrl: err?.manualUrl };
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
    totalMemMB: Math.floor(os.totalmem() / 1024 / 1024),
  }));
  handle('settings:get', async () => ctx.settings.publicView());
  handle('settings:set', async (patch) => ctx.settings.update(patch));
  handle('tasks:list', async () => ({ active: ctx.tasks.list(), history: ctx.tasks.getHistory() }));
  handle('tasks:pause', async (id) => ctx.tasks.pause(String(id)));
  handle('tasks:resume', async (id) => ctx.tasks.resume(String(id)));
  handle('tasks:cancel', async (id) => ctx.tasks.cancel(String(id)));
  handle('tasks:removeHistory', async (id) => ctx.tasks.removeHistory(String(id)));
  handle('tasks:clearHistory', async () => ctx.tasks.clearHistory());

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
    linked: isLinkedPack(i),
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
  handle('inst:update', async (id, patch) => {
    const cur = await instances.get(id);
    if (isLinkedPack(cur) && ((patch.mcVersion && patch.mcVersion !== cur.mcVersion) || (patch.loader && JSON.stringify(patch.loader) !== JSON.stringify(cur.loader)))) {
      throw new Error(`${cur.pack.name} sets the Minecraft version and loader. Unlink the modpack in Settings to change them.`);
    }
    return instances.update(id, patch);
  });
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
    const entry = { state: 'preparing', log: [], child: null, windowMode: 'keep' };
    running.set(id, entry);
    send('inst:state', { id, state: 'preparing' });
    try {
      const creds = await accounts.launchCredentials();
      const prepared = await ctx.tasks.run(`Preparing ${inst.name}`, (t) => prepareInstance(ctx, inst, t.update), { instanceId: id, kind: 'prepare', icon: 'instance' });
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
          } else if (entry.windowMode === 'hide' && !win.isVisible()) {
            win.show();
          } else if (entry.windowMode === 'minimize' && win.isMinimized()) {
            win.restore();
          }
        },
      });
      entry.state = 'running';
      await instances.update(id, { lastPlayed: Date.now() });
      send('inst:state', { id, state: 'running' });
      entry.windowMode = ctx.settings.get('onLaunch') || 'keep'; // what to do with Junction's window while the game runs
      if (win && !win.isDestroyed()) {
        if (entry.windowMode === 'hide') win.hide();
        else if (entry.windowMode === 'minimize') win.minimize();
      }
      return true;
    } catch (e) {
      running.delete(id);
      send('inst:state', { id, state: null, error: e.message });
      throw e;
    }
  });

  // --- content
  handle('content:list', async (id, type) => instances.listContent(id, type));
  // A linked modpack's own files: only the pack changes them (turning one off is still allowed).
  const refuseLocked = async (id, rels, what) => {
    const locked = await content.lockedRels(id, rels);
    if (!locked.length) return;
    const inst = await instances.get(id);
    throw new Error(`${locked.length === 1 ? `${path.basename(locked[0])} is` : `${locked.length} of these files are`} part of ${inst.pack.name}, so ${what}. You can turn ${locked.length === 1 ? 'it' : 'them'} off instead, or unlink the modpack in Settings.`);
  };
  handle('content:remove', async (id, rels) => { await refuseLocked(id, rels, "they can't be removed here"); return content.removeFiles(id, rels); });
  handle('content:toggle', async (id, rel, enabled) => content.setEnabled(id, rel, enabled));
  handle('content:pin', async (id, rel, pinned) => { await refuseLocked(id, [rel], 'they follow the pack\'s versions'); return content.setPinned(id, rel, pinned); });
  // Bulk actions for the selection bar: one call per action, at most one content.json write each.
  const relList = (rels) => {
    if (!Array.isArray(rels) || rels.some((r) => typeof r !== 'string')) throw new Error('Nothing selected.');
    return [...new Set(rels)];
  };
  handle('content:toggleMany', async (id, rels, enabled) => content.setEnabledMany(id, relList(rels), Boolean(enabled)));
  handle('content:pinMany', async (id, rels, pinned) => { await refuseLocked(id, relList(rels), 'they follow the pack\'s versions'); return content.setPinnedMany(id, relList(rels), Boolean(pinned)); });
  handle('content:counts', async (id) => {
    const out = {};
    for (const t of ['mod', 'resourcepack', 'shader', 'datapack']) out[t] = (await instances.listContent(id, t)).length;
    return out;
  });
  handle('content:authors', async (id) => packlink.authors(id));
  handle('content:copyList', async (id, rels) => {
    const md = await content.markdownList(id, relList(rels));
    clipboard.writeText(md);
    return { count: md ? md.split('\n').length : 0 };
  });
  handle('content:refreshSides', async (id) => content.refreshSides(id));
  handle('content:sendToInstance', async (id, rels, targetId) => {
    const list = relList(rels);
    if (running.has(targetId)) throw new Error('Close the game on the target instance before sending mods to it.');
    const r = await ctx.tasks.run(`Sending ${list.length} file${list.length === 1 ? '' : 's'}`, (t) => content.sendToInstance(id, list, targetId, { report: t.update }), { instanceId: targetId, kind: 'mod', icon: 'mod' });
    return { ...r, blockedSession: startBlockedSession(targetId, r.blocked) };
  });
  handle('content:addFiles', async (id, type) => {
    const filters = type === 'mod' ? [{ name: 'Mods', extensions: ['jar'] }] : [{ name: 'Packs', extensions: ['zip'] }];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
    if (r.canceled) return [];
    return ctx.tasks.run('Adding files', () => content.addLocalFiles(id, r.filePaths, type), { instanceId: id });
  });
  handle('content:identify', async (id, rels) => ctx.tasks.run('Identifying files', (t) => content.identify(id, Array.isArray(rels) ? relList(rels) : null, t.update), { instanceId: id }));
  handle('content:checkUpdates', async (id) => {
    const r = await ctx.tasks.run('Checking for updates', () => content.checkUpdates(id), { instanceId: id });
    home.record(id, r.filter((u) => !u.error).length).catch(() => {}); // keeps Home's "Updates available" in step
    return r;
  });
  const homeView = (d) => ({ ...d, recent: d.recent.map(withState), updates: d.updates.map((u) => ({ ...u, iconSrc: withState({ ...u, id: u.instanceId }).iconSrc })) });
  // Cached update info for the badges on instance cards (no network): { [instanceId]: { count, pack: versionName|null } }
  handle('home:badges', async () => Object.fromEntries((await home.state()).updates.map((u) => [u.instanceId, { count: u.count, pack: u.pack ? u.pack.versionName : null, packVersionId: u.pack ? u.pack.versionId : null }])));
  handle('quick:mods', async () => instances.modIndex());
  // ---- appearance: the background picture lives in <data>/appearance (copied there, never linked)
  const dropBackgrounds = () => { try { for (const f of fs.readdirSync(bgDir())) if (BG_FILE.test(f)) fs.rmSync(path.join(bgDir(), f), { force: true }); } catch { /* nothing there yet */ } };
  handle('appearance:pickBackground', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const ext = path.extname(src).toLowerCase().replace('.jpeg', '.jpg');
    const st = fs.statSync(src);
    if (!st.isFile() || st.size > 25 * 1024 * 1024) throw new Error('Pick a picture under 25 MB (PNG, JPG, WebP or GIF).');
    fs.mkdirSync(bgDir(), { recursive: true });
    dropBackgrounds();
    fs.copyFileSync(src, path.join(bgDir(), `background${ext}`));
    return ctx.settings.update({ appearance: { backgroundFile: `background${ext}`, backgroundVersion: Date.now() } });
  });
  handle('appearance:clearBackground', async () => { dropBackgrounds(); return ctx.settings.update({ appearance: { backgroundFile: null } }); });
  handle('appearance:reset', async () => { dropBackgrounds(); return ctx.settings.update({ appearance: { ...DEFAULT_APPEARANCE } }); });
  handle('appearance:zoom', async (pct) => { win?.webContents.setZoomFactor(Math.min(1.25, Math.max(0.9, Number(pct) / 100 || 1))); });
  handle('news:get', async () => news.state());
  handle('news:refresh', async (opts) => news.refresh(opts || {}));
  handle('home:state', async () => homeView(await home.state()));
  handle('home:refresh', async (opts) => { await home.refresh(opts || {}); return homeView(await home.state()); });
  handle('content:applyUpdates', async (id, updates) => {
    if (running.has(id)) throw new Error('Close the game before updating its mods.');
    const r = await ctx.tasks.run(`Updating ${updates.length} files`, (t) => content.applyUpdates(id, updates, t.update), { instanceId: id, kind: 'update', icon: 'mod' });
    home.record(id, 0).catch(() => {});
    return { ...r, blockedSession: startBlockedSession(id, r.blocked) };
  });
  handle('content:updateCandidates', async (id, q) => content.updateCandidates(id, q));
  handle('content:updateHistory', async (id) => content.updateHistory(id));
  handle('content:undoUpdate', async (id, stamp) => {
    if (running.has(id)) throw new Error('Close the game before undoing an update.');
    return ctx.tasks.run('Undoing update', () => content.undoUpdate(id, stamp), { instanceId: id });
  });
  handle('content:install', async (id, { source, projectId, type, versionId, title }) => {
    const r = await ctx.tasks.run(`Installing ${title || 'content'}`, (t) => content.installProject(id, { source, id: projectId }, type, { versionId, report: t.update }), { instanceId: id, kind: 'mod', icon: 'mod' });
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

  // Which version each site would install, for the "Install from…" window.
  handle('browse:compareSources', async ({ alts, type, instanceId }) => {
    const inst = instanceId && type !== 'modpack' ? await instances.get(instanceId) : null;
    return compareSources({
      alts, type, mcVersion: inst?.mcVersion,
      loadVersions: (source, id) => (inst ? content.compatibleVersions(source, id, inst, type) : sources[source].versions(id, {})),
    });
  });

  // --- modpacks
  // Packs whose author blocks third-party downloads: open the CurseForge page, wait (cancellable, in Activity) for the zip.
  const waitForManualPack = async (opts) => {
    const info = await modpacks.manualPackInfo(opts);
    if (!info) return null;
    shell.openExternal(info.pageUrl);
    return ctx.tasks.run(`Waiting for download… ${info.title}`, async (t) => {
      t.update(0, `Download ${info.fileName} on the CurseForge page. Junction picks it up from your Downloads folder.`);
      return waitForDownload({ dir: app.getPath('downloads'), fileName: info.fileName, sha1: info.sha1, signal: t.signal });
    }, { kind: 'download', icon: 'download' });
  };
  /**
   * Before a modpack install or update: if it would leave the drive with under 10% or 5 GB free, ask.
   * `estimate` returns the bytes it will write (or null when that can't be told, which never blocks).
   */
  const roomForPack = async (estimate) => {
    let needed = null;
    try { needed = await estimate(); } catch { return true; } // the install itself reports real problems
    if (needed == null) return true;
    const a = await checkSpace(ctx, needed);
    if (!a || !a.low) return true;
    const r = await dialog.showMessageBox(win, {
      type: 'warning', title: 'Low disk space', noLink: true,
      message: a.notEnough ? 'There may not be enough free space for this modpack' : 'This modpack will leave your drive nearly full',
      detail: `${a.message}\n\nJunction keeps its data on this drive:\n${ctx.root}`,
      buttons: ['Install anyway', 'Cancel'], defaultId: 1, cancelId: 1,
    });
    return r.response === 0;
  };
  handle('storage:space', async () => {
    const d = await diskSpace(ctx.root);
    return { path: ctx.root, ...(d || { free: null, total: null }), minFreeBytes: MIN_FREE_BYTES, minFreePercent: MIN_FREE_PERCENT };
  });
  handle('pack:installFromSource', async (opts) => {
    const manualFile = opts.source === 'curseforge' ? await waitForManualPack(opts) : null;
    if (!(await roomForPack(() => (manualFile ? modpacks.estimateArchive(manualFile) : modpacks.estimateFromSource(opts))))) return { cancelled: true };
    const r = await ctx.tasks.run(`Installing ${opts.title || 'modpack'}`, async (t) => {
      const res = await modpacks.installFromSource({ ...opts, manualFile, report: t.update });
      try { await packlink.label(res.instance.id); } catch (e) { res.warnings = [...(res.warnings || []), `Couldn't sort pack content from your additions yet: ${e.message}`]; }
      return res;
    }, { kind: 'modpack', icon: 'pack', heavy: true, createsInstance: true });
    return { ...r, blockedSession: startBlockedSession(r.instance.id, r.blocked) };
  });
  handle('pack:importFile', async (filePath) => {
    let file = filePath;
    if (!file) {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Modpacks', extensions: ['mrpack', 'zip'] }] });
      if (r.canceled) return null;
      [file] = r.filePaths;
    }
    if (!(await roomForPack(() => modpacks.estimateArchive(file)))) return null;
    const r = await ctx.tasks.run(`Importing ${path.basename(file)}`, (t) => modpacks.installFile(file, { report: t.update }), { kind: 'modpack', icon: 'pack', heavy: true, createsInstance: true });
    return { ...r, blockedSession: startBlockedSession(r.instance.id, r.blocked) };
  });
  // Files a pack install couldn't download (kept in content.json so they can be retried), and repairing a pack.
  handle('content:failed', async (id) => modpacks.failedDownloads(id));
  handle('content:retryFailed', async (id) => {
    if (running.has(id)) throw new Error('Close the game before retrying downloads for it.');
    return ctx.tasks.run('Retrying failed downloads', (t) => modpacks.retryFailed(id, { report: t.update }), { instanceId: id, kind: 'repair', icon: 'pack' });
  });
  handle('pack:repair', async (id) => {
    if (running.has(id)) throw new Error('Close the game before repairing its modpack.');
    const inst = await instances.get(id);
    const r = await ctx.tasks.run(`Repairing ${inst.name}`, (t) => modpacks.repair(id, { report: t.update }), { instanceId: id, kind: 'repair', icon: 'pack', heavy: true });
    return { ...r, blockedSession: startBlockedSession(id, r.blocked) };
  });
  handle('pack:checkUpdate', async (id) => {
    const u = await packlink.checkUpdate(id);
    home.recordPack(id, u).catch(() => {});
    return u;
  });
  // Linked modpacks: labels, the page's header and changelog, review + update / switch / reinstall, undo, unlink.
  handle('pack:label', async (id, force = false) => {
    if (!force && !(await packlink.needsLabels(id))) return { skipped: true };
    return ctx.tasks.run('Sorting pack content from your additions', () => packlink.label(id), { instanceId: id, kind: 'other', icon: 'pack' });
  });
  const packInfoCache = new Map();
  handle('pack:info', async (id) => {
    const inst = await instances.get(id);
    const key = `${inst.pack?.source}:${inst.pack?.projectId}`;
    const hit = packInfoCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60e3) return hit.info;
    const info = await packlink.info(id);
    // The blurred header picture comes through the main process as a data URL (checked type and size).
    if (info?.banner) {
      try {
        const res = await ctx.http.request(info.banner, { retries: 1, timeout: 15000 });
        const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
        const buf = Buffer.from(await res.arrayBuffer());
        info.banner = /^image\/(png|jpeg|webp|gif)$/.test(type) && buf.length < 4 * 1024 * 1024 ? `data:${type};base64,${buf.toString('base64')}` : null;
      } catch { info.banner = null; }
    }
    packInfoCache.set(key, { at: Date.now(), info });
    return info;
  });
  handle('pack:versions', async (id) => packlink.versions(id));
  handle('pack:changelog', async (id) => (await packlink.changelog(id)).map((v) => ({ ...v, html: v.bodyFormat === 'markdown' ? marked.parse(v.body || '', { gfm: true }) : v.body, body: undefined })));
  handle('pack:preview', async (id, versionId) => ctx.tasks.run('Comparing modpack versions', () => packlink.preview(id, versionId), { instanceId: id, kind: 'other', icon: 'pack' }));
  handle('pack:apply', async (id, versionId, opts = {}) => {
    if (running.has(id)) throw new Error('Close the game before changing its modpack.');
    const inst = await instances.get(id);
    const action = opts.action === 'reinstall' ? 'reinstall' : 'update';
    const p = inst.pack;
    if (!(await roomForPack(() => (['modrinth', 'curseforge'].includes(p?.source) ? modpacks.estimateFromSource({ source: p.source, projectId: p.projectId, versionId }) : null)))) return { cancelled: true };
    const title = action === 'reinstall' ? `Reinstalling ${inst.pack.name}` : `Updating ${inst.name}`;
    const r = await ctx.tasks.run(title, (t) => packlink.applyVersion(id, versionId, { action, keepAdditions: opts.keepAdditions !== false, keepDisabled: action === 'update', report: t.update }), { instanceId: id, kind: 'update', icon: 'pack', heavy: true });
    packInfoCache.clear();
    packlink.checkUpdate(id).then((u) => home.recordPack(id, u)).catch(() => {});
    return { ...r, blockedSession: startBlockedSession(id, r.blocked) };
  });
  handle('pack:update', async (id, versionId) => {
    if (running.has(id)) throw new Error('Close the game before changing its modpack.');
    const inst = await instances.get(id);
    const r = await ctx.tasks.run(`Updating ${inst.name}`, (t) => packlink.applyVersion(id, versionId, { report: t.update }), { instanceId: id, kind: 'update', icon: 'pack', heavy: true });
    return { ...r, blockedSession: startBlockedSession(id, r.blocked) };
  });
  handle('pack:history', async (id) => packlink.history(id));
  handle('pack:undo', async (id, stamp) => {
    if (running.has(id)) throw new Error('Close the game before undoing.');
    return ctx.tasks.run('Undoing modpack change', () => packlink.undo(id, stamp), { instanceId: id, kind: 'update', icon: 'pack' });
  });
  handle('pack:restoreFile', async (id, rel) => {
    if (running.has(id)) throw new Error('Close the game first.');
    return ctx.tasks.run(`Restoring ${path.basename(String(rel))}`, () => packlink.restoreFile(id, String(rel)), { instanceId: id, kind: 'repair', icon: 'pack' });
  });
  handle('pack:unlink', async (id) => {
    const inst = await instances.get(id);
    if (!inst.pack) return withState(inst);
    home.recordPack(id, null).catch(() => {});
    return withState(await instances.update(id, { pack: null, unlinkedPack: inst.pack }));
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
  /** A small data: URL for the import window, so it never needs file access. https pictures are passed through. */
  function iconPreview(info) {
    try {
      if (info.iconPath) {
        let img = nativeImage.createFromPath(info.iconPath);
        if (!img.isEmpty()) {
          const { width, height } = img.getSize();
          if (width > 64 || height > 64) img = img.resize(width >= height ? { width: 64 } : { height: 64 });
          return img.toDataURL();
        }
        // Formats Electron can't decode itself (e.g. WebP): send the bytes as they are if they're small.
        const st = fs.statSync(info.iconPath);
        if (st.size <= 64 * 1024) {
          const buf = fs.readFileSync(info.iconPath);
          const type = sniffImage(buf);
          if (type) return `data:${type.mime};base64,${buf.toString('base64')}`;
        }
      }
      if (typeof info.iconUrl === 'string' && /^https:\/\//.test(info.iconUrl)) return info.iconUrl;
    } catch { /* no preview: the window shows a letter instead */ }
    return null;
  }
  const withPreview = (info) => ({ ...info, preview: iconPreview(info) });
  handle('import:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Pick an instance folder from another launcher' });
    if (r.canceled) return null;
    return withPreview(await detectInstance(r.filePaths[0]));
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
        ...withPreview(f),
        alreadyImported: imported.has(path.resolve(f.folder)) || byName.has(`${String(f.name).toLowerCase()}|${f.mcVersion}`),
      })),
    };
  });
  handle('import:detect', async (folder) => withPreview(await detectInstance(folder)));
  handle('import:run', async (info, choices) => ctx.tasks.run(`Importing ${choices.name || info.name}`, (t) => importInstance({ instances, content }, info, choices, t.update), { kind: 'import', icon: 'instance', heavy: true, createsInstance: true }));

  // --- copy worlds and settings from another instance (the source is only ever read)
  // source: { instanceId } for one of Junction's instances, or { folder } for one found in another launcher.
  const copySource = async (targetId, source = {}) => {
    let dir;
    if (source.instanceId) {
      if (String(source.instanceId) === String(targetId)) throw new Error('That is the same instance. Pick a different one to copy from.');
      if (running.has(source.instanceId)) throw new Error('Close the game for the instance you are copying from first.');
      await instances.get(source.instanceId);
      dir = instances.gameDir(source.instanceId);
    } else if (typeof source.folder === 'string' && source.folder) {
      dir = (await detectInstance(source.folder, { quick: true, skipModScan: true })).gameDir;
    } else throw new Error('Pick an instance to copy from.');
    if (path.resolve(dir) === path.resolve(instances.gameDir(targetId))) throw new Error('That is the same instance. Pick a different one to copy from.');
    return dir;
  };
  handle('copy:inspect', async (targetId, source) => {
    const inst = await instances.get(targetId);
    const found = await inspectSource(await copySource(targetId, source));
    return { ...found, worlds: found.worlds.map((w) => ({ ...w, status: compareWorld(w.version, inst.mcVersion) })), targetVersion: inst.mcVersion };
  });
  handle('copy:plan', async (targetId, source, choices) => {
    const inst = await instances.get(targetId);
    const { entries, ...plan } = await planCopy({ sourceDir: await copySource(targetId, source), targetDir: instances.gameDir(targetId), targetMc: inst.mcVersion, choices: choices || {} });
    return { ...plan, count: entries.length, targetVersion: inst.mcVersion };
  });
  handle('copy:run', async (targetId, source, choices, confirmed) => {
    if (running.has(targetId)) throw new Error('Close the game before copying worlds into it.');
    const inst = await instances.get(targetId);
    const sourceDir = await copySource(targetId, source);
    return ctx.tasks.run(`Copying worlds and settings into ${inst.name}`, (t) => copyFrom({
      ctx, sourceDir, targetDir: instances.gameDir(targetId), backupRoot: path.join(instances.instDir(targetId), 'backups'),
      targetMc: inst.mcVersion, choices: choices || {}, confirmed: confirmed === true, report: t.update,
    }), { instanceId: targetId, kind: 'other', icon: 'instance', heavy: true });
  });

  // --- instance templates (the recipe of an instance: project IDs, no jar files)
  handle('template:list', async () => templates.list());
  handle('template:save', async (instId, opts) => templates.save(instId, opts || {}));
  handle('template:rename', async (id, name) => templates.rename(id, name));
  handle('template:delete', async (id) => templates.remove(id));
  handle('template:plan', async (id, target) => templates.plan(id, target || {}));
  handle('template:apply', async (instId, chosen, confirmed) => {
    const inst = await instances.get(instId);
    const r = await ctx.tasks.run(`Adding template content to ${inst.name}`, (t) => templates.apply(instId, chosen, { confirmed: confirmed === true, report: t.update }), { instanceId: instId, kind: 'mod', icon: 'mod', heavy: true });
    return { ...r, blockedSession: startBlockedSession(instId, r.blocked) };
  });

  // --- accounts
  handle('accounts:list', async () => ({
    accounts: accounts.list().map((a) => ({ ...a, iconSrc: a.skinAt ? `junction-skin://${a.id}/?v=${a.skinAt}` : null })),
    canAddOffline: accounts.canAddOffline(),
  }));
  handle('accounts:beginMs', async () => accounts.beginMicrosoftLogin());
  handle('accounts:completeMs', async (loginId) => accounts.completeMicrosoftLogin(loginId));
  handle('accounts:cancelMs', async (loginId) => accounts.cancelLogin(loginId));
  handle('accounts:addOffline', async (name) => accounts.addOffline(name));
  handle('accounts:setActive', async (id) => accounts.setActive(id));
  handle('accounts:remove', async (id) => accounts.remove(id));

  // --- skins (wardrobe + the active Microsoft account's skin and cape)
  handle('skins:list', async () => skins.list());
  handle('skins:profile', async (accountId) => skins.profile(accountId ? String(accountId) : null));
  handle('skins:inspect', async (file) => skins.inspectFile(file));
  handle('skins:add', async (opts) => skins.addFile({ path: opts?.path, name: opts?.name, model: opts?.model }));
  handle('skins:update', async (id, patch) => skins.update(String(id), { name: patch?.name, model: patch?.model }));
  handle('skins:remove', async (kind, id) => skins.remove(kind === 'history' ? 'history' : 'wardrobe', String(id)));
  handle('skins:clearHistory', async () => skins.clearHistory());
  handle('skins:keep', async (id) => skins.keepFromHistory(String(id)));
  handle('skins:importPlayer', async (name) => skins.importPlayer(name));
  handle('skins:apply', async (opts) => {
    const out = await skins.apply({ kind: opts?.kind === 'history' ? 'history' : 'wardrobe', id: String(opts?.id), accountId: opts?.accountId ? String(opts.accountId) : null, model: opts?.model });
    send('accounts:changed');
    return out;
  });
  handle('skins:reset', async (accountId) => {
    const out = await skins.resetSkin(accountId ? String(accountId) : null);
    send('accounts:changed');
    return out;
  });
  handle('skins:cape', async (accountId, capeId) => skins.setCape(accountId ? String(accountId) : null, capeId === null || capeId === undefined ? null : String(capeId)));

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
  handle('shell:openLogs', async () => { const p = path.join(ctx.root, 'logs'); fs.mkdirSync(p, { recursive: true }); return shell.openPath(p); });

  // --- Settings: memory, Java, storage, about
  handle('inst:modCounts', async () => instances.modCounts());
  handle('java:runtimes', async () => runtimeRows(ctx, instances));
  handle('java:find', async () => findJavas());
  handle('java:test', async (file) => testJava(String(file || '')));
  const javaTask = (major, repair) => ctx.tasks.run(`${repair ? 'Repairing' : 'Downloading'} Java ${Number(major)}`,
    (t) => downloadRuntime(ctx, major, t.update, { repair }).then(() => true), { kind: 'java', icon: 'pack', heavy: true });
  handle('java:download', async (major) => javaTask(major, false));
  handle('java:repair', async (major) => javaTask(major, true));
  handle('java:remove', async (major) => removeRuntime(ctx, instances, major, { running: [...running.keys()] }));
  handle('storage:cache', async () => cacheInfo(ctx));
  handle('storage:clearCache', async () => clearCache(ctx));
  handle('licenses:list', async () => readLicenses(app.getAppPath()));
  handle('app:copyDebugInfo', async () => {
    const text = buildDebugInfo({
      version: VERSION, settings: ctx.settings.publicView(), electron: process.versions.electron, node: process.versions.node,
      javas: await findJavas().catch(() => []), runtimes: await runtimeRows(ctx, instances).catch(() => []), instanceCount: (await instances.list()).length,
    });
    clipboard.writeText(text);
    return text;
  });
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
  // Errors and unhandled promise rejections from the page end up in <data>/logs/window-errors.log.
  win.webContents.on('console-message', (e, lvl, msg, line, src) => {
    const d = e && typeof e === 'object' && 'message' in e ? e : { level: lvl, message: msg, lineNumber: line, sourceId: src };
    if (d.level !== 'error' && d.level !== 3) return;
    errorLog?.write('window', d.message, `${path.basename(String(d.sourceId || ''))}:${d.lineNumber || 0}`);
  });
  win.webContents.on('render-process-gone', (_e, det) => errorLog?.write('crash', `The window process ended: ${det.reason}`));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => errorLog?.write('load', `Could not load ${url}: ${desc} (${code})`));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.JUNCTION_SCREENSHOT) {
    // Used by the automated UI smoke test.
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const size = /^(\d+)x(\d+)$/.exec(process.env.JUNCTION_SCREENSHOT_SIZE || '');
        if (size) { win.setMinimumSize(100, 100); win.setContentSize(Number(size[1]), Number(size[2])); await new Promise((r) => setTimeout(r, 600)); }
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
  if (process.platform === 'win32') app.setAppUserModelId('dk.junction.launcher'); // needed for Windows notifications
  Menu.setApplicationMenu(null);
  encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable().catch(() => false);
  // Dev hook for automated UI screenshots: swap in a fake network.
  const fetchImpl = process.env.JUNCTION_FETCH_MOCK ? require(process.env.JUNCTION_FETCH_MOCK) : undefined;
  ctx = await createContext(dataRoot(), { crypto: osCrypto, fetchImpl, builtins: loadBuildConfig({ appRoot: app.getAppPath() }) });
  errorLog = new ErrorLog(ctx.root);
  accounts = await new Accounts(ctx).load();
  skins = new Skins(ctx, accounts);
  instances = new Instances(ctx);
  sources = createSources(ctx);
  content = new ContentManager(ctx, instances, sources);
  templates = new Templates(ctx, instances, content);
  modpacks = new Modpacks(ctx, instances, content, sources);
  packlink = new PackLink(ctx, instances, content, modpacks, sources);
  home = new Home(ctx, instances, content, sources, packlink);
  news = new News(ctx);
  ctx.tasks.on('update', (t) => {
    send('task:update', t);
    const note = notificationFor(t, ctx.settings, Boolean(win && !win.isDestroyed() && win.isFocused()));
    if (note && Notification.isSupported()) {
      const n = new Notification({ ...note, icon: path.join(__dirname, '..', 'renderer', 'icon.png') });
      n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
      n.show();
    }
  });
  ctx.tasks.on('history', (list) => send('task:history', list));
  protocol.handle('junction-icon', async (req) => {
    const id = new URL(req.url).hostname;
    const file = /^[a-z0-9-]+$/.test(id) ? await instances.iconFile(id) : null;
    if (!file) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  protocol.handle('junction-bg', async () => {
    const f = ctx.settings.get('appearance')?.backgroundFile;
    if (!f || !BG_FILE.test(f)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(bgDir(), f)).toString());
  });
  protocol.handle('junction-skin', async (req) => {
    const id = new URL(req.url).hostname;
    const png = /^[a-z0-9-]+$/.test(id) ? accountHead(id) : null;
    return png ? new Response(png, { headers: { 'content-type': 'image/png' } }) : new Response('not found', { status: 404 });
  });
  accounts.fetchMissingSkins().then(() => send('accounts:changed')).catch(() => {});
  pendingOpenFiles.push(...packFilesFromArgv(process.argv));
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  // Keep running if a game is open so its log and playtime are still tracked.
  if (running.size === 0) app.quit();
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
