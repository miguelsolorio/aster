// Water answering the wanderer: droplets thrown up by feet and landings, and rings that
// spread across the surface from where it was broken.
import * as THREE from 'three';
import type { FrameState, Uniforms } from '../game/contract';

const DROPS = 500;
const STRIDE = 10; // position 3, birth 1, velocity 3, life 1, size 1, spare 1
const RINGS = 40;
const GRAVITY = 9.5;

const DROP_VERT = /* glsl */ `
attribute float aBirth;
attribute vec4 aV; // velocity xyz, life
attribute float aSize;
uniform float uTime;
uniform float uScale;
uniform float uFog;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uFogCol;
varying float vAlpha;
varying vec3 vCol;
void main() {
  float age = uTime - aBirth;
  float life = aV.w;
  if (age < 0.0 || age > life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0; vCol = vec3(0.0);
    return;
  }
  // thrown, slowed a little by the air, and pulled back down
  float e = (1.0 - exp(-1.2 * age)) / 1.2;
  vec3 p = position + aV.xyz * e;
  p.y -= 0.5 * ${GRAVITY.toFixed(1)} * age * age;
  // never below the surface it came from
  p.y = max(p.y, position.y - 0.02);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 0.1);
  float u = age / life;
  gl_PointSize = clamp(aSize * (1.0 - 0.5 * u) * uScale / dist, 2.0, 26.0);
  vec3 vd = normalize(p - cameraPosition);
  float back = pow(max(dot(vd, uSunDir), 0.0), 4.0);
  // water has no colour of its own: it shows the sky, and flashes against the light
  vec3 col = mix(uHorizon, uTop, 0.35) * 0.75 + vec3(0.32);
  col += uSunCol * back * 0.8 * (1.0 - 0.7 * uNight);
  col *= 1.0 - 0.45 * uNight;
  float fog = (1.0 - exp(-dist * uFog)) * 0.6;
  vCol = mix(col, uFogCol, fog);
  vAlpha = 0.85 * smoothstep(0.0, 0.04, u) * (1.0 - smoothstep(0.6, 1.0, u));
}
`;

