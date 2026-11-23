'use strict';
// Protection against malicious mods: unknown-file warning, hash verification, removed-from-platform flags.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { makeCtx, tmpDir, sha1, sha512, fabricJar } = require('./helpers');
const { Instances } = require('../src/core/instances');
const { createSources } = require('../src/core/sources');
const { ContentManager } = require('../src/core/content/manager');
const { Modpacks } = require('../src/core/content/modpacks');
const { describeUnknown, hasFindings } = require('../src/core/content/vetting');
const { curseFingerprint } = require('../src/core/sources/fingerprint');
const { HashMismatchError, describeError } = require('../src/core/http');

const API = 'https://api.modrinth.com/v2';

/** A fake Modrinth that knows exactly the jars in `known` (by sha512). */
function knownTo(known, seen = []) {
  const hashes = new Set(known.map(sha512));
  return [
    ['POST', `${API}/version_files`, (_u, b) => {
      seen.push(b.algorithm);
      return { json: Object.fromEntries(b.hashes.filter((h) => hashes.has(h)).map((h) => [h, { id: 'v1', project_id: 'P1', version_number: '1', files: [], game_versions: [], loaders: [] }])) };
    }],
  ];
}

function tmpJars(...bufs) {
  const dir = tmpDir('junction-jars-');
  return bufs.map((b, i) => { const p = path.join(dir, `file${i}.jar`); fs.writeFileSync(p, b); return p; });
}

test('known file: a jar Modrinth hosts is not flagged (and is looked up by SHA-512)', async () => {
  const jar = fabricJar('sodium', 'Sodium', '1.0.0');
  const seen = [];
  const ctx = await makeCtx(knownTo([jar], seen));
  const content = new ContentManager(ctx, new Instances(ctx), createSources(ctx));
  const r = await content.scanLocalFiles(tmpJars(jar));
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.unchecked, []);
  assert.equal(hasFindings(r), false);
  assert.deepEqual(seen, ['sha512']);
});

