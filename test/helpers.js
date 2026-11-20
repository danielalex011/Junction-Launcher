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
      if (r.json !== undefined) return new Response(JSON.stringify(r.json), { status, headers: { 'content-type': 'application/json' } });
      return new Response(r.body ?? '', { status });
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

module.exports = { tmpDir, fakeFetch, makeCtx, sha1, sha512, fabricJar, forgeJar };
