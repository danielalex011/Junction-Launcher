'use strict';
// Some CurseForge authors don't allow third-party downloads. Instead of
// working around that, Junction opens the file page and watches your
// Downloads folder, then moves the file into place once it's there.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { hashFile } = require('../util');

class BlockedWatcher extends EventEmitter {
  constructor(content, instId, items, downloadsDir) {
    super();
    this.content = content;
    this.instId = instId;
    this.items = items.map((i) => ({ ...i, done: false }));
    this.dir = downloadsDir;
    this.watcher = null;
    this.timer = null;
    this.busy = false;
  }

  start() {
    try {
      this.watcher = fs.watch(this.dir, () => this.scan());
    } catch { /* fall back to polling only */ }
    this.timer = setInterval(() => this.scan(), 2500);
    this.scan();
    return this;
  }

  stop() {
    if (this.watcher) this.watcher.close();
    clearInterval(this.timer);
  }

  status() {
    return this.items.map(({ title, fileName, pageUrl, done, error }) => ({ title, fileName, pageUrl, done, error }));
  }

  async tryFile(item, file) {
    try {
      await this.content.acceptManualFile(this.instId, item, file);
      item.done = true;
      item.error = null;
      this.emit('update', this.status());
      return true;
    } catch (e) {
      item.error = e.message;
      this.emit('update', this.status());
      return false;
    }
  }

  async scan() {
    if (this.busy) return;
    this.busy = true;
    try {
      const names = new Set(await fsp.readdir(this.dir).catch(() => []));
      for (const item of this.items) {
        if (item.done) continue;
        // Browsers sometimes add " (1)" when a file already exists.
        const ext = path.extname(item.fileName);
        const stem = item.fileName.slice(0, -ext.length);
        const candidates = [item.fileName, ...[1, 2, 3].map((n) => `${stem} (${n})${ext}`)].filter((n) => names.has(n));
        for (const c of candidates) {
          const full = path.join(this.dir, c);
          if (item.sha1 && (await hashFile(full, 'sha1').catch(() => '')) !== item.sha1) continue;
          if (await this.tryFile(item, full)) break;
        }
      }
      if (this.items.every((i) => i.done)) {
        this.emit('complete');
        this.stop();
      }
    } finally {
      this.busy = false;
    }
  }

  /** User picked files by hand (drag & drop or file dialog). */
  async offer(filePaths) {
    for (const f of filePaths) {
      const base = path.basename(f);
      const sha = await hashFile(f, 'sha1').catch(() => '');
      const item = this.items.find((i) => !i.done && (i.sha1 ? i.sha1 === sha : i.fileName === base));
      if (item) await this.tryFile(item, f);
    }
    if (this.items.every((i) => i.done)) { this.emit('complete'); this.stop(); }
    return this.status();
  }
}

/**
 * Waits for one file (a modpack zip the author only allows from their website) to show up in the
 * Downloads folder. Resolves with its path once the sha1 matches (or, when the API gave none, once a
 * file with that name newer than `since` appears). Rejects if `signal` aborts (the task's Cancel).
 */
function waitForDownload({ dir, fileName, sha1, signal, since = Date.now() - 2000, pollMs = 2000 }) {
  return new Promise((resolve, reject) => {
    let watcher = null;
    let timer = null;
    let busy = false;
    let finished = false;
    const ext = path.extname(fileName);
    const stem = fileName.slice(0, ext ? -ext.length : undefined);
    const wanted = new Set([fileName, ...[1, 2, 3].map((n) => `${stem} (${n})${ext}`)]);
    const end = (fn, v) => {
      if (finished) return;
      finished = true;
      if (watcher) watcher.close();
      clearInterval(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => end(reject, signal.reason || new Error('Cancelled'));
    const scan = async () => {
      if (busy || finished) return;
      busy = true;
      try {
        const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => wanted.has(n));
        for (const n of names) {
          const full = path.join(dir, n);
          const st = await fsp.stat(full).catch(() => null);
          if (!st || !st.isFile()) continue;
          if (sha1 ? (await hashFile(full, 'sha1').catch(() => '')) === sha1 : st.mtimeMs >= since) { end(resolve, full); return; }
        }
      } finally { busy = false; }
    };
    if (signal?.aborted) return onAbort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try { watcher = fs.watch(dir, () => scan()); } catch { /* polling only */ }
    timer = setInterval(scan, pollMs);
    scan();
  });
}

module.exports = { BlockedWatcher, waitForDownload };
