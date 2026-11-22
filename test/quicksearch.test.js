'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../src/renderer/fuzzy');
const C = require('../src/renderer/color');
const { normalizeAppearance, DEFAULT_APPEARANCE } = require('../src/core/appearance');
const { makeCtx } = require('./helpers');
const { Instances } = require('../src/core/instances');

const page = (id, title) => ({ id: `page:${id}`, kind: 'page', title, keywords: [id] });
const inst = (id, title, sub = 'Fabric · Minecraft 1.21.1') => ({ id: `inst:${id}`, kind: 'instance', title, sub });
const mod = (id, title, where) => ({ id: `mod:${id}`, kind: 'mod', title, sub: `in ${where}` });
const act = (id, title, keywords = []) => ({ id: `act:${id}`, kind: 'action', title, keywords });
const items = [
  page('home', 'Home'), page('library', 'Library'), page('browse', 'Browse'), page('skins', 'Skins'), page('settings', 'Settings'),
  inst('a', 'Prominence II'), inst('b', 'Fabric 26.1.2'), inst('c', 'Craftoria'),
  mod('1', 'Sodium', 'Prominence II'), mod('2', 'Lithium', 'Craftoria'), mod('3', 'Sodium Extra', 'Craftoria'),
  act('new', 'New instance', ['create']), act('updates', 'Check for updates', ['update']), act('data', 'Open data folder'),
  { id: 'logs:a', kind: 'action', title: 'Open logs of Prominence II', queryOnly: true },
];
const top = (q, o) => S.rank(q, items, o).map((r) => r.item.id);

test('search: exact and prefix matches come first, every typed word has to match', () => {
  assert.equal(top('sodium')[0], 'mod:1', 'exact word beats "Sodium Extra"');
  assert.equal(top('lib')[0], 'page:library');
  assert.equal(top('prom')[0], 'inst:a');
  assert.deepEqual(top('sodium craftoria'), [], 'a mod does not match on the "in <instance>" part');
  assert.deepEqual(top('zzzzqq'), []);
});

test('search: tolerates typos and swapped letters', () => {
  assert.equal(top('sodim')[0], 'mod:1');
  assert.equal(top('setings')[0], 'page:settings');
  assert.equal(top('librery')[0], 'page:library');
  assert.equal(top('lihtium')[0], 'mod:2');
  assert.equal(top('brwose')[0], 'page:browse', 'two letters swapped');
  assert.ok(top('craftorai').includes('inst:c'));
  assert.ok(!top('xyz').includes('page:home'), 'unrelated words do not match short typos');
});

test('search: keywords and the "queryOnly" items', () => {
  assert.equal(top('create')[0], 'act:new');
  assert.ok(top('logs').includes('logs:a'));
  assert.ok(!top('').includes('logs:a'), 'per-instance log actions stay hidden until you type');
  assert.ok(top('').every((id) => !id.startsWith('mod:')), 'mods are not listed before you type');
});

test('search: recent choices are on top when nothing is typed and get a boost when typing', () => {
  const r = top('', { recent: ['inst:c', 'page:skins'] });
  assert.deepEqual(r.slice(0, 2), ['inst:c', 'page:skins']);
  assert.equal(top('')[0], 'page:home', 'without history: pages, then instances, then actions');
  // "o" words: Home/Browse/Open... — the recent one moves up
  const base = top('open').indexOf('act:data');
  const boosted = top('open', { recent: ['act:data'] }).indexOf('act:data');
  assert.ok(boosted <= base);
  assert.equal(top('cra', { recent: ['inst:c'] })[0], 'inst:c');
});

test('search: limit and umlauts', () => {
  assert.equal(S.rank('', items, { limit: 3 }).length, 3);
  assert.equal(S.norm('Crâftòria  II'), 'craftoria ii');
  assert.equal(S.distance('ab', 'ba', 1), 1);
});

test('colour contrast: WCAG ratios and the ink picked for the accent buttons', () => {
  assert.ok(Math.abs(C.contrast('#000000', '#ffffff') - 21) < 0.01);
  assert.ok(Math.abs(C.contrast('#777777', '#ffffff') - 4.48) < 0.05);
  assert.equal(C.readableInk('#8ea2ff'), C.INK_DARK);
  assert.equal(C.readableInk('#123456'), C.INK_LIGHT);
  assert.equal(C.parseHex('#abc').g, 0xbb);
  assert.equal(C.parseHex('nope'), null);
});

