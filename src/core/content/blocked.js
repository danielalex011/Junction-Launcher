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

module.exports = { BlockedWatcher };
