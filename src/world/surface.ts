// The terrain function, written twice: once in GLSL (SURFACE_GLSL, used by the
// clipmap vertex shader and the heightmap bake) and once in TypeScript
// (createWorld, used by the player and props). Both sides use the same integer
// lattice hash, so the gradient choices are bit-identical; the remaining float
// arithmetic differs only by float32 vs float64 rounding (well under 1 mm).
//
// Every constant below is emitted into the GLSL source, so tune them here.
import type * as THREE from 'three';
import type { SurfaceSample, World } from '../game/contract';
import { CITY_SHAPE_GLSL, CITY_SITES_GLSL } from '../city/cityGlsl';
import { CITY_CELL, CityIndex, cellHash, cityBlendAt, type CityBlend } from '../city/placement';
import { WORLD_SCALE } from './scale';

// ---------------------------------------------------------------- tuning

export const TERRAIN = {
  // Regions. Noise inputs are in kilometres; values are wavelengths in km.
  mtnRegionKmX: 9 * WORLD_SCALE, // mountain-range mask, stretched so ranges run roughly along z
  mtnRegionKmZ: 6 * WORLD_SCALE,
  mtnLo: 0.06, // mask noise value where mountains start rising
  mtnHi: 0.38, // mask noise value where mountains reach full height
  mtnMin: 150, // peak height of the weakest ranges (m)
  mtnMax: 450, // peak height of the strongest ranges (m)
  ridgeKm: 1.5, // base wavelength of the ridged multifractal
  ridgeOctaves: 6,
  terraceStep: 32, // mesa step height (m)
  terraceLo: 0.15, // dune-region noise value where mesas start replacing ridges
  terraceHi: 0.45,
  rockLo: 22, // mountain height (m) where bare rock starts showing through the sand
  rockHi: 60,
  duneRegionKm: 5 * WORLD_SCALE, // dune seas vs. rippled flats
  flatLo: -0.25, // region noise below this: flats
  flatHi: 0.1, // region noise above this: full dune sea
  flatAmp: 0.2, // dune amplitude on the flats
  saltRegionKm: 3.6 * WORLD_SCALE,
  panEdgeLo: 0.26, // dunes start fading out
  panEdgeHi: 0.42,
  saltLo: 0.36, // salt crust starts
  saltHi: 0.48,
  panSwell: 0.15, // fraction of the broad swell kept on a pan (keeps it nearly flat)
  panDrop: -2, // pans sit slightly lower (m)
  // Dunes (from the gallery height function).
  warpM: 38, // domain warp amplitude (m)
  warpKm: 0.25,
  bigAmp: 30,
  midAmp: 7,
  swellAmp: 30,
  swellKm: 0.667,
  // Passes: ranges open along the straight lines between cities in edge-adjacent cells.
  passLo: 140, // metres from the line that are fully clear
  passHi: 420, // metres from the line where the range is back to full height
  passWobble: 70, // how far the pass edge wanders (m)
  passNear: 450, // passes fade in between these distances from a city centre, so the
  passFar: 900, //   ground a city reads to decide what kind of place it is stays untouched
  // Massifs: lone snow-capped peaks at the corners between city cells. A corner is at least
  // 1.8 km from every line between edge-adjacent cities, so keep radius + jitter under that.
  massifP: 0.7, // chance a corner has one
  massifJitter: 140, // centre offset from the corner, each axis (m)
  massifRMin: 1400, // base radius (m); height grows with it so the slope stays the same
  massifRMax: 1600,
  massifHMin: 830, // cone height (m); the rounded summit ends up about 6% lower
  massifHMax: 960,
  massifPow: 1.35, // flank profile: above 1 is concave, like a volcano
  massifGully: 30, // depth of the erosion gullies (m)
  massifLedge: 18, // bench height (m)
  snowLine: 560, // snow settles above this height (m)
} as const;

/** Tallest ground the terrain can produce (m); shadows stop marching above it. */
export const MAX_TERRAIN_H = 1000;

/** A lone peak: centre, base radius and cone height in metres. */
export interface Massif {
  x: number;
  z: number;
  r: number;
  h: number;
}

// ---------------------------------------------------------------- shared hash

