'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx } = require('./helpers');
const { Instances } = require('../src/core/instances');
const { Home, pickJumpBackIn, UPDATES_TTL } = require('../src/core/home');

const inst = (id, o = {}) => ({ id, name: id, created: 1000, lastPlayed: null, ...o });

test('jump back in: most recently played first, at most 6, unplayed ones left out', () => {
  const list = [inst('a', { lastPlayed: 100 }), inst('b', { lastPlayed: 500 }), inst('never', { created: 9999 }),
    ...Array.from({ length: 6 }, (_, n) => inst(`p${n}`, { lastPlayed: 200 + n }))];
  const r = pickJumpBackIn(list);
  assert.equal(r.fallback, false);
  assert.equal(r.items.length, 6);
  assert.equal(r.items[0].id, 'b');
  assert.ok(!r.items.some((i) => i.id === 'never'));
  assert.deepEqual(r.items.slice(1).map((i) => i.id), ['p5', 'p4', 'p3', 'p2', 'p1']);
});

test('jump back in: when nothing was played, the newest created or imported instances', () => {
  const r = pickJumpBackIn([inst('old', { created: 1 }), inst('new', { created: 30 }), inst('mid', { created: 20 })]);
  assert.equal(r.fallback, true);
  assert.deepEqual(r.items.map((i) => i.id), ['new', 'mid', 'old']);
  assert.deepEqual(pickJumpBackIn([]), { items: [], fallback: true });
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
