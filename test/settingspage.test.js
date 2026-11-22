'use strict';
// Settings tabs: memory zones and the big-pack hint, Java detection (fake folders), auto-save, and the pieces behind the other tabs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const M = require('../src/renderer/memory');
const A = require('../src/renderer/autosave');
const { findJavas, testJava, majorOf, vendorOf } = require('../src/core/javafinder');
const { runtimeRows, removeRuntime, guessMajorForMc } = require('../src/core/minecraft/javainfo');
const { javaFor, bucketMajor } = require('../src/core/minecraft/java');
const { Instances } = require('../src/core/instances');
const { Settings } = require('../src/core/settings');
const { Http } = require('../src/core/http');
const { notificationFor } = require('../src/core/notify');
const { buildDebugInfo, scrubPath } = require('../src/core/debuginfo');
const { clearCache, cacheInfo } = require('../src/core/storage');
const { makeCtx, tmpDir } = require('./helpers');

const GB = 1024;

// ------------------------------------------------------------------ memory
test('memory zones: under 2 GB is too low, within 4 GB of the total leaves too little for Windows', () => {
  const total = 32 * GB;
  assert.equal(M.zoneOf(1 * GB, total), 'low');
  assert.equal(M.zoneOf(2 * GB - 1, total), 'low');
  assert.equal(M.zoneOf(2 * GB, total), 'good');
  assert.equal(M.zoneOf(8 * GB, total), 'good');
  assert.equal(M.zoneOf(28 * GB, total), 'good', 'exactly 4 GB left is still fine');
  assert.equal(M.zoneOf(28 * GB + 512, total), 'high');
  assert.equal(M.zoneOf(32 * GB, total), 'high');
  const z = M.zones(total);
  assert.deepEqual([z.lowEnd, z.highStart, z.max], [2 * GB, 28 * GB, 32 * GB]);
  assert.equal(M.zoneOf(3 * GB, 4 * GB), 'high', 'on a 4 GB PC nothing above 2 GB leaves enough');
  assert.equal(M.zoneOf(1 * GB, 4 * GB), 'low', 'too low wins over too high');
});

test('memory zones: messages and the colours of the slider track', () => {
  assert.match(M.zoneMessage(1 * GB, 16 * GB).text, /too low/i);
  assert.match(M.zoneMessage(15 * GB, 16 * GB).text, /too little for Windows/i);
  assert.equal(M.zoneMessage(6 * GB, 16 * GB).text, 'Good.');
  const s = M.trackStops(32 * GB);
  assert.ok(s.low > 0 && s.low < s.high && s.high < 100, JSON.stringify(s));
  assert.equal(M.maxMB(32 * GB + 100), 32 * GB, 'the slider ends at the RAM, in 0.5 GB steps');
});

test('memory presets and the GB field check', () => {
  assert.equal(M.pcText(31.2 * GB), '32 GB', 'Windows reports a bit less than the RAM on the box');
  assert.equal(M.pcText(32 * GB), '32 GB');
  assert.equal(M.pcText(15.8 * GB), '16 GB');
  assert.equal(M.pcText(8 * GB), '8 GB');
  assert.deepEqual(M.PRESETS.map((p) => [p.label, p.mb / GB]), [['Vanilla', 3], ['Modded', 6], ['Big modpack', 8]]);
  assert.deepEqual(M.checkGB('6.5', { totalMB: 32 * GB }), { ok: true, mb: 6656 });
  assert.deepEqual(M.checkGB('6,5', { totalMB: 32 * GB }), { ok: true, mb: 6656 }, 'a comma is fine');
  assert.equal(M.checkGB('', { totalMB: 32 * GB }).ok, false);
  assert.equal(M.checkGB('lots', { totalMB: 32 * GB }).ok, false);
  assert.match(M.checkGB('0.2', { totalMB: 32 * GB }).error, /At least 0.5 GB/);
  assert.match(M.checkGB('40', { totalMB: 32 * GB }).error, /only has 32 GB/);
  assert.equal(M.checkGB('0.25', { totalMB: 32 * GB, minMB: 256 }).ok, true, 'the minimum field allows smaller values');
});

