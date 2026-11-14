// The drawn outline of a building, shared by the builder (build.ts) and the things that stand on
// or against buildings (extra/*). The lot rectangle in the plan stays the source of truth for the
// height grid; a shaped building is drawn inside it (a turned body may reach SLACK metres past it).
//
//   box    the plain lot rectangle (walls, gates, garden walls)
//   slump  a rectangle with rounded corners, optionally turned by b.rot about the lot centre
//   dome   a rounded base (a cylinder on a square lot, a stadium on a long one) under a dome
//   mound  a low earth hut: half an ellipsoid with a tunnel entrance
//   tower  a round tower that narrows in steps behind ring bands
//   tiered a great round hall of stacked, flared drums

import type { Building, BuildingShape } from './types';

/** How far a turned body may reach past its lot on each side. */
export const SLACK = 0.25;

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

export const shapeOf = (b: Building): BuildingShape => b.shape ?? 'box';

/** Round buildings have no straight walls for things to hang on, and no flat roof edge. */
export const isRound = (b: Building): boolean => {
  const s = shapeOf(b);
  return s === 'dome' || s === 'mound' || s === 'tower' || s === 'tiered';
};

/**
 * Half extents of the largest w x d-proportioned box turned by rot that touches all four sides of
 * the lot grown by slack (both may be <= 0 when the turn is too steep for the lot).
 */
export function fitTurned(w: number, d: number, rot: number, slack = SLACK): { hw: number; hd: number } {
  if (Math.abs(rot) < 1e-6) return { hw: w / 2, hd: d / 2 };
  const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  const W = w / 2 + slack, D = d / 2 + slack;
  const det = c * c - s * s;
  if (det <= 1e-3) return { hw: 0, hd: 0 };
  return { hw: Math.min(w / 2, (W * c - D * s) / det), hd: Math.min(d / 2, (D * c - W * s) / det) };
}

/** Corner radius of a slumped house of half extents hw, hd. */
export const slumpRadius = (hw: number, hd: number): number => Math.min(0.9 * Math.min(hw, hd), Math.max(0.6, Math.min(1.3, 0.38 * Math.min(hw, hd))));

/** Radius of a round tower's foot (ring bands stand 0.2 proud of it). */
export const towerRadius = (b: Building): number => Math.min(b.w, b.d) / 2 - 0.25;
/** Radius of a tiered hall's lowest drum (its flared lip reaches 0.6 further). */
export const tierRadius = (b: Building): number => Math.min(b.w, b.d) / 2 - 0.9;

/** A rounded rectangle in its own frame, turned by rot about (cx, cz). */
export interface Body {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  rot: number;
  /** Corner radius (the same at every corner; the builder may square off buried corners). */
  rc: number;
}

/** The body a building is drawn as, for the outline tests below. A mound has none (it hides nothing). */
export function bodyOf(b: Building): Body | null {
  const s = shapeOf(b);
  const cx = b.x, cz = b.z;
  switch (s) {
    case 'slump': {
      const rot = b.rot ?? 0;
      const { hw, hd } = fitTurned(b.w, b.d, rot);
      return { cx, cz, hw, hd, rot, rc: slumpRadius(hw, hd) };
    }
    case 'dome': {
      const hw = b.w / 2 - 0.1, hd = b.d / 2 - 0.1;
      return { cx, cz, hw, hd, rot: 0, rc: 0.92 * Math.min(hw, hd) };
    }
    case 'tower': {
      const r = towerRadius(b);
      return { cx, cz, hw: r, hd: r, rot: 0, rc: r };
    }
    case 'tiered': {
      const r = tierRadius(b);
      return { cx, cz, hw: r, hd: r, rot: 0, rc: r };
    }
    case 'mound':
      return null;
    default:
      return { cx, cz, hw: b.w / 2, hd: b.d / 2, rot: 0, rc: 0 };
  }
}

/** Signed distance from (x, z) to a body's outline (negative inside). */
export function bodyDist(B: Body, x: number, z: number): number {
  const c = Math.cos(B.rot), s = Math.sin(B.rot);
  const dx = x - B.cx, dz = z - B.cz;
  // into the body's frame (its +x axis points along (c, s))
  const lx = Math.abs(c * dx + s * dz), lz = Math.abs(-s * dx + c * dz);
  const r = Math.min(B.rc, B.hw, B.hd);
  const qx = lx - (B.hw - r), qz = lz - (B.hd - r);
  const ox = Math.max(qx, 0), oz = Math.max(qz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0) - r;
}

/** Is (x, z) inside the drawn body, at least margin in from its outline? */
export function insideBody(b: Building, x: number, z: number, margin = 0): boolean {
  const B = bodyOf(b);
  return B !== null && bodyDist(B, x, z) <= -margin;
}

/**
 * The straight walls of a building, in the same order as a plain lot's (+x, -x, +z, -z), for
 * things fixed to walls. Round buildings have none.
 */
