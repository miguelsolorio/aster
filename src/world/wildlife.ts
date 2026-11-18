// Small signs of life: distant circling birds, a lizard that darts off,
// fireflies at night and the odd meteor. Each is a single draw call.
import * as THREE from 'three';
import type { FrameState, SurfaceSample, Uniforms, World } from '../game/contract';
import { STYLE_GLSL } from '../render/styleGlsl';
import { blockedAt, steer, steered, type SolidQuery } from './avoid';

const BIRDS = 3;
const FIREFLIES = 60;
const METEORS = 8;
const METEOR_DIST = 1500;

// ------------------------------------------------------------------ shaders

const birdVert = /* glsl */ `
attribute float aId;
attribute float aFlap;
uniform vec4 uB[${BIRDS}];  // xyz position, w yaw
uniform vec4 uBF[${BIRDS}]; // x flap phase, y flap amplitude, z bank, w scale
varying vec3 vW;
varying float vUp;
void main() {
  int id = int(aId + 0.5);
  vec4 b = uB[id];
  vec4 f = uBF[id];
  vec3 p = position;
  float ax = abs(p.x);
  // wings bend at the shoulder and more at the tip
  p.y += f.y * (0.45 * ax + 0.25 * ax * ax) * sin(f.x - ax * 0.5);
  p.y += 0.12 * ax; // slight dihedral while gliding
  float cb = cos(f.z);
  float sb = sin(f.z);
  p.xy = vec2(cb * p.x - sb * p.y, sb * p.x + cb * p.y);
  float cy = cos(b.w);
  float sy = sin(b.w);
  p.xz = vec2(cy * p.x + sy * p.z, -sy * p.x + cy * p.z);
  vec3 w = b.xyz + p * f.w;
  vW = w;
  vUp = 0.5 + 0.5 * sin(f.x);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const silhouetteFrag = /* glsl */ `
uniform vec3 uFig;
uniform vec3 uFigLit;
uniform vec3 uFogCol;
uniform float uFog;
varying vec3 vW;
varying float vUp;
void main() {
  vec3 col = mix(uFig, uFigLit, 0.15 * vUp);
  float dist = length(vW - cameraPosition);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

const lizardVert = /* glsl */ `
uniform float uTime;
uniform float uRun;
varying vec3 vW;
varying vec3 vN;
void main() {
  vec3 p = position;
  // sideways S-wave down the body; tail swings most
  float tail = clamp(-p.z / 0.22, 0.0, 1.0);
  float amp = uRun * 0.035 + 0.006 + tail * (uRun * 0.05 + 0.01);
  p.x += sin(p.z * 22.0 - uTime * (6.0 + uRun * 28.0)) * amp;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const lizardFrag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uFig;
uniform vec3 uShade;
uniform vec3 uFogCol;
uniform float uFog;
varying vec3 vW;
varying vec3 vN;
${STYLE_GLSL}
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  n = styleFacet(n, vW);
  float l = styleBands(smoothstep(-0.1, 0.4, dot(n, uSunDir)), vW.xz);
  vec3 col = mix(uFig, mix(uFig, uShade, 0.6), l);
  float dist = length(vW - cameraPosition);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

const flyVert = /* glsl */ `
uniform float uTime;
uniform float uNight;
attribute float aPhase;
varying float vA;
void main() {
  vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
  float d = -mv.z;
  float pulse = 0.5 + 0.5 * sin(uTime * (1.1 + aPhase * 0.9) + aPhase * 6.283);
  pulse = pulse * pulse * pulse;
  vA = pulse * smoothstep(0.5, 0.8, uNight) * smoothstep(3.0, 7.0, d);
  gl_PointSize = clamp(260.0 / max(d, 1.0), 1.5, 9.0);
  gl_Position = projectionMatrix * mv;
}
`;

const flyFrag = /* glsl */ `
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.0) * vA;
  gl_FragColor = vec4(vec3(1.0, 0.82, 0.42) * a, 1.0);
}
`;

const meteorVert = /* glsl */ `
attribute float aId;
attribute float aT;    // 0 tail .. 1 head
attribute float aSide; // -1 .. 1 across the streak
uniform vec4 uMA[${METEORS}]; // start dir xyz, life 0..1 (negative = inactive)
uniform vec4 uMB[${METEORS}]; // end dir xyz, brightness
varying float vT;
varying float vSide;
varying float vK;
void main() {
  int id = int(aId + 0.5);
  vec4 A = uMA[id];
  vec4 B = uMB[id];
  if (A.w < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vT = 0.0; vSide = 0.0; vK = 0.0;
    return;
  }
  float life = A.w;
  float head = life;
  float tail = max(0.0, life - 0.4);
  float s = mix(tail, head, aT);
  vec3 dir = normalize(mix(A.xyz, B.xyz, s));
  vec3 tang = normalize(B.xyz - A.xyz);
  vec3 side = normalize(cross(tang, dir));
  vec3 wp = cameraPosition + dir * ${METEOR_DIST.toFixed(1)};
  wp += side * aSide * ${(METEOR_DIST * 0.0016).toFixed(3)} * (0.25 + 0.75 * aT);
  vT = aT;
  vSide = aSide;
  vK = B.w * smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.65, 1.0, life));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const meteorFrag = /* glsl */ `
uniform float uNight;
varying float vT;
varying float vSide;
varying float vK;
void main() {
  float a = pow(vT, 1.6) * (1.0 - abs(vSide)) * vK * smoothstep(0.4, 0.8, uNight);
  gl_FragColor = vec4(vec3(1.0, 0.95, 0.85) * a, 1.0);
}
`;

