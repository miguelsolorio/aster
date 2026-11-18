// Rare things to stumble on: tended temples, ruins, oases, arches, standing stones, great bones,
// lantern towers, sundial plazas, half-buried shells, and in the otherwise empty cells small empty hamlets (about half of them)
// and lone watchtowers (a fifth). Each massif has villages at its foot besides. Placement is a
// deterministic jittered grid (675 m cells, about one in three occupied); sites
// are built lazily near the player and disposed when far away.
import * as THREE from 'three';
import type { FrameState, SurfaceSample, Uniforms, World } from '../game/contract';
import { WORLD_SCALE } from './scale';
import { STYLE_GLSL } from '../render/styleGlsl';
import { MAX_CAVERNS, TERRAIN, writeCaverns, type Cave, type Cavern, type DesertWorld, type Massif } from './surface';
import { rockCapVert, terrainFrag } from '../render/terrainShaders';
import { CITY_CELL } from '../city/placement';
import { Solids, type SolidKind } from './solids';
import { createDeep } from './deep/index';
import { frostLayout, frostRegion, frostCover, frostWayMarks, type FrostLayout, type FrostPoint, type FrostRegion } from './frost';
import { footVillages, type FootVillage } from './foothills';
import { footVillageFolk, snowVillageFolk, type FolkMark, type FolkRole } from './villagers';
import { CHOSEN, bedrollGeometry, bootGeometry, carpetGeometry, featherGeometry, chartGeometry, fluteGeometry, rodGeometry, ropeCoilGeometry, rugMaterial, solidMaterial } from '../game/equipment';
import type { Offering } from '../game/offerings';
import { isFindKind } from '../game/finds';
import { DEEP_HOLE, type Deep, type DeepKind, type DeepSpec } from './deep/types';
import { type Lead, leadPoint } from './lead';
import { isSettlement } from './settlementKinds';
import { settle, type SettleWorld } from './settle';
import { buildSettlement, type Kit } from './settlements';
import { RouteNet, routePos, type TravelRoute } from '../city/routes';

const CELL = 900 * WORLD_SCALE;
const MARGIN = 150; // keeps sites at least 300 m apart
const SITE_P = 0.34;
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const DRAW_R = 2500; // a find is drawn inside this of the eye, dissolving in over the last FADE metres
const FADE = 220;
// Finds are built further out than they are drawn, and around the point the wanderer is heading
// for rather than under their feet: BUILD_R - LEAD_MAX is still DRAW_R, so whatever is near enough
// to draw is built whichever way they turn, and at a carpet's speed there are some eight seconds
// to build what lies ahead before it starts to show.
const BUILD_R = 2800;
const LEAD_S = 5;
const LEAD_MAX = BUILD_R - DRAW_R;
const SCAN_MS = 4; // the most a scan spends building before it leaves the rest to the next frame
const DROP_R = 3500;
const SCAN_EVERY = 0.3;
const GROVE_P = 0.7; // chance an otherwise empty cell beside a river holds a grove
const HAMLET_P = 0.5; // chance an otherwise empty cell (away from rivers) holds a hamlet
const TOWER_P = 0.2; // and the chance it holds a lone watchtower instead
const SETTLE_P = 0.22; // or one of the settlements people live in, whichever suits the ground (see settle.ts)
const RIVER_SETTLE_P = 0.6; // the chance an otherwise empty cell beside a river holds one: a bridge, or the dyers
const INN_AT = [0.5, 0.42, 0.58, 0.34, 0.66]; // where along a route its caravanserai is tried, as shares of its length
const INN_OFF = 44; // how far off the route's centre line it stands (m)
const INN_EDGE = 100; // and how far inside its cell, so as to keep off the neighbours' finds (m)
const VILLAGE_KEY = -4e12; // the keys of the mountain villages count down from here: four to a massif
const VILLAGE_CITY_CLEAR = 450; // a mountain village keeps this far outside a city (m)
const VILLAGE_REACH = 1.25; // no village stands further from its massif's centre than this many radii
const NO_VILLAGES: FootVillage[] = [];
const GROVE_REACH = 260; // metres from a river that counts as beside it
const CAVERN_P = 1; // chance a cell hides a cavern where the ground suits one: measured, about one cell in two ends up with one (most of the rest are rock, salt or river)
const CAVERN_BUILD_R = 900; // an open cavern's roof is built inside this
const DEEP_BUILD_R = 500; // and the deep under it inside this of its hole
const DEEP_DROP_R = 900; // a deep is let go beyond this (never while the wanderer is in it)
const DEEP_MAX = 2; // how many deeps exist at once
const DEEP_MIN = 280; // the room a deep is given, each way (m)
const DEEP_MAX_ROOM = 360;
const SPOTS = 64; // places in a cell where an entrance is tried (there were 24: the later ones are dealt from salts of their own)
const ROOMS_MAX = 16; // rooms measured for a cell before it is given up on
const CITY_CLEAR = 700; // an entrance keeps this far outside a city (m)
const RIVER_CLEAR = 170; // an entrance keeps this far from a river (m)
const SITE_CLEAR = 320; // and this far from the find its cell has on the surface, wherever that settles
const SITE_CLEAR_NEAR = 180; // or, where nothing else in the cell will do, this far
const LID_MARGIN = 4; // rock left between the top of a deep and the lowest ground over it (m)
const LID_DEEPEST = -45; // a site whose deep would have to start further down than this is passed over
const HOLLOW_R = 30; // a strike sounds hollow within this of a sealed cavern (m)
const DIG_R = 4.5; // and counts toward breaking through within this of the spot
const DIG_HITS = 4; // strikes on the spot before the sand gives way
const DRAIN = 4.5; // seconds the sand takes to run out
const LAMP_KEY = -7; // the site keys of the miner's lost lamps count down from here (massif finds are far below)
// The keys of the wrecks a storm uncovers count down from here, worked out from where each lies
// (so a wreck keeps its key across visits): under every key the cells, caverns, frostland and
// massifs use (those reach down to about -4.1e12), and above -Number.MAX_SAFE_INTEGER.
const WRECK_KEY = -6e12;
/** Metres round a wreck's middle that it keeps clear of other things (her keel runs to about 44 m). */
const WRECK_CLEAR = 32;

/** A wreck in the world, as setWrecks was given it, with the key its site is built under. */
interface WreckAt {
  x: number;
  z: number;
  rot: number;
  key: number;
}
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

// At the far edge of what is drawn a find dissolves into view rather than appearing all at once
// (as the props do at theirs). Declares `dist`, the distance from the eye.
const DISSOLVE = /* glsl */ `float dist = length(vW - cameraPosition);
  if (dist > ${DRAW_R.toFixed(1)} - ${FADE.toFixed(1)} * dh21(gl_FragCoord.xy)) discard;`;

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
uniform vec3 uCavGlowCol;
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
  ${DISSOLVE}
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
  float fogA = 1.0 - exp(-dist * uFog);
  if (dark > 0.5) {
    // in a cavern: nearly black, lit only by what glows there (as the rock around it is)
    col *= 0.2;
    if (uCavGlow.w > 0.0) {
      vec3 gd = uCavGlow.xyz - vW;
      float g2 = dot(gd, gd);
      float ga = 1.0 / (1.0 + g2 / (0.16 * uCavGlow.w * uCavGlow.w));
      ga *= 0.45 + 0.55 * max(dot(n, gd * inversesqrt(g2 + 1e-3)), 0.0);
      col += uCavGlowCol * vTint * (0.85 * ga);
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
  ${DISSOLVE}
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
${NOISE}
${STYLE_GLSL}
void main() {
  ${DISSOLVE}
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  n = styleFacet(n, vW);
  float l = styleBands(smoothstep(-0.2, 0.5, dot(n, uSunDir)), vW.xz);
  vec3 sh = uShade * vec3(0.42, 0.52, 0.34);
  vec3 li = uLit * vec3(0.46, 0.6, 0.3);
  vec3 col = mix(sh, li, l) * vK;
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
  // a light comes up out of the haze where the thing it burns on dissolves into view
  k *= 1.0 - smoothstep(${(DRAW_R - FADE).toFixed(1)}, ${DRAW_R.toFixed(1)}, vDist);
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
// Plain versions for small things nobody stands on (beam ends, flags, jars): a sixth of the triangles.
const UNIT_BIT = new THREE.BoxGeometry(1, 1, 1);
const UNIT_PEBBLE = new THREE.IcosahedronGeometry(1, 0);
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
  /** A temple's marks, local: the stair's foot, the avenue's end, the way out, and where keepers stand (x, y, z, yaw). */
  temple: { foot: [number, number, number]; end: [number, number, number]; yaw: number; keep: [number, number, number, number][]; offer: [number, number, number] } | null = null;
  /** A village's people: where each stands, in the site's frame. */
  folk: FolkMark[] | null = null;
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
    if (geo === UNIT_BLOB || geo === UNIT_PEBBLE) this.solids.addPrim('ball', _m, _mi, kind);
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

/**
 * A small cairn with a lantern on it: what waits at the back of a cave, and what marks the road
 * up the mountain. `halo` is how far its light carries; `snow` (0..1) lays snow on its cap.
 */
function buildCairn(c: Ctx, u: number, v: number, halo = 6, snow = 0): void {
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
  c.glow(u, y + 0.38, v, halo);
  if (snow > 0.35) {
    st.set(1.22, 1.24, 1.28, 1, 0.06);
    c.solid = false;
    c.prim(UNIT_BLOB, u, y + 0.82, v, 0.36, 0.2, 0.36, c.rng() * 6);
    c.solid = true;
  }
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

// ------------------------------------------------------------------ mud-brick settlements

/** Cloth for awnings, pennants and bunting, as tints of the pale palette. */
const CLOTH: [number, number, number][] = [
  [1.18, 0.4, 0.3], // madder red
  [0.3, 0.44, 0.78], // indigo
  [1.25, 0.86, 0.3], // saffron
  [0.32, 0.72, 0.66], // teal
  [1.15, 1.1, 1.0], // undyed
];
const WOOD: [number, number, number] = [0.46, 0.33, 0.23];
const DARK: [number, number, number] = [0.16, 0.12, 0.1];

function clothTint(c: Ctx, k: number): void {
  const t = CLOTH[((k % CLOTH.length) + CLOTH.length) % CLOTH.length];
  c.stone.set(t[0], t[1], t[2], 1, 0.02);
}

interface House {
  /** Height of its floor and of its roof (relative to the site's base). */
  floor: number;
  top: number;
  /** Frame point at local (x along the house, z across it toward the door when positive * face). */
  at: (lx: number, lz: number) => [number, number];
}

/**
 * A mud-brick house of the desert's own kind, standing level on a plinth however the ground lies:
 * beam ends under the parapet, a doorway with a timber lintel, deep window slots that glow at
 * night, and one of four roofs. (hu, hv) is its middle in the site's frame, `ang` the bearing its
 * long side runs along, `face` the side (+1 or -1 along the normal) its door looks out of.
 */
function mudHouse(c: Ctx, hu: number, hv: number, ang: number, face: number, w: number, d: number, wallH: number, wt: number): House {
  const st = c.stone;
  const Tx = Math.cos(ang);
  const Tz = Math.sin(ang);
  const Nx = -Tz;
  const Nz = Tx;
  const ry = -ang;
  const at = (lx: number, lz: number): [number, number] => [hu + Tx * lx + Nx * lz, hv + Tz * lx + Nz * lz];
  let lo = Infinity;
  let hi = -Infinity;
  for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2], [0, 0]] as const) {
    const [u, v] = at(lx, lz);
    const gh = c.g(u, v);
    lo = Math.min(lo, gh);
    hi = Math.max(hi, gh);
  }
  // the floor is a step above the ground at the door; on a slope the back of the house is dug in
  const gDoor = c.g(...at(0, face * (d / 2 + 0.9)));
  const floor = Math.max(gDoor + 0.2, hi - 1.3);
  // footing: a battered plinth of darker brick
  st.set(wt * 0.86, wt * 0.82, wt * 0.74, 2, 0.08);
  c.prim(UNIT_BOX, hu, (lo - 1.2 + floor) / 2, hv, w + 0.9, floor - lo + 1.2, d + 0.9, ry);
  // walls, and the parapet lip round a flat roof
  st.set(wt, wt * 0.96, wt * 0.87, 2, 0.06);
  c.prim(UNIT_BOX, hu, floor + wallH / 2, hv, w, wallH, d, ry);
  c.prim(UNIT_BOX, hu, floor + wallH + 0.12, hv, w + 0.45, 0.5, d + 0.45, ry);
  const top = floor + wallH + 0.37;
  // the ends of the roof beams, standing out of the wall front and back
  st.set(WOOD[0], WOOD[1], WOOD[2], 2, 0.02);
  c.solid = false;
  const nb = Math.max(3, Math.round(w / 1.25));
  for (let i = 0; i < nb; i++) {
    const lx = -w / 2 + 0.6 + (i / (nb - 1)) * (w - 1.2);
    for (const s of [-1, 1]) {
      const [u, v] = at(lx, s * (d / 2 + 0.22));
      c.prim(UNIT_BIT, u, floor + wallH - 0.5, v, 0.2, 0.2, 0.55, ry);
    }
  }
  c.solid = true;
  const style = c.rng();
  if (style < 0.26) {
    // a dome
    const rd = Math.min(w, d) * 0.4;
    const [u, v] = at(-w * 0.08, 0);
    st.set(wt * 1.03, wt * 0.99, wt * 0.9, 2, 0.05);
    c.prim(UNIT_BLOB, u, top - 0.25, v, rd, rd * 0.82, rd, c.rng() * 6);
    c.solid = false;
    c.prim(UNIT_CYL, u, top + rd * 0.78, v, 0.12, 0.5, 0.12);
    c.solid = true;
  } else if (style < 0.56) {
    // a second, smaller storey set back from the door, with its own toothed parapet and a window
    const w2 = w * 0.55;
    const d2 = d * 0.62;
    const lx2 = (c.rng() < 0.5 ? -1 : 1) * w * 0.2;
    const [u, v] = at(lx2, -face * d * 0.17);
    const h2 = c.r(2.2, 2.8);
    st.set(wt * 1.02, wt * 0.98, wt * 0.89, 2, 0.06);
    c.prim(UNIT_BOX, u, top + h2 / 2 - 0.3, v, w2, h2, d2, ry);
    c.prim(UNIT_BOX, u, top + h2 - 0.2, v, w2 + 0.4, 0.45, d2 + 0.4, ry);
    frostMerlons(c, u, v, top + h2 + 0.02, w2 + 0.4, d2 + 0.4, Tx, Tz);
    const [wu, wv] = at(lx2, -face * d * 0.17 + face * (d2 / 2 + 0.03));
    st.set(DARK[0], DARK[1], DARK[2], 2, 0);
    c.solid = false;
    c.prim(UNIT_BIT, wu, top + h2 * 0.5 - 0.2, wv, 0.6, 0.9, 0.14, ry);
    c.solid = true;
    if (c.rng() < 0.6) c.glow(wu, top + h2 * 0.5 - 0.2, wv, 1.0);
  } else if (style < 0.8) {
    // a toothed parapet
    st.set(wt, wt * 0.96, wt * 0.87, 2, 0.06);
    frostMerlons(c, hu, hv, top, w + 0.45, d + 0.45, Tx, Tz);
  } else {
    // a roof that is lived on: a drying frame hung with cloth, and jars
    c.solid = false;
    st.set(WOOD[0], WOOD[1], WOOD[2], 2, 0.02);
    const fx = c.r(-w * 0.2, w * 0.2);
    for (const s of [-1, 1]) {
      const [u, v] = at(fx + s * 1.1, -face * d * 0.15);
      c.prim(UNIT_BIT, u, top + 0.8, v, 0.1, 1.6, 0.1, ry);
    }
    const [bu, bv] = at(fx, -face * d * 0.15);
    c.prim(UNIT_BIT, bu, top + 1.55, bv, 2.4, 0.08, 0.08, ry);
    const k0 = Math.floor(c.rng() * CLOTH.length);
    for (let i = 0; i < 3; i++) {
      clothTint(c, k0 + i * 2);
      const [u, v] = at(fx - 0.72 + i * 0.72, -face * d * 0.15);
      const len = c.r(0.6, 1.0);
      c.prim(UNIT_BIT, u, top + 1.5 - len / 2, v, 0.55, len, 0.05, ry);
    }
    st.set(0.92, 0.56, 0.38, 2, 0.03);
    for (let i = 0; i < 3; i++) {
      const [u, v] = at(c.r(-w * 0.38, w * 0.38), face * d * c.r(0.05, 0.3));
      const s = c.r(0.26, 0.42);
      c.prim(UNIT_PEBBLE, u, top + s * 0.9, v, s, s * 1.15, s, c.rng() * 6);
    }
    c.solid = true;
  }
  // the doorway: dark, under a timber lintel, with a step or two up to it where the ground falls away
  const doorX = c.r(-w * 0.12, w * 0.12);
  {
    const [u, v] = at(doorX, face * (d / 2 + 0.02));
    st.set(DARK[0], DARK[1], DARK[2], 2, 0);
    c.solid = false;
    c.prim(UNIT_BIT, u, floor + 0.95, v, 1.15, 1.9, 0.4, ry);
    st.set(WOOD[0], WOOD[1], WOOD[2], 2, 0.02);
    const [lu, lv] = at(doorX, face * (d / 2 + 0.12));
    c.prim(UNIT_BIT, lu, floor + 2.02, lv, 1.7, 0.24, 0.3, ry);
    c.solid = true;
    st.set(wt * 0.86, wt * 0.82, wt * 0.74, 2, 0.05);
    const drop = floor - gDoor;
    const steps = Math.max(1, Math.min(4, Math.ceil(drop / 0.32)));
    for (let k = 0; k < steps; k++) {
      const [su, sv] = at(doorX, face * (d / 2 + 0.45 + k * 0.42));
      const y1 = floor - (k * drop) / steps;
      const y0 = Math.min(lo, gDoor) - 0.6;
      c.prim(UNIT_BOX, su, (y0 + y1) / 2, sv, 1.7, y1 - y0, 0.46, ry);
    }
  }
  // window slots either side of the door; lamps burn behind some at night
  for (const s of [-1, 1]) {
    const wx = doorX + s * Math.max(1.55, w * 0.3);
    if (Math.abs(wx) > w / 2 - 0.6) continue;
    const [u, v] = at(wx, face * (d / 2 + 0.02));
    st.set(DARK[0], DARK[1], DARK[2], 2, 0);
    c.solid = false;
    c.prim(UNIT_BIT, u, floor + 1.7, v, 0.55, 0.85, 0.3, ry);
    st.set(WOOD[0], WOOD[1], WOOD[2], 2, 0.02);
    const [su, sv] = at(wx, face * (d / 2 + 0.1));
    c.prim(UNIT_BIT, su, floor + 1.22, sv, 0.85, 0.1, 0.24, ry);
    c.solid = true;
    if (c.rng() < 0.7) c.glow(u, floor + 1.7, v, 1.1);
  }
  // an awning of dyed cloth over the door, on two poles
  if (c.rng() < 0.5) {
    const out = 1.7;
    const [u, v] = at(doorX, face * (d / 2 + out / 2 + 0.05));
    clothTint(c, Math.floor(c.rng() * CLOTH.length));
    c.solid = false;
    c.prim(UNIT_BIT, u, floor + 2.42, v, 2.5, 0.07, out, ry, face * 0.24);
    st.set(WOOD[0], WOOD[1], WOOD[2], 2, 0.02);
    for (const s of [-1, 1]) {
      const [pu, pv] = at(doorX + s * 1.15, face * (d / 2 + out));
      const pg = c.g(pu, pv);
      c.prim(UNIT_BIT, pu, (pg + floor + 2.22) / 2, pv, 0.1, floor + 2.22 - pg, 0.1, ry);
    }
    c.solid = true;
  }
  // jars by the door
  st.set(0.92, 0.56, 0.38, 2, 0.03);
  c.solid = false;
  const jars = Math.floor(c.rng() * 3);
  for (let i = 0; i < jars; i++) {
    const [u, v] = at(doorX + (c.rng() < 0.5 ? -1 : 1) * c.r(1.0, 1.5), face * (d / 2 + c.r(0.4, 0.8)));
    const s = c.r(0.28, 0.46);
    c.prim(UNIT_PEBBLE, u, c.g(u, v) + s * 0.95, v, s, s * 1.2, s, c.rng() * 6);
  }
  // a ladder up to the roof against an end wall
  if (c.rng() < 0.35) {
    const side = c.rng() < 0.5 ? -1 : 1;
    const lean = 0.2;
    const [bu, bv] = at(side * (w / 2 + 0.75), -face * d * 0.1);
    const g = c.g(bu, bv);
    const L = (top + 0.5 - g) / Math.cos(lean);
    st.set(WOOD[0] * 1.1, WOOD[1] * 1.1, WOOD[2] * 1.1, 2, 0.01);
    for (const s of [-0.28, 0.28]) {
      const [u, v] = at(side * (w / 2 + 0.75 - (Math.sin(lean) * L) / 2), -face * d * 0.1 + s);
      c.prim(UNIT_BIT, u, g + (Math.cos(lean) * L) / 2, v, 0.08, L, 0.08, ry, 0, side * lean);
    }
    for (let t = 0.5; t < L - 0.3; t += 0.5) {
      const [u, v] = at(side * (w / 2 + 0.75 - Math.sin(lean) * t), -face * d * 0.1);
      c.prim(UNIT_BIT, u, g + Math.cos(lean) * t, v, 0.06, 0.06, 0.6, ry);
    }
  }
  c.solid = true;
  return { floor, top, at };
}

/** A well: a ring of stone, two posts, a beam across and a bucket on its rope. */
function mudWell(c: Ctx, u: number, v: number): void {
  const st = c.stone;
  const g = c.g(u, v);
  st.set(1.0, 0.97, 0.9, 0, 0.08);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    c.prim(UNIT_BOX, u + Math.cos(a) * 1.7, g + 0.45, v + Math.sin(a) * 1.7, 1.3, 1.1, 0.9, -a);
  }
  st.set(DARK[0], DARK[1], DARK[2], 2, 0);
  c.solid = false;
  c.prim(UNIT_CYL, u, g + 0.72, v, 1.3, 0.1, 1.3);
  st.set(WOOD[0], WOOD[1], WOOD[2], 2, 0.02);
  for (const s of [-1, 1]) c.prim(UNIT_BIT, u + s * 1.75, g + 1.6, v, 0.22, 3.2, 0.22);
  c.prim(UNIT_BIT, u, g + 3.1, v, 4.1, 0.2, 0.2);
  c.prim(UNIT_CYL, u, g + 3.1, v, 0.24, 1.4, 0.24, 0, 0, Math.PI / 2);
  c.prim(UNIT_BIT, u + 0.2, g + 2.3, v, 0.04, 1.5, 0.04);
  st.set(WOOD[0] * 1.2, WOOD[1] * 1.2, WOOD[2] * 1.2, 2, 0.02);
  c.prim(UNIT_CYL, u + 0.2, g + 1.45, v, 0.26, 0.4, 0.26);
  c.solid = true;
}

