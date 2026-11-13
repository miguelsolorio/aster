// What a site's props are made of for the wanderer: simple shapes to walk into and stand on.
// Every shape is convex, so a vertical line through it crosses one span of heights; the top of
// that span is where you stand and the bottom is what you can pass beneath.
import type * as THREE from 'three';

export type SolidShape = 'box' | 'cyl' | 'ball';
/** What a solid is made of: 0 stone, 1 bone, 2 wood. */
export type SolidKind = 0 | 1 | 2;

/** A solid counts as overhead, not as a wall, when its underside is this far above the feet. */
export const HEADROOM = 1.7;

interface Item {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  kind: SolidKind;
  /** null for a capsule */
  shape: SolidShape | null;
  /** primitive: rows of the inverse matrix (3 x 4) then half-extents; capsule: a, b, radius */
  d: Float64Array;
}

let lo = 0;
let hi = 0;

/** Clips the span [lo, hi] to where a + t * d lies within [-h, h]. Returns false if nothing is left. */
function slab(a: number, d: number, h: number): boolean {
  if (Math.abs(d) < 1e-9) return Math.abs(a) <= h;
  let t0 = (-h - a) / d;
  let t1 = (h - a) / d;
  if (t0 > t1) {
    const s = t0;
    t0 = t1;
    t1 = s;
  }
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;
  return lo <= hi;
}

/** Clips [lo, hi] to where qa t^2 + 2 qb t + qc <= 0. */
function quad(qa: number, qb: number, qc: number): boolean {
  if (qa < 1e-12) return qc <= 0;
  const disc = qb * qb - qa * qc;
  if (disc < 0) return false;
  const r = Math.sqrt(disc);
  const t0 = (-qb - r) / qa;
  const t1 = (-qb + r) / qa;
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;
  return lo <= hi;
}

/** The heights at which the vertical line through (x, z) is inside an item, written to lo and hi. */
function span(it: Item, x: number, z: number): boolean {
  const d = it.d;
  if (it.shape) {
    // the line in the primitive's own space: a + t * dir
    const ax = d[0] * x + d[2] * z + d[3];
    const ay = d[4] * x + d[6] * z + d[7];
    const az = d[8] * x + d[10] * z + d[11];
    const dx = d[1];
    const dy = d[5];
    const dz = d[9];
    lo = -Infinity;
    hi = Infinity;
    if (it.shape === 'box') return slab(ax, dx, d[12]) && slab(ay, dy, d[13]) && slab(az, dz, d[14]);
    if (it.shape === 'ball') return quad(dx * dx + dy * dy + dz * dz, ax * dx + ay * dy + az * dz, ax * ax + ay * ay + az * az - 1);
    return slab(ay, dy, 0.5) && quad(dx * dx + dz * dz, ax * dx + az * dz, ax * ax + az * az - 1);
  }
  // A capsule: the union of a cylinder between a and b and a ball at each end.
  const r = d[6];
  const r2 = r * r;
  let l = Infinity;
  let h = -Infinity;
  for (let e = 0; e < 2; e++) {
    const ox = x - d[e * 3];
    const oz = z - d[e * 3 + 2];
    const k = r2 - ox * ox - oz * oz;
    if (k < 0) continue;
    const s = Math.sqrt(k);
    l = Math.min(l, d[e * 3 + 1] - s);
    h = Math.max(h, d[e * 3 + 1] + s);
  }
  const ex = d[3] - d[0];
  const ey = d[4] - d[1];
  const ez = d[5] - d[2];
  const len = Math.hypot(ex, ey, ez);
  if (len > 1e-6) {
    const ux = ex / len;
    const uy = ey / len;
    const uz = ez / len;
    // w = (x, 0, z) - a; along the axis the line point sits at s = s0 + t * uy
    const wx = x - d[0];
    const wy = -d[1];
    const wz = z - d[2];
    const s0 = wx * ux + wy * uy + wz * uz;
    // the parts of w and of the up vector that are square to the axis
    const px = wx - s0 * ux;
    const py = wy - s0 * uy;
    const pz = wz - s0 * uz;
    const qx = -uy * ux;
    const qy = 1 - uy * uy;
    const qz = -uy * uz;
    lo = -Infinity;
    hi = Infinity;
    let ok = quad(qx * qx + qy * qy + qz * qz, px * qx + py * qy + pz * qz, px * px + py * py + pz * pz - r2);
    // only between the two ends
    if (ok) {
      if (Math.abs(uy) < 1e-9) ok = s0 >= 0 && s0 <= len;
      else {
        let t0 = -s0 / uy;
        let t1 = (len - s0) / uy;
        if (t0 > t1) {
          const s = t0;
          t0 = t1;
          t1 = s;
        }
        if (t0 > lo) lo = t0;
        if (t1 < hi) hi = t1;
        ok = lo <= hi;
      }
    }
    if (ok) {
      l = Math.min(l, lo);
      h = Math.max(h, hi);
    }
  }
  lo = l;
  hi = h;
  return l <= h;
}

