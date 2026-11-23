import * as THREE from 'three';
import type { Uniforms } from '../../game/contract';
import { warmObject } from '../../render/warm';
import { Glows, Writer, layoutOf } from '../build';
import { CITY_SHADOW_GLSL, cityShadowQ } from '../cityGlsl';
import { loadModel, modelGeometry } from '../../render/art';
import { STYLE_GLSL } from '../../render/styleGlsl';
import { GLOW, MAT, createGlowMaterial, createMasonryMaterial, trackViewport } from '../cityShaders';
import type { Extra, ExtraBuilder, ExtraCtx, Solid } from '../extras';
import { bodyFaces } from '../shape';
import type { Building, CityKind } from '../types';

// Street furniture: the small things that make the streets look lived in. Clay jars and
// amphorae in groups, crates, sacks and baskets of goods, handcarts, rugs laid out on the ground,
// rolled and leaning on walls or aired over parapets, benches, ladders against low houses,
// lanterns hung from wall brackets and market poles (lit from dusk), banners on poles round the
// square and at the gates, blade banners on walls, washing lines across the narrow lanes and
// strings of pennants over the market aisles.
//
// Placement: busy where people trade and gather (market bays and stalls, the edge of the square,
// the gates, the avenues), almost bare in the back lanes. Things on the ground hug the walls
// (ctx.streetGap > 0.3 at their edge), keep 1.2 m from where people linger and claim their
// ground so nothing overlaps; washing lines and banners hang over the lanes above head height.
//
// Draws: everything static is merged per 80 m cell into a masonry mesh, hidden beyond HIDE;
// what moves (cloth that waves, lanterns that swing on their chains) goes per cell into a small
// "flex" material of its own that follows the masonry lighting, hidden beyond HIDE_HIGH. All the
// lantern lights are one glow mesh. Bulky props about a step high or more (tall jars, stacked
// crates, handcarts, banner poles) register solids; low and flat things stay walkable.
// Nothing makes a sound.

const TAU = Math.PI * 2;
const CELL = 80;
const HIDE = 220;
const HIDE_HIGH = 350;
const PB = 8; // point bucket size, metres
const SB = 32; // street bucket size

/** Props at density 1 for a city of this kind (about 1000 for a large town). */
const TARGET: Record<CityKind, number> = { trade: 1100, oasis: 1000, canyon: 900, hill: 950 };

const key = (i: number, j: number): number => (i + 4096) * 8192 + (j + 4096);
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const byte = (s: number): number => clamp(Math.round(s * 255), 0, 255);

// ------------------------------------------------------------------ flex material

// The shared uniforms this material reads, with forwarding holders for any the integrator adds
// later (as cityShaders.ts does for the masonry).
const FALLBACKS: Record<string, () => unknown> = {
  uTime: () => 0,
  uSunDir: () => new THREE.Vector3(0, 1, 0),
  uLit: () => new THREE.Color(0.85, 0.66, 0.4),
  uShade: () => new THREE.Color(0.42, 0.28, 0.18),
  uTop: () => new THREE.Color(0.3, 0.5, 0.5),
  uFogCol: () => new THREE.Color(0.7, 0.66, 0.55),
  uFog: () => 0.00012,
  uNight: () => 0,
  uWind: () => new THREE.Vector2(1, 0),
  uCityMap: () => null,
  uCityRect: () => new THREE.Vector4(0, 0, 0, 0),
  uCityGround: () => 0,
  uCityShadowQ: () => cityShadowQ.value,
};

function forward(shared: Uniforms, name: string, fallback: unknown): THREE.IUniform {
  return {
    get value(): unknown {
      const h = shared[name];
      return h ? h.value : fallback;
    },
    set value(v: unknown) {
      const h = shared[name];
      if (h) h.value = v;
    },
  };
}

function withShared(shared: Uniforms): Uniforms {
  const u: Uniforms = { ...shared };
  for (const name of Object.keys(FALLBACKS)) {
    if (!(name in u)) u[name] = forward(shared, name, FALLBACKS[name]());
  }
  return u;
}

const flexVert = /* glsl */ `
attribute vec4 aInfo; // x material id, y tint 0..255, z motion weight 0..255, w stripes
attribute vec2 aUv;
uniform float uTime;
uniform vec2 uWind;
varying vec3 vW;
varying vec3 vN;
varying vec4 vInfo;
varying vec2 vUv;
varying float vFold;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 nw = normalize(mat3(modelMatrix) * normal);
  float s = aInfo.z / 255.0;
  float ph = wp.x * 0.31 + wp.z * 0.23;
  float gust = 0.6 + 0.25 * sin(uTime * 0.7 + ph * 0.4) + 0.15 * sin(uTime * 1.9 + ph * 0.9);
  float fold = 0.0;
  if (aInfo.x > 4.5 && aInfo.x < 5.5) {
    // cloth: blown downwind, with ripples running out along it from where it is held
    fold = sin(uTime * 4.6 + ph * 1.7 - aUv.x * 6.0 - aUv.y * 4.0) * gust;
    wp.xz += uWind * s * gust * 0.26;
    wp.xyz += nw * s * fold * 0.09;
  } else {
    // rigid: a lantern swinging a little on its chain
    vec2 side = vec2(-uWind.y, uWind.x);
    float sw = sin(uTime * 1.4 + ph * 0.8);
    wp.xz += (uWind * (0.4 + 0.6 * gust) + side * sw * 0.7) * s * 0.05;
  }
  vFold = fold * s;
  vW = wp.xyz;
  vN = nw;
  vInfo = aInfo;
  vUv = aUv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const flexFrag = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uTop;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uNight;
varying vec3 vW;
varying vec3 vN;
varying vec4 vInfo;
varying vec2 vUv;
varying float vFold;
${CITY_SHADOW_GLSL}
${STYLE_GLSL}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 dye(float t) {
  float k = floor(t * 4.0);
  return k < 0.5 ? vec3(0.98, 0.72, 0.36)   // ochre
       : k < 1.5 ? vec3(0.46, 0.53, 0.72)   // faded indigo
       : k < 2.5 ? vec3(0.80, 0.42, 0.27)   // rust
       : vec3(0.97, 0.92, 0.82);            // cream
}

void main() {
  float mat = vInfo.x;
  float tint = vInfo.y / 255.0;
  float dist = length(cameraPosition - vW);
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  n = styleFacet(n, vW);
  float ndl = dot(n, uSunDir);
  float l = smoothstep(-0.12, 0.5, ndl);
  bool cloth = mat > 4.5 && mat < 5.5;
  // sun through the cloth: the far side glows a little
  if (cloth) l = max(l, 0.5 * smoothstep(-0.05, 0.5, -ndl));
  l *= cityShadow(vW + n * 0.45, uSunDir);
  l = styleBands(l, vW.xz);
  l += (1.0 - l) * uNight * 0.16;

  vec3 sh;
  vec3 li;
  if (cloth) {
    vec3 d = dye(tint);
    if (vInfo.w > 0.5) {
      float st = step(0.5, fract(vUv.x * vInfo.w * 0.5));
      d = mix(d, tint < 0.75 ? vec3(0.96, 0.9, 0.8) : vec3(0.62, 0.36, 0.24), st * 0.8);
    }
    sh = mix(d * uShade, d * lum(uShade), 0.5) * 1.15;
    li = mix(d * uLit, d * lum(uLit), 0.5) * 1.12;
  } else if (mat > 6.5 && mat < 7.5) { // lantern glass
    sh = uShade * 0.5;
    li = uLit * 0.7;
  } else {                              // wood, rope, metal
    sh = uShade * vec3(0.55, 0.45, 0.38) * (0.85 + 0.3 * tint);
    li = uLit * vec3(0.52, 0.40, 0.31) * (0.85 + 0.3 * tint);
  }
  vec3 col = mix(sh, li, l);
  col *= 1.0 + 0.12 * vFold; // the folds catch the light as they ripple
  col += uTop * 0.06 * max(n.y, 0.0) * (1.0 - 0.6 * l);

  float on = 0.0;
  if (mat > 6.5 && mat < 7.5) {
    on = smoothstep(0.08, 0.35, uNight);
    col = mix(col, vec3(1.0, 0.74, 0.42) * 1.25, on);
  }
  float fogA = 1.0 - exp(-dist * uFog);
  fogA *= 1.0 - 0.55 * on;
  col = mix(col, uFogCol, fogA);
  gl_FragColor = vec4(col, 1.0);
}
`;

function createFlexMaterial(shared: Uniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: withShared(shared),
    vertexShader: flexVert,
    fragmentShader: flexFrag,
    side: THREE.DoubleSide,
  });
}

// ------------------------------------------------------------------ geometry helpers

/** Ring of `sides` vertices with normals tilted by ny; returns the index of the first. */
function ring(w: Writer, x: number, y: number, z: number, r: number, sides: number, rot: number, ny: number): number {
  const st = w.nv;
  const k = Math.sqrt(Math.max(0, 1 - ny * ny));
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TAU;
    const c = Math.cos(a), q = Math.sin(a);
    w.vert(x + c * r, y, z + q * r, c * k, ny, q * k, i / sides, 0);
  }
  return st;
}

function band(w: Writer, a: number, b: number, sides: number): void {
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    w.index3(a + i, a + j, b + j);
    w.index3(a + i, b + j, b + i);
  }
}

function cap(w: Writer, a: number, tip: number, sides: number): void {
  for (let i = 0; i < sides; i++) w.index3(a + i, a + ((i + 1) % sides), tip);
}

/**
 * A turned shape from (radius, height) pairs listed from the foot up, scaled by sr and sh.
 * topMat < 0 closes the top in the body's material; otherwise the mouth is filled a little
 * below the rim with topMat (an opening, or the goods in a basket).
 */
function lathe(
  w: Writer, x: number, y: number, z: number, prof: readonly number[], sr: number, sh: number,
  sides: number, rot: number, topMat: number, topTint: number,
): void {
  const n = prof.length / 2;
  w.reserve(n * sides + sides + 1, (n - 1) * sides * 6 + sides * 9);
  let prev = -1;
  for (let k = 0; k < n; k++) {
    const kp = Math.max(0, k - 1), kn = Math.min(n - 1, k + 1);
    const dr = (prof[kn * 2] - prof[kp * 2]) * sr, dh = (prof[kn * 2 + 1] - prof[kp * 2 + 1]) * sh;
    const l = Math.hypot(dr, dh) || 1;
    const cur = ring(w, x, y + prof[k * 2 + 1] * sh, z, prof[k * 2] * sr, sides, rot, -dr / l);
    if (prev >= 0) band(w, prev, cur, sides);
    prev = cur;
  }
  const rt = prof[(n - 1) * 2] * sr, yt = y + prof[(n - 1) * 2 + 1] * sh;
  if (topMat < 0) {
    const c = w.vert(x, yt + rt * 0.15, z, 0, 1, 0, 0.5, 0.5);
    cap(w, prev, c, sides);
    return;
  }
  const mat = w.mat, tint = w.tint;
  w.mat = topMat;
  w.tint = topTint;
  const inner = ring(w, x, yt - 0.02 * sh, z, rt * 0.8, sides, rot, 1);
  band(w, prev, inner, sides);
  const c = w.vert(x, yt - (topMat === MAT.opening ? 0.1 : 0.03) * sh, z, 0, 1, 0, 0.5, 0.5);
  cap(w, inner, c, sides);
  w.mat = mat;
  w.tint = tint;
}

/** A tube (or a tapered prism) from a to b. caps closes both ends. */
function tube(
  w: Writer, ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  r0: number, r1: number, sides: number, rot: number, caps: boolean,
): void {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = Math.hypot(dx, dy, dz) || 1;
  dx /= L;
  dy /= L;
  dz /= L;
  // e: a unit vector across the axis; f = d x e completes the frame
  let ex: number, ey: number, ez: number;
  if (Math.abs(dy) < 0.9) {
    ex = -dz;
    ey = 0;
    ez = dx;
  } else {
    ex = 0;
    ey = dz;
    ez = -dy;
  }
  const el = Math.hypot(ex, ey, ez) || 1;
  ex /= el;
  ey /= el;
  ez /= el;
  const fx = dy * ez - dz * ey, fy = dz * ex - dx * ez, fz = dx * ey - dy * ex;
  w.reserve(sides * (caps ? 4 : 2) + (caps ? 2 : 0), sides * (caps ? 12 : 6));
  const put = (cx: number, cy: number, cz: number, r: number, v: number, axial: number): number => {
    const st = w.nv;
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      const nx = ex * c + fx * s, ny = ey * c + fy * s, nz = ez * c + fz * s;
      if (axial === 0) w.vert(cx + nx * r, cy + ny * r, cz + nz * r, nx, ny, nz, i / sides, v);
      else w.vert(cx + nx * r, cy + ny * r, cz + nz * r, dx * axial, dy * axial, dz * axial, i / sides, v);
    }
    return st;
  };
  const a = put(ax, ay, az, r0, 0, 0);
  const b = put(bx, by, bz, r1, 1, 0);
  band(w, a, b, sides);
  if (caps) {
    const ca = put(ax, ay, az, r0, 0, -1);
    cap(w, ca, w.vert(ax, ay, az, -dx, -dy, -dz, 0.5, 0), sides);
    const cb = put(bx, by, bz, r1, 1, 1);
    cap(w, cb, w.vert(bx, by, bz, dx, dy, dz, 0.5, 1), sides);
  }
}