/** A stack of straw, bound round. */
function hayStack(c: Ctx, u: number, v: number, s: number): void {
  const st = c.stone;
  const g = c.g(u, v);
  st.set(1.18, 0.98, 0.52, 2, 0.1);
  c.prim(UNIT_BLOB, u, g + s * 0.55, v, s, s * 0.85, s, c.rng() * 6);
  c.solid = false;
  c.prim(UNIT_CONE, u, g + s * 1.45, v, s * 0.7, s * 0.9, s * 0.7, c.rng() * 6);
  c.solid = true;
}

/** A two-wheeled hand cart, its shafts resting on the ground. */
function handCart(c: Ctx, u: number, v: number, ang: number): void {
  const st = c.stone;
  const Tx = Math.cos(ang);
  const Tz = Math.sin(ang);
  const g = c.g(u, v);
  const ry = -ang;
  st.set(WOOD[0] * 1.15, WOOD[1] * 1.15, WOOD[2] * 1.15, 2, 0.03);
  c.prim(UNIT_BOX, u, g + 0.85, v, 2.2, 0.3, 1.3, ry);
  c.solid = false;
  for (const s of [-1, 1]) {
    c.prim(UNIT_BIT, u - Tz * 0.62 * s, g + 1.15, v + Tx * 0.62 * s, 2.2, 0.4, 0.08, ry);
    c.prim(UNIT_BIT, u + Tx * 1.9 - Tz * 0.5 * s, g + 0.48, v + Tz * 1.9 + Tx * 0.5 * s, 1.9, 0.09, 0.09, ry, 0, -0.4);
  }
  st.set(WOOD[0] * 0.8, WOOD[1] * 0.8, WOOD[2] * 0.8, 2, 0.02);
  for (const s of [-1, 1]) c.prim(UNIT_CYL, u - Tz * 0.78 * s, g + 0.62, v + Tx * 0.78 * s, 0.62, 0.14, 0.62, ry, Math.PI / 2);
  // what it carries
  st.set(0.92, 0.56, 0.38, 2, 0.03);
  c.prim(UNIT_PEBBLE, u - Tx * 0.4, g + 1.3, v - Tz * 0.4, 0.36, 0.42, 0.36);
  st.set(1.18, 0.98, 0.52, 2, 0.08);
  c.prim(UNIT_PEBBLE, u + Tx * 0.4, g + 1.25, v + Tz * 0.4, 0.5, 0.36, 0.48);
  c.solid = true;
}

/** A pen of low mud walls with a gap for a gate, straw inside and a trough. L is its side. */
function mudPen(c: Ctx, pu: number, pv: number, ang: number, L: number): void {
  const st = c.stone;
  const Tx = Math.cos(ang);
  const Tz = Math.sin(ang);
  const ry = -ang;
  st.set(0.95, 0.9, 0.8, 2, 0.1);
  const seg = (lx: number, lz: number, len: number, alongT: boolean): void => {
    const u = pu + Tx * lx - Tz * lz;
    const v = pv + Tz * lx + Tx * lz;
    c.prim(UNIT_BOX, u, c.g(u, v) + 0.45, v, alongT ? len : 0.55, 1.5, alongT ? 0.55 : len, ry);
  };
  const h = L / 2;
  // each side in two lengths, so the wall follows the ground; the near side leaves a gateway
  for (const s of [-1, 1]) {
    seg(-h / 2, s * h, h + 0.3, true);
    if (s < 0) seg(h / 2 + 0.6, s * h, h - 1.2, true);
    else seg(h / 2, s * h, h + 0.3, true);
    seg(s * h, -h / 2, h, false);
    seg(s * h, h / 2, h, false);
  }
  hayStack(c, pu + Tx * (h - 1.6) + Tz * (h - 1.6), pv + Tz * (h - 1.6) - Tx * (h - 1.6), 0.9);
  st.set(WOOD[0], WOOD[1], WOOD[2], 2, 0.03);
  const tu = pu - Tx * (h - 1.2);
  const tv = pv - Tz * (h - 1.2);
  c.prim(UNIT_BOX, tu, c.g(tu, tv) + 0.3, tv, 0.6, 0.5, 1.8, ry);
}

/** A line of little flags between two poles, sagging in the middle. Points are in the site's frame. */
function bunting(c: Ctx, u0: number, v0: number, u1: number, v1: number, high: number): void {
  const st = c.stone;
  const len = Math.hypot(u1 - u0, v1 - v0);
  const ry = -Math.atan2(v1 - v0, u1 - u0);
  const y0 = c.g(u0, v0) + high;
  const y1 = c.g(u1, v1) + high;
  c.solid = false;
  st.set(WOOD[0], WOOD[1], WOOD[2], 2, 0.02);
  c.prim(UNIT_BIT, u0, y0 - high / 2, v0, 0.14, high, 0.14);
  c.prim(UNIT_BIT, u1, y1 - high / 2, v1, 0.14, high, 0.14);
  const n = Math.max(5, Math.round(len / 0.8));
  const k0 = Math.floor(c.rng() * CLOTH.length);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const y = y0 + (y1 - y0) * t - len * 0.1 * 4 * t * (1 - t);
    clothTint(c, k0 + i);
    c.prim(UNIT_BIT, u0 + (u1 - u0) * t, y - 0.24, v0 + (v1 - v0) * t, 0.36, 0.46, 0.04, ry, 0, Math.PI / 4);
  }
  c.solid = true;
}

/** A terrace: a low retaining wall along bearing `ang`, and rows of green behind it on the side (su, sv). */
function terracePlot(c: Ctx, u: number, v: number, ang: number, len: number, deep: number): void {
  const st = c.stone;
  const Tx = Math.cos(ang);
  const Tz = Math.sin(ang);
  const ry = -ang;
  const n = Math.max(2, Math.round(len / 3.5));
  st.set(0.9, 0.84, 0.74, 2, 0.1);
  for (let i = 0; i < n; i++) {
    const t = -len / 2 + ((i + 0.5) / n) * len;
    const wu = u + Tx * t;
    const wv = v + Tz * t;
    c.prim(UNIT_BOX, wu, c.g(wu, wv) + 0.25, wv, len / n + 0.25, 1.3, 0.6, ry);
  }
  c.solid = false;
  const rows = Math.max(1, Math.round(Math.abs(deep) / 1.6));
  const sgn = Math.sign(deep);
  for (let r = 0; r < rows; r++) {
    const off = sgn * (1.3 + r * 1.6);
    const green = c.r(0.85, 1.1);
    for (let t = -len / 2 + 0.8; t < len / 2 - 0.5; t += c.r(0.95, 1.35)) {
      const pu = u + Tx * t - Tz * off;
      const pv = v + Tz * t + Tx * off;
      st.set(0.3 * green, 0.62 * green, 0.3, 0, 0.12);
      const s = c.r(0.3, 0.5);
      c.prim(UNIT_PEBBLE, pu, c.g(pu, pv) + s * 0.5, pv, s * 1.2, s, s * 1.2, c.rng() * 6);
    }
  }
  c.solid = true;
}

/**
 * A mud-brick watchtower, battered as it rises, with a toothed platform, a brazier that burns at
 * night and a pennant. (u, v) is its middle, `ang` the bearing its door faces, H its height.
 */
function mudTower(c: Ctx, u: number, v: number, ang: number, H: number, wt: number): void {
  const st = c.stone;
  const Fx = Math.cos(ang);
  const Fz = Math.sin(ang);
  const ry = -ang;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [a, b] of [[-3, -3], [3, -3], [-3, 3], [3, 3], [0, 0]] as const) {
    const gh = c.g(u + a, v + b);
    lo = Math.min(lo, gh);
    hi = Math.max(hi, gh);
  }
  const base = hi + 0.4;
  const B = 4.8;
  st.set(wt * 0.86, wt * 0.82, wt * 0.74, 2, 0.08);
  c.prim(UNIT_BOX, u, (lo - 1.2 + base) / 2, v, B + 1.6, base - lo + 1.2, B + 1.6, ry);
  // the shaft: a fifth narrower at the top than at the foot
  st.set(wt, wt * 0.96, wt * 0.87, 2, 0.07);
  c.prim(UNIT_SLAB, u, base + H / 2, v, B, H, B, ry);
  const half = (y: number): number => (B / 2) * (1 - 0.2 * (y / H));
  // the platform, carried out past the shaft on beam ends
  const topW = B * 0.8 + 1.3;
  const py = base + H;
  st.set(WOOD[0], WOOD[1], WOOD[2], 2, 0.02);
  c.solid = false;
  for (let i = 0; i < 4; i++) {
    const t = -topW / 2 + 0.5 + (i / 3) * (topW - 1);
    c.prim(UNIT_BIT, u - Fz * t, py - 0.2, v + Fx * t, topW + 0.5, 0.22, 0.22, ry);
    c.prim(UNIT_BIT, u + Fx * t, py - 0.2, v + Fz * t, 0.22, 0.22, topW + 0.5, ry);
  }
  c.solid = true;
  st.set(wt * 1.02, wt * 0.98, wt * 0.89, 2, 0.06);
  c.prim(UNIT_BOX, u, py + 0.2, v, topW, 0.6, topW, ry);
  frostMerlons(c, u, v, py + 0.5, topW, topW, Fx, Fz);
  frostMerlons(c, u, v, py + 0.5, topW, topW, -Fz, Fx);
  // slots up the faces, lit from inside at night, and the door
  for (let k = 0; k < 4; k++) {
    const a = ang + (k * Math.PI) / 2;
    for (const fy of [0.42, 0.72]) {
      if (k === 0 && fy < 0.5) continue;
      const y = H * fy;
      const r = half(y) + 0.02;
      st.set(DARK[0], DARK[1], DARK[2], 2, 0);
      c.solid = false;
      c.prim(UNIT_BIT, u + Math.cos(a) * r, base + y, v + Math.sin(a) * r, 0.14, 1.4, 0.5, -a);
      c.solid = true;
      if (c.rng() < 0.8) c.glow(u + Math.cos(a) * r, base + y, v + Math.sin(a) * r, 1.0);
    }
  }
  {
    const r = half(1) + 0.05;
    st.set(DARK[0], DARK[1], DARK[2], 2, 0);
    c.solid = false;
    c.prim(UNIT_BIT, u + Fx * r, base + 1.0, v + Fz * r, 0.4, 2.0, 1.2, ry);
    st.set(WOOD[0], WOOD[1], WOOD[2], 2, 0.02);
    c.prim(UNIT_BIT, u + Fx * (r + 0.1), base + 2.12, v + Fz * (r + 0.1), 0.3, 0.24, 1.8, ry);
    c.solid = true;
    st.set(wt * 0.86, wt * 0.82, wt * 0.74, 2, 0.05);
    const gd = c.g(u + Fx * (B / 2 + 2.2), v + Fz * (B / 2 + 2.2));
    const drop = base - gd;
    const steps = Math.max(1, Math.min(6, Math.ceil(drop / 0.32)));
    for (let k = 0; k < steps; k++) {
      const su = u + Fx * (B / 2 + 0.95 + k * 0.44);
      const sv = v + Fz * (B / 2 + 0.95 + k * 0.44);
      const y1 = base - (k * drop) / steps;
      const y0 = Math.min(lo, gd) - 0.6;
      c.prim(UNIT_BOX, su, (y0 + y1) / 2, sv, 0.48, y1 - y0, 1.9, ry);
    }
  }
  // the brazier, and a pennant on a pole at one corner
  st.set(0.2, 0.18, 0.17, 1, 0.02);
  c.prim(UNIT_CYL, u, py + 0.85, v, 0.8, 0.5, 0.8);
  st.set(1, 1, 1, 3, 0);
  c.prim(UNIT_CONE, u, py + 1.8, v, 0.5, 1.5, 0.5, 0.6);
  c.glow(u, py + 1.7, v, 8);
  c.glow(u, py + 1.6, v, 4);
  const cu = u + (Fx - Fz) * (topW / 2 - 0.3);
  const cv = v + (Fz + Fx) * (topW / 2 - 0.3);
  c.solid = false;
  st.set(WOOD[0], WOOD[1], WOOD[2], 2, 0.01);
  c.prim(UNIT_BIT, cu, py + 2.6, cv, 0.1, 4.2, 0.1, ry);
  clothTint(c, Math.floor(c.rng() * 4));
  c.prim(UNIT_BIT, cu - Fz * 0.75, py + 4.3, cv + Fx * 0.75, 0.05, 0.6, 1.4, ry);
  c.prim(UNIT_BIT, cu - Fz * 1.65, py + 4.36, cv + Fx * 1.65, 0.05, 0.34, 0.5, ry);
  c.solid = true;
}

/** A handful of mud-brick houses round a well, with pens, palms and a lamp post: a hamlet nobody is home in. */
function buildHamlet(c: Ctx): void {
  const n = 4 + Math.floor(c.rng() * 4);
  const R = c.r(15, 22);
  c.foot = R + 16;
  const a0 = c.rng() * Math.PI * 2;
  const wall = c.r(0.98, 1.1);
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + c.r(-0.2, 0.2);
    const d = R * c.r(0.8, 1.12);
    // long side across the ring, door looking in toward the well
    mudHouse(c, Math.cos(a) * d, Math.sin(a) * d, a + Math.PI / 2, 1, c.r(5, 7.4), c.r(4.2, 5.8), c.r(2.8, 3.6), wall * c.r(0.95, 1.05));
  }
  mudWell(c, 0, 0);
  frostTorch(c, 3.6, 0.6, 1.5);
  // palms in the gaps between the houses, and beyond them a pen or two, straw and a cart
  const palms = 1 + Math.floor(c.rng() * 3);
  for (let k = 0; k < palms; k++) {
    const a = a0 + ((Math.floor(c.rng() * n) + 0.5) / n) * Math.PI * 2;
    const d = R + c.r(8, 13); // behind the houses, clear of their walls
    addPalm(c, Math.cos(a) * d, Math.sin(a) * d, c.rng() * 6.28);
  }
  const pens = 1 + Math.floor(c.rng() * 2);
  const pa = a0 + c.rng() * Math.PI * 2;
  for (let k = 0; k < pens; k++) {
    const a = pa + k * c.r(1.6, 2.6);
    const d = R + c.r(11, 14);
    mudPen(c, Math.cos(a) * d, Math.sin(a) * d, a, c.r(5.5, 8));
  }
  for (let k = 0; k < 2; k++) {
    const a = pa + Math.PI + c.r(-1, 1);
    const d = R + c.r(8, 12);
    hayStack(c, Math.cos(a) * d, Math.sin(a) * d, c.r(0.9, 1.4));
  }
  if (c.rng() < 0.7) {
    const a = a0 + c.rng() * 6.28;
    handCart(c, Math.cos(a) * 6.5, Math.sin(a) * 6.5, a + c.r(0.8, 2.2));
  }
  // a kitchen garden behind a low wall
  if (c.rng() < 0.75) {
    const a = pa + Math.PI / 2 + c.r(-0.4, 0.4);
    const d = R + c.r(10, 13);
    terracePlot(c, Math.cos(a) * d, Math.sin(a) * d, a + Math.PI / 2, c.r(7, 11), c.r(3, 5));
  }
}

/**
 * A village on the foot of a mountain: a street of houses along the slope, a terrace of more
 * above it, a square with a well, a watchtower at one end, garden plots stepping down toward
 * the sand, bunting over the street and palms round about. The frame is the world's own (yaw 0).
 */
function buildMountainVillage(c: Ctx, vil: FootVillage): void {
  const st = c.stone;
  const Tx = Math.cos(vil.yaw);
  const Tz = Math.sin(vil.yaw);
  // down the slope, across the street
  const Nx = -Tz;
  const Nz = Tx;
  const ang = vil.yaw;
  c.foot = 62;
  const P = (a: number, off: number): [number, number] => [Tx * a + Nx * off, Tz * a + Nz * off];
  const wall = c.r(0.98, 1.08);
  const slots = 5 + Math.floor(c.rng() * 2);
  const gap = 10.6;
  const square = Math.floor(slots / 2);
  const x0 = -((slots - 1) / 2) * gap;
  // the street: a row above it and a row below, doors facing across; the square is left open below
  for (let i = 0; i < slots; i++) {
    for (const side of [-1, 1]) {
      if (side === 1 && i === square) continue;
      const w = c.r(6, 8.2);
      const d = c.r(4.8, 6.2);
      const [u, v] = P(x0 + i * gap + c.r(-1, 1), side * (2.6 + d / 2 + c.r(0.4, 1.6)));
      mudHouse(c, u, v, ang, -side, w, d, c.r(2.7, 3.4), wall * c.r(0.95, 1.06));
      // a lamp where the street begins and where it ends; the windows and the fire light the rest
      if ((i === 0 && side === -1) || (i === slots - 1 && side === 1)) {
        const [tu, tv] = P(x0 + i * gap + w / 2 + 0.9, side * 2.4);
        frostTorch(c, tu, tv, 1.2);
      }
    }
  }
  // the terrace above: a shorter row further up, looking out over the roofs
  const upper = 2 + Math.floor(c.rng() * 3);
  for (let i = 0; i < upper; i++) {
    const w = c.r(5.6, 7.4);
    const d = c.r(4.6, 5.6);
    const [u, v] = P((i - (upper - 1) / 2) * 12.5 + c.r(-2, 2), -(19.5 + c.r(0, 3)));
    mudHouse(c, u, v, ang + c.r(-0.12, 0.12), 1, w, d, c.r(2.7, 3.2), wall * c.r(0.95, 1.06));
  }
  // the square: the well, a fire ring, a cart, a lamp
  {
    const [wu, wv] = P(x0 + square * gap, 7.5);
    mudWell(c, wu, wv);
    const [fu, fv] = P(x0 + square * gap - 3.6, 4.4);
    const g = c.g(fu, fv);
    st.set(0.62, 0.58, 0.55, 0, 0.12);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      c.prim(UNIT_BOX, fu + Math.cos(a) * 1.0, g + 0.2, fv + Math.sin(a) * 1.0, 0.7, 0.5, 0.55, -a);
    }
    st.set(1, 1, 1, 3, 0);
    c.prim(UNIT_CONE, fu, g + 0.75, fv, 0.4, 1.0, 0.4, 0.5);
    c.glow(fu, g + 0.8, fv, 4);
    const [cu, cv] = P(x0 + square * gap + 3.4, 4.2);
    handCart(c, cu, cv, ang + c.r(0.3, 1.2));
    const [lu, lv] = P(x0 + square * gap + 4.6, 9.5);
    frostTorch(c, lu, lv, 1.5);
  }
  // stepping stones down the middle of the street
  st.set(0.98, 0.93, 0.84, 0, 0.05);
  c.solid = false;
  for (let a = x0 - gap * 0.7; a <= -x0 + gap * 0.7; a += 1.9) {
    const [u, v] = P(a, c.r(-0.5, 0.5));
    c.prim(UNIT_BIT, u, c.g(u, v) + 0.02, v, c.r(1.0, 1.4), 0.16, c.r(0.9, 1.3), -ang + c.r(-0.3, 0.3));
  }
  c.solid = true;
  // bunting across the street
  for (const i of [1, slots - 2]) {
    const a = x0 + (i + 0.5) * gap;
    const [u0, v0] = P(a + c.r(-0.6, 0.6), -2.5);
    const [u1, v1] = P(a + c.r(-0.6, 0.6), 2.5);
    bunting(c, u0, v0, u1, v1, 4.3);
  }
  // the watchtower past one end of the rows, a little up the slope, its door down toward the street
  const endSign = c.rng() < 0.5 ? -1 : 1;
  c.folk = footVillageFolk({ Tx, Tz, Nx, Nz, x0, gap, slots, square, endSign });
  {
    const [u, v] = P(endSign * (-x0 + gap * 0.95), -7);
    mudTower(c, u, v, Math.atan2(Nz, Nx), c.r(10.5, 13.5), wall);
  }
  // garden plots stepping down below the lower row
  const plots = 2 + Math.floor(c.rng() * 2);
  for (let k = 0; k < plots; k++) {
    const [u, v] = P(c.r(-0.5, 0.5) * gap * (slots - 2) * 0.6, 17 + k * 7.5);
    terracePlot(c, u, v, ang, c.r(13, 24), -c.r(3.5, 5.5));
  }
  // the pen and the straw at the other end from the tower
  {
    const [u, v] = P(-endSign * (-x0 + gap * 1.05), 9);
    mudPen(c, u, v, ang, c.r(6.5, 8.5));
    const [hu, hv] = P(-endSign * (-x0 + gap * 1.05) + c.r(-3, 3), -4);
    hayStack(c, hu, hv, c.r(1.0, 1.5));
  }
  // palms round the edges, and rocks fallen from the mountain above
  for (let k = 0; k < 6; k++) {
    // below the lower row, or above the upper terrace: never among the roofs
    const [u, v] = P(c.r(-1, 1) * (-x0 + gap), c.rng() < 0.65 ? c.r(15, 42) : -c.r(30, 44));
    addPalm(c, u, v, c.rng() * 6.28);
  }
  for (let k = 0; k < 5; k++) {
    const [u, v] = P(c.r(-1, 1) * (-x0 + gap * 1.2), -c.r(30, 48));
    const g = c.g(u, v);
    const s = c.r(1.0, 2.6);
    st.set(c.r(0.9, 1.05), c.r(0.88, 1.0), 0.92, 0, 0.2);
    c.prim(UNIT_BLOB, u, g + s * 0.3, v, s, s * c.r(0.55, 0.85), s * c.r(0.8, 1.1), c.rng() * 3);
  }
}

