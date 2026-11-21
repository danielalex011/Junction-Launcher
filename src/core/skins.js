'use strict';
// Skins: the wardrobe (saved skins + history, shared between accounts), checks on skin files,
// and the calls to Mojang that change the skin / cape of a Microsoft account or look up a player.
//
// Only Mojang's own hosts are ever contacted, and the sign-in token only goes to
// api.minecraftservices.com (see MC_HOST). Nothing here logs a token.
const fs = require('fs');
const path = require('path');
const { decodePng, PngError } = require('./png');
const { SKIN_HOST } = require('./skin');
const { readJson, writeJson, hashBuffer, shortId } = require('./util');

const MC_HOST = 'api.minecraftservices.com';
const LOOKUP_HOST = 'api.mojang.com';
const SESSION_HOST = 'sessionserver.mojang.com';
const MAX_SKIN_FILE = 512 * 1024; // real skins are a few KB
const MAX_CAPE_FILE = 512 * 1024;
const HISTORY_LIMIT = 40;
const MODELS = ['classic', 'slim'];

class SkinError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// ---------------------------------------------------------------- checking skin files
/**
 * Slim ("Alex") skins leave the last pixel column of each arm texture empty, classic ("Steve") skins use it.
 * These four 2-pixel-wide strips are the unused columns of the right and left arm. 64x32 skins have no slim variant.
 */
function guessModel(rgba, width, height) {
  if (width !== 64 || height !== 64) return 'classic';
  const blank = (x, y, w, h) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (rgba[(yy * width + xx) * 4 + 3] !== 0) return false;
    return true;
  };
  return blank(50, 16, 2, 4) && blank(54, 20, 2, 12) && blank(42, 48, 2, 4) && blank(46, 52, 2, 12) ? 'slim' : 'classic';
}

/** Checks that a buffer is a real PNG skin (64x64, or the old 64x32). Returns what it found; throws SkinError with a plain sentence. */
function inspectSkin(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new SkinError('That file is empty.', 'BAD_SKIN');
  if (buf.length > MAX_SKIN_FILE) throw new SkinError('That file is too big to be a skin.', 'BAD_SKIN');
  let img;
  try { img = decodePng(buf, { maxSide: 512 }); } catch (e) {
    if (e instanceof PngError) throw new SkinError(e.message, 'BAD_SKIN');
    throw e;
  }
  const { width, height, rgba } = img;
  if (!((width === 64 && height === 64) || (width === 64 && height === 32))) {
    throw new SkinError(`Skins must be 64×64 pixels (or the old 64×32). This picture is ${width}×${height}.`, 'BAD_SKIN');
  }
  return { width, height, legacy: height === 32, model: guessModel(rgba, width, height), sha1: hashBuffer(buf, 'sha1') };
}

function cleanName(name, fallback = 'My skin') {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32);
  return n || fallback;
}

const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

/** A texture address from Mojang: https (http is upgraded) on textures.minecraft.net, or null. */
function textureUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.hostname !== SKIN_HOST || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.port) return null;
    u.protocol = 'https:';
    return u.toString();
  } catch { return null; }
}

/** What to tell people when Mojang's skin service says no. Never shows the response body. */
function apiMessage(status, { retryAfter = 0, what = 'skin' } = {}) {
  if (status === 429) {
    const mins = Math.ceil(retryAfter / 60000);
    return mins > 1 ? `You've changed your ${what} too often, try again in about ${mins} minutes.` : `You've changed your ${what} too often, try again in a few minutes.`;
  }
  if (status === 401) return 'Mojang did not accept this sign-in. Remove the account and sign in again.';
  if (status === 403) return 'Mojang refused the change. The account may be restricted, or the file was not accepted.';
  if (status === 400 || status === 415) return what === 'cape' ? 'Mojang did not accept that cape. This account may not own it.' : 'Mojang did not accept that skin file.';
  if (status === 404) return 'Mojang could not find this profile. Does the account own Minecraft: Java Edition?';
  if (status >= 500) return 'Mojang\'s skin service is having trouble. Try again in a few minutes.';
  return `Mojang's skin service answered with an unexpected error (${status}).`;
}

