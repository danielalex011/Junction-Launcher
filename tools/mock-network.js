'use strict';
// Fake network for offline UI work and screenshots. Load it with:
//   JUNCTION_FETCH_MOCK=<absolute path to this file> npm start
// Serves a small Mojang version list, Fabric loader versions, and canned
// Modrinth/CurseForge search results and versions. Everything else returns 503.
const crypto = require('crypto');
const AdmZip = require('adm-zip');
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

// ---- "Flaky Pack": a Modrinth modpack (search for "flaky" under Modpacks) whose downloads misbehave,
// to try the retry / repair buttons. a: 503 twice, then fine. b: down for the first 10 requests (a whole
// install, two passes). c: fine. d: 404 once (the CDN hasn't caught up yet), then fine.
const FLAKY = { a: (n) => (n <= 2 ? 503 : 200), b: (n) => (n <= 10 ? 503 : 200), c: () => 200, d: (n) => (n <= 1 ? 404 : 200) };
const flakyHits = {};
const flakyJars = {};
const flakyJar = (k) => { if (!flakyJars[k]) flakyJars[k] = fabricJar(`flaky${k}`, `Flaky ${k.toUpperCase()}`, '1.0'); return flakyJars[k]; };
const sha = (buf, algo) => crypto.createHash(algo).update(buf).digest('hex');
let flakyPackBuf = null;
const flakyPack = () => {
  if (flakyPackBuf) return flakyPackBuf;
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'Flaky Pack', dependencies: { minecraft: '26.1.2', 'fabric-loader': '0.17.3' },
    files: Object.keys(FLAKY).map((k) => ({ path: `mods/flaky-${k}.jar`, hashes: { sha1: sha(flakyJar(k), 'sha1'), sha512: sha(flakyJar(k), 'sha512') }, downloads: [`https://cdn.modrinth.com/data/FLAKY/files/${k}.jar`], fileSize: flakyJar(k).length, env: { client: 'required', server: 'required' } })),
  })));
  zip.addFile('overrides/mods/pack-extras.jar', fabricJar('packextras', 'Pack Extras', '2.0'));
  zip.addFile('overrides/config/flaky.toml', Buffer.from('tuned = true'));
  flakyPackBuf = zip.toBuffer();
  return flakyPackBuf;
};
const flakyVersion = () => ({
  id: 'flaky1', project_id: 'FLAKY', name: 'Flaky Pack 1.0', version_number: '1.0', game_versions: ['26.1.2'], loaders: ['fabric'], version_type: 'release', date_published: daysAgo(4), dependencies: [],
  files: [{ url: 'https://cdn.modrinth.com/data/FLAKY/versions/flaky1/flaky.mrpack', filename: 'flaky.mrpack', hashes: { sha1: sha(flakyPack(), 'sha1'), sha512: sha(flakyPack(), 'sha512') }, size: flakyPack().length, primary: true }],
});
const flakyProject = { id: 'FLAKY', slug: 'flaky-pack', title: 'Flaky Pack', project_type: 'modpack', icon_url: null, description: 'A pack whose download server has a bad day.', downloads: 4200, followers: 12 };
const HTML_503 = '<html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>first byte timeout</center></body></html>';

module.exports = async (url, opts = {}) => {
  const flakyFile = url.startsWith('https://cdn.modrinth.com/data/FLAKY/files/') ? url.slice(-5, -4) : null; // .../files/b.jar -> "b"
  if (flakyFile && FLAKY[flakyFile]) {
    flakyHits[flakyFile] = (flakyHits[flakyFile] || 0) + 1;
    const status = FLAKY[flakyFile](flakyHits[flakyFile]);
    if (status === 503) return new Response(HTML_503, { status, headers: { 'content-type': 'text/html' } });
    if (status === 404) return new Response('<html><body><h1>404 Not Found</h1></body></html>', { status, headers: { 'content-type': 'text/html' } });
    return new Response(flakyJar(flakyFile));
  }
  if (url === 'https://cdn.modrinth.com/data/FLAKY/versions/flaky1/flaky.mrpack') return new Response(flakyPack());
  if (url.startsWith('https://api.modrinth.com/v2/project/FLAKY/version')) return json([flakyVersion()]);
  if (url === 'https://api.modrinth.com/v2/version/flaky1') return json(flakyVersion());
  if (url === 'https://api.modrinth.com/v2/project/FLAKY') return json(flakyProject);
  if (url.endsWith('/v2/version_files') && opts.method === 'POST') return json({}); // nothing in a pack is known by hash
  if (url.startsWith('https://api.modrinth.com/v2/search') && url.includes('project_type%3Amodpack')) {
    return json({ total_hits: 1, hits: [{ ...mr('FLAKY', 'flaky-pack', 'Flaky Pack', 'demo', 'A pack whose download server has a bad day. Try the retry and repair buttons.', 4200, ['adventure']), project_type: 'modpack' }] });
  }
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
