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
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
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
const TYPES = { mod: 'Mods', modpack: 'Modpacks', resourcepack: 'Resource packs', shader: 'Shaders' };
const SRC = { modrinth: 'Modrinth', curseforge: 'CurseForge', local: 'Local', file: 'File' };

function avatar(item, size = '') {
  const src = item.iconSrc || item.icon;
  const url = src && /^((https|junction-icon):\/\/|data:image\/(png|jpeg|gif|webp);base64,)/.test(src) ? src : null;
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
    title: url ? `Open on ${SRC[source] || source}` : null,
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

// ---------------------------------------------------------------- toasts, modals, menus
function toast(msg, type = 'info', ms = 4500) {
  const t = h('div', { class: `toast ${type}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? Math.max(ms, 8000) : ms);
}

function modal({ title, body, actions = [], wide = false, onClose, headExtra }) {
  const root = $('#modal-root');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const foot = actions.length ? h('div', { class: 'm-foot' }, actions.map((a) => {
    const b = h('button', { class: `btn ${a.class || ''}`, type: 'button', disabled: a.disabled }, a.icon ? icon(a.icon) : null, a.label);
    b.addEventListener('click', async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try {
        const keep = await a.onClick(b);
        if (keep !== true) close();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        if (!closed) b.disabled = false;
      }
    });
    return b;
  })) : null;
  const m = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog' },
    h('div', { class: 'm-head' }, headExtra || null, h('h2', null, title), h('button', { class: 'btn ghost icon', type: 'button', onclick: close, title: 'Close' }, icon('x'))),
    h('div', { class: 'm-body' }, body),
    foot);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, m);
  root.append(overlay);
  document.addEventListener('keydown', onKey);
  return { close, el: m, body: $('.m-body', m) };
}

function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title,
      body: h('p', { style: { margin: 0, lineHeight: 1.5 } }, text),
      actions: [
        { label: 'Cancel', class: 'ghost', onClick: () => { answered = true; resolve(false); } },
        { label: okLabel, class: danger ? 'danger solid' : 'primary', onClick: () => { answered = true; resolve(true); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

function popupMenu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu' }, items.map((it) => (it === '-' ? h('hr') : h('button', {
    type: 'button', class: it.danger ? 'danger' : '', onclick: () => { menu.remove(); it.onClick(); },
  }, it.icon ? icon(it.icon) : null, it.label))));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const leftEdge = r.left + r.width / 2 < window.innerWidth / 2 ? r.left : r.right - mw; // open toward the middle of the window
  menu.style.left = `${Math.max(8, Math.min(leftEdge, window.innerWidth - mw - 8))}px`;
  menu.style.top = `${r.bottom + mh + 6 > window.innerHeight ? r.top - mh - 6 : r.bottom + 6}px`;
  setTimeout(() => document.addEventListener('mousedown', function off(e) {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off); }
  }), 0);
}

function loading(text = 'Loading…') {
  return h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text);
}

function select(options, value, onchange, attrs = {}) {
  const s = h('select', { ...attrs, onchange: (e) => onchange && onchange(e.target.value) },
    options.map((o) => (typeof o === 'string' ? h('option', { value: o }, o) : h('option', { value: o.value }, o.label))));
  s.value = value ?? '';
  return s;
}

// ---------------------------------------------------------------- state
const state = {
  view: 'library',
  params: {},
  info: null,
  settings: null,
  tasks: new Map(),
  running: new Map(),
  mcVersions: null,
  logListeners: new Map(),
};

async function loadMcVersions(snapshots = false) {
  if (!snapshots && state.mcVersions) return state.mcVersions;
  const list = await call('mc:versions', { snapshots });
  if (!snapshots) state.mcVersions = list;
  return list;
}

// ---------------------------------------------------------------- navigation
const NAV = [
  { id: 'library', label: 'Library', icon: 'grid' },
  { id: 'browse', label: 'Browse', icon: 'compass' },
  { id: 'accounts', label: 'Accounts', icon: 'user' },
  { id: 'settings', label: 'Settings', icon: 'sliders' },
];

function renderNav() {
  const nav = $('#nav');
  nav.replaceChildren(...NAV.map((n) => h('button', {
    class: `nav-btn ${state.view === n.id || (n.id === 'library' && state.view === 'instance') ? 'active' : ''}`,
    type: 'button',
    onclick: () => go(n.id),
  }, icon(n.icon, 18), n.label)));
}

let renderToken = 0;
async function go(viewName, params = {}) {
  state.view = viewName;
  state.params = params;
  renderNav();
  const token = ++renderToken;
  view().scrollTop = 0;
  const pages = { library: renderLibrary, instance: renderInstance, browse: renderBrowse, accounts: renderAccounts, settings: renderSettings };
  try {
    await pages[viewName](params, token);
  } catch (e) {
    if (token === renderToken) view().replaceChildren(h('div', { class: 'page' }, h('div', { class: 'notice warn' }, icon('alert'), e.message)));
  }
}
const stale = (token) => token !== renderToken;

// ---------------------------------------------------------------- tasks sidebar
function renderTasks() {
  const box = $('#tasks');
  const items = [...state.tasks.values()].filter((t) => t.status !== 'done' || Date.now() - (t.finished || 0) < 4000).slice(-5);
  box.replaceChildren(...items.map((t) => {
    const indeterminate = t.status === 'running' && (t.progress === null || t.progress === undefined);
    return h('div', { class: `task ${t.status}` },
      h('div', { class: 't-title' }, h('span', { class: 'ellipsis' }, t.title),
        t.status === 'error' ? h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Dismiss', onclick: () => { state.tasks.delete(t.id); renderTasks(); } }, icon('x', 12)) : null),
      h('div', { class: 't-detail', title: t.error || t.detail || '' }, t.status === 'error' ? t.error : (t.status === 'done' ? 'Done' : t.detail || 'Working…')),
      t.status === 'running' ? h('div', { class: `bar ${indeterminate ? 'indeterminate' : ''}` }, h('i', { style: { width: `${Math.round((t.progress || 0) * 100)}%` } })) : null);
  }));
}

on('task:update', (t) => {
  if (t.status === 'done') t.finished = Date.now();
  state.tasks.set(t.id, t);
  renderTasks();
  if (t.status === 'done') setTimeout(renderTasks, 4200);
});

// ---------------------------------------------------------------- account chip
async function renderAccountChip() {
  const chip = $('#account-chip');
  try {
    const { accounts } = await call('accounts:list');
    const active = accounts.find((a) => a.active);
    chip.replaceChildren(
      active ? avatar({ name: active.name }, 'xs') : h('div', { class: 'avatar xs', style: { background: 'var(--panel-3)', color: 'var(--muted)' } }, icon('user', 14)),
      h('div', { class: 'grow' },
        h('div', { class: 'a-name ellipsis' }, active ? active.name : 'No account'),
        h('div', { class: 'a-sub' }, active ? (active.type === 'msa' ? 'Microsoft' : 'Offline') : 'Click to add one')),
    );
  } catch { /* ignore */ }
  chip.onclick = () => go('accounts');
}

// ---------------------------------------------------------------- launching
async function play(inst) {
  try {
    await call('inst:launch', inst.id);
  } catch (e) {
    if (e.code === 'NO_ACCOUNT') {
      const ok = await confirmDialog('Add an account first', 'You need a Microsoft account that owns Minecraft to play.', 'Go to Accounts');
      if (ok) go('accounts');
    } else if (e.code === 'NO_CLIENT_ID') {
      toast(e.message, 'error');
      go('settings');
    } else {
      toast(e.message, 'error');
    }
  }
}

function playButton(inst, size = '') {
  const st = state.running.get(inst.id) || inst.state;
  if (st === 'preparing') return h('button', { class: `btn ${size}`, type: 'button', disabled: true }, h('div', { class: 'spinner' }), 'Preparing');
  if (st === 'running') {
    return h('button', { class: `btn danger ${size}`, type: 'button', onclick: (e) => { e.stopPropagation(); call('inst:kill', inst.id); } }, icon('stop'), 'Stop');
  }
  return h('button', { class: `btn good ${size}`, type: 'button', onclick: (e) => { e.stopPropagation(); play(inst); } }, icon('play'), 'Play');
}

on('inst:state', ({ id, state: st, exit, error }) => {
  if (st) state.running.set(id, st); else state.running.delete(id);
  if (exit && exit.code !== 0 && exit.code !== null) {
    toast(`Minecraft exited with code ${exit.code}.${exit.crashReport ? ' A crash report was written — see the Logs tab.' : ''}`, 'error');
  }
  if (error && !/already running/.test(error)) { /* already toasted by caller */ }
  if (state.view === 'library') go('library');
  if (state.view === 'instance' && state.params.id === id) refreshInstanceHeader();
});

on('inst:log', ({ id, lines }) => {
  const fn = state.logListeners.get(id);
  if (fn) fn(lines);
});

// ---------------------------------------------------------------- library
async function renderLibrary(_p, token) {
  const list = await call('inst:list');
  if (stale(token)) return;
  for (const i of list) if (i.state) state.running.set(i.id, i.state);
  const head = h('div', { class: 'page-head' },
    h('h1', null, 'Library'),
    h('button', { class: 'btn', type: 'button', onclick: (e) => importMenu(e.currentTarget) }, icon('login'), 'Import'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => newInstanceDialog() }, icon('plus'), 'New instance'));
  let body;
  if (!list.length) {
    body = h('div', { class: 'empty' },
      h('h2', null, 'No instances yet'),
      h('div', null, 'Make your own, install a modpack from Modrinth or CurseForge, or bring instances over from another launcher.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary lg', type: 'button', onclick: () => newInstanceDialog() }, icon('plus'), 'Create an instance'),
        h('button', { class: 'btn lg', type: 'button', onclick: () => go('browse', { type: 'modpack' }) }, icon('box'), 'Browse modpacks'),
        h('button', { class: 'btn lg', type: 'button', onclick: () => importFromLaunchers() }, icon('login'), 'Import from another launcher')));
  } else {
    body = h('div', { class: 'grid' }, list.map((inst) => h('div', { class: 'card', onclick: () => go('instance', { id: inst.id }) },
      h('div', { class: 'c-top' }, avatar(inst),
        h('div', { class: 'grow' },
          h('div', { class: 'c-name ellipsis', title: inst.name }, inst.name),
          h('div', { class: 'c-sub ellipsis' }, instSubtitle(inst)))),
      h('div', { class: 'c-foot' },
        h('span', { class: 'row' }, state.running.get(inst.id) === 'running' ? h('span', { class: 'state-dot' }) : null,
          inst.pack ? sourceBadge(inst.pack.source === 'file' ? 'file' : inst.pack.source) : null,
          h('span', null, inst.lastPlayed ? `Played ${ago(inst.lastPlayed)}` : 'Never played')),
        playButton(inst, 'sm')))));
  }
  view().replaceChildren(h('div', { class: 'page' }, head, body));
}

function importMenu(anchor) {
  popupMenu(anchor, [
    { label: 'Modpack file (.mrpack / CurseForge .zip)', icon: 'file', onClick: () => importPackFile() },
    { label: 'Instances from other launchers…', icon: 'folder', onClick: () => importFromLaunchers() },
  ]);
}

async function handleInstallResult(r, instId) {
  if (!r) return;
  const n = r.installed?.length || 0;
  const deps = Math.max(0, n - 1);
  if (r.instance && !instId) toast(`Installed ${r.instance.name}`, 'good');
  else if (n) toast(`Installed ${r.installed[0].title}${deps ? ` + ${deps} dependenc${deps > 1 ? 'ies' : 'y'}` : ''}`, 'good');
  else if (r.skipped?.length && !r.blocked?.length) toast(`${r.skipped[0].title}: ${r.skipped[0].reason}`, 'info');
  for (const w of (r.warnings || []).slice(0, 4)) toast(w, 'warn', 7000);
  if (r.blockedSession) blockedDialog(r.blockedSession, instId || r.instance?.id);
}

async function importPackFile(filePath) {
  try {
    const r = await call('pack:importFile', filePath || null);
    if (!r) return;
    await handleInstallResult(r);
    go('instance', { id: r.instance.id });
  } catch (e) { toast(e.message, 'error'); }
}

// ---------------------------------------------------------------- new instance dialog
async function newInstanceDialog(preset = {}) {
  let snapshots = Boolean(state.settings?.showSnapshots);
  let versions = await loadMcVersions(snapshots);
  let loader = preset.loader || 'fabric';
  let mc = preset.mcVersion || versions[0]?.id;
  let loaderVersion = null;
  let nameTouched = false;
  const nameInput = h('input', { type: 'text', placeholder: 'Instance name', oninput: () => { nameTouched = true; } });
  const autoName = () => { if (!nameTouched) nameInput.value = `${LOADER[loader]} ${mc}`; };
  const mcSelectWrap = h('div');
  const loaderVerWrap = h('div');
  const status = h('div', { class: 'hint' });

  const renderMcSelect = () => {
    mcSelectWrap.replaceChildren(select(versions.map((v) => ({ value: v.id, label: v.type === 'release' ? v.id : `${v.id} (${v.type})` })), mc, (v) => { mc = v; autoName(); loadLoaderVersions(); }));
  };
  async function loadLoaderVersions() {
    loaderVersion = null;
    if (loader === 'vanilla') { loaderVerWrap.replaceChildren(h('div', { class: 'hint' }, 'No mod loader — plain Minecraft.')); status.textContent = ''; return; }
    loaderVerWrap.replaceChildren(loading('Fetching versions…'));
    try {
      const { list, default: def } = await call('loader:versions', loader, mc);
      if (!list.length) {
        loaderVerWrap.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), `${LOADER[loader]} isn't available for Minecraft ${mc}.`));
        return;
      }
      loaderVersion = def;
      loaderVerWrap.replaceChildren(select(list.map((v) => ({ value: v.version, label: `${v.version}${v.recommended ? '  (recommended)' : ''}${!v.stable ? '  (beta)' : ''}` })), def, (v) => { loaderVersion = v; }));
    } catch (e) {
      loaderVerWrap.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), e.message));
    }
  }
  const seg = h('div', { class: 'seg' }, Object.entries(LOADER).map(([k, label]) => h('button', {
    type: 'button', class: k === loader ? 'on' : '', onclick: (e) => {
      loader = k;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
      autoName();
      loadLoaderVersions();
    },
  }, label)));
  const snapToggle = h('label', { class: 'check small muted' }, h('input', {
    type: 'checkbox', checked: snapshots, onchange: async (e) => {
      snapshots = e.target.checked;
      versions = await loadMcVersions(snapshots);
      if (!versions.find((v) => v.id === mc)) mc = versions[0]?.id;
      renderMcSelect();
    },
  }), 'Show snapshots');

  renderMcSelect();
  autoName();
  loadLoaderVersions();
  modal({
    title: 'New instance',
    body: [
      h('label', { class: 'field' }, 'Name', nameInput),
      h('div', { class: 'field' }, h('span', { class: 'small muted', style: { fontWeight: 600 } }, 'Mod loader'), seg),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', { class: 'row' }, h('span', { class: 'grow' }, 'Minecraft version'), snapToggle), mcSelectWrap),
        h('label', { class: 'field' }, 'Loader version', loaderVerWrap)),
      status,
      h('div', { class: 'hint' }, 'Tip: you can also start from a modpack in Browse → Modpacks, then add or remove mods freely.'),
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      {
        label: 'Create', class: 'primary', icon: 'plus', onClick: async () => {
          if (loader !== 'vanilla' && !loaderVersion) throw new Error('Pick a loader version first');
          const inst = await call('inst:create', { name: nameInput.value.trim(), mcVersion: mc, loader: loader === 'vanilla' ? { type: 'vanilla' } : { type: loader, version: loaderVersion } });
          toast(`Created ${inst.name}`, 'good');
          go('instance', { id: inst.id });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- import from another launcher
async function importFromLaunchers() {
  const listBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, loading('Looking for instances in Modrinth App, CurseForge, Prism and the Minecraft Launcher…'));
  const selected = new Map();
  let busy = false;
  const m = modal({
    title: 'Import from other launchers',
    body: [
      h('div', { class: 'hint' }, 'Files are copied into Junction, so your other launcher keeps working exactly as before. Mods are matched against Modrinth and CurseForge so they can be updated from here.'),
      listBox,
    ],
    actions: [
      { label: 'Browse for a folder…', class: 'ghost', icon: 'folder', onClick: () => { setTimeout(() => importFolderDialog(), 0); } },
      { label: 'Import selected', class: 'primary', icon: 'download', disabled: true, onClick: async (btn) => { await runImport(btn); return busy; } },
    ],
    onClose: () => { /* imports already started keep running in the task panel */ },
  });
  m.el.style.width = 'min(760px, 100%)';
  const importBtn = m.el.querySelectorAll('.m-foot .btn')[1];
  const refreshBtn = () => {
    importBtn.disabled = busy || selected.size === 0;
    importBtn.replaceChildren(icon('download'), selected.size ? `Import ${selected.size} instance${selected.size > 1 ? 's' : ''}` : 'Import selected');
  };

  async function runImport() {
    busy = true;
    const items = [...selected.values()];
    let ok = 0;
    for (let i = 0; i < items.length; i++) {
      const info = items[i];
      importBtn.replaceChildren(h('div', { class: 'spinner' }), `Importing ${i + 1} of ${items.length}…`);
      try {
        await call('import:run', info, { name: info.name, mcVersion: info.mcVersion, loader: info.loader, loaderVersion: info.loaderVersion });
        ok++;
      } catch (e) {
        toast(`${info.name}: ${e.message}`, 'error');
      }
    }
    busy = false;
    toast(`Imported ${ok} of ${items.length} instance${items.length > 1 ? 's' : ''}`, ok ? 'good' : 'error');
    m.close();
    go('library');
  }

  let found;
  let notes = [];
  try {
    ({ instances: found, notes } = await call('import:scan'));
  } catch (e) {
    listBox.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), e.message));
    return;
  }
  if (!found.length) {
    listBox.replaceChildren(h('div', { class: 'empty', style: { padding: '36px 20px' } },
      h('h2', null, 'No instances found'),
      h('div', null, 'Nothing in the usual Modrinth App, CurseForge, Prism or Minecraft Launcher folders. If you moved them, use “Browse for a folder…”.')));
    return;
  }
  const groups = new Map();
  for (const f of found) {
    if (!groups.has(f.launcher)) groups.set(f.launcher, []);
    groups.get(f.launcher).push(f);
  }
  const rows = [];
  listBox.replaceChildren(...notes.map((n) => h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), h('div', { class: 'small' }, n))), ...[...groups.entries()].map(([launcher, list]) => {
    const newOnes = list.filter((f) => f.mcVersion && !f.alreadyImported);
    const selAll = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => {
      const allOn = newOnes.every((f) => selected.has(f.folder));
      for (const f of newOnes) { if (allOn) selected.delete(f.folder); else selected.set(f.folder, f); }
      for (const r of rows) r();
      refreshBtn();
    } }, 'Select all new');
    return h('div', null,
      h('div', { class: 'row', style: { marginBottom: '6px' } }, h('b', { class: 'grow' }, `${launcher}`, h('span', { class: 'muted small' }, ` · ${list.length} found`)), newOnes.length > 1 ? selAll : null),
      h('div', { class: 'list' }, list.map((f) => {
        const box = h('input', { type: 'checkbox', disabled: !f.mcVersion, onchange: (e) => { if (e.target.checked) selected.set(f.folder, f); else selected.delete(f.folder); refreshBtn(); } });
        rows.push(() => { box.checked = selected.has(f.folder); });
        const loaderTxt = f.loader && f.loader !== 'vanilla' ? `${LOADER[f.loader] || f.loader}${f.loaderVersion ? ` ${f.loaderVersion}` : ''}` : (f.loader === 'vanilla' ? 'Vanilla' : 'Unknown loader');
        return h('label', { class: 'item', style: { gridTemplateColumns: '22px 34px 1fr auto', cursor: f.mcVersion ? 'pointer' : 'default' } },
          box,
          avatar({ name: f.name, iconSrc: f.preview }, 'sm'),
          h('div', { style: { minWidth: 0 } },
            h('div', { class: 'i-title ellipsis', title: f.folder }, f.name),
            h('div', { class: 'i-file ellipsis' }, `${loaderTxt} · ${f.mcVersion ? `Minecraft ${f.mcVersion}` : 'version unknown'} · ${f.modCount} mod${f.modCount === 1 ? '' : 's'}`,
              f.mcVersion && f.detectedBy === 'name' ? h('span', { style: { color: 'var(--warn)' } }, ' · guessed from the name, check with Edit…') : null)),
          h('div', { class: 'row' },
            f.alreadyImported ? h('span', { class: 'badge plain', title: 'You imported this before. Importing again makes a second copy.' }, 'Already imported') : null,
            h('button', { class: `btn sm ${f.mcVersion ? 'ghost' : ''}`, type: 'button', onclick: (e) => { e.preventDefault(); e.stopPropagation(); m.close(); importFolderDialog(f); } }, f.mcVersion ? 'Edit…' : 'Set version…')));
      })));
  }));
  refreshBtn();
}

