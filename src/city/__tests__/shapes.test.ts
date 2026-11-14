import { describe, expect, it } from 'vitest';
import { avenueBearings, planCity } from '../plan';
import { NearBuilder, buildCity } from '../build';
import { packAvenues } from '../placement';
import { MAT } from '../cityShaders';
import { shapeOf } from '../shape';
import type { CityKind, CityPlan, CitySite } from '../types';

function site(seed: number, kind: CityKind, radius: number): CitySite {
  const s: CitySite = { id: seed, seed, cx: 0, cz: 0, radius, groundY: 0, kind, rot: 0, phase1: seed % 7, phase2: seed % 5, falloff: 300, aveA: 0, aveB: 0 };
  [s.aveA, s.aveB] = packAvenues(avenueBearings(s));
  return s;
}

const KINDS: CityKind[] = ['hill', 'canyon', 'oasis', 'trade'];
const towns = (): CityPlan[] => Array.from({ length: 8 }, (_, k) => planCity(site(1234 + k * 977, KINDS[k % 4], 320 + ((k * 40) % 280))));

describe('town building shapes', () => {
  const plans = towns();

  it('the height grid blocks every solid lot at its roof height', () => {
    for (const p of plans) {
      for (const b of p.buildings) {
        if (!b.solid) continue;
        const i0 = b.x - b.w / 2 + p.gridHalf, j0 = b.z - b.d / 2 + p.gridHalf;
        for (let j = j0; j < j0 + b.d; j++) for (let i = i0; i < i0 + b.w; i++) expect(p.grid[j * p.gridSize + i]).toBeCloseTo(b.h, 4);
      }
    }
  });

  it('mixes the house shapes', () => {
    const n: Record<string, number> = {};
    let houses = 0, rounded = 0;
    for (const p of plans) {
      for (const b of p.buildings) {
        if (!b.solid || b.role !== 'house') continue;
        houses++;
        n[shapeOf(b)] = (n[shapeOf(b)] ?? 0) + 1;
        if (b.roof === 'dome') rounded++;
      }
    }
    expect(n.box ?? 0).toBe(0);
    for (const s of ['slump', 'dome', 'mound', 'tower']) expect(n[s] ?? 0).toBeGreaterThan(0);
    expect(rounded / houses).toBeGreaterThan(0.3);
    for (const p of plans) expect(p.buildings.some((b) => b.shape === 'tiered')).toBe(true);
  });

  it('draws shaped buildings inside their lots (a hand-breadth of slack)', () => {
    for (const p of plans) {
      const nb = new NearBuilder(p) as unknown as { w: { nv: number; pos: Float32Array; info: Uint8Array }; building(b: unknown, i: number): void };
      p.buildings.forEach((b, i) => {
        const v0 = nb.w.nv;
        nb.building(b, i);
        if (!b.solid || shapeOf(b) === 'box') return;
        let worst = 0;
        for (let v = v0; v < nb.w.nv; v++) {
          const m = nb.w.info[v * 4];
          if (m === MAT.wood || m === MAT.stone) continue; // beam ends and spouts reach over the lane by design
          const x = nb.w.pos[v * 3], z = nb.w.pos[v * 3 + 2];
          worst = Math.max(worst, Math.abs(x - b.x) - b.w / 2, Math.abs(z - b.z) - b.d / 2);
        }
        expect(worst).toBeLessThan(0.35);
      });
    }
  });

  it('stays inside the triangle budget of the box town', () => {
    // baseline (all boxes) for these eight towns: near 881710, far 28912 masonry triangles
    let near = 0;
    for (const p of plans) {
      const m = buildCity(p, {} as never);
      near += m.near.userData.triangles as number;
      m.dispose();
    }
    expect(near).toBeLessThan(881710 * 1.01);
  });
});
