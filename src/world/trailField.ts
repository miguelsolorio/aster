// TrailField: the sand remembers footprints, slides and landings.
// Disturbance depth (0..1) lives in two scrolling 8-bit render-target cascades
// centred on the player. Uniform convention: uv = (xz - origin) / size,
// u grows with world x, v grows with world z.
import * as THREE from 'three';
import { warmObjects } from '../render/warm';
import type { Uniforms } from '../game/contract';

const RES = 1024;
const TAU = 180; // seconds, wind fill-in time constant
const MAX_STAMPS = 256;

interface Cascade {
  size: number; // metres covered
  texel: number; // metres per texel
  step: number; // seconds between decay passes
  blur: number; // blur mix per decay pass
  minRadius: number; // stamp radius floor (m)
  strScale: number; // stamp strength multiplier
  rts: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  read: number; // index of the current texture
  ix: number; // snapped centre, in whole texels
  iz: number;
  accum: number; // time since the last decay pass
  steps: number; // decay pass counter (dither seed)
  texU: THREE.IUniform;
  rectU: THREE.IUniform;
}

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// Scroll + decay: new(uv) = old(uv + uOffset) * decay. Outside the old texture is 0.
const SCROLL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tMap;
uniform vec2 uOffset;   // uv shift between old and new texture
uniform float uDecay;   // 1.0 = exact copy (no blur, no dither)
uniform float uBlur;
uniform float uSeed;
uniform float uTexel;   // 1/RES
varying vec2 vUv;

float fetch(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return texture2D(tMap, uv).r;
}
void main() {
  vec2 uv = vUv + uOffset;
  float v = fetch(uv);
  if (uDecay < 1.0) {
    if (uBlur > 0.0) {
      float n = fetch(uv + vec2(uTexel, 0.0)) + fetch(uv - vec2(uTexel, 0.0))
              + fetch(uv + vec2(0.0, uTexel)) + fetch(uv - vec2(0.0, uTexel));
      v = mix(v, n * 0.25, uBlur);
    }
    // Dithered rounding: unbiased in expectation, so marks do not stall at low
    // 8-bit values and every mark eventually reaches exactly 0.
    float r = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uSeed) * 43758.5453);
    v = floor(v * uDecay * 255.0 + r) / 255.0;
  }
  gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
}`;

// Instanced stamp quads: iStamp = (x, z, radius, strength), iOrient = (heading, aspect).
const STAMP_VERT = /* glsl */ `
attribute vec4 iStamp;
attribute vec2 iOrient;
uniform vec2 uOrigin;
uniform float uSize;
uniform float uMinRadius;
uniform float uStrScale;
varying vec2 vLocal;
varying float vStrength;
void main() {
  vLocal = position.xy;
  vStrength = iStamp.w * uStrScale;
  float hw = max(iStamp.z, uMinRadius);
  float hl = max(iStamp.z * iOrient.y, uMinRadius);
  vec2 d = vec2(cos(iOrient.x), sin(iOrient.x));
  vec2 p = vec2(-d.y, d.x);
  vec2 w = iStamp.xy + d * (position.x * hl) + p * (position.y * hw);
  gl_Position = vec4((w - uOrigin) / uSize * 2.0 - 1.0, 0.0, 1.0);
}`;

const STAMP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vLocal;
varying float vStrength;
void main() {
  float a = 1.0 - smoothstep(0.4, 1.0, length(vLocal));
  gl_FragColor = vec4(a * vStrength, 0.0, 0.0, 1.0);
}`;

function holder(u: Uniforms, key: string, init: unknown): THREE.IUniform {
  if (!u[key]) u[key] = { value: init };
  return u[key];
}

export class TrailField {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly cascades: Cascade[];
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly scrollScene = new THREE.Scene();
  private readonly stampScene = new THREE.Scene();
  private readonly scrollMat: THREE.ShaderMaterial;
  private readonly stampMat: THREE.ShaderMaterial;
  private readonly stampGeo = new THREE.InstancedBufferGeometry();
  private readonly stampData = new Float32Array(MAX_STAMPS * 6);
  private readonly instBuf: THREE.InstancedInterleavedBuffer;
  private count = 0;
  private readonly clearColor = new THREE.Color();

