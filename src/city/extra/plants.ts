import * as THREE from 'three';
import { BED_SOIL, POOL_LEVEL, Writer } from '../build';
import { MAT, createMasonryMaterial } from '../cityShaders';
import type { Emitter, Extra, ExtraBuilder, ExtraCtx, Solid } from '../extras';
import { bodyFaces } from '../shape';
import type { Building, CityKind, CityPlan, Spot } from '../types';

// Vegetation for the cities: tall fan-crowned trees (a slender ringed trunk, an onion-shaped
// boot and a crown of broad serrated, pleated fans, sometimes with a straw skirt of dead fans
// and ochre seed tassels), low thorny shrubs, reeds standing in the shallows of an oasis pool,
// vines climbing walls that look onto open ground, and potted plants on flat roofs and at the
// foot of street walls.
//
// Draws: every tree goes into one always-visible mesh (they are what you see across the town);
// the small plants are merged per 80 m cell and each cell is hidden beyond HIDE, where it is
// sub-pixel anyway. All of it uses the masonry shader with sway: aInfo.w is the sway weight
// (squared in the shader), 0 at the roots, about 0.3 at a trunk top and up to 0.9 at fan tips.

const TAU = Math.PI * 2;
const CELL = 80;
const HIDE = 260;
const TB = 8; // tree / blocker bucket size, metres

interface Tune {
  /** Trees at density 1: lower and upper bound. */
  trees: [number, number];
  /** Share of the trees for the square, beds and avenues; the rest go to open lots. */
  sq: number;
  bed: number;
  ave: number;
  /** Open lots only when enclosed (courtyards). */
  courtOnly: boolean;
  /** Trees per lot seed (groves). */
  grove: number;
  /** Spacing factor: trunks at least spacing * (h1 + h2) + 0.8 apart. */
  spacing: number;
  shrubs: number;
  vineP: number;
  vines: number;
  roofP: number;
  doorP: number;
  blossom: number;
}

const TUNE: Record<CityKind, Tune> = {
  oasis: { trees: [250, 400], sq: 0.14, bed: 0.22, ave: 0.2, courtOnly: false, grove: 6, spacing: 0.22, shrubs: 900, vineP: 0.3, vines: 220, roofP: 0.24, doorP: 0.3, blossom: 0.5 },
  trade: { trees: [30, 70], sq: 0.3, bed: 0.2, ave: 0.35, courtOnly: false, grove: 2, spacing: 0.3, shrubs: 160, vineP: 0.04, vines: 50, roofP: 0.1, doorP: 0.12, blossom: 0.2 },
  canyon: { trees: [30, 70], sq: 0.25, bed: 0.2, ave: 0.25, courtOnly: false, grove: 3, spacing: 0.28, shrubs: 220, vineP: 0.06, vines: 70, roofP: 0.12, doorP: 0.14, blossom: 0.25 },
  hill: { trees: [40, 90], sq: 0.35, bed: 0.35, ave: 0, courtOnly: true, grove: 2, spacing: 0.28, shrubs: 200, vineP: 0.07, vines: 80, roofP: 0.16, doorP: 0.15, blossom: 0.3 },
};

const key = (i: number, j: number): number => (i + 4096) * 8192 + (j + 4096);
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const byte = (s: number): number => clamp(Math.round(s * 255), 0, 255);

// ------------------------------------------------------------------ geometry

/** One fan on a stalk from (hx, hy, hz): direction a, elevation e, blade radius rb, K pleats. */
function fan(
  w: Writer, hx: number, hy: number, hz: number, a: number, e: number, lp: number, rb: number, K: number,
  s0: number, s1: number, droop: number,
): void {
  const ce = Math.cos(e);
  const Ax = ce * Math.cos(a), Ay = Math.sin(e), Az = ce * Math.sin(a);
  const Sx = -Math.sin(a), Sz = Math.cos(a); // across the fan, horizontal
  // U = S x A: the blade's face normal, upward for a level fan
  const Ux = Az * 0 - Sz * Ay, Uy = Sz * Ax - Sx * Az, Uz = Sx * Ay;
  // stalk: a thin ribbon out to the blade
  const qx = hx + Ax * lp, qy = hy + Ay * lp - lp * 0.12, qz = hz + Az * lp;
  const sm = (s0 + s1) * 0.5;
  w.reserve(4 + 1 + 2 * (K + 1), 6 + 9 * K);
  w.extra = byte(s0);
  const p0 = w.vert(hx + Sx * 0.04, hy, hz + Sz * 0.04, Ux, Uy, Uz, 0, 0);
  const p1 = w.vert(hx - Sx * 0.04, hy, hz - Sz * 0.04, Ux, Uy, Uz, 1, 0);
  w.extra = byte(sm * 0.8);
  const p2 = w.vert(qx - Sx * 0.03, qy, qz - Sz * 0.03, Ux, Uy, Uz, 1, 1);
  const p3 = w.vert(qx + Sx * 0.03, qy, qz + Sz * 0.03, Ux, Uy, Uz, 0, 1);
  w.index3(p0, p1, p2);
  w.index3(p0, p2, p3);
  // blade: a broad half-disc, pleated (ridges and valleys alternate) with a serrated rim
  const c = w.vert(qx, qy, qz, Ux, Uy, Uz, 0.5, 0);
  const phi = 1.25;
  const st = w.nv;
  for (let i = 0; i <= K; i++) {
    const th = -phi + (2 * phi * i) / K;
    const ct = Math.cos(th), sn = Math.sin(th);
    const dx = Ax * ct + Sx * sn, dy = Ay * ct, dz = Az * ct + Sz * sn;
    // in-plane tangent across the pleat, for the pleat's tilted normal
    const Tx = -Ax * sn + Sx * ct, Ty = -Ay * sn, Tz = -Az * sn + Sz * ct;
    const ridge = i & 1 ? 1 : -1;
    const rho = rb * (i & 1 ? 1 : 0.82);
    const pl = ridge * 0.07 * rb;
    let nx = Ux + Tx * ridge * 0.45, ny = Uy + Ty * ridge * 0.45, nz = Uz + Tz * ridge * 0.45;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const dm = droop * rb * 0.25;
    w.extra = byte(sm);
    w.vert(qx + dx * rho * 0.5 + Ux * pl * 0.5, qy + dy * rho * 0.5 + Uy * pl * 0.5 - dm * 0.25, qz + dz * rho * 0.5 + Uz * pl * 0.5, nx, ny, nz, i / K, 0.5);
    w.extra = byte(s1);
    w.vert(qx + dx * rho + Ux * pl, qy + dy * rho + Uy * pl - dm, qz + dz * rho + Uz * pl, nx, ny, nz, i / K, 1);
  }
  for (let i = 0; i < K; i++) {
    const m0 = st + i * 2, r0 = m0 + 1, m1 = m0 + 2, r1 = m0 + 3;
    w.index3(c, m0, m1);
    w.index3(m0, r0, r1);
    w.index3(m0, r1, m1);
  }
  w.extra = 0;
}

