import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DayCycle, FILM_KEYS, KEY_ELEVATIONS, hexV } from '../daycycle';
import { strideLength } from '../player';
import type { Uniforms } from '../contract';

const make = (start: number, length = 100) => {
  const u: Uniforms = {};
  return { u, d: new DayCycle(u, start, length) };
};

describe('hexV', () => {
  it('parses hex to 0..1 floats', () => {
    const v = hexV('#ff8000');
    expect(v.x).toBeCloseTo(1);
    expect(v.y).toBeCloseTo(128 / 255);
    expect(v.z).toBe(0);
  });
});

describe('FILM_KEYS', () => {
  it('are ordered by elevation and match KEY_ELEVATIONS', () => {
    expect(FILM_KEYS.map((k) => k.el)).toEqual([...KEY_ELEVATIONS]);
    for (let i = 1; i < FILM_KEYS.length; i++) expect(FILM_KEYS[i].el).toBeGreaterThan(FILM_KEYS[i - 1].el);
  });
});

describe('DayCycle', () => {
  it('wraps day into 0..1', () => {
    const { d } = make(0.9);
    d.update(20); // 0.2 of a day
    expect(d.day).toBeCloseTo(0.1);
  });

  it('is bright at noon and dark at midnight', () => {
    const noon = make(0.5).d;
    const midnight = make(0).d;
    expect(noon.night).toBe(0);
    expect(midnight.night).toBeCloseTo(1);
    expect(noon.sunDir.y).toBeGreaterThan(0.5);
    expect(midnight.sunDir.y).toBeLessThan(0);
  });

  it('lights from the moon at night and never from below', () => {
    const { d } = make(0);
    expect(d.lightDir.y).toBeGreaterThanOrEqual(0.05 / 1.1);
    expect(d.lightDir.length()).toBeCloseTo(1);
    const { u } = make(0);
    expect((u.uStars.value as number)).toBeGreaterThan(0.9);
  });

  it('writes uniforms and uses the sun by day', () => {
    const { u, d } = make(0.5);
    expect((u.uSunDir.value as THREE.Vector3).distanceTo(d.sunDir)).toBeLessThan(1e-6);
    expect(u.uStars.value).toBe(0);
    expect(u.uNight.value).toBe(0);
  });
});

describe('strideLength', () => {
  it('walks at a fixed stride and lengthens when running fast', () => {
    expect(strideLength(3, false)).toBe(0.8);
    expect(strideLength(5, true)).toBe(1.15);
    expect(strideLength(20, true)).toBeCloseTo(20 / 8.3);
  });
});
