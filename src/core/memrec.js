'use strict';
// Memory recommendations per instance. Reads the pack author's own limits from files only (never runs anything from the pack),
// falls back to Junction's estimate from the mod count, and keeps the result inside what this PC can spare.
//
// Formats:
//  - Memory Settings mod: config/memorysettings.json (checked against a real Prominence II install): minimumClient / maximumClient
//    (MB, each stored as {"maximumClient": 12512}), howtolink, disableWarnings, recommendedMemory["memory values"] = ["systemMB:recommendedMB", ...].
//  - Modpack Configuration Checker and MemoryTester: their config files and key names could NOT be confirmed from the mods' own pages
//    (MemoryTester says config/MemoryTester with RecommendedMemoryAllocation; Config Checker says nothing). So those two are read
//    leniently: any "key = value" / "key": value line in a matching file, units guessed (a small number is GB, a big one MB).
//  - CurseForge manifest: no recommended-RAM field could be confirmed; `pack.recommendedRamMB` is used when an install stored one.
const fs = require('fs');
const path = require('path');

const GB = 1024;
const STEP = 512;
const MAX_FILE = 256 * 1024; // config files are small; anything bigger is not one

const round = (mb) => Math.round(mb / STEP) * STEP;
const gbText = (mb) => {
  const gb = Math.round((mb / GB) * 100) / 100;
  return `${Number.isInteger(gb) ? gb : String(gb)} GB`;
};
const pcText = (totalMB) => `${Math.max(1, Math.ceil(totalMB / GB - 0.05))} GB`;

async function readText(file) {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return await fs.promises.readFile(file, 'utf8');
  } catch { return null; }
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
/** A bare number from a config: up to 64 means GB, above means MB. */
const guessMB = (n) => (n == null ? null : Math.round(n <= 64 ? n * GB : n));
const unwrap = (v, key) => (v && typeof v === 'object' && !Array.isArray(v) ? v[key] : v);
const httpUrl = (s) => (typeof s === 'string' && /^https?:\/\/[^\s]+$/i.test(s.trim()) ? s.trim() : null);

/** Memory Settings mod: "system:recommended" pairs -> the recommended amount for `totalMB`, interpolated between rows. */
function tableRecommend(table, totalMB) {
  const rows = (Array.isArray(table) ? table : []).map((r) => String(r).split(':').map(Number))
    .filter((p) => p.length === 2 && p.every((x) => Number.isFinite(x) && x > 0)).sort((a, b) => a[0] - b[0]);
  if (!rows.length || !(totalMB > 0)) return null;
  if (totalMB <= rows[0][0]) return rows[0][1];
  const last = rows[rows.length - 1];
  if (totalMB >= last[0]) return last[1];
  const i = rows.findIndex((r) => r[0] >= totalMB);
  const [x0, y0] = rows[i - 1];
  const [x1, y1] = rows[i];
  return Math.round(y0 + ((y1 - y0) * (totalMB - x0)) / (x1 - x0));
}

function parseMemorySettings(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const min = num(unwrap(j.minimumClient, 'minimumClient'));
  const max = num(unwrap(j.maximumClient, 'maximumClient'));
  if (!min && !max) return null;
  const rec = j.recommendedMemory;
  return {
    source: 'memorysettings', via: 'Memory Settings',
    minMB: min ? Math.round(min) : null, maxMB: max ? Math.round(max) : null,
    table: Array.isArray(rec?.['memory values']) ? rec['memory values'].map(String).slice(0, 64) : [],
    guideUrl: httpUrl(unwrap(j.howtolink, 'howtolink')),
    warningsOff: unwrap(j.disableWarnings, 'disableWarnings') === true,
  };
}

/** Finds `key = value` / `"key": value` / `key: value` for a key whose name matches `re`; the first number found. */
function lenientNumber(text, re) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^[\s"'#]*([A-Za-z_][\w.\- ]*?)["']?\s*[:=]\s*"?(\d+(?:\.\d+)?)"?\s*,?\s*$/.exec(line);
    if (m && re.test(m[1])) return Number(m[2]);
  }
  return null;
}

