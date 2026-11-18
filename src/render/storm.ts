// A sandstorm, drawn. Each storm is one great slab of sand in the air: a wall on the horizon
// from outside, a murk a few dozen metres deep from within. Both are the same thing, marched in
// the post pass against the depth buffer, so whatever stands in a storm is lost in it by distance
// and no material needs to know that storms exist.
//
// The slab is given in its own frame: `a` runs along the heading (the leading face is at +depth/2),
// `b` across it, y up from the ground under its middle. Its colours are the sand's own (uLit and
// uShade), so it follows the hour and the look without a palette of its own.
import * as THREE from 'three';
import type { FrameState, Uniforms } from '../game/contract';

/** How many storms are drawn at once: the nearest ones. */
const MAX = 2;
/** How high the wall stands over the ground at full strength, in metres: above anything that flies. */
export const STORM_TOP = 950;
/** How many mountains a storm can be parted round at once. */
const HOLES = 4;
/** Metres over which a storm thins to nothing as it comes up to a mountain's foot (as Weather's shelter does). */
const HOLE_BAND = 900;
/** How far off a storm is still drawn. */
const REACH = 16000;
/** Extinction per metre in the thick of it: the ground is gone at about forty metres. */
const SIGMA = 0.062;

/**
 * Goes into the post shader after its noise helpers. applyStorm() takes the colour of the scene
 * at this pixel and returns it with the storms laid over.
 */
