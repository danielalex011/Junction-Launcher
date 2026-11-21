'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, makeCtx, fabricJar } = require('./helpers');
const { scanLaunchers, parseVersionId, importInstance, readModrinthDb, guessFromName, readLogVersion, detectInstance } = require('../src/core/content/importer');
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

  const { instances: found } = await scanLaunchers({ platform: 'win32', env: { APPDATA: appData }, home });
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

test('instance pictures: set from a file, remove, and restore the modpack picture', async () => {
  const ctx = await makeCtx([]);
  const instances = new Instances(ctx);
  const inst = await instances.create({ name: 'Pack', mcVersion: '1.21.1', icon: 'https://cdn.modrinth.com/data/x/icon.png' });
  const img = path.join(tmpDir(), 'my.png');
  write(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const a = await instances.setIconFromFile(inst.id, img);
  assert.equal(a.icon, 'local:icon.png');
  assert.equal(a.originalIcon, 'https://cdn.modrinth.com/data/x/icon.png');
  assert.ok(await instances.iconFile(inst.id));
  const jpg = path.join(tmpDir(), 'other.JPG');
  write(jpg, 'jpg');
  await instances.setIconFromFile(inst.id, jpg);
  assert.ok(!fs.existsSync(path.join(instances.instDir(inst.id), 'icon.png')), 'old picture replaced');
  await assert.rejects(instances.setIconFromFile(inst.id, path.join(tmpDir(), 'x.exe')), /PNG/);
  const b = await instances.clearIcon(inst.id);
  assert.equal(b.icon, 'https://cdn.modrinth.com/data/x/icon.png');
  assert.equal(await instances.iconFile(inst.id), null);
});

test('imports bring the instance picture along (Modrinth App icon file, CurseForge thumbnail)', async () => {
  const home = tmpDir();
  const appData = path.join(home, 'AppData', 'Roaming');
  const mr = path.join(appData, 'ModrinthApp');
  const iconFile = path.join(mr, 'caches', 'icons', 'abc.png');
  write(iconFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  write(path.join(mr, 'profiles', 'Pretty', 'mods', 'a.jar'), fabricJar('a'));
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
  const db = new SQL.Database();
  db.run('CREATE TABLE profiles (path TEXT, name TEXT, icon_path TEXT, game_version TEXT, mod_loader TEXT, mod_loader_version TEXT)');
  db.run('INSERT INTO profiles VALUES (?,?,?,?,?,?)', ['Pretty', 'Pretty Pack', iconFile, '1.21.1', 'fabric', '0.16.14']);
  write(path.join(mr, 'app.db'), Buffer.from(db.export()));
  write(path.join(home, 'curseforge', 'minecraft', 'Instances', 'CFPack', 'minecraftinstance.json'), JSON.stringify({
    name: 'CF Pack', gameVersion: '1.21.1', baseModLoader: { name: 'neoforge-21.1.209' }, installedModpack: { thumbnailUrl: 'https://media.forgecdn.net/avatars/thumbnails/1/2/256/256/x.png' },
  }));
  write(path.join(home, 'curseforge', 'minecraft', 'Instances', 'CFPack', 'mods', 'b.jar'), 'b');
  const { instances: found } = await scanLaunchers({ platform: 'win32', env: { APPDATA: appData }, home });
  const ctx = await makeCtx([['POST', /version_files/, () => ({ json: {} })]]);
  const instances = new Instances(ctx);
  const content = new ContentManager(ctx, instances, createSources(ctx));
  const pretty = found.find((f) => f.name === 'Pretty Pack');
  const r1 = await importInstance({ instances, content }, pretty, {});
  const i1 = await instances.get(r1.instance.id);
  assert.equal(i1.icon, 'local:icon.png');
  assert.deepEqual(fs.readFileSync(await instances.iconFile(i1.id)), fs.readFileSync(iconFile));
  const cfp = found.find((f) => f.name === 'CF Pack');
  const r2 = await importInstance({ instances, content }, cfp, { loader: 'neoforge', loaderVersion: '21.1.209' });
  assert.equal((await instances.get(r2.instance.id)).icon, 'https://media.forgecdn.net/avatars/thumbnails/1/2/256/256/x.png');
});


test('reads Modrinth App data that is still in the write-ahead log (app running)', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = tmpDir();
  const file = path.join(dir, 'app.db');
  const live = new DatabaseSync(file);
  live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  live.exec('CREATE TABLE profiles (path TEXT PRIMARY KEY, name TEXT, game_version TEXT, mod_loader TEXT, mod_loader_version TEXT, icon_path TEXT)');
  live.prepare('INSERT INTO profiles VALUES (?,?,?,?,?,?)').run('Fabric 26.1.2', 'Fabric 26.1.2', '26.1.2', 'fabric', '0.17.3', null);
  live.prepare('INSERT INTO profiles VALUES (?,?,?,?,?,?)').run('C:\\Users\\d\\AppData\\Roaming\\ModrinthApp\\profiles\\QSMP 2 Semi-Recreation', 'QSMP 2 Semi-Recreation', '1.21.1', 'neoforge', '{"id":"21.1.77","stable":true}', null);
  assert.ok(fs.existsSync(`${file}-wal`), 'data is in the WAL file');
  try {
    const map = await readModrinthDb(file);
    assert.equal(map.size >= 2, true, map.diag);
    assert.deepEqual([map.get('Fabric 26.1.2').mcVersion, map.get('Fabric 26.1.2').loaderVersion], ['26.1.2', '0.17.3']);
    const q = map.get('QSMP 2 Semi-Recreation');
    assert.deepEqual([q.loader, q.loaderVersion, q.mcVersion], ['neoforge', '21.1.77', '1.21.1']);
  } finally {
    live.close();
  }
  assert.ok(fs.existsSync(file), "the other app's database is left alone");
});

test('explains when the database cannot be read', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'app.db');
  fs.writeFileSync(file, 'this is not sqlite');
  const map = await readModrinthDb(file);
  assert.equal(map.size, 0);
  assert.match(map.diag, /error/);
});

