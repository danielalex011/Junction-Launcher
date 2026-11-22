'use strict';
// The memory control used by Settings → Memory and the instance settings tab: a coloured slider in 0.5 GB steps,
// a GB field, quick presets, the "too low / leaves too little for Windows" note and the big-pack hint.
// The maths is in memory.js. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

/**
 * @param {{ totalMB: number, valueMB: number|null, defaultMB?: number, nullable?: boolean, name?: string, mods?: number|null,
 *           onChange?: (mb: number|null) => void }} o
 *   nullable: the instance form, where "no value" means "use the default from Settings" (defaultMB)
 * @returns {HTMLElement & { getValue(): number|null, isValid(): boolean, setMods(n: number|null): void, setDefault(mb: number): void }}
 */
function memoryControl(o) {
  const M = JunctionMemory;
  const total = Number(o.totalMB) || 0;
  const maxMB = total ? M.maxMB(total) : 64 * 1024;
  let value = o.valueMB ?? null;
  let defaultMB = o.defaultMB ?? 4096;
  let mods = o.mods ?? null;
  const effective = () => (value ?? defaultMB);
  const gbValue = (mb) => String(Math.round((mb / 1024) * 100) / 100);

  const slider = h('input', { type: 'range', class: 'mem-slider', min: M.MIN_MB / 1024, max: maxMB / 1024, step: M.STEP_MB / 1024, 'aria-label': 'Maximum memory in GB' });
  const gb = h('input', { type: 'number', class: 'mem-gb', min: M.MIN_MB / 1024, max: maxMB / 1024, step: M.STEP_MB / 1024, 'aria-label': 'Maximum memory in GB' });
  const err = h('div', { class: 'field-error', role: 'alert' });
  const zone = h('div', { class: 'mem-zone', 'aria-live': 'polite' });
  const hint = h('div', { class: 'mem-hint' });
  const useDefault = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { value = null; sync(true); emit(); } }, icon('undo', 13), 'Use default');
  const presetBtns = M.PRESETS.map((p) => h('button', { class: 'btn sm mem-preset', type: 'button', disabled: p.mb > maxMB, onclick: () => { value = p.mb; sync(true); emit(); } }, `${p.label} `, h('span', { class: 'mem-preset-gb' }, M.gbText(p.mb))));

  const stops = M.trackStops(total || maxMB);
  slider.style.background = `linear-gradient(to right, var(--warn) 0 ${stops.low}%, var(--good) ${stops.low}% ${stops.high}%, var(--bad) ${stops.high}% 100%)`;

  function emit() { o.onChange?.(value); }

  /** Redraws everything that follows from the value. `fields` also rewrites the slider and the GB box (not while typing in it). */
  function sync(fields) {
    const mb = effective();
    if (fields) {
      slider.value = String(Math.min(maxMB, Math.max(M.MIN_MB, mb)) / 1024);
      gb.value = gbValue(mb);
      err.textContent = '';
      gb.removeAttribute('aria-invalid');
    }
    const z = M.zoneMessage(mb, total);
    zone.className = `mem-zone ${z.zone}`;
    zone.replaceChildren(value === null ? h('span', { class: 'mem-default' }, `Using the default (${M.gbText(defaultMB)}). `) : null, z.text);
    const text = M.bigPackHint({ name: o.name, mods, memoryMB: mb });
    hint.textContent = text || '';
    hint.style.display = text ? '' : 'none';
    useDefault.style.display = o.nullable && value !== null ? '' : 'none';
    presetBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(mb === M.PRESETS[i].mb && (!o.nullable || value !== null))));
  }

  slider.addEventListener('input', () => { value = Math.round(Number(slider.value) * 1024); gb.value = gbValue(value); sync(false); err.textContent = ''; gb.removeAttribute('aria-invalid'); emit(); });
  gb.addEventListener('input', () => {
    const r = gb.validity.badInput ? { ok: false, error: 'Use a number, like 6 or 6.5.' } : M.checkGB(gb.value, { totalMB: total });
    err.textContent = r.ok ? '' : r.error;
    if (r.ok) gb.removeAttribute('aria-invalid'); else gb.setAttribute('aria-invalid', 'true');
    if (!r.ok) return; // nothing is saved while the field is wrong
    value = r.mb;
    slider.value = String(Math.min(maxMB, Math.max(M.MIN_MB, value)) / 1024);
    sync(false);
    emit();
  });

  const el = h('div', { class: 'mem' },
    total ? h('div', { class: 'mem-total' }, `Your PC has ${M.pcText(total)}`) : null,
    h('div', { class: 'mem-row' }, slider, h('label', { class: 'mem-gb-wrap' }, gb, h('span', null, 'GB'))),
    h('div', { class: 'mem-scale' }, h('span', null, M.gbText(M.MIN_MB)), h('span', null, M.gbText(maxMB))),
    err, zone, hint,
    h('div', { class: 'row wrap mem-presets' }, h('span', { class: 'hint' }, 'Quick presets:'), presetBtns, o.nullable ? useDefault : null));
  sync(true);
  el.getValue = () => value;
  el.isValid = () => !err.textContent;
  el.setMods = (n) => { mods = n; sync(false); };
  el.setDefault = (mb) => { defaultMB = mb; sync(value === null); };
  return el;
}
