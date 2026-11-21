'use strict';
// Test helpers: a temporary data folder and a fake internet.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { createContext } = require('../src/core/context');

function tmpDir(prefix = 'junction-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const sha512 = (b) => crypto.createHash('sha512').update(b).digest('hex');

/**
 * routes: array of [method, matcher(url string or RegExp), handler(url, body, headers) -> {status, json|body}]
 */
function fakeFetch(routes, log = []) {
  return async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    let body;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    log.push({ method, url, body, headers: opts.headers || {} });
    for (const [m, match, handler] of routes) {
      if (m !== method) continue;
      const ok = typeof match === 'string' ? url === match : match.test(url);
      if (!ok) continue;
      const r = await handler(url, body, opts.headers || {});
      const status = r.status || 200;
      if (r.json !== undefined) return new Response(JSON.stringify(r.json), { status, headers: { 'content-type': 'application/json', ...(r.headers || {}) } });
      return new Response(r.body ?? '', { status, headers: r.headers || {} });
    }
    return new Response(`no route for ${method} ${url}`, { status: 404 });
  };
}

async function makeCtx(routes = [], { cfKey = '' } = {}) {
  const root = tmpDir();
  const log = [];
  const ctx = await createContext(root, { fetchImpl: fakeFetch(routes, log) });
  if (cfKey) await ctx.settings.update({ cfApiKey: cfKey });
  ctx.requestLog = log;
  return ctx;
}

function fabricJar(id, name = id, version = '1.0.0', extra = {}) {
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id, name, version, ...extra })));
  zip.addFile(`${id}/Main.class`, Buffer.from(`fake class ${id} ${version}`));
  return zip.toBuffer();
}

function forgeJar(modId, name = modId, version = '1.0.0', neo = false) {
  const zip = new AdmZip();
  const toml = `modLoader="javafml"\nloaderVersion="[47,)"\nlicense="MIT"\n\n[[mods]]\nmodId="${modId}"\nversion="${version}"\ndisplayName="${name}"\ndescription='''\nA test mod\n'''\n\n[[dependencies.${modId}]]\nmodId="minecraft"\n`;
  zip.addFile(neo ? 'META-INF/neoforge.mods.toml' : 'META-INF/mods.toml', Buffer.from(toml));
  return zip.toBuffer();
}

/** A tiny PNG encoder (8-bit RGBA) so tests and the mock network can serve a real skin. pixel(x, y) -> [r, g, b, a]. */
function makePng(width, height, pixel) {
  const zlib = require('zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, sum]);
  };
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A 64x64 demo skin: skin-coloured face with eyes, brown hair on the hat layer. */
function demoSkin() {
  return makePng(64, 64, (x, y) => {
    if (x >= 8 && x < 16 && y >= 8 && y < 16) return (y === 11 && (x === 10 || x === 13)) ? [40, 60, 160, 255] : [198, 134, 96, 255];
    if (x >= 40 && x < 48 && y >= 8 && y < 16) return y < 10 ? [92, 58, 30, 255] : [0, 0, 0, 0];
    return [0, 0, 0, 0];
  });
}

module.exports = { makePng, demoSkin, tmpDir, fakeFetch, makeCtx, sha1, sha512, fabricJar, forgeJar };
