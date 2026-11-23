import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { avenueBearings, planCity } from '../plan';
import { packAvenues } from '../placement';
import { Glows, Writer } from '../build';
import { GLOW, createCutUniforms } from '../cityShaders';
import { INTERIOR_IN, Interiors, writeRoom, writeVeil } from '../interiors';
import { frameBudget } from '../../world/budget';
import type { CityKind, CityPlan, CitySite } from '../types';

function plan(kind: CityKind, seed: number): CityPlan {
  const s: CitySite = {
    id: seed,
    seed,
    cx: 0,
    cz: 0,
    radius: 360,
    groundY: 0,
    kind,
    rot: 0,
    phase1: 0.3,
    phase2: 0.7,
    falloff: 120,
    aveA: 0,
    aveB: 0,
  };
  [s.aveA, s.aveB] = packAvenues(avenueBearings(s));
  return planCity(s);
}

/** What Interiors made before it kept rooms apart: every wanted room into one writer, in order. */
function reference(p: CityPlan, x: number, z: number, had: Set<number> = new Set()) {
  const want: number[] = [];
  p.rooms.forEach((r, k) => {
    const d = Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));
    // (a room once in keeps its inside until it is a little further off)
    if (d < INTERIOR_IN || (had.has(k) && d < INTERIOR_IN + 25)) want.push(k);
  });
  had.clear();
  for (const k of want) had.add(k);
  const w = new Writer(64, 128);
  const glows = new Glows();
  for (const k of want) {
    writeRoom(w, p, p.rooms[k]);
    for (const c of p.rooms[k].candles) glows.add(c.x, c.y, c.z, 0.45, GLOW.lamp, c.seed, 1.0);
  }
  const v = new Writer(16, 32);
  for (let k = 0; k < p.rooms.length; k++) if (!want.includes(k)) writeVeil(v, p.rooms[k]);
  return { inner: w.geometry(), veil: v.geometry(), glow: glows.geometry() };
}

function same(a: THREE.BufferGeometry | null | undefined, b: THREE.BufferGeometry | null | undefined): void {
  expect(!!a).toBe(!!b);
  if (!a || !b) return;
  expect(Object.keys(a.attributes).sort()).toEqual(Object.keys(b.attributes).sort());
  for (const n of Object.keys(a.attributes)) {
    const x = a.attributes[n] as THREE.BufferAttribute;
    const y = b.attributes[n] as THREE.BufferAttribute;
    expect(x.normalized).toBe(y.normalized);
    expect(Array.from(x.array as ArrayLike<number>)).toEqual(Array.from(y.array as ArrayLike<number>));
  }
  expect(Array.from(a.index?.array ?? [])).toEqual(Array.from(b.index?.array ?? []));
  expect(a.boundingSphere?.center.toArray()).toEqual(b.boundingSphere?.center.toArray());
  expect(a.boundingSphere?.radius).toBe(b.boundingSphere?.radius);
}

const mesh = (it: Interiors, name: string) =>
  (it.group.children.find((o) => o.name === name) as THREE.Mesh | undefined)?.geometry as THREE.BufferGeometry | undefined;

describe('Interiors', () => {
  const p = plan('trade', 7);
  const walk: [number, number][] = [
    [0, 0],
    [40, 10],
    [90, 30],
    [150, 60],
    [20, -80],
  ];

  it('makes, along a walk, exactly what writing every room at once made', () => {
    const it = new Interiors(p, {}, createCutUniforms());
    const had = new Set<number>();
    for (const [x, z] of walk) {
      it.update(x, z);
      const ref = reference(p, x, z, had);
      same(mesh(it, 'city-interiors-rooms'), ref.inner);
      same(mesh(it, 'city-interiors-veils'), ref.veil);
      same(mesh(it, 'city-interiors-candles'), ref.glow);
    }
    it.dispose();
  });

  it('on a frame budget, writes over several frames and ends up the same', () => {
    const it = new Interiors(p, {}, createCutUniforms());
    let frames = 0;
    let worst = 0;
    try {
      // a budget too small for more than one step a frame
      for (; frames < 2000; frames++) {
        frameBudget.begin(1e-6);
        const t = performance.now();
        it.update(0, 0);
        worst = Math.max(worst, performance.now() - t);
        if (mesh(it, 'city-interiors-rooms')) break;
      }
    } finally {
      frameBudget.begin(Infinity);
    }
    expect(frames).toBeGreaterThan(3);
    const ref = reference(p, 0, 0);
    same(mesh(it, 'city-interiors-rooms'), ref.inner);
    same(mesh(it, 'city-interiors-veils'), ref.veil);
    console.log(`interiors: ${frames} frames, worst frame step ${worst.toFixed(2)} ms`);
    it.dispose();
  });
});