/** The solids of one site, in the site's own frame (x, z from its centre, y from its base). */
export class Solids {
  private readonly items: Item[] = [];
  /** Furthest any solid reaches from the site's centre. */
  reach = 0;
  /** What the last topAt stood on, when it returned a height. */
  kind: SolidKind = 0;

  get count(): number {
    return this.items.length;
  }

  private push(it: Item): void {
    this.items.push(it);
    this.reach = Math.max(this.reach, Math.hypot(Math.max(-it.minX, it.maxX), Math.max(-it.minZ, it.maxZ)));
  }

  /** A unit primitive (box and cylinder 1 across and 1 tall, ball of radius 1) placed by a matrix. */
  addPrim(shape: SolidShape, m: THREE.Matrix4, inv: THREE.Matrix4, kind: SolidKind, hx = 0.5, hz = 0.5): void {
    const e = inv.elements;
    const d = new Float64Array(15);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) d[r * 4 + c] = e[c * 4 + r];
    const bx = shape === 'box' ? hx : 1;
    const by = shape === 'ball' ? 1 : 0.5;
    const bz = shape === 'box' ? hz : 1;
    d[12] = bx;
    d[13] = by;
    d[14] = bz;
    const me = m.elements;
    const rx = Math.abs(me[0]) * bx + Math.abs(me[4]) * by + Math.abs(me[8]) * bz;
    const rz = Math.abs(me[2]) * bx + Math.abs(me[6]) * by + Math.abs(me[10]) * bz;
    this.push({ minX: me[12] - rx, maxX: me[12] + rx, minZ: me[14] - rz, maxZ: me[14] + rz, kind, shape, d });
  }

  addCapsule(a: THREE.Vector3, b: THREE.Vector3, r: number, kind: SolidKind): void {
    const d = Float64Array.of(a.x, a.y, a.z, b.x, b.y, b.z, r);
    this.push({ minX: Math.min(a.x, b.x) - r, maxX: Math.max(a.x, b.x) + r, minZ: Math.min(a.z, b.z) - r, maxZ: Math.max(a.z, b.z) + r, kind, shape: null, d });
  }

  /** Top of the highest solid over (x, z) that feet at height y are not underneath, or -Infinity. */
  topAt(x: number, z: number, y: number): number {
    let top = -Infinity;
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (x < it.minX || x > it.maxX || z < it.minZ || z > it.maxZ) continue;
      if (!span(it, x, z) || lo > y + HEADROOM || hi <= top) continue;
      top = hi;
      this.kind = it.kind;
    }
    return top;
  }

  /** Whether the point (x, y, z) lies inside a solid, grown by a margin all round. */
  contains(x: number, y: number, z: number, m = 0): boolean {
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (x < it.minX - m || x > it.maxX + m || z < it.minZ - m || z > it.maxZ + m) continue;
      if (span(it, x, z) && lo - m <= y && y <= hi + m) return true;
    }
    return false;
  }

  /** Underside of the lowest solid over (x, z) that feet at height y are underneath, or Infinity. */
  ceilAt(x: number, z: number, y: number): number {
    let ceil = Infinity;
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (x < it.minX || x > it.maxX || z < it.minZ || z > it.maxZ) continue;
      if (span(it, x, z) && lo > y + HEADROOM && lo < ceil) ceil = lo;
    }
    return ceil;
  }
}
