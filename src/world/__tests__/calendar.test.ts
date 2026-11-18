import { describe, expect, it } from 'vitest';
import { MONTH, moonPhase } from '../sky';
import { FESTIVAL_NIGHT, FLOOD_NIGHT, MARKET_DAYS, almanacLines, dayName, daysUntil, festival, flood, market, migration, migrationBearing, monthDay } from '../calendar';

describe('the month', () => {
  it('is counted from the new moon, with the full moon half way', () => {
    for (let n = 0; n < MONTH * 2; n++) expect(monthDay(n) / MONTH).toBe(moonPhase(n));
    expect(FLOOD_NIGHT).toBe(0);
    expect(FESTIVAL_NIGHT).toBe(MONTH / 2);
  });

  it('counts the days to what is coming', () => {
    expect(daysUntil(2, MARKET_DAYS)).toBe(0);
    expect(daysUntil(3, MARKET_DAYS)).toBe(3);
    expect(daysUntil(7, [FLOOD_NIGHT])).toBe(1);
    expect(daysUntil(1, [FLOOD_NIGHT])).toBe(7);
  });
});

/** A clock whose day number falls on month day `md`, at time of day `day`. */
const at = (md: number, day: number): [number, number] => [md - 3 + MONTH + day, day];

describe('what each day brings', () => {
  it('holds a market by day on the half moons only', () => {
    expect(market(...at(2, 0.5))).toBe(1);
    expect(market(...at(6, 0.5))).toBe(1);
    expect(market(...at(2, 0.1))).toBe(0);
    expect(market(...at(3, 0.5))).toBe(0);
  });

  it('keeps the festival and the flood for one whole night each, across midnight', () => {
    // the night of month day 4 runs from the dusk before its midnight to the dawn after
    expect(festival(...at(3, 0.9))).toBe(1);
    expect(festival(...at(4, 0.1))).toBe(1);
    expect(festival(...at(4, 0.5))).toBe(0);
    expect(festival(...at(4, 0.9))).toBe(0);
    expect(flood(...at(7, 0.9))).toBe(1);
    expect(flood(...at(0, 0.1))).toBe(1);
    expect(flood(...at(0, 0.5))).toBe(0);
  });

  it('moves the herds by day, out one month and back the next', () => {
    expect(migration(...at(5, 0.5))).toBe(1);
    expect(migration(...at(5, 0.05))).toBe(0);
    expect(migration(...at(4, 0.5))).toBe(0);
    expect(Math.abs(migrationBearing(0) - migrationBearing(1))).toBeCloseTo(Math.PI);
  });

  it('names the days on the almanac and has something to say on every one', () => {
    expect(dayName(0)).toBe('flood');
    expect(dayName(4)).toBe('lanterns');
    expect(dayName(1)).toBe('');
    for (let md = 0; md < MONTH; md++) expect(almanacLines(md).length).toBeGreaterThanOrEqual(2);
  });
});
