'use strict';
// Appearance settings (accent colour, background picture, corners, sidebar, interface size): defaults and cleaning.
// Plain Node. Whatever the renderer sends is cleaned here, so settings.json can never hold a broken value.

const T = require('../renderer/themes'); // the preset colours and the theme file rules live with the page that draws them; plain JS, shared here

const DEFAULT_APPEARANCE = Object.freeze({
  accent: '#8ea2ff',
  backgroundFile: null, // "background.png" etc. in <data>/appearance, set by the main process when the user picks a picture
  backgroundVersion: 0, // changes with each new picture so the page reloads it
  bgDim: 55, // % of darkening over the picture
  bgBlur: 4, // px
  rounded: true,
  sidebar: 'left', // 'left' | 'right'
  compact: false, // icons-only sidebar
  scale: 100, // % interface size
  theme: 'midnight', // a preset id from renderer/themes.js, or 'custom' (then customColors holds the colours)
  customColors: null, // { bg, sidebar, panel, panel2, panel3, chip, border, text, muted, faint } as #rrggbb
  customBase: 'midnight', // the preset "Customise" started from (fills in anything missing)
  font: 'default', // 'default' | 'system' | 'pixel' (pixel font for headings only)
  translucent: false, // Windows 11: let the window material (Mica) show through the panels
  reduceMotion: 'system', // 'system' follows the operating system | 'on' | 'off'
  themeCardDismissed: false, // the "Make Junction yours" card on Home
});

const BG_FILE = /^background\.(png|jpe?g|webp|gif)$/;
const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt; };

function normalizeHex(v, dflt) {
  const s = String(v || '').trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return dflt;
  let x = m[1].toLowerCase();
  if (x.length === 3) x = [...x].map((c) => c + c).join('');
  return `#${x}`;
}

function normalizeAppearance(a) {
  const d = DEFAULT_APPEARANCE;
  const v = a && typeof a === 'object' ? a : {};
  return {
    accent: normalizeHex(v.accent, d.accent),
    backgroundFile: typeof v.backgroundFile === 'string' && BG_FILE.test(v.backgroundFile) ? v.backgroundFile : null,
    backgroundVersion: Number.isFinite(Number(v.backgroundVersion)) ? Number(v.backgroundVersion) : 0,
    bgDim: num(v.bgDim, 0, 90, d.bgDim),
    bgBlur: num(v.bgBlur, 0, 24, d.bgBlur),
    rounded: v.rounded === undefined ? d.rounded : Boolean(v.rounded),
    sidebar: v.sidebar === 'right' ? 'right' : 'left',
    compact: Boolean(v.compact),
    scale: num(v.scale, 90, 125, d.scale),
    ...normalizeTheme(v),
    font: T.FONTS.includes(v.font) ? v.font : d.font,
    translucent: Boolean(v.translucent),
    reduceMotion: T.MOTION.includes(v.reduceMotion) ? v.reduceMotion : d.reduceMotion,
    themeCardDismissed: Boolean(v.themeCardDismissed),
  };
}

function normalizeTheme(v) {
  const customBase = T.PRESET_IDS.includes(v.customBase) ? v.customBase : 'midnight';
  const customColors = v.customColors && typeof v.customColors === 'object' ? T.normalizeColors(v.customColors, customBase) : null;
  const theme = T.PRESET_IDS.includes(v.theme) || (v.theme === 'custom' && customColors) ? v.theme : 'midnight';
  return { theme, customColors, customBase };
}

/** The window's own background colour for this look (so there is no flash of the wrong colour before the page loads). */
function windowBackground(a) { return T.resolve(normalizeAppearance(a)).colors.bg; }

module.exports = { DEFAULT_APPEARANCE, normalizeAppearance, normalizeHex, windowBackground, BG_FILE };