test('name guesses must be real Minecraft versions; pack versions are ignored', () => {
  const known = new Set(['26.1', '26.1.2', '26.2-pre-5', '1.21.1', '1.0']);
  assert.equal(guessFromName('pure vanilla with optimizations 1.0.1', known).mc, null);
  assert.equal(guessFromName('Pure vanilla with optimizations 1.0.0', known).mc, null);
  assert.equal(guessFromName('Fabric 26.2-pre-5', known).mc, '26.2-pre-5');
  assert.equal(guessFromName('Fabric 26.1.2 (1)', known).mc, '26.1.2');
  assert.equal(guessFromName('pack 1.0.1').mc, null, 'offline fallback also rejects 1.0.x / 1.1.x');
  assert.equal(guessFromName('NeoForge 1.21.1').mc, '1.21.1');
});

test('exact versions come from the game log of an instance that was launched before', async () => {
  const fab = tmpDir();
  write(path.join(fab, 'logs', 'latest.log'), '[12:00:01] [main/INFO]: Loading Minecraft 26.1.2 with Fabric Loader 0.17.3\n[12:00:02] [main/INFO]: Loading 148 mods\n');
  assert.deepEqual(await readLogVersion(fab), { mcVersion: '26.1.2', loader: 'fabric', loaderVersion: '0.17.3' });
  const neo = tmpDir();
  write(path.join(neo, 'logs', 'latest.log'), '[main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running: args [--username, Daniel, --version, neoforge-21.1.77, --gameDir, C:\\x, --fml.neoForgeVersion, 21.1.77, --fml.fmlVersion, 4.0.24, --fml.mcVersion, 1.21.1, --fml.neoFormVersion, 20240808.144430, --launchTarget, forgeclient]\n');
  assert.deepEqual(await readLogVersion(neo), { mcVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.77' });
  const forge = tmpDir();
  write(path.join(forge, 'logs', 'latest.log'), 'ModLauncher running: args [--fml.forgeVersion, 47.3.0, --fml.mcVersion, 1.20.1, --fml.forgeGroup, net.minecraftforge]\n');
  assert.deepEqual(await readLogVersion(forge), { mcVersion: '1.20.1', loader: 'forge', loaderVersion: '47.3.0' });
  // detectInstance prefers the log over a misleading folder name.
  const misnamed = tmpDir();
  write(path.join(misnamed, 'logs', 'latest.log'), 'Loading Minecraft 1.21.1 with Fabric Loader 0.16.14\n');
  write(path.join(misnamed, 'mods', 'a.jar'), fabricJar('a'));
  const info = await detectInstance(misnamed);
  assert.deepEqual([info.mcVersion, info.loader, info.loaderVersion, info.detectedBy], ['1.21.1', 'fabric', '0.16.14', 'log']);
});
