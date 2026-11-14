import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import type { Building, CityPlan, Room } from './types';
import { rectFaces, type Face } from './rooms';
import { GLOW, MAT, createCutUniforms, type CutUniforms, createGlowMaterial, createMasonryMaterial, createWaterMaterial, trackViewport } from './cityShaders';

// Turns a CityPlan into meshes. Everything is written straight into growable typed arrays
// and merged per material family:
//   near: masonry (1 draw), cloth (1), plants (1), water (0..1), glows (1)
//   far:  masonry skyline (1), glows (1)
// Walls stand exactly on each footprint and every walkable roof is exactly at b.h; all detail
// (openings, parapets, crowns) is either cut into the wall or sits on the roof inside the footprint,
// except beam ends, spouts and awnings, which project a little over the lanes above head height.

export interface CityMeshes {
  /** The cut-away of the building the wanderer is in, shared by the near masonry and the interiors. */
  cut: CutUniforms;
  /** Full-detail city. Children are in city-local space; the integrator positions and rotates the group. */
  near: THREE.Group;
  /** Simplified skyline for viewing from 1.5 to 9 km away, same local space. */
  far: THREE.Group;
  /** Every door the near city cut into its walls (local, on the wall plane, outward normal). */
  doors: Array<{ x: number; z: number; nx: number; nz: number; w: number }>;
  dispose(): void;
}

const STOREY = 3.2;
/** Walls start a little below the plateau so the terrain blend never shows a seam. */
export const FOOT = -0.5;
/** Water level of the pool, relative to the plateau. The terrain must dip below it inside the rim. */
export const POOL_LEVEL = 0.06; // just above the plateau: the terrain is not carved under the pool
const EPS = 1e-4;
/** Garden beds: top of the stone kerb and of the soil inside it (plants stand on the soil). */
const BED_RIM = 0.38;
export const BED_SOIL = BED_RIM - 0.08;

// ------------------------------------------------------------------ hashing

function hashInt(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const hashU = (a: number, b: number, c: number): number => hashInt(a, b, c) / 4294967296;

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

// ------------------------------------------------------------------ geometry writer

/**
 * Growable typed-array mesh: position f32x3, normal i8x3 (normalized), aInfo u8x4
 * (material, tint, window seed, stripes/sway; read as 0..255 floats), aUv u8x2 (normalized).
 */
export class Writer {
  pos: Float32Array;
  nrm: Int8Array;
  info: Uint8Array;
  uvs: Uint8Array;
  idx: Uint32Array;
  nv = 0;
  ni = 0;
  mat = 0;
  tint = 128;
  seed = 0;
  extra = 0;

  constructor(v = 4096, i = 8192) {
    this.pos = new Float32Array(v * 3);
    this.nrm = new Int8Array(v * 3);
    this.info = new Uint8Array(v * 4);
    this.uvs = new Uint8Array(v * 2);
    this.idx = new Uint32Array(i);
  }

  get tris(): number {
    return this.ni / 3;
  }

  reserve(nv: number, ni: number): void {
    if (this.nv + nv > this.pos.length / 3) {
      const cap = Math.max((this.pos.length / 3) * 2, this.nv + nv);
      const p = new Float32Array(cap * 3);
      p.set(this.pos);
      this.pos = p;
      const n = new Int8Array(cap * 3);
      n.set(this.nrm);
      this.nrm = n;
      const f = new Uint8Array(cap * 4);
      f.set(this.info);
      this.info = f;
      const u = new Uint8Array(cap * 2);
      u.set(this.uvs);
      this.uvs = u;
    }
    if (this.ni + ni > this.idx.length) {
      const ix = new Uint32Array(Math.max(this.idx.length * 2, this.ni + ni));
      ix.set(this.idx);
      this.idx = ix;
    }
  }

  /** Writes one vertex; reserve() must have been called. */
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    const i = this.nv++;
    const p = i * 3;
    this.pos[p] = x;
    this.pos[p + 1] = y;
    this.pos[p + 2] = z;
    this.nrm[p] = Math.round(nx * 127);
    this.nrm[p + 1] = Math.round(ny * 127);
    this.nrm[p + 2] = Math.round(nz * 127);
    const q = i * 4;
    this.info[q] = this.mat;
    this.info[q + 1] = this.tint;
    this.info[q + 2] = this.seed;
    this.info[q + 3] = this.extra;
    const w = i * 2;
    this.uvs[w] = Math.round(clamp(u, 0, 1) * 255);
    this.uvs[w + 1] = Math.round(clamp(v, 0, 1) * 255);
    return i;
  }

  index3(a: number, b: number, c: number): void {
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = b;
    this.idx[this.ni++] = c;
  }

  /** Quad from a loop of corners a b c d with face normal n; winding is fixed to face n. uv (0,0) (1,0) (1,1) (0,1). */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
  ): void {
    this.reserve(4, 6);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const s = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    const a = this.vert(ax, ay, az, nx, ny, nz, 0, 0);
    const b = this.vert(bx, by, bz, nx, ny, nz, 1, 0);
    const c = this.vert(cx, cy, cz, nx, ny, nz, 1, 1);
    const d = this.vert(dx, dy, dz, nx, ny, nz, 0, 1);
    if (s >= 0) {
      this.index3(a, b, c);
      this.index3(a, c, d);
    } else {
      this.index3(a, c, b);
      this.index3(a, d, c);
    }
  }

  /** Quad with the normal taken from its own corners, flipped to agree with the hint (hx, hy, hz). */
  quadAuto(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    hx: number, hy: number, hz: number,
  ): void {
    const ux = cx - ax, uy = cy - ay, uz = cz - az;
    const vx = dx - bx, vy = dy - by, vz = dz - bz;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    if (nx * hx + ny * hy + nz * hz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    this.quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz);
  }

  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    nx: number, ny: number, nz: number,
  ): void {
    this.reserve(3, 3);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const s = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    const a = this.vert(ax, ay, az, nx, ny, nz, 0, 0);
    const b = this.vert(bx, by, bz, nx, ny, nz, 1, 0);
    const c = this.vert(cx, cy, cz, nx, ny, nz, 0.5, 1);
    if (s >= 0) this.index3(a, b, c);
    else this.index3(a, c, b);
  }

  /** Triangle with its own face normal, oriented toward the hint. */
  triAuto(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
  ): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    if (nx * hx + ny * hy + nz * hz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz);
  }

  /** Axis-aligned box. mask bits: 1 +x, 2 -x, 4 +y, 8 -y, 16 +z, 32 -z. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mask = 55): void {
    if (mask & 1) this.quad(x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0, 1, 0, 0);
    if (mask & 2) this.quad(x0, y0, z1, x0, y0, z0, x0, y1, z0, x0, y1, z1, -1, 0, 0);
    if (mask & 4) this.quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, 0, 1, 0);
    if (mask & 8) this.quad(x0, y0, z0, x0, y0, z1, x1, y0, z1, x1, y0, z0, 0, -1, 0);
    if (mask & 16) this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1);
    if (mask & 32) this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1);
  }

  /** Reorders every triangle so its winding agrees with its vertex normals (needed for two-sided lighting). */
  orient(): void {
    const P = this.pos, N = this.nrm, I = this.idx;
    for (let t = 0; t < this.ni; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const sx = N[a] + N[b] + N[c], sy = N[a + 1] + N[b + 1] + N[c + 1], sz = N[a + 2] + N[b + 2] + N[c + 2];
      if ((uy * vz - uz * vy) * sx + (uz * vx - ux * vz) * sy + (ux * vy - uy * vx) * sz < 0) {
        const k = I[t + 1];
        I[t + 1] = I[t + 2];
        I[t + 2] = k;
      }
    }
  }

  geometry(): THREE.BufferGeometry | null {
    if (this.ni === 0) return null;
    const nv = this.nv;
    const g = new THREE.BufferGeometry();
    const pos = this.pos.slice(0, nv * 3);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, nv * 3), 3, true));
    g.setAttribute('aInfo', new THREE.BufferAttribute(this.info.slice(0, nv * 4), 4, false));
    g.setAttribute('aUv', new THREE.BufferAttribute(this.uvs.slice(0, nv * 2), 2, true));
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.ni), 1));
    setBounds(g, pos);
    return g;
  }
}

function setBounds(g: THREE.BufferGeometry, pos: Float32Array): void {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
}

// ------------------------------------------------------------------ glows

