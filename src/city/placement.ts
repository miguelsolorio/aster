import type { SurfaceSample } from '../game/contract';
import type { CityKind, CitySite } from './types';
import { CITY_REACH_EXTRA } from './cityGlsl';
import { avenueBearings } from './plan';
import { WORLD_SCALE } from '../world/scale';

/** One city per cell, so neighbours are 6 to 9 km apart on average. */
export const CITY_CELL = 10000 * WORLD_SCALE;

type BaseSample = (x: number, z: number, out: SurfaceSample) => SurfaceSample;

function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Result of blending a point against a city site. */
export interface CityBlend {
  flatten: number; // 0 = untouched desert .. 1 = on the plateau
  paved: number; // 0..1, the built area
  ground: number; // plateau height
  h: number; // the height of the ground there, city and surroundings included
  rock: number; // rock mask the city adds (the cliffs and buttes around a canyon town)
}

/** The ways out of a city, as the shaders see them (uCityC), rounded to float32. */
export interface CityWays {
  t1: number; // track bearings
  t2: number;
  aveA: number; // packed avenues, see cityAveLat in cityGlsl.ts
  aveB: number;
}

/** A 2D noise of world metres (the terrain's own gradient noise with the city key). */
export type CityNoise = (x: number, y: number) => number;

const TAU = 6.283185307;
const PI = 3.141592654;
const f32 = Math.fround;
const wrapPi = (a: number): number => {
  const b = a + PI;
  return b - TAU * Math.floor(b / TAU) - PI;
};

/** Packs avenue bearings into two float32-exact numbers for uCityC.zw (see cityAveLat). */
export function packAvenues(bearings: number[]): [number, number] {
  const n = Math.min(6, bearings.length);
  if (n === 0) return [0, 0];
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < n; k++) {
    const a = bearings[k] - (TAU * k) / n;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  let base = Math.atan2(sy, sx);
  // centre the offsets on their mid-range, so the step (and the rounding error) is as small as can be
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < n; k++) {
    const o = wrapPi(bearings[k] - (TAU * k) / n - base);
    lo = Math.min(lo, o);
    hi = Math.max(hi, o);
  }
  base += (lo + hi) / 2;
  base -= TAU * Math.floor(base / TAU);
  if (base >= TAU) base = 0;
  let maxOff = 0;
  const off: number[] = [];
  for (let k = 0; k < n; k++) {
    const o = wrapPi(bearings[k] - (TAU * k) / n - base);
    off.push(o);
    maxOff = Math.max(maxOff, Math.abs(o));
  }
  const s = Math.min(15, Math.max(0, Math.ceil(maxOff / 7.5 / 0.008) - 1));
  const st = 0.008 * (s + 1);
  let code = 0;
  for (let k = 0; k < n; k++) {
    const q = Math.min(15, Math.max(0, Math.round(off[k] / st + 7.5)));
    code += q * 2 ** (4 * k);
  }
  return [f32(64 * s + 8 * n + base), code];
}

/** Lateral distance in metres to the nearest avenue. Twin of cityAveLat. */
function aveLat(ang: number, dist: number, A: number, B: number): number {
  const s = Math.floor(A / 64);
  const rem = A - s * 64;
  const n = Math.floor(rem / 8);
  const base = rem - n * 8;
  const st = 0.008 * (s + 1);
  let best = 1e6;
  for (let k = 0; k < 6; k++) {
    if (k >= n) break;
    const q = Math.floor(B / 2 ** (4 * k)) % 16;
    const a = base + (TAU * k) / n + (q - 7.5) * st;
    best = Math.min(best, Math.abs(wrapPi(ang - a)));
  }
  return best * dist;
}

