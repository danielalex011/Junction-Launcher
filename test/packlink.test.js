'use strict';
// Linked modpacks: pack-content labels (matched by hash, never touching files), locked pack files,
// comparing pack versions, and pack updates that keep your additions and turned-off mods.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createContext } = require('../src/core/context');
const { Instances } = require('../src/core/instances');
const { createSources } = require('../src/core/sources');
const { ContentManager } = require('../src/core/content/manager');
const { Modpacks } = require('../src/core/content/modpacks');
const { PackLink, planLabels, comparePacks, fileStem, additionsCoveredBy } = require('../src/core/content/packlink');
const { tmpDir, fabricJar } = require('./helpers');

const mock = require('../tools/mock-network');

async function setup() {
  const ctx = await createContext(tmpDir(), { fetchImpl: mock });
  const instances = new Instances(ctx);
  const sources = createSources(ctx);
  const content = new ContentManager(ctx, instances, sources);
  const modpacks = new Modpacks(ctx, instances, content, sources);
  const packs = new PackLink(ctx, instances, content, modpacks, sources);
  const r = await modpacks.installFromSource({ source: 'modrinth', projectId: 'LANTERN', versionId: 'lan419' });
  await packs.label(r.instance.id); // what the install handler in main.js does
  return { ctx, instances, content, modpacks, packs, id: r.instance.id, gd: instances.gameDir(r.instance.id) };
}

/** Every file under a folder with its hash and modification time. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = `${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')}@${fs.statSync(p).mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

/** Makes an instance look like one installed before Junction kept pack labels. */
function forgetLabels(instances, id) {
  const f = path.join(instances.instDir(id), 'content.json');
  const idx = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const e of Object.values(idx.files)) { delete e.fromPack; delete e.packFile; delete e.packChanged; }
  delete idx.packLabels;
  fs.writeFileSync(f, JSON.stringify(idx));
}

// ------------------------------------------------------------------ pure parts
test('planLabels: same hash anywhere is pack content; same path / project / name with another hash is "changed"; the rest is yours', () => {
  const manifest = { files: [
    { rel: 'mods/a-1.0.jar', type: 'mod', sha1: 'aaa', source: 'modrinth', projectId: 'A' },
    { rel: 'mods/b-1.0.jar', type: 'mod', sha1: 'bbb', source: 'modrinth', projectId: 'B' },
    { rel: 'mods/c-1.0.jar', type: 'mod', sha1: 'ccc' },
    { rel: 'mods/d-2.0.jar', type: 'mod', sha1: 'ddd', source: 'modrinth', projectId: 'D' },
    { rel: 'resourcepacks/ui.zip', type: 'resourcepack', sha1: 'eee', override: true },
  ] };
  const entries = {
    'mods/renamed.jar': { sha1: 'aaa' }, // the pack's file under another name
    'mods/b-1.0.jar': { sha1: 'zzz' }, // same path, different file
    'mods/c-1.1.jar': { sha1: 'yyy' }, // same name without the version
    'mods/d-3.0.jar': { sha1: 'xxx', source: 'modrinth', projectId: 'D' }, // same project, other version
    'mods/mine.jar': { sha1: 'mmm' },
    'resourcepacks/ui.zip': { sha1: 'eee' },
    'config/x.toml': { sha1: 'q' }, // not content: never labelled
  };
  const plan = planLabels(entries, manifest);
  assert.deepEqual(Object.keys(plan.labels).sort(), ['mods/b-1.0.jar', 'mods/c-1.1.jar', 'mods/d-3.0.jar', 'mods/renamed.jar', 'resourcepacks/ui.zip']);
  assert.equal(plan.labels['mods/renamed.jar'].packChanged, false);
  assert.equal(plan.labels['resourcepacks/ui.zip'].packChanged, false);
  for (const rel of ['mods/b-1.0.jar', 'mods/c-1.1.jar', 'mods/d-3.0.jar']) assert.equal(plan.labels[rel].packChanged, true, rel);
  assert.equal(plan.labels['mods/d-3.0.jar'].packFile.rel, 'mods/d-2.0.jar', 'restore knows the pack file');
  assert.deepEqual(plan.notPack, ['mods/mine.jar']);
  assert.equal(plan.missing.length, 0);
});

