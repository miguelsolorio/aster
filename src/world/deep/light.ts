// Baked light. Nothing underground is lit by the sun: what light there is comes from lamps
// (warm, near, occluded by the rock between) and from sky shafts (daylight through a faked
// opening in the roof). Both are worked out once per vertex at build time. Lamp light goes in
// rgb; sky light goes in its own channel, so a uniform can dim it at night.

import type { SpanGrid } from './spans';

export interface Lamp {
  u: number;
  y: number;
  v: number;
  /** Metres at which its light has fallen to nothing. */
  reach: number;
  /** Colour times strength. */
  r: number;
  g: number;
  b: number;
  strength: number;
  /** False for a light that only moving things should feel (the relic's): it is not baked. */
  baked: boolean;
  /** Set false to put it out (for glowAt). */
  live: boolean;
}

export interface Shaft {
  u: number;
  v: number;
  /** Height of the glowing patch. */
  y: number;
  /** Radius of the opening. */
  r: number;
  strength: number;
  /** The floor it falls on. */
  floor: number;
  /**
   * For light that comes down a well rather than through a roof: it is gone this far below the
   * patch, and is not tested against the rock (so it fades evenly down the stair).
   */
  fade?: number;
}

const BUCKET = 16;

/** Light left at distance d of a lamp with this reach: 1 at the flame, exactly 0 at its reach. */
export function falloff(d: number, reach: number): number {
  if (d >= reach) return 0;
  const q = d / reach;
  const w = 1 - q * q;
  return (w * w) / (1 + (d * d) / (0.22 * reach * reach));
}

export class Lights {
  readonly lamps: Lamp[] = [];
  readonly shafts: Shaft[] = [];
  private grid!: SpanGrid;
  private bu = 0;
  private bv = 0;
  private nbu = 0;
  private nbv = 0;
  private buckets: number[][] = [];
  private step = 1;

  /** Sort the lamps into buckets. Call once everything is placed, before any query. */
  index(grid: SpanGrid): void {
    this.grid = grid;
    this.step = Math.min(grid.cu, grid.cv) * 0.9;
    this.bu = grid.u0;
    this.bv = grid.v0;
    this.nbu = Math.ceil((grid.nu * grid.cu) / BUCKET);
    this.nbv = Math.ceil((grid.nv * grid.cv) / BUCKET);
    this.buckets = [];
    for (let i = 0; i < this.nbu * this.nbv; i++) this.buckets.push([]);
    this.lamps.forEach((l, li) => {
      const i0 = Math.max(0, Math.floor((l.u - l.reach - this.bu) / BUCKET));
      const i1 = Math.min(this.nbu - 1, Math.floor((l.u + l.reach - this.bu) / BUCKET));
      const j0 = Math.max(0, Math.floor((l.v - l.reach - this.bv) / BUCKET));
      const j1 = Math.min(this.nbv - 1, Math.floor((l.v + l.reach - this.bv) / BUCKET));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.buckets[i + j * this.nbu].push(li);
    });
  }

  private near(u: number, v: number): number[] | null {
    const i = Math.floor((u - this.bu) / BUCKET);
    const j = Math.floor((v - this.bv) / BUCKET);
    if (i < 0 || j < 0 || i >= this.nbu || j >= this.nbv) return null;
    return this.buckets[i + j * this.nbu];
  }

  /** Whether any lamp reaches a point, or a shaft's beam falls near it: where light needs fine vertices. */
  lit(u: number, y: number, v: number): boolean {
    const b = this.near(u, v);
    if (b) {
      for (let q = 0; q < b.length; q++) {
        const l = this.lamps[b[q]];
        if (!l.baked) continue;
        const du = l.u - u;
        const dy = l.y - y;
        const dv = l.v - v;
        if (du * du + dy * dy + dv * dv < l.reach * l.reach) return true;
      }
    }
    for (const s of this.shafts) {
      const R = s.r + 0.06 * (s.y - y) + 7;
      const du = s.u - u;
      const dv = s.v - v;
      if (du * du + dv * dv < R * R) return true;
    }
    return false;
  }

  /** Clear air between a point and a light? The first stretch from the point is not looked at. */
  private clear(u: number, y: number, v: number, lu: number, ly: number, lv: number, d: number, step: number): boolean {
    const g = this.grid;
    const n = Math.max(2, Math.ceil(d / step));
    const du = (lu - u) / n;
    const dy = (ly - y) / n;
    const dv = (lv - v) / n;
    for (let i = 1; i < n; i++) {
      if (!g.isAir(u + du * i, y + dy * i, v + dv * i)) return false;
    }
    return true;
  }

