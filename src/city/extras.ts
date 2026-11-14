import * as THREE from 'three';
import type { FrameState, Uniforms } from '../game/contract';
import type { CityPlan, CitySite } from './types';

// Contract for everything added to a city beyond its buildings: plants, water, street
// furniture, birds and smoke, and the worked land around it. Each of these is an "extra":
// a builder function that takes an ExtraCtx and returns meshes plus what the game needs
// to know about them (what blocks the player, what makes sound).
//
// All coordinates are CITY-LOCAL (see types.ts): origin at the city centre, y = 0 at the
// plateau. Outside the paved area the ground is not flat: use ctx.groundAt(x, z).

/**
 * Something that blocks the player and can be stood on: an axis-aligned box in local space.
 * y0..y1 are relative to the plateau. A box only counts when the player's feet are above
 * y0 - 1.7, so a deck on piers (y0 well above the ground) can be walked under and landed on.
 * Trunks, piers and walls have y0 at or below the ground.
 */
export interface Solid {
  x: number;
  z: number;
  /** Half extents along local x and z. */
  hw: number;
  hd: number;
  y0: number;
  y1: number;
}

export type EmitterKind = 'water' | 'leaves' | 'mill' | 'fire' | 'birds';

/** A place that makes a quiet, steady sound. The game turns the nearest of each kind into a level. */
export interface Emitter {
  x: number;
  z: number;
  kind: EmitterKind;
  /** 0..1 loudness at the source. */
  gain: number;
  /** Distance in metres at which it has faded to nothing (default 40). */
  reach?: number;
}

export interface Extra {
  /** Full detail, shown with the full city (player within about 1.5 km). */
  near: THREE.Group;
  /** Optional simplified version for the skyline (1.5 to 9 km): only large things and far lights. */
  far: THREE.Group | null;
  solids: Solid[];
  emitters: Emitter[];
  /** Called every frame while this is the city the player is in or next to. `local` is the player in city-local space. */
  update?(f: FrameState, local: THREE.Vector3): void;
  dispose(): void;
}

export interface ExtraCtx {
  plan: CityPlan;
  site: CitySite;
  /** The shared uniform holders (see contract.ts). Spread them into materials by reference. */
  uniforms: Uniforms;
  /** 1 on desktop, 0.7 on the low tier, 0.35 on phones. Scale counts of small things by it. */
  density: number;
  /** A seeded random stream; the same salt always gives the same stream for this city. */
  rng(salt: number): () => number;
  /** World bearings (atan2(dz, dx)) of the worn tracks leaving the city toward its neighbours. */
  tracks: number[];
  /** Every door cut into a wall: centre on the wall plane, outward normal, width (metres). */
  doors: Door[];
  /** Terrain height relative to the plateau (0 on the paved area, varies outside it). */
  groundAt(x: number, z: number): number;
  /** Height of the building roof over a point (0 on open ground or outside the city grid). */
  roofAt(x: number, z: number): number;
  /**
   * Distance to the edge of the nearest street: negative inside a street (by how far),
   * positive beside it, capped at +24. People walk the streets, so keep them clear.
   */
  streetGap(x: number, z: number): number;
  /** True if a circle of radius r touches no building, pool or earlier claim. */
  free(x: number, z: number, r: number): boolean;
  /** Reserve a circle so later extras keep off it. */
  claim(x: number, z: number, r: number): void;
}

export type ExtraBuilder = (ctx: ExtraCtx) => Extra;

export interface Door {
  x: number;
  z: number;
  nx: number;
  nz: number;
  w: number;
}

// ------------------------------------------------------------------ context

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SB = 32; // street bucket size, metres
const CB = 16; // claim bucket size

