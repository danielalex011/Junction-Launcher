'use strict';
// The Skins page: a 3D preview (skinview3d, bundled in vendor/), the capes an account owns, the wardrobe of saved
// skins and the history of skins applied through Junction. Plain script: shares one global scope with the other
// src/renderer files (load order is in index.html).

const sk = { viewer: null, walking: true, paint: 0, images: new Map() };

// ---------------------------------------------------------------- pictures
function loadImage(src) {
  if (!sk.images.has(src)) {
    sk.images.set(src, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That picture could not be shown.'));
      img.src = src;
    }));
    if (sk.images.size > 200) sk.images.delete(sk.images.keys().next().value);
  }
  return sk.images.get(src);
}

/** A neutral stand-in for accounts without a custom skin (Minecraft hands those a built-in skin we don't ship). */
let placeholder = null;
function placeholderSkin() {
  if (placeholder) return placeholder;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const fill = (col, x, y, w, ht) => { g.fillStyle = col; g.fillRect(x, y, w, ht); };
  fill('#b98f6c', 0, 0, 32, 16); fill('#5b4636', 8, 0, 16, 8); fill('#5b4636', 0, 8, 32, 2); fill('#5b4636', 24, 8, 8, 8);
  fill('#2b3140', 10, 11, 1, 1); fill('#2b3140', 13, 11, 1, 1);
  fill('#6b7a9c', 16, 16, 24, 16); fill('#b98f6c', 40, 16, 16, 16); fill('#6b7a9c', 40, 16, 16, 5); fill('#b98f6c', 32, 48, 16, 16); fill('#6b7a9c', 32, 48, 16, 5);
  fill('#434c66', 0, 16, 16, 16); fill('#434c66', 16, 48, 16, 16);
  placeholder = c.toDataURL('image/png');
  return placeholder;
}

/** The front of a skin as a small canvas (head, body, arms, legs, with the outer layers). */
function skinFront(src, model, scale = 5) {
  const cv = document.createElement('canvas');
  cv.width = 16 * scale; cv.height = 32 * scale;
  cv.className = 'sk-front';
  loadImage(src).then((img) => {
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    const legacy = img.height === 32;
    const slim = model === 'slim' && !legacy;
    const part = (sx, sy, sw, sh, dx, dy, flip = false) => {
      if (flip) { g.save(); g.translate((dx + sw) * scale, 0); g.scale(-1, 1); g.drawImage(img, sx, sy, sw, sh, 0, dy * scale, sw * scale, sh * scale); g.restore(); } else g.drawImage(img, sx, sy, sw, sh, dx * scale, dy * scale, sw * scale, sh * scale);
    };
    const aw = slim ? 3 : 4;
    part(4, 20, 4, 12, 4, 20); part(legacy ? 4 : 20, legacy ? 20 : 52, 4, 12, 8, 20, legacy); // legs
    part(44, 20, aw, 12, slim ? 1 : 0, 8); part(legacy ? 44 : 36, legacy ? 20 : 52, aw, 12, 12, 8, legacy); // arms
    part(20, 20, 8, 12, 4, 8); // body
    part(8, 8, 8, 8, 4, 0); // head
    if (!legacy) { // outer layers
      part(4, 36, 4, 12, 4, 20); part(4, 52, 4, 12, 8, 20); part(44, 36, aw, 12, slim ? 1 : 0, 8); part(52, 52, aw, 12, 12, 8); part(20, 36, 8, 12, 4, 8);
    }
    part(40, 8, 8, 8, 4, 0);
  }).catch(() => {});
  return cv;
}

/** The front panel of a cape texture. */
function capeFront(src, scale = 3) {
  const cv = document.createElement('canvas');
  cv.width = 10 * scale; cv.height = 16 * scale;
  cv.className = 'sk-front';
  if (src) {
    loadImage(src).then((img) => {
      const u = Math.max(1, img.width / 64);
      const g = cv.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(img, u, u, 10 * u, 16 * u, 0, 0, cv.width, cv.height);
    }).catch(() => {});
  }
  return cv;
}

