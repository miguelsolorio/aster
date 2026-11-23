import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import type { Building, CityPlan, Room } from './types';
import { rectFaces, type Face } from './rooms';
import { GLOW, MAT, createCutUniforms, type CutUniforms, createGlowMaterial, createMasonryMaterial, createWaterMaterial, trackViewport } from './cityShaders';
import { bodyOf, isRound, loopFaces, roundedLoop, shapeOf, slumpRadius, tierRadius, towerRadius, type Body, type Loop } from './shape';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadModel, modelGeometry } from '../render/art';

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
  /** The near masonry (city-local), for collision to follow the shapes that are drawn. */
  masonry: THREE.BufferGeometry | null;
  /** Every door the near city cut into its walls (local, on the wall plane, outward normal). */
  doors: Array<{ x: number; z: number; nx: number; nz: number; w: number }>;
  /** Whether it was built before the modelled details arrived and has not been given them yet. */
  readonly needsDetails: boolean;
  /** Adds the modelled details (see detailData) as the 'city-details' mesh, once; returns it, if any. */
  setDetails(detail: GeoData | null, tris: number): THREE.Mesh | null;
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

/** Vertical cylinder wall facing inward (the inside of a parapet ring). */
function cylinderIn(w: Writer, cx: number, cz: number, r: number, y0: number, y1: number, segs: number): void {
  const v0 = w.nv, i0 = w.ni;
  cylinder(w, cx, cz, r, y0, y1, segs);
  for (let v = v0; v < w.nv; v++) {
    w.nrm[v * 3] = -w.nrm[v * 3];
    w.nrm[v * 3 + 2] = -w.nrm[v * 3 + 2];
  }
  for (let k = i0; k < w.ni; k += 3) {
    const t = w.idx[k + 1];
    w.idx[k + 1] = w.idx[k + 2];
    w.idx[k + 2] = t;
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

/** Quad with a normal per corner (smooth shading); the winding follows the corners' mean normal. P and N are 4 x (x, y, z). */
function quadN(w: Writer, P: number[], N: number[]): void {
  w.reserve(4, 6);
  const ux = P[3] - P[0], uy = P[4] - P[1], uz = P[5] - P[2];
  const vx = P[6] - P[0], vy = P[7] - P[1], vz = P[8] - P[2];
  const mx = N[0] + N[3] + N[6] + N[9], my = N[1] + N[4] + N[7] + N[10], mz = N[2] + N[5] + N[8] + N[11];
  const s = (uy * vz - uz * vy) * mx + (uz * vx - ux * vz) * my + (ux * vy - uy * vx) * mz;
  const a = w.vert(P[0], P[1], P[2], N[0], N[1], N[2], 0, 0);
  const b = w.vert(P[3], P[4], P[5], N[3], N[4], N[5], 1, 0);
  const c = w.vert(P[6], P[7], P[8], N[6], N[7], N[8], 1, 1);
  const d = w.vert(P[9], P[10], P[11], N[9], N[10], N[11], 0, 1);
  if (s >= 0) {
    w.index3(a, b, c);
    w.index3(a, c, d);
  } else {
    w.index3(a, c, b);
    w.index3(a, d, c);
  }
}

/**
 * Dome on an elliptical base (radii rx along x, rz along z), smooth-shaded; point 0 = round, up
 * to ~0.5 = pointed. With top < 1 the profile stops at that fraction of its quarter turn and a
 * flat disc closes it (an earth mound with a flat top).
 */
export function domeE(
  w: Writer, cx: number, cz: number, rx: number, rz: number, y0: number, hgt: number, segs: number, rings: number, point: number, top = 1,
): void {
  const nv = (rings + 1) * (segs + 1);
  w.reserve(nv, rings * segs * 6);
  const base = w.nv;
  const f = (t: number): number => {
    const a = t * Math.PI * 0.5;
    return (1 - point) * Math.cos(a) + point * (1 - Math.sin(a));
  };
  const g = (t: number): number => Math.sin(t * Math.PI * 0.5);
  for (let j = 0; j <= rings; j++) {
    const t = (j / rings) * top;
    const ta = Math.max(0, t - 0.01), tb = Math.min(1, t + 0.01);
    // normal of the unit profile (f, g), then through the inverse of the axis scaling
    const pr = g(tb) - g(ta), py = -(f(tb) - f(ta));
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      let nx = (pr * c) / rx, ny = py / hgt, nz = (pr * s) / rz;
      if (j === rings && top >= 0.999) {
        nx = 0;
        ny = 1;
        nz = 0;
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      const ft = f(t);
      w.vert(cx + c * rx * ft, y0 + hgt * g(t), cz + s * rz * ft, nx / l, ny / l, nz / l, i / segs, t);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a = base + j * (segs + 1) + i;
      const b = a + 1;
      const c = a + segs + 1;
      const d = c + 1;
      w.index3(a, c, b);
      if (j < rings - 1 || top < 0.999) w.index3(b, c, d);
    }
  }
  if (top < 0.999) {
    const yt = y0 + hgt * g(top), ft = f(top);
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
      w.tri(cx, yt, cz, cx + Math.cos(a0) * rx * ft, yt, cz + Math.sin(a0) * rz * ft, cx + Math.cos(a1) * rx * ft, yt, cz + Math.sin(a1) * rz * ft, 0, 1, 0);
    }
  }
}

/** Smooth cone frustum from radius r0 at y0 to r1 at y1 (no caps); flares out when r1 > r0. */
function frustum(w: Writer, cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, segs: number): void {
  w.reserve((segs + 1) * 2, segs * 6);
  const base = w.nv;
  const dy = y1 - y0, dr = r1 - r0;
  const l = Math.hypot(dy, dr) || 1;
  const nr = dy / l, ny = -dr / l;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    w.vert(cx + c * r0, y0, cz + s * r0, c * nr, ny, s * nr, i / segs, 0);
    w.vert(cx + c * r1, y1, cz + s * r1, c * nr, ny, s * nr, i / segs, 1);
  }
  for (let i = 0; i < segs; i++) {
    const a = base + i * 2;
    w.index3(a, a + 1, a + 2);
    w.index3(a + 2, a + 1, a + 3);
  }
}

/** A circle as an outline loop of n sides, every edge a smooth arc piece. */
function circleLoop(cx: number, cz: number, r: number, n: number): Loop {
  const L: Loop = { x: [], z: [], nx: [], nz: [], ox: [], oz: [], side: [], cx, cz };
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    L.x.push(cx + c * r);
    L.z.push(cz + s * r);
    L.nx.push(c);
    L.nz.push(s);
    L.ox.push(c);
    L.oz.push(s);
    L.side.push(-1);
  }
  return L;
}

/** Flat roof over a (convex) loop at height y, as a fan from its centre. */
/** A flat roof at y over the polygon (xs, zs), with the rectangular hatch of the stair out to it left open. */
function capHatched(w: Writer, xs: number[], zs: number[], y: number, h: { x0: number; z0: number; x1: number; z1: number }): void {
  const contour = xs.map((x, i) => new THREE.Vector2(x, zs[i]));
  const hole = [new THREE.Vector2(h.x0, h.z0), new THREE.Vector2(h.x1, h.z0), new THREE.Vector2(h.x1, h.z1), new THREE.Vector2(h.x0, h.z1)];
  const pts = [...contour, ...hole];
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [hole])) {
    const A = pts[a], B = pts[b], C = pts[c];
    // wound the way every upward face here is: the cross product's y comes out negative
    const up = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y) < 0;
    if (up) w.tri(A.x, y, A.y, B.x, y, B.y, C.x, y, C.y, 0, 1, 0);
    else w.tri(A.x, y, A.y, C.x, y, C.y, B.x, y, B.y, 0, 1, 0);
  }
}

function capLoop(w: Writer, L: Loop, y: number): void {
  const n = L.x.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    w.tri(L.cx, y, L.cz, L.x[i], y, L.z[i], L.x[j], y, L.z[j], 0, 1, 0);
  }
}

/** Outward normal of a loop's edge i at its end k (0 start, 1 end): the face's own on straight sides. */
function edgeN(L: Loop, faces: Face[], i: number, k: number): [number, number] {
  if (L.side[i] >= 0) return [faces[i].nx, faces[i].nz];
  const v = k === 0 ? i : (i + 1) % L.x.length;
  return [L.nx[v], L.nz[v]];
}

/**
 * Walls round a loop from y0 up to yt (per point). Straight sides and any edge with openings are
 * flat faces with their holes cut; the corner arcs are smooth.
 */
function loopWalls(w: Writer, L: Loop, faces: Face[], hid: boolean[], y0: number, yt: number[], holes: Hole[][] | null): void {
  const n = faces.length;
  for (let i = 0; i < n; i++) {
    if (hid[i]) continue;
    const j = (i + 1) % n;
    const hs = holes ? holes[i] : [];
    if (hs.length > 0 || L.side[i] >= 0) {
      wallFace(w, faces[i], y0, Math.min(yt[i], yt[j]), hs);
      continue;
    }
    quadN(
      w,
      [L.x[i], y0, L.z[i], L.x[j], y0, L.z[j], L.x[j], yt[j], L.z[j], L.x[i], yt[i], L.z[i]],
      [L.nx[i], 0, L.nz[i], L.nx[j], 0, L.nz[j], L.nx[j], 0, L.nz[j], L.nx[i], 0, L.nz[i]],
    );
  }
}

/**
 * A low wall standing on the roof at h just inside a loop (thickness t), up to yt per point, with
 * a rounded coping that rises crest above it: the soft, hand-smoothed parapet of an adobe house.
 */
function loopParapet(w: Writer, L: Loop, faces: Face[], h: number, yt: number[], t: number, crest: number): void {
  const n = faces.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [nix, niz] = edgeN(L, faces, i, 0);
    const [njx, njz] = edgeN(L, faces, i, 1);
    const Pix = L.x[i], Piz = L.z[i], Pjx = L.x[j], Pjz = L.z[j];
    const Iix = Pix - L.ox[i] * t, Iiz = Piz - L.oz[i] * t, Ijx = Pjx - L.ox[j] * t, Ijz = Pjz - L.oz[j] * t;
    const yi = yt[i], yj = yt[j];
    quadN(w, [Iix, h, Iiz, Ijx, h, Ijz, Ijx, yj - crest, Ijz, Iix, yi - crest, Iiz], [-nix, 0, -niz, -njx, 0, -njz, -njx, 0, -njz, -nix, 0, -niz]);
    // the coping: one quad sloping in by crest, whose normals roll over from the outer edge to the
    // inner one, so the light reads it as a rounded top
    const a = 0.62, b = 0.78;
    quadN(
      w,
      [Pix, yi, Piz, Pjx, yj, Pjz, Ijx, yj - crest, Ijz, Iix, yi - crest, Iiz],
      [nix * a, b, niz * a, njx * a, b, njz * a, -njx * a, b, -njz * a, -nix * a, b, -niz * a],
    );
  }
}

/** A plaster band standing out from the walls round a loop, from y0 to y1, with a ledge on top. */
function loopBand(w: Writer, L: Loop, faces: Face[], hid: boolean[], y0: number, y1: number, out: number): void {
  const n = faces.length;
  for (let i = 0; i < n; i++) {
    if (hid[i]) continue;
    const j = (i + 1) % n;
    const [nix, niz] = edgeN(L, faces, i, 0);
    const [njx, njz] = edgeN(L, faces, i, 1);
    const Qix = L.x[i] + L.ox[i] * out, Qiz = L.z[i] + L.oz[i] * out, Qjx = L.x[j] + L.ox[j] * out, Qjz = L.z[j] + L.oz[j] * out;
    quadN(w, [Qix, y0, Qiz, Qjx, y0, Qjz, Qjx, y1, Qjz, Qix, y1, Qiz], [nix, 0, niz, njx, 0, njz, njx, 0, njz, nix, 0, niz]);
    w.quad(L.x[i], y1, L.z[i], L.x[j], y1, L.z[j], Qjx, y1, Qjz, Qix, y1, Qiz, 0, 1, 0);
  }
}

/** Turns the vertices written since v0 about (cx, cz) by rot (positions and normals). */
function turnRange(w: Writer, v0: number, cx: number, cz: number, rot: number): void {
  if (rot === 0) return;
  const c = Math.cos(rot), s = Math.sin(rot);
  for (let v = v0; v < w.nv; v++) {
    const p = v * 3;
    const dx = w.pos[p] - cx, dz = w.pos[p + 2] - cz;
    w.pos[p] = cx + c * dx - s * dz;
    w.pos[p + 2] = cz + s * dx + c * dz;
    const nx = w.nrm[p], nz = w.nrm[p + 2];
    w.nrm[p] = Math.round(c * nx - s * nz);
    w.nrm[p + 2] = Math.round(s * nx + c * nz);
  }
}

/** Where (x, y, z) goes when a body's walls lean in by lean (+x, -x, +z, -z sides) at height h. */
function leanAt(B: Body, lean: number[], h: number, x: number, y: number, z: number): [number, number, number] {
  const t = clamp(y / h, 0, 1);
  if (t <= 0) return [x, z, 0];
  const c = Math.cos(B.rot), s = Math.sin(B.rot);
  const dx = x - B.cx, dz = z - B.cz;
  let lx = c * dx + s * dz, lz = -s * dx + c * dz;
  const ax = lx >= 0 ? lean[0] : lean[1], az = lz >= 0 ? lean[2] : lean[3];
  lx *= 1 - (t * ax) / B.hw;
  lz *= 1 - (t * az) / B.hd;
  return [B.cx + c * lx - s * lz, B.cz + s * lx + c * lz, Math.max(ax, az) / h];
}

