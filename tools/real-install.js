'use strict';
// Dev script (not part of the app): runs prepareInstance against the REAL services
// (Mojang, Fabric meta, Forge/NeoForge maven, ...) for a few instance setups.
//
//   node tools/real-install.js                      # all four setups
//   node tools/real-install.js vanilla-26.3 forge-1.20.1
//   node tools/real-install.js --dir C:\tmp\junction-real   # reuse downloads between runs
//
// Uses a temporary data folder (deleted afterwards unless --dir is given), so it never
// touches %APPDATA%\Junction.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createContext } = require('../src/core/context');
const { loadBuildConfig } = require('../src/core/build-config');
const { Instances } = require('../src/core/instances');
const { listLoaderVersions, pickDefault } = require('../src/core/loaders');
const { prepareInstance } = require('../src/core/minecraft/launch');

const CASES = {
  'vanilla-26.3': { mc: '26.3', loader: 'vanilla' },
  'fabric-26.3': { mc: '26.3', loader: 'fabric' },
  'neoforge-1.21.1': { mc: '1.21.1', loader: 'neoforge' },
  'forge-1.20.1': { mc: '1.20.1', loader: 'forge' },
};

async function runCase(ctx, instances, name, { mc, loader }) {
  const t0 = Date.now();
  // Progress arrives per file ("Assets: 12/5000"), so only print when the step
  // changes, plus a heartbeat every 5 seconds.
  let lastStep = ''; let lastPrint = 0;
  const report = (p, d) => {
    if (!d) return;
    const step = String(d).replace(/[:\s]*\d.*$/, '');
    const now = Date.now();
    if (step !== lastStep || now - lastPrint > 5000) {
      console.log(`  [${name}] ${String(Math.round(p * 100)).padStart(3)}%  ${d}`);
      lastStep = step; lastPrint = now;
    }
  };
  let loaderObj = { type: 'vanilla' };
  if (loader !== 'vanilla') {
    const list = await listLoaderVersions(ctx, loader, mc);
    const pick = pickDefault(list);
    if (!pick) throw new Error(`No ${loader} versions listed for ${mc}`);
    loaderObj = { type: loader, version: pick.version };
    console.log(`  [${name}] using ${loader} ${pick.version} (${list.length} versions listed)`);
  }
  const inst = await instances.create({ name: `real-${name}`, mcVersion: mc, loader: loaderObj });
  const prepared = await prepareInstance(ctx, inst, report);
  // Sanity checks on what a launch would use.
  const missing = [...prepared.files.libraries, prepared.files.clientJar].filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`prepareInstance finished but ${missing.length} files are missing, e.g. ${missing[0]}`);
  if (!prepared.java?.path && !prepared.java?.javaPath && !prepared.java?.exe && typeof prepared.java !== 'string') {
    console.log(`  [${name}] java result shape:`, Object.keys(prepared.java || {}));
  }
  return {
    versionId: prepared.versionId,
    mainClass: prepared.version.mainClass,
    libraries: prepared.files.libraries.length,
    java: prepared.java?.path || prepared.java?.javaPath || prepared.java?.exe || String(prepared.java),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
}

(async () => {
  const args = process.argv.slice(2);
  let dir = null;
  const names = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') dir = path.resolve(args[++i]);
    else names.push(args[i]);
  }
  const wanted = names.length ? names : Object.keys(CASES);
  for (const n of wanted) if (!CASES[n]) { console.error(`Unknown case "${n}". Choose from: ${Object.keys(CASES).join(', ')}`); process.exit(2); }

  const root = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'junction-real-'));
  fs.mkdirSync(root, { recursive: true });
  console.log(`Data folder: ${root}${dir ? ' (kept)' : ' (deleted at the end)'}`);
  const b = loadBuildConfig({ appRoot: path.join(__dirname, '..') });
  const ctx = await createContext(root, { builtins: { cfApiKey: b.cfApiKey, msClientId: b.msClientId } });
  const instances = new Instances(ctx);

  const results = {};
  for (const n of wanted) {
    console.log(`\n== ${n}`);
    try {
      results[n] = { ok: true, ...(await runCase(ctx, instances, n, CASES[n])) };
    } catch (e) {
      results[n] = { ok: false, error: e.message };
      console.log(`  [${n}] FAILED: ${e.message}`);
      if (e.stack) console.log(e.stack.split('\n').slice(1, 5).join('\n'));
    }
  }

  console.log('\n== Summary');
  for (const [n, r] of Object.entries(results)) {
    console.log(r.ok
      ? `PASS ${n}: ${r.versionId}, main ${r.mainClass}, ${r.libraries} libraries, ${r.seconds}s, java ${r.java}`
      : `FAIL ${n}: ${r.error}`);
  }
  if (!dir) fs.rmSync(root, { recursive: true, force: true });
  process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1);
})();