test('big pack hint: 300+ mods and under 6 GB', () => {
  assert.equal(M.bigPackHint({ name: 'Prominence II', mods: 460, memoryMB: 4 * GB }), 'Prominence II has 460 mods; 6–8 GB is recommended');
  assert.equal(M.bigPackHint({ name: 'X', mods: 300, memoryMB: 6143 }) !== null, true, '300 mods counts');
  assert.equal(M.bigPackHint({ name: 'X', mods: 299, memoryMB: 2 * GB }), null, 'under 300 mods: no hint');
  assert.equal(M.bigPackHint({ name: 'X', mods: 460, memoryMB: 6 * GB }), null, 'already 6 GB: no hint');
  assert.equal(M.bigPackHint({ name: 'X', mods: 460, memoryMB: 8 * GB }), null);
  assert.equal(M.bigPackHint({ name: 'X', mods: null, memoryMB: 2 * GB }), null, 'mod count not known yet');
});

test('instances count their switched-on mods for the hint', async () => {
  const ctx = await makeCtx([]);
  const instances = new Instances(ctx);
  const a = await instances.create({ name: 'Big', mcVersion: '1.20.1', loader: { type: 'fabric', version: '0.15' } });
  const dir = path.join(instances.gameDir(a.id), 'mods');
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `m${i}.jar`), 'x');
  fs.writeFileSync(path.join(dir, 'off.jar.disabled'), 'x');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');
  assert.equal((await instances.modCounts())[a.id], 5);
});

// ------------------------------------------------------------------ Java detection
function fakeJdk(dir, { release, javaw = false } = {}) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'java.exe'), '');
  if (javaw) fs.writeFileSync(path.join(dir, 'bin', 'javaw.exe'), '');
  if (release) fs.writeFileSync(path.join(dir, 'release'), release);
}

