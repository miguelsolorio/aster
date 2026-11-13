// The animals of the open desert: oryx herds that graze and bolt, fennec foxes out after dark,
// hares that lope off when you come close, lizards on warm ground, and vultures circling over
// bones and ruins. All of them are one instanced draw call: legs, heads, ears, tails and wings
// move in the vertex shader, and only where they are and what they're doing is worked out here.
import * as THREE from 'three';
import type { FrameState, SurfaceSample, Uniforms, World } from '../game/contract';
import { GB } from '../city/caravans';
import type { Landmark } from './discoveries';
import { STYLE_GLSL } from '../render/styleGlsl';

const CAP = 128;
const BIG_CELL = 320; // one oryx herd at most per cell
const SMALL_CELL = 90; // one small animal (or a few) at most per cell
const BIG_R = 720; // herds are kept within this of the player
const SMALL_R = 240; // small animals within this: further out they're specks
const SCAN_EVERY = 0.5;
const TAU = Math.PI * 2;

export const ORYX = 0;
export const FOX = 1;
export const HARE = 2;
export const LIZARD = 3;
export const VULTURE = 4;

type V3 = [number, number, number];

interface Spec {
  walk: number; // m/s
  run: number;
  flee: number; // bolts when the player comes this close (m)
  stride: number; // metres per gait cycle at a walk
  runStride: number;
  turn: number; // rad/s
  roam: number; // wanders this far from home (m)
  coat: V3;
}

const SPEC: Spec[] = [
  { walk: 1.0, run: 9, flee: 30, stride: 1.5, runStride: 3.6, turn: 2.0, roam: 35, coat: [0.86, 0.8, 0.7] },
  { walk: 1.1, run: 6.5, flee: 13, stride: 0.42, runStride: 1.1, turn: 4.0, roam: 30, coat: [0.88, 0.74, 0.54] },
  { walk: 1.0, run: 8, flee: 10, stride: 0.5, runStride: 1.5, turn: 5.0, roam: 14, coat: [0.6, 0.5, 0.38] },
  { walk: 0.4, run: 4, flee: 5, stride: 0.1, runStride: 0.22, turn: 8.0, roam: 3, coat: [0.66, 0.55, 0.4] },
  { walk: 9, run: 9, flee: 0, stride: 1, runStride: 1, turn: 1, roam: 0, coat: [0.3, 0.24, 0.2] },
];

// ------------------------------------------------------------------ geometry

// Kinds: 0 rigid, 1 leg (aRig.x phase offset), 2 head and neck (aRig.z weight), 3 tail (aRig.z
// weight along it), 4 ear (follows the head, aRig.w side), 5 wing (aRig.z side).
// Materials: 0 coat, 1 dark coat, 2 pale (belly, face, lower legs), 3 horn, 4 eye and nose, 5 inner ear.
// Part: the species; the shader drops every part but the instance's own.

function oryx(b: GB): void {
  b.set(0, 0, ORYX).tube(
    [
      { c: [0, 0.95, -0.72], rx: 0.2, rz: 0.22 },
      { c: [0, 1.0, -0.45], rx: 0.27, rz: 0.3 },
      { c: [0, 1.02, 0.1], rx: 0.26, rz: 0.31 },
      { c: [0, 1.06, 0.5], rx: 0.24, rz: 0.3 },
      { c: [0, 1.12, 0.68], rx: 0.17, rz: 0.2 },
    ],
    7,
    0,
    true,
    true,
  );
  // the dark band along the flank
  b.set(0, 1, ORYX).tube(
    [
      { c: [0, 0.83, -0.48], rx: 0.276, rz: 0.07 },
      { c: [0, 0.84, 0.1], rx: 0.266, rz: 0.07 },
      { c: [0, 0.86, 0.48], rx: 0.246, rz: 0.07 },
    ],
    7,
    0,
    false,
    false,
  );
  for (const [fx, fz, ph] of [
    [0.13, 0.48, 0],
    [-0.13, 0.48, 0.5],
    [0.13, -0.5, 0.5],
    [-0.13, -0.5, 0],
  ] as V3[]) {
    const back = fz < 0 ? -0.06 : 0.02;
    b.set(1, 1, ORYX, ph, [fx, 0.9, fz]).tube(
      [
        { c: [fx, 0.92, fz], rx: 0.075, rz: 0.075 },
        { c: [fx, 0.5, fz + back], rx: 0.042, rz: 0.042 },
      ],
      4,
      Math.PI / 4,
      false,
      false,
    );
    b.set(1, 2, ORYX, ph, [fx, 0.9, fz]).tube(
      [
        { c: [fx, 0.5, fz + back], rx: 0.042, rz: 0.042 },
        { c: [fx, 0.06, fz], rx: 0.032, rz: 0.032 },
        { c: [fx, 0, fz + 0.03], rx: 0.036, rz: 0.036 },
      ],
      4,
      Math.PI / 4,
      false,
      true,
    );
  }
  const NP: V3 = [0, 1.12, 0.62];
  b.set(2, 0, ORYX, 0, NP, 1).tube(
    [
      { c: [0, 1.05, 0.58], rx: 0.13, rz: 0.17 },
      { c: [0, 1.38, 0.82], rx: 0.09, rz: 0.1 },
      { c: [0, 1.47, 0.9], rx: 0.085, rz: 0.085 },
    ],
    6,
    0,
    false,
    false,
  );
  b.set(2, 2, ORYX, 0, NP, 1).tube(
    [
      { c: [0, 1.5, 0.85], rx: 0.075, rz: 0.08 },
      { c: [0, 1.47, 1.0], rx: 0.07, rz: 0.075 },
      { c: [0, 1.37, 1.17], rx: 0.045, rz: 0.045 },
    ],
    6,
    0,
    true,
    true,
  );
  b.set(2, 4, ORYX, 0, NP, 1);
  b.box(0.068, 1.49, 0.98, 0.03, 0.03, 0.03);
  b.box(-0.068, 1.49, 0.98, 0.03, 0.03, 0.03);
  b.box(0, 1.45, 1.06, 0.15, 0.035, 0.07);
  for (const s of [-1, 1]) {
    // long straight horns, swept back
    b.set(2, 3, ORYX, 0, NP, 1).tube(
      [
        { c: [s * 0.04, 1.53, 0.9], rx: 0.022, rz: 0.022 },
        { c: [s * 0.09, 1.95, 0.68], rx: 0.016, rz: 0.016 },
        { c: [s * 0.12, 2.25, 0.52], rx: 0.005, rz: 0.005 },
      ],
      4,
      0,
      false,
      false,
    );
    b.set(4, 0, ORYX, 0, NP, 1, s).tube(
      [
        { c: [s * 0.07, 1.55, 0.86], rx: 0.03, rz: 0.03 },
        { c: [s * 0.17, 1.6, 0.8], rx: 0.012, rz: 0.025 },
      ],
      4,
      0,
      false,
      true,
    );
  }
  b.set(3, 1, ORYX, 0, [0, 0.98, -0.72]).tube(
    [
      { c: [0, 0.98, -0.74], rx: 0.035, rz: 0.035, z: 0 },
      { c: [0, 0.72, -0.84], rx: 0.03, rz: 0.05, z: 1 },
    ],
    4,
    0,
    false,
    true,
  );
}

