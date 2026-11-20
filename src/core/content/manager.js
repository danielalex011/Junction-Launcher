'use strict';
// Installing, updating, identifying and removing mods / resource packs / shaders.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { TYPE_DIR } = require('../instances');
const { compatibleLoaders } = require('../sources');
const { CurseForge, LOADER_TYPE } = require('../sources/curseforge');
const { curseFingerprintFile } = require('../sources/fingerprint');
const { readModMetadata } = require('./metadata');
const { matchKey, exists, hashFile, ensureDir, pool } = require('../util');

const RANK = { release: 0, beta: 1, alpha: 2 };

function pickFile(version) {
  return version.files.find((f) => f.primary) || version.files[0];
}

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
    return [...list].sort((a, b) => (RANK[a.releaseType] - RANK[b.releaseType]) || (new Date(b.date) - new Date(a.date)))[0];
  }

  async projectInfo(source, projectId) {
    if (source === 'modrinth') return this.sources.modrinth.project(projectId);
    const [m] = await this.sources.curseforge.mods([projectId]);
    return m;
  }

  /** Summary of what's installed, for duplicate / dependency checks. */
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
          icon: proj?.icon || null, projectUrl: proj?.url || null, slug: proj?.slug, fileUrl: file.url,
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

  async installProject(instId, { source, id }, type = 'mod', { versionId, report } = {}) {
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
    return this.installVersion(instId, version, { type, project, report });
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
        found[rel] = { source: 'modrinth', projectId: v.projectId, versionId: v.id, versionName: v.versionNumber, title: p?.title, icon: p?.icon, projectUrl: p?.url, slug: p?.slug, fileUrl: f?.url };
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
    const updates = [];
    const loaders = compatibleLoaders(inst.loader?.type, inst.mcVersion);

    // Modrinth: one request per content type using file hashes.
    for (const t of Object.keys(TYPE_DIR)) {
      const items = all.filter((i) => i.type === t && i.source === 'modrinth' && !i.pinned && idx.files[i.file]?.sha1);
      if (!items.length) continue;
      try {
        const latest = await this.sources.modrinth.latestByHash(items.map((i) => idx.files[i.file].sha1), {
          loaders: t === 'mod' ? loaders : undefined, gameVersions: [inst.mcVersion],
        });
        for (const i of items) {
          const v = latest[idx.files[i.file].sha1];
          if (v && v.id !== i.versionId && !v.files.some((f) => f.sha1 === idx.files[i.file].sha1)) {
            updates.push({ file: i.file, title: i.title, type: t, source: 'modrinth', current: i.versionName, next: v.versionNumber, version: v });
          }
        }
      } catch (e) { updates.push({ error: `Modrinth: ${e.message}` }); }
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
          if (best && Number(best.fileId) > Number(i.versionId)) wanted.push({ item: i, fileId: best.fileId, project: m });
        }
        const files = new Map((await this.sources.curseforge.files(wanted.map((w) => w.fileId))).map((f) => [f.id, f]));
        for (const w of wanted) {
          const v = files.get(w.fileId);
          if (v) updates.push({ file: w.item.file, title: w.item.title, type: w.item.type, source: 'curseforge', current: w.item.versionName, next: v.versionNumber, version: v, project: w.project });
        }
      } catch (e) { updates.push({ error: `CurseForge: ${e.message}` }); }
    }
    return updates;
  }

  async applyUpdates(instId, updates, report = () => {}) {
    const out = { installed: [], blocked: [], warnings: [] };
    let i = 0;
    for (const u of updates) {
      if (!u.version) continue;
      report(i++ / updates.length, `Updating ${u.title}`);
      const r = await this.installVersion(instId, u.version, { type: u.type, project: u.project || null, withDeps: true });
      out.installed.push(...r.installed);
      out.blocked.push(...r.blocked);
      out.warnings.push(...r.warnings);
    }
    return out;
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

module.exports = { ContentManager, pickFile, versionSupports };
