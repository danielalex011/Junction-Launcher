'use strict';
// The instance page: header, Logs tab, Settings tab. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ---------------------------------------------------------------- instance page
let currentInstance = null;
async function refreshInstanceHeader() {
  if (state.view !== 'instance') return;
  const slot = $('#inst-play');
  if (!slot || !currentInstance) return;
  slot.replaceChildren(playButton(currentInstance, 'lg'));
}

async function renderInstance(params, token) {
  const { id, tab = 'mod' } = params;
  let inst;
  try { inst = await call('inst:get', id); } catch (e) {
    // A link to an instance that was deleted (Activity, quick search, Home...): back to the Library, no error page.
    if (/Instance not found/.test(e.message)) { if (!stale(token)) go('library'); return; }
    throw e;
  }
  if (stale(token)) return;
  currentInstance = inst;
  if (inst.state) state.running.set(id, inst.state);
  if (inst.linked) { await renderPackInstance(inst, params, token); return; }
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
  const failedSlot = h('div');
  const removedSlot = h('div', { id: 'removed-slot' });
  view().replaceChildren(h('div', { class: 'page page-full instance-page' }, back, head, failedSlot, removedSlot, tabBar, content));
  refreshRemovedBanner(inst);
  call('content:failed', id).then((list) => {
    if (!stale(token) && list?.length) failedSlot.replaceChildren(failedNotice(inst, list, () => go('instance', state.params)));
  }).catch(() => {});
  if (['mod', 'resourcepack', 'shader'].includes(activeTab)) await renderContentTab(inst, activeTab, content, token);
  else if (activeTab === 'logs') await renderLogsTab(inst, content);
  else await renderInstSettings(inst, content);
}

/** Red banner when installed files were taken down from Modrinth / CurseForge (found by the update check). */
function removedNotice(inst, list, onChange) {
  const on = list.filter((i) => i.enabled);
  const where = [...new Set(list.map((i) => i.platform))].join(' and ');
  const names = list.slice(0, 6).map((i) => i.title).join(', ') + (list.length > 6 ? `, and ${list.length - 6} more` : '');
  return h('div', { class: 'notice bad' }, icon('alert'),
    h('div', { class: 'grow' },
      h('div', null, `${list.length} file${list.length === 1 ? ' was' : 's were'} removed from ${where}`),
      h('div', { class: 'hint' }, `${names}. The ${list.length === 1 ? 'page or version' : 'pages or versions'} no longer exist${list.length === 1 ? 's' : ''} there. That can mean a problem was found or just a clean-up, so it's worth a look.${on.length ? '' : ' They are all turned off.'}`)),
    on.length ? h('button', { class: 'btn sm primary', type: 'button', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        for (const type of [...new Set(on.map((i) => i.type))]) await call('content:toggleMany', inst.id, on.filter((i) => i.type === type).map((i) => i.file), false);
        toast(`Turned off ${on.length} file${on.length === 1 ? '' : 's'}`, 'good');
        onChange();
      } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
    } }, 'Turn off') : null);
}

/** Fills the banner slot on the instance page (also called after an update check finds new removals). */
async function refreshRemovedBanner(inst) {
  const slot = document.getElementById('removed-slot');
  if (!slot) return;
  try {
    const list = await call('content:removed', inst.id);
    if (document.getElementById('removed-slot') !== slot) return; // the page changed meanwhile
    slot.replaceChildren(...(list?.length ? [removedNotice(inst, list, () => go('instance', state.params))] : []));
  } catch { /* the banner is a bonus; the list itself still works */ }
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
  popupMenu(anchor, instanceMenuItems(inst));
}

