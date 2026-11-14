// The insides of the rooms near the wanderer, built when they come within reach and let go when
// they are left behind: inner walls with the doorway cut through, a floor, a ceiling, and the cap
// on the walls that shows when the roof is drawn away. All of them in one merged mesh on the near
// city's masonry shader (sharing its cut-away), rebuilt only when a room comes into reach.
// The rooms further off get a dark veil just inside the doorway, so no one sees through them.

import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import { Glows, Writer, doorHole, faceQuad, polyCap, taper, wallFace } from './build';
import { GLOW, MAT, createGlowMaterial, createMasonryMaterial, trackViewport, type CutUniforms } from './cityShaders';
import { ceilOf, storeysOf } from './furnish';
import { rectFaces, type Face } from './rooms';
import type { CityPlan, Piece, Room, RoomStair } from './types';

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
  // floors and ceilings: beaten plaster or flagstones underfoot, timber, plaster or stone overhead
  const ceilMat = r.grand ? MAT.stone : b.role === 'house' ? MAT.wood : MAT.plaster;
  const inner: R = { x0: xa, z0: za, x1: xb, z1: zb };
  const holeIn = (k: number): R | null => r.stairs.find((st) => st.k === k) ?? null;
  const n = storeysOf(r);
  for (let s = 0; s < n; s++) {
    // the floor of storey s: the plateau itself at the bottom, a slab above it
    w.mat = r.grand ? MAT.stone : MAT.roof;
    if (s === 0) w.quad(xa, 0.02, za, xb, 0.02, za, xb, 0.02, zb, xa, 0.02, zb, 0, 1, 0);
    else {
      const f = r.floors[s - 1];
      for (const q of minus(inner, holeIn(s - 1))) w.quad(q.x0, f, q.z0, q.x1, f, q.z0, q.x1, f, q.z1, q.x0, f, q.z1, 0, 1, 0);
    }
    // its ceiling, with the stairwell cut through it (and, at the top, the hatch to the roof)
    w.mat = ceilMat;
    const c = ceilOf(r, s);
    const hole = s === n - 1 ? r.hatch : holeIn(s);
    for (const q of minus(inner, hole)) w.quad(q.x0, c, q.z0, q.x1, c, q.z0, q.x1, c, q.z1, q.x0, c, q.z1, 0, -1, 0);
    // the edges of the hole, down the slab (or up the roof) to the floor above
    if (hole) {
      const top = s === n - 1 ? r.h : r.floors[s];
      w.mat = MAT.plaster;
      holeSides(w, inner, hole, c, top);
    }
  }
  w.mat = MAT.plaster;
  for (const st of r.stairs) writeStair(w, st);
  for (const p of r.pieces) writePiece(w, p);
  for (const c of r.candles) writeCandle(w, c.x, c.y, c.z);
}

