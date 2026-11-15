// Where the wanderer is about to be. The things built around the wanderer as they travel (props,
// finds) are looked for around this point rather than under their feet, so that at a carpet's
// speed the ground ahead is ready before it comes into sight.

export interface Lead {
  x: number;
  z: number;
}

/**
 * The point `seconds` ahead of (x, z) at velocity (vx, vz), never more than `max` metres away.
 * Standing still it is the point itself. Written to `out` and returned.
 */
export function leadPoint(x: number, z: number, vx: number, vz: number, seconds: number, max: number, out: Lead): Lead {
  let lx = vx * seconds;
  let lz = vz * seconds;
  const len = Math.hypot(lx, lz);
  if (!Number.isFinite(len)) lx = lz = 0;
  else if (len > max) {
    lx *= max / len;
    lz *= max / len;
  }
  out.x = x + lx;
  out.z = z + lz;
  return out;
}
