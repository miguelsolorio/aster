import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { FrameBudget, Task } from '../../world/budget';
import { createWorld, type DesertWorld } from '../../world/surface';
import { planCity } from '../plan';
import { createExtraCtx, type Extra, type ExtraCtx } from '../extras';
import { EXTRAS, EXTRA_JOBS } from '../extrasList';
import { CityData } from '../people';
import type { CitySite } from '../types';

// The extras of a city (and its people's streets) built as jobs, a step a frame, come out exactly as
// built at once: every attribute, index and bound of every mesh, what the meshes carry, the solids
// and the sounds, and what each claims of the ground (which the later extras see).

/** Everything an extra holds that the game reads, as plain data (attribute arrays hashed). */
function dump(e: Extra): unknown {
  const meshes: unknown[] = [];
  for (const root of [e.near, e.far]) {
    if (!root) continue;
    root.traverse((o) => {
      const parts: unknown[] = [o.type, o.name, o.visible, o.position.toArray(), o.rotation.toArray(), o.renderOrder];
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (g) {
        for (const n of Object.keys(g.attributes).sort()) {
          const a = g.attributes[n] as THREE.BufferAttribute;
          parts.push(n, a.itemSize, a.normalized, a.array.constructor.name, a.array.length, hash(a.array));
        }
        if (g.index) parts.push('index', g.index.array.length, hash(g.index.array));
        parts.push(g.boundingSphere?.center.toArray(), g.boundingSphere?.radius, g.boundingBox?.min.toArray(), g.boundingBox?.max.toArray());
        parts.push(g.drawRange.start, g.drawRange.count, (g as THREE.InstancedBufferGeometry).instanceCount);
      }
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) parts.push(m.type, m.side, m.transparent);
      meshes.push(parts);
    });
  }
  // (how long the build took is not part of what it built)
  const { buildMs: _ms, ...userData } = e.near.userData;
  return { meshes, userData, solids: e.solids, emitters: e.emitters, update: typeof e.update };
}

function hash(a: ArrayLike<number>): number {
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + Math.round(a[i] * 65536)) | 0;
  return h;
}

/** Where later extras may still go: ctx.free over a grid across the city and its outskirts. */
function claims(ctx: ExtraCtx): number {
  const R = ctx.site.radius + 400;
  let h = 0;
  for (let z = -R; z <= R; z += 7) for (let x = -R; x <= R; x += 7) h = (Math.imul(h, 31) + (ctx.free(x, z, 1.5) ? 1 : 0)) | 0;
  return h;
}

function ctxOf(world: DesertWorld, s: CitySite): ExtraCtx {
  const w = world.cities.ways(s);
  return createExtraCtx(planCity(s), {}, 1, (x, z) => world.height(x, z), [...new Set([w.t1, w.t2, w.t3, w.t4])], []);
}

describe('the extras of a city as jobs', () => {
  const world = createWorld(1);
  // an oasis with an aqueduct, a trade town, a canyon and a hill town
  const sites = [world.cities.cell(0, 0), world.cities.cell(1, 0), world.cities.cell(0, 1), world.cities.cell(1, 1)];

  it('cover every kind of city', () => {
    expect(new Set(sites.map((s) => s.kind)).size).toBe(4);
    expect(sites.some((s) => s.radius > 450)).toBe(true);
  });

  it('built a step a frame on a tiny budget, two cities at once, come out as built at once', () => {
    const want = sites.map((s) => {
      const ctx = ctxOf(world, s);
      const out = EXTRAS.map((b) => dump(b(ctx)));
      return { out, claims: claims(ctx) };
    });
    // a budget that lets one step through a frame (each look at the clock takes a millisecond)
    let t = 0;
    const budget = new FrameBudget(() => t++);
    // the cities two at a time, their jobs stepped in turn, so each kind is under way in both at once
    for (let p = 0; p < sites.length; p += 2) {
      const pair = [p, p + 1].map((i) => ({ i, ctx: ctxOf(world, sites[i]), got: [] as unknown[], steps: 0 }));
      for (let k = 0; k < EXTRA_JOBS.length; k++) {
        const tasks = pair.map((c) => new Task(EXTRA_JOBS[k](c.ctx)));
        for (let frames = 0; tasks.some((x) => !x.done); frames++) {
          expect(frames).toBeLessThan(100000);
          for (let q = 0; q < tasks.length; q++) {
            budget.begin(1);
            if (!tasks[q].done) pair[q].steps++;
            tasks[q].run(budget);
          }
        }
        for (let q = 0; q < tasks.length; q++) pair[q].got.push(dump(tasks[q].finish()));
      }
      for (const c of pair) {
        expect(c.steps).toBeGreaterThan(200);
        for (let k = 0; k < EXTRAS.length; k++) expect(c.got[k], `${sites[c.i].kind} ${EXTRAS[k].name}`).toEqual(want[c.i].out[k]);
        expect(claims(c.ctx)).toBe(want[c.i].claims);
      }
    }
  });

  it('take no long step: the longest is a small part of a frame', () => {
    // (warm the code up first: the first build of each compiles it)
    for (const b of EXTRAS) b(ctxOf(world, sites[0]));
    let worst = 0;
    let where = '';
    for (const s of sites) {
      const ctx = ctxOf(world, s);
      for (let k = 0; k < EXTRA_JOBS.length; k++) {
        const job = EXTRA_JOBS[k](ctx);
        for (;;) {
          const t0 = performance.now();
          const r = job.next();
          const dt = performance.now() - t0;
          if (dt > worst) {
            worst = dt;
            where = `${s.kind} ${EXTRAS[k].name}`;
          }
          if (r.done) break;
        }
      }
    }
    console.log(`extras: longest step ${worst.toFixed(2)} ms (${where})`);
    // generous: a slow machine, a collection in the middle of a step
    expect(worst).toBeLessThan(8);
  });

  it("the people's streets, worked out a step at a time, are those worked out at once", () => {
    for (const s of sites) {
      const plan = planCity(s);
      const now = new CityData(s, plan);
      const job = CityData.job(s, plan);
      let steps = 0;
      let r = job.next();
      for (; !r.done; r = job.next()) steps++;
      expect(steps).toBeGreaterThan(10);
      const later = r.value;
      const keys = Object.keys(now).filter((k) => k !== 'rest');
      expect(Object.keys(later).filter((k) => k !== 'rest').sort()).toEqual([...keys].sort());
      for (const k of keys) expect((later as unknown as Record<string, unknown>)[k], `${s.kind} ${k}`).toEqual((now as unknown as Record<string, unknown>)[k]);
    }
  });
});
