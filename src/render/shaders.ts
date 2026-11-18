// Uber-shaders for Aster. GLSL1-style source for THREE.ShaderMaterial
// (three converts to GLSL ES 3.00 on WebGL2). Uniform names follow the
// contract in ./types.ts. All colours are display-space vec3.

import { STORM_GLSL } from './storm';

// Shared fragment helpers: hashing, value noise, 4-octave fbm (normalised to
// roughly 0..1) and an anti-aliased floor for stepped/banded quantities.
const COMMON = /* glsl */ `
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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

// floor(x) with a one-pixel ramp at each step so band edges do not stair-step.
float aaFloor(float x) {
  float w = clamp(fwidth(x), 1e-4, 1.0);
  return floor(x) + smoothstep(1.0 - w, 1.0, fract(x));
}
`;

// ---------------------------------------------------------------- SAND

export const sandVert = /* glsl */ `
varying vec3 vW;
varying vec3 vN;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = mat3(modelMatrix) * normal;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const sandFrag = /* glsl */ `
precision highp float;

uniform sampler2D uHeightMap;
uniform vec3 uRect;
uniform sampler2D uTrail;
uniform vec3 uTrailRect;

uniform float uTime;
uniform vec3 uSunDir;
uniform vec2 uWind;
uniform vec3 uFigPos;

uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uSunCol;
uniform vec3 uFogCol;
uniform vec3 uLine;

uniform float uBands;
uniform float uBandNoise;
uniform float uTermSharp;
uniform float uShadowK;
uniform float uShadowAmt;
uniform float uRipple;
uniform float uRippleBig;
uniform float uSparkle;
uniform float uContour;
uniform float uGrid;
uniform float uFacet;
uniform float uFlat;
uniform float uFog;

varying vec3 vW;
varying vec3 vN;

${COMMON}

// Explicit LOD: H is called inside the dynamic shadow loop, where implicit
// derivatives are undefined.
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

