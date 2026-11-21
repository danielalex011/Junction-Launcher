'use strict';
// Colour maths for the accent colour: contrast checks so text on accent buttons (and the accent as text) stays readable.
// Plain script that also loads in Node, so the tests can use it. Shares one global scope with the other src/renderer files.

const JunctionColor = (function colorModule() {
  const INK_DARK = '#0d1020';
  const INK_LIGHT = '#ffffff';
  const PANEL = '#171a20'; // the interface's panel colour: the accent is also used as text on it

  function parseHex(s) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s || '').trim());
    if (!m) return null;
    let x = m[1];
    if (x.length === 3) x = [...x].map((c) => c + c).join('');
    return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16) };
  }
  const toHex = ({ r, g, b }) => `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;
  const rgbOf = (c) => (typeof c === 'string' ? parseHex(c) : c);

  /** WCAG relative luminance. */
  function luminance(c) {
    const { r, g, b } = rgbOf(c);
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  /** WCAG contrast ratio, 1 to 21. */
  function contrast(a, b) {
    const la = luminance(a); const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function mix(a, b, t) {
    const x = rgbOf(a); const y = rgbOf(b);
    return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
  }
  /** The text colour (dark or white) that reads best on this background. */
  function readableInk(bg) { return contrast(bg, INK_DARK) >= contrast(bg, INK_LIGHT) ? INK_DARK : INK_LIGHT; }

  /** Lightens a too-dark accent until it reads as text on the dark panels (default 4.5:1, the WCAG AA level for body text). */
  function ensureOnDark(hex, min = 4.5, bg = PANEL) {
    let c = hex;
    for (let i = 0; i < 40 && contrast(c, bg) < min; i++) c = mix(c, '#ffffff', 0.06);
    return c;
  }

  /** Everything the interface needs from the one colour the user picked. */
  function accentVars(hex) {
    const base = parseHex(hex) ? toHex(parseHex(hex)) : '#8ea2ff';
    const accent = ensureOnDark(base);
    const ink = readableInk(accent);
    const hover = ink === INK_DARK ? mix(accent, '#ffffff', 0.14) : mix(accent, '#000000', 0.14);
    return { accent, hover, ink, lightened: accent !== base, ratio: contrast(accent, ink), onPanel: contrast(accent, PANEL) };
  }

  return { parseHex, toHex, luminance, contrast, mix, readableInk, ensureOnDark, accentVars, INK_DARK, INK_LIGHT, PANEL };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = JunctionColor;
