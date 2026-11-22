'use strict';
// "Copy worlds and settings from…": copies worlds, options, server list, minimap data and schematics from another
// instance (Junction's or another launcher's) into a Junction instance. The source folder is only ever read.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { exists, ensureDir, copyDir, safeJoin, compareVersions, formatBytes } = require('../util');
const { dirSize } = require('../storage');
const { checkSpace } = require('../space');

/** What can be copied besides worlds. Paths are relative to the game folder. */
const ITEMS = [
  { id: 'options', label: 'Options (keybinds and video settings)', paths: ['options.txt', 'optionsof.txt', 'optionsshaders.txt'] },
  { id: 'servers', label: 'Server list', paths: ['servers.dat'] },
  { id: 'minimap', label: "Minimap data (Xaero's and JourneyMap)", paths: ['xaero', 'XaeroWorldMap', 'XaeroWaypoints', 'journeymap'] },
  { id: 'schematics', label: 'Schematics', paths: ['schematics', 'config/worldedit/schematics'] },
];

// ---------------------------------------------------------------- level.dat (gzip-compressed NBT)

/** Minimal NBT reader: returns the root compound as plain JS values (longs as numbers, arrays as arrays). */
function parseNbt(buf) {
  let pos = 0;
  const need = (n) => { if (pos + n > buf.length) throw new Error('Truncated NBT'); };
  const readers = {
    1: () => { need(1); return buf.readInt8(pos++); },
    2: () => { need(2); const v = buf.readInt16BE(pos); pos += 2; return v; },
    3: () => { need(4); const v = buf.readInt32BE(pos); pos += 4; return v; },
    4: () => { need(8); const v = Number(buf.readBigInt64BE(pos)); pos += 8; return v; },
    5: () => { need(4); const v = buf.readFloatBE(pos); pos += 4; return v; },
    6: () => { need(8); const v = buf.readDoubleBE(pos); pos += 8; return v; },
    7: () => { const n = readers[3](); need(n); pos += n; return []; },
    8: () => { need(2); const n = buf.readUInt16BE(pos); pos += 2; need(n); const s = buf.toString('utf8', pos, pos + n); pos += n; return s; },
    9: (depth) => {
      const type = readers[1](); const n = readers[3]();
      if (n < 0 || (n > 0 && !readers[type])) throw new Error('Bad NBT list');
      const out = [];
      for (let i = 0; i < n; i++) out.push(readers[type](depth + 1));
      return out;
    },
    10: (depth) => {
      if (depth > 64) throw new Error('NBT too deep');
      const out = {};
      for (;;) {
        const type = readers[1]();
        if (type === 0) return out;
        if (!readers[type]) throw new Error('Bad NBT tag');
        const name = readers[8]();
        out[name] = readers[type](depth + 1);
      }
    },
    11: () => { const n = readers[3](); need(n * 4); pos += n * 4; return []; },
    12: () => { const n = readers[3](); need(n * 8); pos += n * 8; return []; },
  };
  const rootType = readers[1]();
  if (rootType !== 10) throw new Error('Not an NBT compound');
  readers[8]();
  return readers[10](0);
}

/** The Minecraft version that last saved the world: { name, id, snapshot } or null (worlds from before 1.9 don't record it). */
async function readWorldVersion(worldDir) {
  try {
    const raw = await fsp.readFile(path.join(worldDir, 'level.dat'));
    let data;
    try { data = zlib.gunzipSync(raw); } catch { data = raw; }
    const v = parseNbt(data)?.Data?.Version;
    if (!v || typeof v.Name !== 'string') return null;
    return { name: v.Name, id: typeof v.Id === 'number' ? v.Id : null, snapshot: Boolean(v.Snapshot) };
  } catch { return null; }
}

async function readWorldName(worldDir) {
  try {
    const raw = await fsp.readFile(path.join(worldDir, 'level.dat'));
    let data;
    try { data = zlib.gunzipSync(raw); } catch { data = raw; }
    const n = parseNbt(data)?.Data?.LevelName;
    return typeof n === 'string' ? n : null;
  } catch { return null; }
}

const RELEASE = /^\d+(\.\d+){1,2}$/;

/**
 * Can a world last saved in `worldVersion` go into an instance on `targetMc`?
 *   'same'    – same version
 *   'older'   – the world is older: fine, but opening it upgrades it, so the old version can't open it afterwards
 *   'newer'   – the world is newer than the instance: not allowed
 *   'unknown' – no version in level.dat, or a snapshot we can't place
 */
function compareWorld(worldVersion, targetMc) {
  if (!worldVersion?.name || worldVersion.snapshot || !RELEASE.test(worldVersion.name) || !RELEASE.test(String(targetMc))) return 'unknown';
  const pad = (v) => (v.split('.').length < 3 ? `${v}.0` : v); // "1.20" is the same release as "1.20.0"
  const c = compareVersions(pad(worldVersion.name), pad(String(targetMc)));
  return c > 0 ? 'newer' : c < 0 ? 'older' : 'same';
}

// ---------------------------------------------------------------- what's in a source

async function sizeOf(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory() ? dirSize(p) : st.size;
  } catch { return 0; }
}