export function createExtraCtx(plan: CityPlan, uniforms: Uniforms, density: number, worldHeight: (x: number, z: number) => number, tracks: number[] = [], doors: Door[] = []): ExtraCtx {
  const site = plan.site;
  const co = Math.cos(site.rot);
  const si = Math.sin(site.rot);

  // Streets, bucketed so streetGap is cheap.
  const streets = new Map<number, number[]>();
  const key = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
  plan.edges.forEach((e, k) => {
    const a = plan.nodes[e.a];
    const b = plan.nodes[e.b];
    const pad = e.width / 2 + 24;
    const i0 = Math.floor((Math.min(a.x, b.x) - pad) / SB);
    const i1 = Math.floor((Math.max(a.x, b.x) + pad) / SB);
    const j0 = Math.floor((Math.min(a.z, b.z) - pad) / SB);
    const j1 = Math.floor((Math.max(a.z, b.z) + pad) / SB);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const kk = key(i, j);
        let l = streets.get(kk);
        if (!l) streets.set(kk, (l = []));
        l.push(k);
      }
  });

  const claims = new Map<number, number[]>(); // x, z, r triples, in the bucket of their centre
  let maxClaim = 0;

  const roofAt = (x: number, z: number) => {
    const i = Math.floor(x + plan.gridHalf);
    const j = Math.floor(z + plan.gridHalf);
    if (i < 0 || j < 0 || i >= plan.gridSize || j >= plan.gridSize) return 0;
    return plan.grid[j * plan.gridSize + i];
  };

  return {
    plan,
    site,
    uniforms,
    density,
    tracks,
    doors,
    rng: (salt) => mulberry((site.seed ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0),
    groundAt(x, z) {
      return worldHeight(site.cx + co * x - si * z, site.cz + si * x + co * z) - site.groundY;
    },
    roofAt,
    streetGap(x, z) {
      const l = streets.get(key(Math.floor(x / SB), Math.floor(z / SB)));
      let best = 24;
      if (!l) return best;
      for (const k of l) {
        const e = plan.edges[k];
        const a = plan.nodes[e.a];
        const b = plan.nodes[e.b];
        const ex = b.x - a.x;
        const ez = b.z - a.z;
        const len2 = ex * ex + ez * ez || 1;
        const t = Math.min(1, Math.max(0, ((x - a.x) * ex + (z - a.z) * ez) / len2));
        const d = Math.hypot(x - a.x - ex * t, z - a.z - ez * t) - e.width / 2;
        if (d < best) best = d;
      }
      return best;
    },
    free(x, z, r) {
      if (roofAt(x, z) > 0) return false;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        if (roofAt(x + Math.cos(a) * r, z + Math.sin(a) * r) > 0) return false;
      }
      const p = plan.pool;
      if (p && Math.hypot(x - p.x, z - p.z) < p.r + r) return false;
      const i0 = Math.floor((x - r - maxClaim) / CB);
      const i1 = Math.floor((x + r + maxClaim) / CB);
      const j0 = Math.floor((z - r - maxClaim) / CB);
      const j1 = Math.floor((z + r + maxClaim) / CB);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const l = claims.get(key(i, j));
          if (!l) continue;
          for (let n = 0; n < l.length; n += 3) if (Math.hypot(x - l[n], z - l[n + 1]) < r + l[n + 2]) return false;
        }
      return true;
    },
    claim(x, z, r) {
      if (r > maxClaim) maxClaim = r;
      const kk = key(Math.floor(x / CB), Math.floor(z / CB));
      let l = claims.get(kk);
      if (!l) claims.set(kk, (l = []));
      l.push(x, z, r);
    },
  };
}

/** Looks up which solids stand over a point. Built once per city from all its extras. */
export class SolidIndex {
  private cells = new Map<number, Solid[]>();
  private static readonly C = 8;

  add(s: Solid) {
    const C = SolidIndex.C;
    for (let j = Math.floor((s.z - s.hd) / C); j <= Math.floor((s.z + s.hd) / C); j++)
      for (let i = Math.floor((s.x - s.hw) / C); i <= Math.floor((s.x + s.hw) / C); i++) {
        const k = (i + 4096) * 8192 + (j + 4096);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(s);
      }
  }

  /** Whether (x, y, z), grown by a margin, is inside a solid. */
  contains(x: number, y: number, z: number, m = 0): boolean {
    const C = SolidIndex.C;
    const l = this.cells.get((Math.floor(x / C) + 4096) * 8192 + (Math.floor(z / C) + 4096));
    if (!l) return false;
    for (const s of l) {
      if (Math.abs(x - s.x) <= s.hw + m && Math.abs(z - s.z) <= s.hd + m && y >= s.y0 - m && y <= s.y1 + m) return true;
    }
    return false;
  }

  /** Top of the highest solid over (x, z) that the feet at height y are not underneath, or -Infinity. */
  topAt(x: number, z: number, y: number): number {
    const C = SolidIndex.C;
    const l = this.cells.get((Math.floor(x / C) + 4096) * 8192 + (Math.floor(z / C) + 4096));
    let top = -Infinity;
    if (!l) return top;
    for (const s of l) {
      if (Math.abs(x - s.x) > s.hw || Math.abs(z - s.z) > s.hd) continue;
      if (s.y0 > y + 1.7) continue;
      if (s.y1 > top) top = s.y1;
    }
    return top;
  }
}

export const EMITTER_KINDS: EmitterKind[] = ['water', 'leaves', 'mill', 'fire', 'birds'];
