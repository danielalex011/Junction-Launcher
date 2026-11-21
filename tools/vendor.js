'use strict';
// `npm run vendor`: copies the skinview3d browser bundle and the licenses of the code inside it from node_modules
// into src/renderer/vendor/. Run it after changing the skinview3d version, then commit the result.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'renderer', 'vendor');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const files = [
  [nm('skinview3d', 'bundles', 'skinview3d.bundle.js'), 'skinview3d.bundle.js'],
  [nm('skinview3d', 'LICENSE'), 'LICENSE-skinview3d.txt'],
  [nm('three', 'LICENSE'), 'LICENSE-three.txt'], // three.js is bundled inside skinview3d
  [nm('skinview-utils', 'LICENSE'), 'LICENSE-skinview-utils.txt'], // so is skinview-utils
];
fs.mkdirSync(out, { recursive: true });
for (const [from, name] of files) {
  if (!fs.existsSync(from)) { console.error(`Missing ${path.relative(root, from)}. Run npm install first.`); process.exit(1); }
  fs.copyFileSync(from, path.join(out, name));
  console.log(`vendor/${name}`);
}
console.log(`skinview3d ${require(nm('skinview3d', 'package.json')).version}, three ${require(nm('three', 'package.json')).version}`);