/** Worlds and copyable items in a game folder (read-only). */
async function inspectSource(gameDir) {
  const worlds = [];
  const saves = path.join(gameDir, 'saves');
  for (const e of await fsp.readdir(saves, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const dir = path.join(saves, e.name);
    if (!(await exists(path.join(dir, 'level.dat')))) continue;
    worlds.push({ folder: e.name, name: (await readWorldName(dir)) || e.name, size: await dirSize(dir), version: await readWorldVersion(dir) });
  }
  const items = [];
  for (const it of ITEMS) {
    let size = 0; let found = 0;
    for (const rel of it.paths) {
      const p = path.join(gameDir, ...rel.split('/'));
      if (await exists(p)) { found++; size += await sizeOf(p); }
    }
    if (found) items.push({ id: it.id, label: it.label, size });
  }
  return { worlds, items };
}

// ---------------------------------------------------------------- planning and copying

/**
 * Works out what a copy would do, without touching anything.
 * choices: { worlds: [folder names], items: [item ids] }
 * Returns { entries, blocked, upgrades, unknown, overwrites, bytes }.
 */
async function planCopy({ sourceDir, targetDir, targetMc, choices }) {
  const src = await inspectSource(sourceDir);
  const entries = [];
  const blocked = []; const upgrades = []; const unknown = [];
  for (const folder of choices.worlds || []) {
    const w = src.worlds.find((x) => x.folder === folder);
    if (!w) throw new Error(`The world "${folder}" isn't in the source any more.`);
    const status = compareWorld(w.version, targetMc);
    const info = { name: w.name, folder, worldVersion: w.version?.name || null, targetVersion: targetMc };
    if (status === 'newer') blocked.push(info);
    else if (status === 'older') upgrades.push(info);
    else if (status === 'unknown') unknown.push(info);
    entries.push({ kind: 'world', label: `World "${w.name}"`, srcRel: `saves/${folder}`, destRel: `saves/${folder}`, size: w.size });
  }
  for (const id of choices.items || []) {
    const it = ITEMS.find((x) => x.id === id);
    if (!it) throw new Error(`Unknown item: ${id}`);
    for (const rel of it.paths) {
      const p = path.join(sourceDir, ...rel.split('/'));
      if (!(await exists(p))) continue;
      entries.push({ kind: 'item', label: `${it.label.replace(/ \(.*\)$/, '')}: ${rel}`, srcRel: rel, destRel: rel, size: await sizeOf(p) });
    }
  }
  const overwrites = [];
  for (const e of entries) {
    if (await exists(safeJoin(targetDir, e.destRel))) overwrites.push(e.label);
  }
  return { entries, blocked, upgrades, unknown, overwrites, bytes: entries.reduce((n, e) => n + e.size, 0) };
}

/**
 * Copies the chosen worlds and settings into the instance's game folder. Anything it would replace is moved into the
 * instance's backups folder first. The source is only read.
 * `confirmed` must be true when the plan replaces something or puts an older/unknown world into a newer version.
 */
async function copyFrom({ ctx, sourceDir, targetDir, backupRoot, targetMc, choices, confirmed = false, report = () => {} }) {
  if (path.resolve(sourceDir) === path.resolve(targetDir)) throw new Error('That is the same instance. Pick a different one to copy from.');
  const plan = await planCopy({ sourceDir, targetDir, targetMc, choices });
  if (!plan.entries.length) throw new Error('Nothing to copy: tick at least one world or setting.');
  if (plan.blocked.length) {
    const b = plan.blocked[0];
    throw new Error(`"${b.name}" was last saved in Minecraft ${b.worldVersion}, which is newer than this instance (${targetMc}). A world can't be copied into an older version.`);
  }
  if ((plan.overwrites.length || plan.upgrades.length || plan.unknown.length) && !confirmed) {
    throw new Error('Please confirm the copy first: it replaces existing files or moves a world to a newer version.');
  }
  const space = await checkSpace(ctx, plan.bytes);
  if (space?.notEnough) throw new Error(`Not enough free space: ${space.message}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot, `copy-${stamp}`);
  const copied = []; const backedUp = [];
  let done = 0;
  for (const e of plan.entries) {
    report(plan.bytes ? done / plan.bytes : 0, e.label);
    const from = path.join(sourceDir, ...e.srcRel.split('/'));
    const to = safeJoin(targetDir, e.destRel);
    let moved = null;
    if (await exists(to)) {
      moved = safeJoin(backupDir, e.destRel);
      await ensureDir(path.dirname(moved));
      await fsp.rename(to, moved);
      backedUp.push(e.destRel);
    }
    try {
      await ensureDir(path.dirname(to));
      const st = await fsp.stat(from);
      if (st.isDirectory()) await copyDir(from, to, { filter: (p) => path.basename(p) !== 'session.lock' });
      else await fsp.copyFile(from, to);
    } catch (err) {
      // Put things back the way they were for this entry.
      await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
      if (moved) { await fsp.rename(moved, to).catch(() => {}); backedUp.pop(); }
      throw new Error(`Couldn't copy ${e.label}: ${err.message}`);
    }
    copied.push(e.destRel);
    done += e.size;
  }
  report(1, 'Done');
  return { copied, backedUp, backupDir: backedUp.length ? backupDir : null, bytes: plan.bytes, summary: `Copied ${copied.length} item${copied.length === 1 ? '' : 's'} (${formatBytes(plan.bytes)})` };
}

module.exports = { ITEMS, parseNbt, readWorldVersion, compareWorld, inspectSource, planCopy, copyFrom };
