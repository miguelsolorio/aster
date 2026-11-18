// Sandstorms: where they are, from the seed and the world clock alone. Nothing about a
// scheduled storm is stored. The plane is cut into cells and time into one-day slots; each
// (cell, day) may hold one storm, born at a jittered point and time in that slot and running on
// that day's prevailing heading, so the fronts of one day run parallel. A storm is a box (width
// across its heading, depth along it) that travels at a steady speed until it dies.
//
// No storm climbs a mountain. Each massif has a keep-out circle that covers the peak and the
// villages at its foot; `shelter` takes the storm off the ground inside it and thins it over a band
// outside, and the wall that is drawn parts round the same circles (render/storm.ts). (Ending a
// storm's track at the first mountain was tried: the mountains of this world stand too close
// together for a front to pass between two, so hardly a storm lived.)
//
// The clock is in in-game days. Distances are metres, speeds metres per real second.

import type * as THREE from 'three';

export interface Storm {
  id: number; // stable for a given seed + slot
  x0: number; // centre of the front at t0, world metres
  z0: number;
  hx: number; // unit heading
  hz: number;
  t0: number; // world-clock days: born, gone
  t1: number;
  width: number; // metres across the heading (~4000)
  depth: number; // metres along the heading (~1500)
  speed: number; // m/s (~12)
}

/** A mountain's keep-out circle: no storm is on the ground inside it. */
export interface Peak {
  x: number;
  z: number;
  r: number;
}

/** One in-game day in real seconds (DayCycle's default length). */
export const DAY_SECONDS = 1200;
/** One in-game hour in real seconds. */
export const HOUR_SECONDS = DAY_SECONDS / 24;

// ---- the schedule. Thin on purpose: most hours the whole horizon is clear, and a wall somewhere
// far off is an event (about one alive within a dozen kilometres at a time). A point on open sand
// is inside a scheduled storm about once in eight days; the game sends one to a wanderer who has gone
// two or three days without (see main.ts), which is what keeps them from being strangers.
const CELL = 5000; // metres: one possible storm per cell per day
const CHANCE = 0.07; // that a (cell, day) slot holds a storm
const TRACK_MIN = 10000; // metres a storm would travel, if no mountain stops it
const TRACK_MAX = 13000;
const WIDTH = 4000;
const DEPTH = 1500;
const SPEED_MIN = 11.5;
const SPEED_MAX = 12.5;
const FIRST = 0.5; // no scheduled storm is born before this clock (a new save's first half day)
// ---- the envelope and the profile
const FADE_IN = 90; // real seconds a storm takes to build
const FADE_OUT = 120; // and to thin away
const EDGE_LEAD = 200; // metres of soft edge inside the leading face
const EDGE_TRAIL = 450; // the trailing one
const EDGE_SIDE = 500; // and each side
const SIDE_WARN = 600; // past the side of a storm the warning fades out over this many metres
// ---- caches
const REACH_PAD = 8000; // storms() answers from a cached list for any reach up to this
const SPAN = TRACK_MAX + DEPTH / 2 + Math.hypot(WIDTH / 2, DEPTH / 2);

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Integer hash of four ints, to 32 bits. */
function hash(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d) ^ Math.imul(d | 0, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}
const unit = (h: number): number => h / 4294967296;

const slotKey = (i: number, j: number, d: number): number => (d * 4096 + (i & 4095)) * 4096 + (j & 4095);

export class Weather {
  /** A storm placed by hand (the guaranteed first storm, and ?storm). Counted like any other. */
  sent: Storm | null = null;

  private readonly slots = new Map<number, Storm | null>();
  private readonly near = new Map<number, Storm[]>();
  private readonly found: Storm[] = [];
  private readonly scan: Storm[] = [];

  constructor(
    readonly seed: number,
    /** 0 open sand .. 1 fully sheltered by a mountain. */
    private readonly shelter?: (x: number, z: number) => number,
  ) {}

  /** The prevailing heading on day slot d (radians): every storm born that day runs along it. */
  private dayAngle(d: number): number {
    return unit(hash(this.seed, d, 0x5a17, 3)) * Math.PI * 2;
  }

  /** The storm of a (cell, day) slot, or null. Made once and kept. */
  private slot(i: number, j: number, d: number): Storm | null {
    if (d < 0) return null;
    const key = slotKey(i, j, d);
    const had = this.slots.get(key);
    if (had !== undefined) return had;
    const s = this.make(i, j, d);
    if (this.slots.size > 16384) this.slots.clear();
    this.slots.set(key, s);
    return s;
  }

