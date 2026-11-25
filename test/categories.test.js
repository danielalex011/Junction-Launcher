'use strict';
// Browse categories: Modrinth's and CurseForge's lists become one, searches pass the right id to each site, and every tab has them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mergeCategories, niceName, keyOf } = require('../src/core/sources/categories');
const { createSources, searchAll, categoriesFor } = require('../src/core/sources');
const { makeCtx } = require('./helpers');

test('the same category with different names on the two sites becomes one entry', () => {
  const list = mergeCategories(
    [{ id: 'adventure', label: 'Adventure' }, { id: 'worldgen', label: niceName('worldgen') }, { id: 'optimization', label: 'Optimization' }, { id: 'cursed', label: 'Cursed' }, { id: '512x+', label: niceName('512x+') }],
    [{ id: 422, label: 'Adventure and RPG' }, { id: 406, label: 'World Gen' }, { id: 6814, label: 'Performance' }, { id: 405, label: 'Miscellaneous' }, { id: 398, label: '512x and Higher' }],
  );
  const by = Object.fromEntries(list.map((c) => [c.key, c]));
  assert.deepEqual([by.adventure.modrinth, by.adventure.curseforge], ['adventure', 422]);
  assert.deepEqual([by.worldgeneration.modrinth, by.worldgeneration.curseforge], ['worldgen', 406]);
  assert.deepEqual([by.optimization.modrinth, by.optimization.curseforge], ['optimization', 6814]);
  assert.equal(by.adventure.label, 'Adventure', "Modrinth's wording is used when both have it");
  assert.deepEqual([by.cursed.modrinth, by.cursed.curseforge], ['cursed', null], 'only on Modrinth');
  assert.deepEqual([by.miscellaneous.modrinth, by.miscellaneous.curseforge], [null, 405], 'only on CurseForge');
  assert.equal(by['512xorhigher'].curseforge, 398);
  assert.deepEqual(list.map((c) => c.label), [...list.map((c) => c.label)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), 'sorted by name');
  assert.equal(keyOf('Utility & QoL'), keyOf('utility'));
  assert.equal(niceName('game-mechanics'), 'Game mechanics');
});

const tagList = [
  { name: 'adventure', project_type: 'mod' }, { name: 'worldgen', project_type: 'mod' }, { name: 'cursed', project_type: 'mod' },
  { name: 'adventure', project_type: 'modpack' }, { name: '16x', project_type: 'resourcepack' }, { name: 'fantasy', project_type: 'shader' }, { name: 'adventure-mode', project_type: 'minecraft_java_server' },
];
const cfCats = (classId) => ({ data: [
  { id: classId, name: 'The class itself', isClass: true },
  { id: 422, name: 'Adventure and RPG', parentCategoryId: classId },
  { id: 406, name: 'World Gen', parentCategoryId: classId },
  { id: 407, name: 'Biomes', parentCategoryId: 406 },
] });

async function world() {
  const ctx = await makeCtx([
    ['GET', 'https://api.modrinth.com/v2/tag/category', () => ({ json: tagList })],
    ['GET', /api\.curseforge\.com\/v1\/categories\?gameId=432&classId=(\d+)/, (u) => ({ json: cfCats(Number(/classId=(\d+)/.exec(u)[1])) })],
    ['GET', /api\.modrinth\.com\/v2\/search/, () => ({ json: { hits: [{ project_id: 'm1', slug: 'xaeros', title: 'Xaeros', description: 'map', author: 'x', downloads: 5, project_type: 'mod', categories: ['adventure'] }], total_hits: 1 } })],
    ['GET', /api\.curseforge\.com\/v1\/mods\/search/, () => ({ json: { data: [{ id: 7, slug: 'waystones', name: 'Waystones', summary: 's', downloadCount: 3, classId: 6, categories: [{ name: 'Adventure and RPG' }], authors: [{ name: 'a' }], links: {}, latestFilesIndexes: [] }], pagination: { totalCount: 1 } } })],
  ], { cfKey: 'cf-test-key' });
  return { ctx, sources: createSources(ctx) };
}

