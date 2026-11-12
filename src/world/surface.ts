// The terrain function, written twice: once in GLSL (SURFACE_GLSL, used by the
// clipmap vertex shader and the heightmap bake) and once in TypeScript
// (createWorld, used by the player and props). Both sides use the same integer
// lattice hash, so the gradient choices are bit-identical; the remaining float
// arithmetic differs only by float32 vs float64 rounding (well under 1 mm).
//
// Every constant below is emitted into the GLSL source, so tune them here.
import type * as THREE from 'three';
import { Vector4 } from 'three';
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
  // Plateau country: raised, flat slickrock for the rivers to cut gorges into. It takes the
  // low side of the salt-region noise (the high side is the pans).
  platLo: -0.42, // region noise below this: full plateau
  platHi: -0.2, // region noise above this: none
  platH: 85, // how far a plateau stands above the desert (m)
  // Rivers: the zero line of a winding noise field. Every river lies at one water level, below
  // all natural ground, so the water is flat and can be drawn as a single sheet.
  riverKm: 4.3, // wavelength of the field: sets how far apart rivers are
  meanderKm: 1.4, // wavelength of the bends
  meander: 0.22, // strength of the bends
  riverGradMin: 0.1, // floor on the field's slope (per km): caps how wide a river can pool
  waterY: -34, // water level (m)
  riverHalf: 14, // half-width of the water (m)
  riverWade: 0.45, // how deep you stand in it: the water is painted on a flat bed
  riverBank: 1, // height of the flat valley floor above the water (m)
  riverFloor: 46, // half-width of the flat valley floor (m)
  // Caves: one level slot cut into each massif's flank, half way out along a ridgeline. The
  // discoveries cap it with a rock roof.
  caveLen: 46, // how far it runs into the mountain (m)
  caveHalf: 5, // half-width (m)
  caveRoofFrom: 12, // metres in from the mouth where the roof starts
  caveHeight: 7, // floor to ceiling (m)
  // Spires: pillars of the old ground left standing where a river has cut a gorge.
  spireCell: 380, // one candidate per cell of this size (m)
  spireMax: 80, // tallest a spire stands above the water (m)
  spireP: 0.5, // chance a cell has one (it only shows if it lands in a gorge)
  // Rivers bend round cities: the field is pushed away from zero by riverPush within
  // riverClearNear of a city centre, easing to nothing by riverClearFar (under the 1.8 km a
  // city keeps to its cell border).
  // Rivers meet a massif head on: inside riverRadial times its radius they run straight along
  // a radius, and they bend onto that line between there and riverRadialFar times its radius.
  riverRadial: 1.15,
  riverRadialFar: 1.6,
  riverSmoothNear: 120, // within this of a river a massif's flank is a plain cone (m)
  riverSmoothFar: 350, // and by here it has all its lobes, gullies and benches back
  riverPush: 0.9,
  riverClearNear: 1100,
  riverClearFar: 1750,
  riverCityNear: 800, // a backstop: any river that still gets this close fades out
  riverCityFar: 1100,
  // Where a river meets a massif it ends at a spring under a headwall, over this narrow band
  // of the massif's foot (as a fraction of its height profile).
  springLo: 0.04,
  springHi: 0.07,
  // The spring's notch, in terms of how present the river still is (1 at the pool, 0 above the
  // headwall): the lip the water pours from, and the back wall of the notch.
  springLip: 0.5,
  springBack: 0.2,
  springHalf: 8, // half-width of the notch (m)
  springHeight: 9, // floor to ceiling under the rock that caps the notch (m)
  // Caverns: sealed chambers under open sand, found and opened with the pick. Unlike everything
  // above they are not part of the seeded function alone: the few nearest are handed to both
  // copies of it (see Cavern and CAVERN_GLSL), and one only cuts the ground once it is open.
  cavernHeight: 7, // floor to ceiling (m)
  cavernBrow: 3.2, // headroom where the ramp passes under the start of the roof (m)
  cavernCover: 1.6, // least thickness of ground left over the ceiling (m)
  cavernSlope: 0.3, // mean fall of the ramp (rise over run)
  cavernRampMax: 44, // longest ramp (m)
  cavernReach: 92, // furthest a cavern reshapes the ground from the spot it is dug at (m)
} as const;

/** How many caverns the terrain considers at once (the nearest ones to the player). */
export const MAX_CAVERNS = 4;

/**
 * A cavern, in the terms both copies of the terrain cut it by. u runs from the spot it is dug
 * at down the ramp and on to the back wall; v is across. Everything the shape needs is here, so
 * the GLSL and the TypeScript cannot drift apart over a site.
 */
export interface Cavern {
  /** The spot over the top of the ramp: where the sand gives way. */
  x: number;
  z: number;
  /** Unit direction the ramp runs down and the chamber lies. */
  dx: number;
  dz: number;
  /** Height of the ground at the spot, and of the chamber floor. */
  top: number;
  floor: number;
  /** Half-width of the passage (m). */
  half: number;
  /** How far the far end is shifted sideways (m): 0 for a straight run, either sign for a dogleg. */
  bend: number;
  /** Extra half-width of the chamber at the far end (m). */
  bulge: number;
  /** u of the back wall, the length of the ramp, and u where the roof begins. */
  len: number;
  ramp: number;
  roof: number;
  /** Radius of the basin in the end chamber's floor (m), or 0. */
  pool: number;
  /** 0 sealed .. 1 open: the sand drains as this rises. */
  open: number;
  /** Depth of the dimple that marks the spot (m). */
  dimple: number;
}

/** Tallest ground the terrain can produce (m); shadows stop marching above it. */
export const MAX_TERRAIN_H = 1000;