function parseMemoryTester(text) {
  const rec = guessMB(lenientNumber(text, /^recommendedmemoryallocation$/i));
  return rec ? { source: 'memorytester', via: 'MemoryTester', minMB: null, maxMB: null, recommendedMB: rec, table: [], guideUrl: null, warningsOff: false } : null;
}

function parseConfigChecker(text) {
  const req = guessMB(lenientNumber(text, /(required|minimum|min)\w*(ram|mem)|(ram|mem)\w*(required|minimum|min)/i));
  const rec = guessMB(lenientNumber(text, /recommend\w*(ram|mem)|(ram|mem)\w*recommend/i));
  if (!req && !rec) return null;
  return { source: 'configchecker', via: 'Modpack Configuration Checker', minMB: req, maxMB: null, recommendedMB: rec, table: [], guideUrl: null, warningsOff: false };
}

/** What the pack author says about memory, or null. Only reads files in the instance's own config folder. */
async function readPackMemory(gameDir, inst = null) {
  const cfg = path.join(gameDir, 'config');
  const ms = await readText(path.join(cfg, 'memorysettings.json'));
  if (ms) { const r = parseMemorySettings(ms); if (r) return r; }
  let names = [];
  try { names = await fs.promises.readdir(cfg); } catch { /* no config yet */ }
  for (const n of names) {
    if (/^(modpack[-_ ]?)?config(uration)?[-_ ]?checker/i.test(n)) {
      const t = await readText(path.join(cfg, n));
      const r = t && parseConfigChecker(t);
      if (r) return r;
    }
  }
  let testerFiles = [];
  try { testerFiles = await fs.promises.readdir(path.join(cfg, 'MemoryTester')); } catch { /* none */ }
  for (const n of testerFiles) {
    const t = await readText(path.join(cfg, 'MemoryTester', n));
    const r = t && parseMemoryTester(t);
    if (r) return r;
  }
  const ram = num(inst?.pack?.recommendedRamMB);
  if (ram) return { source: 'manifest', via: 'the modpack file', minMB: null, maxMB: null, recommendedMB: Math.round(ram), table: [], guideUrl: null, warningsOff: false };
  return null;
}

/** The most this PC can give: at least 4 GB stays free for Windows, never over 75%, and 5 GB at most on an 8 GB PC. */
function pcCap(totalMB) {
  const t = Number(totalMB) || 0;
  if (!t) return 8 * GB;
  let cap = Math.min(t * 0.75, t - 4 * GB);
  if (t <= 8.5 * GB) cap = Math.min(cap, 5 * GB);
  return Math.max(2 * GB, Math.floor(cap / STEP) * STEP);
}

/** Junction's own estimate from what is installed. */
function estimateMB({ mods = 0, shaders = 0, resourcePacks = 0 }) {
  let mb = mods <= 0 ? 3 * GB : mods <= 50 ? 4 * GB : mods <= 150 ? 6 * GB : mods <= 300 ? 8 * GB : 9 * GB;
  if (shaders > 0 || resourcePacks >= 5) mb += GB;
  return mb;
}

/**
 * @param {{ pack?: object|null, mods?: number, shaders?: number, resourcePacks?: number, totalMB: number, name?: string }} o
 * @returns {{ mb: number, source: 'pack'|'estimate', label: string, reason: string, minMB: number|null, maxMB: number|null,
 *             guideUrl: string|null, warningsOff: boolean, pcShort: boolean, cap: number }}
 */