export const STORM_GLSL = /* glsl */ `
uniform float uStormN;
uniform vec4 uStormA[${MAX}]; // centre x, z and heading x, z
uniform vec4 uStormB[${MAX}]; // half width, half depth, top (world y), strength 0..1
uniform float uStormBase[${MAX}]; // ground under the middle (world y)
uniform vec3 uStormHole[${MAX * HOLES}]; // mountains it parts round: x, z and the radius kept clear
uniform vec3 uStormEye;
uniform mat4 uStormInv; // clip space to world
uniform vec3 uSunDir;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uDetail;

const float ST_BILLOW = 300.0;

// Signed distance to the slab, in metres, with its faces thrown into rolling heads.
// q is (a, y above the ground, b).
float stormShape(vec3 q, vec4 B, float base) {
  // the crest is no ruled line: it stands higher here and lower there along the front, and
  // falls away toward either end
  float top = (B.z - base) * (0.6 + 0.4 * vnoise(vec2(q.z / 850.0 + B.z, q.x / 1300.0)))
            * (1.0 - 0.6 * smoothstep(0.4, 1.0, abs(q.z) / B.x));
  // the heads: great ones that make the outline, lesser ones that break it, all rolling over
  // and down the leading face
  float roll = uTime * 5.0;
  // (the lesser two are folded, |2n - 1|: round heads with creases between, as cloud has)
  float n = vnoise(vec2(q.z + q.x * 0.6, q.y * 1.25 + roll) / 480.0) * 0.46
          + abs(2.0 * vnoise(vec2(q.z * 1.3 - q.x, q.y * 1.4 + roll * 1.7) / 260.0 + 31.7) - 1.0) * 0.36
          + abs(2.0 * vnoise(vec2(q.z + q.x, q.y + roll * 2.2) / 110.0 + 9.1) - 1.0) * 0.18;
  // a rounded box: the leading edge leans out over the ground it is about to take
  float lean = 0.22 * q.y * smoothstep(-B.y, B.y, q.x);
  vec3 d = vec3(abs(q.x - lean * 0.5) - B.y, q.y - top, abs(q.z) - B.x);
  const float R = 320.0;
  vec3 m = max(d + R, 0.0);
  float box = length(m) - R + min(max(d.x, max(d.y, d.z)) + R, 0.0);
  return box - (n - 0.42) * ST_BILLOW * (0.35 + 0.65 * smoothstep(0.0, 260.0, q.y));
}

vec3 applyStorm(vec3 col, vec2 uv, float jitter) {
  if (uStormN < 0.5) return col;
  float depth = texture2D(tDepth, uv).r;
  vec4 wp = uStormInv * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 hit = wp.xyz / wp.w;
  vec3 rd = hit - uStormEye;
  float scene = length(rd);
  rd /= max(scene, 1e-4);
  if (depth > 0.99999) scene = 1e9;

  int steps = int(mix(8.0, 18.0, clamp(uDetail, 0.0, 1.0)));
  float T = 1.0;
  vec3 acc = vec3(0.0);

  for (int s = 0; s < ${MAX}; s++) {
    if (float(s) >= uStormN) break;
    vec4 A = uStormA[s];
    vec4 B = uStormB[s];
    float base = uStormBase[s];
    if (B.w < 0.004) continue;
    vec2 hd = A.zw;
    vec2 sd = vec2(-hd.y, hd.x);
    // the eye and the ray in the slab's frame
    vec2 e = uStormEye.xz - A.xy;
    vec3 ro = vec3(dot(e, hd), uStormEye.y - base, dot(e, sd));
    vec3 dr = vec3(dot(rd.xz, hd), rd.y, dot(rd.xz, sd));
    // where the ray is inside the slab's bounds (grown by what the heads and the lean can add)
    vec3 lo = vec3(-B.y - ST_BILLOW, -400.0, -B.x - ST_BILLOW);
    vec3 hi = vec3(B.y + ST_BILLOW + 0.22 * (B.z - base), B.z - base + ST_BILLOW, B.x + ST_BILLOW);
    vec3 inv = 1.0 / (abs(dr) + 1e-6) * sign(dr + 1e-9);
    vec3 ta = (lo - ro) * inv;
    vec3 tb = (hi - ro) * inv;
    vec3 tmn = min(ta, tb);
    vec3 tmx = max(ta, tb);
    float t0 = max(max(tmn.x, max(tmn.y, tmn.z)), 0.0);
    float t1 = min(min(tmx.x, min(tmx.y, tmx.z)), scene);
    if (t1 <= t0) continue;

    // the sun, in the slab's frame, for the light on the heads
    vec3 sun = vec3(dot(uSunDir.xz, hd), uSunDir.y, dot(uSunDir.xz, sd));
    float span = t1 - t0;
    float prev = t0;
    for (int i = 0; i < 18; i++) {
      if (i >= steps || T < 0.02) break;
      // steps crowd toward the near end: the face of the wall from outside, the first few
      // metres from within
      float f1 = (float(i) + 1.0) / float(steps);
      float next = t0 + span * f1 * f1;
      float seg = next - prev;
      float tm = prev + seg * jitter;
      prev = next;
      vec3 q = ro + dr * tm;
      // Well inside, there is no shape to find: it is thick all round, and lit from nowhere.
      // (Most of what is drawn from within is this, so it is worth not working the heads out.)
      float full = B.z - base;
      bool deep = abs(q.x) < B.y - 520.0 && abs(q.z) < B.x * 0.4 && q.y < full * 0.6 - 420.0;
      float d = deep ? -1000.0 : stormShape(q, B, base);
      // a hard face in front, a long thinning tail behind
      float soft = mix(520.0, 70.0, smoothstep(-B.y, B.y * 0.4, q.x));
      float dens = (1.0 - smoothstep(-soft, 0.0, d)) * B.w;
      // and it thins out over the top, where there is only what the wind has carried up
      dens *= 1.0 - 0.75 * smoothstep(0.35, 1.0, q.y / (B.z - base));
      if (dens < 0.002) continue;
      // no storm climbs a mountain: it parts round the foot of each and leaves it standing clear
      vec2 wxz = uStormEye.xz + rd.xz * tm;
      for (int h = 0; h < ${HOLES}; h++) {
        vec3 H = uStormHole[s * ${HOLES} + h];
        dens *= smoothstep(H.z, H.z + ${HOLE_BAND.toFixed(1)}, distance(wxz, H.xy));
      }
      if (dens < 0.002) continue;
      // close to, it is not even: it comes past in sheets, thick and then thin, running the way
      // the storm goes, and the ground shows and is lost again between them
      float sheet = vnoise(vec2(q.x * 0.03 - uTime * 0.85, q.z * 0.2 + q.y * 0.28))
                  * 0.65 + vnoise(vec2(q.x * 0.09 - uTime * 2.1, q.z * 0.55 + q.y * 0.7) + 5.3) * 0.35;
      dens *= mix(1.0, 0.3 + 1.4 * sheet, smoothstep(170.0, 15.0, tm));
      float a = 1.0 - exp(-dens * ${SIGMA.toFixed(3)} * seg);
      // light: does the shape open toward the sun here? Deep inside there is no telling.
      float lit = 0.5;
      if (d > -260.0) {
        float g = (stormShape(q + sun * 110.0, B, base) - d) / 110.0;
        lit = mix(0.5, smoothstep(-0.15, 0.6, g), smoothstep(-260.0, -10.0, d));
      }
      float hgt = clamp(q.y / (B.z - base), 0.0, 1.0);
      // sand in the air is the sand's own colour, a little browner in its shadows
      vec3 dark = uShade * vec3(0.86, 0.74, 0.62) * mix(0.78, 1.0, hgt);
      vec3 c = mix(dark, uLit * vec3(1.0, 0.95, 0.86), lit * mix(0.65, 1.0, hgt));
      // what lies between it and the eye
      c = mix(c, uFogCol, (1.0 - exp(-tm * uFog)) * 0.35);
      acc += T * a * c;
      T *= 1.0 - a;
    }
  }
  return col * T + acc;
}
`;

