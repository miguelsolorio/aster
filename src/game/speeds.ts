// How fast each way of getting about goes, in metres a second over level ground.
//
// There is one pace for each, and no key to go faster: everything goes flat out. They climb a
// ladder, slowest to fastest: on foot, a board, flying, a ridden animal, a carpet. Nailed boots
// are part of going on foot and stay under the board. speeds.test.ts holds the order.

/** On foot, on rock. */
export const RUN = 13;
/** On foot in sand: soft ground, hard going. */
export const RUN_SAND = 10.5;
/** Nailed boots are this much quicker over rock. */
export const BOOTS = 1.25;

/** A board driven over the flat. A slope gives more, or takes some. */
export const BOARD = 30;

/** Forward speed in flight without a carpet. */
export const GLIDE = 33;

/** A ridden animal, each to its build: a camel is the heaviest, an oryx the quickest. */
export const CAMEL_GALLOP = 36;
export const ASS_GALLOP = 38;
export const ORYX_GALLOP = 40;

/** A carpet flies this many times faster than flying without one. */
export const CARPET = 1.8;
/** And climbs for this many times as long, */
export const CARPET_LIFT = 2;
/** this many times as fast, so a full climb on one rises about four times as high. */
export const CARPET_CLIMB = 2;

/** Forward speed in flight. */
export function flightSpeed(carpet: boolean): number {
  return GLIDE * (carpet ? CARPET : 1);
}
