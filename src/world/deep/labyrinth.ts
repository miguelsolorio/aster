// The tunnel labyrinth: a hand-cut city of soft pale rock, four levels of tight passages one
// over another. The stair from the hole comes down into the top level; a lamp-lit way leads
// through a few junctions to a ledge high in the wall of the great shaft, a square well cut
// down through every level, each level's tunnels opening into its walls as dark mouths and
// balconies, a stair of slabs turning down round it. At its foot a door leads to the chapel:
// a cruciform hall under a barrel roof, a plinth at its crossing.
//
// How it is laid out. Every level is a lattice of junctions about thirty metres apart, each
// pushed a little off its place, joined by a maze (a spanning tree with loops knocked through)
// of passages that dogleg and wander. Each level's lattice is set half a step off the one
// above, so passages cross over passages rather than lying on them, and a stair between two
// levels runs straight from a junction of one to a junction of the next, one and a half steps
// along. Everything optional (side rooms, wells, vents, niches) is cut only where the rock is
// found solid, so nothing breaks into anything else.
//
// Up and down: level 0 hangs just under the lid; the others follow D apart; the shaft's floor
// and the chapel are on the last.

import type { Uniforms } from '../../game/contract';
import type { DeepSpec } from './types';
import { DeepBuilder, TEAL, mulberry32, type BuiltDeep } from './builder';
import type { Pt } from './spans';

function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));

/** What a check (or a curious caller) may want to know about a built labyrinth. Local frame. */
export interface LabyrinthInfo {
  /** Floor height of each level, top down. */
  levels: number[];
  /** The great shaft: its plan, floor and roof. */
  shaft: { u0: number; v0: number; u1: number; v1: number; floor: number; roof: number };
  /** The middle of the shaft's floor. */
  foot: Pt;
  /** A junction on each level. */
  levelPts: Pt[];
  /** The chamber with the mineral seam, or null. */
  vein: Pt | null;
  /** Junctions and chambers, and metres of passage between them. */
  nodes: number;
  metres: number;
  stairs: number;
  wells: number;
  /** Every joining the maze was planned with (passage, stair, mouth into the shaft), as the two places it joins. */
  links: { kind: string; a: Pt; b: Pt }[];
}

const NL = 4;
// each level's lattice, in steps off the first: neighbours differ along one axis only
const OFFU = [0, 0.5, 0.5, 0];
const OFFV = [0, 0, 0.5, 0.5];
const F_ROUTE = 1;
const F_STAIR = 2;
const F_MOUTH = 4;
const R_JUNCTION = 0;
const R_STORE = 1;
const R_STABLE = 2;
const R_CHAPEL = 3;
const R_CELL = 4;
const R_WELL = 5;
const R_VEIN = 6;
const R_HALL = 7;

interface Node {
  l: number;
  i: number;
  j: number;
  u: number;
  v: number;
  valid: boolean;
  alive: boolean;
  flags: number;
  /** Everything it is joined to (passages, stairs, the shaft, the way in). */
  adj: Node[];
  depth: number;
  room: number;
  ra: number;
  rb: number;
  rh: number;
}
interface Edge {
  a: Node;
  b: Node;
  ax: number;
  key: number;
}
interface Stair {
  l: number;
  alongU: boolean;
  a: Node;
  b: Node;
  p0: number;
  p1: number;
  lat: number;
  y0: number;
  y1: number;
  steps: boolean;
}
interface Seg {
  l: number;
  au: number;
  av: number;
  bu: number;
  bv: number;
  key: number;
  /** A passage of the maze proper (not a spur or a connector). */
  maze: boolean;
}
interface Mouth {
  l: number;
  wall: number;
  lat: number;
  node: Node;
  pts: number[][];
  balcony: boolean;
}

