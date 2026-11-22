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
  const inst = await call('inst:get', id);
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
  view().replaceChildren(h('div', { class: 'page page-full instance-page' }, back, head, failedSlot, tabBar, content));
  call('content:failed', id).then((list) => {
    if (!stale(token) && list?.length) failedSlot.replaceChildren(failedNotice(inst, list, () => go('instance', state.params)));
  }).catch(() => {});
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
  if (inst.linked) {
    items.push('-', { label: 'Switch modpack version…', icon: 'refresh', onClick: () => switchVersionDialog(inst) },
      { label: 'Repair modpack', icon: 'refresh', onClick: () => repairFlow(inst) },
      { label: 'Modpack settings', icon: 'sliders', onClick: () => go('instance', { id: inst.id, tab: 'settings' }) });
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
    memMin: h('input', { type: 'number', min: 256, step: 256, value: inst.memoryMin || '', placeholder: `${s.memoryMin} (default)` }),
    jvm: h('textarea', { rows: 3, placeholder: 'Extra JVM arguments, e.g. -XX:+UseZGC', value: inst.jvmArgs || '' }),
    java: h('input', { type: 'text', value: inst.javaPath || '', placeholder: 'Automatic (Mojang runtime for this version)' }),
    width: h('input', { type: 'number', min: 0, value: inst.resolution?.width || '', placeholder: 'default' }),
    height: h('input', { type: 'number', min: 0, value: inst.resolution?.height || '', placeholder: 'default' }),
    server: h('input', { type: 'text', value: inst.joinServer || '', placeholder: 'e.g. play.example.net:25565' }),
  };
  const memCtl = memoryControl({ totalMB: state.info?.totalMemMB, valueMB: inst.memoryMax || null, defaultMB: s.memoryMax, nullable: true, name: inst.name });
  call('inst:modCounts').then((c) => memCtl.setMods(c[inst.id] ?? null)).catch(() => {});
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
      memoryMax: memCtl.getValue(),
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
      h('p', null, `Move the slider to give this instance its own amount, or use the default from Settings (${JunctionMemory.gbText(s.memoryMax)}). Java is downloaded automatically in the version Minecraft needs.`),
      memCtl,
      h('div', { class: 'form-grid', style: { marginTop: '18px' } },
        h('label', { class: 'field' }, 'Minimum memory (MB), advanced', f.memMin),
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
