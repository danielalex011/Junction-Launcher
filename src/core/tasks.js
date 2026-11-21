'use strict';
// Background tasks: progress, speed / ETA, Cancel, Pause / Resume, a queue for heavy installs and a
// saved history. The UI subscribes to 'update' (one task) and 'history' (the finished list).
//
// Code running inside ctx.tasks.run() is found through AsyncLocalStorage (taskcontext.js), so
// http.download() and pool() report bytes / files and obey Cancel and Pause on their own.
const { EventEmitter } = require('events');
const { als, CancelledError, abortable } = require('./taskcontext');
const { readJson, writeJson } = require('./util');
const { HttpError, describeError } = require('./http');

let seq = 0;
const FINAL = new Set(['done', 'error', 'cancelled']);
const SPEED_WINDOW_MS = 3000;
const EMIT_INTERVAL_MS = 250; // about 4 UI updates per second

/** Bytes per second, smoothed over the last few seconds. */
class SpeedMeter {
  constructor(windowMs = SPEED_WINDOW_MS) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  add(bytes, now = Date.now()) {
    if (bytes > 0) this.samples.push({ t: now, b: bytes });
    this.prune(now);
  }

  prune(now) {
    const cut = now - this.windowMs;
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift();
  }

  speed(now = Date.now()) {
    this.prune(now);
    if (!this.samples.length) return 0;
    const total = this.samples.reduce((n, s) => n + s.b, 0);
    const span = Math.max(1000, Math.min(this.windowMs, now - this.samples[0].t));
    return total / (span / 1000);
  }
}

/** Seconds left, or null when it can't be known yet. */
function computeEta(remainingBytes, bytesPerSecond) {
  if (!(remainingBytes > 0) || !(bytesPerSecond > 0)) return null;
  return Math.ceil(remainingBytes / bytesPerSecond);
}

/** Seconds left from how fast whole files finish; needs a few done files to mean anything. */
function computeFilesEta(remainingFiles, filesDone, elapsedMs) {
  if (!(remainingFiles > 0) || filesDone < 3 || !(elapsedMs > 0)) return null;
  return Math.ceil(remainingFiles / (filesDone / (elapsedMs / 1000)));
}

/** One plain sentence for the UI: never HTML, never a URL. */
function readable(err) {
  const msg = String(err?.message || err || 'Something went wrong');
  if (err instanceof HttpError || err?.code || /fetch failed|timed? ?out|stalled|mismatch/i.test(msg)) return describeError(err);
  return msg.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Something went wrong';
}

class TaskManager extends EventEmitter {
  /**
   * @param {{ historyFile?: string, historyLimit?: number, maxHeavy?: number, emitInterval?: number }} opts
   */
  constructor({ historyFile = null, historyLimit = 50, maxHeavy = 1, emitInterval = EMIT_INTERVAL_MS } = {}) {
    super();
    this.tasks = new Map(); // live tasks (queued, running, paused)
    this.ctls = new Map(); // id -> private state
    this.historyFile = historyFile;
    this.historyLimit = historyLimit;
    this.maxHeavy = maxHeavy;
    this.emitInterval = emitInterval;
    this.history = [];
    this.writing = Promise.resolve();
    this.ticker = null;
  }

  async load() {
    if (this.historyFile) {
      const saved = await readJson(this.historyFile, []);
      this.history = Array.isArray(saved) ? saved.slice(0, this.historyLimit) : [];
    }
    return this;
  }

  // ---- creating tasks --------------------------------------------------------------------