/** Ring of `sides` vertices; returns the index of the first. */
function ring(w: Writer, x: number, y: number, z: number, r: number, sides: number, rot: number, s: number, ny: number): number {
  const st = w.nv;
  w.extra = byte(s);
  const k = Math.sqrt(1 - ny * ny);
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TAU;
    const c = Math.cos(a), q = Math.sin(a);
    w.vert(x + c * r, y, z + q * r, c * k, ny, q * k, i / sides, 0);
  }
  return st;
}

function band(w: Writer, a: number, b: number, sides: number): void {
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    w.index3(a + i, a + j, b + j);
    w.index3(a + i, b + j, b + i);
  }
}

function cap(w: Writer, a: number, tip: number, sides: number): void {
  for (let i = 0; i < sides; i++) w.index3(a + i, a + ((i + 1) % sides), tip);
}

/** A fan-crowned tree of height h standing at (x, y, z). Returns the height of the trunk top above y. */
export function tree(w: Writer, x: number, y: number, z: number, h: number, r: () => number): number {
  const sTop = 0.22 + 0.012 * h; // taller trunks bend further
  const la = r() * TAU;
  const lx = Math.cos(la), lz = Math.sin(la);
  const lean = (0.03 + r() * 0.06) * h;
  const bend = (r() - 0.5) * 0.1 * h;
  const top = h - 0.5; // the boot, where the fans spring from
  const r0 = 0.12 + 0.011 * h;
  const rot = r() * TAU;
  const S = 6;
  const T = [-0.04, 0.03, 0.3, 0.62, 1];
  const M = [1.6, 1.1, 0.95, 0.82, 0.72];
  w.mat = MAT.wood;
  const bark = 70 + Math.floor(r() * 70);
  w.reserve(S * 5 + S * 3 + 1, S * 6 * 6 + S * 3);
  let prev = -1;
  let hx = x, hz = z;
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    const tt = Math.max(0, t);
    const ox = lx * lean * tt * tt - lz * bend * Math.sin(Math.PI * tt);
    const oz = lz * lean * tt * tt + lx * bend * Math.sin(Math.PI * tt);
    w.tint = i & 1 ? bark + 25 : bark; // faint ring scars
    const cur = ring(w, x + ox, i === 0 ? y - 0.45 : y + t * top, z + oz, r0 * M[i], S, rot, sTop * tt, 0);
    if (prev >= 0) band(w, prev, cur, S);
    prev = cur;
    hx = x + ox;
    hz = z + oz;
  }
  const hy = y + top;
  const rt = r0 * M[M.length - 1];
  // the boot: an onion-shaped swelling of old stalk bases
  w.tint = Math.max(0, bark - 30);
  const b1 = ring(w, hx, hy + 0.3, hz, rt * 2.0, S, rot + 0.5, sTop, 0.2);
  band(w, prev, b1, S);
  const b2 = ring(w, hx, hy + 0.7, hz, rt * 1.2, S, rot + 0.9, sTop, 0.6);
  band(w, b1, b2, S);
  w.extra = byte(sTop);
  const tip = w.vert(hx, hy + 0.85, hz, 0, 1, 0, 0.5, 1);
  cap(w, b2, tip, S);

  const fy = hy + 0.55;
  // a straw skirt of dead fans hanging under the crown
  if (r() < 0.25 + 0.03 * h) {
    w.mat = MAT.wood;
    w.tint = 170 + Math.floor(r() * 70);
    const n = 6 + Math.floor(r() * 3);
    const len = 0.9 + 0.09 * h;
    for (let k = 0; k < n; k++) {
      const a = rot + (k / n) * TAU + r() * 0.3;
      const c = Math.cos(a), s = Math.sin(a);
      const tx = -s * 0.3, tz = c * 0.3;
      const ra = rt * 1.7, rb = ra + 0.3 + r() * 0.2, l = len * (0.8 + r() * 0.4);
      w.reserve(4, 6);
      w.extra = byte(sTop);
      const v0 = w.vert(hx + c * ra - tx, fy - 0.15, hz + s * ra - tz, c, 0.2, s, 0, 0);
      const v1 = w.vert(hx + c * ra + tx, fy - 0.15, hz + s * ra + tz, c, 0.2, s, 1, 0);
      w.extra = byte(sTop + 0.08);
      const v2 = w.vert(hx + c * rb + tx * 1.3, fy - l, hz + s * rb + tz * 1.3, c, 0.1, s, 1, 1);
      const v3 = w.vert(hx + c * rb - tx * 1.3, fy - l, hz + s * rb - tz * 1.3, c, 0.1, s, 0, 1);
      w.index3(v0, v1, v2);
      w.index3(v0, v2, v3);
    }
  }
  // ochre seed tassels
  if (h > 8 && r() < 0.5) {
    w.mat = MAT.cloth;
    w.tint = Math.floor(r() * 50); // ochre in the dye ramp
    w.extra = 0; // cloth reads aInfo.w as stripes, so no sway
    const n = 2 + Math.floor(r() * 2);
    for (let k = 0; k < n; k++) {
      const a = r() * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      const tx = -s * 0.08, tz = c * 0.08;
      const l = 0.8 + r() * 0.7;
      const ax = hx + c * rt * 2, az = hz + s * rt * 2, bx = hx + c * (rt * 2 + 0.35), bz = hz + s * (rt * 2 + 0.35);
      w.reserve(5, 9);
      const v0 = w.vert(ax - tx, fy + 0.1, az - tz, c, 0, s, 0, 0);
      const v1 = w.vert(ax + tx, fy + 0.1, az + tz, c, 0, s, 1, 0);
      const v2 = w.vert(bx + tx * 1.6, fy - l * 0.6, bz + tz * 1.6, c, 0, s, 1, 0.6);
      const v3 = w.vert(bx - tx * 1.6, fy - l * 0.6, bz - tz * 1.6, c, 0, s, 0, 0.6);
      const v4 = w.vert(bx + c * 0.05, fy - l, bz + s * 0.05, c, 0, s, 0.5, 1);
      w.index3(v0, v1, v2);
      w.index3(v0, v2, v3);
      w.index3(v3, v2, v4);
    }
  }
  // the crown: upper fans held up and out, lower ones older, darker and drooping
  w.mat = MAT.plant;
  const nf = 7 + Math.floor(h / 4) + Math.floor(r() * 2);
  const K = h > 10 ? 8 : 7;
  const rim = 0.62 + 0.02 * h;
  const a0 = r() * TAU;
  for (let k = 0; k < nf; k++) {
    const a = a0 + k * 2.39996 + (r() - 0.5) * 0.3; // golden angle: no two fans in line
    const upper = k < nf * 0.6;
    const e = upper ? 0.3 + r() * 0.65 : -0.15 - r() * 0.45;
    const rb = (0.95 + 0.11 * h) * (upper ? 0.85 + r() * 0.25 : 1 + r() * 0.15);
    w.tint = upper ? 140 + Math.floor(r() * 90) : 70 + Math.floor(r() * 70);
    fan(w, hx, fy + (upper ? 0.1 : -0.1), hz, a, e, 0.35 + 0.05 * h, rb, K, sTop, rim, upper ? 0.6 : 1.4);
  }
  w.extra = 0;
  return top + 0.85;
}

