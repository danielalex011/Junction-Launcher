'use strict';
// Fake network for offline UI work and screenshots. Load it with:
//   JUNCTION_FETCH_MOCK=<absolute path to this file> npm start
// Serves a small Mojang version list, Fabric loader versions, and canned
// Modrinth/CurseForge search results and versions. Everything else returns 503.
const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();

const mr = (id, slug, title, author, desc, dl, cats) => ({
  project_id: id, slug, title, author, description: desc, downloads: dl, follows: dl / 300, icon_url: null,
  date_modified: daysAgo(3), project_type: 'mod', display_categories: cats, versions: ['26.1.2'],
});
const cf = (id, slug, name, author, summary, dl, cats) => ({
  id, slug, name, summary, authors: [{ name: author }], downloadCount: dl, classId: 6, dateModified: daysAgo(5),
  links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/${slug}` }, categories: cats.map((n) => ({ name: n })),
  latestFilesIndexes: [{ gameVersion: '26.1.2', fileId: 1, modLoader: 4 }],
});
const versions = (pid) => [['5', '0.9.6-beta.4', 'beta', 2], ['4', '0.9.5', 'release', 9], ['3', '0.9.4', 'release', 20], ['2', '0.9.3-alpha.2', 'alpha', 30]]
  .map(([n, num, type, d]) => ({
    id: `${pid}-${n}`, project_id: pid, name: num, version_number: num, game_versions: ['26.1.2'], loaders: ['fabric'], version_type: type,
    date_published: daysAgo(d), files: [{ url: 'https://cdn.modrinth.com/x.jar', filename: 'x.jar', hashes: {}, size: 1, primary: true }], dependencies: [],
  }));

module.exports = async (url) => {
  const mv = url.match(/api\.modrinth\.com\/v2\/project\/([^/]+)\/version/);
  if (mv) return json(versions(decodeURIComponent(mv[1])));
  if (url.includes('version_manifest')) {
    return json({ versions: ['26.2', '26.1.2', '26.1.1', '26.1', '1.21.11', '1.21.1', '1.20.1'].map((id) => ({ id, type: 'release', url: 'x', sha1: 'y' })) });
  }
  if (url.includes('meta.fabricmc.net/v2/versions/loader/')) {
    return json([{ loader: { version: '0.17.3', stable: true } }, { loader: { version: '0.17.2', stable: true } }, { loader: { version: '0.18.0-beta.1', stable: false } }]);
  }
  if (url.startsWith('https://api.modrinth.com/v2/search')) {
    return json({ total_hits: 4, hits: [
      mr('AANobbMI', 'sodium', 'Sodium', 'jellysquid3', 'Rendering optimization mod.', 98e6, ['optimization']),
      mr('gvQqBUqZ', 'lithium', 'Lithium', 'jellysquid3', 'Game logic optimization mod.', 61e6, ['optimization']),
      mr('YL57xq9U', 'iris', 'Iris Shaders', 'coderbot', 'Shader pack loader.', 70e6, ['decoration']),
      mr('uCdwusMi', 'distanthorizons', 'Distant Horizons', 'jeseibel', 'See farther.', 12e6, ['optimization']),
    ] });
  }
  if (url.startsWith('https://api.curseforge.com/v1/mods/search')) {
    return json({ pagination: { totalCount: 3 }, data: [
      cf(394468, 'sodium', 'Sodium', 'jellysquid3_', 'Rendering engine.', 41e6, ['Performance']),
      cf(238222, 'jei', 'Just Enough Items (JEI)', 'mezz', 'View items and recipes.', 380e6, ['API and Library']),
      cf(263420, 'xaeros-minimap', "Xaero's Minimap", 'xaero96', 'Minimap.', 120e6, ['Map and Information']),
    ] });
  }
  return new Response('offline (mock network)', { status: 503 });
};
