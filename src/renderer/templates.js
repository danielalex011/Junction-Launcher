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
 * The review before anything is installed: will add / needed by other mods / not available / skipped.
 * `plan` comes from template:plan. onConfirm(chosen) runs only when the user presses the button.
 */
function templateReviewDialog(plan, onConfirm) {
  const adds = plan.items.filter((i) => i.status === 'add' && !i.dependency).map((i) => ({ ...i, on: true }));
  const deps = plan.items.filter((i) => i.status === 'add' && i.dependency).map((i) => ({ ...i, on: true }));
  const missing = plan.items.filter((i) => i.status === 'unavailable').map((i) => ({ ...i, on: false }));
  const skipped = plan.items.filter((i) => i.status === 'skipped');
  const loaderName = LOADER[plan.loader.type] || 'Vanilla';
  let btn;
  const chosenNow = () => [...adds, ...deps, ...missing.filter((m) => m.forceable)].filter((a) => a.on);
  const sync = () => {
    const n = chosenNow().length;
    if (btn) { btn.disabled = n === 0 && !(plan.copies || []).length; btn.replaceChildren(icon('plus'), n ? `Create and install ${n}` : 'Create instance'); }
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
  const m = modal({
    title: `Review “${plan.template.name}”`,
    body: [
      h('p', { style: { margin: 0, lineHeight: 1.5, color: 'var(--muted)' } }, `For Minecraft ${plan.mcVersion} with ${loaderName}. Nothing is created or installed until you press the button. Junction picks the newest version of each project, preferring full releases.`),
      (plan.copies || []).length ? h('div', { class: 'notice' }, icon('info'), `Also copies: ${plan.copies.join(', ')}`) : null,
      group(`Will add (${adds.length})`, null, adds.map((a) => row(a, badges(a), tick(a, `Install ${a.title}`)))),
      group(`Will add, needed by other mods (${deps.length})`, 'The template does not have these, but the mods above need them to run.', deps.map((a) => row(a, badges(a), tick(a, `Install ${a.title}`), `Needed by ${a.neededBy.join(', ')}`))),
      group(`Not available for this version or loader (${missing.length})`, 'These are left out. If a mod only misses a dependency its author may have listed by mistake, you can tick “Install anyway”.',
        missing.map((i) => row(i, i.forceable ? h('label', { class: 'check small' }, tick(i, `Install ${i.title} anyway`), 'Install anyway') : null))),
      group(`Skipped (${skipped.length})`, null, skipped.map((i) => row(i))),
      !adds.length ? h('div', { class: 'notice warn' }, icon('alert'), 'None of the template\'s projects have a version for this Minecraft version and loader. Try another version.') : null,
    ],
    actions: [
      { label: 'Back', class: 'ghost' },
      { label: 'Create and install', class: 'primary', icon: 'plus', onClick: async () => { await onConfirm(chosenNow(), plan); } },
    ],
  });
  m.el.style.width = 'min(820px, 100%)';
  btn = m.el.querySelectorAll('.m-foot .btn')[1];
  sync();
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
