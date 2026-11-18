import './touch.css';

export interface TouchHooks {
  /** Camera drag in CSS pixels since the last event. */
  onLook(dx: number, dy: number): void;
  /** Pinch (photo mode only): >1 means fingers moved apart since the last event. */
  onZoom(factor: number): void;
  /** Fly button pressed down. */
  onJump(): void;
  /** Reserved; not called by the touch layer. */
  onPause(): void;
  /** Talk button pressed. */
  onTalk(): void;
  /** Board button pressed: step on or off. */
  onBoard(): void;
  /** Spyglass chosen from the Tools fan. */
  onSpyglass(): void;
  /** Flute chosen from the Tools fan. */
  onFlute(): void;
  /** Bedroll chosen from the Tools fan. */
  onBedroll(): void;
}

export type TouchMode = 'off' | 'play' | 'photo';

const STICK_RADIUS = 56;
const DEAD_ZONE = 0.12;
// The stick only follows the finger once it is dragged this far out, so there is room to overshoot.
const FOLLOW_EDGE = 1.5;
const STICK_SIDE = 0.45;
const IDLE_MS = 4000;

interface Slot {
  id: number;
  x: number;
  y: number;
}

const FLY_SVG =
  '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  '<path d="M6 17.5 14 9.5l8 8"/><path d="M9.5 22 14 17.5l4.5 4.5"/></svg>';
const TALK_SVG =
  '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  '<path d="M7 8.5h14a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-7l-4 3.5v-3.5H7A1.5 1.5 0 0 1 5.5 17v-7A1.5 1.5 0 0 1 7 8.5z"/></svg>';
const PICK_SVG =
  '<svg class="aster-touch__pick" viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  '<path d="M6 12.5c3.5-4.6 12.5-4.6 16 0"/><path d="M14 9v13"/></svg>';
// a camel from the side: rump, hump, neck and head, the belly and a leg at each end
const RIDE_SVG =
  '<svg class="aster-touch__ride" viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  '<path d="M5.5 22v-7.5c0-1.700 1-2.700 2.500-2.700 1.100 0 1.700-.7 2.300-2 .6-1.400 1.500-2.300 2.900-2.300s2.300.9 2.900 2.300c.5 1.200 1.100 1.900 2.100 1.900 1.200 0 2-.9 2-2.100V7.500c0-1 .8-1.800 1.800-1.800h1.500"/>' +
  '<path d="M5.5 17h12M17.5 11.6V22"/></svg>';
const BOARD_SVG =
  '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  '<path d="M5 19.5c0-1.2 4-2 9-2s9 .8 9 2-4 2-9 2-9-.8-9-2z"/><path d="M11 17V9.5M17 17V9.5"/></svg>';
const DOT = 'style="fill:currentColor;stroke:none"';
// a satchel: what is carried
const TOOLS_SVG =
  '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  '<path d="M6.5 11.5h15l-1.2 10h-12.6z"/><path d="M10.5 11.5V9a3.5 3.5 0 0 1 7 0v2.5"/><path d="M11 15.5h6"/></svg>';
// a glass drawn out, wide end up
const SPYGLASS_SVG =
  '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  '<path d="M5.5 20.5 8 23l5.5-5-2.5-2.5z"/><path d="M11 15.5 13.5 18l8-7.5L17.500 6.500z"/><path d="M16.500 5.500 22.500 11.500"/></svg>';
// a reed, with its finger holes
const FLUTE_SVG =
  '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  `<path d="M5 21 20.5 5.500 22.500 7.500 7 23z"/><circle cx="11" cy="17" r="0.9" ${DOT}/><circle cx="14" cy="14" r="0.9" ${DOT}/><circle cx="17" cy="11" r="0.9" ${DOT}/></svg>`;
const BEDROLL_SVG =
  '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  '<path d="M6 11h13a4 4 0 0 1 0 8H6a2.5 4 0 0 1 0-8z"/><path d="M19 11v8"/></svg>';
