// The builder every kind of deep is written against.
//
// A kind makes a DeepBuilder, carves and fills its span grid (b.grid), stands props and lamps
// in it, and calls finish(), which meshes the rock, bakes the light and hands back a Deep.
//
//   const b = new DeepBuilder(spec, uniforms, { cell: 1, yMin: -90 });
//   b.holeStair();                                     // the way down the hole, to [4, b.foot, 0]
//   b.grid.roughNow = 0.35;                            // how craggy what is cut next will be
//   b.grid.carveBox(20, -30, 120, 30, -80, -20);       // a hall
//   b.grid.fillBox(60, -30, 64, 30, -52, -50);         // a bridge across it
//   b.grid.fillRun([20, -50, 0], [60, -80, 0], 4, 40, { steps: true }); // a stair built up from the floor
//   b.lamp(40, -78.5, 0);                              // a lantern: baked light, a flame, a glow
//   b.skyShaft(90, 0, 6);                              // daylight from a patch of roof
//   b.color(0.9, 0.88, 0.8, 1); b.cyl(50, -80, 5, 0.8, 9, { solid: true }); // a column
//   return b.finish({ ledge: [20, -50, 0], centre: [118, -80, 0], relic: null });
//
// Everything is in the deep's own frame: u along, v across, y up from the antechamber floor.
// A point is [u, y, v]. finish() places the result in the world.

import * as THREE from 'three';
import type { Uniforms } from '../../game/contract';
import { DEEP_HOLE, type Deep, type DeepSpec } from './types';
import { HEADROOM, OPEN, SpanGrid, type Pt } from './spans';
import { Lights, lightByte, type Lamp } from './light';
import { VB, meshGrid, meshWater } from './mesher';
import { deepMaterials, type DeepMaterials } from './material';

export interface BuilderOpts {
  /** Nominal cell size, metres: about 2 for great halls, 1 for passages a person fills. */
  cell: number;
  /** The lowest anything will be cut to. */
  yMin: number;
  /** Most levels of air over one spot (default 6; raised if the hole's stairwell needs more). */
  maxSpans?: number;
  /** Height of the courses walls are cut into (default 3 m). */
  wallStep?: number;
}

export interface LampOpts {
  /** Metres until its light is gone (default 22). */
  reach?: number;
  strength?: number;
  color?: readonly [number, number, number];
  /** Scale of the flame and its glow (default 1). */
  size?: number;
  /** Stand a small lantern body under the flame (default true). */
  body?: boolean;
  /** No flame and no glow: only the baked light. */
  bare?: boolean;
  /** A steady light rather than a flickering one. */
  steady?: boolean;
}

export interface PropOpts {
  /** Fill the span grid under it, so it cannot be walked through and shadows what is behind. */
  solid?: boolean;
  /** Tilt, radians about the local u and v axes (applied after the turn about y). */
  rx?: number;
  rz?: number;
  /** Cylinders and cones: sides (default 8), and top radius as a fraction of the bottom's. */
  sides?: number;
  top?: number;
  /** Rings of vertices up its height, so tall things take the light's gradient (default by height). */
  seg?: number;
}

export interface Marks {
  /** Where the passage opens onto the main space. */
  ledge: Pt;
  /** The centrepiece. */
  centre: Pt;
  /** Where the relic sits (it is drawn there), or null. */
  relic: Pt | null;
}

export interface DeepStats {
  triangles: number;
  vertices: number;
  cells: number;
  lamps: number;
  drawCalls: number;
  /** Milliseconds: carving (everything before finish), meshing, baking, total. */
  carveMs: number;
  meshMs: number;
  bakeMs: number;
  totalMs: number;
  /** Cuts refused for being outside the room, and spans dropped from full cells: both should be 0. */
  refused: number;
  overflow: number;
}

/** A Deep with what built it left attached, for kinds and checks. */
export interface BuiltDeep extends Deep {
  readonly grid: SpanGrid;
  readonly stats: DeepStats;
  /** World point to the deep's frame: [u, y, v]. */
  toLocal(x: number, y: number, z: number, out: number[]): number[];
}

const WARM: readonly [number, number, number] = [1, 0.78, 0.46];
const TEAL: readonly [number, number, number] = [0.3, 0.95, 0.82];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

interface Blocker {
  u: number;
  v: number;
  /** Radius, or half-extents and turn for a box. */
  r: number;
  hu: number;
  hv: number;
  rot: number;
  y0: number;
  y1: number;
}

export class DeepBuilder {
  readonly spec: DeepSpec;
  readonly grid: SpanGrid;
  readonly lights = new Lights();
  /** Seeded from spec.seed: use it for every choice, so a spec always builds the same place. */
  readonly rng: () => number;
  readonly tier: 0 | 1 | 2;
  /**
   * Where holeStair() comes down to, at u = +halfU: low enough that a passage 2.5 m high
   * starting there is under the lid. A kind's own cutting starts from [halfU, foot, 0].
   */
  readonly foot: number;
  /** Flights in the hole's stair: 1 where the lid is close, more (always odd) in a well. */
  private readonly flights: number;
  /** Paint table: [r, g, b, kind]. Index 0 is bare rock. */
  readonly paints: number[][] = [[1, 1, 1, 0]];

