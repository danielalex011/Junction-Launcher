'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { tmpDir, makeCtx } = require('./helpers');
const { assessSpace, diskSpace, checkSpace, MIN_FREE_BYTES, MIN_FREE_PERCENT } = require('../src/core/space');
const { Modpacks } = require('../src/core/content/modpacks');

const GB = 1024 ** 3;

test('space check: plenty of room is fine', () => {
  const a = assessSpace({ free: 400 * GB, total: 500 * GB, needed: 10 * GB });
  assert.equal(a.low, false);
  assert.equal(a.notEnough, false);
  assert.equal(a.after, 390 * GB);
});

test('space check: under 5 GB left warns, even on a huge drive', () => {
  const a = assessSpace({ free: 9 * GB, total: 4000 * GB, needed: 5 * GB });
  assert.equal(a.low, true);
  assert.equal(a.notEnough, false);
  assert.match(a.message, /needs about 5\.0 GB/);
  assert.match(a.message, /9\.0 GB of 3\.9 TB|9\.0 GB of/);
});

test('space check: under 10% left warns, even with more than 5 GB', () => {
  const a = assessSpace({ free: 60 * GB, total: 500 * GB, needed: 20 * GB }); // 40 GB left = 8%
  assert.equal(a.low, true);
  assert.equal(a.notEnough, false);
  assert.ok(a.percentAfter < MIN_FREE_PERCENT);
  assert.ok(a.after > MIN_FREE_BYTES);
});

test('space check: exactly on the limits does not warn; one byte under does', () => {
  assert.equal(assessSpace({ free: 100 * GB, total: 500 * GB, needed: 50 * GB }).low, false); // 50 GB = exactly 10%
  assert.equal(assessSpace({ free: 100 * GB, total: 500 * GB, needed: 50 * GB + 1 }).low, true);
  assert.equal(assessSpace({ free: 10 * GB, total: 20 * GB, needed: 5 * GB }).low, false); // exactly 5 GB and 25%
  assert.equal(assessSpace({ free: 10 * GB, total: 20 * GB, needed: 5 * GB + 1 }).low, true);
});

test('space check: more than is free says there is not enough', () => {
  const a = assessSpace({ free: 3 * GB, total: 500 * GB, needed: 8 * GB });
  assert.equal(a.low, true);
  assert.equal(a.notEnough, true);
  assert.match(a.message, /only 3\.0 GB is free/);
});

test('diskSpace reads the real drive of a folder; checkSpace uses the data folder', async () => {
  const d = await diskSpace(tmpDir());
  assert.ok(d.total > 0 && d.free >= 0 && d.free <= d.total);
  assert.equal(await diskSpace(path.join(tmpDir(), 'does', 'not', 'exist')), null);
  const ctx = await makeCtx();
  const a = await checkSpace(ctx, 1);
  assert.equal(a.needed, 1);
  // two reads of a live drive: anything writing in between (a build, an update) moves it a little, so allow some slack
  assert.ok(Math.abs(a.free - (await diskSpace(ctx.root)).free) < 64 * 1024 * 1024);
});

test('modpack size estimate: mrpack counts listed files plus overrides, skips client-unsupported files', async () => {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    game: 'minecraft', name: 'P', versionId: '1', dependencies: { minecraft: '1.20.1' },
    files: [
      { path: 'mods/a.jar', fileSize: 1000, hashes: {}, downloads: [] },
      { path: 'mods/b.jar', fileSize: 2000, hashes: {}, downloads: [], env: { client: 'required' } },
      { path: 'mods/server.jar', fileSize: 99999, hashes: {}, downloads: [], env: { client: 'unsupported' } },
    ],
  })));
  zip.addFile('overrides/config/x.toml', Buffer.alloc(500));
  zip.addFile('client-overrides/options.txt', Buffer.alloc(40));
  zip.addFile('server-overrides/ignored.txt', Buffer.alloc(7000));
  const file = path.join(tmpDir(), 'p.mrpack');
  zip.writeZip(file);
  const mp = new Modpacks(await makeCtx(), null, null, { curseforge: { configured: () => false } });
  assert.equal(await mp.estimateArchive(file), 1000 + 2000 + 500 + 40);
});

test('modpack size estimate: CurseForge pack adds the sizes CurseForge reports', async () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    manifestType: 'minecraftModpack', name: 'P', version: '1', overrides: 'overrides',
    minecraft: { version: '1.20.1', modLoaders: [] },
    files: [{ projectID: 1, fileID: 10, required: true }, { projectID: 2, fileID: 11, required: true }, { projectID: 3, fileID: 12, required: false }],
  })));
  zip.addFile('overrides/config/y.json', Buffer.alloc(300));
  const file = path.join(tmpDir(), 'p.zip');
  zip.writeZip(file);
  let asked = null;
  const cf = { configured: () => true, files: async (ids) => { asked = ids; return ids.map((id) => ({ id, files: [{ size: id * 100, primary: true }] })); } };
  const mp = new Modpacks(await makeCtx(), null, null, { curseforge: cf });
  assert.equal(await mp.estimateArchive(file), 300 + 1000 + 1100);
  assert.deepEqual(asked, [10, 11]);
});

test('modpack size estimate: not a pack gives null, never an error', async () => {
  const file = path.join(tmpDir(), 'x.zip');
  fs.writeFileSync(file, 'nope');
  const mp = new Modpacks(await makeCtx(), null, null, { curseforge: { configured: () => false } });
  assert.equal(await mp.estimateArchive(file), null);
});
