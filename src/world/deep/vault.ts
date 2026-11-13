// The strata vault: an enormous pit of layered rock. The stair from the hole runs into a short
// dark passage that opens on a high ledge; below it terraces step down the walls to a floor a
// long way under, and in the far wall stands a door forty metres tall, colonnades cut into the
// rock either side of it, a dark chamber behind.
//
// Laid out along u: hole, passage (with one turn), the pit, the door wall, the chamber.
// Up and down: everything hangs from the lid; the ledge is ten metres under the pit's roof.

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

export function buildVault(spec: DeepSpec, uniforms?: Uniforms): BuiltDeep {
  const tier = spec.tier;
  const lid = spec.lid;
  // the shape of the place comes from a generator of its own, so every tier builds the same vault
  const rnd = mulberry32(Math.imul(spec.seed | 0, 0x9e3779b1) ^ 0x51a7a);
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
  const H = R(60, 90); // floor to roof
  const Yc = lid - 1.5; // the roof at its highest
  const yA = lid - 2.9; // foot of the stair down the hole (the builder's b.foot)
  const yL = Yc - 10; // the ledge
  const Yf = Yc - H; // the pit's floor

  const b = new DeepBuilder(spec, uniforms, { cell: tier === 2 ? 2 : 1, yMin: Yf - 4, maxSpans: 5, wallStep: [3, 4, 5][tier] });
  const g = b.grid;

  // ---- the way in: stair, then a passage with one turn in it, unlit
  const PW = 3.6;
  const L1 = even(R(12, 18));
  const L3 = even(R(12, 18));
  let side = rnd() < 0.5 ? -1 : 1;
  let Lv = onV(R(9, 15));
  const roomFor = (s: number): number => (s > 0 ? spec.v1 : -spec.v0) - 6 - PW;
  if (roomFor(side) < Lv) side = -side;
  if (roomFor(side) < Lv) Lv = Math.max(0, onV(roomFor(side) - 0.9));
  const uT = 4 + L1 + 2; // the middle of the cross leg
  const vP = side * Lv; // where the passage comes out
  const uH0 = uT + 2 + L3; // the pit's near wall
  const Lp = uT - 4 + Lv + (uH0 - uT);
  const yAt = (s: number): number => yA + ((yL - yA) * s) / Lp;
  b.holeStair();
  g.roughNow = 0.12;
  const PH = 2.5;
  if (Lv > 0) {
    g.carveRun([4, yA, 0], [uT, yAt(uT - 4), 0], PW, PH, { cap1: 2 });
    g.carveRun([uT, yAt(uT - 4), 0], [uT, yAt(uT - 4 + Lv), vP], PW + 0.4, PH, { cap0: 1.8, cap1: 1.8 });
    g.carveRun([uT, yAt(uT - 4 + Lv), vP], [uH0, yL, vP], PW, PH, { cap0: 2 });
  } else {
    g.carveRun([4, yA, 0], [uH0, yL, 0], PW, PH);
  }

  // ---- the pit
  const uF = even(Math.min(spec.u1 - 44, uH0 + 250)); // the door wall
  const W = Math.min(spec.v1 - spec.v0 - 16, R(170, 250));
  const vMid = Math.min(spec.v1 - 8 - W / 2, Math.max(spec.v0 + 8 + W / 2, vP + R(-12, 12)));
  const vA = vMid - W / 2;
  const vB = vMid + W / 2;
  const T = 3 + Math.floor(rnd() * 3); // terraces between ledge and floor
  const wT = R(7.5, 10); // how far each steps back
  const wN = 4; // under the ledge they are only a walkway each, so the near wall falls away steeply
  const hT = (yL - Yf) / T;
  const level = (k: number): number => (k >= T ? Yf : yL - k * hT);
  g.roughNow = tier === 2 ? 0.5 : 0.4;
  g.carveFn(uH0, vA, uF, vB, (u, v, o) => {
    const d = Math.min(((u - uH0) * wT) / wN, v - vA, vB - v);
    o.floor = level(Math.min(T, Math.floor(d / wT)));
    // the roof: lower toward the walls, and broken into plates
    const arch = 1 - smooth(d / 40);
    o.ceil = Yc - Math.round(3 * arch * arch + 3.2 * vnoise(u / 27, v / 27) + 0.8 * vnoise(u / 9, v / 9));
    return true;
  });

  // ---- light from above: one shaft before the door, and often a second nearer the ledge
  const stairSide = rnd() < 0.5 ? -1 : 1; // which wall the stairs go down
  const shafts: number[] = [];
  {
    const su = uF - R(26, 44);
    const sv = vMid + R(-10, 10);
    b.skyShaft(su, sv, R(5, 7.5), 1);
    shafts.push(su);
    if (rnd() < 0.65) {
      const su2 = uH0 + T * wN + R(30, 65);
      b.skyShaft(su2, vMid - stairSide * R(8, W * 0.2), R(3.5, 5), 0.8);
      shafts.push(su2);
    }
  }

  // ---- the stairs: one flight per terrace, each built on the terrace below, hard against the riser
  const wallV = stairSide < 0 ? vA : vB;
  const SW = wT >= 8.6 ? 5.4 : 3.6;
  const uS0 = uH0 + T * wN + 8;
  const uS1 = uF - 14;
  const avail = uS1 - uS0;
  let slope = 0.5;
  let L = hT / slope;
  if (L > avail) {
    L = avail;
    slope = hT / L;
  }
  const LAND = 6;
  let zig = rnd() < 0.5;
  if (T * L + (T - 1) * LAND > avail) zig = true;
  const offs = zig ? R(0, avail - L) : R(0, avail - (T * L + (T - 1) * LAND));
  interface Flight { ua: number; ub: number; v: number; y0: number; y1: number }
  const flights: Flight[] = [];
  g.roughNow = 0;
  for (let k = 0; k < T; k++) {
    let ua: number;
    let ub: number;
    if (zig) {
      ua = uS0 + offs + (k % 2 === 0 ? 0 : L);
      ub = uS0 + offs + (k % 2 === 0 ? L : 0);
    } else {
      ua = uS0 + offs + k * (L + LAND);
      ub = ua + L;
    }
    const fv = wallV - stairSide * ((k + 1) * wT + SW / 2);
    const fl: Flight = { ua, ub, v: fv, y0: level(k), y1: level(k + 1) };
    flights.push(fl);
    g.fillRun([ua, fl.y0, fv], [ub, fl.y1, fv], SW, hT + 2, { steps: true, cap0: 2 });
  }

  // ---- a lookout pushed out from the ledge, over the terrace below
  g.roughNow = 0.1;
  g.fillBox(uH0 + wN - 0.5, vP - 3.6, uH0 + wN + 6, vP + 3.6, yL - 1.6, yL);

  // ---- a bridge from one side's terrace to the other's, over the floor
  const kB = T - 1 - (T > 3 && rnd() < 0.5 ? 1 : 0);
  const yBr = level(kB);
  let uBr = NaN;
  for (let tries = 0; tries < 40 && uBr !== uBr; tries++) {
    const u = even(R(uS0 + 4, uF - 34));
    const f = flights[kB];
    if (u > Math.min(f.ua, f.ub) - 7 && u < Math.max(f.ua, f.ub) + 7) continue;
    if (shafts.some((s) => Math.abs(s - u) < 13)) continue;
    uBr = u;
  }
  const brA = vA + (kB + 1) * wT - 1.2;
  const brB = vB - (kB + 1) * wT + 1.2;
  if (uBr === uBr) {
    g.fillBox(uBr - 2.25, brA, uBr + 2.25, brB, yBr - 2, yBr);
    const pa = vA + T * wT + SW + 5;
    const pb = vB - T * wT - SW - 5;
    const np = Math.max(1, Math.round((pb - pa) / 24));
    for (let i = 0; i <= np; i++) {
      const pv = pa + ((pb - pa) * i) / np;
      g.fillBox(uBr - 1.5, pv - 1.5, uBr + 1.5, pv + 1.5, Yf - 1, yBr - 2);
    }
  }

  // ---- the door wall: a podium and its steps, the door, the chamber behind
  const doorW = R(13, 18);
  const doorH = Math.min(R(40, 52), H - 14);
  const RS = 2;
  const yD = Yf + RS; // the threshold
  const podHalf = doorW / 2 + 8;
  g.roughNow = 0.06;
  g.fillBox(uF - 7, vMid - podHalf, uF, vMid + podHalf, Yf - 1, yD);
  g.roughNow = 0;
  g.fillRun([uF - 7 - RS / 0.5, Yf, vMid], [uF - 7, yD, vMid], podHalf * 2, RS + 1, { steps: true });
  g.roughNow = 0.08;
  g.carveBox(uF, vMid - doorW / 2 - 2.7, uF + 2, vMid + doorW / 2 + 2.7, yD, yD + doorH + 2.5); // the frame
  g.carveBox(uF, vMid - doorW / 2, uF + 6, vMid + doorW / 2, yD, yD + doorH);
  g.carveBox(uF + 6, vMid - 13, uF + 36, vMid + 13, yD, yD + doorH + 4);
  for (let i = 0; i < 3; i++) {
    for (const s of [-1, 1]) g.fillBox(uF + 12 + i * 8 - 1.2, vMid + s * 7.5 - 1.2, uF + 12 + i * 8 + 1.2, vMid + s * 7.5 + 1.2, yD - 1, yD + doorH + 5);
  }

  // ---- colonnades: galleries cut into the door wall at the floor and at the terraces above it
  const nCol = 2 + (rnd() < 0.6 ? 1 : 0);
  const GD = 7;
  const GH = Math.min(9, hT - 3);
  const gap = doorW / 2 + 9;
  const lampEvery = [2, 3, 4][tier];
  for (let q = 0; q < nCol; q++) {
    const k = T - q;
    if (k < 1) break;
    const y = level(k);
    for (const s of [-1, 1]) {
      const va = s < 0 ? vA + k * wT : vMid + gap;
      const vb = s < 0 ? vMid - gap : vB - k * wT;
      if (vb - va < 12) continue;
      g.roughNow = 0.1;
      g.carveBox(uF, va, uF + GD, vb, y, y + GH);
      const n = Math.max(2, Math.floor((vb - va) / 5.4));
      const pitch = (vb - va) / n;
      b.color(1, 1, 1, 0);
      for (let i = 0; i < n; i++) {
        const cv = va + (i + 0.5) * pitch;
        b.cyl(uF + 1.3, y + 0.35, cv, 0.8, GH - 0.8, { solid: true, sides: tier === 2 ? 6 : 8 });
        b.box(uF + 1.3, y, cv, 1.9, 0.35, 1.9);
        b.box(uF + 1.3, y + GH - 0.45, cv, 2, 0.45, 2);
        if (i % lampEvery === (q + (s > 0 ? 1 : 0)) % lampEvery && i + 1 < n) b.lamp(uF + GD - 1, y + 0.5, cv + pitch / 2, { reach: 20 });
      }
    }
  }

  // ---- lamps, left burning: at the ledge, along the way round the rim, down every flight, at the door
  b.lamp(uH0 + 1, yL + 0.5, vP - 3, { reach: 16, strength: 0.8 });
  b.lamp(uH0 + 1, yL + 0.5, vP + 3, { reach: 16, strength: 0.8 });
  b.lamp(uH0 + wN + 5.2, yL + 0.5, vP + 2.8 * side, { reach: 16 });
  const trail = [26, 30, 40][tier];
  {
    // along the near wall to the stair side's corner, then along that wall to the head of the first flight
    const vEnd = wallV - stairSide * 1.2;
    const dir = Math.sign(vEnd - vP) || 1;
    for (let v = vP + dir * trail; (vEnd - v) * dir > 6; v += dir * trail) b.lamp(uH0 + 1.1, yL + 0.5, v, { reach: 14, strength: 0.7 });
    for (let u = uH0 + 8; u < flights[0].ua - 4; u += trail) b.lamp(u, yL + 0.5, vEnd, { reach: 14, strength: 0.7 });
  }
  for (const f of flights) {
    const dir = Math.sign(f.ub - f.ua);
    const len = Math.abs(f.ub - f.ua);
    const fv = f.v + stairSide * (SW / 2 - 0.45);
    for (const t of tier === 2 ? [0.02, 0.98] : len > 34 ? [0.02, 0.34, 0.67, 0.98] : [0.02, 0.5, 0.98]) {
      b.lamp(f.ua + dir * len * t, f.y0 + (f.y1 - f.y0) * t + 0.62, fv, { reach: 20 });
    }
  }
  if (uBr === uBr) {
    for (const t of tier === 2 ? [0.5] : [0.04, 0.5, 0.96]) b.lamp(uBr + 1.8, yBr + 0.5, brA + 1.2 + (brB - brA - 2.4) * t, { reach: 18 });
  }
  for (const s of [-1, 1]) {
    // braziers either side of the door
    const bu = uF - 3.5;
    const bv = vMid + s * (doorW / 2 + 3.4);
    b.color(0.95, 0.95, 0.95, 0);
    b.cyl(bu, yD, bv, 0.7, 1.3, { solid: true });
    b.cyl(bu, yD + 1.3, bv, 0.75, 0.5, { top: 1.6 });
    b.lamp(bu, yD + 2.3, bv, { reach: 50, strength: 1.7, size: 2.6, body: false });
  }

  // ---- what was left behind
  const jar = (u: number, y: number, v: number): void => {
    const r = b.r(0.24, 0.34);
    const h = b.r(0.5, 0.75);
    const k = b.r(0.75, 1);
    if (b.rng() < 0.5) b.color(0.85 * k, 0.62 * k, 0.45 * k, 2);
    else b.color(0.9 * k, 0.86 * k, 0.8 * k, 1);
    if (b.rng() < 0.2) {
      // on its side
      b.cyl(u, y + r, v, r, h, { top: 0.6, rx: Math.PI / 2, sides: 7 });
      return;
    }
    b.cyl(u, y, v, r * 0.8, h * 0.65, { top: 1.25, sides: 7 });
    b.cyl(u, y + h * 0.65, v, r, h * 0.35, { top: 0.5, sides: 7 });
  };
  const jars = (u: number, y: number, v: number, n: number): void => {
    for (let i = 0; i < n; i++) jar(u + b.r(-1, 1), y, v + b.r(-1, 1));
  };
  const rug = (u: number, y: number, v: number, rot: number): void => {
    const red = b.rng() < 0.6;
    if (red) b.color(0.62, 0.2, 0.15, 2);
    else b.color(0.25, 0.34, 0.44, 2);
    b.box(u, y, v, 2.8, 0.05, 1.7, rot);
    b.color(0.85, 0.7, 0.45, 2);
    b.box(u, y + 0.05, v, 2.2, 0.02, 1.1, rot);
  };
  const few = [1, 0.6, 0.35][tier];
  jars(uH0 + 1.8, yL, vP + side * 5.5, Math.ceil(4 * few));
  rug(uH0 + wN + 2.6, yL, vP - side * 0.6, 0.15);
  for (let k = 0; k < flights.length; k++) {
    const f = flights[k];
    const dir = Math.sign(f.ub - f.ua);
    // at the foot of each flight, out of the way of the next one's head
    const fu = f.ub + dir * 3;
    const fv = f.v + stairSide * (SW / 2 - 1.3);
    if (b.rng() < 0.8) jars(fu, f.y1, fv, Math.ceil(3 * few));
    if (k < flights.length - 1 && b.rng() < 0.7 * few + 0.2) rug(f.ub - dir * 0.5, f.y1, f.v - stairSide * (SW / 2 + 1.6), b.r(-0.2, 0.2));
  }
  jars(uF - 2, yD, vMid + (doorW / 2 + 6) * (b.rng() < 0.5 ? -1 : 1), Math.ceil(5 * few));
  rug(uF - 3.5, yD, vMid + b.r(-2, 2), Math.PI / 2 + b.r(-0.1, 0.1));
  // blocks fallen from the walls, on the floor under the far side's terraces and before the door wall
  const farV = stairSide < 0 ? vB - T * wT : vA + T * wT; // foot of the wall the stairs are not on
  for (let i = 0; i < [12, 7, 4][tier]; i++) {
    const s = b.r(0.8, 2.6);
    const byDoor = i % 3 === 0;
    const u = byDoor ? uF - b.r(1.5, 5) - 12 : b.r(uH0 + T * wN + 8, uF - 16);
    const v = byDoor ? vMid + (b.rng() < 0.5 ? -1 : 1) * b.r(podHalf + 4, Math.max(podHalf + 6, W / 2 - T * wT - 6)) : farV + stairSide * b.r(1.5, 7);
    const k = b.r(0.8, 1);
    b.color(k, k, k, 0);
    b.box(u, Yf - s * 0.12, v, s * b.r(0.8, 1.4), s * b.r(0.5, 0.9), s, b.r(0, 3), { rx: b.r(-0.2, 0.2), rz: b.r(-0.2, 0.2), solid: s > 1.2 });
  }

  // ---- a seam of glowing mineral in the foot of the far side's wall
  if (spec.vein) {
    const ua = uH0 + T * wN + b.r(25, 55);
    const len = 28;
    const n = [18, 14, 9][tier];
    for (let i = 0; i < n; i++) {
      const t = (i + b.rng() * 0.6) / n;
      const h = b.r(0.8, 2.2);
      const k = b.r(0.65, 1.1);
      b.color(k, k, k, 4);
      b.cone(ua + len * t, Yf + 0.4 + Math.min(hT - 2, 6) * Math.sin(t * Math.PI) * b.r(0.75, 1), farV + stairSide * 0.1, b.r(0.25, 0.55), h, { rx: stairSide * b.r(0.5, 1.1), rz: b.r(-0.5, 0.5), sides: 4 });
    }
    for (let i = 0; i < 7; i++) {
      const k = b.r(0.6, 1.05);
      b.color(k, k, k, 4);
      b.cone(ua + len / 2 + b.r(-3, 3), Yf, farV + stairSide * b.r(1, 3), b.r(0.18, 0.4), b.r(0.6, 1.7), { rx: b.r(-0.35, 0.35), rz: b.r(-0.35, 0.35), sides: 4 });
    }
    b.light(ua + len / 2, Yf + 3, farV + stairSide * 1.6, 26, 0.9, TEAL);
    b.glow(ua + len / 2, Yf + 3, farV + stairSide * 1.4, 7, [0.22, 0.7, 0.6]);
    for (const t of [0.2, 0.5, 0.8]) b.glow(ua + len * t, Yf + 0.8 + 4 * Math.sin(t * Math.PI), farV + stairSide * 0.4, 2, [0.22, 0.7, 0.6]);
  }

  // ---- carved slabs stood against the door wall, their marks still holding a little light
  if (spec.carvings) {
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const v = vMid + s * (doorW / 2 + 4.3 + i * 2.5) + b.r(-0.2, 0.2);
        const h = b.r(2.6, 3.5);
        const k = b.r(0.85, 1);
        b.color(k, k * 0.98, k * 0.94, 0);
        b.box(uF - 0.42, yD - 0.2, v, 0.55, h, b.r(1.3, 1.7), b.r(-0.06, 0.06), { rz: b.r(-0.04, 0.04) });
        b.color(0.42, 0.42, 0.42, 4);
        for (let row = 0; row < 5; row++) {
          const y = yD + 0.5 + row * 0.42;
          if (y > yD + h - 0.9) break;
          for (let q = -1; q <= 1; q++) {
            if (b.rng() < 0.3) continue;
            const tall = b.rng() < 0.3;
            b.box(uF - 0.72, y, v + q * 0.36, 0.06, tall ? 0.3 : 0.07, tall ? 0.07 : b.r(0.14, 0.28));
          }
        }
      }
    }
  }

  // ---- the relic, on a stone of its own just inside the door
  let relic: Pt | null = null;
  if (spec.relic) {
    const ru = uF + 9;
    b.color(0.9, 0.88, 0.84, 0);
    b.box(ru, yD, vMid, 2.2, 0.4, 2.2, 0, { solid: true });
    b.cyl(ru, yD + 0.4, vMid, 0.62, 0.75);
    b.cyl(ru, yD + 1.15, vMid, 0.48, 0.14);
    relic = [ru, yD + 1.6, vMid];
  }

  return b.finish({ ledge: [uH0 + 1.5, yL, vP], centre: [uF + 1, yD, vMid], relic });
}
