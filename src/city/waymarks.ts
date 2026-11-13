// Stone waymarkers along the routes between neighbouring cities.
// One merged masonry mesh and one glow mesh per route; routes are built for the cities near the
// player and dropped again once both of their cities are far away. Nothing here is solid.
import * as THREE from 'three';
import type { FrameState, Uniforms, World } from '../game/contract';
import type { CitySite } from './types';
import { Writer, polyCap, taper } from './build';
import { GLOW, MAT, createGlowMaterial, createMasonryMaterial, trackViewport } from './cityShaders';
import { routeLat, routeSlope, type RouteNet } from './routes';

const SPACING = 300;
const JITTER = 30;
const EDGE = 1.3; // routes start this many radii from the city centre
const KEEP_OUT = 1.25;
const MAX_SLOPE = 0.55;
const BUILDS_PER_FRAME = 1;
const TAU = Math.PI * 2;

interface Route {
  key: string;
  a: number; // site ids
  b: number;
  group: THREE.Group;
  geos: THREE.BufferGeometry[];
  markers: number;
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

// ------------------------------------------------------------------ marker shapes (local frame: +z is the front)

class Shaper {
  constructor(readonly w: Writer) {}

  /** Box rotated by yaw about its own base centre. Local x right, z front. */
  obox(px: number, py: number, pz: number, cx: number, cz: number, sx: number, y0: number, y1: number, sz: number, yaw: number, mask = 63): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const hx = sx / 2;
    const hz = sz / 2;
    // corner (i, j) in local space -> world
    const P = (lx: number, lz: number, y: number): [number, number, number] => {
      const x = cx + lx;
      const z = cz + lz;
      return [px + x * c + z * s, py + y, pz - x * s + z * c];
    };
    const N = (lx: number, lz: number): [number, number] => [lx * c + lz * s, -lx * s + lz * c];
    const w = this.w;
    const face = (a: [number, number, number], b: [number, number, number], d: [number, number, number], e: [number, number, number], n: [number, number, number]): void => {
      w.quad(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2], e[0], e[1], e[2], n[0], n[1], n[2]);
    };
    if (mask & 1) { const n = N(1, 0); face(P(hx, -hz, y0), P(hx, hz, y0), P(hx, hz, y1), P(hx, -hz, y1), [n[0], 0, n[1]]); }
    if (mask & 2) { const n = N(-1, 0); face(P(-hx, hz, y0), P(-hx, -hz, y0), P(-hx, -hz, y1), P(-hx, hz, y1), [n[0], 0, n[1]]); }
    if (mask & 4) face(P(-hx, -hz, y1), P(hx, -hz, y1), P(hx, hz, y1), P(-hx, hz, y1), [0, 1, 0]);
    if (mask & 16) { const n = N(0, 1); face(P(-hx, hz, y0), P(hx, hz, y0), P(hx, hz, y1), P(-hx, hz, y1), [n[0], 0, n[1]]); }
    if (mask & 32) { const n = N(0, -1); face(P(hx, -hz, y0), P(-hx, -hz, y0), P(-hx, -hz, y1), P(hx, -hz, y1), [n[0], 0, n[1]]); }
  }
}

interface Spec {
  x: number;
  z: number;
  y: number; // lowest ground under the footprint
  yaw: number; // local +z points toward the route
  height: number;
  variant: number; // 0 cairn, 1 pillar, 2 slab pair
  large: boolean;
  big: number; // 0 bench, 1 arch (large only)
}

