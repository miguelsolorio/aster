// The lived-in places out on the open desert: what each is built of and who stands where.
// Where they stand is settle.ts's business; this file is handed a site's frame and builds in it.
// The frame's +u is the way the place faces (see each builder), +v is to its side, and heights
// are relative to the site's base. The discoveries lend their own kit of mud-brick pieces, so a
// house here is the same house as in a hamlet.
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadModel, modelGeometry } from '../render/art';
import type { SettlementKind } from './settlementKinds';
import type { FolkMark, FolkRole } from './villagers';

type RGB = [number, number, number];

/** What a builder needs of the discoveries' site context. */
export interface SiteCtx {
  readonly stone: { r: number; g: number; b: number; k: number; rough: number; set(r: number, g: number, b: number, k: number, rough: number): void };
  readonly pools: { y: number; r: number; u?: number; v?: number; under?: boolean }[];
  folk: FolkMark[] | null;
  solid: boolean;
  /** While set, prim() still adds its solid (and draws its random numbers) but draws nothing: a modelled piece stands in for it. */
  ghost: boolean;
  foot: number;
  lx: number;
  lz: number;
  readonly rng: () => number;
  r(a: number, b: number): number;
  at(u: number, v: number): void;
  g(u: number, v: number): number;
  prim(geo: THREE.BufferGeometry, u: number, y: number, v: number, sx: number, sy: number, sz: number, ry?: number, rx?: number, rz?: number): void;
  glow(u: number, y: number, v: number, size: number): void;
}

export interface SiteHouse {
  floor: number;
  top: number;
  at: (lx: number, lz: number) => [number, number];
}

/** The discoveries' own pieces, lent to the builders here. */
export interface Kit {
  BOX: THREE.BufferGeometry;
  CYL: THREE.BufferGeometry;
  SLAB: THREE.BufferGeometry;
  BLOB: THREE.BufferGeometry;
  CONE: THREE.BufferGeometry;
  BIT: THREE.BufferGeometry;
  PEBBLE: THREE.BufferGeometry;
  house(c: SiteCtx, hu: number, hv: number, ang: number, face: number, w: number, d: number, wallH: number, wt: number): SiteHouse;
  well(c: SiteCtx, u: number, v: number): void;
  tower(c: SiteCtx, u: number, v: number, ang: number, H: number, wt: number): void;
  torch(c: SiteCtx, u: number, v: number, tall?: number): void;
  bunting(c: SiteCtx, u0: number, v0: number, u1: number, v1: number, high: number): void;
  cart(c: SiteCtx, u: number, v: number, ang: number): void;
  palm(c: SiteCtx, u: number, v: number, la: number): void;
  hay(c: SiteCtx, u: number, v: number, s: number): void;
  merlons(c: SiteCtx, u: number, v: number, y: number, w: number, d: number, Tx: number, Tz: number): void;
}

const TAU = Math.PI * 2;

// Cloth and dye, as tints of the pale palette.
const MADDER: RGB = [1.18, 0.4, 0.3];
const INDIGO: RGB = [0.3, 0.44, 0.78];
const SAFFRON: RGB = [1.3, 0.86, 0.25];
const TEAL: RGB = [0.3, 0.85, 0.8];
const UNDYED: RGB = [1.15, 1.1, 1.0];
const MAGENTA: RGB = [1.25, 0.28, 0.7];
const VIOLET: RGB = [0.7, 0.32, 0.9];
const VERMILION: RGB = [1.3, 0.42, 0.22];
const CRIMSON: RGB = [1.05, 0.16, 0.16];
const GOLD: RGB = [1.4, 1.02, 0.3];
const BRASS: RGB = [1.25, 0.9, 0.38];
const DYES: RGB[] = [MAGENTA, SAFFRON, INDIGO, TEAL, VERMILION, VIOLET];
const CLOTHS: RGB[] = [MADDER, INDIGO, SAFFRON, TEAL, UNDYED];

// What people wear, as the figures take it (plain colour).
const WHITE: RGB = [0.94, 0.91, 0.84];
const LINEN: RGB = [0.86, 0.81, 0.69];
const STRAW: RGB = [0.76, 0.62, 0.34];
const RUST: RGB = [0.62, 0.33, 0.16];
const SAND_COAT: RGB = [0.74, 0.58, 0.36];

// ------------------------------------------------------------------ the modelled pieces
//
// tools/blender/settlements.py writes public/art/settlements.glb: the tents, huts, wind towers,
// awnings, kilns, wells and fires drawn properly. Until it has loaded (and for good without it)
// everything below is built of the plain boxes it always was. Once it has, each builder still
// lays its piece out as before, draws the same random numbers and adds the same solids, but with
// c.ghost set, so the boxes are not drawn; the modelled piece is drawn in their place. Nothing
// moves and nothing you walk into changes. Settlements built before the file arrived are built
// again once (discoveries.ts watchSettlementModels).

/** What each vertex of a modelled piece is (its _part), and so how it is coloured. */
const PART = {
  MUD: 0,
  MUD_L: 1,
  FOOT: 2,
  WOOD: 3,
  WOOD_D: 4,
  DARK: 5,
  CLOTH: 6,
  CLOTH_B: 7,
  FLAME: 8,
  STONE: 9,
  ROPE: 10,
  HAIR: 11,
  HAIR_P: 12,
  HAIR_W: 13,
  SOOT: 14,
  BUCKET: 15,
} as const;

/** A modelled piece: its triangles (three corners each, x y z), split by part. */
type Piece = { part: number; pos: Float32Array }[];

const PIECES = ['TentA', 'TentB', 'TentC', 'HutBody0', 'HutBody1', 'HutBody2', 'HutRoom', 'HutDoor', 'HutWindow', 'HutBeam', 'WindTower0', 'WindTower1', 'Awning0', 'Awning1', 'Kiln0', 'Kiln1', 'Well0', 'Well1', 'Fire0', 'Fire1'] as const;
type PieceName = (typeof PIECES)[number];

let MODELS: Map<PieceName, Piece> | null = null;
let modelLoad: Promise<boolean> | null = null;

/** Takes the pieces out of a loaded settlements.glb; false (and nothing changes) if any is missing. */
export function useSettlementModels(gltf: GLTF): boolean {
  const out = new Map<PieceName, Piece>();
  for (const name of PIECES) {
    const g = modelGeometry(gltf, name);
    const part = g?.getAttribute('_part');
    if (!g || !part) return false;
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    const n = idx ? idx.count : pos.count;
    const by = new Map<number, number[]>();
    for (let t = 0; t < n; t += 3) {
      const corner = (i: number): number => (idx ? idx.getX(t + i) : t + i);
      const p = Math.round(part.getX(corner(0)));
      let list = by.get(p);
      if (!list) {
        list = [];
        by.set(p, list);
      }
      for (let i = 0; i < 3; i++) {
        const v = corner(i);
        list.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      }
    }
    out.set(
      name,
      [...by].map(([p, list]) => ({ part: p, pos: Float32Array.from(list) })),
    );
  }
  MODELS = out;
  return true;
}

/** Starts loading settlements.glb (once); resolves true when the pieces are in use. */
export function loadSettlementModels(): Promise<boolean> {
  modelLoad ??= loadModel('settlements.glb').then((gltf) => (gltf ? useSettlementModels(gltf) : false));
  return modelLoad;
}

/** Whether the modelled pieces are in use. */
export function settlementModelsReady(): boolean {
  return MODELS !== null;
}

/** Back to the plain boxes (tests). */
export function dropSettlementModels(): void {
  MODELS = null;
}

/**
 * How a piece is stretched to the size it is built at, a coordinate at a time: the middle of
 * the reference size stretches, the margins keep their shape and only move. For x and z,
 * [half the reference size, margin, half the size wanted]; for y, [reference top, how much of
 * the top keeps its shape, top wanted, and what y < 0 (the footing) is scaled by].
 */
interface Stretch {
  x?: [number, number, number];
  z?: [number, number, number];
  y?: [number, number, number, number];
}

const across = (s: number, h0: number, m: number, h1: number): number => {
  if (h1 <= m + 0.05) return (s * h1) / h0;
  const a = Math.abs(s);
  return a <= h0 - m ? (s * (h1 - m)) / (h0 - m) : s + Math.sign(s) * (h1 - h0);
};

const upward = (y: number, t0: number, keep: number, t1: number, foot: number): number => {
  if (y < 0) return y * foot;
  return y <= t0 - keep ? (y * Math.max(t1 - keep, 0.05)) / (t0 - keep) : y + (t1 - t0);
};

function stretched(src: Float32Array, st: Stretch): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = st.x ? across(src[i], st.x[0], st.x[1], st.x[2]) : src[i];
    out[i + 1] = st.y ? upward(src[i + 1], st.y[0], st.y[1], st.y[2], st.y[3]) : src[i + 1];
    out[i + 2] = st.z ? across(src[i + 2], st.z[0], st.z[1], st.z[2]) : src[i + 2];
  }
  return out;
}

const SCRATCH = new THREE.BufferGeometry();

/** How a piece's parts are coloured: sets c.stone for the part, or returns false to leave it out. */
type Paint = (c: SiteCtx, part: number) => boolean;

/**
 * Draws a modelled piece with its origin at frame (u, y, v), its x along bearing `ang`, scaled by
 * (sx, sy, sz) after any stretch. It adds no solids, draws no random numbers, and leaves the
 * stone material as it found it.
 */
function piece(c: SiteCtx, name: PieceName, u: number, y: number, v: number, ang: number, paint: Paint, st?: Stretch, sx = 1, sy = 1, sz = 1): void {
  const m = MODELS?.get(name);
  if (!m) return;
  const s = c.stone;
  const keep = [s.r, s.g, s.b, s.k, s.rough] as const;
  const solid = c.solid;
  const ghost = c.ghost;
  c.solid = false;
  c.ghost = false;
  for (const p of m) {
    if (paint(c, p.part) === false) continue;
    SCRATCH.setAttribute('position', new THREE.BufferAttribute(st ? stretched(p.pos, st) : p.pos, 3));
    c.prim(SCRATCH, u, y, v, sx, sy, sz, -ang);
  }
  SCRATCH.deleteAttribute('position');
  c.solid = solid;
  c.ghost = ghost;
  s.set(keep[0], keep[1], keep[2], keep[3], keep[4]);
}

/** One of n variants for a piece standing at (u, v), without drawing a random number. */
const variant = (u: number, v: number, n: number): number => {
  const h = Math.sin(u * 12.9898 + v * 78.233) * 43758.5453;
  return Math.floor((h - Math.floor(h)) * n) % n;
};

/** Runs `draw` with c.ghost set when the modelled pieces are in use (and returns whether they are). */
function ghosted(c: SiteCtx, draw: () => void): boolean {
  if (!MODELS) {
    draw();
    return false;
  }
  const keep = c.ghost;
  c.ghost = true;
  draw();
  c.ghost = keep;
  return true;
}

const mud = (c: SiteCtx, wt: number): void => c.stone.set(wt, wt * 0.96, wt * 0.87, 2, 0.06);
const footing = (c: SiteCtx, wt: number): void => c.stone.set(wt * 0.86, wt * 0.82, wt * 0.74, 2, 0.08);
const wood = (c: SiteCtx, k = 1): void => c.stone.set(0.46 * k, 0.33 * k, 0.23 * k, 2, 0.02);
const dark = (c: SiteCtx): void => c.stone.set(0.16, 0.12, 0.1, 2, 0);
const cloth = (c: SiteCtx, t: RGB, k = 1): void => c.stone.set(t[0] * k, t[1] * k, t[2] * k, 1, 0.02);
const flame = (c: SiteCtx): void => c.stone.set(1, 1, 1, 3, 0);
const pickOf = <T>(c: SiteCtx, list: T[]): T => list[Math.floor(c.rng() * list.length) % list.length];

/** The colours of a modelled piece's parts: its mud (by weathering `wt`), its cloth, its stone. */
function tones(o: { wt?: number; tint?: RGB; stone?: [number, number, number, number]; rough?: number; skip?: number }): Paint {
  const wt = o.wt ?? 1;
  const rough = o.rough ?? 0.03;
  const tint = o.tint ?? UNDYED;
  return (c, p) => {
    if (p === o.skip) return false;
    switch (p) {
      case PART.MUD: c.stone.set(wt, wt * 0.96, wt * 0.87, 2, rough); break;
      case PART.MUD_L: c.stone.set(wt * 1.04, wt * 1.04 * 0.96, wt * 1.04 * 0.87, 2, rough); break;
      case PART.FOOT: c.stone.set(wt * 0.86, wt * 0.82, wt * 0.74, 2, rough); break;
      case PART.WOOD: wood(c); break;
      case PART.WOOD_D: wood(c, 0.85); break;
      case PART.DARK: dark(c); break;
      case PART.CLOTH: cloth(c, tint); break;
      case PART.CLOTH_B: cloth(c, tint, 0.78); break;
      case PART.FLAME: flame(c); break;
      case PART.STONE: {
        const s = o.stone ?? [1.0, 0.97, 0.9, 0.04];
        c.stone.set(s[0], s[1], s[2], 0, s[3]);
        break;
      }
      case PART.ROPE: c.stone.set(0.78, 0.66, 0.48, 2, 0); break;
      case PART.HAIR: c.stone.set(0.2, 0.16, 0.14, 2, 0.02); break;
      case PART.HAIR_P: c.stone.set(0.62, 0.5, 0.36, 2, 0.01); break;
      case PART.HAIR_W: c.stone.set(0.18, 0.145, 0.13, 2, 0.02); break;
      case PART.SOOT: c.stone.set(0.3, 0.26, 0.24, 2, 0.02); break;
      case PART.BUCKET: wood(c, 1.2); break;
      default: return false;
    }
    return true;
  };
}

