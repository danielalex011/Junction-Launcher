'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx } = require('./helpers');
const { Instances } = require('../src/core/instances');
const { Home, orderInstances, summarizeUpdates, UPDATES_TTL } = require('../src/core/home');

const inst = (id, o = {}) => ({ id, name: id, created: 1000, lastPlayed: null, ...o });

test('your instances row: played ones first (latest first), then never-played ones, newest first, capped', () => {
  const list = [inst('a', { lastPlayed: 100 }), inst('b', { lastPlayed: 500 }), inst('old', { created: 1 }), inst('new', { created: 9999 })];
  assert.deepEqual(orderInstances(list).map((i) => i.id), ['b', 'a', 'new', 'old']);
  assert.deepEqual(orderInstances([]), []);
  const many = Array.from({ length: 30 }, (_, n) => inst(`i${n}`, { lastPlayed: n + 1 }));
  assert.equal(orderInstances(many).length, 16);
  assert.equal(orderInstances(many)[0].id, 'i29');
});

async function setup({ updatesFor = {}, hits = [{ source: 'modrinth', id: 'P1', title: 'Pack' }] } = {}) {
  const ctx = await makeCtx([]);
  const instances = new Instances(ctx);
  const a = await instances.create({ name: 'Alpha', mcVersion: '1.20.1', loader: { type: 'fabric', version: '0.15' } });
  const b = await instances.create({ name: 'Beta', mcVersion: '1.20.1', loader: { type: 'fabric', version: '0.15' } });
  const calls = { check: 0, search: 0 };
  const content = { checkUpdates: async (id) => { calls.check++; return Array.from({ length: updatesFor[id] || 0 }, () => ({ file: 'x' })); } };
  const sources = { modrinth: { search: async () => { calls.search++; return { hits, total: hits.length }; }, configured: () => true }, curseforge: { configured: () => false } };

  return { ctx, home: new Home(ctx, instances, content, sources), a, b, calls, instances };
}

test('home updates are cached: a second refresh makes no calls, a stale one checks again', async () => {
  const s = await setup();
  s.home.content.checkUpdates = async (id) => { s.calls.check++; return id === s.a.id ? [{}, {}, {}] : []; };
  let st = await s.home.state();
  assert.equal(st.updatesStale, true);
  assert.deepEqual(st.updates, []);

  await s.home.refresh();
  assert.equal(s.calls.check, 2);
  st = await s.home.state();
  assert.equal(st.updatesStale, false);
  assert.deepEqual(st.updates.map((u) => [u.name, u.count]), [['Alpha', 3]], 'only instances that have updates are listed');

  await s.home.refresh();
  assert.equal(s.calls.check, 2, 'fresh cache: nothing is called');
  assert.equal(s.calls.search, 1);

  assert.equal((await s.home.state(Date.now() + UPDATES_TTL + 1000)).updatesStale, true);
  await s.home.refresh({ force: true });
  assert.equal(s.calls.check, 4);
});

test('home updates: the instance page keeps the cache in step, and deleted instances drop out', async () => {
  const s = await setup();
  s.home.content.checkUpdates = async (id) => (id === s.a.id ? [{}, {}] : [{}]);
  await s.home.refresh();
  assert.equal((await s.home.state()).updates.length, 2);
  await s.home.record(s.a.id, 0); // applied the updates
  assert.deepEqual((await s.home.state()).updates.map((u) => u.name), ['Beta']);
  await s.instances.remove(s.b.id);
  assert.deepEqual((await s.home.state()).updates, []);
});

test('home: a failed check keeps the old numbers, and popular packs come from the cache', async () => {
  const s = await setup();
  s.home.content.checkUpdates = async () => [{}];
  await s.home.refresh();
  s.home.content.checkUpdates = async () => { throw new Error('offline'); };
  await s.home.refresh({ force: true });
  const st = await s.home.state();
  assert.equal(st.updates.length, 2, 'offline: still shows the last known result');
  assert.equal(st.popular[0].title, 'Pack');
  assert.equal(st.popularStale, false);
});

test('summary: instances with mod updates, total updates, and modpack updates named', () => {
  const up = (name, count, pack = null) => ({ instanceId: name, name, count, pack });
  assert.deepEqual(summarizeUpdates([]), { instances: 0, mods: 0, packs: 0, text: '' });
  assert.equal(summarizeUpdates([up('A', 1)]).text, '1 instance has 1 update');
  const s = summarizeUpdates([up('A', 13), up('B', 20), up('C', 7), up('D', 5), up('E', 3, { versionName: '1.0' }), up('Prominence II', 0, { versionName: '4.2.0' })]);
  assert.equal(s.mods, 48);
  assert.equal(s.instances, 6);
  assert.equal(s.packs, 2);
  assert.equal(s.text, '5 instances have 48 updates · 2 modpack updates available');
  assert.equal(summarizeUpdates([up('A', 13), up('Prominence II', 0, { versionName: '4.2.0' })]).text, '1 instance has 13 updates · Prominence II 4.2.0 available');
  assert.equal(summarizeUpdates([up('Prominence II', 0, { versionName: '4.2.0' })]).text, 'Prominence II 4.2.0 available', 'a pack update alone has no mod part');
});

test('home state carries the summary built from the cached counts and pack updates', async () => {
  const s = await setup();
  s.home.content.checkUpdates = async (id) => (id === s.a.id ? [{}, {}, {}] : [{}]);
  s.home.packs = { needsLabels: async () => false, checkUpdate: async (id) => (id === s.b.id ? { versionId: 'v2', versionName: '4.2.0' } : null) };
  await s.instances.update(s.b.id, { pack: { source: 'modrinth', name: 'Beta Pack', versionId: 'v1', versionName: '4.1.0' } });
  await s.home.refresh();
  const st = await s.home.state();
  assert.equal(st.summary.mods, 4);
  assert.equal(st.summary.instances, 2);
  assert.equal(st.summary.text, '2 instances have 4 updates · Beta 4.2.0 available');
  assert.deepEqual(st.updates.find((u) => u.name === 'Beta').pack, { versionId: 'v2', versionName: '4.2.0' });
});
