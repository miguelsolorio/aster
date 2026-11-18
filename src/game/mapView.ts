// The map: a sheet of parchment over the view, drawn in ink and wash. Ground the wanderer has
// seen is washed in its colours; the rest lies under a dusk veil. Places come upon are inked
// in, and an errand is a dashed round over roughly where to look, whether or not anyone has
// been there. North is up: east is +x, south is +z.
import './map.css';
import { ATLAS_CELL, cellKey, keyX, keyZ, type Area, type Atlas } from './atlas';
import { findName, isFindKind } from './finds';

/** An errand, as the map shows it: the round to look in, and what for. */
export interface MapHint extends Area {
  label: string;
}

export interface MapState {
  x: number;
  z: number;
  /** The way the wanderer faces: 0 is +z, a quarter turn is +x. */
  heading: number;
  camp: { x: number; z: number } | null;
  /** Places marked through the spyglass: x then z for each. */
  sighted: readonly number[];
  hints: readonly MapHint[];
}

/** What the ground is at the middle of a cell, as far as the map cares. */
export interface Ground {
  /** How much the ground rises toward the south-east over a step (m per m): lit from the north-west. */
  lit: number;
  rock: number;
  salt: number;
  green: number;
  snow: number;
  water: boolean;
  /** Streets and roofs. */
  town: number;
}

type RGB = readonly [number, number, number];
const SAND: RGB = [233, 207, 153];
const ROCK: RGB = [171, 131, 95];
const SALT: RGB = [241, 234, 217];
const SNOW: RGB = [247, 245, 240];
const GREEN: RGB = [160, 171, 114];
const WATER: RGB = [104, 157, 160];
const TOWN: RGB = [205, 158, 118];
const PLAIN = (SAND[0] << 16) | (SAND[1] << 8) | SAND[2];

/** The wash a cell is given, packed 0xRRGGBB. */
export function groundInk(g: Ground): number {
  if (g.water) return (WATER[0] << 16) | (WATER[1] << 8) | WATER[2];
  const c = [SAND[0], SAND[1], SAND[2]];
  const mix = (to: RGB, k: number): void => {
    const t = Math.min(1, Math.max(0, k));
    for (let i = 0; i < 3; i++) c[i] += (to[i] - c[i]) * t;
  };
  mix(SALT, g.salt);
  mix(ROCK, g.rock);
  mix(GREEN, g.green * 0.8);
  mix(TOWN, g.town * 0.85);
  mix(SNOW, g.snow);
  const shade = 1 + Math.min(0.1, Math.max(-0.2, g.lit * 0.55));
  const ch = (v: number): number => Math.min(255, Math.max(0, Math.round(v * shade)));
  return (ch(c[0]) << 16) | (ch(c[1]) << 8) | ch(c[2]);
}

const INK = '#3a2a1d';
const INK_SOFT = 'rgba(58, 42, 29, 0.62)';
const PAPER = '#ecdcb9';
const VEIL = '#b7a27d';
const RED = '#a23a22';
const GOLD = '#b9862f';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';

const TOWNS: Record<string, string> = { hill: 'Hill town', canyon: 'Canyon town', oasis: 'Oasis town', trade: 'Trading town' };
/** What a place on the map is called. */
export function placeName(kind: string): string {
  if (kind.startsWith('city:')) return TOWNS[kind.slice(5)] ?? 'Town';
  return isFindKind(kind) ? findName(kind) : '';
}

const MAP_SVG =
  '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  '<path d="M5.5 8.5 11 6.5l6 2 5.5-2v13L17 21.5l-6-2-5.5 2z"/><path d="M11 6.500v13M17 8.500v13"/></svg>';

const MIN_SCALE = 0.02; // px per metre: 50 km across a wide sheet
const MAX_SCALE = 0.32;
const OPEN_SCALE = 0.1;

type Ctx = CanvasRenderingContext2D;

