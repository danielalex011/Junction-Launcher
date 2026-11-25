'use strict';
// The Settings page: a tab list on the left (General, Appearance, Memory, Java, Downloads & storage, About).
// Every setting is saved on its own a moment after it changes, with a small "Saved" note; there is no Save button.
// Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'memory', label: 'Memory' },
  { id: 'java', label: 'Java' },
  { id: 'storage', label: 'Downloads & storage' },
  { id: 'about', label: 'About' },
];
const REPO_URL = 'https://github.com/danielalex011/Junction-Launcher';
const settingsUi = { auto: null, note: () => {} };

const setLink = (label, url) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); call('shell:open', url); } }, label);
const setHere = (el) => document.body.contains(el); // async parts only draw while their tab is still on screen

/** A checkbox that saves itself. */
function setCheckbox(auto, key, checked, label) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e) => auto.queue({ [key]: e.target.checked }) }), label);
}

/**
 * A number field that checks what you type and saves only valid values.
 * `toPatch(value)` turns the checked number (null = left empty) into the settings change.
 */
function setNumberField(auto, { value, rule, toPatch, step, placeholder, label, width }) {
  const err = h('div', { class: 'field-error', role: 'alert' });
  const input = h('input', { type: 'number', value: value ?? '', step, placeholder, 'aria-label': label,
    oninput: () => {
      const r = input.validity.badInput ? { ok: false, error: 'Use a number.' } : JunctionAutosave.checkNumber(input.value, rule);
      err.textContent = r.ok ? '' : r.error;
      if (r.ok) input.removeAttribute('aria-invalid'); else input.setAttribute('aria-invalid', 'true');
      if (r.ok) auto.queue(toPatch(r.value));
    } });
  if (width) input.style.width = width;
  return { input, el: h('div', null, input, err) };
}