/**
 * A lone watchtower out on the sand: the tower itself, a keeper's hut against it, a ring of low
 * wall half fallen in, and what was left lying about.
 */
function buildWatchtower(c: Ctx): void {
  const st = c.stone;
  c.foot = 20;
  const wt = c.r(0.98, 1.1);
  const face = c.rng() * Math.PI * 2;
  mudTower(c, 0, 0, face, c.r(13, 17.5), wt);
  // the hut, off to one side of the door
  const ha = face + (c.rng() < 0.5 ? -1 : 1) * c.r(1.2, 1.7);
  mudHouse(c, Math.cos(ha) * 7.6, Math.sin(ha) * 7.6, ha + Math.PI / 2, -1, c.r(4.6, 5.6), c.r(3.6, 4.2), c.r(2.4, 2.8), wt * c.r(0.95, 1.04));
  // the ring wall, with gaps where it has gone
  const R = c.r(12.5, 15);
  const segs = 18;
  st.set(wt * 0.92, wt * 0.87, wt * 0.78, 2, 0.12);
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const dFace = Math.abs(Math.atan2(Math.sin(a - face), Math.cos(a - face)));
    if (dFace < 0.3 || c.rng() < 0.28) continue; // the gateway, and the fallen lengths
    const u = Math.cos(a) * R;
    const v = Math.sin(a) * R;
    const h = c.r(0.7, 1.9);
    c.prim(UNIT_BOX, u, c.g(u, v) + h / 2 - 0.4, v, 0.8, h + 0.8, (Math.PI * 2 * R) / segs + 0.2, -a);
  }
  // inside the wall: straw, a cart or a stack of wood, a lamp by the gate
  {
    const a = face + Math.PI + c.r(-0.8, 0.8);
    hayStack(c, Math.cos(a) * (R - 3.2), Math.sin(a) * (R - 3.2), c.r(0.9, 1.3));
  }
  if (c.rng() < 0.6) {
    const a = ha + Math.PI + c.r(-0.4, 0.4);
    handCart(c, Math.cos(a) * 8, Math.sin(a) * 8, a + 1.2);
  } else {
    const a = ha + Math.PI + c.r(-0.4, 0.4);
    const u = Math.cos(a) * 7.5;
    const v = Math.sin(a) * 7.5;
    st.set(0.5, 0.36, 0.25, 2, 0.05);
    c.prim(UNIT_BOX, u, c.g(u, v) + 0.45, v, 2.4, 0.9, 0.9, -a);
  }
  frostTorch(c, Math.cos(face + 0.24) * (R + 0.6), Math.sin(face + 0.24) * (R + 0.6), 1.3);
  frostTorch(c, Math.cos(face - 0.24) * (R + 0.6), Math.sin(face - 0.24) * (R + 0.6), 1.3);
  if (c.rng() < 0.5) addPalm(c, Math.cos(face + 2.4) * (R + 4), Math.sin(face + 2.4) * (R + 4), c.rng() * 6.28);
}

// ------------------------------------------------------------------ the frostland

/** Width of the road across the open desert and up the mountain (m). */
const WAY_W = 4.2;
const CLIMB_W = 3.4;
/** Metres the road is laid above the ground, so it never sinks into the dunes. */
const WAY_LIFT = 0.1;
/** Points of the way in one chunk of road (a chunk is built and dropped as a whole). */
const FROST_CHUNK = 34;
/** Keys of the frost sites count down from here, clear of every other kind. */
const FROST_KEY = -1e12;
/** The frostland wakes (its layout is worked out) when the wanderer comes this close to its mountain. */
const FROST_WAKE = 9500;

/** A standing torch: a post, an iron cup and a flame that glows at night. */
function frostTorch(c: Ctx, u: number, v: number, tall = 1): void {
  const st = c.stone;
  const g = c.g(u, v);
  st.set(0.42, 0.3, 0.21, 2, 0.02);
  c.prim(UNIT_BOX, u, g + 1.05 * tall, v, 0.16, 2.1 * tall, 0.16);
  c.prim(UNIT_BOX, u, g + 0.2, v, 0.5, 0.4, 0.5, 0.6);
  st.set(0.2, 0.18, 0.17, 1, 0.02);
  c.prim(UNIT_CYL, u, g + 2.18 * tall, v, 0.3, 0.2, 0.3);
  st.set(1, 1, 1, 3, 0);
  c.prim(UNIT_CONE, u, g + 2.55 * tall, v, 0.15, 0.5, 0.15, 0.6);
  c.glow(u, g + 2.5 * tall, v, 1.7);
}

/** A pine, its boughs lying under snow. s scales it. */
function frostPine(c: Ctx, u: number, v: number, s: number): void {
  const st = c.stone;
  const g = c.g(u, v);
  st.set(0.4, 0.28, 0.2, 2, 0.03);
  c.prim(UNIT_CYL, u, g + 0.9 * s, v, 0.28 * s, 1.8 * s, 0.28 * s);
  for (let t = 0; t < 3; t++) {
    const y = g + (2.1 + t * 1.45) * s;
    const rad = (2.0 - t * 0.55) * s;
    const h = 2.7 * s;
    st.set(0.2, 0.46, 0.3, 0, 0.1);
    c.prim(UNIT_CONE, u, y, v, rad, h, rad, c.rng() * 1.5);
    st.set(1.25, 1.27, 1.3, 1, 0.06);
    c.prim(UNIT_CONE, u, y + h * 0.16, v, rad * 0.8, h * 0.72, rad * 0.8, 0.4);
  }
}

/** A snow-capped boulder. */
function frostBoulder(c: Ctx, u: number, v: number, s: number): void {
  const st = c.stone;
  const g = c.g(u, v);
  const sy = s * c.r(0.55, 0.9);
  st.set(0.62, 0.6, 0.6, 1, 0.18);
  c.prim(UNIT_BLOB, u, g + sy * 0.4, v, s, sy, s * c.r(0.8, 1.1), c.rng() * 3);
  st.set(1.25, 1.27, 1.3, 1, 0.12);
  c.prim(UNIT_BLOB, u, g + sy * 0.95, v, s * 0.78, sy * 0.45, s * 0.7, c.rng() * 3);
}

/** A slab of snow lying on a flat roof (or a ledge), w by d, its top a little uneven. */
function frostSnowCap(c: Ctx, u: number, v: number, y: number, w: number, d: number, ry: number, deep = 0.34): void {
  const st = c.stone;
  st.set(1.22, 1.24, 1.28, 1, 0.07);
  c.solid = false;
  c.prim(UNIT_BOX, u, y + deep / 2, v, w, deep, d, ry);
  c.solid = true;
}

/** The teeth along a parapet, as on the towns' walls: one at each corner and along the long sides. (Tx, Tz) is the long axis. */
function frostMerlons(c: Ctx, u: number, v: number, y: number, w: number, d: number, Tx: number, Tz: number): void {
  const ry = -Math.atan2(Tz, Tx);
  const n = Math.max(2, Math.round(w / 1.5));
  c.solid = false;
  for (const sz of [-1, 1]) {
    for (let k = 0; k < n; k++) {
      const lx = -w / 2 + 0.3 + (k / (n - 1)) * (w - 0.6);
      const lz = sz * (d / 2 - 0.2);
      c.prim(UNIT_BOX, u + Tx * lx - Tz * lz, y + 0.22, v + Tz * lx + Tx * lz, 0.6, 0.45, 0.4, ry);
    }
  }
  c.solid = true;
}

/**
 * The gate where the road crosses into the snow: two battered mud-brick pylons with toothed
 * heads, like a town gate standing alone, a beam between them, braziers on top.
 */
function frostGate(c: Ctx, p: FrostPoint, ang: number): void {
  const st = c.stone;
  const u0 = p.x - c.x;
  const v0 = p.z - c.z;
  const Tx = Math.cos(ang);
  const Tz = Math.sin(ang);
  const half = WAY_W / 2 + 2.6;
  const ry = -ang;
  const g0 = c.g(u0, v0);
  const wt = 1.03;
  for (const side of [-1, 1]) {
    const u = u0 - Tz * half * side;
    const v = v0 + Tx * half * side;
    const g = c.g(u, v);
    // stepped in as it rises
    st.set(wt * 0.88, wt * 0.84, wt * 0.76, 2, 0.08);
    c.prim(UNIT_BOX, u, g + 0.7, v, 3.2, 2.6, 3.2, ry);
    st.set(wt, wt * 0.96, wt * 0.87, 2, 0.06);
    c.prim(UNIT_BOX, u, g + 3.6, v, 2.5, 4.4, 2.5, ry);
    c.prim(UNIT_BOX, u, g + 6.4, v, 2.0, 1.6, 2.0, ry);
    c.prim(UNIT_BOX, u, g + 7.3, v, 2.5, 0.45, 2.5, ry);
    frostMerlons(c, u, v, g + 7.5, 2.5, 2.5, Tx, Tz);
    frostSnowCap(c, u, v, g + 7.52, 1.5, 1.5, ry, 0.3);
    frostSnowCap(c, u, v, g + 2.0, 3.0, 3.0, ry, 0.22);
    // a slot on the face that meets the traveller
    st.set(0.16, 0.12, 0.1, 2, 0);
    c.solid = false;
    c.prim(UNIT_BOX, u - Tx * 1.26, g + 4.2, v - Tz * 1.26, 0.12, 1.6, 0.5, ry);
    c.solid = true;
    st.set(0.2, 0.18, 0.17, 1, 0.02);
    c.prim(UNIT_CYL, u, g + 8.0, v, 0.6, 0.35, 0.6);
    st.set(1, 1, 1, 3, 0);
    c.prim(UNIT_CONE, u, g + 8.75, v, 0.38, 1.2, 0.38, 0.6);
    c.glow(u, g + 8.7, v, 3.8);
  }
  // the beam across, of dark timber, with snow along it
  const top = g0 + 6.3;
  st.set(0.46, 0.33, 0.23, 2, 0.04);
  c.solid = false;
  c.prim(UNIT_BOX, u0, top, v0, 0.5, 0.55, half * 2, ry);
  c.prim(UNIT_BOX, u0, top - 0.75, v0, 0.3, 0.3, half * 2 - 2, ry);
  c.solid = true;
  frostSnowCap(c, u0, v0, top + 0.27, 0.6, half * 2 - 2.2, ry, 0.2);
}

/**
 * A stretch of the road: the worn ribbon over the ground, a lantern cairn now and then on one
 * side or the other (as the waymarkers stand along the routes between the towns), the gate,
 * and pines and boulders along it where the snow lies (more of them the deeper it is).
 */
function buildFrostWay(c: Ctx, layout: FrostLayout, i0: number, i1: number): void {
  const st = c.stone;
  const { way, region } = layout;
  const w = c.world;
  const px = (p: FrostPoint) => p.x - c.x;
  const pz = (p: FrostPoint) => p.z - c.z;
  const dirAt = (i: number) => {
    const a = way[Math.max(0, i - 1)];
    const b = way[Math.min(way.length - 1, i + 1)];
    return Math.atan2(b.z - a.z, b.x - a.x);
  };
  // the road itself: a strip of the ground's own surface laid just over it and drawn by the
  // ground's shader as trodden (see vCave in terrainFrag), so it is worn sand on the desert,
  // packed snow in the frostland, and fades out at its edges like the routes between the towns
  const SUB = 3;
  const smp: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  const nrm = new THREE.Vector3();
  const LANES = [-1, -0.5, 0.5, 1];
  const WORN = [0, 1, 1, 0];
  type RV = [number, number, number, number, number, number, number, number, number];
  for (let i = i0; i < i1; i++) {
    const a = way[i];
    const b = way[i + 1];
    const hw = (i >= layout.climbAt ? CLIMB_W : WAY_W) / 2 + 1.1;
    const aa = dirAt(i);
    let ab = dirAt(i + 1);
    ab = aa + Math.atan2(Math.sin(ab - aa), Math.cos(ab - aa));
    const row = (t: number): RV[] => {
      const ang = aa + (ab - aa) * t;
      return LANES.map((s, k) => {
        const x = a.x + (b.x - a.x) * t - Math.sin(ang) * hw * s;
        const z = a.z + (b.z - a.z) * t + Math.cos(ang) * hw * s;
        w.sample(x, z, smp);
        w.normal(x, z, nrm);
        return [x - c.x, smp.h - c.baseY + WAY_LIFT, z - c.z, nrm.x, nrm.y, nrm.z, smp.rock, smp.salt, -WORN[k]];
      });
    };
    let r0 = row(0);
    for (let j = 1; j <= SUB; j++) {
      const r1 = row(j / SUB);
      for (let k = 0; k < 3; k++) {
        for (const q of [r0[k], r1[k], r0[k + 1], r0[k + 1], r1[k], r1[k + 1]]) c.rock.vert(q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], q[8]);
      }
      r0 = r1;
    }
  }
  // the gate, and the cairns; a point shared with the next stretch belongs to that one
  if (layout.gateAt >= i0 && layout.gateAt < i1) frostGate(c, way[layout.gateAt], dirAt(layout.gateAt));
  for (const m of frostWayMarks(layout, i0, i1)) {
    const p = way[m.i];
    const ang = dirAt(m.i);
    const off = (m.i >= layout.climbAt ? CLIMB_W : WAY_W) / 2 + 2.6;
    buildCairn(c, px(p) - Math.sin(ang) * off * m.side, pz(p) + Math.cos(ang) * off * m.side, 3, frostCover(region, p.x, p.z));
  }
  // pines and boulders in the snow, a few frosted ones further out
  const s: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  const river = (w as { river?: (x: number, z: number) => number }).river;
  for (let i = i0; i <= i1; i += 2) {
    const p = way[i];
    const cover = frostCover(region, p.x, p.z);
    if (cover <= 0.2) continue;
    const ang = dirAt(i);
    const nx = -Math.sin(ang);
    const nz = Math.cos(ang);
    const tx = Math.cos(ang);
    const tz = Math.sin(ang);
    const tries = c.rng() < 0.3 + 0.9 * cover ? 1 + Math.floor(c.rng() * (1 + 2 * cover)) : 0;
    for (let k = 0; k < tries; k++) {
      const side = c.rng() < 0.5 ? -1 : 1;
      const lat = side * c.r(9, 20 + 55 * cover);
      const al = c.r(-12, 12);
      const x = p.x + nx * lat + tx * al;
      const z = p.z + nz * lat + tz * al;
      if (river && river.call(w, x, z) < 60) continue;
      w.sample(x, z, s);
      if (s.rock > 0.5 || s.salt > 0.3) continue;
      if (c.rng() < 0.82) frostPine(c, x - c.x, z - c.z, c.r(0.8, 1.5) * (0.8 + 0.4 * cover));
      else frostBoulder(c, x - c.x, z - c.z, c.r(1.2, 3));
    }
  }
}

/** One village: houses either side of the road, a fire pit, a lamp at a door here and there, and for the high one a hold. */
function buildSnowVillage(c: Ctx, layout: FrostLayout, vi: number): void {
  const village = layout.villages[vi];
  const st = c.stone;
  const { way } = layout;
  const ang = village.yaw;
  const Tx = Math.cos(ang);
  const Tz = Math.sin(ang);
  const Nx = -Tz;
  const Nz = Tx;
  const ry = -ang;
  const ox = village.x - c.x;
  const oz = village.z - c.z;
  c.foot = 70;
  const n = village.kind === 'mid' ? 8 : village.kind === 'gate' ? 6 : 4;
  const hw = CLIMB_W / 2;
  for (let k = 0; k < n; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    const a = (Math.floor(k / 2) - (Math.ceil(n / 2) - 1) / 2) * 11.5 + c.r(-1.5, 1.5);
    const off = side * (hw + c.r(7.5, 10));
    const w = c.r(6, 8);
    const d = c.r(5, 6.4);
    const wallH = c.r(2.6, 3.2);
    const hx = ox + Tx * a + Nx * off;
    const hz = oz + Tz * a + Nz * off;
    // local (x along the road, z across it) to the site's frame
    const at = (lx: number, lz: number): [number, number] => [hx + Tx * lx + Nx * lz, hz + Tz * lx + Nz * lz];
    let lo = Infinity;
    let hi = -Infinity;
    for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2], [0, 0]] as const) {
      const [u, v] = at(lx, lz);
      const gh = c.g(u, v);
      lo = Math.min(lo, gh);
      hi = Math.max(hi, gh);
    }
    const floor = hi + 0.15;
    const wt = c.r(0.96, 1.08); // each house its own shade of the same earth
    const face = -side; // the side that looks onto the road
    // footing: a battered plinth of darker brick carries the house level over the slope
    st.set(wt * 0.86, wt * 0.82, wt * 0.74, 2, 0.08);
    c.prim(UNIT_BOX, hx, (lo - 1.2 + floor) / 2, hz, w + 0.9, floor - lo + 1.2, d + 0.9, ry);
    // walls of the towns' own mud brick, and the parapet lip round a flat roof
    st.set(wt, wt * 0.96, wt * 0.87, 2, 0.06);
    c.prim(UNIT_BOX, hx, floor + wallH / 2, hz, w, wallH, d, ry);
    c.prim(UNIT_BOX, hx, floor + wallH + 0.12, hz, w + 0.45, 0.5, d + 0.45, ry);
    const top = floor + wallH + 0.37;
    const style = c.rng();
    if (style < 0.3) {
      // a dome, as on the desert hamlets, under a cap of snow
      const rd = Math.min(w, d) * 0.4;
      const [u, v] = at(-w * 0.1, 0);
      c.prim(UNIT_BLOB, u, top - 0.2, v, rd, 1.7, rd, c.rng() * 6);
      st.set(1.22, 1.24, 1.28, 1, 0.08);
      c.prim(UNIT_BLOB, u, top + 0.55, v, rd * 0.8, 1.05, rd * 0.8, c.rng() * 6);
      frostSnowCap(c, hx, hz, top, w - 0.2, d - 0.2, ry, 0.22);
    } else if (style < 0.6) {
      // a second, smaller storey set back from the road, with its own roof
      const w2 = w * 0.55;
      const d2 = d * 0.6;
      const [u, v] = at(-w * 0.2, -face * d * 0.18);
      const h2 = c.r(2.2, 2.7);
      c.prim(UNIT_BOX, u, top + h2 / 2 - 0.3, v, w2, h2, d2, ry);
      c.prim(UNIT_BOX, u, top + h2 - 0.2, v, w2 + 0.4, 0.45, d2 + 0.4, ry);
      frostMerlons(c, u, v, top + h2 + 0.02, w2 + 0.4, d2 + 0.4, Tx, Tz);
      frostSnowCap(c, u, v, top + h2 + 0.03, w2 - 0.2, d2 - 0.2, ry);
      frostSnowCap(c, hx, hz, top, w - 0.2, d - 0.2, ry, 0.26);
      // its one dark window
      const [wu, wv] = at(-w * 0.2, -face * d * 0.18 + face * (d2 / 2 + 0.03));
      st.set(0.16, 0.12, 0.1, 2, 0);
      c.solid = false;
      c.prim(UNIT_BOX, wu, top + h2 * 0.5 - 0.2, wv, 0.6, 0.9, 0.14, ry);
      c.solid = true;
      if (c.rng() < 0.6) c.glow(wu, top + h2 * 0.5 - 0.2, wv, 1.0);
    } else {
      // a plain flat roof behind a toothed parapet, deep in snow
      frostMerlons(c, hx, hz, top, w + 0.45, d + 0.45, Tx, Tz);
      frostSnowCap(c, hx, hz, top, w - 0.2, d - 0.2, ry, 0.42);
    }
    // a smoke stack like a small wind tower
    {
      const [u, v] = at(w * 0.3, -face * d * 0.22);
      st.set(wt * 0.94, wt * 0.9, wt * 0.82, 2, 0.05);
      c.prim(UNIT_BOX, u, top + 0.9, v, 0.9, 1.9, 0.9, ry);
      c.prim(UNIT_BOX, u, top + 1.95, v, 1.15, 0.25, 1.15, ry);
      st.set(1.22, 1.24, 1.28, 1, 0.06);
      c.prim(UNIT_BLOB, u, top + 2.12, v, 0.55, 0.22, 0.55);
    }
    // the dark doorway and two deep window slots toward the road; lamps burn behind some at night
    {
      const [u, v] = at(0, face * (d / 2 + 0.02));
      st.set(0.16, 0.12, 0.1, 2, 0);
      c.solid = false;
      c.prim(UNIT_BOX, u, floor + 0.95, v, 1.15, 1.9, 0.4, ry);
      c.solid = true;
    }
    for (const wx of [-w * 0.31, w * 0.31]) {
      const [u, v] = at(wx, face * (d / 2 + 0.02));
      st.set(0.16, 0.12, 0.1, 2, 0);
      c.solid = false;
      c.prim(UNIT_BOX, u, floor + 1.75, v, 0.55, 0.85, 0.3, ry);
      c.solid = true;
      if (c.rng() < 0.75) c.glow(u, floor + 1.75, v, 1.15);
    }
    // snow drifted against the foot of the walls
    for (let q = 0; q < 3; q++) {
      const lx = c.r(-w / 2, w / 2);
      const [u, v] = at(lx, -face * (d / 2 + 0.3) * (q === 0 ? -1 : 1) + (q === 0 ? face * 0.5 : 0));
      if (q === 0 && Math.abs(lx) < 1.4) continue; // not across the door
      st.set(1.2, 1.22, 1.27, 1, 0.1);
      c.solid = false;
      c.prim(UNIT_BLOB, u, c.g(u, v) + 0.1, v, c.r(1.2, 2.2), c.r(0.45, 0.8), c.r(0.8, 1.2), ry + c.r(-0.3, 0.3));
      c.solid = true;
    }
    // a lamp by one door in three; the lit windows and the fire pit do the rest
    if (k % 3 === 0) {
      const [u, v] = at(w * 0.5 + 0.7, face * (d / 2 + 0.9));
      frostTorch(c, u, v, 0.9);
    }
    // a stack of logs at the back, under snow
    if (c.rng() < 0.7) {
      const [u, v] = at(-w * 0.2, -face * (d / 2 + 0.7));
      const gl = c.g(u, v);
      st.set(0.5, 0.36, 0.25, 2, 0.05);
      c.prim(UNIT_BOX, u, gl + 0.45, v, 2.4, 0.9, 0.9, ry);
      st.set(1.22, 1.24, 1.28, 1, 0.08);
      c.prim(UNIT_BLOB, u, gl + 0.95, v, 1.3, 0.3, 0.6, ry);
    }
  }
  // a fire pit beside the road, ringed with stone
  {
    const fu = ox + Nx * (hw + 3.2);
    const fv = oz + Nz * (hw + 3.2);
    const g = c.g(fu, fv);
    st.set(0.62, 0.58, 0.55, 1, 0.12);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      c.prim(UNIT_BOX, fu + Math.cos(a) * 1.3, g + 0.35, fv + Math.sin(a) * 1.3, 0.8, 0.7, 0.7, -a);
    }
    st.set(1, 1, 1, 3, 0);
    c.prim(UNIT_CONE, fu, g + 1.0, fv, 0.5, 1.3, 0.5, 0.5);
    c.glow(fu, g + 1.0, fv, 4.5);
  }
  // pines among the houses
  for (let k = 0; k < 9; k++) {
    const a = c.r(-30, 30);
    const side = c.rng() < 0.5 ? -1 : 1;
    const off = side * c.r(19, 34);
    frostPine(c, ox + Tx * a + Nx * off, oz + Tz * a + Nz * off, c.r(0.9, 1.5));
  }
  // the hold at the head of the road: a mud-brick watchtower like the towns', with a great brazier
  const end = way[way.length - 1];
  const eu = end.x - c.x + Tx * 8;
  const ev = end.z - c.z + Tz * 8;
  c.folk = snowVillageFolk({ Tx, Tz, Nx, Nz, ox, oz, hw, kind: village.kind, hold: village.kind === 'high' ? [eu, ev] : null });
  if (village.kind === 'high') {
    const g = c.g(eu, ev);
    const wt = c.r(0.98, 1.06);
    st.set(wt * 0.9, wt * 0.87, wt * 0.8, 2, 0.07);
    c.prim(UNIT_BOX, eu, g + 0.9, ev, 7.4, 3.6, 7.4, ry);
    st.set(wt, wt * 0.96, wt * 0.87, 2, 0.06);
    c.prim(UNIT_BOX, eu, g + 6.2, ev, 4.6, 10, 4.6, ry);
    c.prim(UNIT_BOX, eu, g + 11.3, ev, 5.4, 0.6, 5.4, ry);
    frostMerlons(c, eu, ev, g + 11.6, 5.4, 5.4, Tx, Tz);
    frostSnowCap(c, eu, ev, g + 11.62, 4.3, 4.3, ry);
    frostSnowCap(c, eu, ev, g + 2.72, 7, 7, ry, 0.3);
    // slots up the faces, lit from inside at night
    for (const [lx, lz] of [[0, 2.32], [0, -2.32], [2.32, 0], [-2.32, 0]] as const) {
      for (const y of [4.2, 7.6]) {
        const u = eu + Tx * lx - Tz * lz;
        const v = ev + Tz * lx + Tx * lz;
        st.set(0.16, 0.12, 0.1, 2, 0);
        c.solid = false;
        c.prim(UNIT_BOX, u, g + y, v, lz === 0 ? 0.12 : 0.5, 1.5, lz === 0 ? 0.5 : 0.12, ry);
        c.solid = true;
        c.glow(u, g + y, v, 1.0);
      }
    }
    st.set(0.2, 0.18, 0.17, 1, 0.02);
    c.prim(UNIT_CYL, eu, g + 12.0, ev, 1.1, 0.5, 1.1);
    st.set(1, 1, 1, 3, 0);
    c.prim(UNIT_CONE, eu, g + 13.1, ev, 0.7, 1.9, 0.7, 0.6);
    c.glow(eu, g + 13.0, ev, 9);
    c.glow(eu, g + 12.8, ev, 5);
  }
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

