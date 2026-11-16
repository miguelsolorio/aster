// Travellers and caravans on the open desert: parties walking the worn paths between cities and
// resting at the camps along them, people round the fires outside each city, and the pilgrims and
// keepers of the temples out in the wilderness, and the beasts kept in the pens outside each city.
// Four draw calls: pack animals, people, ground props, fire/smoke.
// Everything is instanced; all animation (walk, sit, sway, head turn and bow) is in the vertex shaders.
import * as THREE from 'three';
import type { FrameState, SurfaceSample, Uniforms, World } from '../game/contract';
import type { CitySite } from './types';
import type { Landmark, Village } from '../world/discoveries';
import { STYLE_GLSL } from '../render/styleGlsl';
import { blockedAt, clearAt, CREATURE_STEP, steer, steered, type SolidQuery } from '../world/avoid';
import { routePos, routeSAtU, routeSlope, routeUAtS, type RouteCamp, type RouteNet, type TravelRoute } from './routes';
import type { Herder } from '../world/fauna';
import { inPen, PEN_MARGIN, penSpot, type PenSpot } from './pens';
import { CITY_CLEAR, EARLY_CELL, EARLY_CHANCE, EARLY_R, WILD_CELL, WILD_CHANCE, WILD_TRIES, wildAnchor, wildWanted } from './wildcamps';

const RANGE = 2500;
const FADE0 = 1200;
// Raised for the shepherds, water carriers, foragers and traders' rests out in the open; the
// quality tier thins those out (setDensity) well before the caps are reached.
const CAP_A = 360;
const CAP_P = 380;
const CAP_PROP = 560;
const CAP_FIRE = 500;
/** Route parties and camps are kept for the routes this near the player (distance to the line between the cities). */
const ROUTE_NEAR = RANGE + 1500;
const TAU = Math.PI * 2;
const AVOID_R = 400; // within this of the player, walkers step round whatever stands on their way
// How far aside of their line they look for a way past, nearest first (m).
const SIDESTEP = [0.7, 1.4, 2.1, 2.8, 3.6, 4.5, 5.5];
// Shepherds keep to cells this big, at most one each, kept within RANGE of the player. They never
// walk far (SHEP_ROAM round home), so they need no path: a long way is always walked on a route.
const SHEP_CELL = 1200;
const SHEP_ROAM = 70;
// Riding a pack animal (a camel): slower and steadier than an oryx, and wider in the turn.
/** How far a rider may be from a camel and still climb on (m): a little more than for an oryx, a camel being long. */
const CAMEL_REACH = 3.6;
/** The top of the back over the ground at scale 1, standing (m: the body tube in animalGeometry), and how far it drops kneeling (the shader's). */
const CAMEL_BACK = 2.88;
const CAMEL_KNEEL = 1.5;
const CAMEL_WALK = 1.7; // m/s
const CAMEL_RUN = 5.5;
const CAMEL_RUN_STRIDE = 4.4; // metres per gait cycle at a run (a walk is the agent's own stride)
const CAMEL_TURN = 1.1; // rad/s
const CAMEL_BODY = 0.8; // kept this far (m) from anything standing in the way
/** A camel left loose kneels down to wait after this long (s). */
const CAMEL_WAIT = 40;
// The beasts in a city's pens: only kept up this near the player (they were never seen further),
// fading out from PEN_FADE0. They amble, and turn slowly in the space a pen gives them.
const PEN_R = 700;
const PEN_FADE0 = 450;
const PEN_WALK = 0.6; // m/s
const PEN_TURN = 0.7; // rad/s
/** How far a beast bows its neck (rad) to the ground, to the trough and to the heap of fodder. */
const BOW_GROUND = 1.4;
const BOW_TROUGH = 1.25;
const BOW_HEAP = 1.1;

type V3 = [number, number, number];

// ------------------------------------------------------------------ geometry builder

interface Ring {
  c: V3;
  rx: number;
  rz: number;
  z?: number;
  w?: number;
}

export class GB {
  pos: number[] = [];
  nrm: number[] = [];
  rig: number[] = [];
  piv: number[] = [];
  mp: number[] = [];
  tris = 0;
  private kind = 0;
  private ph = 0;
  private z = 0;
  private w = 0;
  private pv: V3 = [0, 0, 0];
  private mat = 0;
  private part = 0;

  set(kind: number, mat: number, part = 0, ph = 0, pv: V3 = [0, 0, 0], z = 0, w = 0): this {
    this.kind = kind;
    this.mat = mat;
    this.part = part;
    this.ph = ph;
    this.pv = pv;
    this.z = z;
    this.w = w;
    return this;
  }

  tri(a: V3, b: V3, c: V3, ctr: V3 | null, zs?: V3, ws?: V3): void {
    let z: V3 = zs ?? [this.z, this.z, this.z];
    let w: V3 = ws ?? [this.w, this.w, this.w];
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    if (ctr) {
      const mx = (a[0] + b[0] + c[0]) / 3 - ctr[0];
      const my = (a[1] + b[1] + c[1]) / 3 - ctr[1];
      const mz = (a[2] + b[2] + c[2]) / 3 - ctr[2];
      if (nx * mx + ny * my + nz * mz < 0) {
        const t = b;
        b = c;
        c = t;
        z = [z[0], z[2], z[1]];
        w = [w[0], w[2], w[1]];
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
    }
    const P = [a, b, c];
    for (let i = 0; i < 3; i++) {
      this.pos.push(P[i][0], P[i][1], P[i][2]);
      this.nrm.push(nx / len, ny / len, nz / len);
      this.rig.push(this.ph, this.kind, z[i], w[i]);
      this.piv.push(this.pv[0], this.pv[1], this.pv[2]);
      this.mp.push(this.mat, this.part);
    }
    this.tris++;
  }

  tube(rings: Ring[], sides: number, rot: number, capStart: boolean, capEnd: boolean): void {
    const n = rings.length;
    const pts: V3[][] = [];
    for (let i = 0; i < n; i++) {
      const a = rings[Math.max(0, i - 1)].c;
      const b = rings[Math.min(n - 1, i + 1)].c;
      let tx = b[0] - a[0];
      let ty = b[1] - a[1];
      let tz = b[2] - a[2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const h: V3 = Math.abs(ty) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      let ux = h[1] * tz - h[2] * ty;
      let uy = h[2] * tx - h[0] * tz;
      let uz = h[0] * ty - h[1] * tx;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul;
      uy /= ul;
      uz /= ul;
      const vx = ty * uz - tz * uy;
      const vy = tz * ux - tx * uz;
      const vz = tx * uy - ty * ux;
      const r = rings[i];
      const row: V3[] = [];
      for (let j = 0; j < sides; j++) {
        const ang = rot + (j / sides) * TAU;
        const cs = Math.cos(ang) * r.rx;
        const sn = Math.sin(ang) * r.rz;
        row.push([r.c[0] + ux * cs + vx * sn, r.c[1] + uy * cs + vy * sn, r.c[2] + uz * cs + vz * sn]);
      }
      pts.push(row);
    }
    const zOf = (i: number) => rings[i].z ?? this.z;
    const wOf = (i: number) => rings[i].w ?? this.w;
    for (let i = 0; i < n - 1; i++) {
      const ctr = rings[i].c;
      for (let j = 0; j < sides; j++) {
        const j2 = (j + 1) % sides;
        const a = pts[i][j];
        const b = pts[i][j2];
        const c = pts[i + 1][j];
        const d = pts[i + 1][j2];
        this.tri(a, b, c, ctr, [zOf(i), zOf(i), zOf(i + 1)], [wOf(i), wOf(i), wOf(i + 1)]);
        this.tri(b, d, c, ctr, [zOf(i), zOf(i + 1), zOf(i + 1)], [wOf(i), wOf(i + 1), wOf(i + 1)]);
      }
    }
    const cap = (i: number, ref: V3) => {
      for (let j = 0; j < sides; j++) {
        const j2 = (j + 1) % sides;
        this.tri(rings[i].c, pts[i][j], pts[i][j2], ref, [zOf(i), zOf(i), zOf(i)], [wOf(i), wOf(i), wOf(i)]);
      }
    };
    if (capStart) cap(0, rings[Math.min(1, n - 1)].c);
    if (capEnd) cap(n - 1, rings[Math.max(0, n - 2)].c);
  }

  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw = 0): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const corner = (i: number, j: number, k: number): V3 => {
      const x = (i - 0.5) * sx;
      const z = (k - 0.5) * sz;
      return [cx + x * c + z * s, cy + (j - 0.5) * sy, cz - x * s + z * c];
    };
    const ctr: V3 = [cx, cy, cz];
    const q = (a: V3, b: V3, c2: V3, d: V3) => {
      this.tri(a, b, c2, ctr);
      this.tri(a, c2, d, ctr);
    };
    q(corner(0, 0, 0), corner(1, 0, 0), corner(1, 1, 0), corner(0, 1, 0));
    q(corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1));
    q(corner(0, 0, 0), corner(0, 0, 1), corner(0, 1, 1), corner(0, 1, 0));
    q(corner(1, 0, 0), corner(1, 0, 1), corner(1, 1, 1), corner(1, 1, 0));
    q(corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1), corner(0, 0, 1));
    q(corner(0, 1, 0), corner(1, 1, 0), corner(1, 1, 1), corner(0, 1, 1));
  }

  geometry(): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aRig', new THREE.Float32BufferAttribute(this.rig, 4));
    g.setAttribute('aPivot', new THREE.Float32BufferAttribute(this.piv, 3));
    g.setAttribute('aMP', new THREE.Float32BufferAttribute(this.mp, 2));
    return g;
  }
}

// Material ids: 0 coat, 1 dark coat, 2 light coat, 3 fringe, 4 load A, 5 load B, 6 strap/wood,
// 7 clay, 8 char / face shadow, 9 trim, 10 stone.
// Kinds (animal): 0 rigid, 1 leg, 2 neck/head, 3 fringe, 4 tail, 5 neck fringe.
// Kinds (person): 0 rigid, 1 leg, 6 arm, 7 cloak.
// Parts (animal/person): bit mask of load variants; 0 = always. Props: part = prop type.
// Person bits: 1 staff, 2 pack, 4 bag, 8 lantern (lit after dark), 16 water jar on the head.

function animalGeometry(): { geo: THREE.InstancedBufferGeometry; tris: number } {
  const b = new GB();
  // body
  b.set(0, 0).tube(
    [
      { c: [0, 2.3, -1.25], rx: 0.2, rz: 0.26 },
      { c: [0, 2.38, -0.75], rx: 0.38, rz: 0.48 },
      { c: [0, 2.4, 0], rx: 0.42, rz: 0.52 },
      { c: [0, 2.43, 0.75], rx: 0.4, rz: 0.5 },
      { c: [0, 2.5, 1.22], rx: 0.27, rz: 0.36 },
    ],
    8,
    Math.PI / 8,
    true,
    true,
  );
  // legs: hip pivot, upper part rigid, lower part bends at the knee (weight w)
  const hips: Array<[number, number, number, number]> = [
    [0.27, 0.8, 1, 0.12],
    [-0.27, 0.8, 1, 0.62],
    [0.27, -0.8, -1, 0],
    [-0.27, -0.8, -1, 0.5],
  ];
  for (const [hx, hz, front, ph] of hips) {
    const pv: V3 = [hx, 2.15, hz];
    b.set(1, 0, 0, ph, pv, front, 0).tube(
      [
        { c: [hx, 2.15, hz], rx: 0.16, rz: 0.16 },
        { c: [hx, 1.15, hz + 0.02 * front], rx: 0.17, rz: 0.17 },
      ],
      4,
      Math.PI / 4,
      false,
      false,
    );
    b.set(1, 1, 0, ph, pv, front, 0).tube(
      [
        { c: [hx, 1.15, hz + 0.02 * front], rx: 0.17, rz: 0.17, w: 0 },
        { c: [hx, 0.6, hz], rx: 0.075, rz: 0.075, w: 1 },
        { c: [hx, 0.12, hz], rx: 0.095, rz: 0.095, w: 1 },
        { c: [hx, 0.02, hz + 0.03], rx: 0.14, rz: 0.12, w: 1 },
      ],
      4,
      Math.PI / 4,
      false,
      true,
    );
  }
  // neck and head, pivot at the neck base
  const np: V3 = [0, 2.46, 1.0];
  b.set(2, 0, 0, 0, np).tube(
    [
      { c: [0, 2.52, 1.0], rx: 0.27, rz: 0.27, z: 0 },
      { c: [0, 2.62, 1.5], rx: 0.19, rz: 0.19, z: 0.35 },
      { c: [0, 2.72, 2.0], rx: 0.15, rz: 0.15, z: 0.7 },
      { c: [0, 2.76, 2.35], rx: 0.13, rz: 0.13, z: 1 },
    ],
    5,
    0,
    false,
    false,
  );
  b.set(2, 2, 0, 0, np, 1).tube(
    [
      { c: [0, 2.76, 2.3], rx: 0.15, rz: 0.14 },
      { c: [0, 2.72, 2.58], rx: 0.13, rz: 0.12 },
      { c: [0, 2.66, 2.84], rx: 0.09, rz: 0.08 },
    ],
    5,
    0,
    false,
    true,
  );
  b.set(2, 0, 0, 0, np, 1);
  for (const s of [-1, 1]) b.tri([s * 0.09, 2.86, 2.36], [s * 0.17, 2.98, 2.3], [s * 0.12, 2.85, 2.46], null);
  b.set(2, 3, 0, 0, np, 1).tri([-0.08, 2.88, 2.45], [0.08, 2.88, 2.45], [0, 2.78, 2.68], null);
  // neck beard
  b.set(5, 3, 0, 0, np, 0, 0.3);
  const beard: Array<[number, number, number]> = [
    [1.25, 2.36, 0.2],
    [1.65, 2.42, 0.5],
    [2.05, 2.5, 0.8],
  ];
  for (const [z, y, w] of beard) b.tri([0, y, z - 0.18], [0, y, z + 0.18], [0, y - 0.6, z], null, [0, 0, 1], [w, w, w]);
  // flank fringes
  b.set(3, 3);
  for (const s of [-1, 1]) {
    for (const z of [-0.95, -0.55, -0.15, 0.25, 0.65, 1.05]) {
      b.tri([s * 0.38, 2.15, z - 0.2], [s * 0.38, 2.15, z + 0.2], [s * 0.5, 1.3, z + 0.03], null, [0, 0, 1]);
    }
  }
  b.tri([-0.22, 2.2, 1.2], [0.22, 2.2, 1.2], [0, 1.5, 1.32], null, [0, 0, 1]);
  // tail
  const tp: V3 = [0, 2.62, -1.22];
  b.set(4, 0, 0, 0, tp).tube(
    [
      { c: [0, 2.62, -1.22], rx: 0.08, rz: 0.08, z: 0 },
      { c: [0, 2.35, -1.45], rx: 0.07, rz: 0.07, z: 0.5 },
      { c: [0, 2.05, -1.5], rx: 0.06, rz: 0.06, z: 1 },
    ],
    4,
    Math.PI / 4,
    false,
    false,
  );
  b.set(4, 1, 0, 0, tp);
  b.tri([-0.12, 2.15, -1.5], [0.12, 2.15, -1.5], [0, 1.7, -1.52], null, [0.9, 0.9, 1]);
  b.tri([0, 2.15, -1.62], [0, 2.15, -1.38], [0, 1.7, -1.5], null, [0.9, 0.9, 1]);
  // load variant 1: bundles either side and a strap
  for (const s of [-1, 1]) b.set(0, 4, 1).box(s * 0.56, 2.58, 0.05, 0.42, 0.62, 0.95);
  b.set(0, 6, 1).box(0, 2.96, 0.05, 1.35, 0.05, 0.18);
  // variant 2: two jars
  for (const s of [-1, 1]) {
    b.set(0, 7, 2).tube(
      [
        { c: [s * 0.62, 2.2, 0.1], rx: 0.1, rz: 0.1 },
        { c: [s * 0.62, 2.42, 0.1], rx: 0.23, rz: 0.23 },
        { c: [s * 0.62, 2.7, 0.1], rx: 0.17, rz: 0.17 },
        { c: [s * 0.62, 2.9, 0.1], rx: 0.09, rz: 0.09 },
      ],
      5,
      0,
      true,
      false,
    );
  }
  // variant 4: blanket and a rolled cloth
  b.set(0, 5, 4).box(0, 2.94, 0, 0.95, 0.07, 1.5);
  for (const s of [-1, 1]) {
    b.tri([s * 0.48, 2.94, -0.75], [s * 0.48, 2.94, 0.75], [s * 0.5, 2.45, 0.75], null);
    b.tri([s * 0.48, 2.94, -0.75], [s * 0.5, 2.45, 0.75], [s * 0.5, 2.45, -0.75], null);
  }
  b.set(0, 4, 4).tube(
    [
      { c: [-0.5, 3.08, -0.1], rx: 0.17, rz: 0.17 },
      { c: [0.5, 3.08, -0.1], rx: 0.17, rz: 0.17 },
    ],
    6,
    0,
    true,
    true,
  );
  return { geo: b.geometry(), tris: b.tris };
}

function personGeometry(): { geo: THREE.InstancedBufferGeometry; tris: number } {
  const b = new GB();
  for (const [hx, ph] of [
    [0.09, 0],
    [-0.09, 0.5],
  ] as Array<[number, number]>) {
    // thin dark legs with a small foot, like the townsfolk
    b.set(1, 8, 0, ph, [hx, 0.62, 0]).tube(
      [
        { c: [hx, 0.62, 0], rx: 0.024, rz: 0.024 },
        { c: [hx, 0.04, 0.0], rx: 0.022, rz: 0.022 },
        { c: [hx, 0.0, 0.05], rx: 0.024, rz: 0.03 },
      ],
      4,
      Math.PI / 4,
      false,
      true,
    );
  }
  b.set(7, 0).tube(
    [
      { c: [0, 0.28, 0], rx: 0.36, rz: 0.33, z: 1 },
      { c: [0, 0.85, 0], rx: 0.28, rz: 0.27, z: 0.45 },
      { c: [0, 1.42, 0], rx: 0.2, rz: 0.2, z: 0 },
    ],
    8,
    Math.PI / 8,
    false,
    false,
  );
  b.set(7, 2, 0, 0, [0, 0, 0], 0.1).tube(
    [
      { c: [0, 1.0, 0], rx: 0.33, rz: 0.31 },
      { c: [0, 1.46, 0], rx: 0.21, rz: 0.21 },
    ],
    8,
    Math.PI / 8,
    false,
    false,
  );
  b.set(0, 0).tube(
    [
      { c: [0, 1.44, 0], rx: 0.14, rz: 0.14 },
      { c: [0, 1.58, 0.01], rx: 0.19, rz: 0.19 },
      { c: [0, 1.74, 0], rx: 0.165, rz: 0.165 },
      { c: [0, 1.85, -0.01], rx: 0, rz: 0 },
    ],
    6,
    Math.PI / 6,
    false,
    false,
  );
  // the face: a plain white disc set in the front of the hood
  b.set(0, 11).tube(
    [
      { c: [0, 1.6, 0.12], rx: 0.115, rz: 0.115 },
      { c: [0, 1.6, 0.2], rx: 0.11, rz: 0.11 },
      { c: [0, 1.6, 0.215], rx: 0.07, rz: 0.07 },
    ],
    8,
    Math.PI / 8,
    false,
    true,
  );
  for (const [sx, ph] of [
    [1, 0.5],
    [-1, 0],
  ] as Array<[number, number]>) {
    const pv: V3 = [sx * 0.25, 1.36, 0];
    b.set(6, 0, 0, ph, pv).tube(
      [
        { c: [sx * 0.25, 1.36, 0], rx: 0.08, rz: 0.08 },
        { c: [sx * 0.29, 0.82, 0.05], rx: 0.06, rz: 0.06 },
      ],
      4,
      Math.PI / 4,
      false,
      true,
    );
  }
  b.set(0, 6, 1).tube(
    [
      { c: [0.36, 0, 0.2], rx: 0.022, rz: 0.022 },
      { c: [0.36, 1.75, 0.2], rx: 0.022, rz: 0.022 },
    ],
    4,
    Math.PI / 4,
    true,
    true,
  );
  b.set(0, 4, 2).box(0, 1.12, -0.27, 0.4, 0.5, 0.26);
  b.set(0, 5, 4).box(-0.3, 0.72, -0.12, 0.22, 0.3, 0.2);
  // a lantern hung from the left hand, swinging with the arm (pilgrims, after dark)
  const lv: V3 = [-0.25, 1.36, 0];
  b.set(6, 6, 8, 0, lv).box(-0.3, 0.8, 0.06, 0.02, 0.1, 0.02);
  b.box(-0.3, 0.75, 0.06, 0.16, 0.03, 0.16);
  b.box(-0.3, 0.6, 0.06, 0.15, 0.03, 0.15);
  b.set(6, 12, 8, 0, lv).box(-0.3, 0.675, 0.06, 0.11, 0.12, 0.11);
  // a water jar carried on the head (water carriers at an oasis): it turns with the hood
  b.set(0, 7, 16).tube(
    [
      { c: [0, 1.84, 0], rx: 0.07, rz: 0.07 },
      { c: [0, 1.95, 0], rx: 0.15, rz: 0.15 },
      { c: [0, 2.08, 0], rx: 0.11, rz: 0.11 },
      { c: [0, 2.13, 0], rx: 0.06, rz: 0.06 },
      { c: [0, 2.17, 0], rx: 0.075, rz: 0.075 },
    ],
    6,
    0,
    true,
    true,
  );
  return { geo: b.geometry(), tris: b.tris };
}

