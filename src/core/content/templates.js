'use strict';
// Instance templates: the recipe of an instance (which Modrinth/CurseForge projects, plus optionally configs and options.txt)
// without any jar files, so it can be rebuilt for another Minecraft version or loader.
// Stored in <data>/templates/<id>/template.json, with copied files next to it in <id>/files/.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { TYPE_DIR } = require('../instances');
const { ensureDir, exists, readJson, writeJson, copyDir, safeJoin, slugify, shortId, pool } = require('../util');
const { describeError } = require('../http');
const { pickVersion } = require('../sources/choose');
const { ITEMS } = require('./worldcopy');

const TYPES = ['mod', 'resourcepack', 'shader'];
const TYPE_LABEL = { mod: 'Mods', resourcepack: 'Resource packs', shader: 'Shaders' };
const OPTION_FILES = ITEMS.find((i) => i.id === 'options').paths; // options.txt, optionsof.txt, optionsshaders.txt (same list "Copy worlds and settings" uses)

class Templates {
  constructor(ctx, instances, content) {
    this.ctx = ctx;
    this.instances = instances;
    this.content = content;
    this.dir = path.join(ctx.paths.root, 'templates');
  }

  dirOf(id) { return safeJoin(this.dir, id); }

  async get(id) {
    const j = await readJson(path.join(this.dirOf(id), 'template.json'), null);
    if (!j) throw new Error('That template is gone. Close this window and try again.');
    return j;
  }

  summary(t) {
    const count = (type) => (t.content?.[type] || []).length;
    return {
      id: t.id, name: t.name, created: t.created, mcVersion: t.mcVersion, loader: t.loader, include: t.include,
      counts: { mod: count('mod'), resourcepack: count('resourcepack'), shader: count('shader') },
      skipped: t.skipped || [], hasFiles: Boolean(t.files?.length),
    };
  }

  async list() {
    const out = [];
    for (const e of await fsp.readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const t = await readJson(path.join(this.dir, e.name, 'template.json'), null);
      if (t) out.push(this.summary(t));
    }
    return out.sort((a, b) => (b.created || 0) - (a.created || 0));
  }

