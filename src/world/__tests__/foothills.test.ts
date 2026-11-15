import { describe, expect, it } from 'vitest';
import { createWorld } from '../surface';
import { FOOT_VILLAGES, footVillages } from '../foothills';
import { frostRegion } from '../frost';
import { Discoveries } from '../discoveries';
import { FIND_KINDS, findName } from '../../game/finds';

const world = createWorld(1);
const massifs: { gi: number; gj: number; x: number; z: number; r: number; h: number; kind: number }[] = [];
for (let gj = -2; gj <= 2; gj++) {
  for (let gi = -2; gi <= 2; gi++) {
    const m = world.massif(gi, gj);
    if (m) massifs.push({ gi, gj, ...m });
  }
}

describe('footVillages', () => {
  const all = massifs.map((m) => ({ m, v: footVillages(world, m, 0.37, () => true) }));

  it('finds ground for a village at the foot of most massifs, never more than it tries', () => {
    expect(massifs.length).toBeGreaterThan(3);
    expect(all.filter((a) => a.v.length > 0).length).toBeGreaterThan(massifs.length / 2);
    for (const a of all) expect(a.v.length).toBeLessThanOrEqual(FOOT_VILLAGES);
  });

  it('keeps them on the foot: within 1.25 radii, and off the rivers', () => {
    for (const { m, v } of all) {
      for (const p of v) {
        const d = Math.hypot(p.x - m.x, p.z - m.z) / m.r;
        expect(d).toBeGreaterThan(0.8);
        expect(d).toBeLessThan(1.25);
        expect(world.river(p.x, p.z)).toBeGreaterThanOrEqual(110);
        expect(Math.hypot(p.ux, p.uz)).toBeCloseTo(1, 6);
        // the street runs across the slope
        expect(Math.cos(p.yaw) * p.ux + Math.sin(p.yaw) * p.uz).toBeCloseTo(0, 6);
      }
    }
  });

  it('is the same every time, and leaves out what is not free', () => {
    for (const { m, v } of all) {
      expect(footVillages(world, m, 0.37, () => true)).toEqual(v);
      expect(footVillages(world, m, 0.37, () => false)).toEqual([]);
    }
  });
});

describe('mountain villages among the discoveries', () => {
  const d = new Discoveries(world, {});
  const sites = d.sitesNear(0, 0, 12000, []).filter((s) => s.kind === 'mountain-village');

  it('lists them, with keys of their own', () => {
    expect(sites.length).toBeGreaterThan(2);
    const keys = sites.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(Number.isSafeInteger(k)).toBe(true);
    // a second cold scan of every cell within 12 km: a few seconds on a slow machine, hence the timeout
    expect(new Discoveries(world, {}).sitesNear(0, 0, 12000, []).filter((s) => s.kind === 'mountain-village')).toEqual(sites);
  }, 30000);

  it('has none on the frostland mountain, which has its snow villages', () => {
    const fr = frostRegion(world)!;
    expect(fr).not.toBeNull();
    for (const s of sites) expect(Math.hypot(s.x - fr.cx, s.z - fr.cz)).toBeGreaterThan(fr.r * 1.3);
  });

  it('keeps the scattered rocks and cacti off them', () => {
    for (const s of sites) expect(d.claimed(s.x + 20, s.z - 20, 5)).toBe(true);
  });

  it('can be found: the nearest unfound one is offered once everything else is', () => {
    const found = new Set<string>(FIND_KINDS.filter((k) => k !== 'mountain-village'));
    const got = d.nearestUnfound(0, 0, found, 12000)!;
    expect(got.kind).toBe('mountain-village');
    const min = Math.min(...sites.map((s) => Math.hypot(s.x, s.z)));
    expect(Math.hypot(got.x, got.z)).toBeCloseTo(min, 6);
  });
});

describe('the new finds', () => {
  it('are named', () => {
    expect(findName('mountain-village')).toBe('Mountain village');
    expect(findName('watchtower')).toBe('Watchtower');
  });

  it('watchtowers stand in some of the cells that were empty, hamlets where they were', () => {
    const d = new Discoveries(world, {});
    const all = d.surfaceSitesNear(0, 0, 9000, []);
    const towers = all.filter((s) => s.kind === 'watchtower').length;
    const hamlets = all.filter((s) => s.kind === 'hamlet').length;
    expect(towers).toBeGreaterThan(5);
    expect(hamlets).toBeGreaterThan(towers);
  });
});
