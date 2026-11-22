'use strict';
// Sizes of folders and the cache clean-up for Settings → Downloads & storage.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/** Total size of every file below `dir` (0 when it does not exist). Links are not followed. */
async function dirSize(dir) {
  let total = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch { /* vanished while counting */ } }
    }
  };
  await walk(dir);
  return total;
}

async function cacheInfo(ctx) {
  return { path: ctx.paths.cache, bytes: await dirSize(ctx.paths.cache) };
}

/** Empties the cache folder (it keeps the folder itself). The cache only holds things Junction can download again. */
async function clearCache(ctx) {
  const before = await dirSize(ctx.paths.cache);
  for (const e of await fsp.readdir(ctx.paths.cache).catch(() => [])) {
    await fsp.rm(path.join(ctx.paths.cache, e), { recursive: true, force: true }).catch(() => {});
  }
  return { freed: before - (await dirSize(ctx.paths.cache)) };
}

module.exports = { dirSize, cacheInfo, clearCache };
