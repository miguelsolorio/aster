import * as THREE from 'three';
import type { FrameState } from '../../game/contract';
import type { Emitter, Extra, ExtraBuilder, ExtraCtx } from '../extras';
import type { Building } from '../types';

// Signs of life over a city: small flocks of an invented desert bird, and thin chimney smoke.
//
// Birds: a few flocks (5 to 14 birds) each live on one roof, mostly the tallest towers and landmarks
// and a few ordinary rooftops. They sit along the roof edge, and every so often some lift off and
// wheel round their tower on a loose circle, then settle on a free perch again. Walk within 14 m of
// a perched bird and the whole flock bursts up, scatters wide, circles for a while and comes back
// (to somewhere that is not near you). At night they roost and stay put; at dawn they stir more.
// The simulation is a few floats per bird, written straight into two instanced attributes, and is
// skipped for flocks more than 400 m away (which are parked on their perches instead). The wings
// are two triangles each, flapped in the vertex shader from a per-bird phase and a flap amount
// (0 = glide, folded when perched). One draw call.
//
// Smoke: 10 to 25 house roofs send up a column of soft billboards. Nothing is simulated: the vertex
// shader derives each puff's age, height, drift with the wind and size from uTime and per-puff
// seeds. Columns kindle and die away with the time of day (busy at dawn and dusk, mostly out in the
// deep night). Premultiplied alpha, no depth writes, tinted by the sky and fog. One draw call.

const TAU = Math.PI * 2;
const MAX_BIRDS = 150;
const SIM_RANGE = 400; // flocks farther than this are parked, not simulated
const SCARE = 14; // metres from a perched bird that sets the flock off
const SCARE2 = SCARE * SCARE;
const SETTLE_CLEAR = 16; // a flock will not land on a perch this close to the player

const P_PERCH = 0;
const P_WAIT = 1; // about to take off (the flock lifts raggedly)
const P_FLY = 2;
const P_LAND = 3;

const SMOKE_PER = 14; // puffs per column
const SMOKE_LIFE = 11; // seconds a puff takes to rise and fade

const wrap = (a: number): number => a - TAU * Math.floor((a + Math.PI) / TAU);
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

// ------------------------------------------------------------------ shaders

const BIRD_VERT = /* glsl */ `
attribute vec2 aW;     // x: wing side (-1, 0 body, 1), y: fraction along the wing
attribute vec4 aPos;   // local position, yaw
attribute vec4 aSt;    // wing phase, flap amount, bank, fold
attribute float aSeed;
uniform float uFog;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uTop;
uniform vec3 uFogCol;
varying vec3 vCol;
void main() {
  vec3 p = position * (0.85 + 0.3 * aSeed);
  float f = aW.y;
  float fold = aSt.w;
  float up = mix(0.14, sin(aSt.x), aSt.y);
  p.z *= mix(1.0 - 0.2 * f * abs(up), 0.3, fold);
  p.y += (1.0 - fold) * f * 0.2 * up - fold * f * 0.045;
  p.x += (1.0 - fold) * f * 0.03 * up; // tips sweep a little on the stroke
  float cb = cos(aSt.z), sb = sin(aSt.z);
  p.yz = vec2(p.y * cb - p.z * sb, p.y * sb + p.z * cb);
  float c = cos(aPos.w), s = sin(aPos.w);
  vec3 lp = vec3(aPos.x + c * p.x - s * p.z, aPos.y + p.y, aPos.z + s * p.x + c * p.z);
  vec4 wp = modelMatrix * vec4(lp, 1.0);
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
  float dist = length(wp.xyz - cameraPosition);
  // a dark silhouette with a little light: dim ink by day, almost nothing by night
  float l = clamp(uSunDir.y * 1.6, 0.0, 1.0) * (1.0 - uNight);
  vec3 night = uShade * 0.16 + uTop * 0.02;
  vec3 day = mix(uShade, uLit, 0.4) * 0.34;
  vec3 col = mix(night, day, l) * (0.85 + 0.3 * aSeed);
  col += uLit * 0.12 * f * l * (0.5 + 0.5 * up); // pale wing tips catch the sun
  vCol = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
}
`;

