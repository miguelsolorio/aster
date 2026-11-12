// Travellers and caravans on the open desert around cities.
// Four draw calls: pack animals, travellers, ground props, fire/smoke.
// Everything is instanced; all animation (walk, sit, sway, head turn) is in the vertex shaders.
import * as THREE from 'three';
import type { FrameState, SurfaceSample, Uniforms, World } from '../game/contract';
import type { CitySite } from './types';

const RANGE = 2500;
const FADE0 = 1200;
const CAP_A = 160;
const CAP_P = 160;
const CAP_PROP = 200;
const CAP_FIRE = 160;
const TAU = Math.PI * 2;

type V3 = [number, number, number];

// ------------------------------------------------------------------ geometry builder

interface Ring {
  c: V3;
  rx: number;
  rz: number;
  z?: number;
  w?: number;
}

class GB {
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
  else c = vec3(0.97, 0.95, 0.9);
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
uniform float uTime;
varying vec3 vW;
varying vec3 vN;
varying vec3 vCol;
varying float vY;
${common}
void main() {
  float vis = 1.0;
  if (aMP.y > 0.5) vis = mod(floor(iLoad.w / aMP.y + 0.01), 2.0);
  if (vis < 0.5 || iMot.w < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vW = vec3(0.0); vN = vec3(0.0, 1.0, 0.0); vCol = vec3(0.0); vY = 0.0;
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
    float pitch = (0.11 * g * sin(TAU * ph + 0.8) + 0.04 * sin(T * 0.9 + seed * 40.0) - 0.5 * sit) * w;
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
${common}
void main() {
  float vis = 1.0;
  if (aMP.y > 0.5) vis = mod(floor(iLoad.w / aMP.y + 0.01), 2.0);
  if (vis < 0.5 || iMot.w < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vW = vec3(0.0); vN = vec3(0.0, 1.0, 0.0); vCol = vec3(0.0); vY = 0.0;
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
${common}
void main() {
  if (abs(aMP.y - iProp.x) > 0.5 || iProp.y < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vW = vec3(0.0); vN = vec3(0.0, 1.0, 0.0); vCol = vec3(0.0); vY = 0.0;
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
void main() {
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float ndl = dot(n, uSunDir);
  float l = smoothstep(-0.35, 0.75, ndl);
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
  if (kind < 0.5) {
    float s = 7.0 * fade;
    wp = c + vec3(0.0, 0.9, 0.0) + right * q.x * s + vec3(0.0, 1.0, 0.0) * q.y * s * 0.8;
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
  if (vKind < 0.5) {
    float r = length(vUv);
    float a = pow(max(1.0 - r, 0.0), 2.2);
    float inten = (0.05 + 0.95 * uNight) * 0.55;
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

interface Agent {
  animal: boolean;
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
  dirSign: number;
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
}

interface Route {
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

// kind: 0 walking caravan, 1 camp, 2 lone walkers
interface Group {
  kind: number;
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
}

function routePoint(r: Route, s: number, out: { x: number; z: number }): void {
  const env = s <= 0 ? 0 : ss(0, 150, s);
  const m = env * (r.a1 * Math.sin(s * r.k1 + r.p1) + r.a2 * Math.sin(s * r.k2 + r.p2));
  out.x = r.ax + r.dx * s + r.px * m;
  out.z = r.az + r.dz * s + r.pz * m;
}

function newAgent(animal: boolean, rng: () => number): Agent {
  const coat = animal ? COATS[Math.floor(rng() * COATS.length)] : CLOAKS[Math.floor(rng() * CLOAKS.length)];
  const j = 0.9 + rng() * 0.2;
  const ld = LOADS[Math.floor(rng() * LOADS.length)];
  const vars = animal ? ANIMAL_LOADS : PERSON_LOADS;
  return {
    animal,
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
    dirSign: 1,
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
  };
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
  private readonly cities: { near(x: number, z: number): CitySite[] };

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
  private readonly live: Group[] = [];
  private refresh = 0;

  private readonly sample: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private readonly nrm = new THREE.Vector3();
  private readonly P0 = { x: 0, z: 0 };
  private readonly P1 = { x: 0, z: 0 };

  constructor(world: World, cities: { near(x: number, z: number): CitySite[] }, uniforms: Uniforms) {
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
    attach(this.animalGeo, ['iPos', 'iUp', 'iMot', 'iCoat', 'iLoad'], [this.aPos, this.aUp, this.aMot, this.aCoat, this.aLoad]);
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
    const nb = this.cities.near(site.cx, site.cz).filter((s) => s.id !== site.id);

    // walking caravans
    const nRoutes = 1 + (rng() < 0.6 ? 1 : 0);
    const bends = [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1];
    for (let k = 0; k < nRoutes; k++) {
      let base: number;
      const other = nb[k];
      if (other) base = Math.atan2(other.cz - site.cz, other.cx - site.cx) + (rng() - 0.5) * 0.5;
      else base = rng() * TAU + k * 2.2;
      const len = 1500 + rng() * 1000;
      let route: Route | null = null;
      for (const bd of bends) {
        const r = this.makeRoute(rng, site.cx, site.cz, base + bd, site.radius + 60, len, 40 + rng() * 50);
        if (this.routeClear(r)) {
          route = r;
          break;
        }
      }
      if (route) groups.push(this.buildCaravan(rng, route, site));
    }

    // resting camp
    const base = rng() * TAU;
    for (let k = 0; k < 10; k++) {
      const a = base + k * 0.62;
      const d = site.radius + 300 + rng() * 600;
      const x = site.cx + Math.cos(a) * d;
      const z = site.cz + Math.sin(a) * d;
      if (this.levelAt(x, z)) {
        groups.push(this.buildCamp(rng, x, z));
        break;
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
    return { kind, agents: [], route: null, ax, az, reach, pres: 0, active: false, maxO: 0, props: [], fx: 0, fy: 0, fz: 0, fseed: 0 };
  }

  private buildCaravan(rng: () => number, route: Route, site: CitySite): Group {
    void site;
    const g = this.emptyGroup(0, route.ax + route.dx * route.len * 0.5, route.az + route.dz * route.len * 0.5, route.len * 0.5 + 100);
    g.route = route;
    const na = 3 + Math.floor(rng() * 5);
    const np = 2 + Math.floor(rng() * 4);
    const spacing = 5.6 + rng() * 0.8;
    const tail = 9 + (na - 1) * spacing;
    for (let i = 0; i < na; i++) {
      const a = newAgent(true, rng);
      a.o = 9 + i * spacing;
      a.lat = (rng() - 0.5) * 0.5;
      g.agents.push(a);
    }
    for (let i = 0; i < np; i++) {
      const a = newAgent(false, rng);
      if (i === 0) {
        a.o = 0;
        a.lat = 0.8;
      } else if (i === np - 1) {
        a.o = tail + 4;
        a.lat = -0.6;
      } else {
        a.o = 6 + rng() * (tail - 6);
        a.lat = (i % 2 ? 1 : -1) * (2.3 + rng() * 0.9);
      }
      g.agents.push(a);
    }
    for (const a of g.agents) g.maxO = Math.max(g.maxO, a.o);
    for (const a of g.agents) {
      a.hi = route.len - a.o;
      a.lo = 25 + (g.maxO - a.o);
    }
    return g;
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
    }

    this.nA = 0;
    this.nP = 0;
    this.nR = 0;
    this.nF = 0;

    const walkOk = f.night < 0.6;
    for (let i = 0; i < this.live.length; i++) {
      const g = this.live[i];
      const inRange = Math.hypot(g.ax - px, g.az - pz) < RANGE + g.reach;
      const want = inRange && (g.kind === 1 || walkOk);
      g.pres = Math.min(1, Math.max(0, g.pres + (want ? 1 : -1) * dt * 0.4));
      if (g.pres <= 0 && !want) {
        g.active = false;
        continue;
      }
      if (!g.active) {
        g.active = true;
        this.snap(g, f);
      }
      if (g.kind === 0) this.stepCaravan(g, f, dt, px, pz);
      else if (g.kind === 2) this.stepWalkers(g, f, dt, px, pz);
      else this.stepCamp(g, f, dt, px, pz);
    }

    this.animalGeo.instanceCount = this.nA;
    this.personGeo.instanceCount = this.nP;
    this.propGeo.instanceCount = this.nR;
    this.fireGeo.instanceCount = this.nF;
    this.aPos.attr.needsUpdate = this.aUp.attr.needsUpdate = this.aMot.attr.needsUpdate = true;
    this.aCoat.attr.needsUpdate = this.aLoad.attr.needsUpdate = true;
    this.pPos.attr.needsUpdate = this.pUp.attr.needsUpdate = this.pMot.attr.needsUpdate = true;
    this.pCoat.attr.needsUpdate = this.pLoad.attr.needsUpdate = true;
    this.rPos.attr.needsUpdate = this.rProp.attr.needsUpdate = this.rCol.attr.needsUpdate = true;
    this.fBase.attr.needsUpdate = this.fKind.attr.needsUpdate = true;
  }

  /** Put a group where its schedule says it should be, used whenever it (re)appears. */
  private snap(g: Group, f: FrameState): void {
    const r = g.route;
    if (g.kind === 1 || !r) return;
    if (g.kind === 2) {
      for (const a of g.agents) {
        const t = (f.time * a.vmax + a.s) % (2 * r.len);
        a.s = t > r.len ? 2 * r.len - t : t;
        a.dirSign = t > r.len ? -1 : 1;
        a.spd = a.vmax;
        this.faceRoute(a, r);
      }
      return;
    }
    const day = f.day;
    const dir = day < 0.5 ? 1 : -1;
    const frac = dir > 0 ? Math.min(1, Math.max(0, (day - 0.22) / 0.26)) : 1 - Math.min(1, Math.max(0, (day - 0.5) / 0.3));
    for (const a of g.agents) {
      const s = dir > 0 ? frac * r.len - a.o : frac * r.len + 25 + (g.maxO - a.o);
      a.s = Math.min(a.hi, Math.max(a.lo, s));
      a.dirSign = dir;
      a.sit = 0;
      a.sitTarget = 0;
      a.spd = 0;
      a.drift = 0;
      this.faceRoute(a, r);
    }
  }

  private faceRoute(a: Agent, r: Route): void {
    routePoint(r, a.s, this.P0);
    routePoint(r, a.s + 3, this.P1);
    a.yaw = Math.atan2(this.P1.x - this.P0.x, this.P1.z - this.P0.z) + (a.dirSign < 0 ? Math.PI : 0);
  }

  private stepCaravan(g: Group, f: FrameState, dt: number, px: number, pz: number): void {
    const dirWanted = f.day < 0.5 ? 1 : -1;
    for (let i = 0; i < g.agents.length; i++) this.stepRouteAgent(g, g.agents[i], dirWanted, false, f, dt, px, pz);
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
      if (a.dirSign > 0 && a.s >= r.len) a.dirSign = -1;
      else if (a.dirSign < 0 && a.s <= 0) a.dirSign = 1;
      mv = a.dirSign;
    } else {
      mv = dirWanted;
      if (mv > 0 && a.s >= a.hi) mv = 0;
      if (mv < 0 && a.s <= a.lo) mv = 0;
      if (mv !== 0) a.dirSign = mv;
    }
    const ty = Math.atan2(tx, tz) + (a.dirSign < 0 ? Math.PI : 0);
    const err = angDiff(ty, a.yaw);
    const tr = (a.animal ? 1.0 : 1.8) * dt;
    a.yaw += Math.max(-tr, Math.min(tr, err));
    const go = mv !== 0 && Math.abs(err) < 0.5 && a.sit < 0.3;
    a.spd += ((go ? a.vmax : 0) - a.spd) * k(1.5);
    if (a.spd < 0.01) a.spd = 0;
    a.s += a.dirSign * a.spd * dt;
    if (bounce) a.s = Math.min(r.len, Math.max(0, a.s));
    else a.s = Math.min(a.hi, Math.max(a.lo, a.s));
    a.ph += (a.spd * dt) / a.stride;
    a.sitTarget = !bounce && mv === 0 && a.spd < 0.15 ? 1 : 0;
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
    const x = this.P0.x + tz * lat;
    const z = this.P0.z - tx * lat;
    const w = this.world;
    const y = w.height(x, z);
    w.normal(x, z, this.nrm);
    this.put(a, x, y, z, this.nrm.x, this.nrm.y, this.nrm.z, g, dt, px, pz);
  }

  private stepCamp(g: Group, f: FrameState, dt: number, px: number, pz: number): void {
    for (let i = 0; i < g.agents.length; i++) {
      const a = g.agents[i];
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

  private put(a: Agent, x: number, y: number, z: number, nx: number, ny: number, nz: number, g: Group, dt: number, px: number, pz: number): void {
    const dx = x - px;
    const dz = z - pz;
    const d = Math.hypot(dx, dz);
    if (d > RANGE) return;
    const pr = g.pres * g.pres * (3 - 2 * g.pres);
    const sc = a.scale * pr * (1 - ss(FADE0, RANGE, d));
    if (sc < 0.02) return;
    if (a.animal) {
      // head turns toward a player within 12 m
      let target = 0;
      if (d < 12) {
        const c = Math.cos(a.yaw);
        const s = Math.sin(a.yaw);
        const lx = -dx * c + dz * s;
        const lz = -dx * s - dz * c;
        const ang = Math.atan2(lx, lz);
        target = Math.max(-1.1, Math.min(1.1, ang));
      }
      a.look += (target - a.look) * (1 - Math.exp(-dt * 3));
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
    L.arr[o + 3] = a.variant;
    if (a.animal) this.nA++;
    else this.nP++;
  }
}
