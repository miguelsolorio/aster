// The terrain function, written twice: once in GLSL (SURFACE_GLSL, used by the
// clipmap vertex shader and the heightmap bake) and once in TypeScript
// (createWorld, used by the player and props). Both sides use the same integer
// lattice hash, so the gradient choices are bit-identical; the remaining float
// arithmetic differs only by float32 vs float64 rounding (well under 1 mm).
//
// Every constant below is emitted into the GLSL source, so tune them here.
import type * as THREE from 'three';
import type { SurfaceSample, World } from '../game/contract';

// ---------------------------------------------------------------- tuning

export const TERRAIN = {
  // Regions. Noise inputs are in kilometres; values are wavelengths in km.
  mtnRegionKmX: 9, // mountain-range mask, stretched so ranges run roughly along z
  mtnRegionKmZ: 6,
  mtnLo: 0.12, // mask noise value where mountains start rising
  mtnHi: 0.42, // mask noise value where mountains reach full height
  mtnMin: 150, // peak height of the weakest ranges (m)
  mtnMax: 450, // peak height of the strongest ranges (m)
  ridgeKm: 2.2, // base wavelength of the ridged multifractal
  ridgeOctaves: 5,
  terraceStep: 32, // mesa step height (m)
  terraceLo: 0.15, // dune-region noise value where mesas start replacing ridges
  terraceHi: 0.45,
  rockLo: 22, // mountain height (m) where bare rock starts showing through the sand
  rockHi: 60,
  duneRegionKm: 5, // dune seas vs. rippled flats
  flatLo: -0.25, // region noise below this: flats
  flatHi: 0.1, // region noise above this: full dune sea
  flatAmp: 0.2, // dune amplitude on the flats
  saltRegionKm: 3.6,
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
} as const;

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

// (height m, rock 0..1, salt 0..1). About 13 noise evaluations.
vec3 surface(vec2 p) {
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

float surfaceH(vec2 p) {
  return surface(p).x;
}
`;

// ---------------------------------------------------------------- TypeScript

export function createWorld(seed: number): World {
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

  function surface(x: number, z: number, out: SurfaceSample): SurfaceSample {
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

    const m = smoothstep(T.mtnLo, T.mtnHi, rM);
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

  const tmp: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  const height = (x: number, z: number): number => surface(x, z, tmp).h;

  return {
    seed,
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
