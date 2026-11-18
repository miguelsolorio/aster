import { describe, expect, it } from 'vitest';
import { ASS_GALLOP, BOARD, BOARD_BOOST, BOOTS, CAMEL_GALLOP, flightSpeed, ORYX_GALLOP, RIDE, RUN, RUN_SAND, WALK } from '../speeds';

const climbs = (speeds: number[]) => {
  for (let i = 1; i < speeds.length; i++) expect(speeds[i], `rung ${i}`).toBeGreaterThan(speeds[i - 1]);
};

describe('the speed ladder', () => {
  it('climbs at the easy pace: on foot, a board, flying, an animal, a carpet', () => {
    climbs([WALK, WALK * BOOTS, BOARD, flightSpeed(false, false), RIDE, flightSpeed(true, false)]);
  });

  it('climbs with Shift in the same order, whichever animal it is', () => {
    climbs([WALK, RUN_SAND, RUN, RUN * BOOTS, BOARD_BOOST, flightSpeed(false, true), CAMEL_GALLOP, ASS_GALLOP, ORYX_GALLOP, flightSpeed(true, true)]);
  });

  it('makes a board a real step up from going on foot', () => {
    expect(BOARD).toBeGreaterThan(WALK * 2);
    expect(BOARD_BOOST).toBeGreaterThan(RUN * BOOTS * 1.4);
  });

  it('is quicker with Shift on every rung', () => {
    expect(BOARD_BOOST).toBeGreaterThan(BOARD);
    expect(flightSpeed(false, true)).toBeGreaterThan(flightSpeed(false, false));
    expect(CAMEL_GALLOP).toBeGreaterThan(RIDE);
    expect(flightSpeed(true, true)).toBeGreaterThan(flightSpeed(true, false));
  });
});
