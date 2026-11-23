'use strict';
// The Mods / Resource packs / Shaders tab: list, selection bar, Send to instance. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ----- content tab
let contentKeyHandler = null;

function typeNoun(type, n) {
  const one = { mod: 'mod', resourcepack: 'resource pack', shader: 'shader', datapack: 'data pack' }[type] || 'file';
  return n === 1 ? one : `${one}s`;
}

async function renderContentTab(inst, type, root, token) {
  root.replaceChildren(loading());
  let items = await call('content:list', inst.id, type);
  if (stale(token)) return;
  let filter = '';
  let updates = new Map();
  let checked = false; // has "check for updates" run on this tab?
  const selected = new Set(); // file paths; stays put when a filter hides some of them
  let anchor = null; // last clicked row, for Shift+click ranges
  let rowEls = new Map();
  let shownFiles = [];
  let headBox = null;
  let busy = false;
  const listBox = h('div');
  const bar = h('div', { class: 'selbar' });
  const countLabel = h('span', { class: 'muted small' });
  const updateBtn = h('button', { class: 'btn', type: 'button' }, icon('refresh'), 'Check for updates');
  const updateAllBtn = h('button', { class: 'btn primary', type: 'button', style: { display: 'none' } }, icon('arrowUp'), 'Update all');
  const notices = h('div');
  // A linked modpack: the pack's files are the bottom layer (locked), your additions sit on top.
  const linked = Boolean(inst.linked);
  const packName = inst.pack?.name || 'the modpack';
  let origin = 'all'; // all | pack | mine | changed | off
  let authors = {};
  const isLocked = (i) => linked && i.fromPack;
  const chips = h('div', { class: 'chips' });
  const ORIGINS = [
    ['all', 'All', () => true],
    ['pack', 'From the pack', (i) => i.fromPack],
    ['mine', 'Added by you', (i) => !i.fromPack],
    ['changed', 'Changed', (i) => i.fromPack && i.packChanged],
    ['off', 'Turned off', (i) => !i.enabled],
  ];
  const originPred = () => (ORIGINS.find((o) => o[0] === origin) || ORIGINS[0])[2];

  const noun = (n) => typeNoun(type, n);
  const refresh = () => renderContentTab(inst, type, root, renderToken);
  const reviewUpdates = (list) => updateReviewDialog(inst, list, refresh);
  const act = async (fn) => {
    if (busy) return;
    busy = true;
    bar.classList.add('busy');
    try { await fn(); } catch (e) { toast(e.message, 'error'); } finally { busy = false; bar.classList.remove('busy'); }
  };

  // ---- selection --------------------------------------------------------
  const shownItems = () => {
    const pred = linked ? originPred() : () => true;
    const list = items.filter((i) => pred(i) && (!filter || `${i.title} ${i.fileName} ${i.modId || ''} ${authors[i.file] || ''}`.toLowerCase().includes(filter)));
    // Your additions on top, the pack underneath.
    return linked ? [...list.filter((i) => !i.fromPack), ...list.filter((i) => i.fromPack)] : list;
  };
  const selectedItems = () => items.filter((i) => selected.has(i.file));

  const renderBar = () => {
    if (!selected.size) { bar.replaceChildren(); return; }
    const sel = selectedItems();
    const shownSet = new Set(shownFiles);
    const hidden = sel.filter((i) => !shownSet.has(i.file)).length;
    const abtn = (label, ic, onclick, cls = '') => h('button', { class: `btn sm ${cls}`, type: 'button', onclick: () => act(onclick) }, icon(ic, 14), label);
    bar.replaceChildren(
      h('div', { class: 'sel-info' },
        h('div', { class: 'stack' }, sel.slice(0, 4).map((i) => avatar({ icon: i.icon, title: i.title }, 'xs')), sel.length > 4 ? h('div', { class: 'avatar xs more' }, `+${sel.length - 4}`) : null),
        h('div', { class: 'sel-label' }, `${sel.length} selected`, hidden ? h('small', null, ` (${hidden} hidden by filter)`) : null),
        h('button', { class: 'btn ghost icon', type: 'button', title: 'Clear selection (Esc)', onclick: () => clearSelection() }, icon('x'))),
      h('div', { class: 'sel-actions' },
        abtn('Update selected', 'arrowUp', updateSelected, 'primary'),
        abtn('Enable', 'check', () => bulkToggle(true)),
        abtn('Disable', 'x', () => bulkToggle(false)),
        abtn('Pin', 'pin', () => bulkPin(true)),
        abtn('Unpin', 'pin', () => bulkPin(false)),
        abtn('Copy list', 'copy', copyList),
        abtn('Send to instance…', 'upload', sendSelected),
        abtn('Remove', 'trash', removeSelected, 'danger')));
  };

  const syncSelection = () => {
    for (const [file, { row, box }] of rowEls) {
      const on = selected.has(file);
      box.checked = on;
      row.classList.toggle('selected', on);
    }
    if (headBox) {
      const n = shownFiles.filter((f) => selected.has(f)).length;
      headBox.checked = shownFiles.length > 0 && n === shownFiles.length;
      headBox.indeterminate = n > 0 && n < shownFiles.length;
    }
    listBox.classList.toggle('has-selection', selected.size > 0);
    renderBar();
  };
  const clearSelection = () => { selected.clear(); anchor = null; syncSelection(); };
  const selectAllShown = () => { for (const f of shownFiles) selected.add(f); syncSelection(); };
  const toggleShown = (on) => { for (const f of shownFiles) { if (on) selected.add(f); else selected.delete(f); } anchor = null; syncSelection(); };
  const onRowBox = (it, e) => {
    const on = e.currentTarget.checked;
    const from = anchor ? shownFiles.indexOf(anchor) : -1;
    const to = shownFiles.indexOf(it.file);
    if (e.shiftKey && from !== -1 && to !== -1) {
      for (let k = Math.min(from, to); k <= Math.max(from, to); k++) { if (on) selected.add(shownFiles[k]); else selected.delete(shownFiles[k]); }
    } else if (on) selected.add(it.file); else selected.delete(it.file);
    anchor = it.file;
    syncSelection();
  };

  // ---- updates ----------------------------------------------------------
  const runCheck = async () => {
    const res = await call('content:checkUpdates', inst.id);
    for (const e of res.filter((u) => u.error)) toast(e.error, 'warn');
    try { // the check also flags files taken down from their platform
      const fresh = new Map((await call('content:list', inst.id, type)).map((f) => [f.file, f.removed || null]));
      for (const it of items) it.removed = fresh.get(it.file) || null;
    } catch { /* badges update next time */ }
    refreshRemovedBanner(inst);
    updates = new Map(res.filter((u) => !u.error && u.type === type).map((u) => [u.file, u]));
    checked = true;
    if (!res.length) toast('Everything is up to date', 'good');
    updateAllBtn.style.display = updates.size ? '' : 'none';
    updateAllBtn.replaceChildren(icon('arrowUp'), `Update all (${updates.size})`);
    updateAllBtn.onclick = () => reviewUpdates([...updates.values()]);
    renderList();
  };
  const updateSelected = async () => {
    if (!checked) await runCheck();
    const list = [...updates.values()].filter((u) => selected.has(u.file));
    if (!list.length) { toast(`None of the selected ${noun(2)} have an update.`, 'info'); return; }
    reviewUpdates(list);
  };

  // ---- bulk actions -----------------------------------------------------
  const bulkToggle = async (on) => {
    const sel = selectedItems().filter((i) => i.enabled !== on);
    if (!sel.length) { toast(`The selected ${noun(2)} are already ${on ? 'enabled' : 'disabled'}.`, 'info'); return; }
    await call('content:toggleMany', inst.id, sel.map((i) => i.file), on);
    for (const i of sel) i.enabled = on;
    renderList();
    toast(`${on ? 'Enabled' : 'Disabled'} ${sel.length} ${noun(sel.length)}`, 'good');
  };
  const bulkPin = async (on) => {
    const sel = selectedItems();
    await call('content:pinMany', inst.id, sel.map((i) => i.file), on);
    for (const i of sel) i.pinned = on;
    renderList();
    toast(`${on ? 'Pinned' : 'Unpinned'} ${sel.length} ${noun(sel.length)}${on ? '. Updates will skip them.' : ''}`, 'good');
  };
  const copyList = async () => {
    const r = await call('content:copyList', inst.id, selectedItems().map((i) => i.file));
    toast(`Copied ${r.count} ${noun(r.count)} as a Markdown list`, 'good');
  };
  const sendSelected = async () => { await sendToInstanceDialog(inst, selectedItems().map((i) => i.file), type); };
  const removeSelected = async () => {
    const sel = selectedItems();
    const ok = await confirmDialog(`Remove ${sel.length} ${noun(sel.length)}?`,
      `This deletes ${sel.length} ${noun(sel.length)} from ${inst.name}: ${sel.slice(0, 5).map((i) => i.title).join(', ')}${sel.length > 5 ? `, and ${sel.length - 5} more` : ''}. This can't be undone.`,
      `Remove ${sel.length}`, true);
    if (!ok) return;
    await call('content:remove', inst.id, sel.map((i) => i.file));
    const gone = new Set(sel.map((i) => i.file));
    items = items.filter((i) => !gone.has(i.file));
    selected.clear();
    renderList();
    toast(`Removed ${sel.length} ${noun(sel.length)}`);
  };

  // ---- smart select -----------------------------------------------------
  const applySmart = (pred, label) => {
    const hit = items.filter((i) => pred(i) && !isLocked(i));
    if (!hit.length) { toast(`No ${noun(2)} match “${label}”.`, 'info'); return; }
    selected.clear();
    for (const i of hit) selected.add(i.file);
    anchor = null;
    syncSelection();
  };
  const smartMenu = (anchorEl) => {
    const count = (p) => items.filter((i) => p(i) && !isLocked(i)).length;
    const entry = (label, pred, ic, opts = {}) => ({
      label: `${label}${opts.count === false ? '' : ` (${count(pred)})`}`, icon: ic,
      onClick: () => act(async () => { if (opts.needsCheck && !checked) await runCheck(); applySmart(pred, label); }),
    });
    popupMenu(anchorEl, [
      entry('All disabled', (i) => !i.enabled, 'x'),
      { ...entry('All with updates', (i) => updates.has(i.file), 'arrowUp', { needsCheck: true, count: checked }), label: `All with updates${checked ? ` (${updates.size})` : ' (checks first)'}` },
      entry('All not linked to Modrinth or CurseForge', (i) => i.source === 'local', 'info'),
      ...(type === 'mod' ? [entry('All duplicates', (i) => Boolean(i.duplicateOf), 'alert')] : []),
      '-',
      entry('All from Modrinth', (i) => i.source === 'modrinth', 'check'),
      entry('All from CurseForge', (i) => i.source === 'curseforge', 'check'),
      ...(type === 'mod' ? [entry('All client-only', (i) => i.clientOnly, 'box')] : []),
    ]);
  };

  // ---- the list ---------------------------------------------------------
  const renderList = () => {
    const have = new Set(items.map((i) => i.file));
    for (const f of [...selected]) if (!have.has(f)) selected.delete(f);
    const shown = shownItems();
    shownFiles = shown.filter((i) => !isLocked(i)).map((i) => i.file); // pack files are left out of multi-select
    rowEls = new Map();
    headBox = null;
    countLabel.textContent = `${items.length} ${type === 'mod' ? 'mods' : 'files'}${items.filter((i) => !i.enabled).length ? ` · ${items.filter((i) => !i.enabled).length} disabled` : ''}`;
    if (linked) {
      chips.replaceChildren(...ORIGINS.map(([key, label, pred]) => {
        const n = items.filter(pred).length;
        if (key === 'changed' && !n && origin !== 'changed') return null;
        return h('button', { type: 'button', class: `chip ${origin === key ? 'on' : ''}`, onclick: () => { origin = key; renderList(); } }, label, h('span', { class: 'count' }, String(n)));
      }));
    }
    const dups = items.filter((i) => i.duplicateOf);
    // On a linked pack only your additions count: the pack's files are never updated one by one.
    const unknown = items.filter((i) => i.source === 'local' && !(linked && i.fromPack));
    notices.replaceChildren(
      dups.length ? h('div', { class: 'notice warn' }, icon('alert'), h('div', null,
        h('div', null, `${dups.length} duplicate mod${dups.length > 1 ? 's' : ''} found (the same mod installed twice, e.g. from both Modrinth and CurseForge). Minecraft will refuse to start like this.`),
        h('div', { class: 'hint' }, dups.map((d) => `${d.fileName} ↔ ${d.duplicateOf}`).join(' · ')))) : null,
      unknown.length ? h('div', { class: 'notice info' }, icon('info'), h('div', { class: 'grow' },
        `${unknown.length} file${unknown.length > 1 ? 's' : ''} not linked to Modrinth or CurseForge, so ${unknown.length > 1 ? "they can't" : "it can't"} be updated.`),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => {
          try { const r = await call('content:identify', inst.id, linked ? unknown.map((i) => i.file) : null); toast(`Recognised ${r.identified} of ${r.total}`, r.identified ? 'good' : 'info'); renderContentTab(inst, type, root, renderToken); } catch (e) { toast(e.message, 'error'); }
        } }, 'Look them up')) : null,
    );
    if (!shown.length) {
      listBox.replaceChildren(h('div', { class: 'empty' },
        h('h2', null, items.length ? 'Nothing matches' : `No ${TYPES[type].toLowerCase()} yet`),
        h('div', null, items.length ? 'Try another filter.' : 'Browse Modrinth and CurseForge, or add files you already have.'),
        !items.length ? h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => go('browse', { type, instanceId: inst.id }) }, icon('search'), `Find ${TYPES[type].toLowerCase()}`)) : null));
      syncSelection();
      return;
    }
    headBox = h('input', { type: 'checkbox', title: linked ? 'Select everything shown that you added' : 'Select everything shown', onclick: (e) => toggleShown(e.currentTarget.checked) });
    if (linked) { listBox.replaceChildren(h('div', { class: 'list content-list pack-list' }, packHead(), packRows(shown))); syncSelection(); return; }
    const head = h('div', { class: 'item content-head' },
      headBox,
      h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Smart select…', onclick: (e) => smartMenu(e.currentTarget) }, icon('chevronDown', 14)),
      h('div', null, 'Name'),
      h('div', null, 'Version'),
      h('div', null, 'Source'),
      h('div', { class: 'c-switch' }, 'Enabled'),
      h('div'));
    const rows = shown.map((it) => {
      const up = updates.get(it.file);
      const box = h('input', {
        type: 'checkbox', class: 'sel', title: 'Select (Shift+click for a range)',
        onmousedown: (e) => { if (e.shiftKey) e.preventDefault(); }, // no text selection while range-selecting
        onclick: (e) => onRowBox(it, e),
      });
      const sw = h('label', { class: 'switch', title: it.enabled ? 'Enabled: click to disable' : 'Disabled: click to enable' },
        h('input', {
          type: 'checkbox', checked: it.enabled, onchange: async (e) => {
            try { await call('content:toggle', inst.id, it.file, e.target.checked); it.enabled = e.target.checked; renderList(); } catch (err) { toast(err.message, 'error'); e.target.checked = it.enabled; }
          },
        }), h('span'));
      const row = h('div', { class: `item ${it.enabled ? '' : 'disabled'}` },
        box,
        avatar({ icon: it.icon, title: it.title }, 'sm'),
        h('div', { class: 'i-main', style: { minWidth: 0 } },
          h('div', { class: 'i-title ellipsis', title: it.title }, it.title,
            it.clientOnly ? h('span', { class: 'badge client plain', style: { marginLeft: '8px' }, title: "Client-only: it's not needed on a server" }, 'Client') : null,
            it.duplicateOf ? h('span', { class: 'badge warn plain', style: { marginLeft: '8px' } }, 'Duplicate') : null,
            removedBadge(it),
            it.pinned ? h('span', { class: 'badge plain', style: { marginLeft: '8px' }, title: 'Pinned: skipped by updates' }, 'Pinned') : null),
          h('div', { class: 'i-file ellipsis', title: it.fileName }, it.fileName)),
        h('div', { class: 'i-ver ellipsis', title: it.versionName }, up ? h('span', { class: 'badge good plain', title: `Update: ${up.next}` }, `→ ${up.next}`) : it.versionName),
        h('div', null, sourceBadge(it.source, it.url)),
        h('div', { class: 'c-switch' }, sw),
        h('div', { class: 'i-actions' },
          up ? h('button', { class: 'btn sm primary', type: 'button', title: `Update to ${up.next}`, onclick: () => reviewUpdates([up]) }, icon('arrowUp', 14)) : null,
          h('button', { class: 'btn ghost icon', type: 'button', title: 'More', onclick: (e) => popupMenu(e.currentTarget, [
            { label: it.pinned ? 'Unpin version' : 'Pin this version (skip updates)', icon: 'pin', onClick: async () => { await call('content:pin', inst.id, it.file, !it.pinned); it.pinned = !it.pinned; renderList(); } },
            ...(it.url ? [{ label: `Open on ${SRC[it.source]}`, icon: 'external', onClick: () => call('shell:open', it.url) }] : []),
            ...(it.projectId && it.source !== 'local' ? [{ label: 'Change version…', icon: 'refresh', onClick: () => projectDialog({ source: it.source, id: it.projectId, title: it.title, icon: it.icon, type }, { instance: inst, tab: 'versions', onInstalled: () => renderContentTab(inst, type, root, renderToken) }) }] : []),
            '-',
            { label: 'Remove', icon: 'trash', danger: true, onClick: async () => {
              await call('content:remove', inst.id, [it.file]);
              items = items.filter((x) => x.file !== it.file);
              renderList();
              toast(`Removed ${it.title}`);
            } },
          ]) }, icon('more'))));
      rowEls.set(it.file, { row, box });
      return row;
    });
    listBox.replaceChildren(h('div', { class: 'list content-list' }, head, rows));
    syncSelection();
  };

  // ---- the linked-modpack list -------------------------------------------
  const sideBadge = (side) => (side ? h('span', { class: `badge plain side-${side}`, title: { client: 'Only needed on your computer', server: 'Only needed on a server', both: 'Needed on both' }[side] }, { client: 'Client', server: 'Server', both: 'Both' }[side]) : h('span', { class: 'faint' }, '—'));
  const packHead = () => h('div', { class: 'item content-head' },
    headBox,
    h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Smart select (your additions)…', onclick: (e) => smartMenu(e.currentTarget) }, icon('chevronDown', 14)),
    h('div'),
    h('div', null, 'Name'),
    h('div', null, 'Author'),
    h('div', null, 'Side'),
    h('div', null, 'Version'),
    h('div', { class: 'c-switch' }, 'Enabled'),
    h('div'));
  const lockMenu = (anchorEl, it) => popupMenu(anchorEl, [
    ...(it.packChanged ? [{ label: 'Restore pack version', icon: 'refresh', onClick: () => act(async () => {
      const r = await call('pack:restoreFile', inst.id, it.file);
      toast(`Restored the pack's ${r.restored.split('/').pop()}`, 'good');
      items = await call('content:list', inst.id, type);
      renderList();
    }) }] : []),
    ...(it.url ? [{ label: `Open on ${SRC[it.source]}`, icon: 'external', onClick: () => call('shell:open', it.url) }] : []),
    { label: 'Why is this locked?', icon: 'lock', onClick: () => toast(`${it.title} is part of ${packName}, so it changes only with pack updates. You can turn it off if it causes problems; that choice is kept when the pack updates. To change it anyway, unlink the modpack in Settings.`, 'info', 10000) },
  ]);
  const packRows = (shown) => {
    const out = [];
    const mine = shown.filter((i) => !i.fromPack);
    const pack = shown.filter((i) => i.fromPack);
    const groupRow = (label, n, sub) => h('div', { class: 'item group-row' }, h('div', { class: 'g-label' }, label, h('span', { class: 'count' }, String(n)), sub ? h('span', { class: 'faint', style: { fontWeight: 400 } }, sub) : null));
    if (origin === 'all' && mine.length) out.push(groupRow('Added by you', mine.length, 'These keep all the normal controls.'));
    for (const it of mine) out.push(packRow(it));
    if (origin === 'all' && pack.length) out.push(groupRow(`From ${packName}`, pack.length, 'Locked: they change with pack updates. You can still turn them off.'));
    for (const it of pack) out.push(packRow(it));
    return out;
  };
  const packRow = (it) => {
    const locked = isLocked(it);
    const up = locked ? null : updates.get(it.file);
    const box = h('input', {
      type: 'checkbox', class: 'sel', disabled: locked, title: locked ? `Part of ${packName}: not included in bulk actions` : 'Select (Shift+click for a range)',
      onmousedown: (e) => { if (e.shiftKey) e.preventDefault(); },
      onclick: (e) => onRowBox(it, e),
    });
    const sw = h('label', { class: 'switch', title: it.enabled ? 'Enabled: click to turn off' : 'Turned off: click to turn on' },
      h('input', {
        type: 'checkbox', checked: it.enabled, onchange: async (e) => {
          try { await call('content:toggle', inst.id, it.file, e.target.checked); it.enabled = e.target.checked; renderList(); } catch (err) { toast(err.message, 'error'); e.target.checked = it.enabled; }
        },
      }), h('span'));
    const info = packUi.info.get(inst.id);
    const marker = it.fromPack
      ? h('span', { class: 'origin pack', title: `From ${packName}${it.packChanged ? ' (changed: not the pack’s version of this file)' : ''}` }, avatar({ icon: info?.icon || inst.iconSrc || inst.icon, title: packName }, 'xs'))
      : h('span', { class: 'origin you', title: 'You added this' }, 'You');
    const row = h('div', { class: `item ${it.enabled ? '' : 'disabled'} ${it.fromPack ? 'from-pack' : 'mine'}` },
      box,
      marker,
      avatar({ icon: it.icon, title: it.title }, 'sm'),
      h('div', { class: 'i-main', style: { minWidth: 0 } },
        h('div', { class: 'i-title ellipsis', title: it.title }, it.title,
          it.packChanged ? h('span', { class: 'badge warn plain', style: { marginLeft: '8px' }, title: "This isn't the file the pack ships. Restore it from the lock menu." }, 'Changed') : null,
          it.duplicateOf ? h('span', { class: 'badge warn plain', style: { marginLeft: '8px' } }, 'Duplicate') : null,
          removedBadge(it),
          it.pinned && !locked ? h('span', { class: 'badge plain', style: { marginLeft: '8px' }, title: 'Pinned: skipped by updates' }, 'Pinned') : null),
        h('div', { class: 'i-file ellipsis', title: it.fileName }, it.fileName)),
      h('div', { class: 'i-author ellipsis', title: authors[it.file] || '' }, authors[it.file] || h('span', { class: 'faint' }, '—')),
      h('div', null, sideBadge(it.side)),
      h('div', { class: 'i-ver ellipsis', title: it.versionName }, up ? h('span', { class: 'badge good plain', title: `Update: ${up.next}` }, `→ ${up.next}`) : it.versionName),
      h('div', { class: 'c-switch' }, sw),
      h('div', { class: 'i-actions' },
        locked
          ? h('button', { class: `btn ghost icon lock-btn ${it.packChanged ? 'changed' : ''}`, type: 'button', title: `Part of ${packName}. It changes with pack updates.${it.packChanged ? ' Click to restore the pack\'s version.' : ''}`, onclick: (e) => lockMenu(e.currentTarget, it) }, icon('lock', 15))
          : [
            up ? h('button', { class: 'btn sm primary', type: 'button', title: `Update to ${up.next}`, onclick: () => reviewUpdates([up]) }, icon('arrowUp', 14)) : null,
            h('button', { class: 'btn ghost icon', type: 'button', title: 'More', onclick: (e) => rowMenu(e.currentTarget, it) }, icon('more')),
          ]));
    if (!locked) rowEls.set(it.file, { row, box });
    return row;
  };
  const rowMenu = (anchorEl, it) => popupMenu(anchorEl, [
    { label: it.pinned ? 'Unpin version' : 'Pin this version (skip updates)', icon: 'pin', onClick: async () => { await call('content:pin', inst.id, it.file, !it.pinned); it.pinned = !it.pinned; renderList(); } },
    ...(it.url ? [{ label: `Open on ${SRC[it.source]}`, icon: 'external', onClick: () => call('shell:open', it.url) }] : []),
    ...(it.projectId && it.source !== 'local' && it.source !== 'pack' ? [{ label: 'Change version…', icon: 'refresh', onClick: () => projectDialog({ source: it.source, id: it.projectId, title: it.title, icon: it.icon, type }, { instance: inst, tab: 'versions', onInstalled: () => renderContentTab(inst, type, root, renderToken) }) }] : []),
    '-',
    { label: 'Remove', icon: 'trash', danger: true, onClick: async () => {
      try { await call('content:remove', inst.id, [it.file]); } catch (e) { toast(e.message, 'error'); return; }
      items = items.filter((x) => x.file !== it.file);
      renderList();
      toast(`Removed ${it.title}`);
    } },
  ]);

  updateBtn.onclick = async () => {
    updateBtn.disabled = true;
    try { await runCheck(); } catch (e) { toast(e.message, 'error'); } finally { updateBtn.disabled = false; }
  };

  const undoSlot = h('span');
  call('content:updateHistory', inst.id).then((hist) => {
    const last = hist[0];
    if (!last) return;
    undoSlot.replaceChildren(h('button', {
      class: 'btn ghost', type: 'button', title: last.items.map((i) => `${i.title}: ${i.from} → ${i.to}`).join('\n'),
      onclick: async () => {
        const list = last.items.map((i) => `• ${i.title}: back to ${i.from || 'the previous version'}`).join('\n');
        if (!(await confirmDialog(`Undo the update from ${ago(last.date)}?`, `This puts back the exact files that were replaced:\n${list}`, 'Undo update'))) return;
        try { const r = await call('content:undoUpdate', inst.id, last.stamp); toast(`Restored ${r.restored} file${r.restored === 1 ? '' : 's'}`, 'good'); refresh(); } catch (e) { toast(e.message, 'error'); }
      },
    }, icon('undo'), `Undo last update (${last.items.length})`));
  }).catch(() => {});
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'search', style: { maxWidth: '320px' } }, icon('search'), h('input', { type: 'search', placeholder: 'Filter…', oninput: (e) => { filter = e.target.value.toLowerCase(); renderList(); } })),
    countLabel,
    h('div', { class: 'grow' }),
    undoSlot,
    updateAllBtn,
    updateBtn,
    h('button', { class: 'btn', type: 'button', onclick: async () => {
      try { const added = await call('content:addFiles', inst.id, type); if (added?.length) { toast(`Added ${added.length} ${added.length === 1 ? 'file' : 'files'}`, 'good'); renderContentTab(inst, type, root, renderToken); } } catch (e) { toast(e.message, 'error'); }
    } }, icon('file'), 'Add files'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => go('browse', { type, instanceId: inst.id }) }, icon('plus'), `Add ${type === 'mod' ? 'mods' : TYPES[type].toLowerCase()}`));
  if (linked) updateBtn.title = `Checks the files you added. ${packName}'s own files update with the pack.`;
  root.replaceChildren(toolbar, linked ? chips : null, notices, listBox, bar);
  renderList();

  // Keyboard: Ctrl+A selects everything shown, Esc clears the selection.
  if (contentKeyHandler) document.removeEventListener('keydown', contentKeyHandler);
  const onKey = (e) => {
    if (stale(token) || !document.body.contains(listBox)) { document.removeEventListener('keydown', onKey); return; }
    if ($('#modal-root').children.length) return;
    const el = document.activeElement;
    const typing = el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'checkbox'));
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
      if (typing) return; // let the filter box select its own text
      e.preventDefault();
      selectAllShown();
    } else if (e.key === 'Escape' && selected.size) {
      clearSelection();
    }
  };
  contentKeyHandler = onKey;
  document.addEventListener('keydown', onKey);

  // Who made each mod: one bulk lookup per site, cached.
  if (linked) {
    call('content:authors', inst.id).then((a) => {
      if (stale(token) || !document.body.contains(listBox)) return;
      authors = a || {};
      renderList();
    }).catch(() => {});
  }

  // Fill in Modrinth's client/server info for mods linked before it was stored, so "Client" badges are complete.
  if (type === 'mod') {
    call('content:refreshSides', inst.id).then(async (r) => {
      if (!r?.updated || stale(token) || !document.body.contains(listBox)) return;
      items = await call('content:list', inst.id, type);
      if (!stale(token) && document.body.contains(listBox)) renderList();
    }).catch(() => {});
  }
}