export class Glows {
  readonly d: number[] = [];
  get count(): number {
    return this.d.length / 7;
  }
  add(x: number, y: number, z: number, r: number, kind: number, seed: number, bright: number): void {
    this.d.push(x, y, z, r, kind, seed, bright);
  }
  geometry(): THREE.BufferGeometry | null {
    const n = this.count;
    if (n === 0) return null;
    const pos = new Float32Array(n * 12);
    const corner = new Float32Array(n * 8);
    const glow = new Float32Array(n * 16);
    const idx = new Uint32Array(n * 6);
    const C = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < n; i++) {
      const s = i * 7;
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        pos[v * 3] = this.d[s];
        pos[v * 3 + 1] = this.d[s + 1];
        pos[v * 3 + 2] = this.d[s + 2];
        corner[v * 2] = C[k * 2];
        corner[v * 2 + 1] = C[k * 2 + 1];
        glow[v * 4] = this.d[s + 3];
        glow[v * 4 + 1] = this.d[s + 4];
        glow[v * 4 + 2] = this.d[s + 5];
        glow[v * 4 + 3] = this.d[s + 6];
      }
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('aGlow', new THREE.BufferAttribute(glow, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    setBounds(g, pos);
    // pad the bounds by the largest halo
    g.boundingSphere!.radius += 4;
    return g;
  }
}

// ------------------------------------------------------------------ faces and openings

/** Faces of a regular prism around (cx, cz) with corner radius r. */
function prismFaces(cx: number, cz: number, r: number, sides: number, rot: number): Face[] {
  const out: Face[] = [];
  for (let k = 0; k < sides; k++) {
    const a0 = rot + (k / sides) * Math.PI * 2;
    const a1 = rot + ((k + 1) / sides) * Math.PI * 2;
    const x0 = cx + Math.cos(a0) * r, z0 = cz + Math.sin(a0) * r;
    const x1 = cx + Math.cos(a1) * r, z1 = cz + Math.sin(a1) * r;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const am = (a0 + a1) / 2;
    out.push({ ox: x0, oz: z0, tx: (x1 - x0) / len, tz: (z1 - z0) / len, nx: Math.cos(am), nz: Math.sin(am), len });
  }
  return out;
}

export interface Hole {
  u0: number;
  u1: number;
  y0: number;
  y1: number;
  /** Depth of the reveal. */
  d: number;
  /** Material of the back of the opening. */
  back: number;
  seed: number;
  /** Rise of the arch at the top, 0 for a flat lintel. */
  arch: number;
  /** Segments per half arch. */
  k: number;
  /** 0 round .. 1 sharply pointed. */
  point: number;
  /** Open right through the wall (a walk-in doorway): no back, the reveal is the wall's thickness. */
  through?: boolean;
}

export const px = (f: Face, u: number, off: number): number => f.ox + f.tx * u + f.nx * off;
export const pz = (f: Face, u: number, off: number): number => f.oz + f.tz * u + f.nz * off;

/** Quad in the plane of a face, offset off along its normal. */
export function faceQuad(w: Writer, f: Face, u0: number, u1: number, y0: number, y1: number, off: number): void {
  w.quad(
    px(f, u0, off), y0, pz(f, u0, off),
    px(f, u1, off), y0, pz(f, u1, off),
    px(f, u1, off), y1, pz(f, u1, off),
    px(f, u0, off), y1, pz(f, u0, off),
    f.nx, 0, f.nz,
  );
}

/** Box in face coordinates (u, y, off), without its back (off0) face. mask: 1 front, 2 top, 4 bottom, 8 start (-t), 16 end (+t). */
function faceBox(
  w: Writer, f: Face, u0: number, u1: number, y0: number, y1: number, o0: number, o1: number, mask = 31,
): void {
  if (mask & 1) faceQuad(w, f, u0, u1, y0, y1, o1);
  const ax = px(f, u0, o0), az = pz(f, u0, o0);
  const bx = px(f, u1, o0), bz = pz(f, u1, o0);
  const cx = px(f, u1, o1), cz = pz(f, u1, o1);
  const dx = px(f, u0, o1), dz = pz(f, u0, o1);
  if (mask & 2) w.quad(ax, y1, az, bx, y1, bz, cx, y1, cz, dx, y1, dz, 0, 1, 0);
  if (mask & 4) w.quad(ax, y0, az, bx, y0, bz, cx, y0, cz, dx, y0, dz, 0, -1, 0);
  if (mask & 8) w.quad(ax, y0, az, dx, y0, dz, dx, y1, dz, ax, y1, az, -f.tx, 0, -f.tz);
  if (mask & 16) w.quad(bx, y0, bz, cx, y0, cz, cx, y1, cz, bx, y1, bz, f.tx, 0, f.tz);
}

/** A wall face from y0 to y1 with rectangular (optionally arched) openings cut through it. */
export function wallFace(w: Writer, f: Face, y0: number, y1: number, holes: Hole[]): void {
  if (y1 - y0 < EPS || f.len < EPS) return;
  if (holes.length === 0) {
    faceQuad(w, f, 0, f.len, y0, y1, 0);
    return;
  }
  holes.sort((a, b) => a.u0 - b.u0);
  const ys = [y0, y1];
  for (const h of holes) ys.push(h.y0, h.y1);
  ys.sort((a, b) => a - b);
  let prev = -Infinity;
  for (let s = 0; s < ys.length - 1; s++) {
    const ya = Math.max(ys[s], y0);
    const yb = Math.min(ys[s + 1], y1);
    if (yb - ya < EPS || ya < prev - EPS) continue;
    prev = yb;
    let cur = 0;
    for (const h of holes) {
      if (h.y0 <= ya + EPS && h.y1 >= yb - EPS) {
        if (h.u0 > cur + EPS) faceQuad(w, f, cur, h.u0, ya, yb, 0);
        cur = Math.max(cur, h.u1);
      }
    }
    if (cur < f.len - EPS) faceQuad(w, f, cur, f.len, ya, yb, 0);
  }
  for (const h of holes) holeGeometry(w, f, h);
}

function holeGeometry(w: Writer, f: Face, h: Hole): void {
  const { u0, u1, y0, y1, d } = h;
  const wallMat = w.mat;
  const ys = h.arch > 0 ? y1 - h.arch : y1;
  if (!h.through) {
    w.mat = h.back;
    w.seed = h.seed;
    faceQuad(w, f, u0, u1, y0, y1, -d);
    w.seed = 0;
    w.mat = wallMat;
  }
  const tx = f.tx, tz = f.tz;
  if (d < EPS) {
    // a cut with no depth (the inner face of a doorway): only the spandrels of its arch
    if (h.arch > 0) arch(w, f, h, ys, 0);
    return;
  }
  // side reveals
  w.quad(px(f, u0, 0), y0, pz(f, u0, 0), px(f, u0, -d), y0, pz(f, u0, -d), px(f, u0, -d), ys, pz(f, u0, -d), px(f, u0, 0), ys, pz(f, u0, 0), tx, 0, tz);
  w.quad(px(f, u1, 0), y0, pz(f, u1, 0), px(f, u1, -d), y0, pz(f, u1, -d), px(f, u1, -d), ys, pz(f, u1, -d), px(f, u1, 0), ys, pz(f, u1, 0), -tx, 0, -tz);
  // sill
  w.quad(px(f, u0, 0), y0, pz(f, u0, 0), px(f, u1, 0), y0, pz(f, u1, 0), px(f, u1, -d), y0, pz(f, u1, -d), px(f, u0, -d), y0, pz(f, u0, -d), 0, 1, 0);
  if (h.arch <= 0) {
    w.quad(px(f, u0, 0), y1, pz(f, u0, 0), px(f, u1, 0), y1, pz(f, u1, 0), px(f, u1, -d), y1, pz(f, u1, -d), px(f, u0, -d), y1, pz(f, u0, -d), 0, -1, 0);
    return;
  }
  arch(w, f, h, ys, d);
}

/** The arch over an opening: spandrels in the wall plane and, given a depth, the soffit. */
function arch(w: Writer, f: Face, h: Hole, ys: number, d: number): void {
  const { u0, u1, y1 } = h;
  const tx = f.tx, tz = f.tz;
  // curve points from the left springing over the apex to the right springing
  const K = h.k;
  const hw = (u1 - u0) / 2;
  const p = h.point;
  const cu: number[] = [];
  const cy: number[] = [];
  for (let i = 0; i <= 2 * K; i++) {
    const left = i <= K;
    const q = left ? i / K : (2 * K - i) / K;
    const a = q * Math.PI * 0.5;
    const du = hw * ((1 - p) * (1 - Math.cos(a)) + p * q);
    const yf = (1 - p) * Math.sin(a) + p * q;
    cu.push(left ? u0 + du : u1 - du);
    cy.push(ys + h.arch * yf);
  }
  cy[K] = y1;
  cu[K] = u0 + hw;
  for (let i = 0; i < 2 * K; i++) {
    const cornerU = i < K ? u0 : u1;
    // spandrel in the wall plane
    w.tri(
      px(f, cornerU, 0), y1, pz(f, cornerU, 0),
      px(f, cu[i], 0), cy[i], pz(f, cu[i], 0),
      px(f, cu[i + 1], 0), cy[i + 1], pz(f, cu[i + 1], 0),
      f.nx, 0, f.nz,
    );
    // soffit
    if (d < EPS) continue;
    const du = cu[i + 1] - cu[i];
    const dy = cy[i + 1] - cy[i];
    const l = Math.hypot(du, dy) || 1;
    const nu = dy / l;
    const ny = -du / l;
    w.quad(
      px(f, cu[i], 0), cy[i], pz(f, cu[i], 0),
      px(f, cu[i + 1], 0), cy[i + 1], pz(f, cu[i + 1], 0),
      px(f, cu[i + 1], -d), cy[i + 1], pz(f, cu[i + 1], -d),
      px(f, cu[i], -d), cy[i], pz(f, cu[i], -d),
      tx * nu, ny, tz * nu,
    );
  }
}

/** A room's doorway as a through-hole in a face whose u runs `shift` metres behind the outer one, `d` deep. */
export function doorHole(room: Room, shift: number, d: number): Hole {
  const r = room.door;
  return {
    u0: r.u0 - shift, u1: r.u1 - shift, y0: 0, y1: r.top, d, back: MAT.opening, seed: 0,
    arch: r.arch, k: r.portal ? 7 : 4, point: r.portal ? 0.4 : 0.3, through: true,
  };
}

function overlaps(holes: Hole[], u0: number, u1: number, y0: number, y1: number, m: number): boolean {
  for (const h of holes) {
    if (u0 < h.u1 + m && u1 > h.u0 - m && y0 < h.y1 + m && y1 > h.y0 - m) return true;
  }
  return false;
}

// ------------------------------------------------------------------ round shapes

/** Smooth dome of radius r and height hgt on base y0; point 0 = round, up to ~0.5 = pointed. */
export function dome(w: Writer, cx: number, cz: number, r: number, y0: number, hgt: number, segs: number, rings: number, point: number): void {
  const nv = (rings + 1) * (segs + 1);
  w.reserve(nv, rings * segs * 6);
  const base = w.nv;
  const prof = (t: number): [number, number] => {
    const a = t * Math.PI * 0.5;
    return [r * ((1 - point) * Math.cos(a) + point * (1 - Math.sin(a))), hgt * Math.sin(a)];
  };
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const [rho, y] = prof(t);
    const ta = Math.max(0, t - 0.01), tb = Math.min(1, t + 0.01);
    const pa = prof(ta), pb = prof(tb);
    let nr = pb[1] - pa[1];
    let ny = -(pb[0] - pa[0]);
    const l = Math.hypot(nr, ny) || 1;
    nr /= l;
    ny /= l;
    if (j === rings) {
      nr = 0;
      ny = 1;
    }
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      w.vert(cx + c * rho, y0 + y, cz + s * rho, c * nr, ny, s * nr, i / segs, t);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a = base + j * (segs + 1) + i;
      const b = a + 1;
      const c = a + segs + 1;
      const d = c + 1;
      // outward winding (counter-clockwise seen from outside); the top ring meets in a point
      w.index3(a, c, b);
      if (j < rings - 1) w.index3(b, c, d);
    }
  }
}

/** Smooth vertical cylinder wall (no caps). */
export function cylinder(w: Writer, cx: number, cz: number, r: number, y0: number, y1: number, segs: number): void {
  w.reserve((segs + 1) * 2, segs * 6);
  const base = w.nv;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    w.vert(cx + c * r, y0, cz + s * r, c, 0, s, i / segs, 0);
    w.vert(cx + c * r, y1, cz + s * r, c, 0, s, i / segs, 1);
  }
  for (let i = 0; i < segs; i++) {
    const a = base + i * 2;
    w.index3(a, a + 1, a + 2);
    w.index3(a + 2, a + 1, a + 3);
  }
}

/** Flat ring (annulus) facing up or down. */
export function annulus(w: Writer, cx: number, cz: number, r0: number, r1: number, y: number, segs: number, up: boolean): void {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    w.quad(cx + c0 * r0, y, cz + s0 * r0, cx + c1 * r0, y, cz + s1 * r0, cx + c1 * r1, y, cz + s1 * r1, cx + c0 * r1, y, cz + s0 * r1, 0, up ? 1 : -1, 0);
  }
}

