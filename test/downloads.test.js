'use strict';
// Flaky CDNs: retries with backoff, grouped failures, retrying them later, repairing a pack,
// and files the pack ships itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const { makeCtx, sha1, sha512, fabricJar } = require('./helpers');
const { Instances } = require('../src/core/instances');
const { createSources } = require('../src/core/sources');
const { ContentManager } = require('../src/core/content/manager');
const { Modpacks } = require('../src/core/content/modpacks');
const { HttpError, describeError, parseRetryAfter } = require('../src/core/http');

// What cdn.modrinth.com sends instead of a file when it is overloaded.
const HTML_503 = '<html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>first byte timeout</center></body></html>';

/** Skips the waiting between retries, but remembers how long it would have waited. */
function noSleep(ctx) {
  const waits = [];
  ctx.http.sleep = async (ms) => { waits.push(ms); };
  return waits;
}

function services(ctx) {
  const instances = new Instances(ctx);
  const sources = createSources(ctx);
  const content = new ContentManager(ctx, instances, sources);
  const modpacks = new Modpacks(ctx, instances, content, sources);
  return { instances, sources, content, modpacks };
}

// ------------------------------------------------------------------ http.download

test('download retries 5xx with growing, jittered waits, then succeeds', async () => {
  const body = Buffer.from('jar bytes');
  const url = 'https://cdn.modrinth.com/data/a/b.jar';
  let hits = 0;
  const ctx = await makeCtx([['GET', url, () => { hits++; return hits <= 2 ? { status: 503, body: HTML_503 } : { body }; }]]);
  const waits = noSleep(ctx);
  const dest = path.join(ctx.root, 'x', 'a.jar');
  const r = await ctx.http.download(url, dest, { sha1: sha1(body) });
  assert.equal(r.skipped, false);
  assert.equal(hits, 3, 'failed twice, then succeeded');
  assert.deepEqual(fs.readFileSync(dest), body);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 1500 && waits[0] <= 2500, `first wait ~2s, got ${waits[0]}`);
  assert.ok(waits[1] >= 3750 && waits[1] <= 6250, `second wait ~5s, got ${waits[1]}`);
});

test('download honours Retry-After, retries a damaged download, and never retries a 404', async () => {
  const body = Buffer.from('payload');
  let hits = 0;
  const ctx = await makeCtx([
    ['GET', 'https://cdn.modrinth.com/limited.jar', () => { hits++; return hits === 1 ? { status: 429, body: 'slow down', headers: { 'retry-after': '7' } } : { body }; }],
    ['GET', 'https://cdn.modrinth.com/damaged.jar', () => { hits++; return { body: hits === 3 ? body : Buffer.from('corrupt') }; }],
    ['GET', 'https://cdn.modrinth.com/gone.jar', () => { hits++; return { status: 404, body: '<html><body>not found</body></html>' }; }],
  ]);
  const waits = noSleep(ctx);
  await ctx.http.download('https://cdn.modrinth.com/limited.jar', path.join(ctx.root, 'limited.jar'), { sha1: sha1(body) });
  assert.equal(hits, 2);
  assert.ok(waits[0] >= 7000 && waits[0] <= 7600, `waited what Retry-After said, got ${waits[0]}`);

  hits = 1; // the first "corrupt" answer is request 2
  await ctx.http.download('https://cdn.modrinth.com/damaged.jar', path.join(ctx.root, 'damaged.jar'), { sha1: sha1(body) });
  assert.equal(hits, 3, 'a checksum mismatch is retried');

  hits = 0;
  waits.length = 0;
  await assert.rejects(ctx.http.download('https://cdn.modrinth.com/gone.jar', path.join(ctx.root, 'gone.jar')), (e) => e instanceof HttpError && e.status === 404);
  assert.equal(hits, 1, 'other 4xx errors are not retried');
  assert.equal(waits.length, 0);
  assert.equal(parseRetryAfter('3'), 3000);
  assert.ok(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) > 3000);
  assert.equal(parseRetryAfter('nonsense'), 0);
});

