// What fills a room: the stairs of a tall house and the sand-built furniture on every floor, with
// the candles that light it. Pure logic, no three.js. The plan decides it all once per room from the
// seed (planRooms), the near city draws it (interiors.ts) and the wanderer's shell asks it what
// stands where (rooms.ts), so what is drawn and what is solid are the same boxes.
//
// Houses of two or more storeys get floors and a straight stair between each pair of them; the
// stairs of a flat-roofed box come out through the roof. Beds go upstairs, tables and chairs on the
// ground floor; halls get long tables with benches, and a great chamber benches and an altar. All of
// it is the same sand as the walls.

import type { Candle, Piece, PieceKind, Room, RoomStair } from './types';

/** Thickness of a floor slab (its top is the floor above, its underside the ceiling below). */
export const SLAB = 0.25;
/** Width of a flight of stairs. */
export const STAIR_W = 1.0;
const RUN = 0.28;
const MAX_RISE = 0.34;
/** Free floor kept at either end of a flight. */
const LANDING = 0.9;
/** A flight starts this far from the corner of a room, clear of the rounded corner of a slumped house. */
const CORNER = 0.7;

/** Heights of the furniture's tops above its floor. */
export const H_BED = 0.57;
export const H_TABLE = 0.78;
export const H_SEAT = 0.46;
export const H_STAND = 0.56;

function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const overlap = (a: Rect, b: Rect, gap = 0): boolean => a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.z0 < b.z1 + gap && a.z1 > b.z0 - gap;

/** The room's shell, as far as it is known before it is furnished. */
type Shell = Pick<Room, 'x0' | 'z0' | 'x1' | 'z1' | 't' | 'door' | 'grand' | 'ceil' | 'h' | 'floors' | 'stairs' | 'hatch'>;

/** Number of storeys of a room (1 when it has no upper floors). */
export const storeysOf = (r: Pick<Room, 'floors'>): number => r.floors.length + 1;

/** Floor height of storey s. */
export const floorOf = (r: Pick<Room, 'floors'>, s: number): number => (s <= 0 ? 0 : r.floors[Math.min(s, r.floors.length) - 1]);

/** Underside of the ceiling over storey s. */
export const ceilOf = (r: Pick<Room, 'floors' | 'ceil'>, s: number): number => (s >= r.floors.length ? r.ceil : r.floors[s] - SLAB);

/** The storey a body with feet at y stands in (the last few steps of a flight already count as the upper one). */
export function storeyAt(r: Pick<Room, 'floors'>, y: number): number {
  let s = 0;
  for (let k = 0; k < r.floors.length; k++) if (y >= r.floors[k] - 1.2) s = k + 1;
  return s;
}

/** Height of the flight s over (x, z), or -Infinity outside it. */
export function stairTop(st: RoomStair, x: number, z: number): number {
  if (x < st.x0 || x >= st.x1 || z < st.z0 || z >= st.z1) return -Infinity;
  const u = st.dir === 0 ? x - st.x0 : st.dir === 1 ? st.x1 - x : st.dir === 2 ? z - st.z0 : st.z1 - z;
  const j = Math.min(st.steps - 1, Math.max(0, Math.floor(u / st.run)));
  return st.y0 + ((j + 1) * (st.y1 - st.y0)) / st.steps;
}

/** The hole a flight leaves in the slab above it. */
export const holeOf = (st: RoomStair): Rect => st;

/** The rectangle of the door's front, where nothing may stand. */
function doorZone(r: Shell): Rect {
  const d = r.door;
  const w = (d.u1 - d.u0) / 2 + 0.4;
  const depth = (d.portal ? 4 : 1.7) + r.t;
  if (d.fi === 0) return { x0: r.x1 - depth, x1: r.x1, z0: d.z - w, z1: d.z + w };
  if (d.fi === 1) return { x0: r.x0, x1: r.x0 + depth, z0: d.z - w, z1: d.z + w };
  if (d.fi === 2) return { x0: d.x - w, x1: d.x + w, z0: r.z1 - depth, z1: r.z1 };
  return { x0: d.x - w, x1: d.x + w, z0: r.z0, z1: r.z0 + depth };
}

/**
 * The stairs of a house of n storeys of height sh under a roof at h: a flight between each pair of
 * floors, alternating between a wall and the one opposite it, and one more out through the roof when
 * `hatch` allows. Empty when the room has no wall long enough to hold one.
 */