  private readonly uniforms: Uniforms | undefined;
  private readonly wallStep: number;
  private readonly props = new VB();
  private readonly blockers: Blocker[] = [];
  /** The waking stone's reach point, local, once one is stood. */
  private stoneAt: Pt | null = null;
  private readonly glows: number[] = []; // u y v size r g b phase
  private readonly beams: number[] = []; // u y v fade
  private paintNow: number[] = this.paints[0];
  private readonly t0 = now();
  /** The sky patch's paint. */
  private readonly skyPaint: number;

  constructor(spec: DeepSpec, uniforms: Uniforms | undefined, opts: BuilderOpts) {
    this.spec = spec;
    this.uniforms = uniforms;
    this.tier = spec.tier;
    this.rng = mulberry32((spec.seed ^ 0x9e3779b9) + spec.kind * 7919);
    this.foot = spec.lid - 2.9;
    const drop = -this.foot;
    this.flights = drop <= 6.4 ? 1 : Math.min(11, Math.ceil(drop / 3.2) | 1);
    // (a well stacks half its flights over one spot, and a landing under them)
    this.grid = new SpanGrid(spec, opts.cell, opts.yMin, Math.max(opts.maxSpans ?? 6, (this.flights + 1) / 2 + 1));
    this.wallStep = opts.wallStep ?? 3;
    this.skyPaint = this.paint(1, 1, 1, 5);
  }

  /** A random number in [a, b). */
  r(a: number, b: number): number {
    return a + (b - a) * this.rng();
  }

  // ---------------------------------------------------------------- paint

  /** A tint and kind (0 rock, 1 pale, 2 sand/wood/cloth, 3 flame, 4 mineral) as a paint index, for grid.paintF / paintC. */
  paint(r: number, g: number, b: number, kind = 0): number {
    for (let i = 0; i < this.paints.length; i++) {
      const p = this.paints[i];
      if (p[0] === r && p[1] === g && p[2] === b && p[3] === kind) return i;
    }
    if (this.paints.length >= 64) return 0;
    this.paints.push([r, g, b, kind]);
    return this.paints.length - 1;
  }

  /** The tint and kind of the props that follow. */
  color(r: number, g: number, b: number, kind = 0): void {
    this.paintNow = [r, g, b, kind];
  }

  // ---------------------------------------------------------------- the way in

  /**
   * The way down the hole, from the antechamber floor (y = 0 at u = -halfU) to `foot` at
   * u = +halfU, where the kind's own passage takes over under the lid. Where the lid is close
   * it is one straight flight; deeper, it is a stairwell: flights down one side of the hole and
   * back along the other, a landing at each end, until the foot is reached going +u.
   */
  holeStair(): void {
    const g = this.grid;
    const hu = DEEP_HOLE.halfU;
    const hv = DEEP_HOLE.halfV;
    const foot = this.foot;
    const n = this.flights;
    const keepR = g.roughNow;
    g.roughNow = 0;
    if (n === 1) {
      const s = foot / (2 * hu);
      g.carveFn(-hu, -hv, hu, hv, (u, _v, o) => {
        o.floor = s * (u + hu);
        o.ceil = OPEN;
        o.su = s;
        o.steps = true;
        return true;
      });
    } else {
      // the whole well, then slabs put back into it: flights 4 m long between 2 m landings
      g.carveFn(-hu, -hv, hu, hv, (_u, _v, o) => {
        o.floor = foot;
        o.ceil = OPEN;
        return true;
      });
      const h = -foot / n;
      const run = hu;
      const thick = 0.5 + (h / run) * g.cu * 0.5;
      for (let i = 0; i < n; i++) {
        const dir = i % 2 === 0 ? 1 : -1;
        const lane = (-dir * hv) / 2;
        const y0 = -i * h;
        const y1 = i === n - 1 ? foot : y0 - h;
        // a landing at its head (the last flight's foot is the well's own floor)
        g.fillBox(dir > 0 ? -hu : run / 2, -hv, dir > 0 ? -run / 2 : hu, hv, y0 - 0.6, y0);
        g.fillRun([(-dir * run) / 2, y0, lane], [(dir * run) / 2, y1, lane], hv, i === n - 1 ? h + 2 : thick, { steps: true });
      }
    }
    g.roughNow = keepR;
    // what daylight the antechamber has, falling down the well
    this.lights.shafts.push({ u: 0, v: 0, y: 0.5, r: hv, strength: 0.4, floor: foot, fade: 16 });
    this.stairHead();
  }