test('a file that always fails is tried five times, and the error never contains the HTML page', async () => {
  const url = 'https://cdn.modrinth.com/data/a/never.jar';
  let hits = 0;
  const ctx = await makeCtx([['GET', url, () => { hits++; return { status: 503, body: HTML_503 }; }]]);
  const waits = noSleep(ctx);
  const err = await ctx.http.download(url, path.join(ctx.root, 'never.jar')).catch((e) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(hits, 5, 'one try plus four retries');
  assert.equal(waits.length, 4);
  assert.ok(waits[3] > waits[0], 'the waits grow');
  assert.ok(!/[<>]/.test(err.message), `no HTML in the message: ${err.message}`);
  assert.equal(describeError(err), "Modrinth's download server timed out (HTTP 503)");
  assert.ok(!fs.existsSync(path.join(ctx.root, 'never.jar')) && fs.readdirSync(ctx.root).every((f) => !f.includes('.part-')), 'no half-written file is left behind');
});

test('CDN hosts get at most six downloads at a time; other hosts are not held back', async () => {
  let active = 0;
  let peak = 0;
  const slow = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; return { body: 'x' }; };
  const ctx = await makeCtx([['GET', /cdn\.modrinth\.com/, slow], ['GET', /libraries\.minecraft\.net/, slow]]);
  await Promise.all(Array.from({ length: 24 }, (_, i) => ctx.http.download(`https://cdn.modrinth.com/data/p/${i}.jar`, path.join(ctx.root, `m${i}.jar`))));
  assert.ok(peak > 1 && peak <= 6, `Modrinth CDN peak was ${peak}`);
  peak = 0;
  await Promise.all(Array.from({ length: 24 }, (_, i) => ctx.http.download(`https://libraries.minecraft.net/l${i}.jar`, path.join(ctx.root, `l${i}.jar`))));
  assert.ok(peak > 6, `Mojang's libraries aren't throttled, peak was ${peak}`);
});

test('error messages are plain sentences', () => {
  const html = new HttpError(503, 'https://cdn.modrinth.com/a.jar', HTML_503);
  assert.equal(describeError(html), "Modrinth's download server timed out (HTTP 503)");
  assert.equal(describeError(new HttpError(503, 'https://api.modrinth.com/v2/x', '')), 'Modrinth is unavailable right now (HTTP 503)');
  assert.equal(describeError(new HttpError(429, 'https://edge.forgecdn.net/f.jar', '')), "CurseForge's download server is busy right now and asked us to slow down (HTTP 429)");
  assert.equal(describeError(new HttpError(404, 'https://cdn.modrinth.com/a.jar', '<html>nope</html>')), "Modrinth's download server couldn't find the file (HTTP 404)");
  assert.equal(describeError(new Error('Download stalled: https://cdn.modrinth.com/a.jar')), 'The connection timed out');
  assert.equal(describeError(new Error('SHA-1 mismatch for a.jar (expected x, got y)')), 'The downloaded file was damaged (checksum mismatch)');
  assert.equal(describeError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), "Couldn't connect. Check your internet connection");
  for (const e of [html, new HttpError(500, 'https://x.test/a', '<h1>boom</h1>')]) assert.ok(!/[<>]|https?:/.test(describeError(e)));
});

// ------------------------------------------------------------------ modpack fixtures

