// The span grid: what is rock and what is air in a deep.
//
// A 2D grid of cells over the room in the deep's own frame (u along, v across). Each cell holds
// a short list of open spans, bottom to top: [floor, ceil] of air with rock between. A floor is
// a plane (its height at the cell's middle, and a slope each way), so stairs and ramps run true;
// a ceiling is flat. Building is carving air out of solid rock and filling rock back in, which
// splits spans: that is all a bridge over a hall or a stair over a room is.
//
// Everything here is local: u, v in metres, y up from the antechamber floor.

import { DEEP_HOLE, type DeepSpec } from './types';

/** The ceiling of a cell that is open to the antechamber above (the hole). */
export const OPEN = 1e6;
const OPEN_T = 5e5;
/** Air shallower than this over a floor is not somewhere to stand. */
export const HEADROOM = 1;
const EPS = 1e-3;
/** Air thinner than this left by a fill is closed up. */
const SLIVER = 0.3;

// span flags
export const STEPS = 1; // the floor is a stair: drawn as treads, walked as its ramp
export const FM = 2; // (mesher) floor may be merged
export const FD = 4; // (mesher) floor already drawn as part of a merged run
export const CM = 8; // (mesher) ceiling may be merged
export const CD = 16; // (mesher) ceiling drawn as part of a merged run: its corners stay put

/** A point in the deep's frame: [u, y, v]. */
export type Pt = readonly [number, number, number];

/** What a carve function answers for a cell: the air to open there. Return false to leave it. */
export interface CarveOut {
  floor: number;
  ceil: number;
  /** Slope of the floor, metres per metre along u and v. */
  su: number;
  sv: number;
  steps: boolean;
}

/** What a fill function answers for a cell: the rock to put back, and the slope of its top. */
export interface FillOut {
  lo: number;
  hi: number;
  su: number;
  sv: number;
  steps: boolean;
}

export interface RunOpts {
  /** Draw the floor as treads. */
  steps?: boolean;
  /** Level floor carried on past each end, metres (for landings and corners). */
  cap0?: number;
  cap1?: number;
}

export class SpanGrid {
  /** Cell size along u and v. Chosen so the hole's edges fall on cell edges. */
  readonly cu: number;
  readonly cv: number;
  /** The low corner of cell (0, 0). */
  readonly u0: number;
  readonly v0: number;
  readonly nu: number;
  readonly nv: number;
  /** Most spans a cell can hold. */
  readonly K: number;
  readonly lid: number;
  readonly yMin: number;

  /** Spans per cell, then per span (cell * K + s): floor at the cell's middle, ceiling, slopes. */
  readonly n: Uint8Array;
  readonly f: Float32Array;
  readonly c: Float32Array;
  readonly su: Float32Array;
  readonly sv: Float32Array;
  /** Paint (an index into the builder's table) of each span's floor and ceiling, and its flags. */
  readonly fp: Uint8Array;
  readonly cp: Uint8Array;
  readonly fl: Uint8Array;
  /** 0 not ours to cut, 1 in the room (under the lid), 2 in the hole, 3 both. */
  readonly mask: Uint8Array;
  /** How far the rock at each grid corner is roughened, metres. Stamped by every carve and fill. */
  readonly rough: Float32Array;
  /** Water surface per cell (NaN where dry), once any is declared. */
  water: Float32Array | null = null;

  /** What the next carve or fill stamps: roughness, and the paint of new floors and ceilings. */
  roughNow = 0.3;
  paintF = 0;
  paintC = 0;
  /** Cuts refused (outside the room) and spans lost to a full cell: both should stay 0. */
  refused = 0;
  overflow = 0;

