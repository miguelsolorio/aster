import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import type { DesertWorld } from '../world/surface';
import { MAX_SITES } from './cityGlsl';
import { buildCity, type CityMeshes } from './build';
import { planCity } from './plan';
import type { CityKind, CityPlan, CitySite } from './types';
import type { FrameState } from '../game/contract';
import { EMITTER_KINDS, SolidIndex, createExtraCtx, type EmitterKind, type Extra, type ExtraCtx } from './extras';
import { EXTRAS } from './extrasList';
import { WORLD_SCALE } from '../world/scale';
import { RouteNet } from './routes';
import { Interiors } from './interiors';
import { ceilOf, storeyAt } from './furnish';
import { depthIn, roomAt, shellCeil, shellSolid, shellTop } from './rooms';
import type { Room } from './types';
import { contactShade } from './contactShade';
import type { PenLocal, PenSpot } from './pens';

const KIND_ID: Record<CityKind, number> = { hill: 1, canyon: 2, oasis: 3, trade: 4 };

const FAR_IN = 9000 * WORLD_SCALE; // skyline appears (distance to the city's edge)
const FAR_OUT = 11000 * WORLD_SCALE;
const NEAR_IN = 1500; // full buildings appear
const NEAR_OUT = 1800;
const REACH = 40; // metres inside the edge that counts as arriving

interface Loaded {
  site: CitySite;
  plan: CityPlan;
  meshes: CityMeshes;
  holder: THREE.Group;
  map: THREE.DataTexture | null;
  /** Tree crowns (city-local x, z, radius triples) that shade the ground in the map's G channel. */
  crowns: number[];
  reached: boolean;
  /** Plants, water, furniture and the rest: built one per scan after the city loads. */
  extras: Extra[];
  ctx: ExtraCtx | null;
  solids: SolidIndex;
  /** The insides of the rooms near the wanderer: only while this is the city they are in. */
  interiors: Interiors | null;
  /** The animal pens of its outskirts, in world space (for the caravans to keep beasts in). */
  pens: PenSpot[];
}

