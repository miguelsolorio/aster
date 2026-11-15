// The things the wanderer can be given: boards, carpets and picks, ten designs of each.
// The game wears one of each (CHOSEN); the dev page at /equipment.html shows them all.
//
// Every design obeys the same rules as the rest of the world: flat-shaded low-poly
// forms, no textures, at most three colours, and those colours come from the cloth
// and loads the travellers already carry. Pattern is made of coloured faces.
//
// Local spaces. Board: flat in x, z, nose toward +z, deck up, centred. Carpet: the same.
// Rolled carpet: a bundle lying along x, centred. Pick: handle up the y axis from the
// grip at the origin, head at the top, striking edge toward +z.
import * as THREE from 'three';
import type { Uniforms } from './contract';
import { STYLE_GLSL } from '../render/styleGlsl';

type V3 = [number, number, number];

/** The designs the game uses. Change a number to wear a different one. */
// Crescent, Tasselled, Adze (board 10, carpet 6, pick 3 on the equipment page).
export const CHOSEN = { board: 9, carpet: 5, pick: 2 };

// ------------------------------------------------------------------ colours
// Woods and bone, then the cloth and load colours of the caravans (see caravans.ts).
const PALE: V3 = [0.72, 0.63, 0.5];
const OCHRE: V3 = [0.6, 0.46, 0.22];
const BROWN: V3 = [0.45, 0.33, 0.22];
const DARK: V3 = [0.24, 0.18, 0.13];
const BONE: V3 = [0.9, 0.86, 0.76];
const RED: V3 = [0.62, 0.28, 0.22];
const BLUE: V3 = [0.26, 0.36, 0.5];
const NAVY: V3 = [0.2, 0.24, 0.34];
const GREEN: V3 = [0.36, 0.44, 0.3];
const GOLD: V3 = [0.68, 0.52, 0.24];
const TEAL: V3 = [0.2, 0.38, 0.38];
const MAUVE: V3 = [0.55, 0.4, 0.44];
const SAND: V3 = [0.7, 0.64, 0.52];
const IRON: V3 = [0.2, 0.19, 0.2];
const STONE: V3 = [0.42, 0.38, 0.34];

// ------------------------------------------------------------------ builder

/** Collects flat-shaded triangles, each with its own colour. */
class Build {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];

  tri(a: V3, b: V3, c: V3, col: V3): void {
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-10) return;
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx / len, ny / len, nz / len);
      this.col.push(col[0], col[1], col[2]);
    }
  }

  quad(a: V3, b: V3, c: V3, d: V3, col: V3): void {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }

  /** A box by centre and size. */
  box(c: V3, s: V3, col: V3): void {
    this.tube([[c[0], c[1] - s[1] / 2, c[2]], [c[0], c[1] + s[1] / 2, c[2]]], [1, 1], 4, col, Math.PI / 4, [s[0] / Math.SQRT2, s[2] / Math.SQRT2]);
  }

  /**
   * A tube along a line of points, one radius per point. `flat` squashes the section
   * (x and z radii as multiples of the radius), for blades and planks.
   */
  tube(pts: V3[], radii: number[], sides: number, col: V3, rot = 0, flat: [number, number] = [1, 1]): void {
    const n = pts.length;
    const rings: V3[][] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0];
      let ty = b[1] - a[1];
      let tz = b[2] - a[2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      // a frame across the tube: u is sideways (x where it can be), v completes it
      const h: V3 = Math.abs(tx) > 0.9 ? [0, 0, 1] : [1, 0, 0];
      let vx = ty * h[2] - tz * h[1];
      let vy = tz * h[0] - tx * h[2];
      let vz = tx * h[1] - ty * h[0];
      const vl = Math.hypot(vx, vy, vz) || 1;
      vx /= vl;
      vy /= vl;
      vz /= vl;
      const ux = vy * tz - vz * ty;
      const uy = vz * tx - vx * tz;
      const uz = vx * ty - vy * tx;
      const ring: V3[] = [];
      for (let j = 0; j < sides; j++) {
        const ang = rot + (j / sides) * Math.PI * 2;
        const cu = Math.cos(ang) * radii[i] * flat[0];
        const cv = Math.sin(ang) * radii[i] * flat[1];
        ring.push([pts[i][0] + ux * cu + vx * cv, pts[i][1] + uy * cu + vy * cv, pts[i][2] + uz * cu + vz * cv]);
      }
      rings.push(ring);
    }
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < sides; j++) {
        const k = (j + 1) % sides;
        this.quad(rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j], col);
      }
    }
    for (const i of [0, n - 1]) {
      for (let j = 1; j < sides - 1; j++) this.tri(rings[i][0], rings[i][j], rings[i][j + 1], col);
    }
  }

  done(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

const mul = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];
/** A rounded profile: 1 in the middle, 0 at both ends. p sharpens the ends, q fattens the middle. */
const sup = (t: number, p: number, q: number) => Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * t - 1), p)), q);

// ------------------------------------------------------------------ boards

interface BoardSpec {
  name: string;
  note: string;
  len: number;
  /** Half-width at t: 0 the tail .. 1 the nose. */
  half(t: number): number;
  nose: number; // how far the nose turns up
  tail: number; // how far the tail turns up
  cols: V3[];
  /** Colour index of the deck at (u: -1..1 across, t: 0..1 along; i, j: the cell). -1 leaves a hole. */
  deck(u: number, t: number, i: number, j: number): number;
  rim: number;
  under: number;
  extra?(b: Build, at: (u: number, t: number, dy?: number) => V3, s: BoardSpec): void;
}

const BU = 4; // cells across a board
const BT = 18; // cells along it
const THICK = 0.03;

