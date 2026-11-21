'use strict';
// Mojang's skin, cape and player-lookup services for the mock network (tools/mock-network.js).
// A demo profile with a skin and two capes; uploads, reset and cape changes really change it, and after
// three uploads in a row the "skin service" answers 429 for a while, like the real rate limit.
const crypto = require('crypto');
const { makePng } = require('../test/helpers');

const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
const TEX = 'https://textures.minecraft.net/texture/';

/** A small, readable character skin. `slim` leaves the unused arm columns empty, like a real Alex skin. */
function mockSkin({ skin = [198, 134, 96], hair = [92, 58, 30], shirt = [70, 130, 190], pants = [60, 60, 110], shoes = [50, 50, 50], slim = false } = {}) {
  const rgb = (c, a = 255) => [c[0], c[1], c[2], a];
  const inBox = (x, y, [x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1;
  return makePng(64, 64, (x, y) => {
    if (slim && [[50, 16, 52, 20], [54, 20, 56, 32], [42, 48, 44, 52], [46, 52, 48, 64]].some((b) => inBox(x, y, b))) return [0, 0, 0, 0];
    if (inBox(x, y, [0, 0, 32, 16])) { // head
      if (inBox(x, y, [8, 8, 16, 16])) { // face
        if (y === 11 && (x === 10 || x === 13)) return [255, 255, 255, 255];
        if (y === 12 && (x === 10 || x === 13)) return [50, 70, 170, 255];
        if (y === 14 && x >= 11 && x <= 12) return [150, 80, 70, 255];
        if (y < 10) return rgb(hair);
        return rgb(skin);
      }
      if (y < 8 || x >= 24 || y < 10) return rgb(hair);
      return rgb(skin);
    }
    if (inBox(x, y, [32, 0, 64, 16])) return [0, 0, 0, 0]; // hat layer: empty
    if (inBox(x, y, [16, 16, 40, 32])) return rgb(shirt); // body
    if (inBox(x, y, [40, 16, 56, 32]) || inBox(x, y, [32, 48, 48, 64])) { // arms: sleeve on the upper part, skin below
      return (y % 16) < 6 || (y >= 48 && y % 16 < 6) ? rgb(shirt) : rgb(skin);
    }
    if (inBox(x, y, [0, 16, 16, 32]) || inBox(x, y, [16, 48, 32, 64])) return (y % 16) > 12 ? rgb(shoes) : rgb(pants); // legs
    return [0, 0, 0, 0];
  });
}

/** A 64x32 cape: a coloured front panel with a stripe, a darker back. */
function mockCape(main, stripe) {
  return makePng(64, 32, (x, y) => {
    if (x >= 1 && x < 11 && y >= 1 && y < 17) return (y >= 7 && y <= 9) ? [...stripe, 255] : [...main, 255];
    if (x >= 12 && x < 22 && y >= 1 && y < 17) return [main[0] >> 1, main[1] >> 1, main[2] >> 1, 255];
    if (x < 22 && y < 17) return [main[0] >> 2, main[1] >> 2, main[2] >> 2, 255];
    return [0, 0, 0, 0];
  });
}

const textures = {
  'demo-skin': mockSkin(),
  'player-alexa': mockSkin({ skin: [235, 190, 160], hair: [200, 120, 40], shirt: [190, 70, 110], pants: [50, 50, 70], slim: true }),
  'player-builder': mockSkin({ skin: [160, 110, 80], hair: [40, 30, 25], shirt: [230, 170, 50], pants: [70, 90, 60] }),
  'cape-migrator': mockCape([150, 40, 50], [235, 200, 70]),
  'cape-vanilla': mockCape([40, 90, 170], [230, 230, 240]),
  'cape-pan': mockCape([30, 120, 90], [240, 130, 170]),
};
const PLAYERS = {
  Alexa: { id: '11111111111111111111111111111111', skin: 'player-alexa', model: 'slim' },
  Builder: { id: '22222222222222222222222222222222', skin: 'player-builder' },
  Ghost: { id: '33333333333333333333333333333333', skin: null },
};

const fresh = () => ({
  skin: { id: 'skin-1', url: `${TEX}demo-skin`, variant: 'CLASSIC' }, activeCape: 'a1b2c3d4-0001-4000-8000-000000000001', uploads: [],
  capes: [
    { id: 'a1b2c3d4-0001-4000-8000-000000000001', alias: 'Migrator', url: `${TEX}cape-migrator` },
    { id: 'a1b2c3d4-0002-4000-8000-000000000002', alias: 'Vanilla', url: `${TEX}cape-vanilla` },
    { id: 'a1b2c3d4-0003-4000-8000-000000000003', alias: 'Pan', url: `${TEX}cape-pan` },
  ],
});
const state = fresh();
const reset = () => Object.assign(state, fresh());

const profile = () => ({
  id: 'demo', name: 'DemoPlayer',
  skins: state.skin ? [{ id: state.skin.id, state: 'ACTIVE', url: state.skin.url, variant: state.skin.variant }] : [],
  capes: state.capes.map((c) => ({ id: c.id, state: c.id === state.activeCape ? 'ACTIVE' : 'INACTIVE', url: c.url, alias: c.alias })),
});

async function handle(url, opts = {}) {
  const u = new URL(url);
  const method = (opts.method || 'GET').toUpperCase();
  const tex = u.hostname === 'textures.minecraft.net' ? u.pathname.replace('/texture/', '') : null;
  if (tex !== null) return textures[tex] ? new Response(textures[tex], { headers: { 'content-type': 'image/png' } }) : new Response('not found', { status: 404 });

  if (u.hostname === 'api.minecraftservices.com' && u.pathname.startsWith('/minecraft/profile')) {
    const auth = opts.headers?.Authorization || opts.headers?.authorization || '';
    if (!/^Bearer \S+/.test(auth)) return new Response('', { status: 401 });
    if (u.pathname === '/minecraft/profile' && method === 'GET') return json(profile());
    if (u.pathname === '/minecraft/profile/skins' && method === 'POST') {
      const now = Date.now();
      state.uploads = state.uploads.filter((t) => now - t < 90000);
      if (state.uploads.length >= 3) return json({ path: '/minecraft/profile/skins', errorType: 'TOO_MANY_REQUESTS' }, 429, { 'retry-after': '90' });
      const form = opts.body;
      const variant = form?.get?.('variant');
      const file = form?.get?.('file');
      if (!file || !['classic', 'slim'].includes(variant)) return json({ error: 'BadRequest' }, 400);
      const buf = Buffer.from(await file.arrayBuffer());
      const key = `up-${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12)}`;
      textures[key] = buf;
      state.uploads.push(now);
      state.skin = { id: `skin-${now}`, url: `${TEX}${key}`, variant: variant.toUpperCase() };
      return json(profile());
    }
    if (u.pathname === '/minecraft/profile/skins/active' && method === 'DELETE') { state.skin = null; return json(profile()); }
    if (u.pathname === '/minecraft/profile/capes/active' && method === 'PUT') {
      const id = JSON.parse(opts.body || '{}').capeId;
      if (!state.capes.some((c) => c.id === id)) return json({ errorMessage: 'profile does not own cape' }, 400);
      state.activeCape = id;
      return json(profile());
    }
    if (u.pathname === '/minecraft/profile/capes/active' && method === 'DELETE') { state.activeCape = null; return json(profile()); }
  }

  const lookup = u.pathname.match(/^\/users\/profiles\/minecraft\/([^/]+)$/) || u.pathname.match(/^\/minecraft\/profile\/lookup\/name\/([^/]+)$/);
  if ((u.hostname === 'api.mojang.com' || u.hostname === 'api.minecraftservices.com') && lookup) {
    const name = Object.keys(PLAYERS).find((n) => n.toLowerCase() === decodeURIComponent(lookup[1]).toLowerCase());
    return name ? json({ id: PLAYERS[name].id, name }) : json({ errorMessage: 'Couldn\'t find any profile with that name' }, 404);
  }
  const session = u.hostname === 'sessionserver.mojang.com' && u.pathname.match(/^\/session\/minecraft\/profile\/([0-9a-f]{32})$/);
  if (session) {
    const name = Object.keys(PLAYERS).find((n) => PLAYERS[n].id === session[1]);
    if (!name) return new Response('', { status: 204 });
    const p = PLAYERS[name];
    const textures_ = p.skin ? { SKIN: { url: `http://textures.minecraft.net/texture/${p.skin}`, ...(p.model ? { metadata: { model: p.model } } : {}) } } : {};
    const value = Buffer.from(JSON.stringify({ timestamp: Date.now(), profileId: p.id, profileName: name, textures: textures_ })).toString('base64');
    return json({ id: p.id, name, properties: [{ name: 'textures', value }] });
  }
  return null;
}

module.exports = { handle, mockSkin, mockCape, state, reset };
