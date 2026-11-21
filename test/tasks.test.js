'use strict';
// The activity manager: speed / ETA, Cancel (and its cleanup), Pause / Resume, the queue and the saved history.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createContext } = require('../src/core/context');
const { TaskManager, SpeedMeter, computeEta } = require('../src/core/tasks');
const { CancelledError } = require('../src/core/taskcontext');
const { pool } = require('../src/core/util');
const AdmZip = require('adm-zip');
const { Instances } = require('../src/core/instances');
const { ContentManager } = require('../src/core/content/manager');
const { Modpacks } = require('../src/core/content/modpacks');
const { createSources } = require('../src/core/sources');
const { tmpDir, sha1 } = require('./helpers');

const delay = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

/** A fetch whose bodies arrive in small pieces and stop (error) when the request is aborted, like the real one. */
function slowFetch(bodies, { pieces = 5, pieceMs = 15 } = {}) {
  const hits = {};
  const fetchImpl = async (url, { signal } = {}) => {
    const body = bodies[url];
    if (!body) return new Response('missing', { status: 404 });
    hits[url] = (hits[url] || 0) + 1;
    const size = Math.ceil(body.length / pieces);
    let i = 0;
    const stream = new ReadableStream({
      async pull(ctrl) {
        if (i >= pieces) { ctrl.close(); return; }
        try { await delay(pieceMs, signal); } catch (e) { ctrl.error(e); return; }
        ctrl.enqueue(new Uint8Array(body.subarray(i * size, (i + 1) * size)));
        i++;
      },
    });
    return new Response(stream, { headers: { 'content-length': String(body.length) } });
  };
  return { fetchImpl, hits };
}

const bodyOf = (name, n = 4000) => Buffer.from(name.repeat(Math.ceil(n / name.length)).slice(0, n));
const urlOf = (n) => `https://cdn.modrinth.com/data/x/${n}.jar`;
const partFiles = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.part-'));
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await delay(5); }
  throw new Error('timed out waiting for the condition');
};

// ------------------------------------------------------------------ speed and ETA

test('speed is averaged over the last three seconds and decays when downloads stop', () => {
  const m = new SpeedMeter();
  for (let t = 0; t < 3000; t += 100) m.add(1_000_000, t); // 10 MB/s for 3 s
  assert.ok(Math.abs(m.speed(3000) - 10_000_000) < 500_000);
  // older samples fall out of the window, so the number shrinks on its own
  assert.ok(m.speed(4500) < 6_000_000);
  assert.equal(m.speed(9000), 0);
});

test('speed ignores a burst that is older than the window', () => {
  const m = new SpeedMeter();
  m.add(50_000_000, 0);
  m.add(1_000_000, 5000);
  assert.ok(m.speed(5100) <= 1_000_000 + 1); // the old 50 MB is gone; one second minimum span
});

test('ETA is remaining bytes over speed, and unknown without speed or without a total', () => {
  assert.equal(computeEta(10_000_000, 2_000_000), 5);
  assert.equal(computeEta(1, 1_000_000), 1);
  assert.equal(computeEta(10_000_000, 0), null);
  assert.equal(computeEta(0, 5), null);
});

test('a task reports bytes, files, speed and ETA while downloading', async () => {
  const bodies = { [urlOf('a')]: bodyOf('a', 5000), [urlOf('b')]: bodyOf('b', 5000) };
  const { fetchImpl } = slowFetch(bodies);
  const ctx = await createContext(tmpDir(), { fetchImpl });
  const dir = tmpDir();
  const seen = [];
  ctx.tasks.emitInterval = 5;
  ctx.tasks.on('update', (t) => seen.push(t));
  await ctx.tasks.run('Pack', async (t) => {
    t.update(0.1, 'Downloading mods');
    await pool(['a', 'b'], 2, (n) => ctx.http.download(urlOf(n), path.join(dir, `${n}.jar`), { sha1: sha1(bodies[urlOf(n)]) }));
  }, { kind: 'modpack', icon: 'pack' });
  const last = seen.at(-1);
  assert.equal(last.status, 'done');
  assert.equal(last.filesDone, 2);
  assert.equal(last.filesTotal, 2);
  assert.equal(last.bytesDone, 10000);
  assert.equal(last.bytesTotal, 10000);
  const mid = seen.find((t) => t.status === 'running' && t.bytesDone > 0 && t.bytesDone < t.bytesTotal);
  assert.ok(mid, 'saw progress part way');
  assert.ok(mid.step === 'Downloading mods' && mid.kind === 'modpack');
  assert.ok(mid.speed > 0);
  assert.ok(mid.activeFiles.length >= 1 && mid.activeFiles[0].name.endsWith('.jar'));
});

