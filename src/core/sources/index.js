'use strict';
// One search box for both platforms. Results are interleaved, and a project
// published on both sites is shown once with a badge for each source.
const { Modrinth } = require('./modrinth');
const { CurseForge } = require('./curseforge');
const { matchKey } = require('../util');

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

async function searchAll(ctx, sources, params) {
  const wanted = (params.sources && params.sources.length ? params.sources : ['modrinth', 'curseforge'])
    .filter((s) => enabledSources(ctx, sources).includes(s));
  const warnings = [];
  if ((params.sources || []).includes('curseforge') && !sources.curseforge.configured()) {
    warnings.push('CurseForge is off: add your CurseForge API key in Settings to search it.');
  }
  const settled = await Promise.allSettled(wanted.map((s) => sources[s].search(params)));
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

module.exports = { createSources, searchAll, compatibleLoaders, interleaveAndMerge, enabledSources };