const T = TERRAIN;
/** GLSL float literal. */
const F = (n: number): string => {
  const s = String(n);
  return /[.e]/.test(s) ? s : s + '.0';
};
/** Per-channel key offsets: K * golden ratio, wrapped to uint32. */
const KOFF = (k: number): number => Math.imul(k, 0x9e3779b9) >>> 0;
const K_MTN = 1;
const K_DUNE = 2;
const K_SALT = 3;
const K_WX = 4;
const K_WZ = 5;
const K_BIG = 6;
const K_MID = 7;
const K_SWELL = 8;
const K_RIDGE = 9; // .. 9 + octaves - 1
const K_CITY = 20; // buttes around canyon cities
const K_MASSIF = 30; // .. 32
const MASSIF_SALT = 0x3a55;
const MASSIF_P = Math.round(TERRAIN.massifP * 1024);
const SEED_SALT = 0x5bd1e995;

const R2 = Math.fround(Math.SQRT1_2);
const GX = new Float64Array([1, -1, 0, 0, R2, -R2, R2, -R2]);
const GY = new Float64Array([0, 0, 1, -1, R2, R2, -R2, -R2]);
const NSCALE = Math.fround(Math.SQRT2);

function mix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function grad(key: number, ix: number, iy: number, fx: number, fy: number): number {
  const h = mix32(Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ key) & 7;
  return GX[h] * fx + GY[h] * fy;
}

