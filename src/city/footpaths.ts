// The faint footpaths out to the finds in the open desert: temples, ruins, arches, stones.
//
// Each find (a "site") has at most one path, leading on toward town. It runs to the nearest of:
// a point on a city's worn route, the edge of a city, or another find that lies nearer to a
// city than this one does. Because every find-to-find path steps strictly closer to a city, the
// paths form trees hanging off the towns and their routes, never loops. A link is only made if
// the ground along it is walkable: a line that would cross a river, climb something steep, run
// over bare rock or through a town or another find is passed over rather than painted through.
//
// A path is a straight chord with a gentle seeded wobble that dies away at both ends, so it meets
// the route (or stops at the find) exactly where it was aimed. Everything is deterministic from
// the world seed and the finds' positions. FOOT_GLSL is the shader twin of footLat, used by the
// terrain to paint the path: keep them identical.
import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import type { DesertWorld } from '../world/surface';
import { TERRAIN } from '../world/surface';
import { edgeAt, routePos, type RouteNet, type TravelRoute } from './routes';
import type { CitySite } from './types';

/** How many footpaths the terrain paints at once (the nearest to the camera). */
export const MAX_FOOTPATHS = 24;
/** Furthest a footpath runs from one find to the next, or out to a route or a town (m). */
export const FOOT_REACH = 1500;
/** Metres over which a path thins out to nothing short of a find or a town's edge. */
export const FOOT_FADE = 20;

/** Paths are gathered for the finds within this of the point the terrain is focused on (m). */
const FOCUS_R = 3000;
/** Spacing of the checks of the ground along a candidate path (m). */
const CHECK = 15;
/** Steepest rise a path takes between two checks (rise over run). */
const MAX_GRADE = 0.4;
/** Share of the checks that may land on bare rock before a path is given up. */
const MAX_ROCK = 0.25;
/** Clear of the river's water by this much (m), so a path never runs down the bank into it. */
const RIVER_CLEAR = TERRAIN.riverHalf + 8;
/** A path to a town stops this far outside its paved edge, where the town's own ground begins. */
const EDGE_OUT = 40;
/** Candidate links tried per find before it is left without a path (bounds the cost). */
const TRIES = 6;
/** The routes looked at for a junction, nearest first. */
const ROUTES_TRIED = 4;

const TAU = Math.PI * 2;
const f32 = Math.fround;

/** How far a path stops short of the middle of a find of each kind: clear of its stones (m). */
const CLEAR: Record<string, number> = {
  temple: 58,
  hamlet: 48,
  watchtower: 30,
  ruins: 42,
  oasis: 48,
  grove: 36,
  bones: 32,
  arch: 26,
  'standing-stones': 26,
  sundial: 22,
  'balancing-stones': 22,
  shell: 20,
  wreck: 30,
  lantern: 14,
  'well-camp': 34,
  'star-house': 40,
  'salt-works': 70,
  'glass-kilns': 52,
  ledge: 60,
  bridge: 70,
  caravanserai: 50,
  'dyers-town': 80,
  'wind-towers': 110,
  'stepped-city': 130,
};
const clearOf = (kind: string): number => CLEAR[kind] ?? 24;

/** A find a path may lead to, as Discoveries.surfaceSitesNear lists them. */
export interface FootSite {
  key: number;
  kind: string;
  x: number;
  z: number;
}

/** The finds (built yet or not) within r of (x, z). Must give the same answer every time it is asked. */
export type FootSource = (x: number, z: number, r: number, out: FootSite[]) => FootSite[];

export interface Footpath {
  /** The find this path leads away from. */
  site: FootSite;
  /** What it leads to: another find, a point on a route, or a town's edge. */
  to: { kind: 'site'; site: FootSite } | { kind: 'route'; route: TravelRoute; u: number } | { kind: 'city'; city: CitySite };
  /** Frame: origin at the far end (toward town), unit direction toward the find. float32, as the shader gets them. */
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  len: number;
  /** Wobble: amplitude (m), wavenumber and phase of its main sine. */
  amp: number;
  k: number;
  ph: number;
  /** Whether the path thins out at its start (u = 0) and at its end (u = len). */
  fade0: boolean;
  fade1: boolean;
}

/** Lateral offset of the path's centre line at u (to the left, perp = (-dz, dx)). Twin of footLat in FOOT_GLSL. */
export function footLat(f: Footpath, u: number): number {
  const env = Math.sin((Math.PI * u) / f.len);
  return f.amp * env * (Math.sin(u * f.k + f.ph) + 0.4 * Math.sin(u * f.k * 2.7 + f.ph * 1.7));
}

