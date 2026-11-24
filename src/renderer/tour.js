'use strict';
// A short guided tour of the app: a spotlight on each part of the sidebar with a few plain words about it.
// Start it with startTour() (Home, Settings → About and Ctrl+K do). Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

const TOUR_STEPS = [
  { title: 'Welcome to Junction', text: 'A quick tour, about a minute. Junction installs mods and modpacks from Modrinth and CurseForge and starts Minecraft for you. You can stop any time with Esc.' },
  { target: '[data-nav="home"]', title: 'Home', text: 'Your recent instances, an updates bar and popular modpacks. An instance is your own copy of Minecraft, with its own mods and worlds.' },
  { target: '[data-nav="library"]', title: 'Library', text: 'All your instances in one place. Make a new one here, or bring instances over from another launcher. Press Play on a card to start the game.' },
  { target: '[data-nav="browse"]', title: 'Browse', text: 'Search mods, modpacks, resource packs and shaders on Modrinth and CurseForge at the same time, then press Install.' },
  { target: '[data-nav="skins"]', title: 'Skins', text: 'Change your skin and cape, keep skins in a wardrobe and go back to an old one any time.' },
  { target: '[data-nav="settings"]', title: 'Settings', text: 'Memory, Java, downloads, and Appearance with themes and colours. The defaults are fine, so you can ignore this at first.' },
  { target: '#qs-btn', title: 'Search from anywhere', text: 'Press Ctrl+K on any page to find an instance, a mod or a setting. Type a few letters and press Enter.' },
  { target: '#activity-btn', title: 'Activity', text: 'Every download and install shows up here with progress and time left. You can pause or cancel from this panel.' },
  { target: '#account-chip', title: 'Your account', text: 'Sign in with the Microsoft account you bought Minecraft with, or switch between accounts. Your password never goes through Junction.' },
  { target: '#theme-btn', title: 'Make it yours', text: 'The paintbrush opens Appearance: ten themes, accent colours, a background picture and more.' },
  { title: 'That is it', text: 'Sign in, make an instance, press Play. Replay this tour any time from Settings → About, or press Ctrl+K and type "tour".' },
];

const tourUi = { root: null, index: 0, keys: null, resize: null, before: null };

/** Starts the tour at a step (the first by default). Does nothing if it is already open. */
function startTour(index = 0) {
  if (tourUi.root) return;
  tourUi.before = document.activeElement;
  tourUi.root = h('div', { id: 'tour', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tour of Junction' },
    h('div', { class: 'tour-spot', 'aria-hidden': 'true' }),
    h('div', { class: 'tour-card', 'aria-live': 'polite' }));
  document.body.append(tourUi.root);
  tourUi.keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTour(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); tourShow(tourUi.index + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); tourShow(tourUi.index - 1); }
    else if (e.key === 'Tab') { // keep focus on the tour's own buttons
      const btns = [...tourUi.root.querySelectorAll('button')];
      if (!btns.length) return;
      const i = btns.indexOf(document.activeElement);
      e.preventDefault();
      btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); } // no quick search on top of the tour
  };
  tourUi.resize = () => tourPlace();
  window.addEventListener('keydown', tourUi.keys, true);
  window.addEventListener('resize', tourUi.resize);
  tourShow(index);
}

function endTour() {
  if (!tourUi.root) return;
  window.removeEventListener('keydown', tourUi.keys, true);
  window.removeEventListener('resize', tourUi.resize);
  tourUi.root.remove();
  tourUi.root = null;
  try { tourUi.before?.focus?.(); } catch { /* it is gone */ }
}

function tourShow(i) {
  if (!tourUi.root) return;
  if (i >= TOUR_STEPS.length) { endTour(); return; }
  tourUi.index = Math.max(0, i);
  const step = TOUR_STEPS[tourUi.index];
  const last = tourUi.index === TOUR_STEPS.length - 1;
  const card = tourUi.root.querySelector('.tour-card');
  const next = h('button', { class: 'btn primary', type: 'button', onclick: () => (last ? endTour() : tourShow(tourUi.index + 1)) }, last ? 'Done' : 'Next');
  card.replaceChildren(
    h('div', { class: 'tour-count' }, `${tourUi.index + 1} of ${TOUR_STEPS.length}`),
    h('h3', null, step.title),
    h('p', null, step.text),
    h('div', { class: 'tour-actions' },
      last ? null : h('button', { class: 'btn ghost', type: 'button', onclick: endTour }, 'Skip tour'),
      h('span', { class: 'grow' }),
      tourUi.index > 0 ? h('button', { class: 'btn', type: 'button', onclick: () => tourShow(tourUi.index - 1) }, 'Back') : null,
      next));
  tourPlace();
  next.focus();
}

/** Puts the spotlight over the step's target and the card beside it (or in the middle when there is no target). */
function tourPlace() {
  if (!tourUi.root) return;
  const step = TOUR_STEPS[tourUi.index];
  const spot = tourUi.root.querySelector('.tour-spot');
  const card = tourUi.root.querySelector('.tour-card');
  const el = step.target ? document.querySelector(step.target) : null;
  const shown = el && el.getClientRects().length > 0;
  tourUi.root.classList.toggle('centered', !shown);
  spot.hidden = !shown;
  if (!shown) { card.style.left = '50%'; card.style.top = '50%'; card.style.transform = 'translate(-50%, -50%)'; return; }
  const pad = 6;
  const r = el.getBoundingClientRect();
  Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  card.style.transform = 'none';
  const w = card.offsetWidth; const hgt = card.offsetHeight;
  const room = window.innerWidth;
  const a = (el.closest('#sidebar') || el).getBoundingClientRect(); // sidebar parts: the card sits beside the whole sidebar, never over its neighbours
  const left = a.right + 16 + w <= room - 12 ? a.right + 16 : Math.max(12, a.left - 16 - w);
  const top = Math.min(Math.max(12, r.top + r.height / 2 - hgt / 2), window.innerHeight - hgt - 12);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}