const DROP_SVG =
  '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  '<path d="M7 11.5l7 7 7-7"/></svg>';

export class TouchControls {
  used = false;
  moveX = 0;
  moveZ = 0;
  flyHeld = false;
  /** Drop button held: fall out of the glide. Only shown while airborne. */
  dropHeld = false;
  onFirstTouch: (() => void) | null = null;

  private readonly hooks: TouchHooks;
  private readonly layer: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly dot: HTMLDivElement;
  private readonly fly: HTMLButtonElement;
  private readonly drop: HTMLButtonElement;
  private readonly talk: HTMLButtonElement;
  private readonly boardBtn: HTMLButtonElement;
  private readonly toolsBtn: HTMLButtonElement;
  private readonly toolItems: { btn: HTMLButtonElement; fire: () => void }[];

  private mode: TouchMode = 'off';
  private mouseActive = false;

  private stickId = -1;
  private stickCx = 0;
  private stickCy = 0;

  private flyId = -1;
  private dropId = -1;
  private airborne = false;

  private readonly slots: Slot[] = [
    { id: -1, x: 0, y: 0 },
    { id: -1, x: 0, y: 0 },
  ];
  private pinchDist = 0;

  private idleTimer = 0;

  constructor(root: HTMLElement, hooks: TouchHooks) {
    this.hooks = hooks;

    const layer = document.createElement('div');
    layer.className = 'aster-touch';
    this.layer = layer;

    this.ring = document.createElement('div');
    this.ring.className = 'aster-touch__ring';
    this.dot = document.createElement('div');
    this.dot.className = 'aster-touch__dot';

    const fly = document.createElement('button');
    fly.type = 'button';
    fly.className = 'aster-touch__fly';
    fly.setAttribute('aria-label', 'Leap, hold to rise, let go to glide');
    fly.tabIndex = -1;
    fly.innerHTML = FLY_SVG;
    this.fly = fly;

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'aster-touch__drop';
    drop.setAttribute('aria-label', 'Drop');
    drop.tabIndex = -1;
    drop.innerHTML = DROP_SVG;
    this.drop = drop;

    // Talk: appears only while someone is in reach.
    const talk = document.createElement('button');
    talk.type = 'button';
    talk.className = 'aster-touch__talk';
    talk.setAttribute('aria-label', 'Talk');
    talk.tabIndex = -1;
    talk.innerHTML = TALK_SVG + PICK_SVG + RIDE_SVG;
    this.talk = talk;

    // Board: appears once there is a board to step on or off.
    const board = document.createElement('button');
    board.type = 'button';
    board.className = 'aster-touch__talk aster-touch__board';
    board.setAttribute('aria-label', 'Step on or off the board');
    board.tabIndex = -1;
    board.innerHTML = BOARD_SVG;
    this.boardBtn = board;

    // Tools: left of the talk button, shown once any of the spyglass, flute or bedroll is owned.
    // Tapped, it fans the owned ones out above it.
    const mk = (cls: string, label: string, svg: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `aster-touch__talk aster-touch__tool ${cls}`;
      b.setAttribute('aria-label', label);
      b.tabIndex = -1;
      b.innerHTML = svg;
      return b;
    };
    this.toolsBtn = mk('aster-touch__tools', 'Tools', TOOLS_SVG);
    const spyglass = mk('aster-touch__tool-item aster-touch__tool-spyglass', 'Spyglass', SPYGLASS_SVG);
    const flute = mk('aster-touch__tool-item aster-touch__tool-flute', 'Flute', FLUTE_SVG);
    const bedroll = mk('aster-touch__tool-item aster-touch__tool-bedroll', 'Bedroll', BEDROLL_SVG);
    this.toolItems = [
      { btn: spyglass, fire: () => hooks.onSpyglass() },
      { btn: flute, fire: () => hooks.onFlute() },
      { btn: bedroll, fire: () => hooks.onBedroll() },
    ];

    layer.append(this.ring, this.dot, fly, drop, talk, board, this.toolsBtn, spyglass, flute, bedroll);
    root.appendChild(layer);

    layer.addEventListener('pointerdown', this.onDown);
    layer.addEventListener('pointermove', this.onMove);
    layer.addEventListener('pointerup', this.onUp);
    layer.addEventListener('pointercancel', this.onUp);
    layer.addEventListener('lostpointercapture', this.onUp);
    layer.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('pointerdown', this.onWindowPointer, true);
    window.addEventListener('pointermove', this.onWindowPointer, true);
  }

