'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeCtx, sha1, sha512, fabricJar } = require('./helpers');
const { Instances } = require('../src/core/instances');
const { createSources } = require('../src/core/sources');
const { ContentManager } = require('../src/core/content/manager');

function fakeModrinth() {
  const blobs = {};
  const mk = (id, num, type, date) => {
    const buf = fabricJar('sodium', 'Sodium', num);
    const url = `https://cdn.modrinth.com/data/SOD/versions/${id}/sodium-${num}.jar`;
    blobs[url] = buf;
    return { id, project_id: 'SOD', name: num, version_number: num, game_versions: ['26.3'], loaders: ['fabric'], version_type: type, date_published: date,
      files: [{ url, filename: `sodium-${num}.jar`, hashes: { sha1: sha1(buf), sha512: sha512(buf) }, size: buf.length, primary: true }], dependencies: [] };
  };
  const versions = [mk('v1', '0.6.0', 'release', '2026-01-01T00:00:00Z'), mk('v2', '0.6.1', 'release', '2026-02-01T00:00:00Z'), mk('v3', '0.7.0-beta.1', 'beta', '2026-03-01T00:00:00Z')];
  const API = 'https://api.modrinth.com/v2';
  return [
    ['GET', new RegExp(`^${API}/project/SOD/version`), () => ({ json: versions })],
    ['GET', `${API}/project/SOD`, () => ({ json: { id: 'SOD', slug: 'sodium', title: 'Sodium', project_type: 'mod' } })],
    ['GET', new RegExp(`^${API}/projects\\?`), () => ({ json: [{ id: 'SOD', slug: 'sodium', title: 'Sodium', project_type: 'mod' }] })],
    ['GET', new RegExp(`^${API}/version/(v\\d)$`), (u) => ({ json: versions.find((v) => v.id === u.split('/').pop()) })],
    ['POST', `${API}/version_files/update`, (_u, b) => ({ json: Object.fromEntries(b.hashes.filter((h) => h === versions[0].files[0].hashes.sha1).map((h) => [h, versions[2]])) })],
    ['POST', `${API}/version_files`, (_u, b) => ({ json: Object.fromEntries(b.hashes.map((h) => [h, versions.find((v) => v.files[0].hashes.sha1 === h)]).filter(([, v]) => v)) })],
    ['GET', /cdn\.modrinth\.com/, (u) => ({ body: blobs[u] })],
  ];
}

test('update review: pick a non-latest version, keep it disabled, then undo the whole update', async () => {
  const ctx = await makeCtx(fakeModrinth());
  const instances = new Instances(ctx);
  const content = new ContentManager(ctx, instances, createSources(ctx));
  const inst = await instances.create({ name: 'Fabric 26.3', mcVersion: '26.3', loader: { type: 'fabric', version: '0.20.1' } });
  await content.installProject(inst.id, { source: 'modrinth', id: 'SOD' }, 'mod', { versionId: 'v1' });
  await content.setEnabled(inst.id, 'mods/sodium-0.6.0.jar', false);

  const ups = await content.checkUpdates(inst.id);
  assert.equal(ups.length, 1);
  assert.equal(ups[0].version.id, 'v3');
  assert.equal(ups[0].currentVersionId, 'v1');

  const cands = await content.updateCandidates(inst.id, { source: 'modrinth', projectId: 'SOD', type: 'mod', currentVersionId: 'v1' });
  assert.deepEqual(cands.map((v) => v.id), ['v3', 'v2'], 'newer versions only, newest first');

  const chosen = cands.find((v) => v.id === 'v2'); // the user picks the release, not the beta
  const r = await content.applyUpdates(inst.id, [{ ...ups[0], version: chosen }]);
  assert.deepEqual(r.warnings, [], 'no false "Replaced …" warning');
  assert.ok(r.backup);
  const mods = await instances.listContent(inst.id, 'mod');
  assert.equal(mods.length, 1);
  assert.equal(mods[0].fileName, 'sodium-0.6.1.jar');
  assert.equal(mods[0].enabled, false, 'a disabled mod stays disabled after updating');
  assert.equal(mods[0].versionId, 'v2');

  const hist = await content.updateHistory(inst.id);
  assert.deepEqual(hist[0].items, [{ title: 'Sodium', from: '0.6.0', to: '0.6.1' }]);

  const u = await content.undoUpdate(inst.id, hist[0].stamp);
  assert.equal(u.restored, 1);
  const back = await instances.listContent(inst.id, 'mod');
  assert.equal(back.length, 1);
  assert.equal(back[0].fileName, 'sodium-0.6.0.jar');
  assert.equal(back[0].enabled, false);
  assert.equal(back[0].versionId, 'v1');
  assert.equal(back[0].source, 'modrinth');
  assert.deepEqual(await content.updateHistory(inst.id), []);
  await assert.rejects(content.undoUpdate(inst.id, '../../etc'), /Bad backup/);
});
