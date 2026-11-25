'use strict';
const { readJson, writeJson, totalMemMB } = require('./util');
const { DEFAULT_APPEARANCE, normalizeAppearance } = require('./appearance');

const SECRET_KEYS = ['cfApiKey'];

function defaults() {
  const total = totalMemMB();
  return {
    memoryMax: Math.max(2048, Math.min(8192, Math.floor(total / 4 / 512) * 512)),
    memoryMin: 1024,
    jvmArgs: '',
    javaPath: '',
    msClientId: '',
    concurrency: 16,
    preferredSource: 'ask', // 'ask' | 'modrinth' | 'curseforge': where Install goes when a project is on both
    sources: { modrinth: true, curseforge: true },
    startPage: 'home', // 'home' | 'library'
    onLaunch: 'keep', // what Junction does when the game starts: 'keep' | 'minimize' | 'hide'
    notifyOnFinish: true, // desktop notification when a download or install finishes
    javaByMajor: {}, // { "17": "C:\\...\\javaw.exe" } one chosen Java per Java version (8, 17, 21, 25); missing = automatic
    speedLimitMBps: 0, // 0 = no limit
    backupsKept: 5, // update backups kept per instance
    showSnapshots: false,
    includeOptionalPackFiles: true,
    updateChannel: 'auto', // auto (each mod stays on its own channel) | release | beta | alpha
    confirmBeforeDelete: true,
    appearance: { ...DEFAULT_APPEARANCE }, // accent, background, corners, sidebar, size (see appearance.js)
    showNews: true, // Minecraft news carousel on Home
    checkForUpdates: true, // the installed build looks for a new Junction on GitHub at startup and then daily (it still asks before installing)
    cfApiBase: 'https://api.curseforge.com',
  };
}

class Settings {
  constructor(file, crypto, builtins = {}) {
    this.file = file;
    this.crypto = crypto;
    this.builtins = builtins; // defaults baked into the build (see build-config.js)
    this.data = defaults();
    this.secrets = {}; // encrypted, as stored on disk
    this.plain = {}; // decrypted, in memory only
  }

  async load() {
    const raw = await readJson(this.file, {});
    this.data = { ...defaults(), ...(raw.settings || {}) };
    this.data.sources = { ...defaults().sources, ...(raw.settings?.sources || {}) };
    if (raw.settings && 'closeOnLaunch' in raw.settings) { // before 0.1.34 this was a checkbox
      if (!raw.settings.onLaunch) this.data.onLaunch = raw.settings.closeOnLaunch ? 'hide' : 'keep';
      delete this.data.closeOnLaunch;
    }
    this.normalize();
    this.data.appearance = normalizeAppearance(raw.settings?.appearance);
    this.secrets = raw.secrets || {};
    this.plain = {};
    for (const k of SECRET_KEYS) {
      if (!this.secrets[k]) continue;
      try { this.plain[k] = await this.crypto.decrypt(this.secrets[k]); } catch { this.plain[k] = ''; }
    }
    return this;
  }

  async save() {
    await writeJson(this.file, { settings: this.data, secrets: this.secrets });
  }

  get(key) {
    if (SECRET_KEYS.includes(key)) return this.plain[key] || this.builtins[key] || '';
    if (key in this.builtins && !this.data[key]) return this.builtins[key];
    return this.data[key];
  }

  /** Every secret-ish value in use right now (the sign-in app ID and the CurseForge key, built-in or your own), so logs can hide them. */
  secretValues() {
    return [this.get('msClientId'), this.get('cfApiKey'), this.builtins.msClientId, this.builtins.cfApiKey].filter((v, i, all) => typeof v === 'string' && v.length >= 8 && all.indexOf(v) === i);
  }

  // What the UI is allowed to see: secrets are reported as present/absent only.
  publicView() {
    const out = { ...this.data };
    for (const k of SECRET_KEYS) out[`has_${k}`] = Boolean(this.secrets[k]);
    // Whether the build ships its own value (the value itself is never sent to the UI).
    out.builtin_msClientId = Boolean(this.builtins.msClientId);
    out.builtin_cfApiKey = Boolean(this.builtins.cfApiKey);
    return out;
  }

  async update(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (SECRET_KEYS.includes(k)) {
        if (v === null || v === '') { delete this.secrets[k]; delete this.plain[k]; } else {
          this.plain[k] = String(v).trim();
          this.secrets[k] = await this.crypto.encrypt(this.plain[k]);
        }
      } else if (k === 'appearance') {
        this.data.appearance = normalizeAppearance({ ...this.data.appearance, ...(v || {}) });
      } else if (k in defaults() || k === 'sources') {
        this.data[k] = v;
      }
    }
    this.normalize();
    await this.save();
    return this.publicView();
  }

  /** Keeps every value inside what the app understands, whatever was typed or found in an old file. */
  normalize() {
    const d = this.data;
    const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : fallback);
    d.memoryMax = Math.max(512, Math.round(num(d.memoryMax, 4096)));
    d.memoryMin = Math.max(256, Math.min(d.memoryMax, Math.round(num(d.memoryMin, 512))));
    d.concurrency = Math.max(1, Math.min(64, Math.round(num(d.concurrency, 16))));
    d.speedLimitMBps = Math.max(0, Math.min(10000, Math.round(num(d.speedLimitMBps, 0) * 100) / 100));
    d.backupsKept = Math.max(1, Math.min(50, Math.round(num(d.backupsKept, 5))));
    if (!['home', 'library'].includes(d.startPage)) d.startPage = 'home';
    if (!['keep', 'minimize', 'hide'].includes(d.onLaunch)) d.onLaunch = 'keep';
    d.notifyOnFinish = d.notifyOnFinish !== false;
    const by = {};
    for (const [k, v] of Object.entries(d.javaByMajor && typeof d.javaByMajor === 'object' ? d.javaByMajor : {})) {
      if (['8', '17', '21', '25'].includes(String(k)) && typeof v === 'string' && v.trim()) by[String(k)] = v.trim();
    }
    d.javaByMajor = by;
  }
}

module.exports = { Settings, defaults };
