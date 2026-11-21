'use strict';
// Bring an existing instance over from the CurseForge app, Modrinth App,
// Prism/MultiMC, or a plain .minecraft-style folder — without re-downloading.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { readJson, exists, copyDir } = require('../util');
const { parseLoaderId, neoForgeToMc, listLoaderVersions, pickDefault } = require('../loaders');
const { readModMetadata } = require('./metadata');

const SKIP_TOP = new Set(['minecraftinstance.json', 'profile.json', 'mmc-pack.json', 'instance.cfg', 'logs', 'crash-reports', '.fabric', 'natives', '.mixin.out']);

const VERSION_TOKEN = /(?<![\w.])(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?(?:-(?:pre|rc|snapshot)-?\d+)?)(?![\w.])/gi;

/** Every version-looking token in a name, e.g. "Fabric 26.2-pre-5" -> ["26.2-pre-5"]. */
function versionCandidates(name) {
  return [...String(name).matchAll(VERSION_TOKEN)].map((m) => m[1].toLowerCase());
}

function guessFromName(name, knownVersions = null) {
  const loader = (String(name).match(/\b(neoforge|forge|fabric|quilt)\b/i) || [])[1]?.toLowerCase() || null;
  const cands = versionCandidates(name);
  let mc;
  if (knownVersions && knownVersions.size) {
    // Only accept something Mojang actually released ("pack 1.0.1" is not Minecraft 1.0.1).
    mc = cands.find((c) => knownVersions.has(c)) || null;
  } else {
    mc = cands.find((c) => /^(1\.\d{1,2}|[2-9]\d\.\d)/.test(c) && !/^1\.[0-1](\.|$)/.test(c)) || null;
  }
  return { loader, mc };
}

