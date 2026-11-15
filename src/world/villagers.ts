// Who stands where in a village. The discoveries build the houses (buildMountainVillage,
// buildSnowVillage) and call these with the same frame, so everyone has a reason to be where
// they are: by the fire, at the well, at the foot of the tower. Nothing here is random, so a
// village's people are where they were the last time.

/** What someone in a village is, for what they say: one of the many, the watcher at the tower, or the climber by the fire. */
export type FolkRole = 'villager' | 'watcher' | 'climber';

/** One person's place, in the site's own frame (metres from its middle, along the world's axes). */
export interface FolkMark {
  u: number;
  v: number;
  /** A point they face. */
  fu: number;
  fv: number;
  sit: boolean;
  role: FolkRole;
  /** A child. */
  small: boolean;
}

/** A village's frame: the unit vector along its street (T) and the one across it (N). */
interface Frame {
  Tx: number;
  Tz: number;
  Nx: number;
  Nz: number;
}

const mark = (p: [number, number], f: [number, number], role: FolkRole = 'villager', sit = false, small = false): FolkMark => ({ u: p[0], v: p[1], fu: f[0], fv: f[1], sit, role, small });

export interface FootVillagePlan extends Frame {
  /** Where the first house stands along the street, and how far apart they are (m). */
  x0: number;
  gap: number;
  slots: number;
  /** Which slot of the lower row is left open as the square. */
  square: number;
  /** Which end of the street the tower stands past (+1 or -1); the pen is at the other. */
  endSign: number;
}

/**
 * The people of a village at the foot of a mountain: the climber and a neighbour at the fire in
 * the square, someone at the well, the watcher below the tower looking out over the sand, someone
 * leaning on the pen, and a few in the street (one with a child).
 */
export function footVillageFolk(p: FootVillagePlan): FolkMark[] {
  const P = (a: number, off: number): [number, number] => [p.Tx * a + p.Nx * off, p.Tz * a + p.Nz * off];
  const sq = p.x0 + p.square * p.gap;
  const fire = P(sq - 3.6, 4.4);
  const well = P(sq, 7.5);
  const towerA = p.endSign * (-p.x0 + p.gap * 0.95);
  const penA = -p.endSign * (-p.x0 + p.gap * 1.05);
  const a1 = p.x0 + 0.5 * p.gap;
  const a2 = p.x0 + (p.slots - 1.5) * p.gap;
  return [
    mark(P(sq - 3.6, 2.2), fire, 'climber', true),
    mark(P(sq - 1.5, 4.0), fire, 'villager', true),
    mark(P(sq + 0.3, 10.6), well),
    mark(P(towerA, -2.4), P(towerA, 30), 'watcher'),
    mark(P(penA, 2.6), P(penA, 9)),
    mark(P(a1, 0.8), P(a1 + 8, 0.2)),
    mark(P(a2, -0.9), P(a2 - 1.3, 0.1)),
    mark(P(a2 - 1.3, 0.1), P(a2, -0.9), 'villager', false, true),
  ];
}

export interface SnowVillagePlan extends Frame {
  /** The village's middle on the road, in the site's frame. */
  ox: number;
  oz: number;
  /** Half the road's width (m). */
  hw: number;
  kind: 'gate' | 'mid' | 'high';
  /** The foot of the hold, for the high village. */
  hold: [number, number] | null;
}

/**
 * The people of a snow village: the climber and two more round the fire pit, someone across the
 * road, a pair further down it in the big village, and one below the hold in the high one.
 */
export function snowVillageFolk(p: SnowVillagePlan): FolkMark[] {
  const P = (a: number, off: number): [number, number] => [p.ox + p.Tx * a + p.Nx * off, p.oz + p.Tz * a + p.Nz * off];
  const f = p.hw + 3.2;
  const fire = P(0, f);
  const out = [
    mark(P(2.5, f), fire, 'climber', true),
    mark(P(-2.6, f + 0.2), fire),
    mark(P(0.5, f - 2.4), fire, 'villager', true),
    mark(P(5, -(p.hw + 1.6)), fire),
  ];
  if (p.kind === 'mid') {
    out.push(mark(P(-8, p.hw + 1.4), P(-9.2, p.hw + 0.4)));
    out.push(mark(P(-9.2, p.hw + 0.4), P(-8, p.hw + 1.4), 'villager', false, true));
  }
  if (p.hold) {
    const h = p.hold;
    out.push(mark([h[0] - p.Tx * 5.4, h[1] - p.Tz * 5.4], [h[0] - p.Tx * 30, h[1] - p.Tz * 30]));
  }
  return out;
}