/** World point on the centre line of a path at u, for anything that walks it. */
export function footPos(f: Footpath, u: number, out: { x: number; z: number }): { x: number; z: number } {
  const v = footLat(f, u);
  out.x = f.x0 + f.dx * u - f.dz * v;
  out.z = f.z0 + f.dz * u + f.dx * v;
  return out;
}

/** The path as a polyline from its town end to the find, a point every `step` metres. */
export function footPoints(f: Footpath, step = 8): { x: number; z: number }[] {
  const n = Math.max(1, Math.ceil(f.len / step));
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i <= n; i++) out.push(footPos(f, (f.len * i) / n, { x: 0, z: 0 }));
  return out;
}

/** Distance from (x, z) to the straight chord of a path (the wobble is only a few metres). */
function chordDist(f: Footpath, x: number, z: number): number {
  const t = Math.min(f.len, Math.max(0, (x - f.x0) * f.dx + (z - f.z0) * f.dz));
  return Math.hypot(x - f.x0 - f.dx * t, z - f.z0 - f.dz * t);
}

function hashSeed(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x2c1b3c6d) ^ Math.imul(b | 0, 0x297a2d39) ^ Math.imul(c | 0, 0x9e3779b1) ^ 0x5f0a;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Candidate {
  d: number;
  x: number;
  z: number;
  /** How far short of (x, z) the path stops: the target's own clearance. */
  stop: number;
  to: Footpath['to'];
  /** Tie-break so equal distances always sort the same way. */
  order: number;
}

/**
 * The footpaths between the finds and the towns, each worked out the first time it is asked for
 * and kept. Also hands the terrain shader the paths nearest a point (uFootA, uFootB).
 */
export class FootpathNet {
  private readonly links = new Map<number, Footpath | null>();
  private readonly sample = { h: 0, rock: 0, salt: 0 };
  private readonly cityList: CitySite[] = [];
  private readonly routeList: TravelRoute[] = [];
  private readonly siteList: FootSite[] = [];
  private readonly focusList: FootSite[] = [];
  private readonly picked: Footpath[] = [];
  private readonly P = { x: 0, z: 0 };
  private focusX = Infinity;
  private focusZ = Infinity;

  constructor(
    private readonly world: DesertWorld,
    private readonly routes: RouteNet,
    private readonly source: FootSource,
  ) {}

  /** Distance to the nearest town centre: every find-to-find path steps down this. */
  private rank(x: number, z: number): number {
    const c = this.world.cities.near(x, z, this.cityList)[0];
    return Math.hypot(c.cx - x, c.cz - z);
  }

  /** The path leading on from a find toward town, or null if no walkable one is in reach. */
  link(s: FootSite): Footpath | null {
    let f = this.links.get(s.key);
    if (f === undefined) {
      f = this.make(s);
      this.links.set(s.key, f);
    }
    return f;
  }

  /** The paths of the finds within r of (x, z), nearest first (by distance to their chord). */
  near(x: number, z: number, r: number, out: Footpath[]): Footpath[] {
    out.length = 0;
    // a path reaches at most FOOT_REACH from its find, so look that much further out for finds
    const sites = this.source(x, z, r + FOOT_REACH, this.focusList).slice();
    sites.sort((a, b) => a.key - b.key);
    for (const s of sites) {
      const f = this.link(s);
      if (f && chordDist(f, x, z) <= r) out.push(f);
    }
    out.sort((p, q) => chordDist(p, x, z) - chordDist(q, x, z) || p.site.key - q.site.key);
    return out;
  }