/** TypeScript twin of cityBlend in cityGlsl.ts. base = the raw desert height at (x, z). */
export function cityBlendAt(
  site: CitySite,
  ways: CityWays,
  x: number,
  z: number,
  base: number,
  nz: CityNoise,
  out: CityBlend,
): CityBlend {
  const dx = x - site.cx;
  const dz = z - site.cz;
  const dist = Math.hypot(dx, dz);
  const F = site.falloff;
  const g = site.groundY;
  out.flatten = 0;
  out.paved = 0;
  out.ground = g;
  out.h = base;
  out.rock = 0;
  if (dist > site.radius * 1.2 + F + CITY_REACH_EXTRA) return out;
  const ang = Math.atan2(dz, dx);
  const p1 = f32(site.phase1);
  const p2 = f32(site.phase2);
  const edge = site.radius * (1 + 0.1 * Math.sin(3 * ang + site.phase1) + 0.06 * Math.sin(5 * ang + site.phase2));
  const m = 1 - smoothstep(edge, edge + F, dist);
  out.flatten = m;
  out.paved = 1 - smoothstep(edge - 10, edge, dist);
  let h = base + (g - base) * m;
  let rock = 0;
  const t = dist - edge;
  if (t > 0) {
    const tr = Math.min(Math.abs(wrapPi(ang - ways.t1)), Math.abs(wrapPi(ang - ways.t2)));
    const av = aveLat(ang, dist, ways.aveA, ways.aveB);
    if (site.kind === 'hill') {
      if (t < F) {
        const u = t / F;
        const k0 = p1 * 1.37;
        const N = 4 + Math.floor((k0 - Math.floor(k0)) * 4);
        const uw = u + 0.0584 * Math.sin(9.424778 * u) * Math.sin(2 * ang + p2) + 0.0191 * Math.sin(15.70796 * u) * Math.cos(3 * ang + p1);
        const k = uw * N;
        const kf = Math.floor(k);
        const fr = k - kf;
        const st = (kf + smoothstep(0.9, 1, fr)) / N;
        const ht = g - 24 * st + (base - (g - 24 * st)) * (st * st * st);
        const ramp = Math.max(1 - smoothstep(0.16, 0.28, tr), 1 - smoothstep(16, 34, av));
        h = ht + (h - ht) * ramp;
      }
    } else if (site.kind === 'canyon') {
      const gap = Math.min(smoothstep(0.2, 0.32, tr), smoothstep(20, 45, av));
      const band = smoothstep(4, 30, t) * (1 - smoothstep(F + 40, F + 140, t));
      if (gap * band > 0) {
        const wall = 1 - smoothstep(40, 120, t);
        const v = nz(dx * (1 / 85) + p1 * 3, dz * (1 / 85) + p2 * 3) + 0.45 * wall - 0.1;
        const s = smoothstep(0.06, 0.14, v) * band * gap;
        const top = g + 20 + 40 * smoothstep(0.14, 0.6, v);
        h = h + (Math.max(h, top) - h) * s;
        rock = smoothstep(0, 0.3, s);
      }
    } else if (site.kind === 'oasis') {
      const sw = (dx * 0.7648 + dz * 0.6442) / dist;
      const cr = 350 + 70 * Math.sin(2 * ang + p1) + 30 * Math.sin(5 * ang + p2);
      const xx = t - cr;
      const prof = xx < 0 ? smoothstep(-(140 + 60 * sw), 0, xx) : 1 - smoothstep(0, 170 - 90 * sw, xx);
      const H = (25 + 10 * Math.sin(3 * ang + p2 + 1)) * (1 - 0.75 * (1 - smoothstep(0.06, 0.3, tr)));
      h += H * prof;
    } else {
      const rim = smoothstep(25, 70, t) * (1 - smoothstep(90, 170, t)) * Math.min(smoothstep(0.1, 0.2, tr), smoothstep(12, 28, av));
      h += 1.2 * rim;
    }
  }
  out.h = h;
  out.rock = rock;
  return out;
}

/** Finds the city of any grid cell, deterministically from the world seed and the raw terrain. */
export class CityIndex {
  private cache = new Map<string, CitySite>();
  private s: SurfaceSample = { h: 0, rock: 0, salt: 0 };