/** A well: the discoveries' own (its ring of stones is what you walk into), drawn as the modelled one when there is one. */
function well(c: SiteCtx, k: Kit, u: number, v: number): void {
  if (ghosted(c, () => k.well(c, u, v))) piece(c, variant(u, v, 2) ? 'Well1' : 'Well0', u, c.g(u, v), v, 0, tones({ stone: [1.0, 0.97, 0.9, 0.04] }));
}

/** Something slight that nobody walks into. `ang` is the bearing its long (x) side runs along. */
function bit(c: SiteCtx, k: Kit, u: number, y: number, v: number, sx: number, sy: number, sz: number, ang = 0, rx = 0, rz = 0): void {
  const keep = c.solid;
  c.solid = false;
  c.prim(k.BIT, u, y, v, sx, sy, sz, -ang, rx, rz);
  c.solid = keep;
}

/** Someone's place: where they stand (frame), a point they face, and what they are. */
function person(c: SiteCtx, u: number, v: number, fu: number, fv: number, coat: RGB, o: { role?: FolkRole; sit?: boolean; small?: boolean; y?: number } = {}): void {
  c.at(u, v);
  const pu = c.lx;
  const pv = c.lz;
  c.at(fu, fv);
  c.folk ??= [];
  c.folk.push({ u: pu, v: pv, fu: c.lx, fv: c.lz, sit: o.sit === true, role: o.role ?? 'villager', small: o.small === true, coat, y: o.y });
}

/**
 * A plain mud-brick house for the bigger places: a block, a parapet lip, a door and a window or
 * two, and now and then a dome or an upper room. With y0 it stands on a deck or a terrace at
 * that height instead of the ground.
 */
function hut(c: SiteCtx, k: Kit, u: number, v: number, ang: number, face: number, w: number, d: number, h: number, wt: number, y0?: number): SiteHouse {
  const Tx = Math.cos(ang);
  const Tz = Math.sin(ang);
  const at = (lx: number, lz: number): [number, number] => [u + Tx * lx - Tz * lz, v + Tz * lx + Tx * lz];
  let floor = 0;
  let lo = 0;
  if (y0 !== undefined) {
    floor = y0;
    lo = y0 - 0.4;
  } else {
    let hi = -Infinity;
    lo = Infinity;
    for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]] as const) {
      const gh = c.g(...at(lx, lz));
      lo = Math.min(lo, gh);
      hi = Math.max(hi, gh);
    }
    floor = Math.max(c.g(...at(0, face * (d / 2 + 0.8))) + 0.15, hi - 1.6);
    lo -= 1;
  }
  // (with the modelled pieces in use, the boxes below are ghosts: their solids stay, the model is drawn)
  const modelled = MODELS !== null;
  const keepGhost = c.ghost;
  c.ghost = modelled;
  mud(c, wt);
  c.prim(k.BOX, u, (lo + floor + h) / 2, v, w, floor + h - lo, d, -ang);
  mud(c, wt * 1.03);
  bit(c, k, u, floor + h + 0.1, v, w + 0.4, 0.45, d + 0.4, ang);
  const top = floor + h + 0.32;
  const doorX = c.r(-w * 0.2, w * 0.2);
  dark(c);
  bit(c, k, ...lift(at(doorX, face * (d / 2 + 0.02)), floor + 0.95), 1.1, 1.9, 0.3, ang);
  wood(c);
  bit(c, k, ...lift(at(doorX, face * (d / 2 + 0.1)), floor + 2.0), 1.6, 0.22, 0.26, ang);
  for (let i = 0; i < 3; i++) bit(c, k, ...lift(at(-w / 2 + 0.6 + (i * (w - 1.2)) / 2, face * (d / 2 + 0.2)), floor + h - 0.45), 0.18, 0.18, 0.5, ang);
  const windows: [number, number][] = [];
  for (const s of [-1, 1]) {
    const wx = doorX + s * Math.max(1.5, w * 0.3);
    if (Math.abs(wx) > w / 2 - 0.5) continue;
    for (const wy of h > 4.4 ? [1.7, h - 1.3] : [1.7]) {
      const p = at(wx, face * (d / 2 + 0.02));
      dark(c);
      bit(c, k, p[0], floor + wy, p[1], 0.5, 0.8, 0.26, ang);
      windows.push([wx, wy]);
      if (c.rng() < 0.5) c.glow(p[0], floor + wy, p[1], 1.0);
    }
  }
  c.ghost = keepGhost;
  if (modelled) {
    // the body stretched to the house's size, its footing down to the house's foot
    const fa = face > 0 ? ang : ang + Math.PI;
    piece(c, `HutBody${variant(u, v, 3)}` as PieceName, u, floor, v, fa, tones({ wt }), { x: [3, 1.2, w / 2], z: [2.5, 1.2, d / 2], y: [3.2, 0.9, h, floor - lo] });
    const dress = tones({ wt: wt * 1.02, rough: 0 });
    const door = at(doorX, face * (d / 2));
    piece(c, 'HutDoor', door[0], floor, door[1], fa, dress);
    for (const [wx, wy] of windows) {
      const p = at(wx, face * (d / 2 + 0.03));
      piece(c, 'HutWindow', p[0], floor + wy, p[1], fa, dress);
    }
    // the ends of the roof beams, where the boxes had them
    for (let i = 0; i < 3; i++) {
      const p = at(-w / 2 + 0.6 + (i * (w - 1.2)) / 2, face * (d / 2));
      piece(c, 'HutBeam', p[0], floor + h - 0.45, p[1], fa, dress);
    }
  }
  const style = c.rng();
  if (style < 0.18) {
    const rd = Math.min(w, d) * 0.38;
    mud(c, wt * 1.04);
    c.prim(k.BLOB, u, top - 0.25, v, rd, rd * 0.8, rd, c.rng() * 6);
  } else if (style < 0.42) {
    const p = at((c.rng() < 0.5 ? -1 : 1) * w * 0.18, -face * d * 0.15);
    c.ghost = modelled;
    mud(c, wt * 1.02);
    c.prim(k.BOX, p[0], top + 0.9, p[1], w * 0.55, 2.4, d * 0.6, -ang);
    bit(c, k, p[0], top + 2.15, p[1], w * 0.55 + 0.35, 0.4, d * 0.6 + 0.35, ang);
    c.ghost = keepGhost;
    if (modelled) piece(c, 'HutRoom', p[0], top - 0.3, p[1], face > 0 ? ang : ang + Math.PI, tones({ wt: wt * 1.02 }), { x: [3, 1.2, w * 0.275], z: [2.5, 1.2, d * 0.3], y: [3.2, 0.9, 2.4, 0] });
  } else if (style < 0.56) {
    const p = at(doorX, face * (d / 2 + 0.9));
    cloth(c, pickOf(c, CLOTHS));
    bit(c, k, p[0], floor + 2.4, p[1], 2.4, 0.07, 1.7, ang, face * 0.22);
  }
  return { floor, top, at };
}

const lift = (p: [number, number], y: number): [number, number, number] => [p[0], y, p[1]];

/** A wind tower: a tall shaft with slots near its top on every face, to catch whatever wind there is. */
function windTower(c: SiteCtx, k: Kit, u: number, v: number, ang: number, H: number, wt: number, y0?: number): void {
  const g = y0 ?? c.g(u, v);
  const modelled = ghosted(c, () => {
    mud(c, wt * 0.98);
    c.prim(k.BOX, u, g + H / 2 - 0.5, v, 2.3, H + 1, 2.3, -ang);
    for (let f = 0; f < 4; f++) {
      const a = ang + (f * Math.PI) / 2;
      dark(c);
      for (const s of [-0.62, 0, 0.62]) bit(c, k, u + Math.cos(a) * 1.16 - Math.sin(a) * s, g + H - 1.9, v + Math.sin(a) * 1.16 + Math.cos(a) * s, 0.14, 2.3, 0.36, a);
    }
    mud(c, wt * 1.05);
    bit(c, k, u, g + H + 0.62, v, 2.8, 0.3, 2.8, ang);
    wood(c);
    bit(c, k, u, g + H - 3.5, v, 3.5, 0.14, 0.14, ang);
    bit(c, k, u, g + H - 3.8, v, 0.14, 0.14, 3.5, ang);
  });
  // the shaft stretched to the tower's height, the catchers on top as they are
  if (modelled) piece(c, variant(u, v, 2) ? 'WindTower1' : 'WindTower0', u, g, v, ang, tones({ wt: wt * 0.98 }), { y: [10, 4, H, 1] });
}

/** A shade of dyed cloth on four poles, with whatever is sold or kept under it. */
function awning(c: SiteCtx, k: Kit, u: number, v: number, ang: number, w: number, d: number, tint: RGB, goods = true): void {
  const Tx = Math.cos(ang);
  const Tz = Math.sin(ang);
  const g = c.g(u, v);
  const modelled = ghosted(c, () => {
    wood(c);
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const pu = u + (Tx * a * w) / 2 - (Tz * b * d) / 2;
      const pv = v + (Tz * a * w) / 2 + (Tx * b * d) / 2;
      bit(c, k, pu, c.g(pu, pv) + 1.25, pv, 0.1, 2.5, 0.1, ang);
    }
    cloth(c, tint);
    bit(c, k, u, g + 2.5, v, w + 0.5, 0.07, d + 0.5, ang, 0.1);
  });
  if (modelled) piece(c, variant(u, v, 2) ? 'Awning1' : 'Awning0', u, g, v, ang, tones({ tint, rough: 0 }), undefined, w / 4.4, 1, d / 3.2);
  if (!goods) return;
  wood(c, 1.15);
  c.prim(k.BOX, u, g + 0.45, v, w * 0.7, 0.9, d * 0.45, -ang);
  const keep = c.solid;
  c.solid = false;
  for (let i = 0; i < 4; i++) {
    const t = -w * 0.28 + (i / 3) * w * 0.56;
    if (i % 2) c.stone.set(0.92, 0.56, 0.38, 2, 0.03);
    else cloth(c, pickOf(c, DYES));
    c.prim(k.PEBBLE, u + Tx * t, g + 1.1, v + Tz * t, 0.3, 0.34, 0.3, c.rng() * 6);
  }
  c.solid = keep;
}

/** A ladder from one point to another. */
function ladder(c: SiteCtx, k: Kit, u0: number, y0: number, v0: number, u1: number, y1: number, v1: number): void {
  const run = Math.hypot(u1 - u0, v1 - v0);
  const ang = Math.atan2(v1 - v0, u1 - u0);
  const L = Math.hypot(run, y1 - y0);
  const pitch = Math.atan2(y1 - y0, run);
  wood(c, 1.1);
  for (const s of [-0.3, 0.3]) bit(c, k, (u0 + u1) / 2 - Math.sin(ang) * s, (y0 + y1) / 2, (v0 + v1) / 2 + Math.cos(ang) * s, L, 0.09, 0.09, ang, 0, pitch);
  for (let t = 0.4; t < L - 0.2; t += 0.45) {
    const f = t / L;
    bit(c, k, u0 + (u1 - u0) * f, y0 + (y1 - y0) * f, v0 + (v1 - v0) * f, 0.06, 0.06, 0.66, ang);
  }
}

/** Dyed cloth hung to dry on a line between two points, sagging in the middle. */
function clothLine(c: SiteCtx, k: Kit, u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, tints: RGB[], long = 1): void {
  const len = Math.hypot(u1 - u0, v1 - v0);
  const ang = Math.atan2(v1 - v0, u1 - u0);
  wood(c);
  bit(c, k, u0, y0 + 0.8, v0, 0.1, 1.6, 0.1);
  bit(c, k, u1, y1 + 0.8, v1, 0.1, 1.6, 0.1);
  const n = Math.max(3, Math.floor(len / 1.15));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const y = y0 + 1.55 + (y1 - y0) * t - len * 0.05 * 4 * t * (1 - t);
    const drop = c.r(1.1, 2.3) * long;
    cloth(c, pickOf(c, tints), c.r(0.9, 1.08));
    bit(c, k, u0 + (u1 - u0) * t, y - drop / 2, v0 + (v1 - v0) * t, 0.9, drop, 0.05, ang);
  }
}

/** A pole with a long pennant, to be seen from a way off. */
function pennant(c: SiteCtx, k: Kit, u: number, y: number, v: number, h: number, tint: RGB, ang = 0): void {
  wood(c);
  bit(c, k, u, y + h / 2, v, 0.1, h, 0.1);
  cloth(c, tint);
  bit(c, k, u + Math.cos(ang) * 0.8, y + h - 0.35, v + Math.sin(ang) * 0.8, 1.5, 0.6, 0.05, ang);
  bit(c, k, u + Math.cos(ang) * 1.8, y + h - 0.3, v + Math.sin(ang) * 1.8, 0.6, 0.34, 0.05, ang);
}

/** A ring of fire stones with a flame in it. */
function fire(c: SiteCtx, k: Kit, u: number, v: number, size = 1): void {
  const g = c.g(u, v);
  const modelled = ghosted(c, () => {
    c.stone.set(0.62, 0.58, 0.55, 0, 0.12);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      c.prim(k.BOX, u + Math.cos(a) * size, g + 0.2, v + Math.sin(a) * size, 0.7 * size, 0.5, 0.55 * size, -a);
    }
    flame(c);
    c.prim(k.CONE, u, g + 0.75, v, 0.4 * size, 1.0, 0.4 * size, 0.5);
  });
  // (the modelled stones lie where the boxes do: seven, a seventh of a turn apart)
  if (modelled) piece(c, variant(u, v, 2) ? 'Fire1' : 'Fire0', u, g, v, 0, tones({ stone: [0.62, 0.58, 0.55, 0.04] }), undefined, size, 1, size);
  c.glow(u, g + 0.8, v, 4 * size);
}