/** Right-click on an instance card: Play or Stop, Open, the folder, the logs, then everything the "…" menu offers. */
function instanceContextMenu(e, inst) {
  e.preventDefault();
  e.stopPropagation();
  const st = state.running.get(inst.id) || inst.state;
  const first = st === 'running' ? { label: 'Stop', icon: 'stop', danger: true, onClick: () => call('inst:kill', inst.id) }
    : st === 'preparing' ? null : { label: 'Play', icon: 'play', onClick: () => play(inst) };
  popupMenu(pointAnchor(e.clientX, e.clientY), [
    ...(first ? [first] : []),
    { label: 'Open', icon: 'box', onClick: () => go('instance', { id: inst.id }) },
    { label: 'Open game folder', icon: 'folder', onClick: () => call('inst:openFolder', inst.id) },
    { label: 'Logs', icon: 'terminal', onClick: () => go('instance', { id: inst.id, tab: 'logs' }) },
    '-',
    ...instanceMenuItems(inst),
  ]);
}

function instanceMenuItems(inst) {
  const items = [
    { label: 'Change picture…', icon: 'file', onClick: () => changeIcon(inst) },
    '-',
    { label: 'Export as Modrinth pack (.mrpack)', icon: 'upload', onClick: () => exportDialog(inst, 'mrpack') },
    { label: 'Export as CurseForge pack (.zip)', icon: 'upload', onClick: () => exportDialog(inst, 'curseforge') },
  ];
  if (inst.linked) {
    items.push('-', { label: 'Switch modpack version…', icon: 'refresh', onClick: () => switchVersionDialog(inst) },
      { label: 'Repair modpack', icon: 'refresh', onClick: () => repairFlow(inst) },
      { label: 'Modpack settings', icon: 'sliders', onClick: () => go('instance', { id: inst.id, tab: 'settings' }) });
  }
  items.push('-',
    { label: 'Copy worlds and settings from…', icon: 'copy', onClick: () => copyWorldsDialog(inst) },
    { label: 'Add mods from a template…', icon: 'plus', onClick: () => addTemplateDialog(inst) },
    { label: 'Save as template…', icon: 'box', onClick: () => saveTemplateDialog(inst) },
    { label: 'Open mods folder', icon: 'folder', onClick: () => call('inst:openFolder', inst.id, 'mods') },
    { label: 'Rename…', icon: 'edit', onClick: () => renameInstanceDialog(inst) },
    { label: 'Duplicate', icon: 'copy', onClick: async () => { const c = await call('inst:duplicate', inst.id); toast(`Created ${c.name}`, 'good'); go('instance', { id: c.id }); } },
    { label: 'Delete instance', icon: 'trash', danger: true, onClick: async () => {
      if (!(await confirmDialog(`Delete ${inst.name}?`, 'This deletes the instance folder including worlds, configs and mods. This cannot be undone.', 'Delete', true))) return;
      try { await call('inst:delete', inst.id); go(state.view === 'instance' ? 'library' : state.view); toast(`Deleted ${inst.name}`); } catch (e) { toast(e.message, 'error'); }
    } });
  return items;
}

// ----- logs tab
/**
 * The colour of one Logs-tab line. Lines from the game carry their real level ("[17:35:12] [Render thread/INFO]: …"),
 * so an INFO line that merely mentions "ERROR" (like OpenGL's "type=ERROR" notes) stays plain. Other lines (stack traces, plain output) are judged by their words.
 */
function logLineClass(l) {
  if (l.startsWith('[Junction]')) return 'l-j';
  const lvl = /^\[\d\d:\d\d:\d\d\] \[[^\]]*\/(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\](?: \[[^\]]*\])?:/.exec(l); // NeoForge adds "[modname/]" before the colon
  if (lvl) return lvl[1] === 'ERROR' || lvl[1] === 'FATAL' ? 'l-err' : lvl[1] === 'WARN' ? 'l-warn' : '';
  return /\b(ERROR|FATAL)\b|(Exception|Error)\b/.test(l) ? 'l-err' : /\bWARN\b/.test(l) ? 'l-warn' : ''; // also java.lang.IllegalStateException, OutOfMemoryError
}

/** The one-line summary of a hint, for the card title and the toast. */
function logHintTitle(hint) {
  if (hint.kind === 'incompatible') return `${hint.file?.title || hint.modId} doesn't work with this modpack`;
  if (hint.kind === 'missing') return `${hint.requestedByTitle || hint.requestedByName || hint.requestedBy || 'A mod'} needs ${hint.name || hint.modId}, which isn't installed`;
  if (hint.kind === 'memory') return 'Minecraft ran out of memory';
  return 'Something stopped the game';
}

