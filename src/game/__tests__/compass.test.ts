import { describe, expect, it } from 'vitest';
import { bearingDeg, headingDeg, nearest, turnDeg } from '../compass';

describe('compass', () => {
  it('reads the eye looking north at no turn, and east a quarter turn to the right', () => {
    expect(headingDeg(0)).toBeCloseTo(0);
    // the eye looks along (-sin yaw, -cos yaw): at -90 degrees that is +x, which is east
    expect(headingDeg(-Math.PI / 2)).toBeCloseTo(90);
    expect(headingDeg(Math.PI)).toBeCloseTo(180);
    expect(headingDeg(Math.PI / 2)).toBeCloseTo(270);
  });

  it('keeps a heading between 0 and 360 however far the eye has turned', () => {
    expect(headingDeg(-Math.PI / 2 - 6 * Math.PI)).toBeCloseTo(90);
    expect(headingDeg(Math.PI / 2 + 6 * Math.PI)).toBeCloseTo(270);
    for (const yaw of [-40, -0.001, 0, 0.001, 40]) {
      const h = headingDeg(yaw);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('has north at -z and east at +x, as the map does', () => {
    expect(bearingDeg(0, 0, 0, -10)).toBeCloseTo(0);
    expect(bearingDeg(0, 0, 10, 0)).toBeCloseTo(90);
    expect(bearingDeg(0, 0, 0, 10)).toBeCloseTo(180);
    expect(bearingDeg(0, 0, -10, 0)).toBeCloseTo(270);
    expect(bearingDeg(5, 5, 15, -5)).toBeCloseTo(45);
  });

  it('turns the short way round', () => {
    expect(turnDeg(10, 350)).toBeCloseTo(20);
    expect(turnDeg(350, 10)).toBeCloseTo(-20);
    expect(turnDeg(90, 0)).toBeCloseTo(90);
    expect(turnDeg(0, 90)).toBeCloseTo(-90);
    expect(turnDeg(180, 0)).toBeCloseTo(-180);
  });

  it('picks the nearest places, nearest first', () => {
    const got = nearest([100, 0, 5, 5, -30, 0, 0, 1], 0, 0, 3, 'mark', 25);
    expect(got.map((t) => [t.x, t.z])).toEqual([
      [0, 1],
      [5, 5],
      [-30, 0],
    ]);
    expect(got[0]).toMatchObject({ kind: 'mark', r: 25 });
    expect(nearest([], 0, 0, 3, 'mark', 25)).toEqual([]);
    expect(nearest([1, 2, 3], 0, 0, 3, 'mark', 25)).toHaveLength(1);
  });
});
