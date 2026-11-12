// The massifs seen from afar. The clipmap draws the ground out to about 4 km; beyond that each
// massif in range gets a coarse mesh of its own, sampled from the same terrain function and
// shaded like the ground, so the peaks stay on the horizon.
import * as THREE from 'three';
import type { FrameState, SurfaceSample, Uniforms } from '../game/contract';
import { CITY_CELL } from '../city/placement';
import { massifFrag, massifVert } from '../render/terrainShaders';
import type { DesertWorld } from './surface';

const RINGS = 28;
const SEGS = 96;
const BUILD_R = 11500; // metres to the massif's centre (the camera's far plane is 14 km)
const DROP_R = 12500;
const SINK = 16; // metres the mesh sits below the true ground, so it never pokes through it
const SCAN_EVERY = 0.5;
/** Half-size of the square the full clipmap covers (m). */
const CLIP_REACH = 4096;

export class Massifs {
  readonly group = new THREE.Group();
  private readonly mat: THREE.ShaderMaterial;
  private readonly near = new THREE.Vector3();
  private readonly built = new Map<string, THREE.Mesh>();
  private scan = 0;

  constructor(
    private readonly world: DesertWorld,
    uniforms: Uniforms,
  ) {
    this.group.name = 'massifs';
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uNear: { value: this.near } },
      vertexShader: massifVert,
      fragmentShader: massifFrag,
    });
  }

  update(f: FrameState, clipLevels: number): void {
    const cam = f.camera.position;
    // The clipmap snaps to its grid, so leave a margin: a little overlap is hidden by the sink.
    const reach = CLIP_REACH / Math.pow(2, 8 - clipLevels);
    this.near.set(cam.x, cam.z, reach * 0.94);

    this.scan -= f.dt;
    if (this.scan > 0) return;
    this.scan = SCAN_EVERY;
    const px = f.player.pos.x;
    const pz = f.player.pos.z;
    for (const [key, mesh] of this.built) {
      if (Math.hypot(mesh.position.x - px, mesh.position.z - pz) < DROP_R) continue;
      mesh.geometry.dispose();
      this.group.remove(mesh);
      this.built.delete(key);
    }
    // Build the nearest missing one, one per scan.
    const gi0 = Math.round(px / CITY_CELL);
    const gj0 = Math.round(pz / CITY_CELL);
    const span = Math.ceil(BUILD_R / CITY_CELL);
    let best: { key: string; x: number; z: number; r: number } | null = null;
    let bestD = BUILD_R;
    for (let j = gj0 - span; j <= gj0 + span; j++) {
      for (let i = gi0 - span; i <= gi0 + span; i++) {
        const key = i + ',' + j;
        if (this.built.has(key)) continue;
        const m = this.world.massif(i, j);
        if (!m) continue;
        const d = Math.hypot(m.x - px, m.z - pz);
        if (d < bestD) {
          bestD = d;
          best = { key, x: m.x, z: m.z, r: m.r };
        }
      }
    }
    if (best) this.build(best.key, best.x, best.z, best.r);
  }

  private build(key: string, cx: number, cz: number, r: number): void {
    const n = 1 + RINGS * SEGS;
    const pos = new Float32Array(n * 3);
    const rock = new Float32Array(n);
    const s: SurfaceSample = { h: 0, rock: 0, salt: 0 };
    const put = (k: number, x: number, z: number) => {
      this.world.base(cx + x, cz + z, s);
      pos[k * 3] = x;
      pos[k * 3 + 1] = s.h - SINK;
      pos[k * 3 + 2] = z;
      rock[k] = s.rock;
    };
    put(0, 0, 0);
    const reach = r * 1.3;
    for (let i = 1; i <= RINGS; i++) {
      const rr = (i / RINGS) * reach;
      for (let k = 0; k < SEGS; k++) {
        const a = ((k + (i & 1) * 0.5) / SEGS) * Math.PI * 2;
        put(1 + (i - 1) * SEGS + k, Math.cos(a) * rr, Math.sin(a) * rr);
      }
    }
    const idx: number[] = [];
    for (let k = 0; k < SEGS; k++) idx.push(0, 1 + ((k + 1) % SEGS), 1 + k);
    for (let i = 1; i < RINGS; i++) {
      const a0 = 1 + (i - 1) * SEGS;
      const b0 = a0 + SEGS;
      for (let k = 0; k < SEGS; k++) {
        const k1 = (k + 1) % SEGS;
        idx.push(a0 + k, a0 + k1, b0 + k, a0 + k1, b0 + k1, b0 + k);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRock', new THREE.BufferAttribute(rock, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.position.set(cx, 0, cz);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.built.set(key, mesh);
  }
}
