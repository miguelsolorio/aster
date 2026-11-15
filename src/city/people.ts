// The inhabitants of the city that is loaded in full.
//
// A pool of up to MAXP cloaked figures follows the player: people only exist within REACH
// metres of the player, arriving from doorways and leaving into them (or fading out of sight),
// so the visible crowd swells and thins smoothly with the time of day.
//
// Simulation is in CITY-LOCAL metres (see types.ts) on the plan's street graph. Walkers follow
// shortest paths (Dijkstra trees, computed lazily per target node and cached per city) toward a
// slot at a spot, or a waypoint node in another quarter; they keep to the right of each street
// with a per-person lateral offset, avoid each other and the player, and every step is checked
// against the 1 m roof grid and the pool so nobody ever stands inside a building or the water,
// and (near the player) against the props and stones the wanderer bumps into, which they walk round.
//
// Rendering: two draw calls. One InstancedBufferGeometry of a robed figure in four silhouettes
// (posed and animated in the vertex shader from per-instance attributes) and one instanced quad
// of soft multiply-blended blob shadows. Both read the same interleaved dynamic buffer, uploaded
// once per frame; colour and seed live in a second buffer that is only touched when someone appears.

import * as THREE from 'three';
import type { FrameState, Uniforms } from '../game/contract';
import { CITY_SHADOW_GLSL } from './cityGlsl';
import { STYLE_GLSL } from '../render/styleGlsl';
import type { CityKind, CityPlan, CitySite, Spot, SpotKind } from './types';
import { CHOSEN, heapGeometry, lampGeometry, pickGeometry, solidMaterial } from '../game/equipment';
import { CREATURE_STEP, type SolidQuery } from '../world/avoid';

const MAXP = 320;
const MINER_MAX = 4;
// hi-vis on purpose: cloth rgb + seed, and a hem rgb + silhouette (3.5, banded), each a loud pair
// so a miner reads across a whole square
const MINER_CLOTH = [1.0, 0.32, 0.0, 0.11, 1.0, 0.08, 0.5, 0.37, 0.0, 0.78, 1.0, 0.63, 0.45, 1.0, 0.05, 0.89];
const MINER_HEM = [1.0, 0.9, 0.05, 3.5, 1.0, 0.85, 0.2, 3.5, 1.0, 1.0, 0.3, 3.5, 0.9, 0.1, 0.8, 3.5];
const DYN = 12; // floats per instance in the dynamic buffer: iA (4), iB (4), iD (4)
const REACH = 300; // people exist within this distance of the player
const RECYCLE = 318; // beyond this they are recycled
const HIDE_DIST = 120; // beyond this, appearing or vanishing is never noticed
const BODY = 0.28; // radius kept clear of walls and water
const PROP_R = HIDE_DIST; // props (fountains, trees, a site's stones) are walked round within this of the player
const DODGE = [0.45, 0.9, 1.3]; // turns tried to get round a prop met square on, smallest first
const DODGE_T = 0.6; // and kept to for this long (s), so the way round is walked, not dithered over
const CELL = 2.5; // neighbour hash cell
const HASH = 2048;
const CRUMBS = 8;
const TAU = Math.PI * 2;

// Phases.
const P_EXIT = 0; // from a doorway or a spot back to the street
const P_WALK = 1; // along an edge toward curN
const P_APPROACH = 2; // from a street node to the approach point of the destination
const P_SLOT = 3; // from the approach point to the slot (or doorway)
const P_DWELL = 4;
const P_FOLLOW = 5; // a child trailing the player for a few seconds
const P_REJOIN = 6; // finding the way back to the street graph
const P_WAIT_EXIT = 7; // waiting for a path tree
const P_WAIT_NODE = 8;
const P_GONE = 9; // fading out

// Spot kinds, plus errands to a waypoint.
const KINDS: SpotKind[] = ['market', 'stall', 'gather', 'shade', 'bench', 'well', 'gate'];
const K_MARKET = 0;
const K_STALL = 1;
const K_GATHER = 2;
const K_SHADE = 3;
const K_BENCH = 4;
const K_WELL = 5;
const K_GATE = 6;
const K_ERRAND = 7;
const NK = 8;

// Visible population against the time of day (0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset).
const POP_D = [0, 0.18, 0.23, 0.28, 0.33, 0.4, 0.46, 0.52, 0.57, 0.63, 0.7, 0.76, 0.82, 0.88, 0.94, 1.0];
const POP_V = [0.05, 0.05, 0.15, 0.6, 0.9, 1.0, 0.75, 0.5, 0.65, 0.95, 1.0, 0.95, 0.75, 0.3, 0.08, 0.05];

/** Fraction of the city's people out and about at this time of day. */
export function populationAt(day: number): number {
  const d = ((day % 1) + 1) % 1;
  for (let k = 0; k + 1 < POP_D.length; k++) {
    if (d <= POP_D[k + 1]) {
      const t = (d - POP_D[k]) / (POP_D[k + 1] - POP_D[k]);
      const s = t * t * (3 - 2 * t);
      return POP_V[k] + (POP_V[k + 1] - POP_V[k]) * s;
    }
  }
  return POP_V[POP_V.length - 1];
}

// Cloth by kind of city. Most people wear one muted colour in the city's own tones; a few
// wear an accent: a bright robe that blends from one colour at the hood to another at the hem.
type RGB = [number, number, number];
interface Cloth {
  base: Array<[number, number, number, number]>; // r, g, b, weight
  accent: Array<[RGB, RGB]>; // hood colour, hem colour
  rate: number; // share of people in an accent robe
}
const DARK: [number, number, number, number] = [0.2, 0.17, 0.16, 1];
const CLOTH: Record<CityKind, Cloth> = {
  hill: {
    base: [[0.72, 0.52, 0.26, 3], [0.84, 0.78, 0.64, 3], [0.62, 0.3, 0.18, 2], [0.64, 0.56, 0.43, 2], DARK],
    accent: [
      [[0.8, 0.24, 0.12], [0.96, 0.68, 0.24]],
      [[0.94, 0.86, 0.66], [0.78, 0.34, 0.16]],
    ],
    rate: 0.2,
  },
  canyon: {
    base: [[0.68, 0.36, 0.24, 3], [0.5, 0.16, 0.14, 2], [0.36, 0.2, 0.3, 2], [0.7, 0.5, 0.44, 2], DARK],
    accent: [
      [[0.82, 0.14, 0.12], [0.46, 0.16, 0.42]],
      [[0.94, 0.46, 0.14], [0.74, 0.12, 0.14]],
    ],
    rate: 0.2,
  },
  oasis: {
    base: [[0.2, 0.46, 0.46, 3], [0.34, 0.48, 0.3, 2], [0.6, 0.72, 0.78, 2], [0.84, 0.8, 0.68, 2], [0.16, 0.2, 0.24, 1]],
    accent: [
      [[0.08, 0.6, 0.62], [0.62, 0.86, 0.54]],
      [[0.2, 0.38, 0.82], [0.14, 0.66, 0.66]],
    ],
    rate: 0.2,
  },
  trade: {
    base: [[0.7, 0.5, 0.26, 2], [0.26, 0.3, 0.5, 2], [0.6, 0.3, 0.2, 2], [0.84, 0.78, 0.66, 2], [0.22, 0.44, 0.44, 1], [0.4, 0.22, 0.34, 1], DARK],
    accent: [
      [[0.96, 0.28, 0.5], [0.98, 0.62, 0.2]],
      [[0.5, 0.24, 0.82], [0.96, 0.32, 0.56]],
      [[0.86, 0.16, 0.56], [0.18, 0.7, 0.7]],
      [[0.98, 0.8, 0.22], [0.94, 0.3, 0.46]],
    ],
    rate: 0.3,
  },
};

// Silhouettes: 0 wide cone, 1 slim with a tall hood, 2 short round elder with a cane, 3 column with a headpiece.
const SHAPES = 4;

/**
 * Pick what one person wears. Writes the hood colour to a[o..o+2] and the hem colour to
 * b[o..o+2], and returns whether the robe is an accent with bands.
 */
function dress(kind: CityKind, rnd: () => number, a: Float32Array, b: Float32Array, o: number): boolean {
  const c = CLOTH[kind];
  if (rnd() < c.rate) {
    const [top, hem] = c.accent[Math.floor(rnd() * c.accent.length) % c.accent.length];
    for (let k = 0; k < 3; k++) {
      a[o + k] = top[k];
      b[o + k] = hem[k];
    }
    return rnd() < 0.5;
  }
  let total = 0;
  for (const p of c.base) total += p[3];
  let r = rnd() * total;
  let p = 0;
  for (; p < c.base.length - 1; p++) {
    r -= c.base[p][3];
    if (r <= 0) break;
  }
  const lum = 0.9 + rnd() * 0.2;
  for (let k = 0; k < 3; k++) a[o + k] = b[o + k] = c.base[p][k] * lum * (0.95 + rnd() * 0.1);
  return false;
}

const bump = (d: number, c: number, w: number) => {
  let x = Math.abs(d - c);
  if (x > 0.5) x = 1 - x;
  x /= w;
  return Math.exp(-x * x);
};
const wrapPi = (a: number) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------------ per-city data

interface Tree {
  next: Int32Array;
  edge: Int32Array;
  dist: Float32Array;
}

class CityData {
  readonly site: CitySite;
  readonly plan: CityPlan;
  readonly R: number;
  readonly G: number;
  readonly H: number;
  readonly grid: Float32Array;
  readonly poolX: number;
  readonly poolZ: number;
  readonly poolR2: number; // with the body margin
  readonly hasPool: boolean;
  readonly co: number;
  readonly si: number;

  // graph
  readonly nN: number;
  readonly nx: Float32Array;
  readonly nz: Float32Array;
  readonly adjS: Int32Array;
  readonly adjN: Int32Array;
  readonly adjE: Int32Array;
  readonly nE: number;
  readonly eA: Int32Array;
  readonly eB: Int32Array;
  readonly eLen: Float32Array;
  readonly eLat: Float32Array;

  // spots
  readonly sN: number;
  readonly sKind: Uint8Array;
  readonly sX: Float32Array;
  readonly sZ: Float32Array;
  readonly sPx: Float32Array; // approach point on the attach edge
  readonly sPz: Float32Array;
  readonly sEdge: Int32Array; // -1: unusable
  readonly sNode: Int32Array; // tree target
  readonly sCent: Float32Array;
  readonly sSlot0: Int32Array;
  readonly sSlotN: Int32Array;
  readonly sSpeaker: Int32Array;
  readonly sSpeakT: Float32Array;
  readonly slotX: Float32Array;
  readonly slotZ: Float32Array;
  readonly slotF: Float32Array;
  readonly slotSpot: Int32Array;
  readonly slotOwner: Int32Array;
  readonly byKind: Int32Array[];

  // doorways
  readonly dN: number;
  readonly dX: Float32Array;
  readonly dZ: Float32Array;
  readonly dF: Float32Array;
  readonly dPx: Float32Array;
  readonly dPz: Float32Array;
  readonly dEdge: Int32Array;
  readonly dW: Float32Array;
  readonly dCdf: Float32Array;
  readonly nodeDoor: Int32Array;

  readonly wp: Int32Array;
  readonly maxCover: number;

  // node buckets for "nearest reachable node"
  private readonly bS: number;
  private readonly bN: number;
  private readonly bStart: Int32Array;
  private readonly bItems: Int32Array;

  private readonly trees: Array<Tree | null>;
  private readonly heapN: Int32Array;
  private readonly heapK: Float32Array;
  budget = 0;