  /**
   * @param {string} title
   * @param {{ kind?: string, icon?: string, instanceId?: string, heavy?: boolean, createsInstance?: boolean }} opts
   *   kind: modpack | mod | update | newinstance | import | repair | prepare | other
   *   heavy: only `maxHeavy` of these run at once; the rest wait in the queue
   */
  create(title, { kind = 'other', icon = null, instanceId, heavy = false, createsInstance = false } = {}) {
    const id = `t${++seq}`;
    const task = {
      id, title, kind, icon, instanceId, heavy, createsInstance, status: 'running', cancelling: false,
      progress: null, step: '', error: null, started: Date.now(), finished: null,
      bytesDone: 0, bytesTotal: 0, plannedBytes: 0, sizeUnknown: false, filesDone: 0, filesTotal: 0, speed: 0, eta: null,
      activeFiles: [], failedFiles: [], failedCount: 0,
    };
    const ctl = {
      ac: new AbortController(), pauseAc: new AbortController(), waiters: [], meter: new SpeedMeter(),
      files: new Map(), cleanups: [], lastEmit: 0, timer: null, start: null, rejectStart: null, started: null,
    };
    const mustWait = heavy && this.activeHeavy() >= this.maxHeavy; // counted before this task joins the list
    this.tasks.set(id, task);
    this.ctls.set(id, ctl);

    if (mustWait) {
      task.status = 'queued';
      ctl.started = new Promise((resolve, reject) => { ctl.start = resolve; ctl.rejectStart = reject; });
      ctl.started.catch(() => {}); // a cancelled queue entry is reported through run()
    } else {
      ctl.started = Promise.resolve();
    }

    const emit = (force) => this.emitTask(task, ctl, force);
    const api = {
      id,
      signal: ctl.ac.signal,
      started: ctl.started,

      /** Progress 0..1 and what is happening now. Throws once the task has been cancelled. */
      update: (progress, step) => {
        if (ctl.ac.signal.aborted) throw new CancelledError();
        if (progress !== undefined && progress !== null) task.progress = Math.max(0, Math.min(1, progress));
        if (step !== undefined) task.step = step;
        emit(false);
      },
      done: (step, result) => this.finish(task, ctl, 'done', { step, result }),
      fail: (err) => this.finish(task, ctl, 'error', { error: readable(err) }),
      cancel: () => this.cancel(id),
      pause: () => this.pause(id),
      resume: () => this.resume(id),

      // --- used by http.download() and pool() ---
      pauseSignal: () => ctl.pauseAc.signal,
      waitIfPaused: () => (ctl.pauseAc.signal.aborted ? abortable(new Promise((r) => ctl.waiters.push(r)), ctl.ac.signal) : Promise.resolve()),
      /** Total size of the files about to be downloaded, known up front; null when any size is unknown (then no total is shown). */
      planBytes: (bytes) => { if (bytes > 0) task.plannedBytes += bytes; else task.sizeUnknown = true; emit(false); },
      addFiles: (n) => { task.filesTotal += n; emit(false); },
      fileDone: () => { task.filesDone += 1; emit(false); },
      addSkipped: (bytes) => { if (bytes > 0) { task.bytesDone += bytes; task.bytesTotal += bytes; emit(false); } },
      noteFailure: (name, error) => {
        task.failedFiles = [...task.failedFiles.filter((f) => f.name !== name), { name, error }].slice(-50);
        emit(false);
      },
      /** A file starts downloading. Returns { progress(received, total), end(ok) }. */
      fileStart: (name, total = 0) => {
        const f = { name, done: 0, total };
        const key = Symbol(name);
        ctl.files.set(key, f);
        let counted = total;
        task.bytesTotal += total;
        emit(false);
        return {
          progress: (received, t) => {
            if (t && t > f.total) { task.bytesTotal += t - counted; counted = t; f.total = t; }
            const delta = received - f.done;
            f.done = received;
            task.bytesDone += delta;
            ctl.meter.add(delta);
            if (f.done > counted) { task.bytesTotal += f.done - counted; counted = f.done; f.total = f.done; }
            emit(false);
          },
          end: (ok) => {
            ctl.files.delete(key);
            if (ok) task.failedFiles = task.failedFiles.filter((x) => x.name !== name);
            else { task.bytesDone -= f.done; task.bytesTotal -= counted; } // it will be fetched again from scratch
            emit(false);
          },
        };
      },
      /** Register cleanup to run if the task is cancelled (e.g. remove a half-created instance). */
      onCancel: (fn) => { ctl.cleanups.push(fn); },
      setInstance: (instanceId) => { task.instanceId = instanceId; emit(false); },
    };
    ctl.api = api;
    emit(true);
    this.startTicker();
    return api;
  }

