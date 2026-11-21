'use strict';
// Small, dependency-free helpers shared by the whole core.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
  return p;
}

async function readJson(p, fallback = undefined) {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

// Atomic write: write a temp file next to the target, then rename over it.
async function writeJson(p, data) {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, p);
}

function hashBuffer(buf, algo = 'sha1') {
  return crypto.createHash(algo).update(buf).digest('hex');
}

function hashFile(p, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(p)
      .on('error', reject)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')));
  });
}

// Run fn over items with at most `limit` in flight. Collects errors instead of
// failing fast so one bad file doesn't abandon a 300-file download half way.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  const errors = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        errors.push({ item: items[i], error: e });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return { results, errors };
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'instance';
}

// A looser key used to spot "the same mod" across Modrinth and CurseForge.
function matchKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function shortId(n = 6) {
  return crypto.randomBytes(n).toString('hex').slice(0, n);
}

// "group:artifact:version[:classifier][@ext]" -> relative maven path
function mavenPath(name) {
  let ext = 'jar';
  let coords = name;
  const at = coords.indexOf('@');
  if (at !== -1) { ext = coords.slice(at + 1); coords = coords.slice(0, at); }
  const parts = coords.split(':');
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) throw new Error(`Bad maven coordinate: ${name}`);
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}

function mavenKey(name) {
  const coords = name.split('@')[0].split(':');
  return coords.length > 3 ? `${coords[0]}:${coords[1]}:${coords[3]}` : `${coords[0]}:${coords[1]}`;
}

// Join a relative path onto a base and refuse anything that escapes it.
// Modpack files come from the internet; "../../evil.exe" must never land outside.
function safeJoin(base, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error(`Unsafe path: ${rel}`);
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) throw new Error(`Unsafe absolute path: ${rel}`);
  const target = path.resolve(base, norm);
  const root = path.resolve(base);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Unsafe path escapes folder: ${rel}`);
  return target;
}

/** What kind of picture is this? Decided from the first bytes, never from the file name. */
function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: '.png', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buf.toString('latin1', 0, 4) === 'GIF8') return { ext: '.gif', mime: 'image/gif' };
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  return null;
}

/** Same as sniffImage for a file on disk; null if it can't be read or isn't a picture. */
async function imageTypeOfFile(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    return sniffImage(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function osName() {
  return { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform] || process.platform;
}

// Quote-aware argument splitter for user-entered JVM args.
function splitArgs(str) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(str || '')) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

async function copyDir(src, dest, { filter } = {}) {
  await ensureDir(dest);
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (filter && !filter(s, entry)) continue;
    if (entry.isDirectory()) await copyDir(s, d, { filter });
    else if (entry.isFile()) await fsp.copyFile(s, d);
  }
}

async function listFiles(dir) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch { return []; }
}

function compareVersions(a, b) {
  // Generic dotted version compare: "1.21.10" > "1.21.9", "26.1" > "1.21.11".
  const pa = String(a).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]; const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

module.exports = {
  exists, ensureDir, readJson, writeJson, hashBuffer, hashFile, pool, slugify, matchKey, shortId,
  mavenPath, mavenKey, safeJoin, sniffImage, imageTypeOfFile, osName, splitArgs, copyDir, listFiles, compareVersions, formatBytes,
  totalMemMB: () => Math.floor(os.totalmem() / 1024 / 1024),
};
