'use strict';
// Microsoft account sign-in (device code flow -> Xbox Live -> XSTS -> Minecraft)
// plus offline accounts. Tokens are encrypted at rest with the OS keychain
// (Electron safeStorage) when available.
const crypto = require('crypto');
const { readJson, writeJson } = require('../util');

const MS = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';

class AuthError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function form(obj) {
  return new URLSearchParams(obj).toString();
}

function offlineUuid(name) {
  // Same algorithm the vanilla server uses for offline players (UUID v3 of "OfflinePlayer:<name>").
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  return md5.toString('hex');
}

const XERR = {
  2148916233: 'This Microsoft account has no Xbox profile. Sign in once at minecraft.net to create one.',
  2148916235: 'Xbox Live is not available in your country.',
  2148916236: 'This account needs adult verification on the Xbox website (South Korea).',
  2148916237: 'This account needs adult verification on the Xbox website (South Korea).',
  2148916238: 'This is a child account. An adult must add it to a Microsoft Family before it can play.',
};

class Accounts {
  constructor(ctx) {
    this.ctx = ctx;
    this.file = ctx.paths.accountsFile;
    this.data = { active: null, accounts: [] };
    this.pending = new Map();
  }

  async load() {
    this.data = await readJson(this.file, { active: null, accounts: [] });
    return this;
  }

  async save() { await writeJson(this.file, this.data); }

  list() {
    return this.data.accounts.map((a) => ({
      id: a.id, type: a.type, name: a.name, uuid: a.uuid, active: a.id === this.data.active,
      needsRelogin: Boolean(a.needsRelogin),
    }));
  }

  canAddOffline() {
    // Like Prism Launcher: offline accounts unlock once you've signed in with an account that owns the game.
    return this.data.accounts.some((a) => a.type === 'msa' && a.ownsGame);
  }

  async setActive(id) {
    if (!this.data.accounts.find((a) => a.id === id)) throw new Error('Unknown account');
    this.data.active = id;
    await this.save();
  }

