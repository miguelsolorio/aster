import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { FrameState, SurfaceSample, World } from '../../game/contract';
import { Fauna } from '../fauna';
import { Weather } from '../weather';

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

function frame(weather: Weather): FrameState {
  return {
    dt: 0.05,
    time: 0,
    day: 0.4,
    night: 0,
    sunDir: new THREE.Vector3(0, 1, 0),
    lightDir: new THREE.Vector3(0, 1, 0),
    wind: new THREE.Vector2(1, 0),
    gust: 0,
    clock: 0,
    storm: 0,
    stormAhead: 0,
    rain: 0,
    wet: 0,
    stormDir: new THREE.Vector2(1, 0),
    weather,
    camera: new THREE.PerspectiveCamera(),
    player: { pos: new THREE.Vector3(), vel: new THREE.Vector3(), speed: 0, grounded: true, sliding: false, running: false, onRock: 0 },
  } as FrameState;
}

/** Animals out after settling for a while, with the weather the test dresses the frame (and the herd lookups) in. */
function census(rain: number, wet: number): number {
  const weather = new Weather(1);
  weather.rain = () => rain;
  weather.wetAt = () => wet;
  const f = frame(weather);
  f.rain = rain;
  f.wet = wet;
  const fa = new Fauna(flat, {});
  for (let t = 0; t < 8; t += f.dt) {
    f.time += f.dt;
    fa.update(f);
  }
  return fa.census().reduce((a, b) => a + b, 0);
}

describe('fauna after rain', () => {
  it('has more animals about on wet ground once the rain has stopped', () => {
    const dry = census(0, 0);
    expect(dry).toBeGreaterThan(0);
    expect(census(0, 0.9)).toBeGreaterThan(dry * 1.2);
  });

  it('brings none of the extra herds out while it is still raining', () => {
    expect(census(0.8, 0.9)).toBe(census(0, 0));
  });
});
