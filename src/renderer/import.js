'use strict';
// Import from another launcher. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

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