/** Faceted tapering prism from radius r0 at y0 to r1 at y1 (r1 = 0 makes a pyramid). Flat-shaded. */
export function taper(w: Writer, cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, sides: number, rot: number): void {
  for (let k = 0; k < sides; k++) {
    const a0 = rot + (k / sides) * Math.PI * 2, a1 = rot + ((k + 1) / sides) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const hx = Math.cos(am), hz = Math.sin(am);
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    if (r1 <= 1e-3) {
      w.triAuto(cx + c0 * r0, y0, cz + s0 * r0, cx + c1 * r0, y0, cz + s1 * r0, cx, y1, cz, hx, 0.3, hz);
    } else {
      w.quadAuto(cx + c0 * r0, y0, cz + s0 * r0, cx + c1 * r0, y0, cz + s1 * r0, cx + c1 * r1, y1, cz + s1 * r1, cx + c0 * r1, y1, cz + s0 * r1, hx, 0.2, hz);
    }
  }
}

/** Flat polygon cap (fan), facing up. */
export function polyCap(w: Writer, cx: number, cz: number, r: number, y: number, sides: number, rot: number): void {
  for (let k = 0; k < sides; k++) {
    const a0 = rot + (k / sides) * Math.PI * 2, a1 = rot + ((k + 1) / sides) * Math.PI * 2;
    w.tri(cx, y, cz, cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r, 0, 1, 0);
  }
}

/** A small faceted orb on a needle. */
export function finial(w: Writer, cx: number, y: number, cz: number, s: number): void {
  taper(w, cx, cz, s * 0.12, s * 0.06, y, y + s * 0.6, 4, Math.PI / 4);
  const yc = y + s * 0.85;
  const r = s * 0.28;
  // octahedron
  const P: Array<[number, number, number]> = [
    [r, 0, 0], [0, 0, r], [-r, 0, 0], [0, 0, -r],
  ];
  for (let k = 0; k < 4; k++) {
    const a = P[k], b = P[(k + 1) % 4];
    const hx = a[0] + b[0], hz = a[2] + b[2];
    w.triAuto(cx + a[0], yc, cz + a[2], cx + b[0], yc, cz + b[2], cx, yc + r * 1.3, cz, hx, 0.5, hz);
    w.triAuto(cx + a[0], yc, cz + a[2], cx + b[0], yc, cz + b[2], cx, yc - r, cz, hx, -0.5, hz);
  }
  taper(w, cx, cz, s * 0.05, 0, yc + r * 1.2, yc + s * 0.9, 4, Math.PI / 4);
}

// ------------------------------------------------------------------ per-building layout shared by near and far

type ParapetStyle = 'plain' | 'crenel' | 'corner';

interface Layout {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Parapet base height above h (0 = none) and merlon top above h. */
  pb: number;
  pm: number;
  style: ParapetStyle;
  /** Terrace block footprint, or null. */
  block: { x0: number; z0: number; x1: number; z1: number; h: number } | null;
  /** Round crown (dome) centre and radius, drum and dome heights. */
  dome: { cx: number; cz: number; r: number; drum: number; hgt: number; point: number; great: boolean } | null;
  tower: { cx: number; cz: number; s: number; top: number } | null;
  spire: { cx: number; cz: number; r: number; lantern0: number; lantern1: number; top: number } | null;
  turrets: { s: number; hgt: number } | null;
}

export function layoutOf(plan: CityPlan, b: Building, i: number): Layout {
  const seed = plan.site.seed | 0;
  const H = (k: number): number => hashU(seed, i, k);
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  const L: Layout = { x0, z0, x1, z1, pb: 0, pm: 0, style: 'plain', block: null, dome: null, tower: null, spire: null, turrets: null };
  const minWD = Math.min(b.w, b.d);
  const landmark = b.role === 'landmark';
  const crowned = b.roof === 'dome' || b.roof === 'spire' || b.roof === 'windtower';
  let parapet = b.roof === 'parapet' || b.roof === 'terrace' || landmark || b.role === 'gate' || b.role === 'wall';
  if (!parapet && crowned) parapet = H(1) < 0.6;
  if (parapet && minWD >= 2) {
    const ph = 0.5 + 0.4 * H(2);
    const r = H(3);
    L.style = landmark || b.role === 'gate' || b.role === 'wall' ? 'crenel' : r < 0.2 ? 'crenel' : r < 0.42 ? 'corner' : 'plain';
    if (L.style === 'crenel') {
      L.pb = b.role === 'wall' || b.role === 'gate' ? 0.7 : ph * 0.55;
      L.pm = b.role === 'wall' || b.role === 'gate' ? 1.6 : ph + 0.35;
    } else {
      L.pb = ph;
      L.pm = L.style === 'corner' ? ph + 0.35 : ph;
    }
  }
  const crown = Math.max(0, b.crown);
  const inset = L.pb > 0 ? 0.3 : 0;
  if (b.roof === 'terrace' && minWD >= 5) {
    const bw = Math.max(2, Math.round(b.w * (0.4 + 0.2 * H(4))));
    const bd = Math.max(2, Math.round(b.d * (0.4 + 0.2 * H(5))));
    const c = Math.floor(H(6) * 4);
    const bx0 = c & 1 ? x1 - bw : x0;
    const bz0 = c & 2 ? z1 - bd : z0;
    L.block = { x0: bx0, z0: bz0, x1: bx0 + bw, z1: bz0 + bd, h: b.h + (crown >= 1.8 ? crown : 2.6) };
  } else if (b.roof === 'dome' && minWD >= 2.5) {
    let r = minWD / 2 - inset - 0.25;
    const great = landmark;
    if (!great) r = Math.min(r, 9);
    let turrets: Layout['turrets'] = null;
    if (great && minWD >= 14) {
      const s = clamp(minWD * 0.12, 2, 4);
      turrets = { s, hgt: clamp(crown * 0.3, 3, 7) };
      r = Math.min(r, Math.SQRT2 * (minWD / 2 - inset - s) - 0.6);
    }
    L.turrets = turrets;
    const c = crown > 0.5 ? crown : r * 1.1;
    const drum = great ? clamp(c * 0.22, 1.5, 5) : clamp(c * 0.16, 0.3, 1.2);
    const fin = great ? clamp(c * 0.1, 1.2, 3) : 0;
    L.dome = {
      cx: b.x, cz: b.z, r, drum, great,
      hgt: Math.max(0.6, c - drum - fin),
      point: great ? 0.32 : H(7) < 0.45 ? 0.28 : 0,
    };
  } else if (b.roof === 'windtower' && minWD >= 3) {
    const s = clamp(minWD * 0.28, 1.6, 3.2);
    const c = Math.floor(H(8) * 4);
    const off = inset + 0.15 + s / 2;
    const cx = c & 1 ? x1 - off : x0 + off;
    const cz = c & 2 ? z1 - off : z0 + off;
    L.tower = { cx, cz, s, top: b.h + (crown > 1 ? crown : 3.5) };
  } else if (b.roof === 'spire' && minWD >= 2) {
    const r = clamp(minWD * (landmark ? 0.22 : 0.18), 0.9, landmark ? 3.2 : 2.2);
    const top = b.h + (crown > 2 ? crown : 10);
    const span = top - b.h;
    const lh = clamp(r * 1.5, 1.8, 4);
    const lantern1 = top - Math.max(r * 1.6, span * 0.1);
    L.spire = { cx: b.x, cz: b.z, r, lantern0: lantern1 - lh, lantern1, top };
  }
  return L;
}

// ------------------------------------------------------------------ the near city

class NearBuilder {
  readonly w = new Writer(1 << 16, 1 << 17);
  readonly cloth = new Writer(4096, 8192);
  readonly plants = new Writer(4096, 8192);
  readonly glows = new Glows();
  readonly doors: CityMeshes['doors'] = [];
  /** The room each enterable building holds, by building index. */
  private readonly rooms = new Map<number, Room>();
  private readonly grid: Float32Array;
  private readonly gs: number;
  private readonly gh: number;
  private readonly seed: number;
  /** Window spacing multiplier, raised for very dense plans to keep the triangle budget. */
  private readonly density: number;

  constructor(private readonly plan: CityPlan) {
    this.grid = plan.grid;
    this.gs = plan.gridSize | 0;
    this.gh = plan.gridHalf;
    this.seed = plan.site.seed | 0;
    for (const r of plan.rooms) this.rooms.set(r.bi, r);
    // rough count of the windows the plan would get at the normal spacing (about half the facade is exposed)
    let est = 0;
    for (const b of plan.buildings) {
      if (!b.solid || b.role === 'wall' || b.roof === 'canopy' || b.roof === 'none') continue;
      est += (((b.w + b.d) * 2) / 3.7) * Math.max(1, Math.floor((b.h + 0.4) / STOREY)) * 0.5;
    }
    this.density = Math.max(1, est / WINDOW_BUDGET);
  }

  /** Roof height of the cell containing local (x, z); 0 for open ground or outside the grid. */
  H(x: number, z: number): number {
    const i = Math.floor(x + this.gh);
    const j = Math.floor(z + this.gh);
    if (i < 0 || j < 0 || i >= this.gs || j >= this.gs) return 0;
    return this.grid[j * this.gs + i] || 0;
  }

  /** Height of the neighbour just outside a face at u (out metres from the wall). */
  nb(f: Face, u: number, out = 0.5): number {
    return this.H(px(f, u, out), pz(f, u, out));
  }

  /** Neighbour height over a span of the face (max). */
  nbSpan(f: Face, u0: number, u1: number): number {
    let m = 0;
    for (let u = Math.max(0.5, Math.floor(u0) + 0.5); u < u1; u += 1) m = Math.max(m, this.nb(f, u));
    return Math.max(m, this.nb(f, Math.min(u1, f.len - 0.01)), this.nb(f, Math.max(u0, 0.01)));
  }

  hidden(f: Face, top: number): boolean {
    for (let u = 0.5; u < f.len; u += 1) if (this.nb(f, u) < top - 0.01) return false;
    return true;
  }

  /** How many metres of open ground lie straight out from the face at u. */
  street(f: Face, u: number, max = 8): number {
    for (let k = 0; k < max; k++) if (this.nb(f, u, k + 0.5) > 0) return k;
    return max;
  }

  build(): void {
    const bs = this.plan.buildings;
    for (let i = 0; i < bs.length; i++) this.building(bs[i], i);
    this.lamps();
    this.pool();
  }

  private tintByte(t: number): number {
    return clamp(Math.round(t * 255), 0, 255);
  }

  private building(b: Building, i: number): void {
    const rng = makeRng(hashInt(this.seed, i, 0x51));
    const w = this.w;
    w.tint = this.tintByte(b.tint);
    w.seed = 0;
    w.extra = 0;
    if (!b.solid || b.roof === 'canopy' || b.roof === 'none') {
      if (b.roof === 'canopy') this.canopy(b, rng);
      else if (b.role === 'garden') this.garden(b);
      else if (b.role === 'stall') this.stall(b, rng);
      else if (b.solid && b.h > 0.2) this.plainBox(b, i);
      return;
    }
    const L = layoutOf(this.plan, b, i);
    if (b.role === 'wall') this.rampart(b, L, rng);
    else this.blockBuilding(b, L, rng, i);
  }