  /**
   * The head of the stair, up in the antechamber: somebody built this. Paving laid round the
   * mouth, a coping of dressed blocks on the three sides that are a drop, and at the side the
   * stair is entered from a gate of two posts under a lintel, a lantern on each post.
   * (None of it is solid: outside the hole and above the lid the ground is the terrain's.)
   */
  private stairHead(): void {
    const hu = DEEP_HOLE.halfU;
    const hv = DEEP_HOLE.halfV;
    const r = this.r.bind(this);
    const stone = (k: number) => this.color(0.86 * k, 0.83 * k, 0.76 * k, 1);

    // paving: courses of slabs round the mouth, wider toward the way in
    const PV = 1.9;
    const course = (u0: number, u1: number, v0: number, v1: number, along: boolean) => {
      const len = along ? u1 - u0 : v1 - v0;
      const n = Math.max(1, Math.round(len / 1.35));
      for (let i = 0; i < n; i++) {
        const a = i / n;
        const b = (i + 1) / n;
        stone(r(0.74, 0.9));
        const gap = 0.035;
        if (along) this.box(u0 + (len * (a + b)) / 2, r(0.03, 0.06), (v0 + v1) / 2, len * (b - a) - gap, 0.05, v1 - v0 - gap);
        else this.box((u0 + u1) / 2, r(0.03, 0.06), v0 + (len * (a + b)) / 2, u1 - u0 - gap, 0.05, len * (b - a) - gap);
      }
    };
    course(-hu - 3.2, hu + PV, hv, hv + PV / 2, true);
    course(-hu - 3.2, hu + PV, hv + PV / 2, hv + PV, true);
    course(-hu - 3.2, hu + PV, -hv - PV / 2, -hv, true);
    course(-hu - 3.2, hu + PV, -hv - PV, -hv - PV / 2, true);
    course(hu, hu + PV / 2, -hv, hv, false);
    course(hu + PV / 2, hu + PV, -hv, hv, false);
    for (let k = 0; k < 3; k++) course(-hu - 3.2 + k * 1.07, -hu - 3.2 + (k + 1) * 1.07, -hv, hv, false);

    // coping: a kerb of blocks along both long sides (from where the floor falls away) and the far end
    const KW = 0.46;
    const KH = 0.42;
    const kerb = (u0: number, u1: number, v0: number, v1: number, along: boolean) => {
      const len = along ? u1 - u0 : v1 - v0;
      const n = Math.max(1, Math.round(len / 0.95));
      for (let i = 0; i < n; i++) {
        const m = (i + 0.5) / n;
        const l = len / n - 0.03;
        const h = KH + r(-0.04, 0.04);
        stone(r(0.84, 1));
        if (along) this.box(u0 + len * m, 0.05, (v0 + v1) / 2 + r(-0.015, 0.015), l, h, KW);
        else this.box((u0 + u1) / 2 + r(-0.015, 0.015), 0.05, v0 + len * m, KW, h, l);
      }
    };
    kerb(-hu / 2, hu + KW, hv, hv + KW, true);
    kerb(-hu / 2, hu + KW, -hv - KW, -hv, true);
    kerb(hu, hu + KW, -hv, hv, false);

    // the gate: two posts on plinths, a lintel across, lanterns
    const gu = -hu - 0.1;
    const PH = 2.7;
    for (const sd of [-1, 1]) {
      const pv = sd * (hv + 0.42);
      stone(0.92);
      this.box(gu, 0.05, pv, 1.0, 0.3, 1.0);
      stone(1);
      this.box(gu, 0.35, pv, 0.72, PH - 0.35, 0.72);
      stone(0.9);
      this.box(gu, PH, pv, 0.92, 0.2, 0.92);
      this.lamp(gu, PH + 0.75, pv, { reach: 11, strength: 0.9 });
    }
    stone(0.96);
    this.box(gu, PH + 0.2, 0, 0.8, 0.46, 2 * hv + 2.3);
    stone(0.86);
    this.box(gu, PH + 0.66, 0, 0.95, 0.14, 2 * hv + 2.6);
    // a mark cut in the middle of the lintel, still holding a little light
    this.color(0.45, 0.45, 0.45, 4);
    for (const q of [-1, 0, 1]) this.box(gu - 0.42, PH + 0.32 + (q === 0 ? 0.04 : 0), q * 0.3, 0.05, q === 0 ? 0.3 : 0.2, 0.08);
  }

  /** The floor under (or next above) a point, local. +Infinity in solid rock. */
  floorY(u: number, v: number, y: number): number {
    return this.grid.floorAt(u, v, y);
  }

  // ---------------------------------------------------------------- light

  /** A light that is only baked: no flame, nothing drawn. */
  light(u: number, y: number, v: number, reach: number, strength = 1, color: readonly [number, number, number] = WARM): Lamp {
    const l: Lamp = { u, y, v, reach, r: color[0] * strength, g: color[1] * strength, b: color[2] * strength, strength, baked: true, live: true };
    this.lights.lamps.push(l);
    return l;
  }

  /** A soft disc of light facing the eye. phase < 0 holds it steady. */
  glow(u: number, y: number, v: number, size: number, color: readonly [number, number, number], phase = -1): void {
    this.glows.push(u, y, v, size, color[0], color[1], color[2], phase);
  }

  /** A lamp left burning: its flame at (u, y, v), its light baked into everything it can see. */
  lamp(u: number, y: number, v: number, o: LampOpts = {}): void {
    const size = o.size ?? 1;
    const col = o.color ?? WARM;
    this.light(u, y, v, o.reach ?? 22, o.strength ?? 1, col);
    if (o.bare) return;
    const keep = this.paintNow;
    if (o.body !== false) {
      this.color(0.5, 0.45, 0.4, 0);
      this.box(u, y - 0.5 * size, v, 0.24 * size, 0.36 * size, 0.24 * size, 0.6);
    }
    this.color(col[0] / WARM[0], col[1] / WARM[1], col[2] / WARM[2], 3);
    this.prim(OCTA, u, y - 0.13 * size, v, 0.11 * size, 0.3 * size, 0.11 * size, 0.4, 0, 0);
    this.paintNow = keep;
    const ph = o.steady ? -1 : (u * 12.9898 + v * 78.233 + y * 37.719) % 6.2831853;
    const phase = o.steady ? -1 : Math.abs(ph);
    this.glow(u, y, v, 0.42 * size, [col[0] * 0.9, col[1] * 0.9, col[2] * 0.9], phase);
    this.glow(u, y, v, 2.3 * size, [col[0] * 0.3, col[1] * 0.3, col[2] * 0.3], phase);
  }

