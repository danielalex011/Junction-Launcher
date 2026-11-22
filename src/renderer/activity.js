'use strict';
// The sidebar task list, and launching / stopping the game (play button, state and log events). Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ---------------------------------------------------------------- activity (downloads & installs)
// A button at the bottom of the sidebar and a panel with running, queued and finished tasks.
// Rows are updated in place (not rebuilt) so buttons keep working while progress changes four times a second.
const KIND_LABELS = { modpack: 'Modpack', mod: 'Mod install', update: 'Update', newinstance: 'New instance', import: 'Import', repair: 'Repair', prepare: 'Game files', other: 'Task' };
const TASK_ICONS = { pack: 'box', instance: 'folder', mod: 'puzzle' };
const activityUi = { open: false, rows: new Map(), expanded: new Set(), history: [], refs: null, panel: null };

function fmtBytes(n) {
  if (!(n > 0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
const fmtSpeed = (bps) => `${fmtBytes(bps)}/s`;
function fmtEta(sec) {
  if (sec === null || sec === undefined) return '';
  if (sec < 60) return `${Math.max(1, sec)}s left`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s left`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m left`;
}

const liveTasks = () => [...state.tasks.values()];
const runningTasks = () => liveTasks().filter((t) => t.status === 'running' || t.status === 'paused');
const queuedTasks = () => liveTasks().filter((t) => t.status === 'queued');
const taskIcon = (t, size = 18) => h('div', { class: `act-ico ${t.kind || ''}` }, icon(TASK_ICONS[t.icon] || 'download', size));

function initActivity() {
  const btn = $('#activity-btn');
  const r = {
    btn,
    ico: h('span', { class: 'ab-ico' }, icon('activity', 18)),
    title: h('span', { class: 'ab-title' }, 'Activity'),
    sub: h('span', { class: 'ab-sub' }),
    badge: h('span', { class: 'ab-badge', hidden: true }),
  };
  r.spinner = h('div', { class: 'spinner', hidden: true });
  r.ico.append(r.spinner);
  r.idleIcon = r.ico.firstChild;
  btn.replaceChildren(r.ico, h('span', { class: 'ab-text' }, r.title, r.sub), r.badge);
  btn.addEventListener('click', () => (activityUi.open ? closeActivity() : openActivity()));
  activityUi.refs = r;

  const panel = h('div', { id: 'activity-panel', class: 'activity-panel', hidden: true });
  const p = {
    head: h('div', { class: 'act-head' }, h('b', null, 'Activity'), (activityUi.headInfo = h('span', { class: 'act-head-info' }))),
    active: h('div', { class: 'act-list' }),
    queuedHead: h('div', { class: 'act-section' }, 'Queued'),
    queued: h('div', { class: 'act-list' }),
    doneHead: h('div', { class: 'act-section' }, h('span', null, 'Completed'),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => call('tasks:clearHistory').catch((e) => toast(e.message, 'error')) }, 'Clear all')),
    done: h('div', { class: 'act-list' }),
    empty: h('div', { class: 'act-empty' }, 'Nothing running. Installs and downloads show up here.'),
  };
  panel.append(p.head, p.active, p.queuedHead, p.queued, p.doneHead, p.done, p.empty);
  document.body.append(panel);
  activityUi.panel = p;
  activityUi.panelEl = panel;
  document.addEventListener('mousedown', (e) => {
    if (activityUi.open && !panel.contains(e.target) && !btn.contains(e.target) && !$('#modal-root').contains(e.target)) closeActivity();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && activityUi.open && !$('#modal-root').children.length) closeActivity(); });
  setInterval(() => { if (activityUi.open) renderHistory(); }, 30000); // "2 minutes ago" stays fresh
  renderActivity();
  renderHistory();
}

