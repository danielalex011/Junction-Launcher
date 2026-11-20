'use strict';
// Mod loaders. Fabric and Quilt publish ready-made version JSONs; Forge and
// NeoForge have to run their official installer (headless) because their
// installers patch the game with "processors".
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { exists, writeJson, readJson, ensureDir, compareVersions } = require('../util');
const { resolveVersion, versionJsonPath } = require('../minecraft/versions');
const { javaFor } = require('../minecraft/java');
const { clientJarPath } = require('../minecraft/install');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEO_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged';
const NEO_API = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged';

const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

/** NeoForge version -> Minecraft version. Handles both "21.1.77" (=1.21.1) and "26.1.2.5" (=26.1.2). */
function neoForgeToMc(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const [, a, b, c] = m;
  if (Number(a) >= 25) return c === '0' ? `${a}.${b}` : `${a}.${b}.${c}`;
  return b === '0' ? `1.${a}` : `1.${a}.${b}`;
}

async function listLoaderVersions(ctx, loader, mc) {
  if (loader === 'fabric' || loader === 'quilt') {
    const base = loader === 'fabric' ? FABRIC_META : QUILT_META;
    const list = await ctx.http.json(`${base}/versions/loader/${encodeURIComponent(mc)}`);
    return list.map((e) => ({
      version: e.loader.version,
      stable: loader === 'fabric' ? Boolean(e.loader.stable) : !/beta|alpha|pre|rc/i.test(e.loader.version),
    }));
  }
  if (loader === 'neoforge') {
    if (mc === '1.20.1') {
      // NeoForge's 1.20.1 builds live under the old "forge" artifact name.
      const res = await ctx.http.json(`${NEO_API}/forge`);
      return res.versions.filter((v) => v.startsWith('1.20.1-')).map((v) => ({ version: v.slice(7), stable: true })).reverse();
    }
    const res = await ctx.http.json(`${NEO_API}/neoforge`);
    return res.versions
      .filter((v) => neoForgeToMc(v) === mc)
      .map((v) => ({ version: v, stable: !/beta|alpha/i.test(v) }))
      .sort((x, y) => compareVersions(y.version, x.version));
  }
  if (loader === 'forge') {
    const xml = await ctx.http.text(`${FORGE_MAVEN}/maven-metadata.xml`);
    const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    let promos = {};
    try { promos = (await ctx.http.json('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos || {}; } catch { /* optional */ }
    const recommended = promos[`${mc}-recommended`];
    const latest = promos[`${mc}-latest`];
    return all
      .filter((v) => v.startsWith(`${mc}-`))
      .map((v) => {
        const short = v.slice(mc.length + 1);
        return { version: short, stable: true, recommended: short === recommended || short.startsWith(`${recommended}-`), latest: short === latest };
      })
      .sort((x, y) => compareVersions(y.version, x.version));
  }
  return [];
}

function pickDefault(list) {
  return list.find((v) => v.recommended) || list.find((v) => v.stable) || list[0];
}

async function installFabricLike(ctx, loader, loaderVersion, mc) {
  const base = loader === 'fabric' ? FABRIC_META : QUILT_META;
  const profile = await ctx.http.json(`${base}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loaderVersion)}/profile/json`);
  await writeJson(versionJsonPath(ctx, profile.id), profile);
  return profile.id;
}

function installerUrl(loader, loaderVersion, mc) {
  if (loader === 'forge') {
    const full = `${mc}-${loaderVersion}`;
    return { url: `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`, name: `forge-${full}-installer.jar` };
  }
  if (mc === '1.20.1') {
    const full = `1.20.1-${loaderVersion}`;
    return { url: `${NEO_MAVEN}/forge/${full}/forge-${full}-installer.jar`, name: `neoforge-${full}-installer.jar` };
  }
  return { url: `${NEO_MAVEN}/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`, name: `neoforge-${loaderVersion}-installer.jar` };
}

function readInstallerVersionId(installerPath) {
  const zip = new AdmZip(installerPath);
  const v = zip.getEntry('version.json');
  if (v) return JSON.parse(zip.readAsText(v)).id;
  const p = zip.getEntry('install_profile.json');
  if (p) {
    const prof = JSON.parse(zip.readAsText(p));
    return prof.versionInfo?.id || prof.version;
  }
  throw new Error('This installer has no version information (very old Forge versions are not supported).');
}

function runJava(java, args, cwd, onLine) {
  return new Promise((resolve) => {
    const child = spawn(java, args, { cwd, windowsHide: true });
    let output = '';
    const handle = (d) => {
      const s = d.toString();
      output += s;
      if (output.length > 200000) output = output.slice(-100000);
      for (const line of s.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (e) => resolve({ code: -1, output: `${output}\n${e.message}` }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function installForgeLike(ctx, loader, loaderVersion, mc, onProgress) {
  const { url, name } = installerUrl(loader, loaderVersion, mc);
  const installer = path.join(ctx.paths.cache, 'installers', name);
  onProgress(0.05, `Downloading ${name}`);
  await ctx.http.download(url, installer);
  const id = readInstallerVersionId(installer);
  if (await exists(versionJsonPath(ctx, id))) {
    // Already installed — but make sure the processed client files still exist.
    const marker = path.join(ctx.paths.versions, id, '.junction-installed');
    if (await exists(marker)) return id;
  }

  // The installer expects a launcher-style folder with the vanilla version present.
  const vanilla = await resolveVersion(ctx, mc);
  if (vanilla.downloads?.client) {
    await ctx.http.download(vanilla.downloads.client.url, clientJarPath(ctx, mc), { sha1: vanilla.downloads.client.sha1 });
  }
  const profiles = path.join(ctx.paths.meta, 'launcher_profiles.json');
  if (!(await exists(profiles))) await writeJson(profiles, { profiles: {}, settings: {}, version: 3 });

  let java = await javaFor(ctx, vanilla, null, (p, d) => onProgress(0.1 + p * 0.2, d));
  // Use the console java.exe (not javaw.exe) on Windows so installer output can be captured.
  const cli = java.replace(/javaw\.exe$/i, 'java.exe');
  if (cli !== java && (await exists(cli))) java = cli;
  onProgress(0.35, `Running the ${loader === 'forge' ? 'Forge' : 'NeoForge'} installer (this can take a minute)`);
  let lines = 0;
  const onLine = (l) => { lines++; onProgress(Math.min(0.95, 0.35 + lines / 800), l.slice(0, 140)); };
  let result = await runJava(java, ['-jar', installer, '--installClient', ctx.paths.meta], ctx.paths.meta, onLine);
  if (result.code !== 0 && /unrecognized|not a recognized option|UnrecognizedOption/i.test(result.output)) {
    result = await runJava(java, ['-jar', installer, '--install-client', ctx.paths.meta], ctx.paths.meta, onLine);
  }
  if (result.code !== 0 || !(await exists(versionJsonPath(ctx, id)))) {
    const tail = result.output.split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
    throw new Error(`The ${loader} installer failed (exit ${result.code}).\n${tail}`);
  }
  await fsp.writeFile(path.join(ctx.paths.versions, id, '.junction-installed'), new Date().toISOString());
  return id;
}

/** Ensures the loader is installed and returns the version id to launch. */
async function installLoader(ctx, { type, version: loaderVersion }, mc, onProgress = () => {}) {
  if (!type || type === 'vanilla') return mc;
  if (!loaderVersion) throw new Error(`No ${LOADER_NAMES[type]} version selected`);
  if (type === 'fabric' || type === 'quilt') {
    const expected = `${type}-loader-${loaderVersion}-${mc}`;
    if (await exists(versionJsonPath(ctx, expected))) return expected;
    return installFabricLike(ctx, type, loaderVersion, mc);
  }
  if (type === 'forge' || type === 'neoforge') return installForgeLike(ctx, type, loaderVersion, mc, onProgress);
  throw new Error(`Unknown loader: ${type}`);
}

/** Parses "forge-47.2.0" / "fabric-0.16.10" / "neoforge-21.1.77" (CurseForge manifest style). */
function parseLoaderId(id) {
  const m = String(id).match(/^(forge|neoforge|fabric|quilt)-(.+)$/i);
  if (!m) return null;
  return { type: m[1].toLowerCase(), version: m[2] };
}

module.exports = {
  LOADERS, LOADER_NAMES, listLoaderVersions, pickDefault, installLoader, neoForgeToMc, parseLoaderId, readInstallerVersionId,
};
