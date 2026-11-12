// Terrain shaders for the game: the clipmap surface (sand, rock, salt) in the
// '35 mm' look, and the full-screen pass that bakes surface() into a heightmap.
// GLSL1-style source for THREE.ShaderMaterial; three prepends `#version 300 es`
// on WebGL2, so uint, textureLod and textureSize are available.
//
// Mobile notes: every stage declares highp float and int itself (surface()
// hashes with uint and breaks under mediump); textures are only read with
// textureLod inside loops and branches; every derivative is taken before the
// first discard; loops have constant bounds and break early on uniforms.
//
// Run-time quality (shared uniforms, created by Clipmap; see game/quality.ts):
//   float uShadowSteps  heightmap ray-march steps, 1..32 (30 = full quality)
//   float uDetail       0..1 scale on optional fragment work (1 = full quality)
import { SURFACE_GLSL } from '../world/surface';
import { CITY_SHADOW_GLSL, CITY_SITES_GLSL } from '../city/cityGlsl';

// '35 mm' style, baked in.
const LOOK = /* glsl */ `
const float TERM_SHARP = 0.6;
const float SHADOW_K = 8.0;
const float RIPPLE = 0.9;
const float RIPPLE_BIG = 0.45;
const float SPARKLE = 0.35;
const float TRAIL_NORMAL = 0.14; // depth 1.0 is roughly a 14 cm hollow
const float MAX_TERRAIN_H = 620.0;
`;

// Same helpers as the gallery shaders.
const COMMON = /* glsl */ `
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = m * p + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return s / 0.9375;
}
`;

// ---------------------------------------------------------------- CLIPMAP

export const terrainVert = /* glsl */ `
precision highp float;
precision highp int;

${SURFACE_GLSL}

uniform vec2 uLevelCenter; // snapped world xz of this level's centre
uniform float uCell;       // metres per grid cell
uniform float uLower;      // metres to sink this level (0 for the finest)

varying vec3 vW;
varying vec3 vN;
varying vec2 vMask; // rock, salt

void main() {
  vec2 xz = uLevelCenter + position.xz * uCell;
  vec3 s = surface(xz);
  float hx = surfaceH(xz + vec2(uCell, 0.0));
  float hz = surfaceH(xz + vec2(0.0, uCell));
  vN = normalize(vec3(s.x - hx, uCell, s.x - hz));
  vMask = s.yz;
  vec3 wp = vec3(xz.x, s.x - uLower, xz.y);
  vW = wp;
  // camera-relative so large world coordinates do not jitter
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * (wp - cameraPosition), 1.0);
}
`;

