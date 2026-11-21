'use strict';
// App state, navigation, drag & drop and startup. Loaded last: it runs init(). Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ---------------------------------------------------------------- state
const state = {
  view: 'home',
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
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'library', label: 'Library', icon: 'grid' },
  { id: 'browse', label: 'Browse', icon: 'compass' },
  { id: 'skins', label: 'Skins', icon: 'shirt' },
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
  if (state.view === 'skins' && viewName !== 'skins') skinsLeave();
  state.view = viewName;
  state.params = params;
  renderNav();
  const token = ++renderToken;
  view().scrollTop = 0;
  const pages = { home: renderHome, library: renderLibrary, instance: renderInstance, browse: renderBrowse, skins: renderSkins, settings: renderSettings };
  try {
    await pages[viewName](params, token);
  } catch (e) {
    if (token === renderToken) view().replaceChildren(h('div', { class: 'page' }, h('div', { class: 'notice warn' }, icon('alert'), e.message)));
  }
}
const stale = (token) => token !== renderToken;

// ---------------------------------------------------------------- drag & drop, startup
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { $('#drop-hint').textContent = state.view === 'skins' ? 'Drop a skin (64×64 PNG) to add it to your wardrobe' : 'Drop a .mrpack or CurseForge .zip to import it'; dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files || [])].map((f) => window.junction.pathForFile(f)).filter(Boolean);
  for (const f of files) {
    if (/\.png$/i.test(f) && state.view === 'skins') { await skinsAddFromPath(f); continue; }
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
  go('home');
  initActivity();
  const snap = await call('tasks:list').catch(() => ({ active: [], history: [] }));
  for (const t of snap.active) state.tasks.set(t.id, t);
  activityUi.history = snap.history;
  renderActivity();
  renderHistory();
  const pending = await call('app:pendingFiles').catch(() => []);
  for (const f of pending) importPackFile(f);
}());
