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
  constructor(ctx, instances, content, sources, packs = null) {
    this.ctx = ctx;
    this.packs = packs; // PackLink: new versions of linked modpacks
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
    const packs = cache.updates.packs || {};
    const ids = new Set([...Object.keys(cache.updates.byInstance), ...Object.keys(packs)]);
    const updates = [...ids]
      .filter((id) => byId.has(id) && ((cache.updates.byInstance[id] || 0) > 0 || packs[id]))
      .map((id) => ({
        instanceId: id, name: byId.get(id).name, count: cache.updates.byInstance[id] || 0, icon: byId.get(id).icon || null, iconVersion: byId.get(id).iconVersion || 0,
        pack: packs[id] && String(packs[id].versionId) !== String(byId.get(id).pack?.versionId) ? packs[id] : null,
      }))
      .filter((u) => u.count > 0 || u.pack)
      .sort((a, b) => Boolean(b.pack) - Boolean(a.pack) || b.count - a.count || a.name.localeCompare(b.name));
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

  /** Remember (or clear, with null) a newer version of an instance's modpack. */
  async recordPack(instanceId, update) {
    const cache = await this.read();
    cache.updates.packs = cache.updates.packs || {};
    if (update) cache.updates.packs[instanceId] = { versionId: update.versionId, versionName: update.versionName }; else delete cache.updates.packs[instanceId];
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
        const packs = {};
        let failures = 0;
        const list = await this.instances.list();
        for (const inst of list) {
          if (this.packs) {
            // Old installs get their pack labels first, so the pack's own mods aren't counted as updates.
            try { if (await this.packs.needsLabels(inst.id)) await this.packs.label(inst.id); } catch { /* counted as before */ }
            try { const u = await this.packs.checkUpdate(inst.id); if (u) packs[inst.id] = { versionId: u.versionId, versionName: u.versionName }; } catch { /* the mod check below decides about failures */ }
          }
          try {
            const ups = await this.content.checkUpdates(inst.id);
            const n = ups.filter((u) => !u.error).length;
            if (n) byInstance[inst.id] = n;
            if (ups.some((u) => u.error)) failures++;
          } catch { failures++; }
        }
        // If every site failed, keep the old numbers and try again next time instead of claiming "all up to date".
        if (!list.length || failures < list.length) cache.updates = { checkedAt: Date.now(), byInstance, packs };
      }, { kind: 'other' });
    }
    await writeJson(this.file, cache);
    return true;
  }
}

module.exports = { Home, pickJumpBackIn, UPDATES_TTL, POPULAR_TTL };
