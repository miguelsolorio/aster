// Bakes the GLSL surface() into a float texture around the player, for far
// normals and cast shadows. R = height (m), G = rock, B = salt.
import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import { heightBakeFrag, heightBakeVert } from '../render/terrainShaders';

const RES = 2048;
const SIZE = 8192; // metres covered
const TEXEL = SIZE / RES; // 4 m
const REBAKE_DIST = 512;

/** Return the shared holder, creating it if no other system has yet. */
function holder(u: Uniforms, name: string, value: unknown): THREE.IUniform {
  let h = u[name];
  if (!h) {
    h = { value };
    u[name] = h;
  }
  return h;
}

export class HeightBake {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mat: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly mapU: THREE.IUniform;
  private readonly rectU: THREE.IUniform;
  private readonly texelU: THREE.IUniform;
  private readonly center = new THREE.Vector2();
  private baked = false;

  constructor(renderer: THREE.WebGLRenderer, uniforms: Uniforms) {
    this.renderer = renderer;
    renderer.extensions.get('EXT_color_buffer_float');
    renderer.extensions.get('OES_texture_float_linear');

    this.rt = new THREE.WebGLRenderTarget(RES, RES, {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.rt.texture.generateMipmaps = false;

    this.mapU = holder(uniforms, 'uHeightMap', null);
    this.rectU = holder(uniforms, 'uRect', new THREE.Vector3());
    this.texelU = holder(uniforms, 'uTexel', TEXEL);
    if (!(this.rectU.value instanceof THREE.Vector3)) this.rectU.value = new THREE.Vector3();
    const seedU = holder(uniforms, 'uSeed', 0);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: heightBakeVert,
      fragmentShader: heightBakeFrag,
      uniforms: {
        uSeed: seedU,
        uBakeOrigin: { value: new THREE.Vector2() },
        uBakeTexel: { value: TEXEL },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Re-bake when `center` is more than 512 m (xz) from the current bake centre. */
  update(center: THREE.Vector3): void {
    if (this.baked) {
      const dx = center.x - this.center.x;
      const dz = center.z - this.center.y;
      if (dx * dx + dz * dz <= REBAKE_DIST * REBAKE_DIST) return;
    }
    const cx = Math.round(center.x / TEXEL) * TEXEL;
    const cz = Math.round(center.z / TEXEL) * TEXEL;
    this.center.set(cx, cz);
    const ox = cx - SIZE / 2;
    const oz = cz - SIZE / 2;
    (this.mat.uniforms.uBakeOrigin.value as THREE.Vector2).set(ox, oz);

    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevFace = r.getActiveCubeFace();
    const prevMip = r.getActiveMipmapLevel();
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.setRenderTarget(this.rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev, prevFace, prevMip);
    r.xr.enabled = prevXr;

    this.mapU.value = this.rt.texture;
    (this.rectU.value as THREE.Vector3).set(ox, oz, SIZE);
    this.texelU.value = TEXEL;
    this.baked = true;
  }

  dispose(): void {
    this.rt.dispose();
    this.mat.dispose();
    this.quad.geometry.dispose();
  }
}