  /**
   * Daylight from above, faked: a chimney cut up from the ceiling over (u, v) whose top glows,
   * a beam of lit dust under it, and sky light baked into what it falls on. Dims at night.
   * Cut the hall first: the chimney starts from whatever ceiling is there.
   */
  skyShaft(u: number, v: number, radius: number, strength = 1): void {
    const g = this.grid;
    const ci = g.cell(u, v);
    if (ci < 0 || g.n[ci] === 0) return;
    const k = ci * g.K + g.n[ci] - 1;
    const ceil = g.c[k];
    const floor = g.f[k];
    const top = Math.min(g.lid - 0.3, ceil + 2.5);
    // from under the lowest ceiling within the circle, so the whole patch is open to the hall
    let low = ceil;
    g.each(u - radius, v - radius, u + radius, v + radius, (cj) => {
      if (g.n[cj] > 0) low = Math.min(low, g.c[cj * g.K + g.n[cj] - 1]);
    });
    const keepC = g.paintC;
    const keepR = g.roughNow;
    g.paintC = this.skyPaint;
    g.roughNow = Math.min(keepR, 0.15);
    g.carveCyl(u, v, radius, Math.max(floor, low - 1), top);
    g.paintC = keepC;
    g.roughNow = keepR;
    this.lights.shafts.push({ u, v, y: top, r: radius, strength, floor });
    // the dust: nested cones, brightest at the core and near the top
    const N = this.tier === 2 ? 8 : 12;
    for (let ring = 0; ring < 3; ring++) {
      const r0 = radius * (0.92 - ring * 0.28);
      const r1 = r0 + 0.06 * (top - floor);
      for (let q = 0; q < N; q++) {
        const a0 = (q / N) * Math.PI * 2;
        const a1 = ((q + 1) / N) * Math.PI * 2;
        const c0 = Math.cos(a0);
        const s0 = Math.sin(a0);
        const c1 = Math.cos(a1);
        const s1 = Math.sin(a1);
        const bm = this.beams;
        bm.push(u + c0 * r0, top, v + s0 * r0, 1, u + c1 * r0, top, v + s1 * r0, 1, u + c1 * r1, floor, v + s1 * r1, 0.3);
        bm.push(u + c0 * r0, top, v + s0 * r0, 1, u + c1 * r1, floor, v + s1 * r1, 0.3, u + c0 * r1, floor, v + s0 * r1, 0.3);
      }
    }
  }

  // ---------------------------------------------------------------- props
  // Each stands with the middle of its base at (u, y, v).

  /** A box su by sy by sv, turned rotY about the vertical. */
  box(u: number, y: number, v: number, su: number, sy: number, sv: number, rotY = 0, o: PropOpts = {}): void {
    this.prim(BOX, u, y, v, su, sy, sv, rotY, o.rx ?? 0, o.rz ?? 0);
    if (o.solid && Math.max(su, sv) >= 0.5) this.blockers.push({ u, v, r: 0, hu: su / 2, hv: sv / 2, rot: rotY, y0: y, y1: y + sy });
  }

  /**
   * The waking stone: a tall carved slab on a two-step plinth, its marks dark until woken.
   * Its base stands at (u, y, v) and it faces the way rotY turns -u toward (as the carved slabs do).
   */
  stone(u: number, y: number, v: number, rotY: number): void {
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    // a point d along the thickness (toward the back) and a across the face, in the deep's frame
    const at = (d: number, a: number): [number, number] => [u + d * c + a * s, v - d * s + a * c];
    this.color(0.8, 0.77, 0.7, 1);
    this.box(u, y, v, 1.4, 0.2, 2.7, rotY, { solid: true });
    this.box(u, y + 0.2, v, 1.0, 0.2, 2.2, rotY, { solid: true });
    this.color(0.9, 0.87, 0.8, 1);
    this.box(u, y + 0.4, v, 0.6, 3.6, 1.7, rotY, { solid: true });
    this.color(0.55, 0.55, 0.55, 6);
    const rows = [3, 4, 4];
    let r = 0;
    for (let row = 0; row < rows.length; row++) {
      const n = rows[row];
      for (let q = 0; q < n; q++) {
        const tall = (row + q) % 3 === 1;
        const [mu, mv] = at(-0.32, (q - (n - 1) / 2) * 0.34);
        const my = y + 1.2 + row * 0.8 + (tall ? 0 : 0.15);
        this.box(mu, my, mv, 0.06, tall ? 0.4 : 0.09, tall ? 0.09 : 0.2 + 0.04 * ((q + r) % 3), rotY);
        r++;
      }
    }
    const [su, sv] = at(-1.6, 0);
    this.stoneAt = [su, y + 1.6, sv];
  }

  /** An upright cylinder (or a frustum, with o.top). */
  cyl(u: number, y: number, v: number, radius: number, height: number, o: PropOpts = {}): void {
    const geo = cylinder(o.sides ?? 8, o.seg ?? Math.max(1, Math.ceil(height / 4)), o.top ?? 1);
    this.prim(geo, u, y, v, radius, height, radius, 0, o.rx ?? 0, o.rz ?? 0);
    if (o.solid && radius >= 0.25) this.blockers.push({ u, v, r: radius, hu: 0, hv: 0, rot: 0, y0: y, y1: y + height });
  }

