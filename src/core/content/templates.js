'use strict';
// Instance templates: the recipe of an instance (which Modrinth/CurseForge projects, plus optionally configs and options.txt)
// without any jar files, so it can be rebuilt for another Minecraft version or loader.
// Stored in <data>/templates/<id>/template.json, with copied files next to it in <id>/files/.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { TYPE_DIR, isLinkedPack } = require('../instances');
const { ensureDir, exists, readJson, writeJson, copyDir, safeJoin, slugify, shortId, pool, matchKey } = require('../util');
const { CancelledError } = require('../taskcontext');
const { describeError } = require('../http');
const { pickVersion } = require('../sources/choose');
const { ITEMS } = require('./worldcopy');
const { LOADER_NAMES } = require('../loaders');

const TYPES = ['mod', 'resourcepack', 'shader'];
const TYPE_LABEL = { mod: 'Mods', resourcepack: 'Resource packs', shader: 'Shaders' };
const OPTION_FILES = ITEMS.find((i) => i.id === 'options').paths; // options.txt, optionsof.txt, optionsshaders.txt (same list "Copy worlds and settings" uses)

// ---- known conflicts -------------------------------------------------------------------------------------------------
// A small built-in list of mods that break each other. A conflicting template mod is not dropped: it stays in the review,
// unticked, with the reason, because a pack's own setup can make it work.
const KNOWN_MODS = {
  sodium: { label: 'Sodium', modIds: ['sodium'], names: ['sodium'] },
  embeddium: { label: 'Embeddium', modIds: ['embeddium'], names: ['embeddium'] },
  rubidium: { label: 'Rubidium', modIds: ['rubidium'], names: ['rubidium'] },
  optifine: { label: 'OptiFine', modIds: ['optifine', 'optifabric'], names: ['optifine', 'optifabric'] },
  iris: { label: 'Iris', modIds: ['iris'], names: ['iris', 'irisshaders'] },
  oculus: { label: 'Oculus', modIds: ['oculus'], names: ['oculus'] },
};
const CONFLICT_PAIRS = [
  ['sodium', 'embeddium'], ['sodium', 'rubidium'], ['embeddium', 'rubidium'],
  ['optifine', 'sodium'], ['optifine', 'iris'], ['optifine', 'embeddium'], ['optifine', 'rubidium'], ['optifine', 'oculus'],
];

/** Which known mod this is ('sodium', ...), from its mod id or exact name. "Sodium Extra" is not Sodium. */
function knownModOf({ title, modId } = {}) {
  const mid = String(modId || '').toLowerCase();
  const name = matchKey(title);
  return Object.keys(KNOWN_MODS).find((k) => (mid && KNOWN_MODS[k].modIds.includes(mid)) || (name && KNOWN_MODS[k].names.includes(name))) || null;
}

/** The mods in `existing` ({ title, modId }) that `mod` can't run next to: [{ title, label }]. */
function findConflicts(mod, existing) {
  const me = knownModOf(mod);
  if (!me) return [];
  const out = [];
  for (const e of existing) {
    const other = knownModOf(e);
    if (!other || other === me) continue;
    if (CONFLICT_PAIRS.some(([a, b]) => (a === me && b === other) || (a === other && b === me))) out.push({ title: e.title, label: KNOWN_MODS[other].label });
  }
  return out;
}

