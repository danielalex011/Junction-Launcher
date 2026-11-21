'use strict';
// Toasts, modals and menus, plus the new-instance, export and blocked-download dialogs. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ---------------------------------------------------------------- toasts, modals, menus
function toast(msg, type = 'info', ms = 4500) {
  if (type === 'error' && msg === 'Cancelled') return; // the user stopped it themselves; the Activity panel already says so
  const t = h('div', { class: `toast ${type}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? Math.max(ms, 8000) : ms);
}

function modal({ title, body, actions = [], wide = false, onClose, headExtra }) {
  const root = $('#modal-root');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const foot = actions.length ? h('div', { class: 'm-foot' }, actions.map((a) => {
    const b = h('button', { class: `btn ${a.class || ''}`, type: 'button', disabled: a.disabled }, a.icon ? icon(a.icon) : null, a.label);
    b.addEventListener('click', async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try {
        const keep = await a.onClick(b);
        if (keep !== true) close();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        if (!closed) b.disabled = false;
      }
    });
    return b;
  })) : null;
  const m = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog' },
    h('div', { class: 'm-head' }, headExtra || null, h('h2', null, title), h('button', { class: 'btn ghost icon', type: 'button', onclick: close, title: 'Close' }, icon('x'))),
    h('div', { class: 'm-body' }, body),
    foot);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, m);
  root.append(overlay);
  document.addEventListener('keydown', onKey);
  return { close, el: m, body: $('.m-body', m) };
}

function confirmDialog(title, text, okLabel = 'OK', danger = false, cancelLabel = 'Cancel') {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title,
      body: h('p', { style: { margin: 0, lineHeight: 1.5 } }, text),
      actions: [
        { label: cancelLabel, class: 'ghost', onClick: () => { answered = true; resolve(false); } },
        { label: okLabel, class: danger ? 'danger solid' : 'primary', onClick: () => { answered = true; resolve(true); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

function popupMenu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu' }, items.map((it) => (it === '-' ? h('hr') : h('button', {
    type: 'button', class: it.danger ? 'danger' : '', onclick: () => { menu.remove(); it.onClick(); },
  }, it.icon ? icon(it.icon) : null, it.label))));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const leftEdge = r.left + r.width / 2 < window.innerWidth / 2 ? r.left : r.right - mw; // open toward the middle of the window
  menu.style.left = `${Math.max(8, Math.min(leftEdge, window.innerWidth - mw - 8))}px`;
  menu.style.top = `${r.bottom + mh + 6 > window.innerHeight ? r.top - mh - 6 : r.bottom + 6}px`;
  setTimeout(() => document.addEventListener('mousedown', function off(e) {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off); }
  }), 0);
}

function loading(text = 'Loading…') {
  return h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text);
}

function select(options, value, onchange, attrs = {}) {
  const s = h('select', { ...attrs, onchange: (e) => onchange && onchange(e.target.value) },
    options.map((o) => (typeof o === 'string' ? h('option', { value: o }, o) : h('option', { value: o.value }, o.label))));
  s.value = value ?? '';
  return s;
}

// ---------------------------------------------------------------- new instance dialog
async function newInstanceDialog(preset = {}) {
  let snapshots = Boolean(state.settings?.showSnapshots);
  let versions = await loadMcVersions(snapshots);
  let loader = preset.loader || 'fabric';
  let mc = preset.mcVersion || versions[0]?.id;
  let loaderVersion = null;
  let nameTouched = false;
  const nameInput = h('input', { type: 'text', placeholder: 'Instance name', oninput: () => { nameTouched = true; } });
  const autoName = () => { if (!nameTouched) nameInput.value = `${LOADER[loader]} ${mc}`; };
  const mcSelectWrap = h('div');
  const loaderVerWrap = h('div');
  const status = h('div', { class: 'hint' });

  const renderMcSelect = () => {
    mcSelectWrap.replaceChildren(select(versions.map((v) => ({ value: v.id, label: v.type === 'release' ? v.id : `${v.id} (${v.type})` })), mc, (v) => { mc = v; autoName(); loadLoaderVersions(); }));
  };
  async function loadLoaderVersions() {
    loaderVersion = null;
    if (loader === 'vanilla') { loaderVerWrap.replaceChildren(h('div', { class: 'hint' }, 'No mod loader — plain Minecraft.')); status.textContent = ''; return; }
    loaderVerWrap.replaceChildren(loading('Fetching versions…'));
    try {
      const { list, default: def } = await call('loader:versions', loader, mc);
      if (!list.length) {
        loaderVerWrap.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), `${LOADER[loader]} isn't available for Minecraft ${mc}.`));
        return;
      }
      loaderVersion = def;
      loaderVerWrap.replaceChildren(select(list.map((v) => ({ value: v.version, label: `${v.version}${v.recommended ? '  (recommended)' : ''}${!v.stable ? '  (beta)' : ''}` })), def, (v) => { loaderVersion = v; }));
    } catch (e) {
      loaderVerWrap.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), e.message));
    }
  }
  const seg = h('div', { class: 'seg' }, Object.entries(LOADER).map(([k, label]) => h('button', {
    type: 'button', class: k === loader ? 'on' : '', onclick: (e) => {
      loader = k;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
      autoName();
      loadLoaderVersions();
    },
  }, label)));
  const snapToggle = h('label', { class: 'check small muted' }, h('input', {
    type: 'checkbox', checked: snapshots, onchange: async (e) => {
      snapshots = e.target.checked;
      versions = await loadMcVersions(snapshots);
      if (!versions.find((v) => v.id === mc)) mc = versions[0]?.id;
      renderMcSelect();
    },
  }), 'Show snapshots');

  renderMcSelect();
  autoName();
  loadLoaderVersions();
  modal({
    title: 'New instance',
    body: [
      h('label', { class: 'field' }, 'Name', nameInput),
      h('div', { class: 'field' }, h('span', { class: 'small muted', style: { fontWeight: 600 } }, 'Mod loader'), seg),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', { class: 'row' }, h('span', { class: 'grow' }, 'Minecraft version'), snapToggle), mcSelectWrap),
        h('label', { class: 'field' }, 'Loader version', loaderVerWrap)),
      status,
      h('div', { class: 'hint' }, 'Tip: you can also start from a modpack in Browse → Modpacks, then add or remove mods freely.'),
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      {
        label: 'Create', class: 'primary', icon: 'plus', onClick: async () => {
          if (loader !== 'vanilla' && !loaderVersion) throw new Error('Pick a loader version first');
          const inst = await call('inst:create', { name: nameInput.value.trim(), mcVersion: mc, loader: loader === 'vanilla' ? { type: 'vanilla' } : { type: loader, version: loaderVersion } });
          toast(`Created ${inst.name}`, 'good');
          go('instance', { id: inst.id });
        },
      },
    ],
  });
}

