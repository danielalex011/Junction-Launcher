'use strict';
// CurseForge API v1 client. Needs an API key (CurseForge for Studios console),
// which is also sent on CDN downloads.
const GAME_ID = 432;
const CLASS = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552 };
const CLASS_REV = { 6: 'mod', 4471: 'modpack', 12: 'resourcepack', 6552: 'shader' };
const LOADER_TYPE = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const LOADER_NAMES = { forge: 'forge', fabric: 'fabric', quilt: 'quilt', neoforge: 'neoforge' };
const RELEASE = { 1: 'release', 2: 'beta', 3: 'alpha' };
const RELATION = { 1: 'embedded', 2: 'optional', 3: 'required', 4: 'tool', 5: 'incompatible', 6: 'include' };

const enc = encodeURIComponent;

function isMcVersion(s) { return /^\d+\.\d+(\.\d+)?(-snapshot.*)?$/.test(s); }

function normalizeMod(m) {
  const idx = m.latestFilesIndexes || [];
  return {
    source: 'curseforge',
    id: m.id,
    slug: m.slug,
    title: m.name,
    summary: m.summary,
    author: m.authors?.[0]?.name || '',
    downloads: m.downloadCount,
    icon: m.logo?.thumbnailUrl || m.logo?.url || null,
    updated: m.dateModified,
    type: CLASS_REV[m.classId] || 'mod',
    classId: m.classId,
    url: m.links?.websiteUrl || `https://www.curseforge.com/minecraft/search?search=${enc(m.slug)}`,
    categories: (m.categories || []).map((c) => c.name),
    gameVersions: [...new Set(idx.map((i) => i.gameVersion).filter(isMcVersion))],
    allowDistribution: m.allowModDistribution !== false,
    latestFilesIndexes: idx,
    links: { source: m.links?.sourceUrl, issues: m.links?.issuesUrl, wiki: m.links?.wikiUrl },
    gallery: (m.screenshots || []).map((s) => ({ url: s.url, title: s.title })),
  };
}

function normalizeFile(f) {
  const gv = f.gameVersions || [];
  return {
    source: 'curseforge',
    id: f.id,
    projectId: f.modId,
    name: f.displayName,
    versionNumber: f.displayName,
    gameVersions: gv.filter(isMcVersion),
    loaders: gv.map((g) => g.toLowerCase()).filter((g) => LOADER_NAMES[g]),
    releaseType: RELEASE[f.releaseType] || 'release',
    date: f.fileDate,
    downloads: f.downloadCount,
    files: [{
      url: f.downloadUrl || null,
      filename: f.fileName,
      sha1: (f.hashes || []).find((h) => h.algo === 1)?.value,
      size: f.fileLength,
      fingerprint: f.fileFingerprint,
      primary: true,
    }],
    deps: (f.dependencies || []).map((d) => ({ source: 'curseforge', projectId: d.modId, type: RELATION[d.relationType] || 'optional' })),
    serverPackFileId: f.serverPackFileId || null,
  };
}

class CurseForge {
  constructor(ctx) { this.ctx = ctx; }

  get base() { return (this.ctx.settings.get('cfApiBase') || 'https://api.curseforge.com').replace(/\/$/, ''); }

  configured() { return Boolean(this.ctx.settings.get('cfApiKey')); }

  requireKey() {
    if (!this.configured()) {
      const e = new Error('CurseForge needs an API key. Add yours in Settings → CurseForge.');
      e.code = 'NO_CF_KEY';
      throw e;
    }
  }

  async get(pathname) {
    this.requireKey();
    return this.ctx.http.json(`${this.base}${pathname}`, { headers: { Accept: 'application/json' } });
  }

  async post(pathname, json) {
    this.requireKey();
    return this.ctx.http.json(`${this.base}${pathname}`, { method: 'POST', json, headers: { Accept: 'application/json' } });
  }

