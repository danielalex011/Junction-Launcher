'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const zlib = require('zlib');
const { createContext } = require('../src/core/context');
const { Accounts } = require('../src/core/auth/accounts');
const { Skins, inspectSkin, guessModel, cleanName } = require('../src/core/skins');
const { decodePng, crc32, PNG_MAGIC } = require('../src/core/png');
const { makePng, tmpDir } = require('./helpers');
const mock = require('../tools/mock-skins');

const classic = () => mock.mockSkin();
const slim = () => mock.mockSkin({ slim: true });

function chunk(type, data) {
  const t = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(t));
  return Buffer.concat([len, t, sum]);
}
function rawPng({ w = 64, h = 64, interlace = 0, idatBytes }) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = interlace;
  return Buffer.concat([PNG_MAGIC, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(idatBytes || Buffer.alloc((w * 4 + 1) * h))), chunk('IEND', Buffer.alloc(0))]);
}

test('skin file checks: only real 64x64 or 64x32 PNGs', () => {
  assert.equal(inspectSkin(classic()).width, 64);
  const legacy = inspectSkin(makePng(64, 32, () => [10, 20, 30, 255]));
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.model, 'classic');
  assert.throws(() => inspectSkin(makePng(128, 128, () => [0, 0, 0, 255])), /64×64.*128×128/);
  assert.throws(() => inspectSkin(makePng(64, 48, () => [0, 0, 0, 255])), /64×64/);
  assert.throws(() => inspectSkin(Buffer.from('definitely not a png file, but long enough to look like one at a glance....')), /not a PNG/);
  assert.throws(() => inspectSkin(Buffer.alloc(0)), /empty/);
  assert.throws(() => inspectSkin(classic().subarray(0, 120)), /cut off|damaged/);
  const bad = Buffer.from(classic()); bad[bad.length - 20] ^= 0xff; // flip a bit inside the pixel data
  assert.throws(() => inspectSkin(bad), /damaged/);
  assert.throws(() => inspectSkin(rawPng({ interlace: 1 })), /interlaced/);
  assert.throws(() => inspectSkin(rawPng({ idatBytes: Buffer.alloc(5 * 1024 * 1024) })), /damaged/, 'a picture that inflates to more than it claims');
  assert.throws(() => inspectSkin(Buffer.concat([classic(), Buffer.alloc(600 * 1024)])), /too big/);
  assert.equal(decodePng(rawPng({})).width, 64);
});

test('arm model guess: slim skins leave the arm edge empty', () => {
  assert.equal(inspectSkin(classic()).model, 'classic');
  assert.equal(inspectSkin(slim()).model, 'slim');
  const all = (a) => Buffer.alloc(64 * 64 * 4, a);
  assert.equal(guessModel(all(255), 64, 64), 'classic');
  assert.equal(guessModel(all(0), 64, 64), 'slim'); // nothing drawn anywhere
  assert.equal(guessModel(Buffer.alloc(64 * 32 * 4), 64, 32), 'classic', 'old 64x32 skins have no slim model');
  assert.equal(cleanName('  Cool\n  skin  '), 'Cool skin');
  assert.equal(cleanName('   ', 'x'), 'x');
});

async function setup({ offline = false } = {}) {
  mock.reset();
  const log = [];
  const fetchImpl = async (url, opts = {}) => { log.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body }); return (await mock.handle(url, opts)) || new Response('no route', { status: 404 }); };
  const root = tmpDir();
  fs.writeFileSync(`${root}/accounts.json`, JSON.stringify({ active: offline ? 'offline-a' : 'msa-demo', accounts: [
    { id: 'msa-demo', type: 'msa', name: 'DemoPlayer', uuid: 'demo', ownsGame: true, mcToken: `b64:${Buffer.from('secret-token').toString('base64')}`, mcTokenExpires: Date.now() + 1e10 },
    { id: 'offline-a', type: 'offline', name: 'Steve', uuid: 'steve' },
  ] }));
  const ctx = await createContext(root, { fetchImpl });
  const accounts = await new Accounts(ctx).load();
  return { ctx, accounts, skins: new Skins(ctx, accounts), log };
}

