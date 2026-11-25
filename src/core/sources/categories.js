'use strict';
// Categories for the Browse page. Modrinth and CurseForge each have their own list per kind of project, with different names
// ("Adventure" / "Adventure and RPG", "Optimization" / "Performance"). This turns the two lists into one: a category that exists
// on both sites is one entry that searches both; one that exists on a single site says so and only searches that site.
// Plain Node, no Electron.

/** Different names for the same thing, after lower-casing and dropping everything but letters and digits. Left is the shared key. */
const SAME = {
  adventureandrpg: 'adventure',
  apiandlibrary: 'library',
  worldgen: 'worldgeneration', // Modrinth "worldgen" is shown as "World generation"; CurseForge says "World Gen"
  tech: 'technology',
  performance: 'optimization',
  utilityqol: 'utility',
  armortoolsandweapons: 'equipment',
  smalllight: 'lightweight',
  combatpvp: 'combat',
  extralarge: 'kitchensink',
  photorealistic: 'realistic',
  vanilla: 'vanillalike',
  fontpacks: 'fonts',
  '512xandhigher': '512xorhigher',
};

/** What people read for a Modrinth category slug (their slugs are lower-case with dashes). */
const NICE = {
  worldgen: 'World generation', 'game-mechanics': 'Game mechanics', 'kitchen-sink': 'Kitchen sink', 'core-shaders': 'Core shaders',
  '8x-': '8x or lower', '512x+': '512x or higher', pbr: 'PBR', 'colored-lighting': 'Coloured lighting', 'path-tracing': 'Path tracing',
  'semi-realistic': 'Semi-realistic', 'vanilla-like': 'Vanilla-like', locale: 'Languages', gui: 'Menus (GUI)', high: 'High-end PCs', medium: 'Mid-range PCs', low: 'Low-end PCs', potato: 'Potato PCs',
  fonts: 'Fonts', models: 'Models', quests: 'Quests', challenging: 'Challenging',
};

function niceName(slug) {
  if (NICE[slug]) return NICE[slug];
  const s = String(slug).replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function keyOf(label) {
  const k = String(label).toLowerCase().replace(/[^a-z0-9]/g, '');
  return SAME[k] || k;
}

/**
 * @param {Array<{ id: string|number, label: string }>} modrinth  categories of Modrinth (id = slug)
 * @param {Array<{ id: string|number, label: string }>} curseforge categories of CurseForge (id = number)
 * @returns {Array<{ key: string, label: string, modrinth: string|null, curseforge: number|null }>} sorted by name
 */
function mergeCategories(modrinth = [], curseforge = []) {
  const map = new Map();
  const put = (site, c) => {
    const key = keyOf(c.label);
    if (!key) return;
    let e = map.get(key);
    if (!e) { e = { key, label: c.label, modrinth: null, curseforge: null }; map.set(key, e); }
    if (site === 'modrinth') { e.modrinth = String(c.id); e.label = c.label; } else e.curseforge = Number(c.id); // Modrinth's wording wins when both have it
  };
  for (const c of modrinth) put('modrinth', c);
  for (const c of curseforge) put('curseforge', c);
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/** The sites a merged category covers, for a note next to it in the list. */
function coverage(cat) {
  const out = [];
  if (cat.modrinth) out.push('modrinth');
  if (cat.curseforge) out.push('curseforge');
  return out;
}

module.exports = { mergeCategories, coverage, niceName, keyOf };