void main() {
  vec3 p = vW;
  float dist = length(p - cameraPosition);

  // ---- normal
  vec3 n0;
  vec3 n;
  if (uFacet > 0.5) {
    n0 = normalize(cross(dFdx(vW), dFdy(vW)));
    if (n0.y < 0.0) n0 = -n0;
    n = n0;
  } else {
    n0 = normalize(vN);
    n = n0;
    vec2 w = uWind;
    vec2 g = vec2(0.0);

    // small ripples, 0.5 m
    float k1 = 6.2831853 / 0.5;
    float ph1 = dot(p.xz, w) * k1 + fbm(p.xz * 0.45) * 9.0;
    float aa1 = 1.0 - smoothstep(1.2, 2.8, fwidth(ph1));
    float fade1 = 1.0 - smoothstep(6.0, 45.0, dist);
    float pat1 = 0.25 + 0.75 * smoothstep(0.25, 0.75, fbm(p.xz * 0.05 + vec2(3.7, 1.3)));
    g += w * cos(ph1) * (0.35 * uRipple * fade1 * aa1 * pat1);

    // big ripples, 2.6 m
    float k2 = 6.2831853 / 2.6;
    float ph2 = dot(p.xz, w) * k2 + fbm(p.xz * 0.08 + vec2(11.0, 4.0)) * 10.0;
    float aa2 = 1.0 - smoothstep(1.2, 2.8, fwidth(ph2));
    float fade2 = 1.0 - smoothstep(40.0, 350.0, dist);
    float pat2 = 0.3 + 0.7 * smoothstep(0.3, 0.7, fbm(p.xz * 0.012 + vec2(-5.1, 8.2)));
    g += w * cos(ph2) * (0.35 * uRippleBig * fade2 * aa2 * pat2);

    n.xz -= g;
    n = normalize(n);
  }

  // ---- footprints (sampled unconditionally and masked: keeps derivatives defined)
  vec2 tuv = (p.xz - uTrailRect.xy) / uTrailRect.z;
  float inT = step(0.0, tuv.x) * step(tuv.x, 1.0) * step(0.0, tuv.y) * step(tuv.y, 1.0);
  vec2 tc = clamp(tuv, 0.0, 1.0);
  float te = 1.5 / 2048.0;
  float tr = texture2D(uTrail, tc).r * inT;
  float tdx = (texture2D(uTrail, tc + vec2(te, 0.0)).r - texture2D(uTrail, tc - vec2(te, 0.0)).r) / (2.0 * te * uTrailRect.z);
  float tdz = (texture2D(uTrail, tc + vec2(0.0, te)).r - texture2D(uTrail, tc - vec2(0.0, te)).r) / (2.0 * te * uTrailRect.z);
  n = normalize(n + vec3(tdx, 0.0, tdz) * (1.6 * inT));

  float ndl = dot(n, uSunDir);

  // ---- cast shadow (heightmap ray-march)
  float shadow = 1.0;
  if (uShadowAmt > 0.001 && ndl > -0.02) {
    vec3 o = vec3(p.x, max(p.y, H(p.xz)) + 0.6, p.z) + n0 * 0.8;
    float res = 1.0;
    float t = 3.0;
    for (int i = 0; i < 30; i++) {
      vec3 q = o + uSunDir * t;
      float hh = q.y - H(q.xz);
      res = min(res, uShadowK * hh / t);
      if (res <= 0.0) break;
      t += max(2.0, t * 0.18);
    }
    shadow = clamp(res, 0.0, 1.0);
  }

  float fs = figShadow(p);

  // ---- light
  float l = mix(clamp(ndl * 1.25, 0.0, 1.0), smoothstep(-0.02, 0.12, ndl), uTermSharp);
  l *= mix(1.0, shadow, uShadowAmt);
  l *= 1.0 - fs * 0.85;
  l *= 1.0 - tr * 0.45;

  if (uBands > 0.5) {
    float x = l * uBands + 0.5 + (fbm(vW.xz * 0.6) - 0.5) * uBandNoise;
    l = clamp(aaFloor(x) / uBands, 0.0, 1.0);
  }

  // ---- colour
  float amb = 0.5 + 0.5 * n.y;
  vec3 col = mix(uShade * mix(0.82 + 0.18 * amb, 1.0, uFlat), uLit, l);
  if (uFlat < 0.5) {
    col *= 0.96 + 0.08 * fbm(p.xz * 0.3 + vec2(2.3, 7.1));
  }

  // ---- sparkle
  if (uSparkle > 0.001) {
    vec2 sc = p.xz / 0.03;
    vec2 id = floor(sc);
    vec2 f = fract(sc) - 0.5;
    float fwc = max(max(fwidth(sc.x), fwidth(sc.y)), 1e-4);
    float r1 = hash21(id);
    float r2 = hash21(id + 71.3);
    vec2 off = (vec2(r2, hash21(id + 19.1)) - 0.5) * 0.5;
    float rad = 0.14;
    float dotc = 1.0 - smoothstep(rad - fwc, rad + fwc, length(f - off));
    dotc *= 1.0 - smoothstep(0.6, 1.5, fwc); // sub-pixel cells shimmer: drop them
    float on = step(0.95, r1);
    vec3 V = normalize(cameraPosition - p);
    vec3 Hv = normalize(uSunDir + V);
    vec3 gn = normalize(n + (vec3(r2, hash21(id + 5.7), hash21(id + 9.1)) - 0.5) * 0.6);
    float spec = pow(max(dot(gn, Hv), 0.0), 16.0);
    float tw = 0.5 + 0.5 * sin(uTime * (1.2 + 2.5 * r2) + r1 * 80.0);
    float glint = on * dotc * (0.15 + 1.6 * spec) * tw * l * (1.0 - smoothstep(25.0, 60.0, dist));
    col += uSunCol * glint * uSparkle;
  }

  // ---- contour lines every 4 m, every 5th thicker
  if (uContour > 0.001) {
    float y = p.y / 4.0;
    float fy = max(fwidth(y), 1e-5);
    float dl = abs(fract(y + 0.5) - 0.5) / fy;
    float idx = floor(y + 0.5);
    float major = 1.0 - step(0.5, mod(idx, 5.0));
    float hw = mix(0.5, 1.1, major);
    float ln = 1.0 - smoothstep(hw - 0.5, hw + 0.5, dl);
    float fadeMinor = 1.0 - smoothstep(0.12, 0.3, fy);
    float fadeMajor = 1.0 - smoothstep(0.6, 1.5, fy);
    ln *= mix(fadeMinor, fadeMajor, major);
    col = mix(col, uLine, ln * uContour);
  }

  // ---- world grid every 8 m
  if (uGrid > 0.001) {
    vec2 gg = p.xz / 8.0;
    vec2 fg = max(fwidth(gg), vec2(1e-5));
    vec2 dg = abs(fract(gg + 0.5) - 0.5) / fg;
    vec2 lg = (1.0 - smoothstep(vec2(0.0), vec2(1.0), dg)) * (1.0 - smoothstep(vec2(0.12), vec2(0.3), fg));
    col = mix(col, uLine, max(lg.x, lg.y) * uGrid);
  }

  // ---- fog
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));

  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------- SKY