/** A Modrinth pack of five mods whose downloads behave differently (see `behave`). */
function flakyPack() {
  const jars = { a: fabricJar('moda', 'Mod A', '1.0'), b: fabricJar('modb', 'Mod B', '1.0'), c: fabricJar('modc', 'Mod C', '1.0'), d: fabricJar('modd', 'Mod D', '1.0'), e: fabricJar('mode', 'Mod E', '1.0') };
  const shipped = fabricJar('shipped', 'Shipped With Pack', '1.0');
  const url = (k) => `https://cdn.modrinth.com/data/PACK/files/${k}.jar`;
  const index = {
    formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'Flaky Pack',
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' },
    files: Object.entries(jars).map(([k, buf]) => ({ path: `mods/${k}.jar`, hashes: { sha1: sha1(buf), sha512: sha512(buf) }, downloads: [url(k)], fileSize: buf.length, env: { client: 'required', server: 'required' } })),
  };
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index)));
  zip.addFile('overrides/mods/shipped.jar', shipped);
  zip.addFile('overrides/resourcepacks/faithful.zip', Buffer.from('PK pretend zip'));
  zip.addFile('overrides/config/pack.toml', Buffer.from('a = 1'));
  const packBuf = zip.toBuffer();
  const hits = {};
  // behave[k](n) -> HTTP status for the nth request of that file (200 = the file)
  const behave = { a: (n) => (n <= 2 ? 503 : 200), b: () => 200, c: () => 200, d: () => 200, e: () => 200 };
  const packUrl = 'https://cdn.modrinth.com/data/PACK/versions/pv1/pack.mrpack';
  const API = 'https://api.modrinth.com/v2';
  const routes = [
    ['GET', new RegExp(`^${API}/project/PACK$`), () => ({ json: { id: 'PACK', slug: 'flaky-pack', title: 'Flaky Pack', project_type: 'modpack', icon_url: null } })],
    ['GET', new RegExp(`^${API}/version/pv1$`), () => ({ json: {
      id: 'pv1', project_id: 'PACK', name: '1.0', version_number: '1.0', game_versions: ['1.21.1'], loaders: ['fabric'], version_type: 'release', date_published: '2026-01-01T00:00:00Z', dependencies: [],
      files: [{ url: packUrl, filename: 'pack.mrpack', hashes: { sha1: sha1(packBuf), sha512: sha512(packBuf) }, size: packBuf.length, primary: true }],
    } })],
    ['POST', `${API}/version_files`, () => ({ json: {} })],
    ['GET', packUrl, () => { hits.pack = (hits.pack || 0) + 1; return { body: packBuf }; }],
    ['GET', /^https:\/\/cdn\.modrinth\.com\/data\/PACK\/files\/(\w)\.jar$/, (u) => {
      const k = u.match(/files\/(\w)\.jar/)[1];
      hits[k] = (hits[k] || 0) + 1;
      const status = behave[k](hits[k]);
      if (status === 503) return { status, body: HTML_503 };
      if (status === 404) return { status, body: '<html><body><h1>404 Not Found</h1></body></html>' };
      return { body: jars[k] };
    }],
  ];
  return { routes, jars, shipped, hits, behave, index };
}

const install = (modpacks) => modpacks.installFromSource({ source: 'modrinth', projectId: 'PACK', versionId: 'pv1' });
const readFailed = async (instances, id) => (await instances.readIndex(id)).failed || {};

test('pack install: failures are retried, a second pass catches the rest, and what still fails is recorded', async () => {
  const api = flakyPack();
  api.behave.b = () => 503; // never works (yet)
  api.behave.d = () => 404; // gone for good
  api.behave.e = (n) => (n <= 5 ? 503 : 200); // outlasts the retries of the first pass, fine in the second
  const ctx = await makeCtx(api.routes);
  noSleep(ctx);
  const { instances, modpacks } = services(ctx);
  const r = await install(modpacks);
  const gd = instances.gameDir(r.instance.id);

  assert.equal(api.hits.a, 3, 'a: failed twice, then succeeded');
  assert.equal(api.hits.c, 1);
  assert.equal(api.hits.e, 6, 'e: five failures in the first pass, success in the automatic second pass');
  assert.equal(api.hits.b, 10, 'b: five tries in each pass');
  assert.equal(api.hits.d, 1, 'd: a 404 is not retried, not even in the second pass');
  for (const k of ['a', 'c', 'e']) assert.deepEqual(fs.readFileSync(path.join(gd, `mods/${k}.jar`)), api.jars[k]);
  for (const k of ['b', 'd']) assert.ok(!fs.existsSync(path.join(gd, `mods/${k}.jar`)));

  // One grouped result, in plain words.
  assert.deepEqual(r.failed.map((f) => f.name).sort(), ['b.jar', 'd.jar']);
  assert.equal(r.failed.find((f) => f.name === 'b.jar').error, "Modrinth's download server timed out (HTTP 503)");
  assert.equal(r.failed.find((f) => f.name === 'd.jar').error, "Modrinth's download server couldn't find the file (HTTP 404)");
  assert.ok(!/[<>]/.test(JSON.stringify({ failed: r.failed, warnings: r.warnings })), 'no HTML reaches the user');
  assert.deepEqual(r.warnings, []);

  // content.json keeps what's needed to try again: path, URLs, hashes.
  const failed = await readFailed(instances, r.instance.id);
  assert.deepEqual(Object.keys(failed).sort(), ['mods/b.jar', 'mods/d.jar']);
  assert.equal(failed['mods/b.jar'].path, 'mods/b.jar');
  assert.deepEqual(failed['mods/b.jar'].urls, ['https://cdn.modrinth.com/data/PACK/files/b.jar']);
  assert.deepEqual(failed['mods/b.jar'].hashes, { sha1: sha1(api.jars.b), sha512: sha512(api.jars.b) });
  assert.equal(failed['mods/b.jar'].size, api.jars.b.length);
});