  private make(i: number, j: number, d: number): Storm | null {
    const h0 = hash(this.seed, i, j, d);
    if (unit(h0) >= CHANCE) return null;
    const h1 = hash(h0, 1, d, i);
    const h2 = hash(h0, 2, j, d);
    const h3 = hash(h0, 3, i, j);
    const h4 = hash(h0, 4, d, j);
    const t0 = d + unit(h1);
    if (t0 < FIRST) return null;
    const a = this.dayAngle(d);
    const speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * unit(h4);
    const track = TRACK_MIN + (TRACK_MAX - TRACK_MIN) * unit(h3);
    const s: Storm = {
      id: hash(h0, 5, 0x51, 0x7) >>> 1,
      x0: (i + unit(h2)) * CELL,
      z0: (j + unit(hash(h2, 6, 0, 0))) * CELL,
      hx: Math.cos(a),
      hz: Math.sin(a),
      t0,
      t1: t0 + track / speed / DAY_SECONDS,
      width: WIDTH,
      depth: DEPTH,
      speed,
    };
    return s;
  }

  /** Every scheduled storm whose sweep comes within `pad` of the square of side `size` round (cx, cz), from day slots d-1 and d. */
  private gather(cx: number, cz: number, size: number, pad: number, d: number, out: Storm[]): Storm[] {
    out.length = 0;
    const reach = SPAN + pad + size * 0.71;
    const i0 = Math.floor((cx - reach) / CELL);
    const i1 = Math.floor((cx + reach) / CELL);
    const j0 = Math.floor((cz - reach) / CELL);
    const j1 = Math.floor((cz + reach) / CELL);
    const lim = pad + size * 0.71;
    for (let dd = d - 1; dd <= d; dd++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const s = this.slot(i, j, dd);
          if (s && sweepDist(s, cx, cz) <= lim) out.push(s);
        }
      }
    }
    return out;
  }

  /** Scheduled storms that might be alive on day slot d and near the cache cell holding (x, z). */
  private candidates(clock: number, x: number, z: number): readonly Storm[] {
    const d = Math.floor(clock);
    const qi = Math.floor(x / CELL);
    const qj = Math.floor(z / CELL);
    const key = slotKey(qi, qj, d);
    let list = this.near.get(key);
    if (!list) {
      list = this.gather((qi + 0.5) * CELL, (qj + 0.5) * CELL, CELL, REACH_PAD, d, []).slice();
      if (this.near.size > 512) this.near.clear();
      this.near.set(key, list);
    }
    return list;
  }

  /** Storms alive at `clock` whose front is within `reach` metres of (x, z). Reuses its array. */
  storms(clock: number, x: number, z: number, reach = 0): readonly Storm[] {
    const out = this.found;
    out.length = 0;
    const list = reach <= REACH_PAD ? this.candidates(clock, x, z) : this.gather(x, z, 0, reach, Math.floor(clock), this.scan);
    for (const s of list) if (alive(s, clock) && boxDist(s, clock, x, z) <= reach) out.push(s);
    const sent = this.sent;
    if (sent && alive(sent, clock) && boxDist(sent, clock, x, z) <= reach) out.push(sent);
    return out;
  }

  /** Centre of a storm's front at `clock`. */
  centre(s: Storm, clock: number, out: THREE.Vector2): THREE.Vector2 {
    const k = s.speed * (clock - s.t0) * DAY_SECONDS;
    return out.set(s.x0 + s.hx * k, s.z0 + s.hz * k);
  }

  /** 0..1 life envelope: a storm builds over its first minutes and thins over its last. 0 at and after t1. */
  life(s: Storm, clock: number): number {
    const dur = (s.t1 - s.t0) * DAY_SECONDS;
    if (dur <= 0) return 0;
    const since = (clock - s.t0) * DAY_SECONDS;
    const left = (s.t1 - clock) * DAY_SECONDS;
    if (since <= 0 || left <= 0) return 0;
    return smooth(0, Math.min(FADE_IN, dur / 3), since) * smooth(0, Math.min(FADE_OUT, dur / 3), left);
  }

  /** How thick one storm is at a point, before shelter. */
  private thick(s: Storm, clock: number, x: number, z: number): number {
    const k = s.speed * (clock - s.t0) * DAY_SECONDS;
    const rx = x - (s.x0 + s.hx * k);
    const rz = z - (s.z0 + s.hz * k);
    const a = rx * s.hx + rz * s.hz;
    const c = Math.abs(rz * s.hx - rx * s.hz);
    const hd = s.depth / 2;
    const hw = s.width / 2;
    if (c >= hw || a >= hd || a <= -hd) return 0;
    const along = a >= 0 ? 1 - smooth(hd - EDGE_LEAD, hd, a) : 1 - smooth(hd - EDGE_TRAIL, hd, -a);
    return along * (1 - smooth(hw - EDGE_SIDE, hw, c)) * this.life(s, clock);
  }

  /** How strongly one storm warns of itself at a point: 1 inside, rising over the hour before it arrives. */
  private warn(s: Storm, clock: number, x: number, z: number): number {
    const lf = this.life(s, clock);
    if (lf <= 0) return 0;
    const k = s.speed * (clock - s.t0) * DAY_SECONDS;
    const rx = x - (s.x0 + s.hx * k);
    const rz = z - (s.z0 + s.hz * k);
    const a = rx * s.hx + rz * s.hz;
    const c = Math.abs(rz * s.hx - rx * s.hz);
    const hd = s.depth / 2;
    const hw = s.width / 2;
    if (a <= -hd || c >= hw + SIDE_WARN) return 0;
    let ramp = 1;
    if (a > hd) {
      // ahead of the leading face: how long until it gets here, and is it still alive then?
      const wait = (a - hd) / s.speed;
      if (wait >= HOUR_SECONDS || clock + wait / DAY_SECONDS >= s.t1) return 0;
      ramp = 1 - wait / HOUR_SECONDS;
    }
    const side = c <= hw ? 1 : 1 - smooth(hw, hw + SIDE_WARN, c);
    return ramp * side * Math.min(1, lf * 3);
  }

  /** 0..1 how thick the storm is at a point: soft-edged box profile x life x (1 - shelter). */
  density(clock: number, x: number, z: number): number {
    let best = 0;
    for (const s of this.candidates(clock, x, z)) {
      if (alive(s, clock)) best = Math.max(best, this.thick(s, clock, x, z));
    }
    const sent = this.sent;
    if (sent && alive(sent, clock)) best = Math.max(best, this.thick(sent, clock, x, z));
    if (best <= 0 || !this.shelter) return best;
    return best * (1 - Math.min(1, Math.max(0, this.shelter(x, z))));
  }

  /** 0..1 warning at a point: rises from 0 to 1 over the in-game hour before a leading edge arrives, 1 while inside. 0 if nothing is coming. */
  ahead(clock: number, x: number, z: number): number {
    let best = 0;
    for (const s of this.candidates(clock, x, z)) {
      if (alive(s, clock)) best = Math.max(best, this.warn(s, clock, x, z));
    }
    const sent = this.sent;
    if (sent && alive(sent, clock)) best = Math.max(best, this.warn(sent, clock, x, z));
    return best;
  }

  /** Heading of the storm that `density`/`ahead` is about at this point, or null. */
  heading(clock: number, x: number, z: number, out: THREE.Vector2): THREE.Vector2 | null {
    let best = 0;
    let pick: Storm | null = null;
    const look = (s: Storm) => {
      if (!alive(s, clock)) return;
      const w = Math.max(this.warn(s, clock, x, z), this.thick(s, clock, x, z));
      if (w > best) {
        best = w;
        pick = s;
      }
    };
    for (const s of this.candidates(clock, x, z)) look(s);
    if (this.sent) look(this.sent);
    const p = pick as Storm | null;
    return p ? out.set(p.hx, p.hz) : null;
  }

  /**
   * A storm on that day's prevailing heading whose leading edge reaches (x, z) `arrive` real
   * seconds after `clock`. With `arrive` < 0 it is already over the point, its centre there, and
   * fully built.
   */
  aim(clock: number, x: number, z: number, arrive: number): Storm {
    const a = this.dayAngle(Math.floor(clock));
    const hx = Math.cos(a);
    const hz = Math.sin(a);
    const speed = (SPEED_MIN + SPEED_MAX) / 2;
    const inside = arrive < 0;
    const t0 = inside ? clock - FADE_IN / DAY_SECONDS : clock;
    // how far behind the point the centre is at t0
    const back = inside ? speed * FADE_IN : DEPTH / 2 + speed * arrive;
    const after = (DEPTH + 3000) / speed; // it runs on a while past the point
    const s: Storm = {
      id: -1 - (hash(this.seed, Math.round(t0 * 1e5), Math.round(x), Math.round(z)) >>> 2),
      x0: x - hx * back,
      z0: z - hz * back,
      hx,
      hz,
      t0,
      t1: clock + ((inside ? 0 : arrive) + after) / DAY_SECONDS,
      width: WIDTH,
      depth: DEPTH,
      speed,
    };
    return s;
  }

  /** Where this storm leaves a wreck uncovered (on the track its centre passes over, at least 30% along), or null: about 60% of storms leave one. */
  wreck(s: Storm): { x: number; z: number; rot: number } | null {
    const h = hash(s.id, Math.round(s.x0), Math.round(s.z0), 0x3eec);
    if (unit(h) >= 0.6) return null;
    const len = s.speed * (s.t1 - s.t0) * DAY_SECONDS;
    if (len <= 0) return null;
    // far enough along that the wanderer has seen it coming, and short enough of the end that
    // the whole depth of the storm has gone over it while the storm still lives
    const from = len * 0.3;
    const to = len - s.depth - 200;
    if (to <= from) return null;
    const at = from + (to - from) * unit(hash(h, 1, 2, 3));
    return {
      x: s.x0 + s.hx * at,
      z: s.z0 + s.hz * at,
      rot: unit(hash(h, 4, 5, 6)) * Math.PI * 2,
    };
  }
}

