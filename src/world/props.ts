// What lies about the open desert between the finds: boulders, outcrops of fins and stacked
// slabs, and cacti (saguaros with their arms, barrels, organ pipes, prickly pear). Placement is
// a seeded jittered grid of 28 m cells, at most one group to a cell, so a rock is always in the
// same place; it keeps clear of cities, the routes between them, rivers, the finds and their
// caverns, and wherever the game asks (the spawn point, the first fire). Cells are built in
// 112 m chunks near the player, each chunk one merged mesh, one mesh of contact shadows and one
// set of solids, and let go again once far behind.
import * as THREE from 'three';
import type { FrameState, SurfaceSample, Uniforms } from '../game/contract';
import type { DesertWorld } from './surface';
import { STYLE_GLSL } from '../render/styleGlsl';
import { loadModel, modelGeometry } from '../render/art';
import { Solids, type SolidKind } from './solids';
import { type Lead, leadPoint } from './lead';
import { STEP } from '../game/player';

const CELL = 28; // one group at most per cell (m)
const PER = 4; // cells along a chunk's side
const CHUNK = CELL * PER;
/** Footprint radius of a group, by size class: small, medium, large (m). */
const SIZES = [2.5, 4.5, 7.5];
const SPACE = 1.5; // kept between the footprints of two groups (m)
const EDGE = 10; // the most anything of a group reaches past its own chunk (m)
const CITY_CLEAR = 760; // beyond a city's radius (the miner's lamp lies 700 m out on open sand)
const ROUTE_CLEAR = 45; // either side of the line between two neighbouring cities: track and waymarks
const RIVER_CLEAR = 90; // from a river's centre line: water, banks and groves
const CAVE_CLEAR = 8; // around a massif's cave
const SCAN_EVERY = 0.25;
const LEAD_S = 2.5; // chunks are also built around where the wanderer will be this many seconds on
const LEAD_MAX = 180; // and never further ahead than this (m)
const FADE = 80; // the far edge dissolves over this (m)
const FAR: Record<string, number> = { high: 640, low: 480, mobile: 340 };
const TAU = Math.PI * 2;
const REACH_OUT = 0.45; // where feet stop short of a wall, a little past the wanderer's reach (m)

const ROCK = 0;
const CACTUS = 1;
const BLOOM = 2; // flowers and fruit: their own colour, lit like sand

// ------------------------------------------------------------------ hashing and noise

