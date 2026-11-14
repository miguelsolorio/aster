// Buildings you can walk into. Houses, halls, markets and landmarks big enough to hold a room are
// hollow shells: walls `t` thick round a floor at the plateau, a ceiling under the walkable roof,
// and one open doorway on a side that faces the street. Pure logic, no three.js: the plan decides
// the rooms (planRooms), the near city cuts the doorways and draws the shells (build.ts,
// interiors.ts), and the solid world asks a room's shell what stands where (shellTop, shellSolid).
//
// The plan's height grid is left as it was (every cell of the building at its roof height), so
// shadows, props and people go on treating the building as a block; only the wanderer and the
// camera ask the shell.

import type { Building, CityPlan, Room, RoomDoor } from './types';

/** Smallest footprint side (metres) that holds a room. */
export const ROOM_MIN = 4;
/** Walls of houses, halls and markets; a landmark's are heavier. */
export const WALL_T = 0.4;
export const GRAND_WALL_T = 0.6;
/** Height of the wanderer, feet to crown, for the headroom under a lintel or ceiling. */
export const HEADROOM = 1.85;
/** How far in from each jamb the body is kept (the curtain hangs there). */
export const JAMB = 0.22;

/** A vertical rectangle: P(u, y, off) = o + t * u + n * off, u in [0, len]. n is outward. */
export interface Face {
  ox: number;
  oz: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  len: number;
}

/** The four sides of an axis-aligned footprint: +x, -x, +z, -z. */
export function rectFaces(x0: number, z0: number, x1: number, z1: number): Face[] {
  return [
    { ox: x1, oz: z0, tx: 0, tz: 1, nx: 1, nz: 0, len: z1 - z0 },
    { ox: x0, oz: z1, tx: 0, tz: -1, nx: -1, nz: 0, len: z1 - z0 },
    { ox: x1, oz: z1, tx: -1, tz: 0, nx: 0, nz: 1, len: x1 - x0 },
    { ox: x0, oz: z0, tx: 1, tz: 0, nx: 0, nz: -1, len: x1 - x0 },
  ];
}

const ROLES = new Set(['house', 'hall', 'market', 'landmark']);

/** Whether a building is of a kind and size to be walked into (a doorway must still be found). */
export function enterable(b: Building): boolean {
  if (!b.solid || !ROLES.has(b.role) || b.roof === 'canopy' || b.roof === 'none') return false;
  if (Math.min(b.w, b.d) < ROOM_MIN) return false;
  return b.h >= 2.9; // room for a door and a ceiling over it
}

function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Height-grid reader for the plan: roof height of the cell at local (x, z), 0 for open ground. */
function gridH(plan: CityPlan, x: number, z: number): number {
  const i = Math.floor(x + plan.gridHalf);
  const j = Math.floor(z + plan.gridHalf);
  if (i < 0 || j < 0 || i >= plan.gridSize || j >= plan.gridSize) return 0;
  return plan.grid[j * plan.gridSize + i] || 0;
}

const fx = (f: Face, u: number, off: number): number => f.ox + f.tx * u + f.nx * off;
const fz = (f: Face, u: number, off: number): number => f.oz + f.tz * u + f.nz * off;

/** Metres of open ground straight out from the face at u (as NearBuilder.street). */
function street(plan: CityPlan, f: Face, u: number, max: number): number {
  for (let k = 0; k < max; k++) if (gridH(plan, fx(f, u, k + 0.5), fz(f, u, k + 0.5)) > 0) return k;
  return max;
}

/** Open ground in front of the whole span, two cells deep. */
function clearFront(plan: CityPlan, f: Face, u0: number, u1: number): boolean {
  for (let u = u0; u <= u1 + 1e-6; u += Math.min(0.5, Math.max(0.01, u1 - u0))) {
    if (gridH(plan, fx(f, u, 0.5), fz(f, u, 0.5)) > 0 || gridH(plan, fx(f, u, 1.5), fz(f, u, 1.5)) > 0) return false;
  }
  return true;
}

