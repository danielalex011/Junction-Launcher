'use strict';
// End-to-end flows against a fake Mojang / Fabric / Modrinth / CurseForge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const { makeCtx, sha1, sha512, fabricJar, forgeJar, tmpDir } = require('./helpers');
const { Instances } = require('../src/core/instances');
const { createSources } = require('../src/core/sources');
const { ContentManager } = require('../src/core/content/manager');
const { Modpacks } = require('../src/core/content/modpacks');
const { exportMrpack, exportCurseForge } = require('../src/core/content/export');
const { detectInstance, importInstance } = require('../src/core/content/importer');
const { BlockedWatcher } = require('../src/core/content/blocked');
const { Accounts } = require('../src/core/auth/accounts');
const { prepareInstance, launch } = require('../src/core/minecraft/launch');
const { platformKey } = require('../src/core/minecraft/java');
const { curseFingerprint } = require('../src/core/sources/fingerprint');

function services(ctx) {
  const instances = new Instances(ctx);
  const sources = createSources(ctx);
  const content = new ContentManager(ctx, instances, sources);
  const modpacks = new Modpacks(ctx, instances, content, sources);
  return { instances, sources, content, modpacks };
}

// ------------------------------------------------------------------ fake Mojang + Fabric
function fakeGameServer() {
  const files = {};
  const add = (url, buf) => { files[url] = Buffer.isBuffer(buf) ? buf : Buffer.from(buf); return { url, sha1: sha1(files[url]), size: files[url].length }; };
  const clientJar = add('https://piston-data.test/client.jar', 'CLIENT JAR BYTES');
  const lib1 = add('https://libraries.minecraft.net/com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar', 'brigadier');
  const natWin = add('https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar', 'nat-win');
  const natLin = add('https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar', 'nat-linux');
  const logCfg = add('https://piston-data.test/client-1.21.xml', '<Configuration/>');
  const asset1 = Buffer.from('sound bytes');
  const asset2 = Buffer.from('lang bytes');
  const h1 = sha1(asset1); const h2 = sha1(asset2);
  add(`https://resources.download.minecraft.net/${h1.slice(0, 2)}/${h1}`, asset1);
  add(`https://resources.download.minecraft.net/${h2.slice(0, 2)}/${h2}`, asset2);
  const assetIndex = add('https://piston-meta.test/indexes/17.json', JSON.stringify({ objects: { 'minecraft/sounds/a.ogg': { hash: h1, size: asset1.length }, 'minecraft/lang/en_us.json': { hash: h2, size: asset2.length } } }));
  // A fake "java" that records its arguments, so launch() really spawns something.
  const javaScript = add('https://piston-data.test/java', '#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/launch-args.txt"\necho "[Render thread/INFO]: Setting user: test"\nexit 0\n');
  const runtimeManifest = add('https://piston-meta.test/runtime-manifest.json', JSON.stringify({
    files: {
      bin: { type: 'directory' },
      'bin/java': { type: 'file', executable: true, downloads: { raw: javaScript } },
      'bin/javaw.exe': { type: 'file', executable: true, downloads: { raw: javaScript } },
      'jre.bundle/Contents/Home/bin/java': { type: 'file', executable: true, downloads: { raw: javaScript } },
    },
  }));
  const versionJson = {
    id: '1.21.1', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    assetIndex: { id: '17', url: assetIndex.url, sha1: assetIndex.sha1 }, assets: '17',
    downloads: { client: clientJar },
    javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
    libraries: [
      { name: 'com.mojang:brigadier:1.3.10', downloads: { artifact: { path: 'com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar', ...lib1 } } },
      { name: 'org.lwjgl:lwjgl:3.3.3:natives-windows', downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar', ...natWin } }, rules: [{ action: 'allow', os: { name: 'windows' } }] },
      { name: 'org.lwjgl:lwjgl:3.3.3:natives-linux', downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar', ...natLin } }, rules: [{ action: 'allow', os: { name: 'linux' } }] },
    ],
    arguments: {
      game: ['--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}', '--assetsDir', '${assets_root}', '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--userType', '${user_type}'],
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
    },
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client-1.21.xml', ...logCfg } } },
  };
  const vj = add('https://piston-meta.test/v1/1.21.1.json', JSON.stringify(versionJson));
  const fabricLib = add('https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar', 'fabric loader');
  const routes = [
    ['GET', 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', () => ({ json: { latest: { release: '1.21.1' }, versions: [{ id: '1.21.1', type: 'release', url: vj.url, sha1: vj.sha1, releaseTime: '2024-08-08' }] } })],
    ['GET', /java-runtime\/.*\/all\.json$/, () => ({ json: { [platformKey()]: { 'java-runtime-delta': [{ manifest: { url: runtimeManifest.url, sha1: runtimeManifest.sha1 }, version: { name: '21.0.7' } }] } } })],
    ['GET', 'https://meta.fabricmc.net/v2/versions/loader/1.21.1', () => ({ json: [{ loader: { version: '0.16.10', stable: true } }, { loader: { version: '0.17.0-beta.1', stable: false } }] })],
    ['GET', 'https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.10/profile/json', () => ({ json: {
      id: 'fabric-loader-0.16.10-1.21.1', inheritsFrom: '1.21.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
      libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.10', url: 'https://maven.fabricmc.net/', sha1: fabricLib.sha1 }],
    } })],
    ['GET', /.*/, (url) => (files[url] ? { body: files[url] } : { status: 404, body: 'missing' })],
  ];
  return { routes, files };
}

test('creates a Fabric instance, installs everything, and launches it', async () => {
  const { routes } = fakeGameServer();
  const ctx = await makeCtx(routes);
  const { instances } = services(ctx);
  const { listLoaderVersions, pickDefault } = require('../src/core/loaders');
  const lv = await listLoaderVersions(ctx, 'fabric', '1.21.1');
  assert.equal(pickDefault(lv).version, '0.16.10');
  const inst = await instances.create({ name: 'Fabric 1.21.1', mcVersion: '1.21.1', loader: { type: 'fabric', version: '0.16.10' } });
  const progress = [];
  const prepared = await prepareInstance(ctx, inst, (p, d) => progress.push([p, d]));
  assert.equal(prepared.version.id, 'fabric-loader-0.16.10-1.21.1');
  assert.ok(fs.existsSync(prepared.java));
  assert.ok(fs.existsSync(path.join(ctx.paths.libraries, 'net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar')));
  assert.ok(fs.existsSync(path.join(ctx.paths.versions, 'fabric-loader-0.16.10-1.21.1', 'fabric-loader-0.16.10-1.21.1.jar')), 'client jar copied under loader version name');
  assert.ok(fs.readdirSync(path.join(ctx.paths.assets, 'objects')).length === 2);
  const osLib = process.platform === 'win32' ? 'natives-windows' : 'natives-linux';
  assert.ok(prepared.files.libraries.some((l) => l.includes(osLib)));
  assert.ok(!prepared.files.libraries.some((l) => l.includes(process.platform === 'win32' ? 'natives-linux' : 'natives-windows')));
  assert.ok(progress.length > 3);

  if (process.platform === 'win32') return; // the fake java is a shell script
  const creds = { name: 'Daniel', uuid: 'u-u-i-d', accessToken: 'super-secret-token', userType: 'msa', xuid: '1' };
  const logs = [];
  const exit = await new Promise((resolve) => {
    launch(ctx, inst, prepared, creds, { gameDir: instances.gameDir(inst.id), onLog: (l) => logs.push(l), onExit: resolve });
  });
  assert.equal(exit.code, 0);
  const args = fs.readFileSync(path.join(instances.gameDir(inst.id), 'launch-args.txt'), 'utf8').trim().split('\n');
  assert.ok(args.includes('net.fabricmc.loader.impl.launch.knot.KnotClient'));
  assert.equal(args[args.indexOf('--username') + 1], 'Daniel');
  assert.equal(args[args.indexOf('--version') + 1], 'fabric-loader-0.16.10-1.21.1');
  assert.ok(args.some((a) => a.startsWith('-Dlog4j.configurationFile=')));
  assert.ok(logs.some((l) => l.includes('Setting user')));
  assert.ok(!logs.join('\n').includes('super-secret-token'), 'access token must be redacted from logs');

  // Second launch prep should be fast: nothing re-downloaded.
  const before = ctx.requestLog.length;
  await prepareInstance(ctx, inst);
  const downloads = ctx.requestLog.slice(before).filter((r) => /client\.jar|brigadier|resources\.download/.test(r.url));
  assert.equal(downloads.length, 0);
});

// ------------------------------------------------------------------ fake Modrinth + CurseForge content
function fakeContentApis() {
  const blobs = {};
  const file = (url, buf) => { blobs[url] = buf; return { url, sha1: sha1(buf), sha512: sha512(buf), size: buf.length }; };
  const coolJar = fabricJar('coolmod', 'Cool Mod', '2.0.0');
  const libxJar = fabricJar('libx', 'Lib X', '1.0.0');
  const fapiJar = fabricJar('fabric-api', 'Fabric API', '0.110.0');
  const sodiumMr = fabricJar('sodium', 'Sodium', '0.6.0');
  const sodiumCf = fabricJar('sodium', 'Sodium', '0.6.1');
  const blockedJar = fabricJar('blockedmod', 'Blocked Mod', '1.0.0');
  const f = {
    cool: file('https://cdn.modrinth.com/data/COOL/versions/v2/coolmod-2.0.0.jar', coolJar),
    libx: file('https://cdn.modrinth.com/data/LIBX/versions/v1/libx-1.0.0.jar', libxJar),
    fapiCf: file('https://edge.forgecdn.net/files/5000/1/fabric-api-0.110.0.jar', fapiJar),
    sodiumMr: file('https://cdn.modrinth.com/data/AANobbMI/versions/s1/sodium-0.6.0.jar', sodiumMr),
    sodiumCf: file('https://edge.forgecdn.net/files/6000/2/sodium-0.6.1.jar', sodiumCf),
  };
  const mrVersion = (id, projectId, name, fl, deps = []) => ({
    id, project_id: projectId, name, version_number: name, game_versions: ['1.21.1'], loaders: ['fabric'], version_type: 'release', date_published: '2026-01-01T00:00:00Z',
    files: [{ url: fl.url, filename: path.basename(fl.url), hashes: { sha1: fl.sha1, sha512: fl.sha512 }, size: fl.size, primary: true }], dependencies: deps,
  });
  const mrVersions = {
    COOL: [mrVersion('v2', 'COOL', '2.0.0', f.cool, [{ project_id: 'P7dR8mSH', dependency_type: 'required' }, { project_id: 'LIBX', dependency_type: 'required' }, { project_id: 'OPT', dependency_type: 'optional' }])],
    LIBX: [mrVersion('v1', 'LIBX', '1.0.0', f.libx)],
    P7dR8mSH: [mrVersion('fapi1', 'P7dR8mSH', '0.110.0', file('https://cdn.modrinth.com/data/P7dR8mSH/versions/fapi1/fabric-api-0.110.0.jar', fapiJar))],
    AANobbMI: [mrVersion('s1', 'AANobbMI', '0.6.0', f.sodiumMr)],
  };
  const mrProjects = {
    COOL: { id: 'COOL', slug: 'coolmod', title: 'Cool Mod', project_type: 'mod', icon_url: null, client_side: 'required', server_side: 'unsupported' },
    LIBX: { id: 'LIBX', slug: 'libx', title: 'Lib X', project_type: 'mod', client_side: 'required', server_side: 'required' },
    P7dR8mSH: { id: 'P7dR8mSH', slug: 'fabric-api', title: 'Fabric API', project_type: 'mod' },
    AANobbMI: { id: 'AANobbMI', slug: 'sodium', title: 'Sodium', project_type: 'mod' },
  };
  const allMrVersions = Object.values(mrVersions).flat();
  const cfFile = (id, modId, name, fl, extra = {}) => ({
    id, modId, displayName: name, fileName: fl ? path.basename(fl.url) : `${name}.jar`, downloadUrl: fl ? fl.url : null, gameVersions: ['1.21.1', 'Fabric'], releaseType: 1, fileDate: '2026-02-01T00:00:00Z',
    hashes: fl ? [{ value: fl.sha1, algo: 1 }] : [], fileLength: fl ? fl.size : 0, dependencies: [], fileFingerprint: 0, ...extra,
  });
  const blockedSha = sha1(blockedJar);
  const cfFiles = {
    5001: cfFile(5001, 306612, 'fabric-api-0.110.0', f.fapiCf),
    6001: cfFile(6001, 394468, 'sodium-0.6.1', f.sodiumCf),
    7001: { ...cfFile(7001, 777, 'blockedmod-1.0.0', null), fileName: 'blockedmod-1.0.0.jar', hashes: [{ value: blockedSha, algo: 1 }] },
  };
  const cfMods = {
    306612: { id: 306612, slug: 'fabric-api', name: 'Fabric API', classId: 6, links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/fabric-api' }, latestFilesIndexes: [] },
    394468: { id: 394468, slug: 'sodium', name: 'Sodium', classId: 6, links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/sodium' }, latestFilesIndexes: [{ gameVersion: '1.21.1', fileId: 6001, modLoader: 4, releaseType: 1 }] },
    777: { id: 777, slug: 'blocked-mod', name: 'Blocked Mod', classId: 6, allowModDistribution: false, links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/blocked-mod' }, latestFilesIndexes: [] },
  };
  const API = 'https://api.modrinth.com/v2';
  const routes = [
    ['GET', new RegExp(`^${API}/project/([^/]+)/version`), (url) => {
      const id = decodeURIComponent(url.match(/project\/([^/]+)\/version/)[1]);
      return { json: mrVersions[id] || [] };
    }],
    ['GET', new RegExp(`^${API}/project/([^/?]+)$`), (url) => {
      const id = decodeURIComponent(url.split('/project/')[1]);
      return mrProjects[id] ? { json: mrProjects[id] } : { status: 404, json: {} };
    }],
    ['GET', new RegExp(`^${API}/projects\\?ids=`), (url) => {
      const ids = JSON.parse(decodeURIComponent(url.split('ids=')[1]));
      return { json: ids.map((i) => mrProjects[i]).filter(Boolean) };
    }],
    ['GET', new RegExp(`^${API}/version/([^/]+)$`), (url) => ({ json: allMrVersions.find((v) => v.id === url.split('/version/')[1]) })],
    ['POST', `${API}/version_files`, (_u, body) => {
      const out = {};
      for (const h of body.hashes) { const v = allMrVersions.find((x) => x.files[0].hashes.sha1 === h); if (v) out[h] = v; }
      return { json: out };
    }],
    ['POST', `${API}/version_files/update`, (_u, body) => {
      const out = {};
      for (const h of body.hashes) {
        if (h === f.sodiumMr.sha1) out[h] = { ...mrVersions.AANobbMI[0], id: 's2', version_number: '0.6.2', files: [{ ...mrVersions.AANobbMI[0].files[0], hashes: { sha1: 'newsha' } }] };
      }
      return { json: out };
    }],
    ['GET', /^https:\/\/api\.curseforge\.com\/v1\/mods\/(\d+)\/files/, (url) => {
      const id = Number(url.match(/mods\/(\d+)\/files/)[1]);
      return { json: { data: Object.values(cfFiles).filter((x) => x.modId === id), pagination: { totalCount: 1 } } };
    }],
    ['POST', 'https://api.curseforge.com/v1/mods/files', (_u, body) => ({ json: { data: body.fileIds.map((i) => cfFiles[i]).filter(Boolean) } })],
    ['POST', 'https://api.curseforge.com/v1/mods', (_u, body) => ({ json: { data: body.modIds.map((i) => cfMods[i]).filter(Boolean) } })],
    ['POST', 'https://api.curseforge.com/v1/fingerprints/432', (_u, body) => {
      const fp = curseFingerprint(fapiJar);
      return { json: { data: { exactMatches: body.fingerprints.includes(fp) ? [{ id: 306612, file: { ...cfFiles[5001], fileFingerprint: fp } }] : [] } } };
    }],
    ['GET', /.*/, (url) => (blobs[url] ? { body: blobs[url] } : { status: 404, body: 'nope' })],
  ];
  return { routes, f, jars: { coolJar, fapiJar, sodiumMr, sodiumCf, blockedJar }, cfFiles };
}

test('installs a Modrinth mod with dependencies, skipping one already installed from CurseForge', async () => {
  const api = fakeContentApis();
  const ctx = await makeCtx(api.routes, { cfKey: 'k' });
  const { instances, content } = services(ctx);
  const inst = await instances.create({ name: 'Fabric 1.21.1', mcVersion: '1.21.1', loader: { type: 'fabric', version: '0.16.10' } });

  // Fabric API from CurseForge first.
  const r0 = await content.installProject(inst.id, { source: 'curseforge', id: 306612 }, 'mod');
  assert.equal(r0.installed.length, 1);
  assert.equal(ctx.requestLog.find((x) => x.url.includes('forgecdn')).headers['x-api-key'], 'k');

  // Cool Mod from Modrinth needs Fabric API (already there, from CF) + Lib X.
  const r = await content.installProject(inst.id, { source: 'modrinth', id: 'COOL' }, 'mod');
  assert.deepEqual(r.installed.map((i) => i.title).sort(), ['Cool Mod', 'Lib X']);
  assert.ok(r.skipped.some((s) => s.title === 'Fabric API'));
  const mods = await instances.listContent(inst.id, 'mod');
  assert.deepEqual(mods.map((m) => m.title).sort(), ['Cool Mod', 'Fabric API', 'Lib X']);
  assert.equal(mods.find((m) => m.title === 'Fabric API').source, 'curseforge');
  assert.ok(!mods.some((m) => m.duplicateOf));

  // Browse uses this to show "Installed" — Fabric API is known by its CurseForge id, title and mod id.
  const info = await content.installedInfo(inst.id);
  assert.ok(info.projects['curseforge:306612']);
  assert.equal(info.projects['modrinth:COOL'].versionId, 'v2');
  assert.ok(info.titles.includes('fabricapi') && info.modIds.includes('fabricapi'));
  assert.ok(!info.projects['modrinth:P7dR8mSH'], 'not installed from Modrinth, so only title/mod-id matching finds it');

  // Same mod from the other site replaces the old jar instead of duplicating it.
  await content.installProject(inst.id, { source: 'modrinth', id: 'AANobbMI' }, 'mod');
  const r2 = await content.installProject(inst.id, { source: 'curseforge', id: 394468 }, 'mod');
  assert.ok(r2.warnings.some((w) => /Replaced sodium-0\.6\.0\.jar/.test(w)));
  const after = await instances.listContent(inst.id, 'mod');
  assert.equal(after.filter((m) => m.modId === 'sodium').length, 1);

  // Disable / enable / remove.
  const cool = after.find((m) => m.title === 'Cool Mod');
  await content.setEnabled(inst.id, cool.file, false);
  assert.equal((await instances.listContent(inst.id, 'mod')).find((m) => m.title === 'Cool Mod').enabled, false);
  await content.setEnabled(inst.id, cool.file, true);
  await content.removeFiles(inst.id, [cool.file]);
  assert.ok(!(await instances.listContent(inst.id, 'mod')).some((m) => m.title === 'Cool Mod'));
});

test('flags duplicates of the same mod id and finds updates on both sites (pins respected)', async () => {
  const api = fakeContentApis();
  const ctx = await makeCtx(api.routes, { cfKey: 'k' });
  const { instances, content } = services(ctx);
  const inst = await instances.create({ name: 'x', mcVersion: '1.21.1', loader: { type: 'fabric', version: '0.16.10' } });
  // Two Sodium jars dropped in by hand.
  const modsDir = path.join(instances.gameDir(inst.id), 'mods');
  fs.writeFileSync(path.join(modsDir, 'sodium-a.jar'), api.jars.sodiumMr);
  fs.writeFileSync(path.join(modsDir, 'sodium-b.jar'), api.jars.sodiumCf);
  const list = await instances.listContent(inst.id, 'mod');
  assert.equal(list.filter((m) => m.duplicateOf).length, 1);
  fs.rmSync(path.join(modsDir, 'sodium-b.jar'));

  // Identify the hand-copied jar on Modrinth, then check for updates.
  const idr = await content.identify(inst.id);
  assert.equal(idr.identified, 1);
  const ups = await content.checkUpdates(inst.id);
  const u = ups.find((x) => x.title === 'Sodium');
  assert.equal(u.next, '0.6.2');
  await content.setPinned(inst.id, 'mods/sodium-a.jar', true);
  assert.ok(!(await content.checkUpdates(inst.id)).some((x) => x.title === 'Sodium'));
});

test('blocked CurseForge files are reported, then picked up from the Downloads folder', async () => {
  const api = fakeContentApis();
  const ctx = await makeCtx(api.routes, { cfKey: 'k' });
  const { instances, content } = services(ctx);
  const inst = await instances.create({ name: 'x', mcVersion: '1.21.1', loader: { type: 'fabric', version: '0.16.10' } });
  const r = await content.installProject(inst.id, { source: 'curseforge', id: 777 }, 'mod');
  assert.equal(r.installed.length, 0);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].pageUrl, 'https://www.curseforge.com/minecraft/mc-mods/blocked-mod/download/7001');

  const downloads = tmpDir();
  const w = new BlockedWatcher(content, inst.id, r.blocked, downloads);
  const done = new Promise((resolve) => w.on('complete', resolve));
  w.start();
  fs.writeFileSync(path.join(downloads, 'blockedmod-1.0.0 (1).jar'), Buffer.from('wrong file'));
  fs.writeFileSync(path.join(downloads, 'blockedmod-1.0.0.jar'), api.jars.blockedJar);
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('watcher timeout')), 8000))]);
  const mods = await instances.listContent(inst.id, 'mod');
  assert.equal(mods[0].title, 'Blocked Mod');
  assert.equal(mods[0].source, 'curseforge');
});

