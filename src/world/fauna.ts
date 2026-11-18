// The animals of the open desert: oryx herds that graze and bolt, wild goats on the rock and the snow, fennec foxes out after dark,
// hares that lope off when you come close, lizards on warm ground, and vultures circling over
// bones and ruins. All of them are one instanced draw call: legs, heads, ears, tails and wings
// move in the vertex shader, and only where they are and what they're doing is worked out here.
import * as THREE from 'three';
import type { FrameState, SaddleSway, SurfaceSample, Uniforms, World } from '../game/contract';
import { ASS_GALLOP, ORYX_GALLOP, RIDE } from '../game/speeds';
import { GB } from '../city/caravans';
import type { Landmark } from './discoveries';
import { STYLE_GLSL } from '../render/styleGlsl';
import { steer, steered, type SolidQuery } from './avoid';

// Every instance runs the whole mesh (all species) through the vertex shader, so the cap is what
// bounds the cost; the quality tier lowers the share of it in use (setDensity).
const CAP = 200;
const BIG_CELL = 320; // one herd at most per cell
const SMALL_CELL = 90; // one small animal (or a few, or a flock of birds) at most per cell
const BIG_R = 720; // herds are kept within this of the player
const SMALL_R = 240; // small animals within this: further out they're specks
const SCAN_EVERY = 0.5;
const AVOID_R = 300; // animals walk round a site's stones within this of the player; further out nobody can tell
const TAU = Math.PI * 2;
// Keys for herds that do not come from a cell: the ones by an oasis, and a shepherd's flock.
// Cell keys stay under 2^33 and the vultures' are negative, so these never meet them.
const WATER_KEY = -1e12;
const FLOCK_KEY = 1e12;
/** Goats left to graze round a hamlet or a mountain village: this plus the size of the place's own key. */
const GRAZE_KEY = 6e12;
/** Snow lies this deep (0..1) before the animals on it are the cold's own: pale foxes, hares and goats. */
const SNOW_LINE = 0.5;
const SNOW_COAT: V3 = [0.95, 0.96, 0.98];

export const ORYX = 0;
export const FOX = 1;
export const HARE = 2;
export const LIZARD = 3;
export const VULTURE = 4;
export const GAZELLE = 5;
/** A wild ass (an onager): grey, long eared, never far from water. */
export const ASS = 6;
/** A shepherd's goats (only ever with their shepherd, from the caravans). */
export const GOAT = 7;
export const TORTOISE = 8;
/** A sidewinder. */
export const SNAKE = 9;
/** Sandgrouse: a flock pecking over the sand that takes off all at once. */
export const GROUSE = 10;
const SPECIES = 11;
/** The ones a person can sit on: a wild ass and an oryx. */
const RIDEABLE: boolean[] = [true, false, false, false, false, false, true, false, false, false, false];
/** Flat out under a rider (m/s), by species: quicker than it ever runs on its own. */
const GALLOP: number[] = [];
GALLOP[ORYX] = ORYX_GALLOP;
GALLOP[ASS] = ASS_GALLOP;
/** Metres per gait cycle at speed `spd`. A ridden animal outruns its own run, and past that the stride lengthens so the legs go no faster. */
const strideAt = (spec: Spec, spd: number): number => (spd > spec.walk * 1.5 ? spec.runStride * Math.max(1, spd / spec.run) : spec.stride);
/** How near a calm person may come before a rideable animal moves off (m): inside the mounting reach. */
const CALM_FLEE = 1.2;
/** How far a rider may be from an animal and still climb on (m). */
export const MOUNT_REACH = 3.2;
/** The back's height over the ground at scale 1 (m). */
export const MOUNT_BACK = 1.3;
/** How far (m) the flute's call carries to a beast that can be ridden. */
export const CALL_R = 220;
/** A called beast stops this far (m) short of whoever called it. */
const CALL_STOP = 2.5;
/** How long (s) it waits by them once there, and how long it keeps trying to get there. */
const CALL_WAIT = 40;
const CALL_TRY = 45;
/** It gives up if the caller gets this far (m) off. */
const CALL_LOSE = 400;
/** Key base for a herd of one: a beast got off, or one called away from its herd. */
const SOLO_KEY = 1.5e12;
const GOAT_COATS: V3[] = [
  [0.16, 0.13, 0.12],
  [0.42, 0.28, 0.18],
  [0.8, 0.76, 0.68],
  [0.55, 0.42, 0.3],
  [0.24, 0.2, 0.18],
];

type V3 = [number, number, number];

interface Spec {
  walk: number; // m/s
  run: number;
  flee: number; // bolts when the player comes this close (m)
  stride: number; // metres per gait cycle at a walk
  runStride: number;
  turn: number; // rad/s
  roam: number; // wanders this far from home (m)
  body: number; // kept this far (m) from anything standing in the way
  gap: number; // keeps this far (m) from the others of its herd
  spread: number; // a herd starts out scattered this far (m) round its home
  coat: V3;
}

const SPEC: Spec[] = [
  { walk: 1.0, run: 9, flee: 30, stride: 1.5, runStride: 3.6, turn: 2.0, roam: 35, body: 0.6, gap: 2.2, spread: 9, coat: [0.86, 0.8, 0.7] },
  { walk: 1.1, run: 6.5, flee: 13, stride: 0.42, runStride: 1.1, turn: 4.0, roam: 30, body: 0.25, gap: 0.6, spread: 4, coat: [0.88, 0.74, 0.54] },
  { walk: 1.0, run: 8, flee: 10, stride: 0.5, runStride: 1.5, turn: 5.0, roam: 14, body: 0.2, gap: 0.6, spread: 4, coat: [0.6, 0.5, 0.38] },
  { walk: 0.4, run: 4, flee: 5, stride: 0.1, runStride: 0.22, turn: 8.0, roam: 3, body: 0.08, gap: 0.6, spread: 2.5, coat: [0.66, 0.55, 0.4] },
  { walk: 9, run: 9, flee: 0, stride: 1, runStride: 1, turn: 1, roam: 0, body: 0, gap: 0, spread: 0, coat: [0.3, 0.24, 0.2] },
  // gazelle: the most skittish thing out here, and the fastest away
  { walk: 1.1, run: 11, flee: 40, stride: 1.0, runStride: 3.0, turn: 2.6, roam: 30, body: 0.4, gap: 1.5, spread: 8, coat: [0.8, 0.6, 0.4] },
  { walk: 1.2, run: 10, flee: 28, stride: 1.5, runStride: 3.4, turn: 1.8, roam: 40, body: 0.6, gap: 2.4, spread: 9, coat: [0.66, 0.6, 0.53] },
  // goats are used to people: they only shy off a step or two
  { walk: 0.9, run: 3.2, flee: 4, stride: 0.75, runStride: 1.3, turn: 3.0, roam: 9, body: 0.35, gap: 1.0, spread: 5, coat: [0.4, 0.3, 0.22] },
  { walk: 0.1, run: 0.1, flee: 4, stride: 0.07, runStride: 0.07, turn: 0.8, roam: 6, body: 0.18, gap: 0.5, spread: 3, coat: [0.55, 0.46, 0.32] },
  { walk: 0.35, run: 1.5, flee: 4, stride: 0.25, runStride: 0.3, turn: 3.0, roam: 8, body: 0.1, gap: 0.5, spread: 2, coat: [0.82, 0.72, 0.55] },
  { walk: 0.5, run: 11, flee: 15, stride: 0.12, runStride: 0.12, turn: 6.0, roam: 10, body: 0.1, gap: 0.35, spread: 3, coat: [0.76, 0.62, 0.42] },
];

/** Herd animals: they bunch, face the same way, graze head down and watch the player a long way off. */
function herdSp(sp: number): boolean {
  return sp === ORYX || sp === GAZELLE || sp === ASS || sp === GOAT;
}

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

// The four legs of a hoofed animal: hips at (hx, hy, +-hz), knees at ky. Low sided, since every
// instance runs every species' vertices and the legs are thin enough not to need more.
function hooves(b: GB, sp: number, hx: number, hy: number, front: number, back: number, ky: number, r0: number, r1: number): void {
  for (const [fx, fz, ph] of [
    [hx, front, 0],
    [-hx, front, 0.5],
    [hx, back, 0.5],
    [-hx, back, 0],
  ] as V3[]) {
    const lean = fz < 0 ? -0.05 * hy : 0.02 * hy;
    b.set(1, 0, sp, ph, [fx, hy, fz]).tube(
      [
        { c: [fx, hy, fz], rx: r0, rz: r0 },
        { c: [fx, ky, fz + lean], rx: r1, rz: r1 },
      ],
      4,
      Math.PI / 4,
      false,
      false,
    );
    b.set(1, 2, sp, ph, [fx, hy, fz]).tube(
      [
        { c: [fx, ky, fz + lean], rx: r1, rz: r1 },
        { c: [fx, 0.04, fz], rx: r1 * 0.75, rz: r1 * 0.75 },
        { c: [fx, 0, fz + 0.02], rx: r1 * 0.85, rz: r1 * 0.85 },
      ],
      4,
      Math.PI / 4,
      false,
      true,
    );
  }
}