  constructor(spec: DeepSpec, cell: number, yMin: number, maxSpans = 6) {
    const hu = DEEP_HOLE.halfU;
    const hv = DEEP_HOLE.halfV;
    this.cu = (2 * hu) / Math.max(1, Math.round((2 * hu) / cell));
    this.cv = (2 * hv) / Math.max(1, Math.round((2 * hv) / cell));
    this.u0 = -hu - this.cu;
    this.v0 = -hv - Math.ceil((-hv - spec.v0) / this.cv) * this.cv;
    this.nu = Math.ceil((spec.u1 - this.u0) / this.cu);
    this.nv = Math.ceil((spec.v1 - this.v0) / this.cv);
    this.K = maxSpans;
    this.lid = spec.lid;
    this.yMin = yMin;
    const nc = this.nu * this.nv;
    this.n = new Uint8Array(nc);
    this.f = new Float32Array(nc * maxSpans);
    this.c = new Float32Array(nc * maxSpans);
    this.su = new Float32Array(nc * maxSpans);
    this.sv = new Float32Array(nc * maxSpans);
    this.fp = new Uint8Array(nc * maxSpans);
    this.cp = new Uint8Array(nc * maxSpans);
    this.fl = new Uint8Array(nc * maxSpans);
    this.mask = new Uint8Array(nc);
    this.rough = new Float32Array((this.nu + 1) * (this.nv + 1));
    // a metre of rock is always left standing inside the room's edge
    const M = 1;
    for (let j = 0; j < this.nv; j++) {
      const va = this.v0 + j * this.cv;
      const vb = va + this.cv;
      for (let i = 0; i < this.nu; i++) {
        const ua = this.u0 + i * this.cu;
        const ub = ua + this.cu;
        let m = 0;
        if (ua >= M - EPS && ub <= spec.u1 - M + EPS && va >= spec.v0 + M - EPS && vb <= spec.v1 - M + EPS) m |= 1;
        if (ua >= -hu - EPS && ub <= hu + EPS && va >= -hv - EPS && vb <= hv + EPS) m |= 2;
        this.mask[i + j * this.nu] = m;
      }
    }
  }

  // ---------------------------------------------------------------- cells

  /** The cell over (u, v), or -1 outside the grid. */
  cell(u: number, v: number): number {
    const i = Math.floor((u - this.u0) / this.cu);
    const j = Math.floor((v - this.v0) / this.cv);
    if (i < 0 || j < 0 || i >= this.nu || j >= this.nv) return -1;
    return i + j * this.nu;
  }

  /** Middle of a cell. */
  uc(ci: number): number {
    return this.u0 + ((ci % this.nu) + 0.5) * this.cu;
  }
  vc(ci: number): number {
    return this.v0 + (((ci / this.nu) | 0) + 0.5) * this.cv;
  }

  /** Height of span k's floor at (u, v) within its cell ci. */
  floorOf(k: number, ci: number, u: number, v: number): number {
    const su = this.su[k];
    const sv = this.sv[k];
    if (su === 0 && sv === 0) return this.f[k];
    return this.f[k] + su * (u - this.uc(ci)) + sv * (v - this.vc(ci));
  }

  private stamp(ci: number): void {
    const i = ci % this.nu;
    const j = (ci / this.nu) | 0;
    const w = this.nu + 1;
    const r = this.roughNow;
    const a = i + j * w;
    this.rough[a] = r;
    this.rough[a + 1] = r;
    this.rough[a + w] = r;
    this.rough[a + w + 1] = r;
  }

  /** Open [lo, hi] in a cell, joining whatever air it touches. The lowest floor stands. */
  carveCell(ci: number, lo: number, hi: number, su = 0, sv = 0, steps = false): void {
    const m = this.mask[ci];
    if (m === 0) {
      this.refused++;
      return;
    }
    if (hi >= OPEN_T && (m & 2) !== 0) hi = OPEN;
    else if (hi > this.lid) hi = this.lid;
    if (lo < this.yMin) lo = this.yMin;
    if (hi - lo < 0.05) return;
    const K = this.K;
    const b = ci * K;
    const cnt = this.n[ci];
    const { f, c } = this;
    let a = 0;
    while (a < cnt && c[b + a] < lo - EPS) a++;
    let z = a - 1;
    while (z + 1 < cnt && f[b + z + 1] <= hi + EPS) z++;
    this.stamp(ci);
    if (z < a) {
      // touches nothing: a new span at a
      if (cnt >= K) {
        this.overflow++;
        return;
      }
      for (let s = cnt; s > a; s--) this.copy(b + s - 1, b + s);
      const k = b + a;
      f[k] = lo;
      c[k] = hi;
      this.su[k] = su;
      this.sv[k] = sv;
      this.fl[k] = steps ? STEPS : 0;
      this.fp[k] = this.paintF;
      this.cp[k] = this.paintC;
      this.n[ci] = cnt + 1;
      return;
    }
    const k = b + a;
    if (lo < f[k] - EPS) {
      f[k] = lo;
      this.su[k] = su;
      this.sv[k] = sv;
      this.fl[k] = steps ? STEPS : 0;
      this.fp[k] = this.paintF;
    }
    if (hi > c[b + z] + EPS) {
      c[k] = hi;
      this.cp[k] = this.paintC;
    } else {
      c[k] = c[b + z];
      this.cp[k] = this.cp[b + z];
    }
    const gone = z - a;
    if (gone > 0) {
      for (let s = z + 1; s < cnt; s++) this.copy(b + s, b + s - gone);
      this.n[ci] = cnt - gone;
    }
  }

