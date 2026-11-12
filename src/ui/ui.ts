import './ui.css';

export type Quality = 'mobile' | 'low' | 'high';
export type UIState = 'title' | 'playing' | 'menu' | 'photo';

export interface UIHooks {
  onBegin(): void;
  onResume(): void;
  onPause(): void;
  onVolume(v: number): void;
  onQuality(q: Quality): void;
  onPhoto(active: boolean): void;
  onHideFigure(hidden: boolean): void;
  onCapture(): void;
}

const KEY_VOLUME = 'desertscape.volume';
const KEY_QUALITY = 'desertscape.quality';
const CONTROLS = ['WASD glide', 'Mouse look', 'Shift boost', 'Space leap, hold to fly', 'In the air: S climb, W dive', 'Esc menu'];
const TOUCH_CONTROLS = [
  'Left thumb: glide (push to the edge to boost)',
  'Right thumb: look, pinch to zoom',
  'Button: leap, hold to fly',
  'In the air: stick up dives, down climbs',
];
const QUALITIES: Quality[] = ['mobile', 'low', 'high'];
const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fillControls(ul: HTMLElement, items: string[]): void {
  ul.replaceChildren(...items.map((c) => el('li', undefined, c)));
}

function controlsList(cls: string): HTMLUListElement {
  const ul = el('ul', cls);
  fillControls(ul, CONTROLS);
  return ul;
}

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable; fine */
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export class UI {
  private _state: UIState = 'title';
  get state(): UIState {
    return this._state;
  }

  private readonly hooks: UIHooks;
  private readonly host: HTMLElement;
  private readonly title: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly photo: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly volumeOut: HTMLElement;
  private readonly qualityBtns: Record<Quality, HTMLButtonElement>;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly captureBtn: HTMLButtonElement;
  private readonly hideBtn: HTMLButtonElement;
  private readonly beginEl: HTMLElement;
  private readonly titleControls: HTMLElement;
  private readonly panelControls: HTMLElement;
  private readonly photoHint: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly rotateEl: HTMLElement;
  private readonly portraitMq: MediaQueryList | null;
  private touch = false;
  private touchIdleTimer = 0;
  private rotateTimer = 0;
  private rotateDone = false;

  private volume: number;
  private quality: Quality;
  private figureHidden = false;
  private idleTimer = 0;
  private toastTimer = 0;
  private returnFocus: HTMLElement | null = null;

  constructor(root: HTMLElement, hooks: UIHooks, initial?: { volume?: number; quality?: Quality }) {
    this.hooks = hooks;

    const storedVol = parseFloat(readStore(KEY_VOLUME) ?? '');
    const storedQ = readStore(KEY_QUALITY);
    this.volume = clamp01(Number.isFinite(storedVol) ? storedVol : (initial?.volume ?? 0.7));
    this.quality =
      storedQ === 'mobile' || storedQ === 'low' || storedQ === 'high' ? storedQ : (initial?.quality ?? 'high');

    const host = el('div', 'ds-ui');
    host.dataset.state = 'title';
    this.host = host;

    // Title card
    const title = el('div', 'ds-layer ds-title is-on');
    title.appendChild(el('h1', 'ds-title__name', 'Desertscape'));
    title.appendChild(el('p', 'ds-title__line', 'Walk anywhere. There is nowhere you need to be.'));
    this.beginEl = el('p', 'ds-title__begin', 'Click to begin');
    title.appendChild(this.beginEl);
    this.titleControls = controlsList('ds-title__controls');
    title.appendChild(this.titleControls);
    this.title = title;

    // Menu
    const menu = el('div', 'ds-layer ds-menu');
    const panel = el('div', 'ds-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'ds-menu-title');
    const h = el('h2', 'ds-panel__title', 'Paused');
    h.id = 'ds-menu-title';
    panel.appendChild(h);

    const volField = el('div', 'ds-field');
    const volHead = el('div', 'ds-field__head');
    const volLabel = el('label', undefined, 'Volume');
    volLabel.htmlFor = 'ds-volume';
    this.volumeOut = el('span', 'ds-field__value');
    volHead.append(volLabel, this.volumeOut);
    const slider = el('input', 'ds-range');
    slider.id = 'ds-volume';
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    this.slider = slider;
    volField.append(volHead, slider);
    panel.appendChild(volField);

    const gfx = el('div', 'ds-field');
    const gfxHead = el('div', 'ds-field__head');
    const gfxLabel = el('span', undefined, 'Graphics');
    gfxLabel.id = 'ds-gfx-label';
    gfxHead.appendChild(gfxLabel);
    const seg = el('div', 'ds-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-labelledby', 'ds-gfx-label');
    const mk = (q: Quality, label: string): HTMLButtonElement => {
      const b = el('button', undefined, label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => this.chooseQuality(q));
      seg.appendChild(b);
      return b;
    };
    this.qualityBtns = { mobile: mk('mobile', 'Mobile'), low: mk('low', 'Low'), high: mk('high', 'High') };
    gfx.append(gfxHead, seg);
    panel.appendChild(gfx);

    const actions = el('div', 'ds-actions');
    this.resumeBtn = el('button', 'ds-btn ds-btn--primary', 'Resume');
    this.resumeBtn.type = 'button';
    const photoBtn = el('button', 'ds-btn', 'Photo mode');
    photoBtn.type = 'button';
    actions.append(this.resumeBtn, photoBtn);
    panel.appendChild(actions);
    this.panelControls = controlsList('ds-panel__controls');
    panel.appendChild(this.panelControls);
    menu.appendChild(panel);
    this.menu = menu;
    this.panel = panel;

    // Photo bar
    const photo = el('div', 'ds-layer ds-photo');
    const bar = el('div', 'ds-bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Photo mode');
    this.captureBtn = el('button', 'ds-btn ds-btn--primary', 'Capture');
    this.captureBtn.type = 'button';
    this.hideBtn = el('button', 'ds-btn', 'Hide figure');
    this.hideBtn.type = 'button';
    this.hideBtn.setAttribute('aria-pressed', 'false');
    const done = el('button', 'ds-btn', 'Done');
    done.type = 'button';
    const hint = el('p', 'ds-bar__hint');
    this.photoHint = hint;
    this.fillPhotoHint();
    bar.append(this.captureBtn, this.hideBtn, done, hint);
    photo.appendChild(bar);
    this.photo = photo;
    this.bar = bar;

    // Toast
    const toast = el('div', 'ds-toast');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    this.toastEl = toast;

    // Touch-only affordances (hidden unless setTouch(true))
    const pause = el('button', 'ds-pause');
    pause.type = 'button';
    pause.setAttribute('aria-label', 'Pause');
    pause.append(el('span', 'ds-pause__bar'), el('span', 'ds-pause__bar'));
    this.pauseBtn = pause;
    const rotate = el('div', 'ds-rotate');
    rotate.setAttribute('aria-hidden', 'true');
    rotate.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2" transform="rotate(90 12 12)"/><path d="M4 8a8 8 0 0 1 3-3.5M4 4v4h4"/></svg>';
    rotate.append(el('span', undefined, 'Rotate for a wider view'));
    this.rotateEl = rotate;
    this.portraitMq = typeof window.matchMedia === 'function' ? window.matchMedia('(orientation: portrait)') : null;

    host.append(title, menu, photo, pause, rotate, toast);
    root.appendChild(host);

    // Menu is inert until shown
    this.menu.setAttribute('aria-hidden', 'true');
    this.photo.setAttribute('aria-hidden', 'true');

    // Wiring
    this.syncVolume();
    this.syncQuality();
    slider.addEventListener('input', () => {
      this.volume = clamp01(Number(slider.value) / 100);
      writeStore(KEY_VOLUME, String(this.volume));
      this.syncVolume();
      this.hooks.onVolume(this.volume);
    });
    this.resumeBtn.addEventListener('click', () => this.closeMenu());
    photoBtn.addEventListener('click', () => this.enterPhoto());
    this.captureBtn.addEventListener('click', () => this.hooks.onCapture());
    this.hideBtn.addEventListener('click', () => this.setFigureHidden(!this.figureHidden));
    done.addEventListener('click', () => this.exitPhoto());
    title.addEventListener('click', () => this.begin());
    pause.addEventListener('click', () => this.openMenu());
    const onOrient = (): void => {
      if (this.portraitMq && !this.portraitMq.matches) this.rotateDone = false;
      this.syncRotate();
    };
    if (this.portraitMq) {
      if (this.portraitMq.addEventListener) this.portraitMq.addEventListener('change', onOrient);
      else this.portraitMq.addListener(onOrient);
    }
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pointermove', this.onActivity, { passive: true });
    window.addEventListener('pointerdown', this.onActivity, { passive: true });
    window.addEventListener('touchstart', this.onTouchActivity, { passive: true });

    // Restored / initial values
    this.hooks.onVolume(this.volume);
    this.hooks.onQuality(this.quality);
  }

  openMenu(): void {
    if (this._state !== 'playing') return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.setState('menu');
    this.hooks.onPause();
    this.resumeBtn.focus();
  }

  closeMenu(): void {
    if (this._state !== 'menu') return;
    this.setState('playing');
    this.restoreFocus();
    this.hooks.onResume();
  }

  setQuality(q: Quality): void {
    if (!QUALITIES.includes(q)) return;
    this.quality = q;
    writeStore(KEY_QUALITY, q);
    this.syncQuality();
  }

  setTouch(on: boolean): void {
    if (on === this.touch) return;
    this.touch = on;
    this.host.classList.toggle('is-touch', on);
    this.beginEl.textContent = on ? 'Tap to begin' : 'Click to begin';
    fillControls(this.titleControls, on ? TOUCH_CONTROLS : CONTROLS);
    fillControls(this.panelControls, on ? TOUCH_CONTROLS : CONTROLS);
    this.fillPhotoHint();
    this.syncPause();
    this.syncRotate();
  }

  toast(text: string, ms = 2200): void {
    window.clearTimeout(this.toastTimer);
    this.toastEl.textContent = text;
    // restart transition
    this.toastEl.classList.remove('is-on');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('is-on');
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('is-on'), ms);
  }

  // --- internals ---

  private setState(s: UIState): void {
    this._state = s;
    this.host.dataset.state = s;
    this.title.classList.toggle('is-on', s === 'title');
    this.menu.classList.toggle('is-on', s === 'menu');
    this.photo.classList.toggle('is-on', s === 'photo');
    this.menu.setAttribute('aria-hidden', String(s !== 'menu'));
    this.photo.setAttribute('aria-hidden', String(s !== 'photo'));
    this.title.setAttribute('aria-hidden', String(s !== 'title'));
    if (s === 'photo') this.wake();
    else window.clearTimeout(this.idleTimer);
    this.syncPause();
    this.syncRotate();
  }

  private fillPhotoHint(): void {
    if (this.touch) this.photoHint.textContent = 'Drag to orbit, pinch to zoom';
    else this.photoHint.replaceChildren('Drag to orbit. ', el('kbd', undefined, 'C'), ' captures.');
  }

  private syncPause(): void {
    const show = this.touch && this._state === 'playing';
    this.pauseBtn.classList.toggle('is-on', show);
    this.pauseBtn.tabIndex = show ? 0 : -1;
    this.pauseBtn.setAttribute('aria-hidden', String(!show));
    window.clearTimeout(this.touchIdleTimer);
    this.pauseBtn.classList.remove('is-idle');
    if (show) this.touchIdleTimer = window.setTimeout(() => this.pauseBtn.classList.add('is-idle'), 4000);
  }

  private syncRotate(): void {
    const portrait = !!this.portraitMq && this.portraitMq.matches;
    const show =
      this.touch && portrait && !this.rotateDone && (this._state === 'playing' || this._state === 'title');
    const was = this.rotateEl.classList.contains('is-on');
    this.rotateEl.classList.toggle('is-on', show);
    if (show && !was) {
      window.clearTimeout(this.rotateTimer);
      this.rotateTimer = window.setTimeout(() => {
        this.rotateDone = true;
        this.rotateEl.classList.remove('is-on');
      }, 6000);
    } else if (!show) {
      window.clearTimeout(this.rotateTimer);
    }
  }

  private readonly onTouchActivity = (): void => {
    if (!this.touch || this._state !== 'playing') return;
    this.pauseBtn.classList.remove('is-idle');
    window.clearTimeout(this.touchIdleTimer);
    this.touchIdleTimer = window.setTimeout(() => this.pauseBtn.classList.add('is-idle'), 4000);
  };

  private restoreFocus(): void {
    const t = this.returnFocus;
    this.returnFocus = null;
    if (t && document.contains(t)) t.focus({ preventScroll: true });
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  private begin(): void {
    if (this._state !== 'title') return;
    this.setState('playing');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    this.hooks.onBegin();
  }

  private enterPhoto(): void {
    if (this._state !== 'menu') return;
    this.setState('photo');
    this.hooks.onPhoto(true);
    this.captureBtn.focus({ preventScroll: true });
  }

  private exitPhoto(): void {
    if (this._state !== 'photo') return;
    if (this.figureHidden) this.setFigureHidden(false);
    this.setState('menu');
    this.hooks.onPhoto(false);
    this.resumeBtn.focus();
  }

  private setFigureHidden(hidden: boolean): void {
    this.figureHidden = hidden;
    this.hideBtn.setAttribute('aria-pressed', String(hidden));
    this.hooks.onHideFigure(hidden);
  }

  private chooseQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    writeStore(KEY_QUALITY, q);
    this.syncQuality();
    this.hooks.onQuality(q);
  }

  private syncVolume(): void {
    const pct = Math.round(this.volume * 100);
    this.slider.value = String(pct);
    this.slider.style.setProperty('--ds-fill', `${pct}%`);
    this.slider.setAttribute('aria-valuetext', `${pct} percent`);
    this.volumeOut.textContent = String(pct);
  }

  private syncQuality(): void {
    for (const q of QUALITIES) {
      const b = this.qualityBtns[q];
      b.setAttribute('aria-checked', String(q === this.quality));
      b.tabIndex = q === this.quality ? 0 : -1;
    }
  }

  private wake(): void {
    this.bar.classList.remove('is-idle');
    window.clearTimeout(this.idleTimer);
    if (this._state === 'photo') {
      this.idleTimer = window.setTimeout(() => this.bar.classList.add('is-idle'), 3000);
    }
  }

  private readonly onActivity = (): void => {
    if (this._state === 'photo') this.wake();
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    const s = this._state;
    if (s === 'title') {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        this.begin();
      }
      return;
    }
    if (s === 'menu') {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeMenu();
      } else if (e.key === 'Tab') {
        this.trapTab(e);
      } else if (e.key.startsWith('Arrow') && this.arrowSegment(e)) {
        e.preventDefault();
      }
      return;
    }
    if (s === 'photo') {
      this.wake();
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.exitPhoto();
      } else if (e.key === 'c' || e.key === 'C') {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        this.hooks.onCapture();
      } else if (e.key === 'Enter') {
        // Let a focused button handle its own Enter
        if (e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        this.hooks.onCapture();
      }
    }
  };

  private arrowSegment(e: KeyboardEvent): boolean {
    const t = e.target;
    if (!(t instanceof HTMLButtonElement) || t.getAttribute('role') !== 'radio') return false;
    const i = QUALITIES.indexOf(this.quality);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') this.chooseQuality(QUALITIES[Math.max(0, i - 1)]);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown')
      this.chooseQuality(QUALITIES[Math.min(QUALITIES.length - 1, i + 1)]);
    else return false;
    this.qualityBtns[this.quality].focus();
    return true;
  }

  private trapTab(e: KeyboardEvent): void {
    const items = Array.from(this.panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (n) => n.tabIndex >= 0,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!this.panel.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
