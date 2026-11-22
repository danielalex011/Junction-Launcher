'use strict';
// Quick search (Ctrl+K): one box that finds instances, installed mods, pages and actions. Everything is matched locally;
// only the last row ("Search Browse for …") goes online, and only after you pick it. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

const QS_RECENT_KEY = 'junction.qs.recent';
const QS_MAX_MODS = 5;
const QS_KIND_LABEL = { instance: 'Instance', mod: 'Mod', page: 'Page', action: 'Action', browse: 'Browse', more: '' };
const qsUi = { root: null };

function qsLoadRecent() { try { const r = JSON.parse(localStorage.getItem(QS_RECENT_KEY) || '[]'); return Array.isArray(r) ? r.filter((x) => typeof x === 'string').slice(0, 8) : []; } catch { return []; } }
function qsRemember(id) { try { localStorage.setItem(QS_RECENT_KEY, JSON.stringify([id, ...qsLoadRecent().filter((x) => x !== id)].slice(0, 8))); } catch { /* not remembered */ } }

/** Pages and actions that don't depend on your data. */
function qsFixedItems() {
  const page = (id, label, ic) => ({ id: `page:${id}`, kind: 'page', title: label, sub: 'Page', icon: ic, keywords: [id], run: () => go(id) });
  const act = (id, title, ic, kw, run) => ({ id: `act:${id}`, kind: 'action', title, icon: ic, keywords: kw, run });
  return [
    page('home', 'Home', 'home'), page('library', 'Library', 'grid'), page('browse', 'Browse', 'compass'), page('skins', 'Skins', 'shirt'), page('settings', 'Settings', 'sliders'),
    act('new', 'New instance', 'plus', ['create', 'add instance'], () => newInstanceDialog()),
    act('import-file', 'Import a modpack file', 'login', ['import', 'mrpack', 'zip', 'curseforge pack'], () => importPackFile()),
    act('import-launchers', 'Import instances from other launchers', 'login', ['import', 'prism', 'modrinth app', 'curseforge app'], () => importFromLaunchers()),
    act('updates', 'Check for updates', 'refresh', ['update', 'mods', 'modpack'], () => qsCheckUpdates()),
    act('account', 'Add Microsoft account', 'user', ['sign in', 'login', 'minecraft account'], () => microsoftLogin()),
    act('data', 'Open data folder', 'folder', ['files', 'directory'], () => call('shell:openData')),
    act('set-general', 'General settings', 'sliders', ['settings', 'start page', 'notification', 'launch', 'snapshots', 'news', 'sign in', 'curseforge key'], () => go('settings', { tab: 'general' })),
    act('appearance', 'Appearance settings', 'sliders', ['settings', 'theme', 'accent', 'colour', 'color', 'background', 'sidebar', 'size'], () => go('settings', { tab: 'appearance' })),
    act('set-memory', 'Memory settings', 'sliders', ['settings', 'ram', 'xmx', 'gigabytes', 'gb', 'heap'], () => go('settings', { tab: 'memory' })),
    act('set-java', 'Java settings', 'sliders', ['settings', 'jvm', 'runtime', 'jdk', 'graalvm', 'arguments', 'flags'], () => go('settings', { tab: 'java' })),
    act('set-storage', 'Downloads & storage settings', 'sliders', ['settings', 'cache', 'speed limit', 'parallel', 'backups', 'logs', 'disk'], () => go('settings', { tab: 'storage' })),
    act('set-about', 'About Junction', 'info', ['settings', 'version', 'licenses', 'github', 'debug info', 'update channel'], () => go('settings', { tab: 'about' })),
  ];
}

function qsInstanceItems(insts) {
  const out = [];
  for (const inst of insts) {
    out.push({ id: `inst:${inst.id}`, kind: 'instance', title: inst.name, sub: instSubtitle(inst), inst, keywords: [LOADER[(inst.loader || {}).type] || '', inst.mcVersion, 'play', 'open'], run: () => go('instance', { id: inst.id }) });
    out.push({ id: `logs:${inst.id}`, kind: 'action', title: `Open logs of ${inst.name}`, icon: 'terminal', queryOnly: true, keywords: ['log', 'crash', 'latest.log'], run: () => go('instance', { id: inst.id, tab: 'logs' }) });
  }
  return out;
}

async function qsCheckUpdates() {
  toast('Checking your instances for updates…', 'info', 2500);
  await refreshHome(undefined, true);
  const s = homeUi.cache?.summary;
  toast(s?.text ? s.text : 'Everything is up to date.', s?.text ? 'info' : 'good', 6000);
  if (state.view === 'home') go('home');
}

function closeQuickSearch() {
  const q = qsUi.root;
  if (!q) return;
  qsUi.root = null;
  q.el.remove();
  document.removeEventListener('focusin', q.trap, true);
  try { q.prev?.focus({ preventScroll: true }); } catch { /* the old element is gone */ }
}

