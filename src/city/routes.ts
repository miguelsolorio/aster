// The worn paths between neighbouring cities, and the camps along them.
//
// A route joins two partner cities (CityIndex.partners). It is described in its own frame: u
// runs from the centre of city A (the lower id) toward the centre of city B, v is the lateral
// offset to the left (perp = (-dz, dx)). The centre line v = routeLat(u) leaves each city down the
// avenue the terrain keeps open for it (CityIndex.wayToward), runs straight out through the
// ramps, gaps or saddles around the town, then bends onto the line between the cities and wanders
// gently along it. Camps sit a few metres off the path, joined to it by a short spur.
//
// Everything here is deterministic from the world seed and the two cities. ROUTE_GLSL is the
// shader twin of routeLat, used by the terrain to paint the path: keep them identical.
import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import type { DesertWorld } from '../world/surface';
import type { CityKind, CitySite } from './types';

/** How many routes the terrain paints at once (the nearest to the camera). */
export const MAX_ROUTES = 8;
/** At most this many camps per route. */
export const ROUTE_CAMPS = 3;
/** How far a camp's fire sits from the centre of the path, across it (metres, along v). */
export const CAMP_OFF = 16;

const TAU = Math.PI * 2;
const STEP = 4; // arc-length table spacing along u, metres

/** How far past the paved edge the path runs dead straight, out through what the city shapes around it. */
const STUB: Record<CityKind, number> = { hill: 310, canyon: 340, oasis: 540, trade: 180 };

export interface RouteCamp {
  /** Along the route (u) and which side of it (+1 left, -1 right). */
  u: number;
  side: number;
  /** The fire, in world space. */
  x: number;
  y: number;
  z: number;
  /** Arc length along the path where the spur leaves it. */
  s: number;
  seed: number;
}

export interface TravelRoute {
  key: string;
  a: CitySite;
  b: CitySite;
  /** Frame: origin at A's centre, unit direction toward B. */
  ax: number;
  az: number;
  dx: number;
  dz: number;
  len: number;
  /** Stub slopes (dv/du), where each stub ends (u from its own end) and how long the bend onto the main line is. */
  kA: number;
  uA: number;
  wA: number;
  kB: number;
  uB: number;
  wB: number;
  /** Wander of the main line: two sines. */
  a1: number;
  k1: number;
  p1: number;
  a2: number;
  k2: number;
  p2: number;
  /** u where the path leaves the paved edge of A, and of B. */
  gateA: number;
  gateB: number;
  /** Arc length at u = i * STEP. */
  arc: Float32Array;
  /** Total arc length. */
  total: number;
  camps: RouteCamp[] | null;
}

const f32 = Math.fround;
const wrapPi = (a: number): number => {
  const b = a + Math.PI;
  return b - TAU * Math.floor(b / TAU) - Math.PI;
};
const ss = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

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

/** Radius of a city's paved edge at a bearing (as cityPave draws it). */
function edgeAt(s: CitySite, ang: number): number {
  return s.radius * (1 + 0.1 * Math.sin(3 * ang + s.phase1) + 0.06 * Math.sin(5 * ang + s.phase2));
}

/** Lateral offset v of the path's centre line at u. Twin of routeLat in ROUTE_GLSL. */
export function routeLat(r: TravelRoute, u: number): number {
  const sA = ss(r.uA, r.uA + r.wA, u);
  const sB = ss(r.uB, r.uB + r.wB, r.len - u);
  const m = r.a1 * Math.sin(u * r.k1 + r.p1) + r.a2 * Math.sin(u * r.k2 + r.p2);
  return (1 - sA) * u * r.kA + (1 - sB) * (u - r.len) * r.kB + sA * sB * m;
}

/** World point on the centre line at u, plus lateral offset `off` along v. */
export function routePos(r: TravelRoute, u: number, off: number, out: { x: number; z: number }): void {
  const v = routeLat(r, u) + off;
  out.x = r.ax + r.dx * u - r.dz * v;
  out.z = r.az + r.dz * u + r.dx * v;
}

/** Slope dv/du of the centre line. */
export function routeSlope(r: TravelRoute, u: number): number {
  return (routeLat(r, u + 1) - routeLat(r, u - 1)) / 2;
}

/** Arc length along the path at u. */
export function routeSAtU(r: TravelRoute, u: number): number {
  const f = Math.min(r.arc.length - 1.001, Math.max(0, u / STEP));
  const i = Math.floor(f);
  return r.arc[i] + (r.arc[i + 1] - r.arc[i]) * (f - i);
}

