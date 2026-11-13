import './ui.css';

export type Quality = 'mobile' | 'low' | 'high';
/** How long the title card stays up before it fades into the game by itself. */
const TITLE_HOLD_MS = 3200;

export type UIState = 'title' | 'playing' | 'menu' | 'photo';

export interface UIHooks {
  onBegin(): void;
  onResume(): void;
  onPause(): void;
  onVolume(v: number): void;
  onMusic(v: number): void;
  onEffects(v: number): void;
  /** True while a level is being adjusted, so the game can let the real mix through. */
  onLevelPreview(active: boolean): void;
  /** Play one short effect so the effects level can be judged by ear. */
  onEffectsSample(): void;
  onQuality(q: Quality): void;
  onPhoto(active: boolean): void;
  onHideFigure(hidden: boolean): void;
  onCapture(): void;
  onStyle(index: number): void;
  /** Whether a spawn may be saved where the player stands (open ground only). */
  canSetSpawn(): boolean;
  /** Save here, facing the way the player looks, as where to arrive. Returns false if it could not be kept. */
  onSetSpawn(): boolean;
  onClearSpawn(): void;
  /** Move to a fresh random arrival point now. */
  onRespawn(): void;
  /** Forget the journey and the saved spawn (settings stay) and start again. */
  onReset(): void;
}

type TabId = 'audio' | 'graphics' | 'controls' | 'game';
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'audio', label: 'Audio' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'controls', label: 'Controls' },
  { id: 'game', label: 'Game' },
];
/** How long an inline status line stays up, in ms. */
const STATUS_MS = 2600;

export interface StyleChoice {
  id: string;
  name: string;
}

const KEY_VOLUME = 'aster.volume';
const KEY_MUSIC = 'aster.music';
const KEY_EFFECTS = 'aster.effects';
/** How long the true mix stays audible after a level is let go, in ms. */
const PREVIEW_HOLD = 500;
const KEY_QUALITY = 'aster.quality';
const KEY_STYLE = 'aster.style';
/** What the player has found out so far. The controls list only shows what has been earned. */
export interface Known {
  talk: boolean;
  board: boolean;
  carpet: boolean;
  dig: boolean;
}

/** One line of the controls list: what you do, the keys for it, and a short note. */
interface ControlRow {
  action: string;
  keys?: string[];
  note?: string;
}
interface ControlSection {
  title: string;
  rows: ControlRow[];
}

function keyControls(k: Known): ControlSection[] {
  const wasd = ['W', 'A', 'S', 'D'];
  const fly: ControlRow[] = [
    { action: 'Leap', keys: ['Space'], note: 'hold to rise, release to glide' },
    { action: 'Steer', keys: wasd },
    { action: 'Boost', keys: ['Shift'] },
    { action: 'Drop', keys: ['Space', 'Space'], note: 'double-tap in the air' },
  ];
  if (k.carpet) fly.push({ action: 'Carpet', note: 'unrolls when you fly, and flies faster' });
  const out: ControlSection[] = [
    {
      title: 'Move',
      rows: [
        { action: 'Walk', keys: wasd, note: 'or arrow keys' },
        { action: 'Run', keys: ['Shift'] },
        { action: 'Look', note: 'Mouse drag or move' },
        { action: 'Zoom', note: 'Mouse wheel' },
      ],
    },
    { title: 'Fly', rows: fly },
  ];
  const act: ControlRow[] = [];
  if (k.talk) act.push({ action: 'Talk', keys: ['E'] });
  if (k.dig) act.push({ action: 'Swing pick', keys: ['E'], note: 'when nobody is near' });
  if (k.board) act.push({ action: 'Board', keys: ['Q'], note: 'step on or off. On it, WASD glide and Shift boosts' });
  if (act.length) out.push({ title: 'Interact', rows: act });
  out.push({ title: 'Menu', rows: [{ action: 'Pause', keys: ['Esc'] }] });
  return out;
}

function touchControls(k: Known): ControlSection[] {
  const fly: ControlRow[] = [
    { action: 'Leap', note: 'Leap button. Hold to rise, release to glide' },
    { action: 'Steer', note: 'Left thumb stick' },
    { action: 'Boost', note: 'Push the stick past the ring' },
    { action: 'Drop', note: 'Small button in the air' },
  ];
  if (k.carpet) fly.push({ action: 'Carpet', note: 'unrolls when you fly, and flies faster' });
  const out: ControlSection[] = [
    {
      title: 'Move',
      rows: [
        { action: 'Walk', note: 'Left thumb stick' },
        { action: 'Run', note: 'Push the stick past the ring' },
        { action: 'Look', note: 'Right thumb drag' },
        { action: 'Zoom', note: 'Pinch' },
      ],
    },
    { title: 'Fly', rows: fly },
  ];
  const act: ControlRow[] = [];
  if (k.talk) act.push({ action: 'Talk', note: 'Speech button, when someone is near' });
  if (k.dig) act.push({ action: 'Swing pick', note: 'Pick button, when nobody is near' });
  if (k.board) act.push({ action: 'Board', note: 'Board button to step on or off. On it, the stick glides' });
  if (act.length) out.push({ title: 'Interact', rows: act });
  out.push({ title: 'Menu', rows: [{ action: 'Pause', note: 'Pause button' }] });
  return out;
}
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

