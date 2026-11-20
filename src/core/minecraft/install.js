'use strict';
// Installs everything a resolved version needs: client jar, libraries, natives,
// assets and the log4j config. All downloads are hash-verified.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');
const { rulesAllow } = require('./rules');
const { exists, readJson, ensureDir, pool, mavenPath, mavenKey, osName, safeJoin } = require('../util');

const LIB_BASE = 'https://libraries.minecraft.net/';
const ASSET_BASE = 'https://resources.download.minecraft.net/';

function applicableLibraries(version) {
  const seen = new Set();
  const out = [];
  for (const lib of version.libraries || []) {
    if (!lib || !lib.name) continue;
    if (!rulesAllow(lib.rules)) continue;
    const key = mavenKey(lib.name) + (lib.natives ? ':natives' : '');
    if (seen.has(key)) continue; // child (loader) libraries come first and win
    seen.add(key);
    out.push(lib);
  }
  return out;
}

function libraryArtifact(ctx, lib) {
  if (lib.downloads?.artifact) {
    const a = lib.downloads.artifact;
    const rel = a.path || mavenPath(lib.name);
    return { path: path.join(ctx.paths.libraries, rel), url: a.url || '', sha1: a.sha1, size: a.size };
  }
  if (lib.natives && !lib.downloads?.artifact && lib.downloads) return null; // natives-only entry
  if (lib.natives && !lib.downloads) return null;
  const rel = mavenPath(lib.name);
  const base = (lib.url || LIB_BASE).replace(/\/?$/, '/');
  return { path: path.join(ctx.paths.libraries, rel), url: base + rel, sha1: lib.sha1, size: lib.size };
}

function nativeArtifact(ctx, lib) {
  if (!lib.natives) return null;
  const tmpl = lib.natives[osName()];
  if (!tmpl) return null;
  const classifier = tmpl.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
  const c = lib.downloads?.classifiers?.[classifier];
  if (c) return { path: path.join(ctx.paths.libraries, c.path), url: c.url, sha1: c.sha1, size: c.size, exclude: lib.extract?.exclude || [] };
  const [g, a, v] = lib.name.split(':');
  const rel = mavenPath(`${g}:${a}:${v}:${classifier}`);
  const base = (lib.url || LIB_BASE).replace(/\/?$/, '/');
  return { path: path.join(ctx.paths.libraries, rel), url: base + rel, exclude: lib.extract?.exclude || [] };
}

function clientJarPath(ctx, id) {
  return path.join(ctx.paths.versions, id, `${id}.jar`);
}

async function installAssets(ctx, version, report) {
  const ai = version.assetIndex;
  if (!ai) return null;
  const indexFile = path.join(ctx.paths.assets, 'indexes', `${ai.id}.json`);
  await ctx.http.download(ai.url, indexFile, { sha1: ai.sha1 });
  const index = await readJson(indexFile);
  const objects = Object.entries(index.objects || {});
  const jobs = [];
  for (const [, o] of objects) {
    const sub = o.hash.slice(0, 2);
    const dest = path.join(ctx.paths.assets, 'objects', sub, o.hash);
    jobs.push({ url: `${ASSET_BASE}${sub}/${o.hash}`, dest, sha1: o.hash, size: o.size });
  }
  // Fast path: skip existence checks we already did on a previous launch.
  const markerFile = path.join(ctx.paths.assets, 'indexes', `${ai.id}.verified`);
  if (await exists(markerFile)) return { index, id: ai.id };
  const missing = [];
  for (const j of jobs) {
    try {
      const st = await fsp.stat(j.dest);
      if (st.size !== j.size) missing.push(j);
    } catch { missing.push(j); }
  }
  let done = 0;
  const { errors } = await pool(missing, Math.max(8, (ctx.settings.get('concurrency') || 16) * 2), async (j) => {
    await ctx.http.download(j.url, j.dest, { sha1: j.sha1, size: j.size });
    done++;
    report(done / Math.max(1, missing.length), `Assets: ${done}/${missing.length}`);
  });
  if (errors.length) throw new Error(`${errors.length} asset downloads failed: ${errors[0].error.message}`);
  await fsp.writeFile(markerFile, new Date().toISOString());
  return { index, id: ai.id };
}

