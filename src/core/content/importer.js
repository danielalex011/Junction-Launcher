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

function guessFromName(name) {
  const loader = (String(name).match(/\b(neoforge|forge|fabric|quilt)\b/i) || [])[1]?.toLowerCase() || null;
  const mc = (String(name).match(/\b(1\.\d{1,2}(?:\.\d{1,2})?|2\d\.\d(?:\.\d{1,2})?)\b/) || [])[1] || null;
  return { loader, mc };
}

/** Inspects a folder and returns what we could work out about it. */
async function detectInstance(folder, { quick = false, skipModScan = false } = {}) {
  const info = { folder, gameDir: folder, name: path.basename(folder), mcVersion: null, loader: null, loaderVersion: null, from: 'folder' };

  const cf = await readJson(path.join(folder, 'minecraftinstance.json'), null);
  if (cf) {
    info.from = 'CurseForge app';
    info.name = cf.name || info.name;
    info.mcVersion = cf.gameVersion || cf.baseModLoader?.minecraftVersion || null;
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
    } catch { /* optional */ }
  }

  if (/ModrinthApp[\\/]profiles/i.test(folder) && info.from === 'folder') info.from = 'Modrinth App';

  // Fill gaps from the folder name ("Fabric 26.1.2") and from the mods themselves.
  const guess = guessFromName(info.name);
  if (!info.mcVersion) info.mcVersion = guess.mc;
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
function loadSql() {
  if (!sqlPromise) {
    const initSqlJs = require('sql.js');
    const wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
    sqlPromise = initSqlJs({ wasmBinary });
  }
  return sqlPromise;
}

/** Reads Modrinth App's own instance list (name, game version, loader + version) from app.db. */
async function readModrinthDb(dbFile) {
  const out = new Map();
  let buf;
  try { buf = await fsp.readFile(dbFile); } catch { return out; }
  try {
    const SQL = await loadSql();
    const db = new SQL.Database(new Uint8Array(buf));
    try {
      const res = db.exec('SELECT * FROM profiles');
      if (!res.length) return out;
      const { columns, values } = res[0];
      const col = (...names) => names.map((n) => columns.indexOf(n)).find((i) => i >= 0);
      const iPath = col('path');
      const iName = col('name');
      const iGame = col('game_version');
      const iLoader = col('mod_loader', 'loader');
      const iLoaderV = col('mod_loader_version', 'loader_version');
      const iLinked = col('linked_project_id');
      const iIcon = col('icon_path');
      if (iPath === undefined) return out;
      for (const row of values) {
        const loader = iLoader !== undefined ? String(row[iLoader] || '').toLowerCase() : '';
        out.set(String(row[iPath]), {
          name: iName !== undefined ? row[iName] : null,
          mcVersion: iGame !== undefined ? row[iGame] : null,
          loader: loader && loader !== 'vanilla' ? loader : (loader === 'vanilla' ? 'vanilla' : null),
          loaderVersion: iLoaderV !== undefined && row[iLoaderV] ? String(row[iLoaderV]) : null,
          linkedProjectId: iLinked !== undefined ? row[iLinked] : null,
          iconPath: iIcon !== undefined ? row[iIcon] : null,
        });
      }
    } finally {
      db.close();
    }
  } catch { /* unknown schema: fall back to folder detection */ }
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

/** Finds instances in every known launcher location. */
async function scanLaunchers(opts = {}) {
  const found = [];
  const seen = new Set();
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
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const dir = path.join(loc.dir, ent.name);
        if (seen.has(path.resolve(dir)) || !(await looksLikeInstance(dir))) continue;
        seen.add(path.resolve(dir));
        const meta = db.get(ent.name);
        const info = await detectInstance(dir, { quick: true, skipModScan: Boolean(meta?.loader && meta?.mcVersion) });
        if (meta) {
          if (meta.name) info.name = meta.name;
          if (meta.mcVersion) info.mcVersion = meta.mcVersion;
          if (meta.loader) info.loader = meta.loader;
          if (meta.loaderVersion) info.loaderVersion = meta.loaderVersion;
          if (meta.iconPath && /\.(png|jpe?g|webp|gif)$/i.test(meta.iconPath)) info.iconPath = meta.iconPath;
          info.exact = true;
        }
        if (info.from === 'folder') info.from = loc.launcher;
        info.launcher = loc.launcher;
        found.push(info);
      }
    } catch { /* one broken location shouldn't hide the others */ }
  }
  return found;
}

/** Copies the folder into a new Junction instance. */
async function importInstance({ instances, content }, info, { name, mcVersion, loader, loaderVersion }, report = () => {}) {
  const mc = mcVersion || info.mcVersion;
  if (!mc) throw new Error(`Couldn't tell which Minecraft version "${info.name}" uses. Import it on its own and pick the version.`);
  let lv = loaderVersion || info.loaderVersion;
  if (loader && loader !== 'vanilla' && !lv) {
    // Not recorded by the other launcher: use the recommended/latest stable build.
    report(0.02, `Looking up ${loader} versions for ${mc}`);
    lv = pickDefault(await listLoaderVersions(instances.ctx, loader, mc))?.version;
    if (!lv) throw new Error(`${loader} isn't available for Minecraft ${mc}.`);
  }
  const inst = await instances.create({
    name: name || info.name,
    mcVersion: mc,
    loader: loader && loader !== 'vanilla' ? { type: loader, version: lv } : { type: 'vanilla' },
  });
  await instances.update(inst.id, { importedFrom: info.folder });
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

module.exports = { detectInstance, importInstance, guessFromName, scanLaunchers, launcherLocations, readModrinthDb, parseVersionId };
