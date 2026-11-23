// Geometry clipmap: 8 nested square grids of 128x128 cells, 0.5 m .. 64 m per
// cell, displaced on the GPU by surface(). Each level snaps to twice its cell
// size so vertices never swim; coarser levels discard what the next finer level
// covers (minus a 2-cell overlap) and sit 0.04 cells lower to avoid z-fighting.
import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import { terrainFrag, terrainVert } from '../render/terrainShaders';
import { detailTexture, detailTexture2 } from '../render/art';

const LEVELS = 8;
const CELLS = 128;
const HALF = CELLS / 2;
const BASE_CELL = 0.5;
const OVERLAP_CELLS = 2; // in cells of the coarser level
const LOWER = 0.04; // x cell size
const LEVEL_UNIFORMS = new Set(['uLevelCenter', 'uCell', 'uLower', 'uInnerCenter', 'uInnerHalf']);

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

function gridGeometry(): THREE.BufferGeometry {
  const n = CELLS + 1;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      pos[k] = i - HALF;
      pos[k + 1] = 0;
      pos[k + 2] = j - HALF;
    }
  }
  const idx = new Uint32Array(CELLS * CELLS * 6);
  let t = 0;
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // counter-clockwise seen from +y; alternate the diagonal for symmetry
      if ((i + j) & 1) {
        idx[t++] = a; idx[t++] = c; idx[t++] = d;
        idx[t++] = a; idx[t++] = d; idx[t++] = b;
      } else {
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return geo;
}

interface Level {
  cell: number;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  center: THREE.Vector2; // uLevelCenter value
  inner: THREE.Vector2; // uInnerCenter value
}

export class Clipmap {
  readonly group = new THREE.Group();
  private readonly shared: Uniforms;
  private readonly levels: Level[] = [];
  private drawn = LEVELS;

  constructor(uniforms: Uniforms) {
    this.shared = uniforms;
    for (const [name, make] of SHARED_DEFAULTS) {
      if (!uniforms[name]) uniforms[name] = { value: make() };
    }
    const geo = gridGeometry();
    for (let l = 0; l < LEVELS; l++) {
      const cell = BASE_CELL * 2 ** l;
      const center = new THREE.Vector2();
      const inner = new THREE.Vector2();
      const mat = new THREE.ShaderMaterial({
        vertexShader: terrainVert,
        fragmentShader: terrainFrag,
        uniforms: {
          ...uniforms, // same holder objects, by reference
          uLevelCenter: { value: center },
          uCell: { value: cell },
          uLower: { value: l === 0 ? 0 : LOWER * cell },
          uInnerCenter: { value: inner },
          uInnerHalf: { value: -1 },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = l; // fine first: early depth rejects the coarse overlap
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.levels.push({ cell, mesh, mat, center, inner });
    }
    this.group.matrixAutoUpdate = false;
  }

  /** Draw only the finest `n` levels (1..8); the rest are hidden. View distance halves per level dropped. */
  setLevels(n: number): void {
    const k = Math.min(LEVELS, Math.max(1, Math.round(n) || LEVELS));
    this.drawn = k;
    for (let l = 0; l < LEVELS; l++) this.levels[l].mesh.visible = l < k;
  }

  /** How many levels are drawn. */
  get levelCount(): number {
    return this.drawn;
  }

  update(focus: THREE.Vector3): void {
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
    }
  }
}
