'use strict';
// Instance templates: "Save as template" (instance ⋯ menu), the list in Settings → General, and the review shown before a template
// is installed into a new instance. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

const TPL_TYPE_LABEL = { mod: 'Mods', resourcepack: 'Resource packs', shader: 'Shaders' };

function tplCountText(c) {
  const parts = [];
  if (c.mod) parts.push(`${c.mod} mod${c.mod === 1 ? '' : 's'}`);
  if (c.resourcepack) parts.push(`${c.resourcepack} resource pack${c.resourcepack === 1 ? '' : 's'}`);
  if (c.shader) parts.push(`${c.shader} shader${c.shader === 1 ? '' : 's'}`);
  return parts.join(', ') || 'nothing from Modrinth or CurseForge';
}

function saveTemplateDialog(inst) {
  const name = h('input', { type: 'text', value: inst.name, 'aria-label': 'Template name' });
  const box = (label, checked = false) => { const i = h('input', { type: 'checkbox', checked }); return { i, el: h('label', { class: 'check' }, i, label) }; };
  const configs = box('Config files (the config folder)');
  const options = box('Game options (options.txt: keybinds and video settings)');
  const packs = box('Resource packs');
  const shaders = box('Shaders');
  modal({
    title: 'Save as template',
    body: [
      h('p', { style: { margin: 0, lineHeight: 1.5, color: 'var(--muted)' } }, 'A template remembers which mods this instance uses (as Modrinth and CurseForge projects, not as files), so you can build a new instance from it for any Minecraft version or loader.'),
      h('label', { class: 'field' }, 'Template name', name),
      h('div', { class: 'field' }, h('span', { class: 'small muted', style: { fontWeight: 600 } }, 'Also save'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, configs.el, options.el, packs.el, shaders.el)),
      h('div', { class: 'hint' }, 'Files that did not come from Modrinth or CurseForge cannot be rebuilt. They are listed after saving and left out.'),
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      { label: 'Save template', class: 'primary', icon: 'check', onClick: async () => {
        const t = await call('template:save', inst.id, { name: name.value.trim(), include: { configs: configs.i.checked, options: options.i.checked, resourcepacks: packs.i.checked, shaders: shaders.i.checked } });
        toast(`Saved template “${t.name}”: ${tplCountText(t.counts)}`, 'good');
        if (t.skipped.length) setTimeout(() => tplSkippedDialog(t), 0);
      } },
    ],
  });
}

function tplSkippedDialog(t) {
  modal({
    title: `${t.skipped.length} file${t.skipped.length === 1 ? ' was' : 's were'} left out of “${t.name}”`,
    body: [
      h('p', { style: { margin: 0, lineHeight: 1.5 } }, 'These do not come from Modrinth or CurseForge, so Junction cannot download them again. Add them to a new instance by hand if you still want them.'),
      h('div', { class: 'list' }, t.skipped.map((s) => h('div', { class: 'item', style: { gridTemplateColumns: '1fr' } },
        h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis' }, s.title), h('div', { class: 'i-file ellipsis' }, `${TPL_TYPE_LABEL[s.type] || ''} · ${s.why}`))))),
    ],
    actions: [{ label: 'OK', class: 'primary' }],
  });
}

/** The list under Settings → General: rename and delete. */
function templatesSection() {
  const listBox = h('div', { class: 'list' });
  const section = h('div', { class: 'section', id: 'templates' }, h('h3', null, 'Instance templates'),
    h('p', null, 'Save an instance as a template from its ⋯ menu, then start a new instance from it.'), listBox);
  const draw = async () => {
    let list;
    try { list = await call('template:list'); } catch (e) { listBox.replaceChildren(h('div', { class: 'hint' }, e.message)); return; }
    if (!list.length) { listBox.replaceChildren(h('div', { class: 'hint', style: { padding: '10px 12px' } }, 'No templates yet.')); return; }
    listBox.replaceChildren(...list.map((t) => h('div', { class: 'item', style: { gridTemplateColumns: '1fr auto' } },
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'i-title ellipsis' }, t.name),
        h('div', { class: 'i-file ellipsis' }, `${tplCountText(t.counts)} · from ${LOADER[t.loader?.type] || 'Vanilla'} ${t.mcVersion}${t.hasFiles ? ' · with settings files' : ''}`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => tplRenameDialog(t, draw) }, icon('edit', 14), 'Rename'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
          if (!(await confirmDialog(`Delete “${t.name}”?`, 'The template is deleted. Instances you made from it are not changed.', 'Delete', true))) return;
          try { await call('template:delete', t.id); toast(`Deleted ${t.name}`); draw(); } catch (e) { toast(e.message, 'error'); }
        } }, icon('trash', 14), 'Delete')))));
  };
  draw();
  return section;
}