function gazelle(b: GB): void {
  b.set(0, 0, GAZELLE).tube(
    [
      { c: [0, 0.6, -0.42], rx: 0.1, rz: 0.11 },
      { c: [0, 0.63, -0.27], rx: 0.14, rz: 0.16 },
      { c: [0, 0.64, 0.05], rx: 0.13, rz: 0.16 },
      { c: [0, 0.67, 0.29], rx: 0.12, rz: 0.15 },
      { c: [0, 0.72, 0.4], rx: 0.08, rz: 0.1 },
    ],
    6,
    0,
    true,
    true,
  );
  // the dark band along the flank, and the white belly under it
  b.set(0, 1, GAZELLE).tube(
    [
      { c: [0, 0.58, -0.26], rx: 0.145, rz: 0.035 },
      { c: [0, 0.59, 0.27], rx: 0.125, rz: 0.035 },
    ],
    6,
    0,
    false,
    false,
  );
  b.set(0, 2, GAZELLE).tube(
    [
      { c: [0, 0.52, -0.25], rx: 0.11, rz: 0.05 },
      { c: [0, 0.53, 0.26], rx: 0.1, rz: 0.05 },
    ],
    6,
    0,
    true,
    true,
  );
  hooves(b, GAZELLE, 0.075, 0.6, 0.3, -0.31, 0.32, 0.045, 0.024);
  const NP: V3 = [0, 0.72, 0.38];
  b.set(2, 0, GAZELLE, 0, NP, 1).tube(
    [
      { c: [0, 0.7, 0.36], rx: 0.065, rz: 0.085 },
      { c: [0, 0.92, 0.5], rx: 0.045, rz: 0.05 },
      { c: [0, 0.98, 0.54], rx: 0.045, rz: 0.045 },
    ],
    5,
    0,
    false,
    false,
  );
  b.set(2, 2, GAZELLE, 0, NP, 1).tube(
    [
      { c: [0, 1.0, 0.51], rx: 0.045, rz: 0.05 },
      { c: [0, 0.98, 0.6], rx: 0.04, rz: 0.045 },
      { c: [0, 0.92, 0.7], rx: 0.022, rz: 0.024 },
    ],
    5,
    0,
    true,
    true,
  );
  b.set(2, 4, GAZELLE, 0, NP, 1);
  b.box(0.04, 1.0, 0.59, 0.022, 0.022, 0.022);
  b.box(-0.04, 1.0, 0.59, 0.022, 0.022, 0.022);
  b.box(0, 0.93, 0.71, 0.03, 0.02, 0.02);
  for (const s of [-1, 1]) {
    // lyre horns: up, out, and the tips turned in
    b.set(2, 3, GAZELLE, 0, NP, 1).tube(
      [
        { c: [s * 0.022, 1.04, 0.53], rx: 0.014, rz: 0.014 },
        { c: [s * 0.05, 1.17, 0.46], rx: 0.011, rz: 0.011 },
        { c: [s * 0.045, 1.27, 0.45], rx: 0.008, rz: 0.008 },
        { c: [s * 0.03, 1.33, 0.5], rx: 0.003, rz: 0.003 },
      ],
      4,
      0,
      false,
      false,
    );
    b.set(4, 5, GAZELLE, 0, NP, 1, s).tube(
      [
        { c: [s * 0.035, 1.04, 0.5], rx: 0.024, rz: 0.01 },
        { c: [s * 0.1, 1.09, 0.46], rx: 0.02, rz: 0.008 },
        { c: [s * 0.13, 1.11, 0.44], rx: 0.004, rz: 0.004 },
      ],
      4,
      0,
      false,
      true,
    );
  }
  b.set(3, 1, GAZELLE, 0, [0, 0.64, -0.43]).tube(
    [
      { c: [0, 0.64, -0.44], rx: 0.02, rz: 0.02, z: 0 },
      { c: [0, 0.52, -0.49], rx: 0.016, rz: 0.024, z: 1 },
    ],
    4,
    0,
    false,
    true,
  );
}

function ass(b: GB): void {
  b.set(0, 0, ASS).tube(
    [
      { c: [0, 0.98, -0.68], rx: 0.2, rz: 0.24 },
      { c: [0, 1.02, -0.44], rx: 0.27, rz: 0.31 },
      { c: [0, 1.0, 0.05], rx: 0.26, rz: 0.31 },
      { c: [0, 1.04, 0.44], rx: 0.24, rz: 0.29 },
      { c: [0, 1.12, 0.62], rx: 0.16, rz: 0.2 },
    ],
    7,
    0,
    true,
    true,
  );
  // pale belly, and the dark stripe down the spine
  b.set(0, 2, ASS).tube(
    [
      { c: [0, 0.8, -0.42], rx: 0.21, rz: 0.08 },
      { c: [0, 0.8, 0.4], rx: 0.2, rz: 0.08 },
    ],
    6,
    0,
    true,
    true,
  );
  b.set(0, 1, ASS).box(0, 1.32, -0.05, 0.05, 0.03, 1.1);
  hooves(b, ASS, 0.13, 0.94, 0.44, -0.47, 0.5, 0.075, 0.042);
  const NP: V3 = [0, 1.12, 0.58];
  b.set(2, 0, ASS, 0, NP, 1).tube(
    [
      { c: [0, 1.06, 0.55], rx: 0.13, rz: 0.17 },
      { c: [0, 1.36, 0.8], rx: 0.09, rz: 0.12 },
      { c: [0, 1.46, 0.88], rx: 0.085, rz: 0.1 },
    ],
    6,
    0,
    false,
    false,
  );
  b.set(2, 0, ASS, 0, NP, 1).tube(
    [
      { c: [0, 1.48, 0.85], rx: 0.085, rz: 0.1 },
      { c: [0, 1.38, 1.06], rx: 0.075, rz: 0.09 },
    ],
    6,
    0,
    false,
    false,
  );
  b.set(2, 2, ASS, 0, NP, 1).tube(
    [
      { c: [0, 1.38, 1.06], rx: 0.075, rz: 0.09 },
      { c: [0, 1.28, 1.18], rx: 0.065, rz: 0.07 },
    ],
    6,
    0,
    false,
    true,
  );
  // the short mane standing up along the neck
  b.set(2, 1, ASS, 0, NP, 1).tube(
    [
      { c: [0, 1.3, 0.56], rx: 0.02, rz: 0.05 },
      { c: [0, 1.56, 0.8], rx: 0.02, rz: 0.05 },
      { c: [0, 1.62, 0.87], rx: 0.01, rz: 0.02 },
    ],
    4,
    0,
    true,
    true,
  );
  b.set(2, 4, ASS, 0, NP, 1);
  b.box(0.08, 1.46, 0.98, 0.028, 0.028, 0.028);
  b.box(-0.08, 1.46, 0.98, 0.028, 0.028, 0.028);
  b.box(0, 1.26, 1.2, 0.09, 0.03, 0.05);
  for (const s of [-1, 1]) {
    // long ears, the first thing you see of one over a dune
    b.set(4, 0, ASS, 0, NP, 1, s).tube(
      [
        { c: [s * 0.05, 1.54, 0.88], rx: 0.04, rz: 0.016 },
        { c: [s * 0.11, 1.73, 0.83], rx: 0.036, rz: 0.014 },
        { c: [s * 0.13, 1.83, 0.8], rx: 0.006, rz: 0.006 },
      ],
      4,
      0,
      false,
      true,
    );
  }
  const TP: V3 = [0, 1.04, -0.72];
  b.set(3, 0, ASS, 0, TP).tube(
    [
      { c: [0, 1.04, -0.73], rx: 0.03, rz: 0.03, z: 0 },
      { c: [0, 0.74, -0.82], rx: 0.022, rz: 0.022, z: 0.8 },
    ],
    4,
    0,
    false,
    false,
  );
  b.set(3, 1, ASS, 0, TP).tube(
    [
      { c: [0, 0.74, -0.82], rx: 0.04, rz: 0.04, z: 0.8 },
      { c: [0, 0.56, -0.85], rx: 0.015, rz: 0.015, z: 1 },
    ],
    4,
    0,
    false,
    true,
  );
}