const BOARD_SPECS: BoardSpec[] = [
  {
    name: 'Plank',
    note: 'A long oval of pale wood with a dark stringer.',
    len: 1.5,
    half: (t) => 0.16 * sup(t, 2.4, 0.5),
    nose: 0.5,
    tail: 0,
    cols: [PALE, DARK, BROWN],
    deck: (_u, _t, i) => (i === 1 || i === 2 ? 0 : 0),
    rim: 2,
    under: 1,
    extra(b, at) {
      b.tube([at(0, 0.08, 0.004), at(0, 0.5, 0.004), at(0, 0.9, 0.004)], [0.012, 0.012, 0.012], 4, DARK, Math.PI / 4, [1, 0.3]);
    },
  },
  {
    name: 'Leaf',
    note: 'Pointed at both ends, woven from two reeds.',
    len: 1.6,
    half: (t) => 0.17 * sup(t, 1.5, 0.9),
    nose: 0.45,
    tail: 0.15,
    cols: [SAND, OCHRE, DARK],
    deck: (_u, _t, i, j) => (i + j) % 2,
    rim: 2,
    under: 1,
  },
  {
    name: 'Sled',
    note: 'Short and blunt, on two runners, with a rope to pull it.',
    len: 1.15,
    half: (t) => 0.2 * sup(t, 7, 0.5),
    nose: 1.3,
    tail: 0,
    cols: [BROWN, DARK, SAND],
    deck: (_u, _t, _i, j) => (j % 4 === 3 ? 1 : 0),
    rim: 1,
    under: 1,
    extra(b, at) {
      for (const u of [-0.6, 0.6]) b.tube([at(u, 0.06, -0.05), at(u, 0.5, -0.06), at(u, 0.84, -0.045)], [0.016, 0.016, 0.014], 4, DARK, Math.PI / 4);
      const n = at(0, 0.97, 0.01);
      b.tube([at(-0.5, 0.95, 0.01), [n[0] - 0.05, n[1] + 0.09, n[2] + 0.04], [n[0] + 0.05, n[1] + 0.09, n[2] + 0.04], at(0.5, 0.95, 0.01)], [0.008, 0.008, 0.008, 0.008], 4, SAND);
    },
  },
  {
    name: 'Swallowtail',
    note: 'A split tail, dipped dark at the tips.',
    len: 1.5,
    half: (t) => 0.17 * (t < 0.35 ? 0.82 + 0.18 * (t / 0.35) : sup(((t - 0.35) / 0.65) * 0.5 + 0.5, 2, 0.7)),
    nose: 0.5,
    tail: 0,
    cols: [OCHRE, DARK, PALE],
    deck: (u, t, i) => ((i === 1 || i === 2) && t < 0.13 ? -1 : t < 0.2 ? 1 : Math.abs(u) < 0.5 && t > 0.2 && t < 0.26 ? 2 : 0),
    rim: 1,
    under: 1,
  },
  {
    name: 'Red nose',
    note: 'The plank, with its nose painted traveller red.',
    len: 1.6,
    half: (t) => 0.16 * sup(t, 2.4, 0.5),
    nose: 0.55,
    tail: 0,
    cols: [PALE, RED, DARK],
    deck: (_u, t) => (t > 0.72 ? 1 : t > 0.67 ? 2 : 0),
    rim: 2,
    under: 2,
  },
  {
    name: 'Bone',
    note: 'Long, narrow and white, bound in three places.',
    len: 1.7,
    half: (t) => 0.115 * sup(t, 2, 0.6),
    nose: 0.4,
    tail: 0.1,
    cols: [BONE, DARK, RED],
    deck: (_u, _t, _i, j) => (j === 4 || j === 13 ? 1 : j === 9 ? 2 : 0),
    rim: 0,
    under: 0,
  },
  {
    name: 'Shield',
    note: 'A wide teardrop wrapped in blue cloth, rimmed in gold.',
    len: 1.3,
    half: (t) => 0.24 * Math.pow(Math.sin(Math.PI * Math.pow(Math.min(1, Math.max(0, t)), 0.62)), 0.8),
    nose: 0.4,
    tail: 0,
    cols: [BLUE, GOLD, NAVY],
    deck: (_u, _t, i) => (i === 0 || i === 3 ? 2 : 0),
    rim: 1,
    under: 2,
  },
  {
    name: 'Chevron',
    note: 'Pointed nose, square tail, striped like a caravan blanket.',
    len: 1.5,
    half: (t) => 0.17 * (t < 0.6 ? 1 : sup(((t - 0.6) / 0.4) * 0.5 + 0.5, 1.6, 0.9)),
    nose: 0.5,
    tail: 0,
    cols: [SAND, RED, NAVY],
    deck: (_u, _t, i, j) => {
      const k = (j + (i === 0 || i === 3 ? 1 : 0)) % 6;
      return k === 0 ? 1 : k === 3 ? 2 : 0;
    },
    rim: 2,
    under: 2,
  },
  {
    name: 'Driftwood',
    note: 'Four planks of whatever washed up, lashed together.',
    len: 1.45,
    half: (t) => 0.19 * sup(t, 8, 0.5),
    nose: 0.35,
    tail: 0,
    cols: [BROWN, PALE, DARK],
    deck: (_u, _t, i, j) => {
      if ((i === 0 && j > 15) || (i === 3 && j < 2) || (i === 2 && j > 16)) return -1;
      if (j === 4 || j === 12) return 2;
      return i === 1 ? 1 : i === 3 ? 1 : 0;
    },
    rim: 2,
    under: 2,
  },
  {
    name: 'Crescent',
    note: 'Dark wood turned up at both ends, inlaid down the middle.',
    len: 1.55,
    half: (t) => 0.15 * sup(t, 2, 0.6),
    nose: 0.75,
    tail: 0.75,
    cols: [DARK, BONE, GOLD],
    deck: (_u, _t, i, j) => ((i === 1 || i === 2) && j % 3 === 1 && j > 2 && j < 16 ? 1 : 0),
    rim: 2,
    under: 0,
  },
];

