import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { assembleDeep } from '../assemble';
import type { BuiltDeep, DeepData } from '../builder';
import { createDeepData, deepBuffers, reviveDeepData } from '../data';
import { DeepAhead, type DeepAnswer, type DeepAsk, type DeepWorker } from '../deepAhead';
import { createDeep } from '../index';
import type { DeepSpec } from '../types';
import { vaultLayout } from '../vault';

const spec = (kind: number, seed: number, tier: 0 | 1 | 2, relic = true): DeepSpec => ({ x: 100, z: -50, y: 20, dx: 0.6, dz: 0.8, kind: kind as 0, seed, u1: 300, v0: -150, v1: 150, lid: -6, relic, vein: true, carvings: true, tier });

/** The deep as the worker path makes it: the data crosses a structured clone with its buffers handed over. */
function viaWorker(s: DeepSpec): BuiltDeep {
  const data = createDeepData(s);
  const sent = structuredClone(data, { transfer: deepBuffers(data) });
  // (handed over, not copied: the arrays on this side are gone)
  expect(data.rock.pos.length).toBe(0);
  expect(data.grid.f.length).toBe(0);
  return assembleDeep(reviveDeepData(sent));
}

function meshes(d: { group: THREE.Group }): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  d.group.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

const bytes = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

describe('a deep built on a worker', () => {
  for (const [kind, seed, tier] of [[0, 3, 2], [1, 5, 2], [4, 8, 2]] as const) {
    it(`is the deep built on the page (kind ${kind}, seed ${seed}, tier ${tier})`, () => {
      const s = spec(kind, seed, tier);
      const a = createDeep(s) as BuiltDeep;
      const b = viaWorker(s);
      const ma = meshes(a);
      const mb = meshes(b);
      expect(mb.length).toBe(ma.length);
      for (let i = 0; i < ma.length; i++) {
        const ga = ma[i].geometry;
        const gb = mb[i].geometry;
        expect(Object.keys(gb.attributes)).toEqual(Object.keys(ga.attributes));
        for (const k of Object.keys(ga.attributes)) {
          const x = ga.attributes[k] as THREE.BufferAttribute;
          const y = gb.attributes[k] as THREE.BufferAttribute;
          expect([y.itemSize, y.normalized, y.array.constructor]).toEqual([x.itemSize, x.normalized, x.array.constructor]);
          const bx = bytes(x.array);
          const by = bytes(y.array);
          expect(by.length).toBe(bx.length);
          expect(by.every((v, j) => v === bx[j])).toBe(true);
        }
        expect(gb.index && bytes(gb.index.array)).toEqual(ga.index && bytes(ga.index.array));
        // the sphere worked out with the data is the one three would work out here
        const fresh = new THREE.BufferGeometry();
        fresh.setAttribute('position', ga.attributes.position);
        fresh.computeBoundingSphere();
        expect(gb.boundingSphere).toEqual(fresh.boundingSphere);
        expect(ga.boundingSphere).toEqual(fresh.boundingSphere);
        const xa = ma[i].material as THREE.ShaderMaterial;
        const xb = mb[i].material as THREE.ShaderMaterial;
        expect([xb.vertexShader, xb.fragmentShader, mb[i].renderOrder]).toEqual([xa.vertexShader, xa.fragmentShader, ma[i].renderOrder]);
      }
      expect(b.group.matrix.equals(a.group.matrix)).toBe(true);
      expect([b.relic, b.stone, b.centre, b.ledge]).toEqual([a.relic, a.stone, a.centre, a.ledge]);
      const { assembleMs: _x, ...sa } = a.stats;
      const { assembleMs: _y, ...sb } = b.stats;
      expect({ ...sb, carveMs: 0, meshMs: 0, bakeMs: 0, totalMs: 0 }).toEqual({ ...sa, carveMs: 0, meshMs: 0, bakeMs: 0, totalMs: 0 });
      // and it answers feet, eyes and lights the same everywhere
      const oa = [0, 0, 0, 0];
      const ob = [0, 0, 0, 0];
      let r = seed;
      const rnd = () => {
        r = (r * 16807) % 2147483647;
        return r / 2147483647;
      };
      for (let i = 0; i < 1000; i++) {
        const u = rnd() * 310 - 5;
        const v = rnd() * 300 - 150;
        const y = 20 - rnd() * 90;
        const x = 100 + u * 0.6 - v * 0.8;
        const z = -50 + u * 0.8 + v * 0.6;
        expect(b.floorAt(x, z, y)).toBe(a.floorAt(x, z, y));
        expect(b.ceilAt(x, z, y)).toBe(a.ceilAt(x, z, y));
        expect(b.inside(x, y, z)).toBe(a.inside(x, y, z));
        expect(b.glowAt(x, y, z, ob)).toBe(a.glowAt(x, y, z, oa));
        expect(ob).toEqual(oa);
        expect(b.waterAt(x, z, y)).toBe(a.waterAt(x, z, y));
        expect(b.wetness(x, y, z)).toBe(a.wetness(x, y, z));
      }
      if (kind === 0) expect(vaultLayout(b)).toEqual(vaultLayout(a));
    }, 60000);
  }
});

