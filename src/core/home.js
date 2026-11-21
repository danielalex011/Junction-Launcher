'use strict';
// Data for the Home page: which instances to jump back into, which have updates (cached) and a few popular modpacks (cached).
// Plain Node: the renderer gets this through the 'home:*' IPC handlers.
const path = require('path');
const { readJson, writeJson } = require('./util');
const { searchAll } = require('./sources');

const UPDATES_TTL = 4 * 60 * 60 * 1000; // re-check mod updates at most every 4 hours
const POPULAR_TTL = 6 * 60 * 60 * 1000;
const RECENT_COUNT = 6;
const POPULAR_COUNT = 8;

/**
 * "Jump back in": the instances played most recently. When nothing has been played yet,
 * the most recently created or imported ones instead (fallback: true).
 */
function pickJumpBackIn(list, limit = RECENT_COUNT) {
  const played = list.filter((i) => i.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed);
  if (played.length) return { items: played.slice(0, limit), fallback: false };
  const fresh = [...list].sort((a, b) => (b.created || 0) - (a.created || 0));
  return { items: fresh.slice(0, limit), fallback: true };
}

class Home {
  constructor(ctx, instances, content, sources) {
    this.ctx = ctx;
    this.instances = instances;
    this.content = content;
    this.sources = sources;
    this.file = path.join(ctx.paths.cache, 'home.json');
    this.running = null;
  }

  async read() {
    const c = await readJson(this.file, null);
    return { updates: { checkedAt: 0, byInstance: {} }, popular: { checkedAt: 0, hits: [] }, ...(c || {}) };
  }

  /** What Home shows right now, straight from the cache (never touches the network). */
  async state(now = Date.now()) {
    const list = await this.instances.list();
    const cache = await this.read();
    const byId = new Map(list.map((i) => [i.id, i]));
    const updates = Object.entries(cache.updates.byInstance)
      .filter(([id, n]) => byId.has(id) && n > 0)
      .map(([id, count]) => ({ instanceId: id, name: byId.get(id).name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const { items, fallback } = pickJumpBackIn(list);
    return {
      recent: items,
      fallback,
      empty: list.length === 0,
      updates,
      updatesCheckedAt: cache.updates.checkedAt || null,
      updatesStale: now - (cache.updates.checkedAt || 0) > UPDATES_TTL,
      popular: cache.popular.hits,
      popularStale: now - (cache.popular.checkedAt || 0) > POPULAR_TTL || !cache.popular.hits.length,
    };
  }

  /** Remember the update count for one instance (called after the instance page checks or applies updates). */
  async record(instanceId, count) {
    const cache = await this.read();
    if (count > 0) cache.updates.byInstance[instanceId] = count; else delete cache.updates.byInstance[instanceId];
    await writeJson(this.file, cache);
  }

  /**
   * Refreshes whatever is stale. Runs as a quiet task; only one refresh at a time.
   * `force` ignores the cache age (for a manual "check now").
   */
  refresh({ force = false } = {}) {
    if (this.running) return this.running;
    this.running = this.doRefresh(force).finally(() => { this.running = null; });
    return this.running;
  }

  async doRefresh(force) {
    const now = Date.now();
    const cache = await this.read();
    const needUpdates = force || now - (cache.updates.checkedAt || 0) > UPDATES_TTL;
    const needPopular = force || now - (cache.popular.checkedAt || 0) > POPULAR_TTL || !cache.popular.hits.length;
    if (!needUpdates && !needPopular) return false;

    if (needPopular) {
      try {
        const r = await searchAll(this.ctx, this.sources, { type: 'modpack', sort: 'downloads', pageSize: POPULAR_COUNT, page: 0 });
        if (r.hits.length) cache.popular = { checkedAt: Date.now(), hits: r.hits.slice(0, POPULAR_COUNT) };
      } catch { /* offline: keep what we had */ }
    }
    if (needUpdates) {
      await this.ctx.tasks.run('Checking instances for updates', async () => {
        const byInstance = {};
        let failures = 0;
        const list = await this.instances.list();
        for (const inst of list) {
          try {
            const ups = await this.content.checkUpdates(inst.id);
            const n = ups.filter((u) => !u.error).length;
            if (n) byInstance[inst.id] = n;
            if (ups.some((u) => u.error)) failures++;
          } catch { failures++; }
        }
        // If every site failed, keep the old numbers and try again next time instead of claiming "all up to date".
        if (!list.length || failures < list.length) cache.updates = { checkedAt: Date.now(), byInstance };
      }, { kind: 'other' });
    }
    await writeJson(this.file, cache);
    return true;
  }
}

module.exports = { Home, pickJumpBackIn, UPDATES_TTL, POPULAR_TTL };
