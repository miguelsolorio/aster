import * as THREE from 'three';
import { makeHeightFn } from '../world/height';
import { buildHeightMap, buildTerrain } from '../world/terrain';
import { buildFigureGeometry } from '../world/figure';
import { Trail } from '../world/trail';
import { figFrag, figVert, postFrag, postVert, sandFrag, sandVert, skyFrag, skyVert } from './shaders';
import { DEFAULTS, type Pal, type Params, type Style } from './types';

type U = Record<string, THREE.IUniform>;

const SEED = 7;
const VIEW_ANGLE = 0.6; // radians, direction the gallery camera looks
const FOV = 38;

const hex = (s: string, out: THREE.Vector3) => {
  const n = parseInt(s.slice(1), 16);
  return out.set(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

// Per time of day: [day, sunset, night]
const SUN_AZ = [1.2, 0.42, -0.95]; // radians right of the view direction
const SUN_EL = [0.42, 0.17, 0.45];
const SUN_SIZE = [0.03, 0.045, 0.04];
const GLOW = [1, 1.6, 0.5];
const STARS = [0, 0.06, 1];
const KEYS = ['day', 'sunset', 'night'] as const;

const cap = (k: string) => 'u' + k[0].toUpperCase() + k.slice(1);

/** Owns the one WebGL renderer and the gallery scene; renders any style at any time of day. */
export class Stage {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1.6, 0.5, 9000);
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private targets = new Map<string, THREE.WebGLRenderTarget>();
  private u: U = {};
  private postU: U;
  private smooth: THREE.Mesh;
  private facet: THREE.Mesh;
  private sky: THREE.Mesh;
  private figPos = new THREE.Vector3();
  private camBase = new THREE.Vector3();
  private lookBase = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private heightAt: (x: number, z: number) => number;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = true;
    this.canvas = this.renderer.domElement;

    const h = makeHeightFn(SEED);
    this.heightAt = h;

    // Stand the figure on a small crest that looks out at taller dunes:
    // score each local peak and view angle by how high the terrain ahead rises in frame.
    let best = -Infinity;
    let viewAngle = VIEW_ANGLE;
    for (let x = -480; x <= 480; x += 8) {
      for (let z = -480; z <= 480; z += 8) {
        const y = h(x, z);
        if (h(x + 6, z) > y || h(x - 6, z) > y || h(x, z + 6) > y || h(x, z - 6) > y) continue;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          let s = 0;
          for (const off of [-0.3, 0, 0.3]) {
            let maxAng = -1;
            for (let d = 60; d <= 700; d += 25) {
              maxAng = Math.max(maxAng, (h(x + Math.cos(a + off) * d, z + Math.sin(a + off) * d) - (y + 2.5)) / d);
            }
            s -= Math.abs(maxAng - 0.1);
          }
          if (h(x - Math.cos(a) * 17, z - Math.sin(a) * 17) > y - 0.5) s -= 1;
          if (s > best) {
            best = s;
            viewAngle = a;
            this.figPos.set(x, y, z);
          }
        }
      }
    }
    const F = this.figPos;
    this.fwd.set(Math.cos(viewAngle), 0, Math.sin(viewAngle));
    this.right.set(-this.fwd.z, 0, this.fwd.x);

    // Shared uniforms: one value object per name, referenced by every material.
    const v3 = () => ({ value: new THREE.Vector3() });
    const u = this.u;
    u.uTime = { value: 0 };
    for (const k of ['uSunDir', 'uTop', 'uHorizon', 'uLit', 'uShade', 'uSunCol', 'uFogCol', 'uLine', 'uFig', 'uFigLit', 'uInk', 'uPaperCol', 'uA', 'uB', 'uFigPos']) {
      u[k] = v3();
    }
    u.uSunSize = { value: 0.03 };
    u.uGlow = { value: 1 };
    u.uStars = { value: 0 };
    u.uWind = { value: new THREE.Vector2(this.right.x, this.right.z) };
    for (const k of Object.keys(DEFAULTS)) {
      if (k !== 'glow') u[cap(k)] = { value: 0 };
    }
    u.uFigPos.value.copy(F);

    // Terrain: dense near the figure, coarse toward a 2 km edge. One heightmap for cast shadows.
    const hm = buildHeightMap(h, F.x, F.z, 4096, 1024);
    const trail = new Trail(F.x, F.z, 96, 2048);
    const path: Array<[number, number]> = [];
    for (let s = 46; s >= 0.4; s -= 0.5) {
      const side = Math.sin(s * 0.08) * 3 + s * 0.12;
      path.push([F.x - this.fwd.x * s + this.right.x * side, F.z - this.fwd.z * s + this.right.z * side]);
    }
    trail.walk(path);

    const sandU: U = {
      ...u,
      uHeightMap: { value: hm.texture },
      uRect: { value: new THREE.Vector3(...hm.rect) },
      uTexel: { value: hm.texel },
      uTrail: { value: trail.texture },
      uTrailRect: { value: new THREE.Vector3(...trail.rect) },
    };
    const sandMat = new THREE.ShaderMaterial({ uniforms: sandU, vertexShader: sandVert, fragmentShader: sandFrag });
    this.smooth = new THREE.Mesh(buildTerrain(h, F.x, F.z, { res: 480, half: 2048, linear: 0.06 }), sandMat);
    this.facet = new THREE.Mesh(buildTerrain(h, F.x, F.z, { res: 96, half: 2048, linear: 0.12 }), sandMat);
    this.smooth.frustumCulled = this.facet.frustumCulled = false;
    this.scene.add(this.smooth, this.facet);

    const fig = new THREE.Mesh(
      buildFigureGeometry(),
      new THREE.ShaderMaterial({ uniforms: u, vertexShader: figVert, fragmentShader: figFrag }),
    );
    fig.position.set(F.x, F.y - 0.05, F.z);
    fig.rotation.y = Math.atan2(this.fwd.x, this.fwd.z);
    fig.frustumCulled = false;
    this.scene.add(fig);

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: u,
        vertexShader: skyVert,
        fragmentShader: skyFrag,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.sky.scale.setScalar(5000);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.postU = { ...u, tColor: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } };
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({ uniforms: this.postU, vertexShader: postVert, fragmentShader: postFrag, depthTest: false, depthWrite: false }),
    );
    quad.frustumCulled = false;
    this.postScene.add(quad);

    // Camera: behind and above the figure, figure left of centre, trail in the foreground.
    this.camBase.copy(F).addScaledVector(this.fwd, -19).addScaledVector(this.right, 3.5);
    this.camBase.y = Math.max(F.y + 3.2, h(this.camBase.x, this.camBase.z) + 2.2);
    this.lookBase.copy(F).addScaledVector(this.fwd, 40).addScaledVector(this.right, 9);
    this.lookBase.y = F.y - 1.5;
  }

  private target(w: number, h: number): THREE.WebGLRenderTarget {
    const key = `${w}x${h}`;
    let rt = this.targets.get(key);
    if (!rt) {
      // Keep at most a few sizes alive (tiles and the full view).
      if (this.targets.size > 3) {
        for (const t of this.targets.values()) t.dispose();
        this.targets.clear();
      }
      rt = new THREE.WebGLRenderTarget(w, h, { samples: 4, depthBuffer: true });
      rt.depthTexture = new THREE.DepthTexture(w, h);
      rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
      rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
      this.targets.set(key, rt);
    }
    return rt;
  }

  private applyStyle(style: Style, tod: number) {
    const u = this.u;
    const t = Math.min(2, Math.max(0, tod));
    const i = Math.min(1, Math.floor(t));
    const f = t - i;
    const lerp = (a: number, b: number) => a + (b - a) * f;
    const ink = style.ink ?? '#1a1410';
    const paper = style.paperCol ?? '#f4ecdc';
    const pa = style.pal[KEYS[i]];
    const pb = style.pal[KEYS[i + 1]];
    const col = (name: string, get: (p: Pal) => string) => {
      hex(get(pa), this.tmpA);
      hex(get(pb), this.tmpB);
      (u[name].value as THREE.Vector3).copy(this.tmpA).lerp(this.tmpB, f);
    };
    col('uTop', (p) => p.top);
    col('uHorizon', (p) => p.horizon);
    col('uLit', (p) => p.lit);
    col('uShade', (p) => p.shade);
    col('uSunCol', (p) => p.sun);
    col('uFogCol', (p) => p.fog ?? p.horizon);
    col('uLine', (p) => p.line ?? ink);
    col('uA', (p) => p.a ?? ink);
    col('uB', (p) => p.b ?? paper);
    hex(ink, u.uInk.value);
    hex(paper, u.uPaperCol.value);
    hex(style.fig ?? '#1c1512', u.uFig.value);
    (u.uFigLit.value as THREE.Vector3).copy(u.uFig.value).lerp(u.uLit.value, 0.4);

    const p: Params = { ...DEFAULTS, ...style.p };
    for (const k of Object.keys(DEFAULTS) as Array<keyof Params>) {
      if (k !== 'glow') u[cap(k)].value = p[k];
    }
    u.uSunSize.value = lerp(SUN_SIZE[i], SUN_SIZE[i + 1]) * p.sunScale;
    u.uGlow.value = lerp(GLOW[i], GLOW[i + 1]) * p.glow;
    u.uStars.value = lerp(STARS[i], STARS[i + 1]) * p.starAmt;

    const dir = (k: number, out: THREE.Vector3) => {
      const ce = Math.cos(SUN_EL[k]);
      return out
        .set(0, Math.sin(SUN_EL[k]), 0)
        .addScaledVector(this.fwd, ce * Math.cos(SUN_AZ[k]))
        .addScaledVector(this.right, ce * Math.sin(SUN_AZ[k]));
    };
    dir(i, this.tmpA);
    dir(i + 1, this.tmpB);
    (u.uSunDir.value as THREE.Vector3).copy(this.tmpA).lerp(this.tmpB, f).normalize();

    this.smooth.visible = p.facet < 0.5;
    this.facet.visible = p.facet >= 0.5;
  }

  /**
   * Renders one style into `canvas` at w x h device pixels.
   * tod: 0 = day, 1 = sunset, 2 = night. drift: seconds of slow camera movement (0 = fixed).
   */
  render(style: Style, tod: number, time: number, w: number, h: number, drift = 0) {
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    this.applyStyle(style, tod);
    this.u.uTime.value = time;

    const cam = this.camera;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    const a = Math.sin(drift * 0.11) * 0.22;
    cam.position
      .copy(this.camBase)
      .addScaledVector(this.right, Math.sin(a) * 19)
      .addScaledVector(this.fwd, (1 - Math.cos(a)) * 19);
    cam.position.y = Math.max(this.camBase.y + Math.sin(drift * 0.07) * 0.6, this.heightAt(cam.position.x, cam.position.z) + 1.8);
    cam.lookAt(this.lookBase);
    this.sky.position.copy(cam.position);

    if (this.canvas.width !== w || this.canvas.height !== h) this.renderer.setSize(w, h, false);
    const rt = this.target(w, h);
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, cam);
    this.postU.tColor.value = rt.texture;
    this.postU.tDepth.value = rt.depthTexture;
    (this.postU.uRes.value as THREE.Vector2).set(w, h);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCam);
  }
}
