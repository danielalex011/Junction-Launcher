'use strict';
// CurseForge identifies files by a MurmurHash2 (seed 1) of the file with all
// whitespace bytes (tab, LF, CR, space) removed. Used to recognise jars that
// were dropped into an instance by hand or imported from another launcher.
const fsp = require('fs').promises;

function murmur2(data, seed = 1) {
  const m = 0x5bd1e995;
  let len = data.length;
  let h = (seed ^ len) >>> 0;
  let i = 0;
  while (len >= 4) {
    let k = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    k ^= k >>> 24;
    k = Math.imul(k, m) >>> 0;
    h = (Math.imul(h, m) ^ k) >>> 0;
    i += 4;
    len -= 4;
  }
  switch (len) {
    case 3: h ^= data[i + 2] << 16; // falls through
    case 2: h ^= data[i + 1] << 8; // falls through
    case 1: h ^= data[i]; h = Math.imul(h, m) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, m) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

function normalize(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b !== 9 && b !== 10 && b !== 13 && b !== 32) out[j++] = b;
  }
  return out.subarray(0, j);
}

function curseFingerprint(buf) {
  return murmur2(normalize(buf), 1);
}

async function curseFingerprintFile(p) {
  return curseFingerprint(await fsp.readFile(p));
}

module.exports = { murmur2, curseFingerprint, curseFingerprintFile };
