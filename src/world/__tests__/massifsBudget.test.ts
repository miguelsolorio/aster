import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { Massifs } from '../massifs';
import { createWorld } from '../surface';
import { finish, frameBudget, type Job } from '../budget';

interface Inner {
  build(key: string, x: number, z: number, r: number): Job<void>;
  built: Map<string, THREE.Mesh>;
  job: unknown;
  update(f: unknown, levels: number): void;
}

const data = (m: THREE.Mesh) => ({
  attrs: Object.entries(m.geometry.attributes).map(([n, a]) => [n, Array.from(a.array as Float32Array)]),
  index: Array.from(m.geometry.index!.array),
  pos: m.position.toArray(),
});

describe('massifs on the frame budget', () => {
  for (const seed of [20261111, 3]) {
    it(`built a ring at a time equals built at once (seed ${seed})`, () => {
      const w = createWorld(seed);
      const list: { x: number; z: number; r: number }[] = [];
      for (let i = -6; i <= 6 && list.length < 4; i++) for (let j = -6; j <= 6 && list.length < 4; j++) {
        const m = w.massif(i, j);
        if (m) list.push(m);
      }
      expect(list.length).toBe(4);
      const a = new Massifs(w, {}) as unknown as Inner;
      const b = new Massifs(w, {}) as unknown as Inner;
      list.forEach((m, n) => {
        finish(a.build('k' + n, m.x, m.z, m.r));
        const it = b.build('k' + n, m.x, m.z, m.r);
        let steps = 0;
        while (!it.next().done) steps++;
        expect(steps).toBeGreaterThan(20);
        expect(data(b.built.get('k' + n)!)).toEqual(data(a.built.get('k' + n)!));
      });
    });
  }

  it('update builds one massif over several frames, and the next after it', () => {
    const w = createWorld(20261111);
    const a = new Massifs(w, {}) as unknown as Inner;
    const f = { dt: 1, camera: { position: { x: 0, y: 0, z: 0 } }, player: { pos: { x: 0, z: 0 } } };
    let frames = 0;
    // a budget of next to nothing still takes a step a frame
    while (a.built.size < 2 && frames < 2000) {
      frameBudget.begin(0.0001);
      a.update(f, 8);
      frames++;
    }
    frameBudget.begin(Infinity);
    expect(a.built.size).toBe(2);
    expect(frames).toBeGreaterThan(30);
  });
});
