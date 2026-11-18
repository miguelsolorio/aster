// The compass: a short run of the horizon along the top of the view, with north, east, south
// and west sliding past a small notch as the eye turns. The few places the wanderer already
// knows to look for ride along under it: an errand, a place marked through the spyglass, the
// bedroll. One to the side or behind waits, dimmed, at the end to turn toward.
//
// North is -z and east is +x, as on the map.
import './compass.css';

export type ThingKind = 'errand' | 'mark' | 'camp';

export interface Thing {
  x: number;
  z: number;
  kind: ThingKind;
  /** Within this many metres it is not shown: the wanderer is there, or as near as they were told. */
  r: number;
}

const DEG = 180 / Math.PI;
/** Pixels to a degree along the strip. */
const PPD = 2.2;
/** How many things can be shown at once. */
const MAX = 16;
const LETTERS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

/** The way the eye looks, in degrees clockwise from north, 0 up to 360. */
export function headingDeg(camYaw: number): number {
  const d = (-camYaw * DEG) % 360;
  return d < 0 ? d + 360 : d;
}

/** The way from one place to another, in degrees clockwise from north, 0 up to 360. */
export function bearingDeg(fx: number, fz: number, tx: number, tz: number): number {
  const d = Math.atan2(tx - fx, fz - tz) * DEG;
  return d < 0 ? d + 360 : d;
}

/** How far to turn from `heading` to face `bearing`: -180 up to 180, right being positive. */
export function turnDeg(bearing: number, heading: number): number {
  const d = (bearing - heading) % 360;
  return d < -180 ? d + 360 : d >= 180 ? d - 360 : d;
}

/**
 * The `n` places nearest (x, z) out of `at` (x then z for each), as things of one kind.
 * Nearest first.
 */
export function nearest(at: readonly number[], x: number, z: number, n: number, kind: ThingKind, r: number): Thing[] {
  const all: Array<{ x: number; z: number; d: number }> = [];
  for (let i = 0; i + 1 < at.length; i += 2) all.push({ x: at[i], z: at[i + 1], d: (at[i] - x) ** 2 + (at[i + 1] - z) ** 2 });
  all.sort((a, b) => a.d - b.d);
  return all.slice(0, Math.max(0, n)).map((p) => ({ x: p.x, z: p.z, kind, r }));
}

export class Compass {
  private readonly root: HTMLElement;
  private readonly track: HTMLElement;
  private readonly dots: HTMLElement[] = [];
  private things: readonly Thing[] = [];
  private on = false;
  /** Half the strip's width in px, or 0 until it has been measured. */
  private half = 0;
  private trackX = Number.NaN;
  /** Where each thing was last put, in px, so a still one is not written again. */
  private readonly dotX: number[] = [];

  constructor(host: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'aster-compass';
    root.setAttribute('aria-hidden', 'true');
    const win = document.createElement('div');
    win.className = 'aster-compass__window';
    const track = document.createElement('div');
    track.className = 'aster-compass__track';
    // a turn and a half of horizon, so one strip covers every heading without a seam
    for (let d = -90; d <= 450; d += 15) {
      const at = ((d % 360) + 360) % 360;
      const letter = LETTERS[at];
      const t = document.createElement('span');
      t.className = letter
        ? `aster-compass__letter${at === 0 ? ' is-north' : ''}`
        : at % 45 === 0
          ? 'aster-compass__tick is-half'
          : 'aster-compass__tick';
      if (letter) t.textContent = letter;
      t.style.left = `${(d + 90) * PPD}px`;
      track.appendChild(t);
    }
    win.appendChild(track);
    const notch = document.createElement('div');
    notch.className = 'aster-compass__notch';
    const row = document.createElement('div');
    row.className = 'aster-compass__things';
    for (let i = 0; i < MAX; i++) {
      const dot = document.createElement('span');
      dot.hidden = true;
      row.appendChild(dot);
      this.dots.push(dot);
      this.dotX.push(Number.NaN);
    }
    root.append(notch, win, row);
    host.appendChild(root);
    this.root = root;
    this.track = track;
    window.addEventListener('resize', () => {
      this.half = 0;
    });
  }

  /** What to point at. Anything past the first sixteen is left out. */
  setThings(things: readonly Thing[]): void {
    this.things = things;
  }

  /** show: whether it is up at all. camYaw: the eye's turn, 0 looking north. (x, z): where the wanderer stands. */
  update(show: boolean, camYaw: number, x: number, z: number): void {
    if (show !== this.on) {
      this.on = show;
      this.root.classList.toggle('is-on', show);
    }
    if (!show) return;
    if (this.half <= 0) this.half = this.root.clientWidth / 2;
    const half = this.half;
    if (half <= 0) return;
    const heading = headingDeg(camYaw);
    const tx = Math.round((half - (heading + 90) * PPD) * 2) / 2;
    if (tx !== this.trackX) {
      this.trackX = tx;
      this.track.style.transform = `translate3d(${tx}px,0,0)`;
    }
    const reach = half - 5;
    const n = Math.min(MAX, this.things.length);
    for (let i = 0; i < MAX; i++) {
      const dot = this.dots[i];
      const t = i < n ? this.things[i] : null;
      if (!t || Math.hypot(t.x - x, t.z - z) <= t.r) {
        if (!dot.hidden) dot.hidden = true;
        continue;
      }
      const off = turnDeg(bearingDeg(x, z, t.x, t.z), heading) * PPD;
      const pinned = Math.abs(off) > reach;
      const px = Math.round((half + Math.max(-reach, Math.min(reach, off))) * 2) / 2;
      const cls = `aster-compass__thing is-${t.kind}${pinned ? ' is-pinned' : ''}`;
      if (dot.className !== cls) dot.className = cls;
      if (px !== this.dotX[i]) {
        this.dotX[i] = px;
        dot.style.transform = `translate3d(${px}px,0,0)`;
      }
      if (dot.hidden) dot.hidden = false;
    }
  }
}
