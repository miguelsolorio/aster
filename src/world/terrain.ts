import * as THREE from 'three';
import type { HeightFn } from './height';

/** Grid mesh in world coordinates, dense at the centre and coarse at the edge. */
export function buildTerrain(
  h: HeightFn,
  cx: number,
  cz: number,
  opts: { res: number; half: number; linear: number },
): THREE.BufferGeometry {
  const { res, half, linear } = opts;
  const n = res + 1;
  const pos = new Float32Array(n * n * 3);

  // Grid offsets per axis index (same for x and z).
  const off = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / res) * 2 - 1;
    off[i] = half * (linear * u + (1 - linear) * u * u * u);
  }

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = cx + off[i];
      const z = cz + off[j];
      const k = (j * n + i) * 3;
      pos[k] = x;
      pos[k + 1] = h(x, z);
      pos[k + 2] = z;
    }
  }

  // Normals from neighbouring vertices (one-sided at borders).
  const nor = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    const j0 = Math.max(j - 1, 0);
    const j1 = Math.min(j + 1, n - 1);
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(i - 1, 0);
      const i1 = Math.min(i + 1, n - 1);
      const a = (j * n + i0) * 3;
      const b = (j * n + i1) * 3;
      const c = ((j0) * n + i) * 3;
      const d = (j1 * n + i) * 3;
      // tangents along +x and +z
      const txx = pos[b] - pos[a];
      const txy = pos[b + 1] - pos[a + 1];
      const txz = pos[b + 2] - pos[a + 2];
      const tzx = pos[d] - pos[c];
      const tzy = pos[d + 1] - pos[c + 1];
      const tzz = pos[d + 2] - pos[c + 2];
      // normal = tz x tx (points up)
      let nx = tzy * txz - tzz * txy;
      let ny = tzz * txx - tzx * txz;
      let nz = tzx * txy - tzy * txx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const k = (j * n + i) * 3;
      nor[k] = nx;
      nor[k + 1] = ny;
      nor[k + 2] = nz;
    }
  }

  // Indices, wound counter-clockwise when seen from +y.
  const idx = new Uint32Array(res * res * 6);
  let t = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx[t++] = a;
      idx[t++] = c;
      idx[t++] = b;
      idx[t++] = b;
      idx[t++] = c;
      idx[t++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

/** Single-channel half-float heightmap covering a square of `size` metres. */
export function buildHeightMap(
  h: HeightFn,
  cx: number,
  cz: number,
  size: number,
  n: number,
): { texture: THREE.DataTexture; rect: [number, number, number]; texel: number } {
  const ox = cx - size / 2;
  const oz = cz - size / 2;
  const data = new Uint16Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = oz + ((j + 0.5) / n) * size;
    for (let i = 0; i < n; i++) {
      const x = ox + ((i + 0.5) / n) * size;
      data[j * n + i] = THREE.DataUtils.toHalfFloat(h(x, z));
    }
  }
  const texture = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, rect: [ox, oz, size], texel: size / n };
}
