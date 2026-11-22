'use strict';
// New instances get a unique name ("Name (2)", "Name (3)"...); instances that already exist are never renamed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx } = require('./helpers');
const { Instances } = require('../src/core/instances');

const mk = (instances, name, extra = {}) => instances.create({ name, mcVersion: '1.21', loader: { type: 'fabric', version: '0.16.0' }, ...extra });

test('a name that is taken gets " (2)", " (3)"...; the first one keeps its name', async () => {
  const instances = new Instances(await makeCtx());
  const a = await mk(instances, 'My pack');
  const b = await mk(instances, 'My pack');
  const c = await mk(instances, 'My pack');
  assert.deepEqual([a.name, b.name, c.name], ['My pack', 'My pack (2)', 'My pack (3)']);
  assert.equal((await instances.get(a.id)).name, 'My pack', 'the existing instance is not renamed');
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
});

test('names are compared ignoring case and spaces around them; a free number is reused', async () => {
  const instances = new Instances(await makeCtx());
  await mk(instances, 'Fabric 1.21');
  assert.equal((await mk(instances, '  fabric 1.21 ')).name, 'fabric 1.21 (2)');
  const third = await mk(instances, 'Fabric 1.21');
  assert.equal(third.name, 'Fabric 1.21 (3)');
  await instances.remove(third.id);
  assert.equal((await mk(instances, 'Fabric 1.21')).name, 'Fabric 1.21 (3)');
});

test('the default name is unique too, and instances made at the same moment do not share a name', async () => {
  const instances = new Instances(await makeCtx());
  const made = await Promise.all([mk(instances, ''), mk(instances, ''), mk(instances, 'Same'), mk(instances, 'Same')]);
  assert.deepEqual(made.map((i) => i.name).sort(), ['Same', 'Same (2)', 'fabric 1.21', 'fabric 1.21 (2)']);
});

test('copies, pack installs and imports (all go through create) are numbered; renaming is left to the user', async () => {
  const instances = new Instances(await makeCtx());
  const a = await mk(instances, 'Lantern Pack', { pack: { source: 'modrinth', projectId: 'L', name: 'Lantern Pack' } });
  const again = await mk(instances, 'Lantern Pack', { pack: { source: 'modrinth', projectId: 'L', name: 'Lantern Pack' } });
  assert.equal(again.name, 'Lantern Pack (2)');
  const copy = await instances.duplicate(a.id);
  assert.equal(copy.name, 'Lantern Pack (copy)');
  assert.equal((await instances.duplicate(a.id)).name, 'Lantern Pack (copy) (2)');
  await instances.update(again.id, { name: 'Lantern Pack' }); // the user can still choose a clashing name by hand
  assert.equal((await instances.get(again.id)).name, 'Lantern Pack');
});
