// Turns a span grid into triangles: floors, ceilings, and a wall wherever the air in one cell
// stands against rock in the next. Seen only from inside.
//
// Three things keep it from reading as voxels without ever opening a crack:
//  - every vertex sits on a grid corner at some height, and is moved by a function of that
//    corner and height alone, so faces that share a point move it together;
//  - a wall strip takes a vertex at every height where anything else touches its two corner
//    lines (floors, ceilings, the regular courses), so there are no T-junctions on moved edges;
//  - floors are never moved up or down (they are walked on), and flat runs of floor or ceiling
//    that no lamp reaches are merged into big quads whose rims are left unmoved.

import { CD, CM, FD, FM, STEPS, type SpanGrid } from './spans';

const OPEN_T = 5e5;
const YQ = 200; // heights are told apart to 5 mm
const MAX_RUN = 16; // cells a merged quad may span each way
const SKIRT = 0.3; // walls dip this far under a stair's ramp, behind its treads
const CURB = 0.13; // and rise this far over one, as a stringer
const TREAD = 0.25; // rise of one step

/** Vertices and triangles under construction. */
export class VB {
  pos = new Float32Array(3 * 4096);
  /** Where the light is sampled for each vertex: the unroughened point. */
  spos = new Float32Array(3 * 4096);
  nrm = new Int8Array(3 * 4096);
  /** rgb tint and kind. */
  tint = new Uint8Array(4 * 4096);
  n = 0;
  idx = new Uint32Array(8192);
  ni = 0;

  vert(x: number, y: number, z: number, sx: number, sy: number, sz: number, nx: number, ny: number, nz: number, paint: ArrayLike<number>): number {
    const i = this.n;
    if (i * 3 + 3 > this.pos.length) this.growV();
    const a = i * 3;
    this.pos[a] = x; this.pos[a + 1] = y; this.pos[a + 2] = z;
    this.spos[a] = sx; this.spos[a + 1] = sy; this.spos[a + 2] = sz;
    this.nrm[a] = nx * 127; this.nrm[a + 1] = ny * 127; this.nrm[a + 2] = nz * 127;
    const b = i * 4;
    this.tint[b] = Math.min(255, paint[0] * 255); this.tint[b + 1] = Math.min(255, paint[1] * 255);
    this.tint[b + 2] = Math.min(255, paint[2] * 255); this.tint[b + 3] = paint[3];
    this.n = i + 1;
    return i;
  }

  tri(a: number, b: number, c: number): void {
    if (this.ni + 3 > this.idx.length) {
      const g = new Uint32Array(this.idx.length * 2);
      g.set(this.idx);
      this.idx = g;
    }
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = b;
    this.idx[this.ni++] = c;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  private growV(): void {
    const cap = (this.pos.length / 3) * 2;
    const p = new Float32Array(cap * 3); p.set(this.pos); this.pos = p;
    const s = new Float32Array(cap * 3); s.set(this.spos); this.spos = s;
    const nn = new Int8Array(cap * 3); nn.set(this.nrm); this.nrm = nn;
    const t = new Uint8Array(cap * 4); t.set(this.tint); this.tint = t;
  }
}

/** Open-addressed map from a pair of integers to a vertex index. */
class Dedupe {
  private ka = new Int32Array(1 << 16).fill(-1);
  private kb = new Int32Array(1 << 16);
  private vals = new Int32Array(1 << 16);
  private used = 0;
  /** The slot holding (a, b), or the empty one where it would go. a must not be negative. */
  private slot(a: number, b: number): number {
    const m = this.ka.length - 1;
    let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b);
    h ^= h >>> 15;
    let s = h & m;
    while (this.ka[s] !== -1 && (this.ka[s] !== a || this.kb[s] !== b)) s = (s + 1) & m;
    return s;
  }
  get(a: number, b: number): number {
    const s = this.slot(a, b);
    return this.ka[s] === -1 ? -1 : this.vals[s];
  }
  set(a: number, b: number, val: number): void {
    if (this.used * 2 >= this.ka.length) {
      const oa = this.ka;
      const ob = this.kb;
      const ov = this.vals;
      this.ka = new Int32Array(oa.length * 2).fill(-1);
      this.kb = new Int32Array(oa.length * 2);
      this.vals = new Int32Array(oa.length * 2);
      for (let i = 0; i < oa.length; i++) {
        if (oa[i] !== -1) {
          const s = this.slot(oa[i], ob[i]);
          this.ka[s] = oa[i];
          this.kb[s] = ob[i];
          this.vals[s] = ov[i];
        }
      }
    }
    const s = this.slot(a, b);
    if (this.ka[s] === -1) this.used++;
    this.ka[s] = a;
    this.kb[s] = b;
    this.vals[s] = val;
  }
}

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface MeshOpts {
  /** Height between the courses walls are cut into (m): smaller is rougher and costlier. */
  wallStep: number;
  seed: number;
  /** Whether light worth showing reaches a point: such floors and ceilings keep their fine vertices. */
  lit: (u: number, y: number, v: number) => boolean;
  /** Paint table: [r, g, b, kind] per index. */
  paints: ArrayLike<number>[];
}

