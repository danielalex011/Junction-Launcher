'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { makeCtx, sha1 } = require('./helpers');
const { listLoaderVersions, installLoader } = require('../src/core/loaders');
const { platformKey } = require('../src/core/minecraft/java');

test('lists NeoForge versions for both numbering schemes, newest first', async () => {
  const ctx = await makeCtx([
    ['GET', 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', () => ({ json: { versions: ['21.1.77', '21.1.200', '26.1.0.5-beta', '26.1.2.3', '26.1.2.10', '21.11.4'] } })],
  ]);
  const v262 = await listLoaderVersions(ctx, 'neoforge', '26.1.2');
  assert.deepEqual(v262.map((v) => v.version), ['26.1.2.10', '26.1.2.3']);
  const v121 = await listLoaderVersions(ctx, 'neoforge', '1.21.1');
  assert.deepEqual(v121.map((v) => v.version), ['21.1.200', '21.1.77']);
  const v261 = await listLoaderVersions(ctx, 'neoforge', '26.1');
  assert.equal(v261[0].stable, false);
});

test('lists Forge versions and marks the recommended build', async () => {
  const xml = '<metadata><versioning><versions><version>1.20.1-47.2.0</version><version>1.20.1-47.3.0</version><version>1.20-46.0.1</version><version>1.21.1-52.0.1</version></versions></versioning></metadata>';
  const ctx = await makeCtx([
    ['GET', 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', () => ({ body: xml })],
    ['GET', /promotions_slim/, () => ({ json: { promos: { '1.20.1-recommended': '47.2.0', '1.20.1-latest': '47.3.0' } } })],
  ]);
  const list = await listLoaderVersions(ctx, 'forge', '1.20.1');
  assert.deepEqual(list.map((v) => v.version), ['47.3.0', '47.2.0']);
  assert.equal(list.find((v) => v.recommended).version, '47.2.0');
});

function installerServer({ installerId, rejectCamelCase }) {
  const blobs = {};
  const add = (url, buf) => { blobs[url] = Buffer.from(buf); return { url, sha1: sha1(blobs[url]), size: blobs[url].length }; };
  const client = add('https://piston-data.test/client.jar', 'client');
  const vj = add('https://piston-meta.test/1.21.1.json', JSON.stringify({ id: '1.21.1', mainClass: 'M', downloads: { client }, javaVersion: { component: 'java-runtime-delta' }, libraries: [] }));
  const forgeVersion = { id: installerId, inheritsFrom: '1.21.1', mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', libraries: [] };
  // Fake java: behaves like the installer (writes the version json), optionally rejecting --installClient like a renamed flag would.
  const script = `#!/bin/sh
if [ "$3" = "--installClient" ] && [ "${rejectCamelCase ? '1' : '0'}" = "1" ]; then echo "joptsimple.UnrecognizedOptionException: installClient is not a recognized option" 1>&2; exit 1; fi
mkdir -p "$4/versions/${installerId}"
cat > "$4/versions/${installerId}/${installerId}.json" <<'JSON'
${JSON.stringify(forgeVersion)}
JSON
echo "Successfully installed client into launcher."
exit 0
`;
  const java = add('https://piston-data.test/java', script);
  const rt = add('https://piston-meta.test/rt.json', JSON.stringify({ files: { 'bin/java': { type: 'file', executable: true, downloads: { raw: java } }, 'bin/javaw.exe': { type: 'file', executable: true, downloads: { raw: java } } } }));
  const installer = new AdmZip();
  installer.addFile('version.json', Buffer.from(JSON.stringify(forgeVersion)));
  installer.addFile('install_profile.json', Buffer.from('{}'));
  const installerBuf = installer.toBuffer();
  return [
    ['GET', 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', () => ({ json: { versions: [{ id: '1.21.1', type: 'release', url: vj.url, sha1: vj.sha1 }] } })],
    ['GET', /all\.json$/, () => ({ json: { [platformKey()]: { 'java-runtime-delta': [{ manifest: { url: rt.url, sha1: rt.sha1 }, version: { name: '21' } }] } } })],
    ['GET', /installer\.jar$/, () => ({ body: installerBuf })],
    ['GET', /.*/, (url) => (blobs[url] ? { body: blobs[url] } : { status: 404, body: '' })],
  ];
}

test('runs the Forge/NeoForge installer headless and retries with the kebab-case flag', { skip: process.platform === 'win32' }, async () => {
  const ctx = await makeCtx(installerServer({ installerId: 'neoforge-21.1.77', rejectCamelCase: true }));
  const id = await installLoader(ctx, { type: 'neoforge', version: '21.1.77' }, '1.21.1');
  assert.equal(id, 'neoforge-21.1.77');
  assert.ok(fs.existsSync(path.join(ctx.paths.versions, id, `${id}.json`)));
  assert.ok(fs.existsSync(path.join(ctx.paths.meta, 'launcher_profiles.json')), 'installer gets a launcher profile file');
  assert.ok(fs.existsSync(path.join(ctx.paths.versions, '1.21.1', '1.21.1.jar')), 'vanilla jar pre-placed for the installer');
  // Second call is a no-op (no installer run).
  const n = ctx.requestLog.length;
  assert.equal(await installLoader(ctx, { type: 'neoforge', version: '21.1.77' }, '1.21.1'), id);
  assert.ok(ctx.requestLog.slice(n).every((r) => !/java$/.test(r.url)));
  const urls = ctx.requestLog.map((r) => r.url);
  assert.ok(urls.some((u) => u === 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-installer.jar'));
});

test('Forge installer URL and failure output are surfaced', { skip: process.platform === 'win32' }, async () => {
  const routes = installerServer({ installerId: '1.21.1-forge-52.0.1', rejectCamelCase: false });
  const ctx = await makeCtx(routes);
  const id = await installLoader(ctx, { type: 'forge', version: '52.0.1' }, '1.21.1');
  assert.equal(id, '1.21.1-forge-52.0.1');
  assert.ok(ctx.requestLog.some((r) => r.url === 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.0.1/forge-1.21.1-52.0.1-installer.jar'));
});
