// A built deep's data made into what is drawn and what answers in world space. This is the
// only part of building a deep that has to be on the main thread: it wraps the arrays that
// DeepBuilder.finish() worked out (here or on a worker) into geometries and meshes, without
// copying or walking them, and makes the materials.

import * as THREE from 'three';
import type { Uniforms } from '../../game/contract';
import { DEEP_HOLE } from './types';
import type { BuiltDeep, DeepData, GlowData, Sphere4 } from './builder';
import { Lights, type Lamp } from './light';
import type { Pt } from './spans';
import { deepMaterials } from './material';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A geometry's bounding sphere, as worked out with the data. */
function bound(geo: THREE.BufferGeometry, s: Sphere4): void {
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(s[0], s[1], s[2]), s[3]);
}

function glowMesh(g: GlowData, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
  geo.setAttribute('aCorner', new THREE.BufferAttribute(g.corner, 2));
  geo.setAttribute('aSize', new THREE.BufferAttribute(g.size, 1));
  geo.setAttribute('aCol', new THREE.BufferAttribute(g.col, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(g.phase, 1));
  geo.setIndex(new THREE.BufferAttribute(g.index, 1));
  bound(geo, g.sphere);
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 10;
  return m;
}

/**
 * Make a deep's data into the Deep: its meshes placed in the world, and the queries feet, eyes
 * and lights ask of it. `uniforms` is the game's shared uniform object (palette and style
 * holders); without it the deep is drawn in fixed 35 mm colours and ignores ?style=.
 * The data is the Deep's from then on (its grid and lamps are used, not copied).
 */
export function assembleDeep(data: DeepData, uniforms?: Uniforms): BuiltDeep {
  const t0 = now();
  const { spec, grid, marks } = data;
  const lights = new Lights();
  for (const l of data.lamps) lights.lamps.push(l);
  for (const s of data.shafts) lights.shafts.push(s);
  lights.index(grid);

  const mats = deepMaterials(uniforms);
  const group = new THREE.Group();
  group.name = 'deep';
  group.position.set(spec.x, spec.y, spec.z);
  group.rotation.y = Math.atan2(-spec.dz, spec.dx);

  // one geometry for the rock and everything standing on it
  const rock = data.rock;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(rock.pos, 3));
  geo.setAttribute('aTint', new THREE.BufferAttribute(rock.tint, 4, true));
  geo.setAttribute('aLight', new THREE.BufferAttribute(rock.light, 4, true));
  geo.setIndex(new THREE.BufferAttribute(rock.index, 1));
  bound(geo, rock.sphere);
  const geos: THREE.BufferGeometry[] = [geo];
  group.add(new THREE.Mesh(geo, mats.rock));

  if (data.water) {
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(data.water.pos, 3));
    wg.setAttribute('aLight', new THREE.BufferAttribute(data.water.light, 4, true));
    bound(wg, data.water.sphere);
    geos.push(wg);
    group.add(new THREE.Mesh(wg, mats.water));
  }
  if (data.beams) {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(data.beams.pos, 3));
    bg.setAttribute('aFade', new THREE.BufferAttribute(data.beams.fade, 1));
    bound(bg, data.beams.sphere);
    geos.push(bg);
    const bm = new THREE.Mesh(bg, mats.beam);
    bm.renderOrder = 9;
    group.add(bm);
  }
  if (data.glows) {
    const gm = glowMesh(data.glows, mats.glow);
    geos.push(gm.geometry);
    group.add(gm);
  }

  // the waking stone: asleep (-1), or woken at a time on the same clock as the flames
  const stoneAt = data.stone;
  if (stoneAt) mats.stone.value.set(stoneAt[0], stoneAt[1], stoneAt[2]);
  let wokenAt = -1;
  let instant = false;

  // the relic is its own small thing, so it can be lifted off its stone
  let relicObj: THREE.Group | null = null;
  let relicLamp: Lamp | null = null;
  if (data.relic) {
    const r = data.relic;
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
    rg.setAttribute('aTint', new THREE.BufferAttribute(r.tint, 4, true));
    rg.setAttribute('aLight', new THREE.BufferAttribute(new Uint8Array((r.pos.length / 3) * 4), 4, true));
    bound(rg, r.sphere);
    const gl = glowMesh(r.glow, mats.glow);
    relicObj = new THREE.Group();
    relicObj.add(new THREE.Mesh(rg, mats.rock), gl);
    geos.push(rg, gl.geometry);
    group.add(relicObj);
    relicLamp = lights.lamps[r.lamp];
  }
  const stats = { ...data.stats, assembleMs: now() - t0 };

  // ---- the built deep: everything below answers in world space
  const { x: ox, y: oy, z: oz, dx, dz, u1, v0, v1, lid } = spec;
  const HU = DEEP_HOLE.halfU;
  const HV = DEEP_HOLE.halfV;
  const world = (p: Pt): [number, number, number] => [ox + p[0] * dx - p[2] * dz, oy + p[1], oz + p[0] * dz + p[2] * dx];
  const step = Math.min(0.3, Math.min(grid.cu, grid.cv) * 0.4);
  /** Whether the grid has a say at a local point; elsewhere a sight line passes. */
  const ours = (u: number, y: number, v: number): boolean => (u >= -HU && u <= HU && v >= -HV && v <= HV) || y < lid;
  /**
   * Whether a sight line is stopped at a local point. Under the lid and down the hole the grid
   * says; between the lid and the antechamber floor there is only rock, whatever the grid
   * holds (it cuts nothing there), so an eye can never rise out through a passage's roof.
   */
  const stops = (u: number, y: number, v: number): boolean => (ours(u, y, v) ? !grid.isAir(u, y, v) : y < -0.2);

  const deep: BuiltDeep = {
    spec,
    group,
    grid,
    stats,
    relic: marks.relic ? world(marks.relic) : null,
    stone: stoneAt ? world(stoneAt) : null,
    get woken() {
      return instant || wokenAt >= 0;
    },
    wake(inst) {
      if (inst) instant = true;
      else if (wokenAt < 0) wokenAt = mats.time.value;
    },
    centre: world(marks.centre),
    ledge: world(marks.ledge),

    toLocal(x, y, z, out) {
      const rx = x - ox;
      const rz = z - oz;
      out[0] = rx * dx + rz * dz;
      out[1] = y - oy;
      out[2] = rz * dx - rx * dz;
      return out;
    },

    floorAt(x, z, y) {
      const rx = x - ox;
      const rz = z - oz;
      const u = rx * dx + rz * dz;
      const v = rz * dx - rx * dz;
      const ly = y - oy;
      if (!(u >= -HU && u <= HU && v >= -HV && v <= HV)) {
        if (ly >= lid || u < 0 || u > u1 || v < v0 || v > v1) return null;
      }
      return grid.floorAt(u, v, ly) + oy;
    },

    ceilAt(x, z, y) {
      const rx = x - ox;
      const rz = z - oz;
      const u = rx * dx + rz * dz;
      const v = rz * dx - rx * dz;
      const ly = y - oy;
      if (!ours(u, ly, v)) return Infinity;
      return grid.ceilAt(u, v, ly) + oy;
    },

    inside(x, y, z) {
      const rx = x - ox;
      const rz = z - oz;
      const u = rx * dx + rz * dz;
      const v = rz * dx - rx * dz;
      const ly = y - oy;
      // under the lid, or far enough down the hole to be off the antechamber's floor
      if (ly >= lid && !(ly < -0.3 && u >= -HU && u <= HU && v >= -HV && v <= HV)) return false;
      return grid.isAir(u, ly + 0.3, v) || grid.isAir(u, ly, v);
    },

    sight(from, to) {
      const fx = from.x - ox;
      const fz = from.z - oz;
      const au = fx * dx + fz * dz;
      const av = fz * dx - fx * dz;
      const ay = from.y - oy;
      const tx = to.x - ox;
      const tz = to.z - oz;
      const du = tx * dx + tz * dz - au;
      const dv = tz * dx - tx * dz - av;
      const dy = to.y - oy - ay;
      const d = Math.sqrt(du * du + dy * dy + dv * dv);
      if (d < 1e-4) return 1;
      const n = Math.min(96, Math.max(1, Math.ceil(d / step)));
      let hit = -1;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = au + du * t;
        const y = ay + dy * t;
        const v = av + dv * t;
        if (stops(u, y, v)) {
          hit = i;
          break;
        }
      }
      if (hit < 0) return 1;
      // close in on where it meets the rock
      let lo = (hit - 1) / n;
      let hi = hit / n;
      for (let q = 0; q < 5; q++) {
        const t = (lo + hi) * 0.5;
        const u = au + du * t;
        const y = ay + dy * t;
        const v = av + dv * t;
        if (stops(u, y, v)) hi = t;
        else lo = t;
      }
      return lo;
    },

    glowAt(x, y, z, out) {
      const rx = x - ox;
      const rz = z - oz;
      const u = rx * dx + rz * dz;
      const v = rz * dx - rx * dz;
      const ly = y - oy;
      const li = lights.best(u, ly, v);
      if (li >= 0) {
        const l = lights.lamps[li];
        out[0] = ox + l.u * dx - l.v * dz;
        out[1] = oy + l.y;
        out[2] = oz + l.u * dz + l.v * dx;
        out[3] = l.reach;
        return true;
      }
      // in a shaft's beam by day: lit from the opening
      if (mats.sky.value > 0.3) {
        for (const s of lights.shafts) {
          const R = s.r + 0.06 * (s.y - ly) + 1;
          if ((s.u - u) * (s.u - u) + (s.v - v) * (s.v - v) < R * R && ly < s.y && (s.fade === undefined || s.y - ly < s.fade * 0.6)) {
            out[0] = ox + s.u * dx - s.v * dz;
            out[1] = oy + s.y;
            out[2] = oz + s.u * dz + s.v * dx;
            out[3] = (s.y - ly) * 2.5 + 20;
            return true;
          }
        }
      }
      return false;
    },

    waterAt(x, z, y) {
      if (!grid.water) return 0;
      const rx = x - ox;
      const rz = z - oz;
      return grid.waterAt(rx * dx + rz * dz, rz * dx - rx * dz, y - oy);
    },

    wetness(x, y, z) {
      const w = grid.water;
      if (!w) return 0;
      const rx = x - ox;
      const rz = z - oz;
      const u = rx * dx + rz * dz;
      const v = rz * dx - rx * dz;
      const ly = y - oy;
      // open water within about ten metres, weighed by how near
      let sum = 0;
      let tot = 0;
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const wgt = 1 / (1 + di * di + dj * dj);
          tot += wgt;
          const ci = grid.cell(u + di * 4, v + dj * 4);
          if (ci < 0) continue;
          const lv = w[ci];
          if (lv === lv && Math.abs(lv - ly) < 8 && grid.isAir(u + di * 4, lv + 0.2, v + dj * 4)) sum += wgt;
        }
      }
      return Math.min(1, (sum / tot) * 1.6);
    },

    takeRelic() {
      if (relicObj) relicObj.visible = false;
      if (relicLamp) relicLamp.live = false;
    },

    update(time, day) {
      mats.time.value = time;
      mats.wake.value = instant ? 1e4 : wokenAt >= 0 ? time - wokenAt : -1;
      const d = Math.min(1, Math.max(0, day));
      mats.sky.value = 0.05 + 0.95 * d * d * (3 - 2 * d);
    },

    dispose() {
      for (const g of geos) g.dispose();
      mats.dispose();
      group.removeFromParent();
    },
  };

  // what the kind left for its checks (its layout), as the Deep's own properties
  return Object.assign(deep, data.extra);
}
