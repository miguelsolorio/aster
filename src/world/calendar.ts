// The calendar: what the desert does on each day of the moon's month. It is built on the sky's
// month (sky.ts) and the world clock, so nothing here is saved, and anyone who watches the moon
// can tell what is coming.
//
// The month is counted from the new moon:
//   0  new moon       the salt pans flood for the night, and hold the stars
//   2  first quarter  market day in the cities
//   4  full moon      the lantern festival, from dusk to dawn
//   5, 6              the herds are on the move
//   6  last quarter   market day again

import { MONTH, dayOf, nightOf } from './sky';

const mod = (a: number, n: number): number => ((a % n) + n) % n;
const ramp = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The day of the month a day or a night falls on: 0 the new moon, 4 the full. */
export function monthDay(n: number): number {
  return mod(n + 3, MONTH);
}

/** Which month a day falls in, counted from the first. */
export function monthOf(n: number): number {
  return Math.floor((n + 3) / MONTH);
}

export const MARKET_DAYS = [2, 6];
export const FESTIVAL_NIGHT = 4;
export const FLOOD_NIGHT = 0;
export const MIGRATION_DAYS = [5, 6];

/** How much of a market there is now, 0..1: on its days, from the morning to the end of the afternoon. */
export function market(clock: number, day: number): number {
  if (!MARKET_DAYS.includes(monthDay(dayOf(clock, day)))) return 0;
  return ramp(0.27, 0.32, day) * (1 - ramp(0.7, 0.76, day));
}

/** A night's strength at this hour: up through dusk, down through dawn. */
const through = (day: number): number => (day >= 0.5 ? ramp(0.76, 0.82, day) : 1 - ramp(0.2, 0.26, day));

/** How far into the lantern festival the night is, 0..1: the night of the full moon. */
export function festival(clock: number, day: number): number {
  return monthDay(nightOf(clock, day)) === FESTIVAL_NIGHT ? through(day) : 0;
}

/** How deep the salt pans stand in water, 0..1: the night of the new moon. */
export function flood(clock: number, day: number): number {
  return monthDay(nightOf(clock, day)) === FLOOD_NIGHT ? through(day) : 0;
}

/** Whether the herds are travelling today, 0..1: on their days, while it is light. */
export function migration(clock: number, day: number): number {
  if (!MIGRATION_DAYS.includes(monthDay(dayOf(clock, day)))) return 0;
  return ramp(0.24, 0.3, day) * (1 - ramp(0.74, 0.8, day));
}

/** The way the herds go in a month, as a bearing in radians (x = cos, z = sin): out one month, back the next. */
export function migrationBearing(month: number): number {
  return 0.9 + (mod(month, 2) === 0 ? 0 : Math.PI);
}

/** What a day of the month is called on the almanac, '' for a plain day. */
export function dayName(md: number): string {
  return md === FLOOD_NIGHT ? 'flood' : md === FESTIVAL_NIGHT ? 'lanterns' : MARKET_DAYS.includes(md) ? 'market' : md === MIGRATION_DAYS[0] ? 'herds' : '';
}

/** Days from this day of the month until the next of `days` (0 if today is one). */
export function daysUntil(md: number, days: readonly number[]): number {
  let best = MONTH;
  for (const d of days) best = Math.min(best, mod(d - md, MONTH));
  return best;
}

// ---------------------------------------------------------------- what people say about it

const IN = (n: number): string => (n === 1 ? 'tomorrow' : `in ${['', '', 'two', 'three', 'four', 'five', 'six', 'seven'][n]} days`);

/** One thing a townsperson might say about the calendar on this day of the month. */
export function almanacLines(md: number): string[] {
  const out: string[] = [];
  const m = daysUntil(md, MARKET_DAYS);
  out.push(m === 0 ? 'Market day. Mind your feet.' : `Market is ${IN(m)}. It always falls on a half moon.`);
  const f = daysUntil(md, [FESTIVAL_NIGHT]);
  out.push(f === 0 ? 'Lanterns tonight. Stay for it.' : f <= 3 ? `The moon is nearly full. Lanterns ${IN(f)}.` : 'We send the lanterns up when the moon is full.');
  const n = daysUntil(md, [FLOOD_NIGHT]);
  if (n <= 2) out.push(n === 0 ? 'No moon tonight. The salt pans will be standing in water.' : 'When the moon is gone the salt pans flood. Go and stand on one.');
  if (MIGRATION_DAYS.includes(md)) out.push('The herds are moving. They go the day after the lanterns, every month.');
  return out;
}