async function importFolderDialog(preset = null) {
  let info = preset;
  if (!info) {
    try {
      info = await call('import:pickFolder');
    } catch (e) { toast(e.message, 'error'); return; }
  }
  if (!info) return;
  const versions = await loadMcVersions(true);
  let mc = info.mcVersion || '';
  let loader = info.loader || 'vanilla';
  let loaderVersion = info.loaderVersion || null;
  const name = h('input', { type: 'text', value: info.name });
  const lvWrap = h('div');
  async function loadLv() {
    if (loader === 'vanilla' || !mc) { lvWrap.replaceChildren(h('div', { class: 'hint' }, loader === 'vanilla' ? 'No loader' : 'Pick a Minecraft version')); return; }
    lvWrap.replaceChildren(loading());
    try {
      const { list, default: def } = await call('loader:versions', loader, mc);
      if (!list.find((v) => v.version === loaderVersion)) loaderVersion = def;
      lvWrap.replaceChildren(select(list.map((v) => ({ value: v.version, label: v.version })), loaderVersion, (v) => { loaderVersion = v; }));
    } catch (e) { lvWrap.replaceChildren(h('div', { class: 'hint' }, e.message)); }
  }
  const mcSel = select([{ value: '', label: '— pick —' }, ...versions.map((v) => ({ value: v.id, label: v.id }))], mc, (v) => { mc = v; loadLv(); });
  const loaderSel = select(Object.entries(LOADER).map(([k, l]) => ({ value: k, label: l })), loader, (v) => { loader = v; loadLv(); });
  loadLv();
  modal({
    title: 'Import instance',
    body: [
      h('div', { class: 'notice info' }, icon('info'), h('div', null,
        h('div', null, `From: ${info.from}`),
        h('div', { class: 'hint' }, `${info.modCount} files in mods · ${info.gameDir}`))),
      h('label', { class: 'field' }, 'Name', name),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Minecraft version', mcSel),
        h('label', { class: 'field' }, 'Loader', loaderSel),
        h('label', { class: 'field' }, 'Loader version', lvWrap)),
      h('div', { class: 'hint' }, 'Files are copied (your original folder is left untouched). Mods are then matched against Modrinth and CurseForge so they can be updated from here.'),
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      {
        label: 'Import', class: 'primary', onClick: async () => {
          if (!mc) throw new Error('Pick the Minecraft version');
          const r = await call('import:run', info, { name: name.value.trim(), mcVersion: mc, loader, loaderVersion });
          toast(`Imported ${r.instance.name} — recognised ${r.identified} of ${r.total} files`, 'good');
          go('instance', { id: r.instance.id });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- instance page
let currentInstance = null;
async function refreshInstanceHeader() {
  if (state.view !== 'instance') return;
  const slot = $('#inst-play');
  if (!slot || !currentInstance) return;
  slot.replaceChildren(playButton(currentInstance, 'lg'));
}

async function renderInstance({ id, tab = 'mod' }, token) {
  const inst = await call('inst:get', id);
  if (stale(token)) return;
  currentInstance = inst;
  if (inst.state) state.running.set(id, inst.state);
  const tabs = [
    { id: 'mod', label: 'Mods', icon: 'box', hide: inst.loader?.type === 'vanilla' },
    { id: 'resourcepack', label: 'Resource packs', icon: 'grid' },
    { id: 'shader', label: 'Shaders', icon: 'compass' },
    { id: 'logs', label: 'Logs', icon: 'terminal' },
    { id: 'settings', label: 'Settings', icon: 'sliders' },
  ].filter((t) => !t.hide);
  const activeTab = tabs.find((t) => t.id === tab) ? tab : tabs[0].id;
  const content = h('div');
  const iconBtn = h('button', {
    class: 'avatar-edit', type: 'button', title: 'Change picture (or drop an image here)',
    onclick: (e) => iconMenu(e.currentTarget, inst),
  }, avatar(inst, 'lg'), h('span', { class: 'avatar-edit-hint' }, 'Change'));
  const head = h('div', { class: 'inst-head' },
    iconBtn,
    h('div', { class: 'grow' },
      h('h1', { class: 'ellipsis' }, inst.name),
      h('div', { class: 'muted', style: { marginTop: '4px' } }, instSubtitle(inst)),
      h('div', { class: 'row small faint', style: { marginTop: '6px' } },
        inst.pack ? sourceBadge(inst.pack.source === 'file' ? 'file' : inst.pack.source, inst.pack.url) : null,
        inst.pack ? h('span', null, `${inst.pack.name} ${inst.pack.versionName || ''}`) : null,
        h('span', null, `Played ${fmtDuration(inst.playtimeMs)} · last ${ago(inst.lastPlayed)}`))),
    h('button', { class: 'btn icon', type: 'button', title: 'Open folder', onclick: () => call('inst:openFolder', id) }, icon('folder', 18)),
    h('button', { class: 'btn icon', type: 'button', title: 'More', onclick: (e) => instanceMenu(e.currentTarget, inst) }, icon('more', 18)),
    h('span', { id: 'inst-play' }, playButton(inst, 'lg')));
  const tabBar = h('div', { class: 'tabs' }, tabs.map((t) => h('button', {
    type: 'button', class: t.id === activeTab ? 'on' : '', onclick: () => go('instance', { id, tab: t.id }),
  }, icon(t.icon), t.label)));
  const back = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => go('library'), style: { marginBottom: '12px' } }, icon('arrowLeft'), 'Library');
  view().replaceChildren(h('div', { class: 'page' }, back, head, tabBar, content));
  if (['mod', 'resourcepack', 'shader'].includes(activeTab)) await renderContentTab(inst, activeTab, content, token);
  else if (activeTab === 'logs') await renderLogsTab(inst, content);
  else await renderInstSettings(inst, content);
}

async function changeIcon(inst, filePath) {
  try {
    const r = filePath ? await call('inst:setIcon', inst.id, filePath) : await call('inst:pickIcon', inst.id);
    if (!r) return;
    toast('Picture updated', 'good');
    if (state.view === 'instance' && state.params.id === inst.id) go('instance', state.params);
    else if (state.view === 'library') go('library');
  } catch (e) { toast(e.message, 'error'); }
}

function iconMenu(anchor, inst) {
  const custom = typeof inst.icon === 'string' && inst.icon.startsWith('local:');
  popupMenu(anchor, [
    { label: 'Choose a picture…', icon: 'file', onClick: () => changeIcon(inst) },
    ...(custom ? [{ label: inst.originalIcon ? 'Back to the modpack\'s picture' : 'Remove picture', icon: 'x', onClick: async () => {
      await call('inst:clearIcon', inst.id);
      go('instance', state.params);
    } }] : []),
  ]);
}

function instanceMenu(anchor, inst) {
  const items = [
    { label: 'Change picture…', icon: 'file', onClick: () => changeIcon(inst) },
    '-',
    { label: 'Export as Modrinth pack (.mrpack)', icon: 'upload', onClick: () => exportDialog(inst, 'mrpack') },
    { label: 'Export as CurseForge pack (.zip)', icon: 'upload', onClick: () => exportDialog(inst, 'curseforge') },
  ];
  if (inst.pack && ['modrinth', 'curseforge'].includes(inst.pack.source)) {
    items.push('-', { label: 'Check for modpack update', icon: 'refresh', onClick: () => packUpdateFlow(inst) });
  }
  items.push('-',
    { label: 'Open mods folder', icon: 'folder', onClick: () => call('inst:openFolder', inst.id, 'mods') },
    { label: 'Duplicate', icon: 'copy', onClick: async () => { const c = await call('inst:duplicate', inst.id); toast(`Created ${c.name}`, 'good'); go('instance', { id: c.id }); } },
    { label: 'Delete instance', icon: 'trash', danger: true, onClick: async () => {
      if (!(await confirmDialog(`Delete ${inst.name}?`, 'This deletes the instance folder including worlds, configs and mods. This cannot be undone.', 'Delete', true))) return;
      try { await call('inst:delete', inst.id); toast(`Deleted ${inst.name}`); go('library'); } catch (e) { toast(e.message, 'error'); }
    } });
  popupMenu(anchor, items);
}

async function packUpdateFlow(inst) {
  try {
    const u = await call('pack:checkUpdate', inst.id);
    if (!u) { toast(`${inst.pack.name} is up to date`, 'good'); return; }
    const ok = await confirmDialog(`Update ${inst.pack.name}?`,
      `Version ${u.versionName} is available (you have ${inst.pack.versionName}). Mods from the pack will be replaced. Mods you added yourself stay, and your config folder is backed up first.`, 'Update');
    if (!ok) return;
    const r = await call('pack:update', inst.id, u.versionId);
    await handleInstallResult(r, inst.id);
    go('instance', { id: inst.id });
  } catch (e) { toast(e.message, 'error'); }
}

// ----- content tab
let contentKeyHandler = null;

function typeNoun(type, n) {
  const one = { mod: 'mod', resourcepack: 'resource pack', shader: 'shader' }[type] || 'file';
  return n === 1 ? one : `${one}s`;
}

async function renderContentTab(inst, type, root, token) {
  root.replaceChildren(loading());
  let items = await call('content:list', inst.id, type);
  if (stale(token)) return;
  let filter = '';
  let updates = new Map();
  let checked = false; // has "check for updates" run on this tab?
  const selected = new Set(); // file paths; stays put when a filter hides some of them
  let anchor = null; // last clicked row, for Shift+click ranges
  let rowEls = new Map();
  let shownFiles = [];
  let headBox = null;
  let busy = false;
  const listBox = h('div');
  const bar = h('div', { class: 'selbar' });
  const countLabel = h('span', { class: 'muted small' });
  const updateBtn = h('button', { class: 'btn', type: 'button' }, icon('refresh'), 'Check for updates');
  const updateAllBtn = h('button', { class: 'btn primary', type: 'button', style: { display: 'none' } }, icon('arrowUp'), 'Update all');
  const notices = h('div');

  const noun = (n) => typeNoun(type, n);
  const refresh = () => renderContentTab(inst, type, root, renderToken);
  const reviewUpdates = (list) => updateReviewDialog(inst, list, refresh);
  const act = async (fn) => {
    if (busy) return;
    busy = true;
    bar.classList.add('busy');
    try { await fn(); } catch (e) { toast(e.message, 'error'); } finally { busy = false; bar.classList.remove('busy'); }
  };

  // ---- selection --------------------------------------------------------
  const shownItems = () => items.filter((i) => !filter || `${i.title} ${i.fileName} ${i.modId || ''}`.toLowerCase().includes(filter));
  const selectedItems = () => items.filter((i) => selected.has(i.file));

  const renderBar = () => {
    if (!selected.size) { bar.replaceChildren(); return; }
    const sel = selectedItems();
    const shownSet = new Set(shownFiles);
    const hidden = sel.filter((i) => !shownSet.has(i.file)).length;
    const abtn = (label, ic, onclick, cls = '') => h('button', { class: `btn sm ${cls}`, type: 'button', onclick: () => act(onclick) }, icon(ic, 14), label);
    bar.replaceChildren(
      h('div', { class: 'sel-info' },
        h('div', { class: 'stack' }, sel.slice(0, 4).map((i) => avatar({ icon: i.icon, title: i.title }, 'xs')), sel.length > 4 ? h('div', { class: 'avatar xs more' }, `+${sel.length - 4}`) : null),
        h('div', { class: 'sel-label' }, `${sel.length} selected`, hidden ? h('small', null, ` (${hidden} hidden by filter)`) : null),
        h('button', { class: 'btn ghost icon', type: 'button', title: 'Clear selection (Esc)', onclick: () => clearSelection() }, icon('x'))),
      h('div', { class: 'sel-actions' },
        abtn('Update selected', 'arrowUp', updateSelected, 'primary'),
        abtn('Enable', 'check', () => bulkToggle(true)),
        abtn('Disable', 'x', () => bulkToggle(false)),
        abtn('Pin', 'pin', () => bulkPin(true)),
        abtn('Unpin', 'pin', () => bulkPin(false)),
        abtn('Copy list', 'copy', copyList),
        abtn('Send to instance…', 'upload', sendSelected),
        abtn('Remove', 'trash', removeSelected, 'danger')));
  };

  const syncSelection = () => {
    for (const [file, { row, box }] of rowEls) {
      const on = selected.has(file);
      box.checked = on;
      row.classList.toggle('selected', on);
    }
    if (headBox) {
      const n = shownFiles.filter((f) => selected.has(f)).length;
      headBox.checked = shownFiles.length > 0 && n === shownFiles.length;
      headBox.indeterminate = n > 0 && n < shownFiles.length;
    }
    listBox.classList.toggle('has-selection', selected.size > 0);
    renderBar();
  };
  const clearSelection = () => { selected.clear(); anchor = null; syncSelection(); };
  const selectAllShown = () => { for (const f of shownFiles) selected.add(f); syncSelection(); };
  const toggleShown = (on) => { for (const f of shownFiles) { if (on) selected.add(f); else selected.delete(f); } anchor = null; syncSelection(); };
  const onRowBox = (it, e) => {
    const on = e.currentTarget.checked;
    const from = anchor ? shownFiles.indexOf(anchor) : -1;
    const to = shownFiles.indexOf(it.file);
    if (e.shiftKey && from !== -1 && to !== -1) {
      for (let k = Math.min(from, to); k <= Math.max(from, to); k++) { if (on) selected.add(shownFiles[k]); else selected.delete(shownFiles[k]); }
    } else if (on) selected.add(it.file); else selected.delete(it.file);
    anchor = it.file;
    syncSelection();
  };

  // ---- updates ----------------------------------------------------------
  const runCheck = async () => {
    const res = await call('content:checkUpdates', inst.id);
    for (const e of res.filter((u) => u.error)) toast(e.error, 'warn');
    updates = new Map(res.filter((u) => !u.error && u.type === type).map((u) => [u.file, u]));
    checked = true;
    if (!res.length) toast('Everything is up to date', 'good');
    updateAllBtn.style.display = updates.size ? '' : 'none';
    updateAllBtn.replaceChildren(icon('arrowUp'), `Update all (${updates.size})`);
    updateAllBtn.onclick = () => reviewUpdates([...updates.values()]);
    renderList();
  };
  const updateSelected = async () => {
    if (!checked) await runCheck();
    const list = [...updates.values()].filter((u) => selected.has(u.file));
    if (!list.length) { toast(`None of the selected ${noun(2)} have an update.`, 'info'); return; }
    reviewUpdates(list);
  };

  // ---- bulk actions -----------------------------------------------------
  const bulkToggle = async (on) => {
    const sel = selectedItems().filter((i) => i.enabled !== on);
    if (!sel.length) { toast(`The selected ${noun(2)} are already ${on ? 'enabled' : 'disabled'}.`, 'info'); return; }
    await call('content:toggleMany', inst.id, sel.map((i) => i.file), on);
    for (const i of sel) i.enabled = on;
    renderList();
    toast(`${on ? 'Enabled' : 'Disabled'} ${sel.length} ${noun(sel.length)}`, 'good');
  };
  const bulkPin = async (on) => {
    const sel = selectedItems();
    await call('content:pinMany', inst.id, sel.map((i) => i.file), on);
    for (const i of sel) i.pinned = on;
    renderList();
    toast(`${on ? 'Pinned' : 'Unpinned'} ${sel.length} ${noun(sel.length)}${on ? '. Updates will skip them.' : ''}`, 'good');
  };
  const copyList = async () => {
    const r = await call('content:copyList', inst.id, selectedItems().map((i) => i.file));
    toast(`Copied ${r.count} ${noun(r.count)} as a Markdown list`, 'good');
  };
  const sendSelected = async () => { await sendToInstanceDialog(inst, selectedItems().map((i) => i.file), type); };
  const removeSelected = async () => {
    const sel = selectedItems();
    const ok = await confirmDialog(`Remove ${sel.length} ${noun(sel.length)}?`,
      `This deletes ${sel.length} ${noun(sel.length)} from ${inst.name}: ${sel.slice(0, 5).map((i) => i.title).join(', ')}${sel.length > 5 ? `, and ${sel.length - 5} more` : ''}. This can't be undone.`,
      `Remove ${sel.length}`, true);
    if (!ok) return;
    await call('content:remove', inst.id, sel.map((i) => i.file));
    const gone = new Set(sel.map((i) => i.file));
    items = items.filter((i) => !gone.has(i.file));
    selected.clear();
    renderList();
    toast(`Removed ${sel.length} ${noun(sel.length)}`);
  };

  // ---- smart select -----------------------------------------------------
  const applySmart = (pred, label) => {
    const hit = items.filter(pred);
    if (!hit.length) { toast(`No ${noun(2)} match “${label}”.`, 'info'); return; }
    selected.clear();
    for (const i of hit) selected.add(i.file);
    anchor = null;
    syncSelection();
  };
  const smartMenu = (anchorEl) => {
    const count = (p) => items.filter(p).length;
    const entry = (label, pred, ic, opts = {}) => ({
      label: `${label}${opts.count === false ? '' : ` (${count(pred)})`}`, icon: ic,
      onClick: () => act(async () => { if (opts.needsCheck && !checked) await runCheck(); applySmart(pred, label); }),
    });
    popupMenu(anchorEl, [
      entry('All disabled', (i) => !i.enabled, 'x'),
      { ...entry('All with updates', (i) => updates.has(i.file), 'arrowUp', { needsCheck: true, count: checked }), label: `All with updates${checked ? ` (${updates.size})` : ' (checks first)'}` },
      entry('All not linked to Modrinth or CurseForge', (i) => i.source === 'local', 'info'),
      ...(type === 'mod' ? [entry('All duplicates', (i) => Boolean(i.duplicateOf), 'alert')] : []),
      '-',
      entry('All from Modrinth', (i) => i.source === 'modrinth', 'check'),
      entry('All from CurseForge', (i) => i.source === 'curseforge', 'check'),
      ...(type === 'mod' ? [entry('All client-only', (i) => i.clientOnly, 'box')] : []),
    ]);
  };

  // ---- the list ---------------------------------------------------------
  const renderList = () => {
    const have = new Set(items.map((i) => i.file));
    for (const f of [...selected]) if (!have.has(f)) selected.delete(f);
    const shown = shownItems();
    shownFiles = shown.map((i) => i.file);
    rowEls = new Map();
    headBox = null;
    countLabel.textContent = `${items.length} ${type === 'mod' ? 'mods' : 'files'}${items.filter((i) => !i.enabled).length ? ` · ${items.filter((i) => !i.enabled).length} disabled` : ''}`;
    const dups = items.filter((i) => i.duplicateOf);
    const unknown = items.filter((i) => i.source === 'local');
    notices.replaceChildren(
      dups.length ? h('div', { class: 'notice warn' }, icon('alert'), h('div', null,
        h('div', null, `${dups.length} duplicate mod${dups.length > 1 ? 's' : ''} found (the same mod installed twice, e.g. from both Modrinth and CurseForge). Minecraft will refuse to start like this.`),
        h('div', { class: 'hint' }, dups.map((d) => `${d.fileName} ↔ ${d.duplicateOf}`).join(' · ')))) : null,
      unknown.length ? h('div', { class: 'notice info' }, icon('info'), h('div', { class: 'grow' },
        `${unknown.length} file${unknown.length > 1 ? 's' : ''} not linked to Modrinth or CurseForge, so ${unknown.length > 1 ? "they can't" : "it can't"} be updated.`),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => {
          try { const r = await call('content:identify', inst.id); toast(`Recognised ${r.identified} of ${r.total}`, r.identified ? 'good' : 'info'); renderContentTab(inst, type, root, renderToken); } catch (e) { toast(e.message, 'error'); }
        } }, 'Look them up')) : null,
    );
    if (!shown.length) {
      listBox.replaceChildren(h('div', { class: 'empty' },
        h('h2', null, items.length ? 'Nothing matches' : `No ${TYPES[type].toLowerCase()} yet`),
        h('div', null, items.length ? 'Try another filter.' : 'Browse Modrinth and CurseForge, or add files you already have.'),
        !items.length ? h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => go('browse', { type, instanceId: inst.id }) }, icon('search'), `Find ${TYPES[type].toLowerCase()}`)) : null));
      syncSelection();
      return;
    }
    headBox = h('input', { type: 'checkbox', title: 'Select everything shown', onclick: (e) => toggleShown(e.currentTarget.checked) });
    const head = h('div', { class: 'item content-head' },
      headBox,
      h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Smart select…', onclick: (e) => smartMenu(e.currentTarget) }, icon('chevronDown', 14)),
      h('div', null, 'Name'),
      h('div', null, 'Version'),
      h('div', null, 'Source'),
      h('div', { class: 'c-switch' }, 'Enabled'),
      h('div'));
    const rows = shown.map((it) => {
      const up = updates.get(it.file);
      const box = h('input', {
        type: 'checkbox', class: 'sel', title: 'Select (Shift+click for a range)',
        onmousedown: (e) => { if (e.shiftKey) e.preventDefault(); }, // no text selection while range-selecting
        onclick: (e) => onRowBox(it, e),
      });
      const sw = h('label', { class: 'switch', title: it.enabled ? 'Enabled: click to disable' : 'Disabled: click to enable' },
        h('input', {
          type: 'checkbox', checked: it.enabled, onchange: async (e) => {
            try { await call('content:toggle', inst.id, it.file, e.target.checked); it.enabled = e.target.checked; renderList(); } catch (err) { toast(err.message, 'error'); e.target.checked = it.enabled; }
          },
        }), h('span'));
      const row = h('div', { class: `item ${it.enabled ? '' : 'disabled'}` },
        box,
        avatar({ icon: it.icon, title: it.title }, 'sm'),
        h('div', { class: 'i-main', style: { minWidth: 0 } },
          h('div', { class: 'i-title ellipsis', title: it.title }, it.title,
            it.clientOnly ? h('span', { class: 'badge client plain', style: { marginLeft: '8px' }, title: "Client-only: it's not needed on a server" }, 'Client') : null,
            it.duplicateOf ? h('span', { class: 'badge warn plain', style: { marginLeft: '8px' } }, 'Duplicate') : null,
            it.pinned ? h('span', { class: 'badge plain', style: { marginLeft: '8px' }, title: 'Pinned: skipped by updates' }, 'Pinned') : null),
          h('div', { class: 'i-file ellipsis', title: it.fileName }, it.fileName)),
        h('div', { class: 'i-ver ellipsis', title: it.versionName }, up ? h('span', { class: 'badge good plain', title: `Update: ${up.next}` }, `→ ${up.next}`) : it.versionName),
        h('div', null, sourceBadge(it.source, it.url)),
        h('div', { class: 'c-switch' }, sw),
        h('div', { class: 'i-actions' },
          up ? h('button', { class: 'btn sm primary', type: 'button', title: `Update to ${up.next}`, onclick: () => reviewUpdates([up]) }, icon('arrowUp', 14)) : null,
          h('button', { class: 'btn ghost icon', type: 'button', title: 'More', onclick: (e) => popupMenu(e.currentTarget, [
            { label: it.pinned ? 'Unpin version' : 'Pin this version (skip updates)', icon: 'pin', onClick: async () => { await call('content:pin', inst.id, it.file, !it.pinned); it.pinned = !it.pinned; renderList(); } },
            ...(it.url ? [{ label: `Open on ${SRC[it.source]}`, icon: 'external', onClick: () => call('shell:open', it.url) }] : []),
            ...(it.projectId && it.source !== 'local' ? [{ label: 'Change version…', icon: 'refresh', onClick: () => projectDialog({ source: it.source, id: it.projectId, title: it.title, icon: it.icon, type }, { instance: inst, tab: 'versions', onInstalled: () => renderContentTab(inst, type, root, renderToken) }) }] : []),
            '-',
            { label: 'Remove', icon: 'trash', danger: true, onClick: async () => {
              await call('content:remove', inst.id, [it.file]);
              items = items.filter((x) => x.file !== it.file);
              renderList();
              toast(`Removed ${it.title}`);
            } },
          ]) }, icon('more'))));
      rowEls.set(it.file, { row, box });
      return row;
    });
    listBox.replaceChildren(h('div', { class: 'list content-list' }, head, rows));
    syncSelection();
  };

  updateBtn.onclick = async () => {
    updateBtn.disabled = true;
    try { await runCheck(); } catch (e) { toast(e.message, 'error'); } finally { updateBtn.disabled = false; }
  };

  const undoSlot = h('span');
  call('content:updateHistory', inst.id).then((hist) => {
    const last = hist[0];
    if (!last) return;
    undoSlot.replaceChildren(h('button', {
      class: 'btn ghost', type: 'button', title: last.items.map((i) => `${i.title}: ${i.from} → ${i.to}`).join('\n'),
      onclick: async () => {
        const list = last.items.map((i) => `• ${i.title}: back to ${i.from || 'the previous version'}`).join('\n');
        if (!(await confirmDialog(`Undo the update from ${ago(last.date)}?`, `This puts back the exact files that were replaced:\n${list}`, 'Undo update'))) return;
        try { const r = await call('content:undoUpdate', inst.id, last.stamp); toast(`Restored ${r.restored} file${r.restored === 1 ? '' : 's'}`, 'good'); refresh(); } catch (e) { toast(e.message, 'error'); }
      },
    }, icon('refresh'), `Undo last update (${last.items.length})`));
  }).catch(() => {});
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'search', style: { maxWidth: '320px' } }, icon('search'), h('input', { type: 'search', placeholder: 'Filter…', oninput: (e) => { filter = e.target.value.toLowerCase(); renderList(); } })),
    countLabel,
    h('div', { class: 'grow' }),
    undoSlot,
    updateAllBtn,
    updateBtn,
    h('button', { class: 'btn', type: 'button', onclick: async () => {
      try { const added = await call('content:addFiles', inst.id, type); if (added?.length) { toast(`Added ${added.length} file(s)`, 'good'); renderContentTab(inst, type, root, renderToken); } } catch (e) { toast(e.message, 'error'); }
    } }, icon('file'), 'Add files'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => go('browse', { type, instanceId: inst.id }) }, icon('plus'), `Add ${type === 'mod' ? 'mods' : TYPES[type].toLowerCase()}`));
  root.replaceChildren(toolbar, notices, listBox, bar);
  renderList();

  // Keyboard: Ctrl+A selects everything shown, Esc clears the selection.
  if (contentKeyHandler) document.removeEventListener('keydown', contentKeyHandler);
  const onKey = (e) => {
    if (stale(token) || !document.body.contains(listBox)) { document.removeEventListener('keydown', onKey); return; }
    if ($('#modal-root').children.length) return;
    const el = document.activeElement;
    const typing = el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'checkbox'));
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
      if (typing) return; // let the filter box select its own text
      e.preventDefault();
      selectAllShown();
    } else if (e.key === 'Escape' && selected.size) {
      clearSelection();
    }
  };
  contentKeyHandler = onKey;
  document.addEventListener('keydown', onKey);

  // Fill in Modrinth's client/server info for mods linked before it was stored, so "Client" badges are complete.
  if (type === 'mod') {
    call('content:refreshSides', inst.id).then(async (r) => {
      if (!r?.updated || stale(token) || !document.body.contains(listBox)) return;
      items = await call('content:list', inst.id, type);
      if (!stale(token) && document.body.contains(listBox)) renderList();
    }).catch(() => {});
  }
}