/** Leans the walls of everything written since v0 (see leanAt); wall normals tip up to match. */
function leanRange(w: Writer, v0: number, B: Body, lean: number[], h: number): void {
  if (lean.every((d) => d === 0)) return;
  for (let v = v0; v < w.nv; v++) {
    const p = v * 3;
    const [x, z, slope] = leanAt(B, lean, h, w.pos[p], w.pos[p + 1], w.pos[p + 2]);
    w.pos[p] = x;
    w.pos[p + 2] = z;
    const nx = w.nrm[p] / 127, ny = w.nrm[p + 1] / 127, nz = w.nrm[p + 2] / 127;
    if (slope > 0 && Math.abs(ny) < 0.5) {
      const ty = ny + slope * Math.hypot(nx, nz);
      const l = Math.hypot(nx, ty, nz) || 1;
      w.nrm[p] = Math.round((nx / l) * 127);
      w.nrm[p + 1] = Math.round((ty / l) * 127);
      w.nrm[p + 2] = Math.round((nz / l) * 127);
    }
  }
}

/** The same lean for points stored (x, y, z, ...) every stride numbers from index i0. */
function leanPoints(d: number[], i0: number, stride: number, B: Body, lean: number[], h: number): void {
  if (lean.every((v) => v === 0)) return;
  for (let k = i0; k < d.length; k += stride) {
    const [x, z] = leanAt(B, lean, h, d[k], d[k + 1], d[k + 2]);
    d[k] = x;
    d[k + 2] = z;
  }
}

/**
 * The rounded roof of a slumped house, inside its parapet: a low dome over the whole body, or a
 * barrel vault along its longer side with flat ends. Turned with the body.
 */
/** Which rounded or pitched roof a slumped house wears: 0 dome, 1 barrel vault, 2 pitched (gabled). */
export const crownKind = (seed: number, i: number): number => {
  const h = hashU(seed, i, 0x5d);
  return h < 0.4 ? 0 : h < 0.72 ? 1 : 2;
};

