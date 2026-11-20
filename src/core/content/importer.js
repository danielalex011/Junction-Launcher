'use strict';
// Bring an existing instance over from the CurseForge app, Modrinth App,
// Prism/MultiMC, or a plain .minecraft-style folder — without re-downloading.
const fsp = require('fs').promises;
const path = require('path');
const { readJson, exists, copyDir } = require('../util');
const { parseLoaderId } = require('../loaders');
const { readModMetadata } = require('./metadata');

const SKIP_TOP = new Set(['minecraftinstance.json', 'profile.json', 'mmc-pack.json', 'instance.cfg', 'logs', 'crash-reports', '.fabric', 'natives', '.mixin.out']);

function guessFromName(name) {
  const loader = (String(name).match(/\b(neoforge|forge|fabric|quilt)\b/i) || [])[1]?.toLowerCase() || null;
  const mc = (String(name).match(/\b(1\.\d{1,2}(?:\.\d{1,2})?|2\d\.\d(?:\.\d{1,2})?)\b/) || [])[1] || null;
  return { loader, mc };
}

/** Inspects a folder and returns what we could work out about it. */
async function detectInstance(folder) {
  const info = { folder, gameDir: folder, name: path.basename(folder), mcVersion: null, loader: null, loaderVersion: null, from: 'folder' };

  const cf = await readJson(path.join(folder, 'minecraftinstance.json'), null);
  if (cf) {
    info.from = 'CurseForge app';
    info.name = cf.name || info.name;
    info.mcVersion = cf.gameVersion || cf.baseModLoader?.minecraftVersion || null;
    const l = parseLoaderId(cf.baseModLoader?.name || '');
    if (l) {
      info.loader = l.type;
      // "fabric-0.16.10-1.21.1" -> keep only the loader version
      info.loaderVersion = l.type === 'fabric' || l.type === 'quilt' ? l.version.replace(new RegExp(`-${(info.mcVersion || '').replace(/\./g, '\\.')}$`), '') : l.version;
    }
  }

  const mr = await readJson(path.join(folder, 'profile.json'), null);
  if (mr?.metadata) {
    info.from = 'Modrinth App';
    info.name = mr.metadata.name || info.name;
    info.mcVersion = mr.metadata.game_version || null;
    info.loader = mr.metadata.loader && mr.metadata.loader !== 'vanilla' ? mr.metadata.loader : null;
    info.loaderVersion = mr.metadata.loader_version?.id || null;
  }

  const mmc = await readJson(path.join(folder, 'mmc-pack.json'), null);
  if (mmc?.components) {
    info.from = 'Prism / MultiMC';
    for (const c of mmc.components) {
      if (c.uid === 'net.minecraft') info.mcVersion = c.version;
      const map = { 'net.fabricmc.fabric-loader': 'fabric', 'org.quiltmc.quilt-loader': 'quilt', 'net.minecraftforge': 'forge', 'net.neoforged': 'neoforge' };
      if (map[c.uid]) { info.loader = map[c.uid]; info.loaderVersion = c.version; }
    }
    for (const sub of ['.minecraft', 'minecraft']) {
      if (await exists(path.join(folder, sub))) { info.gameDir = path.join(folder, sub); break; }
    }
    try {
      const cfg = await fsp.readFile(path.join(folder, 'instance.cfg'), 'utf8');
      const m = cfg.match(/^name=(.+)$/m);
      if (m) info.name = m[1].trim();
    } catch { /* optional */ }
  }

  if (/ModrinthApp[\\/]profiles/i.test(folder) && info.from === 'folder') info.from = 'Modrinth App';

  // Fill gaps from the folder name ("Fabric 26.1.2") and from the mods themselves.
  const guess = guessFromName(info.name);
  if (!info.mcVersion) info.mcVersion = guess.mc;
  if (!info.loader) {
    const counts = {};
    const mods = await fsp.readdir(path.join(info.gameDir, 'mods')).catch(() => []);
    for (const m of mods.filter((f) => f.endsWith('.jar')).slice(0, 40)) {
      const meta = readModMetadata(path.join(info.gameDir, 'mods', m));
      if (meta?.loader) counts[meta.loader] = (counts[meta.loader] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    info.loader = top?.[0] || guess.loader || (mods.length ? null : 'vanilla');
  }
  const modCount = (await fsp.readdir(path.join(info.gameDir, 'mods')).catch(() => [])).length;
  return { ...info, modCount };
}

/** Copies the folder into a new Junction instance. */
async function importInstance({ instances, content }, info, { name, mcVersion, loader, loaderVersion }, report = () => {}) {
  const inst = await instances.create({
    name: name || info.name,
    mcVersion: mcVersion || info.mcVersion,
    loader: loader && loader !== 'vanilla' ? { type: loader, version: loaderVersion || info.loaderVersion } : { type: 'vanilla' },
  });
  report(0.1, 'Copying files');
  await copyDir(info.gameDir, instances.gameDir(inst.id), {
    filter: (p) => {
      const rel = path.relative(info.gameDir, p);
      const top = rel.split(path.sep)[0];
      return !SKIP_TOP.has(top);
    },
  });
  report(0.6, 'Identifying mods on Modrinth and CurseForge');
  const r = await content.identify(inst.id, null, (p, d) => report(p == null ? null : 0.6 + p * 0.4, d));
  return { instance: inst, ...r };
}

module.exports = { detectInstance, importInstance, guessFromName };