  private make(s: FootSite): Footpath | null {
    const cands: Candidate[] = [];
    const w = this.world;
    // the towns: their routes, and their edges
    w.cities.near(s.x, s.z, this.cityList);
    const towns = this.cityList.slice(0, 2);
    for (let i = 0; i < towns.length; i++) {
      const c = towns[i];
      const ang = Math.atan2(s.z - c.cz, s.x - c.cx);
      const e = edgeAt(c, ang) + EDGE_OUT;
      const x = c.cx + Math.cos(ang) * e;
      const z = c.cz + Math.sin(ang) * e;
      const d = Math.hypot(s.x - x, s.z - z);
      if (d <= FOOT_REACH) cands.push({ d, x, z, stop: 0, to: { kind: 'city', city: c }, order: i });
    }
    const routes = this.routes.near(s.x, s.z, this.routeList, ROUTES_TRIED).slice();
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      const j = this.junction(r, s.x, s.z);
      if (j && j.d <= FOOT_REACH) cands.push({ d: j.d, x: j.x, z: j.z, stop: 0, to: { kind: 'route', route: r, u: j.u }, order: 10 + i });
    }
    // the finds nearer town than this one
    const mine = this.rank(s.x, s.z);
    const others = this.source(s.x, s.z, FOOT_REACH, this.siteList).slice();
    for (const o of others) {
      if (o.key === s.key) continue;
      const ro = this.rank(o.x, o.z);
      if (ro > mine || (ro === mine && o.key > s.key)) continue;
      const d = Math.hypot(o.x - s.x, o.z - s.z);
      if (d <= FOOT_REACH) cands.push({ d, x: o.x, z: o.z, stop: clearOf(o.kind), to: { kind: 'site', site: o }, order: 100 + (o.key % 100000) });
    }
    cands.sort((a, b) => a.d - b.d || a.order - b.order);
    // finds close by that a path must not run through (this one and its target excepted)
    const near = this.source(s.x, s.z, FOOT_REACH + 60, []).slice();
    for (let i = 0, tried = 0; i < cands.length && tried < TRIES; i++) {
      const c = cands[i];
      const f = this.shape(s, c);
      if (!f) continue;
      tried++;
      if (this.walkable(f, near, towns)) return f;
    }
    return null;
  }

  /** Nearest point to (x, z) on a route's centre line, outside both towns' paved edges. */
  private junction(r: TravelRoute, x: number, z: number): { x: number; z: number; u: number; d: number } | null {
    const P = this.P;
    const u0 = r.gateA + 30;
    const u1 = r.gateB - 30;
    if (u1 <= u0) return null;
    let bu = u0;
    let bd = Infinity;
    for (let u = u0; u <= u1; u += 25) {
      routePos(r, u, 0, P);
      const d = Math.hypot(P.x - x, P.z - z);
      if (d < bd) {
        bd = d;
        bu = u;
      }
    }
    // refine round the best coarse sample
    for (let u = Math.max(u0, bu - 25); u <= Math.min(u1, bu + 25); u += 2) {
      routePos(r, u, 0, P);
      const d = Math.hypot(P.x - x, P.z - z);
      if (d < bd) {
        bd = d;
        bu = u;
      }
    }
    if (bd > FOOT_REACH) return null;
    routePos(r, bu, 0, P);
    return { x: P.x, z: P.z, u: bu, d: bd };
  }

  /** Lay out the path from a find toward a candidate, or null if there is too little of it to paint. */
  private shape(s: FootSite, c: Candidate): Footpath | null {
    const ddx = s.x - c.x;
    const ddz = s.z - c.z;
    const full = Math.hypot(ddx, ddz);
    const dx = ddx / full;
    const dz = ddz / full;
    const len = full - c.stop - clearOf(s.kind);
    if (len < 2 * FOOT_FADE + 20) return null;
    const otherKey = c.to.kind === 'site' ? c.to.site.key : c.to.kind === 'route' ? Math.round(c.to.u) : c.to.city.id;
    const rng = mulberry32(hashSeed(s.key, otherKey, this.world.seed));
    const x0 = f32(c.x + dx * c.stop);
    const z0 = f32(c.z + dz * c.stop);
    // (rounded to float32 like the uniforms, so the shader and anything walking it agree)
    return {
      site: s,
      to: c.to,
      x0,
      z0,
      dx: f32(dx),
      dz: f32(dz),
      len: f32(len),
      // a gentle meander: a few metres on a short path, up to about ten on a long one
      amp: f32(Math.min(10, 2 + len * 0.006) * (0.6 + 0.4 * rng())),
      k: f32(TAU / (160 + rng() * 240)),
      ph: f32(rng() * TAU),
      fade0: c.to.kind !== 'route',
      fade1: true,
    };
  }

  /** Whether the ground along a path is fit to walk: dry, not steep, mostly not rock, clear of towns and other finds. */
  private walkable(f: Footpath, near: readonly FootSite[], towns: readonly CitySite[]): boolean {
    const w = this.world;
    const P = this.P;
    const n = Math.max(2, Math.ceil(f.len / CHECK));
    const step = f.len / n;
    let prevH = NaN;
    let rock = 0;
    const target = f.to.kind === 'site' ? f.to.site.key : NaN;
    for (let i = 0; i <= n; i++) {
      footPos(f, i * step, P);
      const sm = w.sample(P.x, P.z, this.sample);
      if (sm.rock > 0.5) rock++;
      if (i > 0 && Math.abs(sm.h - prevH) > MAX_GRADE * step) return false;
      prevH = sm.h;
      if (w.river(P.x, P.z) < RIVER_CLEAR) return false;
      for (const c of towns) {
        const a = Math.atan2(P.z - c.cz, P.x - c.cx);
        // (the end at a town's edge sits EDGE_OUT outside it, so this only catches a path cutting through)
        if (Math.hypot(P.x - c.cx, P.z - c.cz) < edgeAt(c, a) + EDGE_OUT * 0.5) return false;
      }
      for (const o of near) {
        if (o.key === f.site.key || o.key === target) continue;
        if (Math.hypot(P.x - o.x, P.z - o.z) < clearOf(o.kind)) return false;
      }
    }
    return rock <= MAX_ROCK * (n + 1);
  }

  // ---------------------------------------------------------------- shader uniforms

  /** Create the uniforms FOOT_GLSL reads. Call before any terrain material is made. */
  static uniforms(u: Uniforms): void {
    for (const n of ['uFootA', 'uFootB']) {
      if (!u[n]) u[n] = { value: Array.from({ length: MAX_FOOTPATHS }, () => new THREE.Vector4()) };
    }
  }

  /** Hand the terrain the paths nearest (x, z). Cheap when the point has barely moved. */
  focus(u: Uniforms, x: number, z: number): void {
    if (Math.hypot(x - this.focusX, z - this.focusZ) < 150) return;
    this.focusX = x;
    this.focusZ = z;
    const list = this.near(x, z, FOCUS_R, this.picked);
    const A = u.uFootA.value as THREE.Vector4[];
    const B = u.uFootB.value as THREE.Vector4[];
    for (let i = 0; i < MAX_FOOTPATHS; i++) {
      const f = list[i];
      if (!f) {
        B[i].set(0, 0, 0, 0);
        continue;
      }
      A[i].set(f.x0, f.z0, f.dx, f.dz);
      // the phase carries which ends fade, in steps of 8 above it (the phase stays under 2 pi)
      B[i].set(f.len, f.amp, f.k, f.ph + 8 * ((f.fade0 ? 1 : 0) + (f.fade1 ? 2 : 0)));
    }
  }
}