function goat(b: GB): void {
  b.set(0, 0, GOAT).tube(
    [
      { c: [0, 0.55, -0.35], rx: 0.11, rz: 0.12 },
      { c: [0, 0.58, -0.21], rx: 0.15, rz: 0.18 },
      { c: [0, 0.58, 0.08], rx: 0.15, rz: 0.18 },
      { c: [0, 0.6, 0.25], rx: 0.13, rz: 0.16 },
      { c: [0, 0.64, 0.35], rx: 0.09, rz: 0.11 },
    ],
    6,
    0,
    true,
    true,
  );
  hooves(b, GOAT, 0.075, 0.54, 0.25, -0.26, 0.28, 0.045, 0.026);
  const NP: V3 = [0, 0.64, 0.33];
  b.set(2, 0, GOAT, 0, NP, 1).tube(
    [
      { c: [0, 0.6, 0.31], rx: 0.075, rz: 0.095 },
      { c: [0, 0.8, 0.43], rx: 0.055, rz: 0.065 },
      { c: [0, 0.85, 0.45], rx: 0.055, rz: 0.06 },
    ],
    5,
    0,
    false,
    false,
  );
  b.set(2, 0, GOAT, 0, NP, 1).tube(
    [
      { c: [0, 0.85, 0.44], rx: 0.055, rz: 0.06 },
      { c: [0, 0.8, 0.55], rx: 0.045, rz: 0.05 },
      { c: [0, 0.73, 0.63], rx: 0.03, rz: 0.03 },
    ],
    5,
    0,
    false,
    true,
  );
  b.set(2, 1, GOAT, 0, NP, 1).tube(
    [
      { c: [0, 0.72, 0.58], rx: 0.018, rz: 0.018 },
      { c: [0, 0.62, 0.57], rx: 0.006, rz: 0.006 },
    ],
    4,
    0,
    false,
    true,
  );
  b.set(2, 4, GOAT, 0, NP, 1);
  b.box(0.045, 0.85, 0.52, 0.02, 0.02, 0.02);
  b.box(-0.045, 0.85, 0.52, 0.02, 0.02, 0.02);
  for (const s of [-1, 1]) {
    // horns swept back over the neck
    b.set(2, 3, GOAT, 0, NP, 1).tube(
      [
        { c: [s * 0.028, 0.88, 0.46], rx: 0.016, rz: 0.016 },
        { c: [s * 0.05, 0.97, 0.4], rx: 0.012, rz: 0.012 },
        { c: [s * 0.07, 0.99, 0.31], rx: 0.008, rz: 0.008 },
        { c: [s * 0.08, 0.94, 0.25], rx: 0.003, rz: 0.003 },
      ],
      4,
      0,
      false,
      false,
    );
    // ears that hang out to the side
    b.set(4, 5, GOAT, 0, NP, 1, s).tube(
      [
        { c: [s * 0.05, 0.85, 0.46], rx: 0.016, rz: 0.03 },
        { c: [s * 0.13, 0.8, 0.46], rx: 0.012, rz: 0.028 },
        { c: [s * 0.16, 0.77, 0.46], rx: 0.004, rz: 0.006 },
      ],
      4,
      0,
      false,
      true,
    );
  }
  b.set(3, 0, GOAT, 0, [0, 0.64, -0.36]).tube(
    [
      { c: [0, 0.63, -0.37], rx: 0.025, rz: 0.02, z: 0 },
      { c: [0, 0.72, -0.43], rx: 0.006, rz: 0.006, z: 1 },
    ],
    4,
    0,
    false,
    true,
  );
}

function tortoise(b: GB): void {
  // the high domed shell, its rim and a few darker plates on top
  b.set(0, 0, TORTOISE).tube(
    [
      { c: [0, 0.055, -0.19], rx: 0.05, rz: 0.03 },
      { c: [0, 0.075, -0.14], rx: 0.13, rz: 0.075 },
      { c: [0, 0.085, 0.0], rx: 0.155, rz: 0.095 },
      { c: [0, 0.075, 0.14], rx: 0.13, rz: 0.075 },
      { c: [0, 0.055, 0.19], rx: 0.05, rz: 0.03 },
    ],
    7,
    0,
    true,
    true,
  );
  b.set(0, 1, TORTOISE).tube(
    [
      { c: [0, 0.045, -0.17], rx: 0.1, rz: 0.02 },
      { c: [0, 0.045, 0.0], rx: 0.165, rz: 0.022 },
      { c: [0, 0.045, 0.17], rx: 0.1, rz: 0.02 },
    ],
    7,
    0,
    false,
    false,
  );
  b.box(0, 0.18, 0, 0.07, 0.012, 0.08);
  b.box(0.06, 0.155, 0.08, 0.05, 0.012, 0.05, 0.4);
  b.box(-0.06, 0.155, 0.08, 0.05, 0.012, 0.05, -0.4);
  b.box(0.065, 0.155, -0.08, 0.05, 0.012, 0.05, -0.4);
  b.box(-0.065, 0.155, -0.08, 0.05, 0.012, 0.05, 0.4);
  for (const [s, fz, ph] of [
    [1, 0.1, 0],
    [-1, 0.1, 0.5],
    [1, -0.1, 0.5],
    [-1, -0.1, 0],
  ] as V3[]) {
    b.set(1, 2, TORTOISE, ph, [s * 0.11, 0.06, fz]).tube(
      [
        { c: [s * 0.11, 0.06, fz], rx: 0.032, rz: 0.032 },
        { c: [s * 0.13, 0.0, fz + 0.01], rx: 0.03, rz: 0.03 },
      ],
      4,
      Math.PI / 4,
      false,
      true,
    );
  }
  const NP: V3 = [0, 0.06, 0.17];
  b.set(2, 2, TORTOISE, 0, NP, 1).tube(
    [
      { c: [0, 0.055, 0.15], rx: 0.03, rz: 0.028 },
      { c: [0, 0.08, 0.25], rx: 0.028, rz: 0.026 },
      { c: [0, 0.075, 0.29], rx: 0.012, rz: 0.012 },
    ],
    5,
    0,
    false,
    true,
  );
  b.set(2, 4, TORTOISE, 0, NP, 1);
  b.box(0.022, 0.088, 0.26, 0.01, 0.01, 0.01);
  b.box(-0.022, 0.088, 0.26, 0.01, 0.01, 0.01);
}

function snake(b: GB): void {
  // a sidewinder: one long tube the shader bends into a moving S
  const rings: { c: V3; rx: number; rz: number }[] = [];
  for (let i = 0; i <= 9; i++) {
    const z = -0.32 + i * 0.065;
    const t = i / 9;
    const r = 0.006 + 0.016 * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.5) * (t > 0.88 ? 0.75 : 1);
    rings.push({ c: [0, 0.016, z], rx: r * 1.15, rz: r * 0.8 });
  }
  rings.push({ c: [0, 0.016, 0.31], rx: 0.004, rz: 0.004 });
  b.set(0, 0, SNAKE).tube(rings, 5, 0, true, true);
  b.set(0, 1, SNAKE);
  for (let i = 0; i < 6; i++) b.box(0, 0.028, -0.24 + i * 0.085, 0.016, 0.006, 0.03);
  b.set(0, 4, SNAKE);
  b.box(0.014, 0.024, 0.255, 0.006, 0.006, 0.006);
  b.box(-0.014, 0.024, 0.255, 0.006, 0.006, 0.006);
}

