// The flooded hall: a domed natural chamber whose floor is a still lake, with a half-drowned town
// in it. The stair from the hole runs down a dark stepped passage and comes out on a balcony high
// in the dome's flank. Three ways lead down: a stair tower that zigzags to a stone quay at the
// waterline, a stair cut inside the rock behind the near wall that comes out on the town's shore,
// and a gallery along the wall that ends on a rockfall worn into a walkable slope.
// A quay runs right round the hall at the waterline and climbs broad steps onto the podium before
// the door. A long bridge on arches crosses the lake to that podium; daylight falls through a hole
// in the roof onto the water before it. On one side of the bridge a town stands half in the water:
// houses on the dry shore, others drowned to their upper floors and reached by causeways and
// planks, a seated figure, a tower to climb; out on the open water a beacon. Small rooms are cut
// into the walls off the ring quay: a shrine, a store, a grotto, a seam.
//
// Laid out along u: hole, passage, the near wall with the balcony and the tower, the apron of
// the quay, the bridge over the lake, the podium, the door, the chamber behind it.
// Up and down: the roof's crown hangs just under the lid; the water lies H below it.
//
// The lake is never a trap: its bed shelves down in steps a walker can climb, and stairs and
// beaches run into the water from the quay, the podium and the shore.

import type { DeepSpec } from './types';
import { DeepBuilder, TEAL, mulberry32, type DeepData } from './builder';
import type { Pt } from './spans';

/** What was built where, local [u, y, v]: for checks. */
export interface HallLayout {
  ledge: Pt;
  centre: Pt;
  relic: Pt | null;
  stone: Pt | null;
  /** The water's level. */
  water: number;
  /** Foot of each route: stair tower, tunnel in the rock, rockfall. */
  feet: Pt[];
  /** Doorways of enterable buildings (outside, at their floor), and their roofs. */
  doors: Pt[];
  roofs: Pt[];
  /** Points on rooftop planks. */
  links: Pt[];
  /** Points on causeways out to drowned houses. */
  causeways: Pt[];
  /** Landmarks one can walk to: the figure's feet, the tower's top, the beacon's platform. */
  landmarks: Pt[];
  tower: Pt | null;
  figure: Pt | null;
  /** Other spots at the foot of the figure's plinth, in case the first is cut off. */
  figureNear: Pt[];
  beacon: Pt | null;
  /** Side scenes, and their entrances off the ring quay. */
  scenes: Pt[];
  sides: Pt[];
  /** Points round the ring quay. */
  ring: Pt[];
  /** Dense points down each of the three routes. */
  routes: Pt[][];
  /** Houses built, how many stand in the water, how many can be entered. */
  houses: number;
  drowned: number;
  entered: number;
  /** Places built but found cut off by the walk check, and so not claimed above. */
  dropped: number;
}

/**
 * Walk the finished place from the ledge (steps of half a metre, headroom, no deep water) and keep
 * in the layout only the doors, roofs, planks and landmarks that can be reached on foot.
 */
function walkCheck(g: DeepData['grid'], L: HallLayout): void {
  const K = g.K;
  const seen = new Uint8Array(g.nu * g.nv * K);
  const deepW = (k: number, ci: number): boolean => {
    const w = g.water;
    if (!w) return false;
    const lv = w[ci];
    return lv === lv && g.f[k] < lv - 1.2 && g.c[k] >= lv;
  };
  const start = g.spanAt(L.ledge[0], L.ledge[2], L.ledge[1] + 0.2);
  if (start < 0) return;
  const stack = [start];
  seen[start] = 1;
  const DI = [1, -1, 0, 0];
  const DJ = [0, 0, 1, -1];
  while (stack.length) {
    const k = stack.pop()!;
    const ci = (k / K) | 0;
    const i = ci % g.nu;
    const j = (ci / g.nu) | 0;
    for (let q = 0; q < 4; q++) {
      const ni = i + DI[q];
      const nj = j + DJ[q];
      if (ni < 0 || nj < 0 || ni >= g.nu || nj >= g.nv) continue;
      const nci = ni + nj * g.nu;
      const eu = g.u0 + (i + 0.5 + DI[q] * 0.5) * g.cu;
      const ev = g.v0 + (j + 0.5 + DJ[q] * 0.5) * g.cv;
      const fa = g.floorOf(k, ci, eu, ev);
      for (let t = 0; t < g.n[nci]; t++) {
        const nk = nci * K + t;
        if (seen[nk]) continue;
        const fb = g.floorOf(nk, nci, eu, ev);
        if (fb - fa > 0.5) continue;
        if (Math.min(g.c[k], g.c[nk]) - Math.max(fa, fb) < 1) continue;
        if (deepW(nk, nci)) continue;
        seen[nk] = 1;
        stack.push(nk);
      }
    }
  }
  const ok = (p: Pt): boolean => {
    for (let du = -1.2; du <= 1.2; du += 0.6) {
      for (let dv = -1.2; dv <= 1.2; dv += 0.6) {
        const k = g.spanAt(p[0] + du, p[2] + dv, p[1] + 0.3);
        if (k >= 0 && seen[k] && Math.abs(g.floorOf(k, (k / K) | 0, p[0] + du, p[2] + dv) - p[1]) < 1.5) return true;
      }
    }
    return false;
  };
  const keep = (a: Pt[]): Pt[] => {
    const r = a.filter(ok);
    L.dropped += a.length - r.length;
    return r;
  };
  L.doors = keep(L.doors);
  L.roofs = keep(L.roofs);
  L.links = keep(L.links);
  L.causeways = keep(L.causeways);
  L.landmarks = keep(L.landmarks);
  if (L.tower && !ok(L.tower)) L.tower = null;
  if (L.figure && !ok(L.figure)) {
    L.figure = L.figureNear.find(ok) ?? null;
    if (L.figure) L.landmarks.push(L.figure);
  }
  if (L.beacon && !ok(L.beacon)) L.beacon = null;
}