function openActivity() {
  activityUi.open = true;
  const b = activityUi.refs.btn.getBoundingClientRect();
  const el = activityUi.panelEl;
  el.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - Math.min(420, window.innerWidth - 24) - 8))}px`; // stays on screen when the sidebar is on the right
  el.style.bottom = `${window.innerHeight - b.top + 8}px`;
  el.hidden = false;
  activityUi.refs.btn.classList.add('open');
  renderActivity();
  renderHistory();
}

function closeActivity() {
  activityUi.open = false;
  activityUi.panelEl.hidden = true;
  activityUi.refs.btn.classList.remove('open');
}

/** One running / paused / queued task. build() makes the DOM once; update(t) patches it. */
function buildTaskRow(t) {
  const r = {};
  const open = () => activityUi.expanded.has(t.id);
  const setOpen = (on) => { if (on) activityUi.expanded.add(t.id); else activityUi.expanded.delete(t.id); r.el.classList.toggle('open', on); row.update(row.last); };
  r.title = h('div', { class: 'act-title ellipsis' });
  r.step = h('div', { class: 'act-step ellipsis' });
  r.fill = h('i');
  r.bar = h('div', { class: 'bar' }, r.fill);
  r.stats = h('div', { class: 'act-stats' });
  r.details = h('div', { class: 'act-details' });
  r.pauseIco = icon('pause', 14);
  r.playIco = icon('play', 14);
  r.playIco.hidden = true;
  r.pause = h('button', { class: 'btn ghost icon sm', type: 'button', onclick: () => call(row.last.status === 'paused' ? 'tasks:resume' : 'tasks:pause', t.id).catch((e) => toast(e.message, 'error')) }, r.pauseIco, r.playIco);
  r.cancel = h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Cancel', onclick: () => cancelTask(row.last) }, icon('x', 14));
  r.chev = h('button', { class: 'btn ghost icon sm act-chev', type: 'button', title: 'Details', onclick: () => setOpen(!open()) }, icon('chevronDown', 14));
  r.el = h('div', { class: `act-row ${open() ? 'open' : ''}` },
    h('div', { class: 'act-top' }, taskIcon(t), h('div', { class: 'act-main' }, r.title, r.step), h('div', { class: 'act-actions' }, r.pause, r.cancel, r.chev)),
    h('div', { class: 'act-body' }, r.bar, r.stats, r.details));
  const row = {
    el: r.el,
    last: t,
    update(t2) {
      row.last = t2;
      const paused = t2.status === 'paused';
      const queued = t2.status === 'queued';
      r.title.textContent = t2.title;
      r.title.title = t2.title;
      r.step.textContent = t2.cancelling ? 'Cancelling…' : paused ? 'Paused' : queued ? 'Waiting for the current install to finish' : (t2.step || 'Working…');
      r.el.classList.toggle('open', open());
      r.el.classList.toggle('paused', paused);
      r.el.classList.toggle('queued', queued);
      r.pause.hidden = queued;
      r.pause.disabled = Boolean(t2.cancelling);
      r.cancel.disabled = Boolean(t2.cancelling);
      r.pause.title = paused ? 'Resume' : 'Pause';
      r.pauseIco.hidden = paused;
      r.playIco.hidden = !paused;
      r.bar.hidden = queued;
      r.bar.classList.toggle('indeterminate', !queued && (t2.progress === null || t2.progress === undefined));
      r.fill.style.width = `${Math.round((t2.progress || 0) * 100)}%`;
      const stats = [];
      if (t2.bytesTotal > 0) stats.push(`${fmtBytes(t2.bytesDone)} / ${fmtBytes(t2.bytesTotal)}`);
      if (t2.filesTotal > 0) stats.push(`${t2.filesDone}/${t2.filesTotal} files`);
      if (t2.status === 'running' && t2.speed > 0) stats.push(fmtSpeed(t2.speed));
      if (t2.status === 'running' && t2.eta !== null && t2.eta !== undefined) stats.push(fmtEta(t2.eta));
      r.stats.textContent = queued ? '' : stats.join(' · ');
      r.stats.hidden = queued || !stats.length;
      r.chev.hidden = queued;
      if (open() && !queued) {
        const kids = [];
        for (const f of t2.activeFiles || []) {
          const pct = f.total > 0 ? Math.min(100, Math.round((f.done / f.total) * 100)) : 0;
          kids.push(h('div', { class: 'act-file' },
            h('span', { class: 'ellipsis', title: f.name }, f.name),
            h('div', { class: `bar ${f.total > 0 ? '' : 'indeterminate'}` }, h('i', { style: { width: `${pct}%` } })),
            h('small', null, f.total > 0 ? `${fmtBytes(f.done)} / ${fmtBytes(f.total)}` : fmtBytes(f.done))));
        }
        if (!kids.length) kids.push(h('div', { class: 'act-note' }, paused ? 'Paused. Files in progress start again on Resume.' : 'No file is downloading at this moment.'));
        if ((t2.failedFiles || []).length) {
          kids.push(h('div', { class: 'act-fail-head' }, `${t2.failedFiles.length} file${t2.failedFiles.length === 1 ? '' : 's'} failed so far`));
          for (const f of t2.failedFiles.slice(-6)) kids.push(h('div', { class: 'act-fail', title: f.error }, h('span', { class: 'ellipsis' }, f.name), h('small', null, f.error)));
          kids.push(h('div', { class: 'act-note' }, 'Junction tries these once more at the end. Anything still missing can be retried from Completed.'));
        }
        r.details.replaceChildren(...kids);
      } else if (r.details.firstChild) r.details.replaceChildren();
    },
  };
  row.update(t);
  return row;
}

/** "Installing Craftoria" -> "Craftoria": finished rows already show the kind and the result. */
function plainName(title) {
  return String(title || '').replace(/^(Installing|Updating|Importing|Repairing|Preparing|Sending|Adding|Identifying|Checking for|Waiting for download…)\s+/i, '') || title;
}

async function cancelTask(t) {
  if (t.createsInstance) {
    closeActivity(); // the panel would cover the dialog
    const ok = await confirmDialog(`Cancel installing ${plainName(t.title)}?`, 'This stops the download and deletes the half-installed instance. Anything already downloaded for it is removed.', 'Cancel and delete', true, 'Keep installing');
    if (!ok) return;
  }
  call('tasks:cancel', t.id).catch((e) => toast(e.message, 'error'));
}

function syncRows(box, tasks) {
  const keep = new Set(tasks.map((t) => t.id));
  for (const [id, row] of activityUi.rows) {
    if (row.el.parentNode === box && !keep.has(id)) { row.el.remove(); activityUi.rows.delete(id); }
  }
  tasks.forEach((t, i) => {
    let row = activityUi.rows.get(t.id);
    if (!row) { row = buildTaskRow(t); activityUi.rows.set(t.id, row); } else row.update(t);
    if (box.children[i] !== row.el) box.insertBefore(row.el, box.children[i] || null);
  });
}

function renderActivity() {
  const r = activityUi.refs;
  if (!r) return;
  const running = runningTasks();
  const queued = queuedTasks();
  const speed = running.reduce((n, t) => n + (t.status === 'running' ? t.speed || 0 : 0), 0);
  const count = running.length + queued.length;
  const allPaused = running.length > 0 && running.every((t) => t.status === 'paused');
  r.btn.classList.toggle('busy', count > 0);
  r.spinner.hidden = !(running.length && !allPaused);
  r.idleIcon.hidden = Boolean(running.length && !allPaused);
  r.title.textContent = running[0] ? running[0].title : queued[0] ? queued[0].title : 'Activity';
  r.sub.textContent = running.length ? (allPaused ? 'Paused' : speed > 0 ? fmtSpeed(speed) : (running[0].step || 'Working…')) : (queued.length ? 'Waiting…' : '');
  r.sub.hidden = !r.sub.textContent;
  r.badge.textContent = String(count);
  r.badge.hidden = count === 0;
  if (!activityUi.open) return;
  const p = activityUi.panel;
  activityUi.headInfo.textContent = count ? [`${running.length} active`, queued.length ? `${queued.length} queued` : null, speed > 0 ? fmtSpeed(speed) : null].filter(Boolean).join(' · ') : 'Idle';
  syncRows(p.active, running);
  syncRows(p.queued, queued);
  p.queuedHead.hidden = !queued.length;
  p.queued.hidden = !queued.length;
  p.empty.hidden = Boolean(count || activityUi.history.length);
}

const FINISH_TEXT = {
  done: (e) => (e.problemCount ? `⚠ Done with problems: ${e.problemCount} item${e.problemCount === 1 ? '' : 's'} not installed` : e.failedCount ? `⚠ ${e.failedCount} file${e.failedCount === 1 ? '' : 's'} failed` : '✓ Done'),
  error: (e) => `✕ ${e.error || 'Something went wrong'}`,
  cancelled: () => '✕ Cancelled',
};

function renderHistory() {
  const r = activityUi.refs;
  if (!r) return;
  // forget expanded state of tasks that are gone
  for (const id of [...activityUi.expanded]) if (!state.tasks.has(id)) activityUi.expanded.delete(id);
  if (!activityUi.open) return;
  const p = activityUi.panel;
  const list = activityUi.history;
  p.doneHead.hidden = !list.length;
  p.done.hidden = !list.length;
  p.empty.hidden = Boolean(list.length || state.tasks.size);
  p.done.replaceChildren(...list.map((e) => {
    const linkable = e.instanceId && !(e.status === 'cancelled' && e.createsInstance);
    const retry = e.status === 'done' && e.failedCount && e.instanceId
      ? h('button', { class: 'btn sm', type: 'button', onclick: async (ev) => {
        ev.stopPropagation();
        try {
          const r2 = await call('content:retryFailed', e.instanceId);
          toast(r2.failed.length ? `${r2.failed.length} still can't be downloaded. Try again in a few minutes.` : `Downloaded ${r2.fixed.length} file${r2.fixed.length === 1 ? '' : 's'}`, r2.failed.length ? 'warn' : 'good');
        } catch (err) { toast(err.message, 'error'); }
      } }, 'Retry') : null;
    return h('div', { class: `act-row done ${e.status} ${linkable ? 'link' : ''}`, onclick: linkable ? () => { closeActivity(); go('instance', { id: e.instanceId }); } : null },
      h('div', { class: 'act-top' }, taskIcon(e),
        h('div', { class: 'act-main' },
          h('div', { class: 'act-title ellipsis', title: plainName(e.title) }, plainName(e.title)),
          h('div', { class: 'act-step' }, h('span', { class: 'kind-tag' }, KIND_LABELS[e.kind] || 'Task'), ` · ${ago(e.finished)}`),
          h('div', { class: `act-result ${e.status === 'done' && !e.failedCount && !e.problemCount ? 'good' : e.status === 'done' ? 'warn' : 'bad'}`, title: e.error || '' }, (FINISH_TEXT[e.status] || FINISH_TEXT.done)(e), retry ? ' → ' : '', retry),
          (e.problems || []).length ? h('div', { class: 'act-step' }, ...e.problems.slice(0, 6).map((p) => h('div', { class: 'ellipsis', title: `${p.title}: ${p.why}` }, `${p.title}: ${p.why}`)), e.problemCount > 6 ? h('div', null, `and ${e.problemCount - 6} more`) : null) : null),
        h('div', { class: 'act-actions' },
          h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Remove', onclick: (ev) => { ev.stopPropagation(); call('tasks:removeHistory', e.id).catch(() => {}); } }, icon('x', 14)))));
  }));
}

