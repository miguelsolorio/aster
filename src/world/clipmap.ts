// Geometry clipmap: 8 nested square grids of 128x128 cells, 0.5 m .. 64 m per
// cell, displaced on the GPU by surface(). Each level snaps to twice its cell
// size so vertices never swim, and sits 0.04 cells lower than the next finer one
// to avoid z-fighting where they overlap (2 cells of the coarser level).
//
// Every level but the finest is a ring: it has no triangles where the next finer
// level draws. That hole moves by up to a cell within the coarser grid as the two
// levels snap, so the 2-cell frame round its smallest extent is drawn per cell:
// each of those cells has its own four vertices and drops itself (in the vertex
// shader) when the finer level covers it this frame. The result is the same set of
// triangles the old full grids drew minus those a fragment discard used to remove.
//
// Each level is cut into tiles (3x3, minus the hole) with world-space bounds, and
// tiles outside the view are not drawn.
import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import { terrainFrag, terrainVert } from '../render/terrainShaders';
import { detailTexture, detailTexture2 } from '../render/art';
import { MAX_TERRAIN_H } from './surface';

const LEVELS = 8;
const CELLS = 128;
const HALF = CELLS / 2;
const BASE_CELL = 0.5;
const OVERLAP_CELLS = 2; // in cells of the coarser level
const LOWER = 0.04; // x cell size
const LEVEL_UNIFORMS = new Set(['uLevelCenter', 'uCell', 'uLower', 'uInnerCenter', 'uInnerHalf']);
// Lowest ground the terrain can produce (m), with a wide margin: only for the tiles' bounds.
const MIN_TERRAIN_H = -400;

// The finer level covers |x| < INNER cells of this one, about a centre that is 0 or 1 cell off ours
// on each axis. Cells with lower corner in [-CORE, CORE - 1] are always covered; those in
// [-MID, MID - 1] may be. Tiles split each axis at +-MID.
const INNER = HALF / 2 - OVERLAP_CELLS; // 30
const CORE = INNER - 1; // 29
const MID = INNER + 1; // 31

// Shared holders this material reads that other systems may create later.
const SHARED_DEFAULTS: Array<[string, () => unknown]> = [
  ['uHeightMap', () => null],
  ['uRect', () => new THREE.Vector3()],
  ['uTexel', () => 4],
  ['uTrailNear', () => null],
  ['uTrailNearRect', () => new THREE.Vector3()],
  ['uTrailFar', () => null],
  ['uTrailFarRect', () => new THREE.Vector3()],
  ['uSeed', () => 0],
  // run-time quality knobs (game/quality.ts); these defaults are full quality
  ['uShadowSteps', () => 30],
  ['uDetail', () => 1],
  // baked close-up grain (render/art.ts)
  ['uDetailMap', () => detailTexture()],
  ['uDetailMap2', () => detailTexture2()],
];

/** A cell by its lower corner, in cells from the level centre (-HALF .. HALF - 1). */
type Cell = [number, number];

/**
 * Triangles for a set of cells, diagonals alternating exactly as in the full grid. Shared cells
 * share their vertices (y = 0); `own` cells get four of their own, with y = 1 + corner (x + 2 z),
 * so the vertex shader can find the cell's centre and drop it.
 */