  /** Solid thing with roof 'none' and no special role: just a plain plastered block. */
  private plainBox(b: Building, i: number): void {
    const L = layoutOf(this.plan, b, i);
    const w = this.w;
    w.mat = MAT.plaster;
    for (const f of rectFaces(L.x0, L.z0, L.x1, L.z1)) if (!this.hidden(f, b.h)) faceQuad(w, f, 0, f.len, FOOT, b.h, 0);
    w.mat = MAT.roof;
    w.quad(L.x0, b.h, L.z0, L.x1, b.h, L.z0, L.x1, b.h, L.z1, L.x0, b.h, L.z1, 0, 1, 0);
  }

  // ---------------------------------------------------------------- houses, halls, markets, gates, landmarks

  private blockBuilding(b: Building, L: Layout, rng: () => number, i: number): void {
    const w = this.w;
    const landmark = b.role === 'landmark';
    const gate = b.role === 'gate';
    const hall = b.role === 'hall' || b.role === 'market';
    const wallMat = landmark || gate ? MAT.stone : MAT.plaster;
    const top = b.h + L.pb;
    const faces = rectFaces(L.x0, L.z0, L.x1, L.z1);
    const holes: Hole[][] = [[], [], [], []];
    const hid = faces.map((f) => this.hidden(f, top));
    const litChance = clamp(0.15 + 0.5 * hashU(this.seed, i, 0x77), 0, 0.75);
    const lit = (): number => (rng() < litChance ? 1 + Math.floor(rng() * 254) : 0);
    const arcadeFace = [false, false, false, false];
    const room = this.rooms.get(i) ?? null;
    let doorway: Hole | null = null;
    if (room) {
      // the walk-in doorway, open right through the wall (a landmark's is its great portal)
      const d = room.door;
      doorway = doorHole(room, 0, room.t);
      if (!d.portal) holes[d.fi].push(doorway);
      const f = faces[d.fi];
      const uc = (d.u0 + d.u1) / 2;
      this.doors.push({ x: px(f, uc, 0), z: pz(f, uc, 0), nx: f.nx, nz: f.nz, w: d.u1 - d.u0 });
      this.curtain(f, room, rng);
    }

    // ground openings: gate portals, arcades for halls and landmarks, doors for houses
    if (gate) {
      let any = false;
      for (let fi = 0; fi < 4; fi++) {
        const f = faces[fi];
        if (hid[fi] || f.len < 4) continue;
        if (this.street(f, f.len / 2, 4) < 3) continue;
        const pw = Math.min(f.len * 0.5, 4.5);
        const ph = Math.min(b.h * 0.6, 6.5);
        const u0 = (f.len - pw) / 2;
        holes[fi].push({ u0, u1: u0 + pw, y0: 0, y1: ph, d: 1.4, back: MAT.wood, seed: 0, arch: pw * 0.55, k: 6, point: 0.45 });
        any = true;
      }
      if (!any) {
        // no open side found: put the portal on the longest visible face
        let best = -1;
        for (let fi = 0; fi < 4; fi++) if (!hid[fi] && (best < 0 || faces[fi].len > faces[best].len)) best = fi;
        if (best >= 0 && faces[best].len >= 4) {
          const f = faces[best];
          const pw = Math.min(f.len * 0.5, 4.5);
          const u0 = (f.len - pw) / 2;
          holes[best].push({ u0, u1: u0 + pw, y0: 0, y1: Math.min(b.h * 0.6, 6.5), d: 1.4, back: MAT.wood, seed: 0, arch: pw * 0.55, k: 6, point: 0.45 });
        }
      }
    } else if (hall || landmark) {
      const bw = landmark ? 2.4 : 2.0;
      const bayH = Math.min(landmark ? 4.2 : 3.0, b.h - 0.8);
      const step = landmark ? 3.8 : 3.4;
      for (let fi = 0; fi < 4; fi++) {
        const f = faces[fi];
        if (hid[fi] || f.len < 5 || bayH < 2.2) continue;
        if (this.street(f, f.len / 2, 4) < 2) continue;
        arcadeFace[fi] = true;
        // landmarks get one great arched portal in the middle of each open face
        let portal: Hole | null = null;
        if (landmark && f.len >= 10 && b.h >= 7) {
          const pw = Math.min(f.len * 0.3, 8);
          const ph = Math.min(b.h * 0.75, 12);
          const u0 = (f.len - pw) / 2;
          portal = { u0, u1: u0 + pw, y0: 0, y1: ph, d: 2.4, back: MAT.opening, seed: lit(), arch: pw * 0.6, k: 7, point: 0.4 };
          if (doorway && room && room.door.portal && room.door.fi === fi) portal = doorway;
          holes[fi].push(portal);
        }
        const n = Math.floor((f.len - 1.2) / step);
        for (let k = 0; k < n; k++) {
          const uc = ((k + 0.5) * f.len) / n;
          const u0 = uc - bw / 2, u1 = uc + bw / 2;
          if (u0 < 0.6 || u1 > f.len - 0.6) continue;
          if (overlaps(holes[fi], u0, u1, 0, bayH, 0.5)) continue;
          if (this.nbSpan(f, u0, u1) > 0) continue;
          holes[fi].push({ u0, u1, y0: 0, y1: bayH, d: 0.9, back: MAT.opening, seed: rng() < 0.25 ? lit() : 0, arch: bw * 0.5, k: 4, point: 0.3 });
        }
      }
    }
    if (!gate) {
      // doors on street-facing sides
      const cands: Array<{ fi: number; u: number; s: number }> = [];
      for (let fi = 0; fi < 4; fi++) {
        const f = faces[fi];
        if (hid[fi] || arcadeFace[fi] || f.len < 2.6) continue;
        for (let u = 1.3; u <= f.len - 1.3; u += 1) {
          if (this.nb(f, u - 0.8) > 0 || this.nb(f, u + 0.8) > 0) continue;
          const s = this.street(f, u, 6);
          if (s >= 2) cands.push({ fi, u, s });
        }
      }
      const want = b.role === 'house' ? (rng() < 0.3 ? 2 : 1) : 2;
      let placed = room ? 1 : 0; // the doorway is one of them
      for (let tries = 0; tries < 12 && placed < want && cands.length > 0; tries++) {
        const c = cands[Math.floor(rng() * cands.length)];
        const f = faces[c.fi];
        const dw = landmark ? 2.0 : 1.0 + rng() * 0.35;
        const dh = Math.min(landmark ? 3.4 : 2.25 + rng() * 0.35, b.h - 0.5);
        if (dh < 1.9) break;
        const u0 = c.u - dw / 2, u1 = c.u + dw / 2;
        if (u0 < 0.4 || u1 > f.len - 0.4 || overlaps(holes[c.fi], u0, u1, 0, dh, 1.2)) continue;
        const arched = landmark || rng() < 0.45;
        holes[c.fi].push({
          u0, u1, y0: 0, y1: dh, d: 0.45, back: rng() < 0.55 ? MAT.wood : MAT.opening,
          seed: rng() < 0.2 ? lit() : 0, arch: arched ? dw * 0.5 : 0, k: 3, point: 0.3,
        });
        this.doors.push({ x: px(f, c.u, 0), z: pz(f, c.u, 0), nx: f.nx, nz: f.nz, w: dw });
        placed++;
      }
    }

    // windows, storey by storey
    const storeys = Math.max(1, Math.floor((b.h + 0.4) / STOREY));
    const spacing = ((landmark ? 3.4 : 3.0) + hashU(this.seed, i, 0x31) * 1.4) * this.density;
    const skipP = landmark ? 0.05 : 0.14;
    const archWin = landmark || (hall && rng() < 0.6);
    for (let fi = 0; fi < 4; fi++) {
      const f = faces[fi];
      if (hid[fi] || f.len < 2) continue;
      let cols = Math.floor((f.len - 0.6) / spacing);
      if (cols < 1) cols = 1;
      for (let k = 0; k < storeys; k++) {
        const yb = k * STOREY;
        let ww: number, wh: number, sill: number;
        if (gate) {
          if (k === 0) continue;
          ww = 0.28;
          wh = 1.1;
          sill = yb + 1.2;
        } else if (k === 0) {
          ww = 0.6;
          wh = 0.65;
          sill = yb + 1.35;
        } else {
          ww = landmark ? 0.9 : 0.7;
          wh = landmark ? 1.6 : 1.05 + 0.2 * hashU(this.seed, i, 0x32);
          sill = yb + 0.95;
        }
        const y1 = sill + wh;
        if (y1 > b.h - 0.5) continue;
        for (let c = 0; c < cols; c++) {
          const uc = ((c + 0.5) * f.len) / cols;
          const u0 = uc - ww / 2, u1 = uc + ww / 2;
          if (u0 < 0.45 || u1 > f.len - 0.45) continue;
          if ((k === 0 || gate) && rng() < 0.4) continue;
          if (rng() < skipP) continue;
          if (overlaps(holes[fi], u0, u1, sill, y1, 0.35)) continue;
          if (this.nbSpan(f, u0, u1) > sill - 0.3) continue;
          const s = gate ? 0 : lit();
          const arch = archWin && k > 0 ? ww * 0.5 : 0;
          holes[fi].push({ u0, u1, y0: sill, y1, d: gate ? 0.4 : 0.32, back: MAT.opening, seed: s, arch, k: 3, point: 0.3 });
          if (s > 0) this.windowGlow(f, uc, (sill + y1) / 2, s);
        }
      }
    }

    // a hollow building's openings stop short of its room (the doorway goes right through)
    if (room) for (const hs of holes) for (const h of hs) if (!h.through) h.d = Math.min(h.d, room.t - 0.06);
    w.mat = wallMat;
    w.tint = this.tintByte(b.tint);
    for (let fi = 0; fi < 4; fi++) if (!hid[fi] || (room && room.door.fi === fi)) wallFace(w, faces[fi], FOOT, top, holes[fi]);
    // the walkable roof, exactly at h
    w.mat = landmark || gate ? MAT.stone : MAT.roof;
    w.quad(L.x0, b.h, L.z0, L.x1, b.h, L.z0, L.x1, b.h, L.z1, L.x0, b.h, L.z1, 0, 1, 0);
    w.mat = wallMat;
    if (L.pb > 0) this.parapet(L.x0, L.z0, L.x1, L.z1, b.h, L, faces);

    // roof-line details
    if (!gate && !landmark) {
      const r = rng();
      if (r < 0.28 && L.pb < 0.75) this.beams(b, faces, hid, holes, rng);
      else if (r < 0.62) this.spouts(b, L, faces, hid, rng);
      if (b.h <= 9.6) this.awnings(b, faces, hid, holes, arcadeFace, rng);
    }

    if (L.block) this.terraceBlock(b, L, rng, litChance);
    if (L.dome) this.domeCrown(b, L, rng);
    if (L.tower) this.windTower(b, L);
    if (L.spire) this.spireCrown(b, L);
    if (L.turrets) this.turrets(b, L);
  }