function buildBoard(s: BoardSpec): THREE.BufferGeometry {
  const b = new Build();
  const rock = (t: number) => s.nose * Math.pow(Math.max(0, t - 0.62), 2) + s.tail * Math.pow(Math.max(0, 0.38 - t), 2);
  const at = (u: number, t: number, dy = 0): V3 => [u * s.half(t), rock(t) + THICK + dy, (t - 0.5) * s.len];
  for (let j = 0; j < BT; j++) {
    const t0 = j / BT;
    const t1 = (j + 1) / BT;
    for (let i = 0; i < BU; i++) {
      const u0 = (i / BU) * 2 - 1;
      const u1 = ((i + 1) / BU) * 2 - 1;
      const c = s.deck((u0 + u1) / 2, (t0 + t1) / 2, i, j);
      if (c < 0) continue;
      b.quad(at(u0, t0), at(u1, t0), at(u1, t1), at(u0, t1), s.cols[c]);
      b.quad(at(u0, t0, -THICK), at(u1, t0, -THICK), at(u1, t1, -THICK), at(u0, t1, -THICK), mul(s.cols[s.under], 0.8));
      // the cut edges of a hole or a ragged end
      if (i === 0 || s.deck(u0 - 0.01, (t0 + t1) / 2, i - 1, j) < 0) b.quad(at(u0, t0), at(u0, t1), at(u0, t1, -THICK), at(u0, t0, -THICK), s.cols[s.rim]);
      if (i === BU - 1 || s.deck(u1 + 0.01, (t0 + t1) / 2, i + 1, j) < 0) b.quad(at(u1, t0), at(u1, t1), at(u1, t1, -THICK), at(u1, t0, -THICK), s.cols[s.rim]);
      if (j === 0 || s.deck((u0 + u1) / 2, t0 - 0.01, i, j - 1) < 0) b.quad(at(u0, t0), at(u1, t0), at(u1, t0, -THICK), at(u0, t0, -THICK), s.cols[s.rim]);
      if (j === BT - 1 || s.deck((u0 + u1) / 2, t1 + 0.01, i, j + 1) < 0) b.quad(at(u0, t1), at(u1, t1), at(u1, t1, -THICK), at(u0, t1, -THICK), s.cols[s.rim]);
    }
  }
  s.extra?.(b, at, s);
  return b.done();
}

// ------------------------------------------------------------------ carpets

interface CarpetSpec {
  name: string;
  note: string;
  w: number;
  len: number;
  cols: V3[];
  /** Colour index of the weave at cell (i across of CX, j along of CZ, tail first). -1 leaves a hole. */
  weave(i: number, j: number): number;
  /** Length of the fringe at each end, and its colour index. */
  fringe?: [number, number];
  /** Colour index of a tassel at each corner. */
  tassel?: number;
}

const CX = 12;
const CZ = 20;
const edge = (i: number, j: number) => Math.min(i, CX - 1 - i, j, CZ - 1 - j); // cells in from the border
const diamond = (i: number, j: number, ci: number, cj: number) => Math.abs(i - ci) + Math.abs(j - cj);

const CARPET_SPECS: CarpetSpec[] = [
  {
    name: 'Runner',
    note: 'Long and narrow: a red field, a navy band, a gold edge.',
    w: 1.25,
    len: 2.6,
    cols: [RED, GOLD, NAVY],
    weave: (i, j) => {
      const e = edge(i, j);
      if (e === 0) return 1;
      if (e === 1) return 2;
      return (i === 5 || i === 6) && j % 4 === 1 ? 1 : 0;
    },
  },
  {
    name: 'Square',
    note: 'Teal with a sand border and one diamond in the middle.',
    w: 1.9,
    len: 1.9,
    cols: [TEAL, SAND, DARK],
    weave: (i, j) => {
      const e = edge(i, j);
      if (e === 0) return 1;
      const d = diamond(i * 2 + 1, (j * 12) / 10 + 0.6, 12, 12);
      return d < 4 ? 1 : d < 6.5 ? 2 : 0;
    },
  },
  {
    name: 'Kilim',
    note: 'Bands of ochre, red and navy, straight across.',
    w: 1.5,
    len: 2.4,
    cols: [OCHRE, RED, NAVY],
    weave: (_i, j) => [0, 0, 1, 2, 1][j % 5],
  },
  {
    name: 'Fringed',
    note: 'Undyed, with blue chevrons and a long fringe at both ends.',
    w: 1.5,
    len: 2.2,
    cols: [SAND, BLUE, DARK],
    weave: (i, j) => ((j + Math.abs(i - 5.5) + 0.5) % 5 < 1 ? 1 : 0),
    fringe: [0.2, 0],
  },
  {
    name: 'Lattice',
    note: 'Navy, crossed with a lattice of gold diamonds.',
    w: 1.6,
    len: 2.4,
    cols: [NAVY, GOLD, RED],
    weave: (i, j) => {
      if (edge(i, j) === 0) return 2;
      return (i + j) % 4 === 0 || (i - j + 40) % 4 === 0 ? 1 : 0;
    },
  },
  {
    name: 'Tasselled',
    note: 'Mauve inside a dark border, a tassel at each corner.',
    w: 1.7,
    len: 2.1,
    cols: [MAUVE, DARK, GOLD],
    weave: (i, j) => {
      const e = edge(i, j);
      return e === 0 ? 1 : e === 2 ? 2 : 0;
    },
    tassel: 2,
  },
  {
    name: 'Checker',
    note: 'Green and sand checks with a red edge.',
    w: 1.5,
    len: 2.2,
    cols: [GREEN, SAND, RED],
    weave: (i, j) => (edge(i, j) === 0 ? 2 : (Math.floor(i / 2) + Math.floor(j / 2)) % 2),
  },
  {
    name: 'Sun',
    note: 'Night blue with a gold sun woven into the middle.',
    w: 1.8,
    len: 2.2,
    cols: [NAVY, GOLD, OCHRE],
    weave: (i, j) => {
      const dx = (i - 5.5) * 1.5;
      const dz = (j - 9.5) * 1.1;
      const r = Math.hypot(dx, dz);
      if (r < 3) return 1;
      if (r < 6.2 && Math.floor((Math.atan2(dz, dx) / Math.PI) * 6 + 12) % 2 === 0) return 2;
      return edge(i, j) === 0 ? 2 : 0;
    },
  },
  {
    name: 'Rag',
    note: 'Plain sand cloth, frayed at the ends, one red stripe.',
    w: 1.4,
    len: 2.3,
    cols: [SAND, RED, PALE],
    weave: (i, j) => {
      if ((j === 0 && i % 3 !== 1) || (j === CZ - 1 && i % 4 === 2) || (j === 1 && i % 5 === 3)) return -1;
      return j === 14 ? 1 : (i * 7 + j * 3) % 11 === 0 ? 2 : 0;
    },
  },
  {
    name: 'Banner',
    note: 'A long red pennant with a forked tail and gold teeth.',
    w: 1.4,
    len: 2.8,
    cols: [RED, GOLD, DARK],
    weave: (i, j) => {
      if (j < 5 && Math.abs(i - 5.5) < 5 - j) return -1;
      const side = Math.min(i, CX - 1 - i);
      if (side === 0) return j % 2 ? 1 : 2;
      return j === CZ - 1 || j === CZ - 3 ? 1 : 0;
    },
  },
];