/**
 * A sand-ship, wrecked and long buried, with the sand just blown off it: a keel rising to a tall
 * stem, the ribs of one side standing and the other mostly under, a few strakes still on at the
 * bow, a mast snapped half way and a runner on its struts held up in the air. She lies rolled
 * over and down by the stern. u runs along the keel toward the bow.
 */
function buildWreck(c: Ctx): void {
  const st = c.stone;
  const tk = c.r(0.9, 1.06);
  const L = c.r(34, 44); // keel
  const B = L * c.r(0.13, 0.155); // half breadth amidships
  const D = B * c.r(1.25, 1.5); // depth of hull, keel to rail
  const side = c.rng() < 0.5 ? 1 : -1; // the side she lies on
  const roll = side * c.r(0.24, 0.36);
  const pitch = c.r(0.05, 0.11); // bow up
  const sink = c.r(0.7, 1.3);
  c.foot = L / 2 + 8;
  const g0 = c.g(0, 0);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  // ship coordinates (s along the keel, w to her right hand, h up from the keel) into the site's frame
  const P = (s: number, w: number, h: number): THREE.Vector3 => new THREE.Vector3(s, g0 - sink + s * pitch + h * cr - w * sr, w * cr + h * sr);
  // weathered wood: grey-brown, here and there bleached nearly to bone
  const wood = (k = 1, rough = 0.05): void => {
    st.set(0.5 * tk * k, 0.42 * tk * k, 0.33 * tk * k, 2, rough);
  };

  // the keel, sweeping up into the stem at the bow and a shorter post at the stern
  const keelH = (t: number): number => D * 1.9 * Math.pow(Math.max(0, (t - 0.8) / 0.2), 1.8) + D * 0.9 * Math.pow(Math.max(0, (0.1 - t) / 0.1), 1.6);
  {
    const pts: THREE.Vector3[] = [];
    const radii: number[] = [];
    const N = 26;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      // (the stem leans forward as it climbs)
      const over = Math.pow(Math.max(0, (t - 0.86) / 0.14), 2) * L * 0.05;
      pts.push(P((t - 0.5) * L + over, 0, keelH(t)));
      radii.push(THREE.MathUtils.lerp(0.55, 0.3, Math.abs(t - 0.45) * 1.8));
    }
    wood(0.92, 0.06);
    c.tube(c.toLocal(pts), radii, 5, true, 1.5);
  }

  // the frames: one U of timber at each station, ribs up both sides. Half of what was on the
  // low side is under the sand anyway; of the rest some have snapped.
  const half = (t: number): number => B * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.92 + 0.06))), 0.6);
  const ribAt = (t: number, sd: number, k: number): THREE.Vector3 => {
    const w = sd * half(t) * (1 - (1 - k) * (1 - k));
    return P((t - 0.5) * L, w, keelH(t) + D * Math.pow(k, 1.55));
  };
  const nRib = 9 + Math.floor(c.rng() * 4);
  const stations: number[] = [];
  for (let i = 0; i < nRib; i++) stations.push(0.13 + (0.7 * i) / (nRib - 1));
  for (const t of stations) {
    for (const sd of [-1, 1]) {
      const high = sd !== side;
      if (!high && c.rng() < 0.2) continue;
      const broken = c.rng() < (high ? 0.2 : 0.4);
      const kmax = broken ? c.r(0.3, 0.7) : c.r(0.94, 1.06);
      const pts: THREE.Vector3[] = [];
      const radii: number[] = [];
      const N = 7;
      for (let j = 0; j <= N; j++) {
        const k = (j / N) * kmax;
        pts.push(ribAt(t, sd, k));
        radii.push(THREE.MathUtils.lerp(0.46, 0.26, k));
      }
      wood(c.rng() < 0.2 ? c.r(1.25, 1.5) : c.r(0.9, 1.08));
      c.tube(c.toLocal(pts), radii, 5, true, 1.3);
    }
  }

  // strakes still fastened along the high side toward the bow, each a little shorter than the
  // one under it
  {
    const rows = [0.62, 0.9];
    for (let r = 0; r < rows.length; r++) {
      const k = rows[r];
      const from = 0.56 + r * 0.09 + c.r(-0.03, 0.03);
      const pts: THREE.Vector3[] = [];
      const radii: number[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = THREE.MathUtils.lerp(from, 0.9, i / 8);
        const p = ribAt(Math.min(t, 0.83), -side, k);
        // past the last frame the planks run in to the stem
        const close = Math.max(0, (t - 0.83) / 0.07);
        p.lerp(P((t - 0.5) * L, 0, keelH(t) + D * Math.pow(k, 1.55)), close * 0.85);
        pts.push(p);
        radii.push(0.48);
      }
      wood(c.r(0.82, 1.0), 0.03);
      c.solid = false;
      c.tube(c.toLocal(pts), radii, 4, true, 0.22);
      c.solid = true;
    }
  }

  // the mast, snapped: the stump stands in her, the rest lies out on the sand with its yard
  {
    const mt = 0.56;
    const stump = D * c.r(1.7, 2.3);
    const a = P((mt - 0.5) * L, 0, keelH(mt) + 0.2);
    const b = P((mt - 0.5) * L - 0.6, side * 0.4, keelH(mt) + stump);
    wood(0.86, 0.04);
    c.tube(c.toLocal([a, b]), [0.44, 0.36], 6, true);
    // the fallen length, lying the way she rolled
    const len = D * c.r(2.2, 3.0);
    const u = (mt - 0.5) * L - c.r(1, 4);
    const v = side * (B + len * 0.5 + c.r(0.5, 2));
    const yaw = c.r(-0.35, 0.35);
    wood(0.95, 0.04);
    c.prim(UNIT_CYL, u, c.g(u, v) + 0.22, v, 0.34, len, 0.34, yaw, 0, Math.PI / 2 + c.r(-0.05, 0.05));
    const yu = u + Math.sin(yaw) * len * 0.3;
    const yv = v + side * len * 0.28;
    c.prim(UNIT_CYL, yu, c.g(yu, yv) + 0.5, yv, 0.2, len * 0.75, 0.2, yaw + Math.PI / 2 + c.r(-0.3, 0.3), 0, Math.PI / 2 + c.r(0.08, 0.2));
  }

  // what she ran on: a long runner out on two struts, now carried up on the high side
  {
    const out = B * 1.75;
    const drop = D * 0.12;
    const pts: THREE.Vector3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const s = THREE.MathUtils.lerp(-0.26, 0.24, t) * L;
      // turned up at the toe like a sledge's
      pts.push(P(s, -side * out, drop + Math.pow(Math.max(0, (t - 0.7) / 0.3), 2) * D * 0.55));
      radii.push(0.34);
    }
    wood(1.04, 0.03);
    c.tube(c.toLocal(pts), radii, 4, true, 0.4);
    for (const t of [0.32, 0.6]) {
      const s = (t - 0.5) * L;
      wood(0.9, 0.03);
      c.tube(c.toLocal([ribAt(t, -side, 0.55), P(s, -side * out, drop + 0.2)]), [0.24, 0.2], 5, false);
      c.tube(c.toLocal([ribAt(t, -side, 0.95), P(s + L * 0.03, -side * out, drop + 0.2)]), [0.18, 0.16], 5, false);
    }
  }

  // sprung planks and broken ends, strewn down the side she fell on
  for (let i = 0; i < 7; i++) {
    const u = c.r(-0.45, 0.4) * L;
    const v = side * (B * c.r(0.9, 2.6));
    wood(c.r(0.8, 1.35), 0.02);
    c.prim(UNIT_BIT, u, c.g(u, v) + 0.1, v, c.r(1.8, 4.2), 0.16, c.r(0.35, 0.6), c.rng() * 6, c.r(-0.12, 0.12), c.r(-0.1, 0.1));
  }
}

/**
 * A tended temple: a stepped sandstone platform with a walled shrine on top, a columned porch,
 * a stair down to an avenue of obelisks, and braziers that burn after dark. Its keepers stand
 * by the door and pilgrims walk the avenue, so it records where they go.
 */
function buildTemple(c: Ctx): void {
  const st = c.stone;
  const tk = c.r(0.95, 1.05);
  const sand = (k: number, rough = 0.05) => st.set(1.22 * tk * k, 1.1 * tk * k, 0.94 * tk * k, 0, rough);
  const L = c.r(26, 32); // platform, along the axis
  const W = c.r(18, 22);
  const TIERS = 3;
  const TH = 0.8; // each tier: low enough to step up
  const SET = 1.3; // and set this far in from the one below

  // A footing from below the lowest ground to just above the highest, so it sits level.
  let gmin = Infinity;
  let gmax = -Infinity;
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const g = c.g((i / 2) * (L / 2 + 1), (j / 2) * (W / 2 + 1));
      gmin = Math.min(gmin, g);
      gmax = Math.max(gmax, g);
    }
  }
  const base = gmax + 0.2;
  sand(0.9, 0.08);
  c.prim(UNIT_BOX, 0, (gmin - 1.5 + base) / 2, 0, L + 1, base - gmin + 1.5, W + 1);
  let y = base;
  for (let t = 0; t < TIERS; t++) {
    sand(t % 2 ? 0.95 : 1.02);
    c.prim(UNIT_BOX, 0, y + TH / 2, 0, L - t * 2 * SET, TH, W - t * 2 * SET);
    y += TH;
  }
  const top = y;
  const tl = L - (TIERS - 1) * 2 * SET;
  const tw = W - (TIERS - 1) * 2 * SET;

  // The stair: from the sand in front up onto the top tier.
  const SW = 6;
  const TREAD = 0.75;
  const front = tl / 2;
  const gFoot = c.g(front + 8, 0);
  const n = Math.max(2, Math.ceil((top - gFoot) / 0.42));
  const rise = (top - gFoot) / n;
  sand(0.97, 0.03);
  for (let k = 0; k < n; k++) {
    const u0 = front + (n - 1 - k) * TREAD;
    const uc = u0 + TREAD / 2;
    const stepTop = gFoot + (k + 1) * rise;
    const bottom = Math.min(gFoot, c.g(uc, 0)) - 0.6;
    c.prim(UNIT_BOX, uc, (bottom + stepTop) / 2, 0, TREAD + 0.02, stepTop - bottom, SW);
  }
  const foot = front + n * TREAD; // where the stair meets the sand
  // cheek walls either side of the stair
  sand(0.9, 0.06);
  for (const s of [-1, 1]) {
    const len = n * TREAD;
    const tilt = Math.atan2(top - gFoot, len);
    c.prim(UNIT_BOX, front + len / 2, (top + gFoot) / 2 - 0.1, s * (SW / 2 + 0.5), len / Math.cos(tilt) + 0.4, 1.1, 1.0, 0, 0, -tilt);
  }

  // The shrine: four walls with a doorway, set toward the back of the top tier.
  const cu = -tl * 0.12;
  const Lc = tl * 0.56;
  const Wc = tw * 0.64;
  const Hc = c.r(7, 9);
  const WT = 1.1;
  const D = 3.2;
  const Dh = 4.6;
  sand(1.0, 0.07);
  c.prim(UNIT_BOX, cu - Lc / 2 + WT / 2, top + Hc / 2, 0, WT, Hc, Wc);
  for (const s of [-1, 1]) c.prim(UNIT_BOX, cu, top + Hc / 2, s * (Wc / 2 - WT / 2), Lc, Hc, WT);
  const fu = cu + Lc / 2 - WT / 2;
  const side = (Wc - D) / 2;
  for (const s of [-1, 1]) c.prim(UNIT_BOX, fu, top + Hc / 2, s * (D / 2 + side / 2), WT, Hc, side);
  c.prim(UNIT_BOX, fu, top + Dh + (Hc - Dh) / 2, 0, WT, Hc - Dh, D + 0.2);
  // pilasters down the long walls, and a darker carved band near the top
  sand(0.93, 0.05);
  const np = Math.max(3, Math.round(Lc / 3.2));
  for (let i = 0; i <= np; i++) {
    const u = cu - Lc / 2 + 0.4 + (i / np) * (Lc - 0.8);
    for (const s of [-1, 1]) c.prim(UNIT_BOX, u, top + Hc / 2, s * (Wc / 2 + 0.15), 0.7, Hc, 0.4);
  }
  st.set(0.98 * tk, 0.82 * tk, 0.68 * tk, 0, 0.04);
  c.prim(UNIT_BOX, cu, top + Hc * 0.74, 0, Lc + 0.5, 0.7, Wc + 0.5);
  // the door frame stands proud
  c.prim(UNIT_BOX, fu + 0.35, top + Dh + 0.35, 0, 0.5, 0.7, D + 1.4);
  for (const s of [-1, 1]) c.prim(UNIT_BOX, fu + 0.35, top + Dh / 2, s * (D / 2 + 0.35), 0.5, Dh, 0.7);

  // The porch: a row of columns in front of the door, under one roof with the shrine.
  const pu = fu + 3.4;
  sand(1.03, 0.04);
  const vs = [-(Wc / 2 - 0.9), -(D / 2 + 1.0), D / 2 + 1.0, Wc / 2 - 0.9];
  for (const v of vs) {
    c.prim(UNIT_BOX, pu, top + 0.25, v, 1.6, 0.5, 1.6);
    let yy = top + 0.5;
    const capY = top + Hc - 0.7;
    while (yy < capY - 0.1) {
      const dh = Math.min(1.6, capY - yy);
      c.prim(UNIT_CYL, pu, yy + dh / 2, v, 0.58, dh * 0.99, 0.58, c.rng() * 3);
      yy += dh;
    }
    c.prim(UNIT_BOX, pu, top + Hc - 0.35, v, 1.5, 0.7, 1.5);
  }
  // roof: a slab over shrine and porch, a cornice, and a stepped crown
  sand(1.0, 0.05);
  const r0 = cu - Lc / 2 - 0.8;
  const r1 = pu + 1.2;
  c.prim(UNIT_BOX, (r0 + r1) / 2, top + Hc + 0.45, 0, r1 - r0, 0.9, Wc + 1.6);
  sand(0.94, 0.04);
  c.prim(UNIT_BOX, (r0 + r1) / 2, top + Hc + 1.2, 0, r1 - r0 - 1.2, 0.6, Wc + 0.4);
  sand(1.02, 0.05);
  c.prim(UNIT_BOX, cu, top + Hc + 2.0, 0, Lc * 0.62, 1.0, Wc * 0.58);
  c.prim(UNIT_BOX, cu, top + Hc + 2.9, 0, Lc * 0.3, 0.8, Wc * 0.28);
  // a carved disc on the pediment, facing out
  st.set(0.96 * tk, 0.8 * tk, 0.66 * tk, 0, 0.02);
  c.prim(UNIT_CYL, r1 + 0.05, top + Hc + 1.25, 0, 0.9, 0.3, 0.9, 0, 0, Math.PI / 2);

  // Inside: an altar with a flame on it, seen through the door.
  sand(0.88, 0.04);
  const au = cu - Lc / 2 + WT + 1.6;
  c.prim(UNIT_BOX, au, top + 0.6, 0, 1.8, 1.2, 3.0);
  st.set(1, 1, 1, 3, 0);
  c.prim(UNIT_BOX, au, top + 1.35, 0, 0.5, 0.3, 0.5, 0.6);
  c.glow(au, top + 1.6, 0, 0.9);
  c.glow(au, top + 1.8, 0, 4.5);
  // A low stone before the altar, where something is left for whoever walks in (see setOffers).
  const ou = au + 2.7;
  sand(0.92, 0.04);
  c.prim(UNIT_BOX, ou, top + 0.22, 0, 1.0, 0.44, 1.0);
  st.set(0.98 * tk, 0.82 * tk, 0.68 * tk, 0, 0.04);
  c.prim(UNIT_BOX, ou, top + 0.49, 0, 1.16, 0.1, 1.16);

  // Braziers: either side of the door and of the stair's foot. They burn after dark.
  const brazier = (u: number, v: number, gy: number) => {
    sand(0.86, 0.03);
    c.prim(UNIT_CYL, u, gy + 0.55, v, 0.36, 1.1, 0.36);
    st.set(0.42, 0.36, 0.3, 2, 0);
    c.prim(UNIT_CYL, u, gy + 1.22, v, 0.62, 0.26, 0.62);
    st.set(1, 1, 1, 3, 0);
    c.prim(UNIT_BOX, u, gy + 1.44, v, 0.45, 0.22, 0.45, 0.7);
    c.glow(u, gy + 1.7, v, 1.0);
    c.glow(u, gy + 1.9, v, 6.5);
  };
  for (const s of [-1, 1]) {
    brazier(front - 1.0, s * (SW / 2 + 1.0), top);
    const bu = foot + 1.6;
    const bv = s * (SW / 2 + 1.4);
    brazier(bu, bv, c.g(bu, bv));
  }

  // Clay jars of offerings by the door: small enough to walk through.
  c.solid = false;
  for (let i = 0; i < 5; i++) {
    const s = i % 2 ? 1 : -1;
    const v = s * c.r(D / 2 + 0.5, D / 2 + 2.2);
    const u = fu + c.r(0.9, 2.2);
    const k = c.r(0.85, 1.1);
    st.set(0.62 * k, 0.38 * k, 0.26 * k, 2, 0.02);
    const r = c.r(0.22, 0.32);
    c.prim(UNIT_BLOB, u, top + r * 0.9, v, r, r * 1.3, r, c.rng() * 6);
  }

  // The avenue: paving out from the stair, with pairs of obelisks along it.
  const A = c.r(26, 44);
  sand(0.9, 0.02);
  for (let u = foot + 0.6; u < foot + A; u += 2.05) {
    const g = c.g(u, 0);
    const tilt = Math.atan2(c.g(u + 1, 0) - c.g(u - 1, 0), 2);
    // flush with the sand, and sometimes drifted over
    if (c.rng() < 0.12) continue;
    c.prim(UNIT_BOX, u, g - 0.06, c.r(-0.1, 0.1), 1.95, 0.12, SW - 1.6, c.r(-0.02, 0.02), 0, tilt);
  }
  c.solid = true;
  for (let u = foot + 7; u < foot + A - 2; u += c.r(8, 11)) {
    for (const s of [-1, 1]) {
      const v = s * (SW / 2 + 1.8);
      const g = c.g(u, v);
      const H = c.r(4.5, 6.5) * (c.rng() < 0.2 ? c.r(0.35, 0.6) : 1);
      sand(c.r(0.92, 1.04), 0.04);
      c.prim(UNIT_BOX, u, g + 0.2, v, 1.5, 0.8, 1.5);
      c.prim(UNIT_SLAB, u, g + 0.6 + H / 2, v, 0.85, H, 0.85, 0, c.r(-0.03, 0.03), c.r(-0.03, 0.03));
      c.prim(UNIT_CONE, u, g + 0.6 + H + 0.35, v, 0.5, 0.7, 0.5, Math.PI / 4);
    }
  }

  c.foot = Math.max(L, W) / 2 + 12;
  // Where people go: the door (keepers stand either side), and the stair's foot (pilgrims kneel there).
  const yawOut = Math.atan2(c.cy, -c.sy);
  const local = (u: number, v: number, yy: number): [number, number, number] => {
    c.at(u, v);
    return [c.lx, yy, c.lz];
  };
  const keepU = (pu + front) / 2 + 0.6;
  const kv = -(SW / 2 + 2.6);
  c.temple = {
    foot: local(foot + 2.5, 0, c.g(foot + 2.5, 0)),
    end: local(foot + A, 0, c.g(foot + A, 0)),
    yaw: yawOut,
    offer: local(ou, 0, top + 0.54),
    keep: [
      [...local(keepU, D / 2 + 1.6, top), yawOut + c.r(-0.4, 0.2)],
      [...local(foot + 1.6, kv, c.g(foot + 1.6, kv)), yawOut + c.r(0.4, 1.2)],
    ],
  };
}

