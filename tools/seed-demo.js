'use strict';
// Creates a throwaway data folder with a few demo instances and mods, for UI work.
//   node tools/seed-demo.js <data folder>
//   JUNCTION_DATA=<data folder> JUNCTION_FETCH_MOCK=<abs path>/tools/mock-network.js npm start
const fs = require('fs');
const path = require('path');
const { createContext } = require('../src/core/context');
const { Instances } = require('../src/core/instances');
const { fabricJar } = require('../test/helpers');

(async () => {
  const dir = path.resolve(process.argv[2] || 'demo-data');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await createContext(dir);
  const instances = new Instances(ctx);
  const a = await instances.create({ name: 'Fabric 26.1.2', mcVersion: '26.1.2', loader: { type: 'fabric', version: '0.17.3' } });
  await instances.update(a.id, { lastPlayed: Date.now() - 5 * 3600e3, playtimeMs: 41 * 3600e3 });
  await instances.create({ name: 'Craftoria', mcVersion: '1.21.1', loader: { type: 'neoforge', version: '21.1.209' }, pack: { source: 'curseforge', name: 'Craftoria', versionName: '1.33.1' } });
  await instances.create({ name: 'Vanilla 26.2', mcVersion: '26.2', loader: { type: 'vanilla' } });
  const mods = path.join(instances.gameDir(a.id), 'mods');
  // [id, name, version, source, projectId, options]  options: env = fabric.mod.json "environment", off = disabled, extra id = same mod id as another jar
  const list = [
    ['sodium', 'Sodium', '0.7.1', 'modrinth', 'AANobbMI'], ['lithium', 'Lithium', '0.15.0', 'modrinth', 'gvQqBUqZ'],
    ['iris', 'Iris Shaders', '1.9.0', 'modrinth', 'YL57xq9U'], ['distanthorizons', 'Distant Horizons', '2.3.0', 'modrinth', 'uCdwusMi'],
    ['jei', 'Just Enough Items', '27.1.0', 'curseforge', 238222], ['xaerominimap', "Xaero's Minimap", '25.2.0', 'curseforge', 263420, { env: 'client' }],
    ['localmod', 'My Local Tweaks', '1.0', 'local', null], ['fancyhud', 'Fancy HUD', '2.1', 'local', null, { env: 'client' }],
    ['zoomer', 'Zoom Tweaks', '1.4', 'local', null, { env: 'client' }], ['clothconfig', 'Cloth Config API', '20.0.1', 'local', null],
    ['modmenu', 'Mod Menu', '16.0.0', 'local', null, { env: 'client' }], ['betterfog', 'Better Fog', '0.9', 'local', null, { off: true }],
    ['oldfeature', 'Old Feature Pack', '0.3', 'local', null, { off: true }], ['sodium', 'Sodium (second copy)', '0.7.0', 'local', null, { file: 'sodium-copy-0.7.0.jar' }],
  ];
  const idx = { files: {} };
  for (const [id, name, ver, source, projectId, opt = {}] of list) {
    const file = opt.file || `${id}-${ver}.jar`;
    fs.writeFileSync(path.join(mods, file + (opt.off ? '.disabled' : '')), fabricJar(id, name, ver, opt.env ? { environment: opt.env } : {}));
    if (source !== 'local') idx.files[`mods/${file}`] = { source, projectId, versionId: `${id}-v`, title: name, versionName: ver, projectUrl: source === 'modrinth' ? `https://modrinth.com/mod/${id}` : `https://www.curseforge.com/minecraft/mc-mods/${id}` };
  }
  // A second, empty instance to send things to.
  await instances.create({ name: 'Fabric 26.1.2 test', mcVersion: '26.1.2', loader: { type: 'fabric', version: '0.17.3' } });
  fs.writeFileSync(path.join(instances.instDir(a.id), 'content.json'), JSON.stringify(idx));
  console.log(`Demo data in ${dir}`);
})();
