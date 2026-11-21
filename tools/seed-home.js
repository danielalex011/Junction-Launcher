'use strict';
// Demo data for checking Home and the Library with many instances: the normal demo (tools/seed-demo.js) plus more
// instances, 8 of them with cached updates (one of those a modpack update: the demo's Lantern Pack). Writes to a folder you name; use a temp one.
//   node tools/seed-home.js <data folder>
//   JUNCTION_DATA=<data folder> JUNCTION_FETCH_MOCK=<abs path>/tools/mock-network.js npm start
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createContext } = require('../src/core/context');
const { Instances } = require('../src/core/instances');

(async () => {
  const dir = path.resolve(process.argv[2] || 'demo-home-data');
  execFileSync(process.execPath, [path.join(__dirname, 'seed-demo.js'), dir], { stdio: 'ignore' });
  const ctx = await createContext(dir);
  const instances = new Instances(ctx);
  const extra = [
    ['Prominence II', '1.20.1', 'fabric', '0.15.11', 'Prominence II RPG', '4.1.0'],
    ['All the Mods 10 – the really long named expedition pack', '1.21.1', 'neoforge', '21.1.209'],
    ['Create: Astral', '1.20.1', 'forge', '47.3.0'], ['Skyblock Redux', '1.21.1', 'neoforge', '21.1.180'],
    ['Vanilla 1.21.4', '1.21.4', 'vanilla'], ['Quilt Playground', '1.20.4', 'quilt', '0.26.0'],
    ['Builders Tools', '1.21.1', 'fabric', '0.16.5'],
  ];
  const made = [];
  for (const [name, mc, type, ver, pack, packVer] of extra) {
    const i = await instances.create({ name, mcVersion: mc, loader: type === 'vanilla' ? { type } : { type, version: ver }, ...(pack ? { pack: { source: 'modrinth', name: pack, versionName: packVer, versionId: 'p-old' } } : {}) });
    await instances.update(i.id, { lastPlayed: Date.now() - (made.length + 2) * 7 * 3600e3 });
    made.push(i);
  }
  const all = await instances.list();
  const byName = Object.fromEntries(all.map((i) => [i.name, i.id]));
  const homeFile = path.join(ctx.paths.cache, 'home.json');
  const cache = JSON.parse(fs.readFileSync(homeFile, 'utf8'));
  const counts = { 'Fabric 26.1.2': 13, Craftoria: 7, 'Prominence II': 4, 'Create: Astral': 9, 'Skyblock Redux': 2, 'Builders Tools': 5, 'Quilt Playground': 3 };
  for (const [n, c] of Object.entries(counts)) cache.updates.byInstance[byName[n]] = c;
  cache.updates.byInstance[all.find((i) => /Lantern/.test(i.name)).id] = 8;
  cache.updates.checkedAt = Date.now() - 25 * 60e3;
  fs.writeFileSync(homeFile, JSON.stringify(cache));
  console.log(`${all.length} instances, ${Object.keys(cache.updates.byInstance).length} with updates (${Object.keys(cache.updates.packs).length} modpack updates) in ${dir}`);
})();