/** A low thorny shrub (or, when thorns is false, a round leafy bush). */
export function shrub(w: Writer, x: number, y: number, z: number, r: number, thorns: boolean, blossom: boolean, rng: () => number): void {
  const n = 5;
  const rot = rng() * TAU;
  const top = y + r * (thorns ? 0.75 + rng() * 0.3 : 1.0 + rng() * 0.4);
  w.mat = MAT.plant;
  w.tint = thorns ? 50 + Math.floor(rng() * 90) : 90 + Math.floor(rng() * 130);
  w.reserve(n * 2 + 1, n * 9);
  const st = ring(w, x, y - 0.05, z, r * 0.6, n, rot, 0, -0.3);
  const mid = w.nv;
  w.extra = byte(0.22);
  for (let k = 0; k < n; k++) {
    const a = rot + ((k + 0.5) / n) * TAU;
    const c = Math.cos(a), s = Math.sin(a);
    const rr = r * (0.85 + 0.3 * rng());
    w.vert(x + c * rr, y + (top - y) * 0.45, z + s * rr, c * 0.8, 0.45, s * 0.8, 0, 0.5);
  }
  w.extra = byte(0.3);
  const tip = w.vert(x, top, z, 0, 1, 0, 0, 1);
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    w.index3(st + k, mid + k, st + k1);
    w.index3(st + k, mid + ((k + n - 1) % n), mid + k);
    w.index3(mid + k, tip, mid + k1);
  }
  if (thorns) {
    // bare thorny twigs poking out of the foliage, each a crossed pair of slivers
    w.mat = MAT.wood;
    w.tint = 60 + Math.floor(rng() * 60);
    const m = 5 + Math.floor(rng() * 4);
    for (let k = 0; k < m; k++) {
      const a = rng() * TAU;
      const el = 0.2 + rng() * 0.9;
      const c = Math.cos(a) * Math.cos(el), s = Math.sin(a) * Math.cos(el), up = Math.sin(el);
      const bx = x + c * r * 0.5, by = y + (top - y) * (0.3 + 0.4 * up), bz = z + s * r * 0.5;
      const l = r * (0.7 + rng() * 0.6);
      const ex = bx + c * l, ey = by + up * l, ez = bz + s * l;
      const t = 0.035;
      w.reserve(6, 6);
      w.extra = byte(0.2);
      const v0 = w.vert(bx - s * t, by, bz + c * t, c, up, s, 0, 0);
      const v1 = w.vert(bx + s * t, by, bz - c * t, c, up, s, 1, 0);
      const v2 = w.vert(bx, by + t, bz, c, up, s, 0, 0);
      const v3 = w.vert(bx, by - t, bz, c, up, s, 1, 0);
      w.extra = byte(0.34);
      const e0 = w.vert(ex, ey, ez, c, up, s, 0.5, 1);
      const e1 = w.vert(ex, ey, ez, c, up, s, 0.5, 1);
      w.index3(v0, v1, e0);
      w.index3(v2, v3, e1);
    }
  }
  if (blossom) {
    // a few tiny blossoms on top, in the cloth dye ramp (ochre, rust or cream)
    w.mat = MAT.cloth;
    const pick = rng();
    w.tint = pick < 0.45 ? 20 : pick < 0.75 ? 160 : 230;
    w.extra = 0;
    const m = 3 + Math.floor(rng() * 3);
    const s = 0.09 + r * 0.05;
    for (let k = 0; k < m; k++) {
      const a = rng() * TAU, d = r * (0.2 + rng() * 0.6);
      const fx = x + Math.cos(a) * d, fz = z + Math.sin(a) * d;
      const fy = y + (top - y) * (1 - (d / r) * 0.5) + 0.03;
      const ra = rng() * TAU;
      w.tri(
        fx + Math.cos(ra) * s, fy, fz + Math.sin(ra) * s,
        fx + Math.cos(ra + 2.1) * s, fy + 0.02, fz + Math.sin(ra + 2.1) * s,
        fx + Math.cos(ra + 4.2) * s, fy, fz + Math.sin(ra + 4.2) * s,
        0, 1, 0,
      );
    }
  }
  w.extra = 0;
}

