import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { FrameState } from '../../game/contract';
import { Weather } from '../weather';
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

describe('setWrecks', () => {
  const frame = (x: number, z: number): FrameState => ({
    dt: 0.05,
    time: 0,
    day: 0.4,
    night: 0,
    sunDir: new THREE.Vector3(0, 1, 0),
    lightDir: new THREE.Vector3(0, 1, 0),
    wind: new THREE.Vector2(1, 0),
    gust: 0,
    clock: 0,
    storm: 0,
    stormAhead: 0,
    rain: 0,
    wet: 0,
    stormDir: new THREE.Vector2(1, 0),
    weather: new Weather(1),
    camera: new THREE.PerspectiveCamera(),
    player: { pos: new THREE.Vector3(x, 0, z), vel: new THREE.Vector3(), speed: 0, grounded: true, sliding: false, running: false, onRock: 0 },
  });
  const at = { x: 12345.5, z: -6789.25, rot: 1.2 };
  const wrecksNear = (d: Discoveries) => d.sitesNear(at.x, at.z, 50, []).filter((s) => s.kind === 'wreck');
  const built = (d: Discoveries) => (d['sites'] as { kind: string; group: THREE.Group }[]).filter((s) => s.kind === 'wreck');

  it('is reported by sitesNear, under a key no cell has, and claims its ground', () => {
    const d = make();
    expect(wrecksNear(d)).toEqual([]);
    d.setWrecks([at]);
    const w = wrecksNear(d);
    expect(w.length).toBe(1);
    expect(w[0]).toMatchObject({ x: at.x, z: at.z, reached: false });
    expect(Number.isInteger(w[0].key)).toBe(true);
    expect(w[0].key).toBeLessThan(-5e12);
    expect(isFindKind(w[0].kind)).toBe(true);
    expect(d.claimed(at.x + 20, at.z, 1)).toBe(true);
    // the same wreck has the same key in another instance
    const e = make();
    e.setWrecks([at]);
    expect(wrecksNear(e)[0].key).toBe(w[0].key);
  });

  it('is built near the wanderer, fires onReach as a wreck, and goes when taken out of the list', () => {
    const d = make();
    const got: { kind: string; key: number; x: number; z: number }[] = [];
    d.onReach = (kind, key, x, z) => got.push({ kind, key, x, z });
    d.setWrecks([at]);
    d.update(frame(at.x + 5, at.z));
    expect(built(d).length).toBe(1);
    expect(got.filter((g) => g.kind === 'wreck')).toEqual([{ kind: 'wreck', key: wrecksNear(d)[0].key, x: at.x, z: at.z }]);
    expect(wrecksNear(d)[0].reached).toBe(true);
    // the same list again leaves the built wreck alone
    const g = built(d)[0].group;
    d.setWrecks([{ ...at }]);
    expect(built(d)[0].group).toBe(g);
    d.setWrecks([]);
    expect(built(d).length).toBe(0);
    expect(wrecksNear(d)).toEqual([]);
  });
});