// ----- export dialog
async function exportDialog(inst, format) {
  const entries = await call('export:entries', inst.id);
  const checks = new Map();
  const name = h('input', { type: 'text', value: inst.name });
  const version = h('input', { type: 'text', value: '1.0.0' });
  const author = h('input', { type: 'text', value: '', placeholder: 'optional' });
  const list = h('div', { class: 'list', style: { maxHeight: '280px', overflow: 'auto' } }, entries.map((e) => {
    const c = h('input', { type: 'checkbox', checked: e.defaultOn });
    checks.set(e.name, c);
    return h('label', { class: 'check', style: { padding: '8px 12px', borderBottom: '1px solid var(--border)' } }, c, icon(e.dir ? 'folder' : 'file', 14), e.name);
  }));
  modal({
    title: format === 'mrpack' ? 'Export as Modrinth pack' : 'Export as CurseForge pack',
    body: [
      h('div', { class: 'form-grid' }, h('label', { class: 'field' }, 'Pack name', name), h('label', { class: 'field' }, 'Version', version), format === 'curseforge' ? h('label', { class: 'field' }, 'Author', author) : null),
      h('div', { class: 'field' }, h('span', { class: 'small muted', style: { fontWeight: 600 } }, 'Include'), list),
      h('div', { class: 'hint' }, format === 'mrpack'
        ? 'Mods that exist on Modrinth are linked, not copied — so the pack stays small and authors get the downloads. Anything else (e.g. CurseForge-only mods) is bundled inside the pack; only share those packs if the mods\' licences allow it.'
        : 'Mods that exist on CurseForge are linked by ID. Anything else (e.g. Modrinth-only mods) is bundled inside the pack; only share those packs if the mods\' licences allow it.'),
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      {
        label: 'Export', class: 'primary', icon: 'upload', onClick: async () => {
          const include = [...checks.entries()].filter(([, c]) => c.checked).map(([n]) => n);
          const r = await call('export:run', inst.id, format, { name: name.value.trim(), version: version.value.trim() || '1.0.0', author: author.value.trim(), include });
          if (!r) return true;
          toast(`Exported: ${r.referenced} files linked, ${r.bundled} bundled.${r.bundledContent.length ? `\nBundled jars/packs: ${r.bundledContent.slice(0, 5).map((x) => x.split('/').pop()).join(', ')}${r.bundledContent.length > 5 ? '…' : ''}` : ''}`, 'good', 9000);
          return false;
        },
      },
    ],
  });
}

