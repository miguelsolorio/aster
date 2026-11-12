// Rare things to stumble on: ruins, oases, arches, standing stones, great bones,
// lantern towers, sundial plazas and half-buried shells. Placement is a
// deterministic jittered grid (675 m cells, about one in three occupied); sites
// are built lazily near the player and disposed when far away.
import * as THREE from 'three';
import type { FrameState, SurfaceSample, Uniforms, World } from '../game/contract';
import { WORLD_SCALE } from './scale';
import { STYLE_GLSL } from '../render/styleGlsl';
import { MAX_CAVERNS, TERRAIN, writeCaverns, type Cave, type Cavern, type Massif } from './surface';
import { rockCapVert, terrainFrag } from '../render/terrainShaders';
import { CITY_CELL } from '../city/placement';
import { Solids, type SolidKind } from './solids';

const CELL = 900 * WORLD_SCALE;
const MARGIN = 150; // keeps sites at least 300 m apart
const SITE_P = 0.34;
const BUILD_R = 2500;
const DROP_R = 3500;
const SCAN_EVERY = 0.3;
const GROVE_P = 0.7; // chance an otherwise empty cell beside a river holds a grove
const GROVE_REACH = 260; // metres from a river that counts as beside it
const CAVERN_P = 0.22; // chance an otherwise empty cell hides a cavern (where the ground suits one)
const CAVERN_BUILD_R = 900; // an open cavern's roof and contents are built inside this
const HOLLOW_R = 30; // a strike sounds hollow within this of a sealed cavern (m)
const DIG_R = 4.5; // and counts toward breaking through within this of the spot
const DIG_HITS = 4; // strikes on the spot before the sand gives way
const DRAIN = 4.5; // seconds the sand takes to run out
const LAMP_KEY = -7; // the site key of the miner's lost lamp (massif finds are far below this)
const DIMPLE = 0.4; // depth of the dip over a sealed cavern (m)

// ------------------------------------------------------------------ hashing

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

/** Weathering offset: a function of position only, so coincident vertices move together (no cracks). */
function jit(x: number, y: number, z: number, salt: number): number {
  return hash4(Math.round(x * 40), Math.round(y * 40), Math.round(z * 40), salt) * 2 - 1;
}

// ------------------------------------------------------------------ shaders

const NOISE = /* glsl */ `
float dh21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float dvn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dh21(i), dh21(i + vec2(1.0, 0.0)), u.x),
             mix(dh21(i + vec2(0.0, 1.0)), dh21(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const stoneVert = /* glsl */ `
attribute vec3 aTint;
attribute float aKind;
varying vec3 vW;
varying vec3 vN;
varying vec3 vTint;
varying float vKind;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vTint = aTint;
  vKind = aKind;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// kinds: 0 rock palette, 1 pale (salt palette: bone, shell), 2 sand palette (wood, damp sand, shrubs), 3 lantern light,
// 4 glowing mineral. Ten more than any of these is the same thing deep in a cavern, out of the sun's reach.
const stoneFrag = /* glsl */ `
uniform vec4 uCavGlow;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uRockLit;
uniform vec3 uRockShade;
uniform vec3 uSaltLit;
uniform vec3 uSaltShade;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uTop;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uNight;
varying vec3 vW;
varying vec3 vN;
varying vec3 vTint;
varying float vKind;
${NOISE}
${STYLE_GLSL}
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  n = styleFacet(n, vW);
  float dark = step(9.5, vKind);
  float kind = vKind - 10.0 * dark;
  float l = styleBands(smoothstep(-0.12, 0.42, dot(n, uSunDir)), vW.xz) * (1.0 - dark);
  vec3 sh = uShade;
  vec3 li = uLit;
  if (kind < 0.5) { sh = uRockShade; li = uRockLit; }
  else if (kind < 1.5) { sh = mix(uRockShade, uSaltShade, 0.7); li = uSaltLit; }
  vec3 col = mix(sh, li, l * 0.9);
  float m = dvn(vW.xz * 0.45 + vec2(vW.y * 0.6, -vW.y * 0.3)) * 0.6 + dvn(vW.xz * 1.7 + vW.y) * 0.4;
  col *= vTint * (0.88 + 0.24 * m);
  col += (uTop - col) * 0.06 * max(n.y, 0.0) * (1.0 - l);
  float dist = length(vW - cameraPosition);
  float fogA = 1.0 - exp(-dist * uFog);
  if (dark > 0.5) {
    // in a cavern: nearly black, lit only by what glows there (as the rock around it is)
    col *= 0.2;
    if (uCavGlow.w > 0.0) {
      vec3 gd = uCavGlow.xyz - vW;
      float g2 = dot(gd, gd);
      float ga = 1.0 / (1.0 + g2 / (0.16 * uCavGlow.w * uCavGlow.w));
      ga *= 0.45 + 0.55 * max(dot(n, gd * inversesqrt(g2 + 1e-3)), 0.0);
      col += vec3(0.3, 0.95, 0.82) * vTint * (0.85 * ga);
    }
    fogA = 0.0;
  }
  if (kind > 3.5) {
    col = vec3(0.3, 0.95, 0.82) * vTint * (0.8 + 0.2 * sin(uTime * 0.9 + vW.y * 2.0));
    fogA *= 0.5 * (1.0 - dark);
  } else if (kind > 2.5) {
    col = vec3(1.0, 0.78, 0.46) * (0.55 + 0.6 * uNight);
    fogA *= 0.5;
  }
  col = mix(col, uFogCol, fogA);
  gl_FragColor = vec4(col, 1.0);
}
`;

