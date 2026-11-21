'use strict';
// The account chip in the sidebar and the Accounts page. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ---------------------------------------------------------------- account chip
async function renderAccountChip() {
  const chip = $('#account-chip');
  try {
    const { accounts } = await call('accounts:list');
    const active = accounts.find((a) => a.active);
    chip.replaceChildren(
      active ? avatar({ name: active.name }, 'xs') : h('div', { class: 'avatar xs', style: { background: 'var(--panel-3)', color: 'var(--muted)' } }, icon('user', 14)),
      h('div', { class: 'grow' },
        h('div', { class: 'a-name ellipsis' }, active ? active.name : 'No account'),
        h('div', { class: 'a-sub' }, active ? (active.type === 'msa' ? 'Microsoft' : 'Offline') : 'Click to add one')),
    );
  } catch { /* ignore */ }
  chip.onclick = () => go('accounts');
}

// ---------------------------------------------------------------- accounts
async function renderAccounts(_p, token) {
  const { accounts, canAddOffline } = await call('accounts:list');
  const info = state.info || (state.info = await call('app:info'));
  if (stale(token)) return;
  const offlineName = h('input', { type: 'text', placeholder: 'Player name', maxlength: 16 });
  view().replaceChildren(h('div', { class: 'page', style: { maxWidth: '820px' } },
    h('div', { class: 'page-head' }, h('h1', null, 'Accounts'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => microsoftLogin() }, icon('login'), 'Add Microsoft account')),
    !info.msConfigured ? h('div', { class: 'notice warn' }, icon('alert'), h('div', { class: 'grow' },
      h('div', null, 'Microsoft sign-in needs an Azure app (client) ID before it can work.'),
      h('div', { class: 'hint' }, 'Mojang must approve new launcher apps. The README walks you through registering one (free) and requesting approval.')),
    h('button', { class: 'btn sm', type: 'button', onclick: () => go('settings') }, 'Settings')) : null,
    accounts.length ? h('div', { class: 'list' }, accounts.map((a) => h('div', { class: 'item', style: { gridTemplateColumns: '34px 1fr auto auto' } },
      avatar({ name: a.name }, 'sm'),
      h('div', null, h('div', { class: 'i-title' }, a.name, a.active ? h('span', { class: 'badge good plain', style: { marginLeft: '8px' } }, 'Active') : null,
        a.needsRelogin ? h('span', { class: 'badge bad plain', style: { marginLeft: '8px' } }, 'Sign in again') : null),
      h('div', { class: 'i-file' }, `${a.type === 'msa' ? 'Microsoft account' : 'Offline account'} · ${a.uuid}`)),
      a.active ? h('span') : h('button', { class: 'btn sm', type: 'button', onclick: async () => { await call('accounts:setActive', a.id); renderAccountChip(); go('accounts'); } }, 'Use'),
      h('button', { class: 'btn sm ghost danger', type: 'button', onclick: async () => {
        if (!(await confirmDialog(`Remove ${a.name}?`, 'You can sign in again any time.', 'Remove', true))) return;
        await call('accounts:remove', a.id); renderAccountChip(); go('accounts');
      } }, icon('trash', 14))))) : h('div', { class: 'empty' }, h('h2', null, 'No accounts'), h('div', null, 'Sign in with the Microsoft account you bought Minecraft with.')),
    h('div', { class: 'section', style: { marginTop: '18px' } }, h('h3', null, 'Offline account'),
      h('p', null, canAddOffline ? 'For singleplayer and offline-mode LAN servers. Online servers will reject it.' : 'Unlocks after you add a Microsoft account that owns Minecraft. Offline accounts can\'t join online servers.'),
      h('div', { class: 'row' }, offlineName, h('button', { class: 'btn', type: 'button', disabled: !canAddOffline, onclick: async () => {
        try { await call('accounts:addOffline', offlineName.value); renderAccountChip(); go('accounts'); } catch (e) { toast(e.message, 'error'); }
      } }, icon('plus'), 'Add'))),
    h('p', { class: 'hint' }, info.encryption ? 'Sign-in tokens are encrypted with your operating system\'s keychain.' : 'Your OS keychain is not available, so tokens are stored obfuscated, not encrypted.'),
  ));
}

async function microsoftLogin() {
  let begin;
  try {
    begin = await call('accounts:beginMs');
  } catch (e) {
    if (e.code === 'NO_CLIENT_ID') {
      const ok = await confirmDialog('Microsoft sign-in isn\'t set up', e.message, 'Open Settings');
      if (ok) go('settings');
    } else toast(e.message, 'error');
    return;
  }
  const status = h('div', { class: 'row muted', style: { justifyContent: 'center' } }, h('div', { class: 'spinner' }), 'Waiting for you to finish signing in…');
  let done = false;
  const m = modal({
    title: 'Sign in with Microsoft',
    body: [
      h('p', { style: { margin: 0 } }, `Go to ${begin.verificationUri} and enter this code:`),
      h('div', { class: 'code-box' }, begin.userCode),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, h('button', { class: 'btn primary', type: 'button', onclick: () => { navigator.clipboard.writeText(begin.userCode); call('shell:open', begin.verificationUri); } }, icon('copy'), 'Copy code & open sign-in page')),
      status,
    ],
    onClose: () => { if (!done) call('accounts:cancelMs', begin.loginId); },
  });
  try {
    const acc = await call('accounts:completeMs', begin.loginId);
    done = true;
    m.close();
    toast(`Signed in as ${acc.name}`, 'good');
    renderAccountChip();
    if (state.view === 'accounts') go('accounts');
  } catch (e) {
    done = true;
    if (e.code !== 'CANCELLED') {
      status.replaceChildren(h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), e.message));
    }
  }
}
