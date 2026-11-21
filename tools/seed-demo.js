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
  const list = [['sodium', 'Sodium', '0.7.1', 'modrinth', 'AANobbMI'], ['lithium', 'Lithium', '0.15.0', 'modrinth', 'gvQqBUqZ'], ['jei', 'Just Enough Items', '27.1.0', 'curseforge', 238222], ['localmod', 'My Local Tweaks', '1.0', 'local', null]];
  const idx = { files: {} };
  for (const [id, name, ver, source, projectId] of list) {
    const file = `${id}-${ver}.jar`;
    fs.writeFileSync(path.join(mods, file), fabricJar(id, name, ver));
    if (source !== 'local') idx.files[`mods/${file}`] = { source, projectId, versionId: `${id}-v`, title: name, versionName: ver };
  }
  fs.writeFileSync(path.join(instances.instDir(a.id), 'content.json'), JSON.stringify(idx));
  console.log(`Demo data in ${dir}`);
})();