test('each site lists its own categories for a tab: only the right kind, no CurseForge sub-categories', async () => {
  const { sources } = await world();
  assert.deepEqual(await sources.modrinth.categories('mod'), [{ id: 'adventure', label: 'Adventure' }, { id: 'worldgen', label: 'World generation' }, { id: 'cursed', label: 'Cursed' }]);
  assert.deepEqual((await sources.modrinth.categories('datapack')).map((c) => c.id), ['adventure', 'worldgen', 'cursed'], 'data packs use the mod categories on Modrinth');
  assert.deepEqual((await sources.modrinth.categories('modpack')).map((c) => c.id), ['adventure']);
  assert.deepEqual(await sources.curseforge.categories('mod'), [{ id: 422, label: 'Adventure and RPG' }, { id: 406, label: 'World Gen' }]);
});

test('every one of the five tabs gets a merged list, and the list is kept for a while', async () => {
  const { ctx, sources } = await world();
  for (const type of ['mod', 'modpack', 'resourcepack', 'shader', 'datapack']) {
    const list = await categoriesFor(ctx, sources, type);
    assert.ok(list.length > 0, `${type} has categories`);
  }
  const before = ctx.requestLog.length;
  await categoriesFor(ctx, sources, 'mod');
  assert.equal(ctx.requestLog.length, before, 'second ask is from memory');
});

test('a search passes each site its own category, and a site without the category is left out', async () => {
  const { ctx, sources } = await world();
  const r = await searchAll(ctx, sources, { type: 'mod', sort: 'downloads', sources: ['modrinth', 'curseforge'], categories: [{ modrinth: 'adventure', curseforge: 422 }], page: 0, pageSize: 20 });
  const mr = decodeURIComponent(ctx.requestLog.find((x) => /modrinth\.com\/v2\/search/.test(x.url)).url);
  assert.ok(mr.includes('["categories:adventure"]'), mr);
  assert.ok(ctx.requestLog.find((x) => /curseforge\.com\/v1\/mods\/search/.test(x.url)).url.includes('categoryId=422'));
  assert.deepEqual(r.searched.sort(), ['curseforge', 'modrinth']);
  assert.deepEqual(r.warnings, []);
  ctx.requestLog.length = 0;
  const one = await searchAll(ctx, sources, { type: 'mod', sources: ['modrinth', 'curseforge'], categories: [{ modrinth: 'cursed', curseforge: null }], page: 0, pageSize: 20 });
  assert.deepEqual(one.searched, ['modrinth']);
  assert.ok(!ctx.requestLog.some((x) => /curseforge\.com\/v1\/mods\/search/.test(x.url)), 'CurseForge is not asked');
  const none = await searchAll(ctx, sources, { type: 'mod', sources: ['modrinth', 'curseforge'], page: 0, pageSize: 20 });
  assert.ok(!decodeURIComponent(ctx.requestLog.at(-2).url + ctx.requestLog.at(-1).url).includes('categoryId'), 'no category, no filter');
  assert.equal(none.hits.length, 2);
});

test('the Data packs tab searches CurseForge data packs (class 6945), not mods', async () => {
  const { ctx, sources } = await world();
  await sources.curseforge.search({ type: 'datapack', pageSize: 5 });
  assert.match(ctx.requestLog.at(-1).url, /classId=6945/);
});