// ----- send to another instance
async function sendToInstanceDialog(inst, rels, type) {
  const all = (await call('inst:list')).filter((i) => i.id !== inst.id);
  if (!all.length) { toast('You only have one instance. Create another one to send these to.', 'info'); return; }
  let target = null;
  const list = h('div', { class: 'list pick-list' });
  const sendBtnRef = { el: null };
  const draw = () => {
    list.replaceChildren(...all.map((i) => h('div', {
      class: `item pick-row ${target === i.id ? 'selected' : ''}`, onclick: () => { target = i.id; draw(); },
    }, h('input', { type: 'radio', name: 'target', checked: target === i.id }), avatar(i, 'sm'),
    h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis' }, i.name), h('div', { class: 'i-file ellipsis' }, instSubtitle(i))))));
    if (sendBtnRef.el) sendBtnRef.el.disabled = !target;
  };
  draw();
  const m = modal({
    title: `Send ${rels.length} ${typeNoun(type, rels.length)} to…`,
    body: [
      h('p', { style: { margin: 0, color: 'var(--muted)', lineHeight: 1.5 } },
        'Files from Modrinth or CurseForge are installed in the version that fits the other instance (its Minecraft version and loader), together with what they need. Files you added yourself are copied only if their loader matches. Nothing is changed in this instance.'),
      list,
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      {
        label: 'Send', class: 'primary', icon: 'upload', disabled: true, onClick: async () => {
          const dest = all.find((i) => i.id === target);
          const r = await call('content:sendToInstance', inst.id, rels, target);
          sendSummaryDialog(dest, r);
        },
      },
    ],
  });
  sendBtnRef.el = m.el.querySelectorAll('.m-foot .btn')[1];
  sendBtnRef.el.disabled = !target;
}

function sendSummaryDialog(dest, r) {
  const section = (title, cls, rows, fmt) => (rows.length ? h('div', { class: 'sum-sec' },
    h('div', { class: `sum-head ${cls}` }, `${title} (${rows.length})`),
    h('ul', null, rows.map((x) => h('li', null, h('b', null, x.title), fmt ? h('span', { class: 'muted' }, ` — ${fmt(x)}`) : null)))) : null);
  const none = !r.installed.length && !r.copied.length && !r.skipped.length && !r.unavailable.length && !r.blocked.length;
  modal({
    title: `Sent to ${dest.name}`,
    body: [
      none ? h('p', { style: { margin: 0 } }, 'Nothing was sent.') : null,
      section('Installed', 'good', r.installed, (x) => (x.source === 'modrinth' ? 'from Modrinth' : 'from CurseForge')),
      section('Copied', 'good', r.copied, () => 'copied as it is'),
      section('Already there', 'muted', r.skipped, (x) => x.reason),
      section(`Not available for ${dest.mcVersion}`, 'warn', r.unavailable, (x) => x.reason),
      section('Needs a manual download', 'warn', r.blocked, () => 'the author only allows downloads from their CurseForge page'),
      r.warnings.length ? h('div', { class: 'sum-sec' }, h('div', { class: 'sum-head warn' }, 'Heads up'), h('ul', null, r.warnings.map((w) => h('li', { class: 'muted' }, w)))) : null,
    ],
    actions: [{ label: 'Open instance', class: 'ghost', onClick: () => { go('instance', { id: dest.id }); } }, { label: 'Done', class: 'primary' }],
    onClose: () => { if (r.blockedSession) blockedDialog(r.blockedSession, dest.id); },
  });
}
