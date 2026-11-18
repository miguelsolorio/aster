import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CITY_CELL } from '../../city/placement';
import { frostRegion } from '../frost';
import { createWorld } from '../surface';
import { DAY_SECONDS, HOUR_SECONDS, type Storm, Weather, massifGuard } from '../weather';

const SEED = 20261111;
const world = createWorld(SEED);
const guard = massifGuard((i, j) => world.massif(i, j), CITY_CELL, frostRegion(world));
const real = () => new Weather(SEED, guard.shelter);

/** Every storm alive somewhere near (x, z) over a span of days. */
function collect(w: Weather, x: number, z: number, from: number, to: number): Storm[] {
  const seen = new Map<number, Storm>();
  for (let c = from; c < to; c += 0.05) {
    for (const s of w.storms(c, x, z, 8000)) seen.set(s.id, s);
  }
  return [...seen.values()];
}

/** Points on open sand: no shelter and well clear of every keep-out circle. */
function openPoints(n: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let k = 0; pts.length < n && k < 400; k++) {
    const x = ((k * 7919) % 60000) - 30000;
    const z = ((k * 104729) % 60000) - 30000;
    if (guard.shelter(x, z) > 0 || guard.peaks(x, z, 1000).length) continue;
    pts.push([x, z]);
  }
  return pts;
}

