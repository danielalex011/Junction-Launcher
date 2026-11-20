'use strict';
// Modpack import (.mrpack and CurseForge .zip), install from search, and updates.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');
const { TYPE_DIR } = require('../instances');
const { CurseForge } = require('../sources/curseforge');
const { parseLoaderId } = require('../loaders');
const { readModMetadata } = require('./metadata');
const { pickFile } = require('./manager');
const { safeJoin, ensureDir, pool, exists, shortId } = require('../util');

function detectPackFormat(zip) {
  if (zip.getEntry('modrinth.index.json')) return 'mrpack';
  const m = zip.getEntry('manifest.json');
  if (m) {
    try {
      const j = JSON.parse(zip.readAsText(m));
      if (j.manifestType === 'minecraftModpack' || j.minecraft) return 'curseforge';
    } catch { /* not a pack */ }
  }
  return null;
}

function mrpackLoader(deps) {
  if (deps['fabric-loader']) return { type: 'fabric', version: deps['fabric-loader'] };
  if (deps['quilt-loader']) return { type: 'quilt', version: deps['quilt-loader'] };
  if (deps.neoforge) return { type: 'neoforge', version: deps.neoforge };
  if (deps.forge) return { type: 'forge', version: deps.forge };
  return { type: 'vanilla' };
}

async function extractOverrides(zip, prefixes, gameDir) {
  let count = 0;
  for (const prefix of prefixes) {
    const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
    for (const e of zip.getEntries()) {
      if (e.isDirectory || !e.entryName.startsWith(p)) continue;
      const rel = e.entryName.slice(p.length);
      if (!rel) continue;
      const dest = safeJoin(gameDir, rel);
      await ensureDir(path.dirname(dest));
      await fsp.writeFile(dest, e.getData());
      count++;
    }
  }
  return count;
}

