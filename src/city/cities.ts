import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import type { DesertWorld } from '../world/surface';
import { MAX_SITES } from './cityGlsl';
import { buildCity, type CityMeshes } from './build';
import { planCity } from './plan';
import type { CityPlan, CitySite } from './types';

const FAR_IN = 9000; // skyline appears (distance to the city's edge)
const FAR_OUT = 11000;
const NEAR_IN = 1500; // full buildings appear
const NEAR_OUT = 1800;
const REACH = 40; // metres inside the edge that counts as arriving

interface Loaded {
  site: CitySite;
  plan: CityPlan;
  meshes: CityMeshes;
  holder: THREE.Group;
  map: THREE.DataTexture | null;
  reached: boolean;
}

/**
 * Finds the cities around the player, shows each as a distant skyline or in full,
 * tells the terrain where to flatten, and answers "is there a roof here?" for the one you are in.
 */
export class Cities {
  readonly group = new THREE.Group();
  /** Fired once per city when the player first walks in. */
  onReach: ((site: CitySite) => void) | null = null;
  /** The city currently loaded in full, if any. */
  active: Loaded | null = null;

  private loaded = new Map<number, Loaded>();
  private reachedIds = new Set<number>();
  private sites: CitySite[] = [];
  private blank: THREE.DataTexture;
  private scanT = 0;

  constructor(
    private world: DesertWorld,
    private u: Uniforms,
  ) {
    this.blank = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.blank.needsUpdate = true;
    u.uCityA = { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector4()) };
    u.uCityB = { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector4()) };
    u.uCityC = { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector4()) };
    u.uCityMap = { value: this.blank };
    u.uCityRect = { value: new THREE.Vector4() };
    u.uCityGround = { value: 0 };
  }

  /** The nearest city to a point. */
  nearest(x: number, z: number): CitySite {
    return this.world.cities.near(x, z, this.sites)[0];
  }

  /** Tell the shaders which sites reshape the ground near this point. Call before the first terrain bake. */
  setFocus(x: number, z: number) {
    const near = this.world.cities.near(x, z, this.sites);
    const a = this.u.uCityA.value as THREE.Vector4[];
    const b = this.u.uCityB.value as THREE.Vector4[];
    const c = this.u.uCityC.value as THREE.Vector4[];
    for (let i = 0; i < MAX_SITES; i++) {
      const s = near[i];
      a[i].set(s.cx, s.cz, s.radius, s.groundY);
      b[i].set(s.phase1, s.phase2, s.falloff, 0);
      const t = this.tracks(s);
      c[i].set(t[0], t[1], 0, 0);
    }
  }

  private trackCache = new Map<number, [number, number]>();
  /** Bearings from a city toward its two nearest neighbours. */
  private tracks(s: CitySite): [number, number] {
    let t = this.trackCache.get(s.id);
    if (!t) {
      const n = this.world.cities.near(s.cx, s.cz, []);
      t = [Math.atan2(n[1].cz - s.cz, n[1].cx - s.cx), Math.atan2(n[2].cz - s.cz, n[2].cx - s.cx)];
      this.trackCache.set(s.id, t);
    }
    return t;
  }

  /** Absolute height of the roof over (x, z) in the loaded city, or -Infinity on open ground. */
  roofAt(x: number, z: number): number {
    const c = this.active;
    if (!c) return -Infinity;
    const s = c.site;
    const dx = x - s.cx;
    const dz = z - s.cz;
    const co = Math.cos(s.rot);
    const si = Math.sin(s.rot);
    const p = c.plan;
    const i = Math.floor(co * dx + si * dz + p.gridHalf);
    const j = Math.floor(-si * dx + co * dz + p.gridHalf);
    if (i < 0 || j < 0 || i >= p.gridSize || j >= p.gridSize) return -Infinity;
    const h = p.grid[j * p.gridSize + i];
    return h > 0 ? s.groundY + h : -Infinity;
  }

  private load(site: CitySite): Loaded {
    const plan = planCity(site);
    const meshes = buildCity(plan, this.u);
    const holder = new THREE.Group();
    holder.position.set(site.cx, site.groundY, site.cz);
    holder.rotation.y = -site.rot;
    holder.add(meshes.near, meshes.far);
    meshes.near.visible = false;
    this.group.add(holder);
    const entry: Loaded = { site, plan, meshes, holder, map: null, reached: this.reachedIds.has(site.id) };
    this.loaded.set(site.id, entry);
    return entry;
  }

  private roofMap(c: Loaded): THREE.DataTexture {
    if (c.map) return c.map;
    const { grid, gridSize } = c.plan;
    const data = new Uint8Array(gridSize * gridSize);
    for (let k = 0; k < data.length; k++) data[k] = Math.min(255, Math.round(grid[k] * 4));
    const tex = new THREE.DataTexture(data, gridSize, gridSize, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    c.map = tex;
    return tex;
  }

  update(dt: number, pos: THREE.Vector3) {
    this.setFocus(pos.x, pos.z);
    this.scanT -= dt;
    if (this.scanT > 0 && this.loaded.size > 0) {
      this.checkReach(pos);
      return;
    }
    this.scanT = 0.4;

    // Bring cities into range one at a time so a single frame never builds two.
    for (const site of this.sites) {
      const d = Math.hypot(site.cx - pos.x, site.cz - pos.z) - site.radius;
      if (d < FAR_IN && !this.loaded.has(site.id)) {
        this.load(site);
        break;
      }
    }
    // Every loaded city, wherever it is: drop the far ones, and choose skyline or full detail.
    for (const c of this.loaded.values()) {
      const site = c.site;
      const d = Math.hypot(site.cx - pos.x, site.cz - pos.z) - site.radius;
      if (d > FAR_OUT) {
        this.group.remove(c.holder);
        c.meshes.dispose();
        c.map?.dispose();
        this.loaded.delete(site.id);
        if (this.active === c) this.active = null;
        continue;
      }
      const near = c.meshes.near.visible ? d < NEAR_OUT : d < NEAR_IN;
      c.meshes.near.visible = near;
      c.meshes.far.visible = !near;
    }

    // The closest fully shown city casts building shadows and has roofs to stand on.
    let best: Loaded | null = null;
    let bestD = Infinity;
    for (const c of this.loaded.values()) {
      if (!c.meshes.near.visible) continue;
      const d = Math.hypot(c.site.cx - pos.x, c.site.cz - pos.z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    this.active = best;
    const rect = this.u.uCityRect.value as THREE.Vector4;
    if (best) {
      this.u.uCityMap.value = this.roofMap(best);
      rect.set(best.site.cx, best.site.cz, best.plan.gridHalf, best.site.rot);
      this.u.uCityGround.value = best.site.groundY;
    } else {
      this.u.uCityMap.value = this.blank;
      rect.set(0, 0, 0, 0);
    }
    this.checkReach(pos);
  }

  private checkReach(pos: THREE.Vector3) {
    const c = this.active;
    if (!c || c.reached) return;
    if (Math.hypot(c.site.cx - pos.x, c.site.cz - pos.z) < c.site.radius - REACH) {
      c.reached = true;
      this.reachedIds.add(c.site.id);
      this.onReach?.(c.site);
    }
  }
}