function buildCarpet(s: CarpetSpec): THREE.BufferGeometry {
  const b = new Build();
  const x = (i: number) => (i / CX - 0.5) * s.w;
  const z = (j: number) => (j / CZ - 0.5) * s.len;
  for (let j = 0; j < CZ; j++) {
    for (let i = 0; i < CX; i++) {
      const c = s.weave(i, j);
      if (c < 0) continue;
      b.quad([x(i), 0, z(j)], [x(i + 1), 0, z(j)], [x(i + 1), 0, z(j + 1)], [x(i), 0, z(j + 1)], s.cols[c]);
    }
  }
  if (s.fringe) {
    const [f, c] = s.fringe;
    for (let i = 0; i < CX * 2; i += 2) {
      const x0 = (i / (CX * 2) - 0.5) * s.w;
      const x1 = ((i + 1) / (CX * 2) - 0.5) * s.w;
      for (const sgn of [-1, 1]) {
        const z0 = (sgn * s.len) / 2;
        b.quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z0 + sgn * f], [x0, 0, z0 + sgn * f], mul(s.cols[c], 0.92));
      }
    }
  }
  if (s.tassel !== undefined) {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cx = (sx * s.w) / 2;
        const cz = (sz * s.len) / 2;
        b.tri([cx, 0, cz], [cx + sx * 0.16, 0, cz + sz * 0.05], [cx + sx * 0.05, 0, cz + sz * 0.16], s.cols[s.tassel]);
        b.tri([cx + sx * 0.08, 0, cz + sz * 0.08], [cx + sx * 0.3, 0, cz + sz * 0.2], [cx + sx * 0.2, 0, cz + sz * 0.3], s.cols[s.tassel]);
      }
    }
  }
  return b.done();
}

/** The carpet rolled up and strapped: its own weave wrapped round the bundle, folded once to shorten it. */
function buildRoll(s: CarpetSpec): THREE.BufferGeometry {
  const b = new Build();
  const L = Math.min(0.78, s.w * 0.46);
  const R = 0.07 + s.len * 0.006;
  const SIDES = 8;
  const pt = (i: number, k: number, r: number): V3 => {
    const a = (k / SIDES) * Math.PI * 2;
    return [(i / CX - 0.5) * L, Math.cos(a) * r, Math.sin(a) * r];
  };
  for (let i = 0; i < CX; i++) {
    for (let k = 0; k < SIDES; k++) {
      let c = s.weave(i, k);
      if (c < 0) c = 0;
      b.quad(pt(i, k, R), pt(i + 1, k, R), pt(i + 1, k + 1, R), pt(i, k + 1, R), s.cols[c]);
    }
  }
  // the ends: the layers of the roll, seen edge on
  for (const i of [0, CX]) {
    for (let k = 0; k < SIDES; k++) {
      b.quad(pt(i, k, R), pt(i, k + 1, R), pt(i, k + 1, R * 0.5), pt(i, k, R * 0.5), mul(s.cols[1 % s.cols.length], 0.85));
      b.tri(pt(i, k, R * 0.5), pt(i, k + 1, R * 0.5), [pt(i, 0, 0)[0], 0, 0], mul(s.cols[0], 0.8));
    }
  }
  // two straps
  for (const sx of [-0.28, 0.28]) {
    const x0 = sx * L - 0.012;
    const x1 = sx * L + 0.012;
    for (let k = 0; k < SIDES; k++) {
      const a0 = (k / SIDES) * Math.PI * 2;
      const a1 = ((k + 1) / SIDES) * Math.PI * 2;
      const r = R + 0.006;
      b.quad([x0, Math.cos(a0) * r, Math.sin(a0) * r], [x1, Math.cos(a0) * r, Math.sin(a0) * r], [x1, Math.cos(a1) * r, Math.sin(a1) * r], [x0, Math.cos(a1) * r, Math.sin(a1) * r], DARK);
    }
  }
  return b.done();
}

// ------------------------------------------------------------------ picks

interface PickSpec {
  name: string;
  note: string;
  build(b: Build): void;
}

const HANDLE = 0.4; // grip to head, about a forearm
const handle = (b: Build, col: V3, len = HANDLE, r = 0.016) => b.tube([[0, 0, 0], [0, len * 0.5, 0], [0, len, 0]], [r * 1.15, r, r * 1.1], 5, col);
const wrap = (b: Build, y0: number, y1: number, col: V3, r = 0.022) => b.tube([[0, y0, 0], [0, y1, 0]], [r, r], 5, col);