/** Jars standing about a point. */
function jars(c: SiteCtx, k: Kit, u: number, v: number, n: number, spread = 1): void {
  const keep = c.solid;
  c.solid = false;
  c.stone.set(0.92, 0.56, 0.38, 2, 0.03);
  for (let i = 0; i < n; i++) {
    const ju = u + c.r(-spread, spread);
    const jv = v + c.r(-spread, spread);
    const s = c.r(0.28, 0.46);
    c.prim(k.PEBBLE, ju, c.g(ju, jv) + s * 0.95, jv, s, s * 1.2, s, c.rng() * 6);
  }
  c.solid = keep;
}

/** Bales of cloth and sacks, stacked. */
function bales(c: SiteCtx, k: Kit, u: number, v: number, ang: number, n: number): void {
  const Tx = Math.cos(ang);
  const Tz = Math.sin(ang);
  for (let i = 0; i < n; i++) {
    const up = i >= Math.ceil(n * 0.6);
    const t = up ? i - Math.ceil(n * 0.6) + 0.5 : i;
    const bu = u + Tx * t * 1.25;
    const bv = v + Tz * t * 1.25;
    cloth(c, pickOf(c, CLOTHS), 0.9);
    c.prim(k.BOX, bu, c.g(bu, bv) + (up ? 1.15 : 0.4), bv, 1.15, 0.75, 0.85, -ang + c.r(-0.1, 0.1));
  }
}

/** A low black tent of goat hair: a ridge on poles, the cloth pegged down behind and open in front. */
function tent(c: SiteCtx, k: Kit, u: number, v: number, ang: number, face: number, L: number): void {
  const Tx = Math.cos(ang);
  const Tz = Math.sin(ang);
  const Nx = -Tz * face;
  const Nz = Tx * face;
  const g = c.g(u, v);
  const half = 3.3;
  const ridge = 2.9;
  const eave = 1.3;
  const tilt = Math.atan2(ridge - eave, half);
  const slope = Math.hypot(half, ridge - eave) + 0.3;
  const keep = c.solid;
  c.solid = false;
  const modelled = ghosted(c, () => {
    // the two falls of the roof, a paler band woven along each
    for (const s of [-1, 1]) {
      c.stone.set(0.2, 0.16, 0.14, 2, 0.05);
      c.prim(k.BOX, u + (Nx * s * half) / 2, g + (ridge + eave) / 2, v + (Nz * s * half) / 2, L, 0.1, slope, -ang, s * face * tilt);
      c.stone.set(0.62, 0.5, 0.36, 2, 0.02);
      c.prim(k.BIT, u + Nx * s * half * 0.62, g + ridge - (ridge - eave) * 0.62 + 0.07, v + Nz * s * half * 0.62, L + 0.05, 0.05, 0.42, -ang, s * face * tilt);
    }
    // the back and one end hang to the ground; the front stands open on its poles
    c.stone.set(0.18, 0.145, 0.13, 2, 0.04);
    c.prim(k.BOX, u - Nx * half, g + eave / 2, v - Nz * half, L, eave + 0.2, 0.1, -ang);
    c.prim(k.BOX, u - (Tx * L) / 2, g + eave / 2 + 0.3, v - (Tz * L) / 2, 0.1, eave + 0.7, half * 2, -ang);
    wood(c);
    for (const t of [-L / 2 + 0.3, 0, L / 2 - 0.3]) {
      c.prim(k.BIT, u + Tx * t, g + ridge / 2, v + Tz * t, 0.12, ridge, 0.12);
      c.prim(k.BIT, u + Tx * t + Nx * half, g + eave / 2, v + Tz * t + Nz * half, 0.09, eave, 0.09);
    }
    // guy ropes pegged out in front
    for (const t of [-L / 2 + 0.3, L / 2 - 0.3]) c.prim(k.BIT, u + Tx * t + Nx * (half + 0.9), g + eave / 2, v + Tz * t + Nz * (half + 0.9), 0.04, 0.04, 2.2, -ang, face * 0.55);
  });
  // the modelled tent stretched to its length: the middle of it, between the end poles
  if (modelled) piece(c, (['TentA', 'TentB', 'TentC'] as const)[variant(u, v, 3)], u, g, v, face > 0 ? ang : ang + Math.PI, tones({ rough: 0 }), { x: [4.5, 1.5, L / 2] });
  // a rug and cushions inside
  cloth(c, pickOf(c, [MADDER, INDIGO, SAFFRON]), 0.9);
  c.prim(k.BIT, u + Nx * 0.4, g + 0.06, v + Nz * 0.4, L * 0.6, 0.06, 3.4, -ang);
  for (let i = 0; i < 3; i++) {
    cloth(c, pickOf(c, CLOTHS));
    c.prim(k.PEBBLE, u + Tx * c.r(-L * 0.25, L * 0.25) - Nx * c.r(0.6, 1.8), g + 0.25, v + Tz * c.r(-L * 0.25, L * 0.25) - Nz * c.r(0.6, 1.8), 0.45, 0.22, 0.4, c.rng() * 6);
  }
  c.solid = keep;
}

/** A beehive kiln, its mouth facing bearing `ang`: lit from dusk, and never quite out. */
function kiln(c: SiteCtx, k: Kit, u: number, v: number, ang: number, R: number, wt: number): void {
  const g = c.g(u, v);
  const Fx = Math.cos(ang);
  const Fz = Math.sin(ang);
  const modelled = ghosted(c, () => {
    footing(c, wt);
    c.prim(k.CYL, u, g + 0.25, v, R * 1.12, 0.9, R * 1.12);
    mud(c, wt * 0.94);
    c.prim(k.BLOB, u, g + R * 0.55, v, R, R * 1.42, R, c.rng() * 6);
    c.stone.set(0.3, 0.26, 0.24, 2, 0.04);
    c.prim(k.CYL, u, g + R * 1.95, v, R * 0.2, 0.7, R * 0.2);
    // the mouth: an arch of darker brick, and the fire behind it
    footing(c, wt * 0.9);
    c.prim(k.BOX, u + Fx * R * 0.86, g + 0.95, v + Fz * R * 0.86, R * 0.5, 1.9, R * 0.62, -ang);
    flame(c);
    bit(c, k, u + Fx * (R * 1.1 + 0.02), g + 0.85, v + Fz * (R * 1.1 + 0.02), 0.12, 1.25, R * 0.36, ang);
  });
  if (modelled) piece(c, variant(u, v, 2) ? 'Kiln1' : 'Kiln0', u, g, v, ang, tones({ wt: wt * 0.94 }), undefined, R / 3.1, R / 3.1, R / 3.1);
  c.glow(u + Fx * (R * 1.15), g + 0.9, v + Fz * (R * 1.15), 5.5);
  c.glow(u + Fx * (R * 1.15), g + 0.9, v + Fz * (R * 1.15), 2.2);
  // split wood stacked beside it
  wood(c, 0.9);
  const su = u - Fz * (R + 1.3);
  const sv = v + Fx * (R + 1.3);
  for (let i = 0; i < 5; i++) c.prim(k.CYL, su + Fx * (i % 3) * 0.34, c.g(su, sv) + 0.2 + Math.floor(i / 3) * 0.34, sv + Fz * (i % 3) * 0.34, 0.17, 1.5, 0.17, -ang + Math.PI / 2, Math.PI / 2);
}

/** A ring of brass, upright in the plane of bearing `b`, or lying flat when `flat` is set. */
function ring(c: SiteCtx, k: Kit, u: number, y: number, v: number, r: number, b: number, flat = false): void {
  c.stone.set(BRASS[0], BRASS[1], BRASS[2], 1, 0);
  const n = 18;
  const seg = (TAU * r) / n + 0.04;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    if (flat) bit(c, k, u + Math.cos(t) * r, y, v + Math.sin(t) * r, seg, 0.09, 0.09, t + Math.PI / 2);
    else bit(c, k, u + Math.cos(b) * Math.cos(t) * r, y + Math.sin(t) * r, v + Math.sin(b) * Math.cos(t) * r, seg, 0.09, 0.09, b, 0, t + Math.PI / 2);
  }
}

// ------------------------------------------------------------------ the ten places

/** Black tents round one deep well, on open sand. Six people, and nobody else for a day's walk. */
function buildWellCamp(c: SiteCtx, k: Kit): void {
  c.foot = 26;
  well(c, k, 0, 0);
  k.torch(c, 3.4, -1.2, 1.3);
  const a0 = c.rng() * TAU;
  const n = 4;
  const open = a0 + Math.PI; // the side left open, where the fire is
  for (let i = 0; i < n; i++) {
    const a = a0 + (i - (n - 1) / 2) * 1.12 + c.r(-0.1, 0.1);
    const d = c.r(12.5, 15.5);
    tent(c, k, Math.cos(a) * d, Math.sin(a) * d, a + Math.PI / 2, 1, i % 2 ? 7.5 : 9);
    if (i % 2 === 0) jars(c, k, Math.cos(a + 0.42) * (d - 3), Math.sin(a + 0.42) * (d - 3), 3, 0.8);
  }
  const fu = Math.cos(open) * 7.5;
  const fv = Math.sin(open) * 7.5;
  fire(c, k, fu, fv);
  // a trough and a hitching line for the camels, and their loads set down beside it
  const ha = open + 1.25;
  const hu = Math.cos(ha) * 15;
  const hv = Math.sin(ha) * 15;
  wood(c);
  c.prim(k.BOX, hu, c.g(hu, hv) + 0.3, hv, 3.4, 0.55, 0.8, -ha - Math.PI / 2);
  for (const s of [-3.5, 3.5]) bit(c, k, hu + Math.cos(ha) * 2.4 - Math.sin(ha) * s, c.g(hu, hv) + 0.75, hv + Math.sin(ha) * 2.4 + Math.cos(ha) * s, 0.14, 1.5, 0.14);
  bit(c, k, hu + Math.cos(ha) * 2.4, c.g(hu, hv) + 1.35, hv + Math.sin(ha) * 2.4, 7.2, 0.07, 0.07, ha + Math.PI / 2);
  bales(c, k, hu + Math.cos(ha) * 4.6, hv + Math.sin(ha) * 4.6, ha + Math.PI / 2, 5);
  // a pole and a long pennant, so the camp can be found again
  const pa = open - 1.3;
  pennant(c, k, Math.cos(pa) * 11, c.g(Math.cos(pa) * 11, Math.sin(pa) * 11), Math.sin(pa) * 11, 7.5, INDIGO, pa);
  // who is here: the keeper at the well, two at the fire, one at a tent door, one at the trough, a child
  const BLUE: RGB = [0.16, 0.22, 0.5];
  const BLACK: RGB = [0.17, 0.13, 0.12];
  person(c, 2.9, 1.6, fu, fv, WHITE, { role: 'host' });
  person(c, fu + Math.cos(open + 1.2) * 2.2, fv + Math.sin(open + 1.2) * 2.2, fu, fv, BLUE, { sit: true });
  person(c, fu + Math.cos(open - 1.0) * 2.3, fv + Math.sin(open - 1.0) * 2.3, fu, fv, BLACK, { sit: true });
  person(c, Math.cos(a0 + 0.5) * 9, Math.sin(a0 + 0.5) * 9, 0, 0, BLUE);
  person(c, hu + Math.cos(ha) * -1.6, hv + Math.sin(ha) * -1.6, hu, hv, BLUE);
  person(c, fu + Math.cos(open + 2.6) * 3.4, fv + Math.sin(open + 2.6) * 3.4, fu, fv, [0.5, 0.38, 0.26], { small: true });
}

