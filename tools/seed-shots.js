'use strict';
// The demo data for the README screenshots (tools/screenshots.js). It is tools/seed-home.js plus a few touches so the
// pictures look like real use. The test fixtures (seed-demo, seed-home, mock-network) stay as they are.
//   node tools/seed-shots.js <data folder> <hash map file>
//
// - two instances get ordinary names;
// - the update channel is "Releases only", so the review window's "Default to the newest of" says so;
// - <hash map file> tells tools/shots-network.js which mod each downloaded file is (sha1 -> project id), so the
//   simulated Modrinth can offer each one a newer version.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createContext } = require('../src/core/context');
const { Instances } = require('../src/core/instances');

const RENAMES = { 'Fabric 26.1.2 test': 'Creative Builds', 'All the Mods 10 – the really long named expedition pack': 'Kitchen Sink' };

(async () => {
  const dir = path.resolve(process.argv[2] || 'demo-shots-data');
  const mapFile = path.resolve(process.argv[3] || path.join(dir, 'shots-hashes.json'));
  execFileSync(process.execPath, [path.join(__dirname, 'seed-home.js'), dir], { stdio: 'ignore' });
  const ctx = await createContext(dir);
  const instances = new Instances(ctx);
  await ctx.settings.update({ updateChannel: 'release' });
  const map = {};
  for (const inst of await instances.list()) {
    if (RENAMES[inst.name]) await instances.update(inst.id, { name: RENAMES[inst.name] });
    for (const t of ['mod', 'resourcepack', 'shader']) await instances.listContent(inst.id, t); // hashes every file into content.json
    const idx = await instances.readIndex(inst.id);
    for (const e of Object.values(idx.files)) if (e.sha1 && e.source === 'modrinth') map[e.sha1] = String(e.projectId);
  }
  fs.writeFileSync(mapFile, JSON.stringify(map));
  // Home's cached update counts: only what the simulated Modrinth really offers (the 4 mods of "Fabric 26.1.2") plus
  // Lantern Pack's pack update, so Home, Library and the review window all agree.
  const homeFile = path.join(ctx.paths.cache, 'home.json');
  const cache = JSON.parse(fs.readFileSync(homeFile, 'utf8'));
  const fabric = (await instances.list()).find((i) => i.name === 'Fabric 26.1.2');
  cache.updates.byInstance = { [fabric.id]: 4 };
  fs.writeFileSync(homeFile, JSON.stringify(cache));
  console.log(`Screenshot data in ${dir}`);
})();
