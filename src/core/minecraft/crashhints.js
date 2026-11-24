'use strict';
// Reads the game's output and spots a few well-known reasons a game won't start, so Junction can say it in plain words
// and offer the fix (turn a mod off, find a missing one, give more memory). Plain Node, no Electron.
//
//   const d = createHintDetector();
//   for (const line of output) { const hint = d.push(line); if (hint) show(hint); }
//
// A hint: { kind: 'incompatible', modId, reason? } | { kind: 'missing', modId, name?, requestedBy? } | { kind: 'memory' }

const ID = "[a-z0-9_.-]+";

function createHintDetector() {
  const seen = new Set();
  let pending = null; // an "Incompatible mod loaded" line waiting for its "Reason:" line

  const once = (hint) => {
    const key = `${hint.kind}:${hint.modId || ''}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return hint;
  };

  function push(raw) {
    const line = String(raw);
    let out = null;
    if (pending) {
      const reason = /^\s*-?\s*Reason:\s*(.+?)\s*$/.exec(line);
      if (reason) { pending.reason = reason[1]; out = once(pending); pending = null; return out; }
      out = once(pending); // no reason line followed: still worth saying
      pending = null;
      if (out) return out;
    }
    // KubeJS Tweaks (All the Mods packs) and others: "Incompatible mod loaded: letmedespawn"
    let m = new RegExp(`Incompatible mod loaded:\\s*(${ID})`, 'i').exec(line);
    if (m) { pending = { kind: 'incompatible', modId: m[1].toLowerCase() }; return null; }
    // NeoForge / Forge: "Mod ID: 'sodium', Requested by: 'iris', Expected range: '[0.6,)', Actual version: '[MISSING]'"
    m = new RegExp(`Mod ID: '(${ID})', Requested by: '(${ID})'.*Actual version: '\\[MISSING\\]'`, 'i').exec(line);
    if (m) return once({ kind: 'missing', modId: m[1].toLowerCase(), requestedBy: m[2].toLowerCase() });
    // Fabric / Quilt: "Mod 'Iris' (iris) 1.8.0 requires any version of mod 'Sodium' (sodium), which is missing!"
    m = new RegExp(`Mod '([^']+)' \\((${ID})\\).*?requires .*?'([^']+)' \\((${ID})\\), which is missing`, 'i').exec(line);
    if (m) return once({ kind: 'missing', modId: m[4].toLowerCase(), name: m[3], requestedBy: m[2].toLowerCase(), requestedByName: m[1] });
    if (/java\.lang\.OutOfMemoryError/.test(line)) return once({ kind: 'memory' });
    return null;
  }

  /** Call when the output ends: a waiting "Incompatible mod" line is still reported. */
  function end() {
    const out = pending ? once(pending) : null;
    pending = null;
    return out;
  }

  return { push, end };
}

/** Adds the installed file a hint is about (by mod id, then by file name), so the page can offer "Turn off X". */
function attachFiles(hint, items) {
  if (!hint || !hint.modId || !Array.isArray(items)) return hint;
  const id = hint.modId.toLowerCase();
  const byId = items.find((i) => String(i.modId || '').toLowerCase() === id);
  const byName = byId || items.find((i) => String(i.fileName || i.file || '').toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(id.replace(/[^a-z0-9]/g, '')));
  const hit = byId || byName;
  const out = { ...hint };
  if (hit) out.file = { rel: hit.file, title: hit.title, enabled: hit.enabled !== false, fromPack: Boolean(hit.fromPack) };
  if (hint.requestedBy) {
    const req = items.find((i) => String(i.modId || '').toLowerCase() === hint.requestedBy);
    if (req) out.requestedByTitle = req.title;
  }
  return out;
}

module.exports = { createHintDetector, attachFiles };