test('fileStem strips versions so files match across pack versions', () => {
  assert.equal(fileStem('mods/sodium-fabric-0.5.13+mc1.20.1.jar'), fileStem('mods/sodium-fabric-0.6.0+mc1.21.jar'));
  assert.equal(fileStem('mods/create-1.20.1-0.5.1.f.jar'), 'mods/create');
  assert.notEqual(fileStem('mods/create-addon-1.0.jar'), fileStem('mods/create-1.0.jar'));
});

test('comparePacks: mods added, removed and updated, and config files', () => {
  const from = { files: [
    { rel: 'mods/sodium-0.6.0.jar', type: 'mod', sha1: 's1', source: 'modrinth', projectId: 'S' },
    { rel: 'mods/old-1.0.jar', type: 'mod', sha1: 'o1', source: 'modrinth', projectId: 'O' },
    { rel: 'mods/same-1.0.jar', type: 'mod', sha1: 'x1', source: 'modrinth', projectId: 'X' },
    { rel: 'mods/extras-1.0.jar', type: 'mod', sha1: 'e1', override: true },
  ], config: [{ rel: 'config/a.toml', sha1: '1' }, { rel: 'config/b.toml', sha1: '2' }, { rel: 'config/gone.toml', sha1: '3' }] };
  const to = { files: [
    { rel: 'mods/sodium-0.6.1.jar', type: 'mod', sha1: 's2', source: 'modrinth', projectId: 'S' },
    { rel: 'mods/same-1.0.jar', type: 'mod', sha1: 'x1', source: 'modrinth', projectId: 'X' },
    { rel: 'mods/new-2.0.jar', type: 'mod', sha1: 'n1', source: 'modrinth', projectId: 'N' },
    { rel: 'mods/extras-1.1.jar', type: 'mod', sha1: 'e2', override: true },
  ], config: [{ rel: 'config/a.toml', sha1: '1' }, { rel: 'config/b.toml', sha1: '9' }, { rel: 'config/new.toml', sha1: '4' }] };
  const d = comparePacks(from, to);
  assert.deepEqual(d.updated.map((r) => r.rel).sort(), ['mods/extras-1.1.jar', 'mods/sodium-0.6.1.jar']);
  assert.deepEqual(d.added.map((r) => r.rel), ['mods/new-2.0.jar']);
  assert.deepEqual(d.removed.map((r) => r.rel), ['mods/old-1.0.jar']);
  assert.equal(d.unchanged, 1);
  assert.deepEqual(d.config, { added: ['config/new.toml'], removed: ['config/gone.toml'], changed: ['config/b.toml'] });
});

test('additionsCoveredBy finds your own copy of a mod the pack now ships (project, mod id or name)', () => {
  const manifest = { files: [{ rel: 'mods/dh-2.3.jar', type: 'mod', source: 'modrinth', projectId: 'DH' }, { rel: 'mods/zoomy-1.0.jar', type: 'mod' }] };
  const entries = {
    'mods/distant.jar': { source: 'modrinth', projectId: 'DH' },
    'mods/zoomy-0.9.jar': {},
    'mods/byid.jar': { meta: { modId: 'cool' } },
    'mods/other.jar': {},
    'mods/dh-2.3.jar': { fromPack: true },
  };
  assert.deepEqual(additionsCoveredBy(entries, manifest, new Set(['cool'])).sort(), ['mods/byid.jar', 'mods/distant.jar', 'mods/zoomy-0.9.jar']);
});

