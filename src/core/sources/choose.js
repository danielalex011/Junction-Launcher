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
  const gap = new Date(a.version.date) - new Date(b.version.date);
  if (Number.isFinite(gap) && Math.abs(gap) > DAY) {
    const newer = gap > 0 ? a : b;
    a.newer = gap > 0; b.newer = gap < 0;
    notes.push(`Newer on ${SITE[newer.source]} (${new Date(newer.version.date).toISOString().slice(0, 10)} vs ${new Date((newer === a ? b : a).version.date).toISOString().slice(0, 10)}).`);
  }
  if ((RANK[a.version.releaseType] ?? 3) !== (RANK[b.version.releaseType] ?? 3)) {
    const worse = (RANK[a.version.releaseType] ?? 3) > (RANK[b.version.releaseType] ?? 3) ? a : b;
    notes.push(`On ${SITE[worse.source]} the latest is a ${worse.version.releaseType}, not a full release.`);
  }
  if (type === 'modpack') {
    const mcA = list(a.version.gameVersions); const mcB = list(b.version.gameVersions);
    if (mcA && mcB && mcA !== mcB) notes.push(`Different Minecraft versions: ${mcA} on ${SITE[a.source]}, ${mcB} on ${SITE[b.source]}.`);
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
