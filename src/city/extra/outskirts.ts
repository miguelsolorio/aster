import * as THREE from 'three';
import { Writer, dome, polyCap, taper } from '../build';
import { GLOW, MAT, createGlowMaterial, createMasonryMaterial, trackViewport } from '../cityShaders';
import type { Emitter, Extra, ExtraBuilder, ExtraCtx, Solid } from '../extras';
import type { CityKind } from '../types';
import { reeds, shrub, tree } from './plants';

// The worked land around a city, in a ring from the paved edge out to a few hundred metres:
// walled gardens and orchards with low field walls between them, tent camps for travellers
// round a fire, pens of resting pack animals, windmills with turning cloth sails, watchtowers
// on the nearby crests with a beacon that reads for kilometres at night, a burial ground of
// standing stelae set apart from the rest and, against the rock of a canyon, tomb fronts cut
// into the cliff.
//
// Outside the paved area the ground is not flat, so everything is placed by measured slope:
// a lazily sampled 4 m height grid answers "how far does the ground fall over this footprint
// and how steep is its steepest step", and anything that fails is simply not built there.
//
// Draws: towers and windmills each get their own always-visible mesh (offset so the masonry
// shader's dust line, which reads local y, sits at their foot); the small things are merged
// per 100 m cell and each cell is hidden beyond HIDE. Sails are one shared geometry, turned in
// update(). Fires, lanterns and beacons are glow points; beacons and windmills also go into
// the skyline (`far`) group.

const TAU = Math.PI * 2;
const CELL = 100;
const HIDE = 350;
const GS = 4; // ground grid step, metres
const EDGE_PAD = 12; // keep this far beyond the paved edge

const key = (i: number, j: number): number => (i + 4096) * 8192 + (j + 4096);
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const byte = (s: number): number => clamp(Math.round(s * 255), 0, 255);

interface Tune {
  plots: number;
  /** Share of the plots that are orchards; the rest are gardens. */
  orchardP: number;
  /** Share of the orchards planted with fan palms (the rest with round fruit trees). */
  palmP: number;
  /** Chance a garden has a ditch of reeds along one wall. */
  reedP: number;
  /** Chance the next plot is set against an earlier one (patchwork) rather than anywhere. */
  clusterP: number;
  /** Farthest a plot is set from the paved edge. */
  plotFar: number;
  fieldWalls: number;
  camps: number;
  pens: number;
  mills: number;
  towers: number;
  /** Least prominence (metres over the ground 60 m around) for a watchtower crest. */
  prom: number;
  tombs: number;
  stelae: number;
  /** Walls of mud (plaster) rather than stone. */
  mud: boolean;
}

const TUNE: Record<CityKind, Tune> = {
  oasis: { plots: 26, orchardP: 0.55, palmP: 0.65, reedP: 0.7, clusterP: 0.7, plotFar: 230, fieldWalls: 6, camps: 2, pens: 1, mills: 2, towers: 2, prom: 5, tombs: 0, stelae: 36, mud: true },
  trade: { plots: 8, orchardP: 0.25, palmP: 0.4, reedP: 0.15, clusterP: 0.5, plotFar: 240, fieldWalls: 8, camps: 4, pens: 4, mills: 5, towers: 1, prom: 2.5, tombs: 0, stelae: 34, mud: true },
  hill: { plots: 16, orchardP: 0.35, palmP: 0.2, reedP: 0, clusterP: 0.6, plotFar: 300, fieldWalls: 6, camps: 2, pens: 2, mills: 2, towers: 4, prom: 2.5, tombs: 0, stelae: 34, mud: false },
  canyon: { plots: 4, orchardP: 0.4, palmP: 0.5, reedP: 0, clusterP: 0.5, plotFar: 260, fieldWalls: 2, camps: 2, pens: 1, mills: 1, towers: 4, prom: 6, tombs: 7, stelae: 60, mud: false },
};

// ------------------------------------------------------------------ ground

/** Terrain heights on a 4 m grid, sampled on first use, with bilinear lookups between nodes. */
class Ground {
  private v: Float32Array;
  private n: number;
  calls = 0;

  constructor(
    private ctx: ExtraCtx,
    private half: number,
  ) {
    this.n = Math.ceil((2 * half) / GS) + 2;
    this.v = new Float32Array(this.n * this.n).fill(NaN);
  }

  node(i: number, j: number): number {
    const n = this.n;
    i = i < 0 ? 0 : i >= n ? n - 1 : i;
    j = j < 0 ? 0 : j >= n ? n - 1 : j;
    const k = j * n + i;
    let g = this.v[k];
    if (g !== g) {
      g = this.ctx.groundAt(i * GS - this.half, j * GS - this.half);
      this.v[k] = g;
      this.calls++;
    }
    return g;
  }

  at(x: number, z: number): number {
    const fx = (x + this.half) / GS, fz = (z + this.half) / GS;
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const a = this.node(i, j), b = this.node(i + 1, j), c = this.node(i, j + 1), d = this.node(i + 1, j + 1);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  }

  /** Lowest and highest ground over a rectangle, and the largest rise between neighbouring nodes. */
  span(x0: number, z0: number, x1: number, z1: number, out: Span): Span {
    const i0 = Math.floor((x0 + this.half) / GS), i1 = Math.ceil((x1 + this.half) / GS);
    const j0 = Math.floor((z0 + this.half) / GS), j1 = Math.ceil((z1 + this.half) / GS);
    let lo = Infinity, hi = -Infinity, step = 0;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const g = this.node(i, j);
        if (g < lo) lo = g;
        if (g > hi) hi = g;
        if (i > i0) step = Math.max(step, Math.abs(g - this.node(i - 1, j)));
        if (j > j0) step = Math.max(step, Math.abs(g - this.node(i, j - 1)));
      }
    out.lo = lo;
    out.hi = hi;
    out.step = step;
    return out;
  }
}

interface Span {
  lo: number;
  hi: number;
  step: number;
}

// ------------------------------------------------------------------ ways out of town

/** A line from the centre outward (an avenue or a caravan track) and how far to keep off it. */
interface Way {
  ux: number;
  uz: number;
  hw: number;
  track: boolean;
}

/**
 * The avenues (from the plan's avenue ends and from the bearings the terrain is carved along)
 * and the two caravan tracks. The track bearings live only in the shared city uniforms, which
 * hold the sites around the player; a city built while out of that set keeps off its avenues only.
 */
function waysOut(ctx: ExtraCtx): Way[] {
  const { plan, site } = ctx;
  const out: Way[] = [];
  const add = (a: number, hw: number, track: boolean) => out.push({ ux: Math.cos(a), uz: Math.sin(a), hw, track });
  // avenue ends: outermost nodes of the wide streets
  const WIDE = 8.5;
  const dist = plan.nodes.map((n) => Math.hypot(n.x, n.z));
  const nb: number[][] = plan.nodes.map(() => []);
  for (const e of plan.edges) {
    if (e.width < WIDE) continue;
    nb[e.a].push(e.b);
    nb[e.b].push(e.a);
  }
  for (let i = 0; i < plan.nodes.length; i++) {
    if (nb[i].length === 0 || dist[i] < site.radius * 0.45) continue;
    if (nb[i].some((j) => dist[j] >= dist[i])) continue;
    add(Math.atan2(plan.nodes[i].z, plan.nodes[i].x), 9, false);
  }
  // the bearings the terrain keeps open (see aveLat in placement.ts), world to local
  {
    const A = site.aveA, B = site.aveB;
    const s = Math.floor(A / 64);
    const rem = A - s * 64;
    const n = Math.floor(rem / 8);
    const base = rem - n * 8;
    const st = 0.008 * (s + 1);
    for (let k = 0; k < Math.min(n, 6); k++) {
      const q = Math.floor(B / 2 ** (4 * k)) % 16;
      add(base + (TAU * k) / n + (q - 7.5) * st - site.rot, 9, false);
    }
  }
  // tracks toward the two nearest neighbours
  for (const t of ctx.tracks) add(t - site.rot, 16, true);
  return out;
}

// ------------------------------------------------------------------ glows

class GlowList {
  readonly d: number[] = [];
  get count(): number {
    return this.d.length / 7;
  }
  add(x: number, y: number, z: number, r: number, kind: number, seed: number, bright: number): void {
    this.d.push(x, y, z, r, kind, seed, bright);
  }
  geometry(): THREE.BufferGeometry | null {
    const n = this.count;
    if (n === 0) return null;
    const pos = new Float32Array(n * 12);
    const corner = new Float32Array(n * 8);
    const glow = new Float32Array(n * 16);
    const idx = new Uint32Array(n * 6);
    const C = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < n; i++) {
      const s = i * 7;
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        pos[v * 3] = this.d[s];
        pos[v * 3 + 1] = this.d[s + 1];
        pos[v * 3 + 2] = this.d[s + 2];
        corner[v * 2] = C[k * 2];
        corner[v * 2 + 1] = C[k * 2 + 1];
        glow[v * 4] = this.d[s + 3];
        glow[v * 4 + 1] = this.d[s + 4];
        glow[v * 4 + 2] = this.d[s + 5];
        glow[v * 4 + 3] = this.d[s + 6];
      }
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('aGlow', new THREE.BufferAttribute(glow, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingBox();
    g.boundingSphere = g.boundingBox!.getBoundingSphere(new THREE.Sphere());
    g.boundingSphere.radius += 4;
    return g;
  }
}

// ------------------------------------------------------------------ small shapes

/**
 * A box from its centre and three half-axis vectors (u, v, s). mask: 1 +u, 2 -u, 4 +v, 8 -v, 16 +s, 32 -s.
 * The axes need not be axis-aligned or even upright (tilted stones, spars, legs).
 */
function ubox(
  w: Writer, cx: number, cy: number, cz: number,
  ux: number, uy: number, uz: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number,
  mask = 55,
): void {
  const P = (a: number, b: number, c: number, o: number[]) => {
    o[0] = cx + ux * a + vx * b + sx * c;
    o[1] = cy + uy * a + vy * b + sy * c;
    o[2] = cz + uz * a + vz * b + sz * c;
  };
  const p0 = [0, 0, 0], p1 = [0, 0, 0], p2 = [0, 0, 0], p3 = [0, 0, 0];
  const f = (a: number[], b: number[], c: number[], d: number[], hx: number, hy: number, hz: number) => {
    P(a[0], a[1], a[2], p0);
    P(b[0], b[1], b[2], p1);
    P(c[0], c[1], c[2], p2);
    P(d[0], d[1], d[2], p3);
    w.quadAuto(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], hx, hy, hz);
  };
  if (mask & 1) f([1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1], ux, uy, uz);
  if (mask & 2) f([-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1], -ux, -uy, -uz);
  if (mask & 4) f([-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1], vx, vy, vz);
  if (mask & 8) f([-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], -vx, -vy, -vz);
  if (mask & 16) f([-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], sx, sy, sz);
  if (mask & 32) f([-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], -sx, -sy, -sz);
}

/** A square bar of thickness t from a to b (sides only, unless ends is set). */
function bar(w: Writer, ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, ends = false): void {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = Math.hypot(dx, dy, dz);
  if (L < 1e-4) return;
  dx /= L;
  dy /= L;
  dz /= L;
  // side: horizontal and across the bar (or x for a vertical bar)
  let sx = -dz, sz = dx;
  let sl = Math.hypot(sx, sz);
  if (sl < 1e-3) {
    sx = 1;
    sz = 0;
    sl = 1;
  }
  sx /= sl;
  sz /= sl;
  // up = side x dir
  const vx = 0 * dz - sz * dy, vy = sz * dx - sx * dz, vz = sx * dy - 0 * dx;
  const h = t / 2;
  ubox(w, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, dx * L / 2, dy * L / 2, dz * L / 2, vx * h, vy * h, vz * h, sx * h, 0, sz * h, ends ? 63 : 60);
}