test('finds Java in PATH, JAVA_HOME, Program Files and user folders without running anything', async () => {
  const root = tmpDir('junction-java-');
  const pf = path.join(root, 'Program Files');
  const home = path.join(root, 'home');
  const adoptium = path.join(pf, 'Eclipse Adoptium', 'jdk-17.0.9.9-hotspot');
  fakeJdk(adoptium, { javaw: true, release: 'JAVA_VERSION="17.0.9"\nIMPLEMENTOR="Eclipse Adoptium"\n' });
  fakeJdk(path.join(pf, 'Microsoft', 'jdk-21.0.1.12-hotspot'), { release: 'JAVA_VERSION="21.0.1"\nIMPLEMENTOR="Microsoft"\n' });
  fakeJdk(path.join(pf, 'Zulu', 'zulu8.74-win_x64'), { release: 'JAVA_VERSION="1.8.0_392"\nIMPLEMENTOR="Azul Systems, Inc."\n' });
  fakeJdk(path.join(pf, 'BellSoft', 'LibericaJDK-21'), { release: 'JAVA_VERSION="21.0.2"\nIMPLEMENTOR="BellSoft"\n' });
  fakeJdk(path.join(pf, 'Amazon Corretto', 'jdk11.0.21_9'), { release: 'JAVA_VERSION="11.0.21"\nIMPLEMENTOR="Amazon.com Inc."\n' });
  fakeJdk(path.join(pf, 'Java', 'jdk-25'), { release: 'JAVA_VERSION="25"\nIMPLEMENTOR="Oracle Corporation"\n' });
  fakeJdk(path.join(home, '.jdks', 'temurin-21.0.5'), { release: 'JAVA_VERSION="21.0.5"\nIMPLEMENTOR="Eclipse Adoptium"\n' });
  fakeJdk(path.join(home, '.jabba', 'jdk', 'adopt@1.8.0-292')); // no release file: the folder name has the version
  fakeJdk(path.join(home, 'Java', 'graalvm-jdk-21.0.1+12.1'), { release: 'JAVA_VERSION="21.0.1"\nIMPLEMENTOR="Oracle Corporation"\nGRAALVM_VERSION="23.1.1"\n' });
  fakeJdk(path.join(home, 'Java', 'graalvm-community-openjdk-17.0.9+9.1', 'graalvm-community-openjdk-17.0.9+9.1'), { release: 'JAVA_VERSION="17.0.9"\nIMPLEMENTOR="GraalVM Community"\n' }); // fresh unzip: folder inside a folder
  const jhome = path.join(root, 'elsewhere', 'jdk-22');
  fakeJdk(jhome, { release: 'JAVA_VERSION="22.0.1"\nIMPLEMENTOR="Eclipse Adoptium"\n' });
  fs.mkdirSync(path.join(pf, 'Java', 'not-java', 'bin'), { recursive: true }); // a folder without a java file

  const list = await findJavas({
    platform: 'win32', home, programRoots: [pf],
    env: { PATH: `${path.join(adoptium, 'bin')};${path.join(root, 'nothing')}`, JAVA_HOME: jhome },
  });
  const by = (re) => list.find((j) => re.test(j.home));

  assert.equal(list.length, 12 - 1 + 0 - 0, 'every install once: the PATH entry is the same folder as the Program Files one');
  assert.equal(by(/jdk-17\.0\.9\.9/).vendor, 'Eclipse Adoptium');
  assert.equal(by(/jdk-17\.0\.9\.9/).source, 'PATH', 'the first place that found it names it');
  assert.equal(by(/jdk-17\.0\.9\.9/).launchPath.endsWith('javaw.exe'), true);
  assert.equal(by(/jdk-17\.0\.9\.9/).path.endsWith('java.exe'), true);
  assert.equal(by(/jdk-22/).source, 'JAVA_HOME');
  assert.equal(by(/jdk-21\.0\.1\.12/).vendor, 'Microsoft');
  assert.equal(by(/zulu8/).vendor, 'Azul Zulu');
  assert.equal(by(/zulu8/).major, 8, '1.8.0_392 is Java 8');
  assert.equal(by(/LibericaJDK/).vendor, 'BellSoft Liberica');
  assert.equal(by(/jdk11\.0\.21/).vendor, 'Amazon Corretto');
  assert.equal(by(/jdk-25/).major, 25);
  assert.equal(by(/temurin-21/).source, 'Your user folder');
  const jabba = by(/adopt@1\.8/);
  assert.equal(jabba.major, 8);
  assert.equal(jabba.versionFrom, 'folder');
  const graal = by(/graalvm-jdk-21/);
  assert.equal(graal.vendor, 'GraalVM', 'recognised from GRAALVM_VERSION even though the release file says Oracle');
  assert.equal(by(/graalvm-community-openjdk-17/).vendor, 'GraalVM', 'and from the folder name, one level down');
  assert.equal(list.some((j) => /not-java/.test(j.home)), false);
  assert.deepEqual(list.map((j) => j.major), [...list.map((j) => j.major)].sort((a, b) => (b || 0) - (a || 0)), 'newest Java first');
});

test('Java detection: nothing found is an empty list, and helpers read versions and vendors', async () => {
  const root = tmpDir('junction-java-');
  assert.deepEqual(await findJavas({ platform: 'win32', home: root, programRoots: [path.join(root, 'none')], env: {} }), []);
  assert.equal(majorOf('1.8.0_292'), 8);
  assert.equal(majorOf('17.0.9'), 17);
  assert.equal(majorOf('25-ea'), 25);
  assert.equal(majorOf('nope'), null);
  assert.equal(vendorOf({ implementor: 'Oracle Corporation', graalvm: '23.1' }), 'GraalVM');
  assert.equal(vendorOf({ implementor: 'Oracle Corporation' }), 'Oracle');
});