function propGeometry(): THREE.InstancedBufferGeometry {
  const b = new GB();
  b.set(0, 4, 1).box(0, 0.25, 0, 0.8, 0.5, 0.55);
  b.set(0, 6, 1).box(0, 0.25, 0, 0.84, 0.54, 0.12);
  b.set(0, 5, 2).tube(
    [
      { c: [-0.55, 0.2, 0], rx: 0.2, rz: 0.2 },
      { c: [0.55, 0.2, 0], rx: 0.2, rz: 0.2 },
    ],
    6,
    0,
    true,
    true,
  );
  b.set(0, 7, 3).tube(
    [
      { c: [0, 0, 0], rx: 0.1, rz: 0.1 },
      { c: [0, 0.22, 0], rx: 0.24, rz: 0.24 },
      { c: [0, 0.5, 0], rx: 0.15, rz: 0.15 },
      { c: [0, 0.62, 0], rx: 0.09, rz: 0.09 },
    ],
    5,
    0,
    true,
    false,
  );
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    b.set(0, 10, 4).box(Math.sin(a) * 0.55, 0.09, Math.cos(a) * 0.55, 0.26, 0.18, 0.22, a);
  }
  b.set(0, 8, 4).box(0, 0.12, 0, 0.1, 0.1, 0.8, 0.6);
  b.box(0, 0.12, 0, 0.1, 0.1, 0.8, -0.6);
  for (const s of [-1, 1]) {
    b.set(0, 6, 5).tube(
      [
        { c: [s * 1.3, 0, -0.2], rx: 0.04, rz: 0.04 },
        { c: [s * 1.3, 2.0, -0.2], rx: 0.04, rz: 0.04 },
      ],
      4,
      Math.PI / 4,
      false,
      false,
    );
    b.tube(
      [
        { c: [s * 1.3, 0, 1.2], rx: 0.04, rz: 0.04 },
        { c: [s * 1.3, 1.35, 1.2], rx: 0.04, rz: 0.04 },
      ],
      4,
      Math.PI / 4,
      false,
      false,
    );
  }
  b.set(0, 4, 5);
  b.tri([-1.4, 2.0, -0.2], [1.4, 2.0, -0.2], [1.4, 1.35, 1.2], null);
  b.tri([-1.4, 2.0, -0.2], [1.4, 1.35, 1.2], [-1.4, 1.35, 1.2], null);
  b.set(0, 5, 6).box(0, 0.015, 0, 2.0, 0.03, 1.3);
  // 7: a log to sit against, along x
  b.set(0, 6, 7).tube(
    [
      { c: [-0.85, 0.17, 0], rx: 0.17, rz: 0.17 },
      { c: [0.85, 0.15, 0], rx: 0.15, rz: 0.15 },
    ],
    7,
    0.3,
    true,
    true,
  );
  // 8: a low plank bench, along x (wood in the instance colour)
  b.set(0, 4, 8).box(0, 0.41, 0, 1.5, 0.07, 0.34);
  b.box(-0.58, 0.19, 0, 0.1, 0.38, 0.3);
  b.box(0.58, 0.19, 0, 0.1, 0.38, 0.3);
  // 9: a small low table
  b.set(0, 4, 9).box(0, 0.46, 0, 0.8, 0.05, 0.55);
  for (const [lx, lz] of [[-0.33, -0.22], [0.33, -0.22], [-0.33, 0.22], [0.33, 0.22]]) b.box(lx, 0.22, lz, 0.06, 0.44, 0.06);
  // 10: a cooking pot hung from a tripod over the fire
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + 0.3;
    b.set(0, 6, 10).tube(
      [
        { c: [Math.sin(a) * 0.78, 0, Math.cos(a) * 0.78], rx: 0.03, rz: 0.03 },
        { c: [Math.sin(a) * 0.05, 1.4, Math.cos(a) * 0.05], rx: 0.025, rz: 0.025 },
      ],
      4,
      0,
      false,
      false,
    );
  }
  b.set(0, 8, 10).box(0, 1.08, 0, 0.02, 0.6, 0.02);
  b.tube(
    [
      { c: [0, 0.5, 0], rx: 0.14, rz: 0.14 },
      { c: [0, 0.62, 0], rx: 0.21, rz: 0.21 },
      { c: [0, 0.78, 0], rx: 0.19, rz: 0.19 },
    ],
    7,
    0,
    true,
    false,
  );
  return b.geometry();
}

// ------------------------------------------------------------------ shaders

const common = /* glsl */ `
vec3 rx(vec3 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}
vec3 matColor(float m, vec3 coat, vec3 load) {
  vec3 c;
  if (m < 0.5) c = coat;
  else if (m < 1.5) c = coat * 0.5;
  else if (m < 2.5) c = coat * vec3(1.18, 1.1, 1.0);
  else if (m < 3.5) c = coat * vec3(1.22, 1.1, 0.92);
  else if (m < 4.5) c = load;
  else if (m < 5.5) c = load.brg * 0.8 + vec3(0.06, 0.05, 0.03);
  else if (m < 6.5) c = vec3(0.24, 0.18, 0.13);
  else if (m < 7.5) c = vec3(0.62, 0.38, 0.26);
  else if (m < 8.5) c = vec3(0.07, 0.055, 0.05);
  else if (m < 9.5) c = coat * 0.8 + vec3(0.05);
  else if (m < 10.5) c = vec3(0.42, 0.38, 0.34);
  else if (m < 11.5) c = vec3(0.97, 0.95, 0.9);
  else c = vec3(1.0, 0.78, 0.42);
  return c;
}
`;

const animalVert = /* glsl */ `
attribute vec4 aRig;
attribute vec3 aPivot;
attribute vec2 aMP;
attribute vec4 iPos;
attribute vec4 iUp;
attribute vec4 iMot;
attribute vec4 iCoat;
attribute vec4 iLoad;
attribute vec4 iAux;  // x: the neck's bow (rad, + down: grazing, at the trough; - up)
uniform float uTime;
varying vec3 vW;
varying vec3 vN;
varying vec3 vCol;
varying float vY;
varying float vEm;
${common}
void main() {
  float vis = 1.0;
  if (aMP.y > 0.5) vis = mod(floor(iLoad.w / aMP.y + 0.01), 2.0);
  if (vis < 0.5 || iMot.w < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vW = vec3(0.0); vN = vec3(0.0, 1.0, 0.0); vCol = vec3(0.0); vY = 0.0; vEm = 0.0;
    return;
  }
  float TAU = 6.2831853;
  float kind = aRig.y;
  float ph = iMot.x;
  float g = iMot.y;
  float sit = smoothstep(0.0, 1.0, iMot.z);
  float sc = iMot.w;
  float seed = iCoat.w;
  float T = uTime;
  vec3 p = position;
  vec3 n = normal;
  float localY = p.y;
  float th = TAU * (ph + aRig.x);
  bool leg = kind > 0.5 && kind < 1.5;
  bool neck = (kind > 1.5 && kind < 2.5) || (kind > 4.5 && kind < 5.5);
  bool fringe = (kind > 2.5 && kind < 3.5) || (kind > 4.5 && kind < 5.5);
  if (leg) {
    float front = aRig.z;
    float a1 = 0.46 * g * sin(th);
    float kn = 0.95 * g * max(0.0, -cos(th));
    a1 = mix(a1, front > 0.0 ? -1.2 : 1.0, sit);
    kn = mix(kn, front > 0.0 ? 2.55 : -2.45, sit);
    vec3 q = p - aPivot;
    vec3 kr = vec3(0.0, -1.0, 0.0);
    float kw = kn * aRig.w;
    q = kr + rx(q - kr, kw);
    n = rx(n, kw);
    q = rx(q, a1);
    n = rx(n, a1);
    p = aPivot + q;
  }
  if (neck) {
    float w = kind < 3.0 ? aRig.z : aRig.w;
    float pitch = (0.11 * g * sin(TAU * ph + 0.8) + 0.04 * sin(T * 0.9 + seed * 40.0) - 0.5 * sit + iAux.x) * w;
    float b = iUp.w * w + 0.05 * sin(T * 0.6 + seed * 30.0) * w;
    float c = cos(b);
    float s = sin(b);
    vec3 q = rx(p - aPivot, pitch);
    q.xz = vec2(q.x * c + q.z * s, -q.x * s + q.z * c);
    p = aPivot + q;
    n = rx(n, pitch);
    n.xz = vec2(n.x * c + n.z * s, -n.x * s + n.z * c);
  }
  if (fringe) {
    float hz = aRig.z;
    float sw = hz * hz * 0.8 + hz * 0.2;
    p.x += sw * (0.08 * sin(T * 1.8 + p.z * 2.5 + seed * 30.0) + 0.14 * g * sin(th + p.z));
    p.z += sw * (0.10 * g * cos(th) + 0.03 * sin(T * 1.3 + seed * 20.0));
  }
  if (kind > 3.5 && kind < 4.5) {
    float b = (0.45 * sin(T * 1.4 + seed * 30.0) + 0.2 * g * sin(th)) * aRig.z;
    float c = cos(b);
    float s = sin(b);
    vec3 q = p - aPivot;
    q.xy = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
    p = aPivot + q;
  }
  // body roll and bob; feet stay planted
  float roll = 0.05 * g * sin(TAU * ph + 0.4);
  p.x += sin(roll) * p.y;
  p.y += 0.04 * g * sin(2.0 * TAU * ph) * smoothstep(0.3, 2.2, localY);
  p.y += 0.015 * sin(T * 1.1 + seed * 40.0) * smoothstep(0.3, 2.0, localY) * sit;
  p.y -= 1.5 * sit;
  if (leg) p.y = max(p.y, 0.02);
  p *= sc;

  vec3 up = normalize(iUp.xyz);
  float yaw = iPos.w;
  vec3 f0 = vec3(sin(yaw), 0.0, cos(yaw));
  vec3 r = normalize(cross(up, f0));
  vec3 f = cross(r, up);
  vec3 wp = iPos.xyz + r * p.x + up * p.y + f * p.z;
  vW = wp;
  vN = normalize(r * n.x + up * n.y + f * n.z);
  vY = localY;
  vCol = matColor(aMP.x, iCoat.rgb, iLoad.rgb);
  vEm = step(11.5, aMP.x);
  if (fringe) vCol *= 1.0 - 0.22 * aRig.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const personVert = /* glsl */ `