function openQuickSearch() {
  if (qsUi.root) { closeQuickSearch(); return; }
  const prev = document.activeElement;
  let insts = [];
  let mods = [];
  let rows = [];
  let sel = 0;
  let showAllMods = false;
  const fixed = qsFixedItems();

  const input = h('input', { type: 'text', class: 'qs-input', placeholder: 'Search instances, mods, pages and actions…', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'qs-list', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Quick search' });
  const list = h('div', { class: 'qs-list', id: 'qs-list', role: 'listbox' });
  const el = h('div', { class: 'qs-backdrop', onmousedown: (e) => { if (e.target === el) closeQuickSearch(); } },
    h('div', { class: 'qs', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick search' },
      h('div', { class: 'qs-head' }, icon('search', 18), input, h('kbd', null, 'Esc')),
      list,
      h('div', { class: 'qs-foot' }, h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' move'), h('span', null, h('kbd', null, 'Enter'), ' open'),
        h('span', null, h('kbd', null, 'Ctrl'), '+', h('kbd', null, 'Enter'), ' play'), h('span', null, h('kbd', null, 'Alt'), '+', h('kbd', null, 'Enter'), ' folder'))));
  const trap = (e) => { if (!el.contains(e.target)) input.focus(); };
  qsUi.root = { el, prev, trap };
  document.addEventListener('focusin', trap, true);
  document.body.append(el);
  input.focus();

  const run = (row, how) => {
    const { item } = row;
    if (item.kind === 'more') { showAllMods = true; render(); return; }
    closeQuickSearch();
    if (item.kind !== 'browse') qsRemember(item.id);
    if (item.inst && how === 'play') play(item.inst);
    else if (item.inst && how === 'folder') call('inst:openFolder', item.inst.id).catch((e) => toast(e.message, 'error'));
    else item.run();
  };

  const render = () => {
    const text = input.value.trim();
    const modItems = mods.map((m) => ({ id: `mod:${m.instanceId}:${m.file}`, kind: 'mod', title: m.title, sub: `in ${m.instanceName}`, version: m.version, keywords: [m.version], run: () => go('instance', { id: m.instanceId, tab: 'mod' }) }));
    const ranked = JunctionSearch.rank(text, [...qsInstanceItems(insts), ...fixed, ...(text ? modItems : [])], { recent: qsLoadRecent(), limit: 60 });
    const modCount = ranked.filter((r) => r.item.kind === 'mod').length;
    let shownMods = 0;
    const limit = showAllMods ? Infinity : QS_MAX_MODS;
    rows = ranked.filter((r) => r.item.kind !== 'mod' || ++shownMods <= limit).slice(0, showAllMods ? 80 : 30);
    if (!showAllMods && modCount > QS_MAX_MODS) {
      const hidden = modCount - QS_MAX_MODS;
      rows.push({ item: { id: 'more-mods', kind: 'more', title: `Show ${hidden} more mod${hidden === 1 ? '' : 's'}`, icon: 'box', run: () => {} }, score: 0 });
    }
    if (text) rows.push({ item: { id: 'browse', kind: 'browse', title: `Search Browse for “${text}”`, sub: 'Modrinth and CurseForge', icon: 'compass', run: () => go('browse', { query: text }) }, score: 0 });
    sel = Math.min(sel, rows.length - 1);
    list.replaceChildren(...rows.map((row, i) => {
      const it = row.item;
      const lead = it.inst ? avatar(it.inst, 'xs') : h('span', { class: 'qs-ico' }, icon(it.icon || (it.kind === 'mod' ? 'box' : 'puzzle'), 16));
      return h('div', { class: `qs-row${i === sel ? ' on' : ''}`, role: 'option', id: `qs-opt-${i}`, 'aria-selected': String(i === sel),
        onmousemove: () => { if (sel !== i) { sel = i; mark(); } }, onclick: () => run(row) },
      lead,
      h('div', { class: 'qs-main' }, h('span', { class: 'qs-title' }, it.title), it.sub && it.kind !== 'page' ? h('span', { class: 'qs-sub' }, ` · ${it.sub}${it.version ? ` · ${it.version}` : ''}`) : null),
      it.inst ? h('span', { class: 'qs-acts' },
        h('button', { class: 'btn sm good', type: 'button', tabindex: -1, onclick: (e) => { e.stopPropagation(); run(row, 'play'); } }, icon('play', 13), 'Play'),
        h('button', { class: 'btn sm', type: 'button', tabindex: -1, onclick: (e) => { e.stopPropagation(); run(row, 'folder'); } }, icon('folder', 13), 'Folder')) : null,
      h('span', { class: 'qs-kind' }, QS_KIND_LABEL[it.kind]));
    }));
    input.setAttribute('aria-activedescendant', rows.length ? `qs-opt-${sel}` : '');
  };
  const mark = () => {
    [...list.children].forEach((c, i) => { c.classList.toggle('on', i === sel); c.setAttribute('aria-selected', String(i === sel)); });
    input.setAttribute('aria-activedescendant', `qs-opt-${sel}`);
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => { sel = 0; showAllMods = false; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeQuickSearch(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) { sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; mark(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rows[sel]) run(rows[sel], e.ctrlKey || e.metaKey ? 'play' : e.altKey ? 'folder' : undefined);
    } else if (e.key === 'Tab') e.preventDefault();
  });
  render();
  Promise.all([call('inst:list').catch(() => []), call('quick:mods').catch(() => [])]).then(([i, m]) => {
    if (qsUi.root?.el !== el) return;
    insts = i; mods = m;
    render();
  });
}