// ------------------------------------------------------------------ on a real instance (mock network)
test('labels are worked out once for an old install by hash, and labelling never moves, changes or deletes a file', async () => {
  const { instances, packs, id, gd } = await setup();
  forgetLabels(instances, id);
  fs.writeFileSync(path.join(gd, 'mods', 'mousetweaks-3.1.jar'), fabricJar('mousetweaks', 'Mouse Tweaks', '3.1'));
  fs.writeFileSync(path.join(gd, 'mods', 'lithium-0.13.1.jar'), fabricJar('lithium', 'Lithium', '0.13.2-custom')); // replaced by hand
  fs.renameSync(path.join(gd, 'mods', 'iris-1.8.0.jar'), path.join(gd, 'mods', 'iris-renamed.jar')); // same file, other name
  // Cached hashes in content.json are filled in first (that's a content.json write, not a file change).
  for (const t of ['mod', 'resourcepack', 'shader', 'datapack']) await instances.listContent(id, t);
  assert.equal(await packs.needsLabels(id), true);
  const before = snapshot(gd);
  const r = await packs.label(id);
  assert.deepEqual(snapshot(gd), before, 'no file was moved, changed or deleted');
  assert.equal(await packs.needsLabels(id), false);
  assert.equal(r.changed, 1);
  const mods = await instances.listContent(id, 'mod');
  const by = (prefix) => mods.find((m) => m.fileName.startsWith(prefix));
  assert.equal(by('mousetweaks').fromPack, false, 'your addition');
  assert.equal(by('lithium').fromPack, true);
  assert.equal(by('lithium').packChanged, true, 'a different file than the pack ships');
  assert.equal(by('iris-renamed').fromPack, true, 'matched by hash, not by name');
  assert.equal(by('iris-renamed').packChanged, false);
  assert.equal(by('lantern-core').fromPack, true, 'files from overrides count as pack content');
  assert.equal((await instances.listContent(id, 'datapack'))[0].fromPack, true, 'data packs too');
  assert.equal((await instances.listContent(id, 'resourcepack'))[0].fromPack, true);
});

test('locked pack files: no updates, no second copy, Update all covers only your additions', async () => {
  const { instances, content, id } = await setup();
  const locked = await content.lockedRels(id);
  assert.ok(locked.includes('mods/sodium-0.6.0.jar'));
  // The mock offers a newer version for every Modrinth file: none of the pack's own may show up.
  const ups = await content.checkUpdates(id);
  assert.equal(ups.filter((u) => !u.error).length, 0, 'pack files are left out of Check for updates');
  // Installing a mod the pack already has: "already included", no second copy.
  const r = await content.installProject(id, { source: 'modrinth', id: 'AANobbMI' }, 'mod');
  assert.equal(r.installed.length, 0);
  assert.equal(r.skipped[0].reason, 'already included in the modpack');
  assert.equal((await instances.listContent(id, 'mod')).filter((m) => m.title === 'Sodium').length, 1);
  // Update all refuses a pack file even if one is sent.
  const out = await content.applyUpdates(id, [{ file: 'mods/sodium-0.6.0.jar', title: 'Sodium', type: 'mod', version: { id: 'x', projectId: 'AANobbMI', files: [] } }]);
  assert.equal(out.installed.length, 0);
  assert.match(out.warnings[0], /part of the modpack/);
  // Your own mod is still a normal mod.
  const mine = await content.installProject(id, { source: 'modrinth', id: 'uCdwusMi' }, 'mod');
  assert.equal(mine.installed.length, 1);
  assert.equal((await content.lockedRels(id, [mine.installed[0].file])).length, 0);
  assert.ok((await content.checkUpdates(id)).some((u) => u.file === mine.installed[0].file), 'your additions are still checked');
});