  /** A cone, point up. */
  cone(u: number, y: number, v: number, radius: number, height: number, o: PropOpts = {}): void {
    this.cyl(u, y, v, radius, height, { ...o, top: 0 });
  }

  /** Any triangle soup (9 numbers per triangle, in a unit frame with its base on y = 0), placed, scaled and turned. */
  prim(tris: ArrayLike<number>, u: number, y: number, v: number, sx: number, sy: number, sz: number, ry = 0, rx = 0, rz = 0): void {
    _e.set(rx, ry, rz, 'YXZ');
    _m.compose(_p.set(u, y, v), _q.setFromEuler(_e), _s.set(sx, sy, sz));
    const vb = this.props;
    const p = this.paintNow;
    for (let i = 0; i < tris.length; i += 9) {
      _a.set(tris[i], tris[i + 1], tris[i + 2]).applyMatrix4(_m);
      _b.set(tris[i + 3], tris[i + 4], tris[i + 5]).applyMatrix4(_m);
      _c.set(tris[i + 6], tris[i + 7], tris[i + 8]).applyMatrix4(_m);
      const nx = (_b.y - _a.y) * (_c.z - _a.z) - (_b.z - _a.z) * (_c.y - _a.y);
      const ny = (_b.z - _a.z) * (_c.x - _a.x) - (_b.x - _a.x) * (_c.z - _a.z);
      const nz = (_b.x - _a.x) * (_c.y - _a.y) - (_b.y - _a.y) * (_c.x - _a.x);
      const nl = Math.hypot(nx, ny, nz) || 1;
      const ax = nx / nl;
      const ay = ny / nl;
      const az = nz / nl;
      const i0 = vb.vert(_a.x, _a.y, _a.z, _a.x + ax * 0.15, _a.y + ay * 0.15, _a.z + az * 0.15, ax, ay, az, p);
      vb.vert(_b.x, _b.y, _b.z, _b.x + ax * 0.15, _b.y + ay * 0.15, _b.z + az * 0.15, ax, ay, az, p);
      vb.vert(_c.x, _c.y, _c.z, _c.x + ax * 0.15, _c.y + ay * 0.15, _c.z + az * 0.15, ax, ay, az, p);
      vb.tri(i0, i0 + 1, i0 + 2);
    }
  }

  // ---------------------------------------------------------------- finish