test('installs a .mrpack, rejects path traversal, and exports back to .mrpack and CurseForge', async () => {
  const api = fakeContentApis();
  const ctx = await makeCtx(api.routes, { cfKey: 'k' });
  const { instances, content, modpacks, sources } = services(ctx);
  const index = {
    formatVersion: 1, game: 'minecraft', versionId: '3.1.0', name: 'Test Pack',
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' },
    files: [
      { path: 'mods/coolmod-2.0.0.jar', hashes: { sha1: api.f.cool.sha1, sha512: api.f.cool.sha512 }, downloads: [api.f.cool.url], fileSize: api.f.cool.size, env: { client: 'required', server: 'required' } },
      { path: 'mods/serveronly.jar', hashes: { sha1: api.f.libx.sha1, sha512: api.f.libx.sha512 }, downloads: [api.f.libx.url], env: { client: 'unsupported', server: 'required' } },
      { path: '../../escape.jar', hashes: { sha1: api.f.libx.sha1, sha512: api.f.libx.sha512 }, downloads: [api.f.libx.url], env: { client: 'required' } },
    ],
  };
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index)));
  zip.addFile('overrides/config/pack.toml', Buffer.from('a = 1'));
  zip.addFile('overrides/mods/bundled.jar', fabricJar('bundled', 'Bundled', '1.0'));
  zip.addFile('client-overrides/options.txt', Buffer.from('fov:90'));
  const packPath = path.join(ctx.root, 'test.mrpack');
  zip.writeZip(packPath);

  const r = await modpacks.installFile(packPath, {});
  const inst = r.instance;
  assert.equal(inst.name, 'Test Pack');
  assert.deepEqual(inst.loader, { type: 'fabric', version: '0.16.10' });
  const gd = instances.gameDir(inst.id);
  assert.ok(fs.existsSync(path.join(gd, 'mods/coolmod-2.0.0.jar')));
  assert.ok(!fs.existsSync(path.join(gd, 'mods/serveronly.jar')), 'server-only files skipped');
  assert.ok(!fs.existsSync(path.join(ctx.root, 'escape.jar')) && !fs.existsSync(path.join(path.dirname(gd), 'escape.jar')));
  assert.ok(r.warnings.some((w) => /Unsafe/.test(w)));
  assert.equal(fs.readFileSync(path.join(gd, 'options.txt'), 'utf8'), 'fov:90');
  const mods = await instances.listContent(inst.id, 'mod');
  assert.equal(mods.find((m) => m.fileName === 'coolmod-2.0.0.jar').source, 'modrinth');

  // Add a CurseForge-only mod, then export both ways.
  await content.installProject(inst.id, { source: 'curseforge', id: 306612 }, 'mod');
  const out = path.join(ctx.root, 'out.mrpack');
  const ex = await exportMrpack({ instances, sources }, inst.id, out, { name: 'Mine', version: '1.0.0', include: ['mods', 'config', 'options.txt'] });
  const exIndex = JSON.parse(new AdmZip(out).readAsText('modrinth.index.json'));
  // Fabric API's jar is identical on Modrinth, so it's linked rather than bundled.
  assert.deepEqual(exIndex.files.map((x) => x.path).sort(), ['mods/coolmod-2.0.0.jar', 'mods/fabric-api-0.110.0.jar']);
  assert.ok(exIndex.files.every((x) => x.hashes.sha512 && x.downloads[0].startsWith('https://cdn.modrinth.com/')));
  assert.equal(exIndex.dependencies['fabric-loader'], '0.16.10');
  assert.ok(new AdmZip(out).getEntry('overrides/config/pack.toml'));
  assert.deepEqual(ex.bundledContent, ['mods/bundled.jar']);

  const outCf = path.join(ctx.root, 'out-cf.zip');
  const exCf = await exportCurseForge({ instances, sources }, inst.id, outCf, { name: 'Mine', include: ['mods', 'config'] });
  const manifest = JSON.parse(new AdmZip(outCf).readAsText('manifest.json'));
  assert.deepEqual(manifest.minecraft.modLoaders, [{ id: 'fabric-0.16.10', primary: true }]);
  assert.deepEqual(manifest.files, [{ projectID: 306612, fileID: 5001, required: true }]);
  assert.ok(exCf.bundledContent.includes('mods/coolmod-2.0.0.jar'));

  // Round trip: re-import our own export.
  const again = await modpacks.installFile(out, { name: 'Reimported' });
  const mods2 = await instances.listContent(again.instance.id, 'mod');
  assert.deepEqual(mods2.map((m) => m.fileName).sort(), ['bundled.jar', 'coolmod-2.0.0.jar', 'fabric-api-0.110.0.jar']);
});

