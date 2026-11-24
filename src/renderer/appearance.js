'use strict';
// Appearance: applies the saved look to the page (live, no restart) and builds Settings → Appearance. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

const ACCENT_PRESETS = [
  { name: 'Periwinkle', hex: '#8ea2ff' }, { name: 'Sky', hex: '#5cc8ff' }, { name: 'Mint', hex: '#3ccf8e' }, { name: 'Lime', hex: '#a3e635' },
  { name: 'Amber', hex: '#f2b84b' }, { name: 'Orange', hex: '#ff8a4c' }, { name: 'Rose', hex: '#ff6b8b' }, { name: 'Violet', hex: '#c084fc' },
];
const appearanceLive = { zoom: null, showSize: null };
const UI_SIZES = [90, 100, 110, 125];

/** Ctrl+= / Ctrl+- / Ctrl+0: next size up or down, or back to 100%. */
function stepInterfaceSize(dir) {
  const cur = state.settings?.appearance?.scale || 100;
  const next = dir === 0 ? 100 : dir > 0 ? UI_SIZES.find((n) => n > cur) : [...UI_SIZES].reverse().find((n) => n < cur);
  if (!next) { toast(`Interface size ${cur}%`, 'info', 1500); return; }
  changeAppearance({ scale: next });
  if (appearanceLive.showSize && document.body.contains($('.ap-sizes'))) appearanceLive.showSize();
  toast(`Interface size ${next}%`, 'info', 1500);
}

const appearanceMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
let appearanceWindowKey = '';

/** True when animations should be minimal: the person asked for it, or (by default) the operating system did. */
function motionReduced(a = state.settings?.appearance) {
  const m = a?.reduceMotion || 'system';
  return m === 'on' || (m === 'system' && Boolean(appearanceMotionQuery?.matches));
}

/** Puts the saved look on the page. Cheap to call again after every change. */
function applyAppearance(a = state.settings?.appearance) {
  if (!a) return;
  const rootEl = document.documentElement;
  for (const [name, value] of Object.entries(JunctionThemes.cssVars(a))) rootEl.style.setProperty(name, value);
  const cl = document.body.classList;
  cl.toggle('square', a.rounded === false);
  cl.toggle('sb-right', a.sidebar === 'right');
  cl.toggle('sb-compact', Boolean(a.compact));
  cl.toggle('reduce-motion', motionReduced(a));
  const translucent = Boolean(a.translucent && state.info?.canTranslucent);
  cl.toggle('translucent', translucent);
  rootEl.classList.toggle('translucent', translucent);
  const layer = $('#bg-layer');
  const has = Boolean(a.backgroundFile);
  cl.toggle('has-bg', has);
  if (layer) {
    layer.style.backgroundImage = has ? `url("junction-bg://bg/?v=${a.backgroundVersion || 0}")` : '';
    layer.style.filter = a.bgBlur ? `blur(${a.bgBlur}px)` : '';
    layer.style.setProperty('--bg-dim', String((a.bgDim ?? 55) / 100));
  }
  const { colors, light } = JunctionThemes.resolve(a);
  const key = `${translucent}|${light}|${colors.bg}`;
  if (key !== appearanceWindowKey) { appearanceWindowKey = key; call('appearance:window', { translucent, light, bg: colors.bg }).catch(() => {}); } // window material and background colour live in the main process
  if (appearanceLive.zoom !== a.scale) { appearanceLive.zoom = a.scale; call('appearance:zoom', a.scale).catch(() => {}); }
}
if (appearanceMotionQuery) appearanceMotionQuery.addEventListener('change', () => applyAppearance());

/** Colours for the sandboxed description frames, so they match the theme (they can't see the page's variables). */
function frameTheme() { return JunctionThemes.frameColors(state.settings?.appearance); }

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

/** The one-time "Make Junction yours" card on Home: four themes that apply on click, and a way to dismiss it for good. */
const HOME_CARD_THEMES = ['midnight', 'light', 'ocean', 'cherry'];
function themeCard() {
  const card = h('section', { class: 'yours', 'aria-label': 'Make Junction yours' });
  const draw = () => {
    const a = state.settings.appearance;
    card.replaceChildren(
      h('button', { class: 'btn ghost sm yours-x', type: 'button', title: 'Dismiss. This card will not come back.', 'aria-label': 'Dismiss', onclick: () => { changeAppearance({ themeCardDismissed: true }); card.remove(); } }, icon('x', 14)),
      h('h2', null, 'Make Junction yours'),
      h('p', null, 'Pick a look. You can change it any time in Appearance.'),
      h('div', { class: 'ap-themes' }, ...HOME_CARD_THEMES.map((id) => { const p = JunctionThemes.presetById(id); return themeTile(p, a.theme === id, a.accent, () => { changeAppearance({ theme: id }); draw(); }); })),
      h('div', { class: 'yours-foot' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => go('settings', { tab: 'appearance' }) }, icon('brush', 14), 'More themes, colours and fonts')));
  };
  draw();
  return card;
}

