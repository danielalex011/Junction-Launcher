'use strict';
// Finds Java installs that are already on this PC (PATH, JAVA_HOME, Program Files, user folders) and can test one.
// Finding only looks at folders and reads each install's small `release` text file. Nothing is run while searching:
// a Java is only started when the user presses Test, and then only with `-version`.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const VENDOR_FOLDERS = ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto'];
const USER_FOLDERS = [['.jdks'], ['.jabba', 'jdk'], ['Java']]; // GraalVM is often unpacked into %USERPROFILE%\Java

const exeName = (platform) => (platform === 'win32' ? 'java.exe' : 'java');
const isFile = async (p) => { try { return (await fsp.stat(p)).isFile(); } catch { return false; } };
const isDir = async (p) => { try { return (await fsp.stat(p)).isDirectory(); } catch { return false; } };
const readDir = async (p) => { try { return await fsp.readdir(p, { withFileTypes: true }); } catch { return []; } };

/** "1.8.0_292" -> 8, "17.0.9" -> 17, "21" -> 21, "25-ea" -> 25. null when it is not a version. */
function majorOf(version) {
  const m = /^(\d+)(?:\.(\d+))?/.exec(String(version || '').trim());
  if (!m) return null;
  const first = Number(m[1]);
  if (first === 1 && m[2]) return Number(m[2]);
  return first || null;
}

/** Reads the KEY="value" lines of a JDK's `release` file. */
function parseRelease(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(?:"([^"]*)"|(.*))$/.exec(line.trim());
    if (m) out[m[1]] = (m[2] ?? m[3] ?? '').trim();
  }
  return out;
}

/** A readable vendor name. GraalVM is checked first: its `release` file often says "Oracle Corporation". */
function vendorOf({ implementor = '', graalvm = '', hint = '' } = {}) {
  const all = `${implementor} ${hint}`;
  if (graalvm || /graal/i.test(all)) return 'GraalVM';
  if (/adoptium|temurin|adoptopenjdk|eclipse foundation/i.test(all)) return 'Eclipse Adoptium';
  if (/microsoft/i.test(all)) return 'Microsoft';
  if (/azul|zulu/i.test(all)) return 'Azul Zulu';
  if (/bellsoft|liberica/i.test(all)) return 'BellSoft Liberica';
  if (/amazon|corretto/i.test(all)) return 'Amazon Corretto';
  if (/semeru|\bibm\b/i.test(all)) return 'IBM Semeru';
  if (/jetbrains/i.test(all)) return 'JetBrains';
  if (/oracle/i.test(all)) return 'Oracle';
  if (/openjdk/i.test(all)) return 'OpenJDK';
  return implementor.trim() || 'Unknown vendor';
}

/** Describes one Java home (the folder that has bin/java). Returns null when it isn't one. */
async function describeHome(home, platform, source) {
  const bin = path.join(home, 'bin');
  const exe = path.join(bin, exeName(platform));
  if (!(await isFile(exe))) return null;
  const gui = platform === 'win32' ? path.join(bin, 'javaw.exe') : exe;
  const rel = parseRelease(await fsp.readFile(path.join(home, 'release'), 'utf8').catch(() => ''));
  const name = path.basename(home);
  let version = rel.JAVA_VERSION || '';
  let versionFrom = version ? 'release' : null;
  if (!version) { // very old installs have no release file: the folder name usually has the number
    const m = /(?:jdk|jre|java|openjdk|graalvm[^\d]*)[-_ ]?(1\.\d+(?:\.\d+)?(?:_\d+)?|\d+(?:\.\d+){0,3})/i.exec(name) || /(\d+(?:\.\d+){0,3})/.exec(name);
    if (m) { version = m[1]; versionFrom = 'folder'; }
  }
  return {
    home, path: exe, launchPath: (await isFile(gui)) ? gui : exe,
    version: version || null, major: majorOf(version), versionFrom,
    vendor: vendorOf({ implementor: rel.IMPLEMENTOR || '', graalvm: rel.GRAALVM_VERSION || '', hint: `${name} ${home}` }),
    source,
  };
}

