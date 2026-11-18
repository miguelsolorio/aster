// Bringing a place back. Three kinds of place stand empty until the wanderer carries something
// to them: water to a hamlet's dry well, a flame to a watchtower's cold beacon, date stones to
// the wet ground below a spring. What is carried is picked up at another kind of place, so each
// restoration joins two finds. Nothing is lost by waiting and nothing can go wrong.
//
// A place comes back in stages, worked out from the world clock and the day it was restored, so
// only that day is saved.

import type { FindKind } from './finds';

/** What the wanderer can be carrying toward a restoration: one of each at most. */
export type Carry = 'water' | 'flame' | 'seed';
export const CARRIES: Carry[] = ['water', 'flame', 'seed'];

/** The kinds of place that can be brought back. */
export type Revivable = 'hamlet' | 'watchtower' | 'spring';
export const REVIVABLE: Revivable[] = ['hamlet', 'watchtower', 'spring'];

export function isRevivable(k: unknown): k is Revivable {
  return typeof k === 'string' && (REVIVABLE as string[]).includes(k);
}

export function isCarry(k: unknown): k is Carry {
  return typeof k === 'string' && (CARRIES as string[]).includes(k);
}

/** What each place wants carried to it. */
export const WANTS: Record<Revivable, Carry> = { hamlet: 'water', watchtower: 'flame', spring: 'seed' };

/** One place brought back: which, where, and the world clock (in-game days) when it was done. */
export interface Revived {
  key: number;
  kind: Revivable;
  x: number;
  z: number;
  day: number;
}

/** In-game days after the restoring at which each later stage begins. Stage 1 begins at once. */
const STAGES: Record<Revivable, number[]> = {
  // water in the well; people in the houses; caravans calling
  hamlet: [0, 1, 2],
  // the beacon lit; a keeper in the hut
  watchtower: [0, 1],
  // seedlings; young palms; a grove
  spring: [0, 1, 3],
};

/** The last stage a kind reaches. */
export function lastStage(kind: Revivable): number {
  return STAGES[kind].length;
}

/**
 * How far along a restored place is: 1 the moment it is restored, rising as days pass, up to
 * lastStage(kind). 0 is a place nobody has touched, which this never returns.
 */
export function stageOf(kind: Revivable, day: number, clock: number): number {
  const since = clock - day;
  const at = STAGES[kind];
  let s = 1;
  for (let i = 1; i < at.length; i++) if (since >= at[i]) s = i + 1;
  return s;
}

/** Where a carried thing is picked up: the kinds of find that give it. Water also comes from any river or pool. */
export const SOURCES: Record<Exclude<Carry, 'water'>, FindKind[]> = {
  flame: ['lantern'],
  seed: ['grove', 'oasis'],
};

/** How near the middle of a source the wanderer must stand to take from it (m). */
export const TAKE_R = 30;

/** How near the well, the tower's door or the spring's lip the wanderer must stand to give (m). */
export const GIVE_R: Record<Revivable, number> = { hamlet: 5, watchtower: 9, spring: 60 };

/** A caravan party camps this far from a hamlet that has come back (m). */
export const CAMP_OFF = 46;

// ---------------------------------------------------------------- what the wanderer reads

/** Said at an empty place by someone carrying nothing it wants. */
export const NEEDS: Record<Revivable, string> = {
  hamlet: 'The well is dry. Water would have to be carried here.',
  watchtower: 'The beacon is cold. It wants a flame from a lantern tower.',
  spring: 'Wet ground, and nothing growing. It wants date stones.',
};

/** Said on picking a thing up. */
export const TAKEN: Record<Carry, string> = {
  water: 'You fill the waterskin.',
  flame: 'You take a flame from the lantern.',
  seed: 'You pocket a handful of date stones.',
};

/** Said the moment a place is brought back. */
export const DONE: Record<Revivable, string> = {
  hamlet: 'Water stands in the well again. Someone will notice.',
  watchtower: 'The beacon catches. It will be seen a long way off.',
  spring: 'Planted. Give them a few days.',
};

/** What the people who moved into a hamlet say. */
export const SETTLER = [
  'We saw water in the well and stopped. Was that you?',
  'Nobody remembers who left, or why.',
  'The roofs were sound. We only had to sweep.',
  'The caravans call here now. They did not before.',
  'One well is enough, if someone keeps it.',
];

/** What the keeper of a relit tower says. */
export const KEEPER_OF_FLAME = [
  'A lit tower needs a keeper, so here I am.',
  'I saw it burning from two days off and walked toward it.',
  'From the top I can see three days of sand.',
  'It goes out if nobody feeds it. I feed it.',
];