export const terrainFrag = /* glsl */ `
precision highp float;
precision highp int;

uniform sampler2D uHeightMap;
uniform vec3 uRect;
uniform float uTexel;
uniform sampler2D uTrailNear;
uniform vec3 uTrailNearRect;
uniform sampler2D uTrailFar;
uniform vec3 uTrailFarRect;

uniform float uTime;
uniform vec3 uSunDir;
uniform vec2 uWind;
uniform vec3 uFigPos;
uniform float uNight;
uniform float uFog;
uniform float uShadowSteps;
uniform float uDetail;

uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uRockLit;
uniform vec3 uRockShade;
uniform vec3 uSaltLit;
uniform vec3 uSaltShade;
uniform vec3 uSunCol;
uniform vec3 uFogCol;

${CITY_SITES_GLSL}
${CITY_SHADOW_GLSL}

uniform vec2 uInnerCenter; // centre of the next finer level
uniform float uInnerHalf;  // its half-size minus the overlap margin; < 0 = none

varying vec3 vW;
varying vec3 vN;
varying vec2 vMask;

${LOOK}
${COMMON}

// Explicit LOD everywhere: these run inside loops and branches.
// The heightmap holds raw metres in both the 32-bit and the 16-bit float bake.
float H(vec2 xz) {
  return textureLod(uHeightMap, (xz - uRect.xy) / uRect.z, 0.0).r;
}

float figShadow(vec3 p) {
  vec2 s = uSunDir.xz;
  float ss = dot(s, s);
  if (ss < 1e-6) return 0.0;
  float t = dot(uFigPos.xz - p.xz, s) / ss;
  if (t <= 0.0) return 0.0;
  vec3 q = p + uSunDir * t;
  float y = q.y - uFigPos.y;
  if (y < -0.1 || y > 1.85) return 0.0;
  float r = mix(0.42, 0.16, clamp(y / 1.8, 0.0, 1.0));
  float d = distance(q.xz, uFigPos.xz);
  float soft = 0.05 + t * 0.02;
  float ends = smoothstep(-0.1, -0.02, y) * (1.0 - smoothstep(1.75, 1.85, y));
  return (1.0 - smoothstep(r - soft, r + soft, d)) * ends;
}

// Disturbance depth at xz from one trail cascade, its gradient per metre and
// a weight that fades to 0 over the outer 10% of the rect.
float trailTap(sampler2D tex, vec3 rect, vec2 xz, out vec2 g, out float wgt) {
  float sz = max(rect.z, 1e-3);
  vec2 uv = (xz - rect.xy) / sz;
  vec2 c = abs(uv - 0.5) * 2.0;
  wgt = (1.0 - smoothstep(0.9, 1.0, max(c.x, c.y))) * step(1e-3, rect.z);
  if (wgt <= 0.0) {
    // outside this cascade: same result, no fetches
    g = vec2(0.0);
    return 0.0;
  }
  vec2 tc = clamp(uv, 0.0, 1.0);
  float te = 1.5 / max(float(textureSize(tex, 0).x), 1.0);
  float d = textureLod(tex, tc, 0.0).r;
  float dx = textureLod(tex, tc + vec2(te, 0.0), 0.0).r - textureLod(tex, tc - vec2(te, 0.0), 0.0).r;
  float dz = textureLod(tex, tc + vec2(0.0, te), 0.0).r - textureLod(tex, tc - vec2(0.0, te), 0.0).r;
  g = vec2(dx, dz) / (2.0 * te * sz) * wgt;
  return d * wgt;
}

// Cellular noise: distance to the nearest cell border (F2 - F1) and a per-cell random.
vec2 cells(vec2 x) {
  vec2 i = floor(x);
  vec2 f = x - i;
  float d1 = 8.0;
  float d2 = 8.0;
  float id = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int k = -1; k <= 1; k++) {
      vec2 o = vec2(float(k), float(j));
      vec2 h = hash22(i + o);
      vec2 r = o + 0.15 + 0.7 * h - f;
      float d = dot(r, r);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        id = h.x;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return vec2(sqrt(d2) - sqrt(d1), id);
}

void main() {
  vec3 p = vW;
  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  // Built ground: packed earth and paving. It is hard ground for the player (rock = 1 in the
  // surface function), but it must not look like mountain rock.
  float cityGround;
  float pave = cityBlend(p.xz, cityGround).y;
  float rock = clamp(vMask.x, 0.0, 1.0) * (1.0 - pave);
  float salt = clamp(vMask.y, 0.0, 1.0) * (1.0 - rock) * (1.0 - pave);
  float sandW = (1.0 - rock) * (1.0 - salt) * (1.0 - pave);

  // ---- every screen-space derivative up front, in uniform control flow
  // Ripples are set in the sand by the prevailing wind, so their direction is
  // fixed. Using the live, wandering wind here would sweep the whole pattern
  // across the ground.
  vec2 w = vec2(0.7648, 0.6442);
  float along = dot(p.xz, w);
  float fwAlong = fwidth(along);
  const float SALT_CELL = 1.4;
  vec2 saltUV = p.xz / SALT_CELL;
  vec2 fwSaltV = fwidth(saltUV);
  float fwSalt = max(fwSaltV.x, fwSaltV.y);
  float fwY = fwidth(p.y);
  vec2 sc = p.xz / 0.03;
  vec2 fwScV = fwidth(sc);
  float fwSc = max(max(fwScV.x, fwScV.y), 1e-4);

  // ---- clipmap overlap: the finer level draws here
  if (uInnerHalf > 0.0) {
    vec2 dd = abs(p.xz - uInnerCenter);
    if (max(dd.x, dd.y) < uInnerHalf) discard;
  }

  // ---- base normal: mesh near, heightmap far
  vec2 huv = (p.xz - uRect.xy) / max(uRect.z, 1.0);
  vec2 hc = abs(huv - 0.5) * 2.0;
  float he = max(hc.x, hc.y);
  float hOk = step(1.0, uRect.z) * (1.0 - step(0.995, he));
  vec3 n0 = normalize(vN);
  float nb = smoothstep(150.0, 400.0, dist) * hOk;
  if (nb > 0.0) {
    float e = uTexel / max(uRect.z, 1.0);
    float hl = textureLod(uHeightMap, huv - vec2(e, 0.0), 0.0).r;
    float hr = textureLod(uHeightMap, huv + vec2(e, 0.0), 0.0).r;
    float hd = textureLod(uHeightMap, huv - vec2(0.0, e), 0.0).r;
    float hu = textureLod(uHeightMap, huv + vec2(0.0, e), 0.0).r;
    vec3 nH = normalize(vec3(hl - hr, 2.0 * uTexel, hd - hu));
    n0 = normalize(mix(n0, nH, nb));
  }
  vec3 n = n0;

  // Optional work shrinks toward the camera at low detail (1.0 at full detail).
  float dk = mix(0.45, 1.0, clamp(uDetail, 0.0, 1.0));

  // ---- sand ripples, two scales (analytic derivative along the wind)
  float rip = sandW * (1.0 - smoothstep(0.35, 0.75, 1.0 - n0.y));
  if (rip > 0.001 && dist < 360.0) {
    vec2 g = vec2(0.0);
    float k1 = 6.2831853 / 0.5;
    float aa1 = 1.0 - smoothstep(1.2, 2.8, fwAlong * k1 * 1.3);
    float fade1 = 1.0 - smoothstep(6.0, 45.0 * dk, dist);
    if (fade1 * aa1 > 0.0) {
      // small ripples: their warp fbm is only paid for where they show
      float ph1 = along * k1 + fbm(p.xz * 0.45) * 9.0;
      float pat1 = 0.25 + 0.75 * smoothstep(0.25, 0.75, vnoise(p.xz * 0.05 + vec2(3.7, 1.3)));
      g += w * cos(ph1) * (0.35 * RIPPLE * fade1 * aa1 * pat1);
    }

    float k2 = 6.2831853 / 2.6;
    float ph2 = along * k2 + fbm(p.xz * 0.08 + vec2(11.0, 4.0)) * 10.0;
    float aa2 = 1.0 - smoothstep(1.2, 2.8, fwAlong * k2 * 1.3);
    float fade2 = 1.0 - smoothstep(40.0, 350.0, dist);
    float pat2 = 0.3 + 0.7 * smoothstep(0.3, 0.7, vnoise(p.xz * 0.012 + vec2(-5.1, 8.2)));
    g += w * cos(ph2) * (0.35 * RIPPLE_BIG * fade2 * aa2 * pat2);

    n.xz -= g * rip;
    n = normalize(n);
  }

  // ---- rock: break the smooth mesh normal into crags and ledges
  // (detail > 0.55: both octaves; 0.2..0.55: the large one only; below: none)
  float cragFar = 2500.0 * dk;
  if (rock > 0.01 && dist < cragFar && uDetail > 0.2) {
    float re = 0.7;
    vec2 rp = p.xz + p.y * vec2(0.37, -0.29);
    float c0 = fbm(rp * 0.2);
    float cx = fbm((rp + vec2(re, 0.0)) * 0.2);
    float cz = fbm((rp + vec2(0.0, re)) * 0.2);
    if (uDetail > 0.55) {
      c0 += 0.3 * fbm(rp * 0.9 + 9.0);
      cx += 0.3 * fbm((rp + vec2(re, 0.0)) * 0.9 + 9.0);
      cz += 0.3 * fbm((rp + vec2(0.0, re)) * 0.9 + 9.0);
    }
    float rk = rock * 3.5 * (1.0 - smoothstep(0.48 * cragFar, cragFar, dist));
    n = normalize(n - vec3(cx - c0, 0.0, cz - c0) * rk);
  }

  // ---- footprints and trails: near cascade inside its rect, far elsewhere
  vec2 gN;
  vec2 gF;
  float wN;
  float wF;
  float dN = trailTap(uTrailNear, uTrailNearRect, p.xz, gN, wN);
  float dF = trailTap(uTrailFar, uTrailFarRect, p.xz, gF, wF);
  float soft = (1.0 - rock) * (1.0 - pave);
  float tr = mix(dF, dN, wN) * soft;
  vec2 tg = mix(gF, gN, wN) * soft;
  vec3 tp = vec3(tg.x, 0.0, tg.y) * TRAIL_NORMAL;
  float tl = length(tp);
  if (tl > 0.85) tp *= 0.85 / tl;
  float ndlBase = dot(n, uSunDir);
  n = normalize(n + tp);

  // Hollows catch or lose light, but a footprint on a slope that faces away
  // from the sun must not light up.
  float ndl = min(dot(n, uSunDir), ndlBase + 0.06 + 0.7 * smoothstep(-0.05, 0.2, ndlBase));

  // ---- cast shadow: ray-march the heightmap toward the light
  float shadow = 1.0;
  float sIn = step(1.0, uRect.z) * (1.0 - smoothstep(0.82, 0.97, he));
  if (sIn > 0.0 && ndl > -0.05 && uSunDir.y > -0.1) {
    float h0 = H(p.xz);
    vec3 o = vec3(p.x, max(p.y, h0) + 0.25 * uTexel, p.z) + n0 * (0.5 * uTexel);
    float res = 1.0;
    float t = 2.0 * uTexel;
    // Fewer steps take longer strides so the ray still reaches about 1.3-1.5 km
    // (2.7-3 km with an 8 m texel): shadows get softer, not shorter.
    // At 30 steps this is exactly the original march.
    float steps = clamp(uShadowSteps, 1.0, 32.0);
    float sr = 30.0 / steps;
    float grow = 0.16 * pow(sr, 1.25);
    float minStep = 1.5 * uTexel * sr;
    for (int i = 0; i < 32; i++) {
      if (float(i) >= steps) break;
      vec3 q = o + uSunDir * t;
      float hh = q.y - H(q.xz);
      res = min(res, SHADOW_K * hh / t);
      if (res <= 0.0 || q.y > MAX_TERRAIN_H) break;
      t += max(minStep, t * grow);
    }
    shadow = mix(1.0, clamp(res, 0.0, 1.0), sIn);
  }

  float fs = figShadow(p);

  // ---- light
  float l = mix(clamp(ndl * 1.25, 0.0, 1.0), smoothstep(-0.02, 0.12, ndl), TERM_SHARP);
  l *= shadow;
  l *= cityShadow(p, uSunDir);
  l *= 1.0 - fs * 0.85;
  l *= 1.0 - tr * 0.22;
  float amb = 0.5 + 0.5 * n.y;
  // moonlight: keep a little more ambient so the ground stays readable
  l += (1.0 - l) * uNight * 0.14 * amb;

  // ---- sand
  vec3 sandCol = mix(uShade * (0.82 + 0.18 * amb), uLit, l);
  sandCol *= 0.96 + 0.08 * fbm(p.xz * 0.3 + vec2(2.3, 7.1));

  // ---- rock: strata bands on world height plus blotches
  vec3 rockCol = vec3(0.0);
  if (rock > 0.001) {
    float warp = vnoise(p.xz * 0.006) * 2.2 + vnoise(p.xz * 0.03) * 0.5;
    float sy = p.y / 7.0 + warp;
    float aaS = 1.0 - smoothstep(0.08, 0.35, fwY / 7.0);
    float band = smoothstep(0.15, 0.85, abs(fract(sy) - 0.5) * 2.0);
    float sy2 = p.y / 1.6 + warp * 2.0;
    float aaS2 = 1.0 - smoothstep(0.08, 0.35, fwY / 1.6);
    float band2 = abs(fract(sy2) - 0.5) * 2.0;
    float blot = fbm(p.xz * 0.045 + vec2(-3.1, 5.4));
    float tone = 0.9 + 0.22 * (band - 0.5) * aaS + 0.07 * (band2 - 0.5) * aaS2 + 0.22 * (blot - 0.5);
    tone *= 0.95 + 0.1 * vnoise(vec2(p.y * 0.9, warp * 3.0));
    rockCol = mix(uRockShade * (0.8 + 0.2 * amb), uRockLit, l) * tone;
  }

  // ---- salt: pale crust with polygonal cracks
  vec3 saltCol = vec3(0.0);
  if (salt > 0.001) {
    saltCol = mix(uSaltShade * (0.86 + 0.14 * amb), uSaltLit, l);
    float crackFade = (1.0 - smoothstep(0.12, 0.45, fwSalt)) * (1.0 - smoothstep(60.0 * dk, 220.0 * dk, dist));
    if (crackFade > 0.001) {
      vec2 cv = cells(saltUV);
      float lw = 0.045;
      float crack = 1.0 - smoothstep(lw - fwSalt, lw + fwSalt, cv.x);
      float rim = 1.0 - smoothstep(lw + 0.04 - fwSalt, lw + 0.16 + fwSalt, cv.x);
      saltCol *= 1.0 + (0.035 * (rim - crack) + 0.03 * (cv.y - 0.5)) * crackFade;
      saltCol = mix(saltCol, saltCol * 0.62, crack * crackFade);
    }
    saltCol *= 0.97 + 0.05 * vnoise(p.xz * 0.02);
  }

  vec3 col = mix(mix(sandCol, saltCol, salt), rockCol, rock);

  // ---- city ground: pale packed earth with a faint, worn paving pattern
  if (pave > 0.001) {
    vec3 paveCol = mix(uShade * (0.86 + 0.14 * amb), uLit, l) * vec3(0.95, 0.93, 0.9);
    float worn = fbm(p.xz * 0.07 + vec2(4.1, -2.7));
    paveCol *= 0.93 + 0.12 * worn;
    float pf = 1.0 - smoothstep(30.0, 110.0, dist);
    if (pf > 0.001) {
      vec2 pc = cells(p.xz / 1.5);
      float joint = 1.0 - smoothstep(0.03, 0.09, pc.x);
      paveCol *= 1.0 - (0.06 * joint + 0.04 * (pc.y - 0.5)) * pf * smoothstep(0.35, 0.6, worn);
    }
    col = mix(col, paveCol, pave);
  }

  // ---- sparkle on sand only
  float spk = sandW * (1.0 - smoothstep(25.0 * dk, 60.0 * dk, dist));
  if (spk > 0.001) {
    vec2 id = floor(sc);
    vec2 f = fract(sc) - 0.5;
    float r1 = hash21(id);
    float r2 = hash21(id + 71.3);
    vec2 off = (vec2(r2, hash21(id + 19.1)) - 0.5) * 0.5;
    float rad = 0.14;
    float dotc = 1.0 - smoothstep(rad - fwSc, rad + fwSc, length(f - off));
    dotc *= 1.0 - smoothstep(0.6, 1.5, fwSc);
    float on = step(0.95, r1);
    vec3 V = toCam / max(dist, 1e-4);
    vec3 Hv = normalize(uSunDir + V);
    vec3 gn = normalize(n + (vec3(r2, hash21(id + 5.7), hash21(id + 9.1)) - 0.5) * 0.6);
    float spec = pow(max(dot(gn, Hv), 0.0), 16.0);
    float tw = 0.5 + 0.5 * sin(uTime * (1.2 + 2.5 * r2) + r1 * 80.0);
    col += uSunCol * (on * dotc * (0.15 + 1.6 * spec) * tw * l * spk * SPARKLE);
  }

  // ---- fog
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));

  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------- HEIGHT BAKE

export const heightBakeVert = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const heightBakeFrag = /* glsl */ `
precision highp float;
precision highp int;

${SURFACE_GLSL}

uniform vec2 uBakeOrigin; // world xz of the texture's corner
uniform float uBakeTexel; // metres per texel

void main() {
  // gl_FragCoord.xy is the texel centre (i + 0.5), matching uv = (xz - origin) / size
  vec2 xz = uBakeOrigin + gl_FragCoord.xy * uBakeTexel;
  gl_FragColor = vec4(surface(xz), 1.0);
}
`;