const BIRD_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  gl_FragColor = vec4(vCol, 1.0);
}
`;

const SMOKE_VERT = /* glsl */ `
attribute vec4 aA;   // column root (local), column seed
attribute vec4 aB;   // age offset, size, rise height, vigour
uniform float uTime;
uniform vec2 uWind;
uniform float uGust;
uniform float uAct;  // how many columns are lit right now, 0..1
uniform float uFog;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uFogCol;
varying vec2 vUv;
varying float vA;
varying vec3 vCol;
void main() {
  float t = fract(uTime / ${SMOKE_LIFE.toFixed(1)} + aB.x);
  float age = t * ${SMOKE_LIFE.toFixed(1)};
  vec4 wp = modelMatrix * vec4(aA.xyz, 1.0);
  float rise = aB.z * (1.0 - pow(1.0 - t, 1.5));
  wp.y += rise;
  float drift = 0.35 * age + 0.06 * age * age;
  wp.xz += uWind * (0.3 + 0.9 * uGust) * drift;
  wp.xz += vec2(sin(age * 1.1 + aA.w * 31.0), cos(age * 0.9 + aA.w * 17.0)) * 0.3 * t;
  float size = aB.y * (1.2 + 5.0 * sqrt(t));
  vec4 mv = viewMatrix * wp;
  float dist = max(-mv.z, 0.1);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  float on = smoothstep(aA.w, aA.w + 0.12, uAct);
  float a = on * smoothstep(0.0, 0.07, t) * pow(1.0 - t, 1.2) * 0.6 * (0.6 + 0.6 * uAct) * aB.w;
  a *= 1.0 - smoothstep(350.0, 600.0, dist);
  float sun = clamp(uSunDir.y * 1.5, 0.0, 1.0) * (1.0 - uNight);
  vec3 body = mix(uFogCol * 0.45 + uShade * 0.2, mix(uFogCol, vec3(0.9, 0.85, 0.78), 0.85), sun); // paler than the sand, or it vanishes against it
  vCol = mix(body, uFogCol, (1.0 - exp(-dist * uFog)) * 0.7);
  vA = a;
  vUv = position.xy;
}
`;

const SMOKE_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vA;
varying vec3 vCol;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 >= 1.0 || vA < 0.002) discard;
  float a = (1.0 - r2);
  a *= a * vA;
  gl_FragColor = vec4(vCol * a, a); // premultiplied
}
`;

// ------------------------------------------------------------------ birds

/** The bird: a small kite-shaped body (forward +x, up +y) and two quad wings (side +/-z). */
function birdGeometry(): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const aw: number[] = [];
  const tri = (a: number[], b: number[], c: number[], w: number[]): void => {
    pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) aw.push(w[0], w[1]);
  };
  const N = [0.11, 0, 0], B = [0, 0.035, 0], V = [0, -0.03, 0], L = [0, 0, 0.035], R = [0, 0, -0.035], T = [-0.14, 0.004, 0];
  const body = [0, 0];
  tri(N, B, L, body); tri(N, L, V, body); tri(N, V, R, body); tri(N, R, B, body);
  tri(T, L, B, body); tri(T, V, L, body); tri(T, R, V, body); tri(T, B, R, body);
  for (const s of [-1, 1]) {
    const rf = [0.05, 0.012, s * 0.03], rb = [-0.06, 0.012, s * 0.03];
    const tf = [-0.02, 0.012, s * 0.26], tb = [-0.1, 0.012, s * 0.22];
    pos.push(...rf, ...rb, ...tb, ...rf, ...tb, ...tf);
    aw.push(s, 0, s, 0, s, 1, s, 0, s, 1, s, 1);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aW', new THREE.Float32BufferAttribute(aw, 2));
  return g;
}

type Birds = (f: FrameState, p: THREE.Vector3) => void;