/** Seconds for the roof of the room you are in to fade away (and back). */
const CUT_FADE = 0.35;

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
  /** The routes between cities: the worn paths, their camps, the travellers' ways. */
  readonly routes: RouteNet;
  /** The room the wanderer stands in (feet under its ceiling), in the active city. */
  inside: Room | null = null;
  /**
   * The room drawn cut away: the one the wanderer is in, kept while the eye is still over it after
   * they leave, so the roof is never put back over the camera. Its roof is nothing to the camera.
   */
  cutRoom: Room | null = null;
  /** Ceiling (local) of the storey the wanderer is in, in the room being cut: the cut-away starts there. */
  private cutAbove = Infinity;
  private cutFade = 0;

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
    u.uCityD = { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector4()) };
    this.routes = new RouteNet(world);
    RouteNet.uniforms(u);
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
    const d = this.u.uCityD.value as THREE.Vector4[];
    for (let i = 0; i < MAX_SITES; i++) {
      const s = near[i];
      a[i].set(s.cx, s.cz, s.radius, s.groundY);
      b[i].set(s.phase1, s.phase2, s.falloff, KIND_ID[s.kind]);
      const w = this.world.cities.ways(s);
      c[i].set(w.t1, w.t2, s.aveA, s.aveB);
      d[i].set(w.t3, w.t4, 0, 0);
    }
    this.routes.focus(this.u, x, z);
  }

  /** Depth of water to wade through at (x, z): the pool of the loaded city, shelving at its edge. */
  poolDepthAt(x: number, z: number): number {
    const c = this.active;
    const pool = c?.plan.pool;
    if (!c || !pool) return 0;
    const s = c.site;
    const dx = x - s.cx;
    const dz = z - s.cz;
    const co = Math.cos(s.rot);
    const si = Math.sin(s.rot);
    const d = Math.hypot(co * dx + si * dz - pool.x, -si * dx + co * dz - pool.z);
    const t = Math.min(1, Math.max(0, (pool.r - 0.4 - d) / 2.5));
    return t * t * (3 - 2 * t) * 0.6;
  }

  /** Bearings of the ways out of a city: one per route leaving it. */
  private tracks(s: CitySite): number[] {
    const w = this.world.cities.ways(s);
    return [...new Set([w.t1, w.t2, w.t3, w.t4])];
  }

  /** Absolute height of the roof over (x, z) in the loaded city, or -Infinity on open ground. */
  roofAt(x: number, z: number, y = Infinity): number {
    const c = this.active;
    if (!c) return -Infinity;
    const s = c.site;
    const dx = x - s.cx;
    const dz = z - s.cz;
    const co = Math.cos(s.rot);
    const si = Math.sin(s.rot);
    const p = c.plan;
    const lx = co * dx + si * dz;
    const lz = -si * dx + co * dz;
    const top = s.groundY + c.solids.topAt(lx, lz, y - s.groundY);
    const i = Math.floor(lx + p.gridHalf);
    const j = Math.floor(lz + p.gridHalf);
    if (i < 0 || j < 0 || i >= p.gridSize || j >= p.gridSize) return top;
    const k = j * p.gridSize + i;
    const ri = p.roomOf[k];
    if (ri > 0) {
      // a hollow building: its shell answers (walls, the doorway, the floor inside, the roof)
      const r = p.rooms[ri - 1];
      const st = shellTop(r, lx, lz, y - s.groundY, r === this.cutRoom ? this.cutAbove : false);
      return st > -Infinity ? Math.max(top, s.groundY + st) : top;
    }
    const h = p.grid[k];
    return h > 0 ? Math.max(top, s.groundY + h) : top;
  }

  /** Whether the point (x, y, z), grown by a margin, is inside a building of the loaded city. */
  solidAt(x: number, y: number, z: number, m = 0): boolean {
    const c = this.active;
    if (!c) return false;
    const s = c.site;
    const dx = x - s.cx;
    const dz = z - s.cz;
    const co = Math.cos(s.rot);
    const si = Math.sin(s.rot);
    const p = c.plan;
    const lx = co * dx + si * dz;
    const lz = -si * dx + co * dz;
    const ly = y - s.groundY;
    if (c.solids.contains(lx, ly, lz, m)) return true;
    for (let k = 0; k < 5; k++) {
      const ox = k === 1 ? m : k === 2 ? -m : 0;
      const oz = k === 3 ? m : k === 4 ? -m : 0;
      const i = Math.floor(lx + ox + p.gridHalf);
      const j = Math.floor(lz + oz + p.gridHalf);
      if (i < 0 || j < 0 || i >= p.gridSize || j >= p.gridSize) continue;
      const q = j * p.gridSize + i;
      const ri = p.roomOf[q];
      if (ri > 0) {
        // (the point itself with the margin all round; a probe off to the side, as it stands)
        const r = p.rooms[ri - 1];
        if (shellSolid(r, lx + ox, ly, lz + oz, k === 0 ? m : 0, r === this.cutRoom ? this.cutAbove : false)) return true;
        continue;
      }
      const h = p.grid[q];
      if (h > 0 && ly < h + m) return true;
    }
    return false;
  }

  /** Absolute height of the ceiling over feet at (x, y, z) inside a room (or its doorway), or Infinity. */
  ceilAt(x: number, z: number, y: number): number {
    const c = this.active;
    if (!c || c.plan.rooms.length === 0) return Infinity;
    const s = c.site;
    const dx = x - s.cx;
    const dz = z - s.cz;
    const co = Math.cos(s.rot);
    const si = Math.sin(s.rot);
    const lx = co * dx + si * dz;
    const lz = -si * dx + co * dz;
    const r = roomAt(c.plan, lx, lz);
    return r ? s.groundY + shellCeil(r, lx, lz, y - s.groundY) : Infinity;
  }

  /**
   * Per frame, before the camera: which room the wanderer is in, and how far its roof is drawn
   * away. `eye` is where the camera was last frame (the cut-away stays while it is over the room).
   */
  interior(dt: number, feet: THREE.Vector3, eye: THREE.Vector3) {
    const c = this.active;
    let room: Room | null = null;
    if (c && c.plan.rooms.length > 0) {
      const s = c.site;
      const co = Math.cos(s.rot);
      const si = Math.sin(s.rot);
      const lx = co * (feet.x - s.cx) + si * (feet.z - s.cz);
      const lz = -si * (feet.x - s.cx) + co * (feet.z - s.cz);
      const r = roomAt(c.plan, lx, lz);
      if (r && feet.y - s.groundY < r.ceil) room = r;
      if (room) {
        this.cutRoom = room;
        this.cutAbove = ceilOf(room, storeyAt(room, feet.y - s.groundY));
      } else if (this.cutRoom) {
        const r2 = this.cutRoom;
        const ex = co * (eye.x - s.cx) + si * (eye.z - s.cz);
        const ez = -si * (eye.x - s.cx) + co * (eye.z - s.cz);
        // (or the wanderer is up on its roof, which is then solid again)
        if (depthIn(r2, ex, ez) < -0.4 || eye.y - s.groundY > r2.h + 3 || r === r2) this.cutRoom = null;
      }
    } else this.cutRoom = null;
    this.inside = room;
    if (!c) {
      this.cutFade = 0;
      return;
    }
    const want = this.cutRoom ? 1 : 0;
    const step = dt / CUT_FADE;
    this.cutFade = want > this.cutFade ? Math.min(want, this.cutFade + step) : Math.max(want, this.cutFade - step);
    const cut = c.meshes.cut;
    const r = this.cutRoom;
    if (r) cut.uCutBox.value.set(r.x0, r.z0, r.x1, r.z1);
    if (r) cut.uCutY.value.x = this.cutAbove - 0.015;
    cut.uCutY.value.y = this.cutFade;
  }

  /** 1 on desktop, 0.7 low, 0.35 phones. Changing it rebuilds the extras of every loaded city. */
  setDensity(d: number) {
    if (d === this.density) return;
    this.density = d;
    for (const c of this.loaded.values()) this.dropExtras(c);
  }

  /** Per-frame work of the city the player is in, and how loud each kind of ambient sound is here (0..1). */
  frame(f: FrameState): Record<EmitterKind, number> {
    const amb = this.ambience;
    for (const k of EMITTER_KINDS) amb[k] = 0;
    const c = this.active;
    if (!c) return amb;
    const s = c.site;
    const dx = f.player.pos.x - s.cx;
    const dz = f.player.pos.z - s.cz;
    const co = Math.cos(s.rot);
    const si = Math.sin(s.rot);
    this.local.set(co * dx + si * dz, f.player.pos.y - s.groundY, -si * dx + co * dz);
    for (const e of c.extras) {
      e.update?.(f, this.local);
      for (const m of e.emitters) {
        const d = Math.hypot(m.x - this.local.x, m.z - this.local.z);
        const v = m.gain * Math.max(0, 1 - d / (m.reach ?? 40));
        if (v > 0) amb[m.kind] = Math.min(1, Math.hypot(amb[m.kind], v));
      }
    }
    return amb;
  }

  private density = 1;
  private local = new THREE.Vector3();
  private ambience: Record<EmitterKind, number> = { water: 0, leaves: 0, mill: 0, fire: 0, birds: 0 };

  private dropInteriors(c: Loaded) {
    if (!c.interiors) return;
    c.meshes.near.remove(c.interiors.group);
    c.interiors.dispose();
    c.interiors = null;
  }

  private dropExtras(c: Loaded) {
    for (const e of c.extras) {
      c.meshes.near.remove(e.near);
      if (e.far) c.meshes.far.remove(e.far);
      e.dispose();
    }
    c.extras = [];
    c.ctx = null;
    c.solids = new SolidIndex();
    c.pens = [];
  }

  /** The animal pens of every city whose outskirts are built now, in world space. Fills and returns out. */
  pens(out: PenSpot[]): PenSpot[] {
    out.length = 0;
    for (const c of this.loaded.values()) for (const p of c.pens) out.push(p);
    return out;
  }

  /** Builds the next missing extra of a city. Returns true if it did some work. */
  private buildExtra(c: Loaded): boolean {
    if (c.extras.length >= EXTRAS.length) return false;
    c.ctx ??= createExtraCtx(c.plan, this.u, this.density, (x, z) => this.world.height(x, z), this.tracks(c.site), c.meshes.doors);
    const e = EXTRAS[c.extras.length](c.ctx);
    c.extras.push(e);
    c.meshes.near.add(e.near);
    if (e.far) c.meshes.far.add(e.far);
    for (const s of e.solids) c.solids.add(s);
    // tree crowns shade the ground: rebuild the map with them (the update below rebinds it)
    const crowns = e.near.userData.crowns as number[] | undefined;
    if (crowns && crowns.length > 0) {
      for (const v of crowns) c.crowns.push(v);
      c.map?.dispose();
      c.map = null;
    }
    const pens = e.near.userData.pens as PenLocal[] | undefined;
    if (pens) {
      const s = c.site;
      const co = Math.cos(s.rot);
      const si = Math.sin(s.rot);
      for (const p of pens) {
        // (the holder turns the city by -rot about y: local (x, z) is world (co x - si z, si x + co z) from the centre)
        c.pens.push({
          ...p,
          key: s.id * 64 + c.pens.length,
          x: s.cx + co * p.x - si * p.z,
          z: s.cz + si * p.x + co * p.z,
          y: Number.isNaN(p.floor) ? NaN : s.groundY + p.floor,
          rot: s.rot,
        });
      }
    }
    return true;
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
    const entry: Loaded = { site, plan, meshes, holder, map: null, crowns: [], reached: this.reachedIds.has(site.id), extras: [], ctx: null, solids: new SolidIndex(), interiors: null, pens: [] };
    this.loaded.set(site.id, entry);
    return entry;
  }

  private roofMap(c: Loaded): THREE.DataTexture {
    if (c.map) return c.map;
    // R: roof height (0.25 m steps), G: soft contact shade on the ground around the buildings and trees
    const { grid, gridSize, gridHalf } = c.plan;
    const shade = contactShade(grid, gridSize, gridHalf, c.crowns);
    const n = gridSize * gridSize;
    const data = new Uint8Array(n * 2);
    for (let k = 0; k < n; k++) {
      data[2 * k] = Math.min(255, Math.round(grid[k] * 4));
      data[2 * k + 1] = Math.min(255, Math.round(shade[k] * 255));
    }
    const tex = new THREE.DataTexture(data, gridSize, gridSize, THREE.RGFormat, THREE.UnsignedByteType);
    tex.unpackAlignment = 2;
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

    let built = false;
    // Bring cities into range one at a time so a single frame never builds two.
    for (const site of this.sites) {
      const d = Math.hypot(site.cx - pos.x, site.cz - pos.z) - site.radius;
      if (d < FAR_IN && !this.loaded.has(site.id)) {
        this.load(site);
        built = true;
        break;
      }
    }
    // Then fill in their extras, nearest city first, one piece per scan.
    if (!built) {
      const order = [...this.loaded.values()].sort((p, q) => Math.hypot(p.site.cx - pos.x, p.site.cz - pos.z) - Math.hypot(q.site.cx - pos.x, q.site.cz - pos.z));
      for (const c of order) if (this.buildExtra(c)) break;
    }
    // Every loaded city, wherever it is: drop the far ones, and choose skyline or full detail.
    for (const c of this.loaded.values()) {
      const site = c.site;
      const d = Math.hypot(site.cx - pos.x, site.cz - pos.z) - site.radius;
      if (d > FAR_OUT) {
        this.group.remove(c.holder);
        this.dropExtras(c);
        this.dropInteriors(c);
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
    if (this.active !== best) {
      if (this.active) {
        this.active.meshes.cut.uCutY.value.y = 0;
        this.dropInteriors(this.active);
      }
      this.cutRoom = null;
      this.inside = null;
      this.cutFade = 0;
    }
    this.active = best;
    // the insides of the rooms around you, in the city you are in
    if (best && best.plan.rooms.length > 0) {
      if (!best.interiors) {
        best.interiors = new Interiors(best.plan, this.u, best.meshes.cut);
        best.meshes.near.add(best.interiors.group);
      }
      const s = best.site;
      const co = Math.cos(s.rot);
      const si = Math.sin(s.rot);
      best.interiors.update(co * (pos.x - s.cx) + si * (pos.z - s.cz), -si * (pos.x - s.cx) + co * (pos.z - s.cz));
    }
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
