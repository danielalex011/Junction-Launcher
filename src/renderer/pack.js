'use strict';
// The instance page of a linked modpack (Modrinth or CurseForge): pack header, Content / Changelog / Logs / Settings,
// the pack update review window and the Modpack settings section. Plain script: shares one global scope with the
// other src/renderer files (load order is in index.html).

const CONTENT_TYPES = ['mod', 'resourcepack', 'shader', 'datapack'];
const packUi = { info: new Map() }; // instance id -> pack header info (icon, author, tags, banner)

function loaderLabel(inst) {
  const l = inst.loader || {};
  return l.type && l.type !== 'vanilla' ? `${LOADER[l.type] || l.type} ${l.version || ''}`.trim() : 'Vanilla';
}

async function renderPackInstance(inst, params, token) {
  const id = inst.id;
  // Old links point at a content type directly ("mod", "shader", ...): those live under Content now.
  let tab = params.tab || 'content';
  let sub = params.sub || 'mod';
  if (CONTENT_TYPES.includes(tab)) { sub = tab; tab = 'content'; }
  const tabs = [
    { id: 'content', label: 'Content', icon: 'box' },
    { id: 'changelog', label: 'Changelog', icon: 'file' },
    { id: 'logs', label: 'Logs', icon: 'terminal' },
    { id: 'settings', label: 'Settings', icon: 'sliders' },
  ];
  if (!tabs.find((t) => t.id === tab)) tab = 'content';

  const hero = packHero(inst, token);
  const tabBar = h('div', { class: 'tabs' }, tabs.map((t) => h('button', {
    type: 'button', class: t.id === tab ? 'on' : '', onclick: () => go('instance', { id, tab: t.id }),
  }, icon(t.icon), t.label)));
  const back = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => go('library'), style: { marginBottom: '12px' } }, icon('arrowLeft'), 'Library');
  const failedSlot = h('div');
  const body = h('div');
  view().replaceChildren(h('div', { class: 'page page-full instance-page' }, back, hero.el, failedSlot, tabBar, body));
  call('content:failed', id).then((list) => {
    if (!stale(token) && list?.length) failedSlot.replaceChildren(failedNotice(inst, list, () => go('instance', state.params)));
  }).catch(() => {});

  // Opened from Home's "Review": go straight to the review window.
  if (params.review) packReviewDialog(inst, { id: params.review });

  if (tab === 'content') {
    // Once per pack version: work out which files are the pack's (instances from before Junction kept these labels).
    body.replaceChildren(loading('Sorting pack content from your additions…'));
    try {
      const r = await call('pack:label', id);
      if (!r?.skipped && r?.changed) toast(r.changed === 1 ? `1 pack file is different from the pack's version. It's marked "Changed".` : `${r.changed} pack files are different from the pack's version. They're marked "Changed".`, 'info', 7000);
    } catch (e) { toast(`Couldn't read ${inst.pack.name}'s file list: ${e.message}`, 'warn', 8000); }
    if (stale(token)) return;
    await renderPackContent(inst, sub, body, token);
  } else if (tab === 'changelog') await renderPackChangelog(inst, body, token);
  else if (tab === 'logs') await renderLogsTab(inst, body);
  else await renderInstSettings(inst, body);
}