function softCrown(w: Writer, B: Body, y0: number, rise: number, kind: number, far: boolean): void {
  const v0 = w.nv;
  const a = B.hw - 0.4, c = B.hd - 0.4;
  if (a < 0.6 || c < 0.6) return;
  const hgt = clamp(rise, 0.6, 0.9 * Math.min(a, c) + 0.6);
  const vault = kind !== 0;
  if (!vault) {
    domeE(w, B.cx, B.cz, a, c, y0, hgt, far ? 4 : 8, far ? 1 : 2, 0);
  } else {
    // along local x; a vault along z is the same vault turned a quarter more
    const along = a >= c;
    const L = along ? a : c, R = along ? c : a;
    const K = kind === 2 ? 2 : far ? 2 : 6;
    const pts: Array<[number, number, number, number]> = [];
    for (let k = 0; k <= K; k++) {
      if (kind === 2) {
        // pitched: two flat slopes meeting in a ridge (eave, ridge, eave); the slope normal sits on both ends of a segment
        pts.push([R * (1 - k), k === 1 ? hgt : 0, 0, 0]);
        continue;
      }
      const ph = (k / K) * Math.PI;
      const nz = Math.cos(ph) / R, ny = Math.sin(ph) / hgt;
      const l = Math.hypot(nz, ny) || 1;
      pts.push([R * Math.cos(ph), hgt * Math.sin(ph), nz / l, ny / l]);
    }
    for (let k = 0; k < K; k++) {
      let [z0, ya, n0z, n0y] = pts[k], [z1, yb, n1z, n1y] = pts[k + 1];
      if (kind === 2) {
        const l = Math.hypot(hgt, R) || 1;
        n0z = n1z = (k === 0 ? hgt : -hgt) / l;
        n0y = n1y = R / l;
      }
      quadN(
        w,
        [B.cx - L, y0 + ya, B.cz + z0, B.cx + L, y0 + ya, B.cz + z0, B.cx + L, y0 + yb, B.cz + z1, B.cx - L, y0 + yb, B.cz + z1],
        [0, n0y, n0z, 0, n0y, n0z, 0, n1y, n1z, 0, n1y, n1z],
      );
      if (!far) for (const e of [-1, 1]) w.tri(B.cx + e * L, y0, B.cz, B.cx + e * L, y0 + ya, B.cz + z0, B.cx + e * L, y0 + yb, B.cz + z1, e, 0, 0);
    }
    if (!along) turnRange(w, v0, B.cx, B.cz, Math.PI / 2);
  }
  turnRange(w, v0, B.cx, B.cz, B.rot);
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
  // round buildings draw their own crowns and have no parapet (see NearBuilder.roundBuilding)
  if (isRound(b)) return L;
  const slump = shapeOf(b) === 'slump';
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
  if (slump && minWD >= 2) {
    // adobe has no merlons: crenels become raised, rounded corners, and a bare roof gets a low lip
    if (L.style === 'crenel') {
      L.style = 'corner';
      L.pb = Math.max(L.pb, 0.5);
      L.pm = L.pb + 0.35;
    }
    if (L.pb === 0) {
      L.pb = 0.22;
      L.pm = 0.22;
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
  } else if (b.roof === 'dome' && minWD >= 2.5 && !slump) {
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
    const off = inset + 0.15 + s / 2 + (slump ? 0.35 * slumpRadius(b.w / 2, b.d / 2) : 0);
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

// ------------------------------------------------------------------ outlines against the grid

/** Signed distance to a rounded rectangle body with its own radius per corner ((+x,-z) (+x,+z) (-x,+z) (-x,-z)). */
function rrDist(B: Body, radii: number[], x: number, z: number): number {
  const c = Math.cos(B.rot), s = Math.sin(B.rot);
  const dx = x - B.cx, dz = z - B.cz;
  const lx = c * dx + s * dz, lz = -s * dx + c * dz;
  const r = Math.min(radii[lx >= 0 ? (lz < 0 ? 0 : 1) : lz >= 0 ? 2 : 3], B.hw, B.hd);
  const qx = Math.abs(lx) - (B.hw - r), qz = Math.abs(lz) - (B.hd - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - r;
}

/**
 * Corner radii of a slumped house: rounded unless something is built against both sides of the
 * corner (then it could not be seen). The occlusion grid leaves a rounded corner's cells open, so a
 * neighbour's wall beside the notch is always drawn. A turned house is rounded all round.
 */
function slumpRadii(b: Building, B: Body, H: (x: number, z: number) => number): number[] {
  if (B.rot !== 0) return [B.rc, B.rc, B.rc, B.rc];
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  const C: Array<[number, number, number, number]> = [[x1, z0, 1, -1], [x1, z1, 1, 1], [x0, z1, -1, 1], [x0, z0, -1, -1]];
  return C.map(([x, z, sx, sz]) => (H(x + sx * 0.5, z - sz * 0.5) > 0 && H(x - sx * 0.5, z + sz * 0.5) > 0 ? 0 : B.rc));
}

/**
 * The height grid as an occluder: each cell keeps its roof height only where the drawn walls fill
 * it completely, else 0. Walls hide themselves against it, so a wall is only left out where a
 * neighbour's wall really stands in front of it (round and turned houses leave gaps at their lot edges).
 */
function occlusionGrid(plan: CityPlan): Float32Array {
  const gs = plan.gridSize | 0, gh = plan.gridHalf, grid = plan.grid;
  const occ = grid.slice();
  const H = (x: number, z: number): number => {
    const i = Math.floor(x + gh), j = Math.floor(z + gh);
    if (i < 0 || j < 0 || i >= gs || j >= gs) return 0;
    return grid[j * gs + i] || 0;
  };
  for (const b of plan.buildings) {
    const shape = shapeOf(b);
    if (!b.solid || shape === 'box') continue;
    const B = bodyOf(b);
    const radii = B ? (shape === 'slump' ? slumpRadii(b, B, H) : [B.rc, B.rc, B.rc, B.rc]) : null;
    const i0 = Math.round(b.x - b.w / 2 + gh), j0 = Math.round(b.z - b.d / 2 + gh);
    for (let j = j0; j < j0 + b.d; j++) {
      if (j < 0 || j >= gs) continue;
      for (let i = i0; i < i0 + b.w; i++) {
        if (i < 0 || i >= gs) continue;
        let full = B !== null && radii !== null;
        if (full) {
          const x = i - gh, z = j - gh;
          for (let k = 0; k < 4 && full; k++) if (rrDist(B!, radii!, x + (k & 1), z + (k >> 1)) > 0.01) full = false;
        }
        if (!full) occ[j * gs + i] = 0;
      }
    }
  }
  return occ;
}

// ------------------------------------------------------------------ modelled details (architecture.glb)
//
// Carved doors, door surrounds, window frames and lattices, spouts, beam ends, parapet caps and dome
// lanterns made in Blender (tools/blender/architecture.py). They are stamped where the builder
// already knows its openings and edges are, into a writer of their own drawn with the near masonry's
// material, so the masonry (and the collision worked out from it) is the same with or without them.
// Their placement draws nothing from the building's rng: variants and density come from hashes. A
// city built before the file arrived gets them once it does (buildCity).

interface ArchModel {
  pos: Float32Array;
  nrm: Float32Array;
  /** Per vertex: material id (-1 the host's), tint (signed offset for the host, else 0..1), wood hue seed. */
  info: Float32Array;
  uv: Float32Array;
  index: ArrayLike<number>;
}

/** @internal The kit; exported for tests. */
export interface ArchKit {
  leaf: ArchModel[];
  frame: ArchModel[];
  arch: ArchModel;
  jamb: ArchModel;
  win: ArchModel[];
  spout: ArchModel[];
  viga: ArchModel[];
  merlonCap: ArchModel;
  step: ArchModel;
  tooth: ArchModel;
  cornerCap: ArchModel;
  ring: ArchModel;
  lantern: ArchModel;
  finial: ArchModel;
}

/** The sizes the doors and windows were modelled at (architecture.py DOOR_W.. WIN_H). */
const KIT_DOOR_W = 1.0, KIT_DOOR_H = 2.3, KIT_WIN_W = 0.7, KIT_WIN_H = 1.1;

let ARCH: ArchKit | null = null;
let archLoad: Promise<ArchKit | null> | null = null;

function archModel(gltf: GLTF, name: string): ArchModel | null {
  const g = modelGeometry(gltf, name);
  const info = g?.getAttribute('_info');
  const uv = g?.getAttribute('_grain');
  if (!g || !info || info.itemSize !== 3 || !uv || uv.itemSize !== 2) return null;
  g.computeVertexNormals();
  const n = g.getAttribute('position').count;
  return {
    pos: Float32Array.from(g.getAttribute('position').array),
    nrm: Float32Array.from(g.getAttribute('normal').array),
    info: Float32Array.from(info.array),
    uv: Float32Array.from(uv.array),
    index: g.getIndex()?.array ?? Array.from({ length: n }, (_, i) => i),
  };
}

/** @internal The kit out of a loaded architecture.glb, or null if any piece is missing. */
export function archKitFrom(gltf: GLTF): ArchKit | null {
  const set = (base: string, n: number): ArchModel[] | null => {
    const out: ArchModel[] = [];
    for (let i = 0; i < n; i++) {
      const m = archModel(gltf, `${base}${i}`);
      if (!m) return null;
      out.push(m);
    }
    return out;
  };
  const leaf = set('DoorLeaf', 3), frame = set('DoorFrame', 2), win = set('Win', 3), spout = set('Spout', 2), viga = set('Viga', 2);
  const one = (name: string): ArchModel | null => archModel(gltf, name);
  const arch = one('DoorArch0'), jamb = one('DoorJamb0'), merlonCap = one('MerlonCap0'), step = one('ParapetStep0');
  const tooth = one('ParapetTooth0'), cornerCap = one('CornerCap0'), ring = one('DomeRing0'), lantern = one('DomeLantern0'), finial = one('DomeFinial0');
  if (!leaf || !frame || !win || !spout || !viga || !arch || !jamb || !merlonCap || !step || !tooth || !cornerCap || !ring || !lantern || !finial) return null;
  return { leaf, frame, arch, jamb, win, spout, viga, merlonCap, step, tooth, cornerCap, ring, lantern, finial };
}

/** Starts loading the modelled details (once); resolves to them, or null without the file. */
export function loadArchitecture(): Promise<ArchKit | null> {
  archLoad ??= loadModel('architecture.glb').then((gltf) => {
    ARCH = gltf ? archKitFrom(gltf) : null;
    return ARCH;
  });
  return archLoad;
}

/** 0..1 from a position, so a detail picks the same variant whenever its building is built. */
const hashAt = (x: number, z: number, salt: number): number => hashU(Math.round(x * 16), Math.round(z * 16), salt);

/**
 * Writes a model into w at (ox, oy, oz): its x along (tx, tz), y up, z along (nx, nz), scaled by
 * su, sy, sn. Parts in the host's material (-1) take hostMat and the host's tint plus their offset;
 * wood with a hue seed keeps it as the vertex's baked hue (the masonry shader's seed on wood).
 */
function stampKit(
  w: Writer, m: ArchModel, ox: number, oy: number, oz: number, tx: number, tz: number, nx: number, nz: number,
  su: number, sy: number, sn: number, hostMat: number, hostTint: number,
): void {
  const nv = m.pos.length / 3;
  w.reserve(nv, m.index.length);
  const base = w.nv;
  const mat0 = w.mat, tint0 = w.tint, seed0 = w.seed;
  for (let i = 0; i < nv; i++) {
    const p = i * 3;
    const x = m.pos[p] * su, y = m.pos[p + 1] * sy, z = m.pos[p + 2] * sn;
    const ax = m.nrm[p] / su, ay = m.nrm[p + 1] / sy, az = m.nrm[p + 2] / sn;
    const wx = tx * ax + nx * az, wz = tz * ax + nz * az;
    const l = Math.hypot(wx, ay, wz) || 1;
    const k = Math.round(m.info[p]);
    if (k < 0) {
      w.mat = hostMat;
      w.tint = clamp(Math.round(hostTint + m.info[p + 1] * 255), 0, 255);
      w.seed = 0;
    } else {
      w.mat = k;
      w.tint = clamp(Math.round(m.info[p + 1] * 255), 0, 255);
      w.seed = k === MAT.wood && m.info[p + 2] > 0 ? clamp(Math.round(m.info[p + 2] * 255), 1, 255) : 0;
    }
    w.vert(ox + tx * x + nx * z, oy + y, oz + tz * x + nz * z, wx / l, ay / l, wz / l, m.uv[i * 2], m.uv[i * 2 + 1]);
  }
  // (along, up, out) is a mirrored frame when out is the along direction turned clockwise
  const flip = tx * nz - tz * nx < 0;
  const I = m.index;
  for (let t = 0; t < I.length; t += 3) {
    if (flip) w.index3(base + I[t], base + I[t + 2], base + I[t + 1]);
    else w.index3(base + I[t], base + I[t + 1], base + I[t + 2]);
  }
  w.mat = mat0;
  w.tint = tint0;
  w.seed = seed0;
}

/** A model on a wall face at (u, y), off metres out of it. */
function stampOn(w: Writer, m: ArchModel, f: Face, u: number, y: number, off: number, su: number, sy: number, sn: number, hostMat: number, hostTint: number): void {
  stampKit(w, m, px(f, u, off), y, pz(f, u, off), f.tx, f.tz, f.nx, f.nz, su, sy, sn, hostMat, hostTint);
}

// ------------------------------------------------------------------ the near city

/** @internal Exported for tests; use buildCity. */
export class NearBuilder {
  readonly w = new Writer(1 << 16, 1 << 17);
  readonly cloth = new Writer(4096, 8192);
  readonly plants = new Writer(4096, 8192);
  /** The modelled details (empty without the kit): drawn with the masonry, never collided with. */
  readonly detail = new Writer(4096, 8192);
  readonly glows = new Glows();
  readonly doors: CityMeshes['doors'] = [];
  /** The room each enterable building holds, by building index. */
  private readonly rooms = new Map<number, Room>();
  private readonly grid: Float32Array;
  /** The grid as an occluder (see occlusionGrid). */
  private readonly occ: Float32Array;
  /** Lot of the building being built: neighbour samples skip past it (a turned or round body stands inside it). */
  private self: { x0: number; z0: number; x1: number; z1: number } | null = null;
  private readonly gs: number;
  private readonly gh: number;
  private readonly seed: number;
  /** Window spacing multiplier, raised for very dense plans to keep the triangle budget. */
  private readonly density: number;

  constructor(
    private readonly plan: CityPlan,
    /** The modelled details to set onto the buildings, or null for none. */
    private readonly kit: ArchKit | null = null,
  ) {
    this.grid = plan.grid;
    this.occ = occlusionGrid(plan);
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

  /** Occluder height of the cell containing local (x, z). */
  O(x: number, z: number): number {
    const i = Math.floor(x + this.gh);
    const j = Math.floor(z + this.gh);
    if (i < 0 || j < 0 || i >= this.gs || j >= this.gs) return 0;
    return this.occ[j * this.gs + i] || 0;
  }

  /** Height of the neighbour just outside a face at u (out metres past the wall, or past the building's own lot). */
  nb(f: Face, u: number, out = 0.5): number {
    let x = px(f, u, 0), z = pz(f, u, 0);
    const S = this.self;
    if (S && x > S.x0 + EPS && x < S.x1 - EPS && z > S.z0 + EPS && z < S.z1 - EPS) {
      // walk out along the normal to the edge of the lot first
      let t = Infinity;
      if (f.nx > 1e-6) t = Math.min(t, (S.x1 - x) / f.nx);
      else if (f.nx < -1e-6) t = Math.min(t, (S.x0 - x) / f.nx);
      if (f.nz > 1e-6) t = Math.min(t, (S.z1 - z) / f.nz);
      else if (f.nz < -1e-6) t = Math.min(t, (S.z0 - z) / f.nz);
      if (Number.isFinite(t)) {
        x += f.nx * t;
        z += f.nz * t;
      }
    }
    return this.H(x + f.nx * out, z + f.nz * out);
  }

  /** Neighbour height over a span of the face (max). */
  nbSpan(f: Face, u0: number, u1: number): number {
    let m = 0;
    for (let u = Math.max(0.5, Math.floor(u0) + 0.5); u < u1; u += 1) m = Math.max(m, this.nb(f, u));
    return Math.max(m, this.nb(f, Math.min(u1, f.len - 0.01)), this.nb(f, Math.max(u0, 0.01)));
  }

  /** Is a wall on its lot edge covered by the neighbours' walls all along, up to top? */
  hidden(f: Face, top: number): boolean {
    if (f.len < 0.5) return false;
    for (let u = 0.5; u < f.len; u += 1) if (this.O(px(f, u, 0.5), pz(f, u, 0.5)) < top - 0.01) return false;
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
    this.self = { x0: L.x0, z0: L.z0, x1: L.x1, z1: L.z1 };
    const v0 = w.nv, c0 = this.cloth.nv, d0 = this.detail.nv, g0 = this.glows.d.length;
    if (b.role === 'wall') this.rampart(b, L, rng);
    else if (isRound(b)) this.roundBuilding(b, rng, i);
    else this.blockBuilding(b, L, rng, i);
    this.self = null;
    const shape = shapeOf(b);
    if (shape === 'slump' || shape === 'dome') {
      // adobe walls lean in as they rise: the whole house (with its awnings and window glows) is
      // drawn in toward its middle, on every side with open ground in front of it
      const B = bodyOf(b)!;
      const d = clamp(0.045 * b.h, 0.15, 0.4);
      let lean = [d, d, d, d];
      if (shape === 'slump' && B.rot === 0) {
        lean = rectFaces(L.x0, L.z0, L.x1, L.z1).map((f) => {
          for (let u = 0.5; u < f.len; u += 1) if (this.H(px(f, u, 0.5), pz(f, u, 0.5)) > 0) return 0;
          return d;
        });
      }
      leanRange(w, v0, B, lean, b.h);
      leanRange(this.cloth, c0, B, lean, b.h);
      leanRange(this.detail, d0, B, lean, b.h);
      leanPoints(this.glows.d, g0, 7, B, lean, b.h);
    }
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
    // a slumped house is a rounded (and maybe turned) outline; anything else is its lot rectangle
    let loop: Loop | null = null;
    let faces: Face[];
    let radii: number[] = [0, 0, 0, 0];
    if (shapeOf(b) === 'slump') {
      const B = bodyOf(b)!;
      radii = slumpRadii(b, B, (x, z) => this.H(x, z));
      loop = roundedLoop(B, radii, 2);
      faces = loopFaces(loop);
    } else {
      faces = rectFaces(L.x0, L.z0, L.x1, L.z1);
    }
    const turned = loop !== null && (b.rot ?? 0) !== 0;
    const nf = faces.length;
    /** Straight sides (the only faces that take openings and fittings). */
    const straight = faces.map((_, fi) => !loop || loop.side[fi] >= 0);
    const holes: Hole[][] = faces.map(() => []);
    const hid = faces.map((f, fi) => !turned && straight[fi] && this.hidden(f, top));
    const litChance = clamp(0.15 + 0.5 * hashU(this.seed, i, 0x77), 0, 0.75);
    const lit = (): number => (rng() < litChance ? 1 + Math.floor(rng() * 254) : 0);
    const arcadeFace = faces.map(() => false);
    const room = this.rooms.get(i) ?? null;
    // a room's door is on a side of the lot; a slumped house draws that side as a straight edge that starts after its corner arc
    let doorEdge = -1;
    let doorShift = 0;
    let doorway: Hole | null = null;
    if (room) {
      const d = room.door;
      doorEdge = loop ? loop.side.indexOf(d.fi) : d.fi;
      const f = faces[doorEdge];
      if (loop) {
        const f0 = rectFaces(L.x0, L.z0, L.x1, L.z1)[d.fi];
        doorShift = (f.ox - f0.ox) * f0.tx + (f.oz - f0.oz) * f0.tz;
      }
      hid[doorEdge] = false;
      // the walk-in doorway, open right through the wall (a landmark's is its great portal)
      doorway = doorHole(room, doorShift, room.t);
      if (!d.portal) holes[doorEdge].push(doorway);
      const uc = (d.u0 + d.u1) / 2 - doorShift;
      this.doors.push({ x: px(f, uc, 0), z: pz(f, uc, 0), nx: f.nx, nz: f.nz, w: d.u1 - d.u0 });
      this.curtain(f, room, rng, doorShift);
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
      for (let fi = 0; fi < nf; fi++) {
        const f = faces[fi];
        if (hid[fi] || !straight[fi] || f.len < 5 || bayH < 2.2) continue;
        if (this.street(f, f.len / 2, 4) < 2) continue;
        arcadeFace[fi] = true;
        // landmarks get one great arched portal in the middle of each open face
        let portal: Hole | null = null;
        if (landmark && f.len >= 10 && b.h >= 7) {
          const pw = Math.min(f.len * 0.3, 8);
          const ph = Math.min(b.h * 0.75, 12);
          const u0 = (f.len - pw) / 2;
          portal = { u0, u1: u0 + pw, y0: 0, y1: ph, d: 2.4, back: MAT.opening, seed: lit(), arch: pw * 0.6, k: 7, point: 0.4 };
          if (doorway && room && room.door.portal && doorEdge === fi) portal = doorway;
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
    const frames: Array<{ f: Face; h: Hole }> = [];
    if (!gate) {
      // doors on street-facing sides
      const cands: Array<{ fi: number; u: number; s: number }> = [];
      for (let fi = 0; fi < nf; fi++) {
        const f = faces[fi];
        if (hid[fi] || !straight[fi] || arcadeFace[fi] || f.len < 2.6) continue;
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
        const arched = landmark || rng() < (loop ? 0.75 : 0.45);
        const door: Hole = {
          u0, u1, y0: 0, y1: dh, d: 0.45, back: rng() < 0.55 ? MAT.wood : MAT.opening,
          seed: rng() < 0.2 ? lit() : 0, arch: arched ? dw * 0.5 : 0, k: 3, point: 0.3,
        };
        holes[c.fi].push(door);
        if (loop && arched && hashU(this.seed, i, 0x3d + placed) < 0.38) frames.push({ f, h: door });
        this.doors.push({ x: px(f, c.u, 0), z: pz(f, c.u, 0), nx: f.nx, nz: f.nz, w: dw });
        placed++;
      }
    }

    // windows, storey by storey
    const storeys = Math.max(1, Math.floor((b.h + 0.4) / STOREY));
    const spacing = ((landmark ? 3.4 : 3.0) + hashU(this.seed, i, 0x31) * 1.4) * this.density * (loop ? 1.45 : 1);
    const skipP = landmark ? 0.05 : 0.14;
    const archWin = landmark || (hall && rng() < 0.6);
    for (let fi = 0; fi < nf; fi++) {
      const f = faces[fi];
      if (hid[fi] || !straight[fi] || f.len < 2) continue;
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
    if (loop) {
      // the parapet rises a little at the rounded corners: hand-smoothed, never quite level
      const n = loop.x.length;
      const bump = L.style === 'corner' ? L.pm - L.pb : 0.08 + 0.1 * hashU(this.seed, i, 0x3a);
      const yt = loop.x.map((_, v) => (loop!.side[v] < 0 && loop!.side[(v + n - 1) % n] < 0 ? top + bump : top));
      loopWalls(w, loop, faces, hid, FOOT, yt, holes);

      w.mat = MAT.roof;
      if (room?.hatch) capHatched(w, loop.x, loop.z, b.h, room.hatch);
      else capLoop(w, loop, b.h);
      w.mat = wallMat;
      if (L.pb > 0) loopParapet(w, loop, faces, b.h, yt, 0.3, 0.07);
      if (this.kit && L.pb >= 0.4 && hashU(this.seed, i, 0x4b) < TOOTH_FIT) {
        // soft adobe teeth along the straight sides of the parapet
        for (let fi = 0; fi < nf; fi++) {
          const f = faces[fi];
          if (hid[fi] || !straight[fi] || f.len < 1.4) continue;
          const n = Math.floor(f.len / 1.4);
          for (let k = 0; k < n; k++) stampOn(this.detail, this.kit.tooth, f, ((k + 0.5) * f.len) / n, top, 0, 1, 1, 1, wallMat, w.tint);
        }
      }
      // plaster bands: under the roof line, and on the storey line of taller houses
      const bandR = hashU(this.seed, i, 0x3b);
      if (bandR < 0.16 && b.h >= 3) loopBand(w, loop, faces, hid, b.h - 0.42, b.h - 0.18, 0.06);
      else if (bandR > 0.84 && b.h >= 6) loopBand(w, loop, faces, hid, STOREY - 0.2, STOREY + 0.04, 0.06);
      for (const fr of frames) this.archFrame(fr.f, fr.h);
      if (b.roof === 'dome') {
        w.mat = MAT.roof;
        softCrown(w, bodyOf(b)!, b.h, b.crown, crownKind(this.seed, i), false);
        w.mat = wallMat;
      }
    } else {
      for (let fi = 0; fi < 4; fi++) if (!hid[fi]) wallFace(w, faces[fi], FOOT, top, holes[fi]);
      // the walkable roof, exactly at h
      w.mat = landmark || gate ? MAT.stone : MAT.roof;
      if (room?.hatch) capHatched(w, [L.x0, L.x1, L.x1, L.x0], [L.z0, L.z0, L.z1, L.z1], b.h, room.hatch);
      else w.quad(L.x0, b.h, L.z0, L.x1, b.h, L.z0, L.x1, b.h, L.z1, L.x0, b.h, L.z1, 0, 1, 0);
      w.mat = wallMat;
      if (L.pb > 0) this.parapet(L.x0, L.z0, L.x1, L.z1, b.h, L, faces);
    }
    if (this.kit) {
      const framed = new Set(frames.map((fr) => fr.h));
      for (let fi = 0; fi < nf; fi++) if (!hid[fi]) this.fitHoles(faces[fi], holes[fi], 0, wallMat, this.tintByte(b.tint), framed);
    }

    // roof-line details
    if (!gate && !landmark) {
      const r = rng();
      if (r < 0.28 && L.pb < 0.75) this.beams(b, faces, hid, holes, straight, rng);
      else if (r < 0.62) this.spouts(b, L, faces, hid, straight, rng);
      if (b.h <= 9.6) this.awnings(b, faces, hid, holes, arcadeFace, rng);
      if (loop && !L.block && !L.tower && b.roof !== 'dome') this.roofClutter(b, L, i, rng);
    }

    if (L.block) this.terraceBlock(b, L, rng, litChance, loop ? radii : null);
    if (L.dome) this.domeCrown(b, L, rng);
    if (L.tower) this.windTower(b, L, loop !== null);
    if (L.spire) this.spireCrown(b, L);
    if (L.turrets) this.turrets(b, L);
  }

  /**
   * The kit's fittings for the openings of one wall face: a carved leaf in the back of a closed
   * door and its surround (none where the plaster archFrame already rings it), a frame with a
   * lattice, shutters or a grille in some of the windows. base is the floor the wall stands on.
   * The window fittings stay in the reveal or within 0.13 of the wall, behind the window glows.
   */
  private fitHoles(f: Face, hs: Hole[], base: number, host: number, tint: number, framed: ReadonlySet<Hole> | null): void {
    const K = this.kit;
    if (!K) return;
    const d = this.detail;
    for (const h of hs) {
      const wd = h.u1 - h.u0, ht = h.y1 - h.y0;
      const uc = (h.u0 + h.u1) / 2;
      const x = px(f, uc, 0), z = pz(f, uc, 0);
      // nothing else on the face within that span (u) and height
      const clear = (u0: number, u1: number, y0: number, y1: number): boolean =>
        u0 >= 0.03 && u1 <= f.len - 0.03 && !hs.some((o) => o !== h && u0 < o.u1 && u1 > o.u0 && y0 < o.y1 && y1 > o.y0);
      if (h.y0 <= base + 0.01 && ht >= 1.8 && wd <= 1.7) {
        const sx = wd / KIT_DOOR_W, sy = ht / KIT_DOOR_H;
        if (!h.through && h.back === MAT.wood && hashAt(x, z, 0x1f) < DOOR_LEAF_FIT) {
          const leaf = K.leaf[Math.floor(hashAt(x, z, 0x1d) * K.leaf.length)];
          stampOn(d, leaf, f, uc, h.y0, 0.004 - h.d, sx, sy, 1, host, tint);
        }
        if (framed?.has(h) || hashAt(x, z, 0x20) >= DOOR_FRAME_FIT) continue;
        if (h.arch <= 0) {
          // a timber case reaches 0.45 past the jambs, the stepped surround 0.36
          const v = hashAt(x, z, 0x1e) < 0.5 ? 1 : 0;
          for (const k of [v, 1 - v]) {
            const r = (k === 1 ? 0.45 : 0.36) * sx;
            if (!clear(h.u0 - r, h.u1 + r, h.y0, h.y1 + 0.6 * sy)) continue;
            stampOn(d, K.frame[k], f, uc, h.y0, 0, sx, sy, 1, host, tint);
            break;
          }
        } else if (Math.abs(h.arch - wd / 2) < 0.08) {
          // the ring is modelled for a round-headed arch: scaled by the width, it rises by half of it
          const spring = h.y1 - h.arch;
          if (spring - h.y0 > 0.5 && clear(h.u0 - 0.14 * wd, h.u1 + 0.14 * wd, h.y0, h.y1 + 0.2 * wd)) {
            stampOn(d, K.arch, f, uc, spring, 0, wd, wd, 1, host, tint);
            stampOn(d, K.jamb, f, uc, h.y0, 0, sx, spring - h.y0, 1, host, tint);
          }
        }
        continue;
      }
      if (h.y0 > base + 0.3 && h.back === MAT.opening && wd >= 0.45 && wd <= 1.0 && ht >= 0.55) {
        // the windows at eye height first: they are the ones seen close
        if (hashAt(x, z + h.y0, 0x2b) >= (h.y0 < base + 2 ? WINDOW_FIT_LOW : WINDOW_FIT_HIGH)) continue;
        const sx = wd / KIT_WIN_W, sy = ht / KIT_WIN_H;
        let v = Math.floor(hashAt(x, z + h.y0, 0x2c) * K.win.length);
        // shutters fold back a window's width to each side; the others reach 0.12 past it
        if (v === 1 && !clear(uc - wd, uc + wd, h.y0, h.y1)) v = h.y0 > base + 2 ? 0 : 2;
        if (!clear(h.u0 - 0.12 * sx, h.u1 + 0.12 * sx, h.y0 - 0.08, h.y1 + 0.18 * sy)) continue;
        stampOn(d, K.win[v], f, uc, h.y0, 0, sx, sy, 1, host, tint);
      }
    }
  }

  /** A cloth hung in a doorway: a valance under the lintel and the two halves drawn back to the jambs. */
  private curtain(f: Face, room: Room, rng: () => number, shift = 0): void {
    const c = this.cloth;
    const d = { ...room.door, u0: room.door.u0 - shift, u1: room.door.u1 - shift };
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
          const ua = Math.max(u0, 0), ub = Math.min(u1, f.len);
          if (this.kit && ub - ua > 0.3) stampOn(this.detail, this.kit.merlonCap, f, (ua + ub) / 2, ym, 0, (ub - ua) / 0.9, 1, t / 0.3, w.mat, w.tint);
        }
      }
    } else if (L.style === 'corner') {
      const s = 0.65;
      w.box(x0, yb, z0, x0 + s, ym, z0 + s);
      w.box(x1 - s, yb, z0, x1, ym, z0 + s);
      w.box(x0, yb, z1 - s, x0 + s, ym, z1);
      w.box(x1 - s, yb, z1 - s, x1, ym, z1);
      if (this.kit) {
        for (const [cx, cz] of [[x0 + s / 2, z0 + s / 2], [x1 - s / 2, z0 + s / 2], [x0 + s / 2, z1 - s / 2], [x1 - s / 2, z1 - s / 2]]) {
          stampKit(this.detail, this.kit.cornerCap, cx, ym, cz, 1, 0, 0, 1, s / 0.65, 1, s / 0.65, w.mat, w.tint);
        }
      }
    } else if (this.kit && hashAt(x0, z0, 0x4a) < 0.45) {
      // a plain parapet crowned with stepped crenels, on the sides that are seen
      for (const f of faces) {
        if (f.len < 2 || this.hidden(f, yb + 0.4)) continue;
        const n = Math.floor((f.len - 0.4) / 1.6);
        for (let k = 0; k < n; k++) stampOn(this.detail, this.kit.step, f, ((k + 0.5) * f.len) / n, yb, 0, 1, 1, t / 0.3, w.mat, w.tint);
      }
    }
  }

  private beams(b: Building, faces: Face[], hid: boolean[], holes: Hole[][], straight: boolean[], rng: () => number): void {
    const w = this.w;
    w.mat = MAT.wood;
    const y = b.h - 0.5;
    let done = 0;
    for (let fi = 0; fi < faces.length && done < 2; fi++) {
      const f = faces[fi];
      if (!straight[fi]) continue;
      if (hid[fi] || rng() < 0.4) continue;
      // some rows are hewn logs from the kit (the procedural box inside each)
      const logs = hashAt(f.ox, f.oz, 0x5a) < VIGA_FIT;
      for (let u = 0.7; u < f.len - 0.5; u += 1.35) {
        if (this.nb(f, u) > y - 0.5 || overlaps(holes[fi], u - 0.12, u + 0.12, y, y + 0.22, 0.1)) continue;
        const len = 0.45 + 0.15 * rng();
        faceBox(w, f, u - 0.11, u + 0.11, y, y + 0.22, 0, len, 31);
        // a hewn log round the box, its variant one per row
        if (this.kit && logs) stampOn(this.detail, this.kit.viga[hashAt(f.ox, f.oz, 0x5b) < 0.5 ? 0 : 1], f, u, y, 0, 1, 1, len + 0.04, MAT.wood, w.tint);
      }
      done++;
    }
    w.mat = MAT.plaster;
  }

  private spouts(b: Building, L: Layout, faces: Face[], hid: boolean[], straight: boolean[], rng: () => number): void {
    const w = this.w;
    const n = 1 + Math.floor(rng() * 2);
    const sides = faces.map((_, fi) => fi).filter((fi) => straight[fi]);
    for (let k = 0; k < n; k++) {
      const fi = sides[Math.floor(rng() * sides.length)];
      const f = faces[fi];
      if (hid[fi] || f.len < 2) continue;
      const u = 0.8 + rng() * (f.len - 1.6);
      if (this.nb(f, u) > b.h - 1) continue;
      w.mat = rng() < 0.5 ? MAT.wood : MAT.stone;
      const y = b.h + Math.min(L.pb, 0.15) - 0.05;
      faceBox(w, f, u - 0.1, u + 0.1, y - 0.14, y, 0, 0.75, 31);
      // an open trough round the box, which becomes its floor
      if (this.kit) stampOn(this.detail, this.kit.spout[hashAt(px(f, u, 0), pz(f, u, 0), 0x5c) < 0.5 ? 0 : 1], f, u, y, 0, 1, 1, 1, w.mat, w.tint);
    }
    w.mat = MAT.plaster;
  }

  /** Cloth awnings over the ground floor on avenue fronts. */
  private awnings(b: Building, faces: Face[], hid: boolean[], holes: Hole[][], arcade: boolean[], rng: () => number): void {
    const c = this.cloth;
    for (let fi = 0; fi < faces.length; fi++) {
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

  private terraceBlock(b: Building, L: Layout, rng: () => number, litChance: number, radii: number[] | null): void {
    const B = L.block!;
    const w = this.w;
    const top = B.h;
    // which of the house's corners the block shares, (+x,-z) (+x,+z) (-x,+z) (-x,-z)
    const own = [B.x1 === L.x1 && B.z0 === L.z0, B.x1 === L.x1 && B.z1 === L.z1, B.x0 === L.x0 && B.z1 === L.z1, B.x0 === L.x0 && B.z0 === L.z0];
    let loop: Loop | null = null;
    let faces: Face[];
    if (radii) {
      // a slumped house's block keeps the house's corner where it shares it and is rounded elsewhere
      const rcB = Math.min(0.8, 0.3 * Math.min(B.x1 - B.x0, B.z1 - B.z0));
      const body: Body = { cx: (B.x0 + B.x1) / 2, cz: (B.z0 + B.z1) / 2, hw: (B.x1 - B.x0) / 2, hd: (B.z1 - B.z0) / 2, rot: 0, rc: rcB };
      loop = roundedLoop(body, own.map((o, k) => (o ? radii[k] : rcB)), 2);
      faces = loopFaces(loop);
    } else {
      faces = rectFaces(B.x0, B.z0, B.x1, B.z1);
    }
    const sideOf = (fi: number): number => (loop ? loop.side[fi] : fi);
    // a face is flush when it lies on the building's outer wall
    const flushSide = [B.x1 === L.x1, B.x0 === L.x0, B.z1 === L.z1, B.z0 === L.z0];
    const flush = faces.map((_, fi) => sideOf(fi) >= 0 && flushSide[sideOf(fi)]);
    const stairFace = (() => {
      const steps = Math.ceil((top - b.h) / 0.32);
      const need = steps * 0.32 + 0.6;
      const roomX = (L.x1 - L.x0) - (B.x1 - B.x0) - 0.3;
      const roomZ = (L.z1 - L.z0) - (B.z1 - B.z0) - 0.3;
      for (let fi = 0; fi < faces.length; fi++) {
        if (sideOf(fi) < 0 || flush[fi] || faces[fi].len < need) continue;
        const room = sideOf(fi) < 2 ? roomX : roomZ;
        if (room >= 1.2) return fi;
      }
      return -1;
    })();
    const n = faces.length;
    for (let fi = 0; fi < n; fi++) {
      const f = faces[fi];
      if (loop && loop.side[fi] < 0) {
        // a corner arc: from the parapet top where it rounds the house's own corner
        const j = (fi + 1) % n;
        const mx = (loop.x[fi] + loop.x[j]) / 2 - loop.cx, mz = (loop.z[fi] + loop.z[j]) / 2 - loop.cz;
        const corner = mx >= 0 ? (mz < 0 ? 0 : 1) : mz >= 0 ? 2 : 3;
        const y0 = own[corner] ? b.h + L.pb : b.h;
        quadN(
          w,
          [loop.x[fi], y0, loop.z[fi], loop.x[j], y0, loop.z[j], loop.x[j], top, loop.z[j], loop.x[fi], top, loop.z[fi]],
          [loop.nx[fi], 0, loop.nz[fi], loop.nx[j], 0, loop.nz[j], loop.nx[j], 0, loop.nz[j], loop.nx[fi], 0, loop.nz[fi]],
        );
        continue;
      }
      const y0 = flush[fi] ? b.h + L.pb : b.h;
      const holes: Hole[] = [];
      if (fi !== stairFace && top - b.h >= 2.4) {
        const sill = b.h + 0.95;
        const y1 = Math.min(sill + 1.0, top - 0.45);
        const cols = Math.max(1, Math.floor((f.len - 0.6) / 2.8));
        for (let c = 0; c < cols; c++) {
          const uc = ((c + 0.5) * f.len) / cols;
          if (rng() < 0.3 || y1 - sill < 0.5 || uc < 0.5 || uc > f.len - 0.5) continue;
          if (flush[fi] && this.nbSpan(f, uc - 0.35, uc + 0.35) > sill - 0.3) continue;
          const s = rng() < litChance ? 1 + Math.floor(rng() * 254) : 0;
          holes.push({ u0: uc - 0.35, u1: uc + 0.35, y0: sill, y1, d: 0.3, back: MAT.opening, seed: s, arch: loop ? 0.35 : 0, k: 3, point: 0 });
          if (s > 0) this.windowGlow(f, uc, (sill + y1) / 2, s);
        }
        if (!flush[fi] && f.len >= 2.4 && rng() < 0.7) {
          const uc = f.len * (0.3 + 0.4 * rng());
          if (!overlaps(holes, uc - 0.5, uc + 0.5, b.h, b.h + 2.1, 0.3)) {
            holes.push({ u0: uc - 0.45, u1: uc + 0.45, y0: b.h, y1: Math.min(b.h + 2.1, top - 0.4), d: 0.35, back: MAT.wood, seed: 0, arch: loop ? 0.45 : 0, k: 3, point: 0 });
          }
        }
      }
      wallFace(w, f, y0, top, holes);
      this.fitHoles(f, holes, b.h, MAT.plaster, w.tint, null);
    }
    w.mat = MAT.roof;
    if (loop) capLoop(w, loop, top);
    else w.quad(B.x0, top, B.z0, B.x1, top, B.z0, B.x1, top, B.z1, B.x0, top, B.z1, 0, 1, 0);
    w.mat = MAT.plaster;
    // a thin lip round the block's roof
    const lip = 0.25;
    if (loop) {
      loopParapet(w, loop, faces, top, loop.x.map(() => top + lip), 0.2, 0.06);
    } else {
      for (const f of faces) {
        faceBox(w, f, 0, f.len, top, top + lip, -0.2, 0, 1 | 2);
        faceQuad(w, { ...f, nx: -f.nx, nz: -f.nz }, 0.2, f.len - 0.2, top, top + lip, 0.2);
      }
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
      if (this.kit) {
        this.domeRing(D.cx, D.cz, D.r, y0 + D.drum, segs, w.tint);
        if (D.point > 0) this.domeTop(this.kit.finial, D.cx, y0 + D.drum + D.hgt * 0.95, D.cz, 1, w.tint);
        else this.domeTop(this.kit.lantern, D.cx, y0 + D.drum + D.hgt - 0.03, D.cz, clamp(D.r * 0.2, 0.45, 1.2), w.tint);
      }
    }
    w.mat = MAT.plaster;
  }

  /** The kit's roll moulding round the top edge of a drum of radius r (segs flat pieces, as the cylinder's). */
  private domeRing(cx: number, cz: number, r: number, y: number, segs: number, tint: number): void {
    const K = this.kit;
    if (!K) return;
    const rr = r * Math.cos(Math.PI / segs), chord = 2 * r * Math.sin(Math.PI / segs) + 0.03;
    for (let k = 0; k < segs; k++) {
      const a = ((k + 0.5) / segs) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      stampKit(this.detail, K.ring, cx + c * rr, y, cz + s * rr, -s, c, c, s, chord, 1, 1, MAT.plaster, tint);
    }
  }

  /** A lantern or finial from the kit on the crown of a dome, scaled by s. */
  private domeTop(m: ArchModel, x: number, y: number, z: number, s: number, tint: number): void {
    stampKit(this.detail, m, x, y, z, 1, 0, 0, 1, s, s, s, MAT.plaster, tint);
  }

  private windTower(b: Building, L: Layout, soft: boolean): void {
    const T = L.tower!;
    const w = this.w;
    const h2 = T.s / 2;
    const capT = 0.25;
    const top = T.top - capT;
    const slotH = Math.min(1.8, (top - b.h) * 0.35);
    w.mat = MAT.plaster;
    if (soft) {
      // a round-cornered shaft with slots on its flat sides, under a rounded cap
      const rc = T.s * 0.28;
      const loop = roundedLoop({ cx: T.cx, cz: T.cz, hw: h2, hd: h2, rot: 0, rc }, [rc, rc, rc, rc], 2);
      const faces = loopFaces(loop);
      const holes = faces.map((f, fi) => {
        const hs: Hole[] = [];
        if (loop.side[fi] < 0) return hs;
        const n = f.len >= 1.6 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const uc = ((k + 0.5) * f.len) / n;
          hs.push({ u0: uc - 0.15, u1: uc + 0.15, y0: top - 0.25 - slotH, y1: top - 0.25, d: 0.35, back: MAT.opening, seed: 0, arch: 0.15, k: 2, point: 0.2 });
        }
        return hs;
      });
      const open = faces.map(() => false);
      loopWalls(w, loop, faces, open, b.h, loop.x.map(() => T.top), holes);
      w.mat = MAT.roof;
      loopBand(w, loop, faces, open, T.top - 0.25, T.top + 0.05, 0.14);
      capLoop(w, loop, T.top + 0.05);
      w.mat = MAT.plaster;
      return;
    }
    const faces = rectFaces(T.cx - h2, T.cz - h2, T.cx + h2, T.cz + h2);
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

  // ---------------------------------------------------------------- adobe details

  /** A raised plaster surround round an arched doorway: two jambs and a band following the arch. */
  private archFrame(f: Face, h: Hole): void {
    const w = this.w;
    const t = 0.13, o = 0.05;
    if (h.arch <= 0 || h.u0 - t < 0.05 || h.u1 + t > f.len - 0.05) return;
    const ys = h.y1 - h.arch;
    faceBox(w, f, h.u0 - t, h.u0, h.y0, ys, 0, o, 1 | 8);
    faceBox(w, f, h.u1, h.u1 + t, h.y0, ys, 0, o, 1 | 16);
    const K = h.k, hw = (h.u1 - h.u0) / 2, p = h.point, uc = h.u0 + hw;
    const iu: number[] = [], iy: number[] = [], ou: number[] = [], oy: number[] = [];
    for (let k = 0; k <= 2 * K; k++) {
      const left = k <= K;
      const q = left ? k / K : (2 * K - k) / K;
      const a = q * Math.PI * 0.5;
      const du = hw * ((1 - p) * (1 - Math.cos(a)) + p * q);
      const u = k === K ? uc : left ? h.u0 + du : h.u1 - du;
      const y = k === K ? h.y1 : ys + h.arch * ((1 - p) * Math.sin(a) + p * q);
      const l = Math.hypot(u - uc, y - ys) || 1;
      iu.push(u);
      iy.push(y);
      ou.push(u + ((u - uc) / l) * t);
      oy.push(y + ((y - ys) / l) * t);
    }
    for (let k = 0; k < 2 * K; k++) {
      w.quad(
        px(f, iu[k], o), iy[k], pz(f, iu[k], o), px(f, iu[k + 1], o), iy[k + 1], pz(f, iu[k + 1], o),
        px(f, ou[k + 1], o), oy[k + 1], pz(f, ou[k + 1], o), px(f, ou[k], o), oy[k], pz(f, ou[k], o),
        f.nx, 0, f.nz,
      );
    }
  }

  /** A water tank or a capped vent or two on a slumped house's roof, clear of its parapet. */
  private roofClutter(b: Building, L: Layout, i: number, rng: () => number): void {
    const r = hashU(this.seed, i, 0x5c);
    if (r > 0.16) return;
    const B = bodyOf(b)!;
    const m = (L.pb > 0.25 ? 0.3 : 0) + 1.0;
    if (B.hw - m < 0.5 || B.hd - m < 0.5) return;
    const c = Math.cos(B.rot), s = Math.sin(B.rot);
    const w = this.w;
    const n = r < 0.06 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const lx = (rng() * 2 - 1) * (B.hw - m), lz = (rng() * 2 - 1) * (B.hd - m);
      const x = B.cx + c * lx - s * lz, z = B.cz + s * lx + c * lz;
      if (rng() < 0.55 && Math.min(B.hw, B.hd) > 2.2) {
        // a round water tank with a domed lid
        const tr = 0.4 + rng() * 0.22, th = 0.8 + rng() * 0.45;
        w.mat = MAT.plaster;
        cylinder(w, x, z, tr, b.h, b.h + th, 8);
        w.mat = MAT.roof;
        dome(w, x, z, tr + 0.04, b.h + th, tr * 0.45, 8, 2, 0);
      } else {
        // a vent: a stub under a mushroom cap
        const vr = 0.16 + rng() * 0.1, vh = 0.4 + rng() * 0.35;
        w.mat = MAT.plaster;
        cylinder(w, x, z, vr, b.h, b.h + vh, 5);
        w.mat = MAT.roof;
        annulus(w, x, z, vr, vr * 1.8, b.h + vh, 5, false);
        dome(w, x, z, vr * 1.8, b.h + vh, vr * 1.1, 5, 1, 0);
      }
    }
    w.mat = MAT.plaster;
  }

  // ---------------------------------------------------------------- round buildings

  private roundBuilding(b: Building, rng: () => number, i: number): void {
    const w = this.w;
    w.tint = this.tintByte(b.tint);
    const litChance = clamp(0.15 + 0.5 * hashU(this.seed, i, 0x77), 0, 0.75);
    const lit = (): number => (rng() < litChance ? 1 + Math.floor(rng() * 254) : 0);
    switch (shapeOf(b)) {
      case 'dome':
        this.domeHouse(b, rng, i, lit);
        break;
      case 'mound':
        this.moundHut(b, rng, lit);
        break;
      case 'tower':
        this.roundTower(b, rng, i, lit);
        break;
      default:
        this.tieredHall(b, rng, lit);
    }
    w.mat = MAT.plaster;
  }

  /** Faces of a round outline best placed for a door (open ground in front), the most open first, spread round. */
  private roundDoors(faces: Face[], minLen: number, want: number, rng: () => number): number[] {
    const c: Array<{ fi: number; s: number }> = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      if (f.len < minLen) continue;
      const st = this.street(f, f.len / 2, 6);
      if (st >= 2) c.push({ fi, s: st + rng() * 1.5 });
    }
    c.sort((a, b) => b.s - a.s);
    const out: number[] = [];
    const n = faces.length;
    for (const k of c) {
      if (out.length >= want) break;
      if (out.some((o) => Math.min(Math.abs(o - k.fi), n - Math.abs(o - k.fi)) < n / 4)) continue;
      out.push(k.fi);
    }
    return out;
  }

  /** Small windows round a round wall, a few per storey on the sides that look onto open ground. */
  private roundWindows(faces: Face[], holes: Hole[][], y0: number, top: number, p: number, rng: () => number, lit: () => number): void {
    const storeys = Math.max(1, Math.floor((top - y0 + 0.4) / STOREY));
    for (let st = 0; st < storeys; st++) {
      const yb = y0 + st * STOREY;
      const ww = 0.5, wh = st === 0 && y0 <= 0 ? 0.6 : 0.85;
      const sill = yb + (st === 0 && y0 <= 0 ? 1.35 : 0.95);
      if (sill + wh > top - 0.45) continue;
      for (let fi = 0; fi < faces.length; fi++) {
        const f = faces[fi];
        if (f.len < ww + 0.4 || rng() > p / this.density) continue;
        const u0 = (f.len - ww) / 2;
        if (overlaps(holes[fi], u0, u0 + ww, sill, sill + wh, 0.3)) continue;
        if (this.nbSpan(f, u0, u0 + ww) > sill - 0.3) continue;
        const sd = lit();
        holes[fi].push({ u0, u1: u0 + ww, y0: sill, y1: sill + wh, d: 0.3, back: MAT.opening, seed: sd, arch: rng() < 0.6 ? ww * 0.5 : 0, k: 2, point: 0.2 });
        if (sd > 0) this.windowGlow(f, f.len / 2, sill + wh / 2, sd);
      }
    }
  }

  /** A house on a round or stadium-shaped base under a smooth dome. */
  private domeHouse(b: Building, rng: () => number, i: number, lit: () => number): void {
    const w = this.w;
    const B = bodyOf(b)!;
    const loop = roundedLoop(B, [B.rc, B.rc, B.rc, B.rc], B.rc > 2.4 ? 3 : 2);
    const faces = loopFaces(loop);
    const open = faces.map(() => false);
    const holes: Hole[][] = faces.map(() => []);
    const hall = b.role === 'hall';
    const frames: Array<{ f: Face; h: Hole }> = [];
    for (const fi of this.roundDoors(faces, 1.2, hall ? 2 : 1, rng)) {
      const f = faces[fi];
      const dw = Math.min(hall ? 1.6 : 1.05, f.len - 0.3);
      const dh = Math.min(hall ? 2.9 : 2.3, b.h - 0.45);
      if (dh < 1.9) continue;
      const u0 = (f.len - dw) / 2;
      const hole: Hole = { u0, u1: u0 + dw, y0: 0, y1: dh, d: 0.45, back: rng() < 0.55 ? MAT.wood : MAT.opening, seed: rng() < 0.2 ? lit() : 0, arch: dw * 0.5, k: 3, point: 0.2 };
      holes[fi].push(hole);
      frames.push({ f, h: hole });
      this.doors.push({ x: px(f, f.len / 2, 0), z: pz(f, f.len / 2, 0), nx: f.nx, nz: f.nz, w: dw });
    }
    this.roundWindows(faces, holes, 0, b.h, 0.18, rng, lit);
    w.mat = MAT.plaster;
    loopWalls(w, loop, faces, open, FOOT, loop.x.map(() => b.h), holes);
    if (this.kit) {
      const framed = new Set(frames.map((fr) => fr.h));
      for (let fi = 0; fi < faces.length; fi++) this.fitHoles(faces[fi], holes[fi], 0, MAT.plaster, w.tint, framed);
    }
    if (hashU(this.seed, i, 0x3c) < 0.35) loopBand(w, loop, faces, open, b.h - 0.38, b.h - 0.12, 0.07);
    for (const fr of frames) this.archFrame(fr.f, fr.h);
    w.mat = MAT.roof;
    capLoop(w, loop, b.h);
    const rx = B.hw * 0.9, rz = B.hd * 0.9;
    const hgt = clamp(b.crown, 0.8, 1.15 * Math.min(rx, rz));
    const big = Math.max(rx, rz) > 4;
    const point = hashU(this.seed, i, 0x3e) < 0.3 ? 0.22 : 0;
    domeE(w, B.cx, B.cz, rx, rz, b.h, hgt, big ? 16 : 12, big ? 5 : 4, point);
    const top = b.h + hgt;
    if (point > 0) {
      w.mat = MAT.wood;
      taper(w, B.cx, B.cz, 0.06, 0, top - 0.05, top + 0.5, 4, 0);
      if (this.kit) this.domeTop(this.kit.finial, B.cx, top - 0.06, B.cz, 0.9, w.tint);
    } else if (this.kit && hashU(this.seed, i, 0x3f) >= 0.5 && hashU(this.seed, i, 0x4c) < 0.5) {
      this.domeTop(this.kit.lantern, B.cx, top - 0.03, B.cz, clamp(Math.min(rx, rz) * 0.18, 0.4, 0.75), w.tint);
    } else if (hashU(this.seed, i, 0x3f) < 0.5) {
      // a little vent at the crown
      w.mat = MAT.plaster;
      cylinder(w, B.cx, B.cz, 0.22, top - 0.12, top + 0.3, 6);
      w.mat = MAT.roof;
      dome(w, B.cx, B.cz, 0.32, top + 0.3, 0.18, 6, 2, 0);
    }
  }

  /** A low earth hut: half an ellipsoid with a flat top at h, entered through a short vaulted tunnel. */
  private moundHut(b: Building, rng: () => number, lit: () => number): void {
    const w = this.w;
    const lot = rectFaces(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2);
    // the tunnel leaves on the side with the most open ground (the longer way on a tie)
    let side = 0, best = -1;
    for (let k = 0; k < 4; k++) {
      const sc = this.street(lot[k], lot[k].len / 2, 6) + (k < 2 ? b.w : b.d) * 0.01;
      if (sc > best) {
        best = sc;
        side = k;
      }
    }
    const dx = side === 0 ? 1 : side === 1 ? -1 : 0, dz = side === 2 ? 1 : side === 3 ? -1 : 0;
    const E = (dx !== 0 ? b.w : b.d) / 2, Eo = (dx !== 0 ? b.d : b.w) / 2;
    const back = 0.45, rt = E - 0.55, ro = Eo - 0.12;
    const mx = b.x - dx * back, mz = b.z - dz * back;
    const rx = dx !== 0 ? rt : ro, rz = dx !== 0 ? ro : rt;
    const topT = 0.7;
    const hgt = (b.h - FOOT * 0.6) / Math.sin(topT * Math.PI * 0.5);
    const segs = Math.max(rx, rz) > 3.5 ? 16 : 12;
    w.mat = MAT.plaster;
    // the mound starts a little below the plateau, so the terrain blend never shows a seam
    domeE(w, mx, mz, rx, rz, FOOT * 0.6, hgt, segs, 3, 0, topT);
    // a smoke vent on the flat top
    cylinder(w, mx, mz, 0.26, b.h - 0.05, b.h + 0.4, 6);
    w.mat = MAT.roof;
    annulus(w, mx, mz, 0.12, 0.26, b.h + 0.4, 6, true);
    w.mat = MAT.plaster;
    // the tunnel: straight walls under a half-round vault, from inside the mound out to a portal
    const tx = -dz, tz = dx; // along the portal, so that its normal (tz, -tx) points out along (dx, dz)
    const wallH = 1.3, vr = 0.74, pd = 0.28;
    const s1 = E - 0.02, s0 = -back + rt * 0.55, se = s1 - pd;
    const at = (sAlong: number, sAcross: number): [number, number] => [b.x + dx * sAlong + tx * sAcross, b.z + dz * sAlong + tz * sAcross];
    if (se > s0 + 0.1) {
      for (const sg of [-1, 1]) {
        const [ax, az] = at(s0, sg * vr), [bx, bz] = at(se, sg * vr);
        w.quad(ax, FOOT, az, bx, FOOT, bz, bx, wallH, bz, ax, wallH, az, tx * sg, 0, tz * sg);
      }
      const K = 5;
      for (let k = 0; k < K; k++) {
        const p0 = (k / K) * Math.PI, p1 = ((k + 1) / K) * Math.PI;
        const c0 = Math.cos(p0), s0v = Math.sin(p0), c1 = Math.cos(p1), s1v = Math.sin(p1);
        const [a0x, a0z] = at(s0, c0 * vr), [b0x, b0z] = at(se, c0 * vr);
        const [a1x, a1z] = at(s0, c1 * vr), [b1x, b1z] = at(se, c1 * vr);
        quadN(
          w,
          [a0x, wallH + s0v * vr, a0z, b0x, wallH + s0v * vr, b0z, b1x, wallH + s1v * vr, b1z, a1x, wallH + s1v * vr, a1z],
          [tx * c0, s0v, tz * c0, tx * c0, s0v, tz * c0, tx * c1, s1v, tz * c1, tx * c1, s1v, tz * c1],
        );
      }
    }
    // the portal: a thick slab with the arched door through it
    const pw = vr + 0.12, ph = wallH + vr + 0.22;
    const [fx0, fz0] = at(s1, -pw);
    const front: Face = { ox: fx0, oz: fz0, tx, tz, nx: dx, nz: dz, len: 2 * pw };
    const door: Hole = { u0: pw - 0.5, u1: pw + 0.5, y0: 0, y1: Math.min(2.0, ph - 0.2), d: pd + 0.4, back: rng() < 0.6 ? MAT.wood : MAT.opening, seed: rng() < 0.25 ? lit() : 0, arch: 0.5, k: 3, point: 0.1 };
    wallFace(w, front, FOOT, ph, [door]);
    faceBox(w, front, 0, 2 * pw, FOOT, ph, -pd, 0, 2 | 8 | 16);
    const framed = rng() < 0.35;
    if (framed) this.archFrame(front, door);
    this.fitHoles(front, [door], 0, MAT.plaster, w.tint, framed ? new Set([door]) : null);
    const [cxF, czF] = at(s1, 0);
    this.doors.push({ x: cxF, z: czF, nx: dx, nz: dz, w: 1.0 });
  }

  /** A round tower narrowing in steps behind ring bands, with slit windows, under a dome or a lantern. */
  private roundTower(b: Building, rng: () => number, i: number, lit: () => number): void {
    const w = this.w;
    const R = towerRadius(b);
    const cx = b.x, cz = b.z;
    const landmark = b.role === 'landmark';
    const wallMat = landmark ? MAT.stone : MAT.plaster;
    const n = clamp(Math.round(b.h / 6.5), 1, 6);
    const shrink = n > 1 ? 0.2 : 0.06;
    const rAt = (k: number): number => R * (1 - (shrink * k) / Math.max(1, n - 1));
    const sides = R < 2.2 ? 10 : R < 3.6 ? 12 : 16;
    const band = 0.18;
    const slitP = (landmark ? 0.3 : 0.24) / this.density;
    for (let k = 0; k < n; k++) {
      const r = rAt(k);
      const y0 = k === 0 ? FOOT : (b.h * k) / n;
      const y1 = (b.h * (k + 1)) / n;
      const loop = circleLoop(cx, cz, r, sides);
      const faces = loopFaces(loop);
      const holes: Hole[][] = faces.map(() => []);
      if (k === 0) {
        for (const fi of this.roundDoors(faces, 1.1, 1, rng)) {
          const f = faces[fi];
          const dw = Math.min(landmark ? 1.6 : 1.05, f.len - 0.25);
          const dh = Math.min(landmark ? 3.0 : 2.3, y1 - 0.6);
          if (dh < 1.9) continue;
          const u0 = (f.len - dw) / 2;
          const hole: Hole = { u0, u1: u0 + dw, y0: 0, y1: dh, d: 0.5, back: MAT.wood, seed: 0, arch: dw * 0.5, k: 3, point: 0.35 };
          holes[fi].push(hole);
          this.doors.push({ x: px(f, f.len / 2, 0), z: pz(f, f.len / 2, 0), nx: f.nx, nz: f.nz, w: dw });
        }
      }
      // slits, about half way up each step
      const sh = Math.min(1.3, (y1 - Math.max(0, y0)) * 0.4);
      const ys = Math.max(0.9, y0) + (y1 - Math.max(0, y0) - sh) * 0.45;
      if (sh >= 0.6) {
        for (let fi = 0; fi < faces.length; fi++) {
          const f = faces[fi];
          if (rng() > slitP) continue;
          const u0 = f.len / 2 - 0.11;
          if (overlaps(holes[fi], u0, u0 + 0.22, ys, ys + sh, 0.3)) continue;
          if (this.nbSpan(f, u0, u0 + 0.22) > ys - 0.3) continue;
          const sd = rng() < 0.5 ? lit() : 0;
          holes[fi].push({ u0, u1: u0 + 0.22, y0: ys, y1: ys + sh, d: 0.4, back: MAT.opening, seed: sd, arch: 0.11, k: 1, point: 0.4 });
          if (sd > 0) this.windowGlow(f, f.len / 2, ys + sh / 2, sd);
        }
      }
      w.mat = wallMat;
      loopWalls(w, loop, faces, faces.map(() => false), y0, faces.map(() => y1), holes);
      if (this.kit) for (let fi = 0; fi < faces.length; fi++) this.fitHoles(faces[fi], holes[fi], 0, wallMat, w.tint, null);
      // the ring band where the tower steps in (at the top it stands up as a low parapet)
      const last = k === n - 1;
      const rb = r + band;
      const yb1 = last ? y1 + 0.55 : y1;
      cylinder(w, cx, cz, rb, y1 - 0.32, yb1, sides);
      annulus(w, cx, cz, r, rb, y1 - 0.32, sides, false);
      if (!last) annulus(w, cx, cz, rAt(k + 1), rb, y1, sides, true);
      else {
        annulus(w, cx, cz, r - 0.15, rb, yb1, sides, true);
        cylinderIn(w, cx, cz, r - 0.15, y1, yb1, sides);
        w.mat = MAT.roof;
        polyCap(w, cx, cz, r - 0.15, y1, sides, 0);
      }
    }
    const rTop = rAt(n - 1) - 0.15;
    if (b.roof === 'spire') {
      // a lantern chamber under a pointed dome and a needle
      const rl = rTop * 0.72;
      const lh = clamp(rl * 1.4, 1.8, 4);
      const l0 = b.h, l1 = b.h + lh;
      const loop = circleLoop(cx, cz, rl, sides);
      const faces = loopFaces(loop);
      const holes = faces.map((f, fi) => {
        const hw = f.len * 0.28;
        return fi % 2 === 0 && hw > 0.12
          ? [{ u0: f.len / 2 - hw, u1: f.len / 2 + hw, y0: l0 + 0.35, y1: l1 - 0.3, d: 0.25, back: MAT.lantern, seed: 0, arch: hw, k: 2, point: 0.4 }]
          : [];
      });
      w.mat = wallMat;
      loopWalls(w, loop, faces, faces.map(() => false), l0, faces.map(() => l1), holes);
      cylinder(w, cx, cz, rl + 0.2, l1 - 0.1, l1 + 0.15, sides);
      annulus(w, cx, cz, rl, rl + 0.2, l1 - 0.1, sides, false);
      annulus(w, cx, cz, rl * 0.9, rl + 0.2, l1 + 0.15, sides, true);
      const fin = clamp(rl * 0.45, 0.8, 2.2);
      const hgt = Math.max(1.2, Math.min(b.crown - lh - 0.15 - fin, rl * 2.6));
      w.mat = landmark ? MAT.dome : MAT.roof;
      dome(w, cx, cz, rl + 0.05, l1 + 0.15, hgt, Math.max(12, sides), landmark ? 8 : 6, 0.45);
      const dt = l1 + 0.15 + hgt;
      w.mat = wallMat;
      finial(w, cx, dt - 0.05, cz, fin);
      if (b.h + b.crown > dt + fin * 1.6 + 0.5) taper(w, cx, cz, 0.1, 0, dt + fin * 1.4, b.h + b.crown, 4, Math.PI / 4);
      this.glows.add(cx, (l0 + l1) / 2, cz, Math.max(0.9, rl * 1.1), GLOW.lantern, 0.3, 1.0);
    } else {
      // a dome cap, round or a little pointed
      const point = hashU(this.seed, i, 0x4e) < 0.5 ? 0.3 : 0;
      w.mat = MAT.roof;
      dome(w, cx, cz, rTop - 0.1, b.h, Math.max(0.8, b.crown), sides, 5, point);
      if (point > 0) {
        w.mat = MAT.wood;
        taper(w, cx, cz, 0.07, 0, b.h + b.crown * 0.97, b.h + b.crown + 0.6, 4, 0);
        if (this.kit) this.domeTop(this.kit.finial, cx, b.h + b.crown * 0.95, cz, 1.1, w.tint);
      } else if (this.kit && hashU(this.seed, i, 0x4d) < 0.4) {
        this.domeTop(this.kit.lantern, cx, b.h + Math.max(0.8, b.crown) - 0.03, cz, clamp(rTop * 0.22, 0.45, 0.9), w.tint);
      }
    }
  }

  /** A great round hall of stacked drums, each flaring out under the next, crowned with a dome. */
  private tieredHall(b: Building, rng: () => number, lit: () => number): void {
    const w = this.w;
    const cx = b.x, cz = b.z;
    const R0 = tierRadius(b);
    const crown = Math.max(8, b.crown);
    const c1 = Math.max(3.5, crown * 0.3), c2 = Math.max(3, crown * 0.22);
    const tiers = [
      { r: R0, y0: FOOT, y1: b.h, fl: 0.6, sides: 40 },
      { r: R0 * 0.7, y0: b.h, y1: b.h + c1, fl: 0.45, sides: 32 },
      { r: R0 * 0.46, y0: b.h + c1, y1: b.h + c1 + c2, fl: 0.35, sides: 24 },
    ];
    const fin = clamp(R0 * 0.08, 1.2, 2.5);
    const domeR = tiers[2].r * 0.95;
    const domeH = Math.max(2.5, crown - c1 - c2 - fin);
    for (let k = 0; k < tiers.length; k++) {
      const T = tiers[k];
      const loop = circleLoop(cx, cz, T.r, T.sides);
      const faces = loopFaces(loop);
      const holes: Hole[][] = faces.map(() => []);
      const wallTop = T.y1 - 0.6;
      if (k === 0) {
        const sc = faces.map((f) => this.street(f, f.len / 2, 8));
        let main = 0;
        for (let fi = 1; fi < faces.length; fi++) if (sc[fi] > sc[main]) main = fi;
        const opp = (main + faces.length / 2) % faces.length;
        const portals = sc[opp] >= 4 ? [main, opp] : [main];
        for (const fi of portals) {
          const f = faces[fi];
          const pw = Math.min(f.len - 0.35, 3.4);
          const ph = Math.min(b.h * 0.6, 6.5, wallTop - 1);
          const u0 = (f.len - pw) / 2;
          holes[fi].push({ u0, u1: u0 + pw, y0: 0, y1: ph, d: 2.0, back: MAT.opening, seed: lit(), arch: pw * 0.55, k: 6, point: 0.4 });
          this.doors.push({ x: px(f, f.len / 2, 0), z: pz(f, f.len / 2, 0), nx: f.nx, nz: f.nz, w: pw });
        }
        // an arcade on the open sides, and arched windows above it
        const bayH = Math.min(3.0, wallTop - 1.2);
        for (let fi = 0; fi < faces.length; fi++) {
          const f = faces[fi];
          if (holes[fi].length > 0) continue;
          const nearPortal = portals.some((p) => Math.min(Math.abs(p - fi), faces.length - Math.abs(p - fi)) <= 1);
          if (fi % 2 === 0 && !nearPortal && sc[fi] >= 2 && bayH >= 2.2) {
            const bw = Math.min(f.len - 0.5, 2.0);
            const u0 = (f.len - bw) / 2;
            holes[fi].push({ u0, u1: u0 + bw, y0: 0, y1: bayH, d: 0.9, back: MAT.opening, seed: rng() < 0.25 ? lit() : 0, arch: bw * 0.5, k: 4, point: 0.3 });
          }
        }
      }
      // arched windows in the upper storeys of every drum
      const step = k === 0 ? 2 : k === 1 ? 2 : 3;
      const ys0 = k === 0 ? STOREY + 0.9 : T.y0 + (T.y1 - T.y0) * 0.3;
      const wh = Math.min(1.5, (wallTop - ys0) * 0.55);
      if (wh >= 0.8) {
        for (let fi = k === 0 ? 1 : 0; fi < faces.length; fi += step) {
          const f = faces[fi];
          const ww = Math.min(0.8, f.len * 0.4);
          const u0 = (f.len - ww) / 2;
          if (overlaps(holes[fi], u0, u0 + ww, ys0, ys0 + wh, 0.3)) continue;
          if (k === 0 && this.nbSpan(f, u0, u0 + ww) > ys0 - 0.3) continue;
          const sd = lit();
          holes[fi].push({ u0, u1: u0 + ww, y0: ys0, y1: ys0 + wh, d: 0.45, back: MAT.opening, seed: sd, arch: ww * 0.5, k: 3, point: 0.35 });
          if (sd > 0) this.windowGlow(f, f.len / 2, ys0 + wh / 2, sd);
        }
      }
      w.mat = MAT.stone;
      loopWalls(w, loop, faces, faces.map(() => false), T.y0, faces.map(() => wallTop), holes);
      if (this.kit) for (let fi = 0; fi < faces.length; fi++) this.fitHoles(faces[fi], holes[fi], 0, MAT.stone, w.tint, null);
      // the flared lip, and the flat ring roof out to it (the lowest one is the walkable roof at h)
      frustum(w, cx, cz, T.r, T.r + T.fl, wallTop, T.y1, T.sides);
      cylinder(w, cx, cz, T.r + T.fl, T.y1, T.y1 + 0.12, T.sides);
      const inner = k < tiers.length - 1 ? tiers[k + 1].r : domeR * 0.9;
      annulus(w, cx, cz, inner, T.r + T.fl, T.y1 + (k === 0 ? 0 : 0.12), T.sides, true);
      if (k === 0) annulus(w, cx, cz, T.r + T.fl - 0.3, T.r + T.fl, T.y1 + 0.12, T.sides, true);
    }
    // small domed kiosks on the lowest roof
    const rk = (tiers[0].r + tiers[1].r) / 2;
    const kr = clamp(R0 * 0.06, 0.9, 1.5);
    const kh = 2.6 + R0 * 0.03;
    for (let q = 0; q < 4; q++) {
      const a = Math.PI / 4 + (q * Math.PI) / 2;
      const x = cx + Math.cos(a) * rk, z = cz + Math.sin(a) * rk;
      w.mat = MAT.stone;
      cylinder(w, x, z, kr, b.h, b.h + kh, 10);
      cylinder(w, x, z, kr + 0.12, b.h + kh - 0.25, b.h + kh, 10);
      annulus(w, x, z, kr, kr + 0.12, b.h + kh - 0.25, 10, false);
      w.mat = MAT.dome;
      dome(w, x, z, kr + 0.1, b.h + kh, kr * 1.1, 10, 4, 0.3);
    }
    const y = tiers[2].y1 + 0.12;
    w.mat = MAT.dome;
    dome(w, cx, cz, domeR, y, domeH, 32, 10, 0.3);
    w.mat = MAT.stone;
    finial(w, cx, y + domeH * 0.985, cz, fin);
    this.glows.add(cx, y + domeH + 0.6, cz, 0.9, GLOW.lantern, 0.5, 0.8);
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
// Shares of the openings and edges the kit fits out (by a hash of their place), which keep the
// details near a quarter of a city's near triangles: windows are by far the most numerous.
/** Windows at eye height, and above it. */
const WINDOW_FIT_LOW = 0.12;
const WINDOW_FIT_HIGH = 0.05;
/** Carved leaves in closed doors; surrounds on any door. */
const DOOR_LEAF_FIT = 0.6;
const DOOR_FRAME_FIT = 0.28;
/** Rows of beam ends drawn as logs. */
const VIGA_FIT = 0.4;
/** Slumped houses with teeth along their parapet. */
const TOOTH_FIT = 0.08;
/** About how many windows a city may have before their spacing is widened. */
const WINDOW_BUDGET = 9000;
const FAR_DOTS = 320;
const FAR_LAMPS = 160;

function buildFar(plan: CityPlan): { w: Writer; glows: Glows } {
  const w = new Writer(8192, 16384);
  const glows = new Glows();
  const gs = plan.gridSize | 0;
  const gh = plan.gridHalf;
  const occ = occlusionGrid(plan);
  const seed = plan.site.seed | 0;
  const at = (g: Float32Array, x: number, z: number): number => {
    const i = Math.floor(x + gh), j = Math.floor(z + gh);
    if (i < 0 || j < 0 || i >= gs || j >= gs) return 0;
    return g[j * gs + i] || 0;
  };
  const nb = (f: Face, u: number): number => at(occ, px(f, u, 0.5), pz(f, u, 0.5));
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
    const shape = shapeOf(b);
    // a slumped house's low rounded roof does not make it part of the skyline
    const tall = b.h + (shape === 'slump' ? 0 : Math.max(0, b.crown)) >= FAR_MIN_H;
    const keep =
      tall || b.role === 'landmark' || b.role === 'gate' || (b.role === 'wall' && hill) || L.dome !== null || L.spire !== null ||
      shape === 'tower' || shape === 'tiered';
    w.tint = clamp(Math.round(b.tint * 255), 0, 255);
    const stoneish = b.role === 'landmark' || b.role === 'gate' || b.role === 'wall';
    if (keep && isRound(b)) {
      farRound(w, glows, b);
    } else if (keep && shape === 'slump') {
      // the body's rectangle, turned like the near house (its rounded corners are too small to see from here)
      const top = b.h + L.pb;
      const B = bodyOf(b)!;
      const loop = roundedLoop(B, [0, 0, 0, 0], 1);
      const faces = loopFaces(loop);
      // a lot side walled in by neighbours hides the wall behind it (the gap a turn leaves is too thin to see from afar)
      const lotHid = rectFaces(L.x0, L.z0, L.x1, L.z1).map((f) => hidden(f, top));
      w.mat = MAT.plaster;
      for (let fi = 0; fi < faces.length; fi++) {
        const f = faces[fi];
        if (loop.side[fi] >= 0 && lotHid[loop.side[fi]]) continue;
        faceQuad(w, f, 0, f.len, FOOT, top, 0);
      }
      w.mat = MAT.roof;
      w.quad(loop.x[0], top, loop.z[0], loop.x[1], top, loop.z[1], loop.x[2], top, loop.z[2], loop.x[3], top, loop.z[3], 0, 1, 0);
      // domed roofs show on the skyline; a barrel vault's low ridge does not
      if (b.roof === 'dome') softCrown(w, B, b.h, b.crown, crownKind(seed, i), true);
      if (L.block) {
        const Bk = L.block;
        w.mat = MAT.plaster;
        w.box(Bk.x0, b.h, Bk.z0, Bk.x1, Bk.h, Bk.z1, 1 | 2 | 4 | 16 | 32);
      }
      if (L.tower) {
        const T = L.tower;
        w.mat = MAT.plaster;
        taper(w, T.cx, T.cz, T.s * 0.62, T.s * 0.62, b.h, T.top, 6, Math.PI / 6);
        polyCap(w, T.cx, T.cz, T.s * 0.62, T.top, 6, Math.PI / 6);
      }
    } else if (keep) {
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

/** Low-poly skyline of a round building, after NearBuilder.roundBuilding. */
function farRound(w: Writer, glows: Glows, b: Building): void {
  const shape = shapeOf(b);
  const cx = b.x, cz = b.z;
  if (shape === 'dome') {
    const B = bodyOf(b)!;
    const k = B.hd / B.hw;
    w.mat = MAT.plaster;
    // a six-sided drum, squashed to the stadium's proportions
    const v0 = w.nv;
    taper(w, cx, cz, B.hw, B.hw, FOOT, b.h, 6, 0);
    for (let v = v0; v < w.nv; v++) w.pos[v * 3 + 2] = cz + (w.pos[v * 3 + 2] - cz) * k;
    w.mat = MAT.roof;
    domeE(w, cx, cz, B.hw * 0.95, B.hd * 0.95, b.h, clamp(b.crown, 0.8, 1.15 * Math.min(B.hw, B.hd) * 0.9), 6, 1, 0);
  } else if (shape === 'mound') {
    w.mat = MAT.plaster;
    domeE(w, cx, cz, b.w / 2 - 0.3, b.d / 2 - 0.3, FOOT, b.h - FOOT + 0.3, 8, 2, 0);
  } else if (shape === 'tower') {
    const R = towerRadius(b);
    const rTop = R * (b.h >= 9.75 ? 0.8 : 0.94);
    const landmark = b.role === 'landmark';
    w.mat = landmark ? MAT.stone : MAT.plaster;
    taper(w, cx, cz, R + 0.1, rTop + 0.1, FOOT, b.h + 0.5, 5, 0);
    if (b.roof === 'spire') {
      const rl = (rTop - 0.15) * 0.72;
      const lh = clamp(rl * 1.4, 1.8, 4);
      taper(w, cx, cz, rl + 0.2, rl + 0.2, b.h, b.h + lh, 5, 0);
      w.mat = landmark ? MAT.dome : MAT.roof;
      taper(w, cx, cz, rl + 0.25, 0, b.h + lh, b.h + Math.max(lh + 1, b.crown), 5, 0);
      glows.add(cx, b.h + lh / 2, cz, Math.max(0.9, rl * 1.1), GLOW.lantern, 0.3, 1.0);
    } else {
      w.mat = MAT.roof;
      dome(w, cx, cz, rTop + 0.1, b.h + 0.5, Math.max(0.8, b.crown), 5, 1, 0.2);
    }
  } else {
    const R0 = tierRadius(b);
    const crown = Math.max(8, b.crown);
    const c1 = Math.max(3.5, crown * 0.3), c2 = Math.max(3, crown * 0.22);
    const fin = clamp(R0 * 0.08, 1.2, 2.5);
    w.mat = MAT.stone;
    taper(w, cx, cz, R0 + 0.3, R0 + 0.3, FOOT, b.h, 12, 0);
    polyCap(w, cx, cz, R0 + 0.3, b.h, 12, 0);
    taper(w, cx, cz, R0 * 0.7 + 0.2, R0 * 0.7 + 0.2, b.h, b.h + c1, 12, 0);
    polyCap(w, cx, cz, R0 * 0.7 + 0.2, b.h + c1, 12, 0);
    taper(w, cx, cz, R0 * 0.46 + 0.15, R0 * 0.46 + 0.15, b.h + c1, b.h + c1 + c2, 12, 0);
    const y = b.h + c1 + c2;
    const domeH = Math.max(2.5, crown - c1 - c2 - fin);
    w.mat = MAT.dome;
    dome(w, cx, cz, R0 * 0.46 * 0.95 + 0.1, y, domeH, 12, 3, 0.3);
    w.mat = MAT.stone;
    taper(w, cx, cz, 0.35, 0, y + domeH * 0.98, y + domeH + fin, 4, 0);
    glows.add(cx, y + domeH + 0.6, cz, 1.0, GLOW.lantern, 0.5, 0.8);
  }
}

// ------------------------------------------------------------------ public API

function mesh(g: THREE.BufferGeometry, m: THREE.Material, name: string, order = 0): THREE.Mesh {
  const me = new THREE.Mesh(g, m);
  me.name = name;
  me.renderOrder = order;
  return me;
}

/** A built geometry as plain arrays: what the plan worker hands back (the arrays are transferred, not copied). */
export interface GeoData {
  attrs: Array<{ name: string; array: Float32Array | Int8Array | Uint8Array; itemSize: number; normalized: boolean }>;
  index: Uint32Array | Uint16Array | null;
  /** Bounds as built: min xyz, max xyz; centre xyz, radius. */
  box: number[] | null;
  sphere: number[] | null;
}

/** Everything of a city's buildings that is worked out from the plan alone: the geometry, not the materials. */
export interface CityData {
  masonry: GeoData | null;
  cloth: GeoData | null;
  plants: GeoData | null;
  water: GeoData | null;
  glows: GeoData | null;
  farMasonry: GeoData | null;
  farGlows: GeoData | null;
  doors: CityMeshes['doors'];
  triangles: number;
  /** Whether it was built with the modelled details (the kit), and those details, if it was. */
  kit: boolean;
  detail: GeoData | null;
  detailTris: number;
}

/** The modelled details of a city alone: what a city built before the kit arrived gets once it has. */
export interface DetailData {
  detail: GeoData | null;
  tris: number;
}

function toData(g: THREE.BufferGeometry | null): GeoData | null {
  if (!g) return null;
  const attrs: GeoData['attrs'] = [];
  for (const [name, a] of Object.entries(g.attributes)) {
    const b = a as THREE.BufferAttribute;
    attrs.push({ name, array: b.array as GeoData['attrs'][number]['array'], itemSize: b.itemSize, normalized: b.normalized });
  }
  const bb = g.boundingBox;
  const bs = g.boundingSphere;
  return {
    attrs,
    index: g.index ? (g.index.array as Uint32Array | Uint16Array) : null,
    box: bb ? [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z] : null,
    sphere: bs ? [bs.center.x, bs.center.y, bs.center.z, bs.radius] : null,
  };
}

function fromData(d: GeoData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const a of d.attrs) g.setAttribute(a.name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  if (d.index) g.setIndex(new THREE.BufferAttribute(d.index, 1));
  if (d.box) g.boundingBox = new THREE.Box3(new THREE.Vector3(d.box[0], d.box[1], d.box[2]), new THREE.Vector3(d.box[3], d.box[4], d.box[5]));
  if (d.sphere) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(d.sphere[0], d.sphere[1], d.sphere[2]), d.sphere[3]);
  return g;
}

/** The buffers of a CityData (or of its details alone), to transfer it from a worker. */
export function cityDataBuffers(d: Partial<CityData>): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const g of [d.masonry, d.cloth, d.plants, d.water, d.glows, d.farMasonry, d.farGlows, d.detail]) {
    if (!g) continue;
    for (const a of g.attrs) out.add(a.array.buffer as ArrayBuffer);
    if (g.index) out.add(g.index.buffer as ArrayBuffer);
  }
  return [...out];
}

function farData(plan: CityPlan): Pick<CityData, 'farMasonry' | 'farGlows'> {
  const { w, glows } = buildFar(plan);
  return { farMasonry: toData(w.geometry()), farGlows: toData(glows.geometry()) };
}

/**
 * The geometry of a city from its plan, with the modelled details if the kit is given (by default
 * the kit if it has loaded). Pure work on arrays: the plan worker runs it too, with its copy of the kit.
 */
export function cityData(plan: CityPlan, kit: ArchKit | null = ARCH): CityData {
  const nb = new NearBuilder(plan, kit);
  nb.build();
  const masonry = toData(nb.w.geometry());
  const cloth = toData(nb.cloth.geometry());
  nb.plants.orient();
  const plants = toData(nb.plants.geometry());
  const water = toData(nb.waterGeometry);
  const glows = toData(nb.glows.geometry());
  return {
    masonry,
    cloth,
    plants,
    water,
    glows,
    ...farData(plan),
    doors: nb.doors,
    triangles: nb.w.tris + nb.cloth.tris + nb.plants.tris,
    kit: kit !== null,
    detail: kit ? toData(nb.detail.geometry()) : null,
    detailTris: kit ? nb.detail.tris : 0,
  };
}

/** The modelled details of a city: the city built again with the kit, of which only they are kept. */
export function detailData(plan: CityPlan, kit: ArchKit): DetailData {
  const nb = new NearBuilder(plan, kit);
  nb.build();
  return { detail: toData(nb.detail.geometry()), tris: nb.detail.tris };
}

function farGroup(uniforms: Uniforms, d: Pick<CityData, 'farMasonry' | 'farGlows'>, geos: THREE.BufferGeometry[], mats: THREE.Material[]): THREE.Group {
  const far = new THREE.Group();
  far.name = 'city-far';
  if (d.farMasonry) {
    const fg = fromData(d.farMasonry);
    const m = createMasonryMaterial(uniforms, { shadow: false, twoSided: false, sway: false });
    mats.push(m);
    geos.push(fg);
    far.add(mesh(fg, m, 'city-far-masonry'));
  }
  if (d.farGlows) {
    const gg = fromData(d.farGlows);
    const m = createGlowMaterial(uniforms, false);
    mats.push(m);
    geos.push(gg);
    const me = mesh(gg, m, 'city-far-glows', 2);
    trackViewport(me, m);
    far.add(me);
  }
  return far;
}

/**
 * Meshes of a city. `data` is its geometry worked out ahead (in the plan worker); without it the
 * geometry is worked out here. Either way the result is the same: only the materials are made here.
 * A city built before the modelled details arrived gets them later through setDetails: by itself
 * when built here without `data`, else from whoever passed the data (see Cities).
 */
export function buildCity(plan: CityPlan, uniforms: Uniforms, data?: CityData): CityMeshes {
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const given = data !== undefined;
  const loading = loadArchitecture();
  const d = data ?? cityData(plan, ARCH);

  const near = new THREE.Group();
  near.name = 'city-near';
  const cut = createCutUniforms();
  const mg = d.masonry ? fromData(d.masonry) : null;
  let masonryMat: THREE.ShaderMaterial | null = null;
  if (mg) {
    const m = createMasonryMaterial(uniforms, { shadow: true, twoSided: false, sway: false, cut });
    masonryMat = m;
    mats.push(m);
    geos.push(mg);
    near.add(mesh(mg, m, 'city-masonry'));
  }
  if (d.cloth) {
    const cg = fromData(d.cloth);
    const m = createMasonryMaterial(uniforms, { shadow: true, twoSided: true, sway: false });
    mats.push(m);
    geos.push(cg);
    near.add(mesh(cg, m, 'city-cloth'));
  }
  if (d.plants) {
    const pg = fromData(d.plants);
    const m = createMasonryMaterial(uniforms, { shadow: true, twoSided: true, sway: true });
    mats.push(m);
    geos.push(pg);
    const me = mesh(pg, m, 'city-plants');
    near.add(me);
    pg.boundingSphere!.radius += 1; // sway
  }
  if (d.water) {
    const wg = fromData(d.water);
    const m = createWaterMaterial(uniforms);
    mats.push(m);
    geos.push(wg);
    near.add(mesh(wg, m, 'city-water'));
  }
  if (d.glows) {
    const gg = fromData(d.glows);
    const m = createGlowMaterial(uniforms, true);
    mats.push(m);
    geos.push(gg);
    const me = mesh(gg, m, 'city-glows', 2);
    trackViewport(me, m);
    near.add(me);
  }

  const far = farGroup(uniforms, d, geos, mats);
  near.userData.triangles = d.triangles;
  let disposed = false;
  let needsDetails = !d.kit;
  // the modelled details, drawn with the masonry's own material (so its light, grain, night and
  // cut-away) but kept out of the masonry geometry, which collision is worked out from
  const setDetails = (dd: GeoData | null, tris: number): THREE.Mesh | null => {
    needsDetails = false;
    if (disposed || !dd || !masonryMat) return null;
    const g = fromData(dd);
    geos.push(g);
    const me = mesh(g, masonryMat, 'city-details');
    near.add(me);
    near.userData.triangles = ((near.userData.triangles as number | undefined) ?? 0) + tris;
    return me;
  };
  if (d.kit) setDetails(d.detail, d.detailTris);
  else if (!given) {
    // built before the details arrived: build the city again with them, once, and keep only those
    void loading.then((K) => {
      if (!K || disposed || !needsDetails) return;
      const dd = detailData(plan, K);
      setDetails(dd.detail, dd.tris);
    });
  }
  return {
    cut,
    near,
    far,
    masonry: mg,
    doors: d.doors,
    get needsDetails() {
      return needsDetails && !disposed;
    },
    setDetails,
    dispose() {
      disposed = true;
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
  const far = farGroup(uniforms, farData(plan), geos, mats);
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
