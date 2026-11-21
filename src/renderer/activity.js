'use strict';
// The sidebar task list, and launching / stopping the game (play button, state and log events). Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ---------------------------------------------------------------- tasks sidebar
function renderTasks() {
  const box = $('#tasks');
  const items = [...state.tasks.values()].filter((t) => t.status !== 'done' || Date.now() - (t.finished || 0) < 4000).slice(-5);
  box.replaceChildren(...items.map((t) => {
    const indeterminate = t.status === 'running' && (t.progress === null || t.progress === undefined);
    return h('div', { class: `task ${t.status}` },
      h('div', { class: 't-title' }, h('span', { class: 'ellipsis' }, t.title),
        t.status === 'error' ? h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Dismiss', onclick: () => { state.tasks.delete(t.id); renderTasks(); } }, icon('x', 12)) : null),
      h('div', { class: 't-detail', title: t.error || t.detail || '' }, t.status === 'error' ? t.error : (t.status === 'done' ? 'Done' : t.detail || 'Working…')),
      t.status === 'running' ? h('div', { class: `bar ${indeterminate ? 'indeterminate' : ''}` }, h('i', { style: { width: `${Math.round((t.progress || 0) * 100)}%` } })) : null);
  }));
}

on('task:update', (t) => {
  if (t.status === 'done') t.finished = Date.now();
  state.tasks.set(t.id, t);
  renderTasks();
  if (t.status === 'done') setTimeout(renderTasks, 4200);
});

// ---------------------------------------------------------------- launching
async function play(inst) {
  try {
    await call('inst:launch', inst.id);
  } catch (e) {
    if (e.code === 'NO_ACCOUNT') {
      const ok = await confirmDialog('Add an account first', 'You need a Microsoft account that owns Minecraft to play.', 'Go to Accounts');
      if (ok) go('accounts');
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
  if (state.view === 'library') go('library');
  if (state.view === 'instance' && state.params.id === id) refreshInstanceHeader();
});

on('inst:log', ({ id, lines }) => {
  const fn = state.logListeners.get(id);
  if (fn) fn(lines);
});
