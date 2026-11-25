'use strict';
// One search box for both platforms. Results are interleaved, and a project
// published on both sites is shown once with a badge for each source.
const { Modrinth } = require('./modrinth');
const { CurseForge } = require('./curseforge');
const { matchKey } = require('../util');
const { mergeCategories } = require('./categories');

function createSources(ctx) {
  return { modrinth: new Modrinth(ctx), curseforge: new CurseForge(ctx) };
}

/** Loaders whose mods run on this instance's loader. */
function compatibleLoaders(loader, mc) {
  switch (loader) {
    case 'quilt': return ['quilt', 'fabric'];
    case 'neoforge': return mc === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
    case 'forge': return ['forge'];
    case 'fabric': return ['fabric'];
    default: return [];
  }
}

function enabledSources(ctx, sources) {
  const s = ctx.settings.get('sources') || {};
  const out = [];
  if (s.modrinth !== false) out.push('modrinth');
  if (s.curseforge !== false && sources.curseforge.configured()) out.push('curseforge');
  return out;
}

function interleaveAndMerge(lists, preferred) {
  const merged = [];
  const byKey = new Map();
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      const hit = list[i];
      if (!hit) continue;
      const keys = [matchKey(hit.title), hit.slug && matchKey(hit.slug)].filter(Boolean);
      const existing = keys.map((k) => byKey.get(k)).find((e) => e && e.source !== hit.source && !(e.alsoOn || []).some((a) => a.source === hit.source));
      if (existing) {
        const alt = { source: hit.source, id: hit.id, slug: hit.slug, url: hit.url, downloads: hit.downloads };
        if (hit.source === preferred && existing.source !== preferred) {
          // Swap so the preferred platform is the primary entry.
          const old = { source: existing.source, id: existing.id, slug: existing.slug, url: existing.url, downloads: existing.downloads };
          const keepAlso = existing.alsoOn || [];
          Object.assign(existing, hit, { alsoOn: [...keepAlso, old] });
        } else {
          existing.alsoOn = [...(existing.alsoOn || []), alt];
        }
        existing.totalDownloads = (existing.totalDownloads || 0) + (hit.downloads || 0);
        continue;
      }
      const entry = { ...hit, alsoOn: [], totalDownloads: hit.downloads || 0 };
      merged.push(entry);
      for (const k of keys) if (!byKey.has(k)) byKey.set(k, entry);
    }
  }
  return merged;
}

const categoryCache = new Map(); // kind of project -> { at, list }
const CATEGORY_TTL = 12 * 60 * 60 * 1000;

/** The merged category list for one kind of project (Modrinth + CurseForge, whichever are on). Kept for half a day. */
async function categoriesFor(ctx, sources, type) {
  const kind = ['mod', 'modpack', 'resourcepack', 'shader', 'datapack'].includes(type) ? type : 'mod';
  const on = enabledSources(ctx, sources);
  const key = `${kind}:${on.join('+')}`;
  const hit = categoryCache.get(key);
  if (hit && Date.now() - hit.at < CATEGORY_TTL) return hit.list;
  const got = await Promise.allSettled(on.map((s) => sources[s].categories(kind)));
  const pick = (site) => { const i = on.indexOf(site); return i >= 0 && got[i].status === 'fulfilled' ? got[i].value : []; };
  const list = mergeCategories(pick('modrinth'), pick('curseforge'));
  if (list.length) categoryCache.set(key, { at: Date.now(), list });
  return list;
}

async function searchAll(ctx, sources, params) {
  let wanted = (params.sources && params.sources.length ? params.sources : ['modrinth', 'curseforge'])
    .filter((s) => enabledSources(ctx, sources).includes(s));
  const warnings = [];
  // A category is a name on each site; a site that has no such category can't be searched for it.
  const cat = params.category && typeof params.category === 'object' ? params.category : null;
  if (cat) {
    const missing = wanted.filter((s) => cat[s] === null || cat[s] === undefined);
    if (missing.length && missing.length < wanted.length) {
      warnings.push(`${missing.map((s) => (s === 'modrinth' ? 'Modrinth' : 'CurseForge')).join(' and ')} has no such category, so only ${wanted.filter((s) => !missing.includes(s)).map((s) => (s === 'modrinth' ? 'Modrinth' : 'CurseForge')).join(' and ')} is searched.`);
    }
    if (missing.length < wanted.length) wanted = wanted.filter((s) => !missing.includes(s));
  }
  if ((params.sources || []).includes('curseforge') && !sources.curseforge.configured()) {
    warnings.push('CurseForge is off: add your CurseForge API key in Settings to search it.');
  }
  const settled = await Promise.allSettled(wanted.map((s) => sources[s].search({ ...params, category: cat ? cat[s] : undefined })));
  const lists = [];
  const totals = {};
  settled.forEach((r, i) => {
    const s = wanted[i];
    if (r.status === 'fulfilled') {
      lists.push(r.value.hits);
      totals[s] = r.value.total;
    } else {
      warnings.push(`${s === 'modrinth' ? 'Modrinth' : 'CurseForge'}: ${r.reason?.message || r.reason}`);
    }
  });
  // 'ask' still needs a primary entry to show first: Modrinth.
  const preferred = ctx.settings.get('preferredSource') === 'curseforge' ? 'curseforge' : 'modrinth';
  const hits = interleaveAndMerge(lists, preferred);
  return { hits, totals, warnings, searched: wanted };
}

module.exports = { createSources, searchAll, categoriesFor, compatibleLoaders, interleaveAndMerge, enabledSources };
