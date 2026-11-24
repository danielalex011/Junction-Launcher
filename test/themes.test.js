'use strict';
// Themes: the presets stay readable, a theme file round-trips and is validated, and the stylesheet only uses colours the theme engine sets.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/renderer/themes');
const C = require('../src/renderer/color');
const { normalizeAppearance, DEFAULT_APPEARANCE, windowBackground } = require('../src/core/appearance');

const rdir = path.join(__dirname, '..', 'src', 'renderer');
const css = fs.readFileSync(path.join(rdir, 'styles.css'), 'utf8');

test('there are ten presets, each a complete valid colour set, and Midnight is the default look', () => {
  assert.deepEqual(T.PRESET_IDS, ['midnight', 'oled', 'slate', 'deepslate', 'nether', 'end', 'ocean', 'forest', 'cherry', 'light']);
  for (const p of T.PRESETS) {
    assert.deepEqual(Object.keys(p.colors), T.KEYS);
    for (const v of Object.values(p.colors)) assert.match(v, /^#[0-9a-f]{6}$/, p.id);
  }
  assert.equal(DEFAULT_APPEARANCE.theme, 'midnight');
  const v = T.cssVars(DEFAULT_APPEARANCE);
  // unchanged from the look before themes existed
  assert.equal(v['--bg'], '#111317'); assert.equal(v['--panel'], '#171a20'); assert.equal(v['--text'], '#e7e9ee');
  assert.equal(v['--accent'], '#8ea2ff'); assert.equal(v['--good'], '#3ccf8e'); assert.equal(v['--combo'], '#c9a0ff'); assert.equal(v['--accent-ink'], '#0d1020');
});

test('every preset keeps text, status colours, the violet Pack marking and the accent readable', () => {
  for (const p of T.PRESETS) {
    assert.deepEqual(T.contrastWarnings(p.colors), [], `${p.id} has low contrast`);
    for (const accent of ['#8ea2ff', '#ff6b8b', '#a3e635', '#f2b84b']) {
      const v = T.cssVars({ theme: p.id, accent });
      for (const name of ['--accent', '--good', '--warn', '--bad', '--combo', '--mr', '--cf', '--info', '--orange']) {
        for (const surface of ['--bg', '--panel', '--panel-2', '--panel-3']) {
          assert.ok(C.contrast(v[name], v[surface]) >= 4.4, `${p.id}: ${name} on ${surface} is ${C.contrast(v[name], v[surface]).toFixed(2)}:1 (accent ${accent})`);
        }
      }
      assert.ok(C.contrast(v['--accent'], v['--accent-ink']) >= 4.5, `${p.id}: text on the accent button`);
    }
  }
  assert.equal(T.resolve({ theme: 'light' }).light, true);
  assert.equal(T.resolve({ theme: 'oled' }).light, false);
});

test('appearance settings keep theme, custom colours, font, motion and the Home card flag clean', () => {
  const a = normalizeAppearance({ theme: 'nope', font: 'comic', reduceMotion: 'sometimes', translucent: 1, themeCardDismissed: 1 });
  assert.equal(a.theme, 'midnight'); assert.equal(a.font, 'default'); assert.equal(a.reduceMotion, 'system'); assert.equal(a.translucent, true); assert.equal(a.themeCardDismissed, true);
  assert.equal(normalizeAppearance({ theme: 'custom' }).theme, 'midnight', 'custom without colours falls back');
  const c = normalizeAppearance({ theme: 'custom', customBase: 'light', customColors: { bg: '#102030', text: 'red', panel: '#abc' } });
  assert.equal(c.theme, 'custom');
  assert.equal(c.customColors.bg, '#102030');
  assert.equal(c.customColors.panel, '#aabbcc');
  assert.equal(c.customColors.text, T.presetById('light').colors.text, 'a broken colour comes from the base preset');
  assert.equal(windowBackground({ theme: 'oled' }), '#000000');
  assert.equal(windowBackground(c), '#102030');
  assert.equal(normalizeAppearance({ theme: 'ocean' }).theme, 'ocean');
});

test('contrast warnings name what is hard to read in a custom theme', () => {
  const bad = { ...T.presetById('midnight').colors, text: '#2a303a' };
  const w = T.contrastWarnings(bad);
  assert.ok(w.some((t) => t.startsWith('Text on panels')));
  assert.deepEqual(T.contrastWarnings(T.presetById('midnight').colors), []);
});

test('a theme file holds colours, accent and options only, and comes back the same', () => {
  const a = normalizeAppearance({ theme: 'custom', customBase: 'end', customColors: { bg: '#101020' }, accent: '#ff8a4c', rounded: false, font: 'pixel', sidebar: 'right', scale: 110, backgroundFile: 'background.png', backgroundVersion: 5 });
  const file = T.exportTheme(a);
  const text = JSON.stringify(file);
  assert.ok(!/background|path|\\\\|\//.test(text.replace(/#/g, '')), 'no picture and no paths in the file');
  assert.equal(file.format, 'junction-theme');
  const back = T.parseThemeFile(text);
  assert.equal(back.theme, 'custom'); assert.equal(back.customColors.bg, '#101020'); assert.equal(back.accent, '#ff8a4c');
  assert.equal(back.rounded, false); assert.equal(back.font, 'pixel'); assert.equal(back.sidebar, 'right'); assert.equal(back.scale, 110);
  const again = normalizeAppearance({ ...DEFAULT_APPEARANCE, ...back });
  assert.deepEqual(again.customColors, a.customColors);
  // a preset exports and imports as that preset
  assert.equal(T.parseThemeFile(JSON.stringify(T.exportTheme(normalizeAppearance({ theme: 'nether' })))).theme, 'nether');
});

test('importing a theme file validates it: bad values skipped, unknown keys ignored, junk refused', () => {
  const p = T.parseThemeFile(JSON.stringify({ format: 'junction-theme', theme: 'forest', accent: 'javascript:alert(1)', evil: { x: 1 }, options: { rounded: 'yes', scale: 9999, font: 'comic', sidebar: 'right', backgroundFile: '../../x.png', translucent: true } }));
  assert.equal(p.theme, 'forest');
  assert.equal(p.accent, undefined);
  assert.equal(p.rounded, undefined);
  assert.equal(p.scale, 125);
  assert.equal(p.font, undefined);
  assert.equal(p.sidebar, 'right');
  assert.equal(p.translucent, true);
  assert.ok(!('backgroundFile' in p) && !('evil' in p));
  const partial = T.parseThemeFile(JSON.stringify({ format: 'junction-theme', colors: { bg: '#010203', text: 'nonsense' } }));
  assert.equal(partial.theme, 'custom'); assert.equal(partial.customColors.bg, '#010203'); assert.equal(partial.customColors.text, T.presetById('midnight').colors.text);
  assert.throws(() => T.parseThemeFile('not json'), /not valid JSON/);
  assert.throws(() => T.parseThemeFile('{"hello":1}'), /not a Junction theme/);
  assert.throws(() => T.parseThemeFile('[]'), /not a Junction theme/);
  assert.throws(() => T.parseThemeFile(JSON.stringify({ format: 'junction-theme', nothing: true })), /nothing Junction can use/);
  assert.throws(() => T.parseThemeFile(' '.repeat(40000)), /too big/);
});

test('the stylesheet only uses colour variables the theme engine or the stylesheet itself defines', () => {
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const k of Object.keys(T.cssVars(DEFAULT_APPEARANCE))) defined.add(k);
  for (const k of ['--bg-dim', '--sb', '--card-w', '--mk-bg', '--mk-sidebar', '--mk-panel', '--mk-border', '--mk-text', '--mk-muted', '--mk-faint', '--mk-accent']) defined.add(k);
  for (const m of css.matchAll(/var\((--[\w-]+)/g)) assert.ok(defined.has(m[1]), `${m[1]} is used but never set`);
});

test('no theme-sensitive colours are hardcoded in the stylesheet (shadows, overlays and masks aside)', () => {
  const body = css.replace(/:root \{[\s\S]*?\n\}/, '');
  const bad = [];
  body.split('\n').forEach((line, i) => {
    const cleaned = line.replace(/rgba\(\s*0\s*,\s*0\s*,\s*0[^)]*\)/g, '').replace(/rgba\(\s*255\s*,\s*255\s*,\s*255[^)]*\)/g, '').replace(/#000\b|#fff\b/gi, '');
    for (const m of cleaned.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)) bad.push(`${i + 1}: ${m[0]}`);
  });
  // overlays that dim whatever is behind them, the accent hover fallback and the dark ink on coloured avatars are deliberate
  const allowed = bad.filter((b) => !/rgba\(5,\s*6,\s*9|rgba\(5,\s*7,\s*10|#a3b4ff|#0b0d1/.test(b));
  assert.deepEqual(allowed, []);
});

test('the pixel heading font is open-licensed and shipped with its licence', () => {
  assert.ok(fs.existsSync(path.join(rdir, 'vendor', 'PixelifySans-700.woff2')));
  const lic = fs.readFileSync(path.join(rdir, 'vendor', 'LICENSE-PixelifySans.txt'), 'utf8');
  assert.match(lic, /SIL OPEN FONT LICENSE Version 1\.1/i);
  assert.match(css, /vendor\/PixelifySans-700\.woff2/);
  assert.ok(!/minecraft(ia)?\s*(regular|font)|mojangles/i.test(css), "never Mojang's font");
  const { readLicenses } = require('../src/core/licenses');
  assert.ok(readLicenses(path.join(__dirname, '..')).some((l) => /Pixelify/.test(l.name)), 'listed in Settings → About');
});

test('the page loads the theme script, and the Home card, paintbrush and Ctrl+K find Appearance', () => {
  const html = fs.readFileSync(path.join(rdir, 'index.html'), 'utf8');
  assert.ok(html.indexOf('themes.js') > html.indexOf('color.js') && html.indexOf('themes.js') < html.indexOf('appearance.js'));
  assert.match(html, /id="theme-btn"/);
  const qs = fs.readFileSync(path.join(rdir, 'quicksearch.js'), 'utf8');
  for (const w of ['theme', 'colour', 'color', 'background', 'dark', 'light', 'font']) assert.ok(new RegExp(`'${w}'`).test(qs.match(/act\('appearance'[^\n]*/)[0]), `Ctrl+K word ${w}`);
  assert.match(fs.readFileSync(path.join(rdir, 'home.js'), 'utf8'), /themeCardDismissed/);
});
