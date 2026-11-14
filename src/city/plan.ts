// City layout generator: turns a CitySite into a CityPlan (see types.ts for the contract).
//
// Everything is planned on the plan's own 1 m grid, outward from the centre:
//   1. the main square (and the pool of an oasis town),
//   2. 4 to 6 avenues that bend gently from the square to the edge (through gates for a walled hill town),
//   3. the wall and its gates (hill towns only),
//   4. two or three landmarks and, for trade towns, caravan yards near the edge,
//   5. lanes that grow from the avenues as dog-legging walkers, branching and joining each other,
//   6. small pocket squares at lane junctions,
//   7. lots: a random binary split of the whole town, each leaf filled with the largest free
//      rectangle (so lots never overlap and never touch a street), then turned into houses,
//   8. outlying homesteads and walled garden plots that thin out into the sand,
//   9. a trim to the building budget, then the height grid, the places people use and the lamps.
// A mask on the grid records what each cell is (street, open, solid, pool...), so later steps
// only ever build on cells that are still free. All randomness comes from site.seed.

import type { Building, BuildingRole, CityKind, CityPlan, CitySite, RoofKind, Spot, SpotKind } from './types';
import { planRooms } from './rooms';

const STOREY = 3.2;
const TAU = Math.PI * 2;

// Cell states.
const FREE = 0;
const STREET = 1; // inside the width of an avenue, lane or link
const OPEN = 2; // kept open: square, pocket squares, landmark forecourts, market, yards
const BLOCK = 3; // a solid building
const POOL = 4;
const SOFT = 5; // a walk-through thing on what was free ground (garden beds), or a walled yard
const OUTSIDE = 6; // outside the wall of a hill town

/** Half a cell's diagonal: any cell that touches a strip has its centre within this of the strip. */
const PAD = 0.71;

type Rng = () => number;

function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x632be5ab) | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qz = az + t * dz - pz;
  return qx * qx + qz * qz;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Facing angle (0 = +z) of a direction. */
const faceOf = (dx: number, dz: number) => Math.atan2(dx, dz);

interface Street {
  pts: number[];
  width: number;
  kind: 'ring' | 'avenue' | 'lane' | 'link';
  /** A lane whose far end joins another street. */
  joined?: boolean;
}

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

interface LaneReq {
  node: number;
  hd: number;
  parent: number;
  depth: number;
  key: number;
}

interface Gate {
  x: number;
  z: number;
  nx: number;
  nz: number;
}

export function planCity(site: CitySite): CityPlan {
  const plan = new Planner(site).run();
  const { rooms, roomOf } = planRooms(plan);
  plan.rooms = rooms;
  plan.roomOf = roomOf;
  return plan;
}

/**
 * World bearings (atan2(dz, dx) from the centre, radians) at which the avenues reach the edge of
 * town, predicted from the site alone so the terrain around the city can leave ramps and gaps for
 * them without planning the city. Mirrors the random draws of layoutSquare, buildRegion and
 * layoutAvenues, and findGate: keep them in step. For a walled hill town this is where the road
 * out of each gate (straight along the gate's normal) meets the plateau edge.
 */
export function avenueBearings(site: CitySite): number[] {
  const r = makeRng(mix(site.seed | 0, 5));
  const R = site.radius;
  const hill = site.kind === 'hill';
  const ez = site.kind === 'canyon' ? 1 / 1.5 : 1;

  // Hill towns: the square, the walled region and the gates, as the planner makes them.
  let findGate: ((theta: number) => Gate) | null = null;
  if (hill) {
    const r3 = makeRng(mix(site.seed | 0, 3));
    const off = r3() * 8;
    const a = r3() * TAU;
    const sqx = Math.round(Math.cos(a) * off);
    const sqz = Math.round(Math.sin(a) * off);
    const ph = makeRng(mix(site.seed | 0, 4))() * TAU;
    const cs = R >= 430 ? 32 : 24;
    const cK = Math.ceil(R / cs) + 2;
    const rw = 0.62 * R;
    const region = (x: number, z: number): boolean => {
      const i = Math.floor((x + cs / 2) / cs);
      const j = Math.floor((z + cs / 2) / cs);
      if (Math.abs(i) > cK || Math.abs(j) > cK) return false;
      const t = Math.atan2(j * cs, i * cs);
      return Math.hypot(i * cs, j * cs) < rw * (1 + 0.035 * Math.sin(2 * t + ph));
    };
    findGate = (theta: number): Gate => {
      const dx = Math.cos(theta);
      const dz = Math.sin(theta);
      let t = 0;
      while (t < 2 * R && region(sqx + dx * t, sqz + dz * t)) t += 0.5;
      const ai = Math.floor((sqx + dx * (t - 0.5) + cs / 2) / cs);
      const aj = Math.floor((sqz + dz * (t - 0.5) + cs / 2) / cs);
      const bi = Math.floor((sqx + dx * t + cs / 2) / cs);
      const bj = Math.floor((sqz + dz * t + cs / 2) / cs);
      if (ai !== bi) return { x: (bi > ai ? ai + 1 : ai) * cs - cs / 2, z: aj * cs, nx: Math.sign(bi - ai), nz: 0 };
      return { x: ai * cs, z: (bj > aj ? aj + 1 : aj) * cs - cs / 2, nx: 0, nz: Math.sign(bj - aj) };
    };
  }

  let n = R > 470 ? 5 + (r() < 0.5 ? 1 : 0) : 4 + (r() < 0.6 ? 1 : 0);
  if (site.kind === 'canyon') n = R > 450 ? 6 : 4;
  const base = site.kind === 'canyon' ? 0 : r() * TAU;
  const out: number[] = [];
  const gates: Gate[] = [];
  for (let k = 0; k < n; k++) {
    const fixed = site.kind === 'canyon' && (k === 0 || k === n / 2);
    let theta = base + (TAU * k) / n + (fixed ? 0 : (r() - 0.5) * 0.35 * (TAU / n));
    if (findGate) {
      let g = findGate(theta);
      for (let tries = 0; tries < 8 && gates.some((o) => o.x === g.x && o.z === g.z); tries++) {
        theta += tries % 2 === 0 ? 0.12 * (tries + 1) : -0.12 * (tries + 1);
        g = findGate(theta);
      }
      gates.push(g);
      // straight out of the gate to the plateau edge (radius R)
      const gn = g.x * g.nx + g.z * g.nz;
      const s = -gn + Math.sqrt(Math.max(0, gn * gn - (g.x * g.x + g.z * g.z) + R * R));
      out.push(Math.atan2(g.z + g.nz * s, g.x + g.nx * s) + site.rot);
    } else {
      r(); // the avenue's width
      out.push(Math.atan2(Math.sin(theta) * ez, Math.cos(theta)) + site.rot);
    }
  }
  return out;
}

class Planner {
  private readonly site: CitySite;
  private readonly R: number;
  private readonly kind: CityKind;
  private readonly G: number;
  private readonly S: number;
  private readonly mask: Uint8Array;
  private readonly sid: Int32Array;
  private readonly front: Uint8Array;
  private readonly ez: number;
  private readonly za: number;
  private readonly zb: number;
  private readonly tintR: Rng;
  private readonly hist: Int32Array;
  private readonly stk: Int32Array;

  private nx: number[] = [];
  private nz: number[] = [];
  private streets: Street[] = [];
  private buildings: Building[] = [];
  private bGroup: number[] = [];
  private bPrio: number[] = [];
  private groups = 0;
  private spots: Spot[] = [];
  private lamps: Array<{ x: number; y: number; z: number }> = [];
  private pendSpots: Spot[] = [];
  private pendLamps: Array<{ x: number; y: number; z: number }> = [];

  private sq = { x: 0, z: 0, r: 30 };
  private pool: { x: number; z: number; r: number } | null = null;
  private centerNode = -1;
  private ringR = 0;
  private ringNodes: number[] = [];
  private aves: number[] = [];
  private aveAng: number[] = [];
  private gates: Gate[] = [];
  private markets: Rect[] = [];
  private yards: Rect[] = [];
  private gardens: Rect[] = [];
  private pockets: Array<{ x: number; z: number; r: number }> = [];
  private minorSpires = 0;
  private touchParent = false;

  // Hill towns: the walled region is a union of coarse cells.
  private cs = 24;
  private cK = 0;
  private coarse = new Uint8Array(0);

  private edgeList: Array<{ a: number; b: number; width: number }> = [];
  private ehash = new Map<number, number[]>();

  constructor(site: CitySite) {
    this.site = site;
    this.R = site.radius;
    this.kind = site.kind;
    this.G = Math.ceil(site.radius * 1.2);
    this.S = this.G * 2;
    const n = this.S * this.S;
    this.mask = new Uint8Array(n);
    this.sid = new Int32Array(n).fill(-1);
    this.front = new Uint8Array(n);
    this.hist = new Int32Array(this.S + 2);
    this.stk = new Int32Array(this.S + 2);
    this.ez = site.kind === 'canyon' ? 1 / 1.5 : 1;
    const r = this.rng(1);
    this.za = r() * TAU;
    this.zb = r() * TAU;
    this.tintR = this.rng(2);
  }

  private rng(stage: number): Rng {
    return makeRng(mix(this.site.seed | 0, stage));
  }

  run(): CityPlan {
    this.layoutSquare();
    if (this.kind === 'hill') this.buildRegion();
    this.layoutAvenues();
    if (this.kind === 'hill') this.buildWall();
    this.placeLandmarks();
    if (this.kind === 'oasis') this.oasisGardens();
    if (this.kind === 'trade') this.placeCaravanYards();
    this.growLanes();
    this.placePockets();
    if (this.kind !== 'hill') this.placeOutskirts();
    this.fillLots();
    this.trim();
    this.pruneLanes();
    const grid = this.writeGrid();
    this.buildEdges();
    this.makeSpots(grid);
    this.makeLamps(grid);
    // Keep only the nodes that edges use.
    const remap = new Int32Array(this.nx.length).fill(-1);
    const nodes: Array<{ x: number; z: number }> = [];
    const edges = this.edgeList.map((e) => {
      for (const n of [e.a, e.b]) {
        if (remap[n] < 0) {
          remap[n] = nodes.length;
          nodes.push({ x: this.nx[n], z: this.nz[n] });
        }
      }
      return { a: remap[e.a], b: remap[e.b], width: e.width };
    });
    return {
      site: this.site,
      buildings: this.buildings,
      square: { ...this.sq },
      nodes,
      edges,
      spots: this.spots,
      lamps: this.lamps,
      pool: this.pool ? { ...this.pool } : null,
      grid,
      gridSize: this.S,
      gridHalf: this.G,
      rooms: [],
      roomOf: new Uint16Array(0),
    };
  }

  // ---------------------------------------------------------------- shape of the town

  private rho(x: number, z: number): number {
    return Math.hypot(x / this.R, z / (this.R * this.ez));
  }

  /** Outer limit (in rho) of the dense town, wobbling a little with the angle; never above 0.8. */
  private zoneLim(x: number, z: number): number {
    const a = Math.atan2(z / this.ez, x);
    return 0.735 + 0.04 * Math.sin(3 * a + this.za) + 0.02 * Math.sin(5 * a + this.zb);
  }

  private inDense(x: number, z: number): boolean {
    if (this.kind === 'hill') return this.region(x, z);
    return this.rho(x, z) < this.zoneLim(x, z);
  }

  /** 0 at the centre, 1 at the edge of the dense town. */
  private rhoN(x: number, z: number): number {
    if (this.kind === 'hill') return Math.hypot(x, z) / (0.64 * this.R);
    return this.rho(x, z) / this.zoneLim(x, z);
  }

  /** Radius of the plateau edge in the direction of a local point (see cityBlendAt). */
  private edgeR(x: number, z: number): number {
    const c = Math.cos(this.site.rot);
    const s = Math.sin(this.site.rot);
    const wx = c * x - s * z;
    const wz = s * x + c * z;
    const ang = Math.atan2(wz, wx);
    return this.R * (1 + 0.1 * Math.sin(3 * ang + this.site.phase1) + 0.06 * Math.sin(5 * ang + this.site.phase2));
  }

  /** May an outlying thing stand here? Inside 0.92 R and clear of the wobbling plateau edge. */
  private plateauOK(x: number, z: number, pad: number): boolean {
    const d = Math.hypot(x, z);
    return d <= 0.92 * this.R && d <= this.edgeR(x, z) - pad;
  }

  private region(x: number, z: number): boolean {
    const cs = this.cs;
    const i = Math.floor((x + cs / 2) / cs) + this.cK;
    const j = Math.floor((z + cs / 2) / cs) + this.cK;
    const N = 2 * this.cK + 1;
    if (i < 0 || j < 0 || i >= N || j >= N) return false;
    return this.coarse[j * N + i] === 1;
  }

  // ---------------------------------------------------------------- grid helpers

  private cell(x: number, z: number): number {
    const i = Math.floor(x) + this.G;
    const j = Math.floor(z) + this.G;
    if (i < 0 || j < 0 || i >= this.S || j >= this.S) return -1;
    return j * this.S + i;
  }

