'use strict';
// Fake network for offline UI work and screenshots. Load it with:
//   JUNCTION_FETCH_MOCK=<absolute path to this file> npm start
// Serves a small Mojang version list, Fabric loader versions, and canned
// Modrinth/CurseForge search results and versions. Everything else returns 503.
const { fabricJar } = require('../test/helpers');
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
// One tiny, distinct jar per project, so installs (e.g. "Send to instance") really download and verify.
const jars = new Map();
const jarFor = (pid) => { if (!jars.has(pid)) jars.set(pid, fabricJar(String(pid).toLowerCase(), String(pid), '0.9.5')); return jars.get(pid); };
const SIDES = { AANobbMI: ['required', 'unsupported'], gvQqBUqZ: ['required', 'required'], YL57xq9U: ['required', 'unsupported'], uCdwusMi: ['required', 'optional'] };
const mrProject = (id) => ({
  id, slug: String(id).toLowerCase(), title: { AANobbMI: 'Sodium', gvQqBUqZ: 'Lithium', YL57xq9U: 'Iris Shaders', uCdwusMi: 'Distant Horizons' }[id] || id,
  project_type: 'mod', icon_url: null, client_side: (SIDES[id] || ['required', 'required'])[0], server_side: (SIDES[id] || ['required', 'required'])[1],
});
const versions = (pid) => [['5', '0.9.6-beta.4', 'beta', 2], ['4', '0.9.5', 'release', 9], ['3', '0.9.4', 'release', 20], ['2', '0.9.3-alpha.2', 'alpha', 30]]
  .map(([n, num, type, d]) => ({
    id: `${pid}-${n}`, project_id: pid, name: num, version_number: num, game_versions: ['26.1.2'], loaders: ['fabric'], version_type: type,
    date_published: daysAgo(d), files: [{ url: `https://cdn.modrinth.com/data/${pid}/${n}.jar`, filename: `${String(pid).toLowerCase()}-${num}.jar`, hashes: {}, size: jarFor(pid).length, primary: true }], dependencies: [],
  }));

module.exports = async (url, opts = {}) => {
  // Every Modrinth file hash gets a newer version offered, so update review has something to show.
  if (url.endsWith('/v2/version_files/update') && opts.body) {
    const out = {};
    for (const hash of JSON.parse(opts.body).hashes) out[hash] = { ...versions('AANobbMI')[1], id: `upd-${hash.slice(0, 6)}`, files: [{ ...versions('AANobbMI')[1].files[0], hashes: { sha1: 'newer' } }] };
    return json(out);
  }
  const jar = url.match(/^https:\/\/cdn\.modrinth\.com\/data\/([^/]+)\/\d+\.jar$/);
  if (jar) return new Response(jarFor(decodeURIComponent(jar[1])));
  const mps = url.match(/api\.modrinth\.com\/v2\/projects\?ids=(.+)$/);
  if (mps) return json(JSON.parse(decodeURIComponent(mps[1])).map(mrProject));
  const mp = url.match(/api\.modrinth\.com\/v2\/project\/([^/?]+)$/);
  if (mp) return json(mrProject(decodeURIComponent(mp[1])));
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