const waterVert = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const waterFrag = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uShade;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uTime;
uniform float uNight;
uniform float uDim; // 1 under the sky; lower for a pool underground, which has little to mirror
varying vec3 vW;
${NOISE}
void main() {
  vec3 v = normalize(cameraPosition - vW);
  // barely-there ripples: the pool is meant to look still
  vec2 q = vW.xz * 0.35;
  float e = 0.012;
  float r0 = dvn(q + uTime * 0.05) + dvn(q * 2.3 - uTime * 0.07);
  float rx = dvn(q + vec2(e, 0.0) + uTime * 0.05) + dvn((q + vec2(e, 0.0)) * 2.3 - uTime * 0.07);
  float rz = dvn(q + vec2(0.0, e) + uTime * 0.05) + dvn((q + vec2(0.0, e)) * 2.3 - uTime * 0.07);
  vec3 n = normalize(vec3(-(rx - r0) * 0.25 / e * 0.06, 1.0, -(rz - r0) * 0.25 / e * 0.06));
  float c = clamp(dot(n, v), 0.0, 1.0);
  float fres = pow(1.0 - c, 3.0);
  // looking straight down mirrors the zenith; grazing mirrors the horizon
  vec3 col = mix(uTop, uHorizon, fres * 0.9 + 0.1);
  col = mix(col, uShade * 0.6, 0.18 * c); // a hint of depth when looking down
  vec3 rf = reflect(-v, n);
  float g = pow(max(dot(rf, uSunDir), 0.0), 220.0);
  col += uSunCol * g * (1.0 - 0.6 * uNight) * 1.5;
  // underground: dark water that picks up a little of the mineral's light
  col = mix(vec3(0.3, 0.95, 0.82) * (0.1 + 0.25 * fres), col, uDim) * mix(0.55, 1.0, uDim);
  float dist = length(vW - cameraPosition);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

const frondVert = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
attribute float aSway;
attribute float aPhase;
attribute float aShadeK;
varying vec3 vW;
varying vec3 vN;
varying float vK;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float s = aSway * aSway;
  float w = 0.22 + 0.16 * sin(uTime * 1.1 + aPhase) + 0.08 * sin(uTime * 2.7 + aPhase * 1.9);
  wp.xz += uWind * s * w;
  wp.y += s * 0.18 * sin(uTime * 1.7 + aPhase * 1.3);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vK = aShadeK;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const frondFrag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uFogCol;
uniform float uFog;
varying vec3 vW;
varying vec3 vN;
varying float vK;
${STYLE_GLSL}
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  n = styleFacet(n, vW);
  float l = styleBands(smoothstep(-0.2, 0.5, dot(n, uSunDir)), vW.xz);
  vec3 sh = uShade * vec3(0.42, 0.52, 0.34);
  vec3 li = uLit * vec3(0.46, 0.6, 0.3);
  vec3 col = mix(sh, li, l) * vK;
  float dist = length(vW - cameraPosition);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

const glowVert = /* glsl */ `
attribute vec2 aCorner;
attribute float aSize;
varying vec2 vUv;
varying float vDist;
void main() {
  vec4 wc = modelMatrix * vec4(position, 1.0);
  float dist = length(wc.xyz - cameraPosition);
  // grow with distance so the light still reads as a point from kilometres away
  float s = aSize * (1.0 + dist / 500.0);
  vec4 mv = viewMatrix * wc;
  mv.xy += aCorner * s;
  vUv = aCorner;
  vDist = dist;
  gl_Position = projectionMatrix * mv;
}
`;

const glowFrag = /* glsl */ `
uniform float uNight;
uniform float uFog;
uniform float uTime;
uniform vec3 uGlowCol;
uniform float uGlowDay; // how much of it shows in daylight: a lantern's is lost in the sun, a cavern's is not
varying vec2 vUv;
varying float vDist;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 5.0) * (1.0 - r2);
  float flick = 0.94 + 0.06 * sin(uTime * 3.1) * sin(uTime * 4.7 + 1.3);
  float k = mix(0.12 + 0.88 * smoothstep(0.1, 0.8, uNight), 1.0, uGlowDay) * flick;
  float fogA = (1.0 - exp(-vDist * uFog)) * 0.45;
  vec3 col = uGlowCol * a * k * (1.0 - fogA);
  gl_FragColor = vec4(col, 1.0);
}
`;

// Daylight falling through a cavern's mouth: a faint wedge of lit dust under the brow.
const shaftVert = /* glsl */ `
attribute float aFade;
varying float vFade;
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vFade = aFade;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const shaftFrag = /* glsl */ `
uniform vec3 uSunCol;
uniform float uNight;
uniform float uTime;
varying float vFade;
varying vec3 vW;
${NOISE}
void main() {
  float dust = 0.7 + 0.3 * dvn(vW.xz * 0.9 + vec2(uTime * 0.05, vW.y * 0.7));
  float a = vFade * vFade * dust * (1.0 - 0.93 * uNight);
  gl_FragColor = vec4(uSunCol * (0.085 * a), 1.0);
}
`;

// ------------------------------------------------------------------ geometry builders

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1, 2, 3, 2);
const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
const UNIT_SLAB = new THREE.CylinderGeometry(0.4, 0.5, 1, 4, 3).rotateY(Math.PI / 4).scale(1.414, 1, 1.414);
const UNIT_BLOB = new THREE.IcosahedronGeometry(1, 1);
const UNIT_CONE = new THREE.ConeGeometry(1, 1, 4);
/** A relic: a small eight-pointed thing, two crossed spindles. */
const RELIC_GEO = new THREE.OctahedronGeometry(0.15, 0).scale(1, 1.6, 1);

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _mi = new THREE.Matrix4();

class StoneBuilder {
  pos: number[] = [];
  tint: number[] = [];
  kind: number[] = [];
  r = 1;
  g = 1;
  b = 1;
  k = 0;
  rough = 0;
  salt = 1;
  /** Deep in a cavern: out of the sun, lit only by what glows there. */
  dark = false;

  set(r: number, g: number, b: number, k: number, rough: number): void {
    this.r = r;
    this.g = g;
    this.b = b;
    this.k = k;
    this.rough = rough;
  }

  vert(x: number, y: number, z: number): void {
    if (this.rough > 0) {
      const rr = this.rough;
      const dx = jit(x, y, z, this.salt) * rr;
      const dy = jit(x, y, z, this.salt + 1) * rr;
      const dz = jit(x, y, z, this.salt + 2) * rr;
      x += dx;
      y += dy;
      z += dz;
    }
    this.pos.push(x, y, z);
    this.tint.push(this.r, this.g, this.b);
    this.kind.push(this.dark ? this.k + 10 : this.k);
  }

  geo(g: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const p = g.attributes.position as THREE.BufferAttribute;
    const idx = g.index;
    const n = idx ? idx.count : p.count;
    for (let i = 0; i < n; i++) {
      const j = idx ? idx.getX(i) : i;
      _v.fromBufferAttribute(p, j).applyMatrix4(m);
      this.vert(_v.x, _v.y, _v.z);
    }
  }

  build(): THREE.BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 3));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.kind, 1));
    g.computeVertexNormals(); // non-indexed: faceted, weathered look
    g.computeBoundingSphere();
    return g;
  }
}

class FrondBuilder {
  pos: number[] = [];
  sway: number[] = [];
  phase: number[] = [];
  shade: number[] = [];

  vert(p: THREE.Vector3, sway: number, phase: number, shade: number): void {
    this.pos.push(p.x, p.y, p.z);
    this.sway.push(sway);
    this.phase.push(phase);
    this.shade.push(shade);
  }

  build(): THREE.BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setAttribute('aPhase', new THREE.Float32BufferAttribute(this.phase, 1));
    g.setAttribute('aShadeK', new THREE.Float32BufferAttribute(this.shade, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Triangles drawn with the ground's own shader: the rock over a hollow. */
class RockBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  mask: number[] = [];
  cave: number[] = [];

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, rock: number, salt: number, cave: number): void {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.mask.push(rock, salt);
    this.cave.push(cave);
  }

  build(): THREE.BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aMask', new THREE.Float32BufferAttribute(this.mask, 2));
    g.setAttribute('aCave', new THREE.Float32BufferAttribute(this.cave, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** The uncut rock face at a point of a roof: height (relative to the site's base), normal, rock and salt. */
interface Face {
  y: number;
  nx: number;
  ny: number;
  nz: number;
  rock: number;
  salt: number;
}

/** Builds a site in a rotated (u along, v across) frame; y is relative to the site's base height. */
class Ctx {
  readonly rock = new RockBuilder();
  readonly stone = new StoneBuilder();
  readonly fronds = new FrondBuilder();
  readonly pools: { y: number; r: number; u?: number; v?: number; under?: boolean }[] = [];
  readonly glows: number[] = []; // x, y, z, size
  /** The cold light of a mineral: the same, but it shows by day too. */
  readonly veins: number[] = [];
  /** Shafts of daylight: x, y, z, fade per vertex. */
  readonly shafts: number[] = [];
  /** What lights a cavern from inside: local x, y, z and how far it carries. */
  light: [number, number, number, number] | null = null;
  /** Where a relic lies, local. */
  relic: [number, number, number] | null = null;
  /** What the wanderer walks into and stands on: one shape per stone, drum and length of bone. */
  readonly solids = new Solids();
  /** Off while building things you pass straight through (scrub, paving flush with the ground). */
  solid = true;
  foot = 20;
  cy = 1;
  sy = 0;
  lx = 0;
  lz = 0;

  constructor(
    readonly world: World,
    readonly x: number,
    readonly z: number,
    readonly baseY: number,
    readonly rng: () => number,
    yaw: number,
  ) {
    this.cy = Math.cos(yaw);
    this.sy = Math.sin(yaw);
    this.yaw = yaw;
  }
  readonly yaw: number;

  r(a: number, b: number): number {
    return a + (b - a) * this.rng();
  }

  /** Sets lx, lz to the local position of frame point (u, v). */
  at(u: number, v: number): void {
    this.lx = u * this.cy + v * this.sy;
    this.lz = -u * this.sy + v * this.cy;
  }

  /** Ground height (relative to base) at frame point (u, v). */
  g(u: number, v: number): number {
    this.at(u, v);
    return this.world.height(this.x + this.lx, this.z + this.lz) - this.baseY;
  }

  /** Adds a primitive centred at frame (u, y, v), rotated (rx, yaw + ry, rz) in YXZ order, scaled. */
  prim(geo: THREE.BufferGeometry, u: number, y: number, v: number, sx: number, sy: number, sz: number, ry = 0, rx = 0, rz = 0): void {
    this.at(u, v);
    _p.set(this.lx, y, this.lz);
    _q.setFromEuler(_e.set(rx, this.yaw + ry, rz, 'YXZ'));
    _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    this.stone.geo(geo, _m);
    // too slight to stand on or be stopped by: lantern posts, cross bars
    if (!this.solid || geo === UNIT_CONE || Math.min(sx, sy, sz) < 0.25) return;
    _mi.copy(_m).invert();
    const kind = this.stone.k === 1 ? 1 : this.stone.k === 2 ? 2 : 0;
    if (geo === UNIT_BLOB) this.solids.addPrim('ball', _m, _mi, kind);
    else if (geo === UNIT_CYL) this.solids.addPrim('cyl', _m, _mi, kind);
    else if (geo === UNIT_SLAB) this.solids.addPrim('box', _m, _mi, kind, 0.45, 0.45);
    else this.solids.addPrim('box', _m, _mi, kind);
  }

  /** Converts frame points (u, y, v) to local points in place. */
  toLocal(pts: THREE.Vector3[]): THREE.Vector3[] {
    for (const p of pts) {
      this.at(p.x, p.z);
      p.set(this.lx, p.y, this.lz);
    }
    return pts;
  }

  /** Tube along local points with per-point radius; parallel-transport frames. */
  tube(pts: THREE.Vector3[], radii: number[], sides: number, capEnd: boolean, flat = 1, tints?: number[]): void {
    const n = pts.length;
    if (n < 2) return;
    if (this.solid) {
      const kind: SolidKind = this.stone.k === 1 ? 1 : this.stone.k === 2 ? 2 : 0;
      const wide = Math.sqrt(flat);
      for (let i = 0; i < n - 1; i++) this.solids.addCapsule(pts[i], pts[i + 1], (radii[i] + radii[i + 1]) * 0.5 * wide, kind);
    }
    const rings: number[] = [];
    const t = new THREE.Vector3();
    const prevT = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const bin = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      if (i === 0) t.subVectors(pts[1], pts[0]).normalize();
      else if (i === n - 1) t.subVectors(pts[n - 1], pts[n - 2]).normalize();
      else t.subVectors(pts[i + 1], pts[i - 1]).normalize();
      if (i === 0) {
        nrm.set(0, 1, 0);
        if (Math.abs(t.y) > 0.9) nrm.set(1, 0, 0);
        nrm.addScaledVector(t, -nrm.dot(t)).normalize();
      } else {
        q.setFromUnitVectors(prevT, t);
        nrm.applyQuaternion(q);
      }
      prevT.copy(t);
      bin.crossVectors(t, nrm).normalize();
      const r = radii[i];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const ca = Math.cos(a) * r;
        const sa = Math.sin(a) * r * flat;
        let x = pts[i].x + nrm.x * ca + bin.x * sa;
        let y = pts[i].y + nrm.y * ca + bin.y * sa;
        let z = pts[i].z + nrm.z * ca + bin.z * sa;
        const rr = this.stone.rough;
        if (rr > 0) {
          x += jit(x, y, z, 11) * rr;
          y += jit(x, y, z, 12) * rr;
          z += jit(x, y, z, 13) * rr;
        }
        rings.push(x, y, z);
      }
    }
    const sb = this.stone;
    const keep = sb.rough;
    sb.rough = 0; // already applied per ring point
    const baseR = sb.r;
    const baseG = sb.g;
    const baseB = sb.b;
    const P = (i: number, s: number) => {
      const o = (i * sides + (s % sides)) * 3;
      sb.vert(rings[o], rings[o + 1], rings[o + 2]);
    };
    for (let i = 0; i < n - 1; i++) {
      if (tints) {
        const k = tints[i];
        sb.r = baseR * k;
        sb.g = baseG * k;
        sb.b = baseB * k;
      }
      for (let s = 0; s < sides; s++) {
        P(i, s);
        P(i + 1, s);
        P(i, s + 1);
        P(i, s + 1);
        P(i + 1, s);
        P(i + 1, s + 1);
      }
    }
    if (capEnd) {
      const c = pts[n - 1];
      for (let s = 0; s < sides; s++) {
        P(n - 1, s);
        P(n - 1, s + 1);
        sb.vert(c.x, c.y, c.z);
      }
    }
    sb.r = baseR;
    sb.g = baseG;
    sb.b = baseB;
    sb.rough = keep;
  }

  glow(u: number, y: number, v: number, size: number): void {
    this.at(u, v);
    this.glows.push(this.lx, y, this.lz, size);
  }
}

// ------------------------------------------------------------------ site kinds

function buildRuins(c: Ctx): void {
  const st = c.stone;
  const tr = c.r(0.92, 1.08);
  st.set(1.08 * tr, 1.02 * tr, 0.94 * tr, 0, 0.12);
  if (c.rng() < 0.6) {
    // colonnade
    const n = 5 + Math.floor(c.rng() * 5);
    const spacing = c.r(5, 7.5);
    const H = c.r(8, 15);
    const rad = c.r(0.8, 1.3);
    const rows = c.rng() < 0.4 ? 2 : 1;
    const gap = c.r(7, 10);
    c.foot = (n * spacing) / 2 + 6;
    for (let row = 0; row < rows; row++) {
      const v = row * gap - ((rows - 1) * gap) / 2;
      let prevTop = NaN;
      let prevU = 0;
      for (let i = 0; i < n; i++) {
        const u = (i - (n - 1) / 2) * spacing;
        const g = c.g(u, v);
        const roll = c.rng();
        const broken = roll < 0.45;
        const h = roll < 0.1 ? c.r(0.6, 1.8) : broken ? H * c.r(0.2, 0.8) : H;
        c.prim(UNIT_BOX, u, g - 0.2, v, rad * 2.7, 1.2, rad * 2.7, c.r(-0.1, 0.1));
        let y = g - 0.6;
        let j = 0;
        while (y < g + h - 0.3) {
          const dh = Math.min(c.r(1.3, 1.9), g + h - y);
          const rr = rad * (1 - 0.05 * (j / 8)) * c.r(0.95, 1.02);
          c.prim(UNIT_CYL, u + c.r(-0.08, 0.08), y + dh / 2, v + c.r(-0.08, 0.08), rr, dh * 0.98, rr, c.rng() * 3, c.r(-0.02, 0.02), c.r(-0.02, 0.02));
          y += dh;
          j++;
        }
        if (!broken) {
          c.prim(UNIT_BOX, u, y + 0.45, v, rad * 2.8, 0.9, rad * 2.8, c.r(-0.05, 0.05));
          const top = y + 0.9;
          if (!Number.isNaN(prevTop) && c.rng() < 0.75) {
            const mid = (prevU + u) / 2;
            const tilt = Math.atan2(top - prevTop, u - prevU);
            c.prim(UNIT_BOX, mid, (top + prevTop) / 2 + 0.7, v, spacing * 1.04, 1.4, rad * 2.4, 0, 0, tilt);
          }
          prevTop = top;
          prevU = u;
        } else {
          prevTop = NaN;
          // fallen drums, half buried
          const k = 1 + Math.floor(c.rng() * 3);
          for (let d = 0; d < k; d++) {
            const a = c.rng() * Math.PI * 2;
            const dd = c.r(2.5, 8);
            const fu = u + Math.cos(a) * dd;
            const fv = v + Math.sin(a) * dd;
            c.prim(UNIT_CYL, fu, c.g(fu, fv) + rad * 0.45, fv, rad, c.r(1.3, 1.9), rad, c.rng() * 6, Math.PI / 2 + c.r(-0.15, 0.15), 0);
          }
        }
      }
    }
    // a fallen lintel or two
    for (let i = 0; i < 2; i++) {
      const fu = c.r(-c.foot, c.foot) * 0.7;
      const fv = c.r(4, 9) * (c.rng() < 0.5 ? -1 : 1);
      c.prim(UNIT_BOX, fu, c.g(fu, fv) + 0.3, fv, spacing * c.r(0.6, 1), 1.4, rad * 2.4, c.r(-0.6, 0.6), c.r(-0.15, 0.15), c.r(-0.1, 0.1));
    }
  } else {
    // doorway with crumbling wall wings
    const W = c.r(5, 8);
    const H = c.r(10, 16);
    const pw = c.r(2.2, 3.2);
    const pd = c.r(2.2, 3);
    c.foot = W + 18;
    const tops: number[] = [];
    for (const side of [-1, 1]) {
      const u = side * (W / 2 + pw / 2);
      const g = c.g(u, 0);
      let y = g - 1.5;
      while (y < g + H) {
        const bh = c.r(1.2, 1.8);
        c.prim(UNIT_BOX, u + c.r(-0.12, 0.12), y + bh / 2, c.r(-0.12, 0.12), pw * c.r(0.95, 1.05), bh * 0.98, pd * c.r(0.95, 1.05), c.r(-0.04, 0.04));
        y += bh;
      }
      tops.push(y);
      // wall wing, stepping down as it crumbles
      let wy = g;
      let hgt = H * c.r(0.5, 0.8);
      const blocks = 2 + Math.floor(c.rng() * 4);
      for (let b = 0; b < blocks; b++) {
        const wu = u + side * (pw / 2 + 1.3 + b * 2.5);
        wy = c.g(wu, 0);
        if (hgt < 1) break;
        c.prim(UNIT_BOX, wu, wy + hgt / 2 - 1, c.r(-0.1, 0.1), 2.45, hgt, pd * 0.8, c.r(-0.03, 0.03));
        hgt -= c.r(1, 4);
      }
    }
    const top = Math.max(tops[0], tops[1]);
    const tilt = Math.atan2(tops[1] - tops[0], W + pw);
    c.prim(UNIT_BOX, 0, (tops[0] + tops[1]) / 2 + 1, 0, W + pw * 2.4, 2, pd * 1.1, 0, 0, tilt);
    if (c.rng() < 0.6) c.prim(UNIT_BOX, 0, top + 2.6, 0, W * 0.8, 1.3, pd * 0.7, 0, 0, c.r(-0.08, 0.08));
    // second, smaller broken frame behind
    if (c.rng() < 0.5) {
      const v = c.r(10, 16);
      const u = c.r(-3, 3);
      for (const side of [-1, 1]) {
        const uu = u + side * (W * 0.4 + pw / 2);
        const g = c.g(uu, v);
        const h = H * c.r(0.25, 0.7);
        c.prim(UNIT_BOX, uu, g + h / 2 - 1, v, pw * 0.9, h, pd * 0.9, c.r(-0.08, 0.08), c.r(-0.05, 0.05));
      }
    }
  }
  // scattered blocks
  const nb = 6 + Math.floor(c.rng() * 10);
  for (let i = 0; i < nb; i++) {
    const a = c.rng() * Math.PI * 2;
    const d = c.r(4, c.foot);
    const u = Math.cos(a) * d;
    const v = Math.sin(a) * d * 0.6;
    const s = c.r(1, 2.2);
    c.prim(UNIT_BOX, u, c.g(u, v) + s * 0.2, v, s * c.r(1, 1.8), s, s * c.r(0.8, 1.3), c.rng() * 6, c.r(-0.4, 0.4), c.r(-0.4, 0.4));
  }
}

function buildOasis(c: Ctx): void {
  const st = c.stone;
  const R = c.r(10, 20);
  c.foot = R * 1.9;
  // water level: just above the lowest ground in the middle of the pool
  let minH = Infinity;
  for (let ring = 0; ring < 3; ring++) {
    const rr = ring * R * 0.3;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      minH = Math.min(minH, c.g(Math.cos(ang) * rr, Math.sin(ang) * rr));
    }
  }
  const level = minH + 0.35;
  c.pools.push({ y: level, r: R * 1.2 });

  // damp sand ring: polar grid hugging the terrain, darker toward the water
  const RING = R * 1.9;
  const NR = 10;
  const NS = 40;
  const grid: number[] = [];
  for (let i = 0; i <= NR; i++) {
    const rr = (i / NR) * RING;
    for (let s = 0; s < NS; s++) {
      const a = (s / NS) * Math.PI * 2;
      const wob = 1 + 0.12 * Math.sin(a * 3 + c.yaw) + 0.06 * Math.sin(a * 7 + c.yaw * 2);
      const u = Math.cos(a) * rr * wob;
      const v = Math.sin(a) * rr * wob;
      const y = c.g(u, v) + (i === NR ? -0.4 : 0.07);
      grid.push(c.lx, y, c.lz);
    }
  }
  st.set(1, 1, 1, 2, 0);
  const shadeAt = (i: number) => {
    const t = i / NR;
    return 0.55 + 0.45 * THREE.MathUtils.smoothstep(t, 0.45, 1.0);
  };
  const G = (i: number, s: number) => {
    const o = (i * NS + (s % NS)) * 3;
    const k = shadeAt(i);
    st.r = k * 0.95;
    st.g = k * 0.92;
    st.b = k * 0.9;
    st.vert(grid[o], grid[o + 1], grid[o + 2]);
  };
  for (let i = 0; i < NR; i++) {
    for (let s = 0; s < NS; s++) {
      G(i, s);
      G(i, s + 1);
      G(i + 1, s);
      G(i + 1, s);
      G(i, s + 1);
      G(i + 1, s + 1);
    }
  }

  // shrubs
  const nsh = 4 + Math.floor(c.rng() * 6);
  st.set(0.55, 0.62, 0.4, 2, 0.15);
  for (let i = 0; i < nsh; i++) {
    const a = c.rng() * Math.PI * 2;
    const d = R * c.r(1.05, 1.7);
    const u = Math.cos(a) * d;
    const v = Math.sin(a) * d;
    const s = c.r(0.8, 2);
    c.solid = false; // scrub: you brush through it
    c.prim(UNIT_BLOB, u, c.g(u, v) + s * 0.25, v, s * 1.3, s * 0.7, s * 1.2, c.rng() * 6);
    c.solid = true;
  }

  // palms
  const np = 3 + Math.floor(c.rng() * 5);
  for (let p = 0; p < np; p++) {
    const a = (p / np) * Math.PI * 2 + c.r(-0.5, 0.5);
    const d = R * c.r(0.95, 1.5);
    addPalm(c, Math.cos(a) * d, Math.sin(a) * d, a + Math.PI + c.r(-0.9, 0.9)); // leaning mostly toward the water
  }
}

/** One palm rooted at frame point (bu, bv), leaning toward the bearing la. */
function addPalm(c: Ctx, bu: number, bv: number, la: number): void {
  const st = c.stone;
  const top = new THREE.Vector3();
  const pt = new THREE.Vector3();
  {
    const g = c.g(bu, bv);
    const H = c.r(8, 16);
    const lean = c.r(1.5, 5.5);
    const lu = Math.cos(la);
    const lv = Math.sin(la);
    const pts: THREE.Vector3[] = [];
    const radii: number[] = [];
    const tints: number[] = [];
    const N = 9;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const off = lean * Math.pow(t, 1.8);
      pts.push(new THREE.Vector3(bu + lu * off, g - 0.6 + H * t + 0.6 * t, bv + lv * off));
      radii.push((0.42 * (1 - 0.4 * t) + (i === 0 ? 0.2 : 0)) * (H / 12) ** 0.3);
      tints.push(i % 2 === 0 ? 1 : 0.86);
    }
    c.toLocal(pts);
    const tk = c.r(0.9, 1.1);
    st.set(0.52 * tk, 0.43 * tk, 0.34 * tk, 2, 0.03);
    c.tube(pts, radii, 7, true, 1, tints);
    top.copy(pts[N]);
    st.set(0.42, 0.36, 0.28, 2, 0.08);
    _m.compose(top, _q.identity(), _s.set(0.75, 0.6, 0.75));
    st.geo(UNIT_BLOB, _m);
    // fronds
    const nf = 9 + Math.floor(c.rng() * 4);
    const phase = c.rng() * 6.28;
    for (let f = 0; f < nf; f++) {
      const az = (f / nf) * Math.PI * 2 + c.r(-0.25, 0.25);
      const e0 = c.r(0.25, 0.95);
      const L = c.r(4, 6.5) * (H / 12) ** 0.4;
      const hx = Math.cos(az);
      const hz = Math.sin(az);
      const sxv = -hz;
      const szv = hx;
      const shadeK = c.r(0.8, 1.1);
      const ph = phase + f * 0.7;
      const S = 7;
      const cross: THREE.Vector3[] = [];
      for (let i = 0; i <= S; i++) {
        const t = i / S;
        const w = 0.78 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.08 + 0.02)), 0.7) * (L / 5) + 0.04;
        pt.set(top.x + hx * L * t, top.y + L * (Math.sin(e0) * t - 0.95 * t * t), top.z + hz * L * t);
        cross.push(
          new THREE.Vector3(pt.x + sxv * w, pt.y - w * 0.3, pt.z + szv * w),
          new THREE.Vector3(pt.x, pt.y + w * 0.08, pt.z),
          new THREE.Vector3(pt.x - sxv * w, pt.y - w * 0.3, pt.z - szv * w),
        );
      }
      const fb = c.fronds;
      const V = (i: number, j: number) => fb.vert(cross[i * 3 + j], i / S, ph, shadeK);
      for (let i = 0; i < S; i++) {
        V(i, 0); V(i, 1); V(i + 1, 0);
        V(i, 1); V(i + 1, 1); V(i + 1, 0);
        V(i, 1); V(i, 2); V(i + 1, 1);
        V(i, 2); V(i + 1, 2); V(i + 1, 1);
      }
    }
  }
}

/**
 * A stand of palms and scrub on a riverbank. The site sits on the bank; onBank says whether a
 * frame point is on the damp ground beside the water, and toWater is the bearing to the river.
 */
function buildGrove(c: Ctx, onBank: (u: number, v: number) => boolean, toWater: number): void {
  const st = c.stone;
  c.foot = 34;
  const np = 3 + Math.floor(c.rng() * 6);
  for (let p = 0, tries = 0; p < np && tries < 60; tries++) {
    const a = c.rng() * Math.PI * 2;
    const d = c.r(2, 34);
    const u = Math.cos(a) * d;
    const v = Math.sin(a) * d;
    if (!onBank(u, v)) continue;
    addPalm(c, u, v, toWater + c.r(-0.9, 0.9));
    p++;
  }
  const nsh = 8 + Math.floor(c.rng() * 10);
  for (let i = 0, tries = 0; i < nsh && tries < 80; tries++) {
    const a = c.rng() * Math.PI * 2;
    const d = c.r(1, 40);
    const u = Math.cos(a) * d;
    const v = Math.sin(a) * d;
    if (!onBank(u, v)) continue;
    const k = c.r(0.85, 1.1);
    st.set(0.5 * k, 0.62 * k, 0.38 * k, 2, 0.15);
    const s = c.r(0.7, 1.9);
    c.solid = false; // scrub: you brush through it
    c.prim(UNIT_BLOB, u, c.g(u, v) + s * 0.25, v, s * 1.3, s * 0.7, s * 1.2, c.rng() * 6);
    c.solid = true;
    i++;
  }
}

/** A small cairn with a lantern on it: what waits at the back of a cave. */
function buildCairn(c: Ctx, u: number, v: number): void {
  const st = c.stone;
  const tk = c.r(0.9, 1.05);
  let y = c.g(u, v) - 0.3;
  const layers = 4 + Math.floor(c.rng() * 2);
  for (let i = 0; i < layers; i++) {
    const r = THREE.MathUtils.lerp(1.1, 0.45, i / layers) * c.r(0.9, 1.1);
    const hh = c.r(0.45, 0.6);
    const k = c.r(0.88, 1.08);
    st.set(tk * k, tk * k * 0.97, tk * k * 0.93, 0, 0.08 * r);
    c.prim(UNIT_BLOB, u + c.r(-0.12, 0.12), y + hh * 0.6, v + c.r(-0.12, 0.12), r, hh * 0.75, r * c.r(0.85, 1.1), c.rng() * 6);
    y += hh;
  }
  st.set(0.45, 0.38, 0.3, 2, 0);
  c.prim(UNIT_BOX, u, y + 0.08, v, 0.5, 0.1, 0.5);
  c.prim(UNIT_CONE, u, y + 0.75, v, 0.42, 0.3, 0.42, Math.PI / 4);
  st.set(1, 1, 1, 3, 0);
  c.prim(UNIT_BOX, u, y + 0.38, v, 0.3, 0.44, 0.3);
  c.glow(u, y + 0.38, v, 1.2);
  c.glow(u, y + 0.38, v, 6);
}

/** Where a roof goes, in its site's frame: u runs into the rock from the opening. */
interface RoofDims {
  half: number; // half-width of the hollow (m)
  from: number; // the nearest to the opening the roof may start
  len: number; // u of the back wall
  height: number; // floor to ceiling (m)
}

/**
 * The rock over a hollow. The terrain cuts caves and spring notches as open slots; this caps
 * one, from where the rock stands a ceiling's height above the floor to the back wall. face
 * gives the rock as it would be uncut, and floor the hollow's floor (relative to the site's base).
 * It is drawn with the ground's shader, so the cliff carries on across it.
 */
function buildRoof(c: Ctx, face: (u: number, v: number, out: Face) => Face, floor: (u: number) => number, dm: RoofDims): void {
  const rk = c.rock;
  const HALF = dm.half + 1.4;
  const NV = 10;
  const STEP = 1;
  c.foot = dm.len;
  const F: Face = { y: 0, nx: 0, ny: 1, nz: 0, rock: 1, salt: 0 };
  // The roof starts where the rock first stands a full ceiling's height over the floor, so
  // the opening under its brow is that tall.
  let u0 = dm.from;
  while (u0 < dm.len - 2 && face(u0, 0, F).y - floor(u0) < dm.height + 0.3) u0 += 0.25;
  const NU = Math.ceil((dm.len + 5 - u0) / STEP); // a little past the back wall
  // the mountainside itself, lifted a hand's width so it never fights the ground under it
  const top = (u: number, v: number) => {
    face(u, v, F);
    c.at(u, v);
    rk.vert(c.lx, F.y + 0.05, c.lz, F.nx, F.ny, F.nz, F.rock, F.salt, 0);
  };
  // the underside is level across the hollow, and never above the rock face
  const lowY = (u: number, v: number) => Math.min(floor(u) + dm.height, face(u, v, F).y - 0.4);
  const low = (u: number, v: number) => {
    const y = lowY(u, v);
    c.at(u, v);
    rk.vert(c.lx, y, c.lz, 0, -1, 0, 1, 0, 1);
  };
  // the brow faces out of the opening, back along u
  c.at(-1, 0);
  const bl = Math.hypot(c.lx, c.lz) || 1;
  const bnx = c.lx / bl;
  const bnz = c.lz / bl;
  const brow = (u: number, v: number, y: number) => {
    c.at(u, v);
    rk.vert(c.lx, y, c.lz, bnx, 0, bnz, 1, 0, 0.75);
  };
  for (let i = 0; i < NU; i++) {
    const ua = u0 + i * STEP;
    const ub = ua + STEP;
    for (let j = 0; j < NV; j++) {
      const va = -HALF + (j / NV) * 2 * HALF;
      const vb = -HALF + ((j + 1) / NV) * 2 * HALF;
      top(ua, va); top(ua, vb); top(ub, va);
      top(ub, va); top(ua, vb); top(ub, vb);
      low(ua, va); low(ub, va); low(ua, vb);
      low(ub, va); low(ub, vb); low(ua, vb);
      if (i === 0) {
        const ya = face(ua, va, F).y + 0.05;
        const yb = face(ua, vb, F).y + 0.05;
        brow(ua, va, lowY(ua, va)); brow(ua, vb, lowY(ua, vb)); brow(ua, va, ya);
        brow(ua, va, ya); brow(ua, vb, lowY(ua, vb)); brow(ua, vb, yb);
      }
    }
  }
}

function buildArch(c: Ctx): void {
  const st = c.stone;
  const tk = c.r(0.9, 1.1);
  st.set(tk, tk * c.r(0.95, 1.02), tk * c.r(0.92, 1.0), 0, 1.1);
  const S = c.r(30, 60);
  const H = c.r(25, 45);
  const T = c.r(6, 11);
  const skew = c.r(-0.2, 0.2);
  const bend = c.r(-4, 4);
  c.foot = S / 2 + 15;
  const gL = c.g(-S / 2, 0);
  const gR = c.g(S / 2, 0);
  const base = Math.min(gL, gR);
  const pts: THREE.Vector3[] = [];
  const radii: number[] = [];
  pts.push(new THREE.Vector3(-S / 2 - 1, gL - 10, 0));
  radii.push(T * 1.05);
  const N = 18;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI;
    const ca = -Math.cos(a);
    const sa = Math.sin(a);
    const gy = THREE.MathUtils.lerp(gL, gR, i / N);
    const y = THREE.MathUtils.lerp(gy, base + H, Math.pow(sa, 0.85));
    pts.push(new THREE.Vector3(ca * (S / 2) * (1 + skew * sa), y, sa * bend));
    radii.push(T * (0.5 + 0.5 * (1 - sa)) * c.r(0.9, 1.1));
  }
  pts.push(new THREE.Vector3(S / 2 + 1, gR - 10, 0));
  radii.push(T * 1.05);
  c.toLocal(pts);
  c.tube(pts, radii, 7, false, 1.35);
  // rubble at the feet
  st.set(tk * 0.95, tk * 0.93, tk * 0.9, 0, 0.5);
  const nr = 6 + Math.floor(c.rng() * 8);
  for (let i = 0; i < nr; i++) {
    const side = c.rng() < 0.5 ? -1 : 1;
    const u = side * S * 0.5 + c.r(-12, 12);
    const v = c.r(-12, 12);
    const s = c.r(1.5, 4.5);
    c.prim(UNIT_BLOB, u, c.g(u, v) + s * 0.2, v, s * 1.2, s * 0.8, s, c.rng() * 6);
  }
}

function buildBalancing(c: Ctx): void {
  const st = c.stone;
  const tk = c.r(0.88, 1.08);
  c.foot = 20;
  const stack = (u: number, v: number, scale: number) => {
    st.set(tk, tk * 0.98, tk * 0.95, 0, 0.55 * scale);
    let y = c.g(u, v) - 2 * scale;
    const r0 = c.r(5, 7) * scale;
    c.prim(UNIT_BLOB, u, y + r0 * 0.5, v, r0, r0 * 0.85, r0 * c.r(0.85, 1.1), c.rng() * 6);
    y += r0 * 1.25;
    const layers = 1 + Math.floor(c.rng() * 2);
    let ou = u;
    let ov = v;
    for (let i = 0; i < layers; i++) {
      const r = c.r(2.2, 3.4) * scale;
      ou += c.r(-0.8, 0.8) * scale;
      ov += c.r(-0.8, 0.8) * scale;
      c.prim(UNIT_BLOB, ou, y + r * 0.7, ov, r, r * 0.9, r, c.rng() * 6, c.r(-0.3, 0.3));
      y += r * 1.45;
    }
    const big = c.r(6, 9) * scale;
    const hang = c.r(0.5, 2.5) * scale;
    const ha = c.rng() * Math.PI * 2;
    c.prim(UNIT_BLOB, ou + Math.cos(ha) * hang, y + big * 0.72, ov + Math.sin(ha) * hang, big * 1.3, big * 0.85, big, c.rng() * 6, c.r(-0.2, 0.2), c.r(-0.2, 0.2));
  };
  stack(0, 0, 1);
  if (c.rng() < 0.6) stack(c.r(18, 28), c.r(-8, 8), c.r(0.45, 0.7));
  if (c.rng() < 0.3) stack(c.r(-25, -15), c.r(-10, 10), c.r(0.35, 0.5));
  st.set(tk * 0.95, tk * 0.93, tk * 0.9, 0, 0.4);
  for (let i = 0; i < 8; i++) {
    const a = c.rng() * Math.PI * 2;
    const d = c.r(8, 22);
    const u = Math.cos(a) * d;
    const v = Math.sin(a) * d;
    const s = c.r(1, 3);
    c.prim(UNIT_BLOB, u, c.g(u, v) + s * 0.15, v, s * 1.2, s * 0.75, s, c.rng() * 6);
  }
}

function buildStones(c: Ctx, onSalt: boolean): void {
  const st = c.stone;
  const tk = onSalt ? c.r(0.6, 0.72) : c.r(0.9, 1.05);
  const stone = (u: number, v: number, ry: number, w: number, h: number, d: number, lean: number, fallen: boolean) => {
    const k = c.r(0.92, 1.06);
    st.set(tk * k, tk * k * 0.98, tk * k * 0.95, 0, 0.18);
    const g = c.g(u, v);
    if (fallen) {
      c.prim(UNIT_SLAB, u, g + d * 0.25, v, w, h, d, ry, Math.PI / 2 - 0.05, c.r(-0.1, 0.1));
    } else {
      const y = g + (h / 2 - 1.5) * Math.cos(lean);
      const off = (h / 2) * Math.sin(lean);
      c.prim(UNIT_SLAB, u + Math.sin(ry) * off, y, v + Math.cos(ry) * off, w, h, d, ry, lean, c.r(-0.03, 0.03));
    }
  };
  if (c.rng() < 0.6) {
    const n = 7 + Math.floor(c.rng() * 7);
    const R = c.r(14, 28);
    c.foot = R + 6;
    const lean1 = Math.floor(c.rng() * n);
    const lean2 = c.rng() < 0.5 ? Math.floor(c.rng() * n) : -1;
    const fallen = c.rng() < 0.5 ? Math.floor(c.rng() * n) : -1;
    const hBase = c.r(8, 14);
    for (let i = 0; i < n; i++) {
      if (i !== lean1 && c.rng() < 0.08) continue;
      const a = (i / n) * Math.PI * 2 + c.r(-0.08, 0.08);
      const u = Math.cos(a) * R;
      const v = Math.sin(a) * R;
      const ry = Math.PI / 2 - a; // broad face toward the centre
      const lean = i === lean1 || i === lean2 ? c.r(0.2, 0.45) * (c.rng() < 0.5 ? -1 : 1) : c.r(-0.04, 0.04);
      stone(u, v, ry, c.r(1.8, 3.4), hBase * c.r(0.75, 1.25), c.r(1.0, 1.8), lean, i === fallen);
    }
    if (c.rng() < 0.55) {
      st.set(tk, tk, tk * 0.96, 0, 0.12);
      c.prim(UNIT_BOX, 0, c.g(0, 0) + 0.3, 0, c.r(3, 5), 1.2, c.r(1.8, 2.6), c.rng() * 3);
    }
  } else {
    const n = 5 + Math.floor(c.rng() * 5);
    const sp = c.r(5, 9);
    c.foot = (n * sp) / 2 + 6;
    const rising = c.rng() < 0.5;
    const lean1 = Math.floor(c.rng() * n);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const u = (i - (n - 1) / 2) * sp;
      const v = c.r(-1.5, 1.5);
      const h = THREE.MathUtils.lerp(8, c.r(14, 18), rising ? t : 1 - Math.abs(t - 0.5) * 2);
      const lean = i === lean1 ? c.r(0.2, 0.4) * (c.rng() < 0.5 ? -1 : 1) : c.r(-0.04, 0.04);
      stone(u, v, c.r(-0.2, 0.2), c.r(1.8, 3), h, c.r(1, 1.6), lean, false);
    }
  }
}

function buildBones(c: Ctx): void {
  const st = c.stone;
  const tk = c.r(0.92, 1.05);
  const L = c.r(60, 110);
  const Hs = c.r(12, 22);
  const R = c.r(9, 16);
  c.foot = L / 2 + 8;
  const nV = 22 + Math.floor(c.rng() * 9);
  const wig = c.r(2, 6);
  const wf = c.r(0.5, 1.5);
  const spine: THREE.Vector3[] = [];
  const sr: number[] = [];
  const vy: number[] = [];
  for (let i = 0; i <= nV; i++) {
    const t = i / nV;
    const u = (t - 0.5) * L;
    const v = Math.sin(t * Math.PI * wf) * wig;
    const y = c.g(u, v) + Hs * Math.pow(Math.sin(Math.PI * t), 0.8) - 3;
    spine.push(new THREE.Vector3(u, y, v));
    vy.push(y);
    sr.push(THREE.MathUtils.lerp(1.4, 0.7, t));
  }
  const spineLocal = c.toLocal(spine.map((p) => p.clone()));
  st.set(1.0 * tk, 0.95 * tk, 0.84 * tk, 1, 0.12);
  // The back is somewhere to land and to walk the length of, so what you stand on is one
  // unbroken run as high as the vertebrae, not the dips between them. The fins standing
  // along it are solid: you walk round them.
  c.solid = false;
  c.tube(spineLocal, sr, 6, true);
  c.solid = true;
  for (let i = 0; i < nV; i++) c.solids.addCapsule(spineLocal[i], spineLocal[i + 1], (sr[i] + sr[i + 1]) * 0.5 * 1.42, 1);
  for (let i = 0; i <= nV; i++) {
    const p = spine[i];
    const s = sr[i] * c.r(1.3, 1.6);
    st.set(1.0 * tk, 0.95 * tk, 0.84 * tk, 1, 0.15);
    c.prim(UNIT_BLOB, p.x, p.y, p.z, s * 0.8, s, s * 1.2, 0);
    c.prim(UNIT_BOX, p.x - 0.4, p.y + s * 1.6, p.z, s * 0.35, s * 2.4, s * 0.6, 0, 0, 0.3);
  }
  // ribs sweeping down to the sand on both sides
  for (let i = 0; i <= nV; i++) {
    const t = i / nV;
    if (t < 0.16 || t > 0.78) continue;
    const sp = spine[i];
    const rr = R * (0.55 + 0.45 * Math.sin(Math.PI * (t - 0.1) / 0.75));
    for (const side of [-1, 1]) {
      if (c.rng() < 0.1) continue;
      const broken = c.rng() < 0.25;
      const smax = broken ? c.r(0.35, 0.75) : 1;
      const endU = sp.x + 3;
      const endV = sp.z + side * rr * 1.1;
      const gEnd = c.g(endU, endV) - 2.5;
      const pts: THREE.Vector3[] = [];
      const radii: number[] = [];
      const N = 10;
      for (let k = 0; k <= N; k++) {
        const s = (k / N) * smax;
        const out = Math.sin(s * Math.PI * 0.5) * 1.1 + 0.12 * Math.sin(s * Math.PI);
        pts.push(new THREE.Vector3(sp.x + s * 3, THREE.MathUtils.lerp(vy[i], gEnd, Math.pow(s, 1.7)), sp.z + side * rr * out));
        radii.push(THREE.MathUtils.lerp(0.95, 0.45, s) * (R / 12) ** 0.5);
      }
      const k = c.r(0.9, 1.05);
      st.set(1.0 * tk * k, 0.95 * tk * k, 0.84 * tk * k, 1, 0.06);
      c.tube(c.toLocal(pts), radii, 6, broken);
      if (broken && c.rng() < 0.7) {
        const fu = endU + c.r(-3, 3);
        const fv = sp.z + side * rr * c.r(0.8, 1.3);
        c.prim(UNIT_CYL, fu, c.g(fu, fv) + 0.25, fv, 0.6, rr * c.r(0.4, 0.7), 0.6, c.rng() * 6, Math.PI / 2 + c.r(-0.2, 0.2));
      }
    }
  }
  // skull at the low end, mostly buried
  st.set(1.0 * tk, 0.95 * tk, 0.84 * tk, 1, 0.35);
  const su = -L / 2 - 4;
  const sv = spine[0].z;
  const sg = c.g(su, sv);
  c.prim(UNIT_BLOB, su, sg + 0.8, sv, 5.5, 3, 3.6, c.r(-0.3, 0.3), 0, c.r(-0.25, 0.1));
  c.prim(UNIT_BLOB, su - 5, sg - 0.2, sv + c.r(-1, 1), 4, 1.6, 2.6, c.r(-0.3, 0.3), 0, 0.15);
}

function buildLantern(c: Ctx): void {
  const st = c.stone;
  const tk = c.r(0.9, 1.08);
  c.foot = 10;
  const g0 = c.g(0, 0);
  let y = g0 - 1;
  const layers = 6 + Math.floor(c.rng() * 5);
  const mastTall = c.rng() < 0.6;
  const cairnH = mastTall ? c.r(7, 11) : c.r(15, 22);
  let ou = 0;
  let ov = 0;
  for (let i = 0; i < layers; i++) {
    const t = i / layers;
    const r = THREE.MathUtils.lerp(3.4, mastTall ? 1.2 : 0.9, t) * c.r(0.9, 1.1);
    const hh = cairnH / layers;
    ou += c.r(-0.25, 0.25);
    ov += c.r(-0.25, 0.25);
    const k = c.r(0.88, 1.08);
    st.set(tk * k, tk * k * 0.97, tk * k * 0.93, 0, 0.12 * r);
    if (mastTall) c.prim(UNIT_BLOB, ou, y + hh * 0.6, ov, r, hh * 0.75, r * c.r(0.85, 1.1), c.rng() * 6);
    else c.prim(UNIT_BOX, ou, y + hh / 2, ov, r * 1.7, hh * 1.02, r * 1.6, c.rng() * 6);
    y += hh;
  }
  let topY = y;
  let tu = ou;
  let tv = ov;
  if (mastTall) {
    const H = c.r(10, 18);
    const la = c.rng() * 6.28;
    const lean = c.r(0, 0.8);
    const pts: THREE.Vector3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      pts.push(new THREE.Vector3(ou + Math.cos(la) * lean * t * t, y - 1 + H * t, ov + Math.sin(la) * lean * t * t));
      radii.push(THREE.MathUtils.lerp(0.36, 0.2, t));
    }
    st.set(0.5, 0.42, 0.34, 2, 0.02);
    c.tube(c.toLocal(pts), radii, 5, true);
    tu = ou + Math.cos(la) * lean;
    tv = ov + Math.sin(la) * lean;
    topY = y - 1 + H;
    // cross bar below the light
    c.prim(UNIT_BOX, tu, topY - 2.2, tv, 3.2, 0.18, 0.18, c.rng() * 3);
  }
  // lantern housing: four posts, a cap, and the light
  st.set(0.45, 0.38, 0.3, 2, 0);
  const hw = 0.55;
  for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    c.prim(UNIT_BOX, tu + a * hw, topY + 0.8, tv + b * hw, 0.12, 1.6, 0.12);
  }
  c.prim(UNIT_BOX, tu, topY + 0.05, tv, hw * 2.4, 0.2, hw * 2.4);
  c.prim(UNIT_CONE, tu, topY + 2.0, tv, hw * 1.8, 0.9, hw * 1.8, Math.PI / 4);
  st.set(1, 1, 1, 3, 0);
  c.prim(UNIT_BOX, tu, topY + 0.8, tv, 0.75, 1.0, 0.75);
  c.glow(tu, topY + 0.8, tv, 1.6);
  c.glow(tu, topY + 0.8, tv, 7);
  // ring of small stones
  const n = 9 + Math.floor(c.rng() * 6);
  const R = c.r(6, 9);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const u = Math.cos(a) * R;
    const v = Math.sin(a) * R;
    const s = c.r(0.5, 1.1);
    st.set(tk, tk, tk * 0.95, 0, 0.1);
    c.prim(UNIT_BLOB, u, c.g(u, v) + s * 0.3, v, s, s * 0.8, s, c.rng() * 6);
  }
}

function buildSundial(c: Ctx, onSalt: boolean): void {
  const st = c.stone;
  const tk = onSalt ? c.r(0.62, 0.72) : c.r(1.08, 1.18);
  const R = c.r(16, 26);
  c.foot = R + 4;
  const step = 3.2;
  for (let u = -R; u <= R; u += step) {
    for (let v = -R; v <= R; v += step) {
      if (u * u + v * v > R * R) continue;
      if (c.rng() < 0.15) continue;
      const k = c.r(0.9, 1.06);
      st.set(tk * k, tk * k * 0.98, tk * k * 0.94, 0, 0.04);
      const g = c.g(u, v);
      const sink = c.rng() < 0.2 ? c.r(0.2, 0.5) : 0;
      c.solid = false; // paving, flush with the ground
      c.prim(UNIT_BOX, u, g - 0.15 - sink, v, step * 0.94, 0.6, step * 0.94, c.r(-0.03, 0.03), c.r(-0.04, 0.04), c.r(-0.04, 0.04));
      c.solid = true;
    }
  }
  // gnomon: a tall triangular blade, vertical edge at the centre, slope running out along +u
  const Ht = c.r(12, 22);
  const ang = c.r(0.55, 0.95);
  const Lb = Math.min(Ht / Math.tan(ang), R * 0.9);
  const th = c.r(0.9, 1.4) / 2;
  const g0 = c.g(0, 0);
  const gB = c.g(Lb, 0);
  st.set(tk * 0.95, tk * 0.93, tk * 0.9, 0, 0.08);
  const corners: number[] = [];
  for (const vv of [-th, th]) {
    for (const [u, y] of [[0, g0 - 0.6], [Lb, gB - 0.6], [0, g0 + Ht]]) {
      c.at(u, vv);
      corners.push(c.lx, y, c.lz);
    }
  }
  const C = (i: number) => st.vert(corners[i * 3], corners[i * 3 + 1], corners[i * 3 + 2]);
  const quad = (a: number, b: number, d: number, e: number) => {
    C(a); C(b); C(d);
    C(a); C(d); C(e);
  };
  C(0); C(1); C(2);
  C(3); C(5); C(4);
  quad(0, 3, 4, 1);
  quad(1, 4, 5, 2);
  quad(2, 5, 3, 0);
  c.prim(UNIT_BOX, 0, g0 + 0.6, 0, 3.4, 2.4, 3.4, 0);
  // hour posts around the rim
  const n = 8 + 4 * Math.floor(c.rng() * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const u = Math.cos(a) * (R + 1.2);
    const v = Math.sin(a) * (R + 1.2);
    const h = i % (n / 4) === 0 ? c.r(3, 4.5) : c.r(1.4, 2.6);
    const fallen = c.rng() < 0.15;
    st.set(tk, tk * 0.98, tk * 0.94, 0, 0.06);
    if (fallen) c.prim(UNIT_SLAB, u, c.g(u, v) + 0.35, v, 0.9, h, 0.7, -a + c.r(-1, 1), Math.PI / 2);
    else c.prim(UNIT_SLAB, u, c.g(u, v) + h / 2 - 0.3, v, 0.9, h, 0.7, -a);
  }
}

function buildShell(c: Ctx): void {
  const st = c.stone;
  const tk = c.r(0.92, 1.04);
  const rmax = c.r(8, 13);
  const b = c.r(0.17, 0.22);
  const turns = c.r(2.6, 3.2) * Math.PI;
  const a0 = rmax * Math.exp(-b * turns);
  const roll = c.r(-0.25, 0.25);
  c.foot = rmax * 1.6;
  const g0 = c.g(0, 0);
  const lift = g0 + rmax * c.r(0.35, 0.6);
  const pts: THREE.Vector3[] = [];
  const radii: number[] = [];
  const tints: number[] = [];
  const N = 70;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * turns;
    const r = a0 * Math.exp(b * th);
    const px = r * Math.cos(th);
    const py = r * Math.sin(th);
    // the coil sits in a slightly rolled vertical plane, drifting sideways like a real whorl
    const pz = r * 0.25;
    pts.push(new THREE.Vector3(px, lift + py * cr - pz * sr, py * sr + pz * cr));
    radii.push(r * 0.56);
    tints.push(i % 3 === 0 ? 0.88 : 1);
  }
  st.set(1.0 * tk, 0.92 * tk, 0.86 * tk, 1, 0.05);
  c.tube(c.toLocal(pts), radii, 12, false, 1.25, tints);
  // a few fragments scattered on the sand
  for (let i = 0; i < 5; i++) {
    const a = c.rng() * Math.PI * 2;
    const d = c.r(rmax * 1.2, rmax * 2.2);
    const u = Math.cos(a) * d;
    const v = Math.sin(a) * d;
    const s = c.r(0.6, 1.4);
    c.prim(UNIT_BLOB, u, c.g(u, v) + s * 0.1, v, s * 1.4, s * 0.4, s, c.rng() * 6);
  }
}

// ------------------------------------------------------------------ caverns

/** A cavern as the discoveries know it: the shape the terrain cuts, and what is inside. */
export interface CavernSite {
  key: number;
  cav: Cavern;
  /** 0 a single chamber, 1 a bent passage, 2 a chamber with a pool. */
  variant: number;
  /** A great seam of glowing mineral, rather than a few crystals. */
  vein: boolean;
  carvings: boolean;
  relic: boolean;
  seed: number;
  /** Strikes landed on the spot so far. */
  hits: number;
}

const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** How far a cavern's centre line has shifted sideways by u, and its half-width there (as the terrain cuts it). */
const cavLine = (cv: Cavern, u: number): number => cv.bend * sstep(cv.ramp + 3, cv.ramp + 17, u);
const cavHalf = (cv: Cavern, u: number): number => {
  const er = cv.half + cv.bulge;
  return cv.half + cv.bulge * sstep(cv.len - 2 * er - 4, cv.len - er, u);
};

/**
 * An open cavern: the sand left standing over it as a roof (the terrain cuts the slot, as it
 * does for a cave), daylight falling in under the brow, and what the dark holds.
 */
function buildCavern(c: Ctx, cs: CavernSite, face: (u: number, v: number, out: Face) => Face): void {
  const cv = cs.cav;
  const rk = c.rock;
  const st = c.stone;
  const F: Face = { y: 0, nx: 0, ny: 1, nz: 0, rock: 0, salt: 0 };
  const floorY = cv.floor - c.baseY;
  const ceilY = floorY + TERRAIN.cavernHeight;
  const er = cv.half + cv.bulge;
  c.foot = cv.len;

  // ---- the roof: a sheet following the centre line, wide enough to lap onto uncut ground
  const WC = er + 3.4;
  const NV = Math.ceil((WC * 2) / 1.25);
  const u0 = cv.roof;
  const NU = Math.ceil((cv.len + 4 - u0) / 1.25);
  const du = (cv.len + 4 - u0) / NU;
  const uAt = (i: number) => u0 + i * du;
  const vAt = (u: number, j: number) => cavLine(cv, u) - WC + (j / NV) * 2 * WC;
  // the sand itself, a hand's width proud of the ground, tucked under it round the rim
  const top = (i: number, j: number) => {
    const u = uAt(i);
    const v = vAt(u, j);
    face(u, v, F);
    c.at(u, v);
    rk.vert(c.lx, F.y + (j === 0 || j === NV || i === NU ? -0.04 : 0.05), c.lz, F.nx, F.ny, F.nz, F.rock, F.salt, 0);
  };
  // the underside: broken rock a little above the ceiling's height, never above the sand
  const lowY = (i: number, j: number) => {
    const u = uAt(i);
    const bump = i === 0 ? 0 : 0.9 * hash4(i, j, st.salt, 21);
    return Math.min(ceilY + bump, face(u, vAt(u, j), F).y - 0.5);
  };
  const low = (i: number, j: number) => {
    const u = uAt(i);
    const y = lowY(i, j);
    c.at(u, vAt(u, j));
    rk.vert(c.lx, y, c.lz, 0, -1, 0, 1, 0, 1 + sstep(u0 + 1, u0 + 14, u));
  };
  c.at(-1, 0);
  const bl = Math.hypot(c.lx, c.lz) || 1;
  const bnx = c.lx / bl;
  const bnz = c.lz / bl;
  const brow = (j: number, y: number) => {
    c.at(u0, vAt(u0, j));
    rk.vert(c.lx, y, c.lz, bnx, 0, bnz, 1, 0, 0.75);
  };
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      top(i, j); top(i, j + 1); top(i + 1, j);
      top(i + 1, j); top(i, j + 1); top(i + 1, j + 1);
      low(i, j); low(i + 1, j); low(i, j + 1);
      low(i + 1, j); low(i + 1, j + 1); low(i, j + 1);
      if (i === 0) {
        const ya = face(u0, vAt(u0, j), F).y + 0.05;
        const yb = face(u0, vAt(u0, j + 1), F).y + 0.05;
        brow(j, lowY(0, j)); brow(j + 1, lowY(0, j + 1)); brow(j, ya);
        brow(j, ya); brow(j + 1, lowY(0, j + 1)); brow(j + 1, yb);
      }
    }
  }

  // ---- daylight through the mouth: three slanting sheets of lit dust from the brow to the floor
  const rampY = (u: number) => floorY + (cv.top - cv.floor) * (1 - sstep(2, 2 + cv.ramp, u));
  for (let k = 0; k < 3; k++) {
    const ua = u0 - 2.5 + k * 1.2;
    const ub = u0 + 5 + k * 4;
    const w = cv.half - 0.4;
    const cols: Array<[number, number]> = [[-w, 0], [0, 1], [w, 0]];
    for (let q = 0; q < 2; q++) {
      const [va, fa] = cols[q];
      const [vb, fb] = cols[q + 1];
      const P = (u: number, v: number, y: number, fd: number) => {
        c.at(u, v + cavLine(cv, u));
        c.shafts.push(c.lx, y, c.lz, fd);
      };
      // (brightest a third of the way down, fading out to both ends so no edge shows)
      const ya = ceilY + 1.5;
      const yb = rampY(ub) + 0.1;
      const um = ua + (ub - ua) * 0.35;
      const ym = ya + (yb - ya) * 0.35;
      P(ua, va, ya, 0); P(ua, vb, ya, 0); P(um, va, ym, fa);
      P(um, va, ym, fa); P(ua, vb, ya, 0); P(um, vb, ym, fb);
      P(um, va, ym, fa); P(um, vb, ym, fb); P(ub, va, yb, 0);
      P(ub, va, yb, 0); P(um, vb, ym, fb); P(ub, vb, yb, 0);
    }
  }

  // ---- what the dark holds. Everything from here is out of the sun's reach.
  st.dark = true;
  const side = c.rng() < 0.5 ? -1 : 1;
  const wall = (u: number, sd: number, inset: number) => cavLine(cv, u) + sd * (cavHalf(cv, u) - inset);

  // the mineral: a seam climbing one wall of the end chamber, or only a few crystals at its foot
  {
    const ua = cv.len - er * 1.7;
    const ub = cv.len - 2.5;
    const n = cs.vein ? 16 : 5;
    for (let i = 0; i < n; i++) {
      const t = (i + c.rng() * 0.6) / n;
      const u = ua + (ub - ua) * t;
      const h = c.r(0.7, 1.9) * (cs.vein ? 1 : 0.7);
      const y = floorY + (cs.vein ? 0.3 + 4.6 * Math.sin(t * Math.PI) * c.r(0.75, 1) : 0.2);
      const k = c.r(0.65, 1.1);
      st.set(k, k, k, 4, 0);
      c.prim(UNIT_CONE, u, y + h * 0.35, wall(u, side, 0.15), c.r(0.22, 0.5), h, c.r(0.22, 0.5), c.rng() * 6, side * c.r(0.5, 1.1), c.r(-0.5, 0.5));
    }
    // a cluster growing out of the floor beneath it
    const um = (ua + ub) / 2;
    for (let i = 0; i < (cs.vein ? 7 : 3); i++) {
      const u = um + c.r(-2.2, 2.2);
      const v = wall(u, side, c.r(0.9, 2.4));
      const h = c.r(0.5, 1.5);
      const k = c.r(0.6, 1.05);
      st.set(k, k, k, 4, 0);
      c.prim(UNIT_CONE, u, floorY + h * 0.4, v, c.r(0.16, 0.34), h, c.r(0.16, 0.34), c.rng() * 6, c.r(-0.35, 0.35), c.r(-0.35, 0.35));
    }
    const ly = floorY + (cs.vein ? 2.8 : 1);
    c.at(um, wall(um, side, 1.4));
    c.light = [c.lx, ly, c.lz, cs.vein ? 17 : 9];
    c.veins.push(c.lx, ly, c.lz, cs.vein ? 7 : 3.5);
    if (cs.vein) {
      for (const t of [0.2, 0.5, 0.8]) {
        const u = ua + (ub - ua) * t;
        c.at(u, wall(u, side, 0.4));
        c.veins.push(c.lx, floorY + 0.6 + 4.4 * Math.sin(t * Math.PI), c.lz, 2);
      }
    }
  }

  // old carvings: stones stood against the other wall, cut with rows of marks that still hold a little light
  if (cs.carvings) {
    const n = 3;
    for (let i = 0; i < n; i++) {
      const u = cv.len - er - 7 + i * 4.6 + c.r(-0.5, 0.5);
      const v = wall(u, -side, 0.45);
      const h = c.r(2.5, 3.4);
      const k = c.r(0.85, 1.05);
      st.set(k, k * 0.98, k * 0.94, 0, 0.05);
      c.prim(UNIT_BOX, u, floorY + h / 2 - 0.3, v, c.r(1.3, 1.7), h, 0.55, c.r(-0.08, 0.08), 0, c.r(-0.04, 0.04));
      st.set(0.42, 0.42, 0.42, 4, 0);
      c.solid = false;
      for (let row = 0; row < 5; row++) {
        const y = floorY + 0.55 + row * 0.42;
        if (y > floorY + h - 0.75) break;
        for (let q = -1; q <= 1; q++) {
          if (c.rng() < 0.3) continue;
          const tall = c.rng() < 0.3;
          c.prim(UNIT_BOX, u + q * 0.36, y, v + side * 0.3, tall ? 0.07 : c.r(0.14, 0.28), tall ? 0.3 : 0.07, 0.06);
        }
      }
      c.solid = true;
    }
  }

  // a pool, in the basin the terrain leaves for it
  if (cv.pool > 0) c.pools.push({ y: floorY - 0.1, r: cv.pool - 0.6, u: cv.len - er, v: cv.bend, under: true });

  // and now and then something left behind, on a stone of its own
  if (cs.relic) {
    const u = cv.pool > 0 ? cv.len - 2.6 : cv.len - er;
    const v = cavLine(cv, u) - side * (cv.pool > 0 ? 0 : 1.5);
    const k = c.r(0.8, 0.95);
    st.set(k, k * 0.97, k * 0.93, 0, 0.05);
    c.prim(UNIT_CYL, u, floorY + 0.3, v, 0.62, 0.75, 0.62, c.rng() * 6);
    c.prim(UNIT_CYL, u, floorY + 0.74, v, 0.48, 0.14, 0.48, c.rng() * 6);
    c.at(u, v);
    c.relic = [c.lx, floorY + 1.12, c.lz];
  }
  st.dark = false;
}

// ------------------------------------------------------------------ the system

/** A spring: the middle of the lip, the unit direction square into the cliff there, and the notch's depth (m). */
interface Spring {
  x: number;
  z: number;
  dx: number;
  dz: number;
  len: number;
  half: number; // half-width of the rock over it (m)
}

interface Site {
  key: number;
  x: number;
  z: number;
  kind: string;
  group: THREE.Group;
  reachR: number;
  /** Where the site's own frame sits: the group's position. */
  ox: number;
  oy: number;
  oz: number;
  solids: Solids | null;
  /** Still water at the site: surface height (absolute), radius, and centre. */
  pools: { y: number; r: number; x: number; z: number }[];
  /** For a cavern: what lights it (world position, reach) and the relic lying in it, if any. */
  light?: THREE.Vector4;
  relic?: { x: number; y: number; z: number; obj: THREE.Object3D };
}

export class Discoveries {
  readonly group = new THREE.Group();
  /** Called (at most once per site) when the player first comes within ~25 m of a site. */
  onReach: ((kind: string) => void) | null = null;

  private readonly world: World;
  private readonly stoneMat: THREE.ShaderMaterial;
  private readonly rockMat: THREE.ShaderMaterial;
  private readonly waterMat: THREE.ShaderMaterial;
  private readonly frondMat: THREE.ShaderMaterial;
  private readonly glowMat: THREE.ShaderMaterial;
  private readonly sites: Site[] = [];
  private readonly reached = new Set<number>();
  private readonly sample: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private readonly cellPos = { x: 0, z: 0 };
  private readonly bankSample: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private readonly springCache = new Map<number, Spring[]>();
  /** The rock caps over springs that are built now, by site key. */
  private readonly caps = new Map<number, Spring>();
  private scanT = 0;

  /** The sand over a cavern has finished draining away: it is open for good. */
  onOpened: ((key: number) => void) | null = null;
  /** The ground has changed shape, so anything baked from it is out of date. */
  onGround: (() => void) | null = null;
  private readonly u: Uniforms;
  private readonly veinMat: THREE.ShaderMaterial;
  private readonly relicGlowMat: THREE.ShaderMaterial;
  private readonly shaftMat: THREE.ShaderMaterial;
  private readonly underWaterMat: THREE.ShaderMaterial;
  /** Every cell looked at so far: the cavern under it, or null. */
  private readonly cavernCache = new Map<number, CavernSite | null>();
  private readonly opened = new Set<number>();
  private readonly taken = new Set<number>();
  /** The caverns the terrain is shaped by now: the nearest few. */
  private active: CavernSite[] = [];
  private draining: CavernSite | null = null;
  private readonly struck = { hollow: 0, level: 0, broke: false };

  constructor(world: World, uniforms: Uniforms) {
    this.world = world;
    this.u = uniforms;
    this.group.name = 'discoveries';
    this.stoneMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms },
      vertexShader: stoneVert,
      fragmentShader: stoneFrag,
      side: THREE.DoubleSide,
    });
    this.rockMat = new THREE.ShaderMaterial({
      // the ground's own shader; no clipmap level to cut out of it
      uniforms: { ...uniforms, uInnerCenter: { value: new THREE.Vector2() }, uInnerHalf: { value: -1 } },
      vertexShader: rockCapVert,
      fragmentShader: terrainFrag,
      side: THREE.DoubleSide,
    });
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uDim: { value: 1 } },
      vertexShader: waterVert,
      fragmentShader: waterFrag,
    });
    this.underWaterMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uDim: { value: 0.12 } },
      vertexShader: waterVert,
      fragmentShader: waterFrag,
    });
    this.frondMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms },
      vertexShader: frondVert,
      fragmentShader: frondFrag,
      side: THREE.DoubleSide,
    });
    const glow = (r: number, g: number, b: number, day: number) =>
      new THREE.ShaderMaterial({
        uniforms: { ...uniforms, uGlowCol: { value: new THREE.Vector3(r, g, b) }, uGlowDay: { value: day } },
        vertexShader: glowVert,
        fragmentShader: glowFrag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    this.glowMat = glow(1, 0.72, 0.38, 0);
    this.veinMat = glow(0.22, 0.7, 0.6, 1);
    this.relicGlowMat = glow(1, 0.72, 0.38, 1);
    this.shaftMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms },
      vertexShader: shaftVert,
      fragmentShader: shaftFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
  }

  // ---------------------------------------------------------------- caverns

  /** What the save remembers: the caverns already opened, and the relics already carried off. */
  restore(opened: readonly number[], taken: readonly number[]): void {
    for (const k of opened) this.opened.add(k);
    for (const k of taken) this.taken.add(k);
  }

  /** The cavern hidden under a cell, if it has one. Worked out once per cell. */
  private cavernAt(cx: number, cz: number): CavernSite | null {
    const key = cellKey(cx, cz);
    let site = this.cavernCache.get(key);
    if (site === undefined) {
      site = this.findCavern(cx, cz, key);
      this.cavernCache.set(key, site);
    }
    return site;
  }

  /**
   * Whether a cell hides a cavern, and exactly how it lies. Only a cell with no other find may,
   * and only on open sand level enough to leave a roof over the whole of it. The floor is set
   * from the lowest ground above, so the roof is nowhere thinner than cavernCover.
   */
  private findCavern(cx: number, cz: number, key: number): CavernSite | null {
    const w = this.world;
    const s = w.seed | 0;
    if (hash4(cx, cz, s, 1) < SITE_P || hash4(cx, cz, s, 9) >= CAVERN_P) return null;
    const x0 = cx * CELL + MARGIN + hash4(cx, cz, s, 2) * (CELL - 2 * MARGIN);
    const z0 = cz * CELL + MARGIN + hash4(cx, cz, s, 3) * (CELL - 2 * MARGIN);
    if (this.riverAt(x0, z0) < 420) return null;
    const cities = (w as Partial<{ cities: { at(x: number, z: number): { cx: number; cz: number; radius: number } } }>).cities;
    if (cities) {
      const c = cities.at(x0, z0);
      if (Math.hypot(c.cx - x0, c.cz - z0) < c.radius + 1500 * WORLD_SCALE) return null;
    }
    const q = this.sample;
    const seed = Math.floor(hash4(cx, cz, s, 12) * 4294967296);
    const rng = mulberry32(seed);
    const variant = Math.floor(rng() * 3) % 3;
    const half = [4.5, 4, 5][variant] + rng() * 0.8;
    const bend = variant === 1 ? (rng() < 0.5 ? -1 : 1) * (9 + rng() * 2) : variant === 2 ? (rng() - 0.5) * 6 : 0;
    const bulge = [4.5, 3, 4.5][variant];
    const chamber = [24, 30, 30][variant] + rng() * 4;
    const pool = variant === 2 ? 5.5 + rng() : 0;
    const vein = rng() < (variant === 2 ? 0.5 : 0.75);
    const carvings = rng() < (vein ? 0.5 : 0.9);
    const relic = rng() < 0.35;
    const yaw0 = rng() * Math.PI * 2;
    const T = TERRAIN;
    const uMax = 2 + T.cavernRampMax + chamber + 5;
    const W = Math.abs(bend) + half + bulge + 5;
    // Dunes leave few places level enough, so a handful of spots around the cell's own are
    // tried, each with the cavern lying six ways, and the first that fits is the one.
    for (let k = 0; k < 30; k++) {
      const spot = Math.floor(k / 6);
      const x = Math.fround(x0 + (spot === 0 ? 0 : (hash4(cx, cz, s, 40 + spot) - 0.5) * 240));
      const z = Math.fround(z0 + (spot === 0 ? 0 : (hash4(cx, cz, s, 50 + spot) - 0.5) * 240));
      if (k % 6 === 0) {
        w.sample(x, z, q);
        if (q.rock > 0.08 || q.salt > 0.25) {
          k += 5;
          continue;
        }
      }
      const top = w.height(x, z);
      const yaw = yaw0 + (k * Math.PI) / 3;
      const dx = Math.fround(Math.cos(yaw));
      const dz = Math.fround(Math.sin(yaw));
      let lo = Infinity;
      let hi = -Infinity;
      let ok = true;
      for (let u = -10; u <= uMax && ok; u += 4) {
        for (let v = -W; v <= W; v += 4) {
          w.sample(x + dx * u - dz * v, z + dz * u + dx * v, q);
          if (q.rock > 0.12) {
            ok = false;
            break;
          }
          hi = Math.max(hi, q.h);
          if (u >= 6) lo = Math.min(lo, q.h);
        }
      }
      if (!ok || top - lo > 6.5 || hi - top > 12) continue;
      const floor = lo - (T.cavernHeight + T.cavernCover);
      const drop = top - floor;
      const ramp = Math.min(T.cavernRampMax, drop / T.cavernSlope);
      // the roof starts where the ramp has sunk a brow's height below the ceiling
      const want = 1 - (T.cavernHeight - T.cavernBrow) / drop;
      let a = 0;
      let b = 1;
      for (let i = 0; i < 24; i++) {
        const t = (a + b) / 2;
        if (t * t * (3 - 2 * t) < want) a = t;
        else b = t;
      }
      const open = this.opened.has(key) ? 1 : 0;
      return {
        key,
        cav: { x, z, dx, dz, top, floor, half, bend, bulge, len: 2 + ramp + chamber, ramp, roof: 2 + ramp * a, pool, open, dimple: DIMPLE },
        variant,
        vein,
        carvings,
        relic: relic && !this.taken.has(key),
        seed,
        hits: 0,
      };
    }
    return null;
  }

  /** Tell both copies of the terrain which caverns shape the ground now. */
  private pushCaverns(): void {
    const list = this.active.map((c) => c.cav);
    (this.world as Partial<{ setCaverns(l: readonly Cavern[]): void }>).setCaverns?.(list);
    if (this.u.uCavA) writeCaverns(this.u, list);
  }

  /**
   * Keeps the terrain's short list of caverns to the nearest few, and builds the roof and
   * contents of an open one that has come into range. Returns whether it built one.
   */
  private scanCaverns(px: number, pz: number): boolean {
    if (!(this.world as Partial<{ setCaverns: unknown }>).setCaverns) return false;
    const pcx = Math.floor(px / CELL);
    const pcz = Math.floor(pz / CELL);
    const near: CavernSite[] = [];
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const cs = this.cavernAt(pcx + dx, pcz + dz);
        if (cs && Math.hypot(cs.cav.x - px, cs.cav.z - pz) < 1400) near.push(cs);
      }
    }
    // one that is draining stays on the list whatever else is near
    if (this.draining && !near.includes(this.draining)) near.push(this.draining);
    const d2 = (c: CavernSite) => (c === this.draining ? -1 : (c.cav.x - px) ** 2 + (c.cav.z - pz) ** 2);
    near.sort((a, b) => d2(a) - d2(b));
    near.length = Math.min(near.length, MAX_CAVERNS);
    if (near.length !== this.active.length || near.some((c, i) => c !== this.active[i])) {
      const shaped = near.some((c) => c.cav.open > 0) || this.active.some((c) => c.cav.open > 0);
      this.active = near;
      this.pushCaverns();
      if (shaped) this.onGround?.();
    }
    for (const cs of near) {
      if (cs.cav.open > 0 && !this.isBuilt(cs.key) && Math.hypot(cs.cav.x - px, cs.cav.z - pz) < CAVERN_BUILD_R) {
        this.buildCavernSite(cs);
        return true;
      }
    }
    if (this.lampAt && !this.isBuilt(LAMP_KEY) && Math.hypot(this.lampAt.x - px, this.lampAt.z - pz) < BUILD_R) {
      this.buildLamp();
      return true;
    }
    return false;
  }

  private buildCavernSite(cs: CavernSite): void {
    const cv = cs.cav;
    // the frame's u axis runs down the ramp
    const ctx = new Ctx(this.world, cv.x, cv.z, cv.top, mulberry32(cs.seed ^ 0x51ab), Math.atan2(-cv.dz, cv.dx));
    ctx.stone.salt = cs.key & 1023;
    buildCavern(ctx, cs, this.faceOf(ctx));
    // it counts as reached once you are down in the end chamber
    const u = cv.len - cv.half - cv.bulge;
    ctx.at(u, cavLine(cv, u));
    this.finishSite(cs.key, 'cavern', cv.x + ctx.lx, cv.z + ctx.lz, cv.top, ctx);
    this.sites[this.sites.length - 1].reachR = 9;
  }

  /**
   * The pick has come down on sand at (x, z). Says how hollow the ground sounds there (0..1,
   * rising toward a sealed cavern from HOLLOW_R out), and on the spot itself counts the blow:
   * `level` 1..3 as the crust cracks, then `broke` when the sand starts to drain.
   */
  strike(x: number, z: number): { hollow: number; level: number; broke: boolean } {
    const out = this.struck;
    out.hollow = 0;
    out.level = 0;
    out.broke = false;
    let best: CavernSite | null = null;
    let bd = HOLLOW_R;
    for (const cs of this.active) {
      if (cs.cav.open > 0) continue;
      const d = Math.hypot(cs.cav.x - x, cs.cav.z - z);
      if (d < bd) {
        bd = d;
        best = cs;
      }
    }
    if (!best) return out;
    out.hollow = Math.pow(1 - bd / HOLLOW_R, 0.8);
    if (bd > DIG_R || this.draining) return out;
    best.hits++;
    best.cav.dimple = DIMPLE + 0.14 * best.hits;
    if (best.hits >= DIG_HITS) {
      out.broke = true;
      best.cav.open = 1e-4;
      this.draining = best;
      if (!this.isBuilt(best.key)) this.buildCavernSite(best);
    } else out.level = best.hits;
    this.pushCaverns();
    return out;
  }

  /** How long the sand takes to drain once a cavern breaks open (s). */
  readonly drainTime = DRAIN;

  /** The cavern whose sand is running out now, if any. */
  get drainingCavern(): Cavern | null {
    return this.draining ? this.draining.cav : null;
  }

  /** The nearest sealed cavern on the terrain's list within r metres, for the signs it gives at the surface. */
  sealedNear(x: number, z: number, r: number): Cavern | null {
    let best: Cavern | null = null;
    for (const cs of this.active) {
      if (cs.cav.open > 0) continue;
      const d = Math.hypot(cs.cav.x - x, cs.cav.z - z);
      if (d < r) {
        r = d;
        best = cs.cav;
      }
    }
    return best;
  }

  /**
   * The nearest cavern to a point, searching out ring by ring over the cells (they are rare, so
   * this can look several kilometres). `sealed` leaves out the ones already open.
   */
  nearestCavern(x: number, z: number, sealed = true): Cavern | null {
    const pcx = Math.floor(x / CELL);
    const pcz = Math.floor(z / CELL);
    let best: Cavern | null = null;
    let bd = Infinity;
    for (let r = 0; r <= 16; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cs = this.cavernAt(pcx + dx, pcz + dz);
          if (!cs || (sealed && cs.cav.open > 0)) continue;
          const d = Math.hypot(cs.cav.x - x, cs.cav.z - z);
          if (d < bd) {
            bd = d;
            best = cs.cav;
          }
        }
      }
      // nothing in a further ring can be nearer than this
      if (best && bd < r * CELL) break;
    }
    return best;
  }

  // ---------------------------------------------------------------- the lost lamp

  private lampAt: { x: number; z: number } | null = null;

  /**
   * Where a lamp lost near a point would be: at the nearest spring to it, failing that just
   * inside a massif's cave, and null where there is no mountain by at all. `kind` says which.
   * A spring's mouth is high up a headwall nobody can walk, so the lamp lies at the foot of the
   * fall under it: on the bank of the pool, just clear of the water.
   */
  lampSpot(x: number, z: number): { x: number; z: number; kind: 'spring' | 'cave' } | null {
    const w = this.world as Partial<{ massif(gi: number, gj: number): Massif | null; cave(gi: number, gj: number): Cave | null }>;
    if (!w.massif || !w.cave) return null;
    const gi0 = Math.floor(x / CITY_CELL);
    const gj0 = Math.floor(z / CITY_CELL);
    let best: { x: number; z: number; kind: 'spring' | 'cave' } | null = null;
    let bd = Infinity;
    let cave: { x: number; z: number; kind: 'spring' | 'cave' } | null = null;
    let cd = Infinity;
    for (let gj = gj0; gj <= gj0 + 1; gj++) {
      for (let gi = gi0; gi <= gi0 + 1; gi++) {
        const m = w.massif(gi, gj);
        if (!m) continue;
        const id = (gi + 32768) * 65536 + (gj + 32768);
        let springs = this.springCache.get(id);
        if (!springs) this.springCache.set(id, (springs = this.findSprings(m)));
        for (const sp of springs) {
          const d = Math.hypot(sp.x - x, sp.z - z);
          if (d >= bd) continue;
          bd = d;
          // Out from the mouth to where the fall has reached the pool, a little further, then
          // off to one side to the first level ground clear of the water. (Failing that it
          // stands in the shallows.)
          const low = TERRAIN.waterY + TERRAIN.riverBank + 1.5;
          let out = 8;
          while (out < 90 && this.world.height(sp.x - sp.dx * out, sp.z - sp.dz * out) > low) out += 2;
          const bx = sp.x - sp.dx * (out + 6);
          const bz = sp.z - sp.dz * (out + 6);
          best = { x: bx, z: bz, kind: 'spring' };
          search: for (let lat = 10; lat <= 34; lat += 1) {
            for (const side of [-1, 1]) {
              const tx = bx - sp.dz * side * lat;
              const tz = bz + sp.dx * side * lat;
              if (this.riverAt(tx, tz) < TERRAIN.riverHalf + 2.5 || this.world.height(tx, tz) > low) continue;
              best = { x: tx, z: tz, kind: 'spring' };
              break search;
            }
          }
        }
        const cv = w.cave(gi, gj)!;
        const d = Math.hypot(cv.x - x, cv.z - z);
        if (d < cd) {
          cd = d;
          cave = { x: cv.x + cv.dx * (TERRAIN.caveRoofFrom + 3) - cv.dz * 2.5, z: cv.z + cv.dz * (TERRAIN.caveRoofFrom + 3) + cv.dx * 2.5, kind: 'cave' };
        }
      }
    }
    return best ?? cave;
  }

  /** Put the lost lamp out in the world at (x, z), or take it away (null). It is built when the player comes near. */
  setLamp(at: { x: number; z: number } | null): void {
    if (at && this.lampAt && at.x === this.lampAt.x && at.z === this.lampAt.z) return;
    this.lampAt = at ? { x: at.x, z: at.z } : null;
    const i = this.sites.findIndex((s) => s.key === LAMP_KEY);
    if (i >= 0) {
      this.disposeSite(this.sites[i]);
      this.sites.splice(i, 1);
    }
  }

  /** Whether the lost lamp lies within reach of (x, z). */
  lampNear(x: number, z: number, reach: number): boolean {
    return this.lampAt !== null && this.isBuilt(LAMP_KEY) && Math.hypot(this.lampAt.x - x, this.lampAt.z - z) < reach;
  }

  private buildLamp(): void {
    const at = this.lampAt!;
    const baseY = this.world.height(at.x, at.z);
    const c = new Ctx(this.world, at.x, at.z, baseY, mulberry32(0x1a3f), 0);
    const st = c.stone;
    c.solid = false; // a thing to pick up, not to trip on
    c.foot = 0;
    // a miner's lamp, set down and forgotten: tipped a little, still alight
    st.set(0.3, 0.27, 0.25, 2, 0);
    c.prim(UNIT_BOX, 0, 0.04, 0, 0.3, 0.07, 0.3, 0.4, 0, 0.12);
    c.prim(UNIT_CONE, 0.05, 0.5, 0, 0.24, 0.16, 0.24, 0.4 + Math.PI / 4, 0, 0.12);
    st.set(1, 1, 1, 3, 0);
    c.prim(UNIT_BOX, 0.03, 0.25, 0, 0.2, 0.34, 0.2, 0.4, 0, 0.12);
    c.glow(0.03, 0.25, 0, 0.9);
    c.glow(0.03, 0.25, 0, 4.5);
    this.finishSite(LAMP_KEY, 'lamp', at.x, at.z, baseY, c);
    this.sites[this.sites.length - 1].reachR = 0; // found by picking it up, not by coming near
  }

  /** The key of a relic lying within reach of (x, y, z), or -1. */
  relicNear(x: number, y: number, z: number, reach: number): number {
    for (const s of this.sites) {
      const r = s.relic;
      if (r && Math.hypot(r.x - x, r.z - z) < reach && Math.abs(r.y - y - 1) < 1.6) return s.key;
    }
    return -1;
  }

  /** The relic has been picked up: it is gone from its stone for good. */
  takeRelic(key: number): void {
    this.taken.add(key);
    const cs = this.cavernCache.get(key);
    if (cs) cs.relic = false;
    for (const s of this.sites) {
      if (s.key !== key || !s.relic) continue;
      s.group.remove(s.relic.obj);
      s.relic.obj.traverse((o) => {
        if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
      });
      s.relic = undefined;
    }
  }

  /** Site position for a cell, or false if the cell is empty. */
  private cellSite(cx: number, cz: number): boolean {
    const s = this.world.seed | 0;
    this.cellPos.x = cx * CELL + MARGIN + hash4(cx, cz, s, 2) * (CELL - 2 * MARGIN);
    this.cellPos.z = cz * CELL + MARGIN + hash4(cx, cz, s, 3) * (CELL - 2 * MARGIN);
    // Most cells are empty, but one beside a river usually holds a grove.
    if (hash4(cx, cz, s, 1) >= SITE_P && !(hash4(cx, cz, s, 5) < GROVE_P && this.riverAt(this.cellPos.x, this.cellPos.z) < GROVE_REACH)) return false;
    // The wilderness finds keep clear of cities.
    const cities = (this.world as Partial<{ cities: { at(x: number, z: number): { cx: number; cz: number; radius: number } } }>).cities;
    if (cities) {
      const c = cities.at(this.cellPos.x, this.cellPos.z);
      if (Math.hypot(c.cx - this.cellPos.x, c.cz - this.cellPos.z) < c.radius + 1500 * WORLD_SCALE) return false;
    }
    return true;
  }

  private isBuilt(key: number): boolean {
    for (let i = 0; i < this.sites.length; i++) if (this.sites[i].key === key) return true;
    return false;
  }

  update(f: FrameState): void {
    const px = f.player.pos.x;
    const pz = f.player.pos.z;
    this.scanT -= f.dt;
    if (this.scanT <= 0) {
      this.scanT = SCAN_EVERY;
      this.scan(px, pz, this.sites.length === 0 ? 4 : 1);
    }
    // sand running out of a cavern that has just been broken into
    const dr = this.draining;
    if (dr && f.dt > 0) {
      dr.cav.open = Math.min(1, dr.cav.open + f.dt / DRAIN);
      this.pushCaverns();
      if (dr.cav.open >= 1) {
        this.draining = null;
        this.opened.add(dr.key);
        this.onOpened?.(dr.key);
        this.onGround?.();
      }
    }
    // the light of the nearest cavern's mineral, for the ground's shader and the stones'
    const glowU = this.u.uCavGlow?.value as THREE.Vector4 | undefined;
    let glowD = 150 * 150;
    if (glowU) glowU.w = 0;
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      const dx = s.x - px;
      const dz = s.z - pz;
      const d2 = dx * dx + dz * dz;
      if (s.light && glowU && d2 < glowD) {
        glowD = d2;
        glowU.copy(s.light);
      }
      // built out to DROP_R for hysteresis, but only drawn inside the build radius
      s.group.visible = d2 < (BUILD_R + 200) * (BUILD_R + 200);
      if (this.reached.has(s.key)) continue;
      if (d2 < s.reachR * s.reachR) {
        this.reached.add(s.key);
        if (this.onReach) this.onReach(s.kind);
      }
    }
  }

  private scan(px: number, pz: number, maxBuilds: number): void {
    // drop far sites
    for (let i = this.sites.length - 1; i >= 0; i--) {
      const s = this.sites[i];
      const dx = s.x - px;
      const dz = s.z - pz;
      if (dx * dx + dz * dz > DROP_R * DROP_R) {
        this.disposeSite(s);
        this.sites.splice(i, 1);
      }
    }
    const pcx = Math.floor(px / CELL);
    const pcz = Math.floor(pz / CELL);
    const span = Math.ceil(BUILD_R / CELL);
    if (this.scanCaverns(px, pz)) return;
    if (this.scanMassifs(px, pz)) return;
    for (let b = 0; b < maxBuilds; b++) {
      let best = Infinity;
      let bcx = 0;
      let bcz = 0;
      for (let dz = -span; dz <= span; dz++) {
        for (let dx = -span; dx <= span; dx++) {
          const cx = pcx + dx;
          const cz = pcz + dz;
          if (!this.cellSite(cx, cz)) continue;
          const ddx = this.cellPos.x - px;
          const ddz = this.cellPos.z - pz;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 > BUILD_R * BUILD_R || d2 >= best) continue;
          if (this.isBuilt(cellKey(cx, cz))) continue;
          best = d2;
          bcx = cx;
          bcz = cz;
        }
      }
      if (best === Infinity) return;
      this.buildSite(bcx, bcz);
    }
  }

  /**
   * Builds the nearest unbuilt find that belongs to a massif: a lantern on its summit and the
   * roof over its cave. Returns whether it built one.
   */
  private scanMassifs(px: number, pz: number): boolean {
    const w = this.world as Partial<{
      massif(gi: number, gj: number): Massif | null;
      cave(gi: number, gj: number): Cave | null;
      uncarved(x: number, z: number): number;
    }>;
    if (!w.massif || !w.cave || !w.uncarved) return false;
    const gi0 = Math.round(px / CITY_CELL);
    const gj0 = Math.round(pz / CITY_CELL);
    for (let gj = gj0 - 1; gj <= gj0 + 1; gj++) {
      for (let gi = gi0 - 1; gi <= gi0 + 1; gi++) {
        const m = w.massif(gi, gj);
        if (!m) continue;
        const id = (gi + 32768) * 65536 + (gj + 32768);
        const seed = Math.floor(hash4(gi, gj, this.world.seed | 0, 11) * 4294967296);
        const summitKey = -(id * 16 + 1);
        // (inside the build radius only: anything further is dropped again on the next scan)
        if (!this.isBuilt(summitKey) && Math.hypot(m.x - px, m.z - pz) < BUILD_R) {
          const ctx = new Ctx(this.world, m.x, m.z, this.world.height(m.x, m.z), mulberry32(seed), 0);
          ctx.stone.salt = id & 1023;
          buildLantern(ctx);
          this.finishSite(summitKey, 'summit', m.x, m.z, ctx.baseY, ctx);
          return true;
        }
        const caveKey = -(id * 16 + 2);
        const cv = w.cave(gi, gj)!;
        if (!this.isBuilt(caveKey) && Math.hypot(cv.x - px, cv.z - pz) < BUILD_R) {
          // the frame's u axis runs into the mountain
          const ctx = new Ctx(this.world, cv.x, cv.z, this.world.height(cv.x, cv.z), mulberry32(seed ^ 0x5f3a), Math.atan2(-cv.dz, cv.dx));
          ctx.stone.salt = (id * 7) & 1023;
          buildRoof(
            ctx,
            this.faceOf(ctx),
            (u) => ctx.g(u, 0),
            { half: TERRAIN.caveHalf, from: TERRAIN.caveRoofFrom - 2, len: TERRAIN.caveLen, height: TERRAIN.caveHeight },
          );
          buildCairn(ctx, TERRAIN.caveLen - 7, 0);
          this.finishSite(caveKey, 'cave', cv.x + cv.dx * TERRAIN.caveLen * 0.6, cv.z + cv.dz * TERRAIN.caveLen * 0.6, ctx.baseY, ctx);
          return true;
        }
        // the rock over each spring: the notch a river pours from becomes a cave mouth
        let springs = this.springCache.get(id);
        if (!springs) this.springCache.set(id, (springs = this.findSprings(m)));
        for (let k = 0; k < springs.length && k < 12; k++) {
          const sp = springs[k];
          const key = -(id * 16 + 3 + k);
          if (this.isBuilt(key) || Math.hypot(sp.x - px, sp.z - pz) >= BUILD_R) continue;
          const ctx = new Ctx(this.world, sp.x, sp.z, this.world.height(sp.x, sp.z), mulberry32(seed ^ (0x9a1 + k)), Math.atan2(-sp.dz, sp.dx));
          ctx.stone.salt = (id * 13 + k) & 1023;
          buildRoof(
            ctx,
            this.faceOf(ctx),
            (u) => ctx.g(u, 0),
            { half: sp.half, from: 0, len: sp.len, height: TERRAIN.springHeight },
          );
          this.caps.set(key, sp);
          this.finishSite(key, 'spring', sp.x, sp.z, ctx.baseY, ctx);
          return true;
        }
      }
    }
    return false;
  }

  /** The uncut rock at a point of a site's frame, for buildRoof: height, normal, rock and salt. */
  private faceOf(ctx: Ctx): (u: number, v: number, out: Face) => Face {
    const w = this.world as Partial<{ uncarved(x: number, z: number): number; uncarvedSample(x: number, z: number, out: SurfaceSample): SurfaceSample }>;
    const s: SurfaceSample = { h: 0, rock: 0, salt: 0 };
    return (u, v, out) => {
      ctx.at(u, v);
      const x = ctx.x + ctx.lx;
      const z = ctx.z + ctx.lz;
      w.uncarvedSample!(x, z, s);
      // The ground lights itself from normals taken across several metres (its heightmap), so
      // take the same broad slope here, or the cap would catch the light differently.
      const dx = (w.uncarved!(x + 4, z) - w.uncarved!(x - 4, z)) / 8;
      const dz = (w.uncarved!(x, z + 4) - w.uncarved!(x, z - 4)) / 8;
      const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      out.y = s.h - ctx.baseY;
      out.nx = -dx * inv;
      out.ny = inv;
      out.nz = -dz * inv;
      out.rock = s.rock;
      out.salt = s.salt;
      return out;
    };
  }

  /**
   * The springs at a massif's foot: for each place a river runs into the mountain, the middle
   * of the lip its water pours from, the direction the notch runs back into the rock, and how
   * far back the notch goes. The terrain makes these from noise, so they are found by sweeping
   * the mountain's foot for river water that is giving out. Done once per massif.
   */
  private findSprings(m: Massif): Spring[] {
    const out: Spring[] = [];
    const w = this.world;
    const s = this.bankSample;
    // On the water, the damp-ground value is how present the river still is: 1 in the open,
    // falling to 0 up the headwall. The lip of a notch is where it passes springLip.
    const present = (x: number, z: number) => w.sample(x, z, s).green ?? 0;
    const LIP = TERRAIN.springLip;

    // 1. Sweep the foot of the mountain for river water that is giving out.
    const R0 = m.r * 0.7;
    const R1 = m.r * 1.15;
    const G = 8;
    const hits: { x: number; z: number; n: number }[] = [];
    for (let x = m.x - R1; x <= m.x + R1; x += G) {
      for (let z = m.z - R1; z <= m.z + R1; z += G) {
        const r = Math.hypot(x - m.x, z - m.z);
        if (r < R0 || r > R1 || this.riverAt(x, z) > 7) continue;
        const g = present(x, z);
        if (g < LIP - 0.2 || g > LIP + 0.2) continue;
        const c = hits.find((h) => Math.hypot(h.x / h.n - x, h.z / h.n - z) < 70);
        if (c) {
          c.x += x;
          c.z += z;
          c.n++;
        } else hits.push({ x, z, n: 1 });
      }
    }

    for (const h of hits) {
      // 2. Settle on the middle of the lip: on the river's centre line, where the river is
      // just at the strength the lip is cut at.
      let x = h.x / h.n;
      let z = h.z / h.n;
      for (let pass = 0, span = 24, step = 4; pass < 3; pass++, span /= 4, step /= 4) {
        let best = Infinity;
        let bx = x;
        let bz = z;
        for (let ox = -span; ox <= span; ox += step) {
          for (let oz = -span; oz <= span; oz += step) {
            const rd = this.riverAt(x + ox, z + oz);
            if (rd > 10) continue;
            const cost = rd + 40 * Math.abs(present(x + ox, z + oz) - LIP);
            if (cost < best) {
              best = cost;
              bx = x + ox;
              bz = z + oz;
            }
          }
        }
        x = bx;
        z = bz;
      }
      if (this.riverAt(x, z) > 3 || Math.abs(present(x, z) - LIP) > 0.08) continue;
      if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 40)) continue;

      // 3. The notch runs back square to the cliff: the way the river thins out fastest.
      const gx = present(x + 3, z) - present(x - 3, z);
      const gz = present(x, z + 3) - present(x, z - 3);
      const gl = Math.hypot(gx, gz);
      let dx = (m.x - x) / Math.hypot(m.x - x, m.z - z);
      let dz = (m.z - z) / Math.hypot(m.x - x, m.z - z);
      if (gl > 0.01) {
        dx = -gx / gl;
        dz = -gz / gl;
      }
      // The notch itself follows the river, so where the river meets the cliff at a slant the
      // rock over it has to reach further to each side. Find the river's heading: the way
      // along its centre line that goes most nearly into the cliff.
      let cos = 0;
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * Math.PI * 2;
        const ex = Math.cos(a);
        const ez = Math.sin(a);
        if (this.riverAt(x + ex * 6, z + ez * 6) < 1.5) cos = Math.max(cos, ex * dx + ez * dz);
      }
      const skew = cos > 0.35 ? Math.sqrt(1 - cos * cos) / cos : 0;

      // 4. How far back the notch runs before its back wall.
      let len = 6;
      let h0 = w.height(x + dx * len, z + dz * len);
      for (; len < 30; len++) {
        const h1 = w.height(x + dx * (len + 1), z + dz * (len + 1));
        if (h1 - h0 > 4) break;
        h0 = h1;
      }
      // no back wall: the headwall is too low here for the notch to be a hollow worth roofing
      if (len >= 30) continue;
      out.push({ x, z, dx, dz, len, half: TERRAIN.springHalf + Math.min(10, skew * len) });
    }
    return out;
  }

  /**
   * The height of the rock ceiling over (x, z) where a spring's notch is capped, or Infinity.
   * Near the lip the rock face is lower than a ceiling's height above the floor, so it is open.
   */
  capCeil(x: number, z: number): number {
    for (const sp of this.caps.values()) {
      const ox = x - sp.x;
      const oz = z - sp.z;
      const u = ox * sp.dx + oz * sp.dz;
      if (u < 0 || u > sp.len + 1.5) continue;
      if (Math.abs(ox * -sp.dz + oz * sp.dx) > sp.half + 0.8) continue;
      const ceil = this.world.height(sp.x + sp.dx * u, sp.z + sp.dz * u) + TERRAIN.springHeight;
      const top = (this.world as Partial<{ uncarved(x: number, z: number): number }>).uncarved?.(x, z) ?? -Infinity;
      return top > ceil + 0.5 ? ceil : Infinity;
    }
    return Infinity;
  }

  /**
   * Top of the highest stone or bone over (x, z) that feet at height y are not underneath, or
   * -Infinity on open ground. solidKind then says what it is: 0 stone, 1 bone, 2 wood.
   */
  topAt(x: number, z: number, y: number): number {
    let top = -Infinity;
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      const so = s.solids;
      if (!so) continue;
      const dx = x - s.ox;
      const dz = z - s.oz;
      if (dx * dx + dz * dz > so.reach * so.reach) continue;
      const t = so.topAt(dx, dz, y - s.oy) + s.oy;
      if (t > top) {
        top = t;
        this.solidKind = so.kind;
      }
    }
    return top;
  }
  solidKind: SolidKind = 0;

  /** Underside of the lowest stone or bone that feet at height y are beneath, or Infinity under open sky. */
  ceilAt(x: number, z: number, y: number): number {
    let ceil = Infinity;
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      const so = s.solids;
      if (!so) continue;
      const dx = x - s.ox;
      const dz = z - s.oz;
      if (dx * dx + dz * dz > so.reach * so.reach) continue;
      ceil = Math.min(ceil, so.ceilAt(dx, dz, y - s.oy) + s.oy);
    }
    return ceil;
  }

  /** Whether (x, z) is within reach of any site's stones, give or take a margin. */
  nearSolids(x: number, z: number, margin: number): boolean {
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      if (s.solids && Math.hypot(x - s.ox, z - s.oz) < s.solids.reach + margin) return true;
    }
    return false;
  }

  /** Surface height of an oasis pool over (x, z), or -Infinity where there is none. */
  poolAt(x: number, z: number): number {
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      for (const p of s.pools) {
        const dx = x - p.x;
        const dz = z - p.z;
        if (dx * dx + dz * dz < p.r * p.r) return p.y;
      }
    }
    return -Infinity;
  }

  /** Distance to the nearest river, if this world has rivers. */
  private riverAt(x: number, z: number): number {
    const river = (this.world as Partial<{ river(x: number, z: number): number }>).river;
    return river ? river(x, z) : Infinity;
  }

  /**
   * The nearest spot on a riverbank to (x, z), written to cellPos, or false if there is none:
   * damp ground a little back from the water, where the river has not faded out.
   */
  private bankNear(x: number, z: number): boolean {
    let best = Infinity;
    for (let r = 0; r <= GROVE_REACH + 40; r += 12) {
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        const tx = x + Math.cos(a) * r;
        const tz = z + Math.sin(a) * r;
        const rd = this.riverAt(tx, tz);
        if (rd < 20 || rd > 38 || r >= best) continue;
        const sm = this.world.sample(tx, tz, this.bankSample);
        if ((sm.green ?? 0) < 0.6 || sm.rock > 0.3) continue;
        best = r;
        this.cellPos.x = tx;
        this.cellPos.z = tz;
      }
      if (best < Infinity) return true;
    }
    return false;
  }

  private buildSite(cx: number, cz: number): void {
    this.cellSite(cx, cz);
    let x = this.cellPos.x;
    let z = this.cellPos.z;
    const w = this.world;
    const rng = mulberry32(Math.floor(hash4(cx, cz, w.seed | 0, 7) * 4294967296));
    const s = w.sample(x, z, this.sample);
    const h = s.h;
    let mean = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      mean += w.height(x + Math.cos(a) * 250, z + Math.sin(a) * 250);
    }
    mean /= 8;
    const r = rng();
    let kind: string;
    if (this.riverAt(x, z) < GROVE_REACH && this.bankNear(x, z)) {
      kind = 'grove';
      x = this.cellPos.x;
      z = this.cellPos.z;
    } else if (s.rock > 0.45) kind = r < 0.45 ? 'arch' : r < 0.75 ? 'balancing-stones' : r < 0.9 ? 'lantern' : 'standing-stones';
    else if (s.salt > 0.35) kind = r < 0.4 ? 'standing-stones' : r < 0.7 ? 'sundial' : r < 0.85 ? 'lantern' : 'bones';
    else if (h < mean - 4 && r < 0.6) kind = 'oasis';
    else {
      const q = rng();
      kind =
        q < 0.22 ? 'ruins'
        : q < 0.42 ? 'bones'
        : q < 0.56 ? 'shell'
        : q < 0.7 ? 'standing-stones'
        : q < 0.84 ? 'lantern'
        : q < 0.92 && h < mean + 2 ? 'oasis'
        : 'sundial';
    }
    if (kind === 'oasis') {
      // settle into the lowest nearby ground
      let bh = w.height(x, z);
      let bx = x;
      let bz = z;
      for (let i = -3; i <= 3; i++) {
        for (let j = -3; j <= 3; j++) {
          const tx = x + i * 45;
          const tz = z + j * 45;
          const th = w.height(tx, tz);
          if (th < bh) {
            bh = th;
            bx = tx;
            bz = tz;
          }
        }
      }
      x = bx;
      z = bz;
    }
    const baseY = w.height(x, z);
    const ctx = new Ctx(w, x, z, baseY, rng, rng() * Math.PI * 2);
    ctx.stone.salt = (cx * 31 + cz * 17) & 1023;
    const onSalt = s.salt > 0.35;
    switch (kind) {
      case 'ruins': buildRuins(ctx); break;
      case 'oasis': buildOasis(ctx); break;
      case 'grove': {
        // bearing to the water, and a test for the damp bank, both in the site's own frame
        let toWater = 0;
        let near = Infinity;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          ctx.at(Math.cos(a) * 14, Math.sin(a) * 14);
          const rd = this.riverAt(x + ctx.lx, z + ctx.lz);
          if (rd < near) {
            near = rd;
            toWater = a;
          }
        }
        const onBank = (u: number, v: number): boolean => {
          ctx.at(u, v);
          const rd = this.riverAt(x + ctx.lx, z + ctx.lz);
          return rd > TERRAIN.riverHalf + 2 && rd < TERRAIN.riverFloor + 6;
        };
        buildGrove(ctx, onBank, toWater);
        break;
      }
      case 'arch': buildArch(ctx); break;
      case 'balancing-stones': buildBalancing(ctx); break;
      case 'standing-stones': buildStones(ctx, onSalt); break;
      case 'bones': buildBones(ctx); break;
      case 'lantern': buildLantern(ctx); break;
      case 'sundial': buildSundial(ctx, onSalt); break;
      default: buildShell(ctx); break;
    }
    this.finishSite(cellKey(cx, cz), kind, x, z, baseY, ctx);
  }

  /** Turns what a builder made into meshes and records the site. */
  private finishSite(key: number, kind: string, x: number, z: number, baseY: number, ctx: Ctx): void {

    const group = new THREE.Group();
    group.name = `site:${kind}`;
    group.position.set(ctx.x, baseY, ctx.z); // (x, z) is where the site counts as reached, which a cave puts inside it
    const sg = ctx.stone.build();
    if (sg) group.add(new THREE.Mesh(sg, this.stoneMat));
    const rg = ctx.rock.build();
    if (rg) group.add(new THREE.Mesh(rg, this.rockMat));
    const fg = ctx.fronds.build();
    if (fg) group.add(new THREE.Mesh(fg, this.frondMat));
    const pools: Site['pools'] = [];
    for (const p of ctx.pools) {
      ctx.at(p.u ?? 0, p.v ?? 0);
      const wg = new THREE.CircleGeometry(p.r, 56).rotateX(-Math.PI / 2).translate(ctx.lx, p.y, ctx.lz);
      group.add(new THREE.Mesh(wg, p.under ? this.underWaterMat : this.waterMat));
      pools.push({ y: baseY + p.y, r: p.r, x: ctx.x + ctx.lx, z: ctx.z + ctx.lz });
    }
    if (ctx.shafts.length > 0) {
      const n = ctx.shafts.length / 4;
      const pos = new Float32Array(n * 3);
      const fade = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        pos.set(ctx.shafts.slice(i * 4, i * 4 + 3), i * 3);
        fade[i] = ctx.shafts[i * 4 + 3];
      }
      const sg2 = new THREE.BufferGeometry();
      sg2.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      sg2.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
      const sm = new THREE.Mesh(sg2, this.shaftMat);
      sm.renderOrder = 9;
      group.add(sm);
    }
    let relic: Site['relic'];
    if (ctx.relic) {
      // the relic is its own small thing, so it can be lifted off its stone
      const [rx, ry, rz] = ctx.relic;
      const rb = new StoneBuilder();
      rb.set(1, 1, 1, 3, 0);
      rb.geo(RELIC_GEO, _m.makeTranslation(rx, ry, rz));
      const obj = new THREE.Group();
      obj.add(new THREE.Mesh(rb.build()!, this.stoneMat));
      const gm = this.glowMesh([rx, ry, rz, 0.9, rx, ry, rz, 3.2], this.relicGlowMat);
      obj.add(gm);
      group.add(obj);
      relic = { x: ctx.x + rx, y: baseY + ry, z: ctx.z + rz, obj };
    }
    if (ctx.veins.length > 0) group.add(this.glowMesh(ctx.veins, this.veinMat));
    if (ctx.glows.length > 0) group.add(this.glowMesh(ctx.glows, this.glowMat));
    this.group.add(group);
    this.sites.push({
      key,
      x,
      z,
      kind,
      group,
      reachR: Math.max(25, ctx.foot * 0.6 + 15),
      ox: ctx.x,
      oy: baseY,
      oz: ctx.z,
      solids: ctx.solids.count > 0 ? ctx.solids : null,
      pools,
      light: ctx.light ? new THREE.Vector4(ctx.x + ctx.light[0], baseY + ctx.light[1], ctx.z + ctx.light[2], ctx.light[3]) : undefined,
      relic,
    });
  }

  /** Soft additive discs that always face the camera, one per (x, y, z, size) in `list`. */
  private glowMesh(list: number[], mat: THREE.ShaderMaterial): THREE.Mesh {
    {
      const n = list.length / 4;
      const pos = new Float32Array(n * 12);
      const corner = new Float32Array(n * 8);
      const size = new Float32Array(n * 4);
      const index: number[] = [];
      const cs = [-1, -1, 1, -1, 1, 1, -1, 1];
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 4; k++) {
          pos[i * 12 + k * 3] = list[i * 4];
          pos[i * 12 + k * 3 + 1] = list[i * 4 + 1];
          pos[i * 12 + k * 3 + 2] = list[i * 4 + 2];
          corner[i * 8 + k * 2] = cs[k * 2];
          corner[i * 8 + k * 2 + 1] = cs[k * 2 + 1];
          size[i * 4 + k] = list[i * 4 + 3];
        }
        const o = i * 4;
        index.push(o, o + 1, o + 2, o, o + 2, o + 3);
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      gg.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
      gg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      gg.setIndex(index);
      const gm = new THREE.Mesh(gg, mat);
      gm.frustumCulled = false;
      gm.renderOrder = 10;
      return gm;
    }
  }

  private disposeSite(s: Site): void {
    this.group.remove(s.group);
    this.caps.delete(s.key);
    s.group.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
    });
  }

  /** Frees everything, including the shared materials. */
  dispose(): void {
    for (const s of this.sites) this.disposeSite(s);
    this.sites.length = 0;
    this.stoneMat.dispose();
    this.rockMat.dispose();
    this.waterMat.dispose();
    this.frondMat.dispose();
    this.glowMat.dispose();
    this.veinMat.dispose();
    this.relicGlowMat.dispose();
    this.shaftMat.dispose();
    this.underWaterMat.dispose();
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}
