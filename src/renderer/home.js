'use strict';
// The Home page: Minecraft news, a slim updates bar, your instances and popular modpacks. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

const homeUi = { cache: null, refreshing: false, newsIndex: 0, updOpen: readUpdOpen() };

function readUpdOpen() { try { return localStorage.getItem('junction.home.updOpen') === '1'; } catch { return false; } }
function saveUpdOpen(v) { try { localStorage.setItem('junction.home.updOpen', v ? '1' : '0'); } catch { /* private mode: just not remembered */ } }

async function renderHome(_p, token) {
  // Instant: draw from the cache. Then refresh in the background and redraw if anything changed.
  const data = await call('home:state');
  if (stale(token)) return;
  homeUi.cache = data;
  if (data.updatesStale || data.popularStale) refreshHome(token); // sets "refreshing" at once, so the bar says Checking…
  drawHome(data, token);
}

async function refreshHome(token, force = false) {
  if (homeUi.refreshing) return;
  homeUi.refreshing = true;
  try {
    const data = await call('home:refresh', { force });
    homeUi.cache = data;
    homeUi.refreshing = false;
    if (state.view === 'home' && (token === undefined || !stale(token))) drawHome(data, token);
  } catch { /* offline: keep showing the cache */ } finally { homeUi.refreshing = false; }
}

function homeSection(title, sub, ...kids) {
  return h('section', { class: 'home-sec' },
    h('div', { class: 'home-sec-head' }, h('h2', null, title), sub || null),
    ...kids);
}

/** What the update badges need, per instance, from Home's cached list: { [id]: { count, pack, packVersionId } }. */
function badgeMap(updates) {
  return Object.fromEntries(updates.map((u) => [u.instanceId, { count: u.count, pack: u.pack ? u.pack.versionName : null, packVersionId: u.pack ? u.pack.versionId : null }]));
}

/**
 * The small "↑ 13" (mod updates) or "↑ 4.2.0" (modpack update) badge on an instance card. Clicking it opens that instance's review.
 * `info` comes from the cache only, so it costs no API calls.
 */
function updateBadge(instanceId, info) {
  if (!info || (!info.count && !info.pack)) return null;
  const mods = `${info.count} mod update${info.count === 1 ? '' : 's'}`;
  const tip = info.pack
    ? `Modpack update: ${info.pack} is available${info.count ? `, plus ${mods}` : ''}. Click to review.`
    : `${mods} available. Click to review.`;
  return h('button', {
    class: 'upd-badge', type: 'button', title: tip, 'aria-label': tip,
    onclick: (e) => { e.stopPropagation(); reviewHomeUpdates({ instanceId, count: info.count, pack: info.pack ? { versionId: info.packVersionId, versionName: info.pack } : null }, e.currentTarget); },
  }, `↑ ${info.pack || info.count}`);
}

/** A compact instance card for the sideways row (also what the Library grid uses, with `badge` from the cache). */
function instanceCard(inst, badge) {
  const open = () => go('instance', { id: inst.id });
  return h('div', { class: 'card srow-card inst-card', tabindex: 0, role: 'link', title: instSubtitle(inst), onclick: open,
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); } },
  h('div', { class: 'c-top' }, avatar(inst),
    h('div', { class: 'grow' },
      h('div', { class: 'c-name', title: inst.name }, inst.name),
      h('div', { class: 'c-sub ellipsis' }, `${LOADER[(inst.loader || {}).type] || 'Vanilla'} · ${inst.mcVersion}`))),
  h('div', { class: 'c-foot' }, h('span', { class: 'row' }, badge, inst.pack ? sourceBadge(inst.pack.source === 'file' ? 'file' : inst.pack.source) : null, addedBadge(inst, inst.addedCount)), playButton(inst, 'sm')));
}

// ---------------------------------------------------------------- Minecraft news
const newsDate = (d) => { const t = Date.parse(d); return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };

function drawNews(host, n) {
  const items = n?.enabled ? n.items || [] : [];
  if (!items.length) { host.replaceChildren(); return; }
  homeUi.newsIndex = Math.min(Math.max(0, homeUi.newsIndex), items.length - 1);
  const show = (i) => { homeUi.newsIndex = (i + items.length) % items.length; drawNews(host, n); host.querySelector('.news')?.focus({ preventScroll: true }); };
  const it = items[homeUi.newsIndex];
  const pic = h('div', { class: 'news-pic' });
  if (it.image) {
    const img = h('img', { src: it.image, alt: '', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    pic.append(img);
  }
  const meta = [it.category, newsDate(it.date)].filter(Boolean).join(' · ');
  host.replaceChildren(h('section', { class: 'news', tabindex: 0, role: 'region', 'aria-roledescription': 'carousel', 'aria-label': 'Minecraft news',
    onkeydown: (e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); show(homeUi.newsIndex - 1); } else if (e.key === 'ArrowRight') { e.preventDefault(); show(homeUi.newsIndex + 1); } } },
  h('div', { class: 'news-slide', 'aria-live': 'polite' },
    pic,
    h('div', { class: 'news-text' },
      h('div', { class: 'news-meta' }, meta),
      h('h3', { class: 'news-title', title: it.title }, it.title),
      h('p', { class: 'news-sum' }, it.summary),
      h('div', { class: 'news-foot' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => call('shell:open', it.url) }, 'Read more', icon('external', 13)),
        h('div', { class: 'news-dots' }, items.map((_, i) => h('button', { class: `news-dot${i === homeUi.newsIndex ? ' on' : ''}`, type: 'button', 'aria-label': `News ${i + 1} of ${items.length}`, 'aria-current': i === homeUi.newsIndex ? 'true' : null, onclick: () => show(i) })))))),
  items.length > 1 ? h('button', { class: 'news-arrow prev', type: 'button', 'aria-label': 'Previous news', title: 'Previous', onclick: () => show(homeUi.newsIndex - 1) }, icon('chevronDown', 18)) : null,
  items.length > 1 ? h('button', { class: 'news-arrow next', type: 'button', 'aria-label': 'Next news', title: 'Next', onclick: () => show(homeUi.newsIndex + 1) }, icon('chevronDown', 18)) : null));
}

/** Shows the cached news at once, then looks for newer news in the background (never blocks the page). */
async function fillNews(host, token) {
  try {
    const n = await call('news:get');
    if (stale(token)) return;
    drawNews(host, n);
    if (n.enabled && n.stale) {
      const r = await call('news:refresh');
      if (!stale(token)) drawNews(host, r);
    }
  } catch { /* no news is fine */ }
}