const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('the Browse page has a filter panel with Loader, Category and Environment sections that remember being collapsed', () => {
  const b = rd('src', 'renderer', 'browse.js');
  assert.match(b, /browse:categories', browseState\.type/);
  for (const w of ["section('loader', 'Loader'", "section('category', 'Category'", "section('env', 'Environment'"]) assert.ok(b.includes(w), w);
  assert.match(b, /localStorage\.getItem\('junction\.browsePanel'\)/);
  assert.match(b, /'aria-expanded': String\(!collapsed\)/, 'the section heads say whether they are open');
  assert.match(b, /browseState\.type = k; browseState\.categories = \[\]; browseState\.environment = '';/, 'a new tab starts without picks');
  assert.match(b, /categories: pickedCats\(\)\.map\(\(c\) => \(\{ modrinth: c\.modrinth, curseforge: c\.curseforge \}\)\)/);
  assert.match(rd('src', 'main', 'main.js'), /handle\('browse:categories'/);
  assert.ok(!/select\(\[\{ value: '', label: 'All categories' \}\]/.test(b), 'the old dropdown is gone');
});

test('category tiles: two columns, multi-select with a checkmark, groups with site dots, first 6 then "+N more", search above 12', () => {
  const b = rd('src', 'renderer', 'browse.js');
  const css = rd('src', 'renderer', 'styles.css');
  assert.match(css, /\.tiles\.two \{[^}]*grid-template-columns: 1fr 1fr/);
  assert.match(b, /'aria-pressed': String\(on\)/);
  assert.match(b, /on \? icon\('check', 13\) : null/, 'selected is not only a colour');
  for (const w of ["'Both sites'", "'Modrinth only'", "'CurseForge only'", 'dots(sites)', 'all.length > 6', '`+${hidden} more`', 'list.length <= 12']) assert.ok(b.includes(w), w);
  assert.match(css, /\.dot\.modrinth \{ background: var\(--mr\)/);
  assert.match(css, /\.dot\.curseforge \{ background: var\(--cf\)/);
});

test('picked filters show as removable chips with Clear all, and a plain note says when a site is hidden', () => {
  const b = rd('src', 'renderer', 'browse.js');
  assert.match(b, /'aria-label': `Remove filter \$\{label\}`/);
  assert.ok(b.includes("'Clear all'"));
  assert.match(b, /results are hidden\./);
  assert.match(b, /can't filter by client or server side/);
  assert.match(b, /No single site has all of these together/);
});

test('the filter panel uses theme variables only (no colour literals) and collapses behind a Filters button on narrow windows', () => {
  const css = rd('src', 'renderer', 'styles.css');
  const block = css.slice(css.indexOf('/* ---------- browse: filter panel'), css.indexOf('@media (max-width: 1100px)'));
  assert.ok(block.length > 500);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block) && !/rgba?\(/.test(block), 'no hardcoded colours');
  assert.match(css, /@media \(max-width: 1100px\) \{[^}]*\.browse-layout \{ grid-template-columns: minmax\(0, 1fr\)[\s\S]*\.filters-toggle \{ display: inline-flex/);
});

test('category icons come from the bundled Lucide set with its licence, and every key has an icon or falls back to the generic one', () => {
  const root = path.join(__dirname, '..', 'src', 'renderer', 'vendor');
  assert.match(fs.readFileSync(path.join(root, 'LICENSE-lucide.txt'), 'utf8'), /ISC License/);
  const src = fs.readFileSync(path.join(root, 'category-icons.js'), 'utf8');
  const icons = new Function(`${src}; return { CATEGORY_ICONS, CATEGORY_ICON_GENERIC };`)();
  assert.ok(Object.keys(icons.CATEGORY_ICONS).length > 50 && icons.CATEGORY_ICON_GENERIC.includes('<'));
  for (const k of ['adventure', 'optimization', 'technology', 'worldgeneration', 'library', 'realistic', 'cursed', '16x']) assert.ok(icons.CATEGORY_ICONS[k], `an icon for ${k}`);
  for (const v of Object.values(icons.CATEGORY_ICONS)) assert.ok(!/<script|on\w+=/i.test(v), 'plain shapes only');
  assert.match(rd('src', 'renderer', 'index.html'), /vendor\/category-icons\.js/);
  assert.match(rd('tools', 'vendor.js'), /LICENSE-lucide\.txt/);
});