  /**
   * Light arriving at a point with normal n: lamp light to out[0..2], sky light to out[3].
   * Unbounded above; the bake folds it into bytes.
   */
  sample(u: number, y: number, v: number, nx: number, ny: number, nz: number, out: Float32Array): void {
    let r = 0;
    let g = 0;
    let b = 0;
    const bk = this.near(u, v);
    if (bk) {
      for (let q = 0; q < bk.length; q++) {
        const l = this.lamps[bk[q]];
        if (!l.baked) continue;
        const du = l.u - u;
        const dy = l.y - y;
        const dv = l.v - v;
        const d2 = du * du + dy * dy + dv * dv;
        if (d2 >= l.reach * l.reach) continue;
        const d = Math.sqrt(d2);
        let a = falloff(d, l.reach);
        if (a < 0.004) continue;
        const lam = d > 0.3 ? Math.max(0, (du * nx + dy * ny + dv * nz) / d) : 1;
        a *= 0.3 + 0.7 * lam;
        // what the rock hides still gets a little, as if bounced; out where the light is faint
        // anyway it is not worth looking, and everything gets half
        if (a * l.strength < 0.04) a *= 0.5;
        else if (d > this.step * 1.5 && !this.clear(u, y, v, l.u, l.y, l.v, d, this.step)) a *= 0.07;
        r += l.r * a;
        g += l.g * a;
        b += l.b * a;
      }
    }
    let sky = 0;
    for (const s of this.shafts) {
      const du = s.u - u;
      const dv = s.v - v;
      const dh = Math.sqrt(du * du + dv * dv);
      const dy = s.y - y;
      if (dy < -0.5) continue;
      const D = Math.sqrt(dh * dh + dy * dy);
      // the beam: a column widening a little as it falls
      const R = s.r + 0.06 * dy;
      let beam = 0;
      if (dh < R + 4) {
        const t = Math.min(1, Math.max(0, (R + 4 - dh) / 5));
        beam = t * t * (3 - 2 * t) * (0.35 + 0.65 * Math.max(0, ny));
      }
      // and what spills from it into the hall: a soft glow from the patch
      const lam = D > 0.3 ? Math.max(0, (du * nx + dy * ny + dv * nz) / D) : 1;
      // (wide: a hall hundreds of metres across is read by this, not by its lamps)
      const amb = (0.75 / (1 + (D * D) / (500 * s.r * s.r))) * (0.45 + 0.55 * lam);
      let a = (beam + amb) * s.strength;
      if (s.fade !== undefined) {
        const k = Math.max(0, 1 - dy / s.fade);
        sky += a * k * k;
        continue;
      }
      if (a < 0.01) continue;
      // aim at the part of the opening nearest overhead
      const k = dh > 1e-3 ? Math.min(1, (s.r * 0.7) / dh) : 0;
      const tu = u + du * (1 - k);
      const tv = v + dv * (1 - k);
      const ty = s.y - 0.4;
      const td = Math.sqrt((tu - u) * (tu - u) + (ty - y) * (ty - y) + (tv - v) * (tv - v));
      const step = beam > 0.05 ? this.step : Math.max(this.step * 1.5, td / 24);
      if (a < 0.03) a *= 0.6;
      else if (td > this.step * 1.5 && !this.clear(u, y, v, tu, ty, tv, td, step)) a *= 0.08;
      sky += a;
    }
    out[0] = r;
    out[1] = g;
    out[2] = b;
    out[3] = sky;
  }

  /**
   * The light that matters most at a point: its index in `lamps`, or -1. Lamps behind rock do
   * not count.
   */
  best(u: number, y: number, v: number): number {
    const bk = this.near(u, v);
    if (!bk) return -1;
    let best = -1;
    let bw = 0.01;
    for (let q = 0; q < bk.length; q++) {
      const l = this.lamps[bk[q]];
      if (!l.live) continue;
      const du = l.u - u;
      const dy = l.y - y;
      const dv = l.v - v;
      const d2 = du * du + dy * dy + dv * dv;
      if (d2 >= l.reach * l.reach) continue;
      const d = Math.sqrt(d2);
      const w = falloff(d, l.reach) * l.strength;
      if (w <= bw) continue;
      if (d > 1 && !this.clear(u, y, v, l.u, l.y, l.v, d, 0.6)) continue;
      bw = w;
      best = bk[q];
    }
    return best;
  }
}

/** Fold a light amount (0..2 and beyond) into a byte; the shader squares it back out. */
export function lightByte(x: number): number {
  const q = Math.sqrt(Math.min(2, Math.max(0, x)) / 2) * 255;
  return (q + 0.5) | 0;
}