/** A folder like "jdk-21.0.1" is a Java home; a folder holding one more folder (a fresh unzip) counts too. */
async function homesIn(dir, platform) {
  const out = [];
  for (const e of await readDir(dir)) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const child = path.join(dir, e.name);
    if (await isFile(path.join(child, 'bin', exeName(platform)))) { out.push(child); continue; }
    if (platform === 'darwin' && (await isFile(path.join(child, 'Contents', 'Home', 'bin', 'java')))) { out.push(path.join(child, 'Contents', 'Home')); continue; }
    const inner = (await readDir(child)).filter((x) => x.isDirectory());
    if (inner.length === 1 && (await isFile(path.join(child, inner[0].name, 'bin', exeName(platform))))) out.push(path.join(child, inner[0].name));
  }
  return out;
}

/**
 * Looks for Java installs. Everything that depends on this PC can be passed in, so the tests use fake folders.
 * @returns {Promise<Array<{home, path, launchPath, version, major, versionFrom, vendor, source}>>}
 */
async function findJavas({ env = process.env, platform = process.platform, home = os.homedir(), programRoots, extraRoots = [] } = {}) {
  const found = []; // [home, source]
  const add = (h, source) => { if (h) found.push([h, source]); };

  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH || env.Path || '').split(sep).map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    if (await isFile(path.join(dir, exeName(platform)))) add(path.dirname(dir), 'PATH');
  }
  if (env.JAVA_HOME) add(env.JAVA_HOME.replace(/^"|"$/g, ''), 'JAVA_HOME');

  const pf = programRoots || [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  if (platform === 'win32') {
    for (const root of new Set(pf)) for (const v of VENDOR_FOLDERS) for (const h of await homesIn(path.join(root, v), platform)) add(h, 'Program Files');
  } else if (platform === 'darwin') {
    for (const h of await homesIn('/Library/Java/JavaVirtualMachines', platform)) add(h, 'System');
  } else {
    for (const h of await homesIn('/usr/lib/jvm', platform)) add(h, 'System');
  }
  for (const parts of USER_FOLDERS) for (const h of await homesIn(path.join(home, ...parts), platform)) add(h, 'Your user folder');
  for (const dir of extraRoots) for (const h of await homesIn(dir, platform)) add(h, 'Other folder');

  const seen = new Set();
  const out = [];
  for (const [h, source] of found) {
    const info = await describeHome(h, platform, source);
    if (!info) continue;
    let key = info.path;
    try { key = await fsp.realpath(info.path); } catch { /* keep the plain path */ }
    if (platform === 'win32') key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(info);
  }
  return out.sort((a, b) => (b.major || 0) - (a.major || 0) || a.vendor.localeCompare(b.vendor) || a.path.localeCompare(b.path));
}

/**
 * Starts `java -version` (nothing else) with a time limit. Only a file called java / javaw is ever started.
 * @returns {Promise<{ok: true, version: string|null, major: number|null, summary: string} | {ok: false, error: string}>}
 */
async function testJava(file, { timeoutMs = 8000, execFileImpl = execFile } = {}) {
  const p = String(file || '');
  if (!/^javaw?(\.exe)?$/i.test(path.basename(p))) return { ok: false, error: 'That file is not called java or javaw, so Junction will not run it.' };
  let exe = p;
  if (/^javaw(\.exe)?$/i.test(path.basename(p))) { // javaw has no console, so it prints nothing: ask its java.exe twin
    const twin = path.join(path.dirname(p), path.basename(p).replace(/javaw/i, 'java'));
    if (await isFile(twin)) exe = twin;
  }
  if (!(await isFile(exe))) return { ok: false, error: 'The file is not there any more.' };
  return new Promise((resolve) => {
    execFileImpl(exe, ['-version'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err && (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT')) return resolve({ ok: false, error: `It did not answer within ${Math.round(timeoutMs / 1000)} seconds.` });
      const text = `${stderr || ''}\n${stdout || ''}`;
      const m = /(?:java|openjdk|jdk)\s+version\s+"([^"]+)"/i.exec(text);
      if (err || !m) return resolve({ ok: false, error: err?.code === 'ENOENT' ? 'The file is not there any more.' : 'This does not look like a working Java.' });
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2);
      resolve({ ok: true, version: m[1], major: majorOf(m[1]), summary: lines.join(' · ').slice(0, 220) });
    });
  });
}

module.exports = { findJavas, testJava, majorOf, parseRelease, vendorOf, describeHome, exeName };
