'use strict';
// Instances that follow a modpack from Modrinth or CurseForge.
//   - Labels every file the pack ships (index / manifest files and overrides) as pack content in content.json,
//     also for instances installed before Junction kept these labels (matched by hash). Labelling only ever
//     writes content.json: it never moves, changes or deletes a file.
//   - Compares two pack versions (mods added / removed / updated, config files changed) for the review window.
//   - Pack updates and reinstalls with a backup first, keeping your additions and the pack mods you turned off.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');
const { TYPE_DIR, isLinkedPack } = require('../instances');
const { detectPackFormat, contentType, normRel } = require('./modpacks');
const { safeJoin, ensureDir, exists, hashBuffer, readJson, writeJson, matchKey } = require('../util');
const { describeError } = require('../http');

const MR_CDN = /^https:\/\/cdn\.modrinth\.com\/data\/([^/]+)\/versions\/([^/]+)\//;
const PACK_BACKUPS_KEPT = 3;

/** "sodium-fabric-0.5.13+mc1.20.1.jar" -> "sodium-fabric": the file name without its version, to match files across versions. */
function fileStem(rel) {
  const base = path.basename(String(rel)).replace(/\.disabled$/i, '').replace(/\.(jar|zip)$/i, '').toLowerCase();
  const parts = base.split(/[-_+ ]/);
  const keep = [];
  for (const p of parts) {
    if (/^(v|mc)?\d/.test(p) && keep.length) break;
    keep.push(p);
  }
  return `${path.dirname(String(rel)).split(/[\\/]/)[0]}/${keep.join('-') || base}`;
}

const prettyName = (rel) => path.basename(String(rel)).replace(/\.(jar|zip)$/i, '');

/** The key that says "the same mod / pack in another version". */
function fileKey(f) {
  if (f.projectId != null && f.source) return `${f.source}:${f.projectId}`;
  return `stem:${fileStem(f.rel)}`;
}

// ---- reading a pack archive into one shape ----------------------------------------------------

/**
 * A pack version as a plain list:
 *   { format, name, versionName, mcVersion, loader,
 *     files: [{ rel, type, sha1, sha512, size, urls, source, projectId, versionId, title, override, blocked }],
 *     config: [{ rel, sha1 }] }   // override files that are not mods / resource packs / shaders / data packs
 * CurseForge manifests need the API (file names and hashes are not in the zip): pass `resolveCurseForge`.
 */
async function readPackArchive(zipPath, { resolveCurseForge } = {}) {
  const zip = new AdmZip(zipPath);
  const fmt = detectPackFormat(zip);
  if (!fmt) throw new Error('The downloaded file is not a modpack.');
  const out = { format: fmt, files: [], config: [] };
  const seenOverride = new Map();
  const addOverrides = (prefixes) => {
    for (const prefix of prefixes) {
      const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
      for (const e of zip.getEntries()) {
        if (e.isDirectory || !e.entryName.startsWith(p)) continue;
        const rel = normRel(e.entryName.slice(p.length));
        if (!rel) continue;
        try { safeJoin('/x', rel); } catch { continue; }
        seenOverride.set(rel, { rel, sha1: hashBuffer(e.getData(), 'sha1'), size: e.header.size, entry: e.entryName });
      }
    }
  };
  if (fmt === 'mrpack') {
    const index = JSON.parse(zip.readAsText('modrinth.index.json'));
    const deps = index.dependencies || {};
    const { mrpackLoader } = require('./modpacks');
    Object.assign(out, { name: index.name, versionName: index.versionId, mcVersion: deps.minecraft, loader: mrpackLoader(deps) });
    for (const f of index.files || []) {
      if (f.env?.client === 'unsupported') continue;
      const rel = normRel(f.path || '');
      try { safeJoin('/x', rel); } catch { continue; }
      const m = (f.downloads || []).map((u) => String(u).match(MR_CDN)).find(Boolean);
      out.files.push({
        rel, type: contentType(rel), sha1: f.hashes?.sha1, sha512: f.hashes?.sha512, size: f.fileSize, urls: f.downloads || [],
        source: m ? 'modrinth' : null, projectId: m ? m[1] : null, versionId: m ? m[2] : null, title: null, override: false,
      });
    }
    addOverrides(['overrides', 'client-overrides']);
  } else {
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    const { parseLoaderId } = require('../loaders');
    const le = (manifest.minecraft?.modLoaders || []).find((l) => l.primary) || manifest.minecraft?.modLoaders?.[0];
    Object.assign(out, { name: manifest.name, versionName: manifest.version, mcVersion: manifest.minecraft?.version, loader: le ? parseLoaderId(le.id) || { type: 'vanilla' } : { type: 'vanilla' } });
    if ((manifest.files || []).some((f) => f.required !== false)) {
      if (!resolveCurseForge) throw new Error('Reading a CurseForge pack needs the CurseForge API.');
      const { jobs, blocked } = await resolveCurseForge(manifest);
      for (const j of [...jobs, ...blocked]) {
        out.files.push({
          rel: j.rel, type: contentType(j.rel) || j.type, sha1: j.sha1, size: j.size, urls: j.url ? [j.url] : [],
          source: 'curseforge', projectId: j.projectId, versionId: j.versionId, title: j.title, versionName: j.versionName, icon: j.icon, override: false,
          blocked: j.url ? null : { pageUrl: j.pageUrl },
        });
      }
    }
    addOverrides([manifest.overrides || 'overrides']);
  }
  for (const o of seenOverride.values()) {
    const type = contentType(o.rel);
    if (type) {
      // An override replaces an index file at the same path.
      out.files = out.files.filter((f) => f.rel !== o.rel);
      out.files.push({ rel: o.rel, type, sha1: o.sha1, size: o.size, urls: [], source: null, projectId: null, versionId: null, title: null, override: true, entry: o.entry });
    } else out.config.push({ rel: o.rel, sha1: o.sha1, entry: o.entry });
  }
  return out;
}

