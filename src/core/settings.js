'use strict';
const { readJson, writeJson, totalMemMB } = require('./util');

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
    preferredSource: 'modrinth',
    sources: { modrinth: true, curseforge: true },
    closeOnLaunch: false,
    showSnapshots: false,
    includeOptionalPackFiles: true,
    updateChannel: 'alpha', // newest of: release | beta | alpha
    confirmBeforeDelete: true,
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
      } else if (k in defaults() || k === 'sources') {
        this.data[k] = v;
      }
    }
    this.data.memoryMax = Math.max(512, Number(this.data.memoryMax) || 4096);
    this.data.memoryMin = Math.max(256, Math.min(this.data.memoryMax, Number(this.data.memoryMin) || 512));
    this.data.concurrency = Math.max(1, Math.min(64, Number(this.data.concurrency) || 16));
    await this.save();
    return this.publicView();
  }
}

module.exports = { Settings, defaults };