/**
 * A box turned about y: long axis (ux, uz), half extents hu along it and hn across it.
 * mask bits: 1 +u, 2 -u, 4 top, 8 bottom, 16 +n, 32 -n. inward flips the faces to look inside.
 */
function ybox(
  w: Writer, cx: number, cz: number, ux: number, uz: number, hu: number, hn: number,
  y0: number, y1: number, mask = 55, inward = false,
): void {
  const vx = -uz, vz = ux;
  const s = inward ? -1 : 1;
  // corners: A+ A- at the +u end, B+ B- at the -u end (+/- across)
  const ax = cx + ux * hu, az = cz + uz * hu;
  const bx = cx - ux * hu, bz = cz - uz * hu;
  const Apx = ax + vx * hn, Apz = az + vz * hn, Amx = ax - vx * hn, Amz = az - vz * hn;
  const Bpx = bx + vx * hn, Bpz = bz + vz * hn, Bmx = bx - vx * hn, Bmz = bz - vz * hn;
  if (mask & 1) w.quad(Amx, y0, Amz, Apx, y0, Apz, Apx, y1, Apz, Amx, y1, Amz, ux * s, 0, uz * s);
  if (mask & 2) w.quad(Bpx, y0, Bpz, Bmx, y0, Bmz, Bmx, y1, Bmz, Bpx, y1, Bpz, -ux * s, 0, -uz * s);
  if (mask & 4) w.quad(Bmx, y1, Bmz, Amx, y1, Amz, Apx, y1, Apz, Bpx, y1, Bpz, 0, s, 0);
  if (mask & 8) w.quad(Bmx, y0, Bmz, Bpx, y0, Bpz, Apx, y0, Apz, Amx, y0, Amz, 0, -s, 0);
  if (mask & 16) w.quad(Bpx, y0, Bpz, Apx, y0, Apz, Apx, y1, Apz, Bpx, y1, Bpz, vx * s, 0, vz * s);
  if (mask & 32) w.quad(Amx, y0, Amz, Bmx, y0, Bmz, Bmx, y1, Bmz, Amx, y1, Amz, -vx * s, 0, -vz * s);
}

const P3 = [0, 0, 0];

/** A sheet of nu x nv quads: at(u, v) places a vertex, wt(u, v) is its motion weight 0..1. */
function sheet(
  f: Writer, nu: number, nv: number, nx: number, ny: number, nz: number,
  at: (u: number, v: number, p: number[]) => void, wt: (u: number, v: number) => number,
): void {
  f.reserve((nu + 1) * (nv + 1), nu * nv * 6);
  const st = f.nv;
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv;
      at(u, v, P3);
      f.seed = byte(wt(u, v));
      f.vert(P3[0], P3[1], P3[2], nx, ny, nz, u, v);
    }
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a = st + j * (nu + 1) + i;
      f.index3(a, a + 1, a + nu + 2);
      f.index3(a, a + nu + 2, a + nu + 1);
    }
  f.seed = 0;
}

/** A thin cord from a to b drawn as two crossed ribbons, with motion weights s0 and s1 at its ends. */
function cord(
  f: Writer, ax: number, ay: number, az: number, bx: number, by: number, bz: number, hw: number, s0: number, s1: number,
): void {
  const dx = bx - ax, dz = bz - az;
  const l = Math.hypot(dx, dz);
  // A sloping cord: one ribbon standing up, one lying flat across it. A hanging (vertical)
  // cord: two upright ribbons, one along x and one along z.
  const flat = l > 1e-3;
  const cx = flat ? -dz / l : 1, cz = flat ? dx / l : 0;
  // offsets (o) and normals (m) of the two ribbons
  const o1x = flat ? 0 : hw, o1y = flat ? hw : 0, o1z = 0;
  const m1x = flat ? cx : 0, m1z = flat ? cz : 1;
  const o2x = flat ? cx * hw : 0, o2z = flat ? cz * hw : hw;
  const m2x = flat ? 0 : 1, m2y = flat ? 1 : 0;
  f.reserve(8, 12);
  for (let k = 0; k < 2; k++) {
    const ox = k === 0 ? o1x : o2x, oy = k === 0 ? o1y : 0, oz = k === 0 ? o1z : o2z;
    const mx = k === 0 ? m1x : m2x, my = k === 0 ? 0 : m2y, mz = k === 0 ? m1z : 0;
    f.seed = byte(s0);
    const v0 = f.vert(ax - ox, ay - oy, az - oz, mx, my, mz, 0, 0);
    const v1 = f.vert(ax + ox, ay + oy, az + oz, mx, my, mz, 1, 0);
    f.seed = byte(s1);
    const v2 = f.vert(bx + ox, by + oy, bz + oz, mx, my, mz, 1, 1);
    const v3 = f.vert(bx - ox, by - oy, bz - oz, mx, my, mz, 0, 1);
    f.index3(v0, v1, v2);
    f.index3(v0, v2, v3);
  }
  f.seed = 0;
}

// ------------------------------------------------------------------ modelled furniture

// public/art/furniture.glb (tools/blender/furniture.py) holds modelled jars, sacks, baskets,
// crates, benches, handcarts and lanterns, drawn in the frames the props below size them in.
// Until it has loaded, and wherever it cannot be had, the procedural props are drawn. Every prop
// takes the same draws from the shared rng either way (the model's variant comes from a hash of
// its position), so a town is laid out the same with or without the file; a town built before it
// arrives is rebuilt once from the models when it does. Each vertex carries _info: x a part
// (below), y a tint (a signed offset / 255 for body and goods, else 0..1), and _grain, the wood's
// texture coordinates.

const PART = { body: 0, opening: 1, goods: 2, rope: 3, iron: 4, glass: 5 } as const;

interface Model {
  pos: Float32Array;
  nrm: Float32Array;
  info: Float32Array;
  uv: Float32Array;
  index: ArrayLike<number>;
}

interface Furn {
  /** By jar kind: water jars, amphorae, jugs. */
  jar: Model[][];
  sack: Model[];
  basket: Model[];
  crateShut: Model[];
  crateOpen: Model[];
  /** Two legs (seat half length 0.7), three legs (1.05). */
  bench: Model[];
  cart: Model[];
  lantern: Model[];
}

let FURN: Furn | null = null;
let furnLoad: Promise<Furn | null> | null = null;

/** The crate the models were drawn for (half sizes and height). */
const CRATE_HU = 0.29, CRATE_HN = 0.25, CRATE_HH = 0.42;
const BENCH_HL = [0.7, 1.05];

function modelOf(gltf: Parameters<typeof modelGeometry>[0], name: string): Model | null {
  const g = modelGeometry(gltf, name);
  const info = g?.getAttribute('_info');
  const uv = g?.getAttribute('_grain');
  if (!g || !info || info.itemSize !== 3 || !uv || uv.itemSize !== 2) return null;
  g.computeVertexNormals();
  const n = g.getAttribute('position').count;
  const index = g.getIndex()?.array ?? Array.from({ length: n }, (_, i) => i);
  return {
    pos: Float32Array.from(g.getAttribute('position').array),
    nrm: Float32Array.from(g.getAttribute('normal').array),
    info: Float32Array.from(info.array),
    uv: Float32Array.from(uv.array),
    index,
  };
}

/** Starts loading the modelled furniture (once); resolves to it, or null without the file. */
function loadFurniture(): Promise<Furn | null> {
  if (!furnLoad) {
    furnLoad = loadModel('furniture.glb').then((gltf) => {
      if (!gltf) return null;
      const set = (base: string, n: number): Model[] | null => {
        const out: Model[] = [];
        for (let i = 0; i < n; i++) {
          const m = modelOf(gltf, `${base}${i}`);
          if (!m) return null;
          out.push(m);
        }
        return out;
      };
      const jar = set('Jar', 3), amph = set('Amphora', 2), jug = set('Jug', 2);
      const sack = set('Sack', 3), basket = set('Basket', 3);
      const crateShut = set('CrateShut', 2), crateOpen = set('CrateOpen', 2);
      const bench = set('Bench', 2), cart = set('Cart', 2), lantern = set('Lantern', 2);
      if (!jar || !amph || !jug || !sack || !basket || !crateShut || !crateOpen || !bench || !cart || !lantern) return null;
      FURN = { jar: [jar, amph, jug], sack, basket, crateShut, crateOpen, bench, cart, lantern };
      return FURN;
    });
  }
  return furnLoad;
}

