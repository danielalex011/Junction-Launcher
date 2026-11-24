'use strict';
// Themes: the preset colour sets, how a theme becomes CSS variables, and the theme file (export / import).
// Plain script that also loads in Node (like color.js), so the settings code and the tests share it. Shares one global scope with the other src/renderer files.

const JunctionThemes = (function themesModule() {
  const C = typeof JunctionColor !== 'undefined' ? JunctionColor : require('./color'); // eslint-disable-line no-undef

  /** The base colours a theme sets, in the order the editor shows them. */
  const COLOR_KEYS = [
    ['bg', 'App background'], ['sidebar', 'Sidebar'], ['panel', 'Panels and cards'], ['panel2', 'Menus and raised panels'], ['panel3', 'Highlights'],
    ['chip', 'Chips and tags'], ['border', 'Borders'], ['text', 'Text'], ['muted', 'Secondary text'], ['faint', 'Hints'],
  ];
  const KEYS = COLOR_KEYS.map(([k]) => k);

  const mk = (id, name, hint, v) => ({ id, name, hint, colors: Object.fromEntries(KEYS.map((k, i) => [k, v[i]])) });
  //                                bg         sidebar    panel      panel2     panel3     chip       border     text       muted      faint
  const PRESETS = [
    mk('midnight', 'Midnight', 'The default', ['#111317', '#171a20', '#171a20', '#1d2128', '#252a33', '#252a33', '#2a303a', '#e7e9ee', '#9aa3b2', '#6b7383']),
    mk('oled', 'OLED Black', 'Pure black', ['#000000', '#07080a', '#0a0b0d', '#111317', '#1a1d22', '#1a1d22', '#23272e', '#eceef2', '#9ea5b1', '#6a7180']),
    mk('slate', 'Slate', 'Soft blue-grey', ['#1a1f27', '#202630', '#202630', '#272e3a', '#313a49', '#313a49', '#38414f', '#e8ecf2', '#a3adbd', '#76819a']),
    mk('deepslate', 'Deepslate', 'Neutral stone grey', ['#17181a', '#1e1f22', '#1e1f22', '#26282b', '#313337', '#313337', '#3a3c41', '#e6e6e8', '#a0a2a8', '#727479']),
    mk('nether', 'Nether', 'Dark netherrack red', ['#1a0d0e', '#230f11', '#230f11', '#2d1416', '#3b1c1f', '#3b1c1f', '#4a2427', '#f3e4e2', '#c9a5a1', '#98736f']),
    mk('end', 'End', 'Deep purple', ['#0f0c18', '#151022', '#151022', '#1c162d', '#271f3d', '#271f3d', '#302749', '#ebe7f5', '#aca4c7', '#7b7397']),
    mk('ocean', 'Ocean', 'Deep sea blue', ['#0a141c', '#0f1c27', '#0f1c27', '#142636', '#1c3347', '#1c3347', '#234059', '#e3eef5', '#98b4c8', '#6a8ba5']),
    mk('forest', 'Forest', 'Dark green', ['#0f1611', '#151f18', '#151f18', '#1b281f', '#253628', '#253628', '#2c4032', '#e6efe8', '#a1b9a8', '#738e7b']),
    mk('cherry', 'Cherry', 'Dark rose', ['#1a1015', '#23151c', '#23151c', '#2d1b24', '#3b2530', '#3b2530', '#4a2d3a', '#f5e6ec', '#cca5b5', '#9b7584']),
    mk('light', 'Light', 'Bright and clean', ['#f3f4f7', '#ffffff', '#ffffff', '#f6f7fa', '#e8eaf0', '#e8eaf0', '#d6dae3', '#1a1d24', '#515968', '#7a8292']),
  ];
  const PRESET_IDS = PRESETS.map((p) => p.id);
  const presetById = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];

  const FONTS = ['default', 'system', 'pixel'];
  const MOTION = ['system', 'on', 'off'];

  const hexOf = (v) => { const c = C.parseHex(v); return c ? C.toHex(c) : null; };

  /** Takes whatever was saved or imported and returns a complete, valid colour set (anything missing or broken comes from `base`). */
  function normalizeColors(raw, base = 'midnight') {
    const from = presetById(base).colors;
    const src = raw && typeof raw === 'object' ? raw : {};
    return Object.fromEntries(KEYS.map((k) => [k, hexOf(src[k]) || from[k]]));
  }

  /** The colours and light/dark of the theme an appearance object asks for. */
  function resolve(a) {
    const colors = a && a.theme === 'custom' && a.customColors ? normalizeColors(a.customColors, a.customBase) : presetById(a && a.theme).colors;
    return { colors, light: C.luminance(colors.bg) > 0.35 };
  }

  const STATUS_DARK = { good: '#3ccf8e', warn: '#f2b84b', bad: '#f2676a', mr: '#1bd96a', cf: '#f16436', combo: '#c9a0ff', info: '#6fb8ff', orange: '#ffb86f' };
  const STATUS_LIGHT = { good: '#0c7a4d', warn: '#8a5a00', bad: '#c0262c', mr: '#0b7f3e', cf: '#bf4519', combo: '#7a3fd0', info: '#1767b0', orange: '#a05508' };

  /** Pushes a colour away from the surfaces (toward white on dark themes, black on light ones) until it reads at the given contrast on all of them. */
  function readable(hex, surfaces, light, min = 4.5) {
    let c = hexOf(hex) || '#888888';
    const worst = (x) => Math.min(...surfaces.map((s) => C.contrast(x, s)));
    for (let i = 0; i < 50 && worst(c) < min; i++) c = C.mix(c, light ? '#000000' : '#ffffff', 0.06);
    return c;
  }

  /** The accent as the interface uses it: readable as text on every surface, with matching ink and hover colours. */
  function accentFor(hex, colors, light) {
    const base = hexOf(hex) || '#8ea2ff';
    const surfaces = [colors.bg, colors.sidebar, colors.panel, colors.panel2, colors.panel3];
    const accent = readable(base, surfaces, light);
    const ink = C.readableInk(accent);
    const hover = ink === C.INK_DARK ? C.mix(accent, '#ffffff', 0.14) : C.mix(accent, '#000000', 0.14);
    return { accent, hover, ink, adjusted: accent !== base, ratio: C.contrast(accent, ink), onPanel: C.contrast(accent, colors.panel) };
  }

  /** Every CSS variable a theme + accent needs, as { '--name': value }. Cheap to call again after every change. */
  function cssVars(a) {
    const { colors: k, light } = resolve(a);
    const acc = accentFor(a && a.accent, k, light);
    const surfaces = [k.bg, k.sidebar, k.panel, k.panel2, k.panel3];
    const st = {};
    for (const [name, v] of Object.entries(light ? STATUS_LIGHT : STATUS_DARK)) st[name] = readable(v, surfaces, light);
    const font = a && a.font;
    return {
      '--bg': k.bg, '--sidebar': k.sidebar, '--panel': k.panel, '--panel-2': k.panel2, '--panel-3': k.panel3, '--chip': k.chip,
      // solid copies: a background picture or the translucent window makes the working variables see-through, menus and dialogs keep these
      '--t-bg': k.bg, '--t-sidebar': k.sidebar, '--t-panel': k.panel, '--t-panel-2': k.panel2, '--t-panel-3': k.panel3,
      '--border': k.border, '--border-hover': C.mix(k.border, k.text, 0.2), '--text': k.text, '--muted': k.muted, '--faint': k.faint,
      '--accent': acc.accent, '--accent-2': acc.accent, '--accent-hover': acc.hover, '--accent-ink': acc.ink,
      '--good': st.good, '--warn': st.warn, '--bad': st.bad, '--mr': st.mr, '--cf': st.cf, '--combo': st.combo, '--info': st.info, '--orange': st.orange,
      '--good-ink': C.readableInk(st.good), '--bad-ink': C.readableInk(st.bad),
      '--selection': C.mix(k.bg, acc.accent, light ? 0.3 : 0.45), '--scroll': k.panel3,
      '--log-bg': light ? k.panel2 : C.mix(k.bg, '#000000', 0.4),
      '--font-body': font === 'system' ? 'system-ui, sans-serif' : '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Inter", Roboto, sans-serif',
      '--font-head': font === 'pixel' ? '"Pixelify Sans", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' : 'inherit',
    };
  }

  /** A few ready colours for pages the theme can't reach (the sandboxed description frames). */
  function frameColors(a) {
    const { colors: k, light } = resolve(a);
    const v = cssVars(a);
    return { bg: k.panel, panel: k.panel2, panel3: k.panel3, code: light ? k.panel3 : C.mix(k.bg, '#000000', 0.35), border: k.border, text: k.text, muted: k.muted, faint: k.faint, accent: v['--accent'], good: v['--good'], light };
  }

  /** Contrast problems in a colour set, as plain sentences (empty when it is fine). */
  function contrastWarnings(colors) {
    const out = [];
    const check = (fg, bg, min, what) => { const r = C.contrast(colors[fg], colors[bg]); if (r < min) out.push(`${what} is hard to read (contrast ${r.toFixed(1)}:1, aim for at least ${min}:1).`); };
    check('text', 'bg', 4.5, 'Text on the app background');
    check('text', 'panel', 4.5, 'Text on panels and cards');
    check('text', 'panel2', 4.5, 'Text on menus and raised panels');
    check('text', 'panel3', 4.5, 'Text on highlights');
    check('muted', 'panel', 3, 'Secondary text on panels');
    check('muted', 'bg', 3, 'Secondary text on the app background');
    check('muted', 'panel3', 3, 'Secondary text on highlights');
    if (C.contrast(colors.border, colors.panel) < 1.15) out.push('Borders are almost invisible against the panels.');
    return out;
  }

  // ---- theme files
  const FILE_FORMAT = 'junction-theme';
  const MAX_FILE_BYTES = 32 * 1024;
  const OPTION_VALUES = {
    rounded: (v) => (typeof v === 'boolean' ? v : undefined),
    compact: (v) => (typeof v === 'boolean' ? v : undefined),
    translucent: (v) => (typeof v === 'boolean' ? v : undefined),
    sidebar: (v) => (v === 'left' || v === 'right' ? v : undefined),
    scale: (v) => (Number.isFinite(v) ? Math.min(125, Math.max(90, Math.round(v))) : undefined),
    font: (v) => (FONTS.includes(v) ? v : undefined),
    reduceMotion: (v) => (MOTION.includes(v) ? v : undefined),
  };

  /** What goes in a theme file: colours, accent and options only. No paths, no picture. */
  function exportTheme(a) {
    const { colors } = resolve(a);
    const options = {};
    for (const k of Object.keys(OPTION_VALUES)) if (a && a[k] !== undefined) options[k] = a[k];
    return { format: FILE_FORMAT, version: 1, theme: a && a.theme === 'custom' ? 'custom' : presetById(a && a.theme).id, colors, accent: hexOf(a && a.accent) || '#8ea2ff', options };
  }

  /**
   * Reads a theme file's text and returns the appearance settings it stands for ({ theme, customColors, accent, ...options }).
   * Unknown keys are ignored and bad values are skipped; a file that is not a theme at all throws a sentence for the person.
   */
  function parseThemeFile(text) {
    if (String(text).length > MAX_FILE_BYTES) throw new Error('That file is too big to be a Junction theme.');
    let raw;
    try { raw = JSON.parse(String(text)); } catch { throw new Error('That file is not a Junction theme (it is not valid JSON).'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.format !== FILE_FORMAT) throw new Error('That file is not a Junction theme.');
    const patch = {};
    const baseId = PRESET_IDS.includes(raw.theme) ? raw.theme : 'midnight';
    if (raw.colors && typeof raw.colors === 'object') {
      const colors = normalizeColors(raw.colors, baseId);
      const same = KEYS.every((k) => colors[k] === presetById(baseId).colors[k]);
      if (same && PRESET_IDS.includes(raw.theme)) patch.theme = baseId;
      else { patch.theme = 'custom'; patch.customColors = colors; patch.customBase = baseId; }
    } else if (PRESET_IDS.includes(raw.theme)) patch.theme = raw.theme;
    if (hexOf(raw.accent)) patch.accent = hexOf(raw.accent);
    const opts = raw.options && typeof raw.options === 'object' ? raw.options : {};
    for (const [k, clean] of Object.entries(OPTION_VALUES)) { const v = clean(opts[k]); if (v !== undefined) patch[k] = v; }
    if (!Object.keys(patch).length) throw new Error('That theme file has nothing Junction can use.');
    return patch;
  }

  return { COLOR_KEYS, KEYS, PRESETS, PRESET_IDS, presetById, FONTS, MOTION, normalizeColors, resolve, cssVars, accentFor, frameColors, contrastWarnings, exportTheme, parseThemeFile, readable };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = JunctionThemes;