function grouse(b: GB): void {
  // a sandgrouse: plump, short legged, pointed tail; the wings fold along its sides
  b.set(0, 0, GROUSE).tube(
    [
      { c: [0, 0.1, -0.13], rx: 0.03, rz: 0.025 },
      { c: [0, 0.115, -0.06], rx: 0.062, rz: 0.058 },
      { c: [0, 0.125, 0.03], rx: 0.066, rz: 0.062 },
      { c: [0, 0.145, 0.08], rx: 0.045, rz: 0.045 },
    ],
    6,
    0,
    true,
    false,
  );
  b.set(0, 2, GROUSE).tube(
    [
      { c: [0, 0.125, 0.045], rx: 0.064, rz: 0.06 },
      { c: [0, 0.135, 0.07], rx: 0.052, rz: 0.05 },
    ],
    6,
    0,
    false,
    false,
  );
  b.set(0, 1, GROUSE);
  b.tri([-0.02, 0.11, -0.12], [0.02, 0.11, -0.12], [0, 0.115, -0.24], null);
  for (const [s, ph] of [
    [1, 0],
    [-1, 0.5],
  ] as Array<[number, number]>) {
    b.set(1, 2, GROUSE, ph, [s * 0.025, 0.08, 0]).tube(
      [
        { c: [s * 0.025, 0.08, 0], rx: 0.009, rz: 0.009 },
        { c: [s * 0.025, 0, 0.01], rx: 0.007, rz: 0.007 },
      ],
      3,
      0,
      false,
      true,
    );
  }
  const NP: V3 = [0, 0.145, 0.08];
  b.set(2, 0, GROUSE, 0, NP, 1).tube(
    [
      { c: [0, 0.15, 0.08], rx: 0.032, rz: 0.034 },
      { c: [0, 0.19, 0.105], rx: 0.033, rz: 0.033 },
      { c: [0, 0.19, 0.135], rx: 0.018, rz: 0.018 },
      { c: [0, 0.185, 0.155], rx: 0.003, rz: 0.003 },
    ],
    5,
    0,
    false,
    true,
  );
  b.set(2, 4, GROUSE, 0, NP, 1);
  b.box(0.026, 0.198, 0.115, 0.009, 0.009, 0.009);
  b.box(-0.026, 0.198, 0.115, 0.009, 0.009, 0.009);
  for (const s of [-1, 1]) {
    const P = (x: number, z: number): V3 => [s * x, 0.14, z];
    b.set(5, 0, GROUSE, 0, [s * 0.05, 0.14, 0.03], s);
    b.tri(P(0.05, 0.06), P(0.22, 0.03), P(0.22, -0.06), null);
    b.tri(P(0.05, 0.06), P(0.22, -0.06), P(0.05, -0.08), null);
    b.set(5, 1, GROUSE, 0, [s * 0.05, 0.14, 0.03], s);
    b.tri(P(0.22, 0.03), P(0.32, -0.04), P(0.22, -0.06), null);
  }
}