/** A clump of reeds or spiky grass: n tapering blades bending out from (x, z). */
export function reeds(w: Writer, x: number, y: number, z: number, n: number, hgt: number, heads: boolean, rng: () => number): void {
  for (let k = 0; k < n; k++) {
    const a = rng() * TAU;
    const c = Math.cos(a), s = Math.sin(a);
    const j = rng() * 0.25 * (hgt / 1.6);
    const bx = x + c * j, bz = z + s * j;
    const H = hgt * (0.65 + rng() * 0.5);
    const lean = H * (0.12 + rng() * 0.3);
    const wd = 0.03 + H * 0.012;
    const sx = -s * wd, sz = c * wd;
    const nx = c * 0.95, ny = 0.3, nz = s * 0.95;
    w.mat = MAT.plant;
    w.tint = 90 + Math.floor(rng() * 120);
    w.reserve(5, 9);
    w.extra = 0;
    const v0 = w.vert(bx - sx, y, bz - sz, nx, ny, nz, 0, 0);
    const v1 = w.vert(bx + sx, y, bz + sz, nx, ny, nz, 1, 0);
    const mx = bx + c * lean * 0.3, my = y + H * 0.55, mz = bz + s * lean * 0.3;
    w.extra = byte(0.45);
    const v2 = w.vert(mx + sx * 0.7, my, mz + sz * 0.7, nx, ny, nz, 1, 0.55);
    const v3 = w.vert(mx - sx * 0.7, my, mz - sz * 0.7, nx, ny, nz, 0, 0.55);
    w.extra = byte(0.75);
    const tx = bx + c * lean, ty = y + H, tz = bz + s * lean;
    const v4 = w.vert(tx, ty, tz, nx, ny, nz, 0.5, 1);
    w.index3(v0, v1, v2);
    w.index3(v0, v2, v3);
    w.index3(v3, v2, v4);
    if (heads && rng() < 0.3) {
      // a brown seed head on the upper blade
      w.mat = MAT.wood;
      w.tint = 40 + Math.floor(rng() * 40);
      const ha = 0.72, hb = 0.88;
      const p = (f: number, side: number): [number, number, number] => {
        const ll = f <= 0.55 ? (lean * 0.3 * f) / 0.55 : lean * 0.3 + ((lean * 0.7) * (f - 0.55)) / 0.45;
        return [bx + c * ll + sx * side * 2, y + H * f, bz + s * ll + sz * side * 2];
      };
      const [ax0, ay0, az0] = p(ha, -1), [ax1, ay1, az1] = p(ha, 1), [bx1, by1, bz1] = p(hb, 1), [bx0, by0, bz0] = p(hb, -1);
      w.reserve(4, 6);
      w.extra = byte(0.62);
      const h0 = w.vert(ax0 + nx * 0.02, ay0, az0 + nz * 0.02, nx, ny, nz, 0, 0);
      const h1 = w.vert(ax1 + nx * 0.02, ay1, az1 + nz * 0.02, nx, ny, nz, 1, 0);
      w.extra = byte(0.68);
      const h2 = w.vert(bx1 + nx * 0.02, by1, bz1 + nz * 0.02, nx, ny, nz, 1, 1);
      const h3 = w.vert(bx0 + nx * 0.02, by0, bz0 + nz * 0.02, nx, ny, nz, 0, 1);
      w.index3(h0, h1, h2);
      w.index3(h0, h2, h3);
    }
  }
  w.extra = 0;
}

/** A clay or glazed urn of height about 0.5 s with something growing in it. */
/** Where tall pots register their solids while a city is being built (set by the builder). */
let potSink: Solid[] | null = null;

function pot(w: Writer, x: number, y: number, z: number, s: number, rng: () => number): void {
  const S = 6;
  const rot = rng() * TAU;
  const kind = rng();
  if (kind < 0.55) {
    w.mat = MAT.cloth; // terracotta: the rust of the dye ramp
    w.tint = 140 + Math.floor(rng() * 45);
  } else if (kind < 0.8) {
    w.mat = MAT.dome; // pale glaze
    w.tint = 128;
  } else {
    w.mat = MAT.plaster;
    w.tint = 120 + Math.floor(rng() * 50);
  }
  w.extra = 0;
  const hgt = s * (0.45 + rng() * 0.25);
  // a pot as tall as a step is a post to walk round; shorter ones are stepped over
  if (potSink && hgt >= 0.75) potSink.push({ x, z, hw: 0.27 * s, hd: 0.27 * s, y0: y - 1, y1: y + hgt });
  w.reserve(S * 5 + 1, S * 6 * 3 + S * 3);
  const a = ring(w, x, y - 0.02, z, 0.16 * s, S, rot, 0, -0.4);
  const b = ring(w, x, y + hgt * 0.45, z, 0.27 * s, S, rot, 0, 0);
  const c = ring(w, x, y + hgt * 0.85, z, 0.17 * s, S, rot, 0, 0.3);
  const d = ring(w, x, y + hgt, z, 0.22 * s, S, rot, 0, -0.2);
  band(w, a, b, S);
  band(w, b, c, S);
  band(w, c, d, S);
  w.mat = MAT.soil;
  const e = ring(w, x, y + hgt * 0.93, z, 0.2 * s, S, rot, 0, 1);
  const m = w.vert(x, y + hgt * 0.93, z, 0, 1, 0, 0.5, 0.5);
  cap(w, e, m, S);
  const ty = y + hgt * 0.93;
  const p = rng();
  if (p < 0.45) {
    // a young fan tree
    w.mat = MAT.plant;
    const n = 3 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      w.tint = 120 + Math.floor(rng() * 100);
      fan(w, x, ty, z, rng() * TAU, 0.5 + rng() * 0.6, 0.25 * s, (0.3 + rng() * 0.15) * s, 5, 0.1, 0.5, 0.6);
    }
  } else if (p < 0.75) {
    reeds(w, x, ty, z, 5 + Math.floor(rng() * 3), 0.55 * s, false, rng);
  } else {
    shrub(w, x, ty, z, 0.28 * s, false, rng() < 0.6, rng);
  }
}

/**
 * A vine climbing a wall: stems wandering up from the foot, a leaf pair at each node.
 * The face runs from (ox, oz) along (tx, tz) with outward normal (nx, nz).
 */
function vine(
  w: Writer, ox: number, oz: number, tx: number, tz: number, nx: number, nz: number,
  u0: number, u1: number, top: number, rng: () => number,
): void {
  const stems = 2 + Math.floor(rng() * 3);
  const step = 0.5;
  for (let k = 0; k < stems; k++) {
    let u = u0 + ((k + 0.5) / stems) * (u1 - u0) + (rng() - 0.5) * 0.4;
    let y = -0.1;
    const yt = top * (0.6 + rng() * 0.4);
    const tint = 80 + Math.floor(rng() * 110);
    while (y < yt) {
      const du = (rng() - 0.5) * 0.5;
      const y2 = y + step;
      const u2 = clamp(u + du, u0, u1);
      const sw0 = 0.12 + 0.2 * (y / top), sw1 = 0.12 + 0.2 * (y2 / top);
      const off = 0.04;
      // stem
      w.mat = MAT.wood;
      w.tint = 70;
      w.reserve(4, 6);
      const ax = ox + tx * u + nx * off, az = oz + tz * u + nz * off;
      const bx = ox + tx * u2 + nx * off, bz = oz + tz * u2 + nz * off;
      w.extra = byte(sw0 * 0.7);
      const s0 = w.vert(ax - tx * 0.025, y, az - tz * 0.025, nx, 0, nz, 0, 0);
      const s1 = w.vert(ax + tx * 0.025, y, az + tz * 0.025, nx, 0, nz, 1, 0);
      w.extra = byte(sw1 * 0.7);
      const s2 = w.vert(bx + tx * 0.025, y2, bz + tz * 0.025, nx, 0, nz, 1, 1);
      const s3 = w.vert(bx - tx * 0.025, y2, bz - tz * 0.025, nx, 0, nz, 0, 1);
      w.index3(s0, s1, s2);
      w.index3(s0, s2, s3);
      // leaves: a diamond either side, tipped out from the wall
      w.mat = MAT.plant;
      for (const side of [-1, 1]) {
        if (rng() < 0.2) continue;
        w.tint = clamp(tint + Math.floor((rng() - 0.5) * 60), 0, 255);
        const ls = 0.17 + rng() * 0.15;
        const lu = u2 + side * 0.06, ly = y2 - rng() * 0.2;
        const du2 = side * ls * (0.6 + rng() * 0.5), dy = ls * (rng() - 0.3);
        const lo = 0.07;
        const bxx = ox + tx * lu + nx * lo, bzz = oz + tz * lu + nz * lo;
        const txx = bxx + tx * du2 + nx * ls * 0.5, tzz = bzz + tz * du2 + nz * ls * 0.5;
        const mx = (bxx + txx) / 2, mz = (bzz + tzz) / 2, my = ly + dy / 2;
        const qn = 0.55;
        const lnx = nx * 0.8, lny = 0.45, lnz = nz * 0.8;
        w.reserve(4, 6);
        w.extra = byte(sw1);
        const l0 = w.vert(bxx, ly, bzz, lnx, lny, lnz, 0, 0.5);
        w.extra = byte(sw1 + 0.05);
        const l1 = w.vert(mx, my + ls * qn * 0.5, mz, lnx, lny, lnz, 0.5, 1);
        const l2 = w.vert(txx, ly + dy, tzz, lnx, lny, lnz, 1, 0.5);
        const l3 = w.vert(mx, my - ls * qn * 0.5, mz, lnx, lny, lnz, 0.5, 0);
        w.index3(l0, l1, l2);
        w.index3(l0, l2, l3);
      }
      u = u2;
      y = y2;
    }
  }
  w.extra = 0;
}