test('UI updates are throttled to about four per second', async () => {
  const tm = new TaskManager();
  const seen = [];
  tm.on('update', (t) => seen.push(t));
  await tm.run('Busy', async (t) => {
    const end = Date.now() + 600;
    while (Date.now() < end) { t.update(Math.random(), 'x'); await delay(2); }
  });
  assert.ok(seen.length <= 8, `got ${seen.length} updates in 0.6 s`);
  assert.equal(seen.at(-1).status, 'done'); // the final state is never swallowed
});

// ------------------------------------------------------------------ cancel

test('Cancel stops a download, leaves no .part file and rejects with CancelledError', async () => {
  const bodies = { [urlOf('big')]: bodyOf('big', 10000) };
  const { fetchImpl } = slowFetch(bodies, { pieces: 20, pieceMs: 20 });
  const ctx = await createContext(tmpDir(), { fetchImpl });
  const dir = tmpDir();
  let id;
  const job = ctx.tasks.run('Big', async (t) => {
    id = t.id;
    await ctx.http.download(urlOf('big'), path.join(dir, 'big.jar'), { sha1: sha1(bodies[urlOf('big')]) });
  });
  const failed = assert.rejects(job, (e) => e instanceof CancelledError && e.code === 'CANCELLED');
  await waitFor(() => partFiles(dir).length === 1); // really in flight
  assert.equal(ctx.tasks.cancel(id), true);
  await failed;
  assert.deepEqual(partFiles(dir), []);
  assert.equal(fs.existsSync(path.join(dir, 'big.jar')), false);
  assert.equal(ctx.tasks.list().length, 0);
  assert.equal(ctx.tasks.getHistory()[0].status, 'cancelled');
});

test('Cancel stops a pool: nothing new starts and the job ends as cancelled', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const bodies = Object.fromEntries(names.map((n) => [urlOf(n), bodyOf(n, 3000)]));
  const { fetchImpl, hits } = slowFetch(bodies, { pieces: 10, pieceMs: 20 });
  const ctx = await createContext(tmpDir(), { fetchImpl });
  const dir = tmpDir();
  let id;
  const job = ctx.tasks.run('Many', async (t) => {
    id = t.id;
    await pool(names, 2, (n) => ctx.http.download(urlOf(n), path.join(dir, `${n}.jar`)));
  });
  const failed = assert.rejects(job, CancelledError);
  await waitFor(() => Object.keys(hits).length >= 2);
  ctx.tasks.cancel(id);
  await failed;
  assert.ok(Object.keys(hits).length < names.length, 'the rest never started');
  assert.deepEqual(partFiles(dir), []);
});

test('Cancel runs the cleanup the job registered, e.g. removing a half-made instance', async () => {
  const { fetchImpl } = slowFetch({ [urlOf('a')]: bodyOf('a', 4000) }, { pieces: 20, pieceMs: 20 });
  const ctx = await createContext(tmpDir(), { fetchImpl });
  const instDir = path.join(tmpDir(), 'half-made');
  let id;
  const job = ctx.tasks.run('Pack', async (t) => {
    id = t.id;
    fs.mkdirSync(instDir);
    fs.writeFileSync(path.join(instDir, 'instance.json'), '{}');
    t.onCancel(() => fs.promises.rm(instDir, { recursive: true, force: true }));
    await ctx.http.download(urlOf('a'), path.join(instDir, 'mods', 'a.jar'));
  }, { kind: 'modpack', createsInstance: true });
  const failed = assert.rejects(job, CancelledError);
  await waitFor(() => fs.existsSync(path.join(instDir, 'mods')));
  ctx.tasks.cancel(id);
  await failed;
  assert.equal(fs.existsSync(instDir), false);
});

test('a finished task is not cancelled, and a progress report after Cancel throws', async () => {
  const tm = new TaskManager();
  let id;
  const job = tm.run('Steps', async (t) => {
    id = t.id;
    await delay(20);
    t.update(0.5, 'Halfway'); // cancelled by now
  });
  await delay(5);
  assert.equal(tm.cancel(id), true);
  assert.equal(tm.cancel(id), false); // already cancelling
  await assert.rejects(job, CancelledError);
  assert.equal(tm.cancel(id), false); // gone
});

// ------------------------------------------------------------------ pause / resume

