'use strict';
// Which version would Install pick, and how do two sources compare? Pure functions
// (the version lists are passed in), so the "Install from…" window and the real
// install use the same rule and it can be tested without a network.
const { describeError } = require('../http');

const RANK = { release: 0, beta: 1, alpha: 2 };
const SITE = { modrinth: 'Modrinth', curseforge: 'CurseForge' };
const DAY = 864e5;

/** The version Install picks from a (newest-first) list: best release type, then newest. Modpacks: newest release, else newest. */
function pickVersion(list, type) {
  if (!list || !list.length) return null;
  if (type === 'modpack') return list.find((v) => v.releaseType === 'release') || list[0];
  return [...list].sort((a, b) => ((RANK[a.releaseType] ?? 3) - (RANK[b.releaseType] ?? 3)) || (new Date(b.date) - new Date(a.date)))[0];
}

function summarizeVersion(v) {
  const file = v.files?.find((f) => f.primary) || v.files?.[0] || null;
  return {
    id: v.id,
    name: v.name || v.versionNumber,
    versionNumber: v.versionNumber,
    releaseType: v.releaseType,
    date: v.date,
    downloads: v.downloads ?? null,
    size: file?.size ?? null,
    filename: file?.filename || '',
    gameVersions: v.gameVersions || [],
    loaders: v.loaders || [],
    manualDownload: Boolean(file) && !file.url, // CurseForge: the author disabled third-party downloads
  };
}

const list = (a) => (a || []).join(', ');

const numParts = (s) => { const m = /^\d+(?:\.\d+)*/.exec(String(s || '').trim().replace(/^v/i, '')); return m ? m[0].split('.').map(Number) : null; };
const cmpParts = (x, y) => { for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

/** 0 = same version, >0 / <0 = a is newer / older, null = can't tell from the numbers alone. */
function compareVersionNumbers(a, b) {
  const norm = (s) => String(s || '').trim().replace(/^v/i, '').toLowerCase();
  if (!norm(a) || !norm(b)) return null;
  if (norm(a) === norm(b)) return 0;
  const pa = numParts(a); const pb = numParts(b);
  if (!pa || !pb) return null;
  const d = cmpParts(pa, pb);
  // Same numbers but different suffixes (4.1.9 vs 4.1.9-beta): not comparable.
  return d === 0 ? null : d;
}

/** The newest release-style Minecraft version in a list ("1.20.1" of ["1.20.1", "1.20"]); CurseForge tags extra versions, so only this one is compared. */
function newestMc(versions) {
  const vs = (versions || []).map(String);
  const nums = vs.filter((v) => /^\d+(\.\d+)*$/.test(v)).sort((x, y) => cmpParts(numParts(y), numParts(x)));
  return nums[0] || vs.slice().sort().join(',');
}

/** Sets `reason` on options with no version, `newer` on the fresher one, and returns sentences about what differs (only options that have a version are compared). */
function differences(options, { type, mcVersion } = {}) {
  const notes = [];
  for (const o of options) {
    if (o.version) continue;
    const site = SITE[o.source] || o.source;
    if (o.error) o.reason = `Couldn't check ${site}: ${o.error}`;
    else if (mcVersion) o.reason = `Not available for Minecraft ${mcVersion} on ${site}.`;
    else o.reason = `No downloadable version on ${site}.`;
  }
  const have = options.filter((o) => o.version);
  if (have.length < 2) return notes;
  const [a, b] = have;
  const cmp = compareVersionNumbers(a.version.versionNumber, b.version.versionNumber);
  if (cmp === 0) {
    notes.push(`Same version (${a.version.versionNumber}) on both sites.`);
  } else {
    let gap = cmp; // numbers decide when they can be compared; otherwise fall back to upload dates
    if (gap === null) {
      gap = new Date(a.version.date) - new Date(b.version.date);
      if (!Number.isFinite(gap) || Math.abs(gap) <= DAY) gap = 0;
    }
    if (gap !== 0) {
      const newer = gap > 0 ? a : b;
      a.newer = gap > 0; b.newer = gap < 0;
      notes.push(`Newer on ${SITE[newer.source]} (${newer.version.versionNumber} vs ${(newer === a ? b : a).version.versionNumber}).`);
    }
  }
  if ((RANK[a.version.releaseType] ?? 3) !== (RANK[b.version.releaseType] ?? 3)) {
    const worse = (RANK[a.version.releaseType] ?? 3) > (RANK[b.version.releaseType] ?? 3) ? a : b;
    notes.push(`On ${SITE[worse.source]} the latest is a ${worse.version.releaseType}, not a full release.`);
  }
  if (type === 'modpack') {
    const mcA = list(a.version.gameVersions); const mcB = list(b.version.gameVersions);
    if (mcA && mcB && newestMc(a.version.gameVersions) !== newestMc(b.version.gameVersions)) notes.push(`Different Minecraft versions: ${mcA} on ${SITE[a.source]}, ${mcB} on ${SITE[b.source]}.`);
    const lA = list(a.version.loaders); const lB = list(b.version.loaders);
    if (lA && lB && lA !== lB) notes.push(`Different loaders: ${lA} on ${SITE[a.source]}, ${lB} on ${SITE[b.source]}.`);
  }
  return notes;
}

/**
 * alts: [{ source, id, url }]. loadVersions(source, projectId) -> versions that fit (the instance's
 * Minecraft version + loader for mods, anything for modpacks). A source that throws counts as unavailable.
 * Returns { options: [{ source, projectId, url, version|null, reason?, error?, newer? }], notes, only: source|null }.
 */
async function compareSources({ alts, type, loadVersions, mcVersion }) {
  const options = await Promise.all(alts.map(async (a) => {
    const o = { source: a.source, projectId: a.id, url: a.url || null, version: null };
    try {
      const v = pickVersion(await loadVersions(a.source, a.id), type);
      if (v) o.version = summarizeVersion(v);
    } catch (e) {
      o.error = describeError(e);
    }
    return o;
  }));
  const usable = options.filter((o) => o.version);
  return { options, notes: differences(options, { type, mcVersion }), only: usable.length === 1 ? usable[0].source : null };
}

module.exports = { pickVersion, summarizeVersion, differences, compareSources, RANK };