test('Test button: runs only java -version, with a time limit, and only on files called java/javaw', async () => {
  const root = tmpDir('junction-java-');
  const home = path.join(root, 'jdk-21');
  fakeJdk(home, { javaw: true });
  const calls = [];
  const ok = (_f, _a, _o, cb) => cb(null, '', 'openjdk version "21.0.5" 2024-10-15\nOpenJDK Runtime Environment Temurin-21.0.5+11 (build 21.0.5+11)\n');
  const r = await testJava(path.join(home, 'bin', 'javaw.exe'), { execFileImpl: (f, a, o, cb) => { calls.push({ f, a, o }); ok(f, a, o, cb); } });
  assert.equal(r.ok, true);
  assert.equal(r.version, '21.0.5');
  assert.equal(r.major, 21);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].a, ['-version'], 'nothing but -version');
  assert.ok(calls[0].f.endsWith('java.exe'), 'javaw prints nothing, so its java.exe twin is asked');
  assert.ok(calls[0].o.timeout > 0, 'there is a timeout');

  const slow = await testJava(path.join(home, 'bin', 'java.exe'), { timeoutMs: 1000, execFileImpl: (f, a, o, cb) => cb(Object.assign(new Error('timed out'), { killed: true }), '', '') });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /did not answer within 1 seconds/);

  const bad = await testJava(path.join(home, 'bin', 'java.exe'), { execFileImpl: (f, a, o, cb) => cb(null, 'hello', 'not java') });
  assert.equal(bad.ok, false);

  fs.writeFileSync(path.join(root, 'evil.exe'), '');
  let ran = false;
  const refused = await testJava(path.join(root, 'evil.exe'), { execFileImpl: () => { ran = true; } });
  assert.equal(refused.ok, false);
  assert.equal(ran, false, 'a file with another name is never started');
  assert.equal((await testJava(path.join(root, 'gone', 'java.exe'), { execFileImpl: () => { ran = true; } })).ok, false);
  assert.equal(ran, false);
});

// ------------------------------------------------------------------ Junction's own Java
async function fakeRuntime(ctx, component, version = '21.0.7') {
  const dir = path.join(ctx.paths.runtimes, component);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'javaw.exe'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(dir, '.junction-runtime.json'), JSON.stringify({ component, manifestSha1: 'abc', version }));
}

test('Junction\'s Java rows: status, version, size and which instances use each', async () => {
  const ctx = await makeCtx([]);
  const instances = new Instances(ctx);
  await instances.create({ name: 'Old', mcVersion: '1.12.2' });
  await instances.create({ name: 'Middle', mcVersion: '1.20.1' });
  await instances.create({ name: 'Newer', mcVersion: '1.21.1' });
  await instances.create({ name: 'Newest', mcVersion: '26.1.2' });
  await instances.create({ name: 'Own Java', mcVersion: '1.21.1' }).then((i) => instances.update(i.id, { javaPath: 'C:/x/java.exe' }));
  await fakeRuntime(ctx, 'java-runtime-delta', '21.0.7');
  const rows = await runtimeRows(ctx, instances);
  assert.deepEqual(rows.map((r) => r.major), [8, 17, 21, 25]);
  const r21 = rows.find((r) => r.major === 21);
  assert.equal(r21.installed, true);
  assert.equal(r21.version, '21.0.7');
  assert.ok(r21.sizeBytes >= 1000);
  assert.deepEqual(r21.usedBy.map((u) => u.name), ['Newer'], 'an instance with its own Java path does not count');
  assert.deepEqual(rows.find((r) => r.major === 8).usedBy.map((u) => u.name), ['Old']);
  assert.deepEqual(rows.find((r) => r.major === 17).usedBy.map((u) => u.name), ['Middle']);
  assert.deepEqual(rows.find((r) => r.major === 25).usedBy.map((u) => u.name), ['Newest']);
  assert.equal(rows.find((r) => r.major === 17).installed, false);
  assert.equal(guessMajorForMc('1.20.4'), 17);
  assert.equal(guessMajorForMc('1.20.5'), 21);
});

test('removing a runtime: only when nothing uses it', async () => {
  const ctx = await makeCtx([]);
  const instances = new Instances(ctx);
  await instances.create({ name: 'Newer', mcVersion: '1.21.1' });
  await fakeRuntime(ctx, 'java-runtime-delta');
  await fakeRuntime(ctx, 'java-runtime-epsilon', '25.0.1');
  await assert.rejects(() => removeRuntime(ctx, instances, 21), /used by Newer/);
  assert.ok(fs.existsSync(path.join(ctx.paths.runtimes, 'java-runtime-delta')));
  await assert.rejects(() => removeRuntime(ctx, instances, 25, { running: ['x'] }), /running game/);
  await removeRuntime(ctx, instances, 25);
  assert.equal(fs.existsSync(path.join(ctx.paths.runtimes, 'java-runtime-epsilon')), false);
  await assert.rejects(() => removeRuntime(ctx, instances, 99), /8, 17, 21 and 25/);
});