/** 2D Perlin gradient noise, roughly -1..1. */
function noise(px: number, py: number, key: number): number {
  px = Math.fround(px);
  py = Math.fround(py);
  const ix0 = Math.floor(px);
  const iy0 = Math.floor(py);
  const fx = px - ix0;
  const fy = py - iy0;
  const ix = ix0 | 0;
  const iy = iy0 | 0;
  const a = grad(key, ix, iy, fx, fy);
  const b = grad(key, ix + 1, iy, fx - 1, fy);
  const c = grad(key, ix, iy + 1, fx, fy - 1);
  const d = grad(key, ix + 1, iy + 1, fx - 1, fy - 1);
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const ab = a + ux * (b - a);
  const cd = c + ux * (d - c);
  return (ab + uy * (cd - ab)) * NSCALE;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- GLSL

export const SURFACE_GLSL = /* glsl */ `
uniform float uSeed;

const vec2 SF_G[8] = vec2[8](
  vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0),
  vec2(${F(R2)}, ${F(R2)}), vec2(${F(-R2)}, ${F(R2)}),
  vec2(${F(R2)}, ${F(-R2)}), vec2(${F(-R2)}, ${F(-R2)}));

uint sfMix(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

float sfGrad(uint key, int ix, int iy, float fx, float fy) {
  uint h = sfMix((uint(ix) * 0x8da6b343u) ^ (uint(iy) * 0xd8163841u) ^ key) & 7u;
  vec2 g = SF_G[int(h)];
  return g.x * fx + g.y * fy;
}

float sfNoise(vec2 p, uint key) {
  vec2 i = floor(p);
  vec2 f = p - i;
  int ix = int(i.x);
  int iy = int(i.y);
  float a = sfGrad(key, ix, iy, f.x, f.y);
  float b = sfGrad(key, ix + 1, iy, f.x - 1.0, f.y);
  float c = sfGrad(key, ix, iy + 1, f.x, f.y - 1.0);
  float d = sfGrad(key, ix + 1, iy + 1, f.x - 1.0, f.y - 1.0);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float ab = a + u.x * (b - a);
  float cd = c + u.x * (d - c);
  return (ab + u.y * (cd - ab)) * ${F(NSCALE)};
}

// Integer hash of a grid cell (matches cellHash in placement.ts).
uint sfCell(uint a, uint b, uint c) {
  uint h = (a * 0x9e3779b1u) ^ (b * 0x85ebca6bu) ^ (c * 0xc2b2ae35u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  return h ^ (h >> 15u);
}

// Centre of the city in a cell (matches CityIndex.cell).
vec2 sfCity(ivec2 c) {
  uint h0 = sfCell(uint(c.x), uint(c.y), uint(int(uSeed)));
  vec2 r = vec2(float(sfCell(h0, 1u, 0x51edu)), float(sfCell(h0, 2u, 0x51edu))) * ${F(1 / 4294967296)};
  return (vec2(c) + 0.24 + 0.52 * r) * ${F(CITY_CELL)};
}

// The raw desert: (height m, rock 0..1, salt 0..1). About 13 noise evaluations, 16 on a massif.
vec3 surfaceBase(vec2 p) {
  uint sk = sfMix(uint(int(uSeed)) ^ ${SEED_SALT >>> 0}u);
  vec2 q = p * 0.001; // kilometres

  // regions
  float rM = sfNoise(q * vec2(${F(1 / T.mtnRegionKmX)}, ${F(1 / T.mtnRegionKmZ)}) + vec2(31.7, -12.3), sk + ${KOFF(K_MTN)}u);
  float rD = sfNoise(q * ${F(1 / T.duneRegionKm)} + vec2(-8.9, 17.2), sk + ${KOFF(K_DUNE)}u);
  float rS = sfNoise(q * ${F(1 / T.saltRegionKm)} + vec2(4.4, 9.6), sk + ${KOFF(K_SALT)}u);

  // dunes: domain-warped ridged noise
  float wnx = sfNoise(q * ${F(1 / T.warpKm)} + vec2(11.0, 0.0), sk + ${KOFF(K_WX)}u);
  float wnz = sfNoise(q * ${F(1 / T.warpKm)} + vec2(0.0, 7.0), sk + ${KOFF(K_WZ)}u);
  vec2 wq = q + vec2(wnx, wnz) * ${F(T.warpM * 0.001)};
  float r1 = 1.0 - min(1.0, abs(sfNoise(wq * vec2(6.5, 3.8), sk + ${KOFF(K_BIG)}u)));
  float big = pow(r1, 2.2) * ${F(T.bigAmp)};
  float r2 = 1.0 - min(1.0, abs(sfNoise(wq * vec2(17.0, 11.0) + vec2(50.0, 50.0), sk + ${KOFF(K_MID)}u)));
  float mid = r2 * r2 * ${F(T.midAmp)} * (0.4 + 0.6 * r1);
  float swell = sfNoise(q * ${F(1 / T.swellKm)} + vec2(100.0, 100.0), sk + ${KOFF(K_SWELL)}u) * ${F(T.swellAmp)};

  // mountains: ridged multifractal, optionally terraced into mesas
  float m = smoothstep(${F(T.mtnLo)}, ${F(T.mtnHi)}, rM);
  // passes: the ranges open along the lines to the cities in the four edge-adjacent cells
  if (m > 0.0) {
    ivec2 cc = ivec2(floor(p / ${F(CITY_CELL)}));
    vec2 ca = sfCity(cc);
    vec2 pa = p - ca;
    float la = length(pa);
    float pk = 1.0;
    for (int k = 0; k < 4; k++) {
      ivec2 o = ivec2(k == 0 ? 1 : k == 1 ? -1 : 0, k == 2 ? 1 : k == 3 ? -1 : 0);
      vec2 cn = sfCity(cc + o);
      vec2 ba = cn - ca;
      float hh = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      float ds = length(pa - ba * hh) + ${F(T.passWobble)} * wnx;
      float de = min(la, length(p - cn));
      pk = min(pk, 1.0 - (1.0 - smoothstep(${F(T.passLo)}, ${F(T.passHi)}, ds)) * smoothstep(${F(T.passNear)}, ${F(T.passFar)}, de));
    }
    m *= pk;
  }
  float mt = 0.0;
  if (m > 0.0) {
    vec2 r = q * ${F(1 / T.ridgeKm)} + vec2(-7.3, 4.1);
    float sum = 0.0;
    float w = 1.0;
    float a = 1.0;
    for (int k = 0; k < ${T.ridgeOctaves}; k++) {
      float n = sfNoise(r, sk + ${KOFF(K_RIDGE)}u + uint(k) * ${KOFF(1)}u);
      float s = 1.0 - sqrt(n * n + 0.003);
      s = s * s * w;
      w = clamp(s * 1.8, 0.0, 1.0);
      sum += s * a;
      a *= 0.48;
      r = vec2(1.6 * r.x - 1.2 * r.y, 1.2 * r.x + 1.6 * r.y) + vec2(5.3, -2.9);
    }
    float amp = ${F(T.mtnMin)} + ${F(T.mtnMax - T.mtnMin)} * smoothstep(${F(T.mtnHi)}, 0.8, rM);
    mt = amp * m * (0.15 * m + 0.62 * sum);
    float tm = smoothstep(${F(T.terraceLo)}, ${F(T.terraceHi)}, rD) * m;
    float tk = mt / ${F(T.terraceStep)};
    float tf = floor(tk);
    float tt = (tf + smoothstep(0.68, 1.0, tk - tf)) * ${F(T.terraceStep)};
    mt += (tt - mt) * tm;
    // rock ledges everywhere: short cliffs between walkable benches
    float lk = mt / 14.0;
    float lf = floor(lk);
    float lt = (lf + smoothstep(0.55, 1.0, lk - lf)) * 14.0;
    mt += (lt - mt) * 0.55 * m;
  }

  // massif: a lone cone at the nearest corner between city cells, with gullies, benches and
  // three smooth ridgelines to walk up
  vec2 gcf = floor(p / ${F(CITY_CELL)} + 0.5);
  ivec2 gi = ivec2(gcf);
  uint mh = sfCell(uint(gi.x), uint(gi.y), uint(int(uSeed)) ^ ${MASSIF_SALT}u);
  if ((mh & 1023u) < ${MASSIF_P}u) {
    uint mh2 = sfCell(mh, 7u, 0x51edu);
    vec2 jj = vec2(float((mh >> 10u) & 1023u), float((mh >> 20u) & 1023u)) / 1023.0;
    float js = float(mh2 & 1023u) / 1023.0;
    vec2 ju = vec2(float((mh2 >> 10u) & 1023u), float((mh2 >> 20u) & 1023u)) / 1023.0 - 0.5;
    vec2 mc = gcf * ${F(CITY_CELL)} + (jj - 0.5) * ${F(2 * T.massifJitter)};
    float mR = ${F(T.massifRMin)} + ${F(T.massifRMax - T.massifRMin)} * js;
    vec2 d = p - mc;
    float dl = length(d);
    if (dl < mR * 1.25) {
      vec2 lq = d * 0.001 + jj * 37.0;
      float n1 = sfNoise(lq * 0.9 + vec2(3.1, -1.7), sk + ${KOFF(K_MASSIF)}u);
      float n2 = sfNoise(lq * 2.6 + vec2(-5.2, 2.4), sk + ${KOFF(K_MASSIF + 1)}u);
      float gn = 1.0 - min(1.0, abs(sfNoise(lq * 5.0 + vec2(1.3, 8.8), sk + ${KOFF(K_MASSIF + 2)}u)));
      float t = dl / (mR * (1.0 + 0.16 * n1 + 0.07 * n2));
      float mf = pow(max(0.0, 1.0 - sqrt(t * t + 0.002)), ${F(T.massifPow)});
      float c = dot(d, ju) / (length(ju) * max(dl, 1.0));
      float lg = smoothstep(-0.45, 0.1, c * (4.0 * c * c - 3.0));
      float mH = ${F(T.massifHMin)} + ${F(T.massifHMax - T.massifHMin)} * js;
      // the ridgelines meet at the summit, so gullies and benches fade out below it
      float su = 1.0 - smoothstep(0.72, 0.88, mf);
      float mz = mH * mf + ${F(T.massifGully)} * gn * gn * 4.0 * mf * (1.0 - mf) * (0.35 + 0.65 * lg * su);
      float zk = mz / ${F(T.massifLedge)};
      float zf = floor(zk);
      float zt = (zf + smoothstep(0.55, 1.0, zk - zf)) * ${F(T.massifLedge)};
      mz += (zt - mz) * 0.5 * lg * su * smoothstep(0.02, 0.1, mf);
      mt = mt * (1.0 - smoothstep(0.0, 0.3, mf)) + mz;
      m = max(m, smoothstep(0.0, 0.08, mf));
    }
  }
  float rock = smoothstep(${F(T.rockLo)}, ${F(T.rockHi)}, mt + 18.0 * wnx);

  // salt pans and flats
  float nm = 1.0 - m;
  float pan = smoothstep(${F(T.panEdgeLo)}, ${F(T.panEdgeHi)}, rS) * nm;
  float salt = smoothstep(${F(T.saltLo)}, ${F(T.saltHi)}, rS) * nm;
  float da = ${F(T.flatAmp)} + ${F(1 - T.flatAmp)} * smoothstep(${F(T.flatLo)}, ${F(T.flatHi)}, rD);
  da *= (1.0 - pan) * (1.0 - rock);
  float base = swell + (swell * ${F(T.panSwell)} + ${F(T.panDrop)} - swell) * pan;

  return vec3(base + da * (big + mid) + mt, rock, salt);
}

${CITY_SITES_GLSL}
${CITY_SHAPE_GLSL}

// The desert with cities: the ground is levelled into a plateau under each city and
// shaped around it (terraces, cliffs, dunes), and the built area counts as hard
// ground (rock = 1, no salt).
vec3 surface(vec2 p) {
  vec3 s = surfaceBase(p);
  float h;
  float rk;
  uint ck = sfMix(uint(int(uSeed)) ^ ${SEED_SALT >>> 0}u) + ${KOFF(K_CITY)}u;
  vec2 cb = cityBlend(p, s.x, ck, h, rk);
  s.x = h;
  s.y = max(s.y, max(cb.y, rk));
  s.z *= 1.0 - cb.x;
  return s;
}

float surfaceH(vec2 p) {
  return surface(p).x;
}
`;

// ---------------------------------------------------------------- TypeScript

/** The terrain plus where its cities are. */
export interface DesertWorld extends World {
  readonly cities: CityIndex;
  /** The desert as it would be with no cities. */
  base(x: number, z: number, out: SurfaceSample): SurfaceSample;
  /** The massif at the corner (gi, gj) of the city grid, at world (gi, gj) * CITY_CELL, if any. */
  massif(gi: number, gj: number): Massif | null;
}

export function createWorld(seed: number): DesertWorld {
  const sk = mix32((Math.trunc(Math.fround(seed)) | 0) ^ SEED_SALT);
  const key = (k: number): number => (sk + KOFF(k)) >>> 0;
  const kM = key(K_MTN);
  const kD = key(K_DUNE);
  const kS = key(K_SALT);
  const kWX = key(K_WX);
  const kWZ = key(K_WZ);
  const kBig = key(K_BIG);
  const kMid = key(K_MID);
  const kSwell = key(K_SWELL);
  const kR: number[] = [];
  for (let k = 0; k < T.ridgeOctaves; k++) kR.push((sk + KOFF(K_RIDGE) + Math.imul(k, KOFF(1))) >>> 0);

  const fM = [Math.fround(1 / T.mtnRegionKmX), Math.fround(1 / T.mtnRegionKmZ)];
  const fD = Math.fround(1 / T.duneRegionKm);
  const fS = Math.fround(1 / T.saltRegionKm);
  const fW = Math.fround(1 / T.warpKm);
  const fR = Math.fround(1 / T.ridgeKm);
  const fSw = Math.fround(1 / T.swellKm);
  const wM = Math.fround(T.warpM * 0.001);
  const kMa = key(K_MASSIF);
  const kMb = key(K_MASSIF + 1);
  const kMc = key(K_MASSIF + 2);
  // The shaders read the seed as a float32 uniform, so the grid hashes use it rounded the same way.
  const gridSeed = Math.trunc(Math.fround(seed)) | 0;
  const f = Math.fround;
  const INV32 = f(1 / 4294967296);
  const cA = { x: 0, z: 0 };
  const cN = { x: 0, z: 0 };
  // Mirrors sfCity in the GLSL.
  function cityCentre(ci: number, cj: number, out: { x: number; z: number }): void {
    const h0 = cellHash(ci, cj, gridSeed);
    const rx = f(f(cellHash(h0, 1, 0x51ed)) * INV32);
    const rz = f(f(cellHash(h0, 2, 0x51ed)) * INV32);
    out.x = f(f(f(ci + f(0.24)) + f(f(0.52) * rx)) * CITY_CELL);
    out.z = f(f(f(cj + f(0.24)) + f(f(0.52) * rz)) * CITY_CELL);
  }
  const PASS_OX = [1, -1, 0, 0];
  const PASS_OZ = [0, 0, 1, -1];
  const mScratch = { x: 0, z: 0, r: 0, h: 0, jx: 0, jz: 0, ux: 0, uz: 0 };
  /** The massif at a cell corner, if there is one. Mirrors the GLSL. */
  function massifAt(gi: number, gj: number, out: typeof mScratch): boolean {
    const mh = cellHash(gi, gj, gridSeed ^ MASSIF_SALT);
    if ((mh & 1023) >= MASSIF_P) return false;
    const mh2 = cellHash(mh, 7, 0x51ed);
    out.jx = f(((mh >>> 10) & 1023) / 1023);
    out.jz = f(((mh >>> 20) & 1023) / 1023);
    const js = f((mh2 & 1023) / 1023);
    out.ux = f(f(((mh2 >>> 10) & 1023) / 1023) - 0.5);
    out.uz = f(f(((mh2 >>> 20) & 1023) / 1023) - 0.5);
    out.x = f(f(gi * CITY_CELL) + f(f(out.jx - 0.5) * (2 * T.massifJitter)));
    out.z = f(f(gj * CITY_CELL) + f(f(out.jz - 0.5) * (2 * T.massifJitter)));
    out.r = f(T.massifRMin + f((T.massifRMax - T.massifRMin) * js));
    out.h = f(T.massifHMin + f((T.massifHMax - T.massifHMin) * js));
    return true;
  }

  function base(x: number, z: number, out: SurfaceSample): SurfaceSample {
    const qx = Math.fround(x * 0.001);
    const qz = Math.fround(z * 0.001);

    const rM = noise(qx * fM[0] + 31.7, qz * fM[1] - 12.3, kM);
    const rD = noise(qx * fD - 8.9, qz * fD + 17.2, kD);
    const rS = noise(qx * fS + 4.4, qz * fS + 9.6, kS);

    const wnx = noise(qx * fW + 11, qz * fW, kWX);
    const wnz = noise(qx * fW, qz * fW + 7, kWZ);
    const wqx = qx + wnx * wM;
    const wqz = qz + wnz * wM;
    const r1 = 1 - Math.min(1, Math.abs(noise(wqx * 6.5, wqz * 3.8, kBig)));
    const big = Math.pow(r1, 2.2) * T.bigAmp;
    const r2 = 1 - Math.min(1, Math.abs(noise(wqx * 17 + 50, wqz * 11 + 50, kMid)));
    const mid = r2 * r2 * T.midAmp * (0.4 + 0.6 * r1);
    const swell = noise(qx * fSw + 100, qz * fSw + 100, kSwell) * T.swellAmp;

    let m = smoothstep(T.mtnLo, T.mtnHi, rM);
    const px = f(x);
    const pz = f(z);
    // passes (mirrors the GLSL)
    if (m > 0) {
      const ci = Math.floor(f(px / CITY_CELL));
      const cj = Math.floor(f(pz / CITY_CELL));
      cityCentre(ci, cj, cA);
      const pax = px - cA.x;
      const paz = pz - cA.z;
      const la = Math.hypot(pax, paz);
      let pk = 1;
      for (let k = 0; k < 4; k++) {
        cityCentre(ci + PASS_OX[k], cj + PASS_OZ[k], cN);
        const bax = cN.x - cA.x;
        const baz = cN.z - cA.z;
        const hh = clamp01((pax * bax + paz * baz) / (bax * bax + baz * baz));
        const ds = Math.hypot(pax - bax * hh, paz - baz * hh) + T.passWobble * wnx;
        const de = Math.min(la, Math.hypot(px - cN.x, pz - cN.z));
        pk = Math.min(pk, 1 - (1 - smoothstep(T.passLo, T.passHi, ds)) * smoothstep(T.passNear, T.passFar, de));
      }
      m *= pk;
    }
    let mt = 0;
    if (m > 0) {
      let rx = qx * fR - 7.3;
      let rz = qz * fR + 4.1;
      let sum = 0;
      let w = 1;
      let a = 1;
      for (let k = 0; k < T.ridgeOctaves; k++) {
        const n = noise(rx, rz, kR[k]);
        let s = 1 - Math.sqrt(n * n + 0.003);
        s = s * s * w;
        w = clamp01(s * 1.8);
        sum += s * a;
        a *= 0.48;
        const nx = 1.6 * rx - 1.2 * rz + 5.3;
        const nz = 1.2 * rx + 1.6 * rz - 2.9;
        rx = Math.fround(nx);
        rz = Math.fround(nz);
      }
      const amp = T.mtnMin + (T.mtnMax - T.mtnMin) * smoothstep(T.mtnHi, 0.8, rM);
      mt = amp * m * (0.15 * m + 0.62 * sum);
      const tm = smoothstep(T.terraceLo, T.terraceHi, rD) * m;
      const tk = mt / T.terraceStep;
      const tf = Math.floor(tk);
      const tt = (tf + smoothstep(0.68, 1, tk - tf)) * T.terraceStep;
      mt += (tt - mt) * tm;
      // rock ledges everywhere (mirrors the GLSL)
      const lk = mt / 14;
      const lf = Math.floor(lk);
      const lt = (lf + smoothstep(0.55, 1, lk - lf)) * 14;
      mt += (lt - mt) * 0.55 * m;
    }

    // massif (mirrors the GLSL)
    const ms = mScratch;
    if (massifAt(Math.floor(f(f(px / CITY_CELL) + 0.5)), Math.floor(f(f(pz / CITY_CELL) + 0.5)), ms)) {
      const dx = f(px - ms.x);
      const dz = f(pz - ms.z);
      const dl = Math.hypot(dx, dz);
      if (dl < ms.r * 1.25) {
        const lx = f(f(dx * 0.001) + f(ms.jx * 37));
        const lz = f(f(dz * 0.001) + f(ms.jz * 37));
        const n1 = noise(lx * 0.9 + 3.1, lz * 0.9 - 1.7, kMa);
        const n2 = noise(lx * 2.6 - 5.2, lz * 2.6 + 2.4, kMb);
        const gn = 1 - Math.min(1, Math.abs(noise(lx * 5 + 1.3, lz * 5 + 8.8, kMc)));
        const t = dl / (ms.r * (1 + 0.16 * n1 + 0.07 * n2));
        const mf = Math.pow(Math.max(0, 1 - Math.sqrt(t * t + 0.002)), T.massifPow);
        const c = (dx * ms.ux + dz * ms.uz) / (Math.hypot(ms.ux, ms.uz) * Math.max(dl, 1));
        const lg = smoothstep(-0.45, 0.1, c * (4 * c * c - 3));
        const su = 1 - smoothstep(0.72, 0.88, mf);
        let mz = ms.h * mf + T.massifGully * gn * gn * 4 * mf * (1 - mf) * (0.35 + 0.65 * lg * su);
        const zk = mz / T.massifLedge;
        const zf = Math.floor(zk);
        const zt = (zf + smoothstep(0.55, 1, zk - zf)) * T.massifLedge;
        mz += (zt - mz) * 0.5 * lg * su * smoothstep(0.02, 0.1, mf);
        mt = mt * (1 - smoothstep(0, 0.3, mf)) + mz;
        m = Math.max(m, smoothstep(0, 0.08, mf));
      }
    }
    const rock = smoothstep(T.rockLo, T.rockHi, mt + 18 * wnx);

    const nm = 1 - m;
    const pan = smoothstep(T.panEdgeLo, T.panEdgeHi, rS) * nm;
    const salt = smoothstep(T.saltLo, T.saltHi, rS) * nm;
    let da = T.flatAmp + (1 - T.flatAmp) * smoothstep(T.flatLo, T.flatHi, rD);
    da *= (1 - pan) * (1 - rock);
    const base = swell + (swell * T.panSwell + T.panDrop - swell) * pan;

    out.h = base + da * (big + mid) + mt;
    out.rock = rock;
    out.salt = salt;
    return out;
  }

  const cities = new CityIndex(gridSeed, base);
  const blend: CityBlend = { flatten: 0, paved: 0, ground: 0, h: 0, rock: 0 };
  const kCity = key(K_CITY);
  const cityNoise = (x: number, y: number): number => noise(x, y, kCity);
  // Mirrors surface() in the GLSL: level and shape the ground around the city of this cell.
  function surface(x: number, z: number, out: SurfaceSample): SurfaceSample {
    base(x, z, out);
    const site = cities.at(x, z);
    const cb = cityBlendAt(site, cities.ways(site), x, z, out.h, cityNoise, blend);
    out.h = cb.h;
    out.rock = Math.max(out.rock, cb.paved, cb.rock);
    out.salt *= 1 - cb.flatten;
    return out;
  }

  const tmp: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  const height = (x: number, z: number): number => surface(x, z, tmp).h;

  return {
    seed,
    cities,
    base,
    massif(gi: number, gj: number): Massif | null {
      return massifAt(gi, gj, mScratch) ? { x: mScratch.x, z: mScratch.z, r: mScratch.r, h: mScratch.h } : null;
    },
    height,
    sample: surface,
    normal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
      const dx = height(x + 0.5, z) - height(x - 0.5, z);
      const dz = height(x, z + 0.5) - height(x, z - 0.5);
      const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      return out.set(-dx * inv, inv, -dz * inv);
    },
  };
}