function retryAfterMs(res) {
  const secs = Number(res.headers?.get?.('retry-after'));
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
}

// ---------------------------------------------------------------- the service
class Skins {
  constructor(ctx, accounts) {
    this.ctx = ctx;
    this.accounts = accounts;
    this.dir = ctx.paths.wardrobe;
    this.indexFile = path.join(this.dir, 'index.json');
    this.textures = new Map(); // texture url -> data url (textures never change under the same address)
    this.queue = Promise.resolve();
  }

  /** Runs index changes one after another so two quick clicks can't overwrite each other. */
  lock(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async index() {
    const idx = await readJson(this.indexFile, { skins: [], history: [] });
    if (!Array.isArray(idx.skins)) idx.skins = [];
    if (!Array.isArray(idx.history)) idx.history = [];
    return idx;
  }

  async saveIndex(idx) {
    fs.mkdirSync(this.dir, { recursive: true });
    await writeJson(this.indexFile, idx);
  }

  fileOf(id) {
    if (!/^[a-f0-9]{6,16}$/.test(String(id))) throw new SkinError('Unknown skin.', 'NOT_FOUND');
    return path.join(this.dir, `${id}.png`);
  }

  async writeSkinFile(buf) {
    const id = shortId(8);
    fs.mkdirSync(this.dir, { recursive: true });
    const dest = this.fileOf(id);
    fs.writeFileSync(`${dest}.part`, buf);
    fs.renameSync(`${dest}.part`, dest);
    return id;
  }

  dropFile(id) { try { fs.rmSync(this.fileOf(id), { force: true }); } catch { /* already gone */ } }

  view(entry) {
    let src = null;
    try { src = dataUrl(fs.readFileSync(this.fileOf(entry.id))); } catch { /* file went missing: shown without a picture */ }
    return { ...entry, dataUrl: src };
  }

  async list() {
    const idx = await this.index();
    return { skins: idx.skins.map((s) => this.view(s)), history: idx.history.map((s) => this.view(s)) };
  }

  /** Reads a skin file from disk and checks it. Returns what to show in the "add skin" window. */
  async inspectFile(file) {
    const buf = this.readSkinFile(file);
    const info = inspectSkin(buf);
    const base = path.basename(String(file)).replace(/\.png$/i, '');
    return { ...info, dataUrl: dataUrl(buf), suggestedName: cleanName(base, 'My skin') };
  }

  readSkinFile(file) {
    let st;
    try { st = fs.statSync(String(file)); } catch { throw new SkinError('Junction could not open that file.', 'BAD_SKIN'); }
    if (!st.isFile()) throw new SkinError('That is not a file.', 'BAD_SKIN');
    if (st.size > MAX_SKIN_FILE) throw new SkinError('That file is too big to be a skin.', 'BAD_SKIN');
    return fs.readFileSync(String(file));
  }

  /** Saves a checked skin picture into the wardrobe. */
  async addBuffer(buf, { name, model, origin = 'file' }) {
    const info = inspectSkin(buf);
    const useModel = MODELS.includes(model) ? model : info.model;
    return this.lock(async () => {
      const id = await this.writeSkinFile(buf);
      const entry = { id, name: cleanName(name), model: useModel, sha1: info.sha1, origin, addedAt: Date.now() };
      const idx = await this.index();
      idx.skins.push(entry);
      await this.saveIndex(idx);
      return this.view(entry);
    });
  }

  async addFile({ path: file, name, model }) {
    return this.addBuffer(this.readSkinFile(file), { name, model, origin: 'file' });
  }

  async update(id, patch) {
    return this.lock(async () => {
      const idx = await this.index();
      const entry = idx.skins.find((s) => s.id === id);
      if (!entry) throw new SkinError('That skin is no longer in your wardrobe.', 'NOT_FOUND');
      if (patch.name !== undefined) entry.name = cleanName(patch.name, entry.name);
      if (patch.model !== undefined) {
        if (!MODELS.includes(patch.model)) throw new SkinError('The arm model is classic or slim.', 'BAD_MODEL');
        entry.model = patch.model;
      }
      await this.saveIndex(idx);
      return this.view(entry);
    });
  }

  async remove(kind, id) {
    return this.lock(async () => {
      const idx = await this.index();
      const key = kind === 'history' ? 'history' : 'skins';
      const entry = idx[key].find((s) => s.id === id);
      if (!entry) return;
      idx[key] = idx[key].filter((s) => s.id !== id);
      await this.saveIndex(idx);
      this.dropFile(id);
    });
  }

  async clearHistory() {
    return this.lock(async () => {
      const idx = await this.index();
      for (const s of idx.history) this.dropFile(s.id);
      idx.history = [];
      await this.saveIndex(idx);
    });
  }

  /** Copies a history entry into the wardrobe. */
  async keepFromHistory(id) {
    const idx = await this.index();
    const h = idx.history.find((s) => s.id === id);
    if (!h) throw new SkinError('That skin is no longer in your history.', 'NOT_FOUND');
    return this.addBuffer(fs.readFileSync(this.fileOf(id)), { name: h.name, model: h.model, origin: 'history' });
  }

  async remember(entry, buf, accountName) {
    return this.lock(async () => {
      const idx = await this.index();
      const same = idx.history.find((s) => s.sha1 === entry.sha1 && s.model === entry.model);
      if (same) {
        same.appliedAt = Date.now(); same.by = accountName; same.name = entry.name;
        idx.history.sort((a, b) => b.appliedAt - a.appliedAt);
      } else {
        const id = await this.writeSkinFile(buf);
        idx.history.unshift({ id, name: entry.name, model: entry.model, sha1: entry.sha1, appliedAt: Date.now(), by: accountName });
        for (const old of idx.history.splice(HISTORY_LIMIT)) this.dropFile(old.id);
      }
      await this.saveIndex(idx);
    });
  }

  // ------------------------------------------------------------ talking to Mojang
  /** The account to work on: an id, or the active one. Microsoft accounts only when `needMsa`. */
  account(id, { needMsa = false } = {}) {
    const acc = id ? this.accounts.get(id) : this.accounts.data.accounts.find((a) => a.id === this.accounts.data.active);
    if (!acc) throw new SkinError('Add an account first: click the account at the bottom left.', 'NO_ACCOUNT');
    if (needMsa && acc.type !== 'msa') throw new SkinError('Offline accounts can\'t change skins. Switch to a Microsoft account.', 'OFFLINE');
    return acc;
  }

  /** A call to Minecraft services as the account. The token is only attached to api.minecraftservices.com. */
  async mc(acc, method, apiPath, { json, form, what = 'skin' } = {}) {
    const url = `https://${MC_HOST}${apiPath}`;
    if (new URL(url).hostname !== MC_HOST) throw new Error('Refusing to send the sign-in token anywhere else');
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accounts.freshMcToken(acc, { force: attempt > 0 });
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      let body;
      if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
      if (form) body = form;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      let res;
      try {
        res = await this.ctx.http.fetch(url, { method, headers: this.ctx.http.headersFor(url, headers), body, signal: ac.signal, redirect: 'error' });
      } catch {
        throw new SkinError('Junction could not reach Mojang. Check your internet connection and try again.', 'NETWORK');
      } finally { clearTimeout(timer); }
      if (res.status === 401 && attempt === 0) continue; // the token may have just expired: sign in again once
      if (!res.ok) {
        const err = new SkinError(apiMessage(res.status, { retryAfter: retryAfterMs(res), what }), res.status === 429 ? 'RATE_LIMIT' : 'MOJANG');
        err.status = res.status;
        throw err;
      }
      const text = await res.text().catch(() => '');
      try { return text ? JSON.parse(text) : null; } catch { return null; }
    }
    throw new SkinError(apiMessage(401), 'MOJANG');
  }