test('the Java chosen per version is used, an instance\'s own Java wins, Automatic falls through', async () => {
  const ctx = await makeCtx([]);
  const root = tmpDir('junction-java-');
  const mine = path.join(root, 'javaw.exe');
  const own = path.join(root, 'own.exe');
  fs.writeFileSync(mine, '');
  fs.writeFileSync(own, '');
  await ctx.settings.update({ javaByMajor: { 21: mine, 17: path.join(root, 'gone.exe') } });
  const v21 = { javaVersion: { component: 'java-runtime-delta', majorVersion: 21 } };
  assert.equal(await javaFor(ctx, v21, {}), mine);
  assert.equal(await javaFor(ctx, v21, { javaPath: own }), own);
  await assert.rejects(() => javaFor(ctx, { javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 } }, {}), /Java you chose for Java 17/);
  assert.equal(bucketMajor(16), 17);
  assert.equal(bucketMajor(8), 8);
  assert.equal(bucketMajor(25), 25);
});

// ------------------------------------------------------------------ settings and auto-save
test('settings: numbers stay in range, the old checkbox becomes a three-way choice, junk Java choices are dropped', async () => {
  const ctx = await makeCtx([]);
  const out = await ctx.settings.update({ memoryMax: 8192, memoryMin: 99999, concurrency: 500, speedLimitMBps: -4, backupsKept: 0, startPage: 'nope', onLaunch: 'explode', javaByMajor: { 17: ' C:/j/javaw.exe ', 99: 'x', 21: '' }, closeOnLaunch: true });
  assert.equal(out.memoryMax, 8192);
  assert.equal(out.memoryMin, 8192, 'the minimum can never be above the maximum');
  assert.equal(out.concurrency, 64);
  assert.equal(out.speedLimitMBps, 0);
  assert.equal(out.backupsKept, 1);
  assert.equal(out.startPage, 'home');
  assert.equal(out.onLaunch, 'keep');
  assert.deepEqual(out.javaByMajor, { 17: 'C:/j/javaw.exe' });
  assert.ok(!('closeOnLaunch' in out));
  const ok = await ctx.settings.update({ startPage: 'library', onLaunch: 'minimize', notifyOnFinish: false, speedLimitMBps: 2.5, backupsKept: 7 });
  assert.deepEqual([ok.startPage, ok.onLaunch, ok.notifyOnFinish, ok.speedLimitMBps, ok.backupsKept], ['library', 'minimize', false, 2.5, 7]);
});

test('settings: an old closeOnLaunch checkbox is carried over, and changes survive a restart', async () => {
  const ctx = await makeCtx([]);
  fs.writeFileSync(ctx.paths.settingsFile, JSON.stringify({ settings: { closeOnLaunch: true, memoryMax: 6144 }, secrets: {} }));
  const s = await new Settings(ctx.paths.settingsFile, ctx.crypto).load();
  assert.equal(s.get('onLaunch'), 'hide');
  assert.equal(s.get('closeOnLaunch'), undefined);
  fs.writeFileSync(ctx.paths.settingsFile, JSON.stringify({ settings: { closeOnLaunch: false }, secrets: {} }));
  assert.equal((await new Settings(ctx.paths.settingsFile, ctx.crypto).load()).get('onLaunch'), 'keep');
  await s.update({ startPage: 'library' });
  assert.equal((await new Settings(ctx.paths.settingsFile, ctx.crypto).load()).get('startPage'), 'library');
});

function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (fn) => { const id = next++; pending.set(id, fn); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    fire: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach((f) => f()); },
    count: () => pending.size,
  };
}