  setMode(mode: TouchMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.releaseAll();
    this.closeFan();
    const cl = this.layer.classList;
    cl.toggle('aster-touch--play', mode === 'play');
    cl.remove('aster-touch--idle');
    this.armIdle();
    this.syncPointerEvents();
  }

  /** Show the drop button only while the figure is in the air. */
  setAirborne(air: boolean): void {
    if (air === this.airborne) return;
    this.airborne = air;
    this.layer.classList.toggle('aster-touch--air', air);
    if (!air) this.endDrop();
  }

  /**
   * Show the talk button while there is someone to talk to. With nobody in reach it becomes
   * the button for a beast in reach to climb onto, or for getting off the one ridden (`ride`),
   * and failing that the pick's, wherever there is ground to strike (`dig`).
   */
  setTalk(on: boolean, dig = false, ride: 'on' | 'off' | null = null): void {
    const riding = ride !== null && !on;
    const digging = dig && !on && !riding;
    this.layer.classList.toggle('aster-touch--talk', on || dig || riding);
    this.layer.classList.toggle('aster-touch--ride', riding);
    this.layer.classList.toggle('aster-touch--dig', digging);
    const label = riding ? (ride === 'on' ? 'Ride' : 'Get off') : digging ? 'Swing the pick' : 'Talk';
    if (this.talk.getAttribute('aria-label') !== label) this.talk.setAttribute('aria-label', label);
  }

  /** Show the board button once there is a board; it reads as pressed while riding. */
  setBoard(has: boolean, on: boolean): void {
    this.layer.classList.toggle('aster-touch--board', has);
    this.boardBtn.classList.toggle('is-held', on);
  }

  /** Show the Tools button when any of the three is owned; the fan lists only those owned. */
  setTools(t: { spyglass: boolean; flute: boolean; bedroll: boolean }): void {
    const own = [t.spyglass, t.flute, t.bedroll];
    const cl = this.layer.classList;
    cl.toggle('aster-touch--tools', own.some(Boolean));
    // Owned items stack upward from the Tools button with no gaps.
    let slot = 0;
    this.toolItems.forEach(({ btn }, i) => {
      btn.classList.toggle('is-owned', own[i]);
      if (own[i]) btn.style.setProperty('--aster-slot', String(slot++));
    });
    if (!own.some(Boolean)) this.closeFan();
  }

  private closeFan(): void {
    this.layer.classList.remove('aster-touch--fan');
    this.toolsBtn.classList.remove('is-held');
  }

  private syncPointerEvents(): void {
    const on = this.used && this.mode !== 'off' && !this.mouseActive;
    this.layer.classList.toggle('aster-touch--on', on);
  }

  private static isTouch(e: PointerEvent): boolean {
    return e.pointerType === 'touch' || e.pointerType === 'pen';
  }

  private onWindowPointer = (e: PointerEvent): void => {
    if (TouchControls.isTouch(e)) {
      if (e.type === 'pointerdown') {
        this.layer.classList.remove('aster-touch--idle');
        this.armIdle();
      }
      let changed = false;
      if (this.mouseActive) {
        this.mouseActive = false;
        changed = true;
      }
      if (!this.used) {
        this.used = true;
        changed = true;
        if (this.onFirstTouch) this.onFirstTouch();
      }
      if (changed) this.syncPointerEvents();
    } else if (this.used && !this.mouseActive) {
      // A real mouse on a hybrid device: let it through to the game.
      this.mouseActive = true;
      this.syncPointerEvents();
    }
  };