test('installs a CurseForge modpack zip and reports blocked files', async () => {
  const api = fakeContentApis();
  const ctx = await makeCtx(api.routes, { cfKey: 'k' });
  const { instances, modpacks } = services(ctx);
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '1.21.1', modLoaders: [{ id: 'fabric-0.16.10', primary: true }] }, manifestType: 'minecraftModpack', manifestVersion: 1,
    name: 'CF Pack', version: '2.0', files: [{ projectID: 306612, fileID: 5001, required: true }, { projectID: 777, fileID: 7001, required: true }], overrides: 'overrides',
  })));
  zip.addFile('overrides/config/x.json', Buffer.from('{}'));
  const p = path.join(ctx.root, 'cf.zip');
  zip.writeZip(p);
  const r = await modpacks.installFile(p, {});
  assert.deepEqual(r.instance.loader, { type: 'fabric', version: '0.16.10' });
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].fileName, 'blockedmod-1.0.0.jar');
  const mods = await instances.listContent(r.instance.id, 'mod');
  assert.equal(mods.length, 1);
  assert.equal(mods[0].source, 'curseforge');
  assert.ok(fs.existsSync(path.join(instances.gameDir(r.instance.id), 'config/x.json')));
});

test('CurseForge packs without an API key fail with a clear message', async () => {
  const ctx = await makeCtx([]);
  const { modpacks } = services(ctx);
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ minecraft: { version: '1.21.1', modLoaders: [] }, manifestType: 'minecraftModpack', files: [{ projectID: 1, fileID: 2 }] })));
  const p = path.join(ctx.root, 'cf.zip');
  zip.writeZip(p);
  await assert.rejects(modpacks.installFile(p, {}), /CurseForge API key/);
});