  async search({ query = '', type = 'mod', gameVersion, loader, sort = 'relevance', page = 0, pageSize = 20 } = {}) {
    const q = [`gameId=${GAME_ID}`, `classId=${CLASS[type] || 6}`, `pageSize=${pageSize}`, `index=${Math.min(page * pageSize, 9999 - pageSize)}`];
    if (query) q.push(`searchFilter=${enc(query)}`);
    if (gameVersion) q.push(`gameVersion=${enc(gameVersion)}`);
    if (loader && LOADER_TYPE[loader] && (type === 'mod' || type === 'modpack')) q.push(`modLoaderType=${LOADER_TYPE[loader]}`);
    const sortField = { downloads: 6, newest: 11, updated: 3, follows: 2 }[sort] || (query ? null : 2);
    if (sortField) q.push(`sortField=${sortField}`, 'sortOrder=desc');
    const r = await this.get(`/v1/mods/search?${q.join('&')}`);
    return { hits: r.data.map(normalizeMod), total: Math.min(r.pagination?.totalCount || 0, 10000) };
  }

  async project(id) {
    const [mod, desc] = await Promise.all([
      this.get(`/v1/mods/${enc(id)}`),
      this.get(`/v1/mods/${enc(id)}/description`).catch(() => ({ data: '' })),
    ]);
    return { ...normalizeMod(mod.data), body: desc.data || '', bodyFormat: 'html' };
  }

  async mods(ids) {
    if (!ids.length) return [];
    const out = [];
    for (let i = 0; i < ids.length; i += 500) {
      const r = await this.post('/v1/mods', { modIds: ids.slice(i, i + 500).map(Number), filterPcOnly: true });
      out.push(...r.data.map(normalizeMod));
    }
    return out;
  }

  async versions(modId, { gameVersion, loaders } = {}) {
    const all = [];
    let index = 0;
    // Page through (most mods have < 200 files for one game version).
    for (let page = 0; page < 6; page++) {
      const q = [`pageSize=50`, `index=${index}`];
      if (gameVersion) q.push(`gameVersion=${enc(gameVersion)}`);
      if (loaders?.length === 1 && LOADER_TYPE[loaders[0]]) q.push(`modLoaderType=${LOADER_TYPE[loaders[0]]}`);
      const r = await this.get(`/v1/mods/${enc(modId)}/files?${q.join('&')}`);
      all.push(...r.data.map(normalizeFile));
      index += r.data.length;
      if (r.data.length < 50 || index >= (r.pagination?.totalCount || 0)) break;
    }
    let out = all;
    if (loaders?.length > 1) out = all.filter((f) => !f.loaders.length || f.loaders.some((l) => loaders.includes(l)));
    return out.sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  async files(fileIds) {
    if (!fileIds.length) return [];
    const out = [];
    for (let i = 0; i < fileIds.length; i += 500) {
      const r = await this.post('/v1/mods/files', { fileIds: fileIds.slice(i, i + 500).map(Number) });
      out.push(...r.data.map(normalizeFile));
    }
    return out;
  }

  /** fingerprint -> { projectId, version } */
  async byFingerprint(fingerprints) {
    if (!fingerprints.length) return {};
    const out = {};
    for (let i = 0; i < fingerprints.length; i += 500) {
      const r = await this.post(`/v1/fingerprints/${GAME_ID}`, { fingerprints: fingerprints.slice(i, i + 500) });
      for (const m of r.data?.exactMatches || []) {
        const v = normalizeFile(m.file);
        out[m.file.fileFingerprint] = { projectId: m.id, version: v };
      }
    }
    return out;
  }

  static manualDownloadUrl(project, fileId) {
    const base = project?.url && project.url.includes('curseforge.com') ? project.url.replace(/\/$/, '') : null;
    return base ? `${base}/download/${fileId}` : `https://www.curseforge.com/api/v1/mods/${project?.id}/files/${fileId}/download`;
  }
}

module.exports = { CurseForge, normalizeFile, normalizeMod, CLASS, CLASS_REV, LOADER_TYPE };