/** An observatory on a lone hilltop: a dome with a slit in it, a brass ring on a tower, four houses down the slope. */
function buildStarHouse(c: SiteCtx, k: Kit): void {
  c.foot = 32;
  const wt = c.r(0.98, 1.06);
  const g0 = c.g(0, 0);
  // the drum and its dome, the slit turned to the part of the sky they are counting this year
  footing(c, wt);
  c.prim(k.CYL, 0, g0 - 0.4, 0, 6.3, 2.2, 6.3);
  mud(c, wt);
  c.prim(k.CYL, 0, g0 + 2.6, 0, 5.6, 4.2, 5.6);
  mud(c, wt * 1.08);
  c.prim(k.CYL, 0, g0 + 4.75, 0, 5.95, 0.4, 5.95);
  c.stone.set(1.12, 1.1, 1.02, 1, 0.03);
  c.prim(k.BLOB, 0, g0 + 4.6, 0, 5.3, 4.9, 5.3, 0.3);
  const sa = c.rng() * TAU;
  dark(c);
  for (let i = 0; i < 5; i++) {
    const t = 0.25 + i * 0.26; // from near the zenith down toward the rim
    bit(c, k, Math.cos(sa) * Math.sin(t) * 5.25, g0 + 4.6 + Math.cos(t) * 4.85, Math.sin(sa) * Math.sin(t) * 5.25, 1.5, 0.3, 1.0, sa, 0, -t);
  }
  // the door, on the side away from the slit, three steps up
  const da = sa + Math.PI + 0.5;
  dark(c);
  bit(c, k, Math.cos(da) * 5.55, g0 + 1.55, Math.sin(da) * 5.55, 0.4, 2.1, 1.3, da);
  wood(c);
  bit(c, k, Math.cos(da) * 5.7, g0 + 2.7, Math.sin(da) * 5.7, 0.3, 0.24, 1.9, da);
  footing(c, wt);
  for (let s = 0; s < 3; s++) c.prim(k.BOX, Math.cos(da) * (6.5 + s * 0.5), g0 - 0.6 + (0.5 - s * 0.3) / 2, Math.sin(da) * (6.5 + s * 0.5), 0.55, 1.7 - s * 0.3, 2.2, -da);
  // the instrument tower, and the ring on it: three hoops of brass and the rod they turn on
  const ta = sa + 2.1;
  const tu = Math.cos(ta) * 11.5;
  const tv = Math.sin(ta) * 11.5;
  const tg = c.g(tu, tv);
  footing(c, wt);
  c.prim(k.BOX, tu, tg - 0.3, tv, 4.6, 1.6, 4.6, -ta);
  mud(c, wt * 0.98);
  c.prim(k.SLAB, tu, tg + 4.6, tv, 3.6, 9.2, 3.6, -ta);
  mud(c, wt * 1.04);
  c.prim(k.BOX, tu, tg + 9.35, tv, 3.9, 0.5, 3.9, -ta);
  dark(c);
  bit(c, k, tu - Math.cos(ta) * 1.75, tg + 1.0, tv - Math.sin(ta) * 1.75, 0.3, 2.0, 1.1, ta);
  for (const y of [4.2, 6.8]) bit(c, k, tu - Math.cos(ta) * 1.6, tg + y, tv - Math.sin(ta) * 1.6, 0.3, 1.1, 0.4, ta);
  const ry = tg + 11.9;
  ring(c, k, tu, ry, tv, 2.0, ta);
  ring(c, k, tu, ry, tv, 1.85, ta + Math.PI / 2);
  ring(c, k, tu, ry, tv, 2.0, 0, true);
  c.stone.set(BRASS[0], BRASS[1], BRASS[2], 1, 0);
  bit(c, k, tu, ry - 0.2, tv, 0.1, 4.8, 0.1, 0, 0.4);
  bit(c, k, tu, tg + 9.75, tv, 0.5, 0.5, 0.5);
  // four houses down the slope, doors to the path
  for (let i = 0; i < 4; i++) {
    const a = da + 0.75 + i * 1.18 + c.r(-0.12, 0.12);
    const d = c.r(19, 24);
    k.house(c, Math.cos(a) * d, Math.sin(a) * d, a + Math.PI / 2, 1, c.r(5.4, 6.8), c.r(4.4, 5.4), c.r(2.7, 3.2), wt * c.r(0.96, 1.05));
  }
  // stepping stones down from the door, and a stone bench that looks out over the sand
  c.stone.set(0.98, 0.93, 0.84, 0, 0.05);
  const keep = c.solid;
  c.solid = false;
  for (let d = 8.6; d < 27; d += 1.8) {
    const a = da + Math.sin(d * 0.3) * 0.06;
    c.prim(k.BIT, Math.cos(a) * d, c.g(Math.cos(a) * d, Math.sin(a) * d) + 0.03, Math.sin(a) * d, c.r(1.0, 1.4), 0.16, c.r(0.9, 1.3), c.rng() * 6);
  }
  c.solid = keep;
  const ba = da - 1.0;
  const bu = Math.cos(ba) * 12.5;
  const bv = Math.sin(ba) * 12.5;
  c.stone.set(1.0, 0.97, 0.9, 0, 0.06);
  c.prim(k.BOX, bu, c.g(bu, bv) + 0.28, bv, 0.7, 0.56, 4.2, -ba);
  // the long glass on its tripod, pointed low over the desert
  const ga = da - 2.0;
  const gu = Math.cos(ga) * 10.5;
  const gv = Math.sin(ga) * 10.5;
  const gg = c.g(gu, gv);
  wood(c, 1.2);
  for (let i = 0; i < 3; i++) {
    const a = ga + (i / 3) * TAU;
    bit(c, k, gu + Math.cos(a) * 0.4, gg + 0.7, gv + Math.sin(a) * 0.4, 0.07, 1.6, 0.07, a, 0, 0.5);
  }
  c.stone.set(BRASS[0], BRASS[1], BRASS[2], 1, 0);
  bit(c, k, gu + Math.cos(ga) * 0.2, gg + 1.6, gv + Math.sin(ga) * 0.2, 2.2, 0.2, 0.2, ga, 0, 0.3);
  // who is here: the old stargazer at the glass, two on the bench, one at the door, the maker at the tower, an apprentice
  const NIGHT: RGB = [0.12, 0.17, 0.42];
  person(c, gu - Math.cos(ga) * 1.4, gv - Math.sin(ga) * 1.4, gu + Math.cos(ga) * 6, gv + Math.sin(ga) * 6, [0.86, 0.62, 0.2], { role: 'host' });
  person(c, bu - Math.sin(ba) * 1.0, bv + Math.cos(ba) * 1.0, bu * 3, bv * 3, NIGHT, { sit: true });
  person(c, bu + Math.sin(ba) * 1.1, bv - Math.cos(ba) * 1.1, bu * 3, bv * 3, [0.16, 0.2, 0.46], { sit: true });
  person(c, Math.cos(da + 0.3) * 8.2, Math.sin(da + 0.3) * 8.2, Math.cos(da) * 20, Math.sin(da) * 20, NIGHT);
  person(c, tu - Math.cos(ta) * 3.6, tv - Math.sin(ta) * 3.6, tu, tv, [0.38, 0.26, 0.17]);
  person(c, gu - Math.cos(ga) * 2.6 - Math.sin(ga) * 1.2, gv - Math.sin(ga) * 2.6 + Math.cos(ga) * 1.2, gu, gv, [0.2, 0.26, 0.52], { small: true });
  person(c, Math.cos(da) * 17, Math.sin(da) * 17, 0, 0, NIGHT);
}

/** Shallow pools of pink, white and green out on a pan, salt stacked in blocks, and a row of low houses with their backs to the wind. */
function buildSaltWorks(c: SiteCtx, k: Kit): void {
  c.foot = 62;
  const wt = c.r(1.02, 1.1);
  const n = 8;
  for (let i = 0; i < n; i++) {
    const hu = (i - (n - 1) / 2) * 9.4 + c.r(-0.6, 0.6);
    k.house(c, hu, -24 + c.r(-1, 1), 0, 1, c.r(6.2, 7.6), c.r(4.6, 5.4), c.r(2.3, 2.7), wt * c.r(0.97, 1.04));
  }
  // the pools: a grid of them, each behind a low crust of its own salt
  const POOLS: RGB[] = [[1.28, 0.8, 0.76], [1.32, 1.3, 1.26], [0.64, 1.02, 0.92], [1.02, 0.82, 1.06], [1.3, 1.02, 0.78], [0.72, 0.96, 1.08]];
  const keep = c.solid;
  c.solid = false;
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 5; i++) {
      const pw = 13.2;
      const pd = 13.6;
      const pu = (i - 2) * (pw + 1.6) + (j % 2) * 3;
      const pv = -5 + j * (pd + 1.6) + pd / 2;
      const g = c.g(pu, pv);
      c.stone.set(1.34, 1.33, 1.3, 1, 0.07);
      c.prim(k.BOX, pu, g + 0.02, pv, pw + 1.3, 0.42, pd + 1.3);
      const t = pickOf(c, POOLS);
      c.stone.set(t[0], t[1], t[2], 1, 0);
      c.prim(k.BIT, pu, g + 0.2, pv, pw, 0.12, pd);
      // salt raked into rows in the ones that are nearly dry
      if (c.rng() < 0.4) {
        c.stone.set(1.36, 1.35, 1.32, 1, 0.05);
        for (let q = 0; q < 4; q++) c.prim(k.PEBBLE, pu - pw * 0.3 + q * pw * 0.2, g + 0.3, pv + c.r(-3, 3), 0.7, 0.34, 0.7, c.rng() * 6);
      }
    }
  }
  c.solid = keep;
  // the stacks, by the houses, where the tallyman can see them
  const stack = (su: number, sv: number, rows: number): void => {
    const g = c.g(su, sv);
    c.stone.set(1.36, 1.35, 1.32, 1, 0.03);
    for (let r = 0; r < rows; r++) for (let i = 0; i < rows - r; i++) c.prim(k.BOX, su + (i - (rows - r - 1) / 2) * 1.12, g + 0.3 + r * 0.6, sv, 1.05, 0.58, 1.6);
  };
  stack(-22, -14, 5);
  stack(-9, -13.5, 4);
  stack(17, -14, 5);
  stack(29, -13, 3);
  // the tally shade: cloth on four poles, a board with the count cut into it
  awning(c, k, 4, -13.5, 0, 4.2, 3.2, MADDER, false);
  wood(c, 1.2);
  bit(c, k, 6.6, c.g(6.6, -13.5) + 1.1, -13.5, 0.12, 2.2, 1.4);
  // a sled half loaded, a cart, rakes left standing in a pool's rim
  wood(c);
  const sg = c.g(-14, 1);
  c.prim(k.BOX, -14, sg + 0.22, -3, 3.0, 0.18, 1.5, -0.3);
  c.stone.set(1.36, 1.35, 1.32, 1, 0.03);
  for (let i = 0; i < 3; i++) c.prim(k.BOX, -14.8 + i * 0.9, sg + 0.62, -3 + i * 0.28, 0.85, 0.55, 1.2, -0.3);
  k.cart(c, 24, -6, 2.2);
  wood(c, 1.15);
  for (const [ru, rv, ra] of [[-6, 3.6, 0.3], [9, 18.6, -0.4], [21, 3.6, 0.5]] as const) bit(c, k, ru, c.g(ru, rv) + 1.0, rv, 0.07, 2.3, 0.07, 0, ra * 0.4, ra);
  pennant(c, k, -38, c.g(-38, -20), -20, 8, UNDYED);
  k.torch(c, -3, -19, 1.3);
  k.torch(c, 12, -19, 1.3);
  // who is here: the tallyman in his shade, cutters out among the pools, haulers at the sled, a child on the stacks' side
  const BLACK: RGB = [0.14, 0.11, 0.1];
  person(c, 4, -13.2, 4, 10, BLACK, { role: 'host' });
  person(c, -7.5, 3, -7.5, 9, WHITE);
  person(c, 10.5, 18, 10.5, 24, WHITE);
  person(c, 22.4, 3, 22.4, 9, WHITE);
  person(c, -24, 18, -18, 22, WHITE);
  person(c, 0, 33.6, 3, 39, WHITE);
  person(c, -29, -4, -22, -14, WHITE);
  person(c, -16.6, -4.6, -14, -3, STRAW);
  person(c, -11.4, -1.2, -14, -3, STRAW);
  person(c, 15, -11.6, 17, -14, LINEN, { sit: true });
  person(c, 27, -10.6, 29, -13, [0.8, 0.7, 0.5], { small: true });
  person(c, 30, -19, 30, 0, WHITE);
}