test('imports a CurseForge-app instance folder and recognises its mods', async () => {
  const api = fakeContentApis();
  const ctx = await makeCtx(api.routes, { cfKey: 'k' });
  const svc = services(ctx);
  const src = tmpDir();
  fs.writeFileSync(path.join(src, 'minecraftinstance.json'), JSON.stringify({ name: 'My CF Pack', gameVersion: '1.21.1', baseModLoader: { name: 'fabric-0.16.10-1.21.1' } }));
  fs.mkdirSync(path.join(src, 'mods'));
  fs.mkdirSync(path.join(src, 'saves', 'World1'), { recursive: true });
  fs.writeFileSync(path.join(src, 'saves', 'World1', 'level.dat'), 'lvl');
  fs.writeFileSync(path.join(src, 'mods', 'coolmod.jar'), api.jars.coolJar);
  fs.writeFileSync(path.join(src, 'mods', 'fapi.jar'), api.jars.fapiJar);
  fs.writeFileSync(path.join(src, 'mods', 'mystery.jar'), fabricJar('mystery'));
  const info = await detectInstance(src);
  assert.equal(info.from, 'CurseForge app');
  assert.equal(info.mcVersion, '1.21.1');
  assert.equal(info.loader, 'fabric');
  assert.equal(info.loaderVersion, '0.16.10');
  const r = await importInstance(svc, info, { mcVersion: info.mcVersion, loader: info.loader, loaderVersion: info.loaderVersion });
  assert.equal(r.total, 3);
  assert.equal(r.identified, 2); // coolmod (Modrinth hash) + Fabric API (Modrinth or CF), mystery stays local
  const gd = svc.instances.gameDir(r.instance.id);
  assert.ok(fs.existsSync(path.join(gd, 'saves', 'World1', 'level.dat')));
  assert.ok(!fs.existsSync(path.join(gd, 'minecraftinstance.json')));
  assert.ok(fs.existsSync(path.join(src, 'mods', 'coolmod.jar')), 'original folder untouched');
});

