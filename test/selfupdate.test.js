'use strict';
// Self-update: the rules around electron-updater, tested with a fake updater that serves a mocked GitHub feed (latest.yml + the installer file).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { UpdateManager, compareVersions, isPrereleasePhase, selfUpdateSupport, plainUpdateError, DAY_MS, FIRST_CHECK_MS } = require('../src/core/updates');

const sha = (buf) => crypto.createHash('sha512').update(buf).digest('base64');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jx-upd-'));

/**
 * Acts like electron-updater against a mocked feed. `feed` is { version, bytes, listedSha512? } or an Error (offline, 404 ...).
 * `selfVerify` makes it do electron-updater's own hash check and fail with its message; with it off, a wrong file reaches Junction's own check.
 */
class FakeUpdater extends EventEmitter {
  constructor(feed, { selfVerify = false } = {}) {
    super();
    this.feed = feed;
    this.selfVerify = selfVerify;
    this.calls = [];
    this.dir = tmp();
  }

  async checkForUpdates() {
    this.calls.push('check');
    if (this.feed instanceof Error) throw this.feed;
    const f = this.feed;
    this.updateInfo = { version: f.version, files: [{ url: `Junction-${f.version}-win-x64.exe`, sha512: f.listedSha512 || sha(f.bytes), size: f.bytes.length }] };
    return { updateInfo: this.updateInfo };
  }

  async downloadUpdate() {
    this.calls.push('download');
    const file = path.join(this.dir, this.updateInfo.files[0].url);
    fs.writeFileSync(file, this.feed.bytes);
    this.emit('download-progress', { percent: 50 });
    if (this.selfVerify && sha(this.feed.bytes) !== this.updateInfo.files[0].sha512) {
      const err = new Error(`sha512 checksum mismatch, expected ${this.updateInfo.files[0].sha512}, got ${sha(this.feed.bytes)}`);
      this.emit('error', err);
      throw err;
    }
    this.emit('update-downloaded', { ...this.updateInfo, downloadedFile: file });
    return [file];
  }

  quitAndInstall(silent, runAfter) { this.calls.push(`install:${silent}:${runAfter}`); }
}

const mk = (feed, o = {}) => {
  const updater = new FakeUpdater(feed, o.updater);
  const m = new UpdateManager({ version: o.version || '0.1.51', updater, support: o.support || { ok: true }, autoCheck: o.autoCheck, timers: o.timers });
  return { m, updater };
};
const installer = Buffer.from('pretend this is the NSIS installer');

test('a newer version is found, downloaded in the background and only then offered; nothing installs until the click', async () => {
  const { m, updater } = mk({ version: '0.1.52', bytes: installer });
  const seen = [];
  m.on('state', (s) => seen.push(s.status));
  const s = await m.check({ manual: true });
  assert.equal(s.status, 'ready');
  assert.equal(s.version, '0.1.52');
  assert.equal(s.notesUrl, 'https://github.com/danielalex011/Junction-Launcher/releases/tag/v0.1.52');
  assert.deepEqual(seen.filter((x, i) => x !== seen[i - 1]), ['checking', 'downloading', 'ready']);
  assert.ok(!updater.calls.some((c) => c.startsWith('install')), 'no install without a click');
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false, 'it is not installed when Junction quits either');
  assert.equal(m.install(), true);
  assert.ok(updater.calls.includes('install:false:true'));
});

test('the same version, or an older one, is "up to date" and downloads nothing', async () => {
  for (const v of ['0.1.51', '0.1.50']) {
    const { m, updater } = mk({ version: v, bytes: installer });
    const s = await m.check();
    assert.equal(s.status, 'uptodate');
    assert.ok(!updater.calls.includes('download'));
    assert.equal(m.install(), false, 'nothing to install');
  }
});

