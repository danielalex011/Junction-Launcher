'use strict';
// "Is this file on Modrinth or CurseForge?" Looks files up by hash before they are installed.
// A match only says the platform hosts a file with exactly these bytes. It does not say the file is safe,
// and nothing here (or in the UI) should ever claim that.
const crypto = require('crypto');
const fsp = require('fs').promises;
const { curseFingerprint } = require('../sources/fingerprint');

const MAX_LISTED = 12;
const MODRINTH_HOST = 'cdn.modrinth.com';

const digest = (algo, buf) => crypto.createHash(algo).update(buf).digest('hex');

/** A file name that is safe to show: no folders, no control characters, not endless. */
function safeName(name) {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop() || 'unnamed file';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '?').trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean || 'unnamed file';
}

/** Entries for files on disk (the ones the user picked in "Add files"). */
function entriesFromPaths(paths) {
  return paths.map((p) => ({ name: safeName(p), read: () => fsp.readFile(p) }));
}

/**
 * Entries for what a modpack archive brings along that is not fetched from a platform by id:
 *   - every .jar inside its overrides folders (shipped in the zip itself)
 *   - Modrinth pack files whose download is hosted somewhere other than Modrinth's own CDN
 * fmt is 'mrpack' or 'curseforge' (CurseForge manifest files are CurseForge files by id, so only overrides matter).
 */
function entriesFromPack(zip, fmt) {
  const entries = [];
  let prefixes;
  if (fmt === 'mrpack') {
    prefixes = ['overrides/', 'client-overrides/'];
    let index = {};
    try { index = JSON.parse(zip.readAsText('modrinth.index.json')); } catch { /* the install reports a broken pack */ }
    for (const f of index.files || []) {
      if (f.env?.client === 'unsupported') continue;
      const hosts = (f.downloads || []).map((u) => { try { return new URL(u).hostname; } catch { return ''; } });
      if (hosts.length && hosts.every((h) => h === MODRINTH_HOST)) continue; // hosted by Modrinth itself
      const outside = hosts.find((h) => h && h !== MODRINTH_HOST);
      entries.push({
        name: safeName(f.path), note: outside ? `hosted on ${outside.replace(/[^a-z0-9.-]/gi, '')}` : 'no download address',
        sha1: f.hashes?.sha1, sha512: f.hashes?.sha512, read: null, // not downloaded yet, so no CurseForge fingerprint
      });
    }
  } else {
    let manifest = {};
    try { manifest = JSON.parse(zip.readAsText('manifest.json')); } catch { /* same */ }
    prefixes = [`${manifest.overrides || 'overrides'}/`];
  }
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !/\.jar$/i.test(e.entryName)) continue;
    if (!prefixes.some((p) => e.entryName.startsWith(p))) continue;
    entries.push({ name: safeName(e.entryName), read: async () => e.getData() });
  }
  return entries;
}

/**
 * Looks each entry up on Modrinth (SHA-512) and then CurseForge (fingerprint, double-checked against the SHA-1 CurseForge lists).
 * Returns { unknown: [label], unchecked: [label], cfSkipped }:
 *   unknown   = looked up and found on neither platform
 *   unchecked = the lookup itself failed, so nothing can be said about them
 *   cfSkipped = CurseForge wasn't asked (no API key), so "unknown" really means "not on Modrinth"
 */
async function findUnknown(sources, entries) {
  const out = { unknown: [], unchecked: [], cfSkipped: false };
  if (!entries.length) return out;
  const label = (e) => (e.note ? `${e.name} (${e.note})` : e.name);
  for (const e of entries) {
    if (e.read && !(e.sha1 && e.sha512)) {
      const data = await e.read();
      e.sha1 = digest('sha1', data);
      e.sha512 = digest('sha512', data);
    }
  }

  let known = new Set();
  let modrinthFailed = false;
  try {
    const found = await sources.modrinth.versionsByHash([...new Set(entries.map((e) => e.sha512).filter(Boolean))], 'sha512');
    known = new Set(Object.keys(found).map((h) => h.toLowerCase()));
  } catch { modrinthFailed = true; }
  const onModrinth = (e) => Boolean(e.sha512) && known.has(String(e.sha512).toLowerCase());

  let rest = entries.filter((e) => !onModrinth(e));
  const onCurse = new Set();
  let cfFailed = false;
  const canAsk = rest.filter((e) => e.read);
  if (!modrinthFailed && canAsk.length) {
    if (!sources.curseforge.configured()) {
      out.cfSkipped = true;
    } else {
      try {
        const prints = new Map();
        for (const e of canAsk) prints.set(e, curseFingerprint(await e.read()));
        const matches = await sources.curseforge.byFingerprint([...new Set(prints.values())]);
        for (const [e, fp] of prints) {
          const m = matches[fp];
          if (!m) continue;
          // Murmur2 is only 32 bits: also require the SHA-1 CurseForge lists for that file, when it lists one.
          const theirs = m.version?.files?.[0]?.sha1;
          if (!theirs || String(theirs).toLowerCase() === String(e.sha1).toLowerCase()) onCurse.add(e);
        }
      } catch { cfFailed = true; }
    }
  }
  if (modrinthFailed) { out.unchecked = rest.map(label); return out; }
  rest = rest.filter((e) => !onCurse.has(e));
  // Files that couldn't be fingerprinted aren't blamed on a failed CurseForge call; the ones that could have been are "unchecked".
  for (const e of rest) (cfFailed && e.read ? out.unchecked : out.unknown).push(label(e));
  return out;
}

/** The words for the warning dialog. Never says a file is safe or checked-and-fine. */
function describeUnknown(r) {
  const list = (names) => {
    const shown = names.slice(0, MAX_LISTED).map((n) => `  • ${n}`);
    if (names.length > MAX_LISTED) shown.push(`  …and ${names.length - MAX_LISTED} more`);
    return shown.join('\n');
  };
  // The heading already says what the list is; a label above the list is only needed when both kinds are shown.
  const both = r.unknown.length > 0 && r.unchecked.length > 0;
  const parts = [];
  if (r.unknown.length) {
    const site = r.cfSkipped ? 'Modrinth' : 'Modrinth or CurseForge';
    parts.push(both ? `Not found on ${site}:\n${list(r.unknown)}` : list(r.unknown));
  }
  if (r.unchecked.length) parts.push(both ? `Couldn't be checked (the lookup failed, so Junction can't say either way):\n${list(r.unchecked)}` : list(r.unchecked));
  const n = r.unknown.length + r.unchecked.length;
  const tail = [
    n === 1
      ? "Junction can't tell what this file does. Only install it if you trust where it came from."
      : "Junction can't tell what these files do. Only install them if you trust where they came from.",
    r.cfSkipped ? "CurseForge wasn't checked because no CurseForge API key is set in Settings." : '',
  ].filter(Boolean).join(' ');
  return {
    title: 'Files Junction could not match',
    message: r.unknown.length
      ? `${n} file${n === 1 ? ' was' : 's were'} not found on ${r.cfSkipped ? 'Modrinth' : 'Modrinth or CurseForge'}`
      : `${n} file${n === 1 ? '' : 's'} could not be checked against Modrinth or CurseForge`,
    detail: `${parts.join('\n\n')}\n\n${tail}`,
    buttons: ["Don't install", 'Install anyway'],
  };
}

const hasFindings = (r) => Boolean(r && (r.unknown.length || r.unchecked.length));

module.exports = { safeName, entriesFromPaths, entriesFromPack, findUnknown, describeUnknown, hasFindings, digest };