/** Writes one marker into the stone writer; returns the niche glow position (world, relative to the writer origin) in `glow`. */
function buildMarker(sh: Shaper, sp: Spec, rng: () => number, ox: number, oz: number, glow: number[]): void {
  const w = sh.w;
  const px = sp.x - ox;
  const pz = sp.z - oz;
  const base = sp.y - 0.3;
  const H = sp.height;
  const yaw = sp.yaw;
  const fx = Math.sin(yaw); // world direction of local +z
  const fz = Math.cos(yaw);
  const lw = (lx: number, lz: number): [number, number] => [px + lx * Math.cos(yaw) + lz * Math.sin(yaw), pz - lx * Math.sin(yaw) + lz * Math.cos(yaw)];
  w.mat = MAT.stone;
  w.seed = 0;
  w.extra = 0;
  const tint = () => Math.floor(rng() * 255);

  let nicheY = H - 0.55;
  let nicheR = 0.3; // how far in front of the centre the glow sits (local z)

  if (sp.variant === 0) {
    // cairn: stacked faceted stones, a lantern gap under the cap
    const gapY0 = base + H * 0.72;
    const gapH = 0.34;
    let y = base;
    const n = 6;
    const r0 = 0.62 + rng() * 0.2 + (sp.large ? 0.25 : 0);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const r = r0 * (1 - t * 0.62);
      const hgt = ((gapY0 - base) / n) * (0.9 + rng() * 0.2);
      const [jx, jz] = lw((rng() - 0.5) * 0.12, (rng() - 0.5) * 0.12);
      w.tint = tint();
      taper(w, jx, jz, r, r * (0.8 + rng() * 0.1), y, y + hgt, 7, rng() * TAU);
      y += hgt;
    }
    // top of the stack, then three little posts around the niche
    const rt = r0 * 0.38;
    polyCap(w, px, pz, rt, y, 7, 0);
    for (let k = 0; k < 3; k++) {
      const a = yaw + Math.PI * 0.5 + (k - 1) * 1.9 + Math.PI * 0.0;
      const ax = px + Math.sin(a) * rt * 0.7;
      const az = pz + Math.cos(a) * rt * 0.7;
      w.tint = tint();
      taper(w, ax, az, 0.09, 0.08, y, y + gapH, 4, a);
    }
    w.tint = tint();
    taper(w, px, pz, rt * 1.1, rt * 0.5, y + gapH, y + gapH + (base + H - (y + gapH)), 7, rng() * TAU);
    polyCap(w, px, pz, rt * 0.5, base + H, 7, 0);
    nicheY = y + gapH * 0.5;
    nicheR = 0.0;
  } else if (sp.variant === 1) {
    // slim carved pillar: plinth, tapering shaft, cap, niche on the front
    const hw = 0.26 + rng() * 0.08 + (sp.large ? 0.1 : 0);
    w.tint = tint();
    sh.obox(px, 0, pz, 0, 0, hw * 3.2, base, base + 0.4, hw * 3.2, yaw, 63);
    const shaftTop = base + H - 0.3;
    w.tint = tint();
    taper(w, px, pz, hw * 1.55, hw * 1.05, base + 0.4, shaftTop, 4, yaw + Math.PI / 4);
    w.tint = tint();
    sh.obox(px, 0, pz, 0, 0, hw * 2.9, shaftTop, base + H, hw * 2.9, yaw, 63);
    // niche: dark recess on the front face of the shaft, with a stone sill
    const ny = base + H - 0.95;
    const fz0 = hw * 1.05 + (hw * 0.5) * (1 - (ny - base - 0.4) / (shaftTop - base - 0.4)) + 0.02;
    w.mat = MAT.opening;
    w.tint = 0;
    sh.obox(px, 0, pz, 0, fz0 - 0.02, 0.26, ny, ny + 0.36, 0.05, yaw, 16);
    w.mat = MAT.stone;
    w.tint = tint();
    sh.obox(px, 0, pz, 0, fz0 + 0.04, 0.4, ny - 0.07, ny, 0.16, yaw, 63);
    sh.obox(px, 0, pz, 0, fz0 + 0.0, 0.4, ny + 0.36, ny + 0.43, 0.1, yaw, 63);
    nicheY = ny + 0.18;
    nicheR = fz0 + 0.12;
  } else {
    // leaning slab with a smaller companion stone
    const sw = 0.9 + rng() * 0.3;
    const sd = 0.38;
    w.tint = tint();
    sh.obox(px, 0, pz, 0, 0, sw, base, base + H, sd, yaw, 63);
    const [bx, bz] = lw(sw * 0.62 + 0.1, -0.2);
    w.tint = tint();
    taper(w, bx, bz, 0.45, 0.3, base, base + H * 0.38, 6, rng() * TAU);
    polyCap(w, bx, bz, 0.3, base + H * 0.38, 6, 0);
    // a carved niche in the slab front
    const ny = base + H - 0.9;
    w.mat = MAT.opening;
    w.tint = 0;
    sh.obox(px, 0, pz, 0, sd / 2 + 0.02, 0.32, ny, ny + 0.42, 0.05, yaw, 16);
    w.mat = MAT.stone;
    w.tint = tint();
    sh.obox(px, 0, pz, 0, sd / 2 + 0.06, 0.46, ny - 0.07, ny, 0.16, yaw, 63);
    sh.obox(px, 0, pz, 0, sd / 2 + 0.02, 0.46, ny + 0.42, ny + 0.5, 0.1, yaw, 63);
    nicheY = ny + 0.2;
    nicheR = sd / 2 + 0.14;
  }

  if (sp.large) {
    if (sp.big === 0) {
      // a stone bench to one side: two slab legs and a long seat, facing the route
      const [cx, cz] = lw(1.6, 0.4);
      w.tint = tint();
      for (const k of [-1, 1]) {
        const [lx, lz] = lw(1.6 + k * 0.8, 0.4);
        sh.obox(lx, 0, lz, 0, 0, 0.3, base + 0.3, base + 0.62, 0.55, yaw, 63);
        sh.obox(lx, 0, lz, 0, 0, 0.3, base + 0.0, base + 0.3, 0.55, yaw, 63);
      }
      w.tint = tint();
      sh.obox(cx, 0, cz, 0, 0, 2.2, base + 0.62, base + 0.78, 0.6, yaw, 63);
    } else {
      // a small arch shelter: two posts and a lintel with a stepped top
      const [lx, lz] = lw(-2.4, 0.3);
      const [rx, rz] = lw(-0.8, 0.3);
      const [mx, mz] = lw(-1.6, 0.3);
      w.tint = tint();
      sh.obox(lx, 0, lz, 0, 0, 0.45, base, base + 2.0, 0.55, yaw, 63);
      sh.obox(rx, 0, rz, 0, 0, 0.45, base, base + 2.0, 0.55, yaw, 63);
      w.tint = tint();
      sh.obox(mx, 0, mz, 0, 0, 2.1, base + 2.0, base + 2.35, 0.75, yaw, 63);
      sh.obox(mx, 0, mz, 0, 0, 1.4, base + 2.35, base + 2.6, 0.6, yaw, 63);
      w.tint = tint();
      sh.obox(mx, 0, mz, 0, 0, 1.2, base, base + 0.4, 0.5, yaw, 63); // a seat under the arch
    }
  }

  glow.push(px + fx * nicheR, nicheY, pz + fz * nicheR);
}