  private node(x: number, z: number): number {
    this.nx.push(x);
    this.nz.push(z);
    return this.nx.length - 1;
  }

  private rasterCapsule(ax: number, az: number, bx: number, bz: number, rad: number, sidVal: number) {
    const { G, S, mask, sid } = this;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - rad) + G);
    const i1 = Math.min(S - 1, Math.floor(Math.max(ax, bx) + rad) + G);
    const j0 = Math.max(0, Math.floor(Math.min(az, bz) - rad) + G);
    const j1 = Math.min(S - 1, Math.floor(Math.max(az, bz) + rad) + G);
    const r2 = rad * rad;
    for (let j = j0; j <= j1; j++) {
      const cz = j - G + 0.5;
      for (let i = i0; i <= i1; i++) {
        const cx = i - G + 0.5;
        if (segDist2(cx, cz, ax, az, bx, bz) >= r2) continue;
        const k = j * S + i;
        if (mask[k] === FREE) mask[k] = STREET;
        if (mask[k] === STREET && sid[k] < 0) sid[k] = sidVal;
      }
    }
  }

  private rasterFront(ax: number, az: number, bx: number, bz: number, rad: number) {
    const { G, S, front } = this;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - rad) + G);
    const i1 = Math.min(S - 1, Math.floor(Math.max(ax, bx) + rad) + G);
    const j0 = Math.max(0, Math.floor(Math.min(az, bz) - rad) + G);
    const j1 = Math.min(S - 1, Math.floor(Math.max(az, bz) + rad) + G);
    const r2 = rad * rad;
    for (let j = j0; j <= j1; j++) {
      const cz = j - G + 0.5;
      for (let i = i0; i <= i1; i++) {
        if (segDist2(i - G + 0.5, cz, ax, az, bx, bz) < r2) front[j * S + i] = 1;
      }
    }
  }

  private rasterDisc(x: number, z: number, rad: number, val: number, sidVal: number) {
    const { G, S, mask, sid } = this;
    const i0 = Math.max(0, Math.floor(x - rad) + G);
    const i1 = Math.min(S - 1, Math.floor(x + rad) + G);
    const j0 = Math.max(0, Math.floor(z - rad) + G);
    const j1 = Math.min(S - 1, Math.floor(z + rad) + G);
    const r2 = rad * rad;
    for (let j = j0; j <= j1; j++) {
      const dz = j - G + 0.5 - z;
      for (let i = i0; i <= i1; i++) {
        const dx = i - G + 0.5 - x;
        if (dx * dx + dz * dz >= r2) continue;
        const k = j * S + i;
        if (mask[k] === FREE) mask[k] = val;
        if (sidVal >= 0 && mask[k] === val && sid[k] < 0) sid[k] = sidVal;
      }
    }
  }

  /** True if every cell of the rectangle (grown by m) is free and on the grid. */
  private rectFree(x0: number, z0: number, x1: number, z1: number, m = 0): boolean {
    const { G, S, mask } = this;
    const i0 = x0 - m + G;
    const i1 = x1 + m + G;
    const j0 = z0 - m + G;
    const j1 = z1 + m + G;
    if (i0 < 0 || j0 < 0 || i1 > S || j1 > S) return false;
    for (let j = j0; j < j1; j++) {
      const row = j * S;
      for (let i = i0; i < i1; i++) if (mask[row + i] !== FREE) return false;
    }
    return true;
  }

  /** Sets cells of a rectangle to val; with onlyFree, only cells that are still free. */
  private fillRect(x0: number, z0: number, x1: number, z1: number, val: number, onlyFree: boolean) {
    const { G, S, mask } = this;
    const i0 = Math.max(0, x0 + G);
    const i1 = Math.min(S, x1 + G);
    const j0 = Math.max(0, z0 + G);
    const j1 = Math.min(S, z1 + G);
    for (let j = j0; j < j1; j++) {
      const row = j * S;
      for (let i = i0; i < i1; i++) {
        if (!onlyFree || mask[row + i] === FREE) mask[row + i] = val;
      }
    }
  }

  /** No solid, pool, yard or outside cell within rad of the segment. */
  private pathClear(ax: number, az: number, bx: number, bz: number, rad: number): boolean {
    const { G, S, mask } = this;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - rad) + G);
    const i1 = Math.min(S - 1, Math.floor(Math.max(ax, bx) + rad) + G);
    const j0 = Math.max(0, Math.floor(Math.min(az, bz) - rad) + G);
    const j1 = Math.min(S - 1, Math.floor(Math.max(az, bz) + rad) + G);
    const r2 = rad * rad;
    for (let j = j0; j <= j1; j++) {
      const cz = j - G + 0.5;
      for (let i = i0; i <= i1; i++) {
        if (segDist2(i - G + 0.5, cz, ax, az, bx, bz) >= r2) continue;
        const m = mask[j * S + i];
        if (m === BLOCK || m === POOL || m === SOFT || m === OUTSIDE) return false;
      }
    }
    return true;
  }

  private addB(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    h: number,
    roof: RoofKind,
    role: BuildingRole,
    solid: boolean,
    crown: number,
    group = -1,
    prio = 0,
    markSoft = false,
  ) {
    const b: Building = {
      x: (x0 + x1) / 2,
      z: (z0 + z1) / 2,
      w: x1 - x0,
      d: z1 - z0,
      h,
      roof,
      role,
      tint: this.tintR(),
      solid,
      crown,
    };
    this.buildings.push(b);
    this.bGroup.push(group);
    this.bPrio.push(prio);
    if (solid) this.fillRect(x0, z0, x1, z1, BLOCK, false);
    else if (markSoft) this.fillRect(x0, z0, x1, z1, SOFT, true);
  }

  private addStreet(pts: number[], width: number, kind: Street['kind']): number {
    const id = this.streets.length;
    this.streets.push({ pts, width, kind });
    const rad = width / 2 + PAD;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      this.rasterCapsule(this.nx[a], this.nz[a], this.nx[b], this.nz[b], rad, id);
    }
    return id;
  }

  /** Nearest point on a street's centre line. */
  private project(sidv: number, x: number, z: number) {
    const s = this.streets[sidv];
    let best = Infinity;
    let bi = -1;
    let bt = 0;
    for (let i = 0; i + 1 < s.pts.length; i++) {
      const ax = this.nx[s.pts[i]];
      const az = this.nz[s.pts[i]];
      const bx = this.nx[s.pts[i + 1]];
      const bz = this.nz[s.pts[i + 1]];
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = clamp(t, 0, 1);
      const qx = ax + t * dx - x;
      const qz = az + t * dz - z;
      const d2 = qx * qx + qz * qz;
      if (d2 < best) {
        best = d2;
        bi = i;
        bt = t;
      }
    }
    if (bi < 0) return null;
    const a = s.pts[bi];
    const b = s.pts[bi + 1];
    const len = Math.hypot(this.nx[b] - this.nx[a], this.nz[b] - this.nz[a]);
    return {
      i: bi,
      t: bt,
      len,
      x: this.nx[a] + (this.nx[b] - this.nx[a]) * bt,
      z: this.nz[a] + (this.nz[b] - this.nz[a]) * bt,
    };
  }

  /** A node on a street at a projected point, splitting the street there if needed. */
  private attach(sidv: number, p: { i: number; t: number; len: number; x: number; z: number }): number {
    const s = this.streets[sidv];
    if (p.t * p.len < 1.5) return s.pts[p.i];
    if ((1 - p.t) * p.len < 1.5) return s.pts[p.i + 1];
    const n = this.node(p.x, p.z);
    s.pts.splice(p.i + 1, 0, n);
    return n;
  }

  // ---------------------------------------------------------------- square, avenues, wall

  private layoutSquare() {
    const r = this.rng(3);
    const off = r() * 8;
    const a = r() * TAU;
    const x = Math.round(Math.cos(a) * off);
    const z = Math.round(Math.sin(a) * off);
    let sr: number;
    switch (this.kind) {
      case 'trade':
        sr = 34 + r() * 6;
        break;
      case 'oasis': {
        const pr = 18 + r() * 6;
        this.pool = { x, z, r: pr };
        sr = Math.min(40, pr + 14 + r() * 3);
        break;
      }
      case 'hill':
        sr = 24 + r() * 6;
        break;
      default:
        sr = 22 + r() * 6;
    }
    this.sq = { x, z, r: sr };
    // Street 0 is the ring path around the square; the square's cells point at it.
    this.streets.push({ pts: [], width: 6, kind: 'ring' });
    if (this.pool) this.rasterDisc(x, z, this.pool.r + PAD, POOL, -1);
    this.rasterDisc(x, z, sr + PAD, OPEN, 0);
  }

  private buildRegion() {
    const r = this.rng(4);
    this.cs = this.R >= 430 ? 32 : 24;
    const cs = this.cs;
    this.cK = Math.ceil(this.R / cs) + 2;
    const N = 2 * this.cK + 1;
    this.coarse = new Uint8Array(N * N);
    const ph = r() * TAU;
    const rw = 0.62 * this.R;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i - this.cK) * cs;
        const z = (j - this.cK) * cs;
        const t = Math.atan2(z, x);
        if (Math.hypot(x, z) < rw * (1 + 0.035 * Math.sin(2 * t + ph))) this.coarse[j * N + i] = 1;
      }
    }
  }

  /** Where a ray from the square leaves the walled region: the middle of that coarse edge. */
  private findGate(theta: number): Gate {
    const cs = this.cs;
    const dx = Math.cos(theta);
    const dz = Math.sin(theta);
    let t = 0;
    while (t < 2 * this.R && this.region(this.sq.x + dx * t, this.sq.z + dz * t)) t += 0.5;
    const px = this.sq.x + dx * (t - 0.5);
    const pz = this.sq.z + dz * (t - 0.5);
    const qx = this.sq.x + dx * t;
    const qz = this.sq.z + dz * t;
    const ai = Math.floor((px + cs / 2) / cs);
    const aj = Math.floor((pz + cs / 2) / cs);
    const bi = Math.floor((qx + cs / 2) / cs);
    const bj = Math.floor((qz + cs / 2) / cs);
    if (ai !== bi) {
      const X = (bi > ai ? ai + 1 : ai) * cs - cs / 2;
      return { x: X, z: aj * cs, nx: Math.sign(bi - ai), nz: 0 };
    }
    const Z = (bj > aj ? aj + 1 : aj) * cs - cs / 2;
    return { x: ai * cs, z: Z, nx: 0, nz: Math.sign(bj - aj) };
  }

  private layoutAvenues() {
    const r = this.rng(5);
    const R = this.R;
    const sq = this.sq;
    const hill = this.kind === 'hill';
    let n = R > 470 ? 5 + (r() < 0.5 ? 1 : 0) : 4 + (r() < 0.6 ? 1 : 0);
    if (this.kind === 'canyon') n = R > 450 ? 6 : 4;
    const base = this.kind === 'canyon' ? 0 : r() * TAU;
    const ends: Array<{ x: number; z: number }> = [];
    const widths: number[] = [];
    for (let k = 0; k < n; k++) {
      const fixed = this.kind === 'canyon' && (k === 0 || k === n / 2);
      let theta = base + (TAU * k) / n + (fixed ? 0 : (r() - 0.5) * 0.35 * (TAU / n));
      if (hill) {
        let g = this.findGate(theta);
        for (let tries = 0; tries < 8 && this.gates.some((o) => o.x === g.x && o.z === g.z); tries++) {
          theta += tries % 2 === 0 ? 0.12 * (tries + 1) : -0.12 * (tries + 1);
          g = this.findGate(theta);
        }
        this.gates.push(g);
        ends.push({ x: g.x - g.nx * 14, z: g.z - g.nz * 14 });
      } else {
        let f = 0.92;
        let ex = 0;
        let ez = 0;
        for (; f > 0.4; f -= 0.004) {
          ex = sq.x + Math.cos(theta) * R * f;
          ez = sq.z + Math.sin(theta) * R * this.ez * f;
          const d = Math.hypot(ex, ez);
          if (d <= 0.92 * R && d <= this.edgeR(ex, ez) - 6) break;
        }
        ends.push({ x: ex, z: ez });
      }
      widths.push(this.kind === 'trade' ? 11 + Math.floor(r() * 3) : hill ? 9 : 9 + Math.floor(r() * 4));
    }
    const ang = ends.map((e) => Math.atan2(e.z - sq.z, e.x - sq.x));
    this.aveAng = ang;
    this.ringR = this.pool ? this.pool.r + 3 : sq.r - 4;
    const rr = this.ringR;

    // Ring path around the square, with a node where each avenue meets it.
    const order = ang.map((_, i) => i).sort((a, b) => ((ang[a] + TAU) % TAU) - ((ang[b] + TAU) % TAU));
    const ringOf: number[] = new Array(n).fill(-1);
    const ring: number[] = [];
    for (let q = 0; q < n; q++) {
      const k = order[q];
      const k2 = order[(q + 1) % n];
      const a0 = ang[k];
      let arc = (ang[k2] - a0 + TAU) % TAU;
      if (n === 1) arc = TAU;
      ringOf[k] = this.node(sq.x + Math.cos(a0) * rr, sq.z + Math.sin(a0) * rr);
      ring.push(ringOf[k]);
      const m = Math.max(1, Math.ceil((arc * rr) / 14));
      for (let s = 1; s < m; s++) {
        const a = a0 + (arc * s) / m;
        ring.push(this.node(sq.x + Math.cos(a) * rr, sq.z + Math.sin(a) * rr));
      }
    }
    this.ringNodes = ring.slice();
    this.streets[0].pts = [...ring, ring[0]];
    if (!this.pool) this.centerNode = this.node(sq.x, sq.z);

    for (let k = 0; k < n; k++) {
      const pts: number[] = [];
      if (this.centerNode >= 0) pts.push(this.centerNode);
      pts.push(ringOf[k]);
      let px = this.nx[ringOf[k]];
      let pz = this.nz[ringOf[k]];
      const E = ends[k];
      const D = Math.hypot(E.x - px, E.z - pz);
      const A = 0.1 + 0.14 * r();
      const m = 1 + r() * 1.5;
      const ph = r() * TAU;
      for (let it = 0; it < 300; it++) {
        const dx = E.x - px;
        const dz = E.z - pz;
        const dist = Math.hypot(dx, dz);
        if (dist < 16) {
          pts.push(this.node(E.x, E.z));
          break;
        }
        const prog = 1 - dist / D;
        const off = A * Math.sin(ph + m * Math.PI * prog) * Math.min(1, dist / 80);
        const hd = Math.atan2(dz, dx) + off;
        px += Math.cos(hd) * 12;
        pz += Math.sin(hd) * 12;
        pts.push(this.node(px, pz));
      }
      if (hill) {
        const g = this.gates[k];
        pts.push(this.node(g.x, g.z));
        pts.push(this.node(g.x + g.nx * 12, g.z + g.nz * 12));
      }
      const id = this.addStreet(pts, widths[k], 'avenue');
      this.aves.push(id);
      for (let i = 0; i + 1 < pts.length; i++) {
        this.rasterFront(this.nx[pts[i]], this.nz[pts[i]], this.nx[pts[i + 1]], this.nz[pts[i + 1]], widths[k] / 2 + 9);
      }
    }
  }

  private buildWall() {
    const r = this.rng(6);
    const { G, S, mask } = this;
    const wallH = 7 + Math.round(r() * 4) / 2;
    for (let j = 0; j < S; j++) {
      const cz = j - G + 0.5;
      for (let i = 0; i < S; i++) {
        const k = j * S + i;
        if (mask[k] === FREE && !this.region(i - G + 0.5, cz)) mask[k] = OUTSIDE;
      }
    }
    const wm = new Uint8Array(S * S);
    const lim = Math.min(G - 8, Math.ceil(0.95 * this.R));
    const out = (x: number, z: number, o: number) =>
      !this.region(x - o, z - o) || !this.region(x + o, z - o) || !this.region(x - o, z + o) || !this.region(x + o, z + o);
    for (let j = G - lim; j < G + lim; j++) {
      const cz = j - G + 0.5;
      for (let i = G - lim; i < G + lim; i++) {
        const cx = i - G + 0.5;
        if (!this.region(cx, cz)) continue;
        const k = j * S + i;
        if (out(cx, cz, 3)) wm[k] = 1;
        else if (out(cx, cz, 6) && mask[k] === FREE) mask[k] = OPEN; // walkway inside the wall
      }
    }
    const clearWm = (x0: number, z0: number, x1: number, z1: number) => {
      for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
        const k = this.cell(x, z);
        if (k >= 0) wm[k] = 0;
      }
    };
    // Rect from intervals along the gate's tangent (t) and normal (n), relative to the gate.
    const gateRect = (g: Gate, t0: number, t1: number, n0: number, n1: number): Rect => {
      if (g.nx !== 0) {
        const xa = g.nx > 0 ? g.x + n0 : g.x - n1;
        const xb = g.nx > 0 ? g.x + n1 : g.x - n0;
        return { x0: xa, x1: xb, z0: g.z + t0, z1: g.z + t1 };
      }
      const za = g.nz > 0 ? g.z + n0 : g.z - n1;
      const zb = g.nz > 0 ? g.z + n1 : g.z - n0;
      return { x0: g.x + t0, x1: g.x + t1, z0: za, z1: zb };
    };
    const th = wallH + 2.5 + r() * 1.5;
    for (const g of this.gates) {
      const gap = gateRect(g, -5, 5, -7, 3);
      clearWm(gap.x0, gap.z0, gap.x1, gap.z1);
      for (const side of [-1, 1]) {
        // Run the tower to the corner of the coarse edge when less than 3 m would be left over.
        const te = this.cs / 2 - 11 < 3 ? this.cs / 2 : 11;
        const t = gateRect(g, side < 0 ? -te : 5, side < 0 ? -5 : te, -4, 2);
        clearWm(t.x0, t.z0, t.x1, t.z1);
        let ok = true;
        for (let z = t.z0; z < t.z1 && ok; z++) for (let x = t.x0; x < t.x1; x++) {
          const k = this.cell(x, z);
          if (k < 0 || mask[k] === STREET || mask[k] === BLOCK) ok = false;
        }
        if (ok) this.addB(t.x0, t.z0, t.x1, t.z1, th, 'parapet', 'gate', true, 0);
      }
      const ix = g.x - g.nx * 4;
      const iz = g.z - g.nz * 4;
      const tx = -g.nz;
      const tz = g.nx;
      this.pendLamps.push({ x: ix + tx * 4, y: 4.2, z: iz + tz * 4 }, { x: ix - tx * 4, y: 4.2, z: iz - tz * 4 });
      this.pendSpots.push(
        { x: g.x - g.nx * 7 + tx * 3, z: g.z - g.nz * 7 + tz * 3, kind: 'gate', facing: faceOf(g.nx, g.nz), capacity: 3 },
        { x: g.x + g.nx * 7 - tx * 3, z: g.z + g.nz * 7 - tz * 3, kind: 'gate', facing: faceOf(-g.nx, -g.nz), capacity: 3 },
      );
    }
    for (let k = 0; k < S * S; k++) if (wm[k] && mask[k] !== FREE && mask[k] !== OPEN) wm[k] = 0;
    // Greedy split of the wall band into boxes.
    for (let j = G - lim; j < G + lim; j++) {
      for (let i = G - lim; i < G + lim; i++) {
        const k = j * S + i;
        if (!wm[k]) continue;
        let W = 1;
        while (wm[k + W]) W++;
        let D = 1;
        outer: for (; j + D < S; D++) {
          for (let q = 0; q < W; q++) if (!wm[k + D * S + q]) break outer;
        }
        if (W < 2 || D < 2) {
          // Try growing downwards first.
          let D2 = 1;
          while (j + D2 < S && wm[k + D2 * S]) D2++;
          let W2 = 1;
          outer2: for (; W2 < S - i; W2++) {
            for (let q = 0; q < D2; q++) if (!wm[k + q * S + W2]) break outer2;
          }
          if (W2 >= 2 && D2 >= 2) {
            W = W2;
            D = D2;
          }
        }
        for (let q = 0; q < D; q++) for (let p = 0; p < W; p++) wm[k + q * S + p] = 0;
        let x0 = i - G;
        let z0 = j - G;
        // A one-cell sliver (beside a gate tower or a corner) grows into a free neighbour row or column.
        const usable = (x: number, z: number) => {
          const c = this.cell(x, z);
          if (c < 0) return false;
          const m = mask[c];
          return m === FREE || m === OPEN || m === OUTSIDE;
        };
        const colFree = (x: number) => {
          for (let z = z0; z < z0 + D; z++) if (!usable(x, z)) return false;
          return true;
        };
        const rowFree = (z: number) => {
          for (let x = x0; x < x0 + W; x++) if (!usable(x, z)) return false;
          return true;
        };
        const claim = () => {
          for (let z = z0; z < z0 + D; z++) for (let x = x0; x < x0 + W; x++) {
            const c = this.cell(x, z);
            if (c >= 0) wm[c] = 0;
          }
        };
        if (W === 1) {
          if (colFree(x0 + 1)) W = 2;
          else if (colFree(x0 - 1)) {
            x0--;
            W = 2;
          }
        }
        if (D === 1) {
          if (rowFree(z0 + 1)) D = 2;
          else if (rowFree(z0 - 1)) {
            z0--;
            D = 2;
          }
        }
        if (W < 2 || D < 2) continue;
        claim();
        this.addB(x0, z0, x0 + W, z0 + D, wallH, 'parapet', 'wall', true, 0);
      }
    }
  }

  // ---------------------------------------------------------------- landmarks

  private gapsBySize(): Array<{ ang: number; width: number }> {
    const a = this.aveAng.map((v) => (v + TAU) % TAU).sort((p, q) => p - q);
    const out: Array<{ ang: number; width: number }> = [];
    for (let i = 0; i < a.length; i++) {
      const a0 = a[i];
      const a1 = i + 1 < a.length ? a[i + 1] : a[0] + TAU;
      out.push({ ang: (a0 + a1) / 2, width: a1 - a0 });
    }
    return out.sort((p, q) => q.width - p.width);
  }

  private usedGaps = new Set<number>();

  /** A rectangle facing the square in the widest gap between avenues that has room. */
  private nearSquare(W: number, D: number, margin: number): Rect | null {
    const gaps = this.gapsBySize();
    for (let gi = 0; gi < gaps.length; gi++) {
      if (this.usedGaps.has(gi)) continue;
      const g = gaps[gi];
      const dx = Math.cos(g.ang);
      const dz = Math.sin(g.ang);
      for (let d = this.sq.r + 4; d < this.sq.r + 160; d += 2) {
        const cx = this.sq.x + dx * d;
        const cz = this.sq.z + dz * d;
        const x0 = Math.round(cx - W / 2);
        const z0 = Math.round(cz - D / 2);
        const rc = { x0, z0, x1: x0 + W, z1: z0 + D };
        if (!this.denseRect(rc, margin)) continue;
        if (this.rectFree(x0, z0, x0 + W, z0 + D, margin)) {
          this.usedGaps.add(gi);
          return rc;
        }
      }
    }
    return null;
  }

  private denseRect(rc: Rect, m: number): boolean {
    return (
      this.inDense(rc.x0 - m, rc.z0 - m) &&
      this.inDense(rc.x1 + m, rc.z0 - m) &&
      this.inDense(rc.x0 - m, rc.z1 + m) &&
      this.inDense(rc.x1 + m, rc.z1 + m)
    );
  }

  /** Point and tangent at a fraction of an avenue's length. */
  private alongAve(k: number, frac: number) {
    const pts = this.streets[this.aves[k]].pts;
    let total = 0;
    for (let i = 0; i + 1 < pts.length; i++) total += Math.hypot(this.nx[pts[i + 1]] - this.nx[pts[i]], this.nz[pts[i + 1]] - this.nz[pts[i]]);
    let want = total * frac;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = this.nx[pts[i]];
      const az = this.nz[pts[i]];
      const bx = this.nx[pts[i + 1]];
      const bz = this.nz[pts[i + 1]];
      const l = Math.hypot(bx - ax, bz - az);
      if (want <= l || i + 2 === pts.length) {
        const t = l > 0 ? clamp(want / l, 0, 1) : 0;
        return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / (l || 1), tz: (bz - az) / (l || 1) };
      }
      want -= l;
    }
    return { x: this.sq.x, z: this.sq.z, tx: 1, tz: 0 };
  }

  /** A rectangle beside an avenue, between fractions f0 and f1 of its length. */
  private besideAve(
    r: Rng,
    W: number,
    D: number,
    margin: number,
    f0: number,
    f1: number,
    dense: boolean,
  ): { rc: Rect; px: number; pz: number } | null {
    for (let attempt = 0; attempt < 90; attempt++) {
      const k = Math.floor(r() * this.aves.length);
      const w = this.streets[this.aves[k]].width;
      const p = this.alongAve(k, f0 + r() * (f1 - f0));
      const side = r() < 0.5 ? -1 : 1;
      const nx = -p.tz * side;
      const nz = p.tx * side;
      const half = Math.abs(nx) * (W / 2) + Math.abs(nz) * (D / 2);
      const off = w / 2 + PAD + margin + half + 0.6;
      const cx = p.x + nx * off;
      const cz = p.z + nz * off;
      const x0 = Math.round(cx - W / 2);
      const z0 = Math.round(cz - D / 2);
      const rc = { x0, z0, x1: x0 + W, z1: z0 + D };
      if (dense && !this.denseRect(rc, margin)) continue;
      if (!dense) {
        const pad = 6;
        if (
          !this.plateauOK(rc.x0, rc.z0, pad) ||
          !this.plateauOK(rc.x1, rc.z0, pad) ||
          !this.plateauOK(rc.x0, rc.z1, pad) ||
          !this.plateauOK(rc.x1, rc.z1, pad)
        )
          continue;
      }
      if (this.rectFree(x0, z0, x0 + W, z0 + D, margin)) return { rc, px: p.x, pz: p.z };
    }
    return null;
  }

  /** Links a point to the nearest avenue or ring node with a clear straight path. */
  private linkToNetwork(from: number, width: number): boolean {
    const x = this.nx[from];
    const z = this.nz[from];
    const cands: number[] = [...this.ringNodes];
    if (this.centerNode >= 0) cands.push(this.centerNode);
    for (const a of this.aves) for (const p of this.streets[a].pts) cands.push(p);
    cands.sort((p, q) => Math.hypot(this.nx[p] - x, this.nz[p] - z) - Math.hypot(this.nx[q] - x, this.nz[q] - z));
    for (let i = 0; i < Math.min(14, cands.length); i++) {
      const c = cands[i];
      if (this.pathClear(x, z, this.nx[c], this.nz[c], width / 2 + PAD)) {
        this.addStreet([from, c], width, 'link');
        return true;
      }
    }
    return false;
  }

  private reserveOpen(rc: Rect, margin: number) {
    this.fillRect(rc.x0 - margin, rc.z0 - margin, rc.x1 + margin, rc.z1 + margin, OPEN, true);
  }

  private placeLandmarks() {
    const r = this.rng(7);
    const three = this.R >= 440;
    let list: Array<'hall' | 'spire' | 'market' | 'garden'>;
    switch (this.kind) {
      case 'hill':
        list = ['hall', 'spire', 'garden'];
        break;
      case 'canyon':
        list = ['spire', 'hall', 'market'];
        break;
      case 'oasis':
        list = ['garden', 'hall', 'spire'];
        break;
      default:
        list = ['market', 'hall', 'spire'];
    }
    if (!three) list = list.slice(0, 2);
    for (const what of list) {
      if (what === 'hall') this.placeHall(r);
      else if (what === 'spire') this.placeSpire(r);
      else if (what === 'market') this.placeMarket(r, true);
      else this.placeGarden(r);
    }
    // Every town but the canyon gets a market of some size; canyon and small towns a small one.
    if (!list.includes('market')) this.placeMarket(r, false);
  }

  private placeHall(r: Rng) {
    const W = 30 + Math.round(r() * 20);
    const D = clamp(W + Math.round((r() - 0.5) * 8), 30, 50);
    const rc = this.nearSquare(W, D, 3) ?? this.besideAve(r, W, D, 3, 0.15, 0.45, true)?.rc ?? null;
    if (!rc) return;
    const h = 12 + r() * 6;
    const crown = Math.min(20, 0.36 * Math.min(W, D) + r() * 3);
    this.addB(rc.x0, rc.z0, rc.x1, rc.z1, h, 'dome', 'landmark', true, crown);
    this.reserveOpen(rc, 3);
    // Entrance on the face that looks at the square.
    const cx = (rc.x0 + rc.x1) / 2;
    const cz = (rc.z0 + rc.z1) / 2;
    const vx = this.sq.x - cx;
    const vz = this.sq.z - cz;
    let fx = 0;
    let fz = 0;
    if (Math.abs(vx) > Math.abs(vz)) fx = Math.sign(vx);
    else fz = Math.sign(vz);
    const ex = fx !== 0 ? (fx > 0 ? rc.x1 : rc.x0) : cx;
    const ez = fz !== 0 ? (fz > 0 ? rc.z1 : rc.z0) : cz;
    const tx = -fz;
    const tz = fx;
    const span = (fx !== 0 ? D : W) / 4;
    this.pendLamps.push(
      { x: ex + fx * 1.5 + tx * span, y: 3.2, z: ez + fz * 1.5 + tz * span },
      { x: ex + fx * 1.5 - tx * span, y: 3.2, z: ez + fz * 1.5 - tz * span },
    );
    this.pendSpots.push({ x: ex + fx * 2.5, z: ez + fz * 2.5, kind: 'gather', facing: faceOf(fx, fz), capacity: 10 });
  }

  private placeSpire(r: Rng) {
    const s = 6 + Math.round(r() * 4);
    const rc =
      this.kind === 'hill'
        ? this.nearSquare(s, s, 4) ?? this.besideAve(r, s, s, 4, 0.15, 0.4, true)?.rc ?? null
        : this.besideAve(r, s, s, 4, 0.25, 0.5, true)?.rc ?? this.nearSquare(s, s, 4);
    if (!rc) return;
    const h = 30 + r() * 15;
    const crown = 10 + r() * 10;
    this.addB(rc.x0, rc.z0, rc.x1, rc.z1, h, 'spire', 'landmark', true, crown);
    this.reserveOpen(rc, 4);
    const cx = (rc.x0 + rc.x1) / 2;
    const cz = (rc.z0 + rc.z1) / 2;
    const hs = s / 2 + 2;
    this.pendLamps.push({ x: cx + hs, y: 3.2, z: cz + hs }, { x: cx - hs, y: 3.2, z: cz - hs });
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      this.pendSpots.push({ x: cx + dx * (s / 2 + 2), z: cz + dz * (s / 2 + 2), kind: 'gather', facing: faceOf(-dx, -dz), capacity: 5 });
    }
  }

  private placeMarket(r: Rng, landmark: boolean) {
    const big = this.kind === 'trade';
    const L = landmark ? (big ? 56 + Math.round(r() * 14) : 40 + Math.round(r() * 20)) : 30 + Math.round(r() * 10);
    const Wv = landmark ? (big ? 30 + Math.round(r() * 8) : 24 + Math.round(r() * 8)) : 22 + Math.round(r() * 4);
    const longX = r() < 0.5;
    const W = longX ? L : Wv;
    const D = longX ? Wv : L;
    const nearSq = this.kind === 'trade' || this.kind === 'hill' || this.kind === 'oasis';
    const rc =
      (nearSq ? this.nearSquare(W, D, 2) : null) ??
      this.besideAve(r, W, D, 2, 0.15, 0.55, true)?.rc ??
      (nearSq ? null : this.nearSquare(W, D, 2));
    if (!rc) return;
    this.reserveOpen(rc, 2);
    this.markets.push(rc);
    const mapP = (u: number, v: number) => (longX ? { x: rc.x0 + u, z: rc.z0 + v } : { x: rc.x0 + v, z: rc.z0 + u });
    const mapR = (u0: number, v0: number, u1: number, v1: number): Rect =>
      longX
        ? { x0: rc.x0 + u0, z0: rc.z0 + v0, x1: rc.x0 + u1, z1: rc.z0 + v1 }
        : { x0: rc.x0 + v0, z0: rc.z0 + u0, x1: rc.x0 + v1, z1: rc.z0 + u1 };
    // Direction of +v in local x/z, for facings.
    const vdir = longX ? { x: 0, z: 1 } : { x: 1, z: 0 };
    const mid = Math.floor(Wv / 2);
    let u = 1;
    while (u + 6 <= L - 1) {
      const u1 = Math.min(L - 1, u + 9 + Math.floor(r() * 4));
      for (const side of [0, 1]) {
        const v0 = side === 0 ? 1 : mid + 3;
        const v1 = side === 0 ? mid - 3 : Wv - 1;
        if (u1 - u < 4 || v1 - v0 < 3) continue;
        if (r() < 0.12) continue; // an open bay
        const c = mapR(u, v0, u1, v1);
        this.addB(c.x0, c.z0, c.x1, c.z1, 3.4 + r() * 0.6, 'canopy', 'market', false, 0);
        const bc = mapP((u + u1) / 2, side === 0 ? v0 + 1.2 : v1 - 1.2);
        this.pendSpots.push({ x: bc.x, z: bc.z, kind: 'shade', facing: faceOf(vdir.x * (side === 0 ? 1 : -1), vdir.z * (side === 0 ? 1 : -1)), capacity: 3 });
        // Stalls along the aisle side of the bay.
        const sv0 = side === 0 ? v1 - 2 : v0;
        let su = u + 1;
        while (su + 2 <= u1 - 1) {
          const sl = 2 + (r() < 0.4 ? 1 : 0);
          if (su + sl > u1 - 1) break;
          const st = mapR(su, sv0, su + sl, sv0 + 2);
          this.addB(st.x0, st.z0, st.x1, st.z1, 1.1, 'flat', 'stall', false, 0);
          const sp = mapP(su + sl / 2, side === 0 ? v1 + 0.9 : v0 - 0.9);
          const fs = side === 0 ? -1 : 1;
          this.pendSpots.push({ x: sp.x, z: sp.z, kind: 'stall', facing: faceOf(vdir.x * fs, vdir.z * fs), capacity: 2 });
          su += sl + 1 + Math.floor(r() * 2);
        }
      }
      u = u1 + 3;
    }
    for (let uu = 4, alt = 1; uu < L - 3; uu += 7, alt = -alt) {
      const p = mapP(uu, mid + alt);
      this.pendSpots.push({ x: p.x, z: p.z, kind: 'market', facing: faceOf(vdir.x * -alt, vdir.z * -alt), capacity: 6 });
    }
    const a = mapP(1.5, mid);
    const b = mapP(L - 1.5, mid);
    const c = mapP(L / 2, mid);
    const na = this.node(a.x, a.z);
    const nc = this.node(c.x, c.z);
    const nb = this.node(b.x, b.z);
    this.addStreet([na, nc, nb], 4, 'link');
    // Link the end that is nearer the square.
    const da = Math.hypot(a.x - this.sq.x, a.z - this.sq.z);
    const db = Math.hypot(b.x - this.sq.x, b.z - this.sq.z);
    if (!this.linkToNetwork(da < db ? na : nb, 4)) this.linkToNetwork(da < db ? nb : na, 4);
    for (const [u0, v0] of [
      [1, 1],
      [L - 1, 1],
      [1, Wv - 1],
      [L - 1, Wv - 1],
    ]) {
      const p = mapP(u0, v0);
      this.pendLamps.push({ x: p.x, y: 3.2, z: p.z });
    }
  }

  private placeGarden(r: Rng) {
    const Gs = 34 + 2 * Math.floor(r() * 7);
    const rc =
      this.kind === 'oasis' || this.kind === 'hill'
        ? this.nearSquare(Gs, Gs, 2) ?? this.besideAve(r, Gs, Gs, 2, 0.15, 0.5, true)?.rc ?? null
        : this.besideAve(r, Gs, Gs, 2, 0.2, 0.5, true)?.rc ?? null;
    if (!rc) return;
    this.reserveOpen(rc, 2);
    this.gardens.push(rc);
    const half = Gs / 2;
    const cx = rc.x0 + half;
    const cz = rc.z0 + half;
    const wh = 1.2 + r() * 0.4;
    const wall = (x0: number, z0: number, x1: number, z1: number) =>
      this.addB(rc.x0 + x0, rc.z0 + z0, rc.x0 + x1, rc.z0 + z1, wh, 'flat', 'garden', true, 0);
    wall(0, 0, half - 2, 2);
    wall(half + 2, 0, Gs, 2);
    wall(0, Gs - 2, half - 2, Gs);
    wall(half + 2, Gs - 2, Gs, Gs);
    wall(0, 2, 2, half - 2);
    wall(0, half + 2, 2, Gs - 2);
    wall(Gs - 2, 2, Gs, half - 2);
    wall(Gs - 2, half + 2, Gs, Gs - 2);
    const P = 2 * Math.round(Gs * 0.15);
    this.addB(cx - P / 2, cz - P / 2, cx + P / 2, cz + P / 2, 0.3, 'none', 'garden', false, 0);
    const B0 = P / 2 + 3;
    const B1 = half - 3;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const bed = (u0: number, v0: number, u1: number, v1: number) => {
          const xa = sx > 0 ? cx + u0 : cx - u1;
          const xb = sx > 0 ? cx + u1 : cx - u0;
          const za = sz > 0 ? cz + v0 : cz - v1;
          const zb = sz > 0 ? cz + v1 : cz - v0;
          if (xb - xa >= 2 && zb - za >= 2) this.addB(xa, za, xb, zb, 0.5, 'none', 'garden', false, 0);
        };
        bed(B0, 2, B1, B1);
        bed(2, B0, B0, B1);
      }
    }
    // Paths: a ring round the pool and four spokes to the gaps.
    const q = P / 2 + 1.5;
    const ring = [
      this.node(cx, cz - q),
      this.node(cx + q, cz - q),
      this.node(cx + q, cz),
      this.node(cx + q, cz + q),
      this.node(cx, cz + q),
      this.node(cx - q, cz + q),
      this.node(cx - q, cz),
      this.node(cx - q, cz - q),
    ];
    this.addStreet([...ring, ring[0]], 2, 'link');
    const gapsN = [
      { x: cx, z: rc.z0 + 1, nx: 0, nz: -1, mid: ring[0] },
      { x: rc.x1 - 1, z: cz, nx: 1, nz: 0, mid: ring[2] },
      { x: cx, z: rc.z1 - 1, nx: 0, nz: 1, mid: ring[4] },
      { x: rc.x0 + 1, z: cz, nx: -1, nz: 0, mid: ring[6] },
    ];
    // The gap that looks most toward the square links to the network.
    let best = 0;
    let bestDot = -Infinity;
    gapsN.forEach((g, i) => {
      const vx = this.sq.x - cx;
      const vz = this.sq.z - cz;
      const dot = (g.nx * vx + g.nz * vz) / (Math.hypot(vx, vz) || 1);
      if (dot > bestDot) {
        bestDot = dot;
        best = i;
      }
    });
    gapsN.forEach((g, i) => {
      const gn = this.node(g.x, g.z);
      this.addStreet([g.mid, gn], 3, 'link');
      if (i === best) {
        const on = this.node(g.x + g.nx * 3, g.z + g.nz * 3);
        this.addStreet([gn, on], 3, 'link');
        this.linkToNetwork(on, 3);
        const tx = -g.nz;
        const tz = g.nx;
        this.pendLamps.push(
          { x: g.x + g.nx * 2.5 + tx * 2.6, y: 3.2, z: g.z + g.nz * 2.5 + tz * 2.6 },
          { x: g.x + g.nx * 2.5 - tx * 2.6, y: 3.2, z: g.z + g.nz * 2.5 - tz * 2.6 },
        );
      }
      // A bench on the ring facing the pool.
      const bx = this.nx[g.mid] + -g.nz * 2.5;
      const bz = this.nz[g.mid] + g.nx * 2.5;
      this.pendSpots.push({ x: bx, z: bz, kind: 'bench', facing: faceOf(-g.nx, -g.nz), capacity: 3 });
    });
    this.pendSpots.push({ x: cx + q, z: cz + q, kind: 'shade', facing: faceOf(-1, -1), capacity: 3 });
    this.pendSpots.push({ x: cx - q, z: cz - q, kind: 'gather', facing: faceOf(1, 1), capacity: 6 });
  }

  /** Beds, cloth shades and a well in the ring of an oasis square around its pool. */
  private oasisGardens() {
    const pool = this.pool;
    if (!pool) return;
    const r = this.rng(8);
    const sq = this.sq;
    const inner = this.ringR + 2.2;
    const outer = sq.r - 1.2;
    const aveClear = (x: number, z: number, pad: number) => {
      for (const a of this.aves) {
        const s = this.streets[a];
        for (let i = 0; i + 1 < Math.min(s.pts.length, 4); i++) {
          const d2 = segDist2(x, z, this.nx[s.pts[i]], this.nz[s.pts[i]], this.nx[s.pts[i + 1]], this.nz[s.pts[i + 1]]);
          if (d2 < (s.width / 2 + pad) ** 2) return false;
        }
      }
      return true;
    };
    let placed = 0;
    for (let tries = 0; tries < 120 && placed < 16; tries++) {
      const a = r() * TAU;
      const rad = inner + r() * (outer - inner);
      const canopy = placed % 4 === 3;
      const w = canopy ? 4 : 2 + Math.floor(r() * 3);
      const d = canopy ? 4 : 2 + Math.floor(r() * 2);
      const x0 = Math.round(sq.x + Math.cos(a) * rad - w / 2);
      const z0 = Math.round(sq.z + Math.sin(a) * rad - d / 2);
      const corners = [
        [x0, z0],
        [x0 + w, z0],
        [x0, z0 + d],
        [x0 + w, z0 + d],
      ];
      if (!corners.every(([x, z]) => {
        const dd = Math.hypot(x - sq.x, z - sq.z);
        return dd > inner && dd < outer && aveClear(x, z, 1.2);
      }))
        continue;
      if (!aveClear(x0 + w / 2, z0 + d / 2, 1.2)) continue;
      // Not on top of another bed.
      if (this.buildings.some((b) => b.role === 'garden' && !b.solid && Math.abs(b.x - (x0 + w / 2)) < (b.w + w) / 2 + 1 && Math.abs(b.z - (z0 + d / 2)) < (b.d + d) / 2 + 1)) continue;
      if (canopy) {
        this.addB(x0, z0, x0 + w, z0 + d, 3.2, 'canopy', 'garden', false, 0);
        this.pendSpots.push({ x: x0 + w / 2, z: z0 + d / 2, kind: 'shade', facing: faceOf(pool.x - x0, pool.z - z0), capacity: 4 });
      } else {
        this.addB(x0, z0, x0 + w, z0 + d, 0.5, 'none', 'garden', false, 0);
        const px = x0 + w / 2 + Math.cos(a + 1.6) * 2;
        const pz = z0 + d / 2 + Math.sin(a + 1.6) * 2;
        this.pendSpots.push({ x: px, z: pz, kind: 'shade', facing: faceOf(pool.x - px, pool.z - pz), capacity: 2 });
      }
      placed++;
    }
  }

  private placeCaravanYards() {
    const r = this.rng(9);
    const n = 2 + (this.R > 450 ? 1 : 0) + (r() < 0.5 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const Y = 28 + 2 * Math.floor(r() * 7);
      const got = this.besideAve(r, Y, Y, 2, 0.8, 0.97, false);
      if (!got) continue;
      const { rc, px, pz } = got;
      this.reserveOpen(rc, 2);
      this.yards.push(rc);
      const cx = rc.x0 + Y / 2;
      const cz = rc.z0 + Y / 2;
      const vx = px - cx;
      const vz = pz - cz;
      let gx = 0;
      let gz = 0;
      if (Math.abs(vx) > Math.abs(vz)) gx = Math.sign(vx);
      else gz = Math.sign(vz);
      const wh = 2.8 + r() * 0.6;
      const half = Y / 2;
      const wall = (x0: number, z0: number, x1: number, z1: number) =>
        this.addB(rc.x0 + x0, rc.z0 + z0, rc.x0 + x1, rc.z0 + z1, wh, 'flat', 'wall', true, 0);
      const side = (s: 'n' | 's' | 'w' | 'e', gap: boolean) => {
        if (s === 'n' || s === 's') {
          const z0 = s === 'n' ? 0 : Y - 2;
          if (gap) {
            wall(0, z0, half - 5, z0 + 2);
            wall(half + 5, z0, Y, z0 + 2);
          } else wall(0, z0, Y, z0 + 2);
        } else {
          const x0 = s === 'w' ? 0 : Y - 2;
          if (gap) {
            wall(x0, 2, x0 + 2, half - 5);
            wall(x0, half + 5, x0 + 2, Y - 2);
          } else wall(x0, 2, x0 + 2, Y - 2);
        }
      };
      side('n', gz < 0);
      side('s', gz > 0);
      side('w', gx < 0);
      side('e', gx > 0);
      const gxp = cx + gx * (half - 1);
      const gzp = cz + gz * (half - 1);
      const nc = this.node(cx, cz);
      const ng = this.node(gxp, gzp);
      const no = this.node(gxp + gx * 4, gzp + gz * 4);
      this.addStreet([nc, ng, no], 4, 'link');
      this.linkToNetwork(no, 4);
      // Cloth shades along the back wall.
      const bx = -gx;
      const bz = -gz;
      const tx = -bz;
      const tz = bx;
      for (let c = -1; c <= 1; c++) {
        if (c !== 0 && r() < 0.25) continue;
        const ccx = cx + bx * (half - 5) + tx * c * 9;
        const ccz = cz + bz * (half - 5) + tz * c * 9;
        const w = Math.abs(bx) > 0 ? 4 : 7;
        const d = Math.abs(bx) > 0 ? 7 : 4;
        const x0 = Math.round(ccx - w / 2);
        const z0 = Math.round(ccz - d / 2);
        this.addB(x0, z0, x0 + w, z0 + d, 3.4, 'canopy', 'market', false, 0);
        this.pendSpots.push({ x: x0 + w / 2 - bx * 1, z: z0 + d / 2 - bz * 1, kind: 'stall', facing: faceOf(gx, gz), capacity: 3 });
      }
      this.pendSpots.push({ x: cx + tx * 3, z: cz + tz * 3, kind: 'gather', facing: faceOf(gx, gz), capacity: 8 });
      this.pendLamps.push(
        { x: gxp + gx * 2.5 + tx * 6.5, y: 3.2, z: gzp + gz * 2.5 + tz * 6.5 },
        { x: gxp + gx * 2.5 - tx * 6.5, y: 3.2, z: gzp + gz * 2.5 - tz * 6.5 },
      );
    }
  }

  // ---------------------------------------------------------------- lanes

  private growLanes() {
    const r = this.rng(10);
    const sq = this.sq;
    const kf = this.kind === 'canyon' ? 0.85 : this.kind === 'oasis' ? 1.2 : 1;
    const reqs: LaneReq[] = [];
    for (const a of this.aves) {
      const pts = this.streets[a].pts.slice();
      let acc = 0;
      let next = 20 * kf;
      for (let i = 1; i < pts.length; i++) {
        const x = this.nx[pts[i]];
        const z = this.nz[pts[i]];
        const px = this.nx[pts[i - 1]];
        const pz = this.nz[pts[i - 1]];
        acc += Math.hypot(x - px, z - pz);
        if (Math.hypot(x - sq.x, z - sq.z) < sq.r + 10) continue;
        if (!this.inDense(x, z)) continue;
        if (acc < next) continue;
        acc = 0;
        next = (24 + 60 * this.rhoN(x, z)) * (0.75 + 0.5 * r()) * kf;
        const hd = Math.atan2(z - pz, x - px);
        for (const side of [-1, 1]) {
          if (r() < 0.85) {
            reqs.push({ node: pts[i], hd: hd + (side * Math.PI) / 2 + (r() - 0.5) * 0.5, parent: a, depth: r() < 0.55 ? 0 : 1, key: Math.hypot(x, z) });
          }
        }
      }
    }
    const aveNodes = new Set<number>();
    for (const a of this.aves) for (const p of this.streets[a].pts) aveNodes.add(p);
    for (const n of this.ringNodes) {
      if (aveNodes.has(n)) continue;
      const hd = Math.atan2(this.nz[n] - sq.z, this.nx[n] - sq.x);
      reqs.push({ node: n, hd, parent: 0, depth: 1, key: 0 });
    }
    reqs.sort((p, q) => p.key - q.key);
    const queue = reqs;
    for (let qi = 0; qi < queue.length && qi < 8000; qi++) this.walk(queue[qi], queue, r);
  }

  /** Checks the disc a lane would cover: -2 blocked, a street id when it meets one, -1 clear. */
  private probe(x: number, z: number, rad: number, parent: number, left: boolean, walked: number): number {
    const { G, S, mask, sid } = this;
    this.touchParent = false;
    let hit = -1;
    const i0 = Math.floor(x - rad) + G;
    const i1 = Math.floor(x + rad) + G;
    const j0 = Math.floor(z - rad) + G;
    const j1 = Math.floor(z + rad) + G;
    if (i0 < 0 || j0 < 0 || i1 >= S || j1 >= S) return -2;
    const r2 = rad * rad;
    for (let j = j0; j <= j1; j++) {
      const dz = j - G + 0.5 - z;
      for (let i = i0; i <= i1; i++) {
        const dx = i - G + 0.5 - x;
        if (dx * dx + dz * dz >= r2) continue;
        const k = j * S + i;
        const m = mask[k];
        if (m === FREE) continue;
        if (m === STREET || m === OPEN) {
          const s = sid[k];
          if (s >= 0) {
            if (s === parent && (!left || walked < 10)) {
              this.touchParent = true;
              continue;
            }
            hit = s;
            continue;
          }
          if (m === OPEN) return -2;
          continue;
        }
        return -2;
      }
    }
    return hit;
  }

  private walk(q: LaneReq, queue: LaneReq[], r: Rng) {
    const depth = q.depth;
    const w = depth === 0 ? (r() < 0.5 ? 4 : 5) : depth === 1 ? (r() < 0.6 ? 3 : 4) : 3;
    const rad = w / 2 + PAD;
    const maxLen = [240, 110, 65, 40][depth] * (0.6 + 0.7 * r());
    let x = this.nx[q.node];
    let z = this.nz[q.node];
    let hd = q.hd;
    const base = q.hd;
    const bx: number[] = [x];
    const bz: number[] = [z];
    let walked = 0;
    let left = false;
    let segLeft = 6 + r() * 18;
    let jog = false;
    let prevHd = hd;
    let hit = -1;
    while (walked < maxLen) {
      const cx = x + Math.cos(hd);
      const cz = z + Math.sin(hd);
      if (!this.inDense(cx, cz)) break;
      const p = this.probe(cx, cz, rad, q.parent, left, walked);
      if (p === -2) break;
      x = cx;
      z = cz;
      walked++;
      if (!this.touchParent) left = true;
      if (p >= 0) {
        hit = p;
        break;
      }
      if (left && walked > 6) {
        const sx = -Math.sin(hd);
        const sz = Math.cos(hd);
        for (const s of [-1, 1]) {
          const k = this.cell(x + sx * s * (rad + 5), z + sz * s * (rad + 5));
          if (k < 0) continue;
          const m = this.mask[k];
          const sd = this.sid[k];
          if ((m === STREET || m === OPEN) && sd >= 0 && (sd !== q.parent || walked > 12)) {
            hit = sd;
            break;
          }
        }
        if (hit >= 0) break;
      }
      if (--segLeft <= 0) {
        bx.push(x);
        bz.push(z);
        if (jog) {
          hd = prevHd;
          jog = false;
          segLeft = 8 + r() * 20;
        } else if (r() < 0.2) {
          prevHd = hd;
          hd += (r() < 0.5 ? -1 : 1) * (1.2 + r() * 0.4);
          jog = true;
          segLeft = 3 + r() * 4;
        } else {
          hd = clamp(hd + (r() - 0.5) * 0.9, base - 1.0, base + 1.0);
          segLeft = 8 + r() * 22;
        }
      }
    }
    if (walked < 8) return;
    const lx = bx[bx.length - 1];
    const lz = bz[bz.length - 1];
    if (Math.hypot(lx - x, lz - z) > 0.5) {
      bx.push(x);
      bz.push(z);
    } else {
      bx[bx.length - 1] = x;
      bz[bz.length - 1] = z;
    }
    let endNode = -1;
    if (hit >= 0) {
      const p = this.project(hit, x, z);
      if (p && this.pathClear(x, z, p.x, p.z, rad)) endNode = this.attach(hit, p);
    }
    const pts = [q.node];
    for (let i = 1; i < bx.length; i++) pts.push(this.node(bx[i], bz[i]));
    if (endNode >= 0 && endNode !== pts[pts.length - 1]) pts.push(endNode);
    const id = this.addStreet(pts, w, 'lane');
    if (endNode >= 0) this.streets[id].joined = true;
    if (depth >= 3) return;
    const pb = [0.6, 0.45, 0.3][depth] * (1 - 0.45 * clamp(this.rhoN(this.nx[q.node], this.nz[q.node]), 0, 1));
    const last = endNode >= 0 ? pts.length - 2 : pts.length - 1;
    for (let i = 1; i <= last; i++) {
      if (r() >= pb) continue;
      const a = pts[i];
      const b = pts[i - 1];
      const h = Math.atan2(this.nz[a] - this.nz[b], this.nx[a] - this.nx[b]);
      const side = r() < 0.5 ? -1 : 1;
      queue.push({ node: a, hd: h + (side * Math.PI) / 2 + (r() - 0.5) * 0.4, parent: id, depth: depth + 1, key: 0 });
      if (r() < 0.25) queue.push({ node: a, hd: h - (side * Math.PI) / 2 + (r() - 0.5) * 0.4, parent: id, depth: depth + 1, key: 0 });
    }
  }

  private placePockets() {
    const r = this.rng(11);
    const deg = new Int32Array(this.nx.length);
    for (const s of this.streets) {
      for (let i = 0; i + 1 < s.pts.length; i++) {
        deg[s.pts[i]]++;
        deg[s.pts[i + 1]]++;
      }
    }
    const cands: number[] = [];
    for (let s = 1; s < this.streets.length; s++) {
      const st = this.streets[s];
      if (st.kind !== 'lane') continue;
      for (const p of st.pts) if (deg[p] >= 3) cands.push(p);
    }
    for (let i = cands.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [cands[i], cands[j]] = [cands[j], cands[i]];
    }
    const want = Math.round(this.R / 22);
    for (const n of cands) {
      if (this.pockets.length >= want) break;
      const x = this.nx[n];
      const z = this.nz[n];
      const k = this.cell(x, z);
      if (k < 0 || this.front[k]) continue;
      if (Math.hypot(x - this.sq.x, z - this.sq.z) < this.sq.r + 30) continue;
      if (this.rhoN(x, z) > 0.92) continue;
      if (this.pockets.some((p) => Math.hypot(p.x - x, p.z - z) < 45)) continue;
      const pr = 4 + r() * 4;
      this.rasterDisc(x, z, pr, OPEN, -1);
      this.pockets.push({ x, z, r: pr });
    }
  }

  // ---------------------------------------------------------------- lots and houses

  private lotF = 1;

  private fillLots() {
    const r = this.rng(12);
    this.lotF = 1 + clamp((this.R - 320) / 280, 0, 1) * 0.12;
    const L = Math.ceil((this.kind === 'hill' ? 0.86 : 0.82) * this.R);
    const stack: number[] = [-L, -L, L, L];
    const lim = (this.kind === 'hill' ? 0.9 : 0.86) * this.R;
    // 1. Split the whole town into leaves.
    const leaves: Array<{ x0: number; z0: number; x1: number; z1: number; rn: number; key: number }> = [];
    while (stack.length) {
      const z1 = stack.pop()!;
      const x1 = stack.pop()!;
      const z0 = stack.pop()!;
      const x0 = stack.pop()!;
      const nxp = clamp(0, x0, x1);
      const nzp = clamp(0, z0, z1);
      if (Math.hypot(nxp, nzp) > lim) continue;
      const w = x1 - x0;
      const d = z1 - z0;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const t = this.lotSize(cx, cz) * (0.8 + 0.4 * r());
      if (w > t * 1.3 || d > t * 1.3) {
        if (w >= d) {
          const s = clamp(x0 + Math.round(w * (0.3 + 0.4 * r())), x0 + 3, x1 - 3);
          stack.push(x0, z0, s, z1, s, z0, x1, z1);
        } else {
          const s = clamp(z0 + Math.round(d * (0.3 + 0.4 * r())), z0 + 3, z1 - 3);
          stack.push(x0, z0, x1, s, x0, s, x1, z1);
        }
        continue;
      }
      if (!this.inDense(cx, cz)) {
        r();
        continue;
      }
      // 2. How much this leaf wants a house: all of the core, thinning to a few at the edge,
      // and more along streets so the outer houses line the lanes.
      const rn = this.rhoN(cx, cz);
      const fall = Math.max(0, rn - 0.28) / (this.kind === 'oasis' ? 0.4 : 0.3);
      const p0 = this.kind === 'oasis' ? 0.85 : 0.95;
      let p = Math.max(0.07, p0 * Math.exp(-fall * fall));
      if (this.touchesStreet(x0, z0, x1, z1)) p *= 1.5;
      leaves.push({ x0, z0, x1, z1, rn, key: r() / Math.max(0.02, p) });
    }
    // 3. Build the most wanted leaves until the budget is spent. Leaves never overlap, so order is free.
    leaves.sort((a, b) => a.key - b.key);
    const total = this.budget();
    for (const lf of leaves) {
      if (this.buildings.length >= total || lf.key > 40) break;
      if (lf.rn > 0.5 && r() < 0.1) {
        // A walled-in kitchen garden instead of a house.
        const g = this.maxRect(lf.x0 + 1, lf.z0 + 1, lf.x1 - 1, lf.z1 - 1);
        if (g) this.bedRows(g, r, this.groups++, r() * 0.6);
        continue;
      }
      this.leaf(lf.x0, lf.z0, lf.x1, lf.z1, lf.rn, r);
    }
  }

  private budget(): number {
    return Math.round(250 + clamp((this.R - 320) / 280, 0, 1) * 450);
  }

  private touchesStreet(x0: number, z0: number, x1: number, z1: number): boolean {
    const { mask } = this;
    for (let x = x0 - 1; x <= x1; x += 2) {
      const a = this.cell(x, z0 - 1);
      const b = this.cell(x, z1);
      if ((a >= 0 && mask[a] === STREET) || (b >= 0 && mask[b] === STREET)) return true;
    }
    for (let z = z0 - 1; z <= z1; z += 2) {
      const a = this.cell(x0 - 1, z);
      const b = this.cell(x1, z);
      if ((a >= 0 && mask[a] === STREET) || (b >= 0 && mask[b] === STREET)) return true;
    }
    return false;
  }

  private lotSize(x: number, z: number): number {
    const rn = clamp(this.rhoN(x, z), 0, 1.2);
    const kf = this.kind === 'canyon' ? 0.82 : this.kind === 'oasis' ? 1.15 : this.kind === 'trade' ? 1.05 : 0.95;
    return (16 + 8 * rn) * kf * this.lotF;
  }

  private leaf(x0: number, z0: number, x1: number, z1: number, rn: number, r: Rng) {
    const w = x1 - x0;
    const d = z1 - z0;
    let a0 = x0;
    let b0 = z0;
    let a1 = x1;
    let b1 = z1;
    const sb = 0.06 + 0.2 * clamp(rn, 0, 1);
    if (w >= 7) {
      if (r() < sb) a0++;
      if (r() < sb) a1--;
    }
    if (d >= 7) {
      if (r() < sb) b0++;
      if (r() < sb) b1--;
    }
    const first = this.maxRect(a0, b0, a1, b1);
    if (!first) return;
    this.makeHouse(first, rn, r);
    const left = w * d - (first.x1 - first.x0) * (first.z1 - first.z0);
    if (left > 40 && r() < 0.75) {
      const second = this.maxRect(a0, b0, a1, b1);
      if (second && (second.x1 - second.x0) * (second.z1 - second.z0) >= 16) this.makeHouse(second, rn, r);
    }
  }

  /** Largest rectangle of free cells (both sides >= 3, area >= 12) inside a rectangle. */
  private maxRect(x0: number, z0: number, x1: number, z1: number): Rect | null {
    const { G, S, mask, hist: H, stk: st } = this;
    const w = x1 - x0;
    if (w < 3 || z1 - z0 < 3) return null;
    H.fill(0, 0, w + 1);
    let best = 0;
    let rx0 = 0;
    let rz0 = 0;
    let rx1 = 0;
    let rz1 = 0;
    for (let z = z0; z < z1; z++) {
      const row = (z + G) * S + x0 + G;
      for (let i = 0; i < w; i++) H[i] = mask[row + i] === FREE ? H[i] + 1 : 0;
      H[w] = 0;
      let top = 0;
      for (let i = 0; i <= w; i++) {
        const h = H[i];
        while (top > 0 && H[st[top - 1]] >= h) {
          const hh = H[st[--top]];
          const l = top > 0 ? st[top - 1] + 1 : 0;
          const ww = i - l;
          if (hh >= 3 && ww >= 3 && hh * ww > best) {
            best = hh * ww;
            rx0 = x0 + l;
            rx1 = x0 + i;
            rz1 = z + 1;
            rz0 = z + 1 - hh;
          }
        }
        st[top++] = i;
      }
    }
    return best >= 12 ? { x0: rx0, z0: rz0, x1: rx1, z1: rz1 } : null;
  }

  private bedRows(g: Rect, r: Rng, group: number, prio: number) {
    const w = g.x1 - g.x0;
    const d = g.z1 - g.z0;
    const alongX = w >= d;
    const span = alongX ? d : w;
    let v = 0;
    while (v + 2 <= span) {
      const t = Math.min(span - v, 2 + Math.floor(r() * 2));
      if (t < 2) break;
      if (alongX) this.addB(g.x0, g.z0 + v, g.x1, g.z0 + v + t, 0.45, 'none', 'garden', false, 0, group, prio, true);
      else this.addB(g.x0 + v, g.z0, g.x0 + v + t, g.z1, 0.45, 'none', 'garden', false, 0, group, prio, true);
      v += t + 1;
    }
  }

  private makeHouse(rc: Rect, rn: number, r: Rng, group = -1, prio = -1) {
    const w = rc.x1 - rc.x0;
    const d = rc.z1 - rc.z0;
    if (group < 0) {
      group = this.groups++;
    }
    const k = this.cell((rc.x0 + rc.x1) / 2, (rc.z0 + rc.z1) / 2);
    const front = k >= 0 && this.front[k] === 1;
    if (prio < 0) prio = (1 - clamp(rn, 0, 1)) + r() * 0.5 + (front ? 0.3 : 0);
    // Very long thin lots become two houses.
    if (Math.max(w, d) > 3 * Math.min(w, d) && Math.max(w, d) >= 10) {
      if (w >= d) {
        const s = rc.x0 + Math.round(w * (0.4 + 0.2 * r()));
        this.makeHouse({ ...rc, x1: s }, rn, r, group, prio);
        this.makeHouse({ ...rc, x0: s }, rn, r, this.groups++, prio);
      } else {
        const s = rc.z0 + Math.round(d * (0.4 + 0.2 * r()));
        this.makeHouse({ ...rc, z1: s }, rn, r, group, prio);
        this.makeHouse({ ...rc, z0: s }, rn, r, this.groups++, prio);
      }
      return;
    }
    let sf = 1 + 2.7 * Math.pow(Math.max(0, 1 - rn), 1.3) + (r() - 0.5) * 1.3;
    if (front) sf += 0.7;
    if (this.kind === 'hill') sf += rn < 0.45 ? 0.9 : 0.2;
    else if (this.kind === 'canyon') sf += 0.6;
    else if (this.kind === 'oasis') sf -= 0.6;
    const s = clamp(Math.round(sf), 1, 4);
    const h = s * STOREY;
    const add = (x0: number, z0: number, x1: number, z1: number, hh: number, roof: RoofKind, crown: number, role: BuildingRole = 'house') =>
      this.addB(x0, z0, x1, z1, hh, roof, role, true, crown, group, prio);

    // A slender tower with a lower house wrapped round it.
    const maxSpires = 3 + Math.round(this.R / 120);
    if (this.minorSpires < maxSpires && front && rn < 0.75 && Math.min(w, d) >= 7 && r() < 0.06) {
      this.minorSpires++;
      const ts = 4 + (r() < 0.5 ? 1 : 0);
      const left = r() < 0.5;
      const top = r() < 0.5;
      const tx0 = left ? rc.x0 : rc.x1 - ts;
      const tz0 = top ? rc.z0 : rc.z1 - ts;
      add(tx0, tz0, tx0 + ts, tz0 + ts, Math.max(h + 6.4, 15 + r() * 8), 'spire', 5 + r() * 5, 'hall');
      // The rest of the lot: a full-depth strip beside the tower and a short one behind it.
      if (left) add(rc.x0 + ts, rc.z0, rc.x1, rc.z1, h, 'parapet', 0);
      else add(rc.x0, rc.z0, rc.x1 - ts, rc.z1, h, 'parapet', 0);
      const sx0 = left ? rc.x0 : rc.x1 - ts;
      if (top) add(sx0, rc.z0 + ts, sx0 + ts, rc.z1, Math.max(STOREY, h - STOREY), 'terrace', 0);
      else add(sx0, rc.z0, sx0 + ts, rc.z1 - ts, Math.max(STOREY, h - STOREY), 'terrace', 0);
      return;
    }
    // Stepped terrace: a lower block attached to a taller one.
    if (s >= 2 && Math.max(w, d) >= 10 && r() < 0.32) {
      const tallRoof: RoofKind = w * d >= 90 && r() < 0.35 ? 'windtower' : 'parapet';
      const tallCrown = tallRoof === 'windtower' ? 3 + r() * 2 : 0;
      const lowH = (s - 1) * STOREY;
      const lowFirst = r() < 0.5;
      if (w >= d) {
        const sp = clamp(Math.round(w * (0.35 + 0.15 * r())), 3, w - 3);
        const cut = lowFirst ? rc.x0 + sp : rc.x1 - sp;
        if (lowFirst) {
          add(rc.x0, rc.z0, cut, rc.z1, lowH, 'terrace', 0);
          add(cut, rc.z0, rc.x1, rc.z1, h, tallRoof, tallCrown);
        } else {
          add(rc.x0, rc.z0, cut, rc.z1, h, tallRoof, tallCrown);
          add(cut, rc.z0, rc.x1, rc.z1, lowH, 'terrace', 0);
        }
      } else {
        const sp = clamp(Math.round(d * (0.35 + 0.15 * r())), 3, d - 3);
        const cut = lowFirst ? rc.z0 + sp : rc.z1 - sp;
        if (lowFirst) {
          add(rc.x0, rc.z0, rc.x1, cut, lowH, 'terrace', 0);
          add(rc.x0, cut, rc.x1, rc.z1, h, tallRoof, tallCrown);
        } else {
          add(rc.x0, rc.z0, rc.x1, cut, h, tallRoof, tallCrown);
          add(rc.x0, cut, rc.x1, rc.z1, lowH, 'terrace', 0);
        }
      }
      return;
    }
    const m = Math.min(w, d);
    if (m >= 5 && Math.abs(w - d) <= 3 && r() < (this.kind === 'oasis' ? 0.12 : 0.08)) {
      add(rc.x0, rc.z0, rc.x1, rc.z1, h, 'dome', 0.42 * m, w * d >= 120 && front ? 'hall' : 'house');
      return;
    }
    if (s >= 2 && w * d >= 110 && r() < 0.3) {
      add(rc.x0, rc.z0, rc.x1, rc.z1, h, 'windtower', 3 + r() * 2);
      return;
    }
    add(rc.x0, rc.z0, rc.x1, rc.z1, h, r() < 0.6 ? 'parapet' : 'flat', 0);
  }

  // ---------------------------------------------------------------- outskirts

  private placeOutskirts() {
    const r = this.rng(13);
    const R = this.R;
    const want = Math.round(R / 28);
    let placed = 0;
    for (let attempt = 0; attempt < want * 10 && placed < want; attempt++) {
      let cx: number;
      let cz: number;
      let tx: number;
      let tz: number;
      if (r() < 0.65) {
        const k = Math.floor(r() * this.aves.length);
        const p = this.alongAve(k, 0.7 + r() * 0.3);
        const side = r() < 0.5 ? -1 : 1;
        const w = this.streets[this.aves[k]].width;
        const lat = w / 2 + 6 + r() * 45;
        cx = p.x - p.tz * side * lat;
        cz = p.z + p.tx * side * lat;
        tx = p.x;
        tz = p.z;
      } else {
        const a = r() * TAU;
        const rr = 0.72 + r() * 0.2;
        cx = Math.cos(a) * R * rr;
        cz = Math.sin(a) * R * this.ez * rr;
        tx = this.sq.x;
        tz = this.sq.z;
      }
      if (this.rho(cx, cz) < this.zoneLim(cx, cz) - 0.04) continue;
      if (this.rho(cx, cz) > 0.9) continue;
      const homestead = r() < 0.68;
      let Lu: number;
      let Lv: number;
      let hw = 0;
      let hd = 0;
      let sm = 0;
      if (homestead) {
        hw = 6 + Math.floor(r() * 6);
        hd = 6 + Math.floor(r() * 5);
        sm = 1 + Math.floor(r() * 3);
        Lu = hw + 2 * sm + 4;
        Lv = 2 + hd + 4 + Math.floor(r() * 6) + 2;
      } else {
        Lu = 12 + Math.floor(r() * 14);
        Lv = 10 + Math.floor(r() * 10);
      }
      // The gap faces the avenue (or the town).
      const gx = tx - cx;
      const gz = tz - cz;
      const o = Math.abs(gx) > Math.abs(gz) ? (gx > 0 ? 2 : 3) : gz > 0 ? 0 : 1;
      const W = o >= 2 ? Lv : Lu;
      const D = o >= 2 ? Lu : Lv;
      const x0 = Math.round(cx - W / 2);
      const z0 = Math.round(cz - D / 2);
      const x1 = x0 + W;
      const z1 = z0 + D;
      if (!this.plateauOK(x0, z0, 8) || !this.plateauOK(x1, z0, 8) || !this.plateauOK(x0, z1, 8) || !this.plateauOK(x1, z1, 8)) continue;
      if (!this.rectFree(x0, z0, x1, z1, 2)) continue;
      const map = (u0: number, v0: number, u1: number, v1: number): Rect => {
        switch (o) {
          case 0:
            return { x0: x0 + u0, z0: z0 + v0, x1: x0 + u1, z1: z0 + v1 };
          case 1:
            return { x0: x0 + u0, z0: z1 - v1, x1: x0 + u1, z1: z1 - v0 };
          case 2:
            return { x0: x0 + v0, z0: z0 + u0, x1: x0 + v1, z1: z0 + u1 };
          default:
            return { x0: x1 - v1, z0: z0 + u0, x1: x1 - v0, z1: z0 + u1 };
        }
      };
      const group = this.groups++;
      const prio = 0.9 + r() * 0.4;
      const wh = 1 + r() * 0.6;
      const solidAt = (u0: number, v0: number, u1: number, v1: number, h: number, roof: RoofKind, role: BuildingRole, crown = 0) => {
        if (u1 - u0 < 2 || v1 - v0 < 2) return;
        const m = map(u0, v0, u1, v1);
        this.addB(m.x0, m.z0, m.x1, m.z1, h, roof, role, true, crown, group, prio);
      };
      const bedAt = (u0: number, v0: number, u1: number, v1: number) => {
        if (u1 - u0 < 2 || v1 - v0 < 2) return;
        const m = map(u0, v0, u1, v1);
        this.addB(m.x0, m.z0, m.x1, m.z1, 0.45, 'none', 'garden', false, 0, group, prio);
      };
      const gu = Math.floor(Lu / 2);
      // Low walls: along the back and down one side (homestead) or both sides (garden plot), open to the front.
      solidAt(0, 0, Lu, 2, wh, 'flat', 'garden');
      const leftSide = r() < 0.5;
      if (!homestead || leftSide) solidAt(0, 2, 2, Lv - 1, wh, 'flat', 'garden');
      if (!homestead || !leftSide) solidAt(Lu - 2, 2, Lu, Lv - 1, wh, 'flat', 'garden');
      if (homestead) {
        const s = r() < 0.3 ? 2 : 1;
        const roll = r();
        const roof: RoofKind = roll < 0.1 ? 'dome' : roll < 0.55 ? 'parapet' : 'flat';
        solidAt(2 + sm, 2, 2 + sm + hw, 2 + hd, s * STOREY, roof, 'house', roof === 'dome' ? 0.42 * Math.min(hw, hd) : 0);
        if (leftSide) bedAt(3, 2 + hd + 1, gu - 1, Lv - 1);
        else bedAt(gu + 1, 2 + hd + 1, Lu - 3, Lv - 1);
      } else {
        const mid = Math.floor(Lv / 2);
        bedAt(3, 3, Lu - 3, mid - 1);
        bedAt(3, mid + 1, Lu - 3, Lv - 2);
      }
      this.fillRect(x0, z0, x1, z1, SOFT, true);
      placed++;
    }
  }

  // ---------------------------------------------------------------- budget and grid

  private trim() {
    const T = Math.round(this.budget() * 1.05);
    const N = this.buildings.length;
    if (N <= T) return;
    const groupPrio = new Map<number, number>();
    const groupSize = new Map<number, number>();
    this.bGroup.forEach((g, i) => {
      if (g < 0) return;
      groupPrio.set(g, this.bPrio[i]);
      groupSize.set(g, (groupSize.get(g) ?? 0) + 1);
    });
    const order = [...groupPrio.keys()].sort((a, b) => groupPrio.get(a)! - groupPrio.get(b)! || a - b);
    const drop = new Set<number>();
    let n = N;
    for (const g of order) {
      if (n <= T) break;
      drop.add(g);
      n -= groupSize.get(g)!;
    }
    const keep: Building[] = [];
    const kg: number[] = [];
    const kp: number[] = [];
    this.buildings.forEach((b, i) => {
      if (drop.has(this.bGroup[i])) {
        const x0 = b.x - b.w / 2;
        const z0 = b.z - b.d / 2;
        this.fillRect(x0, z0, x0 + b.w, z0 + b.d, FREE, false);
        return;
      }
      keep.push(b);
      kg.push(this.bGroup[i]);
      kp.push(this.bPrio[i]);
    });
    this.buildings = keep;
    this.bGroup = kg;
    this.bPrio = kp;
  }

  /** Is anything built (or planted) within rad of this segment? */
  private segServes(ax: number, az: number, bx: number, bz: number, rad: number): boolean {
    const { G, S, mask } = this;
    const l = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(l / 2));
    const rr = Math.ceil(rad);
    for (let q = 0; q <= n; q++) {
      const x = Math.floor(ax + ((bx - ax) * q) / n) + G;
      const z = Math.floor(az + ((bz - az) * q) / n) + G;
      for (let j = Math.max(0, z - rr); j <= Math.min(S - 1, z + rr); j += 2) {
        for (let i = Math.max(0, x - rr); i <= Math.min(S - 1, x + rr); i += 2) {
          const m = mask[j * S + i];
          if (m === BLOCK || m === SOFT) return true;
        }
      }
    }
    return false;
  }

  /** Drops lanes, and the tails of dead-end lanes, that lead past nothing. */
  private pruneLanes() {
    const refs = new Int32Array(this.nx.length);
    for (const s of this.streets) for (const p of new Set(s.pts)) refs[p]++;
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (let si = this.streets.length - 1; si >= 1; si--) {
        const s = this.streets[si];
        if (s.kind !== 'lane' || s.pts.length < 2) continue;
        const pts = s.pts;
        const rad = s.width / 2 + 6;
        const n = pts.length;
        const attached = s.joined === true;
        // Furthest node we must keep: one another street uses, or the end of a segment that serves a building.
        let keep = 0;
        for (let i = 1; i < n; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          if ((i < n - 1 || !attached) && refs[b] >= 2) keep = i;
          if (this.segServes(this.nx[a], this.nz[a], this.nx[b], this.nz[b], rad)) keep = i;
        }
        if (attached && keep > 0) continue; // a used through-lane stays whole
        if (keep === n - 1) continue;
        const cut = attached ? 0 : keep;
        const after = cut === 0 ? [] : pts.slice(0, cut + 1);
        const still = new Set(after);
        for (const p of new Set(pts)) if (!still.has(p)) refs[p]--;
        s.pts = after;
        changed = true;
      }
      if (!changed) break;
    }
  }

  private writeGrid(): Float32Array {
    const { G, S } = this;
    const grid = new Float32Array(S * S);
    for (const b of this.buildings) {
      if (!b.solid) continue;
      const i0 = b.x - b.w / 2 + G;
      const j0 = b.z - b.d / 2 + G;
      for (let j = j0; j < j0 + b.d; j++) {
        const row = j * S;
        for (let i = i0; i < i0 + b.w; i++) grid[row + i] = b.h;
      }
    }
    return grid;
  }

  private buildEdges() {
    const seen = new Set<string>();
    for (const s of this.streets) {
      for (let i = 0; i + 1 < s.pts.length; i++) {
        const a = s.pts[i];
        const b = s.pts[i + 1];
        if (a === b) continue;
        const key = a < b ? a + ',' + b : b + ',' + a;
        if (seen.has(key)) continue;
        seen.add(key);
        this.edgeList.push({ a, b, width: s.width });
      }
    }
    const B = 8;
    this.edgeList.forEach((e, idx) => {
      const ax = this.nx[e.a];
      const az = this.nz[e.a];
      const bx = this.nx[e.b];
      const bz = this.nz[e.b];
      const i0 = Math.floor(Math.min(ax, bx) / B);
      const i1 = Math.floor(Math.max(ax, bx) / B);
      const j0 = Math.floor(Math.min(az, bz) / B);
      const j1 = Math.floor(Math.max(az, bz) / B);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const key = (j + 4096) * 8192 + (i + 4096);
          let l = this.ehash.get(key);
          if (!l) this.ehash.set(key, (l = []));
          l.push(idx);
        }
      }
    });
  }

  /** Distance to the nearest street centre line (capped at 8). */
  private edgeDist(x: number, z: number): number {
    const B = 8;
    const bi = Math.floor(x / B);
    const bj = Math.floor(z / B);
    let best = 64;
    for (let j = bj - 1; j <= bj + 1; j++) {
      for (let i = bi - 1; i <= bi + 1; i++) {
        const l = this.ehash.get((j + 4096) * 8192 + (i + 4096));
        if (!l) continue;
        for (const idx of l) {
          const e = this.edgeList[idx];
          const d2 = segDist2(x, z, this.nx[e.a], this.nz[e.a], this.nx[e.b], this.nz[e.b]);
          if (d2 < best) best = d2;
        }
      }
    }
    return Math.sqrt(best);
  }

  // ---------------------------------------------------------------- spots and lamps

  private inRect(rc: Rect, x: number, z: number) {
    return x >= rc.x0 && x <= rc.x1 && z >= rc.z0 && z <= rc.z1;
  }

  private addSpot(grid: Float32Array, s: Spot): boolean {
    const k = this.cell(s.x, s.z);
    if (k < 0 || grid[k] !== 0 || this.mask[k] === POOL) return false;
    const inSq = Math.hypot(s.x - this.sq.x, s.z - this.sq.z) < this.sq.r;
    const reach = inSq || this.markets.some((m) => this.inRect(m, s.x, s.z)) || this.edgeDist(s.x, s.z) <= 5.9;
    if (!reach) return false;
    for (const o of this.spots) if (Math.abs(o.x - s.x) < 1.2 && Math.abs(o.z - s.z) < 1.2) return false;
    this.spots.push(s);
    return true;
  }

  private makeSpots(grid: Float32Array) {
    const r = this.rng(14);
    const sq = this.sq;
    const target = Math.max(40, Math.round(this.buildings.length / 4));
    const spot = (x: number, z: number, kind: SpotKind, facing: number, capacity: number) =>
      this.addSpot(grid, { x, z, kind, facing, capacity });
    // Wells.
    if (this.pool) {
      for (let t = 0; t < 12; t++) {
        const a = r() * TAU;
        const x = sq.x + Math.cos(a) * (this.pool.r + 2.2);
        const z = sq.z + Math.sin(a) * (this.pool.r + 2.2);
        if (spot(x, z, 'well', faceOf(sq.x - x, sq.z - z), 4)) break;
      }
    } else spot(sq.x + 0.5, sq.z + 0.5, 'well', 0, 5);
    // Gathering in the square.
    const ng = 4 + Math.round(sq.r / 10);
    for (let i = 0, t = 0; i < ng && t < ng * 6; t++) {
      const a = r() * TAU;
      const rad = this.pool ? this.pool.r + 2 + r() * (sq.r - this.pool.r - 3.5) : sq.r * (0.3 + 0.45 * r());
      const x = sq.x + Math.cos(a) * rad;
      const z = sq.z + Math.sin(a) * rad;
      if (spot(x, z, 'gather', faceOf(sq.x - x, sq.z - z), 6 + Math.floor(r() * 7))) i++;
    }
    // Stalls and trading round the edge of the square.
    const ns = this.kind === 'trade' ? 10 : 3;
    for (let i = 0; i < ns; i++) {
      const a = (TAU * (i + r() * 0.5)) / ns;
      const x = sq.x + Math.cos(a) * (sq.r - 2.5);
      const z = sq.z + Math.sin(a) * (sq.r - 2.5);
      spot(x, z, i % 3 === 2 ? 'market' : 'stall', faceOf(sq.x - x, sq.z - z), i % 3 === 2 ? 5 : 2);
    }
    for (const s of this.pendSpots) this.addSpot(grid, s);
    // Pocket squares, the second well in one of them (or in the water garden).
    let well2 = this.pool !== null || this.gardens.length > 0;
    if (this.gardens.length > 0 && !this.pool) {
      const g = this.gardens[0];
      const cx = (g.x0 + g.x1) / 2;
      const cz = (g.z0 + g.z1) / 2;
      const P = 2 * Math.round((g.x1 - g.x0) * 0.15);
      well2 = spot(cx + P / 2 + 1.5, cz, 'well', faceOf(-1, 0), 4);
    }
    for (const p of this.pockets) {
      if (!well2 && spot(p.x + 1.2, p.z + 1.2, 'well', 0, 4)) {
        well2 = true;
        continue;
      }
      const a = r() * TAU;
      spot(p.x + Math.cos(a) * 1.5, p.z + Math.sin(a) * 1.5, 'gather', faceOf(-Math.cos(a), -Math.sin(a)), 4 + Math.floor(r() * 5));
    }
    // Benches along the avenues and gate spots where they leave the town.
    for (const a of this.aves) {
      const s = this.streets[a];
      let acc = 0;
      let side = 1;
      for (let i = 0; i + 1 < s.pts.length; i++) {
        const ax = this.nx[s.pts[i]];
        const az = this.nz[s.pts[i]];
        const bx = this.nx[s.pts[i + 1]];
        const bz = this.nz[s.pts[i + 1]];
        const l = Math.hypot(bx - ax, bz - az);
        acc += l;
        if (acc < 45 || l < 1) continue;
        if (Math.hypot(bx - sq.x, bz - sq.z) < sq.r + 12) continue;
        acc = 0;
        const tx = (bx - ax) / l;
        const tz = (bz - az) / l;
        const off = s.width / 2 - 1.2;
        const x = (ax + bx) / 2 - tz * side * off;
        const z = (az + bz) / 2 + tx * side * off;
        spot(x, z, 'bench', faceOf(tz * side, -tx * side), 3);
        side = -side;
      }
      if (this.kind !== 'hill') {
        const n = s.pts.length;
        const ex = this.nx[s.pts[n - 1]];
        const ez = this.nz[s.pts[n - 1]];
        const px = this.nx[s.pts[n - 2]];
        const pz = this.nz[s.pts[n - 2]];
        const l = Math.hypot(ex - px, ez - pz) || 1;
        const tx = (ex - px) / l;
        const tz = (ez - pz) / l;
        spot(ex - tx * 3 - tz * 3, ez - tz * 3 + tx * 3, 'gate', faceOf(tx, tz), 4);
      }
    }
    // Shade on the north and east sides of buildings (world north is -z, east is +x).
    const c = Math.cos(this.site.rot);
    const sn = Math.sin(this.site.rot);
    const north = { x: -sn, z: -c };
    const east = { x: c, z: -sn };
    const cands: Spot[] = [];
    for (const b of this.buildings) {
      if (!b.solid || b.h < STOREY || (b.role !== 'house' && b.role !== 'hall' && b.role !== 'landmark')) continue;
      for (const [fx, fz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (Math.max(fx * north.x + fz * north.z, fx * east.x + fz * east.z) < 0.55) continue;
        const len = fx !== 0 ? b.d : b.w;
        const t = (r() - 0.5) * Math.max(0, len - 2);
        const x = b.x + fx * (b.w / 2 + 1) + (fx === 0 ? t : 0);
        const z = b.z + fz * (b.d / 2 + 1) + (fz === 0 ? t : 0);
        cands.push({ x, z, kind: 'shade', facing: faceOf(fx, fz), capacity: 2 + Math.floor(r() * 2) });
      }
    }
    for (let i = cands.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [cands[i], cands[j]] = [cands[j], cands[i]];
    }
    for (const s of cands) {
      if (this.spots.length >= target) break;
      this.addSpot(grid, s);
    }
    // Still short: benches along the lanes.
    for (let si = 1; si < this.streets.length && this.spots.length < target; si++) {
      const s = this.streets[si];
      if (s.kind !== 'lane' || s.pts.length < 2) continue;
      const a = s.pts[0];
      const b = s.pts[1];
      const l = Math.hypot(this.nx[b] - this.nx[a], this.nz[b] - this.nz[a]) || 1;
      const tx = (this.nx[b] - this.nx[a]) / l;
      const tz = (this.nz[b] - this.nz[a]) / l;
      const x = (this.nx[a] + this.nx[b]) / 2 - tz * 0.8;
      const z = (this.nz[a] + this.nz[b]) / 2 + tx * 0.8;
      spot(x, z, 'bench', faceOf(tz, -tx), 2);
    }
  }

  private addLamp(grid: Float32Array, x: number, y: number, z: number): boolean {
    const k = this.cell(x, z);
    if (k < 0 || grid[k] !== 0 || this.mask[k] === POOL) return false;
    for (const o of this.lamps) if (Math.abs(o.x - x) < 3 && Math.abs(o.z - z) < 3) return false;
    this.lamps.push({ x, y, z });
    return true;
  }

  private makeLamps(grid: Float32Array) {
    const sq = this.sq;
    const sp = 18 + 4 * clamp((this.R - 320) / 280, 0, 1);
    const aveLamps: number[] = [];
    for (const a of this.aves) {
      const s = this.streets[a];
      let acc = sp / 2;
      let side = 1;
      for (let i = 0; i + 1 < s.pts.length; i++) {
        const ax = this.nx[s.pts[i]];
        const az = this.nz[s.pts[i]];
        const bx = this.nx[s.pts[i + 1]];
        const bz = this.nz[s.pts[i + 1]];
        const l = Math.hypot(bx - ax, bz - az);
        if (l < 1e-6) continue;
        const tx = (bx - ax) / l;
        const tz = (bz - az) / l;
        let t = acc;
        while (t < l) {
          const x0 = ax + tx * t;
          const z0 = az + tz * t;
          t += sp;
          if (Math.hypot(x0 - sq.x, z0 - sq.z) < sq.r + 3) continue;
          if (this.gates.some((g) => Math.hypot(g.x - x0, g.z - z0) < 10)) continue;
          const off = s.width / 2 - 0.8;
          if (this.addLamp(grid, x0 - tz * side * off, 3.2, z0 + tx * side * off)) aveLamps.push(this.lamps.length - 1);
          side = -side;
        }
        acc = t - l;
      }
    }
    // Round the square, skipping the mouths of the avenues.
    const n = Math.round((TAU * sq.r) / 12);
    for (let i = 0; i < n; i++) {
      const a = (TAU * i) / n;
      const x = sq.x + Math.cos(a) * (sq.r - 1.2);
      const z = sq.z + Math.sin(a) * (sq.r - 1.2);
      let onAve = false;
      for (const av of this.aves) {
        const s = this.streets[av];
        for (let q = 0; q + 1 < Math.min(4, s.pts.length); q++) {
          const d2 = segDist2(x, z, this.nx[s.pts[q]], this.nz[s.pts[q]], this.nx[s.pts[q + 1]], this.nz[s.pts[q + 1]]);
          if (d2 < (s.width / 2 + 0.5) ** 2) onAve = true;
        }
      }
      if (!onAve) this.addLamp(grid, x, 3.2, z);
    }
    for (const l of this.pendLamps) this.addLamp(grid, l.x, l.y, l.z);
    for (const p of this.pockets) this.addLamp(grid, p.x + p.r * 0.6, 3.2, p.z);
    if (this.kind !== 'hill') {
      for (const a of this.aves) {
        const s = this.streets[a];
        const m = s.pts.length;
        const ex = this.nx[s.pts[m - 1]];
        const ez = this.nz[s.pts[m - 1]];
        const px = this.nx[s.pts[m - 2]];
        const pz = this.nz[s.pts[m - 2]];
        const l = Math.hypot(ex - px, ez - pz) || 1;
        const off = s.width / 2 - 0.8;
        for (const side of [-1, 1]) this.addLamp(grid, ex - ((ez - pz) / l) * side * off, 3.2, ez + ((ex - px) / l) * side * off);
      }
    }
    // Too few: light the busier lane junctions.
    if (this.lamps.length < 80) {
      const deg = new Int32Array(this.nx.length);
      for (const e of this.edgeList) {
        deg[e.a]++;
        deg[e.b]++;
      }
      for (let i = 0; i < this.nx.length && this.lamps.length < 80; i++) {
        if (deg[i] >= 3) this.addLamp(grid, this.nx[i] + 0.8, 3.2, this.nz[i] + 0.8);
      }
    }
    // Too many: thin the avenue lamps.
    if (this.lamps.length > 250) {
      const extra = this.lamps.length - 250;
      const drop = new Set<number>();
      const step = aveLamps.length / extra;
      for (let i = 0; i < extra && i * step < aveLamps.length; i++) drop.add(aveLamps[Math.floor(i * step)]);
      this.lamps = this.lamps.filter((_, i) => !drop.has(i));
    }
  }
}
