// Rare things to stumble on: ruins, oases, arches, standing stones, great bones,
// lantern towers, sundial plazas and half-buried shells. Placement is a
// deterministic jittered grid (675 m cells, about one in three occupied); sites
// are built lazily near the player and disposed when far away.
import * as THREE from 'three';
import type { FrameState, SurfaceSample, Uniforms, World } from '../game/contract';
import { WORLD_SCALE } from './scale';
import { STYLE_GLSL } from '../render/styleGlsl';
import { TERRAIN, type Cave, type Massif } from './surface';
import { CITY_CELL } from '../city/placement';

const CELL = 900 * WORLD_SCALE;
const MARGIN = 150; // keeps sites at least 300 m apart
const SITE_P = 0.34;
const BUILD_R = 2500;
const DROP_R = 3500;
const SCAN_EVERY = 0.3;
const GROVE_P = 0.7; // chance an otherwise empty cell beside a river holds a grove
const GROVE_REACH = 260; // metres from a river that counts as beside it

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

// kinds: 0 rock palette, 1 pale (salt palette: bone, shell), 2 sand palette (wood, damp sand, shrubs), 3 lantern light
const stoneFrag = /* glsl */ `
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
  float l = styleBands(smoothstep(-0.12, 0.42, dot(n, uSunDir)), vW.xz);
  vec3 sh = uShade;
  vec3 li = uLit;
  if (vKind < 0.5) { sh = uRockShade; li = uRockLit; }
  else if (vKind < 1.5) { sh = mix(uRockShade, uSaltShade, 0.7); li = uSaltLit; }
  vec3 col = mix(sh, li, l * 0.9);
  float m = dvn(vW.xz * 0.45 + vec2(vW.y * 0.6, -vW.y * 0.3)) * 0.6 + dvn(vW.xz * 1.7 + vW.y) * 0.4;
  col *= vTint * (0.88 + 0.24 * m);
  col += (uTop - col) * 0.06 * max(n.y, 0.0) * (1.0 - l);
  float dist = length(vW - cameraPosition);
  float fogA = 1.0 - exp(-dist * uFog);
  if (vKind > 2.5) {
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
varying vec2 vUv;
varying float vDist;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 5.0) * (1.0 - r2);
  float flick = 0.94 + 0.06 * sin(uTime * 3.1) * sin(uTime * 4.7 + 1.3);
  float k = (0.12 + 0.88 * smoothstep(0.1, 0.8, uNight)) * flick;
  float fogA = (1.0 - exp(-vDist * uFog)) * 0.45;
  vec3 col = vec3(1.0, 0.72, 0.38) * a * k * (1.0 - fogA);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ------------------------------------------------------------------ geometry builders

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1, 2, 3, 2);
const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
const UNIT_SLAB = new THREE.CylinderGeometry(0.4, 0.5, 1, 4, 3).rotateY(Math.PI / 4).scale(1.414, 1, 1.414);
const UNIT_BLOB = new THREE.IcosahedronGeometry(1, 1);
const UNIT_CONE = new THREE.ConeGeometry(1, 1, 4);

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

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
    this.kind.push(this.k);
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

/** Builds a site in a rotated (u along, v across) frame; y is relative to the site's base height. */
class Ctx {
  readonly stone = new StoneBuilder();
  readonly fronds = new FrondBuilder();
  readonly pools: { y: number; r: number }[] = [];
  readonly glows: number[] = []; // x, y, z, size
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
    c.prim(UNIT_BLOB, u, c.g(u, v) + s * 0.25, v, s * 1.3, s * 0.7, s * 1.2, c.rng() * 6);
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
    c.prim(UNIT_BLOB, u, c.g(u, v) + s * 0.25, v, s * 1.3, s * 0.7, s * 1.2, c.rng() * 6);
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

/**
 * The rock over a cave. The terrain cuts the cave as an open slot; this caps it, from where the
 * mountain stands a ceiling's height above the floor to the back wall. The frame's u axis runs
 * into the mountain from the mouth. top gives the mountainside as it would be uncut, and floor
 * the cave floor, both relative to the site's base.
 */
function buildCaveRoof(c: Ctx, top: (u: number, v: number) => number, floor: (u: number) => number): void {
  const st = c.stone;
  const HALF = TERRAIN.caveHalf + 2.6;
  const NV = 6;
  const STEP = 2.5;
  const u0 = TERRAIN.caveRoofFrom - 2;
  const NU = Math.ceil((TERRAIN.caveLen + 4 - u0) / STEP);
  c.foot = TERRAIN.caveLen;
  const P = new THREE.Vector3();
  const put = (u: number, v: number, y: number) => {
    c.at(u, v);
    P.set(c.lx, y, c.lz);
    st.vert(P.x, P.y, P.z);
  };
  const topY = (u: number, v: number) => top(u, v) + 0.35;
  // the underside is level across the cave, and never above the mountainside
  const lowY = (u: number, v: number) => Math.min(floor(u) + TERRAIN.caveHeight, topY(u, v) - 0.5);
  for (let i = 0; i < NU; i++) {
    const ua = u0 + i * STEP;
    const ub = ua + STEP;
    for (let j = 0; j < NV; j++) {
      const va = -HALF + (j / NV) * 2 * HALF;
      const vb = -HALF + ((j + 1) / NV) * 2 * HALF;
      const k = c.r(0.9, 1.06);
      // the mountainside over the cave
      st.set(0.84 * k, 0.72 * k, 0.58 * k, 0, 0.12);
      put(ua, va, topY(ua, va)); put(ua, vb, topY(ua, vb)); put(ub, va, topY(ub, va));
      put(ub, va, topY(ub, va)); put(ua, vb, topY(ua, vb)); put(ub, vb, topY(ub, vb));
      // the ceiling
      st.set(0.5 * k, 0.38 * k, 0.3 * k, 0, 0.3);
      put(ua, va, lowY(ua, va)); put(ub, va, lowY(ub, va)); put(ua, vb, lowY(ua, vb));
      put(ub, va, lowY(ub, va)); put(ub, vb, lowY(ub, vb)); put(ua, vb, lowY(ua, vb));
      // the brow over the mouth
      if (i === 0) {
        st.set(0.62 * k, 0.47 * k, 0.37 * k, 0, 0.1);
        put(ua, va, lowY(ua, va)); put(ua, vb, lowY(ua, vb)); put(ua, va, topY(ua, va));
        put(ua, va, topY(ua, va)); put(ua, vb, lowY(ua, vb)); put(ua, vb, topY(ua, vb));
      }
    }
  }
  buildCairn(c, TERRAIN.caveLen - 7, 0);
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
  c.tube(spineLocal, sr, 6, true);
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
      c.prim(UNIT_BOX, u, g - 0.15 - sink, v, step * 0.94, 0.6, step * 0.94, c.r(-0.03, 0.03), c.r(-0.04, 0.04), c.r(-0.04, 0.04));
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

// ------------------------------------------------------------------ the system

interface Site {
  key: number;
  x: number;
  z: number;
  kind: string;
  group: THREE.Group;
  reachR: number;
}

export class Discoveries {
  readonly group = new THREE.Group();
  /** Called (at most once per site) when the player first comes within ~25 m of a site. */
  onReach: ((kind: string) => void) | null = null;

  private readonly world: World;
  private readonly stoneMat: THREE.ShaderMaterial;
  private readonly waterMat: THREE.ShaderMaterial;
  private readonly frondMat: THREE.ShaderMaterial;
  private readonly glowMat: THREE.ShaderMaterial;
  private readonly sites: Site[] = [];
  private readonly reached = new Set<number>();
  private readonly sample: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private readonly cellPos = { x: 0, z: 0 };
  private readonly bankSample: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private scanT = 0;

  constructor(world: World, uniforms: Uniforms) {
    this.world = world;
    this.group.name = 'discoveries';
    this.stoneMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms },
      vertexShader: stoneVert,
      fragmentShader: stoneFrag,
      side: THREE.DoubleSide,
    });
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms },
      vertexShader: waterVert,
      fragmentShader: waterFrag,
    });
    this.frondMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms },
      vertexShader: frondVert,
      fragmentShader: frondFrag,
      side: THREE.DoubleSide,
    });
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms },
      vertexShader: glowVert,
      fragmentShader: glowFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
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
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      const dx = s.x - px;
      const dz = s.z - pz;
      const d2 = dx * dx + dz * dz;
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
        const summitKey = -(id * 2 + 1);
        // (inside the build radius only: anything further is dropped again on the next scan)
        if (!this.isBuilt(summitKey) && Math.hypot(m.x - px, m.z - pz) < BUILD_R) {
          const ctx = new Ctx(this.world, m.x, m.z, this.world.height(m.x, m.z), mulberry32(seed), 0);
          ctx.stone.salt = id & 1023;
          buildLantern(ctx);
          this.finishSite(summitKey, 'summit', m.x, m.z, ctx.baseY, ctx);
          return true;
        }
        const caveKey = -(id * 2 + 2);
        const cv = w.cave(gi, gj)!;
        if (!this.isBuilt(caveKey) && Math.hypot(cv.x - px, cv.z - pz) < BUILD_R) {
          // the frame's u axis runs into the mountain
          const ctx = new Ctx(this.world, cv.x, cv.z, this.world.height(cv.x, cv.z), mulberry32(seed ^ 0x5f3a), Math.atan2(-cv.dz, cv.dx));
          ctx.stone.salt = (id * 7) & 1023;
          const uncarved = w.uncarved;
          buildCaveRoof(
            ctx,
            (u, v) => {
              ctx.at(u, v);
              return uncarved(cv.x + ctx.lx, cv.z + ctx.lz) - ctx.baseY;
            },
            (u) => ctx.g(u, 0),
          );
          this.finishSite(caveKey, 'cave', cv.x + cv.dx * TERRAIN.caveLen * 0.6, cv.z + cv.dz * TERRAIN.caveLen * 0.6, ctx.baseY, ctx);
          return true;
        }
      }
    }
    return false;
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
    const fg = ctx.fronds.build();
    if (fg) group.add(new THREE.Mesh(fg, this.frondMat));
    for (const p of ctx.pools) {
      const wg = new THREE.CircleGeometry(p.r, 56).rotateX(-Math.PI / 2).translate(0, p.y, 0);
      group.add(new THREE.Mesh(wg, this.waterMat));
    }
    if (ctx.glows.length > 0) {
      const n = ctx.glows.length / 4;
      const pos = new Float32Array(n * 12);
      const corner = new Float32Array(n * 8);
      const size = new Float32Array(n * 4);
      const index: number[] = [];
      const cs = [-1, -1, 1, -1, 1, 1, -1, 1];
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 4; k++) {
          pos[i * 12 + k * 3] = ctx.glows[i * 4];
          pos[i * 12 + k * 3 + 1] = ctx.glows[i * 4 + 1];
          pos[i * 12 + k * 3 + 2] = ctx.glows[i * 4 + 2];
          corner[i * 8 + k * 2] = cs[k * 2];
          corner[i * 8 + k * 2 + 1] = cs[k * 2 + 1];
          size[i * 4 + k] = ctx.glows[i * 4 + 3];
        }
        const o = i * 4;
        index.push(o, o + 1, o + 2, o, o + 2, o + 3);
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      gg.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
      gg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      gg.setIndex(index);
      const gm = new THREE.Mesh(gg, this.glowMat);
      gm.frustumCulled = false;
      gm.renderOrder = 10;
      group.add(gm);
    }
    this.group.add(group);
    this.sites.push({
      key,
      x,
      z,
      kind,
      group,
      reachR: Math.max(25, ctx.foot * 0.6 + 15),
    });
  }

  private disposeSite(s: Site): void {
    this.group.remove(s.group);
    s.group.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
    });
  }

  /** Frees everything, including the shared materials. */
  dispose(): void {
    for (const s of this.sites) this.disposeSite(s);
    this.sites.length = 0;
    this.stoneMat.dispose();
    this.waterMat.dispose();
    this.frondMat.dispose();
    this.glowMat.dispose();
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}