// ------------------------------------------------------------------ glow geometry

function glowGeometry(d: number[]): THREE.BufferGeometry | null {
  const n = d.length / 5; // x y z radius seed
  if (n === 0) return null;
  const pos = new Float32Array(n * 12);
  const corner = new Float32Array(n * 8);
  const glow = new Float32Array(n * 16);
  const idx = new Uint32Array(n * 6);
  const C = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let i = 0; i < n; i++) {
    const s = i * 5;
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      pos[v * 3] = d[s];
      pos[v * 3 + 1] = d[s + 1];
      pos[v * 3 + 2] = d[s + 2];
      corner[v * 2] = C[k * 2];
      corner[v * 2 + 1] = C[k * 2 + 1];
      glow[v * 4] = d[s + 3];
      glow[v * 4 + 1] = GLOW.lamp;
      glow[v * 4 + 2] = d[s + 4];
      glow[v * 4 + 3] = 0.8;
    }
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  g.setAttribute('aGlow', new THREE.BufferAttribute(glow, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function bound(g: THREE.BufferGeometry, pad: number): void {
  g.computeBoundingBox();
  g.boundingSphere = g.boundingBox!.getBoundingSphere(new THREE.Sphere());
  g.boundingSphere.radius += pad;
}

// ------------------------------------------------------------------ Waymarks

export class Waymarks {
  readonly group = new THREE.Group();

  private readonly world: World;
  private readonly cities: { near(x: number, z: number): CitySite[]; neighbours(site: CitySite): [CitySite, CitySite]; partners(site: CitySite): CitySite[] };
  private readonly stoneMat: THREE.ShaderMaterial;
  private readonly glowMat: THREE.ShaderMaterial;
  private readonly routes = new Map<string, Route>();
  private readonly wanted = new Map<string, [CitySite, CitySite]>();
  private readonly nearIds = new Set<number>();
  private readonly pending: string[] = [];
  private refresh = 0;
  private cell = '';

  constructor(
    world: World,
    cities: { near(x: number, z: number): CitySite[]; neighbours(site: CitySite): [CitySite, CitySite]; partners(site: CitySite): CitySite[] },
    private readonly net: RouteNet,
    uniforms: Uniforms,
  ) {
    this.world = world;
    this.cities = cities;
    this.group.name = 'waymarks';
    this.stoneMat = createMasonryMaterial(uniforms, { shadow: false, twoSided: false, sway: false });
    this.glowMat = createGlowMaterial(uniforms, true);
  }

  /** Number of routes currently built, and markers in them (dev hook). */
  stats(): { routes: number; markers: number } {
    let markers = 0;
    for (const r of this.routes.values()) markers += r.markers;
    return { routes: this.routes.size, markers };
  }

  dispose(): void {
    for (const r of this.routes.values()) for (const g of r.geos) g.dispose();
    this.routes.clear();
    this.group.clear();
    this.stoneMat.dispose();
    this.glowMat.dispose();
  }

  update(f: FrameState): void {
    const px = f.player.pos.x;
    const pz = f.player.pos.z;
    const cell = Math.floor(px / 10000) + ',' + Math.floor(pz / 10000);
    this.refresh -= f.dt;
    if (this.refresh <= 0 || cell !== this.cell) {
      this.refresh = 1;
      this.cell = cell;
      this.rescan(px, pz);
    }
    for (let n = 0; n < BUILDS_PER_FRAME && this.pending.length > 0; n++) {
      const key = this.pending.pop()!;
      const pair = this.wanted.get(key);
      if (pair && !this.routes.has(key)) this.build(key, pair[0], pair[1]);
    }
  }

  private rescan(px: number, pz: number): void {
    const near = this.cities.near(px, pz);
    this.wanted.clear();
    this.nearIds.clear();
    for (let i = 0; i < near.length; i++) {
      const s = near[i];
      this.nearIds.add(s.id);
      for (const o of this.cities.partners(s)) {
        const [a, b] = s.id < o.id ? [s, o] : [o, s];
        const key = a.id + ':' + b.id;
        if (!this.wanted.has(key)) this.wanted.set(key, [a, b]);
      }
    }
    // drop routes whose two cities are both out of range
    for (const [key, r] of this.routes) {
      if (this.nearIds.has(r.a) || this.nearIds.has(r.b)) continue;
      for (const g of r.geos) g.dispose();
      this.group.remove(r.group);
      this.routes.delete(key);
    }
    this.pending.length = 0;
    for (const key of this.wanted.keys()) if (!this.routes.has(key)) this.pending.push(key);
    // nearest first (pop takes from the end)
    this.pending.sort((p, q) => this.dist(q, px, pz) - this.dist(p, px, pz));
  }

  private dist(key: string, px: number, pz: number): number {
    const [a, b] = this.wanted.get(key)!;
    return Math.min(Math.hypot(a.cx - px, a.cz - pz), Math.hypot(b.cx - px, b.cz - pz));
  }

  private build(key: string, A: CitySite, B: CitySite): void {
    const world = this.world;
    const rng = mulberry32((Math.imul(A.id, 73856093) ^ Math.imul(B.id, 19349663) ^ Math.imul(world.seed | 0, 83492791)) >>> 0);
    const dx = B.cx - A.cx;
    const dz = B.cz - A.cz;
    const len = Math.hypot(dx, dz);
    const route: Route = { key, a: A.id, b: B.id, group: new THREE.Group(), geos: [], markers: 0 };
    this.routes.set(key, route);
    route.group.name = 'waymarks-' + key;
    if (len < 1) return;
    const ux = dx / len;
    const uz = dz / len;
    const vx = -uz; // perpendicular (the route's lateral axis, v)
    const vz = ux;
    const path = this.net.route(A, B);
    const camps = this.net.camps(path);
    const t0 = A.radius * EDGE;
    const t1 = len - B.radius * EDGE;
    if (t1 - t0 < SPACING * 0.5) {
      this.group.add(route.group);
      return;
    }
    // the other cities that could stand close to the middle of the route
    const mid = this.cities.near(A.cx + dx * 0.5, A.cz + dz * 0.5);

    const stone = new Writer(8192, 16384);
    const sh = new Shaper(stone);
    const glow: number[] = [];
    const gd: number[] = [];
    const sample = new Float32Array(5);
    const ox = A.cx;
    const oz = A.cz;
    const count = Math.max(2, Math.round((t1 - t0) / SPACING));
    const step = (t1 - t0) / count;
    let side = rng() < 0.5 ? -1 : 1;
    let sinceLarge = 2 + Math.floor(rng() * 5);

    for (let i = 0; i <= count; i++) {
      let t = t0 + step * i + (i === 0 || i === count ? 0 : (rng() * 2 - 1) * JITTER);
      t = Math.min(t1, Math.max(t0, t));
      side = -side;
      // beside the worn path (measured square to it where it runs aslant), clear of the camps
      const sl = routeSlope(path, t);
      const off = (4.6 + rng() * 2.4) * Math.sqrt(1 + sl * sl);
      if (camps.some((c) => Math.abs(c.u - t) < 30 && c.side === side)) continue;
      const lat = routeLat(path, t) + side * off;
      const x = A.cx + ux * t + vx * lat;
      const z = A.cz + uz * t + vz * lat;

      let ok = true;
      for (let c = 0; c < mid.length && ok; c++) {
        const s = mid[c];
        if (Math.hypot(s.cx - x, s.cz - z) < s.radius * KEEP_OUT) ok = false;
      }
      if (!ok) continue;
      let lo = Infinity;
      let hi = -Infinity;
      sample[0] = world.height(x, z);
      sample[1] = world.height(x + 1, z);
      sample[2] = world.height(x - 1, z);
      sample[3] = world.height(x, z + 1);
      sample[4] = world.height(x, z - 1);
      for (let k = 0; k < 5; k++) {
        if (!Number.isFinite(sample[k])) ok = false;
        lo = Math.min(lo, sample[k]);
        hi = Math.max(hi, sample[k]);
      }
      if (!ok || (hi - lo) / 2 > MAX_SLOPE) continue;

      sinceLarge++;
      const large = sinceLarge >= 8 && rng() < 0.45;
      if (large) sinceLarge = 0;
      const sp: Spec = {
        x,
        z,
        y: lo,
        // face the route line
        yaw: Math.atan2(-side * vx, -side * vz),
        height: (large ? 2.8 : 2.0) + rng() * (large ? 0.7 : 1.5),
        variant: Math.floor(rng() * 3),
        large,
        big: rng() < 0.5 ? 0 : 1,
      };
      glow.length = 0;
      buildMarker(sh, sp, rng, ox, oz, glow);
      gd.push(glow[0], glow[1], glow[2], 0.2 + rng() * 0.06, rng());
      route.markers++;
    }

    const mg = stone.geometry();
    const gg = glowGeometry(gd);
    if (mg) {
      mg.boundingSphere!.radius += 1;
      const me = new THREE.Mesh(mg, this.stoneMat);
      me.name = 'waymark-stone';
      me.position.set(ox, 0, oz);
      me.matrixAutoUpdate = false;
      me.updateMatrix();
      route.group.add(me);
      route.geos.push(mg);
    }
    if (gg) {
      bound(gg, 2);
      const me = new THREE.Mesh(gg, this.glowMat);
      me.name = 'waymark-glow';
      me.renderOrder = 2;
      me.position.set(ox, 0, oz);
      me.matrixAutoUpdate = false;
      me.updateMatrix();
      trackViewport(me, this.glowMat);
      route.group.add(me);
      route.geos.push(gg);
    }
    this.group.add(route.group);
  }
}