/** Each kind of place as a few strokes of ink in a box about 14 px across, centred on the origin. */
function glyph(c: Ctx, kind: string): void {
  c.beginPath();
  switch (kind) {
    case 'hamlet':
    case 'mountain-village':
    case 'snow-village':
    case 'well-camp':
    case 'star-house':
    case 'salt-works':
    case 'glass-kilns':
    case 'ledge':
    case 'bridge':
    case 'caravanserai':
    case 'dyers-town':
    case 'wind-towers':
    case 'stepped-city':
      // a house, and a smaller one beside it
      c.moveTo(-6, 5);
      c.lineTo(-6, -1);
      c.lineTo(-2, -5);
      c.lineTo(2, -1);
      c.lineTo(2, 5);
      c.closePath();
      c.moveTo(2, 1);
      c.lineTo(4.5, -1.5);
      c.lineTo(7, 1);
      c.lineTo(7, 5);
      c.lineTo(2, 5);
      break;
    case 'temple':
      c.moveTo(-6.5, -2);
      c.lineTo(0, -6);
      c.lineTo(6.5, -2);
      c.closePath();
      for (const x of [-4.5, 0, 4.5]) {
        c.moveTo(x, -2);
        c.lineTo(x, 4.5);
      }
      c.moveTo(-6.5, 5);
      c.lineTo(6.5, 5);
      break;
    case 'watchtower':
    case 'lantern':
      c.moveTo(-2.5, 6);
      c.lineTo(-2, -2.5);
      c.lineTo(2, -2.5);
      c.lineTo(2.5, 6);
      c.moveTo(-3.5, -2.5);
      c.lineTo(-3.5, -5.5);
      c.lineTo(3.5, -5.5);
      c.lineTo(3.5, -2.5);
      c.closePath();
      break;
    case 'ruins':
      c.moveTo(-5, 5);
      c.lineTo(-5, -5);
      c.moveTo(-0.5, 5);
      c.lineTo(-0.5, -1.5);
      c.moveTo(4, 5);
      c.lineTo(4, 1.5);
      c.moveTo(-7, 5.5);
      c.lineTo(7, 5.5);
      c.moveTo(-6.5, -5);
      c.lineTo(-3.5, -5);
      break;
    case 'arch':
      c.moveTo(-6, 5.5);
      c.lineTo(-6, 0);
      c.arc(0, 0, 6, Math.PI, 0);
      c.lineTo(6, 5.5);
      c.moveTo(-2.5, 5.5);
      c.lineTo(-2.5, 0.5);
      c.arc(0, 0.5, 2.5, Math.PI, 0);
      c.lineTo(2.5, 5.5);
      break;
    case 'standing-stones':
      for (const [x, t] of [[-5, -2], [0, -6], [5, -3.5]]) {
        c.moveTo(x - 1.4, 5.5);
        c.lineTo(x - 1, t);
        c.lineTo(x + 1, t);
        c.lineTo(x + 1.4, 5.5);
      }
      break;
    case 'balancing-stones':
      c.ellipse(0, 3.2, 4.6, 2.6, 0, 0, Math.PI * 2);
      c.moveTo(3.2, -1.6);
      c.ellipse(0, -1.6, 3.2, 2.1, 0, 0, Math.PI * 2);
      c.moveTo(1.8, -5.2);
      c.ellipse(0, -5.2, 1.8, 1.4, 0, 0, Math.PI * 2);
      break;
    case 'oasis':
    case 'spring':
      // a drop
      c.moveTo(0, -6.5);
      c.bezierCurveTo(5.5, -0.5, 5, 6, 0, 6);
      c.bezierCurveTo(-5, 6, -5.5, -0.5, 0, -6.5);
      break;
    case 'grove':
      c.arc(0, -2, 4.6, 0, Math.PI * 2);
      c.moveTo(0, 2.6);
      c.lineTo(0, 6.5);
      break;
    case 'bones':
    case 'wreck': // (the bones' ribs for now, until the wreck has a mark of its own)
      c.moveTo(-7, 3.5);
      c.lineTo(7, 3.5);
      for (const x of [-4.5, -1, 2.5]) {
        c.moveTo(x, 3.5);
        c.quadraticCurveTo(x - 1, -5, x + 3.5, -5.5);
      }
      break;
    case 'fallen-star': // a four-pointed star over the dish it made
      c.moveTo(0, -7);
      c.quadraticCurveTo(0.6, -2.6, 4, -2);
      c.quadraticCurveTo(0.6, -1.4, 0, 3);
      c.quadraticCurveTo(-0.6, -1.4, -4, -2);
      c.quadraticCurveTo(-0.6, -2.6, 0, -7);
      c.moveTo(-6, 4.5);
      c.quadraticCurveTo(0, 8, 6, 4.5);
      break;
    case 'sundial':
      c.arc(0, 0.5, 5.8, 0, Math.PI * 2);
      c.moveTo(0, 0.5);
      c.lineTo(3.6, -4);
      c.moveTo(0, 0.5);
      c.lineTo(0, -3.2);
      break;
    case 'shell':
      c.arc(0, 0, 6, Math.PI * 0.15, Math.PI * 1.6);
      c.arc(1, 0.4, 3.4, Math.PI * 1.6, Math.PI * 0.7, true);
      break;
    case 'cavern':
    case 'cave':
      c.moveTo(-6.5, 5);
      c.arc(0, 5, 6.5, Math.PI, 0);
      c.closePath();
      break;
    case 'summit':
      c.moveTo(-7, 5.5);
      c.lineTo(-0.5, -6);
      c.lineTo(7, 5.5);
      c.moveTo(-3.3, -1);
      c.lineTo(-0.8, 0.8);
      c.lineTo(1, -1.2);
      c.lineTo(2.9, -0.8);
      break;
    default:
      c.arc(0, 0, 4, 0, Math.PI * 2);
  }
}

