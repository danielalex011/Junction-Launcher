'use strict';
// Mojang version manifest + version JSON resolution (including inheritsFrom,
// which Fabric, Quilt, Forge and NeoForge all use).
const path = require('path');
const { exists, readJson, writeJson } = require('../util');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
let manifestCache = null;
let manifestAt = 0;

async function getManifest(ctx, { force = false } = {}) {
  if (!force && manifestCache && Date.now() - manifestAt < 30 * 60 * 1000) return manifestCache;
  const file = path.join(ctx.paths.meta, 'version_manifest_v2.json');
  try {
    manifestCache = await ctx.http.json(MANIFEST_URL);
    manifestAt = Date.now();
    await writeJson(file, manifestCache);
  } catch (e) {
    // Offline? Fall back to the last copy we saw.
    const cached = await readJson(file, null);
    if (!cached) throw e;
    manifestCache = cached;
  }
  return manifestCache;
}

async function listGameVersions(ctx, { snapshots = false } = {}) {
  const m = await getManifest(ctx);
  return m.versions
    .filter((v) => snapshots || v.type === 'release')
    .map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
}

function versionJsonPath(ctx, id) {
  return path.join(ctx.paths.versions, id, `${id}.json`);
}

async function ensureVersionJson(ctx, id) {
  const file = versionJsonPath(ctx, id);
  if (await exists(file)) {
    const json = await readJson(file, null);
    if (json) return json;
  }
  const manifest = await getManifest(ctx);
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new Error(`Minecraft version "${id}" was not found. If it's a modded version, install the loader first.`);
  await ctx.http.download(entry.url, file, { sha1: entry.sha1 });
  return readJson(file);
}

function mergeVersion(parent, child) {
  const merged = { ...parent, ...child };
  merged.libraries = [...(child.libraries || []), ...(parent.libraries || [])];
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...(parent.arguments?.game || []), ...(child.arguments?.game || [])],
      jvm: [...(parent.arguments?.jvm || []), ...(child.arguments?.jvm || [])],
    };
  }
  merged.minecraftArguments = child.minecraftArguments || parent.minecraftArguments;
  for (const k of ['assetIndex', 'assets', 'downloads', 'javaVersion', 'logging', 'type', 'releaseTime']) {
    merged[k] = child[k] || parent[k];
  }
  merged.mainClass = child.mainClass || parent.mainClass;
  merged._clientJarId = child.downloads?.client ? child.id : (parent._clientJarId || parent.id);
  merged._chain = [...(parent._chain || [parent.id]), child.id];
  merged._baseId = parent._baseId || parent.id;
  delete merged.inheritsFrom;
  return merged;
}

/** Fully resolved version: inheritsFrom flattened, ready for install + launch. */
async function resolveVersion(ctx, id, depth = 0) {
  if (depth > 8) throw new Error('Version inheritance is nested too deeply');
  const json = await ensureVersionJson(ctx, id);
  if (!json.inheritsFrom) {
    return { ...json, _clientJarId: json.id, _chain: [json.id], _baseId: json.id };
  }
  const parent = await resolveVersion(ctx, json.inheritsFrom, depth + 1);
  return mergeVersion(parent, json);
}

module.exports = { getManifest, listGameVersions, ensureVersionJson, resolveVersion, mergeVersion, versionJsonPath };