function fox(b: GB): void {
  b.set(0, 0, FOX).tube(
    [
      { c: [0, 0.2, -0.17], rx: 0.06, rz: 0.065 },
      { c: [0, 0.215, -0.05], rx: 0.075, rz: 0.08 },
      { c: [0, 0.22, 0.08], rx: 0.07, rz: 0.075 },
      { c: [0, 0.235, 0.15], rx: 0.05, rz: 0.055 },
    ],
    6,
    0,
    true,
    true,
  );
  for (const [fx, fz, ph] of [
    [0.045, 0.11, 0],
    [-0.045, 0.11, 0.5],
    [0.045, -0.13, 0.5],
    [-0.045, -0.13, 0],
  ] as V3[]) {
    b.set(1, 2, FOX, ph, [fx, 0.2, fz]).tube(
      [
        { c: [fx, 0.2, fz], rx: 0.022, rz: 0.022 },
        { c: [fx, 0.0, fz + 0.01], rx: 0.013, rz: 0.013 },
      ],
      4,
      Math.PI / 4,
      false,
      true,
    );
  }
  const NP: V3 = [0, 0.24, 0.15];
  b.set(2, 0, FOX, 0, NP, 1).tube(
    [
      { c: [0, 0.255, 0.15], rx: 0.045, rz: 0.05 },
      { c: [0, 0.29, 0.21], rx: 0.055, rz: 0.055 },
      { c: [0, 0.27, 0.27], rx: 0.03, rz: 0.03 },
      { c: [0, 0.255, 0.32], rx: 0.01, rz: 0.01 },
    ],
    6,
    0,
    false,
    true,
  );
  b.set(2, 4, FOX, 0, NP, 1);
  b.box(0, 0.256, 0.322, 0.016, 0.014, 0.012);
  b.box(0.026, 0.3, 0.25, 0.012, 0.012, 0.012);
  b.box(-0.026, 0.3, 0.25, 0.012, 0.012, 0.012);
  for (const s of [-1, 1]) {
    // the ears: as tall as the head is long
    b.set(4, 5, FOX, 0, NP, 1, s).tube(
      [
        { c: [s * 0.03, 0.31, 0.2], rx: 0.034, rz: 0.012 },
        { c: [s * 0.065, 0.39, 0.185], rx: 0.024, rz: 0.009 },
        { c: [s * 0.088, 0.46, 0.175], rx: 0.004, rz: 0.004 },
      ],
      5,
      0,
      false,
      true,
    );
  }
  b.set(3, 0, FOX, 0, [0, 0.2, -0.18]).tube(
    [
      { c: [0, 0.2, -0.18], rx: 0.025, rz: 0.025, z: 0.1 },
      { c: [0, 0.15, -0.3], rx: 0.045, rz: 0.045, z: 0.6 },
      { c: [0, 0.12, -0.4], rx: 0.04, rz: 0.04, z: 1 },
    ],
    6,
    0,
    false,
    false,
  );
  b.set(3, 1, FOX, 0, [0, 0.2, -0.18]).tube(
    [
      { c: [0, 0.12, -0.4], rx: 0.04, rz: 0.04, z: 1 },
      { c: [0, 0.11, -0.46], rx: 0.005, rz: 0.005, z: 1 },
    ],
    6,
    0,
    false,
    true,
  );
}