/** Three beehive kilns that glow from dusk, racks of glass that catch the light, and the houses of the people who blow it. */
function buildGlassKilns(c: SiteCtx, k: Kit): void {
  c.foot = 44;
  const wt = c.r(0.98, 1.06);
  // the kilns stand in an arc, their mouths to the yard
  const mouths: [number, number][] = [];
  for (let i = 0; i < 3; i++) {
    const a = Math.PI + (i - 1) * 0.95;
    const d = 10.5;
    const R = i === 1 ? 3.7 : 3.1;
    kiln(c, k, Math.cos(a) * d, Math.sin(a) * d, a + Math.PI, R, wt);
    mouths.push([Math.cos(a) * (d - R - 1.6), Math.sin(a) * (d - R - 1.6)]);
  }
  // racks of glass set out to cool: it holds the light by day and by night
  const GLASS: RGB[] = [[1, 1, 1], [3.1, 0.82, 0.24], [0.62, 0.74, 1.22], [2.2, 1.02, 0.9]];
  const rack = (u: number, v: number, ang: number, w: number): void => {
    const Tx = Math.cos(ang);
    const Tz = Math.sin(ang);
    const g = c.g(u, v);
    wood(c);
    for (const s of [-1, 1]) bit(c, k, u + (Tx * s * w) / 2, g + 1.4, v + (Tz * s * w) / 2, 0.14, 2.8, 0.14);
    bit(c, k, u, g + 2.75, v, w + 0.5, 0.1, 0.1, ang);
    bit(c, k, u, g + 1.5, v, w, 0.08, 0.08, ang);
    const m = Math.floor(w / 0.62);
    for (let i = 0; i < m; i++) {
      const t = -w / 2 + 0.4 + (i / (m - 1)) * (w - 0.8);
      const hi = i % 2 === 0;
      const drop = c.r(0.3, 0.7);
      wood(c);
      bit(c, k, u + Tx * t, g + (hi ? 2.75 : 1.5) - drop / 2, v + Tz * t, 0.03, drop, 0.03);
      const tn = pickOf(c, GLASS);
      c.stone.set(tn[0], tn[1], tn[2], 4, 0);
      const s = c.r(0.16, 0.26);
      bit(c, k, u + Tx * t, g + (hi ? 2.75 : 1.5) - drop - s, v + Tz * t, s * 1.3, s * 2.0, s * 1.3, c.rng() * 3, 0, Math.PI / 4);
    }
    c.glow(u, g + 1.9, v, 2.6);
  };
  rack(6, -7.5, 0.35, 5.6);
  rack(8.5, 2.5, -1.2, 5);
  rack(3.5, 9, 0.9, 6.2);
  // the bench where it is cut, and what stands on it
  const bg = c.g(0.5, 0.5);
  c.stone.set(1.0, 0.97, 0.9, 0, 0.06);
  c.prim(k.BOX, 0.5, bg + 0.45, 0.5, 3.2, 0.9, 1.4, -0.4);
  for (let i = 0; i < 4; i++) {
    const tn = pickOf(c, GLASS);
    c.stone.set(tn[0], tn[1], tn[2], 4, 0);
    bit(c, k, 0.5 + Math.cos(0.4) * (i - 1.5) * 0.7, bg + 1.12, 0.5 + Math.sin(0.4) * (i - 1.5) * 0.7, 0.2, 0.44, 0.2, i);
  }
  // a heap of the pale sand they melt, and baskets for carrying it
  c.stone.set(1.3, 1.26, 1.14, 1, 0.1);
  c.prim(k.BLOB, -2, c.g(-2, 17) - 0.2, 17, 4.2, 1.5, 3.6, 0.6);
  c.stone.set(0.78, 0.6, 0.36, 2, 0.04);
  for (const [bu, bv] of [[2.6, 15.6], [3.6, 17.4]] as const) c.prim(k.CYL, bu, c.g(bu, bv) + 0.3, bv, 0.42, 0.6, 0.42);
  // blowpipes leaning in a rack by the middle kiln
  c.stone.set(0.5, 0.48, 0.5, 1, 0);
  for (let i = 0; i < 4; i++) bit(c, k, -3.2 + i * 0.16, c.g(-3.2, -5) + 1.0, -5 - i * 0.2, 0.05, 2.2, 0.05, 0, 0.12, 0.2);
  // the houses, round the other half of the yard
  for (let i = 0; i < 9; i++) {
    const a = -1.5 + (i / 8) * 3.0 + c.r(-0.06, 0.06);
    const d = (i % 2 ? 31 : 24.5) + c.r(-1, 1);
    k.house(c, Math.cos(a) * d, Math.sin(a) * d, a + Math.PI / 2, 1, c.r(5.6, 7.2), c.r(4.4, 5.6), c.r(2.7, 3.3), wt * c.r(0.96, 1.05));
  }
  well(c, k, 15, 0);
  k.torch(c, 12, 5.5, 1.4);
  k.torch(c, -4, -17, 1.4);
  pennant(c, k, 0, c.g(0, -22), -22, 8, SAFFRON);
  // who is here: the master at the middle kiln, blowers at the others and the bench, carriers at the heap, a child
  const SOOT: RGB = [0.3, 0.28, 0.29];
  person(c, mouths[1][0] + 0.6, mouths[1][1] + 1.6, mouths[1][0] - 4, mouths[1][1], [0.9, 0.55, 0.12], { role: 'host' });
  person(c, mouths[0][0], mouths[0][1], mouths[0][0] * 1.6, mouths[0][1] * 1.6, SOOT);
  person(c, mouths[2][0], mouths[2][1], mouths[2][0] * 1.6, mouths[2][1] * 1.6, SOOT);
  person(c, 1.6, -1.2, 0.5, 0.5, SOOT);
  person(c, 5.2, -5.6, 6, -7.5, [0.36, 0.33, 0.33]);
  person(c, 4.6, 6.6, 3.5, 9, SOOT);
  person(c, 2.2, 13.6, -2, 17, LINEN);
  person(c, -6.4, 14.6, -2, 17, LINEN, { sit: true });
  person(c, 13, -2.6, 15, 0, LINEN);
  person(c, -0.8, 3, 0.5, 0.5, [0.7, 0.6, 0.46], { small: true });
  person(c, 18, 9, 0, 0, SOOT);
}

/** Houses stacked against a rock face under a great overhang, pots drying along the lip, and ladders. +u is up the slope. */
function buildLedge(c: SiteCtx, k: Kit): void {
  c.foot = 50;
  const wt = c.r(0.96, 1.04);
  // three rows, each standing on the ground behind the roofs of the one below
  const rows: SiteHouse[][] = [];
  for (let r = 0; r < 3; r++) {
    const row: SiteHouse[] = [];
    const n = 6 - r;
    for (let i = 0; i < n; i++) {
      const hv = (i - (n - 1) / 2) * 8.3 + c.r(-0.5, 0.5) + (r % 2) * 2;
      row.push(hut(c, k, 5 + r * 7.2 + c.r(-0.4, 0.4), hv, Math.PI / 2, 1, c.r(5.6, 7), c.r(4.6, 5.4), c.r(2.9, 3.5), wt * c.r(0.95, 1.05)));
    }
    rows.push(row);
  }
  // ladders: from the ground to the first roofs, and from roof to the door above
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < rows[r + 1].length; i += 2) {
      const up = rows[r + 1][i];
      const p0 = up.at(c.r(-1.6, 1.6), 5.4);
      const p1 = up.at(0, 2.9);
      ladder(c, k, p0[0], c.g(p0[0], p0[1]), p0[1], p1[0], up.floor + 0.2, p1[1]);
    }
  }
  // the overhang: slabs of the rock itself, bedded in the slope behind and held up at either end
  const top = c.g(24, 0);
  const roofY = Math.max(top + 5.5, rows[2][0].top + 4.4);
  c.stone.set(1, 0.98, 0.96, 0, 0.55);
  c.prim(k.BOX, 20, roofY + 2.4, -9, 20, 4.8, 34, 0.05, 0, -0.07);
  c.stone.set(0.96, 0.95, 0.94, 0, 0.6);
  c.prim(k.BOX, 21, roofY + 2.9, 12, 19, 5.6, 30, -0.08, 0, -0.05);
  c.stone.set(1.03, 1.0, 0.97, 0, 0.5);
  c.prim(k.BOX, 26, roofY + 5.6, 0, 14, 4, 46, 0.02, 0, -0.1);
  for (const s of [-1, 1]) {
    c.stone.set(0.98, 0.96, 0.94, 0, 0.7);
    c.prim(k.BLOB, 17, c.g(17, s * 28) + (roofY - c.g(17, s * 28)) / 2, s * 28, 6.5, (roofY - c.g(17, s * 28)) / 2 + 3.5, 5, s);
    c.prim(k.BLOB, 25, c.g(25, s * 25) + 3, s * 25, 8, roofY - c.g(25, s * 25) + 2, 6, s * 2);
  }
  // the lip: a low wall along the front, and the day's pots drying on it
  footing(c, wt);
  for (let i = -5; i <= 5; i++) {
    if (i === 0) continue; // the way in
    const lv = i * 4.4;
    c.prim(k.BOX, 0, c.g(0, lv) + 0.2, lv, 0.6, 1.2, 4.5);
  }
  const keep = c.solid;
  c.solid = false;
  for (let i = 0; i < 26; i++) {
    const lv = -22 + i * 1.72 + c.r(-0.2, 0.2);
    if (Math.abs(lv) < 2.6) continue;
    const s = c.r(0.22, 0.4);
    c.stone.set(0.86 + c.r(-0.08, 0.1), 0.48, 0.3, 2, 0.03);
    c.prim(k.PEBBLE, 0, c.g(0, lv) + 0.8 + s, lv, s, s * 1.25, s, c.rng() * 6);
  }
  c.solid = keep;
  // down on the sand: the kiln, the clay, and the tower that watches the way up
  kiln(c, k, -13, 15, Math.PI * 0.75, 2.5, wt);
  c.stone.set(0.74, 0.44, 0.3, 2, 0.12);
  c.prim(k.BLOB, -9, c.g(-9, 21) - 0.1, 21, 2.6, 0.9, 2.2, 1);
  jars(c, k, -8, 11, 6, 2.2);
  k.tower(c, 3, -31, Math.PI / 2, c.r(9.5, 11.5), wt);
  well(c, k, -11, -8);
  awning(c, k, -9.5, 1.5, 0.2, 4, 3, pickOf(c, [MADDER, SAFFRON]));
  k.torch(c, -2.4, 3.6, 1.4);
  k.torch(c, -2.4, -3.6, 1.4);
  // who is here: the ladder keeper at the way in, potters at the kiln and the wheel, elders in the shade, children
  const CLAY: RGB = [0.62, 0.26, 0.16];
  const CREAM: RGB = [0.88, 0.83, 0.7];
  person(c, -2.6, 1.2, -9, 0, [0.82, 0.54, 0.16], { role: 'host' });
  person(c, -10.4, 12.4, -13, 15, CLAY);
  person(c, -7.2, 18.6, -9, 21, CLAY, { sit: true });
  person(c, -6.6, 9.4, -8, 11, CLAY);
  person(c, -11.2, 0.6, -9.5, 1.5, CREAM, { sit: true });
  person(c, -8, 3, -9.5, 1.5, CREAM, { sit: true });
  person(c, -9.2, -6.4, -11, -8, CLAY);
  person(c, 1.8, 7, -6, 7, [0.84, 0.66, 0.4], { small: true });
  person(c, 1.6, -12, -6, -12, CLAY);
  person(c, 1.7, 18, -8, 18, [0.8, 0.5, 0.2]);
  person(c, -4, -24, 3, -31, [0.8, 0.5, 0.2]);
}

/** Houses along the deck of a stone bridge, a gate at each end, fish drying and boats tied up below. +u runs across the river. */
function buildBridge(c: SiteCtx, k: Kit): void {
  c.foot = 52;
  const wt = c.r(0.98, 1.06);
  const bed = c.g(0, 0);
  const bank = Math.max(c.g(24, 0), c.g(-24, 0));
  const D = bank + 3.6; // the deck
  const W = 12.5;
  // the deck over the water, on two piers with a cutwater at each end
  mud(c, wt * 0.97);
  c.prim(k.BOX, 0, D - 0.6, 0, 37, 1.2, W);
  for (const pu of [-8.2, 8.2]) {
    footing(c, wt);
    c.prim(k.BOX, pu, (bed - 1.5 + D - 1.2) / 2, 0, 3.2, D - 1.2 - bed + 1.5, W + 1.4);
    for (const s of [-1, 1]) c.prim(k.SLAB, pu, (bed - 1.5 + D - 2.6) / 2, s * (W / 2 + 1.5), 3.2, D - 2.6 - bed + 1.5, 3.2, Math.PI / 4);
    // the springing of the arches, corbelled out under the deck
    mud(c, wt * 0.93);
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) c.prim(k.BOX, pu + s * (2.2 + i * 1.3), D - 1.55 - i * 0.02 + i * 0.12 - 0.3, 0, 1.4, 0.8 - i * 0.2, W - 0.4);
  }
  // abutments, and the stairs up from either bank
  for (const s of [-1, 1]) {
    footing(c, wt);
    c.prim(k.BOX, s * 20.5, (bed - 1 + D - 1.2) / 2, 0, 4, D - 1.2 - bed + 1, W + 1);
    const steps = 9;
    for (let i = 0; i < steps; i++) {
      const su = s * (19.2 + i * 0.95);
      const y1 = D - (i * (D - bank)) / steps;
      mud(c, wt * 0.95);
      c.prim(k.BOX, su, (bank - 1.5 + y1) / 2, 0, 0.98, y1 - bank + 1.5, 7);
    }
    // the gate: two pylons and a beam, a lamp hung from it, a pennant
    for (const t of [-1, 1]) {
      mud(c, wt);
      c.prim(k.SLAB, s * 29.5, bank + 3.3, t * 4.6, 2.7, 7.6, 2.7);
      k.merlons(c, s * 29.5, t * 4.6, bank + 6.9, 2.4, 2.4, 1, 0);
    }
    wood(c);
    bit(c, k, s * 29.5, bank + 5.4, 0, 0.4, 0.4, 7.4);
    c.stone.set(0.2, 0.18, 0.17, 1, 0.02);
    bit(c, k, s * 29.5, bank + 4.75, 0, 0.36, 0.5, 0.36);
    flame(c);
    bit(c, k, s * 29.5, bank + 4.7, 0, 0.22, 0.3, 0.22);
    c.glow(s * 29.5, bank + 4.7, 0, 3.2);
    pennant(c, k, s * 29.5, bank + 7.3, s * 4.6 * 1, 3.4, MADDER, s > 0 ? 0 : Math.PI);
  }
  // the houses on the deck: a row down each side, a lane between, each hanging a little out over the water
  for (const side of [-1, 1]) {
    let hu = -15.5;
    while (hu < 14) {
      const w = c.r(4.2, 5.6);
      const d = 4.0;
      if (Math.abs(hu + w / 2) > 2.4 || side < 0) hut(c, k, hu + w / 2, side * (W / 2 - d / 2 + 0.7), 0, -side, w, d, c.r(2.7, 4.9), wt * c.r(0.95, 1.06), D);
      hu += w + c.r(0.5, 1.4);
    }
  }
  // a rail across the gap left for looking at the river
  wood(c);
  bit(c, k, 0, D + 0.95, W / 2 - 0.2, 5.2, 0.12, 0.12);
  for (const t of [-2.4, 0, 2.4]) bit(c, k, t, D + 0.5, W / 2 - 0.2, 0.12, 1.0, 0.12);
  clothLine(c, k, -9, D + 3.4, -3.4, -9, D + 3.4, 3.4, CLOTHS, 0.5);
  clothLine(c, k, 9.5, D + 3.4, -3.4, 9.5, D + 3.4, 3.4, CLOTHS, 0.5);
  // on the banks: a few houses each side of the road, racks of fish, the boats
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const t = i < 2 ? -1 : 1;
      const hu = s * (35.5 + (i % 2) * 2.6);
      const hv = t * (9.5 + (i % 2) * 9.6) + c.r(-0.6, 0.6);
      k.house(c, hu, hv, Math.PI / 2 + c.r(-0.1, 0.1), -s, c.r(5.4, 6.6), c.r(4.4, 5.2), c.r(2.7, 3.2), wt * c.r(0.96, 1.05));
    }
    // fish split and hung in the wind
    for (const t of [-1, 1]) {
      const ru = s * 24.5;
      const rv = t * 15;
      const g = c.g(ru, rv);
      wood(c);
      for (const e of [-2.2, 2.2]) bit(c, k, ru, g + 1.1, rv + e, 0.12, 2.2, 0.12);
      bit(c, k, ru, g + 2.1, rv, 0.08, 0.08, 4.8);
      c.stone.set(1.05, 1.08, 1.1, 1, 0);
      for (let i = 0; i < 8; i++) bit(c, k, ru, g + 1.72, rv - 1.9 + i * 0.54, 0.05, 0.7, 0.22);
    }
    // a boat drawn up where the water starts
    const bu = s * 16.6;
    const bv = s * 13;
    const bg = c.g(bu, bv);
    wood(c, 0.85);
    c.prim(k.BLOB, bu, bg + 0.3, bv, 1.0, 0.55, 3.1, 0.25 * s);
    wood(c, 1.2);
    bit(c, k, bu, bg + 0.66, bv, 1.5, 0.08, 4.6, 0.25 * s + Math.PI / 2 - Math.PI / 2);
    bit(c, k, bu, bg + 1.9, bv, 0.09, 2.6, 0.09);
    k.torch(c, s * 27, s * -7.6, 1.4);
  }
  jars(c, k, 25, 9, 4, 1.4);
  bales(c, k, -25.5, -9.5, 0.4, 4);
  // who is here: the toll keeper at one gate, river folk on the deck and the banks, fish driers at the racks, children
  const RIVER: RGB = [0.12, 0.45, 0.48];
  const REED: RGB = [0.33, 0.5, 0.28];
  person(c, 31.6, 1.6, 40, 1, [0.74, 0.16, 0.12], { role: 'host' });
  person(c, -31.5, -1.6, -40, 0, [0.74, 0.16, 0.12]);
  person(c, 1.2, 4.6, 1.2, 20, RIVER, { y: D });
  person(c, -1.4, 4.4, -3, 20, [0.86, 0.8, 0.66], { y: D, small: true });
  person(c, -11, 0.6, 0, 0, RIVER, { y: D });
  person(c, 12, -0.4, 0, 0, REED, { y: D });
  person(c, 26, 14.4, 24.5, 15, REED);
  person(c, -26.2, -14.2, -24.5, -15, REED);
  person(c, 18.6, 11.4, 16.6, 13, RIVER);
  person(c, -19, -11, -16.6, -13, RIVER, { sit: true });
  person(c, 33, -5, 40, -8, RIVER);
  person(c, -33.5, 6, -40, 8, RIVER);
  person(c, 24, -12.6, 24.5, -15, [0.4, 0.56, 0.34]);
  person(c, -22.4, 11, -24.5, 15, [0.82, 0.74, 0.56], { small: true });
}

