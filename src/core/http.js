'use strict';
// HTTP + verified downloads. Every file is hashed while it streams and only
// renamed into place once the hash matches, so a cut connection never leaves a
// half-written jar behind.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { ensureDir, exists, hashFile } = require('./util');

const VERSION = require('../../package.json').version;
const USER_AGENT = `junction-launcher/${VERSION} (personal Minecraft launcher)`;

/** CDNs answer errors with whole HTML pages. Those never belong in a message. */
const looksLikeHtml = (t) => /^\s*(<!doctype|<html|<head|<body|<\?xml)/i.test(String(t)) || /<\/?(html|body|head|center|h1|title)\b/i.test(String(t));
const stripTags = (t) => String(t).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

class HttpError extends Error {
  constructor(status, url, body, { retryAfter = 0 } = {}) {
    const text = body && !looksLikeHtml(body) ? stripTags(body).slice(0, 200) : '';
    super(`HTTP ${status} for ${url}${text ? `: ${text}` : ''}`);
    this.status = status;
    this.url = url;
    this.body = body;
    this.retryAfter = retryAfter; // milliseconds, from the Retry-After header
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry-After is either seconds or a date. Returns milliseconds (0 if absent), capped at a minute. */
function parseRetryAfter(value) {
  if (!value) return 0;
  const secs = Number(value);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60000) : 0;
}

/** Would trying again help? Rate limits, server errors, dropped connections, stalls and damaged downloads: yes. Bad requests and full disks: no. */
function isRetryable(e) {
  if (e instanceof HttpError) return e.status === 429 || e.status === 408 || e.status >= 500;
  if (e && typeof e.code === 'string' && /^E(NOSPC|ACCES|PERM|ROFS|ISDIR|MFILE|NOENT)$/.test(e.code)) return false;
  return true;
}

function siteOf(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* no host */ }
  if (host.endsWith('modrinth.com')) return { name: 'Modrinth', cdn: host.startsWith('cdn.') };
  if (host.endsWith('forgecdn.net')) return { name: 'CurseForge', cdn: true };
  if (host.endsWith('curseforge.com')) return { name: 'CurseForge', cdn: false };
  if (/minecraft\.net$|mojang\.com$/.test(host)) return { name: 'Mojang', cdn: /^(libraries|resources)\./.test(host) };
  return { name: host || 'The server', cdn: false };
}

/**
 * One plain sentence for people: what went wrong and who it was. Never contains HTML or a URL.
 *   "Modrinth's download server timed out (HTTP 503)"
 */
function describeError(e) {
  if (e instanceof HttpError) {
    const { name, cdn } = siteOf(e.url);
    const who = cdn ? `${name}'s download server` : name;
    const s = e.status;
    const body = String(e.body || '');
    const clean = body && !looksLikeHtml(body) ? stripTags(body) : '';
    if (s === 401 && clean) return clean;
    if (s === 429) return `${who} is busy right now and asked us to slow down (HTTP 429)`;
    if (s === 408 || s === 504 || /time-?d?\s?out/i.test(body)) return `${who} timed out (HTTP ${s})`;
    if (s === 503 || s === 502) return `${who} is unavailable right now (HTTP ${s})`;
    if (s >= 500) return `${who} had a server error (HTTP ${s})`;
    if (s === 404 || s === 410) return `${who} couldn't find the file (HTTP ${s})`;
    if (s === 401 || s === 403) return `${who} refused the download (HTTP ${s})`;
    return `${who} refused the request (HTTP ${s})`;
  }
  const msg = String((e && e.message) || e || 'Unknown error');
  const code = e?.code || e?.cause?.code || '';
  if (code === 'ENOSPC') return 'Your disk is full';
  if (code === 'EACCES' || code === 'EPERM') return "Junction isn't allowed to write there";
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || /stalled|timed? ?out|aborted/i.test(msg)) return 'The connection timed out';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(code + msg)) return "Couldn't connect. Check your internet connection";
  if (/ECONNRESET|socket hang up|terminated/i.test(code + msg)) return 'The connection was interrupted';
  if (/(SHA-1|SHA-512) mismatch/i.test(msg)) return 'The downloaded file was damaged (checksum mismatch)';
  return stripTags(msg.replace(/https?:\/\/\S+/g, '')).slice(0, 160) || 'Unknown error';
}

/** Gentle limits for the CDNs that answer "503 first byte timeout" when hit with too many requests at once. */
const CDN_LIMIT = 6;
function gateKey(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return null; }
  if (host === 'cdn.modrinth.com') return 'modrinth-cdn';
  if (host.endsWith('.forgecdn.net')) return 'forgecdn';
  return null;
}

class Gate {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  async acquire() {
    if (this.active < this.limit) { this.active++; return; }
    await new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); else this.active--; // hand the slot straight on
  }
}

class Http {
  /**
   * @param {{ getCurseForgeKey?: () => string, fetchImpl?: typeof fetch }} opts
   */
  constructor(opts = {}) {
    this.getCurseForgeKey = opts.getCurseForgeKey || (() => '');
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this.sleep = opts.sleep || sleep;
    this.retryDelays = opts.retryDelays || [2000, 5000, 10000, 20000]; // before retries 1..4, jittered
    this.cdnLimit = opts.cdnLimit || CDN_LIMIT;
    this.gates = new Map();
  }