/** A worker that answers when told to, by building the deep it was asked for. */
function fakeWorker() {
  const posted: DeepAsk[] = [];
  const w: DeepWorker & { answer(fail?: boolean): void; fail(): void; dead: boolean } = {
    onmessage: null,
    onerror: null,
    dead: false,
    postMessage: (a) => {
      posted.push(a);
    },
    terminate: () => {
      w.dead = true;
    },
    answer: (fail = false) => {
      const a = posted.shift()!;
      const data = fail ? null : structuredClone(createDeepData(a.spec));
      w.onmessage?.({ data: { id: a.id, data } as DeepAnswer });
    },
    fail: () => w.onerror?.(new Error('no')),
  };
  return { w, posted };
}

describe('DeepAhead', () => {
  const s1 = spec(3, 1, 2, false);
  const s2 = spec(4, 2, 2, false);

  it('works on one at a time, and hands each over once', () => {
    const { w, posted } = fakeWorker();
    const ahead = new DeepAhead(() => w);
    ahead.request(1, s1);
    ahead.request(1, s1); // asked once only
    ahead.request(2, s2);
    expect(posted.length).toBe(1);
    expect(ahead.take(1, s1)).toBeNull();
    w.answer();
    expect(posted.length).toBe(1); // the next one goes out as soon as the first is back
    expect(ahead.has(1, s1)).toBe(true);
    const d: DeepData | null = ahead.take(1, s1);
    expect(d?.grid.floorAt(10, 0, -5)).toBeTypeOf('number');
    expect(assembleDeep(d!).floorAt(100, -50, 20)).not.toBeNull();
    expect(ahead.take(1, s1)).toBeNull();
    w.answer();
    expect(ahead.take(2, s2)).not.toBeNull();
  });

  it('drops what nobody is waiting for, and what was built from another spec', () => {
    const { w, posted } = fakeWorker();
    const ahead = new DeepAhead(() => w);
    ahead.request(1, s1);
    ahead.request(2, s2);
    ahead.keep(new Set([2])); // 1 is in flight: its answer is thrown away
    w.answer();
    expect(ahead.take(1, s1)).toBeNull();
    expect(posted[0].spec).toEqual(s2);
    w.answer();
    expect(ahead.take(2, { ...s2, tier: 0 })).toBeNull(); // the quality changed meanwhile
    expect(ahead.asked(2, s2)).toBe(false);
  });

  it('puts an urgent one first', () => {
    const { w, posted } = fakeWorker();
    const ahead = new DeepAhead(() => w);
    ahead.request(1, s1);
    ahead.request(2, s2);
    ahead.request(3, spec(0, 3, 2), true);
    w.answer();
    expect(posted[0].spec.kind).toBe(0);
  });

  it('stops working when there is no worker, or the worker fails', () => {
    expect(new DeepAhead(() => null).working).toBe(false);
    const { w } = fakeWorker();
    const ahead = new DeepAhead(() => w);
    ahead.request(1, s1);
    w.answer(true); // a build that failed there is made on the page instead
    expect(ahead.take(1, s1)).toBeNull();
    expect(ahead.working).toBe(true);
    w.fail();
    expect(ahead.working).toBe(false);
    expect(w.dead).toBe(true);
    ahead.request(1, s1);
    expect(ahead.take(1, s1)).toBeNull();
  });
});
