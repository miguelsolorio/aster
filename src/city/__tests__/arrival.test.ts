import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { avenueBearings, planCity } from '../plan';
import { buildCity, cityData, cityDataBuffers } from '../build';
import { contactBase, contactShade, roofBytes, shadeCrowns } from '../contactShade';
import { packAvenues } from '../placement';
import type { CityKind, CitySite } from '../types';

// A city's buildings are worked out in the plan worker and handed to the page (see planWorker.ts):
// what the page makes of the handed-over arrays must be what it would have built itself.

function site(seed: number, kind: CityKind, radius: number): CitySite {
  const s: CitySite = { id: seed, seed, cx: 0, cz: 0, radius, groundY: 0, kind, rot: 0, phase1: seed % 7, phase2: seed % 5, falloff: 300, aveA: 0, aveB: 0 };
  [s.aveA, s.aveB] = packAvenues(avenueBearings(s));
  return s;
}

function meshesOf(g: THREE.Group): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

function sameGeometry(a: THREE.BufferGeometry, b: THREE.BufferGeometry): void {
  expect(Object.keys(b.attributes)).toEqual(Object.keys(a.attributes));
  for (const k of Object.keys(a.attributes)) {
    const x = a.attributes[k] as THREE.BufferAttribute;
    const y = b.attributes[k] as THREE.BufferAttribute;
    expect(y.itemSize).toBe(x.itemSize);
    expect(y.normalized).toBe(x.normalized);
    expect(y.array.constructor).toBe(x.array.constructor);
    sameBytes(x.array as ArrayBufferView, y.array as ArrayBufferView);
  }
  sameBytes(a.index?.array, b.index?.array);
  expect(b.boundingBox).toEqual(a.boundingBox);
  expect(b.boundingSphere).toEqual(a.boundingSphere);
}

const ms = (f: () => void, n = 1): number => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) f();
  return (performance.now() - t0) / n;
};

/** Byte-for-byte equality of two typed arrays (and of their kinds). */
function sameBytes(a: ArrayBufferView | undefined, b: ArrayBufferView | undefined): void {
  expect(b?.constructor).toBe(a?.constructor);
  if (!a || !b) return;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let first = x.length === y.length ? -1 : 0;
  for (let i = 0; i < x.length && first < 0; i++) if (x[i] !== y[i]) first = i;
  expect(first).toBe(-1);
}

describe('a city arriving', () => {
  const sites = [site(4021, 'trade', 520), site(777, 'oasis', 430), site(9157, 'hill', 380)];

  it('builds the same meshes from the worker geometry as on the page', () => {
    for (const s of sites) {
      const plan = planCity(s);
      const here = buildCity(plan, {} as never);
      // what comes back from the worker: a structured clone, its buffers moved over
      const data = cityData(plan);
      const moved = structuredClone(data, { transfer: cityDataBuffers(data) });
      const there = buildCity(plan, {} as never, moved);
      for (const part of ['near', 'far'] as const) {
        const a = meshesOf(here[part]);
        const b = meshesOf(there[part]);
        expect(b.map((m) => m.name)).toEqual(a.map((m) => m.name));
        for (let i = 0; i < a.length; i++) {
          sameGeometry(a[i].geometry, b[i].geometry);
          expect(b[i].renderOrder).toBe(a[i].renderOrder);
          expect((b[i].material as THREE.ShaderMaterial).defines).toEqual((a[i].material as THREE.ShaderMaterial).defines);
        }
      }
      expect(there.doors).toEqual(here.doors);
      expect(there.near.userData.triangles).toBe(here.near.userData.triangles);
      here.dispose();
      there.dispose();
    }
  }, 120000);

  it('shades the ground the same with the crowns added a few at a time', () => {
    const plan = planCity(sites[0]);
    const { grid, gridSize, gridHalf } = plan;
    // crowns scattered over the city, overlapping one another and the edges of the grid
    const crowns: number[] = [];
    let r = 12345;
    const rnd = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 400; i++) crowns.push((rnd() - 0.5) * 2.1 * gridHalf, (rnd() - 0.5) * 2.1 * gridHalf, 1.5 + rnd() * 5);
    const whole = roofBytes(grid, contactShade(grid, gridSize, gridHalf, crowns));
    const shade = contactBase(grid, gridSize);
    const map = roofBytes(grid, shade);
    const some: number[] = [];
    for (const n of [30, 0, 270, 600, 1200]) {
      const from = some.length;
      for (let i = from; i < Math.min(crowns.length, from + n); i++) some.push(crowns[i]);
      shadeCrowns(shade, gridSize, gridHalf, some, from, map);
    }
    expect(some.length).toBe(crowns.length);
    sameBytes(whole, map);
  }, 60000);

  it('leaves the page little to do when the worker has done its part (timings)', () => {
    const plan = planCity(sites[0]);
    const { grid, gridSize, gridHalf } = plan;
    const data = cityData(plan);
    const crowns: number[] = [];
    for (let i = 0; i < 300; i++) crowns.push(((i * 37) % 200) - 100, ((i * 53) % 200) - 100, 3);
    const a = new Float32Array(gridSize * gridSize);
    const m = new Uint8Array(a.length * 2);
    const t = {
      // before: all of this ran on the page, buildCity at 9 km and the map in the frame the city is shown
      buildCity: ms(() => buildCity(plan, {} as never).dispose(), 3),
      roofMap: ms(() => roofBytes(grid, contactShade(grid, gridSize, gridHalf, crowns)), 3),
      // after: the worker does cityData and the buildings' shade; the page wraps arrays and adds crowns
      worker_cityData: ms(() => cityData(plan), 3),
      worker_shade: ms(() => roofBytes(grid, contactBase(grid, gridSize)), 3),
      page_buildCity: ms(() => buildCity(plan, {} as never, data).dispose(), 3),
      page_crowns: ms(() => shadeCrowns(a, gridSize, gridHalf, crowns, 0, m), 3),
    };
    console.log(`city arrival, ms (grid ${gridSize}^2, ${data.triangles} triangles):`, Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v * 10) / 10])));
    expect(t.page_buildCity).toBeLessThan(t.buildCity);
  }, 120000);
});