  gateFor(url) {
    const key = gateKey(url);
    if (!key) return null;
    if (!this.gates.has(key)) this.gates.set(key, new Gate(this.cdnLimit));
    return this.gates.get(key);
  }

  /** How long to wait before retry number attempt+1: Retry-After if the server gave one, else exponential steps with ±25% jitter. */
  backoff(attempt, err) {
    if (err?.retryAfter) return err.retryAfter + Math.round(Math.random() * 500);
    const base = this.retryDelays[Math.min(attempt, this.retryDelays.length - 1)] || 0;
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  headersFor(url, extra = {}) {
    const h = { 'User-Agent': USER_AGENT, ...extra };
    let host = '';
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    // CurseForge requires the API key on the API *and* (since July 2026) on CDN downloads.
    if (host === 'api.curseforge.com' || host.endsWith('.forgecdn.net')) {
      const key = this.getCurseForgeKey();
      if (key) h['x-api-key'] = key;
    }
    return h;
  }

  async request(url, { method = 'GET', headers = {}, body, json, retries = 2, timeout = 30000 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`Timed out after ${timeout} ms: ${url}`)), timeout);
      try {
        const h = this.headersFor(url, headers);
        let payload = body;
        if (json !== undefined) {
          h['Content-Type'] = 'application/json';
          payload = JSON.stringify(json);
        }
        const res = await this.fetch(url, { method, headers: h, body: payload, signal: ac.signal, redirect: 'follow' });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new HttpError(res.status, url, text, { retryAfter: parseRetryAfter(res.headers.get('retry-after')) });
          // Retry only things that might succeed next time.
          if (res.status === 429 || res.status >= 500) {
            lastErr = err;
            const wait = Number(res.headers.get('retry-after')) * 1000 || 800 * (attempt + 1);
            await sleep(Math.min(wait, 10000));
            continue;
          }
          throw err;
        }
        return res;
      } catch (e) {
        if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
        lastErr = e;
        if (attempt < retries) await sleep(600 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async json(url, opts) {
    const res = await this.request(url, opts);
    return res.json();
  }

  async text(url, opts) {
    const res = await this.request(url, opts);
    return res.text();
  }

  /**
   * Download url -> dest. Skips the download if dest already exists and matches the hash.
   * @returns {Promise<{path:string, skipped:boolean, sha1?:string}>}
   */
  async download(url, dest, { sha1, sha512, size, onProgress, retries = this.retryDelays.length, idleTimeout = 45000, headers = {} } = {}) {
    if (await exists(dest)) {
      if (sha1 && (await hashFile(dest, 'sha1')) === sha1.toLowerCase()) return { path: dest, skipped: true, sha1 };
      if (!sha1 && sha512 && (await hashFile(dest, 'sha512')) === sha512.toLowerCase()) return { path: dest, skipped: true };
      if (!sha1 && !sha512 && size && (await fsp.stat(dest)).size === size) return { path: dest, skipped: true };
    }
    await ensureDir(path.dirname(dest));
    const gate = this.gateFor(url);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const tmp = `${dest}.part-${crypto.randomBytes(3).toString('hex')}`;
      const ac = new AbortController();
      let timer;
      let wait = 0;
      const kick = () => {
        clearTimeout(timer);
        timer = setTimeout(() => ac.abort(new Error(`Download stalled: ${url}`)), idleTimeout);
      };
      if (gate) await gate.acquire();
      try {
        kick();
        const res = await this.fetch(url, { headers: this.headersFor(url, headers), signal: ac.signal, redirect: 'follow' });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 401 && /forgecdn|curseforge/.test(url)) {
            throw new HttpError(401, url, 'CurseForge rejected the download. Add a valid CurseForge API key in Settings.');
          }
          throw new HttpError(res.status, url, text, { retryAfter: parseRetryAfter(res.headers.get('retry-after')) });
        }
        const total = Number(res.headers.get('content-length')) || size || 0;
        const h1 = crypto.createHash('sha1');
        const h512 = sha512 ? crypto.createHash('sha512') : null;
        const out = fs.createWriteStream(tmp);
        let received = 0;
        try {
          for await (const chunk of res.body) {
            kick();
            received += chunk.length;
            h1.update(chunk);
            if (h512) h512.update(chunk);
            if (!out.write(chunk)) await once(out, 'drain');
            if (onProgress) onProgress(received, total);
          }
        } finally {
          await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
        }
        const got1 = h1.digest('hex');
        if (sha1 && got1 !== sha1.toLowerCase()) throw new Error(`SHA-1 mismatch for ${path.basename(dest)} (expected ${sha1}, got ${got1})`);
        if (h512) {
          const got512 = h512.digest('hex');
          if (got512 !== sha512.toLowerCase()) throw new Error(`SHA-512 mismatch for ${path.basename(dest)}`);
        }
        await fsp.rename(tmp, dest);
        return { path: dest, skipped: false, sha1: got1 };
      } catch (e) {
        lastErr = e;
        await fsp.rm(tmp, { force: true }).catch(() => {});
        if (!isRetryable(e) || attempt >= retries) break;
        wait = this.backoff(attempt, e);
      } finally {
        clearTimeout(timer);
        if (gate) gate.release(); // never hold a slot while waiting to retry
      }
      if (wait) await this.sleep(wait);
    }
    throw lastErr;
  }
}

module.exports = { Http, HttpError, USER_AGENT, describeError, isRetryable, parseRetryAfter };
