import * as THREE from 'three';
import type { PlayerState, Uniforms } from './contract';

// The wanderer: a hooded walker with legs, arms and a cape that streams behind.
// Local space: feet at y = 0, facing +z. Body parts are posed on the CPU; the
// cape is a cloth sheet shaped and fluttered in the vertex shader.

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

const capeVert = /* glsl */ `
uniform float uTime;
uniform float uFlow;      // 0 hanging .. 1+ streaming straight back
uniform vec2 uLocalWind;  // wind in the figure's local x, z
uniform float uSpread;    // 0 hanging .. 1 opened out like a wing
attribute vec2 aUV;       // x: -1..1 around the shoulders, y: 0 collar .. 1 hem
varying vec3 vW;
varying vec3 vN;
void main() {
  vec3 p = position;
  float v = aUV.y;
  float w = v * v;
  vec3 radial = normalize(vec3(p.x, 0.0, p.z) + vec3(0.0, 0.0, -1e-3));

  // stream back and up with speed, and draw the sides in
  p.z -= w * uFlow * 0.62;
  p.y += w * uFlow * 0.24;
  p.x *= 1.0 - w * min(uFlow, 1.0) * 0.3 * (1.0 - uSpread) + uSpread * v * 1.1;
  p.y += uSpread * w * 0.12;

  // lean with the wind
  p.x += uLocalWind.x * w * 0.2;
  p.z += uLocalWind.y * w * 0.2;

  // travelling waves, bigger toward the hem and with speed
  float t = uTime * (3.5 + uFlow * 6.0);
  float wave = sin(v * 7.0 - t + aUV.x * 2.5) * 0.045 + sin(v * 13.0 - t * 1.7 + aUV.x * 5.0) * 0.02;
  p += radial * wave * w * (0.7 + uFlow * 1.6);
  p.y += sin(v * 9.0 - t * 1.3 + aUV.x * 4.0) * 0.02 * w * uFlow;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vW = wp.xyz;
  // smooth cloth normal: outward, tilted by the fold slope and by how far the cape is lifted
  vec3 nl = radial + vec3(0.0, 1.0, 0.0) * (uFlow * w * 0.5 - cos(v * 7.0 - t + aUV.x * 2.5) * 0.4 * w * (0.7 + uFlow * 1.6));
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
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uNight;
uniform float uBody;   // 0 = dark cloak cloth .. 1 = sand-coloured
uniform float uDeriv;  // 1 = take the normal from screen-space derivatives (cloth)
varying vec3 vW;
varying vec3 vN;
void main() {
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 nd = normalize(cross(dFdx(vW), dFdy(vW)));
  vec3 n = uDeriv > 0.5 ? nd : normalize(vN);
  float inside = 1.0;
  if (dot(n, V) < 0.0) {
    n = -n;
    inside = 0.8;
  }
  float ndl = dot(n, uSunDir);
  float l = smoothstep(-0.1, 0.35, ndl);
  vec3 sh = mix(uFig, uShade, uBody);
  vec3 li = mix(uFigLit, uLit, uBody * 0.7);
  vec3 col = mix(sh, li, l * 0.85) * inside;
  // a thin rim of light so the silhouette holds against dark dunes
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * smoothstep(-0.2, 0.3, ndl);
  col += uSunCol * rim * 0.12 * (1.0 - 0.5 * uNight);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

const HIP = 0.92;
const THIGH = 0.46;
const SHIN = 0.46;

function capeGeometry(): THREE.BufferGeometry {
  const NU = 28;
  const NV = 20;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= NV; j++) {
    const v = j / NV;
    for (let i = 0; i <= NU; i++) {
      const u = (i / NU) * 2 - 1;
      const a = u * 1.95; // wraps from the back round to the front of each shoulder
      const r = 0.215 + (0.37 - 0.215) * Math.pow(v, 0.8) + 0.02 * Math.sin(a * 5) * v;
      pos.push(Math.sin(a) * r, 1.45 - v * 1.14, -Math.cos(a) * r * 0.82 - 0.02);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const a = j * (NU + 1) + i;
      const b = a + 1;
      const c = a + NU + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export class Figure {
  readonly group = new THREE.Group();
  private hips: THREE.Group[] = [];
  private knees: THREE.Group[] = [];
  private arms: THREE.Group[] = [];
  private torso = new THREE.Group();
  private flow = { value: 0 };
  private spreadU = { value: 0 };
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
    const mat = (body: number, extra: Uniforms = {}, vert = bodyVert, deriv = 0, side: THREE.Side = THREE.FrontSide) =>
      new THREE.ShaderMaterial({
        uniforms: { ...u, uBody: { value: body }, uDeriv: { value: deriv }, ...extra },
        vertexShader: vert,
        fragmentShader: frag,
        side,
      });
    const cloth = mat(0);
    const clothes = mat(0.42);
    const boots = mat(0.08);
    const skin = mat(0.2);
    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.frustumCulled = false;
      parent.add(mesh);
      return mesh;
    };

    // legs: hip pivot -> thigh -> knee pivot -> shin and boot
    for (const sx of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(sx * 0.095, HIP, 0);
      add(hip, new THREE.CylinderGeometry(0.095, 0.072, THIGH, 10).translate(0, -THIGH / 2, 0), clothes);
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      add(knee, new THREE.SphereGeometry(0.072, 10, 8), clothes);
      add(knee, new THREE.CylinderGeometry(0.07, 0.056, SHIN - 0.06, 10).translate(0, -(SHIN - 0.06) / 2, 0), boots);
      add(knee, new THREE.BoxGeometry(0.1, 0.075, 0.25).translate(0, -SHIN + 0.04, 0.055), boots);
      hip.add(knee);
      this.group.add(hip);
      this.hips.push(hip);
      this.knees.push(knee);
    }

    // torso, shoulders, arms, head and hood all ride on one group so the body can lean
    const t = this.torso;
    t.position.y = HIP;
    this.group.add(t);
    add(t, new THREE.CylinderGeometry(0.155, 0.135, 0.5, 12).scale(1, 1, 0.72).translate(0, 0.25, 0), clothes);
    add(t, new THREE.SphereGeometry(0.14, 12, 8).scale(1, 0.6, 0.75), clothes); // hips
    add(t, new THREE.SphereGeometry(0.2, 14, 8).scale(1.08, 0.42, 0.62).translate(0, 0.5, 0), cloth); // shoulders
    add(t, new THREE.TorusGeometry(0.095, 0.05, 8, 16).rotateX(Math.PI / 2).translate(0, 0.58, 0.01), cloth); // scarf
    for (const sx of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(sx * 0.2, 0.5, 0);
      add(arm, new THREE.CylinderGeometry(0.052, 0.04, 0.56, 8).translate(0, -0.28, 0), clothes);
      add(arm, new THREE.SphereGeometry(0.045, 8, 6).translate(0, -0.58, 0), skin);
      t.add(arm);
      this.arms.push(arm);
    }
    add(t, new THREE.SphereGeometry(0.108, 14, 10).translate(0, 0.72, 0.012), skin); // face, in the hood's shadow
    // hood: a shell open at the front
    add(
      t,
      new THREE.SphereGeometry(0.15, 20, 14, Math.PI / 2 + 0.62, Math.PI * 2 - 1.24).scale(1, 1.08, 1.1).translate(0, 0.725, -0.012),
      mat(0, {}, bodyVert, 0, THREE.DoubleSide),
    );
    add(t, new THREE.ConeGeometry(0.1, 0.34, 12).translate(0, 0.17, 0).rotateX(-2.5).translate(0, 0.8, -0.09), cloth);

    add(t, capeGeometry().translate(0, -HIP, 0), mat(0, { uFlow: this.flow, uLocalWind: this.localWind, uSpread: this.spreadU }, capeVert, 0, THREE.DoubleSide));
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
    // The cape opens only a little on the glide; it is cloth catching air, not a wing.
    this.spreadU.value = glide * 0.3;
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
      let thigh = -sg * s * this.amp;
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

      // arms: swing when walking; swept back like folded wings when riding or diving;
      // opened wide when gliding. In a turn the inside arm dips and the outside arm lifts.
      const inside = -sg * this.bank > 0 ? -1 : 1;
      const tip = inside * Math.abs(this.bank) * 0.8;
      const backX = 1.1 + Math.min(0.25, st.speed * 0.01);
      const backZ = 0.38 + tip + sway;
      let armX = sg * s * this.amp * 0.7;
      let armZ = 0.1;
      armX += (backX - armX) * this.slide;
      armZ += (backZ - armZ) * this.slide;
      // in the air: low and a little back on the way up, eased out to the sides for
      // balance on the glide. Never forward, never spread like wings.
      const jumpX = 0.3 + rise * 0.25 - flare * 0.25;
      const jumpZ = 0.24 + tip * 0.4 + sway;
      const glideX = 0.16 - flare * 0.2;
      const glideZ = 0.62 + tip * 0.7 + sway * 2;
      armX += (jumpX + (glideX - jumpX) * glide - armX) * air;
      armZ += (jumpZ + (glideZ - jumpZ) * glide - armZ) * air;
      this.arms[i].rotation.x = armX;
      this.arms[i].rotation.z = -sg * armZ;
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

    // Cape: streams off the legs when riding, opens like a wing when gliding.
    const flowT = Math.min(1.25, this.slide * 0.55 + st.speed / 24 + this.air * 0.45 + gust * 0.08 + Math.abs(this.bank) * 0.3);
    this.flow.value += (flowT - this.flow.value) * k(3.5);
    const str = 0.45 + gust * 0.9;
    this.localWind.value.set((wind.x * cf - wind.y * sf) * str - this.bank * 1.6, (wind.x * sf + wind.y * cf) * str);
  }
}
