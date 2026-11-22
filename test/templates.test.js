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

// ---------------------------------------------------------------- dependencies, failures, copied files

/** ALP needs LIB (required) and OPT (optional). BET needs GHO, which has no version for 1.21. BAD's file can't be downloaded. */
function depRoutes() {
  const blobs = {};
  const dep = (id, type) => ({ project_id: id, version_id: null, file_name: null, dependency_type: type });
  const mkv = (project, { gv = ['1.21'], loaders = ['fabric'], deps = [], missingFile = false, ext = 'jar' } = {}) => {
    const buf = ext === 'jar' ? fabricJar(project.toLowerCase(), project, '1.0.0') : Buffer.from(`pack ${project}`);
    const url = `https://cdn.modrinth.com/data/${project}/${project}.${ext}`;
    if (!missingFile) blobs[url] = buf;
    return { id: `${project}-v1`, project_id: project, name: '1.0.0', version_number: '1.0.0', game_versions: gv, loaders, version_type: 'release', date_published: '2026-01-01T00:00:00Z',
      files: [{ url, filename: `${project.toLowerCase()}.${ext}`, hashes: { sha1: sha1(buf), sha512: sha512(buf) }, size: buf.length, primary: true }], dependencies: deps };
  };
  const versions = {
    ALP: [mkv('ALP', { deps: [dep('LIB', 'required'), dep('OPT', 'optional')] })],
    LIB: [mkv('LIB')],
    OPT: [mkv('OPT')],
    BET: [mkv('BET', { deps: [dep('GHO', 'required')] })],
    GHO: [mkv('GHO', { gv: ['1.20'] })],
    CAR: [mkv('CAR')],
    BAD: [mkv('BAD', { missingFile: true })],
    RPK: [mkv('RPK', { loaders: ['minecraft'], ext: 'zip' })],
    SHD: [mkv('SHD', { loaders: ['iris'], ext: 'zip' })],
  };
  const titles = { ALP: 'Alpha Mod', LIB: 'Library Mod', OPT: 'Optional Extra', BET: 'Beta Mod', GHO: 'Ghost Lib', CAR: 'Carl', BAD: 'Bad Download', RPK: 'Pretty Pack', SHD: 'Shiny Shaders' };
  const ids = Object.keys(versions).join('|');
  return {
    versions, titles,
    routes: [
      ['GET', new RegExp(`^${API}/project/(${ids})/version`), (u) => ({ json: versions[u.match(/project\/(\w+)\/version/)[1]] })],
      ['GET', new RegExp(`^${API}/project/(${ids})$`), (u) => { const id = u.split('/').pop(); return { json: { id, slug: id.toLowerCase(), title: titles[id], project_type: 'mod' } }; }],
      ['GET', new RegExp(`^${API}/version/([\\w-]+)$`), (u) => ({ json: Object.values(versions).flat().find((v) => v.id === u.split('/').pop()) })],
      ['GET', /cdn\.modrinth\.com/, (u) => (blobs[u] ? { body: blobs[u] } : { status: 404, body: 'gone' })],
    ],
  };
}

async function depSetup({ include = {} } = {}) {
  const { routes: r, titles } = depRoutes();
  const ctx = await makeCtx(r);
  const instances = new Instances(ctx);
  const content = new ContentManager(ctx, instances, createSources(ctx));
  const templates = new Templates(ctx, instances, content);
  const src = await instances.create({ name: 'Source', mcVersion: '1.21', loader: { type: 'fabric', version: '0.16.0' } });
  const game = instances.gameDir(src.id);
  const put = async (dir, file, source, projectId) => { await fs.promises.mkdir(path.join(game, dir), { recursive: true }); await fs.promises.writeFile(path.join(game, dir, file), 'x'); return [`${dir}/${file}`, { source, projectId, title: titles[projectId] }]; };
  const entries = [await put('mods', 'a.jar', 'modrinth', 'ALP'), await put('mods', 'b.jar', 'modrinth', 'BET'), await put('mods', 'c.jar', 'modrinth', 'CAR'), await put('mods', 'd.jar', 'modrinth', 'BAD'),
    await put('resourcepacks', 'r.zip', 'modrinth', 'RPK'), await put('shaderpacks', 's.zip', 'modrinth', 'SHD')];
  await fs.promises.writeFile(path.join(game, 'options.txt'), 'fov:70');
  await fs.promises.mkdir(path.join(game, 'config'), { recursive: true });
  await fs.promises.writeFile(path.join(game, 'config', 'x.toml'), 'k=1');
  await instances.withIndex(src.id, (idx) => { for (const [k, v] of entries) idx.files[k] = v; });
  const t = await templates.save(src.id, { name: 'Deps', include: { resourcepacks: true, shaders: true, options: true, configs: true, ...include } });
  return { ctx, instances, content, templates, t };
}

