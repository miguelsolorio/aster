import { describe, expect, it } from 'vitest';
import { createWorld } from '../surface';
import { Discoveries, type SiteRef } from '../discoveries';
import { FIND_KINDS, isFindKind } from '../../game/finds';

const make = (seed = 1) => new Discoveries(createWorld(seed), {});

describe('sitesNear', () => {
  const d = make();
  const all = d.sitesNear(0, 0, 4500, []).map((s) => ({ ...s }));

  it('finds sites, all of them kinds the finds know', () => {
    expect(all.length).toBeGreaterThan(5);
    for (const s of all) expect(isFindKind(s.kind)).toBe(true);
  });

  it('is deterministic, across instances too', () => {
    expect(make().sitesNear(0, 0, 4500, [])).toEqual(all);
    expect(d.sitesNear(0, 0, 4500, [])).toEqual(all);
  });

  it('gives unique integer keys', () => {
    const keys = all.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(Number.isInteger(k)).toBe(true);
  });

  it('respects r and clears and returns out', () => {
    const out: SiteRef[] = [{ key: 1, kind: 'x', x: 0, y: 0, z: 0, reached: false }];
    const near = d.sitesNear(0, 0, 1500, out);
    expect(near).toBe(out);
    for (const s of near) expect(Math.hypot(s.x, s.z)).toBeLessThanOrEqual(1500);
    expect(near.length).toBeLessThan(all.length);
    const keys = new Set(all.map((s) => s.key));
    for (const s of near) expect(keys.has(s.key)).toBe(true);
  });

  it('includes sites that are not built (nothing is, headless)', () => {
    expect(all.every((s) => !s.reached)).toBe(true);
    expect(all.length).toBeGreaterThan(0);
  });
});

describe('nearestUnfound', () => {
  const d = make();
  const sites = d.sitesNear(0, 0, 12000, []);

  it('returns the nearest site whose kind is not found', () => {
    const found = new Set<string>(['temple', 'ruins']);
    const got = d.nearestUnfound(0, 0, found, 12000)!;
    expect(got).not.toBeNull();
    expect(found.has(got.kind)).toBe(false);
    const want = sites.filter((s) => !found.has(s.kind) && isFindKind(s.kind)).reduce((a, b) => (Math.hypot(a.x, a.z) <= Math.hypot(b.x, b.z) ? a : b));
    expect(Math.hypot(got.x, got.z)).toBeCloseTo(Math.hypot(want.x, want.z), 6);
  });

  it('with nothing found is the nearest site of any kind', () => {
    const got = d.nearestUnfound(0, 0, new Set(), 12000)!;
    const min = Math.min(...sites.map((s) => Math.hypot(s.x, s.z)));
    expect(Math.hypot(got.x, got.z)).toBeCloseTo(min, 6);
  });

  it('is null when every kind is found, or nothing lies in range', () => {
    expect(d.nearestUnfound(0, 0, new Set<string>(FIND_KINDS), 12000)).toBeNull();
    expect(d.nearestUnfound(0, 0, new Set(), 1)).toBeNull();
  });
});

describe('ropeSpot', () => {
  const d = make();
  const bones = d.sitesNear(0, 0, 12000, []).filter((s) => s.kind === 'bones');

  it('lies about 3 m from the nearest bones, the same every time', () => {
    expect(bones.length).toBeGreaterThan(0);
    const b = bones[0];
    const a = d.ropeSpot(b.x, b.z, 500)!;
    expect(a).not.toBeNull();
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(2.99);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(9);
    expect(make().ropeSpot(b.x, b.z, 500)).toEqual(a);
    expect(d.ropeSpot(b.x, b.z, 500)).toEqual(a);
  });

  it('is null with no bones in range', () => {
    expect(d.ropeSpot(0, 0, 1)).toBeNull();
  });

  it('can be laid and found without a renderer', () => {
    const b = bones[0];
    const a = d.ropeSpot(b.x, b.z, 500)!;
    expect(d.ropeNear(a.x, 0, a.z, 5)).toBe(false);
    d.setRope(a);
    expect(d.ropeNear(a.x, d['world'].height(a.x, a.z), a.z, 2)).toBe(true);
    d.setRope(null);
    expect(d.ropeNear(a.x, 0, a.z, 5)).toBe(false);
  });
});