  /**
   * Saves an instance as a template. `include`: { configs, options, resourcepacks, shaders } (all optional).
   * Files that aren't linked to Modrinth or CurseForge can't be rebuilt, so they are listed in `skipped` and left out.
   */
  async save(instId, { name, include = {} } = {}) {
    const inst = await this.instances.get(instId);
    name = String(name || '').trim() || inst.name;
    const types = ['mod', ...(include.resourcepacks ? ['resourcepack'] : []), ...(include.shaders ? ['shader'] : [])];
    const contentByType = { mod: [], resourcepack: [], shader: [] };
    const skipped = [];
    for (const type of types) {
      const seen = new Set();
      for (const item of await this.instances.listContent(instId, type)) {
        const linked = (item.source === 'modrinth' || item.source === 'curseforge') && item.projectId != null;
        if (!linked) { skipped.push({ type, title: item.title, file: item.fileName, why: item.source === 'pack' ? 'shipped inside a modpack, not on Modrinth or CurseForge' : 'not from Modrinth or CurseForge' }); continue; }
        const key = `${item.source}:${item.projectId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        contentByType[type].push({ source: item.source, projectId: String(item.projectId), title: item.title, icon: item.icon || null });
      }
    }

    let id = slugify(name);
    if (await exists(this.dirOf(id))) id = `${id}-${shortId(4)}`;
    const files = [];
    const root = this.dirOf(id);
    const filesDir = path.join(root, 'files');
    try {
      await ensureDir(filesDir);
      const game = this.instances.gameDir(instId);
      if (include.configs && (await exists(path.join(game, 'config')))) {
        await copyDir(path.join(game, 'config'), path.join(filesDir, 'config'));
        files.push('config');
      }
      if (include.options) {
        for (const rel of OPTION_FILES) {
          if (await exists(path.join(game, rel))) { await fsp.copyFile(path.join(game, rel), path.join(filesDir, rel)); files.push(rel); }
        }
      }
      const t = {
        id, name, created: Date.now(), mcVersion: inst.mcVersion, loader: { type: inst.loader?.type || 'vanilla' },
        include: { configs: Boolean(include.configs), options: Boolean(include.options), resourcepacks: Boolean(include.resourcepacks), shaders: Boolean(include.shaders) },
        content: contentByType, files, skipped,
      };
      await writeJson(path.join(root, 'template.json'), t);
      return this.summary(t);
    } catch (e) {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  async rename(id, name) {
    name = String(name || '').trim();
    if (!name) throw new Error('Give the template a name.');
    const t = await this.get(id);
    t.name = name;
    await writeJson(path.join(this.dirOf(id), 'template.json'), t);
    return this.summary(t);
  }

  async remove(id) {
    await this.get(id);
    await fsp.rm(this.dirOf(id), { recursive: true, force: true });
  }

  /**
   * Looks up the newest matching version of every project for a Minecraft version + loader. Changes nothing.
   * Each item: status 'add' (versionId etc. filled in), 'unavailable' (nothing for this version or loader) or 'skipped'.
   * The version is chosen like a normal install: best release type first (releases over betas over alphas), then newest.
   * A CurseForge file whose author blocked third-party downloads is still 'add' but flagged `manual`.
   */
  async plan(templateId, { mcVersion, loader }) {
    const t = await this.get(templateId);
    if (!mcVersion) throw new Error('Pick a Minecraft version first.');
    const loaderType = loader?.type || 'vanilla';
    const target = { mcVersion, loader: { type: loaderType } };
    const items = [];
    const jobs = [];
    for (const type of TYPES) {
      for (const p of t.content?.[type] || []) {
        const base = { type, source: p.source, projectId: p.projectId, title: p.title, icon: p.icon || null };
        if (type === 'mod' && loaderType === 'vanilla') items.push({ ...base, status: 'skipped', reason: 'Mods need a mod loader, and this instance is vanilla.' });
        else { const it = { ...base, status: 'unavailable', reason: '' }; items.push(it); jobs.push(it); }
      }
    }
    await pool(jobs, 6, async (it) => {
      try {
        const list = await this.content.compatibleVersions(it.source, it.projectId, target, it.type);
        const v = pickVersion(list, it.type);
        if (!v) {
          it.reason = it.type === 'mod' ? `No version for Minecraft ${mcVersion} with ${loaderType}.` : `No version for Minecraft ${mcVersion}.`;
          return;
        }
        const file = v.files?.find((f) => f.primary) || v.files?.[0];
        if (!file) { it.reason = 'This version has no downloadable file.'; return; }
        Object.assign(it, { status: 'add', reason: '', versionId: String(v.id), versionNumber: v.versionNumber, releaseType: v.releaseType, manual: !file.url });
      } catch (e) {
        it.reason = `Couldn't check right now: ${describeError(e)}`;
      }
    }, { count: false });
    for (const s of t.skipped || []) items.push({ type: s.type, title: s.title, status: 'skipped', reason: `Left out when the template was saved (${s.why}).` });
    return { template: this.summary(t), mcVersion, loader: { type: loaderType }, items };
  }

  /**
   * Installs what the user confirmed from plan(): `chosen` is a list of { type, source, projectId, versionId, title }.
   * Needs `confirmed: true`, so nothing can install without the review. Returns the usual { installed, blocked, warnings }.
   */
  async apply(instId, chosen, { confirmed = false, report = () => {} } = {}) {
    if (confirmed !== true) throw new Error('Please review the list and confirm before installing.');
    const out = { installed: [], skipped: [], blocked: [], warnings: [] };
    let i = 0;
    for (const c of chosen || []) {
      if (!TYPE_DIR[c.type]) continue;
      report(i++ / chosen.length, `Installing ${c.title || 'content'}`);
      try {
        const r = await this.content.installProject(instId, { source: c.source, id: c.projectId }, c.type, { versionId: c.versionId, report: (f, m) => report(null, m) });
        out.installed.push(...r.installed); out.skipped.push(...r.skipped); out.blocked.push(...r.blocked); out.warnings.push(...r.warnings);
      } catch (e) {
        out.warnings.push(`${c.title || c.projectId}: ${describeError(e)}`);
      }
    }
    report(1, 'Done');
    return out;
  }
}

module.exports = { Templates, TYPE_LABEL };