function buildBirds(ctx: ExtraCtx, near: THREE.Group, emitters: Emitter[], owned: Array<{ dispose(): void }>): Birds | null {
  const { plan } = ctx;
  const rng = ctx.rng(0x1b1d5);

  // ---- where the flocks live
  const ok = (b: Building): boolean =>
    b.solid && b.roof !== 'none' && b.roof !== 'canopy' && b.role !== 'wall' && b.role !== 'stall' && b.role !== 'garden' && Math.min(b.w, b.d) >= 2;
  const cands = plan.buildings.filter(ok);
  const tall = cands.slice().sort((a, b) => b.h + b.crown - (a.h + a.crown));
  const homes: Building[] = [];
  const apart = (b: Building): boolean => homes.every((o) => Math.hypot(o.x - b.x, o.z - b.z) >= 30);
  const nf = Math.max(4, Math.round((6 + rng() * 8) * Math.min(1, ctx.density)));
  const nTower = Math.ceil(nf * 0.65);
  for (const b of tall) {
    if (homes.length >= nTower) break;
    if (b.h + b.crown >= 8 && apart(b)) homes.push(b);
  }
  const houses = cands.filter((b) => b.role === 'house' && b.h >= 3 && b.h + b.crown < 14);
  for (let i = houses.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [houses[i], houses[j]] = [houses[j], houses[i]];
  }
  for (const b of houses) {
    if (homes.length >= nf) break;
    if (apart(b)) homes.push(b);
  }

  // ---- perches (all flocks in one list), birds
  const px: number[] = [], py: number[] = [], pz: number[] = [], pyaw: number[] = [];
  const fx: number[] = [], fz: number[] = [], fR: number[] = [], fAlt: number[] = [], fDir: number[] = [], fFloor: number[] = [];
  const fP0: number[] = [], fPn: number[] = [], fB0: number[] = [], fBn: number[] = [];
  const bFlock: number[] = [], bPerch: number[] = [], bFly: number[] = [];
  let total = 0;

  for (const b of homes) {
    if (total >= MAX_BIRDS) break;
    // perimeter points, on the coping when the roof has a parapet, else on the roof edge
    const rim = b.roof === 'parapet' || b.roof === 'terrace' || b.role === 'landmark' || b.role === 'gate';
    const inset = rim ? 0.15 : 0.22;
    const y = b.h + (rim ? 0.62 : 0.08) + 0.04;
    const x0 = b.x - b.w / 2 + inset, x1 = b.x + b.w / 2 - inset, z0 = b.z - b.d / 2 + inset, z1 = b.z + b.d / 2 - inset;
    const pts: number[][] = [];
    for (let x = x0; x <= x1 + 1e-6; x += 0.7) pts.push([x, z0], [x, z1]);
    for (let z = z0 + 0.7; z < z1 - 1e-6; z += 0.7) pts.push([x0, z], [x1, z]);
    if (pts.length < 8) continue;
    for (let i = pts.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pts[i], pts[j]] = [pts[j], pts[i]];
    }
    const keep = pts.slice(0, 40);
    const n = Math.min(5 + Math.floor(rng() * 10), Math.floor(keep.length * 0.7), MAX_BIRDS - total);
    if (n < 4) continue;
    const f = fx.length;
    fx.push(b.x);
    fz.push(b.z);
    fR.push(Math.max(b.w, b.d) / 2 + 5 + rng() * 7);
    fAlt.push(b.h + Math.min(b.crown, 12) * 0.6 + 4 + rng() * 3);
    fDir.push(rng() < 0.5 ? 1 : -1);
    fFloor.push(0);
    fP0.push(px.length);
    fPn.push(keep.length);
    fB0.push(bFlock.length);
    fBn.push(n);
    for (const [x, z] of keep) {
      px.push(x);
      py.push(y);
      pz.push(z);
      pyaw.push(rng() * TAU);
    }
    for (let k = 0; k < n; k++) {
      bFlock.push(f);
      bPerch.push(fP0[f] + k);
      bFly.push(rng() < 0.35 ? 1 : 0);
    }
    total += n;
    emitters.push({ x: b.x, z: b.z, kind: 'birds', gain: 0.6, reach: 60 });
  }
  const NB = total;
  const NF = fx.length;
  if (NB === 0) return null;
  const NP = px.length;

  // ---- state
  const Px = Float32Array.from(px), Py = Float32Array.from(py), Pz = Float32Array.from(pz), Pyaw = Float32Array.from(pyaw);
  const pOwner = new Int16Array(NP).fill(-1);
  const FX = Float32Array.from(fx), FZ = Float32Array.from(fz), FR = Float32Array.from(fR), FAlt = Float32Array.from(fAlt);
  const FDir = Float32Array.from(fDir), FFloor = Float32Array.from(fFloor);
  const FP0 = Int32Array.from(fP0), FPn = Int32Array.from(fPn), FB0 = Int32Array.from(fB0), FBn = Int32Array.from(fBn);
  const parked = new Uint8Array(NF);
  const flockOf = Uint16Array.from(bFlock);

  const state = new Uint8Array(NB);
  const perch = new Int16Array(NB);
  const scared = new Uint8Array(NB);
  const bx = new Float32Array(NB), by = new Float32Array(NB), bz = new Float32Array(NB);
  const vx = new Float32Array(NB), vy = new Float32Array(NB), vz = new Float32Array(NB);
  const yaw = new Float32Array(NB), bank = new Float32Array(NB), phase = new Float32Array(NB);
  const flap = new Float32Array(NB), fold = new Float32Array(NB);
  const timer = new Float32Array(NB), panic = new Float32Array(NB);
  const cr = new Float32Array(NB), calt = new Float32Array(NB), speed = new Float32Array(NB), rate = new Float32Array(NB);
  const seed = new Float32Array(NB);
  const aPos = new Float32Array(NB * 4);
  const aSt = new Float32Array(NB * 4);

  for (let i = 0; i < NB; i++) {
    const f = flockOf[i];
    seed[i] = rng();
    speed[i] = 4.5 + rng() * 2;
    rate[i] = 24 + rng() * 8;
    phase[i] = rng() * TAU;
    perch[i] = bPerch[i];
    if (bFly[i]) {
      // already wheeling: spread round the circle
      const a = rng() * TAU;
      cr[i] = FR[f] * (0.8 + rng() * 0.5);
      calt[i] = FAlt[f] + rng() * 5 - 2;
      bx[i] = FX[f] + Math.cos(a) * cr[i];
      bz[i] = FZ[f] + Math.sin(a) * cr[i];
      by[i] = calt[i];
      vx[i] = -Math.sin(a) * FDir[f] * speed[i];
      vz[i] = Math.cos(a) * FDir[f] * speed[i];
      yaw[i] = Math.atan2(vz[i], vx[i]);
      state[i] = P_FLY;
      timer[i] = 6 + rng() * 25;
      flap[i] = 0.2;
    } else {
      const p = perch[i];
      pOwner[p] = i;
      bx[i] = Px[p];
      by[i] = Py[p];
      bz[i] = Pz[p];
      yaw[i] = Pyaw[p];
      fold[i] = 1;
    }
  }

  const geo = birdGeometry();
  geo.instanceCount = NB;
  const posAttr = new THREE.InstancedBufferAttribute(aPos, 4).setUsage(THREE.DynamicDrawUsage);
  const stAttr = new THREE.InstancedBufferAttribute(aSt, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPos', posAttr);
  geo.setAttribute('aSt', stAttr);
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...ctx.uniforms },
    vertexShader: BIRD_VERT,
    fragmentShader: BIRD_FRAG,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'city-birds';
  mesh.frustumCulled = false; // instances wander; the whole thing is tiny anyway
  near.add(mesh);
  owned.push(geo, mat);
  near.userData.counts = { ...(near.userData.counts as object | undefined), flocks: NF, birds: NB };

  const roofAt = ctx.roofAt;

  const snap = (i: number, p: number): void => {
    perch[i] = p;
    pOwner[p] = i;
    state[i] = P_PERCH;
    bx[i] = Px[p];
    by[i] = Py[p];
    bz[i] = Pz[p];
    vx[i] = vy[i] = vz[i] = 0;
    panic[i] = 0;
  };

  const park = (f: number): void => {
    const b0 = FB0[f], b1 = b0 + FBn[f];
    for (let i = b0; i < b1; i++) {
      if (state[i] === P_PERCH) continue;
      if (state[i] === P_LAND) {
        snap(i, perch[i]);
        continue;
      }
      for (let p = FP0[f]; p < FP0[f] + FPn[f]; p++)
        if (pOwner[p] < 0) {
          snap(i, p);
          yaw[i] = Pyaw[p];
          fold[i] = 1;
          flap[i] = 0;
          bank[i] = 0;
          break;
        }
    }
    parked[f] = 1;
  };

  const scare = (f: number): void => {
    const b0 = FB0[f], b1 = b0 + FBn[f];
    for (let i = b0; i < b1; i++)
      if (state[i] === P_PERCH) {
        state[i] = P_WAIT;
        timer[i] = Math.random() * 0.5;
        scared[i] = 1;
      }
  };

  const launch = (i: number, f: number, qx: number, qz: number): void => {
    pOwner[perch[i]] = -1;
    state[i] = P_FLY;
    const s = scared[i] === 1;
    timer[i] = s ? 14 + Math.random() * 22 : 12 + Math.random() * 25;
    panic[i] = s ? 3 + Math.random() * 2 : 0;
    cr[i] = FR[f] * (0.8 + Math.random() * 0.5);
    calt[i] = FAlt[f] + Math.random() * 5 - 2;
    let ax = bx[i] - (s ? qx : FX[f]);
    let az = bz[i] - (s ? qz : FZ[f]);
    const l = Math.hypot(ax, az) || 1;
    ax /= l;
    az /= l;
    vx[i] = ax * 3.5 + (Math.random() - 0.5) * 2;
    vz[i] = az * 3.5 + (Math.random() - 0.5) * 2;
    vy[i] = 3.5 + Math.random() * 1.5;
    flap[i] = 1;
    scared[i] = 0;
  };

  const pickPerch = (i: number, f: number, qx: number, qy: number, qz: number): boolean => {
    for (let k = 0; k < 8; k++) {
      const p = FP0[f] + Math.floor(Math.random() * FPn[f]);
      if (pOwner[p] >= 0) continue;
      const dx = Px[p] - qx, dy = Py[p] - qy, dz = Pz[p] - qz;
      if (dx * dx + dy * dy + dz * dz < SETTLE_CLEAR * SETTLE_CLEAR) continue;
      pOwner[p] = i;
      perch[i] = p;
      state[i] = P_LAND;
      timer[i] = 25;
      return true;
    }
    return false;
  };

  return (f, p) => {
    const dt = f.dt;
    if (dt <= 0) return;
    const t = f.time;
    const night = f.night;
    const dd = (f.day - 0.27) / 0.06;
    const dawn = Math.exp(-dd * dd);
    const lift = night > 0.65 ? 0 : (1 / 80) * (1 + 2.5 * dawn) * dt; // chance per bird per frame
    const kf = Math.min(1, dt * 10);

    for (let fl = 0; fl < NF; fl++) {
      const hx = p.x - FX[fl], hz = p.z - FZ[fl];
      if (hx * hx + hz * hz > SIM_RANGE * SIM_RANGE) {
        if (parked[fl] === 0) {
          park(fl);
          writeFlock(fl);
        }
        continue;
      }
      parked[fl] = 0;
      const b0 = FB0[fl], b1 = b0 + FBn[fl];
      for (let i = b0; i < b1; i++) {
        const st = state[i];
        if (st === P_PERCH) {
          const dx = bx[i] - p.x, dy = by[i] - p.y, dz = bz[i] - p.z;
          if (dx * dx + dy * dy + dz * dz < SCARE2) {
            scare(fl);
          } else if (Math.random() < lift) {
            state[i] = P_WAIT;
            timer[i] = 0;
            scared[i] = 0;
          } else {
            const dy2 = wrap(Pyaw[perch[i]] - yaw[i]);
            yaw[i] += dy2 * Math.min(1, dt * 6);
            bank[i] -= bank[i] * kf;
            flap[i] -= flap[i] * kf;
            fold[i] += (1 - fold[i]) * kf;
            continue;
          }
        }
        if (state[i] === P_WAIT) {
          timer[i] -= dt;
          if (timer[i] <= 0) launch(i, fl, p.x, p.z);
          else {
            fold[i] += (1 - fold[i]) * kf;
            continue;
          }
        }

        // ---- airborne
        const s = state[i];
        let ax = 0, az = 0, ay = 0; // desired velocity
        let flapT = 0;
        let rateK = 1;
        if (s === P_FLY) {
          let rx = bx[i] - FX[fl], rz = bz[i] - FZ[fl];
          const rad = Math.max(0.5, Math.hypot(rx, rz));
          rx /= rad;
          rz /= rad;
          const rr = cr[i] * (panic[i] > 0 ? 1.6 : 1);
          const radial = clamp((rr - rad) * 0.6, -speed[i] * 0.7, speed[i] * 0.7);
          ax = -rz * FDir[fl] * speed[i] + rx * radial;
          az = rx * FDir[fl] * speed[i] + rz * radial;
          const dy = calt[i] + (panic[i] > 0 ? 3 : 0) - by[i];
          ay = clamp(dy * 0.5, -2.5, 3.5);
          flapT = dy > 1 || panic[i] > 0 ? 1 : (t * 0.35 + seed[i] * 10) % 1 < 0.25 ? 0.7 : 0;
          panic[i] -= dt;
          timer[i] -= dt * (night > 0.7 ? 6 : 1);
          if (timer[i] <= 0) {
            if (!pickPerch(i, fl, p.x, p.y, p.z)) timer[i] = 5;
          }
        } else {
          const q = perch[i];
          const dx = Px[q] - bx[i], dz = Pz[q] - bz[i];
          const hd = Math.hypot(dx, dz);
          const aimY = Py[q] + clamp(hd * 0.5, 0.3, 4);
          const ex = dx, ey = (hd > 2.5 ? aimY : Py[q]) - by[i], ez = dz;
          const el = Math.max(0.05, Math.hypot(ex, ey, ez));
          const sp = clamp(hd * 0.6 + 1.5, 1.5, speed[i]);
          ax = (ex / el) * sp;
          ay = (ey / el) * sp;
          az = (ez / el) * sp;
          flapT = el < 4 ? 1 : 0.35;
          rateK = 1;
          timer[i] -= dt;
          const pdx = Px[q] - p.x, pdy = Py[q] - p.y, pdz = Pz[q] - p.z;
          if (pdx * pdx + pdy * pdy + pdz * pdz < 81 || timer[i] <= 0) {
            // somebody came too close, or it is taking too long: give up and circle again
            pOwner[q] = -1;
            state[i] = P_FLY;
            timer[i] = 5 + Math.random() * 6;
          } else if (el < 0.3) {
            snap(i, q);
            continue;
          }
        }

        const k = Math.min(1, dt * (s === P_LAND ? 3 : 1.8));
        vx[i] += (ax - vx[i]) * k;
        vy[i] += (ay - vy[i]) * k;
        vz[i] += (az - vz[i]) * k;
        bx[i] += vx[i] * dt;
        by[i] += vy[i] * dt;
        bz[i] += vz[i] * dt;
        // never through a roof: lift over whatever is below
        const floor = Math.max(roofAt(bx[i], bz[i]), FFloor[fl]) + (state[i] === P_LAND ? 0.1 : 0.9);
        if (by[i] < floor) {
          by[i] = floor;
          if (vy[i] < 0) vy[i] = 0;
        }

        const sp2 = Math.hypot(vx[i], vz[i]);
        if (sp2 > 0.3) {
          const d = wrap(Math.atan2(vz[i], vx[i]) - yaw[i]);
          yaw[i] += clamp(d, -6 * dt, 6 * dt);
          bank[i] += (clamp(d * 0.9, -0.6, 0.6) - bank[i]) * Math.min(1, dt * 5);
        }
        flap[i] += (flapT - flap[i]) * Math.min(1, dt * 4);
        fold[i] -= fold[i] * kf;
        phase[i] += dt * rate[i] * (0.12 + 0.88 * flap[i]) * rateK;
      }
      writeFlock(fl);
    }
    posAttr.needsUpdate = true;
    stAttr.needsUpdate = true;
  };

  function writeFlock(f: number): void {
    const b0 = FB0[f], b1 = b0 + FBn[f];
    for (let i = b0; i < b1; i++) {
      const o = i * 4;
      aPos[o] = bx[i];
      aPos[o + 1] = by[i];
      aPos[o + 2] = bz[i];
      aPos[o + 3] = yaw[i];
      aSt[o] = phase[i];
      aSt[o + 1] = flap[i];
      aSt[o + 2] = bank[i];
      aSt[o + 3] = fold[i];
    }
  }
}