on('task:update', (t) => {
  if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') {
    state.tasks.delete(t.id);
    if (t.status === 'cancelled') toast(`Cancelled ${t.title}`, 'info', 3000);
  } else {
    state.tasks.set(t.id, t);
  }
  renderActivity();
});

on('task:history', (list) => { activityUi.history = list; renderHistory(); renderActivity(); });

// ---------------------------------------------------------------- launching
/** Before launch: if the memory is outside the pack's own range, ask what to do. Resolves true to go on launching. */
async function memoryRangeCheck(inst) {
  const r = await call('inst:memoryCheck', inst.id).catch(() => null);
  if (!r?.check) return true;
  const c = r.check;
  const G = JunctionMemory.gbText;
  const text = c.problem === 'high'
    ? `${inst.name} is set to ${G(c.mb)}, but ${r.packName} allows at most ${G(c.limitMB)}. The game would show its own warning screen.`
    : `${inst.name} is set to ${G(c.mb)}, but ${r.packName} needs at least ${G(c.limitMB)}. The game would show its own warning screen.`;
  return new Promise((resolve) => {
    let answered = false;
    const done = (v) => { answered = true; resolve(v); };
    modal({
      title: 'Memory outside the pack’s range',
      body: h('p', { style: { margin: 0, lineHeight: 1.5 } }, text),
      actions: [
        { label: "Don't ask again for this instance", class: 'ghost', onClick: async () => { await call('inst:update', inst.id, { memoryWarnOff: true }); done(true); } },
        { label: 'Launch anyway', onClick: () => done(true) },
        { label: `Use recommended (${G(c.recommendedMB)})`, class: 'primary', onClick: async () => { await call('inst:update', inst.id, { memoryMode: 'recommended' }); done(true); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

async function play(inst) {
  try {
    if (!(await memoryRangeCheck(inst))) return;
    await call('inst:launch', inst.id);
  } catch (e) {
    if (e.code === 'NO_ACCOUNT') {
      const ok = await confirmDialog('Add an account first', 'You need a Microsoft account that owns Minecraft to play.', 'Add account');
      if (ok) openAccountMenu($('#account-chip'));
    } else if (e.code === 'RELOGIN') {
      toast(e.message, 'error');
      openAccountMenu($('#account-chip'));
    } else if (e.code === 'NO_CLIENT_ID') {
      toast(e.message, 'error');
      go('settings');
    } else {
      toast(e.message, 'error');
    }
  }
}

function playButton(inst, size = '') {
  const st = state.running.get(inst.id) || inst.state;
  if (st === 'preparing') return h('button', { class: `btn ${size}`, type: 'button', disabled: true }, h('div', { class: 'spinner' }), 'Preparing');
  if (st === 'running') {
    return h('button', { class: `btn danger ${size}`, type: 'button', onclick: (e) => { e.stopPropagation(); call('inst:kill', inst.id); } }, icon('stop'), 'Stop');
  }
  return h('button', { class: `btn good ${size}`, type: 'button', onclick: (e) => { e.stopPropagation(); play(inst); } }, icon('play'), 'Play');
}

on('inst:state', ({ id, state: st, exit, error }) => {
  if (st) state.running.set(id, st); else state.running.delete(id);
  if (exit && exit.code !== 0 && exit.code !== null) {
    toast(`Minecraft exited with code ${exit.code}.${exit.crashReport ? ' A crash report was written — see the Logs tab.' : ''}`, 'error');
  }
  if (error && !/already running/.test(error)) { /* already toasted by caller */ }
  if (state.view === 'library' || state.view === 'home') go(state.view);
  if (state.view === 'instance' && state.params.id === id) refreshInstanceHeader();
});

on('inst:log', ({ id, lines }) => {
  const fn = state.logListeners.get(id);
  if (fn) fn(lines);
});
