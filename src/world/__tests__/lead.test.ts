import { describe, expect, it } from 'vitest';
import { leadPoint } from '../lead';

describe('leadPoint', () => {
  const out = { x: 0, z: 0 };

  it('is the point itself when standing still', () => {
    expect(leadPoint(10, -20, 0, 0, 5, 300, out)).toEqual({ x: 10, z: -20 });
  });

  it('runs ahead along the velocity', () => {
    expect(leadPoint(0, 0, 10, 0, 5, 300, out)).toEqual({ x: 50, z: 0 });
    expect(leadPoint(100, 100, 0, -4, 2, 300, out)).toEqual({ x: 100, z: 92 });
  });

  it('never runs further ahead than the cap', () => {
    leadPoint(0, 0, 72, 0, 5, 300, out);
    expect(out.x).toBeCloseTo(300);
    leadPoint(5, 5, 30, 40, 100, 300, out);
    expect(Math.hypot(out.x - 5, out.z - 5)).toBeCloseTo(300);
    expect(out.x - 5).toBeCloseTo(180);
  });

  it('stays put on a velocity that is not a number', () => {
    expect(leadPoint(3, 4, NaN, 1, 5, 300, out)).toEqual({ x: 3, z: 4 });
  });
});
