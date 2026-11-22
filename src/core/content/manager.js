'use strict';
// Installing, updating, identifying and removing mods / resource packs / shaders.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { TYPE_DIR, DIR_TYPE, isLinkedPack } = require('../instances');
const { compatibleLoaders } = require('../sources');
const { CurseForge, LOADER_TYPE } = require('../sources/curseforge');
const { curseFingerprintFile } = require('../sources/fingerprint');
const { readModMetadata } = require('./metadata');
const { matchKey, exists, hashFile, ensureDir, pool, readJson, writeJson } = require('../util');
const { describeError, HttpError } = require('../http');

const { pickVersion } = require('../sources/choose');
const { sameVariant } = require('./variant');
const CF_RELEASE = { 1: 'release', 2: 'beta', 3: 'alpha' }; // CurseForge's releaseType numbers in latestFilesIndexes

/** HTTP errors already name the site; other failures (no connection, ...) get the site put in front. */
const siteError = (site, e) => (e instanceof HttpError ? describeError(e) : `${site}: ${describeError(e)}`);

function pickFile(version) {
  return version.files.find((f) => f.primary) || version.files[0];
}

/** Modrinth's client_side / server_side, kept in content.json so "client-only" works offline. */
function sidesOf(project) {
  return project && (project.clientSide || project.serverSide) ? { client: project.clientSide || null, server: project.serverSide || null } : undefined;
}