const PICK_SPECS: PickSpec[] = [
  {
    name: 'Spike',
    note: 'One curved iron spike on a wooden handle.',
    build(b) {
      handle(b, BROWN);
      b.tube([[0, HANDLE - 0.01, -0.03], [0, HANDLE + 0.02, 0.06], [0, HANDLE - 0.02, 0.16], [0, HANDLE - 0.08, 0.22]], [0.022, 0.02, 0.013, 0.002], 4, IRON, Math.PI / 4);
    },
  },
  {
    name: 'Pick',
    note: 'The plain two-ended pick, small enough for one hand.',
    build(b) {
      handle(b, PALE);
      b.tube([[0, HANDLE - 0.06, -0.18], [0, HANDLE - 0.01, -0.09], [0, HANDLE + 0.01, 0], [0, HANDLE - 0.01, 0.09], [0, HANDLE - 0.06, 0.18]], [0.002, 0.014, 0.022, 0.014, 0.002], 4, IRON, Math.PI / 4);
    },
  },
  {
    name: 'Adze',
    note: 'A flat blade set across the handle, for shaving sand away.',
    build(b) {
      handle(b, BROWN);
      wrap(b, HANDLE - 0.05, HANDLE + 0.01, DARK, 0.024);
      b.tube([[0, HANDLE, 0], [0, HANDLE - 0.02, 0.09], [0, HANDLE - 0.09, 0.15]], [0.02, 0.03, 0.045], 4, IRON, Math.PI / 4, [1.5, 0.22]);
    },
  },
  {
    name: 'Claw',
    note: 'Two hooked prongs, like a bird foot.',
    build(b) {
      handle(b, DARK);
      wrap(b, 0.02, 0.13, RED);
      for (const sx of [-1, 1]) {
        b.tube([[0, HANDLE - 0.01, 0], [sx * 0.03, HANDLE + 0.03, 0.07], [sx * 0.04, HANDLE - 0.02, 0.15], [sx * 0.035, HANDLE - 0.09, 0.17]], [0.016, 0.014, 0.01, 0.002], 4, IRON, Math.PI / 4);
      }
    },
  },
  {
    name: 'Trowel',
    note: 'A leaf blade in line with the handle.',
    build(b) {
      handle(b, PALE, 0.26);
      wrap(b, 0.22, 0.28, GOLD, 0.021);
      b.tube([[0, 0.27, 0], [0, 0.33, 0.01], [0, 0.42, 0.015], [0, 0.5, 0.005]], [0.012, 0.045, 0.04, 0.003], 4, IRON, Math.PI / 4, [1, 0.18]);
    },
  },
  {
    name: 'Fork',
    note: 'Three prongs for loosening packed ground.',
    build(b) {
      handle(b, BROWN, 0.3);
      b.box([0, 0.31, 0], [0.11, 0.022, 0.022], IRON);
      for (const sx of [-1, 0, 1]) b.tube([[sx * 0.045, 0.31, 0], [sx * 0.045, 0.4, 0.015], [sx * 0.045, 0.48, 0.005]], [0.01, 0.009, 0.002], 4, IRON, Math.PI / 4);
    },
  },
  {
    name: 'Bone pick',
    note: 'A stone point lashed to a long bone with red cord.',
    build(b) {
      b.tube([[0, 0, 0], [0, 0.03, 0], [0, HANDLE * 0.5, 0], [0, HANDLE - 0.02, 0], [0, HANDLE + 0.02, 0]], [0.026, 0.017, 0.014, 0.018, 0.027], 5, BONE);
      b.tube([[0, HANDLE - 0.02, -0.05], [0, HANDLE - 0.01, 0.03], [0, HANDLE - 0.07, 0.17]], [0.02, 0.027, 0.003], 4, STONE, Math.PI / 4, [0.7, 1]);
      wrap(b, HANDLE - 0.055, HANDLE - 0.02, RED, 0.03);
    },
  },
  {
    name: 'Hammer',
    note: 'A spike one side, a square hammer the other, a gold grip.',
    build(b) {
      handle(b, DARK);
      wrap(b, 0.02, 0.15, GOLD);
      b.box([0, HANDLE, -0.045], [0.05, 0.05, 0.07], IRON);
      b.tube([[0, HANDLE, 0], [0, HANDLE, 0.07], [0, HANDLE - 0.04, 0.17]], [0.024, 0.018, 0.002], 4, IRON, Math.PI / 4);
    },
  },
  {
    name: 'Sickle',
    note: 'A crescent blade that hooks and pulls.',
    build(b) {
      handle(b, BROWN, 0.3);
      const pts: V3[] = [];
      const rad: number[] = [];
      for (let k = 0; k <= 6; k++) {
        const a = -0.5 + (k / 6) * 3.0;
        pts.push([0, 0.39 + Math.sin(a) * 0.1, 0.02 + (1 - Math.cos(a)) * 0.1]);
        rad.push(0.004 + 0.026 * Math.sin((k / 6) * Math.PI));
      }
      b.tube(pts, rad, 4, IRON, Math.PI / 4, [0.2, 1]);
    },
  },
  {
    name: 'Wedge',
    note: 'A lump of stone bound to a stick. The oldest tool there is.',
    build(b) {
      handle(b, BROWN, HANDLE, 0.018);
      b.tube([[0, HANDLE - 0.07, -0.05], [0, HANDLE - 0.01, -0.02], [0, HANDLE + 0.02, 0.06], [0, HANDLE - 0.03, 0.14]], [0.03, 0.05, 0.04, 0.004], 5, STONE, 0.3, [0.75, 1]);
      wrap(b, HANDLE - 0.09, HANDLE - 0.055, SAND, 0.027);
      wrap(b, HANDLE - 0.035, HANDLE - 0.01, SAND, 0.03);
    },
  },
];

// ------------------------------------------------------------------ public