test('Pause aborts files in progress and starts nothing new; Resume restarts them and skips finished files', async () => {
  const names = ['a', 'b', 'c', 'd'];
  const bodies = Object.fromEntries(names.map((n) => [urlOf(n), bodyOf(n, 3000)]));
  const { fetchImpl, hits } = slowFetch(bodies, { pieces: 10, pieceMs: 25 });
  const ctx = await createContext(tmpDir(), { fetchImpl });
  const dir = tmpDir();
  let id;
  const job = ctx.tasks.run('Pack', async (t) => {
    id = t.id;
    await pool(names, 1, (n) => ctx.http.download(urlOf(n), path.join(dir, `${n}.jar`), { sha1: sha1(bodies[urlOf(n)]) }));
  }, { kind: 'modpack' });
  await waitFor(() => fs.existsSync(path.join(dir, 'a.jar')) && hits[urlOf('b')] === 1); // a is done, b is downloading
  assert.equal(ctx.tasks.pause(id), true);
  assert.equal(ctx.tasks.list()[0].status, 'paused');
  await waitFor(() => partFiles(dir).length === 0); // the in-flight file was dropped
  const before = JSON.stringify(hits);
  await delay(150);
  assert.equal(JSON.stringify(hits), before, 'nothing starts while paused');
  assert.equal(ctx.tasks.list()[0].speed, 0);
  assert.equal(ctx.tasks.resume(id), true);
  await job;
  for (const n of names) assert.equal(fs.readFileSync(path.join(dir, `${n}.jar`)).equals(bodies[urlOf(n)]), true, `${n} is intact`);
  assert.equal(hits[urlOf('a')], 1, 'the verified file was not fetched again');
  assert.equal(hits[urlOf('b')], 2, 'the interrupted file started over');
  assert.equal(hits[urlOf('c')], 1);
  // bytes of the dropped attempt are taken back out, so the total is exact
  const done = ctx.tasks.getHistory()[0];
  assert.equal(done.status, 'done');
  assert.equal(done.bytesDone, 12000);
});

test('a task that is paused can still be cancelled', async () => {
  const { fetchImpl } = slowFetch({ [urlOf('a')]: bodyOf('a', 3000) }, { pieces: 20, pieceMs: 20 });
  const ctx = await createContext(tmpDir(), { fetchImpl });
  const dir = tmpDir();
  let id;
  const job = ctx.tasks.run('P', async (t) => { id = t.id; await ctx.http.download(urlOf('a'), path.join(dir, 'a.jar')); });
  const failed = assert.rejects(job, CancelledError);
  await waitFor(() => partFiles(dir).length === 1);
  ctx.tasks.pause(id);
  await waitFor(() => partFiles(dir).length === 0);
  ctx.tasks.cancel(id);
  await failed;
  assert.equal(fs.existsSync(path.join(dir, 'a.jar')), false);
});

// ------------------------------------------------------------------ queue

test('heavy installs run one at a time; the others wait and then start in order', async () => {
  const tm = new TaskManager();
  const order = [];
  const gates = [];
  const heavy = (name) => tm.run(name, async () => {
    order.push(`start ${name}`);
    await new Promise((r) => gates.push(r));
    order.push(`end ${name}`);
  }, { heavy: true, kind: 'modpack' });
  const a = heavy('A');
  const b = heavy('B');
  const c = heavy('C');
  await delay(10);
  assert.deepEqual(tm.list().map((t) => `${t.title}:${t.status}`), ['A:running', 'B:queued', 'C:queued']);
  const light = await tm.run('Light', async () => 'ok', { kind: 'mod' }); // a mod install never waits
  assert.equal(light, 'ok');
  gates.shift()();
  await a;
  await delay(10);
  assert.deepEqual(tm.list().map((t) => `${t.title}:${t.status}`), ['B:running', 'C:queued']);
  gates.shift()();
  await b;
  await delay(10);
  gates.shift()();
  await c;
  assert.deepEqual(order, ['start A', 'end A', 'start B', 'end B', 'start C', 'end C']);
});

test('a queued task can be cancelled before it ever starts', async () => {
  const tm = new TaskManager();
  let release;
  const a = tm.run('A', () => new Promise((r) => { release = r; }), { heavy: true });
  let ran = false;
  let idB;
  const b = tm.run('B', async () => { ran = true; }, { heavy: true });
  idB = tm.list().find((t) => t.title === 'B').id;
  await delay(5);
  tm.cancel(idB);
  await assert.rejects(b, CancelledError);
  release();
  await a;
  assert.equal(ran, false);
  assert.equal(tm.getHistory().find((h) => h.title === 'B').status, 'cancelled');
});

test('a failing heavy task still lets the next one start', async () => {
  const tm = new TaskManager();
  const a = tm.run('A', async () => { throw new Error('<html><body><h1>503 Service Unavailable</h1></body></html>'); }, { heavy: true });
  const b = tm.run('B', async () => 'fine', { heavy: true });
  await assert.rejects(a);
  assert.equal(await b, 'fine');
  const failed = tm.getHistory().find((h) => h.title === 'A');
  assert.equal(failed.status, 'error');
  assert.ok(!/[<>]/.test(failed.error), 'errors are plain text, never HTML');
});