// ---------------------------------------------------------------- updates bar
function updatesBar(d) {
  const checking = homeUi.refreshing && d.updatesStale;
  const checked = checking ? 'Checking…' : d.updatesCheckedAt ? `Checked ${ago(d.updatesCheckedAt)}` : 'Not checked yet';
  if (!d.updates.length) {
    return h('div', { class: 'upd-line' }, checking ? h('div', { class: 'spinner', style: { width: '13px', height: '13px' } }) : icon('check', 14),
      checking ? 'Checking…' : d.updatesCheckedAt ? `Everything is up to date · ${checked.toLowerCase()}` : 'Junction checks for updates in the background.');
  }
  const open = homeUi.updOpen;
  const shown = d.updates.slice(0, 5);
  const more = d.updates.length - shown.length;
  const modsOnly = d.summary.mods > 0;
  const onlyPack = !modsOnly && d.updates.length === 1;
  const reviewAllBtn = modsOnly || onlyPack
    ? h('button', { class: 'btn sm primary', type: 'button', onclick: (e) => (modsOnly ? reviewAllUpdates(e.currentTarget) : reviewHomeUpdates(d.updates[0], e.currentTarget)) }, icon('arrowUp', 14), modsOnly ? 'Review all' : 'Review')
    : null;
  const toggle = h('button', { class: `btn ghost icon sm upd-toggle${open ? ' open' : ''}`, type: 'button', 'aria-expanded': String(open), title: open ? 'Hide the list' : 'Show the list',
    onclick: () => { homeUi.updOpen = !homeUi.updOpen; saveUpdOpen(homeUi.updOpen); if (homeUi.cache) drawHome(homeUi.cache, renderTokenNow()); } }, icon('chevronDown', 16));
  const bar = h('div', { class: 'upd-bar' },
    h('div', { class: 'upd-stack', 'aria-hidden': 'true' }, ...shown.map((u) => avatar({ ...u, iconSrc: u.iconSrc }, 'sm')), more > 0 ? h('div', { class: 'avatar sm upd-more' }, `+${more}`) : null),
    h('div', { class: 'upd-text grow' }, d.summary.text),
    h('span', { class: 'muted small upd-checked' }, checked),
    reviewAllBtn, toggle);
  const rows = open ? h('div', { class: 'upd-rows' }, d.updates.map((u) => h('div', { class: 'upd-mini' },
    avatar(u, 'sm'),
    h('div', { class: 'upd-mini-name ellipsis', title: u.name }, u.name),
    h('div', { class: 'muted small upd-mini-what' }, [u.pack ? `${u.pack.versionName} available` : null, u.count ? `${u.count} ${u.pack ? 'mod ' : ''}update${u.count === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')),
    h('button', { class: 'btn sm', type: 'button', onclick: (e) => reviewHomeUpdates(u, e.currentTarget) }, 'Review')))) : null;
  return h('div', { class: 'upd-wrap' }, bar, rows);
}

// ---------------------------------------------------------------- page
let homeRenderToken;
const renderTokenNow = () => homeRenderToken;

function drawHome(d, token) {
  homeRenderToken = token;
  const sections = [];

  if (state.settings?.showNews !== false) {
    const host = h('div', { class: 'news-host' });
    sections.push(host);
    fillNews(host, token);
  }

  if (d.empty) {
    sections.push(homeSection('Welcome to Junction', null, h('div', { class: 'empty' },
      h('h2', null, 'No instances yet'),
      h('div', null, 'Make your own, or install a modpack from Modrinth or CurseForge.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary lg', type: 'button', onclick: () => newInstanceDialog() }, icon('plus'), 'New instance'),
        h('button', { class: 'btn lg', type: 'button', onclick: () => go('browse', { type: 'modpack' }) }, icon('box'), 'Browse modpacks')))));
  } else {
    for (const i of d.recent) if (i.state) state.running.set(i.id, i.state);
    sections.push(h('div', { class: 'home-sec upd-sec-home' }, updatesBar(d)));
    const badges = badgeMap(d.updates);
    sections.push(homeSection('Your instances',
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => go('library') }, 'See all →'),
      scrollRow(d.recent.map((inst) => instanceCard(inst, updateBadge(inst.id, badges[inst.id]))), { label: 'Your instances', cardWidth: '232px' })));
  }

  const hits = d.popular || [];
  sections.push(homeSection('Popular modpacks',
    h('button', { class: 'btn ghost sm', type: 'button', onclick: () => go('browse', { type: 'modpack' }) }, 'See all →'),
    hits.length ? scrollRow(hits.map(popularCard), { label: 'Popular modpacks', cardWidth: '300px' })
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
  return h('div', { class: 'card home-card srow-card', onclick: () => projectDialog(hit, {}) },
    h('div', { class: 'c-top' }, avatar(hit),
      h('div', { class: 'grow' },
        h('div', { class: 'c-name', title: hit.title }, hit.title),
        h('div', { class: 'c-sub ellipsis' }, [hit.author ? `by ${hit.author}` : null, `${fmtNum(hit.totalDownloads || hit.downloads)} downloads`].filter(Boolean).join(' · ')))),
    h('div', { class: 'home-sum' }, hit.summary || ''),
    h('div', { class: 'c-foot' },
      h('span', { class: 'row' }, ...sources.map((s) => sourceBadge(s.source, s.url))),
      btn));
}

/** Redraw whichever page shows update badges after a review changed something. */
function afterUpdateReview() {
  if (state.view === 'home' || state.view === 'library') go(state.view);
}

/** Runs a fresh check for that instance (it is the quick path, one instance only), then opens the normal review window. */
async function reviewHomeUpdates(u, btn) {
  // A new modpack version: its review window lives on the instance page.
  if (u.pack) { go('instance', { id: u.instanceId, review: u.pack.versionId }); return; }
  btn.disabled = true;
  try {
    const inst = await call('inst:get', u.instanceId).catch((e) => { if (/Instance not found/.test(e.message)) return null; throw e; });
    if (!inst) { go('library'); return; } // deleted since the list was drawn
    const res = (await call('content:checkUpdates', u.instanceId)).filter((x) => !x.error);
    if (!res.length) { toast(`${inst.name} is already up to date.`, 'good'); await refreshHome(undefined, false); afterUpdateReview(); return; }
    updateReviewDialog(inst, res, afterUpdateReview);
  } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
}

/** "Review all": one window with a section per instance that has mod updates. Modpack updates have their own review window (their rows open it). */
async function reviewAllUpdates(btn) {
  const targets = (homeUi.cache?.updates || []).filter((u) => u.count > 0);
  if (!targets.length) return;
  btn.disabled = true;
  const label = btn.textContent;
  const groups = new Array(targets.length).fill(null);
  let next = 0; let doneN = 0; let failed = 0;
  const worker = async () => {
    while (next < targets.length) {
      const i = next++;
      try {
        const inst = await call('inst:get', targets[i].instanceId);
        const res = (await call('content:checkUpdates', targets[i].instanceId)).filter((x) => !x.error);
        if (res.length) groups[i] = { inst, updates: res };
      } catch { failed++; }
      btn.replaceChildren(`Checking ${Math.min(++doneN, targets.length)}/${targets.length}…`);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
    const found = groups.filter(Boolean);
    if (!found.length) {
      toast(failed ? "Couldn't check for updates right now. Try again in a minute." : 'Everything is already up to date.', failed ? 'warn' : 'good');
      await refreshHome(undefined, false);
      afterUpdateReview();
      return;
    }
    multiUpdateReviewDialog(found, afterUpdateReview);
  } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; btn.replaceChildren(icon('arrowUp', 14), label); }
}