// ------------------------------------------------------------------ placement

/** Points (x, z, r) bucketed for quick "is anything within r" checks. */
class Points {
  private m = new Map<number, number[]>();
  private maxR = 0;
  add(x: number, z: number, r: number): void {
    if (r > this.maxR) this.maxR = r;
    const k = key(Math.floor(x / TB), Math.floor(z / TB));
    let l = this.m.get(k);
    if (!l) this.m.set(k, (l = []));
    l.push(x, z, r);
  }
  /** True if a circle of radius r at (x, z) overlaps any point's circle. */
  hit(x: number, z: number, r: number): boolean {
    const p = r + this.maxR;
    for (let j = Math.floor((z - p) / TB); j <= Math.floor((z + p) / TB); j++)
      for (let i = Math.floor((x - p) / TB); i <= Math.floor((x + p) / TB); i++) {
        const l = this.m.get(key(i, j));
        if (!l) continue;
        for (let n = 0; n < l.length; n += 3) {
          const dx = x - l[n], dz = z - l[n + 1], rr = r + l[n + 2];
          if (dx * dx + dz * dz < rr * rr) return true;
        }
      }
    return false;
  }
}

interface Face {
  ox: number;
  oz: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  len: number;
}

/** The building's straight walls as drawn (turned and inset for a slumped house; none on a round one). */
function facesOf(b: Building): Face[] {
  return bodyFaces(b);
}

/** Clear ground between a trunk (its edge) and the nearest person at a spot. */
export const SPOT_CLEAR = 2.5;

/**
 * Furthest a person stands from a spot's centre, as people.ts lays out its slots: a ring of up
 * to 10 round a gathering or well, a keeper and a row of browsers 1.4 m in front of a stall or
 * market, a short row for the rest.
 */
export function spotRing(s: Spot): number {
  const cap = Math.max(1, s.capacity);
  switch (s.kind) {
    case 'gather': return 0.6 + 0.11 * Math.min(cap, 10) + 0.15;
    case 'well': return 1.35;
    case 'market':
    case 'stall': return Math.hypot(1.4, ((Math.max(1, cap - 1) - 1) / 2) * 0.85) + 0.1;
    case 'gate': return Math.hypot(((Math.min(cap, 4) - 1) / 2) * 0.9, 0.6) + 0.1;
    default: return ((Math.min(cap, 4) - 1) / 2) * 0.8 + 0.1;
  }
}

function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax, ez = bz - az;
  const l2 = ex * ex + ez * ez || 1;
  const t = clamp(((px - ax) * ex + (pz - az) * ez) / l2, 0, 1);
  const dx = px - ax - ex * t, dz = pz - az - ez * t;
  return dx * dx + dz * dz;
}

/**
 * Market areas as padded boxes (x0, z0, x1, z1 each), from clusters of market canopies and stalls
 * and the market / stall spots among them, plus the lines (ax, az, bx, bz) joining each market or
 * stall spot to its nearest neighbour within 25 m.
 */
export function marketAreas(plan: CityPlan): { rects: number[]; lines: number[] } {
  const boxes: number[][] = [];
  for (const b of plan.buildings)
    if (!b.solid && (b.role === 'market' || b.role === 'stall')) boxes.push([b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2]);
  const ms = plan.spots.filter((s) => s.kind === 'market' || s.kind === 'stall');
  // spots join a cluster only when they lie among its canopies
  const near = (a: number[], b: number[], g: number): boolean => a[0] < b[2] + g && b[0] < a[2] + g && a[1] < b[3] + g && b[1] < a[3] + g;
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++)
      for (let j = i + 1; j < boxes.length; j++)
        if (near(boxes[i], boxes[j], 8)) {
          const a = boxes[i], b = boxes[j];
          boxes[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
          boxes.splice(j, 1);
          merged = true;
          break;
        }
  }
  const rects: number[] = [];
  for (const b of boxes) {
    let [x0, z0, x1, z1] = b;
    for (const s of ms)
      if (s.x > x0 - 4 && s.x < x1 + 4 && s.z > z0 - 4 && s.z < z1 + 4) {
        x0 = Math.min(x0, s.x);
        z0 = Math.min(z0, s.z);
        x1 = Math.max(x1, s.x);
        z1 = Math.max(z1, s.z);
      }
    const p = 2 + spotRing({ x: 0, z: 0, kind: 'market', facing: 0, capacity: 6 });
    rects.push(x0 - p, z0 - p, x1 + p, z1 + p);
  }
  const lines: number[] = [];
  for (let i = 0; i < ms.length; i++) {
    let best = -1, bd = 25 * 25;
    for (let j = 0; j < ms.length; j++) {
      if (j === i) continue;
      const d = (ms[i].x - ms[j].x) ** 2 + (ms[i].z - ms[j].z) ** 2;
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    if (best >= 0) lines.push(ms[i].x, ms[i].z, ms[best].x, ms[best].z);
  }
  return { rects, lines };
}