// ----- send to another instance
async function sendToInstanceDialog(inst, rels, type) {
  const all = (await call('inst:list')).filter((i) => i.id !== inst.id);
  if (!all.length) { toast('You only have one instance. Create another one to send these to.', 'info'); return; }
  let target = null;
  const list = h('div', { class: 'list pick-list' });
  const sendBtnRef = { el: null };
  const draw = () => {
    list.replaceChildren(...all.map((i) => h('div', {
      class: `item pick-row ${target === i.id ? 'selected' : ''}`, onclick: () => { target = i.id; draw(); },
    }, h('input', { type: 'radio', name: 'target', checked: target === i.id }), avatar(i, 'sm'),
    h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis' }, i.name), h('div', { class: 'i-file ellipsis' }, instSubtitle(i))))));
    if (sendBtnRef.el) sendBtnRef.el.disabled = !target;
  };
  draw();
  const m = modal({
    title: `Send ${rels.length} ${typeNoun(type, rels.length)} to…`,
    body: [
      h('p', { style: { margin: 0, color: 'var(--muted)', lineHeight: 1.5 } },
        'Files from Modrinth or CurseForge are installed in the version that fits the other instance (its Minecraft version and loader), together with what they need. Files you added yourself are copied only if their loader matches. Nothing is changed in this instance.'),
      list,
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      {
        label: 'Send', class: 'primary', icon: 'upload', disabled: true, onClick: async () => {
          const dest = all.find((i) => i.id === target);
          const r = await call('content:sendToInstance', inst.id, rels, target);
          sendSummaryDialog(dest, r);
        },
      },
    ],
  });
  sendBtnRef.el = m.el.querySelectorAll('.m-foot .btn')[1];
  sendBtnRef.el.disabled = !target;
}

function sendSummaryDialog(dest, r) {
  const section = (title, cls, rows, fmt) => (rows.length ? h('div', { class: 'sum-sec' },
    h('div', { class: `sum-head ${cls}` }, `${title} (${rows.length})`),
    h('ul', null, rows.map((x) => h('li', null, h('b', null, x.title), fmt ? h('span', { class: 'muted' }, ` — ${fmt(x)}`) : null)))) : null);
  const none = !r.installed.length && !r.copied.length && !r.skipped.length && !r.unavailable.length && !r.blocked.length;
  modal({
    title: `Sent to ${dest.name}`,
    body: [
      none ? h('p', { style: { margin: 0 } }, 'Nothing was sent.') : null,
      section('Installed', 'good', r.installed, (x) => (x.source === 'modrinth' ? 'from Modrinth' : 'from CurseForge')),
      section('Copied', 'good', r.copied, () => 'copied as it is'),
      section('Already there', 'muted', r.skipped, (x) => x.reason),
      section(`Not available for ${dest.mcVersion}`, 'warn', r.unavailable, (x) => x.reason),
      section('Needs a manual download', 'warn', r.blocked, () => 'the author only allows downloads from their CurseForge page'),
      r.warnings.length ? h('div', { class: 'sum-sec' }, h('div', { class: 'sum-head warn' }, 'Heads up'), h('ul', null, r.warnings.map((w) => h('li', { class: 'muted' }, w)))) : null,
    ],
    actions: [{ label: 'Open instance', class: 'ghost', onClick: () => { go('instance', { id: dest.id }); } }, { label: 'Done', class: 'primary' }],
    onClose: () => { if (r.blockedSession) blockedDialog(r.blockedSession, dest.id); },
  });
}

// ----- update review
const CHANNELS = [
  { value: 'release', label: 'Releases only' },
  { value: 'beta', label: 'Releases & betas' },
  { value: 'alpha', label: 'Everything (incl. alpha)' },
];
const CH_RANK = { release: 0, beta: 1, alpha: 2 };

function releaseBadge(t) {
  return h('span', { class: `badge plain ${t === 'release' ? 'good' : t === 'beta' ? 'warn' : 'bad'}` }, t || 'release');
}

function updateReviewDialog(inst, updates, onDone) {
  let channel = state.settings?.updateChannel || 'alpha';
  const allowed = (v) => (CH_RANK[v.releaseType] ?? 0) <= CH_RANK[channel];
  const rows = updates.map((u) => ({ u, include: allowed(u.version), touched: false, candidates: null, chosen: u.version, failed: false }));
  const running = state.running.get(inst.id) === 'running';

  const applyChannel = (row) => {
    if (row.touched) return;
    const list = row.candidates || [row.u.version];
    const best = list.find(allowed);
    if (best) { row.chosen = best; row.include = true; } else { row.include = false; }
  };

  const listBox = h('div', { class: 'list upd-list' });
  const summary = h('span', { class: 'muted small' });
  const renderRow = (row) => {
    const { u } = row;
    const opts = row.candidates && row.candidates.length ? row.candidates : [u.version];
    const sel = h('select', {
      class: 'upd-select', disabled: !row.candidates,
      title: row.candidates ? 'Pick the version to update to' : 'Loading versions…',
      onchange: (e) => {
        row.chosen = opts.find((v) => String(v.id) === e.target.value) || row.chosen;
        row.touched = true;
        row.include = true;
        redraw();
      },
    }, opts.map((v) => h('option', { value: String(v.id) }, `${v.versionNumber}${v.releaseType !== 'release' ? `  (${v.releaseType})` : ''}  ·  ${ago(v.date)}`)));
    sel.value = String(row.chosen.id);
    const noneInChannel = row.candidates && !row.touched && !row.candidates.some(allowed);
    return h('div', { class: `item upd-row ${row.include ? '' : 'skipped'}` },
      h('input', { type: 'checkbox', checked: row.include, onchange: (e) => { row.include = e.target.checked; row.touched = true; redraw(); } }),
      avatar({ icon: u.icon, title: u.title }, 'sm'),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'i-title ellipsis' }, u.title),
        h('div', { class: 'i-file ellipsis' }, noneInChannel ? h('span', { style: { color: 'var(--warn)' } }, `No ${channel === 'release' ? 'release' : 'release or beta'} update — pick one to include it`) : SRC[u.source])),
      h('div', { class: 'upd-from ellipsis', title: u.current }, u.current || '—'),
      icon('arrowLeft', 14),
      h('div', { class: 'row', style: { minWidth: 0, gap: '6px' } }, sel, row.candidates ? null : h('div', { class: 'spinner', style: { width: '14px', height: '14px' } })),
      releaseBadge(row.chosen.releaseType));
  };
  const countSel = () => rows.filter((r) => r.include).length;
  let actionBtn;
  const redraw = () => {
    listBox.replaceChildren(...rows.map(renderRow));
    const n = countSel();
    summary.textContent = `${n} of ${rows.length} selected`;
    if (actionBtn) {
      actionBtn.disabled = n === 0 || running;
      actionBtn.replaceChildren(icon('arrowUp'), n ? `Update ${n} mod${n > 1 ? 's' : ''}` : 'Nothing selected');
    }
  };

  const channelSel = select(CHANNELS, channel, async (v) => {
    channel = v;
    rows.forEach(applyChannel);
    redraw();
    try { state.settings = await call('settings:set', { updateChannel: v }); } catch { /* not critical */ }
  });
  const m = modal({
    title: `${rows.length} update${rows.length > 1 ? 's' : ''} ready`,
    body: [
      h('p', { style: { margin: 0, color: 'var(--muted)', lineHeight: 1.5 } }, 'Nothing changes until you press Update. Pick the version for each mod, or untick one to skip it. Replaced files are backed up so the whole update can be undone.'),
      h('div', { class: 'row wrap' },
        h('label', { class: 'row small muted' }, 'Default to the newest of', channelSel),
        h('div', { class: 'grow' }),
        summary,
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { rows.forEach((r) => { r.include = true; r.touched = true; }); redraw(); } }, 'All'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { rows.forEach((r) => { r.include = false; r.touched = true; }); redraw(); } }, 'None')),
      listBox,
      running ? h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), 'Minecraft is running from this instance. Close the game first.') : h('div', { class: 'hint' }, 'Tip: pin a mod in the list (⋯ → Pin this version) to stop it being offered at all.'),
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      {
        label: 'Update', class: 'primary', icon: 'arrowUp', onClick: async () => {
          const chosen = rows.filter((r) => r.include).map((r) => ({
            file: r.u.file, title: r.u.title, type: r.u.type, source: r.u.source, current: r.u.current, version: r.chosen, project: r.u.project || null,
          }));
          const res = await call('content:applyUpdates', inst.id, chosen);
          await handleInstallResult({ ...res, installed: [] }, inst.id);
          toast(`Updated ${chosen.length} mod${chosen.length > 1 ? 's' : ''}. Use “Undo last update” if something breaks.`, 'good', 7000);
          if (onDone) onDone();
        },
      },
    ],
  });
  m.el.style.width = 'min(1100px, 100%)';
  actionBtn = m.el.querySelectorAll('.m-foot .btn')[1];
  rows.forEach((r) => { if (!allowed(r.u.version)) r.include = false; });
  redraw();

  // Load every newer compatible version per mod (a few at a time).
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        const list = await call('content:updateCandidates', inst.id, { source: row.u.source, projectId: row.u.projectId ?? row.u.version.projectId, type: row.u.type, currentVersionId: row.u.currentVersionId });
        if (!list.some((v) => String(v.id) === String(row.u.version.id))) list.unshift(row.u.version);
        row.candidates = list.sort((a, b) => new Date(b.date) - new Date(a.date));
      } catch {
        row.candidates = [row.u.version];
        row.failed = true;
      }
      applyChannel(row);
      if (document.body.contains(listBox)) redraw();
    }
  };
  Promise.all([worker(), worker(), worker(), worker()]);
}

