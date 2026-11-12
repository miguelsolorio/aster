import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * A cloaked wanderer, feet at y = 0, about 1.8 m tall, facing +z.
 * Shoulders under a long cloak, and a hood whose point hangs down the back.
 */
export function buildFigureGeometry(): THREE.BufferGeometry {
  // Cloak: lathe of (radius, y), then flattened front to back so it reads as a body, not a cone.
  const profile = [
    [0.43, 0],
    [0.4, 0.16],
    [0.3, 0.6],
    [0.235, 1.0],
    [0.225, 1.22],
    [0.245, 1.36], // shoulders
    [0.19, 1.45],
    [0.1, 1.52],
    [0.0, 1.54],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const cloak = new THREE.LatheGeometry(profile, 56);
  // Cloth folds: deep at the hem, gone by the shoulders, plus a wider sweep at the back.
  {
    const pos = cloak.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const a = Math.atan2(z, x);
      const low = Math.pow(Math.max(0, 1 - y / 1.3), 1.4);
      const fold = 1 + low * (0.09 * Math.sin(a * 7 + 0.6) + 0.05 * Math.sin(a * 13 + 2.1));
      const back = 1 + low * 0.28 * Math.max(0, -Math.sin(a));
      pos.setXYZ(i, x * fold, y, z * fold * back);
    }
    cloak.computeVertexNormals();
  }
  cloak.scale(1, 1, 0.8);

  // Head inside the hood.
  const hood = new THREE.SphereGeometry(0.165, 22, 16);
  hood.scale(0.95, 1.08, 1.05);
  hood.translate(0, 1.655, 0.01);

  // Hood mantle: a soft collar that joins head and shoulders.
  const mantle = new THREE.SphereGeometry(0.2, 20, 12);
  mantle.scale(1.05, 0.5, 0.9);
  mantle.translate(0, 1.5, -0.02);

  // Hood point, hanging back and down.
  const peak = new THREE.ConeGeometry(0.11, 0.36, 14);
  peak.translate(0, 0.18, 0);
  peak.rotateX(-THREE.MathUtils.degToRad(146));
  peak.translate(0, 1.72, -0.07);

  const parts = [cloak, hood, mantle, peak].map((g) => {
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
