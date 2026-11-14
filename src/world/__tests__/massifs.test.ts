import { describe, expect, it } from 'vitest';
import { MAX_TERRAIN_H, TERRAIN, createWorld } from '../surface';

describe('massif kinds', () => {
  const w = createWorld(20261111);
  const out = { h: 0, rock: 0, salt: 0 };
  const byKind: { x: number; z: number; r: number; h: number }[][] = [[], [], [], []];
  for (let gi = -8; gi <= 8; gi++) {
    for (let gj = -8; gj <= 8; gj++) {
      const m = w.massif(gi, gj);
      if (m) byKind[m.kind].push(m);
    }
  }

  it('uses all four kinds', () => {
    for (const k of byKind) expect(k.length).toBeGreaterThan(10);
  });

  it('keeps each kind inside its size range', () => {
    byKind.forEach((list, k) => {
      const kd = TERRAIN.massifKinds[k];
      for (const m of list) {
        expect(m.r).toBeGreaterThanOrEqual(kd.rMin - 1);
        expect(m.r).toBeLessThanOrEqual(kd.rMax + 1);
        expect(m.h).toBeGreaterThanOrEqual(kd.hMin - 1);
        expect(m.h).toBeLessThanOrEqual(kd.hMax + 1);
      }
    });
  });

  it('stays finite and under the shadow ceiling', () => {
    for (const list of byKind) {
      for (const m of list.slice(0, 6)) {
        for (let a = 0; a < 360; a += 20) {
          for (let r = 0; r <= m.r * 1.3; r += 100) {
            const h = w.sample(m.x + Math.cos(a) * r, m.z + Math.sin(a) * r, out).h;
            expect(Number.isFinite(h)).toBe(true);
            expect(h).toBeLessThan(MAX_TERRAIN_H);
          }
        }
      }
    }
  });

  it('caps a mesa below the snow line and lets the other kinds rise above it', () => {
    const peak = (k: number): number => {
      let top = 0;
      for (const m of byKind[k].slice(0, 12)) {
        for (let a = 0; a < 360; a += 30) for (let r = 0; r <= m.r * 0.6; r += 60) top = Math.max(top, w.sample(m.x + Math.cos(a) * r, m.z + Math.sin(a) * r, out).h);
      }
      return top;
    };
    expect(peak(2)).toBeLessThan(TERRAIN.snowLine + 100);
    expect(peak(1)).toBeGreaterThan(TERRAIN.snowLine);
    expect(peak(3)).toBeGreaterThan(TERRAIN.snowLine);
  });
});
