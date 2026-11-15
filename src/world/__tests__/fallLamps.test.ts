import { describe, expect, it } from 'vitest';
import { Discoveries } from '../discoveries';
import { createWorld } from '../surface';

describe('fallLamps', () => {
  const world = createWorld(1);
  const d = new Discoveries(world, {});
  // the first mountain with a fall on it: lampSpot names its spring from the middle of the massif
  let at: { x: number; z: number } | null = null;
  let named: ReturnType<Discoveries['lampSpot']> = null;
  for (let gj = -3; gj <= 3 && !named; gj++) {
    for (let gi = -3; gi <= 3 && !named; gi++) {
      const m = world.massif(gi, gj);
      if (!m) continue;
      const s = d.lampSpot(m.x, m.z);
      if (s?.kind !== 'spring') continue;
      at = { x: s.x, z: s.z }; // stand at its pool
      named = s;
    }
  }

  it('finds a mountain with a fall to test against', () => {
    expect(named).not.toBeNull();
  });

  it('puts a lamp by the pool of every fall near, the named one among them', () => {
    const falls = d.fallLamps(at!.x, at!.z);
    expect(falls.length).toBeGreaterThan(0);
    expect(falls.some((f) => f.x === named!.x && f.z === named!.z)).toBe(true);
    expect(new Set(falls.map((f) => `${f.x},${f.z}`)).size).toBe(falls.length);
  });

  it('keeps to the radius, and is the same on another instance', () => {
    const falls = d.fallLamps(at!.x, at!.z);
    expect(new Discoveries(createWorld(1), {}).fallLamps(at!.x, at!.z)).toEqual(falls);
    expect(d.fallLamps(at!.x, at!.z, 1)).toEqual([]);
    const wide = d.fallLamps(at!.x, at!.z, 6000);
    for (const f of falls) expect(wide).toContainEqual(f);
  });
});