/** One great walled house half way along a route: a gate you could ride a camel through, a yard, stables, a lamp over the door all night. +u faces the road. */
function buildCaravanserai(c: SiteCtx, k: Kit): void {
  c.foot = 44;
  const wt = c.r(1.0, 1.08);
  const R = 21; // half the square
  const H = 6.4;
  // the wall, in lengths that follow the ground, toothed along the top
  const wall = (u0: number, v0: number, u1: number, v1: number): void => {
    const len = Math.hypot(u1 - u0, v1 - v0);
    const n = Math.max(1, Math.round(len / 5.4));
    const ang = Math.atan2(v1 - v0, u1 - u0);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const wu = u0 + (u1 - u0) * t;
      const wv = v0 + (v1 - v0) * t;
      const g = c.g(wu, wv);
      mud(c, wt * c.r(0.98, 1.02));
      c.prim(k.BOX, wu, g + H / 2 - 0.6, wv, len / n + 0.1, H + 1.2, 1.5, -ang);
      k.merlons(c, wu, wv, g + H, len / n, 1.5, Math.cos(ang), Math.sin(ang));
      // slits high in the wall
      dark(c);
      bit(c, k, wu - Math.sin(ang) * 0.72, g + H - 1.7, wv + Math.cos(ang) * 0.72, 0.3, 1.1, 0.14, ang);
      bit(c, k, wu + Math.sin(ang) * 0.72, g + H - 1.7, wv - Math.cos(ang) * 0.72, 0.3, 1.1, 0.14, ang);
    }
  };
  wall(-R, -R, R, -R);
  wall(-R, R, R, R);
  wall(-R, -R, -R, R);
  wall(R, -R, R, -3.4);
  wall(R, 3.4, R, R);
  // corner towers, a pennant on each of the two that face the road
  for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const g = c.g(a * R, b * R);
    footing(c, wt);
    c.prim(k.BOX, a * R, g - 0.2, b * R, 6, 1.6, 6);
    mud(c, wt * 1.01);
    c.prim(k.SLAB, a * R, g + 5, b * R, 5, 10, 5);
    c.prim(k.BOX, a * R, g + 10.1, b * R, 5.2, 0.6, 5.2);
    k.merlons(c, a * R, b * R, g + 10.4, 5.2, 5.2, 1, 0);
    k.merlons(c, a * R, b * R, g + 10.4, 5.2, 5.2, 0, 1);
    dark(c);
    for (const y of [4, 7.4]) bit(c, k, a * (R + 2.45 * (a > 0 ? 1 : 1)), g + y, b * R, 0.14, 1.3, 0.45);
    if (a > 0) pennant(c, k, a * R, g + 10.6, b * R, 4.4, b > 0 ? MADDER : TEAL);
  }
  // the gate: two pylons taller than the wall, the arch between them, and the lamp that burns all night
  const gg = c.g(R, 0);
  for (const s of [-1, 1]) {
    mud(c, wt * 1.03);
    c.prim(k.SLAB, R + 0.3, gg + 4.4, s * 4.5, 3.4, 9.6, 3.4);
    k.merlons(c, R + 0.3, s * 4.5, gg + 9, 3, 3, 0, 1);
  }
  mud(c, wt * 1.03);
  c.prim(k.BOX, R + 0.3, gg + 7.1, 0, 2.2, 2.8, 6.4);
  c.prim(k.BOX, R + 0.3, gg + 5.5, -2.4, 2.0, 0.9, 1.2, 0, 0.6);
  c.prim(k.BOX, R + 0.3, gg + 5.5, 2.4, 2.0, 0.9, 1.2, 0, -0.6);
  c.stone.set(0.2, 0.18, 0.17, 1, 0.02);
  bit(c, k, R + 1.5, gg + 5.1, 0, 0.44, 0.6, 0.44);
  flame(c);
  bit(c, k, R + 1.5, gg + 5.05, 0, 0.28, 0.4, 0.28);
  c.glow(R + 1.6, gg + 5.05, 0, 6.5);
  c.glow(R + 1.6, gg + 5.05, 0, 2.6);
  cloth(c, SAFFRON);
  bit(c, k, R + 1.46, gg + 7.4, 0, 0.06, 1.7, 3.2);
  // inside: stalls under a lean-to along two walls, and the lodging along the back, two floors and a dome
  const lean = (u0: number, v0: number, u1: number, v1: number, inward: [number, number]): void => {
    const len = Math.hypot(u1 - u0, v1 - v0);
    const ang = Math.atan2(v1 - v0, u1 - u0);
    const mu = (u0 + u1) / 2 + inward[0] * 2.4;
    const mv = (v0 + v1) / 2 + inward[1] * 2.4;
    const g = c.g(mu, mv);
    mud(c, wt * 0.99);
    bit(c, k, mu, g + 3.25, mv, len, 0.3, 5, ang, 0, 0);
    wood(c);
    const n = Math.round(len / 4.2);
    for (let i = 0; i <= n; i++) {
      const t = i / n - 0.5;
      const pu = (u0 + u1) / 2 + (u1 - u0) * t + inward[0] * 4.6;
      const pv = (v0 + v1) / 2 + (v1 - v0) * t + inward[1] * 4.6;
      c.prim(k.BIT, pu, c.g(pu, pv) + 1.6, pv, 0.26, 3.2, 0.26, -ang);
      if (i < n) {
        // a stall's back door, and straw
        dark(c);
        bit(c, k, pu + ((u1 - u0) / n) * 0.5 - inward[0] * 3.8, c.g(pu, pv) + 1.0, pv + ((v1 - v0) / n) * 0.5 - inward[1] * 3.8, 1.2, 2.0, 0.2, ang);
        wood(c);
      }
    }
  };
  lean(-R + 6, -R, R - 4, -R, [0, 1]);
  lean(-R + 6, R, R - 4, R, [0, -1]);
  hut(c, k, -R + 4.6, 0, Math.PI / 2, -1, 26, 6.4, 5.9, wt * 1.02);
  mud(c, wt * 1.06);
  c.prim(k.BLOB, -R + 4.6, c.g(-R + 4.6, 0) + 6.1, 0, 3.4, 2.8, 3.4, 0.4);
  // the yard: the well, a trough, a fire, the day's loads set down
  well(c, k, 2, -2);
  wood(c);
  c.prim(k.BOX, 6.5, c.g(6.5, -9) + 0.3, -9, 4.2, 0.55, 0.9, -0.2);
  fire(c, k, -5, 6.5, 1.1);
  bales(c, k, 8, 10, 0.3, 6);
  bales(c, k, -3, -11, 1.4, 4);
  jars(c, k, 12, 13.5, 5, 1.6);
  k.hay(c, 13, -14.5, 1.3);
  k.hay(c, 10.6, -15.6, 1.0);
  k.cart(c, -8, -5.5, 2.4);
  for (const s of [-1, 1]) bit(c, k, 13, c.g(13, s * 6) + 0.6, s * 6, 0.14, 1.2, 0.14);
  // outside: palms either side of the gate, and bales waiting for the morning
  k.palm(c, R + 9, 12.5, 1);
  k.palm(c, R + 8, -13, 4);
  bales(c, k, R + 6, -6.5, 1.2, 3);
  k.torch(c, R + 12, 5, 1.5);
  // who is here: the innkeeper just inside the gate, guards outside it, stable hands, and whoever is on the road this week
  const COATS: RGB[] = [[0.5, 0.16, 0.14], [0.2, 0.46, 0.46], [0.36, 0.2, 0.3], [0.72, 0.52, 0.26], [0.84, 0.78, 0.64], [0.2, 0.38, 0.6], [0.8, 0.5, 0.16]];
  person(c, R - 4.2, 2.6, R + 6, 0, WHITE, { role: 'host' });
  person(c, R + 3.6, 5.6, R + 12, 3, LINEN);
  person(c, R + 3.6, -5.6, R + 12, -3, LINEN);
  person(c, 9, -12.6, 13, -14.5, RUST);
  person(c, 6.4, -6.6, 6.5, -9, RUST);
  person(c, -9, -3, -8, -5.5, RUST);
  person(c, -5 + 2.3, 6.5 + 1.2, -5, 6.5, COATS[0], { sit: true });
  person(c, -5 - 1.6, 6.5 + 2.2, -5, 6.5, COATS[1], { sit: true });
  person(c, -5 - 2.2, 6.5 - 1.4, -5, 6.5, COATS[2], { sit: true });
  person(c, 4.6, 0.6, 2, -2, COATS[3]);
  person(c, 9.6, 8, 8, 10, COATS[4]);
  person(c, 6.4, 11.6, 8, 10, COATS[5]);
  person(c, -12.6, 2.6, 0, 0, COATS[6]);
  person(c, 0.4, 5.4, 2, -2, [0.76, 0.6, 0.4], { small: true });
  person(c, R + 7.6, -3.6, R + 6, -6.5, COATS[3]);
}