  /** A cloth hung in a doorway: a valance under the lintel and the two halves drawn back to the jambs. */
  private curtain(f: Face, room: Room, rng: () => number): void {
    const c = this.cloth;
    const d = room.door;
    const spring = d.top - d.arch;
    const off = -Math.min(0.12, room.t * 0.3);
    c.mat = MAT.cloth;
    c.tint = Math.floor(rng() * 255);
    c.extra = rng() < 0.5 ? Math.max(2, Math.round((d.u1 - d.u0) / 0.3)) : 0;
    const drop = Math.min(0.42, (spring - 1.9) * 0.5 + 0.18);
    if (d.arch <= 0) faceQuad(c, f, d.u0, d.u1, spring - drop, spring, off);
    // the drawn-back halves: a little wider at the foot, where they hang loose
    const side = d.portal ? 0.5 : 0.2;
    for (const s of [1, -1]) {
      const ua = s > 0 ? d.u0 : d.u1;
      const ub = ua + s * side;
      const uf = ua + s * side * 1.4;
      c.quadAuto(
        px(f, ua, off), 0.02, pz(f, ua, off), px(f, uf, off), 0.02, pz(f, uf, off),
        px(f, ub, off), spring, pz(f, ub, off), px(f, ua, off), spring, pz(f, ua, off),
        f.nx, 0, f.nz,
      );
    }
    c.extra = 0;
  }

  private windowGlow(f: Face, u: number, y: number, s: number): void {
    const bright = 0.55 + 0.75 * (((s / 255) * 13.7) % 1);
    const x = px(f, u, 0.15), z = pz(f, u, 0.15);
    this.glows.add(x, y, z, 0.45, GLOW.window, s / 255, bright);
  }

  /** Low wall round the roof edge, inside the footprint, standing on the roof at h. */
  private parapet(x0: number, z0: number, x1: number, z1: number, h: number, L: Layout, faces: Face[]): void {
    const w = this.w;
    const t = 0.3;
    const yb = h + L.pb;
    const xi0 = x0 + t, xi1 = x1 - t, zi0 = z0 + t, zi1 = z1 - t;
    if (xi1 <= xi0 || zi1 <= zi0) return;
    // inner faces
    w.quad(xi1, h, zi0, xi1, h, zi1, xi1, yb, zi1, xi1, yb, zi0, -1, 0, 0);
    w.quad(xi0, h, zi1, xi0, h, zi0, xi0, yb, zi0, xi0, yb, zi1, 1, 0, 0);
    w.quad(xi1, h, zi1, xi0, h, zi1, xi0, yb, zi1, xi1, yb, zi1, 0, 0, -1);
    w.quad(xi0, h, zi0, xi1, h, zi0, xi1, yb, zi0, xi0, yb, zi0, 0, 0, 1);
    // copings
    w.quad(x0, yb, z0, x1, yb, z0, x1, yb, zi0, x0, yb, zi0, 0, 1, 0);
    w.quad(x0, yb, zi1, x1, yb, zi1, x1, yb, z1, x0, yb, z1, 0, 1, 0);
    w.quad(x0, yb, zi0, xi0, yb, zi0, xi0, yb, zi1, x0, yb, zi1, 0, 1, 0);
    w.quad(xi1, yb, zi0, x1, yb, zi0, x1, yb, zi1, xi1, yb, zi1, 0, 1, 0);
    const ym = h + L.pm;
    if (L.style === 'crenel') {
      for (let fi = 0; fi < 4; fi++) {
        const f = faces[fi];
        const ml = 0.9, gap = 0.75;
        const n = Math.max(1, Math.floor((f.len + gap) / (ml + gap)));
        const span = n * ml + (n - 1) * gap;
        const s0 = (f.len - span) / 2;
        for (let k = 0; k < n; k++) {
          const u0 = s0 + k * (ml + gap);
          const u1 = u0 + ml;
          // the face frame runs along the outer wall; merlons occupy off in [-t, 0]
          faceBox(w, f, Math.max(u0, 0), Math.min(u1, f.len), yb, ym, -t, 0, 1 | 2 | 8 | 16);
          faceQuad(w, { ...f, nx: -f.nx, nz: -f.nz }, Math.max(u0, 0), Math.min(u1, f.len), yb, ym, t);
        }
      }
    } else if (L.style === 'corner') {
      const s = 0.65;
      w.box(x0, yb, z0, x0 + s, ym, z0 + s);
      w.box(x1 - s, yb, z0, x1, ym, z0 + s);
      w.box(x0, yb, z1 - s, x0 + s, ym, z1);
      w.box(x1 - s, yb, z1 - s, x1, ym, z1);
    }
  }

  private beams(b: Building, faces: Face[], hid: boolean[], holes: Hole[][], rng: () => number): void {
    const w = this.w;
    w.mat = MAT.wood;
    const y = b.h - 0.5;
    let done = 0;
    for (let fi = 0; fi < 4 && done < 2; fi++) {
      const f = faces[fi];
      if (hid[fi] || rng() < 0.4) continue;
      for (let u = 0.7; u < f.len - 0.5; u += 1.35) {
        if (this.nb(f, u) > y - 0.5 || overlaps(holes[fi], u - 0.12, u + 0.12, y, y + 0.22, 0.1)) continue;
        faceBox(w, f, u - 0.11, u + 0.11, y, y + 0.22, 0, 0.45 + 0.15 * rng(), 31);
      }
      done++;
    }
    w.mat = MAT.plaster;
  }

  private spouts(b: Building, L: Layout, faces: Face[], hid: boolean[], rng: () => number): void {
    const w = this.w;
    const n = 1 + Math.floor(rng() * 2);
    for (let k = 0; k < n; k++) {
      const fi = Math.floor(rng() * 4);
      const f = faces[fi];
      if (hid[fi] || f.len < 2) continue;
      const u = 0.8 + rng() * (f.len - 1.6);
      if (this.nb(f, u) > b.h - 1) continue;
      w.mat = rng() < 0.5 ? MAT.wood : MAT.stone;
      const y = b.h + Math.min(L.pb, 0.15) - 0.05;
      faceBox(w, f, u - 0.1, u + 0.1, y - 0.14, y, 0, 0.75, 31);
    }
    w.mat = MAT.plaster;
  }

  /** Cloth awnings over the ground floor on avenue fronts. */
  private awnings(b: Building, faces: Face[], hid: boolean[], holes: Hole[][], arcade: boolean[], rng: () => number): void {
    const c = this.cloth;
    for (let fi = 0; fi < 4; fi++) {
      const f = faces[fi];
      if (hid[fi] || arcade[fi] || f.len < 3.5) continue;
      if (this.street(f, f.len / 2, 7) < 6 || rng() < 0.62) continue;
      const aw = Math.min(f.len - 1, 2.4 + rng() * 2);
      const u0 = 0.5 + rng() * (f.len - 1 - aw);
      const u1 = u0 + aw;
      if (overlaps(holes[fi], u0, u1, 2.35, 3.0, 0.05)) continue;
      const ya = 2.95, yb = 2.5, dep = 1.2 + rng() * 0.4;
      c.mat = MAT.cloth;
      c.tint = Math.floor(rng() * 255);
      c.extra = rng() < 0.5 ? Math.max(2, Math.round(aw / 0.35)) : 0;
      c.quadAuto(
        px(f, u0, 0.03), ya, pz(f, u0, 0.03), px(f, u1, 0.03), ya, pz(f, u1, 0.03),
        px(f, u1, dep), yb, pz(f, u1, dep), px(f, u0, dep), yb, pz(f, u0, dep),
        0, 1, 0,
      );
      // valance
      faceQuad(c, f, u0, u1, yb - 0.22, yb, dep);
      c.extra = 0;
      // two thin wooden struts back to the wall (the awning is cantilevered: nothing in the lane)
      const wv = this.w;
      wv.mat = MAT.wood;
      for (const u of [u0 + 0.1, u1 - 0.1]) {
        wv.quadAuto(
          px(f, u - 0.03, 0), ya - 0.7, pz(f, u - 0.03, 0), px(f, u + 0.03, 0), ya - 0.7, pz(f, u + 0.03, 0),
          px(f, u + 0.03, dep * 0.8), yb - 0.02, pz(f, u + 0.03, dep * 0.8), px(f, u - 0.03, dep * 0.8), yb - 0.02, pz(f, u - 0.03, dep * 0.8),
          f.nx, -1, f.nz,
        );
      }
      wv.mat = MAT.plaster;
    }
  }

  private terraceBlock(b: Building, L: Layout, rng: () => number, litChance: number): void {
    const B = L.block!;
    const w = this.w;
    const faces = rectFaces(B.x0, B.z0, B.x1, B.z1);
    const top = B.h;
    // a face is flush when it lies on the building's outer wall
    const flush = [B.x1 === L.x1, B.x0 === L.x0, B.z1 === L.z1, B.z0 === L.z0];
    const stairFace = (() => {
      const steps = Math.ceil((top - b.h) / 0.32);
      const need = steps * 0.32 + 0.6;
      const roomX = (L.x1 - L.x0) - (B.x1 - B.x0) - 0.3;
      const roomZ = (L.z1 - L.z0) - (B.z1 - B.z0) - 0.3;
      for (let fi = 0; fi < 4; fi++) {
        if (flush[fi] || faces[fi].len < need) continue;
        const room = fi < 2 ? roomX : roomZ;
        if (room >= 1.2) return fi;
      }
      return -1;
    })();
    for (let fi = 0; fi < 4; fi++) {
      const f = faces[fi];
      const y0 = flush[fi] ? b.h + L.pb : b.h;
      const holes: Hole[] = [];
      if (fi !== stairFace && top - b.h >= 2.4) {
        const sill = b.h + 0.95;
        const y1 = Math.min(sill + 1.0, top - 0.45);
        const cols = Math.max(1, Math.floor((f.len - 0.6) / 2.8));
        for (let c = 0; c < cols; c++) {
          const uc = ((c + 0.5) * f.len) / cols;
          if (rng() < 0.3 || y1 - sill < 0.5) continue;
          if (flush[fi] && this.nbSpan(f, uc - 0.35, uc + 0.35) > sill - 0.3) continue;
          const s = rng() < litChance ? 1 + Math.floor(rng() * 254) : 0;
          holes.push({ u0: uc - 0.35, u1: uc + 0.35, y0: sill, y1, d: 0.3, back: MAT.opening, seed: s, arch: 0, k: 3, point: 0 });
          if (s > 0) this.windowGlow(f, uc, (sill + y1) / 2, s);
        }
        if (!flush[fi] && f.len >= 2.4 && rng() < 0.7) {
          const uc = f.len * (0.3 + 0.4 * rng());
          if (!overlaps(holes, uc - 0.5, uc + 0.5, b.h, b.h + 2.1, 0.3)) {
            holes.push({ u0: uc - 0.45, u1: uc + 0.45, y0: b.h, y1: Math.min(b.h + 2.1, top - 0.4), d: 0.35, back: MAT.wood, seed: 0, arch: 0, k: 3, point: 0 });
          }
        }
      }
      wallFace(w, f, y0, top, holes);
    }
    w.mat = MAT.roof;
    w.quad(B.x0, top, B.z0, B.x1, top, B.z0, B.x1, top, B.z1, B.x0, top, B.z1, 0, 1, 0);
    w.mat = MAT.plaster;
    // a thin lip round the block's roof
    const lip = 0.25;
    for (const f of faces) {
      faceBox(w, f, 0, f.len, top, top + lip, -0.2, 0, 1 | 2);
      faceQuad(w, { ...f, nx: -f.nx, nz: -f.nz }, 0.2, f.len - 0.2, top, top + lip, 0.2);
    }
    if (stairFace >= 0) {
      const f = faces[stairFace];
      const rise = top - b.h;
      const steps = Math.ceil(rise / 0.32);
      const rr = rise / steps;
      const run = 0.32;
      const us = f.len - steps * run - 0.15;
      for (let k = 0; k < steps; k++) {
        const u0 = us + k * run;
        faceBox(w, f, u0, u0 + run, b.h, b.h + (k + 1) * rr, 0, 0.95, k === steps - 1 ? 1 | 2 | 8 | 16 : 1 | 2 | 8);
      }
    }
  }