test('pack update review: mods updated / added / removed, config files, additions the pack now includes', async () => {
  const { instances, packs, id, gd } = await setup();
  fs.writeFileSync(path.join(gd, 'mods', 'distanthorizons-2.2.1.jar'), fabricJar('distanthorizons', 'Distant Horizons', '2.2.1'));
  fs.writeFileSync(path.join(gd, 'mods', 'mousetweaks-3.1.jar'), fabricJar('mousetweaks', 'Mouse Tweaks', '3.1'));
  await packs.label(id);
  await new ContentManager(packs.ctx, instances, packs.sources).setEnabled(id, 'mods/zoomify-2.14.jar', false);
  const p = await packs.preview(id, 'lan420');
  assert.equal(p.to.versionName, '4.2.0');
  assert.deepEqual(p.updated.filter((r) => r.type === 'mod').map((r) => [r.title, r.fromVersionName, r.toVersionName]), [['Sodium', '0.6.0', '0.6.1']]);
  assert.deepEqual(p.added.map((r) => r.title).sort(), ['Better Caves', 'Distant Horizons']);
  assert.deepEqual(p.removed.map((r) => r.title), ['Old Tweaks']);
  assert.deepEqual(p.config, { added: ['config/bettercaves.toml'], removed: ['config/oldtweaks.json'], changed: ['config/lantern.toml'] });
  assert.deepEqual(p.covered.map((c) => c.rel), ['mods/distanthorizons-2.2.1.jar']);
  assert.equal(p.keptAdditions, 1);
  assert.deepEqual(p.keptDisabled, ['Zoomify']);
});

test('pack update keeps your additions and turned-off mods, replaces your copy of a mod the pack now ships, and can be undone', async () => {
  const { instances, content, packs, id, gd } = await setup();
  fs.writeFileSync(path.join(gd, 'mods', 'distanthorizons-2.2.1.jar'), fabricJar('distanthorizons', 'Distant Horizons', '2.2.1'));
  fs.writeFileSync(path.join(gd, 'mods', 'mousetweaks-3.1.jar'), fabricJar('mousetweaks', 'Mouse Tweaks', '3.1'));
  fs.writeFileSync(path.join(gd, 'saves.txt'), 'my world');
  await content.setEnabled(id, 'mods/zoomify-2.14.jar', false);
  const before = snapshot(gd);
  const r = await packs.applyVersion(id, 'lan420');
  assert.equal((await instances.get(id)).pack.versionName, '4.2.0');
  const mods = fs.readdirSync(path.join(gd, 'mods')).sort();
  assert.ok(mods.includes('sodium-0.6.1.jar') && !mods.includes('sodium-0.6.0.jar'), 'pack mod updated');
  assert.ok(!mods.includes('oldtweaks-2.2.jar'), 'removed from the pack');
  assert.ok(mods.includes('mousetweaks-3.1.jar'), 'your addition stays');
  assert.ok(mods.includes('zoomify-2.14.jar.disabled') && !mods.includes('zoomify-2.14.jar'), 'turned off stays off');
  assert.ok(mods.includes('distanthorizons-2.3.0.jar') && !mods.includes('distanthorizons-2.2.1.jar'), "the pack's copy replaces yours");
  assert.deepEqual(r.removedCovered, ['Distant Horizons']);
  assert.equal(fs.readFileSync(path.join(gd, 'saves.txt'), 'utf8'), 'my world');
  const list = await instances.listContent(id, 'mod');
  assert.equal(list.find((m) => m.fileName === 'mousetweaks-3.1.jar').fromPack, false);
  assert.equal(list.find((m) => m.fileName === 'distanthorizons-2.3.0.jar').fromPack, true);
  // Undo: exactly the files from before.
  const [last] = await packs.history(id);
  assert.equal(last.to, '4.2.0');
  await packs.undo(id, last.stamp);
  assert.equal((await instances.get(id)).pack.versionName, '4.1.9');
  const after = snapshot(gd);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const k of Object.keys(before)) assert.equal(after[k].split('@')[0], before[k].split('@')[0], k);
});