// ---- labelling (pure: decides, the caller writes content.json) --------------------------------

/**
 * Works out which index entries are the pack's. `entries` is content.json's files (with sha1s filled in).
 * Returns { labels: { rel: { packChanged, packFile } }, notPack: [rel], missing: [packFile] }.
 *   - same hash as a pack file (anywhere)                     -> pack content
 *   - same path, or same project, but a different file          -> pack content, "changed"
 *   - everything else                                           -> added by you
 */
function planLabels(entries, manifest) {
  const files = manifest.files.filter((f) => f.type);
  const bySha = new Map();
  for (const f of files) if (f.sha1) bySha.set(String(f.sha1).toLowerCase(), f);
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const byProject = new Map(files.filter((f) => f.projectId != null && f.source).map((f) => [`${f.source}:${f.projectId}`, f]));
  const byStem = new Map(files.map((f) => [fileStem(f.rel), f]));
  const used = new Set();
  const labels = {};
  const notPack = [];
  const rels = Object.keys(entries).filter((rel) => contentType(rel));
  // Exact matches first, so a "changed" guess never steals a file that is really there.
  const pending = [];
  for (const rel of rels) {
    const e = entries[rel];
    const f = e.sha1 && bySha.get(String(e.sha1).toLowerCase());
    if (f && !used.has(f)) { used.add(f); labels[rel] = { packChanged: false, packFile: packFileOf(f) }; } else pending.push(rel);
  }
  for (const rel of pending) {
    const e = entries[rel];
    const cands = [byRel.get(rel), e.projectId != null && e.source ? byProject.get(`${e.source}:${e.projectId}`) : null, byStem.get(fileStem(rel))];
    const f = cands.find((c) => c && !used.has(c));
    if (f) { used.add(f); labels[rel] = { packChanged: true, packFile: packFileOf(f) }; } else notPack.push(rel);
  }
  const missing = files.filter((f) => !used.has(f)).map(packFileOf);
  return { labels, notPack, missing };
}

