'use strict';
// "Copy worlds and settings from…" (instance ⋯ menu). Plain script: shares one global scope with the other src/renderer files.
// Step 1 picks the source (another Junction instance, one found in another launcher, or a folder); step 2 picks what to copy.

function copyWorldsDialog(inst) {
  if (state.running.get(inst.id)) { toast('Close the game first: worlds can\'t be copied into a running instance.', 'error'); return; }
  const listBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, loading('Looking for instances…'));
  const m = modal({
    title: `Copy worlds and settings into ${inst.name}`,
    body: [
      h('div', { class: 'hint' }, 'Pick where to copy from. The other instance is only read, never changed.'),
      listBox,
    ],
    actions: [
      { label: 'Browse for a folder…', class: 'ghost', icon: 'folder', onClick: async () => {
        const info = await call('import:pickFolder');
        if (!info) return true; // picker cancelled: keep this window
        setTimeout(() => copyWorldsChoose(inst, { folder: info.folder }, info.name), 0);
      } },
      { label: 'Cancel', class: 'ghost' },
    ],
  });
  m.el.style.width = 'min(720px, 100%)';
  const pick = (source, name) => { m.close(); copyWorldsChoose(inst, source, name); };
  const row = (title, sub, source, iconSrc) => h('button', { class: 'item', type: 'button', style: { gridTemplateColumns: '34px 1fr', textAlign: 'left', width: '100%' }, onclick: () => pick(source, title) },
    avatar({ name: title, iconSrc: iconSrc || null }, 'sm'),
    h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis' }, title), h('div', { class: 'i-file ellipsis' }, sub)));

  (async () => {
    try {
      const mine = (await call('inst:list')).filter((i) => i.id !== inst.id);
      const sections = [];
      if (mine.length) {
        sections.push(h('div', null, h('b', null, 'Your Junction instances'),
          h('div', { class: 'list', style: { marginTop: '6px' } }, mine.map((i) => row(i.name, `Minecraft ${i.mcVersion}`, { instanceId: i.id }, i.iconSrc)))));
      }
      listBox.replaceChildren(...sections, h('div', { id: 'copy-others' }, loading('Looking in other launchers…')));
      const { instances: found } = await call('import:scan');
      const others = found.filter((f) => f.gameDir);
      const box = listBox.querySelector('#copy-others');
      if (!box) return;
      const groups = new Map();
      for (const f of others) { if (!groups.has(f.launcher)) groups.set(f.launcher, []); groups.get(f.launcher).push(f); }
      if (!groups.size) { box.replaceChildren(h('div', { class: 'hint' }, mine.length ? 'No instances found in other launchers.' : 'No other instances found. Use “Browse for a folder…” to pick one yourself.')); return; }
      box.replaceChildren(...[...groups.entries()].map(([launcher, list]) => h('div', { style: { marginBottom: '10px' } }, h('b', null, launcher),
        h('div', { class: 'list', style: { marginTop: '6px' } }, list.map((f) => row(f.name, `${f.mcVersion ? `Minecraft ${f.mcVersion}` : 'version unknown'} · ${f.folder}`, { folder: f.folder }, f.preview))))));
    } catch (e) {
      listBox.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), e.message));
    }
  })();
}