const alive = (s: Storm, clock: number): boolean => clock >= s.t0 && clock < s.t1;

/** Distance from a point to a storm's box at `clock` (0 inside). */
function boxDist(s: Storm, clock: number, x: number, z: number): number {
  const k = s.speed * (clock - s.t0) * DAY_SECONDS;
  const rx = x - (s.x0 + s.hx * k);
  const rz = z - (s.z0 + s.hz * k);
  const a = Math.max(0, Math.abs(rx * s.hx + rz * s.hz) - s.depth / 2);
  const c = Math.max(0, Math.abs(rz * s.hx - rx * s.hz) - s.width / 2);
  return Math.hypot(a, c);
}

/** Distance from a point to the whole stretch of ground a storm's box sweeps in its life. */
function sweepDist(s: Storm, x: number, z: number): number {
  const len = s.speed * (s.t1 - s.t0) * DAY_SECONDS;
  const rx = x - s.x0;
  const rz = z - s.z0;
  const a = rx * s.hx + rz * s.hz;
  const lo = -s.depth / 2;
  const hi = len + s.depth / 2;
  const da = a < lo ? lo - a : a > hi ? a - hi : 0;
  const c = Math.max(0, Math.abs(rz * s.hx - rx * s.hz) - s.width / 2);
  return Math.hypot(da, c);
}