  constructor(
    private seed: number,
    private base: BaseSample,
  ) {}

  /** The site whose cell contains (x, z). A city only ever reshapes ground inside its own cell. */
  at(x: number, z: number): CitySite {
    return this.cell(Math.floor(x / CITY_CELL), Math.floor(z / CITY_CELL));
  }

  cell(ci: number, cj: number): CitySite {
    const key = ci + ',' + cj;
    let site = this.cache.get(key);
    if (site) return site;
    const h0 = hash(ci, cj, this.seed);
    const r = (n: number) => hash(h0, n, 0x51ed) / 4294967296;
    // Keep the centre in the middle 52% of the cell so the plateau and its slopes never cross a border.
    const cx = (ci + 0.24 + 0.52 * r(1)) * CITY_CELL;
    const cz = (cj + 0.24 + 0.52 * r(2)) * CITY_CELL;
    const radius = 320 + 280 * r(3);

    // Read the raw terrain around the centre to decide what kind of place this is.
    let sum = 0;
    let min = Infinity;
    let rock = 0;
    let salt = 0;
    const N = 12;
    for (let k = 0; k <= N; k++) {
      const a = (k / N) * Math.PI * 2;
      const rr = k === N ? 0 : radius * 0.6;
      const sm = this.base(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, this.s);
      sum += sm.h;
      min = Math.min(min, sm.h);
      rock += sm.rock;
      salt += sm.salt;
    }
    const avg = sum / (N + 1);
    rock /= N + 1;
    salt /= N + 1;

    let kind: CityKind;
    let groundY: number;
    let falloff: number;
    if (rock > 0.45) {
      kind = 'canyon';
      groundY = min + 6;
      falloff = 190;
    } else if (salt > 0.45) {
      kind = 'trade';
      groundY = avg + 0.5;
      falloff = 240;
    } else if (r(4) < 0.5) {
      kind = 'hill';
      groundY = avg + 24;
      falloff = 300;
    } else {
      kind = 'oasis';
      groundY = min - 2;
      falloff = 320;
    }

    site = {
      id: h0,
      seed: hash(h0, 99, this.seed),
      cx,
      cz,
      radius,
      groundY,
      kind,
      rot: r(5) * Math.PI * 2,
      phase1: r(6) * Math.PI * 2,
      phase2: r(7) * Math.PI * 2,
      falloff,
      aveA: 0,
      aveB: 0,
    };
    [site.aveA, site.aveB] = packAvenues(avenueBearings(site));
    this.cache.set(key, site);
    return site;
  }

  private waysCache = new Map<number, CityWays>();
  /**
   * The ways out of a site: bearings toward its two nearest neighbours (as Cities.tracks gives the
   * shaders) and its packed avenues, rounded to float32 like the uniforms.
   */
  ways(site: CitySite): CityWays {
    let w = this.waysCache.get(site.id);
    if (!w) {
      const n = this.near(site.cx, site.cz, []);
      w = {
        t1: f32(Math.atan2(n[1].cz - site.cz, n[1].cx - site.cx)),
        t2: f32(Math.atan2(n[2].cz - site.cz, n[2].cx - site.cx)),
        aveA: f32(site.aveA),
        aveB: f32(site.aveB),
      };
      this.waysCache.set(site.id, w);
    }
    return w;
  }

  /** The sites of the 3x3 cells around a point, nearest first. */
  near(x: number, z: number, out: CitySite[] = []): CitySite[] {
    const ci = Math.floor(x / CITY_CELL);
    const cj = Math.floor(z / CITY_CELL);
    out.length = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) out.push(this.cell(ci + i, cj + j));
    out.sort((a, b) => Math.hypot(a.cx - x, a.cz - z) - Math.hypot(b.cx - x, b.cz - z));
    return out;
  }
}