export function planStairs(r: Shell, n: number, sh: number, hatch: boolean, seed: number, bi: number): RoomStair[] {
  const xa = r.x0 + r.t, xb = r.x1 - r.t, za = r.z0 + r.t, zb = r.z1 - r.t;
  const steps = Math.ceil(sh / MAX_RISE - 1e-6);
  const len = steps * RUN;
  const fi = r.door.fi;
  const zone = doorZone(r);
  // walls: 0 +x, 1 -x (run along z), 2 +z, 3 -z (run along x)
  const order = [fi ^ 1, ...(fi < 2 ? [2, 3] : [0, 1])];
  const along = (w: number): number => (w < 2 ? zb - za : xb - xa);
  const across = (w: number): number => (w < 2 ? xb - xa : zb - za);
  const flight = (w: number, k: number, low: boolean): RoomStair => {
    // low: the foot is at the low-coordinate end of the wall
    const a0 = (w < 2 ? za : xa) + CORNER;
    const a1 = (w < 2 ? zb : xb) - CORNER;
    const s0 = low ? a0 : a1 - len;
    const s1 = s0 + len;
    const dir = w < 2 ? (low ? 2 : 3) : low ? 0 : 1;
    let x0: number, x1: number, z0: number, z1: number;
    if (w < 2) {
      x0 = w === 0 ? xb - STAIR_W : xa;
      x1 = w === 0 ? xb : xa + STAIR_W;
      z0 = s0;
      z1 = s1;
    } else {
      z0 = w === 2 ? zb - STAIR_W : za;
      z1 = w === 2 ? zb : za + STAIR_W;
      x0 = s0;
      x1 = s1;
    }
    return { k, x0, z0, x1, z1, dir, y0: k * sh, y1: (k + 1) * sh, steps, run: RUN };
  };
  const reach = (st: RoomStair): Rect => {
    // the strip and the floor kept clear at its foot
    const g = LANDING;
    return {
      x0: st.x0 - (st.dir === 0 ? g : 0),
      x1: st.x1 + (st.dir === 1 ? g : 0),
      z0: st.z0 - (st.dir === 2 ? g : 0),
      z1: st.z1 + (st.dir === 3 ? g : 0),
    };
  };
  for (const w of order) {
    if (along(w) < len + LANDING + 2 * CORNER || across(w) < 2 * STAIR_W + 0.8) continue;
    const e = hash(seed, bi, 0x51) < 0.5;
    const first = flight(w, 0, e);
    if (overlap(reach(first), zone)) continue;
    const out: RoomStair[] = [first];
    const count = hatch ? n : n - 1;
    for (let k = 1; k < count; k++) out.push(k % 2 === 1 ? flight(w ^ 1, k, !e) : flight(w, k, e));
    return out;
  }
  return [];
}

// ---------------------------------------------------------------- furniture

class Floor {
  readonly placed: Rect[] = [];
  constructor(
    readonly inner: Rect,
    readonly blocked: Rect[],
  ) {}

  fits(p: Rect, gap = 0.2, keep = 0.05): boolean {
    const i = this.inner;
    if (p.x0 < i.x0 + keep || p.x1 > i.x1 - keep || p.z0 < i.z0 + keep || p.z1 > i.z1 - keep) return false;
    for (const b of this.blocked) if (overlap(p, b)) return false;
    for (const q of this.placed) if (overlap(p, q, gap)) return false;
    return true;
  }
}

/** The four directions as unit steps: 0 +x, 1 -x, 2 +z, 3 -z. */
const DX = [1, -1, 0, 0];
const DZ = [0, 0, 1, -1];

