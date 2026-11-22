'use strict';
// Makes the README screenshots: docs/screenshots/*.png at 1600x1000.
//
//   npm run screenshots               # all of them
//   npm run screenshots -- home skins # only these
//
// It starts the app from source (electron .) once per picture, against a throwaway data folder with demo data and the
// simulated network (tools/seed-home.js + tools/mock-network.js), and uses the app's own JUNCTION_SCREENSHOT hook, which
// saves webContents.capturePage(). Nothing real can show up in the pictures:
//   - the data folder is generated, the account is called "Player" and nothing talks to the internet;
//   - while capturing, local paths (data folder, temp folder, home folder, user name) are replaced on screen;
//   - the sign-in ID and CurseForge key from the environment are removed from the app's environment, and the app's
//     output is thrown away. This script prints only its own progress lines.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots');
const WIDTH = 1600;
const HEIGHT = 1000;

// Each scene: file name, what to run in the page (after the page has loaded), and how long to wait for it to settle.
const SCENES = [
  { name: 'home', wait: 2500, js: "go('home')" },
  { name: 'library', wait: 2000, js: "go('library')" },
  {
    name: 'browse-install-from', wait: 500,
    js: `(async () => {
      await go('browse', { type: 'modpack', query: 'twin' });
      const card = await until(() => [...document.querySelectorAll('.result')].find((c) => c.querySelector('.r-title')?.textContent === 'Twin Pack'), 15000);
      card.querySelector('.btn.primary').click(); // on both sites, so this opens the "Install from…" window
      await until(() => document.querySelector('#modal-root .modal'), 10000);
      await sleep(2500);
    })()`,
  },
  {
    name: 'modpack-content', wait: 2500,
    js: "call('inst:list').then((l) => go('instance', { id: l.find((i) => /Lantern/.test(i.name)).id, tab: 'content' }))",
  },
  {
    name: 'review-all', wait: 500,
    js: `(async () => {
      await go('home');
      await sleep(2000);
      reviewAllUpdates(document.createElement('button'));
      await until(() => document.querySelector('#modal-root .modal'), 30000);
      await sleep(1000);
    })()`,
  },
  { name: 'skins', wait: 4000, js: "go('skins')" },
  {
    name: 'activity', wait: 3500,
    // A download that streams slowly, so the panel shows progress, speed and time left.
    js: `(async () => {
      await go('library');
      call('pack:installFromSource', { source: 'modrinth', projectId: 'SLOW', title: 'Slow Pack' }).catch(() => {});
      await sleep(3000);
      openActivity();
    })()`,
  },
  {
    name: 'quick-search', wait: 1500,
    js: `(async () => {
      await go('home');
      await sleep(1000);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      await sleep(300);
      const i = document.querySelector('.qs-input');
      i.value = 'sod';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  },
  { name: 'settings', wait: 2000, js: "go('settings', { tab: 'storage' })" },
];

/** Runs in the page before each scene: replaces local paths and the demo account name, now and whenever the page changes. */
function scrubJs(paths) {
  return `(() => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.sleep = sleep;
    const toasts = document.querySelector('#toasts');
    if (toasts) toasts.style.display = 'none'; // pop-up notes would only be noise in the pictures
    window.until = async (fn, ms) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('Timed out waiting for the page'); await sleep(200); } };
    const subs = ${JSON.stringify(paths)}.filter((p) => p[0]).sort((a, b) => b[0].length - a[0].length);
    const fix = (s) => {
      let out = s;
      for (const [from, to] of subs) out = out.split(from).join(to);
      return out;
    };
    const scrub = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) { const f = fix(n.nodeValue); if (f !== n.nodeValue) n.nodeValue = f; }
      for (const el of root.querySelectorAll ? root.querySelectorAll('[title], [aria-label], input') : []) {
        for (const a of ['title', 'aria-label', 'value', 'placeholder']) {
          const v = el.getAttribute(a);
          if (v) { const f = fix(v); if (f !== v) el.setAttribute(a, f); }
        }
        if (el.tagName === 'INPUT' && el.value) { const f = fix(el.value); if (f !== el.value) el.value = f; }
      }
    };
    new MutationObserver(() => scrub(document.body)).observe(document.body, { childList: true, subtree: true, characterData: true });
    scrub(document.body);
  })();`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('latin1', 1, 4) !== 'PNG') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function runElectron({ env, userData, label }) {
  return new Promise((resolve) => {
    const child = spawn(require('electron'), [root, `--user-data-dir=${userData}`, '--force-device-scale-factor=1'], { env, stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } console.error(`  ${label}: timed out`); }, 60000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

(async () => {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const scenes = only.length ? SCENES.filter((s) => only.includes(s.name)) : SCENES;
  if (only.length && scenes.length !== only.length) {
    console.error(`Unknown picture. Choose from: ${SCENES.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-shots-'));
  const data = path.join(tmp, 'data');
  const userData = path.join(tmp, 'ud');
  console.log('Making demo data…');
  execFileSync(process.execPath, [path.join(__dirname, 'seed-home.js'), data], { stdio: 'ignore' });
  // The signed-in account is called "Player" in every picture.
  const accFile = path.join(data, 'accounts.json');
  const acc = JSON.parse(fs.readFileSync(accFile, 'utf8'));
  for (const a of acc.accounts) if (a.type === 'msa') a.name = 'Player';
  fs.writeFileSync(accFile, JSON.stringify(acc));

  fs.mkdirSync(outDir, { recursive: true });
  const env = { ...process.env, JUNCTION_DATA: data, JUNCTION_FETCH_MOCK: path.join(__dirname, 'mock-network.js') };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (/^JUNCTION_(MS_CLIENT_ID|CF_API_KEY)$|TOKEN|SECRET|PASSWORD|API_KEY/i.test(k)) delete env[k];
  const home = os.homedir();
  const paths = [
    [data, '%APPDATA%\\Junction\\data'], [tmp, '%TEMP%'], [os.tmpdir(), '%TEMP%'], [root, '<junction>'], [home, '%USERPROFILE%'],
    ['DemoPlayer', 'Player'],
  ].flatMap(([from, to]) => (from ? [[from, to], [from.replace(/\\/g, '/'), to]] : []));

  let failed = 0;
  for (const s of scenes) {
    const file = path.join(outDir, `${s.name}.png`);
    fs.rmSync(file, { force: true });
    process.stdout.write(`${s.name}… `);
    await runElectron({
      label: s.name, userData,
      env: {
        ...env, JUNCTION_SCREENSHOT: file, JUNCTION_SCREENSHOT_SIZE: `${WIDTH}x${HEIGHT}`, JUNCTION_SCREENSHOT_DELAY: '3500',
        JUNCTION_SCREENSHOT_WAIT: String(s.wait), JUNCTION_SCREENSHOT_JS: `${scrubJs(paths)}\n${s.js}`,
      },
    });
    await sleep(500);
    const size = fs.existsSync(file) ? pngSize(file) : null;
    if (!size || size.width !== WIDTH || size.height !== HEIGHT) { failed++; console.log(size ? `wrong size ${size.width}x${size.height}` : 'NOT SAVED'); } else console.log(`${size.width}x${size.height}, ${Math.round(fs.statSync(file).size / 1024)} KB`);
  }
  // Window errors from the page, with local paths replaced.
  const log = path.join(data, 'logs', 'window-errors.log');
  if (fs.existsSync(log)) {
    let text = fs.readFileSync(log, 'utf8');
    for (const [from, to] of paths) text = text.split(from).join(to);
    console.log(`\nWindow errors during capture:\n${text.trim().split('\n').slice(0, 20).join('\n')}`);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* still closing */ }
  if (failed) { console.error(`\n${failed} picture(s) failed.`); process.exit(1); }
  console.log(`\nSaved ${scenes.length} picture(s) in docs/screenshots/`);
})().catch((e) => { console.error(e.message); process.exit(1); });