  constructor(site: CitySite, plan: CityPlan) {
    this.site = site;
    this.plan = plan;
    this.R = site.radius;
    this.G = plan.gridSize;
    this.H = plan.gridHalf;
    this.grid = plan.grid;
    this.co = Math.cos(site.rot);
    this.si = Math.sin(site.rot);
    const pool = plan.pool;
    this.hasPool = pool !== null;
    this.poolX = pool ? pool.x : 0;
    this.poolZ = pool ? pool.z : 0;
    this.poolR2 = pool ? (pool.r + 0.35) ** 2 : 0;
    let seed = (site.seed ^ 0x5bd1e995) >>> 0 || 1;
    const rnd = () => {
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed / 4294967296;
    };

    // ---- graph
    const nN = plan.nodes.length;
    this.nN = nN;
    this.nx = new Float32Array(nN);
    this.nz = new Float32Array(nN);
    for (let i = 0; i < nN; i++) {
      this.nx[i] = plan.nodes[i].x;
      this.nz[i] = plan.nodes[i].z;
    }
    const nE = plan.edges.length;
    this.nE = nE;
    this.eA = new Int32Array(nE);
    this.eB = new Int32Array(nE);
    this.eLen = new Float32Array(nE);
    this.eLat = new Float32Array(nE);
    const deg = new Int32Array(nN + 1);
    for (let e = 0; e < nE; e++) {
      const ed = plan.edges[e];
      this.eA[e] = ed.a;
      this.eB[e] = ed.b;
      this.eLen[e] = Math.max(0.01, Math.hypot(this.nx[ed.b] - this.nx[ed.a], this.nz[ed.b] - this.nz[ed.a]));
      deg[ed.a]++;
      deg[ed.b]++;
    }
    this.adjS = new Int32Array(nN + 1);
    for (let i = 0; i < nN; i++) this.adjS[i + 1] = this.adjS[i] + deg[i];
    this.adjN = new Int32Array(nE * 2);
    this.adjE = new Int32Array(nE * 2);
    const fill = new Int32Array(nN);
    for (let e = 0; e < nE; e++) {
      const a = this.eA[e];
      const b = this.eB[e];
      let k = this.adjS[a] + fill[a]++;
      this.adjN[k] = b;
      this.adjE[k] = e;
      k = this.adjS[b] + fill[b]++;
      this.adjN[k] = a;
      this.adjE[k] = e;
    }
    // Safe lateral offset per edge: the widest offset at which both sides of the whole edge are clear.
    for (let e = 0; e < nE; e++) {
      const a = this.eA[e];
      const b = this.eB[e];
      const L = this.eLen[e];
      const ux = (this.nx[b] - this.nx[a]) / L;
      const uz = (this.nz[b] - this.nz[a]) / L;
      let lat = Math.max(0, plan.edges[e].width / 2 - 0.6);
      while (lat > 0) {
        let ok = true;
        for (let s = 0; s <= L + 0.01 && ok; s += 0.7) {
          const t = Math.min(s, L);
          const px = this.nx[a] + ux * t;
          const pz = this.nz[a] + uz * t;
          if (!this.clear(px - uz * lat, pz + ux * lat) || !this.clear(px + uz * lat, pz - ux * lat)) ok = false;
        }
        if (ok) break;
        lat -= 0.25;
      }
      this.eLat[e] = Math.max(0, lat);
    }

    const sq = plan.square;
    const cent = (x: number, z: number) => 0.2 + 1.5 * Math.exp(-Math.hypot(x - sq.x, z - sq.z) / (0.35 * this.R));

    const markets = plan.spots.filter((m) => m.kind === 'market' || m.kind === 'stall');
    // ---- doorways: points in front of a wall beside a street
    const dX: number[] = [];
    const dZ: number[] = [];
    const dF: number[] = [];
    const dPx: number[] = [];
    const dPz: number[] = [];
    const dE: number[] = [];
    const dT: number[] = [];
    for (let e = 0; e < nE; e++) {
      const a = this.eA[e];
      const b = this.eB[e];
      const L = this.eLen[e];
      if (L < 3) continue;
      const ux = (this.nx[b] - this.nx[a]) / L;
      const uz = (this.nz[b] - this.nz[a]) / L;
      const maxProbe = plan.edges[e].width / 2 + 3;
      for (let t = 1.5 + rnd() * 3; t < L - 1.5; t += 6 + rnd() * 3) {
        const px = this.nx[a] + ux * t;
        const pz = this.nz[a] + uz * t;
        if (!this.clear(px, pz)) continue;
        for (const side of [-1, 1]) {
          const ox = -uz * side;
          const oz = ux * side;
          let hit = -1;
          for (let d = 0.5; d <= maxProbe; d += 0.25) {
            const qx = px + ox * d;
            const qz = pz + oz * d;
            if (this.solidAt(qx, qz)) {
              hit = d;
              break;
            }
          }
          if (hit < 0) continue;
          const i = Math.floor(px + ox * hit + this.H);
          const j = Math.floor(pz + oz * hit + this.H);
          if (i < 0 || j < 0 || i >= this.G || j >= this.G || this.grid[j * this.G + i] <= 0) continue; // water, not a wall
          const dd = hit - 0.45;
          if (dd < 0.3) continue;
          const x = px + ox * dd;
          const z = pz + oz * dd;
          if (!this.clear(x, z) || !this.los(px, pz, x, z)) continue;
          dX.push(x);
          dZ.push(z);
          dF.push(Math.atan2(-ox, -oz));
          dPx.push(px);
          dPz.push(pz);
          dE.push(e);
          dT.push(t);
        }
      }
    }
    const dN = dX.length;
    this.dN = dN;
    this.dX = Float32Array.from(dX);
    this.dZ = Float32Array.from(dZ);
    this.dF = Float32Array.from(dF);
    this.dPx = Float32Array.from(dPx);
    this.dPz = Float32Array.from(dPz);
    this.dEdge = Int32Array.from(dE);
    this.dW = new Float32Array(dN);
    this.dCdf = new Float32Array(dN);
    let acc = 0;
    for (let d = 0; d < dN; d++) {
      let w = cent(dX[d], dZ[d]);
      for (const m of markets) {
        if (Math.abs(m.x - dX[d]) < 40 && Math.abs(m.z - dZ[d]) < 40) {
          w += 0.6;
          break;
        }
      }
      this.dW[d] = w;
      acc += w;
      this.dCdf[d] = acc;
    }
    this.nodeDoor = new Int32Array(nN).fill(-1);
    const ndd = new Float32Array(nN).fill(Infinity);
    for (let d = 0; d < dN; d++) {
      const e = dE[d];
      const ta = dT[d];
      const tb = this.eLen[e] - ta;
      if (ta < ndd[this.eA[e]]) {
        ndd[this.eA[e]] = ta;
        this.nodeDoor[this.eA[e]] = d;
      }
      if (tb < ndd[this.eB[e]]) {
        ndd[this.eB[e]] = tb;
        this.nodeDoor[this.eB[e]] = d;
      }
    }

    // ---- spots: attach each to the nearest edge it can be reached from in a straight line
    // The plan's spots, plus doorsteps: people sit or lean by a house wall out of the sun.
    const spotList: Spot[] = plan.spots.slice();
    for (let d = 0, n = 0; d < dN && n < 220; d += 3, n++) spotList.push({ x: dX[d], z: dZ[d], kind: 'shade', facing: dF[d], capacity: 2 });
    const sN = spotList.length;
    this.sN = sN;
    this.sKind = new Uint8Array(sN);
    this.sX = new Float32Array(sN);
    this.sZ = new Float32Array(sN);
    this.sPx = new Float32Array(sN);
    this.sPz = new Float32Array(sN);
    this.sEdge = new Int32Array(sN).fill(-1);
    this.sNode = new Int32Array(sN).fill(-1);
    this.sCent = new Float32Array(sN);
    this.sSlot0 = new Int32Array(sN);
    this.sSlotN = new Int32Array(sN);
    this.sSpeaker = new Int32Array(sN).fill(-1);
    this.sSpeakT = new Float32Array(sN);
    const slX: number[] = [];
    const slZ: number[] = [];
    const slF: number[] = [];
    const slS: number[] = [];
    const ed2 = new Float64Array(nE);
    const edT = new Float64Array(nE);
    const kinds: number[][] = KINDS.map(() => []);
    for (let s = 0; s < sN; s++) {
      const sp = spotList[s];
      const kind = Math.max(0, KINDS.indexOf(sp.kind));
      this.sKind[s] = kind;
      this.sX[s] = sp.x;
      this.sZ[s] = sp.z;
      this.sCent[s] = cent(sp.x, sp.z) + (kind === K_MARKET || kind === K_STALL ? 0.5 : 0);
      for (let e = 0; e < nE; e++) {
        const a = this.eA[e];
        const b = this.eB[e];
        const L = this.eLen[e];
        const ux = (this.nx[b] - this.nx[a]) / L;
        const uz = (this.nz[b] - this.nz[a]) / L;
        const t = clamp((sp.x - this.nx[a]) * ux + (sp.z - this.nz[a]) * uz, 0, L);
        const px = this.nx[a] + ux * t;
        const pz = this.nz[a] + uz * t;
        ed2[e] = (px - sp.x) ** 2 + (pz - sp.z) ** 2;
        edT[e] = t;
      }
      for (let tries = 0; tries < 8; tries++) {
        let best = -1;
        for (let e = 0; e < nE; e++) if (ed2[e] < Infinity && (best < 0 || ed2[e] < ed2[best])) best = e;
        if (best < 0 || ed2[best] > 30 * 30) break;
        const e = best;
        ed2[e] = Infinity;
        const a = this.eA[e];
        const b = this.eB[e];
        const L = this.eLen[e];
        const t = edT[e];
        const px = this.nx[a] + ((this.nx[b] - this.nx[a]) / L) * t;
        const pz = this.nz[a] + ((this.nz[b] - this.nz[a]) / L) * t;
        if (!this.clear(px, pz) || !this.los(px, pz, sp.x, sp.z)) continue;
        this.sEdge[s] = e;
        this.sNode[s] = t < L / 2 ? a : b;
        this.sPx[s] = px;
        this.sPz[s] = pz;
        break;
      }
      // Slots.
      this.sSlot0[s] = slX.length;
      if (this.sEdge[s] < 0) continue;
      const f = sp.facing;
      const fx = Math.sin(f);
      const fz = Math.cos(f);
      const rx = -fz;
      const rz = fx;
      const cap = Math.max(1, sp.capacity);
      const add = (x: number, z: number, face: number) => {
        if (!this.clear(x, z) || !this.los(this.sPx[s], this.sPz[s], x, z)) return false;
        slX.push(x);
        slZ.push(z);
        slF.push(face);
        slS.push(s);
        return true;
      };
      if (kind === K_GATHER || kind === K_WELL) {
        const n = Math.min(cap, kind === K_WELL ? 5 : 10);
        const r0 = kind === K_WELL ? 1.2 : 0.6 + 0.11 * n;
        for (let k = 0; k < n; k++) {
          const a = f + Math.PI + (k * TAU) / n + (rnd() - 0.5) * 0.4;
          const rr = r0 + (rnd() - 0.5) * 0.3;
          const x = sp.x + Math.sin(a) * rr;
          const z = sp.z + Math.cos(a) * rr;
          add(x, z, Math.atan2(sp.x - x, sp.z - z));
        }
      } else if (kind === K_MARKET || kind === K_STALL) {
        // slot 0 is the keeper, behind the goods; the rest browse in front, facing the keeper
        if (!add(sp.x - fx * 0.4, sp.z - fz * 0.4, f)) add(sp.x, sp.z, f);
        const n = Math.max(1, cap - 1);
        for (let k = 0; k < n; k++) {
          const o = (k - (n - 1) / 2) * 0.85;
          add(sp.x + fx * 1.4 + rx * o, sp.z + fz * 1.4 + rz * o, f + Math.PI);
        }
      } else {
        const n = Math.min(cap, 4);
        const step = kind === K_GATE ? 0.9 : 0.8;
        for (let k = 0; k < n; k++) {
          const o = (k - (n - 1) / 2) * step;
          const fwd = kind === K_GATE ? rnd() * 0.6 : 0;
          add(sp.x + rx * o + fx * fwd, sp.z + rz * o + fz * fwd, f);
        }
      }
      if (slX.length === this.sSlot0[s]) add(sp.x, sp.z, f);
      this.sSlotN[s] = slX.length - this.sSlot0[s];
      if (this.sSlotN[s] > 0) kinds[kind].push(s);
    }
    this.slotX = Float32Array.from(slX);
    this.slotZ = Float32Array.from(slZ);
    this.slotF = Float32Array.from(slF);
    this.slotSpot = Int32Array.from(slS);
    this.slotOwner = new Int32Array(slX.length).fill(-1);
    this.byKind = kinds.map((k) => Int32Array.from(k));

    // ---- waypoints: spread over the town by farthest-point sampling
    const wps: number[] = [];
    const minD = new Float32Array(nN).fill(Infinity);
    let first = -1;
    let bestC = Infinity;
    for (let i = 0; i < nN; i++) {
      const d = Math.hypot(this.nx[i] - sq.x, this.nz[i] - sq.z);
      if (d < bestC && this.adjS[i + 1] - this.adjS[i] >= 2) {
        bestC = d;
        first = i;
      }
    }
    if (first < 0 && nN > 0) first = 0;
    for (let k = 0; k < 24 && first >= 0; k++) {
      wps.push(first);
      let far = -1;
      let farD = -1;
      for (let i = 0; i < nN; i++) {
        const d = Math.hypot(this.nx[i] - this.nx[first], this.nz[i] - this.nz[first]);
        if (d < minD[i]) minD[i] = d;
        if (this.adjS[i + 1] - this.adjS[i] >= 2 && minD[i] > farD) {
          farD = minD[i];
          far = i;
        }
      }
      if (far < 0 || farD < 20) break;
      first = far;
    }
    this.wp = Int32Array.from(wps);

    // ---- node buckets
    this.bS = 12;
    this.bN = Math.ceil((2 * this.H) / this.bS) + 1;
    const nb = this.bN * this.bN;
    this.bStart = new Int32Array(nb + 1);
    this.bItems = new Int32Array(nN);
    const bk = new Int32Array(nN);
    for (let i = 0; i < nN; i++) {
      bk[i] = this.bucket(this.nx[i], this.nz[i]);
      this.bStart[bk[i] + 1]++;
    }
    for (let k = 0; k < nb; k++) this.bStart[k + 1] += this.bStart[k];
    const bf = new Int32Array(nb);
    for (let i = 0; i < nN; i++) this.bItems[this.bStart[bk[i]] + bf[bk[i]]++] = i;

    this.trees = new Array<Tree | null>(nN).fill(null);
    this.heapN = new Int32Array(nE * 2 + nN + 4);
    this.heapK = new Float32Array(nE * 2 + nN + 4);
    this.maxCover = Math.max(1e-6, this.coverAt(sq.x, sq.z));
  }

  private bucket(x: number, z: number) {
    const i = clamp(Math.floor((x + this.H) / this.bS), 0, this.bN - 1);
    const j = clamp(Math.floor((z + this.H) / this.bS), 0, this.bN - 1);
    return j * this.bN + i;
  }

  /** True on a solid building, in (or right at the edge of) the pool, or off the grid. */
  solidAt(x: number, z: number): boolean {
    const i = Math.floor(x + this.H);
    const j = Math.floor(z + this.H);
    if (i < 0 || j < 0 || i >= this.G || j >= this.G) return true;
    if (this.grid[j * this.G + i] > 0) return true;
    if (this.hasPool) {
      const dx = x - this.poolX;
      const dz = z - this.poolZ;
      if (dx * dx + dz * dz < this.poolR2) return true;
    }
    return false;
  }

  /** A body can stand here. */
  clear(x: number, z: number): boolean {
    return (
      !this.solidAt(x, z) &&
      !this.solidAt(x + BODY, z) &&
      !this.solidAt(x - BODY, z) &&
      !this.solidAt(x, z + BODY) &&
      !this.solidAt(x, z - BODY)
    );
  }