function tplRenameDialog(t, done) {
  const name = h('input', { type: 'text', value: t.name, 'aria-label': 'Template name' });
  modal({
    title: 'Rename template',
    body: [h('label', { class: 'field' }, 'Name', name)],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      { label: 'Rename', class: 'primary', onClick: async () => { await call('template:rename', t.id, name.value); done(); } },
    ],
  });
}

/**
 * The review before anything is installed: will add / needed by other mods / may not work together / already in the pack /
 * not available / skipped. `plan` comes from template:plan. onConfirm(chosen) runs only when the user presses the button.
 * opts: { verb: 'Create and install', empty: 'Create instance' } for a new instance; the default is for an existing one.
 *   afterPackInstall: the modpack was installed just now for this review (changes the wording when nothing fits).
 *   onDismiss: runs when the window is closed or "Back" is pressed without confirming.
 */
function templateReviewDialog(plan, onConfirm, opts = {}) {
  const inst = plan.instance;
  const verb = opts.verb || (inst ? 'Add' : 'Create and install');
  const emptyLabel = opts.empty || 'Create instance';
  const adds = plan.items.filter((i) => i.status === 'add' && !i.dependency).map((i) => ({ ...i, on: true }));
  const deps = plan.items.filter((i) => i.status === 'add' && i.dependency).map((i) => ({ ...i, on: true }));
  const clashes = plan.items.filter((i) => i.status === 'conflict').map((i) => ({ ...i, on: false })); // never ticked for you
  const inPack = plan.items.filter((i) => i.status === 'have' && i.have === 'pack');
  const inInst = plan.items.filter((i) => i.status === 'have' && i.have !== 'pack');
  const missing = plan.items.filter((i) => i.status === 'unavailable').map((i) => ({ ...i, on: false }));
  const skipped = plan.items.filter((i) => i.status === 'skipped');
  const loaderName = LOADER[plan.loader.type] || 'Vanilla';
  const kept = plan.kept || [];
  let btn;
  let confirmed = false;
  const chosenNow = () => [...adds, ...deps, ...clashes, ...missing.filter((m) => m.forceable)].filter((a) => a.on);
  const sync = () => {
    const n = chosenNow().length;
    const files = (plan.copies || []).length > 0;
    if (!btn) return;
    // An existing instance: with nothing to add or copy the button just says Done. A new instance still needs something to create.
    btn.disabled = n === 0 && !files && !inst;
    if (n) btn.replaceChildren(icon('plus'), `${verb} ${n}`);
    else if (files) btn.replaceChildren(icon('plus'), 'Copy files');
    else btn.replaceChildren(icon(inst ? 'check' : 'plus'), inst ? 'Done' : emptyLabel);
  };
  const group = (title, hint, rows) => (rows.length ? h('div', null, h('b', null, title), hint ? h('div', { class: 'hint', style: { margin: '2px 0 6px' } }, hint) : null, h('div', { class: 'list' }, rows)) : null);
  const row = (i, extra, lead, sub) => h('div', { class: 'item', style: { gridTemplateColumns: `${lead ? '22px ' : ''}34px 1fr auto` } },
    lead || null, avatar({ icon: i.icon, title: i.title }, 'sm'),
    h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis' }, i.title), h('div', { class: 'i-file ellipsis', title: sub || i.reason || '' }, sub || `${TPL_TYPE_LABEL[i.type] || ''}${i.reason ? ` · ${i.reason}` : ''}`)),
    extra || null);
  const tick = (a, label) => h('input', { type: 'checkbox', checked: a.on, 'aria-label': label, onchange: (e) => { a.on = e.target.checked; sync(); } });
  const badges = (a) => h('div', { class: 'row', style: { gap: '6px' } },
    a.manual ? h('span', { class: 'badge plain warn', title: 'The author only allows downloads from their own page. Junction will help you get it.' }, 'manual download') : null,
    a.releaseType && a.releaseType !== 'release' ? releaseBadge(a.releaseType) : null,
    h('span', { class: 'muted small' }, a.versionNumber));
  const nothingNew = !adds.length && !deps.length && !clashes.length;
  const keptWhat = plan.instance?.linked ? "the pack's" : 'your';
  const m = modal({
    title: `Review “${plan.template.name}”`,
    body: [
      h('p', { style: { margin: 0, lineHeight: 1.5, color: 'var(--muted)' } },
        `${inst ? `For ${inst.name}: ` : 'For '}Minecraft ${plan.mcVersion} with ${loaderName}. Nothing ${inst ? '' : 'is created or '}installs until you press the button. Junction picks the newest version of each project, preferring full releases.${inst?.linked ? ` ${inst.packName} stays as it is: what you add goes under “Added by you”, so pack updates never touch it.` : ''}`),
      (plan.copies || []).length ? h('div', { class: 'notice' }, icon('info'), `Also copies: ${plan.copies.join(', ')}`) : null,
      kept.length ? h('div', { class: 'notice' }, icon('info'), h('span', { title: kept.join('\n') }, `Kept ${keptWhat} version of: ${kept.slice(0, 6).join(', ')}${kept.length > 6 ? ` and ${kept.length - 6} more` : ''}`)) : null,
      group(`Will add (${adds.length})`, null, adds.map((a) => row(a, badges(a), tick(a, `Install ${a.title}`)))),
      group(`Will add, needed by other mods (${deps.length})`, 'The template does not have these, but the mods above need them to run.', deps.map((a) => row(a, badges(a), tick(a, `Install ${a.title}`), `Needed by ${a.neededBy.join(', ')}`))),
      group(`May not work together (${clashes.length})`, 'These are known to clash with something already in the instance, so they are not ticked. Tick one only if you know it works.',
        clashes.map((a) => row(a, badges(a), tick(a, `Install ${a.title} anyway`), a.reason))),
      group(`Already in the pack (${inPack.length})`, 'Not added again.', inPack.map((i) => row(i))),
      group(`Already installed (${inInst.length})`, 'Not added again.', inInst.map((i) => row(i))),
      group(`Not available for this version or loader (${missing.length})`, 'These are left out. If a mod only misses a dependency its author may have listed by mistake, you can tick “Install anyway”.',
        missing.map((i) => row(i, i.forceable ? h('label', { class: 'check small' }, tick(i, `Install ${i.title} anyway`), 'Install anyway') : null))),
      group(`Skipped (${skipped.length})`, null, skipped.map((i) => row(i))),
      nothingNew && (inPack.length || inInst.length) && !missing.length ? h('div', { class: 'notice' }, icon('info'), inst?.linked ? 'Everything in this template is already in the pack.' : 'Everything in this template is already installed.') : null,
      nothingNew && !(inPack.length || inInst.length)
        ? h('div', { class: 'notice warn' }, icon('alert'), inst
          ? `${opts.afterPackInstall ? `${inst.packName || inst.name} is installed. ` : ''}Nothing from “${plan.template.name}” has a version for Minecraft ${plan.mcVersion} with ${loaderName}.`
          : "None of the template's projects have a version for this Minecraft version and loader. Try another version.") : null,
    ],
    actions: [
      { label: 'Back', class: 'ghost' },
      { label: verb, class: 'primary', icon: 'plus', onClick: async () => {
        confirmed = true;
        try { await onConfirm(chosenNow(), plan); } catch (e) { confirmed = false; throw e; }
      } },
    ],
    onClose: () => { if (!confirmed && opts.onDismiss) opts.onDismiss(); },
    backdropClose: false, // a stray click beside the window must not count as "Back" (which can open the Keep / Remove question)
  });
  m.el.style.width = 'min(820px, 100%)';
  btn = m.el.querySelectorAll('.m-foot .btn')[1];
  sync();
}

