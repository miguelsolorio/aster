// The drawn shape of a city's buildings, for standing on and bumping into.
//
// The plan's height grid holds every lot as a flat-topped block at its roof height. The builder
// draws more than that: domes, barrel vaults, parapets, wind towers and crowns on the roofs, and
// the round buildings (domes, mounds, towers, tiered halls) inside their square lots. Relief
// rasterises the city's masonry on a fine grid over the building cells, keeping the highest drawn
// point over each subcell, so the wanderer lands on the dome that is drawn instead of sinking into
// it, and walks round a parapet instead of through it. Over a round building it also notes which
// corners of the lot have nothing drawn over them at all: those are open ground, not the grid's
// block.
//
// It is worked out a slice at a time (`step`), so loading a city never stalls a frame; until it is
// `done`, collision answers from the grid alone.

import type { CityPlan } from './types';
import { isRound } from './shape';

/** Subcells per grid cell along each side. */
export const SUB = 4;
const S = 1 / SUB;
/** Drawn points no higher than this above the cell's roof are the roof itself. */
const ROOF_EPS = 0.05;
/** Triangles taken per check of the clock. */
const CHUNK = 256;

export class Relief {
  /** True once every triangle has been rasterised: until then nothing here is used. */
  done = false;
  /** Highest drawn point (local y) over each subcell of a building cell, keyed by grid cell; -Infinity where nothing is drawn. */
  private readonly tiles = new Map<number, Float32Array>();
  /** Cells of round buildings, whose subcells with nothing drawn over them are open ground. */
  private readonly whole: Uint8Array;
  private next = 0;
  // scratch for clipping a triangle to a subcell (a triangle cut by four lines has at most 7 corners)
  private readonly pa = new Float64Array(24);
  private readonly pb = new Float64Array(24);

  /**
   * @param plan the city plan (its grid and buildings)
   * @param pos  masonry positions in city-local space, xyz per vertex
   * @param idx  triangle indices into pos
   * @param count number of indices in use
   */
  constructor(
    private readonly plan: CityPlan,
    private readonly pos: ArrayLike<number>,
    private readonly idx: ArrayLike<number>,
    private readonly count = idx.length,
  ) {
    const { gridSize: N, gridHalf: H } = plan;
    this.whole = new Uint8Array(N * N);
    for (const b of plan.buildings) {
      if (!b.solid || !isRound(b)) continue;
      const i0 = Math.round(b.x - b.w / 2 + H), j0 = Math.round(b.z - b.d / 2 + H);
      for (let j = j0; j < j0 + b.d; j++)
        for (let i = i0; i < i0 + b.w; i++) {
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          const k = j * N + i;
          this.whole[k] = 1;
          // a corner of the lot with nothing drawn over it is open ground, not the grid's block
          if (!this.tiles.has(k)) this.tiles.set(k, new Float32Array(SUB * SUB).fill(-Infinity));
        }
    }
    if (this.count === 0) this.done = true;
  }

  /** Rasterises triangles for up to `budget` milliseconds. Returns true once all are done. */
  step(budget = 3): boolean {
    if (this.done) return true;
    const t0 = performance.now();
    while (this.next < this.count) {
      const end = Math.min(this.count, this.next + CHUNK * 3);
      for (let t = this.next; t < end; t += 3) this.tri(t);
      this.next = end;
      if (performance.now() - t0 > budget) break;
    }
    if (this.next >= this.count) this.done = true;
    return this.done;
  }

  /** Whether grid cell k belongs to a round building (where nothing drawn means open ground). */
  isWhole(k: number): boolean {
    return this.done && this.whole[k] === 1;
  }

  /**
   * Highest drawn point (local y) over local (x, z) in grid cell k, or -Infinity where nothing
   * is drawn over the grid's roof (or the relief is not ready yet).
   */
  at(k: number, x: number, z: number): number {
    if (!this.done) return -Infinity;
    const t = this.tiles.get(k);
    if (!t) return -Infinity;
    const H = this.plan.gridHalf;
    const u = x + H - Math.floor(x + H);
    const v = z + H - Math.floor(z + H);
    const si = Math.min(SUB - 1, Math.floor(u * SUB));
    const sj = Math.min(SUB - 1, Math.floor(v * SUB));
    return t[sj * SUB + si];
  }