// ----- logs tab
async function renderLogsTab(inst, root) {
  const box = h('div', { class: 'log' });
  let auto = true;
  box.addEventListener('scroll', () => { auto = box.scrollTop + box.clientHeight >= box.scrollHeight - 30; });
  const add = (lines) => {
    const frag = document.createDocumentFragment();
    for (const l of lines) {
      const cls = l.startsWith('[Junction]') ? 'l-j' : /\b(ERROR|FATAL|Exception)\b/.test(l) ? 'l-err' : /\bWARN\b/.test(l) ? 'l-warn' : '';
      frag.append(h('div', { class: cls }, l));
    }
    box.append(frag);
    while (box.childElementCount > 4000) box.firstChild.remove();
    if (auto) box.scrollTop = box.scrollHeight;
  };
  const existing = await call('inst:log', inst.id);
  if (existing.length) add(existing); else box.append(h('div', { class: 'faint' }, 'Game output appears here while Minecraft is running.'));
  state.logListeners.set(inst.id, (lines) => { if (document.body.contains(box)) add(lines); });
  root.replaceChildren(
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', type: 'button', onclick: () => { navigator.clipboard.writeText([...box.children].map((c) => c.textContent).join('\n')); toast('Log copied'); } }, icon('copy'), 'Copy'),
      h('button', { class: 'btn', type: 'button', onclick: () => call('inst:openFolder', inst.id, 'logs') }, icon('folder'), 'Logs folder'),
      h('button', { class: 'btn', type: 'button', onclick: () => call('inst:openFolder', inst.id, 'crash-reports') }, icon('alert'), 'Crash reports')),
    box);
}