attribute vec4 aRig;
attribute vec3 aPivot;
attribute vec2 aMP;
attribute vec4 iPos;
attribute vec4 iUp;
attribute vec4 iMot;
attribute vec4 iCoat;
attribute vec4 iLoad;
uniform float uTime;
varying vec3 vW;
varying vec3 vN;
varying vec3 vCol;
varying float vY;
varying float vEm;
${common}
void main() {
  float vis = 1.0;
  if (aMP.y > 0.5) vis = mod(floor(iLoad.w / aMP.y + 0.01), 2.0);
  if (vis < 0.5 || iMot.w < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vW = vec3(0.0); vN = vec3(0.0, 1.0, 0.0); vCol = vec3(0.0); vY = 0.0; vEm = 0.0;
    return;
  }
  float TAU = 6.2831853;
  float kind = aRig.y;
  float ph = iMot.x;
  float g = iMot.y;
  float sit = smoothstep(0.0, 1.0, iMot.z);
  float sc = iMot.w;
  float seed = iCoat.w;
  float T = uTime;
  vec3 p = position;
  vec3 n = normal;
  float localY = p.y;
  float th = TAU * (ph + aRig.x);
  bool leg = kind > 0.5 && kind < 1.5;
  if (leg) {
    float a = mix(0.6 * g * sin(th), -1.45, sit);
    p = aPivot + rx(p - aPivot, a);
    n = rx(n, a);
  } else if (kind > 5.5 && kind < 6.5) {
    float a = mix(-0.5 * g * sin(th), -0.5, sit);
    p = aPivot + rx(p - aPivot, a);
    n = rx(n, a);
  } else if (kind > 6.5) {
    float sw = aRig.z * aRig.z;
    p.x += sw * (0.04 * g * sin(th) + 0.015 * sin(T * 1.2 + seed * 30.0));
    p.z += sw * (0.07 * g * sin(th + 1.2) + 0.01 * sin(T * 0.9 + seed * 20.0));
  }
  if (!leg) {
    float tw = 0.07 * g * sin(th) * smoothstep(0.5, 1.4, localY);
    float c = cos(tw);
    float s = sin(tw);
    p.xz = vec2(p.x * c + p.z * s, -p.x * s + p.z * c);
    p.y += 0.02 * g * sin(2.0 * th + 0.5) * smoothstep(0.3, 1.0, localY);
    p.y += 0.006 * sin(T * 1.5 + seed * 30.0) * smoothstep(0.3, 1.0, localY);
  }
  // the head turns to look (iUp.w): the hood and face, blended in at the neck
  float hk = smoothstep(1.36, 1.5, localY) * iUp.w;
  if (abs(hk) > 1e-4) {
    float c = cos(hk);
    float s = sin(hk);
    p.xz = vec2(p.x * c + p.z * s, -p.x * s + p.z * c);
    n.xz = vec2(n.x * c + n.z * s, -n.x * s + n.z * c);
  }
  if (leg) {
    p.y -= sit * 0.6;
    p.y = max(p.y, 0.02);
  } else {
    p.y -= sit * 0.6 * smoothstep(0.0, 0.7, localY);
    p.xz *= 1.0 + 0.3 * sit * (1.0 - smoothstep(0.0, 1.1, localY));
  }
  p *= sc;
  vec3 up = normalize(iUp.xyz);
  float yaw = iPos.w;
  vec3 f0 = vec3(sin(yaw), 0.0, cos(yaw));
  vec3 r = normalize(cross(up, f0));
  vec3 f = cross(r, up);
  vec3 wp = iPos.xyz + r * p.x + up * p.y + f * p.z;
  vW = wp;
  vN = normalize(r * n.x + up * n.y + f * n.z);
  vY = localY;
  vCol = matColor(aMP.x, iCoat.rgb, iLoad.rgb);
  vEm = step(11.5, aMP.x);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const propVert = /* glsl */ `
attribute vec2 aMP;
attribute vec4 iPos;
attribute vec4 iProp;
attribute vec4 iCol;
varying vec3 vW;
varying vec3 vN;
varying vec3 vCol;
varying float vY;
varying float vEm;
${common}
void main() {
  if (abs(aMP.y - iProp.x) > 0.5 || iProp.y < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vW = vec3(0.0); vN = vec3(0.0, 1.0, 0.0); vCol = vec3(0.0); vY = 0.0; vEm = 0.0;
    return;
  }
  float c = cos(iPos.w);
  float s = sin(iPos.w);
  vec3 p = position * iProp.y;
  vec3 wp = iPos.xyz + vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
  vW = wp;
  vN = vec3(normal.x * c + normal.z * s, normal.y, -normal.x * s + normal.z * c);
  vY = position.y;
  vCol = matColor(aMP.x, iCol.rgb, iCol.rgb);
  vEm = 0.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const bodyFrag = /* glsl */ `
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
varying float vEm;
${STYLE_GLSL}
void main() {
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  if (vEm > 0.5) {
    // a lantern's flame: lit from inside, brighter the darker it gets
    vec3 fc = vCol * (0.7 + 0.8 * uNight);
    gl_FragColor = vec4(mix(fc, uFogCol, (1.0 - exp(-dist * uFog)) * 0.5), 1.0);
    return;
  }
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
  col *= mix(0.72, 1.0, smoothstep(0.0, 0.5, vY));
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * smoothstep(-0.2, 0.3, ndl);
  col += uSunCol * rim * 0.12 * (1.0 - 0.5 * uNight);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

const fireVert = /* glsl */ `
attribute vec4 iBase;
attribute vec4 iKind;
uniform float uTime;
uniform vec2 uWind;
varying vec2 vUv;
varying float vKind;
varying float vA;
varying float vDist;
varying float vSeed;
void main() {
  float kind = iKind.x;
  float seed = iKind.y;
  float idx = iKind.z;
  float fade = iBase.w;
  vec3 c = iBase.xyz;
  vec3 toCam = cameraPosition - c;
  vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-5, 0.0, 0.0));
  vec2 q = position.xy;
  vec3 wp;
  vA = 1.0;
  if (kind < 0.5 || kind > 2.5) {
    bool lamp = kind > 2.5;
    float s = (lamp ? 2.6 : 7.0) * fade;
    wp = c + vec3(0.0, lamp ? 0.0 : 0.9, 0.0) + right * q.x * s + vec3(0.0, 1.0, 0.0) * q.y * s * 0.8;
    vUv = q;
  } else if (kind < 1.5) {
    float fl = 0.82 + 0.18 * sin(uTime * 11.0 + seed * 40.0) + 0.1 * sin(uTime * 17.0 + seed * 13.0);
    float h = (0.9 + 0.5 * fract(seed * 7.0)) * fl * fade;
    float w = 0.34 * fade;
    float yy = q.y * 0.5 + 0.5;
    vec3 off = vec3((fract(seed * 13.0) - 0.5) * 0.4, 0.05, (fract(seed * 29.0) - 0.5) * 0.4);
    wp = c + off + right * q.x * w + vec3(0.0, 1.0, 0.0) * yy * h;
    wp.xz += uWind * 0.12 * yy * yy;
    vUv = vec2(q.x, yy);
  } else {
    float age = fract(uTime * 0.08 + idx);
    float rise = 1.4 + age * 17.0;
    float sz = (0.22 + age * 1.4) * fade;
    vec3 ctr = c + vec3(0.0, rise, 0.0);
    ctr.xz += uWind * age * age * 9.0 + vec2(sin(age * 6.0 + seed * 20.0), cos(age * 5.0 + seed * 17.0)) * age * 0.6;
    wp = ctr + right * q.x * sz + vec3(0.0, 1.0, 0.0) * q.y * sz;
    vA = smoothstep(0.0, 0.1, age) * (1.0 - smoothstep(0.55, 1.0, age));
    vUv = q;
  }
  vKind = kind;
  vSeed = seed;
  vDist = length(toCam);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const fireFrag = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uNight;
uniform float uFog;
uniform vec3 uFogCol;
varying vec2 vUv;
varying float vKind;
varying float vA;
varying float vDist;
varying float vSeed;
void main() {
  float fogK = exp(-vDist * uFog);
  if (vKind < 0.5 || vKind > 2.5) {
    float r = length(vUv);
    float a = pow(max(1.0 - r, 0.0), 2.2);
    float inten = vKind > 2.5 ? uNight * 0.9 : (0.05 + 0.95 * uNight) * 0.55;
    gl_FragColor = vec4(vec3(1.0, 0.5, 0.2) * a * inten * (0.5 + 0.5 * fogK), 0.0);
  } else if (vKind < 1.5) {
    float y = vUv.y;
    float x = vUv.x + 0.25 * sin(y * 6.0 - uTime * 9.0 + vSeed * 40.0) * y;
    float w = max(pow(1.0 - y, 0.7) * 0.85, 0.02);
    float a = (1.0 - smoothstep(w * 0.35, w, abs(x))) * (1.0 - y * 0.9);
    vec3 col = mix(vec3(1.0, 0.85, 0.4), vec3(1.0, 0.32, 0.08), y);
    float inten = 0.45 + 0.55 * uNight;
    gl_FragColor = vec4(col * a * inten * 0.9 * (0.6 + 0.4 * fogK), 0.0);
  } else {
    float r = length(vUv);
    float a = (1.0 - smoothstep(0.15, 1.0, r)) * vA * 0.32 * (1.0 - 0.6 * uNight);
    vec3 sm = mix(vec3(0.62, 0.58, 0.52), vec3(0.2, 0.2, 0.22), uNight);
    sm = mix(sm, uFogCol, 1.0 - fogK);
    gl_FragColor = vec4(sm * a, a);
  }
}
`;

// ------------------------------------------------------------------ helpers

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number in 0..1 from four integers: the same answer every time for the same cell. */
function hash4(a: number, b: number, c: number, d: number): number {
  let h = 0x9e3779b9 ^ Math.imul(a | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) ^ Math.imul(b | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) ^ Math.imul(d | 0, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function ss(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function angDiff(a: number, b: number): number {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

const COATS: V3[] = [
  [0.62, 0.5, 0.36],
  [0.38, 0.28, 0.2],
  [0.45, 0.4, 0.34],
  [0.55, 0.36, 0.24],
  [0.72, 0.63, 0.5],
  [0.3, 0.24, 0.2],
  [0.5, 0.42, 0.3],
];
const CLOAKS: V3[] = [
  [0.2, 0.24, 0.34],
  [0.5, 0.24, 0.2],
  [0.6, 0.46, 0.22],
  [0.34, 0.36, 0.22],
  [0.7, 0.64, 0.52],
  [0.2, 0.19, 0.2],
  [0.2, 0.38, 0.38],
  [0.42, 0.3, 0.36],
];
const LOADS: V3[] = [
  [0.62, 0.28, 0.22],
  [0.26, 0.36, 0.5],
  [0.68, 0.52, 0.24],
  [0.5, 0.46, 0.3],
  [0.36, 0.44, 0.3],
  [0.55, 0.4, 0.44],
];
const ANIMAL_LOADS = [1, 2, 4, 5, 6, 1, 2, 5];
const PERSON_LOADS = [1, 3, 5, 0, 1, 2, 7, 1];
// The temple people share one look: pilgrims in undyed linen, keepers in saffron and rust.
const PILGRIM_ROBES: V3[] = [
  [0.86, 0.82, 0.72],
  [0.8, 0.74, 0.62],
  [0.74, 0.68, 0.56],
  [0.84, 0.78, 0.66],
];
const KEEPER_ROBES: V3[] = [
  [0.74, 0.42, 0.16],
  [0.66, 0.32, 0.14],
  [0.78, 0.5, 0.2],
];
const PILGRIM_LOADS = [0, 1, 1, 2, 3, 0];
// The mountain people wear their own wool: madder, sage, straw, plum and undyed cream at the foot
// of the mountains, and darker, heavier dyes up in the snow. (No blue or green among them: those
// are the watcher's and the climber's.)
const VILLAGE_WOOL: V3[] = [
  [0.56, 0.3, 0.2],
  [0.32, 0.38, 0.3],
  [0.64, 0.52, 0.32],
  [0.38, 0.3, 0.42],
  [0.74, 0.68, 0.56],
];
const SNOW_WOOL: V3[] = [
  [0.5, 0.17, 0.15],
  [0.3, 0.2, 0.16],
  [0.62, 0.46, 0.2],
  [0.74, 0.71, 0.66],
  [0.4, 0.26, 0.34],
];
// The two with something to ask stand out from the rest: the watcher in deep blue, the climber in teal.
const WATCHER_COAT: V3 = [0.13, 0.24, 0.52];
const CLIMBER_COAT: V3 = [0.1, 0.47, 0.45];
/** Who someone is, for what they say: a traveller, a pilgrim, a temple keeper, or a goat herder. */
export const ROLE_TRAVELLER = 0;
export const ROLE_PILGRIM = 1;
export const ROLE_KEEPER = 2;
/** Someone out with a shepherd's flock (the shepherd, or whoever walks with them). */
export const ROLE_HERDER = 3;
/** The people of the mountain villages: anyone, the watcher under the tower, and the climber by the fire. */
export const ROLE_VILLAGER = 4;
export const ROLE_WATCHER = 5;
export const ROLE_CLIMBER = 6;
export const ROLE_HOST = 7;

interface Agent {
  animal: boolean;
  role: number;
  /** Which way a keeper faces when nobody needs them. */
  yaw0: number;
  /** Carrying a lit lantern now. */
  lamp: boolean;
  s: number;
  o: number;
  lo: number;
  hi: number;
  lat: number;
  drift: number;
  ph: number;
  spd: number;
  vmax: number;
  sit: number;
  sitTarget: number;
  yaw: number;
  look: number;
  /** The neck's bow now (rad, + down; animals only), eased toward what it is doing. */
  pitch: number;
  /** Standing or sitting still with nobody near: where the head is turned to look, how far it bows, and for how long (s). */
  lookTo: number;
  pitchTo: number;
  idleT: number;
  /** Bowed this far to eat (rad), a beast at its fodder or grazing; 0 otherwise. */
  bow: number;
  dirSign: number;
  /** Stepped this far aside of the line (m, along the route's side) to pass something standing on it. */
  avoid: number;
  /** How fast that is changing (m/s), which the heading leans into. */
  avV: number;
  /** The side chosen for the way past (+1, -1, 0 none yet). */
  dside: number;
  /** Walkers that stop at each end of their way (to fill a jar, to gather): how long for, and how long is left. */
  pause: number;
  rest: number;
  scale: number;
  stride: number;
  seed: number;
  coat: V3;
  load: V3;
  variant: number;
  // fixed placement (camps)
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  // the ground last sampled under someone on the move: where, how high, and its normal
  gx: number;
  gz: number;
  gy: number;
  gnx: number;
  gny: number;
  gnz: number;
  /** A camel out of its party: 0 with it, 1 ridden, 2 left loose where the rider got off. */
  free: number;
  /** 0..1, grown back to 1 as a camel fades in again at its place in the party. */
  shown: number;
}

/** A camel taken out of its party: ridden, or standing loose where the rider got off it. */
interface Mount {
  a: Agent;
  g: Group;
  /** Where it knelt in a camp (a camp keeps no schedule to put it back there). */
  hx: number;
  hy: number;
  hz: number;
  hnx: number;
  hny: number;
  hnz: number;
  hyaw: number;
  hsit: number;
  /** Seconds since it was left loose. */
  t: number;
  /** The side a way round something is taken on. */
  dodge: number;
}

interface Route {
  /** Walked dead straight for this far before the meander starts (an avenue). */
  s0?: number;
  /** After s0, heads on this way instead (unit x, z). */
  bx?: number;
  bz?: number;
  ax: number;
  az: number;
  dx: number;
  dz: number;
  px: number;
  pz: number;
  len: number;
  a1: number;
  k1: number;
  p1: number;
  a2: number;
  k2: number;
  p2: number;
}

interface PropI {
  type: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  col: V3;
}

/** A stretch of a party's round trip: walking from s0 to s1, resting at a camp, or away in town. */
interface Leg {
  t0: number;
  t1: number;
  s0: number;
  s1: number;
  dir: number;
  /** Index into Trip.camps while resting there; -1 walking; -2 away in town (not shown). */
  camp: number;
}

/** Where people and animals settle at a camp on a route. */
interface CampSpots {
  camp: RouteCamp;
  /** Sitting places by the seats, facing the fire. The first is the resident's, if there is one. */
  seats: { x: number; z: number; yaw: number }[];
  resident: boolean;
  /** Standing places round the fire. */
  stand: { x: number; z: number; yaw: number }[];
  /** Where the animals kneel, off to the far side. */
  pens: { x: number; z: number; yaw: number }[];
}

/** A party's round trip along a route: A to B with rests at camps, a while in town, and back. */
interface Trip {
  route: TravelRoute;
  camps: CampSpots[];
  legs: Leg[];
  period: number;
  phase: number;
  /** Arc length where the path leaves the paved edge at A and at B. */
  gA: number;
  gB: number;
  /** Which party of the route this is (spreads them over the standing places). */
  index: number;
}

// kind: 1 camp, 2 lone walkers, 3 pilgrims, 4 temple keepers (and a village's people, who keep
// their places the same way), 5 a party on a route between cities,
// 6 a shepherd, 7 the beasts in a pen outside a city
interface Group {
  kind: number;
  /** A village's kind, for the talking. */
  place?: string;
  /** Pilgrims walk together: where they are along the route, which way, how fast, and how long they stay put. */
  s: number;
  dir: number;
  v: number;
  wait: number;
  agents: Agent[];
  route: Route | null;
  ax: number; // anchor
  az: number;
  reach: number;
  pres: number;
  active: boolean;
  maxO: number;
  props: PropI[];
  fx: number;
  fy: number;
  fz: number;
  fseed: number;
  /** Route parties: the trip, and how long its clock has been held (someone talking to one of them). */
  trip?: Trip;
  delay: number;
  /**
   * Shown only while the quality tier's density is above this (0: always). The extra people out in
   * the open get a share of 0..1 each so a lesser tier drops them evenly.
   */
  rank: number;
  /** A shepherd: where the flock is kept, and where they are wandering to. */
  shep?: Shepherd;
  /** A pen's beasts: the pen, and what each of them is about. */
  pen?: PenLife;
  /** A village's people, up in the snow. */
  snow?: boolean;
}

/** The beasts of one pen (a Group of kind 7). The pen's own frame turns by co, si of its rot. */
interface PenLife {
  spot: PenSpot;
  co: number;
  si: number;
  /** One per agent, in the same order. */
  beasts: PenBeast[];
  /** The refresh it was last on the live list in. */
  seen: number;
}

/** What a beast in a pen is about. */
interface PenBeast {
  /** 0 lying down, 1 standing, 2 walking (or turning on the spot) to somewhere else in the pen. */
  mode: number;
  /** Seconds left lying or standing. */
  t: number;
  /** Walking to here (world), to face this way on arrival (NaN: whichever way it came). */
  tx: number;
  tz: number;
  tyaw: number;
  /** Standing at the trough (1) or the heap (2) to eat, or (0) nowhere in particular. */
  eat: number;
  /** Nibbling at the ground while it stands. */
  graze: boolean;
}

/** A shepherd out in the open with a flock (the goats themselves are fauna, following `herder`). */
interface Shepherd {
  herder: Herder;
  hx: number;
  hz: number;
  tx: number;
  tz: number;
  /** Seconds left standing still, or walking (when `walking`). */
  t: number;
  walking: boolean;
  /** The side a way round something is taken on. */
  dodge: number;
}

function routePoint(r: Route, s: number, out: { x: number; z: number }): void {
  const s0 = r.s0 ?? 0;
  const env = s <= s0 ? 0 : ss(s0, s0 + 150, s);
  const m = env * (r.a1 * Math.sin(s * r.k1 + r.p1) + r.a2 * Math.sin(s * r.k2 + r.p2));
  if (r.bx !== undefined && r.bz !== undefined && s > s0) {
    const x0 = r.ax + r.dx * s0;
    const z0 = r.az + r.dz * s0;
    out.x = x0 + r.bx * (s - s0) - r.bz * m;
    out.z = z0 + r.bz * (s - s0) + r.bx * m;
    return;
  }
  out.x = r.ax + r.dx * s + r.px * m;
  out.z = r.az + r.dz * s + r.pz * m;
}

function newAgent(animal: boolean, rng: () => number): Agent {
  const coat = animal ? COATS[Math.floor(rng() * COATS.length)] : CLOAKS[Math.floor(rng() * CLOAKS.length)];
  const j = 0.9 + rng() * 0.2;
  const ld = LOADS[Math.floor(rng() * LOADS.length)];
  const vars = animal ? ANIMAL_LOADS : PERSON_LOADS;
  const a: Agent = {
    animal,
    role: ROLE_TRAVELLER,
    yaw0: 0,
    lamp: false,
    s: 0,
    o: 0,
    lo: 0,
    hi: 0,
    lat: 0,
    drift: 0,
    ph: rng() * 4,
    spd: 0,
    vmax: 1.3 * (0.96 + rng() * 0.08),
    sit: 0,
    sitTarget: 0,
    yaw: 0,
    look: 0,
    pitch: 0,
    lookTo: 0,
    pitchTo: 0,
    idleT: 0,
    bow: 0,
    dirSign: 1,
    avoid: 0,
    avV: 0,
    dside: 0,
    pause: 0,
    rest: 0,
    scale: animal ? 0.9 + rng() * 0.2 : 0.94 + rng() * 0.12,
    stride: animal ? 3.0 : 1.5,
    seed: rng(),
    coat: [coat[0] * j, coat[1] * j, coat[2] * j],
    load: ld,
    variant: vars[Math.floor(rng() * vars.length)],
    x: 0,
    y: 0,
    z: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    gx: NaN,
    gz: NaN,
    gy: 0,
    gnx: 0,
    gny: 1,
    gnz: 0,
    free: 0,
    shown: 1,
  };
  // (so that a camp's people do not all glance round at once when it comes into view)
  a.idleT = 1 + a.seed * 9;
  return a;
}

/**
 * Someone out on the sand, as the talking needs them. role is ROLE_TRAVELLER, ROLE_PILGRIM,
 * ROLE_KEEPER, ROLE_HERDER or one of the village roles (snow is true for someone of a snow
 * village); camp is true for someone who belongs to a camp (sitting or standing at its fire),
 * false for someone walking (a caravan, a pilgrim, a shepherd), at a temple or in a village.
 */
export interface PersonOut {
  ref: unknown;
  x: number;
  y: number;
  z: number;
  h: number;
  sit: number;
  seed: number;
  role: number;
  camp?: boolean;
  snow?: boolean;
  place?: string;
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

// ------------------------------------------------------------------ Caravans

export class Caravans {
  readonly group = new THREE.Group();

  private readonly world: World;
  private readonly cities: { near(x: number, z: number): CitySite[]; neighbours(site: CitySite): [CitySite, CitySite] };

  private readonly animalGeo: THREE.InstancedBufferGeometry;
  private readonly personGeo: THREE.InstancedBufferGeometry;
  private readonly propGeo: THREE.InstancedBufferGeometry;
  private readonly fireGeo: THREE.InstancedBufferGeometry;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly meshes: THREE.Mesh[] = [];

  private readonly aPos = new Inst(CAP_A);
  private readonly aUp = new Inst(CAP_A);
  private readonly aMot = new Inst(CAP_A);
  private readonly aCoat = new Inst(CAP_A);
  private readonly aLoad = new Inst(CAP_A);
  private readonly aAux = new Inst(CAP_A);
  private readonly pPos = new Inst(CAP_P);
  private readonly pUp = new Inst(CAP_P);
  private readonly pMot = new Inst(CAP_P);
  private readonly pCoat = new Inst(CAP_P);
  private readonly pLoad = new Inst(CAP_P);
  private readonly rPos = new Inst(CAP_PROP);
  private readonly rProp = new Inst(CAP_PROP);
  private readonly rCol = new Inst(CAP_PROP);
  private readonly fBase = new Inst(CAP_FIRE);
  private readonly fKind = new Inst(CAP_FIRE);

  private nA = 0;
  private nP = 0;
  private nR = 0;
  private nF = 0;

  private readonly cache = new Map<number, Group[]>();
  /** The camps and parties of each route, by its key. */
  private readonly routeLife = new Map<string, Group[]>();
  private readonly routeList: TravelRoute[] = [];
  /** The pilgrims and keepers of each temple, by its site key. */
  private readonly shrines = new Map<number, Group[]>();
  private readonly marks: Landmark[] = [];
  /** The places built now in the open desert (temples among them). Set by the game. */
  landmarks: ((out: Landmark[]) => Landmark[]) | null = null;
  /** The villages built now, with where their people stand. Set by the game. */
  villages: ((out: Village[]) => Village[]) | null = null;
  private readonly vils: Village[] = [];
  /** Each village's people, by its site key. */
  private readonly villagers = new Map<number, Group>();
  /** The animal pens outside the cities whose outskirts are built now (world space). Set by the game. */
  pens: ((out: PenSpot[]) => PenSpot[]) | null = null;
  /** The beasts of each pen, by its key, and how many refreshes there have been (to forget the pens left behind). */
  private readonly penLife = new Map<number, Group>();
  private readonly penList: PenSpot[] = [];
  private penStamp = 0;
  /** Pen-local places of the other beasts in a pen, while choosing where one goes. */
  private readonly penOthers: number[] = [];
  private readonly penOut = { u: 0, v: 0, yaw: 0 };
  /** What stands in a walker's way: the top over (x, z) for feet at y, or -Infinity (as the wanderer's roof). Set by the game. */
  solid: SolidQuery | null = null;
  private readonly live: Group[] = [];
  private readonly placed: Group[] = []; // camps put down by the game, not by a city
  private held: Agent | null = null; // someone the player is talking to
  private heldT = 0;
  private refresh = 0;
  /** The people of each oasis (a camp by the water, carriers, a forager), by its site key. */
  private readonly oases = new Map<number, Group[]>();
  /** Shepherds, by the cell they keep to (null: nobody keeps that one). */
  private readonly shepCells = new Map<number, Group | null>();
  /** Camps out in the open desert by grid cell (the everyday grid, and the finer one for those with no board). */
  private readonly wildCells = new Map<number, Group | null>();
  private readonly earlyCells = new Map<number, Group | null>();
  /** Set while the wanderer has no board: more camps near, so one is soon found. */
  needy = false;
  /** 0..1 from the quality tier (as people.setDensity): extras with a rank at or above it stay home. */
  private density = 1;
  private readonly cityBuf: CitySite[] = [];

  private readonly sample: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private readonly nrm = new THREE.Vector3();
  private readonly P0 = { x: 0, z: 0 };
  private readonly P1 = { x: 0, z: 0 };

  constructor(
    world: World,
    cities: { near(x: number, z: number): CitySite[]; neighbours(site: CitySite): [CitySite, CitySite] },
    private readonly net: RouteNet,
    uniforms: Uniforms,
  ) {
    this.world = world;
    this.cities = cities;
    this.group.name = 'caravans';

    const animal = animalGeometry();
    const person = personGeometry();
    this.animalGeo = animal.geo;
    this.personGeo = person.geo;
    this.propGeo = propGeometry();

    const attach = (g: THREE.InstancedBufferGeometry, names: string[], insts: Inst[]) => {
      names.forEach((nm, i) => g.setAttribute(nm, insts[i].attr));
    };
    attach(this.animalGeo, ['iPos', 'iUp', 'iMot', 'iCoat', 'iLoad', 'iAux'], [this.aPos, this.aUp, this.aMot, this.aCoat, this.aLoad, this.aAux]);
    attach(this.personGeo, ['iPos', 'iUp', 'iMot', 'iCoat', 'iLoad'], [this.pPos, this.pUp, this.pMot, this.pCoat, this.pLoad]);
    attach(this.propGeo, ['iPos', 'iProp', 'iCol'], [this.rPos, this.rProp, this.rCol]);

    this.fireGeo = new THREE.InstancedBufferGeometry();
    this.fireGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    this.fireGeo.setIndex([0, 1, 2, 0, 2, 3]);
    attach(this.fireGeo, ['iBase', 'iKind'], [this.fBase, this.fKind]);

    const mk = (geo: THREE.BufferGeometry, vs: string, fs: string, extra: Partial<THREE.ShaderMaterialParameters> = {}, order = 0) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...uniforms },
        vertexShader: vs,
        fragmentShader: fs,
        side: THREE.DoubleSide,
        ...extra,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      mesh.name = 'caravans-draw';
      this.group.add(mesh);
      this.materials.push(mat);
      this.meshes.push(mesh);
    };
    mk(this.animalGeo, animalVert, bodyFrag);
    mk(this.personGeo, personVert, bodyFrag);
    mk(this.propGeo, propVert, bodyFrag);
    mk(this.fireGeo, fireVert, fireFrag, {
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    }, 4);
    this.animalGeo.instanceCount = 0;
    this.personGeo.instanceCount = 0;
    this.propGeo.instanceCount = 0;
    this.fireGeo.instanceCount = 0;
  }

  dispose(): void {
    this.animalGeo.dispose();
    this.personGeo.dispose();
    this.propGeo.dispose();
    this.fireGeo.dispose();
    for (const m of this.materials) m.dispose();
    this.group.clear();
  }

  // ---------------------------------------------------------------- talking

  /**
   * How uneven the ground is for a camp at (x, z): the largest height difference, in metres,
   * to four points 14 m out. Infinity on rock or salt, where nobody camps. Under 1.6 is level.
   */
  campRough(x: number, z: number): number {
    const w = this.world;
    const s = w.sample(x, z, this.sample);
    if (s.rock > 0.15 || s.salt > 0.5) return Infinity;
    const h0 = s.h;
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const a = i * (Math.PI / 2);
      worst = Math.max(worst, Math.abs(w.height(x + Math.sin(a) * 14, z + Math.cos(a) * 14) - h0));
    }
    return worst;
  }

  /** Put a camp down at a chosen place: a fire, animals, and people round it. */
  addCamp(x: number, z: number, seed: number): void {
    const g = this.buildCamp(mulberry32(seed >>> 0), x, z);
    this.placed.push(g);
    this.live.push(g);
  }

  /**
   * The nearest traveller within maxD metres of (px, pz). out.y is the ground under
   * them, out.h their height scale and out.sit how far they are sat down (0..1).
   */
  nearestPerson(px: number, pz: number, maxD: number, out: PersonOut): boolean {
    let best: Agent | null = null;
    let bestG: Group | null = null;
    let bd = maxD;
    for (let i = 0; i < this.live.length; i++) {
      const g = this.live[i];
      if (!g.active || g.pres < 0.8 || Math.hypot(g.ax - px, g.az - pz) > g.reach + 60) continue;
      for (let k = 0; k < g.agents.length; k++) {
        const a = g.agents[k];
        if (a.animal) continue;
        const d = Math.hypot(a.x - px, a.z - pz);
        if (d < bd) {
          bd = d;
          best = a;
          bestG = g;
        }
      }
    }
    return best !== null && this.fillPerson(best, bestG, out);
  }

  /** Where a traveller is now. */
  personAt(ref: unknown, out: PersonOut): boolean {
    const a = ref as Agent;
    return this.fillPerson(a, this.groupOf(a), out);
  }

  /** The group on the live list that someone belongs to, or null. */
  private groupOf(a: Agent): Group | null {
    for (let i = 0; i < this.live.length; i++) if (this.live[i].agents.includes(a)) return this.live[i];
    return null;
  }

  private fillPerson(a: Agent, g: Group | null, out: PersonOut): boolean {
    out.ref = a;
    out.role = g?.kind === 6 ? ROLE_HERDER : a.role;
    out.camp = g?.kind === 1;
    out.snow = g?.snow === true;
    out.place = g?.place;
    out.x = a.x;
    out.y = a.y;
    out.z = a.z;
    out.h = a.scale;
    out.sit = a.sit;
    out.seed = a.seed;
    return true;
  }

  /** Fewer people out in the open on a lesser tier: d in 0..1, as people.setDensity. */
  setDensity(d: number): void {
    this.density = Math.min(1, Math.max(0.05, d));
  }

  /** The shepherds out now (for the goats to follow). Fills and returns out. */
  herders(out: Herder[]): Herder[] {
    out.length = 0;
    for (let i = 0; i < this.live.length; i++) {
      const g = this.live[i];
      if (g.shep) out.push(g.shep.herder);
    }
    return out;
  }

  /** Call every frame while talking to a traveller: they stop walking and turn to the player. */
  hold(ref: unknown): void {
    this.held = ref as Agent;
    this.heldT = 0.3;
  }

  // ---------------------------------------------------------------- riding

  private ridden: Mount | null = null;
  /** Camels got off and left standing where they were, till the player is well away. */
  private readonly loose: Mount[] = [];
  private turnRate = 0;

  /** Whether someone is on a camel now. */
  get mounted(): boolean {
    return this.ridden !== null;
  }

  /** The nearest camel within `reach` of (x, z), kneeling in a camp, walking in a caravan, in a pen or left loose; or null. */
  nearestRideable(x: number, z: number, reach = CAMEL_REACH): unknown {
    if (this.ridden) return null;
    let best: Agent | null = null;
    let bd = reach;
    for (let i = 0; i < this.loose.length; i++) {
      const a = this.loose[i].a;
      const d = Math.hypot(a.x - x, a.z - z);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    for (let i = 0; i < this.live.length; i++) {
      const g = this.live[i];
      if ((g.kind !== 1 && g.kind !== 5 && g.kind !== 7) || !g.active || g.pres < 0.5 || Math.hypot(g.ax - x, g.az - z) > g.reach + 80) continue;
      for (let k = 0; k < g.agents.length; k++) {
        const a = g.agents[k];
        if (!a.animal || a.free !== 0) continue;
        const d = Math.hypot(a.x - x, a.z - z);
        if (d < bd) {
          bd = d;
          best = a;
        }
      }
    }
    return best;
  }

  /** Where the key cap goes for a camel got from nearestRideable: on its back, lower while it kneels. */
  rideMark(ref: unknown, out: { x: number; y: number; z: number }): void {
    const a = ref as Agent;
    out.x = a.x;
    out.y = a.y + (CAMEL_BACK - CAMEL_KNEEL * ss(0, 1, a.sit)) * a.scale;
    out.z = a.z;
  }

  /** Climb on a camel got from nearestRideable. It is taken out of its party; its load comes off and stays off. */
  mount(ref: unknown): boolean {
    const a = ref as Agent | null;
    if (!a?.animal || this.ridden) return false;
    let m: Mount | null = null;
    const li = this.loose.findIndex((l) => l.a === a);
    if (li >= 0) m = this.loose.splice(li, 1)[0];
    else {
      for (let i = 0; i < this.live.length && !m; i++) {
        const g = this.live[i];
        if (!g.agents.includes(a)) continue;
        m = { a, g, hx: a.x, hy: a.y, hz: a.z, hnx: a.nx, hny: a.ny, hnz: a.nz, hyaw: a.yaw, hsit: a.sit, t: 0, dodge: 1 };
      }
    }
    if (!m) return false;
    this.ridden = m;
    a.free = 1;
    a.variant = 0;
    a.spd = 0;
    a.sitTarget = 0;
    a.shown = 1;
    this.turnRate = 0;
    return true;
  }

  /** Get off: the camel stays where it stands, calm, and goes back to its party once the player is well away. */
  dismount(): void {
    const m = this.ridden;
    if (!m) return;
    this.ridden = null;
    m.a.free = 2;
    m.a.spd = 0;
    m.t = 0;
    this.loose.push(m);
  }

  /** Where the ridden camel stands and faces, and how fast it goes (valid while mounted). back follows it up off its knees. */
  get seat(): { x: number; z: number; y: number; yaw: number; spd: number; back: number; turn: number } | null {
    const m = this.ridden;
    if (!m) return null;
    const a = m.a;
    const back = (CAMEL_BACK - CAMEL_KNEEL * ss(0, 1, a.sit)) * a.scale;
    return { x: a.x, z: a.z, y: a.y, yaw: a.yaw, spd: a.spd, back, turn: this.turnRate };
  }

  /**
   * Steer the ridden camel. (wx, wz) is the way to go in the world (length 0..1, 0 to stand); run
   * trots it on. A kneeling one gets up first. It turns slowly and wide, takes its time to speed
   * up, and goes round what is in its way.
   */
  ride(dt: number, wx: number, wz: number, run: boolean): void {
    const m = this.ridden;
    if (!m || dt <= 0) return;
    const a = m.a;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    // up off its knees in about a second, and nowhere till it is nearly standing
    if (a.sit > 0) {
      a.sit = Math.max(0, a.sit - dt);
      if (a.sit > 0.2) {
        this.turnRate += (0 - this.turnRate) * k(6);
        return;
      }
    }
    const want = Math.hypot(wx, wz);
    let targetSpd = 0;
    if (want > 0.1) {
      const err = angDiff(Math.atan2(wx, wz), a.yaw);
      const tr = CAMEL_TURN * dt;
      const step = Math.max(-tr, Math.min(tr, err));
      a.yaw += step;
      this.turnRate += (step / dt - this.turnRate) * k(6);
      // (easing off into a turn, and only ambling round one it is far from making)
      targetSpd = (run ? CAMEL_RUN : CAMEL_WALK) * Math.min(1, want) * (Math.abs(err) < 1.2 ? 1 - 0.3 * (Math.abs(err) / 1.2) : 0.3);
    } else this.turnRate += (0 - this.turnRate) * k(6);
    a.spd += (targetSpd - a.spd) * k(targetSpd > a.spd ? 1.2 : 2.5);
    if (a.spd < 0.02) a.spd = 0;
    a.ph += (a.spd * dt) / (a.spd > CAMEL_WALK * 1.4 ? CAMEL_RUN_STRIDE : a.stride);
    if (a.spd === 0) return;
    // too steep a face and it will not climb; a stone or a wall and it goes round
    const mx = Math.sin(a.yaw) * a.spd * dt;
    const mz = Math.cos(a.yaw) * a.spd * dt;
    let nx = a.x + mx;
    let nz = a.z + mz;
    if (this.solid && steer(this.solid, a.x, a.z, a.y, mx, mz, CAMEL_BODY, m.dodge)) {
      m.dodge = steered.side;
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

  /**
   * Whether a camp's things stand at (x, z): a lean-to, the fire, the gear piled by it, or a camel.
   * None of them stops the wanderer, but nobody steps down off a camel into them.
   */
  crowded(x: number, z: number): boolean {
    for (let i = 0; i < this.live.length; i++) {
      const g = this.live[i];
      if (!g.active || Math.hypot(g.ax - x, g.az - z) > g.reach + 80) continue;
      for (let k = 0; k < g.props.length; k++) {
        const p = g.props[k];
        const r = p.type === 5 ? 1.7 : p.type === 4 || p.type === 10 ? 1.0 : p.type === 1 || p.type === 2 || p.type === 9 ? 0.7 : 0;
        if (r > 0 && Math.hypot(p.x - x, p.z - z) < r * p.scale) return true;
      }
    }
    return this.beastAt(x, z);
  }

  /** A camel stands at (x, z): one in a party, a pen, or left loose. The ridden one is not counted. */
  beastAt(x: number, z: number): boolean {
    for (let i = 0; i < this.live.length; i++) {
      const g = this.live[i];
      if (!g.active || Math.hypot(g.ax - x, g.az - z) > g.reach + 80) continue;
      for (let k = 0; k < g.agents.length; k++) {
        const a = g.agents[k];
        if (a.animal && a.free === 0 && this.under(a, x, z)) return true;
      }
    }
    for (let i = 0; i < this.loose.length; i++) if (this.under(this.loose[i].a, x, z)) return true;
    return false;
  }

  /** (x, z) is under a camel's body: in its own frame, a box as long as it is and half that wide either side. */
  private under(a: Agent, x: number, z: number): boolean {
    const dx = x - a.x;
    const dz = z - a.z;
    const c = Math.cos(a.yaw);
    const s = Math.sin(a.yaw);
    return Math.abs(dx * s + dz * c) < 1.7 * a.scale && Math.abs(dx * c - dz * s) < 0.7 * a.scale;
  }

  /**
   * The ridden camel and the loose ones, drawn before everyone else (so they always get a slot).
   * A loose one stands where it was left, in time kneels, and quietly goes back to its party once
   * the player is far from it (and from the party, unless it is out of sight altogether).
   */
  private stepMounts(dt: number, px: number, pz: number): void {
    const r = this.ridden;
    if (r) this.putMount(r, dt, px, pz);
    for (let i = this.loose.length - 1; i >= 0; i--) {
      const m = this.loose[i];
      const a = m.a;
      const d = Math.hypot(a.x - px, a.z - pz);
      // (one got off inside its own pen is simply back among the others)
      const home = m.g.pen !== undefined && this.inOwnPen(a, m.g.pen);
      if (home || d > RANGE || (d > FADE0 && Math.hypot(m.g.ax - px, m.g.az - pz) > FADE0)) {
        this.rejoin(m, home);
        this.loose[i] = this.loose[this.loose.length - 1];
        this.loose.pop();
        continue;
      }
      m.t += dt;
      a.sitTarget = m.t > CAMEL_WAIT ? 1 : 0;
      a.sit += Math.max(-dt * 0.7, Math.min(dt * 0.7, a.sitTarget - a.sit));
      this.putMount(m, dt, px, pz);
    }
  }

  private putMount(m: Mount, dt: number, px: number, pz: number): void {
    const a = m.a;
    const w = this.world;
    // up on whatever low thing it walked onto, a step or a pen's platform; else the ground
    const h = w.height(a.x, a.z);
    const top = this.solid ? this.solid(a.x, a.z, a.y + CREATURE_STEP) : -Infinity;
    a.y = top > h && top <= a.y + CREATURE_STEP ? top : h;
    w.normal(a.x, a.z, this.nrm);
    // only partly tipped to the slope, so the rider's seat stays over the feet
    const tilt = 0.35;
    this.put(a, a.x, a.y, a.z, this.nrm.x * tilt, this.nrm.y * tilt + (1 - tilt), this.nrm.z * tilt, m.g, dt, px, pz);
  }

  /**
   * A loose camel back to its party: to its place in camp, or wherever the party's schedule has it
   * now, fading in. One from a pen goes back to somewhere free in it, or (inPlace) is already there.
   */
  private rejoin(m: Mount, inPlace = false): void {
    const a = m.a;
    a.free = 0;
    a.spd = 0;
    if (m.g.pen) {
      this.rejoinPen(m, inPlace);
      return;
    }
    a.shown = 0;
    a.look = 0;
    if (m.g.kind === 1) {
      a.x = m.hx;
      a.y = m.hy;
      a.z = m.hz;
      a.nx = m.hnx;
      a.ny = m.hny;
      a.nz = m.hnz;
      a.yaw = m.hyaw;
      a.sit = a.sitTarget = m.hsit;
    } else a.gx = NaN; // the ground is sampled again where the party has it
  }

  // ---------------------------------------------------------------- generation

  private levelAt(x: number, z: number): boolean {
    const w = this.world;
    const s = w.sample(x, z, this.sample);
    if (s.rock > 0.15 || s.salt > 0.5) return false;
    const h0 = s.h;
    for (let i = 0; i < 4; i++) {
      const a = i * (Math.PI / 2);
      if (Math.abs(w.height(x + Math.sin(a) * 14, z + Math.cos(a) * 14) - h0) > 1.6) return false;
    }
    return true;
  }

  private routeClear(r: Route): boolean {
    const p = this.P0;
    // Finely near the start: the cliffs and terrace walls around a city are narrow.
    for (let s = 0; s <= r.len; s += s < 900 ? 15 : 60) {
      routePoint(r, s, p);
      if (this.world.sample(p.x, p.z, this.sample).rock > 0.5) return false;
    }
    return true;
  }

  private makeRoute(rng: () => number, cx: number, cz: number, bearing: number, start: number, len: number, amp: number): Route {
    const dx = Math.cos(bearing);
    const dz = Math.sin(bearing);
    return {
      ax: cx + dx * start,
      az: cz + dz * start,
      dx,
      dz,
      px: -dz,
      pz: dx,
      len,
      a1: amp * (0.6 + rng() * 0.4),
      k1: TAU / (350 + rng() * 300),
      p1: rng() * TAU,
      a2: amp * 0.35 * rng(),
      k2: TAU / (130 + rng() * 100),
      p2: rng() * TAU,
    };
  }

  private build(site: CitySite): Group[] {
    const groups: Group[] = [];
    const rng = mulberry32((this.world.seed ^ Math.imul(site.id | 0, 0x9e3779b1) ^ 0x51ed270b) >>> 0);
    // (the caravans themselves walk the routes between cities: see buildRoute)

    // resting camp
    // (two, on different sides: the first close in, the second further out)
    const base = rng() * TAU;
    for (let c = 0; c < 2; c++) {
      for (let k = 0; k < 10; k++) {
        const a = base + c * 3.1 + k * 0.62;
        const d = site.radius + 300 + c * 500 + rng() * 600;
        const x = site.cx + Math.cos(a) * d;
        const z = site.cz + Math.sin(a) * d;
        if (this.levelAt(x, z)) {
          const g = this.buildCamp(rng, x, z);
          if (c > 0) g.rank = 0.1 + 0.6 * rng();
          groups.push(g);
          break;
        }
      }
    }

    // lone walkers and pairs
    const nW = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < nW; k++) {
      for (let t = 0; t < 6; t++) {
        const d = site.radius + 80 + rng() * Math.max(150, 1500 - site.radius - 80);
        const ang = rng() * TAU;
        const x = site.cx + Math.cos(ang) * d;
        const z = site.cz + Math.sin(ang) * d;
        const r = this.makeRoute(rng, x, z, rng() * TAU, 0, 250 + rng() * 350, 18);
        if (!this.routeClear(r)) continue;
        const g: Group = this.emptyGroup(2, r.ax, r.az, 400);
        g.route = r;
        const n = rng() < 0.4 ? 2 : 1;
        const dir = rng() < 0.5 ? 1 : -1;
        for (let i = 0; i < n; i++) {
          const a = newAgent(false, rng);
          a.o = i * 1.2;
          a.lat = i === 0 ? 0 : 1.1;
          a.dirSign = dir;
          a.s = rng() * r.len;
          g.agents.push(a);
        }
        groups.push(g);
        break;
      }
    }
    return groups;
  }

  private emptyGroup(kind: number, ax: number, az: number, reach: number): Group {
    return { kind, s: 0, dir: 1, v: 1, wait: 0, agents: [], route: null, ax, az, reach, pres: 0, active: false, maxO: 0, props: [], fx: 0, fy: 0, fz: 0, fseed: 0, delay: 0, rank: 0 };
  }

  private buildCamp(rng: () => number, x: number, z: number): Group {
    const w = this.world;
    const g = this.emptyGroup(1, x, z, 0);
    g.fx = x;
    g.fz = z;
    g.fy = w.height(x, z);
    g.fseed = rng();
    const place = (a: Agent, px: number, pz: number) => {
      a.x = px;
      a.z = pz;
      a.y = w.height(px, pz);
      w.normal(px, pz, this.nrm);
      a.nx = this.nrm.x;
      a.ny = this.nrm.y;
      a.nz = this.nrm.z;
    };
    const prop = (type: number, px: number, pz: number, yaw: number, scale: number, col: V3, dy = 0) => {
      g.props.push({ type, x: px, y: w.height(px, pz) + dy, z: pz, yaw, scale, col });
    };
    g.props.push({ type: 4, x, y: g.fy, z, yaw: rng() * TAU, scale: 1, col: [1, 1, 1] });
    const na = 3 + Math.floor(rng() * 3);
    const a0 = rng() * TAU;
    for (let i = 0; i < na; i++) {
      const phi = a0 + (i / na) * TAU + (rng() - 0.5) * 0.5;
      const r = 6 + rng() * 3;
      const a = newAgent(true, rng);
      place(a, x + Math.sin(phi) * r, z + Math.cos(phi) * r);
      a.yaw = phi + (rng() < 0.5 ? 1 : -1) * (Math.PI / 2) + (rng() - 0.5) * 0.6;
      a.sit = 1;
      a.sitTarget = 1;
      g.agents.push(a);
      const pr = r + 2.6;
      const pa = phi + (rng() - 0.5) * 0.4;
      const col = LOADS[Math.floor(rng() * LOADS.length)];
      prop(rng() < 0.55 ? 1 : 2, x + Math.sin(pa) * pr, z + Math.cos(pa) * pr, rng() * TAU, 1, col);
      if (rng() < 0.6) prop(1, x + Math.sin(pa + 0.15) * (pr + 0.5), z + Math.cos(pa + 0.15) * (pr + 0.5), rng() * TAU, 0.8, LOADS[Math.floor(rng() * LOADS.length)]);
    }
    const nPeople = 2 + Math.floor(rng() * 3);
    const b0 = rng() * TAU;
    for (let i = 0; i < nPeople; i++) {
      const phi = b0 + (i / nPeople) * TAU + (rng() - 0.5) * 0.4;
      const r = 2.4 + rng() * 1.0;
      const a = newAgent(false, rng);
      place(a, x + Math.sin(phi) * r, z + Math.cos(phi) * r);
      a.yaw = phi + Math.PI + (rng() - 0.5) * 0.5;
      const sit = rng() < 0.7;
      a.sit = sit ? 1 : 0;
      a.sitTarget = a.sit;
      a.variant &= 3;
      g.agents.push(a);
      if (sit && i < 2) prop(6, a.x, a.z, a.yaw, 1, LOADS[Math.floor(rng() * LOADS.length)], 0.01);
    }
    for (let i = 0; i < 2; i++) {
      const pa = rng() * TAU;
      prop(3, x + Math.sin(pa) * 1.9, z + Math.cos(pa) * 1.9, 0, 1, [0.62, 0.38, 0.26]);
    }
    if (rng() < 0.55) {
      const pa = rng() * TAU;
      prop(5, x + Math.sin(pa) * 5, z + Math.cos(pa) * 5, pa + Math.PI, 1, LOADS[Math.floor(rng() * LOADS.length)]);
    }
    return g;
  }

  // ---------------------------------------------------------------- routes between cities

  /** A fire of the wanderer's own, beside a laid bedroll: where its flames stand, or null for none. */
  hearth: { x: number; y: number; z: number } | null = null;

  /** How loud the nearest camp fires are at (px, pz), 0..1 (the fire ambience, as a city's fires make it). */
  fireLevel(px: number, pz: number): number {
    let v = 0;
    if (this.hearth) {
      const d = Math.hypot(this.hearth.x - px, this.hearth.z - pz);
      if (d < 25) v = 0.5 * (1 - d / 25);
    }
    for (let i = 0; i < this.live.length; i++) {
      const g = this.live[i];
      if (g.kind !== 1 || !g.active) continue;
      const d = Math.hypot(g.fx - px, g.fz - pz);
      if (d < 25) v = Math.hypot(v, 0.7 * (1 - d / 25) * g.pres);
    }
    return Math.min(1, v);
  }

  /** A route's camps (each a fire with seats, sometimes someone tending it) and the parties walking it. */
  private buildRoute(r: TravelRoute): Group[] {
    const rng = mulberry32((this.world.seed ^ Math.imul(r.a.id | 0, 0x2c1b3c6d) ^ Math.imul(r.b.id | 0, 0x297a2d39) ^ 0x3c6ef372) >>> 0);
    const groups: Group[] = [];
    const spots: CampSpots[] = [];
    for (const c of this.net.camps(r)) {
      const sp = this.buildRouteCamp(r, c);
      spots.push(sp.spots);
      groups.push(sp.group);
    }
    const gA = routeSAtU(r, r.gateA);
    const gB = routeSAtU(r, r.gateB);
    if (gB - gA < 200) return groups;
    // A steady stream: about one party per 520 m of road, each way round in turn. One per 800 m
    // are always out, spread evenly through the order; the tier thins the rest, and since their
    // places in the order alternate with the others, what is left stays evenly spaced.
    const n0 = Math.min(10, Math.max(5, Math.round((gB - gA) / 800)));
    const n = Math.min(16, Math.max(7, Math.round((gB - gA) / 520)));
    for (let i = 0; i < n; i++) {
      const g = this.buildParty(rng, r, spots, gA, gB, i, n);
      const always = Math.floor(((i + 1) * n0) / n) > Math.floor((i * n0) / n);
      g.rank = always ? 0 : 0.2 + 0.8 * rng();
      groups.push(g);
    }
    // the people round the camps and off the road: separate numbers, so the parties stay as they are
    const xr = mulberry32((this.world.seed ^ Math.imul(r.a.id | 0, 0x45d9f3b) ^ Math.imul(r.b.id | 0, 0x119de1f3) ^ 0x6a09e667) >>> 0);
    for (const sp of spots) {
      if (xr() < 0.65) {
        const c = sp.camp;
        // out away from the path to gather brush, crouching at the far end of the way
        const away = Math.atan2(c.side * -r.dz, c.side * r.dx) + (xr() - 0.5) * 1.4;
        const fg = this.forager(xr, c.x, c.z, away, 35 + xr() * 55);
        if (fg) groups.push(fg);
      }
    }
    if (xr() < 0.55) {
      // A trader resting with their beasts and goods laid out, off the road between the camps.
      // Rare: about every other route, and only on level open sand.
      for (let t = 0; t < 8; t++) {
        const u = r.gateA + (r.gateB - r.gateA) * (0.15 + 0.7 * xr());
        let near = false;
        for (const sp of spots) if (Math.abs(sp.camp.u - u) < 260) near = true;
        if (near) continue;
        const side = xr() < 0.5 ? -1 : 1;
        routePos(r, u, side * (30 + xr() * 10), this.P0);
        const x = this.P0.x;
        const z = this.P0.z;
        if (!this.levelAt(x, z)) continue;
        const g = this.buildCamp(xr, x, z);
        // the goods face the road, so passers by can see what is on offer
        this.addGoods(g, xr, x, z, Math.atan2(-side * -r.dz, -side * r.dx));
        g.rank = 0.15 + 0.85 * xr();
        groups.push(g);
        break;
      }
    }
    return groups;
  }

  /**
   * A trader's wares, laid out on a rug by the fire on the side of `face` (a bearing, as sin, cos):
   * jars, bales and rolled cloth, a low table, and an awning behind.
   */
  private addGoods(g: Group, rng: () => number, x: number, z: number, face: number): void {
    const w = this.world;
    const put = (type: number, a: number, rad: number, yaw: number, scale: number, col: V3, dy = 0) => {
      const px = x + Math.sin(a) * rad;
      const pz = z + Math.cos(a) * rad;
      g.props.push({ type, x: px, y: w.height(px, pz) + dy, z: pz, yaw, scale, col });
    };
    put(6, face, 4.6, face + Math.PI / 2, 1.25, LOADS[Math.floor(rng() * LOADS.length)], 0.01);
    put(6, face + 0.42, 4.9, face + Math.PI / 2 + 0.2, 1.0, LOADS[Math.floor(rng() * LOADS.length)], 0.012);
    for (let k = 0; k < 4; k++) put(3, face - 0.22 + k * 0.15, 4.4 + (k % 2) * 0.6, 0, 0.8 + rng() * 0.35, [0.62, 0.38, 0.26], 0.02);
    for (let k = 0; k < 2; k++) put(1, face + 0.35 + k * 0.2, 5.2, face + rng() * 0.6, 0.85, LOADS[Math.floor(rng() * LOADS.length)], 0.02);
    put(2, face - 0.5, 5.3, face + Math.PI / 2, 0.9, LOADS[Math.floor(rng() * LOADS.length)], 0.02);
    put(9, face + 0.75, 4.0, face, 1, [0.46, 0.34, 0.23]);
    put(5, face + Math.PI, 6.2, face, 1.1, LOADS[Math.floor(rng() * LOADS.length)]);
  }

  /**
   * Someone walking a short way out from (x, z) toward the bearing `away` (as sin, cos) and back,
   * crouching a while at each end: a forager gathering brush, or (with a jar) a water carrier.
   */
  private forager(rng: () => number, x: number, z: number, away: number, len: number, jar = false): Group | null {
    // makeRoute takes its bearing as (cos, sin)
    const r = this.makeRoute(rng, x, z, Math.atan2(Math.cos(away), Math.sin(away)), 4, len, jar ? 2 : 6);
    if (!this.routeClear(r)) return null;
    const g = this.emptyGroup(2, r.ax, r.az, len + 20);
    g.route = r;
    const a = newAgent(false, rng);
    a.variant = jar ? 16 : rng() < 0.5 ? 4 : 2;
    a.pause = jar ? 5 + rng() * 4 : 7 + rng() * 9;
    a.vmax = jar ? 1.05 : 1.15;
    a.s = rng() * r.len;
    a.dirSign = rng() < 0.5 ? 1 : -1;
    g.agents.push(a);
    g.rank = 0.2 + 0.8 * rng();
    return g;
  }

  /** Life round an oasis: a camp a little way out, people fetching water from it, someone gathering. */
  private buildOasis(l: Landmark): Group[] {
    const rng = mulberry32((this.world.seed ^ Math.imul(l.key | 0, 0x45d9f3b) ^ 0x0a515c) >>> 0);
    const groups: Group[] = [];
    // level ground out past the palms and stones round the pool
    const a0 = rng() * TAU;
    let cx = NaN;
    let cz = NaN;
    for (let k = 0; k < 10 && Number.isNaN(cx); k++) {
      const a = a0 + k * 0.63;
      const d = 55 + rng() * 25;
      const x = l.x + Math.sin(a) * d;
      const z = l.z + Math.cos(a) * d;
      if (!this.levelAt(x, z)) continue;
      if (this.solid && blockedAt(this.solid, x, z, this.world.height(x, z))) continue;
      cx = x;
      cz = z;
    }
    if (Number.isNaN(cx)) return groups;
    const camp = this.buildCamp(rng, cx, cz);
    const toWater = Math.atan2(l.x - cx, l.z - cz);
    // traders often stop over at water with their goods out
    if (rng() < 0.45) this.addGoods(camp, rng, cx, cz, toWater + Math.PI / 2);
    camp.rank = 0.1 + 0.6 * rng();
    groups.push(camp);
    const dist = Math.hypot(l.x - cx, l.z - cz);
    // the pool reaches at most about 24 m out from the middle: stop at its edge to fill the jar
    const nCarry = rng() < 0.6 ? 2 : 1;
    for (let i = 0; i < nCarry; i++) {
      const g = this.forager(rng, cx, cz, toWater + (rng() - 0.5) * 0.35, Math.max(8, dist - 30 + rng() * 3), true);
      if (g) groups.push(g);
    }
    if (rng() < 0.6) {
      const g = this.forager(rng, cx, cz, toWater + Math.PI + (rng() - 0.5) * 1.6, 40 + rng() * 50);
      if (g) groups.push(g);
    }
    return groups;
  }

  /** The camp of a grid cell, if it has one: the first level, open spot near its anchor. Decided by the cell alone. */
  private buildWildCamp(cx: number, cz: number, cell: number, chance: number, early: boolean): Group | null {
    const s = this.world.seed | 0;
    if (!wildWanted(cx, cz, chance, hash4, s)) return null;
    const an = wildAnchor(cx, cz, cell, hash4, s);
    for (const [ox, oz] of WILD_TRIES) {
      const x = an.x + ox;
      const z = an.z + oz;
      if (!this.levelAt(x, z)) continue;
      const sites = this.cities.near(x, z);
      let ok = true;
      for (let i = 0; i < sites.length && ok; i++) if (Math.hypot(sites[i].cx - x, sites[i].cz - z) < sites[i].radius + CITY_CLEAR) ok = false;
      for (let i = 0; i < this.marks.length && ok; i++) if (Math.hypot(this.marks[i].x - x, this.marks[i].z - z) < 120) ok = false;
      if (ok && this.solid && blockedAt(this.solid, x, z, this.world.height(x, z))) ok = false;
      if (!ok) continue;
      const g = this.buildCamp(mulberry32(Math.floor(hash4(cx, cz, s, early ? 84 : 83) * 4294967296)), x, z);
      // the everyday ones thin out on a lesser tier; the early ones stay, they are the way to the first board
      g.rank = early ? 0 : 0.1 + 0.8 * hash4(cx, cz, s, 85);
      return g;
    }
    return null;
  }

  /** Puts the camps of the cells round (px, pz) on the live list, building any not met before. */
  private wildNear(px: number, pz: number, cell: number, chance: number, early: boolean, cells: Map<number, Group | null>, reach: number): void {
    const span = Math.ceil(reach / cell);
    const pcx = Math.floor(px / cell);
    const pcz = Math.floor(pz / cell);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (Math.hypot((cx + 0.5) * cell - px, (cz + 0.5) * cell - pz) > reach + cell * 0.5) continue;
        const key = (cx + 32768) * 65536 + (cz + 32768);
        let g = cells.get(key);
        if (g === undefined) {
          g = this.buildWildCamp(cx, cz, cell, chance, early);
          cells.set(key, g);
        }
        if (g && Math.hypot(g.ax - px, g.az - pz) <= reach + 200) this.live.push(g);
      }
    }
    if (cells.size > 300) {
      for (const [key, g] of cells) {
        const cx = Math.floor(key / 65536) - 32768;
        const cz = (key % 65536) - 32768;
        if (Math.hypot((cx + 0.5) * cell - px, (cz + 0.5) * cell - pz) > RANGE * 3 && !(g && g.active)) cells.delete(key);
      }
    }
  }

  /** The shepherd who keeps to a cell, if anyone does: decided by the cell alone. */
  private buildShepherd(cx: number, cz: number, key: number): Group | null {
    const s = this.world.seed | 0;
    if (hash4(cx, cz, s, 71) > 0.32) return null;
    const x = (cx + 0.2 + 0.6 * hash4(cx, cz, s, 72)) * SHEP_CELL;
    const z = (cz + 0.2 + 0.6 * hash4(cx, cz, s, 73)) * SHEP_CELL;
    const sm = this.world.sample(x, z, this.sample);
    if (sm.rock > 0.25 || sm.salt > 0.4) return null;
    if (((this.world as Partial<{ river(x: number, z: number): number }>).river?.(x, z) ?? Infinity) < 60) return null;
    // out in the open: well clear of any city, and of the built places
    const sites = this.cities.near(x, z);
    for (let i = 0; i < sites.length; i++) if (Math.hypot(sites[i].cx - x, sites[i].cz - z) < sites[i].radius + 450) return null;
    for (let i = 0; i < this.marks.length; i++) if (Math.hypot(this.marks[i].x - x, this.marks[i].z - z) < 160) return null;
    const rng = mulberry32(Math.floor(hash4(cx, cz, s, 74) * 4294967296));
    const g = this.emptyGroup(6, x, z, 30);
    g.rank = hash4(cx, cz, s, 75);
    const lead = newAgent(false, rng);
    lead.variant = rng() < 0.5 ? 1 : 5; // a crook, and sometimes a bag
    lead.vmax = 0.75 + rng() * 0.1;
    g.agents.push(lead);
    if (rng() < 0.4) {
      // a child out with them, or a second herder
      const b = newAgent(false, rng);
      b.variant = 0;
      if (rng() < 0.6) b.scale *= 0.74;
      g.agents.push(b);
    }
    const a0 = rng() * TAU;
    for (let i = 0; i < g.agents.length; i++) {
      const a = g.agents[i];
      a.x = x + Math.sin(a0) * 1.6 * i;
      a.z = z + Math.cos(a0) * 1.6 * i;
      a.y = this.world.height(a.x, a.z);
      a.yaw = rng() * TAU;
    }
    g.shep = { herder: { key, x, z, on: false, rest: false, seed: rng() }, hx: x, hz: z, tx: x, tz: z, t: rng() * 10, walking: false, dodge: rng() < 0.5 ? 1 : -1 };
    return g;
  }

  /** Puts the shepherds of the cells round (px, pz) on the live list, building any not met before. */
  private shepherdsNear(px: number, pz: number): void {
    const span = Math.ceil(RANGE / SHEP_CELL);
    const pcx = Math.floor(px / SHEP_CELL);
    const pcz = Math.floor(pz / SHEP_CELL);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (Math.hypot((cx + 0.5) * SHEP_CELL - px, (cz + 0.5) * SHEP_CELL - pz) > RANGE + SHEP_CELL * 0.75) continue;
        const key = (cx + 32768) * 65536 + (cz + 32768);
        let g = this.shepCells.get(key);
        if (g === undefined) {
          g = this.buildShepherd(cx, cz, key);
          this.shepCells.set(key, g);
        }
        if (g) this.live.push(g);
      }
    }
    // forget the cells left far behind (they are worked out the same again on the way back)
    if (this.shepCells.size > 300) {
      for (const [key, g] of this.shepCells) {
        const cx = Math.floor(key / 65536) - 32768;
        const cz = (key % 65536) - 32768;
        if (Math.hypot((cx + 0.5) * SHEP_CELL - px, (cz + 0.5) * SHEP_CELL - pz) > RANGE * 3 && !(g && g.active)) this.shepCells.delete(key);
      }
    }
  }

  private buildRouteCamp(r: TravelRoute, c: RouteCamp): { group: Group; spots: CampSpots } {
    const w = this.world;
    const rng = mulberry32((Math.floor(c.seed * 4294967296) ^ 0x5bd1e995) >>> 0);
    const x = c.x;
    const z = c.z;
    const g = this.emptyGroup(1, x, z, 0);
    g.fx = x;
    g.fz = z;
    g.fy = c.y;
    g.fseed = rng();
    const prop = (type: number, a: number, rad: number, yaw: number, scale: number, col: V3, dy = 0) => {
      const px = x + Math.sin(a) * rad;
      const pz = z + Math.cos(a) * rad;
      g.props.push({ type, x: px, y: w.height(px, pz) + dy, z: pz, yaw, scale, col });
    };
    // bearings round the fire as (sin a, cos a): toward the path, and away from it
    const toPath = Math.atan2(-c.side * -r.dz, -c.side * r.dx);
    const away = toPath + Math.PI;
    g.props.push({ type: 4, x, y: c.y, z, yaw: rng() * TAU, scale: 1, col: [1, 1, 1] });
    if (rng() < 0.55) g.props.push({ type: 10, x, y: c.y, z, yaw: rng() * TAU, scale: 1, col: [1, 1, 1] });
    const wood: V3 = [0.46 + rng() * 0.08, 0.34 + rng() * 0.05, 0.23 + rng() * 0.04];
    // two to four seats round the fire, leaving the side toward the path open
    const nSeats = 2 + Math.floor(rng() * 3);
    const seats: { x: number; z: number; yaw: number }[] = [];
    const used: number[] = [];
    for (let i = 0; i < nSeats; i++) {
      const a = toPath + 1.0 + ((i + 0.5) / nSeats) * (TAU - 2.0) + (rng() - 0.5) * 0.25;
      used.push(a);
      const kind = rng();
      if (kind < 0.45) prop(7, a, 3.0, a, 1, wood);
      else if (kind < 0.7) prop(8, a, 3.05, a, 1, wood);
      else prop(6, a, 2.55, a, 0.8, LOADS[Math.floor(rng() * LOADS.length)], 0.01);
      const rr = kind < 0.7 ? 2.35 : 2.55;
      seats.push({ x: x + Math.sin(a) * rr, z: z + Math.cos(a) * rr, yaw: a + Math.PI });
    }
    // standing places in the gaps between the seats
    const stand: { x: number; z: number; yaw: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const a = toPath + 0.55 + (i / 6) * (TAU - 1.1) + 0.3;
      if (used.some((u) => Math.abs(Math.atan2(Math.sin(u - a), Math.cos(u - a))) < 0.45)) continue;
      const rr = 2.7 + rng() * 0.6;
      stand.push({ x: x + Math.sin(a) * rr, z: z + Math.cos(a) * rr, yaw: a + Math.PI });
    }
    if (stand.length === 0) stand.push({ x: x + Math.sin(toPath) * 3, z: z + Math.cos(toPath) * 3, yaw: toPath + Math.PI });
    // a lean-to across the far side, the gear and water jars by it, a low table
    if (rng() < 0.6) {
      prop(5, away + (rng() - 0.5) * 0.4, 6.4, away + Math.PI, 1, LOADS[Math.floor(rng() * LOADS.length)]);
      for (let k = 0; k < 2; k++) prop(rng() < 0.5 ? 1 : 2, away + (k ? 0.5 : -0.5), 7.2, rng() * TAU, 0.9, LOADS[Math.floor(rng() * LOADS.length)]);
    } else {
      prop(1, away + 0.3, 5.0, rng() * TAU, 1, LOADS[Math.floor(rng() * LOADS.length)]);
    }
    if (rng() < 0.45) {
      const a = toPath + 0.6 * (rng() < 0.5 ? -1 : 1);
      prop(9, a, 4.4, a + Math.PI / 2, 1, wood);
      prop(3, a, 4.4, 0, 0.55, [0.62, 0.38, 0.26], 0.48);
    }
    for (let k = 0; k < 1 + Math.floor(rng() * 2); k++) prop(3, rng() * TAU, 1.9, 0, 1, [0.62, 0.38, 0.26]);
    // where pack animals kneel: off on the far side, either side of the lean-to
    const pens: { x: number; z: number; yaw: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const a = away + (i % 2 ? 1 : -1) * (0.75 + 0.32 * Math.floor(i / 2));
      const rr = 8.5 + rng() * 1.5;
      pens.push({ x: x + Math.sin(a) * rr, z: z + Math.cos(a) * rr, yaw: a + (rng() < 0.5 ? 1 : -1) * (Math.PI / 2) + (rng() - 0.5) * 0.5 });
    }
    // someone keeps the fire at about half the camps, a beast hobbled nearby
    const resident = rng() < 0.5;
    if (resident) {
      const a = newAgent(false, rng);
      const st = seats[0];
      a.x = st.x;
      a.z = st.z;
      a.y = w.height(st.x, st.z);
      w.normal(st.x, st.z, this.nrm);
      a.nx = this.nrm.x;
      a.ny = this.nrm.y;
      a.nz = this.nrm.z;
      a.yaw = st.yaw;
      a.sit = a.sitTarget = 1;
      a.variant &= 3;
      g.agents.push(a);
      if (rng() < 0.5) {
        const b = newAgent(true, rng);
        const pn = pens[5];
        b.x = pn.x;
        b.z = pn.z;
        b.y = w.height(pn.x, pn.z);
        b.yaw = pn.yaw;
        b.sit = b.sitTarget = 1;
        g.agents.push(b);
      }
    }
    return { group: g, spots: { camp: c, seats, resident, stand, pens } };
  }

  /** One party on a route: a caravan of pack animals, a few travellers, or pilgrims. */
  private buildParty(rng: () => number, r: TravelRoute, camps: CampSpots[], gA: number, gB: number, index: number, count: number): Group {
    const g = this.emptyGroup(5, r.ax, r.az, 60);
    const roll = rng();
    let v: number;
    if (roll < 0.4) {
      // a caravan: a string of pack animals with people walking beside them
      const na = 2 + Math.floor(rng() * 4);
      const np = 2 + Math.floor(rng() * 2);
      const spacing = 5.4 + rng() * 0.8;
      const tail = 7 + (na - 1) * spacing;
      for (let i = 0; i < na; i++) {
        const a = newAgent(true, rng);
        a.o = 7 + i * spacing;
        a.lat = (rng() - 0.5) * 0.4;
        g.agents.push(a);
      }
      for (let i = 0; i < np; i++) {
        const a = newAgent(false, rng);
        if (i === 0) {
          a.o = 0;
          a.lat = 0.5;
        } else if (i === np - 1) {
          a.o = tail + 3;
          a.lat = -0.4;
        } else {
          a.o = 5 + rng() * (tail - 5);
          a.lat = (i % 2 ? 1 : -1) * (1.5 + rng() * 0.4);
        }
        g.agents.push(a);
      }
      v = 1.15 + rng() * 0.1;
    } else if (roll < 0.78) {
      // travellers on foot, in ones and twos
      const n = 1 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        const a = newAgent(false, rng);
        a.o = Math.floor(i / 2) * 1.6 + rng() * 0.3;
        a.lat = n === 1 ? 0 : (i % 2 ? -0.5 : 0.5);
        g.agents.push(a);
      }
      v = 1.2 + rng() * 0.15;
    } else {
      // pilgrims, walking slowly side by side
      const n = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < n; k++) {
        const a = newAgent(false, rng);
        a.role = ROLE_PILGRIM;
        const c = PILGRIM_ROBES[Math.floor(rng() * PILGRIM_ROBES.length)];
        const j = 0.94 + rng() * 0.1;
        a.coat = [c[0] * j, c[1] * j, c[2] * j];
        a.load = KEEPER_ROBES[Math.floor(rng() * KEEPER_ROBES.length)];
        a.variant = PILGRIM_LOADS[Math.floor(rng() * PILGRIM_LOADS.length)];
        a.lat = (k - (n - 1) / 2) * 1.05;
        a.o = rng() * 0.4;
        g.agents.push(a);
      }
      v = 0.9 + rng() * 0.2;
    }
    for (const a of g.agents) g.maxO = Math.max(g.maxO, a.o);
    g.v = v;
    g.reach = g.maxO + 60;
    g.fseed = rng();

    // the round trip: out to B, resting at a camp or two on the way, a while in town, and back
    const legs: Leg[] = [];
    let t = 0;
    const order = camps.map((_, k) => k).sort((p, q) => camps[p].camp.s - camps[q].camp.s);
    const leg = (dir: number, from: number, to: number) => {
      const stops = (dir > 0 ? order : [...order].reverse()).filter(() => rng() < 0.55);
      if (stops.length === 0 && order.length > 0) stops.push(order[Math.floor(rng() * order.length)]);
      stops.sort((p, q) => (camps[p].camp.s - camps[q].camp.s) * dir);
      let s = from;
      for (const k of stops) {
        const cs = camps[k].camp.s;
        legs.push({ t0: t, t1: (t += Math.abs(cs - s) / v), s0: s, s1: cs, dir, camp: -1 });
        legs.push({ t0: t, t1: (t += 150 + rng() * 210), s0: cs, s1: cs, dir, camp: k });
        s = cs;
      }
      legs.push({ t0: t, t1: (t += Math.abs(to - s) / v), s0: s, s1: to, dir, camp: -1 });
      legs.push({ t0: t, t1: (t += 60 + rng() * 150), s0: to, s1: to, dir, camp: -2 });
    };
    leg(1, gA - 30, gB + 30 + g.maxO);
    leg(-1, gB + 30, gA - 30 - g.maxO);
    g.trip = { route: r, camps, legs, period: t, phase: ((index + 0.15 + 0.7 * rng()) / count) * t, gA, gB, index };
    return g;
  }

  /** Ground height under someone walking at (x, z), sampled again only once they have moved a little. */
  private groundAt(a: Agent, x: number, z: number, d: number): number {
    const thr = d < 150 ? 0.35 : d < 700 ? 1.2 : 3;
    if (!(Math.abs(x - a.gx) < thr && Math.abs(z - a.gz) < thr)) {
      const w = this.world;
      a.gx = x;
      a.gz = z;
      a.gy = w.height(x, z);
      if (d < 600) {
        w.normal(x, z, this.nrm);
        a.gnx = this.nrm.x;
        a.gny = this.nrm.y;
        a.gnz = this.nrm.z;
      } else {
        a.gnx = 0;
        a.gny = 1;
        a.gnz = 0;
      }
    }
    return a.gy - (a.gnx * (x - a.gx) + a.gnz * (z - a.gz)) / a.gny;
  }

  private stepParty(g: Group, f: FrameState, dt: number, px: number, pz: number): void {
    const trip = g.trip as Trip;
    const r = trip.route;
    let held = false;
    for (let i = 0; i < g.agents.length; i++) if (g.agents[i] === this.held) held = true;
    // talking to one of them holds the whole party where it is
    if (held) g.delay += dt;
    const tau = (((f.time - g.delay + trip.phase) % trip.period) + trip.period) % trip.period;
    const legs = trip.legs;
    let L = legs[legs.length - 1];
    for (let i = 0; i < legs.length; i++) {
      if (tau < legs[i].t1) {
        L = legs[i];
        break;
      }
    }
    const e = tau - L.t0;
    const rem = L.t1 - tau;
    g.s = L.camp === -1 ? L.s0 + (L.s1 - L.s0) * (e / Math.max(1e-6, L.t1 - L.t0)) : L.s0;
    const dir = L.dir;
    // where the party is, for range checks and for finding someone to talk to
    routePos(r, routeUAtS(r, g.s), 0, this.P0);
    g.ax = this.P0.x;
    g.az = this.P0.z;
    const away = L.camp === -2;
    if (away || Math.hypot(g.ax - px, g.az - pz) > RANGE + g.reach) {
      g.active = false;
      for (const a of g.agents) if (a.free === 0) a.x = a.z = 1e9;
      return;
    }
    const snap = !g.active;
    g.active = true;
    g.pres = 1;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    const rest = L.camp >= 0 ? trip.camps[L.camp] : null;
    const lamp = f.night > 0.35;
    let pi = 0;
    let ai = 0;
    for (let i = 0; i < g.agents.length; i++) {
      const a = g.agents[i];
      const s = g.s - dir * a.o;
      const vis = ss(trip.gA - 30, trip.gA + 5, s) * (1 - ss(trip.gB - 5, trip.gB + 30, s));
      const u = routeUAtS(r, s);
      const sl = routeSlope(r, u);
      const nl = Math.sqrt(1 + sl * sl);
      // the way along the path (+s) in world space, and its left normal
      const tx = (r.dx - r.dz * sl) / nl;
      const tz = (r.dz + r.dx * sl) / nl;
      routePos(r, u, 0, this.P0);
      const lat = (a.lat + 0.6) * dir;
      let x = this.P0.x - tz * lat;
      let z = this.P0.z + tx * lat;
      let ty = Math.atan2(tx * dir, tz * dir);
      let moving = L.camp === -1;
      let sitT = 0;
      if (rest) {
        // off the path to a place by the fire, a long rest, and back onto the path
        let spot: { x: number; z: number; yaw: number };
        let sits = false;
        if (a.animal) {
          spot = rest.pens[(ai + trip.index * 3) % rest.pens.length];
          sits = true;
          ai++;
        } else {
          const free = rest.seats.length - (rest.resident ? 1 : 0);
          const slot = (pi + trip.index) % Math.max(1, rest.seats.length + rest.stand.length);
          if (pi < free) {
            spot = rest.seats[(rest.resident ? 1 : 0) + ((pi + trip.index) % free)];
            sits = true;
          } else spot = rest.stand[slot % rest.stand.length];
          pi++;
        }
        const dx = spot.x - x;
        const dz = spot.z - z;
        const far = Math.hypot(dx, dz);
        const tm = Math.min(25, Math.max(3, far / 1.0));
        const kIn = ss(0, tm, e);
        const kOut = ss(0, tm, rem - 3);
        const kk = Math.min(kIn, kOut);
        x += dx * kk;
        z += dz * kk;
        if (kk > 0.999) {
          moving = false;
          ty = spot.yaw;
          sitT = sits && rem > tm + 3 ? 1 : 0;
        } else if (kk > 0.001) {
          moving = true;
          ty = kIn < kOut ? Math.atan2(dx, dz) : Math.atan2(-dx, -dz);
        } else moving = false;
      }
      // a camel someone is riding, or has left loose, is not the party's to place (its pen slot stays counted)
      if (a.free !== 0) continue;
      if (a === this.held) {
        moving = false;
        ty = Math.atan2(px - a.x, pz - a.z);
      }
      // (one back with the party again is put straight where it belongs, as it fades in)
      const sn = snap || a.shown <= 0;
      const err = angDiff(ty, a.yaw);
      if (sn) a.yaw = ty;
      else {
        const tr = (a.animal ? 1.0 : 1.8) * dt;
        a.yaw += Math.max(-tr, Math.min(tr, err));
      }
      a.dirSign = dir;
      if (sn) {
        a.spd = moving ? g.v : 0;
        a.sit = sitT;
      }
      a.spd += ((moving ? g.v : 0) - a.spd) * k(3);
      if (a.spd < 0.01) a.spd = 0;
      a.ph += (a.spd * dt) / a.stride;
      a.sitTarget = sitT;
      a.sit += Math.max(-dt * 0.7, Math.min(dt * 0.7, a.sitTarget - a.sit));
      a.lamp = lamp && !a.animal;
      if (vis <= 0.001) {
        a.x = a.z = 1e9;
        continue;
      }
      const d = Math.hypot(x - px, z - pz);
      const y = this.groundAt(a, x, z, d);
      this.put(a, x, y, z, a.gnx, a.gny, a.gnz, g, dt, px, pz, vis);
    }
  }

  // ---------------------------------------------------------------- temples

  /** A temple's people: keepers at the door and the stair, and pilgrims walking out and back along its avenue. */
  private buildShrine(l: Landmark, all: readonly Landmark[]): Group[] {
    const t = l.temple!;
    const rng = mulberry32((this.world.seed ^ Math.imul(l.key | 0, 0x2c1b3c6d) ^ 0x7e3a11c5) >>> 0);
    const groups: Group[] = [];
    const robe = (list: V3[]): V3 => {
      const c = list[Math.floor(rng() * list.length)];
      const j = 0.94 + rng() * 0.1;
      return [c[0] * j, c[1] * j, c[2] * j];
    };

    const kg = this.emptyGroup(4, t.foot.x, t.foot.z, 60);
    for (const k of t.keep) {
      const a = newAgent(false, rng);
      a.role = ROLE_KEEPER;
      a.coat = robe(KEEPER_ROBES);
      a.variant = 0;
      a.x = k.x;
      a.y = k.y;
      a.z = k.z;
      a.yaw = a.yaw0 = k.yaw;
      kg.agents.push(a);
    }
    // a pilgrim or two kneeling at the foot of the stair, at any hour
    const nk = rng() < 0.6 ? 1 : 2;
    for (let i = 0; i < nk; i++) {
      const a = newAgent(false, rng);
      a.role = ROLE_PILGRIM;
      a.coat = robe(PILGRIM_ROBES);
      a.variant = 0;
      const side = i === 0 ? -1.4 : 1.6;
      // face the stair: back the way the avenue runs
      const fx0 = Math.sin(t.yaw);
      const fz0 = Math.cos(t.yaw);
      a.x = t.foot.x + fz0 * side + fx0 * (1.5 + rng());
      a.z = t.foot.z - fx0 * side + fz0 * (1.5 + rng());
      a.y = this.world.height(a.x, a.z);
      a.yaw = a.yaw0 = t.yaw + Math.PI + (rng() - 0.5) * 0.3;
      a.sit = a.sitTarget = 1;
      kg.agents.push(a);
    }
    groups.push(kg);

    // Out along the avenue, then on toward whatever lies ahead: another temple, an oasis, a ruin.
    // Nobody heads back past the temple itself, so only places in front of it are chosen.
    const fx = Math.sin(t.yaw);
    const fz = Math.cos(t.yaw);
    const s0 = Math.hypot(t.end.x - t.foot.x, t.end.z - t.foot.z) + 8;
    const ex = t.foot.x + fx * s0;
    const ez = t.foot.z + fz * s0;
    const ahead: Landmark[] = [];
    for (const o of all) {
      if (o.key === l.key) continue;
      const dx = o.x - ex;
      const dz = o.z - ez;
      const d = Math.hypot(dx, dz);
      if (d < 350 || d > 2400 || (dx * fx + dz * fz) / d < 0.5) continue;
      ahead.push(o);
    }
    const nGroups = 2 + (rng() < 0.5 ? 1 : 0);
    for (let i = 0; i < nGroups; i++) {
      let route: Route | null = null;
      for (let tries = 0; tries < 5 && !route; tries++) {
        let bx: number;
        let bz: number;
        let len: number;
        const dest = ahead.length ? ahead[(i + tries) % ahead.length] : null;
        if (i === 0) {
          // one group only walks the avenue and a little past it, so there's nearly always someone close
          const a = t.yaw + (rng() - 0.5) * 0.5;
          bx = Math.sin(a);
          bz = Math.cos(a);
          len = s0 + 60 + rng() * 140;
        } else if (dest && tries < 3) {
          const d = Math.hypot(dest.x - ex, dest.z - ez);
          bx = (dest.x - ex) / d;
          bz = (dest.z - ez) / d;
          len = s0 + d - 40; // stop short of its stones
        } else {
          const a = t.yaw + (rng() - 0.5) * 1.2;
          bx = Math.sin(a);
          bz = Math.cos(a);
          len = s0 + 450 + rng() * 650;
        }
        const r = this.makeRoute(rng, t.foot.x, t.foot.z, Math.atan2(fz, fx), 0, len, 14 + rng() * 14);
        r.s0 = s0;
        r.bx = bx;
        r.bz = bz;
        if (this.routeClear(r)) route = r;
      }
      if (!route) continue;
      const g = this.emptyGroup(3, 0, 0, 0);
      const mid = { x: 0, z: 0 };
      routePoint(route, route.len * 0.5, mid);
      g.ax = mid.x;
      g.az = mid.z;
      g.reach = route.len * 0.5 + 100;
      g.route = route;
      g.v = 0.85 + rng() * 0.25;
      g.fseed = rng();
      const n = rng() < 0.45 ? 1 : rng() < 0.7 ? 2 : 3;
      for (let k = 0; k < n; k++) {
        const a = newAgent(false, rng);
        a.role = ROLE_PILGRIM;
        a.coat = robe(PILGRIM_ROBES);
        a.load = robe(KEEPER_ROBES);
        a.variant = PILGRIM_LOADS[Math.floor(rng() * PILGRIM_LOADS.length)];
        a.lat = (k - (n - 1) / 2) * 1.15;
        g.agents.push(a);
      }
      groups.push(g);
    }
    return groups;
  }

  /** Whether a lane `o` m to the side of a route (along (lx, lz)) is clear here at (x0, z0) and `look` m on at (ex, ez). */
  private laneClear(q: SolidQuery, x0: number, z0: number, ex: number, ez: number, lx: number, lz: number, o: number, y: number, fx: number, fz: number, body: number, look: number): boolean {
    if (q(x0 + lx * o, z0 + lz * o, y) > y + CREATURE_STEP) return false;
    return clearAt(q, ex + lx * o, ez + lz * o, y, fx, fz, body, look);
  }

  /**
   * For someone on a route at (x0, z0), heading along the unit (fx, fz), `lat` m to its side
   * (along (lx, lz)): eases a.avoid, the step aside of that line, to pass whatever stands on the
   * way, looking `look` m ahead, nearest lane first and to the side already taken. Off near the
   * player it lets the step aside go. Returns true when the place it now puts them is blocked all
   * the same (nothing clears within reach of the line), so the caller holds them where they were.
   */
  private sidestep(a: Agent, x0: number, z0: number, fx: number, fz: number, lx: number, lz: number, lat: number, px: number, pz: number, body: number, look: number, rate: number, dt: number): boolean {
    const q = this.solid;
    let target = 0;
    let y = 0;
    const near = q !== null && (x0 - px) * (x0 - px) + (z0 - pz) * (z0 - pz) < AVOID_R * AVOID_R;
    if (q && near) {
      y = this.world.height(x0 + lx * lat, z0 + lz * lat);
      const ex = x0 + fx * look;
      const ez = z0 + fz * look;
      if (this.laneClear(q, x0, z0, ex, ez, lx, lz, lat, y, fx, fz, body, look)) a.dside = 0;
      else if (a.avoid !== 0 && this.laneClear(q, x0, z0, ex, ez, lx, lz, lat + a.avoid, y, fx, fz, body, look)) target = a.avoid;
      else {
        target = a.avoid;
        const side = a.dside !== 0 ? a.dside : a.lat >= 0 ? 1 : -1;
        search: for (let n = 0; n < SIDESTEP.length; n++) {
          for (let t = 0; t < 2; t++) {
            const sd = t === 0 ? side : -side;
            if (!this.laneClear(q, x0, z0, ex, ez, lx, lz, lat + sd * SIDESTEP[n], y, fx, fz, body, look)) continue;
            target = sd * SIDESTEP[n];
            a.dside = sd;
            break search;
          }
        }
      }
    } else a.dside = 0;
    const was = a.avoid;
    const mv = rate * dt;
    a.avoid += Math.max(-mv, Math.min(mv, target - a.avoid));
    a.avV += ((a.avoid - was) / Math.max(dt, 1e-4) - a.avV) * (1 - Math.exp(-dt * 6));
    if (!q || !near) return false;
    // just come into view (where they were is somewhere else), or standing in something
    // already: let them walk on out of it
    if (Math.abs(a.x - x0) + Math.abs(a.z - z0) > 12 + Math.abs(lat) || blockedAt(q, a.x, a.z, a.y)) return false;
    const o = lat + a.avoid;
    return blockedAt(q, x0 + lx * o, z0 + lz * o, y);
  }

  private stepPilgrims(g: Group, f: FrameState, dt: number, px: number, pz: number): void {
    const r = g.route as Route;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    let held = false;
    for (let i = 0; i < g.agents.length; i++) if (g.agents[i] === this.held) held = true;
    const sPrev = g.s;
    if (g.wait > 0) {
      g.wait -= dt;
      if (g.wait <= 0) g.dir = -g.dir;
    } else if (!held) {
      g.s += g.dir * g.v * dt;
      if (g.dir > 0 && g.s >= r.len) {
        g.s = r.len;
        g.wait = 3 + Math.random() * 4; // a rest at the far end
      } else if (g.dir < 0 && g.s <= 0) {
        g.s = 0;
        g.wait = 10 + Math.random() * 10; // kneel at the foot of the stair
      }
    }
    const moving = g.wait <= 0 && !held;
    const kneel = !moving && !held && g.s <= 0.01;
    const lamp = f.night > 0.35;
    for (let i = 0; i < g.agents.length; i++) {
      const a = g.agents[i];
      a.s = g.s;
      a.dirSign = g.dir;
      routePoint(r, a.s, this.P0);
      routePoint(r, a.s + 3, this.P1);
      let tx = this.P1.x - this.P0.x;
      let tz = this.P1.z - this.P0.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const lean = g.dir * Math.atan2(a.avV, Math.max(a.spd, 0.4));
      const ty = a === this.held ? Math.atan2(px - a.x, pz - a.z) : Math.atan2(tx, tz) + (g.dir < 0 ? Math.PI : 0) + lean;
      const err = angDiff(ty, a.yaw);
      const tr = 1.8 * dt;
      a.yaw += Math.max(-tr, Math.min(tr, err));
      a.spd += ((moving ? g.v : 0) - a.spd) * k(2);
      if (a.spd < 0.01) a.spd = 0;
      a.ph += (a.spd * dt) / a.stride;
      a.sitTarget = kneel ? 1 : 0;
      a.sit += Math.max(-dt * 0.7, Math.min(dt * 0.7, a.sitTarget - a.sit));
      a.lamp = lamp;
      // step aside for a player standing on the way
      const ex = px - this.P0.x;
      const ez = pz - this.P0.z;
      let tgt = 0;
      if (ex * ex + ez * ez < 100) {
        const along = ex * tx + ez * tz;
        const rel = ex * tz - ez * tx - a.lat;
        if (Math.abs(along) < 8 && Math.abs(rel) < 2.4) tgt = (rel >= 0 ? -1 : 1) * (2.4 - Math.abs(rel)) * (1 - ss(5, 8, Math.abs(along)));
      }
      a.drift += (tgt - a.drift) * k(1.8);
      const lat = a.lat + a.drift;
      let x: number;
      let z: number;
      if (this.sidestep(a, this.P0.x, this.P0.z, tx * g.dir, tz * g.dir, tz, -tx, lat, px, pz, 0.3, 2.5, 1.1, dt)) {
        // no way past within reach of the path: stop where they stood, rest a moment and turn back
        x = a.x;
        z = a.z;
        a.spd = 0;
        g.s = sPrev;
        if (moving) g.wait = 2 + a.seed * 2;
      } else {
        x = this.P0.x + tz * (lat + a.avoid);
        z = this.P0.z - tx * (lat + a.avoid);
      }
      const w = this.world;
      w.normal(x, z, this.nrm);
      this.put(a, x, w.height(x, z), z, this.nrm.x, this.nrm.y, this.nrm.z, g, dt, px, pz);
    }
  }

  /** A village's people, each where the village has a place for them: they keep to it, as the temples' keepers do. */
  private buildVillage(v: Village): Group {
    const rng = mulberry32((this.world.seed ^ Math.imul(v.key | 0, 0x3d4d51cb) ^ 0x51ed270b) >>> 0);
    let far = 0;
    for (const f of v.folk) far = Math.max(far, Math.hypot(f.x - v.x, f.z - v.z));
    const g = this.emptyGroup(4, v.x, v.z, Math.max(80, far + 20));
    g.snow = v.snow;
    g.place = v.kind;
    const wool = v.snow ? SNOW_WOOL : VILLAGE_WOOL;
    for (const f of v.folk) {
      const a = newAgent(false, rng);
      const c = wool[Math.floor(rng() * wool.length)];
      const j = 0.9 + rng() * 0.18;
      a.role = f.role === 'watcher' ? ROLE_WATCHER : f.role === 'climber' ? ROLE_CLIMBER : f.role === 'host' ? ROLE_HOST : ROLE_VILLAGER;
      a.coat = f.coat ? [f.coat[0] * j, f.coat[1] * j, f.coat[2] * j]
        : f.role === 'watcher' ? WATCHER_COAT : f.role === 'climber' ? CLIMBER_COAT : [c[0] * j, c[1] * j, c[2] * j];
      a.variant = 0;
      if (f.small) a.scale = 0.58 + rng() * 0.1;
      let x = f.x;
      let z = f.z;
      let y = f.y ?? this.world.height(x, z);
      // (a place that turns out to be inside a wall: step aside, or stay indoors; not on a deck or terrace)
      if (f.y === undefined && this.solid && blockedAt(this.solid, x, z, y)) {
        let ok = false;
        for (let k = 0; k < 8 && !ok; k++) {
          const an = (k / 8) * TAU;
          const tx = f.x + Math.sin(an) * 1.6;
          const tz = f.z + Math.cos(an) * 1.6;
          const ty = this.world.height(tx, tz);
          if (blockedAt(this.solid, tx, tz, ty)) continue;
          x = tx;
          z = tz;
          y = ty;
          ok = true;
        }
        if (!ok && f.role === 'villager') continue;
      }
      a.x = x;
      a.y = y;
      a.z = z;
      a.yaw = a.yaw0 = f.yaw;
      if (f.sit) a.sit = a.sitTarget = 1;
      g.agents.push(a);
    }
    return g;
  }

  private stepKeepers(g: Group, f: FrameState, dt: number, px: number, pz: number): void {
    for (let i = 0; i < g.agents.length; i++) {
      const a = g.agents[i];
      // Mostly still, looking out over the avenue; they turn to whoever speaks to them.
      const ty = a === this.held ? Math.atan2(px - a.x, pz - a.z) : a.yaw0 + 0.35 * Math.sin(f.time * 0.06 + a.seed * 40);
      a.yaw += angDiff(ty, a.yaw) * (1 - Math.exp(-dt * (a === this.held ? 4 : 0.8)));
      this.put(a, a.x, a.y, a.z, 0, 1, 0, g, dt, px, pz);
    }
  }

  // ---------------------------------------------------------------- update

  update(f: FrameState): void {
    const dt = Math.min(f.dt, 0.1);
    const px = f.player.pos.x;
    const pz = f.player.pos.z;

    this.refresh -= dt;
    if (this.refresh <= 0) {
      this.refresh = 1.5;
      const sites = this.cities.near(px, pz);
      this.live.length = 0;
      for (let i = 0; i < sites.length; i++) {
        const s = sites[i];
        if (Math.hypot(s.cx - px, s.cz - pz) > s.radius + 4800) continue;
        let gs = this.cache.get(s.id);
        if (!gs) {
          gs = this.build(s);
          this.cache.set(s.id, gs);
        }
        for (let k = 0; k < gs.length; k++) this.live.push(gs[k]);
      }
      // the routes between cities: their camps, and the parties walking them
      const routes = this.net.near(px, pz, this.routeList, 10);
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        const t = Math.min(r.len, Math.max(0, (px - r.ax) * r.dx + (pz - r.az) * r.dz));
        if (Math.hypot(px - r.ax - r.dx * t, pz - r.az - r.dz * t) > ROUTE_NEAR) continue;
        let gs = this.routeLife.get(r.key);
        if (!gs) {
          gs = this.buildRoute(r);
          this.routeLife.set(r.key, gs);
        }
        for (let k = 0; k < gs.length; k++) this.live.push(gs[k]);
      }
      for (let k = 0; k < this.placed.length; k++) this.live.push(this.placed[k]);
      if (this.pens) this.pensNear(px, pz);
      if (this.landmarks) {
        const ls = this.landmarks(this.marks);
        for (let i = 0; i < ls.length; i++) {
          const l = ls[i];
          if (l.kind === 'oasis' && Math.hypot(l.x - px, l.z - pz) < RANGE + 500) {
            let os = this.oases.get(l.key);
            if (!os) {
              os = this.buildOasis(l);
              this.oases.set(l.key, os);
            }
            for (let k = 0; k < os.length; k++) this.live.push(os[k]);
            continue;
          }
          if (!l.temple || Math.hypot(l.x - px, l.z - pz) > RANGE + 1500) continue;
          let gs = this.shrines.get(l.key);
          if (!gs) {
            gs = this.buildShrine(l, ls);
            this.shrines.set(l.key, gs);
          }
          for (let k = 0; k < gs.length; k++) this.live.push(gs[k]);
        }
      }
      if (this.villages) {
        const vs = this.villages(this.vils);
        for (let i = 0; i < vs.length; i++) {
          const v = vs[i];
          if (Math.hypot(v.x - px, v.z - pz) > RANGE + 500) continue;
          let g = this.villagers.get(v.key);
          if (!g) {
            g = this.buildVillage(v);
            this.villagers.set(v.key, g);
          }
          this.live.push(g);
        }
      }
      this.shepherdsNear(px, pz);
      this.wildNear(px, pz, WILD_CELL, WILD_CHANCE, false, this.wildCells, RANGE);
      if (this.needy) this.wildNear(px, pz, EARLY_CELL, EARLY_CHANCE, true, this.earlyCells, EARLY_R);
    }
    this.heldT -= dt;
    if (this.heldT <= 0) this.held = null;

    this.nA = 0;
    this.nP = 0;
    this.nR = 0;
    this.nF = 0;
    this.stepMounts(dt, px, pz);

    const walkOk = f.night < 0.6;
    for (let i = 0; i < this.live.length; i++) {
      const g = this.live[i];
      // the extras a lesser tier leaves out
      if (g.rank > 0 && g.rank >= this.density) {
        g.active = false;
        g.pres = 0;
        if (g.shep) g.shep.herder.on = false;
        continue;
      }
      if (g.kind === 5) {
        this.stepParty(g, f, dt, px, pz);
        continue;
      }
      const inRange = Math.hypot(g.ax - px, g.az - pz) < RANGE + g.reach;
      // camps, keepers and pilgrims (who carry lanterns) stay out after dark
      const want = inRange && (g.kind === 1 || g.kind >= 3 || walkOk);
      g.pres = Math.min(1, Math.max(0, g.pres + (want ? 1 : -1) * dt * 0.4));
      if (g.pres <= 0 && !want) {
        g.active = false;
        if (g.shep) g.shep.herder.on = false;
        continue;
      }
      if (!g.active) {
        g.active = true;
        this.snap(g, f);
      }
      if (g.kind === 2) this.stepWalkers(g, f, dt, px, pz);
      else if (g.kind === 3) this.stepPilgrims(g, f, dt, px, pz);
      else if (g.kind === 4) this.stepKeepers(g, f, dt, px, pz);
      else if (g.kind === 6) this.stepShepherd(g, f, dt, px, pz);
      else if (g.kind === 7) this.stepPen(g, f, dt, px, pz);
      else this.stepCamp(g, f, dt, px, pz);
    }

    // the wanderer's own fire: the same glow, tongues and smoke as any camp's
    const h = this.hearth;
    if (h && this.nF + 13 <= CAP_FIRE && Math.hypot(h.x - px, h.z - pz) < 1800) {
      for (let i = 0; i < 13; i++) {
        const o = this.nF * 4;
        const kind = i === 0 ? 0 : i < 5 ? 1 : 2;
        this.fBase.arr[o] = h.x;
        this.fBase.arr[o + 1] = h.y;
        this.fBase.arr[o + 2] = h.z;
        this.fBase.arr[o + 3] = 0.8;
        this.fKind.arr[o] = kind;
        this.fKind.arr[o + 1] = (0.37 * 7.31 + i * 0.173) % 1;
        this.fKind.arr[o + 2] = kind === 2 ? ((i - 5) / 8 + 0.37) % 1 : 0;
        this.fKind.arr[o + 3] = 0;
        this.nF++;
      }
    }
    this.animalGeo.instanceCount = this.nA;
    this.personGeo.instanceCount = this.nP;
    this.propGeo.instanceCount = this.nR;
    this.fireGeo.instanceCount = this.nF;
    this.aPos.attr.needsUpdate = this.aUp.attr.needsUpdate = this.aMot.attr.needsUpdate = true;
    this.aCoat.attr.needsUpdate = this.aLoad.attr.needsUpdate = this.aAux.attr.needsUpdate = true;
    this.pPos.attr.needsUpdate = this.pUp.attr.needsUpdate = this.pMot.attr.needsUpdate = true;
    this.pCoat.attr.needsUpdate = this.pLoad.attr.needsUpdate = true;
    this.rPos.attr.needsUpdate = this.rProp.attr.needsUpdate = this.rCol.attr.needsUpdate = true;
    this.fBase.attr.needsUpdate = this.fKind.attr.needsUpdate = true;
  }

  /** Put a group where its schedule says it should be, used whenever it (re)appears. */
  private snap(g: Group, f: FrameState): void {
    const r = g.route;
    if (g.kind === 1 || !r) return;
    if (g.kind === 3) {
      // anywhere on the way out and back, as if they had been walking all along
      const t = (f.time * g.v + g.fseed * 2 * r.len) % (2 * r.len);
      g.s = t > r.len ? 2 * r.len - t : t;
      g.dir = t > r.len ? -1 : 1;
      g.wait = 0;
      for (const a of g.agents) {
        a.s = g.s;
        a.dirSign = g.dir;
        a.spd = g.v;
        a.sit = 0;
        this.faceRoute(a, r);
      }
      return;
    }
    if (g.kind === 2) {
      for (const a of g.agents) {
        const t = (f.time * a.vmax + a.s) % (2 * r.len);
        a.s = t > r.len ? 2 * r.len - t : t;
        a.dirSign = t > r.len ? -1 : 1;
        a.spd = a.vmax;
        a.rest = 0;
        this.faceRoute(a, r);
      }
      return;
    }
  }

  private faceRoute(a: Agent, r: Route): void {
    routePoint(r, a.s, this.P0);
    routePoint(r, a.s + 3, this.P1);
    a.yaw = Math.atan2(this.P1.x - this.P0.x, this.P1.z - this.P0.z) + (a.dirSign < 0 ? Math.PI : 0);
  }

  private stepWalkers(g: Group, f: FrameState, dt: number, px: number, pz: number): void {
    for (let i = 0; i < g.agents.length; i++) this.stepRouteAgent(g, g.agents[i], 0, true, f, dt, px, pz);
  }

  private stepRouteAgent(g: Group, a: Agent, dirWanted: number, bounce: boolean, f: FrameState, dt: number, px: number, pz: number): void {
    const r = g.route as Route;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    routePoint(r, a.s, this.P0);
    routePoint(r, a.s + 3, this.P1);
    let tx = this.P1.x - this.P0.x;
    let tz = this.P1.z - this.P0.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    let mv: number;
    if (bounce) {
      // (someone with a reason to stop at each end, a jar to fill or brush to gather, stays a while)
      if (a.dirSign > 0 && a.s >= r.len) {
        a.dirSign = -1;
        if (a.pause > 0) a.rest = a.pause * (0.6 + 0.8 * Math.random());
      } else if (a.dirSign < 0 && a.s <= 0) {
        a.dirSign = 1;
        if (a.pause > 0) a.rest = a.pause * (0.6 + 0.8 * Math.random());
      }
      mv = a.dirSign;
      if (a.rest > 0) {
        a.rest -= dt;
        mv = 0;
      }
    } else {
      mv = dirWanted;
      if (mv > 0 && a.s >= a.hi) mv = 0;
      if (mv < 0 && a.s <= a.lo) mv = 0;
      if (mv !== 0) a.dirSign = mv;
    }
    // Spoken to: stop on the road and turn to the player.
    const held = a === this.held;
    if (held) mv = 0;
    // (leaning into a step aside, when there is one)
    const lean = a.dirSign * Math.atan2(a.avV, Math.max(a.spd, 0.4));
    const ty = held ? Math.atan2(px - a.x, pz - a.z) : Math.atan2(tx, tz) + (a.dirSign < 0 ? Math.PI : 0) + lean;
    const err = angDiff(ty, a.yaw);
    const tr = (a.animal ? 1.0 : 1.8) * dt;
    a.yaw += Math.max(-tr, Math.min(tr, err));
    const go = mv !== 0 && Math.abs(err) < 0.5 + Math.abs(lean) && a.sit < 0.3;
    a.spd += ((go ? a.vmax : 0) - a.spd) * k(1.5);
    if (a.spd < 0.01) a.spd = 0;
    const sPrev = a.s;
    a.s += a.dirSign * a.spd * dt;
    if (bounce) a.s = Math.min(r.len, Math.max(0, a.s));
    else a.s = Math.min(a.hi, Math.max(a.lo, a.s));
    a.ph += (a.spd * dt) / a.stride;
    a.sitTarget = !bounce && !held && mv === 0 && a.spd < 0.15 ? 1 : a.rest > 0 && !held && a.spd < 0.3 ? 0.55 : 0;
    const ds = a.sitTarget - a.sit;
    a.sit += Math.max(-dt * 0.7, Math.min(dt * 0.7, ds));

    // drift aside if the player stands on the line
    const ex = px - this.P0.x;
    const ez = pz - this.P0.z;
    let tgt = 0;
    if (ex * ex + ez * ez < 100) {
      const along = ex * tx + ez * tz;
      const rel = ex * tz - ez * tx - a.lat;
      if (Math.abs(along) < 8 && Math.abs(rel) < 2.4) tgt = (rel >= 0 ? -1 : 1) * (2.4 - Math.abs(rel)) * (1 - ss(5, 8, Math.abs(along)));
    }
    a.drift += (tgt - a.drift) * k(1.8);
    const lat = a.lat + a.drift + (a.animal ? 0 : Math.sin(f.time * 0.2 + a.seed * 40) * 0.3);
    let x: number;
    let z: number;
    if (this.sidestep(a, this.P0.x, this.P0.z, tx * a.dirSign, tz * a.dirSign, tz, -tx, lat, px, pz, a.animal ? 0.7 : 0.3, a.animal ? 4 : 2.5, a.animal ? 0.8 : 1.1, dt)) {
      // no way past within reach of the track: hold where they stood (someone walking alone turns back)
      x = a.x;
      z = a.z;
      a.s = sPrev;
      a.spd = 0;
      if (bounce) a.dirSign = -a.dirSign;
    } else {
      x = this.P0.x + tz * (lat + a.avoid);
      z = this.P0.z - tx * (lat + a.avoid);
    }
    const w = this.world;
    const y = w.height(x, z);
    w.normal(x, z, this.nrm);
    this.put(a, x, y, z, this.nrm.x, this.nrm.y, this.nrm.z, g, dt, px, pz);
  }

  /**
   * A shepherd: a slow walk to somewhere new within SHEP_ROAM of home, a long stand while the
   * flock grazes, and sitting out the night. Anyone with them keeps a step behind.
   */
  private stepShepherd(g: Group, f: FrameState, dt: number, px: number, pz: number): void {
    const sh = g.shep as Shepherd;
    const lead = g.agents[0];
    const night = f.night > 0.6;
    let held = false;
    for (let i = 0; i < g.agents.length; i++) if (g.agents[i] === this.held) held = true;
    let ty = lead.yaw;
    let want = 0;
    if (held) {
      sh.walking = false;
      if (lead === this.held) ty = Math.atan2(px - lead.x, pz - lead.z);
    } else if (night) sh.walking = false;
    else if (sh.walking) {
      const ex = sh.tx - lead.x;
      const ez = sh.tz - lead.z;
      if (Math.hypot(ex, ez) < 1) {
        sh.walking = false;
        sh.t = 12 + Math.random() * 25;
      } else {
        ty = Math.atan2(ex, ez);
        want = lead.vmax;
      }
    } else {
      sh.t -= dt;
      if (sh.t <= 0) {
        const ang = Math.random() * TAU;
        const rr = Math.sqrt(Math.random()) * SHEP_ROAM;
        sh.tx = sh.hx + Math.cos(ang) * rr;
        sh.tz = sh.hz + Math.sin(ang) * rr;
        sh.walking = true;
      }
    }
    for (let i = 0; i < g.agents.length; i++) {
      const a = g.agents[i];
      let aty = ty;
      let aw = want;
      if (i > 0) {
        // a step behind and to the side of the shepherd
        const c = Math.cos(lead.yaw);
        const sn = Math.sin(lead.yaw);
        const ox = lead.x - sn * 1.8 + c * 1.3 * (i % 2 ? 1 : -1);
        const oz = lead.z - c * 1.8 - sn * 1.3 * (i % 2 ? 1 : -1);
        const ed = Math.hypot(ox - a.x, oz - a.z);
        aty = a === this.held ? Math.atan2(px - a.x, pz - a.z) : ed > 0.6 ? Math.atan2(ox - a.x, oz - a.z) : lead.yaw;
        aw = a === this.held || night ? 0 : Math.min(1.25, ed * 0.8);
        if (aw < 0.15) aw = 0;
      }
      const err = angDiff(aty, a.yaw);
      a.yaw += Math.max(-1.8 * dt, Math.min(1.8 * dt, err));
      const go = Math.abs(err) < 0.6 && a.sit < 0.3 ? 1 : 0;
      a.spd += (aw * go - a.spd) * (1 - Math.exp(-dt * 2));
      if (a.spd < 0.01) a.spd = 0;
      a.ph += (a.spd * dt) / a.stride;
      a.sitTarget = night && !held ? 1 : 0;
      a.sit += Math.max(-dt * 0.7, Math.min(dt * 0.7, a.sitTarget - a.sit));
      const mx = Math.sin(a.yaw) * a.spd * dt;
      const mz = Math.cos(a.yaw) * a.spd * dt;
      const d = Math.hypot(a.x - px, a.z - pz);
      let x = a.x + mx;
      let z = a.z + mz;
      if (this.solid && d < AVOID_R && a.spd > 0) {
        if (steer(this.solid, a.x, a.z, a.y, mx, mz, 0.3, sh.dodge)) {
          sh.dodge = steered.side;
          // boxed in: the shepherd gives up on that spot and stands a while
          if (steered.turn === 0 && i === 0) {
            sh.walking = false;
            sh.t = 5 + Math.random() * 5;
          }
        }
        x = steered.x;
        z = steered.z;
      }
      const y = this.groundAt(a, x, z, d);
      this.put(a, x, y, z, a.gnx, a.gny, a.gnz, g, dt, px, pz);
    }
    g.ax = lead.x;
    g.az = lead.z;
    sh.herder.x = lead.x;
    sh.herder.z = lead.z;
    sh.herder.rest = night;
    sh.herder.on = g.pres > 0.3;
  }

  // ---------------------------------------------------------------- pens

  /** Puts the pens near (px, pz) on the live list, building the beasts of any not met before. */
  private pensNear(px: number, pz: number): void {
    const ps = (this.pens as (out: PenSpot[]) => PenSpot[])(this.penList);
    this.penStamp++;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (Math.hypot(p.x - px, p.z - pz) > PEN_R + 60) continue;
      let g = this.penLife.get(p.key);
      // (a city's outskirts built again, as when the tier changes, are a new pen under the same key)
      if (!g || g.pen?.spot !== p) {
        g = this.buildPen(p);
        this.penLife.set(p.key, g);
        this.adopt(g);
      }
      (g.pen as PenLife).seen = this.penStamp;
      this.live.push(g);
    }
    // forget the pens left behind (they are built the same again on the way back)
    if (this.penLife.size > 48) for (const [key, g] of this.penLife) if ((g.pen as PenLife).seen !== this.penStamp) this.penLife.delete(key);
  }

  /** A pen's beasts, where the outskirts laid them out: mostly of one coat, some still in a blanket. */
  private buildPen(p: PenSpot): Group {
    const rng = mulberry32((this.world.seed ^ Math.imul(p.key | 0, 0x2f6b4a1d) ^ 0x1b873593) >>> 0);
    const g = this.emptyGroup(7, p.x, p.z, Math.hypot(p.hw, p.hd) + 5);
    const co = Math.cos(p.rot);
    const si = Math.sin(p.rot);
    const beasts: PenBeast[] = [];
    const herd = COATS[Math.floor(rng() * COATS.length)];
    for (const b of p.beasts) {
      const a = newAgent(true, rng);
      if (rng() < 0.7) {
        const j = 0.9 + rng() * 0.2;
        a.coat = [herd[0] * j, herd[1] * j, herd[2] * j];
      }
      a.variant = rng() < 0.45 ? 4 : 0;
      a.x = p.x + co * b.u - si * b.v;
      a.z = p.z + si * b.u + co * b.v;
      a.y = Number.isNaN(p.y) ? this.world.height(a.x, a.z) : p.y;
      a.yaw = b.yaw - p.rot;
      a.sit = a.sitTarget = b.lying ? 1 : 0;
      g.agents.push(a);
      // (the first to stir do so within a minute or so, the rest later)
      beasts.push({ mode: b.lying ? 0 : 1, t: b.lying ? 10 + rng() * 80 : 3 + rng() * 15, tx: a.x, tz: a.z, tyaw: NaN, eat: 0, graze: rng() < 0.5 });
    }
    g.pen = { spot: p, co, si, beasts, seen: 0 };
    return g;
  }

  /** A pen built anew while one of its beasts is out (ridden, or loose): that beast stands in for its copy. */
  private adopt(g: Group): void {
    const life = g.pen as PenLife;
    const take = (m: Mount) => {
      if (!m.g.pen || m.g === g || m.g.pen.spot.key !== life.spot.key) return;
      const i = m.g.agents.indexOf(m.a);
      if (i >= 0 && i < g.agents.length) g.agents[i] = m.a;
      else {
        g.agents.push(m.a);
        life.beasts.push({ mode: 1, t: 5, tx: m.a.x, tz: m.a.z, tyaw: NaN, eat: 0, graze: false });
      }
      m.g = g;
    };
    if (this.ridden) take(this.ridden);
    for (let i = 0; i < this.loose.length; i++) take(this.loose[i]);
  }

  /** Pen-local (u, v) of a world point, into penOut. */
  private penLocal(life: PenLife, x: number, z: number): void {
    const dx = x - life.spot.x;
    const dz = z - life.spot.z;
    this.penOut.u = life.co * dx + life.si * dz;
    this.penOut.v = -life.si * dx + life.co * dz;
  }

  private inOwnPen(a: Agent, life: PenLife): boolean {
    this.penLocal(life, a.x, a.z);
    return inPen(life.spot, this.penOut.u, this.penOut.v, 0.6);
  }

  /** The other beasts of a pen (where they stand, and where any are walking to), pen-local, for penSpot. */
  private penOthersOf(g: Group, skip: Agent): number[] {
    const life = g.pen as PenLife;
    const o = this.penOthers;
    o.length = 0;
    for (let j = 0; j < g.agents.length; j++) {
      const b = g.agents[j];
      if (b === skip || b.free !== 0) continue;
      this.penLocal(life, b.x, b.z);
      o.push(this.penOut.u, this.penOut.v);
      if (life.beasts[j].mode === 2) {
        this.penLocal(life, life.beasts[j].tx, life.beasts[j].tz);
        o.push(this.penOut.u, this.penOut.v);
      }
    }
    return o;
  }

  /** Back in its pen after a ride: where it stands (inPlace), or faded in somewhere free in it. */
  private rejoinPen(m: Mount, inPlace: boolean): void {
    const a = m.a;
    const g = m.g;
    const life = g.pen as PenLife;
    const P = life.spot;
    if (!inPlace) {
      a.shown = 0;
      a.look = a.pitch = 0;
      let u: number;
      let v: number;
      if (penSpot(P, Math.random, this.penOthersOf(g, a), 0, this.penOut)) {
        u = this.penOut.u;
        v = this.penOut.v;
      } else {
        this.penLocal(life, m.hx, m.hz);
        u = this.penOut.u;
        v = this.penOut.v;
      }
      a.x = P.x + life.co * u - life.si * v;
      a.z = P.z + life.si * u + life.co * v;
      a.y = Number.isNaN(P.y) ? this.world.height(a.x, a.z) : P.y;
      a.gx = NaN;
      a.yaw = m.hyaw;
      a.sit = a.sitTarget = m.hsit;
    }
    const b = life.beasts[g.agents.indexOf(a)];
    if (b) {
      b.mode = a.sit > 0.5 ? 0 : 1;
      b.t = 4 + Math.random() * 8;
      b.eat = 0;
      b.graze = false;
    }
  }

  /** A beast that has stood long enough decides what next: lie down, walk somewhere, or shift round where it is. */
  private penNext(g: Group, i: number, night: boolean): void {
    const life = g.pen as PenLife;
    const a = g.agents[i];
    const b = life.beasts[i];
    const r = Math.random();
    if (r < (night ? 0.45 : 0.14)) {
      b.mode = 0;
      b.t = 50 + Math.random() * 120;
      return;
    }
    b.mode = 2;
    b.eat = 0;
    b.tyaw = NaN;
    if (r < (night ? 0.6 : 0.75)) {
      // now and then to the trough or the heap, otherwise anywhere with room
      const eat = r < 0.3 ? 1 : r < 0.42 ? 2 : 0;
      if (penSpot(life.spot, Math.random, this.penOthersOf(g, a), eat, this.penOut)) {
        const u = this.penOut.u;
        const v = this.penOut.v;
        b.tx = life.spot.x + life.co * u - life.si * v;
        b.tz = life.spot.z + life.si * u + life.co * v;
        if (!Number.isNaN(this.penOut.yaw)) b.tyaw = this.penOut.yaw - life.spot.rot;
        b.eat = eat;
        return;
      }
    }
    // stays, and shifts round a little
    b.tx = a.x;
    b.tz = a.z;
    b.tyaw = a.yaw + (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.6);
  }

  /** Something stands in a pen beast's way, close ahead of it: another beast, the ridden camel or the player. */
  private penBlocked(g: Group, a: Agent, px: number, pz: number): boolean {
    const fx = Math.sin(a.yaw);
    const fz = Math.cos(a.yaw);
    const ahead = (x: number, z: number, r: number) => {
      const dx = x - a.x;
      const dz = z - a.z;
      const d = Math.hypot(dx, dz);
      return d < r && dx * fx + dz * fz > 0.2 * d;
    };
    for (let j = 0; j < g.agents.length; j++) {
      const b = g.agents[j];
      if (b !== a && b.free === 0 && ahead(b.x, b.z, 2.9)) return true;
    }
    if (this.ridden && this.ridden.a !== a && ahead(this.ridden.a.x, this.ridden.a.z, 3.2)) return true;
    return ahead(px, pz, 2.4);
  }

  /**
   * The beasts in a pen. Lying ones rest a long while, looking about now and then (see idle), and
   * in time get up; standing ones graze, eat at the trough or the heap, shift round, and now and
   * then amble a few metres to somewhere with room, or lie down again (more often after dark).
   * They keep inside the rails and out of each other's way, and stop for whoever is in front.
   */
  private stepPen(g: Group, f: FrameState, dt: number, px: number, pz: number): void {
    const life = g.pen as PenLife;
    const P = life.spot;
    const night = f.night > 0.6;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    for (let i = 0; i < g.agents.length; i++) {
      const a = g.agents[i];
      if (a.free !== 0) continue; // ridden off, or left loose somewhere
      const b = life.beasts[i];
      a.bow = 0;
      let ty = a.yaw;
      let want = 0;
      if (b.mode === 0) {
        a.sitTarget = 1;
        b.t -= dt;
        if (b.t <= 0) {
          if (Math.random() < (night ? 0.2 : 0.55)) {
            b.mode = 1;
            b.t = 8 + Math.random() * 16;
            b.eat = 0;
            b.graze = Math.random() < 0.5;
          } else b.t = 25 + Math.random() * 70;
        }
      } else {
        a.sitTarget = 0;
        if (a.sit > 0.05) {
          // still getting up
        } else if (b.mode === 1) {
          if (b.eat !== 0) a.bow = b.eat === 1 ? BOW_TROUGH : BOW_HEAP;
          else if (b.graze && Math.sin(f.time * 0.23 + a.seed * 40) > -0.35) a.bow = BOW_GROUND;
          b.t -= dt;
          if (b.t <= 0) this.penNext(g, i, night);
        } else {
          const ex = b.tx - a.x;
          const ez = b.tz - a.z;
          const dist = Math.hypot(ex, ez);
          if (dist > 0.3) {
            ty = Math.atan2(ex, ez);
            want = PEN_WALK * Math.min(1, 0.35 + dist / 1.5);
          } else if (!Number.isNaN(b.tyaw) && Math.abs(angDiff(b.tyaw, a.yaw)) > 0.06) ty = b.tyaw;
          else {
            b.mode = 1;
            b.t = b.eat !== 0 ? 15 + Math.random() * 30 : 6 + Math.random() * 16;
            b.graze = b.eat === 0 && Math.random() < 0.55;
          }
        }
      }
      // turn slowly; walk on once facing about the right way (creeping round meanwhile, so the
      // feet step through the turn), and stop short for anything close in front
      const err = angDiff(ty, a.yaw);
      const tr = PEN_TURN * dt;
      a.yaw += Math.max(-tr, Math.min(tr, err));
      let fwd = want > 0 ? want * Math.max(0.25, 1 - Math.abs(err) / 0.9) : b.mode === 2 && Math.abs(err) > 0.06 ? 0.15 : 0;
      if (fwd > 0 && this.penBlocked(g, a, px, pz)) {
        fwd = 0;
        b.mode = 1;
        b.t = 2 + Math.random() * 4;
        b.graze = false;
      }
      a.spd += (fwd - a.spd) * k(1.5);
      if (a.spd < 0.01) a.spd = 0;
      a.ph += (a.spd * dt) / a.stride;
      a.sit += Math.max(-dt * 0.45, Math.min(dt * 0.45, a.sitTarget - a.sit));
      let x = a.x;
      let z = a.z;
      if (a.spd > 0) {
        // never out past the margin: no step that takes it further out there
        this.penLocal(life, a.x, a.z);
        const u0 = this.penOut.u;
        const v0 = this.penOut.v;
        let u = u0 + (life.co * Math.sin(a.yaw) + life.si * Math.cos(a.yaw)) * a.spd * dt;
        let v = v0 + (-life.si * Math.sin(a.yaw) + life.co * Math.cos(a.yaw)) * a.spd * dt;
        const lu = P.hw - PEN_MARGIN + 0.3;
        const lv = P.hd - PEN_MARGIN + 0.3;
        if (Math.abs(u) > lu && Math.abs(u) > Math.abs(u0)) u = u0;
        if (Math.abs(v) > lv && Math.abs(v) > Math.abs(v0)) v = v0;
        x = P.x + life.co * u - life.si * v;
        z = P.z + life.si * u + life.co * v;
      }
      const d = Math.hypot(x - px, z - pz);
      const flat = !Number.isNaN(P.y);
      const y = flat ? P.y : this.groundAt(a, x, z, d);
      this.put(a, x, y, z, flat ? 0 : a.gnx, flat ? 1 : a.gny, flat ? 0 : a.gnz, g, dt, px, pz, 1 - ss(PEN_FADE0, PEN_R, d));
    }
  }

  private stepCamp(g: Group, f: FrameState, dt: number, px: number, pz: number): void {
    for (let i = 0; i < g.agents.length; i++) {
      const a = g.agents[i];
      if (a.free !== 0) continue; // ridden off, or left loose somewhere
      // Someone standing by the fire turns to whoever speaks to them.
      if (a === this.held && a.sit < 0.5) a.yaw += angDiff(Math.atan2(px - a.x, pz - a.z), a.yaw) * (1 - Math.exp(-dt * 4));
      this.put(a, a.x, a.y, a.z, a.nx, a.ny, a.nz, g, dt, px, pz);
    }
    const dist = Math.hypot(g.fx - px, g.fz - pz);
    const fade = (1 - ss(FADE0, RANGE, dist)) * (g.pres * g.pres * (3 - 2 * g.pres));
    if (fade < 0.02) return;
    for (let i = 0; i < g.props.length; i++) {
      const p = g.props[i];
      const n = this.nR;
      if (n >= CAP_PROP) break;
      const o = n * 4;
      this.rPos.arr[o] = p.x;
      this.rPos.arr[o + 1] = p.y - 0.02;
      this.rPos.arr[o + 2] = p.z;
      this.rPos.arr[o + 3] = p.yaw;
      this.rProp.arr[o] = p.type;
      this.rProp.arr[o + 1] = p.scale * fade;
      this.rProp.arr[o + 2] = 0;
      this.rProp.arr[o + 3] = 0;
      this.rCol.arr[o] = p.col[0];
      this.rCol.arr[o + 1] = p.col[1];
      this.rCol.arr[o + 2] = p.col[2];
      this.rCol.arr[o + 3] = 0;
      this.nR++;
    }
    // fire: one glow, four tongues, eight smoke puffs
    if (this.nF + 13 > CAP_FIRE) return;
    for (let i = 0; i < 13; i++) {
      const o = this.nF * 4;
      const kind = i === 0 ? 0 : i < 5 ? 1 : 2;
      this.fBase.arr[o] = g.fx;
      this.fBase.arr[o + 1] = g.fy;
      this.fBase.arr[o + 2] = g.fz;
      this.fBase.arr[o + 3] = fade;
      this.fKind.arr[o] = kind;
      this.fKind.arr[o + 1] = (g.fseed * 7.31 + i * 0.173) % 1;
      this.fKind.arr[o + 2] = kind === 2 ? ((i - 5) / 8 + g.fseed) % 1 : 0;
      this.fKind.arr[o + 3] = 0;
      this.nF++;
    }
    void f;
  }

  /**
   * Someone standing or sitting still picks where to look next: a glance aside for a few seconds
   * (a beast's whole neck, now and then up at the sky or down a little), then ahead again a while.
   */
  private idle(a: Agent): void {
    const r = Math.random();
    if (a.lookTo !== 0 && r < 0.65) {
      a.lookTo = 0;
      a.pitchTo = a.animal ? (Math.random() - 0.5) * 0.16 : 0;
      a.idleT = 4 + Math.random() * 10;
      return;
    }
    const side = Math.random() < 0.5 ? -1 : 1;
    a.lookTo = side * (a.animal ? 0.35 + Math.random() * 0.75 : 0.25 + Math.random() * 0.5);
    // (kneeling, the neck is already lifted: it only tips a little either way)
    a.pitchTo = !a.animal ? 0 : a.sit > 0.5 ? -0.12 + Math.random() * 0.3 : -0.3 + Math.random() * 0.45;
    a.idleT = 2 + Math.random() * 4;
  }

  private put(a: Agent, x: number, y: number, z: number, nx: number, ny: number, nz: number, g: Group, dt: number, px: number, pz: number, vis = 1): void {
    const dx = x - px;
    const dz = z - pz;
    const d = Math.hypot(dx, dz);
    // (kept so someone on the road can be found and spoken to)
    a.x = x;
    a.y = y;
    a.z = z;
    if (a.shown < 1) a.shown = Math.min(1, a.shown + dt / 3);
    if (d > RANGE) return;
    // (a camel out of its party goes with the rider, not with how far off its camp is)
    const pr = a.free !== 0 ? 1 : g.pres * g.pres * (3 - 2 * g.pres);
    const sc = a.scale * pr * vis * a.shown * (1 - ss(FADE0, RANGE, d));
    if (sc < 0.02) return;
    {
      // The head turns toward a player within 12 m (an animal's whole neck; a person's hood).
      // Otherwise someone still looks about now and then, and a beast eating keeps its head down.
      let target = 0;
      let bow = 0;
      let rate = 3;
      if (d < 12 && a !== this.held) {
        const c = Math.cos(a.yaw);
        const s = Math.sin(a.yaw);
        const lx = -dx * c + dz * s;
        const lz = -dx * s - dz * c;
        const ang = Math.atan2(lx, lz);
        target = a.animal ? Math.max(-1.1, Math.min(1.1, ang)) : Math.abs(ang) < 1.6 ? Math.max(-0.9, Math.min(0.9, ang)) : 0;
      } else if (a.spd < 0.05 && a !== this.held) {
        a.idleT -= dt;
        if (a.idleT <= 0) this.idle(a);
        const eating = a.bow > 0.5;
        target = eating ? a.lookTo * 0.3 : a.lookTo;
        bow = eating ? a.bow : a.pitchTo;
        rate = 1.1;
      }
      a.look += (target - a.look) * (1 - Math.exp(-dt * rate));
      a.pitch += (bow - a.pitch) * (1 - Math.exp(-dt * 0.9));
    }
    const amp = Math.min(1.25, a.spd / 1.3);
    const n = a.animal ? this.nA : this.nP;
    if (n >= (a.animal ? CAP_A : CAP_P)) return;
    const o = n * 4;
    const P = a.animal ? this.aPos : this.pPos;
    const U = a.animal ? this.aUp : this.pUp;
    const M = a.animal ? this.aMot : this.pMot;
    const C = a.animal ? this.aCoat : this.pCoat;
    const L = a.animal ? this.aLoad : this.pLoad;
    P.arr[o] = x;
    P.arr[o + 1] = y;
    P.arr[o + 2] = z;
    P.arr[o + 3] = a.yaw;
    U.arr[o] = nx;
    U.arr[o + 1] = ny;
    U.arr[o + 2] = nz;
    U.arr[o + 3] = a.look;
    M.arr[o] = a.ph;
    M.arr[o + 1] = amp;
    M.arr[o + 2] = a.sit;
    M.arr[o + 3] = sc;
    C.arr[o] = a.coat[0];
    C.arr[o + 1] = a.coat[1];
    C.arr[o + 2] = a.coat[2];
    C.arr[o + 3] = a.seed;
    L.arr[o] = a.load[0];
    L.arr[o + 1] = a.load[1];
    L.arr[o + 2] = a.load[2];
    L.arr[o + 3] = a.variant + (a.lamp ? 8 : 0);
    if (a.animal) this.aAux.arr[o] = a.pitch;
    if (a.animal) this.nA++;
    else this.nP++;
    if (a.lamp && this.nF < CAP_FIRE) {
      // the lantern's glow, where the left hand holds it
      const c = Math.cos(a.yaw);
      const s = Math.sin(a.yaw);
      const lx = -0.3 * sc;
      const lz = 0.06 * sc;
      const q = this.nF * 4;
      this.fBase.arr[q] = x + c * lx + s * lz;
      this.fBase.arr[q + 1] = y + (0.68 - 0.4 * a.sit) * sc;
      this.fBase.arr[q + 2] = z - s * lx + c * lz;
      this.fBase.arr[q + 3] = sc / a.scale;
      this.fKind.arr[q] = 3;
      this.fKind.arr[q + 1] = a.seed;
      this.fKind.arr[q + 2] = 0;
      this.fKind.arr[q + 3] = 0;
      this.nF++;
    }
  }
}
