'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const util = require('../src/core/util');
const { rulesAllow, evaluateArgs } = require('../src/core/minecraft/rules');
const { mergeVersion } = require('../src/core/minecraft/versions');
const { applicableLibraries, libraryArtifact, nativeArtifact } = require('../src/core/minecraft/install');
const { buildLaunchArgs } = require('../src/core/minecraft/launch');
const { neoForgeToMc, parseLoaderId } = require('../src/core/loaders');
const { murmur2, curseFingerprint } = require('../src/core/sources/fingerprint');
const { offlineUuid } = require('../src/core/auth/accounts');
const { readModMetadata } = require('../src/core/content/metadata');
const { interleaveAndMerge, compatibleLoaders } = require('../src/core/sources');
const { guessFromName } = require('../src/core/content/importer');
const { makeCtx, sha1, fabricJar, forgeJar, tmpDir } = require('./helpers');

test('maven paths', () => {
  assert.equal(util.mavenPath('net.fabricmc:fabric-loader:0.16.10'), 'net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar');
  assert.equal(util.mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');
  assert.equal(util.mavenPath('de.oceanlabs.mcp:mcp_config:1.20.1@zip'), 'de/oceanlabs/mcp/mcp_config/1.20.1/mcp_config-1.20.1.zip');
  assert.equal(util.mavenKey('org.lwjgl:lwjgl:3.3.3:natives-windows'), 'org.lwjgl:lwjgl:natives-windows');
  assert.equal(util.mavenKey('org.ow2.asm:asm:9.7'), 'org.ow2.asm:asm');
});

test('safeJoin blocks path traversal from modpacks', () => {
  const base = tmpDir();
  assert.ok(util.safeJoin(base, 'mods/a.jar').startsWith(base));
  assert.throws(() => util.safeJoin(base, '../evil.exe'));
  assert.throws(() => util.safeJoin(base, 'mods/../../evil.exe'));
  assert.throws(() => util.safeJoin(base, '/etc/passwd'));
  assert.throws(() => util.safeJoin(base, 'C:\\Windows\\evil.dll'));
  assert.throws(() => util.safeJoin(base, '..\\evil.exe'));
});

test('splitArgs keeps quoted values together', () => {
  assert.deepEqual(util.splitArgs('-Xss2M  -Dfoo="a b" -XX:+UseZGC'), ['-Xss2M', '-Dfoo=a b', '-XX:+UseZGC']);
  assert.deepEqual(util.splitArgs(''), []);
});

test('version comparison handles new year-based versions', () => {
  assert.ok(util.compareVersions('1.21.10', '1.21.9') > 0);
  assert.ok(util.compareVersions('26.1', '1.21.11') > 0);
  assert.ok(util.compareVersions('26.1.2.5', '26.1.2.10') < 0);
});

test('rules: os, arch and features', () => {
  const win = { os: 'windows', arch: 'x64', osVersion: '10.0' };
  const lin = { os: 'linux', arch: 'x64', osVersion: '6.1' };
  const onlyWin = [{ action: 'allow', os: { name: 'windows' } }];
  const notOsx = [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }];
  assert.equal(rulesAllow(onlyWin, {}, win), true);
  assert.equal(rulesAllow(onlyWin, {}, lin), false);
  assert.equal(rulesAllow(notOsx, {}, lin), true);
  assert.equal(rulesAllow([{ action: 'allow', os: { arch: 'x86' } }], {}, win), false);
  assert.equal(rulesAllow([{ action: 'allow', features: { has_custom_resolution: true } }], { has_custom_resolution: true }, win), true);
  assert.equal(rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], {}, win), false);
  const args = evaluateArgs(['--a', '${x}', { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${w}'] }], { x: 'X', w: 800 }, { has_custom_resolution: true }, win);
  assert.deepEqual(args, ['--a', 'X', '--width', '800']);
});

test('inheritsFrom merge: loader libraries first, args concatenated', () => {
  const parent = { id: '1.21.1', mainClass: 'net.minecraft.client.main.Main', libraries: [{ name: 'org.ow2.asm:asm:9.3' }, { name: 'a:b:1' }], arguments: { game: ['--username'], jvm: ['-cp', '${classpath}'] }, downloads: { client: { url: 'x' } }, assetIndex: { id: '17' }, javaVersion: { component: 'java-runtime-delta', majorVersion: 21 } };
  const parentResolved = { ...parent, _clientJarId: '1.21.1', _chain: ['1.21.1'], _baseId: '1.21.1' };
  const child = { id: 'fabric-loader-0.16.10-1.21.1', inheritsFrom: '1.21.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'org.ow2.asm:asm:9.7', url: 'https://maven.fabricmc.net/' }], arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] } };
  const m = mergeVersion(parentResolved, child);
  assert.equal(m.mainClass, child.mainClass);
  assert.equal(m._clientJarId, '1.21.1');
  assert.equal(m.javaVersion.majorVersion, 21);
  assert.deepEqual(m.arguments.jvm, ['-cp', '${classpath}', '-DFabricMcEmu= net.minecraft.client.main.Main ']);
  const libs = applicableLibraries(m);
  const asm = libs.filter((l) => l.name.startsWith('org.ow2.asm:asm:'));
  assert.equal(asm.length, 1);
  assert.equal(asm[0].name, 'org.ow2.asm:asm:9.7'); // the loader's newer ASM wins
});

test('library artifacts: vanilla, fabric-style and natives', async () => {
  const ctx = await makeCtx();
  const vanilla = libraryArtifact(ctx, { name: 'com.mojang:brigadier:1.2.9', downloads: { artifact: { path: 'com/mojang/brigadier/1.2.9/brigadier-1.2.9.jar', url: 'https://libraries.minecraft.net/x.jar', sha1: 'abc' } } });
  assert.equal(vanilla.sha1, 'abc');
  const fab = libraryArtifact(ctx, { name: 'net.fabricmc:intermediary:1.21.1', url: 'https://maven.fabricmc.net/' });
  assert.equal(fab.url, 'https://maven.fabricmc.net/net/fabricmc/intermediary/1.21.1/intermediary-1.21.1.jar');
  const legacyNatives = { name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4', natives: { linux: 'natives-linux', windows: 'natives-windows', osx: 'natives-osx' }, downloads: { classifiers: { 'natives-linux': { path: 'p/linux.jar', url: 'u-linux', sha1: '1' }, 'natives-windows': { path: 'p/win.jar', url: 'u-win', sha1: '2' }, 'natives-osx': { path: 'p/osx.jar', url: 'u-osx', sha1: '3' } } }, extract: { exclude: ['META-INF/'] } };
  assert.equal(libraryArtifact(ctx, legacyNatives), null);
  const nat = nativeArtifact(ctx, legacyNatives);
  assert.ok(nat.url.startsWith('u-'));
  assert.deepEqual(nat.exclude, ['META-INF/']);
});

test('launch arguments are complete (modern + legacy formats)', async () => {
  const ctx = await makeCtx();
  const creds = { name: 'Daniel', uuid: 'abcd', accessToken: 'tok123456789', userType: 'msa', xuid: '42' };
  const modern = {
    id: 'fabric-loader-0.16.10-1.21.1', mainClass: 'Knot', type: 'release', assetIndex: { id: '17' },
    arguments: {
      jvm: [{ rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] }, '-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
      game: ['--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}', '--assetsDir', '${assets_root}', '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--clientId', '${clientid}', '--xuid', '${auth_xuid}', '--userType', '${user_type}', '--versionType', '${version_type}',
        { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
        { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] },
        { rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] }],
    },
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}' } },
  };
  const prepared = { version: modern, java: 'java', files: { libraries: ['/l/a.jar', '/l/b.jar'], clientJar: '/v/c.jar', nativesDir: '/n', loggingFile: '/log.xml' } };
  const inst = { memoryMax: 6144, memoryMin: 1024, jvmArgs: '-XX:+UseZGC -XX:+ZGenerational', resolution: { width: 1920, height: 1080 }, joinServer: 'mc.example.net:25570' };
  const args = buildLaunchArgs(ctx, inst, prepared, creds, '/game', '/assets');
  const joined = args.join(' ');
  assert.ok(!/\$\{/.test(joined), `unresolved placeholder in: ${joined}`);
  assert.ok(args.includes('-Xmx6144M') && args.includes('-XX:+UseZGC'));
  assert.ok(!args.includes('--demo'));
  assert.ok(joined.includes('--width 1920 --height 1080'));
  assert.ok(joined.includes('--quickPlayMultiplayer mc.example.net:25570'));
  assert.ok(args.includes('-Dlog4j.configurationFile=/log.xml'));
  const cpIdx = args.indexOf('-cp');
  assert.ok(args[cpIdx + 1].endsWith('c.jar'));
  assert.ok(args.indexOf('Knot') > cpIdx && args.indexOf('Knot') < args.indexOf('--username'));
  assert.equal(args[args.indexOf('--username') + 1], 'Daniel');

  const legacy = { id: '1.7.10', mainClass: 'net.minecraft.client.main.Main', minecraftArguments: '--username ${auth_player_name} --session ${auth_session} --version ${version_name} --gameDir ${game_directory} --assetsDir ${game_assets} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userProperties ${user_properties} --userType ${user_type}', assets: '1.7.10' };
  const a2 = buildLaunchArgs(ctx, { joinServer: 'old.example.net' }, { version: legacy, files: { libraries: [], clientJar: '/c.jar', nativesDir: '/n' } }, creds, '/game', '/virtual');
  assert.ok(!/\$\{/.test(a2.join(' ')));
  assert.ok(a2.includes('-Djava.library.path=/n'));
  assert.equal(a2[a2.indexOf('--assetsDir') + 1], '/virtual');
  assert.ok(a2.join(' ').includes('--server old.example.net --port 25565'));
});

test('NeoForge version -> Minecraft version (old and 2026 schemes)', () => {
  assert.equal(neoForgeToMc('21.1.77'), '1.21.1');
  assert.equal(neoForgeToMc('21.0.10-beta'), '1.21');
  assert.equal(neoForgeToMc('20.4.237'), '1.20.4');
  assert.equal(neoForgeToMc('21.11.48'), '1.21.11');
  assert.equal(neoForgeToMc('26.1.0.10-beta'), '26.1');
  assert.equal(neoForgeToMc('26.1.2.5'), '26.1.2');
  assert.deepEqual(parseLoaderId('neoforge-21.1.77'), { type: 'neoforge', version: '21.1.77' });
  assert.deepEqual(parseLoaderId('forge-47.2.0'), { type: 'forge', version: '47.2.0' });
});

test('CurseForge fingerprint matches reference MurmurHash2', () => {
  // Reference values computed with the PyPI murmurhash2 package (seed 1).
  assert.equal(murmur2(Buffer.from('a')), 626045324);
  assert.equal(murmur2(Buffer.from('ab')), 1692487918);
  assert.equal(murmur2(Buffer.from('abc')), 1621425345);
  assert.equal(murmur2(Buffer.from('abcd')), 3376380438);
  assert.equal(murmur2(Buffer.from('abcde')), 3469237630);
  const data = Buffer.concat([Buffer.from('Hello CurseForge!\n\tThis is a test file with  spaces.\r\n'.repeat(3)), Buffer.from([...Array(256).keys()])]);
  assert.equal(curseFingerprint(data), 1909445612);
});

test('offline UUID matches vanilla server', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f');
});

test('reads mod metadata from Fabric, Forge and NeoForge jars', () => {
  const dir = tmpDir();
  const f1 = path.join(dir, 'sodium.jar');
  fs.writeFileSync(f1, fabricJar('sodium', 'Sodium', '0.6.0', { description: 'line1\nline2' }));
  const f2 = path.join(dir, 'jei.jar');
  fs.writeFileSync(f2, forgeJar('jei', 'Just Enough Items', '15.2.0'));
  const f3 = path.join(dir, 'neo.jar');
  fs.writeFileSync(f3, forgeJar('ftbquests', 'FTB Quests', '2101.1.0', true));
  assert.deepEqual(readModMetadata(f1), { loader: 'fabric', modId: 'sodium', name: 'Sodium', version: '0.6.0', environment: undefined });
  assert.equal(readModMetadata(f2).modId, 'jei');
  assert.equal(readModMetadata(f3).loader, 'neoforge');
  assert.equal(readModMetadata(f3).name, 'FTB Quests');
});

test('search results from both sites are merged, preferred site first', () => {
  const mr = [{ source: 'modrinth', id: 'AANobbMI', title: 'Sodium', slug: 'sodium', downloads: 100 }, { source: 'modrinth', id: 'x', title: 'Only On Modrinth', slug: 'oom', downloads: 5 }];
  const cf = [{ source: 'curseforge', id: 394468, title: 'Sodium', slug: 'sodium', downloads: 50 }, { source: 'curseforge', id: 2, title: 'Cloth Config API (Fabric/Forge/NeoForge)', slug: 'cloth-config', downloads: 7 }];
  const merged = interleaveAndMerge([mr, cf], 'modrinth');
  assert.equal(merged.length, 3);
  const sodium = merged.find((m) => m.title === 'Sodium');
  assert.equal(sodium.source, 'modrinth');
  assert.equal(sodium.alsoOn[0].source, 'curseforge');
  assert.equal(sodium.totalDownloads, 150);
  const merged2 = interleaveAndMerge([mr, cf], 'curseforge');
  assert.equal(merged2.find((m) => m.title === 'Sodium').source, 'curseforge');
});

test('loader compatibility (Quilt runs Fabric mods, NeoForge 1.20.1 runs Forge mods)', () => {
  assert.deepEqual(compatibleLoaders('quilt', '1.21.1'), ['quilt', 'fabric']);
  assert.deepEqual(compatibleLoaders('neoforge', '1.20.1'), ['neoforge', 'forge']);
  assert.deepEqual(compatibleLoaders('neoforge', '1.21.1'), ['neoforge']);
});

test('guess loader & version from folder names like "Fabric 26.1.2"', () => {
  assert.deepEqual(guessFromName('Fabric 26.1.2'), { loader: 'fabric', mc: '26.1.2' });
  assert.deepEqual(guessFromName('NeoForge 1.21.1 Craftoria'), { loader: 'neoforge', mc: '1.21.1' });
});

test('verified download: bad hash is rejected and leaves no file', async () => {
  const good = Buffer.from('hello world');
  const ctx = await makeCtx([['GET', 'https://x.test/f.jar', () => ({ body: good })]]);
  const dest = path.join(ctx.root, 'f.jar');
  await assert.rejects(ctx.http.download('https://x.test/f.jar', dest, { sha1: '0'.repeat(40), retries: 0 }), /SHA-1 mismatch/);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.readdirSync(ctx.root).filter((f) => f.includes('.part-')).length, 0);
  const r = await ctx.http.download('https://x.test/f.jar', dest, { sha1: sha1(good) });
  assert.equal(r.skipped, false);
  const r2 = await ctx.http.download('https://x.test/f.jar', dest, { sha1: sha1(good) });
  assert.equal(r2.skipped, true);
});

test('CurseForge key is sent to the API and CDN only', async () => {
  const ctx = await makeCtx([
    ['GET', /edge\.forgecdn\.net/, () => ({ body: 'x' })],
    ['GET', /example\.com/, () => ({ body: 'y' })],
  ], { cfKey: 'secret-key' });
  await ctx.http.download('https://edge.forgecdn.net/files/1/2/a.jar', path.join(ctx.root, 'a.jar'));
  await ctx.http.download('https://example.com/b.jar', path.join(ctx.root, 'b.jar'));
  assert.equal(ctx.requestLog[0].headers['x-api-key'], 'secret-key');
  assert.equal(ctx.requestLog[1].headers['x-api-key'], undefined);
  const raw = JSON.parse(fs.readFileSync(path.join(ctx.root, 'settings.json'), 'utf8'));
  assert.ok(!JSON.stringify(raw).includes('secret-key'), 'key must not be stored in plain text');
});

test('settings never expose secrets to the UI', async () => {
  const ctx = await makeCtx([], { cfKey: 'k' });
  const pub = ctx.settings.publicView();
  assert.equal(pub.has_cfApiKey, true);
  assert.ok(!JSON.stringify(pub).includes('"k"'));
});

module.exports = { AdmZip };
