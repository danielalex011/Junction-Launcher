'use strict';
// The Home page: jump back in, updates available, popular modpacks. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

const homeUi = { cache: null, refreshing: false };

async function renderHome(_p, token) {
  // Instant: draw from the cache. Then refresh in the background and redraw if anything changed.
  const data = await call('home:state');
  if (stale(token)) return;
  homeUi.cache = data;
  drawHome(data);
  if (data.updatesStale || data.popularStale) refreshHome(token);
}

async function refreshHome(token, force = false) {
  if (homeUi.refreshing) return;
  homeUi.refreshing = true;
  try {
    const data = await call('home:refresh', { force });
    homeUi.cache = data;
    if (state.view === 'home' && (token === undefined || !stale(token))) drawHome(data);
  } catch { /* offline: keep showing the cache */ } finally { homeUi.refreshing = false; }
}

function homeSection(title, sub, ...kids) {
  return h('section', { class: 'home-sec' },
    h('div', { class: 'home-sec-head' }, h('h2', null, title), sub || null),
    ...kids);
}

function drawHome(d) {
  const recentTitle = d.fallback ? 'Your instances' : 'Jump back in';
  const sections = [];

  if (d.empty) {
    sections.push(homeSection('Welcome to Junction', null, h('div', { class: 'empty' },
      h('h2', null, 'No instances yet'),
      h('div', null, 'Make your own, or install a modpack from Modrinth or CurseForge.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary lg', type: 'button', onclick: () => newInstanceDialog() }, icon('plus'), 'New instance'),
        h('button', { class: 'btn lg', type: 'button', onclick: () => go('browse', { type: 'modpack' }) }, icon('box'), 'Browse modpacks')))));
  } else {
    for (const i of d.recent) if (i.state) state.running.set(i.id, i.state);
    sections.push(homeSection(recentTitle, d.fallback ? h('span', { class: 'muted small' }, 'Nothing played yet, so here are the newest ones') : null,
      h('div', { class: 'home-recent' }, d.recent.map((inst) => h('div', { class: 'card home-card', tabindex: 0, role: 'link', onclick: () => go('instance', { id: inst.id }),
        onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) go('instance', { id: inst.id }); } },
      h('div', { class: 'c-top' }, avatar(inst),
        h('div', { class: 'grow' },
          h('div', { class: 'c-name', title: inst.name }, inst.name),
          h('div', { class: 'c-sub', title: instSubtitle(inst) }, instSubtitle(inst)))),
      h('div', { class: 'c-foot' },
        h('span', null, inst.lastPlayed ? `Played ${ago(inst.lastPlayed)}` : 'Never played'),
        playButton(inst, 'sm')))))));
  }

  if (!d.empty) {
    const rows = d.updates.map((u) => h('div', { class: 'item home-upd' },
      h('div', { class: 'grow' },
        h('div', { class: 'i-title ellipsis' }, u.name),
        h('div', { class: 'i-file' }, `${u.count} update${u.count === 1 ? '' : 's'} available`)),
      h('button', { class: 'btn sm primary', type: 'button', onclick: (e) => reviewHomeUpdates(u, e.currentTarget) }, icon('arrowUp'), 'Review')));
    const checking = homeUi.refreshing && d.updatesStale;
    sections.push(homeSection('Updates available',
      h('span', { class: 'muted small' }, checking ? 'Checking…' : d.updatesCheckedAt ? `Checked ${ago(d.updatesCheckedAt)}` : 'Not checked yet'),
      rows.length ? h('div', { class: 'list' }, rows)
        : h('div', { class: 'home-note' }, checking ? 'Checking your instances for updates…' : d.updatesCheckedAt ? 'Everything is up to date.' : 'Junction checks in the background.')));
  }

  const hits = d.popular || [];
  sections.push(homeSection('Popular modpacks',
    h('button', { class: 'btn ghost sm', type: 'button', onclick: () => go('browse', { type: 'modpack' }) }, 'See all →'),
    hits.length ? h('div', { class: 'home-popular' }, hits.map(popularCard))
      : h('div', { class: 'home-note' }, homeUi.refreshing ? 'Loading popular modpacks…' : 'Popular modpacks will show up here once Junction can reach Modrinth or CurseForge.')));

  view().replaceChildren(h('div', { class: 'page page-full home' },
    h('div', { class: 'page-head' }, h('h1', null, 'Home')), ...sections));
}

function popularCard(hit) {
  const sources = [{ source: hit.source, url: hit.url }, ...(hit.alsoOn || [])];
  const btn = h('button', { class: 'btn primary sm', type: 'button' }, icon('download'), 'Install');
  btn.onclick = async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    try { await quickInstall(hit, null); } finally { btn.disabled = false; }
  };
  return h('div', { class: 'card home-card', onclick: () => projectDialog(hit, {}) },
    h('div', { class: 'c-top' }, avatar(hit),
      h('div', { class: 'grow' },
        h('div', { class: 'c-name', title: hit.title }, hit.title),
        h('div', { class: 'c-sub' }, [hit.author ? `by ${hit.author}` : null, `${fmtNum(hit.totalDownloads || hit.downloads)} downloads`].filter(Boolean).join(' · ')))),
    h('div', { class: 'home-sum' }, hit.summary || ''),
    h('div', { class: 'c-foot' },
      h('span', { class: 'row' }, ...sources.map((s) => sourceBadge(s.source, s.url))),
      btn));
}

/** Runs a fresh check for that instance (it is the quick path, one instance only), then opens the normal review window. */
async function reviewHomeUpdates(u, btn) {
  btn.disabled = true;
  try {
    const inst = await call('inst:get', u.instanceId);
    const res = (await call('content:checkUpdates', u.instanceId)).filter((x) => !x.error);
    if (!res.length) { toast(`${inst.name} is already up to date.`, 'good'); await refreshHome(undefined, false); return; }
    updateReviewDialog(inst, res, () => { if (state.view === 'home') go('home'); });
  } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
}