test('accent colours: text on the button is readable for every preset and for awkward custom colours', () => {
  const presets = ['#8ea2ff', '#5cc8ff', '#3ccf8e', '#a3e635', '#f2b84b', '#ff8a4c', '#ff6b8b', '#c084fc'];
  const awkward = ['#000000', '#ffffff', '#808080', '#7f7fff', '#1a2a80', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#777700', '#330033'];
  for (const hex of [...presets, ...awkward]) {
    const v = C.accentVars(hex);
    assert.ok(v.ratio >= 4.5, `${hex}: ink contrast ${v.ratio.toFixed(2)} on ${v.accent}`);
    assert.ok(v.onPanel >= 4.5, `${hex}: accent as text on the panel ${v.onPanel.toFixed(2)}`);
  }
  assert.equal(C.accentVars('#8ea2ff').lightened, false, 'the default is untouched');
  assert.equal(C.accentVars('#1a2a80').lightened, true, 'a dark accent is lightened');
  assert.equal(C.accentVars('garbage').accent, '#8ea2ff', 'a bad value falls back to the default');
});

test('appearance settings are cleaned: bad colour, size and file names fall back', () => {
  assert.deepEqual(normalizeAppearance(undefined), DEFAULT_APPEARANCE);
  const a = normalizeAppearance({ accent: 'red', scale: 300, bgDim: -5, bgBlur: 99, sidebar: 'top', backgroundFile: '../../evil.png', rounded: false, compact: 1 });
  assert.equal(a.accent, '#8ea2ff');
  assert.equal(a.scale, 125);
  assert.equal(a.bgDim, 0);
  assert.equal(a.bgBlur, 24);
  assert.equal(a.sidebar, 'left');
  assert.equal(a.backgroundFile, null, 'only background.<ext> is accepted');
  assert.equal(a.rounded, false);
  assert.equal(a.compact, true);
  assert.equal(normalizeAppearance({ accent: '#ABC', scale: 90, backgroundFile: 'background.png' }).accent, '#aabbcc');
  assert.equal(normalizeAppearance({ scale: 50 }).scale, 90);
});

test('appearance is saved in settings and a partial change keeps the rest', async () => {
  const ctx = await makeCtx([]);
  await ctx.settings.update({ appearance: { accent: '#ff6b8b', scale: 110 } });
  await ctx.settings.update({ appearance: { sidebar: 'right' } });
  const a = ctx.settings.publicView().appearance;
  assert.equal(a.accent, '#ff6b8b');
  assert.equal(a.scale, 110);
  assert.equal(a.sidebar, 'right');
  await ctx.settings.load();
  assert.equal(ctx.settings.get('appearance').accent, '#ff6b8b', 'survives a reload');
});

test('mod index for the quick search comes from the saved content.json files', async () => {
  const ctx = await makeCtx([]);
  const instances = new Instances(ctx);
  const a = await instances.create({ name: 'Alpha', mcVersion: '1.20.1', loader: { type: 'fabric', version: '0.15' } });
  const b = await instances.create({ name: 'Beta', mcVersion: '1.20.1', loader: { type: 'fabric', version: '0.15' } });
  fs.writeFileSync(path.join(instances.instDir(a.id), 'content.json'), JSON.stringify({ files: {
    'mods/sodium-1.jar': { source: 'modrinth', title: 'Sodium', versionName: '0.6.0' },
    'mods/local.jar': { source: 'local', meta: { name: 'My Local', version: '1.0' } },
    'mods/bare.jar': {},
    'resourcepacks/x.zip': { title: 'Not a mod' },
  } }));
  const idx = await instances.modIndex();
  assert.deepEqual(idx.map((m) => [m.title, m.instanceName, m.version]).sort(), [['My Local', 'Alpha', '1.0'], ['Sodium', 'Alpha', '0.6.0'], ['bare', 'Alpha', '']]);
  assert.ok(!idx.some((m) => m.instanceId === b.id));
});

test('quick search: mods match on their own name only, and instances rank above mods', () => {
  const items = [
    { id: 'inst:p', kind: 'instance', title: 'Prominence II', sub: 'Fabric 1.20.1', keywords: ['fabric'] },
    { id: 'mod:1', kind: 'mod', title: 'Cable Fixes for Prom', sub: 'in Some Pack' },
    { id: 'mod:2', kind: 'mod', title: 'Sodium', sub: 'in Prominence II' },
    { id: 'mod:3', kind: 'mod', title: 'Lithium', sub: 'in Prominence II' },
  ];
  const ids = S.rank('prom', items).map((r) => r.item.id);
  assert.equal(ids[0], 'inst:p', 'the instance beats a mod that has the word in its name');
  assert.ok(ids.includes('mod:1'));
  assert.ok(!ids.includes('mod:2') && !ids.includes('mod:3'), 'the "in Prominence II" label does not make a mod match');
});