// ----- blocked downloads
function blockedDialog(session, instId) {
  let status = session.status;
  const listBox = h('div', { class: 'list' });
  const render = () => {
    listBox.replaceChildren(...status.map((s) => h('div', { class: 'item', style: { gridTemplateColumns: '22px 1fr auto' } },
      s.done ? h('span', { style: { color: 'var(--good)' } }, icon('check')) : h('div', { class: 'spinner', style: { width: '14px', height: '14px' } }),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis' }, s.title), h('div', { class: 'i-file ellipsis' }, s.error ? `⚠ ${s.error}` : s.fileName)),
      s.done ? h('span', { class: 'badge good plain' }, 'Added') : h('button', { class: 'btn sm', type: 'button', onclick: () => call('shell:open', s.pageUrl) }, icon('external', 14), 'Download page'))));
  };
  render();
  const offUpdate = on('blocked:update', ({ sessionId, status: st }) => { if (sessionId === session.sessionId) { status = st; render(); } });
  const offDone = on('blocked:complete', ({ sessionId }) => {
    if (sessionId !== session.sessionId) return;
    toast('All manual downloads added', 'good');
    m.close();
    if (state.view === 'instance' && state.params.id === instId) go('instance', state.params);
  });
  const m = modal({
    title: `${status.length} file${status.length > 1 ? 's' : ''} ${status.length > 1 ? 'need' : 'needs'} a manual download`,
    body: [
      h('p', { style: { margin: 0, lineHeight: 1.5 } }, 'The authors of these files only allow downloads from the CurseForge website. Click each “Download page” and download it in your browser — Junction watches your Downloads folder and moves each file into place automatically.'),
      h('div', { class: 'hint' }, `Watching: ${session.downloadsDir}`),
      listBox,
    ],
    actions: [
      { label: 'Select files…', icon: 'file', onClick: async () => { const st = await call('blocked:pickFiles', session.sessionId); if (st) { status = st; render(); } return true; } },
      { label: 'Close', class: 'ghost' },
    ],
    onClose: () => { offUpdate(); offDone(); if (status.some((s) => !s.done)) { call('blocked:cancel', session.sessionId); toast('Stopped watching for manual downloads. Missing files can be added later with “Add files”.', 'warn'); } },
  });
}