  private armIdle(): void {
    window.clearTimeout(this.idleTimer);
    if (this.mode !== 'play') return;
    this.idleTimer = window.setTimeout(() => {
      this.layer.classList.add('aster-touch--idle');
    }, IDLE_MS);
  }

  private onDown = (e: PointerEvent): void => {
    if (!TouchControls.isTouch(e) || this.mode === 'off') return;
    e.preventDefault();
    const id = e.pointerId;
    if (id === this.stickId || id === this.flyId || id === this.dropId) return;
    if (this.findSlot(id) >= 0) return;

    const x = e.clientX;
    const y = e.clientY;

    if (this.mode === 'play') {
      const t = e.target as Node | null;
      const onTools = !!t && (t === this.toolsBtn || this.toolsBtn.contains(t));
      const item = t ? this.toolItems.find((i) => i.btn === t || i.btn.contains(t)) : undefined;
      if (this.layer.classList.contains('aster-touch--fan') && !onTools && !item) this.closeFan();
      if (onTools) {
        if (this.layer.classList.contains('aster-touch--tools')) {
          const open = this.layer.classList.toggle('aster-touch--fan');
          this.toolsBtn.classList.toggle('is-held', open);
        }
        return;
      }
      if (item) {
        if (this.layer.classList.contains('aster-touch--fan') && item.btn.classList.contains('is-owned')) {
          this.closeFan();
          item.fire();
        }
        return;
      }
      if (t && (t === this.fly || this.fly.contains(t))) {
        if (this.flyId < 0) {
          this.flyId = id;
          this.flyHeld = true;
          this.fly.classList.add('is-held');
          this.capture(id);
          this.hooks.onJump();
        }
        return;
      }
      if (t && (t === this.talk || this.talk.contains(t))) {
        if (this.layer.classList.contains('aster-touch--talk')) this.hooks.onTalk();
        return;
      }
      if (t && (t === this.boardBtn || this.boardBtn.contains(t))) {
        if (this.layer.classList.contains('aster-touch--board')) this.hooks.onBoard();
        return;
      }
      if (t && (t === this.drop || this.drop.contains(t))) {
        if (this.dropId < 0 && this.airborne) {
          this.dropId = id;
          this.dropHeld = true;
          this.drop.classList.add('is-held');
          this.capture(id);
        }
        return;
      }
      if (x < window.innerWidth * STICK_SIDE) {
        if (this.stickId < 0) {
          this.stickId = id;
          this.stickCx = x;
          this.stickCy = y;
          this.capture(id);
          this.placeStick(x, y, x, y);
          this.layer.classList.add('aster-touch--stick');
        }
        return;
      }
    }

    // Look pointer (right side in play, anywhere in photo).
    const free = this.findSlot(-1);
    if (free < 0) return;
    const s = this.slots[free];
    s.id = id;
    s.x = x;
    s.y = y;
    this.capture(id);
    if (this.slots[0].id >= 0 && this.slots[1].id >= 0) {
      this.pinchDist = this.slotDist();
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!TouchControls.isTouch(e)) return;
    const id = e.pointerId;

    if (id === this.stickId) {
      e.preventDefault();
      this.moveStick(e.clientX, e.clientY);
      return;
    }
    if (id === this.flyId || id === this.dropId) {
      e.preventDefault();
      return;
    }
    const i = this.findSlot(id);
    if (i < 0) return;
    e.preventDefault();
    const s = this.slots[i];
    const x = e.clientX;
    const y = e.clientY;
    const dx = x - s.x;
    const dy = y - s.y;
    s.x = x;
    s.y = y;

    // Pinch only zooms in photo mode. While playing it would push the eye in on the wanderer, so a
    // second finger on the look side keeps turning the view instead.
    if (this.mode === 'photo' && this.slots[0].id >= 0 && this.slots[1].id >= 0) {
      const d = this.slotDist();
      if (this.pinchDist > 0 && d > 0) {
        const f = d / this.pinchDist;
        if (f !== 1 && isFinite(f)) this.hooks.onZoom(f);
      }
      this.pinchDist = d;
    } else if (dx !== 0 || dy !== 0) {
      this.hooks.onLook(dx, dy);
    }
  };