  private domeCrown(b: Building, L: Layout, rng: () => number): void {
    const D = L.dome!;
    const w = this.w;
    const y0 = b.h;
    const segs = D.great ? 40 : D.r > 4 ? 16 : 12;
    const rings = D.great ? 14 : D.r > 4 ? 7 : 5;
    w.mat = D.great ? MAT.stone : MAT.plaster;
    let rd = D.r;
    if (D.great) {
      // a sixteen-sided drum pierced by arched windows
      const sides = 16;
      const fs = prismFaces(D.cx, D.cz, D.r, sides, 0);
      const fl = fs[0].len;
      for (const f of fs) {
        const hw = Math.min(fl * 0.22, 0.8);
        const hy0 = y0 + D.drum * 0.28, hy1 = y0 + D.drum * 0.82;
        const holes: Hole[] = [];
        if (hy1 - hy0 > 0.9 && fl > 1.2) {
          const s = rng() < 0.45 ? 1 + Math.floor(rng() * 254) : 0;
          holes.push({ u0: fl / 2 - hw, u1: fl / 2 + hw, y0: hy0, y1: hy1, d: 0.5, back: MAT.opening, seed: s, arch: hw, k: 3, point: 0.35 });
          if (s > 0) this.windowGlow(f, fl / 2, (hy0 + hy1) / 2, s);
        }
        wallFace(w, f, y0, y0 + D.drum, holes);
      }
      // cornice ring, then the dome sits a little in from the drum
      const ry = y0 + D.drum;
      polyRing(w, D.cx, D.cz, D.r * 0.9, D.r + 0.35, ry, ry + 0.4, sides);
      rd = D.r * 0.97;
      w.mat = MAT.dome;
      dome(w, D.cx, D.cz, rd, ry + 0.4, D.hgt, segs, rings, D.point);
      w.mat = MAT.stone;
      finial(w, D.cx, ry + 0.4 + D.hgt * 0.985, D.cz, clamp(D.r * 0.18, 1.2, 3));
      // a lantern at the crown for the night skyline
      this.glows.add(D.cx, ry + 0.4 + D.hgt + 0.6, D.cz, 0.9, GLOW.lantern, 0.5, 0.8);
    } else {
      cylinder(w, D.cx, D.cz, D.r, y0, y0 + D.drum, segs);
      annulus(w, D.cx, D.cz, D.r * 0.9, D.r, y0 + D.drum, segs, true);
      w.mat = MAT.roof;
      dome(w, D.cx, D.cz, D.r * 0.9, y0 + D.drum, D.hgt, segs, rings, D.point);
      if (D.point > 0) {
        w.mat = MAT.wood;
        taper(w, D.cx, D.cz, 0.06, 0, y0 + D.drum + D.hgt * 0.97, y0 + D.drum + D.hgt + 0.5, 4, 0);
      }
    }
    w.mat = MAT.plaster;
  }

  private windTower(b: Building, L: Layout): void {
    const T = L.tower!;
    const w = this.w;
    const h2 = T.s / 2;
    const capT = 0.25;
    const top = T.top - capT;
    const faces = rectFaces(T.cx - h2, T.cz - h2, T.cx + h2, T.cz + h2);
    const slotH = Math.min(1.8, (top - b.h) * 0.35);
    w.mat = MAT.plaster;
    for (const f of faces) {
      const holes: Hole[] = [];
      const n = T.s >= 2.4 ? 3 : 2;
      for (let k = 0; k < n; k++) {
        const uc = ((k + 0.5) * f.len) / n;
        holes.push({ u0: uc - 0.15, u1: uc + 0.15, y0: top - 0.25 - slotH, y1: top - 0.25, d: 0.35, back: MAT.opening, seed: 0, arch: 0, k: 1, point: 0 });
      }
      wallFace(w, f, b.h, top, holes);
    }
    w.mat = MAT.roof;
    w.box(T.cx - h2 - 0.15, top, T.cz - h2 - 0.15, T.cx + h2 + 0.15, T.top, T.cz + h2 + 0.15, 63 & ~8);
    w.mat = MAT.plaster;
  }

  private spireCrown(b: Building, L: Layout): void {
    const S = L.spire!;
    const w = this.w;
    const sides = 8;
    const rot = Math.PI / 8;
    const r0 = S.r;
    const rl = S.r * 0.68;
    w.mat = b.role === 'landmark' ? MAT.stone : MAT.plaster;
    // shaft with a balcony part way up
    const mid = b.h + (S.lantern0 - b.h) * 0.55;
    const rm = r0 + (rl - r0) * 0.55;
    taper(w, S.cx, S.cz, r0, rm, b.h, mid, sides, rot);
    if (S.lantern0 - b.h > 8) {
      polyRing(w, S.cx, S.cz, rm, rm + 0.35, mid, mid + 0.35, sides, rot);
      taper(w, S.cx, S.cz, rm, rl, mid + 0.35, S.lantern0, sides, rot);
    } else {
      taper(w, S.cx, S.cz, rm, rl, mid, S.lantern0, sides, rot);
    }
    // the lantern chamber: a slightly wider band with openings that glow at night
    polyRing(w, S.cx, S.cz, rl, rl + 0.2, S.lantern0 - 0.2, S.lantern0, sides, rot);
    const fs = prismFaces(S.cx, S.cz, rl + 0.08, sides, rot);
    for (let k = 0; k < sides; k++) {
      const f = fs[k];
      const holes: Hole[] = [];
      const hw = f.len * 0.28;
      if (k % 2 === 0 && hw > 0.12) {
        holes.push({ u0: f.len / 2 - hw, u1: f.len / 2 + hw, y0: S.lantern0 + 0.35, y1: S.lantern1 - 0.3, d: 0.25, back: MAT.lantern, seed: 0, arch: hw, k: 2, point: 0.4 });
      }
      wallFace(w, f, S.lantern0, S.lantern1, holes);
    }
    polyRing(w, S.cx, S.cz, rl + 0.08, rl + 0.35, S.lantern1, S.lantern1 + 0.25, sides, rot);
    w.mat = b.role === 'landmark' ? MAT.dome : MAT.roof;
    taper(w, S.cx, S.cz, rl + 0.25, 0, S.lantern1 + 0.25, S.top, sides, rot);
    w.mat = MAT.plaster;
    this.glows.add(S.cx, (S.lantern0 + S.lantern1) / 2, S.cz, Math.max(0.9, rl * 1.1), GLOW.lantern, 0.3, 1.0);
  }

  private turrets(b: Building, L: Layout): void {
    const T = L.turrets!;
    const w = this.w;
    const inset = L.pb > 0 ? 0.3 : 0;
    const s = T.s;
    const corners = [
      [L.x0 + inset, L.z0 + inset],
      [L.x1 - inset - s, L.z0 + inset],
      [L.x0 + inset, L.z1 - inset - s],
      [L.x1 - inset - s, L.z1 - inset - s],
    ];
    for (const [x, z] of corners) {
      const top = b.h + T.hgt;
      const faces = rectFaces(x, z, x + s, z + s);
      w.mat = MAT.stone;
      for (const f of faces) {
        const holes: Hole[] = [];
        if (T.hgt > 2.5) holes.push({ u0: f.len / 2 - 0.2, u1: f.len / 2 + 0.2, y0: top - 2.1, y1: top - 0.8, d: 0.35, back: MAT.opening, seed: 0, arch: 0.2, k: 2, point: 0.4 });
        wallFace(w, f, b.h, top, holes);
      }
      w.quad(x, top, z, x + s, top, z, x + s, top, z + s, x, top, z + s, 0, 1, 0);
      w.mat = MAT.dome;
      dome(w, x + s / 2, z + s / 2, s * 0.42, top, s * 0.55, 12, 5, 0.3);
    }
    w.mat = MAT.plaster;
  }

  // ---------------------------------------------------------------- ramparts

  private rampart(b: Building, L: Layout, rng: () => number): void {
    const w = this.w;
    const top = b.h + L.pb;
    const faces = rectFaces(L.x0, L.z0, L.x1, L.z1);
    const hid = faces.map((f) => this.hidden(f, top));
    // the outer side is the long side farther from the city centre
    const alongX = b.w >= b.d;
    const outerFi = alongX ? (Math.abs(L.z1) > Math.abs(L.z0) ? 2 : 3) : Math.abs(L.x1) > Math.abs(L.x0) ? 0 : 1;
    w.mat = MAT.stone;
    w.tint = this.tintByte(b.tint);
    for (let fi = 0; fi < 4; fi++) {
      if (hid[fi]) continue;
      const f = faces[fi];
      const holes: Hole[] = [];
      if (fi === outerFi && b.h > 4) {
        const ys = b.h - 2.4;
        for (let u = 3 + rng() * 4; u < f.len - 2; u += 7 + rng() * 4) {
          if (this.nbSpan(f, u - 0.2, u + 0.2) > ys - 0.3) continue;
          holes.push({ u0: u - 0.13, u1: u + 0.13, y0: ys, y1: ys + 1.0, d: 0.35, back: MAT.opening, seed: 0, arch: 0, k: 1, point: 0 });
        }
      }
      wallFace(w, f, FOOT, top, holes);
    }
    w.quad(L.x0, b.h, L.z0, L.x1, b.h, L.z0, L.x1, b.h, L.z1, L.x0, b.h, L.z1, 0, 1, 0);
    // parapet: low on the inside, merlons on the outer side
    const t = 0.4;
    const yb = top;
    const ym = b.h + L.pm;
    for (let fi = 0; fi < 4; fi++) {
      const f = faces[fi];
      if (f.len < 1) continue;
      const long = alongX ? fi >= 2 : fi < 2;
      if (!long) continue;
      // inner face and coping of the base course
      faceQuad(w, { ...f, nx: -f.nx, nz: -f.nz }, 0, f.len, b.h, yb, t);
      faceBox(w, f, 0, f.len, yb - 0.001, yb, -t, 0, 2);
      if (fi === outerFi) {
        const ml = 1.1, gap = 0.9;
        const n = Math.max(1, Math.floor((f.len + gap) / (ml + gap)));
        const s0 = (f.len - (n * ml + (n - 1) * gap)) / 2;
        for (let k = 0; k < n; k++) {
          const u0 = s0 + k * (ml + gap);
          faceBox(w, f, u0, u0 + ml, yb, ym, -t, 0, 31);
          faceQuad(w, { ...f, nx: -f.nx, nz: -f.nz }, u0, u0 + ml, yb, ym, t);
        }
      }
    }
  }

