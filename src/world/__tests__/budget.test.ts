import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FrameBudget, Task, finish, frameBudget } from '../budget';
import { soupNormals, soupSphere } from '../soup';
import { createWorld } from '../surface';
import { Discoveries } from '../discoveries';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { dropSettlementModels, useSettlementModels } from '../settlements';
import { isSettlement } from '../settlementKinds';

describe('FrameBudget', () => {
  /** A job of `n` steps, each taking `ms` on the fake clock. */
  const steps = (clock: { t: number }, n: number, ms: number, log: number[]) =>
    (function* () {
      for (let i = 0; i < n; i++) {
        clock.t += ms;
        log.push(i);
        yield;
      }
      return 'done';
    })();

  it('steps a job until the frame is spent, and carries on next frame', () => {
    const clock = { t: 0 };
    const b = new FrameBudget(() => clock.t);
    const log: number[] = [];
    const job = steps(clock, 10, 1, log);
    b.begin(3);
    expect(b.run(job)).toBe(false);
    expect(log.length).toBe(3);
    expect(b.open).toBe(false);
    expect(b.spent).toBe(3);
    // nothing left: no step at all
    expect(b.run(job)).toBe(false);
    expect(log.length).toBe(3);
    b.begin(3);
    b.run(job);
    expect(log.length).toBe(6);
    b.begin(100);
    expect(b.run(job)).toBe(true);
    expect(log).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('shares one frame between jobs: what the first takes the second does not get', () => {
    const clock = { t: 0 };
    const b = new FrameBudget(() => clock.t);
    const a: number[] = [];
    const c: number[] = [];
    const ja = steps(clock, 10, 1, a);
    const jc = steps(clock, 10, 1, c);
    b.begin(4);
    b.run(ja);
    b.run(jc);
    expect(a.length + c.length).toBe(4);
    expect(c.length).toBe(0);
    b.spend(-2); // (spend takes off what the caller timed: here, gives two back)
    b.run(jc);
    expect(c.length).toBe(2);
  });

  it('a step longer than the frame still runs (once), and the overrun is not carried over', () => {
    const clock = { t: 0 };
    const b = new FrameBudget(() => clock.t);
    const log: number[] = [];
    const job = steps(clock, 3, 10, log);
    b.begin(3);
    b.run(job);
    expect(log.length).toBe(1);
    expect(b.remaining).toBe(0);
    b.begin(3);
    b.run(job);
    expect(log.length).toBe(2);
  });

  it('is unlimited until a frame opens it, so headless work runs straight through', () => {
    const b = new FrameBudget(() => 0);
    expect(b.framed).toBe(false);
    const log: number[] = [];
    expect(b.run(steps({ t: 0 }, 50, 1, log))).toBe(true);
    expect(log.length).toBe(50);
    b.begin(2);
    expect(b.framed).toBe(true);
  });

  it('finish runs a job to its end and hands back its value; Task keeps it', () => {
    const clock = { t: 0 };
    expect(finish(steps(clock, 5, 1, []))).toBe('done');
    const b = new FrameBudget(() => clock.t);
    const task = new Task(steps(clock, 5, 1, []));
    b.begin(2);
    expect(task.run(b)).toBe(false);
    expect(task.value).toBeUndefined();
    b.begin(10);
    expect(task.run(b)).toBe(true);
    expect(task.value).toBe('done');
    expect(task.run(b)).toBe(true);
  });
});

describe('soup normals and bounds', () => {
  it('are exactly three.js computeVertexNormals and computeBoundingSphere, in slices', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647) * 200 - 100;
    };
    const pos = new Float32Array(3 * 3 * 5000);
    for (let i = 0; i < pos.length; i++) pos[i] = rnd();
    // a degenerate triangle too (zero area: normal 0, as three gives it)
    pos.fill(1, 0, 9);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const nrm = new Float32Array(pos.length);
    const job = soupNormals(pos, nrm, 64);
    let n = 0;
    while (!job.next().done) n++;
    expect(n).toBeGreaterThan(10);
    expect(Array.from(nrm)).toEqual(Array.from(g.attributes.normal.array));
    const sphere = finish(soupSphere(pos, 100));
    expect(sphere.center.toArray()).toEqual(g.boundingSphere?.center.toArray());
    expect(sphere.radius).toBe(g.boundingSphere?.radius);
  });
});