const DROP_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vCol;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = 1.0 - dot(c, c) * 4.0;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vCol, vAlpha * smoothstep(0.0, 0.5, a));
}
`;

const RING_VERT = /* glsl */ `
attribute vec4 aRing; // centre xyz, birth
attribute vec2 aGrow; // final radius, life
uniform float uTime;
varying vec2 vUv;
varying float vAge;
varying float vDist;
void main() {
  float age = (uTime - aRing.w) / aGrow.y;
  vAge = age;
  vUv = position.xy;
  if (age < 0.0 || age > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vDist = 0.0;
    return;
  }
  vec3 wp = aRing.xyz + vec3(position.x, 0.0, position.y) * aGrow.x;
  vDist = length(wp - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uNight;
varying vec2 vUv;
varying float vAge;
varying float vDist;
float band(float r, float at, float w) {
  return smoothstep(at - w, at, r) * (1.0 - smoothstep(at, at + w * 0.6, r));
}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  // the first ring runs out fast and slows; a second follows inside it
  float out1 = sqrt(vAge);
  float out2 = sqrt(max(vAge - 0.22, 0.0)) * 0.8;
  float w = 0.05 + 0.07 * vAge;
  float a = band(r, out1 * 0.94, w) + 0.6 * band(r, out2 * 0.94, w) * step(0.22, vAge);
  a *= (1.0 - vAge) * (1.0 - vAge);
  if (a < 0.004) discard;
  vec3 col = mix(uHorizon, uTop, 0.3) * 0.7 + vec3(0.38);
  col *= 1.0 - 0.45 * uNight;
  col = mix(col, uFogCol, (1.0 - exp(-vDist * uFog)) * 0.7);
  gl_FragColor = vec4(col, min(a, 1.0) * 0.6);
}
`;

export class Splash {
  readonly group = new THREE.Group();

  private readonly uniforms: Uniforms;
  private readonly data = new Float32Array(DROPS * STRIDE);
  private readonly buffer = new THREE.InterleavedBuffer(this.data, STRIDE);
  private readonly ringA = new Float32Array(RINGS * 4);
  private readonly ringB = new Float32Array(RINGS * 2);
  private readonly ringAttrA: THREE.InstancedBufferAttribute;
  private readonly ringAttrB: THREE.InstancedBufferAttribute;
  private readonly scaleU = { value: 800 };
  private next = 0;
  private nextRing = 0;
  private dirty = false;
  private density = 1;

  constructor(uniforms: Uniforms) {
    this.uniforms = uniforms;
    this.group.name = 'splash';
    for (let i = 0; i < DROPS; i++) {
      this.data[i * STRIDE + 3] = -1e6;
      this.data[i * STRIDE + 7] = 1;
    }
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    geo.setAttribute('aBirth', new THREE.InterleavedBufferAttribute(this.buffer, 1, 3));
    geo.setAttribute('aV', new THREE.InterleavedBufferAttribute(this.buffer, 4, 4));
    geo.setAttribute('aSize', new THREE.InterleavedBufferAttribute(this.buffer, 1, 8));
    const drops = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        uniforms: { ...uniforms, uScale: this.scaleU },
        vertexShader: DROP_VERT,
        fragmentShader: DROP_FRAG,
        transparent: true,
        depthWrite: false,
      }),
    );
    drops.frustumCulled = false;
    drops.renderOrder = 6;

    for (let i = 0; i < RINGS; i++) {
      this.ringA[i * 4 + 3] = -1e6;
      this.ringB[i * 2] = 1;
      this.ringB[i * 2 + 1] = 1;
    }
    const rgeo = new THREE.InstancedBufferGeometry();
    rgeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    rgeo.setIndex([0, 2, 1, 0, 3, 2]);
    this.ringAttrA = new THREE.InstancedBufferAttribute(this.ringA, 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    this.ringAttrB = new THREE.InstancedBufferAttribute(this.ringB, 2).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    rgeo.setAttribute('aRing', this.ringAttrA);
    rgeo.setAttribute('aGrow', this.ringAttrB);
    rgeo.instanceCount = RINGS;
    const rings = new THREE.Mesh(
      rgeo,
      new THREE.ShaderMaterial({
        uniforms: { ...uniforms },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        // the river is painted on its bed, so the rings lie on the ground itself
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    );
    rings.frustumCulled = false;
    rings.renderOrder = 3;
    this.group.add(rings, drops);
  }

  /** 0..1 scale on how many droplets a splash throws. */
  setDensity(d: number): void {
    this.density = Math.min(1, Math.max(0.3, d));
  }

  private now(): number {
    return (this.uniforms.uTime?.value as number) ?? 0;
  }

  /**
   * Droplets thrown from a point on the surface. amount 0..1 sets how many and how high;
   * (vx, vz) is the way the thing that broke the water was moving, which the spray leans along.
   */
  burst(x: number, y: number, z: number, vx: number, vz: number, amount: number): void {
    const a = Math.min(1, Math.max(0, amount));
    const n = Math.max(2, Math.round((4 + a * 46) * this.density));
    const up = 1.6 + a * 4.6;
    const d = this.data;
    const t = this.now();
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      // a crown: most of it goes out and up at a slant, a little straight up
      const out = (0.5 + Math.random()) * (0.7 + a * 2.2);
      const o = this.next * STRIDE;
      this.next = (this.next + 1) % DROPS;
      const r = Math.random() * (0.08 + a * 0.3);
      d[o] = x + Math.cos(th) * r;
      d[o + 1] = y + 0.02;
      d[o + 2] = z + Math.sin(th) * r;
      d[o + 3] = t;
      d[o + 4] = Math.cos(th) * out + vx * 0.25;
      d[o + 5] = up * (0.35 + Math.random() * 0.75);
      d[o + 6] = Math.sin(th) * out + vz * 0.25;
      d[o + 7] = 0.35 + Math.random() * (0.3 + a * 0.5);
      d[o + 8] = 0.05 + Math.random() * (0.04 + a * 0.07);
    }
    this.dirty = true;
  }

  /** A ring spreading on the surface to the given radius over life seconds. */
  ring(x: number, y: number, z: number, radius: number, life: number): void {
    const i = this.nextRing;
    this.nextRing = (i + 1) % RINGS;
    this.ringA[i * 4] = x;
    this.ringA[i * 4 + 1] = y + 0.015;
    this.ringA[i * 4 + 2] = z;
    this.ringA[i * 4 + 3] = this.now();
    this.ringB[i * 2] = radius;
    this.ringB[i * 2 + 1] = life;
    this.ringAttrA.needsUpdate = true;
    this.ringAttrB.needsUpdate = true;
  }

  update(f: FrameState): void {
    const h = typeof window !== 'undefined' ? window.innerHeight * Math.min(window.devicePixelRatio || 1, 2) : 1080;
    this.scaleU.value = h / (2 * Math.tan((f.camera.fov * Math.PI) / 360));
    if (this.dirty) {
      this.buffer.needsUpdate = true;
      this.dirty = false;
    }
  }
}