  /** Mesh, bake, and hand over the built deep. Nothing may be carved after this. */
  finish(marks: Marks): BuiltDeep {
    const { spec, grid, lights } = this;
    const t1 = now();
    lights.index(grid);

    // the rock
    const vb = new VB();
    meshGrid(grid, vb, { wallStep: this.wallStep, seed: spec.seed, lit: (u, y, v) => lights.lit(u, y, v), paints: this.paints });
    const t2 = now();

    // light: props first, while nothing stands in their own way; then the rock, with them in it
    const pl = bake(this.props, lights);
    for (const k of this.blockers) {
      if (k.r > 0) grid.fillCyl(k.u, k.v, k.r, k.y0, k.y1, HEADROOM);
      else {
        const cs = Math.cos(k.rot);
        const sn = Math.sin(k.rot);
        const ext = Math.hypot(k.hu, k.hv);
        let any = false;
        grid.each(k.u - ext, k.v - ext, k.u + ext, k.v + ext, (ci, cu, cv) => {
          const du = cu - k.u;
          const dv = cv - k.v;
          if (Math.abs(du * cs - dv * sn) <= k.hu && Math.abs(du * sn + dv * cs) <= k.hv) {
            grid.fillCell(ci, k.y0, k.y1, 0, 0, false, HEADROOM);
            any = true;
          }
        });
        if (!any && Math.min(k.hu, k.hv) >= 0.35) {
          const ci = grid.cell(k.u, k.v);
          if (ci >= 0) grid.fillCell(ci, k.y0, k.y1, 0, 0, false, HEADROOM);
        }
      }
    }
    const rl = bake(vb, lights);
    const t3 = now();

    // one geometry for the rock and everything standing on it
    const pv = this.props;
    const nv = vb.n + pv.n;
    const pos = new Float32Array(nv * 3);
    pos.set(vb.pos.subarray(0, vb.n * 3));
    pos.set(pv.pos.subarray(0, pv.n * 3), vb.n * 3);
    const tint = new Uint8Array(nv * 4);
    tint.set(vb.tint.subarray(0, vb.n * 4));
    tint.set(pv.tint.subarray(0, pv.n * 4), vb.n * 4);
    const lgt = new Uint8Array(nv * 4);
    lgt.set(rl);
    lgt.set(pl, vb.n * 4);
    const idx = new Uint32Array(vb.ni + pv.ni);
    idx.set(vb.idx.subarray(0, vb.ni));
    for (let i = 0; i < pv.ni; i++) idx[vb.ni + i] = pv.idx[i] + vb.n;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 4, true));
    geo.setAttribute('aLight', new THREE.BufferAttribute(lgt, 4, true));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();

    const mats = deepMaterials(this.uniforms);
    const group = new THREE.Group();
    group.name = 'deep';
    group.position.set(spec.x, spec.y, spec.z);
    group.rotation.y = Math.atan2(-spec.dz, spec.dx);
    const geos: THREE.BufferGeometry[] = [geo];
    group.add(new THREE.Mesh(geo, mats.rock));

    const water = meshWater(grid);
    if (water) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(water, 3));
      const wl = new Uint8Array((water.length / 3) * 4);
      const o4 = new Float32Array(4);
      for (let i = 0; i < water.length / 3; i++) {
        lights.sample(water[i * 3], water[i * 3 + 1] + 0.2, water[i * 3 + 2], 0, 1, 0, o4);
        for (let q = 0; q < 4; q++) wl[i * 4 + q] = lightByte(o4[q]);
      }
      wg.setAttribute('aLight', new THREE.BufferAttribute(wl, 4, true));
      wg.computeBoundingSphere();
      geos.push(wg);
      group.add(new THREE.Mesh(wg, mats.water));
    }
    if (this.beams.length > 0) {
      const n = this.beams.length / 4;
      const bp = new Float32Array(n * 3);
      const bf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        bp[i * 3] = this.beams[i * 4];
        bp[i * 3 + 1] = this.beams[i * 4 + 1];
        bp[i * 3 + 2] = this.beams[i * 4 + 2];
        bf[i] = this.beams[i * 4 + 3];
      }
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(bp, 3));
      bg.setAttribute('aFade', new THREE.BufferAttribute(bf, 1));
      bg.computeBoundingSphere();
      geos.push(bg);
      const bm = new THREE.Mesh(bg, mats.beam);
      bm.renderOrder = 9;
      group.add(bm);
    }
    if (this.glows.length > 0) {
      const gm = glowMesh(this.glows, mats.glow);
      geos.push(gm.geometry);
      group.add(gm);
    }

    // the waking stone: asleep (-1), or woken at a time on the same clock as the flames
    const stoneAt = this.stoneAt;
    if (stoneAt) mats.stone.value.set(stoneAt[0], stoneAt[1], stoneAt[2]);
    let wokenAt = -1;
    let instant = false;

    // the relic is its own small thing, so it can be lifted off its stone
    let relicObj: THREE.Group | null = null;
    let relicLamp: Lamp | null = null;
    if (marks.relic) {
      const [ru, ry, rv] = marks.relic;
      const rb = new VB();
      const p = [1, 1, 1, 3];
      for (let i = 0; i < OCTA.length; i += 9) {
        const i0 = rb.n;
        for (let q = 0; q < 9; q += 3) {
          const x = ru + OCTA[i + q] * 0.15;
          const y = ry + (OCTA[i + q + 1] - 0.5) * 0.48;
          const z = rv + OCTA[i + q + 2] * 0.15;
          rb.vert(x, y, z, x, y, z, 0, 1, 0, p);
        }
        rb.tri(i0, i0 + 1, i0 + 2);
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.BufferAttribute(rb.pos.slice(0, rb.n * 3), 3));
      rg.setAttribute('aTint', new THREE.BufferAttribute(rb.tint.slice(0, rb.n * 4), 4, true));
      rg.setAttribute('aLight', new THREE.BufferAttribute(new Uint8Array(rb.n * 4), 4, true));
      rg.computeBoundingSphere();
      const gl = glowMesh([ru, ry, rv, 0.9, 1, 0.72, 0.38, -1, ru, ry, rv, 3.2, 1, 0.72, 0.38, -1], mats.glow);
      relicObj = new THREE.Group();
      relicObj.add(new THREE.Mesh(rg, mats.rock), gl);
      geos.push(rg, gl.geometry);
      group.add(relicObj);
      relicLamp = { u: ru, y: ry, v: rv, reach: 7, r: 1, g: 0.72, b: 0.38, strength: 0.8, baked: false, live: true };
      lights.lamps.push(relicLamp);
      lights.index(grid);
    }

    const t4 = now();
    const stats: DeepStats = {
      triangles: idx.length / 3 + this.beams.length / 12 + (this.glows.length / 8) * 2 + (water ? water.length / 9 : 0),
      vertices: nv,
      cells: grid.nu * grid.nv,
      lamps: lights.lamps.length,
      drawCalls: group.children.length + (relicObj ? 1 : 0),
      carveMs: t1 - this.t0,
      meshMs: t2 - t1,
      bakeMs: t3 - t2,
      totalMs: t4 - this.t0,
      refused: grid.refused,
      overflow: grid.overflow,
    };

    // ---- the built deep: everything below answers in world space
    const { x: ox, y: oy, z: oz, dx, dz, u1, v0, v1, lid } = spec;
    const HU = DEEP_HOLE.halfU;
    const HV = DEEP_HOLE.halfV;
    const world = (p: Pt): [number, number, number] => [ox + p[0] * dx - p[2] * dz, oy + p[1], oz + p[0] * dz + p[2] * dx];
    const step = Math.min(0.3, Math.min(grid.cu, grid.cv) * 0.4);
    /** Whether the grid has a say at a local point; elsewhere a sight line passes. */
    const ours = (u: number, y: number, v: number): boolean => (u >= -HU && u <= HU && v >= -HV && v <= HV) || y < lid;
    /**
     * Whether a sight line is stopped at a local point. Under the lid and down the hole the grid
     * says; between the lid and the antechamber floor there is only rock, whatever the grid
     * holds (it cuts nothing there), so an eye can never rise out through a passage's roof.
     */
    const stops = (u: number, y: number, v: number): boolean => (ours(u, y, v) ? !grid.isAir(u, y, v) : y < -0.2);

    return {
      spec,
      group,
      grid,
      stats,
      relic: marks.relic ? world(marks.relic) : null,
      stone: stoneAt ? world(stoneAt) : null,
      get woken() {
        return instant || wokenAt >= 0;
      },
      wake(inst) {
        if (inst) instant = true;
        else if (wokenAt < 0) wokenAt = mats.time.value;
      },
      centre: world(marks.centre),
      ledge: world(marks.ledge),

      toLocal(x, y, z, out) {
        const rx = x - ox;
        const rz = z - oz;
        out[0] = rx * dx + rz * dz;
        out[1] = y - oy;
        out[2] = rz * dx - rx * dz;
        return out;
      },

      floorAt(x, z, y) {
        const rx = x - ox;
        const rz = z - oz;
        const u = rx * dx + rz * dz;
        const v = rz * dx - rx * dz;
        const ly = y - oy;
        if (!(u >= -HU && u <= HU && v >= -HV && v <= HV)) {
          if (ly >= lid || u < 0 || u > u1 || v < v0 || v > v1) return null;
        }
        return grid.floorAt(u, v, ly) + oy;
      },

      ceilAt(x, z, y) {
        const rx = x - ox;
        const rz = z - oz;
        const u = rx * dx + rz * dz;
        const v = rz * dx - rx * dz;
        const ly = y - oy;
        if (!ours(u, ly, v)) return Infinity;
        return grid.ceilAt(u, v, ly) + oy;
      },

      inside(x, y, z) {
        const rx = x - ox;
        const rz = z - oz;
        const u = rx * dx + rz * dz;
        const v = rz * dx - rx * dz;
        const ly = y - oy;
        // under the lid, or far enough down the hole to be off the antechamber's floor
        if (ly >= lid && !(ly < -0.3 && u >= -HU && u <= HU && v >= -HV && v <= HV)) return false;
        return grid.isAir(u, ly + 0.3, v) || grid.isAir(u, ly, v);
      },

      sight(from, to) {
        const fx = from.x - ox;
        const fz = from.z - oz;
        const au = fx * dx + fz * dz;
        const av = fz * dx - fx * dz;
        const ay = from.y - oy;
        const tx = to.x - ox;
        const tz = to.z - oz;
        const du = tx * dx + tz * dz - au;
        const dv = tz * dx - tx * dz - av;
        const dy = to.y - oy - ay;
        const d = Math.sqrt(du * du + dy * dy + dv * dv);
        if (d < 1e-4) return 1;
        const n = Math.min(96, Math.max(1, Math.ceil(d / step)));
        let hit = -1;
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = au + du * t;
          const y = ay + dy * t;
          const v = av + dv * t;
          if (stops(u, y, v)) {
            hit = i;
            break;
          }
        }
        if (hit < 0) return 1;
        // close in on where it meets the rock
        let lo = (hit - 1) / n;
        let hi = hit / n;
        for (let q = 0; q < 5; q++) {
          const t = (lo + hi) * 0.5;
          const u = au + du * t;
          const y = ay + dy * t;
          const v = av + dv * t;
          if (stops(u, y, v)) hi = t;
          else lo = t;
        }
        return lo;
      },

      glowAt(x, y, z, out) {
        const rx = x - ox;
        const rz = z - oz;
        const u = rx * dx + rz * dz;
        const v = rz * dx - rx * dz;
        const ly = y - oy;
        const li = lights.best(u, ly, v);
        if (li >= 0) {
          const l = lights.lamps[li];
          out[0] = ox + l.u * dx - l.v * dz;
          out[1] = oy + l.y;
          out[2] = oz + l.u * dz + l.v * dx;
          out[3] = l.reach;
          return true;
        }
        // in a shaft's beam by day: lit from the opening
        if (mats.sky.value > 0.3) {
          for (const s of lights.shafts) {
            const R = s.r + 0.06 * (s.y - ly) + 1;
            if ((s.u - u) * (s.u - u) + (s.v - v) * (s.v - v) < R * R && ly < s.y && (s.fade === undefined || s.y - ly < s.fade * 0.6)) {
              out[0] = ox + s.u * dx - s.v * dz;
              out[1] = oy + s.y;
              out[2] = oz + s.u * dz + s.v * dx;
              out[3] = (s.y - ly) * 2.5 + 20;
              return true;
            }
          }
        }
        return false;
      },

      waterAt(x, z, y) {
        if (!grid.water) return 0;
        const rx = x - ox;
        const rz = z - oz;
        return grid.waterAt(rx * dx + rz * dz, rz * dx - rx * dz, y - oy);
      },

      wetness(x, y, z) {
        const w = grid.water;
        if (!w) return 0;
        const rx = x - ox;
        const rz = z - oz;
        const u = rx * dx + rz * dz;
        const v = rz * dx - rx * dz;
        const ly = y - oy;
        // open water within about ten metres, weighed by how near
        let sum = 0;
        let tot = 0;
        for (let dj = -2; dj <= 2; dj++) {
          for (let di = -2; di <= 2; di++) {
            const wgt = 1 / (1 + di * di + dj * dj);
            tot += wgt;
            const ci = grid.cell(u + di * 4, v + dj * 4);
            if (ci < 0) continue;
            const lv = w[ci];
            if (lv === lv && Math.abs(lv - ly) < 8 && grid.isAir(u + di * 4, lv + 0.2, v + dj * 4)) sum += wgt;
          }
        }
        return Math.min(1, (sum / tot) * 1.6);
      },

      takeRelic() {
        if (relicObj) relicObj.visible = false;
        if (relicLamp) relicLamp.live = false;
      },

      update(time, day) {
        mats.time.value = time;
        mats.wake.value = instant ? 1e4 : wokenAt >= 0 ? time - wokenAt : -1;
        const d = Math.min(1, Math.max(0, day));
        mats.sky.value = 0.05 + 0.95 * d * d * (3 - 2 * d);
      },

      dispose() {
        for (const g of geos) g.dispose();
        mats.dispose();
        group.removeFromParent();
      },
    };
  }
}

