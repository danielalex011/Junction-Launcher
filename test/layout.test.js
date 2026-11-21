'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');

test('browse search bar and results share one centred column', () => {
  assert.match(css, /\.browse-top\s*\{[^}]*--browse-w/);
  assert.match(css, /\.browse-body\s*\{[^}]*--browse-w/);
  assert.match(css, /\.page\s*\{[^}]*margin:\s*0 auto/);
});

test('results become a 2-column grid on wide windows and 3 on very wide ones', () => {
  assert.match(css, /@media \(min-width: 1820px\)[^@]*\.results\s*\{[^}]*repeat\(2,/);
  assert.match(css, /@media \(min-width: 2420px\)\s*\{\s*\.results\s*\{[^}]*repeat\(3,/);
});
