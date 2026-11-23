// The carved street: a slot canyon far underground whose walls were cut into house fronts. The
// stair from the hole runs down a dark passage to a ledge across the canyon's near end; the
// canyon bends away from it, widening into a basin, plazas and a court and pinching into gorges,
// its walls fifty or sixty metres of carved fronts that lean together toward the roof. A town
// stands on the floor where it is wide; a high arch and a bridge cross it; and at the far end,
// past an open court, a door forty metres tall under a great geometric mask.
//
// Three ways lead from the ledge to the floor: a broad stair down one wall, a tunnel inside the
// other, and a rockfall worn into a slope below the ledge. Galleries cut into both walls are
// joined by the bridge; rooms open off them and off the floor; alleys run behind the walls and
// come back; side scenes lie at the ends of short passages.

import type { DeepSpec } from './types';
import { DeepBuilder, TEAL, mulberry32, type DeepData } from './builder';
import type { Pt } from './spans';

/** What was built where, local [u, y, v]: for checks. */
export interface StreetLayout {
  ledge: Pt;
  centre: Pt;
  relic: Pt | null;
  stone: Pt | null;
  /** Foot of each route: stair, tunnel, rubble slope. */
  feet: Pt[];
  /** Doorways of enterable buildings (outside, at ground), and their roofs. */
  doors: Pt[];
  roofs: Pt[];
  /** Points on rooftop links. */
  links: Pt[];
  tower: Pt | null;
  /** Points by the landmarks (the figure, the tower's foot, under the arch). */
  landmarks: Pt[];
  /** Side scenes, and their entrances. */
  scenes: Pt[];
  sides: Pt[];
  /** Points along the wall galleries, and on the bridge between them. */
  galleries: Pt[];
  bridges: Pt[];
  /** Rooms cut into the walls (floor, gallery and tunnel levels). */
  rooms: Pt[];
  /** The far lane of each alley that loops behind a wall. */
  alleys: Pt[];
  /** Dense points down each of the three routes: stair, tunnel, rubble slope. */
  routes: Pt[][];
  /** Outside roof stairs: foot then top, in pairs. */
  stairs: Pt[];
}

