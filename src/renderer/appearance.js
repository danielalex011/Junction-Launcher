'use strict';
// Appearance: applies the saved look to the page (live, no restart) and builds Settings → Appearance. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

const ACCENT_PRESETS = [
  { name: 'Periwinkle', hex: '#8ea2ff' }, { name: 'Sky', hex: '#5cc8ff' }, { name: 'Mint', hex: '#3ccf8e' }, { name: 'Lime', hex: '#a3e635' },
  { name: 'Amber', hex: '#f2b84b' }, { name: 'Orange', hex: '#ff8a4c' }, { name: 'Rose', hex: '#ff6b8b' }, { name: 'Violet', hex: '#c084fc' },
];
const appearanceLive = { zoom: null };

/** Puts the saved look on the page. Cheap to call again after every change. */
function applyAppearance(a = state.settings?.appearance) {
  if (!a) return;
  const root = document.documentElement.style;
  const v = JunctionColor.accentVars(a.accent);
  root.setProperty('--accent', v.accent);
  root.setProperty('--accent-2', v.accent);
  root.setProperty('--accent-hover', v.hover);
  root.setProperty('--accent-ink', v.ink);
  const cl = document.body.classList;
  cl.toggle('square', a.rounded === false);
  cl.toggle('sb-right', a.sidebar === 'right');
  cl.toggle('sb-compact', Boolean(a.compact));
  const layer = $('#bg-layer');
  const has = Boolean(a.backgroundFile);
  cl.toggle('has-bg', has);
  if (layer) {
    layer.style.backgroundImage = has ? `url("junction-bg://bg/?v=${a.backgroundVersion || 0}")` : '';
    layer.style.filter = a.bgBlur ? `blur(${a.bgBlur}px)` : '';
    layer.style.setProperty('--bg-dim', String((a.bgDim ?? 55) / 100));
  }
  if (appearanceLive.zoom !== a.scale) { appearanceLive.zoom = a.scale; call('appearance:zoom', a.scale).catch(() => {}); }
}

let appearanceSaveTimer = null;
/** Applies a change at once and saves it a moment later (so dragging a slider saves once, at the end). */
function changeAppearance(patch) {
  const s = state.settings || (state.settings = {});
  s.appearance = { ...s.appearance, ...patch };
  applyAppearance(s.appearance);
  clearTimeout(appearanceSaveTimer);
  settingsUi.note('saving');
  appearanceSaveTimer = setTimeout(() => call('settings:set', { appearance: s.appearance }).then(() => settingsUi.note('saved')).catch((e) => { settingsUi.note('error', e.message); toast(e.message, 'error'); }), 200); // the whole object, so quick changes in a row can't lose each other
}

function appearanceSection() {
  const a0 = state.settings.appearance;
  const rangeRow = (label, key, min, max, step, fmt, disabled) => {
    const out = h('span', { class: 'ap-val' }, fmt(a0[key]));
    const input = h('input', { type: 'range', min, max, step, value: a0[key], disabled, 'aria-label': label,
      oninput: (e) => { out.textContent = fmt(Number(e.target.value)); changeAppearance({ [key]: Number(e.target.value) }); } });
    return h('label', { class: 'ap-range' }, h('span', null, label), input, out);
  };

  // accent
  const note = h('div', { class: 'hint ap-note' });
  const swatches = h('div', { class: 'ap-swatches', role: 'group', 'aria-label': 'Accent colour' });
  const custom = h('input', { type: 'color', class: 'ap-custom', 'aria-label': 'Custom accent colour', value: a0.accent });
  const showAccent = () => {
    const cur = state.settings.appearance.accent;
    const v = JunctionColor.accentVars(cur);
    for (const b of swatches.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.hex === cur));
    custom.value = cur;
    custom.classList.toggle('on', !ACCENT_PRESETS.some((p) => p.hex === cur));
    note.textContent = `Text on accent buttons is ${v.ink === JunctionColor.INK_DARK ? 'dark' : 'white'} (contrast ${v.ratio.toFixed(1)}:1).${v.lightened ? ' That colour was a bit dark for this interface, so it is lightened to stay readable.' : ''}`;
  };
  for (const p of ACCENT_PRESETS) swatches.append(h('button', { class: 'ap-sw', type: 'button', title: p.name, 'aria-label': p.name, 'data-hex': p.hex, style: { background: p.hex }, onclick: () => { changeAppearance({ accent: p.hex }); showAccent(); } }));
  custom.addEventListener('input', () => { changeAppearance({ accent: custom.value }); showAccent(); });
  swatches.append(custom);

  // background
  const thumb = h('div', { class: 'ap-thumb' });
  const sliders = h('div', { class: 'ap-sliders' });
  const bgBtns = h('div', { class: 'row wrap' });
  const showBg = () => {
    const a = state.settings.appearance;
    thumb.style.backgroundImage = a.backgroundFile ? `url("junction-bg://bg/?v=${a.backgroundVersion || 0}")` : '';
    thumb.textContent = a.backgroundFile ? '' : 'None';
    bgBtns.replaceChildren(
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        try { const r = await call('appearance:pickBackground'); if (r) { state.settings = r; applyAppearance(); showBg(); } } catch (e) { toast(e.message, 'error'); }
      } }, icon('upload', 15), a.backgroundFile ? 'Change picture…' : 'Choose a picture…'),
      a.backgroundFile ? h('button', { class: 'btn ghost', type: 'button', onclick: async () => { state.settings = await call('appearance:clearBackground'); applyAppearance(); showBg(); } }, 'Remove') : null);
    sliders.replaceChildren(rangeRow('Dim', 'bgDim', 0, 90, 1, (n) => `${n}%`, !a.backgroundFile), rangeRow('Blur', 'bgBlur', 0, 24, 1, (n) => `${n} px`, !a.backgroundFile));
  };

  const sidebarSel = select([{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }], a0.sidebar, (v) => changeAppearance({ sidebar: v }));
  const rounded = h('input', { type: 'checkbox', checked: a0.rounded !== false, onchange: (e) => changeAppearance({ rounded: e.target.checked }) });
  const compact = h('input', { type: 'checkbox', checked: Boolean(a0.compact), onchange: (e) => changeAppearance({ compact: e.target.checked }) });
  const section = h('div', { class: 'section', id: 'appearance' },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Appearance'),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => {
        clearTimeout(appearanceSaveTimer);
        state.settings = await call('appearance:reset'); applyAppearance(); go('settings', { section: 'appearance' }); toast('Appearance reset to defaults', 'good');
      } }, icon('refresh', 14), 'Reset to defaults')),
    h('p', null, 'Changes show right away and are saved automatically.'),
    h('div', { class: 'ap-block' }, h('div', { class: 'ap-label' }, 'Accent colour'), swatches, note),
    h('div', { class: 'ap-block' }, h('div', { class: 'ap-label' }, 'Background picture'),
      h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '14px' } }, thumb, h('div', { class: 'grow ap-bg-col' }, bgBtns, sliders)),
      h('div', { class: 'hint' }, 'The picture is copied into Junction\'s data folder. Raise Dim or Blur if text gets hard to read.')),
    h('div', { class: 'form-grid ap-grid' },
      h('label', { class: 'field' }, 'Sidebar', sidebarSel),
      rangeRow('Interface size', 'scale', 90, 125, 5, (n) => `${n}%`, false)),
    h('div', { class: 'row wrap', style: { gap: '22px', marginTop: '12px' } },
      h('label', { class: 'check' }, rounded, 'Rounded corners'),
      h('label', { class: 'check' }, compact, 'Compact sidebar (icons only)')));
  showAccent();
  showBg();
  return section;
}
