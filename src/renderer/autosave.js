'use strict';
// Auto-save for Settings: changes are collected for a moment and sent in one go, and the "Saved" note follows along.
// Also the number-field check used while typing. Plain script that also loads in Node, so the tests can use it.
// Shares one global scope with the other src/renderer files.

const JunctionAutosave = (function autosaveModule() {
  /**
   * @param {{ save: (patch: object) => Promise<any>, delay?: number, onState?: (state: 'saving'|'saved'|'error', message?: string) => void,
   *           timers?: { setTimeout: Function, clearTimeout: Function } }} opts
   */
  function createAutosaver({ save, delay = 450, onState = () => {}, timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) } }) { // wrapped: the browser's own functions must not be called as methods of this object
    let patch = null;
    let timer = null;
    let chain = Promise.resolve();

    function run() {
      timer = null;
      const p = patch;
      patch = null;
      if (!p) return chain;
      onState('saving');
      chain = chain
        .then(() => save(p))
        .then(() => { if (!patch) onState('saved'); })
        .catch((e) => { onState('error', e?.message || String(e)); });
      return chain;
    }

    return {
      /** Adds a change. Several quick changes become one save; later values win. */
      queue(change) {
        patch = { ...(patch || {}), ...change };
        if (timer !== null) timers.clearTimeout(timer);
        timer = timers.setTimeout(run, delay);
      },
      /** Saves now what is waiting. Resolves when everything is on disk. */
      flush() {
        if (timer !== null) { timers.clearTimeout(timer); return run(); }
        return chain;
      },
      pending: () => timer !== null || patch !== null,
    };
  }

  /**
   * Checks a number typed into a field.
   * @returns {{ok: true, value: number|null} | {ok: false, error: string}}  `value` is null for an empty optional field
   */
  function checkNumber(text, { min = -Infinity, max = Infinity, integer = false, optional = false, unit = '' } = {}) {
    const raw = String(text ?? '').trim().replace(',', '.');
    if (!raw) return optional ? { ok: true, value: null } : { ok: false, error: 'Type a number.' };
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return { ok: false, error: 'Use a number.' };
    const n = Number(raw);
    if (integer && !Number.isInteger(n)) return { ok: false, error: 'Use a whole number.' };
    const u = unit ? ` ${unit}` : '';
    if (n < min) return { ok: false, error: `At least ${min}${u}.` };
    if (n > max) return { ok: false, error: `At most ${max}${u}.` };
    return { ok: true, value: n };
  }

  return { createAutosaver, checkNumber };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = JunctionAutosave;