export interface Design {
  name: string;
  note: string;
}

export const BOARDS: Design[] = BOARD_SPECS;
export const CARPETS: Design[] = CARPET_SPECS;
export const PICKS: Design[] = PICK_SPECS;

const pickOf = <T,>(list: T[], i: number): T => list[Math.max(0, Math.min(list.length - 1, i | 0))];

export const boardGeometry = (i: number): THREE.BufferGeometry => buildBoard(pickOf(BOARD_SPECS, i));
/** The carpet laid flat, and how long it is (the ripple runs along its length). */
export const carpetGeometry = (i: number): { geo: THREE.BufferGeometry; len: number } => {
  const s = pickOf(CARPET_SPECS, i);
  return { geo: buildCarpet(s), len: s.len + (s.fringe ? s.fringe[0] * 2 : 0) };
};
export const rollGeometry = (i: number): THREE.BufferGeometry => buildRoll(pickOf(CARPET_SPECS, i));
export const pickGeometry = (i: number): THREE.BufferGeometry => {
  const b = new Build();
  pickOf(PICK_SPECS, i).build(b);
  return b.done().scale(1.2, 1.2, 1.2); // a little larger than life, so it reads on the back
};

// ------------------------------------------------------------------ small things carried

/** A miner's lamp, hanging from the top of its ring: iron frame, horn panes. */
export const lampGeometry = (): THREE.BufferGeometry => {
  const b = new Build();
  const pane: V3 = [1.0, 0.84, 0.5];
  b.tube([[-0.03, -0.01, 0], [-0.03, 0.03, 0], [0.03, 0.03, 0], [0.03, -0.01, 0]], [0.006, 0.006, 0.006, 0.006], 4, IRON);
  b.tube([[0, -0.01, 0], [0, -0.05, 0]], [0.05, 0.062], 4, IRON, Math.PI / 4);
  b.box([0, -0.105, 0], [0.07, 0.11, 0.07], pane);
  b.box([0, -0.17, 0], [0.095, 0.022, 0.095], IRON);
  for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.box([x * 0.038, -0.105, z * 0.038], [0.012, 0.11, 0.012], DARK);
  return b.done();
};

/** The wanderer's trim: closed bands worn round the figure, each by height, radius, front-to-back squash and thickness. */
export const trimGeometry = (bands: { y: number; r: number; flat: number; w: number; col: V3; arc?: number }[]): THREE.BufferGeometry => {
  const b = new Build();
  const N = 28;
  for (const { y, r, flat, w, col, arc = Math.PI } of bands) {
    const ring: V3[] = [];
    for (let i = 0; i <= N; i++) {
      const a = ((i / N) * 2 - 1) * arc;
      ring.push([Math.sin(a) * r, y, Math.cos(a) * r * flat]);
    }
    b.tube(ring, ring.map(() => w), 4, col, Math.PI / 4, [1, 0.55]);
  }
  return b.done();
};
export const TRIM = { sash: OCHRE, scarf: [0.72, 0.4, 0.24] as V3 };

/** A relic from under the sand: two crossed spindles of old gold, hung by its middle. */
export const relicGeometry = (): THREE.BufferGeometry => {
  const b = new Build();
  const gold: V3 = [0.98, 0.74, 0.3];
  b.tube([[0, -0.11, 0], [0, 0, 0], [0, 0.11, 0]], [0.002, 0.05, 0.002], 4, gold);
  b.tube([[-0.085, 0, 0], [0, 0, 0], [0.085, 0, 0]], [0.002, 0.04, 0.002], 4, mul(gold, 0.85));
  return b.done();
};

/** The miner's heap: a low pile of broken stone, sorted by an eye nobody else has. Sits on the ground at y = 0. */
export const heapGeometry = (): THREE.BufferGeometry => {
  const b = new Build();
  // (fixed, not random: every miner's heap is the same heap)
  const stones: Array<[number, number, number, number, number]> = [
    [0, 0, 0.2, 0.17, 0.3], [0.26, 0.05, 0.16, 0.13, 1.1], [-0.22, 0.1, 0.15, 0.12, 2.0], [0.08, 0.27, 0.14, 0.12, 0.7],
    [-0.1, -0.24, 0.15, 0.1, 2.6], [0.3, -0.2, 0.11, 0.09, 1.7], [0.04, 0.03, 0.13, 0.3, 0.9], [-0.33, -0.12, 0.09, 0.07, 0.2],
    [0.42, 0.2, 0.08, 0.06, 2.2],
  ];
  stones.forEach(([x, z, r, top, rot], i) => {
    const col = mul(i % 3 === 0 ? SAND : STONE, 0.8 + 0.12 * (i % 4));
    const y0 = i === 6 ? 0.17 : 0;
    b.tube([[x, y0, z], [x + 0.02, y0 + (top - y0) * 0.6, z], [x + 0.03, top, z + 0.02]], [r, r * 0.9, r * 0.45], 5, col, rot, [1, 0.8]);
  });
  return b.done();
};

// ------------------------------------------------------------------ tools found later

/** A spyglass, closed: three brass draws along the y axis, eyepiece at the origin, bound in dark leather. */
export const spyglassGeometry = (): THREE.BufferGeometry => {
  const b = new Build();
  const brass: V3 = [0.74, 0.56, 0.24];
  b.tube([[0, 0, 0], [0, 0.085, 0]], [0.017, 0.019], 6, mul(brass, 0.82));
  b.tube([[0, 0.085, 0], [0, 0.2, 0]], [0.025, 0.027], 6, DARK);
  b.tube([[0, 0.2, 0], [0, 0.27, 0]], [0.031, 0.033], 6, brass);
  b.tube([[0, -0.006, 0], [0, 0.008, 0]], [0.022, 0.022], 6, brass);
  b.tube([[0, 0.262, 0], [0, 0.276, 0]], [0.037, 0.037], 6, mul(brass, 1.12));
  return b.done();
};