/** Light for every vertex of vb, as bytes. Flames, minerals and sky are their own light. */
function bake(vb: VB, lights: Lights): Uint8Array {
  const out = new Uint8Array(vb.n * 4);
  const o = new Float32Array(4);
  const { spos, nrm, tint } = vb;
  for (let i = 0; i < vb.n; i++) {
    if (tint[i * 4 + 3] >= 3) continue;
    const a = i * 3;
    lights.sample(spos[a], spos[a + 1], spos[a + 2], nrm[a] / 127, nrm[a + 1] / 127, nrm[a + 2] / 127, o);
    const b = i * 4;
    out[b] = lightByte(o[0]);
    out[b + 1] = lightByte(o[1]);
    out[b + 2] = lightByte(o[2]);
    out[b + 3] = lightByte(o[3]);
  }
  return out;
}

function glowMesh(g: number[], mat: THREE.Material): THREE.Mesh {
  const n = g.length / 8;
  const pos = new Float32Array(n * 12);
  const corner = new Float32Array(n * 8);
  const size = new Float32Array(n * 4);
  const col = new Float32Array(n * 12);
  const phase = new Float32Array(n * 4);
  const idx = new Uint16Array(n * 6);
  const C = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let i = 0; i < n; i++) {
    for (let q = 0; q < 4; q++) {
      const v = i * 4 + q;
      pos.set([g[i * 8], g[i * 8 + 1], g[i * 8 + 2]], v * 3);
      corner.set([C[q * 2], C[q * 2 + 1]], v * 2);
      size[v] = g[i * 8 + 3];
      col.set([g[i * 8 + 4], g[i * 8 + 5], g[i * 8 + 6]], v * 3);
      phase[v] = g[i * 8 + 7];
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 10;
  return m;
}

// ---------------------------------------------------------------- unit shapes
// Triangle soups in a unit frame: base on y = 0, top at y = 1, half-width 0.5 (boxes) or radius 1 (round things).

const BOX = ((): Float32Array => {
  const q = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  const h = 0.5;
  const p = (x: number, y: number, z: number) => [x * h, y, z * h];
  return new Float32Array([
    ...q(p(-1, 0, 1), p(1, 0, 1), p(1, 1, 1), p(-1, 1, 1)),
    ...q(p(1, 0, -1), p(-1, 0, -1), p(-1, 1, -1), p(1, 1, -1)),
    ...q(p(1, 0, 1), p(1, 0, -1), p(1, 1, -1), p(1, 1, 1)),
    ...q(p(-1, 0, -1), p(-1, 0, 1), p(-1, 1, 1), p(-1, 1, -1)),
    ...q(p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1)),
    ...q(p(-1, 0, -1), p(1, 0, -1), p(1, 0, 1), p(-1, 0, 1)),
  ]);
})();