test('unknown file: listed by name with careful wording, and never called safe', async () => {
  const known = fabricJar('sodium', 'Sodium', '1.0.0');
  const odd = fabricJar('sketchy', 'Sketchy', '9.9.9');
  const ctx = await makeCtx(knownTo([known]));
  const content = new ContentManager(ctx, new Instances(ctx), createSources(ctx));
  const dir = tmpDir('junction-jars-');
  fs.writeFileSync(path.join(dir, 'sodium.jar'), known);
  fs.writeFileSync(path.join(dir, 'sketchy.jar'), odd);
  const r = await content.scanLocalFiles([path.join(dir, 'sodium.jar'), path.join(dir, 'sketchy.jar')]);
  assert.deepEqual(r.unknown, ['sketchy.jar']);
  assert.equal(r.cfSkipped, true, 'no CurseForge key: only Modrinth was asked');
  const d = describeUnknown(r);
  assert.deepEqual(d.buttons, ["Don't install", 'Install anyway'], "Don't install comes first (the default)");
  assert.match(d.detail, /Not found on Modrinth:/);
  assert.match(d.detail, /sketchy\.jar/);
  assert.doesNotMatch(d.detail, /sodium/);
  assert.match(d.detail, /CurseForge wasn't checked/);
  assert.doesNotMatch(`${d.title} ${d.message} ${d.detail}`, /\bsafe\b|verified|trusted by/i);
  assert.doesNotMatch(d.detail, /[A-Za-z]:\\|\/tmp|junction-jars/, 'no folders in the dialog');
});

test('unknown file: with a CurseForge key, a weak fingerprint match is double-checked with SHA-1', async () => {
  const jar = fabricJar('cfmod', 'CF Mod', '1.0.0');
  const ghost = fabricJar('ghost', 'Ghost', '1.0.0');
  const fp = (b) => curseFingerprint(b);
  const cfFile = (buf, sha) => ({ id: 5, modId: 7, displayName: 'x', fileName: 'x.jar', fileFingerprint: fp(buf), hashes: [{ algo: 1, value: sha }], gameVersions: [] });
  const ctx = await makeCtx([
    ...knownTo([]),
    ['POST', /api\.curseforge\.com\/v1\/fingerprints/, (_u, b) => ({ json: { data: { exactMatches: [
      ...(b.fingerprints.includes(fp(jar)) ? [{ id: 7, file: cfFile(jar, sha1(jar)) }] : []),
      // same 32-bit fingerprint, but CurseForge lists a different SHA-1: not the same file
      ...(b.fingerprints.includes(fp(ghost)) ? [{ id: 8, file: cfFile(ghost, 'f'.repeat(40)) }] : []),
    ] } } })],
  ], { cfKey: 'test-key' });
  const content = new ContentManager(ctx, new Instances(ctx), createSources(ctx));
  const dir = tmpDir('junction-jars-');
  fs.writeFileSync(path.join(dir, 'cfmod.jar'), jar);
  fs.writeFileSync(path.join(dir, 'ghost.jar'), ghost);
  const r = await content.scanLocalFiles([path.join(dir, 'cfmod.jar'), path.join(dir, 'ghost.jar')]);
  assert.deepEqual(r.unknown, ['ghost.jar']);
  assert.equal(r.cfSkipped, false);
  assert.match(describeUnknown(r).detail, /Not found on Modrinth or CurseForge/);
});

test('unknown file: when the lookup itself fails, files are "could not be checked", not "unknown"', async () => {
  const ctx = await makeCtx([['POST', `${API}/version_files`, () => ({ status: 400, json: { error: 'nope' } })]]);
  const content = new ContentManager(ctx, new Instances(ctx), createSources(ctx));
  ctx.http.retryDelays = [];
  const r = await content.scanLocalFiles(tmpJars(fabricJar('a', 'A', '1')));
  assert.deepEqual(r.unknown, []);
  assert.equal(r.unchecked.length, 1);
  assert.match(describeUnknown(r).detail, /Couldn't be checked/);
});

test('modpack archive: jars in overrides and files hosted outside Modrinth are looked up; Modrinth-hosted ones are not', async () => {
  const bundled = fabricJar('bundled', 'Bundled', '1.0.0');
  const knownJar = fabricJar('sodium', 'Sodium', '1.0.0');
  const external = Buffer.from('external jar bytes');
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    game: 'minecraft', formatVersion: 1, versionId: '1', name: 'Pack', dependencies: { minecraft: '26.3', 'fabric-loader': '0.20.1' },
    files: [
      { path: 'mods/hosted.jar', hashes: { sha1: sha1(knownJar), sha512: sha512(knownJar) }, downloads: ['https://cdn.modrinth.com/data/a/b.jar'], fileSize: 1 },
      { path: 'mods/github.jar', hashes: { sha1: sha1(external), sha512: sha512(external) }, downloads: ['https://github.com/x/y/releases/download/1/github.jar'], fileSize: 1 },
    ],
  })));
  zip.addFile('overrides/mods/bundled.jar', bundled);
  zip.addFile('overrides/mods/sodium.jar', knownJar);
  zip.addFile('overrides/config/readme.txt', Buffer.from('hi'));
  const file = path.join(tmpDir('junction-pack-'), 'pack.mrpack');
  zip.writeZip(file);

  const ctx = await makeCtx(knownTo([knownJar]));
  const instances = new Instances(ctx);
  const sources = createSources(ctx);
  const modpacks = new Modpacks(ctx, instances, new ContentManager(ctx, instances, sources), sources);
  const r = await modpacks.scanArchive(file);
  assert.deepEqual(r.unknown.sort(), ['bundled.jar', 'github.jar (hosted on github.com)']);
  assert.equal(await modpacks.scanArchive(path.join(path.dirname(file), 'missing.zip')), null);
});