test('retry failed downloads fetches what is still missing and keeps the rest recorded', async () => {
  const api = flakyPack();
  api.behave.b = () => 503;
  api.behave.d = () => 404;
  const ctx = await makeCtx(api.routes);
  noSleep(ctx);
  const { instances, modpacks } = services(ctx);
  const r = await install(modpacks);
  const id = r.instance.id;
  assert.equal(r.failed.length, 2);

  api.behave.b = () => 200; // the CDN has recovered
  const retry = await modpacks.retryFailed(id);
  assert.deepEqual(retry.fixed, ['mods/b.jar']);
  assert.deepEqual(retry.failed.map((f) => f.name), ['d.jar'], 'the 404 is still there to try again later');
  assert.deepEqual(fs.readFileSync(path.join(instances.gameDir(id), 'mods/b.jar')), api.jars.b);
  assert.deepEqual(Object.keys(await readFailed(instances, id)), ['mods/d.jar']);
  const b = (await instances.listContent(id, 'mod')).find((m) => m.fileName === 'b.jar');
  assert.equal(b.fromPack, true);

  api.behave.d = () => 200;
  const last = await modpacks.retryFailed(id);
  assert.deepEqual(last.failed, []);
  assert.deepEqual(await readFailed(instances, id), {}, 'nothing left to retry');
  assert.deepEqual(await modpacks.failedDownloads(id), []);
  assert.deepEqual((await modpacks.retryFailed(id)).retried, 0);
});

test('files shipped in overrides/ are recorded as coming from the pack and skipped by lookups', async () => {
  const api = flakyPack();
  const ctx = await makeCtx(api.routes);
  noSleep(ctx);
  const { instances, content, modpacks } = services(ctx);
  const r = await install(modpacks);
  const id = r.instance.id;
  const mods = await instances.listContent(id, 'mod');
  const shipped = mods.find((m) => m.fileName === 'shipped.jar');
  assert.equal(shipped.source, 'pack');
  assert.equal(shipped.fromPack, true);
  assert.equal(shipped.title, 'Shipped With Pack');
  assert.equal((await instances.listContent(id, 'resourcepack')).find((p) => p.fileName === 'faithful.zip').source, 'pack');
  assert.ok(fs.existsSync(path.join(instances.gameDir(id), 'config/pack.toml')), 'configs are still extracted as before');
  // The five index files weren't known to Modrinth, so they stay "local"; the shipped one is not among them.
  assert.deepEqual(mods.filter((m) => m.source === 'local').map((m) => m.fileName).sort(), ['a.jar', 'b.jar', 'c.jar', 'd.jar', 'e.jar']);

  const before = ctx.requestLog.length;
  const res = await content.identify(id);
  assert.equal(res.total, 5, 'the pack-shipped mod is not looked up');
  const lookup = ctx.requestLog.slice(before).find((x) => x.url.endsWith('/version_files'));
  assert.ok(!lookup.body.hashes.includes(sha1(api.shipped)));
});