describe('weather schedule', () => {
  it('is the same for the same seed, and different for another', () => {
    const a = real();
    const b = real();
    const c = new Weather(SEED + 1, guard.shelter);
    let same = 0;
    let diff = 0;
    for (let k = 0; k < 40; k++) {
      const clock = 1 + k * 0.37;
      const x = k * 900 - 18000;
      const z = 5000 - k * 600;
      const sa = a.storms(clock, x, z, 8000).map((s) => ({ ...s }));
      expect(b.storms(clock, x, z, 8000).map((s) => ({ ...s }))).toEqual(sa);
      expect(b.density(clock, x, z)).toBe(a.density(clock, x, z));
      expect(b.ahead(clock, x, z)).toBe(a.ahead(clock, x, z));
      same += sa.length;
      if (JSON.stringify(c.storms(clock, x, z, 8000)) !== JSON.stringify(sa)) diff++;
    }
    expect(same).toBeGreaterThan(5);
    expect(diff).toBeGreaterThan(5);
  });

  it('has no storm in the first half day', () => {
    const w = new Weather(SEED);
    for (let c = 0; c < 0.5; c += 0.01) {
      for (const [x, z] of [
        [0, 0],
        [12000, -7000],
        [-30000, 22000],
      ]) {
        expect(w.storms(c, x, z, 8000)).toHaveLength(0);
        expect(w.density(c, x, z)).toBe(0);
        expect(w.ahead(c, x, z)).toBe(0);
      }
    }
  });

  it('puts a point on open sand inside a scheduled storm about once in ten days (the rest are sent)', () => {
    const w = real();
    const pts = openPoints(16);
    expect(pts.length).toBe(16);
    const days = 300;
    const step = 4 / DAY_SECONDS;
    let entries = 0;
    for (const [x, z] of pts) {
      let was = false;
      for (let c = 0; c < days; c += step) {
        const inside = w.density(c, x, z) > 0.5;
        if (inside && !was) entries++;
        was = inside;
      }
    }
    const gap = (days * pts.length) / entries;
    expect(gap).toBeGreaterThan(5);
    expect(gap).toBeLessThan(16);
  }, 60000);

  it('takes about two minutes to pass over someone standing still', () => {
    const w = new Weather(SEED);
    const step = 2 / DAY_SECONDS;
    let total = 0;
    let passes = 0;
    for (const [x, z] of [
      [0, 0],
      [9000, 4000],
      [-15000, 20000],
    ]) {
      let run = 0;
      for (let c = 0; c < 60; c += step) {
        if (w.density(c, x, z) > 0) run += 2;
        else if (run > 0) {
          total += run;
          passes++;
          run = 0;
        }
      }
    }
    expect(passes).toBeGreaterThan(20);
    expect(total / passes).toBeGreaterThan(90);
    expect(total / passes).toBeLessThan(180);
  });

  it('warns ahead of a front, fully by the time it arrives, and not far away', () => {
    const w = real();
    const storms = collect(w, 0, 0, 1, 70).filter((s) => (s.t1 - s.t0) * DAY_SECONDS > 600);
    expect(storms.length).toBeGreaterThan(3);
    const at = new THREE.Vector2();
    let checked = 0;
    for (const s of storms) {
      // a point on the centre line that the leading edge reaches well into the storm's life
      const tm = s.t0 + (s.t1 - s.t0) * 0.6;
      w.centre(s, tm, at);
      const px = at.x + s.hx * s.depth * 0.5;
      const pz = at.y + s.hz * s.depth * 0.5;
      if (w.density(tm + 30 / DAY_SECONDS, px, pz) <= 0) continue; // sheltered there
      let firstAhead = Infinity;
      let firstDense = Infinity;
      for (let c = tm - (2 * HOUR_SECONDS) / DAY_SECONDS; c < tm + 60 / DAY_SECONDS; c += 1 / DAY_SECONDS) {
        if (firstAhead === Infinity && w.ahead(c, px, pz) >= 1) firstAhead = c;
        if (firstDense === Infinity && w.density(c, px, pz) > 0) firstDense = c;
      }
      expect(firstAhead).toBeLessThanOrEqual(firstDense);
      // an hour and a half before, nothing yet; half an hour before, something
      // (unless another storm is over the same ground just then)
      if (w.ahead(tm - (1.5 * HOUR_SECONDS) / DAY_SECONDS, px, pz) > 0) continue;
      expect(w.ahead(tm - (0.5 * HOUR_SECONDS) / DAY_SECONDS, px, pz)).toBeGreaterThan(0);
      const h = w.heading(tm - (0.5 * HOUR_SECONDS) / DAY_SECONDS, px, pz, new THREE.Vector2());
      expect(h).not.toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
    // far from the only storm there is (before any scheduled one): nothing at all
    const far = new Weather(SEED);
    far.sent = far.aim(0.2, 0, 0, 30);
    const s = far.sent;
    expect(far.ahead(0.2 + 10 / DAY_SECONDS, 0, 0)).toBeGreaterThan(0); // (a storm warns of itself once it has begun to build)
    expect(far.ahead(0.2, 50000, 50000)).toBe(0);
    expect(far.ahead(0.2, -s.hz * 3500, s.hx * 3500)).toBe(0); // well off to one side
    expect(far.ahead(0.2, s.hx * 5000, s.hz * 5000)).toBe(0); // more than an hour ahead
  });

  it('is zero ahead and nowhere when nothing is coming', () => {
    const w = new Weather(SEED);
    // find a quiet moment at a point: no storm within 8 km
    let quiet = -1;
    for (let c = 1; c < 30; c += 0.01) {
      if (w.storms(c, 3000, 3000, 8000).length === 0) {
        quiet = c;
        break;
      }
    }
    expect(quiet).toBeGreaterThan(0);
    expect(w.ahead(quiet, 3000, 3000)).toBe(0);
    expect(w.density(quiet, 3000, 3000)).toBe(0);
    expect(w.heading(quiet, 3000, 3000, new THREE.Vector2())).toBeNull();
  });

  it('reports a storm sent by hand, coming and already overhead', () => {
    const w = new Weather(SEED);
    const clock = 0.2; // before any scheduled storm
    w.sent = w.aim(clock, 500, -300, 60);
    expect(w.storms(clock, 500, -300, 2000)).toContain(w.sent);
    expect(w.density(clock, 500, -300)).toBe(0);
    expect(w.ahead(clock + 20 / DAY_SECONDS, 500, -300)).toBeGreaterThan(0);
    expect(w.density(clock + 100 / DAY_SECONDS, 500, -300)).toBeGreaterThan(0.5);
    const h = w.heading(clock + 100 / DAY_SECONDS, 500, -300, new THREE.Vector2());
    expect(h?.x).toBeCloseTo(w.sent.hx);
    w.sent = w.aim(clock, 500, -300, -1);
    expect(w.density(clock, 500, -300)).toBeGreaterThan(0.9);
    expect(w.ahead(clock, 500, -300)).toBe(1);
  });

  it('gives nothing where the shelter is complete', () => {
    const w = new Weather(SEED, () => 1);
    w.sent = w.aim(1, 0, 0, -1);
    for (let c = 1; c < 10; c += 0.003) expect(w.density(c, 0, 0)).toBe(0);
  });

  it('keeps every storm off the mountains: inside a keep-out circle the ground is clear', () => {
    const w = real();
    // (a storm right over the origin's mountains as well as whatever the schedule brings)
    w.sent = w.aim(1, 0, 0, -1);
    const peaks = guard.peaks(0, 0, 16000);
    expect(peaks.length).toBeGreaterThan(2);
    for (const p of peaks) {
      for (let c = 0.5; c < 30; c += 10 / DAY_SECONDS) {
        for (let k = 0; k < 5; k++) {
          const a = k * 1.3 + c;
          const r = p.r * (k / 5);
          expect(w.density(c, p.x + Math.cos(a) * r, p.z + Math.sin(a) * r)).toBe(0);
        }
      }
    }
  }, 60000);

  it('leaves a wreck behind about six storms in ten, on the track, the same every time', () => {
    const a = real();
    const b = real();
    const storms = collect(a, 0, 0, 0.5, 400);
    expect(storms.length).toBeGreaterThan(40);
    let wrecks = 0;
    for (const s of storms) {
      const wa = a.wreck(s);
      expect(b.wreck({ ...s })).toEqual(wa);
      if (!wa) continue;
      wrecks++;
      const len = s.speed * (s.t1 - s.t0) * DAY_SECONDS;
      const rx = wa.x - s.x0;
      const rz = wa.z - s.z0;
      expect(Math.abs(rz * s.hx - rx * s.hz)).toBeLessThan(1e-6 * len + 1e-6);
      const along = rx * s.hx + rz * s.hz;
      expect(along).toBeGreaterThanOrEqual(0.3 * len - 1e-6);
      expect(along).toBeLessThanOrEqual(len + 1e-6);
    }
    expect(wrecks / storms.length).toBeGreaterThan(0.45);
    expect(wrecks / storms.length).toBeLessThan(0.75);
  });
});