// ---------------------------------------------------------------- 3D preview
function startViewer(canvas) {
  if (typeof skinview3d === 'undefined') return null;
  try {
    const v = new skinview3d.SkinViewer({ canvas, width: 300, height: 400, zoom: 0.86, enableControls: true });
    v.controls.enableZoom = false;
    v.controls.enablePan = false;
    v.animation = sk.walking ? new skinview3d.WalkingAnimation() : null;
    return v;
  } catch { return null; } // no WebGL: the page falls back to a flat picture
}

/** Sizes the 3D view to its column: wide windows get a bigger player, but never taller than the window can show with the buttons below it. */
function fitViewer() {
  if (!sk.viewer || !sk.ui?.stage) return;
  const w = Math.max(240, sk.ui.stage.clientWidth - 34);
  const hgt = Math.round(Math.max(300, Math.min(w * 1.35, window.innerHeight - 330)));
  sk.viewer.setSize(w, hgt);
}

function skinsLeave() {
  if (sk.resizer) { sk.resizer.disconnect(); window.removeEventListener('resize', fitViewer); sk.resizer = null; }
  if (sk.viewer) { try { sk.viewer.dispose(); } catch { /* already gone */ } }
  sk.viewer = null;
  sk.ui = null;
}

const modelLabel = (m) => (m === 'slim' ? 'Slim arms' : 'Classic arms');
const currentCape = () => sk.profile?.capes?.find((c) => c.active) || null;

/** What the preview shows right now: the selected saved skin, or the account's current skin. */
function stageSkin() {
  if (sk.sel) return { src: sk.sel.dataUrl, label: sk.sel.name, sub: sk.sel.kind === 'history' ? 'From your history' : 'From your wardrobe' };
  if (sk.profile?.skin?.dataUrl) return { src: sk.profile.skin.dataUrl, label: `${sk.profile.name}'s current skin`, sub: 'On your account right now' };
  return { src: placeholderSkin(), label: 'Default skin', sub: sk.profile?.offline ? 'Offline accounts have no skin to change' : 'No custom skin on this account' };
}

async function paintStage() {
  const mine = ++sk.paint;
  const s = stageSkin();
  const cape = currentCape();
  const [img, capeImg] = await Promise.all([loadImage(s.src).catch(() => null), cape?.dataUrl ? loadImage(cape.dataUrl).catch(() => null) : null]);
  if (mine !== sk.paint || !img || !sk.ui) return;
  if (sk.viewer) {
    sk.viewer.loadSkin(img, { model: sk.model === 'slim' ? 'slim' : 'default' });
    sk.viewer.loadCape(capeImg || null);
  } else {
    sk.ui.flat.replaceChildren(skinFront(s.src, sk.model, 12));
  }
}

// ---------------------------------------------------------------- the page
function armSeg(value, onchange, disabled = false) {
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Arm model' });
  const buttons = [['classic', 'Classic'], ['slim', 'Slim']].map(([id, label]) => h('button', {
    type: 'button', class: id === value ? 'on' : '', disabled, title: id === 'classic' ? 'Steve-style arms, 4 pixels wide' : 'Alex-style arms, 3 pixels wide',
    onclick: () => { buttons.forEach((b, i) => b.classList.toggle('on', i === (id === 'classic' ? 0 : 1))); onchange(id); },
  }, label));
  seg.append(...buttons);
  return seg;
}

const canChange = () => Boolean(sk.account && sk.profile && !sk.profile.offline && !sk.profile.failed);