test('plan: missing required dependencies are added, optional ones ignored, and a mod that cannot get its dependency is held back', async () => {
  const { templates, t } = await depSetup();
  const plan = await templates.plan(t.id, { mcVersion: '1.21', loader: { type: 'fabric' } });
  const by = (title) => plan.items.find((i) => i.title === title);
  assert.equal(by('Alpha Mod').status, 'add');
  assert.equal(by('Library Mod').status, 'add', 'a required dependency the template does not have is added');
  assert.equal(by('Library Mod').dependency, true);
  assert.deepEqual(by('Library Mod').neededBy, ['Alpha Mod']);
  assert.equal(by('Optional Extra'), undefined, 'optional dependencies are not installed');
  assert.equal(by('Beta Mod').status, 'unavailable');
  assert.equal(by('Beta Mod').forceable, true, 'the user can still install it anyway');
  assert.equal(by('Beta Mod').reason, "Needs Ghost Lib, which isn't available for Minecraft 1.21 with fabric.");
  assert.equal(by('Ghost Lib'), undefined, 'the missing dependency itself is not listed, its name is in the reason');
  assert.ok(plan.items.every((i) => !/^[A-Z]{3}$/.test(i.title)), 'names, never raw project IDs');
  assert.equal(by('Pretty Pack').status, 'add');
  assert.equal(by('Shiny Shaders').status, 'add');
  assert.deepEqual(plan.copies, ['config folder', 'options.txt']);
});

test('apply: one mod that fails does not stop the rest; packs, shaders, dependencies and saved files all arrive', async () => {
  const { templates, instances, t } = await depSetup();
  const plan = await templates.plan(t.id, { mcVersion: '1.21', loader: { type: 'fabric' } });
  const target = await instances.create({ name: 'Target', mcVersion: '1.21', loader: { type: 'fabric', version: '0.16.0' } });
  const chosen = plan.items.filter((i) => i.status === 'add');
  assert.ok(chosen.some((i) => i.title === 'Bad Download'), 'the failing mod was planned');
  const r = await templates.apply(target.id, chosen, { confirmed: true, templateId: t.id, copyFiles: true });
  assert.deepEqual(r.problems.map((p) => p.title), ['Bad Download'], 'only the broken one is reported');
  const mods = (await instances.listContent(target.id, 'mod')).map((m) => m.title).sort();
  assert.deepEqual(mods, ['Alpha Mod', 'Carl', 'Library Mod']);
  assert.equal((await instances.listContent(target.id, 'resourcepack')).length, 1);
  assert.equal((await instances.listContent(target.id, 'shader')).length, 1);
  assert.deepEqual(r.copied.sort(), ['config folder', 'options.txt']);
  assert.equal(fs.readFileSync(path.join(instances.gameDir(target.id), 'options.txt'), 'utf8'), 'fov:70');
  assert.ok(fs.existsSync(path.join(instances.gameDir(target.id), 'config', 'x.toml')));
});

test('apply: Cancel still stops everything instead of being listed as a problem', async () => {
  const { templates, instances, t } = await depSetup();
  const plan = await templates.plan(t.id, { mcVersion: '1.21', loader: { type: 'fabric' } });
  const target = await instances.create({ name: 'Target', mcVersion: '1.21', loader: { type: 'fabric', version: '0.16.0' } });
  const { CancelledError } = require('../src/core/taskcontext');
  let n = 0;
  await assert.rejects(templates.apply(target.id, plan.items.filter((i) => i.status === 'add'), { confirmed: true, report: () => { if (++n > 2) throw new CancelledError(); } }), (e) => e.name === 'CancelledError');
});
