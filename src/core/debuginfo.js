'use strict';
// The text behind "Copy debug info" in Settings → About: what someone needs to help with a problem.
// It never contains tokens, API keys, account names or e-mail addresses; the user's folder name is replaced by %USERPROFILE%.
const os = require('os');
const gbText = (mb) => `${Math.round((Number(mb) / 1024) * 100) / 100} GB`;

/** Replaces the home folder in a path, so the Windows user name is not shared by accident. */
function scrubPath(p, home = os.homedir()) {
  if (!p) return '';
  const s = String(p);
  if (home && s.toLowerCase().startsWith(home.toLowerCase())) return `%USERPROFILE%${s.slice(home.length)}`;
  return s;
}

/**
 * @param {{ version: string, settings: object, javas: Array, runtimes: Array, instanceCount: number, electron?: string, node?: string, home?: string }} d
 *   `settings` is the page's view of the settings (it never has secret values).
 */
function buildDebugInfo(d) {
  const s = d.settings || {};
  const home = d.home || os.homedir();
  const lines = [
    `Junction ${d.version}`,
    `Windows/OS: ${os.type()} ${os.release()} (${os.arch()}), version ${os.version?.() || 'unknown'}`,
    `Electron ${d.electron || '?'}, Node ${d.node || '?'}`,
    `RAM: ${gbText(Math.floor(os.totalmem() / 1024 / 1024))} total`,
    `Instances: ${d.instanceCount ?? '?'}`,
    '',
    'Settings',
    `  Memory default: max ${gbText(s.memoryMax)}, min ${gbText(s.memoryMin)}`,
    `  Parallel downloads: ${s.concurrency}, speed limit: ${s.speedLimitMBps ? `${s.speedLimitMBps} MB/s` : 'none'}`,
    `  Update backups kept: ${s.backupsKept}, update channel: ${s.updateChannel}`,
    `  Global JVM arguments: ${s.jvmArgs ? 'set' : 'none'}`,
    `  Java per version: ${Object.entries(s.javaByMajor || {}).map(([k, v]) => `${k} = ${scrubPath(v, home)}`).join('; ') || 'all automatic'}`,
    `  On game start: ${s.onLaunch}, start page: ${s.startPage}`,
    '',
    "Junction's Java",
    ...(d.runtimes || []).map((r) => `  Java ${r.major}: ${r.installed ? `${r.version || 'installed'}` : 'not downloaded yet'}`),
    '',
    'Other Java on this PC',
    ...((d.javas || []).length
      ? d.javas.map((j) => `  ${j.version || 'version unknown'}, ${j.vendor}, ${scrubPath(j.path, home)} (${j.source})`)
      : ['  none found']),
  ];
  return lines.join('\n');
}

module.exports = { buildDebugInfo, scrubPath };
