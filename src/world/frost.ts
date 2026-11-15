// The frostland: one snowbound mountain with a road to it, a new part of the desert to walk to.
//
// Everything here is decided from the world seed alone. The region is wrapped round the nearest
// suitable snow-capped massif to the start (a snow cone or an alpine range), far enough off that
// it is a journey. Inside `rIn` of its centre the ground is under snow; out to `rOut` the snow
// thins to frost and then to bare sand (the terrain shader paints that, from the uniform
// uFrost = (x, z, rIn, rOut)). A road marked by lantern cairns runs out from the nearest city to the foot of the
// mountain and then winds up its flank to three villages, the highest with a lantern hold.
//
// The layout is laid out lazily, the first time the player comes within reach of the region, by
// walking the ground in small steps and choosing the gentlest way (see `layout`).
import { Vector4 } from 'three';
import type { SurfaceSample } from '../game/contract';
import type { CitySite } from '../city/types';
import type { DesertWorld } from './surface';

export interface FrostRegion {
  /** The massif the region is wrapped round. */
  cx: number;
  cz: number;
  /** Its base radius and height (m), and kind (0 snow cone, 1 alpine range). */
  r: number;
  h: number;
  kind: number;
  /** Snow-covered inside this distance of the centre (m). */
  rIn: number;
  /** No snow outside this distance (m). Between the two it thins out. */
  rOut: number;
}

export interface FrostPoint {
  x: number;
  z: number;
  /** Ground height (m). */
  y: number;
}

export type VillageKind = 'gate' | 'mid' | 'high';

export interface FrostVillage {
  kind: VillageKind;
  /** Index into `way` of the path point it stands by. */
  at: number;
  x: number;
  z: number;
  /** Bearing of the path there (radians): the way the street runs. */
  yaw: number;
}

export interface FrostLayout {
  region: FrostRegion;
  /** The road, from beside the city out to the high village, one point every STEP metres. */
  way: FrostPoint[];
  /** Index in `way` where the climb up the mountain begins (the approach ends). */
  climbAt: number;
  /** Index of the point where the road is first among the snow: the gate stands there. */
  gateAt: number;
  villages: FrostVillage[];
}

/** Metres between points of the way. */
export const FROST_STEP = 12;
/** How far past the massif's own flank the snow reaches: the width of the thinning band (m). */
const BAND = 820;
/** Full snow reaches this many radii out from the centre. */
const SNOW_R = 1.08;
/** How far from the start (m) the region may be, and the nearest it may be. */
const NEAREST = 6000;
/** Grade the climb aims for (rise over run). */
const CLIMB_GRADE = 0.2;
/** How much of the mountain the road climbs (fraction of its height, capped in metres). */
const CLIMB_FRAC = 0.4;
const CLIMB_MAX = 380;

const TAU = Math.PI * 2;
const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/**
 * Where the frostland is: a snow-capped massif a journey from the start, with the most room round
 * it. Its snow must not reach a city, so only massifs whose nearest city lies well clear count;
 * of those the nearest to the origin wins.
 */
export function frostRegion(world: DesertWorld): FrostRegion | null {
  let best: FrostRegion | null = null;
  let bestD = Infinity;
  const span = 4;
  for (let gj = -span; gj <= span; gj++) {
    for (let gi = -span; gi <= span; gi++) {
      const m = world.massif(gi, gj);
      if (!m || m.kind > 1) continue;
      const d = Math.hypot(m.x, m.z);
      if (d < NEAREST || d >= bestD) continue;
      const rIn = m.r * SNOW_R;
      const city = world.cities.near(m.x, m.z)[0];
      // the snow's edge, a town's edge and room for a road between them
      if (Math.hypot(city.cx - m.x, city.cz - m.z) < rIn + BAND + city.radius * 1.4 + 350) continue;
      bestD = d;
      best = { cx: m.x, cz: m.z, r: m.r, h: m.h, kind: m.kind, rIn, rOut: rIn + BAND };
    }
  }
  return best;
}

/** How much snow lies over open ground at (x, z), from distance alone: 1 inside, thinning to 0. */
export function frostCover(r: FrostRegion, x: number, z: number): number {
  return 1 - smooth(r.rIn, r.rOut, Math.hypot(x - r.cx, z - r.cz));
}