function cellGeometry(shared: Cell[], own: Cell[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const at = new Map<number, number>();
  const vert = (x: number, z: number): number => {
    const key = (x + HALF) * (CELLS + 1) + (z + HALF);
    let v = at.get(key);
    if (v === undefined) {
      v = pos.length / 3;
      pos.push(x, 0, z);
      at.set(key, v);
    }
    return v;
  };
  const quad = (i: number, j: number, a: number, b: number, c: number, d: number) => {
    // a (i, j), b (i + 1, j), c (i, j + 1), d (i + 1, j + 1); counter-clockwise seen from +y
    if ((i + j) & 1) idx.push(a, c, d, a, d, b);
    else idx.push(a, c, b, b, c, d);
  };
  for (const [i, j] of shared) quad(i, j, vert(i, j), vert(i + 1, j), vert(i, j + 1), vert(i + 1, j + 1));
  for (const [i, j] of own) {
    const v = pos.length / 3;
    pos.push(i, 1, j, i + 1, 2, j, i, 3, j + 1, i + 1, 4, j + 1);
    quad(i, j, v, v + 1, v + 2, v + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9); // culled by Clipmap itself
  return geo;
}

export interface TileShape {
  geo: THREE.BufferGeometry;
  /** Cell bounds: x0..x1, z0..z1 (vertex coordinates, in cells from the level centre). */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  verts: number;
}

/**
 * The tiles of a level. A ring level splits each axis at -MID and MID into three spans and has
 * the eight tiles round the middle, each edge tile carrying the part of the hole's frame next to
 * it. The finest level, with the eye near its middle, is four quarters (fewer draw calls).
 */
export function tileShapes(ring: boolean): TileShape[] {
  const spans: Array<[number, number]> = ring
    ? [
        [-HALF, -MID],
        [-MID, MID],
        [MID, HALF],
      ]
    : [
        [-HALF, 0],
        [0, HALF],
      ];
  const core = (c: number) => c >= -CORE && c <= CORE - 1;
  const shapes: TileShape[] = [];
  for (let sj = 0; sj < spans.length; sj++) {
    for (let si = 0; si < spans.length; si++) {
      const [x0, x1] = spans[si];
      const [z0, z1] = spans[sj];
      const middle = si === 1 && sj === 1;
      if (ring && middle) continue;
      const shared: Cell[] = [];
      const own: Cell[] = [];
      for (let j = z0; j < z1; j++) for (let i = x0; i < x1; i++) shared.push([i, j]);
      if (ring && (si === 1 || sj === 1)) {
        // the frame cells of the middle span that lie on this edge's side
        for (let j = -MID; j < MID; j++) {
          for (let i = -MID; i < MID; i++) {
            if (core(i) && core(j)) continue;
            const side = i < -CORE ? 0 : i > CORE - 1 ? 2 : j < -CORE ? 3 : 4;
            const mine = side === 0 ? si === 0 : side === 2 ? si === 2 : side === 3 ? sj === 0 : sj === 2;
            if (mine) own.push([i, j]);
          }
        }
      }
      const geo = cellGeometry(shared, own);
      let bx0 = x0;
      let bx1 = x1;
      let bz0 = z0;
      let bz1 = z1;
      for (const [i, j] of own) {
        bx0 = Math.min(bx0, i);
        bx1 = Math.max(bx1, i + 1);
        bz0 = Math.min(bz0, j);
        bz1 = Math.max(bz1, j + 1);
      }
      shapes.push({ geo, x0: bx0, x1: bx1, z0: bz0, z1: bz1, verts: geo.getAttribute('position').count });
    }
  }
  return shapes;
}

interface Tile {
  shape: TileShape;
  mesh: THREE.Mesh;
}

interface Level {
  cell: number;
  lower: number;
  tiles: Tile[];
  mat: THREE.ShaderMaterial;
  center: THREE.Vector2; // uLevelCenter value
  inner: THREE.Vector2; // uInnerCenter value
}

export class Clipmap {
  readonly group = new THREE.Group();
  private readonly shared: Uniforms;
  private readonly levels: Level[] = [];
  private drawn = LEVELS;
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private tilesDrawn = 0;
  private vertsDrawn = 0;

  constructor(uniforms: Uniforms) {
    this.shared = uniforms;
    for (const [name, make] of SHARED_DEFAULTS) {
      if (!uniforms[name]) uniforms[name] = { value: make() };
    }
    const full = tileShapes(false);
    const ring = tileShapes(true);
    for (let l = 0; l < LEVELS; l++) {
      const cell = BASE_CELL * 2 ** l;
      const lower = l === 0 ? 0 : LOWER * cell;
      const center = new THREE.Vector2();
      const inner = new THREE.Vector2();
      const mat = new THREE.ShaderMaterial({
        vertexShader: terrainVert,
        fragmentShader: terrainFrag,
        uniforms: {
          ...uniforms, // same holder objects, by reference
          uLevelCenter: { value: center },
          uCell: { value: cell },
          uLower: { value: lower },
          uInnerCenter: { value: inner },
          uInnerHalf: { value: -1 },
        },
      });
      const tiles: Tile[] = [];
      for (const shape of l === 0 ? full : ring) {
        const mesh = new THREE.Mesh(shape.geo, mat);
        mesh.frustumCulled = false; // see update()
        mesh.renderOrder = l; // fine first: early depth rejects the coarse overlap
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        tiles.push({ shape, mesh });
      }
      this.levels.push({ cell, lower, tiles, mat, center, inner });
    }
    this.group.matrixAutoUpdate = false;
  }

  /** Draw only the finest `n` levels (1..8); the rest are hidden. View distance halves per level dropped. */
  setLevels(n: number): void {
    const k = Math.min(LEVELS, Math.max(1, Math.round(n) || LEVELS));
    this.drawn = k;
    for (let l = 0; l < LEVELS; l++) if (l >= k) for (const t of this.levels[l].tiles) t.mesh.visible = false;
  }

  /** How many levels are drawn. */
  get levelCount(): number {
    return this.drawn;
  }

  /** What the last update() left to draw: tiles (draw calls) and terrain vertices shaded per frame. */
  get stats(): { tiles: number; vertices: number } {
    return { tiles: this.tilesDrawn, vertices: this.vertsDrawn };
  }

  /**
   * Centre the levels on `focus`, and when `camera` is given (its matrices current) hide the
   * tiles outside its view. Without a camera every tile of a drawn level is shown.
   */
  update(focus: THREE.Vector3, camera?: THREE.Camera): void {
    if (camera) this.frustum.setFromProjectionMatrix(this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    this.tilesDrawn = 0;
    this.vertsDrawn = 0;
    for (let l = 0; l < LEVELS; l++) {
      const lv = this.levels[l];
      const snap = lv.cell * 2;
      lv.center.set(Math.floor(focus.x / snap + 0.5) * snap, Math.floor(focus.z / snap + 0.5) * snap);
      if (l > 0) {
        const fine = this.levels[l - 1];
        lv.inner.copy(fine.center);
        lv.mat.uniforms.uInnerHalf.value = HALF * fine.cell - OVERLAP_CELLS * lv.cell;
      }
      // Pick up shared holders added (or replaced) by other systems after construction.
      const mu = lv.mat.uniforms;
      for (const k in this.shared) {
        if (mu[k] !== this.shared[k] && !LEVEL_UNIFORMS.has(k)) mu[k] = this.shared[k];
      }
      const on = l < this.drawn;
      for (const t of lv.tiles) {
        let vis = on;
        if (vis && camera) {
          const s = t.shape;
          this.box.min.set(lv.center.x + s.x0 * lv.cell, MIN_TERRAIN_H - lv.lower, lv.center.y + s.z0 * lv.cell);
          this.box.max.set(lv.center.x + s.x1 * lv.cell, MAX_TERRAIN_H, lv.center.y + s.z1 * lv.cell);
          vis = this.frustum.intersectsBox(this.box);
        }
        t.mesh.visible = vis;
        if (vis) {
          this.tilesDrawn++;
          this.vertsDrawn += t.shape.verts;
        }
      }
    }
  }
}
