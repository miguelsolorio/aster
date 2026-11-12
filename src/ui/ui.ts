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
  onStyle(index: number): void;
}

export interface StyleChoice {
  id: string;
  name: string;
}

const KEY_VOLUME = 'aster.volume';
const KEY_QUALITY = 'aster.quality';
const KEY_STYLE = 'aster.style';
const CONTROLS = ['WASD glide', 'Mouse look', 'Shift boost', 'Space leap, hold to rise, let go to glide', 'In the air: WASD steer, Shift drop', 'Esc menu'];
const TOUCH_CONTROLS = [
  'Left thumb: glide (push to the edge to boost)',
  'Right thumb: look, pinch to zoom',
  'Button: leap, hold to rise, let go to glide',
  'In the air: stick steers, small button drops',
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
  private readonly panelControls: HTMLElement;
  private readonly photoHint: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly styleNames: HTMLElement[] = [];
  private readonly styles: StyleChoice[];
  private styleI = 0;
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

  constructor(
    root: HTMLElement,
    hooks: UIHooks,
    initial?: { volume?: number; quality?: Quality; styles?: StyleChoice[]; style?: string | null },
  ) {
    this.hooks = hooks;
    this.styles = initial?.styles ?? [];
    // A style named in the URL wins for this visit, without replacing the saved choice.
    const wanted = initial?.style ?? readStore(KEY_STYLE);
    this.styleI = Math.max(0, this.styles.findIndex((st) => st.id === wanted));

    const storedVol = parseFloat(readStore(KEY_VOLUME) ?? '');
    const storedQ = readStore(KEY_QUALITY);
    this.volume = clamp01(Number.isFinite(storedVol) ? storedVol : (initial?.volume ?? 0.7));
    this.quality =
      storedQ === 'mobile' || storedQ === 'low' || storedQ === 'high' ? storedQ : (initial?.quality ?? 'high');

    const host = el('div', 'aster-ui');
    host.dataset.state = 'title';
    this.host = host;

    // Title card
    const title = el('div', 'aster-layer aster-title is-on');
    title.appendChild(el('h1', 'aster-title__name', 'Aster'));
    title.appendChild(el('p', 'aster-title__line', 'The desert is your map'));
    this.beginEl = el('p', 'aster-title__begin', 'Click to begin');
    title.appendChild(this.beginEl);
    this.title = title;

    // Menu
    const menu = el('div', 'aster-layer aster-menu');
    const panel = el('div', 'aster-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'aster-menu-title');
    const h = el('h2', 'aster-panel__title', 'Paused');
    h.id = 'aster-menu-title';
    panel.appendChild(h);

    const volField = el('div', 'aster-field');
    const volHead = el('div', 'aster-field__head');
    const volLabel = el('label', undefined, 'Volume');
    volLabel.htmlFor = 'aster-volume';
    this.volumeOut = el('span', 'aster-field__value');
    volHead.append(volLabel, this.volumeOut);
    const slider = el('input', 'aster-range');
    slider.id = 'aster-volume';
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    this.slider = slider;
    volField.append(volHead, slider);
    panel.appendChild(volField);

    const gfx = el('div', 'aster-field');
    const gfxHead = el('div', 'aster-field__head');
    const gfxLabel = el('span', undefined, 'Graphics');
    gfxLabel.id = 'aster-gfx-label';
    gfxHead.appendChild(gfxLabel);
    const seg = el('div', 'aster-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-labelledby', 'aster-gfx-label');
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

    if (this.styles.length > 1) {
      const sty = el('div', 'aster-field');
      const styHead = el('div', 'aster-field__head');
      const styLabel = el('span', undefined, 'Style');
      styLabel.id = 'aster-style-label';
      styHead.appendChild(styLabel);
      sty.append(styHead, this.stylePicker('aster-pick aster-pick--wide', 'aster-style-label'));
      panel.appendChild(sty);
    }

    const actions = el('div', 'aster-actions');
    this.resumeBtn = el('button', 'aster-btn aster-btn--primary', 'Resume');
    this.resumeBtn.type = 'button';
    const photoBtn = el('button', 'aster-btn', 'Photo mode');
    photoBtn.type = 'button';
    actions.append(this.resumeBtn, photoBtn);
    panel.appendChild(actions);
    this.panelControls = controlsList('aster-panel__controls');
    panel.appendChild(this.panelControls);
    menu.appendChild(panel);
    this.menu = menu;
    this.panel = panel;

    // Photo bar
    const photo = el('div', 'aster-layer aster-photo');
    const bar = el('div', 'aster-bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Photo mode');
    this.captureBtn = el('button', 'aster-btn aster-btn--primary', 'Capture');
    this.captureBtn.type = 'button';
    this.hideBtn = el('button', 'aster-btn', 'Hide figure');
    this.hideBtn.type = 'button';
    this.hideBtn.setAttribute('aria-pressed', 'false');
    const done = el('button', 'aster-btn', 'Done');
    done.type = 'button';
    const hint = el('p', 'aster-bar__hint');
    this.photoHint = hint;
    this.fillPhotoHint();
    if (this.styles.length > 1) bar.append(this.stylePicker('aster-pick'));
    bar.append(this.captureBtn, this.hideBtn, done, hint);
    photo.appendChild(bar);
    this.photo = photo;
    this.bar = bar;

    // Toast
    const toast = el('div', 'aster-toast');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    this.toastEl = toast;

    // Touch-only affordances (hidden unless setTouch(true))
    const pause = el('button', 'aster-pause');
    pause.type = 'button';
    pause.setAttribute('aria-label', 'Pause');
    pause.append(el('span', 'aster-pause__bar'), el('span', 'aster-pause__bar'));
    this.pauseBtn = pause;
    const rotate = el('div', 'aster-rotate');
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
    this.syncStyle();
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
    if (this.styles.length) this.hooks.onStyle(this.styleI);
  }

  /** The style currently chosen. */
  get style(): StyleChoice | undefined {
    return this.styles[this.styleI];
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
    else if (this.styles.length > 1)
      this.photoHint.replaceChildren('Drag to orbit. ', el('kbd', undefined, '['), ' ', el('kbd', undefined, ']'), ' style. ', el('kbd', undefined, 'C'), ' captures.');
    else this.photoHint.replaceChildren('Drag to orbit. ', el('kbd', undefined, 'C'), ' captures.');
  }

  /** ‹ Name › : steps through the styles. */
  private stylePicker(cls: string, labelledBy?: string): HTMLElement {
    const pick = el('div', cls);
    pick.setAttribute('role', 'group');
    if (labelledBy) pick.setAttribute('aria-labelledby', labelledBy);
    else pick.setAttribute('aria-label', 'Style');
    const prev = el('button', 'aster-pick__step', '\u2039');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous style');
    const next = el('button', 'aster-pick__step', '\u203a');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next style');
    const name = el('span', 'aster-pick__name');
    name.setAttribute('aria-live', 'polite');
    this.styleNames.push(name);
    prev.addEventListener('click', () => this.stepStyle(-1));
    next.addEventListener('click', () => this.stepStyle(1));
    pick.append(prev, name, next);
    return pick;
  }

  private stepStyle(d: number): void {
    const n = this.styles.length;
    if (n < 2) return;
    this.styleI = (this.styleI + d + n) % n;
    writeStore(KEY_STYLE, this.styles[this.styleI].id);
    this.syncStyle();
    this.hooks.onStyle(this.styleI);
    if (this._state === 'playing') this.toast(this.styles[this.styleI].name, 1200);
  }

  private syncStyle(): void {
    const name = this.styles[this.styleI]?.name ?? '';
    for (const n of this.styleNames) n.textContent = name;
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
    this.slider.style.setProperty('--aster-fill', `${pct}%`);
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
    if ((s === 'playing' || s === 'photo') && (e.key === '[' || e.key === ']') && !(e.ctrlKey || e.metaKey || e.altKey)) {
      e.preventDefault();
      if (s === 'photo') this.wake();
      this.stepStyle(e.key === '[' ? -1 : 1);
      return;
    }
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
