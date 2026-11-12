import type { SurfaceSample } from '../game/contract';
import type { CityKind, CitySite } from './types';

/** One city per cell, so neighbours are 8 to 12 km apart on average. */
export const CITY_CELL = 10000;

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
}

/** TypeScript twin of cityBlend in cityGlsl.ts. */
export function cityBlendAt(site: CitySite, x: number, z: number, out: CityBlend): CityBlend {
  const dx = x - site.cx;
  const dz = z - site.cz;
  const dist = Math.hypot(dx, dz);
  out.flatten = 0;
  out.paved = 0;
  out.ground = site.groundY;
  if (dist > site.radius * 1.2 + site.falloff) return out;
  const ang = Math.atan2(dz, dx);
  const edge = site.radius * (1 + 0.1 * Math.sin(3 * ang + site.phase1) + 0.06 * Math.sin(5 * ang + site.phase2));
  out.flatten = 1 - smoothstep(edge, edge + site.falloff, dist);
  out.paved = 1 - smoothstep(edge - 10, edge, dist);
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
    // Keep the centre in the middle 56% of the cell so the plateau and its slopes never cross a border.
    const cx = (ci + 0.22 + 0.56 * r(1)) * CITY_CELL;
    const cz = (cj + 0.22 + 0.56 * r(2)) * CITY_CELL;
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
    };
    this.cache.set(key, site);
    return site;
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