// ------------------------------------------------------------------ caverns

/** A cavern as the discoveries know it: the entrance the terrain cuts, and the deep under it. */
export interface CavernSite {
  key: number;
  cav: Cavern;
  /** Which of the five deeps lies under it. Neighbouring cells never share one. */
  kind: DeepKind;
  /** The room the deep may be cut in, in its own frame (see DeepSpec), and the lid over it. */
  u1: number;
  v0: number;
  v1: number;
  lid: number;
  /** What the site rolled, for the deep to hold: a seam of mineral, carved slabs, a relic. */
  vein: boolean;
  carvings: boolean;
  relic: boolean;
  seed: number;
  /** Strikes landed on the spot so far. */
  hits: number;
  /** The deep, while it is built. */
  deep: Deep | null;
  /** The middle of the hole in the antechamber floor: the deep's origin. */
  hx: number;
  hz: number;
}

/**
 * The key of the site that is a cavern's roof. A cavern's own key is its cell's (it is what the
 * save knows it by), and so is the key of the find on the surface that the cell may also have.
 */
const roofKey = (cs: CavernSite): number => cs.key + 0.5;

/** What the outside world calls a built site's key: an integer, a cavern's kept apart from its cell's surface find. */
const CAVERN_REF = -2e12;
const refKey = (key: number): number => (Number.isInteger(key) ? key : CAVERN_REF - Math.floor(key));

/** A discovery site as the tools see it, built yet or not. `key` is stable across visits and unique per site. */
export interface SiteRef {
  key: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  reached: boolean;
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
 * An open cavern's entrance: the sand left standing over it as a roof (the terrain cuts the
 * slot, as it does for a cave), and daylight falling in under the brow. What the place holds
 * is all below, in the deep.
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
  // the sand itself, a hand's width proud of the ground, tucked under it round the rim (and
  // along the brow to either side of the opening, where the ground is uncut)
  const lift = (i: number, j: number) => {
    if (j === 0 || j === NV || i === NU) return -0.04;
    return i === 0 && Math.abs(vAt(u0, j) - cavLine(cv, u0)) > cavHalf(cv, u0) + 1 ? -0.04 : 0.05;
  };
  const top = (i: number, j: number) => {
    const u = uAt(i);
    const v = vAt(u, j);
    face(u, v, F);
    c.at(u, v);
    rk.vert(c.lx, F.y + lift(i, j), c.lz, F.nx, F.ny, F.nz, F.rock, F.salt, 0);
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
        const ya = face(u0, vAt(u0, j), F).y + lift(0, j);
        const yb = face(u0, vAt(u0, j + 1), F).y + lift(0, j + 1);
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
  temple?: TempleMarks;
  /** For a village: its people. */
  folk?: VillageFolk[];
  /** For a temple: what lies on the stone before its altar now, if anything. */
  offer?: { kind: Offering; obj: THREE.Group };
}

/** Where people go at a temple, in world coordinates. */
export interface TempleMarks {
  /** The foot of the stair, where pilgrims arrive and kneel. */
  foot: { x: number; y: number; z: number };
  /** The far end of the avenue. */
  end: { x: number; y: number; z: number };
  /** Heading straight out along the avenue (atan2(dx, dz)). */
  yaw: number;
  /** Where the keepers stand, and which way they face. */
  keep: { x: number; y: number; z: number; yaw: number }[];
  /** The top of the stone before the altar, where an offering lies. */
  offer: { x: number; y: number; z: number };
}

/** Someone's place in a village, in world coordinates: where they stand or sit, and which way they face (atan2(dx, dz)). */
export interface VillageFolk {
  x: number;
  z: number;
  yaw: number;
  sit: boolean;
  role: FolkRole;
  small: boolean;
  /** Their cloth, where the place has colours of its own. */
  coat?: [number, number, number];
  /** The height they stand at, where it is not the ground (a deck, a terrace). */
  y?: number;
}

/** A built village and its people: at the foot of a mountain, up in the snow, or one of the settlements out on the sand. */
export interface Village {
  key: number;
  /** The site's kind: 'mountain-village', 'snow-village' or one of the settlements. */
  kind: string;
  snow: boolean;
  x: number;
  z: number;
  folk: VillageFolk[];
}

/** Small things left lying up a mountain for whoever is sent after them: boots at the back of its cave, a feather on its summit. */
export type Stray = 'boots' | 'feather';

/** A built place in the open desert that people might walk to. */
export interface Landmark {
  key: number;
  kind: string;
  x: number;
  z: number;
  temple?: TempleMarks;
}

/** Sites that are not somewhere to walk to: underground, or up a mountain. */
const NOT_LANDMARKS = new Set(['cavern', 'lamp', 'summit', 'cave', 'spring', 'snow-village', 'frostway']);

/** The mud-brick pieces, as the settlements' builders are lent them. */
const KIT: Kit = {
  BOX: UNIT_BOX,
  CYL: UNIT_CYL,
  SLAB: UNIT_SLAB,
  BLOB: UNIT_BLOB,
  CONE: UNIT_CONE,
  BIT: UNIT_BIT,
  PEBBLE: UNIT_PEBBLE,
  house: mudHouse,
  well: mudWell,
  tower: mudTower,
  torch: frostTorch,
  bunting,
  cart: handCart,
  palm: addPalm,
  hay: hayStack,
  merlons: frostMerlons,
};

/** Where a route's caravanserai stands, and the way its gate faces (toward the road). */
interface Inn {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

export class Discoveries {
  readonly group = new THREE.Group();
  /** Called (at most once per site) when the player first comes within ~25 m of a site: what it is, its key, and where it stands. */
  onReach: ((kind: string, key: number, x: number, z: number) => void) | null = null;

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
  /** Every cell's surface find as surfaceSite worked it out (null for an empty cell). */
  private readonly placeCache = new Map<number, Landmark | null>();
  /** The rock caps over springs that are built now, by site key. */
  private readonly caps = new Map<number, Spring>();
  private scanT = 0;
  private readonly lead: Lead = { x: 0, z: 0 };
  private readonly want: { cx: number; cz: number; d2: number }[] = [];

  /** The sand over a cavern has finished draining away: it is open for good. */
  onOpened: ((key: number) => void) | null = null;
  /** A waking stone has been touched. */
  onWoken: ((key: number) => void) | null = null;
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
  private readonly woken = new Set<number>();
  /** The caverns the terrain is shaped by now: the nearest few. */
  private active: CavernSite[] = [];
  private draining: CavernSite | null = null;
  /** The caverns whose deep is built now: the nearest one or two that are open. */
  private readonly deeps: CavernSite[] = [];
  /** The one the wanderer is down in, if any. */
  private inside: CavernSite | null = null;
  private readonly glowOut = [0, 0, 0, 0];
  /** How much detail a deep is built with: 0 high, 1 low, 2 mobile. One already built keeps what it had. */
  tier: 0 | 1 | 2 = 0;
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
  restore(opened: readonly number[], taken: readonly number[], woken: readonly number[] = []): void {
    for (const k of opened) this.opened.add(k);
    for (const k of taken) this.taken.add(k);
    for (const k of woken) this.woken.add(k);
  }

  /** How many waking stones have been woken. */
  get wokenCount(): number {
    return this.woken.size;
  }

  /** The built deep whose sleeping stone is within reach of the point, or null. */
  private stoneSite(x: number, y: number, z: number, reach = 3.2): CavernSite | null {
    for (const cs of this.deeps) {
      const st = cs.deep!.stone;
      if (!st || cs.deep!.woken) continue;
      if (Math.hypot(st[0] - x, st[1] - (y + 1), st[2] - z) < reach) return cs;
    }
    return null;
  }

  /** Whether the point is within reach of a stone that is still asleep. */
  stoneNear(x: number, y: number, z: number): boolean {
    return this.stoneSite(x, y, z) !== null;
  }

  /** The point of the sleeping stone nearest the wanderer within reach, for the key cue; or null. */
  stoneAt(x: number, y: number, z: number): [number, number, number] | null {
    return this.stoneSite(x, y, z)?.deep!.stone ?? null;
  }

  /** Wake the stone the wanderer stands at: its light spreads, and stays. False if none was in reach. */
  wakeStone(x = 0, y = 0, z = 0, reach = 3.2): boolean {
    const cs = this.stoneSite(x, y, z, reach);
    if (!cs) return false;
    cs.deep!.wake(false);
    this.woken.add(cs.key);
    this.onWoken?.(cs.key);
    return true;
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
   * Whether a cell hides a cavern, and exactly how it lies. Any cell may, one with a find on
   * the surface included (the entrance then keeps well clear of it). The entrance needs open
   * sand level enough to leave a roof over the whole of it; its floor is set from the lowest
   * ground above, so the roof is nowhere thinner than cavernCover. The deep under it needs only
   * room: a rectangle inside the cell, clear of rivers and cities.
   */
  private findCavern(cx: number, cz: number, key: number): CavernSite | null {
    const w = this.world;
    const s = w.seed | 0;
    if (hash4(cx, cz, s, 9) >= CAVERN_P) return null;
    // A cell with a find of its own on the surface can hide a cavern too, well away from it.
    const shared = this.cellSite(cx, cz);
    const sx = this.cellPos.x;
    const sz = this.cellPos.z;
    const x0 = shared ? cx * CELL + MARGIN + hash4(cx, cz, s, 22) * (CELL - 2 * MARGIN) : sx;
    const z0 = shared ? cz * CELL + MARGIN + hash4(cx, cz, s, 23) * (CELL - 2 * MARGIN) : sz;
    const cities = (w as Partial<{ cities: { at(x: number, z: number): { cx: number; cz: number; radius: number } } }>).cities;
    const cityNear = (x: number, z: number): boolean => {
      if (!cities) return false;
      const c = cities.at(x, z);
      return Math.hypot(c.cx - x, c.cz - z) < c.radius + CITY_CLEAR;
    };
    const q = this.sample;
    const seed = Math.floor(hash4(cx, cz, s, 12) * 4294967296);
    const rng = mulberry32(seed);
    // The rolls are made in the order they always were (there used to be three shapes of
    // cavern, which is what `was` is), so a site keeps its spot, its bearing and what it holds.
    const was = Math.floor(rng() * 3) % 3;
    const rHalf = rng();
    const wasBend = was === 1 ? (rng() < 0.5 ? -1 : 1) * (9 + rng() * 2) : was === 2 ? (rng() - 0.5) * 6 : 0;
    const rChamber = rng();
    if (was === 2) rng();
    const vein = rng() < (was === 2 ? 0.5 : 0.75);
    const carvings = rng() < (vein ? 0.5 : 0.9);
    const relic = rng() < 0.35;
    const yaw0 = rng() * Math.PI * 2;
    const T = TERRAIN;
    // The entrance: the ramp, then a short level antechamber a little wider at its end, with
    // the hole in its floor near the back wall.
    const half = 4.2 + rHalf * 0.6;
    const bulge = 1.6;
    const chamber = 20 + rChamber * 2;
    // (and the ground the old shape asked for)
    const wasW = Math.abs(wasBend) + [4.5, 4, 5][was] + rHalf * 0.8 + [4.5, 3, 4.5][was] + 5;
    const wasMax = 2 + T.cavernRampMax + [24, 30, 30][was] + rChamber * 4 + 5;
    const holeBack = DEEP_HOLE.halfU + 3; // from the back wall to the middle of the hole
    // Each cell has one kind of deep, dealt so that no two cells that touch, corners included, share one.
    const kind = ((((cx + 2 * cz + (s % 5)) % 5) + 5) % 5) as DeepKind;
    // Dunes leave few places level enough, so a handful of spots around the cell's own are
    // tried, each with the cavern lying several ways, and the first that fits is the one. The
    // first pass asks for as much level ground, and looks the same six ways, as the caverns
    // before the deeps did, so that one found then is found in the same place now; the second
    // asks only for what the entrance needs, and looks twelve ways. The third is there so that
    // more cells hold one: it comes nearer the cell's find on the surface, and takes a spot less
    // level (the ring and the light over it show where the cracks alone would not). Each pass
    // only ever adds: a cavern found by an earlier one is never moved by a later.
    let rooms = 0;
    for (let pass = 0; pass < 3; pass++) {
      const ways = pass === 0 ? 6 : 12;
      const siteClear = pass === 2 ? SITE_CLEAR_NEAR : SITE_CLEAR;
      const tilt = pass === 2 ? 2 : 1.3;
      const uMax = pass === 0 ? wasMax : 2 + T.cavernRampMax + chamber + 5;
      const W = pass === 0 ? wasW : half + bulge + 5;
      const spots = pass === 0 ? 8 : SPOTS;
      for (let k = 0; k < spots * ways; k++) {
        const spot = Math.floor(k / ways);
        // (the first eight spots lie round the cell's own; the rest are anywhere in it)
        const x = Math.fround(spot < 8 ? x0 + (spot === 0 ? 0 : (hash4(cx, cz, s, 40 + spot) - 0.5) * 240) : (cx + 0.12 + 0.76 * hash4(cx, cz, s, (spot < 24 ? 60 : 120) + spot)) * CELL);
        const z = Math.fround(spot < 8 ? z0 + (spot === 0 ? 0 : (hash4(cx, cz, s, 50 + spot) - 0.5) * 240) : (cz + 0.12 + 0.76 * hash4(cx, cz, s, (spot < 24 ? 90 : 190) + spot)) * CELL);
        if (k % ways === 0) {
          w.sample(x, z, q);
          if (q.rock > 0.08 || q.salt > 0.25 || this.riverAt(x, z) < RIVER_CLEAR || cityNear(x, z) || (shared && Math.hypot(x - sx, z - sz) < siteClear)) {
            k += ways - 1;
            continue;
          }
        }
        const top = w.height(x, z);
        const yaw = yaw0 + (k * 2 * Math.PI) / ways;
        const dx = Math.fround(Math.cos(yaw));
        const dz = Math.fround(Math.sin(yaw));
        {
          // the spot to dig lies some way down the ramp, and must be close to level, or the mark on it could not be seen
          const px = x + dx * 15;
          const pz = z + dz * 15;
          if (Math.max(Math.abs(w.height(px + 6, pz) - w.height(px - 6, pz)), Math.abs(w.height(px, pz + 6) - w.height(px, pz - 6))) > tilt) continue;
        }
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
        const floor = Math.fround(lo - (T.cavernHeight + T.cavernCover));
        const drop = top - floor;
        const ramp = Math.min(T.cavernRampMax, drop / T.cavernSlope);
        const len = 2 + ramp + chamber;
        const hole = Math.fround(len - holeBack);
        // the deep: its room has to lie inside this cell, under ground that leaves it a lid
        const hx = x + dx * hole;
        const hz = z + dz * hole;
        const room = this.fitRoom(cx, cz, hx, hz, dx, dz);
        if (!room) continue;
        // (measuring the ground over a room is the dear part, so only a few are measured)
        if (++rooms > ROOMS_MAX) return null;
        const lid = this.roomLid(hx, hz, dx, dz, room, floor);
        if (lid === null) continue;
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
          // (the spot to dig is 40% of the way down the ramp: well inside the open sinkhole, short of the roof)
          cav: { x, z, spot: 2 + ramp * 0.4, dx, dz, top, floor, half, bend: 0, bulge, len, ramp, roof: 2 + ramp * a, hole, open, dimple: DIMPLE },
          kind,
          u1: room.u1,
          v0: room.v0,
          v1: room.v1,
          lid,
          vein,
          carvings,
          relic,
          seed,
          hits: 0,
          deep: null,
          hx,
          hz,
        };
      }
    }
    return null;
  }

  private readonly room = { u1: 0, v0: 0, v1: 0 };

  /**
   * The room for a deep whose hole is at (hx, hz) and whose stair runs down along (dx, dz): u
   * from 0 to u1 and v from v0 to v1, each 280 to 360 m, wholly inside the cell (so no two
   * deeps, and no deep and a neighbour's entrance, can ever meet). The smallest is fitted first,
   * as near to centred on the hole as the cell allows, then grown. Null if even that does not fit.
   */
  private fitRoom(cx: number, cz: number, hx: number, hz: number, dx: number, dz: number): { u1: number; v0: number; v1: number } | null {
    const ax = cx * CELL + 6;
    const az = cz * CELL + 6;
    const bx = (cx + 1) * CELL - 6;
    const bz = (cz + 1) * CELL - 6;
    const inCell = (u: number, v: number): boolean => {
      const px = hx + u * dx - v * dz;
      const pz = hz + u * dz + v * dx;
      return px > ax && px < bx && pz > az && pz < bz;
    };
    const fits = (u1: number, v0: number, v1: number): boolean => inCell(0, v0) && inCell(0, v1) && inCell(u1, v0) && inCell(u1, v1);
    for (const off of [0, 20, -20, 40, -40, 60, -60, 80, -80]) {
      let v0 = -DEEP_MIN / 2 + off;
      let v1 = v0 + DEEP_MIN;
      let u1 = DEEP_MIN;
      if (!fits(u1, v0, v1)) continue;
      while (u1 < DEEP_MAX_ROOM && fits(u1 + 20, v0, v1)) u1 += 20;
      for (let i = 0; i < 4 && v1 - v0 < DEEP_MAX_ROOM; i++) {
        if (i % 2 === 0 ? fits(u1, v0 - 20, v1) : fits(u1, v0, v1 + 20)) {
          if (i % 2 === 0) v0 -= 20;
          else v1 += 20;
        }
      }
      const r = this.room;
      r.u1 = u1;
      r.v0 = v0;
      r.v1 = v1;
      return r;
    }
    return null;
  }

  /**
   * The lid over a deep's room, in its own frame (the hole at (hx, hz), the antechamber floor
   * at y): the lowest ground anywhere over the room, as it is with nothing cut into it, less a
   * margin, and never above 3 m under the antechamber floor. Null where a river runs over the
   * room, a city stands near it, or the ground over it falls so far that the deep would have
   * to start a long way down.
   */
  private roomLid(hx: number, hz: number, dx: number, dz: number, room: { u1: number; v0: number; v1: number }, y: number): number | null {
    const w = this.world as World & Partial<{ uncarved(x: number, z: number): number; cities: { at(x: number, z: number): { cx: number; cz: number; radius: number } } }>;
    const ground = w.uncarved ? w.uncarved.bind(w) : w.height.bind(w);
    const STEP = 10;
    const nu = Math.ceil((room.u1 + 2 * STEP) / STEP);
    const nv = Math.ceil((room.v1 - room.v0 + 2 * STEP) / STEP);
    // rivers and cities first: they are cheap to ask after, on a coarse grid
    for (let i = 0; i <= nu; i += 3) {
      for (let j = 0; j <= nv; j += 3) {
        const u = -STEP + (i / nu) * (room.u1 + 2 * STEP);
        const v = room.v0 - STEP + (j / nv) * (room.v1 - room.v0 + 2 * STEP);
        const px = hx + u * dx - v * dz;
        const pz = hz + u * dz + v * dx;
        if (this.riverAt(px, pz) < TERRAIN.riverFloor + 40) return null;
        if (w.cities && (i === 0 || i >= nu - 2) && (j === 0 || j >= nv - 2)) {
          const c = w.cities.at(px, pz);
          if (Math.hypot(c.cx - px, c.cz - pz) < c.radius + 200) return null;
        }
      }
    }
    let lo = Infinity;
    for (let i = 0; i <= nu; i++) {
      for (let j = 0; j <= nv; j++) {
        const u = -STEP + (i / nu) * (room.u1 + 2 * STEP);
        const v = room.v0 - STEP + (j / nv) * (room.v1 - room.v0 + 2 * STEP);
        lo = Math.min(lo, ground(hx + u * dx - v * dz, hz + u * dz + v * dx));
        if (lo - y - LID_MARGIN < LID_DEEPEST) return null;
      }
    }
    return Math.min(-3, lo - y - LID_MARGIN);
  }

  /** Tell both copies of the terrain which caverns shape the ground now. */
  private pushCaverns(): void {
    const list = this.active.map((c) => c.cav);
    (this.world as Partial<{ setCaverns(l: readonly Cavern[]): void }>).setCaverns?.(list);
    if (this.u.uCavA) writeCaverns(this.u, list);
  }