/** A small hash of a position, 0..1, so a modelled prop picks the same variant whenever it is built. */
function hashXZ(x: number, z: number, salt: number): number {
  let h = Math.imul(Math.round(x * 16) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(z * 16) | 0, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const variant = (ms: readonly Model[], x: number, y: number, z: number, salt: number): Model =>
  ms[Math.min(ms.length - 1, Math.floor(hashXZ(x + y * 3.7, z, salt) * ms.length))];

/** Sets w.mat and w.tint for a vertex of the given part and tint. */
type Look = (w: Writer, part: number, t: number) => void;

/**
 * Writes a model's triangles into w at (x, y, z): its x axis along (ux, uz), its z axis across
 * (-uz, ux), scaled by su, sy, sn along them. Normals follow the scale (inverse transpose).
 */
function stamp(
  w: Writer, m: Model, x: number, y: number, z: number, ux: number, uz: number,
  su: number, sy: number, sn: number, look: Look,
): void {
  const vx = -uz, vz = ux;
  const nv = m.pos.length / 3;
  w.reserve(nv, m.index.length);
  const base = w.nv;
  for (let i = 0; i < nv; i++) {
    const p = i * 3;
    const px = m.pos[p] * su, py = m.pos[p + 1] * sy, pz = m.pos[p + 2] * sn;
    const ax = m.nrm[p] / su, ay = m.nrm[p + 1] / sy, az = m.nrm[p + 2] / sn;
    const nx = ux * ax + vx * az, nz = uz * ax + vz * az;
    const l = Math.hypot(nx, ay, nz) || 1;
    look(w, m.info[p], m.info[p + 1]);
    w.vert(x + ux * px + vx * pz, y + py, z + uz * px + vz * pz, nx / l, ay / l, nz / l, m.uv[i * 2], m.uv[i * 2 + 1]);
  }
  const I = m.index;
  for (let t = 0; t < I.length; t += 3) w.index3(base + I[t], base + I[t + 1], base + I[t + 2]);
}

/** The usual look: body in the prop's material and tint, goods in cloth, rope and iron as wood/stone. */
function looks(mat: number, tint: number, goods = 0, ironMat: number = MAT.stone): Look {
  return (w, part, t) => {
    const k = Math.round(part);
    if (k === PART.body) {
      w.mat = mat;
      w.tint = clamp(Math.round(tint + t * 255), 0, 255);
    } else if (k === PART.opening) {
      w.mat = MAT.opening;
      w.tint = 128;
    } else if (k === PART.goods) {
      w.mat = MAT.cloth;
      w.tint = clamp(Math.round(goods + t * 255), 0, 255);
    } else if (k === PART.rope) {
      w.mat = MAT.wood;
      w.tint = byte(t);
    } else if (k === PART.iron) {
      w.mat = ironMat;
      w.tint = byte(t);
    } else {
      w.mat = MAT.lantern;
      w.tint = 128;
    }
  };
}

/** A prop's geometry, written into w from the models (M) or procedurally (M null). Takes no draws. */
type Emit = (w: Writer, M: Furn | null) => void;

/** A prop written into a writer: its vertex and index ranges, and how to write it again. */
interface Op {
  v0: number;
  v1: number;
  i0: number;
  i1: number;
  emit: Emit;
}

/** While a town is built without the models, what each writer holds of the props they replace. */
let replay: Map<Writer, Op[]> | null = null;

/** Writes a prop into w now, and records it for a rebuild from the models if one may follow. */
function put(w: Writer, emit: Emit): void {
  const v0 = w.nv, i0 = w.ni;
  emit(w, FURN);
  if (!replay) return;
  const op = { v0, v1: w.nv, i0, i1: w.ni, emit };
  const l = replay.get(w);
  if (l) l.push(op);
  else replay.set(w, [op]);
}

/** src written again with its recorded props drawn from the models; everything else copied. */
function rebuilt(src: Writer, ops: readonly Op[], M: Furn): Writer {
  const w = new Writer(src.nv + 4096, src.ni + 8192);
  let v = 0, i = 0;
  const copy = (v1: number, i1: number): void => {
    const nv = v1 - v, ni = i1 - i;
    w.reserve(nv, ni);
    const off = w.nv - v;
    w.pos.set(src.pos.subarray(v * 3, v1 * 3), w.nv * 3);
    w.nrm.set(src.nrm.subarray(v * 3, v1 * 3), w.nv * 3);
    w.info.set(src.info.subarray(v * 4, v1 * 4), w.nv * 4);
    w.uvs.set(src.uvs.subarray(v * 2, v1 * 2), w.nv * 2);
    w.nv += nv;
    for (let k = i; k < i1; k++) w.idx[w.ni++] = src.idx[k] + off;
  };
  for (const op of ops) {
    copy(op.v0, op.i0);
    op.emit(w, M);
    w.seed = 0;
    w.extra = 0;
    v = op.v1;
    i = op.i1;
  }
  copy(src.nv, src.ni);
  w.orient();
  return w;
}

// ------------------------------------------------------------------ props

/** Where the props below register their solids while a city is being built (set by the builder). */
let solidSink: Solid[] | null = null;
/** Props at least this tall (about a step) get a solid. */
const SOLID_MIN = 0.75;


// Profiles (radius, height) from the foot up, for a height of 1.
const JAR = [0.2, 0, 0.31, 0.1, 0.37, 0.36, 0.33, 0.62, 0.21, 0.82, 0.15, 0.92, 0.19, 1];
const AMPHORA = [0.06, 0, 0.14, 0.12, 0.24, 0.42, 0.24, 0.6, 0.15, 0.78, 0.085, 0.88, 0.08, 0.98, 0.11, 1.02];
const JUG = [0.15, 0, 0.23, 0.18, 0.25, 0.38, 0.16, 0.62, 0.09, 0.76, 0.12, 0.84];
const SACK = [0.85, 0, 1, 0.2, 0.97, 0.55, 0.72, 0.8, 0.32, 0.92, 0.38, 1];
const BASKET = [0.72, 0, 0.95, 0.5, 1, 0.62];

/** Widest radius of each jar kind for a height of 1. */
const JAR_R = [0.37, 0.24, 0.25];

/** A clay jar (0), an amphora (1) or a jug (2) of height s standing at (x, y, z). */
function jar(w: Writer, x: number, y: number, z: number, s: number, kind: number, rng: () => number): void {
  put(w, drawJar(x, y, z, s, kind, rng));
}

function drawJar(x: number, y: number, z: number, s: number, kind: number, rng: () => number): Emit {
  const pick = rng();
  let mat: number, tint: number;
  if (pick < 0.62) {
    mat = MAT.cloth; // terracotta: the rust of the dye ramp
    tint = 140 + Math.floor(rng() * 45);
  } else if (pick < 0.8) {
    mat = MAT.plaster; // limewashed
    tint = 10 + Math.floor(rng() * 100);
  } else if (pick < 0.9) {
    mat = MAT.cloth; // a faded blue glaze
    tint = 70 + Math.floor(rng() * 50);
  } else {
    mat = MAT.dome; // pale glaze
    tint = 128;
  }
  const rot = rng() * TAU;
  const jh = s * (kind === 1 ? 1.02 : kind === 2 ? 0.84 : 1);
  if (solidSink && jh >= SOLID_MIN) {
    const jr = JAR_R[kind] * s;
    solidSink.push({ x, z, hw: jr, hd: jr, y0: y - 1, y1: y + jh });
  }
  return (w, M) => {
    w.mat = mat;
    w.tint = tint;
    if (M) {
      stamp(w, variant(M.jar[kind], x, y, z, 11), x, y - 0.02, z, Math.cos(rot), Math.sin(rot), s, s, s, looks(mat, tint));
      return;
    }
    jarShape(w, x, y, z, s, kind, rot);
  };
}

function jarShape(w: Writer, x: number, y: number, z: number, s: number, kind: number, rot: number): void {
  const prof = kind === 0 ? JAR : kind === 1 ? AMPHORA : JUG;
  lathe(w, x, y - 0.02, z, prof, s, s, kind === 2 ? 6 : 7, rot, MAT.opening, 128);
  if (kind === 1) {
    // two loop handles from the neck to the shoulder
    for (const side of [0, Math.PI]) {
      const c = Math.cos(rot + side), q = Math.sin(rot + side);
      const nx = x + c * 0.09 * s, nz = z + q * 0.09 * s, ny = y + 0.88 * s;
      const ex = x + c * 0.2 * s, ez = z + q * 0.2 * s, ey = y + 0.86 * s;
      const sx = x + c * 0.22 * s, sz = z + q * 0.22 * s, sy = y + 0.66 * s;
      tube(w, nx, ny, nz, ex, ey, ez, 0.018 * s + 0.004, 0.018 * s + 0.004, 4, 0, false);
      tube(w, ex, ey, ez, sx, sy, sz, 0.018 * s + 0.004, 0.018 * s + 0.004, 4, 0, false);
    }
  }
}

/** Goods colours: grain and dates (ochre), spice (rust), cotton (cream), dyed wool (indigo). */
function goodsTint(rng: () => number): number {
  const r = rng();
  return r < 0.4 ? Math.floor(rng() * 60) : r < 0.7 ? 135 + Math.floor(rng() * 50) : r < 0.88 ? 200 + Math.floor(rng() * 55) : 70 + Math.floor(rng() * 50);
}

/** A wooden crate, closed or open and heaped with goods. */
function crate(
  w: Writer, x: number, y: number, z: number, ux: number, uz: number, hu: number, hn: number, hh: number,
  open: boolean, rng: () => number,
): void {
  const t = 110 + Math.floor(rng() * 110);
  const goods = open ? goodsTint(rng) : 0;
  put(w, (w, M) => {
    if (M) {
      const m = variant(open ? M.crateOpen : M.crateShut, x, y, z, 13);
      stamp(w, m, x, y, z, ux, uz, hu / CRATE_HU, hh / CRATE_HH, hn / CRATE_HN, looks(MAT.wood, t, goods));
      return;
    }
    crateShape(w, x, y, z, ux, uz, hu, hn, hh, open, t, goods);
  });
}

function crateShape(
  w: Writer, x: number, y: number, z: number, ux: number, uz: number, hu: number, hn: number, hh: number,
  open: boolean, t: number, goods: number,
): void {
  w.mat = MAT.wood;
  w.tint = t;
  if (!open) {
    ybox(w, x, z, ux, uz, hu, hn, y, y + hh, 1 | 2 | 4 | 16 | 32);
    // a batten round the middle
    w.tint = Math.max(0, t - 60);
    ybox(w, x, z, ux, uz, hu + 0.012, hn + 0.012, y + hh * 0.42, y + hh * 0.56, 1 | 2 | 16 | 32);
    return;
  }
  ybox(w, x, z, ux, uz, hu, hn, y, y + hh, 1 | 2 | 16 | 32);
  ybox(w, x, z, ux, uz, hu - 0.025, hn - 0.025, y + hh * 0.7, y + hh, 1 | 2 | 16 | 32, true);
  // the rim
  w.tint = Math.max(0, t - 30);
  const vx = -uz, vz = ux;
  const yt = y + hh;
  for (const sg of [1, -1]) {
    const cx = x + ux * sg * (hu - 0.0125), cz = z + uz * sg * (hu - 0.0125);
    ybox(w, cx, cz, ux, uz, 0.0125, hn, yt - 0.001, yt + 0.001, 4);
    const dx = x + vx * sg * (hn - 0.0125), dz = z + vz * sg * (hn - 0.0125);
    ybox(w, dx, dz, ux, uz, hu, 0.0125, yt - 0.001, yt + 0.001, 4);
  }
  // goods heaped a little in the middle
  w.mat = MAT.cloth;
  w.tint = goods;
  const yg = y + hh * 0.86;
  const hx = (a: number, b: number): number => x + ux * a + vx * b;
  const hz = (a: number, b: number): number => z + uz * a + vz * b;
  const iu = hu - 0.025, iv = hn - 0.025;
  w.reserve(5, 12);
  const c0 = w.vert(hx(-iu, -iv), yg, hz(-iu, -iv), 0, 1, 0, 0, 0);
  const c1 = w.vert(hx(iu, -iv), yg, hz(iu, -iv), 0, 1, 0, 1, 0);
  const c2 = w.vert(hx(iu, iv), yg, hz(iu, iv), 0, 1, 0, 1, 1);
  const c3 = w.vert(hx(-iu, iv), yg, hz(-iu, iv), 0, 1, 0, 0, 1);
  const top = w.vert(x, yg + Math.min(iu, iv) * 0.5, z, 0, 1, 0, 0.5, 0.5);
  w.index3(c0, c1, top);
  w.index3(c1, c2, top);
  w.index3(c2, c3, top);
  w.index3(c3, c0, top);
}

/** A tied sack of grain or cotton. */
function sack(w: Writer, x: number, y: number, z: number, r: number, h: number, rng: () => number): void {
  put(w, drawSack(x, y, z, r, h, rng));
}

function drawSack(x: number, y: number, z: number, r: number, h: number, rng: () => number): Emit {
  const p = rng();
  const tint = p < 0.55 ? 205 + Math.floor(rng() * 50) : p < 0.85 ? Math.floor(rng() * 55) : 140 + Math.floor(rng() * 40);
  const rot = rng() * TAU;
  return (w, M) => {
    w.mat = MAT.cloth;
    w.tint = tint;
    if (M) stamp(w, variant(M.sack, x, y, z, 17), x, y - 0.02, z, Math.cos(rot), Math.sin(rot), r, h, r, looks(MAT.cloth, tint));
    else lathe(w, x, y - 0.02, z, SACK, r, h, 6, rot, -1, 0);
  };
}

/** A wide wicker basket heaped with goods. */
function basket(w: Writer, x: number, y: number, z: number, r: number, h: number, rng: () => number): void {
  const tint = 200 + Math.floor(rng() * 55);
  const rot = rng() * TAU;
  const goods = goodsTint(rng);
  put(w, (w, M) => {
    w.mat = MAT.wood;
    w.tint = tint;
    if (M) stamp(w, variant(M.basket, x, y, z, 19), x, y - 0.01, z, Math.cos(rot), Math.sin(rot), r, h, r, looks(MAT.wood, tint, goods));
    else lathe(w, x, y - 0.01, z, BASKET, r, h, 7, rot, MAT.cloth, goods);
  });
}

/** A rug laid flat: a plain border and a striped field. */
function flatRug(w: Writer, x: number, y: number, z: number, ux: number, uz: number, hl: number, hw: number, rng: () => number): void {
  const vx = -uz, vz = ux;
  const P = (a: number, b: number, yy: number): [number, number, number] => [x + ux * a + vx * b, yy, z + uz * a + vz * b];
  w.mat = MAT.cloth;
  w.tint = Math.floor(rng() * 255);
  w.extra = 0;
  const y0 = y + 0.012;
  const a = P(-hl, -hw, y0), b = P(hl, -hw, y0), c = P(hl, hw, y0), d = P(-hl, hw, y0);
  w.quad(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2], 0, 1, 0);
  w.tint = Math.floor(rng() * 255);
  w.extra = 4 + Math.floor(rng() * 12);
  const y1 = y + 0.02, i = 0.12;
  const e = P(-hl + i, -hw + i, y1), g = P(hl - i, -hw + i, y1), h = P(hl - i, hw - i, y1), k = P(-hl + i, hw - i, y1);
  w.quad(e[0], e[1], e[2], g[0], g[1], g[2], h[0], h[1], h[2], k[0], k[1], k[2], 0, 1, 0);
  w.extra = 0;
}

/** A pile of folded rugs. */
function rugPile(w: Writer, x: number, y: number, z: number, ux: number, uz: number, rng: () => number): number {
  const n = 2 + Math.floor(rng() * 4);
  let yy = y;
  w.mat = MAT.cloth;
  for (let k = 0; k < n; k++) {
    w.tint = Math.floor(rng() * 255);
    w.extra = rng() < 0.6 ? 4 + Math.floor(rng() * 8) : 0;
    const t = 0.06 + rng() * 0.04;
    ybox(w, x + (rng() - 0.5) * 0.06, z + (rng() - 0.5) * 0.06, ux, uz, 0.42 - k * 0.02, 0.3 - k * 0.015, yy, yy + t, 1 | 2 | 4 | 16 | 32);
    yy += t;
  }
  w.extra = 0;
  return yy;
}

/** A bench along (ux, uz): planks on legs, or a plastered block with a stone top. */
function bench(w: Writer, x: number, y: number, z: number, ux: number, uz: number, hl: number, rng: () => number): void {
  if (rng() < 0.55) {
    const tint = 70 + Math.floor(rng() * 110);
    put(w, (w, M) => {
      w.mat = MAT.wood;
      w.tint = tint;
      if (M) {
        const k = hl > 0.9 ? 1 : 0;
        stamp(w, M.bench[k], x, y, z, ux, uz, hl / BENCH_HL[k], 1, 1, looks(MAT.wood, tint));
        return;
      }
      benchShape(w, x, y, z, ux, uz, hl);
    });
  } else {
    w.mat = MAT.plaster;
    w.tint = Math.floor(rng() * 120);
    ybox(w, x, z, ux, uz, hl, 0.21, y - 0.05, y + 0.4, 1 | 2 | 16 | 32);
    w.mat = MAT.stone;
    w.tint = 100 + Math.floor(rng() * 100);
    ybox(w, x, z, ux, uz, hl + 0.03, 0.24, y + 0.4, y + 0.47);
  }
}

/** The wooden bench: planks on legs. */
function benchShape(w: Writer, x: number, y: number, z: number, ux: number, uz: number, hl: number): void {
  ybox(w, x, z, ux, uz, hl, 0.2, y + 0.38, y + 0.45);
  const n = hl > 0.9 ? 3 : 2;
  for (let k = 0; k < n; k++) {
    const a = -hl + 0.12 + ((2 * hl - 0.24) * k) / (n - 1);
    ybox(w, x + ux * a, z + uz * a, ux, uz, 0.04, 0.16, y - 0.02, y + 0.38, 1 | 2 | 16 | 32);
  }
}

/**
 * A two-wheeled handcart along (ux, uz), its shafts resting on the ground ahead (+u).
 * The bed spans u in [-0.65, 0.65], the wheels sit at +-0.5 across.
 */
function cart(w: Writer, x: number, y: number, z: number, ux: number, uz: number, rng: () => number): void {
  const vx = -uz, vz = ux;
  const t = 70 + Math.floor(rng() * 100);
  const yb = y + 0.5;
  if (solidSink) {
    // the bed and its wheels, three boxes along the cart so a diagonal one is not one fat box;
    // the thin shafts ahead stay walkable
    const ax = Math.abs(ux), az = Math.abs(uz);
    for (let k = 0; k < 3; k++) {
      const a = (k - 1) * (0.65 * 2) / 3, hs = 0.65 / 3;
      solidSink.push({
        x: x + ux * a, z: z + uz * a,
        hw: ax * hs + az * 0.54, hd: az * hs + ax * 0.54,
        y0: y - 1, y1: y + 0.87,
      });
    }
  }
  // a load on the bed, now and then
  const load: Emit[] = [];
  if (rng() < 0.6) {
    const n = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const a = -0.35 + (0.7 * (k + 0.5)) / n;
      const cx = x + ux * a + vx * (rng() - 0.5) * 0.2, cz = z + uz * a + vz * (rng() - 0.5) * 0.2;
      if (rng() < 0.6) load.push(drawSack(cx, yb + 0.07, cz, 0.18, 0.42, rng));
      else load.push(drawJar(cx, yb + 0.07, cz, 0.45, 2, rng));
    }
  }
  put(w, (w, M) => {
    w.mat = MAT.wood;
    w.tint = t;
    if (M) stamp(w, variant(M.cart, x, y, z, 23), x, y, z, ux, uz, 1, 1, 1, looks(MAT.wood, t));
    else cartShape(w, x, y, z, ux, uz, t);
    for (const e of load) e(w, M);
  });
}