function folderType(rel) {
  const top = rel.split('/')[0];
  return { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader' }[top] || null;
}

class Modpacks {
  constructor(ctx, instances, content, sources) {
    this.ctx = ctx;
    this.instances = instances;
    this.content = content;
    this.sources = sources;
  }

  /** Backs up config + removes files the old pack version installed. */
  async prepareUpdate(instId) {
    const gameDir = this.instances.gameDir(instId);
    const backupDir = path.join(this.instances.instDir(instId), 'backups');
    await ensureDir(backupDir);
    const cfg = path.join(gameDir, 'config');
    if (await exists(cfg)) {
      const zip = new AdmZip();
      zip.addLocalFolder(cfg, 'config');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      zip.writeZip(path.join(backupDir, `config-before-update-${stamp}.zip`));
    }
    const idx = await this.instances.readIndex(instId);
    const packFiles = Object.entries(idx.files).filter(([, e]) => e.fromPack).map(([rel]) => rel);
    await this.content.removeFiles(instId, packFiles);
  }

  async installFile(zipPath, { name, icon, pack, instanceId, report = () => {} } = {}) {
    const zip = new AdmZip(zipPath);
    const fmt = detectPackFormat(zip);
    if (fmt === 'mrpack') return this.installMrpack(zip, { name, icon, pack, instanceId, report });
    if (fmt === 'curseforge') return this.installCurseForge(zip, { name, icon, pack, instanceId, report });
    throw new Error('This file is not a Modrinth (.mrpack) or CurseForge modpack.');
  }

  async createOrReuse(instanceId, { name, mcVersion, loader, icon, pack }) {
    if (instanceId) {
      await this.prepareUpdate(instanceId);
      return this.instances.update(instanceId, { mcVersion, loader, pack, ...(icon ? { icon } : {}) });
    }
    return this.instances.create({ name, mcVersion, loader, icon, pack });
  }

  async installMrpack(zip, { name, icon, pack, instanceId, report }) {
    const index = JSON.parse(zip.readAsText('modrinth.index.json'));
    if (index.game !== 'minecraft') throw new Error('Not a Minecraft modpack');
    const deps = index.dependencies || {};
    const inst = await this.createOrReuse(instanceId, {
      name: name || index.name, mcVersion: deps.minecraft, loader: mrpackLoader(deps), icon,
      pack: pack || { source: 'file', name: index.name, versionName: index.versionId },
    });
    const gameDir = this.instances.gameDir(inst.id);
    const includeOptional = this.ctx.settings.get('includeOptionalPackFiles') !== false;
    const files = (index.files || []).filter((f) => {
      const env = f.env?.client;
      return env !== 'unsupported' && (env !== 'optional' || includeOptional);
    });
    const warnings = [];
    let done = 0;
    const { errors } = await pool(files, this.ctx.settings.get('concurrency') || 16, async (f) => {
      const dest = safeJoin(gameDir, f.path);
      const urls = (f.downloads || []).filter((u) => /^https:\/\//i.test(u));
      if (!urls.length) throw new Error(`${f.path}: no https download URL`);
      let lastErr;
      for (const u of urls) {
        try {
          await this.ctx.http.download(u, dest, { sha1: f.hashes?.sha1, sha512: f.hashes?.sha512, size: f.fileSize });
          lastErr = null;
          break;
        } catch (e) { lastErr = e; }
      }
      if (lastErr) throw lastErr;
      done++;
      report(0.1 + 0.7 * (done / files.length), `Downloading pack files ${done}/${files.length}`);
    });
    for (const e of errors) warnings.push(`${e.item.path}: ${e.error.message}`);
    report(0.82, 'Applying overrides');
    await extractOverrides(zip, ['overrides', 'client-overrides'], gameDir);

    // Record where every file came from so updates & exports work later.
    report(0.88, 'Identifying files');
    const sha1s = files.map((f) => f.hashes?.sha1).filter(Boolean);
    let bySha = {};
    let projects = new Map();
    try {
      bySha = await this.sources.modrinth.versionsByHash(sha1s);
      projects = new Map((await this.sources.modrinth.projects([...new Set(Object.values(bySha).map((v) => v.projectId))])).map((p) => [p.id, p]));
    } catch (e) { warnings.push(`Couldn't identify pack files on Modrinth: ${e.message}`); }
    await this.instances.withIndex(inst.id, async (idx) => {
      for (const f of files) {
        const rel = f.path.replace(/\\/g, '/');
        if (!folderType(rel)) continue;
        const v = bySha[f.hashes?.sha1];
        const p = v ? projects.get(v.projectId) : null;
        const full = safeJoin(gameDir, rel);
        const meta = rel.startsWith('mods/') && (await exists(full)) ? readModMetadata(full) : null;
        idx.files[rel] = {
          ...(idx.files[rel] || {}),
          source: v ? 'modrinth' : 'local', projectId: v?.projectId, versionId: v?.id, versionName: v?.versionNumber,
          title: p?.title, icon: p?.icon, projectUrl: p?.url, slug: p?.slug, sha1: f.hashes?.sha1, fileUrl: f.downloads?.[0], fromPack: true, meta,
        };
      }
    });
    report(1, 'Done');
    return { instance: await this.instances.get(inst.id), blocked: [], warnings };
  }

  async installCurseForge(zip, { name, icon, pack, instanceId, report }) {
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    const mc = manifest.minecraft?.version;
    const loaderEntry = (manifest.minecraft?.modLoaders || []).find((l) => l.primary) || manifest.minecraft?.modLoaders?.[0];
    const loader = loaderEntry ? parseLoaderId(loaderEntry.id) || { type: 'vanilla' } : { type: 'vanilla' };
    const fileRefs = (manifest.files || []).filter((f) => f.required !== false);
    if (fileRefs.length && !this.sources.curseforge.configured()) {
      throw new Error('This is a CurseForge modpack. Add your CurseForge API key in Settings to install it.');
    }
    const inst = await this.createOrReuse(instanceId, {
      name: name || manifest.name, mcVersion: mc, loader, icon,
      pack: pack || { source: 'file', name: manifest.name, versionName: manifest.version },
    });
    const gameDir = this.instances.gameDir(inst.id);
    report(0.05, `Resolving ${fileRefs.length} CurseForge files`);
    const versions = new Map((await this.sources.curseforge.files(fileRefs.map((f) => f.fileID))).map((v) => [v.id, v]));
    const projects = new Map((await this.sources.curseforge.mods([...new Set(fileRefs.map((f) => f.projectID))])).map((p) => [p.id, p]));
    const blocked = [];
    const warnings = [];
    const jobs = [];
    for (const ref of fileRefs) {
      const v = versions.get(ref.fileID);
      const p = projects.get(ref.projectID);
      if (!v) { warnings.push(`File ${ref.fileID} (project ${ref.projectID}) no longer exists on CurseForge`); continue; }
      const type = p?.type && TYPE_DIR[p.type] ? p.type : 'mod';
      const file = pickFile(v);
      const rel = `${TYPE_DIR[type]}/${file.filename}`;
      const item = {
        title: p?.title || v.name, fileName: file.filename, sha1: file.sha1, size: file.size, rel,
        dest: safeJoin(gameDir, rel), source: 'curseforge', projectId: ref.projectID, versionId: v.id,
        icon: p?.icon || null, projectUrl: p?.url || null, versionName: v.versionNumber, fromPack: true,
        pageUrl: CurseForge.manualDownloadUrl(p, v.id), url: file.url, type,
      };
      if (!file.url) blocked.push(item); else jobs.push(item);
    }
    let done = 0;
    const { errors } = await pool(jobs, this.ctx.settings.get('concurrency') || 16, async (j) => {
      await this.ctx.http.download(j.url, j.dest, { sha1: j.sha1, size: j.size });
      done++;
      report(0.1 + 0.75 * (done / Math.max(1, jobs.length)), `Downloading mods ${done}/${jobs.length}`);
    });
    for (const e of errors) warnings.push(`${e.item.fileName}: ${e.error.message}`);
    report(0.88, 'Applying overrides');
    await extractOverrides(zip, [manifest.overrides || 'overrides'], gameDir);
    const failed = new Set(errors.map((e) => e.item.rel));
    await this.instances.withIndex(inst.id, async (idx) => {
      for (const j of jobs) {
        if (failed.has(j.rel)) continue;
        const meta = j.type === 'mod' && (await exists(j.dest)) ? readModMetadata(j.dest) : null;
        idx.files[j.rel] = {
          source: 'curseforge', projectId: j.projectId, versionId: j.versionId, title: j.title, versionName: j.versionName,
          icon: j.icon, projectUrl: j.projectUrl, sha1: j.sha1, fileUrl: j.url, fromPack: true, meta,
        };
      }
    });
    report(1, blocked.length ? `${blocked.length} files need a manual download` : 'Done');
    return { instance: await this.instances.get(inst.id), blocked, warnings };
  }

  /** Install a pack picked in the Browse page (or update an existing instance to a new version). */
  async installFromSource({ source, projectId, versionId, instanceId, report = () => {} }) {
    const project = source === 'modrinth' ? await this.sources.modrinth.project(projectId) : (await this.sources.curseforge.mods([projectId]))[0];
    let version;
    if (versionId) {
      version = source === 'modrinth' ? await this.sources.modrinth.version(versionId) : (await this.sources.curseforge.files([versionId]))[0];
    } else {
      const list = await this.sources[source].versions(projectId, {});
      version = list.find((v) => v.releaseType === 'release') || list[0];
    }
    if (!version) throw new Error('No downloadable version of this modpack was found');
    const file = pickFile(version);
    if (!file.url) {
      const e = new Error(`The author of ${project.title} only allows downloads from the CurseForge website. Download the zip there, then use Import → From file.`);
      e.manualUrl = CurseForge.manualDownloadUrl(project, version.id);
      throw e;
    }
    report(0.02, `Downloading ${file.filename}`);
    const cached = path.join(this.ctx.paths.cache, 'packs', `${shortId(6)}-${file.filename}`);
    await this.ctx.http.download(file.url, cached, { sha1: file.sha1, sha512: file.sha512, size: file.size });
    try {
      return await this.installFile(cached, {
        name: project.title,
        icon: project.icon,
        instanceId,
        pack: { source, projectId, versionId: version.id, name: project.title, versionName: version.versionNumber, url: project.url },
        report,
      });
    } finally {
      await fsp.rm(cached, { force: true });
    }
  }

  async checkPackUpdate(instId) {
    const inst = await this.instances.get(instId);
    if (!inst.pack || !['modrinth', 'curseforge'].includes(inst.pack.source)) return null;
    const list = await this.sources[inst.pack.source].versions(inst.pack.projectId, {});
    const latest = list.find((v) => v.releaseType === 'release') || list[0];
    if (!latest || String(latest.id) === String(inst.pack.versionId)) return null;
    return { versionId: latest.id, versionName: latest.versionNumber, date: latest.date };
  }
}

module.exports = { Modpacks, detectPackFormat, mrpackLoader, extractOverrides };
