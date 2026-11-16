// Which kind of settlement suits the ground near a point, and exactly where and which way it
// stands. Pure: the answer depends on the world and the cell's rolls alone, so a place is always
// where it was. What gets built there is up to settlements.ts.
import type { SurfaceSample } from '../game/contract';
import { TERRAIN } from './surface';
import type { SettlementKind } from './settlementKinds';

/** What placing a settlement needs to know of the world. */
export interface SettleWorld {
  height(x: number, z: number): number;
  sample(x: number, z: number, out: SurfaceSample): SurfaceSample;
  /** Distance (m, >= 0) to the centre line of the nearest river; absent when the world has none. */
  river?(x: number, z: number): number;
}

export interface Settled {
  kind: SettlementKind;
  x: number;
  z: number;
  /** Unit vector the place faces along (meaning depends on kind). */
  dx: number;
  dz: number;
}

/** The farthest a settlement may stand from the point asked about (m). */
export const MAX_MOVE = 160;
/** Half-baseline the slope and uphill direction are judged over (m). */
const SLOPE_BASE = 15;

/** A bridge is looked for when a river is nearer than this (m). */
export const BRIDGE_SEEK = 150;
/** Steps tried walking to the river's centre line, the baseline of the river-distance gradient (m), and the distance counted as arrived (m). */
const WALK_STEPS = 12;
const WALK_BASE = 4;
const WALK_DONE = 1.5;
/** The centre line may lie this far above the water's surface (m). */
const BRIDGE_CENTRE_RISE = 0.5;
/** Distance each side the banks are measured at (m), the most they may rise above the water's surface (m), and the least the river must lie beyond (m). */
const BRIDGE_SPAN = 30;
const BRIDGE_BANK_RISE = 1.5;
const BRIDGE_BANK_RIVER = 20;
/** Sampling offset for the across-river direction (m). */
const ACROSS_OFF = 20;
/** Along the river, how far each way it must stay within BRIDGE_STRAIGHT of its centre line (m). */
const BRIDGE_ALONG = 40;
const BRIDGE_STRAIGHT = 12;

/** A dyers' town is looked for when a river is nearer than this (m). */
export const DYERS_SEEK = 260;
/** Candidate spacing (m) and reach in steps. */
const DYERS_STEP = 40;
const DYERS_REACH = 2;
/** Its candidates lie between these distances from the river (m). */
const DYERS_NEAR = 90;
const DYERS_FAR = 330;
/** The slope it likes (rise over run), and how heavily rock, salt and distance count against a spot. */
const DYERS_SLOPE = 0.12;
const DYERS_SLOPE_W = 100;
const DYERS_ROCK_W = 40;
const DYERS_SALT_W = 40;
const DYERS_DIST_W = 0.2;
/** Slope below which uphill means nothing, and the direction of increasing river distance is used. */
const FLAT_SLOPE = 0.01;

/** Salt works: candidate spacing (m), the least salt, and the steepest slope. */
const SALT_STEP = 50;
const SALT_MIN = 0.35;
const SALT_SLOPE_MAX = 0.08;

/** Ledge: candidate spacing (m), reach in steps, the least rock, and the slope range. */
const LEDGE_STEP = 45;
const LEDGE_REACH = 2;
const LEDGE_ROCK = 0.45;
const LEDGE_SLOPE_MIN = 0.3;
const LEDGE_SLOPE_MAX = 1.1;

/** Star-house: candidate spacing (m), reach in steps, the ring the hill's prominence is measured on (m). */
const STAR_STEP = 40;
const STAR_REACH = 3;
const STAR_RING = 140;
/** It needs this much prominence (m), at most this much rock and salt, and a top this flat: heights on a ring of STAR_TOP metres within STAR_FLAT (m). */
const STAR_PROMINENCE = 9;
const STAR_ROCK_MAX = 0.45;
const STAR_SALT_MAX = 0.35;
const STAR_TOP = 12;
const STAR_FLAT = 4;

/** Open ground: candidate spacing (m), and the two rings the ground's spread is measured on (m). */
const OPEN_STEP = 50;
const OPEN_RING_NEAR = 60;
const OPEN_RING_FAR = 110;
/** Level enough for a big place when spread is under this (m); weights of rock and salt against a spot. */
const LEVEL_SPREAD = 7;
const OPEN_ROCK_W = 40;
const OPEN_SALT_W = 40;
/** Chance (by roll) of a stepped city, and of wind towers after it; and the room each needs clear (m). */
const CITY_ROLL = 0.2;
const TOWERS_ROLL = 0.5;
const CITY_CLEAR = 300;
const TOWERS_CLEAR = 260;
/** Hamlet: baseline of the unevenness measure (m), weight of distance from the start, and the roll below which it is a well camp. */
const HAMLET_BASE = 25;
const HAMLET_DIST_W = 0.3;
const WELL_ROLL = 0.5;

