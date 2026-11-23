// The lived-in warren: a settlement cut into rounded rock, left with its lamps burning. The stair
// from the hole runs into a short dark passage that opens on a high ledge over the great commons:
// a cavern forty-odd metres tall with rock pillars left standing in it, a great lamp hung over a
// table and a rug at its middle, galleries ringing its walls at three heights and stairs winding
// up between them. Wide passages lead on to two or three smaller halls (a cistern hall with its
// pools, a market, a sleeping hall), each with a gallery of its own, and everywhere the walls
// are full of alcove rooms, one above another.
//
// Laid out along u: hole, passage (one turn), the commons, a hall beyond it, another beyond that;
// often a third off to one side. Up and down: four levels a dozen metres apart. Level 0 is every
// hall's floor, level 1 every hall's gallery (and the passages that join them, running over the
// wide ones below), levels 2 and 3 are the commons' alone, and the ledge is on level 3.
//
// Order of work: plan everything (halls, passages, stairs, pillars, rooms), carve it all, then
// put rock back (stairs, bridges, the lookout), then dress it. Carving after filling would cut
// the stairs.

import type { DeepSpec } from './types';
import { DeepBuilder, TEAL, mulberry32, type DeepData } from './builder';
import type { Pt } from './spans';

/** What was built where, in the deep's own frame ([u, y, v]): for checks. */
export interface WarrenLayout {
  /** The commons first. role: 0 commons, 1 cistern, 2 market, 3 sleeping. */
  halls: { role: number; u: number; v: number; a: number; b: number; floor: number; top: number }[];
  /** Points on each gallery, by hall and level (1..3). */
  galleries: { hall: number; level: number; pts: [number, number, number][] }[];
  rooms: [number, number, number][];
  /** Middles of the bridges. */
  bridges: [number, number, number][];
  /** Pools: [u, water level, v, radius]. */
  pools: [number, number, number, number][];
  /** Heads of the stair flights. */
  flights: [number, number, number][];
  /** The end of the dark back passage, if there is one. */
  back: [number, number, number] | null;
}

/** The layout of a deep built by buildWarren: left on it by the build (see DeepData.extra), for checks. */
export function warrenLayout(d: object): WarrenLayout | undefined {
  return (d as { warren?: WarrenLayout }).warren;
}

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

const TAU = Math.PI * 2;
/** The turn that lays a box's long (local u) side along (du, dv). */
const rotOf = (du: number, dv: number): number => Math.atan2(-dv, du);

interface Flight {
  /** Runs along u (against a wall on the +v or -v side) or along v. */
  axisU: boolean;
  /** Which way the wall is from the hall's middle, and which way the flight climbs. */
  sgn: number;
  dir: number;
  /** Foot, along its axis; length; rise. */
  t0: number;
  L: number;
  y0: number;
  y1: number;
  /** Its edge on the hall's side. */
  inner: number;
  cap0: number;
  cap1: number;
  /** Built up from the floor, or a slab hung along the wall. */
  solid: boolean;
  rect: [number, number, number, number];
}

interface Hall {
  role: number;
  u: number;
  v: number;
  /** Half its size along u and v, and how square its outline is. */
  a: number;
  b: number;
  p: number;
  amp: number;
  p1: number;
  p2: number;
  p3: number;
  /** Its radius and the lean of its wall, by angle. */
  rt: Float32Array;
  lt: Float32Array;
  floor: number;
  /** Height of its roof over the floor, in the middle and at the walls. */
  top: number;
  wallH: number;
  /** Depth and height of its galleries, and their floors. */
  GW: number;
  GH: number;
  levels: number[];
  mouths: { u: number; v: number; th: number; w: number }[];
  flights: Flight[];
  pillars: { u: number; v: number; r: number; ph: number; th: number }[];
  pools: { u: number; v: number; r: number }[];
}

interface Seg {
  au: number;
  av: number;
  bu: number;
  bv: number;
  hw: number;
  y0: number;
  y1: number;
}

interface Room {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  y: number;
  /** Where its door comes out. */
  tu: number;
  tv: number;
  hall: Hall;
  lvl: number;
  /** Planned, but left uncut on the lowest tier. */
  skip: boolean;
}