function cartShape(w: Writer, x: number, y: number, z: number, ux: number, uz: number, t: number): void {
  const vx = -uz, vz = ux;
  const yb = y + 0.5;
  ybox(w, x, z, ux, uz, 0.65, 0.42, yb, yb + 0.07);
  for (const s of [1, -1]) {
    ybox(w, x + vx * s * 0.4, z + vz * s * 0.4, ux, uz, 0.65, 0.022, yb + 0.07, yb + 0.3, 1 | 2 | 4 | 16 | 32);
    ybox(w, x + ux * s * 0.63, z + uz * s * 0.63, ux, uz, 0.022, 0.38, yb + 0.07, yb + 0.26, 1 | 2 | 4 | 16 | 32);
  }
  // shafts down to the ground ahead
  for (const s of [1, -1]) {
    tube(w, x + ux * 0.55 + vx * s * 0.34, yb + 0.02, z + uz * 0.55 + vz * s * 0.34,
      x + ux * 1.8 + vx * s * 0.28, y + 0.05, z + uz * 1.8 + vz * s * 0.28, 0.035, 0.03, 4, Math.PI / 4, false);
  }
  // axle and wheels
  w.tint = Math.max(0, t - 40);
  const ya = y + 0.42;
  tube(w, x - vx * 0.5, ya, z - vz * 0.5, x + vx * 0.5, ya, z + vz * 0.5, 0.04, 0.04, 4, 0, false);
  for (const s of [1, -1]) {
    tube(w, x + vx * s * 0.47, ya, z + vz * s * 0.47, x + vx * s * 0.54, ya, z + vz * s * 0.54, 0.42, 0.42, 8, 0, true);
  }
}

/** A ladder from its foot (fx, fz) to its top (tx, ty, tz), rungs along (ux, uz). */
function ladder(w: Writer, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, ux: number, uz: number, rng: () => number): void {
  w.mat = MAT.wood;
  w.tint = 60 + Math.floor(rng() * 90);
  const hw = 0.21;
  for (const s of [1, -1]) {
    tube(w, fx + ux * hw * s, fy - 0.02, fz + uz * hw * s, tx + ux * hw * s, ty, tz + uz * hw * s, 0.032, 0.03, 4, Math.PI / 4, false);
  }
  const L = ty - fy;
  for (let yy = 0.3; yy < L - 0.15; yy += 0.31) {
    const k = yy / L;
    const cx = fx + (tx - fx) * k, cy = fy + yy, cz = fz + (tz - fz) * k;
    tube(w, cx - ux * hw, cy, cz - uz * hw, cx + ux * hw, cy, cz + uz * hw, 0.02, 0.02, 4, Math.PI / 4, false);
  }
}

/** A wooden arm out from a wall at height y, with a strut under it. Returns nothing; the hook is at off - 0.06. */
function bracket(w: Writer, wx: number, wz: number, nx: number, nz: number, y: number, off: number): void {
  w.mat = MAT.wood;
  w.tint = 50;
  tube(w, wx, y, wz, wx + nx * off, y, wz + nz * off, 0.035, 0.03, 4, Math.PI / 4, false);
  const so = off * 0.6;
  tube(w, wx, y - so * 0.9, wz, wx + nx * so, y - 0.02, wz + nz * so, 0.025, 0.025, 4, Math.PI / 4, false);
}

/** A lantern hanging from a hook at (x, y, z) on a chain `drop` long. Adds its light. */
function lantern(f: Writer, G: Glows, x: number, y: number, z: number, drop: number, seed: number): void {
  const yt = y - drop;
  put(f, (f, M) => {
    f.mat = MAT.wood;
    f.tint = 30;
    f.extra = 0;
    cord(f, x, y, z, x, yt, z, 0.012, 0, 1);
    // the lantern swings as one piece (weight 1 everywhere below the chain)
    f.seed = 255;
    if (M) stamp(f, variant(M.lantern, x, y, z, 29), x, yt, z, 1, 0, 1, 1, 1, looks(MAT.wood, 30, 0, MAT.wood));
    else lanternShape(f, x, yt, z);
    f.seed = 0;
  });
  G.add(x, yt - 0.22, z, 0.6, GLOW.lantern, seed, 0.85);
}

/** The procedural lantern below the hook end of its chain at (x, yt, z). */
function lanternShape(f: Writer, x: number, yt: number, z: number): void {
  const r = 0.11;
  // cap: a little four-sided roof
  f.reserve(5, 12);
  const apex = f.vert(x, yt, z, 0, 1, 0, 0.5, 1);
  const cs = f.nv;
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k / 4) * TAU;
    f.vert(x + Math.cos(a) * (r + 0.05), yt - 0.09, z + Math.sin(a) * (r + 0.05), Math.cos(a) * 0.6, 0.8, Math.sin(a) * 0.6, k / 4, 0);
  }
  for (let k = 0; k < 4; k++) f.index3(cs + k, cs + ((k + 1) % 4), apex);
  f.mat = MAT.lantern;
  ybox(f, x, z, 1, 0, r, r, yt - 0.36, yt - 0.09, 1 | 2 | 16 | 32);
  f.mat = MAT.wood;
  ybox(f, x, z, 1, 0, r + 0.025, r + 0.025, yt - 0.4, yt - 0.36);
}

/** Cloth colour: mostly cream for washing, any dye for banners. */
function clothTint(rng: () => number, creamy: boolean): number {
  const r = rng();
  if (creamy && r < 0.55) return 200 + Math.floor(rng() * 55);
  return Math.floor(rng() * 255);
}

/**
 * A banner hanging from a rod: the rod runs from (ax, az) along (ex, ez) for width W at height y,
 * the cloth hangs L below it. shape 0 square, 1 pointed, 2 swallowtail. hold weights the motion
 * across the width (0..1 at u = 0), so a banner held near a wall moves less at its inner edge.
 */
function banner(
  f: Writer, ax: number, y: number, az: number, ex: number, ez: number, W: number, L: number,
  shape: number, hold: number, rng: () => number,
): void {
  f.mat = MAT.cloth;
  f.tint = clothTint(rng, false);
  f.extra = rng() < 0.45 ? 2 + Math.floor(rng() * 3) * 2 : 0;
  const bottom = (u: number): number => {
    const m = 1 - Math.abs(2 * u - 1);
    return shape === 1 ? L * 0.22 * m : shape === 2 ? -L * 0.2 * m : 0;
  };
  sheet(f, 2, 4, -ez, 0, ex,
    (u, v, p) => {
      p[0] = ax + ex * W * u;
      p[1] = y - v * (L + bottom(u));
      p[2] = az + ez * W * u;
    },
    (u, v) => Math.pow(v, 1.1) * (hold + (1 - hold) * u));
  f.extra = 0;
}

/** A long pennant flying from a pole at (x, z), from height yt down, pointing along (ex, ez). */
function pennant(f: Writer, x: number, yt: number, z: number, ex: number, ez: number, L: number, H: number, rng: () => number): void {
  f.mat = MAT.cloth;
  f.tint = clothTint(rng, false);
  f.extra = 0;
  sheet(f, 4, 1, -ez, 0, ex,
    (u, v, p) => {
      const d = 0.06 + u * L;
      const top = yt - u * H * 0.35;
      const bot = yt - H + u * H * 0.5;
      p[0] = x + ex * d;
      p[1] = top + (bot - top) * v;
      p[2] = z + ez * d;
    },
    (u) => Math.pow(u, 1.2));
}

/** A tall pole on a stone foot, with a small finial. */
function pole(w: Writer, x: number, y: number, z: number, h: number, rng: () => number): void {
  if (solidSink) solidSink.push({ x, z, hw: 0.17, hd: 0.17, y0: y - 1, y1: y + h });
  w.mat = MAT.stone;
  w.tint = 100 + Math.floor(rng() * 100);
  ybox(w, x, z, 1, 0, 0.17, 0.17, y - 0.05, y + 0.32, 1 | 2 | 4 | 16 | 32);
  w.mat = MAT.wood;
  w.tint = 40 + Math.floor(rng() * 60);
  tube(w, x, y + 0.3, z, x, y + h, z, 0.06, 0.045, 5, 0, false);
  tube(w, x, y + h, z, x, y + h + 0.28, z, 0.07, 0.0, 5, 0, false);
}

/** Height of a line sagging from a (t = 0) to b (t = 1). */
const sagY = (ya: number, yb: number, sag: number, t: number): number => ya + (yb - ya) * t - sag * 4 * t * (1 - t);