export class MapView {
  /** The places the wanderer has brought back, as the save keeps them. Set by the game. */
  revived: readonly { x: number; z: number }[] = [];
  isOpen = false;
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: Ctx;
  private readonly hintEl: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly tile = document.createElement('canvas');
  private readonly tctx: Ctx;
  private img: ImageData | null = null;
  private readonly grain: CanvasPattern | null;
  private readonly hatch: CanvasPattern | null;
  /** The wash of every cell worked out so far. */
  private readonly inks = new Map<number, number>();
  /** Cells seen but not yet washed: the newest are done first. */
  private readonly pending: number[];
  private cx = 0;
  private cz = 0;
  private scale = OPEN_SCALE;
  private w = 0;
  private h = 0;
  private dirty = false;
  private since = 0;
  private touch = false;
  private state: MapState | null = null;
  private readonly fingers = new Map<number, { x: number; y: number }>();

  /**
   * `ink` works out the wash for the cell whose middle is (x, z). `onToggle` is asked to
   * open or close the map (the game decides whether it may).
   */
  constructor(
    host: HTMLElement,
    private readonly atlas: Atlas,
    private readonly ink: (x: number, z: number) => number,
    onToggle: () => void,
  ) {
    this.pending = [...atlas.cells];
    const root = document.createElement('div');
    root.className = 'aster-map';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Map');
    root.setAttribute('aria-hidden', 'true');
    const sheet = document.createElement('div');
    sheet.className = 'aster-map__sheet';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'aster-map__canvas';
    this.canvas.setAttribute('role', 'img');
    const title = document.createElement('div');
    title.className = 'aster-map__title';
    title.textContent = 'The desert so far';
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'aster-map__hint';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'aster-map__close';
    close.setAttribute('aria-label', 'Close the map');
    close.textContent = '×';
    sheet.append(this.canvas, title, this.hintEl, close);
    root.append(sheet);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'aster-map-btn';
    button.setAttribute('aria-label', 'Map');
    button.tabIndex = -1;
    button.innerHTML = MAP_SVG;
    host.append(button, root);
    this.root = root;
    this.button = button;
    this.ctx = this.canvas.getContext('2d') as Ctx;
    this.tctx = this.tile.getContext('2d') as Ctx;
    this.grain = this.makeGrain();
    this.hatch = this.makeHatch();

    button.addEventListener('click', onToggle);
    close.addEventListener('click', onToggle);
    // a tap on the dark round the sheet puts it away
    root.addEventListener('pointerdown', (e) => {
      if (e.target === root) onToggle();
    });
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture?.(e.pointerId);
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    cv.addEventListener('pointermove', (e) => {
      const f = this.fingers.get(e.pointerId);
      if (!f) return;
      if (this.fingers.size === 1) this.panBy(f.x - e.clientX, f.y - e.clientY);
      else if (this.fingers.size === 2) {
        // two fingers: the distance between them is the zoom
        let other = f;
        for (const [id, o] of this.fingers) if (id !== e.pointerId) other = o;
        const was = Math.hypot(f.x - other.x, f.y - other.y);
        const now = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (was > 4 && now > 4) this.zoomBy(now / was);
      }
      f.x = e.clientX;
      f.y = e.clientY;
    });
    const up = (e: PointerEvent): void => void this.fingers.delete(e.pointerId);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('lostpointercapture', up);
    window.addEventListener('resize', () => {
      if (this.isOpen) this.fit();
    });
  }