test('a download that does not match latest.yml is thrown away with a plain message and cannot be installed', async () => {
  // electron-updater's own check fails first: its message becomes a sentence
  const a = mk({ version: '0.1.52', bytes: installer, listedSha512: sha(Buffer.from('something else')) }, { updater: { selfVerify: true } });
  const sa = await a.m.check({ manual: true });
  assert.equal(sa.status, 'error');
  assert.match(sa.message, /did not match its checksum.*installed nothing/);
  assert.ok(!sa.message.includes('expected'), 'the raw hashes are not shown');
  assert.equal(a.m.install(), false);
  // and if the updater let it through, Junction's own check still refuses it and deletes the file
  const b = mk({ version: '0.1.52', bytes: installer, listedSha512: sha(Buffer.from('something else')) });
  const sb = await b.m.check({ manual: true });
  assert.equal(sb.status, 'error');
  assert.match(sb.message, /checksum/);
  assert.equal(b.m.install(), false);
  assert.ok(!b.updater.calls.some((c) => c.startsWith('install')));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!fs.existsSync(path.join(b.updater.dir, 'Junction-0.1.52-win-x64.exe')), 'the bad file is deleted');
});

test('offline: a plain "could not reach GitHub" and the bar stays away; the next check works again', async () => {
  const offline = Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' });
  const { m, updater } = mk(offline);
  const s = await m.check();
  assert.equal(s.status, 'error');
  assert.equal(s.message, 'Could not reach GitHub. Check your internet connection and try again.');
  assert.equal(s.version, null);
  updater.feed = { version: '0.1.52', bytes: installer };
  assert.equal((await m.check()).status, 'ready');
});