  constructor(renderer: THREE.WebGLRenderer, uniforms: Uniforms) {
    this.renderer = renderer;

    const makeRT = () => {
      const rt = new THREE.WebGLRenderTarget(RES, RES, {
        format: THREE.RedFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      rt.texture.generateMipmaps = false;
      return rt;
    };
    const make = (size: number, step: number, blur: number, minRadius: number, strScale: number, names: [string, string]): Cascade => ({
      size, texel: size / RES, step, blur, minRadius, strScale,
      rts: [makeRT(), makeRT()], read: 0, ix: 0, iz: 0, accum: 0, steps: 0,
      texU: holder(uniforms, names[0], null),
      rectU: holder(uniforms, names[1], new THREE.Vector3()),
    });
    this.cascades = [
      make(51.2, 0.25, 0.04, 0, 1, ['uTrailNear', 'uTrailNearRect']),
      make(409.6, 0.5, 0, 0.5, 0.75, ['uTrailFar', 'uTrailFarRect']),
    ];

    // Fullscreen scroll/decay pass.
    this.scrollMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: SCROLL_FRAG,
      uniforms: {
        tMap: { value: null }, uOffset: { value: new THREE.Vector2() }, uDecay: { value: 1 },
        uBlur: { value: 0 }, uSeed: { value: 0 }, uTexel: { value: 1 / RES },
      },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.scrollMat);
    quad.frustumCulled = false;
    this.scrollScene.add(quad);

    // Instanced stamps with MAX blending.
    const g = this.stampGeo;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    // One per-instance interleaved buffer: iStamp (0..3), iOrient (4..5).
    const inst = new THREE.InstancedInterleavedBuffer(this.stampData, 6, 1);
    inst.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iStamp', new THREE.InterleavedBufferAttribute(inst, 4, 0));
    g.setAttribute('iOrient', new THREE.InterleavedBufferAttribute(inst, 2, 4));
    this.instBuf = inst;
    g.instanceCount = 0;

    this.stampMat = new THREE.ShaderMaterial({
      vertexShader: STAMP_VERT,
      fragmentShader: STAMP_FRAG,
      uniforms: {
        uOrigin: { value: new THREE.Vector2() }, uSize: { value: 1 },
        uMinRadius: { value: 0 }, uStrScale: { value: 1 },
      },
      depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation, blendEquationAlpha: THREE.MaxEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    const mesh = new THREE.Mesh(g, this.stampMat);
    mesh.frustumCulled = false;
    this.stampScene.add(mesh);

    this.clear();
    for (const c of this.cascades) this.publish(c);
    warmObjects(this.scrollScene, this.stampScene); // compiled before play (see render/warm.ts)
  }

  /** Queue a soft elliptical stamp (world metres). heading = atan2(dz, dx), aspect = length/width. */
  stamp(x: number, z: number, radius: number, strength: number, heading = 0, aspect = 1): void {
    if (this.count >= MAX_STAMPS) return;
    const o = this.count++ * 6;
    const d = this.stampData;
    d[o] = x; d[o + 1] = z; d[o + 2] = radius;
    d[o + 3] = Math.min(1, Math.max(0, strength));
    d[o + 4] = heading; d[o + 5] = Math.max(0.01, aspect);
  }

  /** Once per frame: re-centre, decay, draw queued stamps, swap. */
  update(dt: number, cx: number, cz: number): void {
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this.clearColor);
    r.autoClear = false;

    this.instBuf.needsUpdate = this.count > 0;
    this.stampGeo.instanceCount = this.count;

    for (const c of this.cascades) {
      const ix = Math.round(cx / c.texel);
      const iz = Math.round(cz / c.texel);
      const scrolled = ix !== c.ix || iz !== c.iz;
      c.accum += dt;
      const decayDue = c.accum >= c.step;

      if (scrolled || decayDue) {
        const m = this.scrollMat.uniforms;
        const w = c.rts[1 - c.read];
        m.tMap.value = c.rts[c.read].texture;
        // New texel (i,j) reads old texel (i + shift): uv offset in whole texels.
        (m.uOffset.value as THREE.Vector2).set((ix - c.ix) / RES, (iz - c.iz) / RES);
        if (decayDue) {
          m.uDecay.value = Math.exp(-c.accum / TAU);
          m.uBlur.value = c.blur;
          m.uSeed.value = (++c.steps % 997) * 1.37;
          c.accum = 0;
        } else {
          m.uDecay.value = 1; // pure scroll: exact copy, no rounding loss
        }
        r.setRenderTarget(w);
        r.render(this.scrollScene, this.camera);
        c.read = 1 - c.read;
        c.ix = ix; c.iz = iz;
      }

      if (this.count > 0) {
        const s = this.stampMat.uniforms;
        (s.uOrigin.value as THREE.Vector2).set(c.ix * c.texel - c.size / 2, c.iz * c.texel - c.size / 2);
        s.uSize.value = c.size;
        s.uMinRadius.value = c.minRadius;
        s.uStrScale.value = c.strScale;
        r.setRenderTarget(c.rts[c.read]);
        r.render(this.stampScene, this.camera);
      }
      this.publish(c);
    }

    this.count = 0;
    r.setRenderTarget(prevRT);
    r.autoClear = prevAuto;
    r.setClearColor(this.clearColor, prevAlpha);
  }

  /** Point the shared uniforms at the cascade's current texture and rect. */
  private publish(c: Cascade): void {
    c.texU.value = c.rts[c.read].texture;
    (c.rectU.value as THREE.Vector3).set(c.ix * c.texel - c.size / 2, c.iz * c.texel - c.size / 2, c.size);
  }

  clear(): void {
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this.clearColor);
    r.setClearColor(0x000000, 0);
    for (const c of this.cascades) {
      for (const rt of c.rts) {
        r.setRenderTarget(rt);
        r.clear(true, false, false);
      }
      c.accum = 0;
    }
    this.count = 0;
    r.setRenderTarget(prevRT);
    r.setClearColor(this.clearColor, prevAlpha);
  }

  dispose(): void {
    for (const c of this.cascades) for (const rt of c.rts) rt.dispose();
    this.scrollMat.dispose();
    this.stampMat.dispose();
    this.stampGeo.dispose();
    this.scrollScene.children.forEach((o) => (o as THREE.Mesh).geometry.dispose());
  }
}