  private onUp = (e: PointerEvent): void => {
    const id = e.pointerId;
    if (id === this.stickId) {
      if (e.type !== 'lostpointercapture') e.preventDefault();
      this.endStick();
    } else if (id === this.flyId) {
      if (e.type !== 'lostpointercapture') e.preventDefault();
      this.endFly();
    } else if (id === this.dropId) {
      if (e.type !== 'lostpointercapture') e.preventDefault();
      this.endDrop();
    } else {
      const i = this.findSlot(id);
      if (i >= 0) {
        if (e.type !== 'lostpointercapture') e.preventDefault();
        this.slots[i].id = -1;
        this.pinchDist = 0;
      }
    }
    if (e.type === 'pointerup' || e.type === 'pointercancel') {
      try {
        this.layer.releasePointerCapture(id);
      } catch {
        /* already released */
      }
    }
  };

  private moveStick(x: number, y: number): void {
    let dx = x - this.stickCx;
    let dy = y - this.stickCy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > STICK_RADIUS * FOLLOW_EDGE) {
      const k = (len - STICK_RADIUS * FOLLOW_EDGE) / len;
      this.stickCx += dx * k;
      this.stickCy += dy * k;
      dx = x - this.stickCx;
      dy = y - this.stickCy;
    }
    const l2raw = Math.sqrt(dx * dx + dy * dy);
    if (l2raw > STICK_RADIUS) {
      dx *= STICK_RADIUS / l2raw;
      dy *= STICK_RADIUS / l2raw;
    }
    const l2 = Math.sqrt(dx * dx + dy * dy);
    const mag = Math.min(1, l2 / STICK_RADIUS);
    if (mag < DEAD_ZONE || l2 === 0) {
      this.moveX = 0;
      this.moveZ = 0;
    } else {
      const m = (mag - DEAD_ZONE) / (1 - DEAD_ZONE);
      this.moveX = (dx / l2) * m;
      this.moveZ = (-dy / l2) * m;
    }
    this.placeStick(this.stickCx, this.stickCy, this.stickCx + dx, this.stickCy + dy);
  }

  private placeStick(cx: number, cy: number, tx: number, ty: number): void {
    this.ring.style.transform = `translate(${cx}px,${cy}px)`;
    this.dot.style.transform = `translate(${tx}px,${ty}px)`;
  }

  private endStick(): void {
    this.stickId = -1;
    this.moveX = 0;
    this.moveZ = 0;
    this.layer.classList.remove('aster-touch--stick');
  }

  private endFly(): void {
    this.flyId = -1;
    this.flyHeld = false;
    this.fly.classList.remove('is-held');
  }

  private endDrop(): void {
    this.dropId = -1;
    this.dropHeld = false;
    this.drop.classList.remove('is-held');
  }

  private releaseAll(): void {
    this.endStick();
    this.endFly();
    this.endDrop();
    this.slots[0].id = -1;
    this.slots[1].id = -1;
    this.pinchDist = 0;
  }

  private findSlot(id: number): number {
    if (this.slots[0].id === id) return 0;
    if (this.slots[1].id === id) return 1;
    return -1;
  }

  private slotDist(): number {
    const a = this.slots[0];
    const b = this.slots[1];
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private capture(id: number): void {
    try {
      this.layer.setPointerCapture(id);
    } catch {
      /* pointer may already be gone */
    }
  }
}
