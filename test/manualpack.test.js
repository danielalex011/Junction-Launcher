'use strict';
// A CurseForge pack zip the author only allows from their website: Junction waits for it in Downloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { waitForDownload } = require('../src/core/content/blocked');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'junction-dl-'));
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

test('waitForDownload: ignores a same-named file with the wrong hash, takes the right one', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'Pack.zip'), 'old different file');
  const p = waitForDownload({ dir, fileName: 'Pack.zip', sha1: sha1('the real pack'), pollMs: 30 });
  await new Promise((r) => setTimeout(r, 120));
  fs.writeFileSync(path.join(dir, 'Pack (1).zip'), 'the real pack');
  assert.equal(path.basename(await p), 'Pack (1).zip');
});

test('waitForDownload: rejects when cancelled', async () => {
  const dir = tmp();
  const ac = new AbortController();
  const p = waitForDownload({ dir, fileName: 'Pack.zip', sha1: sha1('x'), signal: ac.signal, pollMs: 30 });
  setTimeout(() => ac.abort(new Error('stop')), 60);
  await assert.rejects(p, /stop/);
});
