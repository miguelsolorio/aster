// Browser gestures that pull a touch player out of the game: a double tap that zooms the page,
// and a swipe in from the screen edge (or the system back gesture) that leaves it. The viewport
// tag and touch-action in index.html handle the pinch; these cover what those miss.

const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 48;
const EDGE_PX = 28;
const CONTROLS = 'button, a, input, select, textarea, label';

/**
 * Install the guards. `onBack` runs when the player goes back (gesture or button); the page
 * stays where it is.
 */
export function installTouchGuards(onBack: () => void): void {
  // ---- double tap: the second tap of a quick pair would zoom the page on iOS
  let lastEnd = -1e9;
  let lastX = 0;
  let lastY = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      if (e.touches.length > 0) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const now = e.timeStamp;
      const near = Math.hypot(t.clientX - lastX, t.clientY - lastY) < DOUBLE_TAP_PX;
      const quick = now - lastEnd < DOUBLE_TAP_MS;
      lastEnd = now;
      lastX = t.clientX;
      lastY = t.clientY;
      if (!quick || !near || !e.cancelable) return;
      e.preventDefault();
      // Cancelling the tap also cancels its click, so a button tapped twice in a row is clicked by hand.
      const el = e.target instanceof Element ? e.target.closest('button, a') : null;
      if (el instanceof HTMLElement) el.click();
    },
    { passive: false },
  );

  // ---- edge swipe: a drag that starts at the left or right edge is the browser's back and forward
  document.addEventListener(
    'touchstart',
    (e) => {
      if (!e.cancelable) return;
      const w = window.innerWidth;
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX > EDGE_PX && t.clientX < w - EDGE_PX) continue;
        if (e.target instanceof Element && e.target.closest(`${CONTROLS}, .aster-panes`)) return;
        e.preventDefault();
        return;
      }
    },
    { passive: false },
  );

  // ---- back: where the gesture gets through anyway (Android's system back, older iOS), it lands on
  // a spare history entry of this same page instead of leaving. The entry is added on the first
  // touch, since browsers skip entries made without one, and only on touch so a desktop's history is
  // left alone.
  let armed = false;
  const arm = (e: PointerEvent): void => {
    if (armed || e.pointerType === 'mouse') return;
    armed = true;
    window.removeEventListener('pointerup', arm, true);
    history.pushState({ asterGuard: true }, '');
  };
  window.addEventListener('pointerup', arm, true);
  window.addEventListener('popstate', () => {
    if (!armed) return;
    history.pushState({ asterGuard: true }, '');
    onBack();
  });
}