test('auto-save: quick changes become one save, later values win, and the note says saving then saved', async () => {
  const timers = fakeTimers();
  const saves = [];
  const states = [];
  const auto = A.createAutosaver({ save: async (p) => { saves.push(p); }, onState: (s) => states.push(s), timers });
  auto.queue({ memoryMax: 4096 });
  auto.queue({ memoryMax: 6144, jvmArgs: '-Xfoo' });
  assert.equal(timers.count(), 1, 'one timer, restarted by each change');
  assert.equal(saves.length, 0, 'nothing is sent while changes keep coming');
  assert.equal(auto.pending(), true);
  timers.fire();
  await auto.flush();
  assert.deepEqual(saves, [{ memoryMax: 6144, jvmArgs: '-Xfoo' }]);
  assert.deepEqual(states, ['saving', 'saved']);
  assert.equal(auto.pending(), false);
});

test('auto-save: flush saves right away, a failure is reported, and a change during a save is not lost', async () => {
  const timers = fakeTimers();
  const saves = [];
  const states = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let fail = false;
  const auto = A.createAutosaver({
    save: async (p) => { saves.push(p); if (saves.length === 1) await gate; if (fail) throw new Error('disk full'); },
    onState: (s, m) => states.push(m ? `${s}:${m}` : s), timers,
  });
  auto.queue({ a: 1 });
  const first = auto.flush(); // does not wait for the timer
  assert.equal(timers.count(), 0);
  auto.queue({ b: 2 }); // arrives while the first save is still running
  timers.fire();
  release();
  await first;
  await auto.flush();
  assert.deepEqual(saves, [{ a: 1 }, { b: 2 }]);
  assert.equal(states.at(-1), 'saved');
  fail = true;
  auto.queue({ c: 3 });
  await auto.flush();
  assert.equal(states.at(-1), 'error:disk full');
  assert.equal(await auto.flush(), undefined, 'flush with nothing waiting is fine');
});

test('number fields are checked as you type', () => {
  const rule = { min: 1, max: 64, integer: true };
  assert.deepEqual(A.checkNumber('16', rule), { ok: true, value: 16 });
  assert.match(A.checkNumber('0', rule).error, /At least 1/);
  assert.match(A.checkNumber('100', rule).error, /At most 64/);
  assert.match(A.checkNumber('2.5', rule).error, /whole number/);
  assert.match(A.checkNumber('abc', rule).error, /number/);
  assert.equal(A.checkNumber('', rule).ok, false, 'required');
  assert.deepEqual(A.checkNumber('', { ...rule, optional: true }), { ok: true, value: null });
  assert.deepEqual(A.checkNumber('1,5', { min: 0.25 }), { ok: true, value: 1.5 });
  assert.match(A.checkNumber('0.1', { min: 0.25, unit: 'MB/s' }).error, /0.25 MB\/s/);
});

// ------------------------------------------------------------------ downloads, notifications, storage, about
test('speed limit: downloads share one clock, 0 means no limit', () => {
  let limit = 1; // MB/s
  const http = new Http({ getSpeedLimit: () => limit });
  const mb = 1024 * 1024;
  assert.equal(http.throttleDelay(mb / 8, 0), 0, 'a small first piece fits in the burst');
  assert.equal(http.throttleDelay(mb, 0), 875, 'a second piece waits for the first one and its own time (less the burst)');
  assert.equal(http.throttleDelay(mb, 0), 1875, 'every download queues behind the same clock');
  limit = 0;
  assert.equal(http.throttleDelay(10 * mb, 5000), 0);
  assert.equal(http.nextSlot, 0, 'the clock resets when the limit is removed');
});

test('notification: only for finished downloads and installs, when on, and not while you are looking at Junction', () => {
  const on = { get: (k) => (k === 'notifyOnFinish' ? true : undefined) };
  const off = { get: () => false };
  const done = { status: 'done', kind: 'modpack', title: 'Installing Prominence II' };
  assert.deepEqual(notificationFor(done, on, false), { title: 'Junction', body: 'Finished: Installing Prominence II' });
  assert.equal(notificationFor(done, off, false), null, 'turned off');
  assert.equal(notificationFor(done, on, true), null, 'the window is in front');
  assert.equal(notificationFor({ ...done, status: 'error' }, on, false), null);
  assert.equal(notificationFor({ ...done, status: 'running' }, on, false), null);
  assert.equal(notificationFor({ ...done, kind: 'prepare' }, on, false), null, 'starting the game is not an install');
  assert.equal(notificationFor({ ...done, kind: 'other' }, on, false), null);
  assert.ok(notificationFor({ ...done, kind: 'java' }, on, false));
});