test('profile shows the current skin and the capes the account owns', async () => {
  const { skins } = await setup();
  const p = await skins.profile();
  assert.equal(p.name, 'DemoPlayer');
  assert.equal(p.skin.variant, 'classic');
  assert.ok(p.skin.dataUrl.startsWith('data:image/png;base64,'));
  assert.deepEqual(p.capes.map((c) => [c.alias, c.active]), [['Migrator', true], ['Vanilla', false], ['Pan', false]]);
  assert.ok(p.capes.every((c) => c.dataUrl));
});

test('apply uploads the skin with its arm model, keeps history, updates the head; reset and cape calls work', async () => {
  const { skins, accounts, log } = await setup();
  const entry = await skins.addBuffer(slim(), { name: 'Alexa-ish' });
  assert.equal(entry.model, 'slim', 'guessed from the file');
  const out = await skins.apply({ id: entry.id });
  assert.equal(out.skin.variant, 'slim');
  const post = log.find((l) => l.method === 'POST');
  assert.equal(post.url, 'https://api.minecraftservices.com/minecraft/profile/skins');
  assert.equal(post.body.get('variant'), 'slim');
  assert.equal(Buffer.from(await post.body.get('file').arrayBuffer()).equals(slim()), true);
  assert.equal((await skins.list()).history.length, 1);
  assert.equal((await skins.list()).history[0].by, 'DemoPlayer');
  assert.ok(accounts.get('msa-demo').skinAt > 0 && fs.existsSync(accounts.skinFile('msa-demo')), 'the account chip head is refreshed');
  // the same skin again is one history entry, not two
  await skins.update(entry.id, { model: 'classic' });
  await skins.apply({ id: entry.id });
  assert.equal((await skins.list()).history.length, 2, 'a different arm model is a different history entry');
  await skins.apply({ kind: 'history', id: (await skins.list()).history[1].id });
  assert.equal((await skins.list()).history.length, 2);
  // reset
  const reset = await skins.resetSkin();
  assert.equal(reset.skin, null);
  assert.equal(log.filter((l) => l.method === 'DELETE').at(-1).url, 'https://api.minecraftservices.com/minecraft/profile/skins/active');
  assert.equal(accounts.list()[0].skinAt, 0, 'back to the letter avatar');
  assert.ok(!fs.existsSync(accounts.skinFile('msa-demo')));
  // capes
  assert.equal((await skins.setCape(null, mock.state.capes[1].id)).capes.find((c) => c.active).alias, 'Vanilla');
  const put = log.filter((l) => l.method === 'PUT').at(-1);
  assert.deepEqual(JSON.parse(put.body), { capeId: mock.state.capes[1].id });
  assert.equal((await skins.setCape(null, null)).capes.some((c) => c.active), false);
  await assert.rejects(skins.setCape(null, 'not-owned'), /own it/);
  await assert.rejects(skins.setCape(null, '../x'), /Unknown cape/);
});

test('Mojang\'s rate limit becomes a readable sentence, and nothing is lost', async () => {
  const { skins } = await setup();
  const e = await skins.addBuffer(classic(), { name: 'One' });
  for (let i = 0; i < 3; i++) await skins.apply({ id: e.id });
  await assert.rejects(skins.apply({ id: e.id }), (err) => err.code === 'RATE_LIMIT' && /changed your skin too often, try again in about 2 minutes/.test(err.message) && !/TOO_MANY|json|path/i.test(err.message));
  assert.equal((await skins.list()).skins.length, 1);
});

