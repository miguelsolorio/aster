import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SurfaceSample, World } from '../contract';
import { Player, type PlayerInput } from '../player';
import { BOARD, flightSpeed, RUN } from '../speeds';

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

const input = (over: Partial<PlayerInput> = {}): PlayerInput => ({ x: 0, z: 0, jump: false, lift: false, drop: false, wind: new THREE.Vector2(1, 0), ...over });
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

  it('hold on rock too steep for bare feet, at a walk', () => {
    const bare = new Player(rock(1.3));
    const shod = new Player(rock(1.3));
    shod.boots = true;
    for (const p of [bare, shod]) {
      p.place(0, 0);
      walk(p, 3);
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

describe('speed over the pace', () => {
  it('goes on gathering on a board run downhill', () => {
    const p = new Player(rock(-0.3));
    p.board = true;
    p.place(0, 0);
    walk(p, 30);
    expect(p.state.speed).toBeGreaterThan(BOARD * 1.4);
  });

  it('is not had on the flat: a board holds its pace', () => {
    const p = new Player(rock(0));
    p.board = true;
    p.place(0, 0);
    walk(p, 30);
    expect(p.state.speed).toBeGreaterThan(BOARD * 0.9);
    expect(p.state.speed).toBeLessThanOrEqual(BOARD);
  });

  it('is kept a while in flight after a fast launch', () => {
    const p = new Player(rock(0));
    p.place(0, 0);
    p.update(1 / 60, input({ z: 1, jump: true, lift: true }), Math.PI, ev);
    for (let i = 0; i < 60; i++) p.update(1 / 60, input({ z: 1, lift: true }), Math.PI, ev);
    p.state.vel.set(0, 0, 55);
    for (let i = 0; i < 60; i++) p.update(1 / 60, input({ z: 1 }), Math.PI, ev);
    expect(p.state.grounded).toBe(false);
    expect(p.state.speed).toBeGreaterThan(flightSpeed(false) + 15);
    expect(p.state.speed).toBeLessThan(55);
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

describe('a board', () => {
  const rider = (slope: number) => {
    const p = new Player(rock(slope));
    p.board = true;
    p.place(0, 0);
    return p;
  };
  const rest = (p: Player, seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) p.update(1 / 60, input(), Math.PI, ev);
  };

  it('rides level rock as it rides sand, faster than feet walk it', () => {
    const p = rider(0);
    walk(p, 8);
    expect(p.state.sliding).toBe(true);
    expect(p.state.speed).toBeGreaterThan(BOARD * 0.9);
    expect(p.state.speed).toBeLessThanOrEqual(BOARD);
  });

  it('rides up a mountainside', () => {
    const p = rider(0.8);
    walk(p, 4);
    expect(p.state.grounded).toBe(true);
    expect(p.state.pos.z).toBeGreaterThan(15);
    expect(p.state.pos.y).toBeCloseTo(p.state.pos.z * 0.8, 3);
  });

  it('rides up a cliff no feet could stand on, no faster than it can climb', () => {
    const p = rider(3);
    walk(p, 3);
    expect(p.state.grounded).toBe(true);
    expect(p.state.pos.y).toBeGreaterThan(20);
    expect(p.state.pos.y).toBeLessThan(3 * 24 + 0.5);
  });

  it('spends speed carried into a cliff rather than rocketing up it', () => {
    const p = rider(3);
    p.state.vel.set(0, 0, 48);
    walk(p, 1);
    expect(p.state.grounded).toBe(true);
    expect(p.state.pos.y).toBeLessThan(60);
  });

  it('comes to rest on rock feet could stand on, and stays', () => {
    const p = rider(0.8);
    walk(p, 2);
    rest(p, 5);
    const z = p.state.pos.z;
    expect(p.state.speed).toBeLessThan(0.05);
    rest(p, 3);
    expect(p.state.pos.z).toBeCloseTo(z, 2);
  });

  it('slips back down a cliff when let go, unless there is a rope to hold it', () => {
    const loose = rider(3);
    const roped = rider(3);
    roped.rope = true;
    for (const p of [loose, roped]) {
      walk(p, 2);
      rest(p, 4);
    }
    expect(loose.state.pos.z).toBeLessThan(0);
    expect(roped.state.pos.z).toBeGreaterThan(3);
    expect(roped.state.speed).toBeLessThan(0.05);
  });

  it('is held at rest on rock too steep for bare feet by nailed boots', () => {
    const bare = rider(1.3);
    const shod = rider(1.3);
    shod.boots = true;
    for (const p of [bare, shod]) {
      walk(p, 2);
      rest(p, 5);
    }
    expect(shod.state.speed).toBeLessThan(0.05);
    expect(bare.state.pos.z).toBeLessThan(shod.state.pos.z - 5);
  });

  it('starts up a steep sand face from a standstill', () => {
    const sand = rock(0.6);
    const p = new Player({
      ...sand,
      sample: (x, z, out) => {
        sand.sample(x, z, out).rock = 0;
        return out;
      },
    });
    p.board = true;
    p.place(0, 0);
    walk(p, 3);
    expect(p.state.onRock).toBe(0);
    expect(p.state.pos.z).toBeGreaterThan(10);
  });

  it('is still stopped by what stands on steep ground', () => {
    const p = rider(2);
    p.roof = (_x, z) => (z > 6 && z < 7 ? z * 2 + 4 : -Infinity);
    walk(p, 4);
    expect(p.state.pos.z).toBeLessThan(6);
  });

  it('is walked underground', () => {
    const p = rider(0);
    p.floor = () => 0;
    walk(p, 4);
    expect(p.riding).toBe(false);
    expect(p.state.sliding).toBe(false);
    expect(p.state.pos.z).toBeLessThan(4 * RUN * 1.02);
  });
});
