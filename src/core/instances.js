'use strict';
// Instance storage. Each instance is a folder:
//   instance.json   settings (version, loader, memory, ...)
//   content.json    where every mod/pack file came from (source, project, version)
//   minecraft/      the game directory (mods, config, saves, ...)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { exists, readJson, writeJson, ensureDir, slugify, shortId, copyDir, hashFile, safeJoin, imageTypeOfFile } = require('./util');
const { readModMetadata, isClientOnly } = require('./content/metadata');

// datapacks/ is only used by modpacks that ship global data packs (loaded by a mod); new instances don't get the folder.
const TYPE_DIR = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
const ICON_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const DIR_TYPE = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader', datapacks: 'datapack' };
const CONTENT_EXT = { mod: ['.jar'], resourcepack: ['.zip'], shader: ['.zip'], datapack: ['.zip'] };

/** A modpack from Modrinth or CurseForge that the instance follows (gets pack updates, pack content is locked). */
function isLinkedPack(inst) {
  return Boolean(inst?.pack && ['modrinth', 'curseforge'].includes(inst.pack.source) && inst.pack.projectId != null);
}

/** 'client', 'server', 'both' or null, from Modrinth's client_side/server_side or the jar's environment. */
function sideOf(entry) {
  const s = entry?.sides;
  if (s && (s.client || s.server)) {
    if (s.server === 'unsupported') return 'client';
    if (s.client === 'unsupported') return 'server';
    return 'both';
  }
  const env = entry?.meta?.environment;
  if (env === 'client' || env === 'server') return env;
  if (env === '*' || env === 'both') return 'both';
  return null;
}

class Instances {
  constructor(ctx) {
    this.ctx = ctx;
    this.dir = ctx.paths.instances;
    this.locks = new Map();
  }

  instDir(id) { return safeJoin(this.dir, id); }
  gameDir(id) { return path.join(this.instDir(id), 'minecraft'); }

  async list() {
    const out = [];
    for (const e of await fsp.readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const j = await readJson(path.join(this.dir, e.name, 'instance.json'), null);
      if (j) out.push(j);
    }
    return out.sort((a, b) => (b.lastPlayed || b.created || 0) - (a.lastPlayed || a.created || 0));
  }

  async get(id) {
    const j = await readJson(path.join(this.instDir(id), 'instance.json'), null);
    if (!j) throw new Error(`Instance not found: ${id}`);
    return j;
  }

  async create({ name, mcVersion, loader = { type: 'vanilla' }, icon = null, pack = null }) {
    if (!mcVersion) throw new Error('Pick a Minecraft version');
    name = String(name || '').trim() || `${loader.type === 'vanilla' ? 'Vanilla' : loader.type} ${mcVersion}`;
    let id = slugify(name);
    if (await exists(path.join(this.dir, id))) id = `${id}-${shortId(4)}`;
    const inst = {
      id, name, mcVersion, loader, icon, pack,
      created: Date.now(), lastPlayed: null, playtimeMs: 0,
      memoryMax: null, memoryMin: null, jvmArgs: '', javaPath: '', resolution: null, joinServer: '',
    };
    await ensureDir(this.gameDir(id));
    for (const d of ['mods', 'resourcepacks', 'shaderpacks']) await ensureDir(path.join(this.gameDir(id), d));
    await writeJson(path.join(this.instDir(id), 'instance.json'), inst);
    await writeJson(path.join(this.instDir(id), 'content.json'), { files: {} });
    return inst;
  }

  async update(id, patch) {
    const inst = await this.get(id);
    const allowed = ['name', 'mcVersion', 'loader', 'icon', 'pack', 'lastPlayed', 'playtimeMs', 'memoryMax', 'memoryMin', 'jvmArgs', 'javaPath', 'resolution', 'joinServer', 'notes', 'importedFrom', 'originalIcon', 'iconVersion', 'unlinkedPack'];
    for (const k of allowed) if (k in patch) inst[k] = patch[k];
    await writeJson(path.join(this.instDir(id), 'instance.json'), inst);
    return inst;
  }

