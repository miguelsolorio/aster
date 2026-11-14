// The fenced pens of pack animals outside a city. The outskirts build the fence, trough and
// fodder and say where each pen is (PenLocal, city-local, on the near group's userData.pens);
// Cities turns them to world space (PenSpot); the caravans keep the animals in them alive.
// Here: those shapes, and the choice of where a beast in a pen walks to next.

/** Where a beast stood when the pen was laid out: pen-local (u along the city's x, v along its z), heading as atan2(u, v). */
export interface PenBeastSpot {
  u: number;
  v: number;
  yaw: number;
  lying: boolean;
}

/** A pen's inside, in its own frame (centre at 0, 0): what a beast must keep clear of. */
export interface PenShape {
  hw: number;
  hd: number;
  /** The trough's centre (it runs along u, 2.2 m long and 0.6 m deep). */
  tu: number;
  tv: number;
  /** The heap of fodder's centre. */
  hu: number;
  hv: number;
}

/** A pen as the outskirts publish it: city-local, y relative to the plateau. */
export interface PenLocal extends PenShape {
  x: number;
  z: number;
  /** The top of the platform it stands on, or NaN on the ground as it is. */
  floor: number;
  /** How many beasts, already thinned by the quality tier. */
  beasts: PenBeastSpot[];
}

/** A pen in the world, as the caravans take it. */
export interface PenSpot extends PenShape {
  /** Stable while its city stays loaded: the city's id and the pen's place in its list. */
  key: number;
  x: number;
  z: number;
  /** Absolute height of the platform under it, or NaN on the ground. */
  y: number;
  /** The city's rotation: pen-local (u, v) is world (x + co u - si v, z + si u + co v) with co, si of it. */
  rot: number;
  beasts: PenBeastSpot[];
}

/** How far a beast keeps from the rails (m): its head and tail stay inside. */
export const PEN_MARGIN = 2.0;
/** How far apart two beasts stand, at the least (m). */
export const PEN_GAP = 3.2;
const HAY_GAP = 2.8;
const TROUGH_GAP = 2.2;
/** How far from the trough's middle line, and from the heap, a beast stands to eat from it (m). */
const TROUGH_REACH = 1.75;
const HAY_REACH = 2.3;

/** Distance from (u, v) to the trough's footprint. */
function troughGap(p: PenShape, u: number, v: number): number {
  const du = Math.max(0, Math.abs(u - p.tu) - 1.1);
  const dv = Math.max(0, Math.abs(v - p.tv) - 0.3);
  return Math.hypot(du, dv);
}

/** Whether (u, v) is inside the pen with `margin` to spare all round. */
export function inPen(p: PenShape, u: number, v: number, margin = PEN_MARGIN): boolean {
  return Math.abs(u) <= p.hw - margin && Math.abs(v) <= p.hd - margin;
}

/**
 * Somewhere for a beast to go next, written to out (pen-local; yaw is the way to face once there,
 * or NaN for any). eat: 0 anywhere to stand, 1 at the trough, 2 at the heap of fodder. Inside the
 * margin, clear of the trough and the heap, and PEN_GAP from each (u, v) pair in `others`. False if
 * no such place turns up in a few tries.
 */
export function penSpot(p: PenShape, rand: () => number, others: readonly number[], eat: number, out: { u: number; v: number; yaw: number }): boolean {
  for (let t = 0; t < 12; t++) {
    let u: number;
    let v: number;
    let yaw = NaN;
    if (eat === 1) {
      // alongside the trough, facing it, the head reaching over it
      u = p.tu + (rand() - 0.5) * 1.6;
      v = p.tv - Math.sign(p.tv || 1) * TROUGH_REACH;
      yaw = Math.atan2(0, p.tv - v);
    } else if (eat === 2) {
      // round the heap on the side toward the middle of the pen
      const a = Math.atan2(-p.hu, -p.hv) + (rand() - 0.5) * 1.2;
      u = p.hu + Math.sin(a) * HAY_REACH;
      v = p.hv + Math.cos(a) * HAY_REACH;
      yaw = Math.atan2(p.hu - u, p.hv - v);
    } else {
      u = (rand() * 2 - 1) * (p.hw - PEN_MARGIN);
      v = (rand() * 2 - 1) * (p.hd - PEN_MARGIN);
      if (Math.hypot(u - p.hu, v - p.hv) < HAY_GAP || troughGap(p, u, v) < TROUGH_GAP) continue;
    }
    if (!inPen(p, u, v)) continue;
    let near = false;
    for (let i = 0; i + 1 < others.length && !near; i += 2) near = Math.hypot(others[i] - u, others[i + 1] - v) < PEN_GAP;
    if (near) continue;
    out.u = u;
    out.v = v;
    out.yaw = yaw;
    return true;
  }
  return false;
}