// ---------------------------------------------------------------- page
async function renderSettings(p, token) {
  await settingsUi.auto?.flush(); // a change made a moment ago must be on disk before we read the settings again
  const s = await call('settings:get');
  const info = await call('app:info');
  if (stale(token)) return;
  state.settings = s;
  state.info = info;
  const tab = SETTINGS_TABS.some((t) => t.id === p?.tab) ? p.tab : (p?.section === 'appearance' ? 'appearance' : 'general');

  const saved = h('span', { class: 'set-saved', role: 'status', 'aria-live': 'polite' });
  let fade = null;
  settingsUi.note = (st, msg) => {
    clearTimeout(fade);
    saved.className = `set-saved ${st}`;
    saved.textContent = st === 'saving' ? 'Saving…' : st === 'saved' ? '✓ Saved' : `Not saved: ${msg}`;
    if (st === 'saved') fade = setTimeout(() => { saved.className = 'set-saved'; saved.textContent = ''; }, 2500);
  };
  const auto = JunctionAutosave.createAutosaver({
    save: async (patch) => { state.settings = await call('settings:set', patch); state.mcVersions = null; },
    onState: (st, msg) => settingsUi.note(st, msg),
  });
  settingsUi.auto = auto;

  const builders = { general: settingsGeneral, appearance: settingsAppearance, memory: settingsMemory, java: settingsJava, storage: settingsStorage, about: settingsAbout };
  const nav = h('div', { class: 'set-tabs', role: 'tablist', 'aria-orientation': 'vertical' }, SETTINGS_TABS.map((t) => h('button', {
    class: `set-tab ${t.id === tab ? 'on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(t.id === tab), id: `set-tab-${t.id}`,
    onclick: () => { if (t.id !== tab) go('settings', { tab: t.id }); },
  }, t.label)));
  view().replaceChildren(h('div', { class: 'page set-page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Settings'), saved),
    h('div', { class: 'set-layout' }, nav, h('div', { class: 'set-body', role: 'tabpanel', 'aria-labelledby': `set-tab-${tab}` }, builders[tab](s, info, auto)))));
}

// ---------------------------------------------------------------- General
function settingsGeneral(s, info, auto) {
  const isWin = info.platform === 'win32';
  const startSel = select([{ value: 'home', label: 'Home' }, { value: 'library', label: 'Library' }], s.startPage || 'home', (v) => auto.queue({ startPage: v }));
  const launchSel = select([
    { value: 'keep', label: 'Keep Junction open' },
    { value: 'minimize', label: 'Minimize Junction' },
    { value: 'hide', label: 'Hide Junction until the game closes' },
  ], s.onLaunch || 'keep', (v) => auto.queue({ onLaunch: v }));

  // sign-in and CurseForge: both were on the old page and are kept here
  const msId = h('input', { type: 'text', value: s.msClientId || '', placeholder: '00000000-0000-0000-0000-000000000000', spellcheck: 'false', 'aria-label': 'Azure application (client) ID' });
  const msErr = h('div', { class: 'field-error', role: 'alert' });
  msId.addEventListener('input', () => {
    const v = msId.value.trim();
    const ok = !v || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    msErr.textContent = ok ? '' : 'That does not look like an application ID. It has 32 letters and numbers in groups, like 00000000-0000-0000-0000-000000000000.';
    if (ok) auto.queue({ msClientId: v });
  });
  const cfKey = h('input', { type: 'password', value: '', placeholder: s.has_cfApiKey ? '•••••••• saved — type to replace' : 'Paste your CurseForge API key', autocomplete: 'off', 'aria-label': 'CurseForge API key',
    onchange: async () => {
      const v = cfKey.value.trim();
      if (!v) return;
      auto.queue({ cfApiKey: v });
      await auto.flush();
      go('settings', { tab: 'general' });
    } });
  const srcMr = h('input', { type: 'checkbox', checked: s.sources?.modrinth !== false });
  const srcCf = h('input', { type: 'checkbox', checked: s.sources?.curseforge !== false });
  const saveSources = () => auto.queue({ sources: { modrinth: srcMr.checked, curseforge: srcCf.checked } });
  srcMr.addEventListener('change', saveSources);
  srcCf.addEventListener('change', saveSources);

  const msLinks = h('div', { class: 'hint', style: { marginTop: '8px' } }, setLink('Register an app in Azure', 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'), ' · ', setLink('Request Minecraft API access', 'https://aka.ms/mce-reviewappid'));
  const cfField = h('div', { class: 'row' }, h('label', { class: 'field grow' }, s.builtin_cfApiKey ? 'Your own API key (optional)' : 'API key', cfKey),
    s.has_cfApiKey ? h('button', { class: 'btn danger', type: 'button', style: { alignSelf: 'flex-end' }, onclick: async () => { await call('settings:set', { cfApiKey: '' }); toast('CurseForge key removed'); go('settings', { tab: 'general' }); } }, 'Remove key') : null);
  const cfHint = h('div', { class: 'hint', style: { marginTop: '8px' } }, s.has_cfApiKey ? h('span', { style: { color: 'var(--good)' } }, '✓ Your key is saved. ') : null, setLink('Get a key at console.curseforge.com', 'https://console.curseforge.com/'));

  return [
    h('div', { class: 'section' }, h('h3', null, 'Starting & playing'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Start page', startSel),
        h('label', { class: 'field' }, 'When the game starts', launchSel)),
      h('div', { style: { marginTop: '14px' } }, setCheckbox(auto, 'notifyOnFinish', s.notifyOnFinish !== false, `Show a ${isWin ? 'Windows' : 'desktop'} notification when a download or install finishes`)),
      h('div', { class: 'hint', style: { marginTop: '6px' } }, 'You only get the notification while Junction is not the window you are looking at.')),
    h('div', { class: 'section' }, h('h3', null, 'Browsing & installing'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        setCheckbox(auto, 'showSnapshots', Boolean(s.showSnapshots), 'Show snapshots when creating instances'),
        setCheckbox(auto, 'showNews', s.showNews !== false, 'Show Minecraft news on the Home page'),
        setCheckbox(auto, 'includeOptionalPackFiles', Boolean(s.includeOptionalPackFiles), 'Include optional files when installing Modrinth packs'))),
    templatesSection(),
    h('div', { class: 'section' }, h('h3', null, 'Sources'),
      h('div', { class: 'row wrap', style: { gap: '22px' } },
        h('label', { class: 'check' }, srcMr, 'Search Modrinth'),
        h('label', { class: 'check' }, srcCf, 'Search CurseForge'),
        h('label', { class: 'field', style: { minWidth: '220px' } }, 'When a project is on both sites, install from',
          select([{ value: 'ask', label: 'Ask me each time' }, { value: 'modrinth', label: 'Modrinth' }, { value: 'curseforge', label: 'CurseForge' }], s.preferredSource || 'ask', (v) => auto.queue({ preferredSource: v }))))),
    h('div', { class: 'section' }, h('h3', null, 'Microsoft sign-in'),
      s.builtin_msClientId
        ? h('p', null, 'Sign-in works out of the box: you sign in on Microsoft\'s own page, so your password never touches Junction.')
        : h('p', null, 'This build has no sign-in app ID. Microsoft requires every launcher to sign in through its own registered Azure app, and Mojang must approve new apps. See “Building it yourself” in the README.'),
      s.builtin_msClientId
        ? (state.info?.devBuild ? h('details', { class: 'adv', open: Boolean(s.msClientId) }, h('summary', null, 'Advanced: use your own Azure app ID'),
          h('label', { class: 'field' }, 'Azure application (client) ID. Leave empty to use the built-in one.', msId), msErr, msLinks) : null) // release builds: no field (a saved override is still used)
        : [h('label', { class: 'field' }, 'Azure application (client) ID', msId), msErr, msLinks]),
    h('div', { class: 'section' }, h('h3', null, 'CurseForge'),
      s.builtin_cfApiKey
        ? h('p', null, `CurseForge search and downloads work out of the box with Junction's own API key.${state.info?.devBuild ? ' You can use your own key instead if you have one.' : ''}`)
        : h('p', null, 'CurseForge requires an API key for search and downloads. Get one free from the CurseForge for Studios console. It\'s stored encrypted. Without a key, Junction works with Modrinth only.'),
      s.builtin_cfApiKey ? (state.info?.devBuild ? h('details', { class: 'adv', open: Boolean(s.has_cfApiKey) }, h('summary', null, 'Advanced: use your own CurseForge API key'), cfField, cfHint) : null) : [cfField, cfHint]),
    h('div', { class: 'section' }, h('h3', null, 'Privacy'),
      h('p', { style: { marginBottom: 0 } }, 'No ads, no telemetry, no account needed to browse. Junction only talks to Mojang, Microsoft (sign-in), Modrinth, CurseForge, the loader download sites and GitHub (to look for a new version of Junction: it asks for the public release list and sends no account, name or other identifier).')),
  ];
}

// ---------------------------------------------------------------- Appearance
function settingsAppearance() {
  return appearanceSection();
}

// ---------------------------------------------------------------- Memory
function settingsMemory(s, info, auto) {
  const M = JunctionMemory;
  const total = info.totalMemMB || 0;
  let minMB = s.memoryMin;
  const lists = h('div');

  const minErr = h('div', { class: 'field-error', role: 'alert' });
  const minInput = h('input', { type: 'number', min: 0.25, step: 0.25, value: String(Math.round((minMB / 1024) * 100) / 100), 'aria-label': 'Minimum memory in GB',
    oninput: () => {
      const r = minInput.validity.badInput ? { ok: false, error: 'Use a number, like 1 or 1.5.' } : M.checkGB(minInput.value, { totalMB: total, minMB: 256 });
      if (r.ok && r.mb > ctl.getValue()) { r.ok = false; r.error = 'The minimum cannot be more than the maximum.'; }
      minErr.textContent = r.ok ? '' : r.error;
      if (r.ok) minInput.removeAttribute('aria-invalid'); else minInput.setAttribute('aria-invalid', 'true');
      if (r.ok) { minMB = r.mb; auto.queue({ memoryMin: r.mb }); }
    } });

  const ctl = memoryControl({ totalMB: total, valueMB: s.memoryMax, onChange: (mb) => {
    auto.queue({ memoryMax: mb });
    if (minMB > mb) { minMB = mb; minInput.value = String(Math.round((mb / 1024) * 100) / 100); minErr.textContent = ''; auto.queue({ memoryMin: mb }); }
    drawLists();
  } });

  let insts = [];
  let counts = {};
  let infos = {};
  const MODE_TEXT = { recommended: 'Recommended', default: 'Global default', custom: 'Custom' };
  function drawLists() {
    const dflt = ctl.getValue();
    const own = insts.filter((i) => infos[i.id]?.mode === 'custom' || i.memoryMin);
    const hints = insts.map((i) => ({ i, text: M.bigPackHint({ name: i.name, mods: counts[i.id], memoryMB: Number(i.memoryMax) || dflt }) })).filter((x) => x.text);
    lists.replaceChildren(
      insts.length ? h('div', { class: 'section' }, h('h3', null, 'Recommended memory per instance'),
        h('p', null, 'What Junction suggests for each instance, and where the number comes from. Change an instance’s mode on its Settings tab.'),
        h('div', { class: 'list' }, h('div', { class: 'item mem-rec-row mem-rec-head' }, h('span', null, 'Instance'), h('span', null, 'Mode'), h('span', null, 'Uses'), h('span', null, 'Recommended')),
          insts.map((i) => { const inf = infos[i.id]; return h('div', { class: 'item mem-rec-row' },
            h('a', { href: '#', class: 'i-title ellipsis', onclick: (e) => { e.preventDefault(); go('instance', { id: i.id, tab: 'settings' }); } }, i.name),
            h('span', null, inf ? MODE_TEXT[inf.mode] : '—'),
            h('span', null, inf ? M.gbText(inf.effectiveMB) : '—'),
            h('span', { title: inf?.rec?.reason || '' }, inf?.rec ? `${M.gbText(inf.rec.mb)} · ${inf.rec.label}` : 'No recommendation')); }))) : null,
      h('div', { class: 'section' }, h('h3', null, 'Instances with their own memory'),
        h('p', null, 'These ignore the default above. “Use default” removes the instance\'s own setting.'),
        own.length
          ? h('div', { class: 'list' }, own.map((i) => h('div', { class: 'item mem-inst' },
            h('a', { href: '#', class: 'i-title ellipsis', onclick: (e) => { e.preventDefault(); go('instance', { id: i.id, tab: 'settings' }); } }, i.name),
            h('span', { class: 'i-ver' }, i.memoryMax ? `${M.gbText(i.memoryMax)} max` : 'default max', i.memoryMin ? `, ${M.gbText(i.memoryMin)} min` : ''),
            h('button', { class: 'btn sm', type: 'button', onclick: async () => {
              try { await call('inst:update', i.id, { memoryMax: null, memoryMin: null, memoryMode: 'default' }); i.memoryMax = null; i.memoryMin = null; if (infos[i.id]) infos[i.id] = { ...infos[i.id], mode: 'default', effectiveMB: dflt }; drawLists(); toast(`${i.name} uses the default now`, 'good'); } catch (e) { toast(e.message, 'error'); }
            } }, icon('undo', 13), 'Use default'))))
          : h('div', { class: 'hint' }, 'None. Every instance uses the default.')),
      hints.length ? h('div', { class: 'section' }, h('h3', null, 'Big packs'),
        hints.map(({ i, text }) => h('div', { class: 'notice warn', style: { marginBottom: '8px' } }, icon('alert'),
          h('div', { class: 'grow' }, text, '. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('instance', { id: i.id, tab: 'settings' }); } }, 'Change it in its settings'))))) : null);
  }
  Promise.all([call('inst:list'), call('inst:modCounts'), call('inst:memoryInfoAll').catch(() => ({}))]).then(([l, c, inf]) => { insts = l; counts = c; infos = inf; if (setHere(lists)) drawLists(); }).catch(() => {});

  return [
    h('div', { class: 'section' }, h('h3', null, 'Maximum memory'),
      h('p', null, 'How much memory a game may use when an instance has no setting of its own. Modded Minecraft wants more than vanilla, but giving it nearly all of your RAM makes things slower, not faster.'),
      ctl,
      h('details', { class: 'adv', style: { marginTop: '14px' } }, h('summary', null, 'Advanced'),
        h('label', { class: 'field', style: { maxWidth: '260px' } }, 'Minimum memory (GB), what the game starts with', h('div', { class: 'row' }, minInput, h('span', null, 'GB'))), minErr)),
    lists,
  ];
}

// ---------------------------------------------------------------- Java
function settingsJava(s, info, auto) {
  const MAJORS = [8, 17, 21, 25];
  let by = { ...(s.javaByMajor || {}) };
  let found = [];
  const runtimesBox = h('div', null, loading('Looking…'));
  const foundBox = h('div', null, loading('Looking for Java on this PC…'));
  const perBox = h('div');
  const busy = new Set();

  // ---- Junction's own Java
  async function loadRuntimes() {
    let rows;
    try { rows = await call('java:runtimes'); } catch (e) { if (setHere(runtimesBox)) runtimesBox.replaceChildren(h('div', { class: 'hint' }, e.message)); return; }
    if (!setHere(runtimesBox)) return;
    const run = async (major, what, fn) => {
      busy.add(major);
      drawRuntimes(rows);
      try { await fn(); toast(`Java ${major} ${what}`, 'good'); } catch (e) { toast(e.message, 'error'); }
      busy.delete(major);
      loadRuntimes();
    };
    drawRuntimes(rows, run);
  }
  function drawRuntimes(rows, run) {
    runtimesBox.replaceChildren(h('div', { class: 'list' }, rows.map((r) => {
      const working = busy.has(r.major);
      const names = r.usedBy.slice(0, 3).map((u) => u.name).join(', ') + (r.usedBy.length > 3 ? ` and ${r.usedBy.length - 3} more` : '');
      return h('div', { class: 'item java-row' },
        h('div', { class: 'grow' },
          h('div', { class: 'row' }, h('span', { class: 'i-title' }, `Java ${r.major}`), working ? h('span', { class: 'badge warn plain' }, 'Working… see Activity') : r.installed ? h('span', { class: 'badge good' }, 'Installed') : h('span', { class: 'badge plain' }, 'Not downloaded yet')),
          h('div', { class: 'i-file' }, r.installed ? [r.version ? `Version ${r.version}` : 'Version unknown', ` · ${fmtBytes(r.sizeBytes)} on disk`] : 'Downloads automatically when an instance needs it.',
            ' · ', r.usedBy.length ? `Used by ${names}` : 'No instance uses it')),
        h('div', { class: 'row' },
          r.installed ? null : h('button', { class: 'btn sm', type: 'button', disabled: working || !run, onclick: () => run(r.major, 'downloaded', () => call('java:download', r.major)) }, icon('download', 13), 'Download now'),
          r.installed ? h('button', { class: 'btn sm', type: 'button', disabled: working || !run, title: 'Checks every file again and downloads the ones that are damaged or missing', onclick: () => run(r.major, 'repaired', () => call('java:repair', r.major)) }, icon('refresh', 13), 'Re-download (repair)') : null,
          r.installed ? h('button', { class: 'btn sm danger', type: 'button', disabled: working || !run || r.usedBy.length > 0, title: r.usedBy.length ? 'Instances still use it. It downloads again when needed, so this is only for ones nothing uses.' : 'Deletes it. It downloads again when needed.',
            onclick: async () => {
              if (!(await confirmDialog(`Remove Java ${r.major}?`, 'It is downloaded again the next time an instance needs it.', 'Remove', true))) return;
              run(r.major, 'removed', () => call('java:remove', r.major));
            } }, icon('trash', 13), 'Remove') : null));
    })));
  }

  // ---- Java found on this PC
  const testResults = new Map();
  async function loadFound() {
    foundBox.replaceChildren(loading('Looking for Java on this PC…'));
    try { found = await call('java:find'); } catch (e) { found = []; foundBox.replaceChildren(h('div', { class: 'hint' }, e.message)); return; }
    if (!setHere(foundBox)) return;
    drawFound();
    drawPer();
  }
  function drawFound() {
    if (!found.length) { foundBox.replaceChildren(h('div', { class: 'hint' }, 'No other Java found. That is fine: Junction uses its own.')); return; }
    foundBox.replaceChildren(h('div', { class: 'list' }, found.map((j) => {
      const out = h('div', { class: 'i-file java-test' });
      const showResult = (r) => {
        out.className = `i-file java-test ${r ? (r.ok ? 'ok' : 'fail') : ''}`;
        out.textContent = r ? (r.ok ? `✓ ${r.summary}` : `✗ ${r.error}`) : '';
      };
      showResult(testResults.get(j.path));
      const btn = h('button', { class: 'btn sm', type: 'button', onclick: async () => {
        btn.disabled = true;
        out.className = 'i-file java-test'; out.textContent = 'Testing…';
        try { const r = await call('java:test', j.path); testResults.set(j.path, r); showResult(r); } catch (e) { showResult({ ok: false, error: e.message }); }
        btn.disabled = false;
      } }, 'Test');
      return h('div', { class: 'item java-row' },
        h('div', { class: 'grow' },
          h('div', { class: 'row wrap' }, h('span', { class: 'i-title' }, j.version ? `Java ${j.version}` : 'Version not known'), h('span', { class: 'pill' }, j.vendor), h('span', { class: 'pill' }, j.source)),
          h('div', { class: 'i-file ellipsis java-path', title: j.path }, j.path), out),
        btn);
    })));
  }

  // ---- which Java for which Java version
  const BROWSE = '__browse__';
  function drawPer() {
    perBox.replaceChildren(h('div', { class: 'form-grid' }, MAJORS.map((m) => {
      const cur = by[m] || '';
      const fits = found.filter((j) => j.major === m || j.major === null);
      const opts = [{ value: '', label: 'Automatic (recommended)' }, ...fits.map((j) => ({ value: j.launchPath, label: `${j.vendor} ${j.version || ''} (${j.path})`.replace('  ', ' ') }))];
      if (cur && !opts.some((o) => o.value === cur)) opts.push({ value: cur, label: cur });
      opts.push({ value: BROWSE, label: 'Browse…' });
      const sel = select(opts, cur, async (v) => {
        if (v === BROWSE) {
          let picked = null;
          try { picked = await call('dialog:pickJava'); } catch (e) { toast(e.message, 'error'); }
          if (!picked) { sel.value = by[m] || ''; return; }
          v = picked;
        }
        if (v) by[m] = v; else delete by[m];
        auto.queue({ javaByMajor: { ...by } });
        drawPer();
      }, { 'aria-label': `Java for Minecraft versions that need Java ${m}` });
      return h('label', { class: 'field' }, `Java ${m}`, sel, h('span', { class: 'hint' }, cur ? 'Junction starts the game with the Java you picked.' : 'Junction uses its own Java.'));
    })));
  }

  const jvm = h('textarea', { rows: 2, value: s.jvmArgs || '', placeholder: 'Applied to every instance', 'aria-label': 'Global JVM arguments', oninput: () => auto.queue({ jvmArgs: jvm.value.trim() }) });
  loadRuntimes();
  loadFound();
  drawPer();

  return [
    h('div', { class: 'notice info', style: { marginBottom: '16px' } }, icon('info'), 'Java is installed automatically in the version each Minecraft release needs.'),
    h('div', { class: 'section' }, h('h3', null, 'Junction\'s Java'),
      h('p', null, 'The runtimes Junction downloaded from Mojang. They are the ones games normally start with.'),
      runtimesBox),
    h('div', { class: 'section' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Other Java on this PC'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => loadFound() }, icon('refresh', 13), 'Look again')),
      h('p', null, 'Found in PATH, JAVA_HOME, Program Files and your user folders (.jdks, .jabba, Java). Junction only starts one when you press Test, and then only with “java -version”.'),
      foundBox),
    h('div', { class: 'section' }, h('h3', null, 'Which Java to use'),
      h('p', null, 'For each Java version, let Junction pick (recommended) or choose one of the installs above. An instance can still have its own Java in its settings.'),
      perBox,
      s.javaPath ? h('div', { class: 'notice warn', style: { marginTop: '14px' } }, icon('alert'),
        h('div', { class: 'grow' }, 'An older single Java setting is still on: ', h('code', null, s.javaPath), '. It is used for every Java version that is set to Automatic.'),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { await call('settings:set', { javaPath: '' }); go('settings', { tab: 'java' }); } }, 'Remove it')) : null),
    h('div', { class: 'section' }, h('h3', null, 'Global JVM arguments'),
      h('label', { class: 'field' }, 'Added to every instance', jvm),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Leave this empty unless a pack asks for something. Copied flag lists are often outdated and can make things worse.')),
  ];
}

// ---------------------------------------------------------------- Downloads & storage
function settingsStorage(s, info, auto) {
  const conc = setNumberField(auto, { value: s.concurrency, rule: { min: 1, max: 64, integer: true }, toPatch: (v) => ({ concurrency: v }), label: 'Parallel downloads', width: '110px' });
  const limit = setNumberField(auto, { value: s.speedLimitMBps || '', rule: { min: 0.25, max: 1000, optional: true, unit: 'MB/s' }, toPatch: (v) => ({ speedLimitMBps: v || 0 }), step: 0.25, placeholder: 'No limit', label: 'Speed limit in MB per second', width: '130px' });
  const keep = setNumberField(auto, { value: s.backupsKept, rule: { min: 1, max: 50, integer: true }, toPatch: (v) => ({ backupsKept: v }), label: 'Update backups to keep', width: '110px' });

  const cacheText = h('span', { class: 'hint' }, 'Counting…');
  const clearBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    clearBtn.disabled = true;
    try { const r = await call('storage:clearCache'); toast(`Cache cleared (${fmtBytes(r.freed)} freed)`, 'good'); } catch (e) { toast(e.message, 'error'); }
    clearBtn.disabled = false;
    loadCache();
  } }, icon('trash', 14), 'Clear cache');
  const loadCache = () => call('storage:cache').then((c) => { if (setHere(cacheText)) cacheText.textContent = `${fmtBytes(c.bytes)} in the cache`; }).catch(() => {});
  loadCache();

  const spaceText = h('div', { class: 'hint' }, 'Checking free space…');
  const spaceBar = h('div', { class: 'bar' }, h('i'));
  call('storage:space').then((d) => {
    if (!setHere(spaceText)) return;
    if (d.free == null) { spaceText.textContent = "Couldn't read the free space on this drive."; spaceBar.remove(); return; }
    const pct = (d.free / d.total) * 100;
    const low = d.free < d.minFreeBytes || pct < d.minFreePercent;
    spaceText.textContent = `${fmtBytes(d.free)} free of ${fmtBytes(d.total)} (${pct.toFixed(pct < 10 ? 1 : 0)}%)${low ? ' · running low' : ''}`;
    spaceText.style.color = low ? 'var(--warn)' : '';
    spaceBar.firstChild.style.width = `${Math.min(100, Math.max(0, 100 - pct))}%`;
    if (low) spaceBar.firstChild.style.background = 'var(--warn)';
  }).catch(() => { if (setHere(spaceText)) { spaceText.textContent = "Couldn't read the free space on this drive."; spaceBar.remove(); } });

  return [
    h('div', { class: 'section' }, h('h3', null, 'Downloads'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Parallel downloads', conc.el, h('span', { class: 'hint' }, 'How many files download at the same time (1–64).')),
        h('label', { class: 'field' }, 'Speed limit (MB/s)', limit.el, h('span', { class: 'hint' }, 'For all downloads together. Leave empty for no limit.')))),
    h('div', { class: 'section' }, h('h3', null, 'Backups'),
      h('label', { class: 'field', style: { maxWidth: '320px' } }, 'Update backups to keep per instance', keep.el,
        h('span', { class: 'hint' }, 'Before an update Junction saves the old files so you can undo it. Older backups are deleted.'))),
    h('div', { class: 'section' }, h('h3', null, 'Cache'),
      h('p', null, 'Things Junction can download again: news, project lists and the like. Clearing it is safe.'),
      h('div', { class: 'row' }, clearBtn, cacheText)),
    h('div', { class: 'section' }, h('h3', null, 'Free space'),
      h('p', null, 'On the drive Junction keeps its data. Junction warns before a modpack install that would leave less than 10% or 5 GB free.'),
      spaceBar, spaceText),
    h('div', { class: 'section' }, h('h3', null, 'Data folder'),
      h('p', null, 'Instances, accounts, Java and settings live here.'),
      h('div', { class: 'row' }, h('code', { class: 'grow ellipsis small', title: info.dataDir }, info.dataDir),
        h('button', { class: 'btn', type: 'button', onclick: () => call('shell:openData') }, icon('folder'), 'Open'),
        h('button', { class: 'btn', type: 'button', onclick: () => call('shell:openLogs') }, icon('terminal'), 'Open logs folder'))),
  ];
}

// ---------------------------------------------------------------- About
function settingsAbout(s, info, auto) {
  const licenses = h('div', null, loading('Loading…'));
  call('licenses:list').then((list) => {
    if (!setHere(licenses)) return;
    licenses.replaceChildren(list.length
      ? h('div', { class: 'list' }, list.map((l) => h('details', { class: 'lic' }, h('summary', null, l.name), h('pre', null, l.text))))
      : h('div', { class: 'hint' }, 'The licence files were not found in this build.'));
  }).catch((e) => { if (setHere(licenses)) licenses.replaceChildren(h('div', { class: 'hint' }, e.message)); });

  return [
    h('div', { class: 'section' }, h('h3', null, `Junction ${info.version}`),
      h('p', null, 'A Minecraft launcher for Modrinth and CurseForge. No ads, no telemetry.'),
      h('label', { class: 'field', style: { maxWidth: '320px' } }, 'Update channel',
        select(CHANNELS, s.updateChannel || 'alpha', (v) => auto.queue({ updateChannel: v })),
        h('span', { class: 'hint' }, 'Which versions of your mods and modpacks count as updates. (Updates to Junction itself are under Updates below.)')),
      h('div', { class: 'row wrap', style: { marginTop: '14px' } },
        h('button', { class: 'btn', type: 'button', onclick: () => call('shell:open', REPO_URL) }, icon('external', 14), 'GitHub repository'),
        h('button', { class: 'btn', type: 'button', onclick: () => call('shell:open', `${REPO_URL}/releases`) }, icon('external', 14), 'Releases'),
        h('button', { class: 'btn', type: 'button', onclick: () => call('shell:open', `${REPO_URL}/issues`) }, icon('external', 14), 'Report a problem'))),
    selfUpdateSection(s, info, auto),
    h('div', { class: 'section' }, h('h3', null, 'Tour'),
      h('p', null, 'A short walk through the sidebar: what each part does.'),
      h('button', { class: 'btn', type: 'button', onclick: () => startTour() }, icon('compass', 14), 'Take the tour')),
    h('div', { class: 'section' }, h('h3', null, 'Debug info'),
      h('p', null, 'Copies the Junction version, your Windows version and the Java installs Junction found, to paste into a bug report. It never includes accounts, tokens or keys.'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { try { await call('app:copyDebugInfo'); toast('Debug info copied', 'good'); } catch (e) { toast(e.message, 'error'); } } }, icon('copy', 14), 'Copy debug info')),
    h('div', { class: 'section' }, h('h3', null, 'Third-party licenses'),
      h('p', null, 'Junction is MIT licensed and includes the open source code below.'),
      licenses),
  ];
}
