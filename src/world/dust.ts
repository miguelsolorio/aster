// Sand particle effects: puffs/spray, crest spindrift, ambient motes.
import * as THREE from 'three';
import type { FrameState, SurfaceSample, Uniforms, World } from '../game/contract';

// ---- Tunables ----
const CAPACITY = 1500;
const STRIDE = 16; // floats per particle
const GRAVITY = 3.0; // m/s^2 at grav scale 1 ("light")
const WIND_DRIFT = 0.5; // m/s extra drift along uWind
const MAX_POINT_PX = 72;
const PUFF_ALPHA = 0.5;
const SPRAY_ALPHA = 0.4;
const SPINDRIFT_ALPHA = 0.26;
const SPINDRIFT_PROBES = 12; // terrain probes per frame
const SPINDRIFT_MIN_R = 15;
const SPINDRIFT_MAX_R = 90;
const SPINDRIFT_DROP = 0.8; // m of height drop over SPINDRIFT_SPAN
const SPINDRIFT_SPAN = 4;
const SPINDRIFT_RATE = 3.2; // particles per probe hit at full gust
const MOTE_COUNT = 200;
const MOTE_BOX = 40;
const MOTE_ALPHA = 0.16;
const MOTE_SIZE = 0.035; // metres

const PARTICLE_VERT = /* glsl */ `
attribute float aBirth;
attribute vec4 aV;   // velocity xyz, life
attribute vec4 aM;   // size, seed, drag, grav scale
attribute float aAlpha;
uniform float uTime;
uniform vec2 uWind;
uniform float uScale;
uniform float uFog;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uLit;
uniform vec3 uShade;
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
  float k = max(aM.z, 0.01);
  float e = (1.0 - exp(-k * age)) / k;
  vec3 p = position + aV.xyz * e;
  p.xz += uWind * (${WIND_DRIFT.toFixed(2)} * age);
  p.y -= 0.5 * ${GRAVITY.toFixed(2)} * aM.w * age * age;
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 0.1);
  float u = age / life;
  float grow = 1.0 + 1.6 * sqrt(u);
  gl_PointSize = clamp(aM.x * grow * uScale / dist, 0.0, ${MAX_POINT_PX.toFixed(1)});
  float fadeIn = smoothstep(0.0, 0.05, u);
  float fadeOut = 1.0 - smoothstep(0.08, 1.0, u);
  vec3 vd = normalize(wp - cameraPosition);
  float back = pow(max(dot(vd, uSunDir), 0.0), 3.0);
  // (an alpha above 2 marks dust hanging low and thick enough to read dark against the sand under it)
  float low = step(2.0, aAlpha);
  vAlpha = (aAlpha - 2.0 * low) * fadeIn * fadeOut * mix(fadeOut, 1.0, low) * (1.0 + 1.8 * back * (1.0 - low)) * (1.0 - 0.5 * uNight);
  vec3 col = mix(mix(uShade, uLit, 0.7 + 0.3 * back), uShade * 0.9, low);
  float fog = (1.0 - exp(-dist * uFog)) * 0.6;
  vCol = mix(col, uFogCol, fog);
}
`;

const PARTICLE_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vCol;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  float a = (1.0 - d2);
  if (a <= 0.0) discard;
  a *= a;
  gl_FragColor = vec4(vCol, vAlpha * a);
}
`;

const MOTE_VERT = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uScale;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uLit;
uniform vec3 uSunCol;
uniform float uFog;
uniform vec3 uFogCol;
varying float vAlpha;
varying vec3 vCol;
void main() {
  float B = ${MOTE_BOX.toFixed(1)};
  vec3 s = position; // 0..1 random
  vec3 base = s * B;
  base.xz += uWind * (0.35 * uTime);
  base += 0.4 * vec3(sin(uTime * 0.31 + s.y * 40.0), sin(uTime * 0.23 + s.z * 31.0), cos(uTime * 0.27 + s.x * 37.0));
  vec3 rel = mod(base - cameraPosition + 0.5 * B, B) - 0.5 * B;
  vec3 wp = cameraPosition + rel;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 0.1);
  gl_PointSize = clamp(${MOTE_SIZE.toFixed(3)} * (0.6 + s.x) * uScale / dist, 1.0, 6.0);
  float edge = 1.0 - smoothstep(0.35 * B, 0.5 * B, max(max(abs(rel.x), abs(rel.y)), abs(rel.z)));
  vec3 vd = normalize(rel);
  float sunward = pow(max(dot(vd, uSunDir), 0.0), 2.0);
  float tw = 0.7 + 0.3 * sin(uTime * 1.3 + s.x * 90.0);
  vAlpha = ${MOTE_ALPHA.toFixed(3)} * edge * tw * (0.5 + 2.0 * sunward) * (1.0 - 0.7 * uNight);
  vCol = mix(mix(uLit, uSunCol, 0.5), uFogCol, (1.0 - exp(-dist * uFog)) * 0.4);
}
`;