/** A line strung from a to b with washing (or, when flags, a string of pennants) hung on it. Returns pieces hung. */
function line(
  f: Writer, ax: number, ay: number, az: number, bx: number, by: number, bz: number, sag: number,
  flags: boolean, minY: number, rng: () => number,
): number {
  const dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz);
  const n = Math.max(4, Math.ceil(L / 1.2));
  f.mat = MAT.wood;
  f.tint = flags ? 120 : 190;
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n;
    cord(f, ax + dx * t0, sagY(ay, by, sag, t0), az + dz * t0, ax + dx * t1, sagY(ay, by, sag, t1), az + dz * t1, 0.012, 0, 0);
  }
  const ux = dx / L, uz = dz / L;
  const nx = -uz, nz = ux;
  let pieces = 0;
  f.mat = MAT.cloth;
  if (flags) {
    // triangular pennants every half metre, in a repeating run of colours
    const palette = [Math.floor(rng() * 255), Math.floor(rng() * 255), Math.floor(rng() * 255)];
    const fw = 0.28, gap = 0.2;
    let k = 0;
    for (let d = 0.35; d + fw < L - 0.3; d += fw + gap, k++) {
      const t0 = d / L, t1 = (d + fw) / L, tm = (t0 + t1) / 2;
      const y0 = sagY(ay, by, sag, t0), y1 = sagY(ay, by, sag, t1), ym = sagY(ay, by, sag, tm) - 0.34;
      if (ym < minY) continue;
      f.tint = palette[k % 3];
      f.reserve(3, 3);
      f.seed = 0;
      const v0 = f.vert(ax + dx * t0, y0, az + dz * t0, nx, 0, nz, 0, 0);
      const v1 = f.vert(ax + dx * t1, y1, az + dz * t1, nx, 0, nz, 1, 0);
      f.seed = byte(0.85);
      const v2 = f.vert(ax + dx * tm, ym, az + dz * tm, nx, 0, nz, 0.5, 1);
      f.index3(v0, v1, v2);
      f.seed = 0;
      pieces++;
    }
    return pieces;
  }
  // washing: shirts, cloths and the odd long sheet, pegged along the line
  let d = 0.3 + rng() * 0.4;
  while (d < L - 0.6) {
    const gw = rng() < 0.2 ? 0.9 + rng() * 0.5 : 0.35 + rng() * 0.4;
    if (d + gw > L - 0.3) break;
    const t0 = d / L, t1 = (d + gw) / L;
    const ylo = Math.min(sagY(ay, by, sag, t0), sagY(ay, by, sag, t1));
    const gh = Math.min(gw > 0.85 ? 0.9 + rng() * 0.3 : 0.4 + rng() * 0.4, ylo - minY);
    if (gh > 0.25 && rng() < 0.85) {
      f.tint = clothTint(rng, true);
      f.extra = rng() < 0.2 ? 2 + Math.floor(rng() * 3) * 2 : 0;
      sheet(f, 2, 2, nx, 0, nz,
        (u, v, p) => {
          const t = t0 + (t1 - t0) * u;
          p[0] = ax + dx * t;
          p[1] = sagY(ay, by, sag, t) - v * gh;
          p[2] = az + dz * t;
        },
        (_u, v) => v * 0.9);
      f.extra = 0;
      pieces++;
    }
    d += gw + 0.08 + rng() * 0.35;
  }
  return pieces;
}

// ------------------------------------------------------------------ placement

/** Points (x, z, r) bucketed for quick "is anything within r" checks. */
class Points {
  private m = new Map<number, number[]>();
  private maxR = 0;
  add(x: number, z: number, r: number): void {
    if (r > this.maxR) this.maxR = r;
    const k = key(Math.floor(x / PB), Math.floor(z / PB));
    let l = this.m.get(k);
    if (!l) this.m.set(k, (l = []));
    l.push(x, z, r);
  }
  /** True if a circle of radius r at (x, z) overlaps any point's circle. */
  hit(x: number, z: number, r: number): boolean {
    const p = r + this.maxR;
    for (let j = Math.floor((z - p) / PB); j <= Math.floor((z + p) / PB); j++)
      for (let i = Math.floor((x - p) / PB); i <= Math.floor((x + p) / PB); i++) {
        const l = this.m.get(key(i, j));
        if (!l) continue;
        for (let n = 0; n < l.length; n += 3) {
          const dx = x - l[n], dz = z - l[n + 1], rr = r + l[n + 2];
          if (dx * dx + dz * dz < rr * rr) return true;
        }
      }
    return false;
  }
  /** Distance to the nearest point within max (its radius ignored), or Infinity. */
  nearest(x: number, z: number, max: number): number {
    let best = max * max;
    let found = false;
    for (let j = Math.floor((z - max) / PB); j <= Math.floor((z + max) / PB); j++)
      for (let i = Math.floor((x - max) / PB); i <= Math.floor((x + max) / PB); i++) {
        const l = this.m.get(key(i, j));
        if (!l) continue;
        for (let n = 0; n < l.length; n += 3) {
          const dx = x - l[n], dz = z - l[n + 1], d2 = dx * dx + dz * dz;
          if (d2 < best) {
            best = d2;
            found = true;
          }
        }
      }
    return found ? Math.sqrt(best) : Infinity;
  }
}

interface Face {
  ox: number;
  oz: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  len: number;
}

/** The building's straight walls as drawn (turned and inset for a slumped house; none on a round one). */
function facesOf(b: Building): Face[] {
  return bodyFaces(b);
}

const fx = (f: Face, u: number, off: number): number => f.ox + f.tx * u + f.nx * off;
const fz = (f: Face, u: number, off: number): number => f.oz + f.tz * u + f.nz * off;

/** A stretch of wall beside a street. */
interface Slot {
  b: Building;
  i: number;
  f: Face;
  u: number;
  /** Open ground from the wall to the street edge, metres. */
  depth: number;
  busy: number;
  /** Width of the nearest street. */
  lane: number;
}