/** A reed flute: a pale cane along the y axis, mouth at the top, bound in red thread at the joints. */
export const fluteGeometry = (): THREE.BufferGeometry => {
  const b = new Build();
  b.tube([[0, 0, 0], [0, 0.4, 0]], [0.0125, 0.0105], 5, PALE);
  for (const y of [0.05, 0.19, 0.33]) b.tube([[0, y, 0], [0, y + 0.022, 0]], [0.0155, 0.0155], 5, RED);
  // the finger holes, as dark flecks down the front
  for (let i = 0; i < 4; i++) b.box([0, 0.085 + i * 0.03, 0.0115], [0.007, 0.009, 0.004], DARK);
  return b.done();
};

/** A bedroll, rolled: undyed wool lying along x, centred, with two red straps and the darker lining showing at the ends. */
export const bedrollGeometry = (): THREE.BufferGeometry => {
  const b = new Build();
  const wool: V3 = [0.74, 0.68, 0.56];
  const L = 0.25;
  b.tube([[-L, 0, 0], [-L + 0.03, 0, 0], [L - 0.03, 0, 0], [L, 0, 0]], [0.062, 0.074, 0.074, 0.062], 8, wool);
  for (const x of [-0.13, 0.13]) b.tube([[x - 0.013, 0, 0], [x + 0.013, 0, 0]], [0.079, 0.079], 8, RED);
  for (const sx of [-1, 1]) b.tube([[sx * (L + 0.001), 0, 0], [sx * (L + 0.004), 0, 0]], [0.04, 0.04], 6, BROWN);
  return b.done();
};

/**
 * The bedroll laid out on the ground at y = 0: head toward +z, a pillow roll at the head and
 * the blanket turned back at one corner.
 */
export const bedGeometry = (): THREE.BufferGeometry => {
  const b = new Build();
  const wool: V3 = [0.74, 0.68, 0.56];
  const W = 0.38;
  const L = 0.95;
  // the mat, a little proud of the sand, and the blanket over its lower two thirds
  b.box([0, 0.02, 0], [W * 2, 0.04, L * 2], BROWN);
  b.box([0, 0.055, -0.28], [W * 2 - 0.04, 0.035, L * 2 - 0.62], wool);
  for (const z of [-0.78, -0.2]) b.box([0, 0.075, z], [W * 2 - 0.035, 0.008, 0.05], RED);
  // the corner turned back
  b.quad([W - 0.02, 0.075, 0.03], [W - 0.34, 0.075, 0.03], [W - 0.02, 0.085, -0.3], [W - 0.02, 0.085, -0.3], mul(wool, 0.8));
  b.tube([[-W + 0.06, 0.1, L - 0.14], [W - 0.06, 0.1, L - 0.14]], [0.075, 0.075], 7, mul(wool, 1.08));
  return b.done();
};

/** The hearth beside a laid bedroll, on the ground at y = 0: a ring of stones round a few charred sticks. */
export const hearthGeometry = (): THREE.BufferGeometry => {
  const b = new Build();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    const r = 0.085 + 0.02 * ((i * 5) % 3);
    b.tube([[Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3], [Math.cos(a) * 0.3, r * 1.1, Math.sin(a) * 0.3]], [r, r * 0.6], 5, mul(i % 2 ? STONE : SAND, 0.7 + 0.08 * (i % 3)), a);
  }
  const char: V3 = [0.1, 0.085, 0.08];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI + 0.4;
    b.tube([[Math.cos(a) * 0.2, 0.03, Math.sin(a) * 0.2], [-Math.cos(a) * 0.14, 0.11, -Math.sin(a) * 0.14]], [0.026, 0.02], 4, i === 2 ? BROWN : char);
  }
  return b.done();
};

/**
 * A dowsing rod: a forked twig. The tip points toward +z and the two grips come back to
 * either hand, so it is held level out in front and dips about the grips (the origin).
 */
export const rodGeometry = (): THREE.BufferGeometry => {
  const b = new Build();
  const fork: V3 = [0, 0, 0.17];
  b.tube([fork, [0, 0.004, 0.27], [0, 0, 0.36]], [0.012, 0.01, 0.005], 5, BROWN);
  for (const sx of [-1, 1]) {
    b.tube([fork, [sx * 0.05, 0, 0.09], [sx * 0.095, 0, 0]], [0.011, 0.0105, 0.01], 5, BROWN);
    b.tube([[sx * 0.095, 0, 0], [sx * 0.1, 0, -0.012]], [0.0102, 0.0102], 5, BONE); // the cut ends
  }
  return b.done();
};

/** A star chart in its case: a blue tube along the y axis, centred, capped in brass. */
export const chartGeometry = (): THREE.BufferGeometry => {
  const b = new Build();
  b.tube([[0, -0.13, 0], [0, 0.13, 0]], [0.028, 0.028], 6, NAVY);
  for (const y of [-0.13, 0.115]) b.tube([[0, y, 0], [0, y + 0.018, 0]], [0.033, 0.033], 6, GOLD);
  b.tube([[0, -0.045, 0], [0, -0.035, 0]], [0.0305, 0.0305], 6, GOLD);
  b.tube([[0, 0.035, 0], [0, 0.045, 0]], [0.0305, 0.0305], 6, GOLD);
  return b.done();
};

/**
 * A rope and hook: a coil lying flat on the ground at y = 0, centred, with an iron
 * three-pronged hook resting across it.
 */
