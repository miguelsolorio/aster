import * as THREE from 'three';
import type { PlayerState, Uniforms } from './contract';
import { strideLength } from './player';
import { STYLE_GLSL } from '../render/styleGlsl';
import { CHOSEN, TRIM, bedrollGeometry, boardGeometry, carpetGeometry, chartGeometry, fluteGeometry, lampGeometry, pickGeometry, relicGeometry, rodGeometry, rollGeometry, ropeCoilGeometry, rugMaterial, solidMaterial, spyglassGeometry, trimGeometry } from './equipment';

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

// The hood and the head bulging out of its front. Both are placed at the hood's centre and
// coloured by the direction from there (vL): white within a fixed angle of straight ahead,
// cloth outside. The face is an exact circle per pixel, not the ragged line where the two
// meshes cross, and both shade with the same normal so that crossing never shows.
const hoodVert = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
void main() {
  vL = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normalize(position));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const robeVert = /* glsl */ `
uniform float uTime;
uniform float uFlow;      // 0 hanging .. 1+ streaming straight back
uniform vec2 uLocalWind;  // wind in the figure's local x, z
uniform float uSpread;    // 0 hanging .. 1 flared wide
uniform float uStep;      // signed stride, swings the hem with the legs
uniform float uBack;      // 0..1 a board is slung on the back: the cloth lies against it
uniform float uRoll;      // 0..1 a rolled carpet is strapped low on the back
uniform float uPick;      // 0..1 a pick is tucked slantwise across the back
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

  // A board on the back: the cloth cannot pass through it. Across the board's width it is
  // held in front of the wood and lies flat there; to either side it hangs and streams as before.
  float bx = abs(p.x + (p.y - 0.25) * 0.203);
  float held = (1.0 - smoothstep(0.17, 0.3, bx)) * uBack;
  p.z = mix(p.z, max(p.z, -0.235 + 0.02 * sin(ph) * w), held);
  // A rolled carpet strapped across the small of the back holds the cloth in the same way.
  float band = (1.0 - smoothstep(0.1, 0.2, abs(p.y - 0.14))) * (1.0 - smoothstep(0.3, 0.42, abs(p.x))) * uRoll;
  p.z = mix(p.z, max(p.z, -0.225), band);
  // And a pick tucked across the back, from the left hip up to the right shoulder.
  float px = abs(p.x - (-0.135 + (p.y - 0.1) * 0.685));
  float tuck = (1.0 - smoothstep(0.05, 0.13, px)) * smoothstep(0.0, 0.06, p.y) * (1.0 - smoothstep(0.56, 0.62, p.y)) * uPick;
  p.z = mix(p.z, max(p.z, -0.225), tuck);

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
uniform float uDeepDark;  // 0 under the sky .. 1 down in a deep, out of the daylight
uniform vec4 uCavGlow; // the lamp that matters most down there: position, reach (0 = none)
uniform vec3 uCavGlowCol;
varying vec3 vW;
varying vec3 vN;
#ifdef FACE
varying vec3 vL;
#endif
${STYLE_GLSL}
void main() {
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 n = normalize(vN);
  vec3 n0 = n;
  float body = uBody;
#ifdef FACE
  // the face: every point of the hood within a fixed angle of straight ahead, with a
  // one-pixel soft edge, so it stays a clean circle however the figure moves
  float d = dot(normalize(vL), FACE_AXIS);
  float fw = max(fwidth(d), 1e-4);
  body = smoothstep(FACE_COS - fw, FACE_COS + fw, d);
#endif
  float inside = 1.0;
  if (dot(n, V) < 0.0) {
    n = -n;
    inside = 0.75;
  }
  n = styleFacet(n, vW);
  float ndl = dot(n, uSunDir);
  float l = styleBands(smoothstep(-0.1, 0.35, ndl), vW.xz);
  // cloth: a warm near-black that only just takes the light
  vec3 sh = uFig * mix(0.36, 0.66, uTone);
  vec3 li = mix(uFig, uFigLit, mix(0.03, 0.2, uTone));
  vec3 dark = mix(sh, li, l * 0.85) * inside;
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * smoothstep(-0.2, 0.3, ndl);
  dark += uSunCol * rim * 0.08 * (1.0 - 0.5 * uNight);
  // face: flat white, tinted by the light and dimmed at night. It takes the smooth light,
  // not the facets or the world-space band noise, which would crawl across it on the move.
  float lf = smoothstep(-0.1, 0.35, dot(n0, uSunDir));
  vec3 white = vec3(0.97, 0.95, 0.9) * mix(vec3(1.0), uSunCol, 0.3) * (1.0 - 0.42 * uNight) * mix(0.84, 1.0, lf);
  vec3 col = mix(dark, white, body);
  if (uDeepDark > 0.0) {
    // underground: nearly black, as the stones of a cavern are, and lit only by what glows there
    vec3 lit = vec3(0.0);
    if (uCavGlow.w > 0.0) {
      vec3 gd = uCavGlow.xyz - vW;
      float g2 = dot(gd, gd);
      float ga = 1.0 / (1.0 + g2 / (0.16 * uCavGlow.w * uCavGlow.w));
      vec3 gn = gd * inversesqrt(g2 + 1e-3);
      float gl = 0.45 + 0.55 * max(dot(n, gn), 0.0);
      // the cloth barely takes it; the face does, and a thin edge of light keeps the shape readable
      vec3 alb = mix(mix(vec3(0.1, 0.09, 0.085), vec3(0.2, 0.18, 0.16), uTone), vec3(0.92, 0.9, 0.86), body);
      float edge = pow(1.0 - max(dot(n, V), 0.0), 3.0) * smoothstep(-0.3, 0.4, dot(n, gn));
      lit = uCavGlowCol * ga * (0.85 * alb * gl + 0.12 * edge) * inside;
    }
    col = mix(col, col * 0.2 + lit, uDeepDark);
  }
  col = mix(col, uFogCol, (1.0 - exp(-dist * uFog)) * (1.0 - uDeepDark));
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
const HOOD_R = 0.155;
const HOOD_Y = HEAD_Y + 0.01;
const HOOD_Z = -0.03;
// The face circle, seen from the hood's centre: its axis tips down a touch toward the head's
// centre, and its edge sits ~53° off that axis, where the head comes out through the hood.
const FACE_DROP = 0.11;
const FACE_COS = 0.6;

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
    void h;
    // a clean scalloped hem: seven soft points round the cloth, not a ragged tear
    return d.rag * (0.5 + 0.5 * Math.sin((k / NU) * Math.PI * 14 + d.top * 10));
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
const DRESS: Drape = { top: COLLAR, hem: HEM, r0: 0.07, r1: 0.33, curve: 1.45, arc: Math.PI, rag: 0.06, flat: 0.88 };
// The cloak: a mantle off the shoulders to the knee, open down the front, one piece with the hood.
const CLOAK: Drape = { top: COLLAR + 0.03, hem: 0.74, r0: 0.1, r1: 0.27, curve: 0.75, arc: 2.35, rag: 0.05, flat: 0.92 };

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
  /** The board, twice: slung on the back when walking, under the feet when riding. */
  private boardBack: THREE.Mesh;
  private boardFoot: THREE.Mesh;
  /** Carries a board. */
  board = false;
  /** Standing on it, rather than carrying it on the back. */
  boardOn = true;
  private boardTilt = 0;
  /** Sitting astride an animal: the legs hang either side and the walk stops. */
  seated = false;
  private seat = 0;
  private backU = { value: 0 };
  /** Has a carpet: rolled on the back, it unrolls under the feet whenever the figure flies. */
  carpet = false;
  private rug: THREE.Mesh;
  private roll: THREE.Mesh;
  private rollU = { value: 0 };
  private rugU = { value: 0 };
  private rugLen = { value: 2.4 };
  private rugOut = 0;
  /** Carries a pick, tucked slantwise across the back. */
  pick = false;
  /** 0..1 through a swing of the pick, or -1 when it hangs at rest. */
  swing = -1;
  private pickMesh: THREE.Mesh;
  private pickU = { value: 0 };
  /** Carries a lamp at the right hip, or a relic at the left. */
  lamp = false;
  relic = false;
  /** Set to 1 when something has just been picked up: it swells and settles into place. */
  flourish = 0;
  private lampMesh: THREE.Mesh;
  private relicMesh: THREE.Mesh;
  /** The tools found later, each worn where it can be seen: glass and rope at the right hip, chart at the left, flute in the sash, bedroll across the shoulders. */
  spyglass = false;
  flute = false;
  bedroll = false;
  rod = false;
  chart = false;
  rope = false;
  /** 0..1 the flute is at the lips. */
  piping = 0;
  /** 0..1 the rod is held out in both hands, and how far its tip is pulled down (0..1). */
  dowsing = 0;
  dip = 0;
  /** 0..1 hauling up a rock face on the rope: the arms reach up in turn. */
  climbing = 0;
  private pipe = 0;
  private dowse = 0;
  private climb = 0;
  private glassMesh: THREE.Mesh;
  private fluteMesh: THREE.Mesh;
  private bedMesh: THREE.Mesh;
  private rodMesh: THREE.Mesh;
  private chartMesh: THREE.Mesh;
  private ropeMesh: THREE.Mesh;

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
      add(hip, new THREE.CylinderGeometry(0.03, 0.024, THIGH, 8).translate(0, -THIGH / 2, 0), cloth);
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      add(knee, new THREE.CylinderGeometry(0.024, 0.02, SHIN - 0.01, 8).translate(0, -(SHIN - 0.01) / 2, 0), cloth);
      add(knee, new THREE.BoxGeometry(0.056, 0.036, 0.15).translate(0, -SHIN + 0.014, 0.04), cloth);
      hip.add(knee);
      this.group.add(hip);
      this.hips.push(hip);
      this.knees.push(knee);
    }

    // robe, head, hood and arms all ride on one group so the body can lean from the hips
    const t = this.torso;
    t.position.y = HIP;
    this.group.add(t);
    const cloth2 = { uFlow: this.flow, uLocalWind: this.localWind, uSpread: this.spreadU, uStep: this.stepU, uBack: this.backU, uRoll: this.rollU, uPick: this.pickU };
    add(t, drapeGeometry(DRESS).translate(0, -HIP, 0), mat(0, 0, cloth2, robeVert, THREE.DoubleSide));
    add(t, drapeGeometry(CLOAK).translate(0, -HIP, 0), mat(0, 1, cloth2, robeVert, THREE.DoubleSide));
    // hood: a plain round cowl set a little behind the head, so the face shows as a disc (see hoodVert)
    const hoodMat = mat(0, 1, {}, hoodVert);
    hoodMat.defines = { FACE: '', FACE_AXIS: `normalize(vec3(0.0, ${-FACE_DROP}, 1.0))`, FACE_COS: FACE_COS.toFixed(4) };
    add(t, new THREE.SphereGeometry(HOOD_R, 48, 32).scale(1, 1.03, 1), hoodMat).position.set(0, HOOD_Y - HIP, HOOD_Z);
    add(t, new THREE.SphereGeometry(HEAD_R, 48, 32).translate(0, HEAD_Y - HOOD_Y, 0.035 - HOOD_Z), hoodMat).position.set(0, HOOD_Y - HIP, HOOD_Z);

    for (const sx of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(sx * 0.09, SHOULDER_Y, 0);
      add(arm, new THREE.CylinderGeometry(0.02, 0.017, 1, 6).translate(0, -0.5, 0), cloth);
      t.add(arm);
      this.arms.push(arm);
    }

    // What it has been given. The designs live in equipment.ts.
    const solid = solidMaterial(u);
    // trim: a warm sash at the waist, showing through the open front of the cloak, and a scarf at the neck
    const dressR = (y: number) => DRESS.r0 + (DRESS.r1 - DRESS.r0) * Math.pow((DRESS.top - y) / (DRESS.top - DRESS.hem), DRESS.curve);
    const trim = add(t, trimGeometry([
      { y: 1.04 - HIP, r: dressR(1.04) + 0.012, flat: DRESS.flat, w: 0.024, col: TRIM.sash, arc: 1.0 },
      { y: 1.0 - HIP, r: dressR(1.0) + 0.012, flat: DRESS.flat, w: 0.014, col: TRIM.sash, arc: 1.0 },
      { y: COLLAR - 0.045 - HIP, r: 0.108, flat: 0.95, w: 0.03, col: TRIM.scarf },
    ]), solid);
    trim.position.y = 0;
    const empty = new THREE.BufferGeometry();
    // the board on the back: stood on end between the shoulders, nose up, leaning a little
    this.boardBack = add(t, empty, solid);
    this.boardBack.rotation.set(-Math.PI / 2, 0, 0.2, 'ZYX');
    this.boardBack.position.set(0, 0.25, -0.265);
    this.boardFoot = add(this.group, empty, solid);
    this.boardFoot.position.set(0, 0.03, 0.05);
    // the carpet, flying and rolled
    this.rug = add(this.group, empty, rugMaterial(u, this.rugU, this.rugLen));
    this.roll = add(t, empty, solid);
    // the pick, tucked across the back
    this.pickMesh = add(t, empty, solid);
    // small things hung at the hips, outside the cloak
    this.lampMesh = add(t, lampGeometry(), solid);
    this.relicMesh = add(t, relicGeometry(), solid);
    this.lampMesh.visible = this.relicMesh.visible = false;
    this.glassMesh = add(t, spyglassGeometry(), solid);
    this.fluteMesh = add(t, fluteGeometry(), solid);
    this.bedMesh = add(t, bedrollGeometry(), solid);
    this.rodMesh = add(t, rodGeometry(), solid);
    this.chartMesh = add(t, chartGeometry(), solid);
    // (the coil is made lying flat; worn, it hangs on edge from the belt)
    this.ropeMesh = add(t, ropeCoilGeometry().translate(0, -0.058, 0).scale(0.8, 0.8, 0.8), solid);
    for (const m of [this.glassMesh, this.fluteMesh, this.bedMesh, this.rodMesh, this.chartMesh, this.ropeMesh]) m.visible = false;
    this.boardBack.visible = this.boardFoot.visible = this.rug.visible = this.roll.visible = this.pickMesh.visible = false;
    this.setBoard(CHOSEN.board);
    this.setCarpet(CHOSEN.carpet);
    this.setPick(CHOSEN.pick);
  }

  /** Wear a different design (an index into BOARDS, CARPETS or PICKS in equipment.ts). */
  setBoard(i: number) {
    const g = boardGeometry(i);
    this.boardBack.geometry = g;
    this.boardFoot.geometry = g;
  }

  setCarpet(i: number) {
    const c = carpetGeometry(i);
    this.rug.geometry = c.geo;
    this.rugLen.value = c.len;
    this.roll.geometry = rollGeometry(i);
  }

  setPick(i: number) {
    this.pickMesh.geometry = pickGeometry(i);
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
    this.seat += ((this.seated ? 1 : 0) - this.seat) * k(8);
    const walking = st.grounded && !st.sliding && !this.seated;
    const strideLen = strideLength(st.speed, st.running);
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
      // With a board the feet stay planted on it through a jump or a flight.
      const loose = (this.board && this.boardOn) || this.rugOut > 0.5 ? 0.12 : 1;
      thigh += ((fThigh - thigh) * (1 - loose) + (aThigh - thigh) * loose) * air;
      knee += ((fKnee + 0.18 * rise - knee) * (1 - loose) + (aKnee - knee) * loose) * air;
      // astride: thighs forward and out, knees bent, the lower legs hanging down the animal's flanks
      thigh += (-1.05 - thigh) * this.seat;
      knee += (1.25 - knee) * this.seat;
      this.hips[i].rotation.x = thigh;
      this.hips[i].rotation.z = sg * 0.28 * this.seat;
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

    // The board lies along the sand under the feet while riding, whatever the body's lean.
    // It stays there in the air too, nose lifting with a climb and dipping with a fall.
    // The carpet unrolls for a flight (a climb or a glide, not a plain jump) and takes the board's place.
    const rugT = this.carpet && !st.grounded && (m.lifting || m.gliding) ? 1 : 0;
    this.rugOut += (rugT - this.rugOut) * k(rugT ? 7 : 12);
    this.rug.visible = this.rugOut > 0.03;
    if (this.rug.visible) {
      this.rugU.value += (Math.min(1, st.speed / 30) - this.rugU.value) * k(3);
      const climb = -0.4 * Math.atan2(st.vel.y, Math.max(st.speed, 6));
      this.rug.rotation.x = -this.pitch + climb;
      this.rug.rotation.z = this.bank * 0.4;
      this.rug.position.set(0, 0.02, -0.15);
      this.rug.scale.set(0.3 + 0.7 * this.rugOut, 1, this.rugOut);
    }
    const riding = this.board && this.boardOn && this.rugOut < 0.5 && (st.grounded ? this.slide > 0.2 : true);
    this.boardFoot.visible = riding;
    this.boardBack.visible = this.board && !riding;
    this.backU.value = this.boardBack.visible ? 1 : 0;
    // Rolled, the carpet rides across the small of the back: outside the board when that is there too.
    this.roll.visible = this.carpet && this.rugOut < 0.5;
    this.rollU.value = this.roll.visible ? 1 : 0;
    this.roll.position.set(0, 0.14, this.boardBack.visible ? -0.385 : -0.31);

    // The pick is tucked slantwise across the back, head up by the shoulder and its edge turned
    // outward (outside the board when that is there too), or it is in the hand through a swing:
    // up over the shoulder, then down in front.
    this.pickMesh.visible = this.pick;
    this.pickU.value = this.pick && this.swing < 0 ? 1 : 0;
    if (this.pick && this.swing >= 0) {
      const a = this.swing * Math.PI * 2;
      const up = 0.5 + 0.5 * Math.cos(a); // 1 raised .. 0 struck
      const hx = -0.16;
      const hy = -0.12 + 0.5 * up;
      const hz = 0.34 - 0.2 * up;
      this.reach(this.arms[0], hx, hy, hz, 1);
      this.pickMesh.position.set(hx, hy, hz);
      this.pickMesh.rotation.set(1.75 - 2.1 * up, 0, 0);
    } else if (this.pick) {
      this.pickMesh.position.set(-0.135, 0.1, this.boardBack.visible ? -0.335 : -0.255);
      this.pickMesh.rotation.set(0, Math.PI, 0.6);
    }
    // What hangs at the hips swings a little with the walk, and swells for a moment when new.
    this.flourish = Math.max(0, this.flourish - dt * 1.4);
    const pop = 1 + 1.6 * this.flourish * this.flourish * (0.6 + 0.4 * Math.cos(this.flourish * 14));
    this.lampMesh.visible = this.lamp;
    this.relicMesh.visible = this.relic;
    if (this.lamp) {
      this.lampMesh.position.set(0.25, 0.24 + 0.3 * this.flourish, 0.04);
      this.lampMesh.rotation.set(Math.sin(a) * 0.25 * this.amp - this.pitch * 0.6, 0.5, Math.sin(t * 1.7) * 0.05);
      this.lampMesh.scale.setScalar(1.25 * pop);
    }
    if (this.relic) {
      this.relicMesh.position.set(-0.24, 0.13 + 0.3 * this.flourish, 0.07);
      this.relicMesh.rotation.set(0, t * 0.6, Math.sin(a + 1) * 0.2 * this.amp);
      this.relicMesh.scale.setScalar(pop);
    }
    // The later tools. Each hangs outside the cloak and swings a little with the walk.
    const sw = Math.sin(a) * this.amp;
    this.glassMesh.visible = this.spyglass;
    if (this.spyglass) {
      // at the right hip, forward of where a lamp hangs, eyepiece up
      this.glassMesh.position.set(0.19, 0.27, 0.15);
      this.glassMesh.rotation.set(Math.PI + 0.18 + sw * 0.16 - this.pitch * 0.5, 0, -0.14);
    }
    this.chartMesh.visible = this.chart;
    if (this.chart) {
      // slung behind the left hip, slanting back
      this.chartMesh.position.set(-0.22, 0.16, -0.1);
      this.chartMesh.rotation.set(-0.55 + sw * 0.1, 0, 0.3);
    }
    this.ropeMesh.visible = this.rope;
    if (this.rope) {
      this.ropeMesh.position.set(0.27, 0.1, -0.07);
      this.ropeMesh.rotation.set(sw * 0.12 - this.pitch * 0.5, 0.25, -Math.PI / 2 + 0.12);
    }
    // The bedroll rides across the back above the carpet's roll, outside the board.
    this.bedMesh.visible = this.bedroll;
    if (this.bedroll) this.bedMesh.position.set(0, this.roll.visible ? 0.33 : 0.2, this.boardBack.visible ? -0.37 : -0.3);
    // The flute sits in the sash, slantwise across the front, until it is played: then both
    // hands bring it up to the lips and it points down and out.
    this.pipe += (this.piping - this.pipe) * k(9);
    this.fluteMesh.visible = this.flute;
    if (this.flute) {
      const p = this.pipe * this.pipe * (3 - 2 * this.pipe);
      const breath = Math.sin(t * 5.3) * 0.012 * p;
      this.fluteMesh.position.set(0.12 - 0.12 * p, 0.1 + 0.27 * p, 0.215 + 0.135 * p + breath);
      this.fluteMesh.rotation.set(-0.12 - 0.55 * p, 0, 0.95 * (1 - p));
      if (p > 0.05) {
        this.reach(this.arms[0], -0.035, 0.5, 0.26, p);
        this.reach(this.arms[1], 0.035, 0.43, 0.3, p);
      }
    }
    // The rod is carried at the left hip, fork down. Held, it is level out in front in both
    // hands, trembling, and its tip is drawn down as the ground under it answers.
    this.dowse += (this.dowsing - this.dowse) * k(6);
    this.rodMesh.visible = this.rod;
    if (this.rod) {
      const d = this.dowse * this.dowse * (3 - 2 * this.dowse);
      const shake = (Math.sin(t * 31) + Math.sin(t * 47 + 1)) * 0.012 * d * (0.3 + this.dip);
      this.rodMesh.position.set(-0.2 + 0.2 * d, 0.2 + 0.06 * d, 0.12 + 0.12 * d);
      this.rodMesh.rotation.set((1 - d) * 1.5 + d * (0.08 + this.dip * 1.0) + shake, (1 - d) * 0.4, (1 - d) * 0.2);
      if (d > 0.05 && this.pipe < 0.05) {
        this.reach(this.arms[0], -0.095, 0.26, 0.24, d);
        this.reach(this.arms[1], 0.095, 0.26, 0.24, d);
      }
    }
    // Hauling up a face on the rope: hand over hand above the head.
    this.climb += (this.climbing - this.climb) * k(8);
    if (this.climb > 0.05) {
      const h = Math.sin(t * 5.5);
      this.reach(this.arms[0], -0.12, 0.62 + 0.14 * h, 0.2, this.climb);
      this.reach(this.arms[1], 0.12, 0.62 - 0.14 * h, 0.2, this.climb);
    }
    if (riding) {
      const tiltT = st.grounded ? -Math.atan(m.slopeAlong) : -0.45 * Math.atan2(st.vel.y, Math.max(st.speed, 4));
      this.boardTilt += (tiltT - this.boardTilt) * k(st.grounded ? 14 : 6);
      this.boardFoot.rotation.x = -this.pitch + this.boardTilt;
      this.boardFoot.rotation.z = st.grounded ? 0 : this.bank * 0.5;
      this.boardFoot.position.y = 0.03;
    }

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
