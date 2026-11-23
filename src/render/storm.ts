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
/** How high the underside of a rain cloud hangs over the ground, and how high its heads reach. */
const RAIN_BASE = 620;
const RAIN_TOP = 1500;
/** How many stretches of rained-on ground the ground shader is told about. */
export const WET_MAX = 3;
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
uniform float uStormKind[${MAX}]; // 0 a sandstorm, 1 rain
uniform vec3 uStormHole[${MAX * HOLES}]; // mountains it parts round: x, z and the radius kept clear
uniform vec3 uStormEye;
uniform mat4 uStormInv; // clip space to world
uniform vec3 uSunDir;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uDetail;
uniform vec3 uTop;
uniform vec3 uSunCol;

const float ST_BILLOW = 300.0;
const float RAIN_BASE = ${RAIN_BASE.toFixed(1)}; // the underside of a rain cloud, over the ground

// Rain at a point of its slab: x how thick (per metre), y how lit, z 1 in the cloud and 0 in the
// rain under it. q is (a, y above the ground, b); B as for a storm.
vec3 rainAt(vec3 q, vec4 B, float top) {
  // it has no wall: the cloud frays out at its edges and the rain under it thins with it
  float foot = (1.0 - smoothstep(B.y - 900.0, B.y, abs(q.x))) * (1.0 - smoothstep(B.x - 1100.0, B.x, abs(q.z)));
  if (foot <= 0.0) return vec3(0.0);
  float drift = uTime * 1.5;
  float big = vnoise(vec2(q.x + drift, q.z) / 760.0);
  if (q.y > RAIN_BASE - 170.0) {
    // the cloud: a ragged dark underside, heaped heads on top
    float n = big * 0.55
            + abs(2.0 * vnoise(vec2(q.x + q.y * 0.7 + drift, q.z - q.y * 0.5) / 280.0 + 7.3) - 1.0) * 0.3
            + vnoise(vec2(q.x - q.y, q.z + q.y) / 95.0 + 3.1) * 0.15;
    float under = RAIN_BASE + 150.0 * (n - 0.5);
    float over = mix(RAIN_BASE + 160.0, top, smoothstep(0.2, 0.75, n) * foot);
    float cd = smoothstep(under, under + 80.0, q.y) * (1.0 - smoothstep(over - 140.0, over, q.y));
    cd *= smoothstep(0.0, 0.3, foot - (1.0 - n) * 0.22);
    return vec3(cd * 0.02, smoothstep(RAIN_BASE + 60.0, top - 80.0, q.y), 1.0);
  }
  // the rain: grey shafts, slanting a little, heavier here and lighter there
  float shaft = vnoise(vec2((q.z + q.y * 0.22) / 75.0, (q.x - q.y * 0.3) / 240.0)) * 0.6 + big * 0.4;
  return vec3(foot * (0.2 + 1.1 * shaft * shaft) * 0.0034, 0.0, 0.0);
}

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

uniform float uRainbow;
uniform vec3 uSunPos;