function hash4(a: number, b: number, c: number, d: number): number {
  let h = 0x811c9dc5 ^ Math.imul(a | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) ^ Math.imul(d | 0, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t: number) => t * t * (3 - 2 * t);
const smooth = (a: number, b: number, v: number) => fade(Math.min(1, Math.max(0, (v - a) / (b - a))));

/** Value noise in 0..1 over a unit lattice. */
function noise2(x: number, z: number, seed: number, salt: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const ux = fade(x - ix);
  const uz = fade(z - iz);
  const a = hash4(ix, iz, seed, salt);
  const b = hash4(ix + 1, iz, seed, salt);
  const c = hash4(ix, iz + 1, seed, salt);
  const d = hash4(ix + 1, iz + 1, seed, salt);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** The same in three dimensions: a function of position only, so shared corners move together. */
function noise3(x: number, y: number, z: number, salt: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const ux = fade(x - ix);
  const uy = fade(y - iy);
  const uz = fade(z - iz);
  const h = (i: number, j: number, k: number) => hash4(ix + i, iy + j, iz + k, salt);
  const x00 = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * ux;
  const x10 = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * ux;
  const x01 = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * ux;
  const x11 = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

// ------------------------------------------------------------------ shaders

const NOISE = /* glsl */ `
float ph21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float pvn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ph21(i), ph21(i + vec2(1.0, 0.0)), u.x), mix(ph21(i + vec2(0.0, 1.0)), ph21(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const propVert = /* glsl */ `
attribute vec3 aTint;
attribute float aKind;
attribute float aUp;
varying vec3 vW;
varying vec3 vN;
varying vec3 vTint;
varying float vKind;
varying float vUp;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vTint = aTint;
  vKind = aKind;
  vUp = aUp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// Rock in the ground's own rock colours, cacti in the greens the palms use, both mixed from
// shade to lit by the sun like everything else, darker where they meet the sand, then fogged.
const propFrag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uRockLit;
uniform vec3 uRockShade;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uTop;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uPropFar;
varying vec3 vW;
varying vec3 vN;
varying vec3 vTint;
varying float vKind;
varying float vUp;
${NOISE}
${STYLE_GLSL}
void main() {
  vec3 n = normalize(vN);
  n = styleFacet(n, vW);
  float l = styleBands(smoothstep(-0.12, 0.42, dot(n, uSunDir)), vW.xz);
  float dist = length(vW - cameraPosition);
  // at the far edge of what is built they dissolve rather than pop
  if (dist > uPropFar - ${FADE.toFixed(1)} * ph21(gl_FragCoord.xy)) discard;
  vec3 col;
  if (vKind < 0.5) {
    float m = pvn(vW.xz * 0.5 + vec2(vW.y * 0.7, -vW.y * 0.3)) * 0.6 + pvn(vW.xz * 2.1 + vW.y * 1.3) * 0.4;
    float strata = 0.95 + 0.05 * sin(vW.y * 4.2 + pvn(vW.xz * 0.25) * 6.0);
    col = mix(uRockShade, uRockLit, l * 0.9) * vTint * (0.86 + 0.26 * m) * strata;
  } else if (vKind < 1.5) {
    float m = pvn(vW.xz * 3.0 + vW.y * 2.0);
    col = mix(uShade * vec3(0.4, 0.5, 0.36), uLit * vec3(0.5, 0.64, 0.4), l) * vTint * (0.92 + 0.12 * m);
    // spines catch the light: pale specks, close to only
    float sp = step(0.9, ph21(floor(vW.xz * 9.0) + floor(vW.y * 9.0) * 17.0));
    col = mix(col, uLit * 0.95, sp * 0.22 * (1.0 - smoothstep(8.0, 30.0, dist)));
  } else {
    col = vTint * dot(mix(uShade, uLit, l), vec3(0.3333)) * 1.25;
  }
  float low = 1.0 - smoothstep(0.0, 1.3, vUp);
  col *= 1.0 - 0.3 * low;
  col += (uLit - col) * 0.07 * low * (1.0 - l);
  col += (uTop - col) * 0.06 * max(n.y, 0.0) * (1.0 - l);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

const shadeVert = /* glsl */ `
attribute vec4 aShadow;
varying vec3 vL;
varying vec3 vW;
varying vec4 vS;
void main() {
  vL = position;
  vS = aShadow;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// A soft shadow on the sand under each group: a dark ring where it meets the ground, and a
// stroke laid away from the light as long as the thing is tall (within the patch). Multiplied
// over the ground.
const shadeFrag = /* glsl */ `
uniform vec3 uSunDir;
uniform float uNight;
uniform float uFog;
uniform float uPropFar;
varying vec3 vL;
varying vec3 vW;
varying vec4 vS;
void main() {
  vec2 p = vL.xz - vS.xy;
  float r = vS.z;
  float h = vS.w;
  float R = r * 1.25 + min(h * 1.25, 9.0);
  vec2 sh = -uSunDir.xz / max(uSunDir.y, 0.25) * h * 0.85;
  float L = length(sh);
  float lim = max(R - r * 1.2, 0.0);
  if (L > lim) sh *= lim / L;
  float t = clamp(dot(p, sh) / max(dot(sh, sh), 1e-4), 0.0, 1.0);
  float d = length(p - sh * t);
  float w = r * mix(1.0, 0.55, t);
  float strk = (1.0 - smoothstep(w * 0.45, w * 1.2, d)) * mix(0.8, 0.4, t);
  float contact = (1.0 - smoothstep(r * 0.5, r * 1.35, length(p))) * 0.9;
  float a = max(strk, contact) * (1.0 - 0.6 * uNight);
  float dist = length(vW - cameraPosition);
  a *= (1.0 - smoothstep(uPropFar * 0.4, uPropFar * 0.7, dist)) * exp(-dist * uFog);
  gl_FragColor = vec4(vec3(1.0 - 0.36 * a), 1.0);
}
`;

// ------------------------------------------------------------------ geometry

function triangles(g: THREE.BufferGeometry): Float32Array {
  const ng = g.index ? g.toNonIndexed() : g;
  return (ng.attributes.position.array as Float32Array).slice();
}
/** Unit rock bodies to weather: coarse for the small, finer for the big. */
const ICO = [triangles(new THREE.IcosahedronGeometry(1, 1)), triangles(new THREE.IcosahedronGeometry(1, 2))];

/**
 * The modelled rocks (tools/blender/props.py writes public/art/props.glb): bedded, weathered
 * bodies in the same unit space as the icospheres, packed (x, y, z, shade) per vertex, three to a
 * triangle. Null until they have loaded, and for good without the file; rock() then weathers the
 * icospheres itself.
 */
let MODEL_ROCKS: { small: Float32Array[]; big: Float32Array[] } | null = null;
let rockLoad: Promise<boolean> | null = null;

function loadRocks(): Promise<boolean> {
  if (!rockLoad) {
    rockLoad = loadModel('props.glb').then((gltf) => {
      if (!gltf) return false;
      const get = (name: string): Float32Array | null => {
        const g = modelGeometry(gltf, name);
        const shade = g?.getAttribute('_shade');
        if (!g || !shade) return null;
        const pos = g.getAttribute('position');
        const idx = g.getIndex();
        const n = idx ? idx.count : pos.count;
        const out = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          const v = idx ? idx.getX(i) : i;
          out[i * 4] = pos.getX(v);
          out[i * 4 + 1] = pos.getY(v);
          out[i * 4 + 2] = pos.getZ(v);
          out[i * 4 + 3] = shade.getX(v);
        }
        return out;
      };
      const big = [0, 1, 2, 3].map((i) => get(`Boulder${i}`)).filter((a): a is Float32Array => !!a);
      const small = [0, 1, 2].map((i) => get(`Stone${i}`)).filter((a): a is Float32Array => !!a);
      if (big.length === 0 || small.length === 0) return false;
      MODEL_ROCKS = { small, big };
      return true;
    });
  }
  return rockLoad;
}

const _m = new THREE.Matrix4();
const _mi = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/**
 * One upright part of a group as the wanderer meets it: a footprint (an ellipse turned by yaw)
 * standing from `bottom` to `top`, `vis` the top of what is drawn there. `post` false for a part
 * that keeps its own solids (a saguaro) and is here only so its neighbours know it is tall.
 */
interface Piece {
  x: number;
  z: number;
  rx: number;
  rz: number;
  yaw: number;
  bottom: number;
  top: number;
  vis: number;
  kind: SolidKind;
  post: boolean;
}

/** Everything one chunk is made of, written relative to its origin. */
class Build {
  readonly pos: number[] = [];
  readonly tint: number[] = [];
  readonly kind: number[] = [];
  readonly up: number[] = [];
  readonly shPos: number[] = [];
  readonly shAttr: number[] = [];
  readonly shIdx: number[] = [];
  readonly solids = new Solids();
  /** Footprints of the groups: x, z, r (world). */
  readonly spots: number[] = [];
  r = 1;
  g = 1;
  b = 1;
  k = ROCK;
  /** Ground under the group being built: aUp is measured from it. */
  base = 0;
  groups = 0;

  constructor(
    readonly world: DesertWorld,
    readonly ox: number,
    readonly oy: number,
    readonly oz: number,
  ) {}

  tintTo(r: number, g: number, b: number, k: number): void {
    this.r = r;
    this.g = g;
    this.b = b;
    this.k = k;
  }

  private vert(p: ArrayLike<number>, i: number): void {
    const o = i * 4;
    const m = p[o + 3];
    this.pos.push(p[o] - this.ox, p[o + 1] - this.oy, p[o + 2] - this.oz);
    this.tint.push(this.r * m, this.g * m, this.b * m);
    this.kind.push(this.k);
    this.up.push(p[o + 1] - this.base);
  }

  /**
   * A triangle of points packed (x, y, z, shade) in p, turned to face away from the point
   * (rx, ry, rz) inside the solid it bounds.
   */
  face(p: ArrayLike<number>, a: number, b: number, c: number, rx: number, ry: number, rz: number): void {
    const A = a * 4;
    const B = b * 4;
    const C = c * 4;
    const e1x = p[B] - p[A];
    const e1y = p[B + 1] - p[A + 1];
    const e1z = p[B + 2] - p[A + 2];
    const e2x = p[C] - p[A];
    const e2y = p[C + 1] - p[A + 1];
    const e2z = p[C + 2] - p[A + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const mx = (p[A] + p[B] + p[C]) / 3 - rx;
    const my = (p[A + 1] + p[B + 1] + p[C + 1]) / 3 - ry;
    const mz = (p[A + 2] + p[B + 2] + p[C + 2]) / 3 - rz;
    this.vert(p, a);
    if (nx * mx + ny * my + nz * mz < 0) {
      this.vert(p, c);
      this.vert(p, b);
    } else {
      this.vert(p, b);
      this.vert(p, c);
    }
  }

  /** Lowest ground under a disc of radius r. */
  low(x: number, z: number, r: number): number {
    let lo = this.world.height(x, z);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      lo = Math.min(lo, this.world.height(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return lo;
  }

  // ---------------------------------------------------------------- solids (world in, local stored)

  /** A unit primitive placed by position, rotation (YXZ) and scale, all in world terms. */
  prim(shape: 'box' | 'cyl' | 'ball', x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, pitch: number, roll: number, kind: SolidKind): void {
    _p.set(x - this.ox, y - this.oy, z - this.oz);
    _q.setFromEuler(_e.set(pitch, yaw, roll, 'YXZ'));
    _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    _mi.copy(_m).invert();
    this.solids.addPrim(shape, _m, _mi, kind);
  }

  /** An upright footprint (elliptic cylinder) from y0 to y1. */
  post(x: number, z: number, rx: number, rz: number, y0: number, y1: number, yaw: number, kind: SolidKind): void {
    this.prim('cyl', x, (y0 + y1) * 0.5, z, rx, y1 - y0, rz, yaw, 0, 0, kind);
  }

  capsule(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, kind: SolidKind): void {
    this.solids.addCapsule(_a.set(ax - this.ox, ay - this.oy, az - this.oz), _b.set(bx - this.ox, by - this.oy, bz - this.oz), r, kind);
  }

  /** The upright parts of the group being built, each made a post by `seal`. */
  private readonly pieces: Piece[] = [];

  piece(x: number, z: number, rx: number, rz: number, yaw: number, bottom: number, top: number, vis: number, kind: SolidKind, post = true): void {
    this.pieces.push({ x, z, rx, rz, yaw, bottom, top, vis, kind, post });
  }

  /**
   * Stands the group's parts up as posts so that nothing in it is a stair. A part drawn more
   * than a step above the ground about it is a wall from that ground; so is anything that
   * touches a wall, however low, or it would be the stair onto it. Such a post rises at least
   * a step and a hand above the highest ground about it (above the lowest, for a lone part
   * drawn no more than a step over its uphill side, which can still be stepped onto from
   * there). Parts that are low and stand apart keep their own tops and are stepped onto.
   */
  seal(): void {
    const ps = this.pieces;
    const n = ps.length;
    if (n === 0) return;
    const w = this.world;
    const lo: number[] = [];
    const hi: number[] = [];
    const wall: boolean[] = [];
    for (const p of ps) {
      // the ground where feet stop short of the post
      const R = Math.max(p.rx, p.rz) + REACH_OUT;
      let l = w.height(p.x, p.z);
      let h = l;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU;
        const g = w.height(p.x + Math.cos(a) * R, p.z + Math.sin(a) * R);
        l = Math.min(l, g);
        h = Math.max(h, g);
      }
      lo.push(l);
      hi.push(h);
      wall.push(p.vis - l > STEP + 0.05);
    }
    const near = (i: number, j: number) => {
      const a = ps[i];
      const b = ps[j];
      return Math.hypot(a.x - b.x, a.z - b.z) < Math.max(a.rx, a.rz) + Math.max(b.rx, b.rz) + REACH_OUT;
    };
    const tall = wall.slice();
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = 0; i < n; i++) {
        if (wall[i]) continue;
        for (let j = 0; j < n; j++) {
          if (j !== i && wall[j] && near(i, j)) {
            wall[i] = changed = true;
            break;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      if (!p.post) continue;
      let top = p.top;
      if (wall[i]) {
        // (a hand short of a step, as feet can come at it from ground a little higher still)
        let alone = tall[i] && p.vis - hi[i] <= STEP - 0.1;
        for (let j = 0; j < n && alone; j++) if (j !== i && wall[j] && near(i, j)) alone = false;
        top = Math.max(top, (alone ? lo[i] : hi[i]) + STEP + 0.15);
      }
      this.post(p.x, p.z, p.rx, p.rz, p.bottom, top, p.yaw, p.kind);
    }
    ps.length = 0;
  }

  // ---------------------------------------------------------------- shadow

  /** The patch of sand a group's shadow is drawn on, laid over the ground. */
  shadow(x: number, z: number, r: number, h: number): void {
    const R = r * 1.25 + Math.min(h * 1.25, 9);
    const NR = 5;
    const NS = 14;
    const w = this.world;
    const lift = 0.12;
    const first = this.shPos.length / 3;
    const put = (px: number, pz: number) => {
      this.shPos.push(px - this.ox, w.height(px, pz) + lift - this.oy, pz - this.oz);
      this.shAttr.push(x - this.ox, z - this.oz, r, h);
    };
    put(x, z);
    for (let k = 1; k <= NR; k++) {
      const rad = R * (k / NR);
      for (let s = 0; s < NS; s++) {
        const a = (s / NS) * TAU;
        put(x + Math.cos(a) * rad, z + Math.sin(a) * rad);
      }
    }
    const I = (k: number, s: number) => first + 1 + (k - 1) * NS + (s % NS);
    for (let s = 0; s < NS; s++) this.shIdx.push(first, I(1, s + 1), I(1, s));
    for (let k = 1; k < NR; k++) {
      for (let s = 0; s < NS; s++) this.shIdx.push(I(k, s), I(k, s + 1), I(k + 1, s), I(k, s + 1), I(k + 1, s + 1), I(k + 1, s));
    }
  }

  // ---------------------------------------------------------------- output

  mesh(mat: THREE.ShaderMaterial): THREE.Mesh | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 3));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.kind, 1));
    g.setAttribute('aUp', new THREE.Float32BufferAttribute(this.up, 1));
    g.computeVertexNormals(); // not indexed: every face flat, weathered
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.position.set(this.ox, this.oy, this.oz);
    return m;
  }

  shadeMesh(mat: THREE.ShaderMaterial): THREE.Mesh | null {
    if (this.shPos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.shPos, 3));
    g.setAttribute('aShadow', new THREE.Float32BufferAttribute(this.shAttr, 4));
    g.setIndex(this.shIdx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.position.set(this.ox, this.oy, this.oz);
    m.renderOrder = 1;
    return m;
  }
}

// ------------------------------------------------------------------ rock

const _rock = new Float64Array(Math.max(ICO[1].length / 3, 1024) * 4);
const _ext = [0, 0, 0];

/**
 * A weathered rock: an icosphere pushed about by noise and cut by a few planes into flat faces,
 * its foot flattened (and buried), centred at (x, y, z), scaled and turned. Leaves its extents in
 * its own unit space (x, top, z) in _ext.
 */
function rock(b: Build, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, pitch: number, roll: number, rng: () => number, slab = false): void {
  const large = Math.max(sx, sy, sz) > 1.6;
  const salt = Math.floor(rng() * 65536);
  // the modelled bodies come weathered and bedded already; the cuts below still face them
  const set = MODEL_ROCKS ? (large ? MODEL_ROCKS.big : MODEL_ROCKS.small) : null;
  const model = set ? set[salt % set.length] : null;
  const src = model ?? ICO[large ? 1 : 0];
  const stride = model ? 4 : 3;
  const planes: number[] = [];
  const nside = 2 + Math.floor(rng() * 3);
  for (let k = 0; k < nside; k++) {
    const a = rng() * TAU;
    const e = rng() * 0.7 - 0.2;
    planes.push(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a), 0.62 + rng() * 0.25);
  }
  if (rng() < 0.7) {
    const tx = (rng() - 0.5) * 0.5;
    const tz = (rng() - 0.5) * 0.5;
    const l = Math.hypot(tx, 1, tz);
    planes.push(tx / l, 1 / l, tz / l, 0.62 + rng() * 0.2);
  }
  if (slab) planes.push(0, 0, 1, 0.68, 0, 0, -1, 0.68);
  const n = src.length / stride;
  const p = _rock;
  let ex = 0;
  let ey = 0;
  let ez = 0;
  _q.setFromEuler(_e.set(pitch, yaw, roll, 'YXZ'));
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  for (let i = 0; i < n; i++) {
    const vx = src[i * stride];
    const vy = src[i * stride + 1];
    const vz = src[i * stride + 2];
    const k = model ? 1 : 1 + 0.34 * (noise3(vx * 1.6, vy * 1.6, vz * 1.6, salt) - 0.5) + 0.12 * (noise3(vx * 4.1, vy * 4.1, vz * 4.1, salt + 1) - 0.5);
    let px = vx * k;
    let py = vy * k;
    let pz = vz * k;
    for (let j = 0; j < planes.length; j += 4) {
      const d = px * planes[j] + py * planes[j + 1] + pz * planes[j + 2] - planes[j + 3];
      if (d > 0) {
        px -= planes[j] * d;
        py -= planes[j + 1] * d;
        pz -= planes[j + 2] * d;
      }
    }
    if (py < -0.45) py = -0.45;
    ex = Math.max(ex, Math.abs(px));
    ey = Math.max(ey, py);
    ez = Math.max(ez, Math.abs(pz));
    _v.set(px, py, pz).applyMatrix4(_m);
    p[i * 4] = _v.x;
    p[i * 4 + 1] = _v.y;
    p[i * 4 + 2] = _v.z;
    p[i * 4 + 3] = model ? model[i * 4 + 3] : 1;
  }
  for (let i = 0; i < n; i += 3) b.face(p, i, i + 1, i + 2, x, y, z);
  _ext[0] = ex;
  _ext[1] = ey;
  _ext[2] = ez;
}

/**
 * A rock's solid: an ellipsoid the size of what was drawn, and an upright core under all of it
 * (made a post when the group is sealed). The ellipsoid alone would let you walk up a low
 * rock's flank as if it were a slope, or under a leaning one's overhang and up through it; the
 * core covers the ellipsoid's whole footprint, tilt and all, so its rim is no ledge either.
 */
function rockSolid(b: Build, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, pitch: number, roll: number, ground: number): void {
  const [ex, ey, ez] = _ext;
  const a = sx * ex * 0.94;
  const c = sy * ey * 0.97;
  const d = sz * ez * 0.94;
  b.prim('ball', x, y, z, a, c, d, yaw, pitch, roll, 0);
  // the ellipsoid's shadow straight down, and how far it reaches up: from R diag(a², c², d²) Rᵀ
  _m.makeRotationFromEuler(_e.set(pitch, yaw, roll, 'YXZ'));
  const m = _m.elements;
  const s2 = [a * a, c * c, d * d];
  let xx = 0;
  let xz = 0;
  let zz = 0;
  let yy = 0;
  for (let k = 0; k < 3; k++) {
    const rx = m[k * 4];
    const ry = m[k * 4 + 1];
    const rz = m[k * 4 + 2];
    xx += rx * rx * s2[k];
    xz += rx * rz * s2[k];
    zz += rz * rz * s2[k];
    yy += ry * ry * s2[k];
  }
  const mid = (xx + zz) * 0.5;
  const dev = Math.hypot((xx - zz) * 0.5, xz);
  const th = 0.5 * Math.atan2(2 * xz, xx - zz); // the long axis, (cos th, sin th) in x, z
  const up = Math.sqrt(yy);
  // a post's own x runs along (cos yaw, -sin yaw)
  b.piece(x, z, Math.sqrt(mid + dev) * 1.02, Math.sqrt(Math.max(mid - dev, 0)) * 1.02, -th, ground - 1, y + up * 0.97, y + up, 0);
}

function rockTint(b: Build, rng: () => number): void {
  const v = 0.86 + rng() * 0.24;
  const q = rng();
  if (q < 0.3) b.tintTo(1.07 * v, 0.93 * v, 0.84 * v, ROCK); // iron-red
  else if (q < 0.5) b.tintTo(0.96 * v, 0.96 * v, 0.95 * v, ROCK); // grey
  else b.tintTo(1.02 * v, 0.98 * v, 0.92 * v, ROCK);
}

interface Made {
  h: number; // height for the shadow
  sr: number; // shadow footprint radius
}

/** One boulder, waist high or more, and perhaps a stone or two at its foot. */
function boulder(b: Build, x: number, z: number, r: number, rng: () => number): Made {
  const big = r > 3;
  let sy = big ? 1.5 + rng() * 0.9 : 1.15 + rng() * 0.4;
  let sx = sy * (1.1 + rng() * 0.5);
  let sz = sx * (0.7 + rng() * 0.3);
  const k = Math.min(1, (r * 0.75) / Math.max(sx, sz));
  sx *= k;
  sz *= k;
  sy = Math.max(sy * k, 1.15);
  const yaw = rng() * TAU;
  const pitch = (rng() - 0.5) * 0.3;
  const roll = (rng() - 0.5) * 0.3;
  const g = b.low(x, z, Math.max(sx, sz) * 0.8);
  b.base = g;
  const y = g + sy * 0.25;
  rockTint(b, rng);
  rock(b, x, y, z, sx, sy, sz, yaw, pitch, roll, rng);
  rockSolid(b, x, y, z, sx, sy, sz, yaw, pitch, roll, g);
  const top = y + sy * _ext[1];
  const foot = Math.max(sx, sz);
  const n = Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const s = 0.35 + rng() * 0.35;
    const a = rng() * TAU;
    const d = Math.min(foot + s * 0.6, r - s * 1.2);
    const px = x + Math.cos(a) * d;
    const pz = z + Math.sin(a) * d;
    const pg = b.low(px, pz, s);
    rock(b, px, pg + s * 0.2, pz, s * (1 + rng() * 0.4), s, s * (0.8 + rng() * 0.3), rng() * TAU, rng() - 0.5, rng() - 0.5, rng);
    rockSolid(b, px, pg + s * 0.2, pz, s * 1.2, s, s * 0.95, 0, 0, 0, pg);
  }
  return { h: top - g, sr: foot * 0.95 };
}

/** A heap of boulders: one big one and its fallen neighbours. */
function cluster(b: Build, x: number, z: number, r: number, rng: () => number): Made {
  const g0 = b.low(x, z, r * 0.6);
  b.base = g0;
  rockTint(b, rng);
  const sy0 = 1.7 + rng() * 1.1;
  const sx0 = Math.min(sy0 * (1.1 + rng() * 0.4), r * 0.45);
  const sz0 = sx0 * (0.75 + rng() * 0.25);
  const yaw0 = rng() * TAU;
  const y0 = g0 + sy0 * 0.25;
  rock(b, x, y0, z, sx0, sy0, sz0, yaw0, (rng() - 0.5) * 0.2, (rng() - 0.5) * 0.2, rng);
  rockSolid(b, x, y0, z, sx0, sy0, sz0, yaw0, 0, 0, g0);
  let top = y0 + sy0 * _ext[1];
  const n = 2 + Math.floor(rng() * 4);
  const a0 = rng() * TAU;
  for (let i = 0; i < n; i++) {
    const sy = sy0 * (0.4 + rng() * 0.4);
    const sx = sy * (1 + rng() * 0.5);
    const sz = sx * (0.7 + rng() * 0.3);
    const a = a0 + (i / n) * TAU + (rng() - 0.5) * 0.8;
    const d = Math.min(sx0 * 0.8 + sx * 0.7, r - Math.max(sx, sz) * 1.05);
    const px = x + Math.cos(a) * d;
    const pz = z + Math.sin(a) * d;
    const g = b.low(px, pz, sx * 0.7);
    const yaw = rng() * TAU;
    const pitch = (rng() - 0.5) * 0.5;
    const roll = (rng() - 0.5) * 0.5;
    const y = g + sy * 0.25;
    rock(b, px, y, pz, sx, sy, sz, yaw, pitch, roll, rng);
    rockSolid(b, px, y, pz, sx, sy, sz, yaw, pitch, roll, g);
    top = Math.max(top, y + sy * _ext[1]);
  }
  return { h: top - g0, sr: r * 0.7 };
}

/** Fins: slabs of bedded rock standing out of the sand, all leaning the same way. */
function fins(b: Build, x: number, z: number, r: number, rng: () => number): Made {
  const g0 = b.low(x, z, r * 0.6);
  b.base = g0;
  rockTint(b, rng);
  const yaw = rng() * TAU;
  const lean = (0.08 + rng() * 0.16) * (rng() < 0.5 ? -1 : 1);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const n = 2 + Math.floor(rng() * 3);
  let top = g0;
  for (let i = 0; i < n; i++) {
    const across = (i - (n - 1) / 2) * (1.6 + rng() * 0.6);
    const along = (rng() - 0.5) * 2;
    // local x runs along the fin, z across it (Three's yaw turns +x to (cos, -sin))
    const px = x + cy * along + sy * across;
    const pz = z - sy * along + cy * across;
    const L = Math.min(2 + rng() * 2.2, r - Math.hypot(along, across) - 0.6);
    if (L < 1) continue;
    const H = 1.8 + rng() * 1.9;
    const T = 0.55 + rng() * 0.4;
    const g = b.low(px, pz, L * 0.6);
    const y = g + H * 0.2;
    const fy = yaw + (rng() - 0.5) * 0.2;
    rock(b, px, y, pz, L, H, T, fy, lean + (rng() - 0.5) * 0.06, (rng() - 0.5) * 0.1, rng, true);
    rockSolid(b, px, y, pz, L, H, T, fy, lean, 0, g);
    top = Math.max(top, y + H * _ext[1]);
  }
  return { h: top - g0, sr: r * 0.55 };
}

/** A tor: flat slabs stacked one on another, each a little smaller. */
function stack(b: Build, x: number, z: number, r: number, rng: () => number): Made {
  const g0 = b.low(x, z, r * 0.5);
  b.base = g0;
  rockTint(b, rng);
  const layers = 2 + Math.floor(rng() * 3);
  let w = Math.min(1.3 + rng() * 1.2, r * 0.6);
  let y = g0;
  let cx = x;
  let cz = z;
  for (let i = 0; i < layers; i++) {
    const sy = 0.55 + rng() * 0.35;
    const sx = w * (0.9 + rng() * 0.2);
    const sz = w * (0.75 + rng() * 0.2);
    const yaw = rng() * TAU;
    const cyc = y + sy * (i === 0 ? 0.35 : 0.4);
    rock(b, cx, cyc, cz, sx, sy, sz, yaw, (rng() - 0.5) * 0.12, (rng() - 0.5) * 0.12, rng);
    rockSolid(b, cx, cyc, cz, sx, sy, sz, yaw, 0, 0, g0);
    y = cyc + sy * _ext[1] * 0.92;
    w *= 0.68 + rng() * 0.18;
    cx += (rng() - 0.5) * w * 0.5;
    cz += (rng() - 0.5) * w * 0.5;
    if (w < 0.45) break;
  }
  // each slab's core stands on the ground, so the tor's ledges are not a stair
  return { h: y - g0, sr: Math.min(r * 0.5, 2) };
}

// ------------------------------------------------------------------ cacti

const _ring = new Float64Array(4 * 2 * 32 * 2 + 8);
const _tube: number[] = [];

/**
 * A ribbed stem along points (world), radius per point: each ring alternates rib and groove, the
 * grooves shaded darker. Closed at the far end with a point; `shades` darkens or browns ring by ring.
 */
function ribTube(b: Build, pts: THREE.Vector3[], radii: number[], ribs: number, depth: number, shades?: number[]): void {
  const n = pts.length;
  const sides = ribs * 2;
  const t = new THREE.Vector3();
  const prevT = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const bin = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const ring = _tube;
  ring.length = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) t.subVectors(pts[1], pts[0]).normalize();
    else if (i === n - 1) t.subVectors(pts[n - 1], pts[n - 2]).normalize();
    else t.subVectors(pts[i + 1], pts[i - 1]).normalize();
    if (i === 0) {
      nrm.set(1, 0, 0);
      if (Math.abs(t.x) > 0.9) nrm.set(0, 0, 1);
      nrm.addScaledVector(t, -nrm.dot(t)).normalize();
    } else {
      q.setFromUnitVectors(prevT, t);
      nrm.applyQuaternion(q);
    }
    prevT.copy(t);
    bin.crossVectors(t, nrm).normalize();
    const sh = shades ? shades[i] : 1;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * TAU;
      const groove = s & 1;
      const r = radii[i] * (groove ? 1 - depth : 1);
      const ca = Math.cos(a) * r;
      const sa = Math.sin(a) * r;
      ring.push(pts[i].x + nrm.x * ca + bin.x * sa, pts[i].y + nrm.y * ca + bin.y * sa, pts[i].z + nrm.z * ca + bin.z * sa, sh * (groove ? 0.8 : 1.05));
    }
  }
  const p = _ring;
  const R = (i: number, s: number, slot: number) => {
    const o = (i * sides + (s % sides)) * 4;
    p[slot * 4] = ring[o];
    p[slot * 4 + 1] = ring[o + 1];
    p[slot * 4 + 2] = ring[o + 2];
    p[slot * 4 + 3] = ring[o + 3];
  };
  for (let i = 0; i < n - 1; i++) {
    const cx = (pts[i].x + pts[i + 1].x) * 0.5;
    const cy = (pts[i].y + pts[i + 1].y) * 0.5;
    const cz = (pts[i].z + pts[i + 1].z) * 0.5;
    for (let s = 0; s < sides; s++) {
      R(i, s, 0);
      R(i, s + 1, 1);
      R(i + 1, s + 1, 2);
      R(i + 1, s, 3);
      b.face(p, 0, 1, 2, cx, cy, cz);
      b.face(p, 0, 2, 3, cx, cy, cz);
    }
  }
  // a point over the last ring
  const e = pts[n - 1];
  t.subVectors(pts[n - 1], pts[n - 2]).normalize();
  const tip = radii[n - 1] * 0.45;
  p[8] = e.x + t.x * tip;
  p[9] = e.y + t.y * tip;
  p[10] = e.z + t.z * tip;
  p[11] = shades ? shades[n - 1] * 1.05 : 1.05;
  for (let s = 0; s < sides; s++) {
    R(n - 1, s, 0);
    R(n - 1, s + 1, 1);
    b.face(p, 0, 1, 2, e.x - t.x, e.y - t.y, e.z - t.z);
  }
}

/** Points up a stem from y0 to y1 at (x, z), then a rounded crown of radius r. */
function stem(x: number, z: number, y0: number, y1: number, r: number, step: number, lean: [number, number] | null, pts: THREE.Vector3[], radii: number[], taper = 0.08): void {
  const n = Math.max(2, Math.ceil((y1 - y0) / step));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const lx = lean ? lean[0] * t * t : 0;
    const lz = lean ? lean[1] * t * t : 0;
    pts.push(new THREE.Vector3(x + lx, y0 + (y1 - y0) * t, z + lz));
    radii.push(r * (1 - taper * t));
  }
  const top = pts[pts.length - 1];
  const rt = radii[radii.length - 1];
  for (const phi of [0.5, 0.95, 1.3]) {
    pts.push(new THREE.Vector3(top.x, top.y + rt * 0.85 * Math.sin(phi), top.z));
    radii.push(rt * Math.cos(phi));
  }
}

function cactusTint(b: Build, rng: () => number): void {
  const v = 0.88 + rng() * 0.2;
  b.tintTo(v * (0.95 + rng() * 0.1), v, v * (0.92 + rng() * 0.14), CACTUS);
}

/** Shade per ring: the old woody foot of a stem goes grey-brown. */
function footShades(pts: THREE.Vector3[], g: number): number[] {
  return pts.map((p) => 0.72 + 0.28 * smooth(g, g + 0.7, p.y));
}

/** A saguaro: a ribbed column with a domed top and, once old enough, arms that bend up. */
function saguaro(b: Build, x: number, z: number, r: number, rng: () => number, young: boolean): Made {
  const H = young ? 1.9 + rng() * 1.6 : 4.5 + rng() * 4;
  const R = young ? 0.22 + rng() * 0.1 : 0.3 + rng() * 0.14;
  const g = b.low(x, z, R * 1.5);
  b.base = g;
  cactusTint(b, rng);
  const lean: [number, number] = [(rng() - 0.5) * 0.4, (rng() - 0.5) * 0.4];
  const pts: THREE.Vector3[] = [];
  const radii: number[] = [];
  stem(x, z, g - 0.3, g + H, R, 0.7, lean, pts, radii);
  const ribs = 14 + Math.floor(rng() * 6);
  ribTube(b, pts, radii, ribs, 0.1, footShades(pts, g));
  b.capsule(x, g - 1, z, x + lean[0], g + H, z + lean[1], R * 0.95, 2);
  // and an upright post under all of the trunk, or its lean is an overhang to walk in under
  const ll = Math.hypot(lean[0], lean[1]);
  b.piece(x + lean[0] * 0.5, z + lean[1] * 0.5, R * 0.95 + ll * 0.5, R * 0.95 + ll * 0.5, 0, g - 1, g + H * 0.9, g + H, 2);
  let reach = R;
  let arm = 0;
  const arms = young ? 0 : [0, 1, 2, 2, 3, 3, 4][Math.floor(rng() * 7)];
  const a0 = rng() * TAU;
  for (let i = 0; i < arms; i++) {
    const az = a0 + (i / arms) * TAU + (rng() - 0.5) * 0.9;
    const ux = Math.cos(az);
    const uz = Math.sin(az);
    const ha = g + H * (0.3 + rng() * 0.35);
    const ra = R * (0.62 + rng() * 0.18);
    const out = Math.min(R + 0.35 + rng() * 0.6, r - ra - 0.3);
    const rc = 0.3 + rng() * 0.2;
    const armTop = Math.max(ha + rc + 0.6, Math.min(g + H * (0.72 + rng() * 0.25), g + H - 0.2));
    // where the trunk is at this height (it leans)
    const tt = (ha - g + 0.3) / (H + 0.3);
    const ax = x + lean[0] * tt * tt;
    const azz = z + lean[1] * tt * tt;
    const ap: THREE.Vector3[] = [];
    const ar: number[] = [];
    const at = (d: number, y: number) => ap.push(new THREE.Vector3(ax + ux * d, y, azz + uz * d));
    at(R * 0.2, ha - 0.04);
    ar.push(ra * 0.95);
    at(R + 0.08, ha + 0.02);
    ar.push(ra);
    at(out - rc, ha + 0.08);
    ar.push(ra);
    for (const th of [0.5, 1.0]) {
      at(out - rc + rc * Math.sin(th), ha + 0.08 + rc * (1 - Math.cos(th)));
      ar.push(ra);
    }
    const y0 = ha + 0.08 + rc;
    const nUp = Math.max(1, Math.ceil((armTop - y0) / 0.7));
    for (let k = 0; k <= nUp; k++) {
      at(out, y0 + ((armTop - y0) * k) / nUp);
      ar.push(ra * (1 - 0.06 * (k / nUp)));
    }
    const top = ap[ap.length - 1];
    for (const phi of [0.5, 0.95, 1.3]) {
      ap.push(new THREE.Vector3(top.x, top.y + ra * 0.85 * Math.sin(phi), top.z));
      ar.push(ra * Math.cos(phi));
    }
    ribTube(b, ap, ar, 10 + Math.floor(rng() * 3), 0.1);
    b.capsule(ax, ha + 0.04, azz, ax + ux * out, ha + 0.08, azz + uz * out, ra, 2);
    b.capsule(ax + ux * out, y0, azz + uz * out, ax + ux * out, armTop, azz + uz * out, ra, 2);
    reach = Math.max(reach, out * 0.6);
    arm = Math.max(arm, Math.hypot(ax - x, azz - z) + out + ra);
  }
  // the arms are solids of their own; this only tells what stands under them that they are tall
  if (arm > 0) b.piece(x, z, arm, arm, 0, g - 1, g + H, g + H, 2, false);
  return { h: H, sr: Math.max(R * 1.6, reach) };
}

/** A barrel cactus: squat, deeply ribbed, leaning south, with a crown of flowers. */
function barrel(b: Build, x: number, z: number, H: number, R: number, rng: () => number): number {
  const g = b.low(x, z, R);
  b.base = g;
  cactusTint(b, rng);
  const lean = 0.05 + rng() * 0.12; // toward the sun at noon (+z)
  const prof = [0.86, 0.98, 1, 0.97, 0.88, 0.7, 0.42];
  const ts = [0, 0.15, 0.35, 0.55, 0.75, 0.9, 1];
  const pts: THREE.Vector3[] = [];
  const radii: number[] = [];
  const y0 = g - 0.15;
  const len = H + 0.15;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    pts.push(new THREE.Vector3(x, y0 + Math.cos(lean) * len * t, z + Math.sin(lean) * len * t));
    radii.push(R * prof[i]);
  }
  ribTube(b, pts, radii, 16 + Math.floor(rng() * 7), 0.14, footShades(pts, g));
  // flowers: a ring of little points of colour on the crown
  const top = pts[pts.length - 1];
  const red = rng() < 0.4;
  b.tintTo(red ? 1.15 : 1.25, red ? 0.42 : 0.9, red ? 0.3 : 0.32, BLOOM);
  const nf = 5 + Math.floor(rng() * 4);
  const p = _ring;
  for (let i = 0; i < nf; i++) {
    const a = (i / nf) * TAU + rng() * 0.3;
    const fx = top.x + Math.cos(a) * R * 0.32;
    const fz = top.z + Math.sin(a) * R * 0.32;
    const fy = top.y - 0.02;
    const s = 0.05 + rng() * 0.03;
    // a little three-sided cone
    for (let k = 0; k < 3; k++) {
      const c0 = a + (k / 3) * TAU;
      const c1 = a + ((k + 1) / 3) * TAU;
      p[0] = fx + Math.cos(c0) * s;
      p[1] = fy;
      p[2] = fz + Math.sin(c0) * s;
      p[3] = 1;
      p[4] = fx + Math.cos(c1) * s;
      p[5] = fy;
      p[6] = fz + Math.sin(c1) * s;
      p[7] = 1;
      p[8] = fx;
      p[9] = fy + s * 1.6;
      p[10] = fz;
      p[11] = 1;
      b.face(p, 0, 1, 2, fx, fy + s * 0.4, fz);
    }
  }
  b.piece(x, z + Math.sin(lean) * H * 0.4, R * 0.92, R * 0.92, 0, g - 1, g + H * 0.92, g + H, 2);
  return H;
}

function barrels(b: Build, x: number, z: number, r: number, rng: () => number): Made {
  const n = 1 + Math.floor(rng() * 3);
  let h = 0;
  const a0 = rng() * TAU;
  for (let i = 0; i < n; i++) {
    const H = i === 0 ? 1 + rng() * 0.7 : 0.6 + rng() * 0.6;
    const R = H * (0.36 + rng() * 0.1);
    const d = i === 0 ? 0 : Math.min(0.9 + rng() * 0.6, r - R - 0.3);
    const a = a0 + i * 2.4;
    h = Math.max(h, barrel(b, x + Math.cos(a) * d, z + Math.sin(a) * d, H, R, rng));
  }
  return { h, sr: n > 1 ? 1.4 : 0.6 };
}

/** Organ pipe: a clump of thin ribbed stems that rise from one root and splay out. */
function organ(b: Build, x: number, z: number, r: number, rng: () => number): Made {
  const g = b.low(x, z, 0.8);
  b.base = g;
  cactusTint(b, rng);
  const n = 4 + Math.floor(rng() * 5);
  const H0 = 2.6 + rng() * 2.4;
  const spread = 0.35 + rng() * 0.25;
  let hMin = Infinity;
  let hMax = 0;
  let reach = 0;
  const a0 = rng() * TAU;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU + (rng() - 0.5) * 0.6;
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    const rs = 0.13 + rng() * 0.07;
    const out = Math.min(spread + 0.3 + rng() * 0.6, r - rs - 0.4);
    const Hi = H0 * (0.55 + rng() * 0.5);
    const pts: THREE.Vector3[] = [];
    const radii: number[] = [];
    // out from the root, then up
    for (const [d, y] of [[0.1, -0.3], [spread * 0.5, 0.15], [out * 0.8, 0.55], [out, 1.0]]) {
      pts.push(new THREE.Vector3(x + ux * d, g + y, z + uz * d));
      radii.push(rs);
    }
    const sx = x + ux * out;
    const sz = z + uz * out;
    const up: THREE.Vector3[] = [];
    const ur: number[] = [];
    stem(sx, sz, g + 1.0, g + Hi, rs, 0.8, null, up, ur, 0.05);
    for (let k = 1; k < up.length; k++) {
      pts.push(up[k]);
      radii.push(ur[k]);
    }
    ribTube(b, pts, radii, 9 + Math.floor(rng() * 3), 0.12, footShades(pts, g));
    b.capsule(sx, g + 1.0, sz, sx, g + Hi, sz, rs, 2);
    hMin = Math.min(hMin, Hi);
    hMax = Math.max(hMax, Hi);
    reach = Math.max(reach, out + rs);
  }
  b.piece(x, z, spread + 0.35, spread + 0.35, 0, g - 1, g + Math.max(1.2, hMin * 0.8), g + hMax, 2);
  // the stems are solids of their own; this only tells what stands about them that they are tall
  b.piece(x, z, reach, reach, 0, g - 1, g + hMax, g + hMax, 2, false);
  return { h: hMax, sr: spread + 0.6 };
}

/** Prickly pear: flat pads that grow out of one another's rims, a few with fruit. */
function pear(b: Build, x: number, z: number, r: number, rng: () => number): Made {
  const g = b.low(x, z, Math.min(r, 1.5));
  b.base = g;
  const v = 0.86 + rng() * 0.2;
  const tr = 0.82 * v;
  const tg = 1.0 * v;
  const tb = (0.95 + rng() * 0.15) * v;
  const T = 0.055 + rng() * 0.02;
  const pads: { c: THREE.Vector3; u: THREE.Vector3; nn: THREE.Vector3; w: number; hh: number; lvl: number }[] = [];
  const keep = r - 0.4;
  const grow = (base: THREE.Vector3, u: THREE.Vector3, nn: THREE.Vector3, lvl: number) => {
    const w = (0.2 + rng() * 0.1) * (1 - lvl * 0.08);
    const hh = w * (1.25 + rng() * 0.25);
    const c = base.clone().addScaledVector(u, hh * 0.9);
    if (Math.hypot(c.x - x, c.z - z) > keep - w) return;
    pads.push({ c, u, nn, w, hh, lvl });
    if (lvl >= 3 || pads.length > 18) return;
    const kids = rng() < 0.75 - lvl * 0.15 ? 1 + (rng() < 0.45 ? 1 : 0) : 0;
    for (let k = 0; k < kids; k++) {
      const th = (rng() < 0.5 ? -1 : 1) * (0.25 + rng() * 0.55);
      const s = new THREE.Vector3().crossVectors(u, nn);
      const pb = c.clone().addScaledVector(u, hh * Math.cos(th)).addScaledVector(s, w * Math.sin(th));
      const nu = u.clone().multiplyScalar(Math.cos(th)).addScaledVector(s, Math.sin(th));
      nu.y += 0.35;
      nu.normalize();
      // turned about the vertical a little, then square to the new up
      const turn = (rng() - 0.5) * 1.6;
      const yq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn);
      nu.applyQuaternion(yq);
      const nn2 = nn.clone().applyQuaternion(yq);
      nn2.addScaledVector(nu, -nn2.dot(nu)).normalize();
      grow(pb, nu, nn2, lvl + 1);
    }
  };
  const nb = 2 + Math.floor(rng() * 3);
  const a0 = rng() * TAU;
  for (let i = 0; i < nb; i++) {
    const a = a0 + (i / nb) * TAU + (rng() - 0.5) * 0.8;
    const yaw = rng() * TAU;
    const nn = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const s0 = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), nn);
    const lean = (rng() - 0.5) * 0.7;
    const u = new THREE.Vector3(0, Math.cos(lean), 0).addScaledVector(s0, Math.sin(lean));
    grow(new THREE.Vector3(x + Math.cos(a) * 0.3, g - 0.05, z + Math.sin(a) * 0.3), u, nn, 0);
  }
  // the pads: a lens each, a rim of ten with a centre a little proud on either face
  const p = _ring;
  const RIM = 10;
  let top = g;
  let far = 0;
  for (const pd of pads) {
    const s = new THREE.Vector3().crossVectors(pd.u, pd.nn);
    const shade = pd.lvl === 0 ? 0.85 : 1;
    b.tintTo(tr * shade, tg * shade, tb * shade, CACTUS);
    for (let k = 0; k < RIM; k++) {
      const th = (k / RIM) * TAU;
      _v.copy(pd.c).addScaledVector(pd.u, pd.hh * Math.cos(th)).addScaledVector(s, pd.w * Math.sin(th));
      p[k * 4] = _v.x;
      p[k * 4 + 1] = _v.y;
      p[k * 4 + 2] = _v.z;
      p[k * 4 + 3] = 0.92;
      top = Math.max(top, _v.y);
    }
    for (let f = 0; f < 2; f++) {
      const o = (RIM + f) * 4;
      const sg = f === 0 ? T : -T;
      p[o] = pd.c.x + pd.nn.x * sg;
      p[o + 1] = pd.c.y + pd.nn.y * sg;
      p[o + 2] = pd.c.z + pd.nn.z * sg;
      p[o + 3] = 1.06;
    }
    for (let k = 0; k < RIM; k++) {
      b.face(p, RIM, k, (k + 1) % RIM, pd.c.x, pd.c.y, pd.c.z);
      b.face(p, RIM + 1, (k + 1) % RIM, k, pd.c.x, pd.c.y, pd.c.z);
    }
    far = Math.max(far, Math.hypot(pd.c.x - x, pd.c.z - z) + pd.w);
    // fruit along the top rim of the outermost pads
    if (pd.lvl >= 1 && rng() < 0.4) {
      b.tintTo(0.78, 0.2, 0.34, BLOOM);
      const nfr = 2 + Math.floor(rng() * 3);
      for (let k = 0; k < nfr; k++) {
        const th = (rng() - 0.5) * 1.6;
        _v.copy(pd.c).addScaledVector(pd.u, pd.hh * Math.cos(th) + 0.04).addScaledVector(s, pd.w * Math.sin(th));
        const fs = 0.05;
        // a tiny octahedron
        const O = [[1, 0, 0], [-1, 0, 0], [0, 1.4, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        for (let j = 0; j < 6; j++) {
          p[j * 4] = _v.x + O[j][0] * fs;
          p[j * 4 + 1] = _v.y + O[j][1] * fs;
          p[j * 4 + 2] = _v.z + O[j][2] * fs;
          p[j * 4 + 3] = 1;
        }
        for (const [i0, i1] of [[0, 4], [4, 1], [1, 5], [5, 0]]) {
          b.face(p, i0, i1, 2, _v.x, _v.y, _v.z);
          b.face(p, i1, i0, 3, _v.x, _v.y, _v.z);
        }
      }
    }
  }
  if (pads.length === 0) return { h: 0, sr: 0 };
  const rr = Math.max(0.5, far * 0.75);
  // a clump drawn more than a step high is made a wall when the group is sealed
  b.piece(x, z, rr, rr, 0, g - 1, g + Math.max(0.6, (top - g) * 0.85), top, 2);
  return { h: top - g, sr: Math.max(0.7, far * 0.8) };
}

// ------------------------------------------------------------------ the props

interface Chunk {
  ix: number;
  iz: number;
  ox: number;
  oy: number;
  oz: number;
  mesh: THREE.Mesh | null;
  shade: THREE.Mesh | null;
  solids: Solids | null;
  /** Footprints of its groups: x, z, r. */
  spots: number[];
  groups: number;
}

const chunkKey = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);

export class Props {
  readonly group = new THREE.Group();
  /**
   * Ground some other system has a claim on (the finds and their caverns), which props keep off:
   * whether a disc of radius r at (x, z) touches any of it. Should not change from call to call.
   */
  blocked: ((x: number, z: number, r: number) => boolean) | null = null;
  /** What the last topAt stood on, when it returned a height: 0 stone, 2 a cactus (as wood). */
  kind: SolidKind = 0;

  private readonly world: DesertWorld;
  private readonly mat: THREE.ShaderMaterial;
  private readonly shadeMat: THREE.ShaderMaterial;
  private readonly chunks = new Map<number, Chunk>();
  private readonly clearings: number[] = []; // x, z, r
  private readonly pending: number[] = []; // chunk keys, nearest last
  /** Chunks built before the modelled rocks arrived, to be built again (a few a frame). */
  private readonly redo: number[] = [];
  private disposed = false;
  private readonly far = { value: FAR.high };
  private readonly sample: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private readonly nrm = new THREE.Vector3();
  private readonly cand = { x: 0, z: 0, r: 0, pri: 0, size: 0 };
  private readonly other = { x: 0, z: 0, r: 0, pri: 0, size: 0 };
  private readonly lead: Lead = { x: 0, z: 0 };
  private scanT = 0;
  private pix = NaN;
  private piz = NaN;
  private dirty = true;

  constructor(world: DesertWorld, uniforms: Uniforms) {
    this.world = world;
    this.group.name = 'props';
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uPropFar: this.far },
      vertexShader: propVert,
      fragmentShader: propFrag,
    });
    this.shadeMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uPropFar: this.far },
      vertexShader: shadeVert,
      fragmentShader: shadeFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // multiplied over what is already drawn: dst * src
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.watchModels();
  }

  /** Starts loading the modelled rocks; once they arrive, what is already built is built again. */
  private watchModels(): void {
    if (MODEL_ROCKS) return;
    void loadRocks().then((ok) => {
      if (!ok || this.disposed) return;
      this.redo.length = 0;
      for (const k of this.chunks.keys()) this.redo.push(k);
    });
  }

  /** How far out props are drawn, by graphics tier. */
  setTier(tier: string): void {
    const f = FAR[tier] ?? FAR.high;
    if (f === this.far.value) return;
    this.far.value = f;
    this.dirty = true;
  }

  /** Keeps a disc clear of props from now on (the spawn point, the first fire), rebuilding what is already there. */
  keepClear(x: number, z: number, r: number): void {
    this.clearings.push(x, z, r);
    for (const [k, c] of this.chunks) {
      const cx = (c.ix + 0.5) * CHUNK;
      const cz = (c.iz + 0.5) * CHUNK;
      if (Math.hypot(cx - x, cz - z) < r + CHUNK) {
        this.drop(c);
        this.chunks.delete(k);
      }
    }
    this.dirty = true;
  }

  /** Chunks, groups and triangles built now (dev hook). */
  stats(): { chunks: number; groups: number; tris: number } {
    let groups = 0;
    let tris = 0;
    for (const c of this.chunks.values()) {
      groups += c.groups;
      if (c.mesh) tris += (c.mesh.geometry as THREE.BufferGeometry).attributes.position.count / 3;
    }
    return { chunks: this.chunks.size, groups, tris };
  }

  update(f: FrameState): void {
    const px = f.player.pos.x;
    const pz = f.player.pos.z;
    const ix = Math.floor(px / CHUNK);
    const iz = Math.floor(pz / CHUNK);
    this.scanT -= f.dt;
    if (this.dirty || ix !== this.pix || iz !== this.piz || this.scanT <= 0) {
      this.scanT = SCAN_EVERY;
      this.pix = ix;
      this.piz = iz;
      this.dirty = false;
      leadPoint(px, pz, f.player.vel.x, f.player.vel.z, LEAD_S, LEAD_MAX, this.lead);
      this.rescan(px, pz, this.lead.x, this.lead.z);
    }
    // the first time round, what is in view is built at once; after that a little each frame
    const budget = this.chunks.size === 0 ? 60 : 3;
    const t0 = performance.now();
    let built = 0;
    while (this.pending.length > 0 && (built === 0 || performance.now() - t0 < budget)) {
      const k = this.pending.pop()!;
      if (this.chunks.has(k)) continue;
      const cix = Math.floor(k / 65536) - 32768;
      const ciz = (k % 65536) - 32768;
      this.chunks.set(k, this.build(cix, ciz));
      built++;
    }
    // then, a chunk or so a frame, those built before the modelled rocks came, in place
    while (this.redo.length > 0 && this.pending.length === 0 && (built === 0 || performance.now() - t0 < budget)) {
      const k = this.redo.pop();
      const old = k === undefined ? undefined : this.chunks.get(k);
      if (k === undefined || !old) continue;
      this.chunks.set(k, this.build(old.ix, old.iz));
      this.drop(old);
      built++;
    }
  }

  /**
   * What is wanted is every chunk in reach of the wanderer or of the point they are heading for
   * (lx, lz): the first keeps the ground whole whichever way they look, the second has the ground
   * ahead built before it is near enough to be seen. The chunks ahead are built first.
   */
  private rescan(px: number, pz: number, lx: number, lz: number): void {
    const far = this.far.value + CHUNK * 0.75;
    for (const [k, c] of this.chunks) {
      const x = (c.ix + 0.5) * CHUNK;
      const z = (c.iz + 0.5) * CHUNK;
      if (Math.min(Math.hypot(x - px, z - pz), Math.hypot(x - lx, z - lz)) > far + CHUNK) {
        this.drop(c);
        this.chunks.delete(k);
      }
    }
    const span = Math.ceil(far / CHUNK);
    const i0 = Math.floor(Math.min(px, lx) / CHUNK) - span;
    const i1 = Math.floor(Math.max(px, lx) / CHUNK) + span;
    const j0 = Math.floor(Math.min(pz, lz) / CHUNK) - span;
    const j1 = Math.floor(Math.max(pz, lz) / CHUNK) + span;
    const want: { k: number; d: number }[] = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * CHUNK;
        const z = (j + 0.5) * CHUNK;
        const d = Math.hypot(x - lx, z - lz);
        if (d > far && Math.hypot(x - px, z - pz) > far) continue;
        const k = chunkKey(i, j);
        if (!this.chunks.has(k)) want.push({ k, d });
      }
    }
    want.sort((a, b) => b.d - a.d);
    this.pending.length = 0;
    for (const w of want) this.pending.push(w.k);
  }

  private drop(c: Chunk): void {
    for (const m of [c.mesh, c.shade]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
  }

  // ---------------------------------------------------------------- placement

  /** The group a cell would hold, if any: written to `out`. Decided by the hashes alone. */
  private cellGroup(gi: number, gj: number, out: { x: number; z: number; r: number; pri: number; size: number }): boolean {
    const s = this.world.seed | 0;
    const x0 = gi * CELL;
    const z0 = gj * CELL;
    // thick in places and bare in others
    const patch = noise2(x0 / 380, z0 / 380, s, 1) * 0.7 + noise2(x0 / 110, z0 / 110, s, 2) * 0.3;
    const dens = 0.05 + 0.42 * smooth(0.32, 0.78, patch);
    if (hash4(gi, gj, s, 11) >= dens) return false;
    const q = hash4(gi, gj, s, 12);
    out.size = q < 0.42 ? 0 : q < 0.82 ? 1 : 2;
    out.r = SIZES[out.size];
    out.x = x0 + hash4(gi, gj, s, 13) * CELL;
    out.z = z0 + hash4(gi, gj, s, 14) * CELL;
    out.pri = hash4(gi, gj, s, 15);
    return true;
  }

  /** Whether a cell's group stands, its neighbours' footprints given way to by the lesser. */
  private wins(gi: number, gj: number): boolean {
    const c = this.cand;
    if (!this.cellGroup(gi, gj, c)) return false;
    const o = this.other;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        if ((i === 0 && j === 0) || !this.cellGroup(gi + i, gj + j, o)) continue;
        if (o.pri > c.pri && Math.hypot(o.x - c.x, o.z - c.z) < o.r + c.r + SPACE) return false;
      }
    }
    // cellGroup wrote the neighbours to `other` only, so `cand` is still this cell's
    return true;
  }

  /** Whether a disc is clear of everything props keep off. */
  private open(x: number, z: number, r: number, routes: number[]): boolean {
    const cl = this.clearings;
    for (let i = 0; i < cl.length; i += 3) if (Math.hypot(cl[i] - x, cl[i + 1] - z) < cl[i + 2] + r) return false;
    const w = this.world;
    const city = w.cities.at(x, z);
    if (Math.hypot(city.cx - x, city.cz - z) < city.radius + CITY_CLEAR + r) return false;
    for (let i = 0; i < routes.length; i += 4) {
      const ax = routes[i];
      const az = routes[i + 1];
      const dx = routes[i + 2] - ax;
      const dz = routes[i + 3] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < ROUTE_CLEAR + r) return false;
    }
    if (w.river(x, z) < RIVER_CLEAR + r) return false;
    if (w.caveCeil(x, z) < Infinity) return false;
    const cr = r + CAVE_CLEAR;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU;
      if (w.caveCeil(x + Math.cos(a) * cr, z + Math.sin(a) * cr) < Infinity) return false;
    }
    return !this.blocked?.(x, z, r);
  }

  /** The lines between the cities near a chunk and their neighbours: ax, az, bx, bz each. */
  private routesNear(x: number, z: number): number[] {
    const out: number[] = [];
    const w = this.world;
    for (const c of w.cities.near(x, z)) {
      for (const o of w.cities.neighbours(c)) out.push(c.cx, c.cz, o.cx, o.cz);
    }
    return out;
  }

  private build(ix: number, iz: number): Chunk {
    const w = this.world;
    const ox = (ix + 0.5) * CHUNK;
    const oz = (iz + 0.5) * CHUNK;
    const oy = w.height(ox, oz);
    const b = new Build(w, ox, oy, oz);
    const routes = this.routesNear(ox, oz);
    const s = w.seed | 0;
    const c = this.cand;
    for (let j = 0; j < PER; j++) {
      for (let i = 0; i < PER; i++) {
        const gi = ix * PER + i;
        const gj = iz * PER + j;
        if (!this.wins(gi, gj)) continue;
        const { x, z, size } = c;
        let r = c.r;
        if (!this.open(x, z, r, routes)) continue;
        // the ground: not too steep, and nothing on bare mountain, in a salt pan's middle or a river's green
        const sm = w.sample(x, z, this.sample);
        if (sm.rock > 0.75 || (sm.green ?? 0) > 0.3) continue;
        w.normal(x, z, this.nrm);
        if (this.nrm.y < 0.86) continue;
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * TAU;
          const h = w.height(x + Math.cos(a) * r * 0.8, z + Math.sin(a) * r * 0.8);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        if (hi - lo > r * 0.55 + 0.4) continue;
        const rng = mulberry32(Math.floor(hash4(gi, gj, s, 16) * 4294967296));
        // cactus country and rock country, in broad patches; cacti keep off rock and salt
        const rocky = sm.rock > 0.22;
        const salty = sm.salt > 0.3;
        const share = salty ? 0 : rocky ? 0.15 : 0.12 + 0.78 * smooth(0.25, 0.65, noise2(x / 900, z / 900, s, 3));
        const q = rng();
        let made: Made;
        if (rng() < share) {
          if (size === 0) made = q < 0.6 ? barrels(b, x, z, r, rng) : pear(b, x, z, r, rng);
          else if (size === 1) made = q < 0.48 ? saguaro(b, x, z, r, rng, q < 0.12) : q < 0.72 ? pear(b, x, z, r, rng) : q < 0.9 ? organ(b, x, z, r, rng) : barrels(b, x, z, r, rng);
          else {
            // a stand: a big saguaro or an organ pipe, with barrels or a pear about its foot
            const a = rng() * TAU;
            const d = r * 0.45;
            made = q < 0.65 ? saguaro(b, x, z, 2.5, rng, false) : organ(b, x, z, 2.5, rng);
            const fx = x + Math.cos(a) * d;
            const fz = z + Math.sin(a) * d;
            const m2 = rng() < 0.6 ? barrels(b, fx, fz, r - d, rng) : pear(b, fx, fz, Math.min(2.2, r - d), rng);
            if (m2.h > 0) b.shadow(fx, fz, m2.sr, m2.h);
            r = 2.5;
          }
        } else {
          if (size === 0) made = boulder(b, x, z, r, rng);
          else if (size === 1) made = q < 0.6 ? boulder(b, x, z, r, rng) : q < 0.8 ? stack(b, x, z, r, rng) : fins(b, x, z, r, rng);
          else made = q < 0.45 ? cluster(b, x, z, r, rng) : q < 0.8 ? fins(b, x, z, r, rng) : stack(b, x, z, r, rng);
        }
        b.seal();
        if (made.h <= 0) continue;
        b.shadow(x, z, made.sr, made.h);
        b.spots.push(x, z, c.r);
        b.groups++;
      }
    }
    const mesh = b.mesh(this.mat);
    const shade = b.shadeMesh(this.shadeMat);
    if (mesh) this.group.add(mesh);
    if (shade) this.group.add(shade);
    return { ix, iz, ox, oy, oz, mesh, shade, solids: b.solids.count > 0 ? b.solids : null, spots: b.spots, groups: b.groups };
  }

  // ---------------------------------------------------------------- what the wanderer meets

  /**
   * Top of the highest prop over (x, z) that feet at height y are not underneath, or -Infinity.
   * `kind` then says what it is.
   */
  topAt(x: number, z: number, y: number): number {
    let top = -Infinity;
    const ix = Math.floor(x / CHUNK);
    const iz = Math.floor(z / CHUNK);
    const fx = x - ix * CHUNK;
    const fz = z - iz * CHUNK;
    const i0 = fx < EDGE ? -1 : 0;
    const i1 = fx > CHUNK - EDGE ? 1 : 0;
    const j0 = fz < EDGE ? -1 : 0;
    const j1 = fz > CHUNK - EDGE ? 1 : 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = this.chunks.get(chunkKey(ix + i, iz + j));
        const so = c?.solids;
        if (!so) continue;
        const t = so.topAt(x - c.ox, z - c.oz, y - c.oy) + c.oy;
        if (t > top) {
          top = t;
          this.kind = so.kind;
        }
      }
    }
    return top;
  }

  /** Underside of the lowest prop overhead (a saguaro's arm) for feet at height y, or Infinity. */
  ceilAt(x: number, z: number, y: number): number {
    let ceil = Infinity;
    const ix = Math.floor(x / CHUNK);
    const iz = Math.floor(z / CHUNK);
    const fx = x - ix * CHUNK;
    const fz = z - iz * CHUNK;
    for (let j = fz < EDGE ? -1 : 0; j <= (fz > CHUNK - EDGE ? 1 : 0); j++) {
      for (let i = fx < EDGE ? -1 : 0; i <= (fx > CHUNK - EDGE ? 1 : 0); i++) {
        const c = this.chunks.get(chunkKey(ix + i, iz + j));
        if (c?.solids) ceil = Math.min(ceil, c.solids.ceilAt(x - c.ox, z - c.oz, y - c.oy) + c.oy);
      }
    }
    return ceil;
  }

  /** Whether (x, z) is within a margin of any group's footprint. */
  nearSolids(x: number, z: number, margin: number): boolean {
    const ix = Math.floor(x / CHUNK);
    const iz = Math.floor(z / CHUNK);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const c = this.chunks.get(chunkKey(ix + i, iz + j));
        if (!c) continue;
        const sp = c.spots;
        for (let k = 0; k < sp.length; k += 3) {
          const dx = sp[k] - x;
          const dz = sp[k + 1] - z;
          const m = sp[k + 2] + margin;
          if (dx * dx + dz * dz < m * m) return true;
        }
      }
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.chunks.values()) this.drop(c);
    this.chunks.clear();
    this.mat.dispose();
    this.shadeMat.dispose();
  }
}