async function renderSkins(_p, token) {
  skinsLeave();
  const [{ accounts }, list] = await Promise.all([call('accounts:list'), call('skins:list')]);
  if (stale(token)) return;
  Object.assign(sk, {
    accounts, account: accounts.find((a) => a.active) || null, list, profile: null, loadingProfile: true, sel: null, model: 'classic', error: null, busy: false,
  });

  const canvas = h('canvas', { class: 'sk-canvas', width: 300, height: 400, 'aria-label': 'Drag to turn the player around' });
  const ui = {
    flat: h('div', { class: 'sk-flat' }),
    info: h('div', { class: 'sk-info' }),
    controls: h('div', { class: 'sk-controls' }),
    capes: h('div', { class: 'section sk-capes' }),
    wardrobe: h('div', { class: 'section' }),
    history: h('div', { class: 'section' }),
  };
  sk.ui = ui;
  sk.viewer = startViewer(canvas);
  const stage = h('div', { class: 'sk-stage' },
    h('div', { class: 'sk-view' }, sk.viewer ? canvas : ui.flat, h('div', { class: 'sk-drag-hint' }, sk.viewer ? 'Drag to turn' : '')),
    ui.info, ui.controls);
  ui.stage = stage;

  const picker = h('input', { type: 'file', accept: 'image/png,.png', style: { display: 'none' }, onchange: (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    const p = f && window.junction.pathForFile(f);
    if (p) skinsAddFromPath(p);
  } });
  sk.ui.picker = picker;
  const switcher = h('button', { class: 'btn sk-switch', type: 'button', title: 'Choose which account to change', onclick: (e) => accountSwitcher(e.currentTarget) },
    sk.account ? avatar({ name: sk.account.name, iconSrc: sk.account.iconSrc }, 'xs') : icon('user', 16),
    h('span', { class: 'ellipsis' }, sk.account ? sk.account.name : 'No account'), icon('chevronDown', 14));

  view().replaceChildren(h('div', { class: 'page skins-page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Skins'), switcher),
    h('div', { class: 'skins-layout' }, stage, h('div', { class: 'sk-side' }, ui.capes, ui.wardrobe, ui.history)),
    picker));
  renderStageInfo();
  renderCapes();
  renderWardrobe();
  renderSkinHistory();
  if (sk.viewer) {
    fitViewer();
    sk.resizer = new ResizeObserver(fitViewer);
    sk.resizer.observe(stage);
    window.addEventListener('resize', fitViewer);
  }
  paintStage();
  loadProfile(token);
}

function accountSwitcher(anchor) {
  const items = sk.accounts.map((a) => ({
    label: `${a.active ? '✓ ' : ''}${a.name}${a.type === 'msa' ? '' : ' (offline)'}`, icon: 'user',
    onClick: async () => {
      if (!a.active) { try { await call('accounts:setActive', a.id); } catch (e) { toast(e.message, 'error'); return; } renderAccountChip(); }
      go('skins');
    },
  }));
  if (items.length) items.push('-');
  items.push({ label: 'Add Microsoft account', icon: 'login', onClick: () => microsoftLogin() });
  popupMenu(anchor, items);
}

async function loadProfile(token) {
  if (!sk.account) { sk.loadingProfile = false; sk.profile = null; refreshAll(); return; }
  try {
    const p = await call('skins:profile', sk.account.id);
    if (stale(token)) return;
    sk.profile = p;
  } catch (e) {
    if (stale(token)) return;
    sk.profile = { failed: true, name: sk.account.name, skin: null, capes: [] };
    sk.error = e.message;
  }
  sk.loadingProfile = false;
  sk.model = sk.profile.skin?.variant || 'classic';
  refreshAll();
  paintStage();
}

function refreshAll() {
  if (!sk.ui) return;
  renderStageInfo();
  renderCapes();
  renderWardrobe();
  renderSkinHistory();
}

