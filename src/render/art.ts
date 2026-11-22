import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

// The art made in Blender (tools/blender/*.py writes it into public/art). Everything here is an
// extra: the game builds its own geometry first and runs without these files, then takes the
// modelled meshes and the detail texture as they arrive.

const BASE = `${import.meta.env.BASE_URL}art/`;

let detail: THREE.Texture | null = null;

/**
 * One tileable 512 px detail map, mid-grey (0.5) on average in every channel:
 * R woven cloth, G limewashed plaster, B dressed stone. Until it has loaded it is flat grey,
 * so a shader that reads `(texel - 0.5)` adds nothing.
 */
export function detailTexture(): THREE.Texture {
  if (detail) return detail;
  const tex = new THREE.Texture();
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgb(128,128,128)';
      ctx.fillRect(0, 0, 1, 1);
    }
    tex.image = c;
  }
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  detail = tex;
  if (typeof document !== 'undefined') {
    new THREE.ImageLoader().load(
      `${BASE}detail.png`,
      (img) => {
        tex.image = img;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
      },
      undefined,
      () => {},
    );
  }
  return tex;
}

const models = new Map<string, Promise<GLTF | null>>();

/** A model from public/art by file name ("wanderer.glb"), or null where it cannot be had. */
export function loadModel(file: string): Promise<GLTF | null> {
  let p = models.get(file);
  if (!p) {
    p = new GLTFLoader().loadAsync(`${BASE}${file}`).catch(() => null);
    models.set(file, p);
  }
  return p;
}

/** The mesh of that name in a loaded model, with its geometry baked into the model's own space. */
export function modelGeometry(gltf: GLTF, name: string): THREE.BufferGeometry | null {
  const obj = gltf.scene.getObjectByName(name);
  if (!(obj instanceof THREE.Mesh)) return null;
  obj.updateWorldMatrix(true, false);
  const g = (obj.geometry as THREE.BufferGeometry).clone();
  g.applyMatrix4(obj.matrixWorld);
  return g;
}