/** u at arc length s along the path (clamped to the route). */
export function routeUAtS(r: TravelRoute, s: number): number {
  const a = r.arc;
  if (s <= 0) return 0;
  if (s >= r.total) return (a.length - 1) * STEP;
  let lo = 0;
  let hi = a.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (a[m] <= s) lo = m;
    else hi = m;
  }
  return (lo + (s - a[lo]) / Math.max(1e-6, a[hi] - a[lo])) * STEP;
}

/**
 * The routes between cities, built once each and kept. Also hands the terrain shader the routes
 * nearest a point (uRouteA..E).
 */
export class RouteNet {
  private readonly cache = new Map<string, TravelRoute>();
  private readonly sites: CitySite[] = [];
  private readonly seen = new Set<string>();
  private readonly sample = { h: 0, rock: 0, salt: 0 };
  private readonly P = { x: 0, z: 0 };
  private focusX = Infinity;
  private focusZ = Infinity;
  private readonly picked: TravelRoute[] = [];

  constructor(private readonly world: DesertWorld) {}

  static key(a: CitySite, b: CitySite): string {
    return a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id;
  }

  /** The route between two partner cities (in either order). */
  route(p: CitySite, q: CitySite): TravelRoute {
    const key = RouteNet.key(p, q);
    let r = this.cache.get(key);
    if (!r) {
      r = this.make(key, p.id < q.id ? p : q, p.id < q.id ? q : p);
      this.cache.set(key, r);
    }
    return r;
  }

  /** The routes of the cities around (x, z), nearest first (by distance to the line between their cities). */
  near(x: number, z: number, out: TravelRoute[], max: number): TravelRoute[] {
    const cities = this.world.cities;
    cities.near(x, z, this.sites);
    this.seen.clear();
    out.length = 0;
    for (const s of this.sites) {
      for (const o of cities.partners(s)) {
        const key = RouteNet.key(s, o);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        out.push(this.route(s, o));
      }
    }
    const d = (r: TravelRoute): number => {
      const t = Math.min(r.len, Math.max(0, (x - r.ax) * r.dx + (z - r.az) * r.dz));
      return Math.hypot(x - r.ax - r.dx * t, z - r.az - r.dz * t);
    };
    out.sort((p, q) => d(p) - d(q));
    if (out.length > max) out.length = max;
    return out;
  }

  /** The camps along a route (worked out the first time they are asked for). */
  camps(r: TravelRoute): RouteCamp[] {
    if (r.camps) return r.camps;
    const w = this.world;
    const rng = mulberry32((Math.imul(r.a.id, 0x2c1b3c6d) ^ Math.imul(r.b.id, 0x297a2d39) ^ Math.imul(w.seed | 0, 0x9e3779b1) ^ 0xca3b) >>> 0);
    const out: RouteCamp[] = [];
    const u0 = r.uA + r.wA + 120;
    const u1 = r.len - r.uB - r.wB - 120;
    const span = u1 - u0;
    const n = span < 300 ? 0 : span < 1500 ? 1 : Math.min(ROUTE_CAMPS, Math.max(1, Math.round(span / 1900)));
    const P = this.P;
    for (let i = 0; i < n; i++) {
      const uc = u0 + (span * (i + 0.5)) / n + (rng() - 0.5) * 0.35 * (span / n);
      const side0 = rng() < 0.5 ? -1 : 1;
      const seed = rng();
      let done = false;
      for (const du of [0, 50, -50, 110, -110, 180, -180, 260, -260]) {
        for (const side of [side0, -side0]) {
          const u = Math.min(u1, Math.max(u0, uc + du));
          routePos(r, u, side * CAMP_OFF, P);
          if (!this.level(P.x, P.z)) continue;
          out.push({ u, side, x: P.x, y: w.height(P.x, P.z), z: P.z, s: routeSAtU(r, u), seed });
          done = true;
          break;
        }
        if (done) break;
      }
    }
    r.camps = out;
    return out;
  }

  /** Level, dry, open sand (not rock or salt), clear of rivers: somewhere to sit round a fire. */
  private level(x: number, z: number): boolean {
    const w = this.world;
    const s = w.sample(x, z, this.sample);
    if (s.rock > 0.15 || s.salt > 0.5) return false;
    if (w.river(x, z) < 45) return false;
    for (let i = 0; i < 4; i++) {
      const a = i * (Math.PI / 2) + 0.4;
      if (Math.abs(w.height(x + Math.sin(a) * 9, z + Math.cos(a) * 9) - s.h) > 1.3) return false;
    }
    return true;
  }