const mdEscape = (t) => String(t).replace(/([\\`*_[\]])/g, '\\$1');
const baseTitle = (rel, e) => e?.title || e?.meta?.name || path.basename(rel).replace(/\.(jar|zip)$/i, '');

function versionSupports(version, inst, type) {
  if (version.gameVersions?.length && !version.gameVersions.includes(inst.mcVersion)) return false;
  if (type === 'mod') {
    const ok = compatibleLoaders(inst.loader?.type, inst.mcVersion);
    if (!ok.length) return false; // vanilla instances can't run mods
    if (version.loaders?.length && !version.loaders.some((l) => ok.includes(l))) return false;
  }
  return true;
}

class ContentManager {
  constructor(ctx, instances, sources) {
    this.ctx = ctx;
    this.instances = instances;
    this.sources = sources;
  }

  src(name) {
    const s = this.sources[name];
    if (!s) throw new Error(`Unknown source ${name}`);
    return s;
  }

  async compatibleVersions(source, projectId, inst, type) {
    const loaders = type === 'mod' ? compatibleLoaders(inst.loader?.type, inst.mcVersion) : undefined;
    const list = await this.src(source).versions(projectId, { gameVersion: inst.mcVersion, loaders });
    return list.filter((v) => versionSupports(v, inst, type));
  }

  async bestVersion(source, projectId, inst, type) {
    const list = await this.compatibleVersions(source, projectId, inst, type);
    if (!list.length) return null;
    return pickVersion(list, type);
  }

  async projectInfo(source, projectId) {
    if (source === 'modrinth') return this.sources.modrinth.project(projectId);
    const [m] = await this.sources.curseforge.mods([projectId]);
    return m;
  }

  /** What's in an instance, for marking "Installed" in Browse. */
  async installedInfo(instId) {
    const out = { projects: {}, titles: [], modIds: [] };
    for (const t of Object.keys(TYPE_DIR)) {
      for (const it of await this.instances.listContent(instId, t)) {
        if (it.projectId != null && it.source !== 'local') {
          out.projects[`${it.source}:${it.projectId}`] = { file: it.file, versionId: it.versionId != null ? String(it.versionId) : null, enabled: it.enabled, type: t, fromPack: it.fromPack };
        }
        out.titles.push(matchKey(it.title));
        if (it.modId) out.modIds.push(matchKey(it.modId));
      }
    }
    return out;
  }

  /** Summary of what's installed, for duplicate / dependency checks. */
  /** The files of a linked modpack that only the pack may change (empty for other instances). */
  async lockedRels(instId, rels = null) {
    const inst = await this.instances.get(instId);
    if (!isLinkedPack(inst)) return [];
    const idx = await this.instances.readIndex(instId);
    return (rels || Object.keys(idx.files)).filter((r) => idx.files[r]?.fromPack);
  }

  async installedSummary(instId) {
    const idx = await this.instances.readIndex(instId);
    const byProject = new Map();
    const titles = new Map();
    const modIds = new Map();
    for (const [rel, e] of Object.entries(idx.files)) {
      if (e.source && e.projectId != null) byProject.set(`${e.source}:${e.projectId}`, rel);
      if (e.title) titles.set(matchKey(e.title), rel);
      if (e.meta?.modId) modIds.set(e.meta.modId, rel);
    }
    return { idx, byProject, titles, modIds };
  }

  /**
   * Installs a version (and its required dependencies) into an instance.
   * Returns { installed, skipped, blocked, warnings }.
   */
  async installVersion(instId, version, { type = 'mod', project = null, withDeps = true, fromPack = false, report = () => {} } = {}) {
    const inst = await this.instances.get(instId);
    const linked = isLinkedPack(inst) && !fromPack;
    const result = { installed: [], skipped: [], blocked: [], warnings: [] };
    const queue = [{ version, project, type, explicit: true }];
    const seen = new Set();
    while (queue.length) {
      const job = queue.shift();
      const v = job.version;
      const key = `${v.source}:${v.projectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const proj = job.project || (await this.projectInfo(v.source, v.projectId).catch(() => null));
      const title = proj?.title || v.name;
      const summary = await this.installedSummary(instId);

      // The modpack already has it: never a second copy, and the pack's own file stays as the pack set it.
      if (linked) {
        const rel0 = summary.byProject.get(key) || summary.titles.get(matchKey(title));
        if (rel0 && summary.idx.files[rel0]?.fromPack) {
          result.skipped.push({ title, reason: 'already included in the modpack' });
          continue;
        }
      }
      if (!job.explicit) {
        // Dependency: skip if already present from either platform.
        if (summary.byProject.has(key) || summary.titles.has(matchKey(title))) {
          result.skipped.push({ title, reason: 'already installed' });
          continue;
        }
      }
      const file = pickFile(v);
      if (!file) { result.warnings.push(`${title}: no downloadable file`); continue; }
      const dir = TYPE_DIR[job.type] || 'mods';
      const rel = `${dir}/${file.filename}`;
      const dest = this.instances.contentPath(instId, rel);

      // Replacing an older version of the same project?
      const oldRel = summary.byProject.get(key);
      if (oldRel && oldRel !== rel) {
        await this.removeFiles(instId, [oldRel]);
        for (const [mid, r] of summary.modIds) if (r === oldRel) summary.modIds.delete(mid);
      } else if (oldRel === rel && summary.idx.files[rel]?.versionId === v.id && (await exists(dest))) {
        result.skipped.push({ title, reason: 'this version is already installed' });
        continue;
      }

      if (!file.url) {
        result.blocked.push({
          title, fileName: file.filename, sha1: file.sha1, size: file.size, rel, dest,
          source: v.source, projectId: v.projectId, versionId: v.id, icon: proj?.icon || null,
          pageUrl: CurseForge.manualDownloadUrl(proj, v.id), projectUrl: proj?.url || null, versionName: v.versionNumber,
        });
        continue;
      }
      report(null, `Downloading ${file.filename}`);
      await this.ctx.http.download(file.url, dest, { sha1: file.sha1, sha512: file.sha512, size: file.size });
      const meta = job.type === 'mod' ? readModMetadata(dest) : null;

      // Same mod id already present (e.g. from the other platform)?
      if (meta?.modId && summary.modIds.has(meta.modId) && summary.modIds.get(meta.modId) !== rel) {
        const other = summary.modIds.get(meta.modId);
        if (linked && summary.idx.files[other]?.fromPack) {
          await fsp.rm(dest, { force: true });
          result.skipped.push({ title, reason: 'already included in the modpack' });
          continue;
        }
        if (job.explicit) {
          await this.removeFiles(instId, [other]);
          result.warnings.push(`Replaced ${path.basename(other)} (same mod "${meta.modId}") with ${file.filename}`);
        } else {
          await fsp.rm(dest, { force: true });
          result.skipped.push({ title, reason: `already provided by ${path.basename(other)}` });
          continue;
        }
      }
      const st = await fsp.stat(dest);
      await this.instances.withIndex(instId, (idx) => {
        idx.files[rel] = {
          source: v.source, projectId: v.projectId, versionId: v.id, title, versionName: v.versionNumber,
          icon: proj?.icon || null, projectUrl: proj?.url || null, slug: proj?.slug, fileUrl: file.url, sides: sidesOf(proj),
          sha1: file.sha1 || undefined, fromPack, meta: meta || null, metaSize: st.size, metaMtime: st.mtimeMs,
          installedAt: Date.now(),
        };
      });
      result.installed.push({ title, file: rel, source: v.source });

      if (withDeps) {
        for (const dep of v.deps || []) {
          if (dep.type !== 'required' || dep.projectId == null) continue;
          try {
            let depVersion = null;
            if (dep.source === 'modrinth' && dep.versionId) depVersion = await this.sources.modrinth.version(dep.versionId).catch(() => null);
            if (depVersion && !versionSupports(depVersion, inst, 'mod')) depVersion = null;
            if (!depVersion) depVersion = await this.bestVersion(dep.source, dep.projectId, inst, 'mod');
            if (!depVersion) {
              result.warnings.push(`${title} needs a dependency (${dep.source} ${dep.projectId}) with no version for ${inst.mcVersion}`);
              continue;
            }
            queue.push({ version: depVersion, project: null, type: 'mod', explicit: false });
          } catch (e) {
            result.warnings.push(`Could not resolve a dependency of ${title}: ${e.message}`);
          }
        }
      }
    }
    return result;
  }

  async installProject(instId, { source, id }, type = 'mod', { versionId, report, withDeps = true } = {}) {
    const inst = await this.instances.get(instId);
    const project = await this.projectInfo(source, id);
    let version;
    if (versionId) {
      version = source === 'modrinth' ? await this.sources.modrinth.version(versionId) : (await this.sources.curseforge.files([versionId]))[0];
    } else {
      version = await this.bestVersion(source, id, inst, type);
    }
    if (!version) {
      const loaderName = inst.loader?.type === 'vanilla' ? 'vanilla' : inst.loader?.type;
      throw new Error(`${project?.title || 'This project'} has no version for Minecraft ${inst.mcVersion}${type === 'mod' ? ` + ${loaderName}` : ''}`);
    }
    return this.installVersion(instId, version, { type, project, report, withDeps });
  }

  async removeFiles(instId, rels) {
    await this.instances.withIndex(instId, async (idx) => {
      for (const rel of rels) {
        const p = this.instances.contentPath(instId, rel);
        await fsp.rm(p, { force: true });
        await fsp.rm(`${p}.disabled`, { force: true });
        delete idx.files[rel];
      }
    });
  }

  async setEnabled(instId, rel, enabled) {
    const on = this.instances.contentPath(instId, rel, true);
    const off = this.instances.contentPath(instId, rel, false);
    if (enabled && (await exists(off))) await fsp.rename(off, on);
    if (!enabled && (await exists(on))) await fsp.rename(on, off);
  }

  async setPinned(instId, rel, pinned) {
    await this.instances.withIndex(instId, (idx) => {
      idx.files[rel] = { ...(idx.files[rel] || {}), pinned: Boolean(pinned) };
    });
  }

  // ---- bulk actions (the content list's selection bar) ---------------------
  // Each one touches content.json at most once, however many files are selected.

  /** Enables or disables many files. This only renames files, so the index isn't touched. */
  async setEnabledMany(instId, rels, enabled) {
    let changed = 0;
    for (const rel of rels) {
      const from = this.instances.contentPath(instId, rel, !enabled);
      if (!(await exists(from))) continue;
      await this.setEnabled(instId, rel, enabled);
      changed++;
    }
    return { changed };
  }

  /** Pins or unpins many files with one index write. */
  async setPinnedMany(instId, rels, pinned) {
    for (const rel of rels) this.instances.contentPath(instId, rel); // rejects unsafe paths
    await this.instances.withIndex(instId, (idx) => {
      for (const rel of rels) if (idx.files[rel]) idx.files[rel].pinned = Boolean(pinned);
    });
    return { changed: rels.length };
  }

  /** A Markdown list (names + project links) of the chosen files, in the order given. */
  async markdownList(instId, rels) {
    const idx = await this.instances.readIndex(instId);
    return rels.map((rel) => {
      const e = idx.files[rel];
      if (!e) return null;
      const title = mdEscape(baseTitle(rel, e));
      const version = e.versionName || e.meta?.version;
      return `- ${e.projectUrl ? `[${title}](${e.projectUrl})` : title}${version && !String(version).includes('${') ? ` — ${version}` : ''}`;
    }).filter(Boolean).join('\n');
  }

  /**
   * Fills in client/server sides from Modrinth: for Modrinth mods linked before we stored them, and for every other
   * mod (CurseForge, local, pack) by looking its sha1 up on Modrinth. One bulk version_files request plus one bulk
   * projects request, one index write. Misses are remembered for 30 days (sidesChecked), so the lookup isn't repeated.
   */
  async refreshSides(instId) {
    const idx = await this.instances.readIndex(instId);
    const month = 30 * 24 * 3600e3;
    const mods = Object.entries(idx.files).filter(([rel, e]) => rel.startsWith('mods/') && !e.sides);
    const linked = mods.filter(([, e]) => e.source === 'modrinth' && e.projectId);
    const byHash = mods.filter(([, e]) => !(e.source === 'modrinth' && e.projectId) && e.sha1 && !(e.sidesChecked && Date.now() - e.sidesChecked < month));
    if (!linked.length && !byHash.length) return { updated: 0 };
    let versions = {};
    let hashLookupOk = false;
    if (byHash.length) {
      try { versions = await this.sources.modrinth.versionsByHash([...new Set(byHash.map(([, e]) => e.sha1))]); hashLookupOk = true; } catch { /* try again next time */ }
    }
    const pid = (e) => (e.source === 'modrinth' && e.projectId ? e.projectId : versions[e.sha1]?.projectId);
    const all = [...linked, ...byHash];
    const ids = [...new Set(all.map(([, e]) => pid(e)).filter(Boolean))];
    let byId = new Map();
    if (ids.length) {
      try { byId = new Map((await this.sources.modrinth.projects(ids)).map((p) => [p.id, p])); } catch { return { updated: 0 }; }
    }
    const hashRels = new Set(byHash.map(([r]) => r));
    const found = all.filter(([, e]) => sidesOf(byId.get(pid(e))));
    const misses = hashLookupOk ? byHash.filter(([, e]) => !sidesOf(byId.get(pid(e)))) : [];
    if (!found.length && !misses.length) return { updated: 0 };
    let updated = 0;
    await this.instances.withIndex(instId, (fresh) => {
      for (const [rel, old] of found) {
        if (!fresh.files[rel]) continue;
        fresh.files[rel].sides = sidesOf(byId.get(pid(old)));
        delete fresh.files[rel].sidesChecked;
        updated++;
      }
      for (const [rel] of misses) if (fresh.files[rel] && hashRels.has(rel)) fresh.files[rel].sidesChecked = Date.now();
    });
    return { updated };
  }

  /**
   * Copies the chosen files from one instance to another.
   *   Files linked to Modrinth / CurseForge: the best version for the TARGET's Minecraft version and
   *   loader is installed, with its dependencies. Local files: copied only if the loader matches.
   * Returns { installed, copied, skipped, unavailable, blocked, warnings }.
   */
  async sendToInstance(srcId, rels, targetId, { report = () => {} } = {}) {
    if (srcId === targetId) throw new Error('Pick a different instance to send these to.');
    const target = await this.instances.get(targetId);
    const srcIdx = await this.instances.readIndex(srcId);
    const out = { installed: [], copied: [], skipped: [], unavailable: [], blocked: [], warnings: [] };
    const okLoaders = compatibleLoaders(target.loader?.type, target.mcVersion);
    const forMods = target.loader?.type && target.loader.type !== 'vanilla' ? ` + ${target.loader.type}` : '';
    const copiedRels = [];
    let i = 0;
    for (const rel of rels) {
      report(i++ / Math.max(1, rels.length), `Sending ${baseTitle(rel, srcIdx.files[rel])}`);
      const e = srcIdx.files[rel];
      const type = DIR_TYPE[String(rel).split('/')[0]];
      const title = baseTitle(rel, e);
      if (!e || !type) { out.unavailable.push({ title, reason: 'not found in this instance' }); continue; }
      if (type === 'mod' && !okLoaders.length) { out.unavailable.push({ title, reason: 'the target instance has no mod loader (it is vanilla)' }); continue; }
      const summary = await this.installedSummary(targetId);

      if (e.source && e.source !== 'local' && e.projectId != null) {
        if (summary.byProject.has(`${e.source}:${e.projectId}`) || summary.titles.has(matchKey(title))) { out.skipped.push({ title, reason: 'already installed' }); continue; }
        if (e.meta?.modId && summary.modIds.has(e.meta.modId)) { out.skipped.push({ title, reason: `already provided by ${path.basename(summary.modIds.get(e.meta.modId))}` }); continue; }
        let version;
        try { version = await this.bestVersion(e.source, e.projectId, target, type); } catch (err) { out.unavailable.push({ title, reason: `couldn't check: ${describeError(err)}` }); continue; }
        if (!version) { out.unavailable.push({ title, reason: `no version for Minecraft ${target.mcVersion}${type === 'mod' ? forMods : ''}` }); continue; }
        try {
          const r = await this.installVersion(targetId, version, { type });
          out.installed.push(...r.installed);
          out.skipped.push(...r.skipped);
          out.blocked.push(...r.blocked);
          out.warnings.push(...r.warnings);
        } catch (err) {
          out.unavailable.push({ title, reason: err.message });
        }
        continue;
      }

      // A file that isn't linked to either site: copy it, but only if it can run on the target's loader.
      if (type === 'mod') {
        const loader = e.meta?.loader;
        if (!loader) { out.unavailable.push({ title, reason: "can't tell which loader this file is for" }); continue; }
        if (!okLoaders.includes(loader)) { out.unavailable.push({ title, reason: `built for ${loader}, but the target uses ${target.loader.type}` }); continue; }
        if (e.meta?.modId && summary.modIds.has(e.meta.modId)) { out.skipped.push({ title, reason: `already provided by ${path.basename(summary.modIds.get(e.meta.modId))}` }); continue; }
      }
      const dest = this.instances.contentPath(targetId, rel);
      if ((await exists(dest)) || (await exists(`${dest}.disabled`))) { out.skipped.push({ title, reason: 'a file with this name is already there' }); continue; }
      const onPath = this.instances.contentPath(srcId, rel, true);
      const from = (await exists(onPath)) ? onPath : this.instances.contentPath(srcId, rel, false);
      if (!(await exists(from))) { out.unavailable.push({ title, reason: 'the file is missing' }); continue; }
      await ensureDir(path.dirname(dest));
      await fsp.copyFile(from, dest);
      copiedRels.push(rel);
      out.copied.push({ title, file: rel });
    }
    if (copiedRels.length) {
      await this.instances.withIndex(targetId, (idx) => {
        for (const rel of copiedRels) idx.files[rel] = { sides: srcIdx.files[rel]?.sides, copiedFrom: srcId, installedAt: Date.now() };
      });
      if (copiedRels.some((r) => r.startsWith('mods/'))) {
        const nLocal = copiedRels.filter((r) => r.startsWith('mods/')).length;
        out.warnings.push(nLocal === 1
          ? `1 local mod was copied as it is. Junction can't tell which Minecraft version it's for, so check it works on ${target.mcVersion}.`
          : `${nLocal} local mods were copied as they are. Junction can't tell which Minecraft version they're for, so check they work on ${target.mcVersion}.`);
      }
    }
    return out;
  }

  async addLocalFiles(instId, filePaths, type = 'mod') {
    const dir = path.join(this.instances.gameDir(instId), TYPE_DIR[type]);
    await ensureDir(dir);
    const added = [];
    for (const f of filePaths) {
      const dest = path.join(dir, path.basename(f));
      await fsp.copyFile(f, dest);
      added.push(`${TYPE_DIR[type]}/${path.basename(f)}`);
    }
    await this.identify(instId, added);
    return added;
  }

  /**
   * Looks unknown files up on Modrinth (by SHA-1) and CurseForge (by fingerprint)
   * so imported or hand-copied mods become updatable.
   */
  async identify(instId, onlyRels = null, report = () => {}) {
    for (const t of Object.keys(TYPE_DIR)) await this.instances.listContent(instId, t); // refresh hashes
    const idx = await this.instances.readIndex(instId);
    const targets = Object.entries(idx.files).filter(([rel, e]) => (!onlyRels || onlyRels.includes(rel)) && (!e.source || e.source === 'local'));
    if (!targets.length) return { identified: 0, total: 0 };
    report(0.1, `Looking up ${targets.length} files on Modrinth`);
    const found = {};
    try {
      const bySha = await this.sources.modrinth.versionsByHash(targets.map(([, e]) => e.sha1).filter(Boolean));
      const projIds = [...new Set(Object.values(bySha).map((v) => v.projectId))];
      const projects = new Map((await this.sources.modrinth.projects(projIds)).map((p) => [p.id, p]));
      for (const [rel, e] of targets) {
        const v = bySha[e.sha1];
        if (!v) continue;
        const p = projects.get(v.projectId);
        const f = v.files.find((x) => x.sha1 === e.sha1) || pickFile(v);
        found[rel] = { source: 'modrinth', projectId: v.projectId, versionId: v.id, versionName: v.versionNumber, title: p?.title, icon: p?.icon, projectUrl: p?.url, slug: p?.slug, fileUrl: f?.url, sides: sidesOf(p) };
      }
    } catch (e) {
      report(null, `Modrinth lookup failed: ${e.message}`);
    }
    const remaining = targets.filter(([rel]) => !found[rel]);
    if (remaining.length && this.sources.curseforge.configured()) {
      report(0.5, `Looking up ${remaining.length} files on CurseForge`);
      try {
        const fps = {};
        await pool(remaining, 8, async ([rel]) => {
          const full = this.instances.contentPath(instId, rel);
          const p = (await exists(full)) ? full : `${full}.disabled`;
          fps[rel] = await curseFingerprintFile(p);
        });
        const matches = await this.sources.curseforge.byFingerprint(Object.values(fps));
        const modIds = [...new Set(Object.values(matches).map((m) => m.projectId))];
        const mods = new Map((await this.sources.curseforge.mods(modIds)).map((m) => [m.id, m]));
        for (const [rel] of remaining) {
          const m = matches[fps[rel]];
          if (!m) continue;
          const p = mods.get(m.projectId);
          found[rel] = { source: 'curseforge', projectId: m.projectId, versionId: m.version.id, versionName: m.version.versionNumber, title: p?.title, icon: p?.icon, projectUrl: p?.url, slug: p?.slug, fileUrl: m.version.files[0]?.url };
        }
      } catch (e) {
        report(null, `CurseForge lookup failed: ${e.message}`);
      }
    }
    await this.instances.withIndex(instId, (fresh) => {
      for (const [rel, info] of Object.entries(found)) fresh.files[rel] = { ...(fresh.files[rel] || {}), ...info };
    });
    return { identified: Object.keys(found).length, total: targets.length };
  }

  /** Finds newer compatible versions for everything that came from Modrinth or CurseForge. */
  async checkUpdates(instId) {
    const inst = await this.instances.get(instId);
    const all = [];
    for (const t of Object.keys(TYPE_DIR)) {
      for (const item of await this.instances.listContent(instId, t)) all.push({ ...item, type: t });
    }
    const idx = await this.instances.readIndex(instId);
    // A linked modpack's own files follow the pack (its updates), so only your additions are checked.
    if (isLinkedPack(inst)) for (let k = all.length - 1; k >= 0; k--) if (all[k].fromPack) all.splice(k, 1);
    const updates = [];
    const loaders = compatibleLoaders(inst.loader?.type, inst.mcVersion);

    // Modrinth: one request per content type using file hashes.
    for (const t of Object.keys(TYPE_DIR)) {
      const items = all.filter((i) => i.type === t && i.source === 'modrinth' && !i.pinned && idx.files[i.file]?.sha1);
      if (!items.length) continue;
      try {
        const hashes = items.map((i) => idx.files[i.file].sha1);
        let installed = {};
        try { installed = await this.sources.modrinth.versionsByHash(hashes); } catch { /* without it the loader check is skipped */ }
        // Other kinds of content have their own "loader" (minecraft = resource pack, datapack...), so ask for the same kind as the installed file.
        const groups = new Map();
        for (const i of items) {
          const sha = idx.files[i.file].sha1;
          const key = t === 'mod' ? '' : (installed[sha]?.loaders || []).join(',');
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(i);
        }
        const latest = {};
        for (const [key, list] of groups) {
          Object.assign(latest, await this.sources.modrinth.latestByHash(list.map((i) => idx.files[i.file].sha1), {
            loaders: t === 'mod' ? loaders : (key ? key.split(',') : undefined), gameVersions: [inst.mcVersion],
          }));
        }
        for (const i of items) {
          const sha = idx.files[i.file].sha1;
          const v = latest[sha];
          if (v && v.id !== i.versionId && !v.files.some((f) => f.sha1 === sha) && sameVariant(installed[sha], v)) {
            updates.push({ file: i.file, title: i.title, icon: i.icon, type: t, source: 'modrinth', current: i.versionName, currentVersionId: i.versionId, currentReleaseType: installed[sha]?.releaseType, projectId: i.projectId, next: v.versionNumber, version: v });
          }
        }
      } catch (e) { updates.push({ error: siteError('Modrinth', e) }); }
    }

    // CurseForge: latestFilesIndexes gives the newest file per game version + loader.
    const cfItems = all.filter((i) => i.source === 'curseforge' && !i.pinned && i.projectId);
    if (cfItems.length && this.sources.curseforge.configured()) {
      try {
        const mods = new Map((await this.sources.curseforge.mods(cfItems.map((i) => i.projectId))).map((m) => [String(m.id), m]));
        const wanted = [];
        for (const i of cfItems) {
          const m = mods.get(String(i.projectId));
          if (!m) continue;
          const loaderTypes = loaders.map((l) => LOADER_TYPE[l]);
          const cands = m.latestFilesIndexes.filter((x) => x.gameVersion === inst.mcVersion && (i.type !== 'mod' || x.modLoader == null || loaderTypes.includes(x.modLoader)));
          const best = cands.sort((a, b) => (a.releaseType - b.releaseType) || (b.fileId - a.fileId))[0];
          if (best && Number(best.fileId) > Number(i.versionId)) {
            const mine = m.latestFilesIndexes.find((x) => String(x.fileId) === String(i.versionId));
            wanted.push({ item: i, fileId: best.fileId, project: m, currentReleaseType: mine ? CF_RELEASE[mine.releaseType] : undefined });
          }
        }
        const files = new Map((await this.sources.curseforge.files(wanted.map((w) => w.fileId))).map((f) => [f.id, f]));
        for (const w of wanted) {
          const v = files.get(w.fileId);
          if (v && sameVariant({ versionNumber: w.item.versionName }, v)) updates.push({ file: w.item.file, title: w.item.title, icon: w.item.icon, type: w.item.type, source: 'curseforge', current: w.item.versionName, currentVersionId: w.item.versionId, currentReleaseType: w.currentReleaseType, projectId: w.item.projectId, next: v.versionNumber, version: v, project: w.project });
        }
      } catch (e) { updates.push({ error: siteError('CurseForge', e) }); }
    }
    return updates;
  }

  /** Newer compatible versions of a project than the one installed (newest first), for the update picker. */
  async updateCandidates(instId, { source, projectId, type, currentVersionId }) {
    const inst = await this.instances.get(instId);
    const list = await this.compatibleVersions(source, projectId, inst, type);
    const cur = list.find((v) => String(v.id) === String(currentVersionId));
    const curDate = cur ? new Date(cur.date).getTime() : null;
    return list
      .filter((v) => String(v.id) !== String(currentVersionId) && (curDate === null || new Date(v.date).getTime() > curDate) && sameVariant(cur, v))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 60)
      .map((v) => ({ ...v, changelog: undefined }));
  }

  backupsDir(instId) {
    return path.join(this.instances.instDir(instId), 'backups', 'updates');
  }

  /**
   * Installs the chosen versions. Every replaced file is backed up first so the
   * whole batch can be undone with undoUpdate().
   */
  async applyUpdates(instId, updates, report = () => {}) {
    const out = { installed: [], blocked: [], warnings: [], backup: null };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bdir = path.join(this.backupsDir(instId), stamp);
    const before = await this.instances.readIndex(instId);
    const record = { stamp, date: Date.now(), items: [] };
    const locked = new Set(await this.lockedRels(instId, updates.map((u) => u.file)));
    let i = 0;
    for (const u of updates) {
      if (!u.version) continue;
      if (locked.has(u.file)) { out.warnings.push(`${u.title} is part of the modpack. It changes with pack updates.`); continue; }
      report(i++ / updates.length, `Updating ${u.title}`);
      const onPath = this.instances.contentPath(instId, u.file, true);
      const offPath = this.instances.contentPath(instId, u.file, false);
      const wasDisabled = !(await exists(onPath)) && (await exists(offPath));
      const src = wasDisabled ? offPath : onPath;
      let backup = null;
      if (await exists(src)) {
        backup = u.file + (wasDisabled ? '.disabled' : '');
        await ensureDir(path.dirname(path.join(bdir, backup)));
        await fsp.copyFile(src, path.join(bdir, backup));
      }
      let r;
      try {
        r = await this.installVersion(instId, u.version, { type: u.type, project: u.project || null, withDeps: true });
      } catch (e) {
        out.warnings.push(`${u.title}: ${e.message}`);
        continue;
      }
      const newRels = r.installed.map((x) => x.file);
      if (wasDisabled && newRels[0]) await this.setEnabled(instId, newRels[0], false);
      record.items.push({ title: u.title, oldRel: u.file, backup, oldEntry: before.files[u.file] || null, newRels, from: u.current || '', to: u.version.versionNumber });
      out.installed.push(...r.installed);
      out.blocked.push(...r.blocked);
      out.warnings.push(...r.warnings);
    }
    if (record.items.length) {
      await writeJson(path.join(bdir, 'update.json'), record);
      out.backup = stamp;
      // Keep the most recent update backups (Settings → Downloads & storage, 5 by default).
      const keep = Math.max(1, Number(this.ctx.settings.get('backupsKept')) || 5);
      const all = (await fsp.readdir(this.backupsDir(instId)).catch(() => [])).sort().reverse();
      for (const old of all.slice(keep)) await fsp.rm(path.join(this.backupsDir(instId), old), { recursive: true, force: true });
    }
    return out;
  }

  async updateHistory(instId) {
    const out = [];
    for (const name of (await fsp.readdir(this.backupsDir(instId)).catch(() => [])).sort().reverse()) {
      const rec = await readJson(path.join(this.backupsDir(instId), name, 'update.json'), null);
      if (rec) out.push({ stamp: rec.stamp, date: rec.date, items: rec.items.map(({ title, from, to }) => ({ title, from, to })) });
    }
    return out;
  }

  /** Puts back the exact files an update replaced, and removes what it added. */
  async undoUpdate(instId, stamp) {
    if (!/^[\w-]+$/.test(String(stamp))) throw new Error('Bad backup id');
    const bdir = path.join(this.backupsDir(instId), stamp);
    const rec = await readJson(path.join(bdir, 'update.json'), null);
    if (!rec) throw new Error('That update backup no longer exists.');
    for (const item of [...rec.items].reverse()) {
      await this.removeFiles(instId, item.newRels);
      if (item.backup) {
        const disabled = item.backup.endsWith('.disabled');
        const dest = this.instances.contentPath(instId, item.oldRel, !disabled);
        await ensureDir(path.dirname(dest));
        await fsp.copyFile(path.join(bdir, item.backup), dest);
      }
      if (item.oldEntry) await this.instances.withIndex(instId, (idx) => { idx.files[item.oldRel] = item.oldEntry; });
    }
    await fsp.rm(bdir, { recursive: true, force: true });
    return { restored: rec.items.length };
  }

  /** Called when a user supplies a file we couldn't download automatically. */
  async acceptManualFile(instId, blockedItem, filePath) {
    if (blockedItem.sha1) {
      const got = await hashFile(filePath, 'sha1');
      if (got !== blockedItem.sha1) throw new Error(`${path.basename(filePath)} doesn't match the expected file (SHA-1 mismatch).`);
    }
    const dest = this.instances.contentPath(instId, blockedItem.rel);
    await ensureDir(path.dirname(dest));
    await fsp.copyFile(filePath, dest);
    const st = await fsp.stat(dest);
    const meta = blockedItem.rel.startsWith('mods/') ? readModMetadata(dest) : null;
    await this.instances.withIndex(instId, (idx) => {
      idx.files[blockedItem.rel] = {
        source: blockedItem.source, projectId: blockedItem.projectId, versionId: blockedItem.versionId, title: blockedItem.title,
        versionName: blockedItem.versionName, icon: blockedItem.icon, projectUrl: blockedItem.projectUrl, sha1: blockedItem.sha1,
        fromPack: Boolean(blockedItem.fromPack), meta, metaSize: st.size, metaMtime: st.mtimeMs, installedAt: Date.now(),
      };
    });
  }
}

module.exports = { ContentManager, pickFile, versionSupports, sidesOf };