export class Dust {
  readonly group = new THREE.Group();

  private readonly world: World;
  private readonly uniforms: Uniforms;
  private readonly data = new Float32Array(CAPACITY * STRIDE);
  private readonly buffer = new THREE.InterleavedBuffer(this.data, STRIDE);
  private readonly points: THREE.Points;
  private readonly motes: THREE.Points;
  private readonly scaleU = { value: 800 };

  private density = 1;
  private next = 0;
  private dirtyMin = Infinity;
  private dirtyMax = -1;

  private readonly surf: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpSide = new THREE.Vector3();

  constructor(world: World, uniforms: Uniforms) {
    this.world = world;
    this.uniforms = uniforms;

    // Dead until spawned: birth far in the past.
    for (let i = 0; i < CAPACITY; i++) {
      this.data[i * STRIDE + 3] = -1e6;
      this.data[i * STRIDE + 7] = 1;
    }
    this.buffer.setUsage(THREE.DynamicDrawUsage);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    geo.setAttribute('aBirth', new THREE.InterleavedBufferAttribute(this.buffer, 1, 3));
    geo.setAttribute('aV', new THREE.InterleavedBufferAttribute(this.buffer, 4, 4));
    geo.setAttribute('aM', new THREE.InterleavedBufferAttribute(this.buffer, 4, 8));
    geo.setAttribute('aAlpha', new THREE.InterleavedBufferAttribute(this.buffer, 1, 12));
    geo.setDrawRange(0, CAPACITY);

    const mat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uScale: this.scaleU },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.group.add(this.points);