test('Microsoft device-code sign-in, token refresh, and offline unlock', async () => {
  let polls = 0;
  const jwt = `x.${Buffer.from(JSON.stringify({ xuid: '2535' })).toString('base64url')}.y`;
  let mcCalls = 0;
  const routes = [
    ['POST', 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', () => ({ json: { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://microsoft.com/link', expires_in: 60, interval: 0.01 } })],
    ['POST', 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token', (_u, body) => {
      if (String(body).includes('device_code')) {
        polls++;
        return polls < 2 ? { status: 400, json: { error: 'authorization_pending' } } : { json: { access_token: 'ms-at', refresh_token: 'ms-rt', expires_in: 3600 } };
      }
      return { json: { access_token: 'ms-at-2', refresh_token: 'ms-rt-2' } };
    }],
    ['POST', 'https://user.auth.xboxlive.com/user/authenticate', () => ({ json: { Token: 'xbl' } })],
    ['POST', 'https://xsts.auth.xboxlive.com/xsts/authorize', () => ({ json: { Token: 'xsts', DisplayClaims: { xui: [{ uhs: 'uhs1' }] } } })],
    ['POST', 'https://api.minecraftservices.com/authentication/login_with_xbox', () => { mcCalls++; return { json: { access_token: jwt, expires_in: mcCalls === 1 ? 1 : 86400 } }; }],
    ['GET', 'https://api.minecraftservices.com/minecraft/profile', () => ({ json: { id: 'abc123', name: 'DanielMC' } })],
  ];
  const ctx = await makeCtx(routes);
  await ctx.settings.update({ msClientId: 'client-id' });
  const accounts = await new Accounts(ctx).load();
  assert.equal(accounts.canAddOffline(), false);
  await assert.rejects(accounts.addOffline('Steve'));
  const begin = await accounts.beginMicrosoftLogin();
  assert.equal(begin.userCode, 'ABCD-1234');
  const acc = await accounts.completeMicrosoftLogin(begin.loginId);
  assert.equal(acc.name, 'DanielMC');
  const stored = fs.readFileSync(ctx.paths.accountsFile, 'utf8');
  assert.ok(!stored.includes('ms-rt'), 'refresh token not stored in plain text');
  // Token expired (expires_in: 1) -> refresh happens on launch.
  const creds = await accounts.launchCredentials();
  assert.equal(creds.name, 'DanielMC');
  assert.equal(creds.xuid, '2535');
  assert.equal(mcCalls, 2);
  assert.equal(accounts.canAddOffline(), true);
  await accounts.addOffline('Steve');
  assert.equal((await accounts.launchCredentials()).offline, true);
});

