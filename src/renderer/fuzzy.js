'use strict';
// Typo-tolerant matching and ranking for the quick search (Ctrl+K). Runs locally, no network.
// Plain script that also loads in Node, so the tests can use it. Shares one global scope with the other src/renderer files.

const JunctionSearch = (function searchModule() {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const words = (s) => norm(s).split(' ').filter(Boolean);

  /** Edit distance counting a swapped pair of letters as one mistake. Gives up (returns max + 1) when it is above max. */
  function distance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const prev2 = []; let prev = []; let cur = [];
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
        rowMin = Math.min(rowMin, cur[j]);
      }
      if (rowMin > max) return max + 1;
      prev2.length = 0; prev2.push(...prev); prev = cur;
    }
    return prev[b.length];
  }
  const tolerance = (len) => (len <= 3 ? 0 : len <= 7 ? 1 : 2);
  const isSubsequence = (q, w) => { let i = 0; for (const c of w) if (c === q[i]) i++; return i === q.length; };

  /** How well one typed word matches one word of the text: 0 (no) to 100 (same). */
  function wordScore(q, w) {
    if (q === w) return 100;
    if (w.startsWith(q)) return 90 - Math.min(10, w.length - q.length);
    if (w.includes(q) && q.length >= 3) return 65;
    const tol = tolerance(q.length);
    if (tol) {
      const dFull = distance(q, w, tol);
      const dPre = distance(q, w.slice(0, q.length), tol); // a typo in the part typed so far
      const d = Math.min(dFull, dPre);
      if (d <= tol) return (dPre <= tol && dPre <= dFull ? 62 : 55) - d * 8;
    }
    if (q.length >= 3 && isSubsequence(q, w)) return 28;
    return 0;
  }

  /** 0 when some typed word matches nothing, otherwise about 25 to 100. Every typed word has to match. */
  function textScore(query, text) {
    const qw = words(query);
    const tw = words(text);
    if (!qw.length || !tw.length) return 0;
    let sum = 0;
    for (const q of qw) {
      let best = 0;
      for (const w of tw) best = Math.max(best, wordScore(q, w));
      if (!best) return 0;
      sum += best;
    }
    let score = sum / qw.length;
    if (norm(text).startsWith(norm(query))) score += 6; // "fab" on "Fabric 1.21" beats "My Fabric"
    return Math.min(100, score);
  }

  const KIND_TIEBREAK = { instance: 3, page: 2, action: 1, mod: 0 };
  const MOD_FACTOR = 0.85; // a mod has to match clearly better than an instance, page or action to rank above it
  const EMPTY_BASE = { page: 60, instance: 50, action: 40 };

  /**
   * Ranks `items` ({ id, kind, title, sub?, keywords?: string[], queryOnly? }) for the typed text, best first.
   * Recent choices (`recent`: ids, newest first) get a boost, and with nothing typed they come first.
   * Returns [{ item, score }].
   */
  function rank(query, items, { recent = [], limit = 30 } = {}) {
    const q = norm(query);
    const recentIndex = new Map(recent.map((id, i) => [id, i]));
    const out = [];
    items.forEach((item, order) => {
      const r = recentIndex.has(item.id) ? recentIndex.get(item.id) : -1;
      let score;
      if (!q) {
        if (r >= 0) score = 1000 - r;
        else if (item.queryOnly || !(item.kind in EMPTY_BASE)) return;
        else score = EMPTY_BASE[item.kind] - Math.min(order, 30) * 0.1;
      } else {
        if (item.kind === 'mod') score = MOD_FACTOR * textScore(q, item.title); // mods match on their own name only, never on "in <instance>"
        else {
          score = Math.max(
            textScore(q, item.title),
            0.92 * textScore(q, `${item.title} ${item.sub || ''}`), // words may be split between the name and a subtitle
            0.8 * textScore(q, (item.keywords || []).join(' ')),
            0.45 * textScore(q, item.sub || ''),
          );
        }
        if (!score) return;
        score += (KIND_TIEBREAK[item.kind] || 0) + (r >= 0 ? 14 - r : 0);
      }
      out.push({ item, score, order });
    });
    out.sort((a, b) => b.score - a.score || a.order - b.order);
    return out.slice(0, limit).map(({ item, score }) => ({ item, score }));
  }

  return { norm, distance, wordScore, textScore, rank };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = JunctionSearch;