// the six ways a face can look: -u +u -v +v up down
const ORN = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];

/** Mesh the grid into vb. Returns the number of triangles added. */
export function meshGrid(g: SpanGrid, vb: VB, o: MeshOpts): number {
  const { nu, nv, K, cu, cv, n, f, c, su, sv, fl, fp, cp } = g;
  const W = nu + 1;
  const tri0 = vb.ni;
  const dd = new Dedupe();
  const seed = o.seed | 0;
  const yBase = g.yMin - 8;
  const step = o.wallStep;

  const cornerU = (ci: number) => g.u0 + ci * cu;
  const cornerV = (cj: number) => g.v0 + cj * cv;
  /** Floor of span k (of cell i, j) at grid corner (ci, cj). */
  const floorC = (k: number, i: number, j: number, ci: number, cj: number): number =>
    f[k] + su[k] * ((ci - i - 0.5) * cu) + sv[k] * ((cj - j - 0.5) * cv);
  const ceilOf = (k: number): number => (c[k] >= OPEN_T ? 0 : c[k]);
  /** Heights live on a 5 mm lattice, so every face that comes to a point agrees on where it is. */
  const qz = (y: number): number => Math.round((y - yBase) * YQ);

  // ---- which flat floors and ceilings may be merged: level with all eight neighbours, and unlit
  for (let k = 0; k < fl.length; k++) fl[k] &= STEPS;
  // a stair's treads end square on the cell's edge, so the walls beside it must stay there too
  for (let ci = 0; ci < nu * nv; ci++) {
    for (let s = 0; s < n[ci]; s++) {
      if (fl[ci * K + s] & STEPS) {
        const a = (ci % nu) + ((ci / nu) | 0) * W;
        g.rough[a] = g.rough[a + 1] = g.rough[a + W] = g.rough[a + W + 1] = 0;
      }
    }
  }
  const has = (ci: number, y: number, floor: boolean, paint: number): boolean => {
    const b = ci * K;
    for (let s = 0; s < n[ci]; s++) {
      const k = b + s;
      if (floor) {
        if (Math.abs(f[k] - y) < 1e-3 && su[k] === 0 && sv[k] === 0 && (fl[k] & STEPS) === 0 && fp[k] === paint) return true;
      } else if (Math.abs(c[k] - y) < 1e-3 && cp[k] === paint) return true;
    }
    return false;
  };
  const ring = (i: number, j: number, y: number, floor: boolean, paint: number): boolean => {
    if (i < 1 || j < 1 || i >= nu - 1 || j >= nv - 1) return false;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if ((di !== 0 || dj !== 0) && !has(i + di + (j + dj) * nu, y, floor, paint)) return false;
      }
    }
    return true;
  };
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const ci = i + j * nu;
      const cnt = n[ci];
      if (cnt === 0) continue;
      const uc = g.u0 + (i + 0.5) * cu;
      const vc = g.v0 + (j + 0.5) * cv;
      for (let s = 0; s < cnt; s++) {
        const k = ci * K + s;
        if (su[k] === 0 && sv[k] === 0 && (fl[k] & STEPS) === 0 && ring(i, j, f[k], true, fp[k]) && !o.lit(uc, f[k], vc)) fl[k] |= FM;
        if (c[k] < OPEN_T && ring(i, j, c[k], false, cp[k]) && !o.lit(uc, c[k], vc)) fl[k] |= CM;
      }
    }
  }

  // ---- greedy runs of mergeable floor and ceiling
  const rects: number[] = []; // i0, j0, i1, j1 (corner indices), y, paint, floor?
  const find = (ci: number, y: number, floor: boolean, paint: number): number => {
    const b = ci * K;
    for (let s = 0; s < n[ci]; s++) {
      const k = b + s;
      if (floor) {
        if ((fl[k] & (FM | FD)) === FM && Math.abs(f[k] - y) < 1e-3 && fp[k] === paint) return k;
      } else if ((fl[k] & (CM | CD)) === CM && Math.abs(c[k] - y) < 1e-3 && cp[k] === paint) return k;
    }
    return -1;
  };
  for (let pass = 0; pass < 2; pass++) {
    const floor = pass === 0;
    const can = floor ? FM : CM;
    const done = floor ? FD : CD;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const ci = i + j * nu;
        for (let s = 0; s < n[ci]; s++) {
          const k = ci * K + s;
          if ((fl[k] & (can | done)) !== can) continue;
          const y = floor ? f[k] : c[k];
          const paint = floor ? fp[k] : cp[k];
          let w = 1;
          while (w < MAX_RUN && i + w < nu && find(ci + w, y, floor, paint) >= 0) w++;
          let h = 1;
          grow: while (h < MAX_RUN && j + h < nv) {
            for (let q = 0; q < w; q++) {
              if (find(ci + q + h * nu, y, floor, paint) < 0) break grow;
            }
            h++;
          }
          if (w * h === 1) continue;
          for (let dj = 0; dj < h; dj++) for (let q = 0; q < w; q++) fl[find(ci + q + dj * nu, y, floor, paint)] |= done;
          rects.push(i, j, i + w, j + h, y, paint, pass);
        }
      }
    }
  }

  // ---- vertices
  const cellAir = (i: number, j: number, y: number): boolean => {
    if (i < 0 || j < 0 || i >= nu || j >= nv) return false;
    const ci = i + j * nu;
    const b = ci * K;
    for (let s = 0; s < n[ci]; s++) {
      const k = b + s;
      if (y <= c[k]) return y >= f[k] - Math.abs(su[k]) * cu - Math.abs(sv[k]) * cv;
    }
    return false;
  };
  /** A vertex at grid corner (ci, cj), height y, on a face looking the way `orn` says. */
  const vertex = (ci: number, cj: number, yq: number, orn: number, paint: number): number => {
    const y = yBase + yq / YQ;
    const ka = ci + cj * W;
    const kb = (yq << 9) | (orn << 6) | paint;
    const got = dd.get(ka, kb);
    if (got >= 0) return got;
    const x = cornerU(ci);
    const z = cornerV(cj);
    let dx = 0;
    let dy = 0;
    let dz = 0;
    const amp = g.rough[ci + cj * W];
    if (amp > 0) {
      // what meets here: floors pin the height, the middle of a floor or of a merged ceiling pins everything
      let nF = 0;
      let nC = 0;
      let merged = false;
      for (let q = 0; q < 4; q++) {
        const i = ci - (q & 1);
        const j = cj - (q >> 1);
        if (i < 0 || j < 0 || i >= nu || j >= nv) continue;
        const b = (i + j * nu) * K;
        for (let s = 0; s < n[i + j * nu]; s++) {
          const k = b + s;
          if (Math.abs(qz(floorC(k, i, j, ci, cj)) - yq) <= 1) nF++;
          if (Math.abs(qz(c[k]) - yq) <= 1) {
            nC++;
            if (fl[k] & CD) merged = true;
          }
        }
      }
      if (nF < 4 && !(nC === 4 && merged)) {
        // the way out of the rock here, from which of the four cells are air just above and below
        let ax = 0;
        let az = 0;
        for (let q = 0; q < 4; q++) {
          const i = ci - (q & 1);
          const j = cj - (q >> 1);
          const w = (cellAir(i, j, y + 0.15) ? 1 : 0) + (cellAir(i, j, y - 0.15) ? 1 : 0);
          ax += (q & 1 ? -w : w);
          az += (q >> 1 ? -w : w);
        }
        const al = Math.hypot(ax, az);
        // courses: each band of height stands a little proud of, or back from, the one below
        const cy = y / step;
        const c0 = Math.floor(cy);
        const ct = cy - c0;
        const course = (hash3(c0, seed, 91) * (1 - ct) + hash3(c0 + 1, seed, 91) * ct) * 2 - 1;
        if (al > 0) {
          dx = (ax / al) * course * amp * 0.8;
          dz = (az / al) * course * amp * 0.8;
        }
        dx += (hash3(ci, cj, yq + seed) * 2 - 1) * amp * 0.45;
        dz += (hash3(cj, yq, ci + seed + 7) * 2 - 1) * amp * 0.45;
        if (nF === 0) dy = (hash3(yq, ci, cj + seed + 13) * 2 - 1) * amp * 0.7;
      }
    }
    const nn = ORN[orn];
    const id = vb.vert(x + dx, y + dy, z + dz, x + nn[0] * 0.3, y + nn[1] * 0.3, z + nn[2] * 0.3, nn[0], nn[1], nn[2], o.paints[paint]);
    dd.set(ka, kb, id);
    return id;
  };

  // ---- merged runs
  for (let r = 0; r < rects.length; r += 7) {
    const i0 = rects[r];
    const j0 = rects[r + 1];
    const i1 = rects[r + 2];
    const j1 = rects[r + 3];
    const y = qz(rects[r + 4]);
    const paint = rects[r + 5];
    const orn = rects[r + 6] === 0 ? 4 : 5;
    const a = vertex(i0, j0, y, orn, paint);
    const b = vertex(i1, j0, y, orn, paint);
    const cc = vertex(i1, j1, y, orn, paint);
    const d = vertex(i0, j1, y, orn, paint);
    if (orn === 4) vb.quad(a, d, cc, b);
    else vb.quad(a, b, cc, d);
  }

  // ---- a wall strip between two corner lines, with a vertex wherever anything touches either
  const ev: number[] = [];
  const chainA: number[] = [];
  const chainB: number[] = [];
  const qStep = Math.round(step * YQ);
  const qOff = Math.round(yBase * YQ); // lattice index of y = 0, negated
  /** Vertices up corner line (ci, cj) from lo to hi (lattice heights), pushed to out as index, height pairs. */
  const chain = (ci: number, cj: number, lo: number, hi: number, orn: number, out: number[]): void => {
    ev.length = 0;
    for (let q = 0; q < 4; q++) {
      const i = ci - (q & 1);
      const j = cj - (q >> 1);
      if (i < 0 || j < 0 || i >= nu || j >= nv) continue;
      const b = (i + j * nu) * K;
      for (let s = 0; s < n[i + j * nu]; s++) {
        const k = b + s;
        const y0 = qz(floorC(k, i, j, ci, cj));
        if (y0 > lo && y0 < hi) ev.push(y0);
        const y1 = qz(ceilOf(k));
        if (y1 > lo && y1 < hi) ev.push(y1);
      }
    }
    // the courses: every `step` metres of absolute height
    for (let m = Math.floor((lo + qOff) / qStep) + 1; m * qStep - qOff < hi; m++) ev.push(m * qStep - qOff);
    ev.sort((p, q) => p - q);
    out.length = 0;
    out.push(vertex(ci, cj, lo, orn, 0), lo);
    let last = lo;
    for (let e = 0; e < ev.length; e++) {
      if (ev[e] === last) continue;
      last = ev[e];
      out.push(vertex(ci, cj, last, orn, 0), last);
    }
    if (hi > lo) out.push(vertex(ci, cj, hi, orn, 0), hi);
  };
  const wall = (ai: number, aj: number, bi: number, bj: number, loAf: number, hiAf: number, loBf: number, hiBf: number, orn: number): void => {
    const loA = qz(loAf);
    const loB = qz(loBf);
    const hiA = Math.max(loA, qz(hiAf));
    const hiB = Math.max(loB, qz(hiBf));
    if (hiA === loA && hiB === loB) return;
    chain(ai, aj, loA, hiA, orn, chainA);
    chain(bi, bj, loB, hiB, orn, chainB);
    // zip the two chains together, always advancing the side whose next vertex is lower
    let p = 0;
    let q = 0;
    const na = chainA.length - 2;
    const nb = chainB.length - 2;
    while (p < na || q < nb) {
      const ya = p < na ? chainA[p + 3] : Infinity;
      const yb = q < nb ? chainB[q + 3] : Infinity;
      if (ya <= yb) {
        vb.tri(chainA[p], chainB[q], chainA[p + 2]);
        p += 2;
      } else {
        vb.tri(chainA[p], chainB[q], chainB[q + 2]);
        q += 2;
      }
    }
  };

  // ---- cell by cell: floor, ceiling, and the four walls of every span
  const push4 = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, x3: number, y3: number, z3: number, nx: number, ny: number, nz: number, paint: number): void => {
    const p = o.paints[paint];
    const ox = nx * 0.3;
    const oy = ny * 0.3;
    const oz = nz * 0.3;
    const a = vb.vert(x0, y0, z0, x0 + ox, y0 + oy, z0 + oz, nx, ny, nz, p);
    const b = vb.vert(x1, y1, z1, x1 + ox, y1 + oy, z1 + oz, nx, ny, nz, p);
    const cc = vb.vert(x2, y2, z2, x2 + ox, y2 + oy, z2 + oz, nx, ny, nz, p);
    const d = vb.vert(x3, y3, z3, x3 + ox, y3 + oy, z3 + oz, nx, ny, nz, p);
    vb.quad(a, b, cc, d);
  };
  // neighbours: +u, -u, +v, -v; the edge shared with each as two corners (offsets from i, j), and how the wall looks
  const DI = [1, -1, 0, 0];
  const DJ = [0, 0, 1, -1];
  const EA = [[1, 0], [0, 0], [0, 1], [0, 0]];
  const EB = [[1, 1], [0, 1], [1, 1], [1, 0]];
  const EO = [1, 0, 3, 2];

  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const ci = i + j * nu;
      const cnt = n[ci];
      if (cnt === 0) continue;
      const ua = cornerU(i);
      const ub = cornerU(i + 1);
      const va = cornerV(j);
      const vb2 = cornerV(j + 1);
      for (let s = 0; s < cnt; s++) {
        const k = ci * K + s;
        const flags = fl[k];
        const sloped = su[k] !== 0 || sv[k] !== 0;

        // floor
        if (flags & STEPS && sloped) {
          const alongU = Math.abs(su[k]) >= Math.abs(sv[k]);
          const sl = alongU ? su[k] : sv[k];
          const len = alongU ? cu : cv;
          const nt = Math.min(8, Math.max(1, Math.round((Math.abs(sl) * len) / TREAD)));
          const paint = fp[k];
          const face = sl < 0 ? 1 : -1; // risers look down the stair
          const a0 = alongU ? ua : va;
          const riser = (at: number, yLo: number, yHi: number): void => {
            if (yHi - yLo < 0.005) return;
            if (alongU) push4(at, yLo, va, at, yLo, vb2, at, yHi, vb2, at, yHi, va, face, 0, 0, paint);
            else push4(ua, yLo, at, ub, yLo, at, ub, yHi, at, ua, yHi, at, 0, 0, face, paint);
          };
          const eLo = f[k] - sl * len * 0.5; // the ramp at the low-coordinate edge
          const eHi = f[k] + sl * len * 0.5;
          let prev = 0;
          for (let t = 0; t < nt; t++) {
            const p0 = a0 + (t / nt) * len;
            const p1 = a0 + ((t + 1) / nt) * len;
            const h = f[k] + sl * (((t + 0.5) / nt - 0.5) * len);
            if (alongU) push4(p0, h, va, p0, h, vb2, p1, h, vb2, p1, h, va, 0, 1, 0, paint);
            else push4(ua, h, p0, ub, h, p0, ub, h, p1, ua, h, p1, 0, 1, 0, paint);
            if (t === 0) {
              if (sl < 0) riser(p0, h, eLo);
              else riser(p0, eLo - SKIRT, h);
            } else riser(p0, Math.min(prev, h), Math.max(prev, h));
            if (t === nt - 1) {
              if (sl < 0) riser(p1, eHi - SKIRT, h);
              else riser(p1, h, eHi);
            }
            prev = h;
          }
        } else if ((flags & FD) === 0) {
          const p = fp[k];
          const a = vertex(i, j, qz(floorC(k, i, j, i, j)), 4, p);
          const b = vertex(i + 1, j, qz(floorC(k, i, j, i + 1, j)), 4, p);
          const cc = vertex(i + 1, j + 1, qz(floorC(k, i, j, i + 1, j + 1)), 4, p);
          const d = vertex(i, j + 1, qz(floorC(k, i, j, i, j + 1)), 4, p);
          vb.quad(a, d, cc, b);
        }

        // ceiling
        if (c[k] < OPEN_T && (flags & CD) === 0) {
          const p = cp[k];
          const y = qz(c[k]);
          vb.quad(vertex(i, j, y, 5, p), vertex(i + 1, j, y, 5, p), vertex(i + 1, j + 1, y, 5, p), vertex(i, j + 1, y, 5, p));
        }

        // walls: wherever this span's air has rock beside it
        const top = ceilOf(k);
        const skirt = sloped && flags & STEPS ? SKIRT : 0;
        for (let d = 0; d < 4; d++) {
          const ni = i + DI[d];
          const nj = j + DJ[d];
          const ai = i + EA[d][0];
          const aj = j + EA[d][1];
          const bi = i + EB[d][0];
          const bj = j + EB[d][1];
          const fa = floorC(k, i, j, ai, aj);
          const fb = floorC(k, i, j, bi, bj);
          // the rock beside this span, worked out at each end of the edge: between the neighbour's
          // spans, from this floor up to this ceiling
          let loA = fa;
          let loB = fb;
          let first = true;
          if (ni >= 0 && nj >= 0 && ni < nu && nj < nv) {
            const nci = ni + nj * nu;
            const nb = nci * K;
            for (let t = 0; t < n[nci]; t++) {
              const nk = nb + t;
              const bc = ceilOf(nk);
              const ga = floorC(nk, ni, nj, ai, aj);
              const gb = floorC(nk, ni, nj, bi, bj);
              // air on both sides at once, by more than a hair? otherwise this span opens nothing here
              if (Math.min(bc, top) - Math.max((ga + gb) * 0.5, (loA + loB) * 0.5) < 0.011) continue;
              const hiA = Math.min(ga, top);
              const hiB = Math.min(gb, top);
              if (hiA > loA || hiB > loB) {
                const curb = fl[nk] & STEPS ? CURB : 0;
                const sk = first ? skirt : 0;
                wall(ai, aj, bi, bj, loA - sk, hiA + curb, loB - sk, hiB + curb, EO[d]);
              }
              first = false;
              if (bc > loA) loA = bc;
              if (bc > loB) loB = bc;
              if (bc >= top) break;
            }
          }
          if (top > loA || top > loB) {
            const sk = first ? skirt : 0;
            wall(ai, aj, bi, bj, loA - sk, top, loB - sk, top, EO[d]);
          }
        }
      }
    }
  }
  return (vb.ni - tri0) / 3;
}