function hare(b: GB): void {
  b.set(0, 0, HARE).tube(
    [
      { c: [0, 0.16, -0.15], rx: 0.08, rz: 0.09 },
      { c: [0, 0.19, -0.05], rx: 0.1, rz: 0.11 },
      { c: [0, 0.21, 0.07], rx: 0.075, rz: 0.085 },
      { c: [0, 0.23, 0.13], rx: 0.05, rz: 0.06 },
    ],
    6,
    0,
    true,
    true,
  );
  for (const s of [-1, 1]) {
    // long hind legs folded under, both together; short front legs
    b.set(1, 0, HARE, 0, [s * 0.07, 0.15, -0.08]).tube(
      [
        { c: [s * 0.07, 0.15, -0.08], rx: 0.035, rz: 0.035 },
        { c: [s * 0.08, 0.04, -0.06], rx: 0.025, rz: 0.025 },
        { c: [s * 0.08, 0.01, -0.03], rx: 0.02, rz: 0.02 },
        { c: [s * 0.075, 0.01, 0.07], rx: 0.016, rz: 0.016 },
      ],
      4,
      Math.PI / 4,
      false,
      true,
    );
    b.set(1, 0, HARE, 0.5, [s * 0.04, 0.17, 0.1]).tube(
      [
        { c: [s * 0.04, 0.17, 0.1], rx: 0.016, rz: 0.016 },
        { c: [s * 0.04, 0.0, 0.13], rx: 0.012, rz: 0.012 },
      ],
      4,
      Math.PI / 4,
      false,
      true,
    );
  }
  const NP: V3 = [0, 0.24, 0.13];
  b.set(2, 0, HARE, 0, NP, 1).tube(
    [
      { c: [0, 0.25, 0.12], rx: 0.04, rz: 0.045 },
      { c: [0, 0.29, 0.18], rx: 0.048, rz: 0.05 },
      { c: [0, 0.27, 0.24], rx: 0.025, rz: 0.028 },
    ],
    6,
    0,
    false,
    true,
  );
  b.set(2, 4, HARE, 0, NP, 1);
  b.box(0.035, 0.3, 0.2, 0.012, 0.012, 0.012);
  b.box(-0.035, 0.3, 0.2, 0.012, 0.012, 0.012);
  for (const s of [-1, 1]) {
    b.set(4, 0, HARE, 0, NP, 1, s).tube(
      [
        { c: [s * 0.02, 0.31, 0.16], rx: 0.02, rz: 0.01 },
        { c: [s * 0.035, 0.42, 0.11], rx: 0.022, rz: 0.01 },
        { c: [s * 0.042, 0.5, 0.07], rx: 0.006, rz: 0.006 },
      ],
      5,
      0,
      false,
      true,
    );
  }
  b.set(0, 2, HARE).box(0, 0.18, -0.2, 0.05, 0.05, 0.04);
}

function lizard(b: GB): void {
  b.set(0, 0, LIZARD).tube(
    [
      { c: [0, 0.03, -0.06], rx: 0.02, rz: 0.014 },
      { c: [0, 0.035, 0.03], rx: 0.025, rz: 0.016 },
      { c: [0, 0.035, 0.09], rx: 0.016, rz: 0.012 },
      { c: [0, 0.03, 0.13], rx: 0.004, rz: 0.004 },
    ],
    5,
    0,
    true,
    true,
  );
  b.set(3, 0, LIZARD, 0, [0, 0.03, -0.06]).tube(
    [
      { c: [0, 0.03, -0.06], rx: 0.014, rz: 0.012, z: 0 },
      { c: [0, 0.02, -0.15], rx: 0.008, rz: 0.007, z: 0.5 },
      { c: [0, 0.012, -0.26], rx: 0.002, rz: 0.002, z: 1 },
    ],
    4,
    0,
    false,
    true,
  );
  for (const [s, fz, ph] of [
    [1, 0.05, 0],
    [-1, 0.05, 0.5],
    [1, -0.04, 0.5],
    [-1, -0.04, 0],
  ] as V3[]) {
    b.set(1, 1, LIZARD, ph, [s * 0.02, 0.03, fz]).tube(
      [
        { c: [s * 0.02, 0.03, fz], rx: 0.006, rz: 0.006 },
        { c: [s * 0.055, 0.02, fz + 0.01], rx: 0.005, rz: 0.005 },
        { c: [s * 0.065, 0.0, fz + 0.025], rx: 0.004, rz: 0.004 },
      ],
      3,
      0,
      false,
      true,
    );
  }
}

function vulture(b: GB): void {
  b.set(0, 0, VULTURE).tube(
    [
      { c: [0, 0, -0.35], rx: 0.08, rz: 0.06 },
      { c: [0, 0, -0.1], rx: 0.14, rz: 0.12 },
      { c: [0, 0.01, 0.2], rx: 0.12, rz: 0.1 },
      { c: [0, 0.03, 0.36], rx: 0.07, rz: 0.07 },
    ],
    6,
    0,
    true,
    false,
  );
  b.set(0, 2, VULTURE).tube(
    [
      { c: [0, 0.03, 0.33], rx: 0.1, rz: 0.09 },
      { c: [0, 0.04, 0.4], rx: 0.09, rz: 0.08 },
    ],
    6,
    0,
    false,
    false,
  );
  b.set(0, 2, VULTURE).tube(
    [
      { c: [0, 0.04, 0.4], rx: 0.04, rz: 0.04 },
      { c: [0, 0.05, 0.52], rx: 0.04, rz: 0.04 },
      { c: [0, 0.03, 0.58], rx: 0.045, rz: 0.04 },
      { c: [0, 0.0, 0.66], rx: 0.01, rz: 0.01 },
    ],
    5,
    0,
    false,
    true,
  );
  // tail fan
  b.set(0, 1, VULTURE);
  b.tri([-0.1, 0, -0.32], [0.1, 0, -0.32], [0.16, 0, -0.62], null);
  b.tri([-0.1, 0, -0.32], [0.16, 0, -0.62], [-0.16, 0, -0.62], null);
  for (const s of [-1, 1]) {
    // broad wings with fingered tips; they bend at the shoulder
    b.set(5, 0, VULTURE, 0, [s * 0.12, 0.02, 0], s);
    const P = (x: number, z: number): V3 => [s * x, 0.02 - 0.03 * x, z];
    b.tri(P(0.1, 0.18), P(0.8, 0.16), P(0.8, -0.34), null);
    b.tri(P(0.1, 0.18), P(0.8, -0.34), P(0.1, -0.3), null);
    b.set(5, 1, VULTURE, 0, [s * 0.12, 0.02, 0], s);
    b.tri(P(0.8, 0.16), P(1.2, 0.1), P(1.2, -0.26), null);
    b.tri(P(0.8, 0.16), P(1.2, -0.26), P(0.8, -0.34), null);
    for (let k = 0; k < 5; k++) {
      const z0 = 0.08 - k * 0.075;
      b.tri(P(1.2, z0), P(1.2, z0 - 0.06), P(1.48 - k * 0.03, z0 - 0.05 - k * 0.012), null);
    }
  }
}

