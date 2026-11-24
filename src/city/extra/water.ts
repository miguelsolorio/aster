import * as THREE from 'three';
import type { Uniforms } from '../../game/contract';
import { warmObject } from '../../render/warm';
import { finish } from '../../world/budget';
import { FOOT, Writer, cylinder, annulus, dome, finial, polyCap, taper } from '../build';
import { MAT, createMasonryMaterial } from '../cityShaders';
import type { Emitter, Extra, ExtraBuilder, ExtraCtx, Solid } from '../extras';
import type { Building, CityPlan } from '../types';

// Water in the cities: a fountain (or a covered well) in the main square, stone-lined runnels
// along the avenues carrying water out from the square, and in the larger cities a raised
// aqueduct that strides in from the desert on arched piers to a cistern tower on the rim.
//
// Everything is merged into one masonry mesh (fountain and runnels), one for the aqueduct and
// one water mesh with its own small shader (the pool's ripples, plus a flow along a channel).

const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

// ------------------------------------------------------------------ flowing water material

const NOISE = /* glsl */ `
float ch21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float cvn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ch21(i), ch21(i + vec2(1.0, 0.0)), u.x),
             mix(ch21(i + vec2(0.0, 1.0)), ch21(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const flowVert = /* glsl */ `
attribute vec3 aFlow; // x along the flow, y across it (both pre-scaled), z speed (0 = still)
varying vec3 vW;
varying vec3 vF;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vF = aFlow;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const flowFrag = /* glsl */ `
precision highp float;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uShade;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uTime;
uniform float uNight;
varying vec3 vW;
varying vec3 vF;
${NOISE}
float rip(vec2 q, float s) {
  vec2 d = vec2(uTime * s, 0.0);
  return cvn(q - d * 0.8 + uTime * 0.05) + cvn(q * vec2(2.3, 3.1) - d * 1.9 - uTime * 0.07);
}
void main() {
  vec3 v = normalize(cameraPosition - vW);
  vec2 q = vF.xy;
  float s = vF.z;
  float e = 0.012;
  float r0 = rip(q, s);
  float rx = rip(q + vec2(e, 0.0), s);
  float rz = rip(q + vec2(0.0, e), s);
  float k = 0.015 + 0.025 * min(s, 1.0);
  vec3 n = normalize(vec3(-(rx - r0) / e * k, 1.0, -(rz - r0) / e * k));
  float c = clamp(dot(n, v), 0.0, 1.0);
  float fres = pow(1.0 - c, 3.0);
  vec3 col = mix(uTop, uHorizon, fres * 0.9 + 0.1);
  col = mix(col, uShade * 0.6, 0.2 * c);
  vec3 rf = reflect(-v, n);
  float g = pow(max(dot(rf, uSunDir), 0.0), 220.0);
  col += uSunCol * g * (1.0 - 0.6 * uNight) * 1.5;
  // running water: pale streaks drifting downstream
  float st = smoothstep(0.6, 0.95, cvn(vec2(q.x * 0.6 - uTime * s * 0.9, q.y * 4.0)));
  col = mix(col, mix(uHorizon, uSunCol, 0.35), st * 0.25 * min(s, 1.0) * (1.0 - 0.6 * uNight));
  float dist = length(vW - cameraPosition);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

function createFlowMaterial(shared: Uniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared },
    vertexShader: flowVert,
    fragmentShader: flowFrag,
    side: THREE.DoubleSide,
  });
}

/** Water surfaces: position plus (along, across, speed). Double-sided, so winding does not matter. */
class WaterWriter {
  readonly pos: number[] = [];
  readonly flow: number[] = [];
  readonly idx: number[] = [];

  get tris(): number {
    return this.idx.length / 3;
  }

  vert(x: number, y: number, z: number, along: number, across: number, speed: number): number {
    this.pos.push(x, y, z);
    this.flow.push(along, across, speed);
    return this.pos.length / 3 - 1;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Still water: a flat regular polygon. */
  disc(cx: number, cz: number, r: number, y: number, sides: number, rot: number): void {
    const c = this.vert(cx, y, cz, cx * 0.35, cz * 0.35, 0);
    const first = this.pos.length / 3;
    for (let k = 0; k < sides; k++) {
      const a = rot + (k / sides) * TAU;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      this.vert(x, y, z, x * 0.35, z * 0.35, 0);
    }
    for (let k = 0; k < sides; k++) this.idx.push(c, first + k, first + ((k + 1) % sides));
  }

  geometry(): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array(this.flow), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ small shapes

/** Inward-facing wall of a regular prism (the inside of a basin). */
function innerWall(w: Writer, cx: number, cz: number, r: number, y0: number, y1: number, sides: number, rot: number): void {
  for (let k = 0; k < sides; k++) {
    const a0 = rot + (k / sides) * TAU, a1 = rot + ((k + 1) / sides) * TAU;
    const am = (a0 + a1) / 2;
    const x0 = cx + Math.cos(a0) * r, z0 = cz + Math.sin(a0) * r;
    const x1 = cx + Math.cos(a1) * r, z1 = cz + Math.sin(a1) * r;
    w.quadAuto(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0, -Math.cos(am), 0, -Math.sin(am));
  }
}

/** Flat upward band between two regular polygons (the top of a rim). */
function topBand(w: Writer, cx: number, cz: number, r0: number, r1: number, y: number, sides: number, rot: number): void {
  for (let k = 0; k < sides; k++) {
    const a0 = rot + (k / sides) * TAU, a1 = rot + ((k + 1) / sides) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    w.quad(cx + c0 * r0, y, cz + s0 * r0, cx + c1 * r0, y, cz + s1 * r0, cx + c1 * r1, y, cz + s1 * r1, cx + c0 * r1, y, cz + s0 * r1, 0, 1, 0);
  }
}

/** A box turned to the direction (tx, tz): half length hl along it, half width hw across. No bottom. */
function obox(w: Writer, x: number, z: number, tx: number, tz: number, hl: number, hw: number, y0: number, y1: number): void {
  const nx = -tz, nz = tx;
  const X = (u: number, v: number) => x + tx * u + nx * v;
  const Z = (u: number, v: number) => z + tz * u + nz * v;
  w.quadAuto(X(-hl, -hw), y1, Z(-hl, -hw), X(hl, -hw), y1, Z(hl, -hw), X(hl, hw), y1, Z(hl, hw), X(-hl, hw), y1, Z(-hl, hw), 0, 1, 0);
  w.quadAuto(X(hl, -hw), y0, Z(hl, -hw), X(hl, hw), y0, Z(hl, hw), X(hl, hw), y1, Z(hl, hw), X(hl, -hw), y1, Z(hl, -hw), tx, 0, tz);
  w.quadAuto(X(-hl, -hw), y0, Z(-hl, -hw), X(-hl, hw), y0, Z(-hl, hw), X(-hl, hw), y1, Z(-hl, hw), X(-hl, -hw), y1, Z(-hl, -hw), -tx, 0, -tz);
  w.quadAuto(X(-hl, hw), y0, Z(-hl, hw), X(hl, hw), y0, Z(hl, hw), X(hl, hw), y1, Z(hl, hw), X(-hl, hw), y1, Z(-hl, hw), nx, 0, nz);
  w.quadAuto(X(-hl, -hw), y0, Z(-hl, -hw), X(hl, -hw), y0, Z(hl, -hw), X(hl, -hw), y1, Z(hl, -hw), X(-hl, -hw), y1, Z(-hl, -hw), -nx, 0, -nz);
}

// ------------------------------------------------------------------ lookups

/** Cheap "is anything walk-through (stall, bed, canopy) here" test over the non-solid buildings. */
class SoftIndex {
  private cells = new Map<number, Building[]>();
  private static readonly C = 16;
  constructor(buildings: Building[]) {
    const C = SoftIndex.C;
    for (const b of buildings) {
      if (b.solid) continue;
      for (let j = Math.floor((b.z - b.d / 2) / C); j <= Math.floor((b.z + b.d / 2) / C); j++)
        for (let i = Math.floor((b.x - b.w / 2) / C); i <= Math.floor((b.x + b.w / 2) / C); i++) {
          const k = (i + 4096) * 8192 + (j + 4096);
          let l = this.cells.get(k);
          if (!l) this.cells.set(k, (l = []));
          l.push(b);
        }
    }
  }
  hit(x: number, z: number, r: number): boolean {
    const C = SoftIndex.C;
    for (let j = Math.floor((z - r) / C); j <= Math.floor((z + r) / C); j++)
      for (let i = Math.floor((x - r) / C); i <= Math.floor((x + r) / C); i++) {
        const l = this.cells.get((i + 4096) * 8192 + (j + 4096));
        if (!l) continue;
        for (const b of l) if (Math.abs(x - b.x) < b.w / 2 + r && Math.abs(z - b.z) < b.d / 2 + r) return true;
      }
    return false;
  }
}

/** Distance from a point to a building footprint (0 inside). */
function rectDist(b: Building, x: number, z: number): number {
  const dx = Math.max(0, Math.abs(x - b.x) - b.w / 2);
  const dz = Math.max(0, Math.abs(z - b.z) - b.d / 2);
  return Math.hypot(dx, dz);
}

// ------------------------------------------------------------------ avenues

interface Chain {
  /** Node ids from the square outward. */
  ids: number[];
  x: number[];
  z: number[];
  /** Arc length at each node. */
  cum: number[];
  width: number;
}

/** The avenues as polylines, each from its innermost node at the square out to its end. */
function avenueChains(plan: CityPlan): Chain[] {
  const { nodes, edges, square: sq } = plan;
  const WIDE = 8.5; // avenues are 9..13 m; the ring is 6, lanes and links 2..5
  const adj: number[][] = nodes.map(() => []);
  edges.forEach((e, k) => {
    adj[e.a].push(k);
    adj[e.b].push(k);
  });
  const other = (k: number, n: number) => (edges[k].a === n ? edges[k].b : edges[k].a);
  const d = (n: number) => Math.hypot(nodes[n].x - sq.x, nodes[n].z - sq.z);
  const used = new Uint8Array(edges.length);
  const out: Chain[] = [];
  for (let n = 0; n < nodes.length; n++) {
    if (d(n) > sq.r + 1) continue;
    // only start from the innermost node of an avenue (the centre, or the ring round a pool)
    if (adj[n].some((k) => edges[k].width >= WIDE && d(other(k, n)) < d(n) - 0.5)) continue;
    for (const k0 of adj[n]) {
      if (used[k0] || edges[k0].width < WIDE || d(other(k0, n)) <= d(n)) continue;
      used[k0] = 1;
      const width = edges[k0].width;
      const ids = [n, other(k0, n)];
      for (;;) {
        const cur = ids[ids.length - 1];
        const prev = ids[ids.length - 2];
        let ex = nodes[cur].x - nodes[prev].x;
        let ez = nodes[cur].z - nodes[prev].z;
        const el = Math.hypot(ex, ez) || 1;
        ex /= el;
        ez /= el;
        let best = -1;
        let bestDot = 0.5;
        for (const k of adj[cur]) {
          if (used[k] || edges[k].width !== width) continue;
          const o = other(k, cur);
          const ox = nodes[o].x - nodes[cur].x;
          const oz = nodes[o].z - nodes[cur].z;
          const dot = (ox * ex + oz * ez) / (Math.hypot(ox, oz) || 1);
          if (dot > bestDot) {
            bestDot = dot;
            best = k;
          }
        }
        if (best < 0) break;
        used[best] = 1;
        ids.push(other(best, cur));
      }
      if (ids.length < 3) continue;
      const x = ids.map((i) => nodes[i].x);
      const z = ids.map((i) => nodes[i].z);
      const cum = [0];
      for (let i = 1; i < ids.length; i++) cum.push(cum[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]));
      out.push({ ids, x, z, cum, width });
    }
  }
  return out;
}

/** Point and unit tangent on a chain's centre line at arc length a. */
function chainAt(c: Chain, a: number, out: { x: number; z: number; tx: number; tz: number }): void {
  const n = c.ids.length;
  const pos = (s: number, o: { x: number; z: number }) => {
    s = clamp(s, 0, c.cum[n - 1]);
    let i = 0;
    while (i < n - 2 && c.cum[i + 1] < s) i++;
    const L = c.cum[i + 1] - c.cum[i] || 1;
    const f = (s - c.cum[i]) / L;
    o.x = c.x[i] + (c.x[i + 1] - c.x[i]) * f;
    o.z = c.z[i] + (c.z[i + 1] - c.z[i]) * f;
  };
  const p = { x: 0, z: 0 };
  const q = { x: 0, z: 0 };
  pos(a, out);
  pos(a - 3, p);
  pos(a + 3, q);
  const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
  out.tx = (q.x - p.x) / l;
  out.tz = (q.z - p.z) / l;
}

// ------------------------------------------------------------------ builder

export const water: ExtraBuilder = (ctx: ExtraCtx): Extra => finish(waterJob(ctx));

/** The water as a job (see world/budget.ts): it yields between its parts, a span or a run at a time. */
export function* waterJob(ctx: ExtraCtx): Generator<void, Extra> {
  const { plan } = ctx;
  const w = new Writer(4096, 8192);
  const ww = new WaterWriter();
  const solids: Solid[] = [];
  const emitters: Emitter[] = [];
  const soft = new SoftIndex(plan.buildings);
  const chains = avenueChains(plan);
  yield;

  yield* fountain(ctx, w, ww, solids, emitters);
  yield;
  const aq = yield* aqueduct(ctx, chains, soft, ww, solids, emitters);
  yield;
  yield* runnels(ctx, chains, soft, w, ww, emitters);
  yield;

  // ---------------------------------------------------------------- meshes
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const near = new THREE.Group();
  near.name = 'city-water-extra';
  const masonry = createMasonryMaterial(ctx.uniforms, { shadow: true, twoSided: false, sway: false });
  mats.push(masonry);
  const add = (g: THREE.BufferGeometry | null, m: THREE.Material, name: string, y = 0): void => {
    if (!g) return;
    geos.push(g);
    const me = new THREE.Mesh(g, m);
    me.name = name;
    me.position.y = y;
    near.add(me);
  };
  add(w.geometry(), masonry, 'water-stone');
  if (aq) add(aq.w.geometry(), masonry, 'aqueduct', aq.base);
  const flow = createFlowMaterial(ctx.uniforms);
  mats.push(flow);
  add(ww.geometry(), flow, 'water-surface');

  let far: THREE.Group | null = null;
  if (aq) {
    const fg = aq.far.geometry();
    if (fg) {
      far = new THREE.Group();
      far.name = 'aqueduct-far';
      const m = createMasonryMaterial(ctx.uniforms, { shadow: false, twoSided: false, sway: false });
      mats.push(m);
      geos.push(fg);
      const me = new THREE.Mesh(fg, m);
      me.name = 'aqueduct-far';
      me.position.y = aq.base;
      far.add(me);
    }
  }
  near.userData.triangles = w.tris + ww.tris + (aq ? aq.w.tris : 0);

  return {
    near,
    far,
    solids,
    emitters,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      geos.length = 0;
      mats.length = 0;
    },
  };
}

// ------------------------------------------------------------------ the fountain in the square

/**
 * The plan keeps the middle of the square for walkers (the avenues meet at its centre node) and
 * for the 'well' spot people gather round, so the fountain goes where the square is most open:
 * the point farthest from streets, spots, lamps, buildings and the pool, preferring the centre.
 */
function* fountain(ctx: ExtraCtx, w: Writer, ww: WaterWriter, solids: Solid[], emitters: Emitter[]): Generator<void, void> {
  const { plan, site } = ctx;
  const sq = plan.square;
  const covered = site.kind === 'hill' || site.kind === 'canyon';
  const want = covered ? 2.1 : site.kind === 'trade' ? 3.0 : 2.6;
  const reach = sq.r + 14;
  const blds = plan.buildings.filter((b) => rectDist(b, sq.x, sq.z) < reach);
  const spots = plan.spots.filter((s) => Math.hypot(s.x - sq.x, s.z - sq.z) < reach);
  const lamps = plan.lamps.filter((l) => Math.hypot(l.x - sq.x, l.z - sq.z) < reach);
  const P = plan.pool;

  let best = -Infinity;
  let fx = sq.x;
  let fz = sq.z;
  let fc = 0;
  const STEP = 1.25;
  for (let rho = 0; rho < sq.r - 1.5; rho += STEP) {
    yield;
    const n = rho < 0.1 ? 1 : Math.ceil((TAU * rho) / STEP);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + rho * 0.37;
      const x = sq.x + Math.cos(a) * rho;
      const z = sq.z + Math.sin(a) * rho;
      const bias = 0.04 * rho;
      let c = Math.min(sq.r - 1 - rho, want + 0.4);
      if (c - bias <= best) continue;
      c = Math.min(c, ctx.streetGap(x, z));
      if (c - bias <= best) continue;
      if (P) c = Math.min(c, Math.hypot(x - P.x, z - P.z) - P.r - 1.2);
      for (const b of blds) c = Math.min(c, rectDist(b, x, z) - 0.6);
      for (const s of spots) c = Math.min(c, Math.hypot(x - s.x, z - s.z) - 2.2);
      for (const l of lamps) c = Math.min(c, Math.hypot(x - l.x, z - l.z) - 0.5);
      if (c - bias > best) {
        best = c - bias;
        fx = x;
        fz = z;
        fc = c;
      }
    }
  }

  w.mat = MAT.stone;
  w.tint = 170;
  if (covered) {
    // a covered well: an octagonal step, a round well-head, four posts and a pyramid roof
    const R = clamp(fc - 0.3, 1.7, want); // posts on the diagonals stay on the step
    const rot = Math.PI / 8;
    taper(w, fx, fz, R, R, FOOT, 0.15, 8, rot);
    polyCap(w, fx, fz, R, 0.15, 8, rot);
    cylinder(w, fx, fz, 0.95, 0.1, 0.85, 14);
    const st = w.nv;
    const si = w.ni;
    cylinder(w, fx, fz, 0.75, 0.25, 0.85, 14);
    // turn the inner wall of the well-head to face the water
    for (let v = st; v < w.nv; v++) {
      w.nrm[v * 3] = -w.nrm[v * 3];
      w.nrm[v * 3 + 2] = -w.nrm[v * 3 + 2];
    }
    for (let k = si; k < w.ni; k += 3) {
      const t = w.idx[k + 1];
      w.idx[k + 1] = w.idx[k + 2];
      w.idx[k + 2] = t;
    }
    annulus(w, fx, fz, 0.75, 0.95, 0.85, 14, true);
    ww.disc(fx, fz, 0.76, 0.3, 14, 0);
    w.mat = MAT.wood;
    w.tint = 90;
    const pp = 0.95; // posts on the diagonals, inside the step
    const ph = 0.09;
    const top = 2.75;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) w.box(fx + sx * pp - ph, 0.15, fz + sz * pp - ph, fx + sx * pp + ph, top, fz + sz * pp + ph, 1 | 2 | 16 | 32);
    // a beam under the eaves, rope and bucket
    w.box(fx - 1.45, top - 0.14, fz - 0.07, fx + 1.45, top, fz + 0.07, 1 | 2 | 8 | 16 | 32);
    w.box(fx - 0.02, 1.25, fz - 0.02, fx + 0.02, top - 0.14, fz + 0.02, 1 | 2 | 16 | 32);
    w.box(fx - 0.15, 1.0, fz - 0.15, fx + 0.15, 1.25, fz + 0.15, 1 | 2 | 4 | 8 | 16 | 32);
    // eaves and roof
    const e = 1.45;
    w.box(fx - e, top, fz - e, fx + e, top + 0.14, fz + e, 1 | 2 | 4 | 8 | 16 | 32);
    w.mat = MAT.roof;
    w.tint = 200;
    taper(w, fx, fz, e * Math.SQRT2, 0, top + 0.14, top + 1.15, 4, Math.PI / 4);
    w.mat = MAT.stone;
    finial(w, fx, top + 1.1, fz, 0.5);
    solids.push({ x: fx, z: fz, hw: 0.95, hd: 0.95, y0: FOOT, y1: 0.85 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) solids.push({ x: fx + sx * pp, z: fz + sz * pp, hw: ph, hd: ph, y0: 0, y1: top });
    solids.push({ x: fx, z: fz, hw: e, hd: e, y0: top, y1: top + 0.14 });
    ctx.claim(fx, fz, R + 0.4);
  } else {
    // a low fountain: an octagonal basin on a step, a pedestal and a bowl spilling a curtain of water
    const R = clamp(fc - 0.8, 1.6, want); // the step (R + 0.45) keeps clear of streets and spots
    const rot = Math.PI / 8;
    const rim = 0.32;
    const rimY = 0.55;
    const wl = 0.42;
    taper(w, fx, fz, R + 0.45, R + 0.45, FOOT, 0.14, 8, rot);
    topBand(w, fx, fz, R, R + 0.45, 0.14, 8, rot);
    taper(w, fx, fz, R, R, 0.1, rimY, 8, rot);
    topBand(w, fx, fz, R - rim, R, rimY, 8, rot);
    innerWall(w, fx, fz, R - rim, wl - 0.05, rimY, 8, rot);
    ww.disc(fx, fz, R - rim + 0.01, wl, 8, rot);
    const rb = clamp(R * 0.42, 0.8, 1.2);
    taper(w, fx, fz, 0.42, 0.3, wl - 0.05, 1.25, 8, rot);
    taper(w, fx, fz, 0.3, rb, 1.25, 1.55, 8, rot);
    topBand(w, fx, fz, rb - 0.1, rb, 1.6, 8, rot);
    taper(w, fx, fz, rb, rb, 1.55, 1.6, 8, rot);
    ww.disc(fx, fz, rb - 0.09, 1.57, 8, rot);
    taper(w, fx, fz, 0.16, 0.11, 1.57, 2.05, 8, rot);
    finial(w, fx, 2.0, fz, 0.7);
    // the curtain from the lip of the bowl down to the basin, running downward
    const sides = 8;
    const ring: number[] = [];
    for (let k = 0; k <= sides; k++) {
      const a = rot + (k / sides) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      const ac = (k / sides) * TAU * rb * 2;
      ring.push(
        ww.vert(fx + c * (rb + 0.02), 1.58, fz + s * (rb + 0.02), 0, ac, 2),
        ww.vert(fx + c * (rb + 0.16), wl, fz + s * (rb + 0.16), (1.58 - wl) * 3, ac, 2),
      );
    }
    for (let k = 0; k < sides; k++) ww.quad(ring[k * 2], ring[k * 2 + 2], ring[k * 2 + 3], ring[k * 2 + 1]);
    const inR = (R + 0.45) * Math.cos(Math.PI / 8);
    solids.push({ x: fx, z: fz, hw: R * Math.cos(Math.PI / 8), hd: R * Math.cos(Math.PI / 8), y0: FOOT, y1: rimY });
    solids.push({ x: fx, z: fz, hw: rb * 0.9, hd: rb * 0.9, y0: rimY, y1: 1.6 });
    ctx.claim(fx, fz, inR + 0.4);
  }
  w.mat = MAT.plaster;
  w.tint = 128;
  emitters.push({ x: fx, z: fz, kind: 'water', gain: 0.8, reach: 35 });
}

// ------------------------------------------------------------------ runnels along the avenues

const K_TOP = 0.2; // top of the kerbs
const K_WL = 0.12; // water surface
const K_IN = 0.4; // half the channel
const K_OUT = 0.55; // half the whole runnel
const K_BOT = -0.08;

function* runnels(ctx: ExtraCtx, chains: Chain[], soft: SoftIndex, w: Writer, ww: WaterWriter, emitters: Emitter[]): Generator<void, void> {
  const { plan, site } = ctx;
  const sq = plan.square;
  const rng = ctx.rng(0x7a7e);
  const STEP = 4;

  // spots bucketed on an 8 m grid
  const SB = 8;
  const spotCells = new Map<number, number[]>();
  plan.spots.forEach((s, i) => {
    const k = (Math.floor(s.x / SB) + 4096) * 8192 + (Math.floor(s.z / SB) + 4096);
    let l = spotCells.get(k);
    if (!l) spotCells.set(k, (l = []));
    l.push(i);
  });

  const deg = new Int32Array(plan.nodes.length);
  for (const e of plan.edges) {
    deg[e.a]++;
    deg[e.b]++;
  }

  // the widest avenues keep their runnels on every device; the others shrink or go on low tiers
  const order = chains.map((_, i) => i).sort((a, b) => chains[b].width - chains[a].width || a - b);
  const full = Math.max(1, Math.ceil(chains.length * ctx.density));
  const claims: number[] = [];
  const p = { x: 0, z: 0, tx: 0, tz: 0 };

  for (let rank = 0; rank < order.length; rank++) {
    yield;
    const c = chains[order[rank]];
    if (rank >= full && ctx.density < 0.6) continue;
    const side = rng() < 0.5 ? 1 : -1;
    const off = c.width / 2 - 2.1;
    const n = c.ids.length;
    const total = c.cum[n - 1];
    // where the runnel leaves the square and where it stops short of the gate or the town's edge
    let a0 = 0;
    for (; a0 < total; a0 += 1) {
      chainAt(c, a0, p);
      if (Math.hypot(p.x - p.tz * side * off - sq.x, p.z + p.tx * side * off - sq.z) >= sq.r + 1.5) break;
    }
    let a1 = site.kind === 'hill' ? c.cum[n - 2] - 10 : total - 6;
    if (rank >= full) a1 = a0 + (a1 - a0) * 0.5;
    if (a1 - a0 < 12) continue;

    // samples on the runnel's centre line
    const m = Math.ceil((a1 - a0) / STEP) + 1;
    const X = new Float32Array(m), Z = new Float32Array(m), NX = new Float32Array(m), NZ = new Float32Array(m);
    const TX = new Float32Array(m), TZ = new Float32Array(m), G = new Float32Array(m), A = new Float32Array(m);
    const ok = new Uint8Array(m);
    const at = (a: number) => {
      chainAt(c, a, p);
      const nx = -p.tz * side, nz = p.tx * side;
      return { x: p.x + nx * off, z: p.z + nz * off, tx: p.tx, tz: p.tz, nx, nz };
    };
    for (let i = 0; i < m; i++) {
      if ((i & 15) === 15) yield;
      const a = a0 + ((a1 - a0) * i) / (m - 1);
      const q = at(a);
      X[i] = q.x;
      Z[i] = q.z;
      TX[i] = q.tx;
      TZ[i] = q.tz;
      NX[i] = q.nx;
      NZ[i] = q.nz;
      A[i] = a;
      G[i] = ctx.groundAt(q.x, q.z);
      ok[i] = ctx.free(q.x, q.z, 0.7) && !soft.hit(q.x, q.z, 0.7) ? 1 : 0;
    }

    // slabs: where a lane crosses, where someone stands or sits at the runnel, and every so often
    const slabs: Array<{ a: number; len: number }> = [];
    for (let v = 1; v < n - 1; v++) {
      if (deg[c.ids[v]] < 3) continue;
      const q = at(c.cum[v]);
      for (const e of plan.edges) {
        if (e.a !== c.ids[v] && e.b !== c.ids[v]) continue;
        const o = e.a === c.ids[v] ? e.b : e.a;
        if (o === c.ids[v - 1] || o === c.ids[v + 1]) continue;
        const ex = plan.nodes[o].x - c.x[v];
        const ez = plan.nodes[o].z - c.z[v];
        const el = Math.hypot(ex, ez) || 1;
        const s = (ex * q.nx + ez * q.nz) / el;
        if (s < 0.25) continue;
        const t = off / s;
        if (t > el + 1) continue;
        slabs.push({ a: c.cum[v] + ((ex * q.tx + ez * q.tz) / el) * t, len: clamp(e.width / s + 0.4, 1.4, 6) });
      }
    }
    const seen = new Set<number>();
    for (let i = 0; i < m; i++) {
      const bi = Math.floor(X[i] / SB);
      const bj = Math.floor(Z[i] / SB);
      for (let j = bj - 1; j <= bj + 1; j++)
        for (let k = bi - 1; k <= bi + 1; k++) {
          const l = spotCells.get((k + 4096) * 8192 + (j + 4096));
          if (!l) continue;
          for (const si of l) {
            if (seen.has(si)) continue;
            const s = plan.spots[si];
            const dx = s.x - X[i], dz = s.z - Z[i];
            const along = dx * TX[i] + dz * TZ[i];
            if (Math.abs(along) > STEP * 0.6) continue;
            if (Math.abs(dx * NX[i] + dz * NZ[i]) > 1.7) continue;
            seen.add(si);
            slabs.push({ a: A[i] + along, len: 2.0 });
          }
        }
    }
    slabs.sort((u, v) => u.a - v.a);
    yield;

    // contiguous runs of free samples
    for (let i = 0; i < m; ) {
      if (!ok[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < m && ok[j + 1]) j++;
      if (j - i >= 2) {
        buildRun(i, j, i === 0);
        yield;
      }
      i = j + 1;
    }

    function buildRun(i0: number, i1: number, head: boolean): void {
      w.mat = MAT.stone;
      w.tint = 150;
      const P = (k: number, s: number, y: number, o: number[]) => {
        o[0] = X[k] + NX[k] * s;
        o[1] = G[k] + y;
        o[2] = Z[k] + NZ[k] * s;
      };
      const pa = [0, 0, 0], pb = [0, 0, 0], pc = [0, 0, 0], pd = [0, 0, 0];
      const face = (i: number, j: number, s0: number, y0: number, s1: number, y1: number, hx: number, hy: number, hz: number) => {
        P(i, s0, y0, pa);
        P(j, s0, y0, pb);
        P(j, s1, y1, pc);
        P(i, s1, y1, pd);
        w.quadAuto(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2], pc[0], pc[1], pc[2], pd[0], pd[1], pd[2], hx, hy, hz);
      };
      for (let i = i0; i < i1; i++) {
        const j = i + 1;
        for (const sg of [-1, 1]) {
          const hx = NX[i] * sg, hz = NZ[i] * sg;
          face(i, j, sg * K_OUT, K_BOT, sg * K_OUT, K_TOP, hx, 0, hz);
          face(i, j, sg * K_IN, K_TOP, sg * K_OUT, K_TOP, 0, 1, 0);
          face(i, j, sg * K_IN, K_WL, sg * K_IN, K_TOP, -hx, 0, -hz);
        }
      }
      // the water, running away from the square
      const S = 1.6;
      let prev = -1;
      for (let i = i0; i <= i1; i++) {
        P(i, -K_IN, K_WL, pa);
        P(i, K_IN, K_WL, pb);
        const l = ww.vert(pa[0], pa[1], pa[2], A[i] * S, -K_IN * S, 1);
        ww.vert(pb[0], pb[1], pb[2], A[i] * S, K_IN * S, 1);
        if (prev >= 0) ww.quad(prev, l, l + 1, prev + 1);
        prev = l;
      }
      // a head stone where the water comes out of the square, an end stone where it drains
      const g0 = G[i0], g1 = G[i1];
      if (head) obox(w, X[i0] - TX[i0] * 0.5, Z[i0] - TZ[i0] * 0.5, TX[i0], TZ[i0], 0.6, 0.8, g0 + K_BOT, g0 + 0.55);
      else obox(w, X[i0] - TX[i0] * 0.3, Z[i0] - TZ[i0] * 0.3, TX[i0], TZ[i0], 0.4, 0.72, g0 + K_BOT, g0 + 0.3);
      obox(w, X[i1] + TX[i1] * 0.3, Z[i1] + TZ[i1] * 0.3, TX[i1], TZ[i1], 0.4, 0.72, g1 + K_BOT, g1 + 0.3);

      // slabs inside this run, then fill long stretches without one
      const aS = A[i0] + 0.8, aE = A[i1] - 0.8;
      const mine: Array<{ a: number; len: number }> = [];
      for (const s of slabs) if (s.a > aS && s.a < aE && (mine.length === 0 || s.a - mine[mine.length - 1].a > 2.5)) mine.push({ ...s });
      let lastA = A[i0];
      const all: Array<{ a: number; len: number }> = [];
      for (const s of [...mine, { a: Infinity, len: 0 }]) {
        while (s.a - lastA > 42 && lastA + 30 < aE) {
          lastA += 30;
          all.push({ a: lastA, len: 1.3 });
        }
        if (s.a !== Infinity) {
          all.push(s);
          lastA = s.a;
        }
      }
      w.tint = 110;
      for (const s of all) {
        const q = at(s.a);
        const g = ctx.groundAt(q.x, q.z);
        obox(w, q.x, q.z, q.tx, q.tz, s.len / 2, 0.72, g - 0.05, g + 0.27);
      }
      w.tint = 150;

      // sound, and keep plants and furniture off it
      const len = A[i1] - A[i0];
      for (let a = 20; a < len; a += 40) {
        const q = at(A[i0] + a);
        emitters.push({ x: q.x, z: q.z, kind: 'water', gain: 0.35, reach: 18 });
      }
      for (let a = A[i0]; a <= A[i1]; a += 2) {
        const q = at(a);
        claims.push(q.x, q.z);
      }
    }
  }
  for (let i = 0; i < claims.length; i += 2) ctx.claim(claims[i], claims[i + 1], 0.75);
  w.mat = MAT.plaster;
  w.tint = 128;
}


// ------------------------------------------------------------------ the aqueduct

const SPAN = 12; // pier spacing
const PH = 0.8; // pier half thickness along the aqueduct (more for tall piers)
const PW = 1.0; // pier and spandrel half width
const DW = 1.25; // deck half width
const CW = 0.62; // half the water channel on the deck
const KH = 0.45; // kerbs above the deck slab
const DT = 0.6; // deck slab
const DB = KH + DT; // walking surface to deck underside
const SLOPE = 0.004; // a level aqueduct rises this much per metre away from the city
const CH = 3.5; // cistern half size
const SH = 2.6; // spring house half size
// Where the ground falls away (a hill town's mound), the deck comes down in level runs joined by
// stepped cascades instead of standing on ever taller piers.
const HMAX = 16; // tallest pier before the deck steps down
const HT = 10; // pier height a cascade aims for
const DROPMAX = 7.5; // most one cascade drops over a span
const RISE = 0.5; // a walkable step
const FALL = 0.002; // stepped runs fall this much per metre away from the city
const TOWER = 0.5; // a drop tower is this much longer than its pier, each way

interface Run {
  /** From t on, the walking surface is k + slope * (u - t). */
  t: number;
  k: number;
}

interface Route {
  dx: number;
  dz: number;
  tc: number; // cistern centre
  gc: number; // ground at the cistern
  stepped: boolean;
  runs: Run[];
  piers: number[];
  pierG: number[];
  pierH: number[]; // half thickness along
  /** casc[p]: the span from pier p - 1 to pier p is a cascade. */
  casc: boolean[];
  te: number; // face of the spring house
  len: number;
  maxH: number;
  score: number;
}

function runAt(runs: Run[], slope: number, t: number): number {
  let r = runs[0];
  for (let i = 1; i < runs.length && runs[i].t <= t; i++) r = runs[i];
  return r.k + slope * (t - r.t);
}

function* aqueduct(
  ctx: ExtraCtx, chains: Chain[], soft: SoftIndex, ww: WaterWriter, solids: Solid[], emitters: Emitter[],
): Generator<void, { w: Writer; far: Writer; base: number } | null> {
  const { plan, site } = ctx;
  if (site.radius <= 450) return null;
  const rng = ctx.rng(0xa9ed);
  const L = 400 + 300 * rng();
  const LMAX = Math.max(L, Math.min(700, L + 150));
  const STEP = 2; // SPAN is a whole number of these
  const PER = SPAN / STEP;
  const NS = Math.ceil((LMAX + 4 * SH) / STEP) + 2;
  const R = site.radius;
  const hill = site.kind === 'hill';
  const ends = chains.map((c) => Math.atan2(c.z[c.z.length - 1], c.x[c.x.length - 1]));

  // The deck runs along a local axis, so every solid is an exact axis-aligned box.
  const dirs: Array<[number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let best: Route | null = null;
  for (const [dx, dz] of dirs) {
    yield;
    const px = -dz, pz = dx;
    const ang = Math.atan2(dz, dx);
    let gap = Math.PI;
    for (const e of ends) {
      const d = Math.abs(((ang - e + Math.PI * 3) % TAU) - Math.PI);
      if (d < gap) gap = d;
    }
    // the rim: the last thing built along this bearing
    let last = 0;
    for (let t = 0; t < R * 1.35; t += 2) {
      if ((t & 63) === 0) yield;
      for (let s = -10; s <= 10; s += 5) {
        const x = dx * t + px * s, z = dz * t + pz * s;
        if (ctx.roofAt(x, z) > 0 || soft.hit(x, z, 0.5)) last = t;
      }
    }
    let tc = Math.max(last + 12, plan.pool ? Math.hypot(plan.pool.x, plan.pool.z) + plan.pool.r + 12 : 0);
    const lim = tc + 60;
    while (tc < lim && !(ctx.free(dx * tc, dz * tc, CH * 1.5) && !soft.hit(dx * tc, dz * tc, CH + 1))) tc += 3;
    if (tc >= lim) continue;
    const gc = ctx.groundAt(dx * tc, dz * tc);
    // the ground under the deck: highest and lowest across its width, every 2 m from the cistern
    const gHi = new Float32Array(NS);
    const gLo = new Float32Array(NS);
    for (let i = 0; i < NS; i++) {
      if ((i & 31) === 31) yield;
      const t = tc + CH + i * STEP;
      let hi = -Infinity, lo = Infinity;
      for (const s of [-DW, 0, DW]) {
        const g = ctx.groundAt(dx * t + px * s, dz * t + pz * s);
        hi = Math.max(hi, g);
        lo = Math.min(lo, g);
      }
      gHi[i] = hi;
      gLo[i] = lo;
    }
    // A hill town keeps the lowest deck that still clears a head under the first arches and steps
    // down its mound; elsewhere a level deck, stepped only if it would stand too tall.
    for (const h of hill ? [5.5] : [7.5, 10.5, 14]) {
      yield;
      let r = walk(dx, dz, tc, gc, h, gHi, gLo, hill);
      if (!hill && r.maxH > 18) r = walk(dx, dz, tc, gc, h, gHi, gLo, true);
      r.score = gap * 1.2 + (Math.min(r.len, L) / L) * 2 - (h - 7.5) * 0.04 - Math.max(0, r.maxH - HMAX) * 0.15 + rng() * 0.15;
      if (!best || r.score > best.score) best = r;
    }
  }
  if (!best || best.len < 60) return null;

  function walk(
    dx: number, dz: number, tc: number, gc: number, h: number, gHi: Float32Array, gLo: Float32Array, stepped: boolean,
  ): Route {
    const ts = tc + CH;
    const slope = stepped ? -FALL : SLOPE;
    const runs: Run[] = [{ t: ts, k: gc + h }];
    const K = (t: number) => {
      const r = runs[runs.length - 1];
      return r.k + slope * (t - r.t);
    };
    const piers: number[] = [];
    const pierG: number[] = [];
    const pierH: number[] = [];
    const casc: boolean[] = [];
    let te = -1;
    for (let i = 1; i < NS; i++) {
      const t = ts + i * STEP;
      if (t - ts > LMAX) break;
      if (i % PER === 0) {
        const g = Math.min(gLo[i - 1], gLo[i], gLo[Math.min(NS - 1, i + 1)]);
        let H = K(t) - DB - g;
        let c = false;
        if (stepped && H > HMAX && piers.length > 0) {
          // come down over the span ending here, but stay clear of the ground just beyond
          let ahead = -Infinity;
          for (let j = i; j <= Math.min(NS - 1, i + PER); j++) ahead = Math.max(ahead, gHi[j]);
          const drop = Math.min(DROPMAX, H - HT, K(t) - (ahead + 3.5));
          if (drop >= RISE) {
            runs.push({ t, k: K(t) - drop });
            H -= drop;
            c = true;
          }
        }
        piers.push(t);
        pierG.push(g);
        pierH.push(clamp(PH + 0.015 * H, PH, 1.3));
        casc.push(c);
      }
      if (K(t) - gHi[i] < 2.0) {
        // back up to where it meets the slope (a cliff can climb metres between samples)
        te = t - STEP;
        for (let u = t - STEP + 0.25; u < t; u += 0.25) {
          let g = -Infinity;
          for (const s of [-DW, 0, DW]) g = Math.max(g, ctx.groundAt(dx * u - dz * s, dz * u + dx * s));
          if (runAt(runs, slope, u) - g < 2.0) break;
          te = u;
        }
        break;
      }
    }
    if (te < 0) {
      // past the seeded length, end where the deck stands lowest
      let low = Infinity;
      for (let i = Math.ceil(L / STEP); i * STEP <= LMAX && i < NS; i++) {
        const t = ts + i * STEP;
        const c = runAt(runs, slope, t) - gLo[i];
        if (c < low) {
          low = c;
          te = t;
        }
      }
    }
    // nothing within a short span of the spring house
    while (piers.length > 0 && piers[piers.length - 1] + 1.3 + 3 > te) {
      piers.pop();
      pierG.pop();
      pierH.pop();
      casc.pop();
    }
    while (runs.length > 1 && runs[runs.length - 1].t > te - 1) runs.pop();
    // a pier at the head of a cascade becomes a drop tower
    for (let p = 0; p + 1 < piers.length; p++) if (casc[p + 1]) pierH[p] += TOWER;
    let maxH = 0;
    piers.forEach((t, p) => (maxH = Math.max(maxH, runAt(runs, slope, t) - DB - pierG[p])));
    return { dx, dz, tc, gc, stepped, runs, piers, pierG, pierH, casc, te, len: te - ts, maxH, score: 0 };
  }

  // ---------------------------------------------------------------- geometry
  const r = best;
  const { dx, dz } = r;
  const px = -dz, pz = dx;
  const ts = r.tc + CH;
  const slope = r.stepped ? -FALL : SLOPE;
  const Kat = (t: number) => runAt(r.runs, slope, t);
  // cascade spans, centre to centre: inside one the deck's underside is the lower level's
  const cascades: Array<{ a: number; b: number; ku: number; kl: number }> = [];
  for (let p = 1; p < r.piers.length; p++) {
    if (r.casc[p]) cascades.push({ a: r.piers[p - 1], b: r.piers[p], ku: Kat(r.piers[p - 1]), kl: Kat(r.piers[p]) });
  }
  const B = (t: number) => {
    for (const c of cascades) if (t > c.a && t < c.b) return c.kl - DB;
    return Kat(t) - DB;
  };
  const ga = (t: number) => ctx.groundAt(dx * t, dz * t);
  const shc = r.te + SH;
  let gs = Infinity;
  for (const u of [-SH, 0, SH]) for (const v of [-SH, SH]) gs = Math.min(gs, ctx.groundAt(dx * (shc + u) + px * v, dz * (shc + u) + pz * v));
  let gcm = Infinity;
  for (const u of [-CH, 0, CH]) for (const v of [-CH, CH]) gcm = Math.min(gcm, ctx.groundAt(dx * (r.tc + u) + px * v, dz * (r.tc + u) + pz * v));
  gs = Math.min(gs, Kat(r.te) - 2.5); // into the slope where it rises steeply
  const base = Math.min(gcm, gs, ...r.pierG) - 0.6;

  const w = new Writer(2048, 4096);
  const far = new Writer(256, 512);
  w.mat = far.mat = MAT.stone;
  w.tint = far.tint = 140;
  const X = (t: number, s: number) => dx * t + px * s;
  const Z = (t: number, s: number) => dz * t + pz * s;
  const q = (
    t0: number, s0: number, y0: number, t1: number, s1: number, y1: number,
    t2: number, s2: number, y2: number, t3: number, s3: number, y3: number,
    ht: number, hy: number, hs: number,
  ) => {
    w.quadAuto(X(t0, s0), y0, Z(t0, s0), X(t1, s1), y1, Z(t1, s1), X(t2, s2), y2, Z(t2, s2), X(t3, s3), y3, Z(t3, s3), dx * ht + px * hs, hy, dz * ht + pz * hs);
  };
  /** An axis-aligned box from t0..t1 along, s0..s1 across. */
  const tbox = (o: Writer, t0: number, t1: number, s0: number, s1: number, y0: number, y1: number, mask = 55) => {
    const xa = X(t0, s0), xb = X(t1, s1), za = Z(t0, s0), zb = Z(t1, s1);
    o.box(Math.min(xa, xb), y0, Math.min(za, zb), Math.max(xa, xb), y1, Math.max(za, zb), mask);
  };
  const solid = (t0: number, t1: number, s0: number, s1: number, y0: number, y1: number) => {
    const tm = (t0 + t1) / 2, ht = Math.abs(t1 - t0) / 2;
    const sm = (s0 + s1) / 2, hs = Math.abs(s1 - s0) / 2;
    solids.push({ x: X(tm, sm), z: Z(tm, sm), hw: dx !== 0 ? ht : hs, hd: dx !== 0 ? hs : ht, y0, y1 });
  };
  const segs = ctx.density < 0.5 ? 6 : 8;
  // water runs downhill: toward the city on a level deck, away from it down the cascades
  const S = 1.4;
  const along = (t: number) => (r.stepped ? (t - ts) * S : (r.te - t) * S);
  const speed = 0.9;

  // supports: the cistern face, the piers, the spring house face
  const sup: Array<{ t: number; lo: number; hi: number; g: number }> = [{ t: r.tc, lo: r.tc - CH, hi: ts, g: gcm }];
  r.piers.forEach((t, i) => sup.push({ t, lo: t - r.pierH[i], hi: t + r.pierH[i], g: r.pierG[i] }));
  sup.push({ t: shc, lo: r.te, hi: shc + SH, g: gs });

  for (let i = 0; i + 1 < sup.length; i++) {
    yield;
    const L0 = sup[i], L1 = sup[i + 1];
    const a = L0.hi, b = L1.lo;
    const mid = (a + b) / 2, A = (b - a) / 2;
    let gmax = -Infinity, gmn = Infinity;
    for (const t of [a, mid, b]) for (const s of [-PW, PW]) {
      const g = ctx.groundAt(X(t, s), Z(t, s));
      gmax = Math.max(gmax, g);
      gmn = Math.min(gmn, g);
    }
    const Bm = B(mid);
    const H = Bm - 0.7 - gmax;
    const rise = H >= A + 1.8 ? A : Math.min(A, H - 1.2);
    const arch = rise >= 1.0 && A >= 1.5;
    const spring = Bm - 0.7 - rise;
    let y0span: number;
    if (arch) {
      for (const sg of [-1, 1]) {
        for (let k = 0; k < segs; k++) {
          const f0 = Math.PI * (1 - k / segs), f1 = Math.PI * (1 - (k + 1) / segs);
          const t0 = mid + A * Math.cos(f0), t1 = mid + A * Math.cos(f1);
          const y0 = spring + rise * Math.sin(f0), y1 = spring + rise * Math.sin(f1);
          q(t0, sg * PW, y0, t1, sg * PW, y1, t1, sg * PW, B(t1), t0, sg * PW, B(t0), 0, 0, sg);
        }
      }
      for (let k = 0; k < segs; k++) {
        const f0 = Math.PI * (1 - k / segs), f1 = Math.PI * (1 - (k + 1) / segs);
        const t0 = mid + A * Math.cos(f0), t1 = mid + A * Math.cos(f1);
        const y0 = spring + rise * Math.sin(f0), y1 = spring + rise * Math.sin(f1);
        const fm = (f0 + f1) / 2;
        q(t0, -PW, y0, t1, -PW, y1, t1, PW, y1, t0, PW, y0, -Math.cos(fm), -Math.sin(fm), 0);
      }
      // the faces of the piers either side of the opening, up to the springing
      if (i > 0 && spring > L0.g) q(a, -PW, L0.g - 0.5, a, PW, L0.g - 0.5, a, PW, spring, a, -PW, spring, 1, 0, 0);
      if (i + 2 < sup.length && spring > L1.g) q(b, -PW, L1.g - 0.5, b, PW, L1.g - 0.5, b, PW, spring, b, -PW, spring, -1, 0, 0);
      y0span = spring + rise;
      // very tall piers are braced by a lower tier of arches, as on the great viaducts
      if (i > 0 && i + 2 < sup.length && spring - gmax > 18) {
        const s2 = gmax + (spring - gmax) * 0.42;
        const top = s2 + A + 1.1;
        for (let k = 0; k < segs; k++) {
          const f0 = Math.PI * (1 - k / segs), f1 = Math.PI * (1 - (k + 1) / segs);
          const t0 = mid + A * Math.cos(f0), t1 = mid + A * Math.cos(f1);
          const y0 = s2 + A * Math.sin(f0), y1 = s2 + A * Math.sin(f1);
          for (const sg of [-1, 1]) q(t0, sg * PW, y0, t1, sg * PW, y1, t1, sg * PW, top, t0, sg * PW, top, 0, 0, sg);
          const fm = (f0 + f1) / 2;
          q(t0, -PW, y0, t1, -PW, y1, t1, PW, y1, t0, PW, y0, -Math.cos(fm), -Math.sin(fm), 0);
        }
        q(a, -PW, top, b, -PW, top, b, PW, top, a, PW, top, 0, 1, 0);
        solid(a, b, -PW, PW, s2 + A, top);
      }
    } else {
      // too low for an arch: a plain wall down to the ground
      for (const sg of [-1, 1]) q(a, sg * PW, gmn - 0.5, b, sg * PW, gmn - 0.5, b, sg * PW, B(b), a, sg * PW, B(a), 0, 0, sg);
      y0span = gmn - 1;
    }

    // The deck over this span (support centre to support centre, clipped to the end walls), as
    // pieces: one sloping piece, or the treads of a cascade with risers of at most RISE.
    const d0 = Math.max(L0.t, ts), d1 = Math.min(L1.t, r.te);
    const cas = cascades.find((c) => c.a === L0.t && c.b === L1.t);
    // piece j runs from pt[j] to pt[j + 1]; a cascade's first tread runs over the drop tower
    const pt = [d0];
    const lv: number[] = [];
    if (cas) {
      const n = Math.ceil((cas.ku - cas.kl) / RISE - 1e-6);
      const c0 = L0.hi; // the tower's downstream face
      for (let j = 0; j <= n; j++) {
        pt.push(c0 + ((d1 - c0) * j) / (n + 1) + (d1 - c0) / (n + 1));
        lv.push(cas.ku - ((cas.ku - cas.kl) * j) / n);
      }
    } else pt.push(d1);
    const n = pt.length - 1;
    let farLo = Infinity, farHi = -Infinity;
    for (let j = 0; j < n; j++) {
      const t0 = pt[j], t1 = pt[j + 1];
      const k0 = cas ? lv[j] : Kat(t0), k1 = cas ? lv[j] : Kat(t1);
      const b0 = cas ? cas.kl - DB : B(t0), b1 = cas ? cas.kl - DB : B(t1);
      farLo = Math.min(farLo, b0, b1);
      farHi = Math.max(farHi, k0, k1);
      for (const sg of [-1, 1]) {
        q(t0, sg * DW, b0, t1, sg * DW, b1, t1, sg * DW, k1, t0, sg * DW, k0, 0, 0, sg);
        q(t0, sg * PW, b0, t1, sg * PW, b1, t1, sg * DW, b1, t0, sg * DW, b0, 0, -1, 0);
        q(t0, sg * CW, k0, t1, sg * CW, k1, t1, sg * DW, k1, t0, sg * DW, k0, 0, 1, 0);
        q(t0, sg * CW, k0 - 0.16, t1, sg * CW, k1 - 0.16, t1, sg * CW, k1, t0, sg * CW, k0, 0, 0, -sg);
      }
      const v0 = ww.vert(X(t0, -CW), k0 - 0.16, Z(t0, -CW), along(t0), -CW * S, speed);
      ww.vert(X(t1, -CW), k1 - 0.16, Z(t1, -CW), along(t1), -CW * S, speed);
      ww.vert(X(t1, CW), k1 - 0.16, Z(t1, CW), along(t1), CW * S, speed);
      ww.vert(X(t0, CW), k0 - 0.16, Z(t0, CW), along(t0), CW * S, speed);
      ww.quad(v0, v0 + 1, v0 + 2, v0 + 3);
      solid(t0, t1, -DW, DW, y0span, Math.max(k0, k1));
      if (cas && j + 1 < n) {
        // the riser down to the next tread: stone at the kerbs, a little fall of water between
        const kn = lv[j + 1];
        for (const sg of [-1, 1]) q(t1, sg * CW, kn, t1, sg * DW, kn, t1, sg * DW, k1, t1, sg * CW, k1, 1, 0, 0);
        const fa = along(t1);
        const f0 = ww.vert(X(t1, -CW), k1 - 0.16, Z(t1, -CW), fa, -CW * S, speed * 2);
        ww.vert(X(t1, -CW), kn - 0.16, Z(t1, -CW), fa + (k1 - kn) * S * 1.5, -CW * S, speed * 2);
        ww.vert(X(t1, CW), kn - 0.16, Z(t1, CW), fa + (k1 - kn) * S * 1.5, CW * S, speed * 2);
        ww.vert(X(t1, CW), k1 - 0.16, Z(t1, CW), fa, CW * S, speed * 2);
        ww.quad(f0, f0 + 1, f0 + 2, f0 + 3);
      }
    }
    tbox(far, d0, d1, -DW, DW, farLo - 1.0, farHi, 1 | 2 | 4 | 8 | 16 | 32);
  }

  // piers: the long sides from the ground up to the deck; drop towers at the head of each cascade
  r.piers.forEach((t, i) => {
    const g = r.pierG[i];
    const ph = r.pierH[i];
    const tower = i + 1 < r.piers.length && r.casc[i + 1];
    if (tower) {
      const top = Kat(t);
      const tw = DW + 0.35;
      tbox(w, t - ph, t + ph, -tw, tw, g - 0.5, top);
      tbox(w, t - ph - 0.12, t + ph + 0.12, -tw - 0.12, tw + 0.12, top - 0.35, top - 0.1, 1 | 2 | 8 | 16 | 32);
      for (const u of [-1, 1])
        for (const v of [-1, 1]) {
          const mt = t + u * (ph - 0.3), ms = v * (tw - 0.25);
          tbox(w, mt - 0.3, mt + 0.3, ms - 0.25, ms + 0.25, top, top + 0.7, 1 | 2 | 4 | 16 | 32);
          solid(mt - 0.3, mt + 0.3, ms - 0.25, ms + 0.25, top - 1, top + 0.7);
        }
      solid(t - ph, t + ph, -tw, tw, g - 1, top);
      tbox(far, t - ph, t + ph, -tw, tw, g - 0.5, top + 0.7, 1 | 2 | 4 | 16 | 32);
    } else {
      for (const sg of [-1, 1]) q(t - ph, sg * PW, g - 0.5, t + ph, sg * PW, g - 0.5, t + ph, sg * PW, B(t + ph), t - ph, sg * PW, B(t - ph), 0, 0, sg);
      solid(t - ph, t + ph, -PW, PW, g - 1, B(t));
      tbox(far, t - ph, t + ph, -PW, PW, g - 0.5, B(t), 1 | 2 | 16 | 32);
    }
    // a plinth at the foot; tall piers stand on a broad footing
    const H = B(t) - g;
    const fo = H > 12 ? 0.35 : 0.2;
    const fs = (tower ? DW + 0.35 : PW) + fo;
    tbox(w, t - ph - fo, t + ph + fo, -fs, fs, g - 0.5, g + (H > 12 ? H * 0.3 : 0.35), 1 | 2 | 4 | 16 | 32);
    ctx.claim(dx * t, dz * t, tower ? 2.2 : 1.6);
  });

  // the cistern tower on the rim
  const k0 = Kat(ts);
  const ct = k0 + 2.6;
  w.tint = 160;
  tbox(w, r.tc - CH, r.tc + CH, -CH, CH, gcm - 0.6, ct);
  tbox(w, r.tc - CH - 0.15, r.tc + CH + 0.15, -CH - 0.15, CH + 0.15, k0 - 0.2, k0 + 0.15, 1 | 2 | 4 | 8 | 16 | 32);
  tbox(w, r.tc - CH - 0.2, r.tc + CH + 0.2, -CH - 0.2, CH + 0.2, ct - 0.3, ct, 1 | 2 | 8 | 16 | 32);
  for (const u of [-1, 0, 1])
    for (const v of [-1, 0, 1]) {
      if (u === 0 && v === 0) continue;
      const mt = r.tc + u * (CH - 0.45), ms = v * (CH - 0.45);
      tbox(w, mt - 0.45, mt + 0.45, ms - 0.45, ms + 0.45, ct, ct + 0.8, 1 | 2 | 4 | 16 | 32);
    }
  // a dark doorway on the side facing the town
  w.mat = MAT.opening;
  const gd = ga(r.tc - CH);
  q(r.tc - CH - 0.03, -0.7, gd, r.tc - CH - 0.03, 0.7, gd, r.tc - CH - 0.03, 0.7, gd + 2.4, r.tc - CH - 0.03, -0.7, gd + 2.4, -1, 0, 0);
  w.mat = MAT.stone;
  solids.push({ x: dx * r.tc, z: dz * r.tc, hw: CH, hd: CH, y0: gcm - 1, y1: ct });
  ctx.claim(dx * r.tc, dz * r.tc, CH * 1.45);
  emitters.push({ x: dx * r.tc, z: dz * r.tc, kind: 'water', gain: 0.5, reach: 30 });
  tbox(far, r.tc - CH, r.tc + CH, -CH, CH, gcm - 0.6, ct + 0.8);

  // the spring house at the far end
  const st = Kat(r.te) + 1.1;
  w.tint = 175;
  tbox(w, shc - SH, shc + SH, -SH, SH, gs - 0.6, st);
  tbox(w, shc - SH - 0.15, shc + SH + 0.15, -SH - 0.15, SH + 0.15, st - 0.25, st, 1 | 2 | 8 | 16 | 32);
  w.mat = MAT.dome;
  dome(w, X(shc, 0), Z(shc, 0), SH - 0.4, st, 1.6, 12, 4, 0.25);
  w.mat = MAT.opening;
  const gd2 = ga(shc + SH);
  if (gd2 + 2.3 < st) q(shc + SH + 0.03, -0.6, gd2, shc + SH + 0.03, 0.6, gd2, shc + SH + 0.03, 0.6, gd2 + 2.1, shc + SH + 0.03, -0.6, gd2 + 2.1, 1, 0, 0);
  w.mat = MAT.stone;
  solids.push({ x: dx * shc, z: dz * shc, hw: SH, hd: SH, y0: gs - 1, y1: st });
  ctx.claim(dx * shc, dz * shc, SH * 1.45);
  emitters.push({ x: dx * shc, z: dz * shc, kind: 'water', gain: 0.5, reach: 30 });
  tbox(far, shc - SH, shc + SH, -SH, SH, gs - 0.6, st + 1.2);
  for (const c of cascades) emitters.push({ x: dx * (c.a + c.b) * 0.5, z: dz * (c.a + c.b) * 0.5, kind: 'water', gain: 0.45, reach: 25 });

  // shift both meshes so their local y is height above their lowest foot (the masonry shader
  // reads local y as height above the plateau for its dust line)
  for (const o of [w, far]) for (let v = 0; v < o.nv; v++) o.pos[v * 3 + 1] -= base;
  return { w, far, base };
}

/** Samples of what this draws beyond the shared city materials, for the shader warm-up (see render/warm.ts). */
export function warmWater(uniforms: Uniforms): THREE.Object3D[] {
  return [warmObject(createFlowMaterial(uniforms), { normals: false })];
}
