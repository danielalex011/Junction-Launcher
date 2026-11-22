'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeCtx, sha1, sha512, fabricJar } = require('./helpers');
const { Instances } = require('../src/core/instances');
const { createSources } = require('../src/core/sources');
const { ContentManager } = require('../src/core/content/manager');
const { Templates } = require('../src/core/content/templates');

const API = 'https://api.modrinth.com/v2';
const CF = 'https://api.curseforge.com/v1';

/** Modrinth: SOD has a release and a newer beta for 1.21 (fabric); FRG only has a forge version; OLD only 1.20. CurseForge: a mod whose author blocked downloads. */
function routes() {
  const blobs = {};
  const mkv = (id, project, num, type, date, gv, loaders) => {
    const buf = fabricJar(project.toLowerCase(), project, num);
    const url = `https://cdn.modrinth.com/data/${project}/${id}.jar`;
    blobs[url] = buf;
    return { id, project_id: project, name: num, version_number: num, game_versions: gv, loaders, version_type: type, date_published: date,
      files: [{ url, filename: `${project.toLowerCase()}-${num}.jar`, hashes: { sha1: sha1(buf), sha512: sha512(buf) }, size: buf.length, primary: true }], dependencies: [] };
  };
  const versions = {
    SOD: [mkv('s1', 'SOD', '0.6.0', 'release', '2026-01-01T00:00:00Z', ['1.21'], ['fabric']), mkv('s2', 'SOD', '0.7.0-beta.1', 'beta', '2026-03-01T00:00:00Z', ['1.21'], ['fabric'])],
    FRG: [mkv('f1', 'FRG', '1.0.0', 'release', '2026-01-01T00:00:00Z', ['1.21'], ['forge'])],
    OLD: [mkv('o1', 'OLD', '1.0.0', 'release', '2026-01-01T00:00:00Z', ['1.20'], ['fabric'])],
  };
  const project = (id) => ({ id, slug: id.toLowerCase(), title: id, project_type: 'mod' });
  const cfFile = { id: 900, modId: 77, displayName: 'Blocked 1.0', fileName: 'blocked-1.0.jar', downloadUrl: null, releaseType: 1, fileDate: '2026-01-01T00:00:00Z', gameVersions: ['1.21', 'Fabric'], hashes: [], fileLength: 10, dependencies: [] };
  return [
    ['GET', new RegExp(`^${API}/project/(SOD|FRG|OLD)/version`), (u) => ({ json: versions[u.match(/project\/(\w+)\/version/)[1]] })],
    ['GET', new RegExp(`^${API}/project/(SOD|FRG|OLD)$`), (u) => ({ json: project(u.split('/').pop()) })],
    ['GET', new RegExp(`^${API}/version/(\\w+)$`), (u) => ({ json: Object.values(versions).flat().find((v) => v.id === u.split('/').pop()) })],
    ['GET', new RegExp(`^${CF}/mods/77/files`), () => ({ json: { data: [cfFile], pagination: { totalCount: 1 } } })],
    ['GET', new RegExp(`^${CF}/mods/77$`), () => ({ json: { data: { id: 77, slug: 'blocked', name: 'Blocked Mod', classId: 6, links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/blocked' }, latestFilesIndexes: [] } } })],
    ['POST', `${CF}/mods/files`, (_u, b) => ({ json: { data: b.fileIds.map((i) => (i === 900 ? cfFile : null)).filter(Boolean) } })],
    ['GET', /cdn\.modrinth\.com/, (u) => ({ body: blobs[u] })],
  ];
}

async function setup() {
  const ctx = await makeCtx(routes(), { cfKey: 'test-key' });
  const instances = new Instances(ctx);
  const content = new ContentManager(ctx, instances, createSources(ctx));
  const templates = new Templates(ctx, instances, content);
  const src = await instances.create({ name: 'My pack', mcVersion: '1.20.1', loader: { type: 'fabric', version: '0.15.0' } });
  const mods = instances.contentPath(src.id, 'mods');
  await fs.promises.mkdir(mods, { recursive: true });
  for (const f of ['sodium.jar', 'frg.jar', 'old.jar', 'blocked.jar', 'mine.jar']) await fs.promises.writeFile(path.join(mods, f), 'x');
  const game = instances.gameDir(src.id);
  await fs.promises.mkdir(path.join(game, 'config'), { recursive: true });
  await fs.promises.writeFile(path.join(game, 'config', 'a.toml'), 'a=1');
  await fs.promises.writeFile(path.join(game, 'options.txt'), 'fov:90');
  await instances.withIndex(src.id, (idx) => {
    idx.files['mods/sodium.jar'] = { source: 'modrinth', projectId: 'SOD', title: 'Sodium' };
    idx.files['mods/frg.jar'] = { source: 'modrinth', projectId: 'FRG', title: 'Forge Only' };
    idx.files['mods/old.jar'] = { source: 'modrinth', projectId: 'OLD', title: 'Old Mod' };
    idx.files['mods/blocked.jar'] = { source: 'curseforge', projectId: 77, title: 'Blocked Mod' };
    idx.files['mods/mine.jar'] = { source: 'local', title: 'My Own Mod' };
  });
  return { ctx, instances, content, templates, src };
}

test('save as template: project IDs only, local files listed and skipped, optional files copied', async () => {
  const { templates, ctx } = await setup();
  const t = await templates.save((await new Instances(ctx).list())[0].id, { name: 'Favourites', include: { configs: true, options: true } });
  assert.equal(t.counts.mod, 4);
  assert.deepEqual(t.skipped.map((s) => s.title), ['My Own Mod']);
  assert.match(t.skipped[0].why, /not from Modrinth or CurseForge/);
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.paths.root, 'templates', t.id, 'template.json'), 'utf8'));
  assert.equal(saved.content.mod.find((m) => m.projectId === 'SOD').source, 'modrinth');
  assert.ok(!JSON.stringify(saved.content).includes('.jar'), 'the saved projects are IDs, not files');
  assert.ok(fs.existsSync(path.join(ctx.paths.root, 'templates', t.id, 'files', 'config', 'a.toml')));
  assert.ok(fs.existsSync(path.join(ctx.paths.root, 'templates', t.id, 'files', 'options.txt')));
  assert.equal((await templates.list()).length, 1);
  assert.equal((await templates.rename(t.id, 'Renamed')).name, 'Renamed');
  await templates.remove(t.id);
  assert.deepEqual(await templates.list(), []);
});

test('template plan: newest matching version per project, with the release-channel rule', async () => {
  const { templates, src } = await setup();
  const t = await templates.save(src.id, { name: 'T' });
  const plan = await templates.plan(t.id, { mcVersion: '1.21', loader: { type: 'fabric' } });
  const by = (title) => plan.items.find((i) => i.title === title);
  assert.equal(by('Sodium').status, 'add');
  assert.equal(by('Sodium').versionNumber, '0.6.0', 'a release is preferred over a newer beta');
  assert.equal(by('Sodium').versionId, 's1');
  assert.equal(by('Blocked Mod').status, 'add');
  assert.equal(by('Blocked Mod').manual, true, 'downloadUrl null: flagged for the manual-download flow, no CDN URL is built');
});

test('template plan: projects with no version for this Minecraft version or loader are "not available"', async () => {
  const { templates, src } = await setup();
  const t = await templates.save(src.id, { name: 'T' });
  const plan = await templates.plan(t.id, { mcVersion: '1.21', loader: { type: 'fabric' } });
  const by = (title) => plan.items.find((i) => i.title === title);
  assert.equal(by('Forge Only').status, 'unavailable');
  assert.match(by('Forge Only').reason, /No version for Minecraft 1\.21 with fabric/);
  assert.equal(by('Old Mod').status, 'unavailable');
  assert.equal(by('My Own Mod').status, 'skipped', 'what was left out at save time shows as skipped');
  const forge = await templates.plan(t.id, { mcVersion: '1.21', loader: { type: 'forge' } });
  assert.equal(forge.items.find((i) => i.title === 'Forge Only').status, 'add');
  assert.equal(forge.items.find((i) => i.title === 'Sodium').status, 'unavailable');
  const vanilla = await templates.plan(t.id, { mcVersion: '1.21', loader: { type: 'vanilla' } });
  assert.ok(vanilla.items.filter((i) => i.type === 'mod').every((i) => i.status === 'skipped'), 'mods are skipped on a vanilla instance');
});

test('applying a template installs only what was confirmed', async () => {
  const { templates, instances, src } = await setup();
  const t = await templates.save(src.id, { name: 'T' });
  const plan = await templates.plan(t.id, { mcVersion: '1.21', loader: { type: 'fabric' } });
  const target = await instances.create({ name: 'New', mcVersion: '1.21', loader: { type: 'fabric', version: '0.16.0' } });
  const chosen = plan.items.filter((i) => i.status === 'add' && i.title === 'Sodium');
  await assert.rejects(templates.apply(target.id, chosen), /confirm/);
  assert.equal((await instances.listContent(target.id, 'mod')).length, 0, 'nothing installs without the confirmation');
  const r = await templates.apply(target.id, chosen, { confirmed: true });
  assert.equal(r.installed.length, 1);
  const mods = await instances.listContent(target.id, 'mod');
  assert.deepEqual(mods.map((m) => m.versionId), ['s1']);
});
