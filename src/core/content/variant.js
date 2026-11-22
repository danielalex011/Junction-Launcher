'use strict';
// Is a version a fair update for the installed one? Same kind of content (loaders: fabric, datapack, minecraft = resource pack...)
// and not just the same version number with another variant tag ("1.12.9+rp" vs "1.12.9+dp").

const lowerList = (a) => (Array.isArray(a) ? a.map((x) => String(x).toLowerCase()) : []);
const split = (n) => {
  const s = String(n || '').trim().toLowerCase();
  const i = s.indexOf('+');
  return i < 0 ? { base: s, tag: '' } : { base: s.slice(0, i), tag: s.slice(i + 1) };
};

/** `current` and `candidate` are normalised versions ({ versionNumber, loaders }); `current` may be missing or partial. */
function sameVariant(current, candidate) {
  if (!current || !candidate) return true;
  const a = lowerList(current.loaders);
  const b = lowerList(candidate.loaders);
  if (a.length && b.length && !a.some((l) => b.includes(l))) return false;
  const c = split(current.versionNumber);
  const d = split(candidate.versionNumber);
  if (c.base && c.base === d.base && c.tag !== d.tag) return false;
  return true;
}

module.exports = { sameVariant };
