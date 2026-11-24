'use strict';
// Turns an instance into a running Minecraft process.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { resolveVersion } = require('./versions');
const { installVersion, clientJarPath, prepareLegacyAssets } = require('./install');
const { javaFor } = require('./java');
const { evaluateArgs, substitute, rulesAllow } = require('./rules');
const { makeRedactor, createGameLogReader } = require('./gamelog');
const { installLoader } = require('../loaders');
const { exists, ensureDir, splitArgs } = require('../util');

const VERSION = require('../../../package.json').version;

async function prepareInstance(ctx, inst, report = () => {}) {
  const mc = inst.mcVersion;
  report(0.01, 'Checking loader');
  let versionId = await installLoader(ctx, inst.loader || { type: 'vanilla' }, mc, (p, d) => report(p * 0.25, d));
  let version = await resolveVersion(ctx, versionId);
  const java = await javaFor(ctx, version, inst, (p, d) => report(0.25 + p * 0.25, d));
  let files;
  try {
    files = await installVersion(ctx, version, (p, d) => report(0.5 + p * 0.5, d));
  } catch (e) {
    if (e.code !== 'LOADER_MISSING') throw e;
    // Forge/NeoForge generated files went missing: rerun the installer once.
    await fsp.rm(path.join(ctx.paths.versions, versionId, '.junction-installed'), { force: true });
    await fsp.rm(path.join(ctx.paths.versions, versionId, `${versionId}.json`), { force: true });
    versionId = await installLoader(ctx, inst.loader, mc, (p, d) => report(p * 0.25, d));
    version = await resolveVersion(ctx, versionId);
    files = await installVersion(ctx, version, (p, d) => report(0.5 + p * 0.5, d));
  }
  // Loader versions inherit the vanilla jar. Name a copy after the loader version,
  // because Forge/NeoForge's module system ignores "${version_name}.jar" by name.
  let clientJar = files.clientJar;
  if (version.id !== version._clientJarId) {
    const own = clientJarPath(ctx, version.id);
    if (!(await exists(own))) {
      await ensureDir(path.dirname(own));
      await fsp.copyFile(files.clientJar, own);
    }
    clientJar = own;
  }
  return { version, java, files: { ...files, clientJar }, versionId };
}

function supportsQuickPlay(version) {
  return (version.arguments?.game || []).some((a) => typeof a === 'object' && a.rules?.some((r) => r.features?.is_quick_play_multiplayer));
}

