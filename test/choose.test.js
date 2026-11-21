'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickVersion, compareSources } = require('../src/core/sources/choose');

const day = (n) => new Date(Date.UTC(2026, 10, 20) - n * 864e5).toISOString();
const ver = (id, releaseType, d, extra = {}) => ({
  source: 'modrinth', id, versionNumber: `v${id}`, releaseType, date: day(d), gameVersions: ['26.1.2'], loaders: ['fabric'], downloads: 10,
  files: [{ url: 'https://x/y.jar', filename: 'y.jar', size: 2048, primary: true }], ...extra,
});

test('pickVersion: mods prefer release over newer beta, then newest', () => {
  const list = [ver('beta', 'beta', 1), ver('old', 'release', 30), ver('new', 'release', 5), ver('alpha', 'alpha', 0)];
  assert.equal(pickVersion(list, 'mod').id, 'new');
  assert.equal(pickVersion([ver('b', 'beta', 9), ver('a', 'alpha', 1)], 'mod').id, 'b');
  assert.equal(pickVersion([], 'mod'), null);
});

test('pickVersion: modpacks take the first (newest) release, else the first entry', () => {
  assert.equal(pickVersion([ver('beta', 'beta', 1), ver('rel', 'release', 9)], 'modpack').id, 'rel');
  assert.equal(pickVersion([ver('beta', 'beta', 1), ver('alpha', 'alpha', 9)], 'modpack').id, 'beta');
});

const alts = [{ source: 'modrinth', id: 'M1', url: 'https://modrinth.com/x' }, { source: 'curseforge', id: 77, url: 'https://curseforge.com/x' }];

test('compareSources: both fit, points out the newer one and a beta-only site', async () => {
  const lists = { modrinth: [ver('m', 'release', 20)], curseforge: [ver('c', 'beta', 2, { source: 'curseforge' })] };
  const r = await compareSources({ alts, type: 'mod', mcVersion: '26.1.2', loadVersions: async (s) => lists[s] });
  assert.equal(r.only, null);
  assert.equal(r.options[0].version.id, 'm');
  assert.equal(r.options[1].newer, true);
  assert.equal(r.options[0].newer, false);
  assert.equal(r.options[0].version.size, 2048);
  assert.match(r.notes.join('\n'), /Newer on CurseForge/);
  assert.match(r.notes.join('\n'), /On CurseForge the latest is a beta/);
});

test('compareSources: only one site has a compatible version', async () => {
  const r = await compareSources({ alts, type: 'mod', mcVersion: '1.20.1', loadVersions: async (s) => (s === 'curseforge' ? [ver('c', 'release', 3)] : []) });
  assert.equal(r.only, 'curseforge');
  assert.equal(r.options[0].version, null);
  assert.equal(r.options[0].reason, 'Not available for Minecraft 1.20.1 on Modrinth.');
});

test('compareSources: a site that errors counts as unavailable, none at all gives only=null', async () => {
  const r = await compareSources({
    alts, type: 'modpack',
    loadVersions: async (s) => { if (s === 'curseforge') throw new Error('offline'); return []; },
  });
  assert.equal(r.only, null);
  assert.match(r.options[1].reason, /Couldn't check CurseForge/);
  assert.equal(r.options[0].reason, 'No downloadable version on Modrinth.');
});

test('compareSources: modpacks show differing Minecraft versions, loaders and manual-download packs', async () => {
  const lists = {
    modrinth: [ver('m', 'release', 12)],
    curseforge: [ver('c', 'release', 3, { gameVersions: ['26.2'], loaders: ['neoforge'], files: [{ url: null, filename: 'p.zip', size: 5, primary: true }] })],
  };
  const r = await compareSources({ alts, type: 'modpack', loadVersions: async (s) => lists[s] });
  assert.match(r.notes.join('\n'), /Different Minecraft versions: 26\.1\.2 on Modrinth, 26\.2 on CurseForge/);
  assert.match(r.notes.join('\n'), /Different loaders/);
  assert.equal(r.options[1].version.manualDownload, true);
  assert.equal(r.options[0].version.manualDownload, false);
});

test('the preferred-site setting defaults to asking', () => {
  const { defaults } = require('../src/core/settings');
  assert.equal(defaults().preferredSource, 'ask');
});