/**
 * Installs what the review confirmed into an existing instance: follow it in Activity, then refresh the page.
 * Returns at once; the work goes on in the background.
 */
function templateInstall(inst, plan, chosen, templateId) {
  if (!chosen.length && !(plan.copies || []).length) return; // Done with nothing to add or copy
  toast(`Adding ${chosen.length} item${chosen.length === 1 ? '' : 's'} to ${inst.name}. Follow it in Activity.`, 'good');
  setTimeout(async () => {
    try {
      const r = await call('template:apply', inst.id, chosen, { confirmed: true, templateId, copyFiles: (plan.copies || []).length > 0 });
      templateResultReport(r, inst.name);
      if (r.blockedSession) await handleInstallResult({ blockedSession: r.blockedSession }, inst.id);
      if (state.view === 'instance' && state.params.id === inst.id) go('instance', state.params); // the page was drawn before the files arrived
    } catch (e) { toast(e.message, 'error'); }
  }, 0);
}

/** ⋯ → "Add mods from a template…": pick a template, review what it would add to this instance, then install. */
async function addTemplateDialog(inst) {
  let list;
  try { list = await call('template:list'); } catch (e) { toast(e.message, 'error'); return; }
  if (!list.length) { toast('No templates yet. Open an instance, then ⋯ → Save as template.'); return; }
  let templateId = list[0].id;
  modal({
    title: `Add mods from a template to ${inst.name}`,
    body: [
      h('p', { style: { margin: 0, lineHeight: 1.5, color: 'var(--muted)' } }, `Junction looks up each project for Minecraft ${inst.mcVersion} with ${LOADER[inst.loader?.type] || 'Vanilla'}, leaves out what ${inst.name} already has, and shows you a list first.${inst.linked ? ' Your additions stay separate from the modpack.' : ''}`),
      h('label', { class: 'field' }, 'Template', select(list.map((t) => ({ value: t.id, label: `${t.name} (${tplCountText(t.counts)})` })), templateId, (v) => { templateId = v; })),
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      { label: 'Review', class: 'primary', icon: 'check', onClick: async () => {
        const plan = await call('template:plan', templateId, { instanceId: inst.id });
        const id = templateId;
        setTimeout(() => templateReviewDialog(plan, async (chosen) => { templateInstall(inst, plan, chosen, id); }), 0);
      } },
    ],
  });
}

