import { describe, expect, it } from 'vitest';
import { VB, meshGrid } from '../mesher';
import { SpanGrid } from '../spans';
import type { DeepSpec } from '../types';

const SPEC: DeepSpec = { x: 0, z: 0, y: 0, dx: 1, dz: 0, kind: 4, seed: 7, u1: 300, v0: -150, v1: 150, lid: -4, relic: false, vein: false, carvings: false, tier: 0 };

/**
 * Square metres of upright face that lie on top of another face in the same plane. Two faces in
 * one plane flicker against each other as the eye moves, so the rock should have none.
 */
function doubled(vb: VB): number {
  const G = 0.02;
  const seen = new Map<string, number>();
  let twice = 0;
  for (let t = 0; t < vb.ni; t += 3) {
    const p = [0, 1, 2].map((c) => [vb.pos[vb.idx[t + c] * 3], vb.pos[vb.idx[t + c] * 3 + 1], vb.pos[vb.idx[t + c] * 3 + 2]]);
    for (const ax of [0, 2]) {
      if (Math.abs(p[0][ax] - p[1][ax]) > 1e-4 || Math.abs(p[0][ax] - p[2][ax]) > 1e-4) continue;
      const q = p.map((v) => [v[2 - ax], v[1]]);
      const area2 = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
      if (Math.abs(area2) < 1e-6) continue;
      const edge = (a: number, b: number, x: number, y: number) => ((q[b][0] - q[a][0]) * (y - q[a][1]) - (q[b][1] - q[a][1]) * (x - q[a][0])) * Math.sign(area2);
      const lo = [0, 1].map((c) => Math.floor(Math.min(q[0][c], q[1][c], q[2][c]) / G));
      const hi = [0, 1].map((c) => Math.ceil(Math.max(q[0][c], q[1][c], q[2][c]) / G));
      for (let a = lo[0]; a < hi[0]; a++) {
        for (let b = lo[1]; b < hi[1]; b++) {
          const x = (a + 0.5) * G;
          const y = (b + 0.5) * G;
          // (strictly inside: a point on the edge two triangles share belongs to neither)
          if (edge(0, 1, x, y) <= 1e-9 || edge(1, 2, x, y) <= 1e-9 || edge(2, 0, x, y) <= 1e-9) continue;
          const key = `${ax}:${Math.round(p[0][ax] * 1000)}:${a}:${b}`;
          const c = (seen.get(key) ?? 0) + 1;
          seen.set(key, c);
          if (c === 2) twice++;
        }
      }
    }
  }
  return twice * G * G;
}

function mesh(carve: (g: SpanGrid) => void): VB {
  const g = new SpanGrid(SPEC, 1, -40);
  carve(g);
  const vb = new VB();
  meshGrid(g, vb, { wallStep: 3, seed: 7, lit: () => false, paints: [[1, 1, 1, 0]] });
  return vb;
}

describe('stairs in the rock', () => {
  it('draws each riser once along a flight', () => {
    for (const [a, b] of [[20, 40], [40, 20]]) {
      const vb = mesh((g) => {
        g.carveBox(a - 4, -2, a + 4, 2, -10, -7);
        g.carveRun([a, -10, 0], [b, -20, 0], 3, 2.7, { steps: true });
        g.carveBox(b - 4, -2, b + 4, 2, -20, -17);
      });
      expect(vb.ni).toBeGreaterThan(0);
      expect(doubled(vb)).toBeLessThan(0.01);
    }
  });

  it('and across, and where a landing sits a little off the stair', () => {
    const vb = mesh((g) => {
      g.carveBox(48, 16, 52, 24, -10.1, -7);
      g.carveRun([50, -10, 20], [50, -18, 44], 3, 2.7, { steps: true });
      g.carveBox(48, 40, 52, 48, -17.88, -14);
    });
    expect(doubled(vb)).toBeLessThan(0.01);
  });
});
