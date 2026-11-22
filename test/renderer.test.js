'use strict';
// Guards for the renderer's shared global scope and the preload bridge: the kind of mistakes that break a page silently.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ErrorLog, scrub } = require('../src/core/errorlog');

const rdir = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(rdir, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith('vendor/'));
const read = (f) => fs.readFileSync(path.join(rdir, f), 'utf8');

test('every event the page listens for is allowed by the preload bridge', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  const allowed = new Set([...preload.match(/EVENTS = new Set\(\[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const used = new Set();
  for (const f of scripts) for (const m of read(f).matchAll(/(?<![\w.])on\('([^']+)'/g)) used.add(m[1]);
  assert.ok(used.size > 3, 'found the on(...) calls');
  for (const e of used) assert.ok(allowed.has(e), `preload.js does not allow the "${e}" event (the page script would stop at that line)`);
});

test('every event the main process sends is allowed by the preload bridge', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const allowed = new Set([...preload.match(/EVENTS = new Set\(\[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  for (const m of main.matchAll(/\bsend\('([^']+)'/g)) assert.ok(allowed.has(m[1]), `main.js sends "${m[1]}" but preload.js does not pass it on`);
});

test('renderer scripts do not redefine each other\'s top-level functions or variables', () => {
  const seen = new Map();
  for (const f of scripts) {
    for (const m of read(f).matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1] || m[2];
      assert.ok(!seen.has(name), `"${name}" is defined in both ${seen.get(name)} and ${f}: the later one silently replaces the first`);
      seen.set(name, f);
    }
  }
});

test('the account menu code reads only things that exist when accounts.js finishes loading', () => {
  // accounts.js must not stop halfway (e.g. on a rejected on() call), or accountMenu stays uninitialised.
  const src = read('accounts.js');
  const iLet = src.indexOf('let accountMenu');
  const firstOn = src.indexOf("on('");
  assert.ok(iLet > -1 && firstOn > -1);
  assert.ok(iLet < firstOn, 'declare accountMenu before anything in the file that can throw');
});

test('error log writes a line, hides tokens and keeps the file small', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'junction-errlog-'));
  const log = new ErrorLog(dir);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEFghiJKL';
  assert.ok(log.write('window', `Uncaught Error: boom Authorization: Bearer abc123def456ghi789 token=SECRETVALUE99 ${jwt}`, 'accounts.js:21'));
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /\[window\] Uncaught Error: boom/);
  assert.match(text, /accounts\.js:21/);
  for (const secret of ['abc123def456ghi789', 'SECRETVALUE99', jwt]) assert.ok(!text.includes(secret), `${secret} was written to the log`);
  fs.writeFileSync(log.file, 'x'.repeat(600 * 1024));
  log.write('window', 'again');
  assert.ok(fs.existsSync(`${log.file}.old`));
  assert.ok(fs.statSync(log.file).size < 1000);
  assert.equal(scrub('access_token: "abcd1234"'), 'access_token: "[hidden]"');
  assert.equal(new ErrorLog('/nonexistent\0bad').write('window', 'x'), false); // never throws
});

test('dialogs sit above the Activity panel, and opening one closes the panel', () => {
  const css = read('styles.css');
  const z = (re) => Number(re.exec(css)[1]);
  const overlay = z(/\.overlay \{[^}]*z-index: (\d+)/);
  const panel = z(/\.activity-panel \{[^}]*z-index: (\d+)/);
  const menu = z(/\.menu \{[^}]*z-index: (\d+)/);
  const toasts = z(/#toasts \{[^}]*z-index: (\d+)/);
  assert.ok(overlay > panel, 'a dialog is never hidden behind the Activity panel');
  assert.ok(menu > overlay && toasts > overlay, 'menus and toasts stay on top of dialogs');
  assert.match(read('dialogs.js'), /function modal\([^)]*\) \{[^}]*closeActivity\(\)/s, 'modal() closes the Activity panel');
});

test('the template review ignores clicks on the backdrop; a link to a deleted instance goes to the Library', () => {
  assert.match(read('dialogs.js'), /backdropClose && e\.target === overlay/);
  assert.match(read('templates.js'), /backdropClose: false/);
  assert.match(read('instance.js'), /Instance not found[\s\S]{0,80}go\('library'\)/);
});

test('every renderer script is valid JavaScript (a syntax error leaves every page empty)', () => {
  const vm = require('node:vm');
  for (const f of scripts) {
    assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), `${f} does not parse`);
  }
});