export const skyVert = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const skyFrag = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunCol;
uniform vec3 uFogCol;
uniform vec3 uShade;
uniform float uSunSize;
uniform float uGlow;
uniform float uStars;
uniform float uSkyCurve;
uniform float uSkyBands;
uniform float uSunBands;
uniform float uMtn;

varying vec3 vDir;

${COMMON}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

void main() {
  vec3 d = normalize(vDir);
  // The camera stands above the sand, so the visible horizon sits a little below eye level.
  float h = d.y + 0.035;

  // ---- gradient
  float g = pow(clamp(h, 0.0, 1.0), uSkyCurve);
  if (uSkyBands > 0.5) {
    g = clamp(aaFloor(g * uSkyBands) / max(uSkyBands - 1.0, 1.0), 0.0, 1.0);
  }
  vec3 col = mix(uHorizon, uTop, g);

  // ---- glow
  float sd = dot(d, uSunDir);
  float sdp = max(sd, 0.0);
  col += uSunCol * (pow(sdp, 40.0) * 0.35 + pow(sdp, 6.0) * 0.12) * uGlow;

  // ---- stars
  if (uStars > 0.001) {
    vec3 sp = d * 180.0;
    vec3 cell = floor(sp);
    float fwS = max(length(fwidth(sp)), 1e-4);
    float hs = hash31(cell);
    vec3 jit = hash33(cell);
    vec3 c = normalize(cell + 0.2 + 0.6 * jit) * 180.0;
    float sdist = length(sp - c);
    float rad = 0.07 + 0.08 * jit.z;
    float aa = fwS * 0.6;
    float core = 1.0 - smoothstep(rad - aa, rad + aa, sdist);
    core *= min(1.0, rad / aa); // keep sub-pixel stars from flickering at full strength
    float on = step(0.985, hs);
    float tw = 0.6 + 0.4 * sin(uTime * (1.5 + 3.0 * jit.x) + hs * 60.0);
    float b = on * core * tw * mix(0.4, 1.0, jit.y) * smoothstep(0.02, 0.25, h);
    col += vec3(b * uStars);
  }

  // ---- sun disc
  float ang = atan(length(cross(d, uSunDir)), sd);
  float fa = max(fwidth(ang), 1e-5);
  float disc = 1.0 - smoothstep(uSunSize - fa, uSunSize + fa, ang);
  if (uSunBands > 0.5) {
    vec3 rgt = cross(uSunDir, vec3(0.0, 1.0, 0.0));
    rgt = length(rgt) > 1e-4 ? normalize(rgt) : vec3(1.0, 0.0, 0.0);
    vec3 upv = cross(rgt, uSunDir);
    float yy = -dot(d, upv) / max(uSunSize, 1e-4); // 0 at centre, 1 at bottom
    float sy = yy * 5.0;
    float fws = max(fwidth(sy), 1e-4);
    float f = abs(fract(sy) - 0.5);
    float gapW = 0.15 + 0.45 * clamp(yy, 0.0, 1.0);
    float gap = (1.0 - smoothstep(gapW * 0.5 - fws, gapW * 0.5 + fws, f)) * step(0.0, yy);
    disc *= 1.0 - gap;
  }
  col = mix(col, uSunCol, disc);

  // ---- distant mountains
  if (uMtn > 0.01) {
    vec2 az = d.xz / max(length(d.xz), 1e-4);

    float f1 = fbm(az * 2.3 + vec2(5.2, 1.3));
    float hF = 0.07 * uMtn * clamp(f1 * 1.5 - 0.3, 0.0, 1.0);
    float e1 = h - hF;
    float w1 = max(fwidth(e1), 1e-5);
    float m1 = (1.0 - smoothstep(-w1, w1, e1)) * smoothstep(0.0, 0.003, hF);
    vec3 farC = mix(uFogCol, uShade, 0.30);
    farC = mix(farC, uFogCol, 0.25 * (1.0 - clamp(h / max(hF, 1e-4), 0.0, 1.0)));
    col = mix(col, farC, m1);

    float f2 = fbm(az * 1.6 + vec2(-3.7, 8.1));
    float hN = 0.09 * uMtn * smoothstep(0.42, 0.85, f2);
    float e2 = h - hN;
    float w2 = max(fwidth(e2), 1e-5);
    float m2 = (1.0 - smoothstep(-w2, w2, e2)) * smoothstep(0.0, 0.003, hN);
    vec3 nearC = mix(uFogCol, uShade, 0.55);
    nearC = mix(nearC, uFogCol, 0.25 * (1.0 - clamp(h / max(hN, 1e-4), 0.0, 1.0)));
    col = mix(col, nearC, m2);
  }

  // ---- below the horizon
  col = mix(col, uFogCol, 1.0 - smoothstep(-0.04, 0.0, h));

  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------- FIGURE

export const figVert = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;

varying vec3 vW;
varying vec3 vN;

void main() {
  vec3 p = position;
  float k = 1.0 - clamp(p.y / 1.5, 0.0, 1.0);
  float fl = 0.6 * sin(uTime * 3.3 + p.y * 5.0 + p.x * 4.0)
           + 0.4 * sin(uTime * 5.7 + p.z * 6.0 - p.y * 3.0);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  // offset applied in world xz so it stays downwind even if the mesh is rotated
  wp.xz += uWind * (k * k * (0.28 + 0.12 * fl));
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const figFrag = /* glsl */ `
precision highp float;

uniform vec3 uSunDir;
uniform vec3 uFig;
uniform vec3 uFigLit;
uniform vec3 uFogCol;
uniform float uBands;
uniform float uFog;

varying vec3 vW;
varying vec3 vN;

${COMMON}

void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float l = smoothstep(0.0, 0.3, dot(n, uSunDir));
  if (uBands > 0.5) {
    l = clamp(aaFloor(l * uBands + 0.5) / uBands, 0.0, 1.0);
  }
  vec3 col = mix(uFig, uFigLit, l * 0.8);
  float dist = length(vW - cameraPosition);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------- POST

export const postVert = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const postFrag = /* glsl */ `
precision highp float;

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uTime;

uniform vec3 uInk;
uniform vec3 uPaperCol;
uniform vec3 uA;
uniform vec3 uB;

uniform float uMode;
uniform float uGrain;
uniform float uVig;
uniform float uChroma;
uniform float uSat;
uniform float uContrast;
uniform float uPoster;
uniform float uPosterDither;
uniform float uPixelRows;
uniform float uOutline;
uniform float uOutlineW;
uniform float uPaper;
uniform float uWobble;

varying vec2 vUv;

${COMMON}

#define bayer2(a) fract(dot(floor(a), vec2(0.5, floor(a).y * 0.75)))
#define bayer4(a) (bayer2(0.5 * (a)) * 0.25 + bayer2(a))
#define bayer8(a) (bayer4(0.5 * (a)) * 0.25 + bayer2(a))

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

${STORM_GLSL}

vec3 grade(vec3 c) {
  float lum = dot(c, LUMA);
  c = mix(vec3(lum), c, uSat);
  c = (c - 0.5) * uContrast + 0.5;
  return clamp(c, 0.0, 1.0);
}

float lineCov(float d, float hw, float aa) {
  return 1.0 - smoothstep(hw - aa, hw + aa, d);
}

// One rotated halftone screen. fc in pixels, cell in pixels.
float dotScreen(vec2 fc, float ang, float cell, float cov) {
  float c = cos(ang);
  float s = sin(ang);
  vec2 q = mat2(c, s, -s, c) * fc / cell;
  vec2 f = fract(q) - 0.5;
  float r = sqrt(cov) * 0.72;
  float aa = 0.75 / cell;
  return (1.0 - smoothstep(r - aa, r + aa, length(f))) * smoothstep(0.01, 0.03, cov);
}

// Parallel lines along dir, spacing and half width in unit space.
float hatch(vec2 p, vec2 dir, float spacing, float hw, float aa) {
  float dd = abs(fract(dot(p, dir) / spacing) - 0.5) * spacing;
  return lineCov(dd, hw, aa);
}

void main() {
  vec2 px = 1.0 / uRes;
  float unit = uRes.y / 500.0;

  // 1. pixelate
  float ps = 1.0;
  vec2 uv = vUv;
  if (uPixelRows > 0.5) {
    ps = max(1.0, floor(uRes.y / uPixelRows));
    uv = (floor(gl_FragCoord.xy / ps) * ps + 0.5 * ps) * px;
  }
  vec2 blockCoord = floor(gl_FragCoord.xy / ps);

  // 2. wobble (noise sampled per block so pixel blocks stay intact)
  if (uWobble > 0.001) {
    vec2 q = blockCoord * ps / unit * 0.015;
    vec2 wv = vec2(vnoise(q), vnoise(q + vec2(17.3, 41.9))) - 0.5;
    uv += wv * (6.0 * unit * uWobble) * px;
  }

  // 3. sample + chromatic aberration
  vec3 col;
  if (uChroma > 0.0001) {
    vec2 o = (uv - 0.5) * uChroma;
    col = vec3(texture2D(tColor, uv + o).r, texture2D(tColor, uv).g, texture2D(tColor, uv - o).b);
  } else {
    col = texture2D(tColor, uv).rgb;
  }

  // 3b. sandstorms, laid over the scene before anything is drawn on top of it
  col = applyStorm(col, uv, bayer8(gl_FragCoord.xy));

  // 4. depth-edge outline
  bool mode3 = abs(uMode - 3.0) < 0.5;
  float edge = 0.0;
  if (uOutline > 0.001 || mode3) {
    vec2 o = px * unit * uOutlineW;
    float dc = texture2D(tDepth, uv).r;
    float s4 = texture2D(tDepth, uv + vec2(o.x, 0.0)).r
             + texture2D(tDepth, uv - vec2(o.x, 0.0)).r
             + texture2D(tDepth, uv + vec2(0.0, o.y)).r
             + texture2D(tDepth, uv - vec2(0.0, o.y)).r;
    edge = smoothstep(0.02, 0.07, abs(s4 - 4.0 * dc) / max(1.0 - dc, 1e-5));
    col = mix(col, uInk, edge * uOutline);
  }

  // 5. grade
  col = grade(col);

  // 6. posterize
  if (uPoster > 0.5) {
    float bd = bayer8(blockCoord);
    col = clamp(floor(col * uPoster + mix(0.5, bd, uPosterDither)) / uPoster, 0.0, 1.0);
  }

  float lum = dot(col, LUMA);

  if (abs(uMode - 1.0) < 0.5) {
    // 7. two-ink halftone with misregistration
    vec3 c2 = grade(texture2D(tColor, uv + px * unit * vec2(2.5, -1.5)).rgb);
    float covA = clamp((col.r - col.b) * 1.3, 0.0, 1.0);
    float covB = clamp(1.0 - c2.r * 1.05, 0.0, 1.0);
    float cell = uRes.y / 110.0;
    float dA = dotScreen(gl_FragCoord.xy, 0.26, cell, covA);
    float dB = dotScreen(gl_FragCoord.xy, 1.3, cell, covB);
    col = uPaperCol * mix(vec3(1.0), uA, dA) * mix(vec3(1.0), uB, dB);
  } else if (abs(uMode - 2.0) < 0.5) {
    // 8. one-bit ordered dither
    col = mix(uA, uB, step(bayer8(blockCoord), lum * 1.1 - 0.05));
  } else if (mode3) {
    // 9. cross-hatch
    vec2 p = gl_FragCoord.xy / unit;
    p += (vec2(vnoise(p * 0.04), vnoise(p * 0.04 + vec2(9.7, 3.1))) - 0.5) * 3.0;
    float aa = 0.8 / unit;
    float w1 = 1.0 - smoothstep(0.62, 0.78, lum);
    float w2 = 1.0 - smoothstep(0.40, 0.56, lum);
    float w3 = 1.0 - smoothstep(0.20, 0.36, lum);
    float h1 = hatch(p, vec2(0.70710678, 0.70710678), 6.0, mix(0.2, 0.75, w1), aa) * w1;
    float h2 = hatch(p, vec2(0.70710678, -0.70710678), 6.0, mix(0.2, 0.75, w2), aa) * w2;
    float h3 = hatch(p, vec2(0.96592583, 0.25881905), 3.5, mix(0.15, 0.6, w3), aa) * w3;
    float ink = max(max(h1, h2), max(h3, edge));
    col = mix(uB, uA, ink);
  }

  // 10. paper
  if (uPaper > 0.001) {
    vec2 q = gl_FragCoord.xy / unit;
    float fib = vnoise(vec2(q.x * 0.12, q.y * 0.9)) * 0.55
              + vnoise(vec2(q.x * 0.8 + q.y * 0.25, q.y * 0.09) + vec2(13.1, 2.7)) * 0.45;
    float grn = vnoise(q * 1.1 + vec2(5.3, 8.9));
    float pn = 1.0 - uPaper * (0.09 * fib + 0.07 * grn);
    col *= pn * mix(vec3(1.0), uPaperCol, 0.35 * uPaper);
  }

  // 11. grain + vignette
  float gn = hash21(gl_FragCoord.xy + fract(uTime * 7.31) * vec2(491.3, 173.9)) - 0.5;
  col += gn * uGrain;
  vec2 v = vUv - 0.5;
  col *= 1.0 - uVig * dot(v, v) * 1.6;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