  los(ax: number, az: number, bx: number, bz: number): boolean {
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / 0.3));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (!this.clear(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }

  /** Sum of doorway weights within reach of a point: how much of the town is around. */
  coverAt(x: number, z: number): number {
    let s = 0;
    const r2 = REACH * REACH;
    for (let d = 0; d < this.dN; d++) {
      const dx = this.dX[d] - x;
      const dz = this.dZ[d] - z;
      if (dx * dx + dz * dz < r2) s += this.dW[d];
    }
    return s;
  }

  sampleDoor(u: number): number {
    const n = this.dN;
    if (n === 0) return -1;
    const v = u * this.dCdf[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.dCdf[m] < v) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /** The nearest node within maxR that can be walked to in a straight line, or -1. */
  nearestLosNode(x: number, z: number, maxR: number): number {
    let last = -1;
    for (let attempt = 0; attempt < 5; attempt++) {
      let best = -1;
      let bestD = Infinity;
      const i0 = clamp(Math.floor((x - maxR + this.H) / this.bS), 0, this.bN - 1);
      const i1 = clamp(Math.floor((x + maxR + this.H) / this.bS), 0, this.bN - 1);
      const j0 = clamp(Math.floor((z - maxR + this.H) / this.bS), 0, this.bN - 1);
      const j1 = clamp(Math.floor((z + maxR + this.H) / this.bS), 0, this.bN - 1);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const b = j * this.bN + i;
          for (let k = this.bStart[b]; k < this.bStart[b + 1]; k++) {
            const n = this.bItems[k];
            const d = Math.hypot(this.nx[n] - x, this.nz[n] - z);
            if (d > maxR || d <= last || d >= bestD) continue;
            best = n;
            bestD = d;
          }
        }
      }
      if (best < 0) return -1;
      if (this.los(x, z, this.nx[best], this.nz[best])) return best;
      last = bestD;
    }
    return -1;
  }

  /** Shortest-path tree toward node t (next hop from every node). Null when this frame's budget is spent. */
  tree(t: number): Tree | null {
    const cached = this.trees[t];
    if (cached) return cached;
    if (this.budget <= 0) return null;
    this.budget--;
    const n = this.nN;
    const tr: Tree = { next: new Int32Array(n).fill(-1), edge: new Int32Array(n).fill(-1), dist: new Float32Array(n).fill(Infinity) };
    const hN = this.heapN;
    const hK = this.heapK;
    let size = 0;
    const push = (node: number, key: number) => {
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hK[p] <= key) break;
        hN[i] = hN[p];
        hK[i] = hK[p];
        i = p;
      }
      hN[i] = node;
      hK[i] = key;
    };
    tr.dist[t] = 0;
    push(t, 0);
    while (size > 0) {
      const u = hN[0];
      const ku = hK[0];
      size--;
      if (size > 0) {
        const ln = hN[size];
        const lk = hK[size];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= size) break;
          if (c + 1 < size && hK[c + 1] < hK[c]) c++;
          if (hK[c] >= lk) break;
          hN[i] = hN[c];
          hK[i] = hK[c];
          i = c;
        }
        hN[i] = ln;
        hK[i] = lk;
      }
      if (ku > tr.dist[u]) continue;
      for (let k = this.adjS[u]; k < this.adjS[u + 1]; k++) {
        const v = this.adjN[k];
        const e = this.adjE[k];
        const nd = ku + this.eLen[e];
        if (nd < tr.dist[v]) {
          tr.dist[v] = nd;
          tr.next[v] = u;
          tr.edge[v] = e;
          if (size < hN.length) push(v, nd);
        }
      }
    }
    this.trees[t] = tr;
    return tr;
  }
}

// ------------------------------------------------------------------ shaders

const figureVert = /* glsl */ `
uniform float uTime;
uniform vec2 uWindL;
uniform vec3 uSunDir;
attribute vec2 aPart;  // x: 0 robe, 1 head and hood, 2/3 legs, 4 cane; y: shade multiplier
attribute vec3 aKind;  // x: 0 cloth, 1 white face, 2 dark; y: silhouette (-1 all, -2 all but the tall hood); z: robe height 0 hem .. 1 neck
attribute vec4 iE;     // hem colour rgb, silhouette + 0.5 if banded
attribute vec4 iA;     // x, z (city local), facing, height scale
attribute vec4 iB;     // walk phase 0..1, speed m/s, sitting 0..1, talking 0..1
attribute vec4 iC;     // cloth tint rgb, seed
attribute vec4 iD;     // fade 0..1, lean (rad), head yaw, head pitch (up)
varying vec3 vW;
varying vec3 vTint;
varying float vFade;
varying float vMul;
varying float vSun;
varying vec3 vTint2;
varying vec3 vInfo;    // material, height along the robe, banded
${CITY_SHADOW_GLSL}
// The robe's outline for each silhouette: radius, height, forward offset.
vec3 robe(float v, float shape) {
  if (shape < 0.5) return vec3(mix(0.36, 0.085, pow(v, 0.85)), mix(0.3, 1.42, v), 0.0);
  if (shape < 1.5) return vec3(mix(0.25, 0.085, v * (0.5 + 0.5 * v)), mix(0.2, 1.42, v), 0.0);
  if (shape < 2.5) return vec3(0.28 * (1.0 - 0.7 * v * v * v), mix(0.34, 1.18, v), 0.11 * v * v);
  return vec3(mix(0.21, 0.185, v) * (1.0 - 0.52 * smoothstep(0.78, 1.0, v)), mix(0.18, 1.42, v), 0.0);
}
void main() {
  vFade = iD.x;
  float shape = floor(iE.w + 0.01);
  bool mine = aKind.y < -1.5 ? abs(shape - 1.0) > 0.5 : (aKind.y < -0.5 || abs(aKind.y - shape) < 0.5);
  if (iD.x < 0.004 || !mine || (aPart.x > 3.5 && iB.z > 0.3)) {
    vW = vec3(0.0); vTint = vec3(0.0); vMul = 0.0; vSun = 0.0; vTint2 = vec3(0.0); vInfo = vec3(0.0);
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec3 p = position;
  float part = aPart.x;
  if (aKind.z >= 0.0) {
    vec3 o = robe(aKind.z, shape);
    p = vec3(position.x * o.x, o.y, position.z * o.x * 0.86 + o.z);
  }
  float t = uTime + iC.w * 61.0;
  float ph = iB.x * 6.2831853;
  float amp = clamp(iB.y / 1.3, 0.0, 1.4);
  float sit = iB.z;
  float talk = iB.w;
  float fac = iA.z;
  float cf = cos(fac);
  float sf = sin(fac);
  vec2 wl = vec2(uWindL.x * cf - uWindL.y * sf, uWindL.x * sf + uWindL.y * cf);

  if (part < 0.5) {
    float hem = clamp((1.3 - p.y) / 1.2, 0.0, 1.0);
    float h2 = hem * hem;
    // the stride pushes the hem out in front and lets it trail
    p.z += (abs(sin(ph)) * 0.07 - 0.05) * amp * h2;
    p.x += sin(ph) * 0.035 * amp * h2;
    // slow sway and the wind in the cloth
    p.x += (sin(t * 1.3 + p.y * 2.0) * 0.012 + wl.x * 0.035) * h2;
    p.z += (sin(t * 1.1 + 1.7) * 0.01 + wl.y * 0.035) * h2;
    // breathing, and the shoulders lifting with speech
    float chest = smoothstep(0.85, 1.25, p.y) * (1.0 - smoothstep(1.3, 1.46, p.y));
    p.xz *= 1.0 + 0.014 * sin(t * 1.6) * chest;
    p.y += talk * 0.014 * (0.5 + 0.5 * sin(t * 3.3)) * smoothstep(1.1, 1.38, p.y);
  } else if (part < 1.5) {
    vec3 q = p - vec3(0.0, 1.42, 0.0);
    float pitch = -iD.w + talk * sin(t * 4.3) * 0.08 + sit * 0.05;
    float yaw = iD.z + talk * sin(t * 2.1) * 0.18;
    float cp = cos(pitch);
    float sp = sin(pitch);
    q.yz = vec2(cp * q.y - sp * q.z, sp * q.y + cp * q.z);
    float cy = cos(yaw);
    float sy = sin(yaw);
    q.xz = vec2(cy * q.x + sy * q.z, -sy * q.x + cy * q.z);
    p = q + vec3(0.0, 1.42, 0.0);
    p.y += talk * 0.014 * (0.5 + 0.5 * sin(t * 3.3)) + 0.004 * sin(t * 1.6);
    // the elder's head sits low and forward on a bent back
    if (abs(shape - 2.0) < 0.5) p += vec3(0.0, -0.2, 0.14);
  } else if (part > 3.5) {
    // the cane swings from the hand and is planted with each step
    p.z += sin(ph) * 0.14 * amp * (1.0 - p.y / 0.95);
  } else {
    float side = part < 2.5 ? 1.0 : -1.0;
    float foot = 1.0 - clamp(p.y / 0.3, 0.0, 1.0);
    p.z += sin(ph) * side * 0.24 * amp * foot;
    p.y += max(0.0, cos(ph) * side) * 0.06 * amp * foot;
  }

  // sitting: legs fold forward along the ground, the body lowers and leans back a little
  if (sit > 0.001) {
    vec3 s = p;
    if (p.y < 0.6) {
      s.y = p.y * 0.28;
      s.z = p.z + (0.6 - p.y) * 0.75;
    } else {
      float ry = p.y - 0.6;
      float lb = -0.12;
      s.y = 0.168 + ry * cos(lb) - p.z * sin(lb);
      s.z = ry * sin(lb) + p.z * cos(lb);
    }
    p = mix(p, s, sit);
  }

  // posture: forward with speed, roll into turns, a bob with each step
  float pb = amp * 0.05;
  p.yz = vec2(p.y * cos(pb) - p.z * sin(pb), p.y * sin(pb) + p.z * cos(pb));
  float ln = iD.y;
  p.xy = vec2(p.x * cos(ln) + p.y * sin(ln), -p.x * sin(ln) + p.y * cos(ln));
  p.y += (abs(cos(ph)) * 0.035 - 0.02) * amp * (1.0 - sit);

  p *= iA.w;
  vec3 lp = vec3(p.x * cf + p.z * sf + iA.x, p.y, -p.x * sf + p.z * cf + iA.y);
  vec4 wp = modelMatrix * vec4(lp, 1.0);
  vW = wp.xyz;
  vTint = iC.rgb;
  vTint2 = iE.rgb;
  vInfo = vec3(aKind.x, aKind.z < 0.0 ? 1.0 : aKind.z, fract(iE.w));
  vMul = aPart.y;
  vSun = cityShadow(wp.xyz, uSunDir);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const figureFrag = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uFig;
uniform vec3 uFigLit;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uNight;
varying vec3 vW;
varying vec3 vTint;
varying float vFade;
varying float vMul;
varying float vSun;
varying vec3 vTint2;
varying vec3 vInfo;
${STYLE_GLSL}
void main() {
  if (vFade < 0.995) {
    float h = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
    if (h > vFade) discard;
  }
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  if (dot(n, V) < 0.0) n = -n;
  float ndl = dot(n, uSunDir);
  float l = smoothstep(-0.1, 0.35, ndl) * vSun;
  l = styleBands(l, vW.xz);
  l += (1.0 - l) * uNight * 0.12;
  // cloth: one colour, or a blend from the hood colour down to the hem colour, some with bands
  float hgt = vInfo.y;
  vec3 tint = mix(vTint2, vTint, smoothstep(0.15, 0.85, hgt));
  if (vInfo.z > 0.25) {
    float band = step(0.09, hgt) * step(hgt, 0.16) + step(0.21, hgt) * step(hgt, 0.245);
    tint = mix(tint, vTint, band);
  }
  // lit by the same light as the sand, but less dyed by it, so a blue robe stays blue
  float lumL = dot(uLit, vec3(0.3333));
  float lumS = dot(uShade, vec3(0.3333));
  vec3 sunW = mix(uSunCol, vec3(1.0), 0.45);
  vec3 liC = mix(uLit * 1.25, sunW * lumL * 1.6, 0.8);
  vec3 shC = mix(uShade * 1.3, mix(sunW, uFogCol, 0.5) * lumS * 1.9, 0.8);
  vec3 col = mix(tint * shC, tint * liC, l * 0.85);
  col = mix(col, mix(uFig, uFigLit, l), 0.1) * vMul;
  if (vInfo.x > 1.5) {
    col = uFig * mix(0.45, 0.75, l);
  } else if (vInfo.x > 0.5) {
    // the face: flat white, tinted by the light and dimmed at night
    col = vec3(0.97, 0.95, 0.9) * mix(vec3(1.0), uSunCol, 0.3) * (1.0 - 0.42 * uNight) * mix(0.7, 1.0, l);
  }
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * smoothstep(-0.2, 0.3, ndl) * vSun;
  col += uSunCol * rim * 0.1 * (1.0 - 0.5 * uNight);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

const blobVert = /* glsl */ `
uniform vec3 uSunDir;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iD;
varying vec2 vQ;
varying float vA;
varying vec3 vW;
${CITY_SHADOW_GLSL}
void main() {
  if (iD.x < 0.004) {
    vQ = vec2(2.0); vA = 0.0; vW = vec3(0.0);
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float r = (0.42 + 0.14 * iB.z) * iA.w;
  vec3 lp = vec3(iA.x + position.x * r, 0.03, iA.y + position.z * r);
  vec4 wp = modelMatrix * vec4(lp, 1.0);
  vQ = position.xz;
  vW = wp.xyz;
  vA = iD.x * mix(0.35, 1.0, cityShadow(wp.xyz + vec3(0.0, 0.8, 0.0), uSunDir));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const blobFrag = /* glsl */ `
precision highp float;
uniform float uFog;
uniform float uNight;
varying vec2 vQ;
varying float vA;
varying vec3 vW;
void main() {
  float d = length(vQ);
  float a = (1.0 - smoothstep(0.2, 1.0, d)) * vA * 0.42 * (1.0 - 0.5 * uNight);
  a *= exp(-length(cameraPosition - vW) * uFog);
  gl_FragColor = vec4(vec3(1.0 - a), 1.0);
}
`;

/**
 * One figure that holds every silhouette. The robe is a unit tube that the vertex shader
 * shapes per person; hoods, headpiece, eye and cane are each tagged with the silhouette they
 * belong to and collapsed for everyone else. Feet at 0, facing +z. About 350 triangles are
 * drawn for any one person.
 */
function figureGeometry(): THREE.InstancedBufferGeometry {
  const N = 10;
  const pos: number[] = [];
  const part: number[] = [];
  const kind: number[] = [];
  const idx: number[] = [];
  let pid = 0;
  let mat = 0;
  let who = -1;
  let shade = 1;
  const vert = (x: number, y: number, z: number, v = -1) => {
    pos.push(x, y, z);
    part.push(pid, shade);
    kind.push(mat, who, v);
    return pos.length / 3 - 1;
  };
  const ring = (y: number, rx: number, rz: number, zo: number, v = -1, n = N) => {
    const base = pos.length / 3;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      vert(Math.sin(a) * rx, y, Math.cos(a) * rz + zo, v);
    }
    return base;
  };
  const band = (r0: number, r1: number, n = N) => {
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      idx.push(r0 + k, r0 + k1, r1 + k, r0 + k1, r1 + k1, r1 + k);
    }
  };
  const fan = (r: number, c: number, flip: boolean, n = N) => {
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      if (flip) idx.push(r + k1, r + k, c);
      else idx.push(r + k, r + k1, c);
    }
  };
  /** A low-poly ball: bottom pole, rings, top pole. */
  const ball = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, n = 8, rows = 4) => {
    const bot = vert(cx, cy - ry, cz);
    let prev = -1;
    for (let j = 1; j <= rows; j++) {
      const a = (j / (rows + 1)) * Math.PI;
      const r = ring(cy - Math.cos(a) * ry, Math.sin(a) * rx, Math.sin(a) * rz, cz, -1, n);
      if (prev < 0) fan(r, bot, true, n);
      else band(prev, r, n);
      prev = r;
    }
    fan(prev, vert(cx, cy + ry, cz), false, n);
  };

  // robe: unit rings, hem to neck, shaped in the shader
  pid = 0;
  const R = 6;
  const robe: number[] = [];
  for (let j = 0; j <= R; j++) robe.push(ring(0, 1, 1, 0, j / R));
  for (let j = 0; j < R; j++) band(robe[j], robe[j + 1]);
  shade = 0.6;
  fan(robe[0], vert(0, 0, 0, 0.04), true);
  shade = 1;

  // head: a plain white ball. Hoods sit a little behind it, so the face shows as a disc.
  pid = 1;
  mat = 1;
  ball(0, 1.53, 0.035, 0.125, 0.125, 0.125, 10, 5);
  mat = 0;
  // cowl, for everyone but the tall hood
  who = -2;
  ball(0, 1.545, -0.035, 0.158, 0.162, 0.158);
  // tall pointed hood
  who = 1;
  const tall = [ring(1.4, 0.165, 0.165, -0.04, -1, 8), ring(1.63, 0.145, 0.15, -0.045, -1, 8), ring(1.86, 0.075, 0.08, -0.07, -1, 8)];
  band(tall[0], tall[1], 8);
  band(tall[1], tall[2], 8);
  fan(tall[2], vert(0, 2.1, -0.1), false, 8);
  shade = 0.6;
  fan(tall[0], vert(0, 1.42, -0.04), true, 8);
  shade = 1;
  // headpiece: a tall flat-topped cap, and a single dark eye
  who = 3;
  const cap = [ring(1.62, 0.12, 0.12, -0.03, -1, 8), ring(2.02, 0.15, 0.14, -0.03, -1, 8)];
  band(cap[0], cap[1], 8);
  fan(cap[1], vert(0, 2.04, -0.03), false, 8);
  mat = 2;
  {
    const c = vert(0, 1.54, 0.163);
    const b = pos.length / 3;
    for (let k = 0; k < 6; k++) vert(Math.sin((k / 6) * TAU) * 0.03, 1.54 + Math.cos((k / 6) * TAU) * 0.03, 0.161);
    for (let k = 0; k < 6; k++) idx.push(c, b + ((k + 1) % 6), b + k);
  }

  // legs: two thin sticks with a small foot, mostly hidden up inside the robe
  who = -1;
  for (const [id, sx] of [
    [2, 0.07],
    [3, -0.07],
  ]) {
    pid = id;
    const b = pos.length / 3;
    const w = 0.02;
    for (const [y, toe] of [
      [0, 0.075],
      [0.035, 0.0],
      [0.5, 0.0],
    ]) {
      vert(sx - w, y, -w);
      vert(sx + w, y, -w);
      vert(sx + w, y, w + toe);
      vert(sx - w, y, w + toe);
    }
    for (let j = 0; j < 2; j++) {
      for (let k = 0; k < 4; k++) {
        const k1 = (k + 1) % 4;
        const r0 = b + j * 4;
        idx.push(r0 + k, r0 + k1, r0 + 4 + k, r0 + k1, r0 + 4 + k1, r0 + 4 + k);
      }
    }
  }
  // the elder's cane
  who = 2;
  pid = 4;
  {
    const b = pos.length / 3;
    const w = 0.014;
    for (const y of [0, 0.95]) {
      vert(-0.3 - w, y, 0.24 - w);
      vert(-0.3 + w, y, 0.24 - w);
      vert(-0.3 + w, y, 0.24 + w);
      vert(-0.3 - w, y, 0.24 + w);
    }
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      idx.push(b + k, b + k1, b + 4 + k, b + k1, b + 4 + k1, b + 4 + k);
    }
  }

  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 2));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 3));
  g.setIndex(idx);
  return g;
}

