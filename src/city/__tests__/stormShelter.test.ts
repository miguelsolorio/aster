import { describe, expect, it } from 'vitest';
import { Weather } from '../../world/weather';
import { STORM_HALT, stormHold } from '../caravans';
import { stormShelter } from '../people';

describe('a caravan in a storm', () => {
  it('halts above the threshold and goes on only once the storm is gone', () => {
    expect(stormHold(false, 0)).toBe(false);
    expect(stormHold(false, STORM_HALT - 0.01)).toBe(false);
    expect(stormHold(false, STORM_HALT + 0.01)).toBe(true);
    // a falling value does not restart it until it is back to nothing
    expect(stormHold(true, 0.1)).toBe(true);
    expect(stormHold(true, 0)).toBe(false);
  });

  it('holds when a storm is sent right over it', () => {
    const w = new Weather(1);
    const clock = 3.3;
    w.sent = w.aim(clock, 100, 200, -1);
    expect(stormHold(false, w.ahead(clock, 100, 200))).toBe(true);
    expect(stormHold(false, w.ahead(clock, 1e6, 1e6))).toBe(false);
  });
});

describe('a town in a storm', () => {
  it('stays put with no storm', () => {
    let s = 0;
    for (let i = 0; i < 100; i++) s = stormShelter(s, 0, 0.1);
    expect(s).toBe(0);
    expect(1 - s).toBe(1);
  });

  it('goes indoors over a few seconds, and comes back over ten', () => {
    let s = 0;
    for (let i = 0; i < 30; i++) s = stormShelter(s, 0.5, 0.1);
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(0.6);
    for (let i = 0; i < 40; i++) s = stormShelter(s, 0.5, 0.1);
    expect(s).toBe(1);
    for (let i = 0; i < 50; i++) s = stormShelter(s, 0, 0.1);
    expect(s).toBeCloseTo(0.5, 5);
    for (let i = 0; i < 60; i++) s = stormShelter(s, 0, 0.1);
    expect(s).toBe(0);
  });
});
