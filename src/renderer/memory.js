'use strict';
// Memory maths for Settings → Memory and the instance settings tab: the coloured zones, the quick presets,
// number-field checks and the "big pack" hint. Plain script that also loads in Node, so the tests can use it.
// Shares one global scope with the other src/renderer files.

const JunctionMemory = (function memoryModule() {
  const LOW_MB = 2048; // under this is too little for almost anything
  const WINDOWS_MB = 4096; // Windows and other programs want about this much left over
  const STEP_MB = 512; // slider step: 0.5 GB
  const MIN_MB = 512;
  const BIG_PACK_MODS = 300;
  const BIG_PACK_FROM_MB = 6144; // a pack this big wants at least 6 GB ...
  const BIG_PACK_RANGE = '6–8 GB'; // ... and 6–8 GB is what we suggest
  const PRESETS = [
    { id: 'vanilla', label: 'Vanilla', mb: 3072 },
    { id: 'modded', label: 'Modded', mb: 6144 },
    { id: 'bigpack', label: 'Big modpack', mb: 8192 },
  ];

  const gbText = (mb) => {
    const gb = Math.round((mb / 1024) * 100) / 100;
    return `${Number.isInteger(gb) ? gb : String(gb)} GB`;
  };

  /** "32 GB" for a PC that reports 31.2 GB: Windows hides some RAM, but people know the number on the box. */
  const pcText = (totalMB) => `${Math.max(1, Math.ceil(totalMB / 1024 - 0.05))} GB`;

  /** The largest value the slider offers: the PC's RAM in 0.5 GB steps. */
  function maxMB(totalMB) {
    const t = Number(totalMB) || 0;
    return Math.max(MIN_MB, Math.floor(t / STEP_MB) * STEP_MB);
  }

  /** Where the colours change. `highStart` is the first value that leaves less than 4 GB for Windows. */
  function zones(totalMB) {
    const max = maxMB(totalMB);
    const lowEnd = LOW_MB;
    const highStart = Math.max(lowEnd, (Number(totalMB) || 0) - WINDOWS_MB);
    return { min: MIN_MB, max, lowEnd, highStart };
  }

  /** 'low' (under 2 GB), 'high' (leaves under 4 GB for Windows) or 'good'. Too low wins on a very small PC. */
  function zoneOf(valueMB, totalMB) {
    const v = Number(valueMB);
    if (v < LOW_MB) return 'low';
    if (totalMB > 0 && totalMB - v < WINDOWS_MB) return 'high';
    return 'good';
  }

  /** The text under the slider. */
  function zoneMessage(valueMB, totalMB) {
    const z = zoneOf(valueMB, totalMB);
    if (z === 'low') return { zone: z, text: 'Too low: under 2 GB, the game may run out of memory or crash.' };
    if (z === 'high') return { zone: z, text: `Leaves too little for Windows: less than 4 GB stays free (${gbText(Math.max(0, totalMB - valueMB))}). The whole PC may stutter.` };
    return { zone: z, text: 'Good.' };
  }

  /** CSS stops for the slider track, as percentages of its width. */
  function trackStops(totalMB) {
    const { min, max, lowEnd, highStart } = zones(totalMB);
    const pct = (v) => Math.round(Math.max(0, Math.min(1, (v - min) / (max - min))) * 1000) / 10;
    return { low: pct(lowEnd), high: pct(highStart) };
  }

  /**
   * Checks what was typed into a GB field (a comma is fine as the decimal mark).
   * @returns {{ok: true, mb: number} | {ok: false, error: string}}
   */
  function checkGB(text, { totalMB = 0, minMB = MIN_MB } = {}) {
    const raw = String(text ?? '').trim().replace(',', '.');
    if (!raw) return { ok: false, error: 'Type an amount in GB.' };
    if (!/^\d+(\.\d+)?$/.test(raw)) return { ok: false, error: 'Use a number, like 6 or 6.5.' };
    const mb = Math.round(Number(raw) * 1024);
    if (mb < minMB) return { ok: false, error: `At least ${gbText(minMB)}.` };
    if (totalMB > 0 && mb > totalMB) return { ok: false, error: `Your PC only has ${gbText(totalMB)}.` };
    return { ok: true, mb };
  }

  /** "Prominence II has 460 mods; 6–8 GB is recommended", or null when there is nothing to say. */
  function bigPackHint({ name, mods, memoryMB }) {
    if (!(Number(mods) >= BIG_PACK_MODS)) return null;
    if (!(Number(memoryMB) < BIG_PACK_FROM_MB)) return null;
    return `${name || 'This instance'} has ${mods} mods; ${BIG_PACK_RANGE} is recommended`;
  }

  return { LOW_MB, WINDOWS_MB, STEP_MB, MIN_MB, BIG_PACK_MODS, BIG_PACK_FROM_MB, PRESETS, gbText, pcText, maxMB, zones, zoneOf, zoneMessage, trackStops, checkGB, bigPackHint };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = JunctionMemory;