  // ---- icons -----------------------------------------------------------------
  // inst.icon is either an https URL (from a modpack) or "local:<file>" for an
  // image stored in the instance folder.

  async iconFile(id) {
    const inst = await this.get(id).catch(() => null);
    if (!inst || typeof inst.icon !== 'string' || !inst.icon.startsWith('local:')) return null;
    const file = path.join(this.instDir(id), path.basename(inst.icon.slice(6)));
    return (await exists(file)) ? file : null;
  }

  async setIconFromFile(id, src) {
    // The file's contents decide, not its name: pictures from other launchers
    // often have no extension (or the wrong one).
    const type = await imageTypeOfFile(src);
    if (!type) throw new Error('Pick a PNG, JPG, WebP or GIF image.');
    const ext = type.ext;
    const st = await fsp.stat(src);
    if (st.size > 10 * 1024 * 1024) throw new Error('That image is over 10 MB. Pick a smaller one.');
    const inst = await this.get(id);
    for (const e of ICON_EXT) await fsp.rm(path.join(this.instDir(id), `icon${e}`), { force: true });
    await fsp.copyFile(src, path.join(this.instDir(id), `icon${ext}`));
    const patch = { icon: `local:icon${ext}`, iconVersion: Date.now() };
    if (inst.icon && /^https:\/\//.test(inst.icon) && !inst.originalIcon) patch.originalIcon = inst.icon;
    return this.update(id, patch);
  }

  async clearIcon(id) {
    const inst = await this.get(id);
    for (const e of ICON_EXT) await fsp.rm(path.join(this.instDir(id), `icon${e}`), { force: true });
    return this.update(id, { icon: inst.originalIcon || null, iconVersion: Date.now() });
  }

  async remove(id) {
    await fsp.rm(this.instDir(id), { recursive: true, force: true });
  }

  async duplicate(id, name) {
    const src = await this.get(id);
    const copy = await this.create({ name: name || `${src.name} (copy)`, mcVersion: src.mcVersion, loader: src.loader, icon: src.icon, pack: src.pack });
    await copyDir(this.instDir(id), this.instDir(copy.id), { filter: (p) => !p.endsWith('instance.json') });
    const merged = { ...src, ...copy, created: Date.now(), lastPlayed: null, playtimeMs: 0, name: copy.name, id: copy.id };
    await writeJson(path.join(this.instDir(copy.id), 'instance.json'), merged);
    return merged;
  }

  // ---- content index -------------------------------------------------------
  async readIndex(id) {
    const j = await readJson(path.join(this.instDir(id), 'content.json'), { files: {} });
    if (!j.files) j.files = {};
    return j;
  }

  async writeIndex(id, idx) {
    await writeJson(path.join(this.instDir(id), 'content.json'), idx);
  }

  /** Serialises index edits per instance so parallel installs don't clobber each other. */
  async withIndex(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    let release;
    const cur = new Promise((r) => { release = r; });
    this.locks.set(id, prev.then(() => cur));
    await prev;
    try {
      const idx = await this.readIndex(id);
      const r = await fn(idx);
      await this.writeIndex(id, idx);
      return r;
    } finally {
      release();
    }
  }

  /** Lists files of one content type, merged with index info and jar metadata. */
  async listContent(id, type) {
    const sub = TYPE_DIR[type];
    const dir = path.join(this.gameDir(id), sub);
    const idx = await this.readIndex(id);
    let changed = false;
    const out = [];
    const names = await fsp.readdir(dir).catch(() => []);
    for (const name of names) {
      const enabled = !name.endsWith('.disabled');
      const base = enabled ? name : name.slice(0, -'.disabled'.length);
      if (!CONTENT_EXT[type].some((e) => base.toLowerCase().endsWith(e))) continue;
      const rel = `${sub}/${base}`;
      const full = path.join(dir, name);
      const st = await fsp.stat(full).catch(() => null);
      if (!st || !st.isFile()) continue;
      let entry = idx.files[rel];
      if (!entry) { entry = {}; idx.files[rel] = entry; changed = true; }
      if (type === 'mod' && (entry.metaSize !== st.size || entry.metaMtime !== st.mtimeMs)) {
        const meta = readModMetadata(full);
        entry.meta = meta || null;
        entry.metaSize = st.size;
        entry.metaMtime = st.mtimeMs;
        entry.sha1 = await hashFile(full, 'sha1');
        changed = true;
      } else if (!entry.sha1) {
        entry.sha1 = await hashFile(full, 'sha1');
        changed = true;
      }
      out.push({
        file: rel,
        fileName: base,
        enabled,
        size: st.size,
        source: entry.source || 'local',
        projectId: entry.projectId || null,
        versionId: entry.versionId || null,
        title: entry.title || entry.meta?.name || base.replace(/\.(jar|zip)$/i, ''),
        versionName: (entry.meta?.version && !String(entry.meta.version).includes('${') ? entry.meta.version : null) || entry.versionName || '',
        icon: entry.icon || null,
        url: entry.projectUrl || null,
        modId: entry.meta?.modId || null,
        loader: entry.meta?.loader || null,
        pinned: Boolean(entry.pinned),
        fromPack: Boolean(entry.fromPack),
        packChanged: Boolean(entry.fromPack && entry.packChanged),
        sides: entry.sides || null,
        side: sideOf(entry),
        clientOnly: type === 'mod' && isClientOnly({ environment: entry.meta?.environment, sides: entry.sides }),
      });
    }
    // Drop index entries whose files were deleted outside the launcher.
    const present = new Set(out.map((o) => o.file));
    for (const rel of Object.keys(idx.files)) {
      if (rel.startsWith(`${sub}/`) && !present.has(rel)) { delete idx.files[rel]; changed = true; }
    }
    if (changed) await this.writeIndex(id, idx);
    // Flag duplicate mod ids (e.g. the same mod from both Modrinth and CurseForge).
    if (type === 'mod') {
      const seen = new Map();
      for (const o of out) {
        if (!o.modId || !o.enabled) continue;
        if (seen.has(o.modId)) { o.duplicateOf = seen.get(o.modId); } else seen.set(o.modId, o.fileName);
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * Every mod in every instance, from the saved content.json files only (no jar is opened), for the quick search.
   * An instance whose mods have never been listed has no entries yet.
   */
  async modIndex() {
    const out = [];
    for (const inst of await this.list()) {
      const idx = await this.readIndex(inst.id).catch(() => null);
      for (const [rel, e] of Object.entries(idx?.files || {})) {
        if (!rel.startsWith('mods/')) continue;
        const title = e.title || e.meta?.name || path.basename(rel).replace(/\.(jar|zip)$/i, '');
        const v = e.versionName || (e.meta?.version && !String(e.meta.version).includes('${') ? e.meta.version : '');
        out.push({ instanceId: inst.id, instanceName: inst.name, file: rel, title, version: String(v || '') });
      }
    }
    return out;
  }

  /** How many mods are switched on in each instance ({ id: count }): counts the .jar files in mods/, nothing is opened. */
  async modCounts() {
    const out = {};
    for (const inst of await this.list()) {
      const names = await fs.promises.readdir(path.join(this.gameDir(inst.id), 'mods')).catch(() => []);
      out[inst.id] = names.filter((n) => /\.jar$/i.test(n)).length;
    }
    return out;
  }

  contentPath(id, rel, enabled = true) {
    const full = safeJoin(this.gameDir(id), rel);
    return enabled ? full : `${full}.disabled`;
  }
}

module.exports = { Instances, isLinkedPack, sideOf, TYPE_DIR, DIR_TYPE, CONTENT_EXT, ICON_EXT };
