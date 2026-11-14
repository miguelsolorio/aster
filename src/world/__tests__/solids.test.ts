import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HEADROOM, Solids } from '../solids';
import { STEP, wallAhead } from '../../game/player';
import { CREATURE_STEP, steer, steered, type SolidQuery } from '../avoid';

/** A box of size (w, h, d) centred at (x, y, z), added to s. */
function addBox(s: Solids, x: number, y: number, z: number, w: number, h: number, d: number, rotY = 0) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(w, h, d));
  s.addPrim('box', m, m.clone().invert(), 0, 0.5, 0.5);
}

/** The player's view of the solids with feet at height y. */
const playerTop = (s: Solids, y: number) => (x: number, z: number) => s.topAt(x, z, y);
const walled = (s: Solids, x: number, z: number, dx: number, dz: number, feet = 0) => wallAhead(playerTop(s, feet), x, z, dx, dz, feet + STEP);

describe('Solids vs the player step rule', () => {
  it('a box taller than STEP blocks', () => {
    const s = new Solids();
    addBox(s, 0, 1, 0, 2, 2, 2); // 0..2 high
    expect(s.topAt(0, 0, 0)).toBeCloseTo(2);
    expect(s.topAt(0, 0, 0)).toBeGreaterThan(STEP);
    expect(walled(s, -3, 0, 1.5, 0)).toBe(false); // clear of it
    expect(walled(s, -1.5, 0, 0.6, 0)).toBe(true); // arm's length reaches it
  });

  it('a low box can be stepped onto', () => {
    const s = new Solids();
    addBox(s, 0, 0.25, 0, 2, 0.5, 2);
    expect(s.topAt(0, 0, 0)).toBeCloseTo(0.5);
    expect(walled(s, -1.2, 0, 0.6, 0)).toBe(false);
  });

  it('an overhead solid leaves headroom to pass beneath', () => {
    const s = new Solids();
    addBox(s, 0, 3, 0, 4, 1, 4); // underside 2.5, above feet + HEADROOM
    expect(2.5).toBeGreaterThan(HEADROOM);
    expect(s.topAt(0, 0, 0)).toBe(-Infinity);
    expect(s.ceilAt(0, 0, 0)).toBeCloseTo(2.5);
    expect(walled(s, -3, 0, 4, 0)).toBe(false);
  });

  it('a solid hung too low is a wall, not overhead', () => {
    const s = new Solids();
    addBox(s, 0, 2, 0, 4, 1, 4); // underside 1.5, under HEADROOM
    expect(s.topAt(0, 0, 0)).toBeCloseTo(2.5);
    expect(walled(s, -1, 0, 0.6, 0)).toBe(true);
  });

  it('a capsule (cactus-like) blocks', () => {
    const s = new Solids();
    s.addCapsule(new THREE.Vector3(0, 0.3, 0), new THREE.Vector3(0, 2.5, 0), 0.4, 2);
    expect(s.topAt(0, 0, 0)).toBeCloseTo(2.9);
    expect(s.topAt(0.3, 0, 0)).toBeGreaterThan(STEP);
    expect(s.topAt(0.6, 0, 0)).toBe(-Infinity);
    expect(walled(s, -0.6, 0, 0.5, 0)).toBe(true);
  });
});

describe('avoid.steer', () => {
  it('never ends a step inside a box, over many steps', () => {
    const s = new Solids();
    addBox(s, 0, 1, 0, 3, 2, 3, 0.4);
    const q: SolidQuery = (x, z, y) => s.topAt(x, z, y);
    const inside = (x: number, z: number) => q(x, z, 0) > CREATURE_STEP;
    for (const [sx, sz, hx, hz] of [[-10, 0.2, 1, 0], [0.3, -10, 0, 1], [10, -9, -1, 1], [-8, 7, 1, -0.7]]) {
      let x = sx;
      let z = sz;
      let side = 1;
      const l = Math.hypot(hx, hz);
      for (let i = 0; i < 400; i++) {
        steer(q, x, z, 0, (hx / l) * 0.15, (hz / l) * 0.15, 0.3, side);
        x = steered.x;
        z = steered.z;
        side = steered.side;
        expect(inside(x, z)).toBe(false);
      }
    }
  });
});
