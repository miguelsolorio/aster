// Normals and bounds for a triangle soup (non-indexed geometry), worked out a slice at a time so
// a big site's mesh can be finished over several frames. The arithmetic is three.js's own
// (BufferGeometry.computeVertexNormals and computeBoundingSphere), step for step and rounded to
// float32 where it rounds, so the numbers come out exactly the same.
import * as THREE from 'three';

/** Vertices handled between yields: a fraction of a millisecond on a desktop. */
export const SOUP_STEP = 3072;

/**
 * Writes the faceted normal of every triangle into `nrm` (as computeVertexNormals does for a
 * non-indexed geometry, then normalizeNormals), yielding every `step` vertices or so.
 */
export function* soupNormals(pos: Float32Array, nrm: Float32Array, step = SOUP_STEP): Generator<void, void> {
  const count = pos.length / 3;
  const tmp = new Float32Array(3);
  let since = 0;
  for (let i = 0; i < count; i += 3) {
    const a = i * 3;
    const b = a + 3;
    const c = a + 6;
    // cb = pC - pB, ab = pA - pB, cb x ab
    const cbx = pos[c] - pos[b];
    const cby = pos[c + 1] - pos[b + 1];
    const cbz = pos[c + 2] - pos[b + 2];
    const abx = pos[a] - pos[b];
    const aby = pos[a + 1] - pos[b + 1];
    const abz = pos[a + 2] - pos[b + 2];
    // (stored as float32, then read back and normalised, as normalizeNormals does)
    tmp[0] = cby * abz - cbz * aby;
    tmp[1] = cbz * abx - cbx * abz;
    tmp[2] = cbx * aby - cby * abx;
    const x = tmp[0];
    const y = tmp[1];
    const z = tmp[2];
    const s = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    const nx = x * s;
    const ny = y * s;
    const nz = z * s;
    for (let k = 0; k < 3; k++) {
      const o = a + k * 3;
      if (o >= nrm.length) break;
      nrm[o] = nx;
      nrm[o + 1] = ny;
      nrm[o + 2] = nz;
    }
    since += 3;
    if (since >= step) {
      since = 0;
      yield;
    }
  }
}

/** The bounding sphere computeBoundingSphere would give `pos`, yielding every `step` vertices or so. */
export function* soupSphere(pos: Float32Array, step = SOUP_STEP): Generator<void, THREE.Sphere> {
  const count = pos.length / 3;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i0 = 0; i0 < count; i0 += step) {
    const end = Math.min(count, i0 + step);
    for (let i = i0; i < end; i++) {
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      // (Math.min and max, as Box3 does: they carry a NaN through)
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      z1 = Math.max(z1, z);
    }
    if (end < count) yield;
  }
  const sphere = new THREE.Sphere();
  const empty = x1 < x0 || y1 < y0 || z1 < z0;
  const cx = empty ? 0 : (x0 + x1) * 0.5;
  const cy = empty ? 0 : (y0 + y1) * 0.5;
  const cz = empty ? 0 : (z0 + z1) * 0.5;
  sphere.center.set(cx, cy, cz);
  let maxSq = 0;
  for (let i0 = 0; i0 < count; i0 += step) {
    const end = Math.min(count, i0 + step);
    for (let i = i0; i < end; i++) {
      const dx = cx - pos[i * 3];
      const dy = cy - pos[i * 3 + 1];
      const dz = cz - pos[i * 3 + 2];
      maxSq = Math.max(maxSq, dx * dx + dy * dy + dz * dz);
    }
    yield;
  }
  sphere.radius = Math.sqrt(maxSq);
  return sphere;
}