// ---------------------------------------------------------------- preview text and buttons
function renderStageInfo() {
  const s = stageSkin();
  const offline = sk.profile?.offline;
  sk.ui.info.replaceChildren(
    h('div', { class: 'sk-title ellipsis', title: s.label }, sk.loadingProfile ? 'Loading your skin…' : s.label),
    h('div', { class: 'hint' }, sk.loadingProfile ? 'Asking Mojang' : s.sub));
  const apply = sk.sel && h('button', { class: 'btn primary', type: 'button', disabled: !canChange() || sk.busy, title: canChange() ? null : 'Needs a Microsoft account', onclick: () => applySaved(sk.sel.kind, sk.sel, sk.model) }, icon('check'), `Apply${sk.model !== sk.sel.model ? ` with ${sk.model} arms` : ''}`);
  const back = sk.sel && h('button', { class: 'btn ghost', type: 'button', onclick: () => { sk.sel = null; sk.model = sk.profile?.skin?.variant || 'classic'; refreshAll(); paintStage(); } }, icon('arrowLeft'), 'Back to current skin');
  const walk = h('button', {
    class: `toggle${sk.walking ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': sk.walking ? 'true' : 'false', title: 'Make the player walk',
    onclick: () => { sk.walking = !sk.walking; if (sk.viewer) sk.viewer.animation = sk.walking ? new skinview3d.WalkingAnimation() : null; renderStageInfo(); },
  }, h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-knob' })), 'Walking animation');
  sk.ui.controls.replaceChildren(
    h('div', { class: 'row sk-tools' }, armSeg(sk.model, (m) => { sk.model = m; renderStageInfo(); paintStage(); }), walk),
    sk.error ? h('div', { class: 'notice warn' }, icon('alert'), sk.error) : null,
    offline ? h('div', { class: 'notice info' }, icon('info'), 'Offline accounts can\'t change skins. You can still browse your wardrobe and add skins here, then use them from a Microsoft account.') : null,
    !sk.account ? h('div', { class: 'notice info' }, icon('info'), 'Add an account (the account button at the bottom left) to change your skin.') : null,
    apply || back ? h('div', { class: 'row wrap' }, apply, back) : null,
    canChange() ? h('button', {
      class: 'btn ghost danger sm', type: 'button', disabled: sk.busy || !sk.profile.skin, title: sk.profile.skin ? null : 'Already using the default skin',
      onclick: resetSkin,
    }, icon('undo', 14), 'Reset to default skin') : null);
}

// ---------------------------------------------------------------- actions
async function guarded(fn) {
  if (sk.busy) return;
  sk.busy = true;
  sk.error = null;
  refreshAll();
  try { await fn(); } catch (e) { sk.error = e.message; toast(e.message, 'error'); } finally { sk.busy = false; if (sk.ui) refreshAll(); }
}

function takeProfile(p) {
  sk.profile = p;
  sk.sel = null;
  sk.model = p.skin?.variant || 'classic';
}

function applySaved(kind, entry, model) {
  return guarded(async () => {
    takeProfile(await call('skins:apply', { kind, id: entry.id, accountId: sk.account.id, model }));
    sk.list = await call('skins:list');
    renderAccountChip();
    toast(`${entry.name} is now your skin`, 'good');
    paintStage();
  });
}

async function resetSkin() {
  if (!(await confirmDialog('Reset to the default skin?', 'Your account goes back to the skin Minecraft gives every new player. Your wardrobe is not touched.', 'Reset', true))) return;
  guarded(async () => {
    takeProfile(await call('skins:reset', sk.account.id));
    renderAccountChip();
    toast('Back to the default skin', 'good');
    paintStage();
  });
}

function chooseCape(cape) {
  guarded(async () => {
    const p = await call('skins:cape', sk.account.id, cape ? cape.id : null);
    sk.profile = { ...sk.profile, capes: p.capes };
    toast(cape ? `${cape.alias} cape is on` : 'Cape taken off', 'good');
    paintStage();
  });
}

function selectSkin(kind, entry) {
  sk.sel = { ...entry, kind };
  sk.model = entry.model;
  refreshAll();
  paintStage();
}

async function reloadSkins() {
  sk.list = await call('skins:list');
  if (sk.sel && !(sk.sel.kind === 'history' ? sk.list.history : sk.list.skins).some((s) => s.id === sk.sel.id)) sk.sel = null;
  if (sk.ui) { renderWardrobe(); renderSkinHistory(); renderStageInfo(); }
}

// ---------------------------------------------------------------- capes
function renderCapes() {
  const p = sk.profile;
  const el = sk.ui.capes;
  if (!sk.account || !p || p.offline || p.failed) {
    el.replaceChildren(h('h3', null, 'Capes'), h('p', null, !sk.account ? 'Add a Microsoft account to see its capes.' : p?.offline ? 'Offline accounts have no capes.' : p?.failed ? 'Capes could not be loaded. Try opening this page again.' : 'Loading…'));
    return;
  }
  const tile = (cape) => {
    const on = cape ? cape.active : !p.capes.some((c) => c.active);
    return h('button', {
      type: 'button', class: `sk-cape${on ? ' on' : ''}`, disabled: sk.busy, 'aria-pressed': on ? 'true' : 'false', title: cape ? `Wear the ${cape.alias} cape` : 'Wear no cape',
      onclick: () => { if (!on) chooseCape(cape); },
    }, cape ? capeFront(cape.dataUrl, 4) : h('div', { class: 'sk-cape-none' }, icon('x', 18)), h('span', { class: 'sk-cape-name ellipsis' }, cape ? cape.alias : 'No cape'));
  };
  el.replaceChildren(
    h('h3', null, 'Capes'),
    h('p', null, p.capes.length ? 'Pick the cape your player wears. It shows on the preview and in game.' : 'This account does not own any capes yet. Capes from Mojang events and Minecraft Live show up here.'),
    p.capes.length ? h('div', { class: 'sk-cape-row' }, tile(null), p.capes.map(tile)) : null);
}

// ---------------------------------------------------------------- wardrobe and history
function skinCard(entry, kind) {
  const selected = sk.sel && sk.sel.kind === kind && sk.sel.id === entry.id;
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  const items = [
    { label: 'Apply', icon: 'check', onClick: () => applySaved(kind, entry) },
    ...(kind === 'wardrobe' ? [
      { label: 'Rename', icon: 'edit', onClick: () => renameSkin(entry) },
      { label: entry.model === 'slim' ? 'Change to classic arms' : 'Change to slim arms', icon: 'sliders', onClick: () => setSkinModel(entry, entry.model === 'slim' ? 'classic' : 'slim') },
      '-', { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteSkin(entry) },
    ] : [
      { label: 'Save to wardrobe', icon: 'plus', onClick: async () => { try { await call('skins:keep', entry.id); await reloadSkins(); toast(`${entry.name} saved to your wardrobe`, 'good'); } catch (e) { toast(e.message, 'error'); } } },
      '-', { label: 'Remove from history', icon: 'trash', danger: true, onClick: async () => { try { await call('skins:remove', 'history', entry.id); await reloadSkins(); } catch (e) { toast(e.message, 'error'); } } },
    ]),
  ];
  if (!canChange()) items[0] = { label: 'Apply (needs a Microsoft account)', icon: 'lock', onClick: () => toast('Switch to a Microsoft account to change your skin.', 'warn') };
  return h('div', {
    class: `sk-card${selected ? ' sel' : ''}`, tabindex: 0, role: 'button', 'aria-pressed': selected ? 'true' : 'false', title: 'Preview this skin',
    onclick: () => selectSkin(kind, entry), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSkin(kind, entry); } },
  },
  h('div', { class: 'sk-thumb' }, skinFront(entry.dataUrl || placeholderSkin(), entry.model, 5)),
  h('div', { class: 'sk-name ellipsis', title: entry.name }, entry.name),
  h('div', { class: 'sk-meta' }, h('span', { class: 'badge plain' }, modelLabel(entry.model)), kind === 'history' ? h('span', { class: 'hint' }, ago(entry.appliedAt)) : null),
  h('div', { class: 'sk-actions' },
    h('button', { class: 'btn sm primary', type: 'button', disabled: !canChange() || sk.busy, title: canChange() ? 'Put this skin on your account' : 'Needs a Microsoft account', onclick: stop(() => applySaved(kind, entry)) }, 'Apply'),
    h('button', { class: 'btn sm ghost icon', type: 'button', 'aria-label': `More for ${entry.name}`, title: 'More', onclick: stop((e) => popupMenu(e.currentTarget, items)) }, icon('more', 16))));
}

function renderWardrobe() {
  const skins = sk.list.skins;
  sk.ui.wardrobe.replaceChildren(
    h('div', { class: 'row wrap sk-head' },
      h('div', { class: 'grow' }, h('h3', null, 'Wardrobe'), h('div', { class: 'hint' }, 'Saved skins, shared by all your accounts. Drop a PNG anywhere on this page to add it.')),
      h('button', { class: 'btn', type: 'button', onclick: importPlayerDialog }, icon('download'), 'Import from player name'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => sk.ui.picker.click() }, icon('plus'), 'Add skin')),
    skins.length
      ? h('div', { class: 'sk-grid' }, skins.map((s) => skinCard(s, 'wardrobe')))
      : h('div', { class: 'sk-empty' }, 'Nothing saved yet. Add a skin file (64×64 PNG) or import the skin of any player by name.'));
}

function renderSkinHistory() {
  const hist = sk.list.history;
  sk.ui.history.replaceChildren(
    h('div', { class: 'row wrap sk-head' },
      h('div', { class: 'grow' }, h('h3', null, 'History'), h('div', { class: 'hint' }, 'Every skin you apply through Junction is kept here, so you can go back to it.')),
      hist.length ? h('button', {
        class: 'btn ghost sm danger', type: 'button',
        onclick: async () => { if (await confirmDialog('Clear history?', 'The skins in your history are forgotten. Your wardrobe and your account are not touched.', 'Clear', true)) { await call('skins:clearHistory'); await reloadSkins(); } },
      }, icon('trash', 14), 'Clear history') : null),
    hist.length ? h('div', { class: 'sk-grid' }, hist.map((s) => skinCard(s, 'history'))) : h('div', { class: 'sk-empty' }, 'Skins you apply will show up here.'));
}

// ---------------------------------------------------------------- dialogs
async function skinsAddFromPath(file) {
  let info;
  try { info = await call('skins:inspect', file); } catch (e) { toast(e.message, 'error'); return; }
  let model = info.model;
  const name = h('input', { type: 'text', value: info.suggestedName, maxlength: 32, placeholder: 'Name' });
  const thumb = h('div', { class: 'sk-thumb big' });
  const draw = () => thumb.replaceChildren(skinFront(info.dataUrl, model, 9));
  draw();
  const guessNote = h('div', { class: 'hint' }, info.legacy ? 'This is an old 64×32 skin. Those always use classic arms.' : `Junction thinks this one has ${model} arms. Change it if the preview looks wrong.`);
  const save = async () => {
    const saved = await call('skins:add', { path: file, name: name.value, model });
    await reloadSkins();
    toast(`${saved.name} saved to your wardrobe`, 'good');
    selectSkin('wardrobe', saved);
  };
  const m = modal({
    title: 'Add skin',
    body: h('div', { class: 'sk-add' }, thumb,
      h('div', { class: 'sk-add-form' },
        h('label', { class: 'field' }, 'Name', name),
        h('div', { class: 'field' }, 'Arm model', armSeg(model, (v) => { model = v; draw(); }, info.legacy), guessNote))),
    actions: [{ label: 'Cancel', class: 'ghost' }, { label: 'Save to wardrobe', class: 'primary', icon: 'plus', onClick: save }],
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.querySelectorAll('.m-foot .btn')[1].click(); });
  name.focus();
  name.select();
}

function importPlayerDialog() {
  const name = h('input', { type: 'text', placeholder: 'Player name, for example Notch', maxlength: 16, spellcheck: 'false', style: { width: '100%' } });
  const m = modal({
    title: 'Import from player name',
    body: [
      h('p', { style: { margin: 0, color: 'var(--muted)', lineHeight: 1.5 } }, 'Junction asks Mojang for the skin this player is wearing right now and saves a copy in your wardrobe. Nothing is sent anywhere else.'),
      name,
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      { label: 'Import skin', class: 'primary', icon: 'download', onClick: async () => {
        const saved = await call('skins:importPlayer', name.value);
        await reloadSkins();
        toast(`Saved ${saved.name}'s skin`, 'good');
        selectSkin('wardrobe', saved);
      } },
    ],
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.querySelectorAll('.m-foot .btn')[1].click(); });
  name.focus();
}

function renameSkin(entry) {
  const name = h('input', { type: 'text', value: entry.name, maxlength: 32, style: { width: '100%' } });
  const m = modal({
    title: 'Rename skin',
    body: name,
    actions: [{ label: 'Cancel', class: 'ghost' }, { label: 'Rename', class: 'primary', onClick: async () => { await call('skins:update', entry.id, { name: name.value }); await reloadSkins(); } }],
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.querySelectorAll('.m-foot .btn')[1].click(); });
  name.focus();
  name.select();
}

async function setSkinModel(entry, model) {
  try {
    await call('skins:update', entry.id, { model });
    if (sk.sel?.kind === 'wardrobe' && sk.sel.id === entry.id) { sk.sel = { ...sk.sel, model }; sk.model = model; paintStage(); }
    await reloadSkins();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteSkin(entry) {
  if (!(await confirmDialog(`Delete ${entry.name}?`, 'It is removed from your wardrobe. If you applied it before, it stays in your history.', 'Delete', true))) return;
  try { await call('skins:remove', 'wardrobe', entry.id); await reloadSkins(); } catch (e) { toast(e.message, 'error'); }
}