// ----- instance settings tab
const JVM_PRESETS = [
  { label: 'Generational ZGC', args: '-XX:+UseZGC -XX:+ZGenerational', hint: 'Low pause times for big packs. Java 21+ (on 23+ ZGC is generational by default).' },
  { label: 'Tuned G1', args: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1', hint: 'Well-known G1 flags for modded play.' },
];

async function renderInstSettings(inst, root) {
  const s = state.settings || (state.settings = await call('settings:get'));
  const versions = await loadMcVersions(true);
  const f = {
    name: h('input', { type: 'text', value: inst.name }),
    memMax: h('input', { type: 'number', min: 512, step: 256, value: inst.memoryMax || '', placeholder: `${s.memoryMax} (default)` }),
    memMin: h('input', { type: 'number', min: 256, step: 256, value: inst.memoryMin || '', placeholder: `${s.memoryMin} (default)` }),
    jvm: h('textarea', { rows: 3, placeholder: 'Extra JVM arguments, e.g. -XX:+UseZGC', value: inst.jvmArgs || '' }),
    java: h('input', { type: 'text', value: inst.javaPath || '', placeholder: 'Automatic (Mojang runtime for this version)' }),
    width: h('input', { type: 'number', min: 0, value: inst.resolution?.width || '', placeholder: 'default' }),
    height: h('input', { type: 'number', min: 0, value: inst.resolution?.height || '', placeholder: 'default' }),
    server: h('input', { type: 'text', value: inst.joinServer || '', placeholder: 'e.g. play.example.net:25565' }),
  };
  let mc = inst.mcVersion;
  let loader = inst.loader?.type || 'vanilla';
  let loaderVersion = inst.loader?.version || null;
  const lvWrap = h('div');
  async function loadLv() {
    if (loader === 'vanilla') { lvWrap.replaceChildren(h('div', { class: 'hint' }, 'No loader')); loaderVersion = null; return; }
    lvWrap.replaceChildren(loading());
    try {
      const { list, default: def } = await call('loader:versions', loader, mc);
      if (!list.length) { lvWrap.replaceChildren(h('div', { class: 'hint' }, `Not available for ${mc}`)); loaderVersion = null; return; }
      if (!list.find((v) => v.version === loaderVersion)) loaderVersion = def;
      lvWrap.replaceChildren(select(list.map((v) => ({ value: v.version, label: `${v.version}${v.recommended ? ' (recommended)' : ''}` })), loaderVersion, (v) => { loaderVersion = v; }));
    } catch (e) { lvWrap.replaceChildren(h('div', { class: 'hint' }, e.message)); }
  }
  loadLv();
  const save = async () => {
    const changedGame = mc !== inst.mcVersion || loader !== (inst.loader?.type || 'vanilla') || (loaderVersion || null) !== (inst.loader?.version || null);
    if (changedGame && !(await confirmDialog('Change game version?', 'Mods made for the old version or loader may not work and may need updating. Worlds opened in a newer version can\'t safely go back.', 'Change it'))) return;
    const w = Number(f.width.value) || 0;
    const hgt = Number(f.height.value) || 0;
    await call('inst:update', inst.id, {
      name: f.name.value.trim() || inst.name,
      mcVersion: mc,
      loader: loader === 'vanilla' ? { type: 'vanilla' } : { type: loader, version: loaderVersion },
      memoryMax: Number(f.memMax.value) || null,
      memoryMin: Number(f.memMin.value) || null,
      jvmArgs: f.jvm.value.trim(),
      javaPath: f.java.value.trim(),
      resolution: w && hgt ? { width: w, height: hgt } : null,
      joinServer: f.server.value.trim(),
    });
    toast('Saved', 'good');
    go('instance', { id: inst.id, tab: 'settings' });
  };
  root.replaceChildren(
    h('div', { class: 'section' }, h('h3', null, 'General'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Name', f.name),
        h('label', { class: 'field' }, 'Minecraft version', select(versions.map((v) => ({ value: v.id, label: v.type === 'release' ? v.id : `${v.id} (${v.type})` })), mc, (v) => { mc = v; loadLv(); })),
        h('label', { class: 'field' }, 'Loader', select(Object.entries(LOADER).map(([k, l]) => ({ value: k, label: l })), loader, (v) => { loader = v; loadLv(); })),
        h('label', { class: 'field' }, 'Loader version', lvWrap))),
    h('div', { class: 'section' }, h('h3', null, 'Java & memory'),
      h('p', null, `Leave empty to use the defaults from Settings (${s.memoryMax} MB max). Java is downloaded automatically in the version Minecraft needs.`),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Maximum memory (MB)', f.memMax),
        h('label', { class: 'field' }, 'Minimum memory (MB)', f.memMin),
        h('label', { class: 'field' }, 'Java executable', h('div', { class: 'row' }, f.java, h('button', { class: 'btn', type: 'button', onclick: async () => { const p = await call('dialog:pickJava'); if (p) f.java.value = p; } }, 'Browse')))),
      h('label', { class: 'field', style: { marginTop: '14px' } }, 'JVM arguments', f.jvm),
      h('div', { class: 'row wrap', style: { marginTop: '8px' } }, h('span', { class: 'hint' }, 'Presets:'),
        JVM_PRESETS.map((p) => h('button', { class: 'btn sm', type: 'button', title: p.hint, onclick: () => { f.jvm.value = p.args; } }, p.label)),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { f.jvm.value = ''; } }, 'Clear'))),
    h('div', { class: 'section' }, h('h3', null, 'Game window & server'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Window width', f.width),
        h('label', { class: 'field' }, 'Window height', f.height),
        h('label', { class: 'field' }, 'Join server on launch', f.server))),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => save().catch((e) => toast(e.message, 'error')) }, icon('check'), 'Save changes')),
  );
}

