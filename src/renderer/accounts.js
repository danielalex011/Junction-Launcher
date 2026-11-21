'use strict';
// The account chip in the sidebar and the menu it opens. Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

// ---------------------------------------------------------------- account chip
let accountMenu = null; // declared first: nothing below may run before it exists

async function renderAccountChip() {
  const chip = $('#account-chip');
  chip.setAttribute('aria-haspopup', 'menu');
  try {
    const { accounts } = await call('accounts:list');
    const active = accounts.find((a) => a.active);
    chip.replaceChildren(
      active ? avatar({ name: active.name, iconSrc: active.iconSrc }, 'xs') : h('div', { class: 'avatar xs', style: { background: 'var(--panel-3)', color: 'var(--muted)' } }, icon('user', 14)),
      h('div', { class: 'grow' },
        h('div', { class: 'a-name ellipsis' }, active ? active.name : 'No account'),
        h('div', { class: 'a-sub' }, active ? (active.type === 'msa' ? 'Microsoft' : 'Offline') : 'Click to add one')),
      icon('chevronDown', 14));
  } catch { /* ignore */ }
  chip.onclick = () => (closeAccountMenu() ? null : openAccountMenu(chip));
}

on('accounts:changed', () => renderAccountChip());


/** Closes the account menu. Returns true if one was open. */
function closeAccountMenu({ refocus = false } = {}) {
  if (!accountMenu) return false;
  const { el, off } = accountMenu;
  accountMenu = null;
  el.remove();
  document.removeEventListener('mousedown', off.mouse, true);
  document.removeEventListener('keydown', off.key, true);
  const chip = $('#account-chip');
  chip.setAttribute('aria-expanded', 'false');
  if (refocus) chip.focus();
  return true;
}

async function openAccountMenu(chip) {
  let data;
  let info;
  try {
    data = await call('accounts:list');
    info = state.info || (state.info = await call('app:info'));
  } catch (e) { toast(e.message, 'error'); return; }
  const { accounts, canAddOffline } = data;
  const rows = accounts.map((a) => h('div', { class: `acct-row ${a.active ? 'active' : ''}` },
    h('button', {
      type: 'button', role: 'menuitemradio', 'aria-checked': a.active ? 'true' : 'false', class: 'acct-main',
      title: a.active ? 'The account Minecraft starts with' : `Switch to ${a.name}`,
      onclick: async () => {
        closeAccountMenu({ refocus: true });
        if (!a.active) { try { await call('accounts:setActive', a.id); } catch (e) { toast(e.message, 'error'); } renderAccountChip(); }
      },
    }, avatar({ name: a.name, iconSrc: a.iconSrc }, 'xs'),
    h('div', { class: 'grow' },
      h('div', { class: 'a-name ellipsis' }, a.name),
      h('div', { class: 'a-sub' }, a.needsRelogin ? 'Microsoft · sign in again' : (a.type === 'msa' ? 'Microsoft' : 'Offline'))),
    a.active ? h('span', { class: 'badge good plain' }, icon('check', 12), 'Active') : null),
    h('button', {
      type: 'button', class: 'btn ghost sm danger icon', title: `Remove ${a.name}`, 'aria-label': `Remove ${a.name}`,
      onclick: async () => {
        closeAccountMenu();
        if (!(await confirmDialog(`Remove ${a.name}?`, 'You can sign in again any time.', 'Remove', true))) return;
        try { await call('accounts:remove', a.id); } catch (e) { toast(e.message, 'error'); }
        renderAccountChip();
      },
    }, icon('trash', 14))));
  const el = h('div', { class: 'acct-menu', role: 'menu', 'aria-label': 'Accounts' },
    accounts.length ? h('div', { class: 'acct-list' }, rows) : h('div', { class: 'acct-empty' }, 'No accounts yet. Sign in with the Microsoft account you bought Minecraft with.'),
    h('hr'),
    h('button', { type: 'button', role: 'menuitem', class: 'acct-add', onclick: () => { closeAccountMenu(); microsoftLogin(); } }, icon('login'), 'Add Microsoft account'),
    h('button', {
      type: 'button', role: 'menuitem', class: 'acct-add', disabled: !canAddOffline,
      title: canAddOffline ? 'For singleplayer and offline-mode LAN servers' : 'Unlocks after you add a Microsoft account that owns Minecraft',
      onclick: () => { closeAccountMenu(); offlineAccountDialog(); },
    }, icon('plus'), 'Add offline account'),
    canAddOffline ? null : h('div', { class: 'acct-hint' }, 'Offline accounts unlock after you add a Microsoft account that owns Minecraft.'),
    h('div', { class: 'acct-hint' }, info.encryption ? 'Sign-in tokens are encrypted with your operating system\'s keychain.' : 'Your OS keychain is not available, so tokens are stored obfuscated, not encrypted.'));
  document.body.append(el);
  const r = chip.getBoundingClientRect();
  el.style.left = `${Math.max(8, r.left)}px`;
  el.style.width = `${Math.max(280, r.width)}px`;
  el.style.bottom = `${window.innerHeight - r.top + 6}px`;
  chip.setAttribute('aria-expanded', 'true');
  const items = () => [...el.querySelectorAll('button:not(:disabled)')];
  const off = {
    mouse: (e) => { if (!el.contains(e.target) && !chip.contains(e.target)) closeAccountMenu(); },
    key: (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAccountMenu({ refocus: true }); return; }
      if (e.key === 'Tab' && !el.contains(document.activeElement)) { closeAccountMenu(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const list = items();
      const i = list.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    },
  };
  document.addEventListener('mousedown', off.mouse, true);
  document.addEventListener('keydown', off.key, true);
  accountMenu = { el, off };
  (el.querySelector('.acct-row.active .acct-main') || items()[0])?.focus();
}

function offlineAccountDialog() {
  const name = h('input', { type: 'text', placeholder: 'Player name', maxlength: 16, style: { width: '100%' } });
  const m = modal({
    title: 'Add offline account',
    body: [
      h('p', { style: { margin: 0, color: 'var(--muted)', lineHeight: 1.5 } }, 'For singleplayer and offline-mode LAN servers. Online servers will reject it.'),
      name,
    ],
    actions: [
      { label: 'Cancel', class: 'ghost' },
      { label: 'Add', class: 'primary', icon: 'plus', onClick: async () => { await call('accounts:addOffline', name.value); renderAccountChip(); } },
    ],
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.querySelectorAll('.m-foot .btn')[1].click(); });
  name.focus();
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
  } catch (e) {
    done = true;
    if (e.code !== 'CANCELLED') {
      status.replaceChildren(h('div', { class: 'notice warn', style: { margin: 0 } }, icon('alert'), e.message));
    }
  }
}
