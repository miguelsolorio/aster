import { describe, expect, it } from 'vitest';
import { ASS_GALLOP, BOARD, BOOTS, CAMEL_GALLOP, flightSpeed, ORYX_GALLOP, RUN, RUN_SAND } from '../speeds';

describe('the speed ladder', () => {
  it('climbs: on foot, a board, flying, an animal, a carpet', () => {
    const rungs = [RUN_SAND, RUN, RUN * BOOTS, BOARD, flightSpeed(false), CAMEL_GALLOP, ASS_GALLOP, ORYX_GALLOP, flightSpeed(true)];
    for (let i = 1; i < rungs.length; i++) expect(rungs[i], `rung ${i}`).toBeGreaterThan(rungs[i - 1]);
  });

  it('makes a board a real step up from going on foot', () => {
    expect(BOARD).toBeGreaterThan(RUN * BOOTS * 1.4);
  });

  it('keeps the quickest thing under the most anything is let go', () => {
    expect(flightSpeed(true)).toBeLessThan(60);
  });
});