/** The vec4 the terrain shader reads: centre, full-snow radius, no-snow radius. Zero when there is no frostland. */
export function frostUniform(r: FrostRegion | null): Vector4 {
  return r ? new Vector4(r.cx, r.cz, r.rIn, r.rOut) : new Vector4(0, 0, 0, 0);
}

/**
 * The road and the villages. The approach is a walk from the edge of the nearest city toward the
 * foot of the mountain, steering away from steep ground, water and bare rock; the climb contours
 * round the mountain, turning in just enough to hold a steady grade, so it winds up as a spiral.
 */
export function frostLayout(world: DesertWorld, region: FrostRegion): FrostLayout {
  const s: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  const way: FrostPoint[] = [];
  const city: CitySite = world.cities.near(region.cx, region.cz)[0];
  const H = (x: number, z: number): number => world.height(x, z);
  /** What it costs to stand at (x, z), beyond distance: water, bare rock, salt. */
  const hazard = (x: number, z: number): number => {
    let c = 0;
    const rv = world.river(x, z);
    if (rv < 70) c += rv < 35 ? 60 : 6;
    world.sample(x, z, s);
    c += 4 * s.rock + 2 * s.salt;
    return c;
  };

  // ---- the approach: from the city's edge to the gate, in the snow's outer edge
  const toCity = Math.atan2(city.cz - region.cz, city.cx - region.cx);
  const gx = region.cx + Math.cos(toCity) * region.rIn * 0.97;
  const gz = region.cz + Math.sin(toCity) * region.rIn * 0.97;
  const dCity = Math.hypot(region.cx - city.cx, region.cz - city.cz);
  const e = city.radius * 1.35 + 60;
  let px = city.cx + ((region.cx - city.cx) / dCity) * e;
  let pz = city.cz + ((region.cz - city.cz) / dCity) * e;
  way.push({ x: px, z: pz, y: H(px, pz) });
  let prevOff = 0;
  const offs = [-1.3, -1.0, -0.75, -0.5, -0.3, -0.15, 0, 0.15, 0.3, 0.5, 0.75, 1.0, 1.3];
  for (let i = 0; i < 900; i++) {
    const dx = gx - px;
    const dz = gz - pz;
    if (Math.hypot(dx, dz) < FROST_STEP * 1.2) break;
    const base = Math.atan2(dz, dx);
    const y0 = way[way.length - 1].y;
    let bestC = Infinity;
    let bx = px;
    let bz = pz;
    let by = y0;
    let bo = 0;
    for (const o of offs) {
      const a = base + o;
      const nx = px + Math.cos(a) * FROST_STEP;
      const nz = pz + Math.sin(a) * FROST_STEP;
      const ny = H(nx, nz);
      const grade = Math.abs(ny - y0) / FROST_STEP;
      const c = grade * grade * 14 + Math.abs(o) * 0.5 + Math.abs(o - prevOff) * 0.9 + hazard(nx, nz) * 0.4;
      if (c < bestC) {
        bestC = c;
        bx = nx;
        bz = nz;
        by = ny;
        bo = o;
      }
    }
    px = bx;
    pz = bz;
    prevOff = bo * 0.6;
    way.push({ x: px, z: pz, y: by });
  }
  const climbAt = way.length - 1;
  const gateAt = Math.max(1, way.findIndex((p) => frostCover(region, p.x, p.z) > 0.35));

  // ---- the climb: round the mountain, holding a grade
  const sign = hash2(Math.round(region.cx), Math.round(region.cz)) < 0.5 ? -1 : 1;
  const hStart = way[climbAt].y;
  const hEnd = hStart + Math.min(CLIMB_MAX, region.h * CLIMB_FRAC);
  let heading = Math.atan2(pz - region.cz, px - region.cx) + sign * (Math.PI / 2);
  for (let i = 0; i < 900; i++) {
    const y0 = way[way.length - 1].y;
    if (y0 >= hEnd) break;
    const inward = Math.atan2(region.cz - pz, region.cx - px);
    const tangent = inward - sign * (Math.PI / 2);
    let bestE = Infinity;
    let bx = px;
    let bz = pz;
    let by = y0;
    let bh = heading;
    for (let k = -2; k <= 11; k++) {
      // from a little outward of the contour to steeply inward
      const a = tangent + sign * (k * 0.13);
      const nx = px + Math.cos(a) * FROST_STEP;
      const nz = pz + Math.sin(a) * FROST_STEP;
      const ny = H(nx, nz);
      const grade = (ny - y0) / FROST_STEP;
      const err = Math.abs(grade - CLIMB_GRADE) + hazard(nx, nz) * 0.05 + Math.abs(wrapPi(a - heading)) * 0.25;
      if (err < bestE) {
        bestE = err;
        bx = nx;
        bz = nz;
        by = ny;
        bh = a;
      }
    }
    // swing the heading gently, so the road does not twitch with every gully
    heading = heading + wrapPi(bh - heading) * 0.6;
    px = bx;
    pz = bz;
    way.push({ x: px, z: pz, y: by });
  }

  // ---- the villages: on the flattest ground near three points of the way
  const flat = (i: number): number => {
    const p = way[i];
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      const y = H(p.x + Math.cos(a) * 26, p.z + Math.sin(a) * 26);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    return hi - lo;
  };
  const siteNear = (target: number, reach: number): number => {
    let best = target;
    let bestF = Infinity;
    const lo = Math.max(2, target - reach);
    const hi = Math.min(way.length - 3, target + reach);
    for (let i = lo; i <= hi; i += 2) {
      const f = flat(i) + Math.abs(i - target) * 0.08;
      if (f < bestF) {
        bestF = f;
        best = i;
      }
    }
    return best;
  };
  const tangentAt = (i: number): number => {
    const a = way[Math.max(0, i - 2)];
    const b = way[Math.min(way.length - 1, i + 2)];
    return Math.atan2(b.z - a.z, b.x - a.x);
  };
  const last = way.length - 1;
  const mk = (kind: VillageKind, target: number, reach: number): FrostVillage => {
    const at = siteNear(Math.min(last - 2, target), reach);
    return { kind, at, x: way[at].x, z: way[at].z, yaw: tangentAt(at) };
  };
  const span = last - climbAt;
  const villages = [mk('gate', climbAt + 4, 6), mk('mid', climbAt + Math.round(span * 0.5), 14), mk('high', last - 3, 8)];

  return { region, way, climbAt, gateAt, villages };
}

