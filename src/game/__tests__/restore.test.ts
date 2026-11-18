import { describe, expect, it } from 'vitest';
import { REVIVABLE, WANTS, lastStage, stageOf } from '../restore';
import { WELL_CLEAR, hamletFolk, towerFolk } from '../../world/villagers';

describe('a place brought back', () => {
  it('is at its first stage the moment it is restored', () => {
    for (const k of REVIVABLE) expect(stageOf(k, 4, 4)).toBe(1);
  });

  it('moves on as the days pass and stops at its last stage', () => {
    expect(stageOf('hamlet', 2, 2.99)).toBe(1);
    expect(stageOf('hamlet', 2, 3)).toBe(2);
    expect(stageOf('hamlet', 2, 4)).toBe(3);
    expect(stageOf('watchtower', 0, 0.99)).toBe(1);
    expect(stageOf('watchtower', 0, 1)).toBe(2);
    expect(stageOf('spring', 0, 2.9)).toBe(2);
    expect(stageOf('spring', 0, 3)).toBe(3);
    for (const k of REVIVABLE) expect(stageOf(k, 0, 1000)).toBe(lastStage(k));
  });

  it('wants a different thing at each kind of place', () => {
    expect(new Set(REVIVABLE.map((k) => WANTS[k])).size).toBe(REVIVABLE.length);
  });
});

describe('the people who come', () => {
  const houses = [0, 1, 2, 3, 4].map((i) => ({ a: (i / 5) * Math.PI * 2, d: 18, w: 6, depth: 5 }));

  it('puts three to five in a hamlet, one of them a host, none in the well', () => {
    for (const n of [4, 5]) {
      const folk = hamletFolk({ yaw: 0.7, houses: houses.slice(0, n), torch: [3.6, 0.6] });
      expect(folk.length).toBeGreaterThanOrEqual(3);
      expect(folk.length).toBeLessThanOrEqual(5);
      expect(folk.filter((f) => f.role === 'host')).toHaveLength(1);
      for (const f of folk) expect(Math.hypot(f.u, f.v)).toBeGreaterThanOrEqual(WELL_CLEAR);
    }
  });

  it('puts one keeper at a tower', () => {
    const folk = towerFolk({ yaw: 0, ha: 1.2, hd: 7.6, w: 5, depth: 4 });
    expect(folk).toHaveLength(1);
    expect(folk[0].role).toBe('watcher');
  });
});
