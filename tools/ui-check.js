'use strict';
// Dev script: starts the real app against a COPY of a data folder and checks that the account chip
// (and the Skins page's account button) open their menus from every page. Prints any window errors.
//
//   node tools/ui-check.js "%APPDATA%\Junction\data"     # copied first, the original is never touched
//   node tools/ui-check.js --demo                         # uses tools/seed-demo.js data instead
//
// Needs Node 22+ (global WebSocket). Exit code 1 if anything fails.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const arg = process.argv[2];
if (!arg) { console.error('Usage: node tools/ui-check.js <data folder> | --demo'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-uicheck-'));
const data = path.join(tmp, 'data');
if (arg === '--demo') execFileSync(process.execPath, [path.join(__dirname, 'seed-demo.js'), data], { stdio: 'ignore' });
else fs.cpSync(arg, data, { recursive: true, filter: (s) => !/[\/](runtimes|cache|libraries|assets|versions)$/.test(s) && !/[\/]instances[\/][^\/]+[\/](saves|.minecraft)$/.test(s) });
const startedAt = Date.now();
const port = 9300 + Math.floor(Math.random() * 500);
const electron = require('electron');
const child = spawn(electron, [root, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, 'ud')}`], {
  env: { ...process.env, JUNCTION_DATA: data }, stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('The app window did not open.');
}

(async () => {
  const failures = [];
  const errors = [];
  const ws = await connect();
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const run = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await sleep(3000); // let init() finish
  // Errors thrown while the scripts load happen before Runtime.enable above, so check that the main globals exist.
  for (const g of ['go', 'renderSettings', 'initActivity', 'renderLibrary', 'renderInstSettings', 'memoryControl', 'play']) {
    if ((await run(`typeof ${g}`)) !== 'function') failures.push(`Renderer load error: ${g} is not defined (a script failed to load).`);
  }

  const instId = await run('call("inst:list").then((l) => l[0]?.id || null)');
  const tabs = ['general', 'appearance', 'memory', 'java', 'storage', 'about'];
  const pages = [['home', '{}'], ['library', '{}'], ['browse', '{}'], ['skins', '{}'], ...tabs.map((t) => ['settings', `{ tab: '${t}' }`])];
  if (instId) pages.splice(2, 0, ['instance', `{ id: ${JSON.stringify(instId)} }`]);
  else console.log('(no instance in this data folder, skipping the instance page)');

  const open = (what) => run(`(async () => { document.querySelector(${JSON.stringify(what)}).click(); await new Promise((r) => setTimeout(r, 500)); return document.querySelector('.acct-menu, .menu, .popup-menu, [role=menu]')?.innerText || null; })()`);
  const close = () => run('(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise((r) => setTimeout(r, 200)); return document.querySelectorAll(".acct-menu").length; })()');
  for (const [name, params] of pages) {
    await run(`go(${JSON.stringify(name)}, ${params}).then(() => new Promise((r) => setTimeout(r, 1500)))`);
    const text = await open('#account-chip');
    if (!text || !/Add Microsoft account/.test(text)) failures.push(`Account chip did not open its menu on the ${name} page.`);
    await close();
    if (name === 'skins') {
      const t2 = await open('.sk-switch');
      if (!t2 || !/Add Microsoft account/.test(t2)) failures.push('The account button on the Skins page did not open its menu.');
      await run('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.body.click();');
    }
    if (name === 'settings') {
      const tab = /tab: '(\w+)'/.exec(params)[1];
      const shown = await run(`document.querySelector('.set-tab.on')?.id + '|' + (document.querySelector('.set-body')?.innerText.length || 0)`);
      if (shown.split('|')[0] !== `set-tab-${tab}` || Number(shown.split('|')[1]) < 40) failures.push(`The Settings "${tab}" tab did not show its content (${shown}).`);
    }
    console.log(`${name === 'settings' ? `settings/${/tab: '([a-z]+)'/.exec(params)[1]}` : name}: chip menu ${text ? 'opens' : 'DOES NOT OPEN'}`);
  }

  // Auto-save: a valid number is saved and the "Saved" note shows; a wrong one shows an error and is not saved.
  await run("go('settings', { tab: 'storage' }).then(() => new Promise((r) => setTimeout(r, 800)))");
  const typeInto = (sel, v) => run(`(async () => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 1200)); return [document.querySelector('.set-saved')?.textContent, [...document.querySelectorAll('.field-error')].map((e) => e.textContent).join('|')]; })()`);
  const [note, errs] = await typeInto('input[aria-label="Parallel downloads"]', '20');
  const saved = await run("call('settings:get').then((s) => s.concurrency)");
  if (saved !== 20 || !/Saved/.test(note || '')) failures.push(`Auto-save: typed 20 parallel downloads, got setting ${saved}, note "${note}".`);
  const [, bad] = await typeInto('input[aria-label="Parallel downloads"]', '0');
  const still = await run("call('settings:get').then((s) => s.concurrency)");
  if (still !== 20 || !/At least 1/.test(bad)) failures.push(`Auto-save: a wrong value was not refused (setting ${still}, error "${bad}").`);
  console.log(`auto-save: typed 20 -> ${saved} (${note}); typed 0 -> still ${still} (${bad})`);
  ws.close();
  child.kill();
  for (const e of errors) failures.push(`Window error: ${e}`);
  const log = path.join(data, 'logs', 'window-errors.log');
  if (fs.existsSync(log)) {
    // Only lines written during this run (the copied data folder brings old ones). Any [window] error or [load] failure fails the check.
    const fresh = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l && Date.parse(l.slice(0, 24)) >= startedAt - 1000);
    if (fresh.length) console.log(`\nWindow error log:\n${fresh.join('\n')}`);
    for (const l of fresh) failures.push(`Logged: ${l.slice(0, 220)}`);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* still closing */ }
  if (failures.length) { console.error(`\nFAILED:\n- ${failures.join('\n- ')}`); process.exit(1); }
  console.log('\nOK: the account menus open from every page, no window errors.');
  process.exit(0);
})().catch((e) => { console.error(e); try { child.kill(); } catch { /* ignore */ } process.exit(1); });