test('hash mismatch: the file is deleted, one more try is made, then it fails with a clear message', async () => {
  const good = Buffer.from('the real mod');
  let hits = 0;
  const ctx = await makeCtx([['GET', 'https://cdn.modrinth.com/evil.jar', () => { hits++; return { body: Buffer.from('swapped bytes') }; }]]);
  const dest = path.join(ctx.root, 'mods', 'evil.jar');
  await assert.rejects(ctx.http.download('https://cdn.modrinth.com/evil.jar', dest, { sha1: sha1(good), sha512: sha512(good) }), (e) => {
    assert.ok(e instanceof HashMismatchError);
    assert.match(describeError(e), /evil\.jar didn't match the checksum.*deleted it/);
    assert.doesNotMatch(describeError(e), /https?:|cdn\.modrinth/, 'no addresses in the message');
    return true;
  });
  assert.equal(hits, 2, 'exactly one retry');
  assert.equal(fs.existsSync(dest), false, 'nothing was left in place');
  assert.deepEqual(fs.readdirSync(path.dirname(dest)).filter((f) => f.includes('.part')), [], 'no partial files either');
});

test('hash mismatch: a good second answer succeeds, and a mismatch is not retried again by pack installs', async () => {
  const good = Buffer.from('the real mod');
  let hits = 0;
  const ctx = await makeCtx([['GET', 'https://cdn.modrinth.com/flaky.jar', () => { hits++; return { body: hits === 1 ? Buffer.from('garbled') : good }; }]]);
  const dest = path.join(ctx.root, 'flaky.jar');
  await ctx.http.download('https://cdn.modrinth.com/flaky.jar', dest, { sha1: sha1(good) });
  assert.equal(hits, 2);
  assert.deepEqual(fs.readFileSync(dest), good);
  const { isRetryable } = require('../src/core/http');
  assert.equal(isRetryable(new HashMismatchError('a.jar', 'SHA-1')), false);
});

// ---- removed from the platform -------------------------------------------------------------

function modrinthWith(state) {
  const jar = fabricJar('sodium', 'Sodium', '0.6.0');
  const url = 'https://cdn.modrinth.com/data/SOD/versions/v1/sodium-0.6.0.jar';
  const version = { id: 'v1', project_id: 'SOD', name: '0.6.0', version_number: '0.6.0', game_versions: ['26.3'], loaders: ['fabric'], version_type: 'release', date_published: '2026-01-01T00:00:00Z',
    files: [{ url, filename: 'sodium-0.6.0.jar', hashes: { sha1: sha1(jar), sha512: sha512(jar) }, size: jar.length, primary: true }], dependencies: [] };
  const project = { id: 'SOD', slug: 'sodium', title: 'Sodium', project_type: 'mod' };
  return [
    ['GET', new RegExp(`^${API}/project/SOD/version`), () => ({ json: [version] })],
    ['GET', `${API}/project/SOD`, () => ({ json: project })],
    ['GET', new RegExp(`^${API}/versions\\?ids=`), () => (state.down ? { status: 400, body: 'oops' } : { json: state.versionGone ? [] : [version] })],
    ['GET', new RegExp(`^${API}/projects\\?`), () => ({ json: state.projectGone ? [] : [project] })],
    ['GET', new RegExp(`^${API}/version/v1$`), () => ({ json: version })],
    ['POST', `${API}/version_files/update`, () => ({ json: {} })],
    ['POST', `${API}/version_files`, () => ({ json: {} })],
    ['GET', /cdn\.modrinth\.com/, () => ({ body: jar })],
  ];
}

test('removed version: the update check flags it, keeps the flag on errors, and clears it when it is back', async () => {
  const state = {};
  const ctx = await makeCtx(modrinthWith(state));
  ctx.http.retryDelays = [];
  const instances = new Instances(ctx);
  const content = new ContentManager(ctx, instances, createSources(ctx));
  const inst = await instances.create({ name: 'Fabric', mcVersion: '26.3', loader: { type: 'fabric', version: '0.20.1' } });
  await content.installProject(inst.id, { source: 'modrinth', id: 'SOD' }, 'mod', { versionId: 'v1' });

  await content.checkUpdates(inst.id);
  assert.equal((await instances.listContent(inst.id, 'mod'))[0].removed, null, 'still on Modrinth: no flag');
  assert.deepEqual(await content.removedFiles(inst.id), []);

  state.versionGone = true; // the version is gone but the project is still there
  await content.checkUpdates(inst.id);
  let mod = (await instances.listContent(inst.id, 'mod'))[0];
  assert.deepEqual(mod.removed, { platform: 'Modrinth', what: 'version' });
  const list = await content.removedFiles(inst.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].platform, 'Modrinth');
  assert.equal(list[0].enabled, true);

  state.down = true; // Modrinth having a bad day must not clear (or invent) anything
  await content.checkUpdates(inst.id);
  assert.deepEqual((await instances.listContent(inst.id, 'mod'))[0].removed, { platform: 'Modrinth', what: 'version' });

  state.down = false;
  state.projectGone = true; // now the whole project is gone
  await content.checkUpdates(inst.id);
  mod = (await instances.listContent(inst.id, 'mod'))[0];
  assert.deepEqual(mod.removed, { platform: 'Modrinth', what: 'project' });

  // "Turn off" is the banner's main action: the file stays installed but is switched off.
  await content.setEnabledMany(inst.id, [mod.file], false);
  assert.equal((await content.removedFiles(inst.id))[0].enabled, false);

  state.versionGone = false;
  state.projectGone = false;
  await content.checkUpdates(inst.id);
  assert.equal((await instances.listContent(inst.id, 'mod'))[0].removed, null, 'back on the platform: flag cleared');
});
