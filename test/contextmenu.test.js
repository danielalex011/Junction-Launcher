'use strict';
// Right-click on an instance card (Home and Library) opens a menu with the same things as the "…" menu, plus Play/Stop and shortcuts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', f), 'utf8');

test('Home and Library cards open the context menu on right-click', () => {
  assert.match(read('home.js'), /oncontextmenu: \(e\) => instanceContextMenu\(e, inst\)/);
  assert.match(read('library.js'), /oncontextmenu: \(e\) => instanceContextMenu\(e, inst\)/);
});

test('the menu has Play or Stop, Open, folder and Logs, then the same items as the "…" menu', () => {
  const src = read('instance.js');
  const start = src.indexOf('function instanceContextMenu(e, inst)');
  const fn = src.slice(start, src.indexOf('function instanceMenuItems(inst)'));
  assert.ok(start > 0 && fn.length > 100, 'found the function');
  for (const w of ["label: 'Stop'", "label: 'Play'", "label: 'Open'", "label: 'Open game folder'", "label: 'Logs'", '...instanceMenuItems(inst)']) assert.ok(fn.includes(w), w);
  assert.match(fn, /e\.preventDefault\(\)/, 'the browser\'s own menu does not show');
  assert.match(fn, /pointAnchor\(e\.clientX, e\.clientY\)/, 'opens at the mouse pointer');
  // the "…" button on the instance page uses the very same list, so the two never drift apart
  assert.match(src, /function instanceMenu\(anchor, inst\) \{\s*popupMenu\(anchor, instanceMenuItems\(inst\)\);/);
  for (const w of ['Export as Modrinth pack', 'Rename…', 'Duplicate', 'Delete instance', 'Save as template…']) assert.ok(src.includes(w), w);
});

test('menus close with Escape and a click elsewhere, and a right-click menu puts the keyboard on its first item', () => {
  const d = read('dialogs.js');
  assert.match(d, /function pointAnchor\(x, y\)/);
  assert.match(d, /e\.key === 'Escape'/);
  assert.match(d, /first\.focus\(\)/);
});

test('deleting from a card refreshes the page you are on instead of jumping to the Library', () => {
  assert.match(read('instance.js'), /go\(state\.view === 'instance' \? 'library' : state\.view\)/);
});

test('a menu never opens off the top or bottom of the window', () => {
  assert.match(read('dialogs.js'), /Math\.max\(8, Math\.min\(wanted, window\.innerHeight - mh - 8\)\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8'), /\.menu \{[^}]*max-height: calc\(100vh - 16px\); overflow-y: auto;/);
});
