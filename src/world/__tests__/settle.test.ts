import { describe, expect, it } from 'vitest';
import type { SurfaceSample } from '../../game/contract';
import { settle, type SettleWorld } from '../settle';
import { TERRAIN } from '../surface';

interface Spec {
  h?: (x: number, z: number) => number;
  rock?: (x: number, z: number) => number;
  salt?: (x: number, z: number) => number;
  river?: (x: number, z: number) => number;
}

function world(s: Spec): SettleWorld {
  const h = s.h ?? (() => 0);
  const w: SettleWorld = {
    height: (x, z) => h(x, z),
    sample: (x, z, out: SurfaceSample) => {
      out.h = h(x, z);
      out.rock = s.rock ? s.rock(x, z) : 0;
      out.salt = s.salt ? s.salt(x, z) : 0;
      return out;
    },
  };
  if (s.river) w.river = s.river;
  return w;
}

const rolls = (a: number, b: number, c: number) => (i: number) => [0, a, b, c][i] ?? 0.5;
const yes = () => true;
const no = () => false;
const dist = (r: { x: number; z: number }, x: number, z: number) => Math.hypot(r.x - x, r.z - z);

const bank = TERRAIN.waterY + TERRAIN.riverBank;
const riverWorld = world({
  river: (x) => Math.abs(x),
  h: (x) => bank + Math.max(0, Math.abs(x) - 46) * 0.3,
});

describe('settle', () => {
  const sand = world({});

  it('puts a stepped city, wind towers, a well camp or glass kilns on flat sand, by the rolls', () => {
    expect(settle(sand, 0, 0, rolls(0.3, 0.1, 0.9), yes).kind).toBe('stepped-city');
    expect(settle(sand, 0, 0, rolls(0.3, 0.3, 0.9), yes).kind).toBe('wind-towers');
    expect(settle(sand, 0, 0, rolls(0.3, 0.7, 0.2), yes).kind).toBe('well-camp');
    expect(settle(sand, 0, 0, rolls(0.3, 0.7, 0.8), yes).kind).toBe('glass-kilns');
  });

  it('demotes the big two to a hamlet when there is no room', () => {
    expect(settle(sand, 0, 0, rolls(0.3, 0.1, 0.2), no).kind).toBe('well-camp');
    expect(settle(sand, 0, 0, rolls(0.3, 0.3, 0.8), no).kind).toBe('glass-kilns');
  });

  it('works salt on a flat pan', () => {
    const r = settle(world({ salt: () => 0.8 }), 10, 20, rolls(0.25, 0.5, 0.5), yes);
    expect(r.kind).toBe('salt-works');
    expect(Math.hypot(r.dx, r.dz)).toBeCloseTo(1, 6);
  });

  it('bridges a river lying close by', () => {
    const r = settle(riverWorld, 60, 0, rolls(0.3, 0.5, 0.5), yes);
    expect(r.kind).toBe('bridge');
    expect(Math.abs(r.x)).toBeLessThan(1.5);
    expect(Math.abs(r.dx)).toBeCloseTo(1, 3);
  });

  it('puts a dyers town on the slope above a farther river, facing uphill', () => {
    const r = settle(riverWorld, 200, 0, rolls(0.3, 0.5, 0.5), yes);
    expect(r.kind).toBe('dyers-town');
    expect(Math.abs(r.x)).toBeGreaterThanOrEqual(90);
    expect(Math.abs(r.x)).toBeLessThanOrEqual(330);
    expect(Math.sign(r.dx)).toBe(Math.sign(r.x));
    expect(Math.abs(r.dx)).toBeCloseTo(1, 3);
  });

  it('builds a ledge against a rocky slope, facing uphill', () => {
    const r = settle(world({ h: (x) => 0.6 * x, rock: () => 1 }), 0, 0, rolls(0.3, 0.5, 0.5), yes);
    expect(r.kind).toBe('ledge');
    expect(r.dx).toBeCloseTo(1, 3);
    expect(r.dz).toBeCloseTo(0, 3);
  });

  it('puts a star-house on a lone smooth hill', () => {
    const bump = world({ h: (x, z) => 30 * Math.exp(-((x * x + z * z) / (35 * 35))) });
    const r = settle(bump, 40, -40, rolls(0.3, 0.5, 0.5), yes);
    expect(r.kind).toBe('star-house');
    expect(dist(r, 0, 0)).toBeLessThan(45);
  });

  it('stays within 160 m of the start and gives the same answer twice', () => {
    const worlds = [sand, riverWorld, world({ salt: () => 0.8 }), world({ h: (x) => 0.6 * x, rock: () => 1 })];
    for (const w of worlds) {
      for (const [x, z] of [[0, 0], [60, 0], [200, 0], [-140, 90]]) {
        const a = settle(w, x, z, rolls(0.3, 0.1, 0.2), yes);
        const b = settle(w, x, z, rolls(0.3, 0.1, 0.2), yes);
        expect(a).toEqual(b);
        expect(dist(a, x, z)).toBeLessThanOrEqual(160);
        expect(a.kind).not.toBe('caravanserai');
      }
    }
  });
});