  // ---------------------------------------------------------------- non-solid things

  private canopy(b: Building, rng: () => number): void {
    const w = this.w;
    const x0 = b.x - b.w / 2 + 0.15, x1 = b.x + b.w / 2 - 0.15;
    const z0 = b.z - b.d / 2 + 0.15, z1 = b.z + b.d / 2 - 0.15;
    const base = b.solid ? b.h : 0;
    const h = b.solid ? b.h + Math.max(2.4, b.crown) : Math.max(2.3, b.h);
    if (b.solid) {
      // a canopy over a solid block: the block first, then the cloth above its roof
      w.mat = MAT.plaster;
      for (const f of rectFaces(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2)) if (!this.hidden(f, b.h)) faceQuad(w, f, 0, f.len, FOOT, b.h, 0);
      w.mat = MAT.roof;
      w.quad(b.x - b.w / 2, b.h, b.z - b.d / 2, b.x + b.w / 2, b.h, b.z - b.d / 2, b.x + b.w / 2, b.h, b.z + b.d / 2, b.x - b.w / 2, b.h, b.z + b.d / 2, 0, 1, 0);
    }
    w.mat = MAT.wood;
    const pr = 0.06;
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) w.box(x - pr, b.solid ? base : FOOT, z - pr, x + pr, h + 0.12, z + pr, 1 | 2 | 4 | 16 | 32);
    w.mat = MAT.plaster;
    const c = this.cloth;
    c.mat = MAT.cloth;
    c.tint = this.tintByte(b.tint);
    const span = Math.min(b.w, b.d);
    c.extra = rng() < 0.4 ? Math.max(2, Math.round((x1 - x0) / 0.5)) : 0;
    const sag = clamp(0.12 + span * 0.035, 0.15, 0.6);
    const N = clamp(Math.round(Math.max(b.w, b.d) / 1.5), 4, 10);
    const M = N;
    const yAt = (u: number, v: number): number => {
      const su = Math.sin(Math.PI * u), sv = Math.sin(Math.PI * v);
      const f = 0.5 * su * sv + 0.5 * (1 - (1 - su) * (1 - sv));
      return h - sag * f;
    };
    c.reserve((N + 1) * (M + 1), N * M * 6);
    const start = c.nv;
    const e = 0.01;
    for (let j = 0; j <= M; j++) {
      for (let i = 0; i <= N; i++) {
        const u = i / N, v = j / M;
        const x = x0 + (x1 - x0) * u, z = z0 + (z1 - z0) * v;
        const dydx = (yAt(u + e, v) - yAt(u - e, v)) / (2 * e * (x1 - x0));
        const dydz = (yAt(u, v + e) - yAt(u, v - e)) / (2 * e * (z1 - z0));
        const l = Math.hypot(dydx, 1, dydz);
        c.vert(x, yAt(u, v), z, -dydx / l, 1 / l, -dydz / l, u, v);
      }
    }
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const a = start + j * (N + 1) + i;
        const bb = a + 1, cc = a + N + 1, d = cc + 1;
        c.index3(a, cc, bb);
        c.index3(bb, cc, d);
      }
    }
    c.extra = 0;
  }

  /** A raised bed: stone kerb and soil. What grows in it comes from the plants extra (extra/plants.ts). */
  private garden(b: Building): void {
    const w = this.w;
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    const t = 0.25;
    w.mat = MAT.stone;
    w.box(x0, FOOT, z0, x1, BED_RIM, z0 + t);
    w.box(x0, FOOT, z1 - t, x1, BED_RIM, z1);
    w.box(x0, FOOT, z0 + t, x0 + t, BED_RIM, z1 - t, 1 | 2 | 4);
    w.box(x1 - t, FOOT, z0 + t, x1, BED_RIM, z1 - t, 1 | 2 | 4);
    w.mat = MAT.soil;
    w.quad(x0 + t, BED_SOIL, z0 + t, x1 - t, BED_SOIL, z0 + t, x1 - t, BED_SOIL, z1 - t, x0 + t, BED_SOIL, z1 - t, 0, 1, 0);
    w.mat = MAT.plaster;
  }

  private stall(b: Building, rng: () => number): void {
    const w = this.w;
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    // counter along the longer side
    const alongX = b.w >= b.d;
    w.mat = MAT.wood;
    w.tint = 100 + Math.floor(rng() * 100);
    const ch = 0.85;
    let cx0: number, cz0: number, cx1: number, cz1: number;
    if (alongX) {
      cx0 = x0 + 0.2; cx1 = x1 - 0.2; cz0 = z0 + 0.2; cz1 = z0 + 0.2 + Math.min(0.8, b.d * 0.45);
    } else {
      cz0 = z0 + 0.2; cz1 = z1 - 0.2; cx0 = x0 + 0.2; cx1 = x0 + 0.2 + Math.min(0.8, b.w * 0.45);
    }
    w.box(cx0, FOOT, cz0, cx1, ch, cz1);
    // goods on the counter
    const n = 2 + Math.floor(rng() * 4);
    w.mat = MAT.cloth;
    for (let k = 0; k < n; k++) {
      w.tint = Math.floor(rng() * 255);
      const s = 0.18 + rng() * 0.2;
      const gx = cx0 + s + rng() * Math.max(0, cx1 - cx0 - 2 * s);
      const gz = cz0 + s + rng() * Math.max(0, cz1 - cz0 - 2 * s);
      w.box(gx - s, ch, gz - s, gx + s, ch + s * (0.8 + rng()), gz + s);
    }
    // awning on four poles, sloping toward the front
    w.mat = MAT.wood;
    w.tint = this.tintByte(b.tint);
    const hb = Math.max(2.3, b.h), hf = hb - 0.35;
    const pr = 0.04;
    const P: Array<[number, number, number]> = [[x0 + 0.1, z0 + 0.1, 0], [x1 - 0.1, z0 + 0.1, 0], [x0 + 0.1, z1 - 0.1, 1], [x1 - 0.1, z1 - 0.1, 1]];
    for (const [x, z, front] of P) {
      const top = alongX ? (front ? hf : hb) : x > b.x ? hf : hb;
      w.box(x - pr, FOOT, z - pr, x + pr, top, z + pr, 1 | 2 | 4 | 16 | 32);
    }
    w.mat = MAT.plaster;
    const c = this.cloth;
    c.mat = MAT.cloth;
    c.tint = this.tintByte(b.tint);
    c.extra = rng() < 0.6 ? 6 : 0;
    if (alongX) c.quadAuto(x0, hb, z0, x1, hb, z0, x1, hf, z1, x0, hf, z1, 0, 1, 0);
    else c.quadAuto(x0, hb, z0, x0, hb, z1, x1, hf, z1, x1, hf, z0, 0, 1, 0);
    c.extra = 0;
  }

  // ---------------------------------------------------------------- lamps and pool

  private lamps(): void {
    const w = this.w;
    const lamps = this.plan.lamps;
    for (let i = 0; i < lamps.length; i++) {
      const L = lamps[i];
      const g = this.H(L.x, L.z);
      const base = g > 0 && g < L.y - 0.8 ? g : FOOT;
      const r = 0.06;
      w.mat = MAT.wood;
      w.tint = 40;
      if (L.y - 0.3 - base > 0.2) w.box(L.x - r, base, L.z - r, L.x + r, L.y - 0.22, L.z + r, 1 | 2 | 16 | 32);
      // lantern: glass box with a small cap
      w.mat = MAT.lantern;
      w.box(L.x - 0.14, L.y - 0.22, L.z - 0.14, L.x + 0.14, L.y + 0.16, L.z + 0.14, 1 | 2 | 8 | 16 | 32);
      w.mat = MAT.wood;
      taper(w, L.x, L.z, 0.24, 0, L.y + 0.16, L.y + 0.36, 4, Math.PI / 4);
      const s = hashU(this.seed, i, 0x1a);
      this.glows.add(L.x, L.y, L.z, 1.3, GLOW.lamp, s, 0.9 + 0.3 * s);
    }
    w.mat = MAT.plaster;
  }

  waterGeometry: THREE.BufferGeometry | null = null;

  private pool(): void {
    const P = this.plan.pool;
    if (!P || P.r <= 0.5) return;
    const w = this.w;
    const segs = clamp(Math.round(P.r * 2), 32, 96);
    const rimW = 0.7, rimH = 0.32;
    w.mat = MAT.stone;
    w.tint = 150;
    annulus(w, P.x, P.z, P.r, P.r + rimW, rimH, segs, true);
    cylinder(w, P.x, P.z, P.r + rimW, FOOT, rimH, segs);
    // inner face of the rim, down below the water
    const st = w.nv;
    cylinder(w, P.x, P.z, P.r, POOL_LEVEL - 0.6, rimH, segs);
    // flip the inner wall to face the water
    for (let v = st; v < w.nv; v++) {
      w.nrm[v * 3] = -w.nrm[v * 3];
      w.nrm[v * 3 + 2] = -w.nrm[v * 3 + 2];
    }
    for (let k = w.ni - segs * 6; k < w.ni; k += 3) {
      const t = w.idx[k + 1];
      w.idx[k + 1] = w.idx[k + 2];
      w.idx[k + 2] = t;
    }
    w.mat = MAT.plaster;
    // water disc
    const pos: number[] = [P.x, POOL_LEVEL, P.z];
    const idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pos.push(P.x + Math.cos(a) * P.r, POOL_LEVEL, P.z + Math.sin(a) * P.r);
      if (i > 0) idx.push(0, i + 1, i);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.waterGeometry = g;
  }
}

/** A faceted ring band (cornice, balcony) between radii r0 and r1 from y0 to y1, flat-shaded. */
function polyRing(w: Writer, cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, sides: number, rot = 0): void {
  for (const f of prismFaces(cx, cz, r1, sides, rot)) faceQuad(w, f, 0, f.len, y0, y1, 0);
  for (let k = 0; k < sides; k++) {
    const a0 = rot + (k / sides) * Math.PI * 2, a1 = rot + ((k + 1) / sides) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    w.quad(cx + c0 * r0, y1, cz + s0 * r0, cx + c1 * r0, y1, cz + s1 * r0, cx + c1 * r1, y1, cz + s1 * r1, cx + c0 * r1, y1, cz + s0 * r1, 0, 1, 0);
    w.quad(cx + c0 * r0, y0, cz + s0 * r0, cx + c1 * r0, y0, cz + s1 * r0, cx + c1 * r1, y0, cz + s1 * r1, cx + c0 * r1, y0, cz + s0 * r1, 0, -1, 0);
  }
}

