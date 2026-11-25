'use strict';
// Junction updating itself: the "Update available" bar and the live state the About tab shows. Plain script: shares one global scope with the other
// src/renderer files (load order is in index.html). The logic lives in src/core/updates.js; this only draws it. Nothing installs without the click here.

let selfUpdateState = null; // the last state from the main process: { status, version, percent, message, notesUrl, supported, releasesUrl, ... }
const selfUpdateWatchers = new Set(); // functions the About tab adds so its status line follows along while it is open

function selfUpdateBar() {
  const bar = document.getElementById('update-bar');
  if (!bar) return;
  const s = selfUpdateState;
  const show = s && s.supported && (s.status === 'downloading' || s.status === 'ready');
  bar.hidden = !show;
  if (!show) { bar.replaceChildren(); return; }
  const ready = s.status === 'ready';
  bar.replaceChildren(h('div', { class: 'update-bar-in', role: 'status' },
    icon('download', 16),
    h('div', { class: 'ub-text' },
      h('b', null, `Update available (${s.version})`),
      h('span', { class: 'muted' }, ready ? ' · Ready to install' : ` · Downloading… ${s.percent || 0}%`)),
    s.notesUrl ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => call('shell:open', s.notesUrl) }, icon('external', 13), 'Release notes') : null,
    h('button', {
      class: 'btn primary sm', type: 'button', disabled: !ready,
      onclick: async (e) => { e.currentTarget.disabled = true; try { await call('updates:install'); } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; } },
    }, 'Install and restart')));
}

function selfUpdateSet(st) {
  selfUpdateState = st;
  selfUpdateBar();
  for (const fn of [...selfUpdateWatchers]) fn(st);
}

on('updates:state', selfUpdateSet);
call('updates:state').then(selfUpdateSet).catch(() => { /* the bar just stays away */ });

/** One line for the About tab: what the last check found. */
function selfUpdateLine(st) {
  if (!st) return '';
  if (st.status === 'checking') return 'Checking GitHub…';
  if (st.status === 'downloading') return `Version ${st.version} is available. Downloading… ${st.percent || 0}%`;
  if (st.status === 'ready') return `Version ${st.version} is ready. Use “Install and restart” at the bottom of the window.`;
  if (st.status === 'error') return st.message;
  if (st.status === 'uptodate') return `You have the newest version${st.lastChecked ? ` (checked ${new Date(st.lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}.`;
  return '';
}

/** The "Updates" block of the About tab. Installed builds get the switch and Check now; the zip, MSI and dev builds get a pointer to Releases. */
function selfUpdateSection(s, info, auto) {
  const body = h('div', null);
  const line = h('div', { class: 'hint', 'aria-live': 'polite', style: { marginTop: '8px' } });
  const btn = h('button', { class: 'btn', type: 'button', onclick: () => { btn.disabled = true; call('updates:check').catch((e) => toast(e.message, 'error')); } }, icon('refresh', 14), 'Check now');
  let seen = false; // once the tab was on screen and then is gone, stop following
  const paint = (st) => {
    if (body.isConnected) seen = true; else if (seen) { selfUpdateWatchers.delete(paint); return; }
    line.textContent = selfUpdateLine(st);
    btn.disabled = Boolean(st && (st.status === 'checking' || st.status === 'downloading' || st.status === 'ready'));
  };
  const supported = selfUpdateState ? selfUpdateState.supported : true;
  if (!supported) {
    body.replaceChildren(
      h('p', null, `You have Junction ${info.version}. This copy does not update itself. New versions are on the Releases page.`),
      h('button', { class: 'btn', type: 'button', onclick: () => call('shell:open', `${REPO_URL}/releases`) }, icon('external', 14), 'Open the Releases page'));
  } else {
    body.replaceChildren(
      h('p', null, `You have Junction ${info.version}. Junction looks for new versions on GitHub (it asks GitHub's release list and nothing else, and sends no identifiers). It never installs anything until you click.`),
      setCheckbox(auto, 'checkForUpdates', s.checkForUpdates !== false, 'Check for updates automatically'),
      h('div', { class: 'row wrap', style: { marginTop: '12px' } }, btn,
        h('button', { class: 'btn ghost', type: 'button', onclick: () => call('shell:open', `${REPO_URL}/releases`) }, icon('external', 14), 'Release notes')),
      line);
    selfUpdateWatchers.add(paint);
    paint(selfUpdateState);
  }
  return h('div', { class: 'section' }, h('h3', null, 'Updates'), body);
}
