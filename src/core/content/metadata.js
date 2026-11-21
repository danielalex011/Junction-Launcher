'use strict';
// Reads the mod's own metadata from inside the jar (Fabric, Quilt, Forge,
// NeoForge). This is how Junction spots the same mod installed twice even when
// one copy came from Modrinth and the other from CurseForge.
const AdmZip = require('adm-zip');

function parseLooseJson(text) {
  // fabric.mod.json files in the wild often contain raw newlines/tabs inside strings.
  return JSON.parse(text.replace(/^﻿/, '').replace(/[\u0000-\u001F]+/g, ' '));
}

function tomlValue(section, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(?:"""([\\s\\S]*?)"""|"([^"]*)"|'([^']*)')`, 'm');
  const m = section.match(re);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

function parseModsToml(text) {
  const idx = text.indexOf('[[mods]]');
  if (idx === -1) return null;
  const rest = text.slice(idx + 8);
  const end = rest.search(/^\s*\[/m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const authors = tomlValue(text, 'authors') || tomlValue(section, 'authors');
  return { modId: tomlValue(section, 'modId'), name: tomlValue(section, 'displayName'), version: tomlValue(section, 'version'), ...(authors ? { authors: [String(authors).split(',')[0].trim()] } : {}) };
}

function manifestVersion(zip) {
  const mf = zip.getEntry('META-INF/MANIFEST.MF');
  if (!mf) return undefined;
  const m = zip.readAsText(mf).match(/^Implementation-Version:\s*(.+)$/m);
  return m ? m[1].trim() : undefined;
}

function readModMetadata(file) {
  let zip;
  try { zip = new AdmZip(file); } catch { return null; }
  const read = (name) => {
    const e = zip.getEntry(name);
    return e ? zip.readAsText(e) : null;
  };
  try {
    const fabric = read('fabric.mod.json');
    if (fabric) {
      const j = parseLooseJson(fabric);
      const authors = (Array.isArray(j.authors) ? j.authors : []).map((a) => (typeof a === 'string' ? a : a?.name)).filter((a) => typeof a === 'string' && a).slice(0, 3);
      return { loader: 'fabric', modId: j.id, name: j.name || j.id, version: j.version, environment: j.environment, ...(authors.length ? { authors } : {}) };
    }
    const quilt = read('quilt.mod.json');
    if (quilt) {
      const j = parseLooseJson(quilt).quilt_loader || {};
      return { loader: 'quilt', modId: j.id, name: j.metadata?.name || j.id, version: j.version, environment: j.minecraft?.environment };
    }
    for (const [name, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge']]) {
      const t = read(name);
      if (!t) continue;
      const m = parseModsToml(t);
      if (!m) continue;
      let { version } = m;
      if (!version || version.includes('${')) version = manifestVersion(zip) || version;
      return { loader, modId: m.modId, name: m.name || m.modId, version, ...(m.authors ? { authors: m.authors } : {}) };
    }
    const mcmod = read('mcmod.info');
    if (mcmod) {
      const j = parseLooseJson(mcmod);
      const first = Array.isArray(j) ? j[0] : j.modList?.[0];
      if (first) return { loader: 'forge', modId: first.modid, name: first.name, version: first.version };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Is this mod only needed on the client (safe to leave off a server)?
 * Two sources: the jar's own "environment" field (Fabric / Quilt: "client"), and, when the
 * project is known, Modrinth's client_side / server_side (stored in content.json as sides).
 */
function isClientOnly({ environment, sides } = {}) {
  if (environment === 'client') return true;
  return Boolean(sides && sides.server === 'unsupported' && sides.client !== 'unsupported');
}

module.exports = { readModMetadata, parseModsToml, parseLooseJson, isClientOnly };