test('repair: re-downloads missing or damaged pack files and leaves configs and your own mods alone', async () => {
  const api = flakyPack();
  const ctx = await makeCtx(api.routes);
  noSleep(ctx);
  const { instances, modpacks } = services(ctx);
  const r = await install(modpacks);
  const id = r.instance.id;
  const gd = instances.gameDir(id);
  const mods = path.join(gd, 'mods');
  assert.deepEqual(r.failed, []);

  // Break things: a missing mod, a damaged one, a damaged one that was switched off, a missing pack-shipped mod.
  fs.rmSync(path.join(mods, 'a.jar'));
  fs.writeFileSync(path.join(mods, 'c.jar'), 'truncated');
  fs.renameSync(path.join(mods, 'e.jar'), path.join(mods, 'e.jar.disabled'));
  fs.writeFileSync(path.join(mods, 'e.jar.disabled'), 'also damaged');
  fs.rmSync(path.join(mods, 'shipped.jar'));
  // Things that are yours.
  const mine = fabricJar('mine', 'My Own Mod', '3.0');
  fs.writeFileSync(path.join(mods, 'mine.jar'), mine);
  fs.writeFileSync(path.join(gd, 'config/pack.toml'), 'a = 2 # edited by me');
  const packRequests = api.hits.pack;

  const rep = await modpacks.repair(id);
  assert.equal(api.hits.pack, packRequests + 1, 'the pack index was downloaded again');
  assert.equal(rep.checked, 5);
  assert.deepEqual(rep.repaired.sort(), ['mods/a.jar', 'mods/c.jar', 'mods/e.jar']);
  assert.equal(rep.ok, 2);
  assert.deepEqual(rep.restored, ['mods/shipped.jar']);
  assert.deepEqual(rep.failed, []);
  assert.deepEqual(fs.readFileSync(path.join(mods, 'a.jar')), api.jars.a);
  assert.deepEqual(fs.readFileSync(path.join(mods, 'c.jar')), api.jars.c);
  assert.ok(!fs.existsSync(path.join(mods, 'e.jar')), 'a mod you switched off stays off');
  assert.deepEqual(fs.readFileSync(path.join(mods, 'e.jar.disabled')), api.jars.e);
  assert.deepEqual(fs.readFileSync(path.join(mods, 'shipped.jar')), api.shipped);
  assert.deepEqual(fs.readFileSync(path.join(mods, 'mine.jar')), mine, 'your own mod is untouched');
  assert.equal(fs.readFileSync(path.join(gd, 'config/pack.toml'), 'utf8'), 'a = 2 # edited by me', 'configs are untouched');
  const list = await instances.listContent(id, 'mod');
  assert.equal(list.find((m) => m.fileName === 'shipped.jar').source, 'pack');
  assert.equal(list.find((m) => m.fileName === 'mine.jar').source, 'local');
  assert.equal(list.find((m) => m.fileName === 'e.jar').enabled, false);

  // Nothing left to fix the second time, and no pack file was fetched again.
  const hitsBefore = { ...api.hits };
  const again = await modpacks.repair(id);
  assert.deepEqual([again.repaired, again.restored, again.ok], [[], [], 5]);
  for (const k of ['a', 'b', 'c', 'd', 'e']) assert.equal(api.hits[k], hitsBefore[k]);
});

test('repair also retries, records what still fails, and refuses instances that did not come from a pack', async () => {
  const api = flakyPack();
  const ctx = await makeCtx(api.routes);
  noSleep(ctx);
  const { instances, modpacks } = services(ctx);
  const r = await install(modpacks);
  const id = r.instance.id;
  fs.rmSync(path.join(instances.gameDir(id), 'mods/b.jar'));
  fs.rmSync(path.join(instances.gameDir(id), 'mods/c.jar'));
  api.behave.b = () => 503; // stays down
  api.behave.c = (n) => (n <= 3 ? 503 : 200); // recovers within the retries
  const rep = await modpacks.repair(id);
  assert.deepEqual(rep.repaired, ['mods/c.jar']);
  assert.deepEqual(rep.failed.map((f) => f.name), ['b.jar']);
  assert.deepEqual(Object.keys(await readFailed(instances, id)), ['mods/b.jar']);

  const plain = await instances.create({ name: 'Plain', mcVersion: '1.21.1', loader: { type: 'fabric', version: '0.16.10' } });
  await assert.rejects(modpacks.repair(plain.id), /nothing to repair/);
  const fromFile = await instances.create({ name: 'From file', mcVersion: '1.21.1', loader: { type: 'fabric', version: '0.16.10' }, pack: { source: 'file', name: 'x' } });
  await assert.rejects(modpacks.repair(fromFile.id), /nothing to repair/);
});