  /** Whether fingers or keys are in use: which hint is shown, and whether the button is. */
  setTouch(on: boolean): void {
    this.touch = on;
    this.root.classList.toggle('is-touch', on);
    this.hintEl.textContent = on ? 'Drag to move · pinch to zoom' : 'M to close · W A S D to move · wheel to zoom';
  }

  /** Show the map button (touch, while playing and the map is shut). */
  setButton(show: boolean): void {
    this.button.classList.toggle('is-on', show && this.touch && !this.isOpen);
  }

  /** Newly seen cells, to be washed in. */
  fresh(keys: readonly number[]): void {
    for (const k of keys) this.pending.push(k);
  }

  open(s: MapState): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.state = s;
    // (wherever it was last slid to, it opens on the wanderer; the zoom is left as it was)
    this.cx = s.x;
    this.cz = s.z;
    this.root.classList.add('is-on');
    this.root.setAttribute('aria-hidden', 'false');
    this.button.classList.remove('is-on');
    const n = this.atlas.places.length;
    const errands = s.hints.map((h) => h.label).join(', ');
    this.canvas.setAttribute('aria-label', `Map of the ground you have seen. ${n} ${n === 1 ? 'place' : 'places'} known.${errands ? ` Marked: ${errands}.` : ''}`);
    this.fit();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.fingers.clear();
    this.root.classList.remove('is-on');
    this.root.setAttribute('aria-hidden', 'true');
  }

  /** Slide the view by a number of screen pixels. */
  panBy(dx: number, dy: number): void {
    this.cx += dx / this.scale;
    this.cz += dy / this.scale;
    this.dirty = true;
  }

  zoomBy(f: number): void {
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * f));
    if (s === this.scale) return;
    this.scale = s;
    this.dirty = true;
  }

  /**
   * Once a frame. Washes in a few of the cells still waiting, and while the map is open keeps
   * it drawn. `panX`, `panZ` are the keys held (-1..1).
   */
  update(dt: number, s: MapState | null, panX = 0, panZ = 0): void {
    this.work(this.isOpen ? 5 : 0.8);
    if (!this.isOpen) return;
    if (s) this.state = s;
    if (panX !== 0 || panZ !== 0) this.panBy(panX * 620 * dt, panZ * 620 * dt);
    // (now and then regardless: an errand may have changed, and the sheet may have been resized)
    this.since += dt;
    if (this.dirty || this.since > 0.5) {
      this.dirty = false;
      this.since = 0;
      this.draw();
    }
  }

  private work(ms: number): void {
    if (this.pending.length === 0) return;
    const t0 = performance.now();
    for (let i = 0; this.pending.length > 0; i++) {
      if ((i & 7) === 7 && performance.now() - t0 > ms) break;
      const key = this.pending.pop() as number;
      if (!this.inks.has(key)) this.inks.set(key, this.ink((keyX(key) + 0.5) * ATLAS_CELL, (keyZ(key) + 0.5) * ATLAS_CELL));
    }
    if (this.isOpen) this.dirty = true;
  }

  private fit(): void {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    const pw = Math.round(this.w * dpr);
    const ph = Math.round(this.h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  private makeGrain(): CanvasPattern | null {
    const c = document.createElement('canvas');
    c.width = c.height = 160;
    const g = c.getContext('2d');
    if (!g) return null;
    const d = g.createImageData(160, 160);
    // (a fixed scatter, so the paper is the same sheet every time it is unrolled)
    let s = 9173;
    for (let i = 0; i < d.data.length; i += 4) {
      s = (Math.imul(s, 1103515245) + 12345) | 0;
      const v = (s >>> 16) & 255;
      const dark = v < 128;
      d.data[i] = dark ? 70 : 255;
      d.data[i + 1] = dark ? 50 : 246;
      d.data[i + 2] = dark ? 30 : 225;
      d.data[i + 3] = Math.abs(v - 128) > 96 ? 26 : 9;
    }
    g.putImageData(d, 0, 0);
    return this.ctx.createPattern(c, 'repeat');
  }

  private makeHatch(): CanvasPattern | null {
    const c = document.createElement('canvas');
    c.width = c.height = 9;
    const g = c.getContext('2d');
    if (!g) return null;
    g.strokeStyle = 'rgba(70, 50, 32, 0.16)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-1, 10);
    g.lineTo(10, -1);
    g.moveTo(-1, 1);
    g.lineTo(1, -1);
    g.moveTo(8, 10);
    g.lineTo(10, 8);
    g.stroke();
    return this.ctx.createPattern(c, 'repeat');
  }

  private draw(): void {
    const s = this.state;
    if (!s || this.w < 2) return;
    const c = this.ctx;
    const { w, h, scale: k } = this;
    const sx = (x: number): number => w / 2 + (x - this.cx) * k;
    const sy = (z: number): number => h / 2 + (z - this.cz) * k;

    // ---- the unknown: a veil, finely hatched
    c.fillStyle = VEIL;
    c.fillRect(0, 0, w, h);
    if (this.hatch) {
      c.fillStyle = this.hatch;
      c.fillRect(0, 0, w, h);
    }

    // ---- the ground seen: one pixel a cell, drawn up soft so its edge feathers into the veil
    const i0 = Math.floor((this.cx - w / 2 / k) / ATLAS_CELL) - 1;
    const i1 = Math.floor((this.cx + w / 2 / k) / ATLAS_CELL) + 1;
    const j0 = Math.floor((this.cz - h / 2 / k) / ATLAS_CELL) - 1;
    const j1 = Math.floor((this.cz + h / 2 / k) / ATLAS_CELL) + 1;
    const ni = i1 - i0 + 1;
    const nj = j1 - j0 + 1;
    if (!this.img || this.img.width !== ni || this.img.height !== nj) {
      this.tile.width = ni;
      this.tile.height = nj;
      this.img = this.tctx.createImageData(ni, nj);
    }
    const px = this.img.data;
    const cells = this.atlas.cells;
    let o = 0;
    for (let j = 0; j < nj; j++) {
      for (let i = 0; i < ni; i++, o += 4) {
        const key = cellKey(i0 + i, j0 + j);
        if (!cells.has(key)) {
          px[o + 3] = 0;
          continue;
        }
        const v = this.inks.get(key) ?? PLAIN;
        px[o] = v >> 16;
        px[o + 1] = (v >> 8) & 255;
        px[o + 2] = v & 255;
        px[o + 3] = 255;
      }
    }
    this.tctx.putImageData(this.img, 0, 0);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    // (with a rim of ink bled out round it, as a coast is drawn)
    c.shadowColor = 'rgba(58, 42, 29, 0.55)';
    c.shadowBlur = 7;
    c.drawImage(this.tile, sx(i0 * ATLAS_CELL), sy(j0 * ATLAS_CELL), ni * ATLAS_CELL * k, nj * ATLAS_CELL * k);
    c.shadowColor = 'transparent';
    c.shadowBlur = 0;

    // ---- the paper itself, over ground and veil alike, and the dark toward its edges
    if (this.grain) {
      c.fillStyle = this.grain;
      c.fillRect(0, 0, w, h);
    }
    const vg = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.56);
    vg.addColorStop(0, 'rgba(70, 48, 28, 0)');
    vg.addColorStop(1, 'rgba(70, 48, 28, 0.34)');
    c.fillStyle = vg;
    c.fillRect(0, 0, w, h);

    c.lineJoin = 'round';
    c.lineCap = 'round';
    const label = (text: string, x: number, y: number, colour: string, font: string, align: CanvasTextAlign = 'center'): void => {
      c.font = font;
      c.textAlign = align;
      c.textBaseline = 'middle';
      c.lineWidth = 3.5;
      c.strokeStyle = 'rgba(236, 220, 185, 0.86)';
      c.strokeText(text, x, y);
      c.fillStyle = colour;
      c.fillText(text, x, y);
    };
    const seen = (x: number, y: number, m: number): boolean => x > -m && y > -m && x < w + m && y < h + m;

    // ---- errands: a dashed round over roughly where to look
    for (const hint of s.hints) {
      const x = sx(hint.x);
      const y = sy(hint.z);
      const r = Math.max(15, hint.r * k);
      if (seen(x, y, r)) {
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fillStyle = 'rgba(176, 62, 34, 0.13)';
        c.fill();
        c.setLineDash([7, 5]);
        c.lineWidth = 1.6;
        c.strokeStyle = RED;
        c.stroke();
        c.setLineDash([]);
        label(hint.label, x, y + r + 12, RED, `italic 600 13px ${SERIF}`);
      }
    }

    // ---- places come upon
    const names = k >= 0.07;
    for (const p of this.atlas.places) {
      const x = sx(p.x);
      const y = sy(p.z);
      if (!seen(x, y, 40)) continue;
      const town = p.kind.startsWith('city:');
      c.save();
      c.translate(x, y);
      c.beginPath();
      c.arc(0, 0, town ? 12 : 10.5, 0, Math.PI * 2);
      c.fillStyle = 'rgba(236, 220, 185, 0.8)';
      c.fill();
      c.strokeStyle = INK;
      c.fillStyle = INK;
      if (town) {
        // a walled town: a ring of wall, four gates, the square at its heart
        c.lineWidth = 1.7;
        c.beginPath();
        c.arc(0, 0, 7.5, 0, Math.PI * 2);
        c.stroke();
        c.beginPath();
        c.arc(0, 0, 2.6, 0, Math.PI * 2);
        c.fill();
        for (let q = 0; q < 4; q++) {
          c.rotate(Math.PI / 2);
          c.fillRect(-1.5, -10, 3, 3.6);
        }
      } else {
        c.lineWidth = 1.35;
        glyph(c, p.kind);
        if (p.kind === 'cavern' || p.kind === 'cave') c.fill();
        c.stroke();
      }
      c.restore();
      // a place brought back: a small warm dot at the glyph's shoulder, the one mark on the map that is the wanderer's doing
      if (this.revived.some((r) => Math.abs(r.x - p.x) < 60 && Math.abs(r.z - p.z) < 60)) {
        c.beginPath();
        c.arc(x + 8.5, y - 8.5, 3.1, 0, Math.PI * 2);
        c.fillStyle = '#c9822f';
        c.fill();
        c.lineWidth = 1.1;
        c.strokeStyle = INK;
        c.stroke();
      }
      if (names) label(placeName(p.kind), x, y + (town ? 21 : 19), INK, `${town ? '600 12.5px' : '11.5px'} ${SERIF}`);
    }

    // ---- places marked through the spyglass, not yet reached
    for (let i = 0; i + 1 < s.sighted.length; i += 2) {
      const x = sx(s.sighted[i]);
      const y = sy(s.sighted[i + 1]);
      if (!seen(x, y, 10)) continue;
      c.beginPath();
      c.moveTo(x, y - 6);
      c.lineTo(x + 4.5, y);
      c.lineTo(x, y + 6);
      c.lineTo(x - 4.5, y);
      c.closePath();
      c.fillStyle = 'rgba(236, 220, 185, 0.85)';
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = GOLD;
      c.stroke();
      c.beginPath();
      c.arc(x, y, 1.2, 0, Math.PI * 2);
      c.fillStyle = GOLD;
      c.fill();
    }

    // ---- the bedroll, where it is laid
    if (s.camp) {
      const x = sx(s.camp.x);
      const y = sy(s.camp.z);
      if (seen(x, y, 10)) {
        c.beginPath();
        c.moveTo(x - 6, y + 4.5);
        c.lineTo(x, y - 5.5);
        c.lineTo(x + 6, y + 4.5);
        c.closePath();
        c.fillStyle = 'rgba(236, 220, 185, 0.85)';
        c.fill();
        c.lineWidth = 1.4;
        c.strokeStyle = INK;
        c.stroke();
        c.beginPath();
        c.moveTo(x, y - 5.5);
        c.lineTo(x, y + 4.5);
        c.stroke();
      }
    }

    // ---- the wanderer
    {
      const x = sx(s.x);
      const y = sy(s.z);
      if (seen(x, y, 12)) {
        c.save();
        c.translate(x, y);
        // (heading 0 looks along +z, which is down the sheet)
        c.rotate(Math.PI - s.heading);
        c.beginPath();
        c.moveTo(0, -10);
        c.lineTo(6.5, 7.5);
        c.lineTo(0, 3.6);
        c.lineTo(-6.5, 7.5);
        c.closePath();
        c.lineWidth = 3;
        c.strokeStyle = PAPER;
        c.stroke();
        c.fillStyle = RED;
        c.fill();
        c.restore();
      }
    }

    // ---- whatever is off the sheet is pointed at from its edge: errands, and the wanderer
    const edge = (wx: number, wz: number, text: string, colour: string): void => {
      const x = sx(wx);
      const y = sy(wz);
      const m = 30;
      if (x >= m && y >= m && x <= w - m && y <= h - m) return;
      const dx = x - w / 2;
      const dy = y - h / 2;
      const t = Math.min((w / 2 - m) / Math.max(1e-6, Math.abs(dx)), (h / 2 - m) / Math.max(1e-6, Math.abs(dy)));
      if (t >= 1) return;
      const ex = w / 2 + dx * t;
      const ey = h / 2 + dy * t;
      c.save();
      c.translate(ex, ey);
      c.rotate(Math.atan2(dy, dx));
      c.beginPath();
      c.moveTo(11, 0);
      c.lineTo(-2, -6.5);
      c.lineTo(-2, 6.5);
      c.closePath();
      c.lineWidth = 3;
      c.strokeStyle = PAPER;
      c.stroke();
      c.fillStyle = colour;
      c.fill();
      c.restore();
      if (!text) return;
      const left = ex > w / 2;
      label(text, ex + (left ? -12 : 12), ey + (ey > h / 2 ? -14 : 14), colour, `italic 600 12.5px ${SERIF}`, left ? 'right' : 'left');
    };
    for (const hint of s.hints) if (!seen(sx(hint.x), sy(hint.z), Math.max(15, hint.r * k) - 30)) edge(hint.x, hint.z, hint.label, RED);
    edge(s.x, s.z, 'You', INK);

    // ---- north, and how far a thumb's width is
    {
      const x = w - 40;
      const y = h - 46;
      c.beginPath();
      c.moveTo(x, y - 17);
      c.lineTo(x + 5.5, y + 5);
      c.lineTo(x, y + 1);
      c.lineTo(x - 5.5, y + 5);
      c.closePath();
      c.fillStyle = INK;
      c.fill();
      c.beginPath();
      c.arc(x, y - 2, 20, 0, Math.PI * 2);
      c.lineWidth = 1;
      c.strokeStyle = INK_SOFT;
      c.stroke();
      label('N', x, y + 12.5, INK, `600 11px ${SERIF}`);
    }
    {
      const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 20000];
      const m = steps.find((v) => v * k >= 70) ?? steps[steps.length - 1];
      const x0 = 22;
      const y0 = h - 24;
      c.beginPath();
      c.moveTo(x0, y0 - 5);
      c.lineTo(x0, y0);
      c.lineTo(x0 + m * k, y0);
      c.lineTo(x0 + m * k, y0 - 5);
      c.lineWidth = 1.3;
      c.strokeStyle = INK;
      c.stroke();
      label(m >= 1000 ? `${m / 1000} km` : `${m} m`, x0 + (m * k) / 2, y0 - 11, INK, `11px ${SERIF}`);
    }
  }
}
