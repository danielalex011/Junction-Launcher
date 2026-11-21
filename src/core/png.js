'use strict';
// A small, strict PNG decoder used to check skin files before they are saved or uploaded.
// It verifies the signature, every chunk's CRC and the exact size of the pixel data, and
// refuses anything unusual (interlaced files, oversized pictures, decompression bombs).
const zlib = require('zlib');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const x of buf) c = CRC_TABLE[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

class PngError extends Error {}

/** @returns {{width:number,height:number,rgba:Buffer}} 8-bit RGBA pixels. Throws PngError with a plain sentence. */
function decodePng(buf, { maxSide = 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 45 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new PngError('That file is not a PNG picture.');
  let pos = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (len > buf.length || pos + 12 + len > buf.length) throw new PngError('The PNG file is cut off or damaged.');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len)) throw new PngError('The PNG file is damaged.');
    if (!ihdr && type !== 'IHDR') throw new PngError('That file is not a valid PNG picture.');
    if (type === 'IHDR') {
      if (ihdr || len !== 13) throw new PngError('That file is not a valid PNG picture.');
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], compression: data[10], filter: data[11], interlace: data[12] };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { ended = true; break; }
    pos += 12 + len;
  }
  if (!ihdr || !ended || !idat.length) throw new PngError('The PNG file is cut off or damaged.');
  const { width, height, depth, color } = ihdr;
  if (!width || !height || width > maxSide || height > maxSide) throw new PngError(`That picture is too large (${width}×${height}).`);
  if (!DEPTHS[color]?.includes(depth) || ihdr.compression !== 0 || ihdr.filter !== 0) throw new PngError('That PNG uses a format Junction does not understand.');
  if (ihdr.interlace !== 0) throw new PngError('That PNG is interlaced. Save it again without interlacing (most editors have an "Adam7 interlacing: none" option).');
  if (color === 3 && !plte) throw new PngError('The PNG file is damaged.');

  const bitsPerPixel = CHANNELS[color] * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const expected = (stride + 1) * height;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }); } catch { throw new PngError('The PNG file is damaged.'); }
  if (raw.length !== expected) throw new PngError('The PNG file is damaged.');

  // Undo the per-row filters.
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    if (f > 4) throw new PngError('The PNG file is damaged.');
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = y ? px[dst - stride + i] : 0;
      const c = i >= bpp && y ? px[dst - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + i] = v & 255;
    }
  }

  // Unpack to 8-bit RGBA.
  const rgba = Buffer.alloc(width * height * 4);
  const sample = (row, idx) => { // idx-th sample of the row, scaled to the raw value (not 0-255)
    if (depth === 8) return px[row + idx];
    if (depth === 16) return (px[row + idx * 2] << 8) | px[row + idx * 2 + 1];
    const perByte = 8 / depth;
    const byte = px[row + Math.floor(idx / perByte)];
    return (byte >> (8 - depth * (1 + (idx % perByte)))) & ((1 << depth) - 1);
  };
  const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
  const keyGray = color === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  const keyRgb = color === 2 && trns && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (color === 0) { const g = sample(row, x); rgba[o] = rgba[o + 1] = rgba[o + 2] = to8(g); rgba[o + 3] = g === keyGray ? 0 : 255; }
      else if (color === 2) {
        const r = sample(row, x * 3); const g = sample(row, x * 3 + 1); const b = sample(row, x * 3 + 2);
        rgba[o] = to8(r); rgba[o + 1] = to8(g); rgba[o + 2] = to8(b);
        rgba[o + 3] = keyRgb && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2] ? 0 : 255;
      } else if (color === 3) {
        const i = sample(row, x);
        if (i * 3 + 2 >= plte.length) throw new PngError('The PNG file is damaged.');
        rgba[o] = plte[i * 3]; rgba[o + 1] = plte[i * 3 + 1]; rgba[o + 2] = plte[i * 3 + 2];
        rgba[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (color === 4) { const g = to8(sample(row, x * 2)); rgba[o] = rgba[o + 1] = rgba[o + 2] = g; rgba[o + 3] = to8(sample(row, x * 2 + 1)); }
      else { for (let k = 0; k < 4; k++) rgba[o + k] = to8(sample(row, x * 4 + k)); }
    }
  }
  return { width, height, rgba };
}

module.exports = { decodePng, PngError, PNG_MAGIC, crc32 };