/** Three rows of houses on a slope, cloth drying on lines between every roof, and a honeycomb of dye vats at the bottom. +u is up the slope. */
function buildDyersTown(c: SiteCtx, k: Kit): void {
  c.foot = 72;
  const wt = c.r(1.0, 1.08);
  const rows: SiteHouse[][] = [];
  for (let r = 0; r < 3; r++) {
    const row: SiteHouse[] = [];
    const n = 9 - r;
    for (let i = 0; i < n; i++) {
      const hv = (i - (n - 1) / 2) * 10.2 + c.r(-0.8, 0.8) + (r % 2) * 3;
      const hu = 10 + r * 13.5 + c.r(-0.8, 0.8);
      // a gap in the middle of the front row, for the way down to the vats
      if (r === 0 && Math.abs(hv) < 4) {
        row.push({ floor: c.g(hu, hv), top: c.g(hu, hv) + 3, at: (lx, lz) => [hu - lz, hv + lx] });
        continue;
      }
      row.push(
        r === 0
          ? k.house(c, hu, hv, Math.PI / 2, 1, c.r(6.2, 7.6), c.r(4.8, 5.8), c.r(2.8, 3.4), wt * c.r(0.96, 1.05))
          : hut(c, k, hu, hv, Math.PI / 2, 1, c.r(6, 7.6), c.r(4.8, 5.8), c.r(2.9, 4.6), wt * c.r(0.95, 1.06)),
      );
    }
    rows.push(row);
  }
  // cloth on lines: along each row from roof to roof, and up the hill from one row to the next
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i + 1 < rows[r].length; i++) {
      if (r === 0 && (i === 3 || i === 4)) continue;
      if (c.rng() < 0.25) continue;
      const a = rows[r][i];
      const b = rows[r][i + 1];
      const p0 = a.at(c.r(1, 2), c.r(-1, 1));
      const p1 = b.at(c.r(-2, -1), c.r(-1, 1));
      clothLine(c, k, p0[0], a.top, p0[1], p1[0], b.top, p1[1], DYES);
    }
    if (r === 2) continue;
    for (let i = 1; i < rows[r + 1].length; i += 2) {
      const a = rows[r][i];
      const b = rows[r + 1][i];
      if (r === 0 && (i === 4 || i === 3)) continue;
      const p0 = a.at(c.r(-1.5, 1.5), -1.2);
      const p1 = b.at(c.r(-1.5, 1.5), 1.4);
      clothLine(c, k, p0[0], a.top, p0[1], p1[0], b.top, p1[1], DYES, 1.25);
    }
  }
  // the vats: three rows of stone rings, each brimming with one colour
  const vat: [number, number][] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 9; i++) {
      const vu = -7 - j * 3.6;
      const vv = (i - 4) * 4.15 + (j % 2) * 2.07;
      const g = Math.max(c.g(vu, vv), c.g(vu - 1.6, vv), c.g(vu + 1.6, vv));
      c.stone.set(1.06, 1.02, 0.94, 0, 0.07);
      c.prim(k.CYL, vu, g - 0.25, vv, 1.72, 1.6, 1.72);
      const t = c.rng() < 0.14 ? UNDYED : pickOf(c, DYES);
      c.stone.set(t[0], t[1], t[2], 1, 0);
      bit(c, k, vu, g + 0.56, vv, 2.05, 0.06, 2.05, c.rng() * 6);
      c.prim(k.CYL, vu, g + 0.5, vv, 1.42, 0.14, 1.42);
      vat.push([vu, vv]);
    }
  }
  // tall frames by the vats, hung with the longest lengths
  for (const fv of [-27, -24, 24, 27]) {
    const fu = -11;
    const g = c.g(fu, fv);
    wood(c);
    for (const s of [-3, 3]) bit(c, k, fu + s, c.g(fu + s, fv) + 2.3, fv, 0.16, 4.6, 0.16);
    bit(c, k, fu, g + 4.5, fv, 6.6, 0.12, 0.12);
    for (let i = 0; i < 4; i++) {
      cloth(c, pickOf(c, DYES));
      const drop = c.r(2.6, 3.8);
      bit(c, k, fu - 2.2 + i * 1.5, g + 4.45 - drop / 2, fv, 1.3, drop, 0.05);
    }
  }
  // the spring they wash in, below the vats, with a rim of stones
  const su = -25;
  const sy = c.g(su, 0) + 0.12;
  c.pools.push({ y: sy, r: 3.4, u: su, v: 0 });
  c.stone.set(1.0, 0.97, 0.9, 0, 0.1);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    c.prim(k.BOX, su + Math.cos(a) * 3.7, sy, Math.sin(a) * 3.7, 2.0, 0.7, 0.8, -a - Math.PI / 2);
  }
  k.palm(c, su - 5, 4, 2);
  k.palm(c, su - 4, -5.5, 5);
  awning(c, k, 1.5, -9, Math.PI / 2, 4.4, 3.2, MAGENTA);
  awning(c, k, 1.5, 9, Math.PI / 2, 4.4, 3.2, SAFFRON);
  k.cart(c, -1, -18, 0.6);
  k.torch(c, 3.5, 2.6, 1.5);
  k.torch(c, 3.5, -2.6, 1.5);
  k.torch(c, -4, 21, 1.4);
  k.torch(c, -4, -21, 1.4);
  pennant(c, k, 4, c.g(4, 0) + 0.2, 0, 9, VIOLET);
  // who is here: the master dyer among the vats, dyers at theirs, merchants under the awnings, vat keepers, children
  const PURPLE: RGB = [0.44, 0.16, 0.52];
  const BLUE: RGB = [0.16, 0.22, 0.5];
  const by = (i: number, du: number, dv: number): [number, number] => [vat[i][0] + du, vat[i][1] + dv];
  person(c, ...by(4, 2.6, 0.4), vat[4][0], vat[4][1], PURPLE, { role: 'host' });
  person(c, ...by(1, 2.4, 0), vat[1][0], vat[1][1], LINEN);
  person(c, ...by(7, 2.4, 0.3), vat[7][0], vat[7][1], LINEN);
  person(c, ...by(11, 0, 2.5), vat[11][0], vat[11][1], LINEN);
  person(c, ...by(15, -0.2, -2.5), vat[15][0], vat[15][1], WHITE);
  person(c, ...by(20, -2.5, 0.2), vat[20][0], vat[20][1], LINEN);
  person(c, ...by(24, -2.5, 0), vat[24][0], vat[24][1], BLUE);
  person(c, ...by(18, -2.6, -0.4), vat[18][0], vat[18][1], BLUE);
  person(c, -10.4, -22.4, -11, -24, LINEN);
  person(c, 2.4, -6.2, 1.5, -9, [0.76, 0.16, 0.46]);
  person(c, 2.4, 6.2, 1.5, 9, [0.9, 0.62, 0.12]);
  person(c, su + 4.6, 1.6, su, 0, LINEN, { sit: true });
  person(c, su + 3.6, -3.6, su, 0, [0.84, 0.76, 0.5], { small: true });
  person(c, 5.4, 1.2, -6, 0, [0.84, 0.8, 0.66], { small: true });
  person(c, 16.6, 6, 10, 10, LINEN);
  person(c, 16.6, -14, 10, -10, WHITE);
}

/** A town on a flat plain with no water in sight: it comes in underground, along a line of well mounds, and wind towers and an ice house keep the place cool. */
function buildWindTowers(c: SiteCtx, k: Kit): void {
  c.foot = 100;
  const wt = c.r(1.0, 1.08);
  // four blocks of houses round a square, a street each way between them
  for (const qu of [-1, 1]) {
    for (const qv of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          if (i === 0 && j === 0 && c.rng() < 0.5) continue; // the corner on the square, left open
          const hu = qu * (12.5 + i * 12.4) + c.r(-1, 1);
          const hv = qv * (12.5 + j * 12.4) + c.r(-1, 1);
          const along = (i + j) % 2 === 0;
          const w = c.r(6.6, 8.6);
          const d = c.r(5.6, 7);
          const h = c.r(3.0, 6.4);
          // doors to the nearer street
          hut(c, k, hu, hv, along ? 0 : Math.PI / 2, along ? -qv : -qu, w, d, h, wt * c.r(0.94, 1.06));
          if ((i * 3 + j + (qu > 0 ? 1 : 0) + (qv > 0 ? 2 : 0)) % 3 === 0) windTower(c, k, hu + qu * (along ? w : d) * 0.3, hv + qv * (along ? d : w) * 0.3, c.r(-0.1, 0.1), h + c.r(4.6, 7.4), wt);
        }
      }
    }
  }
  // the square: the basin the water comes up in, palms, stalls
  const by = c.g(0, 0) + 0.25;
  c.pools.push({ y: by, r: 4.4, u: 0, v: 0 });
  c.stone.set(1.02, 0.99, 0.92, 0, 0.06);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * TAU;
    c.prim(k.BOX, Math.cos(a) * 4.8, by - 0.05, Math.sin(a) * 4.8, 2.2, 0.9, 0.9, -a - Math.PI / 2);
  }
  for (const [pu, pv, la] of [[6.6, 5.4, 1], [-6.2, 5.8, 3], [5.6, -6.4, 5], [-6, -5.6, 0.5]] as const) k.palm(c, pu, pv, la);
  awning(c, k, 3.6, 10.5, 0, 4.4, 3, SAFFRON);
  awning(c, k, -9.5, 2.4, Math.PI / 2, 4.2, 3, MADDER);
  awning(c, k, -3.4, -10.5, 0, 4.4, 3, TEAL);
  k.bunting(c, 44, -3.4, 44, 3.4, 4.6);
  k.bunting(c, 20, -3.4, 20, 3.4, 4.6);
  k.bunting(c, -3.4, 22, 3.4, 22, 4.6);
  for (const [tu, tv] of [[8, 3.6], [-8, -3.6], [30, 3.6], [-30, -3.6], [3.6, 30], [-3.6, -30]] as const) k.torch(c, tu, tv, 1.5);
  // the water's road in: the line of shafts out across the plain, each with its ring of spoil, and the last stretch open to the sky
  const keep = c.solid;
  for (let i = 0; i < 6; i++) {
    const mu = -53 - i * 8.6;
    const g = c.g(mu, 0);
    c.stone.set(1.08, 1.02, 0.9, 2, 0.14);
    c.prim(k.BLOB, mu, g - 0.2, 0, 3.4, 1.3, 3.4, i);
    dark(c);
    bit(c, k, mu, g + 1.02, 0, 1.5, 0.2, 1.5, i * 0.7);
  }
  c.stone.set(1.0, 0.97, 0.9, 0, 0.05);
  for (let t = -47; t < -5; t += 3) {
    for (const s of [-1, 1]) c.prim(k.BOX, t + 1.5, c.g(t + 1.5, 0) + 0.12, s * 0.9, 3.05, 0.5, 0.45);
    c.solid = false;
    c.stone.set(0.36, 0.82, 0.84, 1, 0);
    c.prim(k.BIT, t + 1.5, c.g(t + 1.5, 0) + 0.2, 0, 3.05, 0.08, 1.4);
    c.stone.set(1.0, 0.97, 0.9, 0, 0.05);
    c.solid = keep;
  }
  // the ice house: a stepped cone over a pit, and the long wall that keeps the winter sun off the freezing pond
  const iu = 62;
  const iv = -56;
  const ig = c.g(iu, iv);
  for (let i = 0; i < 9; i++) {
    const r = 9.4 - i * 1.0;
    mud(c, wt * (0.98 + (i % 2) * 0.04));
    c.prim(k.CYL, iu, ig + 0.4 + i * 1.5, iv, r, 1.6, r);
  }
  mud(c, wt * 1.04);
  c.prim(k.CONE, iu, ig + 14.7, iv, 0.9, 2.2, 0.9);
  dark(c);
  bit(c, k, iu - 9.3, ig + 1.1, iv, 0.4, 2.2, 1.4);
  for (let i = 0; i < 8; i++) {
    const wu = iu - 30 + i * 5.2;
    mud(c, wt * 0.98);
    c.prim(k.BOX, wu, c.g(wu, iv + 17) + 3.2, iv + 17, 5.3, 7.6, 1.2);
  }
  c.stone.set(1.3, 1.34, 1.38, 1, 0);
  bit(c, k, iu - 12, c.g(iu - 12, iv + 22) + 0.06, iv + 22, 30, 0.1, 6.5);
  // who is here: a water warden at the head of the channel, townsfolk in the square and the streets, sellers, ice cutters, children
  const WARDEN: RGB = [0.08, 0.33, 0.36];
  const GREY: RGB = [0.48, 0.5, 0.53];
  const SELL: RGB = [0.9, 0.62, 0.12];
  person(c, -8.6, 2.2, -20, 0, WARDEN, { role: 'host' });
  person(c, -50, 3.2, -53, 0, WARDEN);
  person(c, 6.4, 1.2, 0, 0, LINEN, { sit: true });
  person(c, 2, -6.6, 0, 0, WHITE, { sit: true });
  person(c, -3.6, 6.4, 0, 0, LINEN);
  person(c, 3.6, 8.2, 3.6, 10.5, LINEN);
  person(c, 5, 12.6, 3.6, 10.5, SELL);
  person(c, -11.6, 3.4, -9.5, 2.4, SELL);
  person(c, -4.6, -12.6, -3.4, -10.5, SELL);
  person(c, -1.6, -8.4, -3.4, -10.5, WHITE);
  person(c, 21, 1.4, 44, 0, LINEN);
  person(c, 33, -1.6, 0, 0, LINEN);
  person(c, 1.6, 24, 0, 44, WHITE);
  person(c, -1.4, -34, 0, 0, LINEN);
  person(c, -28, -1.6, -50, 0, LINEN);
  person(c, iu - 12, iv + 4, iu, iv, GREY);
  person(c, iu - 14, iv + 20, iu - 12, iv + 22, GREY);
  person(c, 7.6, -3.4, 0, 0, [0.84, 0.78, 0.6], { small: true });
  person(c, 8.6, -1.6, 0, 0, [0.8, 0.7, 0.5], { small: true });
  person(c, 2.6, 13, 3.6, 10.5, [0.86, 0.8, 0.64], { small: true });
}