export function buildLabyrinth(spec: DeepSpec, uniforms?: Uniforms): BuiltDeep {
  const tier = spec.tier;
  const lid = spec.lid;
  const seed = spec.seed | 0;
  // the shape of the place comes from a generator of its own, so every tier builds the same maze
  const rnd = mulberry32(Math.imul(seed, 0x9e3779b1) ^ 0x1ab94);
  const R = (a: number, b: number): number => a + (b - a) * rnd();
  const h01 = (key: number, salt = 0): number => hash2(key ^ Math.imul(seed, 0x2545f491), salt);
  const vnoise = (x: number, y: number): number => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = smooth(x - i);
    const fy = smooth(y - j);
    const a = hash2(i + seed, j);
    const b = hash2(i + 1 + seed, j);
    const c = hash2(i + seed, j + 1);
    const d = hash2(i + 1 + seed, j + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };

  // ---- heights
  const D = Math.round(R(13.5, 15) * 2) / 2; // between levels; half of it is a whole number of treads
  const yFoot = lid - 2.9; // the builder's b.foot
  const Y: number[] = [];
  for (let l = 0; l < NL; l++) Y.push(yFoot - 2 - l * D);
  const Y0 = Y[0];
  const Y3 = Y[NL - 1];
  const yRoof = Y0 + 4.5; // the shaft's roof, just under the lid
  const HS = 2.7; // headroom on a stair

  const b = new DeepBuilder(spec, uniforms, { cell: 1, yMin: Y3 - 3, maxSpans: 8, wallStep: [3, 4, 6][tier] });
  const g = b.grid;
  const cu = g.cu;
  const cv = g.cv;
  const midU = (x: number): number => g.u0 + (Math.floor((x - g.u0) / cu + 1e-6) + 0.5) * cu;
  const midV = (x: number): number => g.v0 + (Math.floor((x - g.v0) / cv + 1e-6) + 0.5) * cv;
  const edgeU = (x: number): number => g.u0 + Math.round((x - g.u0) / cu) * cu;
  const edgeV = (x: number): number => g.v0 + Math.round((x - g.v0) / cv) * cv;

  // ---- the great shaft: where it is
  const Wu = 2 * Math.round(R(13, 18.5));
  const nSv = Math.round(R(26, 37) / cv);
  const Wv = nSv * cv;
  const uA = edgeU(R(56, 68));
  const uB = uA + Wu;
  const vWant = clamp(0.25 * (spec.v0 + spec.v1) * 0.5 + R(-18, 18), spec.v0 + Wv / 2 + 16, spec.v1 - Wv / 2 - 16);
  const vLo = edgeV(vWant - Wv / 2);
  const vHi = vLo + Wv;
  const uS = (uA + uB) / 2;
  const vS = (vLo + vHi) / 2;
  const s = rnd() < 0.5 ? 1 : -1; // which side of the near wall the ledge is on
  const vWall = (sg: number): number => (sg > 0 ? vHi : vLo);
  const wallOf = (sg: number): number => (sg > 0 ? 3 : 2); // walls: 0 near (low u), 1 far, 2 low v, 3 high v
  const TH = 1; // slabs of the stair

  // ---- the chapel: where it is
  const vc = midV(vS);
  const uC0 = uB + 2 * Math.round(R(5, 7));
  const uX = uC0 + 18.5;
  const uC1 = uC0 + 30;
  const hC = Math.min(R(9, 12), D - 3.5);
  const TL = 11.25;

  // ---- what stands in the way of a level's passages
  const rectsMeet = (a0: number, b0: number, a1: number, b1: number, u0: number, v0: number, u1: number, v1: number, pad: number): boolean =>
    a1 > u0 - pad && a0 < u1 + pad && b1 > v0 - pad && b0 < v1 + pad;
  const chU0 = uB;
  const chU1 = uC1 + 5;
  const chV0 = vc - 12;
  const chV1 = vc + 12;
  /** Whether a level's rectangle of passage would run into the shaft or the chapel. */
  const reserved = (l: number, u0: number, v0: number, u1: number, v1: number, pad: number): boolean =>
    rectsMeet(u0, v0, u1, v1, uA, vLo, uB, vHi, pad) || (l === NL - 1 && rectsMeet(u0, v0, u1, v1, chU0, chV0, chU1, chV1, pad));

  // ---- the lattices
  const Su = 2 * Math.round(R(15, 17));
  const Sv = cv * Math.round(R(30, 34) / cv);
  const Ub = 13.5 + R(0, Su / 2);
  const Vb = spec.v0 + 11 + R(0, Sv / 2);
  const NI = Math.min(63, Math.floor((spec.u1 - Ub) / Su) + 2);
  const NJ = Math.min(63, Math.floor((spec.v1 - Vb) / Sv) + 2);
  const JIT = 3;
  const nodeKey = (l: number, i: number, j: number): number => (l * 64 + i) * 64 + j;
  const nodes: Node[][] = [];
  for (let l = 0; l < NL; l++) {
    const row: Node[] = [];
    for (let j = 0; j < NJ; j++) {
      for (let i = 0; i < NI; i++) {
        const key = nodeKey(l, i, j);
        const bu = Ub + (i + OFFU[l]) * Su;
        const bv = Vb + (j + OFFV[l]) * Sv;
        const valid = bu >= (l === 0 ? 16.5 : 11) && bu <= spec.u1 - 11 && bv >= spec.v0 + 11 && bv <= spec.v1 - 11;
        const u = midU(bu + (h01(key, 1) * 2 - 1) * JIT);
        const v = midV(bv + (h01(key, 2) * 2 - 1) * JIT);
        const ok = valid && !reserved(l, u, v, u, v, 8);
        row.push({ l, i, j, u, v, valid: ok, alive: false, flags: 0, adj: [], depth: -1, room: R_JUNCTION, ra: 0, rb: 0, rh: 0 });
      }
    }
    nodes.push(row);
  }
  const at = (l: number, i: number, j: number): Node | null => (i < 0 || j < 0 || i >= NI || j >= NJ ? null : nodes[l][i + j * NI]);
  // A level does not fill the room. It starts as the junctions round the shaft and grows from
  // there, one junction at a time, along the veins of a noise field and out toward a side of
  // its own: so the levels overlap at the heart and each reaches a different far corner. A
  // lesser machine stops the same growth sooner, and so gets the middle of the same place.
  {
    const toU = spec.u1 / 2 - uS;
    const toV = (spec.v0 + spec.v1) / 2 - vS;
    const base = Math.atan2(toV, toU) + R(-0.25, 0.25);
    const turn = rnd() < 0.5 ? 1 : -1;
    for (let l = 0; l < NL; l++) {
      const want = Math.round(R(36, 50) * [1, 0.75, 0.55][tier]);
      const ang = base + turn * (l - 1.5) * 0.75;
      const du = Math.cos(ang);
      const dv = Math.sin(ang);
      const score = (n: Node): number => vnoise(n.i * 0.45 + l * 17.3, n.j * 0.45 - l * 9.1) + (0.3 * ((n.u - uS) * du + (n.v - vS) * dv)) / 150;
      let count = 0;
      const front = new Set<Node>();
      const take = (n: Node): void => {
        n.alive = true;
        count++;
        front.delete(n);
        for (const o of [at(l, n.i + 1, n.j), at(l, n.i - 1, n.j), at(l, n.i, n.j + 1), at(l, n.i, n.j - 1)]) {
          if (o && o.valid && !o.alive) front.add(o);
        }
      };
      for (const n of nodes[l]) {
        if (n.valid && Math.abs(n.u - uS) < Wu / 2 + 1.3 * Su && Math.abs(n.v - vS) < Wv / 2 + 1.3 * Sv) take(n);
      }
      while (count < want && front.size > 0) {
        let best: Node | null = null;
        let bs = -1e9;
        for (const n of front) {
          const sc = score(n);
          if (sc > bs) {
            bs = sc;
            best = n;
          }
        }
        take(best!);
      }
    }
  }
  const pseudo = (l: number, u: number, v: number): Node => ({ l, i: -1, j: -1, u, v, valid: true, alive: true, flags: F_ROUTE, adj: [], depth: -1, room: R_JUNCTION, ra: 0, rb: 0, rh: 0 });
  const join = (a: Node, c: Node): void => {
    if (a.adj.indexOf(c) < 0) {
      a.adj.push(c);
      c.adj.push(a);
    }
  };

  /** The corners of a passage from a to b that leaves and arrives along one axis, with a jog between. */
  const leg = (au: number, av: number, bu: number, bv: number, alongU: boolean, key: number, m0 = 8, m1 = 8): number[][] => {
    const a = alongU ? au : av;
    const c = alongU ? bu : bv;
    if (Math.abs((alongU ? av : au) - (alongU ? bv : bu)) < 0.05) return [[au, av], [bu, bv]];
    const len = Math.abs(c - a);
    const dir = c >= a ? 1 : -1;
    let f = (0.38 + 0.24 * h01(key, 11)) * len;
    f = Math.max(Math.min(f, len - m1), Math.min(m0, len / 2));
    const mid = alongU ? midU(a + dir * f) : midV(a + dir * f);
    return alongU ? [[au, av], [mid, av], [mid, bv], [bu, bv]] : [[au, av], [au, mid], [bu, mid], [bu, bv]];
  };

  // ---- the way in, and the junctions the lit way runs through
  const entry = pseudo(0, 13.5, midV(0.45));
  const shaftNode = pseudo(-1, uS, vS);
  let J1: Node | null = null;
  let J1b: Node | null = null;
  {
    let bd = 1e9;
    let bd2 = 1e9;
    for (const n of nodes[0]) {
      if (!n.valid || n.u < entry.u + 6) continue;
      const d = Math.hypot(n.u - entry.u, n.v - entry.v);
      if (d < bd) {
        bd2 = bd;
        J1b = J1;
        bd = d;
        J1 = n;
      } else if (d < bd2) {
        bd2 = d;
        J1b = n;
      }
    }
    if (J1b && bd2 > 46) J1b = null;
  }
  if (J1) J1.alive = true;
  if (J1b) J1b.alive = true;

  // ---- mouths: where each level opens into the shaft
  const mouths: Mouth[] = [];
  /** Flights of the shaft's stair: which wall, from where to where along it, between which heights. */
  const flights: { wall: number; c0: number; c1: number; ya: number; yb: number; lat: number }[] = [];
  {
    const vIn = (sg: number, cells: number): number => vWall(sg) - sg * cells * cv;
    const h = D / 2;
    flights.push({ wall: 0, c0: vIn(s, 6), c1: vIn(-s, 3), ya: Y0, yb: Y0 - h, lat: uA + 1.5 });
    flights.push({ wall: wallOf(-s), c0: uA + 3, c1: uB - 3, ya: Y0 - h, yb: Y0 - 2 * h, lat: vIn(-s, 1.5) });
    flights.push({ wall: 1, c0: vIn(-s, 3), c1: vIn(s, 3), ya: Y0 - 2 * h, yb: Y0 - 3 * h, lat: uB - 1.5 });
    flights.push({ wall: wallOf(s), c0: uB - 3, c1: uA + 3, ya: Y0 - 3 * h, yb: Y0 - 4 * h, lat: vIn(s, 1.5) });
    flights.push({ wall: 0, c0: vIn(s, 3), c1: vIn(-s, 3), ya: Y0 - 4 * h, yb: Y0 - 5 * h, lat: uA + 1.5 });
    flights.push({ wall: wallOf(-s), c0: uA + 3, c1: uB - 3, ya: Y0 - 5 * h, yb: Y0 - 6 * h, lat: vIn(-s, 1.5) });
  }
  /** Whether a mouth in a wall at `lat`, on a level, would stand clear of every flight on that wall. */
  const mouthClear = (l: number, wall: number, lat: number): boolean => {
    for (const f of flights) {
      if (f.wall !== wall) continue;
      for (const x of [lat - 2.6, lat + 2.6]) {
        const y = f.ya + (f.yb - f.ya) * clamp((x - f.c0) / (f.c1 - f.c0), 0, 1);
        if (!(y <= Y[l] - 4.2 || y - TH >= Y[l] + 3.6)) return false;
      }
    }
    return true;
  };
  const wallAt = [uA, uB, vLo, vHi];
  const findMouth = (l: number, wall: number, lat: number, balcony: boolean): boolean => {
    const alongU = wall < 2;
    const sign = wall === 0 || wall === 2 ? -1 : 1;
    const w = wallAt[wall];
    const key = nodeKey(l, 60, wall) * 31 + mouths.length;
    const start = alongU ? [w - sign * 0.5 * cu, lat] : [lat, w - sign * 0.5 * cv];
    let best: Node | null = null;
    let bp: number[][] = [];
    let bd = 1e9;
    for (const n of nodes[l]) {
      if (!n.alive || (n.flags & F_MOUTH) !== 0) continue;
      const out = sign * ((alongU ? n.u : n.v) - w);
      const dl = Math.abs((alongU ? n.v : n.u) - lat);
      if (out < 9.5 || out > 50 || dl > 40) continue;
      const d = out + dl * 1.2;
      if (d >= bd) continue;
      const pts = leg(start[0], start[1], n.u, n.v, alongU, key, 5, 3.5);
      // the jog must not run back into the chapel
      let ok = true;
      for (let k = 0; k + 1 < pts.length && ok; k++) {
        const p = pts[k];
        const q = pts[k + 1];
        if (l === NL - 1 && rectsMeet(Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1]), chU0, chV0, chU1, chV1, 4)) ok = false;
      }
      if (!ok) continue;
      bd = d;
      best = n;
      bp = pts;
    }
    if (!best) return false;
    best.flags |= F_MOUTH;
    mouths.push({ l, wall, lat, node: best, pts: bp, balcony });
    // (a sill over the drop is a way out of a level, not a way into it)
    if (!balcony) join(best, shaftNode);
    return true;
  };
  {
    const ws = wallOf(s);
    const wn = wallOf(-s);
    // the ledge, and each level's own landing
    findMouth(0, 0, vWall(s) - s * 2.5 * cv, false);
    if (!findMouth(1, 1, vWall(-s) + s * 1.5 * cv, false)) findMouth(1, wn, uB - 1.5, false);
    if (!findMouth(2, ws, uA + 1.5, false)) findMouth(2, 0, vWall(s) - s * 1.5 * cv, false);
    // dark mouths in the other walls, each with a sill pushed out over the drop
    const extra = (l: number, walls: number[], most: number): void => {
      let got = 0;
      for (const wall of walls) {
        if (got >= most) break;
        const alongU = wall < 2;
        const lo = alongU ? vLo + 8.6 : uA + 8;
        const hi = alongU ? vHi - 8.6 : uB - 8;
        for (let tries = 0; tries < 3; tries++) {
          const x = R(lo, hi);
          const lat = alongU ? midV(x) : midU(x);
          if (!mouthClear(l, wall, lat)) continue;
          if (findMouth(l, wall, lat, l < NL - 1)) {
            got++;
            break;
          }
        }
      }
    };
    extra(0, rnd() < 0.5 ? [1, wn, ws] : [wn, 1, ws], 2);
    extra(1, [0, ws], 2);
    extra(2, [1, wn], 2);
    extra(3, [0, ws], 2);
    if (!mouths.some((m) => m.l === NL - 1)) {
      // (only where the room leaves nothing on those sides)
      for (const sg of [-1, 1]) if (!mouths.some((m) => m.l === NL - 1)) findMouth(NL - 1, 1, midV(vc + sg * (Wv / 2 - 4)), false);
    }
  }

  // ---- the lit way across the top level: forced through the lattice from the way in to the ledge
  const forced = new Set<number>();
  const edgeKey = (l: number, i: number, j: number, ax: number): number => nodeKey(l, i, j) * 2 + ax;
  const route: Node[] = [];
  const m0 = mouths.find((m) => m.l === 0 && m.wall === 0 && !m.balcony) ?? null;
  if (J1) {
    join(entry, J1);
    if (J1b) join(entry, J1b);
    route.push(J1);
    if (m0) {
      let ci = J1.i;
      let cj = J1.j;
      const J2 = m0.node;
      while (ci !== J2.i || cj !== J2.j) {
        const goI = ci !== J2.i && (cj === J2.j || rnd() < 0.5);
        const ni = goI ? ci + Math.sign(J2.i - ci) : ci;
        const nj = goI ? cj : cj + Math.sign(J2.j - cj);
        forced.add(edgeKey(0, Math.min(ci, ni), Math.min(cj, nj), goI ? 0 : 1));
        ci = ni;
        cj = nj;
        const n = at(0, ci, cj)!;
        n.alive = true;
        route.push(n);
      }
    }
    for (const n of route) n.flags |= F_ROUTE;
  }

  // ---- stairs between levels
  const stairs: Stair[] = [];
  const blocked = new Set<number>();
  const fyOf = (st: Stair, x: number): number => st.y0 + (st.y1 - st.y0) * clamp((x - st.p0) / (st.p1 - st.p0), 0, 1);
  const sHit = (st: Stair, u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): boolean => {
    const a0 = st.alongU ? u0 : v0;
    const a1 = st.alongU ? u1 : v1;
    const l0 = st.alongU ? v0 : u0;
    const l1 = st.alongU ? v1 : u1;
    if (l1 < st.lat - 2.4 || l0 > st.lat + 2.4) return false;
    const o0 = Math.max(a0, Math.min(st.p0, st.p1) - 0.6);
    const o1 = Math.min(a1, Math.max(st.p0, st.p1) + 0.6);
    if (o0 > o1) return false;
    const f0 = fyOf(st, o0);
    const f1 = fyOf(st, o1);
    return y1 > Math.min(f0, f1) - 1.3 && y0 < Math.max(f0, f1) + HS + 1.1;
  };
  const hitsStair = (u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): boolean => {
    for (const st of stairs) if (sHit(st, u0, v0, u1, v1, y0, y1)) return true;
    return false;
  };
  /** Level passages laid before the stairs are chosen (spurs, the way in): stairs keep off them. */
  const flats: number[][] = [[3, -3.2, 13.5, 3.2, 0]];
  const flatPath = (l: number, pts: number[][]): void => {
    for (let k = 0; k + 1 < pts.length; k++) {
      flats.push([Math.min(pts[k][0], pts[k + 1][0]) - 2.2, Math.min(pts[k][1], pts[k + 1][1]) - 2.2, Math.max(pts[k][0], pts[k + 1][0]) + 2.2, Math.max(pts[k][1], pts[k + 1][1]) + 2.2, l]);
    }
  };
  for (const m of mouths) flatPath(m.l, m.pts);
  const entryLegs: number[][][] = [];
  for (const n of [J1, J1b]) {
    if (!n) continue;
    const pts = leg(entry.u, entry.v, n.u, n.v, true, nodeKey(0, 61, entryLegs.length), 3.5, 3.5);
    entryLegs.push(pts);
    flatPath(0, pts);
  }
  for (let l = 0; l + 1 < NL; l++) {
    const alongU = OFFU[l] !== OFFU[l + 1];
    const off = alongU ? OFFU[l] - OFFU[l + 1] : OFFV[l] - OFFV[l + 1];
    const cands: { a: Node; c: Node; dir: number; w: number }[] = [];
    for (const a of nodes[l]) {
      if (!a.alive) continue;
      for (const dir of [-1, 1]) {
        const k = (alongU ? a.i : a.j) + off + 1.5 * dir;
        const c = alongU ? at(l + 1, k, a.j) : at(l + 1, a.i, k);
        if (c && c.alive) cands.push({ a, c, dir, w: h01(nodeKey(l, a.i, a.j), 20 + dir) });
      }
    }
    cands.sort((x, y) => x.w - y.w);
    let got = 0;
    for (const cd of cands) {
      if (got >= 3) break;
      const { a, c, dir } = cd;
      if ((a.flags & (F_STAIR | F_MOUTH)) !== 0 || (c.flags & (F_STAIR | F_MOUTH)) !== 0) continue;
      const aA = alongU ? a.u : a.v;
      const aB = alongU ? c.u : c.v;
      const p0 = aA + dir * 4.5;
      const p1 = aB - dir * 4.5;
      const run = (p1 - p0) * dir;
      if (run < 8 || D / run > 0.52) continue;
      const lat = alongU ? a.v : a.u;
      // the two passages it takes the place of
      const ia = alongU ? a.i : a.j;
      const ic = alongU ? c.i : c.j;
      const ka = alongU ? edgeKey(l, dir > 0 ? ia : ia - 1, a.j, 0) : edgeKey(l, a.i, dir > 0 ? ia : ia - 1, 1);
      const kc = alongU ? edgeKey(l + 1, dir > 0 ? ic - 1 : ic, c.j, 0) : edgeKey(l + 1, c.i, dir > 0 ? ic - 1 : ic, 1);
      if (forced.has(ka) || forced.has(kc) || blocked.has(ka) || blocked.has(kc)) continue;
      const st: Stair = { l, alongU, a, b: c, p0, p1, lat, y0: Y[l], y1: Y[l + 1], steps: h01(nodeKey(l, a.i, a.j), 23) < 0.7 };
      const lo = Math.min(aA, aB) - 2;
      const hi = Math.max(aA, aB) + 2;
      const r0 = alongU ? lo : lat - 5;
      const r1 = alongU ? lat - 5 : lo;
      const r2 = alongU ? hi : lat + 5;
      const r3 = alongU ? lat + 5 : hi;
      if (rectsMeet(r0, r1, r2, r3, uA, vLo, uB, vHi, 3)) continue;
      if (l + 1 === NL - 1 && rectsMeet(r0, r1, r2, r3, chU0, chV0, chU1, chV1, 4)) continue;
      // not too near another of the same pair, nor through one of any pair, nor through a spur
      let ok = true;
      for (const o of stairs) {
        if (o.l === l && Math.hypot(o.a.u - a.u, o.a.v - a.v) < 70) ok = false;
      }
      for (let x = Math.min(p0, p1); x <= Math.max(p0, p1) && ok; x += 2) {
        const f = fyOf(st, x);
        const x1 = Math.min(x + 2, Math.max(p0, p1));
        if (alongU ? hitsStair(x, lat - 2.4, x1, lat + 2.4, f - 2.5, f + HS + 1.2) : hitsStair(lat - 2.4, x, lat + 2.4, x1, f - 2.5, f + HS + 1.2)) ok = false;
      }
      for (const fb of flats) {
        if (ok && (fb[4] === l || fb[4] === l + 1) && sHit(st, fb[0], fb[1], fb[2], fb[3], Y[fb[4]] - 0.6, Y[fb[4]] + 3.6)) ok = false;
      }
      if (!ok) continue;
      stairs.push(st);
      blocked.add(ka);
      blocked.add(kc);
      a.flags |= F_STAIR;
      c.flags |= F_STAIR;
      join(a, c);
      got++;
    }
  }

  // ---- each level's maze: a spanning tree over what is left, and loops knocked through it
  const edges: Edge[] = [];
  for (let l = 0; l < NL; l++) {
    const cand: (Edge & { w: number })[] = [];
    for (const a of nodes[l]) {
      if (!a.alive) continue;
      for (let ax = 0; ax < 2; ax++) {
        const c = ax === 0 ? at(l, a.i + 1, a.j) : at(l, a.i, a.j + 1);
        if (!c || !c.alive) continue;
        const key = edgeKey(l, a.i, a.j, ax);
        const must = forced.has(key);
        if (blocked.has(key)) continue;
        if (!must) {
          const u0 = Math.min(a.u, c.u) - 3.5;
          const v0 = Math.min(a.v, c.v) - 3.5;
          const u1 = Math.max(a.u, c.u) + 3.5;
          const v1 = Math.max(a.v, c.v) + 3.5;
          if (reserved(l, u0, v0, u1, v1, 1.5) || hitsStair(u0, v0, u1, v1, Y[l] - 0.3, Y[l] + 3.4)) continue;
        }
        cand.push({ a, b: c, ax, key, w: must ? -1 : h01(key, 30) });
      }
    }
    cand.sort((x, y) => x.w - y.w);
    const par = new Map<Node, Node>();
    const find = (n: Node): Node => {
      let r = n;
      while (par.get(r) && par.get(r) !== r) r = par.get(r)!;
      par.set(n, r);
      return r;
    };
    for (const e of cand) {
      const ra = find(e.a);
      const rb = find(e.b);
      if (ra !== rb) par.set(ra, rb);
      else if (e.w >= 0 && h01(e.key, 31) > 0.3) continue;
      edges.push(e);
      join(e.a, e.b);
    }
  }

  // ---- what can be reached from the way in is the labyrinth; the rest is left as rock
  {
    for (const row of nodes) for (const n of row) n.depth = -1;
    entry.depth = 0;
    const queue: Node[] = [entry];
    for (let q = 0; q < queue.length; q++) {
      const n = queue[q];
      for (const o of n.adj) {
        if (o.depth < 0 && o.alive) {
          o.depth = n.depth + 1;
          queue.push(o);
        }
      }
    }
    for (const row of nodes) {
      for (const n of row) {
        if (n.alive && n.depth < 0) {
          n.alive = false;
          for (const o of n.adj) o.adj.splice(o.adj.indexOf(n), 1);
          n.adj.length = 0;
        }
      }
    }
    // lesser machines lose the outermost dead ends
    for (let round = 0; round < [0, 0, 1][tier]; round++) {
      const gone: Node[] = [];
      for (const row of nodes) for (const n of row) if (n.alive && n.flags === 0 && n.adj.length <= 1 && h01(nodeKey(n.l, n.i, n.j), 95 + round) < 0.75) gone.push(n);
      for (const n of gone) {
        n.alive = false;
        for (const o of n.adj) o.adj.splice(o.adj.indexOf(n), 1);
        n.adj.length = 0;
      }
    }
  }
  const liveEdges = edges.filter((e) => e.a.alive && e.b.alive);
  const liveStairs = stairs.filter((st) => st.a.alive && st.b.alive);
  const liveMouths = mouths.filter((m) => m.node.alive);

  /** The lowest stair floor over a rectangle and above y, less the rock it needs under it. */
  const stairOver = (u0: number, v0: number, u1: number, v1: number, y: number): number => {
    let low = Infinity;
    for (const st of liveStairs) {
      const a0 = st.alongU ? u0 : v0;
      const a1 = st.alongU ? u1 : v1;
      const l0 = st.alongU ? v0 : u0;
      const l1 = st.alongU ? v1 : u1;
      if (l1 < st.lat - 2.4 || l0 > st.lat + 2.4) continue;
      const o0 = Math.max(a0, Math.min(st.p0, st.p1) - 0.6);
      const o1 = Math.min(a1, Math.max(st.p0, st.p1) + 0.6);
      if (o0 > o1) continue;
      const f = Math.min(fyOf(st, o0), fyOf(st, o1));
      if (f > y + 1) low = Math.min(low, f - 1.3);
    }
    return low;
  };

  // ---- rooms: every dead end is a chamber, and a junction here and there a small hall
  const chambers: Node[] = [];
  for (const row of nodes) {
    for (const n of row) {
      if (!n.alive) continue;
      const key = nodeKey(n.l, n.i, n.j);
      // (a stair passing close overhead leaves room for a junction only)
      const cap = stairOver(n.u - 4.5, n.v - 4.5 * cv, n.u + 4.5, n.v + 4.5 * cv, Y[n.l]) - Y[n.l];
      if (n.flags === 0 && n.adj.length === 1 && cap >= 3.3) {
        const q = h01(key, 40);
        n.room = q < 0.3 ? R_STORE : q < 0.52 ? R_STABLE : q < 0.68 ? R_CHAPEL : R_CELL;
        n.ra = 3.5 + (h01(key, 41) < 0.5 ? 1 : 0);
        n.rb = cv * (3.5 + (h01(key, 42) < 0.5 ? 1 : 0));
        n.rh = Math.min(cap, 3.3 + 0.7 * h01(key, 43));
        chambers.push(n);
      } else if (n.flags === 0 && n.adj.length >= 3 && cap >= 3.6 && h01(key, 44) < 0.16) {
        n.room = R_HALL;
        n.ra = 3.5;
        n.rb = cv * 3.5;
        n.rh = 3.6;
      } else {
        n.ra = 2.4;
        n.rb = 2.3;
        n.rh = Math.min(cap, 3.2);
      }
    }
  }
  // the seam is in the dead end farthest from the way in, below the top level if there is one
  let veinNode: Node | null = null;
  if (spec.vein) {
    for (const n of chambers) {
      const w = n.depth + (n.l > 0 ? 100 : 0);
      if (!veinNode || w > veinNode.depth + (veinNode.l > 0 ? 100 : 0)) veinNode = n;
    }
    if (!veinNode) {
      // (no dead end left: the deepest plain junction is widened into a chamber for it)
      for (const row of nodes) for (const n of row) if (n.alive && n.flags === 0 && n.rh >= 3.2 && (!veinNode || n.depth > veinNode.depth)) veinNode = n;
      if (veinNode) {
        veinNode.ra = 3.5;
        veinNode.rb = 3.5 * cv;
        chambers.push(veinNode);
      }
    }
    if (veinNode) veinNode.room = R_VEIN;
  }

  // ================================================================ cutting
  const tufa: number[] = [];
  for (let l = 0; l < NL; l++) tufa.push(b.paint(1 - 0.035 * l, 0.97 - 0.04 * l, 0.9 - 0.035 * l, 1));
  const setPaint = (l: number): void => {
    g.paintF = tufa[l];
    g.paintC = tufa[l];
  };
  const segs: Seg[] = [];
  let metres = 0;

  /**
   * A length of passage along one axis, three cells wide under a ceiling lower at its sides.
   * With `wob` its walls wander: the whole passage steps a cell aside now and then, and here
   * and there one wall is cut a cell deeper. e0 and e1 are how far it runs on past each end.
   */
  const tunnel = (au: number, av: number, bu: number, bv: number, y: number, h: number, key = 0, wob = false, e0 = -1, e1 = -1): void => {
    const alongU = Math.abs(bu - au) >= Math.abs(bv - av);
    const cl = alongU ? cv : cu;
    const ca = alongU ? cu : cv;
    const t0 = alongU ? au : av;
    const t1 = alongU ? bu : bv;
    const lat = alongU ? av : au;
    const dir = t1 >= t0 ? 1 : -1;
    const sA = t0 - dir * (e0 < 0 ? 1.5 * ca : e0);
    const sB = t1 + dir * (e1 < 0 ? 1.5 * ca : e1);
    const lo = Math.min(sA, sB);
    const hi = Math.max(sA, sB);
    const tmin = Math.min(t0, t1);
    const tmax = Math.max(t0, t1);
    const reach = (wob ? 3.5 : 1.5) * cl + 0.05;
    const kf = (key % 977) * 0.731;
    const cut = (ci: number, u: number, v: number): void => {
      const t = alongU ? u : v;
      let d = ((alongU ? v : u) - lat) / cl;
      let bul = 0;
      if (wob) {
        const env = clamp((Math.min(t - tmin, tmax - t) - 6) / 4, 0, 1);
        if (env > 0) {
          d -= clamp(Math.round((vnoise(t / 11 + kf, kf * 1.91) * 2 - 1) * 1.9 * env), -1, 1);
          if (env >= 1) {
            const n2 = vnoise(t / 6 + 31.7 + kf, kf * 0.77 + 9);
            bul = n2 > 0.74 ? 1 : n2 < 0.26 ? -1 : 0;
          }
        }
      }
      const ad = Math.abs(d);
      if (ad < 1.02) g.carveCell(ci, y, y + (ad > 0.5 ? h - 0.4 : h));
      else if (bul !== 0 && d * bul > 0 && ad < 2.02) g.carveCell(ci, y, y + Math.max(2.25, h - 0.7));
    };
    if (alongU) g.each(lo - 0.01, lat - reach, hi + 0.01, lat + reach, cut);
    else g.each(lat - reach, lo - 0.01, lat + reach, hi + 0.01, cut);
  };
  /** A passage along the corners `leg` gave. Only its first and last lengths wander. */
  const path = (l: number, pts: number[][], h: number, key: number, wob: boolean, e0 = -1, maze = false): void => {
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k];
      const q = pts[k + 1];
      tunnel(p[0], p[1], q[0], q[1], Y[l], h, key + k * 7, wob && !(pts.length === 4 && k === 1), k === 0 ? e0 : -1);
      segs.push({ l, au: p[0], av: p[1], bu: q[0], bv: q[1], key: key * 4 + k, maze });
      metres += Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
    }
  };
  /** A room: a rounded rectangle under a shallow dome. */
  const room = (u: number, v: number, ra: number, rb: number, y: number, h: number, pw = 3): void => {
    g.carveFn(u - ra, v - rb, u + ra, v + rb, (cu2, cv2, o) => {
      const q = Math.pow(Math.abs(cu2 - u) / ra, pw) + Math.pow(Math.abs(cv2 - v) / rb, pw);
      if (q > 1) return false;
      o.floor = y;
      o.ceil = y + Math.round((h - 0.9 * q * q) / 0.3) * 0.3;
      return true;
    });
  };
  /** Whether a block is solid rock that may be cut: inside the room, and nothing open in it. */
  const rock = (u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): boolean => {
    if (u0 < 1.5 || u1 > spec.u1 - 1.5 || v0 < spec.v0 + 1.5 || v1 > spec.v1 - 1.5) return false;
    let ok = true;
    g.each(u0, v0, u1, v1, (ci) => {
      if (!ok) return;
      if ((g.mask[ci] & 1) === 0) ok = false;
      const k0 = ci * g.K;
      for (let q = 0; q < g.n[ci]; q++) {
        if (g.c[k0 + q] > y0 && g.f[k0 + q] - 1 < y1) ok = false;
      }
    });
    return ok;
  };

  // ---- the way down the hole, a few more steps, and a vestibule
  b.holeStair();
  setPaint(0);
  g.roughNow = 0.08;
  g.carveRun([4, yFoot, 0], [8, Y0, 0], 3.6, 2.5, { steps: true });
  g.carveBox(8, -1.8, 12, 1.8, Y0, Y0 + 2.8);
  tunnel(11.5, entry.v, entry.u, entry.v, Y0, 2.8, 0, false, 0);

  // ---- the great shaft
  setPaint(1);
  g.roughNow = 0.35;
  g.carveBox(uA, vLo, uB, vHi, Y3, yRoof);
  g.roughNow = 0;
  const cornerRect = (k: number): number[] => {
    // corners in the order the stair visits them: 0 near/ledge side, 1 near/other, 2 far/other, 3 far/ledge side
    const far = k === 2 || k === 3;
    const sg = k === 0 || k === 3 ? s : -s;
    const va = vWall(sg);
    const vb = va - sg * 3 * cv;
    return [far ? uB - 3 : uA, Math.min(va, vb), far ? uB : uA + 3, Math.max(va, vb)];
  };
  const ledgeV0 = Math.min(vWall(s), vWall(s) - s * 6 * cv);
  const ledgeV1 = Math.max(vWall(s), vWall(s) - s * 6 * cv);
  g.fillBox(uA, ledgeV0, uA + 6, ledgeV1, Y0 - 1.4, Y0);
  for (let f = 1; f < 6; f++) {
    const r = cornerRect(f % 4);
    const y = Y0 - (f * D) / 2;
    g.fillBox(r[0], r[1], r[2], r[3], y - TH, y);
  }
  for (let f = 0; f < 6; f++) {
    const fl = flights[f];
    const thick = f === 5 ? D / 2 + 1 : TH; // the last is built up from the floor
    if (fl.wall < 2) g.fillRun([fl.lat, fl.ya, fl.c0], [fl.lat, fl.yb, fl.c1], 3 * cu, thick, { steps: true });
    else g.fillRun([fl.c0, fl.ya, fl.lat], [fl.c1, fl.yb, fl.lat], 3 * cv, thick, { steps: true });
  }
  g.roughNow = 0.1;
  for (const m of liveMouths) {
    if (!m.balcony) continue;
    const y = Y[m.l];
    if (m.wall < 2) {
      const ua = m.wall === 0 ? uA : uB - 2;
      g.fillBox(ua, m.lat - 2.5 * cv, ua + 2, m.lat + 2.5 * cv, y - 0.8, y);
    } else {
      const va = m.wall === 2 ? vLo : vHi - 2 * cv;
      g.fillBox(m.lat - 2.5, va, m.lat + 2.5, va + 2 * cv, y - 0.8, y);
    }
  }

  // ---- the levels: passages, spurs, junctions and chambers
  for (let l = 0; l < NL; l++) {
    setPaint(l);
    g.roughNow = 0.1;
    for (const e of liveEdges) {
      if (e.a.l !== l) continue;
      const pts = leg(e.a.u, e.a.v, e.b.u, e.b.v, e.ax === 0, e.key);
      path(l, pts, 2.7 + 0.5 * h01(e.key, 3), e.key, true, -1, true);
    }
    for (const m of liveMouths) if (m.l === l) path(l, m.pts, 2.9, 5000 + m.wall + l * 8, false, 0);
    if (l === 0) entryLegs.forEach((pts, k) => path(0, pts, 2.8, 6000 + k, false));
    g.roughNow = 0.14;
    for (const n of nodes[l]) {
      if (!n.alive) continue;
      if (n.rh >= 2.9) room(n.u, n.v, n.ra, n.rb, Y[l], n.rh, n.room === R_JUNCTION ? 2 : 3);
    }
  }
  room(entry.u, entry.v, 2.4, 2.3, Y0, 3, 2);

  // ---- the stairs between them
  for (const st of liveStairs) {
    const { a, b: c, lat, p0, p1 } = st;
    g.roughNow = 0.08;
    setPaint(st.l);
    const w = (st.alongU ? 3 * cv : 3 * cu) - 0.02;
    if (st.alongU) {
      tunnel(a.u, lat, p0, lat, st.y0, 2.9, 0, false, -1, 0);
      g.carveRun([p0, st.y0, lat], [p1, st.y1, lat], w, HS, { steps: st.steps });
      setPaint(st.l + 1);
      tunnel(p1, lat, c.u, lat, st.y1, 2.9, 0, false, 0);
      if (Math.abs(c.v - lat) > 0.05) tunnel(c.u, lat, c.u, c.v, st.y1, 2.9);
    } else {
      tunnel(lat, a.v, lat, p0, st.y0, 2.9, 0, false, -1, 0);
      g.carveRun([lat, st.y0, p0], [lat, st.y1, p1], w, HS, { steps: st.steps });
      setPaint(st.l + 1);
      tunnel(lat, p1, lat, c.v, st.y1, 2.9, 0, false, 0);
      if (Math.abs(c.u - lat) > 0.05) tunnel(lat, c.v, c.u, c.v, st.y1, 2.9);
    }
    metres += Math.abs(p1 - p0) + 9;
  }

  // ---- the chapel: a nave along u, an apse at its far end, a transept across
  setPaint(NL - 1);
  g.roughNow = 0.1;
  tunnel(uB - 0.5, vc, uC0 + 0.5, vc, Y3, 3.2, 0, false, 0, 0);
  g.roughNow = 0.08;
  {
    const aN = 4.5 * cv;
    const aR = aN + 0.55;
    const spring = hC * 0.42;
    const barrel = (x: number, top: number, half: number): number => spring + (top - spring) * Math.sqrt(Math.max(0, 1 - (x / half) * (x / half)));
    g.carveFn(uC0, vc - TL - 1, uC1 + 5, vc + TL + 1, (u, v, o) => {
      const dv = v - vc;
      let ceil = -1;
      let floor = Y3;
      if (u <= uC1) {
        if (Math.abs(dv) <= aN) ceil = barrel(dv, hC, aR);
      } else {
        const r = Math.hypot(u - uC1, dv);
        if (r <= aN) {
          ceil = barrel(r, hC, aR);
          floor = Y3 + 0.4; // the apse is a step up
        }
      }
      const du = u - uX;
      if (Math.abs(du) <= 3.55 && Math.abs(dv) <= TL) ceil = Math.max(ceil, barrel(du, hC * 0.9, 4.1));
      if (ceil < 0) return false;
      o.floor = floor;
      o.ceil = Y3 + Math.round(ceil / 0.25) * 0.25;
      return true;
    });
  }
  // the door: a low lintel
  g.each(uC0 - 2, vc - 1.5 * cv, uC0 - 1, vc + 1.5 * cv, (ci) => g.fillCell(ci, Y3 + 2.4, Y3 + 3.6));

  // ================================================================ what is in it
  const few = [1, 0.6, 0.35][tier];
  const jar = (u: number, y: number, v: number): void => {
    const r = b.r(0.24, 0.34);
    const h = b.r(0.5, 0.75);
    const k = b.r(0.75, 1);
    if (b.rng() < 0.5) b.color(0.85 * k, 0.62 * k, 0.45 * k, 2);
    else b.color(0.9 * k, 0.86 * k, 0.8 * k, 1);
    if (b.rng() < 0.2) {
      b.cyl(u, y + r, v, r, h, { top: 0.6, rx: Math.PI / 2, sides: 7 });
      return;
    }
    b.cyl(u, y, v, r * 0.8, h * 0.65, { top: 1.25, sides: 7 });
    b.cyl(u, y + h * 0.65, v, r, h * 0.35, { top: 0.5, sides: 7 });
  };
  /** A millstone door stood beside a doorway: a disc on edge, its axis along the passage. */
  const millstone = (u: number, y: number, v: number, alongU: boolean): void => {
    b.color(0.95, 0.93, 0.88, 1);
    const sides = tier === 2 ? 8 : 12;
    if (alongU) b.cyl(u - 0.16, y + 0.95, v, 0.95, 0.32, { rz: -Math.PI / 2, sides });
    else b.cyl(u, y + 0.95, v - 0.16, 0.95, 0.32, { rx: Math.PI / 2, sides });
    b.color(0.6, 0.58, 0.54, 1);
    if (alongU) b.cyl(u - 0.2, y + 0.95 - 0.16, v, 0.16, 0.4, { rz: -Math.PI / 2, sides: 6 });
    else b.cyl(u, y + 0.95 - 0.16, v - 0.2, 0.16, 0.4, { rx: Math.PI / 2, sides: 6 });
  };
  /** A niche cut into the first wall met going (du, dv) from a point in a passage. Its place, or null. */
  const niche = (pu: number, pv: number, y: number, du: number, dv: number): number[] | null => {
    for (let k = 1; k <= 4; k++) {
      const u = pu + du * k * cu;
      const v = pv + dv * k * cv;
      if (g.isAir(u, y + 1.4, v)) continue;
      const u2 = u + du * cu;
      const v2 = v + dv * cv;
      if (!rock(Math.min(u, u2) - 0.2, Math.min(v, v2) - 0.2, Math.max(u, u2) + 0.2, Math.max(v, v2) + 0.2, y + 0.2, y + 2.7)) return null;
      const ci = g.cell(u, v);
      if (ci < 0) return null;
      const keep = g.roughNow;
      g.roughNow = 0.04;
      g.carveCell(ci, y + 0.9, y + 2.0);
      g.roughNow = keep;
      return [u, v];
    }
    return null;
  };
  /** A lamp in a niche beside a point in a passage, or on the floor by the wall if no niche can be cut. */
  const wallLamp = (pu: number, pv: number, y: number, alongU: boolean, key: number, reach: number, strength: number): void => {
    const first = h01(key, 50) < 0.5 ? 1 : -1;
    for (const sd of [first, -first]) {
      const du = alongU ? 0 : sd;
      const dv = alongU ? sd : 0;
      const at2 = niche(pu, pv, y, du, dv);
      if (at2) {
        b.lamp(at2[0] - du * 0.22, y + 1.4, at2[1] - dv * 0.2, { reach, strength, size: 0.8 });
        return;
      }
    }
    b.lamp(pu + (alongU ? 0 : first * 0.9), y + 0.5, pv + (alongU ? first * 0.8 : 0), { reach, strength, size: 0.8 });
  };
  /** A carved slab, its marks still holding a little light. Thin along u. */
  const slab = (u: number, y: number, v: number): void => {
    const h = b.r(1.6, 2.1);
    const k = b.r(0.85, 1);
    b.color(k, k * 0.98, k * 0.94, 1);
    b.box(u, y, v, 0.3, h, 1.05);
    b.color(0.42, 0.42, 0.42, 4);
    for (const face of [-1, 1]) {
      for (let row = 0; row < 3; row++) {
        const yy = y + 0.55 + row * 0.4;
        if (yy > y + h - 0.35) break;
        for (let q = -1; q <= 1; q++) {
          if (b.rng() < 0.3) continue;
          const tall = b.rng() < 0.3;
          b.box(u + face * 0.16, yy, v + q * 0.3, 0.05, tall ? 0.28 : 0.07, tall ? 0.07 : b.r(0.12, 0.24));
        }
      }
    }
    b.glow(u, y + 1, v, 1.5, [0.08, 0.26, 0.22]);
  };

  // ---- doors and what the chambers hold
  let litRooms = 0;
  for (const n of chambers) {
    if (!n.alive || n.room === R_JUNCTION) continue;
    const y = Y[n.l];
    const key = nodeKey(n.l, n.i, n.j);
    const o = n.adj[0];
    // the one way in comes along the lattice from its neighbour
    const alongU = o.j === n.j && o.l === n.l;
    const dir = alongU ? Math.sign(o.u - n.u) || 1 : Math.sign(o.v - n.v) || 1;
    const dd = (alongU ? n.ra : n.rb) + (alongU ? 1 : cv);
    setPaint(n.l);
    g.roughNow = 0.06;
    if (n.adj.length !== 1) {
      // (a chamber made of a junction has no one door)
    } else if (alongU) {
      const ud = midU(n.u + dir * dd);
      g.each(ud - 0.5, n.v - 1.5 * cv, ud + 0.5, n.v + 1.5 * cv, (ci) => g.fillCell(ci, y + 2.25, y + 3.6));
      if (h01(key, 51) < 0.55) millstone(ud + dir * 0.9, y, n.v + (h01(key, 52) < 0.5 ? 1 : -1) * (1.5 * cv + 0.3), true);
    } else {
      const vd = midV(n.v + dir * dd);
      g.each(n.u - 1.5, vd - 0.45, n.u + 1.5, vd + 0.45, (ci) => g.fillCell(ci, y + 2.25, y + 3.6));
      if (h01(key, 51) < 0.55) millstone(n.u + (h01(key, 52) < 0.5 ? 1 : -1) * 1.8, y, vd + dir * 0.85, false);
    }
    // a place against the wall, at an angle round from the door's opposite
    const spot = (ang: number, f: number): number[] => {
      const base = alongU ? (dir > 0 ? Math.PI : 0) : dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      const a = base + ang;
      return [n.u + Math.cos(a) * (n.ra - 0.4) * f, n.v + Math.sin(a) * (n.rb - 0.4) * f, a];
    };
    if (n.room === R_STORE) {
      const cnt = Math.ceil((5 + 5 * h01(key, 53)) * few);
      for (let q = 0; q < cnt; q++) {
        const p = spot(b.r(-2.1, 2.1), b.r(0.62, 0.82));
        jar(p[0], y, p[1]);
      }
    } else if (n.room === R_STABLE) {
      for (const ang of [0, 1.45, -1.45]) {
        if (ang !== 0 && h01(key, 54 + ang) < 0.35) continue;
        const p = spot(ang, 0.78);
        b.color(0.9, 0.88, 0.82, 1);
        b.box(p[0], y, p[1], 0.6, 0.55, 1.9, -p[2], { solid: true });
        b.color(0.5, 0.48, 0.44, 1);
        b.box(p[0], y + 0.55, p[1], 0.36, 0.04, 1.6, -p[2]);
      }
      const p = spot(0.7, 0.45);
      b.color(0.55, 0.42, 0.3, 2);
      b.cyl(p[0], y, p[1], 0.07, 1.1, { sides: 5 });
    } else if (n.room === R_CHAPEL) {
      const p = spot(0, 0.62);
      b.color(0.95, 0.93, 0.88, 1);
      b.box(p[0], y, p[1], 0.9, 0.85, 0.9, 0, { solid: true });
      if (litRooms < [5, 4, 2][tier]) {
        litRooms++;
        b.lamp(p[0], y + 1.35, p[1], { reach: 10, strength: 0.8, size: 0.8 });
      }
      if (spec.carvings && h01(key, 56) < 0.5) {
        const q = spot(1.2, 0.7);
        slab(q[0], y, q[1]);
      }
    } else if (n.room === R_VEIN) {
      const cnt = [16, 12, 8][tier];
      for (let q = 0; q < cnt; q++) {
        const ang = -2.2 + (4.4 * (q + b.rng() * 0.6)) / cnt;
        const p = spot(ang, b.r(0.88, 1.02));
        const k = b.r(0.65, 1.1);
        b.color(k, k, k, 4);
        b.cone(p[0], y + b.r(0.1, 1.9), p[1], b.r(0.16, 0.36), b.r(0.5, 1.3), { rx: Math.sin(p[2]) * -b.r(0.5, 1.1), rz: Math.cos(p[2]) * b.r(0.5, 1.1), sides: 4 });
      }
      for (let q = 0; q < 5; q++) {
        const p = spot(b.r(-1.2, 1.2), b.r(0.3, 0.7));
        const k = b.r(0.6, 1.05);
        b.color(k, k, k, 4);
        b.cone(p[0], y, p[1], b.r(0.14, 0.3), b.r(0.4, 1.1), { rx: b.r(-0.3, 0.3), rz: b.r(-0.3, 0.3), sides: 4 });
      }
      b.light(n.u, y + 1.8, n.v, 13, 0.9, TEAL);
      b.glow(n.u, y + 1.6, n.v, 5, [0.2, 0.62, 0.54]);
      const p = spot(0, 0.9);
      b.glow(p[0], y + 1.2, p[1], 2.2, [0.22, 0.7, 0.6]);
    }
  }

  // ---- the lit way: lamps in niches from the foot of the stair to the ledge
  {
    const way: number[][] = [];
    const add = (pts: number[][], rev = false): void => {
      const p = rev ? pts.slice().reverse() : pts;
      for (let k = 0; k + 1 < p.length; k++) way.push([p[k][0], p[k][1], p[k + 1][0], p[k + 1][1]]);
    };
    if (entryLegs.length > 0) add(entryLegs[0]);
    for (let k = 0; k + 1 < route.length; k++) {
      const a = route[k];
      const c = route[k + 1];
      const lowFirst = a.i < c.i || a.j < c.j;
      const e0 = lowFirst ? a : c;
      const e1 = lowFirst ? c : a;
      const ax = a.j === c.j ? 0 : 1;
      add(leg(e0.u, e0.v, e1.u, e1.v, ax === 0, edgeKey(0, e0.i, e0.j, ax)), !lowFirst);
    }
    if (m0 && m0.node.alive) add(m0.pts, true);
    b.lamp(9, Y0 + 0.5, -1.35, { reach: 10, strength: 0.8, size: 0.8 });
    let since = 9;
    let next = 13;
    let k = 0;
    let vented = false;
    for (const w of way) {
      const len = Math.abs(w[2] - w[0]) + Math.abs(w[3] - w[1]);
      const alongU = Math.abs(w[2] - w[0]) >= Math.abs(w[3] - w[1]);
      const du = Math.sign(w[2] - w[0]);
      const dv = Math.sign(w[3] - w[1]);
      for (let t = 0.5; t < len; t += 1) {
        since += 1;
        if (since < next || t < 2.5 || t > len - 2.5) continue;
        const pu = midU(w[0] + du * t);
        const pv = midV(w[1] + dv * t);
        if (!g.isAir(pu, Y0 + 1, pv)) continue;
        wallLamp(pu, pv, Y0, alongU, 7000 + k, 11, 0.85);
        k++;
        since = 0;
        next = 12 + 6 * h01(7100 + k);
      }
      // one vent on the way lets a little day down
      if (!vented && len > 14 && w[0] > 30 && tier < 2) {
        const pu = edgeU(w[0] + du * len * 0.5);
        const pv = edgeV(w[1] + dv * len * 0.5);
        if (g.isAir(pu + 0.5, Y0 + 1, pv + 0.45) && g.isAir(pu - 0.5, Y0 + 1, pv - 0.45)) {
          b.skyShaft(pu, pv, 1.1, 0.5);
          vented = true;
        }
      }
    }
    if (spec.carvings) {
      slab(entry.u + 1.6, Y0, entry.v + 1.5);
      for (const n of route) slab(n.u + (h01(n.i, 60) < 0.5 ? 1.5 : -1.5), Y0, n.v + (h01(n.j, 61) < 0.5 ? 1.4 : -1.4));
    }
  }

  // ---- the shaft's lamps: the ledge, every landing, the floor
  {
    b.lamp(uA + 0.5, Y0 + 0.5, vWall(s) - s * 0.45, { reach: 15, strength: 0.9 });
    b.lamp(uA + 5.5, Y0 + 0.5, vWall(s) - s * 0.45, { reach: 18 });
    b.lamp(uA + 5.5, Y0 + 0.5, vWall(s) - s * 4.95, { reach: 18 });
    for (let f = 1; f < 6; f++) {
      const r = cornerRect(f % 4);
      const far = f % 4 === 2 || f % 4 === 3;
      const sg = f % 4 === 0 || f % 4 === 3 ? s : -s;
      const y = Y0 - (f * D) / 2;
      const level = f % 2 === 0;
      if (!level && tier === 2 && f !== 3) continue;
      b.lamp(far ? r[2] - 0.5 : r[0] + 0.5, y + 0.5, vWall(sg) - sg * 0.45, level ? { reach: 18 } : { reach: 12, strength: 0.75, size: 0.8 });
    }
    for (const m of liveMouths) {
      if (!m.balcony || h01(m.l * 8 + m.wall, 62) < 0.4) continue;
      // a small lamp on some of the sills, so the walls read as lived in
      const y = Y[m.l];
      if (m.wall < 2) b.lamp(m.wall === 0 ? uA + 1.5 : uB - 1.5, y + 0.5, m.lat + 1.6 * cv, { reach: 9, strength: 0.6, size: 0.7 });
      else b.lamp(m.lat + 1.9, y + 0.5, m.wall === 2 ? vLo + 1.5 * cv : vHi - 1.5 * cv, { reach: 9, strength: 0.6, size: 0.7 });
    }
    // braziers either side of the chapel's door
    for (const sg of [-1, 1]) {
      const bu = uB - 1.6;
      const bv = vc + sg * 3.4;
      b.color(0.95, 0.93, 0.88, 1);
      b.cyl(bu, Y3, bv, 0.5, 1.0, { solid: true });
      b.cyl(bu, Y3 + 1.0, bv, 0.55, 0.4, { top: 1.5 });
      b.lamp(bu, Y3 + 1.9, bv, { reach: 26, strength: 1.3, size: 2, body: false });
    }
    millstone(uC0 - 2.6, Y3, vc + 1.5 * cv + 0.3, true);
    if (spec.carvings) {
      slab(uA + 3.4, Y0, vWall(s) - s * 0.35);
      slab(uB - 4.5, Y3, vc + 5.2);
      slab(uB - 4.5, Y3, vc - 5.2);
    }
    // rubble at the foot of the walls
    for (let q = 0; q < [9, 6, 3][tier]; q++) {
      const sz = b.r(0.6, 1.6);
      const k = b.r(0.82, 1);
      b.color(k, k * 0.97, k * 0.92, 1);
      b.box(b.r(uA + 5, uB - 6), Y3 - sz * 0.12, vWall(s) - s * b.r(1, 4.5), sz * b.r(0.8, 1.4), sz * b.r(0.5, 0.9), sz, b.r(0, 3), { rx: b.r(-0.2, 0.2), rz: b.r(-0.2, 0.2) });
    }
  }

  // ---- the chapel's furnishing
  let relic: Pt | null = null;
  {
    b.color(0.95, 0.93, 0.88, 1);
    b.box(uX, Y3, vc, 2.4, 0.4, 2.4, 0, { solid: true });
    b.cyl(uX, Y3 + 0.4, vc, 0.62, 0.75);
    b.cyl(uX, Y3 + 1.15, vc, 0.48, 0.14);
    if (spec.relic) relic = [uX, Y3 + 1.6, vc];
    for (const sg of [-1, 1]) {
      const bv = vc + sg * 7.2;
      b.color(0.95, 0.93, 0.88, 1);
      b.cyl(uX, Y3, bv, 0.55, 1.1, { solid: true });
      b.cyl(uX, Y3 + 1.1, bv, 0.6, 0.45, { top: 1.5 });
      b.lamp(uX, Y3 + 2.1, bv, { reach: 24, strength: 1.3, size: 2.2, body: false });
      b.lamp(uC0 + 1.5, Y3 + 0.5, vc + sg * 3.3, { reach: 11, strength: 0.7, size: 0.8 });
    }
    // the altar in the apse
    b.color(0.97, 0.95, 0.9, 1);
    b.box(uC1 + 2.5, Y3 + 0.4, vc, 1, 0.95, 2.2, 0, { solid: true });
    b.lamp(uC1 + 2.5, Y3 + 1.85, vc, { reach: 15, strength: 0.9 });
    if (tier < 2) {
      // half columns down the nave
      const top = hC * 0.42;
      for (let q = 0; q < 5; q++) {
        const pu = uC0 + 3.5 + q * 5.6;
        if (Math.abs(pu - uX) < 5) continue;
        for (const sg of [-1, 1]) {
          b.color(0.97, 0.95, 0.9, 1);
          b.cyl(pu, Y3, vc + sg * 4.05, 0.42, top, { sides: 8 });
          b.box(pu, Y3 + top, vc + sg * 4.05, 1.1, 0.3, 1.1);
        }
      }
    }
    for (const sg of [-1, 1]) {
      // benches cut along the walls
      b.color(0.9, 0.88, 0.83, 1);
      b.box(uC0 + 7, Y3, vc + sg * 3.55, 6, 0.45, 0.7);
      b.box(uC1 - 5, Y3, vc + sg * 3.55, 6, 0.45, 0.7);
      if (spec.carvings) slab(uC1 + 0.4, Y3 + 0.4, vc + sg * 2.6);
      for (let q = 0; q < Math.ceil(3 * few); q++) jar(uX + b.r(-2.2, 2.2), Y3, vc + sg * (TL - 0.9 - b.r(0, 1.2)));
    }
  }

  // ---- side rooms off the passages, small and dark, through a low door
  setPaint(0);
  const sideP = [0.34, 0.24, 0.1][tier];
  for (const sg of segs) {
    if (!sg.maze || (sg.key & 3) !== 0 || h01(sg.key, 70) > sideP) continue;
    const y = Y[sg.l];
    const alongU = Math.abs(sg.bu - sg.au) >= Math.abs(sg.bv - sg.av);
    const len = Math.abs(sg.bu - sg.au) + Math.abs(sg.bv - sg.av);
    if (len < 12) continue;
    const dir = alongU ? Math.sign(sg.bu - sg.au) : Math.sign(sg.bv - sg.av);
    const t = 7.5 + h01(sg.key, 71) * (len - 11.5);
    const sd = h01(sg.key, 72) < 0.5 ? 1 : -1;
    const kind = h01(sg.key, 73);
    setPaint(sg.l);
    if (alongU) {
      const pu = edgeU(sg.au + dir * t);
      const va = sg.av + sd * 4.5 * cv;
      const vb = sg.av + sd * 10.5 * cv;
      if (!rock(pu - 4.2, Math.min(va, vb) - 0.3, pu + 4.2, Math.max(va, vb) + 1.2, y - 1.2, y + 4.2)) continue;
      g.roughNow = 0.06;
      g.carveBox(pu - 1, Math.min(sg.av, va), pu + 1, Math.max(sg.av, va), y, y + 2.3);
      g.roughNow = 0.12;
      g.carveBox(pu - 3, Math.min(va, vb), pu + 3, Math.max(va, vb), y, y + 2.8);
      const vm = (va + vb) / 2;
      if (kind < 0.45) for (let q = 0; q < Math.ceil(5 * few); q++) jar(pu + b.r(-2.4, 2.4), y, vb - sd * b.r(0.5, 1.4));
      else if (kind < 0.7) {
        b.color(0.9, 0.88, 0.82, 1);
        b.box(pu, y, vb - sd * 0.5, 2.4, 0.5, 0.6, 0, { solid: true });
      } else if (kind > 0.93) b.lamp(pu + 2.4, y + 0.5, vm, { reach: 8, strength: 0.6, size: 0.7 });
    } else {
      const pv = edgeV(sg.av + dir * t);
      const ua = sg.au + sd * 4.5;
      const ub = sg.au + sd * 10.5;
      if (!rock(Math.min(ua, ub) - 0.3, pv - 4.2, Math.max(ua, ub) + 1.2, pv + 4.2, y - 1.2, y + 4.2)) continue;
      g.roughNow = 0.06;
      g.carveBox(Math.min(sg.au, ua), pv - cv, Math.max(sg.au, ua), pv + cv, y, y + 2.3);
      g.roughNow = 0.12;
      g.carveBox(Math.min(ua, ub), pv - 3 * cv, Math.max(ua, ub), pv + 3 * cv, y, y + 2.8);
      const um = (ua + ub) / 2;
      if (kind < 0.45) for (let q = 0; q < Math.ceil(5 * few); q++) jar(ub - sd * b.r(0.5, 1.4), y, pv + b.r(-2.2, 2.2));
      else if (kind < 0.7) {
        b.color(0.9, 0.88, 0.82, 1);
        b.box(ub - sd * 0.5, y, pv, 0.6, 0.5, 2.4, 0, { solid: true });
      } else if (kind > 0.93) b.lamp(um, y + 0.5, pv + 2.2, { reach: 8, strength: 0.6, size: 0.7 });
    }
  }

  // ---- empty niches in the walls, and vents cut up into the rock
  let vents = 0;
  let skyDeep = tier < 2 ? 1 : 0;
  for (const sg of segs) {
    if (!sg.maze) continue;
    const y = Y[sg.l];
    const alongU = Math.abs(sg.bu - sg.au) >= Math.abs(sg.bv - sg.av);
    const len = Math.abs(sg.bu - sg.au) + Math.abs(sg.bv - sg.av);
    if (len < 8) continue;
    const du = Math.sign(sg.bu - sg.au);
    const dv = Math.sign(sg.bv - sg.av);
    setPaint(sg.l);
    if (h01(sg.key, 80) < 0.3 * few + 0.1) {
      const t = 3 + h01(sg.key, 81) * (len - 6);
      const pu = midU(sg.au + du * t);
      const pv = midV(sg.av + dv * t);
      const sd = h01(sg.key, 82) < 0.5 ? 1 : -1;
      if (g.isAir(pu, y + 1, pv)) niche(pu, pv, y, alongU ? 0 : sd, alongU ? sd : 0);
    }
    if (sg.l > 0 && vents < [9, 6, 2][tier] && h01(sg.key, 83) < 0.1) {
      const t = 3 + h01(sg.key, 84) * (len - 6);
      const pu = edgeU(sg.au + du * t);
      const pv = edgeV(sg.av + dv * t);
      if (!g.isAir(pu + 0.5, y + 1, pv + 0.45) || !g.isAir(pu - 0.5, y + 1, pv - 0.45)) continue;
      // one of them, on the second level, goes all the way up to the day
      const sky = skyDeep > 0 && sg.l === 1;
      const top = sky ? lid - 2.6 : y + 3.4 + 4 + 4 * h01(sg.key, 85);
      if (!rock(pu - 2.4, pv - 2.4, pu + 2.4, pv + 2.4, y + 3.9, sky ? lid + 2 : top + 1.6)) continue;
      g.roughNow = 0.12;
      g.carveCyl(pu, pv, 1.1, y + 2.2, top);
      vents++;
      if (sky) {
        b.skyShaft(pu, pv, 1.1, 0.5);
        skyDeep--;
      }
    }
  }

  // ---- wells: a round hole from a chamber down through the level below, or two
  let wells = 0;
  {
    const cands = chambers.filter((n) => n.alive && n.l < NL - 1 && (n.room === R_CELL || n.room === R_STORE || n.room === R_STABLE));
    cands.sort((x, y) => h01(nodeKey(x.l, x.i, x.j), 90) - h01(nodeKey(y.l, y.i, y.j), 90));
    for (const n of cands) {
      if (wells >= [3, 2, 1][tier]) break;
      const wu = n.u + 0.5 * cu;
      const wv = n.v + 0.5 * cv;
      let deep = n.l + 2 < NL && h01(nodeKey(n.l, n.i, n.j), 91) < 0.6 ? n.l + 2 : n.l + 1;
      const plans: { l: number; pts: number[][] }[] = [];
      for (let m = n.l + 1; m <= deep; m++) {
        let pts: number[][] | null = null;
        if (rock(n.u - 4.6, n.v - 4.4, n.u + 4.6, n.v + 4.4, Y[m] - 1.5, Y[m] + 4.4) && rock(wu - 2.2, wv - 2.2, wu + 2.2, wv + 2.2, Y[m] + 4.4, Y[m - 1] - 1.2)) {
          // a spur from the room at this level to the nearest junction that can be reached cleanly
          let bd = 46;
          for (const t of nodes[m]) {
            if (!t.alive) continue;
            const d = Math.abs(t.u - n.u) + Math.abs(t.v - n.v);
            if (d >= bd || d < 7) continue;
            const alongU = Math.abs(t.u - n.u) >= Math.abs(t.v - n.v);
            const cand = leg(n.u, n.v, t.u, t.v, alongU, nodeKey(m, t.i, t.j) + 77, 4.5, 4.5);
            let ok = true;
            for (let k = 0; k + 1 < cand.length && ok; k++) {
              const u0 = Math.min(cand[k][0], cand[k + 1][0]) - 2.2;
              const v0 = Math.min(cand[k][1], cand[k + 1][1]) - 2.2;
              const u1 = Math.max(cand[k][0], cand[k + 1][0]) + 2.2;
              const v1 = Math.max(cand[k][1], cand[k + 1][1]) + 2.2;
              if (reserved(m, u0, v0, u1, v1, 2) || hitsStair(u0, v0, u1, v1, Y[m] - 0.6, Y[m] + 3.6)) ok = false;
            }
            if (ok) {
              bd = d;
              pts = cand;
            }
          }
        }
        if (!pts) {
          deep = m - 1;
          break;
        }
        plans.push({ l: m, pts });
      }
      if (deep <= n.l) continue;
      for (const p of plans) {
        setPaint(p.l);
        g.roughNow = 0.12;
        room(n.u, n.v, 3.5, 3.5 * cv, Y[p.l], 3.3);
        g.roughNow = 0.1;
        path(p.l, p.pts, 2.8, 8000 + wells * 16 + p.l, false);
      }
      setPaint(deep);
      g.roughNow = 0.1;
      g.carveBox(wu - cu, wv - cv, wu + cu, wv + cv, Y[deep] - 0.4, Y[n.l] + 0.2);
      g.pool(wu - cu, wv - cv, wu + cu, wv + cv, Y[deep] - 0.08);
      for (let m = n.l; m < deep; m++) {
        // a low rim
        b.color(0.95, 0.93, 0.88, 1);
        b.box(wu, Y[m], wv - cv - 0.18, 2 * cu + 0.72, 0.5, 0.36);
        b.box(wu, Y[m], wv + cv + 0.18, 2 * cu + 0.72, 0.5, 0.36);
        b.box(wu - cu - 0.18, Y[m], wv, 0.36, 0.5, 2 * cv);
        b.box(wu + cu + 0.18, Y[m], wv, 0.36, 0.5, 2 * cv);
      }
      n.room = R_WELL;
      wells++;
    }
  }

  // ---- marks
  const levelPts: Pt[] = [];
  for (let l = 0; l < NL; l++) {
    let best: Node | null = null;
    for (const n of nodes[l]) if (n.alive && n.room !== R_WELL && (!best || n.depth > best.depth)) best = n;
    if (best) levelPts.push([best.u, Y[l], best.v]);
  }
  let count = 0;
  for (const row of nodes) for (const n of row) if (n.alive) count++;
  const info: LabyrinthInfo = {
    levels: Y.slice(),
    shaft: { u0: uA, v0: vLo, u1: uB, v1: vHi, floor: Y3, roof: yRoof },
    foot: [uS, Y3, midV(vS)],
    levelPts,
    vein: veinNode && veinNode.room === R_VEIN ? [veinNode.u, Y[veinNode.l], veinNode.v] : null,
    nodes: count,
    metres,
    stairs: liveStairs.length,
    wells,
    links: [
      ...liveEdges.map((e) => ({ kind: 'passage', a: [e.a.u, Y[e.a.l], e.a.v] as Pt, b: [e.b.u, Y[e.b.l], e.b.v] as Pt })),
      ...liveStairs.map((st) => ({ kind: 'stair', a: [st.a.u, Y[st.a.l], st.a.v] as Pt, b: [st.b.u, Y[st.b.l], st.b.v] as Pt })),
      ...liveMouths.map((m) => ({ kind: 'mouth', a: [m.node.u, Y[m.l], m.node.v] as Pt, b: [m.pts[0][0], Y[m.l], m.pts[0][1]] as Pt })),
    ],
  };
  const built = b.finish({ ledge: [uA + 4.5, Y0, vWall(s) - s * 2.5 * cv], centre: [uX - 2.5, Y3, vc], relic });
  return Object.assign(built, { labyrinth: info });
}
