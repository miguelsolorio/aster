import * as THREE from 'three';
import type { PlayerState, Uniforms } from './contract';

// The wanderer: a dark hooded traveller. A cone robe with a ragged hem, two thin
// legs, a plain white face and a round hood.
// Local space: feet at y = 0, facing +z. Legs and arms are posed on the CPU; the
// robe is shaped and fluttered in the vertex shader.

const bodyVert = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const robeVert = /* glsl */ `
uniform float uTime;
uniform float uFlow;      // 0 hanging .. 1+ streaming straight back
uniform vec2 uLocalWind;  // wind in the figure's local x, z
uniform float uSpread;    // 0 hanging .. 1 flared wide
uniform float uStep;      // signed stride, swings the hem with the legs
attribute vec2 aUV;       // x: -1..1 around the body (0 = front), y: 0 collar .. 1 hem
varying vec3 vW;
varying vec3 vN;
void main() {
  vec3 p = position;
  float v = aUV.y;
  float w = v * v;
  float ang = aUV.x * 3.14159265;
  float back = 0.5 - 0.5 * cos(ang);
  vec3 radial = normalize(vec3(p.x, 0.0, p.z) + vec3(0.0, 0.0, 1e-3));

  // stream back and up with speed; the back of the hem goes furthest
  p.z -= w * uFlow * (0.16 + 0.5 * back);
  p.y += w * uFlow * 0.2 * back;
  p.x *= 1.0 - w * min(uFlow, 1.0) * 0.22 * (1.0 - uSpread) + uSpread * v * 0.9;
  p.y += uSpread * w * 0.1;

  // the hem follows the legs
  p.x += uStep * w * 0.05 * cos(ang);
  p.z += uStep * w * 0.04 * sin(ang);

  // lean with the wind
  p.x += uLocalWind.x * w * 0.16;
  p.z += uLocalWind.y * w * 0.16;

  // travelling waves, bigger toward the hem and with speed
  float t = uTime * (3.0 + uFlow * 6.0);
  float ph = v * 6.0 - t + ang * 2.0;
  p += radial * sin(ph) * 0.03 * w * (0.5 + uFlow * 1.8);
  p.y += sin(v * 9.0 - t * 1.3 + ang * 3.0) * 0.02 * w * uFlow;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vW = wp.xyz;
  vec3 nl = radial + vec3(0.0, 1.0, 0.0) * (0.24 + uFlow * w * 0.5 * back - cos(ph) * 0.3 * w * (0.5 + uFlow * 1.8));
  vN = normalize(mat3(modelMatrix) * nl);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const frag = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uFig;
uniform vec3 uFigLit;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uNight;
uniform float uBody;   // 0 = dark cloth .. 1 = the white face
uniform float uTone;   // 0 = the dress, near-black .. 1 = the cloak, a shade warmer
varying vec3 vW;
varying vec3 vN;
void main() {
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 n = normalize(vN);
  float inside = 1.0;
  if (dot(n, V) < 0.0) {
    n = -n;
    inside = 0.75;
  }
  float ndl = dot(n, uSunDir);
  float l = smoothstep(-0.1, 0.35, ndl);
  // cloth: a warm near-black that only just takes the light
  vec3 sh = uFig * mix(0.36, 0.66, uTone);
  vec3 li = mix(uFig, uFigLit, mix(0.03, 0.2, uTone));
  vec3 dark = mix(sh, li, l * 0.85) * inside;
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * smoothstep(-0.2, 0.3, ndl);
  dark += uSunCol * rim * 0.08 * (1.0 - 0.5 * uNight);
  // face: flat white, tinted by the light and dimmed at night
  vec3 white = vec3(0.97, 0.95, 0.9) * mix(vec3(1.0), uSunCol, 0.3) * (1.0 - 0.42 * uNight) * mix(0.84, 1.0, l);
  vec3 col = mix(dark, white, uBody);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

const HIP = 0.78;
const THIGH = 0.39;
const SHIN = 0.39;
const COLLAR = 1.42;
const HEM = 0.4;
const HEAD_Y = 1.55;
const HEAD_R = 0.125;

interface Drape {
  top: number; // collar height
  hem: number; // hem height
  r0: number; // radius at the collar
  r1: number; // radius at the hem
  curve: number; // > 1 hangs straight then flares, < 1 swells early
  arc: number; // half-angle covered, PI = closed all the way round
  rag: number; // depth of the tears in the hem
  flat: number; // front-to-back squash
}

/** A hanging cloth: a bell from collar to hem with a torn edge, closed or open at the front. */
function drapeGeometry(d: Drape): THREE.BufferGeometry {
  const NU = 44;
  const NV = 16;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const closed = d.arc >= Math.PI - 1e-3;
  const rag = (i: number) => {
    const k = closed ? i % NU : i;
    const h = Math.sin(k * 127.1 + d.top * 31.7) * 43758.5453;
    return k % 2 === 0 ? d.rag * (0.3 + 0.7 * (h - Math.floor(h))) : 0;
  };
  for (let j = 0; j <= NV; j++) {
    const v = j / NV;
    for (let i = 0; i <= NU; i++) {
      const a = ((i / NU) * 2 - 1) * d.arc;
      // an open cloth hangs a little longer at the back than at its front edges
      const drop = closed ? 0 : 0.1 * v * (0.5 - 0.5 * Math.cos(a));
      const r = d.r0 + (d.r1 - d.r0) * Math.pow(v, d.curve);
      const y = d.top - v * (d.top - d.hem) - drop - (j === NV ? rag(i) : 0);
      pos.push(Math.sin(a) * r, y, Math.cos(a) * r * d.flat);
      uv.push(a / Math.PI, v);
    }
  }
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const a = j * (NU + 1) + i;
      const b = a + 1;
      const c = a + NU + 1;
      const e = c + 1;
      idx.push(a, c, b, b, c, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// The dress: narrow through the body, flaring late into a wide torn hem at mid-shin.
const DRESS: Drape = { top: COLLAR, hem: HEM, r0: 0.075, r1: 0.35, curve: 1.25, arc: Math.PI, rag: 0.11, flat: 0.88 };
// The cloak: a mantle off the shoulders to the knee, open down the front, one piece with the hood.
const CLOAK: Drape = { top: COLLAR + 0.03, hem: 0.74, r0: 0.09, r1: 0.25, curve: 0.85, arc: 2.35, rag: 0.07, flat: 0.92 };

const SHOULDER_Y = 1.3 - HIP;
const DOWN = new THREE.Vector3(0, -1, 0);

export class Figure {
  readonly group = new THREE.Group();
  private hips: THREE.Group[] = [];
  private knees: THREE.Group[] = [];
  private arms: THREE.Group[] = []; // [right, left]
  private tmp = new THREE.Vector3();
  private torso = new THREE.Group();
  private flow = { value: 0 };
  private spreadU = { value: 0 };
  private stepU = { value: 0 };
  private pitch = 0;
  private localWind = { value: new THREE.Vector2() };
  private cycle = 0;
  private amp = 0;
  private slide = 0;
  private air = 0;
  private glide = 0;
  private rise = 0;
  private flare = 0;
  private lean = 0;
  private bank = 0;
  private time = 0;

  constructor(u: Uniforms) {
    this.group.rotation.order = 'YXZ';
    const mat = (body: number, tone = 0, extra: Uniforms = {}, vert = bodyVert, side: THREE.Side = THREE.FrontSide) =>
      new THREE.ShaderMaterial({
        uniforms: { ...u, uBody: { value: body }, uTone: { value: tone }, ...extra },
        vertexShader: vert,
        fragmentShader: frag,
        side,
      });
    const cloth = mat(0);
    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.frustumCulled = false;
      parent.add(mesh);
      return mesh;
    };

    // legs: thin sticks. hip pivot (hidden up inside the robe) -> thigh -> knee pivot -> shin and foot
    for (const sx of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(sx * 0.065, HIP, 0);
      add(hip, new THREE.CylinderGeometry(0.022, 0.019, THIGH, 6).translate(0, -THIGH / 2, 0), cloth);
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      add(knee, new THREE.CylinderGeometry(0.019, 0.016, SHIN - 0.01, 6).translate(0, -(SHIN - 0.01) / 2, 0), cloth);
      add(knee, new THREE.BoxGeometry(0.042, 0.028, 0.13).translate(0, -SHIN + 0.014, 0.04), cloth);
      hip.add(knee);
      this.group.add(hip);
      this.hips.push(hip);
      this.knees.push(knee);
    }

    // robe, head, hood and arms all ride on one group so the body can lean from the hips
    const t = this.torso;
    t.position.y = HIP;
    this.group.add(t);
    const cloth2 = { uFlow: this.flow, uLocalWind: this.localWind, uSpread: this.spreadU, uStep: this.stepU };
    add(t, drapeGeometry(DRESS).translate(0, -HIP, 0), mat(0, 0, cloth2, robeVert, THREE.DoubleSide));
    add(t, drapeGeometry(CLOAK).translate(0, -HIP, 0), mat(0, 1, cloth2, robeVert, THREE.DoubleSide));
    add(t, new THREE.SphereGeometry(HEAD_R, 24, 16).translate(0, HEAD_Y - HIP, 0.035), mat(1));
    // hood: a plain round cowl set a little behind the head, so the face shows as a disc
    add(t, new THREE.SphereGeometry(0.155, 24, 16).scale(1, 1.03, 1).translate(0, HEAD_Y - HIP + 0.01, -0.03), mat(0, 1));

    for (const sx of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(sx * 0.09, SHOULDER_Y, 0);
      add(arm, new THREE.CylinderGeometry(0.02, 0.017, 1, 6).translate(0, -0.5, 0), cloth);
      t.add(arm);
      this.arms.push(arm);
    }
  }

  /** Stretch an arm from its shoulder to a point in torso space. */
  private reach(arm: THREE.Group, x: number, y: number, z: number, thick: number) {
    const d = this.tmp.set(x, y, z).sub(arm.position);
    const len = Math.max(0.05, d.length());
    arm.quaternion.setFromUnitVectors(DOWN, d.divideScalar(len));
    arm.scale.set(thick, len, thick);
    arm.visible = thick > 0.03;
  }

  /**
   * Pose the figure for this frame.
   * m.turn: turning rate in rad/s, positive to the figure's left.
   * m.slopeAlong: rise over run of the ground in the direction of travel.
   * m.gliding: floating down on the glide. m.lifting: climbing on a held jump.
   * m.alt: height above the ground in metres.
   */
  update(
    dt: number,
    st: PlayerState,
    facing: number,
    wind: THREE.Vector2,
    gust: number,
    m: { turn: number; slopeAlong: number; gliding: boolean; lifting: boolean; alt: number },
  ) {
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    const walking = st.grounded && !st.sliding;
    const strideLen = st.running ? 1.15 : 0.8;
    if (walking) this.cycle += (st.speed * dt) / (2 * strideLen);
    const a = this.cycle * Math.PI * 2;
    this.time += dt;
    const t = this.time;

    const ampT = walking ? Math.min(0.85, 0.12 * st.speed) : 0;
    this.amp += (ampT - this.amp) * k(10);
    // ride: 0 standing .. 1 flying along the sand. Eases in with speed so the pose never snaps.
    const rideT = st.sliding && st.grounded ? Math.min(1, Math.max(0, (st.speed - 1) / 6)) : 0;
    this.slide += (rideT - this.slide) * k(4);
    this.air += ((st.grounded ? 0 : 1) - this.air) * k(6);
    // In the air the figure stays upright: a jump on the way up, a long floating fall on the glide.
    this.glide += ((m.gliding ? 1 : 0) - this.glide) * k(4);
    const glide = this.glide;
    const riseT = !st.grounded && (m.lifting || st.vel.y > 1) ? 1 : 0;
    this.rise += (riseT - this.rise) * k(5);
    const rise = this.rise;
    // Close to the ground on the way down, the legs swing forward to meet it.
    const flareT = !st.grounded && st.vel.y < 0 && m.alt < 1.4 ? 1 : 0;
    this.flare += (flareT - this.flare) * k(flareT ? 9 : 6);
    const flare = this.flare;
    const air = this.air;
    // The hem flares wide on the glide.
    this.spreadU.value = glide * 0.6;
    this.stepU.value = Math.sin(this.cycle * Math.PI * 2) * this.amp;
    const fly = Math.max(this.slide, air);

    // bank like a bird, harder at speed
    const bankT = Math.max(-0.55, Math.min(0.55, m.turn * (0.14 + st.speed * 0.016)));
    this.bank += (bankT - this.bank) * k(4);
    const sway = Math.sin(t * 1.3) * 0.025 + Math.sin(t * 2.1 + 1) * 0.012;

    const s = Math.sin(a);
    const c = Math.cos(a);
    for (let i = 0; i < 2; i++) {
      const sg = i === 0 ? 1 : -1; // +1 is the figure's right side
      // walking on rock: thighs swing opposite, the knee folds while its leg comes forward
      let thigh = -sg * s * this.amp * 0.8;
      let knee = Math.max(0, sg * c) * this.amp * 1.5 + this.amp * 0.12;
      // flying: legs long and together, one a touch behind the other, trailing in the air
      const fThigh = 0.05 * sg + sway * sg;
      const fKnee = 0.07;
      thigh += (fThigh - thigh) * this.slide;
      knee += (fKnee - knee) * this.slide;
      // in the air: a jump. One knee tucked on the way up, both legs trailing a little
      // on the glide, then swung forward for the landing.
      const lead = sg > 0 ? 1 : 0;
      let aThigh = 0.1 + 0.06 * sg + sway * sg + rise * (lead ? -0.5 : 0.22) + glide * 0.14;
      let aKnee = 0.2 + rise * (lead ? 0.75 : 0.15) + glide * 0.1;
      aThigh += (-0.5 - 0.1 * sg - aThigh) * flare;
      aKnee += (0.45 - aKnee) * flare;
      thigh += (aThigh - thigh) * air;
      knee += (aKnee - knee) * air;
      this.hips[i].rotation.x = thigh;
      this.knees[i].rotation.x = knee;

    }

    // The arms stay inside the robe until the glide, then open out for balance.
    const tip = this.bank * 0.5 * fly;
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -1 : 1;
      this.reach(this.arms[i], sx * (0.12 + 0.4 * glide), 0.1 + 0.34 * glide + sx * tip * 0.3 + sway, -0.06 * glide, glide * air);
    }

    // Lean: forward from the ankles on the sand, more with speed and when diving down a face;
    // upright in the air, with a modest forward lean on the glide.
    const slopeTilt = -Math.atan(m.slopeAlong) * 0.7;
    const groundLean = this.slide * (0.26 + Math.min(0.3, st.speed * 0.013)) + this.slide * slopeTilt + (1 - this.slide) * Math.min(0.12, st.speed * 0.012);
    const airLean = (0.07 + glide * 0.24 * Math.min(1, st.speed / 10)) * (1 - flare);
    const pitchT = st.grounded ? groundLean : airLean;
    this.pitch += (pitchT - this.pitch) * k(5);

    this.torso.rotation.x = Math.sin(a * 2) * 0.02 * this.amp - this.air * 0.1;
    this.torso.rotation.y = s * 0.09 * this.amp;
    this.torso.rotation.z = c * 0.03 * this.amp;

    const g = this.group;
    g.rotation.set(this.pitch, facing, -this.bank * Math.max(this.slide, air * 0.5) + sway * fly);
    g.position.copy(st.pos);
    g.position.y += -0.03 - Math.abs(s) * 0.045 * this.amp;
    // In the air, turn about the hips so the body stays centred on the flight path.
    const sf = Math.sin(facing);
    const cf = Math.cos(facing);
    const off = this.air * HIP;
    g.position.x -= sf * Math.sin(this.pitch) * off;
    g.position.z -= cf * Math.sin(this.pitch) * off;
    g.position.y += (1 - Math.cos(this.pitch)) * off;

    // Robe: sways in the walk, streams back when riding, flares when gliding.
    const flowT = Math.min(1.25, this.slide * 0.55 + st.speed / 24 + this.air * 0.45 + gust * 0.08 + Math.abs(this.bank) * 0.3);
    this.flow.value += (flowT - this.flow.value) * k(3.5);
    const str = 0.45 + gust * 0.9;
    this.localWind.value.set((wind.x * cf - wind.y * sf) * str - this.bank * 1.6, (wind.x * sf + wind.y * cf) * str);
  }
}
