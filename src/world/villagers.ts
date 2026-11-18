// Who stands where in a village. The discoveries build the houses (buildMountainVillage,
// buildSnowVillage) and call these with the same frame, so everyone has a reason to be where
// they are: by the fire, at the well, at the foot of the tower. Nothing here is random, so a
// village's people are where they were the last time.

/**
 * What someone in a village is, for what they say: one of the many, the watcher at the tower, the
 * climber by the fire, or (in a settlement out on the sand) the one person worth stopping for.
 */
export type FolkRole = 'villager' | 'watcher' | 'climber' | 'host';

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
  /** Their cloth, where the place has colours of its own (r, g, b). */
  coat?: [number, number, number];
  /** Height they stand at, relative to the site's base, where it is not the ground: a deck, a terrace. */
  y?: number;
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

/** How far round a hamlet's well nobody stands: its ring of stones and its posts (m). */
export const WELL_CLEAR = 2.6;

/** A ring house of a hamlet as buildHamlet lays it: bearing and distance from the well, length and depth (m). */
export interface HamletHouse {
  a: number;
  d: number;
  w: number;
  depth: number;
}

export interface HamletPlan {
  /** The site's frame turn (Ctx yaw): the builders' (u, v) is turned by it onto the world's axes. */
  yaw: number;
  houses: HamletHouse[];
  /** The lamp post by the well, in the frame. */
  torch: [number, number];
}

/** A frame point turned onto the world's axes, as Ctx.at does it. */
const turn = (yaw: number, p: [number, number]): [number, number] => {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
};

const wrap = (a: number): number => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));

/**
 * The people of a hamlet that has come back: the host at the well, looking toward one of the
 * houses (the one furthest round from the lamp), one or two sat by their doors, and the rest
 * standing out in front of theirs, looking in at the well. Three to five, by how many houses
 * there are.
 */
export function hamletFolk(p: HamletPlan): FolkMark[] {
  const hs = p.houses;
  const n = hs.length;
  if (n === 0) return [];
  const count = Math.max(3, Math.min(5, n - 1));
  const ta = Math.atan2(p.torch[1], p.torch[0]);
  let h = 0;
  for (let i = 1; i < n; i++) if (wrap(hs[i].a - ta) > wrap(hs[h].a - ta)) h = i;
  // a house's frame: along its long side (T), and in toward the well (N), from its middle
  const at = (k: number, along: number, inward: number): [number, number] => {
    const { a, d } = hs[k];
    const Tx = -Math.sin(a);
    const Tz = Math.cos(a);
    return [Math.cos(a) * d + Tx * along - Math.cos(a) * inward, Math.sin(a) * d + Tz * along - Math.sin(a) * inward];
  };
  const out: FolkMark[] = [];
  const P = (q: [number, number]) => turn(p.yaw, q);
  {
    const a = hs[h].a;
    const r = WELL_CLEAR + 0.9;
    out.push(mark(P([Math.cos(a) * r, Math.sin(a) * r]), P(at(h, 0, hs[h].depth / 2)), 'host'));
  }
  const sitters = count >= 4 ? 2 : 1;
  for (let k = 1; out.length < count && k < n; k++) {
    const i = (h + k) % n;
    const half = hs[i].depth / 2;
    if (out.length <= sitters) {
      // sat against the wall beside the door, clear of the jars and the awning's poles
      const side = k % 2 === 0 ? -1 : 1;
      out.push(mark(P(at(i, side * Math.min(2.1, hs[i].w / 2 - 0.4), half + 1.1)), P(at(i, side * 2.1, half + 6)), 'villager', true));
    } else {
      out.push(mark(P(at(i, -1, half + 2.6)), [0, 0]));
    }
  }
  return out;
}

export interface TowerPlan {
  /** The site's frame turn (Ctx yaw). */
  yaw: number;
  /** The bearing of the keeper's hut from the tower, its distance (m), and its length and depth. */
  ha: number;
  hd: number;
  w: number;
  depth: number;
}

/** The keeper of a watchtower that has been lit again: standing beside the hut's door, looking out over the sand. */
export function towerFolk(p: TowerPlan): FolkMark[] {
  const { ha, hd } = p;
  // the hut's door looks out, away from the tower
  const Tx = -Math.sin(ha);
  const Tz = Math.cos(ha);
  const out = hd + p.depth / 2 + 1.2;
  const along = Math.min(1.7, p.w / 2 - 0.3);
  const u = Math.cos(ha) * out + Tx * along;
  const v = Math.sin(ha) * out + Tz * along;
  return [mark(turn(p.yaw, [u, v]), turn(p.yaw, [u + Math.cos(ha) * 30, v + Math.sin(ha) * 30]), 'watcher')];
}