function recommend({ pack = null, mods = 0, shaders = 0, resourcePacks = 0, totalMB, name = 'This pack' }) {
  const cap = pcCap(totalMB);
  const pc = totalMB ? ` · your PC has ${pcText(totalMB)}` : '';
  const hasRange = pack && (pack.minMB || pack.maxMB || pack.recommendedMB || pack.table?.length);
  if (hasRange) {
    const fromTable = tableRecommend(pack.table, totalMB);
    let want = fromTable || pack.recommendedMB || pack.minMB || pack.maxMB;
    const lo = pack.minMB || 0;
    const hi = pack.maxMB || Infinity;
    want = Math.min(hi, Math.max(lo, want));
    let mb = Math.min(round(want), cap);
    mb = Math.min(mb, hi);
    const pcShort = Boolean(lo && cap < lo);
    if (!pcShort && lo && mb < lo) mb = Math.ceil(lo / STEP) * STEP;
    const bits = [`Recommended ${gbText(mb)}`];
    if (pack.maxMB) bits.push(`${name} allows up to ${gbText(pack.maxMB)}`);
    if (lo) bits.push(`needs at least ${gbText(lo)}`);
    return {
      mb, source: 'pack', label: "From the pack's settings", reason: bits.join(' · ') + pc,
      minMB: pack.minMB || null, maxMB: pack.maxMB || null, guideUrl: pack.guideUrl || null, warningsOff: Boolean(pack.warningsOff), pcShort, cap,
    };
  }
  const base = estimateMB({ mods, shaders, resourcePacks });
  const mb = Math.min(base, cap, 10 * GB);
  const what = mods > 0 ? `${mods} mod${mods === 1 ? '' : 's'}` : 'vanilla';
  return {
    mb, source: 'estimate', label: `Junction's estimate (${what})`, reason: `Recommended ${gbText(mb)} · Junction's estimate from ${what}${pc}`,
    minMB: null, maxMB: null, guideUrl: null, warningsOff: false, pcShort: false, cap,
  };
}

/** 'recommended' (modpacks), 'default' (others) or 'custom'. An instance that already has its own amount stays custom. */
function memoryMode(inst) {
  if (['recommended', 'default', 'custom'].includes(inst?.memoryMode)) return inst.memoryMode;
  if (Number(inst?.memoryMax) > 0) return 'custom';
  return inst?.pack ? 'recommended' : 'default';
}

/** The maximum memory (MB) this instance launches with. */
function effectiveMB(inst, rec, defaultMB) {
  const mode = memoryMode(inst);
  if (mode === 'recommended' && rec) return rec.mb;
  if (mode === 'custom' && Number(inst.memoryMax) > 0) return Number(inst.memoryMax);
  return defaultMB;
}

/**
 * Before launch: is the allocation outside the pack's own range (the one its in-game warning screen uses)?
 * @returns {null | { mb: number, problem: 'high'|'low', limitMB: number, recommendedMB: number }}
 */
function checkAllocation(inst, rec, defaultMB) {
  if (!rec || rec.source !== 'pack' || rec.warningsOff || inst?.memoryWarnOff) return null;
  const mb = effectiveMB(inst, rec, defaultMB);
  if (rec.maxMB && mb > rec.maxMB) return { mb, problem: 'high', limitMB: rec.maxMB, recommendedMB: rec.mb };
  if (rec.minMB && mb < rec.minMB) return { mb, problem: 'low', limitMB: rec.minMB, recommendedMB: rec.mb };
  return null;
}

// ----- JVM argument presets, checked against the instance's Java
const JVM_PRESETS = [
  { id: 'zgc', label: 'Generational ZGC', args: '-XX:+UseZGC -XX:+ZGenerational', minJava: 21, hint: 'Low pause times for big packs.' },
  {
    id: 'g1', label: 'Tuned G1', minJava: 8, hint: 'Well-known G1 flags for modded play.',
    args: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1',
  },
];

/** Each preset with whether it works on this Java (`javaMajor`) and, if not, why. */
function presetsFor(javaMajor) {
  const j = Number(javaMajor) || 0;
  return JVM_PRESETS.map((p) => {
    const ok = !j || j >= p.minJava;
    return { ...p, ok, reason: ok ? null : `Needs Java ${p.minJava} or newer. This instance uses Java ${j}.` };
  });
}

/** Can these arguments be applied on this Java? Used before a preset is applied. */
function checkPreset(presetId, javaMajor) {
  const p = presetsFor(javaMajor).find((x) => x.id === presetId);
  if (!p) return { ok: false, reason: 'Unknown preset.' };
  return { ok: p.ok, reason: p.reason };
}

module.exports = {
  readPackMemory, parseMemorySettings, parseMemoryTester, parseConfigChecker, tableRecommend, pcCap, estimateMB, recommend,
  memoryMode, effectiveMB, checkAllocation, presetsFor, checkPreset, JVM_PRESETS, gbText, pcText,
};