const TAU = Math.PI * 2;

export function settle(
  w: SettleWorld,
  x0: number,
  z0: number,
  roll: (i: number) => number,
  clear: (x: number, z: number, r: number) => boolean,
): Settled {
  const s: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  const rockAt = (x: number, z: number) => w.sample(x, z, s).rock;
  const saltAt = (x: number, z: number) => w.sample(x, z, s).salt;
  const gradient = (f: (x: number, z: number) => number, x: number, z: number, e: number) => {
    const gx = (f(x + e, z) - f(x - e, z)) / (2 * e);
    const gz = (f(x, z + e) - f(x, z - e)) / (2 * e);
    return { gx, gz, m: Math.hypot(gx, gz) };
  };
  const height = (x: number, z: number) => w.height(x, z);
  const slopeAt = (x: number, z: number) => gradient(height, x, z, SLOPE_BASE);
  const uphill = (x: number, z: number) => {
    const g = slopeAt(x, z);
    return g.m > 1e-9 ? { dx: g.gx / g.m, dz: g.gz / g.m } : { dx: 1, dz: 0 };
  };
  const ring = (x: number, z: number, r: number) => {
    const out: number[] = [];
    for (let k = 0; k < 8; k++) out.push(height(x + Math.cos((k * TAU) / 8) * r, z + Math.sin((k * TAU) / 8) * r));
    return out;
  };
  const spun = (kind: SettlementKind, x: number, z: number): Settled => {
    const a = roll(1) * TAU;
    return { kind, x, z, dx: Math.cos(a), dz: Math.sin(a) };
  };

  const river = w.river ? (x: number, z: number) => w.river!(x, z) : undefined;
  const d0 = river ? river(x0, z0) : Infinity;
  const surface = TERRAIN.waterY + TERRAIN.riverBank;

  // 1. A bridge, where a river is near and runs straight and low.
  if (river && d0 < BRIDGE_SEEK) {
    let cx = x0;
    let cz = z0;
    let d = d0;
    for (let n = 0; n < WALK_STEPS && d >= WALK_DONE; n++) {
      const g = gradient(river, cx, cz, WALK_BASE);
      if (g.m < 1e-9) break;
      cx -= (g.gx / g.m) * d;
      cz -= (g.gz / g.m) * d;
      d = river(cx, cz);
    }
    if (d < WALK_DONE && Math.hypot(cx - x0, cz - z0) <= MAX_MOVE && height(cx, cz) <= surface + BRIDGE_CENTRE_RISE) {
      // The gradient on the centre line itself cancels out, so read it 20 m to one side (or, failing that, along).
      let g = gradient(river, cx + ACROSS_OFF, cz, WALK_BASE);
      if (g.m < 1e-9) g = gradient(river, cx, cz + ACROSS_OFF, WALK_BASE);
      if (g.m > 1e-9) {
        const ax = g.gx / g.m;
        const az = g.gz / g.m;
        const tx = -az;
        const tz = ax;
        let ok = true;
        for (const sg of [-1, 1]) {
          const px = cx + ax * BRIDGE_SPAN * sg;
          const pz = cz + az * BRIDGE_SPAN * sg;
          if (height(px, pz) > surface + BRIDGE_BANK_RISE || river(px, pz) <= BRIDGE_BANK_RIVER) ok = false;
          if (river(cx + tx * BRIDGE_ALONG * sg, cz + tz * BRIDGE_ALONG * sg) >= BRIDGE_STRAIGHT) ok = false;
        }
        if (ok) return { kind: 'bridge', x: cx, z: cz, dx: ax, dz: az };
      }
    }
  }

  // 2. A dyers' town on a gentle slope above a river.
  if (river && d0 < DYERS_SEEK) {
    let best: { x: number; z: number; sc: number } | null = null;
    for (let j = -DYERS_REACH; j <= DYERS_REACH; j++) {
      for (let i = -DYERS_REACH; i <= DYERS_REACH; i++) {
        const x = x0 + i * DYERS_STEP;
        const z = z0 + j * DYERS_STEP;
        const rd = river(x, z);
        if (rd < DYERS_NEAR || rd > DYERS_FAR) continue;
        w.sample(x, z, s);
        const sc =
          Math.abs(slopeAt(x, z).m - DYERS_SLOPE) * DYERS_SLOPE_W +
          DYERS_ROCK_W * s.rock +
          DYERS_SALT_W * s.salt +
          DYERS_DIST_W * (i * i + j * j);
        if (!best || sc < best.sc) best = { x, z, sc };
      }
    }
    if (best) {
      let dir: { dx: number; dz: number };
      if (slopeAt(best.x, best.z).m < FLAT_SLOPE) {
        const g = gradient(river, best.x, best.z, WALK_BASE);
        dir = g.m > 1e-9 ? { dx: g.gx / g.m, dz: g.gz / g.m } : { dx: 1, dz: 0 };
      } else dir = uphill(best.x, best.z);
      return { kind: 'dyers-town', x: best.x, z: best.z, ...dir };
    }
  }

  // 3. Salt works on a flat pan.
  {
    let best: { x: number; z: number; salt: number; slope: number } | null = null;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const x = x0 + i * SALT_STEP;
        const z = z0 + j * SALT_STEP;
        const salt = saltAt(x, z);
        if (salt <= SALT_MIN) continue;
        const slope = slopeAt(x, z).m;
        if (slope >= SALT_SLOPE_MAX) continue;
        if (!best || salt > best.salt || (salt === best.salt && slope < best.slope)) best = { x, z, salt, slope };
      }
    }
    if (best) return spun('salt-works', best.x, best.z);
  }

  // 4. A ledge against the steepest rock face.
  {
    let best: { x: number; z: number; slope: number } | null = null;
    for (let j = -LEDGE_REACH; j <= LEDGE_REACH; j++) {
      for (let i = -LEDGE_REACH; i <= LEDGE_REACH; i++) {
        const x = x0 + i * LEDGE_STEP;
        const z = z0 + j * LEDGE_STEP;
        if (rockAt(x, z) <= LEDGE_ROCK) continue;
        const slope = slopeAt(x, z).m;
        if (slope < LEDGE_SLOPE_MIN || slope > LEDGE_SLOPE_MAX) continue;
        if (!best || slope > best.slope) best = { x, z, slope };
      }
    }
    if (best) return { kind: 'ledge', x: best.x, z: best.z, ...uphill(best.x, best.z) };
  }

  // 5. A star-house on a lone, firm hilltop.
  {
    let px = x0;
    let pz = z0;
    let ph = -Infinity;
    for (let j = -STAR_REACH; j <= STAR_REACH; j++) {
      for (let i = -STAR_REACH; i <= STAR_REACH; i++) {
        const x = x0 + i * STAR_STEP;
        const z = z0 + j * STAR_STEP;
        const h = height(x, z);
        if (h > ph) {
          ph = h;
          px = x;
          pz = z;
        }
      }
    }
    const around = ring(px, pz, STAR_RING);
    const prominence = ph - around.reduce((a, b) => a + b, 0) / around.length;
    if (
      prominence > STAR_PROMINENCE &&
      rockAt(px, pz) < STAR_ROCK_MAX &&
      saltAt(px, pz) < STAR_SALT_MAX &&
      ring(px, pz, STAR_TOP).every((h) => Math.abs(h - ph) <= STAR_FLAT)
    ) {
      return spun('star-house', px, pz);
    }
  }

  // 6. Open ground: a city or towers where it is level and room allows, else a hamlet.
  const cands: { x: number; z: number; i: number; j: number; spread: number; weigh: number }[] = [];
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const x = x0 + i * OPEN_STEP;
      const z = z0 + j * OPEN_STEP;
      const hs = [height(x, z), ...ring(x, z, OPEN_RING_NEAR), ...ring(x, z, OPEN_RING_FAR)];
      w.sample(x, z, s);
      cands.push({
        x,
        z,
        i,
        j,
        spread: Math.max(...hs) - Math.min(...hs),
        weigh: OPEN_ROCK_W * s.rock + OPEN_SALT_W * s.salt,
      });
    }
  }
  let f = cands[0];
  for (const c of cands) if (c.spread + c.weigh < f.spread + f.weigh) f = c;
  const q = roll(2);
  if (f.spread < LEVEL_SPREAD && q < CITY_ROLL && clear(f.x, f.z, CITY_CLEAR)) return spun('stepped-city', f.x, f.z);
  if (f.spread < LEVEL_SPREAD && q < TOWERS_ROLL && clear(f.x, f.z, TOWERS_CLEAR)) return spun('wind-towers', f.x, f.z);
  let h = cands[0];
  let hs = Infinity;
  for (const c of cands) {
    const sc =
      Math.abs(height(c.x + HAMLET_BASE, c.z) - height(c.x - HAMLET_BASE, c.z)) +
      Math.abs(height(c.x, c.z + HAMLET_BASE) - height(c.x, c.z - HAMLET_BASE)) +
      c.weigh +
      HAMLET_DIST_W * (c.i * c.i + c.j * c.j);
    if (sc < hs) {
      hs = sc;
      h = c;
    }
  }
  return spun(roll(3) < WELL_ROLL ? 'well-camp' : 'glass-kilns', h.x, h.z);
}