/** Every file under `dir` as forward-slash paths relative to it. */
async function walkFiles(dir, base = '') {
  const out = [];
  for (const e of await fsp.readdir(path.join(dir, base), { withFileTypes: true }).catch(() => [])) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

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
        contentByType[type].push({ source: item.source, projectId: String(item.projectId), title: item.title, icon: item.icon || null, modId: type === 'mod' ? item.modId || null : null });
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
   * What an instance already has, for matching: [{ type, rel, title, modId, source, projectId, slug, fromPack, enabled }].
   * (listContent first, so the jar metadata in content.json is up to date.)
   */
  async haveList(instId) {
    const out = [];
    for (const type of TYPES) {
      for (const it of await this.instances.listContent(instId, type)) {
        out.push({ type, rel: it.file, title: it.title, modId: it.modId, source: it.source, projectId: it.projectId, fromPack: it.fromPack, enabled: it.enabled });
      }
    }
    const idx = await this.instances.readIndex(instId);
    for (const e of out) e.slug = idx.files[e.rel]?.slug || null;
    return out;
  }

  /**
   * What copying the saved files would do in this game folder: { copies: [label], kept: [rel] }.
   * Files that are already there are never overwritten ("kept"); only missing ones are copied.
   * Without an instance (a new one doesn't exist yet) everything counts as new.
   */
  async filePlan(t, instId = null) {
    const from = path.join(this.dirOf(t.id), 'files');
    const game = instId ? this.instances.gameDir(instId) : null;
    const copies = [];
    const kept = [];
    for (const rel of t.files || []) {
      const src = safeJoin(from, rel);
      if (!(await exists(src))) continue;
      const isDir = (await fsp.stat(src)).isDirectory();
      const files = isDir ? (await walkFiles(src)).map((f) => `${rel}/${f}`) : [rel];
      let fresh = 0;
      for (const f of files) {
        if (game && (await exists(safeJoin(game, f)))) kept.push(f); else fresh++;
      }
      if (!fresh) continue;
      copies.push(rel === 'config' ? (game ? `config folder (${fresh} file${fresh === 1 ? '' : 's'} that aren't there yet)` : 'config folder') : rel);
    }
    return { copies, kept: kept.sort() };
  }

  /**
   * Looks up the newest matching version of every project for a Minecraft version + loader, and the required dependencies
   * those versions need. Changes nothing.
   * With `instanceId` the plan is for that instance (its Minecraft version and loader; `mcVersion` / `loader` are ignored) and
   * also looks at what it already has (a modpack's own files and your additions).
   * Each item has a `status`:
   *   'add'         versionId etc. filled in
   *   'have'        already there: `have` is 'pack' (a linked modpack's own file) or 'instance'. Same project on either site,
   *                 same mod ID inside the jar, or the same name. Nothing is installed for it.
   *   'conflict'    a version was found, but it is known to clash with a mod the instance has (`reason` says which). Installable if ticked.
   *   'unavailable' nothing for this version or loader, or a required dependency is missing
   *   'skipped'
   * Dependencies the template doesn't have come back as extra 'add' items with `dependency: true` and `neededBy: [mod names]`;
   * a dependency the instance already has counts as satisfied and isn't listed. Optional dependencies are ignored.
   * A mod from a template saved on another loader is looked up again for this loader (same project only, never a different mod);
   * when the project has nothing for it the reason reads "Not available for NeoForge ...".
   * The version is chosen like a normal install: best release type first (releases over betas over alphas), then newest.
   * A CurseForge file whose author blocked third-party downloads is still 'add' but flagged `manual`.
   * A mod held back only because of a missing dependency keeps its version and is flagged `forceable`.
   */
  async plan(templateId, { mcVersion, loader, instanceId = null } = {}) {
    const t = await this.get(templateId);
    let inst = null;
    let existing = [];
    if (instanceId) {
      inst = await this.instances.get(instanceId);
      mcVersion = inst.mcVersion;
      loader = { type: inst.loader?.type || 'vanilla' };
      existing = await this.haveList(instanceId);
    }
    if (!mcVersion) throw new Error('Pick a Minecraft version first.');
    const loaderType = loader?.type || 'vanilla';
    const linked = Boolean(inst && isLinkedPack(inst));
    const target = { mcVersion, loader: { type: loaderType } };
    const where = (type) => (type === 'mod' ? `Minecraft ${mcVersion} with ${loaderType}` : `Minecraft ${mcVersion}`);
    const noVersion = (type) => (type === 'mod' && t.loader?.type && t.loader.type !== loaderType
      ? `Not available for ${LOADER_NAMES[loaderType] || loaderType} on Minecraft ${mcVersion}.`
      : `No version for ${where(type)}.`);

    // What the instance has, by project (either site), mod ID, slug and name.
    const have = { key: new Map(), modId: new Map(), name: new Map(), slug: new Map() };
    for (const e of existing) {
      const k = `${e.type}:`;
      if (e.source && e.projectId != null && e.source !== 'local' && e.source !== 'pack') have.key.set(`${k}${e.source}:${e.projectId}`, e);
      if (e.modId) have.modId.set(String(e.modId).toLowerCase(), e);
      if (e.title) have.name.set(`${k}${matchKey(e.title)}`, e);
      if (e.slug) have.slug.set(`${k}${String(e.slug).toLowerCase()}`, e);
    }
    const haveOf = (type, { source, projectId, modId, title, slug }) => (
      have.key.get(`${type}:${source}:${projectId}`)
      || (type === 'mod' && modId && have.modId.get(String(modId).toLowerCase()))
      || (title && have.name.get(`${type}:${matchKey(title)}`))
      || (slug && have.slug.get(`${type}:${String(slug).toLowerCase()}`))
      || null);

    const items = [];
    const jobs = [];
    const versions = new Map(); // item -> the version picked for it (not sent to the page)
    for (const type of TYPES) {
      for (const p of t.content?.[type] || []) {
        const base = { type, source: p.source, projectId: p.projectId, title: p.title, icon: p.icon || null };
        const there = haveOf(type, { source: p.source, projectId: p.projectId, modId: p.modId, title: p.title });
        if (type === 'mod' && loaderType === 'vanilla') items.push({ ...base, status: 'skipped', reason: 'Mods need a mod loader, and this instance is vanilla.' });
        else if (there) items.push({ ...base, status: 'have', have: there.fromPack && linked ? 'pack' : 'instance', reason: there.fromPack && linked ? 'Already in the pack' : 'Already installed' });
        else { const it = { ...base, status: 'unavailable', reason: '', modId: p.modId || null }; items.push(it); jobs.push(it); }
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
        if (!v) it.reason = noVersion(it.type);
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
          if (haveOf('mod', { source: d.source, projectId: d.projectId })) continue; // the pack (or instance) already provides it
          const info = await this.content.projectInfo(d.source, d.projectId).catch(() => null);
          const title = info?.title || 'a required mod';
          if (info && haveOf('mod', { title, slug: info.slug })) continue; // same mod from the other site
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
    // (A template mod the instance already has counts as a dependency that is there.)
    const there = (d) => d.status === 'add' || d.status === 'have';
    const missing = new Map(); // mod -> [dependency names]
    for (let changed = true; changed;) {
      changed = false;
      for (const { mod, dep } of edges) {
        if (mod.status !== 'add' || there(dep)) continue;
        mod.status = 'unavailable'; mod.forceable = true;
        changed = true;
      }
      for (const { mod, dep } of edges) {
        if (mod.status === 'unavailable' && mod.forceable && !there(dep) && dep.status !== 'drop') {
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
    // Known conflicts with mods the instance has switched on: kept in the list but not ticked.
    const running = existing.filter((e) => e.type === 'mod' && e.enabled);
    for (const it of items) {
      if (it.type !== 'mod' || it.status !== 'add') continue;
      const clash = findConflicts({ title: it.title, modId: it.modId }, running);
      if (!clash.length) continue;
      const names = [...new Set(clash.map((c) => c.label))];
      it.status = 'conflict';
      it.reason = `Doesn't work together with ${names.join(' and ')}, which ${linked ? 'the pack already has' : 'this instance already has'}.`;
    }
    const out = items.filter((i) => i.status !== 'drop' && !(i.dependency && i.status !== 'add'));
    for (const s of t.skipped || []) out.push({ type: s.type, title: s.title, status: 'skipped', reason: `Left out when the template was saved (${s.why}).` });
    const { copies, kept } = await this.filePlan(t, instanceId);
    return {
      template: this.summary(t), mcVersion, loader: { type: loaderType }, items: out, copies, kept,
      instance: inst ? { id: inst.id, name: inst.name, linked, packName: linked ? inst.pack.name : null } : null,
    };
  }

  /**
   * Copies the saved config folder and options files into the instance's game folder. Never overwrites: a file the instance
   * (or its modpack) already has stays as it is. Returns { copied: ['config folder', 'options.txt'], kept: [rel] }.
   */
  async copyFiles(instId, templateId) {
    const t = await this.get(templateId);
    const from = path.join(this.dirOf(templateId), 'files');
    const to = this.instances.gameDir(instId);
    const copied = [];
    const kept = [];
    for (const rel of t.files || []) {
      const src = safeJoin(from, rel);
      if (!(await exists(src))) continue;
      const isDir = (await fsp.stat(src)).isDirectory();
      let any = false;
      for (const f of isDir ? (await walkFiles(src)).map((x) => `${rel}/${x}`) : [rel]) {
        const dest = safeJoin(to, f);
        if (await exists(dest)) { kept.push(f); continue; }
        await ensureDir(path.dirname(dest));
        await fsp.copyFile(safeJoin(from, f), dest);
        any = true;
      }
      if (any) copied.push(rel === 'config' ? 'config folder' : rel);
    }
    return { copied, kept: kept.sort() };
  }

  /**
   * Installs what the user confirmed from plan(): `chosen` is a list of { type, source, projectId, versionId, title }
   * (dependencies are separate entries, so nothing is looked up a second time). Needs `confirmed: true`.
   * One failing file never stops the rest: it is listed in `problems` and the others go on.
   * Returns { installed, skipped, blocked, warnings, problems: [{ title, why }], copied, kept }.
   * Settings files are only copied where the instance has none: `kept` lists the ones that stayed as they were.
   * What gets installed is marked `fromTemplate` in content.json. In a linked modpack it is never a pack file ("Added by you").
   */
  async apply(instId, chosen, { confirmed = false, templateId = null, copyFiles = false, report = () => {} } = {}) {
    if (confirmed !== true) throw new Error('Please review the list and confirm before installing.');
    const out = { installed: [], skipped: [], blocked: [], warnings: [], problems: [], copied: [], kept: [] };
    let from = null;
    if (templateId) { const t = await this.get(templateId).catch(() => null); if (t) from = { id: t.id, name: t.name }; }
    if (from) await this.instances.update(instId, { template: from }).catch(() => {}); // remembered for the instance card; a failure here never stops the install
    if (copyFiles && templateId) {
      try { Object.assign(out, await this.copyFiles(instId, templateId)); } catch (e) { out.problems.push({ title: 'Settings files', why: describeError(e) }); }
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
        if (from && r.installed.length) {
          await this.instances.withIndex(instId, (idx) => { for (const x of r.installed) if (idx.files[x.file]) idx.files[x.file].fromTemplate = from; });
        }
      } catch (e) {
        if (e instanceof CancelledError || e?.name === 'CancelledError') throw e; // Cancel stops everything; any other error only this file
        out.problems.push({ title: c.title || String(c.projectId), why: describeError(e) });
      }
    }
    report(1, out.problems.length ? 'Done with problems' : 'Done');
    return out;
  }
}

module.exports = { Templates, TYPE_LABEL, findConflicts, knownModOf, CONFLICT_PAIRS };
