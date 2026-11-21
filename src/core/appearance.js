'use strict';
// Appearance settings (accent colour, background picture, corners, sidebar, interface size): defaults and cleaning.
// Plain Node. Whatever the renderer sends is cleaned here, so settings.json can never hold a broken value.

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
  };
}

module.exports = { DEFAULT_APPEARANCE, normalizeAppearance, normalizeHex, BG_FILE };