function fillControls(host: HTMLElement, sections: ControlSection[]): void {
  host.replaceChildren(
    ...sections.map((sec, i) => {
      const group = el('section', 'aster-ctl');
      const h = el('h3', 'aster-ctl__title', sec.title);
      h.id = `aster-ctl-${i}`;
      const dl = el('dl', 'aster-ctl__list');
      for (const r of sec.rows) {
        const row = el('div', 'aster-ctl__row');
        const dd = el('dd', 'aster-ctl__what');
        if (r.keys) {
          const caps = el('span', 'aster-ctl__keys');
          for (const key of r.keys) caps.appendChild(el('kbd', 'aster-kbd', key));
          dd.appendChild(caps);
        }
        if (r.note) dd.appendChild(el('span', 'aster-ctl__note', r.note));
        row.append(el('dt', 'aster-ctl__action', r.action), dd);
        dl.appendChild(row);
      }
      group.append(h, dl);
      return group;
    }),
  );
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
  private readonly qualityBtns: Record<Quality, HTMLButtonElement>;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly captureBtn: HTMLButtonElement;
  private readonly hideBtn: HTMLButtonElement;
  private readonly panelControls: HTMLElement;
  private readonly tabBtns: Record<TabId, HTMLButtonElement>;
  private readonly tabPanes: Record<TabId, HTMLElement>;
  private readonly spawnBtn: HTMLButtonElement;
  private readonly spawnHint: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly resetCancel: HTMLButtonElement;
  private readonly resetAsk: HTMLElement;
  private tab: TabId = 'audio';
  private statusTimer = 0;
  private readonly photoHint: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly styleNames: HTMLElement[] = [];
  private readonly styles: StyleChoice[];
  private styleI = 0;
  private readonly rotateEl: HTMLElement;
  private readonly portraitMq: MediaQueryList | null;
  private touch = false;
  private known: Known = { talk: false, board: false, carpet: false, dig: false };
  private touchIdleTimer = 0;
  private rotateTimer = 0;
  private rotateDone = false;

  private previewTimer = 0;
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

    const storedQ = readStore(KEY_QUALITY);
    this.quality =
      storedQ === 'mobile' || storedQ === 'low' || storedQ === 'high' ? storedQ : (initial?.quality ?? 'high');

    const host = el('div', 'aster-ui');
    host.dataset.state = 'title';
    this.host = host;

    // Title card
    const title = el('div', 'aster-layer aster-title is-on');
    title.appendChild(el('h1', 'aster-title__name', 'Aster'));
    title.appendChild(el('p', 'aster-title__line', 'Take the long way'));
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

    // Tabs. Resume and Photo mode sit below them, always in reach.
    const tablist = el('div', 'aster-tabs');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Settings');
    const panes = el('div', 'aster-panes');
    this.tabBtns = {} as Record<TabId, HTMLButtonElement>;
    this.tabPanes = {} as Record<TabId, HTMLElement>;
    for (const t of TABS) {
      const tab = el('button', 'aster-tab', t.label);
      tab.type = 'button';
      tab.id = `aster-tab-${t.id}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `aster-pane-${t.id}`);
      tab.addEventListener('click', () => this.selectTab(t.id));
      const pane = el('div', 'aster-pane');
      pane.id = `aster-pane-${t.id}`;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', tab.id);
      this.tabBtns[t.id] = tab;
      this.tabPanes[t.id] = pane;
      tablist.appendChild(tab);
      panes.appendChild(pane);
    }

    // Audio. Music and Effects sit under the overall Volume; 100 on each is the mix as tuned.
    this.tabPanes.audio.append(
      this.level('aster-volume', 'Volume', KEY_VOLUME, initial?.volume ?? 0.7, (v) => this.hooks.onVolume(v)),
      this.level('aster-music', 'Music', KEY_MUSIC, 1, (v) => this.hooks.onMusic(v)),
      this.level(
        'aster-effects',
        'Effects',
        KEY_EFFECTS,
        0.7,
        (v) => this.hooks.onEffects(v),
        () => this.hooks.onEffectsSample(),
      ),
    );

    const gfx = el('div', 'aster-field');
    const gfxHead = el('div', 'aster-field__head');
    const gfxLabel = el('span', undefined, 'Quality');
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
    this.tabPanes.graphics.appendChild(gfx);

    if (this.styles.length > 1) {
      const sty = el('div', 'aster-field');
      const styHead = el('div', 'aster-field__head');
      const styLabel = el('span', undefined, 'Style');
      styLabel.id = 'aster-style-label';
      styHead.appendChild(styLabel);
      sty.append(styHead, this.stylePicker('aster-pick aster-pick--wide', 'aster-style-label'));
      this.tabPanes.graphics.appendChild(sty);
    }

    // Controls: read-only, and only the set for the device in hand.
    this.panelControls = el('div', 'aster-panel__controls');
    fillControls(this.panelControls, keyControls(this.known));
    this.tabPanes.controls.appendChild(this.panelControls);

    // Game
    const game = this.tabPanes.game;
    const btn = (label: string, cls = 'aster-btn'): HTMLButtonElement => {
      const b = el('button', cls, label);
      b.type = 'button';
      return b;
    };
    this.spawnBtn = btn('Set spawn here');
    this.spawnHint = el('span', 'aster-hint');
    this.spawnHint.id = 'aster-spawn-hint';
    const clearBtn = btn('Clear saved spawn');
    const respawnBtn = btn('Respawn elsewhere');
    const spawnRow = el('div', 'aster-stack');
    spawnRow.append(this.spawnBtn, this.spawnHint, clearBtn, respawnBtn);
    this.statusEl = el('p', 'aster-status');
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');
    this.resetBtn = btn('Start over', 'aster-btn aster-btn--danger');
    const resetAsk = el('div', 'aster-confirm');
    resetAsk.hidden = true;
    resetAsk.setAttribute('role', 'group');
    resetAsk.setAttribute('aria-label', 'Start over');
    const resetQ = el('span', 'aster-confirm__q', 'Really reset?');
    resetQ.id = 'aster-reset-q';
    resetAsk.setAttribute('aria-labelledby', 'aster-reset-q');
    this.resetCancel = btn('Cancel');
    const resetYes = btn('Confirm', 'aster-btn aster-btn--danger');
    resetAsk.append(resetQ, this.resetCancel, resetYes);
    this.resetAsk = resetAsk;
    const danger = el('div', 'aster-danger');
    const dangerNote = el('p', 'aster-hint', 'Clears your journey and saved spawn. Settings stay.');
    danger.append(dangerNote, this.resetBtn, resetAsk);
    game.append(spawnRow, this.statusEl, danger);

    this.spawnBtn.addEventListener('click', () => {
      if (!this.hooks.canSetSpawn()) {
        this.syncSpawn();
        return;
      }
      this.say(this.hooks.onSetSpawn() ? 'Spawn saved' : 'Could not save the spawn');
    });
    clearBtn.addEventListener('click', () => {
      this.hooks.onClearSpawn();
      this.say('Saved spawn cleared');
    });
    respawnBtn.addEventListener('click', () => {
      this.closeMenu();
      this.hooks.onRespawn();
    });
    this.resetBtn.addEventListener('click', () => this.askReset(true));
    this.resetCancel.addEventListener('click', () => {
      this.askReset(false);
      this.resetBtn.focus();
    });
    resetYes.addEventListener('click', () => {
      resetYes.disabled = true;
      this.hooks.onReset();
    });

    panel.append(tablist, panes);

    const actions = el('div', 'aster-actions');
    this.resumeBtn = el('button', 'aster-btn aster-btn--primary', 'Resume');
    this.resumeBtn.type = 'button';
    const photoBtn = el('button', 'aster-btn', 'Photo mode');
    photoBtn.type = 'button';
    actions.append(this.resumeBtn, photoBtn);
    panel.appendChild(actions);
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
    this.syncQuality();
    this.syncStyle();
    this.selectTab('audio');
    this.resumeBtn.addEventListener('click', () => this.closeMenu());
    photoBtn.addEventListener('click', () => this.enterPhoto());
    this.captureBtn.addEventListener('click', () => this.hooks.onCapture());
    this.hideBtn.addEventListener('click', () => this.setFigureHidden(!this.figureHidden));
    done.addEventListener('click', () => this.exitPhoto());
    title.addEventListener('click', () => this.begin());
    // The title card holds a moment, then fades on its own into the world.
    window.setTimeout(() => this.begin(), TITLE_HOLD_MS);
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
    this.syncSpawn();
    this.resumeBtn.focus();
  }

  closeMenu(): void {
    if (this._state !== 'menu') return;
    this.askReset(false);
    this.say('');
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
    this.syncControls();
    this.fillPhotoHint();
    this.syncPause();
    this.syncRotate();
  }

  /** What the controls list may show: it grows as the player meets people and is given things. */
  setKnown(k: Known): void {
    this.known = { ...k };
    this.syncControls();
  }

  private syncControls(): void {
    fillControls(this.panelControls, this.touch ? touchControls(this.known) : keyControls(this.known));
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

  private selectTab(id: TabId, focus = false): void {
    this.tab = id;
    for (const t of TABS) {
      const on = t.id === id;
      this.tabBtns[t.id].setAttribute('aria-selected', String(on));
      this.tabBtns[t.id].tabIndex = on ? 0 : -1;
      this.tabPanes[t.id].hidden = !on;
    }
    this.askReset(false);
    this.say('');
    if (id === 'game') this.syncSpawn();
    if (focus) this.tabBtns[id].focus();
  }

  /** Left and Right (and Home, End) move between tabs, which open as they are reached. */
  private arrowTab(e: KeyboardEvent): boolean {
    if (!(e.target instanceof HTMLElement) || e.target.getAttribute('role') !== 'tab') return false;
    const i = TABS.findIndex((t) => t.id === this.tab);
    const n = TABS.length;
    let j: number;
    if (e.key === 'ArrowRight') j = (i + 1) % n;
    else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    else return false;
    this.selectTab(TABS[j].id, true);
    return true;
  }

  /** The spawn button follows where the player stands: open ground only. */
  private syncSpawn(): void {
    const ok = this.hooks.canSetSpawn();
    this.spawnBtn.disabled = !ok;
    this.spawnHint.textContent = ok ? '' : 'Surface only';
    this.spawnHint.hidden = ok;
    if (ok) this.spawnBtn.removeAttribute('aria-describedby');
    else this.spawnBtn.setAttribute('aria-describedby', 'aster-spawn-hint');
  }

  /** A short line of feedback in the Game tab. */
  private say(text: string): void {
    window.clearTimeout(this.statusTimer);
    this.statusEl.textContent = text;
    if (text) this.statusTimer = window.setTimeout(() => (this.statusEl.textContent = ''), STATUS_MS);
  }

  /** Start over asks twice: the button turns into a question with Confirm and Cancel. */
  private askReset(on: boolean): void {
    this.resetBtn.hidden = on;
    this.resetAsk.hidden = !on;
    if (on) this.resetCancel.focus();
  }

  private chooseQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    writeStore(KEY_QUALITY, q);
    this.syncQuality();
    this.hooks.onQuality(q);
  }

  /**
   * One 0..100 level slider with its label and readout. Restores the saved value, applies it
   * straight away, and saves and applies every change as it happens. `sample` is played each
   * time the level is settled on (pointer release or a keyboard step).
   */
  private level(
    id: string,
    label: string,
    key: string,
    fallback: number,
    apply: (v: number) => void,
    sample?: () => void,
  ): HTMLElement {
    const stored = parseFloat(readStore(key) ?? '');
    let value = clamp01(Number.isFinite(stored) ? stored : fallback);

    const field = el('div', 'aster-field');
    const head = el('div', 'aster-field__head');
    const lab = el('label', undefined, label);
    lab.htmlFor = id;
    const out = el('span', 'aster-field__value');
    head.append(lab, out);
    const slider = el('input', 'aster-range');
    slider.id = id;
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    field.append(head, slider);

    const sync = (): void => {
      const pct = Math.round(value * 100);
      slider.value = String(pct);
      slider.style.setProperty('--aster-fill', `${pct}%`);
      slider.setAttribute('aria-valuetext', `${pct} percent`);
      out.textContent = String(pct);
    };
    sync();
    apply(value);

    slider.addEventListener('pointerdown', () => {
      this.previewLevels();
      const up = (): void => {
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        this.releaseLevels();
      };
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    slider.addEventListener('input', () => {
      this.previewLevels();
      value = clamp01(Number(slider.value) / 100);
      writeStore(key, String(value));
      sync();
      apply(value);
    });
    slider.addEventListener('change', () => {
      sample?.();
      this.releaseLevels();
    });
    return field;
  }

  /** The pause menu muffles the game; let the true mix through while a level is in hand. */
  private previewLevels(): void {
    window.clearTimeout(this.previewTimer);
    this.previewTimer = 0;
    this.hooks.onLevelPreview(true);
  }

  private releaseLevels(): void {
    window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0;
      this.hooks.onLevelPreview(false);
    }, PREVIEW_HOLD);
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
      } else if (
        (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') &&
        (this.arrowTab(e) || (e.key.startsWith('Arrow') && this.arrowSegment(e)))
      ) {
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
