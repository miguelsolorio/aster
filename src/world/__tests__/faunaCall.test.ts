import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { FrameState, SurfaceSample, World } from '../../game/contract';
import { CALL_R, Fauna, MOUNT_REACH } from '../fauna';

/** Flat, plain sand everywhere. */
const flat: World = {
  seed: 7,
  height: () => 0,
  sample: (_x: number, _z: number, out: SurfaceSample) => {
    out.h = 0;
    out.rock = 0;
    out.salt = 0;
    return out;
  },
  normal: (_x: number, _z: number, out: THREE.Vector3) => out.set(0, 1, 0),
};

interface Beast {
  x: number;
  z: number;
}

function frame(): FrameState {
  return {
    dt: 0.05,
    time: 0,
    day: 0.4,
    night: 0,
    sunDir: new THREE.Vector3(0, 1, 0),
    lightDir: new THREE.Vector3(0, 1, 0),
    wind: new THREE.Vector2(1, 0),
    gust: 0,
    camera: new THREE.PerspectiveCamera(),
    player: { pos: new THREE.Vector3(), vel: new THREE.Vector3(), speed: 0, grounded: true, sliding: false, running: false, onRock: 0 },
  };
}

function run(fa: Fauna, f: FrameState, sec: number, each?: () => boolean): void {
  for (let t = 0; t < sec; t += f.dt) {
    f.time += f.dt;
    fa.update(f);
    if (each?.()) return;
  }
}

/** A Fauna with herds about, the player 120 m from the nearest rideable beast. */
function setup(): { fa: Fauna; f: FrameState; beast: Beast } {
  const fa = new Fauna(flat, {});
  const f = frame();
  run(fa, f, 2.5);
  const any = fa.nearestRideable(0, 0, 5000) as Beast | null;
  if (!any) throw new Error('no rideable beast on the flat test world');
  f.player.pos.set(any.x + 120, 0, any.z);
  run(fa, f, 2.5);
  const beast = fa.nearestRideable(f.player.pos.x, f.player.pos.z, CALL_R) as Beast;
  return { fa, f, beast };
}

describe('Fauna.call', () => {
  it('finds nothing to call where nothing rideable is in reach', () => {
    const fa = new Fauna(flat, {});
    expect(fa.call(0, 0)).toBe(false);
    expect(fa.called).toBe(false);
  });

  it('brings the nearest beast to stand just short of the caller, unafraid, then lets it go', () => {
    const { fa, f, beast } = setup();
    const p = f.player.pos;
    const d0 = Math.hypot(beast.x - p.x, beast.z - p.z);
    expect(d0).toBeLessThan(CALL_R);
    let answered = 0;
    fa.onCall = () => answered++;
    expect(fa.call(p.x, p.z)).toBe(true);
    expect(answered).toBe(1);
    expect(fa.called).toBe(true);

    // it walks over (no teleport: never more than a gallop's worth per frame)
    let last = { x: beast.x, z: beast.z };
    let maxStep = 0;
    let t = 0;
    run(fa, f, 45, () => {
      t += f.dt;
      maxStep = Math.max(maxStep, Math.hypot(beast.x - last.x, beast.z - last.z));
      last = { x: beast.x, z: beast.z };
      return Math.hypot(beast.x - p.x, beast.z - p.z) < 2.9 && t > 1;
    });
    run(fa, f, 2);
    const d1 = Math.hypot(beast.x - p.x, beast.z - p.z);
    expect(d1).toBeLessThan(MOUNT_REACH);
    expect(d1).toBeGreaterThan(1.6);
    expect(maxStep).toBeLessThan(0.6);
    expect(fa.called).toBe(true);

    // running right by it does not send it off while it waits
    f.player.running = true;
    f.player.speed = 9;
    run(fa, f, 5);
    expect(Math.hypot(beast.x - p.x, beast.z - p.z)).toBeLessThan(MOUNT_REACH);
    f.player.running = false;
    f.player.speed = 0;

    // and it can be got on like any other
    expect(fa.nearestRideable(p.x, p.z)).toBe(beast);

    // after the wait it goes back to its own business
    run(fa, f, 40);
    expect(fa.called).toBe(false);
  });

  it('is over once the called beast is ridden', () => {
    const { fa, f, beast } = setup();
    const p = f.player.pos;
    fa.call(p.x, p.z);
    run(fa, f, 45, () => Math.hypot(beast.x - p.x, beast.z - p.z) < MOUNT_REACH);
    // the key cap goes over its back
    const at = { x: 0, y: 0, z: 0 };
    fa.rideMark(fa.nearestRideable(p.x, p.z), at);
    expect([at.x, at.z]).toEqual([beast.x, beast.z]);
    expect(at.y).toBeGreaterThan(0.8);
    expect(fa.mount(fa.nearestRideable(p.x, p.z))).toBe(true);
    expect(fa.called).toBe(false);
    fa.dismount();
    expect(fa.mounted).toBe(false);
  });

  it('gives up when the caller goes far off', () => {
    const { fa, f } = setup();
    fa.call(f.player.pos.x, f.player.pos.z);
    f.player.pos.x += 900;
    run(fa, f, 1);
    expect(fa.called).toBe(false);
  });
});