test('Microsoft sign-in explains when Mojang has not approved the app', async () => {
  const routes = [
    ['POST', /devicecode$/, () => ({ json: { device_code: 'dc', user_code: 'C', verification_uri: 'u', expires_in: 60, interval: 0.01 } })],
    ['POST', /token$/, () => ({ json: { access_token: 'ms', refresh_token: 'r' } })],
    ['POST', /user\.auth\.xboxlive/, () => ({ json: { Token: 'xbl' } })],
    ['POST', /xsts/, () => ({ json: { Token: 'x', DisplayClaims: { xui: [{ uhs: 'u' }] } } })],
    ['POST', /login_with_xbox/, () => ({ status: 403, json: { error: 'Invalid app registration' } })],
  ];
  const ctx = await makeCtx(routes);
  await ctx.settings.update({ msClientId: 'id' });
  const accounts = await new Accounts(ctx).load();
  const b = await accounts.beginMicrosoftLogin();
  await assert.rejects(accounts.completeMicrosoftLogin(b.loginId), (e) => e.code === 'APP_NOT_APPROVED');
});

// ------------------------------------------------------------------ multi-select: bulk actions + send to instance
function countIndexWrites(instances) {
  const counter = { n: 0 };
  const orig = instances.writeIndex.bind(instances);
  instances.writeIndex = async (...a) => { counter.n++; return orig(...a); };
  return counter;
}