/** A place and heading for small models built in their own frame (+z forward). */
class Frame {
  x = 0;
  y = 0;
  z = 0;
  c = 1;
  s = 0;
  set(x: number, y: number, z: number, yaw: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.c = Math.cos(yaw);
    this.s = Math.sin(yaw);
    return this;
  }
  X(lx: number, lz: number): number {
    return this.x + lx * this.c + lz * this.s;
  }
  Z(lx: number, lz: number): number {
    return this.z - lx * this.s + lz * this.c;
  }
}

/** A bar between two points given in a frame. */
function fbar(w: Writer, F: Frame, ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number): void {
  bar(w, F.X(ax, az), F.y + ay, F.Z(ax, az), F.X(bx, bz), F.y + by, F.Z(bx, bz), t, true);
}

/** A triangle given in a frame, facing the hint (also in the frame). */
function ftri(w: Writer, F: Frame, a: number[], b: number[], c: number[], hx: number, hy: number, hz: number): void {
  w.triAuto(
    F.X(a[0], a[2]), F.y + a[1], F.Z(a[0], a[2]),
    F.X(b[0], b[2]), F.y + b[1], F.Z(b[0], b[2]),
    F.X(c[0], c[2]), F.y + c[1], F.Z(c[0], c[2]),
    hx * F.c + hz * F.s, hy, -hx * F.s + hz * F.c,
  );
}

/** A tube through rings (x, y, z, half width, half height), in a frame; the rings run roughly along the frame's z. */
function ftube(w: Writer, F: Frame, rings: number[][], sides: number, capEnd: boolean): void {
  const n = rings.length;
  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = rings[Math.max(0, i - 1)], b = rings[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // u = up x t (across), v = t x u
    let ux = tz, uz = -tx;
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul;
    uz /= ul;
    const vx = ty * uz, vy = tz * ux - tx * uz, vz = -ty * ux;
    const r = rings[i];
    const row: number[] = [];
    for (let j = 0; j < sides; j++) {
      const an = (j / sides) * TAU;
      const cs = Math.cos(an) * r[3], sn = Math.sin(an) * r[4];
      const lx = r[0] + ux * cs + vx * sn, ly = r[1] + vy * sn, lz = r[2] + uz * cs + vz * sn;
      row.push(F.X(lx, lz), F.y + ly, F.Z(lx, lz));
    }
    pts.push(row);
  }
  for (let i = 0; i < n - 1; i++) {
    const ci = rings[i], cj = rings[i + 1];
    const cx = F.X((ci[0] + cj[0]) / 2, (ci[2] + cj[2]) / 2), cy = F.y + (ci[1] + cj[1]) / 2, cz = F.Z((ci[0] + cj[0]) / 2, (ci[2] + cj[2]) / 2);
    for (let j = 0; j < sides; j++) {
      const j2 = (j + 1) % sides;
      const A = pts[i], B = pts[i + 1];
      const mx = (A[j * 3] + A[j2 * 3] + B[j * 3] + B[j2 * 3]) / 4;
      const my = (A[j * 3 + 1] + A[j2 * 3 + 1] + B[j * 3 + 1] + B[j2 * 3 + 1]) / 4;
      const mz = (A[j * 3 + 2] + A[j2 * 3 + 2] + B[j * 3 + 2] + B[j2 * 3 + 2]) / 4;
      w.quadAuto(
        A[j * 3], A[j * 3 + 1], A[j * 3 + 2], A[j2 * 3], A[j2 * 3 + 1], A[j2 * 3 + 2],
        B[j2 * 3], B[j2 * 3 + 1], B[j2 * 3 + 2], B[j * 3], B[j * 3 + 1], B[j * 3 + 2],
        mx - cx, my - cy, mz - cz,
      );
    }
  }
  if (capEnd) {
    const r = rings[n - 1], p = rings[n - 2];
    const ex = F.X(r[0], r[2]), ey = F.y + r[1], ez = F.Z(r[0], r[2]);
    const hx = F.X(r[0] - p[0], r[2] - p[2]) - F.x, hy = r[1] - p[1], hz = F.Z(r[0] - p[0], r[2] - p[2]) - F.z;
    const A = pts[n - 1];
    for (let j = 0; j < sides; j++) {
      const j2 = (j + 1) % sides;
      w.triAuto(ex, ey, ez, A[j * 3], A[j * 3 + 1], A[j * 3 + 2], A[j2 * 3], A[j2 * 3 + 1], A[j2 * 3 + 2], hx, hy, hz);
    }
  }
}

// ------------------------------------------------------------------ plants for the fields

/** A crop tuft: a small leaning three-sided spike of leaves. */
function tuft(w: Writer, x: number, y: number, z: number, s: number, tint: number, rng: () => number): void {
  const rot = rng() * TAU;
  const h = s * (0.8 + rng() * 0.5);
  const lx = (rng() - 0.5) * s * 0.4, lz = (rng() - 0.5) * s * 0.4;
  w.mat = MAT.plant;
  w.tint = clamp(tint + Math.floor((rng() - 0.5) * 50), 0, 255);
  w.reserve(4, 9);
  w.extra = 0;
  const st = w.nv;
  for (let k = 0; k < 3; k++) {
    const a = rot + (k / 3) * TAU;
    const c = Math.cos(a), q = Math.sin(a);
    w.vert(x + c * s * 0.55, y - 0.03, z + q * s * 0.55, c * 0.7, 0.7, q * 0.7, k / 3, 0);
  }
  w.extra = byte(0.3);
  const tip = w.vert(x + lx, y + h, z + lz, 0, 1, 0, 0.5, 1);
  for (let k = 0; k < 3; k++) w.index3(st + k, st + ((k + 1) % 3), tip);
  w.extra = 0;
}

/** A row of standing grain from (x0, z0) to (x1, z1): a jagged ridge of straw, segment by segment. */
function grainRow(w: Writer, G: Ground, x0: number, z0: number, x1: number, z1: number, h: number, hw: number, rng: () => number): void {
  const L = Math.hypot(x1 - x0, z1 - z0);
  const tx = (x1 - x0) / L, tz = (z1 - z0) / L;
  const nx = -tz, nz = tx;
  const n = Math.max(1, Math.round(L / 1.6));
  w.mat = MAT.cloth;
  w.extra = 0;
  let pg = G.at(x0, z0), ph = h * (0.85 + rng() * 0.3);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * L, b = ((k + 1) / n) * L;
    const ax = x0 + tx * a, az = z0 + tz * a, bx = x0 + tx * b, bz = z0 + tz * b;
    const bg = G.at(bx, bz);
    const bh = h * (0.85 + rng() * 0.3);
    w.tint = 8 + Math.floor(rng() * 40);
    for (const sg of [-1, 1]) {
      w.quadAuto(
        ax + nx * hw * sg, pg - 0.05, az + nz * hw * sg, bx + nx * hw * sg, bg - 0.05, bz + nz * hw * sg,
        bx, bg + bh, bz, ax, pg + ph, az,
        nx * sg, 0.5, nz * sg,
      );
    }
    pg = bg;
    ph = bh;
  }
}

/** A small round-crowned fruit tree. Returns the trunk height. */
function fruitTree(w: Writer, x: number, y: number, z: number, s: number, blossom: boolean, rng: () => number): number {
  const th = (1.3 + rng() * 0.6) * s;
  w.mat = MAT.wood;
  w.tint = 60 + Math.floor(rng() * 60);
  w.extra = 0;
  taper(w, x, z, 0.15 * s, 0.09 * s, y - 0.3, y + th, 5, rng() * TAU);
  shrub(w, x, y + th - 0.35 * s, z, (1.3 + rng() * 0.5) * s, false, blossom, rng);
  return th;
}

// ------------------------------------------------------------------ animals

/** A pack animal (the long-necked, fringed beast of the caravans), resting folded on the ground or standing grazing. */
function animal(w: Writer, F: Frame, lying: boolean, coat: number, rng: () => number): void {
  const setCoat = (k: number, dark: boolean) => {
    if (k === 0) {
      w.mat = MAT.cloth;
      w.tint = dark ? 150 : 20; // ochre, or rust for the darker parts
    } else if (k === 1) {
      w.mat = MAT.wood;
      w.tint = dark ? 60 : 200;
    } else {
      w.mat = MAT.soil;
      w.tint = 128;
      if (dark) {
        w.mat = MAT.wood;
        w.tint = 90;
      }
    }
  };
  w.extra = 0;
  setCoat(coat, false);
  const y0 = lying ? -0.12 : 1.55;
  ftube(w, F, [
    [0, y0 + 0.76, -1.36, 0.06, 0.06],
    [0, y0 + 0.78, -1.2, 0.2, 0.24],
    [0, y0 + 0.86, -0.75, 0.4, 0.46],
    [0, y0 + 0.88, 0, 0.45, 0.5],
    [0, y0 + 0.9, 0.7, 0.42, 0.48],
    [0, y0 + 0.98, 1.15, 0.27, 0.34],
    [0, y0 + 1.0, 1.3, 0.1, 0.12],
  ], 7, false);
  if (lying) {
    ftube(w, F, [[0, 1.05, 1.0, 0.26, 0.26], [0, 1.45, 1.35, 0.19, 0.19], [0, 1.85, 1.6, 0.15, 0.15], [0, 2.05, 1.78, 0.13, 0.13]], 5, false);
    ftube(w, F, [[0, 2.06, 1.72, 0.15, 0.14], [0, 2.03, 2.02, 0.13, 0.12], [0, 1.96, 2.3, 0.09, 0.08]], 5, true);
    // folded legs: shins tucked under the chest, haunches under the hips
    for (const sx of [-1, 1]) {
      fbar(w, F, sx * 0.3, 0.16, 1.3, sx * 0.3, 0.16, 0.5, 0.2);
      fbar(w, F, sx * 0.46, 0.24, -1.0, sx * 0.4, 0.18, -0.25, 0.22);
    }
  } else {
    const hz = rng() < 0.5 ? 2.2 : 2.05;
    ftube(w, F, [[0, 2.5, 1.0, 0.27, 0.27], [0, 2.15, 1.55, 0.19, 0.19], [0, 1.3, 1.95, 0.15, 0.15], [0, 0.72, hz, 0.13, 0.13]], 5, false);
    ftube(w, F, [[0, 0.74, hz - 0.05, 0.15, 0.14], [0, 0.48, hz + 0.17, 0.13, 0.12], [0, 0.26, hz + 0.33, 0.09, 0.08]], 5, true);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const lx = sx * 0.27, lz = sz * 0.8;
        fbar(w, F, lx, 2.2, lz, lx, 1.15, lz + 0.02 * sz, 0.3);
        fbar(w, F, lx, 1.15, lz + 0.02 * sz, lx, 0.0, lz, 0.15);
      }
  }
  // ears
  const hy = lying ? 2.12 : 0.82, hzz = lying ? 1.78 : 2.12;
  for (const s of [-1, 1]) ftri(w, F, [s * 0.08, hy, hzz], [s * 0.17, hy + 0.13, hzz - 0.06], [s * 0.12, hy, hzz + 0.1], s, 0.3, 0);
  // flank fringes and tail
  setCoat(coat, true);
  const fy = y0 + 0.8;
  const foot = lying ? 0.06 : fy - 0.85;
  for (const s of [-1, 1])
    for (const z of [-0.8, -0.35, 0.1, 0.55]) ftri(w, F, [s * 0.42, fy, z - 0.22], [s * 0.42, fy, z + 0.22], [s * 0.52, foot, z + 0.03], s, 0, 0);
  ftri(w, F, [-0.1, y0 + 0.8, -1.36], [0.1, y0 + 0.8, -1.36], [0, lying ? 0.1 : y0 + 0.1, -1.5], 0, 0, -1);
  // a rolled blanket or a load still on the back
  if (rng() < 0.45) {
    w.mat = MAT.cloth;
    w.tint = 64 + Math.floor(rng() * 128);
    w.extra = rng() < 0.5 ? 6 : 0;
    const by = y0 + 1.36;
    ubox(w, F.X(0, 0), F.y + by, F.Z(0, 0), F.c * 0.5, 0, -F.s * 0.5, 0, 0.06, 0, F.s * 0.7, 0, F.c * 0.7, 63);
    w.extra = 0;
  }
}

