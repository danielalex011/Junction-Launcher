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

const { sameVariant } = require('../src/core/content/variant');
const Channel = require('../src/renderer/channel');

test('variant check: same kind of content, and not just another variant tag', () => {
  const rp = { versionNumber: '1.12.9+rp', loaders: ['minecraft'] };
  assert.equal(sameVariant(rp, { versionNumber: '1.12.9+dp', loaders: ['datapack'] }), false, 'a data pack is not an update for a resource pack');
  assert.equal(sameVariant(rp, { versionNumber: '1.12.9+dp', loaders: ['minecraft'] }), false, 'same number, other variant tag');
  assert.equal(sameVariant(rp, { versionNumber: '1.13.0+rp', loaders: ['minecraft'] }), true);
  assert.equal(sameVariant({ versionNumber: '1.0', loaders: ['fabric'] }, { versionNumber: '1.1', loaders: ['forge'] }), false);
  assert.equal(sameVariant({ versionNumber: '1.0', loaders: ['fabric'] }, { versionNumber: '1.1', loaders: ['fabric', 'quilt'] }), true);
  assert.equal(sameVariant(null, rp), true, 'nothing to compare with');
});

test('checkUpdates never offers a data pack for a resource pack', async () => {
  const API = 'https://api.modrinth.com/v2';
  const buf = Buffer.from('resource pack zip');
  const mk = (id, num, loaders, date) => ({ id, project_id: 'MAT', name: num, version_number: num, game_versions: ['26.3'], loaders, version_type: 'release', date_published: date,
    files: [{ url: `https://cdn.modrinth.com/data/MAT/${id}.zip`, filename: `matcha-${id}.zip`, hashes: { sha1: sha1(Buffer.from(id)), sha512: sha512(Buffer.from(id)) }, size: 3, primary: true }], dependencies: [] });
  const versions = [mk('r1', '1.12.8+rp', ['minecraft'], '2026-01-01T00:00:00Z'), mk('r2', '1.12.9+rp', ['minecraft'], '2026-02-01T00:00:00Z'), mk('d2', '1.12.9+dp', ['datapack'], '2026-02-02T00:00:00Z')];
  const asked = [];
  const ctx = await makeCtx([
    ['GET', new RegExp(`^${API}/project/MAT/version`), () => ({ json: versions })],
    ['GET', new RegExp(`^${API}/project/MAT$`), () => ({ json: { id: 'MAT', slug: 'matcha', title: 'Matcha', project_type: 'resourcepack' } })],
    ['GET', new RegExp(`^${API}/projects\?`), () => ({ json: [{ id: 'MAT', slug: 'matcha', title: 'Matcha', project_type: 'resourcepack' }] })],
    // a sloppy server: ignores the loader filter and answers with the newest file overall (the data pack)
    ['POST', `${API}/version_files/update`, (_u, b) => { asked.push(b.loaders); return { json: Object.fromEntries(b.hashes.map((h) => [h, b.loaders?.includes('minecraft') ? versions[1] : versions[2]])) }; }],
    ['POST', `${API}/version_files`, (_u, b) => ({ json: Object.fromEntries(b.hashes.map((h) => [h, versions.find((v) => v.files[0].hashes.sha1 === h)]).filter(([, v]) => v)) })],
    ['GET', /cdn\.modrinth\.com/, () => ({ body: buf })],
  ]);
  const instances = new Instances(ctx);
  const content = new ContentManager(ctx, instances, createSources(ctx));
  const inst = await instances.create({ name: 'Packs', mcVersion: '26.3', loader: { type: 'fabric', version: '0.20.1' } });
  await instances.withIndex(inst.id, (idx) => { idx.files['resourcepacks/matcha-r1.zip'] = { source: 'modrinth', projectId: 'MAT', versionId: 'r1', versionName: '1.12.8+rp', title: 'Matcha', sha1: sha1(Buffer.from('r1')) }; });
  await fs.promises.mkdir(instances.contentPath(inst.id, 'resourcepacks'), { recursive: true });
  await fs.promises.writeFile(instances.contentPath(inst.id, 'resourcepacks/matcha-r1.zip'), 'x');
  const ups = (await content.checkUpdates(inst.id)).filter((u) => !u.error);
  assert.deepEqual(asked, [['minecraft']], 'asks for the same kind of content as the installed file');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].version.id, 'r2');
  const cands = await content.updateCandidates(inst.id, { source: 'modrinth', projectId: 'MAT', type: 'resourcepack', currentVersionId: 'r1' });
  assert.deepEqual(cands.map((v) => v.id), ['r2'], 'the data pack is not offered in the version list either');
});

test('update channel: each mod stays on its own channel by default', () => {
  assert.equal(Channel.allowed('auto', 'release', 'beta'), false, 'a release stays on releases');
  assert.equal(Channel.allowed('auto', 'release', 'release'), true);
  assert.equal(Channel.allowed('auto', 'beta', 'beta'), true);
  assert.equal(Channel.allowed('auto', 'beta', 'release'), true);
  assert.equal(Channel.allowed('auto', 'beta', 'alpha'), false);
  assert.equal(Channel.allowed('auto', 'alpha', 'alpha'), true);
  assert.equal(Channel.allowed('auto', undefined, 'beta'), false, 'unknown counts as a release');
  assert.equal(Channel.allowed('alpha', 'release', 'alpha'), true, 'the dropdown can override');
  assert.equal(Channel.allowed('release', 'alpha', 'beta'), false);
});
