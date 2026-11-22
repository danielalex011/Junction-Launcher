'use strict';
// Settings → Java: which of Junction's own Java runtimes (8, 17, 21, 25) are downloaded, how big they are,
// which instances use them, and download / repair / remove.
const fsp = require('fs').promises;
const path = require('path');
const { readJson, exists } = require('../util');
const { dirSize } = require('../storage');
const { ensureRuntime, javaMajorFor, bucketMajor } = require('./java');

// First component is the one that gets downloaded; the others (1.17 used Java 16) are counted and removed with it.
const ROWS = [
  { major: 8, components: ['jre-legacy'] },
  { major: 17, components: ['java-runtime-gamma', 'java-runtime-beta', 'java-runtime-alpha', 'java-runtime-gamma-snapshot'] },
  { major: 21, components: ['java-runtime-delta'] },
  { major: 25, components: ['java-runtime-epsilon'] },
];
const rowFor = (major) => ROWS.find((r) => r.major === Number(major)) || null;

/** Which Java row a Minecraft version needs, when its version file was never downloaded. */
function guessMajorForMc(mc) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(mc || ''));
  if (!m) return 17;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  if (a >= 26) return 25;
  if (a !== 1) return 17;
  if (b >= 21 || (b === 20 && c >= 5)) return 21;
  if (b >= 17) return 17;
  return 8;
}

/** The Java row an instance launches with (not counting a custom Java path it may have). */
async function majorForInstance(ctx, inst) {
  const file = path.join(ctx.paths.versions, inst.mcVersion, `${inst.mcVersion}.json`);
  const v = await readJson(file, null);
  return v?.javaVersion ? javaMajorFor(v) : guessMajorForMc(inst.mcVersion);
}

/** The four rows for Settings: status, exact version, size on disk and the instances that use each. */
async function runtimeRows(ctx, instances) {
  const list = await instances.list().catch(() => []);
  const users = new Map(ROWS.map((r) => [r.major, []]));
  for (const inst of list) {
    if (inst.javaPath) continue; // it uses its own Java
    const major = await majorForInstance(ctx, inst);
    users.get(bucketMajor(major))?.push({ id: inst.id, name: inst.name });
  }
  const out = [];
  for (const row of ROWS) {
    let installed = false;
    let version = null;
    let sizeBytes = 0;
    for (const comp of row.components) {
      const dir = path.join(ctx.paths.runtimes, comp);
      const marker = await readJson(path.join(dir, '.junction-runtime.json'), null);
      if (marker) {
        installed = true;
        if (!version) version = marker.version || null;
      }
      sizeBytes += await dirSize(dir);
    }
    out.push({ major: row.major, installed, version, sizeBytes, usedBy: users.get(row.major) });
  }
  return out;
}

/** Downloads (or, with repair, re-checks every file of) the runtime for one Java row. */
async function downloadRuntime(ctx, major, onProgress, { repair = false } = {}) {
  const row = rowFor(major);
  if (!row) throw new Error('Junction downloads Java 8, 17, 21 and 25.');
  return ensureRuntime(ctx, row.components[0], onProgress, { force: repair });
}

/** Deletes the downloaded runtime. Refuses while an instance needs it (or is running): it would only download again. */
async function removeRuntime(ctx, instances, major, { running = [] } = {}) {
  const row = rowFor(major);
  if (!row) throw new Error('Junction downloads Java 8, 17, 21 and 25.');
  const rows = await runtimeRows(ctx, instances);
  const cur = rows.find((r) => r.major === row.major);
  if (cur.usedBy.length) throw new Error(`Java ${row.major} is used by ${cur.usedBy.map((u) => u.name).slice(0, 3).join(', ')}${cur.usedBy.length > 3 ? ' and more' : ''}. It can only be removed when no instance needs it.`);
  if (running.length) throw new Error('Close the running game first.');
  for (const comp of row.components) {
    const dir = path.join(ctx.paths.runtimes, comp);
    if (await exists(dir)) await fsp.rm(dir, { recursive: true, force: true });
  }
  return true;
}

module.exports = { ROWS, runtimeRows, downloadRuntime, removeRuntime, guessMajorForMc, majorForInstance };