  private make(key: string, A: CitySite, B: CitySite): TravelRoute {
    const cities = this.world.cities;
    const ddx = B.cx - A.cx;
    const ddz = B.cz - A.cz;
    const len = Math.hypot(ddx, ddz);
    const dx = ddx / len;
    const dz = ddz / len;
    const beta = Math.atan2(dz, dx);
    const wayA = cities.wayToward(A, B);
    const wayB = cities.wayToward(B, A);
    const dA = wrapPi(wayA - beta);
    const dB = wrapPi(wayB - beta - Math.PI);
    const kA = Math.tan(dA);
    const kB = Math.tan(dB);
    const eA = edgeAt(A, wayA);
    const eB = edgeAt(B, wayB);
    let uA = (eA + STUB[A.kind]) * Math.cos(dA);
    let uB = (eB + STUB[B.kind]) * Math.cos(dB);
    // the bend onto the main line: long enough that it never runs steeply across
    let wA = Math.min(1500, Math.max(350, 2.4 * Math.abs(uA * kA) + 250));
    let wB = Math.min(1500, Math.max(350, 2.4 * Math.abs(uB * kB) + 250));
    const room = len - 300 - uA - uB;
    if (wA + wB > room) {
      const k = Math.max(0.1, room) / (wA + wB);
      wA = Math.max(120, wA * k);
      wB = Math.max(120, wB * k);
    }
    if (uA + uB + wA + wB > len) {
      // two cities very close together: shorten the stubs too
      const k = Math.max(0.2, (len - wA - wB) / (uA + uB));
      uA *= k;
      uB *= k;
    }
    const rng = mulberry32((Math.imul(A.id, 73856093) ^ Math.imul(B.id, 19349663) ^ Math.imul(this.world.seed | 0, 83492791) ^ 0x7a71) >>> 0);
    const r: TravelRoute = {
      key,
      a: A,
      b: B,
      ax: A.cx,
      az: A.cz,
      dx,
      dz,
      len,
      kA: f32(kA),
      uA: f32(uA),
      wA: f32(wA),
      kB: f32(kB),
      uB: f32(uB),
      wB: f32(wB),
      a1: f32(9 + rng() * 11),
      k1: f32(TAU / (700 + rng() * 600)),
      p1: f32(rng() * TAU),
      a2: f32(2 + rng() * 3.5),
      k2: f32(TAU / (150 + rng() * 120)),
      p2: f32(rng() * TAU),
      gateA: eA * Math.cos(dA),
      gateB: len - eB * Math.cos(dB),
      arc: new Float32Array(0),
      total: 0,
      camps: null,
    };
    const n = Math.ceil(len / STEP) + 1;
    const arc = new Float32Array(n);
    let prev = routeLat(r, 0);
    let s = 0;
    for (let i = 1; i < n; i++) {
      const v = routeLat(r, i * STEP);
      s += Math.hypot(STEP, v - prev);
      arc[i] = s;
      prev = v;
    }
    r.arc = arc;
    r.total = s;
    return r;
  }

  // ---------------------------------------------------------------- shader uniforms

  /** Create the uniforms ROUTE_GLSL reads. Call before any terrain material is made. */
  static uniforms(u: Uniforms): void {
    for (const n of ['uRouteA', 'uRouteB', 'uRouteC', 'uRouteD', 'uRouteE']) {
      if (!u[n]) u[n] = { value: Array.from({ length: MAX_ROUTES }, () => new THREE.Vector4()) };
    }
  }

  /** Hand the terrain the routes nearest (x, z). Cheap when the point has barely moved. */
  focus(u: Uniforms, x: number, z: number): void {
    if (Math.hypot(x - this.focusX, z - this.focusZ) < 150) return;
    this.focusX = x;
    this.focusZ = z;
    const list = this.near(x, z, this.picked, MAX_ROUTES);
    const A = u.uRouteA.value as THREE.Vector4[];
    const B = u.uRouteB.value as THREE.Vector4[];
    const C = u.uRouteC.value as THREE.Vector4[];
    const D = u.uRouteD.value as THREE.Vector4[];
    const E = u.uRouteE.value as THREE.Vector4[];
    for (let i = 0; i < MAX_ROUTES; i++) {
      const r = list[i];
      if (!r) {
        B[i].set(0, 0, 0, 0);
        continue;
      }
      const cs = this.camps(r);
      const code = (k: number) => (cs[k] ? cs[k].u * cs[k].side : 0);
      A[i].set(r.ax, r.az, r.dx, r.dz);
      B[i].set(r.len, r.kA, r.uA, r.wA);
      C[i].set(r.kB, r.uB, r.wB, r.a1);
      D[i].set(r.k1, r.p1, r.a2, r.k2);
      E[i].set(r.p2, code(0), code(1), code(2));
    }
  }
}