/** The great portal a landmark gets in the middle of an open face (as NearBuilder.blockBuilding). */
export function portalOf(f: Face, h: number): { u0: number; u1: number; top: number; arch: number } {
  const pw = Math.min(f.len * 0.3, 8);
  const u0 = (f.len - pw) / 2;
  return { u0, u1: u0 + pw, top: Math.min(h * 0.75, 12), arch: pw * 0.6 };
}

function makeDoor(f: Face, fi: number, u0: number, u1: number, top: number, arch: number, portal: boolean): RoomDoor {
  const u = (u0 + u1) / 2;
  return { fi, u0, u1, top, arch, portal, x: fx(f, u, 0), z: fz(f, u, 0), nx: f.nx, nz: f.nz };
}

/** The shell of building bi, or null if it is not enterable or no side of it opens on the street. */
export function roomFor(plan: CityPlan, b: Building, bi: number): Room | null {
  if (!enterable(b)) return null;
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  const grand = b.role === 'landmark';
  const hall = b.role === 'hall' || b.role === 'market';
  const t = grand ? GRAND_WALL_T : WALL_T;
  const ceil = grand ? b.h - 0.6 : hall ? Math.min(b.h - 0.5, 4.6) : Math.min(b.h - 0.4, 3.0);
  const faces = rectFaces(x0, z0, x1, z1);
  const seed = plan.site.seed | 0;
  const start = Math.floor(hash(seed, bi, 0x0d) * 4);

  // A landmark is entered by its great portal when one of its sides has one and opens on the street.
  if (grand && b.h >= 7) {
    for (let k = 0; k < 4; k++) {
      const fi = (start + k) & 3;
      const f = faces[fi];
      if (f.len < 10 || street(plan, f, f.len / 2, 4) < 2) continue;
      const p = portalOf(f, b.h);
      if (p.top > ceil - 0.2 || !clearFront(plan, f, p.u0 + 0.3, p.u1 - 0.3)) continue;
      return { bi, x0, z0, x1, z1, t, ceil, h: b.h, grand, door: makeDoor(f, fi, p.u0, p.u1, p.top, p.arch, true) };
    }
  }

  // Otherwise a door: the side with the deepest street in front, as near the middle as it can be.
  const dw = grand ? 2.4 : hall ? 2.0 : 1.4;
  const top = Math.min(grand ? 3.4 : hall ? 3.0 : 2.4, ceil - 0.25);
  const arch = grand || hall ? dw * 0.45 : 0;
  if (top - arch < HEADROOM + 0.15) return null;
  let best: RoomDoor | null = null;
  let bestS = -Infinity;
  for (let k = 0; k < 4; k++) {
    const fi = (start + k) & 3;
    const f = faces[fi];
    const lo = t + 0.3 + dw / 2;
    const hi = f.len - t - 0.3 - dw / 2;
    if (hi < lo) continue;
    const mid = f.len / 2;
    for (let s = 0; s <= hi - lo + 1e-6; s += 0.5) {
      // from the middle outwards
      for (const u of s === 0 ? [Math.min(hi, Math.max(lo, mid))] : [mid - s, mid + s]) {
        if (u < lo - 1e-6 || u > hi + 1e-6) continue;
        const st = street(plan, f, u, 6);
        if (st < 2 || !clearFront(plan, f, u - dw / 2 - 0.2, u + dw / 2 + 0.2)) continue;
        const score = Math.min(st, 4) - (Math.abs(u - mid) / f.len) * 2 - k * 0.01;
        if (score > bestS) {
          bestS = score;
          best = makeDoor(f, fi, u - dw / 2, u + dw / 2, top, arch, false);
        }
      }
    }
  }
  if (!best) return null;
  return { bi, x0, z0, x1, z1, t, ceil, h: b.h, grand, door: best };
}