/** A plain-words card above the log: why the game didn't start, and one button that fixes it. */
function logHintCard(instId, hint) {
  const body = h('div', { class: 'grow' });
  const card = h('div', { class: 'notice warn log-hint' }, icon('alert'), body);
  const draw = (done) => {
    let text = '';
    let action = null;
    if (hint.kind === 'incompatible') {
      const title = hint.file?.title || hint.modId;
      text = `The modpack stopped loading on purpose${hint.reason ? `: "${hint.reason.replace(/\.$/, '')}".` : '.'} `;
      if (done || (hint.file && !hint.file.enabled)) text += `${title} is turned off now. Close the game and press Play again.`;
      else if (hint.file) {
        text += 'Turn it off, then press Play again.';
        action = h('button', { class: 'btn sm primary', type: 'button', onclick: async () => {
          try { await call('content:toggle', instId, hint.file.rel, false); toast(`${title} is turned off`, 'good'); draw(true); } catch (e) { toast(e.message, 'error'); }
        } }, `Turn off ${title}`);
      } else text += `Look for ${title} in the Content tab and turn it off.`;
    } else if (hint.kind === 'missing') {
      const dep = hint.name || hint.modId;
      text = `Install ${dep} (for the same Minecraft version and mod loader), then press Play again.`;
      action = h('button', { class: 'btn sm primary', type: 'button', onclick: () => go('browse', { instanceId: instId, type: 'mod', query: dep }) }, icon('compass', 14), `Find ${dep}`);
    } else if (hint.kind === 'memory') {
      text = 'Give this instance more memory in its Settings tab, then press Play again.';
      action = h('button', { class: 'btn sm primary', type: 'button', onclick: () => go('instance', { id: instId, tab: 'settings' }) }, icon('sliders', 14), 'Open settings');
    }
    body.replaceChildren(h('b', null, logHintTitle(hint)), h('div', { class: 'small' }, text), action ? h('div', { style: { marginTop: '8px' } }, action) : null);
  };
  draw(false);
  return card;
}

on('inst:hint', ({ id, name, hint }) => {
  toast(`${name}: ${logHintTitle(hint)}. Open its Logs tab for the fix.`, 'warn', 9000);
  const box = document.querySelector(`.log-hints[data-inst="${CSS.escape(String(id))}"]`);
  if (box) box.append(logHintCard(id, hint));
});