/** A cave: the middle of its mouth, and the unit direction it runs into the mountain. */
export interface Cave {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

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
const K_RIVER = 40; // .. 41
const SPIRE_SALT = 0x7c1d;
const SPIRE_P = Math.round(TERRAIN.spireP * 256);
/** Height of the ideal cone at the cave mouth, as a fraction of the massif's height. */
const CAVE_C0 = Math.pow(1 - Math.sqrt(0.25 + 0.002), TERRAIN.massifPow);
/** How far from a river the ground can be reshaped (m). */
const RIVER_REACH = TERRAIN.riverFloor + 520;
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

/** noise() with its gradient: writes (value, d/dx, d/dy) to out. Mirrors sfNoiseD. */
function noiseD(px: number, py: number, key: number, out: Float64Array): void {
  px = Math.fround(px);
  py = Math.fround(py);
  const ix0 = Math.floor(px);
  const iy0 = Math.floor(py);
  const fx = px - ix0;
  const fy = py - iy0;
  const ix = ix0 | 0;
  const iy = iy0 | 0;
  const hA = mix32(Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ key) & 7;
  const hB = mix32(Math.imul(ix + 1, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ key) & 7;
  const hC = mix32(Math.imul(ix, 0x8da6b343) ^ Math.imul(iy + 1, 0xd8163841) ^ key) & 7;
  const hD = mix32(Math.imul(ix + 1, 0x8da6b343) ^ Math.imul(iy + 1, 0xd8163841) ^ key) & 7;
  const a = GX[hA] * fx + GY[hA] * fy;
  const b = GX[hB] * (fx - 1) + GY[hB] * fy;
  const c = GX[hC] * fx + GY[hC] * (fy - 1);
  const d = GX[hD] * (fx - 1) + GY[hD] * (fy - 1);
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx - 1) * (fx - 1);
  const duy = 30 * fy * fy * (fy - 1) * (fy - 1);
  const k = a - b - c + d;
  out[0] = (a + ux * (b - a) + uy * (c - a) + ux * uy * k) * NSCALE;
  out[1] = (GX[hA] + ux * (GX[hB] - GX[hA]) + uy * (GX[hC] - GX[hA]) + ux * uy * (GX[hA] - GX[hB] - GX[hC] + GX[hD]) + dux * (b - a + uy * k)) * NSCALE;
  out[2] = (GY[hA] + ux * (GY[hB] - GY[hA]) + uy * (GY[hC] - GY[hA]) + ux * uy * (GY[hA] - GY[hB] - GY[hC] + GY[hD]) + duy * (c - a + ux * k)) * NSCALE;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- GLSL

const NOISE_GLSL = /* glsl */ `
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

// sfNoise with its gradient: (value, d/dx, d/dy).
vec3 sfNoiseD(vec2 p, uint key) {
  vec2 i = floor(p);
  vec2 f = p - i;
  int ix = int(i.x);
  int iy = int(i.y);
  vec2 ga = SF_G[int(sfMix((uint(ix) * 0x8da6b343u) ^ (uint(iy) * 0xd8163841u) ^ key) & 7u)];
  vec2 gb = SF_G[int(sfMix((uint(ix + 1) * 0x8da6b343u) ^ (uint(iy) * 0xd8163841u) ^ key) & 7u)];
  vec2 gc = SF_G[int(sfMix((uint(ix) * 0x8da6b343u) ^ (uint(iy + 1) * 0xd8163841u) ^ key) & 7u)];
  vec2 gd = SF_G[int(sfMix((uint(ix + 1) * 0x8da6b343u) ^ (uint(iy + 1) * 0xd8163841u) ^ key) & 7u)];
  float a = dot(ga, f);
  float b = dot(gb, f - vec2(1.0, 0.0));
  float c = dot(gc, f - vec2(0.0, 1.0));
  float d = dot(gd, f - vec2(1.0, 1.0));
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f - 1.0) * (f - 1.0);
  float k = a - b - c + d;
  float v = a + u.x * (b - a) + u.y * (c - a) + u.x * u.y * k;
  vec2 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * vec2((b - a) + u.y * k, (c - a) + u.x * k);
  return vec3(v, g) * ${F(NSCALE)};
}

`;

export const SURFACE_GLSL = /* glsl */ `
${NOISE_GLSL}

// Set by surfaceBase and surface for the point just sampled: the signed distance to the nearest
// river (m, clamped) and how present the river is there (0 where it fades out by a city or massif).
float sfRiverD;
float sfRiverS;
// Likewise: 1 under the roof of a cave, 0 in the open.
float sfCave;

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

// Signed distance to the centre line of the nearest river (m): positive on one bank, negative
// on the other, so it interpolates cleanly across the water.
// Rivers never run up to a city and stop: around each city the field is pushed further from
// zero, on whichever side of zero the city already stands, so the line bends round the town.
// Rivers also meet a massif head on. Close to one, the field is read from further out along
// the same bearing from its centre, so every river that comes within reach runs straight in
// along a radius, and one that only passes by stays outside.
float sfRiver(vec2 p, uint sk) {
  vec2 pw = p;
  vec2 rh = vec2(0.0);
  float hs = 1.0;
  float hd = 1.0;
  vec2 gcf = floor(p / ${F(CITY_CELL)} + 0.5);
  ivec2 gi = ivec2(gcf);
  uint mh = sfCell(uint(gi.x), uint(gi.y), uint(int(uSeed)) ^ ${MASSIF_SALT}u);
  if ((mh & 1023u) < ${MASSIF_P}u) {
    uint mh2 = sfCell(mh, 7u, 0x51edu);
    vec2 jj = vec2(float((mh >> 10u) & 1023u), float((mh >> 20u) & 1023u)) / 1023.0;
    float mR = ${F(T.massifRMin)} + ${F(T.massifRMax - T.massifRMin)} * (float(mh2 & 1023u) / 1023.0);
    vec2 md = p - (gcf * ${F(CITY_CELL)} + (jj - 0.5) * ${F(2 * T.massifJitter)});
    float mr = max(length(md), 1.0);
    float rc = mR * ${F(T.riverRadial)};
    float rr = mR * ${F(T.riverRadialFar)};
    if (mr < rr) {
      // h is the radius the field is read at: held at rc inside it, easing to mr by rr
      float t = clamp((mr - rc) / (rr - rc), 0.0, 1.0);
      float h = rc + (rr - rc) * t * t * (2.0 - t);
      rh = md / mr;
      hs = h / mr;
      hd = t * (4.0 - 3.0 * t);
      pw = p + rh * (h - mr);
    }
  }
  vec2 q = pw * 0.001;
  vec3 ra = sfNoiseD(q * ${F(1 / T.riverKm)} + vec2(13.7, -6.2), sk + ${KOFF(K_RIVER)}u);
  vec3 rb = sfNoiseD(q * ${F(1 / T.meanderKm)} + vec2(-2.9, 21.4), sk + ${KOFF(K_RIVER + 1)}u);
  float rf = ra.x + ${F(T.meander)} * rb.x;
  vec2 rg = ra.yz * ${F(1 / T.riverKm)} + rb.yz * ${F(T.meander / T.meanderKm)};
  vec2 c = sfCity(ivec2(floor(p / ${F(CITY_CELL)})));
  vec2 cq = c * 0.001;
  float fc = sfNoise(cq * ${F(1 / T.riverKm)} + vec2(13.7, -6.2), sk + ${KOFF(K_RIVER)}u)
    + ${F(T.meander)} * sfNoise(cq * ${F(1 / T.meanderKm)} + vec2(-2.9, 21.4), sk + ${KOFF(K_RIVER + 1)}u);
  float sg = fc < 0.0 ? -${F(T.riverPush)} : ${F(T.riverPush)};
  // (measured from where the field is read, so near a massif the push only turns a river onto
  // another radius, never off one)
  vec2 dc = pw - c;
  float r = length(dc);
  float t = clamp((r - ${F(T.riverClearNear)}) / ${F(T.riverClearFar - T.riverClearNear)}, 0.0, 1.0);
  rf += sg * (1.0 - t * t * (3.0 - 2.0 * t));
  rg += dc * (sg * -6.0 * t * (1.0 - t) * ${F(1000 / (T.riverClearFar - T.riverClearNear))} / max(r, 1.0));
  // the slope of the field as it lies on the ground: stretched round the massif, flat along a radius
  float gr = dot(rg, rh);
  rg = (rg - rh * gr) * hs + rh * (gr * hd);
  return rf / max(length(rg), ${F(T.riverGradMin)}) * 1000.0;
}

// How clear of a city-to-city line a point is: 0 on the line to a city in one of the four
// edge-adjacent cells, 1 well away from all of them. wob makes the edge wander.
float sfPass(vec2 p, float wob) {
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
    float ds = length(pa - ba * hh) + ${F(T.passWobble)} * wob;
    float de = min(la, length(p - cn));
    pk = min(pk, 1.0 - (1.0 - smoothstep(${F(T.passLo)}, ${F(T.passHi)}, ds)) * smoothstep(${F(T.passNear)}, ${F(T.passFar)}, de));
  }
  return pk;
}

// The raw desert: (height m, rock 0..1, salt 0..1, riverbank green 0..1).
// About 15 noise evaluations, 18 on a massif.
vec4 surfaceBase(vec2 p) {
  uint sk = sfMix(uint(int(uSeed)) ^ ${SEED_SALT >>> 0}u);
  vec2 q = p * 0.001; // kilometres
  sfCave = 0.0;

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
  // passes: the ranges open along the lines between neighbouring cities
  if (m > 0.0) m *= sfPass(p, wnx);
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
  float mfo = 0.0;
  float rsd = sfRiver(p, sk); // found before the massif, which smooths itself where a river comes in
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
      // the cave sits half way out along one ridgeline; around it the cone is left smooth
      vec2 un = ju / length(ju);
      vec2 ce = vec2(0.5 * un.x - ${F(Math.fround(Math.sqrt(0.75)))} * un.y, ${F(Math.fround(Math.sqrt(0.75)))} * un.x + 0.5 * un.y);
      vec2 cv = d - ce * (0.5 * mR);
      float cal = -dot(cv, ce); // metres into the mountain from the mouth
      float clt = dot(cv, vec2(-ce.y, ce.x)); // metres to the side
      // Where a river runs in, the outline is left round too, so the headwall faces the river
      // squarely instead of bulging across it.
      float ck = smoothstep(70.0, 150.0, length(cv)) * smoothstep(${F(T.riverSmoothNear)}, ${F(T.riverSmoothFar)}, abs(rsd));
      n1 *= ck;
      n2 *= ck;
      gn *= ck;
      float t = dl / (mR * (1.0 + 0.16 * n1 + 0.07 * n2));
      float mf = pow(max(0.0, 1.0 - sqrt(t * t + 0.002)), ${F(T.massifPow)});
      float c = dot(d, ju) / (length(ju) * max(dl, 1.0));
      float lg = smoothstep(-0.45, 0.1, c * (4.0 * c * c - 3.0)) * ck;
      float mH = ${F(T.massifHMin)} + ${F(T.massifHMax - T.massifHMin)} * js;
      // the ridgelines meet at the summit, so gullies and benches fade out below it
      float su = 1.0 - smoothstep(0.72, 0.88, mf);
      float mz = mH * mf + ${F(T.massifGully)} * gn * gn * 4.0 * mf * (1.0 - mf) * (0.35 + 0.65 * lg * su);
      float zk = mz / ${F(T.massifLedge)};
      float zf = floor(zk);
      float zt = (zf + smoothstep(0.55, 1.0, zk - zf)) * ${F(T.massifLedge)};
      mz += (zt - mz) * 0.5 * lg * su * smoothstep(0.02, 0.1, mf);
      float sl = (1.0 - smoothstep(${F(T.caveHalf)}, ${F(T.caveHalf + 1.5)}, abs(clt))) * smoothstep(-1.0, 1.5, cal) * (1.0 - smoothstep(${F(T.caveLen)}, ${F(T.caveLen + 2)}, cal));
      mz = mix(mz, min(mz, mH * ${F(CAVE_C0)}), sl);
      sfCave = sl * smoothstep(${F(T.caveRoofFrom - 3)}, ${F(T.caveRoofFrom + 1)}, cal);
      mt = mt * (1.0 - smoothstep(0.0, 0.3, mf)) + mz;
      m = max(m, smoothstep(0.0, 0.08, mf));
      mfo = mf;
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

  // plateau country: raised and nearly flat, part rock
  float pu = (1.0 - smoothstep(${F(T.platLo)}, ${F(T.platHi)}, rS)) * nm;
  float steep = smoothstep(0.15, 0.5, max(rock, pu));
  float h = base * (1.0 - 0.6 * pu) + ${F(T.platH)} * pu + da * (1.0 - 0.8 * pu) * (big + mid) + mt;
  rock = max(rock, 0.4 * pu);

  // rivers: a flat floor at the water level, with cliffs where the ground is rock or plateau
  // and a broad gentle valley where it is sand
  float green = 0.0;
  float rd = abs(rsd);
  sfRiverD = clamp(rsd, -300.0, 300.0);
  sfRiverS = 0.0;
  if (rd < ${F(RIVER_REACH)}) {
    vec2 rc = sfCity(ivec2(floor(p / ${F(CITY_CELL)})));
    float rs = smoothstep(${F(T.riverCityNear)}, ${F(T.riverCityFar)}, length(p - rc)) * (1.0 - smoothstep(${F(T.springLo)}, ${F(T.springHi)}, mfo));
    sfRiverS = rs;
    if (rs > 0.0) {
      // where a track crosses, the cliffs give way to a gentle valley and a ford
      if (steep > 0.0) steep *= sfPass(p, wnx);
      float fy = ${F(T.waterY)} + ${F(T.riverBank)} * smoothstep(${F(T.riverHalf - 1)}, ${F(T.riverHalf + 6)}, rd);
      float dep = max(h - ${F(T.waterY + T.riverBank)}, 0.0);
      // side ramps: every few hundred metres the cliffs lie back into a slope you can walk
      float ramp = smoothstep(0.3, 0.55, wnz);
      float ww = mix(clamp(4.0 * dep, 120.0, 500.0), clamp(0.8 * dep, 30.0, 400.0) * (1.0 + 3.0 * ramp), steep);
      float w = smoothstep(${F(T.riverFloor)}, ${F(T.riverFloor)} + ww, rd);
      float carved = min(h, mix(fy, h, w));
      float rkc = mix(steep * smoothstep(0.03, 0.25, w), rock, smoothstep(0.85, 1.0, w));
      // spires: a pillar of the old ground left standing at the foot of the cliffs
      vec2 sg = floor(p / ${F(T.spireCell)});
      uint sh = sfCell(uint(int(sg.x)), uint(int(sg.y)), uint(int(uSeed)) ^ ${SPIRE_SALT}u);
      if ((sh & 255u) < ${SPIRE_P}u && steep > 0.0) {
        vec2 sc = (sg + 0.2 + 0.6 * vec2(float((sh >> 8u) & 1023u), float((sh >> 18u) & 1023u)) / 1023.0) * ${F(T.spireCell)};
        float sr = 9.0 + 5.0 * float((sh >> 28u) & 15u) / 15.0;
        float sm = (1.0 - smoothstep(sr - 3.0, sr, length(p - sc))) * smoothstep(22.0, 30.0, rd) * (1.0 - smoothstep(64.0, 78.0, rd)) * steep;
        carved = mix(carved, max(carved, min(h - 6.0, ${F(T.waterY + T.spireMax)})), sm);
        rkc = max(rkc, sm);
      }
      // the spring: where a river meets a massif, a notch is cut back into the headwall above
      // the pool, and the water pours from its lip. Through the notch the carve is held at one
      // strength, which makes a shelf with a wall behind it.
      float nk = (1.0 - smoothstep(${F(T.springHalf - 1)}, ${F(T.springHalf + 1)}, rd)) * smoothstep(${F(T.springBack - 0.04)}, ${F(T.springBack)}, rs) * (1.0 - smoothstep(${F(T.springLip)}, ${F(T.springLip + 0.04)}, rs)) * step(0.0001, mfo);
      h = mix(h, carved, mix(rs, ${F(T.springLip + 0.02)}, nk));
      rock = mix(rock, rkc, rs);
      salt *= mix(1.0, w, rs);
      green = rs * (1.0 - smoothstep(${F(T.riverHalf)}, ${F(T.riverFloor + 12)}, rd));
    }
  }

  return vec4(h, rock, salt, green);
}

${CITY_SITES_GLSL}
${CITY_SHAPE_GLSL}

// The nearest caverns (see Cavern in surface.ts; len 0 means unused):
// uCavA = (x, z, dir x, dir z), uCavB = (top, floor, open 0..1, roof u),
// uCavC = (half, bend, bulge, len), uCavD = (ramp, pool radius, dimple, unused).
uniform vec4 uCavA[${MAX_CAVERNS}];
uniform vec4 uCavB[${MAX_CAVERNS}];
uniform vec4 uCavC[${MAX_CAVERNS}];
uniform vec4 uCavD[${MAX_CAVERNS}];

// Caverns: a faint dimple over each, and, once one is open, a slot cut down through the sand:
// a ramp from the spot it was dug at, soft-sided in the open and rock-walled under its roof,
// then a level chamber. Sets sfCave under the roof (above 1 where no daylight reaches).
// Mirrors carveCaverns in the TypeScript. A few multiplies per site for a point out of reach.
vec2 sfCaverns(vec2 p, float h) {
  float rock = 0.0;
  for (int i = 0; i < ${MAX_CAVERNS}; i++) {
    vec4 cc = uCavC[i];
    if (cc.w <= 0.0) continue;
    vec4 ca = uCavA[i];
    vec2 d = p - ca.xy;
    float d2 = dot(d, d);
    if (d2 > ${F(T.cavernReach * T.cavernReach)}) continue;
    vec4 cb = uCavB[i];
    vec4 cd = uCavD[i];
    float dm = 1.0 - smoothstep(0.0, 50.0, d2);
    h -= cd.z * dm * dm;
    if (cb.z <= 0.0) continue;
    float u = dot(d, ca.zw);
    float v = dot(d, vec2(-ca.w, ca.z));
    float rk = smoothstep(cb.w - 4.0, cb.w, u);
    float cl = cc.y * smoothstep(cd.x + 3.0, cd.x + 17.0, u);
    float er = cc.x + cc.z;
    float hw = cc.x + cc.z * smoothstep(cc.w - 2.0 * er - 4.0, cc.w - er, u);
    float sd = hw + mix(5.0, 1.5, rk);
    float lat = abs(v - cl);
    float o = cb.z * cb.z * (3.0 - 2.0 * cb.z);
    // Rock, and out of the sun, from under the roof to a stride past the walls: so a wall is
    // dark to its full height however coarsely the mesh steps up it. (The rest is under the roof's sand.)
    float under = rk * o * (1.0 - smoothstep(sd + 0.2, sd + 1.6, lat)) * (1.0 - smoothstep(cc.w + 2.2, cc.w + 3.6, u));
    rock = max(rock, under);
    sfCave = max(sfCave, under * (1.0 + smoothstep(cb.w + 1.0, cb.w + 14.0, u)));
    float m = (1.0 - smoothstep(hw, sd, lat)) * smoothstep(-1.0, 3.0, u) * (1.0 - smoothstep(cc.w, cc.w + 2.0, u));
    if (m <= 0.0) continue;
    float tgt = cb.y + (cb.x - cb.y) * (1.0 - smoothstep(2.0, 2.0 + cd.x, u));
    if (cd.y > 0.0) tgt -= 0.75 * (1.0 - smoothstep(cd.y - 2.5, cd.y, length(vec2(u - (cc.w - er), v - cl))));
    h = mix(h, min(h, mix(h, tgt, m)), o);
  }
  return vec2(h, rock);
}

// The desert with cities: the ground is levelled into a plateau under each city and
// shaped around it (terraces, cliffs, dunes), and the built area counts as hard
// ground (rock = 1, no salt).
vec4 surface(vec2 p) {
  vec4 s = surfaceBase(p);
  float h;
  float rk;
  uint ck = sfMix(uint(int(uSeed)) ^ ${SEED_SALT >>> 0}u) + ${KOFF(K_CITY)}u;
  vec2 cb = cityBlend(p, s.x, ck, h, rk);
  s.x = h;
  s.y = max(s.y, max(cb.y, rk));
  s.z *= 1.0 - cb.x;
  s.w *= 1.0 - cb.x;
  sfRiverS *= 1.0 - cb.x;
  vec2 cv = sfCaverns(p, s.x);
  s.x = cv.x;
  s.y = max(s.y, cv.y);
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
  /** The cave cut into the massif at corner (gi, gj), if there is a massif there. */
  cave(gi: number, gj: number): Cave | null;
  /** The height of the cave ceiling over (x, z), or Infinity where there is no cave roof. */
  caveCeil(x: number, z: number): number;
  /** The ground as it would be with no cave or spring notch cut into it: the top of the rock over one. */
  uncarved(x: number, z: number): number;
  /** uncarved, with the rock and salt of that ground. */
  uncarvedSample(x: number, z: number, out: SurfaceSample): SurfaceSample;
  /** Distance to the centre line of the nearest river (m). Rivers fade out near cities and on massifs. */
  river(x: number, z: number): number;
  /** The massif at the corner (gi, gj) of the city grid, at world (gi, gj) * CITY_CELL, if any. */
  massif(gi: number, gj: number): Massif | null;
  /**
   * The caverns the ground is shaped by from now on: at most MAX_CAVERNS, the same ones (and
   * the same numbers) the shaders are given by writeCaverns.
   */
  setCaverns(list: readonly Cavern[]): void;
  /** The height of the ceiling of an open cavern over (x, z), or Infinity where there is none. */
  cavernCeil(x: number, z: number): number;
}

/** The shared uniforms the terrain reads its caverns from. Create them before any terrain material. */
export function cavernUniforms(u: Record<string, { value: unknown }>): void {
  for (const n of ['uCavA', 'uCavB', 'uCavC', 'uCavD']) {
    if (!u[n]) u[n] = { value: Array.from({ length: MAX_CAVERNS }, () => new Vector4()) };
  }
  // what glows in the nearest open cavern: position, and how far its light carries (0 = nothing)
  if (!u.uCavGlow) u.uCavGlow = { value: new Vector4() };
}

/** Hand the shaders the same caverns the world was given by setCaverns. */
export function writeCaverns(u: Record<string, { value: unknown }>, list: readonly Cavern[]): void {
  const a = u.uCavA.value as Vector4[];
  const b = u.uCavB.value as Vector4[];
  const c = u.uCavC.value as Vector4[];
  const d = u.uCavD.value as Vector4[];
  for (let i = 0; i < MAX_CAVERNS; i++) {
    const cv = list[i];
    if (!cv) {
      c[i].w = 0;
      continue;
    }
    a[i].set(cv.x, cv.z, cv.dx, cv.dz);
    b[i].set(cv.top, cv.floor, cv.open, cv.roof);
    c[i].set(cv.half, cv.bend, cv.bulge, cv.len);
    d[i].set(cv.ramp, cv.pool, cv.dimple, 0);
  }
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
  const kRa = key(K_RIVER);
  const kRb = key(K_RIVER + 1);
  const fRv = Math.fround(1 / T.riverKm);
  const fMe = Math.fround(1 / T.meanderKm);
  const nA = new Float64Array(3);
  const nB = new Float64Array(3);
  /** Distance to the nearest river's centre line (m), from kilometre coordinates. Mirrors the GLSL. */
  const cR = { x: 0, z: 0 };
  // The push is the same for every point in a city's cell, so remember the last cell's.
  let pushCi = NaN;
  let pushCj = NaN;
  let pushSg = 0;
  function riverDist(px: number, pz: number): number {
    // rivers meet a massif head on (mirrors the GLSL)
    let wx = px;
    let wz = pz;
    let rhx = 0;
    let rhz = 0;
    let hs = 1;
    let hd = 1;
    if (massifAt(Math.floor(f(f(px / CITY_CELL) + 0.5)), Math.floor(f(f(pz / CITY_CELL) + 0.5)), mRiver)) {
      const mdx = px - mRiver.x;
      const mdz = pz - mRiver.z;
      const mr = Math.max(Math.hypot(mdx, mdz), 1);
      const rc = mRiver.r * T.riverRadial;
      const rr = mRiver.r * T.riverRadialFar;
      if (mr < rr) {
        const t = clamp01((mr - rc) / (rr - rc));
        const h = rc + (rr - rc) * t * t * (2 - t);
        rhx = mdx / mr;
        rhz = mdz / mr;
        hs = h / mr;
        hd = t * (4 - 3 * t);
        wx = px + rhx * (h - mr);
        wz = pz + rhz * (h - mr);
      }
    }
    const qx = f(f(wx) * 0.001);
    const qz = f(f(wz) * 0.001);
    noiseD(qx * fRv + 13.7, qz * fRv - 6.2, kRa, nA);
    noiseD(qx * fMe - 2.9, qz * fMe + 21.4, kRb, nB);
    let rf = nA[0] + T.meander * nB[0];
    let gx = nA[1] * (1 / T.riverKm) + nB[1] * (T.meander / T.meanderKm);
    let gz = nA[2] * (1 / T.riverKm) + nB[2] * (T.meander / T.meanderKm);
    // rivers bend round cities (mirrors the GLSL)
    const ci = Math.floor(f(px / CITY_CELL));
    const cj = Math.floor(f(pz / CITY_CELL));
    cityCentre(ci, cj, cR);
    if (ci !== pushCi || cj !== pushCj) {
      const cqx = f(cR.x * 0.001);
      const cqz = f(cR.z * 0.001);
      const fc = noise(cqx * fRv + 13.7, cqz * fRv - 6.2, kRa) + T.meander * noise(cqx * fMe - 2.9, cqz * fMe + 21.4, kRb);
      pushSg = fc < 0 ? -T.riverPush : T.riverPush;
      pushCi = ci;
      pushCj = cj;
    }
    const dcx = wx - cR.x;
    const dcz = wz - cR.z;
    const r = Math.hypot(dcx, dcz);
    const t = clamp01((r - T.riverClearNear) / (T.riverClearFar - T.riverClearNear));
    rf += pushSg * (1 - t * t * (3 - 2 * t));
    const k = (pushSg * -6 * t * (1 - t) * (1000 / (T.riverClearFar - T.riverClearNear))) / Math.max(r, 1);
    gx += dcx * k;
    gz += dcz * k;
    const gr = gx * rhx + gz * rhz;
    gx = (gx - rhx * gr) * hs + rhx * (gr * hd);
    gz = (gz - rhz * gr) * hs + rhz * (gr * hd);
    return (Math.abs(rf) / Math.max(Math.hypot(gx, gz), T.riverGradMin)) * 1000;
  }
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
  /** Mirrors sfPass in the GLSL. */
  function passAt(px: number, pz: number, wob: number): number {
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
      const ds = Math.hypot(pax - bax * hh, paz - baz * hh) + T.passWobble * wob;
      const de = Math.min(la, Math.hypot(px - cN.x, pz - cN.z));
      pk = Math.min(pk, 1 - (1 - smoothstep(T.passLo, T.passHi, ds)) * smoothstep(T.passNear, T.passFar, de));
    }
    return pk;
  }
  const mScratch = { x: 0, z: 0, r: 0, h: 0, jx: 0, jz: 0, ux: 0, uz: 0 };
  const mRiver = { x: 0, z: 0, r: 0, h: 0, jx: 0, jz: 0, ux: 0, uz: 0 };
  let caveOn = true; // false while sampling the mountain with no cave or spring notch cut into it
  const cvS = { x: 0, z: 0, along: 0, lat: 0, ex: 0, ez: 0 };
  /** Where a point (dx, dz from the massif's centre) lies in the frame of its cave. Mirrors the GLSL. */
  function caveFrame(ms: typeof mScratch, dx: number, dz: number): void {
    const ul = Math.hypot(ms.ux, ms.uz);
    const unx = ms.ux / ul;
    const unz = ms.uz / ul;
    const S60 = Math.fround(Math.sqrt(0.75));
    const ex = 0.5 * unx - S60 * unz;
    const ez = S60 * unx + 0.5 * unz;
    cvS.ex = ex;
    cvS.ez = ez;
    cvS.x = dx - ex * (0.5 * ms.r);
    cvS.z = dz - ez * (0.5 * ms.r);
    cvS.along = -(cvS.x * ex + cvS.z * ez);
    cvS.lat = cvS.x * -ez + cvS.z * ex;
  }
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
    if (m > 0) m *= passAt(px, pz, wnx);
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
    let mfo = 0;
    const rd = riverDist(px, pz);
    if (massifAt(Math.floor(f(f(px / CITY_CELL) + 0.5)), Math.floor(f(f(pz / CITY_CELL) + 0.5)), ms)) {
      const dx = f(px - ms.x);
      const dz = f(pz - ms.z);
      const dl = Math.hypot(dx, dz);
      if (dl < ms.r * 1.25) {
        const lx = f(f(dx * 0.001) + f(ms.jx * 37));
        const lz = f(f(dz * 0.001) + f(ms.jz * 37));
        let n1 = noise(lx * 0.9 + 3.1, lz * 0.9 - 1.7, kMa);
        let n2 = noise(lx * 2.6 - 5.2, lz * 2.6 + 2.4, kMb);
        let gn = 1 - Math.min(1, Math.abs(noise(lx * 5 + 1.3, lz * 5 + 8.8, kMc)));
        // the cave (mirrors the GLSL)
        caveFrame(ms, dx, dz);
        const ck = smoothstep(70, 150, Math.hypot(cvS.x, cvS.z)) * smoothstep(T.riverSmoothNear, T.riverSmoothFar, rd);
        n1 *= ck;
        n2 *= ck;
        gn *= ck;
        const t = dl / (ms.r * (1 + 0.16 * n1 + 0.07 * n2));
        const mf = Math.pow(Math.max(0, 1 - Math.sqrt(t * t + 0.002)), T.massifPow);
        const c = (dx * ms.ux + dz * ms.uz) / (Math.hypot(ms.ux, ms.uz) * Math.max(dl, 1));
        const lg = smoothstep(-0.45, 0.1, c * (4 * c * c - 3)) * ck;
        const su = 1 - smoothstep(0.72, 0.88, mf);
        let mz = ms.h * mf + T.massifGully * gn * gn * 4 * mf * (1 - mf) * (0.35 + 0.65 * lg * su);
        const zk = mz / T.massifLedge;
        const zf = Math.floor(zk);
        const zt = (zf + smoothstep(0.55, 1, zk - zf)) * T.massifLedge;
        mz += (zt - mz) * 0.5 * lg * su * smoothstep(0.02, 0.1, mf);
        if (caveOn) {
          const sl = (1 - smoothstep(T.caveHalf, T.caveHalf + 1.5, Math.abs(cvS.lat))) * smoothstep(-1, 1.5, cvS.along) * (1 - smoothstep(T.caveLen, T.caveLen + 2, cvS.along));
          mz = mz + (Math.min(mz, ms.h * CAVE_C0) - mz) * sl;
        }
        mt = mt * (1 - smoothstep(0, 0.3, mf)) + mz;
        m = Math.max(m, smoothstep(0, 0.08, mf));
        mfo = mf;
      }
    }
    let rock = smoothstep(T.rockLo, T.rockHi, mt + 18 * wnx);

    const nm = 1 - m;
    const pan = smoothstep(T.panEdgeLo, T.panEdgeHi, rS) * nm;
    let salt = smoothstep(T.saltLo, T.saltHi, rS) * nm;
    let da = T.flatAmp + (1 - T.flatAmp) * smoothstep(T.flatLo, T.flatHi, rD);
    da *= (1 - pan) * (1 - rock);
    const base = swell + (swell * T.panSwell + T.panDrop - swell) * pan;

    // plateau country (mirrors the GLSL)
    const pu = (1 - smoothstep(T.platLo, T.platHi, rS)) * nm;
    let steep = smoothstep(0.15, 0.5, Math.max(rock, pu));
    let h = base * (1 - 0.6 * pu) + T.platH * pu + da * (1 - 0.8 * pu) * (big + mid) + mt;
    rock = Math.max(rock, 0.4 * pu);

    // rivers (mirrors the GLSL)
    let green = 0;
    if (rd < RIVER_REACH) {
      cityCentre(Math.floor(f(px / CITY_CELL)), Math.floor(f(pz / CITY_CELL)), cA);
      const rs = smoothstep(T.riverCityNear, T.riverCityFar, Math.hypot(px - cA.x, pz - cA.z)) * (1 - smoothstep(T.springLo, T.springHi, mfo));
      if (rs > 0) {
        if (steep > 0) steep *= passAt(px, pz, wnx);
        const fy = T.waterY + T.riverBank * smoothstep(T.riverHalf - 1, T.riverHalf + 6, rd);
        const dep = Math.max(h - (T.waterY + T.riverBank), 0);
        const ramp = smoothstep(0.3, 0.55, wnz);
        const wSand = Math.min(500, Math.max(120, 4 * dep));
        const wRock = Math.min(400, Math.max(30, 0.8 * dep)) * (1 + 3 * ramp);
        const ww = wSand + (wRock - wSand) * steep;
        const w = smoothstep(T.riverFloor, T.riverFloor + ww, rd);
        let carved = Math.min(h, fy + (h - fy) * w);
        const rk0 = steep * smoothstep(0.03, 0.25, w);
        let rkc = rk0 + (rock - rk0) * smoothstep(0.85, 1, w);
        // spires (mirrors the GLSL)
        const sgx = Math.floor(f(px / T.spireCell));
        const sgz = Math.floor(f(pz / T.spireCell));
        const sh = cellHash(sgx, sgz, gridSeed ^ SPIRE_SALT);
        if ((sh & 255) < SPIRE_P && steep > 0) {
          const scx = (sgx + 0.2 + (0.6 * ((sh >>> 8) & 1023)) / 1023) * T.spireCell;
          const scz = (sgz + 0.2 + (0.6 * ((sh >>> 18) & 1023)) / 1023) * T.spireCell;
          const sr = 9 + (5 * ((sh >>> 28) & 15)) / 15;
          const sm = (1 - smoothstep(sr - 3, sr, Math.hypot(px - scx, pz - scz))) * smoothstep(22, 30, rd) * (1 - smoothstep(64, 78, rd)) * steep;
          carved = carved + (Math.max(carved, Math.min(h - 6, T.waterY + T.spireMax)) - carved) * sm;
          rkc = Math.max(rkc, sm);
        }
        // the spring's notch (mirrors the GLSL)
        const nk = (1 - smoothstep(T.springHalf - 1, T.springHalf + 1, rd)) * smoothstep(T.springBack - 0.04, T.springBack, rs) * (1 - smoothstep(T.springLip, T.springLip + 0.04, rs)) * (mfo >= 0.0001 && caveOn ? 1 : 0);
        h = h + (carved - h) * (rs + (T.springLip + 0.02 - rs) * nk);
        rock = rock + (rkc - rock) * rs;
        salt *= 1 + (w - 1) * rs;
        green = rs * (1 - smoothstep(T.riverHalf, T.riverFloor + 12, rd));
      }
    }

    out.h = h;
    out.rock = rock;
    out.salt = salt;
    out.green = green;
    return out;
  }

  const cities = new CityIndex(gridSeed, base);
  const blend: CityBlend = { flatten: 0, paved: 0, ground: 0, h: 0, rock: 0 };
  const kCity = key(K_CITY);
  const cityNoise = (x: number, y: number): number => noise(x, y, kCity);
  // Mirrors surface() in the GLSL, up to the caverns: level and shape the ground around the city of this cell.
  let surface = function (x: number, z: number, out: SurfaceSample): SurfaceSample {
    base(x, z, out);
    const site = cities.at(x, z);
    const cb = cityBlendAt(site, cities.ways(site), x, z, out.h, cityNoise, blend);
    out.h = cb.h;
    out.rock = Math.max(out.rock, cb.paved, cb.rock);
    out.salt *= 1 - cb.flatten;
    out.green = (out.green ?? 0) * (1 - cb.flatten);
    return out;
  };

  // Caverns (mirrors sfCaverns in the GLSL). The numbers are kept as the float32 the shaders get.
  const CV = 15; // floats per cavern
  const cav = new Float32Array(MAX_CAVERNS * CV);
  let cavN = 0;
  /** Where a point lies in cavern i: u along, v off its (bent) centre line, the half-width there. */
  const cf = { u: 0, v: 0, hw: 0, rk: 0 };
  function cavFrame(o: number, ddx: number, ddz: number): void {
    const u = ddx * cav[o + 2] + ddz * cav[o + 3];
    const ramp = cav[o + 10];
    const len = cav[o + 9];
    const er = cav[o + 6] + cav[o + 8];
    cf.u = u;
    cf.v = ddx * -cav[o + 3] + ddz * cav[o + 2] - cav[o + 7] * smoothstep(ramp + 3, ramp + 17, u);
    cf.hw = cav[o + 6] + cav[o + 8] * smoothstep(len - 2 * er - 4, len - er, u);
    cf.rk = smoothstep(cav[o + 11] - 4, cav[o + 11], u);
  }
  function carveCaverns(px: number, pz: number, out: SurfaceSample): void {
    for (let i = 0; i < cavN; i++) {
      const o = i * CV;
      const ddx = f(px - cav[o]);
      const ddz = f(pz - cav[o + 1]);
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 > T.cavernReach * T.cavernReach) continue;
      const dm = 1 - smoothstep(0, 50, d2);
      out.h -= cav[o + 14] * dm * dm;
      const open = cav[o + 13];
      if (open <= 0 || !caveOn) continue;
      cavFrame(o, ddx, ddz);
      const u = cf.u;
      const len = cav[o + 9];
      const sd = cf.hw + 5 + (1.5 - 5) * cf.rk;
      const lat = Math.abs(cf.v);
      const k = open * open * (3 - 2 * open);
      out.rock = Math.max(out.rock, cf.rk * k * (1 - smoothstep(sd + 0.2, sd + 1.6, lat)) * (1 - smoothstep(len + 2.2, len + 3.6, u)));
      const m = (1 - smoothstep(cf.hw, sd, lat)) * smoothstep(-1, 3, u) * (1 - smoothstep(len, len + 2, u));
      if (m <= 0) continue;
      const top = cav[o + 4];
      const floor = cav[o + 5];
      let tgt = floor + (top - floor) * (1 - smoothstep(2, 2 + cav[o + 10], u));
      const pool = cav[o + 12];
      if (pool > 0) {
        // (v is measured from the bent centre line, which has finished bending by the end chamber)
        tgt -= 0.75 * (1 - smoothstep(pool - 2.5, pool, Math.hypot(u - (len - cav[o + 6] - cav[o + 8]), cf.v)));
      }
      const h = out.h;
      out.h = h + (Math.min(h, h + (tgt - h) * m) - h) * k;
    }
  }

  // Mirrors surface() in the GLSL, caverns and all.
  const cities0 = surface;
  surface = (x: number, z: number, out: SurfaceSample): SurfaceSample => {
    cities0(x, z, out);
    if (cavN > 0) carveCaverns(f(x), f(z), out);
    return out;
  };

  const tmp: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  const height = (x: number, z: number): number => surface(x, z, tmp).h;

  return {
    seed,
    cities,
    base,
    river: (x: number, z: number): number => riverDist(f(x), f(z)),
    cave(gi: number, gj: number): Cave | null {
      const ms = mScratch;
      if (!massifAt(gi, gj, ms)) return null;
      caveFrame(ms, 0, 0);
      return { x: ms.x + cvS.ex * 0.5 * ms.r, z: ms.z + cvS.ez * 0.5 * ms.r, dx: -cvS.ex, dz: -cvS.ez };
    },
    caveCeil(x: number, z: number): number {
      const px = f(x);
      const pz = f(z);
      const ms = mScratch;
      if (!massifAt(Math.floor(f(f(px / CITY_CELL) + 0.5)), Math.floor(f(f(pz / CITY_CELL) + 0.5)), ms)) return Infinity;
      caveFrame(ms, px - ms.x, pz - ms.z);
      const a = cvS.along;
      if (Math.abs(cvS.lat) > T.caveHalf + 0.8 || a < T.caveRoofFrom || a > T.caveLen + 1.5) return Infinity;
      // level across the width: the floor on the centre line at this distance in
      const mx = ms.x + cvS.ex * (0.5 * ms.r - a);
      const mz = ms.z + cvS.ez * (0.5 * ms.r - a);
      return height(mx, mz) + T.caveHeight;
    },
    uncarved(x: number, z: number): number {
      caveOn = false;
      const h = height(x, z);
      caveOn = true;
      return h;
    },
    uncarvedSample(x: number, z: number, out: SurfaceSample): SurfaceSample {
      caveOn = false;
      surface(x, z, out);
      caveOn = true;
      return out;
    },
    massif(gi: number, gj: number): Massif | null {
      return massifAt(gi, gj, mScratch) ? { x: mScratch.x, z: mScratch.z, r: mScratch.r, h: mScratch.h } : null;
    },
    setCaverns(list: readonly Cavern[]): void {
      cavN = Math.min(MAX_CAVERNS, list.length);
      for (let i = 0; i < cavN; i++) {
        const c = list[i];
        cav.set([c.x, c.z, c.dx, c.dz, c.top, c.floor, c.half, c.bend, c.bulge, c.len, c.ramp, c.roof, c.pool, c.open, c.dimple], i * CV);
      }
    },
    cavernCeil(x: number, z: number): number {
      const px = f(x);
      const pz = f(z);
      for (let i = 0; i < cavN; i++) {
        const o = i * CV;
        if (cav[o + 13] <= 0) continue;
        const ddx = px - cav[o];
        const ddz = pz - cav[o + 1];
        if (ddx * ddx + ddz * ddz > T.cavernReach * T.cavernReach) continue;
        cavFrame(o, ddx, ddz);
        if (cf.u < cav[o + 11] || cf.u > cav[o + 9] + 1.5 || Math.abs(cf.v) > cf.hw + 0.8) continue;
        return cav[o + 5] + T.cavernHeight;
      }
      return Infinity;
    },
    height,
    sample: (x: number, z: number, out: SurfaceSample): SurfaceSample => surface(x, z, out),
    normal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
      const dx = height(x + 0.5, z) - height(x - 0.5, z);
      const dz = height(x, z + 0.5) - height(x, z - 0.5);
      const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      return out.set(-dx * inv, inv, -dz * inv);
    },
  };
}