/** Every room of a plan and the cell index that finds them. */
export function planRooms(plan: CityPlan): { rooms: Room[]; roomOf: Uint16Array } {
  const rooms: Room[] = [];
  const S = plan.gridSize;
  const G = plan.gridHalf;
  const roomOf = new Uint16Array(S * S);
  const bs = plan.buildings;
  for (let bi = 0; bi < bs.length && rooms.length < 65535; bi++) {
    const r = roomFor(plan, bs[bi], bi);
    if (!r) continue;
    rooms.push(r);
    const id = rooms.length;
    for (let j = r.z0 + G; j < r.z1 + G; j++) {
      if (j < 0 || j >= S) continue;
      for (let i = r.x0 + G; i < r.x1 + G; i++) if (i >= 0 && i < S) roomOf[j * S + i] = id;
    }
  }
  return { rooms, roomOf };
}

/** The room whose footprint holds local (x, z), or null. */
export function roomAt(plan: CityPlan, x: number, z: number): Room | null {
  const i = Math.floor(x + plan.gridHalf);
  const j = Math.floor(z + plan.gridHalf);
  if (i < 0 || j < 0 || i >= plan.gridSize || j >= plan.gridSize) return null;
  const k = plan.roomOf[j * plan.gridSize + i];
  return k > 0 ? plan.rooms[k - 1] : null;
}

/** Springing of the doorway: the highest the body's crown can pass under. */
export const doorClear = (d: RoomDoor): number => d.top - d.arch;

/**
 * Where (x, z) lies in the doorway: its depth into the wall (0 at the outer face, t at the inner)
 * and whether it is within the opening's width less `inset` at each jamb. Out of the wall: -1.
 */
function inDoorway(r: Room, x: number, z: number, inset: number): boolean {
  const d = r.door;
  const f = rectFaces(r.x0, r.z0, r.x1, r.z1)[d.fi];
  const off = (x - f.ox) * f.nx + (z - f.oz) * f.nz; // 0 at the outer face, -t at the inner
  if (off > 0.05 || off < -r.t - 0.05) return false;
  const u = (x - f.ox) * f.tx + (z - f.oz) * f.tz;
  return u >= d.u0 + inset && u <= d.u1 - inset;
}

/** Distance in from the nearest outer wall face (negative outside the footprint). */
export function depthIn(r: Room, x: number, z: number): number {
  return Math.min(x - r.x0, r.x1 - x, z - r.z0, r.z1 - z);
}

/**
 * Height (local) of the solid under or around feet at (x, z, y) in room r, the way the wanderer's
 * roof query asks it: -Infinity where the floor is open (the floor is the plateau itself), r.h
 * where a wall stands or over the roof. `cut`: the wanderer is inside, the roof and the walls above
 * the ceiling are drawn away and are nothing to the camera.
 */
export function shellTop(r: Room, x: number, z: number, y: number, cut = false): number {
  if (y >= r.ceil - 0.05) return cut ? -Infinity : r.h;
  if (depthIn(r, x, z) >= r.t) return -Infinity;
  if (y < doorClear(r.door) - HEADROOM && inDoorway(r, x, z, JAMB)) return -Infinity;
  return r.h;
}

/**
 * Whether the point (x, y, z) grown by m is inside the stone of room r: its walls (less the
 * doorway), and the slab between ceiling and roof. With `cut`, nothing above the ceiling counts.
 */
export function shellSolid(r: Room, x: number, y: number, z: number, m: number, cut = false): boolean {
  if (y > r.h + m) return false;
  const top = cut ? r.ceil : r.h;
  if (y > top + m) return false;
  if (y < -m - 0.5) return false;
  const dep = depthIn(r, x, z);
  if (dep < -m) return false;
  if (dep >= r.t + m) return !cut && y > r.ceil - m; // the room itself: only the slab overhead
  // in the wall: the doorway is open below its springing
  if (y < doorClear(r.door) - m && inDoorway(r, x, z, m)) return false;
  return true;
}

/** The ceiling (local) over feet at (x, z, y) in room r, or Infinity when not under it. */
export function shellCeil(r: Room, x: number, z: number, y: number): number {
  if (y >= r.ceil || depthIn(r, x, z) < 0) return Infinity;
  if (depthIn(r, x, z) >= r.t) return r.ceil;
  return inDoorway(r, x, z, 0) ? doorClear(r.door) : Infinity;
}