interface R {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** The rectangle `a` less `hole` (which lies within it), as up to four rectangles. */
function minus(a: R, hole: R | null): R[] {
  if (!hole) return [a];
  const x0 = Math.max(hole.x0, a.x0), x1 = Math.min(hole.x1, a.x1), z0 = Math.max(hole.z0, a.z0), z1 = Math.min(hole.z1, a.z1);
  const out: R[] = [];
  if (x0 > a.x0 + 1e-6) out.push({ x0: a.x0, x1: x0, z0: a.z0, z1: a.z1 });
  if (x1 < a.x1 - 1e-6) out.push({ x0: x1, x1: a.x1, z0: a.z0, z1: a.z1 });
  if (z0 > a.z0 + 1e-6) out.push({ x0, x1, z0: a.z0, z1: z0 });
  if (z1 < a.z1 - 1e-6) out.push({ x0, x1, z0: z1, z1: a.z1 });
  return out;
}

/** The sides of a hole in a slab from y0 to y1, facing into the hole; none where it meets a wall. */
function holeSides(w: Writer, a: R, h: R, y0: number, y1: number): void {
  if (h.x1 < a.x1 - 1e-6) w.quad(h.x1, y0, h.z1, h.x1, y0, h.z0, h.x1, y1, h.z0, h.x1, y1, h.z1, -1, 0, 0);
  if (h.x0 > a.x0 + 1e-6) w.quad(h.x0, y0, h.z0, h.x0, y0, h.z1, h.x0, y1, h.z1, h.x0, y1, h.z0, 1, 0, 0);
  if (h.z1 < a.z1 - 1e-6) w.quad(h.x0, y0, h.z1, h.x1, y0, h.z1, h.x1, y1, h.z1, h.x0, y1, h.z1, 0, 0, -1);
  if (h.z0 > a.z0 + 1e-6) w.quad(h.x1, y0, h.z0, h.x0, y0, h.z0, h.x0, y1, h.z0, h.x1, y1, h.z0, 0, 0, 1);
}

/** A flight of sand steps: each a block from the floor up to its tread. */
function writeStair(w: Writer, st: RoomStair): void {
  const rise = (st.y1 - st.y0) / st.steps;
  const alongX = st.dir < 2;
  const fwd = st.dir === 0 || st.dir === 2;
  w.tint = 60;
  for (let j = 0; j < st.steps; j++) {
    const a0 = j * st.run, a1 = (j + 1) * st.run;
    let x0 = st.x0, x1 = st.x1, z0 = st.z0, z1 = st.z1;
    if (alongX) {
      if (fwd) [x0, x1] = [st.x0 + a0, st.x0 + a1];
      else [x0, x1] = [st.x1 - a1, st.x1 - a0];
    } else if (fwd) [z0, z1] = [st.z0 + a0, st.z0 + a1];
    else [z0, z1] = [st.z1 - a1, st.z1 - a0];
    // top, both sides, the riser facing the foot, and the end of the last one
    const foot = st.dir === 0 ? 2 : st.dir === 1 ? 1 : st.dir === 2 ? 32 : 16;
    const end = st.dir === 0 ? 1 : st.dir === 1 ? 2 : st.dir === 2 ? 16 : 32;
    const sides = alongX ? 16 | 32 : 1 | 2;
    w.box(x0, st.y0, z0, x1, st.y0 + (j + 1) * rise, z1, 4 | sides | foot | (j === st.steps - 1 ? end : 0));
  }
}

const sandTint = (t: number): number => tintByte(0.06 + 0.3 * t);
const CREAM = 0.7;

/** A piece of sand furniture: blocks and slabs, sculpted rather than joined. */
function writePiece(w: Writer, p: Piece): void {
  const y = p.y;
  w.mat = MAT.plaster;
  w.tint = sandTint(p.tint);
  const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
  // the facing as a unit step, to place a head or a back
  const fx = p.dir === 0 ? 1 : p.dir === 1 ? -1 : 0;
  const fz = p.dir === 2 ? 1 : p.dir === 3 ? -1 : 0;
  switch (p.kind) {
    case 'bed': {
      w.box(p.x0, y, p.z0, p.x1, y + 0.38, p.z1);
      // the headboard block at the end away from the foot
      const hb = 0.14;
      const hx0 = fx > 0 ? p.x0 : fx < 0 ? p.x1 - hb : p.x0, hx1 = fx > 0 ? p.x0 + hb : fx < 0 ? p.x1 : p.x1;
      const hz0 = fz > 0 ? p.z0 : fz < 0 ? p.z1 - hb : p.z0, hz1 = fz > 0 ? p.z0 + hb : fz < 0 ? p.z1 : p.z1;
      w.box(hx0, y + 0.38, hz0, hx1, y + 0.78, hz1);
      // the mattress, paler, and a pillow at the head
      w.tint = tintByte(CREAM);
      const m = 0.06;
      w.box(p.x0 + m, y + 0.38, p.z0 + m, p.x1 - m, y + 0.5, p.z1 - m);
      const pl = 0.42;
      const px0 = fx > 0 ? p.x0 + hb : fx < 0 ? p.x1 - hb - pl : p.x0 + 0.14, px1 = fx > 0 ? p.x0 + hb + pl : fx < 0 ? p.x1 - hb : p.x1 - 0.14;
      const pz0 = fz > 0 ? p.z0 + hb : fz < 0 ? p.z1 - hb - pl : p.z0 + 0.14, pz1 = fz > 0 ? p.z0 + hb + pl : fz < 0 ? p.z1 - hb : p.z1 - 0.14;
      w.box(Math.max(p.x0 + m, px0), y + 0.5, Math.max(p.z0 + m, pz0), Math.min(p.x1 - m, px1), y + 0.57, Math.min(p.z1 - m, pz1));
      break;
    }
    case 'table': {
      w.box(p.x0, y + 0.7, p.z0, p.x1, y + p.h, p.z1);
      const long = Math.max(p.x1 - p.x0, p.z1 - p.z0);
      const alongTable = p.x1 - p.x0 >= p.z1 - p.z0;
      const legs = long >= 1.8 ? [0.2, 0.8] : [0.5];
      for (const f of legs) {
        const lx = alongTable ? p.x0 + (p.x1 - p.x0) * f : cx, lz = alongTable ? cz : p.z0 + (p.z1 - p.z0) * f;
        const hw = alongTable ? 0.2 : (p.x1 - p.x0) * 0.32, hd = alongTable ? (p.z1 - p.z0) * 0.32 : 0.2;
        w.box(lx - hw - 0.04, y, lz - hd - 0.04, lx + hw + 0.04, y + 0.1, lz + hd + 0.04);
        w.box(lx - hw, y + 0.1, lz - hd, lx + hw, y + 0.7, lz + hd);
      }
      break;
    }
    case 'chair': {
      w.box(p.x0, y, p.z0, p.x1, y + p.h, p.z1);
      // the back, along the side away from the facing
      const bk = 0.1;
      const bx0 = fx > 0 ? p.x0 : fx < 0 ? p.x1 - bk : p.x0, bx1 = fx > 0 ? p.x0 + bk : fx < 0 ? p.x1 : p.x1;
      const bz0 = fz > 0 ? p.z0 : fz < 0 ? p.z1 - bk : p.z0, bz1 = fz > 0 ? p.z0 + bk : fz < 0 ? p.z1 : p.z1;
      w.box(bx0, y + p.h, bz0, bx1, y + 0.92, bz1);
      break;
    }
    case 'stool': {
      const r = Math.min(p.x1 - p.x0, p.z1 - p.z0) / 2;
      taper(w, cx, cz, r * 0.78, r * 0.62, y, y + p.h - 0.06, 8, Math.PI / 8);
      taper(w, cx, cz, r, r, y + p.h - 0.06, y + p.h, 8, Math.PI / 8);
      polyCap(w, cx, cz, r, y + p.h, 8, Math.PI / 8);
      break;
    }
    case 'bench': {
      w.box(p.x0 + 0.03, y, p.z0 + 0.03, p.x1 - 0.03, y + p.h - 0.06, p.z1 - 0.03);
      w.box(p.x0, y + p.h - 0.06, p.z0, p.x1, y + p.h, p.z1);
      break;
    }
    case 'stand': {
      w.box(p.x0, y, p.z0, p.x1, y + 0.08, p.z1);
      w.box(p.x0 + 0.08, y + 0.08, p.z0 + 0.08, p.x1 - 0.08, y + p.h - 0.07, p.z1 - 0.08);
      w.box(p.x0, y + p.h - 0.07, p.z0, p.x1, y + p.h, p.z1);
      break;
    }
  }
}

/** A candle: a stub of wax in a dish, and the flame, whose glow is added separately. */
function writeCandle(w: Writer, x: number, y: number, z: number): void {
  w.mat = MAT.plaster;
  w.tint = tintByte(CREAM);
  const base = y - 0.2;
  taper(w, x, z, 0.075, 0.06, base, base + 0.025, 6, 0);
  polyCap(w, x, z, 0.06, base + 0.025, 6, 0);
  taper(w, x, z, 0.035, 0.035, base + 0.025, y - 0.03, 6, 0);
  polyCap(w, x, z, 0.035, y - 0.03, 6, 0);
  w.mat = MAT.lantern;
  w.box(x - 0.014, y - 0.03, z - 0.014, x + 0.014, y + 0.05, z + 0.014, 55);
}

/** The dark veil just inside a doorway, for a room whose inside is not built. */
export function writeVeil(w: Writer, r: Room): void {
  const f = rectFaces(r.x0, r.z0, r.x1, r.z1)[r.door.fi];
  w.mat = MAT.opening;
  w.seed = 0;
  w.extra = 0;
  faceQuad(w, f, r.door.u0, r.door.u1, -0.05, r.door.top, -r.t);
  // and the hatch in the roof of a house with a stair out to it: a dark well
  const h = r.hatch;
  if (h) w.quad(h.x0, r.ceil, h.z0, h.x1, r.ceil, h.z0, h.x1, r.ceil, h.z1, h.x0, r.ceil, h.z1, 0, 1, 0);
}

export class Interiors {
  /** City-local: add it to the near city's group. */
  readonly group = new THREE.Group();
  private readonly mat: THREE.ShaderMaterial;
  private inner: THREE.Mesh | null = null;
  private veil: THREE.Mesh | null = null;
  private lights: THREE.Mesh | null = null;
  private readonly glowMat: THREE.ShaderMaterial;
  private built = new Set<number>();
  private first = true;

