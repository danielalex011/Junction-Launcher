'use strict';
// The simulated network for the README screenshots only (tools/screenshots.js). It sits in front of tools/mock-network.js,
// which stays as it is for the tests, ui-check and offline UI work, and changes just what the pictures show:
//   - every mod in the update review gets a believable newer version (not a lower one), mostly releases, one beta;
//   - Home's popular modpacks are made-up packs with real-looking authors and one-line pitches; one is on both sites;
//   - the demo author on "Twin Pack" gets a proper name and pitch.
// Needs JUNCTION_SHOTS_HASHES: the sha1 -> Modrinth project id file that tools/seed-shots.js writes.
const fs = require('fs');
const base = require('./mock-network');

const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();

// ---- update review: versions newer than anything the demo instances have installed, newest first. [number, type, days ago]
const NEWER = {
  AANobbMI: ['sodium', [['0.7.2', 'release', 3]]],
  gvQqBUqZ: ['lithium', [['0.15.1', 'release', 5]]],
  YL57xq9U: ['iris', [['1.9.1', 'release', 4]]],
  uCdwusMi: ['distanthorizons', [['2.3.3-beta.1', 'beta', 1], ['2.3.2', 'release', 6], ['2.3.1', 'release', 19]]],
  OLDTW: ['oldtweaks', [['2.3', 'release', 12]]],
  ZOOMR: ['zoomify', [['2.14.1', 'release', 9]]],
};
const versionsOf = (pid) => NEWER[pid][1].map(([num, type, d]) => ({
  id: `${pid}-${num}`, project_id: pid, name: num, version_number: num, game_versions: ['26.1.2'], loaders: ['fabric'], version_type: type,
  date_published: daysAgo(d), dependencies: [],
  files: [{ url: `https://cdn.modrinth.com/data/${pid}/versions/${num}/${NEWER[pid][0]}-${num}.jar`, filename: `${NEWER[pid][0]}-${num}.jar`, hashes: { sha1: `newer-${pid}-${num}` }, size: 900000, primary: true }],
}));
const newestRelease = (pid) => versionsOf(pid).find((v) => v.version_type === 'release');

let hashMap = null;
const projectOfHash = (h) => {
  if (!hashMap) { try { hashMap = JSON.parse(fs.readFileSync(process.env.JUNCTION_SHOTS_HASHES, 'utf8')); } catch { hashMap = {}; } }
  return hashMap[h];
};

// ---- Home: popular modpacks (Modrinth and CurseForge lists, sorted by downloads; "Twin Pack" is on both)
const TWIN = { author: 'Brightforge', pitch: 'A cosy exploration pack: new biomes, gentle quests and a fresh coat of paint on the vanilla look.' };
const mrPack = (id, slug, title, author, desc, dl, cats) => ({
  project_id: id, slug, title, author, description: desc, downloads: dl, follows: Math.round(dl / 300), icon_url: null,
  date_modified: daysAgo(4), project_type: 'modpack', display_categories: cats, versions: ['26.1.2'],
});
const cfPack = (id, slug, name, author, summary, dl, cats) => ({
  id, slug, name, summary, authors: [{ name: author }], downloadCount: dl, classId: 4471, dateModified: daysAgo(6),
  links: { websiteUrl: `https://www.curseforge.com/minecraft/modpacks/${slug}` }, categories: cats.map((n) => ({ name: n })),
  latestFilesIndexes: [{ gameVersion: '26.1.2', fileId: id, modLoader: 4 }],
});
const POPULAR_MR = [
  mrPack('HOLLOW', 'hollowmere-chronicles', 'Hollowmere Chronicles', 'Kestrelworks', 'Hand-crafted adventure through haunted fens, with quests and tough bosses.', 4800000, ['adventure']),
  mrPack('TWIN', 'twin-pack', 'Twin Pack', TWIN.author, TWIN.pitch, 1200000, ['adventure']),
  mrPack('DRIFT', 'driftwood-skies', 'Driftwood Skies', 'SaltmarshStudio', 'Island-hopping survival with sea monsters, boats and cosy bases.', 910000, ['adventure', 'survival']),
  mrPack('QUILL', 'quarry-and-quill', 'Quarry & Quill', 'tinkerlily', 'Light tech and farming for relaxed, long-running worlds.', 640000, ['technology']),
  mrPack('COPPER', 'copperleaf-plus', 'Copperleaf Vanilla+', 'mossbyte', 'Vanilla, only better: a handful of polish mods and nothing more.', 330000, ['lightweight']),
];
const POPULAR_CF = [
  cfPack(880001, 'obsidian-reach', 'Obsidian Reach', 'VantablackTeam', 'Hardcore exploration and dungeon crawling in a harsher world.', 9600000, ['Adventure and RPG']),
  { ...cfPack(777001, 'twin-pack', 'Twin Pack', TWIN.author, TWIN.pitch, 3400000, ['Adventure and RPG']), latestFilesIndexes: [{ gameVersion: '26.2', fileId: 5, modLoader: 6 }] },
  cfPack(880003, 'stargazers-vale', "Stargazer's Vale", 'luna_fox', 'Magic, astronomy and relaxed building in a starlit valley.', 1900000, ['Magic']),
  cfPack(880004, 'gearhaven', 'Gearhaven', 'cogsmith', 'A big tech tree with factories, trains and automation.', 780000, ['Tech']),
];

/** Search text from a URL (or none) against a title, like a real search box would. */
const matches = (title, q) => !q || title.toLowerCase().includes(decodeURIComponent(q).replace(/\+/g, ' ').toLowerCase());

/** The same response with the demo author and pitch of "Twin Pack" replaced. */
async function retouched(res) {
  const text = (await res.text())
    .split('"author":"demo"').join(`"author":"${TWIN.author}"`)
    .split('"name":"demo"').join(`"name":"${TWIN.author}"`)
    .split('The same pack on both sites. Click Install to try the \\"Install from…\\" window.').join(TWIN.pitch)
    .split('The same pack on both sites.').join(TWIN.pitch);
  return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
}

module.exports = async (url, opts = {}) => {
  // Update review: the newest release for every file we know, and the list of newer versions behind each dropdown.
  if (url.endsWith('/v2/version_files/update') && opts.body) {
    const out = {};
    for (const hash of JSON.parse(opts.body).hashes) {
      const pid = projectOfHash(hash);
      if (pid && NEWER[pid]) out[hash] = newestRelease(pid);
    }
    return json(out);
  }
  const pv = url.match(/^https:\/\/api\.modrinth\.com\/v2\/project\/([^/?]+)\/version/);
  if (pv && NEWER[decodeURIComponent(pv[1])]) return json(versionsOf(decodeURIComponent(pv[1])));

  // Modpack lists: Home's popular row has no search text; Browse's "twin" search keeps the mock's answer, retouched.
  if (url.startsWith('https://api.modrinth.com/v2/search') && url.includes('project_type%3Amodpack')) {
    const hits = POPULAR_MR.filter((p) => matches(p.title, url.match(/[?&]query=([^&]*)/)?.[1]));
    return json({ total_hits: hits.length, hits });
  }
  if (url.startsWith('https://api.curseforge.com/v1/mods/search') && url.includes('classId=4471')) {
    const data = POPULAR_CF.filter((p) => matches(p.name, url.match(/[?&]searchFilter=([^&]*)/)?.[1]));
    return json({ pagination: { totalCount: data.length }, data });
  }
  if (/api\.modrinth\.com\/v2\/project\/TWIN$|api\.curseforge\.com\/v1\/mods\/777001(\/description)?$/.test(url)) return retouched(await base(url, opts));
  return base(url, opts);
};
