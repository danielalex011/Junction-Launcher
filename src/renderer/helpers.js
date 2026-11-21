'use strict';
/* Junction UI — plain DOM, no framework. All API data is inserted with
   textContent (never innerHTML), and project descriptions are shown in a
   sandboxed iframe with scripts disabled. */

const { call, on } = window.junction;

// ---------------------------------------------------------------- helpers
const ICONS = {
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  home: '<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  more: '<circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/><circle cx="5" cy="12" r="1.4"/>',
  pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>',
  arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>',
  arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  puzzle: '<path d="M19.4 12.6V8.2a1 1 0 0 0-1-1h-3.6a2.4 2.4 0 1 0-4.6 0H6.2a1 1 0 0 0-1 1v3.6a2.4 2.4 0 1 1 0 4.6V20a1 1 0 0 0 1 1h4a2.4 2.4 0 1 1 4.6 0h3.6a1 1 0 0 0 1-1v-4.4a2.4 2.4 0 1 1 0-3z"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  undo: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  pack: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22" x2="12" y2="12"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  shirt: '<path d="M20.38 3.46L16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
};

function icon(name, size = 16) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return s;
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

// Conditional children are written as `cond ? el : null`; skip those instead of rendering the text "null".
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const name of ['replaceChildren', 'append', 'prepend']) {
    const orig = proto[name];
    proto[name] = function patched(...kids) { return orig.apply(this, kids.filter((k) => k !== null && k !== undefined && k !== false)); };
  }
}

const $ = (sel, root = document) => root.querySelector(sel);
const view = () => $('#view');

function fmtNum(n) {
  if (n === null || n === undefined) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
function ago(ts) {
  if (!ts) return 'never';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [sec, u] of units) if (s >= sec) { const n = Math.floor(s / sec); return `${n} ${u}${n > 1 ? 's' : ''} ago`; }
  return 'just now';
}
function fmtDuration(ms) {
  const m = Math.round((ms || 0) / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
function hashColor(s) {
  let x = 0;
  for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  const hues = [210, 160, 40, 280, 0, 120, 190, 330];
  return `hsl(${hues[x % hues.length]} 70% 68%)`;
}

const LOADER = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const TYPES = { mod: 'Mods', modpack: 'Modpacks', resourcepack: 'Resource packs', shader: 'Shaders', datapack: 'Data packs' };
const SRC = { modrinth: 'Modrinth', curseforge: 'CurseForge', local: 'Local', pack: 'Pack', file: 'File' };

function avatar(item, size = '') {
  const src = item.iconSrc || item.icon;
  const url = src && /^((https|junction-icon|junction-skin):\/\/|data:image\/(png|jpeg|gif|webp);base64,)/.test(src) ? src : null;
  const label = (item.name || item.title || '?').trim();
  if (url) {
    const img = h('img', { class: `avatar ${size}`, src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(h('div', { class: `avatar ${size}`, style: { background: hashColor(label) } }, label[0]?.toUpperCase())));
    return img;
  }
  return h('div', { class: `avatar ${size}`, style: { background: hashColor(label) } }, label[0]?.toUpperCase() || '?');
}

function sourceBadge(source, url) {
  return h('span', {
    class: `badge src-${source}${url ? ' clickable' : ''}`,
    title: url ? `Open on ${SRC[source] || source}` : source === 'pack' ? 'Shipped inside the modpack' : null,
    onclick: url ? (e) => { e.stopPropagation(); call('shell:open', url); } : null,
  }, SRC[source] || source);
}

function instSubtitle(inst) {
  const l = inst.loader || { type: 'vanilla' };
  const lv = l.type !== 'vanilla' && l.version ? ` ${l.version}` : '';
  return `${LOADER[l.type] || l.type}${lv} · Minecraft ${inst.mcVersion}`;
}

// ---------------------------------------------------------------- "already installed" detection
function matchKey(s) {
  return String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
}

/** Is this search hit already in the instance? Checks project ids on both sites, then title / mod id. */
function installedMatch(hit, installed) {
  if (!installed) return null;
  const refs = [hit, ...(hit.alsoOn || [])];
  for (const r of refs) {
    const m = installed.projects[`${r.source}:${r.id}`];
    if (m) return { ...m, source: r.source, projectId: r.id, exact: true };
  }
  const titles = new Set(installed.titles);
  const modIds = new Set(installed.modIds);
  if (titles.has(matchKey(hit.title))) return { exact: false };
  if (refs.some((r) => r.slug && modIds.has(matchKey(r.slug)))) return { exact: false };
  return null;
}