async function fabricInstance(instances, name, mc = '1.21.1') {
  return instances.create({ name, mcVersion: mc, loader: { type: 'fabric', version: '0.16.10' } });
}

test('bulk actions: enable/disable, pin and remove many files, with one content.json write each', async () => {
  const api = fakeContentApis();
  const ctx = await makeCtx(api.routes, { cfKey: 'k' });
  const { instances, content } = services(ctx);
  const inst = await fabricInstance(instances, 'Bulk');
  await content.installProject(inst.id, { source: 'modrinth', id: 'COOL' }, 'mod'); // + Lib X + Fabric API
  const mods = await instances.listContent(inst.id, 'mod');
  assert.equal(mods.length, 3);
  const rels = mods.map((m) => m.file);
  const writes = countIndexWrites(instances);

  // Enabling/disabling only renames files: the index isn't written at all.
  assert.deepEqual(await content.setEnabledMany(inst.id, rels.slice(0, 2), false), { changed: 2 });
  assert.deepEqual(await content.setEnabledMany(inst.id, rels.slice(0, 2), false), { changed: 0 }, 'already disabled');
  assert.equal(writes.n, 0);
  const afterOff = await instances.listContent(inst.id, 'mod');
  assert.equal(afterOff.filter((m) => !m.enabled).length, 2);
  writes.n = 0;
  await content.setEnabledMany(inst.id, rels, true);
  assert.equal((await instances.listContent(inst.id, 'mod')).filter((m) => !m.enabled).length, 0);

  // Pinning three files is one index write.
  writes.n = 0;
  await content.setPinnedMany(inst.id, rels, true);
  assert.equal(writes.n, 1);
  assert.ok((await instances.listContent(inst.id, 'mod')).every((m) => m.pinned));
  writes.n = 0;
  await content.setPinnedMany(inst.id, rels.slice(0, 1), false);
  assert.equal(writes.n, 1);
  await assert.rejects(content.setPinnedMany(inst.id, ['../evil.jar'], true), /Unsafe/);
  assert.equal((await instances.listContent(inst.id, 'mod')).filter((m) => m.pinned).length, 2);

  // Removing two files (one enabled, one disabled) is one index write and removes both files from disk.
  await content.setEnabledMany(inst.id, [rels[1]], false);
  writes.n = 0;
  await content.removeFiles(inst.id, rels.slice(0, 2));
  assert.equal(writes.n, 1);
  assert.equal((await instances.listContent(inst.id, 'mod')).length, 1);
  assert.ok(!fs.existsSync(instances.contentPath(inst.id, rels[1], false)), 'the .disabled file is gone too');
});

test('copy list: names and project links as Markdown', async () => {
  const api = fakeContentApis();
  const ctx = await makeCtx(api.routes, { cfKey: 'k' });
  const { instances, content } = services(ctx);
  const inst = await fabricInstance(instances, 'Md');
  await content.installProject(inst.id, { source: 'modrinth', id: 'COOL' }, 'mod');
  fs.writeFileSync(path.join(instances.gameDir(inst.id), 'mods', 'mine.jar'), fabricJar('mine', 'My [Tweaks]', '1.2'));
  const list = await instances.listContent(inst.id, 'mod');
  const cool = list.find((m) => m.title === 'Cool Mod');
  const mine = list.find((m) => m.modId === 'mine');
  const md = await content.markdownList(inst.id, [cool.file, mine.file, 'mods/missing.jar']);
  assert.equal(md, '- [Cool Mod](https://modrinth.com/mod/coolmod) — 2.0.0\n- My \\[Tweaks\\] — 1.2');
});

test('client-only: from the jar (environment) and from Modrinth (stored in content.json)', async () => {
  const api = fakeContentApis();
  const ctx = await makeCtx(api.routes, { cfKey: 'k' });
  const { instances, content } = services(ctx);
  const inst = await fabricInstance(instances, 'Sides');
  await content.installProject(inst.id, { source: 'modrinth', id: 'COOL' }, 'mod'); // Modrinth: client required, server unsupported
  const modsDir = path.join(instances.gameDir(inst.id), 'mods');
  fs.writeFileSync(path.join(modsDir, 'hud.jar'), fabricJar('hud', 'Fancy HUD', '1.0', { environment: 'client' }));
  fs.writeFileSync(path.join(modsDir, 'both.jar'), fabricJar('both', 'Both Sides', '1.0', { environment: '*' }));
  const list = await instances.listContent(inst.id, 'mod');
  const flag = (title) => list.find((m) => m.title === title).clientOnly;
  assert.equal(flag('Cool Mod'), true, 'Modrinth says server_side is unsupported');
  assert.equal(flag('Fancy HUD'), true, "the jar's own environment says client");
  assert.equal(flag('Both Sides'), false);
  assert.equal(flag('Lib X'), false, 'required on both sides');
  const idx = await instances.readIndex(inst.id);
  assert.deepEqual(idx.files[list.find((m) => m.title === 'Cool Mod').file].sides, { client: 'required', server: 'unsupported' });

  // Mods linked before sides were stored get them with one request and one write.
  const rel = list.find((m) => m.title === 'Cool Mod').file;
  await instances.withIndex(inst.id, (i) => { delete i.files[rel].sides; });
  assert.equal((await instances.listContent(inst.id, 'mod')).find((m) => m.title === 'Cool Mod').clientOnly, false);
  const writes = countIndexWrites(instances);
  const before = ctx.requestLog.length;
  assert.deepEqual(await content.refreshSides(inst.id), { updated: 1 });
  assert.equal(writes.n, 1);
  assert.equal(ctx.requestLog.slice(before).filter((r) => /\/projects\?ids=/.test(r.url)).length, 1);
  assert.equal((await instances.listContent(inst.id, 'mod')).find((m) => m.title === 'Cool Mod').clientOnly, true);
  assert.deepEqual(await content.refreshSides(inst.id), { updated: 0 });
});

