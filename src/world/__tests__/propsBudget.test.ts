import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type * as THREE from 'three';
import { Props } from '../props';
import { createWorld } from '../surface';
import { finish, frameBudget, type Job } from '../budget';

interface Probe {
  startJob(k: number): { k: number; it: Job<void>; out: unknown };
  land(j: unknown): void;
  chunks: Map<number, { mesh: THREE.Mesh | null; shade: THREE.Mesh | null; solids: { count: number } | null; spots: number[]; groups: number }>;
}
// the modelled rocks and cacti, read straight from the files (no fetch in tests)
vi.mock('../../render/art', async (orig) => ({
  ...(await orig<typeof import('../../render/art')>()),
  loadModel: (file: string): Promise<GLTF | null> => {
    type Fs = { readFileSync(path: string): Uint8Array };
    const fs = (globalThis as unknown as { process: { getBuiltinModule(id: string): Fs } }).process.getBuiltinModule('node:fs');
    const buf = fs.readFileSync(`public/art/${file}`);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
  },
}));

const key = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);

/** A chunk's data in a form two builds can be compared by: every attribute, index, bound, solids and footprints. */
function dump(p: Probe, k: number): unknown {
  const c = p.chunks.get(k)!;
  const geo = (m: THREE.Mesh | null) =>
    m && {
      attrs: Object.entries(m.geometry.attributes).map(([n, a]) => [n, Array.from(a.array as Float32Array)]),
      index: m.geometry.index ? Array.from(m.geometry.index.array) : null,
      sphere: m.geometry.boundingSphere && [m.geometry.boundingSphere.center.toArray(), m.geometry.boundingSphere.radius],
      pos: m.position.toArray(),
    };
  return { mesh: geo(c.mesh), shade: geo(c.shade), solids: c.solids && JSON.stringify(c.solids), spots: c.spots, groups: c.groups };
}

describe('props chunk building', () => {
  // (a first Props asks for the models; they are in once its promise chain has run)
  beforeAll(async () => {
    new Props(createWorld(1), {});
    await new Promise((r) => setTimeout(r, 500));
  });

  const chunksOf = [
    [0, 0],
    [3, -2],
    [-7, 5],
    [12, 9],
    [40, 31],
    [-55, 17],
    [23, -62],
    [90, 90],
  ];
  for (const seed of [20261111, 7]) {
    it(`built a step at a time equals built at once (seed ${seed})`, () => {
      const w = createWorld(seed);
      const one = new Props(w, {}) as unknown as Probe;
      const many = new Props(w, {}) as unknown as Probe;
      let steps = 0;
      let groups = 0;
      let nonEmpty = 0;
      for (const [ix, iz] of chunksOf) {
        const k = key(ix, iz);
        const a = one.startJob(k);
        finish(a.it);
        one.land(a);
        const b = many.startJob(k);
        while (!b.it.next().done) steps++;
        many.land(b);
        expect(many.chunks.has(k)).toBe(one.chunks.has(k));
        expect(dump(many, k)).toEqual(dump(one, k));
        groups += one.chunks.get(k)!.groups;
        if (one.chunks.get(k)!.mesh) nonEmpty++;
      }
      expect(groups).toBeGreaterThan(0);
      expect(steps).toBeGreaterThan(chunksOf.length * 10);
      expect(nonEmpty).toBeGreaterThan(2);
    });
  }

  it('interleaved jobs do not disturb each other', () => {
    const w = createWorld(20261111);
    const ref = new Props(w, {}) as unknown as Probe;
    const mix = new Props(w, {}) as unknown as Probe;
    const ks = chunksOf.map(([i, j]) => key(i, j));
    for (const k of ks) {
      const a = ref.startJob(k);
      finish(a.it);
      ref.land(a);
    }
    const jobs = ks.map((k) => mix.startJob(k));
    for (let live = jobs.length; live > 0; ) {
      live = 0;
      for (const j of jobs) if (!j.it.next().done) live++;
    }
    for (const j of jobs) mix.land(j);
    for (const k of ks) expect(dump(mix, k)).toEqual(dump(ref, k));
  });
});

describe('props update on the frame budget', () => {
  const frame = (x: number, z: number) => ({ dt: 1 / 60, player: { pos: { x, z, y: 0 }, vel: { x: 0, z: 0, y: 0 } } }) as never;

  it('has what is under the wanderer built at once, and the rest a few steps a frame', () => {
    const p = new Props(createWorld(20261111), {});
    const inner = p as unknown as { chunks: Map<number, unknown>; pending: number[]; job: unknown };
    // a frame with no time to spare starts and steps nothing, but the chunks about the wanderer are there
    frameBudget.begin(0);
    p.update(frame(3000, 3000));
    const ix = Math.floor(3000 / 112);
    expect(inner.chunks.has((ix + 32768) * 65536 + (ix + 32768))).toBe(true);
    const first = inner.chunks.size;
    // later frames, a millisecond each, keep building the rest
    for (let f = 0; f < 4000 && (inner.pending.length > 0 || inner.job); f++) {
      frameBudget.begin(1);
      p.update(frame(3000, 3000));
    }
    expect(inner.pending.length).toBe(0);
    expect(inner.chunks.size).toBeGreaterThan(first);
    frameBudget.begin(Infinity);
  });
});
