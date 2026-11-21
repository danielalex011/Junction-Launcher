'use strict';
// The Settings page. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ---------------------------------------------------------------- settings
async function renderSettings(_p, token) {
  const s = await call('settings:get');
  const info = await call('app:info');
  if (stale(token)) return;
  state.settings = s;
  state.info = info;
  const f = {
    msClientId: h('input', { type: 'text', value: s.msClientId || '', placeholder: '00000000-0000-0000-0000-000000000000', spellcheck: 'false' }),
    cfApiKey: h('input', { type: 'password', value: '', placeholder: s.has_cfApiKey ? '•••••••• saved — type to replace' : 'Paste your CurseForge API key', autocomplete: 'off' }),
    memoryMax: h('input', { type: 'number', min: 512, step: 256, value: s.memoryMax }),
    memoryMin: h('input', { type: 'number', min: 256, step: 256, value: s.memoryMin }),
    jvmArgs: h('textarea', { rows: 2, value: s.jvmArgs || '', placeholder: 'Applied to every instance' }),
    javaPath: h('input', { type: 'text', value: s.javaPath || '', placeholder: 'Automatic (recommended)' }),
    concurrency: h('input', { type: 'number', min: 1, max: 64, value: s.concurrency }),
    preferredSource: select([{ value: 'ask', label: 'Ask me each time' }, { value: 'modrinth', label: 'Modrinth' }, { value: 'curseforge', label: 'CurseForge' }], s.preferredSource || 'ask'),
    srcMr: h('input', { type: 'checkbox', checked: s.sources?.modrinth !== false }),
    srcCf: h('input', { type: 'checkbox', checked: s.sources?.curseforge !== false }),
    closeOnLaunch: h('input', { type: 'checkbox', checked: s.closeOnLaunch }),
    showSnapshots: h('input', { type: 'checkbox', checked: s.showSnapshots }),
    includeOptional: h('input', { type: 'checkbox', checked: s.includeOptionalPackFiles }),
  };
  const save = async () => {
    const patch = {
      msClientId: f.msClientId.value.trim(),
      memoryMax: Number(f.memoryMax.value), memoryMin: Number(f.memoryMin.value),
      jvmArgs: f.jvmArgs.value.trim(), javaPath: f.javaPath.value.trim(), concurrency: Number(f.concurrency.value),
      preferredSource: f.preferredSource.value,
      sources: { modrinth: f.srcMr.checked, curseforge: f.srcCf.checked },
      closeOnLaunch: f.closeOnLaunch.checked, showSnapshots: f.showSnapshots.checked, includeOptionalPackFiles: f.includeOptional.checked,
    };
    if (f.cfApiKey.value.trim()) patch.cfApiKey = f.cfApiKey.value.trim();
    state.settings = await call('settings:set', patch);
    state.info = await call('app:info');
    state.mcVersions = null;
    toast('Settings saved', 'good');
    go('settings');
  };
  const link = (label, url) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); call('shell:open', url); } }, label);
  view().replaceChildren(h('div', { class: 'page', style: { maxWidth: '900px' } },
    h('div', { class: 'page-head' }, h('h1', null, 'Settings'), h('button', { class: 'btn primary', type: 'button', onclick: () => save().catch((e) => toast(e.message, 'error')) }, icon('check'), 'Save')),
    h('div', { class: 'section' }, h('h3', null, 'Microsoft sign-in'),
      s.builtin_msClientId
        ? h('p', null, 'Sign-in works out of the box: you sign in on Microsoft\'s own page, so your password never touches Junction.')
        : h('p', null, 'This build has no sign-in app ID. Microsoft requires every launcher to sign in through its own registered Azure app, and Mojang must approve new apps. See “Building it yourself” in the README.'),
      (() => {
        const links = h('div', { class: 'hint', style: { marginTop: '8px' } }, link('Register an app in Azure', 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'), ' · ', link('Request Minecraft API access', 'https://aka.ms/mce-reviewappid'));
        return s.builtin_msClientId
          ? h('details', { class: 'adv', open: Boolean(s.msClientId) }, h('summary', null, 'Advanced: use your own Azure app ID'),
            h('label', { class: 'field' }, 'Azure application (client) ID. Leave empty to use the built-in one.', f.msClientId), links)
          : [h('label', { class: 'field' }, 'Azure application (client) ID', f.msClientId), links];
      })()),
    h('div', { class: 'section' }, h('h3', null, 'CurseForge'),
      s.builtin_cfApiKey
        ? h('p', null, 'CurseForge search and downloads work out of the box with Junction\'s own API key. You can use your own key instead if you have one.')
        : h('p', null, 'CurseForge requires an API key for search and downloads. Get one free from the CurseForge for Studios console. It\'s stored encrypted. Without a key, Junction works with Modrinth only.'),
      (() => {
        const field = h('div', { class: 'row' }, h('label', { class: 'field grow' }, s.builtin_cfApiKey ? 'Your own API key (optional)' : 'API key', f.cfApiKey),
          s.has_cfApiKey ? h('button', { class: 'btn danger', type: 'button', style: { alignSelf: 'flex-end' }, onclick: async () => { await call('settings:set', { cfApiKey: '' }); toast('CurseForge key removed'); go('settings'); } }, 'Remove key') : null);
        const hint = h('div', { class: 'hint', style: { marginTop: '8px' } }, s.has_cfApiKey ? h('span', { style: { color: 'var(--good)' } }, '✓ Your key is saved. ') : null, link('Get a key at console.curseforge.com', 'https://console.curseforge.com/'));
        return s.builtin_cfApiKey ? h('details', { class: 'adv', open: Boolean(s.has_cfApiKey) }, h('summary', null, 'Advanced: use your own CurseForge API key'), field, hint) : [field, hint];
      })()),
    h('div', { class: 'section' }, h('h3', null, 'Sources'),
      h('div', { class: 'row wrap', style: { gap: '22px' } },
        h('label', { class: 'check' }, f.srcMr, 'Search Modrinth'),
        h('label', { class: 'check' }, f.srcCf, 'Search CurseForge'),
        h('label', { class: 'field', style: { minWidth: '220px' } }, 'When a project is on both sites, install from', f.preferredSource))),
    h('div', { class: 'section' }, h('h3', null, 'Java & memory defaults'),
      h('p', null, 'Java is downloaded automatically in the exact version each Minecraft release needs (8, 17, 21 or 25). Instances can override all of this.'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Maximum memory (MB)', f.memoryMax),
        h('label', { class: 'field' }, 'Minimum memory (MB)', f.memoryMin),
        h('label', { class: 'field' }, 'Java executable override', f.javaPath)),
      h('label', { class: 'field', style: { marginTop: '14px' } }, 'Global JVM arguments', f.jvmArgs)),
    h('div', { class: 'section' }, h('h3', null, 'Behaviour'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('label', { class: 'check' }, f.closeOnLaunch, 'Hide the launcher while the game is running'),
        h('label', { class: 'check' }, f.showSnapshots, 'Show snapshots when creating instances'),
        h('label', { class: 'check' }, f.includeOptional, 'Include optional files when installing Modrinth packs'),
        h('label', { class: 'field', style: { maxWidth: '260px' } }, 'Parallel downloads', f.concurrency))),
    h('div', { class: 'section' }, h('h3', null, 'Storage & privacy'),
      h('p', null, 'No ads, no telemetry, no account needed to browse. Junction only talks to Mojang, Microsoft (sign-in), Modrinth, CurseForge and the loader download sites.'),
      h('div', { class: 'row' }, h('code', { class: 'grow ellipsis small' }, info.dataDir), h('button', { class: 'btn', type: 'button', onclick: () => call('shell:openData') }, icon('folder'), 'Open data folder')),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, `Junction ${info.version}`)),
  ));
}
