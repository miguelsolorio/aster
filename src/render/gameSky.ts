// Sky for the game: gradient, sun, moon, stars and thin high cloud.
// Unlike the gallery sky it has no painted mountains, because the world has real ones.

export const gameSkyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const gameSkyFrag = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uSunDir;   // current light (sun or moon), for the glow
uniform vec3 uSunPos;   // true sun
uniform vec3 uMoonPos;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunCol;
uniform vec3 uFogCol;
uniform float uGlow;
uniform float uStars;
uniform float uMoonVis;
uniform vec2 uWind;
// from the look
uniform float uSkyCurve; // gradient exponent
uniform float uSkyBands; // 0 = smooth gradient, N = stepped
uniform float uSunScale; // multiplier on the sun and moon discs
uniform float uSunBands; // 1 = striped lower half of the sun

varying vec3 vDir;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + 17.0;
    a *= 0.5;
  }
  return s;
}
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

float discMask(vec3 d, vec3 c, float size) {
  float ang = atan(length(cross(d, c)), dot(d, c));
  float fa = max(fwidth(ang), 1e-5);
  return 1.0 - smoothstep(size - fa, size + fa, ang);
}

// floor(x) with a one-pixel ramp at each step so band edges do not stair-step.
float aaFloor(float x) {
  float w = clamp(fwidth(x), 1e-4, 1.0);
  return floor(x) + smoothstep(1.0 - w, 1.0, fract(x));
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y + 0.02;
  float g = pow(clamp(h, 0.0, 1.0), uSkyCurve);
  float gb = clamp(aaFloor(g * max(uSkyBands, 1.0)) / max(uSkyBands - 1.0, 1.0), 0.0, 1.0);
  g = uSkyBands > 0.5 ? gb : g;
  vec3 col = mix(uHorizon, uTop, g);

  // glow around the light, plus a warm wash along the horizon under it
  float sdp = max(dot(d, uSunDir), 0.0);
  col += uSunCol * (pow(sdp, 40.0) * 0.35 + pow(sdp, 6.0) * 0.12) * uGlow;
  col += uSunCol * pow(sdp, 3.0) * 0.10 * (1.0 - g) * uGlow;

  // stars and a faint band of them
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
    core *= min(1.0, rad / aa);
    float on = step(0.982, hs);
    float tw = 0.6 + 0.4 * sin(uTime * (1.5 + 3.0 * jit.x) + hs * 60.0);
    float fade = smoothstep(0.02, 0.25, h);
    col += vec3(on * core * tw * mix(0.4, 1.0, jit.y) * fade * uStars);

    float band = exp(-pow(dot(d, normalize(vec3(0.42, 0.3, 0.86))) * 4.5, 2.0));
    float dustN = fbm(d.xz * 7.0 + d.y * 4.0);
    col += vec3(0.55, 0.72, 0.9) * band * dustN * 0.16 * fade * uStars;
  }

  // thin high cloud, drifting with the wind
  vec2 cp = d.xz / (d.y + 0.25) * 1.2 + uWind * uTime * 0.004;
  float cl = fbm(cp * vec2(1.0, 2.6));
  cl = smoothstep(0.52, 0.8, cl) * smoothstep(0.0, 0.15, h) * (1.0 - smoothstep(0.35, 0.8, h));
  vec3 cc = mix(uHorizon, uSunCol, 0.35 + 0.5 * pow(sdp, 4.0));
  col = mix(col, cc, cl * 0.32 * (1.0 - 0.65 * uStars));

  // sun, striped across its lower half in some looks
  float sunR = 0.028 * uSunScale;
  float sun = discMask(d, uSunPos, sunR);
  {
    vec3 rgt = cross(uSunPos, vec3(0.0, 1.0, 0.0));
    rgt = length(rgt) > 1e-4 ? normalize(rgt) : vec3(1.0, 0.0, 0.0);
    vec3 upv = cross(rgt, uSunPos);
    float yy = -dot(d, upv) / max(sunR, 1e-4); // 0 at the centre, 1 at the bottom
    float sy = yy * 5.0;
    float fws = max(fwidth(sy), 1e-4);
    float f = abs(fract(sy) - 0.5);
    float gapW = 0.15 + 0.45 * clamp(yy, 0.0, 1.0);
    float gap = (1.0 - smoothstep(gapW * 0.5 - fws, gapW * 0.5 + fws, f)) * step(0.0, yy);
    sun *= 1.0 - gap * step(0.5, uSunBands);
  }
  col = mix(col, uSunCol * 1.05, sun * (1.0 - uMoonVis));

  // moon, with soft mottling
  float moonR = 0.034 * uSunScale;
  float moon = discMask(d, uMoonPos, moonR);
  vec3 mr = cross(uMoonPos, vec3(0.0, 1.0, 0.0));
  vec2 mp = vec2(dot(d, normalize(mr)), dot(d, cross(normalize(mr), uMoonPos))) / moonR;
  float mott = 0.82 + 0.18 * fbm(mp * 2.2 + 4.0);
  col = mix(col, vec3(0.9, 0.96, 0.94) * mott, moon * uMoonVis);

  // below the horizon
  col = mix(col, uFogCol, 1.0 - smoothstep(-0.04, 0.0, h));
  gl_FragColor = vec4(col, 1.0);
}
`;
