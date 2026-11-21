'use strict';
// The update review window. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ----- update review
const CHANNELS = [
  { value: 'release', label: 'Releases only' },
  { value: 'beta', label: 'Releases & betas' },
  { value: 'alpha', label: 'Everything (incl. alpha)' },
];
const CH_RANK = { release: 0, beta: 1, alpha: 2 };

function releaseBadge(t) {
  return h('span', { class: `badge plain ${t === 'release' ? 'good' : t === 'beta' ? 'warn' : 'bad'}` }, t || 'release');
}

function updateReviewDialog(inst, updates, onDone) {
  let channel = state.settings?.updateChannel || 'alpha';
  const allowed = (v) => (CH_RANK[v.releaseType] ?? 0) <= CH_RANK[channel];
  const rows = updates.map((u) => ({ u, include: allowed(u.version), touched: false, candidates: null, chosen: u.version, failed: false }));
  const running = state.running.get(inst.id) === 'running';

  const applyChannel = (row) => {
    if (row.touched) return;
    const list = row.candidates || [row.u.version];
    const best = list.find(allowed);
    if (best) { row.chosen = best; row.include = true; } else { row.include = false; }
  };

  const listBox = h('div', { class: 'list upd-list' });
  const summary = h('span', { class: 'muted small' });
  const renderRow = (row) => {
    const { u } = row;
    const opts = row.candidates && row.candidates.length ? row.candidates : [u.version];
    const sel = h('select', {
      class: 'upd-select', disabled: !row.candidates,
      title: row.candidates ? 'Pick the version to update to' : 'Loading versions…',
      onchange: (e) => {
        row.chosen = opts.find((v) => String(v.id) === e.target.value) || row.chosen;
        row.touched = true;
        row.include = true;
        redraw();
      },
    }, opts.map((v) => h('option', { value: String(v.id) }, `${v.versionNumber}${v.releaseType !== 'release' ? `  (${v.releaseType})` : ''}  ·  ${ago(v.date)}`)));
    sel.value = String(row.chosen.id);
    const noneInChannel = row.candidates && !row.touched && !row.candidates.some(allowed);
    return h('div', { class: `item upd-row ${row.include ? '' : 'skipped'}` },
      h('input', { type: 'checkbox', checked: row.include, onchange: (e) => { row.include = e.target.checked; row.touched = true; redraw(); } }),
      avatar({ icon: u.icon, title: u.title }, 'sm'),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'i-title ellipsis' }, u.title),
        h('div', { class: 'i-file ellipsis' }, noneInChannel ? h('span', { style: { color: 'var(--warn)' } }, `No ${channel === 'release' ? 'release' : 'release or beta'} update — pick one to include it`) : SRC[u.source])),
      h('div', { class: 'upd-from ellipsis', title: u.current }, u.current || '—'),
      icon('arrowLeft', 14),
      h('div', { class: 'row', style: { minWidth: 0, gap: '6px' } }, sel, row.candidates ? null : h('div', { class: 'spinner', style: { width: '14px', height: '14px' } })),
      releaseBadge(row.chosen.releaseType));
  };
  const countSel = () => rows.filter((r) => r.include).length;
  let actionBtn;
  const redraw = () => {
    listBox.replaceChildren(...rows.map(renderRow));
    const n = countSel();
    summary.textContent = `${n} of ${rows.length} selected`;
    if (actionBtn) {
      actionBtn.disabled = n === 0 || running;
      actionBtn.replaceChildren(icon('arrowUp'), n ? `Update ${n} mod${n > 1 ? 's' : ''}` : 'Nothing selected');
    }
  };

  const channelSel = select(CHANNELS, channel, async (v) => {
    channel = v;
    rows.forEach(applyChannel);
    redraw();
    try { state.settings = await call('settings:set', { updateChannel: v }); } catch { /* not critical */ }
  });
  const m = modal({
    title: `${rows.length} update${rows.length > 1 ? 's' : ''} ready`,
    body: [
      h('p', { style: { margin: 0, color: 'var(--muted)', lineHeight: 1.5 } }, 'Nothing changes until you press Update. Pick the version for each mod, or untick one to skip it. Replaced files are backed up so the whole update can be undone.'),
      h('div', { class: 'row wrap' },
        h('label', { class: 'row small muted' }, 'Default to the newest of', channelSel),
        h('div', { class: 'grow' }),
        summary,
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { rows.forEach((r) => { r.include = true; r.touched = true; }); redraw(); } }, 'All'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { rows.forEach((r) => { r.include = false; r.touched = true; }); redraw(); } }, 'None')),
      listBox,
      running ? h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), 'Minecraft is running from this instance. Close the game first.') : h('div', { class: 'hint' }, 'Tip: pin a mod in the list (⋯ → Pin this version) to stop it being offered at all.'),
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      {
        label: 'Update', class: 'primary', icon: 'arrowUp', onClick: async () => {
          const chosen = rows.filter((r) => r.include).map((r) => ({
            file: r.u.file, title: r.u.title, type: r.u.type, source: r.u.source, current: r.u.current, version: r.chosen, project: r.u.project || null,
          }));
          const res = await call('content:applyUpdates', inst.id, chosen);
          await handleInstallResult({ ...res, installed: [] }, inst.id);
          toast(`Updated ${chosen.length} mod${chosen.length > 1 ? 's' : ''}. Use “Undo last update” if something breaks.`, 'good', 7000);
          if (onDone) onDone();
        },
      },
    ],
  });
  m.el.style.width = 'min(1100px, 100%)';
  actionBtn = m.el.querySelectorAll('.m-foot .btn')[1];
  rows.forEach((r) => { if (!allowed(r.u.version)) r.include = false; });
  redraw();

  // Load every newer compatible version per mod (a few at a time).
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        const list = await call('content:updateCandidates', inst.id, { source: row.u.source, projectId: row.u.projectId ?? row.u.version.projectId, type: row.u.type, currentVersionId: row.u.currentVersionId });
        if (!list.some((v) => String(v.id) === String(row.u.version.id))) list.unshift(row.u.version);
        row.candidates = list.sort((a, b) => new Date(b.date) - new Date(a.date));
      } catch {
        row.candidates = [row.u.version];
        row.failed = true;
      }
      applyChannel(row);
      if (document.body.contains(listBox)) redraw();
    }
  };
  Promise.all([worker(), worker(), worker(), worker()]);
}