function faunaGeometry(): THREE.InstancedBufferGeometry {
  const b = new GB();
  oryx(b);
  fox(b);
  hare(b);
  lizard(b);
  vulture(b);
  return b.geometry();
}

// ------------------------------------------------------------------ shaders

const vert = /* glsl */ `
attribute vec4 aRig;
attribute vec3 aPivot;
attribute vec2 aMP;
attribute vec4 iPos;  // xyz, yaw
attribute vec4 iUp;   // up (xyz), head turn (w)
attribute vec4 iMot;  // gait phase, gait (0 still .. 1 walk .. 2 full run), pose (head down), scale
attribute vec4 iCoat; // rgb, species + seed
uniform float uTime;
varying vec3 vW;
varying vec3 vN;
varying vec3 vCol;
varying float vY;
vec3 rotX(vec3 v, float a) { float c = cos(a); float s = sin(a); return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c); }
vec3 rotY(vec3 v, float a) { float c = cos(a); float s = sin(a); return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }
vec3 rotZ(vec3 v, float a) { float c = cos(a); float s = sin(a); return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z); }
void main() {
  float sp = floor(iCoat.w + 0.001);
  float seed = fract(iCoat.w);
  if (abs(aMP.y - sp) > 0.5 || iMot.w < 0.001) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vW = vec3(0.0); vN = vec3(0.0, 1.0, 0.0); vCol = vec3(0.0); vY = 0.0;
    return;
  }
  float TAU = 6.2831853;
  float kind = aRig.y;
  float ph = iMot.x;
  float g = iMot.y;
  float walk = min(g, 1.0);
  float run = clamp(g - 1.0, 0.0, 1.0);
  float pose = iMot.z;
  float T = uTime;
  vec3 p = position;
  vec3 n = normal;
  float th = TAU * (ph + aRig.x);
  if (kind > 0.5 && kind < 1.5) {
    float amp = sp > 2.5 ? 0.9 : mix(0.45, 0.85, run);
    if (sp > 1.5 && sp < 2.5) amp = 0.9;
    float a = amp * walk * sin(th);
    p = aPivot + rotX(p - aPivot, a);
    n = rotX(n, a);
  } else if (kind > 1.5 && kind < 2.5 || kind > 3.5 && kind < 4.5) {
    float w = aRig.z;
    float pitch = (pose * 1.35 + 0.07 * walk * sin(2.0 * TAU * ph) + 0.04 * sin(T * 0.8 + seed * 30.0)) * w;
    float turn = iUp.w * w;
    vec3 q = p - aPivot;
    if (kind > 3.5) {
      // an ear flicks now and then
      float flick = pow(max(sin(T * 1.3 + seed * 50.0 + aRig.w), 0.0), 16.0);
      q = rotZ(q, -0.35 * aRig.w * flick);
    }
    q = rotY(rotX(q, pitch), turn);
    n = rotY(rotX(n, pitch), turn);
    p = aPivot + q;
  } else if (kind > 2.5 && kind < 3.5) {
    float b = (0.3 * sin(T * 1.9 + seed * 20.0) + 0.35 * walk * sin(th) + run * 0.2) * aRig.z;
    p = aPivot + rotY(p - aPivot, b);
    n = rotY(n, b);
  } else if (kind > 4.5) {
    float a = aRig.z * (g * sin(TAU * ph) + 0.08);
    p = aPivot + rotZ(p - aPivot, a);
    n = rotZ(n, a);
  }
  if (sp > 2.5 && sp < 3.5) {
    // a lizard runs in a sideways S
    p.x += sin(p.z * 26.0 - TAU * ph) * (0.004 + 0.012 * walk) * smoothstep(0.14, -0.1, p.z);
  }
  if (sp > 1.5 && sp < 2.5) {
    // a hare lopes: the whole body arcs up between landings
    p.y += 0.1 * walk * (0.4 + run) * max(0.0, sin(TAU * ph));
  } else if (sp < 1.5 && !(kind > 0.5 && kind < 1.5)) {
    p.y += (0.015 + 0.05 * run) * walk * sin(2.0 * TAU * ph) * (sp < 0.5 ? 1.0 : 0.3);
  }
  vY = position.y;
  p *= iMot.w;
  vec3 up = normalize(iUp.xyz);
  float yaw = iPos.w;
  vec3 f0 = vec3(sin(yaw), 0.0, cos(yaw));
  vec3 r = normalize(cross(up, f0));
  vec3 f = cross(r, up);
  vec3 wp = iPos.xyz + r * p.x + up * p.y + f * p.z;
  vW = wp;
  vN = normalize(r * n.x + up * n.y + f * n.z);
  float m = aMP.x;
  vec3 coat = iCoat.rgb;
  vec3 c;
  if (m < 0.5) c = coat;
  else if (m < 1.5) c = coat * 0.42;
  else if (m < 2.5) c = mix(coat, vec3(0.95, 0.92, 0.86), 0.6);
  else if (m < 3.5) c = vec3(0.13, 0.11, 0.1);
  else if (m < 4.5) c = vec3(0.05, 0.04, 0.04);
  else c = coat * vec3(1.08, 0.82, 0.76);
  vCol = c;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const frag = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uNight;
varying vec3 vW;
varying vec3 vN;
varying vec3 vCol;
varying float vY;
${STYLE_GLSL}
void main() {
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  n = styleFacet(n, vW);
  float ndl = dot(n, uSunDir);
  float l = styleBands(smoothstep(-0.35, 0.75, ndl), vW.xz);
  float bright = clamp(uLit.g * 1.25, 0.12, 1.0);
  vec3 tint = mix(vec3(1.0), uLit / max(uLit.g, 0.02), 0.35);
  vec3 lit = vCol * tint * bright;
  vec3 ratio = clamp(uShade / max(uLit, vec3(0.03)), 0.3, 0.85);
  vec3 col = mix(lit * ratio, lit, l);
  col += vCol * vec3(0.10, 0.13, 0.19) * uNight;
  col *= 0.9 + 0.1 * n.y;
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * smoothstep(-0.2, 0.3, ndl);
  col += uSunCol * rim * 0.12 * (1.0 - 0.5 * uNight);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

// ------------------------------------------------------------------ helpers

function hash(a: number, b: number, c: number, d: number): number {
  let h = 0x9e3779b9 ^ Math.imul(a | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) ^ Math.imul(b | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) ^ Math.imul(d | 0, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 13;
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

function angDiff(a: number, b: number): number {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function ss(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

class Inst {
  readonly arr: Float32Array;
  readonly attr: THREE.InstancedBufferAttribute;
  constructor(cap: number) {
    this.arr = new Float32Array(cap * 4);
    this.attr = new THREE.InstancedBufferAttribute(this.arr, 4);
    this.attr.setUsage(THREE.DynamicDrawUsage);
  }
}

// ------------------------------------------------------------------ animals

interface Animal {
  sp: number;
  x: number;
  z: number;
  yaw: number;
  spd: number;
  ph: number;
  /** 0 standing (grazing, sniffing, basking), 1 walking somewhere, 2 running away. */
  state: number;
  t: number;
  tx: number;
  tz: number;
  pose: number;
  poseT: number;
  look: number;
  scale: number;
  coat: V3;
  seed: number;
  // vultures: the circle they ride
  cx: number;
  cz: number;
  r: number;
  w: number;
  alt: number;
  flap: number;
  burst: number;
}

interface Herd {
  key: number;
  sp: number;
  hx: number;
  hz: number;
  animals: Animal[];
  pres: number;
  /** Something has spooked them: every animal in the herd runs. */
  alarm: number;
  small: boolean;
}

export class Fauna {
  readonly group = new THREE.Group();
  /** The places built now (for vultures to circle over bones and ruins). Set by the game. */
  landmarks: ((out: Landmark[]) => Landmark[]) | null = null;
  /** Whether (x, z) is no place for animals to live: in a city, or among a site's stones. Set by the game. */
  blocked: ((x: number, z: number) => boolean) | null = null;
  /** An animal has called out, this far from the player (m). */
  onCall: ((sp: number, dist: number) => void) | null = null;

  private readonly world: World;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly iPos = new Inst(CAP);
  private readonly iUp = new Inst(CAP);
  private readonly iMot = new Inst(CAP);
  private readonly iCoat = new Inst(CAP);
  private n = 0;
  private readonly herds = new Map<number, Herd>();
  private readonly marks: Landmark[] = [];
  private scanT = 0;
  private callT = 20;
  private readonly sample: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private readonly nrm = new THREE.Vector3();

  constructor(world: World, uniforms: Uniforms) {
    this.world = world;
    this.group.name = 'fauna';
    this.geo = faunaGeometry();
    this.geo.setAttribute('iPos', this.iPos.attr);
    this.geo.setAttribute('iUp', this.iUp.attr);
    this.geo.setAttribute('iMot', this.iMot.attr);
    this.geo.setAttribute('iCoat', this.iCoat.attr);
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({ uniforms: { ...uniforms }, vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.frustumCulled = false;
    mesh.name = 'fauna-draw';
    this.group.add(mesh);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.group.clear();
  }

  /** How many animals are about right now, by species (for checking from the console). */
  census(): number[] {
    const c = [0, 0, 0, 0, 0];
    for (const h of this.herds.values()) if (h.pres > 0.5) c[h.sp] += h.animals.length;
    return c;
  }

  // ---------------------------------------------------------------- spawning

  private newAnimal(sp: number, x: number, z: number, rng: () => number): Animal {
    const spec = SPEC[sp];
    const j = 0.92 + rng() * 0.14;
    return {
      sp,
      x,
      z,
      yaw: rng() * TAU,
      spd: 0,
      ph: rng(),
      state: 0,
      t: rng() * 6,
      tx: x,
      tz: z,
      pose: 0,
      poseT: 0,
      look: 0,
      scale: (sp === ORYX ? 0.92 : 0.9) + rng() * 0.18,
      coat: [spec.coat[0] * j, spec.coat[1] * j, spec.coat[2] * j],
      seed: rng() * 0.999,
      cx: 0,
      cz: 0,
      r: 0,
      w: 0,
      alt: 0,
      flap: rng() * 6,
      burst: rng() * 6,
    };
  }

  /** What lives in a cell, if anything: decided by the cell alone, so it's the same every visit. */
  private makeHerd(small: boolean, cx: number, cz: number, key: number): Herd | null {
    const w = this.world;
    const s = w.seed | 0;
    const salt = small ? 31 : 17;
    const size = small ? SMALL_CELL : BIG_CELL;
    const roll = hash(cx, cz, s, salt);
    if (roll > (small ? 0.24 : 0.08)) return null;
    const x = (cx + 0.15 + 0.7 * hash(cx, cz, s, salt + 1)) * size;
    const z = (cz + 0.15 + 0.7 * hash(cx, cz, s, salt + 2)) * size;
    const sm = w.sample(x, z, this.sample);
    if (this.blocked?.(x, z)) return null;
    if (((this.world as Partial<{ river(x: number, z: number): number }>).river?.(x, z) ?? Infinity) < 25) return null;
    let sp: number;
    let count: number;
    const rng = mulberry32(Math.floor(hash(cx, cz, s, salt + 3) * 4294967296));
    if (small) {
      if (sm.rock > 0.35) sp = LIZARD;
      else if (sm.salt > 0.4) return null;
      else sp = roll < 0.07 ? FOX : roll < 0.14 ? HARE : roll < 0.19 ? LIZARD : -1;
      if (sp < 0) return null;
      count = sp === FOX ? (rng() < 0.3 ? 2 : 1) : sp === HARE ? 1 + Math.floor(rng() * 2) : 1 + Math.floor(rng() * 3);
    } else {
      if (sm.rock > 0.3) return null;
      sp = ORYX;
      count = 3 + Math.floor(rng() * 5);
    }
    const h: Herd = { key, sp, hx: x, hz: z, animals: [], pres: 0, alarm: 0, small };
    const spread = sp === ORYX ? 9 : sp === LIZARD ? 2.5 : 4;
    for (let i = 0; i < count; i++) {
      const a = rng() * TAU;
      const d = Math.sqrt(rng()) * spread;
      h.animals.push(this.newAnimal(sp, x + Math.cos(a) * d, z + Math.sin(a) * d, rng));
    }
    if (sp === ORYX) {
      // a herd faces mostly the same way
      const y0 = rng() * TAU;
      for (const an of h.animals) an.yaw = y0 + (rng() - 0.5) * 1.6;
    }
    return h;
  }

  /** Vultures over a site of bones or ruins. */
  private makeRoost(l: Landmark): Herd {
    const rng = mulberry32((Math.imul(l.key | 0, 0x2c1b3c6d) ^ (this.world.seed | 0) ^ 0x51f15e) >>> 0);
    const h: Herd = { key: -1 - l.key, sp: VULTURE, hx: l.x, hz: l.z, animals: [], pres: 0, alarm: 0, small: false };
    const n = 2 + Math.floor(rng() * 2);
    const ground = this.world.height(l.x, l.z);
    for (let i = 0; i < n; i++) {
      const a = this.newAnimal(VULTURE, l.x, l.z, rng);
      a.cx = l.x + (rng() - 0.5) * 30;
      a.cz = l.z + (rng() - 0.5) * 30;
      a.r = 22 + rng() * 26;
      a.w = (rng() < 0.5 ? -1 : 1) * (0.16 + rng() * 0.08);
      a.alt = ground + 35 + rng() * 40;
      a.yaw = rng() * TAU; // used as the angle round the circle
      a.scale = 1.0 + rng() * 0.2;
      h.animals.push(a);
    }
    return h;
  }

  private scan(px: number, pz: number): void {
    // drop what's gone out of range
    for (const [k, h] of this.herds) {
      const lim = h.sp === VULTURE ? 1900 : h.small ? SMALL_R + 60 : BIG_R + 150;
      if (Math.hypot(h.hx - px, h.hz - pz) > lim && h.pres <= 0) this.herds.delete(k);
    }
    for (const small of [false, true]) {
      const size = small ? SMALL_CELL : BIG_CELL;
      const R = small ? SMALL_R : BIG_R;
      const span = Math.ceil(R / size);
      const pcx = Math.floor(px / size);
      const pcz = Math.floor(pz / size);
      for (let dz = -span; dz <= span; dz++) {
        for (let dx = -span; dx <= span; dx++) {
          const cx = pcx + dx;
          const cz = pcz + dz;
          const ccx = (cx + 0.5) * size;
          const ccz = (cz + 0.5) * size;
          if (Math.hypot(ccx - px, ccz - pz) > R) continue;
          const key = ((cx + 32768) * 65536 + (cz + 32768)) * 2 + (small ? 1 : 0);
          if (this.herds.has(key) || this.empty.has(key)) continue;
          const h = this.makeHerd(small, cx, cz, key);
          if (h) this.herds.set(key, h);
          else this.empty.add(key);
        }
      }
    }
    if (this.empty.size > 20000) this.empty.clear();
    if (this.landmarks) {
      for (const l of this.landmarks(this.marks)) {
        if (l.kind !== 'bones' && l.kind !== 'ruins') continue;
        if (Math.hypot(l.x - px, l.z - pz) > 1600) continue;
        const key = -1 - l.key;
        if (!this.herds.has(key)) this.herds.set(key, this.makeRoost(l));
      }
    }
  }
  private readonly empty = new Set<number>();

  // ---------------------------------------------------------------- update

  update(f: FrameState): void {
    const dt = Math.min(f.dt, 0.1);
    const pl = f.player;
    const px = pl.pos.x;
    const pz = pl.pos.z;
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = SCAN_EVERY;
      this.scan(px, pz);
    }
    this.n = 0;
    let nearestFox = Infinity;
    for (const h of this.herds.values()) {
      // who is out at this hour
      const awake =
        h.sp === FOX ? f.night > 0.45
        : h.sp === HARE ? f.night < 0.75
        : h.sp === LIZARD ? f.night < 0.3
        : h.sp === VULTURE ? f.night < 0.5
        : true;
      const lim = h.sp === VULTURE ? 1700 : h.small ? SMALL_R : BIG_R;
      const want = awake && Math.hypot(h.hx - px, h.hz - pz) < lim;
      h.pres = Math.min(1, Math.max(0, h.pres + (want ? 1 : -1) * dt * 0.5));
      if (h.pres <= 0) continue;
      if (h.sp === VULTURE) {
        for (const a of h.animals) this.stepVulture(a, h, f, dt);
        continue;
      }
      this.stepHerd(h, f, dt, px, pz);
      if (h.sp === FOX) nearestFox = Math.min(nearestFox, Math.hypot(h.hx - px, h.hz - pz));
    }
    // a fox's bark carries a long way at night
    this.callT -= dt;
    if (this.callT <= 0) {
      this.callT = 25 + Math.random() * 35;
      if (nearestFox < 220 && this.onCall) this.onCall(FOX, nearestFox);
    }
    this.geo.instanceCount = this.n;
    this.iPos.attr.needsUpdate = this.iUp.attr.needsUpdate = this.iMot.attr.needsUpdate = this.iCoat.attr.needsUpdate = true;
  }

  private stepHerd(h: Herd, f: FrameState, dt: number, px: number, pz: number): void {
    const spec = SPEC[h.sp];
    const pl = f.player;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    // Something coming fast, or close: the whole herd runs. A lone fox or hare runs on its own.
    const fast = pl.speed > 4;
    let mx = 0;
    let mz = 0;
    for (const a of h.animals) {
      const d = Math.hypot(a.x - px, a.z - pz);
      if (d < spec.flee * (fast ? 1.6 : 1) && h.pres > 0.5) h.alarm = Math.max(h.alarm, 2.5 + Math.random());
      mx += a.x;
      mz += a.z;
    }
    mx /= h.animals.length;
    mz /= h.animals.length;
    if (h.alarm > 0) {
      const d = Math.hypot(mx - px, mz - pz);
      // keep running until well clear, then settle where they stopped
      if (d < spec.flee * 2.4) h.alarm = Math.max(h.alarm, 0.5);
      h.alarm -= dt;
      if (h.alarm <= 0) {
        h.hx = mx;
        h.hz = mz;
        for (const a of h.animals) {
          a.state = 0;
          a.t = 1 + Math.random() * 3;
        }
      }
    }
    const w = this.world;
    for (let i = 0; i < h.animals.length; i++) {
      const a = h.animals[i];
      const dx = a.x - px;
      const dz = a.z - pz;
      const d = Math.hypot(dx, dz);
      let targetYaw = a.yaw;
      let targetSpd = 0;
      let poseT = 0;
      if (h.alarm > 0) {
        a.state = 2;
        // away from the player, with a hare's jinks and a lizard's darts
        let away = Math.atan2(dx, dz) + (a.seed - 0.5) * 0.5;
        if (h.sp === HARE) away += Math.sin(f.time * 3.1 + a.seed * 20) * 0.7;
        if (h.sp === LIZARD) away += Math.sin(f.time * 7 + a.seed * 20) * 0.5;
        targetYaw = away;
        targetSpd = spec.run * (h.sp === ORYX ? 0.85 + a.seed * 0.15 : 1);
      } else {
        a.t -= dt;
        if (a.state === 1) {
          const ex = a.tx - a.x;
          const ez = a.tz - a.z;
          if (Math.hypot(ex, ez) < 0.8 || a.t < -20) {
            a.state = 0;
            a.t = 3 + Math.random() * 8;
          } else {
            targetYaw = Math.atan2(ex, ez);
            targetSpd = spec.walk;
          }
        } else if (a.t <= 0) {
          if (Math.random() < (h.sp === LIZARD ? 0.3 : 0.6)) {
            // wander off a little way from home
            const ang = Math.random() * TAU;
            const rr = Math.sqrt(Math.random()) * spec.roam;
            a.tx = h.hx + Math.cos(ang) * rr;
            a.tz = h.hz + Math.sin(ang) * rr;
            a.state = 1;
            a.t = 0;
          } else a.t = 3 + Math.random() * 8;
        }
        // standing: an oryx grazes, a fox noses the sand, unless the player is near enough to watch
        if (a.state === 0) {
          const grazing = h.sp === ORYX ? Math.sin(f.time * 0.21 + a.seed * 30) > -0.3 : h.sp === FOX ? Math.sin(f.time * 0.5 + a.seed * 30) > 0.4 : false;
          const wary = d < spec.flee * 1.8;
          poseT = grazing && !wary ? (h.sp === ORYX ? 1 : 0.6) : 0;
        }
      }
      // turn, and speed up or slow down
      const err = angDiff(targetYaw, a.yaw);
      const tr = spec.turn * (a.state === 2 ? 1.6 : 1) * dt;
      a.yaw += Math.max(-tr, Math.min(tr, err));
      const go = Math.abs(err) < 1.2 ? 1 : 0.3;
      a.spd += (targetSpd * go - a.spd) * k(a.state === 2 ? 3 : 1.5);
      if (a.spd < 0.01) a.spd = 0;
      a.pose += (poseT - a.pose) * k(1.5);
      // keep a little apart from the others in the herd
      for (let j = 0; j < h.animals.length; j++) {
        if (j === i) continue;
        const b = h.animals[j];
        const sx = a.x - b.x;
        const sz = a.z - b.z;
        const sd = Math.hypot(sx, sz);
        const want = h.sp === ORYX ? 2.2 : 0.6;
        if (sd > 1e-3 && sd < want) {
          a.x += (sx / sd) * (want - sd) * k(2);
          a.z += (sz / sd) * (want - sd) * k(2);
        }
      }
      a.x += Math.sin(a.yaw) * a.spd * dt;
      a.z += Math.cos(a.yaw) * a.spd * dt;
      const running = a.spd > spec.walk * 1.5;
      const stride = running ? spec.runStride : spec.stride;
      a.ph = (a.ph + (a.spd * dt) / stride) % 1;
      const gait = a.spd <= spec.walk ? a.spd / spec.walk : 1 + Math.min(1, (a.spd - spec.walk) / (spec.run - spec.walk));
      // the head follows the player, within reason
      let look = 0;
      if (d < (h.sp === ORYX ? 45 : 16) && a.state !== 2) {
        const c = Math.cos(a.yaw);
        const s = Math.sin(a.yaw);
        const ang = Math.atan2(-dx * c + dz * s, -dx * s - dz * c);
        look = Math.abs(ang) < 2.2 ? Math.max(-1, Math.min(1, ang)) : 0;
      }
      a.look += (look - a.look) * k(3);
      const y = w.height(a.x, a.z);
      w.normal(a.x, a.z, this.nrm);
      // stand mostly upright on a slope (a lizard lies flat to it)
      const tilt = h.sp === LIZARD ? 1 : 0.45;
      const ux = this.nrm.x * tilt;
      const uy = this.nrm.y * tilt + (1 - tilt);
      const uz = this.nrm.z * tilt;
      const fade = h.pres * h.pres * (3 - 2 * h.pres) * (1 - ss(h.small ? SMALL_R - 60 : BIG_R - 120, h.small ? SMALL_R : BIG_R, d));
      this.put(a, a.x, y, a.z, ux, uy, uz, a.look, gait, a.pose, a.scale * fade);
    }
  }

  private stepVulture(a: Animal, h: Herd, f: FrameState, dt: number): void {
    a.yaw += a.w * dt;
    const ca = Math.cos(a.yaw);
    const sa = Math.sin(a.yaw);
    const x = a.cx + ca * a.r;
    const z = a.cz + sa * a.r;
    const y = a.alt + Math.sin(a.yaw * 0.7 + a.seed * 9) * 3;
    const vx = -sa * a.w;
    const vz = ca * a.w;
    const heading = Math.atan2(vx, vz);
    // bank into the turn: tip the up vector toward the centre
    const inx = -ca;
    const inz = -sa;
    const bank = 0.35;
    // long glides with the odd burst of slow, heavy flaps
    a.burst += dt * 0.2;
    const burst = ss(0.6, 0.9, Math.sin(a.burst + a.seed * 10));
    a.flap += dt * (1.2 + 2.2 * burst);
    const cam = f.camera.position;
    const dist = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
    const sc = a.scale * Math.max(1, dist / 220) * h.pres;
    this.put(a, x, y, z, inx * bank, 1, inz * bank, 0, 0.06 + 0.5 * burst, 0, sc, heading, a.flap / TAU);
  }

  private put(a: Animal, x: number, y: number, z: number, ux: number, uy: number, uz: number, look: number, gait: number, pose: number, scale: number, yaw = a.yaw, ph = a.ph): void {
    if (scale < 0.01 || this.n >= CAP) return;
    const o = this.n * 4;
    this.iPos.arr[o] = x;
    this.iPos.arr[o + 1] = y;
    this.iPos.arr[o + 2] = z;
    this.iPos.arr[o + 3] = yaw;
    this.iUp.arr[o] = ux;
    this.iUp.arr[o + 1] = uy;
    this.iUp.arr[o + 2] = uz;
    this.iUp.arr[o + 3] = look;
    this.iMot.arr[o] = ph;
    this.iMot.arr[o + 1] = gait;
    this.iMot.arr[o + 2] = pose;
    this.iMot.arr[o + 3] = scale;
    this.iCoat.arr[o] = a.coat[0];
    this.iCoat.arr[o + 1] = a.coat[1];
    this.iCoat.arr[o + 2] = a.coat[2];
    this.iCoat.arr[o + 3] = a.sp + a.seed;
    this.n++;
  }
}

/** One placement on the review sheet. */
export interface SheetAnimal {
  sp: number;
  x: number;
  z: number;
  facing: number;
  /** 0 standing, 1 walking, 2 running. */
  gait: number;
  /** Head down (grazing). */
  pose?: number;
  scale?: number;
}

/** A still or animated row of animals for the dev review page (characters.html?animals). */
export function faunaSheet(uniforms: Uniforms, list: SheetAnimal[]): { group: THREE.Group; update(dt: number): void } {
  const geo = faunaGeometry();
  const P = new Inst(list.length);
  const U = new Inst(list.length);
  const M = new Inst(list.length);
  const C = new Inst(list.length);
  geo.setAttribute('iPos', P.attr);
  geo.setAttribute('iUp', U.attr);
  geo.setAttribute('iMot', M.attr);
  geo.setAttribute('iCoat', C.attr);
  geo.instanceCount = list.length;
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.add(mesh);
  const ph = list.map((_, i) => i * 0.37);
  const write = () => {
    list.forEach((a, i) => {
      const o = i * 4;
      const fly = a.sp === VULTURE;
      P.arr.set([a.x, fly ? 1.4 : 0, a.z, a.facing], o);
      U.arr.set([0, 1, 0, 0], o);
      M.arr.set([ph[i] % 1, fly ? 0.5 : a.gait, a.pose ?? 0, a.scale ?? 1], o);
      const c = SPEC[a.sp].coat;
      C.arr.set([c[0], c[1], c[2], a.sp + ((i * 0.137) % 0.9)], o);
    });
    P.attr.needsUpdate = U.attr.needsUpdate = M.attr.needsUpdate = C.attr.needsUpdate = true;
  };
  write();
  return {
    group,
    update(dt: number) {
      list.forEach((a, i) => {
        const spec = SPEC[a.sp];
        const spd = a.sp === VULTURE ? 0.5 : a.gait <= 1 ? a.gait * spec.walk : spec.run;
        const stride = a.sp === VULTURE ? 1 : a.gait > 1 ? spec.runStride : spec.stride;
        ph[i] += a.sp === VULTURE ? dt * 0.4 : (spd * dt) / stride;
      });
      write();
    },
  };
}
