'use strict';
// Modrinth API v2 client, normalised to Junction's shared project/version shape.
const API = 'https://api.modrinth.com/v2';

const enc = encodeURIComponent;

function normalizeHit(h) {
  return {
    source: 'modrinth',
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    summary: h.description,
    author: h.author,
    downloads: h.downloads,
    follows: h.follows,
    icon: h.icon_url || null,
    updated: h.date_modified,
    type: h.project_type,
    url: `https://modrinth.com/${h.project_type}/${h.slug}`,
    categories: h.display_categories || h.categories || [],
    gameVersions: h.versions || [],
    clientSide: h.client_side,
    serverSide: h.server_side,
  };
}

function normalizeProject(p) {
  return {
    source: 'modrinth',
    id: p.id,
    slug: p.slug,
    title: p.title,
    summary: p.description,
    body: p.body || '',
    bodyFormat: 'markdown',
    downloads: p.downloads,
    follows: p.followers,
    icon: p.icon_url || null,
    updated: p.updated,
    type: p.project_type,
    url: `https://modrinth.com/${p.project_type}/${p.slug}`,
    categories: p.categories || [],
    loaders: p.loaders || [],
    gameVersions: p.game_versions || [],
    clientSide: p.client_side,
    serverSide: p.server_side,
    license: p.license?.id,
    links: {
      source: p.source_url, issues: p.issues_url, wiki: p.wiki_url, discord: p.discord_url,
    },
    gallery: (p.gallery || []).map((g) => ({ url: g.url, title: g.title, featured: Boolean(g.featured) })),
    team: p.team || null,
  };
}

function normalizeVersion(v) {
  return {
    source: 'modrinth',
    id: v.id,
    projectId: v.project_id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions || [],
    loaders: v.loaders || [],
    releaseType: v.version_type || 'release',
    date: v.date_published,
    downloads: v.downloads,
    changelog: v.changelog || '',
    files: (v.files || []).map((f) => ({
      url: f.url, filename: f.filename, sha1: f.hashes?.sha1, sha512: f.hashes?.sha512, size: f.size, primary: Boolean(f.primary),
    })),
    deps: (v.dependencies || []).map((d) => ({
      source: 'modrinth', projectId: d.project_id, versionId: d.version_id, type: d.dependency_type, fileName: d.file_name,
    })),
  };
}

class Modrinth {
  constructor(ctx) { this.ctx = ctx; }

  async search({ query = '', type = 'mod', gameVersion, loader, sort = 'relevance', page = 0, pageSize = 20 } = {}) {
    const facets = [[`project_type:${type}`]];
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    if (loader && loader !== 'vanilla' && (type === 'mod' || type === 'modpack')) {
      facets.push(loader === 'quilt' ? ['categories:quilt', 'categories:fabric'] : [`categories:${loader}`]);
    }
    const index = { relevance: 'relevance', downloads: 'downloads', newest: 'newest', updated: 'updated', follows: 'follows' }[sort] || 'relevance';
    const url = `${API}/search?query=${enc(query)}&facets=${enc(JSON.stringify(facets))}&index=${index}&offset=${page * pageSize}&limit=${pageSize}`;
    const r = await this.ctx.http.json(url);
    return { hits: r.hits.map(normalizeHit), total: r.total_hits };
  }

  async project(id) {
    return normalizeProject(await this.ctx.http.json(`${API}/project/${enc(id)}`));
  }

  async projects(ids) {
    if (!ids.length) return [];
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      out.push(...(await this.ctx.http.json(`${API}/projects?ids=${enc(JSON.stringify(chunk))}`)).map(normalizeProject));
    }
    return out;
  }

  /** team id -> owner's user name, for many teams in one request per 100. */
  async teamOwners(teamIds) {
    const out = {};
    for (let i = 0; i < teamIds.length; i += 100) {
      const chunk = teamIds.slice(i, i + 100);
      const teams = await this.ctx.http.json(`${API}/teams?ids=${enc(JSON.stringify(chunk))}`);
      for (const members of teams || []) {
        if (!members?.length) continue;
        const owner = members.find((m) => m.is_owner) || members.find((m) => m.role === 'Owner') || members[0];
        if (owner?.team_id && owner.user?.username) out[owner.team_id] = owner.user.username;
      }
    }
    return out;
  }

  async versions(id, { gameVersion, loaders } = {}) {
    let url = `${API}/project/${enc(id)}/version`;
    const q = [];
    if (loaders?.length) q.push(`loaders=${enc(JSON.stringify(loaders))}`);
    if (gameVersion) q.push(`game_versions=${enc(JSON.stringify([gameVersion]))}`);
    if (q.length) url += `?${q.join('&')}`;
    return (await this.ctx.http.json(url)).map(normalizeVersion);
  }

  async version(versionId) {
    return normalizeVersion(await this.ctx.http.json(`${API}/version/${enc(versionId)}`));
  }

  async versionsById(ids) {
    if (!ids.length) return [];
    return (await this.ctx.http.json(`${API}/versions?ids=${enc(JSON.stringify(ids))}`)).map(normalizeVersion);
  }

  /** hash -> normalized version, for files that exist on Modrinth. algorithm: 'sha1' (default) or 'sha512'. */
  async versionsByHash(sha1s, algorithm = 'sha1') {
    if (!sha1s.length) return {};
    const out = {};
    for (let i = 0; i < sha1s.length; i += 500) {
      const r = await this.ctx.http.json(`${API}/version_files`, { method: 'POST', json: { hashes: sha1s.slice(i, i + 500), algorithm } });
      for (const [h, v] of Object.entries(r)) out[h] = normalizeVersion(v);
    }
    return out;
  }

  /** sha1 -> newest compatible version. */
  async latestByHash(sha1s, { loaders, gameVersions } = {}) {
    if (!sha1s.length) return {};
    const out = {};
    for (let i = 0; i < sha1s.length; i += 500) {
      const body = { hashes: sha1s.slice(i, i + 500), algorithm: 'sha1' };
      if (loaders?.length) body.loaders = loaders;
      if (gameVersions?.length) body.game_versions = gameVersions;
      const r = await this.ctx.http.json(`${API}/version_files/update`, { method: 'POST', json: body });
      for (const [h, v] of Object.entries(r)) out[h] = normalizeVersion(v);
    }
    return out;
  }
}

module.exports = { Modrinth, normalizeVersion, normalizeHit };