export function furnish(r: Shell, role: string, seed: number, bi: number): { pieces: Piece[]; candles: Candle[] } {
  const pieces: Piece[] = [];
  const candles: Candle[] = [];
  const t = r.t;
  const inner: Rect = { x0: r.x0 + t, z0: r.z0 + t, x1: r.x1 - t, z1: r.z1 - t };
  const n = storeysOf(r);
  let counter = 0;
  const rnd = (): number => hash(seed, bi, 0x700 + counter++);
  const tintOf = (): number => rnd();

  for (let s = 0; s < n; s++) {
    const y = floorOf(r, s);
    const blocked: Rect[] = [];
    if (s === 0) blocked.push(doorZone(r));
    for (const st of r.stairs) {
      const foot = st.dir === 0 ? { x0: st.x0 - LANDING, x1: st.x1, z0: st.z0, z1: st.z1 }
        : st.dir === 1 ? { x0: st.x0, x1: st.x1 + LANDING, z0: st.z0, z1: st.z1 }
        : st.dir === 2 ? { x0: st.x0, x1: st.x1, z0: st.z0 - LANDING, z1: st.z1 }
        : { x0: st.x0, x1: st.x1, z0: st.z0, z1: st.z1 + LANDING };
      const head = st.dir === 0 ? { x0: st.x0, x1: st.x1 + LANDING, z0: st.z0, z1: st.z1 }
        : st.dir === 1 ? { x0: st.x0 - LANDING, x1: st.x1, z0: st.z0, z1: st.z1 }
        : st.dir === 2 ? { x0: st.x0, x1: st.x1, z0: st.z0, z1: st.z1 + LANDING }
        : { x0: st.x0, x1: st.x1, z0: st.z0 - LANDING, z1: st.z1 };
      if (st.k === s) blocked.push(foot);
      if (st.k + 1 === s) blocked.push(head);
    }
    const fl = new Floor(inner, blocked);

    const add = (kind: PieceKind, p: Rect, h: number, dir: number): Piece => {
      const piece: Piece = { kind, ...p, y, h, dir, tint: tintOf() };
      pieces.push(piece);
      fl.placed.push(p);
      return piece;
    };
    const candle = (x: number, top: number, z: number): void => {
      candles.push({ x, y: y + top + 0.2, z, seed: rnd() });
    };
    // walls 0..3 as in planStairs: the run along each
    const walls = [
      { a0: inner.z0, a1: inner.z1 },
      { a0: inner.z0, a1: inner.z1 },
      { a0: inner.x0, a1: inner.x1 },
      { a0: inner.x0, a1: inner.x1 },
    ];
    /** A rectangle against wall w, `len` deep and `wid` along it, its near end at a. */
    const againstWall = (w: number, a: number, wid: number, len: number): Rect => {
      if (w === 0) return { x0: inner.x1 - len, x1: inner.x1, z0: a, z1: a + wid };
      if (w === 1) return { x0: inner.x0, x1: inner.x0 + len, z0: a, z1: a + wid };
      if (w === 2) return { x0: a, x1: a + wid, z0: inner.z1 - len, z1: inner.z1 };
      return { x0: a, x1: a + wid, z0: inner.z0, z1: inner.z0 + len };
    };
    /** Looks along wall w from a seeded start for a place for a wid x len piece; returns it or null. */
    const alongWall = (w: number, wid: number, len: number, gap = 0.25): { p: Rect; a: number } | null => {
      const { a0, a1 } = walls[w];
      const span = a1 - a0 - wid;
      if (span < 0) return null;
      const from = rnd() * span;
      for (let k = 0; k <= 12; k++) {
        const a = a0 + ((from + (k / 12) * span) % (span + 1e-9));
        const p = againstWall(w, a, wid, len);
        if (fl.fits(p, gap)) return { p, a };
      }
      return null;
    };
    const faceAway = (w: number): number => [1, 0, 3, 2][w];
    const wallOrder = (): number[] => {
      const o = [0, 1, 2, 3];
      for (let i = 3; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [o[i], o[j]] = [o[j], o[i]];
      }
      return o;
    };

    /** A bed with its head to a wall, and a stand with a candle at its side. */
    const bed = (): boolean => {
      for (const w of wallOrder()) {
        const got = alongWall(w, 0.95, 1.9);
        if (!got) continue;
        add('bed', got.p, H_BED, faceAway(w));
        // a bedside stand against the same wall, at whichever side has room
        for (const side of rnd() < 0.5 ? [-1, 1] : [1, -1]) {
          const a = side < 0 ? got.a - 0.4 - 0.05 : got.a + 0.95 + 0.05;
          const sp = againstWall(w, a, 0.4, 0.4);
          if (fl.fits(sp, 0.02)) {
            add('stand', sp, H_STAND, faceAway(w));
            candle((sp.x0 + sp.x1) / 2, H_STAND, (sp.z0 + sp.z1) / 2);
            break;
          }
        }
        return true;
      }
      return false;
    };

    /** A table (long side along x or z) with seats at its long sides, and a candle on it. */
    const table = (tw: number, td: number, seats: number, centre?: { x: number; z: number }): boolean => {
      const cx0 = (inner.x0 + inner.x1) / 2, cz0 = (inner.z0 + inner.z1) / 2;
      const alongX = centre ? tw >= td : inner.x1 - inner.x0 >= inner.z1 - inner.z0 ? rnd() < 0.7 : rnd() < 0.3;
      const w = alongX ? tw : td, d = alongX ? td : tw;
      const cands: Array<{ x: number; z: number; k: number }> = [];
      for (let x = inner.x0 + w / 2; x <= inner.x1 - w / 2 + 1e-6; x += 0.25) {
        for (let z = inner.z0 + d / 2; z <= inner.z1 - d / 2 + 1e-6; z += 0.25) {
          const c = centre ?? { x: cx0, z: cz0 };
          cands.push({ x, z, k: Math.hypot(x - c.x, z - c.z) + rnd() * 0.5 });
        }
      }
      cands.sort((a, b) => a.k - b.k);
      for (const c of cands) {
        const p: Rect = { x0: c.x - w / 2, x1: c.x + w / 2, z0: c.z - d / 2, z1: c.z + d / 2 };
        // room for the seats at the long sides: nothing else there, and floor to stand on
        const seatRects: Array<{ p: Rect; dir: number }> = [];
        const sides = alongX ? [2, 3] : [0, 1];
        for (const sd of sides) {
          const along = alongX ? (sd === 2 ? p.z1 : p.z0) : sd === 0 ? p.x1 : p.x0;
          const dirTo = sd ^ 1;
          const per = alongX ? Math.min(2, Math.floor(w / 0.9)) : Math.min(2, Math.floor(d / 0.9));
          for (let k = 0; k < per && seatRects.length < seats; k++) {
            const frac = per === 1 ? 0.5 : (k + 0.5) / per;
            const mid = alongX ? p.x0 + w * frac : p.z0 + d * frac;
            const off = along + DX[sd] * 0.05 + DZ[sd] * 0.05;
            const sr: Rect = alongX
              ? { x0: mid - 0.225, x1: mid + 0.225, z0: sd === 2 ? off : off - 0.45, z1: sd === 2 ? off + 0.45 : off }
              : { x0: sd === 0 ? off : off - 0.45, x1: sd === 0 ? off + 0.45 : off, z0: mid - 0.225, z1: mid + 0.225 };
            seatRects.push({ p: sr, dir: dirTo });
          }
        }
        if (!fl.fits(p, 0.3)) continue;
        const ok = seatRects.filter((q) => {
          const i = fl.inner;
          return q.p.x0 >= i.x0 + 0.02 && q.p.x1 <= i.x1 - 0.02 && q.p.z0 >= i.z0 + 0.02 && q.p.z1 <= i.z1 - 0.02 && !fl.blocked.some((b) => overlap(q.p, b)) && !fl.placed.some((b) => overlap(q.p, b, 0.02));
        });
        add('table', p, H_TABLE, alongX ? 2 : 0);
        const cxm = (p.x0 + p.x1) / 2, czm = (p.z0 + p.z1) / 2;
        candle(alongX ? cxm + (rnd() - 0.5) * (w - 0.5) : cxm, H_TABLE, alongX ? czm : czm + (rnd() - 0.5) * (d - 0.5));
        for (const q of ok) add(rnd() < 0.5 ? 'chair' : 'stool', q.p, H_SEAT, q.dir);
        return true;
      }
      return false;
    };

    /** A bench against the table side, or a run of them along a wall. */
    const bench = (p: Rect, dir: number): void => {
      if (fl.fits(p, 0.02, 0.02)) add('bench', p, H_SEAT, dir);
    };

    /** A candle on a stand tucked into a corner of the floor. */
    const cornerStand = (): void => {
      const cs: Array<[number, number]> = [[inner.x0, inner.z0], [inner.x1, inner.z0], [inner.x1, inner.z1], [inner.x0, inner.z1]];
      const from = Math.floor(rnd() * 4);
      for (let k = 0; k < 4; k++) {
        const [cx, cz] = cs[(from + k) & 3];
        const p: Rect = { x0: cx === inner.x0 ? cx : cx - 0.4, x1: cx === inner.x0 ? cx + 0.4 : cx, z0: cz === inner.z0 ? cz : cz - 0.4, z1: cz === inner.z0 ? cz + 0.4 : cz };
        if (fl.fits(p, 0.05, 0)) {
          add('stand', p, H_STAND, 0);
          candle((p.x0 + p.x1) / 2, H_STAND, (p.z0 + p.z1) / 2);
          return;
        }
      }
    };

    if (r.grand) {
      // a great chamber: an altar table at the far wall, benches in rows facing it, stands along the walls
      const fi = r.door.fi;
      const far = fi ^ 1;
      const horiz = fi >= 2; // door on a z face: the chamber runs along z
      const aw = Math.min(2.6, (horiz ? inner.x1 - inner.x0 : inner.z1 - inner.z0) - 1.2);
      if (aw > 1) {
        const alt = againstWall(far, ((horiz ? inner.x0 + inner.x1 : inner.z0 + inner.z1) - aw) / 2, aw, 0.9);
        if (fl.fits(alt, 0, 0)) {
          add('table', alt, 0.95, faceAway(far) ^ 1);
          const am = (alt.x0 + alt.x1) / 2, az = (alt.z0 + alt.z1) / 2;
          for (const f of [0.2, 0.5, 0.8]) candle(horiz ? alt.x0 + (alt.x1 - alt.x0) * f : am, 0.95, horiz ? az : alt.z0 + (alt.z1 - alt.z0) * f);
        }
      }
      const rows = Math.min(5, Math.floor(((horiz ? inner.z1 - inner.z0 : inner.x1 - inner.x0) - 6) / 1.5));
      const span = horiz ? inner.x1 - inner.x0 : inner.z1 - inner.z0;
      for (let k = 0; k < rows; k++) {
        const along = (horiz ? (fi === 2 ? inner.z1 - 5.5 - k * 1.5 : inner.z0 + 5.5 + k * 1.5) : fi === 0 ? inner.x1 - 5.5 - k * 1.5 : inner.x0 + 5.5 + k * 1.5);
        for (const side of [-1, 1]) {
          const len = Math.max(1, span / 2 - 1.2);
          const mid = (horiz ? inner.x0 + inner.x1 : inner.z0 + inner.z1) / 2;
          const a0 = side < 0 ? mid - 0.6 - len : mid + 0.6;
          const p: Rect = horiz ? { x0: a0, x1: a0 + len, z0: along, z1: along + 0.45 } : { x0: along, x1: along + 0.45, z0: a0, z1: a0 + len };
          bench(p, far);
        }
      }
      const stands = Math.min(8, Math.floor(span / 3));
      for (let k = 0; k < stands; k++) cornerStand();
    } else if (role === 'hall' || role === 'market') {
      // long tables with a bench each side, along the length of the hall
      const lenX = inner.x1 - inner.x0 >= inner.z1 - inner.z0;
      const L = lenX ? inner.x1 - inner.x0 : inner.z1 - inner.z0;
      const W = lenX ? inner.z1 - inner.z0 : inner.x1 - inner.x0;
      const rowsN = W >= 7 ? 2 : 1;
      const count = Math.max(1, Math.min(3, Math.floor((L - 1) / 3.4)));
      for (let rr = 0; rr < rowsN; rr++) {
        for (let k = 0; k < count; k++) {
          const a = (lenX ? inner.x0 : inner.z0) + ((k + 0.5) / count) * L;
          const across = (lenX ? inner.z0 : inner.x0) + ((rr + 0.5) / rowsN) * W;
          const tl = Math.min(2.4, L / count - 0.8);
          if (tl < 1.2) continue;
          const p: Rect = lenX ? { x0: a - tl / 2, x1: a + tl / 2, z0: across - 0.45, z1: across + 0.45 } : { x0: across - 0.45, x1: across + 0.45, z0: a - tl / 2, z1: a + tl / 2 };
          if (!fl.fits(p, 0.3)) continue;
          const b1: Rect = lenX ? { x0: p.x0, x1: p.x1, z0: p.z1 + 0.05, z1: p.z1 + 0.5 } : { x0: p.x1 + 0.05, x1: p.x1 + 0.5, z0: p.z0, z1: p.z1 };
          const b2: Rect = lenX ? { x0: p.x0, x1: p.x1, z0: p.z0 - 0.5, z1: p.z0 - 0.05 } : { x0: p.x0 - 0.5, x1: p.x0 - 0.05, z0: p.z0, z1: p.z1 };
          add('table', p, H_TABLE, lenX ? 2 : 0);
          const cxm = (p.x0 + p.x1) / 2, czm = (p.z0 + p.z1) / 2;
          for (const f of [-0.28, 0.28]) candle(lenX ? cxm + f * tl : cxm, H_TABLE, lenX ? czm : czm + f * tl);
          bench(b1, lenX ? 3 : 1);
          bench(b2, lenX ? 2 : 0);
        }
      }
      cornerStand();
      cornerStand();
    } else {
      // a house: its ground floor is for living in, its upper floors for sleeping
      const living = s === 0;
      if (living) {
        table(1.2, 0.8, 3);
        if (n === 1) bed();
        if (n === 1 && rnd() < 0.5) bed();
      } else {
        bed();
        if (rnd() < 0.6) bed();
        if (s === n - 1 && rnd() < 0.4) table(1.0, 0.7, 2);
      }
      if (!candles.some((c) => c.y > y && c.y < y + 2.5)) cornerStand();
    }
  }
  return { pieces, candles };
}