  private copy(from: number, to: number): void {
    this.f[to] = this.f[from];
    this.c[to] = this.c[from];
    this.su[to] = this.su[from];
    this.sv[to] = this.sv[from];
    this.fl[to] = this.fl[from];
    this.fp[to] = this.fp[from];
    this.cp[to] = this.cp[from];
  }

  private readonly tf = new Float32Array(16);
  private readonly tc = new Float32Array(16);
  private readonly tsu = new Float32Array(16);
  private readonly tsv = new Float32Array(16);
  private readonly tfl = new Uint8Array(16);
  private readonly tfp = new Uint8Array(16);
  private readonly tcp = new Uint8Array(16);

  /**
   * Put rock back in [lo, hi] of a cell. Air left above it stands on the fill's top. Air left
   * thinner than `sliver` above or below is closed up with it.
   */
  fillCell(ci: number, lo: number, hi: number, su = 0, sv = 0, steps = false, sliver = SLIVER): void {
    const K = this.K;
    const b = ci * K;
    const cnt = this.n[ci];
    if (cnt === 0 || hi - lo < EPS) return;
    const { f, c, tf, tc, tsu, tsv, tfl, tfp, tcp } = this;
    let o = 0;
    let touched = false;
    for (let s = 0; s < cnt; s++) {
      const k = b + s;
      const sf = f[k];
      const sc = c[k];
      if (hi <= sf + EPS || lo >= sc - EPS) {
        tf[o] = sf; tc[o] = sc; tsu[o] = this.su[k]; tsv[o] = this.sv[k]; tfl[o] = this.fl[k]; tfp[o] = this.fp[k]; tcp[o] = this.cp[k];
        o++;
        continue;
      }
      touched = true;
      const below = lo - sf >= sliver;
      const above = sc - hi >= sliver;
      if (below) {
        tf[o] = sf; tc[o] = lo; tsu[o] = this.su[k]; tsv[o] = this.sv[k]; tfl[o] = this.fl[k]; tfp[o] = this.fp[k]; tcp[o] = this.paintC;
        o++;
      }
      if (above) {
        tf[o] = hi; tc[o] = sc; tsu[o] = su; tsv[o] = sv; tfl[o] = steps ? STEPS : 0; tfp[o] = this.paintF; tcp[o] = this.cp[k];
        o++;
      }
    }
    if (!touched) return;
    this.stamp(ci);
    if (o > K) {
      this.overflow += o - K;
      o = K;
    }
    for (let s = 0; s < o; s++) {
      const k = b + s;
      f[k] = tf[s]; c[k] = tc[s]; this.su[k] = tsu[s]; this.sv[k] = tsv[s]; this.fl[k] = tfl[s]; this.fp[k] = tfp[s]; this.cp[k] = tcp[s];
    }
    this.n[ci] = o;
  }

  // ---------------------------------------------------------------- shapes
  // All of these work on the cells whose middles fall inside the shape.

  /** Calls fn(cell, u, v) for each cell whose middle lies in the rectangle. */
  each(u0: number, v0: number, u1: number, v1: number, fn: (ci: number, u: number, v: number) => void): void {
    const i0 = Math.max(0, Math.ceil((u0 - this.u0) / this.cu - 0.5 - 1e-6));
    const i1 = Math.min(this.nu - 1, Math.floor((u1 - this.u0) / this.cu - 0.5 + 1e-6));
    const j0 = Math.max(0, Math.ceil((v0 - this.v0) / this.cv - 0.5 - 1e-6));
    const j1 = Math.min(this.nv - 1, Math.floor((v1 - this.v0) / this.cv - 0.5 + 1e-6));
    for (let j = j0; j <= j1; j++) {
      const v = this.v0 + (j + 0.5) * this.cv;
      for (let i = i0; i <= i1; i++) fn(i + j * this.nu, this.u0 + (i + 0.5) * this.cu, v);
    }
  }

  /** A box of air: level floor at y0, flat ceiling at y1. */
  carveBox(u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): void {
    this.each(u0, v0, u1, v1, (ci) => this.carveCell(ci, y0, y1));
  }

  /** An upright cylinder of air. */
  carveCyl(u: number, v: number, r: number, y0: number, y1: number): void {
    const r2 = r * r;
    this.each(u - r, v - r, u + r, v + r, (ci, cu, cv) => {
      if ((cu - u) * (cu - u) + (cv - v) * (cv - v) <= r2) this.carveCell(ci, y0, y1);
    });
  }