// ------------------------------------------------------------------ geometry

function birdGeometry(): THREE.BufferGeometry {
  // Body diamond plus two-triangle wings per side, forward = +z, wingspan ~4 m.
  const one: number[] = [
    // body
    0, 0, 0.75, 0.16, 0, 0, 0, 0, -0.65,
    0, 0, 0.75, 0, 0, -0.65, -0.16, 0, 0,
    // tail
    0, 0, -0.45, 0.22, 0, -0.95, -0.22, 0, -0.95,
  ];
  for (const sx of [1, -1]) {
    one.push(
      0, 0, 0.32, sx * 1.05, 0, 0.12, 0, 0, -0.32,
      sx * 1.05, 0, 0.12, sx * 2.0, 0, -0.38, sx * 0.9, 0, -0.32,
      sx * 1.05, 0, 0.12, sx * 0.9, 0, -0.32, 0, 0, -0.32,
    );
  }
  const pos: number[] = [];
  const id: number[] = [];
  const flap: number[] = [];
  for (let b = 0; b < BIRDS; b++) {
    for (let i = 0; i < one.length; i += 3) {
      pos.push(one[i], one[i + 1], one[i + 2]);
      id.push(b);
      flap.push(Math.abs(one[i]));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aId', new THREE.Float32BufferAttribute(id, 1));
  g.setAttribute('aFlap', new THREE.Float32BufferAttribute(flap, 1));
  return g;
}

function lizardGeometry(): THREE.BufferGeometry {
  // ~0.45 m long, forward = +z, feet at y = 0
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.SphereGeometry(0.05, 8, 5);
  body.scale(0.8, 0.45, 2.3);
  body.translate(0, 0.035, 0.03);
  parts.push(body);
  const head = new THREE.SphereGeometry(0.03, 7, 5);
  head.scale(1, 0.7, 1.5);
  head.translate(0, 0.04, 0.16);
  parts.push(head);
  const tail = new THREE.ConeGeometry(0.025, 0.24, 6);
  tail.rotateX(-Math.PI / 2);
  tail.translate(0, 0.025, -0.19);
  parts.push(tail);
  for (const [x, z] of [[1, 0.08], [-1, 0.08], [1, -0.04], [-1, -0.04]]) {
    const leg = new THREE.BoxGeometry(0.07, 0.014, 0.018);
    leg.rotateY(x * (z > 0 ? -0.5 : 0.5));
    leg.translate(x * 0.055, 0.012, z);
    parts.push(leg);
  }
  const pos: number[] = [];
  const v = new THREE.Vector3();
  for (const p of parts) {
    const pa = p.attributes.position as THREE.BufferAttribute;
    const idx = p.index;
    const n = idx ? idx.count : pa.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pa, idx ? idx.getX(i) : i);
      pos.push(v.x, v.y, v.z);
    }
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function meteorGeometry(): THREE.BufferGeometry {
  const id: number[] = [];
  const t: number[] = [];
  const side: number[] = [];
  const pos: number[] = [];
  const index: number[] = [];
  for (let m = 0; m < METEORS; m++) {
    const o = m * 4;
    for (const [tt, ss] of [[0, -1], [0, 1], [1, 1], [1, -1]]) {
      id.push(m);
      t.push(tt);
      side.push(ss);
      pos.push(0, 0, 0);
    }
    index.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aId', new THREE.Float32BufferAttribute(id, 1));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(index);
  return g;
}

// ------------------------------------------------------------------ state

interface Bird {
  cx: number;
  cz: number;
  ox: number; // offset of the circle centre from the player
  oz: number;
  r: number;
  ang: number;
  w: number; // angular speed (signed)
  alt: number;
  ground: number;
  groundT: number;
  flap: number;
  burstPhase: number;
  retarget: number;
}

const UP = new THREE.Vector3(0, 1, 0);

export class Wildlife {
  readonly group = new THREE.Group();

  private readonly world: World;
  private readonly sample: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private inited = false;
  /** What stands in the lizard's way: the top over (x, z) for feet at y, or -Infinity (as the wanderer's roof). Set by the game. */
  solid: SolidQuery | null = null;

  // birds
  private readonly birdMesh: THREE.Mesh;
  private readonly birdA: THREE.Vector4[] = [];
  private readonly birdF: THREE.Vector4[] = [];
  private readonly birds: Bird[] = [];
  private readonly birdCount: number;

  // lizard
  private readonly lizard: THREE.Mesh;
  private readonly lizRun: THREE.IUniform<number> = { value: 0 };
  private lizState = 0; // 0 hidden, 1 waiting, 2 fleeing
  private lizTimer = 20;
  private lizYaw = 0;
  private lizHeading = 0;
  private lizX = 0;
  private lizZ = 0;
  private lizY = 0;
  private lizSide = 1;
  private lizT = 0;
  private lizDur = 0;
  private readonly n = new THREE.Vector3();
  private readonly q1 = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();

  // fireflies
  private readonly flies: THREE.Points;
  private readonly flyPos: Float32Array;
  private readonly flyAttr: THREE.BufferAttribute;
  private readonly fx = new Float32Array(FIREFLIES);
  private readonly fz = new Float32Array(FIREFLIES);
  private readonly fvx = new Float32Array(FIREFLIES);
  private readonly fvz = new Float32Array(FIREFLIES);
  private readonly fg = new Float32Array(FIREFLIES);
  private readonly fh = new Float32Array(FIREFLIES);
  private readonly fph = new Float32Array(FIREFLIES);
  private fliesOn = false;
  private flyRR = 0;

  // meteors
  private readonly meteorMesh: THREE.Mesh;
  private readonly mA: THREE.Vector4[] = [];
  private readonly mB: THREE.Vector4[] = [];
  private readonly mLife = new Float32Array(METEORS);
  private readonly mDur = new Float32Array(METEORS);
  private readonly mDelay = new Float32Array(METEORS);
  private meteorTimer = 25;

  constructor(world: World, uniforms: Uniforms) {
    this.world = world;
    this.group.name = 'wildlife';

    // birds
    for (let i = 0; i < BIRDS; i++) {
      this.birdA.push(new THREE.Vector4(0, -1e5, 0, 0));
      this.birdF.push(new THREE.Vector4(0, 0, 0, 0));
    }
    const birdMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uB: { value: this.birdA }, uBF: { value: this.birdF } },
      vertexShader: birdVert,
      fragmentShader: silhouetteFrag,
      side: THREE.DoubleSide,
    });
    this.birdMesh = new THREE.Mesh(birdGeometry(), birdMat);
    this.birdMesh.frustumCulled = false;
    this.group.add(this.birdMesh);
    const s = world.seed | 0;
    this.birdCount = 1 + (Math.abs(Math.imul(s, 0x9e3779b1) >>> 7) % BIRDS);
    for (let i = 0; i < BIRDS; i++) {
      this.birds.push({
        cx: 0, cz: 0, ox: 0, oz: 0,
        r: 40 + Math.random() * 50,
        ang: Math.random() * Math.PI * 2,
        w: (Math.random() < 0.5 ? -1 : 1) * 0.12,
        alt: 60 + Math.random() * 90,
        ground: 0, groundT: 0,
        flap: Math.random() * 6,
        burstPhase: Math.random() * 6,
        retarget: 0,
      });
    }

    // lizard
    const lizMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uRun: this.lizRun },
      vertexShader: lizardVert,
      fragmentShader: lizardFrag,
      side: THREE.DoubleSide,
    });
    this.lizard = new THREE.Mesh(lizardGeometry(), lizMat);
    this.lizard.visible = false;
    this.lizard.frustumCulled = false;
    this.group.add(this.lizard);
    this.lizTimer = 15 + Math.random() * 30;

    // fireflies
    this.flyPos = new Float32Array(FIREFLIES * 3);
    const phase = new Float32Array(FIREFLIES);
    for (let i = 0; i < FIREFLIES; i++) {
      phase[i] = Math.random();
      this.fph[i] = Math.random() * 6.283;
    }
    const fg = new THREE.BufferGeometry();
    this.flyAttr = new THREE.BufferAttribute(this.flyPos, 3);
    this.flyAttr.setUsage(THREE.DynamicDrawUsage);
    fg.setAttribute('position', this.flyAttr);
    fg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    const flyMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms },
      vertexShader: flyVert,
      fragmentShader: flyFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.flies = new THREE.Points(fg, flyMat);
    this.flies.frustumCulled = false;
    this.flies.visible = false;
    this.group.add(this.flies);

    // meteors
    for (let i = 0; i < METEORS; i++) {
      this.mA.push(new THREE.Vector4(0, 1, 0, -1));
      this.mB.push(new THREE.Vector4(0, 1, 0, 0));
      this.mLife[i] = -1;
    }
    const meteorMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uMA: { value: this.mA }, uMB: { value: this.mB } },
      vertexShader: meteorVert,
      fragmentShader: meteorFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.meteorMesh = new THREE.Mesh(meteorGeometry(), meteorMat);
    this.meteorMesh.frustumCulled = false;
    this.meteorMesh.visible = false;
    this.meteorMesh.renderOrder = 5;
    this.group.add(this.meteorMesh);
  }

  update(f: FrameState): void {
    if (!this.inited) {
      this.inited = true;
      for (const b of this.birds) this.retargetBird(b, f.player.pos.x, f.player.pos.z, true);
    }
    this.updateBirds(f);
    this.updateLizard(f);
    this.updateFlies(f);
    this.updateMeteors(f);
  }

  // ---------------------------------------------------------------- birds

  private retargetBird(b: Bird, px: number, pz: number, snap: boolean): void {
    const a = Math.random() * Math.PI * 2;
    const d = 180 + Math.random() * 250;
    b.ox = Math.cos(a) * d;
    b.oz = Math.sin(a) * d;
    b.retarget = 40 + Math.random() * 60;
    if (snap) {
      b.cx = px + b.ox;
      b.cz = pz + b.oz;
      b.ground = this.world.height(b.cx, b.cz);
    }
  }

  private updateBirds(f: FrameState): void {
    const visible = f.night < 0.55 && f.rain < 0.5;
    this.birdMesh.visible = visible;
    if (!visible) return;
    const dt = f.dt;
    const px = f.player.pos.x;
    const pz = f.player.pos.z;
    const fade = 1 - THREE.MathUtils.smoothstep(f.night, 0.35, 0.55);
    for (let i = 0; i < BIRDS; i++) {
      const b = this.birds[i];
      const A = this.birdA[i];
      const F = this.birdF[i];
      if (i >= this.birdCount) {
        F.w = 0;
        continue;
      }
      b.retarget -= dt;
      if (b.retarget <= 0) this.retargetBird(b, px, pz, false);
      // the circle drifts after the player, slowly
      const tx = px + b.ox - b.cx;
      const tz = pz + b.oz - b.cz;
      const td = Math.sqrt(tx * tx + tz * tz);
      if (td > 2000) {
        this.retargetBird(b, px, pz, true);
      } else if (td > 1) {
        const step = Math.min(td, (2 + td * 0.02) * dt);
        b.cx += (tx / td) * step;
        b.cz += (tz / td) * step;
      }
      b.groundT -= dt;
      if (b.groundT <= 0) {
        b.groundT = 1;
        b.ground = THREE.MathUtils.lerp(b.ground, this.world.height(b.cx, b.cz), 0.3);
      }
      b.ang += b.w * dt;
      const ca = Math.cos(b.ang);
      const sa = Math.sin(b.ang);
      const x = b.cx + ca * b.r;
      const z = b.cz + sa * b.r;
      const y = b.ground + b.alt + Math.sin(b.ang * 0.7 + i) * 4;
      // tangent direction of travel
      const vx = -sa * b.w;
      const vz = ca * b.w;
      A.set(x, y, z, Math.atan2(vx, vz));
      // occasional bursts of flapping between long glides
      b.burstPhase += dt * 0.25;
      const burst = THREE.MathUtils.smoothstep(Math.sin(b.burstPhase), 0.55, 0.85);
      b.flap += dt * (2 + 5 * burst);
      F.x = b.flap;
      F.y = 0.08 + 0.55 * burst;
      F.z = (b.w > 0 ? -1 : 1) * 0.3;
      // keep a readable size at distance
      const ddx = x - f.camera.position.x;
      const ddy = y - f.camera.position.y;
      const ddz = z - f.camera.position.z;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      F.w = Math.max(1, dist / 260) * fade;
    }
  }

  // ---------------------------------------------------------------- lizard

  private updateLizard(f: FrameState): void {
    const dt = f.dt;
    const pl = f.player;
    const w = this.world;
    if (this.lizState === 0) {
      this.lizard.visible = false;
      this.lizRun.value = 0;
      const ok = f.night < 0.3 && pl.grounded && !pl.sliding && pl.speed > 0.8 && pl.onRock < 0.2;
      if (!ok) return;
      this.lizTimer -= dt;
      if (this.lizTimer > 0) return;
      const inv = 1 / Math.max(pl.speed, 1e-3);
      const fx = pl.vel.x * inv;
      const fz = pl.vel.z * inv;
      const d = 10 + Math.random() * 8;
      const side = (Math.random() * 2 - 1) * 3;
      const x = pl.pos.x + fx * d - fz * side;
      const z = pl.pos.z + fz * d + fx * side;
      const s = w.sample(x, z, this.sample);
      if (s.rock > 0.2 || s.salt > 0.3 || (this.solid && blockedAt(this.solid, x, z, s.h))) {
        this.lizTimer = 5;
        return;
      }
      this.lizX = x;
      this.lizZ = z;
      this.lizY = s.h;
      this.lizSide = Math.random() < 0.5 ? 1 : -1;
      this.lizYaw = Math.random() * Math.PI * 2;
      this.lizState = 1;
      this.lizT = 0;
      this.lizard.visible = true;
    }
    const dx = this.lizX - pl.pos.x;
    const dz = this.lizZ - pl.pos.z;
    const d2 = dx * dx + dz * dz;
    let sink = 0;
    if (this.lizState === 1) {
      this.lizT += dt;
      this.lizRun.value = 0;
      if (d2 < 36) {
        this.lizState = 2;
        this.lizT = 0;
        this.lizDur = 2.5 + Math.random() * 1.5;
        this.lizHeading = Math.atan2(dx, dz) + (Math.random() * 2 - 1) * 0.6;
      } else if (d2 > 45 * 45 || this.lizT > 40 || f.night > 0.4) {
        this.hideLizard();
        return;
      }
    }
    if (this.lizState === 2) {
      this.lizT += dt;
      const t = this.lizT;
      this.lizRun.value = 1;
      this.lizYaw = this.lizHeading + Math.sin(t * 9) * 0.45 + Math.sin(t * 3.3) * 0.25;
      const sp = 7 * (1 - THREE.MathUtils.smoothstep(t, this.lizDur - 0.5, this.lizDur));
      const mx = Math.sin(this.lizYaw) * sp * dt;
      const mz = Math.cos(this.lizYaw) * sp * dt;
      if (this.solid) {
        // a stone in the way: it darts round it, and keeps going that way
        if (steer(this.solid, this.lizX, this.lizZ, this.lizY, mx, mz, 0.08, this.lizSide)) {
          this.lizSide = steered.side;
          this.lizHeading += steered.turn !== 0 ? steered.turn : this.lizSide * 1.6;
        }
        this.lizX = steered.x;
        this.lizZ = steered.z;
      } else {
        this.lizX += mx;
        this.lizZ += mz;
      }
      // dives into the sand at the end
      sink = THREE.MathUtils.smoothstep(t, this.lizDur - 0.45, this.lizDur) * 0.12;
      if (t > this.lizDur) {
        this.hideLizard();
        return;
      }
    }
    const y = w.height(this.lizX, this.lizZ);
    this.lizY = y;
    w.normal(this.lizX, this.lizZ, this.n);
    this.q1.setFromUnitVectors(UP, this.n);
    this.q2.setFromAxisAngle(UP, this.lizYaw);
    this.lizard.quaternion.multiplyQuaternions(this.q1, this.q2);
    this.lizard.position.set(this.lizX, y + 0.005 - sink, this.lizZ);
  }

  private hideLizard(): void {
    this.lizState = 0;
    this.lizard.visible = false;
    this.lizTimer = 40 + Math.random() * 50;
  }

  // ---------------------------------------------------------------- fireflies

  private spawnFly(i: number, px: number, pz: number, py: number): void {
    const a = Math.random() * Math.PI * 2;
    const d = 8 + Math.random() * 20;
    this.fx[i] = px + Math.cos(a) * d;
    this.fz[i] = pz + Math.sin(a) * d;
    this.fvx[i] = (Math.random() * 2 - 1) * 0.4;
    this.fvz[i] = (Math.random() * 2 - 1) * 0.4;
    this.fh[i] = 0.4 + Math.random() * 2.6;
    const g = this.world.height(this.fx[i], this.fz[i]);
    this.fg[i] = Number.isFinite(g) ? g : py;
  }

  private updateFlies(f: FrameState): void {
    const on = f.night > 0.45;
    const px = f.player.pos.x;
    const py = f.player.pos.y;
    const pz = f.player.pos.z;
    if (!on) {
      this.fliesOn = false;
      this.flies.visible = false;
      return;
    }
    if (!this.fliesOn) {
      this.fliesOn = true;
      for (let i = 0; i < FIREFLIES; i++) this.spawnFly(i, px, pz, py);
    }
    this.flies.visible = true;
    const dt = f.dt;
    const t = f.time;
    // refresh a few ground heights per frame
    for (let k = 0; k < 6; k++) {
      const i = this.flyRR;
      this.flyRR = (this.flyRR + 1) % FIREFLIES;
      this.fg[i] = THREE.MathUtils.lerp(this.fg[i], this.world.height(this.fx[i], this.fz[i]), 0.5);
    }
    for (let i = 0; i < FIREFLIES; i++) {
      // gentle wander plus a lazy push from the wind
      this.fvx[i] += ((Math.random() * 2 - 1) * 0.8 + f.wind.x * 0.05) * dt;
      this.fvz[i] += ((Math.random() * 2 - 1) * 0.8 + f.wind.y * 0.05) * dt;
      this.fvx[i] *= 1 - 0.3 * dt;
      this.fvz[i] *= 1 - 0.3 * dt;
      let x = this.fx[i] + this.fvx[i] * dt;
      let z = this.fz[i] + this.fvz[i] * dt;
      const dx = x - px;
      const dz = z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 32 * 32) {
        this.spawnFly(i, px, pz, py);
        x = this.fx[i];
        z = this.fz[i];
      } else if (d2 < 36) {
        const d = Math.sqrt(d2) + 1e-3;
        this.fvx[i] += (dx / d) * 1.5 * dt;
        this.fvz[i] += (dz / d) * 1.5 * dt;
      }
      this.fx[i] = x;
      this.fz[i] = z;
      const o = i * 3;
      this.flyPos[o] = x;
      this.flyPos[o + 1] = this.fg[i] + this.fh[i] + Math.sin(t * 0.7 + this.fph[i]) * 0.4;
      this.flyPos[o + 2] = z;
    }
    this.flyAttr.needsUpdate = true;
  }

  // ---------------------------------------------------------------- meteors

  private launchMeteor(i: number, az: number, el: number, delay: number): void {
    const A = this.mA[i];
    const B = this.mB[i];
    const ce = Math.cos(el);
    A.set(Math.cos(az) * ce, Math.sin(el), Math.sin(az) * ce, -1);
    // travel 10..25 degrees, mostly sideways and downward
    const len = (10 + Math.random() * 15) * (Math.PI / 180);
    const dirA = Math.random() * Math.PI * 2;
    const az2 = az + Math.cos(dirA) * len / Math.max(ce, 0.3);
    const el2 = Math.max(0.12, el - Math.abs(Math.sin(dirA)) * len - len * 0.3);
    const ce2 = Math.cos(el2);
    B.set(Math.cos(az2) * ce2, Math.sin(el2), Math.sin(az2) * ce2, 0.5 + Math.random() * 0.5);
    this.mLife[i] = 0;
    this.mDur[i] = 0.5 + Math.random() * 0.7;
    this.mDelay[i] = delay;
  }

  private updateMeteors(f: FrameState): void {
    const dt = f.dt;
    let active = false;
    for (let i = 0; i < METEORS; i++) {
      if (this.mLife[i] < 0) continue;
      if (this.mDelay[i] > 0) {
        this.mDelay[i] -= dt;
        this.mA[i].w = -1;
        active = true;
        continue;
      }
      this.mLife[i] += dt / this.mDur[i];
      if (this.mLife[i] >= 1) {
        this.mLife[i] = -1;
        this.mA[i].w = -1;
        continue;
      }
      this.mA[i].w = this.mLife[i];
      active = true;
    }
    this.meteorMesh.visible = active;
    if (f.night < 0.6) return;
    this.meteorTimer -= dt;
    if (this.meteorTimer > 0) return;
    this.meteorTimer = 20 + Math.random() * 40;
    const shower = Math.random() < 0.25;
    const count = shower ? 3 + Math.floor(Math.random() * 4) : 1;
    const az0 = Math.random() * Math.PI * 2;
    const el0 = 0.6 + Math.random() * 0.6;
    let launched = 0;
    for (let i = 0; i < METEORS && launched < count; i++) {
      if (this.mLife[i] >= 0) continue;
      const az = az0 + (shower ? (Math.random() * 2 - 1) * 0.5 : 0);
      const el = el0 + (shower ? (Math.random() * 2 - 1) * 0.25 : 0);
      this.launchMeteor(i, az, el, launched === 0 ? 0 : Math.random() * 3);
      launched++;
    }
    if (launched > 0) this.meteorMesh.visible = true;
  }
}
