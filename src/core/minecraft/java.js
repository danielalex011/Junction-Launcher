'use strict';
// Downloads the exact Java runtime Mojang ships for each Minecraft version
// (Java 8 for old versions, 17/21/25 for newer ones), so nobody has to install Java by hand.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { exists, readJson, writeJson, ensureDir, pool, safeJoin } = require('../util');

const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function platformKey() {
  const { platform, arch } = process;
  if (platform === 'win32') return arch === 'arm64' ? 'windows-arm64' : arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  if (platform === 'linux') return arch === 'ia32' ? 'linux-i386' : 'linux';
  return platform;
}

function javaExecutable(dir) {
  if (process.platform === 'win32') return path.join(dir, 'bin', 'javaw.exe');
  if (process.platform === 'darwin') return path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return path.join(dir, 'bin', 'java');
}

async function getIndex(ctx) {
  const cacheFile = path.join(ctx.paths.cache, 'java-runtimes.json');
  try {
    const idx = await ctx.http.json(RUNTIME_INDEX);
    await writeJson(cacheFile, idx);
    return idx;
  } catch (e) {
    const cached = await readJson(cacheFile, null);
    if (cached) return cached;
    throw e;
  }
}

async function ensureRuntime(ctx, component, onProgress = () => {}, { force = false } = {}) {
  const dir = path.join(ctx.paths.runtimes, component);
  const markerFile = path.join(dir, '.junction-runtime.json');
  const marker = await readJson(markerFile, null);
  const exe = javaExecutable(dir);

  let index;
  try {
    index = await getIndex(ctx);
  } catch (e) {
    if (marker && (await exists(exe))) return exe; // offline but already installed
    throw e;
  }
  const entries = index[platformKey()]?.[component];
  if (!entries || !entries.length) {
    if (marker && (await exists(exe))) return exe;
    throw new Error(`Mojang has no "${component}" Java runtime for ${platformKey()}. Set a Java path in Settings or the instance settings.`);
  }
  const entry = entries[0];
  if (!force && marker && marker.manifestSha1 === entry.manifest.sha1 && (await exists(exe))) return exe; // force = repair: check every file again

  const manifest = await ctx.http.json(entry.manifest.url);
  const files = Object.entries(manifest.files);
  await ensureDir(dir);
  for (const [rel, f] of files) {
    if (f.type === 'directory') await ensureDir(safeJoin(dir, rel));
  }
  const downloads = files.filter(([, f]) => f.type === 'file');
  let done = 0;
  const { errors } = await pool(downloads, ctx.settings.get('concurrency') || 16, async ([rel, f]) => {
    const dest = safeJoin(dir, rel);
    const raw = f.downloads.raw;
    await ctx.http.download(raw.url, dest, { sha1: raw.sha1, size: raw.size });
    if (f.executable && process.platform !== 'win32') await fsp.chmod(dest, 0o755);
    done++;
    onProgress(done / downloads.length, `Java ${entry.version?.name || component}: ${done}/${downloads.length} files`);
  });
  if (errors.length) throw new Error(`Java runtime download failed (${errors.length} files): ${errors[0].error.message}`);
  if (process.platform !== 'win32') {
    for (const [rel, f] of files) {
      if (f.type !== 'link') continue;
      const linkPath = safeJoin(dir, rel);
      await fsp.rm(linkPath, { force: true });
      await fsp.symlink(f.target, linkPath).catch(() => {});
    }
  }
  await writeJson(markerFile, { component, manifestSha1: entry.manifest.sha1, version: entry.version?.name });
  return exe;
}

// Mojang's runtime names and the Java they hold. The Settings page groups them into the four versions people know.
const COMPONENT_MAJOR = { 'jre-legacy': 8, 'java-runtime-alpha': 16, 'java-runtime-beta': 17, 'java-runtime-gamma': 17, 'java-runtime-gamma-snapshot': 17, 'java-runtime-delta': 21, 'java-runtime-epsilon': 25 };

/** 8, 16 -> 8/17 ... : the Java version row (8, 17, 21 or 25) a Java belongs to. */
function bucketMajor(n) {
  const m = Number(n) || 0;
  if (m <= 8) return 8;
  if (m <= 17) return 17;
  if (m <= 21) return 21;
  return 25;
}

/** The Java version row (8, 17, 21, 25) a Minecraft version file asks for. */
function javaMajorFor(version) {
  const m = version?.javaVersion?.majorVersion || COMPONENT_MAJOR[version?.javaVersion?.component] || 8;
  return bucketMajor(m);
}

/** Picks the Java to use: this instance's own > the one chosen for this Java version in Settings > Mojang's runtime. */
async function javaFor(ctx, version, instance, onProgress) {
  const major = javaMajorFor(version);
  const chosen = ctx.settings.get('javaByMajor')?.[major];
  const override = instance?.javaPath || chosen || ctx.settings.get('javaPath'); // javaPath: the old single override, still honoured
  if (override) {
    if (!(await exists(override))) {
      throw new Error(instance?.javaPath || !chosen
        ? `Java not found at ${override}. Pick another one, or clear it to use the automatic Java.`
        : `The Java you chose for Java ${major} is not at ${override} any more. Pick another one in Settings → Java, or set it back to Automatic.`);
    }
    return override;
  }
  const component = version.javaVersion?.component || 'jre-legacy';
  return ensureRuntime(ctx, component, onProgress);
}

module.exports = { ensureRuntime, javaFor, javaExecutable, platformKey, COMPONENT_MAJOR, bucketMajor, javaMajorFor };
