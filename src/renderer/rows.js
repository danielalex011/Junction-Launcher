'use strict';
// The sideways row used by Home (your instances, popular modpacks). Plain script: shares one global scope with the other src/renderer files (load order is in index.html).

/**
 * A row of cards that scrolls sideways: arrow buttons that hide at the ends, snap scrolling and a soft fade at the edges.
 * Shift+scroll and trackpads scroll it natively; with the keyboard, Tab to the row and use Left/Right (or Tab through the cards).
 * `cards` are elements; `label` names the row for screen readers. Returns the wrapper element.
 */
function scrollRow(cards, { label = 'Items', cardWidth = '250px' } = {}) {
  const track = h('div', { class: 'srow-track', tabindex: 0, role: 'group', 'aria-label': label }, cards);
  const prev = h('button', { class: 'srow-btn prev', type: 'button', 'aria-label': 'Scroll left', title: 'Scroll left', tabindex: -1 }, icon('chevronDown', 18));
  const next = h('button', { class: 'srow-btn next', type: 'button', 'aria-label': 'Scroll right', title: 'Scroll right', tabindex: -1 }, icon('chevronDown', 18));
  const wrap = h('div', { class: 'srow' }, prev, track, next);
  wrap.style.setProperty('--card-w', cardWidth);
  const update = () => {
    const max = track.scrollWidth - track.clientWidth;
    wrap.classList.toggle('can-prev', track.scrollLeft > 2);
    wrap.classList.toggle('can-next', track.scrollLeft < max - 2);
  };
  const page = (dir) => track.scrollBy({ left: dir * Math.max(200, track.clientWidth * 0.85), behavior: 'smooth' });
  prev.onclick = () => page(-1);
  next.onclick = () => page(1);
  track.addEventListener('scroll', update, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(track);
  requestAnimationFrame(update);
  return wrap;
}
