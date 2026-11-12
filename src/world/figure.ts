import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Simple cloaked wanderer, feet at y = 0, ~1.8 m tall. */
export function buildFigureGeometry(): THREE.BufferGeometry {
  // Cloak: lathe of (radius, y) profile
  const profile = [
    [0.44, 0],
    [0.4, 0.25],
    [0.31, 0.8],
    [0.24, 1.25],
    [0.19, 1.45],
    [0.1, 1.56],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const cloak = new THREE.LatheGeometry(profile, 24);

  // Hood: slightly stretched sphere
  const hood = new THREE.SphereGeometry(0.19, 20, 14);
  hood.scale(1, 1.1, 1.1);
  hood.translate(0, 1.62, 0);

  // Hood peak: cone tilted backward (tip toward -z)
  const peak = new THREE.ConeGeometry(0.11, 0.24, 12);
  peak.rotateX(-THREE.MathUtils.degToRad(35));
  peak.translate(0, 1.8, 0);

  // Keep only position + normal, non-indexed, so attributes match.
  const parts = [cloak, hood, peak].map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(ng.attributes)) {
      if (name !== 'position' && name !== 'normal') ng.deleteAttribute(name);
    }
    return ng;
  });

  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('figure: mergeGeometries failed');
  merged.computeBoundingSphere();
  return merged;
}
