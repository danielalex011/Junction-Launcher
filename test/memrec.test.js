'use strict';
// Memory recommendations: reading each config format, the rules on 8 / 16 / 32 GB PCs, the pre-launch check and the Java check for presets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../src/core/memrec');
const { tmpDir } = require('./helpers');

const GB = 1024;
const MEMORY_SETTINGS = JSON.stringify({
  minimumClient: { 'desc:': 'x', minimumClient: 4096 },
  maximumClient: { 'desc:': 'x', maximumClient: 12512 },
  disableWarnings: { 'desc:': 'x', disableWarnings: false },
  howtolink: { 'desc:': 'x', howtolink: 'https://rpg.prominence.wiki/performance-guide' },
  recommendedMemory: { 'desc:': 'x', 'memory values': ['8000:4200', '16000:8192', '24000:9000', '32000:9500', '64000:10256'] },
});

function gameDirWith(files) {
  const dir = tmpDir('memrec');
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return dir;
}

test('reads the Memory Settings mod (Prominence II format)', async () => {
  const p = await R.readPackMemory(gameDirWith({ 'config/memorysettings.json': MEMORY_SETTINGS }));
  assert.equal(p.source, 'memorysettings');
  assert.equal(p.minMB, 4096);
  assert.equal(p.maxMB, 12512);
  assert.equal(p.guideUrl, 'https://rpg.prominence.wiki/performance-guide');
  assert.equal(p.warningsOff, false);
  assert.equal(p.table.length, 5);
  assert.equal(R.tableRecommend(p.table, 32000), 9500);
  assert.ok(Math.abs(R.tableRecommend(p.table, 31900) - 9494) < 40, 'interpolates close to the mod\'s 9494 MB');
  assert.equal(R.tableRecommend(p.table, 4000), 4200, 'below the table: the first row');
});

test('reads MemoryTester and Config Checker files leniently, and survives garbage', async () => {
  const t = await R.readPackMemory(gameDirWith({ 'config/MemoryTester/General.cfg': 'general {\n  I:RecommendedMemoryAllocation=6144\n}\n'.replace('I:', '') }));
  // the key may sit inside a block; a plain "key=value" line is what we read
  assert.equal(t?.source, 'memorytester');
  assert.equal(t.recommendedMB, 6144);
  const gb = R.parseMemoryTester('RecommendedMemoryAllocation = 6');
  assert.equal(gb.recommendedMB, 6144, 'a small number means GB');
  const cc = R.parseConfigChecker('{\n  "requiredRam": 3072,\n  "recommendedRam": 6144\n}');
  assert.equal(cc.minMB, 3072);
  assert.equal(cc.recommendedMB, 6144);
  assert.equal(R.parseConfigChecker('hello = world'), null);
  assert.equal(R.parseMemorySettings('{not json'), null);
  assert.equal(await R.readPackMemory(gameDirWith({ 'config/memorysettings.json': 'x'.repeat(300 * 1024) })), null, 'huge files are ignored');
  assert.equal(await R.readPackMemory(gameDirWith({})), null);
});

test('CurseForge: a stored recommended RAM from the manifest is used', async () => {
  const p = await R.readPackMemory(gameDirWith({}), { pack: { recommendedRamMB: 8192 } });
  assert.equal(p.source, 'manifest');
  assert.equal(p.recommendedMB, 8192);
});

const prominence = () => R.parseMemorySettings(MEMORY_SETTINGS);

test('pack range: a value inside it that suits the PC (8, 16, 32 GB)', () => {
  const r32 = R.recommend({ pack: prominence(), mods: 460, totalMB: 32 * GB, name: 'Prominence II' });
  assert.equal(r32.source, 'pack');
  assert.equal(r32.mb, 9.5 * GB);
  assert.equal(r32.label, "From the pack's settings");
  assert.match(r32.reason, /^Recommended 9\.5 GB · Prominence II allows up to 12\.22 GB · needs at least 4 GB · your PC has 32 GB$/);
  const r16 = R.recommend({ pack: prominence(), mods: 460, totalMB: 16 * GB });
  assert.equal(r16.mb, 8 * GB);
  assert.ok(r16.mb <= 12 * GB, 'cap: 75% of 16 GB');
  const r8 = R.recommend({ pack: prominence(), mods: 460, totalMB: 8 * GB });
  assert.equal(r8.mb, 4 * GB, 'an 8 GB PC keeps 4 GB free');
  assert.equal(r8.pcShort, false);
  const small = R.recommend({ pack: { minMB: 6 * GB, maxMB: 8 * GB }, totalMB: 8 * GB });
  assert.equal(small.pcShort, true, 'the PC cannot give what the pack needs');
  assert.ok(small.mb <= 5 * GB);
});