  /** A dome: level floor at y0, the ceiling an ellipsoid cap `rise` high in the middle and `wall` high at the rim. */
  carveDome(u: number, v: number, r: number, y0: number, rise: number, wall = 0): void {
    const r2 = r * r;
    this.each(u - r, v - r, u + r, v + r, (ci, cu, cv) => {
      const d2 = (cu - u) * (cu - u) + (cv - v) * (cv - v);
      if (d2 <= r2) this.carveCell(ci, y0, y0 + wall + (rise - wall) * Math.sqrt(1 - d2 / r2));
    });
  }

  private readonly co: CarveOut = { floor: 0, ceil: 0, su: 0, sv: 0, steps: false };
  private readonly fo: FillOut = { lo: 0, hi: 0, su: 0, sv: 0, steps: false };

  /** Any shape at all: fn writes the floor and ceiling for each cell (su, sv, steps start at 0/false). */
  carveFn(u0: number, v0: number, u1: number, v1: number, fn: (u: number, v: number, out: CarveOut) => boolean): void {
    const o = this.co;
    this.each(u0, v0, u1, v1, (ci, u, v) => {
      o.su = 0;
      o.sv = 0;
      o.steps = false;
      if (fn(u, v, o)) this.carveCell(ci, o.floor, o.ceil, o.su, o.sv, o.steps);
    });
  }

  /**
   * A corridor, ramp or stair: `width` wide and `height` high, its floor running straight from
   * a to b (so a.y to b.y). The ceiling follows the floor, stepping cell by cell.
   */
  carveRun(a: Pt, b: Pt, width: number, height: number, opts: RunOpts = {}): void {
    this.run(a, b, width, opts, (ci, y, su, sv) => this.carveCell(ci, y, y + height, su, sv, opts.steps === true));
  }

  /** A box of rock: a pier, a platform, a gallery floor (a slab hung in a hall splits the air in two). */
  fillBox(u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): void {
    this.each(u0, v0, u1, v1, (ci) => this.fillCell(ci, y0, y1));
  }

  /** An upright cylinder of rock: a pillar. */
  fillCyl(u: number, v: number, r: number, y0: number, y1: number, sliver = SLIVER): void {
    const r2 = r * r;
    let any = false;
    this.each(u - r, v - r, u + r, v + r, (ci, cu, cv) => {
      if ((cu - u) * (cu - u) + (cv - v) * (cv - v) <= r2) {
        this.fillCell(ci, y0, y1, 0, 0, false, sliver);
        any = true;
      }
    });
    // thinner than a cell: it still stands somewhere
    if (!any) {
      const ci = this.cell(u, v);
      if (ci >= 0) this.fillCell(ci, y0, y1, 0, 0, false, sliver);
    }
  }

  /** Any shape of rock: fn writes lo and hi for each cell. */
  fillFn(u0: number, v0: number, u1: number, v1: number, fn: (u: number, v: number, out: FillOut) => boolean): void {
    const o = this.fo;
    this.each(u0, v0, u1, v1, (ci, u, v) => {
      o.su = 0;
      o.sv = 0;
      o.steps = false;
      if (fn(u, v, o)) this.fillCell(ci, o.lo, o.hi, o.su, o.sv, o.steps);
    });
  }

  /**
   * A slab whose top runs straight from a to b, `thick` deep under it: a bridge, a ramp, or
   * (thick enough to reach the ground) a solid stair built up from a floor.
   */
  fillRun(a: Pt, b: Pt, width: number, thick: number, opts: RunOpts = {}): void {
    this.run(a, b, width, opts, (ci, y, su, sv) => this.fillCell(ci, y - thick, y, su, sv, opts.steps === true));
  }

  private run(a: Pt, b: Pt, width: number, opts: RunOpts, fn: (ci: number, y: number, su: number, sv: number) => void): void {
    const du = b[0] - a[0];
    const dv = b[2] - a[2];
    const L = Math.hypot(du, dv);
    if (L < 1e-6) return;
    const eu = du / L;
    const ev = dv / L;
    const s = (b[1] - a[1]) / L;
    const c0 = opts.cap0 ?? 0;
    const c1 = opts.cap1 ?? 0;
    const hw = width / 2 + 1e-6;
    const ext = hw + Math.max(c0, c1);
    this.each(
      Math.min(a[0], b[0]) - ext, Math.min(a[2], b[2]) - ext, Math.max(a[0], b[0]) + ext, Math.max(a[2], b[2]) + ext,
      (ci, u, v) => {
        const pu = u - a[0];
        const pv = v - a[2];
        const t = pu * eu + pv * ev;
        if (t < -c0 - 1e-6 || t > L + c1 + 1e-6 || Math.abs(pu * ev - pv * eu) > hw) return;
        if (t < 0) fn(ci, a[1], 0, 0);
        else if (t > L) fn(ci, b[1], 0, 0);
        else fn(ci, a[1] + s * t, s * eu, s * ev);
      },
    );
  }