/** A city built up in five tiers to a gold dome, with a stair straight up the front of it. +u is the side the gate is on. */
function buildSteppedCity(c: SiteCtx, k: Kit): void {
  c.foot = 118;
  const wt = c.r(1.0, 1.07);
  const HALF = [90, 71, 54, 38, 23]; // half the width of each tier
  const STEP = 5.6; // how far each stands above the last
  const g0 = c.g(0, 0);
  const yOf = (t: number): number => g0 + t * STEP;
  // the tiers: each a great block of brick, buttressed, with a low wall round its edge
  for (let t = 1; t <= 4; t++) {
    const R = HALF[t];
    mud(c, wt * (0.93 + t * 0.012));
    c.prim(k.BOX, 0, (g0 - 5 + yOf(t)) / 2, 0, R * 2, yOf(t) - g0 + 5, R * 2);
    footing(c, wt * 1.02);
    for (let s = 0; s < 4; s++) {
      const a = (s * Math.PI) / 2;
      const Tx = -Math.sin(a);
      const Tz = Math.cos(a);
      const nb = Math.floor((R * 2) / 11);
      for (let i = 0; i <= nb; i++) {
        const q = -R + 1.4 + (i / nb) * (R * 2 - 2.8);
        if (s === 0 && Math.abs(q) < 5.5) continue; // the stair
        c.prim(k.BOX, Math.cos(a) * (R + 0.5) + Tx * q, (yOf(t - 1) - 1 + yOf(t) - 0.9) / 2, Math.sin(a) * (R + 0.5) + Tz * q, 1.8, STEP - 0.9 + 1, 1.5, -a);
      }
      // the low wall along the edge, left open at the head of the stair
      mud(c, wt * 1.02);
      for (const half of [-1, 1]) {
        const gap = s === 0 ? 3.4 : 0;
        const len = R - gap;
        if (s !== 0 && half > 0) continue;
        const mid = s === 0 ? half * (gap + len / 2) : 0;
        c.prim(k.BOX, Math.cos(a) * (R - 0.4) + Tx * mid, yOf(t) + 0.45, Math.sin(a) * (R - 0.4) + Tz * mid, 0.7, 0.9, s === 0 ? len : R * 2, -a);
      }
      footing(c, wt * 1.02);
    }
  }
  // the stair: one flight to each tier, straight up the front
  for (let t = 1; t <= 4; t++) {
    const n = 12;
    for (let i = 0; i < n; i++) {
      const y1 = yOf(t) - (i * STEP) / n;
      mud(c, wt * (i % 2 ? 0.97 : 1.0));
      c.prim(k.BOX, HALF[t] + 0.5 + i * 0.92, (yOf(t - 1) - 0.6 + y1) / 2, 0, 0.94, y1 - yOf(t - 1) + 0.6, 6.4);
    }
    for (const s of [-1, 1]) {
      mud(c, wt * 1.03);
      c.prim(k.BOX, HALF[t] + 6, yOf(t - 1) + STEP / 2 - 0.3, s * 3.8, 12, STEP + 0.6, 1.2, 0, 0, 0);
      k.torch(c, HALF[t] + 12.8, s * 4.4, 1.5);
    }
  }
  // the houses: a row round each tier, doors to the edge, the rows broken where the stair comes up
  const ring = (t: number, inner: number, outer: number): void => {
    const mid = (inner + outer) / 2 - 1;
    for (let s = 0; s < 4; s++) {
      const a = (s * Math.PI) / 2;
      const Tx = -Math.sin(a);
      const Tz = Math.cos(a);
      let q = -mid + 2;
      while (q < mid - 5) {
        const w = c.r(6.4, 9.2);
        const d = Math.min(outer - inner - 7, c.r(6, 8.4));
        const qm = q + w / 2;
        if (!(s === 0 && Math.abs(qm) < 9 + w / 2)) {
          const hu = Math.cos(a) * mid + Tx * qm;
          const hv = Math.sin(a) * mid + Tz * qm;
          const h = c.r(2.9, 5.6);
          hut(c, k, hu, hv, a + Math.PI / 2, -1, w, d, h, wt * c.r(0.93, 1.07), t === 0 ? undefined : yOf(t));
          if (c.rng() < 0.11) windTower(c, k, hu - Math.cos(a) * d * 0.2 + Tx * w * 0.25, hv - Math.sin(a) * d * 0.2 + Tz * w * 0.25, a, h + c.r(4, 6), wt, t === 0 ? undefined : yOf(t));
        }
        q += w + c.r(1.2, 3.2);
      }
    }
  };
  ring(0, HALF[1] + 1.5, HALF[0] - 2.5);
  ring(1, HALF[2] + 1.5, HALF[1] - 1);
  ring(2, HALF[3] + 1.5, HALF[2] - 1);
  ring(3, HALF[4] + 1.5, HALF[3] - 1);
  // the top: the hall and its gold dome, and the tower beside it
  const ty = yOf(4);
  mud(c, wt * 1.05);
  c.prim(k.BOX, -3, ty + 4.2, 0, 22, 8.4, 18);
  c.prim(k.BOX, -3, ty + 8.6, 0, 22.6, 0.7, 18.6);
  k.merlons(c, -3, 0, ty + 8.95, 22.6, 18.6, 1, 0);
  k.merlons(c, -3, 0, ty + 8.95, 22.6, 18.6, 0, 1);
  mud(c, wt * 1.02);
  c.prim(k.CYL, -3, ty + 10.2, 0, 7.2, 2.6, 7.2);
  c.stone.set(GOLD[0], GOLD[1], GOLD[2], 1, 0.02);
  c.prim(k.BLOB, -3, ty + 11.3, 0, 6.9, 7.4, 6.9, 0.3);
  bit(c, k, -3, ty + 19.6, 0, 0.22, 2.6, 0.22);
  bit(c, k, -3, ty + 20.4, 0, 0.7, 0.7, 0.7, 0.6, 0.6, 0.6);
  dark(c);
  bit(c, k, 8.05, ty + 2.3, 0, 0.4, 4.6, 3.0);
  for (const s of [-1, 1]) for (const q of [-5.4, 5.4]) bit(c, k, 8.05, ty + 5.6, q + s * 0, 0.3, 1.6, 0.7);
  c.glow(8.6, ty + 2.6, 0, 5);
  mud(c, wt * 1.01);
  c.prim(k.SLAB, -15, ty + 13, -14, 5.2, 26, 5.2);
  c.prim(k.BOX, -15, ty + 26.1, -14, 5.4, 0.6, 5.4);
  k.merlons(c, -15, -14, ty + 26.4, 5.4, 5.4, 1, 0);
  k.merlons(c, -15, -14, ty + 26.4, 5.4, 5.4, 0, 1);
  c.stone.set(GOLD[0], GOLD[1], GOLD[2], 1, 0.02);
  c.prim(k.CONE, -15, ty + 28.6, -14, 2.1, 4.4, 2.1, Math.PI / 4);
  flame(c);
  bit(c, k, -15, ty + 23.4, -11.3, 0.9, 1.4, 0.2);
  c.glow(-15, ty + 23.4, -11, 6);
  pennant(c, k, -15, ty + 30.4, -14, 3.6, CRIMSON);
  dark(c);
  for (const y of [8, 14, 19]) bit(c, k, -12.5, ty + y, -14, 0.14, 1.5, 0.5);
  // the outer wall, in lengths that follow the ground, its corner towers, and the gate
  const W = HALF[0] + 3;
  const wall = (u0: number, v0: number, u1: number, v1: number): void => {
    const len = Math.hypot(u1 - u0, v1 - v0);
    const n = Math.max(1, Math.round(len / 8));
    const ang = Math.atan2(v1 - v0, u1 - u0);
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const wu = u0 + (u1 - u0) * f;
      const wv = v0 + (v1 - v0) * f;
      const g = c.g(wu, wv);
      mud(c, wt * c.r(0.97, 1.02));
      c.prim(k.BOX, wu, g + 2.4, wv, len / n + 0.1, 6.8, 1.8, -ang);
      c.prim(k.BOX, wu, g + 6.2, wv, len / n * 0.5, 0.9, 1.8, -ang);
    }
  };
  wall(-W, -W, W, -W);
  wall(-W, W, W, W);
  wall(-W, -W, -W, W);
  wall(W, -W, W, -5);
  wall(W, 5, W, W);
  for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const g = c.g(a * W, b * W);
    mud(c, wt);
    c.prim(k.SLAB, a * W, g + 5, b * W, 6.4, 11, 6.4);
    c.prim(k.BOX, a * W, g + 10.6, b * W, 6.4, 0.7, 6.4);
    k.merlons(c, a * W, b * W, g + 10.95, 6.4, 6.4, 1, 0);
    k.merlons(c, a * W, b * W, g + 10.95, 6.4, 6.4, 0, 1);
    pennant(c, k, a * W, g + 11.2, b * W, 4.6, CRIMSON, a > 0 ? 0 : Math.PI);
  }
  const gg = c.g(W, 0);
  for (const s of [-1, 1]) {
    mud(c, wt * 1.03);
    c.prim(k.SLAB, W + 0.4, gg + 6, s * 7, 5, 13, 5);
    c.prim(k.BOX, W + 0.4, gg + 12.6, s * 7, 5.2, 0.7, 5.2);
    k.merlons(c, W + 0.4, s * 7, gg + 12.95, 5.2, 5.2, 1, 0);
    k.merlons(c, W + 0.4, s * 7, gg + 12.95, 5.2, 5.2, 0, 1);
    pennant(c, k, W + 0.4, gg + 13.2, s * 7, 5, CRIMSON);
    cloth(c, CRIMSON);
    bit(c, k, W + 3.0, gg + 7.2, s * 7, 0.06, 6.4, 1.6);
    k.torch(c, W + 5, s * 4.6, 1.7);
    k.palm(c, W + 13, s * 13, s + 2);
    k.palm(c, W + 21, s * 9.5, s + 4);
  }
  mud(c, wt * 1.03);
  c.prim(k.BOX, W + 0.4, gg + 9.3, 0, 3, 3.6, 9.4);
  c.prim(k.BOX, W + 0.4, gg + 7.1, -3.4, 2.6, 1.2, 1.6, 0, 0.6);
  c.prim(k.BOX, W + 0.4, gg + 7.1, 3.4, 2.6, 1.2, 1.6, 0, -0.6);
  flame(c);
  bit(c, k, W + 2.0, gg + 6.3, 0, 0.3, 0.44, 0.3);
  c.glow(W + 2.1, gg + 6.3, 0, 7);
  c.glow(W + 2.1, gg + 6.3, 0, 2.8);
  // inside the gate: the scribe's table under its shade, stalls, the day's loads
  awning(c, k, W - 7, 7.5, Math.PI / 2, 4.2, 3.2, UNDYED, false);
  wood(c, 1.1);
  c.prim(k.BOX, W - 7, c.g(W - 7, 7.5) + 0.45, 7.5, 1.1, 0.9, 2.2);
  cloth(c, UNDYED);
  bit(c, k, W - 7, c.g(W - 7, 7.5) + 0.96, 7.5, 0.7, 0.12, 1.0, 0.2);
  awning(c, k, W - 8, -9, Math.PI / 2, 4.4, 3, SAFFRON);
  awning(c, k, W - 9, -16, Math.PI / 2, 4.4, 3, MADDER);
  bales(c, k, W - 5, -4.4, 1.5, 5);
  jars(c, k, W - 12, 13, 5, 1.6);
  well(c, k, HALF[1] + 13.5, 16);
  // who is here: the scribe at the gate, guards, citizens up and down the tiers, pilgrims, the high families at the top
  const GUARD: RGB = [0.62, 0.1, 0.12];
  const PURPLE: RGB = [0.36, 0.16, 0.48];
  person(c, W - 8.4, 7.5, W, 3, WHITE, { role: 'host' });
  person(c, W + 5.6, 6.6, W + 20, 6, GUARD);
  person(c, W + 5.6, -6.6, W + 20, -6, GUARD);
  person(c, HALF[1] + 13.6, 5.2, W, 4, GUARD);
  person(c, HALF[1] + 13.6, -5.2, W, -4, GUARD);
  person(c, W - 6.6, -7.4, W - 8, -9, SAND_COAT);
  person(c, W - 10, -10.6, W - 8, -9, STRAW);
  person(c, W - 7.4, -14, W - 9, -16, RUST);
  person(c, W - 4, 0.8, W + 10, 0, LINEN);
  person(c, W - 12.4, 2.2, W, 0, LINEN);
  person(c, HALF[1] + 11.4, 14.6, HALF[1] + 13.5, 16, SAND_COAT);
  person(c, HALF[1] + 15.4, 18.4, HALF[1] + 13.5, 16, [0.8, 0.7, 0.5], { small: true });
  person(c, W - 13.4, 11.6, W - 12, 13, RUST, { sit: true });
  person(c, W + 14, 2.6, W, 0, LINEN);
  person(c, W + 17, -1.6, W, 0, SAND_COAT);
  person(c, HALF[2] + 12.5, 6.4, W, 8, SAND_COAT, { y: yOf(1) });
  person(c, HALF[2] + 12.5, -7, W, -8, RUST, { y: yOf(1) });
  person(c, HALF[3] + 12.4, 6, W, 6, STRAW, { y: yOf(2) });
  person(c, HALF[3] + 12.6, -8.4, W, -6, [0.84, 0.78, 0.6], { y: yOf(2), small: true });
  person(c, HALF[4] + 12, -6, W, -6, SAND_COAT, { y: yOf(3) });
  person(c, 12.4, 3.4, 30, 3, PURPLE, { y: ty });
  person(c, 12.4, -3.4, 30, -3, PURPLE, { y: ty });
  person(c, 16.4, 8, 30, 12, WHITE, { y: ty });
}

/** Builds a settlement of the given kind in the site's frame. */
export function buildSettlement(kind: SettlementKind, c: SiteCtx, k: Kit): void {
  switch (kind) {
    case 'well-camp': buildWellCamp(c, k); break;
    case 'star-house': buildStarHouse(c, k); break;
    case 'salt-works': buildSaltWorks(c, k); break;
    case 'glass-kilns': buildGlassKilns(c, k); break;
    case 'ledge': buildLedge(c, k); break;
    case 'bridge': buildBridge(c, k); break;
    case 'caravanserai': buildCaravanserai(c, k); break;
    case 'dyers-town': buildDyersTown(c, k); break;
    case 'wind-towers': buildWindTowers(c, k); break;
    case 'stepped-city': buildSteppedCity(c, k); break;
  }
}