test('reinstall can drop your additions; Restore pack version puts the pack file back', async () => {
  const { packs, id, gd } = await setup();
  fs.writeFileSync(path.join(gd, 'mods', 'mousetweaks-3.1.jar'), fabricJar('mousetweaks', 'Mouse Tweaks', '3.1'));
  fs.writeFileSync(path.join(gd, 'mods', 'lithium-0.13.1.jar'), fabricJar('lithium', 'Lithium', 'custom'));
  fs.writeFileSync(path.join(gd, 'resourcepacks', 'lantern-ui.zip'), 'my own edit');
  await packs.label(id);
  await packs.restoreFile(id, 'mods/lithium-0.13.1.jar');
  await packs.restoreFile(id, 'resourcepacks/lantern-ui.zip'); // an override: comes from the pack archive
  assert.equal(fs.readFileSync(path.join(gd, 'resourcepacks', 'lantern-ui.zip'), 'utf8'), 'lantern ui v1');
  const r = await packs.label(id);
  assert.equal(r.changed, 0);
  await packs.applyVersion(id, 'lan419', { action: 'reinstall', keepAdditions: false, keepDisabled: false });
  assert.ok(!fs.existsSync(path.join(gd, 'mods', 'mousetweaks-3.1.jar')));
  assert.ok(fs.existsSync(path.join(gd, 'mods', 'sodium-0.6.0.jar')));
});

test('review: files without a version show their real names, and changed pack files are said to be replaced', async () => {
  const { packs, id, gd } = await setup();
  fs.writeFileSync(path.join(gd, 'mods', 'lithium-0.13.1.jar'), fabricJar('lithium', 'Lithium', 'custom'));
  await packs.label(id);
  const p = await packs.preview(id, 'lan420');
  const ui = p.updated.find((r) => r.type === 'resourcepack');
  assert.equal(ui.toVersionName, 'lantern-ui.zip');
  assert.equal(ui.sameName, true);
  assert.ok(!p.updated.some((r) => /old file|new file/.test(`${r.fromVersionName} ${r.toVersionName}`)));
  assert.deepEqual(p.replacedChanged.map((c) => [c.title, c.replaced]), [['Lithium', true]]);
});

test('Side for CurseForge mods: one bulk Modrinth hash lookup, misses remembered', async () => {
  const { makeCtx } = require('./helpers');
  const hits = { files: 0, projects: 0 };
  const ctx = await makeCtx([
    ['POST', /\/v2\/version_files$/, () => { hits.files++; return { json: { aaa: { id: 'v1', project_id: 'P1', version_number: '1', files: [], dependencies: [] } } }; }],
    ['GET', /\/v2\/projects\?ids=/, () => { hits.projects++; return { json: [{ id: 'P1', slug: 'p1', title: 'P1', project_type: 'mod', client_side: 'required', server_side: 'unsupported' }] }; }],
  ]);
  const instances = new Instances(ctx);
  const content = new ContentManager(ctx, instances, createSources(ctx));
  const inst = await instances.create({ name: 'CF', mcVersion: '1.20.1', loader: { type: 'forge', version: '47.2.0' } });
  await instances.withIndex(inst.id, (idx) => {
    idx.files['mods/a.jar'] = { source: 'curseforge', projectId: 11, sha1: 'aaa' };
    idx.files['mods/b.jar'] = { source: 'curseforge', projectId: 12, sha1: 'bbb' };
  });
  assert.deepEqual(await content.refreshSides(inst.id), { updated: 1 });
  assert.deepEqual(hits, { files: 1, projects: 1 }, 'one request each, for all files');
  const idx = await instances.readIndex(inst.id);
  assert.deepEqual(idx.files['mods/a.jar'].sides, { client: 'required', server: 'unsupported' });
  assert.ok(idx.files['mods/b.jar'].sidesChecked, 'not on Modrinth: remembered');
  assert.deepEqual(await content.refreshSides(inst.id), { updated: 0 });
  assert.deepEqual(hits, { files: 1, projects: 1 }, 'cached: nothing asked again');
});
