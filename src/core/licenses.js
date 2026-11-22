'use strict';
// The licence texts of the code Junction ships with, for Settings → About.
const fs = require('fs');
const path = require('path');

// [name shown, where the licence text lives (relative to the app folder)]
const SOURCES = [
  ['Junction', 'LICENSE'],
  ['skinview3d', 'src/renderer/vendor/LICENSE-skinview3d.txt'],
  ['three.js', 'src/renderer/vendor/LICENSE-three.txt'],
  ['skinview-utils', 'src/renderer/vendor/LICENSE-skinview-utils.txt'],
  ['marked', 'node_modules/marked/LICENSE'],
  ['adm-zip', 'node_modules/adm-zip/LICENSE'],
  ['sql.js', 'node_modules/sql.js/LICENSE'],
];

/** @returns {Array<{name: string, text: string}>} the ones that could be read, in a fixed order */
function readLicenses(appRoot) {
  const out = [];
  for (const [name, rel] of SOURCES) {
    try {
      const text = fs.readFileSync(path.join(appRoot, rel), 'utf8').trim();
      if (text) out.push({ name, text });
    } catch { /* not shipped in this build */ }
  }
  return out;
}

module.exports = { readLicenses, SOURCES };
