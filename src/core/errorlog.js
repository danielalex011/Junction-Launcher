'use strict';
// Writes errors from the app window to <data>/logs/window-errors.log so a broken page leaves a trace.
// Plain Node (no electron). Tokens and secrets are hidden before anything touches the disk.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 512 * 1024;
const MAX_LINE = 4000;

/** Hides anything that looks like a sign-in token, key or password. */
function scrub(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (typeof s === 'string' && s.length >= 8) out = out.split(s).join('[hidden]'); // the exact values in use (sign-in app ID, CurseForge key)
  return out
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [hidden]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, '[hidden]')
    .replace(/((?:access|refresh|id|api|auth)?[_-]?(?:token|secret|password|passwd|key|code|authorization|xsts|uhs)["']?\s*[:=]\s*["']?)[^\s"'&,;}]{4,}/gi, '$1[hidden]')
    .replace(/\b[A-Za-z0-9+/_-]{60,}={0,2}/g, '[hidden]')
    .replace(/\$2[aby]\$\d\d\$[./A-Za-z0-9]{50,}/g, '[hidden]');
}

class ErrorLog {
  constructor(dir, { secrets = () => [] } = {}) {
    this.secrets = secrets;
    this.file = path.join(dir, 'logs', 'window-errors.log');
  }

  /** Appends one entry. Never throws: logging must not cause problems of its own. */
  write(kind, message, where) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try {
        if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.old`);
      } catch { /* no file yet */ }
      let line = scrub(`${new Date().toISOString()} [${kind}] ${String(message).replace(/\s*\n\s*/g, ' | ')}${where ? ` (${where})` : ''}`, this.secrets());
      if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}…`;
      fs.appendFileSync(this.file, `${line}\n`);
      return true;
    } catch { return false; }
  }
}

module.exports = { ErrorLog, scrub };