/** One theme as a clickable preview: a small mock window painted in that theme's own colours. */
function themeTile(t, on, accent, onPick) {
  const c = t.colors;
  const light = JunctionColor.luminance(c.bg) > 0.35;
  const acc = JunctionThemes.accentFor(accent, c, light).accent;
  const mock = h('div', { class: 'th-mock', style: { '--mk-bg': c.bg, '--mk-sidebar': c.sidebar, '--mk-panel': c.panel, '--mk-border': c.border, '--mk-text': c.text, '--mk-muted': c.muted, '--mk-faint': c.faint, '--mk-accent': acc } },
    h('div', { class: 'mk-side' }, h('i'), h('i'), h('i')),
    h('div', { class: 'mk-main' }, h('div', { class: 'mk-card' }, h('b'), h('u'), h('s'))));
  return h('button', { class: 'th-tile', type: 'button', 'aria-pressed': String(on), 'aria-label': `${t.name} theme`, onclick: onPick },
    mock, h('div', { class: 'th-name' }, t.name, on ? icon('check', 13) : null), h('div', { class: 'th-hint' }, t.hint));
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
    const { colors, light } = JunctionThemes.resolve(state.settings.appearance);
    const v = JunctionThemes.accentFor(cur, colors, light);
    for (const b of swatches.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.hex === cur));
    custom.value = cur;
    custom.classList.toggle('on', !ACCENT_PRESETS.some((p) => p.hex === cur));
    note.textContent = `Text on accent buttons is ${v.ink === JunctionColor.INK_DARK ? 'dark' : 'white'} (contrast ${v.ratio.toFixed(1)}:1).${v.adjusted ? ' That colour was a bit too close to the panel colours of this theme, so it is adjusted to stay readable.' : ''}`;
  };
  for (const p of ACCENT_PRESETS) swatches.append(h('button', { class: 'ap-sw', type: 'button', title: p.name, 'aria-label': p.name, 'data-hex': p.hex, style: { background: p.hex }, onclick: () => { changeAppearance({ accent: p.hex }); showAccent(); showThemes(); } }));
  custom.addEventListener('input', () => { changeAppearance({ accent: custom.value }); showAccent(); showThemes(); });
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


  // theme tiles + customise + theme files
  const TH = JunctionThemes;
  const tiles = h('div', { class: 'ap-themes', role: 'group', 'aria-label': 'Theme' });
  const editor = h('div', { class: 'th-editor', hidden: true });
  const editWarn = h('div', { class: 'notice warn th-warn', hidden: true });
  const themeNote = h('div', { class: 'hint ap-note' });
  const showThemes = () => {
    const cur = state.settings.appearance;
    const list = TH.PRESETS.map((p) => ({ id: p.id, name: p.name, hint: p.hint, colors: p.colors }));
    if (cur.customColors) list.push({ id: 'custom', name: 'Custom', hint: 'Your own colours', colors: TH.normalizeColors(cur.customColors, cur.customBase) });
    tiles.replaceChildren(...list.map((t) => themeTile(t, cur.theme === t.id, cur.accent, () => { changeAppearance({ theme: t.id }); showThemes(); showAccent(); showEditor(); })));
    const base = TH.presetById(cur.customBase).name;
    themeNote.textContent = cur.theme === 'custom' ? `You are using your Custom theme (started from ${base}).` : `${TH.presetById(cur.theme).name}: ${TH.presetById(cur.theme).hint.toLowerCase()}. Customise copies it into your own Custom theme.`;
  };
  const showEditor = () => {
    const cur = state.settings.appearance;
    editor.hidden = cur.theme !== 'custom' || !editor.dataset.open;
    if (editor.hidden) return;
    const colors = TH.normalizeColors(cur.customColors, cur.customBase);
    editor.replaceChildren(
      h('div', { class: 'ap-label' }, 'Customise colours'),
      h('div', { class: 'hint' }, 'Changes show right away across the whole app and are saved as your Custom theme.'),
      h('div', { class: 'th-colors', style: { marginTop: '10px' } }, ...TH.COLOR_KEYS.map(([k, label]) => {
        const code = h('code', null, colors[k]);
        const input = h('input', { type: 'color', value: colors[k], 'aria-label': label });
        input.addEventListener('input', () => {
          const next = { ...TH.normalizeColors(state.settings.appearance.customColors, state.settings.appearance.customBase), [k]: input.value };
          code.textContent = input.value;
          changeAppearance({ customColors: next, theme: 'custom' });
          showWarn(next);
          showThemes();
          showAccent();
        });
        return h('label', { class: 'th-color' }, input, h('span', null, label), code);
      })),
      editWarn,
      h('div', { class: 'th-actions' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => { changeAppearance({ customColors: { ...TH.presetById(cur.customBase).colors }, theme: 'custom' }); showThemes(); showEditor(); showAccent(); } }, icon('refresh', 14), `Reset to ${TH.presetById(cur.customBase).name}`),
        h('button', { class: 'btn primary sm', type: 'button', onclick: () => { delete editor.dataset.open; showEditor(); } }, 'Done')));
    showWarn(colors);
  };
  const showWarn = (colors) => {
    const w = TH.contrastWarnings(colors);
    editWarn.hidden = !w.length;
    editWarn.replaceChildren(icon('alert'), h('div', null, ...w.map((t) => h('div', null, t))));
  };
  const customise = async () => {
    const cur = state.settings.appearance;
    if (cur.theme !== 'custom') {
      const existing = cur.customColors && JSON.stringify(TH.normalizeColors(cur.customColors, cur.customBase)) !== JSON.stringify(TH.resolve(cur).colors);
      if (existing && !(await confirmDialog('Replace your Custom theme?', `Customising ${TH.presetById(cur.theme).name} starts a new Custom theme from it and replaces the one you made before.`, 'Replace'))) return;
      changeAppearance({ theme: 'custom', customColors: { ...TH.resolve(cur).colors }, customBase: cur.theme });
    }
    editor.dataset.open = '1';
    showThemes(); showEditor(); showAccent();
    editor.scrollIntoView({ block: 'nearest', behavior: motionReduced() ? 'auto' : 'smooth' });
  };
  const exportTheme = async () => {
    try { const r = await call('appearance:exportTheme', state.settings.appearance); if (r) toast('Theme saved', 'good'); } catch (e) { toast(e.message, 'error'); }
  };
  const importTheme = async () => {
    try {
      const patch = await call('appearance:importTheme');
      if (!patch) return;
      changeAppearance(patch);
      toast('Theme imported', 'good');
      go('settings', { tab: 'appearance' });
    } catch (e) { toast(e.message, 'error'); }
  };
  const fontSel = select([{ value: 'default', label: 'Default' }, { value: 'system', label: 'System font' }, { value: 'pixel', label: 'Pixel headings' }], a0.font, (v) => changeAppearance({ font: v }));
  const motionSel = select([{ value: 'system', label: 'Follow my system' }, { value: 'on', label: 'Reduce motion' }, { value: 'off', label: 'Keep animations' }], a0.reduceMotion, (v) => changeAppearance({ reduceMotion: v }));
  const translucent = h('input', { type: 'checkbox', checked: Boolean(a0.translucent), onchange: (e) => changeAppearance({ translucent: e.target.checked }) });

  const sizeBtns = h('div', { class: 'ap-sizes', role: 'group', 'aria-label': 'Interface size' });
  const showSize = () => {
    const cur = state.settings.appearance.scale;
    for (const b of sizeBtns.querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.pct) === cur));
  };
  for (const pct of UI_SIZES) sizeBtns.append(h('button', { class: 'btn sm', type: 'button', 'data-pct': String(pct), onclick: () => { changeAppearance({ scale: pct }); showSize(); } }, `${pct}%`));
  appearanceLive.showSize = showSize;
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
    h('div', { class: 'ap-block' }, h('div', { class: 'ap-label' }, 'Theme'), tiles, themeNote,
      h('div', { class: 'th-actions' },
        h('button', { class: 'btn sm', type: 'button', onclick: customise }, icon('sliders', 14), 'Customise…'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: exportTheme }, icon('upload', 14), 'Export theme…'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: importTheme }, icon('login', 14), 'Import theme…')),
      editor),
    h('div', { class: 'ap-block' }, h('div', { class: 'ap-label' }, 'Accent colour'), swatches, note,
      h('div', { class: 'hint' }, 'The accent works on top of any theme.')),
    h('div', { class: 'ap-block' }, h('div', { class: 'ap-label' }, 'Background picture'),
      h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '14px' } }, thumb, h('div', { class: 'grow ap-bg-col' }, bgBtns, sliders)),
      h('div', { class: 'hint' }, 'The picture is copied into Junction\'s data folder. Raise Dim or Blur if text gets hard to read.')),
    h('div', { class: 'form-grid ap-grid' },
      h('label', { class: 'field' }, 'Sidebar', sidebarSel),
      h('div', { class: 'field' }, 'Interface size', sizeBtns),
      h('label', { class: 'field' }, 'Font', fontSel),
      h('label', { class: 'field' }, 'Animations', motionSel)),
    h('div', { class: 'row wrap', style: { gap: '22px', marginTop: '12px' } },
      h('label', { class: 'check' }, rounded, 'Rounded corners'),
      h('label', { class: 'check' }, compact, 'Compact sidebar (icons only)'),
      state.info?.canTranslucent ? h('label', { class: 'check', title: 'Lets the Windows 11 window material show through the panels. Panels stay mostly solid so text stays readable.' }, translucent, 'Translucent window') : null));
  showThemes();
  showAccent();
  showBg();
  showSize();
  return section;
}
