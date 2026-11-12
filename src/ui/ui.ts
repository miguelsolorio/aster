import './ui.css';

export type Quality = 'low' | 'high';
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

function controlsList(cls: string): HTMLUListElement {
  const ul = el('ul', cls);
  for (const c of CONTROLS) ul.appendChild(el('li', undefined, c));
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
      storedQ === 'low' || storedQ === 'high' ? storedQ : (initial?.quality ?? 'high');

    const host = el('div', 'ds-ui');
    host.dataset.state = 'title';
    this.host = host;

    // Title card
    const title = el('div', 'ds-layer ds-title is-on');
    title.appendChild(el('h1', 'ds-title__name', 'Desertscape'));
    title.appendChild(el('p', 'ds-title__line', 'Walk anywhere. There is nowhere you need to be.'));
    title.appendChild(el('p', 'ds-title__begin', 'Click to begin'));
    title.appendChild(controlsList('ds-title__controls'));
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
      b.addEventListener('click', () => this.setQuality(q));
      seg.appendChild(b);
      return b;
    };
    this.qualityBtns = { low: mk('low', 'Low'), high: mk('high', 'High') };
    gfx.append(gfxHead, seg);
    panel.appendChild(gfx);

    const actions = el('div', 'ds-actions');
    this.resumeBtn = el('button', 'ds-btn ds-btn--primary', 'Resume');
    this.resumeBtn.type = 'button';
    const photoBtn = el('button', 'ds-btn', 'Photo mode');
    photoBtn.type = 'button';
    actions.append(this.resumeBtn, photoBtn);
    panel.appendChild(actions);
    panel.appendChild(controlsList('ds-panel__controls'));
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
    hint.append('Drag to orbit. ', el('kbd', undefined, 'C'), ' captures.');
    bar.append(this.captureBtn, this.hideBtn, done, hint);
    photo.appendChild(bar);
    this.photo = photo;
    this.bar = bar;

    // Toast
    const toast = el('div', 'ds-toast');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    this.toastEl = toast;

    host.append(title, menu, photo, toast);
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
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pointermove', this.onActivity, { passive: true });
    window.addEventListener('pointerdown', this.onActivity, { passive: true });

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
  }

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

  private setQuality(q: Quality): void {
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
    for (const q of ['low', 'high'] as const) {
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
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') this.setQuality('low');
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') this.setQuality('high');
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
