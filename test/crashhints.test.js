'use strict';
// Spotting why a game didn't start, in plain words: an incompatible mod, a missing mod, or running out of memory.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHintDetector, attachFiles } = require('../src/core/minecraft/crashhints');

const run = (lines) => {
  const d = createHintDetector();
  const out = [];
  for (const l of lines) { const h = d.push(l); if (h) out.push(h); }
  const last = d.end();
  if (last) out.push(last);
  return out;
};

test('All the Mods 10 + Let Me Despawn: the real lines give one "incompatible" hint with the reason', () => {
  const hints = run([
    "[21:00:43] [Render thread/ERROR] [ne.ne.fm.DeferredWorkQueue/]: Mod 'kubejs' encountered an error in a deferred task:",
    'net.minecraft.ReportedException: ',
    'Incompatible mod loaded: letmedespawn',
    ' - Reason: This mod can cause same items to not stack due to NBT issues',
    '\tat TRANSFORMER/kubejstweaks@1.0.7/dev.uncandango.kubejstweaks.kubejs.kjs72.plugin.KJSTPlugin.afterInit(KJSTPlugin.java:75)',
    'Caused by: java.lang.Throwable: ',
    'Incompatible mod loaded: letmedespawn',
    ' - Reason: This mod can cause same items to not stack due to NBT issues',
    '\tSuppressed: net.minecraft.ReportedException: ',
    'Incompatible mod loaded: letmedespawn',
  ]);
  assert.deepEqual(hints, [{ kind: 'incompatible', modId: 'letmedespawn', reason: 'This mod can cause same items to not stack due to NBT issues' }]);
});

test('missing mods on NeoForge and Fabric, and running out of memory', () => {
  const neo = run(["\tMod ID: 'sodium', Requested by: 'iris', Expected range: '[0.6.0,)', Actual version: '[MISSING]'"]);
  assert.deepEqual(neo, [{ kind: 'missing', modId: 'sodium', requestedBy: 'iris' }]);
  const fab = run(["\t - Mod 'Iris' (iris) 1.8.0 requires any version of mod 'Sodium' (sodium), which is missing!"]);
  assert.equal(fab[0].kind, 'missing');
  assert.equal(fab[0].modId, 'sodium');
  assert.equal(fab[0].name, 'Sodium');
  assert.equal(fab[0].requestedByName, 'Iris');
  assert.deepEqual(run(['Exception in thread "Render thread" java.lang.OutOfMemoryError: Java heap space', 'java.lang.OutOfMemoryError: Java heap space']), [{ kind: 'memory' }]);
  assert.deepEqual(run(['[21:00:34] [Render thread/INFO]: Setting user: Steve', 'WARNING: sun.misc.Unsafe']), [], 'normal output gives no hints');
});

test('a hint finds the installed file by mod id or file name, so the page can offer "Turn off …"', () => {
  const items = [
    { file: 'mods/letmedespawn-neoforge-1.21.1-1.26.11.1.jar', fileName: 'letmedespawn-neoforge-1.21.1-1.26.11.1.jar', title: 'Let Me Despawn', modId: 'letmedespawn', enabled: true, fromPack: false },
    { file: 'mods/iris-1.8.0.jar', fileName: 'iris-1.8.0.jar', title: 'Iris Shaders', modId: 'iris', enabled: true },
    { file: 'mods/oddname.jar', fileName: 'oddname.jar', title: 'Odd', modId: null, enabled: false },
  ];
  const a = attachFiles({ kind: 'incompatible', modId: 'letmedespawn' }, items);
  assert.deepEqual(a.file, { rel: 'mods/letmedespawn-neoforge-1.21.1-1.26.11.1.jar', title: 'Let Me Despawn', enabled: true, fromPack: false });
  assert.equal(attachFiles({ kind: 'incompatible', modId: 'oddname' }, items).file.rel, 'mods/oddname.jar', 'falls back to the file name');
  assert.equal(attachFiles({ kind: 'incompatible', modId: 'notinstalled' }, items).file, undefined);
  assert.equal(attachFiles({ kind: 'missing', modId: 'sodium', requestedBy: 'iris' }, items).requestedByTitle, 'Iris Shaders');
});

test('the page wiring: event allowed, hints kept after the game closes, Logs tab shows the card', () => {
  const root = path.join(__dirname, '..');
  const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
  assert.match(read('src', 'main', 'preload.js'), /'inst:hint'/);
  const main = read('src', 'main', 'main.js');
  assert.match(main, /handle\('inst:hints'/);
  assert.match(main, /detector\.end\(\)/);
  const inst = read('src', 'renderer', 'instance.js');
  assert.match(inst, /content:toggle', instId, hint\.file\.rel, false/);
  assert.ok(!/innerHTML/.test(inst.slice(inst.indexOf('function logHintCard'), inst.indexOf('async function renderLogsTab'))), 'hint text goes in through h()');
});

test('NeoForge log lines ("[thread/LEVEL] [mod/]:") are coloured by their real level too', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'instance.js'), 'utf8');
  const logLineClass = vm.runInNewContext(`(${/function logLineClass\(l\) \{[\s\S]*?\n\}/.exec(src)[0]})`);
  assert.equal(logLineClass("[21:00:34] [Render thread/WARN] [minecolonies/]: Could not get attribute value for 'attribute.name.generic.armor'"), 'l-warn');
  assert.equal(logLineClass('[21:00:43] [Render thread/ERROR] [ne.ne.fm.DeferredWorkQueue/]: Mod \'kubejs\' encountered an error'), 'l-err');
  assert.equal(logLineClass('[21:00:52] [Render thread/INFO] [mojang/Library]: OpenGL debug message: type=ERROR, severity=HIGH'), '', 'INFO stays plain even when it says ERROR');
  assert.equal(logLineClass('[17:55:16] [Render thread/INFO]: Setting user: 0Dani'), '');
});
