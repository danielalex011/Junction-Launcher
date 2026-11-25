'use strict';
// The Browse page and project details. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ---------------------------------------------------------------- browse
const browseState = { type: 'mod', query: '', gameVersion: '', loader: '', sort: 'relevance', sources: ['modrinth', 'curseforge'], page: 0, categories: [], environment: '' }; // categories: the picked merged categories' keys (a project must match all); environment: '' | 'client' | 'server'
let browseCategories = []; // the merged list for the current tab: [{ key, label, modrinth, curseforge }]

// What the filter panel remembers between visits: which sections are collapsed and whether the panel is open on a narrow window.
function browseUiGet() { try { return JSON.parse(localStorage.getItem('junction.browsePanel') || '{}') || {}; } catch { return {}; } }
function browseUiSet(patch) { try { localStorage.setItem('junction.browsePanel', JSON.stringify({ ...browseUiGet(), ...patch })); } catch { /* private window: it just isn't remembered */ } }

/** The picked categories as the merged entries (a key that is not in this tab's list is dropped). */
function pickedCats() { return browseState.categories.map((k) => browseCategories.find((c) => c.key === k)).filter(Boolean); }
/** Does this tab have an Environment filter? Only mods and modpacks, and only Modrinth can answer it. */
const browseHasEnv = () => browseState.type === 'mod' || browseState.type === 'modpack';
/** A category tile's icon: from the bundled Lucide set (vendor/category-icons.js), a generic tag when there is no match. Static SVG, never API text. */
function catIcon(key, size = 16) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CATEGORY_ICONS[key] || CATEGORY_ICON_GENERIC}</svg>`;
  return s;
}
/** Which of the sites the person has switched on can answer the current filters (same rule as the search itself). */
function browseSitesNow(info) {
  const on = browseState.sources.filter((x) => x !== 'curseforge' || info.cfConfigured);
  const cats = pickedCats();
  return on.filter((x) => cats.every((c) => c[x] !== null && c[x] !== undefined) && !(browseState.environment && browseHasEnv() && x === 'curseforge'));
}

async function renderBrowse(params, token) {
  const s = state.settings || (state.settings = await call('settings:get'));
  const info = state.info || (state.info = await call('app:info'));
  let inst = null;
  if (params.instanceId) {
    inst = await call('inst:get', params.instanceId).catch(() => null);
  }
  if (params.type) browseState.type = params.type;
  if (typeof params.query === 'string') browseState.query = params.query; // from the quick search's "Search Browse for…" row
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
      const r = await call('browse:search', { ...browseState, categories: pickedCats().map((c) => ({ modrinth: c.modrinth, curseforge: c.curseforge })), environment: browseHasEnv() ? browseState.environment : '', pageSize: 20 });
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
    onclick: () => { browseState.type = k; browseState.categories = []; browseState.environment = ''; if (k !== 'mod' && k !== 'modpack') browseState.loader = ''; else if (inst) browseState.loader = inst.loader?.type === 'vanilla' ? '' : inst.loader?.type; go('browse', { instanceId: inst?.id, type: k }); },
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
  // ---- the filter panel: Loader, Category and Environment sections, chips for what is picked, and a note when a site is left out
  const chipsBox = h('div', { class: 'fchips' });
  const noteBox = h('div');
  const panelBody = h('div', { class: 'fp-body' });
  const panel = h('aside', { class: `filter-panel${browseUiGet().panelOpen ? ' open' : ''}`, 'aria-label': 'Filters' }, panelBody);
  const filtersBtn = h('button', {
    type: 'button', class: 'btn filters-toggle', 'aria-expanded': String(Boolean(browseUiGet().panelOpen)),
    onclick: () => { const open = !panel.classList.contains('open'); panel.classList.toggle('open', open); filtersBtn.setAttribute('aria-expanded', String(open)); browseUiSet({ panelOpen: open }); },
  }, icon('sliders', 15), 'Filters');
  const catSearch = h('input', { type: 'search', class: 'fp-search', placeholder: 'Find a category…', 'aria-label': 'Find a category', oninput: () => paintCats() });
  const catBody = h('div');
  const expandedGroups = new Set(); // which category groups show everything instead of the first 6
  const sectionCounts = {}; // section id -> the little number in its heading

  const SITE_NAME = { modrinth: 'Modrinth', curseforge: 'CurseForge' };
  const dots = (sites) => h('span', { class: 'site-dots', 'aria-hidden': 'true' }, sites.map((x) => h('i', { class: `dot ${x}` })));
  const loadedFocus = (id) => { const el = panel.querySelector(`[data-f="${id}"]`); if (el) el.focus(); };

  const changed = (focusId) => { paintChips(); paintCats(); paintLoader(); paintEnv(); paintNote(); if (focusId) loadedFocus(focusId); doSearch(); };

  function section(id, title, bodyEl) {
    const collapsed = Boolean(browseUiGet().collapsed?.[id]);
    const count = h('span', { class: 'count' });
    sectionCounts[id] = count;
    const body = h('div', { class: 'fp-sec-body', hidden: collapsed }, bodyEl);
    const head = h('button', {
      type: 'button', class: 'fp-sec-head', 'aria-expanded': String(!collapsed), 'aria-controls': `fp-${id}`,
      onclick: () => {
        const nowCollapsed = !body.hidden;
        body.hidden = nowCollapsed;
        head.setAttribute('aria-expanded', String(!nowCollapsed));
        head.classList.toggle('collapsed', nowCollapsed);
        browseUiSet({ collapsed: { ...(browseUiGet().collapsed || {}), [id]: nowCollapsed } });
      },
    }, h('span', { class: 'grow' }, title), count, icon('chevronDown', 15));
    head.classList.toggle('collapsed', collapsed);
    body.id = `fp-${id}`;
    return h('section', { class: 'fp-sec' }, head, body);
  }
  const setCount = (id, n) => { const el = sectionCounts[id]; if (el) { el.textContent = n ? String(n) : ''; el.hidden = !n; } };

  // Loader (mods and modpacks): one at a time. In an instance the loader is the instance's own, so it is shown but locked.
  const loaderBody = h('div', { class: 'tiles' });
  function paintLoader() {
    loaderBody.replaceChildren(...[['', 'Any'], ...['fabric', 'quilt', 'forge', 'neoforge'].map((l) => [l, LOADER[l]])].map(([v, label]) => {
      const on = browseState.loader === v;
      return h('button', {
        type: 'button', class: `tile${on ? ' on' : ''}`, 'aria-pressed': String(on), disabled: Boolean(inst), 'data-f': `loader-${v || 'any'}`,
        onclick: () => { browseState.loader = v; changed(`loader-${v || 'any'}`); },
      }, h('span', { class: 'tile-name' }, label), on ? icon('check', 13) : null);
    }));
    setCount('loader', browseState.loader ? 1 : 0);
  }

  // Environment (mods and modpacks): "works on the client / server". Only Modrinth knows this, so CurseForge is left out while it is set.
  const envBody = h('div', null);
  function paintEnv() {
    envBody.replaceChildren(h('div', { class: 'tiles' }, [['', 'Any'], ['client', 'Client side'], ['server', 'Server side']].map(([v, label]) => {
      const on = browseState.environment === v;
      return h('button', {
        type: 'button', class: `tile${on ? ' on' : ''}`, 'aria-pressed': String(on), 'data-f': `env-${v || 'any'}`,
        onclick: () => { browseState.environment = v; changed(`env-${v || 'any'}`); },
      }, h('span', { class: 'tile-name' }, label), on ? icon('check', 13) : null);
    })), h('div', { class: 'fp-hint' }, dots(['modrinth']), 'Only Modrinth knows this.'));
    setCount('env', browseState.environment ? 1 : 0);
  }

  // Category: groups by where the category exists, first 6 of each, a search field when the list is long.
  const GROUPS = [
    ['both', 'Both sites', ['modrinth', 'curseforge'], (c) => c.modrinth && c.curseforge],
    ['modrinth', 'Modrinth only', ['modrinth'], (c) => c.modrinth && !c.curseforge],
    ['curseforge', 'CurseForge only', ['curseforge'], (c) => c.curseforge && !c.modrinth],
  ];
  function toggleCat(key) {
    const has = browseState.categories.includes(key);
    browseState.categories = has ? browseState.categories.filter((k) => k !== key) : [...browseState.categories, key];
    changed(`cat-${key}`);
  }
  function paintCats() {
    const list = browseCategories;
    const q = catSearch.value.trim().toLowerCase();
    catSearch.hidden = list.length <= 12;
    setCount('category', browseState.categories.length);
    if (!list.length) { catBody.replaceChildren(h('div', { class: 'fp-hint' }, 'No categories to show right now.')); return; }
    const out = [];
    for (const [gid, title, sites, test] of GROUPS) {
      const all = list.filter(test).filter((c) => !q || c.label.toLowerCase().includes(q));
      if (!all.length) continue;
      const open = q || expandedGroups.has(gid);
      let shown = all;
      if (!open && all.length > 6) shown = all.filter((c, i) => i < 6 || browseState.categories.includes(c.key)); // a picked one never hides
      const hidden = all.length - shown.length;
      out.push(h('div', { class: 'cat-group' },
        h('div', { class: 'cat-group-head' }, dots(sites), title),
        h('div', { class: 'tiles two' }, shown.map((c) => {
          const on = browseState.categories.includes(c.key);
          return h('button', {
            type: 'button', class: `tile cat${on ? ' on' : ''}`, 'aria-pressed': String(on), 'data-f': `cat-${c.key}`, title: c.label,
            onclick: () => toggleCat(c.key),
          }, catIcon(c.key), h('span', { class: 'tile-name' }, c.label), on ? icon('check', 13) : null);
        })),
        hidden > 0 || (!q && expandedGroups.has(gid) && all.length > 6)
          ? h('button', { type: 'button', class: 'more-btn', 'data-f': `more-${gid}`, 'aria-expanded': String(Boolean(open)), onclick: () => { if (expandedGroups.has(gid)) expandedGroups.delete(gid); else expandedGroups.add(gid); paintCats(); loadedFocus(`more-${gid}`); } },
            hidden > 0 ? `+${hidden} more` : 'Show fewer')
          : null));
    }
    catBody.replaceChildren(...(out.length ? out : [h('div', { class: 'fp-hint' }, 'No category has that name.')]));
  }

  // The chips above the results: everything that is picked, each removable, and "Clear all".
  function paintChips() {
    const chips = [];
    const chip = (label, onremove, lead) => h('span', { class: 'fchip' }, lead || null, h('span', null, label),
      h('button', { type: 'button', 'aria-label': `Remove filter ${label}`, onclick: onremove }, icon('x', 12)));
    if (browseState.loader && !inst) chips.push(chip(LOADER[browseState.loader] || browseState.loader, () => { browseState.loader = ''; changed(); }));
    for (const c of pickedCats()) chips.push(chip(c.label, () => { browseState.categories = browseState.categories.filter((k) => k !== c.key); changed(); }, catIcon(c.key, 13)));
    if (browseState.environment && browseHasEnv()) chips.push(chip(browseState.environment === 'client' ? 'Client side' : 'Server side', () => { browseState.environment = ''; changed(); }));
    chipsBox.hidden = !chips.length;
    chipsBox.replaceChildren(...chips, chips.length ? h('button', {
      type: 'button', class: 'btn ghost sm', onclick: () => { browseState.categories = []; browseState.environment = ''; if (!inst) browseState.loader = ''; changed(); },
    }, 'Clear all') : null);
  }

  // Plain words when a site cannot answer what is picked, so a missing result is never a mystery.
  function paintNote() {
    const cats = pickedCats();
    const on = browseState.sources.filter((x) => x !== 'curseforge' || info.cfConfigured);
    const ok = browseSitesNow(info);
    const msgs = [];
    if (on.length && !ok.length) {
      msgs.push('No single site has all of these together, so nothing can match. Remove one filter to see results.');
    } else {
      for (const x of on.filter((y) => !ok.includes(y))) {
        const lacking = cats.filter((c) => c[x] === null || c[x] === undefined).map((c) => c.label);
        const other = SITE_NAME[ok[0]];
        if (lacking.length) msgs.push(`${lacking.join(', ')} ${lacking.length > 1 ? 'are' : 'is'} only on ${other}, so ${SITE_NAME[x]} results are hidden.`);
        else if (browseState.environment && browseHasEnv()) msgs.push(`${SITE_NAME[x]} can't filter by client or server side, so its results are hidden.`);
      }
    }
    noteBox.replaceChildren(...msgs.map((m) => h('div', { class: 'notice info', role: 'status' }, icon('info'), m)));
  }

  panelBody.append(
    browseState.type === 'mod' || browseState.type === 'modpack' ? section('loader', 'Loader', loaderBody) : null,
    section('category', 'Category', h('div', null, catSearch, catBody)),
    browseHasEnv() ? section('env', 'Environment', envBody) : null);
  browseCategories = [];
  paintLoader(); paintEnv(); paintCats(); paintChips(); paintNote();
  call('browse:categories', browseState.type).then((list) => {
    if (stale(token)) return;
    browseCategories = list;
    const had = browseState.categories.length;
    browseState.categories = browseState.categories.filter((k) => list.some((c) => c.key === k));
    paintCats(); paintChips(); paintNote();
    if (had) doSearch(); // categories picked on an earlier visit only count now that the list is here
  }).catch(() => { /* offline: the panel just has no categories */ });

  const top = h('div', { class: 'browse-top' },
    inst ? h('div', { class: 'context-bar' }, avatar(inst, 'xs'), h('div', { class: 'grow' }, h('b', null, `Adding to ${inst.name}`), h('span', { class: 'muted' }, ` · ${instSubtitle(inst)}`)),
      h('button', { class: 'btn sm', type: 'button', onclick: () => go('instance', { id: inst.id, tab: browseState.type }) }, icon('arrowLeft', 14), 'Back to instance')) : null,
    h('div', { class: 'row wrap' }, h('div', { class: 'search' }, icon('search', 18), input), typeSeg),
    h('div', { class: 'filters' },
      select([{ value: '', label: 'All versions' }, ...versions.map((v) => ({ value: v.id, label: v.id }))], browseState.gameVersion, (v) => { browseState.gameVersion = v; doSearch(); }, { disabled: Boolean(inst) }),
      select([{ value: 'relevance', label: 'Relevance' }, { value: 'downloads', label: 'Most downloads' }, { value: 'follows', label: 'Most followed' }, { value: 'updated', label: 'Recently updated' }, { value: 'newest', label: 'Newest' }], browseState.sort, (v) => { browseState.sort = v; doSearch(); }),
      filtersBtn,
      h('div', { class: 'grow' }),
      srcToggle('modrinth'), srcToggle('curseforge')));
  view().replaceChildren(top, h('div', { class: 'browse-body' }, h('div', { class: 'browse-layout' }, h('div', { class: 'browse-main' }, chipsBox, noteBox, warnBox, results, more), panel)));
  // the filter panel sticks just under the search bar, whatever height that is
  const fitPanel = () => view().style.setProperty('--browse-top-h', `${top.offsetHeight}px`);
  fitPanel();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitPanel).observe(top);
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
    if (match?.fromPack && inst.linked) {
      slot.replaceChildren(h('button', { class: 'btn installed', type: 'button', disabled: true, title: `Already included in ${inst.pack?.name || 'the modpack'}` }, icon('lock'), 'In the modpack'));
      return;
    }
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
  try {
    let target = inst;
    if (hit.type !== 'modpack') {
      if (!target) target = await pickInstance(hit);
      if (!target) return false;
    }
    let source = sourceOverride || hit.source;
    let projectId = sourceOverride ? (hit.alsoOn || []).find((a) => a.source === sourceOverride)?.id : hit.id;
    if (!sourceOverride && !versionId) {
      const choice = await chooseSource(hit, target);
      if (!choice) return false;
      ({ source, projectId } = choice);
    }
    if (hit.type === 'modpack') {
      const r = await installPackChecked({ source, projectId, versionId, title: hit.title });
      if (r.cancelled) return false; // low disk space and the user chose Cancel
      await handleInstallResult(r);
      go('instance', { id: r.instance.id });
      return true;
    }
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

/** Which site to install a project from: the saved preference, or the "Install from…" window when it's on both and the setting is Ask. */
async function chooseSource(hit, target) {
  const alts = [{ source: hit.source, id: hit.id, url: hit.url }, ...(hit.alsoOn || [])];
  if (alts.length < 2) return { source: hit.source, projectId: hit.id };
  const s = state.settings || (state.settings = await call('settings:get'));
  const pref = s.preferredSource || 'ask';
  if (pref !== 'ask') {
    const a = alts.find((x) => x.source === pref) || alts[0];
    return { source: a.source, projectId: a.id };
  }
  return installFromDialog(hit, alts, target);
}

function installFromDialog(hit, alts, target) {
  return new Promise((resolve) => {
    let answered = false;
    const isPack = hit.type === 'modpack';
    const remember = h('input', { type: 'checkbox' });
    const body = h('div', { class: 'src-compare' }, loading('Checking Modrinth and CurseForge…'));
    const m = modal({ title: `Install ${hit.title} from…`, body, wide: true, onClose: () => { if (!answered) resolve(null); } });
    m.el.classList.add('fit');
    const pick = async (o) => {
      answered = true;
      if (remember.checked) {
        try {
          state.settings = await call('settings:set', { preferredSource: o.source });
          toast(`Saved: Install will use ${SRC[o.source]} from now on. You can change this in Settings → Sources.`);
        } catch (e) { toast(e.message, 'error'); }
      }
      m.close();
      resolve({ source: o.source, projectId: o.projectId });
    };
    const card = (o) => {
      const v = o.version;
      const rows = [];
      if (v) {
        rows.push(h('div', { class: 'sc-ver' }, v.name || v.versionNumber));
        rows.push(h('div', { class: 'sc-meta' },
          h('span', { class: `badge plain ${v.releaseType === 'release' ? 'good' : 'warn'}` }, v.releaseType),
          h('span', null, v.date ? `${new Date(v.date).toLocaleDateString()} (${ago(v.date)})` : ''),
          v.downloads != null ? h('span', null, icon('download', 12), ` ${fmtNum(v.downloads)}`) : null,
          v.size ? h('span', null, fmtBytes(v.size)) : null));
        if (isPack) rows.push(h('div', { class: 'sc-pack' }, `Minecraft ${v.gameVersions.join(', ') || 'unknown'} · ${v.loaders.map((l) => LOADER[l] || l).join(', ') || 'loader not listed'}`));
        if (isPack && o.source === 'curseforge') rows.push(h('div', { class: 'hint' }, 'CurseForge packs can include mods that need a manual download. Junction will guide you through those.'));
        if (v.manualDownload) rows.push(h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), isPack ? 'The author only allows downloads from the CurseForge website. Junction opens the page, then installs the zip once it lands in your Downloads folder.' : 'The author only allows downloads from the CurseForge website, so you will be sent there.'));
      } else {
        rows.push(h('div', { class: 'sc-why' }, o.reason || 'Nothing to install.'));
      }
      return h('div', { class: `src-card ${v ? '' : 'off'}` },
        h('div', { class: 'row', style: { gap: '8px' } }, sourceBadge(o.source, o.url), o.newer ? h('span', { class: 'badge good plain' }, 'Newer') : null),
        ...rows,
        v ? h('button', { class: 'btn primary', type: 'button', onclick: () => pick(o) }, v.manualDownload ? icon('external') : icon('download'), v.manualDownload ? `Open on ${SRC[o.source]}` : `Install from ${SRC[o.source]}`) : null);
    };
    call('browse:compareSources', { alts, type: hit.type, instanceId: target?.id }).then((r) => {
      const usable = r.options.filter((o) => o.version);
      const where = target && !isPack ? ` for Minecraft ${target.mcVersion}` : '';
      const intro = !usable.length
        ? h('div', { class: 'notice warn' }, icon('alert'), `Neither Modrinth nor CurseForge has a version of ${hit.title}${where} that Junction can install.`)
        : r.only
          ? h('div', { class: 'notice info' }, icon('info'), `Only ${SRC[r.only]} has a version${where} that fits, so that's the one to install.`)
          : h('p', { class: 'muted', style: { margin: 0 } }, isPack ? 'On both sites. This is the newest version of the pack on each.' : `On both sites. This is the version Junction would install${target ? ` into ${target.name}` : ''} from each.`);
      body.replaceChildren(intro,
        h('div', { class: 'src-cols' }, r.options.map(card)),
        r.notes.length ? h('ul', { class: 'sc-notes' }, r.notes.map((n) => h('li', null, n))) : null,
        usable.length ? h('label', { class: 'check' }, remember, 'Remember my choice (change it later in Settings → Sources)') : null,
        h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'Cancel')));
    }).catch((e) => body.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), e.message)));
  });
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
      alts.length > 1 ? h('button', {
        class: 'btn sm primary', type: 'button', onclick: async (e) => {
          e.currentTarget.disabled = true;
          const ok = await quickInstall({ ...hit, type }, instance);
          if (type === 'modpack') { if (ok) m.close(); return; }
          if (ok && onInstalled) await onInstalled();
          e.currentTarget.disabled = false;
        },
      }, icon('download', 14), 'Install') : null,
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
        const f = frameTheme();
        frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
          :root{color-scheme:${f.light ? 'light' : 'dark'}}
          body{font-family:system-ui,"Segoe UI",sans-serif;color:${f.text};background:${f.bg};margin:18px;line-height:1.6;font-size:14px}
          a{color:${f.accent}} img,video,iframe{max-width:100%;height:auto;border-radius:6px} pre,code{background:${f.code};border-radius:5px;padding:2px 5px;font-size:12px;overflow:auto}
          blockquote{border-left:3px solid ${f.border};margin:0;padding:2px 14px;color:${f.muted}} table{border-collapse:collapse} td,th{border:1px solid ${f.border};padding:4px 8px} h1,h2,h3{line-height:1.25} hr{border:0;border-top:1px solid ${f.border}}
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
