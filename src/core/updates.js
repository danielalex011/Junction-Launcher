'use strict';
// Junction updating itself (installed Windows build only). This is the logic around electron-updater: when to check, what the bar says, what
// went wrong in plain words, and the rule that nothing is installed without a click. Plain Node: it never requires Electron or electron-updater.
// The real updater is handed in by main.js (it is an EventEmitter with checkForUpdates / downloadUpdate / quitAndInstall); tests hand in a fake one.
// The only network request is the updater's own: GitHub's release feed (latest.yml) and the installer file. No identifiers are sent.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const REPO_URL = 'https://github.com/danielalex011/Junction-Launcher';
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 20 * 1000; // a little after startup, so the window opens first

/** [major, minor, patch, prerelease-tags]. Leading "v" and build metadata are ignored. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : []];
}

/** -1, 0 or 1 (semver order: 0.2.0-beta.1 < 0.2.0). null when either is not a version. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  const p = x[3];
  const q = y[3];
  if (!p.length && !q.length) return 0;
  if (!p.length) return 1;
  if (!q.length) return -1;
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const pn = /^\d+$/.test(p[i]);
    const qn = /^\d+$/.test(q[i]);
    if (pn && qn) { if (Number(p[i]) !== Number(q[i])) return Number(p[i]) < Number(q[i]) ? -1 : 1; } else if (pn !== qn) return pn ? -1 : 1;
    else if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

/** Junction is "pre-release" while it is 0.x or carries a -beta style tag: then GitHub pre-releases count as updates. */
function isPrereleasePhase(version) {
  const v = parseVersion(version);
  return Boolean(v && (v[0] === 0 || v[3].length));
}

/** Only the installed (NSIS) build updates itself: not `npm start`, a deploy:dev folder, the zip or the MSI. Returns { ok, reason }. */
function selfUpdateSupport({ platform, packaged, devBuild, exePath, productName = 'Junction', exists = fs.existsSync }) {
  if (platform !== 'win32') return { ok: false, reason: 'platform' };
  if (!packaged || devBuild) return { ok: false, reason: 'dev' };
  // The NSIS installer puts "Uninstall <name>.exe" next to the app. The zip and the MSI have none, so they are told to use the Releases page.
  if (!exists(path.join(path.dirname(exePath), `Uninstall ${productName}.exe`))) return { ok: false, reason: 'portable' };
  return { ok: true, reason: '' };
}

/** What went wrong, in a sentence that says what to do next. Never shows a response body. */
function plainUpdateError(err) {
  const msg = String((err && (err.message || err)) || '');
  const code = String((err && err.code) || '');
  if (/sha512|sha-512|checksum|integrity/i.test(msg) || code === 'ERR_UPDATER_CHECKSUM_MISMATCH') {
    return 'The downloaded update did not match its checksum, so Junction threw it away and installed nothing. Try again later, or download the new version from the Releases page.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|net::ERR_|getaddrinfo|socket hang up|timed? ?out|offline/i.test(`${code} ${msg}`)) {
    return 'Could not reach GitHub. Check your internet connection and try again.';
  }
  if (/\b(403|429)\b|rate limit/i.test(msg)) return 'GitHub is busy right now. Try again in a little while.';
  if (/\b404\b|Cannot find latest|No published versions|not found/i.test(msg)) return 'No update information was found on GitHub yet.';
  return 'Could not check for updates. Try again in a little while.';
}

async function sha512Base64(file) {
  const h = crypto.createHash('sha512');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', resolve);
  });
  return h.digest('base64');
}

/** The sha512 latest.yml lists for the downloaded file (matched by file name), or the top-level one. */
function expectedSha512(info, file) {
  const name = path.basename(String(file));
  const files = Array.isArray(info?.files) ? info.files : [];
  const hit = files.find((f) => f && f.url && path.basename(decodeURIComponent(String(f.url))) === name);
  return (hit && hit.sha512) || (files.length === 1 && files[0].sha512) || info?.sha512 || null;
}

class UpdateManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.version  the running version
   * @param {object|null} o.updater  electron-updater's autoUpdater, or null when this build does not update itself
   * @param {{ ok: boolean, reason?: string }} o.support  from selfUpdateSupport()
   * @param {() => boolean} o.autoCheck  "Check for updates automatically"
   * @param {{ setTimeout, setInterval, clearTimeout, clearInterval }} [o.timers]
   */
  constructor({ version, updater = null, support = { ok: true }, autoCheck = () => true, timers = global, now = () => Date.now() }) {
    super();
    this.version = version;
    this.updater = support.ok ? updater : null;
    this.autoCheck = autoCheck;
    this.timers = timers;
    this.now = now;
    this.s = {
      status: support.ok ? 'idle' : 'unsupported', // idle | checking | uptodate | downloading | ready | error | unsupported
      current: version, version: null, notesUrl: null, percent: 0, message: '', lastChecked: null, manual: false,
      supported: Boolean(support.ok), reason: support.reason || '', releasesUrl: `${REPO_URL}/releases`,
    };
    this.pending = null; // the download that finished and passed the checksum: only this can be installed
    this.busy = false;
    this._timers = [];
    if (this.updater) this._wire();
  }

  get state() { return { ...this.s }; }

  _set(patch) {
    this.s = { ...this.s, ...patch };
    this.emit('state', this.state);
  }

  _wire() {
    const u = this.updater;
    u.autoDownload = false; // we start the download ourselves, after we know it is a newer version
    u.autoInstallOnAppQuit = false; // never install without the click
    u.allowDowngrade = false;
    u.allowPrerelease = isPrereleasePhase(this.version);
    u.on('download-progress', (p) => { if (this.s.status === 'downloading') this._set({ percent: Math.max(0, Math.min(100, Math.round(p?.percent || 0))) }); });
  }

  /** Check on startup (after a short wait) and then once a day, when "Check for updates automatically" is on. */
  start() {
    if (!this.updater) return;
    const run = () => { if (this.autoCheck()) this.check({ manual: false }).catch(() => {}); };
    this._timers.push({ t: this.timers.setTimeout(run, FIRST_CHECK_MS), kind: 'timeout' });
    this._timers.push({ t: this.timers.setInterval(run, DAY_MS), kind: 'interval' });
  }

  stop() {
    for (const { t, kind } of this._timers) (kind === 'timeout' ? this.timers.clearTimeout : this.timers.clearInterval)(t);
    this._timers = [];
  }

  /** Looks for a newer version; if there is one, downloads it in the background. Never installs. Resolves to the new state. */
  async check({ manual = false } = {}) {
    if (!this.updater) return this.state;
    if (this.busy || this.s.status === 'ready') return this.state; // already working, or already waiting for the click
    this.busy = true;
    this._set({ status: 'checking', message: '', manual, percent: 0 });
    try {
      const r = await this.updater.checkForUpdates();
      const info = r && r.updateInfo;
      const newer = info && info.version && compareVersions(info.version, this.version) === 1;
      const stamp = this.now();
      if (!newer) {
        this._set({ status: 'uptodate', version: null, notesUrl: null, lastChecked: stamp });
        return this.state;
      }
      this._set({ status: 'downloading', version: info.version, notesUrl: `${REPO_URL}/releases/tag/v${info.version}`, percent: 0, lastChecked: stamp });
      await this._download(info);
    } catch (e) {
      this._set({ status: 'error', message: plainUpdateError(e), version: null, notesUrl: null, lastChecked: this.now() });
    } finally {
      this.busy = false;
    }
    return this.state;
  }

  async _download(info) {
    let ok;
    let bad;
    const done = new Promise((resolve, reject) => { ok = resolve; bad = reject; });
    this.updater.on('update-downloaded', ok);
    this.updater.on('error', bad);
    let ev;
    try {
      const dl = this.updater.downloadUpdate();
      ev = await Promise.race([done, Promise.resolve(dl).then(() => done)]);
    } finally {
      this.updater.removeListener('update-downloaded', ok);
      this.updater.removeListener('error', bad);
      done.catch(() => {}); // a late 'error' after we are done is not an unhandled rejection
    }
    // Belt and braces: electron-updater already checks the hash, but "never install a file that does not match latest.yml" is worth its own check.
    const file = ev?.downloadedFile;
    const want = expectedSha512(ev && ev.files ? ev : info, file);
    if (!file || !want || (await sha512Base64(file).catch(() => null)) !== want) {
      if (file) fs.rm(file, { force: true }, () => {});
      throw Object.assign(new Error('sha512 checksum mismatch'), { code: 'ERR_UPDATER_CHECKSUM_MISMATCH' });
    }
    this.pending = { version: info.version, file };
    this._set({ status: 'ready', percent: 100, version: info.version });
  }

  /** The "Install and restart" click. Only a finished, verified download can be installed. */
  install() {
    if (!this.updater || this.s.status !== 'ready' || !this.pending) return false;
    this.updater.quitAndInstall(false, true); // not silent: the installer shows progress; run Junction again afterwards
    return true;
  }
}

module.exports = { UpdateManager, compareVersions, parseVersion, isPrereleasePhase, selfUpdateSupport, plainUpdateError, expectedSha512, sha512Base64, REPO_URL, DAY_MS, FIRST_CHECK_MS };