/**
 * The water's surface. Laid in tiles about four metres square, so the light baked at their
 * corners can show a pool of daylight in the middle of a lake; a tile the shore cuts into is
 * laid as runs of wet cells along u instead.
 */
export function meshWater(g: SpanGrid): Float32Array | null {
  const w = g.water;
  if (!w) return null;
  const out: number[] = [];
  const wet = (ci: number): number => {
    const lv = w[ci];
    if (!(lv === lv)) return NaN;
    const b = ci * g.K;
    for (let s = 0; s < g.n[ci]; s++) if (g.f[b + s] < lv && g.c[b + s] > lv) return lv;
    return NaN;
  };
  const quad = (i0: number, j0: number, i1: number, j1: number, lv: number): void => {
    const u0 = g.u0 + i0 * g.cu;
    const u1 = g.u0 + i1 * g.cu;
    const v0 = g.v0 + j0 * g.cv;
    const v1 = g.v0 + j1 * g.cv;
    out.push(u0, lv, v0, u0, lv, v1, u1, lv, v1, u0, lv, v0, u1, lv, v1, u1, lv, v0);
  };
  const TU = Math.max(1, Math.round(4 / g.cu));
  const TV = Math.max(1, Math.round(3.6 / g.cv));
  for (let tj = 0; tj < g.nv; tj += TV) {
    const j1 = Math.min(g.nv, tj + TV);
    for (let ti = 0; ti < g.nu; ti += TU) {
      const i1 = Math.min(g.nu, ti + TU);
      const lv0 = wet(ti + tj * g.nu);
      let whole = lv0 === lv0;
      let any = whole;
      for (let j = tj; j < j1; j++) {
        for (let i = ti; i < i1; i++) {
          const lv = wet(i + j * g.nu);
          if (lv === lv) any = true;
          if (lv !== lv0) whole = false;
        }
      }
      if (whole) quad(ti, tj, i1, j1, lv0);
      else if (any) {
        for (let j = tj; j < j1; j++) {
          let i = ti;
          while (i < i1) {
            const lv = wet(i + j * g.nu);
            if (!(lv === lv)) {
              i++;
              continue;
            }
            let e = i + 1;
            while (e < i1 && wet(e + j * g.nu) === lv) e++;
            quad(i, j, e, j + 1, lv);
            i = e;
          }
        }
      }
    }
  }
  return out.length ? new Float32Array(out) : null;
}
