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

class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}${body ? `: ${String(body).slice(0, 300)}` : ''}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Http {
  /**
   * @param {{ getCurseForgeKey?: () => string, fetchImpl?: typeof fetch }} opts
   */
  constructor(opts = {}) {
    this.getCurseForgeKey = opts.getCurseForgeKey || (() => '');
    this.fetch = opts.fetchImpl || globalThis.fetch;
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
          const err = new HttpError(res.status, url, text);
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
  async download(url, dest, { sha1, sha512, size, onProgress, retries = 3, idleTimeout = 45000, headers = {} } = {}) {
    if (await exists(dest)) {
      if (sha1 && (await hashFile(dest, 'sha1')) === sha1.toLowerCase()) return { path: dest, skipped: true, sha1 };
      if (!sha1 && sha512 && (await hashFile(dest, 'sha512')) === sha512.toLowerCase()) return { path: dest, skipped: true };
      if (!sha1 && !sha512 && size && (await fsp.stat(dest)).size === size) return { path: dest, skipped: true };
    }
    await ensureDir(path.dirname(dest));
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const tmp = `${dest}.part-${crypto.randomBytes(3).toString('hex')}`;
      const ac = new AbortController();
      let timer;
      const kick = () => {
        clearTimeout(timer);
        timer = setTimeout(() => ac.abort(new Error(`Download stalled: ${url}`)), idleTimeout);
      };
      try {
        kick();
        const res = await this.fetch(url, { headers: this.headersFor(url, headers), signal: ac.signal, redirect: 'follow' });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 401 && /forgecdn|curseforge/.test(url)) {
            throw new HttpError(401, url, 'CurseForge rejected the download. Add a valid CurseForge API key in Settings.');
          }
          throw new HttpError(res.status, url, text);
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
        if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) break;
        if (attempt < retries) await sleep(700 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }
}

module.exports = { Http, HttpError, USER_AGENT };
