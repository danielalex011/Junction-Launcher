'use strict';
// The Library page (instance cards). Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ---------------------------------------------------------------- library
async function renderLibrary(_p, token) {
  const [list, badges, added] = await Promise.all([call('inst:list'), call('home:badges').catch(() => ({})), call('inst:addedCounts').catch(() => ({}))]); // badges: cached update info, no network
  if (stale(token)) return;
  for (const i of list) if (i.state) state.running.set(i.id, i.state);
  const head = h('div', { class: 'page-head' },
    h('h1', null, 'Library'),
    h('button', { class: 'btn', type: 'button', onclick: (e) => importMenu(e.currentTarget) }, icon('login'), 'Import'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => newInstanceDialog() }, icon('plus'), 'New instance'));
  let body;
  if (!list.length) {
    body = h('div', { class: 'empty' },
      h('h2', null, 'No instances yet'),
      h('div', null, 'Make your own, install a modpack from Modrinth or CurseForge, or bring instances over from another launcher.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary lg', type: 'button', onclick: () => newInstanceDialog() }, icon('plus'), 'Create an instance'),
        h('button', { class: 'btn lg', type: 'button', onclick: () => go('browse', { type: 'modpack' }) }, icon('box'), 'Browse modpacks'),
        h('button', { class: 'btn lg', type: 'button', onclick: () => importFromLaunchers() }, icon('login'), 'Import from another launcher')));
  } else {
    body = h('div', { class: 'grid' }, list.map((inst) => h('div', { class: 'card', onclick: () => go('instance', { id: inst.id }) },
      h('div', { class: 'c-top' }, avatar(inst),
        h('div', { class: 'grow' },
          h('div', { class: 'c-name', title: inst.name }, inst.name),
          h('div', { class: 'c-sub', title: instSubtitle(inst) }, instSubtitle(inst)))),
      h('div', { class: 'c-foot' },
        h('span', { class: 'row' }, state.running.get(inst.id) === 'running' ? h('span', { class: 'state-dot' }) : null,
          updateBadge(inst.id, badges[inst.id]),
          inst.pack ? sourceBadge(inst.pack.source === 'file' ? 'file' : inst.pack.source) : null,
          addedBadge(inst, added[inst.id]),
          h('span', { class: 'ellipsis', title: inst.lastPlayed ? `Last played ${ago(inst.lastPlayed)}` : '' }, inst.lastPlayed ? agoShort(inst.lastPlayed) : 'Never played')),
        playButton(inst, 'sm')))));
  }
  view().replaceChildren(h('div', { class: 'page page-full' }, head, body));
}

function importMenu(anchor) {
  popupMenu(anchor, [
    { label: 'Modpack file (.mrpack / CurseForge .zip)', icon: 'file', onClick: () => importPackFile() },
    { label: 'Instances from other launchers…', icon: 'folder', onClick: () => importFromLaunchers() },
  ]);
}

/** One sentence for a pack install that left files behind: how many, which, never a URL or an HTML page. */
function failedSummary(list) {
  const n = list.length;
  const names = list.slice(0, 5).map((f) => f.name).join(', ') + (n > 5 ? `, and ${n - 5} more` : '');
  return `${n} file${n === 1 ? '' : 's'} couldn't be downloaded: ${names}. Open the instance to retry them.`;
}

/** The notice at the top of an instance: files that failed to download, with a button to try again. */
function failedNotice(inst, list, onChanged) {
  const n = list.length;
  const reasons = [...new Set(list.map((f) => f.error).filter(Boolean))];
  const names = list.slice(0, 8).map((f) => f.name).join(', ') + (n > 8 ? `, and ${n - 8} more` : '');
  const btn = h('button', { class: 'btn sm primary', type: 'button', onclick: async () => {
    btn.disabled = true;
    try {
      const r = await call('content:retryFailed', inst.id);
      if (r.failed.length) toast(`${r.fixed.length ? `${r.fixed.length} downloaded, but ` : ''}${r.failed.length} still can't be downloaded. Try again in a few minutes.`, 'warn', 8000);
      else toast(`Downloaded ${r.fixed.length} file${r.fixed.length === 1 ? '' : 's'}`, 'good');
      onChanged();
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  } }, icon('refresh'), 'Retry failed downloads');
  return h('div', { class: 'notice warn' }, icon('alert'),
    h('div', { class: 'grow' },
      h('div', null, `${n} file${n === 1 ? '' : 's'} couldn't be downloaded`),
      h('div', { class: 'hint' }, names),
      reasons.length ? h('div', { class: 'hint' }, reasons.join(' · ')) : null),
    btn);
}

async function repairFlow(inst) {
  try {
    const r = await call('pack:repair', inst.id);
    const fixed = r.repaired.length + r.restored.length;
    if (fixed) toast(`Repaired ${fixed} file${fixed === 1 ? '' : 's'} of ${inst.pack.name}`, r.failed.length ? 'warn' : 'good');
    else if (!r.failed.length && !r.blocked.length) toast(`Nothing to repair: all ${r.checked} pack files are in place.`, 'good');
    if (r.failed.length) toast(failedSummary(r.failed), 'warn', 10000);
    for (const w of (r.warnings || []).slice(0, 3)) toast(w, 'warn', 7000);
    if (r.blockedSession) blockedDialog(r.blockedSession, inst.id);
    if (state.view === 'instance' && state.params.id === inst.id) go('instance', state.params);
  } catch (e) { toast(e.message, 'error'); }
}

async function handleInstallResult(r, instId) {
  if (!r) return;
  const n = r.installed?.length || 0;
  const deps = Math.max(0, n - 1);
  if (r.instance && !instId) toast(`Installed ${r.instance.name}`, 'good');
  else if (n) toast(`Installed ${r.installed[0].title}${deps ? ` + ${deps} dependenc${deps > 1 ? 'ies' : 'y'}` : ''}`, 'good');
  else if (r.skipped?.length && !r.blocked?.length) toast(`${r.skipped[0].title}: ${r.skipped[0].reason}`, 'info');
  if (r.failed?.length) toast(failedSummary(r.failed), 'warn', 10000);
  for (const w of (r.warnings || []).slice(0, 4)) toast(w, 'warn', 7000);
  if (r.blockedSession) blockedDialog(r.blockedSession, instId || r.instance?.id);
}

async function importPackFile(filePath) {
  try {
    const r = await call('pack:importFile', filePath || null);
    if (!r) return;
    await handleInstallResult(r);
    go('instance', { id: r.instance.id });
  } catch (e) { toast(e.message, 'error'); }
}
