'use strict';
// The Browse page and project details. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

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
      const r = await call('pack:installFromSource', { source, projectId, versionId, title: hit.title });
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