function wrapPi(a: number): number {
  const b = a + Math.PI;
  return b - TAU * Math.floor(b / TAU) - Math.PI;
}

/** The point on the way nearest (x, z), as an index; for tests and for finding the road. */
export function nearestWayIndex(layout: FrostLayout, x: number, z: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < layout.way.length; i++) {
    const d = Math.hypot(layout.way[i].x - x, layout.way[i].z - z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Points of the way between one lantern cairn and the next: sparse over the open desert, closer on the climb. */
export const WAY_MARK_APPROACH = 25;
export const WAY_MARK_CLIMB = 12;
/** No cairn this many points either side of the gate or a village: they carry their own light. */
const WAY_MARK_CLEAR = 4;

export interface WayMark {
  /** Index into `way` of the point it stands beside. */
  i: number;
  /** Which side of the road: they alternate, as the waymarkers between the towns do. */
  side: -1 | 1;
}

/**
 * The lantern cairns beside the stretch of road from point i0 up to (not including) i1: one
 * every 300 m out on the sand, one every 150 m or so up the mountain, on alternate sides. A
 * function of the layout alone, so the chunks the road is built in agree at their seams.
 */
export function frostWayMarks(layout: FrostLayout, i0: number, i1: number): WayMark[] {
  const out: WayMark[] = [];
  const { climbAt, gateAt, villages } = layout;
  for (let i = Math.max(1, i0); i < i1; i++) {
    const climb = i >= climbAt;
    const k = climb ? i - climbAt : i;
    const every = climb ? WAY_MARK_CLIMB : WAY_MARK_APPROACH;
    if (k % every !== 0) continue;
    if (Math.abs(i - gateAt) < WAY_MARK_CLEAR) continue;
    if (villages.some((v) => Math.abs(i - v.at) < WAY_MARK_CLEAR)) continue;
    // the last cairn of the approach is not crowded by the first of the climb
    if (!climb && climbAt - i < WAY_MARK_CLIMB) continue;
    out.push({ i, side: (k / every) % 2 === 0 ? 1 : -1 });
  }
  return out;
}