/**
 * The footpaths, for the terrain fragment shader. Needs vnoise (terrainShaders COMMON) first.
 * footPaths(p, fw, camDist) returns the path mask 0..1 at world xz p: a narrow, trodden line,
 * thinning out at the ends that stop short of a find or a town. fw = pixel footprint in metres.
 */
export const FOOT_GLSL = /* glsl */ `
uniform vec4 uFootA[${MAX_FOOTPATHS}]; // start x, z, unit direction x, z
uniform vec4 uFootB[${MAX_FOOTPATHS}]; // length (0 = unused), wobble amplitude, wavenumber, phase + 8 * (fade at start + 2 * fade at end)

float footSS(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float footLat(vec4 b, float ph, float u) {
  float env = sin(${Math.PI.toFixed(7)} * u / b.x);
  return b.y * env * (sin(u * b.z + ph) + 0.4 * sin(u * b.z * 2.7 + ph * 1.7));
}

float footPaths(vec2 p, float fw, float camDist) {
  float best = 0.0;
  if (camDist > 3000.0) return 0.0;
  for (int i = 0; i < ${MAX_FOOTPATHS}; i++) {
    vec4 b = uFootB[i];
    if (b.x <= 0.0) continue;
    vec4 a = uFootA[i];
    vec2 q = p - a.xy;
    float u = dot(q, a.zw);
    if (u < 0.0 || u > b.x) continue;
    float v = dot(q, vec2(-a.w, a.z));
    if (abs(v) > b.y * 1.4 + 6.0) continue;
    float code = floor(b.w / 8.0);
    float ph = b.w - 8.0 * code;
    float dv = v - footLat(b, ph, u);
    if (abs(dv) > 7.0) continue;
    float sl = (footLat(b, ph, u + 1.5) - footLat(b, ph, u - 1.5)) / 3.0;
    float lat = abs(dv) * inversesqrt(1.0 + sl * sl);
    // half width: wanders between about 1.1 and 2 m
    float hw = 1.5 + 0.3 * sin(u * 0.021 + ph * 3.0) + 0.15 * sin(u * 0.083 + ph);
    lat += (vnoise(p * 0.8 + float(i) * 5.1) - 0.5) * 0.6 * (1.0 - footSS(1.0, 3.0, fw));
    float hwe = max(hw, fw * 1.2);
    float soft = 0.4 + 0.5 * fw;
    float m = 1.0 - footSS(hwe - soft, hwe + soft, lat);
    m *= hw / hwe;
    // thinning out short of a find or a town
    float f0 = mod(code, 2.0);
    float f1 = floor(code / 2.0);
    m *= mix(1.0, footSS(0.0, ${FOOT_FADE}.0, u), f0) * mix(1.0, footSS(0.0, ${FOOT_FADE}.0, b.x - u), f1);
    best = max(best, m);
  }
  // a little fainter than the routes between towns: fewer feet have passed this way
  return 0.85 * best * (1.0 - footSS(1800.0, 3000.0, camDist));
}
`;