async function extractNatives(ctx, version, natives) {
  const dir = path.join(ctx.paths.natives, version.id);
  await ensureDir(dir); // modern LWJGL extracts its own natives here
  if (!natives.length) return dir;
  for (const n of natives) {
    const zip = new AdmZip(n.path);
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      if (n.exclude.some((ex) => e.entryName.startsWith(ex))) continue;
      const dest = safeJoin(dir, e.entryName);
      await ensureDir(path.dirname(dest));
      await fsp.writeFile(dest, e.getData());
    }
  }
  return dir;
}

/**
 * Makes sure everything for `version` (a resolved version) is on disk.
 * @returns {Promise<{libraries:string[], nativesDir:string, clientJar:string, assets:any, loggingFile?:string}>}
 */
async function installVersion(ctx, version, onProgress = () => {}) {
  const jobs = [];
  // 1. client jar
  const jarId = version._clientJarId || version.id;
  const clientJar = clientJarPath(ctx, jarId);
  if (version.downloads?.client) {
    jobs.push({ url: version.downloads.client.url, dest: clientJar, sha1: version.downloads.client.sha1, size: version.downloads.client.size });
  }
  // 2. libraries
  const libs = applicableLibraries(version);
  const classpath = [];
  const natives = [];
  const missingGenerated = [];
  for (const lib of libs) {
    const art = libraryArtifact(ctx, lib);
    if (art) {
      classpath.push(art.path);
      if (art.url) jobs.push({ url: art.url, dest: art.path, sha1: art.sha1, size: art.size });
      else if (!(await exists(art.path))) missingGenerated.push(lib.name);
    }
    const nat = nativeArtifact(ctx, lib);
    if (nat) {
      natives.push(nat);
      jobs.push({ url: nat.url, dest: nat.path, sha1: nat.sha1, size: nat.size });
    }
  }
  if (missingGenerated.length) {
    const err = new Error(`Loader files are missing (${missingGenerated[0]}). Reinstall the loader from the instance settings.`);
    err.code = 'LOADER_MISSING';
    throw err;
  }
  // 3. logging config (log4j hardening that Mojang ships)
  let loggingFile;
  const logCfg = version.logging?.client;
  if (logCfg?.file) {
    loggingFile = path.join(ctx.paths.assets, 'log_configs', logCfg.file.id);
    jobs.push({ url: logCfg.file.url, dest: loggingFile, sha1: logCfg.file.sha1, size: logCfg.file.size });
  }

  let done = 0;
  const { errors } = await pool(jobs, ctx.settings.get('concurrency') || 16, async (j) => {
    await ctx.http.download(j.url, j.dest, { sha1: j.sha1, size: j.size });
    done++;
    onProgress(0.5 * (done / jobs.length), `Libraries: ${done}/${jobs.length}`);
  });
  if (errors.length) throw new Error(`${errors.length} downloads failed. First: ${errors[0].error.message}`);

  const nativesDir = await extractNatives(ctx, version, natives);
  const assets = await installAssets(ctx, version, (p, d) => onProgress(0.5 + 0.5 * p, d));
  return { libraries: classpath, nativesDir, clientJar, assets, loggingFile };
}

/** Legacy versions (pre-1.6) want assets copied to a "virtual" folder or into the game dir. */
async function prepareLegacyAssets(ctx, assets, gameDir) {
  if (!assets?.index) return ctx.paths.assets;
  const { index, id } = assets;
  if (!index.virtual && !index.map_to_resources) return ctx.paths.assets;
  const target = index.map_to_resources ? path.join(gameDir, 'resources') : path.join(ctx.paths.assets, 'virtual', id);
  for (const [name, o] of Object.entries(index.objects)) {
    const dest = safeJoin(target, name);
    if (await exists(dest)) continue;
    await ensureDir(path.dirname(dest));
    await fsp.copyFile(path.join(ctx.paths.assets, 'objects', o.hash.slice(0, 2), o.hash), dest);
  }
  return target;
}

module.exports = { installVersion, applicableLibraries, libraryArtifact, nativeArtifact, clientJarPath, prepareLegacyAssets };