test('cache: size and clearing', async () => {
  const ctx = await makeCtx([]);
  fs.writeFileSync(path.join(ctx.paths.cache, 'a.json'), 'x'.repeat(500));
  fs.mkdirSync(path.join(ctx.paths.cache, 'sub'));
  fs.writeFileSync(path.join(ctx.paths.cache, 'sub', 'b.bin'), 'x'.repeat(300));
  assert.equal((await cacheInfo(ctx)).bytes, 800);
  assert.equal((await clearCache(ctx)).freed, 800);
  assert.equal((await cacheInfo(ctx)).bytes, 0);
  assert.ok(fs.existsSync(ctx.paths.cache), 'the folder itself stays');
});

test('update backups: the number kept comes from the settings', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'content', 'manager.js'), 'utf8');
  assert.match(src, /settings\.get\('backupsKept'\)/);
});

test('debug info has versions and Java installs but never keys, tokens or the user name', async () => {
  const ctx = await makeCtx([], { cfKey: 'CF-SECRET-KEY-123' });
  await ctx.settings.update({ msClientId: '00000000-1111-2222-3333-444444444444' });
  const home = path.join(tmpDir('junction-home-'), 'danie');
  const text = buildDebugInfo({
    version: '0.1.34', settings: ctx.settings.publicView(), electron: '45.0.0', node: '24.0.0', home, instanceCount: 3,
    runtimes: [{ major: 21, installed: true, version: '21.0.7' }, { major: 8, installed: false }],
    javas: [{ version: '21.0.5', vendor: 'GraalVM', path: path.join(home, 'Java', 'graal', 'bin', 'java.exe'), source: 'Your user folder' }],
  });
  assert.match(text, /Junction 0\.1\.34/);
  assert.match(text, /Java 21: 21\.0\.7/);
  assert.match(text, /Java 8: not downloaded yet/);
  assert.match(text, /GraalVM, %USERPROFILE%[\\/]Java/);
  assert.ok(!text.includes('CF-SECRET-KEY-123'), 'the CurseForge key');
  assert.ok(!text.includes('00000000-1111'), 'the sign-in app id');
  assert.ok(!text.includes('danie'), 'the Windows user name');
  assert.ok(!/token|password|secret/i.test(text));
  assert.equal(scrubPath(path.join(home, 'x'), home), `%USERPROFILE%${path.sep}x`);
});

// ------------------------------------------------------------------ the page
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', f), 'utf8');

test('every settings tab is in the quick search, and the page has no Save button', () => {
  const settings = read('settings.js');
  const ids = [...settings.match(/const SETTINGS_TABS = \[([\s\S]*?)\];/)[1].matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['general', 'appearance', 'memory', 'java', 'storage', 'about']);
  const qs = read('quicksearch.js');
  for (const id of ids) assert.ok(qs.includes(`go('settings', { tab: '${id}' })`), `quick search has no entry for the ${id} tab`);
  assert.ok(!/'Save'\)/.test(settings), 'no Save button on the Settings page');
  assert.ok(settings.includes("createAutosaver"), 'the page saves through the auto-saver');
  assert.ok(!/closeOnLaunch/.test(settings + read('app.js')), 'the old checkbox is gone from the page');
});

test('the page offers the Java and storage handlers it calls', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const used = new Set();
  for (const f of ['settings.js', 'instance.js', 'memoryui.js']) for (const m of read(f).matchAll(/call\('([a-z]+:[A-Za-z]+)'/g)) used.add(m[1]);
  for (const ch of used) assert.ok(main.includes(`handle('${ch}'`), `main.js has no handler for ${ch}`);
});