  constructor(
    private readonly plan: CityPlan,
    uniforms: Uniforms,
    cut: CutUniforms,
  ) {
    this.group.name = 'city-interiors';
    this.mat = createMasonryMaterial(uniforms, { shadow: true, twoSided: false, sway: false, cut });
    // candle flames: lit from dusk, and drawn away with the storeys above the wanderer
    this.glowMat = createGlowMaterial(uniforms, true, cut);
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
    const glows = new Glows();
    for (const k of want) {
      writeRoom(w, this.plan, rooms[k]);
      for (const c of rooms[k].candles) glows.add(c.x, c.y, c.z, 0.45, GLOW.lamp, c.seed, 1.0);
    }
    const v = new Writer(Math.max(16, (rooms.length - want.size) * 4), Math.max(32, (rooms.length - want.size) * 6));
    for (let k = 0; k < rooms.length; k++) if (!want.has(k)) writeVeil(v, rooms[k]);
    this.inner = this.swap(this.inner, w.geometry(), 'city-interiors-rooms');
    this.veil = this.swap(this.veil, v.geometry(), 'city-interiors-veils');
    const old = this.lights;
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
    }
    const gg = glows.geometry();
    this.lights = null;
    if (gg) {
      const m = new THREE.Mesh(gg, this.glowMat);
      m.name = 'city-interiors-candles';
      m.renderOrder = 2;
      m.frustumCulled = false;
      trackViewport(m, this.glowMat);
      this.group.add(m);
      this.lights = m;
    }
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
    if (this.lights) {
      this.group.remove(this.lights);
      this.lights.geometry.dispose();
      this.lights = null;
    }
    this.built.clear();
    this.first = true;
    this.mat.dispose();
    this.glowMat.dispose();
  }
}
