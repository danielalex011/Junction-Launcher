'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, makeCtx, fabricJar } = require('./helpers');
const { scanLaunchers, parseVersionId, importInstance } = require('../src/core/content/importer');
const { Instances } = require('../src/core/instances');
const { createSources } = require('../src/core/sources');
const { ContentManager } = require('../src/core/content/manager');

function write(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }

async function makeModrinthDb(file, rows) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
  const db = new SQL.Database();
  db.run('CREATE TABLE profiles (path TEXT PRIMARY KEY, install_stage TEXT, name TEXT, icon_path TEXT, game_version TEXT, mod_loader TEXT, mod_loader_version TEXT, created INTEGER)');
  for (const r of rows) db.run('INSERT INTO profiles VALUES (?,?,?,?,?,?,?,?)', [r.path, 'installed', r.name, null, r.game_version, r.mod_loader, r.mod_loader_version, 0]);
  write(file, Buffer.from(db.export()));
  db.close();
}

test('parses official-launcher version ids', () => {
  assert.deepEqual(parseVersionId('fabric-loader-0.16.10-1.21.1'), { loader: 'fabric', loaderVersion: '0.16.10', mcVersion: '1.21.1' });
  assert.deepEqual(parseVersionId('quilt-loader-0.27.1-26.1.2'), { loader: 'quilt', loaderVersion: '0.27.1', mcVersion: '26.1.2' });
  assert.deepEqual(parseVersionId('1.20.1-forge-47.2.0'), { loader: 'forge', loaderVersion: '47.2.0', mcVersion: '1.20.1' });
  assert.deepEqual(parseVersionId('neoforge-21.1.77'), { loader: 'neoforge', loaderVersion: '21.1.77', mcVersion: '1.21.1' });
  assert.deepEqual(parseVersionId('26.2'), { loader: 'vanilla', loaderVersion: null, mcVersion: '26.2' });
  assert.equal(parseVersionId('latest-release'), null);
});

test('finds instances from Modrinth App (with app.db), CurseForge, Prism and the official launcher', async () => {
  const home = tmpDir();
  const appData = path.join(home, 'AppData', 'Roaming');
  // Modrinth App: one profile described in app.db, one only guessable from its name.
  const mr = path.join(appData, 'ModrinthApp');
  write(path.join(mr, 'profiles', 'Fabric 26.3', 'mods', 'sodium.jar'), fabricJar('sodium'));
  write(path.join(mr, 'profiles', 'Fabric 26.3', 'options.txt'), 'x');
  write(path.join(mr, 'profiles', 'NeoForge 1.21.1 test', 'mods', 'a.jar'), Buffer.from('not a zip'));
  fs.mkdirSync(path.join(mr, 'profiles', '.hidden'), { recursive: true });
  fs.mkdirSync(path.join(mr, 'profiles', 'empty-folder'), { recursive: true });
  await makeModrinthDb(path.join(mr, 'app.db'), [{ path: 'Fabric 26.3', name: 'Fabric 26.3', game_version: '26.3', mod_loader: 'fabric', mod_loader_version: '0.20.1' }]);
  // CurseForge
  const cf = path.join(home, 'curseforge', 'minecraft', 'Instances', 'All the Mods 10');
  write(path.join(cf, 'minecraftinstance.json'), JSON.stringify({ name: 'All the Mods 10', gameVersion: '1.21.1', baseModLoader: { name: 'neoforge-21.1.209' } }));
  write(path.join(cf, 'mods', 'x.jar'), 'x');
  // Prism
  const prism = path.join(appData, 'PrismLauncher', 'instances', 'quilty');
  write(path.join(prism, 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.1' }, { uid: 'org.quiltmc.quilt-loader', version: '0.27.1' }] }));
  write(path.join(prism, 'instance.cfg'), 'name=Quilty Pack\n');
  write(path.join(prism, '.minecraft', 'mods', 'q.jar'), 'q');
  // Official launcher with a custom game dir profile
  const dotmc = path.join(appData, '.minecraft');
  const custom = path.join(home, 'mc-fabric');
  write(path.join(custom, 'mods', 'm.jar'), 'm');
  write(path.join(dotmc, 'launcher_profiles.json'), JSON.stringify({ profiles: {
    a: { name: 'Latest release', type: 'latest-release', lastVersionId: 'latest-release' },
    b: { name: 'fabric-loader-1.21.1', type: 'custom', lastVersionId: 'fabric-loader-0.16.10-1.21.1', gameDir: custom },
  } }));

  const found = await scanLaunchers({ platform: 'win32', env: { APPDATA: appData }, home });
  const by = Object.fromEntries(found.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(by).sort(), ['All the Mods 10', 'Fabric 26.3', 'NeoForge 1.21.1 test', 'Quilty Pack', 'fabric-loader-1.21.1']);
  assert.deepEqual([by['Fabric 26.3'].mcVersion, by['Fabric 26.3'].loader, by['Fabric 26.3'].loaderVersion, by['Fabric 26.3'].exact], ['26.3', 'fabric', '0.20.1', true]);
  assert.equal(by['Fabric 26.3'].launcher, 'Modrinth App');
  assert.deepEqual([by['NeoForge 1.21.1 test'].mcVersion, by['NeoForge 1.21.1 test'].loader], ['1.21.1', 'neoforge']);
  assert.deepEqual([by['All the Mods 10'].launcher, by['All the Mods 10'].loader, by['All the Mods 10'].loaderVersion], ['CurseForge', 'neoforge', '21.1.209']);
  assert.deepEqual([by['Quilty Pack'].loader, by['Quilty Pack'].loaderVersion, path.basename(by['Quilty Pack'].gameDir)], ['quilt', '0.27.1', '.minecraft']);
  assert.deepEqual([by['fabric-loader-1.21.1'].launcher, by['fabric-loader-1.21.1'].gameDir], ['Minecraft Launcher', custom]);
});

test('importing fills in a missing loader version with the recommended build', async () => {
  const ctx = await makeCtx([
    ['GET', 'https://meta.fabricmc.net/v2/versions/loader/1.21.1', () => ({ json: [{ loader: { version: '0.17.0-beta', stable: false } }, { loader: { version: '0.16.14', stable: true } }] })],
    ['POST', /version_files/, () => ({ json: {} })],
  ]);
  const instances = new Instances(ctx);
  const content = new ContentManager(ctx, instances, createSources(ctx));
  const src = tmpDir();
  write(path.join(src, 'mods', 'sodium.jar'), fabricJar('sodium'));
  const r = await importInstance({ instances, content }, { folder: src, gameDir: src, name: 'Fabric 1.21.1', mcVersion: '1.21.1', loader: 'fabric', loaderVersion: null }, { loader: 'fabric' });
  assert.deepEqual(r.instance.loader, { type: 'fabric', version: '0.16.14' });
  assert.equal((await instances.get(r.instance.id)).importedFrom, src);
  await assert.rejects(importInstance({ instances, content }, { folder: src, gameDir: src, name: 'x', mcVersion: null }, {}), /Minecraft version/);
});