/** Reads the exact game + loader version that the loader printed the last time this instance ran. */
async function readLogVersion(gameDir) {
  let fh;
  try { fh = await fsp.open(path.join(gameDir, 'logs', 'latest.log'), 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(128 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const t = buf.subarray(0, bytesRead).toString('utf8');
    let m = t.match(/Loading Minecraft (\S+) with Fabric Loader (\S+)/);
    if (m) return { mcVersion: m[1], loader: 'fabric', loaderVersion: m[2] };
    m = t.match(/Loading Minecraft (\S+) with Quilt Loader (\S+)/);
    if (m) return { mcVersion: m[1], loader: 'quilt', loaderVersion: m[2] };
    const mc = (t.match(/--fml\.mcVersion,\s*([^,\]\s]+)/) || [])[1];
    const neo = (t.match(/--fml\.neoForgeVersion,\s*([^,\]\s]+)/) || [])[1];
    const forge = (t.match(/--fml\.forgeVersion,\s*([^,\]\s]+)/) || [])[1];
    if (mc && neo) return { mcVersion: mc, loader: 'neoforge', loaderVersion: neo };
    if (mc && forge) return { mcVersion: mc, loader: 'forge', loaderVersion: forge };
    return null;
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Inspects a folder and returns what we could work out about it. */
async function detectInstance(folder, { quick = false, skipModScan = false, knownVersions = null } = {}) {
  const info = { folder, gameDir: folder, name: path.basename(folder), mcVersion: null, loader: null, loaderVersion: null, from: 'folder' };

  const cf = await readJson(path.join(folder, 'minecraftinstance.json'), null);
  if (cf) {
    info.from = 'CurseForge app';
    info.name = cf.name || info.name;
    info.mcVersion = cf.gameVersion || cf.baseModLoader?.minecraftVersion || null;
    const thumb = cf.installedModpack?.thumbnailUrl || cf.installedModpack?.thumbnail || null;
    if (typeof thumb === 'string' && /^https:\/\//.test(thumb)) info.iconUrl = thumb;
    const l = parseLoaderId(cf.baseModLoader?.name || '');
    if (l) {
      info.loader = l.type;
      // "fabric-0.16.10-1.21.1" -> keep only the loader version
      info.loaderVersion = l.type === 'fabric' || l.type === 'quilt' ? l.version.replace(new RegExp(`-${(info.mcVersion || '').replace(/\./g, '\\.')}$`), '') : l.version;
    }
  }

  const mr = await readJson(path.join(folder, 'profile.json'), null);
  if (mr?.metadata) {
    info.from = 'Modrinth App';
    info.name = mr.metadata.name || info.name;
    info.mcVersion = mr.metadata.game_version || null;
    info.loader = mr.metadata.loader && mr.metadata.loader !== 'vanilla' ? mr.metadata.loader : null;
    info.loaderVersion = mr.metadata.loader_version?.id || null;
  }

  const mmc = await readJson(path.join(folder, 'mmc-pack.json'), null);
  if (mmc?.components) {
    info.from = 'Prism / MultiMC';
    for (const c of mmc.components) {
      if (c.uid === 'net.minecraft') info.mcVersion = c.version;
      const map = { 'net.fabricmc.fabric-loader': 'fabric', 'org.quiltmc.quilt-loader': 'quilt', 'net.minecraftforge': 'forge', 'net.neoforged': 'neoforge' };
      if (map[c.uid]) { info.loader = map[c.uid]; info.loaderVersion = c.version; }
    }
    for (const sub of ['.minecraft', 'minecraft']) {
      if (await exists(path.join(folder, sub))) { info.gameDir = path.join(folder, sub); break; }
    }
    try {
      const cfg = await fsp.readFile(path.join(folder, 'instance.cfg'), 'utf8');
      const m = cfg.match(/^name=(.+)$/m);
      if (m) info.name = m[1].trim();
      const key = (cfg.match(/^iconKey=(.+)$/m) || [])[1]?.trim();
      if (key && !/^(default|grass|infinity|flame|chicken|creeper|enderman|skeleton|squarecreeper|steve|herobrine|planks|stone|brick|diamond|dirt|gear|gold|iron|magitech|meat|netherstar|tnt|enderpearl|ftb_logo|ftb_glow|bee|fox|modrinth|bookshelf|cheese|coal)$/.test(key)) {
        const roots = [path.join(path.dirname(path.dirname(folder)), 'icons'), folder];
        for (const r of roots) {
          for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
            const f = path.join(r, key.endsWith(ext) ? key : `${key}${ext}`);
            if (await exists(f)) { info.iconPath = f; break; }
          }
          if (info.iconPath) break;
        }
      }
    } catch { /* optional */ }
  }

  if (/ModrinthApp[\\/]profiles/i.test(folder) && info.from === 'folder') info.from = 'Modrinth App';

  // The game log has the exact versions if the instance was ever launched.
  if (!info.mcVersion || !info.loaderVersion) {
    const fromLog = await readLogVersion(info.gameDir);
    if (fromLog && (!info.mcVersion || info.mcVersion === fromLog.mcVersion)) {
      info.mcVersion = fromLog.mcVersion;
      if (!info.loader || info.loader === fromLog.loader) {
        info.loader = fromLog.loader;
        info.loaderVersion = info.loaderVersion || fromLog.loaderVersion;
      }
      info.detectedBy = info.detectedBy || 'log';
    }
  }

  // Last resort: the folder name ("Fabric 26.1.2") and the mods themselves.
  const guess = guessFromName(info.name, knownVersions);
  if (!info.mcVersion && guess.mc) {
    info.mcVersion = guess.mc;
    info.detectedBy = 'name';
  }
  if (!info.loader && !skipModScan) {
    const counts = {};
    const mods = await fsp.readdir(path.join(info.gameDir, 'mods')).catch(() => []);
    for (const m of mods.filter((f) => f.endsWith('.jar')).slice(0, quick ? 6 : 40)) {
      const meta = readModMetadata(path.join(info.gameDir, 'mods', m));
      if (meta?.loader) counts[meta.loader] = (counts[meta.loader] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    info.loader = top?.[0] || guess.loader || (mods.length ? null : 'vanilla');
  }
  const modCount = (await fsp.readdir(path.join(info.gameDir, 'mods')).catch(() => [])).length;
  return { ...info, modCount };
}

// ---------------------------------------------------------------- finding instances automatically

/** Default places other launchers keep their instances, per OS. */
function launcherLocations({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const docs = path.join(home, 'Documents');
  if (platform === 'win32') {
    return [
      { launcher: 'Modrinth App', dir: path.join(appData, 'ModrinthApp', 'profiles'), db: path.join(appData, 'ModrinthApp', 'app.db') },
      { launcher: 'Modrinth App', dir: path.join(appData, 'com.modrinth.theseus', 'profiles'), db: path.join(appData, 'com.modrinth.theseus', 'app.db') },
      { launcher: 'CurseForge', dir: path.join(home, 'curseforge', 'minecraft', 'Instances') },
      { launcher: 'CurseForge', dir: path.join(docs, 'Curse', 'Minecraft', 'Instances') },
      { launcher: 'Prism Launcher', dir: path.join(appData, 'PrismLauncher', 'instances') },
      { launcher: 'PolyMC', dir: path.join(appData, 'PolyMC', 'instances') },
      { launcher: 'GDLauncher', dir: path.join(appData, 'gdlauncher_next', 'instances') },
      { launcher: 'ATLauncher', dir: path.join(appData, 'ATLauncher', 'instances') },
      { launcher: 'Minecraft Launcher', official: path.join(appData, '.minecraft') },
    ];
  }
  if (platform === 'darwin') {
    const sup = path.join(home, 'Library', 'Application Support');
    return [
      { launcher: 'Modrinth App', dir: path.join(sup, 'ModrinthApp', 'profiles'), db: path.join(sup, 'ModrinthApp', 'app.db') },
      { launcher: 'CurseForge', dir: path.join(docs, 'curseforge', 'minecraft', 'Instances') },
      { launcher: 'CurseForge', dir: path.join(home, 'curseforge', 'minecraft', 'Instances') },
      { launcher: 'Prism Launcher', dir: path.join(sup, 'PrismLauncher', 'instances') },
      { launcher: 'Minecraft Launcher', official: path.join(sup, 'minecraft') },
    ];
  }
  const data = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return [
    { launcher: 'Modrinth App', dir: path.join(data, 'ModrinthApp', 'profiles'), db: path.join(data, 'ModrinthApp', 'app.db') },
    { launcher: 'CurseForge', dir: path.join(home, 'curseforge', 'minecraft', 'Instances') },
    { launcher: 'Prism Launcher', dir: path.join(data, 'PrismLauncher', 'instances') },
    { launcher: 'Prism Launcher', dir: path.join(home, '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher', 'instances') },
    { launcher: 'Minecraft Launcher', official: path.join(home, '.minecraft') },
  ];
}

let sqlPromise = null;
function loadSqlJs() {
  if (!sqlPromise) {
    const initSqlJs = require('sql.js');
    const wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
    sqlPromise = initSqlJs({ wasmBinary });
  }
  return sqlPromise;
}

/**
 * Opens a *copy* of another app's SQLite database. Uses the real SQLite built into
 * Electron/Node (so recent changes still in "app.db-wal" are included); falls back
 * to sql.js, which only sees the main file.
 */
async function openDbCopy(dbFile) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'junction-db-'));
  const copy = path.join(tmp, 'app.db');
  await fsp.copyFile(dbFile, copy);
  for (const ext of ['-wal']) {
    await fsp.copyFile(dbFile + ext, copy + ext).catch(() => {});
  }
  const cleanup = () => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  let sqlite = null;
  try { sqlite = require('node:sqlite'); } catch { /* older runtime */ }
  if (sqlite?.DatabaseSync) {
    const db = new sqlite.DatabaseSync(copy);
    return { engine: 'sqlite', all: (sql) => db.prepare(sql).all(), close: async () => { db.close(); await cleanup(); } };
  }
  const SQL = await loadSqlJs();
  const db = new SQL.Database(new Uint8Array(await fsp.readFile(copy)));
  const all = (sql) => {
    const res = db.exec(sql);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
  };
  return { engine: 'sql.js', all, close: async () => { db.close(); await cleanup(); } };
}

const pick = (row, names) => {
  for (const n of names) if (row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
  return null;
};

function asVersionString(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v.id || null;
  const str = String(v).trim();
  if (str.startsWith('{')) { try { return JSON.parse(str).id || null; } catch { return null; } }
  return str.replace(/^"|"$/g, '') || null;
}

/** Reads Modrinth App's own instance list (name, game version, loader + version) from app.db. */
async function readModrinthDb(dbFile) {
  const out = new Map();
  out.diag = null;
  if (!(await exists(dbFile))) return out;
  let db;
  try {
    db = await openDbCopy(dbFile);
    const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    const order = ['profiles', ...tables.filter((t) => t !== 'profiles')].filter((t) => tables.includes(t));
    let used = null;
    for (const t of order) {
      const cols = db.all(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).map((c) => c.name);
      if (t !== 'profiles' && !cols.includes('game_version')) continue;
      used = { table: t, cols };
      for (const row of db.all(`SELECT * FROM "${t.replace(/"/g, '""')}"`)) {
        const rec = {
          path: pick(row, ['path', 'profile_path', 'folder']),
          name: pick(row, ['name']),
          mcVersion: pick(row, ['game_version', 'minecraft_version', 'mc_version']),
          loader: pick(row, ['mod_loader', 'loader', 'modloader']),
          loaderVersion: asVersionString(pick(row, ['mod_loader_version', 'loader_version', 'modloader_version'])),
          iconPath: pick(row, ['icon_path', 'icon']),
        };
        // Some versions keep everything in a JSON column.
        for (const v of Object.values(row)) {
          if (typeof v !== 'string' || !v.startsWith('{')) continue;
          try {
            const j = JSON.parse(v);
            const m = j.metadata || j;
            rec.path = rec.path || j.path || null;
            rec.name = rec.name || m.name || null;
            rec.mcVersion = rec.mcVersion || m.game_version || null;
            rec.loader = rec.loader || m.loader || null;
            rec.loaderVersion = rec.loaderVersion || asVersionString(m.loader_version);
            rec.iconPath = rec.iconPath || m.icon || null;
          } catch { /* not JSON */ }
        }
        const loader = rec.loader ? String(rec.loader).replace(/"/g, '').toLowerCase() : null;
        const entry = {
          name: rec.name, mcVersion: rec.mcVersion ? String(rec.mcVersion) : null,
          loader: loader || null, loaderVersion: loader === 'vanilla' ? null : rec.loaderVersion,
          iconPath: typeof rec.iconPath === 'string' ? rec.iconPath : null,
        };
        const keys = [rec.path && path.basename(String(rec.path).replace(/\\/g, '/')), rec.name].filter(Boolean);
        for (const k of keys) if (!out.has(String(k))) out.set(String(k), entry);
      }
      if (out.size) break;
    }
    out.diag = used ? `${db.engine}; table ${used.table} (${used.cols.join(', ')}); ${out.size} entries` : `${db.engine}; no profiles table among: ${tables.join(', ') || 'none'}`;
  } catch (e) {
    out.diag = `error: ${e.message}`;
  } finally {
    if (db) await db.close().catch(() => {});
  }
  return out;
}

/** "fabric-loader-0.16.10-1.21.1", "1.20.1-forge-47.2.0", "neoforge-21.1.77", "1.21.1" -> loader info. */
function parseVersionId(id) {
  const s = String(id || '');
  let m = s.match(/^fabric-loader-(.+)-(\d[^-]*)$/);
  if (m) return { loader: 'fabric', loaderVersion: m[1], mcVersion: m[2] };
  m = s.match(/^quilt-loader-(.+)-(\d[^-]*)$/);
  if (m) return { loader: 'quilt', loaderVersion: m[1], mcVersion: m[2] };
  m = s.match(/^(\d[^-]*)-forge-(.+)$/);
  if (m) return { loader: 'forge', loaderVersion: m[2], mcVersion: m[1] };
  m = s.match(/^neoforge-(.+)$/);
  if (m) return { loader: 'neoforge', loaderVersion: m[1], mcVersion: neoForgeToMc(m[1]) };
  if (/^\d+\.\d+(\.\d+)?$/.test(s)) return { loader: 'vanilla', loaderVersion: null, mcVersion: s };
  return null;
}

async function looksLikeInstance(dir) {
  for (const marker of ['minecraftinstance.json', 'mmc-pack.json', 'profile.json', 'mods', 'saves', 'config', 'options.txt', '.minecraft', 'minecraft']) {
    if (await exists(path.join(dir, marker))) return true;
  }
  return false;
}

async function officialLauncherProfiles(mcDir) {
  const prof = await readJson(path.join(mcDir, 'launcher_profiles.json'), null);
  if (!prof?.profiles) return [];
  const byDir = new Map();
  for (const p of Object.values(prof.profiles)) {
    const parsed = parseVersionId(p.lastVersionId);
    const gameDir = p.gameDir || mcDir;
    if (!parsed || !parsed.mcVersion) continue;
    if (!p.gameDir && parsed.loader === 'vanilla') continue; // the shared default folder with no mods
    if (!(await exists(gameDir))) continue;
    const prev = byDir.get(gameDir);
    if (prev && prev.loader !== 'vanilla') continue;
    byDir.set(gameDir, {
      folder: gameDir, gameDir, name: p.name || parsed.mcVersion, from: 'Minecraft Launcher', launcher: 'Minecraft Launcher',
      mcVersion: parsed.mcVersion, loader: parsed.loader, loaderVersion: parsed.loaderVersion,
    });
  }
  const out = [];
  for (const e of byDir.values()) {
    e.modCount = (await fsp.readdir(path.join(e.gameDir, 'mods')).catch(() => [])).length;
    out.push(e);
  }
  return out;
}

/** Finds instances in every known launcher location. Returns { instances, notes }. */
async function scanLaunchers(opts = {}) {
  const found = [];
  const notes = [];
  const seen = new Set();
  const knownVersions = opts.knownVersions || null;
  for (const loc of launcherLocations(opts)) {
    try {
      if (loc.official) {
        for (const e of await officialLauncherProfiles(loc.official)) {
          if (seen.has(path.resolve(e.gameDir))) continue;
          seen.add(path.resolve(e.gameDir));
          found.push(e);
        }
        continue;
      }
      const entries = await fsp.readdir(loc.dir, { withFileTypes: true }).catch(() => null);
      if (!entries) continue;
      const db = loc.db ? await readModrinthDb(loc.db) : new Map();
      if (loc.db && db.diag && !db.size) notes.push(`Couldn't read Modrinth App's instance list (${db.diag}). Versions were detected from game logs and folder names instead — check them before importing.`);
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const dir = path.join(loc.dir, ent.name);
        if (seen.has(path.resolve(dir)) || !(await looksLikeInstance(dir))) continue;
        seen.add(path.resolve(dir));
        const meta = db.get(ent.name);
        const info = await detectInstance(dir, { quick: true, skipModScan: Boolean(meta?.loader && meta?.mcVersion), knownVersions });
        if (meta) {
          if (meta.name) info.name = meta.name;
          if (meta.mcVersion) info.mcVersion = meta.mcVersion;
          if (meta.loader) info.loader = meta.loader;
          if (meta.loaderVersion) info.loaderVersion = meta.loaderVersion;
          if (meta.iconPath && /\.(png|jpe?g|webp|gif)$/i.test(meta.iconPath)) {
            info.iconPath = path.isAbsolute(meta.iconPath) ? meta.iconPath : path.join(path.dirname(loc.db), meta.iconPath);
          }
          info.exact = true;
          info.detectedBy = 'database';
        }
        if (info.from === 'folder') info.from = loc.launcher;
        info.launcher = loc.launcher;
        found.push(info);
      }
    } catch { /* one broken location shouldn't hide the others */ }
  }
  return { instances: found, notes };
}

/** Copies the folder into a new Junction instance. */
async function importInstance({ instances, content }, info, { name, mcVersion, loader, loaderVersion }, report = () => {}) {
  const mc = mcVersion || info.mcVersion;
  if (!mc) throw new Error(`Couldn't tell which Minecraft version "${info.name}" uses. Import it on its own and pick the version.`);
  let lv = loaderVersion || info.loaderVersion;
  if (loader && loader !== 'vanilla' && !lv) {
    // Not recorded by the other launcher: use the recommended/latest stable build.
    report(0.02, `Looking up ${loader} versions for ${mc}`);
    let list = [];
    try { list = await listLoaderVersions(instances.ctx, loader, mc); } catch { /* handled below */ }
    lv = pickDefault(list)?.version;
    if (!lv) throw new Error(`No ${loader} version found for Minecraft ${mc}. If that isn't the right Minecraft version, use Edit… to fix it.`);
  }
  const inst = await instances.create({
    name: name || info.name,
    mcVersion: mc,
    loader: loader && loader !== 'vanilla' ? { type: loader, version: lv } : { type: 'vanilla' },
  });
  await instances.update(inst.id, { importedFrom: info.folder });
  try {
    if (info.iconPath && (await exists(info.iconPath))) await instances.setIconFromFile(inst.id, info.iconPath);
    else if (info.iconUrl) await instances.update(inst.id, { icon: info.iconUrl });
  } catch { /* an icon is never worth failing an import over */ }
  report(0.1, 'Copying files');
  await copyDir(info.gameDir, instances.gameDir(inst.id), {
    filter: (p) => {
      const rel = path.relative(info.gameDir, p);
      const top = rel.split(path.sep)[0];
      return !SKIP_TOP.has(top);
    },
  });
  report(0.6, 'Identifying mods on Modrinth and CurseForge');
  const r = await content.identify(inst.id, null, (p, d) => report(p == null ? null : 0.6 + p * 0.4, d));
  return { instance: inst, ...r };
}

module.exports = { detectInstance, importInstance, guessFromName, versionCandidates, readLogVersion, scanLaunchers, launcherLocations, readModrinthDb, parseVersionId };