// ------------------------------------------------------------------ history

test('history keeps the last 50, newest first, and survives a restart', async () => {
  const file = path.join(tmpDir(), 'activity.json');
  const tm = await new TaskManager({ historyFile: file }).load();
  for (let i = 1; i <= 55; i++) await tm.run(`Task ${i}`, async () => ({ failed: i === 55 ? [{}, {}] : [] }), { kind: 'modpack', instanceId: `inst-${i}` });
  await tm.flush();
  assert.equal(tm.getHistory().length, 50);
  assert.equal(tm.getHistory()[0].title, 'Task 55');
  assert.equal(tm.getHistory()[0].failedCount, 2);
  assert.equal(tm.getHistory().at(-1).title, 'Task 6');

  const again = await new TaskManager({ historyFile: file }).load();
  assert.equal(again.getHistory().length, 50);
  assert.equal(again.getHistory()[0].instanceId, 'inst-55');

  again.removeHistory(again.getHistory()[0].id);
  assert.equal(again.getHistory()[0].title, 'Task 54');
  again.clearHistory();
  await again.flush();
  assert.deepEqual((await new TaskManager({ historyFile: file }).load()).getHistory(), []);
});

test('quiet housekeeping tasks do not clutter the history, but their failures do', async () => {
  const tm = new TaskManager();
  await tm.run('Checking for updates', async () => 1); // kind "other"
  await assert.rejects(tm.run('Identifying files', async () => { throw new Error('nope'); }));
  assert.deepEqual(tm.getHistory().map((h) => h.title), ['Identifying files']);
});

// ------------------------------------------------------------------ a real modpack install

function mrpackWith(names, bodies) {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'Test Pack', dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
    files: names.map((n) => ({ path: `mods/${n}.jar`, hashes: { sha1: sha1(bodies[urlOf(n)]) }, downloads: [urlOf(n)], fileSize: bodies[urlOf(n)].length, env: { client: 'required', server: 'required' } })),
  })));
  const file = path.join(tmpDir(), 'test.mrpack');
  zip.writeZip(file);
  return file;
}

test('cancelling a modpack install removes the half-created instance and leaves no .part files', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const bodies = Object.fromEntries(names.map((n) => [urlOf(n), bodyOf(n, 6000)]));
  const { fetchImpl } = slowFetch(bodies, { pieces: 20, pieceMs: 15 });
  const ctx = await createContext(tmpDir(), { fetchImpl });
  const instances = new Instances(ctx);
  const sources = createSources(ctx);
  const modpacks = new Modpacks(ctx, instances, new ContentManager(ctx, instances, sources), sources);
  const file = mrpackWith(names, bodies);
  let id;
  const job = ctx.tasks.run('Installing Test Pack', (t) => { id = t.id; return modpacks.installFile(file, { report: t.update }); },
    { kind: 'modpack', heavy: true, createsInstance: true });
  const failed = assert.rejects(job, CancelledError);
  await waitFor(async () => (await instances.list()).length === 1 && ctx.tasks.list()[0]?.filesDone >= 1);
  const [inst] = await instances.list();
  assert.equal(ctx.tasks.list()[0].instanceId, inst.id, 'the task knows which instance it is making');
  ctx.tasks.cancel(id);
  await failed;
  assert.deepEqual(await instances.list(), []);
  assert.equal(fs.existsSync(instances.instDir(inst.id)), false);
  assert.equal(ctx.tasks.getHistory()[0].status, 'cancelled');
});

test('updating an existing instance with a pack never deletes it when cancelled', async () => {
  const names = ['a', 'b', 'c', 'd'];
  const bodies = Object.fromEntries(names.map((n) => [urlOf(n), bodyOf(n, 6000)]));
  const { fetchImpl } = slowFetch(bodies, { pieces: 20, pieceMs: 15 });
  const ctx = await createContext(tmpDir(), { fetchImpl });
  const instances = new Instances(ctx);
  const sources = createSources(ctx);
  const modpacks = new Modpacks(ctx, instances, new ContentManager(ctx, instances, sources), sources);
  const existing = await instances.create({ name: 'Mine', mcVersion: '1.20.1', loader: { type: 'fabric', version: '0.15.0' } });
  const file = mrpackWith(names, bodies);
  let id;
  const job = ctx.tasks.run('Updating Mine', (t) => { id = t.id; return modpacks.installFile(file, { instanceId: existing.id, report: t.update }); }, { kind: 'update', heavy: true });
  const failed = assert.rejects(job, CancelledError);
  await waitFor(() => ctx.tasks.list()[0]?.filesDone >= 1);
  ctx.tasks.cancel(id);
  await failed;
  assert.equal((await instances.list()).length, 1);
});