export const furniture: ExtraBuilder = (ctx: ExtraCtx): Extra => {
  const { plan, site } = ctx;
  const dens = ctx.density;
  const rng = ctx.rng(0xf0e1);
  const sq = plan.square;
  const target = Math.round(TARGET[site.kind] * dens);

  // ---------------------------------------------------------------- what to keep clear of

  const keep = new Points(); // where people linger, lamp posts, canopy poles
  for (const s of plan.spots) keep.add(s.x, s.z, 1.2);
  for (const l of plan.lamps) keep.add(l.x, l.z, 0.6);
  const lamps = new Points();
  for (const l of plan.lamps) lamps.add(l.x, l.z, 0);
  const canopies: Building[] = [];
  const rects: Building[] = []; // walk-through things to keep off: stalls, beds, garden shades
  for (const b of plan.buildings) {
    if (b.solid) continue;
    if (b.roof === 'canopy') {
      canopies.push(b);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) keep.add(b.x + sx * (b.w / 2 - 0.15), b.z + sz * (b.d / 2 - 0.15), 0.15);
    }
    if (b.role !== 'market') rects.push(b);
  }
  const rb = new Map<number, Building[]>();
  for (const b of rects) {
    for (let j = Math.floor((b.z - b.d / 2 - 2) / 16); j <= Math.floor((b.z + b.d / 2 + 2) / 16); j++)
      for (let i = Math.floor((b.x - b.w / 2 - 2) / 16); i <= Math.floor((b.x + b.w / 2 + 2) / 16); i++) {
        const k = key(i, j);
        let l = rb.get(k);
        if (!l) rb.set(k, (l = []));
        l.push(b);
      }
  }
  const inRect = (x: number, z: number, r: number): boolean => {
    const l = rb.get(key(Math.floor(x / 16), Math.floor(z / 16)));
    if (!l) return false;
    for (const b of l) if (Math.abs(x - b.x) < b.w / 2 + r + 0.15 && Math.abs(z - b.z) < b.d / 2 + r + 0.15) return true;
    return false;
  };

  // A clear way in front of every door: its width plus 0.4 m, 1.6 m deep.
  const DOOR_D = 1.6;
  const db = new Map<number, number[]>(); // door indices by 16 m bucket
  ctx.doors.forEach((d, k) => {
    const ex = d.x + d.nx * DOOR_D, ez = d.z + d.nz * DOOR_D, hw = d.w / 2 + 0.2;
    for (let j = Math.floor((Math.min(d.z, ez) - hw - 1) / 16); j <= Math.floor((Math.max(d.z, ez) + hw + 1) / 16); j++)
      for (let i = Math.floor((Math.min(d.x, ex) - hw - 1) / 16); i <= Math.floor((Math.max(d.x, ex) + hw + 1) / 16); i++) {
        const kk = key(i, j);
        let l = db.get(kk);
        if (!l) db.set(kk, (l = []));
        l.push(k);
      }
  });
  /** True if a circle of radius r at (x, z) reaches into the clear way in front of a door. */
  const inDoor = (x: number, z: number, r: number): boolean => {
    const l = db.get(key(Math.floor(x / 16), Math.floor(z / 16)));
    if (!l) return false;
    for (const k of l) {
      const d = ctx.doors[k];
      const dx = x - d.x, dz = z - d.z;
      const a = dx * -d.nz + dz * d.nx, b = dx * d.nx + dz * d.nz;
      if (Math.abs(a) < d.w / 2 + 0.2 + r && b > -r && b < DOOR_D + r) return true;
    }
    return false;
  };

  /** True if a thing of radius r can stand at (x, z): off the street, the people spots, the doorways and everything else. */
  const fits = (x: number, z: number, r: number): boolean =>
    ctx.streetGap(x, z) > 0.3 + r && !keep.hit(x, z, r) && !inRect(x, z, r) && !inDoor(x, z, r) && ctx.free(x, z, r);
  const take = (x: number, z: number, r: number): boolean => {
    if (!fits(x, z, r)) return false;
    ctx.claim(x, z, r);
    return true;
  };
  /** True if the corners of a footprint (half sizes hu along (ux, uz), hn across) are off the street and open. */
  const cornersClear = (x: number, z: number, ux: number, uz: number, hu: number, hn: number): boolean => {
    for (const a of [-hu, hu])
      for (const b of [-hn, hn]) {
        const cx = x + ux * a - uz * b, cz = z + uz * a + ux * b;
        if (ctx.streetGap(cx, cz) < 0.3 || ctx.roofAt(cx, cz) > 0 || keep.hit(cx, cz, 0.05) || inDoor(cx, cz, 0)) return false;
      }
    return true;
  };

  // ---------------------------------------------------------------- how busy a place is

  const markets = new Points();
  const gathers = new Points();
  const gates = new Points();
  for (const s of plan.spots) {
    if (s.kind === 'market' || s.kind === 'stall') markets.add(s.x, s.z, 0);
    else if (s.kind === 'gate') gates.add(s.x, s.z, 0);
    else gathers.add(s.x, s.z, 0);
  }
  for (const b of canopies) if (b.role === 'market') markets.add(b.x, b.z, 0);
  const streets = new Map<number, number[]>();
  plan.edges.forEach((e, k) => {
    const a = plan.nodes[e.a], b = plan.nodes[e.b];
    const pad = e.width / 2 + 4;
    for (let j = Math.floor((Math.min(a.z, b.z) - pad) / SB); j <= Math.floor((Math.max(a.z, b.z) + pad) / SB); j++)
      for (let i = Math.floor((Math.min(a.x, b.x) - pad) / SB); i <= Math.floor((Math.max(a.x, b.x) + pad) / SB); i++) {
        const kk = key(i, j);
        let l = streets.get(kk);
        if (!l) streets.set(kk, (l = []));
        l.push(k);
      }
  });
  /** Width of the street whose edge is nearest (0 if none within 4 m). */
  const laneAt = (x: number, z: number): number => {
    const l = streets.get(key(Math.floor(x / SB), Math.floor(z / SB)));
    if (!l) return 0;
    let best = 4, wd = 0;
    for (const k of l) {
      const e = plan.edges[k];
      const a = plan.nodes[e.a], b = plan.nodes[e.b];
      const ex = b.x - a.x, ez = b.z - a.z;
      const len2 = ex * ex + ez * ez || 1;
      const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / len2, 0, 1);
      const d = Math.hypot(x - a.x - ex * t, z - a.z - ez * t) - e.width / 2;
      if (d < best) {
        best = d;
        wd = e.width;
      }
    }
    return wd;
  };
  const fade = (d: number, d0: number, d1: number): number => 1 - clamp((d - d0) / (d1 - d0), 0, 1);
  const busyAt = (x: number, z: number, lane: number): number => {
    let b = fade(markets.nearest(x, z, 30), 5, 30);
    b = Math.max(b, 0.85 * fade(Math.abs(Math.hypot(x - sq.x, z - sq.z) - sq.r), 3, 22));
    b = Math.max(b, 0.55 * fade(gates.nearest(x, z, 20), 6, 20));
    b = Math.max(b, 0.35 * fade(gathers.nearest(x, z, 12), 3, 12));
    if (lane >= 9) b = Math.max(b, 0.3);
    return b;
  };

  // ---------------------------------------------------------------- writers, by cell

  const solidCells = new Map<number, Writer>();
  const flexCells = new Map<number, Writer>();
  const cellOf = (m: Map<number, Writer>, x: number, z: number): Writer => {
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    let w = m.get(k);
    if (!w) m.set(k, (w = new Writer(2048, 4096)));
    return w;
  };
  const S = (x: number, z: number): Writer => cellOf(solidCells, x, z);
  const F = (x: number, z: number): Writer => cellOf(flexCells, x, z);
  const G = new Glows();
  const counts = {
    jars: 0, crates: 0, sacks: 0, baskets: 0, rugs: 0, benches: 0, carts: 0, ladders: 0,
    lanterns: 0, banners: 0, poles: 0, washing: 0, bunting: 0, pieces: 0,
  };
  const total = (): number =>
    counts.jars + counts.crates + counts.sacks + counts.baskets + counts.rugs + counts.benches + counts.carts +
    counts.ladders + counts.lanterns + counts.banners + counts.poles + counts.washing + counts.bunting;
  const ground = (x: number, z: number): number => ctx.groundAt(x, z);
  const solids: Solid[] = [];
  solidSink = solids;
  const loading = loadFurniture();
  const modelled = FURN;
  // built before the models arrived: remember what each writer holds of them, to rebuild from
  const ops = modelled ? null : new Map<Writer, Op[]>();
  replay = ops;
  const rugsLater: number[] = []; // flat rugs are claimed last, so goods can stand on them

  // ---------------------------------------------------------------- single goods

  /** One thing of goods near (x, z), market-style. Returns true if placed. */
  const goods = (x: number, z: number, ux: number, uz: number): boolean => {
    const p = rng();
    if (p < 0.27) {
      const kind = rng() < 0.55 ? 0 : rng() < 0.6 ? 1 : 2;
      const s = kind === 0 ? 0.6 + rng() * 0.35 : kind === 1 ? 0.75 + rng() * 0.3 : 0.35 + rng() * 0.15;
      const r = JAR_R[kind] * s + 0.03;
      if (!take(x, z, r)) return false;
      jar(S(x, z), x, ground(x, z), z, s, kind, rng);
      counts.jars++;
    } else if (p < 0.52) {
      const hu = 0.22 + rng() * 0.14, hn = 0.2 + rng() * 0.1, hh = 0.3 + rng() * 0.25;
      const r = Math.hypot(hu, hn);
      if (!take(x, z, r)) return false;
      const tw = (rng() - 0.5) * 0.3;
      const cu = ux * Math.cos(tw) - uz * Math.sin(tw), cz = ux * Math.sin(tw) + uz * Math.cos(tw);
      const w = S(x, z);
      const y = ground(x, z);
      const open = rng() < 0.55;
      crate(w, x, y, z, cu, cz, hu, hn, hh, open, rng);
      counts.crates++;
      if (!open && rng() < 0.35) {
        crate(w, x, y + hh, z, -cz, cu, hn * 0.9, hu * 0.8, hh * 0.85, rng() < 0.5, rng);
        counts.crates++;
        if (hh * 1.85 >= SOLID_MIN) {
          // the stack: the lower crate's footprint, as high as the upper one
          const sx = Math.abs(cu) * hu + Math.abs(cz) * hn, sz = Math.abs(cz) * hu + Math.abs(cu) * hn;
          solids.push({ x, z, hw: sx, hd: sz, y0: y - 1, y1: y + hh * 1.85 });
        }
      }
    } else if (p < 0.72) {
      const r = 0.2 + rng() * 0.08;
      if (!take(x, z, r + 0.02)) return false;
      sack(S(x, z), x, ground(x, z), z, r, 0.45 + rng() * 0.25, rng);
      counts.sacks++;
    } else if (p < 0.9) {
      const r = 0.25 + rng() * 0.12;
      if (!take(x, z, r + 0.02)) return false;
      basket(S(x, z), x, ground(x, z), z, r, 0.3 + rng() * 0.12, rng);
      counts.baskets++;
    } else {
      if (!take(x, z, 0.52)) return false;
      rugPile(S(x, z), x, ground(x, z), z, ux, uz, rng);
      counts.rugs++;
    }
    return true;
  };

  /** A flat rug laid out, claimed at the end. */
  const layRug = (x: number, z: number, ux: number, uz: number, hl: number, hw: number): boolean => {
    const r = Math.hypot(hl, hw);
    // the corners must be off the street too
    const vx = -uz, vz = ux;
    for (const [a, b] of [[hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw]]) {
      const cx = x + ux * a + vx * b, cz = z + uz * a + vz * b;
      if (ctx.streetGap(cx, cz) < 0.3 || keep.hit(cx, cz, 0.05) || inRect(cx, cz, 0) || !ctx.free(cx, cz, 0.05)) return false;
    }
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (inDoor(x + ux * a * hl + vx * b * hw, z + uz * a * hl + vz * b * hw, 0.05)) return false;
    if (keep.hit(x, z, r * 0.7) || !ctx.free(x, z, Math.min(hl, hw))) return false;
    flatRug(S(x, z), x, ground(x, z), z, ux, uz, hl, hw, rng);
    rugsLater.push(x, z, Math.min(hl, hw));
    counts.rugs++;
    return true;
  };

  // ---------------------------------------------------------------- markets

  for (const b of canopies) {
    if (b.role !== 'market') continue;
    const x0 = b.x - b.w / 2 + 0.45, x1 = b.x + b.w / 2 - 0.45;
    const z0 = b.z - b.d / 2 + 0.45, z1 = b.z + b.d / 2 - 0.45;
    const alongX = b.w >= b.d;
    const ux = alongX ? 1 : 0, uz = alongX ? 0 : 1;
    // a rug or two laid out with goods on them
    const nr = rng() < 0.6 * dens ? 1 + (rng() < 0.4 ? 1 : 0) : 0;
    for (let k = 0, tries = 0; k < nr && tries < 8; tries++) {
      const hl = 0.7 + rng() * 0.4, hw = 0.45 + rng() * 0.25;
      if (layRug(x0 + rng() * (x1 - x0), z0 + rng() * (z1 - z0), ux, uz, hl, hw)) k++;
    }
    for (let gz = z0; gz <= z1; gz += 1.05)
      for (let gx = x0; gx <= x1; gx += 1.05) {
        if (rng() > 0.7 * dens) continue;
        goods(gx + (rng() - 0.5) * 0.4, gz + (rng() - 0.5) * 0.4, ux, uz);
      }
  }
  // goods beside every stall
  for (const b of rects) {
    if (b.role !== 'stall') continue;
    const n = Math.round((2 + rng() * 3) * dens);
    for (let k = 0; k < n; k++) {
      const side = Math.floor(rng() * 4);
      const out = 0.45 + rng() * 0.4;
      let x = b.x, z = b.z;
      if (side < 2) {
        x += (side === 0 ? 1 : -1) * (b.w / 2 + out);
        z += (rng() - 0.5) * b.d;
      } else {
        z += (side === 2 ? 1 : -1) * (b.d / 2 + out);
        x += (rng() - 0.5) * b.w;
      }
      goods(x, z, b.w >= b.d ? 1 : 0, b.w >= b.d ? 0 : 1);
    }
  }

  // lanterns on the market poles, and strings of pennants across the aisles between canopies
  {
    const tops: Array<{ x: number; z: number; y: number; b: Building }> = [];
    for (const b of canopies) {
      if (b.role !== 'market') continue;
      const h = Math.max(2.3, b.h);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) tops.push({ x: b.x + sx * (b.w / 2 - 0.15), z: b.z + sz * (b.d / 2 - 0.15), y: h, b });
    }
    const used = new Set<number>();
    for (let i = 0; i < tops.length; i++) {
      const a = tops[i];
      // a lantern hung out over the aisle from the pole top
      if (rng() < 0.35 * dens && ctx.streetGap(a.x, a.z) < 3 && !lamps.hit(a.x, a.z, 2.5)) {
        const ox = a.x > a.b.x ? 1 : -1, oz = a.z > a.b.z ? 1 : -1;
        const alongX = a.b.w >= a.b.d;
        const hx = a.x + (alongX ? 0 : ox * 0.32), hz = a.z + (alongX ? oz * 0.32 : 0);
        const w = S(hx, hz);
        w.mat = MAT.wood;
        w.tint = 50;
        tube(w, a.x, a.y - 0.08, a.z, hx, a.y - 0.08, hz, 0.025, 0.025, 4, Math.PI / 4, false);
        lantern(F(hx, hz), G, hx, a.y - 0.1, hz, 0.12, rng());
        counts.lanterns++;
      }
      if (used.has(i) || rng() > 0.55 * dens) continue;
      let best = -1, bd = 9.5;
      for (let j = 0; j < tops.length; j++) {
        const c = tops[j];
        if (c.b === a.b || used.has(j)) continue;
        const d = Math.hypot(c.x - a.x, c.z - a.z);
        if (d < 4 || d >= bd) continue;
        if (ctx.streetGap((a.x + c.x) / 2, (a.z + c.z) / 2) > 0) continue; // must cross the aisle
        best = j;
        bd = d;
      }
      if (best < 0) continue;
      const c = tops[best];
      used.add(i);
      used.add(best);
      const y = Math.min(a.y, c.y) + 0.08;
      const pcs = line(F((a.x + c.x) / 2, (a.z + c.z) / 2), a.x, y, a.z, c.x, y, c.z, 0.12 + bd * 0.015, true, 2.6, rng);
      counts.bunting++;
      counts.pieces += pcs;
    }
  }

  // ---------------------------------------------------------------- the square and the gates

  const poleAt = (x: number, z: number, h: number, faceX: number, faceZ: number): boolean => {
    if (!take(x, z, 0.3)) return false;
    const y = ground(x, z);
    pole(S(x, z), x, y, z, h, rng);
    const fw = F(x, z);
    if (rng() < 0.55) {
      // a pennant flying out to one side
      const a = Math.atan2(faceZ, faceX) + Math.PI / 2 + (rng() - 0.5) * 0.6;
      pennant(fw, x, y + h - 0.1, z, Math.cos(a), Math.sin(a), 1.6 + rng() * 1.2, 0.5 + rng() * 0.2, rng);
    } else {
      // a standard hanging from a crossbar, its face toward the open ground
      const ex = -faceZ, ez = faceX;
      const W = 0.7 + rng() * 0.25;
      const yb = y + h - 0.25;
      const w = S(x, z);
      w.mat = MAT.wood;
      tube(w, x - ex * (W / 2 + 0.08), yb, z - ez * (W / 2 + 0.08), x + ex * (W / 2 + 0.08), yb, z + ez * (W / 2 + 0.08), 0.025, 0.025, 4, Math.PI / 4, false);
      banner(fw, x - ex * (W / 2), yb - 0.03, z - ez * (W / 2), ex, ez, W, Math.min(1.4 + rng() * 0.8, h - 3), rng() < 0.5 ? 2 : 1, 0.7, rng);
    }
    counts.poles++;
    return true;
  };

  {
    // banners round the edge
    const n = Math.max(6, Math.round((TAU * sq.r) / 16));
    const a0 = rng() * TAU;
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * TAU;
      for (let t = 0; t < 4; t++) {
        const rr = sq.r + (rng() - 0.5) * 3;
        const x = sq.x + Math.cos(a) * rr, z = sq.z + Math.sin(a) * rr;
        if (poleAt(x, z, 5 + rng() * 2.2, -Math.cos(a), -Math.sin(a))) break;
      }
    }
    // benches, jars and goods round the edge, facing in
    const m = Math.round((TAU * sq.r) / 3);
    for (let k = 0; k < m; k++) {
      if (rng() > 0.55 * dens) continue;
      const a = rng() * TAU;
      const rr = sq.r + (rng() - 0.6) * 3.5;
      const x = sq.x + Math.cos(a) * rr, z = sq.z + Math.sin(a) * rr;
      const ux = -Math.sin(a), uz = Math.cos(a);
      const p = rng();
      if (p < 0.3) {
        const hl = 0.7 + rng() * 0.5;
        if (!fits(x, z, hl * 0.6) || !fits(x + ux * hl * 0.6, z + uz * hl * 0.6, 0.3) || !fits(x - ux * hl * 0.6, z - uz * hl * 0.6, 0.3)) continue;
        if (!cornersClear(x, z, ux, uz, hl + 0.03, 0.25)) continue;
        ctx.claim(x, z, hl * 0.6);
        ctx.claim(x + ux * hl * 0.6, z + uz * hl * 0.6, 0.3);
        ctx.claim(x - ux * hl * 0.6, z - uz * hl * 0.6, 0.3);
        bench(S(x, z), x, ground(x, z), z, ux, uz, hl, rng);
        counts.benches++;
      } else if (p < 0.4) {
        if (!fits(x, z, 0.75) || !fits(x + ux * 1.8, z + uz * 1.8, 0.3)) continue;
        ctx.claim(x, z, 0.75);
        ctx.claim(x + ux * 1.8, z + uz * 1.8, 0.3);
        cart(S(x, z), x, ground(x, z), z, ux, uz, rng);
        counts.carts++;
      } else if (p < 0.47) {
        layRug(x, z, ux, uz, 0.8 + rng() * 0.4, 0.5 + rng() * 0.25);
      } else {
        const g = 1 + Math.floor(rng() * 3);
        for (let q = 0; q < g; q++) goods(x + (rng() - 0.5) * 1.4, z + (rng() - 0.5) * 1.4, ux, uz);
      }
    }
  }
  // a pair of banner poles where the avenues come in
  for (const s of plan.spots) {
    if (s.kind !== 'gate' || rng() > 0.8) continue;
    const fxv = Math.sin(s.facing), fzv = Math.cos(s.facing);
    for (const side of [-1, 1]) {
      for (let t = 0; t < 5; t++) {
        const d = 3 + t * 0.8;
        const x = s.x - fzv * side * d, z = s.z + fxv * side * d;
        if (poleAt(x, z, 5.5 + rng() * 1.5, fxv, fzv)) break;
      }
    }
  }

  // ---------------------------------------------------------------- walls beside the streets

  const slots: Slot[] = [];
  plan.buildings.forEach((b, i) => {
    if (!b.solid || b.h < 2.2 || b.role === 'garden' || b.roof === 'canopy' || b.roof === 'none') return;
    const fs = facesOf(b);
    for (const f of fs) {
      if (f.len < 2) continue;
      for (let u = 0.9; u <= f.len - 0.9; u += 1.6) {
        const qx = fx(f, u, 0.55), qz = fz(f, u, 0.55);
        if (ctx.roofAt(qx, qz) > 0) continue;
        const g = ctx.streetGap(qx, qz);
        if (g < 0.3 || g > 3.5) continue;
        const lane = laneAt(qx, qz);
        slots.push({ b, i, f, u, depth: g + 0.55, busy: busyAt(qx, qz, lane), lane });
      }
    }
  });
  for (let k = slots.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    const t = slots[k];
    slots[k] = slots[j];
    slots[j] = t;
  }

  // Overhead: lanterns and banners on brackets, rugs aired over parapets, washing and pennants
  // strung across the lanes. All of it keeps a little apart.
  const over = new Points();
  const storeys = (h: number): number => Math.max(1, Math.floor((h + 0.4) / 3.2));
  for (const s of slots) {
    const { b, f, u } = s;
    const wx = fx(f, u, 0), wz = fz(f, u, 0);
    const ox = fx(f, u, 0.6), oz = fz(f, u, 0.6);
    const house = b.role === 'house' || b.role === 'hall' || b.role === 'market';
    const r = rng();
    const pL = (0.03 + 0.3 * s.busy * s.busy) * dens;
    const pB = pL + (0.015 + 0.08 * s.busy) * dens;
    const pR = pB + (0.02 + 0.05 * s.busy) * dens;
    const pick = !house ? -1 : r < pL ? 0 : r < pB ? 1 : r < pR ? 2 : -1;
    if (pick === 0) {
      // a lantern on a bracket, below the beam ends and clear above the doors and awnings
      const y = Math.min(3.6, b.h - 0.75);
      if (y >= 3.45 && !over.hit(ox, oz, 3.5) && !lamps.hit(ox, oz, 4)) {
        over.add(ox, oz, 1);
        bracket(S(wx, wz), wx, wz, f.nx, f.nz, y, 0.58);
        lantern(F(ox, oz), G, fx(f, u, 0.52), y - 0.03, fz(f, u, 0.52), 0.1 + rng() * 0.12, rng());
        counts.lanterns++;
        continue;
      }
    } else if (pick === 1) {
      // a blade banner standing out from the wall, between the window rows and below the beam ends
      const y = storeys(b.h) === 1 ? b.h - 0.8 : 5.55 + rng() * 0.4;
      const L = Math.min(2.4, y - 3.0, 1.2 + rng() * 1.2);
      if (y <= b.h - 0.8 && L >= 1 && !over.hit(ox, oz, 2.5)) {
        over.add(ox, oz, 1);
        const W = 0.55 + rng() * 0.2;
        const w = S(wx, wz);
        w.mat = MAT.wood;
        w.tint = 50;
        tube(w, wx, y, wz, fx(f, u, W + 0.2), y, fz(f, u, W + 0.2), 0.025, 0.022, 4, Math.PI / 4, false);
        tube(w, fx(f, u, W + 0.2), y, fz(f, u, W + 0.2), fx(f, u, W + 0.3), y, fz(f, u, W + 0.3), 0.04, 0.0, 4, Math.PI / 4, false);
        banner(F(ox, oz), fx(f, u, 0.12), y - 0.03, fz(f, u, 0.12), f.nx, f.nz, W, L, Math.floor(rng() * 3), 0.35, rng);
        counts.banners++;
        continue;
      }
    } else if (pick === 2 && b.roof !== 'terrace' && b.roof !== 'windtower') {
      // a rug aired over the parapet, short enough to clear the beam ends
      const L = layoutOf(plan, b, s.i);
      const rw = 0.9 + rng() * 0.6;
      const u0 = u - rw / 2, u1 = u0 + rw;
      if (L.pb > 0 && L.style !== 'crenel' && u0 > 0.8 && u1 < f.len - 0.8 && !over.hit(ox, oz, 2)) {
        over.add(ox, oz, 1);
        const yt = b.h + L.pb;
        const hang = Math.min(L.pb + 0.15 + rng() * 0.1, 1);
        const w = S(wx, wz);
        w.mat = MAT.cloth;
        w.tint = Math.floor(rng() * 255);
        w.extra = 4 + Math.floor(rng() * 10);
        const o = 0.035, i = -0.33, yc = yt + 0.02;
        w.quad(fx(f, u0, o), yt - hang, fz(f, u0, o), fx(f, u1, o), yt - hang, fz(f, u1, o), fx(f, u1, o), yc, fz(f, u1, o), fx(f, u0, o), yc, fz(f, u0, o), f.nx, 0, f.nz);
        w.quad(fx(f, u0, o), yc, fz(f, u0, o), fx(f, u1, o), yc, fz(f, u1, o), fx(f, u1, i), yc, fz(f, u1, i), fx(f, u0, i), yc, fz(f, u0, i), 0, 1, 0);
        w.quad(fx(f, u0, i), yc, fz(f, u0, i), fx(f, u1, i), yc, fz(f, u1, i), fx(f, u1, i), yt - 0.3, fz(f, u1, i), fx(f, u0, i), yt - 0.3, fz(f, u0, i), -f.nx, 0, -f.nz);
        w.extra = 0;
        counts.rugs++;
        continue;
      }
    }
    // a line strung across to the facing wall: washing in the narrow lanes, pennants where it is busy
    const flags = s.busy > 0.35 && s.lane >= 5;
    const pLine = flags ? 0.8 * s.busy : s.lane <= 5 ? 0.14 * (1 - 0.5 * s.busy) : 0;
    if (pLine > 0 && rng() < pLine * dens && b.h >= 5) {
      const maxD = flags ? 20 : 8.5;
      let d = -1, hb = 0;
      for (let t = 0.75; t <= maxD + 0.5; t += 0.25) {
        const px = fx(f, u, t), pz = fz(f, u, t);
        const h = ctx.roofAt(px, pz);
        if (h > 0) {
          // the facing wall lies on the grid line just crossed
          const c = f.nx !== 0 ? px : pz;
          const n = f.nx !== 0 ? f.nx : f.nz;
          const wall = n > 0 ? Math.floor(c) : Math.floor(c) + 1;
          d = Math.abs(wall - (f.nx !== 0 ? f.ox : f.oz));
          hb = h;
          break;
        }
      }
      if (d < (flags ? 4 : 2.4) || d > maxD) continue;
      const mx = fx(f, u, d / 2), mz = fz(f, u, d / 2);
      if (ctx.streetGap(mx, mz) > 0.5) continue; // only across a street
      const y = Math.min(b.h, hb) - 0.9 - rng() * 0.5;
      if (y < (flags ? 4.6 : 4.4) || over.hit(mx, mz, flags ? 4 : 3)) continue;
      over.add(mx, mz, 1.5);
      const ya = y + (rng() - 0.5) * 0.3, yb = y + (rng() - 0.5) * 0.3;
      const sag = 0.12 + d * (flags ? 0.02 : 0.03);
      const pcs = line(F(mx, mz), fx(f, u, 0.02), ya, fz(f, u, 0.02), fx(f, u, d - 0.02), yb, fz(f, u, d - 0.02), sag, flags, 3.5, rng);
      if (flags) counts.bunting++;
      else counts.washing++;
      counts.pieces += pcs;
    }
  }

  // Strings of pennants over the busy streets, wall to wall, where the frontages face each other
  // (not always squarely: the facing wall may be a little along the street).
  {
    const busySlots = slots.filter((s) => s.busy > 0.3 && s.lane >= 4 && s.b.h >= 5.2);
    const bk = new Map<number, Slot[]>();
    for (const s of busySlots) {
      const k = key(Math.floor(fx(s.f, s.u, 0) / 16), Math.floor(fz(s.f, s.u, 0) / 16));
      let l = bk.get(k);
      if (!l) bk.set(k, (l = []));
      l.push(s);
    }
    for (const s of busySlots) {
      if (rng() > 0.9 * s.busy * dens) continue;
      const ax = fx(s.f, s.u, 0.02), az = fz(s.f, s.u, 0.02);
      let best: Slot | null = null, bd = 0, bdot = 0.7;
      const i0 = Math.floor(ax / 16), j0 = Math.floor(az / 16);
      for (let j = j0 - 1; j <= j0 + 1; j++)
        for (let i = i0 - 1; i <= i0 + 1; i++) {
          const l = bk.get(key(i, j));
          if (!l) continue;
          for (const t of l) {
            if (t.b === s.b || t.f.nx * s.f.nx + t.f.nz * s.f.nz > -0.9) continue;
            const bx = fx(t.f, t.u, 0.02), bz = fz(t.f, t.u, 0.02);
            const d = Math.hypot(bx - ax, bz - az);
            if (d < 5 || d > 16) continue;
            const dot = ((bx - ax) * s.f.nx + (bz - az) * s.f.nz) / d;
            if (dot > bdot) {
              best = t;
              bd = d;
              bdot = dot;
            }
          }
        }
      if (!best) continue;
      const bx = fx(best.f, best.u, 0.02), bz = fz(best.f, best.u, 0.02);
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const y = Math.min(s.b.h, best.b.h) - 0.9 - rng() * 0.4;
      if (y < 4.3 || ctx.streetGap(mx, mz) > 0 || over.hit(mx, mz, 4)) continue;
      let clear = true;
      for (let t = 0.08; t < 0.93 && clear; t += 0.06) if (ctx.roofAt(ax + (bx - ax) * t, az + (bz - az) * t) > y - 0.6) clear = false;
      if (!clear) continue;
      over.add(mx, mz, 1.5);
      const pcs = line(F(mx, mz), ax, y + (rng() - 0.5) * 0.2, az, bx, y + (rng() - 0.5) * 0.2, bz, 0.15 + bd * 0.02, true, 3.5, rng);
      counts.bunting++;
      counts.pieces += pcs;
    }
  }

  // Beside the doors: a pair of jars flanking it, a bench to one side, or a lantern over it.
  for (const d of ctx.doors) {
    const qx = d.x + d.nx * 0.55, qz = d.z + d.nz * 0.55;
    if (ctx.streetGap(qx, qz) > 3.5) continue;
    const busy = busyAt(qx, qz, laneAt(qx, qz));
    if (rng() > (0.12 + 0.25 * busy) * dens) continue;
    const tx = -d.nz, tz = d.nx;
    const P = (a: number, off: number): [number, number] => [d.x + tx * a + d.nx * off, d.z + tz * a + d.nz * off];
    const p = rng();
    if (p < 0.45) {
      const kind = rng() < 0.6 ? 0 : 1;
      const sc = kind === 0 ? 0.6 + rng() * 0.25 : 0.8 + rng() * 0.2;
      const rr = JAR_R[kind] * sc + 0.03;
      for (const side of [-1, 1]) {
        const [x, z] = P(side * (d.w / 2 + 0.25 + rr), rr + 0.08);
        if (!take(x, z, rr)) continue;
        jar(S(x, z), x, ground(x, z), z, sc, kind, rng);
        counts.jars++;
      }
    } else if (p < 0.75) {
      const side = rng() < 0.5 ? -1 : 1;
      const hl = 0.55 + rng() * 0.3;
      const a = side * (d.w / 2 + 0.3 + hl);
      const [x, z] = P(a, 0.32), [ex, ez] = P(a - side * (hl - 0.25), 0.3), [fx2, fz2] = P(a + side * (hl - 0.25), 0.3);
      const [cx, cz] = P(a, 0.26);
      if (!fits(x, z, 0.28) || !fits(ex, ez, 0.25) || !fits(fx2, fz2, 0.25) || !cornersClear(cx, cz, tx, tz, hl + 0.03, 0.25)) continue;
      ctx.claim(x, z, 0.28);
      ctx.claim(ex, ez, 0.25);
      ctx.claim(fx2, fz2, 0.25);
      bench(S(x, z), cx, ground(x, z), cz, tx, tz, hl, rng);
      counts.benches++;
    } else {
      const h = ctx.roofAt(d.x - d.nx * 0.5, d.z - d.nz * 0.5);
      const y = Math.min(3.6, h - 0.75);
      const [ox, oz] = P(0, 0.6);
      if (d.w >= 1.9 || y < 3.45 || over.hit(ox, oz, 2.5) || lamps.hit(ox, oz, 3)) continue; // not over a great portal
      over.add(ox, oz, 1);
      bracket(S(d.x, d.z), d.x, d.z, d.nx, d.nz, y, 0.58);
      const [hx, hz] = P(0, 0.52);
      lantern(F(ox, oz), G, hx, y - 0.03, hz, 0.1 + rng() * 0.12, rng());
      counts.lanterns++;
    }
  }

  // On the ground along the walls: groups whose odds follow how busy the street is, scaled so the
  // town comes out near its target.
  const groupAt = (s: Slot): number => {
    const { b, f, u } = s;
    const ux = f.tx, uz = f.tz;
    const m = s.busy;
    const p = rng();
    // along this wall only: a group never wraps round the corner
    const at = (du: number, off: number): [number, number] => {
      const uu = clamp(u + du, 0.3, f.len - 0.3);
      return [fx(f, uu, off), fz(f, uu, off)];
    };
    let n = 0;
    const house = b.role === 'house';
    const pick = m > 0.55
      ? (p < 0.3 ? 1 : p < 0.55 ? 0 : p < 0.68 ? 2 : p < 0.78 ? 3 : p < 0.86 ? 4 : p < 0.94 ? 5 : 6)
      : (p < 0.26 ? 0 : p < 0.4 ? 1 : p < 0.56 ? 4 : p < 0.68 ? (house ? 7 : 0) : p < 0.75 ? 5 : p < 0.83 ? 2 : p < 0.88 ? 3 : 6);
    switch (pick) {
      case 0: { // jars
        const g = 2 + Math.floor(rng() * 4);
        for (let k = 0; k < g; k++) {
          const kind = rng() < 0.5 ? 0 : rng() < 0.6 ? 1 : 2;
          const sc = kind === 0 ? 0.55 + rng() * 0.4 : kind === 1 ? 0.75 + rng() * 0.3 : 0.35 + rng() * 0.15;
          const r = JAR_R[kind] * sc + 0.03;
          const off = r + 0.08 + (rng() < 0.25 ? r * 2 : 0);
          const [x, z] = at((rng() - 0.5) * 1.8, off);
          if (!take(x, z, r)) continue;
          jar(S(x, z), x, ground(x, z), z, sc, kind, rng);
          counts.jars++;
          n++;
        }
        break;
      }
      case 1: { // crates and sacks
        const g = 2 + Math.floor(rng() * 4);
        for (let k = 0; k < g; k++) {
          const [x, z] = at((rng() - 0.5) * 2, 0.4 + rng() * 0.25);
          if (goods(x, z, ux, uz)) n++;
        }
        break;
      }
      case 2: { // baskets
        const g = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < g; k++) {
          const r = 0.25 + rng() * 0.1;
          const [x, z] = at((rng() - 0.5) * 1.6, r + 0.1);
          if (!take(x, z, r + 0.02)) continue;
          basket(S(x, z), x, ground(x, z), z, r, 0.3 + rng() * 0.1, rng);
          counts.baskets++;
          n++;
        }
        break;
      }
      case 3: { // rolled rugs leaning on the wall
        const g = 2 + Math.floor(rng() * 3);
        for (let k = 0; k < g; k++) {
          const du = (k - (g - 1) / 2) * 0.24;
          const r = 0.08 + rng() * 0.03;
          const ht = 1.2 + rng() * 0.5;
          const [bx, bz] = at(du, 0.32 + rng() * 0.08);
          const [tx, tz] = at(du + (rng() - 0.5) * 0.15, r + 0.02);
          if (!take(bx, bz, r + 0.03) || ctx.roofAt(tx, tz) > 0) continue;
          const w = S(bx, bz);
          w.mat = MAT.cloth;
          w.tint = Math.floor(rng() * 255);
          tube(w, bx, ground(bx, bz) + r * 0.5, bz, tx, ground(bx, bz) + ht, tz, r, r, 6, 0, true);
          counts.rugs++;
          n++;
        }
        break;
      }
      case 4: { // a bench against the wall
        const hl = 0.6 + rng() * 0.45;
        if (u - hl < 0.3 || u + hl > f.len - 0.3) break;
        const [x, z] = at(0, 0.32);
        const [ax, az] = at(-hl + 0.25, 0.3);
        const [bx, bz] = at(hl - 0.25, 0.3);
        if (!fits(x, z, 0.28) || !fits(ax, az, 0.25) || !fits(bx, bz, 0.25)) break;
        // the seat's outer corners too (a neighbour may stand forward of this wall)
        const [cx, cz] = at(0, 0.26);
        if (!cornersClear(cx, cz, ux, uz, hl + 0.03, 0.25)) break;
        ctx.claim(x, z, 0.28);
        ctx.claim(ax, az, 0.25);
        ctx.claim(bx, bz, 0.25);
        bench(S(x, z), cx, ground(x, z), cz, ux, uz, hl, rng);
        counts.benches++;
        n++;
        break;
      }
      case 5: { // a pile of goods and a jar or two by it
        const [x, z] = at(0, 0.62);
        if (!take(x, z, 0.52)) break;
        const w = S(x, z);
        const top = rugPile(w, x, ground(x, z), z, ux, uz, rng);
        counts.rugs++;
        n++;
        if (rng() < 0.4) {
          sack(w, x, top, z, 0.16, 0.35, rng);
          counts.sacks++;
          n++;
        }
        break;
      }
      case 6: { // a handcart along the wall
        const dir = rng() < 0.5 ? 1 : -1;
        if (s.depth < 1.6 || u + dir * 2.1 < 0.3 || u + dir * 2.1 > f.len - 0.3 || u - dir * 0.9 < 0.3 || u - dir * 0.9 > f.len - 0.3) break;
        const [x, z] = at(0, 0.68);
        const [sx, sz] = at(dir * 1.8, 0.68);
        const [bx, bz] = at(-dir * 0.4, 0.68);
        const [ax, az] = at(dir * 0.45, 0.68);
        if (!fits(x, z, 0.6) || !fits(sx, sz, 0.3) || !fits(bx, bz, 0.55) || !fits(ax, az, 0.55)) break;
        ctx.claim(x, z, 0.6);
        ctx.claim(sx, sz, 0.3);
        ctx.claim(bx, bz, 0.55);
        ctx.claim(ax, az, 0.55);
        cart(S(x, z), x, ground(x, z), z, ux * dir, uz * dir, rng);
        counts.carts++;
        n++;
        break;
      }
      case 7: { // a ladder up onto the roof of a low house, or up to the upper floor of a taller one
        // A face with 6 m or more of open ground straight out from its middle may carry a cloth
        // awning over its ground floor (build.ts), which never reaches within 0.5 m of the
        // corners: there the ladder stands right at the end of the wall.
        let open = 0;
        while (open < 6 && ctx.roofAt(fx(f, f.len / 2, open + 0.5), fz(f, f.len / 2, open + 0.5)) === 0) open++;
        const lu = open < 6 ? u : u < f.len / 2 ? 0.26 : f.len - 0.26;
        const L = layoutOf(plan, b, s.i);
        const top = b.h <= 5.2 ? b.h + L.pb + 0.45 : 3.3 + rng() * 0.5;
        const foot = 0.2 + top * 0.24;
        const x = fx(f, lu, foot), z = fz(f, lu, foot);
        const mx = fx(f, lu, Math.max(0.38, foot * 0.5)), mz = fz(f, lu, Math.max(0.38, foot * 0.5));
        if (s.depth < foot + 0.4 || !fits(x, z, 0.3) || !fits(mx, mz, 0.3)) break;
        ctx.claim(x, z, 0.3);
        ctx.claim(mx, mz, 0.3);
        ladder(S(x, z), x, ground(x, z), z, fx(f, lu, 0.06), top, fz(f, lu, 0.06), ux, uz, rng);
        counts.ladders++;
        n++;
        break;
      }
    }
    return n;
  };
  {
    const left = Math.max(0, target - total());
    let sumW = 0;
    for (const s of slots) sumW += 0.04 + s.busy;
    // about 2.2 things per group, and some groups find no room
    let scale = left / (2.2 * 0.7 * Math.max(1, sumW));
    for (let pass = 0; pass < 2 && total() < target; pass++) {
      for (const s of slots) {
        if (total() >= target) break;
        if (rng() < Math.min(0.9, (0.04 + s.busy) * scale)) groupAt(s);
      }
      scale *= 1.6;
    }
  }
  for (let k = 0; k < rugsLater.length; k += 3) ctx.claim(rugsLater[k], rugsLater[k + 1], rugsLater[k + 2]);

  // ---------------------------------------------------------------- meshes

  const near = new THREE.Group();
  near.name = 'city-furniture';
  const solidMat = createMasonryMaterial(ctx.uniforms, { shadow: true, twoSided: false, sway: false });
  const flexMat = createFlexMaterial(ctx.uniforms);
  const mats: THREE.Material[] = [solidMat, flexMat];
  const geos: THREE.BufferGeometry[] = [];
  const cellMeshes: THREE.Mesh[] = [];
  const cellWriters: Writer[] = [];
  const pads: number[] = [];
  const bounds: number[] = [];
  const hides: number[] = [];
  let tris = 0;
  replay = null;
  const addCells = (m: Map<number, Writer>, mat: THREE.Material, name: string, hide: number, pad: number): void => {
    for (const w of m.values()) {
      w.orient();
      const g = w.geometry();
      if (!g) continue;
      tris += w.tris;
      g.boundingSphere!.radius += pad;
      geos.push(g);
      const me = new THREE.Mesh(g, mat);
      me.name = name;
      me.visible = false;
      near.add(me);
      cellMeshes.push(me);
      cellWriters.push(w);
      pads.push(pad);
      const bb = g.boundingBox!;
      bounds.push(bb.min.x, bb.min.z, bb.max.x, bb.max.z);
      hides.push(hide * hide);
    }
  };
  addCells(solidCells, solidMat, 'city-furniture-cell', HIDE, 0);
  addCells(flexCells, flexMat, 'city-furniture-cloth', HIDE_HIGH, 0.5);
  const gg = G.geometry();
  if (gg) {
    const gm = createGlowMaterial(ctx.uniforms, true);
    mats.push(gm);
    geos.push(gg);
    const me = new THREE.Mesh(gg, gm);
    me.name = 'city-furniture-lanterns';
    me.renderOrder = 2;
    trackViewport(me, gm);
    near.add(me);
    tris += G.count * 2;
  }
  solidSink = null;
  const bx = new Float32Array(bounds);
  const h2 = new Float32Array(hides);
  near.userData.triangles = tris;
  near.userData.counts = { ...counts, total: total(), target };

  // built before the modelled furniture arrived: rebuild the cells that hold any once it does
  let disposed = false;
  if (ops && ops.size > 0) {
    void loading.then((M) => {
      if (!M || disposed) return;
      for (let i = 0; i < cellMeshes.length; i++) {
        const src = cellWriters[i];
        const list = ops.get(src);
        if (!list) continue;
        const w = rebuilt(src, list, M);
        const g = w.geometry();
        if (!g?.boundingSphere || !g.boundingBox) continue;
        g.boundingSphere.radius += pads[i];
        near.userData.triangles += w.tris - src.tris;
        const me = cellMeshes[i];
        const old = me.geometry;
        me.geometry = g;
        geos[geos.indexOf(old)] = g;
        old.dispose();
        const bb = g.boundingBox;
        bx[i * 4] = bb.min.x;
        bx[i * 4 + 1] = bb.min.z;
        bx[i * 4 + 2] = bb.max.x;
        bx[i * 4 + 3] = bb.max.z;
      }
      ops.clear();
      cellWriters.length = 0;
    });
  } else {
    cellWriters.length = 0;
  }

  return {
    near,
    far: null,
    solids,
    emitters: [],
    update(_f, p) {
      for (let i = 0; i < cellMeshes.length; i++) {
        const b = i * 4;
        const dx = Math.max(bx[b] - p.x, 0, p.x - bx[b + 2]);
        const dz = Math.max(bx[b + 1] - p.z, 0, p.z - bx[b + 3]);
        cellMeshes[i].visible = dx * dx + dz * dz < h2[i];
      }
    },
    dispose() {
      disposed = true;
      ops?.clear();
      cellWriters.length = 0;
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      geos.length = 0;
      mats.length = 0;
    },
  };
};

/** Samples of what this draws beyond the shared city materials, for the shader warm-up (see render/warm.ts). */
export function warmFurniture(uniforms: Uniforms): THREE.Object3D[] {
  return [warmObject(createFlexMaterial(uniforms), { normals: true })];
}