  async remove(id) {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.active === id) this.data.active = this.data.accounts[0]?.id || null;
    await this.save();
  }

  async addOffline(name) {
    name = String(name || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Name must be 3-16 characters: letters, numbers or _');
    if (!this.canAddOffline()) throw new Error('Sign in with a Microsoft account that owns Minecraft first.');
    const uuid = offlineUuid(name);
    const acc = { id: `offline-${uuid}`, type: 'offline', name, uuid };
    this.data.accounts = this.data.accounts.filter((a) => a.id !== acc.id).concat(acc);
    this.data.active = acc.id;
    await this.save();
    return acc;
  }

  clientId() {
    const id = String(this.ctx.settings.get('msClientId') || '').trim();
    if (!id) {
      throw new AuthError(
        'Microsoft sign-in needs an Azure application (client) ID. Add one in Settings → Microsoft sign-in. See the README for how to get one.',
        'NO_CLIENT_ID',
      );
    }
    return id;
  }

  /** Step 1: start device code login. Returns what the UI shows the user. */
  async beginMicrosoftLogin() {
    const client_id = this.clientId();
    const res = await this.ctx.http.request(`${MS}/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ client_id, scope: SCOPE }),
      retries: 1,
    });
    const dc = await res.json();
    const loginId = crypto.randomBytes(8).toString('hex');
    this.pending.set(loginId, { ...dc, client_id, cancelled: false, started: Date.now() });
    return { loginId, userCode: dc.user_code, verificationUri: dc.verification_uri, expiresIn: dc.expires_in, message: dc.message };
  }

  cancelLogin(loginId) {
    const p = this.pending.get(loginId);
    if (p) p.cancelled = true;
  }

  /** Step 2: poll until the user finishes in the browser, then exchange tokens. */
  async completeMicrosoftLogin(loginId) {
    const p = this.pending.get(loginId);
    if (!p) throw new Error('Login session not found');
    let interval = (p.interval || 5) * 1000;
    const deadline = p.started + (p.expires_in || 900) * 1000;
    try {
      while (Date.now() < deadline) {
        if (p.cancelled) throw new AuthError('Sign-in cancelled', 'CANCELLED');
        await new Promise((r) => setTimeout(r, interval));
        if (p.cancelled) throw new AuthError('Sign-in cancelled', 'CANCELLED');
        const res = await this.ctx.http.fetch(`${MS}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: p.client_id, device_code: p.device_code }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) return await this.finishWithMsToken(body);
        if (body.error === 'authorization_pending') continue;
        if (body.error === 'slow_down') { interval += 5000; continue; }
        if (body.error === 'expired_token') throw new AuthError('The code expired. Try again.', 'EXPIRED');
        if (body.error === 'authorization_declined') throw new AuthError('Sign-in was declined.', 'DECLINED');
        throw new AuthError(body.error_description || body.error || `Token request failed (${res.status})`, body.error);
      }
      throw new AuthError('The code expired. Try again.', 'EXPIRED');
    } finally {
      this.pending.delete(loginId);
    }
  }

  async minecraftFromMs(msAccessToken) {
    const http = this.ctx.http;
    const xbl = await http.json('https://user.auth.xboxlive.com/user/authenticate', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      json: { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' },
    });
    const xstsRes = await http.fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'junction-launcher' },
      body: JSON.stringify({ Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' }),
    });
    const xsts = await xstsRes.json().catch(() => ({}));
    if (!xstsRes.ok) throw new AuthError(XERR[xsts.XErr] || `Xbox sign-in failed (${xstsRes.status}${xsts.XErr ? `, XErr ${xsts.XErr}` : ''})`, 'XSTS');
    const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;
    let mc;
    try {
      mc = await http.json('https://api.minecraftservices.com/authentication/login_with_xbox', {
        method: 'POST', json: { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }, retries: 1,
      });
    } catch (e) {
      if (e.status === 403) {
        throw new AuthError('Mojang refused this app (403). New Azure apps must be approved by Mojang for Minecraft sign-in — see the README.', 'APP_NOT_APPROVED');
      }
      throw e;
    }
    let profile = null;
    try {
      profile = await http.json('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: `Bearer ${mc.access_token}` }, retries: 1 });
    } catch (e) {
      if (e.status === 404) throw new AuthError('This Microsoft account does not own Minecraft: Java Edition (or has never set a profile name).', 'NO_GAME');
      throw e;
    }
    const xuid = (() => {
      try { return JSON.parse(Buffer.from(mc.access_token.split('.')[1], 'base64url').toString()).xuid || ''; } catch { return ''; }
    })();
    return { accessToken: mc.access_token, expiresAt: Date.now() + (mc.expires_in || 86400) * 1000, profile, xuid };
  }

  async finishWithMsToken(ms) {
    const mc = await this.minecraftFromMs(ms.access_token);
    const enc = (v) => this.ctx.crypto.encrypt(v);
    const acc = {
      id: `msa-${mc.profile.id}`, type: 'msa', name: mc.profile.name, uuid: mc.profile.id, xuid: mc.xuid, ownsGame: true,
      refreshToken: await enc(ms.refresh_token || ''), mcToken: await enc(mc.accessToken), mcTokenExpires: mc.expiresAt,
    };
    this.data.accounts = this.data.accounts.filter((a) => a.id !== acc.id).concat(acc);
    this.data.active = acc.id;
    await this.save();
    return { id: acc.id, name: acc.name, uuid: acc.uuid, type: 'msa' };
  }

  /** Returns launch credentials for the active account, refreshing tokens if needed. */
  async launchCredentials() {
    const acc = this.data.accounts.find((a) => a.id === this.data.active);
    if (!acc) throw new AuthError('Add an account first (Accounts page).', 'NO_ACCOUNT');
    if (acc.type === 'offline') {
      return { name: acc.name, uuid: acc.uuid, accessToken: '0', userType: 'legacy', xuid: '0', offline: true };
    }
    const dec = (s) => this.ctx.crypto.decrypt(s);
    if (!acc.mcToken || !acc.mcTokenExpires || acc.mcTokenExpires - Date.now() < 10 * 60 * 1000) {
      const client_id = this.clientId();
      const res = await this.ctx.http.fetch(`${MS}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ grant_type: 'refresh_token', client_id, refresh_token: await dec(acc.refreshToken), scope: SCOPE }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        acc.needsRelogin = true;
        await this.save();
        throw new AuthError(`Your Microsoft sign-in for ${acc.name} expired. Remove the account and sign in again.`, 'RELOGIN');
      }
      const mc = await this.minecraftFromMs(body.access_token);
      acc.refreshToken = await this.ctx.crypto.encrypt(body.refresh_token || (await dec(acc.refreshToken)));
      acc.mcToken = await this.ctx.crypto.encrypt(mc.accessToken);
      acc.mcTokenExpires = mc.expiresAt;
      acc.name = mc.profile.name;
      acc.xuid = mc.xuid || acc.xuid;
      acc.needsRelogin = false;
      await this.save();
    }
    return { name: acc.name, uuid: acc.uuid, accessToken: await dec(acc.mcToken), userType: 'msa', xuid: acc.xuid || '0', offline: false };
  }
}

module.exports = { Accounts, AuthError, offlineUuid };