export const ropeCoilGeometry = (): THREE.BufferGeometry => {
  const b = new Build();
  const hemp: V3 = [0.7, 0.6, 0.42];
  const N = 12;
  // three turns, each a touch smaller and not quite over the last
  [[0.17, 0.022, 0.0], [0.158, 0.058, 0.9], [0.164, 0.094, 1.9]].forEach(([r, y, ph], k) => {
    const ring: V3[] = [];
    for (let i = 0; i <= N; i++) {
      const a = ph + (i / N) * Math.PI * 2;
      ring.push([Math.cos(a) * r + (k === 1 ? 0.012 : 0), y, Math.sin(a) * r]);
    }
    b.tube(ring, ring.map(() => 0.021), 4, mul(hemp, 0.9 + 0.08 * k), Math.PI / 4);
  });
  // the loose end, run out over the side to the hook
  b.tube([[0.15, 0.094, 0.07], [0.2, 0.07, 0.11], [0.24, 0.03, 0.12]], [0.021, 0.021, 0.021], 4, hemp, Math.PI / 4);
  // the hook: a shank and three prongs curling back
  const hx = 0.25;
  const hz = 0.12;
  b.tube([[hx, 0.03, hz], [hx + 0.13, 0.03, hz + 0.03]], [0.012, 0.012], 4, IRON);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const oy = Math.cos(a) * 0.055;
    const oz = Math.sin(a) * 0.055;
    b.tube([[hx + 0.13, 0.03, hz + 0.03], [hx + 0.165, 0.03 + oy * 0.7, hz + 0.038 + oz * 0.7], [hx + 0.13, 0.03 + oy, hz + 0.03 + oz], [hx + 0.095, 0.03 + oy * 0.95, hz + 0.022 + oz * 0.95]], [0.011, 0.01, 0.008, 0.003], 4, IRON);
  }
  return b.done();
};

// ------------------------------------------------------------------ material

const solidVert = /* glsl */ `
attribute vec3 aCol;
varying vec3 vW;
varying vec3 vN;
varying vec3 vCol;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vCol = aCol;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// A carpet in the air: it ripples from nose to tail, faster and deeper with speed.
const rugVert = /* glsl */ `
attribute vec3 aCol;
uniform float uTime;
uniform float uRug;    // 0 hanging in the air .. 1 at full speed
uniform float uRugLen; // length of the carpet, metres
varying vec3 vW;
varying vec3 vN;
varying vec3 vCol;
void main() {
  vec3 p = position;
  float tail = clamp(0.5 - p.z / uRugLen, 0.0, 1.0);   // 0 at the nose .. 1 at the tail
  float side = abs(p.x) / 0.8;
  float t = uTime * (3.5 + uRug * 5.0);
  float amp = 0.035 * (0.35 + tail) * (0.6 + uRug);
  float ph = p.z * 3.2 + t;
  p.y += sin(ph) * amp;
  // the long edges flap a little on their own, and the corners at the tail lift
  p.y += side * side * (0.03 * sin(t * 0.6 + p.z * 2.0) + 0.05 * tail * uRug);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, -cos(ph) * 3.2 * amp));
  vCol = aCol;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// Lit the way the travellers' gear is (see bodyFrag in caravans.ts), so it sits in the same light.
const frag = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uNight;
uniform float uUnder;  // how dark the underside is, for cloth seen from below
uniform float uDeepDark; // 0 under the sky .. 1 down in a deep, out of the daylight
uniform vec4 uCavGlow;   // the lamp that matters most down there: position, reach (0 = none)
uniform vec3 uCavGlowCol;
varying vec3 vW;
varying vec3 vN;
varying vec3 vCol;
${STYLE_GLSL}
void main() {
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 n = normalize(vN);
  // Turn the normal to the viewer. A carpet's normal always points up out of its weave, so
  // one seen from below is its underside, and that is darker.
  float face = 1.0;
  if (dot(n, V) < 0.0) {
    n = -n;
    face = uUnder;
  }
  n = styleFacet(n, vW);
  float ndl = dot(n, uSunDir);
  float l = styleBands(smoothstep(-0.35, 0.75, ndl), vW.xz);
  float bright = clamp(uLit.g * 1.25, 0.12, 1.0);
  vec3 tint = mix(vec3(1.0), uLit / max(uLit.g, 0.02), 0.35);
  vec3 lit = vCol * tint * bright * face;
  vec3 ratio = clamp(uShade / max(uLit, vec3(0.03)), 0.3, 0.85);
  vec3 col = mix(lit * ratio, lit, l);
  col += vCol * vec3(0.10, 0.13, 0.19) * uNight;
  col *= 0.9 + 0.1 * n.y;
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * smoothstep(-0.2, 0.3, ndl);
  col += uSunCol * rim * 0.1 * (1.0 - 0.5 * uNight);
  if (uDeepDark > 0.0) {
    // underground: nearly black, lit only by what glows there (as the figure carrying it is)
    vec3 lit = vec3(0.0);
    if (uCavGlow.w > 0.0) {
      vec3 gd = uCavGlow.xyz - vW;
      float g2 = dot(gd, gd);
      float ga = 1.0 / (1.0 + g2 / (0.16 * uCavGlow.w * uCavGlow.w));
      lit = uCavGlowCol * vCol * (0.85 * ga * (0.45 + 0.55 * max(dot(n, gd * inversesqrt(g2 + 1e-3)), 0.0)));
    }
    col = mix(col, col * 0.2 + lit, uDeepDark);
  }
  col = mix(col, uFogCol, (1.0 - exp(-dist * uFog)) * (1.0 - uDeepDark));
  gl_FragColor = vec4(col, 1.0);
}
`;

/** The material for boards, picks and rolled carpets. */
export function solidMaterial(u: Uniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ uniforms: { ...u, uUnder: { value: 1 } }, vertexShader: solidVert, fragmentShader: frag, side: THREE.DoubleSide });
}

/** The material for a carpet in flight. `speed` is 0..1 and `len` the carpet's length; both are read every frame. */
export function rugMaterial(u: Uniforms, speed: THREE.IUniform, len: THREE.IUniform): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uUnder: { value: 0.6 }, uRug: speed, uRugLen: len },
    vertexShader: rugVert,
    fragmentShader: frag,
    side: THREE.DoubleSide,
  });
}