// ----- export dialog
async function exportDialog(inst, format) {
  const entries = await call('export:entries', inst.id);
  const checks = new Map();
  const name = h('input', { type: 'text', value: inst.name });
  const version = h('input', { type: 'text', value: '1.0.0' });
  const author = h('input', { type: 'text', value: '', placeholder: 'optional' });
  const list = h('div', { class: 'list', style: { maxHeight: '280px', overflow: 'auto' } }, entries.map((e) => {
    const c = h('input', { type: 'checkbox', checked: e.defaultOn });
    checks.set(e.name, c);
    return h('label', { class: 'check', style: { padding: '8px 12px', borderBottom: '1px solid var(--border)' } }, c, icon(e.dir ? 'folder' : 'file', 14), e.name);
  }));
  modal({
    title: format === 'mrpack' ? 'Export as Modrinth pack' : 'Export as CurseForge pack',
    body: [
      h('div', { class: 'form-grid' }, h('label', { class: 'field' }, 'Pack name', name), h('label', { class: 'field' }, 'Version', version), format === 'curseforge' ? h('label', { class: 'field' }, 'Author', author) : null),
      h('div', { class: 'field' }, h('span', { class: 'small muted', style: { fontWeight: 600 } }, 'Include'), list),
      h('div', { class: 'hint' }, format === 'mrpack'
        ? 'Mods that exist on Modrinth are linked, not copied — so the pack stays small and authors get the downloads. Anything else (e.g. CurseForge-only mods) is bundled inside the pack; only share those packs if the mods\' licences allow it.'
        : 'Mods that exist on CurseForge are linked by ID. Anything else (e.g. Modrinth-only mods) is bundled inside the pack; only share those packs if the mods\' licences allow it.'),
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      {
        label: 'Export', class: 'primary', icon: 'upload', onClick: async () => {
          const include = [...checks.entries()].filter(([, c]) => c.checked).map(([n]) => n);
          const r = await call('export:run', inst.id, format, { name: name.value.trim(), version: version.value.trim() || '1.0.0', author: author.value.trim(), include });
          if (!r) return true;
          toast(`Exported: ${r.referenced} files linked, ${r.bundled} bundled.${r.bundledContent.length ? `\nBundled jars/packs: ${r.bundledContent.slice(0, 5).map((x) => x.split('/').pop()).join(', ')}${r.bundledContent.length > 5 ? '…' : ''}` : ''}`, 'good', 9000);
          return false;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- browse
const browseState = { type: 'mod', query: '', gameVersion: '', loader: '', sort: 'relevance', sources: ['modrinth', 'curseforge'], page: 0 };

async function renderBrowse(params, token) {
  const s = state.settings || (state.settings = await call('settings:get'));
  const info = state.info || (state.info = await call('app:info'));
  let inst = null;
  if (params.instanceId) {
    inst = await call('inst:get', params.instanceId).catch(() => null);
  }
  if (params.type) browseState.type = params.type;
  if (inst) {
    browseState.gameVersion = inst.mcVersion;
    browseState.loader = browseState.type === 'mod' ? (inst.loader?.type === 'vanilla' ? '' : inst.loader?.type) : '';
    if (browseState.type === 'modpack') browseState.type = 'mod';
  }
  browseState.page = 0;
  const versions = await loadMcVersions();
  if (stale(token)) return;
  const bctx = {
    installed: inst ? await call('content:installed', inst.id).catch(() => null) : null,
    cards: [],
    async refresh() {
      if (!inst) return;
      this.installed = await call('content:installed', inst.id).catch(() => this.installed);
      for (const fn of this.cards) fn();
    },
  };
  if (stale(token)) return;
  const results = h('div', { class: 'results' });
  const more = h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '16px' } });
  const warnBox = h('div');
  let searchTimer = null;
  let lastHits = [];

  const doSearch = async (append = false) => {
    const myToken = token;
    if (!append) { browseState.page = 0; results.replaceChildren(loading('Searching Modrinth & CurseForge…')); more.replaceChildren(); }
    try {
      const r = await call('browse:search', { ...browseState, pageSize: 20 });
      if (stale(myToken)) return;
      warnBox.replaceChildren(...r.warnings.map((w) => h('div', { class: 'notice warn' }, icon('alert'), w)));
      if (!append) { results.replaceChildren(); lastHits = []; bctx.cards = []; }
      lastHits.push(...r.hits);
      if (!lastHits.length) results.replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'No results'), h('div', null, 'Try another search or loosen the filters.')));
      for (const hit of r.hits) results.append(resultCard(hit, inst, bctx));
      const anyMore = Object.values(r.totals).some((t) => t > (browseState.page + 1) * 20);
      more.replaceChildren(anyMore ? h('button', { class: 'btn', type: 'button', onclick: () => { browseState.page++; doSearch(true); } }, 'Load more') : null);
    } catch (e) {
      results.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), e.message));
    }
  };

  const typeSeg = h('div', { class: 'seg' }, Object.entries(TYPES).map(([k, l]) => h('button', {
    type: 'button', class: k === browseState.type ? 'on' : '', disabled: inst && k === 'modpack',
    onclick: () => { browseState.type = k; if (k !== 'mod' && k !== 'modpack') browseState.loader = ''; else if (inst) browseState.loader = inst.loader?.type === 'vanilla' ? '' : inst.loader?.type; go('browse', { instanceId: inst?.id, type: k }); },
  }, l)));
  const srcToggle = (src) => {
    const disabled = src === 'curseforge' && !info.cfConfigured;
    const onState = browseState.sources.includes(src) && !disabled;
    return h('button', {
      type: 'button', class: `src-toggle ${src} ${onState ? 'on' : ''}`, disabled,
      title: disabled ? 'Add a CurseForge API key in Settings to search CurseForge' : `Search ${SRC[src]}`,
      onclick: (e) => {
        const has = browseState.sources.includes(src);
        if (has && browseState.sources.length === 1) return;
        browseState.sources = has ? browseState.sources.filter((x) => x !== src) : [...browseState.sources, src];
        e.currentTarget.classList.toggle('on', !has);
        doSearch();
      },
    }, onState ? icon('check', 12) : null, SRC[src]);
  };
  const input = h('input', {
    type: 'search', placeholder: `Search ${TYPES[browseState.type].toLowerCase()} on Modrinth and CurseForge…`, value: browseState.query,
    oninput: (e) => { browseState.query = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(), 350); },
  });
  const loaderFilter = browseState.type === 'mod' || browseState.type === 'modpack'
    ? select([{ value: '', label: 'Any loader' }, ...['fabric', 'quilt', 'forge', 'neoforge'].map((l) => ({ value: l, label: LOADER[l] }))], browseState.loader, (v) => { browseState.loader = v; doSearch(); }, { disabled: Boolean(inst) })
    : null;
  const top = h('div', { class: 'browse-top' },
    inst ? h('div', { class: 'context-bar' }, avatar(inst, 'xs'), h('div', { class: 'grow' }, h('b', null, `Adding to ${inst.name}`), h('span', { class: 'muted' }, ` · ${instSubtitle(inst)}`)),
      h('button', { class: 'btn sm', type: 'button', onclick: () => go('instance', { id: inst.id, tab: browseState.type }) }, icon('arrowLeft', 14), 'Back to instance')) : null,
    h('div', { class: 'row wrap' }, h('div', { class: 'search' }, icon('search', 18), input), typeSeg),
    h('div', { class: 'filters' },
      select([{ value: '', label: 'All versions' }, ...versions.map((v) => ({ value: v.id, label: v.id }))], browseState.gameVersion, (v) => { browseState.gameVersion = v; doSearch(); }, { disabled: Boolean(inst) }),
      loaderFilter,
      select([{ value: 'relevance', label: 'Relevance' }, { value: 'downloads', label: 'Most downloads' }, { value: 'follows', label: 'Most followed' }, { value: 'updated', label: 'Recently updated' }, { value: 'newest', label: 'Newest' }], browseState.sort, (v) => { browseState.sort = v; doSearch(); }),
      h('div', { class: 'grow' }),
      srcToggle('modrinth'), srcToggle('curseforge')));
  view().replaceChildren(top, h('div', { class: 'browse-body' }, warnBox, results, more));
  setTimeout(() => input.focus(), 0);
  if (!info.cfConfigured && !s.dismissedCfHint) {
    warnBox.append(h('div', { class: 'notice info' }, icon('info'), h('div', { class: 'grow' }, 'Showing Modrinth only. Add your CurseForge API key in Settings to search both at once.'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => go('settings') }, 'Open Settings')));
  }
  doSearch();
}

function resultCard(hit, inst, bctx = null) {
  const sources = [hit, ...(hit.alsoOn || [])];
  const slot = h('div');
  const onInstalled = () => bctx?.refresh();
  const renderAction = () => {
    const match = inst ? installedMatch(hit, bctx?.installed) : null;
    if (match) {
      const from = match.exact && match.source !== hit.source ? ` (from ${SRC[match.source]})` : '';
      slot.replaceChildren(h('button', {
        class: 'btn installed', type: 'button',
        title: `Already in ${inst.name}${from}. Click to see versions or switch to another one.`,
        onclick: (e) => { e.stopPropagation(); projectDialog(hit, { instance: inst, tab: 'versions', onInstalled }); },
      }, icon('check'), 'Installed'));
      return;
    }
    const installBtn = h('button', { class: 'btn primary', type: 'button' }, icon('download'), hit.type === 'modpack' ? 'Install' : inst ? 'Install' : 'Install…');
    installBtn.onclick = async (e) => {
      e.stopPropagation();
      installBtn.disabled = true;
      try {
        if (await quickInstall(hit, inst)) await onInstalled();
      } finally { installBtn.disabled = false; }
    };
    slot.replaceChildren(installBtn);
  };
  renderAction();
  if (bctx) bctx.cards.push(renderAction);
  return h('div', { class: 'result', onclick: () => projectDialog(hit, { instance: inst, onInstalled }) },
    avatar(hit),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'r-title ellipsis' }, hit.title), hit.author ? h('span', { class: 'r-author ellipsis' }, `by ${hit.author}`) : null),
      h('div', { class: 'r-sum' }, hit.summary || ''),
      h('div', { class: 'r-meta' },
        ...sources.map((s) => sourceBadge(s.source, s.url)),
        h('span', null, icon('download', 12), ` ${fmtNum(hit.totalDownloads || hit.downloads)}`),
        hit.updated ? h('span', null, `Updated ${ago(hit.updated)}`) : null,
        ...(hit.categories || []).slice(0, 3).map((c) => h('span', { class: 'pill' }, c)))),
    slot);
}

