'use strict';
// Modpack import (.mrpack and CurseForge .zip), install from search, updates,
// retrying failed downloads, and repairing an installed pack.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');
const { TYPE_DIR, CONTENT_EXT } = require('../instances');
const { CurseForge } = require('../sources/curseforge');
const { parseLoaderId } = require('../loaders');
const { readModMetadata } = require('./metadata');
const { pickFile } = require('./manager');
const { describeError, isRetryable } = require('../http');
const { currentTask } = require('../taskcontext');
const { safeJoin, ensureDir, pool, exists, shortId, hashFile, hashBuffer } = require('../util');

// How many pack files to fetch at once. The CDNs also have their own gentler
// limit inside http.download, because they answer "503 first byte timeout" when pushed.
const DOWNLOAD_CONCURRENCY = 8;

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

/** Extracts override folders into the game directory. Pass an array as `collect` to learn which files were written. */
async function extractOverrides(zip, prefixes, gameDir, collect = null) {
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
      if (collect) collect.push(rel.replace(/\\/g, '/'));
      count++;
    }
  }
  return count;
}

function folderType(rel) {
  const top = rel.split('/')[0];
  return { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader' }[top] || null;
}

/** The content type if rel is a file the content list shows (mods/x.jar, resourcepacks/x.zip, ...), else null. */
function contentType(rel) {
  const type = rel.split('/').length === 2 ? folderType(rel) : null;
  return type && CONTENT_EXT[type].some((e) => rel.toLowerCase().endsWith(e)) ? type : null;
}

const normRel = (p) => String(p).replace(/\\/g, '/');

/** Checks a file on disk (enabled, or disabled with a .disabled suffix) against its hash. */
async function fileState(dest, { sha1, sha512, size } = {}) {
  const off = `${dest}.disabled`;
  const onExists = await exists(dest);
  const offExists = !onExists && (await exists(off));
  const present = onExists ? dest : offExists ? off : null;
  if (!present) return { state: 'missing', disabled: false };
  let ok = true;
  if (sha1) ok = (await hashFile(present, 'sha1')) === String(sha1).toLowerCase();
  else if (sha512) ok = (await hashFile(present, 'sha512')) === String(sha512).toLowerCase();
  else if (size) ok = (await fsp.stat(present)).size === size;
  return { state: ok ? 'ok' : 'wrong', disabled: offExists };
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
    const created = await this.instances.create({ name, mcVersion, loader, icon, pack });
    // If the user cancels this install, the half-made instance goes away with it.
    const task = currentTask();
    if (task) {
      task.setInstance(created.id);
      task.onCancel(() => this.instances.remove(created.id));
    }
    return created;
  }

  // ---- downloading with a second chance ----------------------------------------------------

  /**
   * Downloads jobs a few at a time, then gives whatever failed for a temporary reason one more
   * go after a short pause. Returns [{ item, error }] for what still failed.
   */
  async downloadAll(jobs, run, progress = () => {}) {
    let done = 0;
    const pass = (list, count) => pool(list, DOWNLOAD_CONCURRENCY, async (job) => { await run(job); done++; progress(done, jobs.length); }, { count });
    const first = await pass(jobs, true);
    const again = first.errors.filter((e) => isRetryable(e.error));
    if (!again.length) return first.errors;
    await this.ctx.http.sleep(this.ctx.http.retryDelays[0] || 0); // let the server breathe
    const second = await pass(again.map((e) => e.item), false);
    return [...first.errors.filter((e) => !isRetryable(e.error)), ...second.errors];
  }

  /** Tries each https URL in turn. */
  async fetchFirst(urls, dest, { sha1, sha512, size } = {}) {
    const usable = (urls || []).filter((u) => typeof u === 'string' && /^https:\/\//i.test(u));
    if (!usable.length) throw new Error('no https download URL');
    let lastErr;
    for (const u of usable) {
      try { await this.ctx.http.download(u, dest, { sha1, sha512, size }); return; } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  /** Writes (or clears) the list of files that couldn't be downloaded, in content.json, with what's needed to try again. */
  async recordFailures(instId, records) {
    await this.instances.withIndex(instId, (idx) => {
      if (records.length) idx.failed = Object.fromEntries(records.map((r) => [r.path, r]));
      else delete idx.failed;
    });
  }

  /** What the UI shows: names and a plain reason, never URLs or HTML. */
  async failedDownloads(instId) {
    const idx = await this.instances.readIndex(instId);
    return Object.values(idx.failed || {}).map((r) => ({ path: r.path, name: path.basename(r.path), error: r.error }));
  }

  mrpackRecord(f, error) {
    return { path: normRel(f.path), urls: f.downloads || [], hashes: { sha1: f.hashes?.sha1, sha512: f.hashes?.sha512 }, size: f.fileSize, source: 'modrinth', error: describeError(error), at: Date.now() };
  }

  cfRecord(j, error) {
    return {
      path: j.rel, urls: [j.url], hashes: { sha1: j.sha1 }, size: j.size, source: 'curseforge', error: describeError(error), at: Date.now(),
      cf: { projectId: j.projectId, versionId: j.versionId, title: j.title, versionName: j.versionName, icon: j.icon, projectUrl: j.projectUrl, type: j.type },
    };
  }

  // ---- recording where files came from -------------------------------------------------------

  /** Looks downloaded .mrpack files up on Modrinth (by hash) and records them in content.json. */
  async indexMrpackFiles(instId, gameDir, files, warnings = []) {
    const sha1s = files.map((f) => f.hashes?.sha1).filter(Boolean);
    let bySha = {};
    let projects = new Map();
    try {
      if (sha1s.length) {
        bySha = await this.sources.modrinth.versionsByHash(sha1s);
        projects = new Map((await this.sources.modrinth.projects([...new Set(Object.values(bySha).map((v) => v.projectId))])).map((p) => [p.id, p]));
      }
    } catch (e) { warnings.push(`Couldn't identify pack files on Modrinth: ${describeError(e)}`); }
    await this.instances.withIndex(instId, async (idx) => {
      for (const f of files) {
        const rel = normRel(f.path);
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
  }

  async indexCurseForgeItems(instId, items) {
    await this.instances.withIndex(instId, async (idx) => {
      for (const j of items) {
        const meta = j.type === 'mod' && (await exists(j.dest)) ? readModMetadata(j.dest) : null;
        idx.files[j.rel] = {
          source: 'curseforge', projectId: j.projectId, versionId: j.versionId, title: j.title, versionName: j.versionName,
          icon: j.icon, projectUrl: j.projectUrl, sha1: j.sha1, fileUrl: j.url, fromPack: true, meta,
        };
      }
    });
  }

  /**
   * Marks files the pack ships itself (from overrides/) as coming from the pack, so they get a
   * "Pack" badge instead of "Local" and are left out of the "not linked" notice and the lookups.
   * keepIdentified: don't touch files already linked to a Modrinth / CurseForge project.
   */
  async recordPackShipped(instId, gameDir, rels, { keepIdentified = false } = {}) {
    const list = [...new Set(rels.map(normRel))].filter((r) => contentType(r));
    if (!list.length) return 0;
    let marked = 0;
    await this.instances.withIndex(instId, async (idx) => {
      for (const rel of list) {
        if (keepIdentified && idx.files[rel]?.projectId != null) continue;
        const full = safeJoin(gameDir, rel);
        const present = (await exists(full)) ? full : (await exists(`${full}.disabled`)) ? `${full}.disabled` : null;
        if (!present) continue;
        idx.files[rel] = {
          ...(idx.files[rel] || {}),
          source: 'pack', projectId: undefined, versionId: undefined, versionName: undefined, title: undefined, icon: undefined, projectUrl: undefined, slug: undefined,
          fromPack: true, sha1: await hashFile(present, 'sha1'), meta: rel.startsWith('mods/') ? readModMetadata(present) : null,
          metaSize: undefined, metaMtime: undefined,
        };
        marked++;
      }
    });
    return marked;
  }

  // ---- installing -------------------------------------------------------------------------

  /** The pack's files that apply to a client install, with any unsafe path left out (and reported). */
  mrpackFiles(index, gameDir, warnings) {
    const includeOptional = this.ctx.settings.get('includeOptionalPackFiles') !== false;
    const out = [];
    for (const f of index.files || []) {
      const env = f.env?.client;
      if (env === 'unsupported' || (env === 'optional' && !includeOptional)) continue;
      try { safeJoin(gameDir, f.path); } catch (e) { warnings.push(`${f.path}: ${e.message}`); continue; }
      out.push(f);
    }
    return out;
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
    const warnings = [];
    const files = this.mrpackFiles(index, gameDir, warnings);
    const errors = await this.downloadAll(files, (f) => this.fetchFirst(f.downloads, safeJoin(gameDir, f.path), { sha1: f.hashes?.sha1, sha512: f.hashes?.sha512, size: f.fileSize }),
      (done, total) => report(0.1 + 0.7 * (done / Math.max(1, total)), `Downloading pack files ${done}/${total}`));
    const failedFiles = new Set(errors.map((e) => e.item));
    report(0.82, 'Applying overrides');
    const shipped = [];
    await extractOverrides(zip, ['overrides', 'client-overrides'], gameDir, shipped);

    // Record where every file came from so updates & exports work later.
    report(0.88, 'Identifying files');
    await this.indexMrpackFiles(inst.id, gameDir, files.filter((f) => !failedFiles.has(f)), warnings);
    await this.recordPackShipped(inst.id, gameDir, shipped);
    await this.recordFailures(inst.id, errors.map((e) => this.mrpackRecord(e.item, e.error)));
    report(1, 'Done');
    return { instance: await this.instances.get(inst.id), blocked: [], failed: await this.failedDownloads(inst.id), warnings };
  }

  /** Works out what to fetch for a CurseForge manifest. Files whose author blocks downloads go to `blocked`. */
  async resolveCurseForge(manifest, gameDir, report = () => {}) {
    const fileRefs = (manifest.files || []).filter((f) => f.required !== false);
    report(0.05, `Resolving ${fileRefs.length} CurseForge files`);
    const versions = new Map((await this.sources.curseforge.files(fileRefs.map((f) => f.fileID))).map((v) => [v.id, v]));
    const projects = new Map((await this.sources.curseforge.mods([...new Set(fileRefs.map((f) => f.projectID))])).map((p) => [p.id, p]));
    const blocked = [];
    const jobs = [];
    const warnings = [];
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
    return { jobs, blocked, warnings };
  }

  async installCurseForge(zip, { name, icon, pack, instanceId, report }) {
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    const mc = manifest.minecraft?.version;
    const loaderEntry = (manifest.minecraft?.modLoaders || []).find((l) => l.primary) || manifest.minecraft?.modLoaders?.[0];
    const loader = loaderEntry ? parseLoaderId(loaderEntry.id) || { type: 'vanilla' } : { type: 'vanilla' };
    const hasFiles = (manifest.files || []).some((f) => f.required !== false);
    if (hasFiles && !this.sources.curseforge.configured()) {
      throw new Error('This is a CurseForge modpack. Add your CurseForge API key in Settings to install it.');
    }
    const inst = await this.createOrReuse(instanceId, {
      name: name || manifest.name, mcVersion: mc, loader, icon,
      pack: pack || { source: 'file', name: manifest.name, versionName: manifest.version },
    });
    const gameDir = this.instances.gameDir(inst.id);
    const { jobs, blocked, warnings } = await this.resolveCurseForge(manifest, gameDir, report);
    const errors = await this.downloadAll(jobs, (j) => this.ctx.http.download(j.url, j.dest, { sha1: j.sha1, size: j.size }),
      (done, total) => report(0.1 + 0.75 * (done / Math.max(1, total)), `Downloading mods ${done}/${total}`));
    report(0.88, 'Applying overrides');
    const shipped = [];
    await extractOverrides(zip, [manifest.overrides || 'overrides'], gameDir, shipped);
    const failed = new Set(errors.map((e) => e.item));
    await this.indexCurseForgeItems(inst.id, jobs.filter((j) => !failed.has(j)));
    await this.recordPackShipped(inst.id, gameDir, shipped);
    await this.recordFailures(inst.id, errors.map((e) => this.cfRecord(e.item, e.error)));
    report(1, blocked.length ? `${blocked.length} files need a manual download` : 'Done');
    return { instance: await this.instances.get(inst.id), blocked, failed: await this.failedDownloads(inst.id), warnings };
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

  // ---- retry what failed -------------------------------------------------------------------

  /** Tries the files recorded as failed again (one automatic extra pass included). */
  async retryFailed(instId, { report = () => {} } = {}) {
    const gameDir = this.instances.gameDir(instId);
    const idx = await this.instances.readIndex(instId);
    const records = [];
    for (const rec of Object.values(idx.failed || {})) {
      try { safeJoin(gameDir, rec.path); records.push(rec); } catch { /* a damaged record: ignore it */ }
    }
    if (!records.length) return { retried: 0, fixed: [], failed: await this.failedDownloads(instId), blocked: [], warnings: [] };
    report(0.05, `Retrying ${records.length} file${records.length === 1 ? '' : 's'}`);
    const errors = await this.downloadAll(records, (rec) => this.fetchFirst(rec.urls, safeJoin(gameDir, rec.path), { sha1: rec.hashes?.sha1, sha512: rec.hashes?.sha512, size: rec.size }),
      (done, total) => report(0.05 + 0.85 * (done / total), `Downloading ${done}/${total}`));
    const stillFailed = new Map(errors.map((e) => [e.item.path, e.error]));
    const fixed = records.filter((r) => !stillFailed.has(r.path));
    const warnings = [];
    await this.indexMrpackFiles(instId, gameDir, fixed.filter((r) => r.source !== 'curseforge').map((r) => ({ path: r.path, hashes: r.hashes, downloads: r.urls, fileSize: r.size })), warnings);
    await this.indexCurseForgeItems(instId, fixed.filter((r) => r.source === 'curseforge').map((r) => ({
      rel: r.path, dest: safeJoin(gameDir, r.path), url: r.urls[0], sha1: r.hashes?.sha1, ...r.cf,
    })));
    await this.recordFailures(instId, records.filter((r) => stillFailed.has(r.path)).map((r) => ({ ...r, error: describeError(stillFailed.get(r.path)), at: Date.now() })));
    report(1, 'Done');
    return { retried: records.length, fixed: fixed.map((r) => r.path), failed: await this.failedDownloads(instId), blocked: [], warnings };
  }

  // ---- repair --------------------------------------------------------------------------------

  /**
   * Downloads the installed pack version's index again and fetches every file of it that is missing
   * or has the wrong hash. Configs and anything you added yourself are never touched.
   */
  async repair(instId, { report = () => {} } = {}) {
    const inst = await this.instances.get(instId);
    const pack = inst.pack;
    if (!pack || !['modrinth', 'curseforge'].includes(pack.source) || !pack.versionId) {
      throw new Error("This instance wasn't installed from a Modrinth or CurseForge modpack, so there is nothing to repair it against.");
    }
    report(0.02, 'Downloading the pack index');
    const version = pack.source === 'modrinth' ? await this.sources.modrinth.version(pack.versionId) : (await this.sources.curseforge.files([pack.versionId]))[0];
    const file = version && pickFile(version);
    if (!file) throw new Error(`${pack.name} version ${pack.versionName || pack.versionId} can't be found any more.`);
    if (!file.url) {
      const e = new Error(`The author of ${pack.name} only allows downloads from the CurseForge website, so Junction can't fetch its file list. Download the zip there, then re-import it.`);
      e.manualUrl = pack.url;
      throw e;
    }
    const cached = path.join(this.ctx.paths.cache, 'packs', `${shortId(6)}-${file.filename}`);
    await this.ctx.http.download(file.url, cached, { sha1: file.sha1, sha512: file.sha512, size: file.size });
    try {
      const zip = new AdmZip(cached);
      const fmt = detectPackFormat(zip);
      if (fmt === 'mrpack') return await this.repairMrpack(zip, inst, report);
      if (fmt === 'curseforge') return await this.repairCurseForge(zip, inst, report);
      throw new Error('The downloaded file is not a modpack.');
    } finally {
      await fsp.rm(cached, { force: true });
    }
  }

  /** Re-checks the pack's own override mods / resource packs / shaders: restores missing ones and labels the ones that match. */
  async reconcileOverrides(zip, prefixes, instId, gameDir) {
    const restored = [];
    const same = [];
    for (const prefix of prefixes) {
      const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
      for (const e of zip.getEntries()) {
        if (e.isDirectory || !e.entryName.startsWith(p)) continue;
        const rel = normRel(e.entryName.slice(p.length));
        if (!contentType(rel)) continue; // configs and everything else: never touched
        const dest = safeJoin(gameDir, rel);
        const present = (await exists(dest)) ? dest : (await exists(`${dest}.disabled`)) ? `${dest}.disabled` : null;
        const data = e.getData();
        if (!present) {
          await ensureDir(path.dirname(dest));
          await fsp.writeFile(dest, data);
          restored.push(rel);
          same.push(rel);
        } else if ((await hashFile(present, 'sha1')) === hashBuffer(data, 'sha1')) {
          same.push(rel);
        } // a different file with that name is the user's: leave it
      }
    }
    await this.recordPackShipped(instId, gameDir, same, { keepIdentified: true });
    return restored;
  }

  async repairMrpack(zip, inst, report) {
    const index = JSON.parse(zip.readAsText('modrinth.index.json'));
    const gameDir = this.instances.gameDir(inst.id);
    const warnings = [];
    const files = this.mrpackFiles(index, gameDir, warnings);
    const states = new Map();
    let checked = 0;
    report(0.1, `Checking ${files.length} files`);
    await pool(files, DOWNLOAD_CONCURRENCY, async (f) => {
      states.set(f, await fileState(safeJoin(gameDir, f.path), { sha1: f.hashes?.sha1, sha512: f.hashes?.sha512, size: f.fileSize }));
      report(0.1 + 0.25 * (++checked / files.length), `Checking files ${checked}/${files.length}`);
    }, { count: false });
    const todo = files.filter((f) => states.get(f).state !== 'ok');
    const errors = await this.downloadAll(todo, async (f) => {
      const dest = safeJoin(gameDir, f.path);
      await this.fetchFirst(f.downloads, dest, { sha1: f.hashes?.sha1, sha512: f.hashes?.sha512, size: f.fileSize });
      if (states.get(f).disabled) await fsp.rename(dest, `${dest}.disabled`); // it was switched off: keep it that way
    }, (done, total) => report(0.35 + 0.5 * (done / Math.max(1, total)), `Downloading ${done}/${total}`));
    const failedFiles = new Set(errors.map((e) => e.item));
    const repaired = todo.filter((f) => !failedFiles.has(f));
    report(0.88, 'Updating records');
    await this.indexMrpackFiles(inst.id, gameDir, repaired, warnings);
    const restored = await this.reconcileOverrides(zip, ['overrides', 'client-overrides'], inst.id, gameDir);
    await this.recordFailures(inst.id, errors.map((e) => this.mrpackRecord(e.item, e.error)));
    report(1, 'Done');
    return { checked: files.length, ok: files.length - todo.length, repaired: repaired.map((f) => normRel(f.path)), restored, failed: await this.failedDownloads(inst.id), blocked: [], warnings };
  }

  async repairCurseForge(zip, inst, report) {
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    if ((manifest.files || []).some((f) => f.required !== false) && !this.sources.curseforge.configured()) {
      throw new Error('Repairing a CurseForge pack needs your CurseForge API key. Add it in Settings.');
    }
    const gameDir = this.instances.gameDir(inst.id);
    const { jobs, blocked: allBlocked, warnings } = await this.resolveCurseForge(manifest, gameDir, report);
    const states = new Map();
    let checked = 0;
    const all = [...jobs, ...allBlocked];
    report(0.15, `Checking ${all.length} files`);
    await pool(all, DOWNLOAD_CONCURRENCY, async (j) => {
      states.set(j, await fileState(j.dest, { sha1: j.sha1, size: j.size }));
      report(0.15 + 0.2 * (++checked / all.length), `Checking files ${checked}/${all.length}`);
    }, { count: false });
    const todo = jobs.filter((j) => states.get(j).state !== 'ok');
    const errors = await this.downloadAll(todo, async (j) => {
      await this.ctx.http.download(j.url, j.dest, { sha1: j.sha1, size: j.size });
      if (states.get(j).disabled) await fsp.rename(j.dest, `${j.dest}.disabled`);
    }, (done, total) => report(0.35 + 0.5 * (done / Math.max(1, total)), `Downloading ${done}/${total}`));
    const failedJobs = new Set(errors.map((e) => e.item));
    const repaired = todo.filter((j) => !failedJobs.has(j));
    report(0.88, 'Updating records');
    await this.indexCurseForgeItems(inst.id, repaired);
    const restored = await this.reconcileOverrides(zip, [manifest.overrides || 'overrides'], inst.id, gameDir);
    await this.recordFailures(inst.id, errors.map((e) => this.cfRecord(e.item, e.error)));
    const blocked = allBlocked.filter((b) => states.get(b).state !== 'ok'); // the author blocks downloads: manual flow
    report(1, 'Done');
    return { checked: all.length, ok: all.length - todo.length - blocked.length, repaired: repaired.map((j) => j.rel), restored, failed: await this.failedDownloads(inst.id), blocked, warnings };
  }
}

module.exports = { Modpacks, detectPackFormat, mrpackLoader, extractOverrides };
