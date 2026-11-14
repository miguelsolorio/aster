import { describe, expect, it } from 'vitest';
import { avenueBearings, planCity } from '../plan';
import { packAvenues } from '../placement';
import { HEADROOM, shellCeil, shellSolid, shellTop } from '../rooms';
import { stairTop, storeysOf } from '../furnish';
import type { CityKind, CityPlan, CitySite, Room, RoomStair } from '../types';

function plan(kind: CityKind, seed: number): CityPlan {
  const s: CitySite = { id: seed, seed, cx: 0, cz: 0, radius: 360, groundY: 0, kind, rot: 0, phase1: 0.3, phase2: 0.7, falloff: 120, aveA: 0, aveB: 0 };
  [s.aveA, s.aveB] = packAvenues(avenueBearings(s));
  return planCity(s);
}

const PLANS = (['trade', 'hill', 'canyon', 'oasis'] as CityKind[]).map((k) => [k, plan(k, 7)] as const);

/** Centre of step j of a flight, and a point beyond its top end. */
function onStair(st: RoomStair, j: number): [number, number] {
  const a = (j + 0.5) * st.run;
  const cx = (st.x0 + st.x1) / 2, cz = (st.z0 + st.z1) / 2;
  if (st.dir === 0) return [st.x0 + a, cz];
  if (st.dir === 1) return [st.x1 - a, cz];
  if (st.dir === 2) return [cx, st.z0 + a];
  return [cx, st.z1 - a];
}

describe('furnished rooms', () => {
  for (const [kind, p] of PLANS) {
    it(`${kind}: every room has furniture and a candle, inside its walls and clear of the stairs`, () => {
      for (const r of p.rooms) {
        expect(r.pieces.length, `room ${r.bi}`).toBeGreaterThan(0);
        expect(r.candles.length, `room ${r.bi}`).toBeGreaterThan(0);
        for (const q of r.pieces) {
          expect(q.x0).toBeGreaterThanOrEqual(r.x0 + r.t - 1e-6);
          expect(q.x1).toBeLessThanOrEqual(r.x1 - r.t + 1e-6);
          expect(q.z0).toBeGreaterThanOrEqual(r.z0 + r.t - 1e-6);
          expect(q.z1).toBeLessThanOrEqual(r.z1 - r.t + 1e-6);
          for (const st of r.stairs) {
            const sameFloor = Math.abs(q.y - st.y0) < 1e-6 || Math.abs(q.y - st.y1) < 1e-6;
            if (sameFloor) expect(q.x0 < st.x1 && q.x1 > st.x0 && q.z0 < st.z1 && q.z1 > st.z0, `piece on stair of room ${r.bi}`).toBe(false);
          }
        }
      }
    });
    it(`${kind}: tall houses have floors and stairs, climbable step by step with headroom`, () => {
      const tall = p.rooms.filter((r) => r.floors.length > 0);
      expect(tall.length).toBeGreaterThan(10);
      for (const r of tall) {
        expect(r.stairs.length).toBeGreaterThanOrEqual(storeysOf(r) - 1);
        for (const st of r.stairs) {
          const rise = (st.y1 - st.y0) / st.steps;
          expect(rise).toBeLessThanOrEqual(0.35);
          let feet = st.y0;
          for (let j = 0; j < st.steps; j++) {
            const [x, z] = onStair(st, j);
            const top = shellTop(r, x, z, feet);
            expect(top, `room ${r.bi} step ${j}`).toBeCloseTo(st.y0 + (j + 1) * rise, 5);
            expect(top - feet).toBeLessThanOrEqual(rise + 1e-6);
            feet = top;
            expect(stairTop(st, x, z)).toBeCloseTo(top, 5);
            expect(shellCeil(r, x, z, feet) - feet, `headroom room ${r.bi} step ${j}`).toBeGreaterThanOrEqual(HEADROOM);
            expect(shellSolid(r, x, feet + 0.5, z, 0)).toBe(false);
          }
          // the top of the flight meets the floor above (or the roof) at the same height
          expect(feet).toBeCloseTo(st.y1, 5);
        }
      }
    });
    it(`${kind}: the floors are solid, the stairwell open, and the roof hatch leads out`, () => {
      for (const r of p.rooms.filter((q) => q.floors.length > 0)) {
        const xm = (r.x0 + r.x1) / 2, zm = (r.z0 + r.z1) / 2;
        const open = (x: number, z: number) => r.stairs.some((st) => x >= st.x0 && x < st.x1 && z >= st.z0 && z < st.z1);
        for (let j = 0; j < r.floors.length; j++) {
          const f = r.floors[j];
          // a point on the slab that is not over a stairwell (or on a piece) is stood on
          const xs = [xm, r.x0 + r.t + 0.3, r.x1 - r.t - 0.3];
          for (const x of xs) {
            const z = zm;
            if (open(x, z) || r.pieces.some((q) => x >= q.x0 && x < q.x1 && z >= q.z0 && z < q.z1)) continue;
            expect(shellTop(r, x, z, f)).toBeCloseTo(f, 5);
            expect(shellCeil(r, x, z, f - 1)).toBeCloseTo(f - 0.25, 5);
          }
        }
        if (r.hatch) {
          const [x, z] = onStair(r.hatch, r.hatch.steps - 1);
          expect(r.hatch.y1).toBeCloseTo(r.h, 5);
          expect(shellTop(r, x, z, r.h - 0.3)).toBeCloseTo(r.h, 5);
          expect(shellCeil(r, x, z, r.h - 2)).toBe(Infinity);
        }
      }
      expect(PLANS.some(([, q]) => q.rooms.some((r) => r.hatch))).toBe(true);
    });
  }
});