function buildLaunchArgs(ctx, inst, prepared, creds, gameDir, assetsDir) {
  const { version, files } = prepared;
  const sep = process.platform === 'win32' ? ';' : ':';
  const classpath = [...files.libraries, files.clientJar];
  const width = Number(inst.resolution?.width) || 0;
  const height = Number(inst.resolution?.height) || 0;
  const server = String(inst.joinServer || '').trim();
  const quickPlay = Boolean(server) && supportsQuickPlay(version);

  const vars = {
    auth_player_name: creds.name,
    version_name: version.id,
    game_directory: gameDir,
    assets_root: ctx.paths.assets,
    game_assets: assetsDir,
    assets_index_name: version.assetIndex?.id || version.assets || 'legacy',
    auth_uuid: creds.uuid,
    auth_access_token: creds.accessToken,
    auth_session: creds.offline ? '-' : `token:${creds.accessToken}:${creds.uuid}`,
    auth_xuid: creds.xuid || '0',
    clientid: ctx.settings.get('msClientId') || '0',
    user_type: creds.userType,
    user_properties: '{}',
    version_type: version.type || 'release',
    natives_directory: files.nativesDir,
    launcher_name: 'junction',
    launcher_version: VERSION,
    classpath: classpath.join(sep),
    classpath_separator: sep,
    library_directory: ctx.paths.libraries,
    resolution_width: width || 854,
    resolution_height: height || 480,
    quickPlayMultiplayer: server,
  };
  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(width && height),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: quickPlay,
    is_quick_play_realms: false,
  };

  let jvm;
  if (version.arguments?.jvm?.length) {
    jvm = evaluateArgs(version.arguments.jvm, vars, features);
  } else {
    jvm = [
      `-Djava.library.path=${files.nativesDir}`,
      `-Dminecraft.launcher.brand=junction`,
      `-Dminecraft.launcher.version=${VERSION}`,
      '-cp', vars.classpath,
    ];
    if (process.platform === 'darwin') jvm.unshift('-XstartOnFirstThread');
  }
  const memMax = Number(inst.memoryMax) || ctx.settings.get('memoryMax');
  const memMin = Math.min(memMax, Number(inst.memoryMin) || ctx.settings.get('memoryMin'));
  const custom = [
    `-Xms${memMin}M`, `-Xmx${memMax}M`,
    ...splitArgs(ctx.settings.get('jvmArgs')),
    ...splitArgs(inst.jvmArgs),
  ];
  const logging = version.logging?.client?.argument && files.loggingFile
    ? [substitute(version.logging.client.argument, { path: files.loggingFile })]
    : [];

  let game;
  if (version.arguments?.game?.length) {
    game = evaluateArgs(version.arguments.game, vars, features);
  } else {
    game = splitArgs(version.minecraftArguments || '').map((a) => substitute(a, vars));
    if (width && height) game.push('--width', String(width), '--height', String(height));
  }
  if (server && !quickPlay) {
    const [host, port] = server.split(':');
    game.push('--server', host, '--port', port || '25565');
  }
  return [...jvm, ...custom, ...logging, version.mainClass, ...game];
}

async function launch(ctx, inst, prepared, creds, { gameDir, onLog = () => {}, onExit = () => {} }) {
  await ensureDir(gameDir);
  const assetsDir = await prepareLegacyAssets(ctx, prepared.files.assets, gameDir);
  const args = buildLaunchArgs(ctx, inst, prepared, creds, gameDir, assetsDir);
  // Never shown, not even in the Logs tab people copy into bug reports: the access token, the sign-in app ID, the Xbox user ID.
  const hide = makeRedactor([[creds.accessToken, '<access token>'], [ctx.settings.get('msClientId'), '<client id>'], [creds.xuid, '<xuid>']]);
  onLog(`[Junction] Java: ${prepared.java}`);
  onLog(`[Junction] Launching ${prepared.version.id} as ${creds.name}${creds.offline ? ' (offline)' : ''}`);
  onLog(hide(`[Junction] Arguments: ${args.join(' ')}`));
  const started = Date.now();
  const child = spawn(prepared.java, args, { cwd: gameDir, windowsHide: false, env: { ...process.env } });
  const pipe = (stream) => {
    let buf = '';
    const reader = createGameLogReader(onLog, hide); // log4j XML -> readable lines, secrets hidden (also the last, unfinished line)
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) reader.push(l);
    });
    stream.on('end', () => { if (buf) reader.push(buf); buf = ''; reader.end(); });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('error', (e) => onLog(`[Junction] Failed to start Java: ${e.message}`));
  child.on('close', async (code) => {
    let crashReport = null;
    if (code !== 0) {
      try {
        const dir = path.join(gameDir, 'crash-reports');
        const files = (await fsp.readdir(dir)).map((f) => path.join(dir, f));
        const stats = await Promise.all(files.map(async (f) => ({ f, t: (await fsp.stat(f)).mtimeMs })));
        const newest = stats.filter((s) => s.t >= started).sort((a, b) => b.t - a.t)[0];
        crashReport = newest?.f || null;
      } catch { /* no crash report */ }
    }
    onExit({ code, crashReport, playedMs: Date.now() - started });
  });
  return child;
}

module.exports = { prepareInstance, buildLaunchArgs, launch, supportsQuickPlay };
// rulesAllow re-exported for tests
module.exports.rulesAllow = rulesAllow;
