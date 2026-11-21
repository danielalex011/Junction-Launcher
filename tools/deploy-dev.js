'use strict';
// Fast dev deploy (Windows): build the unpacked app once, put it in the maintainer's
// dev folder, and refresh the "Junction" shortcut on the desktop.
//
//   npm run deploy:dev
//
// Target folder: JUNCTION_DEV_DIR, or <home>\Documents\Junction-Launcher developer.
// Not part of the app. It never kills a running Junction: it stops and says so.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST_UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const LOCK = path.join(os.tmpdir(), 'junction-deploy-dev.lock');
const VERSION = require('../package.json').version;

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exitCode = 1;
  throw Object.assign(new Error(msg), { handled: true });
}

const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
const isInside = (child, parent) => norm(child) === norm(parent) || norm(child).startsWith(norm(parent) + path.sep);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a PowerShell snippet; values go in through the environment, never into the script text. */
function powershell(script, env = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `PowerShell exited with ${r.status}`).trim());
  return r.stdout.trim();
}

function jsonList(text) {
  if (!text) return [];
  const v = JSON.parse(text);
  return Array.isArray(v) ? v : [v];
}

function targetDir() {
  return path.resolve(process.env.JUNCTION_DEV_DIR || path.join(os.homedir(), 'Documents', 'Junction-Launcher developer'));
}

/** Refuse folders that are clearly not a place to wipe. */
function checkTargetIsSafe(target) {
  const home = os.homedir();
  const protectedDirs = [path.parse(target).root, home, path.join(home, 'Documents'), path.join(home, 'Desktop'), ROOT, path.dirname(ROOT)];
  if (protectedDirs.some((d) => norm(d) === norm(target))) fail(`Refusing to use ${target} as the dev folder: it is too important to wipe. Set JUNCTION_DEV_DIR to a folder just for the build.`);
  if (isInside(ROOT, target) || isInside(target, ROOT)) fail(`The dev folder can't be inside the project (or contain it): ${target}`);
  if (!fs.existsSync(target)) return;
  const entries = fs.readdirSync(target);
  if (entries.length && !fs.existsSync(path.join(target, 'Junction.exe'))) {
    fail(`${target} isn't empty and doesn't contain Junction.exe, so it doesn't look like a previous Junction build. I won't wipe it.\nPick an empty folder (JUNCTION_DEV_DIR) or clear it yourself.`);
  }
}

/** Is a Junction.exe from the dev folder (or from dist) running? */
function runningJunction(target) {
  const out = powershell("Get-CimInstance Win32_Process -Filter \"Name='Junction.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress");
  return jsonList(out).filter((p) => p.ExecutablePath && (isInside(p.ExecutablePath, target) || isInside(p.ExecutablePath, DIST_UNPACKED)));
}

/** Is an electron-builder for this project already running (from anywhere)? */
function runningBuilds() {
  const out = powershell("Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*electron-builder*' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress");
  const root = ROOT.toLowerCase();
  return jsonList(out).filter((p) => String(p.CommandLine).toLowerCase().includes(root));
}

function acquireLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); fail(`Another deploy:dev is already running (process ${pid}). Wait for it to finish.`); } catch (e) { if (e.handled) throw e; /* stale lock */ }
    }
  } catch (e) { if (e.handled) throw e; /* no lock yet */ }
  fs.writeFileSync(LOCK, String(process.pid));
}
const releaseLock = () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK, { force: true }); } catch { /* gone already */ } };

/** fs.rm that survives Windows briefly holding files (antivirus, indexer, Explorer). */
async function removeWithRetries(p, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      return;
    } catch (e) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(e.code) || i === attempts) {
        fail(`Couldn't delete ${e.path || p} (${e.code || e.message}). Windows has it locked, usually a program with that folder open.\nClose anything using it (Explorer windows, a running Junction) and run npm run deploy:dev again.`);
      }
      console.log(`  ${e.code} on ${path.basename(e.path || p)}, retrying (${i}/${attempts - 1})…`);
      await sleep(2000 * i);
    }
  }
}

function build() {
  let cli;
  try { cli = require.resolve('electron-builder/cli.js', { paths: [ROOT] }); } catch { fail('electron-builder isn\'t installed. Run npm install first.'); }
  return new Promise((resolve, reject) => {
    // One build, directly through node: no shell, no zip, no installer.
    const child = spawn(process.execPath, [cli, '--win', '--dir'], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`electron-builder exited with code ${code}`))));
  });
}

function refreshShortcut(exe) {
  return powershell([
    '$desktop = [Environment]::GetFolderPath("Desktop")',
    '$lnk = Join-Path $desktop "Junction.lnk"',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)',
    '$s.TargetPath = $env:JD_EXE',
    '$s.WorkingDirectory = Split-Path $env:JD_EXE',
    '$s.IconLocation = "$($env:JD_EXE),0"',
    '$s.Description = "Junction (dev build)"',
    '$s.Save()',
    '$lnk',
  ].join('; '), { JD_EXE: exe });
}

async function main() {
  if (process.platform !== 'win32') fail('deploy:dev is for Windows only.');
  const target = targetDir();
  console.log(`Junction ${VERSION} -> ${target}`);
  checkTargetIsSafe(target);

  const running = runningJunction(target);
  if (running.length) {
    fail(`Junction is running (process ${running.map((p) => p.ProcessId).join(', ')}). Close Junction first, then run npm run deploy:dev again.\nI never close it for you.`);
  }
  const builds = runningBuilds();
  if (builds.length) {
    fail(`A build is already running (process ${builds.map((p) => p.ProcessId).join(', ')}). Wait for it to finish; starting a second one makes Windows lock the output folder.`);
  }
  acquireLock();

  console.log('\nCleaning dist\\win-unpacked…');
  await removeWithRetries(DIST_UNPACKED);

  console.log('\nBuilding (electron-builder --win --dir)…\n');
  await build();
  const builtExe = path.join(DIST_UNPACKED, 'Junction.exe');
  if (!fs.existsSync(builtExe)) fail(`The build finished but ${builtExe} is missing.`);

  // Re-check: someone may have started Junction while the build ran.
  const again = runningJunction(target);
  if (again.length) fail(`Junction was started while building (process ${again.map((p) => p.ProcessId).join(', ')}). Close it and run npm run deploy:dev again; the new build is ready in dist\\win-unpacked.`);

  console.log(`\nReplacing the contents of ${target}…`);
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(target)) await removeWithRetries(path.join(target, name));
  fs.cpSync(DIST_UNPACKED, target, { recursive: true });
  const exe = path.join(target, 'Junction.exe');
  if (!fs.existsSync(exe)) fail(`Copy finished but ${exe} is missing.`);

  const lnk = refreshShortcut(exe);
  console.log(`\nDeployed Junction ${VERSION}`);
  console.log(`  folder:   ${target}`);
  console.log(`  shortcut: ${lnk}`);
}

process.on('exit', releaseLock);
main().catch((e) => {
  if (!e.handled) { console.error(`\nDeploy failed: ${e.message}\n`); process.exitCode = 1; }
});