  /** Wraps an async job in a task; rethrows so callers still see the failure. Heavy tasks wait their turn first. */
  async run(title, fn, opts) {
    const t = this.create(title, opts);
    try {
      await t.started;
      const result = await als.run(t, () => fn(t));
      t.done(undefined, result);
      return result;
    } catch (e) {
      if (e instanceof CancelledError || t.signal.aborted) {
        await this.finishCancelled(t.id);
        throw e instanceof CancelledError ? e : new CancelledError();
      }
      t.fail(e);
      throw e;
    }
  }

  // ---- controls --------------------------------------------------------------------------

  activeHeavy() {
    let n = 0;
    for (const t of this.tasks.values()) if (t.heavy && (t.status === 'running' || t.status === 'paused')) n++;
    return n;
  }

  /** Cancel: aborts in-flight downloads; the task ends as 'cancelled' once its job has unwound and cleaned up. */
  cancel(id) {
    const task = this.tasks.get(id);
    const ctl = this.ctls.get(id);
    if (!task || FINAL.has(task.status) || ctl.ac.signal.aborted) return false;
    task.cancelling = true;
    ctl.ac.abort(new CancelledError());
    if (task.status === 'queued') ctl.rejectStart(new CancelledError());
    this.emitTask(task, ctl, true);
    return true;
  }

  /** Pause: no new files start, files in progress are aborted (and restarted on Resume). */
  pause(id) {
    const task = this.tasks.get(id);
    const ctl = this.ctls.get(id);
    if (!task || task.status !== 'running' || task.cancelling) return false;
    task.status = 'paused';
    task.speed = 0;
    task.eta = null;
    ctl.pauseAc.abort();
    this.emitTask(task, ctl, true);
    return true;
  }

  resume(id) {
    const task = this.tasks.get(id);
    const ctl = this.ctls.get(id);
    if (!task || task.status !== 'paused') return false;
    task.status = 'running';
    ctl.pauseAc = new AbortController();
    const waiters = ctl.waiters.splice(0);
    for (const w of waiters) w();
    this.emitTask(task, ctl, true);
    return true;
  }

  // ---- finishing -------------------------------------------------------------------------

  async finishCancelled(id) {
    const ctl = this.ctls.get(id);
    if (!ctl) return;
    for (const fn of ctl.cleanups.splice(0)) {
      try { await fn(); } catch { /* best effort: the task is ending either way */ }
    }
    const task = this.tasks.get(id);
    if (task) this.finish(task, ctl, 'cancelled', {});
  }

  finish(task, ctl, status, { step, error, result } = {}) {
    if (FINAL.has(task.status)) return;
    task.status = status;
    task.finished = Date.now();
    task.cancelling = false;
    task.speed = 0;
    task.eta = null;
    task.activeFiles = [];
    if (status === 'done') { task.progress = 1; if (step) task.step = step; }
    if (status === 'error') task.error = error;
    if (status === 'cancelled') task.step = 'Cancelled';
    if (result && typeof result === 'object') {
      if (Array.isArray(result.failed)) task.failedCount = result.failed.length;
      if (result.instance?.id) task.instanceId = result.instance.id;
    }
    if (!task.failedCount && status === 'done') task.failedCount = task.failedFiles.length;
    clearTimeout(ctl.timer);
    this.emitTask(task, ctl, true);
    this.tasks.delete(task.id);
    this.ctls.delete(task.id);
    this.record(task);
    this.pump();
    this.stopTickerIfIdle();
  }