// ------------------------------------------------------------------ the builder

interface Part {
  w: Writer;
  base: number;
}

interface Mill {
  x: number;
  y: number;
  z: number;
  yaw: number;
  phase: number;
  dir: number;
}

export const outskirts: ExtraBuilder = (ctx: ExtraCtx): Extra => {
  const t0 = performance.now();
  const { site } = ctx;
  const T = TUNE[site.kind];
  const dens = ctx.density;
  const R = site.radius;
  const REACH = R * 1.16 + 700;
  const G = new Ground(ctx, REACH + 40);
  const ways = waysOut(ctx);
  const sp: Span = { lo: 0, hi: 0, step: 0 };

  const solids: Solid[] = [];
  const emitters: Emitter[] = [];
  const nearGlow = new GlowList();
  const farGlow = new GlowList();
  const counts = {
    towers: 0, mills: 0, camps: 0, tents: 0, pens: 0, animals: 0, plots: 0, orchards: 0, gardens: 0,
    trees: 0, tufts: 0, fieldWalls: 0, wallPieces: 0, burials: 0, stelae: 0, tombs: 0,
  };
  /** What was placed, for checks: kind, centre, half sizes, ground fall and steepest step under it. */
  const items: Array<{ kind: string; x: number; z: number; hw: number; hd: number; drop: number; step: number }> = [];

  const edgeAt = (a: number): number => {
    const w = a + site.rot;
    return R * (1 + 0.1 * Math.sin(3 * w + site.phase1) + 0.06 * Math.sin(5 * w + site.phase2));
  };
  /** Metres beyond the paved edge (negative inside it). */
  const beyond = (x: number, z: number): number => Math.hypot(x, z) - edgeAt(Math.atan2(z, x));

  // ---------------------------------------------------------------- occupancy

  const rects: number[] = []; // x0, z0, x1, z1 of everything placed here
  const hitRect = (x0: number, z0: number, x1: number, z1: number, pad: number): boolean => {
    for (let i = 0; i < rects.length; i += 4)
      if (x0 - pad < rects[i + 2] && x1 + pad > rects[i] && z0 - pad < rects[i + 3] && z1 + pad > rects[i + 1]) return true;
    return false;
  };
  /** Clearance from the ways out (negative inside a corridor). */
  const wayGap = (x0: number, z0: number, x1: number, z1: number): number => {
    let best = Infinity;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    for (const wy of ways) {
      if (cx * wy.ux + cz * wy.uz < 0) continue;
      let mn = Infinity, mx = -Infinity;
      for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
        const l = wy.ux * z - wy.uz * x;
        if (l < mn) mn = l;
        if (l > mx) mx = l;
      }
      const d = mn > 0 ? mn : mx < 0 ? -mx : -1;
      best = Math.min(best, d - wy.hw);
    }
    return best;
  };
  const outside = (x0: number, z0: number, x1: number, z1: number, pad: number): boolean => {
    const xm = (x0 + x1) / 2, zm = (z0 + z1) / 2;
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [xm, z0], [xm, z1], [x0, zm], [x1, zm]]) {
      const b = beyond(x, z);
      if (b < pad || b > REACH - R) return false;
    }
    return true;
  };
  /** Calls f(x, z, r) for circles that tile a rectangle (square tiles across its short side). */
  const tiles = (x0: number, z0: number, x1: number, z1: number, f: (x: number, z: number, r: number) => boolean): boolean => {
    const W = x1 - x0, D = z1 - z0;
    const s = Math.max(1, Math.min(W, D, 14));
    const nx = Math.ceil(W / s - 0.01), nz = Math.ceil(D / s - 0.01);
    const r = Math.hypot(W / nx, D / nz) / 2;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) if (!f(x0 + ((i + 0.5) * W) / nx, z0 + ((j + 0.5) * D) / nz, r)) return false;
    return true;
  };
  /** Is a rectangle open: past the paved edge, clear of the ways, of our own things and of anyone's claims? */
  const open = (x0: number, z0: number, x1: number, z1: number, pad: number, wayPad: number): boolean => {
    if (!outside(x0, z0, x1, z1, EDGE_PAD)) return false;
    if (wayGap(x0, z0, x1, z1) < wayPad) return false;
    if (hitRect(x0, z0, x1, z1, pad)) return false;
    // small footprints also keep a margin from others' claims (the aqueduct claims only its piers)
    if (Math.max(x1 - x0, z1 - z0) < 25 && !ctx.free((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + 4)) return false;
    return tiles(x0, z0, x1, z1, (x, z, r) => ctx.free(x, z, r * 0.85));
  };
  // Our own claims are made at the very end, so that while we build only the other extras'
  // claims (and the buildings) are seen by ctx.free; among ourselves the exact rectangles rule.
  const take = (kind: string, x0: number, z0: number, x1: number, z1: number, s: Span | null): void => {
    rects.push(x0, z0, x1, z1);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (!s) s = G.span(x0, z0, x1, z1, { lo: 0, hi: 0, step: 0 });
    items.push({ kind, x: cx, z: cz, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, drop: s.hi - s.lo, step: s.step });
  };
  /** A random point a distance t0..t1 beyond the paved edge. */
  const ringPoint = (rng: () => number, ta: number, tb: number, pw: number, out: number[]): number[] => {
    const a = rng() * TAU;
    const d = edgeAt(a) + ta + (tb - ta) * Math.pow(rng(), pw);
    out[0] = Math.cos(a) * d;
    out[1] = Math.sin(a) * d;
    return out;
  };
  const pt = [0, 0];

  // ---------------------------------------------------------------- writers

  const cells = new Map<number, Part>();
  const cellAt = (x: number, z: number, g: number): Writer => {
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    let p = cells.get(k);
    if (!p) cells.set(k, (p = { w: new Writer(2048, 4096), base: Infinity }));
    if (g - 0.6 < p.base) p.base = g - 0.6;
    return p.w;
  };
  const bigs: Part[] = [];
  const farW = new Writer(1024, 2048);
  let farBase = Infinity;
  const mills: Mill[] = [];

  /** A low wall along x (axis 0) or z (axis 1) at fixed c, from a to b, in pieces that follow the ground. */
  const wallRun = (axis: number, c: number, a: number, b: number, th: number, h: number, mat: number, tint: number, rng: () => number): void => {
    const n = Math.max(1, Math.ceil((b - a) / 4));
    for (let k = 0; k < n; k++) {
      const u0 = a + ((b - a) * k) / n, u1 = a + ((b - a) * (k + 1)) / n;
      const P = (u: number): number => (axis === 0 ? G.at(u, c) : G.at(c, u));
      const g0 = P(u0), g1 = P(u1), gm = P((u0 + u1) / 2);
      const lo = Math.min(g0, g1, gm) - 0.4;
      const top = Math.max((g0 + g1) / 2 + h, Math.max(g0, g1, gm) + h * 0.6);
      const x0 = axis === 0 ? u0 : c - th / 2, x1 = axis === 0 ? u1 : c + th / 2;
      const z0 = axis === 0 ? c - th / 2 : u0, z1 = axis === 0 ? c + th / 2 : u1;
      const w = cellAt((x0 + x1) / 2, (z0 + z1) / 2, lo + 0.4);
      w.mat = mat;
      w.tint = clamp(tint + Math.floor((rng() - 0.5) * 24), 0, 255);
      w.extra = 0;
      w.box(x0, lo, z0, x1, top, z1, 55);
      // a coping of flat stones or a rounded mud cap, a hand's width proud
      if (mat === MAT.stone) w.box(x0 - (axis === 1 ? 0.06 : 0), top, z0 - (axis === 0 ? 0.06 : 0), x1 + (axis === 1 ? 0.06 : 0), top + 0.08, z1 + (axis === 0 ? 0.06 : 0), 63);
      solids.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, y0: lo, y1: top + (mat === MAT.stone ? 0.08 : 0) });
      counts.wallPieces++;
    }
  };

  // ---------------------------------------------------------------- watchtowers on the crests

  {
    const rng = ctx.rng(0x70e1);
    const S = 30;
    const NI = Math.ceil(REACH / S);
    const N = NI * 2 + 1;
    const gr = new Float32Array(N * N).fill(NaN);
    const tt = new Float32Array(N * N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = (i - NI) * S, z = (j - NI) * S;
        const t = beyond(x, z);
        if (t < 30 || t > 680) continue;
        gr[j * N + i] = ctx.groundAt(x, z);
        tt[j * N + i] = t;
      }
    const cand: Array<{ x: number; z: number; s: number }> = [];
    for (let j = 2; j < N - 2; j++)
      for (let i = 2; i < N - 2; i++) {
        const g = gr[j * N + i];
        if (g !== g) continue;
        let top = true, sum = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const a = gr[(j + dj) * N + i + di];
            if (a > g) top = false;
            const b = gr[(j + dj * 2) * N + i + di * 2];
            if (b === b) {
              sum += b;
              n++;
            }
          }
        if (n < 5) continue;
        // prominence over the ground round about, or (a terrace lip, a cliff edge) over the land below it
        const x = (i - NI) * S, z = (j - NI) * S;
        const dl = Math.hypot(x, z) || 1;
        const oi = Math.round(i + (x / dl) * 2), oj = Math.round(j + (z / dl) * 2);
        const below = oi >= 0 && oj >= 0 && oi < N && oj < N ? gr[oj * N + oi] : NaN;
        const look = below === below ? (g - below) * 0.7 : 0;
        const prom = Math.max(g - sum / n, look);
        if (prom < T.prom || (!top && prom < T.prom * 1.6 && look < T.prom)) continue;
        // nearer and higher reads better from the town
        cand.push({ x, z, s: prom + 0.04 * g - 0.006 * tt[j * N + i] + rng() * 0.5 });
      }
    cand.sort((a, b) => b.s - a.s);
    const placed: number[] = [];
    for (const c of cand) {
      if (counts.towers >= T.towers) break;
      if (placed.some((_, k) => k % 2 === 0 && Math.hypot(placed[k] - c.x, placed[k + 1] - c.z) < 220)) continue;
      // climb to the top, then look about for the flattest spot near it
      let x = c.x, z = c.z, g = ctx.groundAt(x, z);
      for (let it = 0; it < 8; it++) {
        let bx = x, bz = z, bg = g;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * TAU;
          const qx = x + Math.cos(a) * 4, qz = z + Math.sin(a) * 4;
          const q = ctx.groundAt(qx, qz);
          if (q > bg) {
            bg = q;
            bx = qx;
            bz = qz;
          }
        }
        if (bg <= g) break;
        x = bx;
        z = bz;
        g = bg;
      }
      const s0 = 2.5;
      let best: { x: number; z: number; lo: number; hi: number } | null = null;
      for (let k = 0; k < 9; k++) {
        const a = (k / 8) * TAU, d = k === 0 ? 0 : 5;
        const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
        let lo = Infinity, hi = -Infinity;
        for (const [ox, oz] of [[-s0, -s0], [s0, -s0], [-s0, s0], [s0, s0], [0, 0], [0, s0], [0, -s0], [s0, 0], [-s0, 0]]) {
          const q = ctx.groundAt(px + ox, pz + oz);
          lo = Math.min(lo, q);
          hi = Math.max(hi, q);
        }
        if (hi < g - 2.5) continue;
        if (!best || hi - lo < best.hi - best.lo) best = { x: px, z: pz, lo, hi };
      }
      if (!best || best.hi - best.lo > 1.8) continue;
      x = best.x;
      z = best.z;
      const e = s0 + 0.4;
      if (!open(x - e, z - e, x + e, z + e, 3, 4)) continue;
      take('tower', x - e, z - e, x + e, z + e, { lo: best.lo, hi: best.hi, step: best.hi - best.lo });
      placed.push(x, z);
      watchtower(x, z, best.lo - 0.6, best.hi, (site.kind === 'canyon' ? 7.5 : 9) + rng() * 3.5, rng);
      counts.towers++;
    }
  }

  function watchtower(x: number, z: number, gb: number, gt: number, H: number, rng: () => number): void {
    const w = new Writer(512, 1024);
    bigs.push({ w, base: gb });
    const s0 = 2.5, s1 = 2.1;
    const top = gt + H;
    const e = s1 + 0.3;
    w.mat = MAT.stone;
    w.tint = 110 + Math.floor(rng() * 70);
    taper(w, x, z, s0 * Math.SQRT2, s1 * Math.SQRT2, gb, top - 0.7, 4, Math.PI / 4);
    // a corbelled gallery, the platform and its crenellated parapet
    w.box(x - e, top - 0.7, z - e, x + e, top, z + e, 1 | 2 | 8 | 16 | 32);
    w.box(x - e + 0.3, top - 0.05, z - e + 0.3, x + e - 0.3, top, z + e - 0.3, 4);
    const ph = 0.6;
    w.box(x - e, top - 0.05, z - e, x + e, top + ph, z - e + 0.3, 63);
    w.box(x - e, top - 0.05, z + e - 0.3, x + e, top + ph, z + e, 63);
    w.box(x - e, top - 0.05, z - e + 0.3, x - e + 0.3, top + ph, z + e - 0.3, 63);
    w.box(x + e - 0.3, top - 0.05, z - e + 0.3, x + e, top + ph, z + e - 0.3, 63);
    for (const v of [-1, 1]) {
      for (const u of [-1, 0, 1]) {
        const m = u * (e - 0.35);
        w.box(x + m - 0.3, top + ph, z + v * (e - 0.15) - 0.15, x + m + 0.3, top + ph + 0.5, z + v * (e - 0.15) + 0.15, 1 | 2 | 4 | 16 | 32);
      }
      w.box(x + v * (e - 0.15) - 0.15, top + ph, z - 0.3, x + v * (e - 0.15) + 0.15, top + ph + 0.5, z + 0.3, 1 | 2 | 4 | 16 | 32);
    }
    solids.push({ x, z, hw: s0, hd: s0, y0: gb - 1, y1: top - 0.7 });
    solids.push({ x, z, hw: e, hd: e, y0: top - 0.7, y1: top });
    solids.push({ x, z: z - e + 0.15, hw: e, hd: 0.15, y0: top, y1: top + ph });
    solids.push({ x, z: z + e - 0.15, hw: e, hd: 0.15, y0: top, y1: top + ph });
    solids.push({ x: x - e + 0.15, z, hw: 0.15, hd: e, y0: top, y1: top + ph });
    solids.push({ x: x + e - 0.15, z, hw: 0.15, hd: e, y0: top, y1: top + ph });
    // the door faces the town; slit windows lit at night above it and on the sides
    const sAt = (y: number): number => s0 + ((s1 - s0) * (y - gb)) / (top - 0.7 - gb) + 0.03;
    const ax = Math.abs(x) > Math.abs(z) ? 0 : 1;
    const sg = ax === 0 ? -Math.sign(x) : -Math.sign(z);
    const face = (ax0: number, sg0: number, u: number, y0: number, wd: number, ht: number) => {
      const a = sAt(y0) * sg0, b = sAt(y0 + ht) * sg0;
      if (ax0 === 0)
        w.quadAuto(x + a, y0, z + u - wd / 2, x + a, y0, z + u + wd / 2, x + b, y0 + ht, z + u + wd / 2, x + b, y0 + ht, z + u - wd / 2, sg0, 0, 0);
      else w.quadAuto(x + u - wd / 2, y0, z + a, x + u + wd / 2, y0, z + a, x + u + wd / 2, y0 + ht, z + b, x + u - wd / 2, y0 + ht, z + b, 0, 0, sg0);
    };
    w.mat = MAT.opening;
    w.seed = 0;
    const gd = Math.max(gb + 0.6, (ax === 0 ? ctx.groundAt(x + sg * s0, z) : ctx.groundAt(x, z + sg * s0)) - 0.1);
    face(ax, sg, 0, gd, 1.1, 2.1);
    for (const [a0, s] of [[ax, sg], [1 - ax, 1], [1 - ax, -1]]) {
      w.seed = 1 + Math.floor(rng() * 254);
      face(a0, s, 0, gt + H * 0.55, 0.28, 0.95);
    }
    w.seed = 0;
    // the beacon: a brazier on a stone drum in the middle of the platform
    w.mat = MAT.stone;
    taper(w, x, z, 0.38, 0.3, top, top + 0.75, 6, 0);
    taper(w, x, z, 0.32, 0.62, top + 0.75, top + 1.05, 6, 0);
    w.mat = MAT.wood;
    w.tint = 30;
    polyCap(w, x, z, 0.58, top + 1.0, 6, 0);
    solids.push({ x, z, hw: 0.4, hd: 0.4, y0: top, y1: top + 1.05 });
    nearGlow.add(x, top + 1.45, z, 2.0, GLOW.lamp, rng(), 2.2);
    farGlow.add(x, top + 1.6, z, 3.0, GLOW.lamp, rng(), 2.6);
    // skyline
    farW.mat = MAT.stone;
    farW.tint = w.tint;
    taper(farW, x, z, s0 * Math.SQRT2, e * Math.SQRT2, gb, top + ph, 4, Math.PI / 4);
    farW.box(x - e, top + ph - 0.01, z - e, x + e, top + ph, z + e, 4);
    farBase = Math.min(farBase, gb);
    w.extra = 0;
  }

  // ---------------------------------------------------------------- rock-cut tombs (canyon)

  if (T.tombs > 0) {
    const rng = ctx.rng(0x70b5);
    const want = T.tombs;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const placed: number[] = [];
    for (let it = 0; it < want * 120 && counts.tombs < want; it++) {
      // near the ways in, where the cliffs stand either side of the gap
      let x: number, z: number;
      if (ways.length > 0 && rng() < 0.75) {
        const wy = ways[Math.floor(rng() * ways.length)];
        const a = Math.atan2(wy.uz, wy.ux);
        const d = edgeAt(a) + 15 + rng() * 220;
        const lat = (rng() < 0.5 ? -1 : 1) * (wy.hw + 8 + rng() * 45);
        x = wy.ux * d - wy.uz * lat;
        z = wy.uz * d + wy.ux * lat;
      } else {
        ringPoint(rng, 15, 260, 1.2, pt);
        x = pt[0];
        z = pt[1];
      }
      const g = ctx.groundAt(x, z);
      const d = dirs[Math.floor(rng() * 4)];
      const g1 = ctx.groundAt(x + d[0] * 6, z + d[1] * 6);
      if (g1 - g < 4) continue;
      const g2 = ctx.groundAt(x + d[0] * 12, z + d[1] * 12);
      if (g2 - g < 9) continue;
      const W = 4 + rng() * 3;
      const px = -d[1], pz = d[0];
      const gl = ctx.groundAt(x + px * W * 0.5, z + pz * W * 0.5), gr2 = ctx.groundAt(x - px * W * 0.5, z - pz * W * 0.5);
      if (Math.abs(gl - g) > 1.2 || Math.abs(gr2 - g) > 1.2) continue;
      // find the foot of the cliff along d
      let f = 0;
      for (let u = 0.5; u <= 6; u += 0.5) {
        if (ctx.groundAt(x + d[0] * u, z + d[1] * u) > g + 1.2) break;
        f = u;
      }
      const fx = x + d[0] * (f + 0.3), fz = z + d[1] * (f + 0.3);
      const Hf = clamp(Math.min(g2 - g - 1, 5 + rng() * 4), 4.5, 9);
      // the slab from 0.6 in front of the face to 3.5 into the rock
      const ax0 = fx + d[0] * -0.6 + px * -W / 2, ax1 = fx + d[0] * 3.5 + px * W / 2;
      const az0 = fz + d[1] * -0.6 + pz * -W / 2, az1 = fz + d[1] * 3.5 + pz * W / 2;
      const x0 = Math.min(ax0, ax1), x1 = Math.max(ax0, ax1), z0 = Math.min(az0, az1), z1 = Math.max(az0, az1);
      if (!outside(x0, z0, x1, z1, EDGE_PAD) || wayGap(x0, z0, x1, z1) < 2 || hitRect(x0, z0, x1, z1, 2)) continue;
      if (!ctx.free(fx - d[0] * 1.5, fz - d[1] * 1.5, 2)) continue;
      if (placed.some((_, k) => k % 2 === 0 && Math.hypot(placed[k] - fx, placed[k + 1] - fz) < 10)) continue;
      placed.push(fx, fz);
      // in front of the face: the ground the visitor stands on
      take('tomb', x0, z0, x1, z1, { lo: Math.min(g, gl, gr2), hi: Math.max(g, gl, gr2), step: 0 });
      tomb(fx, fz, d[0], d[1], W, Math.min(g, gl, gr2), Hf, rng);
      counts.tombs++;
    }
  }

  function tomb(fx: number, fz: number, dx: number, dz: number, W: number, g: number, Hf: number, rng: () => number): void {
    const w = cellAt(fx, fz, g);
    const px = -dz, pz = dx;
    w.mat = MAT.stone;
    w.tint = 60 + Math.floor(rng() * 50);
    w.extra = 0;
    const B = (a0: number, a1: number, d0: number, d1: number, y0: number, y1: number, mask = 63) => {
      const xa = fx + px * a0 + dx * d0, xb = fx + px * a1 + dx * d1;
      const za = fz + pz * a0 + dz * d0, zb = fz + pz * a1 + dz * d1;
      w.box(Math.min(xa, xb), y0, Math.min(za, zb), Math.max(xa, xb), y1, Math.max(za, zb), mask);
    };
    const hw = W / 2;
    const yb = g - 0.5;
    const ent = g + Hf - 1.6;
    // the dressed face, pilasters either side, an entablature and a crown of crow-steps
    B(-hw, hw, -0.4, 3.5, yb, ent, 1 | 2 | 4 | 16 | 32);
    for (const s of [-1, 1]) B(s * (hw - 0.45) - 0.28, s * (hw - 0.45) + 0.28, -0.7, -0.4, yb, ent);
    B(-hw - 0.15, hw + 0.15, -0.8, 3.5, ent, ent + 0.55);
    B(-hw + 0.1, hw - 0.1, -0.5, 3.5, ent + 0.55, ent + 0.75);
    const steps = Math.max(2, Math.round(W / 1.6));
    for (let k = 0; k < steps; k++) {
      const a = -hw + 0.4 + ((W - 0.8) * (k + 0.5)) / steps;
      B(a - 0.4, a + 0.4, -0.45, 0.2, ent + 0.75, ent + 1.05);
      B(a - 0.2, a + 0.2, -0.45, 0.2, ent + 1.05, ent + 1.35);
    }
    // a step up to the doorway, its frame and the dark opening
    B(-1.1, 1.1, -1.0, -0.4, yb, g + 0.25);
    w.tint = Math.max(0, w.tint - 25);
    B(-0.95, -0.75, -0.55, -0.4, g + 0.25, g + 3.0);
    B(0.75, 0.95, -0.55, -0.4, g + 0.25, g + 3.0);
    B(-0.95, 0.95, -0.55, -0.4, g + 3.0, g + 3.25);
    w.mat = MAT.opening;
    const ox = fx - dx * 0.42, oz = fz - dz * 0.42;
    w.quadAuto(ox - px * 0.75, g + 0.25, oz - pz * 0.75, ox + px * 0.75, g + 0.25, oz + pz * 0.75, ox + px * 0.75, g + 3.0, oz + pz * 0.75, ox - px * 0.75, g + 3.0, oz - pz * 0.75, -dx, 0, -dz);
    w.mat = MAT.stone;
    const a0x = fx + px * -hw + dx * -0.8, a1x = fx + px * hw + dx * 3.5, a0z = fz + pz * -hw + dz * -0.8, a1z = fz + pz * hw + dz * 3.5;
    solids.push({ x: (a0x + a1x) / 2, z: (a0z + a1z) / 2, hw: Math.abs(a1x - a0x) / 2, hd: Math.abs(a1z - a0z) / 2, y0: yb, y1: ent + 0.75 });
  }

  // ---------------------------------------------------------------- windmills

  {
    const rng = ctx.rng(0x3111);
    const want = T.mills;
    let last: number[] | null = null;
    for (let it = 0; it < want * 80 && counts.mills < want; it++) {
      let x: number, z: number;
      if (last && rng() < 0.7) {
        // a row of mills along the same rise
        const a = Math.atan2(last[1], last[0]) + (rng() < 0.5 ? -1 : 1) * (28 + rng() * 14) / Math.hypot(last[0], last[1]);
        const d = Math.hypot(last[0], last[1]) + (rng() - 0.5) * 12;
        x = Math.cos(a) * d;
        z = Math.sin(a) * d;
      } else {
        ringPoint(rng, 30, 200, 1.3, pt);
        x = pt[0];
        z = pt[1];
      }
      const e = 3.4;
      if (!open(x - e, z - e, x + e, z + e, 6, 5)) continue;
      G.span(x - e, z - e, x + e, z + e, sp);
      if (sp.hi - sp.lo > 1.2 || sp.step > 0.7) continue;
      take('mill', x - e, z - e, x + e, z + e, sp);
      windmill(x, z, sp.lo - 0.6, sp.hi, rng);
      last = [x, z];
      counts.mills++;
    }
  }

  function windmill(x: number, z: number, gb: number, gt: number, rng: () => number): void {
    const w = new Writer(512, 1024);
    bigs.push({ w, base: gb });
    const r0 = 3.0, r1 = 2.55;
    const top = gt + 7 + rng() * 1.5;
    w.mat = site.kind === 'oasis' || site.kind === 'trade' ? MAT.plaster : MAT.stone;
    w.tint = 120 + Math.floor(rng() * 60);
    w.extra = 0;
    // face away from the town, along the nearer axis, so the cap and its solid are exact boxes
    const ax = Math.abs(x) > Math.abs(z) ? 0 : 1;
    const fx = ax === 0 ? Math.sign(x) : 0, fz = ax === 1 ? Math.sign(z) : 0;
    const px = -fz, pz = fx;
    // a facet toward the town for the door
    const rot = Math.atan2(-fz, -fx) - Math.PI / 10;
    taper(w, x, z, r0, r1, gb, top - 0.45, 10, rot);
    w.mat = MAT.stone;
    taper(w, x, z, r1 + 0.18, r1 + 0.18, top - 0.45, top, 10, rot);
    polyCap(w, x, z, r1 + 0.18, top, 10, rot);
    // the door and a lit window on the town side
    w.mat = MAT.opening;
    const ap = Math.cos(Math.PI / 10);
    const sAt = (y: number): number => (r0 + ((r1 - r0) * (y - gb)) / (top - 0.45 - gb)) * ap + 0.03;
    const dg = Math.max(gb + 0.6, ctx.groundAt(x - fx * r0, z - fz * r0) - 0.1);
    for (const [y0, ht, wd, seed] of [[dg, 2.0, 1.0, 0], [gt + 4.2, 0.8, 0.45, 1 + Math.floor(rng() * 254)]]) {
      w.seed = seed;
      const a = sAt(y0), b = sAt(y0 + ht);
      w.quadAuto(
        x - fx * a - px * wd / 2, y0, z - fz * a - pz * wd / 2, x - fx * a + px * wd / 2, y0, z - fz * a + pz * wd / 2,
        x - fx * b + px * wd / 2, y0 + ht, z - fz * b + pz * wd / 2, x - fx * b - px * wd / 2, y0 + ht, z - fz * b - pz * wd / 2,
        -fx, 0, -fz,
      );
    }
    w.seed = 0;
    // the timber cap that turns the sails, with a pitched roof along the axle
    const cl = 1.7, cw = 1.25, ch = 1.9;
    const cx0 = x - Math.abs(fx) * cl - Math.abs(px) * cw, cx1 = x + Math.abs(fx) * cl + Math.abs(px) * cw;
    const cz0 = z - Math.abs(fz) * cl - Math.abs(pz) * cw, cz1 = z + Math.abs(fz) * cl + Math.abs(pz) * cw;
    w.mat = MAT.wood;
    w.tint = 70 + Math.floor(rng() * 60);
    w.box(cx0, top, cz0, cx1, top + ch, cz1, 1 | 2 | 16 | 32);
    w.mat = MAT.roof;
    w.tint = 150;
    const ry = top + ch + 0.9;
    for (const s of [-1, 1]) {
      const ex = x + px * (cw + 0.15) * s, ez = z + pz * (cw + 0.15) * s;
      w.quadAuto(
        ex - fx * (cl + 0.15), top + ch - 0.1, ez - fz * (cl + 0.15), ex + fx * (cl + 0.15), top + ch - 0.1, ez + fz * (cl + 0.15),
        x + fx * (cl + 0.15), ry, z + fz * (cl + 0.15), x - fx * (cl + 0.15), ry, z - fz * (cl + 0.15),
        px * s, 1, pz * s,
      );
    }
    w.mat = MAT.wood;
    for (const s of [-1, 1])
      w.triAuto(
        x + fx * cl * s - px * cw, top + ch, z + fz * cl * s - pz * cw, x + fx * cl * s + px * cw, top + ch, z + fz * cl * s + pz * cw,
        x + fx * cl * s, ry - 0.05, z + fz * cl * s, fx * s, 0, fz * s,
      );
    // the axle reaches past the tower's shoulder so the sails clear it
    const hy = top + 1.25;
    const hx = x + fx * (r0 + 0.7), hz = z + fz * (r0 + 0.7);
    bar(w, x + fx * cl, hy, z + fz * cl, hx, hy, hz, 0.3, true);
    solids.push({ x, z, hw: 2.65, hd: 2.65, y0: gb - 1, y1: top - 0.45 });
    solids.push({ x, z, hw: r1 + 0.1, hd: r1 + 0.1, y0: top - 0.45, y1: top });
    solids.push({ x: (cx0 + cx1) / 2, z: (cz0 + cz1) / 2, hw: (cx1 - cx0) / 2, hd: (cz1 - cz0) / 2, y0: top, y1: top + ch });
    emitters.push({ x, z, kind: 'mill', gain: 0.7, reach: 45 });
    mills.push({ x: hx, y: hy, z: hz, yaw: Math.atan2(fx, fz), phase: rng() * TAU, dir: rng() < 0.5 ? 1 : -1 });
    // skyline: tower, cap and the sails as a still cross
    farW.mat = MAT.plaster;
    farW.tint = 150;
    taper(farW, x, z, r0, r1 + 0.18, gb, top, 6, 0);
    farW.mat = MAT.wood;
    farW.box(cx0, top, cz0, cx1, top + ch + 0.6, cz1, 1 | 2 | 4 | 16 | 32);
    farW.mat = MAT.cloth;
    farW.tint = 230;
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k / 4) * TAU;
      const L = 5.6;
      bar(farW, hx, hy, hz, hx + px * Math.cos(a) * L, hy + Math.sin(a) * L, hz + pz * Math.cos(a) * L, 0.5);
    }
    farBase = Math.min(farBase, gb);
  }

  // ---------------------------------------------------------------- camps for travellers

  /** A spot beside a way out (lateral off from the corridor), t0..t1 beyond the edge. */
  const besideWay = (rng: () => number, wy: Way, ta: number, tb: number, lat0: number, lat1: number, out: number[]): number[] => {
    const a = Math.atan2(wy.uz, wy.ux);
    const d = edgeAt(a) + ta + rng() * (tb - ta);
    const lat = (rng() < 0.5 ? -1 : 1) * (wy.hw + lat0 + rng() * (lat1 - lat0));
    out[0] = wy.ux * d - wy.uz * lat;
    out[1] = wy.uz * d + wy.ux * lat;
    return out;
  };
  const tracks = ways.filter((wy) => wy.track);
  const campSpots: number[] = [];
  {
    const rng = ctx.rng(0xca39);
    const want = T.camps;
    for (let it = 0; it < want * 80 && counts.camps < want; it++) {
      const pool = tracks.length > 0 && rng() < 0.7 ? tracks : ways;
      if (pool.length > 0) besideWay(rng, pool[Math.floor(rng() * pool.length)], 30, 170, 12, 30, pt);
      else ringPoint(rng, 30, 170, 1, pt);
      const x = pt[0], z = pt[1];
      const e = 10.5;
      if (!open(x - e, z - e, x + e, z + e, 6, 3)) continue;
      G.span(x - e, z - e, x + e, z + e, sp);
      if (sp.hi - sp.lo > 1.8 || sp.step > 0.65) continue;
      take('camp', x - e, z - e, x + e, z + e, sp);
      camp(x, z, rng);
      campSpots.push(x, z);
      counts.camps++;
    }
  }

  function camp(x: number, z: number, rng: () => number): void {
    const F = new Frame();
    const gf = G.at(x, z);
    const w = cellAt(x, z, gf - 0.2);
    // the fire: a ring of stones, a bed of ash, crossed logs
    w.mat = MAT.soil;
    w.tint = 40;
    w.extra = 0;
    polyCap(w, x, z, 0.75, gf + 0.03, 7, rng());
    w.mat = MAT.stone;
    w.tint = 90;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + rng() * 0.3;
      const sx = x + Math.cos(a) * 0.85, sz = z + Math.sin(a) * 0.85;
      const c = Math.cos(a), s = Math.sin(a);
      ubox(w, sx, gf + 0.08, sz, c * 0.14, 0, s * 0.14, 0, 0.14, 0, -s * 0.2, 0, c * 0.2, 1 | 2 | 4 | 16 | 32);
    }
    w.mat = MAT.wood;
    w.tint = 30;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU + rng();
      bar(w, x + Math.cos(a) * 0.6, gf + 0.05, z + Math.sin(a) * 0.6, x - Math.cos(a) * 0.15, gf + 0.32, z - Math.sin(a) * 0.15, 0.13, true);
    }
    nearGlow.add(x, gf + 0.55, z, 1.1, GLOW.lamp, rng(), 1.6);
    farGlow.add(x, gf + 0.8, z, 1.4, GLOW.lamp, rng(), 1.1);
    emitters.push({ x, z, kind: 'fire', gain: 0.7, reach: 25 });
    // tents round the fire, doors toward it
    const n = 3 + Math.floor(rng() * 3);
    const a0 = rng() * TAU;
    let lanterns = 0;
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * TAU + (rng() - 0.5) * 0.5;
      const d = 6 + rng() * 2;
      const tx = x + Math.cos(a) * d, tz = z + Math.sin(a) * d;
      const yaw = Math.atan2(x - tx, z - tz);
      const g = G.at(tx, tz);
      const tw = cellAt(tx, tz, g - 0.3);
      if (rng() < 0.55) ridgeTent(tw, F.set(tx, g, tz, yaw), 3.4 + rng() * 1.4, 2.6 + rng() * 0.8, 1.9 + rng() * 0.5, rng);
      else bellTent(tw, tx, tz, g, yaw, 1.9 + rng() * 0.6, 2.4 + rng() * 0.6, rng);
      counts.tents++;
      // a lantern on a pole by some of the doors
      if (lanterns < 2 && rng() < 0.6) {
        const lx = tx + Math.sin(yaw) * 2.4 + Math.cos(yaw) * 1.2, lz = tz + Math.cos(yaw) * 2.4 - Math.sin(yaw) * 1.2;
        lanternPost(tw, lx, lz, G.at(lx, lz), rng);
        lanterns++;
      }
    }
    // bales and sacks between the tents
    w.mat = MAT.cloth;
    for (let k = 0; k < 3 + Math.floor(rng() * 4); k++) {
      const a = rng() * TAU, d = 3 + rng() * 2;
      const bx = x + Math.cos(a) * d, bz = z + Math.sin(a) * d;
      const g = G.at(bx, bz);
      const c = Math.cos(a), s = Math.sin(a);
      w.tint = Math.floor(rng() * 255);
      w.extra = rng() < 0.4 ? 5 : 0;
      const hs = 0.25 + rng() * 0.15;
      ubox(w, bx, g + hs - 0.05, bz, c * 0.45, 0, s * 0.45, 0, hs, 0, -s * 0.3, 0, c * 0.3);
    }
    w.extra = 0;
  }

  function ridgeTent(w: Writer, F: Frame, L: number, W: number, H: number, rng: () => number): void {
    const hl = L / 2, hw = W / 2;
    w.mat = MAT.cloth;
    w.tint = Math.floor(rng() * 255);
    w.extra = rng() < 0.5 ? 4 + Math.floor(rng() * 6) : 0;
    const P = (lx: number, ly: number, lz: number): number[] => [lx, ly, lz];
    // the two slopes run front (+z) to back
    for (const s of [-1, 1]) {
      const a = P(s * hw, -0.05, -hl), b = P(s * hw, -0.05, hl), c = P(0, H, hl + 0.15), d = P(0, H, -hl - 0.15);
      w.quadAuto(
        F.X(a[0], a[2]), F.y + a[1], F.Z(a[0], a[2]), F.X(b[0], b[2]), F.y + b[1], F.Z(b[0], b[2]),
        F.X(c[0], c[2]), F.y + c[1], F.Z(c[0], c[2]), F.X(d[0], d[2]), F.y + d[1], F.Z(d[0], d[2]),
        F.c * s, 0.6, -F.s * s,
      );
    }
    w.extra = 0;
    ftri(w, F, [-hw, -0.05, -hl], [hw, -0.05, -hl], [0, H, -hl - 0.15], 0, 0, -1);
    // the door flaps tied back, and the dark inside
    ftri(w, F, [-hw, -0.05, hl], [0, H, hl + 0.15], [-hw * 0.35, -0.05, hl + 0.35], -0.3, 0, 1);
    ftri(w, F, [hw, -0.05, hl], [0, H, hl + 0.15], [hw * 0.35, -0.05, hl + 0.35], 0.3, 0, 1);
    w.mat = MAT.opening;
    ftri(w, F, [-hw * 0.95, -0.04, hl - 0.25], [hw * 0.95, -0.04, hl - 0.25], [0, H * 0.95, hl - 0.25], 0, 0, 1);
    w.mat = MAT.wood;
    w.tint = 80;
    fbar(w, F, 0, -0.1, hl + 0.15, 0, H + 0.3, hl + 0.15, 0.08);
    fbar(w, F, 0, -0.1, -hl - 0.15, 0, H + 0.3, -hl - 0.15, 0.08);
  }

  function bellTent(w: Writer, x: number, z: number, g: number, yaw: number, r: number, H: number, rng: () => number): void {
    w.mat = MAT.cloth;
    w.tint = Math.floor(rng() * 255);
    w.extra = rng() < 0.5 ? 3 : 0;
    // a facet faces the fire, so the doorway lies flat on it
    const c = Math.sin(yaw), s = Math.cos(yaw);
    const rot = Math.atan2(s, c) - TAU / 16;
    const ap = Math.cos(TAU / 16);
    taper(w, x, z, r, r * 0.92, g - 0.1, g + 0.9, 8, rot);
    w.extra = 0;
    taper(w, x, z, r * 0.92, 0.12, g + 0.9, g + H, 8, rot);
    w.mat = MAT.wood;
    w.tint = 80;
    bar(w, x, g + H - 0.1, z, x, g + H + 0.45, z, 0.08, true);
    // the doorway: a dark slit on the side toward the fire, down the skirt and up the cone
    w.mat = MAT.opening;
    const r0 = r * ap + 0.03, r1 = r * 0.92 * ap + 0.03;
    const r2 = (r * 0.92 + ((0.12 - r * 0.92) * 0.8) / (H - 0.9)) * ap + 0.03;
    w.quadAuto(
      x + c * r0 - s * 0.55, g - 0.05, z + s * r0 + c * 0.55, x + c * r0 + s * 0.55, g - 0.05, z + s * r0 - c * 0.55,
      x + c * r1 + s * 0.4, g + 0.9, z + s * r1 - c * 0.4, x + c * r1 - s * 0.4, g + 0.9, z + s * r1 + c * 0.4,
      c, 0, s,
    );
    w.triAuto(x + c * r1 - s * 0.4, g + 0.9, z + s * r1 + c * 0.4, x + c * r1 + s * 0.4, g + 0.9, z + s * r1 - c * 0.4, x + c * r2, g + 1.7, z + s * r2, c, 0, s);
  }

  function lanternPost(w: Writer, x: number, z: number, g: number, rng: () => number): void {
    w.mat = MAT.wood;
    w.tint = 70;
    w.extra = 0;
    bar(w, x, g - 0.3, z, x, g + 2.1, z, 0.1, true);
    bar(w, x, g + 2.0, z, x + 0.45, g + 2.0, z, 0.06, true);
    w.mat = MAT.lantern;
    w.tint = 128;
    w.box(x + 0.32, g + 1.6, z - 0.1, x + 0.52, g + 1.9, z + 0.1, 63);
    nearGlow.add(x + 0.42, g + 1.75, z, 0.4, GLOW.lantern, rng(), 1.0);
  }

  // ---------------------------------------------------------------- animal pens

  {
    const rng = ctx.rng(0x9e45);
    const want = T.pens;
    for (let it = 0; it < want * 80 && counts.pens < want; it++) {
      // trade towns keep their pens by the camps; elsewhere they stand near the edge
      if (campSpots.length > 0 && rng() < 0.7) {
        const k = Math.floor(rng() * (campSpots.length / 2)) * 2;
        const a = rng() * TAU;
        pt[0] = campSpots[k] + Math.cos(a) * 22;
        pt[1] = campSpots[k + 1] + Math.sin(a) * 22;
      } else ringPoint(rng, 20, 160, 1.3, pt);
      const hw = 6 + Math.floor(rng() * 3), hd = 4.5 + Math.floor(rng() * 2.5);
      const x = pt[0], z = pt[1];
      if (!open(x - hw, z - hd, x + hw, z + hd, 3, 3)) continue;
      G.span(x - hw, z - hd, x + hw, z + hd, sp);
      if (sp.hi - sp.lo > 1.3 || sp.step > 0.55) continue;
      take('pen', x - hw, z - hd, x + hw, z + hd, sp);
      pen(x, z, hw, hd, rng);
      counts.pens++;
    }
  }

  function pen(x: number, z: number, hw: number, hd: number, rng: () => number): void {
    const w = cellAt(x, z, G.span(x - hw, z - hd, x + hw, z + hd, sp).lo);
    w.mat = MAT.wood;
    w.extra = 0;
    // posts every 2 m round the edge with two rails between, a gap for the gate
    const gateSide = Math.floor(rng() * 4);
    const sides: number[][] = [[-hw, -hd, hw, -hd], [hw, -hd, hw, hd], [hw, hd, -hw, hd], [-hw, hd, -hw, -hd]];
    sides.forEach(([ax, az, bx, bz], si) => {
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.round(L / 2);
      const gate = si === gateSide ? Math.floor(n / 2) : -1;
      let px = x + ax, pz = z + az, pg = G.at(px, pz);
      for (let k = 1; k <= n; k++) {
        const qx = x + ax + ((bx - ax) * k) / n, qz = z + az + ((bz - az) * k) / n;
        const qg = G.at(qx, qz);
        w.tint = 60 + Math.floor(rng() * 50);
        bar(w, px, pg - 0.3, pz, px, pg + 1.25, pz, 0.12, true);
        if (k - 1 !== gate) {
          bar(w, px, pg + 0.55, pz, qx, qg + 0.55, qz, 0.07);
          bar(w, px, pg + 1.1, pz, qx, qg + 1.1, qz, 0.07);
        }
        px = qx;
        pz = qz;
        pg = qg;
      }
    });
    // a trough and a heap of fodder
    const tx = x + (rng() - 0.5) * (hw - 2), tz = z + hd - 0.9;
    const tg = G.at(tx, tz);
    w.tint = 90;
    w.box(tx - 1.1, tg - 0.2, tz - 0.3, tx + 1.1, tg + 0.5, tz + 0.3, 1 | 2 | 16 | 32);
    w.mat = MAT.opening;
    w.box(tx - 1.0, tg + 0.35, tz - 0.22, tx + 1.0, tg + 0.45, tz + 0.22, 4);
    w.mat = MAT.cloth;
    w.tint = 12;
    const hx = x - hw + 1.6, hz = z - hd + 1.6;
    taper(w, hx, hz, 1.1, 0.25, G.at(hx, hz) - 0.1, G.at(hx, hz) + 0.9, 7, rng());
    // the animals, mostly resting
    const F = new Frame();
    const na = Math.max(2, Math.round((2 + rng() * 4) * Math.max(0.6, dens)));
    const herd = Math.floor(rng() * 3);
    const spots: number[] = [];
    for (let k = 0, tries = 0; k < na && tries < 40; tries++) {
      const ax = x + (rng() - 0.5) * (hw * 2 - 3.5), az = z + (rng() - 0.5) * (hd * 2 - 3.5);
      if (spots.some((_, i) => i % 2 === 0 && Math.hypot(spots[i] - ax, spots[i + 1] - az) < 3)) continue;
      if (Math.hypot(ax - hx, az - hz) < 2.4 || Math.hypot(ax - tx, az - tz) < 2) continue;
      spots.push(ax, az);
      const coat = rng() < 0.7 ? herd : Math.floor(rng() * 3);
      animal(w, F.set(ax, G.at(ax, az) - 0.05, az, rng() * TAU), rng() < 0.7, coat, rng);
      counts.animals++;
      k++;
    }
  }

  // ---------------------------------------------------------------- burial ground

  {
    const rng = ctx.rng(0xb0e1);
    const want = site.kind === 'canyon' ? 2 : 1;
    const [ta, tb] = site.kind === 'canyon' ? [40, 320] : [140, 420];
    for (let it = 0; it < 300 && counts.burials < want; it++) {
      ringPoint(rng, ta, tb, 1, pt);
      const hw = 12 + Math.floor(rng() * 6), hd = 9 + Math.floor(rng() * 5);
      const x = pt[0], z = pt[1];
      if (!open(x - hw, z - hd, x + hw, z + hd, 40, 12)) continue;
      G.span(x - hw, z - hd, x + hw, z + hd, sp);
      if (sp.hi - sp.lo > 3 || sp.step > 0.8) continue;
      take('burial', x - hw, z - hd, x + hw, z + hd, sp);
      burial(x, z, hw, hd, rng);
      counts.burials++;
    }
  }

  function burial(x: number, z: number, hw: number, hd: number, rng: () => number): void {
    const lo = G.span(x - hw, z - hd, x + hw, z + hd, sp).lo;
    const w = cellAt(x, z, lo);
    w.extra = 0;
    // a small domed tomb of a holy one in the middle, door toward the town
    const tg = G.span(x - 2.5, z - 2.5, x + 2.5, z + 2.5, { lo: 0, hi: 0, step: 0 });
    const sh = 3.2;
    w.mat = T.mud ? MAT.plaster : MAT.stone;
    w.tint = 150 + Math.floor(rng() * 60);
    w.box(x - 2.2, tg.lo - 0.5, z - 2.2, x + 2.2, tg.hi + sh, z + 2.2, 1 | 2 | 16 | 32);
    w.box(x - 2.35, tg.hi + sh, z - 2.35, x + 2.35, tg.hi + sh + 0.25, z + 2.35, 63);
    w.mat = MAT.dome;
    dome(w, x, z, 1.8, tg.hi + sh + 0.25, 1.9, 12, 4, 0.2);
    w.mat = MAT.opening;
    const ax = Math.abs(x) > Math.abs(z) ? 0 : 1;
    const s = ax === 0 ? -Math.sign(x) : -Math.sign(z);
    const dg = G.at(ax === 0 ? x + s * 2.2 : x, ax === 0 ? z : z + s * 2.2);
    if (ax === 0) w.quadAuto(x + s * 2.22, dg, z - 0.6, x + s * 2.22, dg, z + 0.6, x + s * 2.22, dg + 2.0, z + 0.6, x + s * 2.22, dg + 2.0, z - 0.6, s, 0, 0);
    else w.quadAuto(x - 0.6, dg, z + s * 2.22, x + 0.6, dg, z + s * 2.22, x + 0.6, dg + 2.0, z + s * 2.22, x - 0.6, dg + 2.0, z + s * 2.22, 0, 0, s);
    solids.push({ x, z, hw: 2.35, hd: 2.35, y0: tg.lo - 1, y1: tg.hi + sh + 0.25 });
    // stelae in loose rows, all facing one way; cairns and a few tall rough stones among them
    const n = Math.max(10, Math.round(T.stelae * dens));
    const face = rng() * TAU;
    let placed = 0;
    for (let tries = 0; placed < n && tries < n * 4; tries++) {
      const sx = x + (rng() - 0.5) * (hw * 2 - 2), sz = z + (rng() - 0.5) * (hd * 2 - 2);
      if (Math.abs(sx - x) < 3.6 && Math.abs(sz - z) < 3.6) continue;
      const g = G.at(sx, sz);
      const kind = rng();
      w.mat = MAT.stone;
      w.tint = 60 + Math.floor(rng() * 120);
      if (kind < 0.7) {
        // a slab stele, leaning a little with the years
        const hgt = 0.7 + rng() * 1.1 + (rng() < 0.1 ? 0.8 : 0);
        const hwid = 0.22 + rng() * 0.18, ht = 0.08 + rng() * 0.05;
        const yaw = face + (rng() - 0.5) * 0.25;
        const c = Math.cos(yaw), sn = Math.sin(yaw);
        const tilt = (rng() - 0.5) * 0.3, roll = (rng() - 0.5) * 0.15;
        // across a, thickness t, up v; tilt v toward t, roll v toward a
        const ux = c, uz = -sn, tx = sn, tz = c;
        const vx = tx * Math.sin(tilt) + ux * Math.sin(roll), vy = Math.cos(tilt) * Math.cos(roll), vz = tz * Math.sin(tilt) + uz * Math.sin(roll);
        const hh = hgt / 2 + 0.15;
        const cx = sx + vx * hh, cy = g - 0.3 + vy * hh, cz = sz + vz * hh;
        ubox(w, cx, cy, cz, ux * hwid, 0, uz * hwid, vx * hh, vy * hh, vz * hh, tx * ht, 0, tz * ht, 1 | 2 | 4 | 16 | 32);
        if (rng() < 0.5) {
          // rounded shoulders: a narrower block on top
          const tyy = cy + vy * hh;
          ubox(w, cx + vx * hh + vx * 0.08, tyy + 0.08 * vy, cz + vz * hh + vz * 0.08, ux * hwid * 0.6, 0, uz * hwid * 0.6, vx * 0.08, vy * 0.08, vz * 0.08, tx * ht, 0, tz * ht, 1 | 2 | 4 | 16 | 32);
        }
      } else if (kind < 0.88) {
        taper(w, sx, sz, 0.5 + rng() * 0.35, 0, g - 0.1, g + 0.5 + rng() * 0.5, 5, rng() * TAU);
      } else {
        const hgt = 2.2 + rng() * 1.6, r = 0.35 + rng() * 0.15, rot = rng() * TAU;
        taper(w, sx, sz, r, r * 0.65, g - 0.4, g + hgt, 5, rot);
        taper(w, sx, sz, r * 0.65, 0.05, g + hgt, g + hgt + r * 0.8, 5, rot);
      }
      placed++;
    }
    counts.stelae += placed;
    // a few thorny shrubs that have found the shade of the stones
    for (let k = 0; k < Math.round(6 * dens); k++) {
      const bx = x + (rng() - 0.5) * hw * 2, bz = z + (rng() - 0.5) * hd * 2;
      if (Math.abs(bx - x) < 3 && Math.abs(bz - z) < 3) continue;
      shrub(w, bx, G.at(bx, bz), bz, 0.35 + rng() * 0.4, true, false, rng);
    }
  }

  // ---------------------------------------------------------------- gardens and orchards

  const plots: number[] = []; // x0, z0, x1, z1
  {
    const rng = ctx.rng(0x6a2d);
    const want = Math.max(1, Math.round(T.plots * (0.25 + 0.75 * dens) * (dens < 0.5 ? 0.6 : 1)));
    const wallMat = T.mud ? MAT.plaster : MAT.stone;
    const wallTint = T.mud ? 150 : 120;
    for (let it = 0; it < want * 60 && counts.plots < want; it++) {
      const hw = 7 + Math.floor(rng() * 10), hd = 6 + Math.floor(rng() * 8);
      let x: number, z: number;
      if (plots.length > 0 && rng() < T.clusterP) {
        // against an earlier plot, sharing the line of one of its sides
        const k = Math.floor(rng() * (plots.length / 4)) * 4;
        const [a0, b0, a1, b1] = [plots[k], plots[k + 1], plots[k + 2], plots[k + 3]];
        const side = Math.floor(rng() * 4);
        const gap = 1.6 + rng() * 3;
        if (side === 0) {
          x = a1 + gap + hw;
          z = b0 + hd + (rng() < 0.5 ? 0 : b1 - b0 - 2 * hd);
        } else if (side === 1) {
          x = a0 - gap - hw;
          z = b0 + hd + (rng() < 0.5 ? 0 : b1 - b0 - 2 * hd);
        } else if (side === 2) {
          z = b1 + gap + hd;
          x = a0 + hw + (rng() < 0.5 ? 0 : a1 - a0 - 2 * hw);
        } else {
          z = b0 - gap - hd;
          x = a0 + hw + (rng() < 0.5 ? 0 : a1 - a0 - 2 * hw);
        }
      } else {
        ringPoint(rng, 16, T.plotFar, 1.4, pt);
        x = Math.round(pt[0]);
        z = Math.round(pt[1]);
      }
      if (beyond(x, z) > T.plotFar + 40) continue;
      const orchard = rng() < T.orchardP;
      if (!open(x - hw, z - hd, x + hw, z + hd, 1.2, 0)) continue;
      G.span(x - hw, z - hd, x + hw, z + hd, sp);
      if (sp.hi - sp.lo > (orchard ? 1.8 : 1.2) || sp.step > 0.5) continue;
      take(orchard ? 'orchard' : 'garden', x - hw, z - hd, x + hw, z + hd, sp);
      plots.push(x - hw, z - hd, x + hw, z + hd);
      plot(x, z, hw, hd, orchard, wallMat, wallTint, rng);
      counts.plots++;
      if (orchard) counts.orchards++;
      else counts.gardens++;
    }

    // low field walls running on from the plot corners, dividing the land
    const fw = Math.round(T.fieldWalls * (0.4 + 0.6 * dens));
    for (let it = 0; it < fw * 8 && counts.fieldWalls < fw && plots.length > 0; it++) {
      const k = Math.floor(rng() * (plots.length / 4)) * 4;
      const cx = rng() < 0.5 ? plots[k] : plots[k + 2], cz = rng() < 0.5 ? plots[k + 1] : plots[k + 3];
      const axis = rng() < 0.5 ? 0 : 1;
      const sgn = axis === 0 ? (cx === plots[k] ? -1 : 1) : cz === plots[k + 1] ? -1 : 1;
      const len = 16 + Math.floor(rng() * 9) * 4;
      let n = 0;
      for (let u = 0.8; u + 4 <= len; u += 4) {
        const a = axis === 0 ? cx + sgn * u : cz + sgn * u, b = axis === 0 ? cx + sgn * (u + 4) : cz + sgn * (u + 4);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const x0 = axis === 0 ? lo : cx - 0.3, x1 = axis === 0 ? hi : cx + 0.3;
        const z0 = axis === 0 ? cz - 0.3 : lo, z1 = axis === 0 ? cz + 0.3 : hi;
        if (!open(x0, z0, x1, z1, 0.3, 1)) break;
        G.span(x0, z0, x1, z1, sp);
        if (sp.step > 0.7) break;
        n++;
      }
      if (n < 2) continue;
      const a = axis === 0 ? cx + sgn * 0.6 : cz + sgn * 0.6, b = axis === 0 ? cx + sgn * (0.8 + n * 4) : cz + sgn * (0.8 + n * 4);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const x0 = axis === 0 ? lo : cx - 0.3, x1 = axis === 0 ? hi : cx + 0.3;
      const z0 = axis === 0 ? cz - 0.3 : lo, z1 = axis === 0 ? cz + 0.3 : hi;
      take('fieldwall', x0, z0, x1, z1, null);
      wallRun(axis, axis === 0 ? cz : cx, lo, hi, 0.55, 0.75 + rng() * 0.15, wallMat, wallTint - 15, rng);
      counts.fieldWalls++;
    }
  }

  function plot(x: number, z: number, hw: number, hd: number, orchard: boolean, wallMat: number, wallTint: number, rng: () => number): void {
    const x0 = x - hw, x1 = x + hw, z0 = z - hd, z1 = z + hd;
    const wh = 0.8 + rng() * 0.3;
    const th = 0.5;
    // walls with a gap for the gate on the side nearest the town
    const gate = Math.abs(x) > Math.abs(z) ? (x > 0 ? 1 : 0) : z > 0 ? 3 : 2; // 0 +x, 1 -x, 2 +z, 3 -z
    const gw = 1.4;
    const run = (axis: number, c: number, a: number, b: number, hasGate: boolean) => {
      if (!hasGate) {
        wallRun(axis, c, a, b, th, wh, wallMat, wallTint, rng);
        return;
      }
      const m = (a + b) / 2 + (rng() - 0.5) * (b - a - 4) * 0.5;
      wallRun(axis, c, a, m - gw, th, wh, wallMat, wallTint, rng);
      wallRun(axis, c, m + gw, b, th, wh, wallMat, wallTint, rng);
    };
    run(0, z0 + th / 2, x0, x1, gate === 3);
    run(0, z1 - th / 2, x0, x1, gate === 2);
    run(1, x0 + th / 2, z0 + th, z1 - th, gate === 1);
    run(1, x1 - th / 2, z0 + th, z1 - th, gate === 0);

    const ix0 = x0 + th + 0.2, ix1 = x1 - th - 0.2, iz0 = z0 + th + 0.2, iz1 = z1 - th - 0.2;
    const w = cellAt(x, z, G.span(x0, z0, x1, z1, sp).lo);
    w.extra = 0;
    if (orchard) {
      // trees on a grid, the ground under them bare
      const palms = rng() < T.palmP;
      const step = palms ? 5.5 + rng() * 1.5 : 4.2 + rng() * 1.0;
      const nx = Math.max(1, Math.floor((ix1 - ix0 - 1.5) / step) + 1), nz = Math.max(1, Math.floor((iz1 - iz0 - 1.5) / step) + 1);
      const ox = (ix0 + ix1) / 2 - ((nx - 1) * step) / 2, oz = (iz0 + iz1) / 2 - ((nz - 1) * step) / 2;
      const blossom = rng() < 0.35;
      let nt = 0;
      for (let j = 0; j < nz; j++)
        for (let i = 0; i < nx; i++) {
          if (rng() < 0.08) continue; // a gap where one has died
          const tx = ox + i * step + (rng() - 0.5) * 0.6, tz = oz + j * step + (rng() - 0.5) * 0.6;
          const g = G.at(tx, tz);
          let top: number;
          if (palms) top = tree(w, tx, g, tz, 5.5 + rng() * 4.5, rng);
          else top = fruitTree(w, tx, g, tz, 0.8 + rng() * 0.4, blossom, rng) + 1.5;
          solids.push({ x: tx, z: tz, hw: 0.22, hd: 0.22, y0: g - 1, y1: g + top });
          nt++;
          // a few tufts of grass at the feet
          if (rng() < 0.5 * dens) tuft(w, tx + 0.8, G.at(tx + 0.8, tz), tz, 0.4, 90, rng);
        }
      counts.trees += nt;
      emitters.push({ x, z, kind: 'leaves', gain: clamp(0.25 + 0.03 * nt, 0.3, 0.7), reach: clamp(25 + Math.max(hw, hd), 30, 45) });
      return;
    }
    // a garden: dark tilled soil, crops in rows along the long side
    w.mat = MAT.soil;
    w.tint = 128;
    for (let a = ix0; a < ix1 - 0.01; a += GS) {
      const b = Math.min(ix1, a + GS);
      for (let c = iz0; c < iz1 - 0.01; c += GS) {
        const d = Math.min(iz1, c + GS);
        w.quad(a, G.at(a, c) + 0.04, c, b, G.at(b, c) + 0.04, c, b, G.at(b, d) + 0.04, d, a, G.at(a, d) + 0.04, d, 0, 1, 0);
      }
    }
    const alongX = ix1 - ix0 >= iz1 - iz0;
    const L0 = alongX ? ix0 : iz0, L1 = alongX ? ix1 : iz1;
    let A0 = alongX ? iz0 : ix0;
    const A1 = alongX ? iz1 : ix1;
    // an irrigation ditch of reeds along one long wall
    if (rng() < T.reedP) {
      const c = A0 + 0.6;
      w.mat = MAT.opening;
      for (let u = L0; u < L1 - 0.01; u += GS) {
        const v = Math.min(L1, u + GS);
        const P = (s: number, t: number): number[] => (alongX ? [s, G.at(s, t) + 0.06, t] : [t, G.at(t, s) + 0.06, s]);
        const p0 = P(u, c - 0.35), p1 = P(v, c - 0.35), p2 = P(v, c + 0.35), p3 = P(u, c + 0.35);
        w.quad(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], 0, 1, 0);
      }
      const step = 1.1 / Math.max(0.4, dens);
      for (let u = L0 + 0.4; u < L1 - 0.4; u += step * (0.7 + rng() * 0.6)) {
        const rx = alongX ? u : c + (rng() - 0.5) * 0.6, rz = alongX ? c + (rng() - 0.5) * 0.6 : u;
        reeds(w, rx, G.at(rx, rz), rz, 4 + Math.floor(rng() * 3), 1.3 + rng() * 0.7, true, rng);
      }
      A0 += 1.4;
    }
    // strips of different crops across the plot
    const strips = 1 + Math.floor(rng() * 3);
    const span = (L1 - L0) / strips;
    const rowGap = 1.2 + rng() * 0.3;
    for (let si = 0; si < strips; si++) {
      const s0 = L0 + si * span + (si > 0 ? 0.4 : 0), s1 = L0 + (si + 1) * span - (si < strips - 1 ? 0.4 : 0);
      const crop = rng();
      const tint = 120 + Math.floor(rng() * 100);
      for (let c = A0 + rowGap / 2; c < A1 - 0.3; c += rowGap) {
        if (crop < 0.3) {
          // standing grain
          const [ax, az, bx, bz] = alongX ? [s0, c, s1, c] : [c, s0, c, s1];
          grainRow(w, G, ax, az, bx, bz, 0.7 + rng() * 0.25, 0.35, rng);
        } else {
          // leafy rows (low greens) or tall millet
          const tall = crop > 0.8;
          const sp0 = (tall ? 0.9 : 0.7) / Math.sqrt(Math.max(0.3, dens));
          for (let u = s0 + sp0 / 2; u < s1; u += sp0 * (0.85 + rng() * 0.3)) {
            const tx = alongX ? u : c, tz = alongX ? c : u;
            tuft(w, tx, G.at(tx, tz), tz, tall ? 1.1 : 0.42 + rng() * 0.12, tall ? tint - 40 : tint, rng);
            counts.tufts++;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- meshes

  const near = new THREE.Group();
  near.name = 'city-outskirts';
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const softMat = createMasonryMaterial(ctx.uniforms, { shadow: true, twoSided: true, sway: true });
  const hardMat = createMasonryMaterial(ctx.uniforms, { shadow: true, twoSided: false, sway: false });
  mats.push(softMat, hardMat);
  let tris = 0;
  /** Shift a writer so its local y is height above its lowest foot, and wrap it in a mesh. */
  const finish = (p: Part, m: THREE.Material, name: string, two: boolean): THREE.Mesh | null => {
    if (p.w.ni === 0) return null;
    const base = Number.isFinite(p.base) ? p.base : 0;
    for (let v = 0; v < p.w.nv; v++) p.w.pos[v * 3 + 1] -= base;
    if (two) p.w.orient();
    const g = p.w.geometry();
    if (!g) return null;
    if (two) g.boundingSphere!.radius += 0.5;
    geos.push(g);
    tris += p.w.tris;
    const me = new THREE.Mesh(g, m);
    me.name = name;
    me.position.y = base;
    near.add(me);
    return me;
  };
  for (const p of bigs) finish(p, hardMat, 'outskirts-tower', false);

  const cellMeshes: THREE.Mesh[] = [];
  const bounds: number[] = [];
  for (const p of cells.values()) {
    const me = finish(p, softMat, 'outskirts-cell', true);
    if (!me) continue;
    me.visible = false;
    cellMeshes.push(me);
    const bb = me.geometry.boundingBox!;
    bounds.push(bb.min.x, bb.min.z, bb.max.x, bb.max.z);
  }
  const bx = new Float32Array(bounds);

  // sails: one geometry, a turning mesh per windmill
  const sailRoots: THREE.Mesh[] = [];
  if (mills.length > 0) {
    const sw = new Writer(512, 1024);
    const N = 8;
    const L = 5.6;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      sw.mat = MAT.wood;
      sw.tint = 90;
      sw.extra = 0;
      bar(sw, 0, 0, 0.1, c * L, s * L, 0.1, 0.13);
      // a rope from tip to tip
      const c2 = Math.cos(a + TAU / N), s2 = Math.sin(a + TAU / N);
      bar(sw, c * L, s * L, 0.1, c2 * L, s2 * L, 0.1, 0.035);
      // a triangular cloth sail furled round the spar and sheeted to the next
      sw.mat = MAT.cloth;
      sw.tint = 225 + (k & 1) * 20;
      const b = a + 0.5;
      sw.triAuto(c * 0.7, s * 0.7, 0.16, c * L, s * L, 0.16, Math.cos(b) * L * 0.72, Math.sin(b) * L * 0.72, 0.16, 0, 0, 1);
    }
    sw.mat = MAT.wood;
    sw.tint = 60;
    bar(sw, 0, 0, -0.5, 0, 0, 0.45, 0.5, true);
    sw.orient();
    const sg = sw.geometry()!;
    sg.boundingSphere!.radius += 0.5;
    geos.push(sg);
    tris += sw.tris * mills.length;
    for (const m of mills) {
      const pivot = new THREE.Group();
      pivot.position.set(m.x, m.y, m.z);
      pivot.rotation.y = m.yaw;
      const me = new THREE.Mesh(sg, softMat);
      me.name = 'outskirts-sails';
      me.rotation.z = m.phase;
      pivot.add(me);
      near.add(pivot);
      sailRoots.push(me);
    }
  }
  const sailDir = new Float32Array(mills.map((m) => m.dir));

  const glowMesh = (gl: GlowList, isNear: boolean, name: string, into: THREE.Group): void => {
    const g = gl.geometry();
    if (!g) return;
    const m = createGlowMaterial(ctx.uniforms, isNear);
    mats.push(m);
    geos.push(g);
    const me = new THREE.Mesh(g, m);
    me.name = name;
    me.renderOrder = 2;
    trackViewport(me, m);
    into.add(me);
  };
  glowMesh(nearGlow, true, 'outskirts-glows', near);

  let far: THREE.Group | null = null;
  if (farW.ni > 0 || farGlow.count > 0) {
    far = new THREE.Group();
    far.name = 'outskirts-far';
    if (farW.ni > 0) {
      const base = Number.isFinite(farBase) ? farBase : 0;
      for (let v = 0; v < farW.nv; v++) farW.pos[v * 3 + 1] -= base;
      const fg = farW.geometry()!;
      const m = createMasonryMaterial(ctx.uniforms, { shadow: false, twoSided: false, sway: false });
      mats.push(m);
      geos.push(fg);
      const me = new THREE.Mesh(fg, m);
      me.name = 'outskirts-far-masonry';
      me.position.y = base;
      far.add(me);
    }
    glowMesh(farGlow, false, 'outskirts-far-glows', far);
  }

  for (let i = 0; i < rects.length; i += 4)
    tiles(rects[i], rects[i + 1], rects[i + 2], rects[i + 3], (x, z, r) => {
      ctx.claim(x, z, r);
      return true;
    });

  near.userData.triangles = tris;
  near.userData.counts = counts;
  near.userData.items = items;
  near.userData.groundCalls = G.calls;
  near.userData.buildMs = performance.now() - t0;
  near.userData.tracksKnown = tracks.length > 0;

  const H2 = HIDE * HIDE;
  let spin = 0;
  return {
    near,
    far,
    solids,
    emitters,
    update(f, p) {
      for (let i = 0; i < cellMeshes.length; i++) {
        const b = i * 4;
        const dx = Math.max(bx[b] - p.x, 0, p.x - bx[b + 2]);
        const dz = Math.max(bx[b + 1] - p.z, 0, p.z - bx[b + 3]);
        cellMeshes[i].visible = dx * dx + dz * dz < H2;
      }
      // the sails turn slowly, a little faster in the gusts
      spin += f.dt * (0.32 + 0.55 * f.gust);
      for (let i = 0; i < sailRoots.length; i++) sailRoots[i].rotation.z = mills[i].phase + spin * sailDir[i];
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      geos.length = 0;
      mats.length = 0;
    },
  };
};