function packFileOf(f) {
  return {
    rel: f.rel, sha1: f.sha1 || null, sha512: f.sha512 || null, size: f.size || null, urls: (f.urls || []).filter((u) => /^https:\/\//i.test(u)),
    override: Boolean(f.override), source: f.source || null, projectId: f.projectId ?? null, versionId: f.versionId ?? null,
  };
}

// ---- comparing two versions (pure) ------------------------------------------------------------

/**
 * What changes from one pack version to the next.
 * Returns { added, removed, updated, unchanged, config: { added, removed, changed } }.
 * Each mod row: { key, type, title, rel, fromRel?, toRel?, projectId, source, versionId, fromVersionId }.
 */
function comparePacks(from, to) {
  const index = (m) => {
    const map = new Map();
    for (const f of m.files.filter((x) => x.type)) map.set(fileKey(f), f);
    return map;
  };
  const a = index(from);
  const b = index(to);
  const added = [];
  const removed = [];
  const updated = [];
  let unchanged = 0;
  const row = (f, extra = {}) => ({ key: fileKey(f), type: f.type, title: f.title || prettyName(f.rel), rel: f.rel, source: f.source, projectId: f.projectId, versionId: f.versionId, icon: f.icon || null, ...extra });
  for (const [k, f] of b) {
    const old = a.get(k);
    if (!old) added.push(row(f));
    else if ((old.sha1 || old.rel) !== (f.sha1 || f.rel)) updated.push(row(f, { fromRel: old.rel, toRel: f.rel, fromVersionId: old.versionId, fromVersionName: old.versionName, toVersionName: f.versionName }));
    else unchanged++;
  }
  for (const [k, f] of a) if (!b.has(k)) removed.push(row(f));
  const ca = new Map(from.config.map((c) => [c.rel, c.sha1]));
  const cb = new Map(to.config.map((c) => [c.rel, c.sha1]));
  const config = {
    added: [...cb.keys()].filter((r) => !ca.has(r)).sort(),
    removed: [...ca.keys()].filter((r) => !cb.has(r)).sort(),
    changed: [...cb.keys()].filter((r) => ca.has(r) && ca.get(r) !== cb.get(r)).sort(),
  };
  const byTitle = (x, y) => x.title.localeCompare(y.title);
  return { added: added.sort(byTitle), removed: removed.sort(byTitle), updated: updated.sort(byTitle), unchanged, config };
}

/** Index entries you added yourself that a pack version now ships too (same project, same mod id, or same file name). */
function additionsCoveredBy(entries, manifest, modIdsOfPack = new Set()) {
  const keys = new Set(manifest.files.filter((f) => f.type).map(fileKey));
  const stems = new Set(manifest.files.filter((f) => f.type).map((f) => fileStem(f.rel)));
  const titles = new Set(manifest.files.filter((f) => f.type && f.title).map((f) => matchKey(f.title)));
  const out = [];
  for (const [rel, e] of Object.entries(entries)) {
    if (e.fromPack || !contentType(rel)) continue;
    const hit = (e.projectId != null && e.source && keys.has(`${e.source}:${e.projectId}`))
      || (e.meta?.modId && modIdsOfPack.has(e.meta.modId))
      || stems.has(fileStem(rel))
      || (e.title && titles.has(matchKey(e.title)));
    if (hit) out.push(rel);
  }
  return out;
}

// ---- the service ----------------------------------------------------------------------------------

class PackLink {
  constructor(ctx, instances, content, modpacks, sources) {
    this.ctx = ctx;
    this.instances = instances;
    this.content = content;
    this.modpacks = modpacks;
    this.sources = sources;
  }

  async manifestFor(pack, versionId = pack.versionId) {
    const { path: file, project, version } = await this.modpacks.packArchive(pack, versionId);
    const resolveCurseForge = async (manifest) => {
      if (!this.sources.curseforge.configured()) throw new Error('Reading a CurseForge pack needs your CurseForge API key. Add it in Settings.');
      return this.modpacks.resolveCurseForge(manifest, path.join(this.ctx.paths.cache, 'nowhere'));
    };
    const m = await readPackArchive(file, { resolveCurseForge });
    return { ...m, archive: file, project, version };
  }

  /** Brings every content type's index up to date (sha1s), then returns content.json's files. */
  async freshEntries(instId) {
    for (const t of Object.keys(TYPE_DIR)) await this.instances.listContent(instId, t);
    return (await this.instances.readIndex(instId)).files;
  }

  /**
   * Labels the pack's files in content.json from the linked version's index / manifest. Only content.json
   * is written; files on disk are never touched. Safe to run again (it is quick when the archive is cached).
   */
  async label(instId, { manifest = null } = {}) {
    const inst = await this.instances.get(instId);
    if (!isLinkedPack(inst)) return { labelled: 0, changed: 0, additions: 0, skipped: true };
    const m = manifest || (await this.manifestFor(inst.pack));
    const entries = await this.freshEntries(instId);
    const plan = planLabels(entries, m);
    let changed = 0;
    await this.instances.withIndex(instId, (idx) => {
      for (const [rel, l] of Object.entries(plan.labels)) {
        if (!idx.files[rel]) continue;
        const e = idx.files[rel];
        e.fromPack = true;
        e.packChanged = l.packChanged || undefined;
        e.packFile = l.packFile;
        if (l.packChanged) changed++;
        // A file nobody had identified yet, but the pack's index says where it's from.
        if ((!e.source || e.source === 'local') && l.packFile.source && !l.packChanged) {
          e.source = l.packFile.source; e.projectId = l.packFile.projectId; e.versionId = l.packFile.versionId;
        }
        if ((!e.source || e.source === 'local') && l.packFile.override) e.source = 'pack';
      }
      for (const rel of plan.notPack) {
        const e = idx.files[rel];
        if (!e) continue;
        delete e.packChanged; delete e.packFile;
        e.fromPack = false;
        if (e.source === 'pack') e.source = 'local';
      }
      idx.packLabels = { versionId: String(inst.pack.versionId), at: Date.now() };
    });
    return { labelled: Object.keys(plan.labels).length, changed, additions: plan.notPack.length, missing: plan.missing.length };
  }

  /** Whether the labels belong to the version the instance is linked to now. */
  async needsLabels(instId) {
    const inst = await this.instances.get(instId);
    if (!isLinkedPack(inst)) return false;
    const idx = await this.instances.readIndex(instId);
    return idx.packLabels?.versionId !== String(inst.pack.versionId);
  }

  // ---- what the pack page shows -------------------------------------------------------------

  /** Newest version of the linked pack, if it is newer than the installed one (by date; a beta you picked is not "behind"). */
  async checkUpdate(instId) {
    const inst = await this.instances.get(instId);
    if (!isLinkedPack(inst)) return null;
    const list = (await this.sources[inst.pack.source].versions(inst.pack.projectId, {})).sort((a, b) => new Date(b.date) - new Date(a.date));
    const cur = list.find((v) => String(v.id) === String(inst.pack.versionId));
    const latest = list.find((v) => v.releaseType === 'release') || list[0];
    if (!latest || String(latest.id) === String(inst.pack.versionId)) return null;
    if (cur && new Date(latest.date) <= new Date(cur.date)) return null;
    return { versionId: latest.id, versionName: latest.versionNumber, date: latest.date, releaseType: latest.releaseType };
  }

  /** The pack's versions, newest first, for Switch version. */
  async versions(instId) {
    const inst = await this.instances.get(instId);
    if (!isLinkedPack(inst)) return [];
    const list = await this.sources[inst.pack.source].versions(inst.pack.projectId, {});
    return list.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 100)
      .map((v) => ({ id: v.id, versionNumber: v.versionNumber, date: v.date, releaseType: v.releaseType, gameVersions: v.gameVersions, current: String(v.id) === String(inst.pack.versionId) }));
  }

  /** Header data: icon, name, author, tags and a featured / gallery picture. */
  async info(instId) {
    const inst = await this.instances.get(instId);
    if (!isLinkedPack(inst)) return null;
    const { source, projectId } = inst.pack;
    const p = source === 'modrinth' ? await this.sources.modrinth.project(projectId) : await this.sources.curseforge.project(projectId);
    let author = p.author || p.authors?.[0] || '';
    if (!author && source === 'modrinth' && p.team) author = (await this.sources.modrinth.teamOwners([p.team]).catch(() => ({})))[p.team] || '';
    const pic = (p.gallery || []).find((g) => g.featured) || (p.gallery || [])[0] || null;
    return {
      source, projectId, title: p.title, icon: p.icon, url: p.url, author, summary: p.summary,
      tags: (p.categories || []).slice(0, 6), banner: pic && /^https:\/\//.test(pic.url) ? pic.url : null,
    };
  }

  /** Changelogs of the installed version and everything newer (plus a few older ones). Bodies are Markdown (Modrinth) or HTML (CurseForge). */
  async changelog(instId, { older = 4, newerMax = 15 } = {}) {
    const inst = await this.instances.get(instId);
    if (!isLinkedPack(inst)) return [];
    const { source, projectId } = inst.pack;
    const list = (await this.sources[source].versions(projectId, {})).sort((a, b) => new Date(b.date) - new Date(a.date));
    let at = list.findIndex((v) => String(v.id) === String(inst.pack.versionId));
    if (at === -1) at = list.length;
    const pick = [...list.slice(Math.max(0, at - newerMax), at), ...list.slice(at, at + 1 + older)];
    const out = [];
    for (const v of pick) {
      let body = v.changelog || '';
      if (source === 'curseforge') body = await this.sources.curseforge.changelog(projectId, v.id).catch(() => '');
      const idx = list.indexOf(v);
      out.push({ id: v.id, versionNumber: v.versionNumber, date: v.date, releaseType: v.releaseType, newer: idx < at, current: idx === at, body, bodyFormat: source === 'modrinth' ? 'markdown' : 'html' });
    }
    return out;
  }

  /**
   * Who made each mod, for the Author column: one request per site (plus one for Modrinth teams),
   * cached for a month in cache/authors.json. Returns { rel: author }.
   */
  async authors(instId) {
    const file = path.join(this.ctx.paths.cache, 'authors.json');
    const cache = await readJson(file, {});
    const idx = await this.instances.readIndex(instId);
    const month = 30 * 24 * 3600e3;
    const fresh = (k) => cache[k] && Date.now() - cache[k].at < month;
    const want = { modrinth: new Set(), curseforge: new Set() };
    for (const e of Object.values(idx.files)) {
      if (e.projectId == null || !want[e.source] || fresh(`${e.source}:${e.projectId}`)) continue;
      want[e.source].add(String(e.projectId));
    }
    let changed = false;
    if (want.modrinth.size) {
      try {
        const projects = await this.sources.modrinth.projects([...want.modrinth]);
        const owners = await this.sources.modrinth.teamOwners([...new Set(projects.map((p) => p.team).filter(Boolean))]);
        for (const p of projects) { cache[`modrinth:${p.id}`] = { name: owners[p.team] || '', at: Date.now() }; changed = true; }
      } catch { /* the column stays empty for now */ }
    }
    if (want.curseforge.size && this.sources.curseforge.configured()) {
      try {
        for (const m of await this.sources.curseforge.mods([...want.curseforge])) { cache[`curseforge:${m.id}`] = { name: m.author || '', at: Date.now() }; changed = true; }
      } catch { /* same */ }
    }
    if (changed) await writeJson(file, cache);
    const out = {};
    for (const [rel, e] of Object.entries(idx.files)) {
      const c = e.projectId != null ? cache[`${e.source}:${e.projectId}`] : null;
      const a = c?.name || e.meta?.authors?.[0] || null;
      if (a) out[rel] = a;
    }
    return out;
  }

  // ---- restore one changed file ---------------------------------------------------------------

  async restoreFile(instId, rel) {
    const inst = await this.instances.get(instId);
    const idx = await this.instances.readIndex(instId);
    const e = idx.files[rel];
    if (!e?.fromPack || !e.packFile) throw new Error('That file is not part of the modpack.');
    const pf = e.packFile;
    const dest = this.instances.contentPath(instId, pf.rel);
    const tmp = `${dest}.restore`;
    const on = this.instances.contentPath(instId, rel, true);
    const wasDisabled = !(await exists(on)) && (await exists(this.instances.contentPath(instId, rel, false)));
    if (pf.urls?.length) {
      await this.modpacks.fetchFirst(pf.urls, tmp, { sha1: pf.sha1, sha512: pf.sha512, size: pf.size });
    } else {
      const m = await this.manifestFor(inst.pack);
      const f = m.files.find((x) => x.rel === pf.rel && x.entry);
      if (!f) throw new Error(`${path.basename(pf.rel)} isn't in ${inst.pack.name} ${inst.pack.versionName || ''} any more.`);
      const data = new AdmZip(m.archive).getEntry(f.entry).getData();
      await ensureDir(path.dirname(tmp));
      await fsp.writeFile(tmp, data);
    }
    // Only now that the pack's file is here: take out the changed one (the switched-off state stays).
    await this.content.removeFiles(instId, [rel]);
    const final = wasDisabled ? `${dest}.disabled` : dest;
    await fsp.rm(final, { force: true });
    await fsp.rename(tmp, final);
    await this.instances.withIndex(instId, (fresh) => {
      fresh.files[pf.rel] = { ...e, fromPack: true, packChanged: undefined, packFile: pf, sha1: pf.sha1 || undefined, metaSize: undefined, metaMtime: undefined,
        source: pf.source || (pf.override ? 'pack' : e.source), projectId: pf.projectId ?? undefined, versionId: pf.versionId ?? undefined, versionName: undefined };
    });
    return { restored: pf.rel };
  }

  // ---- review a version change ------------------------------------------------------------

  /** Everything the review window shows for moving to `versionId` (the same version: a reinstall). */
  async preview(instId, versionId) {
    const inst = await this.instances.get(instId);
    if (!isLinkedPack(inst)) throw new Error('This instance is not linked to a modpack.');
    if (await this.needsLabels(instId)) await this.label(instId);
    const [cur, next] = await Promise.all([
      this.manifestFor(inst.pack).catch(() => null),
      this.manifestFor(inst.pack, versionId),
    ]);
    const entries = await this.freshEntries(instId);
    const from = cur || { files: Object.entries(entries).filter(([, e]) => e.fromPack).map(([rel, e]) => ({ rel, type: contentType(rel), sha1: e.sha1, source: e.source, projectId: e.projectId, versionId: e.versionId, title: e.title })), config: [] };
    const diff = comparePacks(from, next);
    await this.fillTitles([...diff.added, ...diff.removed, ...diff.updated], entries);
    const covered = additionsCoveredBy(entries, next);
    const disabledPack = [];
    for (const t of Object.keys(TYPE_DIR)) {
      for (const it of await this.instances.listContent(instId, t)) if (it.fromPack && !it.enabled) disabledPack.push(it.title);
    }
    const additions = Object.entries(entries).filter(([rel, e]) => !e.fromPack && contentType(rel));
    // Pack files you changed: the update puts the pack's own file in their place (or drops them with the pack).
    const nextKeys = new Set(next.files.filter((f) => f.type).map(fileKey));
    const replacedChanged = Object.entries(entries).filter(([rel, e]) => e.fromPack && e.packChanged && contentType(rel)).map(([rel, e]) => {
      const pf = e.packFile || { rel };
      const stays = nextKeys.has(fileKey({ ...pf, rel: pf.rel || rel })) || nextKeys.has(fileKey({ rel }));
      return { rel, title: e.title || e.meta?.name || prettyName(rel), replaced: stays };
    });
    return {
      from: { versionId: inst.pack.versionId, versionName: inst.pack.versionName, mcVersion: inst.mcVersion, loader: inst.loader },
      to: { versionId: next.version.id, versionName: next.version.versionNumber, date: next.version.date, mcVersion: next.mcVersion, loader: next.loader, releaseType: next.version.releaseType },
      ...diff,
      exact: Boolean(cur),
      keptAdditions: additions.filter(([rel]) => !covered.includes(rel)).length,
      covered: covered.map((rel) => ({ rel, title: entries[rel]?.title || entries[rel]?.meta?.name || prettyName(rel) })),
      keptDisabled: disabledPack,
      replacedChanged,
    };
  }

  /** Project names (and version numbers) for diff rows, in bulk: one request per site. */
  async fillTitles(rows, entries) {
    const byKey = new Map();
    for (const e of Object.values(entries)) if (e.projectId != null && e.source && e.title) byKey.set(`${e.source}:${e.projectId}`, e);
    const mrIds = [...new Set(rows.filter((r) => r.source === 'modrinth' && r.projectId && !byKey.has(r.key)).map((r) => r.projectId))];
    try {
      for (const p of await this.sources.modrinth.projects(mrIds)) byKey.set(`modrinth:${p.id}`, { title: p.title, icon: p.icon });
    } catch { /* names fall back to file names */ }
    const vIds = [...new Set(rows.flatMap((r) => (r.source === 'modrinth' ? [r.versionId, r.fromVersionId] : [])).filter(Boolean))];
    const vNames = new Map();
    try { for (const v of await this.sources.modrinth.versionsById(vIds)) vNames.set(v.id, v.versionNumber); } catch { /* file names instead */ }
    for (const r of rows) {
      const k = byKey.get(r.key);
      if (k?.title) r.title = k.title;
      if (k?.icon && !r.icon) r.icon = k.icon;
      // Without a version number (files shipped in the pack's overrides), the file names say what changes.
      r.toVersionName = r.toVersionName || vNames.get(r.versionId) || path.basename(r.toRel || r.rel || '') || null;
      if (r.fromRel) r.fromVersionName = r.fromVersionName || vNames.get(r.fromVersionId) || path.basename(r.fromRel);
      if (r.fromRel && r.fromVersionName === r.toVersionName) { r.fromVersionName = null; r.sameName = true; } // same file name, new contents
    }
  }

  // ---- backups ------------------------------------------------------------------------------

  backupsDir(instId) { return path.join(this.instances.instDir(instId), 'backups', 'pack'); }

  /**
   * Copies the content folders, config, content.json and instance.json aside. Content files are hard-linked
   * where the disk allows it (pack updates only ever replace them, never write into them), configs are copied.
   */
  async backup(instId, record) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(this.backupsDir(instId), stamp);
    const gameDir = this.instances.gameDir(instId);
    const copyTree = async (from, to, link) => {
      if (!(await exists(from))) return;
      await ensureDir(to);
      for (const e of await fsp.readdir(from, { withFileTypes: true })) {
        const a = path.join(from, e.name);
        const b = path.join(to, e.name);
        if (e.isDirectory()) await copyTree(a, b, link);
        else if (e.isFile()) {
          if (link) { try { await fsp.link(a, b); continue; } catch { /* another drive or no permission: copy */ } }
          await fsp.copyFile(a, b);
        }
      }
    };
    for (const sub of Object.values(TYPE_DIR)) await copyTree(path.join(gameDir, sub), path.join(dir, 'files', sub), true);
    await copyTree(path.join(gameDir, 'config'), path.join(dir, 'files', 'config'), false);
    await fsp.copyFile(path.join(this.instances.instDir(instId), 'content.json'), path.join(dir, 'content.json')).catch(() => {});
    await fsp.copyFile(path.join(this.instances.instDir(instId), 'instance.json'), path.join(dir, 'instance.json'));
    await writeJson(path.join(dir, 'pack-backup.json'), { stamp, date: Date.now(), ...record });
    const all = (await fsp.readdir(this.backupsDir(instId)).catch(() => [])).sort().reverse();
    for (const old of all.slice(PACK_BACKUPS_KEPT)) await fsp.rm(path.join(this.backupsDir(instId), old), { recursive: true, force: true });
    return stamp;
  }

  async history(instId) {
    const out = [];
    for (const name of (await fsp.readdir(this.backupsDir(instId)).catch(() => [])).sort().reverse()) {
      const rec = await readJson(path.join(this.backupsDir(instId), name, 'pack-backup.json'), null);
      if (rec) out.push({ stamp: rec.stamp, date: rec.date, action: rec.action, from: rec.from, to: rec.to });
    }
    return out;
  }

  /** Puts the instance back exactly as it was before that pack update or reinstall. */
  async undo(instId, stamp) {
    if (!/^[\w-]+$/.test(String(stamp))) throw new Error('Bad backup id');
    const dir = path.join(this.backupsDir(instId), stamp);
    if (!(await exists(path.join(dir, 'pack-backup.json')))) throw new Error('That backup no longer exists.');
    const gameDir = this.instances.gameDir(instId);
    for (const sub of [...Object.values(TYPE_DIR), 'config']) {
      const saved = path.join(dir, 'files', sub);
      const live = path.join(gameDir, sub);
      if (!(await exists(saved))) {
        if (sub !== 'config' && (await exists(live))) await fsp.rm(live, { recursive: true, force: true });
        continue;
      }
      await fsp.rm(live, { recursive: true, force: true });
      await fsp.cp(saved, live, { recursive: true });
    }
    await fsp.copyFile(path.join(dir, 'instance.json'), path.join(this.instances.instDir(instId), 'instance.json'));
    if (await exists(path.join(dir, 'content.json'))) await fsp.copyFile(path.join(dir, 'content.json'), path.join(this.instances.instDir(instId), 'content.json'));
    await fsp.rm(dir, { recursive: true, force: true });
    return { restored: true };
  }

  // ---- update / switch version / reinstall --------------------------------------------------

  /**
   * Moves the instance to another pack version (or the same one: a reinstall).
   *   keepAdditions: false removes the files you added yourself (reinstall only).
   *   keepDisabled: pack mods you turned off stay off in the new version.
   * Returns the install result plus { backup, removedCovered: [title], reenabled }.
   */
  async applyVersion(instId, versionId, { action = 'update', keepAdditions = true, keepDisabled = true, report = () => {} } = {}) {
    const inst = await this.instances.get(instId);
    if (!isLinkedPack(inst)) throw new Error('This instance is not linked to a modpack.');
    // Labels first, so "the pack's files" and "your additions" are right before anything is replaced.
    if (await this.needsLabels(instId)) { report(0.005, 'Sorting pack content from your additions'); await this.label(instId); }
    report(0.01, 'Backing up');
    const backup = await this.backup(instId, { action, from: inst.pack.versionName, to: null, versionId: inst.pack.versionId });
    const entries = await this.freshEntries(instId);
    const off = new Set();
    for (const t of Object.keys(TYPE_DIR)) {
      for (const it of await this.instances.listContent(instId, t)) {
        if (!it.fromPack || it.enabled) continue;
        const e = entries[it.file] || {};
        if (e.projectId != null && e.source) off.add(`${e.source}:${e.projectId}`);
        if (e.meta?.modId) off.add(`mod:${e.meta.modId}`);
        off.add(`stem:${fileStem(it.file)}`);
      }
    }
    if (!keepAdditions) {
      const mine = Object.keys(entries).filter((rel) => !entries[rel].fromPack && contentType(rel));
      await this.content.removeFiles(instId, mine);
    }
    const r = await this.modpacks.installFromSource({ source: inst.pack.source, projectId: inst.pack.projectId, versionId, instanceId: instId, report: (p, msg) => report(0.03 + 0.85 * (p ?? 0), msg) });
    report(0.9, 'Sorting pack content from your additions');
    let manifest = null;
    try { manifest = await this.manifestFor((await this.instances.get(instId)).pack); } catch (e) { r.warnings = [...(r.warnings || []), `Couldn't re-read the pack's file list: ${describeError(e)}`]; }
    if (manifest) await this.label(instId, { manifest });
    const after = await this.freshEntries(instId);
    // Your own copy of something the pack now ships: the pack's copy wins.
    const removedCovered = [];
    if (manifest) {
      const packModIds = new Set(Object.values(after).filter((e) => e.fromPack && e.meta?.modId).map((e) => e.meta.modId));
      const covered = additionsCoveredBy(after, manifest, packModIds);
      for (const rel of covered) removedCovered.push(after[rel]?.title || after[rel]?.meta?.name || prettyName(rel));
      if (covered.length) await this.content.removeFiles(instId, covered);
    }
    // Pack mods you had turned off stay off.
    let keptOff = 0;
    if (keepDisabled && off.size) {
      for (const [rel, e] of Object.entries(after)) {
        if (!e.fromPack || !contentType(rel)) continue;
        const keys = [`stem:${fileStem(rel)}`, e.projectId != null && e.source ? `${e.source}:${e.projectId}` : null, e.meta?.modId ? `mod:${e.meta.modId}` : null].filter(Boolean);
        if (keys.some((k) => off.has(k)) && (await exists(this.instances.contentPath(instId, rel, true)))) { await this.content.setEnabled(instId, rel, false); keptOff++; }
      }
    }
    const now = await this.instances.get(instId);
    const recFile = path.join(this.backupsDir(instId), backup, 'pack-backup.json');
    const rec = await readJson(recFile, {});
    await writeJson(recFile, { ...rec, to: now.pack?.versionName });
    report(1, 'Done');
    return { ...r, backup, removedCovered, keptOff };
  }
}

module.exports = { PackLink, readPackArchive, planLabels, comparePacks, additionsCoveredBy, fileStem, fileKey };