const isBed = (b: Building): boolean => b.role === 'garden' && !b.solid && b.roof === 'none' && b.h >= 0.4;

export const plants: ExtraBuilder = (ctx: ExtraCtx): Extra => {
  const { plan, site } = ctx;
  const T = TUNE[site.kind];
  const dens = ctx.density;
  const rng = ctx.rng(0x91a7);
  const sq = plan.square;
  const pool = plan.pool;
  const R = site.radius;

  // Things trees keep off that ctx.free does not know about: where people linger (the whole
  // ring they stand in, plus SPOT_CLEAR), lamps, and the walk-through cloth shades and stalls.
  const keep = new Points();
  for (const s of plan.spots) keep.add(s.x, s.z, spotRing(s) + SPOT_CLEAR);
  for (const l of plan.lamps) keep.add(l.x, l.z, 0.9);
  const shades = plan.buildings.filter((b) => !b.solid && (b.roof === 'canopy' || b.role === 'stall'));
  const underShade = (x: number, z: number, pad: number): boolean => {
    for (const b of shades) if (Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad) return true;
    return false;
  };
  // Markets: the open middle between the canopies and the lines between neighbouring stalls are
  // where people browse, so no trunk stands there.
  const markets = marketAreas(plan);
  const inMarket = (x: number, z: number): boolean => {
    for (let i = 0; i < markets.rects.length; i += 4) {
      const m = markets.rects;
      if (x > m[i] && z > m[i + 1] && x < m[i + 2] && z < m[i + 3]) return true;
    }
    const L = markets.lines;
    for (let i = 0; i < L.length; i += 4) if (segDist2(x, z, L[i], L[i + 1], L[i + 2], L[i + 3]) < SPOT_CLEAR * SPOT_CLEAR) return true;
    return false;
  };
  const flat = (x: number, z: number, g: number): boolean =>
    Math.abs(ctx.groundAt(x + 2, z) - g) < 1 && Math.abs(ctx.groundAt(x - 2, z) - g) < 1 &&
    Math.abs(ctx.groundAt(x, z + 2) - g) < 1 && Math.abs(ctx.groundAt(x, z - 2) - g) < 1;
  const inSquare = (x: number, z: number, pad: number): boolean => Math.hypot(x - sq.x, z - sq.z) < sq.r + pad;
  const beds = plan.buildings.filter(isBed);
  const bedAt = (x: number, z: number): boolean => {
    for (const b of beds) if (Math.abs(x - b.x) < b.w / 2 - 0.3 && Math.abs(z - b.z) < b.d / 2 - 0.3) return true;
    return false;
  };

  // ---------------------------------------------------------------- trees

  const tx: number[] = [];
  const tz: number[] = [];
  const th: number[] = [];
  const tb = new Map<number, number[]>();
  const want = Math.round((T.trees[0] + rng() * (T.trees[1] - T.trees[0])) * Math.sqrt(dens));

  /** Places a tree of about height h if the spot is good; returns false if not. */
  const tryTree = (x: number, z: number, h: number): boolean => {
    if (tx.length >= want) return false;
    if (ctx.streetGap(x, z) <= 0.6) return false;
    if (!ctx.free(x, z, 0.9)) return false;
    if (keep.hit(x, z, 0.25) || underShade(x, z, 1.2) || inMarket(x, z)) return false;
    // keep crowns from crowding: the gap grows with both trees' heights
    const gi = Math.floor(x / TB), gj = Math.floor(z / TB);
    for (let j = gj - 1; j <= gj + 1; j++)
      for (let i = gi - 1; i <= gi + 1; i++) {
        const l = tb.get(key(i, j));
        if (!l) continue;
        for (const k of l) {
          const d = T.spacing * (h + th[k]) + 0.8;
          if ((x - tx[k]) ** 2 + (z - tz[k]) ** 2 < d * d) return false;
        }
      }
    // the crown must clear the roofs it spreads over
    const cr = 0.3 * h;
    let roof = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      roof = Math.max(roof, ctx.roofAt(x + Math.cos(a) * cr, z + Math.sin(a) * cr), ctx.roofAt(x + Math.cos(a) * cr * 0.45, z + Math.sin(a) * cr * 0.45));
    }
    if (roof > h - 3) h = roof + 3;
    if (h > 14) return false;
    const g = ctx.groundAt(x, z);
    if (!flat(x, z, g)) return false;
    const n = tx.length;
    tx.push(x);
    tz.push(z);
    th.push(h);
    const kk = key(gi, gj);
    let l = tb.get(kk);
    if (!l) tb.set(kk, (l = []));
    l.push(n);
    ctx.claim(x, z, 1.0);
    return true;
  };
  const height = (lo: number, hi: number): number => lo + (hi - lo) * Math.pow(rng(), 0.8);

  // Round the edge of the square (in an oasis, the ring of beds between the pool path and the edge).
  {
    const quota = Math.round(want * T.sq);
    const start = tx.length;
    // a hill town has few other places for trees, so it plants the inside of its square too
    const r0 = pool ? pool.r + 6.5 : site.kind === 'hill' ? sq.r * 0.45 : sq.r - 0.5;
    const r1 = pool ? sq.r + 1.5 : sq.r + 2.5;
    for (let pass = 0; pass < 3 && tx.length - start < quota; pass++) {
      const n = Math.ceil((TAU * sq.r) / (pool ? 3.5 : 5));
      const a0 = rng() * TAU;
      for (let k = 0; k < n && tx.length - start < quota; k++) {
        const a = a0 + (k / n) * TAU;
        const rr = r0 + Math.sqrt(rng()) * (r1 - r0); // more toward the edge
        tryTree(sq.x + Math.cos(a) * rr, sq.z + Math.sin(a) * rr, height(8, 13));
      }
    }
  }
  // In garden beds.
  {
    const quota = Math.round(want * T.bed);
    const start = tx.length;
    const per = site.kind === 'oasis' ? 22 : 40;
    for (const b of beds) {
      if (tx.length - start >= quota) break;
      if (Math.min(b.w, b.d) < 2.5) continue;
      const n = Math.floor((b.w * b.d) / per + rng());
      for (let k = 0; k < n * 3 && k < 24; k++) {
        const x = b.x + (rng() - 0.5) * Math.max(0, b.w - 2);
        const z = b.z + (rng() - 0.5) * Math.max(0, b.d - 2);
        tryTree(x, z, height(6, 11));
      }
    }
  }
  // Along both sides of the widest avenues.
  if (T.ave > 0) {
    const quota = Math.round(want * T.ave);
    const start = tx.length;
    let wmax = 0;
    for (const e of plan.edges) wmax = Math.max(wmax, e.width);
    const step = site.kind === 'oasis' ? 7 : 11;
    const p = site.kind === 'oasis' ? 0.85 : 0.6;
    for (const e of plan.edges) {
      if (tx.length - start >= quota) break;
      if (e.width < Math.max(9, wmax - 2)) continue;
      const a = plan.nodes[e.a], b = plan.nodes[e.b];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1) continue;
      const ex = (b.x - a.x) / L, ez = (b.z - a.z) / L;
      for (const side of [-1, 1]) {
        for (let t = rng() * step; t < L; t += step * (0.8 + rng() * 0.4)) {
          if (rng() > p) continue;
          const off = e.width / 2 + 1.4 + rng() * 1.6;
          const x = a.x + ex * t - ez * side * off, z = a.z + ez * t + ex * side * off;
          if (inSquare(x, z, 0)) continue;
          tryTree(x, z, height(8, 13));
        }
      }
    }
  }
  // Open lots and courtyards, in small groves.
  {
    const enclosed = (x: number, z: number): boolean => {
      let walls = 0;
      for (let k = 0; k < 8; k++) {
        const c = Math.cos((k / 8) * TAU), s = Math.sin((k / 8) * TAU);
        for (let d = 2; d <= 16; d += 1.5)
          if (ctx.roofAt(x + c * d, z + s * d) > 0) {
            walls++;
            break;
          }
      }
      return walls >= 5;
    };
    const lotOk = (x: number, z: number): boolean =>
      !inSquare(x, z, 2) && ctx.streetGap(x, z) > 2.2 && !bedAt(x, z) && (!T.courtOnly || enclosed(x, z));
    const tries = (want - tx.length) * 30 + 200;
    for (let it = 0; it < tries && tx.length < want; it++) {
      const rr = R * 0.95 * Math.sqrt(rng());
      const a = rng() * TAU;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (!lotOk(x, z)) continue;
      // courtyards and the outskirts take smaller trees than the open lots of the town
      const h = T.courtOnly ? height(6, 10) : height(6, 14);
      if (!tryTree(x, z, h)) continue;
      const g = Math.floor(rng() * T.grove);
      for (let k = 0, m = 0; k < g * 3 && m < g; k++) {
        const ga = rng() * TAU, gd = 3 + rng() * 7;
        const gx = x + Math.cos(ga) * gd, gz = z + Math.sin(ga) * gd;
        if (lotOk(gx, gz) && tryTree(gx, gz, T.courtOnly ? height(6, 10) : height(6, 14))) m++;
      }
    }
  }

  const treeW = new Writer(1 << 15, 1 << 16);
  const solids: Solid[] = [];
  potSink = solids;
  for (let i = 0; i < tx.length; i++) {
    const x = tx[i], z = tz[i];
    const y = bedAt(x, z) ? BED_SOIL : ctx.groundAt(x, z);
    const top = tree(treeW, x, y, z, th[i], rng);
    solids.push({ x, z, hw: 0.25, hd: 0.25, y0: y - 1, y1: y + top });
  }

  // ---------------------------------------------------------------- small plants, by cell

  const cells = new Map<number, Writer>();
  const cellW = (x: number, z: number): Writer => {
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    let w = cells.get(k);
    if (!w) cells.set(k, (w = new Writer(2048, 4096)));
    return w;
  };
  let nShrubs = 0, nReeds = 0, nVines = 0, nPots = 0;

  const shrubAt = (x: number, z: number, r: number, inBed: boolean): boolean => {
    if (ctx.streetGap(x, z) <= 0.4 || !ctx.free(x, z, r * 0.8) || underShade(x, z, 0.3) || keep.hit(x, z, 0.3) || inMarket(x, z)) return false;
    const y = inBed ? BED_SOIL : ctx.groundAt(x, z);
    const thorny = !inBed || rng() < 0.4;
    shrub(cellW(x, z), x, y, z, r, thorny, rng() < T.blossom, rng);
    ctx.claim(x, z, r * 0.8);
    nShrubs++;
    return true;
  };
  const shrubWant = Math.round(T.shrubs * dens);
  // at the feet of trees
  for (let i = 0; i < tx.length && nShrubs < shrubWant * 0.4; i++) {
    const n = rng() < (site.kind === 'oasis' ? 0.6 : 0.3) ? 1 + Math.floor(rng() * 2) : 0;
    for (let k = 0; k < n; k++) {
      const a = rng() * TAU, d = 1.3 + rng() * 1.4;
      const x = tx[i] + Math.cos(a) * d, z = tz[i] + Math.sin(a) * d;
      shrubAt(x, z, 0.35 + rng() * 0.4, bedAt(x, z));
    }
  }
  // in the beds
  for (const b of beds) {
    if (nShrubs >= shrubWant * 0.75) break;
    const n = Math.round(((b.w - 0.6) * (b.d - 0.6) * dens) / 6 + rng() * 0.6);
    for (let k = 0; k < n; k++) {
      const x = b.x + (rng() - 0.5) * Math.max(0, b.w - 1.2);
      const z = b.z + (rng() - 0.5) * Math.max(0, b.d - 1.2);
      shrubAt(x, z, 0.3 + rng() * 0.35, true);
    }
  }
  // scattered over the open ground and out into the sand
  for (let it = 0; it < shrubWant * 8 && nShrubs < shrubWant; it++) {
    const rr = R * 1.05 * Math.sqrt(rng());
    const a = rng() * TAU;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    if (inSquare(x, z, 1) || ctx.streetGap(x, z) < 1) continue;
    shrubAt(x, z, 0.3 + rng() * 0.5, false);
  }

  // Reeds standing in the shallows round the inside of the pool rim, in patches.
  if (pool) {
    const ph1 = rng() * TAU, ph2 = rng() * TAU;
    const step = 0.8 / dens;
    const n = Math.floor((TAU * pool.r) / step);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      if (Math.sin(a * 3 + ph1) + 0.6 * Math.sin(a * 7 + ph2) < -0.45) continue;
      for (let row = 0; row < 2; row++) {
        const d = pool.r - 0.3 - row * 0.6 - rng() * 0.5;
        const aa = a + (rng() - 0.5) * (step / pool.r);
        const x = pool.x + Math.cos(aa) * d, z = pool.z + Math.sin(aa) * d;
        reeds(cellW(x, z), x, POOL_LEVEL - 0.25, z, 6 + Math.floor(rng() * 4), 1.4 + rng() * 0.8 - row * 0.3, true, rng);
        nReeds++;
      }
    }
  }

  // Vines on walls that look onto open ground, and potted plants on flat roofs and at the foot of
  // walls beside the street.
  const vineWant = Math.round(T.vines * dens);
  for (const b of plan.buildings) {
    if (!b.solid || (b.role !== 'house' && b.role !== 'hall') || b.h < 3) continue;
    const fs = facesOf(b);
    if (fs.length === 0) continue; // round: nothing to hang a vine or stand a pot against
    const r = rng();
    if (nVines < vineWant && r < T.vineP * 2) {
      for (const f of fs) {
        if (nVines >= vineWant || f.len < 3 || rng() > 0.5) continue;
        const um = f.len / 2;
        const cx = f.ox + f.tx * um, cz = f.oz + f.tz * um;
        // open ground in front, not a lane, and no neighbour against this face
        if (ctx.roofAt(cx + f.nx * 3, cz + f.nz * 3) > 0 || ctx.streetGap(cx + f.nx * 3, cz + f.nz * 3) < 2.5) continue;
        const wv = Math.min(f.len - 1, 1.4 + rng() * 2);
        const u0 = 0.5 + rng() * (f.len - 1 - wv);
        let blocked = false;
        for (let u = u0; u <= u0 + wv; u += 0.7)
          if (ctx.roofAt(f.ox + f.tx * u + f.nx * 0.5, f.oz + f.tz * u + f.nz * 0.5) > 0 || underShade(f.ox + f.tx * u + f.nx * 0.5, f.oz + f.tz * u + f.nz * 0.5, 0)) blocked = true;
        if (blocked) continue;
        vine(cellW(cx, cz), f.ox, f.oz, f.tx, f.tz, f.nx, f.nz, u0, u0 + wv, b.h * (0.55 + rng() * 0.4), rng);
        nVines++;
      }
    }
    // roof pots: only on plain roofs, where nothing else stands
    if ((b.roof === 'flat' || b.roof === 'parapet') && Math.min(b.w, b.d) >= 4 && rng() < T.roofP * dens) {
      const n = 1 + Math.floor(rng() * 4);
      const f = fs[Math.floor(rng() * 4)];
      const u = 0.9 + rng() * Math.max(0, f.len - 1.8 - n * 0.7);
      for (let k = 0; k < n; k++) {
        const x = f.ox + f.tx * (u + k * 0.7) - f.nx * 0.85, z = f.oz + f.tz * (u + k * 0.7) - f.nz * 0.85;
        if (Math.abs(ctx.roofAt(x, z) - b.h) > 0.01) continue; // not under a crown or a neighbour's wall
        pot(cellW(x, z), x, b.h, z, 0.8 + rng() * 0.5, rng);
        nPots++;
      }
    }
    // a pair of pots at the foot of a wall along a street (where doors are)
    if (rng() < T.doorP * dens) {
      for (let tries = 0; tries < 4; tries++) {
        const f = fs[Math.floor(rng() * 4)];
        if (f.len < 3) continue;
        const u = 0.6 + rng() * (f.len - 2.6);
        const ax = f.ox + f.tx * u + f.nx * 0.45, az = f.oz + f.tz * u + f.nz * 0.45;
        const g = ctx.streetGap(ax, az);
        if (g < 0.35 || g > 4) continue;
        const bx = ax + f.tx * 1.4, bz = az + f.tz * 1.4;
        if (!ctx.free(ax, az, 0.28) || !ctx.free(bx, bz, 0.28) || ctx.streetGap(bx, bz) < 0.35) continue;
        const s = 0.9 + rng() * 0.5;
        for (const [x, z] of [[ax, az], [bx, bz]]) {
          pot(cellW(x, z), x, ctx.groundAt(x, z), z, s, rng);
          ctx.claim(x, z, 0.35);
          nPots++;
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------- meshes

  const near = new THREE.Group();
  near.name = 'city-vegetation';
  const mat = createMasonryMaterial(ctx.uniforms, { shadow: true, twoSided: true, sway: true });
  const geos: THREE.BufferGeometry[] = [];
  let tris = treeW.tris;
  treeW.orient();
  const tg = treeW.geometry();
  if (tg) {
    tg.boundingSphere!.radius += 1; // sway
    geos.push(tg);
    const m = new THREE.Mesh(tg, mat);
    m.name = 'city-trees';
    near.add(m);
  }
  const cellMeshes: THREE.Mesh[] = [];
  const bounds: number[] = [];
  for (const w of cells.values()) {
    w.orient();
    const g = w.geometry();
    if (!g) continue;
    tris += w.tris;
    g.boundingSphere!.radius += 0.5;
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.name = 'city-plants-cell';
    m.visible = false;
    near.add(m);
    cellMeshes.push(m);
    const bb = g.boundingBox!;
    bounds.push(bb.min.x, bb.min.z, bb.max.x, bb.max.z);
  }
  potSink = null;
  const bx = new Float32Array(bounds);
  near.userData.triangles = tris;
  // crowns that shade the ground under them (read by Cities into the city map)
  const crowns: number[] = [];
  for (let i = 0; i < tx.length; i++) crowns.push(tx[i], tz[i], 1.2 + 0.22 * th[i]);
  near.userData.crowns = crowns;
  near.userData.counts = { trees: tx.length, shrubs: nShrubs, reeds: nReeds, vines: nVines, pots: nPots };

  // ---------------------------------------------------------------- sound: leaves in the groves

  const emitters: Emitter[] = [];
  {
    const G = 32;
    const groups = new Map<number, { x: number; z: number; n: number }>();
    for (let i = 0; i < tx.length; i++) {
      const k = key(Math.floor(tx[i] / G), Math.floor(tz[i] / G));
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { x: 0, z: 0, n: 0 }));
      g.x += tx[i];
      g.z += tz[i];
      g.n++;
    }
    const list = [...groups.values()].filter((g) => g.n >= 3).sort((a, b) => b.n - a.n).slice(0, 40);
    for (const g of list)
      emitters.push({ x: g.x / g.n, z: g.z / g.n, kind: 'leaves', gain: clamp(0.2 + 0.05 * g.n, 0.2, 0.8), reach: clamp(28 + 2 * g.n, 30, 55) });
  }

  const H2 = HIDE * HIDE;
  return {
    near,
    far: null,
    solids,
    emitters,
    update(_f, p) {
      for (let i = 0; i < cellMeshes.length; i++) {
        const b = i * 4;
        const dx = Math.max(bx[b] - p.x, 0, p.x - bx[b + 2]);
        const dz = Math.max(bx[b + 1] - p.z, 0, p.z - bx[b + 3]);
        cellMeshes[i].visible = dx * dx + dz * dz < H2;
      }
    },
    dispose() {
      for (const g of geos) g.dispose();
      mat.dispose();
      geos.length = 0;
    },
  };
};