test('CurseForge packs: flaky downloads are retried, blocked files go to the manual flow, repair restores what is missing', async () => {
  const jarA = fabricJar('cfa', 'CF A', '1.0');
  const jarB = fabricJar('cfb', 'CF B', '1.0');
  const jarC = fabricJar('cfc', 'CF C', '1.0');
  const url = (k) => `https://edge.forgecdn.net/files/${k}.jar`;
  const manifest = { minecraft: { version: '1.21.1', modLoaders: [{ id: 'fabric-0.16.10', primary: true }] }, manifestType: 'minecraftModpack', manifestVersion: 1, name: 'CF Pack', version: '1.0', overrides: 'overrides',
    files: [{ projectID: 11, fileID: 5001, required: true }, { projectID: 12, fileID: 5002, required: true }, { projectID: 13, fileID: 5003, required: true }] };
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('overrides/mods/bundled.jar', fabricJar('bundled', 'Bundled', '1.0'));
  const packBuf = zip.toBuffer();
  const cfFile = (id, modId, name, buf, downloadUrl) => ({ id, modId, displayName: name, fileName: name, downloadUrl, gameVersions: ['1.21.1', 'Fabric'], releaseType: 1, fileDate: '2026-02-01T00:00:00Z', hashes: buf ? [{ value: sha1(buf), algo: 1 }] : [], fileLength: buf ? buf.length : 0, dependencies: [], fileFingerprint: 0 });
  const files = {
    5001: cfFile(5001, 11, 'cfa.jar', jarA, url('a')), 5002: cfFile(5002, 12, 'cfb.jar', jarB, url('b')), 5003: cfFile(5003, 13, 'cfc.jar', jarC, null),
    9001: cfFile(9001, 99, 'cf-pack.zip', packBuf, 'https://edge.forgecdn.net/files/pack.zip'),
  };
  const mod = (id, slug, name) => ({ id, slug, name, classId: 6, links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/${slug}` }, latestFilesIndexes: [] });
  const mods = { 11: mod(11, 'cfa', 'CF A'), 12: mod(12, 'cfb', 'CF B'), 13: { ...mod(13, 'cfc', 'CF C'), allowModDistribution: false }, 99: { ...mod(99, 'cf-pack', 'CF Pack'), classId: 4471 } };
  const hits = {};
  const flaky = { a: (n) => (n <= 6 ? 503 : 200) }; // outlasts the first pass (5 tries), fine in the second
  const ctx = await makeCtx([
    ['POST', 'https://api.curseforge.com/v1/mods/files', (_u, body) => ({ json: { data: body.fileIds.map((i) => files[i]).filter(Boolean) } })],
    ['POST', 'https://api.curseforge.com/v1/mods', (_u, body) => ({ json: { data: body.modIds.map((i) => mods[i]).filter(Boolean) } })],
    ['GET', 'https://edge.forgecdn.net/files/pack.zip', () => { hits.pack = (hits.pack || 0) + 1; return { body: packBuf }; }],
    ['GET', /edge\.forgecdn\.net\/files\/([ab])\.jar$/, (u) => {
      const k = u.match(/files\/([ab])\.jar/)[1];
      hits[k] = (hits[k] || 0) + 1;
      if (flaky[k] && flaky[k](hits[k]) === 503) return { status: 503, body: HTML_503 };
      return { body: k === 'a' ? jarA : jarB };
    }],
  ], { cfKey: 'key' });
  noSleep(ctx);
  const { instances, modpacks } = services(ctx);
  const p = path.join(ctx.root, 'cf.zip');
  fs.writeFileSync(p, packBuf);
  const r = await modpacks.installFile(p, {});
  const id = r.instance.id;
  assert.equal(hits.a, 7, 'five tries, then the automatic second pass');
  assert.deepEqual(r.failed, []);
  assert.equal(r.blocked.length, 1, 'the author-blocked file goes to the manual download flow, not to "failed"');
  const gd = instances.gameDir(id);
  assert.deepEqual(fs.readFileSync(path.join(gd, 'mods/cfa.jar')), jarA);
  assert.equal((await instances.listContent(id, 'mod')).find((m) => m.fileName === 'bundled.jar').source, 'pack');

  // Repair needs to know which pack version this is.
  await instances.update(id, { pack: { source: 'curseforge', projectId: 99, versionId: 9001, name: 'CF Pack', versionName: '1.0' } });
  fs.rmSync(path.join(gd, 'mods/cfb.jar'));
  fs.writeFileSync(path.join(gd, 'mods/cfa.jar'), 'damaged');
  const rep = await modpacks.repair(id);
  assert.deepEqual(rep.repaired.sort(), ['mods/cfa.jar', 'mods/cfb.jar']);
  assert.equal(rep.blocked.length, 1, 'still missing, so still offered for manual download');
  assert.deepEqual(fs.readFileSync(path.join(gd, 'mods/cfb.jar')), jarB);
  assert.deepEqual(rep.failed, []);
});

test('pack install: the task knows the total size before the first file downloads', async () => {
  const api = flakyPack();
  const ctx = await makeCtx(api.routes);
  const { modpacks } = services(ctx);
  let planned = null;
  await ctx.tasks.run('Installing Pack', async (t) => {
    await modpacks.installFromSource({ source: 'modrinth', projectId: 'PACK', versionId: 'pv1', report: t.update });
    planned = ctx.tasks.list().find((x) => x.id === t.id)?.plannedBytes;
  });
  assert.equal(planned, Object.values(api.jars).reduce((n, b) => n + b.length, 0));
});
