'use strict';
// Player heads for accounts. The Minecraft profile lists the skin on Mojang's own texture server;
// we download that one PNG and the main process crops the face out of it.
const fs = require('fs');
const path = require('path');

const SKIN_HOST = 'textures.minecraft.net';
const MAX_SKIN_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The URL of the active skin in a /minecraft/profile response, or null if it isn't on Mojang's texture server. */
function skinUrlOf(profile) {
  const skins = Array.isArray(profile?.skins) ? profile.skins : [];
  const skin = skins.find((s) => s && s.state === 'ACTIVE') || skins[0];
  try {
    const u = new URL(String(skin?.url || ''));
    return u.protocol === 'https:' && u.hostname === SKIN_HOST ? u.toString() : null;
  } catch { return null; }
}

/** Downloads a skin PNG to dest (checked: texture host, PNG signature, sane size). */
async function downloadSkin(ctx, url, dest) {
  if (skinUrlOf({ skins: [{ url }] }) === null) throw new Error('Not a Mojang skin address');
  const res = await ctx.http.request(url, { retries: 1, timeout: 15000 });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_SKIN_BYTES || buf.length < PNG_MAGIC.length || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('That is not a skin picture');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

/**
 * Takes the face (8x8 at 8,8) and the hat layer (8x8 at 40,8) out of a decoded skin and returns
 * them stacked and enlarged. `px` is 4 bytes per pixel with alpha in byte 3; the other three bytes
 * are copied as they are, so the channel order doesn't matter. HD skins (128 px wide and so on) work too.
 */
function composeHead(px, width, height, scale = 8) {
  if (!(width >= 64) || !(height >= 32) || px.length < width * height * 4) throw new Error('Unexpected skin size');
  const u = Math.floor(width / 64);
  const out = Buffer.alloc(8 * scale * 8 * scale * 4);
  const at = (x, y) => (y * width + x) * 4;
  for (let fy = 0; fy < 8; fy++) {
    for (let fx = 0; fx < 8; fx++) {
      const face = at((8 + fx) * u, (8 + fy) * u);
      const hat = at((40 + fx) * u, (8 + fy) * u);
      const a = px[hat + 3] / 255;
      const c = [0, 1, 2].map((k) => Math.round(px[hat + k] * a + px[face + k] * (1 - a)));
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const o = ((fy * scale + sy) * 8 * scale + fx * scale + sx) * 4;
          out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
        }
      }
    }
  }
  return out;
}

module.exports = { skinUrlOf, downloadSkin, composeHead, SKIN_HOST };