    // Ambient motes: positions are random 0..1 seeds, wrapped in the shader.
    const mp = new Float32Array(MOTE_COUNT * 3);
    for (let i = 0; i < mp.length; i++) mp[i] = Math.random();
    const mgeo = new THREE.BufferGeometry();
    mgeo.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    const mmat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uScale: this.scaleU },
      vertexShader: MOTE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });
    this.motes = new THREE.Points(mgeo, mmat);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 4;
    this.group.add(this.motes);
  }

  /**
   * 0..1 scale on how many particles each puff, spray and spindrift probe pass
   * spawns, and on how many ambient motes are drawn. 1 = full (default).
   */
  setDensity(s: number): void {
    const d = Math.min(1, Math.max(0, Number.isFinite(s) ? s : 1));
    this.density = d;
    this.motes.geometry.setDrawRange(0, Math.round(MOTE_COUNT * d));
  }

  private now(): number {
    const t = this.uniforms.uTime?.value as number | undefined;
    return typeof t === 'number' ? t : 0;
  }

  private spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, drag: number, grav: number, alpha: number,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % CAPACITY;
    const o = i * STRIDE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = this.now();
    d[o + 4] = vx; d[o + 5] = vy; d[o + 6] = vz; d[o + 7] = life;
    d[o + 8] = size; d[o + 9] = Math.random(); d[o + 10] = drag; d[o + 11] = grav;
    d[o + 12] = alpha;
    if (i < this.dirtyMax) {
      // ring wrapped within the frame: upload everything
      this.dirtyMin = 0;
      this.dirtyMax = CAPACITY - 1;
    } else {
      if (i < this.dirtyMin) this.dirtyMin = i;
      this.dirtyMax = i;
    }
  }

  /** A burst of sand at a world position. */
  puff(pos: THREE.Vector3, dir: THREE.Vector3, amount: number): void {
    const a = Math.min(Math.max(amount, 0), 1);
    const d = this.density;
    if (d <= 0) return;
    const n = Math.max(1, Math.round((5 + a * 22 + Math.random() * 2) * d));
    const dl = Math.hypot(dir.x, dir.y, dir.z);
    const inv = dl > 1e-4 ? 1 / dl : 0;
    const dx = dir.x * inv, dy = dir.y * inv, dz = dir.z * inv;
    const base = 0.35 + a * 1.6;
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const r = Math.random();
      const sp = base * (0.4 + r);
      const vx = Math.cos(th) * sp * 0.6 + dx * sp * 0.8;
      const vz = Math.sin(th) * sp * 0.6 + dz * sp * 0.8;
      const vy = (0.3 + Math.random() * 0.7) * base * 0.9 + dy * sp * 0.5;
      this.spawn(
        pos.x + (Math.random() - 0.5) * 0.25, pos.y + 0.04, pos.z + (Math.random() - 0.5) * 0.25,
        vx, vy, vz,
        0.6 + Math.random() * (0.6 + a * 0.6),
        0.1 + a * 0.16 + Math.random() * 0.08,
        2.2, 0.7, PUFF_ALPHA * (0.6 + 0.4 * a),
      );
    }
  }

  /**
   * Sand that hangs and turns slowly in one place: over a hollow the air does not carry it off
   * as it does everywhere else. Call every frame with dt; (x, y, z) is the middle of the patch.
   */
  wisp(x: number, y: number, z: number, radius: number, dt: number): void {
    if (Math.random() > dt * 9 * this.density) return;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    // a slow turn about the middle, barely rising
    const sp = 0.12 + Math.random() * 0.2;
    this.spawn(
      x + Math.cos(a) * r, y + 0.06 + Math.random() * 0.2, z + Math.sin(a) * r,
      -Math.sin(a) * sp, 0.05 + Math.random() * 0.1, Math.cos(a) * sp,
      3.5 + Math.random() * 2.5,
      0.3 + Math.random() * 0.25,
      0.2, 0.0, 2 + 0.3,
    );
  }

  /** Continuous spray while sliding: rooster tail behind and to the sides. */
  spray(pos: THREE.Vector3, vel: THREE.Vector3, amount: number): void {
    const a = Math.min(Math.max(amount, 0), 1);
    const sp = Math.hypot(vel.x, vel.z);
    if (sp < 0.1 || a <= 0) return;
    // stochastic rounding keeps the average rate at low density (identical at 1)
    const n = Math.floor((1 + a * 4) * this.density + Math.random());
    const bx = -vel.x / sp, bz = -vel.z / sp; // backwards
    const sx = -bz, sz = bx; // sideways
    const t = this.tmpDir, s = this.tmpSide;
    t.set(bx, 0, bz);
    s.set(sx, 0, sz);
    for (let i = 0; i < n; i++) {
      const side = (Math.random() * 2 - 1);
      const back = 0.25 + Math.random() * 0.6;
      const k = Math.min(sp, 14);
      const vx = (t.x * back + s.x * side * 0.9) * k * 0.35;
      const vz = (t.z * back + s.z * side * 0.9) * k * 0.35;
      const vy = (0.6 + Math.random() * 1.3) * (0.6 + a * 0.6) * (0.5 + k * 0.08);
      this.spawn(
        pos.x + s.x * side * 0.3, pos.y + 0.05, pos.z + s.z * side * 0.3,
        vx, vy, vz,
        0.7 + Math.random() * 0.9,
        0.1 + a * 0.1 + Math.random() * 0.07,
        1.8, 0.8, SPRAY_ALPHA * (0.6 + 0.4 * a),
      );
    }
  }

  /** The wanderer is underground: no wind reaches there, and no sunlit motes hang in the air. */
  under = false;

  update(f: FrameState): void {
    this.motes.visible = !this.under;
    // Pixel scale for size attenuation.
    const cam = f.camera;
    const h = typeof window !== 'undefined' ? window.innerHeight * Math.min(window.devicePixelRatio || 1, 2) : 1080;
    this.scaleU.value = h / (2 * Math.tan((cam.fov * Math.PI) / 360));

    if (!this.under) this.spindrift(f);

    if (this.dirtyMax >= 0) {
      const b = this.buffer;
      b.clearUpdateRanges();
      b.addUpdateRange(this.dirtyMin * STRIDE, (this.dirtyMax - this.dirtyMin + 1) * STRIDE);
      b.needsUpdate = true;
      this.dirtyMin = Infinity;
      this.dirtyMax = -1;
    }
  }

  private spindrift(f: FrameState): void {
    const gust = f.gust;
    if (gust < 0.05) return;
    const w = this.world;
    const wx = f.wind.x, wz = f.wind.y;
    const px = f.player.pos.x, pz = f.player.pos.z;
    const s = this.surf;
    // fewer probes at low density: fewer particles and less CPU terrain sampling
    const probes = this.density >= 1 ? SPINDRIFT_PROBES : Math.floor(SPINDRIFT_PROBES * this.density + Math.random());
    for (let i = 0; i < probes; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = SPINDRIFT_MIN_R + Math.random() * (SPINDRIFT_MAX_R - SPINDRIFT_MIN_R);
      const x = px + Math.cos(ang) * r;
      const z = pz + Math.sin(ang) * r;
      const h0 = w.height(x, z);
      const h1 = w.height(x + wx * SPINDRIFT_SPAN, z + wz * SPINDRIFT_SPAN);
      if (h0 - h1 < SPINDRIFT_DROP) continue;
      w.sample(x, z, s);
      if (s.rock >= 0.3 || s.salt >= 0.3) continue;
      const n = Math.floor(gust * SPINDRIFT_RATE * (0.5 + Math.random()) + Math.random());
      for (let k = 0; k < n; k++) {
        const speed = 2.0 + gust * 3.0 + Math.random() * 1.5;
        this.spawn(
          x + (Math.random() - 0.5) * 2.0, h0 + 0.1 + Math.random() * 0.25, z + (Math.random() - 0.5) * 2.0,
          wx * speed + (Math.random() - 0.5) * 0.4, 0.4 + Math.random() * 0.7, wz * speed + (Math.random() - 0.5) * 0.4,
          2 + Math.random() * 2,
          0.12 + Math.random() * 0.12,
          0.35, 0.04, SPINDRIFT_ALPHA,
        );
      }
    }
  }
}
