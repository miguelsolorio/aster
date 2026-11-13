// Bakes the GLSL surface() into a float texture around the player, for far
// normals and cast shadows. R = height (m), G = rock, B = salt.
//
// Texture format, chosen once from what the device can do and verified with a
// framebuffer completeness check:
//   - RGBA32F, when EXT_color_buffer_float and OES_texture_float_linear both
//     exist and the bake is larger than 1024 (desktop default, as before).
//   - RGBA16F otherwise (always linear-filterable in WebGL2; renderable with
//     EXT_color_buffer_float or EXT_color_buffer_half_float). Many phones
//     (iOS, most Mali) cannot linearly filter 32-bit floats, and sampling such
//     a texture with LinearFilter would return 0 everywhere.
//   - none: if neither is renderable, nothing is baked and uRect.z stays 0, so
//     the terrain shader falls back to mesh normals and skips cast shadows.
// Heights are stored as raw metres in both float formats. Half floats have
// relative precision (11 significant bits), so dividing by a constant would not
// help: steps are <= 3 cm below 64 m (the dunes), 0.25 m at 256..512 m and
// 0.5 m above 512 m, well under the ray-march bias (0.25 texel = 1-2 m) and the
// 4-8 m texel spacing used for far normals.
import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import { heightBakeFrag, heightBakeVert } from '../render/terrainShaders';

const DEFAULT_RES = 2048;
const SIZE = 8192; // metres covered
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

export type HeightBakeFormat = 'float' | 'half' | 'none';

export class HeightBake {
  private readonly renderer: THREE.WebGLRenderer;
  private rt: THREE.WebGLRenderTarget | null = null;
  private res = DEFAULT_RES;
  private texel = SIZE / DEFAULT_RES;
  private wantRes = DEFAULT_RES;
  private readonly canFloat: boolean;
  private readonly canHalf: boolean;
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
    const ext = renderer.extensions;
    const cbf = ext.has('EXT_color_buffer_float');
    this.canFloat = cbf && ext.has('OES_texture_float_linear');
    this.canHalf = cbf || ext.has('EXT_color_buffer_half_float');

    this.mapU = holder(uniforms, 'uHeightMap', null);
    this.rectU = holder(uniforms, 'uRect', new THREE.Vector3());
    this.texelU = holder(uniforms, 'uTexel', this.texel);
    if (!(this.rectU.value instanceof THREE.Vector3)) this.rectU.value = new THREE.Vector3();
    const seedU = holder(uniforms, 'uSeed', 0);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: heightBakeVert,
      fragmentShader: heightBakeFrag,
      uniforms: {
        ...uniforms, // includes the city sites that reshape the ground
        uSeed: seedU,
        uBakeOrigin: { value: new THREE.Vector2() },
        uBakeTexel: { value: this.texel },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.rt = this.makeTarget(DEFAULT_RES);
    if (!this.rt) console.warn('HeightBake: no renderable float format; far normals and cast shadows are off.');
  }

  /** Format of the current bake. */
  get format(): HeightBakeFormat {
    if (!this.rt) return 'none';
    return this.rt.texture.type === THREE.FloatType ? 'float' : 'half';
  }

  /** Current bake resolution in texels per side. */
  get size(): number {
    return this.res;
  }

  /**
   * Bake resolution per side (1024 or 2048; other values round to a power of
   * two in 512..4096). The coverage stays 8192 m, so the texel becomes 8 m at
   * 1024. The new target is made and baked on the next update(); until then the
   * current map stays in use.
   */
  setSize(n: number): void {
    const max = Math.min(4096, this.renderer.capabilities.maxTextureSize || 4096);
    const p = 2 ** Math.round(Math.log2(Math.max(1, n) || DEFAULT_RES));
    const want = Math.min(max, Math.max(512, p));
    this.wantRes = want;
    if (want !== this.res) this.baked = false;
  }

  /** The ground has changed shape (a cavern has opened): bake again on the next update. */
  invalidate(): void {
    this.baked = false;
  }

  /** Re-bake when `center` is more than 512 m (xz) from the current bake centre, or after setSize. */
  update(center: THREE.Vector3): void {
    if (this.baked) {
      const dx = center.x - this.center.x;
      const dz = center.z - this.center.y;
      if (dx * dx + dz * dz <= REBAKE_DIST * REBAKE_DIST) return;
    }

    let old: THREE.WebGLRenderTarget | null = null;
    if (this.wantRes !== this.res && this.rt) {
      const next = this.makeTarget(this.wantRes);
      if (next) {
        old = this.rt;
        this.rt = next;
        this.res = this.wantRes;
        this.texel = SIZE / this.res;
      } else {
        this.wantRes = this.res; // keep what works
      }
    }
    const rt = this.rt;
    if (!rt) {
      this.baked = true; // nothing to bake into; uRect.z stays 0
      return;
    }

    const texel = this.texel;
    const cx = Math.round(center.x / texel) * texel;
    const cz = Math.round(center.z / texel) * texel;
    this.center.set(cx, cz);
    const ox = cx - SIZE / 2;
    const oz = cz - SIZE / 2;
    (this.mat.uniforms.uBakeOrigin.value as THREE.Vector2).set(ox, oz);
    this.mat.uniforms.uBakeTexel.value = texel;

    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevFace = r.getActiveCubeFace();
    const prevMip = r.getActiveMipmapLevel();
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.setRenderTarget(rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev, prevFace, prevMip);
    r.xr.enabled = prevXr;

    this.mapU.value = rt.texture;
    (this.rectU.value as THREE.Vector3).set(ox, oz, SIZE);
    this.texelU.value = texel;
    this.baked = true;
    old?.dispose();
  }

  dispose(): void {
    this.rt?.dispose();
    this.mat.dispose();
    this.quad.geometry.dispose();
  }

  /** Best renderable, linear-filterable float target at `res`, or null. */
  private makeTarget(res: number): THREE.WebGLRenderTarget | null {
    const types: THREE.TextureDataType[] = [];
    // 32-bit only where it filters and where the extra precision is worth the
    // bandwidth; small (mobile) bakes use half floats.
    if (this.canFloat && res > 1024) types.push(THREE.FloatType);
    if (this.canHalf) types.push(THREE.HalfFloatType);
    if (this.canFloat && res <= 1024) types.push(THREE.FloatType);
    for (const type of types) {
      const rt = new THREE.WebGLRenderTarget(res, res, {
        format: THREE.RGBAFormat,
        type,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
      });
      rt.texture.generateMipmaps = false;
      if (this.complete(rt)) return rt;
      rt.dispose();
    }
    return null;
  }

  private complete(rt: THREE.WebGLRenderTarget): boolean {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevFace = r.getActiveCubeFace();
    const prevMip = r.getActiveMipmapLevel();
    let ok = false;
    try {
      r.setRenderTarget(rt); // allocates the texture and framebuffer
      const gl = r.getContext();
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    } catch {
      ok = false;
    }
    r.setRenderTarget(prev, prevFace, prevMip);
    return ok;
  }
}