// ------------------------------------------------------------------ the far skyline

const FAR_MIN_H = 6;
/** About how many windows a city may have before their spacing is widened. */
const WINDOW_BUDGET = 9000;
const FAR_DOTS = 320;
const FAR_LAMPS = 160;

function buildFar(plan: CityPlan): { w: Writer; glows: Glows } {
  const w = new Writer(8192, 16384);
  const glows = new Glows();
  const gs = plan.gridSize | 0;
  const gh = plan.gridHalf;
  const grid = plan.grid;
  const seed = plan.site.seed | 0;
  const H = (x: number, z: number): number => {
    const i = Math.floor(x + gh), j = Math.floor(z + gh);
    if (i < 0 || j < 0 || i >= gs || j >= gs) return 0;
    return grid[j * gs + i] || 0;
  };
  const nb = (f: Face, u: number): number => H(px(f, u, 0.5), pz(f, u, 0.5));
  const hidden = (f: Face, top: number): boolean => {
    for (let u = 0.5; u < f.len; u += 1) if (nb(f, u) < top - 0.01) return false;
    return true;
  };
  const hill = plan.site.kind === 'hill';
  const bs = plan.buildings;

  // count candidates for the window dots
  let cand = 0;
  for (const b of bs) if (b.solid && b.h >= 3 && b.role !== 'wall') cand++;
  const dotP = Math.min(1, FAR_DOTS / Math.max(1, cand * 1.6));

  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (!b.solid || b.roof === 'canopy' || b.roof === 'none') continue;
    const L = layoutOf(plan, b, i);
    const tall = b.h + Math.max(0, b.crown) >= FAR_MIN_H;
    const keep = tall || b.role === 'landmark' || b.role === 'gate' || (b.role === 'wall' && hill) || L.dome !== null || L.spire !== null;
    w.tint = clamp(Math.round(b.tint * 255), 0, 255);
    const stoneish = b.role === 'landmark' || b.role === 'gate' || b.role === 'wall';
    if (keep) {
      const top = b.h + (L.style === 'crenel' ? (L.pb + L.pm) / 2 : L.pb);
      w.mat = stoneish ? MAT.stone : MAT.plaster;
      const faces = rectFaces(L.x0, L.z0, L.x1, L.z1);
      for (const f of faces) if (!hidden(f, top)) faceQuad(w, f, 0, f.len, FOOT, top, 0);
      w.mat = stoneish ? MAT.stone : MAT.roof;
      w.quad(L.x0, top, L.z0, L.x1, top, L.z0, L.x1, top, L.z1, L.x0, top, L.z1, 0, 1, 0);
      if (L.block) {
        const B = L.block;
        w.mat = MAT.plaster;
        w.box(B.x0, b.h, B.z0, B.x1, B.h, B.z1, 1 | 2 | 4 | 16 | 32);
      }
      if (L.dome) {
        const D = L.dome;
        const y = b.h + D.drum;
        w.mat = D.great ? MAT.stone : MAT.plaster;
        if (D.great) {
          taper(w, D.cx, D.cz, D.r + 0.2, D.r + 0.2, b.h, y + 0.4, 16, 0);
          w.mat = MAT.dome;
          dome(w, D.cx, D.cz, D.r * 0.97, y + 0.4, D.hgt, 24, 7, D.point);
          w.mat = MAT.stone;
          taper(w, D.cx, D.cz, 0.35, 0, y + 0.4 + D.hgt * 0.98, y + 0.4 + D.hgt + clamp(D.r * 0.18, 1.2, 3), 4, 0);
          glows.add(D.cx, y + 0.4 + D.hgt + 0.6, D.cz, 1.0, GLOW.lantern, 0.5, 0.8);
        } else {
          taper(w, D.cx, D.cz, D.r, D.r, b.h, y, 6, 0);
          w.mat = MAT.roof;
          dome(w, D.cx, D.cz, D.r * 0.9, y, D.hgt, 6, 2, D.point);
        }
      }
      if (L.tower) {
        const T = L.tower;
        w.mat = MAT.plaster;
        w.box(T.cx - T.s / 2, b.h, T.cz - T.s / 2, T.cx + T.s / 2, T.top, T.cz + T.s / 2, 1 | 2 | 4 | 16 | 32);
      }
      if (L.spire) {
        const S = L.spire;
        w.mat = b.role === 'landmark' ? MAT.stone : MAT.plaster;
        const rl = S.r * 0.68;
        taper(w, S.cx, S.cz, S.r, rl, b.h, S.lantern0, 4, Math.PI / 4);
        taper(w, S.cx, S.cz, rl + 0.2, rl + 0.2, S.lantern0, S.lantern1 + 0.25, 4, Math.PI / 4);
        w.mat = b.role === 'landmark' ? MAT.dome : MAT.roof;
        taper(w, S.cx, S.cz, rl + 0.3, 0, S.lantern1 + 0.25, S.top, 4, Math.PI / 4);
        glows.add(S.cx, (S.lantern0 + S.lantern1) / 2, S.cz, Math.max(0.9, rl * 1.1), GLOW.lantern, 0.3, 1.0);
      }
      if (L.turrets) {
        const T = L.turrets;
        const inset = L.pb > 0 ? 0.3 : 0;
        w.mat = MAT.stone;
        for (const [x, z] of [
          [L.x0 + inset, L.z0 + inset], [L.x1 - inset - T.s, L.z0 + inset],
          [L.x0 + inset, L.z1 - inset - T.s], [L.x1 - inset - T.s, L.z1 - inset - T.s],
        ]) {
          w.box(x, b.h, z, x + T.s, b.h + T.hgt, z + T.s, 1 | 2 | 4 | 16 | 32);
          taper(w, x + T.s / 2, z + T.s / 2, T.s * 0.45, 0, b.h + T.hgt, b.h + T.hgt + T.s * 0.55, 6, 0);
        }
      }
    }
    // a few warm window dots, whether or not the block is in the skyline mesh
    if (b.h >= 3 && b.role !== 'wall' && hashU(seed, i, 0x91) < dotP) {
      const faces = rectFaces(L.x0, L.z0, L.x1, L.z1);
      const n = 1 + Math.floor(hashU(seed, i, 0x92) * 2.5);
      for (let k = 0; k < n; k++) {
        const fi = Math.floor(hashU(seed, i, 0x93 + k) * 4);
        const f = faces[fi];
        const u = 0.6 + hashU(seed, i, 0xa3 + k) * Math.max(0, f.len - 1.2);
        const storeys = Math.max(1, Math.floor((b.h + 0.4) / STOREY));
        const st = Math.floor(hashU(seed, i, 0xb3 + k) * storeys);
        const y = st * STOREY + (st === 0 ? 1.7 : 1.5);
        if (y > b.h - 0.4 || nb(f, u) > y) continue;
        const s = 1 + Math.floor(hashU(seed, i, 0xc3 + k) * 254);
        glows.add(px(f, u, 0.3), y, pz(f, u, 0.3), 0.6, GLOW.window, s / 255, 0.7 + 0.6 * hashU(seed, i, 0xd3 + k));
      }
    }
  }
  const lamps = plan.lamps;
  const stride = Math.max(1, Math.ceil(lamps.length / FAR_LAMPS));
  for (let i = 0; i < lamps.length; i += stride) {
    const L = lamps[i];
    const s = hashU(seed, i, 0x1a);
    glows.add(L.x, L.y, L.z, 1.6, GLOW.lamp, s, 1.0 + 0.3 * s);
  }
  return { w, glows };
}

// ------------------------------------------------------------------ public API

function mesh(g: THREE.BufferGeometry, m: THREE.Material, name: string, order = 0): THREE.Mesh {
  const me = new THREE.Mesh(g, m);
  me.name = name;
  me.renderOrder = order;
  return me;
}

function farGroup(plan: CityPlan, uniforms: Uniforms, geos: THREE.BufferGeometry[], mats: THREE.Material[]): THREE.Group {
  const far = new THREE.Group();
  far.name = 'city-far';
  const { w, glows } = buildFar(plan);
  const fg = w.geometry();
  if (fg) {
    const m = createMasonryMaterial(uniforms, { shadow: false, twoSided: false, sway: false });
    mats.push(m);
    geos.push(fg);
    far.add(mesh(fg, m, 'city-far-masonry'));
  }
  const gg = glows.geometry();
  if (gg) {
    const m = createGlowMaterial(uniforms, false);
    mats.push(m);
    geos.push(gg);
    const me = mesh(gg, m, 'city-far-glows', 2);
    trackViewport(me, m);
    far.add(me);
  }
  return far;
}

export function buildCity(plan: CityPlan, uniforms: Uniforms): CityMeshes {
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const nb = new NearBuilder(plan);
  nb.build();

  const near = new THREE.Group();
  near.name = 'city-near';
  const cut = createCutUniforms();
  const mg = nb.w.geometry();
  if (mg) {
    const m = createMasonryMaterial(uniforms, { shadow: true, twoSided: false, sway: false, cut });
    mats.push(m);
    geos.push(mg);
    near.add(mesh(mg, m, 'city-masonry'));
  }
  const cg = nb.cloth.geometry();
  if (cg) {
    const m = createMasonryMaterial(uniforms, { shadow: true, twoSided: true, sway: false });
    mats.push(m);
    geos.push(cg);
    near.add(mesh(cg, m, 'city-cloth'));
  }
  nb.plants.orient();
  const pg = nb.plants.geometry();
  if (pg) {
    const m = createMasonryMaterial(uniforms, { shadow: true, twoSided: true, sway: true });
    mats.push(m);
    geos.push(pg);
    const me = mesh(pg, m, 'city-plants');
    near.add(me);
    pg.boundingSphere!.radius += 1; // sway
  }
  if (nb.waterGeometry) {
    const m = createWaterMaterial(uniforms);
    mats.push(m);
    geos.push(nb.waterGeometry);
    near.add(mesh(nb.waterGeometry, m, 'city-water'));
  }
  const gg = nb.glows.geometry();
  if (gg) {
    const m = createGlowMaterial(uniforms, true);
    mats.push(m);
    geos.push(gg);
    const me = mesh(gg, m, 'city-glows', 2);
    trackViewport(me, m);
    near.add(me);
  }

  const far = farGroup(plan, uniforms, geos, mats);
  near.userData.triangles = nb.w.tris + nb.cloth.tris + nb.plants.tris;
  return {
    cut,
    near,
    far,
    doors: nb.doors,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      geos.length = 0;
      mats.length = 0;
    },
  };
}

/** Only the skyline, for cities seen from afar before their plan is worth generating in full. */
export function buildSkyline(plan: CityPlan, uniforms: Uniforms): { far: THREE.Group; dispose(): void } {
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const far = farGroup(plan, uniforms, geos, mats);
  return {
    far,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      geos.length = 0;
      mats.length = 0;
    },
  };
}