test('the sign-in token only goes to Mojang, and never into the wardrobe files', async () => {
  const { skins, log, ctx } = await setup();
  const e = await skins.addBuffer(classic(), { name: 'One' });
  await skins.apply({ id: e.id });
  await skins.resetSkin();
  await skins.profile();
  await skins.importPlayer('Alexa');
  const withToken = log.filter((l) => JSON.stringify(l.headers).includes('secret-token'));
  assert.ok(withToken.length >= 3);
  assert.ok(withToken.every((l) => new URL(l.url).hostname === 'api.minecraftservices.com'));
  assert.ok(log.every((l) => /^(api\.minecraftservices\.com|api\.mojang\.com|sessionserver\.mojang\.com|textures\.minecraft\.net)$/.test(new URL(l.url).hostname)), 'only Mojang hosts');
  assert.ok(!fs.readFileSync(`${ctx.paths.wardrobe}/index.json`, 'utf8').includes('secret-token'));
});

test('offline accounts cannot change skins, but the wardrobe still works', async () => {
  const { skins } = await setup({ offline: true });
  const p = await skins.profile();
  assert.equal(p.offline, true);
  const e = await skins.addBuffer(classic(), { name: 'Browse only' });
  await assert.rejects(skins.apply({ id: e.id }), /Offline accounts can't change skins/);
  await assert.rejects(skins.resetSkin(), /Offline/);
  await assert.rejects(skins.setCape(null, mock.state.capes[0].id), /Offline/);
  assert.equal((await skins.list()).skins.length, 1);
});

test('import from a player name: Mojang lookups only, arm model from the profile', async () => {
  const { skins, log } = await setup();
  const a = await skins.importPlayer('alexa');
  assert.deepEqual([a.name, a.model, a.origin], ['Alexa', 'slim', 'player']);
  const b = await skins.importPlayer('Builder');
  assert.equal(b.model, 'classic');
  await assert.rejects(skins.importPlayer('Nobody'), /no player called Nobody/);
  await assert.rejects(skins.importPlayer('Ghost'), /no custom skin/);
  await assert.rejects(skins.importPlayer('x'), /3 to 16/);
  await assert.rejects(skins.importPlayer('../etc'), /3 to 16/);
  assert.ok(log.some((l) => l.url.startsWith('https://textures.minecraft.net/')), 'the http texture address from the session server was upgraded to https');
  assert.ok(log.every((l) => l.url.startsWith('https://')));
});

test('wardrobe: rename, arm model, delete, keep from history, files checked on add', async () => {
  const { skins, ctx } = await setup();
  const tmp = tmpDir();
  fs.writeFileSync(`${tmp}/cool skin.png`, classic());
  fs.writeFileSync(`${tmp}/fake.png`, 'not a png');
  const info = await skins.inspectFile(`${tmp}/cool skin.png`);
  assert.equal(info.suggestedName, 'cool skin');
  await assert.rejects(skins.inspectFile(`${tmp}/fake.png`), /not a PNG/);
  await assert.rejects(skins.addFile({ path: `${tmp}/fake.png`, name: 'x' }), /not a PNG/);
  await assert.rejects(skins.inspectFile(`${tmp}/missing.png`), /could not open/);
  const e = await skins.addFile({ path: `${tmp}/cool skin.png`, name: '  My   skin ', model: 'slim' });
  assert.deepEqual([e.name, e.model], ['My skin', 'slim']);
  assert.equal((await skins.update(e.id, { name: 'Renamed', model: 'classic' })).name, 'Renamed');
  await assert.rejects(skins.update(e.id, { model: 'wide' }), /classic or slim/);
  await skins.apply({ id: e.id });
  await skins.remove('wardrobe', e.id);
  assert.equal((await skins.list()).skins.length, 0);
  const kept = await skins.keepFromHistory((await skins.list()).history[0].id);
  assert.equal(kept.name, 'Renamed');
  assert.equal((await skins.list()).skins.length, 1);
  await assert.rejects(skins.apply({ id: '../../x' }), /Unknown skin|no longer/);
  await skins.clearHistory();
  assert.equal((await skins.list()).history.length, 0);
  assert.equal(fs.readdirSync(ctx.paths.wardrobe).filter((f) => f.endsWith('.png')).length, 1);
});