export function buildWarren(spec: DeepSpec): DeepData {
  const tier = spec.tier;
  const lid = spec.lid;
  // the shape of the place comes from a generator of its own, so every tier builds the same warren
  const rnd = mulberry32(Math.imul(spec.seed | 0, 0x9e3779b1) ^ 0x3a77e9);
  const R = (a: number, b: number): number => a + (b - a) * rnd();
  const even = (x: number): number => Math.round(x / 2) * 2; // cell edges along u, at every tier
  const onV = (x: number): number => Math.round(x / 1.8) * 1.8; // and along v
  const ns = spec.seed | 0;
  const vnoise = (x: number, y: number): number => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = smooth(x - i);
    const fy = smooth(y - j);
    const a = hash2(i + ns, j);
    const b = hash2(i + 1 + ns, j);
    const c = hash2(i + ns, j + 1);
    const d = hash2(i + 1 + ns, j + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };

  // ---- heights: four levels hL apart, the top one ten metres under the roof
  const hL = R(11, 13.5);
  const Yc = lid - 1.5; // the commons' roof at its highest
  const yA = lid - 2.9; // foot of the stair down the hole (the builder's b.foot)
  const yL = Yc - 10; // the ledge: level 3
  const Yf = yL - 3 * hL; // every hall's floor
  const y1 = Yf + hL;
  const y2 = Yf + 2 * hL;
  const y3 = yL;
  const Yh = Yf - 0.4; // the hearth, sunk a step into the commons' floor

  const b = new DeepBuilder(spec, { cell: tier === 2 ? 2 : 1, yMin: Yf - 4, maxSpans: 6, wallStep: [3, 4, 5][tier] });
  const g = b.grid;

  // ---- halls: a rounded square with a wandering edge
  const rawRadius = (h: Hall, th: number): number => {
    const c = Math.abs(Math.cos(th)) / h.a;
    const s = Math.abs(Math.sin(th)) / h.b;
    const base = 1 / Math.pow(Math.pow(c, h.p) + Math.pow(s, h.p), 1 / h.p);
    return base * (1 + h.amp * (0.5 * Math.sin(3 * th + h.p1) + 0.3 * Math.sin(5 * th + h.p2) + 0.2 * Math.sin(7 * th + h.p3)));
  };
  // (both are asked for every cell of every hall, so they are read from tables)
  const NT = 1024;
  const look = (tab: Float32Array, th: number): number => {
    let x = (th * NT) / TAU;
    x -= Math.floor(x / NT) * NT;
    const i = Math.floor(x);
    return tab[i] + (tab[i + 1] - tab[i]) * (x - i);
  };
  /** How far a hall's wall is from its middle, the way th. */
  const radius = (h: Hall, th: number): number => look(h.rt, th);
  /** How much shorter a step straight at the wall is than one along the ray from the middle. */
  const lean = (h: Hall, th: number): number => look(h.lt, th);
  /** About how far inside a hall's wall a point is (negative: that far into the rock). */
  const sdist = (h: Hall, u: number, v: number): number => {
    const du = u - h.u;
    const dv = v - h.v;
    const th = Math.atan2(dv, du);
    const s = radius(h, th) - Math.hypot(du, dv);
    return s > 20 || s < -20 ? s : s * lean(h, th);
  };
  const at = (h: Hall, th: number, ds: number): [number, number] => {
    const r = radius(h, th) + ds;
    return [h.u + Math.cos(th) * r, h.v + Math.sin(th) * r];
  };
  const newHall = (role: number, a: number, bb: number, top: number): Hall => {
    const p = R(2.8, 3.6);
    const amp = R(0.06, 0.1);
    const p1 = R(0, TAU);
    const p2 = R(0, TAU);
    const p3 = R(0, TAU);
    const h: Hall = {
      role, u: 0, v: 0, a, b: bb, p, amp, p1, p2, p3, floor: Yf, top, rt: new Float32Array(NT + 1), lt: new Float32Array(NT + 1),
      wallH: role === 0 ? top - 7 : Math.max(top - 7, hL + 5.6),
      GW: role === 0 ? 4.5 : 3.6, GH: role === 0 ? 3.6 : 3.2,
      levels: role === 0 ? [y1, y2, y3] : [y1],
      mouths: [], flights: [], pillars: [], pools: [],
    };
    for (let i = 0; i <= NT; i++) h.rt[i] = rawRadius(h, (i / NT) * TAU);
    for (let i = 0; i <= NT; i++) {
      const dr = (h.rt[(i + 3) % NT] - h.rt[(i + NT - 3) % NT]) / ((6 / NT) * TAU);
      h.lt[i] = 1 / Math.sqrt(1 + (dr / h.rt[i]) * (dr / h.rt[i]));
    }
    return h;
  };

  // ---- the way in: stair, then a passage with one turn in it, unlit
  const PW = 3.6;
  const PH = 2.5;
  const L1 = even(R(16, 22));
  const L3 = even(R(16, 22));
  const C = newHall(0, R(30, 43), R(30, 43), Yc - Yf);
  let vP: number;
  {
    const M = 17; // room for the commons' galleries and the rooms behind them
    const lo = Math.ceil((spec.v0 + C.b * (1 + C.amp) + M) / 1.8) * 1.8;
    const hi = Math.floor((spec.v1 - C.b * (1 + C.amp) - M) / 1.8) * 1.8;
    const want = (rnd() < 0.5 ? -1 : 1) * onV(R(9, 16));
    const ok = (x: number): boolean => x >= lo - 1e-6 && x <= hi + 1e-6;
    if (ok(want)) vP = want;
    else if (ok(-want)) vP = -want;
    else if (ok(0)) vP = 0;
    else vP = lo > 0 ? Math.max(lo, 7.2) : Math.min(hi, -7.2);
  }
  const Lv = Math.abs(vP);
  const uT = 4 + L1 + 2; // the middle of the cross leg
  const uH0 = uT + 2 + L3; // the commons' near wall
  const uE = uH0 - 8; // where the passage levels out: before the gallery, so there is no step back up
  C.v = vP;
  C.u = uH0 + radius(C, Math.PI);
  // it comes down as three flights of shallow steps, level where it turns
  const S1 = Lv > 0 ? uT - 2 - 4 : uE - 4;
  const S2 = Lv > 0 ? Lv - 3.6 : 0;
  const S3 = Lv > 0 ? uE - (uT + 2) : 0;
  const hT1 = yA + ((yL - yA) * S1) / (S1 + S2 + S3);
  const hT2 = yA + ((yL - yA) * (S1 + S2)) / (S1 + S2 + S3);
  const segs: Seg[] = [];
  segs.push({ au: 4, av: 0, bu: uT, bv: 0, hw: PW / 2 + 0.5, y0: yL, y1: yA + PH });
  segs.push({ au: uT, av: 0, bu: uT, bv: vP + 1e-3, hw: PW / 2 + 0.7, y0: yL, y1: yA + PH });
  segs.push({ au: uT, av: vP, bu: uH0 - 3, bv: vP, hw: PW / 2 + 0.5, y0: yL, y1: yA + PH });

  // ---- the smaller halls: two in a line beyond the commons, and often a third off to a side
  const small = (): Hall => {
    const a = R(16, 23);
    const bb = R(16, 23);
    return newHall(1, a, bb, Math.max(R(21, 30), hL + 9));
  };
  const H1 = small();
  const H3 = small();
  const HS = small();
  const fitsV = (h: Hall, m: number): boolean => h.v - h.b * (1 + h.amp) - m >= spec.v0 && h.v + h.b * (1 + h.amp) + m <= spec.v1;
  const fitsU = (h: Hall, m: number): boolean => h.u - h.a * (1 + h.amp) - m >= 0 && h.u + h.a * (1 + h.amp) + m <= spec.u1;
  const place = (h: Hall, from: Hall, th: number, gap: number): void => {
    const d = radius(from, th) + gap + radius(h, th + Math.PI);
    h.u = from.u + Math.cos(th) * d;
    h.v = from.v + Math.sin(th) * d;
  };
  {
    const farWall = R(238, Math.min(spec.u1 - 16, 330));
    let th1 = R(-0.4, 0.4);
    let th3 = th1 + R(-0.5, 0.5);
    for (let pass = 0; pass < 3; pass++) {
      place(H1, C, th1, 14);
      place(H3, H1, th3, 14);
      const extra = farWall - (H3.u + radius(H3, 0));
      const gap = Math.min(44, Math.max(14, 14 + extra / (Math.cos(th1) + Math.cos(th3))));
      place(H1, C, th1, gap);
      place(H3, H1, th3, gap);
      if (fitsV(H1, 10) && fitsV(H3, 10) && fitsU(H3, 9)) break;
      if (pass === 0) th3 = th1;
      else th1 = th3 = 0;
    }
  }
  /** Whether two halls keep `gap` metres of rock between them. */
  const apart = (x: Hall, y: Hall, gap: number): boolean => {
    for (let i = 0; i < 24; i++) {
      const th = (i / 24) * TAU;
      const p = at(x, th, 0);
      if (sdist(y, p[0], p[1]) > -gap) return false;
      const q = at(y, th, 0);
      if (sdist(x, q[0], q[1]) > -gap) return false;
    }
    return true;
  };
  const halls: Hall[] = [C, H1, H3];
  let sideFrom: Hall | null = null;
  if (rnd() < 0.75) {
    for (let t = 0; t < 12 && !sideFrom; t++) {
      const from = rnd() < 0.6 ? C : H1;
      const th = (rnd() < 0.5 ? -1 : 1) * R(1.05, 1.7);
      place(HS, from, th, R(16, 28));
      if (!fitsV(HS, 10) || !fitsU(HS, 10)) continue;
      if (!halls.every((o) => apart(HS, o, o === from ? 12 : 14))) continue;
      sideFrom = from;
    }
    if (sideFrom) halls.push(HS);
  }
  // who is what: a cistern hall always, then a market and a sleeping hall as there are halls for them
  {
    const roles = [1, 2, 3];
    for (let i = 2; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = roles[i];
      roles[i] = roles[j];
      roles[j] = t;
    }
    for (let i = 1; i < halls.length; i++) halls[i].role = roles[i - 1];
    if (!halls.some((h) => h.role === 1)) halls[2].role = 1;
  }
  const cistern = halls.find((h) => h.role === 1)!;

  // ---- passages: a wide one on the floor between each pair, and a narrow one over it at gallery height
  interface Link { a: Hall; b: Hall; au: number; av: number; bu: number; bv: number; th: number; w: number }
  const links: Link[] = [];
  const PHT = 5.6;
  const connect = (A: Hall, B: Hall): void => {
    const th = Math.atan2(B.v - A.v, B.u - A.u);
    const ra = radius(A, th);
    const rb = radius(B, th + Math.PI);
    const cu = Math.cos(th);
    const cv = Math.sin(th);
    const w = R(6, 8);
    const l: Link = { a: A, b: B, au: A.u + cu * (ra - 2.5), av: A.v + cv * (ra - 2.5), bu: B.u - cu * (rb - 2.5), bv: B.v - cv * (rb - 2.5), th, w };
    links.push(l);
    A.mouths.push({ u: A.u + cu * ra, v: A.v + cv * ra, th, w });
    B.mouths.push({ u: B.u - cu * rb, v: B.v - cv * rb, th: th + Math.PI, w });
    segs.push({ au: l.au, av: l.av, bu: l.bu, bv: l.bv, hw: w / 2, y0: Yf, y1: Yf + PHT });
    segs.push({ au: l.au, av: l.av, bu: l.bu, bv: l.bv, hw: 1.8, y0: y1, y1: y1 + 3.2 });
  };
  connect(C, H1);
  connect(H1, H3);
  if (sideFrom) connect(sideFrom, HS);

  // ---- a back passage: narrow, unlit, with a bend, ending in a small chamber
  const distSeg = (u: number, v: number, s: Seg): number => {
    const du = s.bu - s.au;
    const dv = s.bv - s.av;
    const t = Math.min(1, Math.max(0, ((u - s.au) * du + (v - s.av) * dv) / (du * du + dv * dv)));
    return Math.hypot(u - s.au - du * t, v - s.av - dv * t);
  };
  const inRoom = (u: number, v: number, m: number): boolean => u >= m && u <= spec.u1 - m && v >= spec.v0 + m && v <= spec.v1 - m;
  let back: { h: Hall; pts: [number, number][]; th: number } | null = null;
  {
    const from = sideFrom && rnd() < 0.4 ? HS : H3;
    const th0 = R(0, TAU);
    const bend = (rnd() < 0.5 ? -1 : 1) * R(0.5, 0.9);
    const la = R(14, 22);
    const lb = R(12, 20);
    for (let k = 0; k < 12 && !back; k++) {
      const th = th0 + (k * TAU) / 12;
      const p0 = at(from, th, -2);
      const p1 = at(from, th, la);
      const p2: [number, number] = [p1[0] + Math.cos(th + bend) * lb, p1[1] + Math.sin(th + bend) * lb];
      if (!inRoom(p1[0], p1[1], 9) || !inRoom(p2[0], p2[1], 11)) continue;
      const pm: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      if (halls.some((o) => [p1, pm, p2].some((q) => sdist(o, q[0], q[1]) > (o === from ? -9 : -18)))) continue;
      if (segs.some((s) => [p0, p1, pm, p2].some((q) => distSeg(q[0], q[1], s) < s.hw + 9))) continue;
      back = { h: from, pts: [p0, p1, p2], th };
    }
    if (back) {
      const [p0, p1, p2] = back.pts;
      const m = at(back.h, back.th, 0);
      back.h.mouths.push({ u: m[0], v: m[1], th: back.th, w: 3.6 });
      segs.push({ au: p0[0], av: p0[1], bu: p1[0], bv: p1[1], hw: 1.8, y0: Yf, y1: Yf + 3 });
      segs.push({ au: p1[0], av: p1[1], bu: p2[0], bv: p2[1], hw: 5, y0: Yf, y1: Yf + 4 });
    }
  }

  // ---- stairs: flights along the walls, each on a side of its own
  const SW = 3.6;
  /** How far the wall is from the hall's middle line, at t along a side. */
  const wallAt = (h: Hall, axisU: boolean, sgn: number, t: number): number => {
    let w = 0;
    while (w < 60 && sdist(h, axisU ? t : h.u + sgn * (w + 0.5), axisU ? h.v + sgn * (w + 0.5) : t) > 0) w += 0.5;
    return w;
  };
  /** side: 0 +u, 1 +v, 2 -u, 3 -v. */
  const planFlight = (h: Hall, side: number, ya: number, yb: number, dir: number, off: number, solid: boolean): Flight | null => {
    const axisU = side === 1 || side === 3;
    const sgn = side < 2 ? 1 : -1;
    const unit = axisU ? 2 : 1.8;
    const snap = axisU ? even : onV;
    const snapW = axisU ? onV : even;
    const rise = yb - ya;
    const L = Math.max(4, Math.round(rise / 0.7 / unit)) * unit;
    const half = axisU ? h.a : h.b;
    const cap0 = unit;
    const cap1 = 2 * unit;
    // where along the side: near `off`, but on the straightest stretch of wall there is
    const span = Math.max(0, 0.66 * half - L / 2 - cap1);
    let t0 = 0;
    let lo = 0;
    let hi = 0;
    let wmin = 0;
    let wmax = 0;
    let best = Infinity;
    for (let q = -2; q <= 2; q++) {
      const mid = (axisU ? h.u : h.v) + Math.max(-span, Math.min(span, off + q * 3.5));
      const c0 = snap(mid - (dir * L) / 2);
      const a0 = Math.min(c0 - dir * cap0, c0 + dir * (L + cap1));
      const a1 = Math.max(c0 - dir * cap0, c0 + dir * (L + cap1));
      let mn = Infinity;
      let mx = 0;
      for (let t = a0 + 0.5; t < a1; t += 1) {
        const w = wallAt(h, axisU, sgn, t);
        mn = Math.min(mn, w);
        mx = Math.max(mx, w);
      }
      const cost = mx - mn + Math.abs(q) * 0.4;
      if (cost < best) {
        best = cost;
        t0 = c0;
        lo = a0;
        hi = a1;
        wmin = mn;
        wmax = mx;
      }
    }
    if (wmin < 0.55 * (axisU ? h.b : h.a)) return null;
    const c = axisU ? h.v : h.u;
    const inner = snapW(c + sgn * (wmin - SW));
    const outer = c + sgn * (wmax + 1);
    const rect: [number, number, number, number] = axisU
      ? [lo, Math.min(inner, outer), hi, Math.max(inner, outer)]
      : [Math.min(inner, outer), lo, Math.max(inner, outer), hi];
    return { axisU, sgn, dir, t0, L, y0: ya, y1: yb, inner, cap0, cap1, solid, rect };
  };
  const inRect = (u: number, v: number, r: readonly number[], m: number): boolean => u > r[0] - m && u < r[2] + m && v > r[1] - m && v < r[3] + m;
  /** A point on a flight: s from 0 at the foot to 1 at the head, w metres in from its hall-side edge. */
  const onFlight = (f: Flight, s: number, w: number): Pt => {
    const t = f.t0 + f.dir * f.L * s;
    const lat = f.inner + f.sgn * w;
    return f.axisU ? [t, f.y0 + (f.y1 - f.y0) * s, lat] : [lat, f.y0 + (f.y1 - f.y0) * s, t];
  };
  const freeOfMouths = (h: Hall, f: Flight): boolean => !h.mouths.some((m) => inRect(m.u, m.v, f.rect, m.w / 2 + 2.5));
  {
    // the commons: one flight under the ledge, then one side each for the climbs to levels 2 and 3
    const dirs = (): number => (rnd() < 0.5 ? -1 : 1);
    const f0 = planFlight(C, 2, Yf, y1, dirs(), R(-8, 8), true);
    if (f0) C.flights.push(f0);
    const sides = [0, 1, 3];
    for (let i = 2; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = sides[i];
      sides[i] = sides[j];
      sides[j] = t;
    }
    const f1 = planFlight(C, sides[0], y1, y2, dirs(), R(-8, 8), false);
    const f2 = planFlight(C, sides[1], y2, y3, dirs(), R(-8, 8), false);
    const f3 = planFlight(C, sides[2], Yf, y1, dirs(), R(-8, 8), true);
    if (f1) C.flights.push(f1);
    if (f2) C.flights.push(f2);
    if (f3 && freeOfMouths(C, f3)) C.flights.push(f3);
  }
  // the top gallery: all the way round, or only from the ledge to the head of the last flight
  let arcC = Math.PI;
  let arcH = 4;
  {
    const f = C.flights.find((x) => x.y1 === y3);
    const full = rnd() < 0.45;
    if (f && !full) {
      const p = onFlight(f, 1, 0);
      const thF = Math.atan2(p[2] - C.v, p[0] - C.u);
      let d = thF - Math.PI;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      arcC = Math.PI + d / 2;
      arcH = Math.abs(d) / 2 + 0.55;
    }
  }
  const inArc = (th: number, m: number): boolean => {
    let d = th - arcC;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return Math.abs(d) <= arcH - m;
  };

  // ---- the cistern hall's pools, before its stair is placed clear of them
  {
    const h = cistern;
    // two side by side across the way in, and sometimes a third beyond them
    const mth = h.mouths[0].th;
    const thA = mth + Math.PI / 2 + R(-0.35, 0.35);
    const r0 = R(4.2, 5);
    const r1 = R(3.6, 4.6);
    const gap = R(0.9, 1.5);
    const third = rnd() < 0.55;
    const r2 = R(2.8, 3.4);
    const th2 = mth + Math.PI + R(-0.4, 0.4);
    h.pools.push({ u: h.u + Math.cos(thA) * (r0 + gap), v: h.v + Math.sin(thA) * (r0 + gap), r: r0 });
    h.pools.push({ u: h.u - Math.cos(thA) * (r1 + gap), v: h.v - Math.sin(thA) * (r1 + gap), r: r1 });
    if (third) {
      const d = Math.max(r0, r1) + r2 + 1.6;
      const pu = h.u + Math.cos(th2) * d;
      const pv = h.v + Math.sin(th2) * d;
      if (sdist(h, pu, pv) >= r2 + 3.5) h.pools.push({ u: pu, v: pv, r: r2 });
    }
  }
  for (let i = 1; i < halls.length; i++) {
    const h = halls[i];
    const order = h.a >= h.b ? [1, 3, 0, 2] : [0, 2, 1, 3];
    if (rnd() < 0.5) order.reverse();
    const dir = rnd() < 0.5 ? -1 : 1;
    const off = R(-4, 4);
    for (const side of order) {
      const f = planFlight(h, side, Yf, y1, dir, off, true);
      if (!f || !freeOfMouths(h, f)) continue;
      if (h.pools.some((p) => inRect(p.u, p.v, f.rect, p.r + 1))) continue;
      h.flights.push(f);
      break;
    }
  }

  // ---- pillars left standing in the commons, and the bridges between them at level 2
  interface Bridge { au: number; av: number; bu: number; bv: number }
  const bridges: Bridge[] = [];
  const balconies: number[] = [];
  {
    const base = R(-0.3, 0.3);
    const cand: Hall['pillars'] = [];
    for (let q = 0; q < 4; q++) {
      const th = Math.PI / 4 + (q * Math.PI) / 2 + base + R(-0.22, 0.22);
      const f = R(0.44, 0.52);
      const r = R(3, 4.6);
      const keep = rnd() < 0.85;
      const d = radius(C, th) * f;
      cand.push({ u: C.u + Math.cos(th) * d, v: C.v + Math.sin(th) * d, r: keep ? r : 0, ph: R(0, TAU), th });
    }
    // never fewer than two tried
    for (let q = 0; cand.filter((p) => p.r > 0).length < 2; q++) if (cand[q].r === 0) cand[q].r = 3.6;
    for (const p of cand) {
      if (p.r === 0) continue;
      if (C.flights.some((f) => inRect(p.u, p.v, f.rect, p.r + 4))) continue;
      if (C.mouths.some((m) => distSeg(p.u, p.v, { au: C.u, av: C.v, bu: m.u, bv: m.v, hw: 0, y0: 0, y1: 0 }) < p.r + m.w / 2 + 1.5)) continue;
      C.pillars.push(p);
    }
    const high = C.flights.filter((f) => f.y1 > y2 - 3 && f.y0 < y2 + 3);
    const clear = (br: Bridge): boolean => {
      for (let i = 0; i <= 16; i++) {
        const u = br.au + ((br.bu - br.au) * i) / 16;
        const v = br.av + ((br.bv - br.av) * i) / 16;
        if (high.some((f) => inRect(u, v, f.rect, 2.8))) return false;
      }
      return true;
    };
    const joined: boolean[] = C.pillars.map(() => false);
    C.pillars.forEach((p, i) => {
      const w = at(C, p.th, 1);
      const br = { au: p.u, av: p.v, bu: w[0], bv: w[1] };
      if (clear(br)) {
        bridges.push(br);
        joined[i] = true;
      }
    });
    // pillar to pillar, where one end can already be reached and the span keeps clear of the great lamp
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < C.pillars.length; i++) {
        const j = (i + 1) % C.pillars.length;
        if (j === i || (C.pillars.length === 2 && i === 1)) continue;
        const p = C.pillars[i];
        const q = C.pillars[j];
        const br = { au: p.u, av: p.v, bu: q.u, bv: q.v };
        if (bridges.some((x) => x.au === br.au && x.av === br.av && x.bu === br.bu && x.bv === br.bv)) continue;
        if (!(joined[i] || joined[j]) || !clear(br)) continue;
        if (distSeg(C.u, C.v, { ...br, hw: 0, y0: 0, y1: 0 }) < 7) continue;
        bridges.push(br);
        joined[i] = joined[j] = true;
      }
    }
    joined.forEach((on, i) => {
      if (on) balconies.push(i);
    });
  }

  // ---- rooms: round every hall at every level, the same places one above another
  const rooms: Room[] = [];
  const roomAngles = new Map<Hall, number[]>();
  for (const h of halls) {
    const n = Math.max(6, Math.floor((Math.PI * (h.a + h.b) * 1.06) / 10.5));
    const th0 = R(0, TAU);
    const cand: { th: number; du: number; dv: number }[] = [];
    for (let i = 0; i < n; i++) {
      cand.push({ th: th0 + ((i + R(-0.14, 0.14)) * TAU) / n, du: [4, 6, 6, 8][Math.floor(rnd() * 4)], dv: [3.6, 5.4, 5.4, 7.2][Math.floor(rnd() * 4)] });
    }
    roomAngles.set(h, cand.map((c) => c.th));
    for (let lvl = 0; lvl <= h.levels.length; lvl++) {
      const y = lvl === 0 ? h.floor : h.levels[lvl - 1];
      for (let i = 0; i < n; i++) {
        const { th, du, dv } = cand[i];
        if (h === C && lvl === 3 && !inArc(th, 0.2)) continue;
        const cs = Math.cos(th);
        const sn = Math.sin(th);
        const r = radius(h, th);
        const band = lvl > 0 ? h.GW / lean(h, th) : 0;
        const rc = r + band + (Math.abs(cs) * du + Math.abs(sn) * dv) / 2 + 0.9;
        const u0 = even(h.u + cs * rc - du / 2);
        const v0 = onV(h.v + sn * rc - dv / 2);
        const room: Room = { u0, v0, u1: u0 + du, v1: v0 + dv, y, tu: 0, tv: 0, hall: h, lvl, skip: tier === 2 && i % 2 === 1 };
        const rt = lvl > 0 ? r + band / 2 : r - 2.2;
        room.tu = h.u + cs * rt;
        room.tv = h.v + sn * rt;
        const cu = u0 + du / 2;
        const cv = v0 + dv / 2;
        const rad = Math.hypot(du, dv) / 2;
        if (u0 < 3 || room.u1 > spec.u1 - 3 || v0 < spec.v0 + 3 || room.v1 > spec.v1 - 3) continue;
        if (halls.some((o) => o !== h && sdist(o, cu, cv) > -(o.GW / 0.55 + rad + 2.5))) continue;
        if (segs.some((s) => y < s.y1 + 2.5 && y + 3.2 > s.y0 - 2.5 && distSeg(cu, cv, s) < s.hw + rad + 2.2)) continue;
        if (rooms.some((o) => Math.abs(o.y - y) < 6 && u0 < o.u1 + 1.6 && room.u1 > o.u0 - 1.6 && v0 < o.v1 + 1.6 && room.v1 > o.v0 - 1.6)) continue;
        if (lvl === 0 && h.flights.some((f) => f.y0 === h.floor && (inRect(room.tu, room.tv, f.rect, 2.6) || inRect(h.u + cs * r, h.v + sn * r, f.rect, 2.2)))) continue;
        rooms.push(room);
      }
    }
  }

  // ================================================================ carving
  b.holeStair();
  g.roughNow = 0.12;
  if (Lv > 0) {
    const sg = Math.sign(vP);
    g.carveRun([4, yA, 0], [uT - 2, hT1, 0], PW, PH, { steps: true, cap1: 4 });
    g.carveRun([uT, hT1, sg * 1.8], [uT, hT2, vP - sg * 1.8], 4, PH, { steps: true, cap0: 3.6, cap1: 3.6 });
    g.carveRun([uT + 2, hT2, vP], [uE, yL, vP], PW, PH, { steps: true, cap0: 4, cap1: uH0 + 3 - uE });
  } else {
    g.carveRun([4, yA, 0], [uE, yL, 0], PW, PH, { steps: true, cap1: uH0 + 3 - uE });
  }

  const paintWorn = b.paint(0.93, 0.9, 0.84, 1);
  for (const h of halls) {
    const eu = h.a * (1 + h.amp) + 1;
    const ev = h.b * (1 + h.amp) + 1;
    const common = h.role === 0;
    const rin = 0.75 * Math.min(h.a, h.b);
    g.roughNow = tier === 2 ? 0.6 : 0.5;
    g.each(h.u - eu, h.v - ev, h.u + eu, h.v + ev, (ci, u, v) => {
      if ((g.mask[ci] & 1) === 0) return;
      const s = sdist(h, u, v);
      if (s <= 0) return;
      for (const p of h.pillars) {
        const du = u - p.u;
        const dv = v - p.v;
        const d2 = du * du + dv * dv;
        if (d2 > p.r * p.r * 1.6) continue;
        const a = Math.atan2(dv, du);
        const rr = p.r * (1 + 0.16 * Math.sin(3 * a + p.ph) + 0.08 * Math.sin(5 * a - p.ph));
        if (d2 < rr * rr) return;
      }
      let ceil: number;
      if (common) {
        // the roof: lower toward the walls, and broken into plates
        const arch = 1 - smooth(s / 16);
        ceil = Yc - Math.round(4 * arch * arch + 2.4 * vnoise(u / 23, v / 23) + 0.9 * vnoise(u / 8, v / 8));
      } else {
        const t = 1 - Math.min(1, s / rin);
        ceil = h.floor + h.wallH + (h.top - h.wallH) * Math.sqrt(1 - t * t) - Math.round(3 * vnoise(u / 11, v / 11)) / 2;
      }
      g.carveCell(ci, h.floor, ceil);
    });
    // its galleries: a slot cut back into the wall at each level
    g.roughNow = 0.22;
    const m = h.GW / 0.5 + 2;
    g.each(h.u - eu - m, h.v - ev - m, h.u + eu + m, h.v + ev + m, (ci, u, v) => {
      if ((g.mask[ci] & 1) === 0) return;
      const s = sdist(h, u, v);
      if (s > 0 || s < -h.GW) return;
      const th = common ? Math.atan2(v - h.v, u - h.u) : 0;
      for (let k = 0; k < h.levels.length; k++) {
        if (common && k === 2 && !inArc(th, 0)) continue;
        g.carveCell(ci, h.levels[k], h.levels[k] + h.GH);
      }
    });
  }

  // the passages between halls: an arched tunnel on the floor, a plain one above it
  const tunnel = (l: Link): void => {
    const du = l.bu - l.au;
    const dv = l.bv - l.av;
    const L = Math.hypot(du, dv);
    const eu = du / L;
    const ev = dv / L;
    const hw = l.w / 2;
    g.carveFn(Math.min(l.au, l.bu) - hw, Math.min(l.av, l.bv) - hw, Math.max(l.au, l.bu) + hw, Math.max(l.av, l.bv) + hw, (u, v, o) => {
      const t = (u - l.au) * eu + (v - l.av) * ev;
      const w = Math.abs((u - l.au) * ev - (v - l.av) * eu);
      if (t < 0 || t > L || w > hw) return false;
      o.floor = Yf;
      o.ceil = Yf + PHT - Math.round(4.4 * (w / hw) * (w / hw)) / 2;
      return true;
    });
  };
  for (const l of links) {
    g.roughNow = 0.4;
    tunnel(l);
    g.roughNow = 0.2;
    g.carveRun([l.au, y1, l.av], [l.bu, y1, l.bv], 3.6, 3.2);
  }
  if (back) {
    const [p0, p1, p2] = back.pts;
    g.roughNow = 0.35;
    g.carveRun([p0[0], Yf, p0[1]], [p1[0], Yf, p1[1]], 3.6, 3, { cap1: 1.8 });
    g.carveRun([p1[0], Yf, p1[1]], [p2[0], Yf, p2[1]], 3.6, 2.8);
    g.carveDome(p2[0], p2[1], 5, Yf, 4.5, 2.5);
  }

  // rooms and their doorways
  for (const r of rooms) {
    if (r.skip) continue;
    g.roughNow = 0.15;
    g.carveBox(r.u0, r.v0, r.u1, r.v1, r.y, r.y + 3.2);
    g.carveRun([(r.u0 + r.u1) / 2, r.y, (r.v0 + r.v1) / 2], [r.tu, r.y, r.tv], 3, 2.6);
  }

  // the hearth: a round of floor sunk a step, worn pale
  g.roughNow = 0.05;
  g.paintF = paintWorn;
  g.carveCyl(C.u, C.v, 8, Yh, Yf + 2);
  g.paintF = 0;

  // the pools: shallow bowls in the floor, water standing in them
  const WL = Yf - 0.15;
  g.flood(0, 0, -1, -1, () => NaN);
  for (const p of cistern.pools) {
    g.carveFn(p.u - p.r, p.v - p.r, p.u + p.r, p.v + p.r, (u, v, o) => {
      const du = u - p.u;
      const dv = v - p.v;
      const d = Math.hypot(du, dv);
      if (d >= p.r) return false;
      o.floor = Yf - 0.2 * (p.r - d);
      o.ceil = Yf + 2;
      if (d > 0.01) {
        o.su = (0.2 * du) / d;
        o.sv = (0.2 * dv) / d;
      }
      return true;
    });
    const w = g.water!;
    g.each(p.u - p.r, p.v - p.r, p.u + p.r, p.v + p.r, (ci, u, v) => {
      if (Math.hypot(u - p.u, v - p.v) < p.r) w[ci] = WL;
    });
  }
  // one small hole in the cistern hall's roof, sometimes
  const shaft = rnd() < 0.4;
  const shaftR = R(2.4, 3.2);
  if (shaft) b.skyShaft(cistern.pools[0].u, cistern.pools[0].v, shaftR, 0.7);

  // ================================================================ rock put back
  for (const h of halls) {
    for (const f of h.flights) {
      g.roughNow = 0;
      const sl = (f.y1 - f.y0) / f.L;
      g.fillFn(f.rect[0], f.rect[1], f.rect[2], f.rect[3], (u, v, o) => {
        const t = f.axisU ? u : v;
        const w = f.axisU ? v : u;
        if ((w - f.inner) * f.sgn < 0) return false;
        const rel = (t - f.t0) * f.dir;
        if (rel < -f.cap0 || rel > f.L + f.cap1) return false;
        if (sdist(h, u, v) <= 0) return false;
        let y = f.y0;
        if (rel >= f.L) y = f.y1;
        else if (rel > 0) {
          y = f.y0 + sl * rel;
          if (f.axisU) o.su = sl * f.dir;
          else o.sv = sl * f.dir;
          o.steps = true;
        }
        o.hi = y;
        o.lo = f.solid ? h.floor - 0.5 : y - 1.8;
        return true;
      });
    }
  }
  // a lookout pushed out from the ledge
  g.roughNow = 0.1;
  g.fillBox(uH0 - 2, vP - 3.6, uH0 + 6, vP + 3.6, yL - 1.6, yL);
  // balconies round the pillars, and the bridges
  g.roughNow = 0.12;
  for (const i of balconies) {
    const p = C.pillars[i];
    g.fillCyl(p.u, p.v, p.r * 1.24 + 3.2, y2 - 1.5, y2);
  }
  for (const br of bridges) g.fillRun([br.au, y2, br.av], [br.bu, y2, br.bv], 3.6, 1.5);

  // ================================================================ dressing
  const few = [1, 0.65, 0.4][tier];
  const sides = tier === 2 ? 5 : 6;
  /** Level floor at y under a spot, and room to stand something on it. */
  const flat = (u: number, v: number, y: number, r = 0.5): boolean => {
    for (let q = 0; q < 5; q++) {
      const f = g.floorAt(u + (q === 1 ? r : q === 2 ? -r : 0), v + (q === 3 ? r : q === 4 ? -r : 0), y + 0.4);
      if (!(Math.abs(f - y) < 0.03)) return false;
    }
    return g.ceilAt(u, v, y + 0.4) - y >= 2.4;
  };
  const CLOTH: [number, number, number][] = [[0.62, 0.2, 0.15], [0.25, 0.34, 0.44], [0.8, 0.58, 0.25], [0.3, 0.45, 0.42], [0.9, 0.85, 0.72], [0.5, 0.22, 0.3]];
  const cloth = (i = Math.floor(b.rng() * CLOTH.length)): void => {
    const c = CLOTH[i % CLOTH.length];
    const k = b.r(0.85, 1.05);
    b.color(c[0] * k, c[1] * k, c[2] * k, 2);
  };
  const wood = (): void => {
    const k = b.r(0.8, 1.05);
    b.color(0.5 * k, 0.36 * k, 0.24 * k, 2);
  };
  const clay = (): void => {
    const k = b.r(0.75, 1);
    if (b.rng() < 0.55) b.color(0.85 * k, 0.62 * k, 0.45 * k, 2);
    else b.color(0.9 * k, 0.86 * k, 0.8 * k, 1);
  };
  const jar = (u: number, y: number, v: number, s = 1): void => {
    const r = b.r(0.24, 0.34) * s;
    const h = b.r(0.5, 0.75) * s;
    clay();
    if (b.rng() < 0.12) {
      b.cyl(u, y + r, v, r, h, { top: 0.6, rx: Math.PI / 2, sides });
      return;
    }
    b.cyl(u, y, v, r * 0.8, h * 0.65, { top: 1.25, sides });
    b.cyl(u, y + h * 0.65, v, r, h * 0.35, { top: 0.5, sides });
  };
  const amphora = (u: number, y: number, v: number): void => {
    const h = b.r(1, 1.35);
    clay();
    b.cyl(u, y, v, 0.14, h * 0.5, { top: 2.3, sides });
    b.cyl(u, y + h * 0.5, v, 0.32, h * 0.3, { top: 0.4, sides });
    b.cyl(u, y + h * 0.8, v, 0.13, h * 0.2, { top: 1.3, sides });
  };
  const jars = (u: number, y: number, v: number, n: number, spread = 1): void => {
    for (let i = 0; i < n; i++) {
      const ju = u + b.r(-spread, spread);
      const jv = v + b.r(-spread, spread);
      if (!g.isAir(ju, y + 0.3, jv)) continue;
      if (b.rng() < 0.2) amphora(ju, y, jv);
      else jar(ju, y, jv);
    }
  };
  const bowl = (u: number, y: number, v: number): void => {
    clay();
    b.cyl(u, y, v, b.r(0.1, 0.16), b.r(0.08, 0.13), { top: 1.7, sides });
  };
  const basket = (u: number, y: number, v: number): void => {
    const k = b.r(0.8, 1);
    b.color(0.78 * k, 0.62 * k, 0.36 * k, 2);
    const r = b.r(0.26, 0.4);
    b.cyl(u, y, v, r, b.r(0.3, 0.5), { top: 1.25, sides });
  };
  const crate = (u: number, y: number, v: number, solid = false): number => {
    const s = b.r(0.6, 0.95);
    wood();
    b.box(u, y, v, s, s * b.r(0.7, 1), s, b.r(0, 1.5), { solid });
    return s;
  };
  const crates = (u: number, y: number, v: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      const cu = u + b.r(-1.1, 1.1);
      const cv = v + b.r(-1.1, 1.1);
      const s = crate(cu, y, cv);
      if (b.rng() < 0.4) crate(cu + b.r(-0.1, 0.1), y + s * 0.85, cv + b.r(-0.1, 0.1));
    }
  };
  /** A rug: a border, a field, and a medallion in the middle. */
  const rug = (u: number, y: number, v: number, w: number, d: number, rot: number, ci = b.rng() < 0.6 ? 0 : Math.floor(b.rng() * CLOTH.length)): void => {
    cloth(ci === 4 ? 0 : ci);
    b.box(u, y, v, w, 0.05, d, rot);
    b.color(0.85, 0.7, 0.45, 2);
    b.box(u, y + 0.05, v, w - Math.min(0.6, w * 0.2), 0.015, d - Math.min(0.6, d * 0.2), rot);
    cloth(ci === 4 ? 0 : ci);
    b.box(u, y + 0.065, v, w - Math.min(1.1, w * 0.36), 0.012, d - Math.min(1.1, d * 0.4), rot);
    if (w > 2.4 && tier < 2) {
      cloth(ci + 1);
      b.box(u, y + 0.077, v, Math.min(w, d) * 0.3, 0.01, Math.min(w, d) * 0.3, rot + Math.PI / 4);
    }
  };
  const cushion = (u: number, y: number, v: number): void => {
    cloth();
    b.box(u, y, v, b.r(0.5, 0.7), b.r(0.14, 0.2), b.r(0.5, 0.7), b.r(0, 1.5));
  };
  const lowTable = (u: number, y: number, v: number, w: number, d: number, rot: number, solid = false): void => {
    wood();
    b.box(u, y, v, w * 0.8, 0.36, d * 0.7, rot, { solid });
    b.box(u, y + 0.36, v, w, 0.09, d, rot);
  };
  /** A lamp on a pole. */
  const post = (u: number, y: number, v: number, reach: number, strength = 1): void => {
    b.color(0.4, 0.33, 0.27, 2);
    b.box(u, y, v, 0.12, 1.9, 0.12, 0.3);
    b.box(u, y, v, 0.4, 0.12, 0.4, 0.3);
    b.lamp(u, y + 2.42, v, { reach, strength, size: 1.2 });
  };
  /** A line between two poles with cloth hung on it. */
  const line = (au: number, av: number, bu: number, bv: number, y: number): void => {
    const du = bu - au;
    const dv = bv - av;
    const L = Math.hypot(du, dv);
    const rot = rotOf(du, dv);
    b.color(0.4, 0.33, 0.27, 2);
    b.box(au, y, av, 0.1, 2.3, 0.1);
    b.box(bu, y, bv, 0.1, 2.3, 0.1);
    b.box((au + bu) / 2, y + 2.18, (av + bv) / 2, L, 0.03, 0.03, rot);
    let t = b.r(0.5, 0.9);
    while (t < L - 0.9) {
      const w = b.r(0.5, 1.1);
      const h = b.r(0.7, 1.4);
      cloth();
      b.box(au + (du / L) * (t + w / 2), y + 2.18 - h, av + (dv / L) * (t + w / 2), w, h, 0.04, rot, { rz: b.r(-0.04, 0.04) });
      t += w + b.r(0.15, 0.7);
    }
  };
  const pallet = (u: number, y: number, v: number, fu: number, fv: number): void => {
    const rot = rotOf(fu, fv);
    b.color(0.86, 0.8, 0.66, 2);
    b.box(u, y, v, 1.9, 0.15, 0.8, rot);
    cloth();
    b.box(u + fu * 0.35, y + 0.15, v + fv * 0.35, 1.15, 0.05, 0.84, rot);
    b.color(0.92, 0.88, 0.8, 2);
    b.box(u - fu * 0.72, y + 0.15, v - fv * 0.72, 0.3, 0.1, 0.55, rot);
  };
  const loom = (u: number, y: number, v: number, rot: number): void => {
    const c = Math.cos(rot);
    const s = -Math.sin(rot);
    wood();
    for (const q of [-1, 1]) b.box(u + c * q * 0.9, y, v + s * q * 0.9, 0.1, 1.9, 0.1, rot);
    b.box(u, y + 1.8, v, 2, 0.1, 0.12, rot);
    b.box(u, y + 0.25, v, 2, 0.1, 0.12, rot);
    b.color(0.9, 0.86, 0.76, 2);
    b.box(u, y + 0.95, v, 1.6, 0.85, 0.03, rot);
    cloth();
    b.box(u, y + 0.35, v, 1.6, 0.6, 0.035, rot);
  };
  const stall = (u: number, y: number, v: number, rot: number): void => {
    const c = Math.cos(rot);
    const s = -Math.sin(rot);
    b.color(0.4, 0.33, 0.27, 2);
    for (const q of [-1, 1]) for (const w of [-1, 1]) b.box(u + c * q * 1.4 + s * w * 1, y, v + s * q * 1.4 - c * w * 1, 0.09, w > 0 ? 2.5 : 2.1, 0.09, rot);
    cloth();
    b.box(u, y + 2.25, v, 3.2, 0.05, 2.4, rot, { rx: -0.19 });
    wood();
    b.box(u, y, v, 2.5, 0.75, 0.8, rot);
    for (let i = 0; i < Math.ceil(4 * few); i++) {
      const t = b.r(-1.05, 1.05);
      const w = b.r(-0.2, 0.2);
      if (b.rng() < 0.5) bowl(u + c * t + s * w, y + 0.75, v + s * t - c * w);
      else jar(u + c * t + s * w, y + 0.75, v + s * t - c * w, 0.55);
    }
  };
  /** Somewhere on a hall's open floor, between two fractions of the way to its wall. */
  const spot = (h: Hall, f0: number, f1: number, r: number): [number, number] | null => {
    for (let t = 0; t < 10; t++) {
      const th = b.r(0, TAU);
      const d = radius(h, th) * b.r(f0, f1);
      const u = h.u + Math.cos(th) * d;
      const v = h.v + Math.sin(th) * d;
      if (!flat(u, v, h.floor, r)) continue;
      if (h.mouths.some((m) => distSeg(u, v, { au: h.u, av: h.v, bu: m.u, bv: m.v, hw: 0, y0: 0, y1: 0 }) < m.w / 2 + r)) continue;
      return [u, v];
    }
    return null;
  };
  const sitting = (u: number, y: number, v: number, n: number): void => {
    const rot = b.r(0, 3);
    rug(u, y, v, b.r(2.6, 3.6), b.r(1.8, 2.4), rot);
    lowTable(u, y + 0.07, v, 1.1, 0.7, rot);
    bowl(u + b.r(-0.3, 0.3), y + 0.52, v + b.r(-0.2, 0.2));
    for (let i = 0; i < n; i++) {
      const a = b.r(0, TAU);
      cushion(u + Math.cos(a) * b.r(0.9, 1.3), y + 0.07, v + Math.sin(a) * b.r(0.9, 1.3));
    }
  };

  /** A lamp in a frame of iron, hung on a chain from the roof: its glass from y to y + 1.6 k. */
  const hang = (u: number, v: number, y: number, roof: number, k: number, reach: number, strength: number): void => {
    b.color(0.34, 0.29, 0.24, 0);
    for (let cy = y + 3.6 * k, i = 0; cy < roof + 0.5; cy += 1.1 * Math.max(k, 0.7), i++) b.box(u, cy, v, 0.14 * k, Math.max(k, 0.7), 0.06 * k, (i % 2) * (Math.PI / 2));
    b.cyl(u, y + 3.1 * k, v, 0.5 * k, 0.5 * k, { top: 0.3, sides: 8 });
    b.cyl(u, y + 2.5 * k, v, 1.7 * k, 0.6 * k, { top: 0.3, sides: 8 });
    b.cyl(u, y + 2.3 * k, v, 1.85 * k, 0.2 * k, { sides: 8 });
    b.cyl(u, y + 0.5 * k, v, 1.85 * k, 0.2 * k, { sides: 8 });
    b.cyl(u, y - 0.5 * k, v, 0.5 * k, k, { top: 3.4, sides: 8 });
    b.cyl(u, y - 0.9 * k, v, 0.2 * k, 0.4 * k, { top: 2.5, sides: 8 });
    for (let i = 0; i < 8; i++) {
      const a = ((i + 0.5) / 8) * TAU;
      b.box(u + Math.cos(a) * 1.72 * k, y + 0.7 * k, v + Math.sin(a) * 1.72 * k, 0.12 * k, 1.6 * k, 0.12 * k, -a);
    }
    b.color(1, 0.86, 0.6, 3);
    b.cyl(u, y + 0.7 * k, v, 1.6 * k, 1.6 * k, { sides: 8 });
    b.lamp(u, y + 1.9 * k, v, { reach, strength, size: 5.5 * k, body: false });
  };

  // ---- the hearth of the commons: the great lamp, the table under it, the rug and its cushions
  {
    const roof = g.ceilAt(C.u, C.v, Yh + 1);
    hang(C.u, C.v, Yh + Math.min(19, (roof - Yh) * 0.42), roof, 1, Math.min(54, Math.max(42, 1.25 * Math.max(C.a, C.b))), 2.8);

    rug(C.u, Yh, C.v, 9, 6.4, 0, 0);
    lowTable(C.u, Yh + 0.08, C.v, 2.6, 1.3, 0, true);
    for (let i = 0; i < Math.ceil(5 * few); i++) bowl(C.u + b.r(-1, 1), Yh + 0.53, C.v + b.r(-0.45, 0.45));
    jar(C.u + 0.9, Yh + 0.53, C.v + 0.3, 0.6);
    const nc = Math.ceil(10 * few);
    for (let i = 0; i < nc; i++) {
      const a = ((i + b.r(-0.3, 0.3)) / nc) * TAU;
      cushion(C.u + Math.cos(a) * b.r(2, 2.5), Yh + 0.08, C.v + Math.sin(a) * b.r(1.3, 1.7));
    }
    // lamps on poles round the pit's rim, jars and baskets between them
    for (let i = 0; i < 4; i++) {
      const a = ((i + 0.5) / 4) * TAU + 0.2;
      if (tier < 2 || i % 2 === 0) post(C.u + Math.cos(a) * 9.3, Yf, C.v + Math.sin(a) * 9.3, 16, 0.9);
      jars(C.u + Math.cos(a + 0.5) * 9.6, Yf, C.v + Math.sin(a + 0.5) * 9.6, Math.ceil(4 * few), 0.9);
      if (b.rng() < 0.7) basket(C.u + Math.cos(a - 0.4) * 9.4, Yf, C.v + Math.sin(a - 0.4) * 9.4);
    }
  }
  let relic: Pt | null = null;
  if (spec.relic) relic = [C.u - 0.6, Yh + 0.83, C.v];
  // the waking stone, freestanding beyond the hearth's rim, facing the ledge side
  b.stone(C.u + 12.5, Yf, C.v, 0);

  // ---- the commons' floor: places to sit, washing hung between poles, stores by the pillars
  for (let i = 0; i < Math.ceil(5 * few); i++) {
    const p = spot(C, 0.4, 0.8, 2.2);
    if (p) sitting(p[0], Yf, p[1], 2 + Math.floor(b.rng() * 3));
  }
  for (let i = 0; i < (tier === 2 ? 1 : 2); i++) {
    const p = spot(C, 0.35, 0.7, 1);
    if (!p) continue;
    const a = b.r(0, TAU);
    const L = b.r(6, 9);
    const q: [number, number] = [p[0] + Math.cos(a) * L, p[1] + Math.sin(a) * L];
    if (flat(q[0], q[1], Yf, 1) && flat((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, Yf, 1)) line(p[0], p[1], q[0], q[1], Yf);
  }
  for (const p of C.pillars) {
    const a = b.r(0, TAU);
    const d = p.r * 1.25 + 1.4;
    jars(p.u + Math.cos(a) * d, Yf, p.v + Math.sin(a) * d, Math.ceil(5 * few), 1.1);
    crates(p.u - Math.cos(a) * d, Yf, p.v - Math.sin(a) * d, Math.ceil(3 * few));
    post(p.u + Math.cos(a + 1.6) * (d + 0.3), Yf, p.v + Math.sin(a + 1.6) * (d + 0.3), 15, 0.85);
  }
  for (let i = 0; i < Math.ceil(7 * few); i++) {
    const p = spot(C, 0.7, 0.93, 1.3);
    if (!p) continue;
    const q = b.rng();
    if (q < 0.4) jars(p[0], Yf, p[1], 4, 1);
    else if (q < 0.7) crates(p[0], Yf, p[1], 3);
    else {
      basket(p[0], Yf, p[1]);
      basket(p[0] + 0.8, Yf, p[1] + 0.3);
      jar(p[0] - 0.5, Yf, p[1] + 0.7);
    }
  }

  // ---- the other halls
  for (let hi = 1; hi < halls.length; hi++) {
    const h = halls[hi];
    {
      // a lamp of its own hung in the middle, a smaller cousin of the great one
      const roof = g.ceilAt(h.u, h.v, Yf + 2);
      if (roof < Yf + 40) hang(h.u, h.v, Yf + Math.min(9, (roof - Yf) * 0.4), roof, 0.5, h.role === 3 ? 24 : 30, h.role === 3 ? 1.1 : 1.6);
    }
    const nPost = Math.ceil((h.role === 3 ? 2 : 4) * (tier === 2 ? 0.5 : 1));
    for (let i = 0; i < nPost; i++) {
      const p = spot(h, 0.45, 0.8, 0.8);
      if (p) post(p[0], Yf, p[1], h.role === 3 ? 13 : 17, h.role === 3 ? 0.7 : 1);
    }
    if (h.role === 1) {
      // rims of rough stone, a spout running into the largest, jars waiting to be filled
      h.pools.forEach((p, pi) => {
        const n = Math.max(7, Math.round((TAU * (p.r - 0.45)) / (tier === 2 ? 1.9 : 1.25)));
        for (let i = 0; i < n; i++) {
          const a = ((i + b.r(-0.15, 0.15)) / n) * TAU;
          const k = b.r(0.82, 1);
          b.color(k, k, k * 0.98, 0);
          b.box(p.u + Math.cos(a) * (p.r - 0.42), Yf - 0.2, p.v + Math.sin(a) * (p.r - 0.42), b.r(0.5, 0.75), b.r(0.5, 0.75), ((TAU * p.r) / n) * 1.06, -a, { rx: b.r(-0.08, 0.08) });
        }
        const a = (h.mouths[0]?.th ?? 0) + Math.PI + b.r(-0.8, 0.8) + pi;
        const cs = Math.cos(a);
        const sn = Math.sin(a);
        if (pi === 0) {
          b.color(0.9, 0.9, 0.88, 0);
          b.box(p.u + cs * (p.r + 0.75), Yf, p.v + sn * (p.r + 0.75), 1.1, 1.7, 1.3, -a, { solid: true });
          b.box(p.u + cs * (p.r - 0.2), Yf + 1.2, p.v + sn * (p.r - 0.2), 1.3, 0.22, 0.4, -a);
          b.color(0.62, 0.86, 0.9, 1);
          b.box(p.u + cs * (p.r - 0.85), WL, p.v + sn * (p.r - 0.85), 0.07, Yf + 1.3 - WL, 0.16, -a);
          b.box(p.u + cs * (p.r - 0.85), WL, p.v + sn * (p.r - 0.85), 0.5, 0.03, 0.5, -a + 0.6);
        }
        jars(p.u + Math.cos(a + 1.3) * (p.r + 1.5), Yf, p.v + Math.sin(a + 1.3) * (p.r + 1.5), Math.ceil(6 * few), 1.1);
        if (b.rng() < 0.7) basket(p.u + Math.cos(a - 1.2) * (p.r + 1.2), Yf, p.v + Math.sin(a - 1.2) * (p.r + 1.2));
      });
      for (let i = 0; i < Math.ceil(3 * few); i++) {
        const p = spot(h, 0.6, 0.9, 1.2);
        if (p) for (let q = 0; q < 4; q++) amphora(p[0] + b.r(-0.9, 0.9), Yf, p[1] + b.r(-0.9, 0.9));
      }
      const p = spot(h, 0.55, 0.85, 1);
      if (p) {
        const a = b.r(0, TAU);
        const q: [number, number] = [p[0] + Math.cos(a) * 5, p[1] + Math.sin(a) * 5];
        if (flat(q[0], q[1], Yf, 1)) line(p[0], p[1], q[0], q[1], Yf);
      }
    } else if (h.role === 2) {
      for (let i = 0; i < Math.ceil(6 * few); i++) {
        const p = spot(h, 0.25, 0.8, 2.2);
        if (p) stall(p[0], Yf, p[1], b.r(0, 3));
      }
      for (let i = 0; i < Math.ceil(5 * few); i++) {
        const p = spot(h, 0.3, 0.9, 1.4);
        if (!p) continue;
        if (b.rng() < 0.5) crates(p[0], Yf, p[1], 4);
        else {
          rug(p[0], Yf, p[1], 2.6, 1.8, b.r(0, 3));
          for (let q = 0; q < 5; q++) (b.rng() < 0.5 ? jar : bowl)(p[0] + b.r(-1, 1), Yf + 0.07, p[1] + b.r(-0.6, 0.6));
        }
      }
      const p = spot(h, 0.3, 0.8, 1.6);
      if (p) loom(p[0], Yf, p[1], b.r(0, 3));
    } else {
      // pallets in rows, hangings between them
      const rot = b.r(0, 3);
      const fu = Math.cos(rot);
      const fv = Math.sin(rot);
      for (let i = -3; i <= 3; i++) {
        for (let j = -2; j <= 2; j++) {
          if (tier === 2 && (i + j) % 2 !== 0) continue;
          const u = h.u + fu * j * 4.2 - fv * i * 2.3;
          const v = h.v + fv * j * 4.2 + fu * i * 2.3;
          if (b.rng() < 0.25 || !flat(u, v, Yf, 1.1) || sdist(h, u, v) < 3) continue;
          pallet(u, Yf, v, fu, fv);
          if (b.rng() < 0.3) jar(u + fu * 1.3, Yf, v + fv * 1.3);
          if (b.rng() < 0.2) rug(u - fv * 1.1, Yf, v + fu * 1.1, 1.8, 0.9, rotOf(fu, fv));
        }
      }
      for (let i = 0; i < 2; i++) {
        const p = spot(h, 0.3, 0.75, 1);
        if (!p) continue;
        const q: [number, number] = [p[0] - fv * 6, p[1] + fu * 6];
        if (flat(q[0], q[1], Yf, 1)) line(p[0], p[1], q[0], q[1], Yf);
      }
    }
  }

  // ---- rooms: what was kept in each, and a lamp in most
  for (const r of rooms) {
    if (r.skip) continue;
    const h = r.hall;
    const cu = (r.u0 + r.u1) / 2;
    const cv = (r.v0 + r.v1) / 2;
    const ddu = r.tu - cu;
    const ddv = r.tv - cv;
    const ax = Math.abs(ddu) >= Math.abs(ddv);
    const fu = ax ? Math.sign(ddu) : 0;
    const fv = ax ? 0 : Math.sign(ddv);
    const hf = (ax ? r.u1 - r.u0 : r.v1 - r.v0) / 2 - 0.45;
    const hr = (ax ? r.v1 - r.v0 : r.u1 - r.u0) / 2 - 0.45;
    const P = (pf: number, pr: number): [number, number] => [cu + fu * pf - fv * pr, cv + fv * pf + fu * pr];
    const rr = rotOf(-fv, fu); // along the back wall
    const rf = rotOf(fu, fv);
    const y = r.y;
    const near = h === C ? [1, 1, 0.8, 0.4][r.lvl] : [0.7, 0.5][r.lvl];
    const dens = near * few;
    const side = b.rng() < 0.5 ? -1 : 1;
    if (b.rng() < [0.85, 0.85, 0.6, 0.3][h === C ? r.lvl : r.lvl + 2] * [1, 0.8, 0.7][tier]) {
      const p = P(-hf + 0.35, side * (hr - 0.35));
      b.lamp(p[0], y + 0.5, p[1], { reach: 10, strength: 0.85 });
    }
    const q = b.rng();
    const kind = h.role === 3 ? (q < 0.7 ? 1 : 2) : h.role === 2 ? (q < 0.45 ? 0 : q < 0.85 ? 3 : 2) : h.role === 1 ? (q < 0.6 ? 0 : 2) : q < 0.3 ? 0 : q < 0.55 ? 1 : q < 0.85 ? 2 : 3;
    if (b.rng() > near + 0.25) continue; // far rooms stand empty
    if (kind === 0) {
      // a store: shelves across the back, pots on them, jars on the floor
      const p = P(-hf + 0.22, 0);
      const len = 2 * hr - 0.3;
      wood();
      for (const sy of [0.8, 1.5]) b.box(p[0], y + sy, p[1], len, 0.07, 0.42, rr);
      for (const e of [-1, 1]) {
        const s = P(-hf + 0.22, e * (len / 2 - 0.05));
        b.box(s[0], y, s[1], 0.08, 1.57, 0.42, rr);
      }
      for (let i = 0; i < Math.ceil(7 * dens); i++) {
        const s = P(-hf + 0.22, b.r(-len / 2 + 0.25, len / 2 - 0.25));
        if (b.rng() < 0.4) bowl(s[0], y + (b.rng() < 0.5 ? 0.87 : 1.57), s[1]);
        else jar(s[0], y + (b.rng() < 0.5 ? 0.87 : 1.57), s[1], 0.5);
      }
      for (let i = 0; i < Math.ceil(5 * dens); i++) {
        const s = P(b.r(-hf + 0.9, hf * 0.3), -side * b.r(hr * 0.5, hr - 0.1));
        if (b.rng() < 0.25) amphora(s[0], y, s[1]);
        else jar(s[0], y, s[1]);
      }
      if (b.rng() < 0.6) {
        const s = P(b.r(-hf + 1, 0), side * (hr - 0.2));
        basket(s[0], y, s[1]);
      }
    } else if (kind === 1) {
      // somewhere to sleep
      for (const e of hr >= 2 ? [-1, 1] : [side]) {
        if (b.rng() > 0.5 + dens) continue;
        const s = P(-hf + 1.15, e * (hr - 0.35));
        pallet(s[0], y, s[1], fu, fv);
      }
      if (hr >= 1.6) {
        const s = P(0.2, 0);
        rug(s[0], y, s[1], Math.min(2.4, 2 * hf - 0.6), Math.min(1.4, 2 * hr - 1.6), rf);
      }
      wood();
      const s = P(-hf + 0.3, -side * (hr - 0.6) * (hr >= 2 ? 0 : 1));
      b.box(s[0], y, s[1], 0.9, 0.5, 0.5, rr);
      if (b.rng() < 0.6) jar(P(hf * 0.5, side * (hr - 0.1))[0], y, P(hf * 0.5, side * (hr - 0.1))[1]);
    } else if (kind === 2) {
      // somewhere to sit
      const s = P(-0.2, 0);
      rug(s[0], y, s[1], Math.min(3.2, 2 * hf - 0.2), Math.min(2.2, 2 * hr - 0.3), rf);
      lowTable(s[0], y + 0.07, s[1], 1.1, 0.7, rf);
      bowl(s[0] + b.r(-0.3, 0.3), y + 0.52, s[1] + b.r(-0.2, 0.2));
      for (let i = 0; i < Math.ceil(4 * dens); i++) {
        const a = b.r(0, TAU);
        const c = P(-0.2 + Math.cos(a) * Math.min(1.1, hf - 0.4), Math.sin(a) * Math.min(1.1, hr - 0.3));
        cushion(c[0], y + 0.07, c[1]);
      }
      const j = P(-hf + 0.25, -side * (hr - 0.25));
      jars(j[0], y, j[1], Math.ceil(2 * dens), 0.3);
    } else {
      // a workroom: a bench across the back, a loom if there is room for one
      const p = P(-hf + 0.35, 0);
      const len = 2 * hr - 0.5;
      wood();
      b.box(p[0], y + 0.78, p[1], len, 0.08, 0.6, rr);
      for (const e of [-1, 1]) {
        const s = P(-hf + 0.35, e * (len / 2 - 0.15));
        b.box(s[0], y, s[1], 0.1, 0.78, 0.5, rr);
      }
      for (let i = 0; i < Math.ceil(4 * dens); i++) {
        const s = P(-hf + 0.35, b.r(-len / 2 + 0.3, len / 2 - 0.3));
        if (b.rng() < 0.5) bowl(s[0], y + 0.86, s[1]);
        else jar(s[0], y + 0.86, s[1], 0.45);
      }
      if (hr >= 2 && hf >= 1.4 && b.rng() < 0.6) {
        const s = P(0.3, -side * 0.4);
        loom(s[0], y, s[1], rr);
      } else {
        const s = P(0.2, -side * (hr - 0.6));
        crate(s[0], y, s[1]);
        if (b.rng() < 0.5) basket(P(0.9, side * (hr - 0.3))[0], y, P(0.9, side * (hr - 0.3))[1]);
      }
    }
  }

  // ---- galleries: a lamp against the back wall between doors, jars, here and there a rug
  const galleryPts: WarrenLayout['galleries'] = [];
  halls.forEach((h, hi) => {
    const ths = roomAngles.get(h)!;
    h.levels.forEach((y, k) => {
      const pts: [number, number, number][] = [];
      const top = h === C && k === 2;
      const every = (h === C ? (top ? 5 : 2) : 3) + (tier === 2 ? 1 : 0);
      for (let i = 0; i < ths.length; i++) {
        const th = (ths[i] + ths[(i + 1) % ths.length] + (i + 1 === ths.length ? TAU : 0)) / 2;
        if (top && !inArc(th, 0.15)) continue;
        const band = h.GW / lean(h, th);
        const mid = at(h, th, band * 0.5);
        pts.push([mid[0], y, mid[1]]);
        const p = at(h, th, band * 0.78);
        if (!flat(p[0], p[1], y, 0.3)) continue;
        if ((i + k) % every === 0) b.lamp(p[0], y + 0.56, p[1], { reach: h === C ? 16 : 12, strength: h === C ? 1.05 : 0.85, size: h === C ? 1.25 : 1 });
        else if (b.rng() < 0.5 * few) jars(p[0], y, p[1], 1 + Math.floor(b.rng() * 3), 0.5);
        else if (!top && b.rng() < 0.25 * few && flat(mid[0], mid[1], y, 0.8)) {
          rug(mid[0], y, mid[1], 2.4, 1.4, rotOf(-Math.sin(th), Math.cos(th)));
          cushion(mid[0] + b.r(-0.7, 0.7), y + 0.07, mid[1] + b.r(-0.4, 0.4));
        }
      }
      galleryPts.push({ hall: hi, level: k + 1, pts });
    });
  });

  // ---- lamps: at the ledge, down every flight, at every mouth, along the wide passages, on the bridges
  b.lamp(uH0 + 5.2, yL + 0.5, vP - 3, { reach: 16, strength: 0.8 });
  b.lamp(uH0 + 5.2, yL + 0.5, vP + 3, { reach: 16, strength: 0.8 });
  jars(uH0 - 1.5, yL, vP + (b.rng() < 0.5 ? -4.6 : 4.6), Math.ceil(4 * few), 0.8);
  rug(uH0 + 2.4, yL, vP, 2.8, 1.7, 0.1);
  const flightHeads: [number, number, number][] = [];
  for (const h of halls) {
    for (const f of h.flights) {
      const top = onFlight(f, 1, 1.2);
      flightHeads.push(f.axisU ? [top[0] + f.dir * 1.5, top[1], top[2]] : [top[0], top[1], top[2] + f.dir * 1.5]);
      for (const s of tier === 2 ? [0.03, 0.97] : [0.03, 0.5, 0.97]) {
        const p = onFlight(f, s, 0.45);
        b.lamp(p[0], p[1] + 0.62, p[2], { reach: 15, strength: 0.9 });
      }
    }
    for (const m of h.mouths) {
      if (m.w < 5) continue; // the back passage stays dark
      for (const e of [-1, 1]) {
        const u = m.u - Math.cos(m.th) * 1.6 - Math.sin(m.th) * e * (m.w / 2 + 1.6);
        const v = m.v - Math.sin(m.th) * 1.6 + Math.cos(m.th) * e * (m.w / 2 + 1.6);
        if (e > 0 || tier < 2) {
          if (flat(u, v, Yf, 0.3)) post(u, Yf, v, 16, 0.9);
        }
      }
    }
  }
  for (const l of links) {
    const L = Math.hypot(l.bu - l.au, l.bv - l.av);
    const n = Math.max(1, Math.round(L / (tier === 2 ? 22 : 13)));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const e = i % 2 === 0 ? 1 : -1;
      const u = l.au + (l.bu - l.au) * t - Math.sin(l.th) * e * (l.w / 2 - 0.7);
      const v = l.av + (l.bv - l.av) * t + Math.cos(l.th) * e * (l.w / 2 - 0.7);
      if (flat(u, v, Yf, 0.2)) b.lamp(u, Yf + 0.5, v, { reach: 14, strength: 0.85 });
      if (b.rng() < 0.6 * few) jars(u + Math.sin(l.th) * e * 0.3 + Math.cos(l.th) * 1.5, Yf, v - Math.cos(l.th) * e * 0.3 + Math.sin(l.th) * 1.5, 3, 0.5);
    }
    // the one above gets a single lamp, half way
    if (tier < 2) b.lamp((l.au + l.bu) / 2 - Math.sin(l.th) * 1.3, y1 + 0.5, (l.av + l.bv) / 2 + Math.cos(l.th) * 1.3, { reach: 10, strength: 0.7 });
  }
  const bridgeMids: [number, number, number][] = [];
  for (const br of bridges) {
    bridgeMids.push([(br.au + br.bu) / 2, y2, (br.av + br.bv) / 2]);
    const L = Math.hypot(br.bu - br.au, br.bv - br.av);
    const nu = -(br.bv - br.av) / L;
    const nv = (br.bu - br.au) / L;
    for (const t of tier === 2 ? [0.5] : [0.3, 0.7]) {
      const u = br.au + (br.bu - br.au) * t + nu * 1.4;
      const v = br.av + (br.bv - br.av) * t + nv * 1.4;
      if (flat(u, v, y2, 0.2)) b.lamp(u, y2 + 0.5, v, { reach: 15, strength: 0.9 });
    }
  }

  // ---- carved slabs stood either side of the commons' entrances, their marks still holding a little light
  if (spec.carvings) {
    const slab = (u: number, y: number, v: number, eu: number, ev: number): void => {
      // eu, ev: the way its face looks
      if (!flat(u, v, y, 0.3)) return;
      const rot = rotOf(eu, ev);
      const h = b.r(2.6, 3.4);
      const w = b.r(1.3, 1.7);
      const k = b.r(0.85, 1);
      b.color(k, k * 0.98, k * 0.94, 0);
      b.box(u, y - 0.2, v, 0.5, h, w, rot, { rz: b.r(-0.04, 0.04) });
      b.color(0.42, 0.42, 0.42, 4);
      for (let row = 0; row < 5; row++) {
        const yy = y + 0.5 + row * 0.42;
        if (yy > y + h - 0.9) break;
        for (let q = -1; q <= 1; q++) {
          if (b.rng() < 0.3) continue;
          const tall = b.rng() < 0.3;
          b.box(u + eu * 0.28 - ev * q * 0.36, yy, v + ev * 0.28 + eu * q * 0.36, 0.06, tall ? 0.3 : 0.07, tall ? 0.07 : b.r(0.14, 0.28), rot);
        }
      }
    };
    for (const m of C.mouths) {
      const cs = Math.cos(m.th);
      const sn = Math.sin(m.th);
      for (const e of [-1, 1]) slab(m.u - cs * 5 - sn * e * (m.w / 2 + 1.6), Yf, m.v - sn * 5 + cs * e * (m.w / 2 + 1.6), -cs, -sn);
    }
    for (const e of [-1, 1]) slab(uH0 - 1.2, yL, vP + e * 3.1, 1, 0);
  }

  // ---- a seam of glowing mineral in the back passage's chamber (or, with no room for one, in the last hall's wall)
  let backEnd: [number, number, number] | null = null;
  if (back) backEnd = [back.pts[2][0], Yf, back.pts[2][1]];
  if (spec.vein) {
    let cu: number;
    let cv: number;
    let a0: number;
    let rad: number;
    if (back) {
      cu = back.pts[2][0];
      cv = back.pts[2][1];
      a0 = Math.atan2(cv - back.pts[1][1], cu - back.pts[1][0]);
      rad = 4.6;
    } else {
      a0 = b.r(-0.6, 0.6);
      rad = radius(H3, a0) - 0.6;
      cu = H3.u;
      cv = H3.v;
    }
    const n = [16, 12, 8][tier];
    const arc = back ? 2.2 : 14 / rad;
    for (let i = 0; i < n; i++) {
      const a = a0 + ((i + b.rng() * 0.6) / n - 0.5) * arc;
      const k = b.r(0.65, 1.1);
      b.color(k, k, k, 4);
      const t = (i + 0.5) / n;
      b.cone(cu + Math.cos(a) * rad, Yf + 0.3 + 2.2 * Math.sin(t * Math.PI) * b.r(0.6, 1), cv + Math.sin(a) * rad, b.r(0.2, 0.45), b.r(0.7, 1.8), {
        rx: -Math.sin(a) * b.r(0.5, 1), rz: Math.cos(a) * b.r(0.5, 1), sides: 4,
      });
    }
    for (let i = 0; i < 6; i++) {
      const a = a0 + b.r(-0.5, 0.5) * arc;
      const k = b.r(0.6, 1.05);
      b.color(k, k, k, 4);
      b.cone(cu + Math.cos(a) * (rad - b.r(0.8, 2)), Yf, cv + Math.sin(a) * (rad - b.r(0.8, 2)), b.r(0.15, 0.35), b.r(0.5, 1.4), { rx: b.r(-0.35, 0.35), rz: b.r(-0.35, 0.35), sides: 4 });
    }
    const lu = cu + Math.cos(a0) * (rad - 1.6);
    const lv = cv + Math.sin(a0) * (rad - 1.6);
    b.light(lu, Yf + 2, lv, 20, 0.9, TEAL);
    b.glow(lu, Yf + 2, lv, 5, [0.22, 0.7, 0.6]);
    for (const t of [-0.3, 0, 0.3]) b.glow(cu + Math.cos(a0 + t * arc) * (rad - 0.4), Yf + 1.6, cv + Math.sin(a0 + t * arc) * (rad - 0.4), 1.8, [0.22, 0.7, 0.6]);
  }

  const built = b.finish({ ledge: [uH0 + 1.5, yL, vP], centre: [C.u, Yh, C.v], relic });
  built.extra.warren = {
    halls: halls.map((h) => ({ role: h.role, u: h.u, v: h.v, a: h.a, b: h.b, floor: h.floor, top: h.top })),
    galleries: galleryPts,
    rooms: rooms.filter((r) => !r.skip).map((r) => [(r.u0 + r.u1) / 2, r.y, (r.v0 + r.v1) / 2]),
    bridges: bridgeMids,
    pools: cistern.pools.map((p) => [p.u, WL, p.v, p.r]),
    flights: flightHeads,
    back: backEnd,
  };
  return built;
}
