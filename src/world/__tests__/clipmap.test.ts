import { describe, expect, it } from 'vitest';
import { tileShapes } from '../clipmap';

// The clipmap's tiles must draw exactly the triangles the old full 128x128 grids drew, minus those
// whose every fragment the finer level's discard used to remove (see world/clipmap.ts).

const HALF = 64;
const INNER = 30; // the finer level covers |x - offset| < INNER cells

/** A triangle as its three corners in cells, order-free. */
const key = (t: Array<[number, number]>) =>
  t
    .map(([x, z]) => `${x},${z}`)
    .sort()
    .join(' ');

/** The old full grid: same diagonals, cells kept by `keep`. */
function reference(keep: (i: number, j: number) => boolean): Set<string> {
  const out = new Set<string>();
  for (let j = -HALF; j < HALF; j++) {
    for (let i = -HALF; i < HALF; i++) {
      if (!keep(i, j)) continue;
      const a: [number, number] = [i, j];
      const b: [number, number] = [i + 1, j];
      const c: [number, number] = [i, j + 1];
      const d: [number, number] = [i + 1, j + 1];
      if ((i + j) & 1) out.add(key([a, c, d])).add(key([a, d, b]));
      else out.add(key([a, c, b])).add(key([b, c, d]));
    }
  }
  return out;
}

/** What the tiles draw with the finer level offset by (ox, oz) cells, as the vertex shader does it. */
function drawn(ring: boolean, ox: number, oz: number): string[] {
  const tris: string[] = [];
  for (const s of tileShapes(ring)) {
    const pos = s.geo.getAttribute('position');
    const idx = s.geo.getIndex();
    if (!idx) throw new Error('no index');
    const at = (v: number): [number, number] | null => {
      const x = pos.getX(v);
      const y = pos.getY(v);
      const z = pos.getZ(v);
      if (y > 0.5) {
        const k = y - 1;
        const cx = x - (k % 2) + 0.5;
        const cz = z - Math.floor(k / 2) + 0.5;
        if (ring && Math.max(Math.abs(cx - ox), Math.abs(cz - oz)) < INNER) return null; // dropped
      }
      return [x, z];
    };
    for (let t = 0; t < idx.count; t += 3) {
      const c = [at(idx.getX(t)), at(idx.getX(t + 1)), at(idx.getX(t + 2))];
      if (c.some((p) => p === null)) {
        expect(c.every((p) => p === null)).toBe(true); // a cell drops whole
        continue;
      }
      const [p0, p1, p2] = c as Array<[number, number]>;
      // wound as the old grid was (every one of its triangles turns the same way)
      expect(Math.sign((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]))).toBe(-1);
      tris.push(key([p0, p1, p2]));
    }
  }
  return tris;
}

describe('clipmap tiles', () => {
  it('the finest level draws the whole grid, once', () => {
    const got = drawn(false, 0, 0);
    const want = reference(() => true);
    expect(new Set(got).size).toBe(got.length);
    expect(new Set(got)).toEqual(want);
  });

  it('a ring draws the grid less what the finer level covers, for every offset of it', () => {
    for (const ox of [-1, 0, 1]) {
      for (const oz of [-1, 0, 1]) {
        const got = drawn(true, ox, oz);
        const inside = (c: number, o: number) => c >= o - INNER && c + 1 <= o + INNER;
        const want = reference((i, j) => !(inside(i, ox) && inside(j, oz)));
        expect(new Set(got).size).toBe(got.length);
        expect(new Set(got)).toEqual(want);
      }
    }
  });

  it('each tile is a closed box of whole cells inside the level', () => {
    for (const ring of [false, true]) {
      for (const s of tileShapes(ring)) {
        const pos = s.geo.getAttribute('position');
        for (let v = 0; v < pos.count; v++) {
          expect(pos.getX(v)).toBeGreaterThanOrEqual(s.x0);
          expect(pos.getX(v)).toBeLessThanOrEqual(s.x1);
          expect(pos.getZ(v)).toBeGreaterThanOrEqual(s.z0);
          expect(pos.getZ(v)).toBeLessThanOrEqual(s.z1);
        }
        expect(s.x0).toBeGreaterThanOrEqual(-HALF);
        expect(s.x1).toBeLessThanOrEqual(HALF);
      }
    }
  });
});
