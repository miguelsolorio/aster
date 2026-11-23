import { describe, expect, it } from 'vitest';
import { avenueBearings, planCity } from '../plan';
import { NearBuilder } from '../build';
import { packAvenues } from '../placement';
import { Relief } from '../relief';
import { isRound, shapeOf } from '../shape';
import type { CityKind, CityPlan, CitySite } from '../types';

function site(seed: number, kind: CityKind, radius: number): CitySite {
  const s: CitySite = { id: seed, seed, cx: 0, cz: 0, radius, groundY: 0, kind, rot: 0, phase1: seed % 7, phase2: seed % 5, falloff: 300, aveA: 0, aveB: 0 };
  [s.aveA, s.aveB] = packAvenues(avenueBearings(s));
  return s;
}

const KINDS: CityKind[] = ['hill', 'canyon', 'oasis', 'trade'];

function town(k: number): { plan: CityPlan; relief: Relief } {
  const plan = planCity(site(4321 + k * 613, KINDS[k % 4], 340 + ((k * 60) % 240)));
  const nb = new NearBuilder(plan);
  nb.build();
  const relief = new Relief(plan, nb.w.pos, nb.w.idx, nb.w.ni);
  while (!relief.step(1000));
  return { plan, relief };
}

const cell = (p: CityPlan, x: number, z: number) => Math.floor(z + p.gridHalf) * p.gridSize + Math.floor(x + p.gridHalf);
/** Highest relief within r of (x, z), sampled on the subcell grid. */
function highest(p: CityPlan, rel: Relief, x: number, z: number, r: number): number {
  let best = -Infinity;
  for (let dz = -r; dz <= r + 1e-9; dz += 0.25)
    for (let dx = -r; dx <= r + 1e-9; dx += 0.25) best = Math.max(best, rel.at(cell(p, x + dx, z + dz), x + dx, z + dz));
  return best;
}

describe('the drawn relief of a city', () => {
  const towns = [0, 1, 2, 3].map(town);

  it('is not used until it is done', () => {
    const plan = planCity(site(99, 'trade', 360));
    const nb = new NearBuilder(plan);
    nb.build();
    const rel = new Relief(plan, nb.w.pos, nb.w.idx, nb.w.ni);
    const b = plan.buildings.find((q) => q.solid && q.roof === 'dome' && !isRound(q));
    if (!b) throw new Error('no domed house in this town');
    expect(rel.at(cell(plan, b.x, b.z), b.x, b.z)).toBe(-Infinity);
    while (!rel.step(1000));
    expect(rel.at(cell(plan, b.x, b.z), b.x, b.z)).toBeGreaterThan(b.h);
  });

  it('stands a domed or vaulted roof up over its flat top', () => {
    let n = 0;
    for (const { plan, relief } of towns)
      for (const b of plan.buildings) {
        if (!b.solid || b.roof !== 'dome' || isRound(b)) continue;
        n++;
        expect(highest(plan, relief, b.x, b.z, 0.5)).toBeGreaterThan(b.h + 0.5);
      }
    expect(n).toBeGreaterThan(20);
  });

  it('raises a parapet round the edge of a parapet roof', () => {
    let n = 0;
    for (const { plan, relief } of towns)
      for (const b of plan.buildings) {
        // (town walls carry theirs on the outer side only)
        if (!b.solid || b.roof !== 'parapet' || shapeOf(b) !== 'box' || b.role === 'wall') continue;
        n++;
        // just inside the middle of each side of the lot
        for (const [x, z] of [[b.x, b.z - b.d / 2 + 0.3], [b.x, b.z + b.d / 2 - 0.3], [b.x - b.w / 2 + 0.3, b.z], [b.x + b.w / 2 - 0.3, b.z]])
          expect(highest(plan, relief, x, z, 0.25)).toBeGreaterThan(b.h + 0.3);
      }
    expect(n).toBeGreaterThan(5);
  });

  it('keeps only what rises over the roof of a square building', { timeout: 60_000 }, () => {
    for (const { plan, relief } of towns)
      for (const b of plan.buildings) {
        if (!b.solid || isRound(b)) continue;
        for (let z = b.z - b.d / 2 + 0.125; z < b.z + b.d / 2; z += 0.25)
          for (let x = b.x - b.w / 2 + 0.125; x < b.x + b.w / 2; x += 0.25) {
            const k = cell(plan, x, z);
            const v = relief.at(k, x, z);
            if (v > -Infinity) expect(v).toBeGreaterThan(plan.grid[k]);
          }
      }
  });

  it('leaves the corners of a round building open and its middle solid', () => {
    let n = 0;
    let open = 0;
    for (const { plan, relief } of towns)
      for (const b of plan.buildings) {
        if (!b.solid || (shapeOf(b) !== 'dome' && shapeOf(b) !== 'tower') || Math.min(b.w, b.d) < 4) continue;
        expect(relief.at(cell(plan, b.x, b.z), b.x, b.z)).toBeGreaterThan(1);
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const x = b.x + sx * (b.w / 2 - 0.1), z = b.z + sz * (b.d / 2 - 0.1);
          expect(relief.isWhole(cell(plan, x, z))).toBe(true);
          n++;
          if (relief.at(cell(plan, x, z), x, z) === -Infinity) open++;
        }
      }
    expect(n).toBeGreaterThan(12);
    // (a few corners have a neighbour's eaves or a wall drawn over them)
    expect(open / n).toBeGreaterThan(0.85);
  });
});