// ------------------------------------------------------------------ smoke

function buildSmoke(ctx: ExtraCtx, near: THREE.Group, owned: Array<{ dispose(): void }>): ((f: FrameState) => void) | null {
  const { plan } = ctx;
  const rng = ctx.rng(0x5a0c3);
  const roofs = plan.buildings.filter(
    (b) => b.solid && b.role === 'house' && (b.roof === 'flat' || b.roof === 'parapet') && b.h >= 2.5 && b.w >= 4 && b.d >= 4,
  );
  for (let i = roofs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [roofs[i], roofs[j]] = [roofs[j], roofs[i]];
  }
  const want = Math.round((10 + rng() * 15) * Math.min(1, ctx.density));
  const cols: Array<{ x: number; y: number; z: number }> = [];
  for (const b of roofs) {
    if (cols.length >= want) break;
    // a corner of the roof, inside any parapet
    const x = b.x + (rng() < 0.5 ? -1 : 1) * (b.w / 2 - 1.1 - rng() * 0.6);
    const z = b.z + (rng() < 0.5 ? -1 : 1) * (b.d / 2 - 1.1 - rng() * 0.6);
    if (Math.abs(ctx.roofAt(x, z) - b.h) > 0.01) continue;
    if (cols.some((c) => Math.hypot(c.x - x, c.z - z) < 10)) continue;
    cols.push({ x, y: b.h + 0.35, z });
  }
  const NC = cols.length;
  if (NC === 0) return null;

  const N = NC * SMOKE_PER;
  const aA = new Float32Array(N * 4);
  const aB = new Float32Array(N * 4);
  for (let c = 0; c < NC; c++) {
    const cs = rng(); // column seed: it burns when the day's activity exceeds this
    const H = 15 + rng() * 10;
    const off = rng();
    const size = 0.22 + rng() * 0.12;
    const vig = 0.75 + rng() * 0.45;
    for (let k = 0; k < SMOKE_PER; k++) {
      const o = (c * SMOKE_PER + k) * 4;
      aA[o] = cols[c].x;
      aA[o + 1] = cols[c].y;
      aA[o + 2] = cols[c].z;
      aA[o + 3] = cs;
      aB[o] = (k + rng() * 0.3) / SMOKE_PER + off;
      aB[o + 1] = size * (0.85 + rng() * 0.3);
      aB[o + 2] = H * (0.92 + rng() * 0.16);
      aB[o + 3] = vig;
    }
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aA', new THREE.InstancedBufferAttribute(aA, 4));
  geo.setAttribute('aB', new THREE.InstancedBufferAttribute(aB, 4));
  geo.instanceCount = N;
  const uAct = { value: 0 };
  const uGust = { value: 0 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...ctx.uniforms, uAct, uGust },
    vertexShader: SMOKE_VERT,
    fragmentShader: SMOKE_FRAG,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'city-smoke';
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  near.add(mesh);
  owned.push(geo, mat);
  near.userData.counts = { ...(near.userData.counts as object | undefined), smokes: NC };

  return (f) => {
    // cooking at dawn and dusk, a modest fire by day, embers at night
    const d1 = (f.day - 0.28) / 0.06;
    const d2 = (f.day - 0.74) / 0.07;
    const act = 0.1 + 0.4 * (1 - f.night) + 0.5 * (Math.exp(-d1 * d1) + Math.exp(-d2 * d2));
    uAct.value = act > 1 ? 1 : act;
    uGust.value = f.gust;
  };
}

// ------------------------------------------------------------------ extra

export const life: ExtraBuilder = (ctx: ExtraCtx): Extra => {
  const near = new THREE.Group();
  near.name = 'city-life';
  const emitters: Emitter[] = [];
  const owned: Array<{ dispose(): void }> = [];
  let birds: Birds | null = null;
  let smoke: ((f: FrameState) => void) | null = null;
  if (ctx.density >= 0.5) {
    birds = buildBirds(ctx, near, emitters, owned);
    smoke = buildSmoke(ctx, near, owned);
  }
  const b = birds;
  const s = smoke;
  return {
    near,
    far: null,
    solids: [],
    emitters,
    update:
      b || s
        ? (f, p) => {
            if (b) b(f, p);
            if (s) s(f);
          }
        : undefined,
    dispose() {
      for (const o of owned) o.dispose();
      owned.length = 0;
    },
  };
};
