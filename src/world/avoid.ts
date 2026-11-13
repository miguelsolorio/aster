// Keeping the creatures that walk the ground out of the things the wanderer bumps into: the
// stones and bones of a site, a city's props, its buildings. They ask the same solid world as the
// wanderer does, through one callback the game hands them. Nothing here allocates.

/**
 * Absolute height of the top of whatever solid stands over (x, z) for feet at height y (things
 * overhead left out), or -Infinity on open ground. The same question the wanderer's roof asks.
 */
export type SolidQuery = (x: number, z: number, y: number) => number;

/**
 * Creatures do not climb onto things the way the wanderer does: anything rising more than this
 * above their feet stands in their way. (A paving stone or a sill is walked over; a step is not.)
 */
export const CREATURE_STEP = 0.4;

/** Something stands in the way at (x, z) for feet at height y. */
export function blockedAt(q: SolidQuery, x: number, z: number, y: number, step = CREATURE_STEP): boolean {
  return q(x, z, y) > y + step;
}

/**
 * Whether a body of radius r can move to (x, z) heading along the unit (ux, uz): its feet there,
 * the front of it a body's width ahead, and (for a long stride) the point halfway, so a quick
 * animal does not jump clean over a thin post.
 */
export function clearAt(q: SolidQuery, x: number, z: number, y: number, ux: number, uz: number, r: number, len: number, step = CREATURE_STEP): boolean {
  if (q(x, z, y) > y + step) return false;
  if (q(x + ux * r, z + uz * r, y) > y + step) return false;
  if (len > r && q(x - ux * len * 0.5, z - uz * len * 0.5, y) > y + step) return false;
  return true;
}

/** What steer() decided. */
export const steered = {
  /** Where to be after the move. */
  x: 0,
  z: 0,
  /** How far the heading was turned to find a way (yaw, radians; 0 straight on). */
  turn: 0,
  /** The side that cleared (+1 or -1), worth keeping so the next obstacle is passed the same way. */
  side: 1,
  /** Something was in the way. */
  hit: false,
};

// Turns tried, smallest first, each to the preferred side and then the other. The last is a little
// past square, which lets a body back off a corner it walked into.
const TURNS = [0.35, 0.7, 1.05, 1.4, 1.75];

/**
 * Moves a body of radius r from (x, z) by (mx, mz) without walking into a solid. Straight on if the
 * way is clear; otherwise turned aside (yaw + side * angle) as little as clears it, keeping to
 * `side` when both would do, so it walks round a post instead of dithering in front of it. With
 * nowhere to go it stays put. A body already standing in something is let out unhindered, so it
 * never sticks. Yaw here is atan2(x, z): a heading of yaw moves along (sin yaw, cos yaw).
 * Writes the result to `steered`; returns steered.hit.
 */
export function steer(q: SolidQuery, x: number, z: number, y: number, mx: number, mz: number, r: number, side: number, maxTurns = TURNS.length, step = CREATURE_STEP): boolean {
  const s = steered;
  s.x = x + mx;
  s.z = z + mz;
  s.turn = 0;
  s.side = side >= 0 ? 1 : -1;
  s.hit = false;
  const len = Math.sqrt(mx * mx + mz * mz);
  if (len < 1e-6) return false;
  if (q(x, z, y) > y + step) return false; // already inside: walk out
  const ux = mx / len;
  const uz = mz / len;
  if (clearAt(q, s.x, s.z, y, ux, uz, r, len, step)) return false;
  s.hit = true;
  const n = Math.min(maxTurns, TURNS.length);
  for (let k = 0; k < n; k++) {
    const a = TURNS[k];
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let t = 0; t < 2; t++) {
      const sd = t === 0 ? s.side : -s.side;
      // turn the heading by sd * a: (sin(Y + b), cos(Y + b)) from (sin Y, cos Y)
      const rx = ux * ca + uz * sa * sd;
      const rz = uz * ca - ux * sa * sd;
      const nx = x + rx * len;
      const nz = z + rz * len;
      if (!clearAt(q, nx, nz, y, rx, rz, r, len, step)) continue;
      s.x = nx;
      s.z = nz;
      s.turn = sd * a;
      s.side = sd;
      return true;
    }
  }
  s.x = x;
  s.z = z;
  return true;
}