  /** Standing water: every cell in the rectangle whose air holds `level` gets a surface there. */
  pool(u0: number, v0: number, u1: number, v1: number, level: number): void {
    this.flood(u0, v0, u1, v1, () => level);
  }

  /** Water by function: fn answers the surface height for a cell, or NaN for none. */
  flood(u0: number, v0: number, u1: number, v1: number, fn: (u: number, v: number) => number): void {
    if (!this.water) this.water = new Float32Array(this.nu * this.nv).fill(NaN);
    const w = this.water;
    this.each(u0, v0, u1, v1, (ci, u, v) => {
      w[ci] = fn(u, v);
    });
  }

  // ---------------------------------------------------------------- queries

  /**
   * The floor for feet at y: that of the lowest span with headroom left above y. +Infinity
   * where it is rock all the way up (or outside the grid).
   */
  floorAt(u: number, v: number, y: number): number {
    const i = Math.floor((u - this.u0) / this.cu);
    const j = Math.floor((v - this.v0) / this.cv);
    if (i < 0 || j < 0 || i >= this.nu || j >= this.nv) return Infinity;
    const ci = i + j * this.nu;
    const cnt = this.n[ci];
    const b = ci * this.K;
    for (let s = 0; s < cnt; s++) {
      const k = b + s;
      let fl = this.f[k];
      const su = this.su[k];
      const sv = this.sv[k];
      if (su !== 0 || sv !== 0) fl += su * (u - this.u0 - (i + 0.5) * this.cu) + sv * (v - this.v0 - (j + 0.5) * this.cv);
      if (this.c[k] - (y > fl ? y : fl) >= HEADROOM) return fl;
    }
    return Infinity;
  }

  /** The ceiling of that same span; +Infinity where it is open above, or there is no such span. */
  ceilAt(u: number, v: number, y: number): number {
    const k = this.spanAt(u, v, y);
    if (k < 0) return Infinity;
    const c = this.c[k];
    return c >= OPEN_T ? Infinity : c;
  }

  /** Index (cell * K + s) of the span floorAt answers from, or -1. */
  spanAt(u: number, v: number, y: number): number {
    const ci = this.cell(u, v);
    if (ci < 0) return -1;
    const cnt = this.n[ci];
    const b = ci * this.K;
    for (let s = 0; s < cnt; s++) {
      const k = b + s;
      const fl = this.floorOf(k, ci, u, v);
      if (this.c[k] - (y > fl ? y : fl) >= HEADROOM) return k;
    }
    return -1;
  }

  /** Whether a point is in air. */
  isAir(u: number, y: number, v: number): boolean {
    const i = Math.floor((u - this.u0) / this.cu);
    const j = Math.floor((v - this.v0) / this.cv);
    if (i < 0 || j < 0 || i >= this.nu || j >= this.nv) return false;
    const ci = i + j * this.nu;
    const cnt = this.n[ci];
    const b = ci * this.K;
    for (let s = 0; s < cnt; s++) {
      const k = b + s;
      if (y > this.c[k]) continue;
      let fl = this.f[k];
      const su = this.su[k];
      const sv = this.sv[k];
      if (su !== 0 || sv !== 0) fl += su * (u - this.u0 - (i + 0.5) * this.cu) + sv * (v - this.v0 - (j + 0.5) * this.cv);
      return y >= fl - 0.02;
    }
    return false;
  }

  /** Depth of water over the floor floorAt answers with, 0 where dry. */
  waterAt(u: number, v: number, y: number): number {
    const w = this.water;
    if (!w) return 0;
    const ci = this.cell(u, v);
    if (ci < 0) return 0;
    const lv = w[ci];
    if (!(lv === lv)) return 0;
    const k = this.spanAt(u, v, y);
    if (k < 0) return 0;
    const fl = this.floorOf(k, ci, u, v);
    return lv > fl && lv <= this.c[k] ? lv - fl : 0;
  }

  /** How far a line from a to b gets through air, 0..1 of the way, looked at every `step` metres. */
  march(au: number, ay: number, av: number, bu: number, by: number, bv: number, step: number): number {
    const du = bu - au;
    const dy = by - ay;
    const dv = bv - av;
    const d = Math.sqrt(du * du + dy * dy + dv * dv);
    const n = Math.max(1, Math.ceil(d / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (!this.isAir(au + du * t, ay + dy * t, av + dv * t)) return (i - 1) / n;
    }
    return 1;
  }
}
