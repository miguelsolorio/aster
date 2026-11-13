// The flooded hall: a domed natural chamber whose floor is a still lake. The stair from the
// hole runs down a dark stepped passage and comes out on a balcony high in the dome's flank.
// From it a stair tower zigzags down to a stone quay at the waterline (the quay passes behind
// the tower, under the balcony); a long bridge on arches crosses the lake to a podium and a
// carved door in the far wall, and daylight falls through a hole in the roof onto the water
// before that door.
//
// Laid out along u: hole, passage, the near wall with the balcony and the tower, the apron of
// the quay, the bridge over the lake, the podium, the door, the chamber behind it.
// Up and down: the roof's crown hangs just under the lid; the water lies H below it.
//
// The lake is never a trap: its bed shelves down in steps a walker can climb, and stairs run
// into the water from the quay and from the podium.

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

/** Distance from a point to a rectangle, 0 inside it. */
const outside = (u: number, v: number, u0: number, v0: number, u1: number, v1: number): number => {
  const du = Math.max(u0 - u, 0, u - u1);
  const dv = Math.max(v0 - v, 0, v - v1);
  return Math.sqrt(du * du + dv * dv);
};

export function buildHall(spec: DeepSpec, uniforms?: Uniforms): BuiltDeep {
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

  const b = new DeepBuilder(spec, uniforms, { cell: tier === 2 ? 2 : 1, yMin: LOW - 2, maxSpans: 5, wallStep: tier === 0 ? 3 : 6 });
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
  const gs = rnd() < 0.5 ? -1 : 1; // the side of the bridge the light falls on, and the podium's water stair
  const ws = rnd() < 0.5 ? -1 : 1; // the side of the bridge the quay's water stair is on
  const vG = vBr + gs * 5.4;
  const GL = 10; // the podium's water stair
  const vWs = vBr + ws * 7.2;
  const WL = 4; // the quay's

  // ---- the quay beyond the apron: along the wall on one side, running out part-way round
  const qs = rnd() < 0.5 ? -1 : 1;
  const uQe = uC + R(-0.1, 0.45) * Ru;
  const quayW = (u: number, v: number): number => ((v - aMid) * qs > 0 ? Wq * smooth((uQe - u) / 14) : 0);
  // rock left standing at the water's edge elsewhere: what makes the lake's outline its own
  const bk = R(9, 14);
  const bankW = (u: number, v: number): number => {
    if (u > uT0 - 16 && Math.abs(v - vBr) < TH + 10) return 0;
    return Math.max(0, bk * vnoise(u / 36 + 7.3, v / 36 + 2.1) - bk * 0.45);
  };
  /** How far out into the lake a spot is, from whatever is dry. */
  const offshore = (u: number, v: number, w: number): number =>
    Math.min(
      w - Math.max(quayW(u, v), bankW(u, v)),
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
  g.carveFn(uC - Ru - 1, vC - Rv - 1, uC + Ru + 1, vC + Rv + 1, (u, v, o) => {
    const d = dn(u, v);
    if (d >= 1) return false;
    const w = (1 - d) * Rm;
    o.ceil = Math.max(embr(u, v), bayRoof(u, v), roof(u, v, d));
    g.paintF = STONE;
    g.roughNow = 0.06;
    if (u >= uT0 && Math.abs(v - vBr) <= TH) o.floor = Yd;
    else if ((u >= uA0 && u <= uA1 && v >= av0 && v <= av1) || w < quayW(u, v)) o.floor = Yq;
    else {
      g.roughNow = tier === 2 ? 0.5 : 0.42;
      const bw = bankW(u, v);
      if (w < bw) {
        g.paintF = MOSS;
        o.floor = Yw + 0.2 + 0.45 * Math.floor(3 * vnoise(u / 11 + 3, v / 11 + 9)); // (never more than a step above the quay)
      } else {
        const s = offshore(u, v, w);
        g.paintF = 0;
        o.floor = bed(s);
      }
    }
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
  const footV = flights[nF - 1].vb + flights[nF - 1].dir * 2.5;
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

  // ---- the relic, on a stone of its own in the chamber
  let relic: Pt | null = null;
  if (spec.relic) {
    const ru = uF + 13.5;
    b.color(0.9, 0.88, 0.84, 0);
    b.box(ru, Yd, vBr, 2.2, 0.4, 2.2, 0, { solid: true });
    b.cyl(ru, Yd + 0.4, vBr, 0.62, 0.75);
    b.cyl(ru, Yd + 1.15, vBr, 0.48, 0.14);
    relic = [ru, Yd + 1.6, vBr];
  }

  return b.finish({ ledge: [uW + 1.5, yL, vP], centre: [uF + 1, Yd, vBr], relic });
}
