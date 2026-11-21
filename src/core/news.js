'use strict';
// Minecraft news for the Home page, from Mojang's own launcher feed (the same one the official launcher shows).
// Cached on disk for a few hours; if the fetch fails the last news stays. Plain Node: the renderer reaches it through 'news:*'.
const path = require('path');
const { readJson, writeJson } = require('./util');

const NEWS_URL = 'https://launchercontent.mojang.com/v2/news.json';
const NEWS_BASE = 'https://launchercontent.mojang.com';
const NEWS_TTL = 4 * 60 * 60 * 1000; // look for new articles at most every 4 hours
const RETRY_AFTER_FAIL = 10 * 60 * 1000; // after a failed fetch, wait a bit before the next try
const NEWS_COUNT = 8;
const SUMMARY_MAX = 220;

function httpsUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    return u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

/** Mojang's feed -> the few fields the carousel shows, newest first. Anything without a title or a safe link is dropped. */
function normalizeNews(feed, limit = NEWS_COUNT) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(feed?.entries) ? feed.entries : []) {
    if (!e || typeof e.title !== 'string' || !e.title.trim()) continue;
    if (Array.isArray(e.newsType) && e.newsType.length && !e.newsType.includes('News page')) continue; // play-page-only promos
    const url = httpsUrl(e.readMoreLink, NEWS_BASE);
    if (!url) continue;
    const key = e.id || `${e.title}|${e.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const img = httpsUrl(e.newsPageImage?.url || e.playPageImage?.url || '', NEWS_BASE);
    const text = String(e.text || '').replace(/\s+/g, ' ').trim();
    out.push({
      id: String(key), title: e.title.trim(), date: String(e.date || ''), category: String(e.category || ''),
      summary: text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : text,
      image: img && new URL(img).hostname === 'launchercontent.mojang.com' ? img : null, url,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

class News {
  constructor(ctx) {
    this.ctx = ctx;
    this.file = path.join(ctx.paths.cache, 'news.json');
    this.running = null;
  }

  async read() {
    const c = await readJson(this.file, null);
    return { checkedAt: 0, triedAt: 0, items: [], ...(c || {}) };
  }

  /** What Home shows right now, straight from the cache (never touches the network). */
  async state(now = Date.now()) {
    const enabled = this.ctx.settings.get('showNews') !== false;
    const c = await this.read();
    const stale = enabled && now - c.checkedAt > NEWS_TTL && now - c.triedAt > RETRY_AFTER_FAIL;
    return { enabled, items: enabled ? c.items : [], checkedAt: c.checkedAt || null, stale };
  }

  /** Fetches when the cache is old (or `force`). A failure or an empty answer keeps the previous news. */
  refresh({ force = false } = {}) {
    if (this.running) return this.running;
    this.running = this.doRefresh(force).finally(() => { this.running = null; });
    return this.running;
  }

  async doRefresh(force) {
    if (this.ctx.settings.get('showNews') === false) return this.state();
    const now = Date.now();
    const c = await this.read();
    if (!force && now - c.checkedAt <= NEWS_TTL) return this.state();
    if (!force && now - c.triedAt <= RETRY_AFTER_FAIL) return this.state();
    try {
      const items = normalizeNews(await this.ctx.http.json(NEWS_URL, { retries: 1, timeout: 15000 }));
      if (items.length) await writeJson(this.file, { checkedAt: Date.now(), triedAt: Date.now(), items });
      else await writeJson(this.file, { ...c, triedAt: Date.now() });
    } catch {
      await writeJson(this.file, { ...c, triedAt: Date.now() }); // offline or Mojang is down: keep the last news
    }
    return this.state();
  }
}

module.exports = { News, normalizeNews, NEWS_URL, NEWS_TTL, RETRY_AFTER_FAIL };