  private tri(t: number) {
    const { pos, idx } = this;
    const { grid, gridSize: N, gridHalf: H } = this.plan;
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    const top = Math.max(ay, by, cy);
    if (top <= ROOF_EPS) return;
    const x0 = Math.min(ax, bx, cx), x1 = Math.max(ax, bx, cx);
    const z0 = Math.min(az, bz, cz), z1 = Math.max(az, bz, cz);
    // Only what rises over the roof of a building cell it covers (or anything over a round one) is kept.
    const ci0 = Math.max(0, Math.floor(x0 + H)), ci1 = Math.min(N - 1, Math.floor(x1 + H));
    const cj0 = Math.max(0, Math.floor(z0 + H)), cj1 = Math.min(N - 1, Math.floor(z1 + H));
    let wanted = false;
    for (let j = cj0; j <= cj1 && !wanted; j++)
      for (let i = ci0; i <= ci1; i++) {
        const k = j * N + i;
        const g = grid[k];
        if (g > 0 && (this.whole[k] === 1 || top > g + ROOF_EPS)) {
          wanted = true;
          break;
        }
      }
    if (!wanted) return;
    // Every subcell the triangle's footprint box touches; each is clipped exactly.
    const si0 = Math.floor((x0 + H) * SUB), si1 = Math.max(si0, Math.ceil((x1 + H) * SUB) - 1);
    const sj0 = Math.floor((z0 + H) * SUB), sj1 = Math.max(sj0, Math.ceil((z1 + H) * SUB) - 1);
    for (let sj = sj0; sj <= sj1; sj++) {
      const j = Math.floor(sj / SUB);
      if (j < 0 || j >= N) continue;
      for (let si = si0; si <= si1; si++) {
        const i = Math.floor(si / SUB);
        if (i < 0 || i >= N) continue;
        const k = j * N + i;
        const g = grid[k];
        if (g <= 0) continue;
        const whole = this.whole[k] === 1;
        if (!whole && top <= g + ROOF_EPS) continue;
        const qx = si * S - H, qz = sj * S - H;
        const y = this.clipTop(ax, ay, az, bx, by, bz, cx, cy, cz, qx, qz, qx + S, qz + S);
        if (y === -Infinity || (!whole && y <= g + ROOF_EPS)) continue;
        let tile = this.tiles.get(k);
        if (!tile) {
          tile = new Float32Array(SUB * SUB).fill(-Infinity);
          this.tiles.set(k, tile);
        }
        const n = (sj - j * SUB) * SUB + (si - i * SUB);
        if (y > tile[n]) tile[n] = y;
      }
    }
  }

  /** Highest y of the triangle within the square [x0, x1] x [z0, z1], or -Infinity if it misses it. */
  private clipTop(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, x0: number, z0: number, x1: number, z1: number): number {
    let src = this.pa;
    let dst = this.pb;
    src[0] = ax; src[1] = ay; src[2] = az;
    src[3] = bx; src[4] = by; src[5] = bz;
    src[6] = cx; src[7] = cy; src[8] = cz;
    let n = 3;
    for (let e = 0; e < 4; e++) {
      // keep the side of each edge of the square: x >= x0, x <= x1, z >= z0, z <= z1
      const ax2 = e < 2 ? 0 : 2;
      const lim = e === 0 ? x0 : e === 1 ? x1 : e === 2 ? z0 : z1;
      const sg = e === 0 || e === 2 ? 1 : -1;
      let m = 0;
      for (let p = 0; p < n; p++) {
        const q = p + 1 === n ? 0 : p + 1;
        const P = p * 3, Q = q * 3;
        const dp = (src[P + ax2] - lim) * sg;
        const dq = (src[Q + ax2] - lim) * sg;
        if (dp >= 0) {
          dst[m * 3] = src[P];
          dst[m * 3 + 1] = src[P + 1];
          dst[m * 3 + 2] = src[P + 2];
          m++;
        }
        if (dp >= 0 !== dq >= 0) {
          const f = dp / (dp - dq);
          dst[m * 3] = src[P] + (src[Q] - src[P]) * f;
          dst[m * 3 + 1] = src[P + 1] + (src[Q + 1] - src[P + 1]) * f;
          dst[m * 3 + 2] = src[P + 2] + (src[Q + 2] - src[P + 2]) * f;
          m++;
        }
      }
      n = m;
      if (n === 0) return -Infinity;
      const sw = src;
      src = dst;
      dst = sw;
    }
    let y = -Infinity;
    for (let p = 0; p < n; p++) if (src[p * 3 + 1] > y) y = src[p * 3 + 1];
    return y;
  }
}