/** A built deep's layout, for checks: left on it by the build (see DeepData.extra). */
export function hallLayout(d: object): HallLayout | undefined {
  return (d as { hall?: HallLayout }).hall;
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

/** Distance from a point to a rectangle, 0 inside it. */
const outside = (u: number, v: number, u0: number, v0: number, u1: number, v1: number): number => {
  const du = Math.max(u0 - u, 0, u - u1);
  const dv = Math.max(v0 - v, 0, v - v1);
  return Math.sqrt(du * du + dv * dv);
};

export function buildHall(spec: DeepSpec): DeepData {
  const tier = spec.tier;
  const lid = spec.lid;
  // the shape of the place comes from a generator of its own, so every tier builds the same hall
  const rnd = mulberry32(Math.imul(spec.seed | 0, 0x9e3779b1) ^ 0x4a11f);
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

  // ---- heights
  const H = R(60, 86); // water to the crown of the roof
  const Yc = lid - 1.5; // the crown
  const yA = lid - 2.9; // foot of the stair down the hole (the builder's b.foot)
  const Yw = Yc - H; // the water
  const Yq = Yw + 0.6; // the quay
  const Yd = Yq + 4; // the bridge's deck and the podium before the door
  const BED = 2.3; // the lake at its deepest
  const SHELF = 0.5; // and along its edges
  const LOW = Yw - BED - 2; // under everything

  const b = new DeepBuilder(spec, { cell: tier === 2 ? 2 : 1, yMin: LOW - 2, maxSpans: 7, wallStep: tier === 0 ? 3 : 6 });
  const g = b.grid;
  const STONE = b.paint(0.94, 0.92, 0.88, 0); // worked stone: quay, stairs, bridge
  const MOSS = b.paint(0.7, 0.84, 0.68, 0); // rock that stands in the water

  // ---- the plan: a rounded hall, its outline pulled in here and there
  const PW = 3.6;
  const PH = 2.5;
  const L1 = even(R(14, 22));
  const L3 = even(R(14, 22));
  const uT = 4 + L1 + 2; // the middle of the passage's corner
  const uH0 = uT + 2 + L3; // the near wall, where the outline is not pulled in
  const Du = Math.min(R(170, 240), spec.u1 - uH0 - 34);
  const Dv = Math.min(R(170, 240), spec.v1 - spec.v0 - 16);
  const Ru = Du / 2;
  let Rv = Dv / 2;
  const uC = uH0 + Ru;
  const LV = 54; // as far as the passage will go sideways to find the hall
  const vC0 = R(-20, 20);
  let vC = vC0;
  let vP = 0;
  for (;;) {
    vC = Math.min(spec.v1 - 8 - Rv, Math.max(spec.v0 + 8 + Rv, vC0));
    vP = onV(Math.min(LV, Math.max(-LV, vC + R(-0.15, 0.15) * Rv)));
    if (Math.abs(vP) < 7.2) vP = 0;
    // a hole far to one side of its room: a narrower hall, so the passage still meets it near the middle
    if (Math.abs(vC - vP) <= 0.3 * Rv || Rv <= 82) break;
    Rv -= 2;
  }
  const pw = R(2.6, 3.4); // how square the plan is
  const qd = R(1.8, 2.4); // and how square the dome's section
  const wallH = R(0.12, 0.24) * H; // the roof at the rim, over the water
  const a1 = R(0.006, 0.02);
  const a2 = R(0.005, 0.015);
  const a3 = R(0.003, 0.01);
  const f1 = R(0, 6.28);
  const f2 = R(0, 6.28);
  const f3 = R(0, 6.28);
  /** 0 at the middle of the hall, 1 at its wall. */
  const dn = (u: number, v: number): number => {
    const x = (u - uC) / Ru;
    const y = (v - vC) / Rv;
    const d = Math.pow(Math.pow(Math.abs(x), pw) + Math.pow(Math.abs(y), pw), 1 / pw);
    const th = Math.atan2(y, x);
    return d * (1 + a1 * (1 + Math.sin(2 * th + f1)) + a2 * (1 + Math.sin(3 * th + f2)) + a3 * (1 + Math.sin(5 * th + f3)) + 0.02 * vnoise(u / 13, v / 13));
  };
  const Rm = Math.min(Ru, Rv) * 0.9; // (1 - dn) * Rm: about how far it is to the wall, never more

  // where the passage breaks through
  let uW = uH0;
  while (uW < uC - 20 && !(dn(uW + 1, vP) < 0.97 && dn(uW + 1, vP - 1.8) < 0.97 && dn(uW + 1, vP + 1.8) < 0.97)) uW += 2;

  // ---- the way in: stair, then a stepped passage, unlit
  const turn = vP !== 0;
  const pdir = Math.sign(vP);
  const Lp = turn ? uT - 2 - 4 + (Math.abs(vP) - 3.6) + (uW - uT - 2) : uW - 4;
  // down as far as its length allows, toward a balcony a little over half-way up the hall
  const drop = Math.min(H * R(0.4, 0.5) - 1.4, 0.5 * Lp);
  const yL = yA - drop; // the balcony
  const sP = drop / Lp;
  b.holeStair();
  g.roughNow = 0.12;
  if (turn) {
    const y1 = yA - sP * (uT - 6);
    const y2 = y1 - sP * (Math.abs(vP) - 3.6);
    g.carveRun([4, yA, 0], [uT - 2, y1, 0], PW, PH, { steps: true });
    g.carveBox(uT - 2, -1.8, uT + 2, 1.8, y1, y1 + PH);
    g.carveRun([uT, y1, pdir * 1.8], [uT, y2, vP - pdir * 1.8], 4, PH, { steps: true });
    g.carveBox(uT - 2, vP - 1.8, uT + 2, vP + 1.8, y2, y2 + PH);
    g.carveRun([uT + 2, y2, vP], [uW, yL, vP], PW, PH, { steps: true });
  } else {
    g.carveRun([4, yA, 0], [uW, yL, 0], PW, PH, { steps: true });
  }

  // ---- the stair tower: flights back and forth, each a lane further from the wall
  const yH = yL - 2; // the tower's head: a few steps down from the balcony, so the floor falls away before the eye
  const hQ = yH - Yq;
  const nF = Math.max(3, Math.ceil(hQ / 13));
  const hF = hQ / nF;
  const FL = onV(hF / 0.5); // length of a flight
  const SW = 4; // width of one
  const LAND = 3.6;
  const Wq = 8; // width of the quay along the wall
  const BK = 6; // and of the way behind the tower
  const uS = uW + BK; // the tower's back
  const uTf = uS + nF * SW; // and its front
  const tdir = Math.abs(vC - vP) > 6 ? Math.sign(vC - vP) : rnd() < 0.5 ? -1 : 1; // which way the first flight goes
  const vS0 = vP + tdir * 1.8; // head of the first flight
  const vS1 = vS0 + tdir * FL; // its foot
  const tv0 = Math.min(vP - tdir * 1.8, vS1 + tdir * LAND);
  const tv1 = Math.max(vP - tdir * 1.8, vS1 + tdir * LAND);
  const yF = (k: number): number => (k >= nF ? Yq : yH - k * hF);

  // ---- the apron: the quay about the tower's foot
  const uA0 = uH0 - 2;
  const uA1 = uTf + 8;
  const av0 = tv0 - 9;
  const av1 = tv1 + 9;
  const aMid = (tv0 + tv1) / 2;

  // ---- the bridge, the podium, the door
  const vBr = onV(R(tv0 + 1.8, tv1 - 1.8));
  const uF = even(uC + Ru - 2); // the door wall
  const TD = 28; // depth of the podium
  const TH = 16.2; // its half-width
  const uT0 = uF - TD;
  const ub0 = uA1 + 8; // where the bridge's own stair tops out
  const doorW = rnd() < 0.5 ? 7.2 : 10.8;
  const doorH = R(16, 22);
  // the side of the bridge the town stands on, and the tunnel goes down: the wider, if the tunnel fits there
  const roomFor = (sd: number): number => Math.floor((sd * ((sd > 0 ? spec.v1 - 3 : spec.v0 + 3) - (vP + sd * 5.4)) - 4) / 1.8) * 1.8;
  const tWof = (sd: number): number => Rv + sd * (vC - vBr);
  const ts = tWof(-tdir) > tWof(tdir) + 8 && roomFor(-tdir) >= yL - Yq + 12 ? -tdir : tdir;
  const gs = -ts; // the side the light falls on, over open water, and the podium's water stair
  const ws = rnd() < 0.5 ? -1 : 1; // the side of the bridge the quay's water stair is on
  const vG = vBr + gs * 5.4;
  const GL = 10; // the podium's water stair
  const vWs = vBr + ws * 7.2;
  const WL = 4; // the quay's

  // ---- the ring: a quay right round the hall at the waterline, wider and narrower as it goes
  const qs = rnd() < 0.5 ? -1 : 1; // which way round the lamps are set
  const quayW = (u: number, v: number): number => Wq * (0.8 + 0.3 * vnoise(u / 40 + 5.3, v / 40 + 1.9));
  // rock shelves left standing at the water's edge beyond it: what makes the lake's outline its own
  const bk = R(9, 14);
  const bankW = (u: number, v: number): number => {
    if (u > uT0 - 16 && Math.abs(v - vBr) < TH + 10) return 0;
    if ((v - vBr) * ts > 0) return 0;
    return Math.max(0, 2.2 * bk * vnoise(u / 36 + 7.3, v / 36 + 2.1) - bk * 0.75);
  };
  // ---- the town's dry ground: the outer part of the tower's side of the lake, from the near wall
  // to short of the podium; between it and the bridge its houses stand in the water
  const uTa = uH0 - 4;
  const uTb = uT0 - 16;
  const tW = Rv + ts * (vC - vBr); // from the bridge to the side wall
  const vl0 = Math.max(26, tW * R(0.24, 0.3));
  const vl1 = Math.max(8, tW * R(0.08, 0.16));
  const vLand = (u: number): number => vl0 + vl1 * vnoise(u / 45 + 3.1, 0.7 + ns * 0.001);
  /** How far into the town's dry ground a spot is (negative: out in the water). */
  const landD = (u: number, v: number): number => Math.min(ts * (v - vBr) - vLand(u), u - uTa, uTb - u);
  /** How far out into the lake a spot is, from whatever is dry. */
  const offshore = (u: number, v: number, w: number): number =>
    Math.min(
      w - Math.max(quayW(u, v), bankW(u, v)),
      -landD(u, v),
      outside(u, v, uA0, av0, uA1, av1),
      outside(u, v, uT0, vBr - TH, uF, vBr + TH),
      outside(u, v, uT0 - GL, vG - 3.6, uT0, vG + 3.6),
      outside(u, v, uA1, vWs - 3.6, uA1 + WL, vWs + 3.6),
    );
  const bed = (s: number): number => Yw - (s < 4 ? SHELF : Math.min(BED, SHELF + 0.45 * Math.ceil((s - 4) / 2.6)));

  // ---- cut it. First what is let into the rock, so it stands whatever the outline does:
  // the bay before the door, the door, the chamber
  const bayH = doorH + R(7, 11);
  const QC = 3; // roofs come down in courses this high, on the same lines the walls are coursed by
  // the bay's roof steps up and out from over the door, so the light of the shaft comes in under it
  const bayRoof = (u: number, v: number): number =>
    u >= uT0 && Math.abs(v - vBr) <= TH ? Math.min(Yc, QC * Math.round((Yd + bayH + Math.max(0, 1.1 * (uF - 6 - u))) / QC)) : -Infinity;
  g.roughNow = 0.08;
  g.paintF = STONE;
  g.carveFn(uT0, vBr - TH, uF, vBr + TH, (u, v, o) => {
    o.floor = Yd;
    o.ceil = bayRoof(u, v);
    return true;
  });
  g.carveBox(uF, vBr - doorW / 2 - 1.8, uF + 2, vBr + doorW / 2 + 1.8, Yd, Yd + doorH + 2); // the frame
  g.carveBox(uF, vBr - doorW / 2, uF + 5, vBr + doorW / 2, Yd, Yd + doorH);
  g.carveBox(uF + 5, vBr - 10.8, uF + 23, vBr + 10.8, Yd, Yd + doorH + 3);
  // the way round the tower at the quay's level: behind it (under the balcony), past its ends, before it
  g.carveBox(uW + 2, tv0 - 5.4, uS, tv1 + 5.4, Yq, Yq + 4.6);
  g.carveBox(uW + 2, tv0 - 5.4, uA1, tv0, Yq, Yq + 4.6);
  g.carveBox(uW + 2, tv1, uA1, tv1 + 5.4, Yq, Yq + 4.6);
  g.carveBox(uTf, tv0 - 5.4, uA1, tv1 + 5.4, Yq, Yq + 4.6);
  // the balcony's niche, and room over every flight and landing where the roof comes down on the tower
  g.carveBox(uW, vP - 3.6, uW + 2, vP + 3.6, yL, yL + 7);
  g.carveBox(uW + 2, vP - 3.6, uS, vP + 3.6, yH, yL + 7);
  g.carveBox(uS, vP - 1.8, uS + SW, vP + 1.8, yH, yL + 7);
  interface Flight { u: number; va: number; vb: number; y0: number; y1: number; dir: number }
  const flights: Flight[] = [];
  for (let k = 0; k < nF; k++) {
    const fwd = k % 2 === 0;
    const fl: Flight = { u: uS + k * SW + SW / 2, va: fwd ? vS0 : vS1, vb: fwd ? vS1 : vS0, y0: yF(k), y1: yF(k + 1), dir: fwd ? tdir : -tdir };
    flights.push(fl);
    g.carveRun([fl.u, fl.y0, fl.va], [fl.u, fl.y1, fl.vb], SW, 6, { steps: true });
    if (k < nF - 1) g.carveBox(fl.u - SW / 2, Math.min(fl.vb, fl.vb + fl.dir * LAND), fl.u + SW * 1.5, Math.max(fl.vb, fl.vb + fl.dir * LAND), fl.y1, fl.y1 + 6);
  }

  // the hall itself: lake, quay, podium, and the dome over them
  const roof = (u: number, v: number, d: number): number => {
    const prof = Math.pow(1 - Math.pow(d, qd), 1 / qd);
    return Math.min(Yc, QC * Math.round((Yc - (H - wallH) * (1 - prof) - 3 * vnoise(u / 31 + 11, v / 31)) / QC));
  };
  // over the balcony and the tower the roof is cut back in a flat-topped embrasure, widening as it
  // goes out to where the dome has risen clear of it, so the hall is seen whole from the passage's mouth
  const yE = Math.min(Yc, QC * Math.ceil((yL + 7) / QC));
  let tE = 12;
  while (tE < 0.75 * Ru && roof(uW + tE, vP, dn(uW + tE, vP)) < yE) tE += 2;
  const embr = (u: number, v: number): number => {
    const t = u - uW;
    return t >= 0 && t <= tE + 4 && Math.abs(v - vP) <= 7.2 + 0.5 * t ? yE : -Infinity;
  };
  const SAND = b.paint(0.9, 0.82, 0.68, 0); // the town's ground
  /** What the floor of the hall is, before anything is built on it; `pk` says what it is made of. */
  let pk = 0; // 0 lake bed, 1 worked stone, 2 rock shelf, 3 the town's ground
  const planFloor = (u: number, v: number): number => {
    const d = dn(u, v);
    if (d >= 1) return NaN;
    const w = (1 - d) * Rm;
    const dv = Math.abs(v - vBr);
    pk = 1;
    if (u >= uT0 && dv <= TH) return Yd;
    if (u >= uA0 && u <= uA1 && v >= av0 && v <= av1) return Yq;
    if (w < quayW(u, v)) {
      // where the ring meets the bay it climbs broad steps onto the podium
      if (u > uT0 - 18 && dv < TH + 10) return Yq + Math.min(4, 0.4 * Math.ceil(Math.max(0, TH + 10 - dv)));
      return Yq;
    }
    const ld = landD(u, v);
    if (ld > 0) {
      pk = 3;
      const lev = Math.min(Math.floor(3 * vnoise(u / 17 + 1.7, v / 17 + 4.2)), Math.floor(ld / 5));
      return Yq + 0.4 * Math.max(0, lev);
    }
    if (ld > -3) {
      pk = 3; // a beach, down in steps into the water
      return Math.max(Yw - SHELF, Yq - 0.4 * Math.ceil(-ld));
    }
    const bw = bankW(u, v);
    if (w < bw) {
      pk = 2;
      return Yw + 0.2 + 0.45 * Math.floor(3 * vnoise(u / 11 + 3, v / 11 + 9)); // (never more than a step above the quay)
    }
    pk = 0;
    return bed(offshore(u, v, w));
  };
  g.carveFn(uC - Ru - 1, vC - Rv - 1, uC + Ru + 1, vC + Rv + 1, (u, v, o) => {
    const F = planFloor(u, v);
    if (F !== F) return false;
    o.floor = F;
    o.ceil = Math.max(embr(u, v), bayRoof(u, v), roof(u, v, dn(u, v)));
    g.paintF = pk === 0 ? 0 : pk === 1 ? STONE : pk === 2 ? MOSS : SAND;
    g.roughNow = pk === 1 ? 0.06 : tier === 2 ? 0.5 : 0.42;
    return true;
  });

  // ---- build in it. The tower: every flight and landing solid to the lake's bed
  g.paintF = STONE;
  g.roughNow = 0;
  const TALL = yL - LOW;
  g.fillBox(uW - 1, vP - 3.6, uW + 2, vP + 3.6, yL - 2, yL); // the balcony
  g.fillRun([uW + 2, yL, vP], [uS, yH, vP], 7.2, 2, { steps: true }); // and its steps, bridging to the tower's head
  g.fillBox(uS, vP - 1.8, uS + SW, vP + 1.8, LOW, yH);
  for (let k = 0; k < nF; k++) {
    const fl = flights[k];
    g.fillRun([fl.u, fl.y0, fl.va], [fl.u, fl.y1, fl.vb], SW, TALL, { steps: true });
    if (k < nF - 1) g.fillBox(fl.u - SW / 2, Math.min(fl.vb, fl.vb + fl.dir * LAND), fl.u + SW * 1.5, Math.max(fl.vb, fl.vb + fl.dir * LAND), LOW, fl.y1);
  }

  // the bridge: a stair up from the apron, then a deck on arches to the podium
  g.fillRun([uA1, Yq, vBr], [ub0, Yd, vBr], 3.6, 12, { steps: true });
  const span = uT0 - ub0;
  const nB = Math.max(2, Math.round(span / R(14, 20)));
  const piers: number[] = [];
  for (let i = 0; i <= nB; i++) piers.push(ub0 + even((span * i) / nB));
  g.roughNow = 0.05;
  g.fillFn(ub0, vBr - 1.8, uT0, vBr + 1.8, (u, _v, o) => {
    let i = 0;
    while (i < nB - 1 && u >= piers[i + 1]) i++;
    const half = (piers[i + 1] - piers[i]) / 2 - 2;
    const t = (u - (piers[i] + piers[i + 1]) / 2) / half;
    o.hi = Yd;
    o.lo = Math.abs(t) >= 1 ? LOW : Yw + 0.3 + (Yd - 1.1 - Yw - 0.3) * Math.sqrt(1 - t * t);
    return true;
  });
  // stairs into the water, worn: from the quay beside the bridge, and broad ones from the podium
  g.roughNow = 0.1;
  g.fillRun([uA1, Yq, vWs], [uA1 + WL, Yw - SHELF, vWs], 7.2, 6, { steps: true });
  g.fillRun([uT0, Yd, vG], [uT0 - GL, Yw - SHELF, vG], 7.2, 12, { steps: true });

  // ---- light from above: one great shaft over the water before the door. (One only: every vertex in the
  // hall looks for each shaft's opening when the light is baked, and a second costs half as much again.)
  let su = uT0 - R(10, 18);
  let sv = vBr + gs * R(13, 19);
  for (let i = 0; i < 12 && dn(su, sv) > 0.78; i++) {
    su += (uC - su) * 0.1;
    sv += (vC - sv) * 0.1;
  }
  const sr = R(7.5, 10.5);

  const L: HallLayout = {
    ledge: [uW + 1.5, yL, vP], centre: [uF + 1, Yd, vBr], relic: null, stone: null, water: Yw, feet: [], doors: [], roofs: [], links: [], causeways: [],
    landmarks: [], tower: null, figure: null, figureNear: [], beacon: null, scenes: [], sides: [], ring: [], routes: [[], [], []], houses: 0, drowned: 0, entered: 0, dropped: 0,
  };
  const props: (() => void)[] = []; // dressing, done once the carving is over
  const gd = -ts; // the far side from the town: the gallery and the rockfall
  // the first way down, the tower: its flights, and its foot on the apron
  for (const fl of flights) for (let q = 0; q <= 8; q++) L.routes[0].push([fl.u, fl.y0 + ((fl.y1 - fl.y0) * q) / 8, fl.va + ((fl.vb - fl.va) * q) / 8]);
  const footV = flights[nF - 1].vb + flights[nF - 1].dir * 2.5;
  L.feet.push([flights[nF - 1].u, Yq, footV]);

  /** Somewhere to walk, whatever is there: rock under it to y, air over it. */
  const shelf = (u0: number, v0: number, u1: number, v1: number, y: number, deep = 2): void => {
    g.fillBox(Math.min(u0, u1), Math.min(v0, v1), Math.max(u0, u1), Math.max(v0, v1), y - deep, y);
    g.carveBox(Math.min(u0, u1), Math.min(v0, v1), Math.max(u0, u1), Math.max(v0, v1), y, y + 3);
  };

  // ---- the second way down: a stair cut inside the rock behind the near wall, a flight along it,
  // a turn and a flight back, then out through the wall onto the shore
  let tunnelExit: [number, number] = [uH0, vP];
  {
    g.paintF = STONE;
    g.roughNow = 0.05;
    const uLA = uH0 - 3.6;
    const uLB = uH0 - 7.6;
    const D = yL - Yq;
    const vA0 = vP + ts * 5.4;
    const edge = ts > 0 ? spec.v1 - 3 : spec.v0 + 3;
    const maxA = Math.floor((ts * (edge - vA0) - 4) / 1.8) * 1.8;
    const hallA = ts * (vC + ts * 0.75 * Rv - vA0);
    let FA = 2 * D;
    let FB = 0;
    if (FA > Math.min(maxA, hallA)) {
      FB = Math.max(14, 2 * D - maxA);
      FA = 2 * D - FB;
    }
    const vA1 = vA0 + ts * FA;
    const yT = yL - FA / 2;
    shelf(uLA - 2, vP + ts * 1.8, uW + 0.5, vA0, yL);
    g.carveRun([uLA, yL, vA0], [uLA, yT, vA1], 4, 3, { steps: true });
    for (let t = 4; t <= FA; t += 2) L.routes[1].push([uLA, yL - t / 2, vA0 + ts * t]);
    let uLx = uLA;
    let vEnd = vA1;
    let dirE = ts;
    if (FB > 0) {
      g.carveBox(uLB - 2, Math.min(vA1, vA1 + ts * 3.6), uLA + 2, Math.max(vA1, vA1 + ts * 3.6), yT, yT + 3);
      vEnd = vA1 - ts * FB;
      g.carveRun([uLB, yT, vA1], [uLB, Yq, vEnd], 4, 3, { steps: true });
      for (let t = 0; t <= FB; t += 2) L.routes[1].push([uLB, yT - t / 2, vA1 - ts * t]);
      uLx = uLB;
      dirE = -ts;
    }
    // out: a level way through the wall, on a jetty where it meets the water
    const vX = vEnd + dirE * 1.8;
    let uX = uH0;
    for (let run = 0; uX < uH0 + 70 && run < 3; uX += 1) {
      let dry = true;
      for (const dv of [-1.2, 0, 1.2]) {
        const F = planFloor(uX, vX + dv);
        if (!(F >= Yq - 0.01 && F <= Yq + 0.01)) dry = false;
      }
      run = dry ? run + 1 : 0;
    }
    g.carveBox(uLx - 2, Math.min(vEnd, vEnd + dirE * 3.6), uX, Math.max(vEnd, vEnd + dirE * 3.6), Yq, Yq + 3);
    g.fillBox(uH0 - 2, Math.min(vEnd, vEnd + dirE * 3.6), uX, Math.max(vEnd, vEnd + dirE * 3.6), LOW, Yq);
    for (let u = uLx; u < uX; u += 2) L.routes[1].push([u, Yq, vX]);
    L.feet.push([uX + 1, Yq, vX]);
    tunnelExit = [uX, vX];
    const lampsT: Pt[] = [[uLA, yL - 2 + 2.2, vA0 + ts * 4]];
    if (FB > 0) lampsT.push([uLA + 1.4, yT + 2.2, vA1 + ts * 1.8]);
    lampsT.push([uLx, Yq + 2.2, vEnd + dirE * 1.8]);
    props.push(() => {
      for (const p of lampsT) b.lamp(p[0], p[1], p[2], { reach: 13, strength: 0.75 });
      for (let t = 18; t < FA - 6; t += tier === 2 ? 36 : 18) b.lamp(uLA - 1.6, yL - t / 2 + 2.2, vA0 + ts * t, { reach: 12, strength: 0.7 });
      b.lamp(uX + 1, Yq + 2.4, vX - dirE * 2.4, { reach: 16 });
    });
  }

  // ---- the third way down: a gallery behind the near wall, then a rockfall worn into a slope
  // along the far side wall, down to the ring
  const gr = 0.45;
  const uB0 = uH0 - 1.8;
  const uFoot = uB0 + (yL - Yq) / gr;
  let vWall = vC + gd * Rv;
  for (let t = 0; t < 1.3 * Rv; t += 1) {
    if (dn(uFoot, vC + gd * t) >= 1) {
      vWall = vC + gd * t;
      break;
    }
  }
  // clear of the ring where it is low, so the ring passes beside it there (and under it where it is high)
  let vQ = vWall;
  for (let u = uFoot - 16; u <= uFoot + 8; u += 2) {
    for (let t = 0; t < 40; t += 0.5) {
      const v = vWall - gd * t;
      const d = dn(u, v);
      if (d < 1 && (1 - d) * Rm >= quayW(u, v)) {
        if ((vQ - v) * gd > 0) vQ = v;
        break;
      }
    }
  }
  const vS = onV(vQ - gd * 8);
  const surf = (u: number): number => (u <= uB0 ? yL : Math.max(Yq, yL - gr * (u - uB0)));
  {
    g.paintF = STONE;
    g.roughNow = 0.1;
    shelf(uH0 - 5.6, vP + gd * 1.8, uW + 0.5, vP + gd * 5.4, yL);
    g.carveBox(uH0 - 5.6, Math.min(vP + gd * 5.4, vS + gd * 4), uH0 - 1.6, Math.max(vP + gd * 5.4, vS + gd * 4), yL, yL + 3);
    for (let v = vP + gd * 9; (vS - v) * gd > 0; v += gd * 2) L.routes[2].push([uH0 - 3.6, yL, v]);
    g.paintF = MOSS;
    g.roughNow = tier === 2 ? 0.5 : 0.4;
    g.fillFn(uH0 - 5.6, vS - 4, uFoot + 8, vS + 4, (u, v, o) => {
      const y = surf(u);
      const edge = 4 - Math.abs(v - vS);
      o.hi = y;
      o.lo = y > Yq + 6 ? y - 3 - 2 * vnoise(u / 4, v / 4) : LOW;
      if (u > uB0 && y > Yq) o.su = -gr;
      return edge > 0;
    });
    g.carveFn(uH0 - 5.6, vS - 4, uFoot + 8, vS + 4, (u, _v, o) => {
      o.floor = surf(u);
      o.ceil = o.floor + 4;
      if (u > uB0 && o.floor > Yq) o.su = -gr;
      return true;
    });
    // its foot spreads to the wall, onto the ring
    g.fillBox(uFoot - 2, Math.min(vS, vWall + gd * 2), uFoot + 8, Math.max(vS, vWall + gd * 2), LOW, Yq);
    for (let u = uB0; u < uFoot; u += 3) L.routes[2].push([u, surf(u), vS]);
    L.feet.push([uFoot + 4, Yq, vS]);
    // rubble heaped either side of it
    g.fillFn(uB0, vS - 9, uFoot, vS + 9, (u, v, o) => {
      const e = (vS - v) * gd - 4;
      if (e <= 0) return false;
      const y = surf(u) - 1.5 * e - 2 * vnoise(u / 5 + 3, v / 5);
      if (y < Yw - 1) return false;
      o.hi = y;
      o.lo = y - 4;
      return true;
    });
    props.push(() => {
      for (let u = uB0 + 14; u < uFoot - 4; u += tier === 2 ? 60 : 34) b.lamp(u, surf(u) + 1.6, vS + ts * 3.2, { reach: 16, strength: 0.8 });
      b.lamp(uH0 - 3.6, yL + 2.2, vS + gd * 2.4, { reach: 13, strength: 0.75 });
      for (let v = vP + gd * 22; (vS - v) * gd > 10; v += gd * (tier === 2 ? 50 : 30)) b.lamp(uH0 - 2, yL + 2.2, v, { reach: 12, strength: 0.7 });
      b.lamp(uFoot + 4, Yq + 1.8, vWall + gd * -3, { reach: 16 });
    });
  }

  // ---- pillars: natural columns, lake bed to roof
  const pillars: [number, number, number][] = [];
  {
    const nP = 3 + Math.floor(rnd() * 4);
    for (let tries = 0; tries < 300 && pillars.length < nP; tries++) {
      const u = R(uH0 + 34, uT0 - 20);
      const v = vC + R(-0.8, 0.8) * Rv;
      const r = R(3.5, 6.5);
      if (dn(u, v) > 0.78) continue;
      if (Math.abs(v - vBr) < r + 16) continue;
      if (Math.abs(v - vP) < r + 14 && u < uW + 110) continue; // the view out from the balcony
      if (outside(u, v, uA0, av0, uA1, av1) < r + 10) continue;
      if (Math.hypot(u - su, v - sv) < sr + r + 8) continue;
      if (Math.abs(v - vS) < r + 14 && u < uFoot + r + 12) continue;
      if (Math.hypot(u - tunnelExit[0], v - tunnelExit[1]) < r + 16) continue;
      if (pillars.some((p) => Math.hypot(p[0] - u, p[1] - v) < p[2] + r + 30)) continue;
      pillars.push([u, v, r]);
    }
    g.roughNow = 0.5;
    g.paintF = MOSS;
    for (const [pu, pv, pr] of pillars) {
      for (let q = 0; q < 3; q++) {
        const y0 = q === 0 ? LOW : Yw + (H * q) / 3;
        const y1 = q === 2 ? Yc + 1 : Yw + (H * (q + 1)) / 3;
        g.fillCyl(pu, pv, pr * [1.3, 0.8, 1.2][q] * (0.9 + 0.2 * rnd()), y0, y1, 0.05);
      }
    }
  }

  // ---- a beacon out on the open water, reached by a stair off the bridge and a causeway
  {
    const cand = piers.slice(1, -1).filter((pu) => Math.abs(pu - su) > sr + 6 && pu < uT0 - 14);
    const X0 = R(26, 38);
    const hB = R(14, 20);
    const tries: [number, number][] = [];
    for (const X of [X0, 22, 46]) for (const pu of cand.sort((a2, c) => Math.abs(a2 - (ub0 + uT0) / 2) - Math.abs(c - (ub0 + uT0) / 2))) tries.push([X, pu]);
    for (const [X, pu] of tries) {
      const vB = onV(vBr + gd * X);
      if (dn(pu, vB) > 0.8 || Math.abs(vB - vS) < 16 || Math.hypot(pu - su, vB - sv) < sr + 8) continue;
      if (pillars.some((p) => Math.hypot(p[0] - pu, p[1] - vB) < p[2] * 1.4 + 9 || (Math.abs(p[0] - pu) < p[2] * 1.4 + 3 && (p[1] - vBr) * gd > 0 && (p[1] - vB) * gd < 0))) continue;
      g.paintF = STONE;
      g.roughNow = 0.08;
      g.fillRun([pu, Yd, vBr + gd * 1.8], [pu, Yq, vBr + gd * 9.8], 2.4, Yd - LOW, { steps: true });
      g.fillBox(pu - 1.2, Math.min(vBr + gd * 9.8, vB), pu + 1.2, Math.max(vBr + gd * 9.8, vB), LOW, Yq);
      g.fillCyl(pu, vB, 5.5, LOW, Yq);
      g.fillCyl(pu, vB, 2.4, Yq, Yq + hB);
      for (let v = vBr + gd * 12; (vB - v) * gd > 6; v += gd * 3) L.causeways.push([pu, Yq, v]);
      L.beacon = [pu + 4, Yq, vB];
      L.landmarks.push(L.beacon);
      props.push(() => {
        b.color(0.95, 0.93, 0.88, 0);
        b.cyl(pu, Yq + hB, vB, 3, 0.6, { sides });
        b.cyl(pu, Yq + hB + 0.6, vB, 1.6, 1.4, { sides, top: 0.9 });
        b.cone(pu, Yq + hB + 2, vB, 1.9, 2.2, { sides });
        b.lamp(pu, Yq + hB + 1.3, vB, { reach: 40, strength: 1.4, size: 2, body: false });
        b.lamp(pu + 3.6, Yq + 1.6, vB, { reach: 14, strength: 0.8 });
        for (const s of [-1, 1]) post(pu + s * 1.6, Yq, vB - gd * 6);
      });
      break;
    }
  }

  // ---- rocks standing out of the lake
  {
    const nI = 2 + Math.floor(rnd() * 5);
    g.roughNow = 0.5;
    for (let i = 0, tries = 0; i < nI && tries < 60; tries++) {
      const u = uC + R(-0.8, 0.8) * Ru;
      const v = vC + R(-0.8, 0.8) * Rv;
      const r = R(3, 9);
      const h = R(2, 12);
      const d = dn(u, v);
      if (d > 0.9 || offshore(u, v, (1 - d) * Rm) < r + 6 || Math.abs(v - vBr) < r + 7) continue;
      if (Math.hypot(su - u, sv - v) < r + sr + 5) continue;
      if ((v - vBr) * gd < 0 || (Math.abs(v - vS) < r + 12 && u < uFoot + r + 10)) continue;
      if (L.beacon && Math.hypot(u - L.beacon[0], v - L.beacon[2]) < r + 12) continue;
      if (L.beacon && Math.abs(u - L.beacon[0]) < r + 4 && (v - vBr) * gd < (L.beacon[2] - vBr) * gd + r) continue;
      if (pillars.some((p) => Math.hypot(p[0] - u, p[1] - v) < p[2] * 1.4 + r + 4)) continue;
      i++;
      g.paintF = MOSS;
      g.fillFn(u - r - 2, v - r - 2, u + r + 2, v + r + 2, (cu, cv, o) => {
        const q = (Math.hypot(cu - u, cv - v) / r) * (0.75 + 0.5 * vnoise(cu / 5 + i, cv / 5));
        if (q >= 1) return false;
        o.lo = LOW;
        o.hi = Yw - 0.4 + 1.2 * Math.round(((h + 0.4) * (1 - q * q)) / 1.2);
        return o.hi > Yw - BED;
      });
    }
  }

  // ================================================================ the half-drowned town
  /** The dry floor of the town or the ring at a spot, or NaN where it is water, rock or worked stone. */
  const ground = (u: number, v: number): number => {
    const F = planFloor(u, v);
    if (F !== F) return NaN;
    if (pk === 3 && F >= Yq - 0.01) return F;
    if (pk === 1 && Math.abs(F - Yq) < 0.01) return F;
    return NaN;
  };
  const PU = 18;
  const PV = 12.6;
  const uL0 = even(uH0 + 6);
  const nI = Math.max(0, Math.floor((uTb + 4 - uL0) / PU));
  const nJ = Math.max(0, Math.floor((Rv + ts * (vC - vBr) - 18) / PV));
  const vL0 = ts > 0 ? onV(vBr + 14) : onV(vBr - 14) - nJ * PV;
  interface Lot { i: number; j: number; u: number; v: number; ok: boolean; wet: boolean; used: boolean; score: number }
  const lots: Lot[] = [];
  const lotAt = (i: number, j: number): Lot | undefined => (i < 0 || j < 0 || i >= nI || j >= nJ ? undefined : lots[i * nJ + j]);
  const keepClear: [number, number, number][] = [[tunnelExit[0], tunnelExit[1], 12], [L.feet[0][0], L.feet[0][2], 10]];
  const blocked: [number, number, number, number][] = []; // rectangles causeways must keep out of
  for (let i = 0; i < nI; i++) {
    for (let j = 0; j < nJ; j++) {
      const u = uL0 + i * PU;
      const v = vL0 + j * PV;
      // dry ground all over, or water (or a beach) under some of it: then it is built up from the bed
      let land = true;
      let ok = true;
      for (let q = 0; q < 9 && ok; q++) {
        const su2 = u + 1 + (q % 3) * 8;
        const sv2 = v + 0.5 + Math.floor(q / 3) * 6.2;
        if (dn(su2, sv2) > 0.92) ok = false;
        const F = ground(su2, sv2);
        if (!(F <= Yq + 0.9)) {
          land = false;
          const W2 = planFloor(su2, sv2);
          if (!(W2 < Yq && (pk === 0 || pk === 3))) ok = false;
        }
      }
      const cx = u + PU / 2;
      const cz = v + PV / 2;
      if (outside(cx, cz, uA0, av0, uA1 + 8, av1) < 11) ok = false;
      if (pillars.some((p) => Math.hypot(p[0] - cx, p[1] - cz) < p[2] * 1.4 + 6)) ok = false;
      if (keepClear.some((p) => Math.hypot(p[0] - cx, p[1] - cz) < p[2] + 6)) ok = false;
      if (Math.hypot(cx - su, cz - sv) < sr + 14) ok = false;
      lots.push({ i, j, u, v, ok, wet: !land, used: false, score: 0.5 * (1 - (cx - uL0) / (uTb - uL0 + 1)) + 0.6 * rnd() });
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
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    return best;
  };
  const groundMax = (u0: number, v0: number, u1: number, v1: number): number => {
    let m = -Infinity;
    for (let a2 = 0; a2 <= 3; a2++) for (let c = 0; c <= 3; c++) m = Math.max(m, ground(u0 + ((u1 - u0) * a2) / 3, v0 + ((v1 - v0) * c) / 3));
    return m;
  };
  const roofP = b.paint(0.9, 0.8, 0.6, 2);
  const lampsTown: (() => void)[] = [];
  const rectHitsPillar = (u0: number, v0: number, u1: number, v1: number): boolean => pillars.some((p) => Math.hypot(Math.max(u0 - p[0], 0, p[0] - u1), Math.max(v0 - p[1], 0, p[1] - v1)) < p[2] * 1.45 + 4);

  // the figure: a seated giant of blocks on a plinth at the shore, looking out over the water to the bridge
  {
    const cand = free().filter((l) => {
      const n = lotAt(l.i, l.j + 1);
      return !l.wet && n && n.ok && !n.wet && !n.used && !rectHitsPillar(l.u, l.v - 2, l.u + PU, l.v + PV * 2 + 2);
    });
    const fu = (uL0 + uTb) / 2 + R(-30, 30);
    const fv = vBr + ts * (vLand((uL0 + uTb) / 2) + 20);
    let lt = nearest(fu, fv, cand);
    // no dry ground for it: it sits out in the water on a plinth, a causeway to its back
    let wetF = false;
    let cwF: [number, number, number] | null = null;
    if (!lt) {
      const c2 = free().filter((l) => {
        const n = lotAt(l.i, l.j + 1);
        return n && n.ok && !n.used && !rectHitsPillar(l.u, l.v - 2, l.u + PU, l.v + PV * 2 + 2);
      });
      for (const l of c2.sort((a2, c) => Math.hypot(mid(a2)[0] - fu, mid(a2)[1] - fv) - Math.hypot(mid(c)[0] - fu, mid(c)[1] - fv))) {
        const cu2 = l.u + PU / 2;
        const cv2 = l.v + PV;
        const dir2 = vBr > cv2 ? 1 : -1;
        let v = cv2 - dir2 * 8;
        let okc = false;
        for (let n = 0; n < 50; n++, v -= dir2 * 1.8) {
          if ([-1.2, 0, 1.2].every((x) => landD(cu2 + x, v) > 2 && ground(cu2 + x, v) <= Yq + 0.9)) {
            okc = true;
            break;
          }
          if (dn(cu2, v) > 0.95 || blocked.some((r) => cu2 + 1.8 > r[0] && cu2 - 1.8 < r[2] && v > r[1] && v < r[3])) break;
          if (pillars.some((p) => Math.hypot(p[0] - cu2, p[1] - v) < p[2] * 1.4 + 2) || outside(cu2, v, uA0, av0, uA1 + 8, av1) < 3) break;
        }
        if (!okc) continue;
        lt = l;
        wetF = true;
        cwF = [cu2, cv2 - dir2 * 8, v];
        break;
      }
    }
    if (lt) {
      const l2 = lotAt(lt.i, lt.j + 1)!;
      lt.used = true;
      l2.used = true;
      const cuF = lt.u + PU / 2;
      const cvF = lt.v + PV;
      const dir = vBr > cvF ? 1 : -1;
      const hF = R(17, 22) / 20.4;
      const y0 = wetF ? Yq - 2 * hF : groundMax(cuF - 8, cvF - 9, cuF + 8, cvF + 9) + 0.2;
      if (cwF) {
        g.paintF = MOSS;
        g.roughNow = 0.15;
        const [cu2, va2, vb2] = cwF;
        g.fillBox(cuF - 8, cvF - 9, cuF + 8, cvF + 9, LOW, Yq);
        g.fillBox(cu2 - 1.6, Math.min(va2, vb2), cu2 + 1.6, Math.max(va2, vb2), LOW, Yq);
        for (const l of lots) if (l.u <= cu2 + 2 && l.u + PU >= cu2 - 2 && l.v <= Math.max(va2, vb2) && l.v + PV >= Math.min(va2, vb2)) l.used = true;
        blocked.push([cu2 - 2, Math.min(va2, vb2), cu2 + 2, Math.max(va2, vb2)]);
        for (let v = Math.min(va2, vb2) + 2; v < Math.max(va2, vb2) - 1; v += 4) L.causeways.push([cu2, Yq, v]);
      }
      const fb = (a0: number, a1: number, f0: number, f1: number, ya: number, yb: number): void => {
        const va = cvF + dir * f0;
        const vb = cvF + dir * f1;
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
      blocked.push([cuF - 9, cvF - 10, cuF + 9, cvF + 10]);
      if (wetF) {
        L.figure = [cuF, Yq, cvF - dir * 6.8];
        L.landmarks.push(L.figure);
      }
      for (const [sx, sz] of wetF ? [] : [[10, 6], [-10, 6], [10, -6], [-10, -6], [0, 11], [0, -11]]) {
        const F = ground(cuF + sx, cvF + sz);
        if (F === F) L.figureNear.push([cuF + sx, F, cvF + sz]);
      }
      for (const sx of wetF ? [] : [10, -10]) {
        const F = ground(cuF + sx, cvF);
        if (!(F === F) || pillars.some((p) => Math.hypot(p[0] - cuF - sx, p[1] - cvF) < p[2] * 1.45 + 3)) continue;
        L.figure = [cuF + sx, F, cvF];
        L.landmarks.push(L.figure);
        break;
      }
      lampsTown.push(() => b.lamp(cuF + 9.5, y0 + 1.8, cvF + dir * 4, { reach: 20 }), () => b.lamp(cuF - 9.5, y0 + 1.8, cvF + dir * 4, { reach: 20 }));
    }
  }
  // the tower you can climb: three flights round a void, a platform at the top
  {
    const fits = (l: Lot, west: boolean): boolean => {
      const n = lotAt(l.i, l.j + 1);
      const w = lotAt(l.i - 1, l.j);
      return !l.wet && !!n && n.ok && !n.used && !n.wet && (!west || (!!w && w.ok && !w.wet)) && ground(l.u - 4, l.v + 1.8) <= Yq + 0.9 && ground(l.u - 4, l.v + 25) <= Yq + 0.9 && !rectHitsPillar(l.u - 6, l.v - 3, l.u + 18, l.v + 29);
    };
    const tv = vBr + ts * R(40, 80);
    const lt = nearest(uL0 + R(30, 90), tv, free().filter((l) => fits(l, true))) ?? nearest(uL0 + 40, tv, free().filter((l) => fits(l, false)));
    if (lt) {
      lt.used = true;
      lotAt(lt.i, lt.j + 1)!.used = true;
      const ua = lt.u;
      const va = lt.v;
      const yB = Math.round(ground(ua - 1, va + 1.8) * 4) / 4;
      g.roughNow = 0.1;
      g.paintF = roofP;
      g.fillRun([ua, yB, va + 1.8], [ua + 12, yB + 6, va + 1.8], 3.6, 10, { steps: true });
      g.fillBox(ua + 12, va, ua + 16, va + 3.6, yB - 4, yB + 6);
      g.fillRun([ua + 14, yB + 6, va + 3.6], [ua + 14, yB + 15, va + 21.6], 4, 20, { steps: true });
      g.fillBox(ua + 12, va + 21.6, ua + 16, va + 25.2, LOW, yB + 15);
      g.fillRun([ua + 12, yB + 15, va + 23.4], [ua + 4, yB + 19, va + 23.4], 3.6, 26, { steps: true });
      g.fillBox(ua, va + 18, ua + 4, va + 25.2, LOW, yB + 19);
      g.paintF = 0;
      blocked.push([ua - 5, va - 1, ua + 17, va + 26]);
      L.tower = [ua + 2, yB + 19, va + 23];
      L.landmarks.push(L.tower);
      L.doors.push([ua - 1.5, yB, va + 1.8]);
      lampsTown.push(() => b.lamp(ua - 1, yB + 1.2, va + 1.8, { reach: 16 }), () => b.lamp(ua + 2, yB + 20, va + 23, { reach: 24, strength: 1.2 }));
    }
  }

  // houses: on the shore, and out in the water to their upper floors
  interface Bld {
    lot: Lot; u0: number; u1: number; v0: number; v1: number; yB: number; h: number; enter: boolean; stair: boolean;
    door: number; stairDir: number; stairSide: number; group: number; two: boolean; yS: number; wet: boolean;
  }
  const blds: Bld[] = [];
  const causeways: [number, number, number][] = []; // u, v from, v to
  {
    const want = 18 + Math.floor(rnd() * 12);
    const pool = free().sort((a2, c) => c.score - a2.score);
    const mk = (lt: Lot): Bld | undefined => {
      const bu = [12, 14, 14][Math.floor(rnd() * 3)];
      const bv = [7.2, 9, 9][Math.floor(rnd() * 3)];
      const door = Math.floor(rnd() * 3); // 0 -u, 1 +u, 2 -v
      const h = Math.round(R(5, 15) * 2) / 2;
      const sd = rnd() < 0.5 ? 1 : -1;
      const two = bu >= 12 && rnd() < 0.5;
      if (lt.wet) {
        // drowned to its upper floor: built up from the bed, its door at the water's edge onto a causeway
        const u0 = lt.u + 14 - bu;
        const v0 = lt.v + (bv === 7.2 ? 1.8 * Math.floor(rnd() * 2) : 0);
        if (rectHitsPillar(u0, v0, u0 + bu, v0 + bv)) return undefined;
        lt.used = true;
        const bd: Bld = { lot: lt, u0, u1: u0 + bu, v0, v1: v0 + bv, yB: Yq, h: Math.max(4, Math.min(h, 9)), enter: false, stair: false, door: 1, stairDir: sd, stairSide: 1, group: -1, two, yS: 0, wet: true };
        blds.push(bd);
        return bd;
      }
      const u0 = lt.u + (bu === 12 ? 2 * Math.floor(rnd() * 2) : 0);
      const v0 = lt.v + (bv === 7.2 ? 1.8 * Math.floor(rnd() * 2) : 0);
      const du = door === 0 ? u0 - 1.4 : door === 1 ? u0 + bu + 1.4 : u0 + bu / 2;
      const dv = door === 2 ? v0 - 1.4 : v0 + bv / 2;
      const yB = ground(du, dv);
      if (!(yB === yB) || groundMax(u0, v0, u0 + bu, v0 + bv) > yB + 3 || Math.abs(yB - ground(u0 + bu / 2, v0 + bv / 2)) > 1.6) return undefined;
      if (rectHitsPillar(u0, v0, u0 + bu, v0 + bv)) return undefined;
      lt.used = true;
      const bd: Bld = { lot: lt, u0, u1: u0 + bu, v0, v1: v0 + bv, yB: Math.round(yB * 4) / 4, h, enter: false, stair: false, door, stairDir: sd, stairSide: 1, group: -1, two, yS: 0, wet: false };
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
        const sc = l.score + 0.45 * Math.min(adj, 2) + (l.wet ? 0.25 : 0);
        if (sc > bs) {
          bs = sc;
          bi = q;
        }
      }
      const lt = pool.splice(bi, 1)[0];
      if (!lt.used) mk(lt);
    }
    // a causeway out to a drowned house: along the lane on its +u side, toward the shore, stopping at dry ground
    const causewayTo = (bd: Bld): boolean => {
      const uc = bd.lot.u + 16;
      const vm = onV((bd.v0 + bd.v1) / 2);
      let v = vm;
      for (let n = 0; n < 60; n++, v += ts * 1.8) {
        const dryHere = [-1.2, 0, 1.2].every((x) => landD(uc + x, v) > 2 && ground(uc + x, v) <= Yq + 0.9);
        if (dryHere) break;
        if (dn(uc, v) > 0.95 || blocked.some((r) => uc + 1.8 > r[0] && uc - 1.8 < r[2] && v > r[1] && v < r[3])) return false;
        if (pillars.some((p) => Math.hypot(p[0] - uc, p[1] - v) < p[2] * 1.4 + 2)) return false;
        if (outside(uc, v, uA0, av0, uA1 + 8, av1) < 3) return false;
        if (n === 59) return false;
      }
      causeways.push([uc, vm - ts * 2.4, v]);
      return true;
    };
    // about a third can be entered; half of the dry ones have a stair to the roof
    const nbc = (bd: Bld): number => blds.filter((o) => o !== bd && Math.abs(o.lot.i - bd.lot.i) + Math.abs(o.lot.j - bd.lot.j) === 1).length;
    const order = blds.map((_, i) => i).sort((a2, c) => hash2(ns + a2, 77) - 0.7 * Math.min(2, nbc(blds[a2])) - (hash2(ns + c, 77) - 0.7 * Math.min(2, nbc(blds[c]))));
    const nE = Math.max(6, Math.round(blds.length / 3));
    const tryStair = (bd: Bld): void => {
      if (bd.wet) return;
      const hasN = (dj: number): boolean => blds.some((o) => o.lot.i === bd.lot.i && o.lot.j === bd.lot.j + dj);
      bd.stairSide = !hasN(1) ? 1 : !hasN(-1) ? -1 : 1;
      // never across a neighbour's door
      if (bd.stairSide > 0 && blds.some((o) => o.lot.i === bd.lot.i && o.lot.j === bd.lot.j + 1 && o.door === 2)) {
        if (hasN(-1)) return;
        bd.stairSide = -1;
      }
      let yB = bd.yB;
      let door = bd.door;
      if (door === 2 && bd.stairSide < 0) {
        door = 0;
        const y2 = ground(bd.u0 - 1.4, (bd.v0 + bd.v1) / 2);
        if (!(y2 === y2)) return;
        yB = Math.round(y2 * 4) / 4;
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
    let entered = 0;
    for (let q = 0; q < order.length && entered < nE; q++) {
      const bd = blds[order[q]];
      if (bd.wet) {
        if (causewayTo(bd)) {
          bd.enter = true;
          entered++;
        }
        continue;
      }
      bd.enter = true;
      entered++;
      if (q % 3 !== 2) tryStair(bd);
    }
    for (const bd of blds) if (bd.wet && !bd.enter && blds.filter((x) => x.wet && x.enter).length < 3 && causewayTo(bd)) bd.enter = true;
    for (let q = 0; q < order.length && blds.filter((x) => x.stair).length < 4; q++) {
      const bd = blds[order[q]];
      if (bd.wet || bd.stair || nbc(bd) === 0) continue;
      bd.enter = true;
      tryStair(bd);
    }
    // rooftop links: from each stair house to a neighbour, and on from there
    const nb = (a2: Bld): Bld[] => blds.filter((o) => o !== a2 && Math.abs(o.lot.i - a2.lot.i) + Math.abs(o.lot.j - a2.lot.j) === 1);
    const links: [Bld, Bld, number][] = [];
    let grp = 0;
    const roofOf = (x: Bld): number => x.yB + x.h;
    const tryLink = (a2: Bld, o: Bld): boolean => {
      const ju = o.lot.i !== a2.lot.i;
      const lo = ju ? (o.lot.i > a2.lot.i ? [a2, o] : [o, a2]) : o.lot.j > a2.lot.j ? [a2, o] : [o, a2];
      const gapv = ju ? lo[1].u0 - lo[0].u1 : lo[1].v0 - lo[0].v1;
      const ov = ju ? Math.min(a2.v1, o.v1) - Math.max(a2.v0, o.v0) : Math.min(a2.u1, o.u1) - Math.max(a2.u0, o.u0);
      if (gapv < 3 || gapv > 9 || ov < 3) return false;
      if (o.group >= 0 && o.group !== a2.group) return false;
      let pos = 0;
      if (ju) pos = onV((Math.max(a2.v0, o.v0) + Math.min(a2.v1, o.v1)) / 2);
      else {
        const [m0, m1] = o.lot.j > a2.lot.j ? [a2, o] : [o, a2];
        const ry = roofOf(a2);
        const ivs: [number, number][] = [];
        for (const [m, face] of [[m0, 1], [m1, -1]] as [Bld, number][]) {
          if (!m.stair || m.stairSide !== face) continue;
          const sa = m.stairDir > 0 ? m.u0 + 2 : m.u1 - 2;
          const sb = sa + m.stairDir * 2 * (ry - m.yS);
          ivs.push([Math.min(sa, sb) - 2.5, Math.max(sa, sb) + 2.5]);
        }
        pos = NaN;
        for (let c = even(Math.max(m0.u0, m1.u0) + 2); c <= Math.min(m0.u1, m1.u1) - 2; c += 2) {
          if (!ivs.some(([i0, i1]) => c >= i0 && c <= i1)) {
            pos = c;
            break;
          }
        }
        if (pos !== pos) return false;
      }
      // a plank over a lane a causeway runs down must clear a walker's head
      if (ju && causeways.some((cw) => cw[0] > lo[0].u1 && cw[0] < lo[1].u0 && pos > Math.min(cw[1], cw[2]) - 2 && pos < Math.max(cw[1], cw[2]) + 2) && roofOf(a2) - 0.6 < Yq + 2.6) return false;
      if (o.group < 0) {
        const hh = roofOf(a2) - o.yB;
        const hi = o.stair ? Math.min(7, (o.u1 - o.u0 - 3) / 2 + o.yS - o.yB) : 15;
        if (hh < (o.wet ? 3.5 : 5) || hh > hi) return false;
        o.h = hh;
        o.group = a2.group;
      } else if (Math.abs(roofOf(o) - roofOf(a2)) > 0.01) return false;
      links.push([a2, o, pos]);
      return true;
    };
    for (const s0 of blds.filter((x) => x.stair)) {
      if (s0.group < 0) s0.group = grp++;
      let cur = s0;
      for (let step = 0; step < 3; step++) {
        const cand = nb(cur).filter((o) => o.group < 0 || o.group === s0.group);
        let done = false;
        for (const o of cand.sort((a2, c) => (c.enter ? 1 : 0) - (a2.enter ? 1 : 0))) {
          if (links.some(([p, q2]) => (p === cur && q2 === o) || (p === o && q2 === cur))) continue;
          if (tryLink(cur, o)) {
            cur = o;
            done = true;
            break;
          }
        }
        if (!done) break;
      }
    }
    for (const cur of [...blds.filter((x) => x.group >= 0), ...blds.filter((x) => x.group >= 0)]) {
      if (links.length >= 9) break;
      let made = 0;
      for (const o of nb(cur)) if (made < 2 && (o.group < 0 || o.group === cur.group) && !links.some(([p, q2]) => (p === cur && q2 === o) || (p === o && q2 === cur)) && tryLink(cur, o)) made++;
    }
    // too few neighbours to cross: raise plain houses beside the stair houses
    for (let pass = 0; pass < 2 && links.length < 3; pass++) {
      for (const cur of blds.filter((x) => x.group >= 0)) {
        if (links.length >= 5) break;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const lt2 = lotAt(cur.lot.i + di, cur.lot.j + dj);
          if (!lt2 || !lt2.ok || lt2.used) continue;
          const nbd = mk(lt2);
          if (!nbd) continue;
          if (!tryLink(cur, nbd)) {
            blds.pop();
            lt2.used = false;
            continue;
          }
          break;
        }
      }
    }
    // the causeways: blocks laid end to end, a little uneven, like stepping stones that have grown together
    g.roughNow = 0.15;
    g.paintF = MOSS;
    for (const [uc, va, vb] of causeways) {
      const v0 = Math.min(va, vb);
      const v1 = Math.max(va, vb);
      let k = 0;
      for (let v = v0; v < v1; v += 2.4, k++) {
        const wd = k % 2 === 0 ? 1.8 : 1.3;
        g.fillBox(uc - wd, v, uc + wd, Math.min(v1, v + 2.4), LOW, Yq - (k % 3 === 1 ? 0.15 : 0));
      }
      for (let v = v0 + 3; v < v1 - 2; v += 4) L.causeways.push([uc, Yq, v]);
      lampsTown.push(() => b.lamp(uc + 1.2, Yq + 1.2, (v0 + v1) / 2, { reach: 14, strength: 0.8 }));
    }
    g.roughNow = 0.12;
    for (const bd of blds) {
      const { u0, u1, v0, v1, yB } = bd;
      const roofY = yB + bd.h;
      const reach = bd.group >= 0;
      g.paintF = roofP;
      g.fillBox(u0, v0, u1, v1, LOW, roofY);
      blocked.push([u0 - 1, v0 - 1, u1 + 1, v1 + 1]);
      g.paintF = 0;
      const vm = onV((v0 + v1) / 2);
      const um = even((u0 + u1) / 2);
      const doorBox = (hh: number): void => {
        if (bd.door === 0) g.carveBox(u0, vm - 1.8, u0 + 2.5, vm + 1.8, yB, yB + hh);
        else if (bd.door === 1) g.carveBox(u1 - 2.5, vm - 1.8, u1, vm + 1.8, yB, yB + hh);
        else g.carveBox(um - 2, v0, um + 2, v0 + 2.7, yB, yB + hh);
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
        if (!bd.wet) g.carveBox(bd.door === 0 ? u1 - 2 : u0, vm - 0.9, bd.door === 0 ? u1 : u0 + 2, vm + 0.9, yB + 1.4, yB + 2.6);
        L.doors.push(dp);
        L.entered++;
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
        if (tier === 0 && (bd.lot.i + bd.lot.j) % 2 === 0) for (const s0 of [-1, 1]) g.carveBox(u0 + 3, s0 < 0 ? v0 : v1 - 0.9, u0 + 5, s0 < 0 ? v0 + 0.9 : v1, yB + bd.h - 3.2, yB + bd.h - 1.8);
      }
      if (bd.wet && !bd.enter && reach) L.roofs.push([um, roofY, vm]);
      if (bd.stair) {
        // an outside stair up a long wall to the roof's edge
        const len = 2 * (roofY - bd.yS);
        const sa = bd.stairDir > 0 ? u0 + 2 : u1 - 2;
        const sv2 = bd.stairSide > 0 ? v1 + 0.9 : v0 - 0.9;
        const sb = sa + bd.stairDir * len;
        g.paintF = roofP;
        g.fillRun([sa, bd.yS, sv2], [sb, roofY, sv2], 1.8, bd.h + 3, { steps: true, cap0: tier === 2 ? 1 : 0, cap1: tier === 2 ? 2 : 0 });
        g.paintF = 0;
        L.roofs.push([sb - bd.stairDir * 0.5, roofY, bd.stairSide > 0 ? v1 - 0.9 : v0 + 0.9]);
        if (rnd() < 0.5) lampsTown.push(() => b.lamp(sa - bd.stairDir * 0.5, bd.yS + 1.6, sv2 + bd.stairSide * 1.8, { reach: 12, strength: 0.8 }));
      }
    }
    for (const [a2, o, pos] of links) {
      const ju = o.lot.i !== a2.lot.i;
      const ry = a2.yB + a2.h;
      g.roughNow = 0.05;
      g.paintF = roofP;
      if (ju) {
        const [l0, l1] = o.lot.i > a2.lot.i ? [a2, o] : [o, a2];
        g.fillBox(l0.u1 - 2, pos - 0.9, l1.u0 + 2, pos + 0.9, ry - 0.6, ry);
        L.links.push([(l0.u1 + l1.u0) / 2, ry, pos]);
      } else {
        const [l0, l1] = o.lot.j > a2.lot.j ? [a2, o] : [o, a2];
        g.fillBox(pos - 1, l0.v1 - 1.8, pos + 1, l1.v0 + 1.8, ry - 0.6, ry);
        L.links.push([pos, ry, (l0.v1 + l1.v0) / 2]);
      }
      g.paintF = 0;
    }
    // courtyards: free dry lots with houses on three sides
    let courts = 0;
    for (const lt of lots) {
      if (!lt.ok || lt.used || lt.wet || courts >= 3) continue;
      const nbs = [lotAt(lt.i + 1, lt.j), lotAt(lt.i - 1, lt.j), lotAt(lt.i, lt.j + 1), lotAt(lt.i, lt.j - 1)].filter((n) => n && n.used).length;
      if (nbs < 3) continue;
      courts++;
      const [cx, cz] = mid(lt);
      props.push(() => {
        const y = ground(cx, cz);
        if (!(y === y)) return;
        b.color(0.6, 0.5, 0.38, 2);
        b.box(cx + 2, y, cz - 1.8, 2, 1, 1.8, 0.3, { solid: true });
        if (tier < 2) b.box(cx - 2, y, cz + 1.8, 1.6, 0.8, 1.6, 0.8, { solid: true });
        jars(cx, y, cz, Math.ceil(3 * few));
        b.lamp(cx, y + 2.4, cz, { reach: 18 });
      });
    }
    L.houses = blds.length;
    L.drowned = blds.filter((x) => x.wet).length;
  }
  props.push(() => {
    let li = 0;
    for (const f of lampsTown) if (tier < 2 || li++ % 2 === 0) f();
  });

  // ---- the water
  g.pool(uC - Ru - 1, vC - Rv - 1, uC + Ru + 1, vC + Rv + 1, Yw);
  // the shaft comes through a funnel worn in the roof: level over the opening and falling away round it,
  // so the daylight spreads sideways under the dome's slope and is not shut in by the low side's rim
  {
    g.roughNow = 0.3;
    g.paintC = 0;
    const top = (ci: number): number => (g.n[ci] > 0 ? g.c[ci * g.K + g.n[ci] - 1] : -Infinity);
    let cMax = -Infinity;
    g.each(su - sr, sv - sr, su + sr, sv + sr, (ci, cu, cv) => {
      if (Math.hypot(cu - su, cv - sv) <= sr) cMax = Math.max(cMax, top(ci));
    });
    const F = sr + 18;
    g.each(su - F, sv - F, su + F, sv + F, (ci, cu, cv) => {
      const c = top(ci);
      const want = QC * Math.round((cMax - 0.6 * Math.max(0, Math.hypot(cu - su, cv - sv) - sr)) / QC);
      if (c > Yw + 6 && want > c + 0.1) g.carveCell(ci, c - 0.5, want);
    });
    b.skyShaft(su, sv, sr, 1);
  }

  // ---- side scenes: small rooms cut into the wall at the end of short passages off the ring
  let relic: Pt | null = null;
  {
    const relicHere = spec.relic && hash2(ns, 99) < 0.5;
    const picks: [number, number, number, number, number, number][] = []; // entrance u v, room u v, ray cs sn
    const phi0 = rnd() * Math.PI * 2;
    for (const gapA of [0.5, 0.36, 0.26]) {
      picks.length = 0;
      for (let i = 0; i < 90 && picks.length < 5; i++) {
        const phi = phi0 + (i / 90) * Math.PI * 2;
        const cs = Math.cos(phi);
        const sn = Math.sin(phi);
        if (picks.some((p) => Math.abs(Math.atan2(Math.sin(phi - Math.atan2(p[5], p[4])), Math.cos(phi - Math.atan2(p[5], p[4])))) < gapA)) continue;
        let lo = 0;
        let hi = Ru + Rv;
        for (let q = 0; q < 14; q++) {
          const t = (lo + hi) / 2;
          if (dn(uC + t * cs, vC + t * sn) < 1) lo = t;
          else hi = t;
        }
        const ue = uC + (lo - 3) * cs;
        const ve = vC + (lo - 3) * sn;
        const uw = uC + lo * cs;
        const vw = vC + lo * sn;
        const F = planFloor(ue, ve);
        if (pk !== 1 || Math.abs(F - Yq) > 0.01) continue;
        if (uw < uH0 + 30 || (uw > uT0 - 24 && Math.abs(vw - vBr) < TH + 24)) continue;
        if (Math.abs(vw - vS) < 22 && uw < uFoot + 16) continue;
        if (Math.hypot(uw - tunnelExit[0], vw - tunnelExit[1]) < 20) continue;
        if (blocked.some((r) => ue > r[0] - 4 && ue < r[2] + 4 && ve > r[1] - 4 && ve < r[3] + 4)) continue;
        if (pillars.some((p) => Math.hypot(p[0] - ue, p[1] - ve) < p[2] * 1.4 + 5)) continue;
        if (L.beacon && Math.hypot(L.beacon[0] - ue, L.beacon[2] - ve) < 12) continue;
        const ru = uw + cs * 13;
        const rv = vw + sn * 13;
        if (ru - 9.5 < uH0 || ru + 9.5 > spec.u1 - 1.5 || rv - 9.5 < spec.v0 + 1.5 || rv + 9.5 > spec.v1 - 1.5) continue;
        if (outside(ru, rv, uT0 - 6, vBr - TH - 6, uF + 28, vBr + TH + 6) < 6) continue;
        let rock = true;
        for (const [a2, c] of [[-6, -6], [6, -6], [-6, 6], [6, 6], [0, 0]]) if (dn(ru + a2, rv + c) < 1.04) rock = false;
        if (!rock) continue;
        picks.push([ue, ve, ru, rv, cs, sn]);
      }
      if (picks.length >= 4) break;
    }
    const relicScene = Math.floor(hash2(ns, 98) * 2) % Math.max(1, picks.length);
    picks.forEach(([ue, ve, ru, rv, cs, sn], idx) => {
      const kind = idx % 4;
      g.paintF = 0;
      g.roughNow = 0.15;
      g.carveRun([ue, Yq, ve], [ru - cs * 4, Yq, rv - sn * 4], 3, 3);
      g.carveBox(ru - 5, rv - 5, ru + 5, rv + 5, Yq, Yq + 4.2);
      const ax = Math.abs(cs) > Math.abs(sn); // the room's long way in, along u or along v
      const dI = ax ? Math.sign(cs) : Math.sign(sn); // inward
      const at = (a2: number, c: number): [number, number] => (ax ? [ru + dI * a2, rv + c] : [ru + c, rv + dI * a2]);
      const [bu, bv] = at(4.4, 0); // the back wall
      let sp = at(-1.5, 0);
      if (kind === 2) {
        // a grotto: a still pool in the back of the room, a trickle into it
        const [p0u, p0v] = at(0.6, -4);
        const [p1u, p1v] = at(5, 4);
        const pu0 = Math.min(p0u, p1u);
        const pu1 = Math.max(p0u, p1u);
        const pv0 = Math.min(p0v, p1v);
        const pv1 = Math.max(p0v, p1v);
        g.carveBox(pu0, pv0, pu1, pv1, Yq - 0.45, Yq + 4.2);
        g.pool(pu0, pv0, pu1, pv1, Yq - 0.12);
        sp = at(-2.5, 0);
      }
      if (kind === 3) {
        // fallen roof over a seam: the back of the room broken out further
        const [k0u, k0v] = at(4, -5);
        const [k1u, k1v] = at(8, 5);
        g.carveBox(Math.min(k0u, k1u), Math.min(k0v, k1v), Math.max(k0u, k1u), Math.max(k0v, k1v), Yq, Yq + 3.6);
      }
      L.scenes.push([sp[0], Yq, sp[1]]);
      L.sides.push([ue, Yq, ve]);
      if (relicHere && idx === relicScene) {
        const [cu2, cv2] = at(0.5, 0);
        relic = [cu2, Yq + 1.6, cv2];
        props.push(() => {
          b.color(0.9, 0.88, 0.84, 0);
          b.box(cu2, Yq, cv2, 2.2, 0.4, 2.2, 0, { solid: true });
          b.cyl(cu2, Yq + 0.4, cv2, 0.62, 0.75, { solid: true });
          b.cyl(cu2, Yq + 1.15, cv2, 0.48, 0.14);
        });
      }
      props.push(() => {
        const [lu, lv] = at(-4, 3.6);
        b.lamp(lu, Yq + 2.6, lv, { reach: 13, strength: 0.9 });
        if (kind === 0) {
          // a shrine: carved slabs along the back wall, their marks holding a little light
          const nS = spec.carvings ? 5 : 3;
          for (let i = 0; i < nS; i++) {
            const [u, v] = at(4.1, -4 + (8 * (i + 0.5)) / nS);
            const h = b.r(2.4, 3.2);
            const k = b.r(0.85, 1);
            b.color(k, k * 0.98, k * 0.94, 0);
            b.box(u, Yq, v, ax ? 0.5 : 1.5, h, ax ? 1.5 : 0.5, b.r(-0.05, 0.05), { solid: true });
            b.color(0.42, 0.42, 0.42, 4);
            for (let row = 0; row < 5; row++) {
              const y = Yq + 0.5 + row * 0.42;
              if (y > Yq + h - 0.8) break;
              for (let q = -1; q <= 1; q++) {
                if (b.rng() < 0.3) continue;
                const tall = b.rng() < 0.3;
                const [mu, mv] = at(3.83, -4 + (8 * (i + 0.5)) / nS + q * 0.36);
                b.box(mu, y, mv, ax ? 0.06 : tall ? 0.07 : 0.2, tall ? 0.3 : 0.07, ax ? (tall ? 0.07 : 0.2) : 0.06);
              }
            }
          }
          b.lamp(ru, Yq + 3.4, rv, { reach: 12, strength: 0.8 });
        } else if (kind === 1) {
          // a store: crates and jars
          for (let i = 0; i < 6 * [1, 0.7, 0.4][tier]; i++) {
            const [u, v] = at(b.r(0.5, 3.6), b.r(-4, 4));
            const sz = b.r(0.9, 1.5);
            b.color(0.55, 0.4, 0.26, 2);
            b.box(u, Yq, v, sz, sz * 0.8, sz, b.r(0, 3), { solid: true });
            if (b.rng() < 0.4) b.box(u, Yq + sz * 0.8, v, sz * 0.7, sz * 0.6, sz * 0.7, b.r(0, 3), { solid: true });
          }
          for (let i = 0; i < 6; i++) {
            const [u, v] = at(b.r(-3, -1), b.r(-4.2, 4.2));
            jar(u, Yq, v);
          }
          coil(bu - (ax ? dI * 1.2 : 0), Yq, bv - (ax ? 0 : dI * 1.2));
        } else if (kind === 2) {
          const [tu, tv] = at(4.6, 0);
          b.color(0.6, 0.78, 0.86, 1);
          b.cyl(tu, Yq + 0.2, tv, 0.1, 3.8, { sides: 4 });
          b.light(tu, Yq + 1.2, tv, 10, 0.5, TEAL);
        } else {
          // a seam of glowing mineral in the broken end
          const n = (spec.vein ? 1 : 0.55) * [18, 14, 9][tier];
          for (let i = 0; i < n; i++) {
            const t = (i + b.rng() * 0.6) / n;
            const [u, v] = at(8.2, -4.5 + 9 * t);
            const k = b.r(0.65, 1.1);
            b.color(k, k, k, 4);
            b.cone(u, Yq + 0.4 + 1.8 * Math.sin(t * Math.PI) * b.r(0.6, 1), v, b.r(0.25, 0.55), b.r(0.8, 2.2), { rx: b.r(-0.6, 0.6), rz: b.r(-0.5, 0.5), sides: 4 });
          }
          for (let i = 0; i < 3; i++) {
            const [u, v] = at(b.r(4.5, 7), b.r(-4, 4));
            b.color(0.8, 0.8, 0.8, 0);
            const sz = b.r(1, 2);
            b.box(u, Yq, v, sz * 1.3, sz * 0.7, sz, b.r(0, 3), { solid: true });
          }
          const [gu, gv] = at(8, 0);
          b.light(gu, Yq + 2, gv, spec.vein ? 26 : 18, 0.9, TEAL);
          b.glow(gu, Yq + 2, gv, spec.vein ? 7 : 4, [0.22, 0.7, 0.6]);
        }
      });
    });
  }

  // ================================================================ what stands in it
  const few = [1, 0.6, 0.35][tier];
  const sides = tier === 2 ? 6 : 8;

  /** A square pier cut with bands and lozenges. */
  const pilaster = (u: number, y: number, v: number, wd: number, h: number, marks: number): void => {
    const k = b.r(0.9, 1);
    b.color(k, k * 0.98, k * 0.95, 0);
    b.box(u, y, v, wd * 1.3, 0.5, wd * 1.3, 0, { solid: true });
    b.box(u, y + 0.5, v, wd, h - 1.1, wd, 0, { solid: true });
    b.box(u, y + h - 0.6, v, wd * 1.35, 0.6, wd * 1.35);
    const rows = Math.max(2, Math.floor((h - 2) / (wd * 1.5)));
    const pitch = (h - 2) / rows;
    for (let i = 0; i < rows; i++) {
      const ry = y + 1 + i * pitch;
      if (i % 2 === 0) b.box(u, ry + pitch * 0.15, v, wd * 0.86, pitch * 0.7, wd * 0.86, Math.PI / 4);
      else {
        b.box(u, ry + pitch * 0.1, v, wd * 1.14, pitch * 0.18, wd * 1.14);
        b.box(u, ry + pitch * 0.72, v, wd * 1.14, pitch * 0.18, wd * 1.14);
      }
    }
    if (marks !== 0) {
      // marks down the face that looks back at the quay, still holding a little light
      b.color(0.42, 0.42, 0.42, 4);
      for (let ry = y + 1.2; ry < y + Math.min(h - 1.2, 4.4); ry += 0.42) {
        for (let q = -1; q <= 1; q++) {
          if (b.rng() < 0.3) continue;
          const tall = b.rng() < 0.3;
          b.box(u + marks * (wd * 0.57 + 0.04), ry, v + q * wd * 0.25, 0.06, tall ? 0.3 : 0.07, tall ? 0.07 : b.r(0.14, 0.28));
        }
      }
    }
  };
  /** A slab stood on end, cut with rows of marks on the face toward `face` (-1 or 1 along u). */
  const stele = (u: number, y: number, v: number, face: number): void => {
    const h = b.r(2.6, 3.6);
    const wd = b.r(1.3, 1.7);
    const k = b.r(0.85, 1);
    b.color(k, k * 0.98, k * 0.94, 0);
    b.box(u, y - 0.2, v, 0.55, h, wd, b.r(-0.06, 0.06), { rz: b.r(-0.04, 0.04) });
    b.color(0.42, 0.42, 0.42, 4);
    for (let row = 0; row < 6; row++) {
      const ry = y + 0.5 + row * 0.42;
      if (ry > y + h - 0.9) break;
      for (let q = -1; q <= 1; q++) {
        if (b.rng() < 0.3) continue;
        const tall = b.rng() < 0.3;
        b.box(u + face * 0.31, ry, v + q * 0.36, 0.06, tall ? 0.3 : 0.07, tall ? 0.07 : b.r(0.14, 0.28));
      }
    }
  };
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
  const jars = (u: number, y: number, v: number, n: number): void => {
    for (let i = 0; i < n; i++) jar(u + b.r(-1, 1), y, v + b.r(-1, 1));
  };
  /** Rope left coiled. */
  const coil = (u: number, y: number, v: number): void => {
    const k = b.r(0.8, 1);
    b.color(0.78 * k, 0.66 * k, 0.46 * k, 2);
    const r = b.r(0.32, 0.42);
    b.cyl(u, y, v, r, 0.1, { sides: 9 });
    b.cyl(u, y + 0.1, v, r * 0.86, 0.1, { sides: 9 });
    if (b.rng() < 0.6) b.cyl(u, y + 0.2, v, r * 0.7, 0.09, { sides: 9 });
  };
  const crate = (u: number, y: number, v: number): void => {
    const s = b.r(0.6, 0.95);
    const k = b.r(0.75, 1);
    b.color(0.6 * k, 0.45 * k, 0.3 * k, 2);
    b.box(u, y, v, s, s * b.r(0.7, 1), s, b.r(0, 1.5));
  };
  /** A post at the quay's edge to tie up to. */
  const post = (u: number, y: number, v: number): void => {
    b.color(0.92, 0.9, 0.86, 0);
    b.cyl(u, y, v, 0.17, 0.85, { sides: 6, top: 0.8 });
    b.cyl(u, y + 0.85, v, 0.22, 0.12, { sides: 6 });
  };
  /** A flat-bottomed boat, low in the water, its long axis turned `rot` from u. */
  const boat = (u: number, v: number, rot: number): void => {
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const at = (a: number, c: number): [number, number] => [u + a * cs + c * sn, v - a * sn + c * cs];
    const y = Yw - 0.1;
    const k = b.r(0.8, 1);
    b.color(0.5 * k, 0.37 * k, 0.26 * k, 2);
    b.box(u, y, v, 5, 0.14, 1.5, rot);
    for (const s of [-1, 1]) {
      const [pu, pv] = at(0, s * 0.78);
      b.box(pu, y, pv, 5.3, 0.52, 0.1, rot);
      const [eu, ev] = at(s * 2.72, 0);
      b.box(eu, y + 0.04, ev, 0.75, 0.1, 1.6, rot, { rz: s * 0.55 });
    }
    b.color(0.42 * k, 0.31 * k, 0.22 * k, 2);
    for (const a of [-1.2, 1]) {
      const [pu, pv] = at(a, 0);
      b.box(pu, y + 0.36, pv, 0.26, 0.06, 1.5, rot);
    }
    const [pu, pv] = at(0.2, 0.25);
    b.color(0.66 * k, 0.54 * k, 0.38 * k, 2);
    b.box(pu, y + 0.42, pv, 3.9, 0.06, 0.07, rot + 0.1);
  };
  /** Is this spot on the quay? */
  const onQuay = (u: number, v: number): boolean => Math.abs(g.floorAt(u, v, Yq + 0.5) - Yq) < 0.01;

  // ---- lamps and leavings. The balcony: the first light after the dark
  b.lamp(uW + 1, yL + 0.5, vP - 3, { reach: 16, strength: 0.8 });
  b.lamp(uW + 1, yL + 0.5, vP + 3, { reach: 16, strength: 0.8 });
  for (let i = 0; i < Math.ceil(3 * few); i++) jar(uW + 0.7 + b.r(0, 0.8), yL, vP - tdir * (1.3 + b.r(0, 1.1)));
  // down the tower: a lamp on every landing, and where the flights are long one half-way
  for (let k = 0; k < nF; k++) {
    const fl = flights[k];
    if (k < nF - 1) b.lamp(fl.u + SW * 1.5 - 0.5, fl.y1 + 0.5, fl.vb + fl.dir * (LAND - 0.5), { reach: 20 });
    if (tier === 0 && k % 2 === 1) b.lamp(fl.u - SW / 2 + 0.4, (fl.y0 + fl.y1) / 2 + 0.62, (fl.va + fl.vb) / 2, { reach: 16, strength: 0.8 });
    if (k < nF - 1 && b.rng() < 0.5 * few + 0.15) jars(fl.u + SW * 0.5, fl.y1, fl.vb + fl.dir * 2.2, 2);
  }
  // the quay behind the tower, under the balcony: one lamp, so the way through shows
  b.lamp(uW + 3.2, Yq + 0.5, vP + tdir * (FL / 2), { reach: 13, strength: 0.7 });

  // the apron: the foot of the stair, the head of the bridge, the great pier at the water's edge
  b.lamp(uTf + 0.6, Yq + 0.5, footV, { reach: 20 });
  for (const s of [-1, 1]) {
    // gate posts at the bridge's stair, a lamp on each
    b.color(0.95, 0.93, 0.9, 0);
    b.box(uA1 - 0.7, Yq, vBr + s * 2.5, 1.1, 2.6, 1.1, 0, { solid: true });
    b.box(uA1 - 0.7, Yq + 2.6, vBr + s * 2.5, 1.4, 0.3, 1.4);
    if (tier < 2 || s === ws) b.lamp(uA1 - 0.7, Yq + 3.4, vBr + s * 2.5, { reach: 22 });
  }
  pilaster(uA1 - 1.8, Yq, vBr - ws * 6.3, 2.2, R(9, 13), spec.carvings ? -1 : 0);
  jars(uA1 - 2.5, Yq, vWs + ws * 4.6, Math.ceil(5 * few));
  coil(uA1 - 1.3, Yq, vWs - ws * 1.5);
  if (tier < 2) coil(uTf + 2.2, Yq, footV + b.r(-3, 3));
  for (let i = 0; i < Math.ceil(4 * few); i++) crate(uTf + b.r(1.5, 4.5), Yq, aMid + b.r(-0.4, 0.4) * (tv1 - tv0));
  {
    // a boat left tied before the apron, on the far side of the pier from the bridge
    const bv = vBr - ws * 11.5;
    if (bv > av0 + 3 && bv < av1 - 3 && g.floorAt(uA1 + 1.5, bv, Yq) < Yw) {
      boat(uA1 + 1.5, bv, Math.PI / 2 + b.r(-0.12, 0.12));
      post(uA1 - 0.5, Yq, bv + 1.8);
      coil(uA1 - 1.2, Yq, bv - 1.2);
    }
  }
  if (spec.carvings) {
    // slabs stood along the apron's sides, their marks facing the stair
    for (const s of [-1, 1]) {
      const sv = s < 0 ? av0 + 1.2 : av1 - 1.2;
      for (let i = 0; i < (tier === 2 ? 1 : 2); i++) {
        const su = uTf - 2 - i * 5.5 + b.r(-0.4, 0.4);
        if (onQuay(su, sv) && onQuay(su, sv - s * 2)) stele(su, Yq, sv, 0);
      }
    }
  }

  // along the quay: lamps far apart, and what was left at the water's edge
  {
    const spacing = [30, 36, 50][tier];
    let since = spacing * 0.6;
    let boats = 0;
    let pu = NaN;
    let pv = NaN;
    let n = 0;
    for (let i = 0; i < 420; i++) {
      const phi = Math.PI - qs * i * 0.012;
      const cs = Math.cos(phi);
      const sn = Math.sin(phi);
      // out along the ray to the wall
      let lo = 0;
      let hi = Ru + Rv;
      for (let q = 0; q < 14; q++) {
        const t = (lo + hi) / 2;
        if (dn(uC + t * cs, vC + t * sn) < 1) lo = t;
        else hi = t;
      }
      const u = uC + (lo - 3.4) * cs;
      const v = vC + (lo - 3.4) * sn;
      if (u >= uA0 && u <= uA1 && v >= av0 - 2 && v <= av1 + 2) continue;
      if (!onQuay(u, v)) continue;
      if (pu === pu) since += Math.hypot(u - pu, v - pv);
      pu = u;
      pv = v;
      if (since < spacing) continue;
      since = 0;
      n++;
      b.lamp(uC + (lo - 1.5) * cs, Yq + 0.5, vC + (lo - 1.5) * sn, { reach: 17, strength: 0.85 });
      if (b.rng() < 0.75) jars(uC + (lo - 2.2) * cs + sn * 2.5, Yq, vC + (lo - 2.2) * sn - cs * 2.5, Math.ceil(4 * few));
      if (spec.carvings && n % 2 === 1 && tier < 2) {
        const eu = uC + (lo - 1.1) * cs - sn * 3.5;
        const ev = vC + (lo - 1.1) * sn + cs * 3.5;
        if (onQuay(eu, ev)) pilaster(eu, Yq, ev, 1.3, b.r(4.5, 6), cs > 0 ? -1 : 1);
      }
      // a boat at the edge here, if there is water to float it
      if (boats < (tier === 2 ? 1 : 2) && b.rng() < 0.7) {
        for (let inset = 5; inset < 22; inset += 0.9) {
          const eu = uC + (lo - inset) * cs;
          const ev = vC + (lo - inset) * sn;
          const f = g.floorAt(eu, ev, Yq + 0.5);
          if (Math.abs(f - Yq) < 0.01) continue;
          if (f < Yw) {
            boat(uC + (lo - inset - 1.3) * cs, vC + (lo - inset - 1.3) * sn, -phi - Math.PI / 2 + b.r(-0.15, 0.15));
            post(uC + (lo - inset + 1.2) * cs + sn * 2, Yq, vC + (lo - inset + 1.2) * sn - cs * 2);
            coil(uC + (lo - inset + 1.6) * cs - sn * 1.2, Yq, vC + (lo - inset + 1.6) * sn + cs * 1.2);
            boats++;
          }
          break;
        }
      }
    }
  }

  // the bridge: a curb at every pier, a lamp at few of them
  for (let i = 1; i < nB; i++) {
    b.color(0.93, 0.91, 0.87, 0);
    for (const s of [-1, 1]) b.box(piers[i], Yd, vBr + s * 1.58, 2.4, 0.45, 0.4);
    if (tier === 2 ? i % 3 === 1 : i % 2 === 1) b.lamp(piers[i], Yd + 0.6, vBr + (i % 4 === 1 ? 1.58 : -1.58), { reach: 18, body: false });
  }

  // ---- the door: piers either side, a lintel in courses, a lozenge over it; braziers on the podium
  {
    const pv = doorW / 2 + 1.5;
    const ph = doorH + 2.5;
    for (const s of [-1, 1]) {
      pilaster(uF - 1.1, Yd, vBr + s * pv, 2, ph, 0);
      pilaster(uF - 0.9, Yd, vBr + s * (pv + 4.2), 1.5, ph * 0.72, spec.carvings ? -1 : 0);
    }
    b.color(0.96, 0.94, 0.9, 0);
    b.box(uF - 0.9, Yd + ph, vBr, 2, 1.5, doorW + 6.6);
    b.box(uF - 0.7, Yd + ph + 1.5, vBr, 1.6, 1.2, doorW + 3.6);
    b.box(uF - 0.5, Yd + ph + 2.7, vBr, 1.2, 1, doorW);
    if (Yd + ph + 8.5 < Yd + bayH) {
      b.box(uF - 0.35, Yd + ph + 4.3, vBr, 0.7, 2.8, 2.8, 0, { rx: Math.PI / 4 });
      if (spec.carvings) {
        b.color(0.5, 0.5, 0.5, 4);
        b.box(uF - 0.75, Yd + ph + 5.2, vBr, 0.12, 1, 1, 0, { rx: Math.PI / 4 });
      }
    }
    for (const s of [-1, 1]) {
      const bu = uF - 8;
      const bv = vBr + s * (doorW / 2 + 5.8);
      b.color(0.95, 0.95, 0.95, 0);
      b.cyl(bu, Yd, bv, 0.7, 1.3, { solid: true, sides });
      b.cyl(bu, Yd + 1.3, bv, 0.75, 0.5, { top: 1.6, sides });
      b.lamp(bu, Yd + 2.3, bv, { reach: 26, strength: 1.3, size: 2.2, body: false });
    }
    jars(uF - 3, Yd, vBr - gs * (doorW / 2 + 9.5), Math.ceil(5 * few));
    coil(uT0 + 1.4, Yd, vG + gs * 2.2);
    // the chamber: columns down either side, and at its end a stone with a little light on it
    for (let i = 0; i < 2; i++) {
      for (const s of [-1, 1]) {
        b.color(1, 1, 1, 0);
        b.cyl(uF + 10 + i * 7, Yd, vBr + s * 7.2, 0.9, doorH + 3, { solid: true, sides });
      }
    }
    if (spec.carvings) stele(uF + 22.3, Yd, vBr + 6.2, -1);
    b.stone(uF + 21.6, Yd, vBr, 0); // the waking stone, against the end wall, facing the door
  }

  // ---- a seam of glowing mineral at the waterline, on the side the quay does not reach
  if (spec.vein) {
    const phi0 = -qs * b.r(0.25, 0.6) * Math.PI;
    const wallAt = (phi: number, inset: number): [number, number] => {
      let lo = 0;
      let hi = Ru + Rv;
      for (let q = 0; q < 14; q++) {
        const t = (lo + hi) / 2;
        if (dn(uC + t * Math.cos(phi), vC + t * Math.sin(phi)) < 1) lo = t;
        else hi = t;
      }
      return [uC + (lo - inset) * Math.cos(phi), vC + (lo - inset) * Math.sin(phi)];
    };
    const n = [20, 15, 9][tier];
    const arc = 26 / Math.min(Ru, Rv);
    for (let i = 0; i < n; i++) {
      const t = (i + b.rng() * 0.6) / n;
      const phi = phi0 + (t - 0.5) * arc;
      const [cu, cv] = wallAt(phi, b.r(-0.2, 1.3));
      const f = g.floorAt(cu, cv, Yw + 1);
      const y = (f < Yw + 3 ? Math.max(Yw, f) : Yw) + b.r(-0.3, 0.3) + 2.2 * Math.sin(t * Math.PI) * b.rng();
      const k = b.r(0.65, 1.1);
      b.color(k, k, k, 4);
      // leaning in from the wall
      b.cone(cu, y, cv, b.r(0.25, 0.55), b.r(0.8, 2.2), { rz: Math.cos(phi) * b.r(0.4, 1), rx: -Math.sin(phi) * b.r(0.4, 1), sides: 4 });
    }
    const [lu, lv] = wallAt(phi0, 3);
    b.light(lu, Yw + 2.2, lv, 28, 0.9, TEAL);
    b.glow(lu, Yw + 1.6, lv, 7, [0.22, 0.7, 0.6]);
    for (const t of [0.2, 0.5, 0.8]) {
      const [cu, cv] = wallAt(phi0 + (t - 0.5) * arc, 0.6);
      b.glow(cu, Yw + 0.6 + 1.6 * Math.sin(t * Math.PI), cv, 2, [0.22, 0.7, 0.6]);
    }
  }

  // ---- the relic, on a stone of its own in the chamber (or in one of the side rooms)
  if (spec.relic && !relic) {
    const ru = uF + 13.5;
    b.color(0.9, 0.88, 0.84, 0);
    b.box(ru, Yd, vBr, 2.2, 0.4, 2.2, 0, { solid: true });
    b.cyl(ru, Yd + 0.4, vBr, 0.62, 0.75);
    b.cyl(ru, Yd + 1.15, vBr, 0.48, 0.14);
    relic = [ru, Yd + 1.6, vBr];
  }

  // the ring, sampled round the wall
  for (let i = 0; i < 64; i++) {
    const phi = (i / 64) * Math.PI * 2;
    const cs = Math.cos(phi);
    const sn = Math.sin(phi);
    let lo = 0;
    let hi = Ru + Rv;
    for (let q = 0; q < 14; q++) {
      const t = (lo + hi) / 2;
      if (dn(uC + t * cs, vC + t * sn) < 1) lo = t;
      else hi = t;
    }
    const u = uC + (lo - 3) * cs;
    const v = vC + (lo - 3) * sn;
    const F = planFloor(u, v);
    if (pk !== 1 || !(F >= Yq - 0.01)) continue;
    if (outside(u, v, uW - 2, tv0 - 6, uTf + 1, tv1 + 6) < 1) continue; // behind the tower: the apron's own
    if (Math.abs(v - vS) < 6 && u < uFoot + 10) continue;
    if (pillars.some((p) => Math.hypot(p[0] - u, p[1] - v) < p[2] * 1.4 + 3)) continue;
    L.ring.push([u, F, v]);
  }
  for (const f of props) f();
  L.stone = [uF + 20, Yd + 1.6, vBr];
  L.relic = relic;
  const built = b.finish({ ledge: L.ledge, centre: L.centre, relic });
  walkCheck(built.grid, L);
  built.extra.hall = L;
  return built;
}
