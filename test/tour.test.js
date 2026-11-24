'use strict';
// The in-app tour: every spotlight target exists on the page, the steps are short and plain, and people can start it from three places.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rdir = path.join(__dirname, '..', 'src', 'renderer');
const read = (f) => fs.readFileSync(path.join(rdir, f), 'utf8');
const tourSrc = read('tour.js');
const STEPS = vm.runInNewContext(`${tourSrc.replace(/^'use strict';/, '')}\nTOUR_STEPS`, {});

test('the tour is short, starts and ends in the middle, and every step has plain words', () => {
  assert.ok(STEPS.length >= 6 && STEPS.length <= 12, `${STEPS.length} steps`);
  assert.equal(STEPS[0].target, undefined);
  assert.equal(STEPS[STEPS.length - 1].target, undefined);
  for (const s of STEPS) {
    assert.ok(s.title && s.title.length <= 30, s.title);
    assert.ok(s.text && s.text.length >= 40 && s.text.length <= 230, `"${s.title}" text is ${s.text && s.text.length} characters`);
  }
});

test('every spotlight target is a real part of the sidebar', () => {
  const html = read('index.html');
  const app = read('app.js');
  const navIds = [...app.matchAll(/\{ id: '(\w+)', label: '[^']+', icon: '\w+' \}/g)].map((m) => m[1]);
  assert.ok(navIds.includes('home') && navIds.includes('settings'));
  assert.match(app, /'data-nav': n\.id/);
  for (const s of STEPS.filter((x) => x.target)) {
    const nav = /^\[data-nav="(\w+)"\]$/.exec(s.target);
    if (nav) assert.ok(navIds.includes(nav[1]), `${s.target} is not a page in the sidebar`);
    else assert.ok(new RegExp(`id="${s.target.slice(1)}"`).test(html), `${s.target} is not in index.html`);
  }
  const seen = new Set(STEPS.filter((x) => x.target).map((x) => x.target));
  assert.equal(seen.size, STEPS.filter((x) => x.target).length, 'no target twice');
});

test('the tour can be started from Home, Settings → About and Ctrl+K, and keeps to the page rules', () => {
  assert.match(read('home.js'), /startTour\(\)/);
  assert.match(read('settings.js'), /Take the tour/);
  const qs = read('quicksearch.js');
  const line = qs.match(/act\('tour'[^\n]*/)[0];
  for (const w of ['tour', 'guide', 'help', 'tutorial']) assert.ok(line.includes(`'${w}'`), `Ctrl+K word ${w}`);
  const html = read('index.html');
  assert.ok(html.indexOf('tour.js') > html.indexOf('helpers.js') && html.indexOf('tour.js') < html.indexOf('<script src="app.js">'));
  assert.ok(!/innerHTML/.test(tourSrc), 'text goes in through h(), never innerHTML');
  for (const key of ['Escape', 'ArrowRight', 'ArrowLeft']) assert.ok(tourSrc.includes(`'${key}'`), `${key} works in the tour`);
  assert.match(tourSrc, /aria-modal/);
});
