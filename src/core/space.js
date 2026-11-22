'use strict';
// Free disk space: how much room the drive holding Junction's data folder has, and whether an install would squeeze it too hard.
const fsp = require('fs').promises;
const { formatBytes } = require('./util');

const GB = 1024 ** 3;
const MIN_FREE_BYTES = 5 * GB; // warn when an install would leave less than this...
const MIN_FREE_PERCENT = 10; //   ...or less than this share of the drive

/** { free, total } in bytes for the drive that holds `dir`. null when the system can't say. */
async function diskSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    const total = Number(s.blocks) * Number(s.bsize);
    return total > 0 ? { free, total } : null;
  } catch { return null; }
}

/**
 * What would be left after `needed` more bytes are written.
 * { free, total, needed, after, percentAfter, low, notEnough, message }
 */
function assessSpace({ free, total, needed = 0 }) {
  const after = free - needed;
  const percentAfter = total > 0 ? (after / total) * 100 : 100;
  const notEnough = after < 0;
  const low = after < MIN_FREE_BYTES || percentAfter < MIN_FREE_PERCENT;
  const pct = `${Math.max(0, percentAfter).toFixed(percentAfter < 10 ? 1 : 0)}%`;
  const message = notEnough
    ? `This needs about ${formatBytes(needed)} but only ${formatBytes(free)} is free on the drive.`
    : `This needs about ${formatBytes(needed)}. ${formatBytes(free)} of ${formatBytes(total)} is free now, so only ${formatBytes(Math.max(0, after))} (${pct}) would be left.`;
  return { free, total, needed, after, percentAfter, low, notEnough, message };
}

/** Space check for installing `needed` bytes into the data folder. null when it can't be checked. */
async function checkSpace(ctx, needed) {
  const d = await diskSpace(ctx.root);
  return d ? assessSpace({ ...d, needed }) : null;
}

module.exports = { diskSpace, assessSpace, checkSpace, MIN_FREE_BYTES, MIN_FREE_PERCENT };