/** A built deep's layout, for checks: left on it by the build (see DeepData.extra). */
export function streetLayout(d: object): StreetLayout | undefined {
  return (d as { street?: StreetLayout }).street;
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
const plat = (u: number, a: number, z: number, ramp: number): number => smooth((u - a) / ramp) * (1 - smooth((u - z) / ramp));

export function buildStreet(spec: DeepSpec): DeepData {
  const tier = spec.tier;
  const lid = spec.lid;
  const rnd = mulberry32(Math.imul(spec.seed | 0, 0x9e3779b1) ^ 0x57ee7);
  const R = (a: number, c: number): number => a + (c - a) * rnd();
  const even = (x: number): number => Math.round(x / 2) * 2;
  const onV = (x: number): number => Math.round(x / 1.8) * 1.8;
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
  const vn = (x: number, y: number, ch: number): number => vnoise(x + ch * 97.31, y + ch * 53.7);
  const L: StreetLayout = { ledge: [0, 0, 0], centre: [0, 0, 0], relic: null, stone: null, feet: [], doors: [], roofs: [], links: [], tower: null, landmarks: [], scenes: [], sides: [], galleries: [], bridges: [], rooms: [], alleys: [], routes: [[], [], []], stairs: [] };

  // ---- the way in: stair, then a passage with one turn in it, unlit
  const PW = 3.6;
  const L1 = even(R(8, 12));
  const L3 = even(R(8, 12));
  const vP = onV(Math.min(spec.v1 - 72, Math.max(spec.v0 + 72, (rnd() < 0.5 ? -1 : 1) * R(0, 30))));
  const uT = 4 + L1 + 2;
  const uH0 = uT + 2 + L3; // the near end wall
  const uF = even(Math.min(spec.u1 - 42, uH0 + R(250, 292))); // the far end wall: the door
  const Lc = uF - uH0;

  // ---- heights
  const Yc = lid - 1.5;
  const yA = lid - 2.9;
  const yL = Yc - R(11, 14); // the ledge
  const D = Math.min(R(36, 44), (Lc - 110) * 0.46);
  const Yf = yL - D;
  const H = Yc - Yf;
  const yM = yL - D / 2; // the galleries, the stair's landing, the bridge

  const b = new DeepBuilder(spec, { cell: tier === 2 ? 2 : 1, yMin: Yf - 4, maxSpans: 12, wallStep: [2.5, 5, 5][tier] });
  const g = b.grid;

  // ---- along u: the ledge, the rubble slope below it, the basin it falls into
  const LD = 12;
  const uR0 = uH0 + LD;
  const gu = 0.5;
  const uR1 = uR0 + D / gu; // the rubble's foot
  const uB1 = uR1 + 6;
  const RW = 7; // the rubble's walkable top, out from the wall
  const LAND = 6;
  const uS1 = uR0 + 2 * D + LAND; // the stair's foot

  // ---- the outline: a centre line that bends, a width that swells and pinches, walls that wander
  const Bamp = R(10, 18);
  const ph = R(0, 50);
  // (a drift from the ledge to the door, and bends about it held small enough that the door stays in view from the ledge)
  const drift = Bamp * R(-0.8, 0.8);
  const line = (u: number): number => vP + (drift * (u - uH0)) / Math.max(1, uF - uH0);
  const bendMax = (): number => Math.min(8, g0 - 4.5);
  const c = (u: number): number => line(u) + Math.max(-bendMax(), Math.min(bendMax(), Bamp * smooth((u - uH0) / 50) * (vn((u - uH0) / 75 + ph, 0.5, 11) - vn(ph, 0.5, 11)) * 1.6));
  const g0 = R(9.5, 12.5);
  const aB = R(12, 16);
  const doorW = rnd() < 0.5 ? 10 : 12;
  const courtHalf = doorW / 2 + 11;
  const courtLen = 34;
  const aC = Math.max(R(24, 32), courtHalf + 8 - g0);
  let uC0 = uF - R(70, 90); // where the court's plaza opens
  let uP0 = even(uB1 + R(14, 26));
  const uP1 = Math.min(uC0 - 22, uP0 + R(50, 85));
  const aP = uP1 - uP0 >= 30 ? R(24, 32) : 0;
  if (aP === 0) {
    uP0 = -1e4;
    uC0 = Math.max(uB1 + 14, uF - 115);
  }
  const AL = R(3, 7);
  const AH = R(3, 7);
  const wob = (x: number, ch: number): number => (vn(x, 0.5, ch) + 0.5 * vn(x * 2.3, 0.5, ch + 1)) / 1.5;
  const base = (u: number): number => g0 + aB * plat(u, uH0 - 40, uB1, 25) + aP * plat(u, uP0, uP1, 18) + aC * plat(u, uC0, uF + 40, 18);
  const vLim0 = spec.v0 + 16;
  const vLim1 = spec.v1 - 16;
  const wLo = (u: number): number => Math.max(vLim0, c(u) - base(u) - AL * wob(u / 30, 1));
  const wHi = (u: number): number => Math.min(vLim1, c(u) + base(u) + AH * wob(u / 30, 3));
  /** The foot of side s's wall (s = -1 the low-v wall, +1 the high); s points into the rock. */
  const face = (s: number, u: number): number => (s < 0 ? wLo(u) : wHi(u));
  const vMid = onV(c(uF));
  const sA = rnd() < 0.5 ? -1 : 1; // the stair's wall, and gallery A's
  const sB = -sA; // the tunnel's and the rubble's
  const plumb = (u: number): number => D + 5 + (0.62 * H - D - 5) * smooth((u - uB1) / 40);
  const LEAN = R(8, 11);

  // rockfalls against the walls, out in the gorges
  interface Heap { u: number; v: number; r: number; h: number; s: number }
  const heaps: Heap[] = [];
  const claims: [number, number][][] = [[], []];
  const sI = (s: number): number => (s < 0 ? 0 : 1);
  const isFree = (s: number, a: number, z: number): boolean => !claims[sI(s)].some(([x, y]) => a < y && z > x);
  const claim = (s: number, a: number, z: number): void => {
    claims[sI(s)].push([a, z]);
  };
  claim(sA, uH0 - 10, uS1 + 8);
  claim(sB, uH0 - 10, uR1 + 8);
  for (const s of [-1, 1]) claim(s, uF - 12, uF + 10);
  const tunnelExit = even(uR1 + 14);
  claim(sB, tunnelExit - 6, tunnelExit + 12);
  /** An even u where [u, u + len] is free at the foot of side s's wall, with gap either end. */
  const place = (s: number, len: number, gap: number, lo: number, hi: number): number => {
    for (let tries = 0; tries < 60; tries++) {
      const u = even(R(lo, hi - len));
      if (u >= lo && u + len <= hi && isFree(s, u - gap, u + len + gap)) return u;
    }
    return NaN;
  };
  // side scenes, alleys that loop behind a wall, rooms off the floor: decided now, cut later
  interface Spot { s: number; u: number; len: number }
  const alleySpots: Spot[] = [];
  const nA = 2 + (rnd() < 0.4 ? 1 : 0);
  const addAlley = (len: number): void => {
    const s0 = rnd() < 0.5 ? -1 : 1;
    for (const s of [s0, -s0]) {
      const u = place(s, len, 3, uR0, uF - 10);
      if (u !== u) continue;
      claim(s, u - 3, u + len + 3);
      alleySpots.push({ s, u, len });
      return;
    }
  };
  addAlley(even(R(20, 30)));
  const sceneSpots: Spot[] = [];
  for (let i = 0; i < 4; i++) {
    const s0 = rnd() < 0.5 ? -1 : 1;
    for (const s of [s0, -s0]) {
      const u = place(s, 12, 2, uR0, uF - 10);
      if (u !== u) continue;
      claim(s, u - 2, u + 14);
      sceneSpots.push({ s, u: u + 6, len: 12 });
      break;
    }
  }
  for (let i = 1; i < nA; i++) addAlley(even(R(26, 40)));
  const roomSpots: Spot[] = [];
  {
    const nR = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < nR + 3 && roomSpots.length < nR; i++) {
      const s = rnd() < 0.5 ? -1 : 1;
      const u = place(s, 8, 2, uR0, uF - 10);
      if (u !== u) continue;
      claim(s, u - 2, u + 10);
      roomSpots.push({ s, u, len: 8 });
    }
  }
  {
    const nH = 1 + Math.floor(rnd() * 3);
    for (let tries = 0; tries < 30 && heaps.length < nH; tries++) {
      const s = rnd() < 0.5 ? -1 : 1;
      const u = R(uB1 + 10, uF - 70);
      const r = R(7, 11);
      if (!isFree(s, u - r - 4, u + r + 4)) continue;
      claim(s, u - r - 4, u + r + 4);
      heaps.push({ u, v: face(s, u) - s * 2, r, h: R(3, 5), s });
    }
  }

  const ground = (u: number, v: number): number => {
    if (u < uH0 || u > uF) return NaN;
    const lo = wLo(u);
    const hi = wHi(u);
    if (v < lo || v > hi) return NaN;
    let F = Yf;
    const dE = Math.min(v - lo, hi - v);
    const dc = Math.hypot(Math.max(0, uF - courtLen - u), Math.max(0, Math.abs(v - vMid) - courtHalf));
    const m = smooth((dE - 6) / 10) * smooth(dc / 14) * smooth((u - uB1) / 20) * smooth((uF - u - 12) / 14);
    if (m > 0) {
      const n = 0.75 * vn(u / 40, v / 40, 9) + 0.25 * vn(u / 14, v / 14, 10);
      F += m * Math.max(0, 3.6 * n - 1.5);
    }
    for (const h of heaps) {
      const hd = Math.hypot(u - h.u, v - h.v);
      if (hd < h.r) F = Math.max(F, Yf + h.h * (1 - hd / h.r));
    }
    if (u >= uR0 - 1 && u <= uR1 + 2) {
      const d = sB * (face(sB, u) - v); // in from the tunnel's wall
      const S = Math.max(Yf, yL - gu * Math.max(0, u - uR0));
      F = Math.max(F, d < RW ? S : S - 2.5 * (d - RW));
    }
    return F;
  };
  const ceilOf = (u: number, v: number, F: number): number => {
    const dW = Math.min(v - wLo(u), wHi(u) - v);
    const top = Yc - 3.5 * vn(u / 23, v / 23, 6) - 0.8 * vn(u / 9, v / 9, 7);
    const pt = Yf + plumb(u);
    const cc = Math.min(top, pt + (top - pt) * smooth(dW / LEAN));
    const q = 2.5;
    return Math.max(Yf + Math.floor((cc - Yf) / q) * q, Math.ceil((F + 8) / q) * q);
  };

  // ---- carve the passage, then the canyon
  const uEnd = uH0 + 1;
  const Lv = Math.abs(vP);
  const side = vP < 0 ? -1 : 1;
  const Lp = uT - 4 + Lv + (uEnd - uT);
  const yAt = (s: number): number => yA + ((yL - yA) * s) / Lp;
  b.holeStair();
  g.roughNow = 0.12;
  const PH = 2.5;
  if (Lv > 0) {
    g.carveRun([4, yA, 0], [uT, yAt(uT - 4), 0], PW, PH, { cap1: 2, steps: true });
    g.carveRun([uT, yAt(uT - 4), 0], [uT, yAt(uT - 4 + Lv), vP], PW + 0.4, PH, { cap0: 1.8, cap1: 1.8, steps: true });
    g.carveRun([uT, yAt(uT - 4 + Lv), vP], [uEnd, yL, vP], PW, PH, { cap0: 2, steps: true });
  } else {
    g.carveRun([4, yA, 0], [uEnd, yL, vP], PW, PH, { steps: true });
  }
  void side;
  const pave = [b.paint(0.97, 0.95, 0.9, 0), b.paint(0.88, 0.86, 0.82, 0), b.paint(0.8, 0.78, 0.75, 0)];
  g.roughNow = tier === 2 ? 0.35 : 0.25;
  const cu = g.cu;
  g.carveFn(uH0, vLim0, uF, vLim1, (u, v, o) => {
    const F = ground(u, v);
    if (F !== F) return false;
    o.floor = F;
    o.ceil = ceilOf(u, v, F);
    const gx = (ground(u + cu / 2, v) - ground(u - cu / 2, v)) / cu;
    const gz = (ground(u, v + g.cv / 2) - ground(u, v - g.cv / 2)) / g.cv;
    if (gx === gx && gz === gz && Math.abs(gx) < 0.55 && Math.abs(gz) < 0.55 && Math.abs(gx) + Math.abs(gz) > 0.01) {
      o.su = gx;
      o.sv = gz;
    }
    g.paintF = F < Yf + 0.05 ? pave[Math.min(2, Math.floor(hash2(Math.floor(u / 2) + ns, Math.floor(v / 1.8)) * 3.4))] : 0;
    return true;
  });
  g.paintF = 0;
  // the ledge: a shelf along the near end wall, carried on along each wall to the stair and the rubble,
  // and a balcony thrust out over the basin from the passage's mouth
  const balc = (u: number): number => 8 - (2.5 * (u - uH0)) / (uR0 + 4 - uH0); // its half-width
  g.roughNow = 0.08;
  g.fillFn(uH0 - 1, vLim0, uR0 + 4, vLim1, (u, v, o) => {
    const dA = sA * (face(sA, u) - v);
    const dB = sB * (face(sB, u) - v);
    const keep = u <= uH0 + 6 || (u <= uR0 && (dA <= 9 || dB <= RW + 3)) || Math.abs(v - vP) <= balc(u);
    if (!keep) return false;
    o.lo = Yf - 1;
    o.hi = yL;
    return true;
  });

  /** Cells whose middle lies d out into the rock of side s's wall (d0 <= d < d1), over [u0, u1]. */
  const wallEach = (s: number, u0: number, u1: number, d0: number, d1: number, fn: (ci: number, u: number, v: number, d: number) => void, widen = false): void => {
    g.each(u0, vLim0 - 15, u1, vLim1 + 15, (ci, u, v) => {
      const d = s * (v - face(s, u));
      // (where the wall runs slantwise, wide enough that one column's strip still meets the next)
      const w = widen ? Math.abs(face(s, u + g.cu) - face(s, u - g.cu)) * 0.6 : 0;
      if (d >= d0 && d < d1 + w) fn(ci, u, v, d);
    });
  };
  const wallCut = (s: number, u0: number, u1: number, d0: number, d1: number, y0: number, y1: number, widen = false): void =>
    wallEach(s, u0, u1, d0, d1, (ci) => g.carveCell(ci, y0, y1), widen);

  // ---- the stair: two flights down wall A, a landing between
  const SW = 4;
  interface Flight { ua: number; ub: number; y0: number; y1: number }
  const flights: Flight[] = [
    { ua: uR0, ub: uR0 + D, y0: yL, y1: yM },
    { ua: uR0 + D + LAND, ub: uS1, y0: yM, y1: Yf },
  ];
  const stairY = (u: number): number => (u < uR0 ? yL : u < uR0 + D ? yL - (u - uR0) * 0.5 : u < uR0 + D + LAND ? yM : u < uS1 ? yM - (u - uR0 - D - LAND) * 0.5 : Yf);
  const wallRun = (ua: number, ub: number, y0: number, y1: number, steps: boolean): void => {
    const len = ub - ua;
    const n = Math.max(1, Math.ceil(len / 4));
    for (let s = 0; s < n; s++) {
      const t0 = s / n;
      const t1 = (s + 1) / n;
      const us = ua + len * t0;
      const ue = ua + len * t1;
      let fmin = Infinity;
      let fmax = -Infinity;
      for (let q = 0; q <= 4; q++) {
        const f = face(sA, us + ((ue - us) * q) / 4);
        fmin = Math.min(fmin, f);
        fmax = Math.max(fmax, f);
      }
      const va = sA < 0 ? fmin - 1 : fmin - SW;
      const vb = sA < 0 ? fmax + SW : fmax + 1;
      g.fillRun([us, y0 + (y1 - y0) * t0, (va + vb) / 2], [ue, y0 + (y1 - y0) * t1, (va + vb) / 2], vb - va, D + 3, { steps, cap0: s === 0 && ua === uR0 ? 2 : 0 });
    }
  };
  g.roughNow = 0;
  wallRun(flights[0].ua, flights[0].ub, yL, yM, true);
  wallRun(flights[0].ub, flights[1].ua, yM, yM, false);
  wallRun(flights[1].ua, flights[1].ub, yM, Yf, true);
  for (const f of flights) {
    for (let q = 0; q <= 10; q++) {
      const u = f.ua + ((f.ub - f.ua) * q) / 10;
      L.routes[0].push([u, f.y0 + ((f.y1 - f.y0) * q) / 10, face(sA, u) - sA * 1.8]);
    }
  }
  L.feet.push([uS1 + 1.5, Yf, face(sA, uS1 + 1.5) - sA * 2]);

  // ---- the tunnel: a stair cut inside wall B's rock, level at the bottom until past the rubble
  const vtun = (u: number): number => face(sB, u) + sB * 4.5;
  const props: (() => void)[] = []; // dressing, done once the carving is over
  let lookout: Pt | null = null;
  {
    const uD = even(uH0 + 3);
    g.roughNow = 0.05;
    const eB = face(sB, uD);
    const [vi0, vi1] = sB < 0 ? [eB - 6.4, eB + 3] : [eB - 3, eB + 6.4];
    g.carveBox(uD - 2, vi0, uD + 2, vi1, yL, yL + 2.8);
    props.push(() => b.lamp(uD - 1.5, yL + 2.4, eB - sB * 1, { reach: 14, strength: 0.9 }));
    let uc = uD + 2;
    let yc = yL;
    const path: [number, number][] = [];
    while (uc < tunnelExit) {
      const ln = yc > Yf + 1e-6 ? Math.min(4, (yc - Yf) / 0.5) : Math.min(4, tunnelExit - uc);
      const un = uc + ln;
      const yn = Math.max(Yf, yc - 0.5 * ln);
      let vmin = Infinity;
      let vmax = -Infinity;
      for (let q = 0; q <= 4; q++) {
        const v = vtun(uc + (ln * q) / 4);
        vmin = Math.min(vmin, v);
        vmax = Math.max(vmax, v);
      }
      const vm = (vmin + vmax) / 2;
      g.carveRun([uc, yc, vm], [un, yn, vm], 3.6 + (vmax - vmin), 2.8, { steps: yn < yc });
      path.push([uc, yc]);
      L.routes[1].push([uc + ln / 2, (yc + yn) / 2, vm]);
      uc = un;
      yc = yn;
    }
    const ue = uc;
    const e = face(sB, ue);
    if (sB < 0) g.carveBox(ue, e - 6.4, ue + 4, e + 3, Yf, Yf + 2.8);
    else g.carveBox(ue, e - 3, ue + 4, e + 6.4, Yf, Yf + 2.8);
    L.feet.push([ue + 2, Yf, face(sB, ue + 2) - sB * 2.5]);
    for (let i = 3; i < path.length; i += tier === 2 ? 14 : 8) {
      const [pu, py] = path[i];
      props.push(() => b.lamp(pu, py + 2.4, vtun(pu) - sB * 1.6, { reach: 12, strength: 0.7 }));
    }
    // a lookout off it, a third of the way down: a room open to the canyon
    const ul = even(uD + 2 + (D / 3) / 0.5);
    const yl = yL - (ul - uD - 2) * 0.5;
    if (ul + 8 < tunnelExit) {
      g.roughNow = 0.1;
      // (its floor falls with the tunnel's, so where the two meet neither is changed)
      const tf = (u: number): number => yL - (u - uD - 2) * 0.5;
      wallEach(sB, ul - 3, ul + 3, 0, 4.6, (ci, u) => g.carveCell(ci, tf(u), tf(u) + 3.2, -0.5, 0, true));
      lookout = [ul, yl, face(sB, ul) + sB * 1.4];
      L.scenes.push(lookout);
      L.rooms.push(lookout);
      props.push(() => b.lamp(ul, yl + 2.6, face(sB, ul) + sB * 3.5, { reach: 14, strength: 0.8 }));
    }
  }

  // ---- the rubble slope
  for (let u = uR0; u <= uR1; u += 3) L.routes[2].push([u, ground(u, face(sB, u) - sB * 3.5), face(sB, u) - sB * 3.5]);
  L.feet.push([uR1 + 4, Yf, face(sB, uR1 + 4) - sB * 3.5]);

  // ---- the bridge, where the canyon pinches, and the galleries cut into both walls to meet it
  let uBr = even(uR1 + 22);
  {
    let best = Infinity;
    for (let u = even(uR1 + 22); u <= Math.min(uF - 64, uR1 + 96); u += 2) {
      let w = 0;
      for (let q = 0; q <= 4; q++) w = Math.max(w, wHi(u + q) - wLo(u + q));
      if (w < best) { best = w; uBr = u; }
    }
  }
  const uGA0 = uR0 + D - 1;
  const uGA1 = uBr + 4;
  const uGB0 = uBr;
  const uGB1 = even(Math.min(uF - courtLen - 8, uBr + R(36, 64)));
  const rough0 = 0.05;
  g.roughNow = rough0;
  const GWd = tier === 2 ? 3 : 2.4;
  wallCut(sA, uGA0, uGA1, 0, GWd, yM, yM + 3.2, true);
  wallCut(sB, uGB0, uGB1, 0, GWd, yM, yM + 3.2, true);
  wallEach(sA, uS1 + 2, uGA1, -1.2, 0, (ci) => g.fillCell(ci, yM - 0.7, yM));
  wallEach(sB, uGB0, uGB1, -1.2, 0, (ci) => g.fillCell(ci, yM - 0.7, yM));
  g.each(uBr, vLim0, uBr + 4, vLim1, (ci, u, v) => {
    if (v >= wLo(u) && v <= wHi(u)) g.fillCell(ci, yM - 1.4, yM);
  });
  L.bridges.push([uBr + 2, yM, (wLo(uBr + 2) + wHi(uBr + 2)) / 2]);
  for (const t of [0.15, 0.5, 0.95]) {
    const u = uGA0 + 2 + (uGA1 - uGA0 - 4) * t;
    L.galleries.push([u, yM, face(sA, u) + sA * 1.2]);
  }
  for (const t of [0.1, 0.5, 0.9]) {
    const u = uGB0 + 2 + (uGB1 - uGB0 - 4) * t;
    L.galleries.push([u, yM, face(sB, u) + sB * 1.2]);
  }
  // rooms behind the galleries
  const roomLamps: Pt[] = [];
  const room = (s: number, ur: number, y: number, h: number, door0: number): void => {
    g.roughNow = 0.06;
    wallCut(s, ur + 2, ur + 4, door0, 4.5, y, y + Math.min(h, 3));
    wallCut(s, ur, ur + 6, 4.4, 10, y, y + h);
    const vr = face(s, ur + 3) + s * 6.5;
    L.rooms.push([ur + 3, y, vr]);
    roomLamps.push([ur + 1, y, face(s, ur + 1) + s * 8.5]);
  };
  for (let u = even(uGA0 + 8); u + 8 < uGA1 - 4; u += 16) room(sA, u, yM, 3.4, 2.3);
  for (let u = even(uGB0 + 8); u + 8 < uGB1; u += 16) room(sB, u, yM, 3.4, 2.3);
  for (const r of roomSpots) room(r.s, r.u + 1, Yf, 4.2, 0);

  // ---- the arch, high over a gorge
  let uAr = NaN;
  {
    let best = Infinity;
    for (let u = even(uB1 + 8); u <= uF - courtLen - 16; u += 2) {
      if (Math.abs(u - uBr) < 26) continue;
      const w = wHi(u + 2) - wLo(u + 2);
      if (w < best) { best = w; uAr = u; }
    }
  }
  const yAr = Yc - 5.5; // (high, over the line from the ledge to the mask)
  if (uAr === uAr) {
    g.roughNow = 0.1;
    g.paintF = pave[1];
    g.each(uAr, vLim0, uAr + 5, vLim1, (ci, u, v) => {
      const lo = wLo(u);
      const hi = wHi(u);
      if (v < lo || v > hi) return;
      const dE = Math.min(v - lo, hi - v);
      g.fillCell(ci, yAr - 2.5 - 9 * (1 - smooth(dE / 9)), yAr);
    });
    g.paintF = 0;
    L.landmarks.push([uAr + 2, Yf, c(uAr + 2)]);
  }

  // ---- alleys that leave the canyon and come back to it behind the wall
  for (const a of alleySpots) {
    const hA = R(7, 11);
    g.roughNow = 0.15;
    g.paintF = pave[2];
    wallCut(a.s, a.u, a.u + 4, 0, 12.5, Yf, Yf + hA, true);
    wallCut(a.s, a.u + a.len - 4, a.u + a.len, 0, 12.5, Yf, Yf + hA, true);
    wallCut(a.s, a.u, a.u + a.len, 8.4, 12.5, Yf, Yf + hA - 2, true);
    g.paintF = 0;
    const um = even(a.u + a.len / 2);
    L.alleys.push([um, Yf, face(a.s, um) + a.s * 10.5]);
    roomLamps.push([um, Yf, face(a.s, um) + a.s * 11.8]);
  }

  // ---- the facades: houses side by side up both walls, storey over storey of dark windows
  const SY = 6;
  const litCand: number[] = [];
  const trims: number[] = []; // s, u, y0, y1, kind
  {
    const skip = (s: number, u: number, y0: number, y1: number): boolean => {
      if (u < uR0 + 1 || u > uF - 4) return true;
      if (y1 > Yf + plumb(u) - 2) return true;
      if (s === sA && u > uR0 - 3 && u < uS1 + 3 && y0 < stairY(u) + 4) return true;
      if (s === sB && u < uR1 + 4 && y0 < Math.max(Yf, yL - gu * (u - uR0)) + 4) return true;
      if (s === sB && lookout && Math.abs(u - lookout[0]) < 6 && y1 > lookout[1] - 1 && y0 < lookout[1] + 4) return true;
      const galA = s === sA && u > uGA0 - 3 && u < uGA1 + 3;
      const galB = s === sB && u > uGB0 - 3 && u < uGB1 + 3;
      if ((galA || galB) && y1 > yM - 1.4 && y0 < yM + 4.4) return true;
      if (uAr === uAr && u > uAr - 4 && u < uAr + 9 && y1 > yAr - 13) return true;
      if (heaps.some((h) => h.s === s && Math.abs(u - h.u) < h.r + 1 && y0 < Yf + h.h + 2)) return true;
      return false;
    };
    for (const s of [-1, 1]) {
      let x = even(uR0 + 2);
      let hi = 0;
      while (x + 10 < uF - 4) {
        const hb = (x * 31 + (s > 0 ? 7 : 0) + ns * 13) | 0;
        const nBay = 2 + Math.floor(hash2(hb, 1) * 4);
        const pat = Math.floor(hash2(hb, 2) * 3);
        const tall = hash2(hb, 3) < 0.4;
        trims.push(s, x, Yf, Yf + plumb(x) - 3, hi % 2);
        for (let k = 0; k * SY + 4 < plumb(x); k++) {
          const y = Yf + k * SY;
          if (k > 0 && hash2(hb, k * 13 + 5) < 0.08) continue;
          for (let j = 0; j < nBay; j++) {
            if (pat === 1 && (j + k) % 2 === 1) continue;
            if (pat === 2 && j % 3 === 2) continue;
            if (tier === 2 && j % 2 === 1 && pat !== 1) continue;
            const wu = x + 2 + j * 4;
            if (k === 0) {
              if (hash2(hb + j * 17, 7) > 0.35 || !isFree(s, wu - 1, wu + 3) || skip(s, wu, y, y + 3)) continue;
              wallCut(s, wu, wu + 2, 0, 1.8, y, y + 2.8);
              continue;
            }
            const lo = y + (tall ? 1.2 : 1.6);
            const hi2 = y + (tall ? 3.8 : 3.2);
            if (skip(s, wu, lo, hi2)) continue;
            g.roughNow = 0.04;
            wallCut(s, wu, wu + 2, 0, tier < 2 && hash2(hb + j, k) < 0.3 ? 1.8 : g.cv * 1.01, lo, hi2);
            if (k <= 6) litCand.push(wu + 1, lo, face(s, wu + 1) + s * 0.45);
          }
          if (k > 0) trims.push(s, x, y, y, 2 + nBay);
        }
        x += 2 + nBay * 4;
        hi++;
      }
    }
  }

  // ---- pillars: natural columns, floor to roof, out where the canyon is wide
  const pillars: [number, number, number][] = [];
  {
    const nP = 2 + Math.floor(rnd() * 3);
    for (let tries = 0; tries < 200 && pillars.length < nP; tries++) {
      const u = R(uB1 + 10, uF - courtLen - 14);
      const v = R(wLo(u) + 8, wHi(u) - 8);
      const r = R(2.5, 5);
      if (Math.min(v - wLo(u), wHi(u) - v) < r + 9 || Math.abs(v - c(u)) < r + 4 || Math.abs(v - line(u)) < r + 5) continue;
      if (Math.abs(u - uBr - 2) < r + 6 || (uAr === uAr && Math.abs(u - uAr - 2) < r + 6)) continue;
      let flat = true;
      for (let q = 0; q < 8 && flat; q++) {
        const F = ground(u + Math.cos(q * 0.785) * (r + 4), v + Math.sin(q * 0.785) * (r + 4));
        if (!(F < Yf + 3)) flat = false;
      }
      if (!flat || pillars.some((p) => Math.hypot(p[0] - u, p[1] - v) < p[2] + r + 24)) continue;
      pillars.push([u, v, r]);
    }
    g.roughNow = 0.5;
    for (const [pu, pv, pr] of pillars) {
      for (let q = 0; q < 3; q++) {
        const y0 = q === 0 ? Yf - 1 : Yf + (H * q) / 3;
        const y1 = q === 2 ? Yc + 1 : Yf + (H * (q + 1)) / 3;
        g.fillCyl(pu, pv, pr * [1.25, 0.8, 1.15][q] * (0.9 + 0.2 * rnd()), y0, y1, 0.05);
      }
    }
  }

  // ---- the great door in the far end wall: a podium and its steps, the door, the sanctum behind
  const yD = Yf + 2;
  const Dh = Math.min(Math.round(R(30, 40) * 2) / 2, Yc - 6 - 18 - yD);
  const yM0 = yD + Dh; // the door's head: the mask stands on it
  const podHalf = doorW / 2 + 8;
  const RS = 2;
  {
    g.roughNow = 0.06;
    g.paintF = pave[0];
    g.fillBox(uF - 7, vMid - podHalf, uF, vMid + podHalf, Yf - 1, yD);
    g.roughNow = 0;
    g.fillRun([uF - 7 - RS / 0.5, Yf, vMid], [uF - 7, yD, vMid], podHalf * 2, RS + 1, { steps: true });
    g.roughNow = 0.06;
    g.carveBox(uF, vMid - doorW / 2 - 2.7, uF + 2, vMid + doorW / 2 + 2.7, yD, yD + Dh + 2.5);
    g.carveBox(uF, vMid - doorW / 2, uF + 6, vMid + doorW / 2, yD, yD + Dh);
    g.paintF = pave[1];
    const hallTop = yD + Math.min(Dh + 4, Yc - 4 - yD);
    g.carveBox(uF + 6, vMid - 13, uF + 36, vMid + 13, yD, hallTop);
    g.paintF = 0;
    for (let i = 0; i < 3; i++) {
      for (const s of [-1, 1]) g.fillBox(uF + 12 + i * 8 - 1.2, vMid + s * 7.5 - 1.2, uF + 12 + i * 8 + 1.2, vMid + s * 7.5 + 1.2, yD - 1, hallTop + 1);
    }
    // rings cut into the wall about the mask, and the mask's own hollows
    const yR = yM0 + 8;
    const rings = tier === 2 ? [[13.6, 3], [19.6, 3]] : [[13.2, 2.6], [17.4, 2.6], [21.6, 2.6]];
    const yMax = Yc - 3;
    const rowU = uF + cu * 0.5;
    for (let v = vMid - 25 + g.cv / 2; v < vMid + 25; v += g.cv) {
      const ci = g.cell(rowU, v);
      if (ci < 0) continue;
      const dv = Math.abs(v - vMid);
      for (const [r, w] of rings) {
        const ro = r + w / 2;
        const ri = r - w / 2;
        if (dv >= ro) continue;
        const yo = Math.sqrt(ro * ro - dv * dv);
        const yi = dv < ri ? Math.sqrt(ri * ri - dv * dv) : 0;
        const arcs = yi > 0 ? [[yR + yi, yR + yo], [yR - yo, yR - yi]] : [[yR - yo, yR + yo]];
        for (const [lo, hi] of arcs) {
          const a = Math.max(lo, yD + Dh + 2.6);
          const z = Math.min(hi, yMax);
          if (z - a >= 0.5) g.carveCell(ci, a, z);
        }
      }
    }
    // deep square eyes, a slot of a mouth, a sunk band across the brow
    for (const s of [-1, 1]) g.carveBox(uF, vMid + s * 4 - 2.2, uF + 4.5, vMid + s * 4 + 2.2, yM0 + 7, yM0 + 10.6);
    g.carveBox(uF, vMid - 3.6, uF + 2.7, vMid + 3.6, yM0 + 3, yM0 + 4.4);
    g.carveBox(uF, vMid - 7, uF + 1, vMid + 7, yM0 + 14.6, yM0 + 15.6);
  }
  // light from above: a shaft over the court
  b.skyShaft(uF - R(22, 34), vMid + R(-5, 5), R(5, 7), 1);
  b.skyShaft(uF - 8, vMid, 3.6, 0.8); // (straight down the face of the mask)
  // and over the town: the middle plaza (or the gorge's mouth), and the foot of the basin
  {
    const u1s = aP > 0 ? (uP0 + uP1) / 2 : (uB1 + uC0) / 2;
    const u2s = uR0 + D * 1.3;
    for (const us of [u1s, u2s]) {
      if (Math.abs(us - uBr - 2) < 12 || (uAr === uAr && Math.abs(us - uAr - 2) < 12)) continue;
      b.skyShaft(us, c(us), R(4.5, 6.5), 0.9);
    }
  }
  b.stone(uF + 34, yD, vMid, 0);
  L.centre = [uF + 1, yD, vMid];
  L.stone = [uF + 32.4, yD + 1.6, vMid];
  const relicInTemple = hash2(ns, 99) < 0.5;
  if (spec.relic && relicInTemple) L.relic = [uF + 9, yD + 1.6, vMid];
  props.push(() => {
    // the mask, built out from the wall over the door: blocks, not a face
    const fbox = (v: number, y: number, proj: number, sv: number, sy: number, tilt = 0): void =>
      b.box(uF - (proj / 2 - 0.1), y, v, proj + 0.2, sy, sv, 0, { rx: tilt });
    const pale = (): void => b.color(1, 0.97, 0.9, 1);
    const dark = (): void => b.color(0.42, 0.39, 0.36, 0);
    const ochre = (): void => b.color(0.72, 0.36, 0.22, 2);
    pale();
    fbox(vMid, yM0, 2.2, doorW + 8, 2); // the lintel
    fbox(vMid, yM0 + 12.4, 2.6, 14, 2.2); // the forehead
    fbox(vMid, yM0 + 5, 2.6, 2.4, 5.6); // the nose, a bar
    fbox(vMid, yM0 + 4.4, 3.4, 3.8, 1.1); // and its foot
    for (const s of [-1, 1]) {
      fbox(vMid + s * 4.2, yM0 + 10.6, 3.4, 6, 1.5, -s * 0.15); // brows, drawn down to the nose
      fbox(vMid + s * 11.5, yM0 + 4.4, 2, 2, 8); // the sides of the head
    }
    fbox(vMid, yM0 + 16.2, 1.8, 14, 0.8); // a stepped crown
    fbox(vMid, yM0 + 17, 2.2, 8, 0.7);
    dark();
    for (const s of [-1, 1]) {
      fbox(vMid + s * 4, yM0 + 6.3, 1.6, 4.8, 0.6); // a lid under each eye
      fbox(vMid + s * 10, yM0 + 2, 1.4, 1.2, 14.2); // the frame's uprights
    }
    fbox(vMid, yM0 + 2, 2.2, 8, 0.9); // the chin
    fbox(vMid, yM0 + 15.6, 1.2, 21.2, 0.6); // the frame's head
    ochre();
    for (const s of [-1, 1]) {
      fbox(vMid + s * 6.6, yM0 + 4.4, 1.8, 3.2, 2.2); // cheeks
      fbox(vMid + s * 4, yM0 + 14.6, 1.4, 2.4, 1); // studs in the brow band
    }
    // teal in the eyes; lamps on the frame raking across the face; a wash from the court
    for (const s of [-1, 1]) {
      b.light(uF + 1.5, yM0 + 8.8, vMid + s * 4, 12, 1.3, TEAL);
      b.glow(uF + 2.5, yM0 + 8.8, vMid + s * 4, 1.8, [0.22, 0.7, 0.6]);
      b.glow(uF + 2.5, yM0 + 8.8, vMid + s * 4, 4.5, [0.08, 0.28, 0.24]);
      b.lamp(uF - 1.6, yM0 + 16.8, vMid + s * 10, { reach: 26, strength: 1.3, size: 1.5 });
      b.lamp(uF - 2.2, yM0 + 2.6, vMid + s * (doorW / 2 + 3), { reach: 20, strength: 1.1 });
    }
    b.light(uF - 16, yM0 + 6, vMid, 40, 1.1);
    b.light(uF - 30, yM0 + 12, vMid, 50, 0.8);
    b.color(0.92, 0.9, 0.86, 0);
    const n = Math.ceil(Dh / 5);
    for (let i = 0; i < n; i++) {
      const y0 = yD + (Dh * i) / n;
      for (const s of [-1, 1]) {
        fbox(vMid + s * (doorW / 2 + 1.1), y0, 1, 2, Dh / n);
        if (tier < 2) fbox(vMid + s * (doorW / 2 + 3.2), y0, 0.45, 1.2, Dh / n);
      }
    }
    for (const s of [-1, 1]) {
      const bu = uF - 3.5;
      const bv = vMid + s * (doorW / 2 + 3.6);
      b.color(0.95, 0.95, 0.95, 0);
      b.cyl(bu, yD, bv, 0.7, 1.3, { solid: true });
      b.cyl(bu, yD + 1.3, bv, 0.75, 0.5, { top: 1.6 });
      b.lamp(bu, yD + 2.3, bv, { reach: 46, strength: 1.6, size: 2.6, body: false });
      b.lamp(uF + 3.8, yD + 0.9, vMid + s * (doorW / 2 - 0.9), { reach: 30, strength: 1.4, size: 1.8 });
    }
    b.light(uF + 4.6, yD + 11, vMid, 26, 0.9);
    if (tier < 2) b.light(uF + 4.6, yD + 23, vMid, 24, 0.7);
    b.light(uF - 7, yM0 + 1, vMid, 34, 1.1);
    b.lamp(uF + 20, yD + 3, vMid, { reach: 18, strength: 0.8 });
    if (L.relic) {
      const ru = uF + 9;
      b.color(0.9, 0.88, 0.84, 0);
      b.box(ru, yD, vMid, 2.2, 0.4, 2.2, 0, { solid: true });
      b.cyl(ru, yD + 0.4, vMid, 0.62, 0.75, { solid: true });
      b.cyl(ru, yD + 1.15, vMid, 0.48, 0.14);
    }
  });

  // ---- the sunken town: lots on a grid over the floor, clear of the court, the pillars and the feet of the routes
  const PU = 20;
  const PV = 14.4;
  const uL0 = even(uR0 + 10);
  const vL0 = onV(vLim0);
  const nI = Math.floor((uF - 14 - uL0) / PU);
  const nJ = Math.floor((vLim1 - vL0) / PV);
  interface Lot { i: number; j: number; u: number; v: number; ok: boolean; used: boolean; score: number }
  const lots: Lot[] = [];
  const lotAt = (i: number, j: number): Lot | undefined => (i < 0 || j < 0 || i >= nI || j >= nJ ? undefined : lots[i * nJ + j]);
  const keepClear: [number, number, number][] = [
    ...L.feet.map((p): [number, number, number] => [p[0], p[2], 10]),
    ...sceneSpots.map((sp): [number, number, number] => [sp.u, face(sp.s, sp.u) - sp.s * 3, 6]),
    ...alleySpots.flatMap((a): [number, number, number][] => [[a.u + 2, face(a.s, a.u + 2) - a.s * 2, 5], [a.u + a.len - 2, face(a.s, a.u + a.len - 2) - a.s * 2, 5]]),
    ...roomSpots.map((r): [number, number, number] => [r.u + 4, face(r.s, r.u + 4) - r.s * 2, 4]),
    ...L.routes[2].filter((p) => p[1] < Yf + 5).map((p): [number, number, number] => [p[0], p[2], 7]),
    ...heaps.map((h): [number, number, number] => [h.u, h.v, h.r - 4]),
  ];
  const nClear = keepClear.length;
  keepClear.push(...L.routes[0].map((p): [number, number, number] => [p[0], p[2], 7])); // (the great stair, last: pads keep a narrower berth)
  for (let i = 0; i < nI; i++) {
    for (let j = 0; j < nJ; j++) {
      const u = uL0 + i * PU;
      const v = vL0 + j * PV;
      let ok = true;
      for (let q = 0; q < 9 && ok; q++) {
        const F = ground(u + 1 + (q % 3) * 8, v + 0.5 + Math.floor(q / 3) * 6.2);
        if (!(F < Yf + 3.4)) ok = false;
      }
      const cx = u + PU / 2;
      const cz = v + PV / 2;
      if (cx + PU / 2 > uF - courtLen - 4 && Math.abs(cz - vMid) < courtHalf + 4 + PV / 2) ok = false;
      if (pillars.some((p) => Math.hypot(p[0] - cx, p[1] - cz) < p[2] * 1.4 + 4)) ok = false;
      if (keepClear.some((p) => Math.hypot(p[0] - cx, p[1] - cz) < p[2] + 8)) ok = false;
      // the lane down the canyon stays open, and nothing tall goes under the bridge
      for (let uu = u; uu <= u + PU && ok && u + PU > uB1 + 8; uu += 4) if (Math.abs(c(uu) - cz) < PV / 2 + 1.5) ok = false;
      if (u < uBr + 10 && u + PU > uBr - 6) ok = false;
      const side = Math.min(1, Math.abs(cz - c(cx)) / 30);
      lots.push({ i, j, u, v, ok, used: false, score: 0.6 * side + 0.5 * (1 - (cx - uL0) / (uF - uL0)) + 0.55 * rnd() });
    }
  }
  const free = (): Lot[] => lots.filter((l) => l.ok && !l.used);
  const mid = (l: Lot): [number, number] => [l.u + PU / 2, l.v + PV / 2];
  const nearest = (u: number, v: number, among: Lot[]): Lot | undefined => {
    let best: Lot | undefined;
    let bd = Infinity;
    for (const l of among) {
      const [cx, cz] = mid(l);
      const d = Math.hypot(cx - u, cz - v);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  };
  const groundMax = (u0: number, v0: number, u1: number, v1: number): number => {
    let m = -Infinity;
    for (let a = 0; a <= 3; a++) for (let c = 0; c <= 3; c++) m = Math.max(m, ground(u0 + ((u1 - u0) * a) / 3, v0 + ((v1 - v0) * c) / 3));
    return m;
  };
  const roofP = b.paint(0.9, 0.8, 0.6, 2);
  const lampsTown: (() => void)[] = [];

  const rectHitsPillar = (u0: number, v0: number, u1: number, v1: number): boolean => pillars.some((p) => Math.hypot(Math.max(u0 - p[0], 0, p[0] - u1), Math.max(v0 - p[1], 0, p[1] - v1)) < p[2] * 1.45 + 4);
  // houses off the lot grid: a pad levelled beside the lane wherever the floor is free, its mounds cut back in gentle slopes
  const pads: [number, number, number, number][] = [];
  const findPad = (len: number, dep: number, from: number): { x: number; s: number; vIn: number; vOut: number; level: () => void; release: () => void } | null => {
    for (let x = even(Math.max(uR0 + 10, from)); x + len + 2 < uF - 8; x += 2) {
      for (const s of [1, -1]) {
        for (const off of [3, 5, 7, 9, 11, 14, 17, 20, 24, 28, 32, 36]) {
          let cm = s > 0 ? -Infinity : Infinity;
          for (let u = x - 2; u <= x + len + 2; u += 2) cm = s > 0 ? Math.max(cm, c(u)) : Math.min(cm, c(u));
          const vSt = cm + s * off; // the apron's lane-side edge
          const vIn = onV(vSt + s * 1.8); // the houses' lane-side face
          const vOut = vIn + s * dep;
          const va = Math.min(vSt, vOut) - 1;
          const vb = Math.max(vSt, vOut) + 1;
          const x0 = x - 2;
          const x1 = x + len + 2;
          const M = 10; // the ramp down to the pad, round it
          const dRect = (p: readonly number[], pu: number, pv: number): number => Math.hypot(Math.max(x0 - pu, 0, pu - x1), Math.max(va - pv, 0, pv - vb));
          if (pillars.some((p) => dRect(p, p[0], p[1]) < p[2] * 1.3 + 2)) continue;
          if (pads.some((q) => q[0] < x1 + 4 && q[1] > x0 - 4 && q[2] < vb + 4 && q[3] > va - 4)) continue;
          if (x1 > uF - courtLen - 4 && va < vMid + courtHalf + 3 && vb > vMid - courtHalf - 3) continue; // the court
          let ok = true;
          for (let u = x0; u <= x1 && ok; u += 2) {
            for (let v = va; v <= vb && ok; v += 1.8) if (!(ground(u, v) < Yf + 2.8)) ok = false;
          }
          if (!ok || lots.some((l) => l.used && l.u < x1 && l.u + PU > x0 && l.v < vb && l.v + PV > va)) continue;
          if (keepClear.some((p, k) => dRect(p, p[0], p[1]) < (k < nClear ? p[2] + 2 : 4.5))) continue;
          if ([...L.doors, ...L.stairs].some((p) => dRect(p, p[0], p[2]) < 3)) continue;
          const took = lots.filter((l) => !l.used && l.u < x1 && l.u + PU > x0 && l.v < vb && l.v + PV > va);
          for (const l of took) l.used = true;
          const me: [number, number, number, number] = [x0, x1, va, vb];
          pads.push(me);
          const level = (): void => {
          g.roughNow = 0.2;
          g.carveFn(x0 - M, va - M, x1 + M, vb + M, (u, v, o) => {
            const F = ground(u, v);
            if (F !== F || pillars.some((p) => Math.hypot(p[0] - u, p[1] - v) < p[2] * 1.4 + 1)) return false;
            if (lots.some((l) => l.used && !took.includes(l) && u > l.u && u < l.u + PU && v > l.v && v < l.v + PV)) return false;
            if (pads.some((q) => q !== me && u > q[0] && u < q[1] && v > q[2] && v < q[3])) return false;
            if (u > uF - courtLen - 2 && Math.abs(v - vMid) < courtHalf + 1) return false; // the court
            if (u < uR1 + 4 && sB * (face(sB, u) - v) < RW + 2.5 * Math.max(0, yL - gu * (u - uR0) - Yf) / 2.5 + 3) return false; // the rubble
            if (u > uR0 - 3 && u < uS1 + 3 && sA * (face(sA, u) - v) < SW + 3) return false; // the great stair
            const du = Math.max(x0 - u, 0, u - x1) * (u < x0 ? -1 : 1);
            const dv = Math.max(va - v, 0, v - vb) * (v < va ? -1 : 1);
            const d = Math.hypot(du, dv);
            const y = Yf + 0.3 * d;
            if (y >= F - 0.01) return false;
            o.floor = y;
            o.ceil = y + 3;
            if (d > 0.01) {
              o.su = (0.3 * du) / d;
              o.sv = (0.3 * dv) / d;
            }
            return true;
          });
          };
          const release = (): void => {
            for (const l of took) l.used = false;
            pads.splice(pads.indexOf(me), 1);
          };
          return { x, s, vIn, vOut, level, release };
        }
      }
    }
    return null;
  };
  // two lots side by side held back, so the town has at least one pair of houses joined at the roof
  let held: [Lot, Lot] | null = null;
  for (const pass of [0, 1]) {
    for (const l1 of lots) {
      if (held || (pass === 0 && l1.u < uB1)) continue;
      const l2 = lotAt(l1.i + 1, l1.j);
      if (l1.ok && !l1.used && l2 && l2.ok && !l2.used) held = [l1, l2];
    }
  }
  if (held) held[0].used = held[1].used = true;
  const compactTower = (va: number, U: (x: number) => number, yPad = NaN): void => {
    const box = (x0: number, x1: number, v0: number, v1: number, y0: number, y1: number): void => g.fillBox(Math.min(U(x0), U(x1)), va + v0, Math.max(U(x0), U(x1)), va + v1, y0, y1);
    const yB = yPad === yPad ? yPad : Math.round(ground(U(-1), va + 1.8) * 4) / 4;
    g.roughNow = 0.1;
    g.paintF = roofP;
    g.fillRun([U(2), yB, va + 1.8], [U(14), yB + 6, va + 1.8], 3.6, 10, { steps: true, cap0: 2 });
    box(14, 18, 0, 3.6, yB - 4, yB + 6);
    g.fillRun([U(16), yB + 6, va + 3.6], [U(16), yB + 9.6, va + 10.8], 4, 14, { steps: true });
    box(14, 18, 10.8, 14.4, yB - 4, yB + 9.6);
    g.fillRun([U(14), yB + 9.6, va + 12.6], [U(6), yB + 13.6, va + 12.6], 3.6, 18, { steps: true });
    box(2, 6, 7.2, 14.4, yB - 4, yB + 13.6);
    g.paintF = 0;
    L.tower = [U(4), yB + 13.6, va + 11];
    L.doors.push([U(0.5), yB, va + 1.8]);
    L.landmarks.push([U(0.5), yB, va + 1.8]);
    lampsTown.push(() => b.lamp(U(0.8), yB + 1.2, va + 0.4, { reach: 16 }), () => b.lamp(U(3), yB + 14.6, va + 8, { reach: 24, strength: 1.2 }));
  };
  // the tower you can climb: three flights round a void, a platform at the top
  for (let attempt = 0; attempt < 2 && !L.tower; attempt++) {
    if (attempt === 1) {
      if (!held) break;
      held[0].used = held[1].used = false; // (the tower matters more)
      held = null;
    }
    const fits = (l: Lot, west: boolean): boolean => {
      if (l.u < uR0 + D * 0.7) return false;
      const n = lotAt(l.i, l.j + 1); const w = lotAt(l.i - 1, l.j); return !!n && n.ok && !n.used && (!west || (!!w && w.ok)) && ground(l.u - 4, l.v + 1.8) < Yf + 3.4 && ground(l.u - 4, l.v + 25) < Yf + 3.4 && !rectHitsPillar(l.u - 6, l.v - 3, l.u + 18, l.v + 29); };
    const tv = c(uB1 + 30) + R(-20, 20);
    // prefer a lot with an open lot to the west for the stair foot; if the town has none, any lot whose west edge is low ground will do
    const lt = nearest(uB1 + 30, tv, free().filter((l) => fits(l, true))) ?? nearest(uB1 + 30, tv, free().filter((l) => fits(l, false)));
    if (lt) {
      lt.used = true;
      lotAt(lt.i, lt.j + 1)!.used = true;
      const wl = lotAt(lt.i - 1, lt.j);
      if (wl) wl.used = true; // (kept open before its door)
      const ua = lt.u;
      const va = lt.v;
      const yB = Math.round(ground(ua - 1, va + 1.8) * 4) / 4;
      g.roughNow = 0.1;
      g.paintF = roofP;
      g.fillRun([ua, yB, va + 1.8], [ua + 12, yB + 6, va + 1.8], 3.6, 10, { steps: true });
      g.fillBox(ua + 12, va, ua + 16, va + 3.6, yB - 4, yB + 6);
      g.fillRun([ua + 14, yB + 6, va + 3.6], [ua + 14, yB + 15, va + 21.6], 4, 20, { steps: true });
      g.fillBox(ua + 12, va + 21.6, ua + 16, va + 25.2, yB, yB + 15);
      g.fillRun([ua + 12, yB + 15, va + 23.4], [ua + 4, yB + 19, va + 23.4], 3.6, 26, { steps: true });
      g.fillBox(ua, va + 18, ua + 4, va + 25.2, yB + 3, yB + 19);
      g.paintF = 0;
      L.tower = [ua + 2, yB + 19, va + 23];
      L.doors.push([ua - 1.5, yB, va + 1.8]);
      L.landmarks.push([ua - 1.5, yB, va + 1.8]);
      lampsTown.push(() => b.lamp(ua - 1, yB + 1.2, va + 1.8, { reach: 16 }), () => b.lamp(ua + 2, yB + 20, va + 23, { reach: 24, strength: 1.2 }));
    } else {
      // no room for it: a squatter tower on one lot, its stair foot on whichever end has an open lot beyond
      const one = (l: Lot, di: number): boolean => {
        const w = lotAt(l.i + di, l.j);
        return l.u >= uR0 + D * 0.7 && !!w && w.ok && !w.used && ground(di < 0 ? l.u - 1 : l.u + PU + 1, l.v + 1.8) < Yf + 3.4 && !rectHitsPillar(l.u - 4, l.v - 2, l.u + PU + 4, l.v + PV + 2);
      };
      let pick: Lot | undefined;
      let m = -1;
      for (const di of [-1, 1]) {
        const got = nearest(uB1 + 30, tv, free().filter((l) => one(l, di)));
        if (got && (!pick || Math.abs(mid(got)[0] - uB1 - 30) < Math.abs(mid(pick)[0] - uB1 - 30))) { pick = got; m = di; }
      }
      if (pick) {
        pick.used = true;
        lotAt(pick.i + m, pick.j)!.used = true; // (kept open before its foot)
        const va = pick.v;
        const pu = pick.u;
        compactTower(va, (x: number): number => (m < 0 ? pu + x : pu + PU - x));
      }
    }
  }
  if (!L.tower) {
    // nowhere on the lots: on a pad of its own (the twin houses' if need be)
    const P = findPad(20, 14.4, uB1) ?? findPad(20, 14.4, uR0) ?? findPad(18, 14.4, uR0) ?? findPad(20, 11, uR0); // (last resort: a pad a little shallower than the tower, whose base then sits a few metres onto the raw floor)
    if (P) {
      P.level();
      compactTower(Math.min(P.vIn, P.vOut), (x: number): number => P.x + x, Yf);
    }
  }
  // a pad held for a pair of houses joined at the roof, should the town have no other way across its roofs
  let twinPad = findPad(31, 7.2, uR0) ?? findPad(31, 5.4, uR0) ?? findPad(31, 3.6, uR0);
  // the figure: a seated giant of blocks on a plinth, facing the court
  let figure = false;
  {
    const sF = rnd() < 0.5 ? -1 : 1;
    const cand = free().filter((l) => { const n = lotAt(l.i, l.j + 1); return n && n.ok && !n.used && !rectHitsPillar(l.u, l.v - 2, l.u + PU, l.v + PV * 2 + 2); });
    const two = nearest(uF - 80, vMid + sF * (courtHalf + 24), cand);
    // (where no two lots side by side are free, a narrower figure on one)
    const lt = two ?? nearest(uF - 80, vMid + sF * (courtHalf + 24), free().filter((l) => !rectHitsPillar(l.u, l.v, l.u + PU, l.v + PV)));
    if (lt) {
      figure = true;
      lt.used = true;
      if (two) lotAt(lt.i, lt.j + 1)!.used = true;
      const sv = two ? 1 : 0.6;
      const cuF = lt.u + PU / 2;
      const cvF = two ? lt.v + PV : lt.v + PV / 2;
      const dir = c(cuF) > cvF ? 1 : -1;
      const hF = (two ? R(17, 22) : R(15, 18)) / 20.4;
      const y0 = groundMax(cuF - 8, cvF - 9 * sv, cuF + 8, cvF + 9 * sv) + 0.2;
      const fb = (a0: number, a1: number, f0: number, f1: number, ya: number, yb: number): void => {
        const va = cvF + dir * f0 * sv;
        const vb = cvF + dir * f1 * sv;
        g.fillBox(cuF + a0, Math.min(va, vb), cuF + a1, Math.max(va, vb), y0 + ya * hF, y0 + yb * hF);
      };
      g.roughNow = 0.15;
      g.paintF = roofP;
      fb(-8, 8, -9, 9, -3, 2);
      fb(-3.6, -0.9, 4.2, 6.6, 2, 7);
      fb(0.9, 3.6, 4.2, 6.6, 2, 7);
      fb(-3.6, 3.6, -4, 6.6, 7, 9);
      fb(-3.2, 3.2, -3.6, 1.6, 9, 17);
      fb(-4.5, 4.5, -3.2, 1.2, 14, 17);
      fb(-1.8, 1.8, -2, 1, 17, 20.4);
      fb(3.6, 5.4, -2.5, 0.5, 9.5, 15);
      fb(-5.4, -3.6, -2.5, 0.5, 9.5, 15);
      fb(3.6, 5.4, 0.5, 6, 9, 10.4);
      fb(-5.4, -3.6, 0.5, 6, 9, 10.4);
      g.paintF = 0;
      for (const sx of [9, -9]) {
        if (pillars.some((p) => Math.hypot(p[0] - cuF - sx, p[1] - cvF) < p[2] * 1.45 + 3)) continue;
        L.landmarks.push([cuF + sx, ground(cuF + sx, cvF), cvF]);
        break;
      }
      lampsTown.push(() => b.lamp(cuF + 9, y0 + 1.8, cvF + dir * 4, { reach: 20 }), () => b.lamp(cuF - 9, y0 + 1.8, cvF + dir * 4, { reach: 20 }));
    }
  }
  // no lot for the figure: it sits on a pad of its own, facing the lane
  if (!figure) {
    let P = findPad(20, 13, uB1);
    let sv = 0.72;
    if (!P) {
      P = findPad(18, 10, uR0);
      sv = 0.55;
    }
    if (!P) {
      P = findPad(16, 8, uR0);
      sv = 0.45;
    }
    if (!P && twinPad) {
      sv = 0.72;
      twinPad.release();
      twinPad = null;
      P = findPad(20, 13, uB1);
    }
    if (P) {
      P.level();
      const { x, s, vIn } = P;
      const cuF = x + 10;
      const cvF = vIn + s * (sv > 0.6 ? 6.5 : 5);
      const dir = -s;
      const hF = R(15, 18) / 20.4;
      const y0 = Yf + 0.2;
      const fb = (a0: number, a1: number, f0: number, f1: number, ya: number, yb: number): void => {
        const va = cvF + dir * f0 * sv;
        const vb = cvF + dir * f1 * sv;
        g.fillBox(cuF + a0, Math.min(va, vb), cuF + a1, Math.max(va, vb), y0 + ya * hF, y0 + yb * hF);
      };
      g.roughNow = 0.15;
      g.paintF = roofP;
      fb(-8, 8, -9, 9, -3, 2);
      fb(-3.6, -0.9, 4.2, 6.6, 2, 7);
      fb(0.9, 3.6, 4.2, 6.6, 2, 7);
      fb(-3.6, 3.6, -4, 6.6, 7, 9);
      fb(-3.2, 3.2, -3.6, 1.6, 9, 17);
      fb(-4.5, 4.5, -3.2, 1.2, 14, 17);
      fb(-1.8, 1.8, -2, 1, 17, 20.4);
      fb(3.6, 5.4, -2.5, 0.5, 9.5, 15);
      fb(-5.4, -3.6, -2.5, 0.5, 9.5, 15);
      fb(3.6, 5.4, 0.5, 6, 9, 10.4);
      fb(-5.4, -3.6, 0.5, 6, 9, 10.4);
      g.paintF = 0;
      L.landmarks.push([cuF, Yf, vIn - s * 1.2]);
      lampsTown.push(() => b.lamp(cuF + 9, y0 + 1.8, vIn - s * 0.6, { reach: 20 }), () => b.lamp(cuF - 9, y0 + 1.8, vIn - s * 0.6, { reach: 20 }));
    }
  }
  // obelisks beside the court
  for (const sO of [-1, 1]) {
    // (at the court's near corners, on no lot)
    const cx = even(uF - courtLen) + 1;
    const cz = onV(vMid + sO * (courtHalf - 3)) + 0.9;
    if (!(ground(cx, cz) < Yf + 0.5) || pillars.some((p) => Math.hypot(p[0] - cx, p[1] - cz) < p[2] * 1.4 + 3)) continue;
    const Ht = R(15, 25);
    const y0 = groundMax(cx - 2, cz - 1.8, cx + 2, cz + 1.8);
    g.roughNow = 0.1;
    g.paintF = roofP;
    g.fillBox(cx - 2, cz - 1.8, cx + 2, cz + 1.8, Yf - 1, y0 + 3);
    g.fillBox(cx - 1, cz - 0.9, cx + 1, cz + 0.9, y0, y0 + Ht);
    g.paintF = 0;
    props.push(() => { b.color(0.95, 0.9, 0.8, 1); b.cone(cx, y0 + Ht, cz, 1.2, 2.2, { sides: 4 }); });
    lampsTown.push(() => b.lamp(cx + 2.8, y0 + 0.9, cz, { reach: 18 }));
  }

  // buildings
  interface Bld {
    lot: Lot; u0: number; u1: number; v0: number; v1: number; yB: number; h: number; enter: boolean; stair: boolean;
    door: number; stairDir: number; stairSide: number; group: number; two: boolean; yS: number;
  }
  const blds: Bld[] = [];
  {
    const want = 18 + Math.floor(rnd() * 13);
    const pool = free().sort((a, c) => c.score - a.score);
    const mk = (lt: Lot): Bld | undefined => {
      const bu = [14, 16, 16][Math.floor(rnd() * 3)];
      const bv = [9, 10.8, 10.8][Math.floor(rnd() * 3)];
      const u0 = lt.u + (bu === 14 ? 2 * Math.floor(rnd() * 2) : 0);
      const v0 = lt.v + (bv === 9 ? 1.8 * Math.floor(rnd() * 2) : 0);
      const door = Math.floor(rnd() * 3); // 0 -u, 1 +u, 2 -v
      const du = door === 0 ? u0 - 1.4 : door === 1 ? u0 + bu + 1.4 : u0 + bu / 2;
      const dv = door === 2 ? v0 - 1.4 : v0 + bv / 2;
      if (pads.some((q) => du > q[0] - 1.5 && du < q[1] + 1.5 && dv > q[2] - 1.5 && dv < q[3] + 1.5)) return undefined; // (a door onto a pad's house)
      const yB = ground(du, dv);
      const h = Math.round(R(5, 15) * 2) / 2;
      const sd = rnd() < 0.5 ? 1 : -1;
      const two = bu >= 14 && rnd() < 0.5;
      if (!(yB === yB) || groundMax(u0, v0, u0 + bu, v0 + bv) > yB + 3 || Math.abs(yB - ground(u0 + bu / 2, v0 + bv / 2)) > 1.6) return undefined;
      if (pillars.some((p) => Math.hypot(Math.max(u0 - p[0], 0, p[0] - u0 - bu), Math.max(v0 - p[1], 0, p[1] - v0 - bv)) < p[2] * 1.45 + 3)) return undefined;
      lt.used = true;
      const bd: Bld = { lot: lt, u0, u1: u0 + bu, v0, v1: v0 + bv, yB: Math.round(yB * 4) / 4, h, enter: false, stair: false, door, stairDir: sd, stairSide: 1, group: -1, two, yS: 0 };
      blds.push(bd);
      return bd;
    };
    for (let guard = 0; blds.length < want && pool.length > 0 && guard < 200; guard++) {
      let bi = 0;
      let bs = -Infinity;
      for (let q = 0; q < pool.length; q++) {
        const l = pool[q];
        let adj = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) adj += lotAt(l.i + di, l.j + dj)?.used ? 1 : 0;
        const sc = l.score + 0.45 * Math.min(adj, 2);
        if (sc > bs) { bs = sc; bi = q; }
      }
      const lt = pool.splice(bi, 1)[0];
      if (!lt.used) mk(lt);
    }
    // about a third can be entered; half of those have a stair to the roof
    const nbc = (bd: Bld): number => blds.filter((o) => o !== bd && Math.abs(o.lot.i - bd.lot.i) + Math.abs(o.lot.j - bd.lot.j) === 1).length;
    const order = blds.map((_, i) => i).sort((a, c) => hash2(ns + a, 77) - 0.7 * Math.min(2, nbc(blds[a])) - (hash2(ns + c, 77) - 0.7 * Math.min(2, nbc(blds[c]))));
    const nE = Math.max(6, Math.round(blds.length / 3));
    const tryStair = (bd: Bld): void => {
      const hasN = (dj: number): boolean => blds.some((o) => o.lot.i === bd.lot.i && o.lot.j === bd.lot.j + dj);
      bd.stairSide = !hasN(1) ? 1 : !hasN(-1) ? -1 : 1;
      let yB = bd.yB;
      let door = bd.door;
      if (door === 2 && bd.stairSide < 0) {
        door = 0;
        const y2 = ground(bd.u0 - 1.4, (bd.v0 + bd.v1) / 2);
        if (!(y2 === y2)) return;
        const dv2 = (bd.v0 + bd.v1) / 2;
        if (pads.some((q) => bd.u0 - 1.4 > q[0] - 1.5 && bd.u0 - 1.4 < q[1] + 1.5 && dv2 > q[2] - 1.5 && dv2 < q[3] + 1.5)) return;
        yB = Math.round(y2 * 4) / 4;
      }
      {
        // (clear of the great stair and the rubble, which the ground does not know of)
        const sv = bd.stairSide > 0 ? bd.v1 + 0.9 : bd.v0 - 0.9;
        if ([...L.routes[0], ...L.routes[2]].some((p) => p[0] > bd.u0 - 6 && p[0] < bd.u1 + 6 && Math.abs(p[2] - sv) < 9)) return;
        // (nor across another house's doorway)
        const sa0 = bd.stairDir > 0 ? bd.u0 + 2 : bd.u1 - 2;
        const sb0 = sa0 + bd.stairDir * 14;
        const doorOf = (o: Bld): [number, number] => (o.door === 0 ? [o.u0 - 1.2, onV((o.v0 + o.v1) / 2)] : o.door === 1 ? [o.u1 + 1.2, onV((o.v0 + o.v1) / 2)] : [even((o.u0 + o.u1) / 2), o.v0 - 1.2]);
        const near = (p: readonly number[]): boolean => Math.abs(p[1] - sv) < 3.2 && p[0] > Math.min(sa0, sb0) - 3 && p[0] < Math.max(sa0, sb0) + 3;
        if (blds.some((o) => o !== bd && near(doorOf(o))) || L.doors.some((p) => near([p[0], p[2]]))) return;
      }
      const yS = ground(bd.stairDir > 0 ? bd.u0 + 2 : bd.u1 - 2, bd.stairSide > 0 ? bd.v1 + 0.9 : bd.v0 - 0.9);
      if (!(yS === yS) || yS > yB + 1.5) return;
      const h = Math.floor(Math.min(bd.h, (bd.u1 - bd.u0 - 3) / 2 + yS - yB, 7) * 2) / 2;
      if (h < 5) return;
      bd.door = door;
      bd.yB = yB;
      bd.h = h;
      bd.yS = Math.round(yS * 4) / 4;
      bd.stair = true;
    };
    for (let q = 0; q < nE && q < order.length; q++) {
      const bd = blds[order[q]];
      bd.enter = true;
      if (q % 3 !== 2) tryStair(bd);
    }
    for (let q = nE; q < order.length && blds.filter((x) => x.stair).length < 4; q++) {
      const bd = blds[order[q]];
      if (nbc(bd) === 0) continue;
      bd.enter = true;
      tryStair(bd);
    }
    // rooftop links: from each stair house to a neighbour, and on from there
    const nb = (a: Bld): Bld[] => blds.filter((o) => o !== a && Math.abs(o.lot.i - a.lot.i) + Math.abs(o.lot.j - a.lot.j) === 1);
    const links: [Bld, Bld, number][] = [];
    let grp = 0;
    const roofOf = (x: Bld): number => x.yB + x.h;
    const tryLink = (a: Bld, o: Bld): boolean => {
      const ju = o.lot.i !== a.lot.i;
      const lo = ju ? (o.lot.i > a.lot.i ? [a, o] : [o, a]) : o.lot.j > a.lot.j ? [a, o] : [o, a];
      const gapv = ju ? lo[1].u0 - lo[0].u1 : lo[1].v0 - lo[0].v1;
      const ov = ju ? Math.min(a.v1, o.v1) - Math.max(a.v0, o.v0) : Math.min(a.u1, o.u1) - Math.max(a.u0, o.u0);
      if (gapv < 3 || gapv > 9 || ov < 3) return false;
      if (o.group >= 0 && o.group !== a.group) return false;
      let pos = 0;
      if (ju) pos = onV((Math.max(a.v0, o.v0) + Math.min(a.v1, o.v1)) / 2);
      else {
        const [m0, m1] = o.lot.j > a.lot.j ? [a, o] : [o, a];
        const ry = roofOf(a);
        const ivs: [number, number][] = [];
        for (const [m, face] of [[m0, 1], [m1, -1]] as [Bld, number][]) {
          if (!m.stair || m.stairSide !== face) continue;
          const sa = m.stairDir > 0 ? m.u0 + 2 : m.u1 - 2;
          const sb = sa + m.stairDir * 2 * (ry - m.yS);
          ivs.push([Math.min(sa, sb) - 2.5, Math.max(sa, sb) + 2.5]);
        }
        pos = NaN;
        for (let c = even(Math.max(m0.u0, m1.u0) + 2); c <= Math.min(m0.u1, m1.u1) - 2; c += 2) if (!ivs.some(([i0, i1]) => c >= i0 && c <= i1)) { pos = c; break; }
        if (pos !== pos) return false;
      }
      if (o.group < 0) {
        const hh = roofOf(a) - o.yB;
        const hi = o.stair ? Math.min(7, (o.u1 - o.u0 - 3) / 2 + o.yS - o.yB) : 15;
        if (hh < 5 || hh > hi) return false;
        o.h = hh;
        o.group = a.group;
      } else if (Math.abs(roofOf(o) - roofOf(a)) > 0.01) return false;
      links.push([a, o, pos]);
      return true;
    };
    for (const s of blds.filter((x) => x.stair)) {
      if (s.group < 0) s.group = grp++;
      let cur = s;
      for (let step = 0; step < 3; step++) {
        const cand = nb(cur).filter((o) => o.group < 0 || o.group === s.group);
        let done = false;
        for (const o of cand.sort((a, c) => (c.enter ? 1 : 0) - (a.enter ? 1 : 0))) {
          if (links.some(([p, q2]) => (p === cur && q2 === o) || (p === o && q2 === cur))) continue;
          if (tryLink(cur, o)) { cur = o; done = true; break; }
        }
        if (!done) break;
      }
    }
    for (const cur of [...blds.filter((x) => x.group >= 0), ...blds.filter((x) => x.group >= 0)]) {
      if (links.length >= 9) break;
      let made = 0;
      for (const o of nb(cur)) if (made < 2 && (o.group < 0 || o.group === cur.group) && !links.some(([p, q2]) => (p === cur && q2 === o) || (p === o && q2 === cur)) && tryLink(cur, o)) made++;
    }
    // too few neighbours to cross: raise plain buildings beside the stair houses
    for (let pass = 0; pass < 2 && links.length < 3; pass++) {
      for (const cur of blds.filter((x) => x.group >= 0)) {
        if (links.length >= 5) break;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const lt2 = lotAt(cur.lot.i + di, cur.lot.j + dj);
          if (!lt2 || !lt2.ok || lt2.used) continue;
          const nbd = mk(lt2);
          if (!nbd) continue;
          if (!tryLink(cur, nbd)) { blds.pop(); lt2.used = false; continue; }
          break;
        }
      }
    }
    // still no way across the roofs: give a house with a neighbour a stair, or raise a pair of houses on two free lots
    if (links.length === 0) {
      for (const a of blds) {
        if (links.length > 0) break;
        if (a.group >= 0 && !a.stair) continue;
        const linked = (x: Bld): boolean => links.some(([p2, q2]) => p2 === x || q2 === x);
        const ns2 = nb(a).filter((o) => !linked(o));
        if (ns2.length === 0) continue;
        if (!a.stair) {
          a.enter = true;
          tryStair(a);
          if (!a.stair) continue;
        }
        if (a.group < 0) a.group = grp++;
        for (const o of ns2) {
          // (a stair house beside it that is linked to nothing joins its group)
          const keep = o.group;
          o.group = -1;
          if (tryLink(a, o)) break;
          o.group = keep;
        }
      }
    }
    if (held) held[0].used = held[1].used = false;
    if (links.length === 0) {
      for (const l1 of held ? [held[0], ...lots] : lots) {
        if (links.length > 0) break;
        const l2 = lotAt(l1.i + 1, l1.j);
        if (!l1.ok || l1.used || !l2 || !l2.ok || l2.used) continue;
        const n0 = blds.length;
        const a = mk(l1);
        const o = a ? mk(l2) : undefined;
        if (a && o) {
          a.enter = true;
          tryStair(a);
          if (a.stair) {
            a.group = grp++;
            if (tryLink(a, o)) break;
            a.group = -1;
          }
        }
        blds.length = n0;
        l1.used = false;
        l2.used = false;
      }
    }
    g.roughNow = 0.12;
    const doorsAt: [number, number, number][] = [];
    for (const bd of blds) {
      const { u0, u1, v0, v1, yB } = bd;
      const roofY = yB + bd.h;
      const reach = bd.group >= 0;
      g.paintF = roofP;
      g.fillBox(u0, v0, u1, v1, Yf - 1, roofY);
      g.paintF = 0;
      const vm = onV((v0 + v1) / 2);
      const um = even((u0 + u1) / 2);
      const doorBox = (h: number): void => {
        if (bd.door === 0) g.carveBox(u0, vm - 1.8, u0 + 2.5, vm + 1.8, yB, yB + h);
        else if (bd.door === 1) g.carveBox(u1 - 2.5, vm - 1.8, u1, vm + 1.8, yB, yB + h);
        else g.carveBox(um - 2, v0, um + 2, v0 + 2.7, yB, yB + h);
      };
      const dp: [number, number, number] = bd.door === 0 ? [u0 - 1.2, yB, vm] : bd.door === 1 ? [u1 + 1.2, yB, vm] : [um, yB, v0 - 1.2];
      if (bd.enter) {
        const rh = Math.min(bd.h - 1.6, 5);
        if (bd.two) {
          g.carveBox(u0 + 2, v0 + 1.8, um - 1, v1 - 1.8, yB, yB + rh);
          g.carveBox(um + 1, v0 + 1.8, u1 - 2, v1 - 1.8, yB, yB + rh);
          g.carveBox(um - 1.5, vm - 1.8, um + 1.5, vm + 1.8, yB, yB + Math.min(rh, 3.2));
        } else g.carveBox(u0 + 2, v0 + 1.8, u1 - 2, v1 - 1.8, yB, yB + rh);
        doorBox(Math.min(rh, 3));
        if (rnd() < 0.5 || tier < 2) g.carveBox(bd.door === 0 ? u1 - 2 : u0, vm - 0.9, bd.door === 0 ? u1 : u0 + 2, vm + 0.9, yB + 1.4, yB + 2.6);
        L.doors.push(dp);
        if (reach) L.roofs.push([um, roofY, vm]);
        const lampIn = rnd() < 0.3;
        lampsTown.push(() => {
          b.lamp(dp[0] + (bd.door === 0 ? -0.6 : bd.door === 1 ? 0.6 : 0), yB + 2.6, dp[2] + (bd.door === 2 ? 0 : 1.9), { reach: 15 });
          if (lampIn) b.lamp(um, yB + rh - 0.4, vm, { reach: 12, strength: 0.8 });
        });
      } else {
        // a recessed dark doorway, and windows
        const dh = 2.8;
        if (bd.door === 0) g.carveBox(u0, vm - 0.9, u0 + 1, vm + 0.9, yB, yB + dh);
        else if (bd.door === 1) g.carveBox(u1 - 1, vm - 0.9, u1, vm + 0.9, yB, yB + dh);
        else g.carveBox(um - 1, v0, um + 1, v0 + 0.9, yB, yB + dh);
        if (tier === 0 && (bd.lot.i + bd.lot.j) % 2 === 0) for (const s of [-1, 1]) g.carveBox(u0 + 3, s < 0 ? v0 : v1 - 0.9, u0 + 5, s < 0 ? v0 + 0.9 : v1, yB + bd.h - 3.2, yB + bd.h - 1.8);
      }
      if (bd.stair) {
        // an outside stair on the +v wall, up to the roof edge
        const len = 2 * (roofY - bd.yS);
        const sa = bd.stairDir > 0 ? u0 + 2 : u1 - 2;
        const sv = bd.stairSide > 0 ? v1 + 0.9 : v0 - 0.9;
        const sb = sa + bd.stairDir * len;
        L.stairs.push([sa, bd.yS, sv], [sb, roofY, sv]);
        g.fillRun([sa, bd.yS, sv], [sb, roofY, sv], 1.8, bd.h + 3, { steps: true, cap0: tier === 2 ? 1 : 0, cap1: tier === 2 ? 2 : 0 });
        L.roofs.push([sb - bd.stairDir * 0.5, roofY, bd.stairSide > 0 ? v1 - 0.9 : v0 + 0.9]);
        if (rnd() < 0.5) lampsTown.push(() => b.lamp(sa - bd.stairDir * 0.5, bd.yS + 1.6, sv + bd.stairSide * 1.8, { reach: 12, strength: 0.8 }));
      }
      doorsAt.push(dp);
      {
        // a lamp on a roof corner, and one by every doorway, lit or not
        const k = blds.indexOf(bd);
        const cu0 = (k & 1) === 0 ? u0 + 0.6 : u1 - 0.6;
        const cv0 = Math.abs(v0 - c(um)) < Math.abs(v1 - c(um)) ? v0 + 0.6 : v1 - 0.6; // the lane's side
        if (k % (tier < 2 ? 3 : 4) === 0) lampsTown.push(() => b.lamp(cu0, roofY + 0.4, cv0, { reach: 18, strength: 0.9 }));
        if (!bd.enter) lampsTown.push(() => b.lamp(dp[0], yB + 2.6, dp[2] + (bd.door === 2 ? -0.4 : 1.6), { reach: 13, strength: 0.8 }));
      }
    }
    for (const [a, o, pos] of links) {
      const ju = o.lot.i !== a.lot.i;
      const ry = a.yB + a.h;
      g.roughNow = 0.05;
      if (ju) {
        const [l0, l1] = o.lot.i > a.lot.i ? [a, o] : [o, a];
        const vc = pos;
        g.fillBox(l0.u1 - 2, vc - 0.9, l1.u0 + 2, vc + 0.9, ry - 0.6, ry);
        L.links.push([(l0.u1 + l1.u0) / 2, ry, vc]);
      } else {
        const [l0, l1] = o.lot.j > a.lot.j ? [a, o] : [o, a];
        const uc = pos;
        g.fillBox(uc - 1, l0.v1 - 1.8, uc + 1, l1.v0 + 1.8, ry - 0.6, ry);
        L.links.push([uc, ry, (l0.v1 + l1.v0) / 2]);
      }
    }
    // no roofs to cross anywhere in the town: a pair of houses joined at the roof by a plank
    if (twinPad) {
      const P = twinPad;
      P.level();
      const joined = L.links.length === 0;
      {
        const { x, s, vIn, vOut } = P;
        const rY = Yf + 6;
        const vm = onV((vIn + vOut) / 2);
        const v0 = Math.min(vIn, vOut);
        const v1 = Math.max(vIn, vOut);
        g.roughNow = 0.12;
        g.paintF = roofP;
        g.fillBox(x, v0, x + 14, v1, Yf - 1, rY);
        g.fillBox(x + 17, v0, x + 31, v1, Yf - 1, rY);
        g.paintF = 0;
        if (joined) {
          g.fillRun([x + 2, Yf, vIn - s * 0.9], [x + 14, rY, vIn - s * 0.9], 1.8, 9, { steps: true, cap0: tier === 2 ? 1 : 0, cap1: tier === 2 ? 2 : 0 });
          g.fillBox(x + 12, vm - 0.9, x + 19, vm + 0.9, rY - 0.6, rY);
          L.roofs.push([x + 7, rY, vm], [x + 24, rY, vm]);
          L.links.push([x + 15.5, rY, vm]);
          L.stairs.push([x + 2, Yf, vIn - s * 0.9], [x + 14, rY, vIn - s * 0.9]);
        }
        g.carveBox(x + 19, v0 + (v1 - v0 > 4 ? 1.8 : 0.9), x + 29, v1 - (v1 - v0 > 4 ? 1.8 : 0.9), Yf, Yf + 4.2);
        g.carveBox(x + 22, Math.min(vIn, vIn + s * 2), x + 26, Math.max(vIn, vIn + s * 2), Yf, Yf + 3);
        L.doors.push([x + 24, Yf, vIn - s * 1.2]);
        lampsTown.push(() => b.lamp(x + 24, Yf + 2.6, vIn - s * 0.5, { reach: 15 }), () => b.lamp(x + 15.5, rY + 1.2, vm, { reach: 18 }));
      }
    }
    // and more single houses on pads, until the town has a fair number of doors (a third of them open)
    for (let k = 0, from = uR0; k < 12 && blds.length + pads.length < 16; k++) {
      const P = findPad(14, 7.2, from);
      if (!P) break;
      P.level();
      const { x, s, vIn, vOut } = P;
      from = x + 18;
      const h = [5, 6.5, 8, 10][Math.floor(hash2(ns + x, 41) * 4)];
      const v0 = Math.min(vIn, vOut);
      const v1 = Math.max(vIn, vOut);
      const vm = onV((v0 + v1) / 2);
      const open = k % 3 === 0 || L.doors.length < 3;
      g.roughNow = 0.12;
      g.paintF = roofP;
      g.fillBox(x, v0, x + 14, v1, Yf - 1, Yf + h);
      g.paintF = 0;
      if (open) {
        g.carveBox(x + 2, v0 + 1.8, x + 12, v1 - 1.8, Yf, Yf + 4);
        g.carveBox(x + 5, Math.min(vIn, vIn + s * 2), x + 9, Math.max(vIn, vIn + s * 2), Yf, Yf + 3);
        L.doors.push([x + 7, Yf, vIn - s * 1.2]);
        lampsTown.push(() => b.lamp(x + 7, Yf + 2.6, vIn - s * 0.5, { reach: 15 }));
      } else {
        g.carveBox(x + 6, Math.min(vIn, vIn + s * 0.9), x + 8, Math.max(vIn, vIn + s * 0.9), Yf, Yf + 2.8);
        if (k % 2 === 1) lampsTown.push(() => b.lamp(x + 0.6, Yf + h + 0.4, vIn + s * 0.6, { reach: 16, strength: 0.9 }));
      }
      void vm;
    }
    // courtyards: free lots with built neighbours on three sides
    let courts = 0;
    for (const lt of lots) {
      if (!lt.ok || lt.used || courts >= 3) continue;
      const nbs = [lotAt(lt.i + 1, lt.j), lotAt(lt.i - 1, lt.j), lotAt(lt.i, lt.j + 1), lotAt(lt.i, lt.j - 1)].filter((n) => n && n.used).length;
      if (nbs < 3) continue;
      courts++;
      const [cx, cz] = mid(lt);
      props.push(() => {
        const y = ground(cx, cz);
        b.color(0.6, 0.5, 0.38, 2);
        b.box(cx + 2, y, cz - 1.8, 2, 1, 1.8, 0.3, { solid: true });
        if (tier < 2) b.box(cx - 2, y, cz + 1.8, 1.6, 0.8, 1.6, 0.8, { solid: true });
        for (let q = 0; q < Math.ceil(3 * [1, 0.6, 0.35][tier]); q++) jar(cx + b.r(-3, 3), y, cz + b.r(-2.5, 2.5));
      });
      lampsTown.push(() => {
        const y = ground(cx, cz);
        b.color(0.95, 0.95, 0.95, 0);
        b.cyl(cx - 2, y, cz - 2, 0.6, 1.1, { solid: true });
        b.cyl(cx - 2, y + 1.1, cz - 2, 0.65, 0.4, { top: 1.6 });
        b.lamp(cx - 2, y + 1.9, cz - 2, { reach: 24, strength: 1.2, size: 1.8, body: false });
      });
    }
  }
  // lamps on posts down the lane, through the town
  for (let u = uR0 + D * 0.7, q = 0; u < uF - courtLen - 4; u += [30, 34, 44][tier], q++) {
    const v = c(u) + (q % 2 === 0 ? 1.2 : -1.2);
    const y = ground(u, v);
    if (!(y < Yf + 1.5) || pillars.some((p) => Math.hypot(p[0] - u, p[1] - v) < p[2] * 1.3 + 1)) continue;
    lampsTown.push(() => {
      b.color(0.5, 0.45, 0.4, 0);
      b.box(u, y, v, 0.22, 3, 0.22);
      b.lamp(u, y + 3.3, v, { reach: 20, strength: 0.95 });
    });
  }

  const tierKeep = tier === 2 ? 0.5 : 1;
  const jar = (u: number, y: number, v: number): void => {
    const r = b.r(0.24, 0.34);
    const h = b.r(0.5, 0.75);
    const k = b.r(0.75, 1);
    if (b.rng() < 0.5) b.color(0.85 * k, 0.62 * k, 0.45 * k, 2);
    else b.color(0.9 * k, 0.86 * k, 0.8 * k, 1);
    b.cyl(u, y, v, r * 0.8, h * 0.65, { top: 1.25, sides: 7 });
    b.cyl(u, y + h * 0.65, v, r, h * 0.35, { top: 0.5, sides: 7 });
  };
  const jars = (u: number, y: number, v: number, n: number): void => {
    for (let i = 0; i < n; i++) jar(u + b.r(-1, 1), y, v + b.r(-1, 1));
  };
  const few = [1, 0.6, 0.35][tier];
  const cloth = (i: number): void => {
    const q = i % 3;
    if (q === 0) b.color(0.62, 0.2, 0.15, 2);
    else if (q === 1) b.color(0.25, 0.34, 0.44, 2);
    else b.color(0.8, 0.6, 0.3, 2);
  };
  let li = 0;
  for (const f of lampsTown) if (li++ % (tier === 2 ? 2 : 1) === 0 || tierKeep === 1) f();

  // ---- market stalls: in open lots beside the lane, a few counters under awnings
  {
    let nM = 0;
    for (const lt of lots) {
      if (nM >= 7 || !lt.ok || lt.used) continue;
      if (hash2(ns + lt.i * 7, lt.j * 13 + 3) > 0.8) continue;
      lt.used = true;
      nM++;
      const [cx, cz] = mid(lt);
      const towardLane = Math.sign(c(cx) - cz) || 1;
      const n = 2 + Math.floor(hash2(ns + lt.i, lt.j) * 3);
      for (let q = 0; q < n; q++) {
        const su = cx - 7 + (14 * (q + 0.5)) / n;
        const sv = cz + towardLane * 3;
        const y = ground(su, sv);
        if (!(y === y)) continue;
        props.push(() => {
          b.color(0.55, 0.4, 0.26, 2);
          b.box(su, y, sv, 2.6, 1, 1.1, 0, { solid: true });
          for (const du of [-1.3, 1.3]) for (const dv of [-0.6, 1.6]) b.box(su + du, y, sv - towardLane * dv, 0.14, 2.5, 0.14);
          cloth(q + lt.i);
          b.box(su, y + 2.5, sv - towardLane * 0.5, 3, 0.06, 2.6, 0, { rx: towardLane * 0.12 });
          if (tier < 2) jars(su, y + 1, sv, Math.ceil(2 * few));
        });
      }
      if (tier < 2 || nM % 2 === 1) props.push(() => b.lamp(cx, ground(cx, cz + towardLane * 6) + 2.4, cz + towardLane * 6, { reach: 16 }));
    }
  }

  // ---- side scenes: small rooms at the foot of the walls, each at the end of a short passage
  const relicScene = Math.min(Math.max(0, sceneSpots.length - 1), Math.floor(hash2(ns, 98) * Math.max(1, sceneSpots.length)));
  sceneSpots.forEach((sp, idx) => {
    const kind = idx % 4;
    const uc = sp.u;
    const sg = sp.s; // toward the rock
    const f0 = face(sg, uc);
    const fin = (d: number): number => face(sg, uc) + sg * d;
    const rh = 4.2;
    g.roughNow = 0.15;
    wallCut(sg, uc - 2, uc + 2, 0, 5.4, Yf, Yf + 3, true);
    wallCut(sg, uc - 6, uc + 6, 5, 12, Yf, Yf + rh);
    const vc = fin(8.5);
    const back = fin(11.4);
    if (kind === 2) {
      // a shallow pool fed by a trickle
      const p0 = Math.min(fin(7), fin(11));
      const p1 = Math.max(fin(7), fin(11));
      g.carveBox(uc - 4, p0, uc + 4, p1, Yf - 0.45, Yf + rh);
      g.pool(uc - 4, p0, uc + 4, p1, Yf - 0.12);
    }
    if (kind === 3) wallCut(sg, uc - 6, uc + 6, 12, 14, Yf, Yf + rh - 0.6);
    const sceneP: Pt = [uc, Yf, fin(6)];
    L.scenes.push(sceneP);
    L.sides.push([uc, Yf, f0 - sg * 2]);
    if (spec.relic && !relicInTemple && idx === relicScene) {
      const rv = fin(8);
      L.relic = [uc + 3, Yf + 1.6, rv];
      props.push(() => {
        b.color(0.9, 0.88, 0.84, 0);
        b.box(uc + 3, Yf, rv, 2.2, 0.4, 2.2, 0, { solid: true });
        b.cyl(uc + 3, Yf + 0.4, rv, 0.62, 0.75, { solid: true });
        b.cyl(uc + 3, Yf + 1.15, rv, 0.48, 0.14);
      });
    }
    props.push(() => {
      b.lamp(uc - 3, Yf + 2.6, f0 - sg * 2, { reach: 12, strength: 0.9 });
      if (kind === 0) {
        // a shrine: carved slabs, their marks holding a little light
        const nS = spec.carvings ? 5 : 3;
        for (let i = 0; i < nS; i++) {
          const u = uc - 5 + (10 * (i + 0.5)) / nS;
          const h = b.r(2.4, 3.2);
          const k = b.r(0.85, 1);
          b.color(k, k * 0.98, k * 0.94, 0);
          b.box(u, Yf, back, 1.5, h, 0.5, b.r(-0.05, 0.05), { solid: true });
          b.color(0.42, 0.42, 0.42, 4);
          for (let row = 0; row < 5; row++) {
            const y = Yf + 0.5 + row * 0.42;
            if (y > Yf + h - 0.8) break;
            for (let q = -1; q <= 1; q++) {
              if (b.rng() < 0.3) continue;
              const tallM = b.rng() < 0.3;
              b.box(u + q * 0.36, y, back - sg * 0.27, tallM ? 0.07 : b.r(0.14, 0.28), tallM ? 0.3 : 0.07, 0.06);
            }
          }
        }
        b.lamp(uc, Yf + 3.4, vc, { reach: 14 });
      } else if (kind === 1) {
        // a store: crates and jars
        for (let i = 0; i < 6 * [1, 0.7, 0.4][tier]; i++) {
          const u = uc - 5 + b.r(0, 10);
          const v = vc + sg * b.r(-1.5, 2);
          const s = b.r(0.9, 1.5);
          b.color(0.55, 0.4, 0.26, 2);
          b.box(u, Yf, v, s, s * 0.8, s, b.r(0, 3), { solid: true });
          if (b.rng() < 0.4) b.box(u, Yf + s * 0.8, v, s * 0.7, s * 0.6, s * 0.7, b.r(0, 3), { solid: true });
        }
        for (let i = 0; i < 8; i++) jar(uc - 5.5 + b.r(0, 11), Yf, back - sg * b.r(0.5, 1.5));
        b.lamp(uc, Yf + 3.4, vc, { reach: 14 });
      } else if (kind === 2) {
        b.color(0.6, 0.78, 0.86, 1);
        b.cyl(uc, Yf + 0.2, back, 0.1, rh - 0.4, { sides: 4 });
        b.lamp(uc - 4.5, Yf + 3, fin(6), { reach: 12 });
      } else {
        // a seam of glowing mineral in a broken end
        const n = (spec.vein ? 1 : 0.55) * [18, 14, 9][tier];
        for (let i = 0; i < n; i++) {
          const t = (i + b.rng() * 0.6) / n;
          const h = b.r(0.8, 2.2);
          const k = b.r(0.65, 1.1);
          b.color(k, k, k, 4);
          b.cone(uc - 5 + 10 * t, Yf + 0.4 + 1.8 * Math.sin(t * Math.PI) * b.r(0.6, 1), fin(13.6), b.r(0.25, 0.55), h, { rx: b.r(-0.6, 0.6), rz: b.r(-0.5, 0.5), sides: 4 });
        }
        for (let i = 0; i < 4; i++) {
          b.color(0.8, 0.8, 0.8, 0);
          const s = b.r(1, 2);
          b.box(uc - 4 + b.r(0, 8), Yf, fin(b.r(10, 12.5)), s * 1.3, s * 0.7, s, b.r(0, 3), { solid: true });
        }
        b.light(uc, Yf + 2, fin(12), spec.vein ? 26 : 18, 0.9, TEAL);
        b.glow(uc, Yf + 2, fin(12.5), spec.vein ? 7 : 4, [0.22, 0.7, 0.6]);
      }
    });
  });

  // ---- lamps left burning: the ledge, down the stair, along the rubble slope
  b.lamp(uH0 + 1, yL + 1.8, vP - 3, { reach: 16, strength: 0.9 });
  b.lamp(uH0 + 1, yL + 1.8, vP + 3, { reach: 16, strength: 0.9 });
  {
    // the balcony's parapet, and a lamp at each front corner
    b.color(0.92, 0.9, 0.85, 0);
    const uf = uR0 + 3.5;
    const hw = balc(uf);
    b.box(uf, yL, vP, 0.6, 1, hw * 2, 0, { solid: true });
    for (const s of [-1, 1]) {
      for (let u = uH0 + 7; u < uf - 0.5; u += 2.5) b.box(u + 1.1, yL, vP + s * (balc(u + 1.1) - 0.3), 2.2, 1, 0.5, 0, { solid: true });
      b.box(uf, yL, vP + s * (hw - 0.4), 0.9, 1.4, 0.9, 0, { solid: true });
      b.lamp(uf, yL + 1.9, vP + s * (hw - 0.4), { reach: 22, strength: 1.1 });
    }
  }
  for (const f of flights) {
    const len = f.ub - f.ua;
    for (const t of tier === 2 ? [0.5] : [0.05, 0.5, 0.95]) {
      const u = f.ua + len * t;
      b.lamp(u, f.y0 + (f.y1 - f.y0) * t + 0.62, face(sA, u) - sA * 0.45, { reach: 20 });
    }
  }
  for (let u = uR0 + 12; u < uR1; u += tier === 2 ? 60 : 36) {
    b.lamp(u, Math.max(Yf, yL - gu * (u - uR0)) + 1.4, face(sB, u) - sB * 0.8, { reach: 16, strength: 0.8 });
  }

  // ---- the facades' trim: a pilaster up each house's edge, a course under each storey
  b.color(0.9, 0.9, 0.9, 0);
  for (let i = 0; i < trims.length; i += 5) {
    const s = trims[i];
    const x = trims[i + 1];
    const y0 = trims[i + 2];
    const y1 = trims[i + 3];
    const kind = trims[i + 4];
    if (kind < 2) {
      if (tier === 2 && kind === 1) continue;
      b.box(x + 1, y0, face(s, x + 1) - s * 0.2, 1.2, y1 - y0, 0.6);
    } else if (tier < 2 || (y0 - Yf) % 12 < 1) {
      const nB = kind - 2;
      for (let q = 0; q < nB; q++) {
        const u = x + 2 + q * 4 + 2;
        b.box(u, y0 - 0.15, face(s, u) - s * 0.15, 4, 0.3, 0.45);
      }
    }
  }
  // ---- the galleries and the bridge: posts along the edges, lamps now and then
  b.color(0.95, 0.94, 0.9, 0);
  for (const [s, u0, u1] of [[sA, Math.max(uGA0, uS1 + 2), uGA1], [sB, uGB0, uGB1]]) {
    for (let u = u0 + 2.5; u < u1 - 1; u += tier === 2 ? 12 : 6) {
      if (u > uBr - 1 && u < uBr + 5) continue;
      b.box(u, yM, face(s, u) - s * 0.9, 0.5, 1.1, 0.5, 0, { solid: true });
    }
    for (let u = u0 + 6; u < u1 - 2; u += [18, 24, 32][tier]) b.lamp(u, yM + 0.5, face(s, u) + s * 1.6, { reach: 14, strength: 0.75 });
  }
  {
    const lo = wLo(uBr + 2);
    const hi = wHi(uBr + 2);
    for (let v = lo + 2; v < hi - 1; v += tier === 2 ? 6 : 3) {
      b.box(uBr + 0.3, yM, v, 0.4, 1, 0.4, 0, { solid: true });
      b.box(uBr + 3.7, yM, v, 0.4, 1, 0.4, 0, { solid: true });
    }
    b.lamp(uBr + 0.4, yM + 1.4, (lo + hi) / 2, { reach: 18 });
    for (let q = 0; q < (tier === 2 ? 1 : 3); q++) {
      cloth(q + ns);
      const len = b.r(4, 8);
      b.box(q % 2 === 0 ? uBr - 0.06 : uBr + 4.06, yM - 1.4 - len, lo + (hi - lo) * (0.25 + 0.25 * q), 0.07, len, b.r(1.2, 1.8));
    }
  }
  // ---- lamps in the rooms, a few in windows; the rest of the walls dark
  roomLamps.forEach((p, i) => {
    if (tier === 2 && i % 2 === 1) return;
    b.lamp(p[0], p[1] + 0.5, p[2], { reach: 12, strength: 0.8 });
  });
  {
    const total = litCand.length / 3;
    const nW = Math.min(total, [16, 10, 5][tier]);
    for (let q = 0; q < nW; q++) {
      const i = Math.min(total - 1, Math.floor(((q + b.rng()) * total) / nW)) * 3;
      b.lamp(litCand[i], litCand[i + 1] + 0.5, litCand[i + 2], { reach: 11, strength: 0.75 });
    }
  }
  L.rooms.forEach((p) => {
    if (p[1] > Yf + 1 && b.rng() < 0.5) jars(p[0] + b.r(-1, 1), p[1], p[2], Math.ceil(3 * few));
  });
  // ---- what fell: blocks along the rubble slope, at the heaps and the bends
  for (let i = 0; i < [14, 9, 5][tier]; i++) {
    const h = heaps.length > 0 && i % 2 === 1 ? heaps[i % heaps.length] : null;
    const u = h ? h.u + b.r(-h.r, h.r) * 0.7 : b.r(uR0 + 6, uR1);
    const v = h ? h.v - h.s * b.r(0, h.r * 0.6) : face(sB, u) - sB * b.r(RW + 1, RW + 5);
    const F = ground(u, v);
    if (!(F === F)) continue;
    const sz = b.r(0.8, 2.4);
    const k = b.r(0.8, 1);
    b.color(k, k, k, 0);
    b.box(u, F - sz * 0.15, v, sz * b.r(0.8, 1.4), sz * b.r(0.5, 0.9), sz, b.r(0, 3), { rx: b.r(-0.2, 0.2), rz: b.r(-0.2, 0.2), solid: sz > 1.2 });
  }
  // ---- what was left behind: by the ledge, the door, the alleys
  // ---- the stair's foot: a waystation where the climb ends, so the floor there is not bare
  {
    const uA = uS1 + 3;
    const open = (u: number, v: number, r: number): boolean => {
      const F = ground(u, v);
      if (!(F === F) || F > Yf + 0.6) return false;
      if (Math.abs(c(u) - v) < 3.5 + r) return false; // (the lane stays open)
      if (pillars.some((q) => Math.hypot(q[0] - u, q[1] - v) < q[2] * 1.4 + r)) return false;
      if (lots.some((l) => l.used && u > l.u - r && u < l.u + PU + r && v > l.v - r && v < l.v + PV + r)) return false;
      if (pads.some((q) => u > q[0] - r && u < q[1] + r && v > q[2] - r && v < q[3] + r)) return false;
      return true;
    };
    const vAt = (u: number, d: number): number => face(sA, u) - sA * (SW + d);
    // a stack of crates and a heap of jars against the wall, a cloth hung between two posts, a lamp over all
    const nC = Math.ceil(5 * few);
    for (let q = 0; q < nC; q++) {
      const u = uA + b.r(0, 9);
      const v = vAt(u, b.r(1.2, 3.2));
      if (!open(u, v, 1.2)) continue;
      const k = b.r(0.75, 0.95);
      b.color(0.7 * k, 0.5 * k, 0.32 * k, 2);
      const sz = b.r(0.9, 1.3);
      const ry = b.r(0, 3);
      b.box(u, ground(u, v), v, sz, sz, sz, ry, { solid: true });
      if (q % 2 === 0) b.box(u + b.r(-0.2, 0.2), ground(u, v) + sz, v + b.r(-0.2, 0.2), sz * 0.8, sz * 0.8, sz * 0.8, ry + 0.4);
    }
    for (const du of [4, 11]) {
      const u = uA + du;
      const v = vAt(u, 6);
      if (open(u, v, 1)) jars(u, ground(u, v), v, Math.ceil(4 * few));
    }
    const uL = uA + 6;
    const vL = vAt(uL, 2.2);
    if (open(uL, vL, 1)) {
      b.color(0.35, 0.3, 0.26, 0);
      b.box(uL, ground(uL, vL), vL, 0.3, 3.2, 0.3, 0, { solid: true });
      b.lamp(uL, ground(uL, vL) + 3.4, vL, { reach: 22, strength: 1.1 });
    }
    const uZ = uA + 1;
    const vZ = vAt(uZ, 8);
    if (tier < 2 && open(uZ, vZ, 2)) {
      // a waymarker: a squat block with a pale cap, facing the stair
      b.color(0.62, 0.58, 0.52, 0);
      b.box(uZ, ground(uZ, vZ), vZ, 1.2, 1.4, 1.2, 0, { solid: true });
      b.color(0.95, 0.9, 0.8, 1);
      b.box(uZ, ground(uZ, vZ) + 1.4, vZ, 1.5, 0.25, 1.5, 0);
    }
  }
  jars(uH0 + 2, yL, vP + 4, Math.ceil(4 * few));
  jars(uF - 2, yD, vMid + (doorW / 2 + 6) * (b.rng() < 0.5 ? -1 : 1), Math.ceil(5 * few));
  for (const a of L.alleys) jars(a[0] + b.r(-3, 3), Yf, a[2], Math.ceil(3 * few));
  if (spec.carvings) {
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const v = vMid + s * (doorW / 2 + 5 + i * 2.6) + b.r(-0.2, 0.2);
        const h = b.r(2.6, 3.5);
        const k = b.r(0.85, 1);
        b.color(k, k * 0.98, k * 0.94, 0);
        b.box(uF - 0.42, yD - 0.2, v, 0.55, h, b.r(1.3, 1.7), b.r(-0.06, 0.06), { solid: true });
        b.color(0.42, 0.42, 0.42, 4);
        for (let row = 0; row < 5; row++) {
          const y = yD + 0.5 + row * 0.42;
          if (y > yD + h - 0.9) break;
          for (let q = -1; q <= 1; q++) {
            if (b.rng() < 0.3) continue;
            const tallM = b.rng() < 0.3;
            b.box(uF - 0.72, y, v + q * 0.36, 0.06, tallM ? 0.3 : 0.07, tallM ? 0.07 : b.r(0.14, 0.28));
          }
        }
      }
    }
  }
  for (const f of props) f();
  // ==== FINISH
  const ledge: Pt = [uH0 + 2, yL, vP];
  L.ledge = ledge;
  const built = b.finish({ ledge, centre: L.centre, relic: L.relic });
  built.extra.street = L;
  return built;
}