  /**
   * Keeps the terrain's short list of caverns to the nearest few, and builds the roof of an
   * open one that has come into range, and then the deep under it. Returns whether it built one.
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
      if (cs.cav.open > 0 && !this.isBuilt(roofKey(cs)) && Math.hypot(cs.cav.x - px, cs.cav.z - pz) < CAVERN_BUILD_R) {
        this.buildCavernSite(cs);
        return true;
      }
    }
    if (this.scanDeeps(px, pz, near)) return true;
    for (const a of this.lampAt) {
      if (this.isBuilt(a.key) || Math.hypot(a.x - px, a.z - pz) >= BUILD_R) continue;
      this.buildLamp(a);
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
    this.finishSite(roofKey(cs), 'cavern', cv.x + cv.dx * cv.spot, cv.z + cv.dz * cv.spot, cv.top, ctx);
    // (it counts as reached far below, at the heart of its deep: see update)
    this.sites[this.sites.length - 1].reachR = 0;
  }

  // ---------------------------------------------------------------- the deeps

  /** What a cavern's deep is built from: the same for a site every time. */
  private specOf(cs: CavernSite): DeepSpec {
    const cv = cs.cav;
    return {
      x: cs.hx,
      z: cs.hz,
      y: cv.floor,
      dx: cv.dx,
      dz: cv.dz,
      kind: cs.kind,
      seed: cs.seed,
      u1: cs.u1,
      v0: cs.v0,
      v1: cs.v1,
      lid: cs.lid,
      // (a relic already carried off is still part of what the place was built round: it is
      // taken out again below, so the place is the same with it or without)
      relic: cs.relic,
      vein: cs.vein,
      carvings: cs.carvings,
      tier: this.tier,
    };
  }

  /** Build the deep under an open cavern (a hitch of a tenth of a second or so: once, never per frame). */
  private buildDeep(cs: CavernSite): void {
    if (cs.deep) return;
    const deep = createDeep(this.specOf(cs), this.u);
    if (this.taken.has(cs.key)) deep.takeRelic();
    if (this.woken.has(cs.key)) deep.wake(true);
    cs.deep = deep;
    this.deeps.push(cs);
    this.group.add(deep.group);
  }

  private dropDeep(cs: CavernSite): void {
    const deep = cs.deep;
    if (!deep) return;
    cs.deep = null;
    this.deeps.splice(this.deeps.indexOf(cs), 1);
    if (this.inside === cs) this.inside = null;
    this.group.remove(deep.group);
    deep.dispose();
  }

  /**
   * Lets go of deeps that are far off, and builds the one under the nearest open cavern in
   * range, keeping to DEEP_MAX of them. The one the wanderer is in is never let go. Returns
   * whether it built one.
   */
  private scanDeeps(px: number, pz: number, near: readonly CavernSite[]): boolean {
    const d = (c: CavernSite) => Math.hypot(c.hx - px, c.hz - pz);
    for (let i = this.deeps.length - 1; i >= 0; i--) {
      const cs = this.deeps[i];
      if (cs !== this.inside && cs !== this.draining && d(cs) > DEEP_DROP_R) this.dropDeep(cs);
    }
    // (near is sorted nearest first)
    for (const cs of near) {
      if (cs.deep || cs.cav.open <= 0 || d(cs) > DEEP_BUILD_R) continue;
      if (this.deeps.length >= DEEP_MAX) {
        // make room by letting the furthest go, if it is further than this one
        let far: CavernSite | null = null;
        for (const o of this.deeps) if (o !== this.inside && o !== this.draining && (!far || d(o) > d(far))) far = o;
        if (!far || d(far) <= d(cs)) return false;
        this.dropDeep(far);
      }
      this.buildDeep(cs);
      return true;
    }
    return false;
  }

  /**
   * The floor for feet at height y over (x, z) where a deep decides it, or null where the
   * terrain does: see Deep.floorAt. A deep has its say only once its cavern is fully open
   * (the hole is not there before), and only from under the antechamber's ceiling down, so
   * the sand roof over the hole is stood on like the rest of it.
   */
  deepFloor(x: number, z: number, y: number): number | null {
    for (let i = 0; i < this.deeps.length; i++) {
      const cs = this.deeps[i];
      if (cs.cav.open < 1 || y > cs.cav.floor + TERRAIN.cavernHeight - 0.3) continue;
      if (Math.abs(x - cs.hx) > 560 || Math.abs(z - cs.hz) > 560) continue;
      const f = cs.deep!.floorAt(x, z, y);
      if (f !== null) return f;
    }
    return null;
  }

  /** The deep the wanderer is down in now (as of the last update), or null. */
  get deepIn(): Deep | null {
    return this.inside ? this.inside.deep : null;
  }

  /** The built deep whose hole is nearest (x, z), with the cavern over it, or null if none is built. */
  deepNear(x: number, z: number): { deep: Deep; cav: Cavern } | null {
    let best: CavernSite | null = null;
    for (const cs of this.deeps) if (!best || Math.hypot(cs.hx - x, cs.hz - z) < Math.hypot(best.hx - x, best.hz - z)) best = cs;
    return best ? { deep: best.deep!, cav: best.cav } : null;
  }