test('estimate from the mod count, with shaders and the PC limits', () => {
  const est = (o, total = 32 * GB) => R.recommend({ totalMB: total, ...o });
  assert.equal(est({ mods: 0 }).mb, 3 * GB);
  assert.equal(est({ mods: 50 }).mb, 4 * GB);
  assert.equal(est({ mods: 51 }).mb, 6 * GB);
  assert.equal(est({ mods: 150 }).mb, 6 * GB);
  assert.equal(est({ mods: 300 }).mb, 8 * GB);
  assert.equal(est({ mods: 460 }).mb, 9 * GB);
  assert.equal(est({ mods: 460, shaders: 1 }).mb, 10 * GB);
  assert.equal(est({ mods: 460, shaders: 1 }).label, "Junction's estimate (460 mods)");
  assert.equal(est({ mods: 460, resourcePacks: 5 }).mb, 10 * GB);
  assert.equal(est({ mods: 100, resourcePacks: 2 }).mb, 6 * GB, 'a few resource packs add nothing');
  assert.equal(est({ mods: 460, shaders: 1 }, 16 * GB).mb, 10 * GB, '16 GB: 75% is 12');
  assert.equal(est({ mods: 460 }, 8 * GB).mb, 4 * GB);
  assert.equal(est({ mods: 100 }, 8 * GB).mb, 4 * GB);
  assert.ok(R.pcCap(8 * GB) <= 5 * GB);
  assert.equal(R.pcCap(16 * GB), 12 * GB);
  assert.equal(R.pcCap(32 * GB), 24 * GB);
  assert.equal(est({ mods: 460, shaders: 3 }, 64 * GB).mb, 10 * GB, 'never over 10 GB without the pack asking');
  const big = R.recommend({ pack: { minMB: 12 * GB, maxMB: 16 * GB, recommendedMB: 14 * GB }, totalMB: 64 * GB });
  assert.equal(big.mb, 14 * GB, 'the pack\'s own range may go over 10 GB');
});

test('memory mode defaults and the amount used', () => {
  assert.equal(R.memoryMode({ pack: { name: 'x' } }), 'recommended');
  assert.equal(R.memoryMode({}), 'default');
  assert.equal(R.memoryMode({ pack: {}, memoryMax: 6144 }), 'custom', 'an amount set earlier stays');
  assert.equal(R.memoryMode({ pack: {}, memoryMode: 'default' }), 'default');
  const rec = { mb: 9728 };
  assert.equal(R.effectiveMB({ memoryMode: 'recommended' }, rec, 4096), 9728);
  assert.equal(R.effectiveMB({ memoryMode: 'default' }, rec, 4096), 4096);
  assert.equal(R.effectiveMB({ memoryMode: 'custom', memoryMax: 5000 }, rec, 4096), 5000);
});

test('pre-launch check: outside the pack range warns, unless turned off', () => {
  const rec = R.recommend({ pack: prominence(), totalMB: 32 * GB });
  const high = R.checkAllocation({ memoryMode: 'custom', memoryMax: 14144 }, rec, 4096);
  assert.equal(high.problem, 'high');
  assert.equal(high.limitMB, 12512);
  assert.equal(R.checkAllocation({ memoryMode: 'custom', memoryMax: 2048 }, rec, 4096).problem, 'low');
  assert.equal(R.checkAllocation({ memoryMode: 'custom', memoryMax: 8192 }, rec, 4096), null);
  assert.equal(R.checkAllocation({ memoryMode: 'recommended' }, rec, 4096), null);
  assert.equal(R.checkAllocation({ memoryMode: 'default' }, rec, 3000).problem, 'low', 'the global default counts too');
  assert.equal(R.checkAllocation({ memoryMode: 'custom', memoryMax: 14144, memoryWarnOff: true }, rec, 4096), null);
  assert.equal(R.checkAllocation({ memoryMode: 'custom', memoryMax: 14144 }, { ...rec, warningsOff: true }, 4096), null, 'the pack turned its warnings off');
  assert.equal(R.checkAllocation({ memoryMode: 'custom', memoryMax: 14144 }, R.recommend({ mods: 10, totalMB: 32 * GB }), 4096), null, 'no pack range, no warning');
});

test('JVM presets are checked against the Java version', () => {
  const on17 = R.presetsFor(17);
  const zgc = on17.find((p) => p.id === 'zgc');
  assert.equal(zgc.ok, false);
  assert.match(zgc.reason, /Java 21/);
  assert.equal(on17.find((p) => p.id === 'g1').ok, true);
  assert.equal(R.presetsFor(21).find((p) => p.id === 'zgc').ok, true);
  assert.equal(R.checkPreset('zgc', 17).ok, false);
  assert.equal(R.checkPreset('zgc', 25).ok, true);
  assert.equal(R.checkPreset('nope', 21).ok, false);
  assert.equal(R.presetsFor(0).every((p) => p.ok), true, 'unknown Java: nothing is blocked');
});