/**
 * The worn paths, for the terrain fragment shader. Needs vnoise (terrainShaders COMMON) first.
 * routePaths(p, fw, camDist) returns the path mask 0..1 at world xz p: 1 on the trodden ribbon,
 * soft at its edges, with the camp clearings and their spurs. fw = pixel footprint in metres.
 */
export const ROUTE_GLSL = /* glsl */ `
uniform vec4 uRouteA[${MAX_ROUTES}]; // origin x, z, unit direction x, z
uniform vec4 uRouteB[${MAX_ROUTES}]; // length (0 = unused), kA, uA, wA
uniform vec4 uRouteC[${MAX_ROUTES}]; // kB, uB, wB, a1
uniform vec4 uRouteD[${MAX_ROUTES}]; // k1, p1, a2, k2
uniform vec4 uRouteE[${MAX_ROUTES}]; // p2, camps as signed u (0 = none)

float routeSS(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float routeLat(int i, float u) {
  vec4 b = uRouteB[i];
  vec4 c = uRouteC[i];
  vec4 d = uRouteD[i];
  float sA = routeSS(b.z, b.z + b.w, u);
  float sB = routeSS(c.y, c.y + c.z, b.x - u);
  float m = c.w * sin(u * d.x + d.y) + d.z * sin(u * d.w + uRouteE[i].x);
  return (1.0 - sA) * u * b.y + (1.0 - sB) * (u - b.x) * c.x + sA * sB * m;
}

float routePaths(vec2 p, float fw, float camDist) {
  float best = 0.0;
  if (camDist > 7000.0) return 0.0;
  for (int i = 0; i < ${MAX_ROUTES}; i++) {
    vec4 b = uRouteB[i];
    if (b.x <= 0.0) continue;
    vec4 a = uRouteA[i];
    vec2 q = p - a.xy;
    float u = dot(q, a.zw);
    if (u < 0.0 || u > b.x) continue;
    float v = dot(q, vec2(-a.w, a.z));
    vec4 c = uRouteC[i];
    float bound = max(abs(b.z * b.y), abs(c.y * c.x)) + c.w + uRouteD[i].z + 40.0;
    if (abs(v) > bound) continue;
    float vc = routeLat(i, u);
    float dv = v - vc;
    vec4 e = uRouteE[i];
    // the camps first: a trodden clearing round each fire and a spur to it from the path
    for (int k = 0; k < 3; k++) {
      float su = k == 0 ? e.y : k == 1 ? e.z : e.w;
      if (su == 0.0) continue;
      float uc = abs(su);
      if (abs(u - uc) > 16.0) continue;
      float side = sign(su);
      float vcc = routeLat(i, uc);
      float cv = vcc + side * ${CAMP_OFF}.0;
      float rr = length(vec2(u - uc, v - cv));
      float edge = 6.5 + 1.6 * (vnoise(q * 0.45) - 0.5) + 0.8 * sin(atan(v - cv, u - uc) * 3.0 + uc);
      best = max(best, 0.85 * (1.0 - routeSS(edge - 2.0, edge + 1.0, rr)));
      float along = (v - vcc) * side;
      if (along > 0.0 && along < ${CAMP_OFF}.0) best = max(best, 0.7 * (1.0 - routeSS(0.6, 1.4 + max(fw, 0.0), abs(u - uc))));
    }
    if (abs(dv) > 14.0) continue;
    float sl = (routeLat(i, u + 1.5) - routeLat(i, u - 1.5)) / 3.0;
    float lat = abs(dv) * inversesqrt(1.0 + sl * sl);
    float sA = routeSS(b.z, b.z + b.w, u);
    float sB = routeSS(c.y, c.y + c.z, b.x - u);
    // half width: wanders between about 1 and 2.6 m, wider where the routes leave town
    float hw = 1.6 + 0.55 * sin(u * 0.0123 + uRouteD[i].y * 3.0) + 0.3 * sin(u * 0.047 + e.x * 2.0) + 0.8 * (1.0 - sA * sB);
    // ragged edges near by; far off the ribbon keeps at least a pixel, fainter, so it reads without shimmering
    lat += (vnoise(p * 0.6 + float(i) * 7.3) - 0.5) * 1.1 * (1.0 - routeSS(1.0, 3.0, fw));
    float hwe = max(hw, fw * 1.2);
    float soft = 0.6 + 0.5 * fw;
    float m = 1.0 - routeSS(hwe - soft, hwe + soft, lat);
    m *= hw / hwe;
    // a trodden line down the middle, where most feet go
    m = max(m * 0.85, (1.0 - routeSS(0.3, 0.9 + fw, lat)) * (1.0 - routeSS(1.0, 2.0, fw)));
    best = max(best, m);
  }
  return best * (1.0 - routeSS(4000.0, 7000.0, camDist));
}
`;