/** Modpack + template: install the pack as a normal linked modpack, then review the template against what the pack has. */
async function packTemplateFlow(pack, templateId, name = '') {
  try {
    toast(`Installing ${pack.title}. Follow it in Activity: the template review opens when the modpack is in.`, 'info', 8000);
    const r = await installPackChecked({ source: pack.source, projectId: pack.projectId, versionId: pack.versionId, title: pack.title, name: name || null });
    if (r.cancelled) return; // low disk space and the user chose Cancel
    await handleInstallResult(r);
    go('instance', { id: r.instance.id });
    const made = await call('inst:get', r.instance.id);
    const plan = await call('template:plan', templateId, { instanceId: made.id });
    setTimeout(() => templateReviewDialog(plan, async (chosen) => { templateInstall(made, plan, chosen, templateId); }, {
      afterPackInstall: true,
      // The pack is installed before this review, so leaving it without confirming has to say what happens to the pack.
      onDismiss: async () => {
        const remove = await confirmDialog(`Keep ${made.name} without the template?`,
          `${made.name} is already installed. Keep it as it is, without anything from “${plan.template.name}”, or remove it?`,
          'Remove it', true, 'Keep it');
        if (!remove) { toast(`Kept ${made.name} without the template`); return; }
        try {
          await call('inst:delete', made.id);
          toast(`Removed ${made.name}`);
          go('library');
        } catch (e) { toast(e.message, 'error'); }
      },
    }), 0);
  } catch (e) { toast(e.message, 'error'); }
}