async function renderLogsTab(inst, root) {
  const box = h('div', { class: 'log' });
  const hintsBox = h('div', { class: 'log-hints', 'data-inst': inst.id });
  call('inst:hints', inst.id).then((list) => { for (const hint of list) hintsBox.append(logHintCard(inst.id, hint)); }).catch(() => {});
  let auto = true;
  box.addEventListener('scroll', () => { auto = box.scrollTop + box.clientHeight >= box.scrollHeight - 30; });
  const add = (lines) => {
    const frag = document.createDocumentFragment();
    for (const l of lines) {
      const cls = logLineClass(l);
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
    hintsBox,
    box);
}

// ----- instance settings tab
async function renderInstSettings(inst, root) {
  const s = state.settings || (state.settings = await call('settings:get'));
  const versions = await loadMcVersions(true);
  const f = {
    name: h('input', { type: 'text', value: inst.name }),
    memMin: h('input', { type: 'number', min: 256, step: 256, value: inst.memoryMin || '', placeholder: `${s.memoryMin} (default)` }),
    jvm: h('textarea', { rows: 3, placeholder: 'Extra JVM arguments, e.g. -XX:+UseZGC', value: inst.jvmArgs || '' }),
    java: h('input', { type: 'text', value: inst.javaPath || '', placeholder: 'Automatic (Java …)', title: 'Leave empty to use the automatic Java' }),
    width: h('input', { type: 'number', min: 0, value: inst.resolution?.width || '', placeholder: 'default' }),
    height: h('input', { type: 'number', min: 0, value: inst.resolution?.height || '', placeholder: 'default' }),
    server: h('input', { type: 'text', value: inst.joinServer || '', placeholder: 'e.g. play.example.net:25565' }),
  };
  const info = await call('inst:memoryInfo', inst.id).catch(() => null);
  let memMode = info?.mode || (inst.pack ? 'recommended' : 'default');
  const memCtl = memoryControl({ totalMB: state.info?.totalMemMB, valueMB: inst.memoryMax || info?.effectiveMB || s.memoryMax, defaultMB: s.memoryMax, name: inst.name });
  call('inst:modCounts').then((c) => memCtl.setMods(c[inst.id] ?? null)).catch(() => {});
  const memModeBox = h('div');
  const MEM_MODES = [['recommended', 'Recommended'], ['default', 'Global default'], ['custom', 'Custom']];
  function drawMemMode() {
    const rec = info?.rec;
    memCtl.style.display = memMode === 'custom' ? '' : 'none';
    memModeBox.replaceChildren(
      h('div', { class: 'row wrap mem-modes', role: 'radiogroup', 'aria-label': 'Memory mode' }, MEM_MODES.map(([v, label]) => h('button', {
        class: `btn sm${memMode === v ? ' primary' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(memMode === v), onclick: () => { memMode = v; drawMemMode(); },
      }, label))),
      memMode === 'recommended' && rec ? h('div', { class: 'mem-rec' },
        h('div', null, rec.reason),
        h('div', { class: 'hint' }, rec.label),
        rec.pcShort ? h('div', { class: 'mem-hint' }, 'This PC has less memory than the pack asks for. It may run badly.') : null,
        rec.guideUrl ? h('a', { href: rec.guideUrl, onclick: (e) => { e.preventDefault(); call('shell:open', rec.guideUrl).catch(() => {}); } }, "Pack's memory guide") : null) : null,
      memMode === 'recommended' && !rec ? h('div', { class: 'hint' }, 'No recommendation for this instance. The global default is used.') : null,
      memMode === 'default' ? h('div', { class: 'hint' }, `Uses the default from Settings (${JunctionMemory.gbText(s.memoryMax)}).`) : null);
  }
  drawMemMode();
  const javaInfo = await call('inst:presets', inst.id).catch(() => ({ major: 0, presets: [] }));
  if (!inst.javaPath && javaInfo.major) f.java.placeholder = `Automatic (Java ${javaInfo.major})`;
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
  if (!inst.linked) loadLv();
  const locked = inst.linked;
  const save = async () => {
    if (!memCtl.isValid()) { toast('Fix the memory amount first.', 'error'); return; }
    const changedGame = !locked && mc !== inst.mcVersion || loader !== (inst.loader?.type || 'vanilla') || (loaderVersion || null) !== (inst.loader?.version || null);
    if (changedGame && !(await confirmDialog('Change game version?', 'Mods made for the old version or loader may not work and may need updating. Worlds opened in a newer version can\'t safely go back.', 'Change it'))) return;
    const w = Number(f.width.value) || 0;
    const hgt = Number(f.height.value) || 0;
    await call('inst:update', inst.id, {
      name: f.name.value.trim() || inst.name,
      ...(locked ? {} : { mcVersion: mc, loader: loader === 'vanilla' ? { type: 'vanilla' } : { type: loader, version: loaderVersion } }),
      memoryMode: memMode,
      ...(memMode === 'custom' ? { memoryMax: memCtl.getValue() } : {}),
      memoryMin: Number(f.memMin.value) || null,
      jvmArgs: f.jvm.value.trim(),
      javaPath: f.java.value.trim(),
      resolution: w && hgt ? { width: w, height: hgt } : null,
      joinServer: f.server.value.trim(),
    });
    toast('Saved', 'good');
    go('instance', { id: inst.id, tab: 'settings' });
  };
  const lockedField = (label, value) => h('label', { class: 'field', title: `Set by ${inst.pack?.name}. Unlink the modpack to change it.` }, h('span', { class: 'row', style: { gap: '6px' } }, label, icon('lock', 12)), h('input', { type: 'text', value, disabled: true }));
  root.replaceChildren(
    locked ? packSettingsSection(inst) : null,
    h('div', { class: 'section' }, h('h3', null, 'General'),
      locked ? h('p', null, `${inst.pack.name} sets the Minecraft version and the loader. Unlink the modpack below to change them.`) : null,
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Name', f.name),
        locked ? lockedField('Minecraft version', inst.mcVersion) : h('label', { class: 'field' }, 'Minecraft version', select(versions.map((v) => ({ value: v.id, label: v.type === 'release' ? v.id : `${v.id} (${v.type})` })), mc, (v) => { mc = v; loadLv(); })),
        locked ? lockedField('Loader', LOADER[inst.loader?.type] || inst.loader?.type || 'Vanilla') : h('label', { class: 'field' }, 'Loader', select(Object.entries(LOADER).map(([k, l]) => ({ value: k, label: l })), loader, (v) => { loader = v; loadLv(); })),
        locked ? lockedField('Loader version', inst.loader?.version || '—') : h('label', { class: 'field' }, 'Loader version', lvWrap))),
    h('div', { class: 'section' }, h('h3', null, 'Java & memory'),
      h('h4', { class: 'sub' }, 'Maximum memory'),
      h('p', null, 'Pick Recommended to let Junction choose, use the global default from Settings, or set your own amount. Java is downloaded automatically in the version Minecraft needs.'),
      memModeBox,
      memCtl,
      h('div', { class: 'form-grid', style: { marginTop: '18px' } },
        h('label', { class: 'field' }, 'Minimum memory (MB), advanced', f.memMin),
        h('label', { class: 'field' }, 'Java executable', h('div', { class: 'row' }, f.java, h('button', { class: 'btn', type: 'button', onclick: async () => { const p = await call('dialog:pickJava'); if (p) f.java.value = p; } }, 'Browse')))),
      h('label', { class: 'field', style: { marginTop: '14px' } }, 'JVM arguments', f.jvm),
      h('div', { class: 'row wrap', style: { marginTop: '8px' } }, h('span', { class: 'hint' }, 'Presets:'),
        javaInfo.presets.map((p) => h('button', {
          class: 'btn sm', type: 'button', disabled: !p.ok, title: p.ok ? p.hint : p.reason,
          onclick: async () => { const c = await call('inst:checkPreset', inst.id, p.id).catch(() => ({ ok: false, reason: 'Could not check the Java version.' })); if (!c.ok) { toast(c.reason, 'error'); return; } f.jvm.value = p.args; },
        }, p.label)),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { f.jvm.value = ''; } }, 'Clear')),
      javaInfo.presets.filter((p) => !p.ok).map((p) => h('div', { class: 'hint' }, `${p.label}: ${p.reason}`)),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Leave this empty unless a pack asks for something. Copied flag lists are often outdated and can make things worse.')),
    h('div', { class: 'section' }, h('h3', null, 'Game window & server'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Window width', f.width),
        h('label', { class: 'field' }, 'Window height', f.height),
        h('label', { class: 'field' }, 'Join server on launch', f.server))),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => save().catch((e) => toast(e.message, 'error')) }, icon('check'), 'Save changes')),
  );
}

/** ⋯ → Rename…: only the name changes; the instance folder and everything in it stay as they are. */
function renameInstanceDialog(inst) {
  const name = h('input', { type: 'text', value: inst.name, 'aria-label': 'Instance name' });
  modal({
    title: `Rename ${inst.name}`,
    body: [h('label', { class: 'field' }, 'Name', name)],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      { label: 'Rename', class: 'primary', onClick: async () => {
        const v = name.value.trim();
        if (!v) throw new Error('Type a name first.');
        if (v !== inst.name) await call('inst:update', inst.id, { name: v });
        toast(`Renamed to ${v}`, 'good');
        go('instance', state.params);
      } },
    ],
  });
}