test('send to instance: installs the best version for the target, copies matching local files, and reports the rest', async () => {
  const api = fakeContentApis();
  const ctx = await makeCtx(api.routes, { cfKey: 'k' });
  const { instances, content } = services(ctx);
  const a = await fabricInstance(instances, 'Source');
  const b = await fabricInstance(instances, 'Target');
  await content.installProject(a.id, { source: 'modrinth', id: 'COOL' }, 'mod'); // + Lib X + Fabric API
  await content.installProject(a.id, { source: 'modrinth', id: 'AANobbMI' }, 'mod'); // Sodium
  const modsA = path.join(instances.gameDir(a.id), 'mods');
  fs.writeFileSync(path.join(modsA, 'tweaks.jar'), fabricJar('tweaks', 'My Tweaks', '1.0'));
  fs.writeFileSync(path.join(modsA, 'oldforge.jar'), forgeJar('oldforge', 'Old Forge Mod', '1.0'));
  await content.installProject(b.id, { source: 'modrinth', id: 'AANobbMI' }, 'mod'); // Sodium is already in B
  const listA = await instances.listContent(a.id, 'mod');
  const rel = (title) => listA.find((m) => m.title === title).file;

  const r = await content.sendToInstance(a.id, [rel('Cool Mod'), rel('Sodium'), rel('My Tweaks'), rel('Old Forge Mod')], b.id);
  assert.deepEqual(r.installed.map((i) => i.title).sort(), ['Cool Mod', 'Fabric API', 'Lib X'], 'the mod plus what it needs');
  assert.deepEqual(r.skipped.map((s) => [s.title, s.reason]), [['Sodium', 'already installed']]);
  assert.deepEqual(r.copied.map((c) => c.title), ['My Tweaks']);
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0].title, 'Old Forge Mod');
  assert.match(r.unavailable[0].reason, /built for forge, but the target uses fabric/);
  assert.ok(r.warnings.some((w) => /1 local mod/.test(w)));
  const listB = await instances.listContent(b.id, 'mod');
  assert.deepEqual(listB.map((m) => m.title).sort(), ['Cool Mod', 'Fabric API', 'Lib X', 'My Tweaks', 'Sodium']);
  assert.equal(listB.find((m) => m.title === 'Cool Mod').source, 'modrinth');
  assert.equal(listB.find((m) => m.title === 'Cool Mod').clientOnly, true, 'sides travel with the install');
  assert.equal(listB.find((m) => m.title === 'My Tweaks').source, 'local');
  assert.equal((await instances.listContent(a.id, 'mod')).length, 6, 'the source instance is untouched');

  // Sending again finds everything already there.
  const again = await content.sendToInstance(a.id, [rel('Cool Mod'), rel('My Tweaks')], b.id);
  assert.equal(again.installed.length + again.copied.length, 0);
  assert.deepEqual(again.skipped.map((s) => s.title).sort(), ['Cool Mod', 'My Tweaks']);

  await assert.rejects(content.sendToInstance(a.id, [rel('Cool Mod')], a.id), /different instance/);
});

test('send to instance: nothing for a Minecraft version without a build, vanilla targets, and one index write for copied files', async () => {
  const api = fakeContentApis();
  const ctx = await makeCtx(api.routes, { cfKey: 'k' });
  const { instances, content } = services(ctx);
  const a = await fabricInstance(instances, 'Source');
  await content.installProject(a.id, { source: 'modrinth', id: 'AANobbMI' }, 'mod');
  fs.writeFileSync(path.join(instances.gameDir(a.id), 'resourcepacks', 'faithful.zip'), 'zip bytes');
  fs.writeFileSync(path.join(instances.gameDir(a.id), 'mods', 'a.jar'), fabricJar('a', 'Local A', '1.0'));
  fs.writeFileSync(path.join(instances.gameDir(a.id), 'mods', 'b.jar'), fabricJar('b', 'Local B', '1.0'));
  const mods = await instances.listContent(a.id, 'mod');
  const packs = await instances.listContent(a.id, 'resourcepack');

  // A different Minecraft version: Sodium has no build for it.
  const old = await fabricInstance(instances, 'Old', '1.20.1');
  const r1 = await content.sendToInstance(a.id, [mods.find((m) => m.title === 'Sodium').file], old.id);
  assert.equal(r1.installed.length, 0);
  assert.match(r1.unavailable[0].reason, /no version for Minecraft 1\.20\.1 \+ fabric/);

  // Vanilla can't run mods, but resource packs go over.
  const vanilla = await instances.create({ name: 'Vanilla', mcVersion: '1.21.1', loader: { type: 'vanilla' } });
  const r2 = await content.sendToInstance(a.id, [mods[0].file, packs[0].file], vanilla.id);
  assert.match(r2.unavailable[0].reason, /no mod loader/);
  assert.deepEqual(r2.copied.map((c) => c.title), ['faithful']);
  assert.ok(fs.existsSync(instances.contentPath(vanilla.id, 'resourcepacks/faithful.zip')));

  // Two local files copied = one write to the target's content.json.
  const b = await fabricInstance(instances, 'Target');
  const writes = countIndexWrites(instances);
  const r3 = await content.sendToInstance(a.id, mods.filter((m) => m.title.startsWith('Local')).map((m) => m.file), b.id);
  assert.equal(r3.copied.length, 2);
  assert.equal(writes.n, 1);
});