/** Choose a modpack for "Modpack + template": one you already have, or search Modrinth and CurseForge. Resolves to { source, projectId, title, icon } or null. */
function pickModpackDialog() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { done = true; m.close(); resolve(v); };
    const installedBox = h('div', { class: 'list', style: { maxHeight: '180px', overflow: 'auto' } }, loading());
    const resultsBox = h('div', { class: 'list', style: { maxHeight: '260px', overflow: 'auto' } }, h('div', { class: 'hint', style: { padding: '10px 12px' } }, 'Type a name to search.'));
    const rowFor = (title, sub, ic, pick) => h('div', { class: 'item', role: 'button', tabindex: 0, style: { gridTemplateColumns: '34px 1fr', cursor: 'pointer' }, onclick: pick, onkeydown: (e) => { if (e.key === 'Enter') pick(); } },
      avatar({ icon: ic, title }, 'sm'), h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis' }, title), h('div', { class: 'i-file ellipsis' }, sub)));
    let timer = null;
    let seq = 0;
    const search = h('input', { type: 'text', placeholder: 'Search modpacks on Modrinth and CurseForge', 'aria-label': 'Search modpacks', oninput: () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (!q) { resultsBox.replaceChildren(h('div', { class: 'hint', style: { padding: '10px 12px' } }, 'Type a name to search.')); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        resultsBox.replaceChildren(loading('Searching…'));
        try {
          const r = await call('browse:search', { type: 'modpack', query: q, gameVersion: '', loader: '', sort: 'relevance', sources: ['modrinth', 'curseforge'], page: 0, pageSize: 12 });
          if (mine !== seq || done) return;
          if (!r.hits.length) { resultsBox.replaceChildren(h('div', { class: 'hint', style: { padding: '10px 12px' } }, 'No modpacks found.')); return; }
          resultsBox.replaceChildren(...r.hits.map((hit) => rowFor(hit.title, `${SRC[hit.source] || hit.source}${hit.alsoOn?.length ? ' + CurseForge' : ''} · ${hit.summary || ''}`, hit.icon, async () => {
            const choice = await chooseSource(hit, null);
            if (choice) finish({ source: choice.source, projectId: choice.projectId, title: hit.title, icon: hit.icon || null });
          })));
        } catch (e) { if (mine === seq) resultsBox.replaceChildren(h('div', { class: 'notice warn' }, icon('alert'), e.message)); }
      }, 300);
    } });
    const m = modal({
      title: 'Choose a modpack',
      body: [
        h('div', null, h('b', null, 'Already installed'), h('div', { class: 'hint', style: { margin: '2px 0 6px' } }, 'Starts a new instance with the newest version of that modpack.'), installedBox),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, h('b', null, 'Find another'), search, resultsBox),
      ],
      actions: [{ label: 'Cancel', class: 'ghost' }],
      onClose: () => { if (!done) resolve(null); },
    });
    call('inst:list').then((all) => {
      const seen = new Set();
      const packs = all.filter((i) => i.linked && i.pack && !seen.has(`${i.pack.source}:${i.pack.projectId}`) && seen.add(`${i.pack.source}:${i.pack.projectId}`));
      installedBox.replaceChildren(...(packs.length ? packs.map((i) => rowFor(i.pack.name, `${SRC[i.pack.source] || i.pack.source} · you have ${i.pack.versionName || 'a version'} in ${i.name}`, i.iconSrc || i.icon, () => finish({ source: i.pack.source, projectId: i.pack.projectId, title: i.pack.name, icon: i.iconSrc || i.icon || null })))
        : [h('div', { class: 'hint', style: { padding: '10px 12px' } }, 'No modpacks installed yet.')]));
    }).catch(() => installedBox.replaceChildren(h('div', { class: 'hint', style: { padding: '10px 12px' } }, 'Could not read your instances.')));
  });
}

/** After an install: one toast for the result, and a list of everything that could not be installed. */
function templateResultReport(r, instName) {
  const n = r.installed?.length || 0;
  const probs = r.problems || [];
  toast(`${n} item${n === 1 ? '' : 's'} added to ${instName}${probs.length ? `, ${probs.length} could not be installed` : ''}`, probs.length ? 'warn' : 'good', 7000);
  if (r.blockedSession) return; // the manual-download window is about to open; the list stays in Activity
  if (probs.length) {
    modal({
      title: `${probs.length} item${probs.length === 1 ? '' : 's'} could not be installed`,
      body: [h('p', { style: { margin: 0, lineHeight: 1.5 } }, 'Everything else was installed. The list is also in Activity.'),
        h('div', { class: 'list' }, probs.map((p) => h('div', { class: 'item', style: { gridTemplateColumns: '1fr' } },
          h('div', { style: { minWidth: 0 } }, h('div', { class: 'i-title ellipsis' }, p.title), h('div', { class: 'i-file', style: { whiteSpace: 'normal' } }, p.why)))))],
      actions: [{ label: 'OK', class: 'primary' }],
    });
  }
}