// ---------------------------------------------------------------- header
function packHero(inst, token) {
  const bg = h('div', { class: 'ph-bg' });
  const title = h('h1', { class: 'ph-title', title: inst.pack.name }, inst.name);
  const byline = h('div', { class: 'ph-by' });
  const tags = h('div', { class: 'ph-tags' });
  const pill = h('div', { class: 'ph-version' });
  const undoSlot = h('span');
  const iconBtn = h('button', {
    class: 'avatar-edit', type: 'button', title: 'Change picture (or drop an image here)',
    onclick: (e) => iconMenu(e.currentTarget, inst),
  }, avatar(inst, 'lg'), h('span', { class: 'avatar-edit-hint' }, 'Change'));
  const meta = h('div', { class: 'ph-meta' },
    h('span', null, icon('clock', 14), inst.lastPlayed ? `Played ${ago(inst.lastPlayed)}` : 'Never played'),
    h('span', null, icon('activity', 14), `${fmtDuration(inst.playtimeMs)} played`),
    h('span', null, icon('box', 14), `Minecraft ${inst.mcVersion}`),
    h('span', null, icon('puzzle', 14), loaderLabel(inst)));
  const el = h('div', { class: 'pack-hero' }, bg,
    h('div', { class: 'ph-main' },
      iconBtn,
      h('div', { class: 'ph-text' },
        h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, title, sourceBadge(inst.pack.source, inst.pack.url)),
        byline, tags,
        h('div', { class: 'row wrap', style: { gap: '8px', marginTop: '10px' } }, pill, undoSlot),
        meta),
      h('div', { class: 'ph-actions' },
        h('button', { class: 'btn icon', type: 'button', title: 'Open folder', onclick: () => call('inst:openFolder', inst.id) }, icon('folder', 18)),
        h('button', { class: 'btn icon', type: 'button', title: 'More', onclick: (e) => instanceMenu(e.currentTarget, inst) }, icon('more', 18)),
        h('span', { id: 'inst-play' }, playButton(inst, 'lg')))));

  const drawPill = (u, checking = false) => {
    const switchBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => switchVersionDialog(inst) }, icon('refresh', 14), 'Switch version');
    if (checking) {
      pill.replaceChildren(h('span', { class: 'vpill' }, inst.pack.versionName || '?', h('span', { class: 'faint' }, ' · Checking…')), switchBtn);
    } else if (u) {
      pill.replaceChildren(
        h('span', { class: 'vpill new', title: `You have ${inst.pack.versionName}` }, icon('arrowUp', 13), `${u.versionName} available`),
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => packReviewDialog(inst, { id: u.versionId, versionNumber: u.versionName }) }, 'Update'),
        switchBtn);
    } else {
      pill.replaceChildren(h('span', { class: 'vpill ok' }, inst.pack.versionName || '?', h('span', null, ' · Up to date')), switchBtn);
    }
  };
  drawPill(null, true);
  call('pack:checkUpdate', inst.id).then((u) => { if (!stale(token)) drawPill(u); }).catch(() => {
    if (!stale(token)) pill.replaceChildren(h('span', { class: 'vpill' }, inst.pack.versionName || '?', h('span', { class: 'faint' }, " · Couldn't check")),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => switchVersionDialog(inst) }, icon('refresh', 14), 'Switch version'));
  });

  const drawInfo = (info) => {
    if (!info) return;
    if (info.author) byline.replaceChildren(`by ${info.author}`);
    tags.replaceChildren(...(info.tags || []).map((t) => h('span', { class: 'ph-tag' }, String(t).replace(/-/g, ' '))));
    if (info.banner && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(info.banner)) {
      bg.style.backgroundImage = `url("${info.banner.replace(/["\\\n\r]/g, '')}")`;
      el.classList.add('has-banner');
    }
  };
  if (packUi.info.has(inst.id)) drawInfo(packUi.info.get(inst.id));
  call('pack:info', inst.id).then((info) => { packUi.info.set(inst.id, info); if (!stale(token)) drawInfo(info); }).catch(() => {});

  call('pack:history', inst.id).then((hist) => {
    const last = hist?.[0];
    if (!last || stale(token)) return;
    const what = last.action === 'reinstall' ? 'reinstall' : 'update';
    const back = last.from ? ` (back to ${last.from})` : '';
    undoSlot.replaceChildren(h('button', {
      class: 'btn sm ghost', type: 'button', title: `Puts back the mods, configs and settings from before the ${what} (${ago(last.date)}).`,
      onclick: async () => {
        if (!(await confirmDialog(`Undo the ${what}?`, `This puts ${inst.name} back exactly as it was before (${last.from || 'the previous version'}): mods, resource packs, shaders and config files. Worlds are not touched.`, 'Undo'))) return;
        try { await call('pack:undo', inst.id, last.stamp); toast(`Back to ${last.from || 'the previous version'}`, 'good'); go('instance', { id: inst.id }); } catch (e) { toast(e.message, 'error'); }
      },
    }, icon('undo', 14), `Undo ${what}${back}`));
  }).catch(() => {});
  return { el };
}

