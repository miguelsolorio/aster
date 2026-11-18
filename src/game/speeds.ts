// How fast each way of getting about goes, in metres a second over level ground.
//
// They climb a ladder, slowest to fastest: on foot, a board, flying, a ridden animal, a carpet.
// Each has an easy pace and a quicker one with Shift, and both climb the ladder in that order:
// the easy paces among themselves, and the Shift paces among themselves. Nailed boots are part
// of going on foot and stay under the board. speeds.test.ts holds the order.

/** On foot, on any ground. */
export const WALK = 7;
/** On foot with Shift, on rock. */
export const RUN = 13;
/** On foot with Shift in sand: soft ground, hard going. */
export const RUN_SAND = 10.5;
/** Nailed boots are this much quicker over rock. */
export const BOOTS = 1.25;

/** A board driven over the flat. A slope gives more, or takes some. */
export const BOARD = 16;
export const BOARD_BOOST = 24;

/** Forward speed in flight without a carpet. */
export const GLIDE = 18;
export const GLIDE_BOOST = 28;

/** Any ridden animal at its easy pace. */
export const RIDE = 20;
/** Flat out, each to its build: a camel is the heaviest, an oryx the quickest. */
export const CAMEL_GALLOP = 34;
export const ASS_GALLOP = 36;
export const ORYX_GALLOP = 38;

/** A carpet flies this many times faster than flying without one. */
export const CARPET = 2;
/** And climbs for this many times as long. */
export const CARPET_LIFT = 2;

/** Forward speed in flight: a carpet is faster at the glide and at the boost alike. */
export function flightSpeed(carpet: boolean, boost: boolean): number {
  return (boost ? GLIDE_BOOST : GLIDE) * (carpet ? CARPET : 1);
}