async function quickInstall(hit, inst, versionId, sourceOverride) {
  const source = sourceOverride || hit.source;
  const projectId = sourceOverride ? (hit.alsoOn || []).find((a) => a.source === sourceOverride)?.id : hit.id;
  try {
    if (hit.type === 'modpack') {
      const r = await call('pack:installFromSource', { source, projectId, versionId, title: hit.title });
      await handleInstallResult(r);
      go('instance', { id: r.instance.id });
      return true;
    }
    let target = inst;
    if (!target) target = await pickInstance(hit);
    if (!target) return false;
    const r = await call('content:install', target.id, { source, projectId, type: hit.type, versionId, title: hit.title });
    await handleInstallResult(r, target.id);
    return true;
  } catch (e) {
    if (e.manualUrl) {
      const ok = await confirmDialog('Manual download needed', e.message, 'Open download page');
      if (ok) call('shell:open', e.manualUrl);
    } else toast(e.message, 'error');
    return false;
  }
}

async function pickInstance(hit) {
  const list = await call('inst:list');
  const ok = list.filter((i) => hit.type !== 'mod' || (i.loader?.type && i.loader.type !== 'vanilla'));
  if (!ok.length) {
    const go2 = await confirmDialog('No modded instance yet', 'Create an instance with a mod loader first, then add mods to it.', 'Create instance');
    if (go2) newInstanceDialog();
    return null;
  }
  const installedIn = await Promise.all(ok.map((i) => call('content:installed', i.id).then((inf) => installedMatch(hit, inf)).catch(() => null)));
  return new Promise((resolve) => {
    let picked = false;
    const m = modal({
      title: `Install ${hit.title} to…`,
      body: h('div', { class: 'list' }, ok.map((i, n) => h('div', {
        class: 'item', style: { gridTemplateColumns: '34px 1fr auto', cursor: 'pointer' },
        title: installedIn[n] ? 'Already installed here. Picking it again installs the newest compatible version.' : null,
        onclick: () => { picked = true; m.close(); resolve(i); },
      }, avatar(i, 'sm'), h('div', null, h('div', { class: 'i-title' }, i.name), h('div', { class: 'i-file' }, instSubtitle(i))),
      installedIn[n] ? h('span', { class: 'badge good plain' }, 'Installed') : icon('download')))),
      onClose: () => { if (!picked) resolve(null); },
    });
  });
}