  /**
   * For testing: the nearest cavern to (x, z) whose deep is of `kind` (failing that, the nearest
   * of any kind, made to be that kind) is opened, for this visit only. Returns where to stand,
   * on the antechamber floor a few steps short of the hole, and the way to face to walk into it.
   */
  devDeep(x: number, z: number, kind: number): { x: number; z: number; facing: number; key: number } | null {
    const pcx = Math.floor(x / CELL);
    const pcz = Math.floor(z / CELL);
    const k = ((Math.floor(kind) % 5) + 5) % 5;
    let best: CavernSite | null = null;
    let any: CavernSite | null = null;
    for (let r = 0; r <= 12 && !best; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cs = this.cavernAt(pcx + dx, pcz + dz);
          if (!cs) continue;
          const d = (c: CavernSite) => Math.hypot(c.cav.x - x, c.cav.z - z);
          if (!any || d(cs) < d(any)) any = cs;
          if (cs.kind === k && (!best || d(cs) < d(best))) best = cs;
        }
      }
    }
    const cs = best ?? any;
    if (!cs) return null;
    cs.kind = k as DeepKind;
    cs.cav.open = 1;
    this.opened.add(cs.key);
    if (!this.active.includes(cs)) this.active = [cs, ...this.active].slice(0, MAX_CAVERNS);
    this.pushCaverns();
    this.onGround?.();
    const cv = cs.cav;
    const u = cv.hole - DEEP_HOLE.halfU - 2.5;
    return { x: cv.x + cv.dx * u, z: cv.z + cv.dz * u, facing: Math.atan2(cv.dx, cv.dz), key: cs.key };
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
      const d = Math.hypot(cs.cav.x + cs.cav.dx * cs.cav.spot - x, cs.cav.z + cs.cav.dz * cs.cav.spot - z);
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
      if (!this.isBuilt(roofKey(best))) this.buildCavernSite(best);
      // the deep is made now, while the sand runs out, so it is there when the hole opens
      this.buildDeep(best);
    } else out.level = best.hits;
    this.pushCaverns();
    return out;
  }

  /** How long the sand takes to drain once a cavern breaks open (s). */
  readonly drainTime = DRAIN;
  /** How near the spot a strike must land to count toward breaking through (m). */
  readonly digReach = DIG_R;

  /** The cavern whose sand is running out now, if any. */
  get drainingCavern(): Cavern | null {
    return this.draining ? this.draining.cav : null;
  }

  /** The nearest sealed cavern on the terrain's list within r metres, for the signs it gives at the surface. */
  sealedNear(x: number, z: number, r: number): Cavern | null {
    let best: Cavern | null = null;
    for (const cs of this.active) {
      if (cs.cav.open > 0) continue;
      const d = Math.hypot(cs.cav.x + cs.cav.dx * cs.cav.spot - x, cs.cav.z + cs.cav.dz * cs.cav.spot - z);
      if (d < r) {
        r = d;
        best = cs.cav;
      }
    }
    return best;
  }

  /**
   * The nearest cavern to a point, searching out ring by ring over the cells (they are rare, so
   * this can look several kilometres). `sealed` leaves out the ones already open. The spot to
   * dig is `spot` metres along (dx, dz) from its (x, z).
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

  // ---------------------------------------------------------------- the wrecks

  /** The wrecks there are now (from setWrecks), each with its site key. */
  private wreckAt: WreckAt[] = [];

  /**
   * The wrecked sand-ships that lie in the world now: ones a storm has uncovered, and ones the
   * wanderer has reached before. They are not on the grid of cells; each is built and let go
   * like any other find (near and far from the wanderer), and one taken out of the list goes.
   * The same list again costs nothing.
   */
  setWrecks(list: readonly { x: number; z: number; rot: number }[]): void {
    const was = this.wreckAt;
    if (list.length === was.length && list.every((a, i) => a.x === was[i].x && a.z === was[i].z && a.rot === was[i].rot)) return;
    const next: WreckAt[] = [];
    for (const a of list) {
      const key = wreckKey(a.x, a.z);
      if (!next.some((b) => b.key === key)) next.push({ x: a.x, z: a.z, rot: a.rot, key });
    }
    this.wreckAt = next;
    for (let i = this.sites.length - 1; i >= 0; i--) {
      const s = this.sites[i];
      if (s.kind !== 'wreck') continue;
      const w = next.find((a) => a.key === s.key);
      // (one that has turned to lie another way is built again)
      if (w && w.x === s.x && w.z === s.z && w.rot === was.find((b) => b.key === s.key)?.rot) continue;
      this.disposeSite(s);
      this.sites.splice(i, 1);
    }
  }

  /** Builds the nearest wreck within BUILD_R of (px, pz) that is not built yet. Returns whether it built one. */
  private scanWrecks(px: number, pz: number): boolean {
    let best: WreckAt | null = null;
    let bd = BUILD_R;
    for (const a of this.wreckAt) {
      const d = Math.hypot(a.x - px, a.z - pz);
      if (d < bd && !this.isBuilt(a.key)) {
        bd = d;
        best = a;
      }
    }
    if (!best) return false;
    const w = this.world;
    const baseY = w.height(best.x, best.z);
    const rng = mulberry32(Math.floor(hash4(Math.round(best.x), Math.round(best.z), w.seed | 0, 0x3eec) * 4294967296));
    const ctx = new Ctx(w, best.x, best.z, baseY, rng, best.rot);
    buildWreck(ctx);
    this.finishSite(best.key, 'wreck', best.x, best.z, baseY, ctx);
    return true;
  }

  // ---------------------------------------------------------------- the lost lamp

  private lampAt: { x: number; z: number; key: number }[] = [];
  /** The site key of the lamp at each spot it has ever been put, so one that stays put keeps its site. */
  private readonly lampKeys = new Map<string, number>();
  private readonly springLamps = new Map<Spring, { x: number; z: number; mouth: { x: number; z: number } }>();

  /**
   * Where the two lamps of a spring stand: one at the foot of the fall, on the bank of the pool
   * just clear of the water, and one (`mouth`) up in the cave mouth the water pours from, which
   * is high on a headwall nobody can walk and has to be flown to.
   */
  private springLamp(sp: Spring): { x: number; z: number; mouth: { x: number; z: number } } {
    let at = this.springLamps.get(sp);
    if (at) return at;
    // Out from the mouth to where the fall has reached the pool, a little further, then
    // off to one side to the first level ground clear of the water. (Failing that it
    // stands in the shallows.)
    const low = TERRAIN.waterY + TERRAIN.riverBank + 1.5;
    let out = 8;
    while (out < 90 && this.world.height(sp.x - sp.dx * out, sp.z - sp.dz * out) > low) out += 2;
    const bx = sp.x - sp.dx * (out + 6);
    const bz = sp.z - sp.dz * (out + 6);
    // and the other: a few steps in from the lip, on the floor of the notch, off the middle
    at = { x: bx, z: bz, mouth: { x: sp.x + sp.dx * 5 - sp.dz * 3, z: sp.z + sp.dz * 5 + sp.dx * 3 } };
    search: for (let lat = 10; lat <= 34; lat += 1) {
      for (const side of [-1, 1]) {
        const tx = bx - sp.dz * side * lat;
        const tz = bz + sp.dx * side * lat;
        if (this.riverAt(tx, tz) < TERRAIN.riverHalf + 2.5 || this.world.height(tx, tz) > low) continue;
        at.x = tx;
        at.z = tz;
        break search;
      }
    }
    this.springLamps.set(sp, at);
    return at;
  }

  private springsOf(gi: number, gj: number, m: Massif): Spring[] {
    const id = (gi + 32768) * 65536 + (gj + 32768);
    let springs = this.springCache.get(id);
    if (!springs) this.springCache.set(id, (springs = this.findSprings(m)));
    return springs;
  }

  /**
   * Where a lamp lost near a point would be: at the nearest spring to it, failing that just
   * inside a massif's cave, and null where there is no mountain by at all. `kind` says which.
   * A spring has two lamps, and either will do: one on the bank of its pool, one (`mouth`) up
   * in the cave mouth the water pours from.
   */
  lampSpot(x: number, z: number): { x: number; z: number; kind: 'spring' | 'cave'; mouth?: { x: number; z: number } } | null {
    const w = this.world as Partial<{ massif(gi: number, gj: number): Massif | null; cave(gi: number, gj: number): Cave | null }>;
    if (!w.massif || !w.cave) return null;
    const gi0 = Math.floor(x / CITY_CELL);
    const gj0 = Math.floor(z / CITY_CELL);
    let best: Spring | null = null;
    let bd = Infinity;
    let cave: { x: number; z: number; kind: 'spring' | 'cave' } | null = null;
    let cd = Infinity;
    for (let gj = gj0; gj <= gj0 + 1; gj++) {
      for (let gi = gi0; gi <= gi0 + 1; gi++) {
        const m = w.massif(gi, gj);
        if (!m) continue;
        for (const sp of this.springsOf(gi, gj, m)) {
          const d = Math.hypot(sp.x - x, sp.z - z);
          if (d >= bd) continue;
          bd = d;
          best = sp;
        }
        const cv = w.cave(gi, gj)!;
        const d = Math.hypot(cv.x - x, cv.z - z);
        if (d < cd) {
          cd = d;
          cave = { x: cv.x + cv.dx * (TERRAIN.caveRoofFrom + 3) - cv.dz * 2.5, z: cv.z + cv.dz * (TERRAIN.caveRoofFrom + 3) + cv.dx * 2.5, kind: 'cave' };
        }
      }
    }
    if (!best) return cave;
    const at = this.springLamp(best);
    return { x: at.x, z: at.z, kind: 'spring', mouth: at.mouth };
  }

  /**
   * The pool bank of every mountain fall within r of a point: where a lamp stands at each once
   * the miner has asked for one, so that any fall will do and not only the one that was named.
   */
  fallLamps(x: number, z: number, r = DRAW_R): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    const w = this.world as Partial<{ massif(gi: number, gj: number): Massif | null }>;
    if (!w.massif) return out;
    const gi0 = Math.round(x / CITY_CELL);
    const gj0 = Math.round(z / CITY_CELL);
    for (let gj = gj0 - 1; gj <= gj0 + 1; gj++) {
      for (let gi = gi0 - 1; gi <= gi0 + 1; gi++) {
        const m = w.massif(gi, gj);
        if (!m || Math.hypot(m.x - x, m.z - z) > r + m.r * 1.3) continue;
        for (const sp of this.springsOf(gi, gj, m)) {
          if (Math.hypot(sp.x - x, sp.z - z) >= r) continue;
          const at = this.springLamp(sp);
          out.push({ x: at.x, z: at.z });
        }
      }
    }
    return out;
  }

  /**
   * Put the lost lamps out in the world, or take them all away (an empty list). Each is built
   * when the player comes near; one already standing where the new list has one is left alone.
   */
  setLamps(at: readonly { x: number; z: number }[]): void {
    if (at.length === this.lampAt.length && at.every((a, i) => a.x === this.lampAt[i].x && a.z === this.lampAt[i].z)) return;
    this.lampAt = at.map((a) => {
      const id = `${a.x},${a.z}`;
      let key = this.lampKeys.get(id);
      if (key === undefined) this.lampKeys.set(id, (key = LAMP_KEY - this.lampKeys.size));
      return { x: a.x, z: a.z, key };
    });
    for (let i = this.sites.length - 1; i >= 0; i--) {
      const s = this.sites[i];
      if (s.kind !== 'lamp' || this.lampAt.some((a) => a.key === s.key)) continue;
      this.disposeSite(s);
      this.sites.splice(i, 1);
    }
  }

  /** Whether one of the lost lamps lies within reach of (x, y, z). */
  lampNear(x: number, y: number, z: number, reach: number): boolean {
    for (const a of this.lampAt) {
      if (this.isBuilt(a.key) && Math.hypot(a.x - x, a.z - z) < reach && Math.abs(this.world.height(a.x, a.z) - y) < 2.5) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- the rope beside the bones

  private ropeMesh: THREE.Mesh | null = null;
  /** One material for every small thing left lying about: the rope, the temples' offerings. */
  private toolMat: THREE.ShaderMaterial | null = null;
  /** What the bones of a cell are made of, by cell key (for keeping a rope clear of them). */
  private readonly boneSolids = new Map<number, Solids | null>();

  /** The solids of the bones a cell holds as buildSite would make them, built or not. */
  private bonesSolids(key: number, cx: number, cz: number): Solids | null {
    let so = this.boneSolids.get(key);
    if (so === undefined) {
      const w = this.world;
      const rng = mulberry32(Math.floor(hash4(cx, cz, w.seed | 0, 7) * 4294967296));
      const at = this.placeSite(cx, cz, rng);
      const ctx = new Ctx(w, at.x, at.z, w.height(at.x, at.z), rng, rng() * Math.PI * 2);
      buildBones(ctx);
      so = ctx.solids.count > 0 ? ctx.solids : null;
      this.boneSolids.set(key, so);
    }
    return so;
  }

  /**
   * Where a rope lies for a wanderer near (x, z): about 3 m from the nearest great bones within
   * maxR, on ground clear of the bones' own stones, the same every time (it does not depend on
   * whether the bones are built). Null where there are no bones in range.
   */
  ropeSpot(x: number, z: number, maxR: number): { x: number; z: number } | null {
    let best: Landmark | null = null;
    let bd = Infinity;
    for (const p of this.surfaceSitesNear(x, z, maxR, [])) {
      if (p.kind !== 'bones') continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd || (d === bd && best && p.key < best.key)) {
        bd = d;
        best = p;
      }
    }
    if (!best) return null;
    const cx = Math.floor(best.key / 65536) - 32768;
    const cz = (best.key % 65536) - 32768;
    const so = this.bonesSolids(best.key, cx, cz);
    const oy = this.world.height(best.x, best.z);
    const a0 = hash4(cx, cz, this.world.seed | 0, 61) * Math.PI * 2;
    let first: { x: number; z: number } | null = null;
    for (let k = 0; k < 48; k++) {
      const a = a0 + k * 2.399963;
      const rad = 3 + Math.floor(k / 8) * 1.5;
      const tx = best.x + Math.cos(a) * rad;
      const tz = best.z + Math.sin(a) * rad;
      first ??= { x: tx, z: tz };
      if (so) {
        const gy = this.world.height(tx, tz) - oy;
        if (so.contains(tx - best.x, gy + 0.2, tz - best.z, 0.9) || so.contains(tx - best.x, gy + 0.8, tz - best.z, 0.9)) continue;
      }
      return { x: tx, z: tz };
    }
    return first;
  }

  /** Lays the rope coil at a spot on the ground, or takes it away (null). */
  setRope(at: { x: number; z: number } | null): void {
    if (!at) {
      if (this.ropeMesh) this.ropeMesh.visible = false;
      return;
    }
    if (!this.ropeMesh) {
      this.ropeMesh = new THREE.Mesh(ropeCoilGeometry(), (this.toolMat ??= solidMaterial(this.u)));
      this.ropeMesh.name = 'rope';
      this.group.add(this.ropeMesh);
    }
    this.ropeMesh.position.set(at.x, this.world.height(at.x, at.z), at.z);
    this.ropeMesh.visible = true;
  }

  /** Whether the rope lies within reach of (x, y, z). */
  ropeNear(x: number, y: number, z: number, r: number): boolean {
    const m = this.ropeMesh;
    if (!m?.visible) return false;
    return Math.hypot(m.position.x - x, m.position.z - z) < r && Math.abs(m.position.y - y) < 2.5;
  }

  // ---------------------------------------------------------------- what is left up the mountains

  private readonly strays: Partial<Record<Stray, THREE.Group>> = {};

  /**
   * Where a stray thing lies for a wanderer near (x, z): the boots at the back of the nearest
   * mountain cave within maxR, the feather a few steps from the lantern on the nearest summit.
   * Decided from the seed alone, so it is the same spot whether or not the mountain is built.
   */
  straySpot(kind: Stray, x: number, z: number, maxR: number): { x: number; z: number } | null {
    const w = this.world as Partial<{ massif(gi: number, gj: number): Massif | null; cave(gi: number, gj: number): Cave | null }>;
    if (!w.massif || !w.cave) return null;
    let best: { x: number; z: number } | null = null;
    let bd = maxR;
    const gi0 = Math.floor((x - maxR) / CITY_CELL) - 1;
    const gi1 = Math.floor((x + maxR) / CITY_CELL) + 1;
    const gj0 = Math.floor((z - maxR) / CITY_CELL) - 1;
    const gj1 = Math.floor((z + maxR) / CITY_CELL) + 1;
    for (let gj = gj0; gj <= gj1; gj++) {
      for (let gi = gi0; gi <= gi1; gi++) {
        const m = w.massif(gi, gj);
        if (!m) continue;
        if (kind === 'boots') {
          const cv = w.cave(gi, gj);
          if (!cv) continue;
          // well in, beside the cairn at the back, against the wall
          const along = TERRAIN.caveLen - 11;
          const sx = cv.x + cv.dx * along - cv.dz * 2.6;
          const sz = cv.z + cv.dz * along + cv.dx * 2.6;
          const d = Math.hypot(sx - x, sz - z);
          if (d < bd) {
            bd = d;
            best = { x: sx, z: sz };
          }
          continue;
        }
        const d = Math.hypot(m.x - x, m.z - z);
        if (d >= bd) continue;
        bd = d;
        // clear of the lantern's cairn, on whichever side the ground falls away least
        const a0 = hash4(gi, gj, this.world.seed | 0, 67) * Math.PI * 2;
        let top = -Infinity;
        for (let k = 0; k < 8; k++) {
          const a = a0 + (k / 8) * Math.PI * 2;
          const sx = m.x + Math.cos(a) * 7;
          const sz = m.z + Math.sin(a) * 7;
          const h = this.world.height(sx, sz);
          if (h > top) {
            top = h;
            best = { x: sx, z: sz };
          }
        }
      }
    }
    return best;
  }

  /** Lays a stray thing at a spot on the ground under a small light, or takes it away (null). */
  setStray(kind: Stray, at: { x: number; z: number } | null): void {
    let g = this.strays[kind];
    if (!at) {
      if (g) g.visible = false;
      return;
    }
    if (!g) {
      const mat = (this.toolMat ??= solidMaterial(this.u));
      g = new THREE.Group();
      g.name = kind;
      if (kind === 'boots') {
        // a pair, larger than life so they read in the dark: one standing, one fallen against it
        const up = new THREE.Mesh(bootGeometry().scale(1.7, 1.7, 1.7).rotateY(0.5).translate(-0.1, 0, 0), mat);
        const down = new THREE.Mesh(bootGeometry().scale(1.7, 1.7, 1.7).rotateZ(-1.42).rotateY(-0.7).translate(0.14, 0.07, 0.06), mat);
        g.add(up, down);
      } else {
        // held up off the ground by the air that comes up the mountain, leaning (update turns it)
        g.add(new THREE.Mesh(featherGeometry().scale(2.6, 2.6, 2.6).translate(0, -0.4, 0).rotateZ(-0.35).translate(0, 0.4, 0), mat));
      }
      // (a small light: enough to find them by in the cave, not enough to drown them in daylight)
      g.add(this.glowMesh([0, 0.35, 0, 0.4, 0, 0.35, 0, 0.95], this.relicGlowMat));
      this.strays[kind] = g;
      this.group.add(g);
    }
    g.position.set(at.x, this.world.height(at.x, at.z), at.z);
    g.visible = true;
  }

  /** Whether a stray thing lies within reach of (x, y, z). */
  strayNear(kind: Stray, x: number, y: number, z: number, r: number): boolean {
    const g = this.strays[kind];
    if (!g?.visible) return false;
    return Math.hypot(g.position.x - x, g.position.z - z) < r && Math.abs(g.position.y - y) < 2.5;
  }

  // ---------------------------------------------------------------- the offerings in the temples

  /**
   * Lay on each built temple's stone whatever `pick` says it holds now (by site key), or clear
   * it (null). Cheap to call often: a stone that already holds the right thing is left alone.
   */
  setOffers(pick: (key: number) => Offering | null): void {
    for (const s of this.sites) {
      if (!s.temple) continue;
      const kind = pick(s.key);
      if ((s.offer?.kind ?? null) === kind) continue;
      if (s.offer) {
        s.group.remove(s.offer.obj);
        s.offer.obj.traverse((o) => {
          if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
        });
      }
      s.offer = kind ? { kind, obj: this.buildOffer(kind, s) } : undefined;
    }
  }

  /** The offering lying within reach of (x, y, z): which temple's, and what it is. */
  offerNear(x: number, y: number, z: number, reach: number): { key: number; kind: Offering } | null {
    for (const s of this.sites) {
      if (!s.offer || !s.temple) continue;
      const o = s.temple.offer;
      if (Math.hypot(o.x - x, o.z - z) < reach && Math.abs(o.y - y) < 2.5) return { key: s.key, kind: s.offer.kind };
    }
    return null;
  }

  /** Whether a temple within r of (x, z) still has something on its stone. */
  offerWithin(x: number, z: number, r: number): boolean {
    return this.sites.some((s) => s.offer && Math.hypot(s.x - x, s.z - z) < r);
  }

  /** A tool laid on a temple's stone, larger than life so it reads from the door, under a small light. */
  private buildOffer(kind: Offering, s: Site): THREE.Group {
    let g: THREE.BufferGeometry;
    switch (kind) {
      case 'chart': g = chartGeometry().rotateZ(Math.PI / 2).scale(2.4, 2.4, 2.4).translate(0, 0.08, 0); break;
      // (the finger holes turned up)
      case 'flute': g = fluteGeometry().translate(0, -0.2, 0).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2).scale(2.4, 2.4, 2.4).translate(0, 0.04, 0); break;
      case 'bedroll': g = bedrollGeometry().scale(1.7, 1.7, 1.7).translate(0, 0.135, 0); break;
      case 'rod': g = rodGeometry().translate(0, 0.012, -0.17).scale(2.4, 2.4, 2.4); break;
      default: g = ropeCoilGeometry().scale(1.5, 1.5, 1.5);
    }
    const o = s.temple!.offer;
    const lx = o.x - s.ox;
    const ly = o.y - s.oy;
    const lz = o.z - s.oz;
    // askew on the stone, the same way every time
    g.rotateY(0.5 + (s.key % 7) * 0.3).translate(lx, ly, lz);
    const obj = new THREE.Group();
    obj.name = `offer:${kind}`;
    obj.add(new THREE.Mesh(g, (this.toolMat ??= solidMaterial(this.u))));
    obj.add(this.glowMesh([lx, ly + 0.25, lz, 0.7, lx, ly + 0.25, lz, 2.6], this.relicGlowMat));
    s.group.add(obj);
    return obj;
  }

  // ---------------------------------------------------------------- the carpet in the deeps

  private carpetOn = false;
  private carpetIn: CavernSite | null = null;
  private carpet: { group: THREE.Group; mat: THREE.ShaderMaterial; pos: THREE.Vector3; speed: { value: number }; loose: boolean } | null = null;

  /**
   * Whether a carpet waits under the sand. While it does, one hangs in the air at the heart of
   * whichever open deep the wanderer is in (or nearest); once they come to the heart it flies to them.
   */
  setCarpet(on: boolean): void {
    this.carpetOn = on;
    if (!on && this.carpet) this.carpet.group.visible = false;
  }

  /** Whether the carpet has come within r of someone whose feet are at (x, y, z). */
  carpetNear(x: number, y: number, z: number, r: number): boolean {
    const c = this.carpet;
    return !!c && this.carpetOn && c.group.visible && Math.hypot(c.pos.x - x, c.pos.y - y - 1.1, c.pos.z - z) < r;
  }

  /** Per frame: hang the carpet at the heart of a deep, and send it to the wanderer once they reach it. */
  private driftCarpet(f: FrameState, inside: CavernSite | null): void {
    const cs = this.carpetOn ? (inside ?? this.deeps.find((d) => d.cav.open >= 1) ?? null) : null;
    if (!cs) {
      if (this.carpet) this.carpet.group.visible = false;
      this.carpetIn = null;
      return;
    }
    if (!this.carpet) {
      const { geo, len } = carpetGeometry(CHOSEN.carpet);
      const speed = { value: 0 };
      const mat = rugMaterial(this.u, speed, { value: len });
      const group = new THREE.Group();
      group.name = 'carpet';
      group.rotation.order = 'YXZ';
      group.add(new THREE.Mesh(geo, mat), this.glowMesh([0, 0.1, 0, 1.1, 0, 0.1, 0, 5.5], this.relicGlowMat));
      this.group.add(group);
      this.carpet = { group, mat, pos: new THREE.Vector3(), speed, loose: false };
    }
    const c = this.carpet;
    const home = cs.deep!.centre;
    if (this.carpetIn !== cs) {
      this.carpetIn = cs;
      c.pos.set(home[0], home[1] + 1.5, home[2]);
      c.loose = false;
    }
    const p = f.player.pos;
    // (the same reach at which the heart counts as found)
    if (!c.loose && inside === cs && Math.hypot(home[0] - p.x, home[1] - p.y, home[2] - p.z) < 14) c.loose = true;
    if (c.loose) {
      const dx = p.x - c.pos.x;
      const dy = p.y + 1.1 - c.pos.y;
      const dz = p.z - c.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 1e-3) {
        // quick while it is far off, easing in as it arrives
        const k = Math.min(1, (Math.min(16, 3 + d * 1.6) * f.dt) / d);
        c.pos.set(c.pos.x + dx * k, c.pos.y + dy * k, c.pos.z + dz * k);
        if (Math.hypot(dx, dz) > 0.3) c.group.rotation.y = Math.atan2(dx, dz);
      }
      c.speed.value = Math.min(1, d / 8);
    } else {
      c.speed.value = 0;
      c.group.rotation.y += f.dt * 0.35;
    }
    // waiting, it hangs tipped so its pattern shows from across the room; flying, it levels out
    const tip = c.loose ? 0 : 0.3;
    c.group.rotation.x += (tip - c.group.rotation.x) * Math.min(1, f.dt * 4);
    c.group.position.set(c.pos.x, c.pos.y + Math.sin(f.time * 1.3) * 0.12, c.pos.z);
    c.group.visible = true;
  }

  private buildLamp(at: { x: number; z: number; key: number }): void {
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
    this.finishSite(at.key, 'lamp', at.x, at.z, baseY, c);
    this.sites[this.sites.length - 1].reachR = 0; // found by picking it up, not by coming near
  }

  /** The key of a relic lying within reach of (x, y, z), or -1. Relics lie in the deeps. */
  relicNear(x: number, y: number, z: number, reach: number): number {
    for (const cs of this.deeps) {
      const r = cs.deep!.relic;
      if (!r || !cs.relic || this.taken.has(cs.key)) continue;
      if (Math.hypot(r[0] - x, r[2] - z) < reach && Math.abs(r[1] - y - 1) < 1.6) return cs.key;
    }
    return -1;
  }

  /** The relic has been picked up: it is gone from its stone for good. */
  takeRelic(key: number): void {
    if (this.taken.has(key)) return;
    this.taken.add(key);
    this.cavernCache.get(key)?.deep?.takeRelic();
  }

  /** Site position for a cell, or false if the cell is empty. */
  private cellSite(cx: number, cz: number): boolean {
    const s = this.world.seed | 0;
    this.cellPos.x = cx * CELL + MARGIN + hash4(cx, cz, s, 2) * (CELL - 2 * MARGIN);
    this.cellPos.z = cz * CELL + MARGIN + hash4(cx, cz, s, 3) * (CELL - 2 * MARGIN);
    // Most cells are empty, but one beside a river usually holds a grove.
    this.cellSpare = '';
    const empty = hash4(cx, cz, s, 1) >= SITE_P;
    // A cell with no find of its own is where a route's caravanserai goes, if one falls in it.
    const inn = empty ? this.innAt(cx, cz) : null;
    if (inn) {
      this.cellPos.x = inn.x;
      this.cellPos.z = inn.z;
      this.cellSpare = 'inn';
    } else if (empty && !(hash4(cx, cz, s, 5) < GROVE_P && this.riverAt(this.cellPos.x, this.cellPos.z) < GROVE_REACH)) {
      // An empty cell away from the water may hold a hamlet instead, a watchtower, or a settlement;
      // one beside the water, a settlement that wants a river.
      const roll = hash4(cx, cz, s, 31);
      if (this.riverAt(this.cellPos.x, this.cellPos.z) < GROVE_REACH) {
        if (hash4(cx, cz, s, 37) >= RIVER_SETTLE_P) return false;
        this.cellSpare = 'settlement';
      } else if (roll >= HAMLET_P + TOWER_P + SETTLE_P) return false;
      else this.cellSpare = roll < HAMLET_P ? 'hamlet' : roll < HAMLET_P + TOWER_P ? 'watchtower' : 'settlement';
    }
    // The wilderness finds keep clear of cities.
    const cities = (this.world as Partial<{ cities: { at(x: number, z: number): { cx: number; cz: number; radius: number } } }>).cities;
    if (cities) {
      const c = cities.at(this.cellPos.x, this.cellPos.z);
      if (Math.hypot(c.cx - this.cellPos.x, c.cz - this.cellPos.z) < c.radius + 1500 * WORLD_SCALE) return false;
    }
    return true;
  }

  /** What an otherwise empty cell holds, as cellSite last worked out. */
  private cellSpare: '' | 'hamlet' | 'watchtower' | 'settlement' | 'inn' = '';
  private readonly innCache = new Map<number, Inn | null>();
  private routes: RouteNet | undefined;
  private readonly routeOut: TravelRoute[] = [];
  private readonly innP = { x: 0, z: 0 };
  private readonly innQ = { x: 0, z: 0 };

  /**
   * The caravanserai that stands in a cell, if a route's falls there: beside the road, about half
   * way between its two cities, at the first of a few places along it where the ground will do.
   * Worked out from the routes and the seed alone, once for each cell.
   */
  private innAt(cx: number, cz: number): Inn | null {
    const key = cellKey(cx, cz);
    let inn = this.innCache.get(key);
    if (inn !== undefined) return inn;
    inn = null;
    const w = this.world as Partial<DesertWorld>;
    if (w.cities && w.river && w.massif) {
      this.routes ??= new RouteNet(this.world as DesertWorld);
      const s = this.world.seed | 0;
      const P = this.innP;
      const Q = this.innQ;
      search: for (const r of this.routes.near((cx + 0.5) * CELL, (cz + 0.5) * CELL, this.routeOut, 4)) {
        const side = hash4(r.a.id, r.b.id, s, 71) < 0.5 ? -1 : 1;
        for (const f of INN_AT) {
          routePos(r, r.len * f, 0, P);
          routePos(r, r.len * f + 6, 0, Q);
          const tl = Math.hypot(Q.x - P.x, Q.z - P.z) || 1;
          const nx = (-(Q.z - P.z) / tl) * side;
          const nz = ((Q.x - P.x) / tl) * side;
          const x = P.x + nx * INN_OFF;
          const z = P.z + nz * INN_OFF;
          if (!this.innFits(r, x, z)) continue;
          // the first place that will do is where this route's stands, whichever cell that is
          if (Math.floor(x / CELL) === cx && Math.floor(z / CELL) === cz) {
            inn = { x, z, dx: -nx, dz: -nz };
            break search;
          }
          continue search;
        }
      }
    }
    this.innCache.set(key, inn);
    return inn;
  }

  /** Whether a caravanserai could stand at (x, z) beside route r: a cell with no find, level sand, off the water and the route's camps. */
  private innFits(r: TravelRoute, x: number, z: number): boolean {
    const w = this.world;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    if (hash4(cx, cz, w.seed | 0, 1) < SITE_P) return false;
    const ex = x - cx * CELL;
    const ez = z - cz * CELL;
    if (ex < INN_EDGE || ez < INN_EDGE || ex > CELL - INN_EDGE || ez > CELL - INN_EDGE) return false;
    if (Math.abs(w.height(x + 22, z) - w.height(x - 22, z)) + Math.abs(w.height(x, z + 22) - w.height(x, z - 22)) > 5) return false;
    if (this.riverAt(x, z) < 200 || w.sample(x, z, this.sample).rock > 0.4) return false;
    for (const camp of this.routes!.camps(r)) if (Math.hypot(camp.x - x, camp.z - z) < 75) return false;
    return true;
  }

  /** Whether nothing else's cell point lies within r of (x, z): the room a big settlement in cell (cx, cz) needs. */
  private settleClear(cx: number, cz: number, x: number, z: number, r: number): boolean {
    const kx = this.cellPos.x;
    const kz = this.cellPos.z;
    const spare = this.cellSpare;
    let ok = true;
    for (let dz = -1; dz <= 1 && ok; dz++) {
      for (let dx = -1; dx <= 1 && ok; dx++) {
        if (dx === 0 && dz === 0) continue;
        if (this.cellSite(cx + dx, cz + dz) && Math.hypot(this.cellPos.x - x, this.cellPos.z - z) < r) ok = false;
      }
    }
    this.cellPos.x = kx;
    this.cellPos.z = kz;
    this.cellSpare = spare;
    return ok;
  }

  private isBuilt(key: number): boolean {
    for (let i = 0; i < this.sites.length; i++) if (this.sites[i].key === key) return true;
    return false;
  }

  update(f: FrameState): void {
    const px = f.player.pos.x;
    const pz = f.player.pos.z;
    // the feather on a summit hangs in the rising air, turning, so it is never edge-on for long
    const fe = this.strays.feather?.children[0];
    if (fe && this.strays.feather?.visible) {
      fe.rotation.y = f.time * 0.9;
      fe.position.y = 0.3 + 0.08 * Math.sin(f.time * 1.3);
    }
    this.scanT -= f.dt;
    if (this.scanT <= 0) {
      const lead = leadPoint(px, pz, f.player.vel.x, f.player.vel.z, LEAD_S, LEAD_MAX, this.lead);
      // while there is still something to build, look again on the very next frame
      this.scanT = this.scan(px, pz, lead.x, lead.z, this.sites.length === 0 ? 60 : SCAN_MS) ? 0 : SCAN_EVERY;
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
    // the deeps: which one the wanderer is in, their flames and falling light, and the heart of
    // one counting as found
    const py = f.player.pos.y;
    let inside: CavernSite | null = null;
    for (let i = 0; i < this.deeps.length; i++) {
      const cs = this.deeps[i];
      const deep = cs.deep!;
      deep.update(f.time, 1 - f.night, f.camera);
      if (cs.cav.open < 1) continue;
      if (!inside && deep.inside(px, py + 1, pz)) inside = cs;
      if (!this.reached.has(roofKey(cs))) {
        const c = deep.centre;
        if (Math.hypot(c[0] - px, c[1] - py, c[2] - pz) < 14) {
          this.reached.add(roofKey(cs));
          this.onReach?.('cavern', refKey(roofKey(cs)), cs.hx, cs.hz);
        }
      }
    }
    this.inside = inside;
    this.driftCarpet(f, inside);
    // What lights the things that move underground, and the rock of the antechamber: down in
    // a deep, its nearest lamp; up in the antechamber, whatever burns at the head of the stair,
    // or failing that the faint light that comes up the hole.
    const glowU = this.u.uCavGlow?.value as THREE.Vector4 | undefined;
    if (glowU) {
      glowU.w = 0;
      const g = this.glowOut;
      if (inside) {
        if (inside.deep!.glowAt(px, py + 1, pz, g)) glowU.set(g[0], g[1], g[2], g[3]);
      } else {
        let bd = 150;
        for (const cs of this.deeps) {
          const d = Math.hypot(cs.hx - px, cs.hz - pz);
          if (cs.cav.open < 1 || d >= bd) continue;
          bd = d;
          const y = cs.cav.floor;
          if (cs.deep!.glowAt(cs.hx, y - 1, cs.hz, g) && Math.hypot(g[0] - cs.hx, g[1] - y, g[2] - cs.hz) < 12) glowU.set(g[0], g[1], g[2], g[3]);
          else glowU.set(cs.hx + cs.cav.dx * 1.5, y - 2.2, cs.hz + cs.cav.dz * 1.5, 7);
        }
      }
    }
    // (a site on the surface is not come upon from underneath it)
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      const dx = s.x - px;
      const dz = s.z - pz;
      const d2 = dx * dx + dz * dz;
      // built further out than this, but past it every fragment would be thrown away (see DISSOLVE)
      s.group.visible = d2 < (DRAW_R + 200) * (DRAW_R + 200);
      if (inside || this.reached.has(s.key)) continue;
      if (d2 < s.reachR * s.reachR) {
        this.reached.add(s.key);
        if (this.onReach) this.onReach(s.kind, refKey(s.key), s.x, s.z);
      }
    }
  }

  /**
   * Lets go of what is far from the wanderer (px, pz) and builds what is missing around the point
   * they are heading for (bx, bz), nearest first, for up to `ms` milliseconds (always one thing at
   * least). Returns whether it built anything, in which case there may be more to do.
   */
  private scan(px: number, pz: number, bx: number, bz: number, ms: number): boolean {
    // drop far sites
    for (let i = this.sites.length - 1; i >= 0; i--) {
      const s = this.sites[i];
      const dx = s.x - px;
      const dz = s.z - pz;
      if (dx * dx + dz * dz > DROP_R * DROP_R && !(this.inside && s.key === roofKey(this.inside))) {
        this.disposeSite(s);
        this.sites.splice(i, 1);
      }
    }
    if (this.scanWrecks(bx, bz)) return true;
    // (the caverns shape the ground under the wanderer's feet, so they go by where the wanderer is)
    if (this.scanCaverns(px, pz)) return true;
    if (this.scanMassifs(bx, bz)) return true;
    if (this.scanFrost(bx, bz)) return true;
    const pcx = Math.floor(bx / CELL);
    const pcz = Math.floor(bz / CELL);
    const span = Math.ceil(BUILD_R / CELL);
    // every cell in reach that has a find still to build, nearest last
    const want = this.want;
    want.length = 0;
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (!this.cellSite(cx, cz)) continue;
        const ddx = this.cellPos.x - bx;
        const ddz = this.cellPos.z - bz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 > BUILD_R * BUILD_R || this.isBuilt(cellKey(cx, cz))) continue;
        want.push({ cx, cz, d2 });
      }
    }
    if (want.length === 0) return false;
    want.sort((a, b) => b.d2 - a.d2);
    const t0 = now();
    do {
      const c = want.pop()!;
      this.buildSite(c.cx, c.cz);
    } while (want.length > 0 && now() - t0 < ms);
    return true;
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
        // the villages at its foot (worked out only once the massif is near enough for one to be in reach)
        const vils = Math.hypot(m.x - px, m.z - pz) < BUILD_R + m.r * VILLAGE_REACH ? this.villagesOf(gi, gj, m) : NO_VILLAGES;
        for (let k = 0; k < vils.length; k++) {
          const v = vils[k];
          const key = VILLAGE_KEY - (id * 4 + k);
          if (this.isBuilt(key) || Math.hypot(v.x - px, v.z - pz) >= BUILD_R) continue;
          const ctx = new Ctx(this.world, v.x, v.z, this.world.height(v.x, v.z), mulberry32(seed ^ (0x51c7 + k * 7919)), 0);
          ctx.stone.salt = (id * 5 + k * 37) & 1023;
          buildMountainVillage(ctx, v);
          this.finishSite(key, 'mountain-village', v.x, v.z, ctx.baseY, ctx);
          return true;
        }
        // the rock over each spring: the notch a river pours from becomes a cave mouth
        const springs = this.springsOf(gi, gj, m);
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

  /** The frostland's region and layout, worked out once and only when the wanderer is near enough to want it. */
  private frostLayoutNear(px: number, pz: number): FrostLayout | null {
    const region = this.frostOf();
    if (!region || Math.hypot(region.cx - px, region.cz - pz) > FROST_WAKE) return null;
    this.frostLay ??= frostLayout(this.world as DesertWorld, region);
    return this.frostLay;
  }

  private frostMemo: FrostRegion | null | undefined;

  /** The frostland's region (null when the world has none), worked out once. */
  private frostOf(): FrostRegion | null {
    if (this.frostMemo === undefined) {
      const w = this.world as Partial<DesertWorld>;
      this.frostMemo = w.massif && w.cities ? frostRegion(this.world as DesertWorld) : null;
    }
    return this.frostMemo;
  }

  /**
   * The villages at the foot of a massif, worked out once: none for the frostland's own mountain,
   * which has its snow villages, and each kept clear of the cities, the finds and the massif's cave.
   */
  private villagesOf(gi: number, gj: number, m: Massif): FootVillage[] {
    const id = (gi + 32768) * 65536 + (gj + 32768);
    let vils = this.villageCache.get(id);
    if (vils) return vils;
    vils = [];
    const fr = this.frostOf();
    const w = this.world as Partial<DesertWorld>;
    if (!(fr && Math.hypot(fr.cx - m.x, fr.cz - m.z) < 1) && w.river) {
      const cv = w.cave?.(gi, gj);
      const free = (x: number, z: number): boolean => {
        if (cv && Math.hypot(cv.x - x, cv.z - z) < 160) return false;
        const city = w.cities?.at(x, z);
        if (city && Math.hypot(city.cx - x, city.cz - z) < city.radius + VILLAGE_CITY_CLEAR) return false;
        return !this.cellClaimed(x, z, 70);
      };
      vils = footVillages(this.world as DesertWorld, m, hash4(gi, gj, this.world.seed | 0, 53), free);
    }
    this.villageCache.set(id, vils);
    return vils;
  }

  private readonly villageCache = new Map<number, FootVillage[]>();
  private frostLay: FrostLayout | undefined;

  /**
   * Builds the nearest unbuilt piece of the frostland road or one of its villages. Returns whether
   * it built one.
   */
  private scanFrost(px: number, pz: number): boolean {
    const lay = this.frostLayoutNear(px, pz);
    if (!lay) return false;
    const seed = Math.floor(hash4(Math.round(lay.region.cx), Math.round(lay.region.cz), this.world.seed | 0, 41) * 4294967296);
    let best = BUILD_R;
    let pick = -1;
    // the villages, then the road in chunks (a key each)
    for (let i = 0; i < lay.villages.length; i++) {
      const v = lay.villages[i];
      const d = Math.hypot(v.x - px, v.z - pz);
      if (d < best && !this.isBuilt(FROST_KEY - 1000 - i)) {
        best = d;
        pick = 1000 + i;
      }
    }
    const chunks = Math.ceil((lay.way.length - 1) / FROST_CHUNK);
    for (let i = 0; i < chunks; i++) {
      const mid = lay.way[Math.min(lay.way.length - 1, i * FROST_CHUNK + (FROST_CHUNK >> 1))];
      const d = Math.hypot(mid.x - px, mid.z - pz);
      if (d < best && !this.isBuilt(FROST_KEY - i)) {
        best = d;
        pick = i;
      }
    }
    if (pick < 0) return false;
    if (pick >= 1000) {
      const vi = pick - 1000;
      const v = lay.villages[vi];
      const ctx = new Ctx(this.world, v.x, v.z, this.world.height(v.x, v.z), mulberry32(seed ^ (0x77 + vi * 131)), 0);
      ctx.stone.salt = (vi * 53 + 9) & 1023;
      buildSnowVillage(ctx, lay, vi);
      this.finishSite(FROST_KEY - pick, 'snow-village', v.x, v.z, ctx.baseY, ctx);
      return true;
    }
    const i0 = pick * FROST_CHUNK;
    const i1 = Math.min(lay.way.length - 1, i0 + FROST_CHUNK);
    const mid = lay.way[Math.min(lay.way.length - 1, i0 + (FROST_CHUNK >> 1))];
    const ctx = new Ctx(this.world, mid.x, mid.z, this.world.height(mid.x, mid.z), mulberry32(seed ^ (0x1f3 + pick * 977)), 0);
    ctx.stone.salt = (pick * 29 + 3) & 1023;
    buildFrostWay(ctx, lay, i0, i1);
    this.finishSite(FROST_KEY - pick, 'frostway', mid.x, mid.z, ctx.baseY, ctx);
    this.reached.add(FROST_KEY - pick); // a stretch of road is not a find: it never chimes
    return true;
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

  /** Whether the point (x, y, z) is inside any site's stones or bones, grown by a margin. */
  solidAt(x: number, y: number, z: number, m = 0): boolean {
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      const so = s.solids;
      if (!so) continue;
      const dx = x - s.ox;
      const dz = z - s.oz;
      const r = so.reach + m;
      if (dx * dx + dz * dz > r * r) continue;
      if (so.contains(dx, y - s.oy, dz, m)) return true;
    }
    return false;
  }

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

  /** The places built now that people walk between: temples, oases, ruins and the rest. */
  landmarks(out: Landmark[]): Landmark[] {
    out.length = 0;
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      if (NOT_LANDMARKS.has(s.kind)) continue;
      out.push({ key: s.key, kind: s.kind, x: s.x, z: s.z, temple: s.temple });
    }
    return out;
  }

  /** The villages built now, with their people. */
  villages(out: Village[]): Village[] {
    out.length = 0;
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      if (s.folk) out.push({ key: s.key, kind: s.kind, snow: s.kind === 'snow-village', x: s.x, z: s.z, folk: s.folk });
    }
    return out;
  }

  /** Whether (x, z) is within reach of any site's stones, give or take a margin. */
  nearSolids(x: number, z: number, margin: number): boolean {
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      if (s.solids && Math.hypot(x - s.ox, z - s.oz) < s.solids.reach + margin) return true;
    }
    return false;
  }

  /**
   * Whether a disc of radius r at (x, z) comes near where a find stands on the surface, a
   * cavern runs under the sand or a mountain village stands, built yet or not. Decided from the seed alone, so it gives the
   * same answer whenever it is asked (for things scattered about that must keep off them); the one
   * exception is a wreck, which claims its ground from when setWrecks lays it there.
   */
  claimed(x: number, z: number, r: number): boolean {
    if (this.cellClaimed(x, z, r)) return true;
    // (and the wrecks lying out now, which are not the seed's: see setWrecks)
    for (const a of this.wreckAt) if (Math.hypot(a.x - x, a.z - z) < r + WRECK_CLEAR) return true;
    // a mountain village spreads some 70 m round its middle
    const w = this.world as Partial<DesertWorld>;
    if (!w.massif) return false;
    const gi0 = Math.round(x / CITY_CELL);
    const gj0 = Math.round(z / CITY_CELL);
    for (let gj = gj0 - 1; gj <= gj0 + 1; gj++) {
      for (let gi = gi0 - 1; gi <= gi0 + 1; gi++) {
        const id = (gi + 32768) * 65536 + (gj + 32768);
        let vils = this.villageCache.get(id);
        if (!vils) {
          const m = w.massif(gi, gj);
          if (!m) this.villageCache.set(id, (vils = NO_VILLAGES));
          else if (Math.hypot(m.x - x, m.z - z) > r + 70 + m.r * VILLAGE_REACH) continue;
          else vils = this.villagesOf(gi, gj, m);
        }
        for (const v of vils) if (Math.hypot(v.x - x, v.z - z) < r + 70) return true;
      }
    }
    return false;
  }

  /** `claimed`, for the finds and caverns of the cells alone. */
  private cellClaimed(x: number, z: number, r: number): boolean {
    const pcx = Math.floor(x / CELL);
    const pcz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        // an oasis settles up to 135 m from its cell's point, and a find spreads round it
        if (this.cellSite(cx, cz) && Math.hypot(this.cellPos.x - x, this.cellPos.z - z) < r + 220) return true;
        const cs = this.cavernAt(cx, cz);
        if (!cs) continue;
        const cv = cs.cav;
        const t = Math.max(0, Math.min(cv.len, (x - cv.x) * cv.dx + (z - cv.z) * cv.dz));
        if (Math.hypot(cv.x + cv.dx * t - x, cv.z + cv.dz * t - z) < r + cv.half + Math.abs(cv.bend) + cv.bulge + 25) return true;
      }
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

  /**
   * The find on the surface of a cell, built yet or not: where it stands and what it is, or null
   * for an empty cell. Decided from the cell alone (the same draws buildSite makes), so footpaths
   * can be laid to finds the wanderer has not come near yet.
   */
  surfaceSite(cx: number, cz: number): Landmark | null {
    const key = cellKey(cx, cz);
    let p = this.placeCache.get(key);
    if (p === undefined) {
      p = null;
      if (this.cellSite(cx, cz)) {
        const at = this.placeSite(cx, cz, mulberry32(Math.floor(hash4(cx, cz, this.world.seed | 0, 7) * 4294967296)));
        p = { key, kind: at.kind, x: at.x, z: at.z };
      }
      this.placeCache.set(key, p);
    }
    return p;
  }

  /** The surface finds (built or not) whose cells lie within r of (x, z). */
  surfaceSitesNear(x: number, z: number, r: number, out: Landmark[]): Landmark[] {
    out.length = 0;
    const c0x = Math.floor((x - r) / CELL);
    const c1x = Math.floor((x + r) / CELL);
    const c0z = Math.floor((z - r) / CELL);
    const c1z = Math.floor((z + r) / CELL);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const p = this.surfaceSite(cx, cz);
        if (p && Math.hypot(p.x - x, p.z - z) <= r) out.push(p);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- every site, built or not

  private pushRef(out: SiteRef[], key: number, kind: string, x: number, z: number, reachedKey: number): void {
    out.push({ key, kind, x, y: this.world.height(x, z), z, reached: this.reached.has(reachedKey) });
  }

  /**
   * Calls `each` for every massif site (summit, cave mouth, villages, springs) of the massifs whose grid
   * cells could reach within r of (x, z), with the key it is built under. `want` leaves out
   * kinds the caller has no use for, so springs (the dear ones to work out) are only found when asked for.
   */
  private eachMassifSite(x: number, z: number, r: number, want: (kind: string) => boolean, each: (key: number, kind: string, sx: number, sz: number) => void): void {
    const w = this.world as Partial<{ massif(gi: number, gj: number): Massif | null; cave(gi: number, gj: number): Cave | null }>;
    if (!w.massif || !w.cave) return;
    const gi0 = Math.floor((x - r) / CITY_CELL) - 1;
    const gi1 = Math.floor((x + r) / CITY_CELL) + 1;
    const gj0 = Math.floor((z - r) / CITY_CELL) - 1;
    const gj1 = Math.floor((z + r) / CITY_CELL) + 1;
    for (let gj = gj0; gj <= gj1; gj++) {
      for (let gi = gi0; gi <= gi1; gi++) {
        const m = w.massif(gi, gj);
        if (!m) continue;
        const id = (gi + 32768) * 65536 + (gj + 32768);
        if (want('summit')) each(-(id * 16 + 1), 'summit', m.x, m.z);
        if (want('mountain-village') && Math.hypot(m.x - x, m.z - z) < r + m.r * VILLAGE_REACH) {
          const vils = this.villagesOf(gi, gj, m);
          for (let k = 0; k < vils.length; k++) each(VILLAGE_KEY - (id * 4 + k), 'mountain-village', vils[k].x, vils[k].z);
        }
        if (want('cave')) {
          const cv = w.cave(gi, gj);
          if (cv) each(-(id * 16 + 2), 'cave', cv.x + cv.dx * TERRAIN.caveLen * 0.6, cv.z + cv.dz * TERRAIN.caveLen * 0.6);
        }
        if (want('spring')) {
          let springs = this.springCache.get(id);
          if (!springs) {
            springs = this.findSprings(m);
            this.springCache.set(id, springs);
          }
          for (let k = 0; k < springs.length && k < 12; k++) each(-(id * 16 + 3 + k), 'spring', springs[k].x, springs[k].z);
        }
      }
    }
  }

  /** The frostland's villages, when the layout is awake for a wanderer at (x, z). */
  private eachFrostVillage(x: number, z: number, each: (key: number, vx: number, vz: number) => void): void {
    const lay = this.frostLayoutNear(x, z);
    if (!lay) return;
    for (let i = 0; i < lay.villages.length; i++) each(FROST_KEY - 1000 - i, lay.villages[i].x, lay.villages[i].z);
  }

  /**
   * Every discovery site within r of (x, z), built yet or not: the surface finds, the caverns,
   * and the summits, caves and springs of the massifs, and the snow villages once the frostland
   * is within reach (as when they are built). `out` is cleared, filled and returned. Keys: a surface
   * find keeps its cell's key, a cavern is CAVERN_REF minus its cell's key (so as not to clash with
   * a find on the same cell), a massif's and a village's are the ones they are built under. The
   * wrecks lying out now (setWrecks) are there too, under WRECK_KEY less where each lies.
   */
  sitesNear(x: number, z: number, r: number, out: SiteRef[]): SiteRef[] {
    out.length = 0;
    const c0x = Math.floor((x - r) / CELL);
    const c1x = Math.floor((x + r) / CELL);
    const c0z = Math.floor((z - r) / CELL);
    const c1z = Math.floor((z + r) / CELL);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const p = this.surfaceSite(cx, cz);
        if (p && Math.hypot(p.x - x, p.z - z) <= r) this.pushRef(out, p.key, p.kind, p.x, p.z, p.key);
        const cs = this.cavernAt(cx, cz);
        if (cs) {
          const cv = cs.cav;
          const sx = cv.x + cv.dx * cv.spot;
          const sz = cv.z + cv.dz * cv.spot;
          if (Math.hypot(sx - x, sz - z) <= r) this.pushRef(out, CAVERN_REF - cs.key, 'cavern', sx, sz, roofKey(cs));
        }
      }
    }
    this.eachMassifSite(x, z, r, () => true, (key, kind, sx, sz) => {
      if (Math.hypot(sx - x, sz - z) <= r) this.pushRef(out, key, kind, sx, sz, key);
    });
    this.eachFrostVillage(x, z, (key, vx, vz) => {
      if (Math.hypot(vx - x, vz - z) <= r) this.pushRef(out, key, 'snow-village', vx, vz, key);
    });
    for (const a of this.wreckAt) if (Math.hypot(a.x - x, a.z - z) <= r) this.pushRef(out, a.key, 'wreck', a.x, a.z, a.key);
    return out;
  }

  /**
   * The nearest site (as sitesNear knows them) of a kind the wanderer has not found, within
   * maxR, or null. Massif sites first (few), then rings of cells outward, stopping once no
   * further ring can beat what is in hand.
   */
  nearestUnfound(x: number, z: number, found: ReadonlySet<string>, maxR: number): SiteRef | null {
    let bd = maxR;
    let bk = 0;
    let bkind = '';
    let bx = 0;
    let bz = 0;
    let bkey = 0;
    let have = false;
    const take = (key: number, kind: string, sx: number, sz: number, reachedKey: number): void => {
      const d = Math.hypot(sx - x, sz - z);
      if (d > bd || (d === bd && have)) return;
      bd = d;
      bkey = key;
      bkind = kind;
      bx = sx;
      bz = sz;
      bk = reachedKey;
      have = true;
    };
    const want = (kind: string): boolean => isFindKind(kind) && !found.has(kind);
    this.eachMassifSite(x, z, maxR, want, (key, kind, sx, sz) => take(key, kind, sx, sz, key));
    if (want('snow-village')) this.eachFrostVillage(x, z, (key, vx, vz) => take(key, 'snow-village', vx, vz, key));
    const pcx = Math.floor(x / CELL);
    const pcz = Math.floor(z / CELL);
    const wantCavern = want('cavern');
    const rings = Math.ceil(maxR / CELL) + 1;
    for (let r = 0; r <= rings; r++) {
      // a cell r rings out is at least (r - 1) cells away
      if ((r - 1) * CELL > bd) break;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = pcx + dx;
          const cz = pcz + dz;
          const p = this.surfaceSite(cx, cz);
          if (p && want(p.kind)) take(p.key, p.kind, p.x, p.z, p.key);
          if (!wantCavern) continue;
          const cs = this.cavernAt(cx, cz);
          if (cs) take(CAVERN_REF - cs.key, 'cavern', cs.cav.x + cs.cav.dx * cs.cav.spot, cs.cav.z + cs.cav.dz * cs.cav.spot, roofKey(cs));
        }
      }
    }
    if (!have) return null;
    return { key: bkey, kind: bkind, x: bx, y: this.world.height(bx, bz), z: bz, reached: this.reached.has(bk) };
  }

  /**
   * Where a cell's find settles and what kind it is. Takes the cell's own rng and leaves it where
   * buildSite carries on from, so a find placed here and one built match exactly.
   */
  private placeSite(cx: number, cz: number, rng: () => number): { kind: string; x: number; z: number; onSalt: boolean; dx?: number; dz?: number } {
    this.cellSite(cx, cz);
    let x = this.cellPos.x;
    let z = this.cellPos.z;
    const w = this.world;
    const s = w.sample(x, z, this.sample);
    const h = s.h;
    let mean = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      mean += w.height(x + Math.cos(a) * 250, z + Math.sin(a) * 250);
    }
    mean /= 8;
    if (this.cellSpare === 'inn') {
      const inn = this.innAt(cx, cz)!;
      rng();
      return { kind: 'caravanserai', x: inn.x, z: inn.z, onSalt: false, dx: inn.dx, dz: inn.dz };
    }
    if (this.cellSpare === 'settlement') {
      // a settlement goes where the ground suits its kind, and faces the way that ground asks
      const seed = w.seed | 0;
      const at = settle(w as SettleWorld, x, z, (i) => hash4(cx, cz, seed, 60 + i), (sx, sz, r) => this.settleClear(cx, cz, sx, sz, r));
      rng();
      return { kind: at.kind, x: at.x, z: at.z, onSalt: false, dx: at.dx, dz: at.dz };
    }
    if (this.cellSpare !== '') {
      // a hamlet or a watchtower settles on the level sand nearby, off rock and salt
      const spare = this.cellSpare;
      let best = Infinity;
      let bx = x;
      let bz = z;
      const x0 = x;
      const z0 = z;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const tx = x0 + i * 50;
          const tz = z0 + j * 50;
          const t = w.sample(tx, tz, this.sample);
          const slope = Math.abs(w.height(tx + 25, tz) - w.height(tx - 25, tz)) + Math.abs(w.height(tx, tz + 25) - w.height(tx, tz - 25));
          const score = slope + 40 * t.rock + 40 * t.salt + (i * i + j * j) * 0.3;
          if (score < best) {
            best = score;
            bx = tx;
            bz = tz;
          }
        }
      }
      rng();
      return { kind: spare, x: bx, z: bz, onSalt: false };
    }
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
        q < 0.17 ? 'temple'
        : q < 0.35 ? 'ruins'
        : q < 0.51 ? 'bones'
        : q < 0.62 ? 'shell'
        : q < 0.73 ? 'standing-stones'
        : q < 0.85 ? 'lantern'
        : q < 0.92 && h < mean + 2 ? 'oasis'
        : 'sundial';
    }
    // A temple wants open, fairly level sand: on a steep slope it would stand on a cliff of footing.
    if (kind === 'temple' && Math.abs(w.height(x + 20, z) - w.height(x - 20, z)) + Math.abs(w.height(x, z + 20) - w.height(x, z - 20)) > 9) kind = 'ruins';
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
    return { kind, x, z, onSalt: s.salt > 0.35 };
  }

  private buildSite(cx: number, cz: number): void {
    const w = this.world;
    const rng = mulberry32(Math.floor(hash4(cx, cz, w.seed | 0, 7) * 4294967296));
    const { kind, x, z, onSalt, dx, dz } = this.placeSite(cx, cz, rng);
    const baseY = w.height(x, z);
    const turn = rng() * Math.PI * 2;
    // (a settlement's frame faces the way its ground asks: +u along (dx, dz))
    const ctx = new Ctx(w, x, z, baseY, rng, dx === undefined || dz === undefined ? turn : Math.atan2(-dz, dx));
    ctx.stone.salt = (cx * 31 + cz * 17) & 1023;
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
      case 'hamlet': buildHamlet(ctx); break;
      case 'watchtower': buildWatchtower(ctx); break;
      case 'sundial': buildSundial(ctx, onSalt); break;
      case 'temple': buildTemple(ctx); break;
      default:
        if (isSettlement(kind)) buildSettlement(kind, ctx, KIT);
        else buildShell(ctx);
        break;
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
      temple: ctx.temple ? templeMarks(ctx, baseY) : undefined,
      folk: ctx.folk?.map((f) => ({ x: ctx.x + f.u, z: ctx.z + f.v, yaw: Math.atan2(f.fu - f.u, f.fv - f.v), sit: f.sit, role: f.role, small: f.small, coat: f.coat, y: f.y === undefined ? undefined : baseY + f.y })),
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
    // the deep under a cavern goes with it (it is usually long gone: see scanDeeps)
    if (s.kind === 'cavern') {
      const cs = this.cavernCache.get(Math.floor(s.key));
      if (cs) this.dropDeep(cs);
    }
    s.group.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
    });
  }

  /** Frees everything, including the shared materials. */
  dispose(): void {
    for (const s of this.sites) this.disposeSite(s);
    this.sites.length = 0;
    while (this.deeps.length > 0) this.dropDeep(this.deeps[0]);
    this.stoneMat.dispose();
    this.rockMat.dispose();
    this.waterMat.dispose();
    this.frondMat.dispose();
    this.glowMat.dispose();
    this.veinMat.dispose();
    this.relicGlowMat.dispose();
    this.shaftMat.dispose();
    this.underWaterMat.dispose();
    this.ropeMesh?.geometry.dispose();
    this.toolMat?.dispose();
    if (this.carpet) {
      this.carpet.group.traverse((o) => {
        if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
      });
      this.carpet.mat.dispose();
    }
  }
}

function templeMarks(ctx: Ctx, baseY: number): TempleMarks {
  const t = ctx.temple!;
  const w = (p: readonly number[]) => ({ x: ctx.x + p[0], y: baseY + p[1], z: ctx.z + p[2] });
  return { foot: w(t.foot), end: w(t.end), yaw: t.yaw, offer: w(t.offer), keep: t.keep.map((k) => ({ ...w(k), yaw: k[3] })) };
}

function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

/** The site key of a wreck lying at (x, z): from where it lies to 4 m, so the same wreck has the same key every visit. */
function wreckKey(x: number, z: number): number {
  const qx = Math.round(x / 4) & 0xfffff;
  const qz = Math.round(z / 4) & 0xfffff;
  return WRECK_KEY - (qx * 0x100000 + qz);
}