/** One person on the dev review sheet. */
/** A townsperson, as the talking needs them (see People.nearestPerson). */
export interface FolkOut {
  id: number;
  x: number;
  z: number;
  h: number;
  sit: number;
  /** Keeping a market stall: standing behind its goods (slot 0 of a market or stall spot). */
  stall?: boolean;
}

export interface SheetPerson {
  x: number;
  z: number;
  facing: number;
  shape: number;
  child?: boolean;
  walk?: boolean;
  /** Seed for the cloth pick, so a sheet looks the same each time. */
  seed: number;
}

/** Dev only: a static row of townsfolk dressed for one kind of city, drawn with the crowd's own shader. */
export function townsfolkSheet(uniforms: Uniforms, kind: CityKind, list: SheetPerson[]): THREE.Mesh {
  const n = list.length;
  const dyn = new Float32Array(n * DYN);
  const a = new Float32Array(n * 4);
  const b = new Float32Array(n * 4);
  list.forEach((p, i) => {
    let s = (p.seed * 2654435761) >>> 0 || 1;
    const rnd = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
    const banded = dress(kind, rnd, a, b, i * 4);
    a[i * 4 + 3] = rnd();
    b[i * 4 + 3] = (p.child ? 0 : p.shape) + (banded ? 0.5 : 0);
    dyn.set([p.x, p.z, p.facing, p.child ? 0.6 : 1, p.walk ? 0.2 : 0, p.walk ? 1.2 : 0, 0, 0, 1, 0, 0, 0], i * DYN);
  });
  const buf = new THREE.InstancedInterleavedBuffer(dyn, DYN, 1);
  const g = figureGeometry();
  g.setAttribute('iA', new THREE.InterleavedBufferAttribute(buf, 4, 0));
  g.setAttribute('iB', new THREE.InterleavedBufferAttribute(buf, 4, 4));
  g.setAttribute('iD', new THREE.InterleavedBufferAttribute(buf, 4, 8));
  g.setAttribute('iC', new THREE.InstancedBufferAttribute(a, 4));
  g.setAttribute('iE', new THREE.InstancedBufferAttribute(b, 4));
  g.instanceCount = n;
  const blank = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  blank.needsUpdate = true;
  const mesh = new THREE.Mesh(
    g,
    new THREE.ShaderMaterial({
      uniforms: { uCityMap: { value: blank }, uCityRect: { value: new THREE.Vector4() }, uCityGround: { value: 0 }, uWindL: { value: new THREE.Vector2() }, ...uniforms },
      vertexShader: figureVert,
      fragmentShader: figureFrag,
    }),
  );
  mesh.frustumCulled = false;
  return mesh;
}

// ------------------------------------------------------------------ the crowd

export class People {
  readonly group = new THREE.Group();

  private readonly u: Uniforms;
  private readonly figMat: THREE.ShaderMaterial;
  private readonly blobMat: THREE.ShaderMaterial;
  private readonly figGeo: THREE.InstancedBufferGeometry;
  private readonly blobGeo: THREE.InstancedBufferGeometry;
  private readonly dyn: THREE.InstancedInterleavedBuffer;
  private readonly dynA: Float32Array;
  private readonly stat: THREE.InstancedBufferAttribute;
  private readonly statA: Float32Array;
  private readonly statB: Float32Array;
  private readonly stat2: THREE.InstancedBufferAttribute;
  private readonly blank: THREE.DataTexture;
  private readonly fallback: Uniforms;
  private readonly windL = new THREE.Vector2();

  // The miners: a handful in every city, each sat at a different spot (chosen from the plan's
  // own by the city's seed) in a loud colour nobody else wears, with a spare pick stood beside
  // them. Not part of the pool: they do not come and go. Each is one more instance of the same figure.
  private readonly minerGeo: THREE.InstancedBufferGeometry;
  private readonly minerBlob: THREE.InstancedBufferGeometry;
  private readonly minerDyn: THREE.InstancedInterleavedBuffer;
  private readonly minerA = new Float32Array(DYN * MINER_MAX);
  private readonly minerFig: THREE.Mesh;
  private readonly minerShadow: THREE.Mesh;
  private readonly minerPicks: THREE.Mesh[] = [];
  private readonly minerLamps: THREE.Mesh[] = [];
  private readonly minerHeaps: THREE.Mesh[] = [];
  private readonly miners = Array.from({ length: MINER_MAX }, () => ({ on: false, x: 0, z: 0, fac: 0, home: 0, heldT: 0, talk: 0, yaw: 0, pitch: 0 }));
  private minerN = 0;
  private minerSel = 0;
  /** The lamp has been brought back: it stands beside the miner. */
  minerLamp = false;

  private city: CityData | null = null;
  private cityId = -1;
  private cache = new Map<number, CityData>();
  private density = 1;
  private _bustle = 0;
  private hi = 0;
  private heldI = -1; // someone the player is talking to: they stand and face the player
  private heldT = 0;
  private time = 0;
  private rs = 0x9e3779b9;
  private spawnAcc = 0;
  private leaveAcc = 0;
  private cover = 0;
  private coverT = 0;
  private target = 0;
  private activeN = 0;
  private dirtyLo = MAXP;
  private dirtyHi = -1;

  // frame state
  private plx = 0;
  private plz = 0;
  private pvx = 0;
  private pvz = 0;
  private pspd = 0;
  private plh = 0;
  private pGround = false;
  private pFly = false;
  private readonly w = new Float32Array(NK);
  private readonly frustum = new THREE.Frustum();
  private readonly m4 = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private tpx = 0;
  private tpz = 0;

  // neighbour hash
  private readonly hStart = new Int32Array(HASH + 1);
  private readonly hFill = new Int32Array(HASH);
  private readonly hKey = new Int32Array(MAXP);
  private readonly hItems = new Int32Array(MAXP);

  // people
  private readonly alive = new Uint8Array(MAXP);
  private readonly x = new Float32Array(MAXP);
  private readonly z = new Float32Array(MAXP);
  private readonly fac = new Float32Array(MAXP);
  private readonly hs = new Float32Array(MAXP); // heading speed
  private readonly vs = new Float32Array(MAXP); // visible speed (from actual motion)
  private readonly pref = new Float32Array(MAXP);
  private readonly latF = new Float32Array(MAXP);
  private readonly hgt = new Float32Array(MAXP);
  private readonly child = new Uint8Array(MAXP);
  private readonly seed = new Float32Array(MAXP);
  private readonly fade = new Float32Array(MAXP);
  private readonly fadeRate = new Float32Array(MAXP);
  private readonly ph = new Uint8Array(MAXP);
  private readonly dest = new Int32Array(MAXP); // slot >= 0, waypoint -2 - w, -1 none
  private readonly door = new Int32Array(MAXP);
  private readonly leaving = new Uint8Array(MAXP);
  private readonly keeper = new Uint8Array(MAXP);
  private readonly prevN = new Int32Array(MAXP);
  private readonly curN = new Int32Array(MAXP);
  private readonly curE = new Int32Array(MAXP);
  private readonly exE = new Int32Array(MAXP);
  private readonly exX = new Float32Array(MAXP);
  private readonly exZ = new Float32Array(MAXP);
  private readonly tx = new Float32Array(MAXP);
  private readonly tz = new Float32Array(MAXP);
  private readonly timer = new Float32Array(MAXP);
  private readonly sit = new Float32Array(MAXP);
  private readonly sitT = new Float32Array(MAXP);
  private readonly talk = new Float32Array(MAXP);
  private readonly lookY = new Float32Array(MAXP);
  private readonly lookP = new Float32Array(MAXP);
  private readonly lookT = new Float32Array(MAXP);
  private readonly lookCool = new Float32Array(MAXP);
  private readonly followCool = new Float32Array(MAXP);
  private readonly bestD = new Float32Array(MAXP);
  private readonly stuckT = new Float32Array(MAXP);
  private readonly turn = new Float32Array(MAXP);
  private readonly pushX = new Float32Array(MAXP);
  private readonly pushZ = new Float32Array(MAXP);
  private readonly walkPh = new Float32Array(MAXP);
  private readonly crumbX = new Float32Array(MAXP * CRUMBS);
  private readonly crumbZ = new Float32Array(MAXP * CRUMBS);
  private readonly crumbN = new Uint8Array(MAXP);
  private readonly rejoinN = new Int32Array(MAXP);
  private readonly avT = new Float32Array(MAXP); // time left heading round a prop
  private readonly avYaw = new Float32Array(MAXP); // the heading that gets round it
  private readonly dodge = new Int8Array(MAXP); // the side props are passed on: +1, -1, or 0 not yet chosen

  /**
   * What stands in a walker's way beyond the plan's own buildings and pool: the city's props, a
   * site's stones (world space, as the wanderer's roof: the top over (x, z) for feet at y, or
   * -Infinity). Set by the game.
   */
  solid: SolidQuery | null = null;
  /** The same in the loaded city's local metres, feet at y above its ground. */
  private readonly localSolid: SolidQuery = (lx, lz, y) => {
    const c = this.city as CityData;
    const s = c.site;
    return (this.solid as SolidQuery)(s.cx + c.co * lx - c.si * lz, s.cz + c.si * lx + c.co * lz, y + s.groundY) - s.groundY;
  };