/** Two pyramids base to base: a flame, a relic. Radius 1, y from 0 to 1. */
const OCTA = ((): Float32Array => {
  const out: number[] = [];
  const ring = [[1, 0.5, 0], [0, 0.5, 1], [-1, 0.5, 0], [0, 0.5, -1]];
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    out.push(...a, 0, 1, 0, ...b, ...b, 0, 0, 0, ...a);
  }
  return new Float32Array(out);
})();

const cylCache = new Map<number, Float32Array>();
function cylinder(sides: number, seg: number, top: number): Float32Array {
  const key = sides * 1000 + seg + top * 1e6;
  let g = cylCache.get(key);
  if (g) return g;
  const out: number[] = [];
  for (let s = 0; s < seg; s++) {
    const y0 = s / seg;
    const y1 = (s + 1) / seg;
    const r0 = 1 + (top - 1) * y0;
    const r1 = 1 + (top - 1) * y1;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      out.push(c0 * r0, y0, s0 * r0, c0 * r1, y1, s0 * r1, c1 * r1, y1, s1 * r1);
      if (r0 > 0) out.push(c0 * r0, y0, s0 * r0, c1 * r1, y1, s1 * r1, c1 * r0, y0, s1 * r0);
    }
  }
  if (top > 0) {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      out.push(0, 1, 0, Math.cos(a1) * top, 1, Math.sin(a1) * top, Math.cos(a0) * top, 1, Math.sin(a0) * top);
    }
  }
  g = new Float32Array(out);
  cylCache.set(key, g);
  return g;
}

export { WARM, TEAL };
