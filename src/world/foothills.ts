// The mountain villages: a street or two of mud-brick houses on the foot of each massif, where the
// sand begins to climb. Where they stand is decided from the world seed alone, so a village is
// always where it was; what they look like is built by the discoveries (buildMountainVillage).
import type { Massif } from './surface';

export interface FootVillage {
  x: number;
  z: number;
  /** Bearing of its street (radians, atan2(dz, dx)): along the contour of the slope. */
  yaw: number;
  /** Unit vector pointing up the slope there. */
  ux: number;
  uz: number;
}

/** What placing a village needs to know of the world. */
export interface FootWorld {
  height(x: number, z: number): number;
  river?(x: number, z: number): number;
}

/** Villages tried per massif: one to a sector of its foot. */
export const FOOT_VILLAGES = 2;
/** Where on the massif's radius a village may stand: from a little up the flank out onto the sand (all inside 1.25 radii, which the discoveries count on). */
const RING = [0.86, 0.94, 1.02, 1.1, 1.18];
/** Bearings tried either side of a sector's own (radians). */
const SWING = [-0.7, -0.47, -0.23, 0, 0.23, 0.47, 0.7];
/** Half the length of the street the ground is judged over (m). */
const REACH = 34;
/** The most the ground may rise across the street's width, and along its length (m): terraces take up the first, not the second. */
const MAX_ACROSS = 13;
const MAX_ALONG = 7;
/** Clear of a river's centre line by this much (m). */
const RIVER_CLEAR = 110;

const TAU = Math.PI * 2;

/**
 * The villages at the foot of a massif. `roll` is a number in 0..1 fixed for the massif (it turns
 * the sectors round); `free` says whether a spot is clear of everything else that stands in the
 * world (cities, finds, caves). A sector with no ground gentle enough is left empty.
 */
export function footVillages(world: FootWorld, m: Massif, roll: number, free: (x: number, z: number) => boolean): FootVillage[] {
  const out: FootVillage[] = [];
  const H = (x: number, z: number): number => world.height(x, z);
  for (let k = 0; k < FOOT_VILLAGES; k++) {
    const a0 = (roll + k / FOOT_VILLAGES) * TAU;
    let best = Infinity;
    let pick: FootVillage | null = null;
    for (const da of SWING) {
      for (const fr of RING) {
        const a = a0 + da;
        const x = m.x + Math.cos(a) * m.r * fr;
        const z = m.z + Math.sin(a) * m.r * fr;
        // the slope there: which way is up, and how steep
        const gx = (H(x + 12, z) - H(x - 12, z)) / 24;
        const gz = (H(x, z + 12) - H(x, z - 12)) / 24;
        const g = Math.hypot(gx, gz);
        // on dead level ground, "up" is toward the mountain
        const ux = g > 0.01 ? gx / g : -Math.cos(a);
        const uz = g > 0.01 ? gz / g : -Math.sin(a);
        const tx = -uz;
        const tz = ux;
        const h0 = H(x, z);
        const across = Math.abs(H(x + ux * 16, z + uz * 16) - H(x - ux * 16, z - uz * 16));
        let along = 0;
        for (const t of [-REACH, -REACH / 2, REACH / 2, REACH]) along = Math.max(along, Math.abs(H(x + tx * t, z + tz * t) - h0));
        if (across > MAX_ACROSS || along > MAX_ALONG) continue;
        if (
          world.river &&
          (world.river(x, z) < RIVER_CLEAR ||
            world.river(x + tx * REACH, z + tz * REACH) < RIVER_CLEAR ||
            world.river(x - tx * REACH, z - tz * REACH) < RIVER_CLEAR)
        )
          continue;
        if (!free(x, z)) continue;
        // gentle ground first, then the sector's own bearing, then close under the mountain
        const score = along * 1.6 + across * 0.5 + Math.abs(da) * 4 + Math.abs(fr - 0.98) * 14;
        if (score < best) {
          best = score;
          pick = { x, z, yaw: Math.atan2(tz, tx), ux, uz };
        }
      }
    }
    if (pick) out.push(pick);
  }
  return out;
}