/** A massif as the weather sees it: centre and base radius. */
export interface MassifLike {
  x: number;
  z: number;
  r: number;
}

/**
 * The keep-out circles and the shelter function for a world's massifs, which stand at the corners
 * (gi, gj) * cell of the city grid. A keep-out circle covers the peak and the villages at its foot
 * (1.25 radii and a margin); the frost region's massif keeps its whole snowfield and villages clear.
 * Shelter is 1 inside a keep-out circle and thins to 0 over a band round it.
 */
export function massifGuard(
  massif: (gi: number, gj: number) => MassifLike | null,
  cell: number,
  frost?: { cx: number; cz: number; rOut: number } | null,
): { peaks: (x: number, z: number, reach: number) => Peak[]; shelter: (x: number, z: number) => number } {
  const BAND = 900;
  const cache = new Map<number, Peak | null>();
  const at = (gi: number, gj: number): Peak | null => {
    const key = (gi & 0xffff) * 65536 + (gj & 0xffff);
    const had = cache.get(key);
    if (had !== undefined) return had;
    const m = massif(gi, gj);
    let p: Peak | null = null;
    if (m) {
      let r = m.r * 1.25 + 200;
      if (frost && Math.hypot(frost.cx - m.x, frost.cz - m.z) < 1) r = Math.max(r, frost.rOut + 300);
      p = { x: m.x, z: m.z, r };
    }
    if (cache.size > 4096) cache.clear();
    cache.set(key, p);
    return p;
  };
  const peaks = (x: number, z: number, reach: number): Peak[] => {
    const out: Peak[] = [];
    const pad = reach + 4000;
    for (let gj = Math.floor((z - pad) / cell); gj <= Math.ceil((z + pad) / cell); gj++) {
      for (let gi = Math.floor((x - pad) / cell); gi <= Math.ceil((x + pad) / cell); gi++) {
        const p = at(gi, gj);
        if (p && Math.hypot(p.x - x, p.z - z) <= reach + p.r) out.push(p);
      }
    }
    return out;
  };
  const shelter = (x: number, z: number): number => {
    const gi = Math.round(x / cell);
    const gj = Math.round(z / cell);
    let best = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const p = at(gi + di, gj + dj);
        if (!p) continue;
        const dx = x - p.x;
        const dz = z - p.z;
        const far = p.r + BAND;
        if (dx * dx + dz * dz >= far * far) continue;
        best = Math.max(best, 1 - smooth(p.r, far, Math.sqrt(dx * dx + dz * dz)));
        if (best >= 1) return 1;
      }
    }
    return best;
  };
  return { peaks, shelter };
}