function faunaGeometry(): THREE.InstancedBufferGeometry {
  const b = new GB();
  oryx(b);
  fox(b);
  hare(b);
  lizard(b);
  vulture(b);
  gazelle(b);
  ass(b);
  goat(b);
  tortoise(b);
  snake(b);
  grouse(b);
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
  int S = int(sp + 0.5);
  float kind = aRig.y;
  float ph = iMot.x;
  float g = iMot.y;
  // a sandgrouse's gait runs past 2 into flight: legs still, wings out and beating
  float fly = 0.0;
  if (S == 10) {
    fly = clamp(g - 2.0, 0.0, 1.0);
    if (g > 2.0) g = 0.0;
  }
  float walk = min(g, 1.0);
  float run = clamp(g - 1.0, 0.0, 1.0);
  float pose = iMot.z;
  float T = uTime;
  vec3 p = position;
  vec3 n = normal;
  float th = TAU * (ph + aRig.x);
  if (kind > 0.5 && kind < 1.5) {
    float amp = mix(0.45, 0.85, run);
    if (S == 2 || S == 3) amp = 0.9;
    else if (S == 10) amp = 0.75;
    else if (S == 8) amp = 0.5;
    float a = amp * walk * sin(th);
    p = aPivot + rotX(p - aPivot, a);
    n = rotX(n, a);
  } else if (kind > 1.5 && kind < 2.5 || kind > 3.5 && kind < 4.5) {
    float w = aRig.z;
    float pitch = (pose * 1.35 + 0.07 * walk * sin(2.0 * TAU * ph) + 0.04 * sin(T * 0.8 + seed * 30.0)) * w;
    float turn = iUp.w * w;
    vec3 q = p - aPivot;
    if (S == 8) {
      // a tortoise does not bow its head: it draws it back into the shell
      q.z -= 0.11 * pose;
      pitch = 0.05 * sin(T * 0.7 + seed * 30.0);
      turn *= 1.0 - pose;
    }
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
    if (S == 10) {
      // folded back along the flanks on the ground; spread and beating in the air
      float flap = aRig.z * (fly * (0.95 * sin(TAU * ph) + 0.15) - 0.35 * (1.0 - fly));
      float fold = aRig.z * 1.4 * (1.0 - fly);
      vec3 q = rotY(rotZ(p - aPivot, flap), fold);
      n = rotY(rotZ(n, flap), fold);
      p = aPivot + q;
    } else {
      float a = aRig.z * (g * sin(TAU * ph) + 0.08);
      p = aPivot + rotZ(p - aPivot, a);
      n = rotZ(n, a);
    }
  }
  if (S == 3) {
    // a lizard runs in a sideways S
    p.x += sin(p.z * 26.0 - TAU * ph) * (0.004 + 0.012 * walk) * smoothstep(0.14, -0.1, p.z);
  } else if (S == 9) {
    // a sidewinder lies in an S, and the S runs down its length as it goes; the loops lift clear
    float wv = p.z * 15.0 - TAU * ph;
    float amp = (0.035 + 0.02 * walk) * mix(1.0, 0.35, smoothstep(0.15, 0.3, p.z));
    p.x += sin(wv) * amp;
    p.y += 0.012 * walk * max(0.0, cos(wv));
  }
  if (S == 2) {
    // a hare lopes: the whole body arcs up between landings
    p.y += 0.1 * walk * (0.4 + run) * max(0.0, sin(TAU * ph));
  } else if ((S <= 1 || (S >= 5 && S <= 7) || S == 10) && !(kind > 0.5 && kind < 1.5)) {
    p.y += (0.015 + 0.05 * run) * walk * sin(2.0 * TAU * ph) * (S == 1 ? 0.3 : S == 10 ? 0.15 : 1.0);
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
  /** Ground under it last frame. */
  y: number;
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
  /** The side it passes things on (+1, -1; 0 not yet chosen), and a heading round one held for avT s. */
  dodge: number;
  avT: number;
  avYaw: number;
  /** A sandgrouse's height off the ground (m): above zero it is flying. */
  fly: number;
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
  /** A shepherd's flock: home is wherever the shepherd is. */
  follow: Herder | null;
  /** Seconds left in which nothing about the player spooks it (a mount just let go of). */
  grace: number;
}

/** Where a shepherd is, as the caravans keep it, for the flock to follow. */
export interface Herder {
  key: number;
  x: number;
  z: number;
  /** In sight and out with the flock. */
  on: boolean;
  /** Sitting out the night: the flock settles round them. */
  rest: boolean;
  /** For the flock's own look (how many, what colours). */
  seed: number;
}

export class Fauna {
  readonly group = new THREE.Group();
  /** The places built now (for vultures to circle over bones and ruins). Set by the game. */
  landmarks: ((out: Landmark[]) => Landmark[]) | null = null;
  /** Whether (x, z) is no place for animals to live: in a city, or among a site's stones. Set by the game. */
  blocked: ((x: number, z: number) => boolean) | null = null;
  /** What stands in an animal's way: the top over (x, z) for feet at y, or -Infinity (as the wanderer's roof). Set by the game. */
  solid: SolidQuery | null = null;
  /** An animal has called out, this far from the player (m). */
  onCall: ((sp: number, dist: number) => void) | null = null;
  /** How much snow lies at (x, z), 0..1: in it the small animals are pale foxes and hares, and goats keep to it. Set by the game. */
  snow: ((x: number, z: number) => number) | null = null;
  /** The shepherds out in the open now, each with a flock of goats to keep near. Set by the game. */
  herders: ((out: Herder[]) => Herder[]) | null = null;

  /** 0..1 from the quality tier: how many cells have animals in them, and how many to a herd. */
  private density = 1;
  private cap = CAP;
  private readonly herderList: Herder[] = [];

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
    const c: number[] = new Array<number>(SPECIES).fill(0);
    for (const h of this.herds.values()) if (h.pres > 0.5) c[h.sp] += h.animals.length;
    return c;
  }

  /**
   * Fewer animals on a lesser tier (d in 0..1, as people.setDensity): fewer cells with anything in
   * them, smaller herds, and a lower cap on how many are drawn. Herds already out stay until they
   * are left behind; cells passed over as empty are looked at again.
   */
  setDensity(d: number): void {
    const v = Math.min(1, Math.max(0.1, d));
    if (v === this.density) return;
    this.density = v;
    this.cap = Math.round(CAP * (0.45 + 0.55 * v));
    this.empty.clear();
  }

  /** The share of cells that get animals, and of each herd's head count, at this density. */
  private get thin(): number {
    return 0.4 + 0.6 * this.density;
  }

  // ---------------------------------------------------------------- spawning

  private newAnimal(sp: number, x: number, z: number, rng: () => number): Animal {
    const spec = SPEC[sp];
    const j = 0.92 + rng() * 0.14;
    const coat = sp === GOAT ? GOAT_COATS[Math.floor(rng() * GOAT_COATS.length)] : spec.coat;
    return {
      sp,
      x,
      z,
      y: this.world.height(x, z),
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
      coat: [coat[0] * j, coat[1] * j, coat[2] * j],
      seed: rng() * 0.999,
      cx: 0,
      cz: 0,
      r: 0,
      w: 0,
      alt: 0,
      flap: rng() * 6,
      burst: rng() * 6,
      dodge: 0,
      avT: 0,
      avYaw: 0,
      fly: 0,
    };
  }

  /** count animals of sp scattered round (x, z), thinned by the quality tier (never below one). */
  private fill(h: Herd, count: number, rng: () => number): Herd {
    const sp = h.sp;
    const n = Math.max(1, Math.round(count * this.thin));
    const spread = SPEC[sp].spread;
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU;
      const d = Math.sqrt(rng()) * spread;
      h.animals.push(this.newAnimal(sp, h.hx + Math.cos(a) * d, h.hz + Math.sin(a) * d, rng));
    }
    if (herdSp(sp) || sp === GROUSE) {
      // a herd faces mostly the same way
      const y0 = rng() * TAU;
      for (const an of h.animals) an.yaw = y0 + (rng() - 0.5) * 1.6;
    }
    return h;
  }

  /** What lives in a cell, if anything: decided by the cell alone, so it's the same every visit. */
  private makeHerd(small: boolean, cx: number, cz: number, key: number): Herd | null {
    const w = this.world;
    const s = w.seed | 0;
    const salt = small ? 31 : 17;
    const size = small ? SMALL_CELL : BIG_CELL;
    const roll = hash(cx, cz, s, salt);
    // Herds gather toward water: a cell within reach of a river is more often taken, and mostly by
    // wild asses. The roll is thinned by the tier and then read as a share (r) to pick the species,
    // so a lesser tier drops cells evenly across them.
    const x = (cx + 0.15 + 0.7 * hash(cx, cz, s, salt + 1)) * size;
    const z = (cz + 0.15 + 0.7 * hash(cx, cz, s, salt + 2)) * size;
    const riv = small ? Infinity : ((this.world as Partial<{ river(x: number, z: number): number }>).river?.(x, z) ?? Infinity);
    const wet = riv < 260;
    const p = (small ? 0.4 : wet ? 0.26 : 0.15) * this.thin;
    if (roll > p) return null;
    const r = roll / p;
    const sm = w.sample(x, z, this.sample);
    if (this.blocked?.(x, z)) return null;
    if (!small && riv < 25) return null;
    if (small && ((this.world as Partial<{ river(x: number, z: number): number }>).river?.(x, z) ?? Infinity) < 25) return null;
    let sp: number;
    let count: number;
    const rng = mulberry32(Math.floor(hash(cx, cz, s, salt + 3) * 4294967296));
    const cold = (this.snow?.(x, z) ?? 0) > SNOW_LINE;
    if (small) {
      // nothing cold-blooded lives in the snow: a fox or a hare, in its winter coat
      if (cold) sp = r < 0.45 ? FOX : r < 0.9 ? HARE : -1;
      else if (sm.rock > 0.35) sp = LIZARD;
      else if (sm.salt > 0.4) return null;
      else sp = r < 0.18 ? FOX : r < 0.36 ? HARE : r < 0.5 ? LIZARD : r < 0.68 ? GROUSE : r < 0.8 ? TORTOISE : r < 0.92 ? SNAKE : -1;
      if (sp < 0) return null;
      count =
        sp === FOX ? (rng() < 0.3 ? 2 : 1)
        : sp === GROUSE ? 5 + Math.floor(rng() * 7)
        : sp === TORTOISE || sp === SNAKE ? 1
        : 1 + Math.floor(rng() * 3);
    } else {
      // bare rock and snow are the wild goats' ground, and nobody else's
      if (sm.rock > 0.3 || cold) {
        if (r > 0.6) return null;
        sp = GOAT;
      } else sp = wet ? (r < 0.65 ? ASS : r < 0.85 ? GAZELLE : ORYX) : r < 0.55 ? ORYX : r < 0.85 ? GAZELLE : ASS;
      count = sp === ORYX ? 4 + Math.floor(rng() * 6) : sp === GAZELLE ? 5 + Math.floor(rng() * 7) : 3 + Math.floor(rng() * 4);
    }
    const h: Herd = { key, sp, hx: x, hz: z, animals: [], pres: 0, alarm: 0, small, follow: null, grace: 0 };
    this.fill(h, count, rng);
    if (cold) {
      for (const a of h.animals) {
        const k = 0.92 + 0.08 * a.seed;
        a.coat = [SNOW_COAT[0] * k, SNOW_COAT[1] * k, SNOW_COAT[2] * k];
      }
    }
    return h;
  }

  /** What comes down to an oasis to drink: a herd grazing a little way off, sometimes sandgrouse too. */
  private makeWater(l: Landmark, k: number): Herd | null {
    const rng = mulberry32((Math.imul(l.key | 0, 0x2c1b3c6d) ^ Math.imul(k + 1, 0x27d4eb2d) ^ (this.world.seed | 0) ^ 0x0a515) >>> 0);
    if (rng() > (k === 0 ? 0.85 : 0.55) * this.thin) return null;
    const sp = k === 0 ? (rng() < 0.55 ? GAZELLE : ASS) : GROUSE;
    // out past the palms and stones round the pool, which are no place to graze
    for (let t = 0; t < 6; t++) {
      const a = rng() * TAU;
      const d = (sp === GROUSE ? 42 : 60) + rng() * 30;
      const x = l.x + Math.cos(a) * d;
      const z = l.z + Math.sin(a) * d;
      if (this.blocked?.(x, z)) continue;
      const sm = this.world.sample(x, z, this.sample);
      if (sm.rock > 0.3 || sm.salt > 0.4) continue;
      const h: Herd = { key: WATER_KEY - l.key * 4 - k, sp, hx: x, hz: z, animals: [], pres: 0, alarm: 0, small: sp === GROUSE, follow: null, grace: 0 };
      return this.fill(h, sp === GAZELLE ? 5 + Math.floor(rng() * 6) : sp === ASS ? 3 + Math.floor(rng() * 4) : 6 + Math.floor(rng() * 8), rng);
    }
    return null;
  }

  /** The goats of a hamlet or a mountain village, grazing just outside it with nobody minding them. */
  private makeGraze(l: Landmark): Herd | null {
    const rng = mulberry32((Math.imul(Math.abs(l.key) | 0, 0x2c1b3c6d) ^ (this.world.seed | 0) ^ 0x60a75) >>> 0);
    const village = l.kind === 'mountain-village';
    if (rng() > (village ? 1 : 0.8) * this.thin) return null;
    // out past the houses, pens and plots, which the goats would only stand stuck among
    for (let t = 0; t < 8; t++) {
      const a = rng() * TAU;
      const d = (village ? 84 : 54) + rng() * 30;
      const x = l.x + Math.cos(a) * d;
      const z = l.z + Math.sin(a) * d;
      if (this.blocked?.(x, z)) continue;
      if (this.world.sample(x, z, this.sample).salt > 0.4) continue;
      const h: Herd = { key: GRAZE_KEY + Math.abs(l.key), sp: GOAT, hx: x, hz: z, animals: [], pres: 0, alarm: 0, small: false, follow: null, grace: 0 };
      return this.fill(h, (village ? 5 : 3) + Math.floor(rng() * 5), rng);
    }
    return null;
  }

  /** A shepherd's goats, close round them. */
  private makeFlock(f: Herder): Herd {
    const rng = mulberry32(Math.floor(f.seed * 4294967296) ^ 0x6f47);
    const h: Herd = { key: FLOCK_KEY + f.key, sp: GOAT, hx: f.x, hz: f.z, animals: [], pres: 0, alarm: 0, small: false, follow: f, grace: 0 };
    return this.fill(h, 5 + Math.floor(rng() * 6), rng);
  }

  /** Vultures over a site of bones or ruins. */
  private makeRoost(l: Landmark): Herd {
    const rng = mulberry32((Math.imul(l.key | 0, 0x2c1b3c6d) ^ (this.world.seed | 0) ^ 0x51f15e) >>> 0);
    const h: Herd = { key: -1 - l.key, sp: VULTURE, hx: l.x, hz: l.z, animals: [], pres: 0, alarm: 0, small: false, follow: null, grace: 0 };
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
        const ld = Math.hypot(l.x - px, l.z - pz);
        if (l.kind === 'oasis' && ld < BIG_R) {
          for (let k = 0; k < 2; k++) {
            const key = WATER_KEY - l.key * 4 - k;
            if (this.herds.has(key) || this.empty.has(key)) continue;
            const h = this.makeWater(l, k);
            if (h) this.herds.set(key, h);
            else this.empty.add(key);
          }
          continue;
        }
        if ((l.kind === 'hamlet' || l.kind === 'mountain-village' || l.kind === 'well-camp') && ld < BIG_R) {
          const key = GRAZE_KEY + Math.abs(l.key);
          if (this.herds.has(key) || this.empty.has(key)) continue;
          const h = this.makeGraze(l);
          if (h) this.herds.set(key, h);
          else this.empty.add(key);
          continue;
        }
        if (l.kind !== 'bones' && l.kind !== 'ruins') continue;
        if (ld > 1600) continue;
        const key = -1 - l.key;
        if (!this.herds.has(key)) this.herds.set(key, this.makeRoost(l));
      }
    }
    if (this.herders) {
      const list = this.herders(this.herderList);
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const key = FLOCK_KEY + f.key;
        if (f.on && !this.herds.has(key) && Math.hypot(f.x - px, f.z - pz) < BIG_R) this.herds.set(key, this.makeFlock(f));
      }
    }
  }
  private readonly empty = new Set<number>();
  private ridden: Animal | null = null;
  private soloKey = 0;

  // ---------------------------------------------------------------- riding

  /** Whether someone is on an animal now. */
  get mounted(): boolean {
    return this.ridden !== null;
  }

  /** A rideable beast (the big ones) stands at (x, z): a box as long as it is, half that wide. The one ridden is not counted. */
  beastAt(x: number, z: number): boolean {
    for (const h of this.herds.values()) {
      if (!RIDEABLE[h.sp] || h.pres < 0.5 || Math.hypot(h.hx - x, h.hz - z) > 400) continue;
      for (const a of h.animals) {
        if (a === this.ridden) continue;
        const dx = x - a.x;
        const dz = z - a.z;
        if (Math.abs(dx) > 2.2 * a.scale || Math.abs(dz) > 2.2 * a.scale) continue;
        const c = Math.cos(a.yaw);
        const sn = Math.sin(a.yaw);
        if (Math.abs(dx * sn + dz * c) < 1.1 * a.scale && Math.abs(dx * c - dz * sn) < 0.5 * a.scale) return true;
      }
    }
    return false;
  }

  /** The nearest animal within `reach` of (x, z) that can be ridden, or null. */
  nearestRideable(x: number, z: number, reach = MOUNT_REACH): unknown {
    if (this.ridden) return null;
    let best: Animal | null = null;
    let bd = reach;
    for (const h of this.herds.values()) {
      if (!RIDEABLE[h.sp] || h.pres < 0.5) continue;
      for (const a of h.animals) {
        const d = Math.hypot(a.x - x, a.z - z);
        if (d < bd) {
          bd = d;
          best = a;
        }
      }
    }
    return best;
  }

  /** Where the key cap goes for an animal got from nearestRideable: on its back. */
  rideMark(ref: unknown, out: { x: number; y: number; z: number }): void {
    const a = ref as Animal;
    out.x = a.x;
    out.y = a.y + MOUNT_BACK * a.scale;
    out.z = a.z;
  }

  /** Climb on an animal got from nearestRideable. */
  mount(ref: unknown): boolean {
    const a = ref as Animal | null;
    if (!a || this.ridden) return false;
    for (const h of this.herds.values()) {
      const i = h.animals.indexOf(a);
      if (i < 0) continue;
      h.animals.splice(i, 1);
      if (a === this.come) {
        // ridden now, as any other: the call is over, and its herd of one goes with it
        if (h === this.comeH && h.key >= SOLO_KEY && h.animals.length === 0) this.herds.delete(h.key);
        this.come = this.comeH = this.comeFrom = null;
      }
      this.ridden = a;
      a.state = 0;
      a.spd = 0;
      a.pose = 0;
      a.avT = 0;
      return true;
    }
    return false;
  }

  /** Get off: the animal stays where it stands, alone, and is not startled for a few seconds. */
  dismount(): void {
    const a = this.ridden;
    if (!a) return;
    this.ridden = null;
    a.state = 0;
    a.t = 2;
    a.tx = a.x;
    a.tz = a.z;
    const key = SOLO_KEY + this.soloKey++;
    this.herds.set(key, { key, sp: a.sp, hx: a.x, hz: a.z, animals: [a], pres: 1, alarm: 0, small: false, follow: null, grace: 3 });
  }

  // ---------------------------------------------------------------- calling

  /** The beast answering the flute, the herd of one it walks in meanwhile, and the herd it left (null: it was alone). */
  private come: Animal | null = null;
  private comeH: Herd | null = null;
  private comeFrom: Herd | null = null;
  /** 0 on its way, 1 waiting by the caller, 2 going back to its herd. */
  private comePhase = 0;
  private comeT = 0;
  /** Turning on the spot to face the caller again. */
  private comeTurn = false;

  /** A beast called on the flute is on its way, or waiting by the caller. */
  get called(): boolean {
    return this.come !== null && this.comePhase < 2;
  }

  /**
   * A call on the flute from (x, z): the nearest wild ass or oryx within CALL_R leaves its herd
   * and comes to stand by the caller, unafraid, for CALL_WAIT s (or till ridden). False if none is
   * in reach. Calling again while one is coming or waiting only starts its time over.
   */
  call(x: number, z: number): boolean {
    let a = this.come;
    if (!a || this.comePhase === 2) {
      let bh: Herd | null = null;
      let bd = CALL_R;
      a = null;
      for (const h of this.herds.values()) {
        if (!RIDEABLE[h.sp] || h.pres < 0.5) continue;
        for (const b of h.animals) {
          const d = Math.hypot(b.x - x, b.z - z);
          if (d < bd) {
            bd = d;
            a = b;
            bh = h;
          }
        }
      }
      if (!a || !bh) return false;
      if (a !== this.come) {
        this.letGo();
        if (bh.animals.length === 1) {
          // alone already: it keeps its own herd of one
          this.comeH = bh;
          this.comeFrom = null;
        } else {
          bh.animals.splice(bh.animals.indexOf(a), 1);
          const key = SOLO_KEY + this.soloKey++;
          this.comeH = { key, sp: a.sp, hx: a.x, hz: a.z, animals: [a], pres: 1, alarm: 0, small: false, follow: null, grace: 0 };
          this.herds.set(key, this.comeH);
          this.comeFrom = bh;
        }
        this.come = a;
      }
    }
    this.comePhase = 0;
    this.comeT = 0;
    this.comeTurn = false;
    a.state = 1;
    a.avT = 0;
    if (this.comeH) this.comeH.alarm = 0;
    this.onCall?.(a.sp, Math.hypot(a.x - x, a.z - z));
    return true;
  }

  /** Forget the call: the beast stays where it is, a herd of one, and behaves as any other. */
  private letGo(): void {
    const h = this.comeH;
    const a = this.come;
    if (h && a) {
      h.hx = a.x;
      h.hz = a.z;
      h.grace = 0;
      a.state = 0;
      a.t = 1 + Math.random() * 3;
    }
    this.come = null;
    this.comeH = null;
    this.comeFrom = null;
    this.comePhase = 0;
  }

  /** Done waiting (or never got there): back to the herd it left, if that is still about. */
  private goBack(): void {
    const from = this.comeFrom;
    const a = this.come;
    if (!a || !this.comeH || !from || from.animals.length === 0 || this.herds.get(from.key) !== from) {
      this.letGo();
      return;
    }
    this.comePhase = 2;
    this.comeT = 0;
    this.comeH.grace = 0;
    a.state = 0;
    a.t = 1 + Math.random() * 2;
  }

  /** The called beast's clock, before the herds move: keeps it calm, gives up, or takes it back into its herd. */
  private stepCall(dt: number, px: number, pz: number): void {
    const a = this.come;
    const h = this.comeH;
    if (!a || !h) return;
    if (this.herds.get(h.key) !== h || !h.animals.includes(a)) {
      this.come = this.comeH = this.comeFrom = null;
      return;
    }
    this.comeT += dt;
    if (this.comePhase < 2) {
      // its own herd of one goes where it goes, and nothing the caller does spooks it
      h.hx = a.x;
      h.hz = a.z;
      h.alarm = 0;
      h.grace = Math.max(h.grace, 0.5);
      const d = Math.hypot(a.x - px, a.z - pz);
      if (this.comePhase === 0 ? this.comeT > CALL_TRY || d > CALL_LOSE : this.comeT > CALL_WAIT) this.goBack();
      return;
    }
    const from = this.comeFrom;
    if (!from || from.animals.length === 0 || this.herds.get(from.key) !== from) {
      this.letGo();
      return;
    }
    h.hx = from.hx;
    h.hz = from.hz;
    if (h.alarm <= 0 && Math.hypot(a.x - from.hx, a.z - from.hz) < SPEC[a.sp].roam) {
      // among them again
      h.animals.length = 0;
      this.herds.delete(h.key);
      from.animals.push(a);
      a.state = 0;
      a.t = 1 + Math.random() * 3;
      this.come = this.comeH = this.comeFrom = null;
    } else if (this.comeT > 240) this.letGo();
  }

  /** Where the ridden animal stands and faces, and how fast it goes (valid while mounted). */
  get seat(): { x: number; z: number; y: number; yaw: number; spd: number; back: number; turn: number; sway?: SaddleSway } | null {
    const a = this.ridden;
    if (!a) return null;
    return { x: a.x, z: a.z, y: a.y, yaw: a.yaw, spd: a.spd, back: MOUNT_BACK * a.scale, turn: this.turnRate };
  }
  private turnRate = 0;

  /**
   * Steer the ridden animal. (wx, wz) is the way to go in the world (length 0..1, 0 to stand);
   * run gallops. It turns at its own pace, speeds up and slows down, and goes round what is in its way.
   */
  ride(dt: number, wx: number, wz: number, run: boolean): void {
    const a = this.ridden;
    if (!a || dt <= 0) return;
    const spec = SPEC[a.sp];
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    const want = Math.hypot(wx, wz);
    let targetSpd = 0;
    if (want > 0.1) {
      const err = angDiff(Math.atan2(wx, wz), a.yaw);
      const tr = spec.turn * 1.4 * dt;
      const step = Math.max(-tr, Math.min(tr, err));
      a.yaw += step;
      this.turnRate += (step / dt - this.turnRate) * k(8);
      targetSpd = (run ? GALLOP[a.sp] : RIDE) * Math.min(1, want) * (Math.abs(err) < 1.4 ? 1 : 0.4);
    } else this.turnRate += (0 - this.turnRate) * k(8);
    a.spd += (targetSpd - a.spd) * k(targetSpd > a.spd ? 2.2 : 4);
    if (a.spd < 0.02) a.spd = 0;
    const mx = Math.sin(a.yaw) * a.spd * dt;
    const mz = Math.cos(a.yaw) * a.spd * dt;
    if (a.spd === 0) return;
    // too steep a face and it will not climb; a stone or a wall and it goes round
    let nx = a.x + mx;
    let nz = a.z + mz;
    if (this.solid && steer(this.solid, a.x, a.z, a.y, mx, mz, spec.body, a.dodge || 1)) {
      a.dodge = steered.side;
      nx = steered.x;
      nz = steered.z;
    }
    const run2 = Math.hypot(nx - a.x, nz - a.z);
    if (run2 > 1e-4 && (this.world.height(nx, nz) - a.y) / run2 > 1.1) {
      a.spd *= 0.3;
      return;
    }
    a.x = nx;
    a.z = nz;
  }

  private putRidden(dt: number, f: FrameState): void {
    const a = this.ridden;
    if (!a) return;
    const spec = SPEC[a.sp];
    a.ph = (a.ph + (a.spd * dt) / strideAt(spec, a.spd)) % 1;
    const gait = a.spd <= spec.walk ? a.spd / spec.walk : 1 + Math.min(1, (a.spd - spec.walk) / (spec.run - spec.walk));
    a.y = this.world.height(a.x, a.z);
    this.world.normal(a.x, a.z, this.nrm);
    const tilt = 0.45;
    this.put(a, a.x, a.y, a.z, this.nrm.x * tilt, this.nrm.y * tilt + (1 - tilt), this.nrm.z * tilt, 0, gait, 0, a.scale);
    void f;
  }

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
    this.stepCall(dt, px, pz);
    this.n = 0;
    let nearestFox = Infinity;
    for (const h of this.herds.values()) {
      // who is out at this hour
      const awake =
        h.sp === FOX ? f.night > 0.45
        : h.sp === HARE ? f.night < 0.75
        : h.sp === LIZARD || h.sp === TORTOISE ? f.night < 0.3
        : h.sp === VULTURE ? f.night < 0.5
        : h.sp === GROUSE ? f.night < 0.4
        : h.sp === SNAKE ? f.night < 0.9
        : h.follow ? h.follow.on
        : true;
      if (h.follow && h.alarm <= 0) {
        h.hx = h.follow.x;
        h.hz = h.follow.z;
      }
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
    this.putRidden(dt, f);
    this.geo.instanceCount = this.n;
    this.iPos.attr.needsUpdate = this.iUp.attr.needsUpdate = this.iMot.attr.needsUpdate = this.iCoat.attr.needsUpdate = true;
  }

  private stepHerd(h: Herd, f: FrameState, dt: number, px: number, pz: number): void {
    const sp = h.sp;
    const spec = SPEC[sp];
    const pl = f.player;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    if (h.animals.length === 0) return;
    // Something coming fast, or close: the whole herd runs (a flock of sandgrouse takes off). A lone
    // fox or hare runs on its own; a tortoise just pulls its head in and waits.
    const fast = pl.speed > 4;
    // A wild ass or an oryx lets someone walk up to it (not run, not slide in on a board): that is
    // how you get close enough to climb on.
    const calm = RIDEABLE[sp] && pl.grounded && !pl.running && !pl.sliding && pl.speed < 6.5;
    const flee = calm ? CALM_FLEE : spec.flee * (fast ? 1.6 : 1);
    h.grace = Math.max(0, h.grace - dt);
    let mx = 0;
    let mz = 0;
    for (const a of h.animals) {
      const d = Math.hypot(a.x - px, a.z - pz);
      if (d < flee && h.pres > 0.5 && h.grace <= 0) h.alarm = Math.max(h.alarm, 2.5 + Math.random());
      mx += a.x;
      mz += a.z;
    }
    mx /= h.animals.length;
    mz /= h.animals.length;
    if (h.alarm > 0) {
      const d = Math.hypot(mx - px, mz - pz);
      // keep running until well clear, then settle where they stopped
      if (d < spec.flee * 2.4 && h.grace <= 0) h.alarm = Math.max(h.alarm, 0.5);
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
    const flock = h.follow;
    const herd = herdSp(sp);
    for (let i = 0; i < h.animals.length; i++) {
      const a = h.animals[i];
      const dx = a.x - px;
      const dz = a.z - pz;
      const d = Math.hypot(dx, dz);
      let targetYaw = a.yaw;
      let targetSpd = 0;
      let poseT = 0;
      if (h.alarm > 0 && sp === TORTOISE) {
        a.state = 0;
        poseT = 1;
      } else if (h.alarm > 0) {
        a.state = 2;
        // away from the player, with a hare's jinks and a lizard's darts
        let away = Math.atan2(dx, dz) + (a.seed - 0.5) * 0.5;
        if (sp === HARE) away += Math.sin(f.time * 3.1 + a.seed * 20) * 0.7;
        if (sp === LIZARD || sp === SNAKE) away += Math.sin(f.time * 7 + a.seed * 20) * 0.5;
        targetYaw = away;
        targetSpd = spec.run * (herd ? 0.85 + a.seed * 0.15 : 1);
        // sandgrouse go up all together, climbing hard at first
        if (sp === GROUSE) a.fly += (4 + a.seed * 4 - a.fly) * k(1.4);
      } else if (a === this.come) {
        // answering the flute: loping in from far off, easing to a trot and a walk as it nears the
        // caller (the gait follows the speed), and stopping short to face them
        a.state = 1;
        const toward = Math.atan2(-dx, -dz);
        if (this.comePhase === 2) {
          const from = this.comeFrom as Herd;
          const ex = from.hx - a.x;
          const ez = from.hz - a.z;
          targetYaw = Math.atan2(ex, ez);
          targetSpd = spec.walk * (Math.hypot(ex, ez) > spec.roam * 2 ? 2.4 : 1);
        } else if (this.comePhase === 0 && d - CALL_STOP > 0.25) {
          const gap = d - CALL_STOP;
          targetYaw = toward;
          targetSpd = Math.min(spec.run * 0.75, gap < 2 ? spec.walk * Math.max(0.3, gap / 2) : spec.walk + (gap - 2) * 0.3);
        } else {
          if (this.comePhase === 0) {
            this.comePhase = 1;
            this.comeT = 0;
          }
          a.state = 0;
          // stands facing them, shifting round when they move off to one side; grazes after a while
          const err = Math.abs(angDiff(toward, a.yaw));
          if (err > 0.7) this.comeTurn = true;
          else if (err < 0.12) this.comeTurn = false;
          if (this.comeTurn) targetYaw = toward;
          poseT = this.comeT > 6 && Math.sin(f.time * 0.21 + a.seed * 30) > 0.2 ? 1 : 0;
        }
      } else if (a.fly > 0) {
        // coming down again a little way on: glide in, slowing, and land running
        a.fly = Math.max(0, a.fly - dt * 2.4);
        targetSpd = Math.max(spec.walk, spec.run * Math.min(1, a.fly / 2.5));
        if (a.fly === 0) {
          a.state = 0;
          a.t = 1 + Math.random() * 3;
        }
      } else {
        a.t -= dt;
        // a shepherd's goats keep round the shepherd: one left behind trots to catch up
        const hd = flock ? Math.hypot(a.x - h.hx, a.z - h.hz) : 0;
        if (flock && !flock.rest && (a.state !== 1 ? hd > spec.roam * 1.4 : Math.hypot(a.tx - h.hx, a.tz - h.hz) > spec.roam * 1.5)) {
          const ang = Math.random() * TAU;
          const rr = Math.sqrt(Math.random()) * spec.roam * 0.7;
          a.tx = h.hx + Math.cos(ang) * rr;
          a.tz = h.hz + Math.sin(ang) * rr;
          a.state = 1;
          a.t = 0;
        }
        if (a.state === 1) {
          const ex = a.tx - a.x;
          const ez = a.tz - a.z;
          if (Math.hypot(ex, ez) < 0.8 || a.t < -20) {
            a.state = 0;
            a.t = 3 + Math.random() * 8;
          } else {
            targetYaw = Math.atan2(ex, ez);
            targetSpd = spec.walk * (hd > spec.roam * 2.2 ? 2.2 : 1);
          }
        } else if (a.t <= 0) {
          if (Math.random() < (sp === LIZARD || sp === TORTOISE ? 0.3 : 0.6) && !(flock && flock.rest)) {
            // wander off a little way from home
            const ang = Math.random() * TAU;
            const rr = Math.sqrt(Math.random()) * spec.roam;
            a.tx = h.hx + Math.cos(ang) * rr;
            a.tz = h.hz + Math.sin(ang) * rr;
            a.state = 1;
            a.t = 0;
          } else a.t = 3 + Math.random() * 8;
        }
        // standing: a grazer grazes, a fox noses the sand, a sandgrouse pecks, unless the player is near enough to watch
        if (a.state === 0) {
          const grazing =
            herd ? Math.sin(f.time * 0.21 + a.seed * 30) > -0.3
            : sp === FOX ? Math.sin(f.time * 0.5 + a.seed * 30) > 0.4
            : sp === GROUSE ? Math.sin(f.time * 2.3 + a.seed * 40) > 0.1
            : false;
          const wary = d < spec.flee * 1.8;
          poseT = grazing && !wary ? (herd ? 1 : sp === GROUSE ? 0.75 : 0.6) : 0;
        }
        // a tortoise someone walks right up to draws its head in all the same
        if (sp === TORTOISE && d < spec.flee * 1.5) {
          poseT = 1;
          targetSpd = 0;
        }
      }
      // on the way round something in its path: keep to the heading that clears it a moment
      if (a.avT > 0) {
        a.avT -= dt;
        if (targetSpd > 0) targetYaw = a.avYaw;
      }
      // turn, and speed up or slow down
      const err = angDiff(targetYaw, a.yaw);
      const tr = spec.turn * (a.state === 2 ? 1.6 : 1) * dt;
      a.yaw += Math.max(-tr, Math.min(tr, err));
      const go = Math.abs(err) < 1.2 ? 1 : 0.3;
      a.spd += (targetSpd * go - a.spd) * k(a.state === 2 ? 3 : 1.5);
      if (a.spd < 0.01) a.spd = 0;
      a.pose += (poseT - a.pose) * k(sp === TORTOISE && poseT > a.pose ? 6 : 1.5);
      // keep a little apart from the others in the herd
      let sx = 0;
      let sz = 0;
      const want = spec.gap;
      for (let j = 0; j < h.animals.length; j++) {
        if (j === i) continue;
        const b = h.animals[j];
        const ox = a.x - b.x;
        const oz = a.z - b.z;
        const sd = Math.hypot(ox, oz);
        if (sd > 1e-3 && sd < want) {
          sx += (ox / sd) * (want - sd) * k(2);
          sz += (oz / sd) * (want - sd) * k(2);
        }
      }
      sx += Math.sin(a.yaw) * a.spd * dt;
      sz += Math.cos(a.yaw) * a.spd * dt;
      // never into a standing stone, a fallen column, a wall: round it, the same side each time
      // (a bird in the air has nothing to walk round)
      if (this.solid && d < AVOID_R && a.fly < 0.6 && (sx !== 0 || sz !== 0)) {
        if (a.dodge === 0) a.dodge = a.seed < 0.5 ? 1 : -1;
        if (steer(this.solid, a.x, a.z, a.y, sx, sz, spec.body, a.dodge)) {
          a.dodge = steered.side;
          a.avT = 0.8;
          if (steered.turn !== 0) a.avYaw = Math.atan2(steered.x - a.x, steered.z - a.z);
          else {
            // boxed in: turn well away, and give up on getting anywhere past it
            a.avYaw = a.yaw + a.dodge * 2.2;
            a.spd *= 0.5;
            if (a.state === 1) {
              a.state = 0;
              a.t = 1 + Math.random() * 3;
            }
          }
        }
        a.x = steered.x;
        a.z = steered.z;
      } else {
        a.x += sx;
        a.z += sz;
      }
      let gait: number;
      if (a.fly > 0) {
        // wingbeats at their own pace; the shader reads a gait over 2 as flight
        a.ph = (a.ph + dt * 6.5) % 1;
        gait = 2 + Math.min(1, a.fly * 1.5);
      } else {
        const running = a.spd > spec.walk * 1.5;
        const stride = running ? spec.runStride : spec.stride;
        a.ph = (a.ph + (a.spd * dt) / stride) % 1;
        gait = a.spd <= spec.walk ? a.spd / spec.walk : 1 + Math.min(1, (a.spd - spec.walk) / (spec.run - spec.walk));
      }
      // the head follows the player, within reason
      let look = 0;
      if (d < (herd && sp !== GOAT ? 45 : 16) && a.state !== 2 && sp !== SNAKE) {
        const c = Math.cos(a.yaw);
        const s = Math.sin(a.yaw);
        const ang = Math.atan2(-dx * c + dz * s, -dx * s - dz * c);
        look = Math.abs(ang) < 2.2 ? Math.max(-1, Math.min(1, ang)) : 0;
      }
      a.look += (look - a.look) * k(3);
      const y = w.height(a.x, a.z);
      a.y = y;
      const fade = h.pres * h.pres * (3 - 2 * h.pres) * (1 - ss(h.small ? SMALL_R - 60 : BIG_R - 120, h.small ? SMALL_R : BIG_R, d));
      if (a.fly > 0) {
        this.put(a, a.x, y + a.fly, a.z, 0, 1, 0, a.look, gait, a.pose, a.scale * fade);
        continue;
      }
      w.normal(a.x, a.z, this.nrm);
      // stand mostly upright on a slope (what crawls lies flat to it)
      const tilt = sp === LIZARD || sp === TORTOISE || sp === SNAKE ? 1 : 0.45;
      const ux = this.nrm.x * tilt;
      const uy = this.nrm.y * tilt + (1 - tilt);
      const uz = this.nrm.z * tilt;
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
    if (scale < 0.01 || this.n >= this.cap) return;
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