// A rainbow: the arc 42 degrees out from the point opposite the sun, red outermost. It is light in
// the air a long way off, so it lies over the far hills and the rain, and under anything near.
vec3 bow(vec3 rd, float scene) {
  if (uRainbow < 0.002) return vec3(0.0);
  float ang = acos(clamp(dot(rd, -uSunPos), -1.0, 1.0));
  float x = (ang - 0.699) / 0.04; // 0 at the violet edge, 1 at the red
  if (x < -0.7 || x > 1.7) return vec3(0.0);
  float band = smoothstep(-0.6, 0.2, x) * (1.0 - smoothstep(0.8, 1.6, x));
  float hue = (1.0 - clamp(x, 0.0, 1.0)) * 0.76;
  vec3 c = clamp(abs(mod(hue * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  // it stands on the ground, and thins toward its feet
  return c * (band * 0.13 * uRainbow * smoothstep(900.0, 3500.0, scene) * smoothstep(-0.02, 0.1, rd.y));
}

vec3 applyStorm(vec3 col, vec2 uv, float jitter) {
  if (uStormN < 0.5 && uRainbow < 0.002) return col;
  float depth = texture2D(tDepth, uv).r;
  vec4 wp = uStormInv * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 hit = wp.xyz / wp.w;
  vec3 rd = hit - uStormEye;
  float scene = length(rd);
  rd /= max(scene, 1e-4);
  if (depth > 0.99999) scene = 1e9;
  vec3 arc = bow(rd, scene);

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
    // (rain falls on down to whatever ground there is, however far below the cloud's own)
    vec3 lo = vec3(-B.y - ST_BILLOW, uStormKind[s] > 0.5 ? -2500.0 : -400.0, -B.x - ST_BILLOW);
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
      if (uStormKind[s] > 0.5) {
        vec3 r = rainAt(q, B, B.z - base);
        if (r.x * B.w < 1e-5) continue;
        float ra = 1.0 - exp(-r.x * B.w * seg);
        // slate under, and where the sun gets at the heads, nearly white
        // (slate is reckoned from the sky it hangs in, so it is always the darker and the greyer of the two)
        vec3 slate = dot(uFogCol, vec3(0.333)) * vec3(0.36, 0.39, 0.45);
        vec3 head = mix(vec3(dot(uLit, vec3(0.333))), uSunCol, 0.35) * 1.08;
        vec3 rc = r.z > 0.5 ? mix(slate, head, r.y * (0.35 + 0.65 * max(uSunDir.y, 0.0))) : slate * 1.3;
        rc = mix(rc, uFogCol, (1.0 - exp(-tm * uFog)) * 0.45);
        acc += T * ra * rc;
        T *= 1.0 - ra;
        continue;
      }
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
  // (the bow shows against the rain behind it: it is added last, over everything far)
  return col * T + acc + arc;
}
`;

/** Declares the storm's uniforms on the shared set. Call before any material spreads it. */
export function stormUniforms(u: Uniforms): void {
  u.uStormN = { value: 0 };
  u.uStormA = { value: Array.from({ length: MAX }, () => new THREE.Vector4(0, 0, 1, 0)) };
  u.uStormB = { value: Array.from({ length: MAX }, () => new THREE.Vector4(1, 1, 1, 0)) };
  u.uStormBase = { value: new Array<number>(MAX).fill(0) };
  u.uStormKind = { value: new Array<number>(MAX).fill(0) };
  // what rain has left on the ground (see WET_GLSL), and a bow in the sky as it clears
  u.uWetA = { value: Array.from({ length: WET_MAX }, () => new THREE.Vector4(0, 0, 1, 0)) };
  u.uWetB = { value: Array.from({ length: WET_MAX }, () => new THREE.Vector4(0, 1, 1, 0)) };
  u.uWetBloom = { value: new Array<number>(WET_MAX).fill(0) };
  u.uRainK = { value: 0 };
  u.uRainbow = { value: 0 };
  u.uStormHole = { value: Array.from({ length: MAX * HOLES }, () => new THREE.Vector3(0, 0, -1e6)) };
  u.uStormK = { value: 0 }; // how thick it is round the eye, for whatever is drawn in it
  u.uStormEye = { value: new THREE.Vector3() };
  u.uStormInv = { value: new THREE.Matrix4() };
}

const centre = new THREE.Vector2();
const dimmed = new THREE.Vector3();
const peakScratch: { x: number; z: number; r: number }[] = [];

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
  const kind = u.uStormKind.value as number[];
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
    const rain = s.kind === 'rain';
    B[n].set(s.width / 2, s.depth / 2, g + (rain ? RAIN_TOP : STORM_TOP * Math.sqrt(life)), life);
    base[n] = g;
    kind[n] = rain ? 1 : 0;
    if (rain) {
      // (rain falls on mountains too)
      for (let h = 0; h < HOLES; h++) holes[n * HOLES + h].set(0, 0, -1e6);
      n++;
      continue;
    }
    // the mountains this one is passing: the nearest few to its middle
    const peaks = peakScratch;
    peaks.length = 0;
    for (const p of peaksAt(centre.x, centre.y, Math.hypot(s.width, s.depth) / 2 + HOLE_BAND)) peaks.push(p);
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

  // Under rain the light is soft and grey: the sun is behind cloud, the sky has lost its colour,
  // and what shadows there are, are faint.
  const r = f.rain;
  u.uRainK.value = r;
  if (r > 0.001) {
    const lit = u.uLit.value as THREE.Vector3;
    dimmed.copy(u.uShade.value as THREE.Vector3).lerp(lit, 0.45);
    lit.lerp(dimmed, r * 0.9);
    for (const name of ['uRockLit', 'uSaltLit', 'uSnowLit'] as const) {
      const c = u[name]?.value as THREE.Vector3 | undefined;
      const sh = u[name.replace('Lit', 'Shade')]?.value as THREE.Vector3 | undefined;
      if (c && sh) c.lerp(dimmed.copy(sh).lerp(c, 0.45), r * 0.9);
    }
    const hz = u.uHorizon.value as THREE.Vector3;
    const top = u.uTop.value as THREE.Vector3;
    const grey = (hz.x + hz.y + hz.z) / 3;
    hz.lerp(dimmed.set(grey, grey, grey * 1.04).multiplyScalar(0.86), r * 0.7);
    top.lerp(dimmed.multiplyScalar(0.8), r * 0.75);
    (u.uFogCol.value as THREE.Vector3).copy(hz);
    u.uGlow.value = (u.uGlow.value as number) * (1 - 0.85 * r);
    u.uStars.value = (u.uStars.value as number) * (1 - r);
  }

  // The ground that has been rained on, nearest first.
  const WA = u.uWetA.value as THREE.Vector4[];
  const WB = u.uWetB.value as THREE.Vector4[];
  const bloom = u.uWetBloom.value as number[];
  const tracks = f.weather.wet(f.clock, px, pz, 9000);
  let fresh = 0;
  for (let i = 0; i < WET_MAX; i++) {
    const t = tracks[i];
    if (!t) {
      WB[i].w = 0;
      bloom[i] = 0;
      continue;
    }
    WA[i].set(t.x0, t.z0, t.hx, t.hz);
    WB[i].set(t.len, t.halfWidth, t.halfDepth, t.wet);
    // The flowers go as the ground dries. (They come some hours behind the rain, which the
    // shader reckons at each point from how long ago the rain's front went over it.)
    bloom[i] = smooth(0, 0.3, t.wet);
    // (a rain that is still falling, or stopped within the last three hours or so)
    fresh = Math.max(fresh, smooth(0.86, 0.97, t.wet));
  }
  // A bow stands against the rain when the sun is out behind you and you are not under it: the
  // sun up, but low enough that the arc clears the ground.
  const el = f.sunDir.y;
  u.uRainbow.value = fresh * (1 - r) * smooth(0.02, 0.12, el) * (1 - smooth(0.5, 0.66, el));
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