async function copyWorldsChoose(inst, source, sourceName) {
  const body = h('div', null, loading('Reading worlds…'));
  let go_ = null;
  const m = modal({
    title: `Copy from ${sourceName || 'instance'}`,
    body: [body],
    actions: [
      { label: 'Back', class: 'ghost', onClick: () => { setTimeout(() => copyWorldsDialog(inst), 0); } },
      { label: 'Copy', class: 'primary', icon: 'download', disabled: true, onClick: async () => {
        const choices = collect();
        const plan = await call('copy:plan', inst.id, source, choices);
        if (plan.blocked.length) throw new Error(`"${plan.blocked[0].name}" is from a newer Minecraft than ${inst.name} uses.`);
        const lines = [];
        if (plan.overwrites.length) lines.push(`These already exist here and will be replaced (the old ones are saved in this instance's backups folder first): ${plan.overwrites.join(', ')}.`);
        if (plan.upgrades.length) lines.push(`${plan.upgrades.map((w) => `"${w.name}" (Minecraft ${w.worldVersion})`).join(', ')} will be upgraded when you open ${plan.upgrades.length === 1 ? 'it' : 'them'} in Minecraft ${inst.mcVersion}. After that, the older version can't open ${plan.upgrades.length === 1 ? 'it' : 'them'} any more.`);
        if (plan.unknown.length) lines.push(`${plan.unknown.map((w) => `"${w.name}"`).join(', ')}: Junction can't tell which Minecraft version ${plan.unknown.length === 1 ? 'it was' : 'they were'} saved in. If that is newer than ${inst.mcVersion}, the game may refuse to open ${plan.unknown.length === 1 ? 'it' : 'them'}.`);
        const needsOk = lines.length > 0;
        if (needsOk && !(await confirmDialog('Copy these?', lines.join('\n\n'), 'Copy anyway'))) return true;
        const r = await call('copy:run', inst.id, source, choices, needsOk);
        toast(`${r.summary}${r.backupDir ? '. Replaced files were saved in the backups folder.' : ''}`, 'good', 8000);
        go('instance', { id: inst.id });
      } },
    ],
  });
  m.el.style.width = 'min(720px, 100%)';
  go_ = m.el.querySelectorAll('.m-foot .btn')[1];

  const worldBoxes = []; const itemBoxes = [];
  const collect = () => ({
    worlds: worldBoxes.filter((b) => b.box.checked).map((b) => b.folder),
    items: itemBoxes.filter((b) => b.box.checked).map((b) => b.id),
  });
  const refresh = () => { const c = collect(); go_.disabled = !c.worlds.length && !c.items.length; };

  let info;
  try { info = await call('copy:inspect', inst.id, source); } catch (e) { body.replaceChildren(h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), e.message)); return; }

  const worldRow = (w) => {
    const blocked = w.status === 'newer';
    const box = h('input', { type: 'checkbox', disabled: blocked, onchange: refresh });
    worldBoxes.push({ box, folder: w.folder });
    const note = blocked ? { text: `Made in Minecraft ${w.version.name}: it can't go into ${info.targetVersion}`, color: 'var(--bad)' }
      : w.status === 'older' ? { text: `Minecraft ${w.version.name}: opening it in ${info.targetVersion} upgrades it`, color: 'var(--warn)' }
      : w.status === 'unknown' ? { text: w.version ? `Minecraft ${w.version.name} (snapshot or unusual version)` : 'Version unknown (an old world)', color: 'var(--warn)' }
      : { text: `Minecraft ${w.version.name}`, color: '' };
    return h('label', { class: 'item', style: { gridTemplateColumns: '22px 1fr auto', cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.6 : 1 } },
      box,
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'i-title ellipsis', title: w.folder }, w.name),
        h('div', { class: 'i-file ellipsis', style: { color: note.color } }, note.text)),
      h('span', { class: 'muted small' }, fmtBytes(w.size)));
  };
  const itemRow = (it) => {
    const box = h('input', { type: 'checkbox', onchange: refresh });
    itemBoxes.push({ box, id: it.id });
    return h('label', { class: 'item', style: { gridTemplateColumns: '22px 1fr auto', cursor: 'pointer' } }, box, h('div', { class: 'i-title' }, it.label), h('span', { class: 'muted small' }, fmtBytes(it.size)));
  };
  if (!info.worlds.length && !info.items.length) {
    body.replaceChildren(h('div', { class: 'empty', style: { padding: '28px 20px' } }, h('h2', null, 'Nothing to copy'), h('div', null, 'No worlds, options, server list, minimap data or schematics were found there.')));
    return;
  }
  body.replaceChildren(
    info.worlds.length ? h('div', { style: { marginBottom: '14px' } }, h('b', null, 'Worlds'), h('div', { class: 'list', style: { marginTop: '6px' } }, info.worlds.map(worldRow))) : null,
    info.items.length ? h('div', null, h('b', null, 'Settings and data'), h('div', { class: 'list', style: { marginTop: '6px' } }, info.items.map(itemRow))) : null,
    h('div', { class: 'hint', style: { marginTop: '12px' } }, `Anything that already exists here is saved to this instance's backups folder before it is replaced. ${sourceName || 'The other instance'} is not changed.`));
}