export function bodyFaces(b: Building): Face[] {
  if (isRound(b)) return [];
  const B = bodyOf(b)!;
  const c = Math.cos(B.rot), s = Math.sin(B.rot);
  const r = shapeOf(b) === 'slump' ? B.rc : 0;
  const P = (lx: number, lz: number): [number, number] => [B.cx + c * lx - s * lz, B.cz + s * lx + c * lz];
  const mk = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number): Face => {
    const [x0, z0] = P(ax, az);
    const [x1, z1] = P(bx, bz);
    const len = Math.hypot(x1 - x0, z1 - z0);
    return { ox: x0, oz: z0, tx: (x1 - x0) / (len || 1), tz: (z1 - z0) / (len || 1), nx: c * nx - s * nz, nz: s * nx + c * nz, len };
  };
  const { hw, hd } = B;
  return [
    mk(hw, -hd + r, hw, hd - r, 1, 0),
    mk(-hw, hd - r, -hw, -hd + r, -1, 0),
    mk(hw - r, hd, -hw + r, hd, 0, 1),
    mk(-hw + r, -hd, hw - r, -hd, 0, -1),
  ];
}

// ------------------------------------------------------------------ outline loops

/**
 * A closed outline going round a body (along the +x side toward +z, then the +z side toward -x, and
 * so on), as points with outward shading normals and inset directions (P - o * t is the outline
 * moved in by t, exact for straight sides, arcs and square corners alike).
 */
export interface Loop {
  x: number[];
  z: number[];
  nx: number[];
  nz: number[];
  ox: number[];
  oz: number[];
  /** Per edge i (point i to i + 1): the straight side it belongs to (0 +x, 1 -x, 2 +z, 3 -z), or -1 on a corner arc. */
  side: number[];
  cx: number;
  cz: number;
}

/**
 * Loop of a rounded rectangle. radii are per corner in the order (+x,-z) (+x,+z) (-x,+z) (-x,-z),
 * k segments per rounded corner.
 */
export function roundedLoop(B: Body, radii: number[], k: number): Loop {
  const c = Math.cos(B.rot), s = Math.sin(B.rot);
  const L: Loop = { x: [], z: [], nx: [], nz: [], ox: [], oz: [], side: [], cx: B.cx, cz: B.cz };
  const { hw, hd } = B;
  const lim = Math.min(hw, hd);
  const R = radii.map((r) => Math.max(0, Math.min(r, lim)));
  const push = (lx: number, lz: number, nx: number, nz: number, ox: number, oz: number): void => {
    L.x.push(B.cx + c * lx - s * lz);
    L.z.push(B.cz + s * lx + c * lz);
    L.nx.push(c * nx - s * nz);
    L.nz.push(s * nx + c * nz);
    L.ox.push(c * ox - s * oz);
    L.oz.push(s * ox + c * oz);
  };
  // corner centres and the side that runs from each corner to the next
  const corners: Array<[number, number, number]> = [
    [hw, -hd, -Math.PI / 2], // start angle of the arc that ENDS on the +x side's start
    [hw, hd, 0],
    [-hw, hd, Math.PI / 2],
    [-hw, -hd, Math.PI],
  ];
  const sides = [0, 2, 1, 3];
  // walk: side (from corner q to corner q+1), then the arc at corner q+1
  for (let q = 0; q < 4; q++) {
    const qn = (q + 1) % 4;
    const [, , a0] = corners[qn];
    const r = R[qn];
    const sx = Math.sign(corners[qn][0]), sz = Math.sign(corners[qn][1]);
    const ccx = corners[qn][0] - sx * r, ccz = corners[qn][1] - sz * r;
    if (r > 1e-3) {
      for (let j = 0; j <= k; j++) {
        const a = a0 + (j / k) * (Math.PI / 2);
        const ca = Math.cos(a), sa = Math.sin(a);
        push(ccx + ca * r, ccz + sa * r, ca, sa, ca, sa);
        L.side.push(j === k ? sides[qn] : -1);
      }
    } else {
      const nx = Math.cos(a0 + Math.PI / 4), nz = Math.sin(a0 + Math.PI / 4);
      push(corners[qn][0], corners[qn][1], nx, nz, sx, sz);
      L.side.push(sides[qn]);
    }
  }
  return L;
}

/** Faces along the loop's edges (edge i from point i to point i + 1). */
export function loopFaces(L: Loop): Face[] {
  const n = L.x.length;
  const out: Face[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = L.x[j] - L.x[i], dz = L.z[j] - L.z[i];
    const len = Math.hypot(dx, dz) || 1e-6;
    const tx = dx / len, tz = dz / len;
    out.push({ ox: L.x[i], oz: L.z[i], tx, tz, nx: tz, nz: -tx, len });
  }
  return out;
}
