// What is left inside the temples. Each shrine has one tool lying on a stone before its altar,
// for whoever walks in to carry off. A temple gives once, and no two near each other start
// with the same thing, so gathering them all means visiting several.

import type { Tool } from './save';

/** The tools the temples hold. The pick, the board, the spyglass and the carpet are come by elsewhere. */
export const OFFERINGS = ['chart', 'flute', 'bedroll', 'rod', 'rope'] as const satisfies readonly Tool[];
export type Offering = (typeof OFFERINGS)[number];

/**
 * What a temple has on its stone: the first tool the wanderer lacks, counting on from where
 * this temple starts. Null once it has given, or when there is nothing left to want.
 */
export function offeringAt(key: number, has: (t: Offering) => boolean, emptied: boolean): Offering | null {
  if (emptied) return null;
  const n = OFFERINGS.length;
  // (a site key is its cell, x * 65536 + z: neighbours along either axis start somewhere different)
  const start = (((Math.floor(key / 65536) * 3 + (key % 65536) * 7) % n) + n) % n;
  for (let i = 0; i < n; i++) {
    const t = OFFERINGS[(start + i) % n];
    if (!has(t)) return t;
  }
  return null;
}
