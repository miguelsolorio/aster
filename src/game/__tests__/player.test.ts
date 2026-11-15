import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SurfaceSample, World } from '../contract';
import { Player, type PlayerInput } from '../player';

/** Bare rock rising along +z at a fixed pitch (rise over run). */
const rock = (slope: number): World => ({
  seed: 1,
  height: (_x, z) => z * slope,
  sample: (_x, z, out: SurfaceSample) => {
    out.h = z * slope;
    out.rock = 1;
    out.salt = 0;
    return out;
  },
  normal: (_x, _z, out: THREE.Vector3) => out.set(0, 1, -slope).normalize(),
});

const input = (over: Partial<PlayerInput> = {}): PlayerInput => ({ x: 0, z: 0, run: false, jump: false, lift: false, drop: false, wind: new THREE.Vector2(1, 0), ...over });
const ev = { step() {}, jump() {}, land() {} };
// (camera yaw PI looks along +z, so "forward" is up the slope)
const walk = (p: Player, seconds: number, over: Partial<PlayerInput> = {}) => {
  for (let i = 0; i < seconds * 60; i++) p.update(1 / 60, input({ z: 1, ...over }), Math.PI, ev);
};

describe('nailed boots', () => {
  it('are quicker over level rock', () => {
    const bare = new Player(rock(0));
    const shod = new Player(rock(0));
    shod.boots = true;
    for (const p of [bare, shod]) {
      p.place(0, 0);
      walk(p, 4);
    }
    expect(bare.state.pos.z).toBeGreaterThan(10);
    expect(shod.state.pos.z).toBeGreaterThan(bare.state.pos.z * 1.2);
  });

  it('hold on rock too steep for bare feet, at a walk even when running', () => {
    const bare = new Player(rock(1.3));
    const shod = new Player(rock(1.3));
    shod.boots = true;
    for (const p of [bare, shod]) {
      p.place(0, 0);
      walk(p, 3, { run: true });
    }
    expect(bare.state.pos.z).toBeLessThan(0.5);
    expect(shod.state.pos.z).toBeGreaterThan(5);
    expect(shod.state.pos.z).toBeLessThan(3 * 4.3);
  });

  it('give up where the rock is steeper still', () => {
    const shod = new Player(rock(1.7));
    shod.boots = true;
    shod.place(0, 0);
    walk(shod, 3);
    expect(shod.state.pos.z).toBeLessThan(0.5);
  });
});

describe('an eagle feather', () => {
  /** Height lost over a few seconds of gliding forward, from high above level ground. */
  const sink = (feather: boolean) => {
    const p = new Player(rock(0));
    p.feather = feather;
    p.place(0, 0);
    p.update(1 / 60, input({ z: 1, jump: true, lift: true }), Math.PI, ev);
    // hold the climb for a second, then let go and glide
    for (let i = 0; i < 60; i++) p.update(1 / 60, input({ z: 1, lift: true }), Math.PI, ev);
    for (let i = 0; i < 90; i++) p.update(1 / 60, input({ z: 1 }), Math.PI, ev);
    expect(p.gliding).toBe(true);
    const y0 = p.state.pos.y;
    for (let i = 0; i < 60; i++) p.update(1 / 60, input({ z: 1 }), Math.PI, ev);
    return y0 - p.state.pos.y;
  };

  it('slows the sink of a glide', () => {
    const plain = sink(false);
    const light = sink(true);
    expect(plain).toBeGreaterThan(1);
    expect(light).toBeLessThan(plain * 0.75);
    expect(light).toBeGreaterThan(0);
  });
});
