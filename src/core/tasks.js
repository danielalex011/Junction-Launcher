'use strict';
// Background task tracking. The UI subscribes to 'update' and renders progress bars.
const { EventEmitter } = require('events');

let seq = 0;

class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
  }

  create(title, { instanceId } = {}) {
    const id = `t${++seq}`;
    const task = {
      id, title, instanceId, status: 'running', progress: null, detail: '', error: null, started: Date.now(),
    };
    this.tasks.set(id, task);
    let lastEmit = 0;
    const emit = (force) => {
      const now = Date.now();
      if (!force && now - lastEmit < 120) return; // throttle UI updates
      lastEmit = now;
      this.emit('update', { ...task });
    };
    const api = {
      id,
      update: (progress, detail) => {
        if (progress !== undefined && progress !== null) task.progress = Math.max(0, Math.min(1, progress));
        if (detail !== undefined) task.detail = detail;
        emit(false);
      },
      done: (detail) => {
        task.status = 'done'; task.progress = 1; if (detail) task.detail = detail;
        emit(true);
        setTimeout(() => this.tasks.delete(id), 60000);
      },
      fail: (err) => {
        task.status = 'error'; task.error = String(err?.message || err);
        emit(true);
      },
    };
    emit(true);
    return api;
  }

  list() {
    return [...this.tasks.values()];
  }

  /** Wraps an async job in a task; rethrows so callers still see the failure. */
  async run(title, fn, opts) {
    const t = this.create(title, opts);
    try {
      const r = await fn(t);
      t.done();
      return r;
    } catch (e) {
      t.fail(e);
      throw e;
    }
  }
}

module.exports = { TaskManager };
