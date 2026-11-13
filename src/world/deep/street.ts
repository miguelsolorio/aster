// The carved street: a slot canyon far underground whose walls were cut into house fronts. The
// stair from the hole runs down a short dark passage to a slab in the canyon's end wall, right
// under the roof: the whole avenue lies ahead and sixty metres below, storey over storey of dark
// windows, bridges crossing at different heights, a gallery along one side, and pale daylight
// falling down a round well at the far end. Part way along the street widens into a square,
// and one side of the square is a door forty metres tall under a great carved mask.
//
// Laid out along u: hole, passage (two turns), end wall and ledge, the street in two or three
// straight pieces joined by bends of raw rock, the well. Across v the street sits to one side of
// the hole. Up and down everything is counted in storeys of five metres from the street floor:
// the ledge is the top storey, the walls lean in a cell at a time above the lower few.
//
// Ways up: a stairwell inside the facade by the ledge (ledge to street, with a door onto the
// gallery), one inside the facade at each higher or lower bridge, and small houses of two or
// three floors. All of it is decided by a generator of its own, so every tier builds the same
// street; only windows, trim, lamps and litter thin out.

import type { Uniforms } from '../../game/contract';
import type { DeepSpec } from './types';
import { DeepBuilder, TEAL, mulberry32, type BuiltDeep } from './builder';
import type { Pt } from './spans';

/** Height of a storey. Stairwell flights fall one storey in eight metres. */
const S = 5;

/** Where things ended up, in the deep's own frame: for checks and for whoever wants to point at them. */
export interface StreetPlan {
  ledge: Pt;
  centre: Pt;
  relic: Pt | null;
  /** The street floor just under the ledge and in the well at the far end. */
  floorEnds: [Pt, Pt];
  /** The middle of each bridge's deck. */
  bridges: Pt[];
  /** Points along the gallery's walkway. */
  gallery: Pt[];
  /** A point on the floor of each side alley's court. */
  alleys: Pt[];
  /** A point in each room that can be walked into. */
  rooms: Pt[];
  /** Street floor and slot roof; length of the street; which side (v sign) the great door is on. */
  floorY: number;
  roofY: number;
  length: number;
  doorSide: number;
  doorHeight: number;
}

