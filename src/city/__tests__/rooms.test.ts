import { describe, expect, it } from 'vitest';
import { avenueBearings, planCity } from '../plan';
import { packAvenues } from '../placement';
import { HEADROOM, depthIn, enterable, rectFaces, roomAt, shellCeil, shellSolid, shellTop } from '../rooms';
import type { Building, CityKind, CitySite } from '../types';

const bld = (o: Partial<Building>): Building => ({ x: 0, z: 0, w: 6, d: 6, h: 3.2, roof: 'flat', role: 'house', tint: 0.5, solid: true, crown: 0, ...o });

function site(kind: CityKind, seed: number): CitySite {
  const s: CitySite = { id: seed, seed, cx: 0, cz: 0, radius: 360, groundY: 0, kind, rot: 0, phase1: 0.3, phase2: 0.7, falloff: 120, aveA: 0, aveB: 0 };
  [s.aveA, s.aveB] = packAvenues(avenueBearings(s));
  return s;
}

describe('which buildings are enterable', () => {
  it('houses, halls, markets and landmarks of at least 4 x 4 m', () => {
    for (const role of ['house', 'hall', 'market', 'landmark'] as const) expect(enterable(bld({ role }))).toBe(true);
    expect(enterable(bld({ w: 3, d: 6 }))).toBe(false);
    expect(enterable(bld({ h: 2.4 }))).toBe(false);
  });
  it('walls, gates, stalls, gardens, canopies and non-solid things stay as they are', () => {
    for (const role of ['wall', 'gate', 'stall', 'garden'] as const) expect(enterable(bld({ role }))).toBe(false);
    expect(enterable(bld({ roof: 'canopy' }))).toBe(false);
    expect(enterable(bld({ solid: false }))).toBe(false);
  });
});

describe('rooms of a planned city', () => {
  for (const kind of ['trade', 'hill'] as CityKind[]) {
    it(`${kind}: doorways open on the street, walls solid, the floor open, the roof walkable`, () => {
      const plan = planCity(site(kind, 1234));
      expect(plan.rooms.length).toBeGreaterThan(10);
      for (const r of plan.rooms) {
        const b = plan.buildings[r.bi];
        expect(enterable(b)).toBe(true);
        expect(roomAt(plan, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2)).toBe(r);
        // the height grid is unchanged: people and props still see a block
        expect(plan.grid[Math.floor((r.z0 + r.z1) / 2 + plan.gridHalf) * plan.gridSize + Math.floor((r.x0 + r.x1) / 2 + plan.gridHalf)]).toBeCloseTo(b.h, 4);
        const f = rectFaces(r.x0, r.z0, r.x1, r.z1)[r.door.fi];
        const uc = (r.door.u0 + r.door.u1) / 2;
        const at = (u: number, off: number) => [f.ox + f.tx * u + f.nx * off, f.oz + f.tz * u + f.nz * off] as const;
        // walking in at the feet: outside in the street, through the doorway, into the room
        for (const off of [1.5, 0.5, -0.05, -r.t / 2, -r.t + 0.05, -r.t - 0.5]) {
          const [x, z] = at(uc, off);
          const g = Math.floor(z + plan.gridHalf) * plan.gridSize + Math.floor(x + plan.gridHalf);
          const top = plan.roomOf[g] > 0 ? shellTop(r, x, z, 0) : plan.grid[g] > 0 ? plan.grid[g] : -Infinity;
          expect(top, `${kind} room ${r.bi} off ${off}`).toBe(-Infinity);
        }
        // headroom all the way in
        const [ix, iz] = at(uc, -r.t - 0.5);
        expect(shellCeil(r, ix, iz, 0)).toBeGreaterThanOrEqual(HEADROOM + 0.2);
        // the wall beside the doorway is solid, to the player and the camera
        const [wx, wz] = at(r.door.u0 - 0.3, -r.t / 2);
        expect(depthIn(r, wx, wz)).toBeGreaterThan(0);
        expect(shellTop(r, wx, wz, 0)).toBe(r.h);
        expect(shellSolid(r, wx, 1, wz, 0)).toBe(true);
        // above the lintel the doorway is wall
        const [dx, dz] = at(uc, -r.t / 2);
        expect(shellSolid(r, dx, r.door.top + 0.2, dz, 0)).toBe(true);
        // standing on the roof from outside
        expect(shellTop(r, ix, iz, r.h)).toBe(r.h);
        // the slab is solid to the camera, unless the roof is cut away
        expect(shellSolid(r, ix, (r.ceil + r.h) / 2, iz, 0)).toBe(r.ceil < r.h - 0.01);
        expect(shellSolid(r, ix, (r.ceil + r.h) / 2, iz, 0, true)).toBe(false);
      }
    });
  }
});