  constructor(uniforms: Uniforms) {
    this.u = uniforms;
    this.blank = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.blank.needsUpdate = true;
    this.fallback = {
      uCityMap: { value: this.blank },
      uCityRect: { value: new THREE.Vector4() },
      uCityGround: { value: 0 },
    };
    const own = (): Uniforms => ({
      ...this.fallback,
      ...uniforms,
      uWindL: { value: this.windL },
    });

    this.dynA = new Float32Array(MAXP * DYN);
    this.dyn = new THREE.InstancedInterleavedBuffer(this.dynA, DYN, 1);
    this.dyn.setUsage(THREE.DynamicDrawUsage);
    this.statA = new Float32Array(MAXP * 4);
    this.stat = new THREE.InstancedBufferAttribute(this.statA, 4);
    this.stat.setUsage(THREE.DynamicDrawUsage);
    this.statB = new Float32Array(MAXP * 4);
    this.stat2 = new THREE.InstancedBufferAttribute(this.statB, 4);
    this.stat2.setUsage(THREE.DynamicDrawUsage);
    const iA = new THREE.InterleavedBufferAttribute(this.dyn, 4, 0);
    const iB = new THREE.InterleavedBufferAttribute(this.dyn, 4, 4);
    const iD = new THREE.InterleavedBufferAttribute(this.dyn, 4, 8);

    this.figGeo = figureGeometry();
    this.figGeo.setAttribute('iA', iA);
    this.figGeo.setAttribute('iB', iB);
    this.figGeo.setAttribute('iC', this.stat);
    this.figGeo.setAttribute('iE', this.stat2);
    this.figGeo.setAttribute('iD', iD);
    this.figGeo.instanceCount = 0;
    this.figMat = new THREE.ShaderMaterial({ uniforms: own(), vertexShader: figureVert, fragmentShader: figureFrag });
    const fig = new THREE.Mesh(this.figGeo, this.figMat);
    fig.frustumCulled = false;

    this.blobGeo = new THREE.InstancedBufferGeometry();
    this.blobGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], 3));
    this.blobGeo.setIndex([0, 2, 1, 0, 3, 2]);
    this.blobGeo.setAttribute('iA', iA);
    this.blobGeo.setAttribute('iB', iB);
    this.blobGeo.setAttribute('iD', iD);
    this.blobGeo.instanceCount = 0;
    this.blobMat = new THREE.ShaderMaterial({
      uniforms: own(),
      vertexShader: blobVert,
      fragmentShader: blobFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const blob = new THREE.Mesh(this.blobGeo, this.blobMat);
    blob.frustumCulled = false;
    blob.renderOrder = 1;
    this.group.add(fig, blob);
    this.group.visible = false;

    // the miners: the same figure and shadow, one instance each, with buffers of their own
    this.minerDyn = new THREE.InstancedInterleavedBuffer(this.minerA, DYN, 1);
    this.minerDyn.setUsage(THREE.DynamicDrawUsage);
    const mA = new THREE.InterleavedBufferAttribute(this.minerDyn, 4, 0);
    const mB = new THREE.InterleavedBufferAttribute(this.minerDyn, 4, 4);
    const mD = new THREE.InterleavedBufferAttribute(this.minerDyn, 4, 8);
    this.minerGeo = figureGeometry();
    this.minerGeo.setAttribute('iA', mA);
    this.minerGeo.setAttribute('iB', mB);
    this.minerGeo.setAttribute('iD', mD);
    this.minerGeo.setAttribute('iC', new THREE.InstancedBufferAttribute(new Float32Array(MINER_CLOTH), 4));
    this.minerGeo.setAttribute('iE', new THREE.InstancedBufferAttribute(new Float32Array(MINER_HEM), 4));
    this.minerGeo.instanceCount = 0;
    this.minerFig = new THREE.Mesh(this.minerGeo, this.figMat);
    this.minerFig.frustumCulled = false;
    this.minerBlob = new THREE.InstancedBufferGeometry();
    this.minerBlob.setAttribute('position', this.blobGeo.getAttribute('position'));
    this.minerBlob.setIndex(this.blobGeo.getIndex());
    this.minerBlob.setAttribute('iA', mA);
    this.minerBlob.setAttribute('iB', mB);
    this.minerBlob.setAttribute('iD', mD);
    this.minerBlob.instanceCount = 0;
    this.minerShadow = new THREE.Mesh(this.minerBlob, this.blobMat);
    this.minerShadow.frustumCulled = false;
    this.minerShadow.renderOrder = 1;
    this.group.add(this.minerFig, this.minerShadow);
    const solid = solidMaterial(uniforms);
    for (let i = 0; i < MINER_MAX; i++) {
      const pick = new THREE.Mesh(pickGeometry(CHOSEN.pick), solid);
      const lamp = new THREE.Mesh(lampGeometry(), solid);
      lamp.scale.setScalar(1.5);
      const heap = new THREE.Mesh(heapGeometry(), solid);
      pick.visible = lamp.visible = heap.visible = false;
      this.minerPicks.push(pick);
      this.minerLamps.push(lamp);
      this.minerHeaps.push(heap);
      this.group.add(pick, lamp, heap);
    }
  }

  /** The nearest miner, if one is within maxD metres of the player: where they are, in world space. */
  minerNear(maxD: number, out: { x: number; z: number; h: number; sit: number }): boolean {
    const c = this.city;
    if (!c) return false;
    let best = -1;
    let bd = maxD;
    for (let i = 0; i < this.minerN; i++) {
      const m = this.miners[i];
      const d = this.distPlayer(m.x, m.z);
      if (m.on && d <= bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) return false;
    const m = this.miners[best];
    this.minerSel = best;
    out.x = c.site.cx + c.co * m.x - c.si * m.z;
    out.z = c.site.cz + c.si * m.x + c.co * m.z;
    out.h = 1;
    out.sit = 1;
    return true;
  }

  /** Call every frame while talking to a miner (the last one minerNear found): they turn to the player and talk. */
  holdMiner() {
    this.miners[this.minerSel].heldT = 0.3;
  }

  /** Sit miners down in a city, each at a different one of the plan's own spots, and keep everyone else off them. */
  private placeMiners(c: CityData) {
    this.minerN = 0;
    for (const m of this.miners) m.on = false;
    const seed = c.site.seed >>> 3;
    const used = new Set<number>();
    for (const k of [K_SHADE, K_BENCH, K_GATHER]) {
      const ok = c.byKind[k].filter((sp) => c.sEdge[sp] >= 0 && c.sSlotN[sp] > 0 && !used.has(sp));
      // spread them: start at the seed's pick and stride across the list
      const stride = Math.max(1, Math.floor(ok.length / MINER_MAX));
      for (let j = 0; j < ok.length && this.minerN < MINER_MAX; j++) {
        const sp = ok[(seed + j * stride) % ok.length];
        if (used.has(sp)) continue;
        used.add(sp);
        this.seatMiner(c, this.minerN++, sp);
      }
      if (this.minerN >= MINER_MAX) break;
    }
    const vis = this.minerN > 0;
    this.minerFig.visible = this.minerShadow.visible = vis;
    this.minerGeo.instanceCount = this.minerBlob.instanceCount = this.minerN;
    for (let i = 0; i < MINER_MAX; i++) {
      const on = i < this.minerN;
      this.minerPicks[i].visible = this.minerHeaps[i].visible = on;
      this.minerLamps[i].visible = false;
    }
  }

  private seatMiner(c: CityData, i: number, sp: number) {
    const m = this.miners[i];
    const slot = c.sSlot0[sp];
    c.slotOwner[slot] = MAXP; // nobody in the pool has this number, so it is never given up
    m.on = true;
    m.x = c.slotX[slot];
    m.z = c.slotZ[slot];
    m.fac = m.home = c.slotF[slot];
    m.talk = m.yaw = m.pitch = m.heldT = 0;
    // the spare pick, stood on its handle within reach of the right hand
    const rx = Math.cos(m.home);
    const rz = -Math.sin(m.home);
    this.minerPicks[i].position.set(m.x + rx * 0.62, 0.02, m.z + rz * 0.62);
    this.minerPicks[i].rotation.set(0.12, m.home + 0.6, 0.2);
    this.minerLamps[i].position.set(m.x - rx * 0.6, 0.29, m.z - rz * 0.6);
    this.minerLamps[i].rotation.set(0, m.home + 0.3, 0);
    // and the heap being sorted, by the left knee
    const fx = Math.sin(m.home);
    const fz = Math.cos(m.home);
    this.minerHeaps[i].position.set(m.x - rx * 0.75 + fx * 0.75, 0, m.z - rz * 0.75 + fz * 0.75);
    this.minerHeaps[i].rotation.set(0, m.home, 0);
  }

  /** The miners' small loop: sat, looking about, bending now and then over a stone in the lap. */
  private updateMiners(dt: number) {
    for (let i = 0; i < this.minerN; i++) this.updateMiner(dt, i);
    this.minerDyn.needsUpdate = true;
  }

  private updateMiner(dt: number, i: number) {
    const m = this.miners[i];
    if (!m.on) return;
    const t = this.time + i * 2.3; // out of step, so they do not all look down together
    const dist = this.distPlayer(m.x, m.z);
    const toP = Math.atan2(this.plx - m.x, this.plz - m.z);
    const k3 = 1 - Math.exp(-dt * 3);
    m.heldT -= dt;
    const held = m.heldT > 0;
    let yaw = 0.5 * Math.sin(t * 0.31) + 0.18 * Math.sin(t * 0.83 + 1);
    // every nine seconds or so, a long look down and two small nods at whatever is being sorted
    const beat = (t % 9) / 9;
    const down = beat > 0.62 ? Math.sin(((beat - 0.62) / 0.38) * Math.PI) : 0;
    let pitch = -0.42 * down - 0.06 * down * Math.sin(t * 9);
    if (down > 0.05) yaw *= 1 - down;
    if (held || (this.pGround && dist < 5)) {
      const raw = wrapPi(toP - m.fac);
      if (Math.abs(raw) < 2.2) yaw = clamp(raw, -1.1, 1.1);
      pitch = 0.12;
    }
    // spoken to, the whole body comes round; left alone it settles back the way the seat faces
    m.fac += wrapPi((held ? toP : m.home) - m.fac) * (1 - Math.exp(-dt * (held ? 2.5 : 0.8)));
    m.talk += ((held ? 1 : 0) - m.talk) * (1 - Math.exp(-dt * 2));
    m.yaw += (yaw - m.yaw) * k3;
    m.pitch += (pitch - m.pitch) * k3;
    this.minerLamps[i].visible = this.minerLamp;
    const a = this.minerA;
    const o = i * DYN;
    a[o] = m.x;
    a[o + 1] = m.z;
    a[o + 2] = m.fac;
    a[o + 3] = 1.04;
    a[o + 4] = 0;
    a[o + 5] = 0;
    a[o + 6] = 1;
    a[o + 7] = m.talk;
    a[o + 8] = 1;
    a[o + 9] = 0;
    a[o + 10] = m.yaw;
    a[o + 11] = m.pitch;
  }

  /** How busy the surroundings are right now, 0..1. */
  /**
   * The nearest townsperson within maxD metres of the player, in world space.
   * out.h is their height scale and out.sit how far they are sat down (0..1); out.stall is true
   * for a shopkeeper standing behind the goods at a market stall.
   */
  nearestPerson(maxD: number, out: FolkOut): boolean {
    if (!this.city) return false;
    let best = -1;
    let bd = maxD;
    for (let i = 0; i < this.hi; i++) {
      if (!this.alive[i] || this.ph[i] === P_GONE || this.fade[i] < 0.7) continue;
      const d = this.distPlayer(this.x[i], this.z[i]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best >= 0 && this.personAt(best, out);
  }

  /** Where a townsperson is now. False once they have gone. */
  personAt(i: number, out: FolkOut): boolean {
    const c = this.city;
    if (!c || i < 0 || !this.alive[i] || this.ph[i] === P_GONE) return false;
    out.id = i;
    out.x = c.site.cx + c.co * this.x[i] - c.si * this.z[i];
    out.z = c.site.cz + c.si * this.x[i] + c.co * this.z[i];
    out.h = this.hgt[i];
    out.sit = this.sit[i];
    out.stall = this.keeper[i] === 1 && this.ph[i] === P_DWELL;
    return true;
  }

  /** Call every frame while talking to someone: they stop where they are and turn to the player. */
  hold(i: number) {
    this.heldI = i;
    this.heldT = 0.3;
  }

  get bustle(): number {
    return this._bustle;
  }

  setDensity(d: number) {
    this.density = clamp(d, 0, 1);
  }

  setCity(city: { site: CitySite; plan: CityPlan } | null) {
    const id = city ? city.site.id : -1;
    if (id === this.cityId) return;
    for (let i = 0; i < this.hi; i++) this.alive[i] = 0;
    this.dynA.fill(0);
    this.hi = 0;
    this.activeN = 0;
    this.spawnAcc = 0;
    this.leaveAcc = 0;
    this.coverT = 0;
    this.cityId = id;
    if (!city) {
      this.city = null;
      this.minerN = 0;
      for (const m of this.miners) m.on = false;
      this.group.visible = false;
      return;
    }
    let c = this.cache.get(id);
    if (!c || c.plan !== city.plan) {
      c = new CityData(city.site, city.plan);
      this.cache.set(id, c);
      if (this.cache.size > 3) {
        for (const k of this.cache.keys()) {
          if (k !== id) {
            this.cache.delete(k);
            break;
          }
        }
      }
    }
    c.slotOwner.fill(-1);
    c.sSpeaker.fill(-1);
    this.city = c;
    this.placeMiners(c);
    this.group.position.set(city.site.cx, city.site.groundY, city.site.cz);
    this.group.rotation.set(0, -city.site.rot, 0);
    this.group.updateMatrixWorld();
    this.group.visible = true;
  }

  dispose() {
    this.figGeo.dispose();
    this.blobGeo.dispose();
    this.figMat.dispose();
    this.blobMat.dispose();
    this.blank.dispose();
    this.cache.clear();
    this.city = null;
  }

  // ---------------------------------------------------------------- helpers

  private rand(): number {
    let s = this.rs;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.rs = s;
    return s / 4294967296;
  }

  private hashCell(gx: number, gz: number): number {
    return (Math.imul(gx, 92837111) ^ Math.imul(gz, 689287499)) & (HASH - 1);
  }

  private hiddenAt(c: CityData, lx: number, lz: number, dist: number): boolean {
    if (dist > HIDE_DIST) return true;
    const s = c.site;
    this.sphere.center.set(s.cx + c.co * lx - c.si * lz, s.groundY + 0.9, s.cz + c.si * lx + c.co * lz);
    this.sphere.radius = 1.3;
    return !this.frustum.intersectsSphere(this.sphere);
  }

  private distPlayer(x: number, z: number): number {
    return Math.hypot(x - this.plx, z - this.plz);
  }

  private release(i: number, c: CityData) {
    const d = this.dest[i];
    if (d >= 0 && c.slotOwner[d] === i) c.slotOwner[d] = -1;
    this.dest[i] = -1;
    this.keeper[i] = 0;
  }

  private kill(i: number, c: CityData) {
    this.release(i, c);
    this.alive[i] = 0;
    this.fade[i] = 0;
    const o = i * DYN;
    this.dynA[o + 8] = 0;
  }

  private gone(i: number, rate: number) {
    if (this.ph[i] === P_GONE) {
      this.fadeRate[i] = Math.max(this.fadeRate[i], rate);
      return;
    }
    this.ph[i] = P_GONE;
    this.fadeRate[i] = rate;
  }

  private resetStuck(i: number) {
    this.bestD[i] = Infinity;
    this.stuckT[i] = 0;
  }

  /** Kind weights for the time of day. */
  private weights(day: number) {
    const w = this.w;
    const nightness = bump(day, 0, 0.13);
    const daylight = 1 - nightness;
    w[K_MARKET] = (bump(day, 0.37, 0.06) + bump(day, 0.66, 0.06)) * 1.1 + 0.25 * bump(day, 0.5, 0.1);
    w[K_STALL] = w[K_MARKET];
    w[K_GATHER] = 0.35 * bump(day, 0.35, 0.08) + 1.5 * bump(day, 0.8, 0.05) + 0.3 * bump(day, 0.62, 0.06) + 0.2 * bump(day, 0.9, 0.04);
    w[K_SHADE] = 1.7 * bump(day, 0.5, 0.07) + 0.3 * bump(day, 0.42, 0.1);
    w[K_BENCH] = (0.3 + 0.4 * bump(day, 0.5, 0.08) + 0.3 * bump(day, 0.8, 0.06)) * (1 - 0.8 * nightness);
    w[K_WELL] = 0.4 * bump(day, 0.3, 0.05) + 0.25 * bump(day, 0.72, 0.05);
    w[K_GATE] = 0.08 * daylight + 0.9 * nightness;
    w[K_ERRAND] = 0.3 * daylight * (1 - 0.6 * bump(day, 0.5, 0.08)) + 0.7 * nightness;
  }

  /** Pick where to go next and reserve the slot. Returns a slot, -2 - waypoint, or -1 for home. */
  private chooseDest(i: number, c: CityData): number {
    const w = this.w;
    const kid = this.child[i] === 1;
    let total = 0;
    for (let k = 0; k < NK; k++) total += w[k] * (kid ? KID_W[k] : 1);
    if (total <= 1e-6) return -1;
    const x = this.x[i];
    const z = this.z[i];
    for (let tries = 0; tries < 8; tries++) {
      let r = this.rand() * total;
      let k = 0;
      for (; k < NK - 1; k++) {
        r -= w[k] * (kid ? KID_W[k] : 1);
        if (r <= 0) break;
      }
      if (k === K_ERRAND) {
        for (let t = 0; t < 4; t++) {
          const wi = Math.floor(this.rand() * c.wp.length);
          const n = c.wp[wi];
          if (this.distPlayer(c.nx[n], c.nz[n]) > REACH - 20) continue;
          const dn = Math.hypot(c.nx[n] - x, c.nz[n] - z);
          if (dn < 15 || dn > 180) continue;
          return -2 - wi;
        }
        continue;
      }
      const list = c.byKind[k];
      if (list.length === 0) continue;
      for (let t = 0; t < 6; t++) {
        const s = list[Math.floor(this.rand() * list.length)];
        if (this.distPlayer(c.sX[s], c.sZ[s]) > REACH - 15) continue;
        const d = Math.hypot(c.sX[s] - x, c.sZ[s] - z);
        if (d > 170 || (d > 70 && this.rand() < 0.6)) continue;
        if (this.rand() > c.sCent[s] / 1.9 + 0.4) continue;
        const s0 = c.sSlot0[s];
        const sn = c.sSlotN[s];
        const trade = k === K_MARKET || k === K_STALL;
        let slot = -1;
        if (trade && !kid && c.slotOwner[s0] < 0 && w[K_MARKET] > 0.15) slot = s0;
        else {
          const start = trade ? 1 : 0;
          const span = sn - start;
          if (span <= 0) continue;
          const off = Math.floor(this.rand() * span);
          for (let q = 0; q < span; q++) {
            const sl = s0 + start + ((off + q) % span);
            if (c.slotOwner[sl] < 0) {
              slot = sl;
              break;
            }
          }
        }
        if (slot < 0) continue;
        c.slotOwner[slot] = i;
        return slot;
      }
    }
    return -1;
  }

  private destNode(i: number, c: CityData): number {
    const d = this.dest[i];
    if (d >= 0) return c.sNode[c.slotSpot[d]];
    if (d <= -2) return c.wp[-2 - d];
    return -1;
  }

  private startDwell(i: number, c: CityData, partial: boolean) {
    const slot = this.dest[i];
    const sp = c.slotSpot[slot];
    const k = c.sKind[sp];
    const kid = this.child[i] === 1;
    const day = this.dayNow;
    const r = this.rand();
    let t = 20;
    this.keeper[i] = 0;
    this.sitT[i] = 0;
    switch (k) {
      case K_MARKET:
      case K_STALL:
        if (slot === c.sSlot0[sp] && !kid) {
          this.keeper[i] = 1;
          t = 120 + r * 300;
        } else t = 10 + r * 35;
        break;
      case K_GATHER:
        t = (40 + r * 160) * (1 + bump(day, 0.8, 0.06));
        break;
      case K_SHADE:
        t = (40 + r * 260) * (1 + 0.5 * bump(day, 0.5, 0.07));
        this.sitT[i] = this.rand() < (kid ? 0.5 : 0.7) ? 1 : 0.22;
        break;
      case K_BENCH:
        t = 30 + r * 150;
        this.sitT[i] = 1;
        break;
      case K_WELL:
        t = 10 + r * 20;
        break;
      case K_GATE:
        t = bump(day, 0, 0.13) > 0.5 ? 60 + r * 140 : 15 + r * 45;
        break;
    }
    if (kid) t *= 0.6;
    if (partial) t *= 0.2 + 0.8 * this.rand();
    this.timer[i] = t;
    this.ph[i] = P_DWELL;
    if (this.sitT[i] > 0.5 && partial) this.sit[i] = this.sitT[i];
  }

  private endDwell(i: number, c: CityData) {
    const sp = c.slotSpot[this.dest[i]];
    this.release(i, c);
    this.sitT[i] = 0;
    this.exE[i] = c.sEdge[sp];
    this.exX[i] = c.sPx[sp];
    this.exZ[i] = c.sPz[sp];
    if (!this.leaving[i]) {
      this.dest[i] = this.chooseDest(i, c);
      if (this.dest[i] === -1) this.leaving[i] = 1;
    }
    this.ph[i] = P_EXIT;
    this.tx[i] = this.exX[i];
    this.tz[i] = this.exZ[i];
    this.resetStuck(i);
  }

  /** At the exit point on an edge: choose which way to walk. */
  private leaveExit(i: number, c: CityData) {
    const e = this.exE[i];
    const a = c.eA[e];
    const b = c.eB[e];
    const ex = this.exX[i];
    const ez = this.exZ[i];
    const la = Math.hypot(ex - c.nx[a], ez - c.nz[a]);
    const lb = Math.hypot(ex - c.nx[b], ez - c.nz[b]);
    let n: number;
    if (this.leaving[i] || this.dest[i] === -1) {
      n = la < lb ? a : b;
      if (this.rand() < 0.3) n = n === a ? b : a;
    } else {
      const d = this.dest[i];
      if (d >= 0 && c.sEdge[c.slotSpot[d]] === e) {
        this.toApproach(i, c);
        return;
      }
      const tr = c.tree(this.destNode(i, c));
      if (!tr) {
        this.ph[i] = P_WAIT_EXIT;
        return;
      }
      const da = la + tr.dist[a];
      const db = lb + tr.dist[b];
      if (!Number.isFinite(da) && !Number.isFinite(db)) {
        this.release(i, c);
        this.leaving[i] = 1;
        n = la < lb ? a : b;
      } else n = da <= db ? a : b;
    }
    this.curE[i] = e;
    this.curN[i] = n;
    this.prevN[i] = n === a ? b : a;
    this.ph[i] = P_WALK;
    this.resetStuck(i);
  }

  private toApproach(i: number, c: CityData) {
    const dr = this.door[i];
    if (dr >= 0) {
      this.tx[i] = c.dPx[dr];
      this.tz[i] = c.dPz[dr];
    } else {
      const sp = c.slotSpot[this.dest[i]];
      this.tx[i] = c.sPx[sp];
      this.tz[i] = c.sPz[sp];
    }
    this.ph[i] = P_APPROACH;
    this.resetStuck(i);
  }

  /** Reached node n: decide the next leg. */
  private arriveNode(i: number, c: CityData, n: number, depth = 0) {
    this.curN[i] = n;
    if (this.leaving[i] || this.dest[i] === -1) {
      const dr = c.nodeDoor[n];
      if (dr >= 0) {
        this.door[i] = dr;
        this.toApproach(i, c);
        return;
      }
      // wander on until a doorway turns up
      const s0 = c.adjS[n];
      const dg = c.adjS[n + 1] - s0;
      if (dg === 0) {
        this.gone(i, 1);
        return;
      }
      let k = Math.floor(this.rand() * dg);
      if (dg > 1 && c.adjN[s0 + k] === this.prevN[i]) k = (k + 1) % dg;
      this.curE[i] = c.adjE[s0 + k];
      this.prevN[i] = n;
      this.curN[i] = c.adjN[s0 + k];
      this.ph[i] = P_WALK;
      this.resetStuck(i);
      return;
    }
    const d = this.dest[i];
    if (d >= 0) {
      const e = c.sEdge[c.slotSpot[d]];
      if (c.eA[e] === n || c.eB[e] === n) {
        this.toApproach(i, c);
        return;
      }
    } else if (c.wp[-2 - d] === n) {
      // errand done
      this.dest[i] = depth < 2 ? this.chooseDest(i, c) : -1;
      if (this.dest[i] === d || this.dest[i] === -1) {
        this.dest[i] = -1;
        this.leaving[i] = 1;
      }
      this.arriveNode(i, c, n, depth + 1);
      return;
    }
    const tr = c.tree(this.destNode(i, c));
    if (!tr) {
      this.ph[i] = P_WAIT_NODE;
      return;
    }
    const nx = tr.next[n];
    if (nx < 0) {
      this.release(i, c);
      this.leaving[i] = 1;
      this.arriveNode(i, c, n, depth + 1);
      return;
    }
    this.curE[i] = tr.edge[n];
    this.prevN[i] = n;
    this.curN[i] = nx;
    this.ph[i] = P_WALK;
    this.resetStuck(i);
  }

  /** Accumulates the push away from the player's line into tpx, tpz. */
  private playerPush(i: number) {
    this.tpx = 0;
    this.tpz = 0;
    if (!this.pGround) return;
    const rx = this.x[i] - this.plx;
    const rz = this.z[i] - this.plz;
    const d2 = rx * rx + rz * rz;
    if (d2 > 16) return;
    const d = Math.sqrt(d2);
    if (this.pspd > 0.3) {
      const ux = this.pvx / this.pspd;
      const uz = this.pvz / this.pspd;
      const along = rx * ux + rz * uz;
      const lat = rx * uz - rz * ux;
      if (along > -0.6 && along < 1.6 + this.pspd * 0.5 && Math.abs(lat) < 1.1) {
        const s = lat >= 0 ? 1 : -1;
        const k = ((1.1 - Math.abs(lat)) / 1.1) * 1.7;
        this.tpx += uz * s * k;
        this.tpz += -ux * s * k;
      }
    }
    if (d < 0.9 && d > 1e-4) {
      const k = (0.9 - d) * 2.5;
      this.tpx += (rx / d) * k;
      this.tpz += (rz / d) * k;
    }
  }

  /** 0 if a step of (mx, mz) from (x, z) is clear, 1 if a wall or the pool is in the way, 2 if a prop is. */
  private stepBlock(c: CityData, strict: boolean, props: boolean, x: number, z: number, mx: number, mz: number): number {
    const nx = x + mx;
    const nz = z + mz;
    if (strict ? !c.clear(nx, nz) : c.solidAt(nx, nz)) return 1;
    if (!props) return 0;
    const len = Math.sqrt(mx * mx + mz * mz);
    if (len < 1e-6) return 0;
    // the feet, the front of the body, and halfway along a long stride
    if (this.propAt(c, nx, nz) || this.propAt(c, nx + (mx / len) * BODY, nz + (mz / len) * BODY)) return 2;
    if (len > BODY && this.propAt(c, x + mx * 0.5, z + mz * 0.5)) return 2;
    return 0;
  }

  /** A prop stands at (x, z), too tall to step over. (Buildings, the pool and the edge of the plan are the plan's own to answer for.) */
  private propAt(c: CityData, x: number, z: number): boolean {
    return !c.solidAt(x, z) && this.localSolid(x, z, 0) > CREATURE_STEP;
  }

  /** Moves someone by (mx, mz), never into a wall, the pool or a prop. `turn`: walking somewhere, so a prop met square on is turned round. */
  private safeMove(i: number, c: CityData, mx: number, mz: number, dt: number, turn = false) {
    const x = this.x[i];
    const z = this.z[i];
    const nx = x + mx;
    const nz = z + mz;
    // Normally the whole body must stay clear; someone already brushing a wall only needs their feet clear.
    const strict = c.clear(x, z);
    // Props only near the player, where it shows; and someone already standing in one walks out of it.
    let props = false;
    if (this.solid) {
      const px = x - this.plx;
      const pz = z - this.plz;
      props = px * px + pz * pz < PROP_R * PROP_R && !this.propAt(c, x, z);
    }
    let ax = x;
    let az = z;
    const full = this.stepBlock(c, strict, props, x, z, mx, mz);
    if (full === 0) {
      ax = nx;
      az = nz;
    } else if (this.stepBlock(c, strict, props, x, z, mx, 0) === 0) ax = nx;
    else if (this.stepBlock(c, strict, props, x, z, 0, mz) === 0) az = nz;
    // Square on to a prop, x or z alone get next to nowhere: turn aside instead, as little as
    // clears it, to the side this walker always takes, and keep to it a moment.
    const want = Math.sqrt(mx * mx + mz * mz);
    if (turn && full === 2 && want > 1e-4 && Math.hypot(ax - x, az - z) < want * 0.35) {
      if (this.dodge[i] === 0) this.dodge[i] = this.seed[i] < 0.5 ? 1 : -1;
      const ux = mx / want;
      const uz = mz / want;
      turnLoop: for (let k = 0; k < DODGE.length; k++) {
        const ca = Math.cos(DODGE[k]);
        const sa = Math.sin(DODGE[k]);
        for (let t = 0; t < 2; t++) {
          const sd = t === 0 ? this.dodge[i] : -this.dodge[i];
          const rx = ux * ca + uz * sa * sd;
          const rz = uz * ca - ux * sa * sd;
          if (this.stepBlock(c, strict, props, x, z, rx * want, rz * want) !== 0) continue;
          ax = x + rx * want;
          az = z + rz * want;
          this.dodge[i] = sd;
          this.avT[i] = DODGE_T;
          this.avYaw[i] = Math.atan2(rx, rz);
          break turnLoop;
        }
      }
    }
    const moved = Math.hypot(ax - x, az - z) / Math.max(dt, 1e-4);
    this.x[i] = ax;
    this.z[i] = az;
    this.vs[i] += (moved - this.vs[i]) * (1 - Math.exp(-dt * 8));
  }

  /** Steer toward (tx, tz) at speed `want`, avoiding others and the player. Returns the distance left. */
  private moveToward(i: number, c: CityData, tx: number, tz: number, want: number, dt: number, avoid: boolean): number {
    const x = this.x[i];
    const z = this.z[i];
    const dx = tx - x;
    const dz = tz - z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const kid = this.child[i] === 1;
    let hd = d > 1e-3 ? Math.atan2(dx, dz) : this.fac[i];
    if (kid && d > 1.5) hd += 0.3 * Math.sin(this.time * 2.3 + this.seed[i] * 40);
    // on the way round a prop: keep to the heading that clears it a moment longer
    if (this.avT[i] > 0) {
      this.avT[i] -= dt;
      hd = this.avYaw[i];
    }
    const f = this.fac[i];
    const fx = Math.sin(f);
    const fz = Math.cos(f);
    const rgx = -fz;
    const rgz = fx;
    let slow = 1;
    let ax = 0;
    let az = 0;
    if (avoid) {
      const gx0 = Math.floor(x / CELL);
      const gz0 = Math.floor(z / CELL);
      for (let gz = gz0 - 1; gz <= gz0 + 1; gz++) {
        for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) {
          const h = this.hashCell(gx, gz);
          for (let k = this.hStart[h]; k < this.hStart[h + 1]; k++) {
            const j = this.hItems[k];
            if (j === i) continue;
            const rx = x - this.x[j];
            const rz = z - this.z[j];
            const d2 = rx * rx + rz * rz;
            if (d2 > 1.44 || d2 < 1e-8) continue;
            const dd = Math.sqrt(d2);
            const wgt = (1.2 - dd) / 1.2;
            ax += (rx / dd) * wgt * 0.7;
            az += (rz / dd) * wgt * 0.7;
            const ahead = -(rx * fx + rz * fz);
            if (ahead > 0.1 && ahead < 1.1) {
              const lj = -(rx * rgx + rz * rgz);
              if (Math.abs(lj) < 0.55) {
                const same = Math.cos(this.fac[j] - f) > 0.6 && this.vs[j] > 0.2;
                if (same) slow = Math.min(slow, Math.max(0.35, (this.vs[j] + 0.1) / Math.max(0.1, want)));
                else {
                  const side = lj > 0.05 ? -1 : 1;
                  ax += rgx * side * 0.6 * (1.2 - ahead);
                  az += rgz * side * 0.6 * (1.2 - ahead);
                }
              }
            }
          }
        }
      }
    }
    this.playerPush(i);
    ax += this.tpx;
    az += this.tpz;
    const kp = 1 - Math.exp(-dt * 5);
    this.pushX[i] += (ax - this.pushX[i]) * kp;
    this.pushZ[i] += (az - this.pushZ[i]) * kp;
    const pm = Math.hypot(this.pushX[i], this.pushZ[i]);
    if (pm > 1.4) {
      this.pushX[i] *= 1.4 / pm;
      this.pushZ[i] *= 1.4 / pm;
    }
    const diff = wrapPi(hd - f);
    const maxT = (kid ? 4 : 2.6) * dt;
    const dd = clamp(diff, -maxT, maxT);
    this.fac[i] = wrapPi(f + dd);
    this.turn[i] += (dd / Math.max(dt, 1e-4) - this.turn[i]) * (1 - Math.exp(-dt * 4));
    const st = want * slow * Math.max(0.15, Math.cos(diff));
    this.hs[i] += (st - this.hs[i]) * (1 - Math.exp(-dt * 3));
    const nf = this.fac[i];
    this.safeMove(i, c, (Math.sin(nf) * this.hs[i] + this.pushX[i]) * dt, (Math.cos(nf) * this.hs[i] + this.pushZ[i]) * dt, dt, true);
    return d;
  }

  private progress(i: number, c: CityData, d: number, dt: number) {
    if (d < this.bestD[i] - 0.1) {
      this.bestD[i] = d;
      this.stuckT[i] = 0;
      return;
    }
    this.stuckT[i] += dt;
    if (this.stuckT[i] > 4) {
      if (this.ph[i] === P_REJOIN) this.gone(i, 1);
      else this.startRejoin(i, c);
    }
  }

  private startRejoin(i: number, c: CityData) {
    this.ph[i] = P_REJOIN;
    this.rejoinN[i] = -1;
    this.resetStuck(i);
    this.pickRejoin(i, c);
  }

  private pickRejoin(i: number, c: CityData) {
    const n = c.nearestLosNode(this.x[i], this.z[i], 25);
    if (n >= 0) {
      this.rejoinN[i] = n;
      this.tx[i] = c.nx[n];
      this.tz[i] = c.nz[n];
      return;
    }
    const cn = this.crumbN[i];
    if (cn > 0) {
      this.crumbN[i] = cn - 1;
      this.rejoinN[i] = -1;
      this.tx[i] = this.crumbX[i * CRUMBS + cn - 1];
      this.tz[i] = this.crumbZ[i * CRUMBS + cn - 1];
      return;
    }
    this.gone(i, 1);
  }

  private dayNow = 0;

  // ---------------------------------------------------------------- spawning

  private spawn(c: CityData, direct: number): boolean {
    let i = -1;
    for (let k = 0; k < MAXP; k++) {
      if (!this.alive[k]) {
        i = k;
        break;
      }
    }
    if (i < 0) return false;
    let best = -1;
    let fb = -1;
    for (let t = 0; t < 12; t++) {
      const d = c.sampleDoor(this.rand());
      if (d < 0) return false;
      const dist = this.distPlayer(c.dX[d], c.dZ[d]);
      if (dist < 8 || dist > REACH - 10) continue;
      if (this.hiddenAt(c, c.dX[d], c.dZ[d], dist)) {
        best = d;
        break;
      }
      if (fb < 0) fb = d;
    }
    if (best < 0) best = fb;
    if (best < 0) return false;

    const night = bump(this.dayNow, 0, 0.13);
    const kid = this.rand() < 0.18 * (1 - 0.85 * night);
    this.alive[i] = 1;
    this.child[i] = kid ? 1 : 0;
    this.hgt[i] = kid ? 0.55 + this.rand() * 0.1 : 0.92 + this.rand() * 0.16;
    this.pref[i] = kid ? 1.35 + this.rand() * 0.35 : 1.1 + this.rand() * 0.4;
    this.latF[i] = 0.35 + this.rand() * 0.55;
    this.seed[i] = this.rand();
    this.fade[i] = 0;
    this.fadeRate[i] = 1;
    this.leaving[i] = 0;
    this.keeper[i] = 0;
    this.door[i] = -1;
    this.dest[i] = -1;
    this.hs[i] = 0;
    this.vs[i] = 0;
    this.sit[i] = 0;
    this.sitT[i] = 0;
    this.talk[i] = 0;
    this.lookY[i] = 0;
    this.lookP[i] = 0;
    this.lookT[i] = 0;
    this.lookCool[i] = this.rand() * 5;
    this.followCool[i] = 5 + this.rand() * 10;
    this.turn[i] = 0;
    this.pushX[i] = 0;
    this.pushZ[i] = 0;
    this.walkPh[i] = this.rand();
    this.crumbN[i] = 0;
    this.avT[i] = 0;
    this.dodge[i] = 0;
    this.x[i] = c.dX[best];
    this.z[i] = c.dZ[best];
    this.fac[i] = c.dF[best];
    this.resetStuck(i);

    // cloth and silhouette. Children are always the plain wide cone; an elder walks slowly.
    const o = i * 4;
    const banded = dress(c.site.kind, () => this.rand(), this.statA, this.statB, o);
    const sr = this.rand();
    const shape = kid ? 0 : sr < 0.35 ? 0 : sr < 0.65 ? 1 : sr < 0.77 ? 2 : SHAPES - 1;
    if (shape === 2) this.pref[i] *= 0.7;
    this.statB[o + 3] = shape + (banded ? 0.5 : 0);
    this.statA[o + 3] = this.seed[i];
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    if (i >= this.hi) this.hi = i + 1;

    const dsel = this.chooseDest(i, c);
    this.dest[i] = dsel;
    if (dsel >= 0 && this.rand() < direct) {
      const sx = c.slotX[dsel];
      const sz = c.slotZ[dsel];
      const dist = this.distPlayer(sx, sz);
      if (dist > 8 && this.hiddenAt(c, sx, sz, dist)) {
        this.x[i] = sx;
        this.z[i] = sz;
        this.fac[i] = c.slotF[dsel];
        this.startDwell(i, c, true);
        return true;
      }
    }
    if (dsel === -1) this.leaving[i] = 1;
    this.exE[i] = c.dEdge[best];
    this.exX[i] = c.dPx[best];
    this.exZ[i] = c.dPz[best];
    this.tx[i] = this.exX[i];
    this.tz[i] = this.exZ[i];
    this.ph[i] = P_EXIT;
    return true;
  }

  private sendHome(c: CityData) {
    let best = -1;
    let bestS = -Infinity;
    const walkerBias = bump(this.dayNow, 0.5, 0.07) * 1.5 + bump(this.dayNow, 0, 0.13) * 1.5;
    for (let t = 0; t < 8; t++) {
      const i = Math.floor(this.rand() * this.hi);
      if (!this.alive[i] || this.leaving[i] || this.ph[i] === P_GONE) continue;
      const dist = this.distPlayer(this.x[i], this.z[i]);
      let s = dist / 100 + this.rand() * 0.5;
      if (this.hiddenAt(c, this.x[i], this.z[i], dist)) s += 2;
      if (this.ph[i] !== P_DWELL) s += walkerBias;
      if (this.keeper[i] && this.w[K_MARKET] > 0.15) s -= 3;
      if (s > bestS) {
        bestS = s;
        best = i;
      }
    }
    if (best < 0) return;
    this.leaving[best] = 1;
    if (this.ph[best] === P_DWELL) this.timer[best] = Math.min(this.timer[best], 1 + this.rand() * 8);
  }

  // ---------------------------------------------------------------- frame

  update(f: FrameState) {
    const dt = Math.min(f.dt, 0.05);
    this.time = f.time;
    const c = this.city;
    if (!c) {
      this._bustle *= Math.exp(-dt);
      return;
    }
    const u = this.u;
    for (let mi = 0; mi < 2; mi++) {
      const mu = (mi === 0 ? this.figMat : this.blobMat).uniforms;
      if (u.uCityMap && mu.uCityMap !== u.uCityMap) mu.uCityMap = u.uCityMap;
      if (u.uCityRect && mu.uCityRect !== u.uCityRect) mu.uCityRect = u.uCityRect;
      if (u.uCityGround && mu.uCityGround !== u.uCityGround) mu.uCityGround = u.uCityGround;
    }
    c.budget = 3;
    this.dayNow = f.day;
    const site = c.site;

    // player in city-local space
    const pp = f.player.pos;
    const dxw = pp.x - site.cx;
    const dzw = pp.z - site.cz;
    this.plx = c.co * dxw + c.si * dzw;
    this.plz = -c.si * dxw + c.co * dzw;
    const pv = f.player.vel;
    this.pvx = c.co * pv.x + c.si * pv.z;
    this.pvz = -c.si * pv.x + c.co * pv.z;
    this.pspd = Math.hypot(this.pvx, this.pvz);
    this.plh = pp.y - site.groundY;
    this.pGround = this.plh < 2.5;
    this.pFly = !f.player.grounded && this.plh > 2 && this.plh < 20;
    this.windL.set(c.co * f.wind.x + c.si * f.wind.y, -c.si * f.wind.x + c.co * f.wind.y).multiplyScalar(0.5 + f.gust);

    const cam = f.camera;
    this.m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);

    this.weights(f.day);
    this.coverT -= dt;
    if (this.coverT <= 0) {
      this.coverT = 0.5;
      this.cover = Math.min(1, c.coverAt(this.plx, this.plz) / c.maxCover);
    }
    const sizeF = 0.7 + 0.3 * clamp((c.R - 320) / 280, 0, 1);
    const cap = Math.min(MAXP, Math.round(300 * this.density * sizeF));
    this.target = cap * populationAt(f.day) * this.cover;

    // neighbour hash
    const hs = this.hStart;
    hs.fill(0);
    for (let i = 0; i < this.hi; i++) {
      if (!this.alive[i]) continue;
      const h = this.hashCell(Math.floor(this.x[i] / CELL), Math.floor(this.z[i] / CELL));
      this.hKey[i] = h;
      hs[h + 1]++;
    }
    for (let h = 0; h < HASH; h++) hs[h + 1] += hs[h];
    this.hFill.fill(0);
    for (let i = 0; i < this.hi; i++) {
      if (!this.alive[i]) continue;
      const h = this.hKey[i];
      this.hItems[hs[h] + this.hFill[h]++] = i;
    }

    // people
    this.heldT -= dt;
    let active = 0;
    let bustle = 0;
    const k2 = 1 - Math.exp(-dt * 2);
    const k3 = 1 - Math.exp(-dt * 3);
    for (let i = 0; i < this.hi; i++) {
      if (!this.alive[i]) continue;
      if (i === this.heldI && this.heldT > 0 && this.ph[i] !== P_GONE) {
        // being spoken to: stand, turn to the player, and talk
        this.vs[i] *= Math.exp(-dt * 8);
        if (this.sit[i] < 0.5) this.fac[i] += wrapPi(Math.atan2(this.plx - this.x[i], this.plz - this.z[i]) - this.fac[i]) * k3;
        this.talk[i] += (1 - this.talk[i]) * k2;
        this.lookT[i] = Math.max(this.lookT[i], 0.5);
      } else this.step(i, c, dt);
      if (!this.alive[i]) continue;
      const dist = this.distPlayer(this.x[i], this.z[i]);
      if (this.ph[i] !== P_GONE) {
        if (dist > RECYCLE) this.gone(i, 2);
        else if (this.leaving[i] && this.ph[i] !== P_DWELL && this.hiddenAt(c, this.x[i], this.z[i], dist) && (dist > 40 || this.ph[i] === P_WAIT_NODE)) this.gone(i, 1);
      }
      if (this.ph[i] === P_GONE) {
        this.fade[i] -= dt * this.fadeRate[i];
        if (this.fade[i] <= 0) {
          this.kill(i, c);
          continue;
        }
      } else {
        this.fade[i] = Math.min(1, this.fade[i] + dt);
        if (!this.leaving[i]) active++;
      }
      if (dist < 60) bustle += this.fade[i] * (1 - dist / 60);

      // gaze: a few turn to look as you pass; some look up when you fly over
      this.lookCool[i] -= dt;
      this.followCool[i] -= dt;
      let ly = 0;
      let lp = 0;
      const toP = Math.atan2(this.plx - this.x[i], this.plz - this.z[i]);
      if (this.lookCool[i] <= 0 && ((this.pGround && dist < 9) || (this.pFly && dist < 14 + this.plh * 0.5))) {
        const p = this.pFly ? 0.55 : 0.4;
        if (this.rand() < p) this.lookT[i] = 2 + this.rand() * 3;
        this.lookCool[i] = 15 + this.rand() * 20;
      }
      if (this.lookT[i] > 0) {
        this.lookT[i] -= dt;
        const raw = wrapPi(toP - this.fac[i]);
        if (Math.abs(raw) < 2.0) ly = clamp(raw, -1.1, 1.1);
        const hd = Math.max(dist, 1);
        lp = this.pFly ? clamp(Math.atan2(this.plh + 1.0 - 1.5 * this.hgt[i], hd), 0, 0.9) : clamp((1.6 - 1.55 * this.hgt[i]) / hd, 0, 0.4);
      } else if (this.ph[i] === P_DWELL) {
        // listeners turn their heads to whoever is talking
        const sk = this.dest[i] >= 0 ? c.sSpeaker[c.slotSpot[this.dest[i]]] : -1;
        if (sk >= 0 && sk !== i && this.alive[sk]) {
          ly = clamp(wrapPi(Math.atan2(this.x[sk] - this.x[i], this.z[sk] - this.z[i]) - this.fac[i]), -0.9, 0.9);
        }
      }
      this.lookY[i] += (ly - this.lookY[i]) * k3;
      this.lookP[i] += (lp - this.lookP[i]) * k3;
      this.sit[i] += (this.sitT[i] - this.sit[i]) * k2 * 0.7;

      // write
      const o = i * DYN;
      const a = this.dynA;
      a[o] = this.x[i];
      a[o + 1] = this.z[i];
      a[o + 2] = this.fac[i];
      a[o + 3] = this.hgt[i];
      this.walkPh[i] = (this.walkPh[i] + (this.vs[i] * dt) / (1.5 * this.hgt[i])) % 1;
      a[o + 4] = this.walkPh[i];
      a[o + 5] = this.vs[i] / this.hgt[i];
      a[o + 6] = this.sit[i];
      a[o + 7] = this.talk[i];
      a[o + 8] = this.fade[i];
      a[o + 9] = clamp(this.turn[i] * 0.06 * Math.min(1, this.vs[i]), -0.18, 0.18);
      a[o + 10] = this.lookY[i];
      a[o + 11] = this.lookP[i];
    }
    while (this.hi > 0 && !this.alive[this.hi - 1]) this.hi--;
    this.activeN = active;
    this.updateMiners(dt);

    // keep the crowd near the target for the hour
    const deficit = this.target - active;
    const rate = Math.max(2, cap * 0.03);
    if (deficit > 0.5 && c.dN > 0) {
      const big = deficit > Math.max(6, this.target * 0.25);
      this.spawnAcc += dt * rate * (big ? 4 : 1);
      let guard = 0;
      while (this.spawnAcc >= 1 && guard++ < 8) {
        this.spawnAcc -= 1;
        if (!this.spawn(c, big ? 0.75 : 0.35)) {
          this.spawnAcc = 0;
          break;
        }
      }
      this.leaveAcc = 0;
    } else {
      this.spawnAcc = 0;
      if (deficit < -0.5) {
        this.leaveAcc += dt * rate * (deficit < -Math.max(6, this.target * 0.25) ? 3 : 1);
        while (this.leaveAcc >= 1) {
          this.leaveAcc -= 1;
          this.sendHome(c);
        }
      } else this.leaveAcc = 0;
    }

    this._bustle += (Math.min(1, bustle / 25) - this._bustle) * (1 - Math.exp(-dt * 0.8));

    // upload
    this.dyn.clearUpdateRanges();
    if (this.hi > 0) this.dyn.addUpdateRange(0, this.hi * DYN);
    this.dyn.needsUpdate = true;
    if (this.dirtyHi >= this.dirtyLo) {
      this.stat.clearUpdateRanges();
      this.stat.addUpdateRange(this.dirtyLo * 4, (this.dirtyHi - this.dirtyLo + 1) * 4);
      this.stat.needsUpdate = true;
      this.stat2.clearUpdateRanges();
      this.stat2.addUpdateRange(this.dirtyLo * 4, (this.dirtyHi - this.dirtyLo + 1) * 4);
      this.stat2.needsUpdate = true;
      this.dirtyLo = MAXP;
      this.dirtyHi = -1;
    }
    this.figGeo.instanceCount = this.hi;
    this.blobGeo.instanceCount = this.hi;
  }

  private step(i: number, c: CityData, dt: number) {
    const pref = this.child[i] ? this.pref[i] * (1 + 0.25 * Math.sin(this.time * 1.7 + this.seed[i] * 20)) : this.pref[i];
    let talkT = 0;
    switch (this.ph[i]) {
      case P_EXIT: {
        const d = this.moveToward(i, c, this.exX[i], this.exZ[i], Math.min(pref, 0.5 + this.hypotTo(i, this.exX[i], this.exZ[i])), dt, true);
        if (d < 0.5) this.leaveExit(i, c);
        else this.progress(i, c, d, dt);
        break;
      }
      case P_WALK: {
        const e = this.curE[i];
        const n = this.curN[i];
        const o = c.eA[e] === n ? c.eB[e] : c.eA[e];
        const L = c.eLen[e];
        const ux = (c.nx[n] - c.nx[o]) / L;
        const uz = (c.nz[n] - c.nz[o]) / L;
        const lat = c.eLat[e] * this.latF[i];
        const tx = c.nx[n] - uz * lat;
        const tz = c.nz[n] + ux * lat;
        const d = this.moveToward(i, c, tx, tz, pref, dt, true);
        if (d < 1.0 || (tx - this.x[i]) * ux + (tz - this.z[i]) * uz < 0.2) this.arriveNode(i, c, n);
        else {
          this.progress(i, c, d, dt);
          this.maybeFollow(i);
        }
        break;
      }
      case P_APPROACH: {
        const d = this.moveToward(i, c, this.tx[i], this.tz[i], pref, dt, true);
        if (d < 0.6) {
          const dr = this.door[i];
          if (dr >= 0) {
            this.tx[i] = c.dX[dr];
            this.tz[i] = c.dZ[dr];
          } else {
            this.tx[i] = c.slotX[this.dest[i]];
            this.tz[i] = c.slotZ[this.dest[i]];
          }
          this.ph[i] = P_SLOT;
          this.resetStuck(i);
        } else this.progress(i, c, d, dt);
        break;
      }
      case P_SLOT: {
        const dd = this.hypotTo(i, this.tx[i], this.tz[i]);
        const d = this.moveToward(i, c, this.tx[i], this.tz[i], Math.min(pref, 0.25 + dd * 0.9), dt, this.door[i] < 0 ? dd > 1.2 : true);
        // (a slot a prop has come to stand over is as near as they can get: they settle short of it)
        if (d < 0.25 || (d < 1.5 && this.stuckT[i] > 1)) {
          if (this.door[i] >= 0) this.gone(i, 1);
          else this.startDwell(i, c, false);
        } else this.progress(i, c, d, dt);
        break;
      }
      case P_DWELL: {
        const slot = this.dest[i];
        const sp = c.slotSpot[slot];
        const kind = c.sKind[sp];
        this.playerPush(i);
        const kp = 1 - Math.exp(-dt * 5);
        this.pushX[i] += (this.tpx - this.pushX[i]) * kp;
        this.pushZ[i] += (this.tpz - this.pushZ[i]) * kp;
        const bx = c.slotX[slot] - this.x[i];
        const bz = c.slotZ[slot] - this.z[i];
        const bd = Math.hypot(bx, bz);
        const back = bd > 0.04 ? Math.min(0.7, bd * 1.5) / bd : 0;
        this.safeMove(i, c, (this.pushX[i] + bx * back) * dt, (this.pushZ[i] + bz * back) * dt, dt);
        const pushed = Math.hypot(this.pushX[i], this.pushZ[i]) > 0.4;
        this.sitT[i] = pushed ? 0 : this.sitTarget(i, kind);
        let ft = c.slotF[slot];
        if (this.lookT[i] > 0 && !this.keeper[i]) ft += this.lookY[i] * 0.4;
        if (!pushed) this.fac[i] = wrapPi(this.fac[i] + wrapPi(ft - this.fac[i]) * (1 - Math.exp(-dt * 2.5)));
        this.turn[i] *= 0.9;
        this.hs[i] = 0;
        // conversation: one speaker at a time, the others nod along
        if (kind === K_GATHER) {
          const sk = c.sSpeaker[sp];
          const valid = sk >= 0 && this.alive[sk] && this.ph[sk] === P_DWELL && this.dest[sk] >= 0 && c.slotSpot[this.dest[sk]] === sp;
          if (!valid || this.time > c.sSpeakT[sp]) {
            if (this.rand() < 0.5) {
              c.sSpeaker[sp] = i;
              c.sSpeakT[sp] = this.time + 2.5 + this.rand() * 4;
            } else c.sSpeakT[sp] = this.time + 0.3;
          }
          talkT = c.sSpeaker[sp] === i ? 1 : 0.25;
        } else if (kind === K_MARKET || kind === K_STALL) {
          const s0 = c.sSlot0[sp];
          let others = 0;
          for (let q = s0; q < s0 + c.sSlotN[sp]; q++) if (c.slotOwner[q] >= 0 && c.slotOwner[q] !== i) others++;
          if (others > 0) talkT = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(this.time * 0.7 + this.seed[i] * 9 + (this.keeper[i] ? 0 : Math.PI)));
        }
        if (this.keeper[i] && this.w[K_MARKET] < 0.05) this.timer[i] = Math.min(this.timer[i], 5);
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) this.endDwell(i, c);
        break;
      }
      case P_FOLLOW: {
        const pux = this.pspd > 0.2 ? this.pvx / this.pspd : 0;
        const puz = this.pspd > 0.2 ? this.pvz / this.pspd : 0;
        const gx = this.plx - pux * 2.0;
        const gz = this.plz - puz * 2.0;
        const dp = this.distPlayer(this.x[i], this.z[i]);
        const want = dp < 2.2 ? 0 : Math.min(1.9, Math.max(1.0, this.pspd));
        this.moveToward(i, c, gx, gz, want, dt, true);
        const cn = this.crumbN[i];
        const base = i * CRUMBS;
        const lx = cn > 0 ? this.crumbX[base + cn - 1] : this.exX[i];
        const lz = cn > 0 ? this.crumbZ[base + cn - 1] : this.exZ[i];
        if (Math.hypot(this.x[i] - lx, this.z[i] - lz) > 1.5) {
          if (cn >= CRUMBS) {
            this.crumbX.copyWithin(base, base + 1, base + CRUMBS);
            this.crumbZ.copyWithin(base, base + 1, base + CRUMBS);
          }
          const k = Math.min(cn, CRUMBS - 1);
          this.crumbX[base + k] = this.x[i];
          this.crumbZ[base + k] = this.z[i];
          this.crumbN[i] = k + 1;
        }
        this.timer[i] -= dt;
        if (this.timer[i] <= 0 || !this.pGround || dp > 12) this.startRejoin(i, c);
        break;
      }
      case P_REJOIN: {
        const d = this.moveToward(i, c, this.tx[i], this.tz[i], pref, dt, true);
        if (d < 0.8) {
          const n = this.rejoinN[i];
          if (n >= 0) this.arriveNode(i, c, n);
          else this.pickRejoin(i, c);
        } else this.progress(i, c, d, dt);
        break;
      }
      case P_WAIT_EXIT:
      case P_WAIT_NODE: {
        this.hs[i] = 0;
        this.vs[i] *= 0.9;
        this.timer[i] += dt;
        if (this.timer[i] > 5) {
          this.gone(i, 1);
          break;
        }
        if (this.ph[i] === P_WAIT_EXIT) this.leaveExit(i, c);
        else this.arriveNode(i, c, this.curN[i]);
        if (this.ph[i] !== P_WAIT_EXIT && this.ph[i] !== P_WAIT_NODE) this.timer[i] = 0;
        break;
      }
      case P_GONE:
        this.hs[i] *= 0.9;
        this.vs[i] *= 0.9;
        break;
    }
    this.talk[i] += (talkT - this.talk[i]) * (1 - Math.exp(-dt * 2));
  }

  private hypotTo(i: number, x: number, z: number) {
    return Math.hypot(x - this.x[i], z - this.z[i]);
  }

  private sitTarget(i: number, kind: number): number {
    if (kind === K_BENCH) return 1;
    if (kind === K_SHADE) return this.seed[i] < (this.child[i] ? 0.5 : 0.7) ? 1 : 0.22;
    return 0;
  }

  /** Children sometimes trail the player for a few seconds, then lose interest. */
  private maybeFollow(i: number) {
    if (!this.child[i] || this.followCool[i] > 0 || !this.pGround || this.pspd < 0.4) return;
    if (this.distPlayer(this.x[i], this.z[i]) > 7) return;
    this.followCool[i] = 30 + this.rand() * 30;
    if (this.rand() > 0.3) return;
    this.ph[i] = P_FOLLOW;
    this.timer[i] = 3 + this.rand() * 3;
    this.crumbN[i] = 1;
    this.crumbX[i * CRUMBS] = this.x[i];
    this.crumbZ[i * CRUMBS] = this.z[i];
    this.exX[i] = this.x[i];
    this.exZ[i] = this.z[i];
  }
}

// How children weigh each kind of place (market, stall, gather, shade, bench, well, gate, errand).
const KID_W = [0.7, 0.7, 1.3, 0.5, 0.3, 1.0, 0.3, 1.4];