export interface BuiltStreet extends BuiltDeep {
  readonly plan: StreetPlan;
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

interface Piece {
  a: number;
  b: number;
  /** Centre line and half-width at the street floor. */
  c: number;
  h: number;
  /** Half-width at each storey: the lean. */
  prof: Float32Array;
}

interface Tower {
  s: number;
  uA: number;
  kTop: number;
  /** The facade's plane at the street floor. */
  P0: number;
}

export function buildStreet(spec: DeepSpec, uniforms?: Uniforms): BuiltStreet {
  const tier = spec.tier;
  const lid = spec.lid;
  // the shape of the place comes from a generator of its own, so every tier builds the same street
  const rnd = mulberry32(Math.imul(spec.seed | 0, 0x9e3779b1) ^ 0x57ee7);
  const R = (a: number, b: number): number => a + (b - a) * rnd();
  const pick = <T,>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rnd() * xs.length))];
  const even = (x: number): number => Math.round(x / 2) * 2; // cell edges along u, at every tier
  const onV = (x: number): number => Math.round(x / 1.8) * 1.8; // and along v
  const ns = spec.seed | 0;
  const vnoise = (x: number): number => {
    const i = Math.floor(x);
    const f = smooth(x - i);
    return hash2(i + ns, 77) * (1 - f) + hash2(i + 1 + ns, 77) * f;
  };

  // ---- heights
  const N = 12 + (rnd() < 0.5 ? 1 : 0); // storeys
  const Yc = lid - 1.5; // the slot's roof
  const Yf = Math.floor((Yc - R(2.5, 4) - N * S) / 2.5) * 2.5; // the street (on the wall courses)
  const yTop = Yf + N * S; // top of the storeys; raw rock from here to the roof
  const lvl = (k: number): number => Yf + k * S;
  const kL = N - 1; // the ledge is the top storey
  const yL = lvl(kL);
  const yA = lid - 2.9; // foot of the stair down the hole (the builder's b.foot)

  // ---- along u
  const L1 = even(R(8, 12));
  const L3 = even(R(6, 10));
  const uT = 4 + L1 + 2; // middle of the passage's cross leg
  const uS0 = uT + 2 + L3; // the end wall
  const uE = Math.floor(Math.min(spec.u1 - 4, uS0 + R(262, 300)) / 2) * 2;
  const Rw = R(6, 7.5); // the well at the far end
  const uW = uE - 8;
  const L = uW - uS0;

  const nb = rnd() < 0.45 ? 1 : 2; // bends
  const fr = nb === 2 ? [R(0.17, 0.24), R(0.76, 0.83)] : [rnd() < 0.5 ? R(0.22, 0.3) : R(0.7, 0.78)];
  const sqPiece = nb === 2 ? 1 : fr[0] < 0.5 ? 1 : 0;
  const pieces: Piece[] = [];
  {
    const HS = [5.4, 7.2, 9];
    let a = uS0;
    let hi = Math.floor(rnd() * 3);
    let off = 0;
    let lastD = 0;
    for (let j = 0; j <= nb; j++) {
      let b2 = uW;
      let next = uW;
      if (j < nb) {
        const Lt = rnd() < 0.5 ? 16 : 20;
        const mid = even(uS0 + L * fr[j]);
        b2 = mid - Lt / 2;
        next = mid + Lt / 2;
      }
      pieces.push({ a, b: b2, c: off, h: HS[hi], prof: new Float32Array(N) });
      hi = (hi + 1 + Math.floor(rnd() * 2)) % 3;
      // (kinks small enough that the daylight at the far end still shows down the street from the ledge)
      const mag = pick([3.6, 5.4, 7.2]);
      const sign = lastD === 0 ? (rnd() < 0.5 ? -1 : 1) : rnd() < 0.8 ? -Math.sign(lastD) : Math.sign(lastD);
      lastD = sign * mag;
      off += lastD;
      a = next;
    }
  }
  const pieceAt = (u: number): number => {
    for (let j = 0; j < pieces.length; j++) if (u <= pieces[j].b + 1e-6) return j;
    return pieces.length - 1;
  };

  // ---- the square and the great door
  const SQ = 22; // half the square's length
  const hSq = 14.4; // how far the door's side stands back from the centre line
  const sp = pieces[sqPiece];
  let uD: number;
  {
    const lo = sp.a + SQ + 24;
    const hi = sp.b - SQ - 24;
    const want = (sp.a + sp.b) / 2 + R(-14, 14);
    uD = lo <= hi ? even(Math.min(hi, Math.max(lo, want))) : even((sp.a + sp.b) / 2);
  }
  const Dw = rnd() < 0.5 ? 10 : 12;
  const Dh = Math.round(R(35, 39) * 2) / 2;
  const yD = Yf + 3; // the threshold
  const yM0 = yD + Dh; // the door's head: the mask stands on it
  const kD = Math.min(N, Math.ceil((yM0 + 14.2 - Yf) / S)); // storeys the door's facade stands plumb
  const hallD = 27;

  // ---- which side: the door's, and the street's own side of the hole
  let dS = rnd() < 0.5 ? -1 : 1;
  const sg0 = rnd() < 0.5 ? -1 : 1;
  const Lv = onV(R(12.6, 19.8));
  const range = (d: number): [number, number] => {
    let lo = -Infinity;
    let hi = Infinity;
    pieces.forEach((p, j) => {
      for (const s of [-1, 1]) {
        let need = p.h + 11;
        if (j === sqPiece && s === d) need = Math.max(need, hSq + 5.4 + hallD + 2.5);
        if (s < 0) lo = Math.max(lo, spec.v0 + 1.2 + need - p.c);
        else hi = Math.min(hi, spec.v1 - 1.2 - need - p.c);
      }
    });
    return [Math.ceil(lo / 1.8 - 1e-6) * 1.8, Math.floor(hi / 1.8 + 1e-6) * 1.8];
  };
  let c0 = NaN;
  for (const d of [dS, -dS]) {
    const [lo, hi] = range(d);
    for (const sg of [sg0, -sg0]) {
      if (c0 === c0) break;
      if (sg * Lv >= lo - 1e-6 && sg * Lv <= hi + 1e-6) {
        c0 = sg * Lv;
        dS = d;
      }
    }
  }
  if (!(c0 === c0)) {
    const [lo, hi] = range(dS);
    c0 = Math.min(hi, Math.max(lo, sg0 * Lv));
  }
  for (const p of pieces) p.c += c0;
  const gS = -dS; // the gallery runs along the wall that faces the door
  const P = sp.c + dS * hSq; // the door's facade

  // ---- the lean: half-width at each storey
  const Q = tier === 2 ? 1.8 : 0.9;
  const hTop = rnd() < 0.5 ? 1.8 : 2.7; // half the slot at the roof
  const leanP = (k: number): number => 0.85 * Math.pow(Math.max(0, (k / N - 0.2) / 0.8), 1.5);
  for (const p of pieces) {
    for (let k = 0; k < N; k++) p.prof[k] = Math.max(hTop, p.h - Q * Math.round(((p.h - hTop) * leanP(k)) / Q));
  }
  const profDoor = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    profDoor[k] = k < kD ? hSq : Math.max(hTop, hSq - Q * Math.round(((hSq - hTop) * 0.85 * (k - kD + 1)) / (N - kD + 1) / Q));
  }

  // ---- levels of the things that cross
  const kG = 3 + Math.floor(rnd() * 3); // the gallery, and the bridge off it
  const kH = kG + 2 + (rnd() < 0.5 ? 1 : 0); // the high bridge
  const k3 = Math.max(2, kG - 1 - (rnd() < 0.5 ? 1 : 0)); // the low one, where there is a third
  const nBr = rnd() < 0.55 ? 3 : 2;
  const yG = lvl(kG);

  const b = new DeepBuilder(spec, uniforms, { cell: tier === 2 ? 2 : 1, yMin: Yf - 4, maxSpans: 10, wallStep: tier === 0 ? 2.5 : 5 });
  const g = b.grid;
  const cb = (u0: number, u1: number, va: number, vb: number, y0: number, y1: number): void =>
    g.carveBox(u0, Math.min(va, vb), u1, Math.max(va, vb), y0, y1);
  const fb = (u0: number, u1: number, va: number, vb: number, y0: number, y1: number): void =>
    g.fillBox(u0, Math.min(va, vb), u1, Math.max(va, vb), y0, y1);
  /**
   * A way cut through a wall that leans: where the storey below stops right under it (the
   * overhang's step) the cut would open into the street beneath, so its floor is put back.
   */
  const cbf = (u0: number, u1: number, va: number, vb: number, y0: number, y1: number): void => {
    cb(u0, u1, va, vb, y0, y1);
    if (y0 > Yf + 1) fb(u0, u1, va, vb, y0 - 0.7, y0);
  };

  // ---- the way in: stair, then a stepped passage with two turns in it, unlit
  b.holeStair();
  g.roughNow = 0.12;
  {
    const PH = 2.5;
    const sgn = Math.sign(c0) || 1;
    const r1 = uT - 2 - 4;
    const r2 = Math.abs(c0) - 3.6;
    const r3 = uS0 - (uT + 2);
    const sl = (yA - yL) / (r1 + r2 + r3);
    const y1 = yA - sl * r1;
    const y2 = y1 - sl * r2;
    g.carveRun([4, yA, 0], [uT - 2, y1, 0], 3.6, PH, { steps: true });
    cb(uT - 2, uT + 2, -1.8, 1.8, y1, y1 + PH);
    g.carveRun([uT, y1, sgn * 1.8], [uT, y2, c0 - sgn * 1.8], 4, PH, { steps: true });
    cb(uT - 2, uT + 2, c0 - 1.8, c0 + 1.8, y2, y2 + PH);
    g.carveRun([uT + 2, y2, c0], [uS0, yL, c0], 3.6, PH + 0.3, { steps: true });
  }

  // ---- the canyon's section at every column of cells
  const nuC = g.nu;
  const colC = new Float32Array(nuC).fill(NaN);
  const colH = new Float32Array(nuC * 2 * N);
  const col = (u: number): number => Math.floor((u - g.u0) / g.cu);
  for (let i = 0; i < nuC; i++) {
    const u = g.u0 + (i + 0.5) * g.cu;
    if (u < uS0 || u > uW) continue;
    const j = pieceAt(u);
    const p = pieces[j];
    if (u >= p.a) {
      colC[i] = p.c;
      const inSq = j === sqPiece && u > uD - SQ && u < uD + SQ;
      for (let k = 0; k < N; k++) {
        colH[i * 2 * N + k] = inSq && dS < 0 ? profDoor[k] : p.prof[k];
        colH[(i * 2 + 1) * N + k] = inSq && dS > 0 ? profDoor[k] : p.prof[k];
      }
    } else {
      // a bend: one piece's section easing into the next
      const q = pieces[j - 1];
      const t = smooth((u - q.b) / (p.a - q.b));
      colC[i] = q.c + (p.c - q.c) * t;
      for (let k = 0; k < N; k++) {
        const hw = q.prof[k] + (p.prof[k] - q.prof[k]) * t;
        colH[i * 2 * N + k] = hw;
        colH[(i * 2 + 1) * N + k] = hw;
      }
    }
  }
  const hwAt = (s: number, k: number, u: number): number => colH[(col(u) * 2 + (s < 0 ? 0 : 1)) * N + k];
  /** The facade of side s (v sign) at storey k over u. */
  const planeAt = (s: number, k: number, u: number): number => colC[col(u)] + s * hwAt(s, k, u);

  // ---- the street
  const pave = [b.paint(0.97, 0.95, 0.9, 0), b.paint(0.88, 0.86, 0.82, 0), b.paint(0.8, 0.78, 0.75, 0)];
  let cMin = Infinity;
  let cMax = -Infinity;
  for (const p of pieces) {
    cMin = Math.min(cMin, p.c);
    cMax = Math.max(cMax, p.c);
  }
  const cut = (u0: number, u1: number): void => {
    g.carveFn(u0, cMin - 16, u1, cMax + 16, (u, v, o) => {
      const i = col(u);
      const c = colC[i];
      if (!(c === c)) return false;
      const d = v - c;
      const ad = Math.abs(d);
      const base = (i * 2 + (d < 0 ? 0 : 1)) * N;
      if (ad >= colH[base]) return false;
      let k = 1;
      while (k < N && colH[base + k] > ad) k++;
      o.floor = Yf;
      o.ceil = k < N ? Yf + S * k : ad < hTop ? Yc - Math.round(vnoise(u / 7) * 3) * 0.5 : yTop;
      g.paintF = pave[Math.min(2, Math.floor(hash2(Math.floor(u / 2) + ns, Math.floor(v / 1.8)) * 3.4))];
      return true;
    });
  };
  pieces.forEach((p, j) => {
    g.roughNow = tier === 2 ? 0.1 : 0.07;
    cut(p.a, p.b);
    if (j > 0) {
      g.roughNow = 0.35;
      cut(pieces[j - 1].b, p.a);
    }
  });
  const last = pieces[pieces.length - 1];
  g.roughNow = 0.4;
  g.paintF = pave[1];
  g.carveCyl(uW, last.c, Rw, Yf, Yc);
  g.paintF = 0;

  // ---- the ledge: a slab from wall to wall under the passage's mouth
  g.roughNow = 0.05;
  fb(uS0, uS0 + 6, pieces[0].c - hwAt(-1, kL, uS0 + 0.5), pieces[0].c + hwAt(1, kL, uS0 + 0.5), yL - 1.5, yL);

  // ---- where things go along the street: claims on each side's wall
  const claims: [number, number][][] = [[], []];
  const sIdx = (s: number): number => (s < 0 ? 0 : 1);
  const isFree = (s: number, a: number, z: number): boolean => !claims[sIdx(s)].some(([x, y]) => a < y && z > x);
  const stretches: [number, number][] = pieces.map((p, j) => [p.a + 2, (j === pieces.length - 1 ? uW - Rw - 6 : p.b) - 2]);
  /** An even u where [u, u + len] lies in a straight piece and is free (with `gap` either end) on those sides. */
  const place = (sides: number[], len: number, gap: number, ok?: (u: number) => boolean): number => {
    const fits = (u: number, st: [number, number]): boolean =>
      u >= st[0] && u + len <= st[1] && sides.every((s) => isFree(s, u - gap, u + len + gap)) && (!ok || ok(u));
    let got = NaN;
    for (let tries = 0; tries < 40; tries++) {
      const st = stretches[Math.min(stretches.length - 1, Math.floor(rnd() * stretches.length))];
      const u = Math.ceil(R(st[0], Math.max(st[0], st[1] - len)) / 2) * 2;
      if (!(got === got) && fits(u, st)) got = u;
    }
    if (got === got) return got;
    for (const st of stretches) {
      for (let u = Math.ceil(st[0] / 2) * 2; u + len <= st[1]; u += 2) if (fits(u, st)) return u;
    }
    return NaN;
  };
  const claim = (sides: number[], a: number, z: number): void => {
    for (const s of sides) claims[sIdx(s)].push([a, z]);
  };
  claim([-1, 1], uS0, uS0 + 18);
  claim([dS], uD - SQ - 4, uD + SQ + 4);

  // ---- stairwells inside the facades: two lanes of flights, a landing at each end
  const landing = (t: Tower, k: number): [number, number] => ((t.kTop - k) % 2 === 0 ? [t.uA, t.uA + 2] : [t.uA + 10, t.uA + 12]);
  const cutTower = (t: Tower): void => {
    const { s, uA, kTop, P0 } = t;
    g.roughNow = 0.03;
    for (let k = kTop; k >= 0; k--) {
      const [la, lb] = landing(t, k);
      const y = lvl(k);
      cb(la, lb, P0 + s * 3.6, P0 + s * 9, y, y + 3);
      if (k > 0) {
        const fromA = (kTop - k) % 2 === 0;
        const lane = P0 + s * (fromA ? 4.5 : 8.1);
        g.carveRun([fromA ? uA + 2 : uA + 10, y, lane], [fromA ? uA + 10 : uA + 2, y - S, lane], 1.8, 3, { steps: true });
      }
    }
  };
  /** A way through the facade from a stairwell's landing at storey k. */
  const towerDoor = (t: Tower, k: number): void => {
    const [la, lb] = landing(t, k);
    g.roughNow = 0.03;
    cbf(la, lb, planeAt(t.s, k, la + 0.5), t.P0 + t.s * 3.6, lvl(k), lvl(k) + 3);
    noWin.push([t.s, la, lb]);
  };
  const towers: Tower[] = [];
  const noWin: [number, number, number][] = []; // side, u from, u to: where a way through the facade leaves no room for windows
  const roomPts: Pt[] = [];
  const roomLamps: Pt[] = [];

  // the first: beside the ledge, all the way down
  const t1: Tower = { s: gS, uA: uS0 + 2, kTop: kL, P0: planeAt(gS, 0, uS0 + 2.5) };
  towers.push(t1);
  cutTower(t1);
  towerDoor(t1, kL);
  towerDoor(t1, kG);
  towerDoor(t1, 0);

  // ---- bridges
  interface Bridge { u0: number; u1: number; k: number; tower: Tower | null; far: number }
  const bridges: Bridge[] = [];
  {
    claims[sIdx(gS)].push([uD - SQ - 4, uD + SQ + 4]); // no bridge across the square
    const sqClaim = claims[sIdx(gS)].length - 1;
    for (let i = 0; i < 3; i++) {
      const k = [kG, kH, k3][i];
      const wide = i === 0 || rnd() < 0.5;
      const ts = i === 0 ? gS : rnd() < 0.5 ? -1 : 1;
      const want = i < nBr;
      const u = want ? place([-1, 1], i === 0 ? 4 : 12, 8) : NaN;
      if (!(u === u)) continue;
      claim([-1, 1], u - 8, u + (i === 0 ? 4 : 12) + 8);
      const tower: Tower | null = i === 0 ? null : { s: ts, uA: u, kTop: k, P0: planeAt(ts, 0, u + 0.5) };
      bridges.push({ u0: u, u1: u + (wide ? 4 : 2), k, tower, far: -ts });
    }
    claims[sIdx(gS)].splice(sqClaim, 1);
  }
  // the gallery: from the first stairwell to past the bridge off it
  const uG0 = uS0;
  const uG1 = Math.min(uW - Rw - 4, Math.max(bridges.length > 0 ? bridges[0].u1 + 10 : 0, even(uS0 + L * R(0.5, 0.85))));

  // ---- houses: a stair of one or two storeys with a room at each floor
  interface House { t: Tower }
  const houses: House[] = [];
  {
    const nH = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < nH; i++) {
      const s = rnd() < 0.5 ? -1 : 1;
      const kTop = 1 + (rnd() < 0.5 ? 1 : 0);
      const u = place([s], 28, 3);
      if (!(u === u)) continue;
      claim([s], u - 3, u + 31);
      houses.push({ t: { s, uA: u + 8, kTop, P0: planeAt(s, 0, u + 8.5) } });
    }
  }

  // ---- side alleys: tall slots off the street, each ending in a small court
  interface Alley { s: number; ua: number; w: number; La: number; hA: number; P0: number }
  const alleys: Alley[] = [];
  {
    const roomOut = (s: number, u: number): number => {
      const p = pieces[pieceAt(u)];
      return s > 0 ? spec.v1 - 1.2 - (p.c + p.h) : p.c - p.h - (spec.v0 + 1.2);
    };
    const nA = 2 + (rnd() < 0.4 ? 1 : 0);
    for (let i = 0; i < nA + 2; i++) {
      // (two more goes if none has gone in: a seam needs somewhere to be)
      if (i >= nA && alleys.length > 0) break;
      const s = i >= nA ? (i === nA ? gS : dS) : rnd() < 0.5 ? -1 : 1;
      const w = rnd() < 0.5 ? 2 : 4;
      const want = onV(R(12.6, 21.6));
      const hA = R(8, 12);
      const u = place([s], w + 8, 3, (x) => roomOut(s, x + 4) >= 16.2);
      if (!(u === u)) continue;
      const La = Math.min(want, Math.floor((roomOut(s, u + 4) - 9) / 1.8 + 1e-6) * 1.8);
      claim([s], u - 3, u + w + 11);
      alleys.push({ s, ua: u + 4, w, La, hA, P0: planeAt(s, 0, u + 4.5) });
    }
  }

  // ---- cut all of that
  for (const br of bridges) {
    const y = lvl(br.k);
    const um = (br.u0 + br.u1) / 2;
    // the deck, thicker where it springs from the walls
    g.roughNow = 0.04;
    g.each(br.u0, cMin - 16, br.u1, cMax + 16, (ci, u, v) => {
      const i = col(u);
      const d = v - colC[i];
      const hw = colH[(i * 2 + (d < 0 ? 0 : 1)) * N + br.k];
      const ad = Math.abs(d);
      if (ad < hw) g.fillCell(ci, y - (hw - ad < 1.8 ? 2.4 : 1.2), y);
    });
    if (br.tower) {
      towers.push(br.tower);
      cutTower(br.tower);
      towerDoor(br.tower, br.k);
      towerDoor(br.tower, 0);
      if (br.tower.s === gS && br.k > kG && br.tower.uA >= uG0 && br.tower.uA + 12 <= uG1) towerDoor(br.tower, kG);
    }
    // a room in the wall it crosses to
    const fs = br.far;
    const P0 = planeAt(fs, 0, um);
    g.roughNow = 0.04;
    cbf(br.u0, br.u1, planeAt(fs, br.k, um), P0 + fs * 1.8, y, y + 3);
    noWin.push([fs, br.u0, br.u1]);
    cb(br.u0 - 2, br.u0 + 6, P0 + fs * 1.8, P0 + fs * 7.2, y, y + 3.2);
    roomPts.push([br.u0 + 2.5, y, P0 + fs * 4.5]);
    roomLamps.push([br.u0 + 5.4, y, P0 + fs * 6.6]);
  }

  {
    // the gallery: a walk cut into the wall, and a slab standing out from it
    g.roughNow = 0.04;
    const si = sIdx(gS);
    g.each(uG0, cMin - 16, uG1, cMax + 16, (ci, u, v) => {
      const i = col(u);
      const c = colC[i];
      if (!(c === c)) return;
      const d = gS * (v - c) - colH[(i * 2 + si) * N + kG];
      // (wider through a bend, where the wall shifts under it from one column to the next)
      const bend = !pieces.some((p) => u > p.a && u < p.b);
      if (d >= 0 && d < (bend ? 3.6 : 1.8)) {
        g.carveCell(ci, yG, yG + 3.2);
        g.fillCell(ci, yG - 0.7, yG);
      } else if (d < 0 && d >= -1.8) g.fillCell(ci, yG - 0.7, yG);
    });
  }

  for (const h of houses) {
    const t = h.t;
    const { s, P0 } = t;
    cutTower(t);
    g.roughNow = 0.04;
    for (let k = 0; k <= t.kTop; k++) {
      const [la] = landing(t, k);
      const r0 = la === t.uA ? t.uA - 8 : t.uA + 12;
      const y = lvl(k);
      cb(r0, r0 + 8, P0 + s * 1.8, P0 + s * 9, y, y + 3.2);
      if (k === 0) cb(r0 + 2, r0 + 4, P0, P0 + s * 1.8, y, y + 3);
      else for (const wu of [r0 + 2, r0 + 6]) cb(wu, wu + 2, planeAt(s, k, wu + 0.5), P0 + s * 1.8, y + 1.1, y + 2.9);
      roomPts.push([r0 + 4.5, y, P0 + s * 4.5]);
      roomLamps.push([la === t.uA ? r0 + 0.6 : r0 + 7.4, y, P0 + s * 8.4]);
    }
  }

  for (const a of alleys) {
    g.roughNow = 0.15;
    g.paintF = pave[2];
    cb(a.ua, a.ua + a.w, a.P0, a.P0 + a.s * a.La, Yf, Yf + a.hA);
    cb(a.ua - 4, a.ua + a.w + 4, a.P0 + a.s * a.La, a.P0 + a.s * (a.La + 7.2), Yf, Yf + 6);
    g.paintF = 0;
  }

  // ---- the great door: a podium and its steps, the door, the hall behind
  const podHalf = Dw / 2 + 6;
  g.roughNow = 0.03;
  g.paintF = pave[0];
  fb(uD - podHalf, uD + podHalf, P - dS * 5.4, P, Yf - 1, yD);
  g.roughNow = 0;
  g.fillRun([uD, Yf, P - dS * 12.6], [uD, yD, P - dS * 5.4], podHalf * 2, 4, { steps: true });
  g.roughNow = 0.05;
  cb(uD - Dw / 2, uD + Dw / 2, P, P + dS * 5.4, yD, yD + Dh);
  g.paintF = pave[1];
  const hallTop = yD + Math.min(Dh + 4, Yc - 4 - yD);
  cb(uD - 14, uD + 14, P + dS * 5.4, P + dS * (5.4 + hallD), yD, hallTop);
  g.paintF = 0;
  for (let i = 0; i < 3; i++) {
    for (const s of [-1, 1]) {
      const pv = P + dS * (9.9 + 7.2 * i);
      fb(uD + s * 7 - 1.2, uD + s * 7 + 1.2, pv - 1.2, pv + 1.2, yD - 1, hallTop + 1);
    }
  }

  // ---- rings cut into the facade about the mask, and the mask's own hollows
  const yR = yM0 + 8; // the rings' centre: between the eyes
  {
    g.roughNow = 0.03;
    const rings = tier === 2 ? [[13.6, 3], [19.6, 3]] : [[13.2, 2.6], [17.4, 2.6], [21.6, 2.6]];
    const yMax = Yf + S * kD - 0.6;
    const rowV = P + dS * g.cv * 0.5;
    for (let u = uD - SQ + g.cu / 2; u < uD + SQ; u += g.cu) {
      const ci = g.cell(u, rowV);
      if (ci < 0) continue;
      const du = Math.abs(u - uD);
      for (const [r, w] of rings) {
        const ro = r + w / 2;
        const ri = r - w / 2;
        if (du >= ro) continue;
        const yo = Math.sqrt(ro * ro - du * du);
        const yi = du < ri ? Math.sqrt(ri * ri - du * du) : 0;
        const arcs = yi > 0 ? [[yR + yi, yR + yo], [yR - yo, yR - yi]] : [[yR - yo, yR + yo]];
        for (const [lo, hi] of arcs) {
          const a = Math.max(lo, yD + 0.6);
          const z = Math.min(hi, yMax);
          if (z - a >= 0.5) g.carveCell(ci, a, z);
        }
      }
    }
    // eye sockets, deep; a mouth, shallow
    for (const s of [-1, 1]) cb(uD + s * 4 - 2, uD + s * 4 + 2, P, P + dS * 2.7, yM0 + 7, yM0 + 9.6);
    cb(uD - 2, uD + 2, P, P + dS * Q, yM0 + 3, yM0 + 4);
  }

  // ---- the facades: houses side by side, storey over storey of windows
  const frnd = mulberry32(Math.imul(spec.seed | 0, 0x85ebca6b) ^ 0xfaca1de);
  const litCand: number[] = []; // u, y, v of sills a lamp could stand on
  const balcCand: number[] = [];
  const dark = 0.9;
  const facade = (s: number, a: number, z: number): void => {
    let x = Math.ceil(a / 2) * 2;
    let bi = 0;
    while (x + 10 <= z) {
      const r0 = frnd();
      const r1 = frnd();
      const r2 = frnd();
      const r3 = frnd();
      const r4 = frnd();
      const r5 = frnd();
      const nBay = Math.min(2 + Math.floor(r0 * 4), Math.floor((z - x - 2) / 4));
      const wB = 2 + nBay * 4;
      const kTopB = N - 2 - Math.floor(r1 * 3);
      const tall = r2 < 0.4;
      const deep = tier === 2 || r3 < 0.3;
      const pat = Math.floor(r4 * 3);
      const kb = r5 < 0.5 ? 1 + Math.floor(r5 * 2 * Math.min(6, kTopB)) : -1; // a balcony's storey
      const hb = (x * 31 + (s > 0 ? 7 : 0)) | 0;
      // windows over one another on a plumb wall are so many levels of air in one cell: no more than seven
      const stack = new Map<number, number>();
      const stacked = (pk: number, dp: number, add: boolean): boolean => {
        let full = false;
        for (let d = g.cv / 2; d < dp; d += g.cv) {
          const key = Math.round((pk + s * d) / 0.45);
          const n = stack.get(key) ?? 0;
          if (n >= 7) full = true;
          if (add) stack.set(key, n + 1);
        }
        return full;
      };
      for (let k = 0; k <= kTopB; k++) {
        const pk = planeAt(s, k, x + 1.5);
        const y = lvl(k);
        const onGallery = s === gS && k === kG && x < uG1;
        // trim: a pilaster up the house's edge, a course under each storey's sills
        if (tier < 2 || bi % 2 === 0) {
          b.color(dark, dark, dark, 0);
          b.box(x + 1, y, pk - s * 0.2, 1.2, S, 0.5);
        }
        if (k > 0 && (tier < 2 || k % 2 === 0)) {
          const nSeg = Math.ceil(wB / [8, 12, 30][tier]);
          for (let q = 0; q < nSeg; q++) b.box(x + (wB * (q + 0.5)) / nSeg, y - 0.15, pk - s * 0.15, wB / nSeg, 0.3, 0.4);
        }
        if (onGallery) {
          // doorways off the walk
          if (tier < 2) for (let j = 0; j < nBay; j += 2) cbf(x + 2 + j * 4, x + 4 + j * 4, pk + s * 1.8, pk + s * 2.7, y, y + 2.6);
          continue;
        }
        if (hash2(hb, k * 13 + 5) < 0.07) continue; // a blank storey
        if (stacked(pk, 1.8, false)) continue;
        stacked(pk, deep || k === kb || k === 0 ? 1.8 : 0.9, true);
        const balc = k === kb && !(s === gS && k === kG);
        if (balc) {
          g.roughNow = 0.03;
          fb(x + 2, x + wB, pk - s * Q, pk, y - 0.5, y);
          balcCand.push(x + 2 + wB / 2, y, pk - s * Q * 0.5);
        }
        g.roughNow = 0.04;
        for (let j = 0; j < nBay; j++) {
          if (pat === 1 && (j + k) % 2 === 1) continue;
          if (pat === 2 && j % 3 === 2) continue;
          if (tier === 2 && j % 2 === 1 && pat !== 1) continue;
          const wu = x + 2 + j * 4;
          if (noWin.some((w) => w[0] === s && wu < w[2] + 2 && wu + 2 > w[1] - 2)) continue;
          const hj = hash2(hb + j * 17, k * 29 + 3);
          const doorway = balc || (k === 0 && hj < 0.35);
          const lo = doorway ? y : y + (tall ? 1.2 : 1.6);
          const hi = doorway ? y + 3 : y + (tall ? 3.8 : 3.2);
          const dp = doorway || deep ? 1.8 : 0.9;
          if (doorway) cbf(wu, wu + 2, pk, pk + s * dp, lo, hi);
          else cb(wu, wu + 2, pk, pk + s * dp, lo, hi);
          if (k <= 8 && !doorway) litCand.push(wu + 1, lo, pk + s * dp * 0.5);
          else if (k === 0) litCand.push(wu + 1, lo, pk + s * 0.9);
        }
      }
      x += wB;
      bi++;
    }
  };
  pieces.forEach((p, j) => {
    const a = p.a;
    const z = j === pieces.length - 1 ? uW - Rw - 2 : p.b;
    for (const s of [-1, 1]) {
      if (j === sqPiece && s === dS) {
        facade(s, a, uD - SQ);
        facade(s, uD + SQ, z);
      } else facade(s, a, z);
    }
  });

  // ---- daylight down the well at the far end
  g.roughNow = 0.4;
  b.skyShaft(uW, last.c, Rw - 1.2, 1);

  // ================================================================ dressing
  const few = [1, 0.6, 0.35][tier];
  const fbox = (u: number, y: number, proj: number, su: number, sy: number, rz = 0): void =>
    b.box(u, y, P - dS * (proj / 2 - 0.1), su, sy, proj + 0.2, 0, { rz });

  // ---- the mask, built out from the facade over the door
  b.color(1, 0.98, 0.94, 0);
  fbox(uD, yM0, 1.6, Dw + 6, 1.8); // the lintel
  fbox(uD, yM0 + 1.8, 0.9, 8, 1); // a lip
  fbox(uD, yM0 + 4.4, 2, 2.6, 1.8); // the nose, heavy at the foot
  fbox(uD, yM0 + 6.2, 1.3, 1.5, 3.8);
  for (const s of [-1, 1]) {
    fbox(uD + s * 4.3, yM0 + 5.3, 0.9, 4.4, 1.1, -s * 0.12); // cheek
    fbox(uD + s * 4.4, yM0 + 9.9, 1.9, 7.4, 1.4, s * 0.2); // brow, drawn down toward the nose
    fbox(uD + s * 8.3, yM0 + 3.4, 1, 1.4, 8.2); // the sides of the head
    fbox(uD + s * 4, yM0 + 6.6, 0.5, 4.6, 0.4); // a lid under each eye
  }
  fbox(uD, yM0 + 11.7, 1, 12.5, 1);
  fbox(uD, yM0 + 12.7, 1.3, 6, 1);
  b.color(0.92, 0.9, 0.86, 0);
  {
    // jambs, in drums so the light climbs them
    const n = Math.ceil(Dh / S);
    for (let i = 0; i < n; i++) {
      const y0 = yD + (Dh * i) / n;
      for (const s of [-1, 1]) {
        fbox(uD + s * (Dw / 2 + 1.1), y0, 1, 2, Dh / n);
        if (tier < 2) fbox(uD + s * (Dw / 2 + 3.2), y0, 0.45, 1.2, Dh / n);
      }
    }
  }

  // ---- light at the door: braziers on the podium, lamps inside to light the jambs, a glow on the mask
  for (const s of [-1, 1]) {
    const bu = uD + s * (Dw / 2 + 3.6);
    const bv = P - dS * 3;
    b.color(0.95, 0.95, 0.95, 0);
    b.cyl(bu, yD, bv, 0.7, 1.3, { solid: true });
    b.cyl(bu, yD + 1.3, bv, 0.75, 0.5, { top: 1.6 });
    b.lamp(bu, yD + 2.3, bv, { reach: 46, strength: 1.6, size: 2.6, body: false });
    b.lamp(uD + s * (Dw / 2 - 0.9), yD + 0.9, P + dS * 3.8, { reach: 30, strength: 1.4, size: 1.8 });
  }
  b.light(uD, yD + 11, P + dS * 4.6, 26, 0.9);
  if (tier < 2) b.light(uD, yD + 23, P + dS * 4.6, 24, 0.7);
  b.light(uD, yM0 + 1, P - dS * 7, 34, 1.1);

  // ---- the ledge, the stairwells, the bridges, the gallery
  const hl = hwAt(1, kL, uS0 + 0.5);
  b.lamp(uS0 + 5.2, yL + 0.5, pieces[0].c + Math.min(hl, hwAt(-1, kL, uS0 + 0.5)) - 0.5, { reach: 16, strength: 0.8 });
  b.lamp(uS0 + 5.2, yL + 0.5, pieces[0].c - Math.min(hl, hwAt(-1, kL, uS0 + 0.5)) + 0.5, { reach: 12, strength: 0.7 });
  for (const t of towers) {
    const every = [2, 2, 3][tier];
    for (let k = t.kTop; k >= 0; k--) {
      if ((t.kTop - k) % every !== 0 && k !== 0) continue;
      const [la] = landing(t, k);
      b.lamp(la + (la === t.uA ? 0.5 : 1.5), lvl(k) + 0.5, t.P0 + t.s * 8.5, { reach: 11, strength: 0.75 });
    }
    // and one at its foot, out in the street
    const [la] = landing(t, 0);
    b.lamp(la - 0.6, Yf + 0.5, t.P0 - t.s * 0.5, { reach: 15, strength: 0.9 });
  }
  const cloth = (i: number): void => {
    const q = i % 3;
    if (q === 0) b.color(0.62, 0.2, 0.15, 2);
    else if (q === 1) b.color(0.25, 0.34, 0.44, 2);
    else b.color(0.8, 0.6, 0.3, 2);
  };
  bridges.forEach((br, i) => {
    const y = lvl(br.k);
    const um = (br.u0 + br.u1) / 2;
    const c = colC[col(um)];
    const hn = hwAt(-1, br.k, um);
    const hp = hwAt(1, br.k, um);
    b.lamp(br.u1 - 0.4, y + 0.5, c + hp - 0.6, { reach: 17 });
    if (tier < 2) b.lamp(br.u0 + 0.4, y + 0.5, c - hn + 0.6, { reach: 17 });
    // cloth hung from its side, still there
    const nc = tier === 2 ? 1 : 2;
    for (let q = 0; q < nc; q++) {
      const len = b.r(3.5, 7);
      cloth(i + q + (ns & 3));
      const bv = c + (q === 0 ? -0.35 : 0.4) * Math.min(hn, hp) + b.r(-0.4, 0.4);
      b.box(q === 0 ? br.u0 - 0.06 : br.u1 + 0.06, y - 0.3 - len, bv, 0.07, len, b.r(1.2, 1.8));
      b.color(0.5, 0.42, 0.34, 2);
      b.box(q === 0 ? br.u0 - 0.1 : br.u1 + 0.1, y - 0.36, bv, 0.14, 0.12, 2.2);
    }
  });
  {
    // the gallery: posts along its edge, a lamp now and then
    const si = sIdx(gS);
    const lampGap = [32, 44, 70][tier];
    b.color(0.95, 0.94, 0.9, 0);
    for (let u = uG0 + 8.5; u < uG1 - 2; u += tier === 2 ? 16 : 8) {
      const i = col(u);
      const pk = colC[i] + gS * colH[(i * 2 + si) * N + kG];
      if (pieces.some((p) => u > p.a + 1 && u < p.b - 1)) b.box(u, yG, pk - gS * 0.45, 0.6, 3.2, 0.6, 0, { solid: true });
    }
    for (let u = uG0 + 20; u < uG1 - 2; u += lampGap) {
      const i = col(u);
      b.lamp(u, yG + 0.5, colC[i] + gS * (colH[(i * 2 + si) * N + kG] + 1.4), { reach: 14, strength: 0.75 });
    }
    b.lamp(uG1 - 1, yG + 0.5, planeAt(gS, kG, uG1 - 1) + gS * 1.3, { reach: 14, strength: 0.75 });
  }

  // ---- lamps left in windows and on balconies: a few, most of the street is dark
  {
    const nW = Math.min(litCand.length / 3, [18, 11, 5][tier]);
    const total = litCand.length / 3;
    for (let q = 0; q < nW; q++) {
      const i = Math.min(total - 1, Math.floor(((q + b.rng()) * total) / nW)) * 3;
      b.lamp(litCand[i], litCand[i + 1] + 0.5, litCand[i + 2], { reach: 11, strength: 0.75 });
    }
    const nB = Math.min(balcCand.length / 3, [7, 4, 2][tier]);
    const totB = balcCand.length / 3;
    for (let q = 0; q < nB; q++) {
      const i = Math.min(totB - 1, Math.floor(((q + b.rng()) * totB) / nB)) * 3;
      b.lamp(balcCand[i] + b.r(-1, 1), balcCand[i + 1] + 0.5, balcCand[i + 2], { reach: 13, strength: 0.8 });
    }
  }

  // ---- what was left behind
  const jar = (u: number, y: number, v: number, big = 1): void => {
    const r = b.r(0.24, 0.34) * big;
    const h = b.r(0.5, 0.75) * big;
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
  const jars = (u: number, y: number, v: number, n: number, spread = 1): void => {
    for (let i = 0; i < n; i++) jar(u + b.r(-spread, spread), y, v + b.r(-spread, spread));
  };
  const rug = (u: number, y: number, v: number, rot: number, size = 1): void => {
    if (b.rng() < 0.6) b.color(0.62, 0.2, 0.15, 2);
    else b.color(0.25, 0.34, 0.44, 2);
    b.box(u, y, v, 2.8 * size, 0.05, 1.7 * size, rot);
    b.color(0.85, 0.7, 0.45, 2);
    b.box(u, y + 0.05, v, 2.2 * size, 0.02, 1.1 * size, rot);
  };
  const crate = (u: number, y: number, v: number): void => {
    const k = b.r(0.7, 1);
    const sz = b.r(0.6, 1);
    b.color(0.55 * k, 0.4 * k, 0.26 * k, 2);
    b.box(u, y, v, sz, sz * b.r(0.7, 1), sz, b.r(0, 1.5));
  };
  // at the foot of the great door: a rug laid out, pots either side, more below the steps
  rug(uD + b.r(-1, 1), yD, P - dS * 2.6, b.r(-0.08, 0.08), 1.6);
  jars(uD - Dw / 2 - 1.2, yD, P - dS * 1.2, Math.ceil(4 * few), 0.8);
  jars(uD + Dw / 2 + 1.2, yD, P - dS * 1.2, Math.ceil(3 * few), 0.8);
  jar(uD - Dw / 2 + 1, yD, P + dS * 1.5, 1.7);
  jar(uD + Dw / 2 - 1.2, yD, P + dS * 2.2, 1.5);
  for (const s of [-1, 1]) {
    jars(uD + s * (podHalf + 1.6), Yf, P - dS * b.r(2, 9), Math.ceil(5 * few), 1.2);
    if (tier < 2) crate(uD + s * (podHalf + 2.5), Yf, P - dS * 1.2);
  }
  rug(uD + b.r(-4, 4), Yf, P - dS * 14.6, b.r(-0.2, 0.2), 1.2);
  // the ledge
  jars(uS0 + 1.2, yL, pieces[0].c + gS * -1.5, Math.ceil(3 * few), 0.6);
  // rooms
  roomLamps.forEach((p, i) => {
    if (tier === 2 && p[1] > Yf + 1 && i % 2 === 1) return;
    b.lamp(p[0], p[1] + 0.5, p[2], { reach: 12, strength: 0.8 });
  });
  roomPts.forEach((p) => {
    if (b.rng() < 0.75) rug(p[0] + b.r(-0.5, 0.5), p[1], p[2] + b.r(-0.4, 0.4), b.r(-0.3, 0.3));
    if (b.rng() < 0.4 + 0.5 * few) jars(p[0] + b.r(1.5, 2.5), p[1], p[2] + b.r(1.5, 2.2), Math.ceil(3 * few), 0.5);
    if (tier < 2 && b.rng() < 0.5) crate(p[0] - 2.4, p[1], p[2] + 1.6);
  });
  // along the street: jars and crates by doors, cloth out of a few windows
  for (const t of towers) {
    const [la] = landing(t, 0);
    if (b.rng() < 0.8) jars(la + 3.2, Yf, t.P0 - t.s * 0.9, Math.ceil(3 * few), 0.6);
    if (tier < 2 && b.rng() < 0.6) crate(la - 1.8, Yf, t.P0 - t.s * 0.8);
  }
  for (const h of houses) {
    const t = h.t;
    jars(t.uA + (b.rng() < 0.5 ? -9 : 21), Yf, t.P0 - t.s * 0.9, Math.ceil(3 * few), 0.6);
    if (tier < 2) crate(t.uA + 5, Yf, t.P0 - t.s * 0.8);
  }
  if (tier < 2) {
    for (let q = 0; q < 6 && q * 3 < balcCand.length; q++) {
      const i = Math.floor(b.rng() * (balcCand.length / 3)) * 3;
      cloth(q);
      const s = Math.sign(balcCand[i + 2] - colC[col(balcCand[i])]) || 1;
      const len = b.r(1.5, 3.2);
      b.box(balcCand[i] + b.r(-3, 3), balcCand[i + 1] - len + 0.3, balcCand[i + 2] - s * (Q * 0.5 + 0.06), b.r(1.2, 2), len, 0.06);
    }
  }
  // blocks fallen from the raw rock: in the bends and round the well, where no door is
  {
    const spots: [number, number][] = [];
    for (let j = 1; j < pieces.length; j++) spots.push([pieces[j - 1].b + 2, pieces[j].a - 2]);
    spots.push([uW - 3, uW + 3]);
    const n = [14, 8, 4][tier];
    for (let i = 0; i < n; i++) {
      const sp2 = spots[i % spots.length];
      const u = b.r(sp2[0], sp2[1]);
      const ci = col(u);
      const s = b.rng() < 0.5 ? -1 : 1;
      const well = i % spots.length === spots.length - 1;
      const sz = b.r(0.7, 2.2);
      const v = well ? last.c + s * b.r(3.2, Rw - 1.8) : colC[ci] + s * (colH[(ci * 2 + (s < 0 ? 0 : 1)) * N] - b.r(1.4, 2.6));
      const k = b.r(0.8, 1);
      b.color(k, k, k, 0);
      b.box(u, Yf - sz * 0.12, v, sz * b.r(0.8, 1.4), sz * b.r(0.5, 0.9), sz, b.r(0, 3), { rx: b.r(-0.2, 0.2), rz: b.r(-0.2, 0.2), solid: sz > 1.3 });
    }
  }

  // ---- alleys: a lamp in each court, and what was stacked there
  alleys.forEach((a, i) => {
    const cu2 = a.ua + a.w / 2;
    const cv2 = a.P0 + a.s * (a.La + 3.6);
    const seam = spec.vein && i === 0;
    if (!seam || tier === 0) b.lamp(a.ua + a.w + 3.2, Yf + 0.5, a.P0 + a.s * (a.La + 6.4), { reach: 14, strength: seam ? 0.5 : 0.85 });
    jars(a.ua - 2.6, Yf, cv2 + a.s * 1.5, Math.ceil(4 * few), 0.8);
    if (tier < 2) {
      crate(a.ua + a.w + 2, Yf, cv2 - a.s * 2);
      crate(a.ua + a.w + 3, Yf, cv2 - a.s * 0.6);
    }
    if (seam) {
      // a seam of glowing mineral up the alley's wall and across the back of its court
      const n = [18, 14, 9][tier];
      for (let q = 0; q < n; q++) {
        const t = (q + b.rng() * 0.6) / n;
        const k = b.r(0.65, 1.1);
        b.color(k, k, k, 4);
        b.cone(a.ua + 0.05, Yf + 0.4 + Math.min(a.hA - 3, 5) * Math.sin(t * Math.PI) * b.r(0.7, 1), a.P0 + a.s * (2 + (a.La - 2.5) * t), b.r(0.22, 0.5), b.r(0.7, 1.9), { rz: -b.r(0.5, 1.1), rx: b.r(-0.5, 0.5), sides: 4 });
      }
      const back = a.P0 + a.s * (a.La + 7.1);
      for (let q = 0; q < Math.ceil(9 * few) + 3; q++) {
        const k = b.r(0.6, 1.05);
        b.color(k, k, k, 4);
        b.cone(cu2 + b.r(-4, 4), Yf + b.r(0, 2.6), back, b.r(0.2, 0.45), b.r(0.6, 1.7), { rx: -a.s * b.r(0.4, 1.1), rz: b.r(-0.4, 0.4), sides: 4 });
      }
      b.light(cu2, Yf + 2.5, cv2 + a.s * 1.5, 18, 0.6, TEAL);
      b.light(a.ua + a.w / 2, Yf + 3, a.P0 + a.s * a.La * 0.5, 14, 0.4, TEAL);
      b.glow(cu2, Yf + 2, back - a.s * 0.4, 6, [0.22, 0.7, 0.6]);
      for (const t of [0.25, 0.6, 0.9]) b.glow(a.ua + 0.4, Yf + 1 + 3 * Math.sin(t * Math.PI), a.P0 + a.s * (2 + (a.La - 2.5) * t), 2, [0.22, 0.7, 0.6]);
    }
  });

  // ---- carved slabs stood either side of the door, their marks still holding a little light
  if (spec.carvings) {
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const u = uD + s * (Dw / 2 + 5 + i * 2.8) + b.r(-0.15, 0.15);
        const y0 = i === 0 ? yD : Yf;
        const h = b.r(2.8, 3.8);
        const k = b.r(0.85, 1);
        b.color(k, k * 0.98, k * 0.94, 0);
        b.box(u, y0 - 0.2, P - dS * 0.42, b.r(1.3, 1.7), h, 0.55, b.r(-0.06, 0.06), { rx: b.r(-0.04, 0.04) });
        b.color(0.42, 0.42, 0.42, 4);
        for (let row = 0; row < 6; row++) {
          const y = y0 + 0.5 + row * 0.42;
          if (y > y0 + h - 0.9) break;
          for (let q = -1; q <= 1; q++) {
            if (b.rng() < 0.3) continue;
            const tallM = b.rng() < 0.3;
            b.box(u + q * 0.36, y, P - dS * 0.73, tallM ? 0.07 : b.r(0.14, 0.28), tallM ? 0.3 : 0.07, 0.06);
          }
        }
      }
    }
  }

  // ---- the hall behind the door: dark, a stone at its far end, the relic on it
  const ru = uD;
  const rv = P + dS * (5.4 + hallD - 7);
  b.color(0.9, 0.88, 0.84, 0);
  b.box(ru, yD, rv, 2.2, 0.4, 2.2, 0, { solid: true });
  b.cyl(ru, yD + 0.4, rv, 0.62, 0.75);
  b.cyl(ru, yD + 1.15, rv, 0.48, 0.14);
  const relic: Pt | null = spec.relic ? [ru, yD + 1.6, rv] : null;
  // the waking stone, against the end wall of the hall, facing the door
  b.stone(ru, yD, P + dS * (5.4 + hallD - 1.6), (-dS * Math.PI) / 2);
  jars(uD - 10, yD, P + dS * 8, Math.ceil(3 * few), 1);
  jars(uD + 11, yD, P + dS * (hallD - 2), Math.ceil(3 * few), 1);

  // ---- hand over
  const ledge: Pt = [uS0 + 1.5, yL, pieces[0].c];
  const centre: Pt = [uD, yD, P + dS * 0.9];
  const galleryPts: Pt[] = [];
  for (const t of [0.02, 0.3, 0.6, 0.98]) {
    const u = uG0 + 1 + (uG1 - uG0 - 2) * t;
    galleryPts.push([u, yG, planeAt(gS, kG, u) + gS * 0.6]);
  }
  const plan: StreetPlan = {
    ledge,
    centre,
    relic,
    floorEnds: [[uS0 + 9, Yf, pieces[0].c], [uW + 0.3, Yf, last.c + 0.3]],
    bridges: bridges.map((br) => [(br.u0 + br.u1) / 2 + 0.5, lvl(br.k), colC[col((br.u0 + br.u1) / 2)] + 0.3] as Pt),
    gallery: galleryPts,
    alleys: alleys.map((a) => [a.ua + a.w / 2 + 0.3, Yf, a.P0 + a.s * (a.La + 3.3)] as Pt),
    rooms: roomPts,
    floorY: Yf,
    roofY: Yc,
    length: uE - uS0,
    doorSide: dS,
    doorHeight: Dh,
  };
  return Object.assign(b.finish({ ledge, centre, relic }), { plan });
}
