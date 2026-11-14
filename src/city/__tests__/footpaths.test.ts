import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createWorld, TERRAIN } from '../../world/surface';
import { Discoveries } from '../../world/discoveries';
import { RouteNet } from '../routes';
import { FOOT_REACH, FootpathNet, MAX_FOOTPATHS, footPos, type FootSite, type Footpath } from '../footpaths';
import type { Uniforms } from '../../game/contract';

/** A fresh world and footpath network for a seed, with the finds the game itself would place. */
function setup(seed: number) {
  const world = createWorld(seed);
  const disc = new Discoveries(world, {});
  const net = new FootpathNet(world, new RouteNet(world), (x, z, r, out) => disc.surfaceSitesNear(x, z, r, out));
  const town = world.cities.near(0, 0)[0];
  return { world, disc, net, town };
}

/** Everything about a path that the terrain or a walker reads, rounded off for comparing. */
const sig = (f: Footpath) => [f.site.key, f.to.kind, f.x0, f.z0, f.dx, f.dz, f.len, f.amp, f.k, f.ph, f.fade0, f.fade1].join(',');

const SEEDS = [1, 7, 12345];

describe('footpaths between the towns and the finds', () => {
  it('lays the same paths for the same seed, whatever order they are asked for in', () => {
    for (const seed of SEEDS) {
      const a = setup(seed);
      const b = setup(seed);
      const sites = a.disc.surfaceSitesNear(a.town.cx, a.town.cz, 4000, []).slice();
      expect(sites.length).toBeGreaterThan(5);
      const one = sites.map((s) => a.net.link(s));
      // the other way round, so no path depends on which was worked out first
      const two = sites
        .slice()
        .reverse()
        .map((s) => b.net.link(s))
        .reverse();
      expect(one.map((f) => (f ? sig(f) : null))).toEqual(two.map((f) => (f ? sig(f) : null)));
      expect(one.filter(Boolean).length).toBeGreaterThan(3);
    }
  });

  it('never runs through a river', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const { world, net, town } = setup(seed);
      const P = { x: 0, z: 0 };
      for (const f of net.near(town.cx, town.cz, 4000, [])) {
        for (let u = 0; u <= f.len; u += 2) {
          footPos(f, u, P);
          expect(world.river(P.x, P.z)).toBeGreaterThan(TERRAIN.riverHalf + 2);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('leads every find toward town without looping, and stops short of the finds', () => {
    for (const seed of SEEDS) {
      const { world, disc, net, town } = setup(seed);
      const rank = (s: FootSite) => {
        const c = world.cities.near(s.x, s.z)[0];
        return Math.hypot(c.cx - s.x, c.cz - s.z);
      };
      for (const s of disc.surfaceSitesNear(town.cx, town.cz, 4000, [])) {
        const f = net.link(s);
        if (!f) continue;
        expect(f.len).toBeLessThanOrEqual(FOOT_REACH);
        // the find's end stops clear of its stones
        const end = footPos(f, f.len, { x: 0, z: 0 });
        expect(Math.hypot(end.x - s.x, end.z - s.z)).toBeGreaterThan(10);
        expect(f.fade1).toBe(true);
        // a path onto a route joins it without thinning out; the others thin out at both ends
        expect(f.fade0).toBe(f.to.kind !== 'route');
        // follow the chain of finds: each step nearer a town, so it always ends
        let cur: Footpath | null = f;
        let steps = 0;
        while (cur && cur.to.kind === 'site') {
          expect(rank(cur.to.site)).toBeLessThanOrEqual(rank(cur.site));
          cur = net.link(cur.to.site);
          expect(++steps).toBeLessThan(50);
        }
      }
    }
  });

  it('hands the terrain the nearest paths, with the ends that fade packed into the phase', () => {
    const { net, town } = setup(7);
    const u: Uniforms = {};
    FootpathNet.uniforms(u);
    net.focus(u, town.cx, town.cz);
    const list = net.near(town.cx, town.cz, 3000, []);
    const A = u.uFootA.value as THREE.Vector4[];
    const B = u.uFootB.value as THREE.Vector4[];
    expect(A.length).toBe(MAX_FOOTPATHS);
    for (let i = 0; i < MAX_FOOTPATHS; i++) {
      const f = list[i];
      if (!f) {
        expect(B[i].x).toBe(0);
        continue;
      }
      expect(A[i].x).toBe(f.x0);
      expect(B[i].x).toBe(f.len);
      const code = Math.floor(B[i].w / 8);
      expect(B[i].w - 8 * code).toBeCloseTo(f.ph, 5);
      expect(code % 2 === 1).toBe(f.fade0);
      expect(code >= 2).toBe(f.fade1);
    }
  });
});

describe('hamlets in the empty desert', () => {
  it('are spread about the open ground and most have a path out', () => {
    for (const seed of SEEDS) {
      const { disc, net, town } = setup(seed);
      const sites = disc.surfaceSitesNear(town.cx, town.cz, 9000, []).slice();
      const hamlets = sites.filter((s) => s.kind === 'hamlet');
      expect(hamlets.length).toBeGreaterThan(8);
      expect(hamlets.length).toBeGreaterThan(sites.length * 0.25);
      for (const a of hamlets) for (const b of hamlets) if (a.key < b.key) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(200);
      const linked = hamlets.filter((h) => net.link(h)).length;
      expect(linked).toBeGreaterThan(hamlets.length * 0.4);
    }
  });
});
