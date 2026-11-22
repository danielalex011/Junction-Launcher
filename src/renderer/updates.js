'use strict';
// The update review window. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ----- update review
const CHANNELS = [
  { value: 'auto', label: 'Same channel as installed' },
  { value: 'release', label: 'Releases only' },
  { value: 'beta', label: 'Releases & betas' },
  { value: 'alpha', label: 'Everything (incl. alpha)' },
];

function releaseBadge(t) {
  return h('span', { class: `badge plain ${t === 'release' ? 'good' : t === 'beta' ? 'warn' : 'bad'}` }, t || 'release');
}

/** The review window for one instance's updates. */
function updateReviewDialog(inst, updates, onDone) {
  return multiUpdateReviewDialog([{ inst, updates }], onDone);
}

/**
 * One review window for the updates of one or more instances (Home's "Review all" passes several).
 * Each instance is its own section, with its own backup when it is applied, so each can be undone on its own.
 */
function multiUpdateReviewDialog(groups, onDone) {
  const multi = groups.length > 1;
  let channel = state.settings?.updateChannel || 'auto';
  const allowedFor = (row, v) => JunctionChannel.allowed(channel, row.u.currentReleaseType, v.releaseType);
  const channelWord = (row) => (JunctionChannel.ceiling(channel, row.u.currentReleaseType) === 0 ? 'release' : 'release or beta');
  const secs = groups.map(({ inst, updates }) => {
    const sec = { inst, running: state.running.get(inst.id) === 'running', rows: [], collapsed: groups.length > 2 }; // many instances: start folded
    sec.rows = updates.map((u) => ({ sec, u, include: false, touched: false, candidates: null, chosen: u.version, failed: false }));
    return sec;
  });
  const rows = secs.flatMap((sec) => sec.rows);

  const applyChannel = (row) => {
    if (row.touched) return;
    const list = row.candidates || [row.u.version];
    const best = list.find((v) => allowedFor(row, v));
    if (best) { row.chosen = best; row.include = !row.sec.running; } else { row.include = false; }
  };

  const listBox = h('div', { class: 'upd-groups' });
  const summary = h('span', { class: 'muted small' });
  const renderRow = (row) => {
    const { u, sec } = row;
    const opts = row.candidates && row.candidates.length ? row.candidates : [u.version];
    const sel = h('select', {
      class: 'upd-select', disabled: !row.candidates,
      title: row.candidates ? 'Pick the version to update to' : 'Loading versions…',
      onchange: (e) => {
        row.chosen = opts.find((v) => String(v.id) === e.target.value) || row.chosen;
        row.touched = true;
        row.include = !sec.running;
        redraw();
      },
    }, opts.map((v) => h('option', { value: String(v.id) }, `${v.versionNumber}${v.releaseType !== 'release' ? `  (${v.releaseType})` : ''}  ·  ${ago(v.date)}`)));
    sel.value = String(row.chosen.id);
    const noneInChannel = row.candidates && !row.touched && !row.candidates.some((v) => allowedFor(row, v));
    return h('div', { class: `item upd-row ${row.include ? '' : 'skipped'}` },
      h('input', { type: 'checkbox', checked: row.include, disabled: sec.running, onchange: (e) => { row.include = e.target.checked; row.touched = true; redraw(); } }),
      avatar({ icon: u.icon, title: u.title }, 'sm'),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'i-title ellipsis' }, u.title),
        h('div', { class: 'i-file ellipsis' }, noneInChannel ? h('span', { style: { color: 'var(--warn)' } }, `No ${channelWord(row)} update — pick one to include it`) : SRC[u.source])),
      h('div', { class: 'upd-from ellipsis', title: u.current }, u.current || '—'),
      icon('arrowLeft', 14),
      h('div', { class: 'row', style: { minWidth: 0, gap: '6px' } }, sel, row.candidates ? null : h('div', { class: 'spinner', style: { width: '14px', height: '14px' } })),
      releaseBadge(row.chosen.releaseType));
  };
  const countSel = () => rows.filter((r) => r.include).length;
  const setSection = (sec, on) => { sec.rows.forEach((r) => { r.include = on && !sec.running; r.touched = true; }); redraw(); };
  const renderSection = (sec) => {
    const n = sec.rows.filter((r) => r.include).length;
    return h('div', { class: `upd-sec${sec.collapsed ? ' folded' : ''}` },
      multi ? h('div', { class: 'upd-sec-head' },
        h('button', { class: 'btn ghost sm upd-fold', type: 'button', 'aria-expanded': String(!sec.collapsed), 'aria-label': `${sec.collapsed ? 'Show' : 'Hide'} the updates of ${sec.inst.name}`, onclick: () => { sec.collapsed = !sec.collapsed; redraw(); } }, icon('chevronDown', 16)),
        avatar(sec.inst, 'sm'),
        h('div', { class: 'grow', style: { minWidth: 0 } },
          h('div', { class: 'i-title ellipsis' }, sec.inst.name),
          h('div', { class: 'i-file ellipsis' }, instSubtitle(sec.inst))),
        h('span', { class: 'muted small' }, `${sec.rows.length} update${sec.rows.length === 1 ? '' : 's'} · ${n} selected`),
        h('button', { class: 'btn ghost sm', type: 'button', disabled: sec.running, onclick: () => setSection(sec, true) }, 'All'),
        h('button', { class: 'btn ghost sm', type: 'button', disabled: sec.running, onclick: () => setSection(sec, false) }, 'None')) : null,
      sec.running && !sec.collapsed ? h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), 'Minecraft is running from this instance. Close the game first.') : null,
      sec.collapsed ? null : h('div', { class: 'list upd-list' }, sec.rows.map(renderRow)));
  };
  let actionBtn;
  const redraw = () => {
    listBox.replaceChildren(...secs.map(renderSection));
    const n = countSel();
    summary.textContent = `${n} of ${rows.length} selected`;
    if (actionBtn) {
      actionBtn.disabled = n === 0;
      actionBtn.replaceChildren(icon('arrowUp'), n ? `Update ${n} mod${n > 1 ? 's' : ''}` : 'Nothing selected');
    }
  };

  const channelSel = select(CHANNELS, channel, async (v) => {
    channel = v;
    rows.forEach(applyChannel);
    redraw();
    try { state.settings = await call('settings:set', { updateChannel: v }); } catch { /* not critical */ }
  });
  const single = secs[0];
  const m = modal({
    title: multi ? `${rows.length} updates ready in ${secs.length} instances` : `${rows.length} update${rows.length > 1 ? 's' : ''} ready`,
    body: [
      h('p', { style: { margin: 0, color: 'var(--muted)', lineHeight: 1.5 } }, multi
        ? 'Nothing changes until you press Update. Pick the version for each mod, or untick one to skip it. Every instance gets its own backup, so each one can be undone on its own page.'
        : 'Nothing changes until you press Update. Pick the version for each mod, or untick one to skip it. Replaced files are backed up so the whole update can be undone.'),
      h('div', { class: 'row wrap' },
        h('label', { class: 'row small muted' }, 'Default to the newest of', channelSel),
        h('div', { class: 'grow' }),
        summary,
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { secs.forEach((sec) => setSection(sec, true)); } }, 'All'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { secs.forEach((sec) => setSection(sec, false)); } }, 'None')),
      listBox,
      !multi && !single.running ? h('div', { class: 'hint' }, 'Tip: pin a mod in the list (⋯ → Pin this version) to stop it being offered at all.') : null,
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      {
        label: 'Update', class: 'primary', icon: 'arrowUp', onClick: async () => {
          let done = 0;
          const doneIn = [];
          const problems = [];
          for (const sec of secs) {
            const chosen = sec.rows.filter((r) => r.include).map((r) => ({
              file: r.u.file, title: r.u.title, type: r.u.type, source: r.u.source, current: r.u.current, version: r.chosen, project: r.u.project || null,
            }));
            if (!chosen.length || sec.running) continue;
            try {
              const res = await call('content:applyUpdates', sec.inst.id, chosen);
              await handleInstallResult({ ...res, installed: [] }, sec.inst.id);
              done += chosen.length;
              doneIn.push(sec.inst.name);
            } catch (e) {
              if (!multi) throw e;
              problems.push(`${sec.inst.name}: ${e.message}`);
            }
          }
          if (multi && !done && problems.length) throw new Error(problems[0]);
          if (multi) {
            toast(`Updated ${done} mod${done === 1 ? '' : 's'} in ${doneIn.length} instance${doneIn.length === 1 ? '' : 's'}. Each has its own backup: open it and use “Undo last update” if something breaks.`, 'good', 9000);
            if (problems.length) toast(`Couldn't update everything. ${problems.join(' · ')}`, 'warn', 10000);
          } else toast(`Updated ${done} mod${done > 1 ? 's' : ''}. Use “Undo last update” if something breaks.`, 'good', 7000);
          if (onDone) onDone();
        },
      },
    ],
  });
  m.el.style.width = 'min(1100px, 100%)';
  actionBtn = m.el.querySelectorAll('.m-foot .btn')[1];
  rows.forEach((r) => { r.include = allowedFor(r, r.u.version) && !r.sec.running; });
  redraw();

  // Load every newer compatible version per mod (a few at a time).
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        const list = await call('content:updateCandidates', row.sec.inst.id, { source: row.u.source, projectId: row.u.projectId ?? row.u.version.projectId, type: row.u.type, currentVersionId: row.u.currentVersionId });
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
