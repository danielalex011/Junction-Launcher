'use strict';
// Release hygiene: secrets stay out of logs, git and the shipped files; the Advanced fields are for dev builds only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scrub, ErrorLog } = require('../src/core/errorlog');
const { Settings } = require('../src/core/settings');
const { tmpDir } = require('./helpers');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('logs hide the exact sign-in app ID and CurseForge key in use, wherever they show up', () => {
  const id = '3f2a9c1e-7b4d-4e68-9a10-5c2d8e7f1a44';
  const key = '$2a$10$abcdefghijklmnopqrstuv';
  const text = `AADSTS700016: Application with identifier '${id}' was not found. x-api-key ${key}`;
  const out = scrub(text, [id, key]);
  assert.ok(!out.includes(id) && !out.includes(key), out);
  const dir = tmpDir();
  new ErrorLog(dir, { secrets: () => [id, key] }).write('window', text);
  const logged = fs.readFileSync(path.join(dir, 'logs', 'window-errors.log'), 'utf8');
  assert.ok(!logged.includes(id) && !logged.includes(key), logged);
});

test('the settings know which secrets are in use: your own override and the built-in ones', async () => {
  const crypto = { encrypt: async (s) => `b64:${Buffer.from(s).toString('base64')}`, decrypt: async (s) => Buffer.from(String(s).slice(4), 'base64').toString() };
  const s = new Settings(path.join(tmpDir(), 'settings.json'), crypto, { msClientId: 'built-in-client-id', cfApiKey: 'built-in-cf-key' });
  await s.load();
  assert.deepEqual(s.secretValues().sort(), ['built-in-cf-key', 'built-in-client-id']);
  await s.update({ msClientId: 'my-own-client-id', cfApiKey: 'my-own-cf-key' });
  const all = s.secretValues();
  assert.ok(all.includes('my-own-client-id') && all.includes('my-own-cf-key'));
  assert.ok(!JSON.stringify(s.publicView()).includes('my-own-cf-key'), 'the page never gets the key back');
  assert.equal(s.get('msClientId'), 'my-own-client-id', 'an override saved earlier keeps being used');
});

test('the Advanced sign-in and CurseForge fields only appear in dev builds', () => {
  const ui = read('src', 'renderer', 'settings.js');
  assert.match(ui, /state\.info\?\.devBuild \? h\('details'[^\n]*Advanced: use your own Azure app ID/);
  assert.match(ui, /state\.info\?\.devBuild \? h\('details'[^\n]*Advanced: use your own CurseForge API key/);
  assert.match(read('src', 'main', 'main.js'), /devBuild: isDevBuild\(\)/);
  assert.match(read('tools', 'deploy-dev.js'), /dev-build\.txt/);
  assert.ok(!/extraMetadata/.test(read('tools', 'deploy-dev.js').replace(/\/\/[^\n]*/g, '')), 'extraMetadata makes electron-builder overwrite package.json on disk');
  assert.ok(pkg.scripts && pkg.scripts['dist:win'] && pkg.build && pkg.devDependencies, 'package.json is whole (scripts, build, devDependencies)');
  assert.ok(!JSON.stringify(pkg.build).includes('dev-build'), 'the marker is never part of what dist:win packs');
});

test('build-config.json is ignored by git and not tracked; user data cannot be packed', () => {
  assert.match(read('.gitignore'), /^build-config\.json$/m);
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n');
  assert.ok(!tracked.includes('build-config.json'));
  // the packaged file list is an allow-list: source, package.json, licence, build-config.json and production modules; no data folders
  for (const f of pkg.build.files) assert.ok(!/JunctionData|portable\.txt|accounts|settings\.json|APPDATA|data\//i.test(f), f);
  assert.ok(pkg.build.files.includes('src/**/*') && pkg.build.files.includes('build-config.json'));
  assert.ok(!(pkg.build.extraResources || pkg.build.extraFiles), 'nothing is copied in from outside the project');
});

test('the CurseForge key follows a redirect only to CurseForge hosts, and downloads never drop to plain http', async () => {
  const { makeCtx } = require('./helpers');
  const hop = (to) => () => ({ status: 302, headers: { location: to } });
  const ctx = await makeCtx([
    ['GET', 'https://api.curseforge.com/v1/ok', hop('https://edge.forgecdn.net/files/a.jar')],
    ['GET', 'https://edge.forgecdn.net/files/a.jar', () => ({ body: 'jar-bytes' })],
    ['GET', 'https://api.curseforge.com/v1/away', hop('https://elsewhere.example/steal')],
    ['GET', 'https://elsewhere.example/steal', () => ({ body: 'x' })],
    ['GET', 'https://api.curseforge.com/v1/relative', hop('/v1/ok')],
    ['GET', 'https://api.curseforge.com/v1/downgrade', hop('http://edge.forgecdn.net/files/a.jar')],
    ['GET', 'https://api.curseforge.com/v1/loop', hop('https://api.curseforge.com/v1/loop')],
  ], { cfKey: 'cf-secret-key-123' });
  const keyOn = (u) => ctx.requestLog.filter((r) => r.url === u).map((r) => r.headers['x-api-key']);
  assert.equal(await (await ctx.http.request('https://api.curseforge.com/v1/ok')).text(), 'jar-bytes');
  assert.deepEqual(keyOn('https://edge.forgecdn.net/files/a.jar'), ['cf-secret-key-123'], 'CurseForge CDN still gets the key');
  assert.equal(await (await ctx.http.request('https://api.curseforge.com/v1/away')).text(), 'x');
  assert.deepEqual(keyOn('https://elsewhere.example/steal'), [undefined], 'a host that is not CurseForge never sees the key');
  assert.equal(await (await ctx.http.request('https://api.curseforge.com/v1/relative')).text(), 'jar-bytes', 'relative redirects work');
  await assert.rejects(ctx.http.request('https://api.curseforge.com/v1/downgrade', { retries: 0 }), /unencrypted/);
  await assert.rejects(ctx.http.request('https://api.curseforge.com/v1/loop', { retries: 0 }), /too many times/);
  // the same rule for file downloads
  const dest = path.join(tmpDir(), 'a.jar');
  await ctx.http.download('https://api.curseforge.com/v1/away', dest, {}).catch(() => {});
  assert.ok(ctx.requestLog.filter((r) => r.url === 'https://elsewhere.example/steal').every((r) => r.headers['x-api-key'] === undefined));
});