/** Declares the storm's uniforms on the shared set. Call before any material spreads it. */
export function stormUniforms(u: Uniforms): void {
  u.uStormN = { value: 0 };
  u.uStormA = { value: Array.from({ length: MAX }, () => new THREE.Vector4(0, 0, 1, 0)) };
  u.uStormB = { value: Array.from({ length: MAX }, () => new THREE.Vector4(1, 1, 1, 0)) };
  u.uStormBase = { value: new Array<number>(MAX).fill(0) };
  u.uStormHole = { value: Array.from({ length: MAX * HOLES }, () => new THREE.Vector3(0, 0, -1e6)) };
  u.uStormK = { value: 0 }; // how thick it is round the eye, for whatever is drawn in it
  u.uStormEye = { value: new THREE.Vector3() };
  u.uStormInv = { value: new THREE.Matrix4() };
}

const centre = new THREE.Vector2();
const dimmed = new THREE.Vector3();

/**
 * Keeps the storm's uniforms in step with the weather, and takes the sun off the ground for
 * whoever stands in one. Call once a frame, after the day cycle has written the light.
 */
export function updateStorm(
  u: Uniforms,
  f: FrameState,
  groundAt: (x: number, z: number) => number,
  peaksAt: (x: number, z: number, reach: number) => readonly { x: number; z: number; r: number }[],
): void {
  const cam = f.camera;
  (u.uStormEye.value as THREE.Vector3).copy(cam.position);
  (u.uStormInv.value as THREE.Matrix4).multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);

  const A = u.uStormA.value as THREE.Vector4[];
  const B = u.uStormB.value as THREE.Vector4[];
  const base = u.uStormBase.value as number[];
  const holes = u.uStormHole.value as THREE.Vector3[];
  const px = f.player.pos.x;
  const pz = f.player.pos.z;
  let n = 0;
  // (storms() hands back the ones in reach; the nearest MAX are drawn)
  const near: { d: number; i: number }[] = [];
  const all = f.weather.storms(f.clock, px, pz, REACH);
  for (let i = 0; i < all.length; i++) {
    f.weather.centre(all[i], f.clock, centre);
    near.push({ d: Math.hypot(centre.x - px, centre.y - pz), i });
  }
  near.sort((p, q) => p.d - q.d);
  for (const { i } of near) {
    if (n >= MAX) break;
    const s = all[i];
    const life = f.weather.life(s, f.clock);
    if (life <= 0.004) continue;
    f.weather.centre(s, f.clock, centre);
    const g = groundAt(centre.x, centre.y);
    A[n].set(centre.x, centre.y, s.hx, s.hz);
    // it rises early in its life and sinks late, a little ahead of thickening and thinning
    B[n].set(s.width / 2, s.depth / 2, g + STORM_TOP * Math.sqrt(life), life);
    base[n] = g;
    // the mountains this one is passing: the nearest few to its middle
    const peaks = [...peaksAt(centre.x, centre.y, Math.hypot(s.width, s.depth) / 2 + HOLE_BAND)];
    const cx = centre.x;
    const cz = centre.y;
    peaks.sort((p, q) => Math.hypot(p.x - cx, p.z - cz) - p.r - (Math.hypot(q.x - cx, q.z - cz) - q.r));
    for (let h = 0; h < HOLES; h++) {
      const p = peaks[h];
      if (p) holes[n * HOLES + h].set(p.x, p.z, p.r);
      else holes[n * HOLES + h].set(0, 0, -1e6);
    }
    n++;
  }
  u.uStormN.value = n;

  // Inside, the sun is gone: no light falls straight on anything, no glow hangs round the disc,
  // and the stars are shut out.
  const k = f.storm;
  u.uStormK.value = k;
  if (k > 0.001) {
    const lit = u.uLit.value as THREE.Vector3;
    dimmed.copy(u.uShade.value as THREE.Vector3).lerp(lit, 0.22);
    lit.lerp(dimmed, k);
    for (const name of ['uRockLit', 'uSaltLit', 'uSnowLit'] as const) {
      const c = u[name]?.value as THREE.Vector3 | undefined;
      const sh = u[name.replace('Lit', 'Shade')]?.value as THREE.Vector3 | undefined;
      if (c && sh) c.lerp(dimmed.copy(sh).lerp(c, 0.22), k);
    }
    u.uGlow.value = (u.uGlow.value as number) * (1 - k);
    u.uStars.value = (u.uStars.value as number) * (1 - k);
  }
}
