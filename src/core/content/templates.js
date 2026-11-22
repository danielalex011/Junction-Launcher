'use strict';
// Instance templates: the recipe of an instance (which Modrinth/CurseForge projects, plus optionally configs and options.txt)
// without any jar files, so it can be rebuilt for another Minecraft version or loader.
// Stored in <data>/templates/<id>/template.json, with copied files next to it in <id>/files/.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { TYPE_DIR } = require('../instances');
const { ensureDir, exists, readJson, writeJson, copyDir, safeJoin, slugify, shortId, pool, matchKey } = require('../util');
const { CancelledError } = require('../taskcontext');
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
   * Looks up the newest matching version of every project for a Minecraft version + loader, and the required dependencies
   * those versions need. Changes nothing.
   * Each item: status 'add' (versionId etc. filled in), 'unavailable' (nothing for this version or loader, or a required
   * dependency is missing) or 'skipped'. Dependencies the template doesn't have come back as extra 'add' items with
   * `dependency: true` and `neededBy: [mod names]`. Optional dependencies are ignored.
   * The version is chosen like a normal install: best release type first (releases over betas over alphas), then newest.
   * A CurseForge file whose author blocked third-party downloads is still 'add' but flagged `manual`.
   * A mod held back only because of a missing dependency keeps its version and is flagged `forceable`.
   */
  async plan(templateId, { mcVersion, loader }) {
    const t = await this.get(templateId);
    if (!mcVersion) throw new Error('Pick a Minecraft version first.');
    const loaderType = loader?.type || 'vanilla';
    const target = { mcVersion, loader: { type: loaderType } };
    const where = (type) => (type === 'mod' ? `Minecraft ${mcVersion} with ${loaderType}` : `Minecraft ${mcVersion}`);
    const items = [];
    const jobs = [];
    const versions = new Map(); // item -> the version picked for it (not sent to the page)
    for (const type of TYPES) {
      for (const p of t.content?.[type] || []) {
        const base = { type, source: p.source, projectId: p.projectId, title: p.title, icon: p.icon || null };
        if (type === 'mod' && loaderType === 'vanilla') items.push({ ...base, status: 'skipped', reason: 'Mods need a mod loader, and this instance is vanilla.' });
        else { const it = { ...base, status: 'unavailable', reason: '' }; items.push(it); jobs.push(it); }
      }
    }
    const fill = (it, v) => {
      const file = v.files?.find((f) => f.primary) || v.files?.[0];
      if (!file) return false;
      Object.assign(it, { status: 'add', reason: '', versionId: String(v.id), versionNumber: v.versionNumber, releaseType: v.releaseType, manual: !file.url });
      versions.set(it, v);
      return true;
    };
    await pool(jobs, 6, async (it) => {
      try {
        const v = pickVersion(await this.content.compatibleVersions(it.source, it.projectId, target, it.type), it.type);
        if (!v) it.reason = `No version for ${where(it.type)}.`;
        else if (!fill(it, v)) it.reason = 'This version has no downloadable file.';
      } catch (e) {
        it.reason = `Couldn't check right now: ${describeError(e)}`;
      }
    }, { count: false });

    // Required dependencies of the mods that will be added.
    const byKey = new Map(items.filter((i) => i.projectId != null).map((i) => [`${i.source}:${i.projectId}`, i]));
    const byTitle = new Map(items.filter((i) => i.type === 'mod').map((i) => [matchKey(i.title), i]));
    const edges = []; // { mod, dep }: mod needs dep
    const queue = items.filter((i) => i.type === 'mod' && i.status === 'add');
    while (queue.length) {
      const mod = queue.shift();
      for (const d of versions.get(mod)?.deps || []) {
        if (d.type !== 'required' || d.projectId == null) continue;
        const key = `${d.source}:${d.projectId}`;
        let dep = byKey.get(key);
        if (!dep) {
          const info = await this.content.projectInfo(d.source, d.projectId).catch(() => null);
          const title = info?.title || 'a required mod';
          dep = info && byTitle.get(matchKey(title)); // the template has the same mod from the other site
          if (!dep) {
            dep = { type: 'mod', source: d.source, projectId: String(d.projectId), title, icon: info?.icon || null, status: 'unavailable', reason: '', dependency: true, neededBy: [] };
            const v = await this.content.bestVersion(d.source, d.projectId, target, 'mod').catch(() => null);
            if (!v || !fill(dep, v)) dep.reason = `No version for ${where('mod')}.`;
            else queue.push(dep);
            byKey.set(key, dep);
            items.push(dep);
          }
        }
        if (dep !== mod) edges.push({ mod, dep });
      }
    }
    // A mod whose dependency can't be added is held back; a dependency nobody needs any more is dropped.
    const missing = new Map(); // mod -> [dependency names]
    for (let changed = true; changed;) {
      changed = false;
      for (const { mod, dep } of edges) {
        if (mod.status !== 'add' || dep.status === 'add') continue;
        mod.status = 'unavailable'; mod.forceable = true;
        changed = true;
      }
      for (const { mod, dep } of edges) {
        if (mod.status === 'unavailable' && mod.forceable && dep.status !== 'add' && dep.status !== 'drop') {
          const list = missing.get(mod) || [];
          if (!list.includes(dep.title)) list.push(dep.title);
          missing.set(mod, list);
        }
      }
      for (const d of items) {
        if (!d.dependency || d.status !== 'add') continue;
        const live = edges.filter((e) => e.dep === d && e.mod.status === 'add').map((e) => e.mod.title);
        if (!live.length) { d.status = 'drop'; changed = true; } else d.neededBy = [...new Set(live)];
      }
    }
    for (const [mod, names] of missing) {
      mod.reason = `Needs ${names.join(' and ')}, which ${names.length === 1 ? "isn't" : "aren't"} available for ${where('mod')}.`;
    }
    const out = items.filter((i) => i.status !== 'drop' && !(i.dependency && i.status !== 'add'));
    for (const s of t.skipped || []) out.push({ type: s.type, title: s.title, status: 'skipped', reason: `Left out when the template was saved (${s.why}).` });
    const copies = (t.files || []).map((f) => (f === 'config' ? 'config folder' : f));
    return { template: this.summary(t), mcVersion, loader: { type: loaderType }, items: out, copies };
  }

  /** Copies the saved config folder and options files into the instance's game folder (a new instance has none of its own yet). */
  async copyFiles(instId, templateId) {
    const t = await this.get(templateId);
    const from = path.join(this.dirOf(templateId), 'files');
    const to = this.instances.gameDir(instId);
    const copied = [];
    for (const rel of t.files || []) {
      const src = safeJoin(from, rel);
      if (!(await exists(src))) continue;
      const dest = safeJoin(to, rel);
      await ensureDir(path.dirname(dest));
      if ((await fsp.stat(src)).isDirectory()) await copyDir(src, dest);
      else await fsp.copyFile(src, dest);
      copied.push(rel === 'config' ? 'config folder' : rel);
    }
    return copied;
  }

  /**
   * Installs what the user confirmed from plan(): `chosen` is a list of { type, source, projectId, versionId, title }
   * (dependencies are separate entries, so nothing is looked up a second time). Needs `confirmed: true`.
   * One failing file never stops the rest: it is listed in `problems` and the others go on.
   * Returns { installed, skipped, blocked, warnings, problems: [{ title, why }], copied }.
   */
  async apply(instId, chosen, { confirmed = false, templateId = null, copyFiles = false, report = () => {} } = {}) {
    if (confirmed !== true) throw new Error('Please review the list and confirm before installing.');
    const out = { installed: [], skipped: [], blocked: [], warnings: [], problems: [], copied: [] };
    if (copyFiles && templateId) {
      try { out.copied = await this.copyFiles(instId, templateId); } catch (e) { out.problems.push({ title: 'Settings files', why: describeError(e) }); }
    }
    const list = chosen || [];
    let i = 0;
    for (const c of list) {
      if (!TYPE_DIR[c.type]) continue;
      report(i++ / Math.max(1, list.length), `Installing ${c.title || 'content'}`);
      try {
        const r = await this.content.installProject(instId, { source: c.source, id: c.projectId }, c.type, { versionId: c.versionId, withDeps: false, report: (f, m) => report(null, m) });
        out.installed.push(...r.installed); out.skipped.push(...r.skipped); out.blocked.push(...r.blocked); out.warnings.push(...r.warnings);
        for (const w of r.warnings) out.problems.push({ title: c.title, why: w });
      } catch (e) {
        if (e instanceof CancelledError || e?.name === 'CancelledError') throw e; // Cancel stops everything; any other error only this file
        out.problems.push({ title: c.title || String(c.projectId), why: describeError(e) });
      }
    }
    report(1, out.problems.length ? 'Done with problems' : 'Done');
    return out;
  }
}

module.exports = { Templates, TYPE_LABEL };
