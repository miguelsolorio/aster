// The strata vault: a natural cavern, built into. A stair from the hole runs into a dark passage
// that opens on a high rim; below it terraces follow a wandering wall down to an uneven floor.
// A sunken town stands over the sides and near end, an open court lies before the temple wall
// (a straight, symmetric door flanked by colonnades), and three ways lead from the rim to the floor:
// a broad stair along the terraces, a tunnel inside the rock, and a collapse worn into a rubble slope.
// Side scenes (a shrine, a store, a pool, a collapsed seam) lie at the ends of short side routes.

import type { DeepSpec } from './types';
import { DeepBuilder, TEAL, mulberry32, type DeepData } from './builder';
import type { Pt } from './spans';

/** What was built where, local [u, y, v]: for checks. */
export interface VaultLayout {
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
  /** Side scenes. */
  scenes: Pt[];
  /** The side scenes' entrances. */
  sides: Pt[];
  /** Points round the walkable ring. */
  ring: Pt[];
  /** Dense points down each of the three routes: stair, tunnel, rubble slope. */
  routes: Pt[][];
  /** Outside roof stairs: foot then top, in pairs. */
  stairs: Pt[];
}

/** A built deep's layout, for checks: left on it by the build (see DeepData.extra). */
export function vaultLayout(d: object): VaultLayout | undefined {
  return (d as { vault?: VaultLayout }).vault;
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

export function buildVault(spec: DeepSpec): DeepData {
  const tier = spec.tier;
  const lid = spec.lid;
  const rnd = mulberry32(Math.imul(spec.seed | 0, 0x9e3779b1) ^ 0x51a7a);
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
  const L: VaultLayout = { ledge: [0, 0, 0], centre: [0, 0, 0], relic: null, stone: null, feet: [], doors: [], roofs: [], links: [], tower: null, scenes: [], sides: [], ring: [], routes: [[], [], []], stairs: [] };

  // ---- the way in: stair, then a passage with one turn in it, unlit
  const PW = 3.6;
  const L1 = even(R(12, 18));
  const L3 = even(R(12, 18));
  let side = rnd() < 0.5 ? -1 : 1;
  let Lv = onV(R(9, 15));
  const roomFor = (s: number): number => (s > 0 ? spec.v1 : -spec.v0) - 6 - PW;
  if (roomFor(side) < Lv) side = -side;
  if (roomFor(side) < Lv) Lv = Math.max(0, onV(roomFor(side) - 0.9));
  {
    // the outlet must lie well inside the hall, whatever shape the room is
    const vPc = Math.min(spec.v1 - 34, Math.max(spec.v0 + 34, side * Lv));
    if (vPc !== side * Lv) {
      side = vPc < 0 ? -1 : 1;
      Lv = onV(Math.abs(vPc));
    }
  }
  const uT = 4 + L1 + 2;
  const vP = side * Lv;
  const uH0 = uT + 2 + L3;
  const uF = even(Math.min(spec.u1 - 50, uH0 + 250)); // the temple wall

  // ---- heights
  const Yc = lid - 1.5;
  const yA = lid - 2.9;
  const yL = Yc - 10; // the rim
  const H = Math.min(R(60, 90), 11.5 + 0.5 * (uF - uH0 - 48) * 0.95);
  const Yf = Yc - H;
  const D = yL - Yf;
  const T = Math.min(4, Math.max(3, Math.ceil(D / 22) + (rnd() < 0.3 ? 1 : 0)));
  const hT = D / T;
  const lvl = (k: number): number => (k >= T ? Yf : yL - k * hT);

  const b = new DeepBuilder(spec, { cell: tier === 2 ? 2 : 1, yMin: Yf - 4, maxSpans: 7, wallStep: [6, 7, 8][tier] });
  const g = b.grid;

  // ---- the outline: a wandering edge, different on each side
  const W = Math.min(spec.v1 - spec.v0 - 16, R(170, 250));
  const vLo = Math.max(spec.v0 + 8 + W / 2, vP + 26 - W / 2);
  const vHi = Math.min(spec.v1 - 8 - W / 2, vP - 26 + W / 2);
  const vMid = vLo > vHi ? (vLo + vHi) / 2 : Math.min(vHi, Math.max(vLo, vP + R(-12, 12)));
  const vA = vMid - W / 2;
  const vB = vMid + W / 2;
  const AL = R(4, 13);
  const AH = R(4, 13);
  const AN = R(4, 14);
  const wob = (x: number, ch: number): number => (vn(x, 0.5, ch) + 0.5 * vn(x * 2.3, 0.5, ch + 1)) / 1.5;
  const wLo = (u: number): number => vA + AL * wob(u / 50, 1);
  const wHi = (u: number): number => vB - AH * wob(u / 50, 3);
  const wNr = (v: number): number => uH0 + AN * wob(v / 40, 5);
  const wCap = Math.max(6, (0.55 * W - 18) / (2 * T));
  const wL = Math.min(R(7.5, 9.5), wCap);
  const wH = Math.min(R(7.5, 9.5), wCap);
  const wNs = R(4, 5.5);
  const stairSide = rnd() < 0.5 ? -1 : 1; // which wall the stair goes down; the other holds the tunnel and the rubble
  const skipB = T >= 4 && rnd() < 0.6 ? 1 : 0; // the other side has one terrace fewer
  const skLo = stairSide > 0 ? skipB : 0;
  const skHi = stairSide < 0 ? skipB : 0;
  const cLo = T - skLo;
  const cHi = T - skHi;
  const band = (s: number, cnt: number, skip: number): number => (s >= cnt ? T : s < 1 ? 0 : Math.floor(s) + skip);

  const doorW = R(13, 18);
  const courtHalf = doorW / 2 + 15;
  const courtLen = 46;
  const yD = Yf + 2;
  const doorH = Math.min(R(40, 52), D - 2 - 8);

  // the collapses that shape the floor: a slope of rubble worn down the far wall, a slump at the near end
  const bSide = -stairSide;
  const wB = bSide < 0 ? wL : wH;
  const cB = bSide < 0 ? cLo : cHi;
  const dEnd = cB * wB + 3;
  const gu = 0.46;
  const S1end = Math.min(yL, Yf + gu * (dEnd - 4)); // where the slope turns out across the terraces
  const uR0 = uH0 + AN + 30;
  const uR1 = uR0 + (yL - S1end) / gu;
  const edgeB = (u: number): number => (bSide < 0 ? wLo(u) : wHi(u));
  const dB = (u: number, v: number): number => (bSide < 0 ? v - wLo(u) : wHi(u) - v);
  const vHeap = vMid + R(-60, 60);
  const uHeap = wNr(vHeap) + T * wNs;
  const RH = R(15, 20);
  const HH = R(5.5, 7.5);

  const ground = (u: number, v: number): number => {
    const sLo = (v - wLo(u)) / wL;
    const sHi = (wHi(u) - v) / wH;
    const sN = (u - wNr(v)) / wNs;
    if (sLo < 0 || sHi < 0 || sN < 0) return NaN;
    const k = Math.min(band(sLo, cLo, skLo), band(sHi, cHi, skHi), band(sN, T, 0));
    let F = lvl(k);
    if (k >= T) {
      const dE = Math.min((sLo - cLo) * wL, (sHi - cHi) * wH, (sN - T) * wNs);
      const dc = Math.hypot(Math.max(0, uF - courtLen - u), Math.max(0, Math.abs(v - vMid) - courtHalf));
      const m = smooth((dE - 5) / 12) * smooth(dc / 14) * smooth((uF - u - 12) / 14);
      const n = 0.75 * vn(u / 40, v / 40, 9) + 0.25 * vn(u / 14, v / 14, 10);
      F += m * Math.max(0, 4.6 * n - 1.5);
    }
    // the slump at the near end
    const hd = Math.hypot(u - uHeap, v - vHeap);
    if (hd < RH) F = Math.max(F, Yf + HH * (1 - hd / RH));
    // the rubble slope: down the wall, then out across the terraces (one tilted plane, in an L)
    if (u > uR0 - 8 && u < uR1 + 20) {
      const d = dB(u, v);
      const S = Math.max(Yf, Math.max(S1end, yL - gu * Math.max(0, u - uR0)) - gu * Math.max(0, d - 4));
      const w1 = (1 - smooth((Math.abs(d - 4) - 4) / 3)) * smooth((u - uR0 + 8) / 6) * (1 - smooth((u - uR1 - 12) / 6));
      const w2 = (1 - smooth((Math.abs(u - uR1 - 4) - 4) / 3)) * smooth((d + 2) / 4) * (1 - smooth((d - dEnd - 2) / 4));
      F += (S - F) * Math.max(w1, w2);
    }
    return F;
  };
  const ceilOf = (u: number, v: number, F: number): number => {
    const dW = Math.min((v - wLo(u)) / wL * wL, (wHi(u) - v), u - wNr(v));
    const arch = 1 - smooth(dW / 45);
    const drop = 6 * arch * (0.4 + 0.6 * vn(u / 17, v / 17, 6)) + 3.5 * vn(u / 31, v / 31, 7) + 0.7 * vn(u / 9, v / 9, 8);
    const q = 2.5;
    return Math.max(Yc - Math.floor(Math.min(9.9, drop) / q) * q, Math.ceil((F + 8) / q) * q);
  };

  // ---- carve the passage, then the hall
  const uEnd = (() => {
    let m = 0;
    for (let v = vP - 2.5; v <= vP + 2.5; v += 0.5) m = Math.max(m, wNr(v));
    return even(m) + 2;
  })();
  const Lp = uT - 4 + Lv + (uEnd - uT);
  const yAt = (s: number): number => yA + ((yL - yA) * s) / Lp;
  b.holeStair();
  g.roughNow = 0.12;
  const PH = 2.5;
  if (Lv > 0) {
    g.carveRun([4, yA, 0], [uT, yAt(uT - 4), 0], PW, PH, { cap1: 2 });
    g.carveRun([uT, yAt(uT - 4), 0], [uT, yAt(uT - 4 + Lv), vP], PW + 0.4, PH, { cap0: 1.8, cap1: 1.8 });
    g.carveRun([uT, yAt(uT - 4 + Lv), vP], [uEnd, yL, vP], PW, PH, { cap0: 2 });
  } else {
    g.carveRun([4, yA, 0], [uEnd, yL, vP], PW, PH);
  }
  g.roughNow = tier === 2 ? 0.5 : 0.35;
  const cu = g.cu;
  g.carveFn(uH0, vA, uF, vB, (u, v, o) => {
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
    return true;
  });
  g.roughNow = 0.1;

  // ---- the stair: one flight per terrace down the stair side, each built on the terrace below, hard against the riser
  const wS = stairSide < 0 ? wL : wH;
  const faceS = (u: number, k: number): number => (stairSide < 0 ? wLo(u) + k * wS : wHi(u) - k * wS);
  const SW = 3.6;
  const uS0 = uH0 + AN + T * wNs + 8;
  const uS1 = uF - 14;
  const avail = uS1 - uS0;
  let slope = 0.5;
  let Lf = hT / slope;
  if (Lf > avail) {
    Lf = avail;
    slope = hT / Lf;
  }
  const LAND = 6;
  let zig = rnd() < 0.5;
  if (T * Lf + (T - 1) * LAND > avail) zig = true;
  const spanLen = zig ? Lf : T * Lf + (T - 1) * LAND;
  const ue0 = even(uH0 + AN + 8) + 2 + (yL - Yf) / 0.5; // where the tunnel will come out: keep the flights clear of it
  const lowOK = ue0 - 12 - spanLen >= uS0;
  const highOK = ue0 + 12 + spanLen <= uS1;
  const pickHigh = highOK && (!lowOK || rnd() < 0.5);
  const offs0 = R(0, avail - spanLen);
  const offs = pickHigh ? ue0 + 12 - uS0 + R(0, uS1 - (ue0 + 12 + spanLen)) : lowOK ? R(0, ue0 - 12 - spanLen - uS0) : offs0;
  interface Flight { ua: number; ub: number; y0: number; y1: number; k: number }
  const flights: Flight[] = [];
  g.roughNow = 0;
  for (let k = 0; k < T; k++) {
    const ua = zig ? uS0 + offs + (k % 2 === 0 ? 0 : Lf) : uS0 + offs + k * (Lf + LAND);
    const ub = zig ? uS0 + offs + (k % 2 === 0 ? Lf : 0) : ua + Lf;
    const fl: Flight = { ua, ub, y0: lvl(k), y1: lvl(k + 1), k };
    flights.push(fl);
    const len = Math.abs(ub - ua);
    const n = Math.max(1, Math.ceil(len / 4));
    for (let s = 0; s < n; s++) {
      const t0 = s / n;
      const t1 = (s + 1) / n;
      const us = ua + (ub - ua) * t0;
      const ue = ua + (ub - ua) * t1;
      let fmin = Infinity;
      let fmax = -Infinity;
      for (let q = 0; q <= 4; q++) {
        const f = faceS(us + ((ue - us) * q) / 4, k + 1);
        fmin = Math.min(fmin, f);
        fmax = Math.max(fmax, f);
      }
      const va = stairSide < 0 ? fmin - 1 : fmin - SW;
      const vb = stairSide < 0 ? fmax + SW : fmax + 1;
      g.fillRun([us, fl.y0 + (fl.y1 - fl.y0) * t0, (va + vb) / 2], [ue, fl.y0 + (fl.y1 - fl.y0) * t1, (va + vb) / 2], vb - va, hT + 3, { steps: true, cap0: s === 0 ? 2 : 0 });
    }
  }
  for (const f of flights) {
    for (let q = 0; q <= 8; q++) {
      const u = f.ua + ((f.ub - f.ua) * q) / 8;
      L.routes[0].push([u, f.y0 + ((f.y1 - f.y0) * q) / 8, faceS(u, f.k + 1) + (stairSide < 0 ? 1.8 : -1.8)]);
    }
  }
  {
    const f = flights[T - 1];
    L.feet.push([f.ub, Yf, faceS(f.ub, T) + stairSide * 0 + (stairSide < 0 ? 1 : -1) * 1.5]);
  }

  // ---- pillars: massive natural columns, floor to roof
  const pillars: [number, number, number][] = [];
  {
    const nP = 3 + Math.floor(rnd() * 4);
    for (let tries = 0; tries < 300 && pillars.length < nP; tries++) {
      const u = R(uH0 + AN + T * wNs + 26, uF - 60);
      const v = R(vA + T * wL + 22, vB - T * wH - 22);
      const r = R(3.5, 6.5);
      if (Math.abs(v - vMid) < courtHalf + r + 6 && u > uF - courtLen - r - 8) continue;
      if (Math.abs(v - vP) < r + 7 && u < uH0 + AN + 90) continue; // the way out of the ledge stays open
      if (Math.hypot(u - uHeap, v - vHeap) < RH + r + 6) continue;
      let flat = true;
      for (let q = 0; q < 8 && flat; q++) {
        const F = ground(u + Math.cos(q * 0.785) * (r + 5), v + Math.sin(q * 0.785) * (r + 5));
        if (!(F < Yf + 3.3)) flat = false;
      }
      if (!flat || pillars.some((p) => Math.hypot(p[0] - u, p[1] - v) < p[2] + r + 30)) continue;
      pillars.push([u, v, r]);
    }
    g.roughNow = 0.5;
    for (const [pu, pv, pr] of pillars) {
      const n = 3;
      for (let q = 0; q < n; q++) {
        const y0 = q === 0 ? Yf - 1 : Yf + (H * q) / n;
        const y1 = q === n - 1 ? Yc + 1 : Yf + (H * (q + 1)) / n;
        g.fillCyl(pu, pv, pr * [1.25, 0.8, 1.2][q] * (0.9 + 0.2 * rnd()), y0, y1, 0.05);
      }
    }
  }

  // ---- light from above: one shaft over the court
  b.skyShaft(uF - R(26, 44), vMid + R(-6, 6), R(5, 7.5), 1);

  // ---- the temple wall: a podium and its steps, the door, the chamber behind
  const GD = 8;
  const GH = Math.min(9, hT - 3);
  const gap = doorW / 2 + 9;
  const podHalf = doorW / 2 + 8;
  const RS = 2;
  g.roughNow = 0.06;
  g.fillBox(uF - 7, vMid - podHalf, uF, vMid + podHalf, Yf - 1, yD);
  g.roughNow = 0;
  g.fillRun([uF - 7 - RS / 0.5, Yf, vMid], [uF - 7, yD, vMid], podHalf * 2, RS + 1, { steps: true });
  g.roughNow = 0.08;
  g.carveBox(uF, vMid - doorW / 2 - 2.7, uF + 2, vMid + doorW / 2 + 2.7, yD, yD + doorH + 2.5);
  g.carveBox(uF, vMid - doorW / 2, uF + 6, vMid + doorW / 2, yD, yD + doorH);
  g.carveBox(uF + 6, vMid - 13, uF + 36, vMid + 13, yD, yD + doorH + 4);
  b.color(1, 1, 1, 0);
  for (let i = 0; i < 3; i++) {
    for (const s of [-1, 1]) g.fillBox(uF + 12 + i * 8 - 1.2, vMid + s * 7.5 - 1.2, uF + 12 + i * 8 + 1.2, vMid + s * 7.5 + 1.2, yD - 1, yD + doorH + 5);
  }

  // ---- colonnades with rooms behind them, cut into the temple wall at three levels
  const rawOf = (kk: number, skip: number): number => (kk >= T ? T - skip : kk >= 1 ? kk - skip : 0);
  const wing = (s: number, kk: number): [number, number] => {
    const raw = rawOf(kk, s < 0 ? skLo : skHi);
    return s < 0 ? [wLo(uF) + raw * wL, vMid - gap] : [vMid + gap, wHi(uF) - raw * wH];
  };
  const kks = [T, T - 1];
  if (rnd() < 0.7 || T === 3) kks.push(T - 2);
  const fallS = rnd() < 0.5 ? -1 : 1;
  const fallK = kks[kks.length - 1];
  const lampEvery = [2, 3, 3][tier];
  const props: (() => void)[] = []; // dressing, done once the carving is over
  const wings: Record<string, [number, number]> = {};
  for (const s of [-1, 1]) {
    for (const kk of kks) {
      const [va, vb] = wing(s, kk);
      if (vb - va < 30) continue;
      wings[`${s}_${kk}`] = [va, vb];
      const y = lvl(kk);
      g.roughNow = 0.1;
      g.carveBox(uF, va, uF + GD, vb, y, y + GH);
      g.carveBox(uF + 10, va + 1.8, uF + 14, vb, y, y + 3.4); // the back corridor
      for (let vd = va + 9; vd < vb - 4; vd += 18) g.carveBox(uF + 7, vd - 1.8, uF + 11, vd + 1.8, y, y + 3.2);
      const nR = Math.floor((vb - va - 3.6) / 14.4);
      for (let r = 0; r < nR; r++) {
        const vs = va + 1.8 + 14.4 * r;
        g.carveBox(uF + 16, vs, uF + 26, vs + 12.6, y, y + 4.6);
        g.carveBox(uF + 13, vs + 5.4, uF + 17, vs + 9, y, y + 3.2);
        if (r < nR - 1) g.carveBox(uF + 19, vs + 10.8, uF + 23, vs + 16.2, y, y + 3.2);
        if (r % lampEvery === 0) props.push(() => b.lamp(uF + 24, y + 3, vs + 6.3, { reach: 14, strength: 0.8 }));
      }
      const n = Math.max(2, Math.floor((vb - va) / 5.4));
      const pitch = (vb - va) / n;
      for (let i = 0; i < n; i++) {
        const cv = va + (i + 0.5) * pitch;
        const outer = s < 0 ? i / n : 1 - (i + 1) / n; // 0 at the outer end
        const fallen = s === fallS && kk === fallK && outer < 0.3;
        props.push(() => {
          b.color(1, 1, 1, 0);
          if (fallen) {
            if (i % 2 === 0) b.cyl(uF + 2.5 + b.r(0, 3), y + 0.6, cv, 0.8, b.r(2, 4), { solid: true, rx: Math.PI / 2, rz: b.r(-0.3, 0.3), sides: 6 });
            else b.box(uF + b.r(2, 5), y, cv, b.r(1.6, 2.6), b.r(1, 1.8), b.r(1.6, 2.6), b.r(0, 3), { solid: true });
            return;
          }
          b.cyl(uF + 1.3, y + 0.35, cv, 0.8, GH - 0.8, { solid: true, sides: tier === 2 ? 6 : 8 });
          b.box(uF + 1.3, y, cv, 1.9, 0.35, 1.9);
          b.box(uF + 1.3, y + GH - 0.45, cv, 2, 0.45, 2);
          if (i % 5 === 2 && i + 1 < n) b.lamp(uF + GD - 1, y + 0.5, cv + pitch / 2, { reach: 20 });
        });
      }
    }
  }
  // stairs inside the rock between the levels, and a passage behind the chamber that closes the ring
  for (const s of [-1, 1]) {
    for (let q = 0; q + 1 < kks.length; q++) {
      const A = wings[`${s}_${kks[q + 1]}`]; // the upper level
      const B = wings[`${s}_${kks[q]}`];
      if (!A || !B) continue;
      const yk = lvl(kks[q + 1]);
      const yl = lvl(kks[q]);
      const Ls = 2 * (yk - yl);
      const vtop = s < 0 ? A[1] - 7 : A[0] + 7;
      const vbot = s < 0 ? vtop - Ls : vtop + Ls;
      if (s < 0 ? vbot < B[0] + 6 : vbot > B[1] - 6) continue;
      g.roughNow = 0.05;
      g.carveBox(uF + 10, vtop - 1.8, uF + 33, vtop + 1.8, yk, yk + 3.2);
      g.carveBox(uF + 10, vbot - 1.8, uF + 33, vbot + 1.8, yl, yl + 3.2);
      g.carveRun([uF + 31, yk, vtop], [uF + 31, yl, vbot], 4, 3.2, { steps: true });
      L.scenes.push([uF + 31, yl, vbot]);
      props.push(() => {
        b.lamp(uF + 28, yk + 2.8, vtop, { reach: 14, strength: 0.8 });
        b.lamp(uF + 30, yk - (yk - yl) / 2 + 2.8, (vtop + vbot) / 2, { reach: 14, strength: 0.8 });
        b.lamp(uF + 28, yl + 2.8, vbot, { reach: 14, strength: 0.8 });
      });
    }
  }
  const yR = lvl(T - 1);
  if (wings[`-1_${T - 1}`] && wings[`1_${T - 1}`]) {
    g.roughNow = 0.05;
    g.carveBox(uF + 10, vMid - gap - 4, uF + 46, vMid - gap, yR, yR + 3.4);
    g.carveBox(uF + 10, vMid + gap, uF + 46, vMid + gap + 4, yR, yR + 3.4);
    g.carveBox(uF + 42, vMid - gap - 4, uF + 46, vMid + gap + 4, yR, yR + 3.4);
    props.push(() => b.lamp(uF + 44, yR + 3, vMid, { reach: 16, strength: 0.8 }));
    L.ring.push([uF + 44, yR, vMid], [uF + 12, yR, vMid - gap - 2], [uF + 12, yR, vMid + gap + 2]);
  }
  {
    // the walkable ring, at the level above the floor: along both sides' terraces and the near wall
    const kr = T - 1;
    for (const u of [uF - 20, uH0 + 70, uH0 + 120]) {
      L.ring.push([u, yR, wLo(u) + (rawOf(kr, skLo) + 0.5) * wL], [u, yR, wHi(u) - (rawOf(kr, skHi) + 0.5) * wH]);
    }
    for (const dv of [-40, 0, 40]) L.ring.push([wNr(vMid + dv) + (kr + 0.5) * wNs, yR, vMid + dv]);
  }
  // a causeway over the rubble slope where it crosses that ring level
  {
    const dS = Math.max(Yf, S1end - gu * ((cB - 1) * wB - 4));
    if (dS + 1.2 <= yR - 1) {
      g.roughNow = 0.05;
      g.fillFn(uR1 - 4, vA, uR1 + 12, vB, (u, v, o) => {
        const d = dB(u, v);
        if (d < (cB - 1) * wB - 1 || d > cB * wB + 0.5) return false;
        o.lo = yR - 1;
        o.hi = yR;
        return true;
      });
    }
  }

  const sgB = bSide < 0 ? 1 : -1;
  for (let u = uR0; u <= uR1; u += 3) L.routes[2].push([u, ground(u, edgeB(u) + sgB * 4), edgeB(u) + sgB * 4]);
  for (let d = 4; d <= dEnd; d += 2) L.routes[2].push([uR1 + 4, ground(uR1 + 4, edgeB(uR1 + 4) + sgB * d), edgeB(uR1 + 4) + sgB * d]);
  L.feet.push([uR1 + 4, ground(uR1 + 4, edgeB(uR1 + 4) + sgB * (dEnd + 1)), edgeB(uR1 + 4) + sgB * (dEnd + 1)]);

  // ---- the tunnel: a stair cut inside the rock behind the stair side's wall
  const edgeA = (u: number): number => (stairSide < 0 ? wLo(u) : wHi(u));
  const vtun = (u: number): number => edgeA(u) + stairSide * 4.5;
  {
    const fT = flights[T - 1];
    const uD = even(uH0 + AN + 8);
    void fT;
    g.roughNow = 0.05;
    const eA = edgeA(uD);
    const [vi0, vi1] = stairSide < 0 ? [eA - 6.4, eA + 3] : [eA - 3, eA + 6.4];
    g.carveBox(uD - 2, vi0, uD + 2, vi1, yL, yL + 2.8);
    L.scenes.push([uD, yL, eA + (stairSide < 0 ? 1.5 : -1.5)]);
    props.push(() => {
      b.lamp(uD - 1.5, yL + 2.4, eA + (stairSide < 0 ? 1 : -1), { reach: 14, strength: 0.9 });
    });
    let uc = uD + 2;
    let yc = yL;
    const path: [number, number][] = [];
    while (yc > Yf + 1e-6 && uc < uF - 10) {
      const ln = Math.min(4, (yc - Yf) / 0.5);
      const un = uc + ln;
      const yn = yc - 0.5 * ln;
      let vmin = Infinity;
      let vmax = -Infinity;
      for (let q = 0; q <= 4; q++) {
        const v = vtun(uc + (ln * q) / 4);
        vmin = Math.min(vmin, v);
        vmax = Math.max(vmax, v);
      }
      const vm = (vmin + vmax) / 2;
      g.carveRun([uc, yc, vm], [un, yn, vm], 3.6 + (vmax - vmin), 2.8, { steps: true });
      path.push([uc, yc]);
      L.routes[1].push([uc + ln / 2, yc - ln / 4, vm]);
      uc = un;
      yc = yn;
    }
    const ue = uc;
    const e = edgeA(ue);
    const span = T * (stairSide < 0 ? wL : wH) + 3;
    if (stairSide < 0) g.carveBox(ue, e - 6.4, ue + 4, e + span, Yf, Yf + 2.8);
    else g.carveBox(ue, e - span, ue + 4, e + 6.4, Yf, Yf + 2.8);
    L.feet.push([ue + 2, Yf, e + stairSide * -(span - 1.5)]);
    // windows onto the faces, where the tunnel passes the height of a riser and no flight is in the way
    const wS2 = stairSide < 0 ? wL : wH;
    for (const kf of [0, 1]) {
      if (kf + 1 > T - 1) continue;
      const yw = lvl(kf + 1) + 1 + 0.5 * (hT - 3.5);
      const uw = even(uD + 2 + (yL - yw) / 0.5);
      const f = flights[kf];
      if (uw > Math.min(f.ua, f.ub) - 5 && uw < Math.max(f.ua, f.ub) + 5) continue;
      const fc = edgeA(uw) + stairSide * -(kf + 1) * wS2;
      if (stairSide < 0) g.carveBox(uw - 1, edgeA(uw) - 4, uw + 1, fc + 1, yw + 1, yw + 3.4);
      else g.carveBox(uw - 1, fc - 1, uw + 1, edgeA(uw) + 4, yw + 1, yw + 3.4);
      props.push(() => b.lamp(uw, yw + 2.2, vtun(uw) + stairSide * -2.5, { reach: 14, strength: 0.8 }));
    }
    for (let i = 3; i < path.length; i += tier === 2 ? 20 : 12) {
      const [pu, py] = path[i];
      props.push(() => b.lamp(pu, py + 2.4, vtun(pu) + stairSide * -1.6, { reach: 12, strength: 0.7 }));
    }
  }

  // side scenes are planned first, so the town leaves their doors clear
  const faceB = (u: number): number => (bSide < 0 ? wLo(u) + cB * wB : wHi(u) - cB * wB);
  const sceneU: number[] = [];
  {
    const lo = uH0 + AN + T * wNs + 16;
    const hi = uF - 34;
    for (const gap of [18, 14, 10]) {
      sceneU.length = 0;
      for (let tries = 0; tries < 500 && sceneU.length < 4; tries++) {
        const uc = even(R(lo, hi));
        if (sceneU.some((x) => Math.abs(x - uc) < gap)) continue;
        if (Math.abs(uc - uR1 - 4) < 20) continue;
        if (Math.hypot(uc - uHeap, faceB(uc) - vHeap) < RH + 12) continue;
        if (L.feet.some((p) => Math.abs(p[0] - uc) < 14)) continue;
        const fv = faceB(uc) - bSide * 3;
        if (!(ground(uc, fv) <= Yf + 0.3)) continue;
        if (pillars.some((p) => Math.hypot(p[0] - uc, p[1] - fv) < p[2] * 1.4 + 9)) continue;
        sceneU.push(uc);
      }
      if (sceneU.length >= 4) break;
    }
    sceneU.sort((a, c) => a - c);
  }
  // ---- the sunken town: lots on a grid over the floor, clear of the court, the pillars and the feet of the routes
  const PU = 20;
  const PV = 14.4;
  const uL0 = even(uH0 + AN + T * wNs + 12);
  const vL0 = onV(vA + 20);
  const nI = Math.floor((uF - 14 - uL0) / PU);
  const nJ = Math.floor((vB - 20 - vL0) / PV);
  interface Lot { i: number; j: number; u: number; v: number; ok: boolean; used: boolean; score: number }
  const lots: Lot[] = [];
  const lotAt = (i: number, j: number): Lot | undefined => (i < 0 || j < 0 || i >= nI || j >= nJ ? undefined : lots[i * nJ + j]);
  const keepClear: [number, number, number][] = [...L.feet.map((p): [number, number, number] => [p[0], p[2], 10]), [uR1 + 4, edgeB(uR1 + 4) + (bSide < 0 ? 1 : -1) * dEnd, 12], ...sceneU.map((u): [number, number, number] => [u, faceB(u) - bSide * 3, 5]), ...L.routes[0].filter((p) => p[1] < Yf + hT + 0.5).map((p): [number, number, number] => [p[0], p[2], 7])];
  for (let i = 0; i < nI; i++) {
    for (let j = 0; j < nJ; j++) {
      const u = uL0 + i * PU;
      const v = vL0 + j * PV;
      let ok = true;
      for (let q = 0; q < 9 && ok; q++) {
        const F = ground(u + 1 + (q % 3) * 8, v + 0.5 + Math.floor(q / 3) * 6.2);
        if (!(F < Yf + 3.4)) ok = false;
      }
      const okG = ok;
      const cx = u + PU / 2;
      const cz = v + PV / 2;
      if (cx + PU / 2 > uF - courtLen - 4 && Math.abs(cz - vMid) < courtHalf + 4 + PV / 2) ok = false;
      const okC = ok;
      if (pillars.some((p) => Math.hypot(p[0] - cx, p[1] - cz) < p[2] * 1.4 + 4)) ok = false;
      const okP = ok;
      if (keepClear.some((p) => Math.hypot(p[0] - cx, p[1] - cz) < p[2] + 8)) ok = false;
      const side = Math.abs(cz - vMid) / (W / 2);
      if ((globalThis as any).DBGV) { const r = ((globalThis as any).RS ??= { all: 0, g: 0, c: 0, p: 0, k: 0 }); r.all++; if (okG) r.g++; if (okC) r.c++; if (okP) r.p++; if (ok) r.k++; }
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
  // the figure: a seated giant of blocks on a plinth, facing the court
  {
    const sF = rnd() < 0.5 ? -1 : 1;
    const cand = free().filter((l) => { const n = lotAt(l.i, l.j + 1); return n && n.ok && !n.used && !rectHitsPillar(l.u, l.v - 2, l.u + PU, l.v + PV * 2 + 2); });
    const lt = nearest(uF - 80, vMid + sF * (courtHalf + 24), cand);
    if (lt) {
      const l2 = lotAt(lt.i, lt.j + 1)!;
      lt.used = true;
      l2.used = true;
      const cuF = lt.u + PU / 2;
      const cvF = lt.v + PV;
      const dir = vMid > cvF ? 1 : -1;
      const hF = R(17, 22) / 20.4;
      const y0 = groundMax(cuF - 8, cvF - 9, cuF + 8, cvF + 9) + 0.2;
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
      for (const sx of [9, -9]) {
        if (pillars.some((p) => Math.hypot(p[0] - cuF - sx, p[1] - cvF) < p[2] * 1.45 + 3)) continue;
        L.scenes.push([cuF + sx, ground(cuF + sx, cvF), cvF]);
        break;
      }
      lampsTown.push(() => b.lamp(cuF + 9, y0 + 1.8, cvF + dir * 4, { reach: 20 }), () => b.lamp(cuF - 9, y0 + 1.8, cvF + dir * 4, { reach: 20 }));
    }
  }
  // the tower you can climb: three flights round a void, a platform at the top
  {
    const fits = (l: Lot, west: boolean): boolean => { const n = lotAt(l.i, l.j + 1); const w = lotAt(l.i - 1, l.j); return !!n && n.ok && !n.used && (!west || (!!w && w.ok)) && ground(l.u - 4, l.v + 1.8) < Yf + 3.4 && ground(l.u - 4, l.v + 25) < Yf + 3.4 && !rectHitsPillar(l.u - 6, l.v - 3, l.u + 18, l.v + 29); };
    const tv = vMid + R(-50, 50);
    // prefer a lot with an open lot to the west for the stair foot; if the town has none, any lot whose west edge is low ground will do
    const lt = nearest(uL0 + 40, tv, free().filter((l) => fits(l, true))) ?? nearest(uL0 + 40, tv, free().filter((l) => fits(l, false)));
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
      g.fillBox(ua + 12, va + 21.6, ua + 16, va + 25.2, yB, yB + 15);
      g.fillRun([ua + 12, yB + 15, va + 23.4], [ua + 4, yB + 19, va + 23.4], 3.6, 26, { steps: true });
      g.fillBox(ua, va + 18, ua + 4, va + 25.2, yB + 3, yB + 19);
      g.paintF = 0;
      L.tower = [ua + 2, yB + 19, va + 23];
      L.doors.push([ua - 1.5, yB, va + 1.8]);
      lampsTown.push(() => b.lamp(ua - 1, yB + 1.2, va + 1.8, { reach: 16 }), () => b.lamp(ua + 2, yB + 20, va + 23, { reach: 24, strength: 1.2 }));
    }
  }
  // obelisks beside the court
  for (const sO of [-1, 1]) {
    const lt = nearest(uF - courtLen - 12, vMid + sO * (courtHalf + 12), free());
    if (!lt) continue;
    lt.used = true;
    const [cx, cz] = mid(lt);
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
    if ((globalThis as any).DBGV) console.log('DBGB', JSON.stringify((globalThis as any).RS), blds.length, 'valid', lots.filter((l) => l.ok).length, '/', lots.length, 'links', links.length, 'stairs', blds.filter((x) => x.stair).map((x) => nb(x).length).join(','), 'freeok', lots.filter((l) => l.ok && !l.used).length);
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
      lampsTown.push(() => b.lamp(cx, ground(cx, cz) + 2.4, cz, { reach: 18 }));
    }
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
  let li = 0;
  for (const f of lampsTown) if (li++ % (tier === 2 ? 2 : 1) === 0 || tierKeep === 1) f();

  // ---- side scenes: four small rooms off the floor-level face of the far side, each at the end of a short passage
  const relicInTemple = hash2(ns, 99) < 0.5;
  const relicScene = Math.min(Math.max(0, sceneU.length - 1), Math.floor(hash2(ns, 98) * Math.max(1, sceneU.length)));
  let relic: Pt | null = null;
  if (spec.relic && relicInTemple) {
    const ru = uF + 9;
    props.push(() => {
      b.color(0.9, 0.88, 0.84, 0);
      b.box(ru, yD, vMid, 2.2, 0.4, 2.2, 0, { solid: true });
      b.cyl(ru, yD + 0.4, vMid, 0.62, 0.75, { solid: true });
      b.cyl(ru, yD + 1.15, vMid, 0.48, 0.14);
    });
    relic = [ru, yD + 1.6, vMid];
  }
  sceneU.forEach((uc, idx) => {
    const kind = idx % 4;
    const f0 = faceB(uc);
    let fin = bSide < 0 ? Infinity : -Infinity;
    for (let u = uc - 6; u <= uc + 6; u += 1) fin = bSide < 0 ? Math.min(fin, faceB(u)) : Math.max(fin, faceB(u));
    const sg = bSide; // toward the rock
    const vIn = fin + sg * 5;
    const vRoom0 = fin + sg * 5;
    const vRoom1 = fin + sg * 12;
    const rh = 4.2;
    g.roughNow = 0.15;
    const rb = (u0: number, u1: number, a: number, c: number, y0: number, y1: number): void => g.carveBox(u0, Math.min(a, c), u1, Math.max(a, c), y0, y1);
    rb(uc - 2, uc + 2, f0 - sg * 1, vIn, Yf, Yf + 3);
    rb(uc - 6, uc + 6, vRoom0, vRoom1, Yf, Yf + rh);
    const vc = (vRoom0 + vRoom1) / 2;
    const back = vRoom1 - sg * 0.6; // the far wall of the room
    const sceneP: Pt = [uc, Yf, vIn + sg * 1.5];
    if (kind === 2) {
      // a shallow pool fed by a trickle
      g.carveBox(uc - 4, Math.min(vc, vc + sg * 3) - 2.7, uc + 4, Math.max(vc, vc + sg * 3) + 0.9, Yf - 0.45, Yf + rh);
      g.pool(uc - 4, Math.min(vc, vc + sg * 3) - 2.7, uc + 4, Math.max(vc, vc + sg * 3) + 0.9, Yf - 0.12);
    }
    if (kind === 3) {
      // fallen roof over a glowing seam
      g.carveBox(uc - 6, Math.min(vRoom1, vRoom1 + sg * 4), uc + 6, Math.max(vRoom1, vRoom1 + sg * 4), Yf, Yf + rh - 0.6);
    }
    L.scenes.push([sceneP[0], sceneP[1], sceneP[2]]);
    L.sides.push([sceneP[0], sceneP[1], sceneP[2]]);
    const rp: Pt = [uc + 3, Yf + 0.9, vc - sg * 0.5];
    if (spec.relic && !relicInTemple && idx === relicScene) {
      relic = [uc, Yf + 1.6, vc];
      props.push(() => {
        b.color(0.9, 0.88, 0.84, 0);
        b.box(uc, Yf, vc, 2.2, 0.4, 2.2, 0, { solid: true });
        b.cyl(uc, Yf + 0.4, vc, 0.62, 0.75, { solid: true });
        b.cyl(uc, Yf + 1.15, vc, 0.48, 0.14);
      });
    }
    props.push(() => {
      b.lamp(uc - 3.4, Yf + 2.6, f0 - sg * 3 + 0, { reach: 12, strength: 0.9 });
      if (kind === 0) {
        // carved slabs, their marks holding a little light
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
              const tall = b.rng() < 0.3;
              b.box(u + q * 0.36, y, back - sg * 0.27, tall ? 0.07 : b.r(0.14, 0.28), tall ? 0.3 : 0.07, 0.06);
            }
          }
        }
        b.lamp(uc, Yf + 3.4, vc, { reach: 14 });
      } else if (kind === 1) {
        // a store: crates and jars
        for (let i = 0; i < 6 * [1, 0.7, 0.4][tier]; i++) {
          const u = uc - 5 + b.r(0, 10);
          const v = vc + sg * b.r(-1.5, 3);
          const s = b.r(0.9, 1.5);
          b.color(0.55, 0.4, 0.26, 2);
          b.box(u, Yf, v, s, s * 0.8, s, b.r(0, 3), { solid: true });
          if (b.rng() < 0.4) b.box(u, Yf + s * 0.8, v, s * 0.7, s * 0.6, s * 0.7, b.r(0, 3), { solid: true });
        }
        for (let i = 0; i < 8; i++) jar(uc - 5.5 + b.r(0, 11), Yf, back - sg * b.r(1, 2.2));
        b.lamp(uc, Yf + 3.4, vc, { reach: 14 });
      } else if (kind === 2) {
        b.color(0.6, 0.78, 0.86, 1);
        b.cyl(uc, Yf + 0.2, vc + sg * 1.5, 0.1, rh - 0.4, { sides: 4 });
        b.lamp(uc - 3.5, Yf + 3, vc - sg * 2, { reach: 12 });
      } else {
        // a seam of glowing mineral in the broken end
        const n = (spec.vein ? 1 : 0.55) * [18, 14, 9][tier];
        for (let i = 0; i < n; i++) {
          const t = (i + b.rng() * 0.6) / n;
          const h = b.r(0.8, 2.2);
          const k = b.r(0.65, 1.1);
          b.color(k, k, k, 4);
          b.cone(uc - 5 + 10 * t, Yf + 0.4 + 1.8 * Math.sin(t * Math.PI) * b.r(0.6, 1), vRoom1 + sg * 0.4, b.r(0.25, 0.55), h, { rx: b.r(-0.6, 0.6), rz: b.r(-0.5, 0.5), sides: 4 });
        }
        for (let i = 0; i < 4; i++) {
          b.color(0.8, 0.8, 0.8, 0);
          const s = b.r(1, 2);
          b.box(uc - 4 + b.r(0, 8), Yf, vc + sg * b.r(-1, 3), s * 1.3, s * 0.7, s, b.r(0, 3), { solid: true });
        }
        b.light(uc, Yf + 2, vRoom1, spec.vein ? 26 : 18, 0.9, TEAL);
        b.glow(uc, Yf + 2, vRoom1, spec.vein ? 7 : 4, [0.22, 0.7, 0.6]);
      }
    });
    void rp;
  });

  // ---- lamps left burning: the rim, down every flight, along the rubble slope, at the door
  g.roughNow = 0.1;
  b.lamp(uEnd - 2, yL + 1.8, vP - 3, { reach: 16, strength: 0.9 });
  b.lamp(uEnd - 2, yL + 1.8, vP + 3, { reach: 16, strength: 0.9 });
  b.lamp(uEnd + 1.5, yL + 0.6, vP + 2.4 * side, { reach: 16 });
  const trail = [26, 30, 40][tier];
  {
    const dir = Math.sign(faceS(uS0, 0) - vP) || 1;
    const vEnd = stairSide < 0 ? wLo(uS0) + 1.5 : wHi(uS0) - 1.5;
    for (let v = vP + dir * trail; (vEnd - v) * dir > 6; v += dir * trail) b.lamp(wNr(v) + 1.2, yL + 0.6, v, { reach: 14, strength: 0.7 });
    for (let u = uH0 + AN + 8; u < uS0 + offs - 4; u += trail) b.lamp(u, yL + 0.6, stairSide < 0 ? wLo(u) + 1.4 : wHi(u) - 1.4, { reach: 14, strength: 0.7 });
  }
  for (const f of flights) {
    const dir = Math.sign(f.ub - f.ua);
    const len = Math.abs(f.ub - f.ua);
    for (const t of tier === 2 ? [0.5] : len > 40 ? [0.05, 0.5, 0.95] : [0.1, 0.9]) {
      const u = f.ua + dir * len * t;
      b.lamp(u, f.y0 + (f.y1 - f.y0) * t + 0.62, faceS(u, f.k + 1) + (stairSide < 0 ? 0.45 : -0.45), { reach: 20 });
    }
  }
  for (let u = uR0 + 12; u < uR1; u += tier === 2 ? 80 : 50) {
    b.lamp(u, Math.max(S1end, yL - gu * (u - uR0)) + 1.4, edgeB(u) + (bSide < 0 ? 1 : -1) * 0.8, { reach: 16, strength: 0.8 });
  }
  b.lamp(uR1, S1end - gu * 14 + 1.4, edgeB(uR1) + (bSide < 0 ? 1 : -1) * 18, { reach: 16, strength: 0.8 });
  for (const s of [-1, 1]) {
    const bu = uF - 3.5;
    const bv = vMid + s * (doorW / 2 + 3.4);
    b.color(0.95, 0.95, 0.95, 0);
    b.cyl(bu, yD, bv, 0.7, 1.3, { solid: true });
    b.cyl(bu, yD + 1.3, bv, 0.75, 0.5, { top: 1.6 });
    b.lamp(bu, yD + 2.3, bv, { reach: 50, strength: 1.7, size: 2.6, body: false });
  }

  // ---- what was left behind
  jars(uEnd - 0.5, yL, vP + side * 5.5, Math.ceil(4 * [1, 0.6, 0.35][tier]));
  for (let i = 0; i < [12, 7, 4][tier]; i++) {
    const s = b.r(0.8, 2.6);
    const u = b.r(uL0, uF - 16);
    const v = b.r(vA + T * wL + 6, vB - T * wH - 6);
    const F = ground(u, v);
    if (!(F < Yf + 0.4)) continue;
    const ci = g.cell(u, v);
    if (ci < 0 || g.n[ci] === 0 || Math.abs(g.floorAt(u, v, Yf - 3) - F) > 0.4) continue;
    if (Math.abs(v - vMid) < courtHalf && u > uF - courtLen) continue;
    const k = b.r(0.8, 1);
    b.color(k, k, k, 0);
    b.box(u, F - s * 0.12, v, s * b.r(0.8, 1.4), s * b.r(0.5, 0.9), s, b.r(0, 3), { rx: b.r(-0.2, 0.2), rz: b.r(-0.2, 0.2), solid: s > 1.2 });
  }
  jars(uF - 2, yD, vMid + (doorW / 2 + 6) * (b.rng() < 0.5 ? -1 : 1), Math.ceil(5 * [1, 0.6, 0.35][tier]));
  if (spec.carvings) {
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const v = vMid + s * (doorW / 2 + 4.3 + i * 2.5) + b.r(-0.2, 0.2);
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
            const tall = b.rng() < 0.3;
            b.box(uF - 0.72, y, v + q * 0.36, 0.06, tall ? 0.3 : 0.07, tall ? 0.07 : b.r(0.14, 0.28));
          }
        }
      }
    }
  }

  for (const f of props) f();
  b.stone(uF + 34, yD, vMid, 0);
  L.ledge = [wNr(vP) + 1, yL, vP];
  L.centre = [uF + 1, yD, vMid];
  L.stone = [uF + 32.4, yD + 1.6, vMid];
  const built = b.finish({ ledge: [wNr(vP) + 1, yL, vP], centre: [uF + 1, yD, vMid], relic });
  L.relic = relic;
  built.extra.vault = L;
  return built;
}