// ----- project details
async function projectDialog(hit, { instance = null, tab = 'about', onInstalled = null } = {}) {
  const alts = [{ source: hit.source, id: hit.id, url: hit.url }, ...(hit.alsoOn || [])];
  let current = alts[0];
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, minHeight: 0 } });
  const head = h('div', { class: 'row', style: { gap: '12px' } }, avatar(hit, 'sm'));
  let activeTab = tab;
  const m = modal({ title: hit.title, body, wide: true, headExtra: head });

  async function show() {
    body.replaceChildren(loading());
    let project;
    try {
      project = await call('browse:project', current.source, current.id);
    } catch (e) {
      body.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), e.message));
      return;
    }
    const type = project.type || hit.type;
    const srcRow = h('div', { class: 'row wrap' },
      alts.length > 1 ? h('div', { class: 'seg' }, alts.map((a) => h('button', { type: 'button', class: a.source === current.source ? 'on' : '', onclick: () => { current = a; show(); } }, SRC[a.source]))) : sourceBadge(current.source, project.url),
      h('span', { class: 'muted small' }, `${fmtNum(project.downloads)} downloads${project.author ? ` · by ${project.author}` : ''}${project.license ? ` · ${project.license}` : ''}`),
      h('div', { class: 'grow' }),
      project.links?.source ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => call('shell:open', project.links.source) }, 'Source') : null,
      project.links?.issues ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => call('shell:open', project.links.issues) }, 'Issues') : null,
      h('button', { class: 'btn sm', type: 'button', onclick: () => call('shell:open', project.url) }, icon('external', 14), `Open on ${SRC[current.source]}`));
    const tabBar = h('div', { class: 'tabs', style: { marginBottom: 0 } });
    const pane = h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } });
    const setTab = (t) => {
      activeTab = t;
      tabBar.replaceChildren(...[['about', 'Description'], ['versions', 'Versions']].map(([k, l]) => h('button', { type: 'button', class: k === t ? 'on' : '', onclick: () => setTab(k) }, l)));
      if (t === 'about') {
        const frame = h('iframe', { class: 'desc-frame', sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer' });
        frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
          body{font-family:system-ui,"Segoe UI",sans-serif;color:#e7e9ee;background:#171a20;margin:18px;line-height:1.6;font-size:14px}
          a{color:#8ea2ff} img,video,iframe{max-width:100%;height:auto;border-radius:6px} pre,code{background:#0f1115;border-radius:5px;padding:2px 5px;font-size:12px;overflow:auto}
          blockquote{border-left:3px solid #2a303a;margin:0;padding:2px 14px;color:#9aa3b2} table{border-collapse:collapse} td,th{border:1px solid #2a303a;padding:4px 8px} h1,h2,h3{line-height:1.25} hr{border:0;border-top:1px solid #2a303a}
          </style></head><body>${project.bodyHtml || `<p>${(project.summary || '').replace(/[<>&]/g, '')}</p>`}</body></html>`;
        pane.replaceChildren(frame);
      } else {
        renderVersions(project, type, pane);
      }
    };
    body.replaceChildren(srcRow, tabBar, pane);
    setTab(activeTab);
  }

  async function renderVersions(project, type, pane) {
    pane.replaceChildren(loading());
    const installed = instance && type !== 'modpack' ? await call('content:installed', instance.id).catch(() => null) : null;
    const mine = installed?.projects[`${current.source}:${current.id}`] || null;
    const filters = instance ? { gameVersion: instance.mcVersion, loader: instance.loader?.type, type } : { gameVersion: browseState.gameVersion, loader: browseState.loader, type };
    try {
      let list;
      if (instance && type !== 'modpack') list = await call('content:compatible', instance.id, current.source, current.id, type);
      else list = await call('browse:versions', current.source, current.id, filters);
      if (!list.length) {
        pane.replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'No matching versions'), h('div', null, instance ? `Nothing for Minecraft ${instance.mcVersion} + ${LOADER[instance.loader?.type] || ''}.` : 'Try clearing the filters on the Browse page.')));
        return;
      }
      const otherSite = !mine && installedMatch({ ...hit, source: current.source, id: current.id }, installed);
      const note = mine
        ? h('div', { class: 'notice info', style: { margin: 0 } }, icon('check'), `Installed in ${instance.name}. Pick another version to switch to it.`)
        : otherSite ? h('div', { class: 'notice info', style: { margin: 0 } }, icon('info'), `${instance.name} already has this mod${otherSite.source ? ` from ${SRC[otherSite.source]}` : ''}. Installing from here replaces that copy.`) : null;
      pane.replaceChildren(note, h('div', { class: 'list vlist', style: { overflow: 'auto', marginTop: note ? '10px' : 0 } }, list.map((v) => {
        const file = v.files.find((f) => f.primary) || v.files[0];
        const isCurrent = mine && String(v.id) === mine.versionId;
        if (isCurrent) {
          return h('div', { class: 'item current' },
            h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis' }, v.name || v.versionNumber), h('div', { class: 'i-file ellipsis' }, file?.filename || '')),
            h('div', { class: 'i-ver ellipsis' }, `${v.gameVersions.slice(0, 3).join(', ')}${v.loaders.length ? ` · ${v.loaders.map((l) => LOADER[l] || l).join(', ')}` : ''}`),
            h('div', null, h('span', { class: `badge plain ${v.releaseType === 'release' ? 'good' : 'warn'}` }, v.releaseType), h('div', { class: 'i-file' }, ago(v.date))),
            h('div', { class: 'i-actions' }, h('span', { class: 'badge good plain' }, icon('check', 12), 'Installed')));
        }
        return h('div', { class: 'item' },
          h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis' }, v.name || v.versionNumber), h('div', { class: 'i-file ellipsis' }, file?.filename || '')),
          h('div', { class: 'i-ver ellipsis', title: `${v.gameVersions.join(', ')} · ${v.loaders.join(', ')}` }, `${v.gameVersions.slice(0, 3).join(', ')}${v.gameVersions.length > 3 ? '…' : ''}${v.loaders.length ? ` · ${v.loaders.map((l) => LOADER[l] || l).join(', ')}` : ''}`),
          h('div', null, h('span', { class: `badge plain ${v.releaseType === 'release' ? 'good' : 'warn'}` }, v.releaseType), h('div', { class: 'i-file' }, ago(v.date))),
          h('div', { class: 'i-actions' }, h('button', {
            class: 'btn sm primary', type: 'button', onclick: async (e) => {
              e.currentTarget.disabled = true;
              const asHit = { ...hit, source: current.source, id: current.id, alsoOn: [], type };
              const ok = await quickInstall(asHit, instance, v.id);
              if (type === 'modpack') { m.close(); return; }
              if (ok) {
                if (onInstalled) await onInstalled();
                renderVersions(project, type, pane);
              }
            },
          }, icon('download', 14), mine ? 'Switch' : 'Install')));
      })));
    } catch (e) {
      pane.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), e.message));
    }
  }
  show();
}

// ----- blocked downloads
function blockedDialog(session, instId) {
  let status = session.status;
  const listBox = h('div', { class: 'list' });
  const render = () => {
    listBox.replaceChildren(...status.map((s) => h('div', { class: 'item', style: { gridTemplateColumns: '22px 1fr auto' } },
      s.done ? h('span', { style: { color: 'var(--good)' } }, icon('check')) : h('div', { class: 'spinner', style: { width: '14px', height: '14px' } }),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis' }, s.title), h('div', { class: 'i-file ellipsis' }, s.error ? `⚠ ${s.error}` : s.fileName)),
      s.done ? h('span', { class: 'badge good plain' }, 'Added') : h('button', { class: 'btn sm', type: 'button', onclick: () => call('shell:open', s.pageUrl) }, icon('external', 14), 'Download page'))));
  };
  render();
  const offUpdate = on('blocked:update', ({ sessionId, status: st }) => { if (sessionId === session.sessionId) { status = st; render(); } });
  const offDone = on('blocked:complete', ({ sessionId }) => {
    if (sessionId !== session.sessionId) return;
    toast('All manual downloads added', 'good');
    m.close();
    if (state.view === 'instance' && state.params.id === instId) go('instance', state.params);
  });
  const m = modal({
    title: `${status.length} file${status.length > 1 ? 's' : ''} ${status.length > 1 ? 'need' : 'needs'} a manual download`,
    body: [
      h('p', { style: { margin: 0, lineHeight: 1.5 } }, 'The authors of these files only allow downloads from the CurseForge website. Click each “Download page” and download it in your browser — Junction watches your Downloads folder and moves each file into place automatically.'),
      h('div', { class: 'hint' }, `Watching: ${session.downloadsDir}`),
      listBox,
    ],
    actions: [
      { label: 'Select files…', icon: 'file', onClick: async () => { const st = await call('blocked:pickFiles', session.sessionId); if (st) { status = st; render(); } return true; } },
      { label: 'Close', class: 'ghost' },
    ],
    onClose: () => { offUpdate(); offDone(); if (status.some((s) => !s.done)) { call('blocked:cancel', session.sessionId); toast('Stopped watching for manual downloads. Missing files can be added later with “Add files”.', 'warn'); } },
  });
}

// ---------------------------------------------------------------- accounts
async function renderAccounts(_p, token) {
  const { accounts, canAddOffline } = await call('accounts:list');
  const info = state.info || (state.info = await call('app:info'));
  if (stale(token)) return;
  const offlineName = h('input', { type: 'text', placeholder: 'Player name', maxlength: 16 });
  view().replaceChildren(h('div', { class: 'page', style: { maxWidth: '820px' } },
    h('div', { class: 'page-head' }, h('h1', null, 'Accounts'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => microsoftLogin() }, icon('login'), 'Add Microsoft account')),
    !info.msConfigured ? h('div', { class: 'notice warn' }, icon('alert'), h('div', { class: 'grow' },
      h('div', null, 'Microsoft sign-in needs an Azure app (client) ID before it can work.'),
      h('div', { class: 'hint' }, 'Mojang must approve new launcher apps. The README walks you through registering one (free) and requesting approval.')),
    h('button', { class: 'btn sm', type: 'button', onclick: () => go('settings') }, 'Settings')) : null,
    accounts.length ? h('div', { class: 'list' }, accounts.map((a) => h('div', { class: 'item', style: { gridTemplateColumns: '34px 1fr auto auto' } },
      avatar({ name: a.name }, 'sm'),
      h('div', null, h('div', { class: 'i-title' }, a.name, a.active ? h('span', { class: 'badge good plain', style: { marginLeft: '8px' } }, 'Active') : null,
        a.needsRelogin ? h('span', { class: 'badge bad plain', style: { marginLeft: '8px' } }, 'Sign in again') : null),
      h('div', { class: 'i-file' }, `${a.type === 'msa' ? 'Microsoft account' : 'Offline account'} · ${a.uuid}`)),
      a.active ? h('span') : h('button', { class: 'btn sm', type: 'button', onclick: async () => { await call('accounts:setActive', a.id); renderAccountChip(); go('accounts'); } }, 'Use'),
      h('button', { class: 'btn sm ghost danger', type: 'button', onclick: async () => {
        if (!(await confirmDialog(`Remove ${a.name}?`, 'You can sign in again any time.', 'Remove', true))) return;
        await call('accounts:remove', a.id); renderAccountChip(); go('accounts');
      } }, icon('trash', 14))))) : h('div', { class: 'empty' }, h('h2', null, 'No accounts'), h('div', null, 'Sign in with the Microsoft account you bought Minecraft with.')),
    h('div', { class: 'section', style: { marginTop: '18px' } }, h('h3', null, 'Offline account'),
      h('p', null, canAddOffline ? 'For singleplayer and offline-mode LAN servers. Online servers will reject it.' : 'Unlocks after you add a Microsoft account that owns Minecraft. Offline accounts can\'t join online servers.'),
      h('div', { class: 'row' }, offlineName, h('button', { class: 'btn', type: 'button', disabled: !canAddOffline, onclick: async () => {
        try { await call('accounts:addOffline', offlineName.value); renderAccountChip(); go('accounts'); } catch (e) { toast(e.message, 'error'); }
      } }, icon('plus'), 'Add'))),
    h('p', { class: 'hint' }, info.encryption ? 'Sign-in tokens are encrypted with your operating system\'s keychain.' : 'Your OS keychain is not available, so tokens are stored obfuscated, not encrypted.'),
  ));
}

async function microsoftLogin() {
  let begin;
  try {
    begin = await call('accounts:beginMs');
  } catch (e) {
    if (e.code === 'NO_CLIENT_ID') {
      const ok = await confirmDialog('Microsoft sign-in isn\'t set up', e.message, 'Open Settings');
      if (ok) go('settings');
    } else toast(e.message, 'error');
    return;
  }
  const status = h('div', { class: 'row muted', style: { justifyContent: 'center' } }, h('div', { class: 'spinner' }), 'Waiting for you to finish signing in…');
  let done = false;
  const m = modal({
    title: 'Sign in with Microsoft',
    body: [
      h('p', { style: { margin: 0 } }, `Go to ${begin.verificationUri} and enter this code:`),
      h('div', { class: 'code-box' }, begin.userCode),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, h('button', { class: 'btn primary', type: 'button', onclick: () => { navigator.clipboard.writeText(begin.userCode); call('shell:open', begin.verificationUri); } }, icon('copy'), 'Copy code & open sign-in page')),
      status,
    ],
    onClose: () => { if (!done) call('accounts:cancelMs', begin.loginId); },
  });
  try {
    const acc = await call('accounts:completeMs', begin.loginId);
    done = true;
    m.close();
    toast(`Signed in as ${acc.name}`, 'good');
    renderAccountChip();
    if (state.view === 'accounts') go('accounts');
  } catch (e) {
    done = true;
    if (e.code !== 'CANCELLED') {
      status.replaceChildren(h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), e.message));
    }
  }
}

// ---------------------------------------------------------------- settings
async function renderSettings(_p, token) {
  const s = await call('settings:get');
  const info = await call('app:info');
  if (stale(token)) return;
  state.settings = s;
  state.info = info;
  const f = {
    msClientId: h('input', { type: 'text', value: s.msClientId || '', placeholder: '00000000-0000-0000-0000-000000000000', spellcheck: 'false' }),
    cfApiKey: h('input', { type: 'password', value: '', placeholder: s.has_cfApiKey ? '•••••••• saved — type to replace' : 'Paste your CurseForge API key', autocomplete: 'off' }),
    memoryMax: h('input', { type: 'number', min: 512, step: 256, value: s.memoryMax }),
    memoryMin: h('input', { type: 'number', min: 256, step: 256, value: s.memoryMin }),
    jvmArgs: h('textarea', { rows: 2, value: s.jvmArgs || '', placeholder: 'Applied to every instance' }),
    javaPath: h('input', { type: 'text', value: s.javaPath || '', placeholder: 'Automatic (recommended)' }),
    concurrency: h('input', { type: 'number', min: 1, max: 64, value: s.concurrency }),
    preferredSource: select([{ value: 'modrinth', label: 'Modrinth' }, { value: 'curseforge', label: 'CurseForge' }], s.preferredSource),
    srcMr: h('input', { type: 'checkbox', checked: s.sources?.modrinth !== false }),
    srcCf: h('input', { type: 'checkbox', checked: s.sources?.curseforge !== false }),
    closeOnLaunch: h('input', { type: 'checkbox', checked: s.closeOnLaunch }),
    showSnapshots: h('input', { type: 'checkbox', checked: s.showSnapshots }),
    includeOptional: h('input', { type: 'checkbox', checked: s.includeOptionalPackFiles }),
  };
  const save = async () => {
    const patch = {
      msClientId: f.msClientId.value.trim(),
      memoryMax: Number(f.memoryMax.value), memoryMin: Number(f.memoryMin.value),
      jvmArgs: f.jvmArgs.value.trim(), javaPath: f.javaPath.value.trim(), concurrency: Number(f.concurrency.value),
      preferredSource: f.preferredSource.value,
      sources: { modrinth: f.srcMr.checked, curseforge: f.srcCf.checked },
      closeOnLaunch: f.closeOnLaunch.checked, showSnapshots: f.showSnapshots.checked, includeOptionalPackFiles: f.includeOptional.checked,
    };
    if (f.cfApiKey.value.trim()) patch.cfApiKey = f.cfApiKey.value.trim();
    state.settings = await call('settings:set', patch);
    state.info = await call('app:info');
    state.mcVersions = null;
    toast('Settings saved', 'good');
    go('settings');
  };
  const link = (label, url) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); call('shell:open', url); } }, label);
  view().replaceChildren(h('div', { class: 'page', style: { maxWidth: '900px' } },
    h('div', { class: 'page-head' }, h('h1', null, 'Settings'), h('button', { class: 'btn primary', type: 'button', onclick: () => save().catch((e) => toast(e.message, 'error')) }, icon('check'), 'Save')),
    h('div', { class: 'section' }, h('h3', null, 'Microsoft sign-in'),
      s.builtin_msClientId
        ? h('p', null, 'Sign-in works out of the box: you sign in on Microsoft\'s own page, so your password never touches Junction.')
        : h('p', null, 'This build has no sign-in app ID. Microsoft requires every launcher to sign in through its own registered Azure app, and Mojang must approve new apps. See “Building it yourself” in the README.'),
      (() => {
        const links = h('div', { class: 'hint', style: { marginTop: '8px' } }, link('Register an app in Azure', 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'), ' · ', link('Request Minecraft API access', 'https://aka.ms/mce-reviewappid'));
        return s.builtin_msClientId
          ? h('details', { class: 'adv', open: Boolean(s.msClientId) }, h('summary', null, 'Advanced: use your own Azure app ID'),
            h('label', { class: 'field' }, 'Azure application (client) ID. Leave empty to use the built-in one.', f.msClientId), links)
          : [h('label', { class: 'field' }, 'Azure application (client) ID', f.msClientId), links];
      })()),
    h('div', { class: 'section' }, h('h3', null, 'CurseForge'),
      s.builtin_cfApiKey
        ? h('p', null, 'CurseForge search and downloads work out of the box with Junction\'s own API key. You can use your own key instead if you have one.')
        : h('p', null, 'CurseForge requires an API key for search and downloads. Get one free from the CurseForge for Studios console. It\'s stored encrypted. Without a key, Junction works with Modrinth only.'),
      (() => {
        const field = h('div', { class: 'row' }, h('label', { class: 'field grow' }, s.builtin_cfApiKey ? 'Your own API key (optional)' : 'API key', f.cfApiKey),
          s.has_cfApiKey ? h('button', { class: 'btn danger', type: 'button', style: { alignSelf: 'flex-end' }, onclick: async () => { await call('settings:set', { cfApiKey: '' }); toast('CurseForge key removed'); go('settings'); } }, 'Remove key') : null);
        const hint = h('div', { class: 'hint', style: { marginTop: '8px' } }, s.has_cfApiKey ? h('span', { style: { color: 'var(--good)' } }, '✓ Your key is saved. ') : null, link('Get a key at console.curseforge.com', 'https://console.curseforge.com/'));
        return s.builtin_cfApiKey ? h('details', { class: 'adv', open: Boolean(s.has_cfApiKey) }, h('summary', null, 'Advanced: use your own CurseForge API key'), field, hint) : [field, hint];
      })()),
    h('div', { class: 'section' }, h('h3', null, 'Sources'),
      h('div', { class: 'row wrap', style: { gap: '22px' } },
        h('label', { class: 'check' }, f.srcMr, 'Search Modrinth'),
        h('label', { class: 'check' }, f.srcCf, 'Search CurseForge'),
        h('label', { class: 'field', style: { minWidth: '220px' } }, 'When a project is on both, prefer', f.preferredSource))),
    h('div', { class: 'section' }, h('h3', null, 'Java & memory defaults'),
      h('p', null, 'Java is downloaded automatically in the exact version each Minecraft release needs (8, 17, 21 or 25). Instances can override all of this.'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Maximum memory (MB)', f.memoryMax),
        h('label', { class: 'field' }, 'Minimum memory (MB)', f.memoryMin),
        h('label', { class: 'field' }, 'Java executable override', f.javaPath)),
      h('label', { class: 'field', style: { marginTop: '14px' } }, 'Global JVM arguments', f.jvmArgs)),
    h('div', { class: 'section' }, h('h3', null, 'Behaviour'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('label', { class: 'check' }, f.closeOnLaunch, 'Hide the launcher while the game is running'),
        h('label', { class: 'check' }, f.showSnapshots, 'Show snapshots when creating instances'),
        h('label', { class: 'check' }, f.includeOptional, 'Include optional files when installing Modrinth packs'),
        h('label', { class: 'field', style: { maxWidth: '260px' } }, 'Parallel downloads', f.concurrency))),
    h('div', { class: 'section' }, h('h3', null, 'Storage & privacy'),
      h('p', null, 'No ads, no telemetry, no account needed to browse. Junction only talks to Mojang, Microsoft (sign-in), Modrinth, CurseForge and the loader download sites.'),
      h('div', { class: 'row' }, h('code', { class: 'grow ellipsis small' }, info.dataDir), h('button', { class: 'btn', type: 'button', onclick: () => call('shell:openData') }, icon('folder'), 'Open data folder')),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, `Junction ${info.version}`)),
  ));
}

// ---------------------------------------------------------------- drag & drop, startup
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files || [])].map((f) => window.junction.pathForFile(f)).filter(Boolean);
  for (const f of files) {
    if (/\.(png|jpe?g|webp|gif)$/i.test(f) && state.view === 'instance' && currentInstance) { await changeIcon(currentInstance, f); continue; }
    if (/\.(mrpack|zip)$/i.test(f)) await importPackFile(f);
    else toast('Drop a .mrpack or CurseForge .zip to import it, or an image on an instance page to use it as its picture.', 'warn');
  }
});

on('app:openFiles', (files) => { for (const f of files) importPackFile(f); });

(async function init() {
  try {
    state.info = await call('app:info');
    state.settings = await call('settings:get');
  } catch (e) {
    toast(e.message, 'error');
  }
  renderNav();
  renderAccountChip();
  go('library');
  for (const t of await call('tasks:list').catch(() => [])) state.tasks.set(t.id, t);
  renderTasks();
  const pending = await call('app:pendingFiles').catch(() => []);
  for (const f of pending) importPackFile(f);
}());
