// The insides of the rooms near the wanderer, built when they come within reach and let go when
// they are left behind: inner walls with the doorway cut through, a floor, a ceiling, and the cap
// on the walls that shows when the roof is drawn away. All of them in one merged mesh on the near
// city's masonry shader (sharing its cut-away), rebuilt only when a room comes into reach.
// The rooms further off get a dark veil just inside the doorway, so no one sees through them.

import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import { Writer, doorHole, faceQuad, wallFace } from './build';
import { MAT, createMasonryMaterial, type CutUniforms } from './cityShaders';
import { rectFaces, type Face } from './rooms';
import type { CityPlan, Room } from './types';

/** Rooms nearer than this (metres, city-local) get their insides; further than OUT they lose them. */
export const INTERIOR_IN = 100;
const INTERIOR_OUT = 125;
/** Height of the cap over the walls, just under the ceiling (the cut-away starts above it). */
const CAP = 0.03;

const tintByte = (t: number): number => Math.max(0, Math.min(255, Math.round(t * 255)));

/** The inner side of face f of a room t thick: same tangent, facing in, starting t along. */
function innerFace(f: Face, t: number): Face {
  return {
    ox: f.ox + f.tx * t - f.nx * t,
    oz: f.oz + f.tz * t - f.nz * t,
    tx: f.tx,
    tz: f.tz,
    nx: -f.nx,
    nz: -f.nz,
    len: f.len - 2 * t,
  };
}

/** Writes the inside of room r. */
export function writeRoom(w: Writer, plan: CityPlan, r: Room): void {
  const b = plan.buildings[r.bi];
  const t = r.t;
  const faces = rectFaces(r.x0, r.z0, r.x1, r.z1);
  const wallMat = r.grand ? MAT.stone : MAT.plaster;
  const top = r.ceil - CAP;
  w.tint = tintByte(b.tint);
  w.seed = 0;
  w.extra = 0;
  w.mat = wallMat;
  for (let fi = 0; fi < 4; fi++) {
    const g = innerFace(faces[fi], t);
    wallFace(w, g, -0.05, top, fi === r.door.fi ? [doorHole(r, t, 0)] : []);
  }
  const xa = r.x0 + t, xb = r.x1 - t, za = r.z0 + t, zb = r.z1 - t;
  // the cap over the walls, seen only when the roof is drawn away
  w.quad(r.x0, top, r.z0, r.x1, top, r.z0, r.x1, top, za, r.x0, top, za, 0, 1, 0);
  w.quad(r.x0, top, zb, r.x1, top, zb, r.x1, top, r.z1, r.x0, top, r.z1, 0, 1, 0);
  w.quad(r.x0, top, za, xa, top, za, xa, top, zb, r.x0, top, zb, 0, 1, 0);
  w.quad(xb, top, za, r.x1, top, za, r.x1, top, zb, xb, top, zb, 0, 1, 0);
  // floor: beaten plaster, or flagstones in a great chamber
  w.mat = r.grand ? MAT.stone : MAT.roof;
  w.quad(xa, 0.02, za, xb, 0.02, za, xb, 0.02, zb, xa, 0.02, zb, 0, 1, 0);
  // ceiling: timber in a house, plaster in a hall, stone in a great chamber
  w.mat = r.grand ? MAT.stone : b.role === 'house' ? MAT.wood : MAT.plaster;
  w.quad(xa, r.ceil, za, xb, r.ceil, za, xb, r.ceil, zb, xa, r.ceil, zb, 0, -1, 0);
}

/** The dark veil just inside a doorway, for a room whose inside is not built. */
export function writeVeil(w: Writer, r: Room): void {
  const f = rectFaces(r.x0, r.z0, r.x1, r.z1)[r.door.fi];
  w.mat = MAT.opening;
  w.seed = 0;
  w.extra = 0;
  faceQuad(w, f, r.door.u0, r.door.u1, -0.05, r.door.top, -r.t);
}

export class Interiors {
  /** City-local: add it to the near city's group. */
  readonly group = new THREE.Group();
  private readonly mat: THREE.ShaderMaterial;
  private inner: THREE.Mesh | null = null;
  private veil: THREE.Mesh | null = null;
  private built = new Set<number>();
  private first = true;

  constructor(
    private readonly plan: CityPlan,
    uniforms: Uniforms,
    cut: CutUniforms,
  ) {
    this.group.name = 'city-interiors';
    this.mat = createMasonryMaterial(uniforms, { shadow: true, twoSided: false, sway: false, cut });
  }

  /** Brings the rooms near local (x, z) in and lets the far ones go. Cheap when nothing changes. */
  update(x: number, z: number): void {
    const rooms = this.plan.rooms;
    if (rooms.length === 0) return;
    let changed = this.first;
    const want = new Set<number>();
    for (let k = 0; k < rooms.length; k++) {
      const r = rooms[k];
      const dx = Math.max(r.x0 - x, 0, x - r.x1);
      const dz = Math.max(r.z0 - z, 0, z - r.z1);
      const d = Math.hypot(dx, dz);
      const had = this.built.has(k);
      if (d < INTERIOR_IN || (had && d < INTERIOR_OUT)) {
        want.add(k);
        if (!had) changed = true;
      } else if (had) changed = true;
    }
    if (!changed) return;
    this.first = false;
    this.built = want;
    const w = new Writer(Math.max(64, want.size * 120), Math.max(128, want.size * 200));
    for (const k of want) writeRoom(w, this.plan, rooms[k]);
    const v = new Writer(Math.max(16, (rooms.length - want.size) * 4), Math.max(32, (rooms.length - want.size) * 6));
    for (let k = 0; k < rooms.length; k++) if (!want.has(k)) writeVeil(v, rooms[k]);
    this.inner = this.swap(this.inner, w.geometry(), 'city-interiors-rooms');
    this.veil = this.swap(this.veil, v.geometry(), 'city-interiors-veils');
  }

  private swap(old: THREE.Mesh | null, g: THREE.BufferGeometry | null, name: string): THREE.Mesh | null {
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
    }
    if (!g) return null;
    const m = new THREE.Mesh(g, this.mat);
    m.name = name;
    this.group.add(m);
    return m;
  }

  dispose(): void {
    this.inner = this.swap(this.inner, null, '');
    this.veil = this.swap(this.veil, null, '');
    this.built.clear();
    this.first = true;
    this.mat.dispose();
  }
}