  /** An unauthenticated GET on one of Mojang's lookup hosts. Returns {status, json}. */
  async lookup(url) {
    const host = new URL(url).hostname;
    if (host !== LOOKUP_HOST && host !== SESSION_HOST && host !== MC_HOST) throw new Error('Not a Mojang address');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const res = await this.ctx.http.fetch(url, { headers: this.ctx.http.headersFor(url, { Accept: 'application/json' }), signal: ac.signal, redirect: 'error' });
      if (res.status === 429) throw new SkinError('Mojang is busy answering player lookups. Try again in a minute.', 'RATE_LIMIT');
      const json = res.ok && res.status !== 204 ? await res.json().catch(() => null) : null;
      return { status: res.status, json };
    } catch (e) {
      if (e instanceof SkinError) throw e;
      throw new SkinError('Junction could not reach Mojang. Check your internet connection and try again.', 'NETWORK');
    } finally { clearTimeout(timer); }
  }

  /** Downloads a picture from Mojang's texture server (checked: right host, real PNG, sane size). */
  async texture(rawUrl, { skin = false } = {}) {
    const url = textureUrl(rawUrl);
    if (!url) throw new SkinError('That texture is not on Mojang\'s texture server.', 'BAD_SKIN');
    const res = await this.ctx.http.request(url, { retries: 1, timeout: 15000 });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > (skin ? MAX_SKIN_FILE : MAX_CAPE_FILE)) throw new SkinError('That texture is too big.', 'BAD_SKIN');
    return buf;
  }

  async textureData(rawUrl, opts) {
    const url = textureUrl(rawUrl);
    if (!url) return null;
    if (this.textures.has(url)) return this.textures.get(url);
    try {
      const buf = await this.texture(url, opts);
      decodePng(buf, { maxSide: 512 }); // must be a real picture
      if (this.textures.size > 80) this.textures.clear();
      this.textures.set(url, dataUrl(buf));
      return this.textures.get(url);
    } catch { return null; }
  }

  /** The account's profile as the Skins page shows it: current skin and owned capes, with their pictures. */
  async profileView(raw, acc) {
    const skin = (Array.isArray(raw?.skins) ? raw.skins : []).find((s) => s?.state === 'ACTIVE') || null;
    const capes = (Array.isArray(raw?.capes) ? raw.capes : []).filter((c) => c && typeof c.id === 'string');
    return {
      account: { id: acc.id, name: acc.name, type: acc.type },
      name: raw?.name || acc.name,
      skin: skin && textureUrl(skin.url) ? { dataUrl: await this.textureData(skin.url, { skin: true }), variant: String(skin.variant).toUpperCase() === 'SLIM' ? 'slim' : 'classic' } : null,
      capes: await Promise.all(capes.map(async (c) => ({
        id: c.id, alias: String(c.alias || 'Cape').slice(0, 40), active: c.state === 'ACTIVE', dataUrl: await this.textureData(c.url),
      }))),
    };
  }

  async profile(accountId) {
    const acc = this.account(accountId);
    if (acc.type !== 'msa') return { account: { id: acc.id, name: acc.name, type: acc.type }, offline: true, name: acc.name, skin: null, capes: [] };
    const raw = await this.mc(acc, 'GET', '/minecraft/profile');
    return this.profileView(raw, acc);
  }

  /** Keeps the account chip's head in step with what Mojang now says. */
  async syncHead(acc, raw) {
    const active = (Array.isArray(raw?.skins) ? raw.skins : []).find((s) => s?.state === 'ACTIVE');
    if (active && textureUrl(active.url)) {
      acc.skinUrl = null; // force a fresh download even if only the arm model changed
      await this.accounts.saveSkin(acc, { skins: [{ state: 'ACTIVE', url: textureUrl(active.url) }] });
    } else await this.accounts.clearSkin(acc);
  }

  /** Uploads a wardrobe or history skin (as checked by inspectSkin) to the account. */
  async apply({ kind = 'wardrobe', id, accountId, model }) {
    const acc = this.account(accountId, { needMsa: true });
    const idx = await this.index();
    const entry = (kind === 'history' ? idx.history : idx.skins).find((s) => s.id === id);
    if (!entry) throw new SkinError('That skin is no longer saved.', 'NOT_FOUND');
    const buf = fs.readFileSync(this.fileOf(id));
    inspectSkin(buf); // checked again right before it leaves the computer
    const variant = MODELS.includes(model) ? model : entry.model; // the arm model chosen in the preview wins over the saved one
    const form = new FormData();
    form.append('variant', variant);
    form.append('file', new Blob([buf], { type: 'image/png' }), 'skin.png');
    let raw = await this.mc(acc, 'POST', '/minecraft/profile/skins', { form });
    await this.remember({ ...entry, model: variant }, buf, acc.name);
    if (!raw || !Array.isArray(raw.skins)) raw = await this.mc(acc, 'GET', '/minecraft/profile');
    await this.syncHead(acc, raw);
    return this.profileView(raw, acc);
  }

  async resetSkin(accountId) {
    const acc = this.account(accountId, { needMsa: true });
    let raw = await this.mc(acc, 'DELETE', '/minecraft/profile/skins/active');
    if (!raw || !Array.isArray(raw.skins)) raw = await this.mc(acc, 'GET', '/minecraft/profile');
    await this.syncHead(acc, raw);
    return this.profileView(raw, acc);
  }

  /** Puts a cape on, or takes it off when capeId is null. */
  async setCape(accountId, capeId) {
    const acc = this.account(accountId, { needMsa: true });
    let raw;
    if (capeId === null || capeId === undefined) raw = await this.mc(acc, 'DELETE', '/minecraft/profile/capes/active', { what: 'cape' });
    else {
      if (!/^[A-Za-z0-9-]{8,64}$/.test(String(capeId))) throw new SkinError('Unknown cape.', 'BAD_CAPE');
      raw = await this.mc(acc, 'PUT', '/minecraft/profile/capes/active', { json: { capeId: String(capeId) }, what: 'cape' });
    }
    if (!raw || !Array.isArray(raw.capes)) raw = await this.mc(acc, 'GET', '/minecraft/profile');
    return this.profileView(raw, acc);
  }

  /** Saves a player's current skin (found through Mojang's own services) into the wardrobe. */
  async importPlayer(name) {
    name = String(name || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new SkinError('Player names are 3 to 16 letters, numbers or _.', 'BAD_NAME');
    const enc = encodeURIComponent(name);
    let found = null;
    for (const url of [`https://${LOOKUP_HOST}/users/profiles/minecraft/${enc}`, `https://${MC_HOST}/minecraft/profile/lookup/name/${enc}`]) {
      let r;
      try { r = await this.lookup(url); } catch (e) { if (e.code === 'RATE_LIMIT') throw e; continue; }
      if (r.status === 404) throw new SkinError(`There is no player called ${name}.`, 'NOT_FOUND');
      if (r.json && /^[0-9a-f]{32}$/i.test(String(r.json.id || ''))) { found = r.json; break; }
    }
    if (!found) throw new SkinError('Mojang\'s lookup is not answering right now. Try again in a minute.', 'NETWORK');
    const prof = (await this.lookup(`https://${SESSION_HOST}/session/minecraft/profile/${found.id}`)).json;
    let tex = null;
    try {
      const prop = (prof?.properties || []).find((p) => p?.name === 'textures');
      tex = JSON.parse(Buffer.from(String(prop?.value || ''), 'base64').toString('utf8'))?.textures?.SKIN || null;
    } catch { /* no textures */ }
    if (!tex || !textureUrl(tex.url)) throw new SkinError(`${found.name || name} has no custom skin, so there is nothing to save.`, 'NO_SKIN');
    const buf = await this.texture(tex.url, { skin: true });
    return this.addBuffer(buf, { name: found.name || name, model: tex.metadata?.model === 'slim' ? 'slim' : 'classic', origin: 'player' });
  }
}

module.exports = { Skins, SkinError, inspectSkin, guessModel, cleanName, textureUrl, apiMessage };