  /** Lets the next queued heavy task start. */
  pump() {
    for (const t of this.tasks.values()) {
      if (t.status !== 'queued') continue;
      if (this.activeHeavy() >= this.maxHeavy) break;
      t.status = 'running';
      t.started = Date.now();
      const ctl = this.ctls.get(t.id);
      this.emitTask(t, ctl, true);
      ctl.start();
    }
  }

  // ---- history ---------------------------------------------------------------------------

  record(task) {
    if (task.kind === 'other' && task.status === 'done') return; // quiet housekeeping (identify, check for updates…)
    const keep = ['id', 'title', 'kind', 'icon', 'instanceId', 'createsInstance', 'status', 'error', 'step', 'started', 'finished',
      'bytesDone', 'filesDone', 'filesTotal', 'failedCount'];
    const entry = Object.fromEntries(keep.map((k) => [k, task[k]]));
    this.history = [entry, ...this.history.filter((h) => h.id !== entry.id)].slice(0, this.historyLimit);
    this.saveHistory();
  }

  removeHistory(id) {
    this.history = this.history.filter((h) => h.id !== id);
    this.saveHistory();
  }

  clearHistory() {
    this.history = [];
    this.saveHistory();
  }

  getHistory() {
    return this.history.slice();
  }

  saveHistory() {
    this.emit('history', this.getHistory());
    if (!this.historyFile) return;
    const data = this.getHistory();
    this.writing = this.writing.then(() => writeJson(this.historyFile, data)).catch(() => {});
  }

  /** Resolves when the history file is written. */
  flush() {
    return this.writing;
  }

  // ---- UI updates ------------------------------------------------------------------------

  snapshot(task, ctl) {
    const now = Date.now();
    const running = task.status === 'running';
    const speed = running && ctl ? ctl.meter.speed(now) : 0;
    // A size known up front beats counting only the files that have started; with unknown sizes there is no total at all.
    let bytesTotal = task.bytesTotal;
    if (task.sizeUnknown) bytesTotal = 0;
    else if (task.plannedBytes > 0) bytesTotal = Math.max(task.plannedBytes, task.bytesDone);
    let eta = null;
    if (running) {
      if (bytesTotal > 0) eta = computeEta(bytesTotal - task.bytesDone, speed);
      else if (task.sizeUnknown) eta = computeFilesEta(task.filesTotal - task.filesDone, task.filesDone, now - task.started);
    }
    const snap = {
      ...task,
      bytesTotal,
      speed,
      eta,
      activeFiles: ctl ? [...ctl.files.values()].slice(0, 8).map((f) => ({ ...f })) : [],
      failedFiles: task.failedFiles.slice(),
    };
    if ((snap.progress === null || snap.progress === undefined) && snap.bytesTotal > 0) snap.progress = Math.min(1, snap.bytesDone / snap.bytesTotal);
    return snap;
  }

  /** At most about four updates a second per task; a trailing update makes sure the last state is never lost. */
  emitTask(task, ctl, force) {
    const now = Date.now();
    const wait = this.emitInterval - (now - ctl.lastEmit);
    if (force || wait <= 0) {
      clearTimeout(ctl.timer);
      ctl.timer = null;
      ctl.lastEmit = now;
      this.emit('update', this.snapshot(task, ctl));
    } else if (!ctl.timer) {
      ctl.timer = setTimeout(() => {
        ctl.timer = null;
        if (this.tasks.has(task.id)) this.emitTask(task, ctl, true);
      }, wait);
      ctl.timer.unref?.();
    }
  }

  /** Keeps speed and ETA fresh (and decaying) while nothing else is changing. */
  startTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      for (const t of this.tasks.values()) if (t.status === 'running') this.emitTask(t, this.ctls.get(t.id), false);
    }, 1000);
    this.ticker.unref?.();
  }

  stopTickerIfIdle() {
    if (this.tasks.size || !this.ticker) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  list() {
    return [...this.tasks.values()].map((t) => this.snapshot(t, this.ctls.get(t.id)));
  }
}

module.exports = { TaskManager, SpeedMeter, computeEta, computeFilesEta, readable };