describe('the discoveries on a frame budget', () => {
  /** Everything a built site's meshes hold, to compare two builds of it. */
  const dump = (d: Discoveries) => {
    const sites = (
      d as unknown as { sites: { key: number; kind: string; group: THREE.Group; solids: { count: number; reach: number } | null }[] }
    ).sites;
    return sites
      .map((s) => {
        const parts: unknown[] = [s.key, s.kind, s.solids?.count ?? 0, s.solids?.reach ?? 0];
        s.group.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const geo = o.geometry as THREE.BufferGeometry;
          for (const n of Object.keys(geo.attributes).sort()) {
            const a = geo.attributes[n].array as ArrayLike<number>;
            let h = 0;
            for (let i = 0; i < a.length; i++) h = (h * 31 + Math.round(a[i] * 4096)) | 0;
            parts.push(n, a.length, h);
          }
          parts.push(geo.boundingSphere?.radius);
        });
        return parts;
      })
      .sort((a, b) => (a[0] as number) - (b[0] as number));
  };

  type Inner = {
    buildSite(cx: number, cz: number): void;
    cellSite(cx: number, cz: number): boolean;
    scanMassifs(px: number, pz: number): boolean;
    syncBuild: boolean;
    jobs: { it: Iterator<unknown> }[];
    cavernJob(cx: number, cz: number): Generator<void, unknown>;
    cavernAt(cx: number, cz: number): unknown;
    springsJob(gi: number, gj: number, m: unknown): Generator<void, unknown>;
    springsOf(gi: number, gj: number, m: unknown): unknown;
    villagesJob(gi: number, gj: number, m: unknown): Generator<void, unknown>;
    villagesOf(gi: number, gj: number, m: unknown): unknown;
  };

  /** The settlements' modelled pieces, read straight from the file (no fetch in tests). */
  const kit = async (): Promise<GLTF> => {
    // (node's own fs, without node's types, which this project does not have)
    type Fs = { readFileSync(path: string): Uint8Array };
    const fs = (globalThis as unknown as { process: { getBuiltinModule(id: string): Fs } }).process.getBuiltinModule('node:fs');
    const buf = fs.readFileSync('public/art/settlements.glb');
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
  };

  /** Builds the cells' finds of a world at once in one, and as jobs stepped round robin in another. */
  const both = (seed: number, during?: () => void) => {
    const now = new Discoveries(createWorld(seed), {});
    const later = new Discoveries(createWorld(seed), {});
    const a = now as unknown as Inner;
    const b = later as unknown as Inner;
    const cells: [number, number][] = [];
    for (let cz = -5; cz <= 5; cz++) for (let cx = -5; cx <= 5; cx++) if (a.cellSite(cx, cz)) cells.push([cx, cz]);
    for (const [cx, cz] of cells) a.buildSite(cx, cz);
    b.syncBuild = false;
    for (const [cx, cz] of cells) b.buildSite(cx, cz);
    b.syncBuild = true;
    expect(b.jobs.length).toBe(cells.length);
    let steps = 0;
    while (b.jobs.length > 0) {
      for (let i = 0; i < b.jobs.length; i++) {
        // (once every job has begun)
        if (++steps === cells.length + 5) during?.();
        if (b.jobs[i].it.next().done) b.jobs.splice(i--, 1);
      }
    }
    expect(steps).toBeGreaterThan(cells.length * 3);
    return { now, later };
  };

  it('builds sites through jobs, stepped in turn with one another, exactly as at once', async () => {
    const { now, later } = both(3);
    // (jobs left their sites in the order they finished)
    expect(dump(later)).toEqual(dump(now));
    expect(dump(now).some((s) => isSettlement(s[1] as string))).toBe(true);
    // and with the modelled pieces in use
    expect(useSettlementModels(await kit())).toBe(true);
    try {
      const m = both(3);
      expect(dump(m.later)).toEqual(dump(m.now));
      expect(dump(m.now)).not.toEqual(dump(now));
    } finally {
      dropSettlementModels();
    }
  });

  it('a settlement begun without the modelled pieces is built without them throughout, though they come mid-way', async () => {
    const gltf = await kit();
    let came = false;
    try {
      const { now, later } = both(3, () => {
        came = useSettlementModels(gltf);
      });
      expect(came).toBe(true);
      expect(dump(later)).toEqual(dump(now));
    } finally {
      dropSettlementModels();
    }
  });

  it('finishes a site at once when the wanderer comes near it, whatever the budget', () => {
    const d = new Discoveries(createWorld(3), {});
    const b = d as unknown as Inner & { pumpJobs(px: number, pz: number): void; sitesNear: Discoveries['sitesNear'] };
    let cell: [number, number] = [NaN, NaN];
    for (let cz = 0; cz <= 3 && Number.isNaN(cell[0]); cz++)
      for (let cx = 0; cx <= 3 && Number.isNaN(cell[0]); cx++) if (b.cellSite(cx, cz)) cell = [cx, cz];
    expect(Number.isNaN(cell[0])).toBe(false);
    b.syncBuild = false;
    b.buildSite(cell[0], cell[1]);
    b.syncBuild = true;
    const job = b.jobs[0] as unknown as { x: number; z: number };
    try {
      frameBudget.begin(0);
      b.pumpJobs(job.x + 5000, job.z);
      expect(b.jobs.length).toBe(1);
      b.pumpJobs(job.x + 100, job.z);
      expect(b.jobs.length).toBe(0);
    } finally {
      frameBudget.begin(Infinity);
    }
  });

  it('works caverns, springs and villages out a step at a time, interleaved, to the same answers', () => {
    const w1 = createWorld(5);
    const sync = new Discoveries(w1, {}) as unknown as Inner;
    const stepped = new Discoveries(createWorld(5), {}) as unknown as Inner;
    const jobs: { it: Generator<void, unknown>; want: () => unknown }[] = [];
    for (let cz = -2; cz <= 2; cz++) {
      for (let cx = -2; cx <= 2; cx++) jobs.push({ it: stepped.cavernJob(cx, cz), want: () => sync.cavernAt(cx, cz) });
    }
    const massif = (w1 as unknown as { massif(gi: number, gj: number): unknown }).massif.bind(w1);
    for (let gj = -1; gj <= 1; gj++) {
      for (let gi = -1; gi <= 1; gi++) {
        const m = massif(gi, gj);
        if (!m) continue;
        jobs.push({ it: stepped.springsJob(gi, gj, m), want: () => sync.springsOf(gi, gj, m) });
        jobs.push({ it: stepped.villagesJob(gi, gj, m), want: () => sync.villagesOf(gi, gj, m) });
      }
    }
    const got = new Map<number, unknown>();
    while (got.size < jobs.length) {
      for (let i = 0; i < jobs.length; i++) {
        if (got.has(i)) continue;
        const r = jobs[i].it.next();
        if (r.done) got.set(i, r.value);
      }
    }
    const strip = (v: unknown) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === 'deep' ? null : x)));
    for (let i = 0; i < jobs.length; i++) expect(strip(got.get(i))).toEqual(strip(jobs[i].want()));
  });

  it('finds the nearest unfound place on the budget as it does at once', () => {
    const a = new Discoveries(createWorld(2), {});
    const b = new Discoveries(createWorld(2), {});
    const found = new Set(['temple', 'ruins', 'bones']);
    const want = a.nearestUnfound(1500, -800, found, 9000);
    const task = new Task(b.unfoundJob(1500, -800, found, 9000));
    const clock = { t: 0 };
    const budget = new FrameBudget(() => clock.t++);
    budget.begin(3);
    let frames = 0;
    while (!task.run(budget)) {
      budget.begin(3);
      frames++;
    }
    expect(frames).toBeGreaterThan(5);
    expect(task.value).toEqual(want);
  });
});