// ---------------------------------------------------------------- content: sub-tabs + the list
async function renderPackContent(inst, sub, root, token) {
  const counts = await call('content:counts', inst.id).catch(() => ({}));
  if (stale(token)) return;
  const subs = CONTENT_TYPES.filter((t) => t !== 'datapack' || counts.datapack > 0).filter((t) => t !== 'mod' || inst.loader?.type !== 'vanilla');
  if (!subs.includes(sub)) sub = subs[0];
  const bar = h('div', { class: 'subtabs' }, subs.map((t) => h('button', {
    type: 'button', class: t === sub ? 'on' : '', onclick: () => go('instance', { id: inst.id, tab: 'content', sub: t }),
  }, TYPES[t], h('span', { class: 'count' }, String(counts[t] ?? 0)))));
  const list = h('div');
  root.replaceChildren(bar, list);
  await renderContentTab(inst, sub, list, token);
}

// ---------------------------------------------------------------- changelog
async function renderPackChangelog(inst, root, token) {
  root.replaceChildren(loading('Loading the changelog…'));
  let list;
  try { list = await call('pack:changelog', inst.id); } catch (e) { root.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), e.message)); return; }
  if (stale(token)) return;
  const newer = list.filter((v) => v.newer).length;
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sections = list.map((v) => `<section class="${v.newer ? 'newer' : v.current ? 'current' : ''}">
    <header><b>${esc(v.versionNumber)}</b>${v.newer ? '<span class="tag new">Newer</span>' : ''}${v.current ? '<span class="tag cur">Installed</span>' : ''}${v.releaseType && v.releaseType !== 'release' ? `<span class="tag">${esc(v.releaseType)}</span>` : ''}<span class="date">${esc(new Date(v.date).toLocaleDateString())}</span></header>
    <div class="body">${v.html || '<p class="none">No changelog for this version.</p>'}</div></section>`).join('');
  const frame = h('iframe', { class: 'desc-frame changelog-frame', sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer' });
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    body{font:14px/1.55 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;color:#e6e9ef;background:#171a20;margin:0;padding:14px 18px}
    a{color:#8ea2ff} img,video,iframe{max-width:100%;height:auto;border-radius:6px} pre,code{background:#0f1115;border-radius:5px;padding:2px 5px;font-size:12px;overflow:auto}
    section{border:1px solid #2a2f3a;border-radius:10px;padding:12px 16px;margin:0 0 12px;background:#1b1f26}
    section.newer{border-color:#4a5ad0;background:#1b2033;box-shadow:inset 3px 0 0 #8ea2ff}
    section.current{border-color:#2c5e48}
    header{display:flex;align-items:center;gap:8px;font-size:15px;margin-bottom:6px}
    .tag{font-size:11px;font-weight:700;padding:1px 8px;border-radius:20px;background:#252a33;color:#9aa3b2}
    .tag.new{background:rgba(142,162,255,.18);color:#8ea2ff}.tag.cur{background:rgba(60,207,142,.14);color:#3ccf8e}
    .date{margin-left:auto;color:#6b7383;font-size:12px}.none{color:#6b7383;margin:0}
    h1,h2,h3{font-size:15px;margin:12px 0 6px} ul{padding-left:20px;margin:6px 0}
  </style></head><body>${sections || '<p class="none">This modpack has no changelogs.</p>'}</body></html>`;
  root.replaceChildren(
    h('div', { class: 'toolbar' },
      newer ? h('span', { class: 'badge plain', style: { color: 'var(--accent)', background: 'rgba(142,162,255,.14)' } }, `${newer} newer version${newer === 1 ? '' : 's'}`) : h('span', { class: 'muted small' }, `You have the newest version (${inst.pack.versionName}).`),
      h('span', { class: 'muted small' }, newer ? 'Highlighted below: read what\'s coming before you update.' : ''),
      h('div', { class: 'grow' }),
      inst.pack.url ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => call('shell:open', inst.pack.url) }, icon('external', 14), `Open on ${SRC[inst.pack.source]}`) : null),
    frame);
}

// ---------------------------------------------------------------- switch version
async function switchVersionDialog(inst) {
  const box = h('div', { class: 'list pick-list', style: { maxHeight: '420px' } }, loading());
  let chosen = null;
  let goBtn;
  const m = modal({
    title: `Switch ${inst.pack.name} version`,
    body: [h('p', { style: { margin: 0, color: 'var(--muted)', lineHeight: 1.5 } }, 'Pick a version. Nothing changes until you have reviewed what it adds, removes and updates.'), box],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      { label: 'Review', class: 'primary', icon: 'check', disabled: true, onClick: () => { packReviewDialog(inst, chosen); } },
    ],
  });
  goBtn = m.el.querySelectorAll('.m-foot .btn')[1];
  try {
    const list = await call('pack:versions', inst.id);
    const draw = () => box.replaceChildren(...list.map((v) => h('div', {
      class: `item pick-row ${chosen?.id === v.id ? 'selected' : ''}`, onclick: () => { if (v.current) return; chosen = v; goBtn.disabled = false; draw(); },
      title: v.current ? 'This is the version you have' : null,
    }, h('input', { type: 'radio', name: 'pv', checked: chosen?.id === v.id, disabled: v.current }), releaseBadge(v.releaseType),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'i-title ellipsis' }, v.versionNumber, v.current ? h('span', { class: 'badge good plain', style: { marginLeft: '8px' } }, 'Installed') : null),
      h('div', { class: 'i-file ellipsis' }, `${ago(v.date)}${v.gameVersions?.length ? ` · Minecraft ${v.gameVersions.join(', ')}` : ''}`)))));
    draw();
  } catch (e) { box.replaceChildren(h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), e.message)); }
}

// ---------------------------------------------------------------- review window (update / switch)
async function packReviewDialog(inst, target) {
  const body = h('div', { class: 'pack-review' }, loading('Reading both versions of the modpack…'));
  let goBtn;
  const running = state.running.get(inst.id) === 'running';
  const m = modal({
    title: `Update ${inst.pack.name}`,
    body: [body],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      { label: 'Update', class: 'primary', icon: 'arrowUp', disabled: true, onClick: async () => {
        const r = await call('pack:apply', inst.id, target.id, { action: 'update' });
        await handleInstallResult({ ...r, installed: [] }, inst.id);
        if (r.removedCovered?.length) toast(`Removed your own copy of ${r.removedCovered.slice(0, 3).join(', ')}${r.removedCovered.length > 3 ? ` and ${r.removedCovered.length - 3} more` : ''}: the pack includes ${r.removedCovered.length === 1 ? 'it' : 'them'} now.`, 'info', 9000);
        toast(`${inst.pack.name} is on ${target.versionNumber || 'the new version'}. Use "Undo update" if something breaks.`, 'good', 8000);
        go('instance', { id: inst.id });
      } },
    ],
  });
  m.el.style.width = 'min(880px, 100%)';
  goBtn = m.el.querySelectorAll('.m-foot .btn')[1];
  let p;
  try { p = await call('pack:preview', inst.id, target.id); } catch (e) { body.replaceChildren(h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), e.message)); return; }
  const older = new Date(p.to.date) < new Date(p.from.date || 0);
  m.el.querySelector('.m-head h2').textContent = `${older ? 'Switch' : 'Update'} ${inst.pack.name} to ${p.to.versionName}`;
  goBtn.replaceChildren(icon('arrowUp'), `${older ? 'Switch' : 'Update'} to ${p.to.versionName}`);
  goBtn.disabled = running;

  const modRow = (r, kind) => h('div', { class: `item rv-row ${kind}` },
    avatar({ icon: r.icon, title: r.title }, 'xs'),
    h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis', title: r.title }, r.title), h('div', { class: 'i-file ellipsis' }, TYPES[r.type] || '')),
    kind === 'upd' && r.sameName ? h('div', { class: 'rv-ver ellipsis', title: `${r.toVersionName}: same file name, new contents` }, h('b', null, r.toVersionName), h('span', { class: 'faint' }, ' (new contents)'))
      : kind === 'upd' ? h('div', { class: 'rv-ver ellipsis', title: `${r.fromVersionName} → ${r.toVersionName}` }, h('span', { class: 'faint' }, r.fromVersionName || '?'), ' → ', h('b', null, r.toVersionName || '?'))
      : h('div', { class: 'rv-ver ellipsis' }, r.toVersionName || ''));
  const group = (title, cls, rows, render, open = true) => (rows.length ? h('details', { class: 'rv-group', open },
    h('summary', null, h('span', { class: `rv-dot ${cls}` }), `${title}`, h('span', { class: 'count' }, String(rows.length))),
    h('div', { class: 'list rv-list' }, rows.map(render))) : null);
  const cfg = [...p.config.changed.map((r) => ['Changed', r]), ...p.config.added.map((r) => ['New', r]), ...p.config.removed.map((r) => ['No longer in the pack', r])];
  const gameChange = p.to.mcVersion !== p.from.mcVersion || p.to.loader?.type !== p.from.loader?.type || p.to.loader?.version !== p.from.loader?.version;
  body.replaceChildren(
    h('div', { class: 'rv-head' },
      h('span', { class: 'vpill' }, p.from.versionName || '?'), icon('arrowLeft', 14), h('span', { class: `vpill ${older ? '' : 'new'}` }, p.to.versionName), releaseBadge(p.to.releaseType),
      h('span', { class: 'muted small' }, `${p.updated.length} updated · ${p.added.length} added · ${p.removed.length} removed · ${p.unchanged} unchanged`)),
    gameChange ? h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'),
      `This version moves to Minecraft ${p.to.mcVersion} with ${LOADER[p.to.loader?.type] || p.to.loader?.type} ${p.to.loader?.version || ''} (you have ${p.from.mcVersion}, ${loaderLabel(inst)}). Make a copy of your worlds first: worlds opened in a newer version can't safely go back.`) : null,
    p.exact ? null : h('div', { class: 'notice info', style: { margin: 0 } }, icon('info'), "The installed version couldn't be read, so this compares with the files that are in the instance now."),
    group('Updated', 'upd', p.updated, (r) => modRow(r, 'upd')),
    group('Added by the pack', 'add', p.added, (r) => modRow(r, 'add')),
    group('Removed by the pack', 'del', p.removed, (r) => modRow(r, 'del')),
    cfg.length ? h('details', { class: 'rv-group' },
      h('summary', null, h('span', { class: 'rv-dot cfg' }), 'Config files', h('span', { class: 'count' }, String(cfg.length))),
      h('div', { class: 'rv-cfg' }, cfg.map(([k, r]) => h('div', null, h('span', { class: `badge plain ${k === 'No longer in the pack' ? 'bad' : k === 'New' ? 'good' : 'warn'}` }, k), h('code', null, r))))) : null,
    h('div', { class: 'rv-keep' },
      h('div', null, icon('check', 14), p.keptAdditions ? (p.keptAdditions === 1 ? '1 file you added yourself stays.' : `${p.keptAdditions} files you added yourself stay.`) : 'You have no additions of your own.'),
      p.keptDisabled.length ? h('div', null, icon('check', 14), `${p.keptDisabled.length === 1 ? '1 pack mod you turned off stays off' : `${p.keptDisabled.length} pack mods you turned off stay off`}: ${p.keptDisabled.slice(0, 4).join(', ')}${p.keptDisabled.length > 4 ? '…' : ''}`) : null,
      ...(p.replacedChanged || []).map((c) => h('div', { class: 'warn' }, icon('alert', 14), c.replaced
        ? `${c.title}: your changed file is replaced with the pack's version.`
        : `${c.title}: your changed file is removed, because ${p.to.versionName} no longer includes it.`)),
      p.covered.length ? h('div', { class: 'warn' }, icon('alert', 14), `The pack now includes ${p.covered.map((c) => c.title).slice(0, 4).join(', ')}${p.covered.length > 4 ? ` and ${p.covered.length - 4} more` : ''}, so your own cop${p.covered.length === 1 ? 'y is' : 'ies are'} removed.`) : null,
      h('div', null, icon('info', 14), 'Mods, resource packs, shaders and configs are backed up first, so you can undo this.')),
    running ? h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), 'Minecraft is running from this instance. Close the game first.') : null);
}

// ---------------------------------------------------------------- Settings → Modpack
function packSettingsSection(inst) {
  const info = packUi.info.get(inst.id);
  return h('div', { class: 'section pack-settings' }, h('h3', null, 'Modpack'),
    h('p', null, `This instance follows ${inst.pack.name}. The pack decides the Minecraft version, the loader and its own mods; you can add your own on top.`),
    h('div', { class: 'ps-installed' },
      avatar({ icon: info?.icon || inst.iconSrc || inst.icon, title: inst.pack.name }, 'sm'),
      h('div', { class: 'grow', style: { minWidth: 0 } },
        h('div', { class: 'i-title ellipsis' }, inst.pack.name),
        h('div', { class: 'muted small' }, `Version ${inst.pack.versionName || '?'} · ${SRC[inst.pack.source]}`)),
      h('button', { class: 'btn', type: 'button', onclick: () => switchVersionDialog(inst) }, icon('refresh'), 'Change version')),
    h('div', { class: 'ps-actions' },
      psAction('Repair', 'Downloads any pack file that is missing or damaged again. Your additions and configs are left alone.', h('button', { class: 'btn', type: 'button', onclick: () => repairFlow(inst) }, icon('refresh'), 'Repair')),
      psAction('Reinstall modpack', `Resets the pack's mods and configs to ${inst.pack.versionName}. A backup is made first.`, h('button', { class: 'btn', type: 'button', onclick: () => reinstallDialog(inst) }, icon('download'), 'Reinstall…')),
      psAction('Unlink modpack', 'Turns this into a normal instance. Everything can be edited, including the loader and Minecraft version, but there are no more pack updates.', h('button', { class: 'btn danger', type: 'button', onclick: () => unlinkDialog(inst) }, icon('x'), 'Unlink…'))));
}

function psAction(title, text, btn) {
  return h('div', { class: 'ps-row' }, h('div', { class: 'grow' }, h('div', { class: 'i-title' }, title), h('div', { class: 'muted small' }, text)), btn);
}

async function unlinkDialog(inst) {
  const ok = await confirmDialog(`Unlink ${inst.pack.name}?`,
    `${inst.name} becomes a normal instance: you can update, remove and replace every mod, and change the loader and Minecraft version. There will be no more updates from ${inst.pack.name}, and this can't be turned back on. Nothing is deleted.`,
    'Unlink', true);
  if (!ok) return;
  try { await call('pack:unlink', inst.id); toast(`${inst.name} is now a normal instance`, 'good'); go('instance', { id: inst.id, tab: 'settings' }); } catch (e) { toast(e.message, 'error'); }
}

function reinstallDialog(inst) {
  let keep = true;
  const opt = (value, title, text) => h('label', { class: 'ps-choice' },
    h('input', { type: 'radio', name: 'keep', checked: keep === value, onchange: () => { keep = value; } }),
    h('div', null, h('div', { class: 'i-title' }, title), h('div', { class: 'muted small' }, text)));
  modal({
    title: `Reinstall ${inst.pack.name} ${inst.pack.versionName || ''}`,
    body: [
      h('p', { style: { margin: 0, color: 'var(--muted)', lineHeight: 1.5 } }, "Every pack file is downloaded again and the pack's config files are put back. Pack mods you turned off are turned back on. Your worlds are not touched. A backup is made first, so you can undo this."),
      opt(true, 'Keep my additions', 'Mods, resource packs and shaders you added yourself stay.'),
      opt(false, 'Remove my additions', 'Only the modpack is left, exactly as its author made it.'),
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      { label: 'Reinstall', class: 'primary', icon: 'download', onClick: async () => {
        const r = await call('pack:apply', inst.id, inst.pack.versionId, { action: 'reinstall', keepAdditions: keep });
        await handleInstallResult({ ...r, installed: [] }, inst.id);
        toast(`Reinstalled ${inst.pack.name}. Use "Undo reinstall" if you need anything back.`, 'good', 8000);
        go('instance', { id: inst.id });
      } },
    ],
  });
}