test('plain error sentences', () => {
  assert.match(plainUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED')), /Could not reach GitHub/);
  assert.match(plainUpdateError(new Error('HttpError: 403 rate limit exceeded <html>secret body</html>')), /GitHub is busy/);
  assert.match(plainUpdateError(new Error('Cannot find latest.yml in the latest release artifacts (404)')), /No update information/);
  assert.equal(plainUpdateError(new Error('weird <html>body</html>')), 'Could not check for updates. Try again in a little while.');
  assert.ok(!/html|body/.test(plainUpdateError(new Error('weird <html>body</html>'))), 'never shows a response body');
});

test('checks on startup and then once a day, and only when "Check for updates automatically" is on', async () => {
  const fired = [];
  const timers = {
    setTimeout: (fn, ms) => { fired.push(['timeout', ms, fn]); return fired.length; },
    setInterval: (fn, ms) => { fired.push(['interval', ms, fn]); return fired.length; },
    clearTimeout() {}, clearInterval() {},
  };
  let on = true;
  const { m, updater } = mk({ version: '0.1.51', bytes: installer }, { timers, autoCheck: () => on });
  m.start();
  assert.deepEqual(fired.map((f) => [f[0], f[1]]), [['timeout', FIRST_CHECK_MS], ['interval', DAY_MS]]);
  assert.equal(DAY_MS, 24 * 60 * 60 * 1000);
  fired[0][2]();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(updater.calls.filter((c) => c === 'check').length, 1);
  on = false;
  fired[1][2]();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(updater.calls.filter((c) => c === 'check').length, 1, 'switched off: the daily check does nothing');
  assert.equal((await m.check({ manual: true })).status, 'uptodate', 'but Check now always works');
});

test('only the installed NSIS build updates itself; dev builds, the zip and the MSI point to the Releases page', async () => {
  const base = { platform: 'win32', packaged: true, devBuild: false, exePath: 'C:\\Users\\x\\AppData\\Local\\Programs\\Junction\\Junction.exe', productName: 'Junction' };
  assert.deepEqual(selfUpdateSupport({ ...base, exists: (f) => /Uninstall Junction\.exe$/.test(f) }), { ok: true, reason: '' });
  assert.equal(selfUpdateSupport({ ...base, exists: () => false }).reason, 'portable', 'zip / MSI: no NSIS uninstaller next to the exe');
  assert.equal(selfUpdateSupport({ ...base, devBuild: true, exists: () => true }).reason, 'dev');
  assert.equal(selfUpdateSupport({ ...base, packaged: false, exists: () => true }).reason, 'dev');
  assert.equal(selfUpdateSupport({ ...base, platform: 'linux', exists: () => true }).ok, false);
  const { m, updater } = mk({ version: '0.1.99', bytes: installer }, { support: { ok: false, reason: 'portable' } });
  m.start();
  const s = await m.check({ manual: true });
  assert.equal(s.status, 'unsupported');
  assert.equal(s.supported, false);
  assert.equal(s.releasesUrl, 'https://github.com/danielalex011/Junction-Launcher/releases');
  assert.deepEqual(updater.calls, [], 'no request at all');
  assert.equal(m.install(), false);
});

test('pre-releases count while Junction itself is a pre-release (0.x or tagged)', () => {
  assert.equal(isPrereleasePhase('0.1.51'), true);
  assert.equal(isPrereleasePhase('0.2.0'), true);
  assert.equal(isPrereleasePhase('1.0.0-beta.2'), true);
  assert.equal(isPrereleasePhase('1.0.0'), false);
  const { updater } = mk({ version: '0.2.0', bytes: installer });
  assert.equal(updater.allowPrerelease, true);
  const stable = new UpdateManager({ version: '1.2.0', updater: new FakeUpdater({ version: '1.3.0', bytes: installer }), support: { ok: true } });
  assert.equal(stable.updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
});

test('version order: patches, minors, pre-releases', () => {
  assert.equal(compareVersions('0.1.52', '0.1.51'), 1);
  assert.equal(compareVersions('0.2.0', '0.1.99'), 1);
  assert.equal(compareVersions('0.1.51', '0.1.51'), 0);
  assert.equal(compareVersions('0.2.0-beta.1', '0.2.0'), -1);
  assert.equal(compareVersions('0.2.0-beta.2', '0.2.0-beta.10'), -1);
  assert.equal(compareVersions('v0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('nonsense', '0.1.0'), null);
});

test('wiring: the installer is built with a GitHub feed and latest.yml, main.js never auto-installs, and the page has the bar and the settings', () => {
  const root = path.join(__dirname, '..');
  const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
  const pkg = JSON.parse(rd('package.json'));
  assert.deepEqual(pkg.build.publish, [{ provider: 'github', owner: 'danielalex011', repo: 'Junction-Launcher' }]);
  assert.match(pkg.scripts['dist:win'], /--publish never/, 'building never uploads anything');
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater ships inside the app');
  const main = rd('src', 'main', 'main.js');
  assert.match(main, /require\('electron-updater'\)/);
  assert.ok(!/autoInstallOnAppQuit\s*=\s*true/.test(main));
  for (const c of ['updates:state', 'updates:check', 'updates:install']) assert.ok(main.includes(`handle('${c}'`), c);
  assert.match(rd('src', 'main', 'preload.js'), /'updates:state'/);
  assert.match(rd('src', 'renderer', 'index.html'), /<script src="selfupdate\.js">/);
  const ui = rd('src', 'renderer', 'selfupdate.js');
  for (const w of ['Install and restart', 'Release notes', 'New versions are on the Releases page']) assert.ok(ui.includes(w) || rd('src', 'renderer', 'settings.js').includes(w), w);
  assert.match(ui, /Check for updates automatically/);
  assert.match(ui, /Check now/);
  assert.match(rd('src', 'renderer', 'settings.js'), /selfUpdateSection\(s, info, auto\)/, 'in the About tab');
  assert.match(rd('src', 'renderer', 'settings.js'), /GitHub \(to look for a new version of Junction/, 'the Privacy text says so');
  assert.match(rd('src', 'core', 'settings.js'), /checkForUpdates: true/);
  assert.match(rd('README.md'), /latest\.yml/);
  assert.match(rd('README.md'), /Junction-\d+\.\d+\.\d+-win-x64\.exe\.blockmap|\.exe\.blockmap/);
});
