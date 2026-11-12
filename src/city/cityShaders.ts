import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import { CITY_SHADOW_GLSL } from './cityGlsl';

// Shaders for the cities: masonry (walls, roofs, domes, wood, cloth, plants), the pool,
// and the warm glows (lamps, lit windows, lanterns) that make a city read at night.
// Colours follow the shared contract: display-space, two-tone from the shared palette,
// gl_FragColor written directly, then the contract's exponential fog.

/** Material ids stored in aInfo.x. */
export const MAT = {
  plaster: 0,
  roof: 1,
  stone: 2,
  wood: 3,
  opening: 4,
  cloth: 5,
  plant: 6,
  lantern: 7,
  soil: 8,
  dome: 9,
} as const;

/** Glow kinds stored in aGlow.y. */
export const GLOW = { lamp: 0, window: 1, lantern: 2 } as const;

// ------------------------------------------------------------------ shared uniforms

/**
 * Names this module reads. If a holder is missing from the shared object when a material is
 * created (the integrator may add the city-shadow uniforms later), a forwarding holder is put
 * in its place that reads the shared object at draw time, so late additions still arrive.
 */
const FALLBACKS: Record<string, () => unknown> = {
  uTime: () => 0,
  uSunDir: () => new THREE.Vector3(0, 1, 0),
  uLit: () => new THREE.Color(0.85, 0.66, 0.4),
  uShade: () => new THREE.Color(0.42, 0.28, 0.18),
  uRockLit: () => new THREE.Color(0.7, 0.5, 0.36),
  uRockShade: () => new THREE.Color(0.32, 0.22, 0.17),
  uTop: () => new THREE.Color(0.3, 0.5, 0.5),
  uHorizon: () => new THREE.Color(0.6, 0.7, 0.62),
  uSunCol: () => new THREE.Color(1, 0.9, 0.7),
  uFogCol: () => new THREE.Color(0.7, 0.66, 0.55),
  uFog: () => 0.00012,
  uNight: () => 0,
  uWind: () => new THREE.Vector2(1, 0),
  uCityMap: () => null,
  uCityRect: () => new THREE.Vector4(0, 0, 0, 0),
  uCityGround: () => 0,
};

function forward(shared: Uniforms, name: string, fallback: unknown): THREE.IUniform {
  return {
    get value(): unknown {
      const h = shared[name];
      return h ? h.value : fallback;
    },
    set value(v: unknown) {
      const h = shared[name];
      if (h) h.value = v;
    },
  };
}

function withShared(shared: Uniforms, own: Uniforms): Uniforms {
  const u: Uniforms = { ...shared };
  for (const name of Object.keys(FALLBACKS)) {
    if (!(name in u)) u[name] = forward(shared, name, FALLBACKS[name]());
  }
  return Object.assign(u, own);
}

// ------------------------------------------------------------------ GLSL

const NOISE = /* glsl */ `
float ch21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float cvn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ch21(i), ch21(i + vec2(1.0, 0.0)), u.x),
             mix(ch21(i + vec2(0.0, 1.0)), ch21(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const masonryVert = /* glsl */ `
attribute vec4 aInfo; // x material id, y tint 0..255, z window seed 0..255 (0 = never lit), w stripes / sway
attribute vec2 aUv;
uniform float uTime;
uniform vec2 uWind;
varying vec3 vW;
varying vec3 vN;
varying float vH;
varying vec4 vInfo;
varying vec2 vUv;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
#ifdef SWAY
  float s = aInfo.w / 255.0;
  s *= s;
  float ph = wp.x * 0.31 + wp.z * 0.23;
  float g = 0.16 + 0.1 * sin(uTime * 1.1 + ph) + 0.05 * sin(uTime * 2.6 + ph * 1.7);
  wp.xz += uWind * s * g;
  wp.y += s * 0.08 * sin(uTime * 1.7 + ph * 1.3);
#endif
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vH = position.y; // local y is height above the plateau
  vInfo = aInfo;
  vUv = aUv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const masonryFrag = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uRockLit;
uniform vec3 uRockShade;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunCol;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uNight;
varying vec3 vW;
varying vec3 vN;
varying float vH;
varying vec4 vInfo;
varying vec2 vUv;
#ifdef CITY_SHADOW
${CITY_SHADOW_GLSL}
#endif
${NOISE}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 paler(vec3 c, float k) { return mix(c, vec3(lum(c)), k); }

vec3 plasterHue(float t) {
  vec3 cream = vec3(1.05, 1.0, 0.93);
  vec3 ochre = vec3(1.07, 0.95, 0.80);
  vec3 rose = vec3(1.05, 0.93, 0.88);
  vec3 lime = vec3(1.02, 1.01, 0.99);
  vec3 h = t < 0.45 ? cream : t < 0.68 ? ochre : t < 0.86 ? rose : lime;
  return h * (0.95 + 0.1 * fract(t * 5.7));
}

vec3 dye(float t) {
  float k = floor(t * 4.0);
  return k < 0.5 ? vec3(0.98, 0.72, 0.36)   // ochre
       : k < 1.5 ? vec3(0.46, 0.53, 0.72)   // faded indigo
       : k < 2.5 ? vec3(0.80, 0.42, 0.27)   // rust
       : vec3(0.97, 0.92, 0.82);            // cream
}

void main() {
  float mat = vInfo.x;
  float tint = vInfo.y / 255.0;
  float seed = vInfo.z / 255.0;
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 n = normalize(vN);
#ifdef TWO_SIDED
  if (!gl_FrontFacing) n = -n;
#endif
  float ndl = dot(n, uSunDir);
  float l = smoothstep(-0.12, 0.5, ndl); // soft wrap
#ifdef TWO_SIDED
  // sun through the cloth / leaves: the far side glows a little
  if (mat > 4.5 && mat < 6.5) l = max(l, (mat < 5.5 ? 0.5 : 0.3) * smoothstep(-0.05, 0.5, -ndl));
#endif
  float sun = 1.0;
#ifdef CITY_SHADOW
  sun = cityShadow(vW + n * 0.45, uSunDir);
  l *= sun;
#endif
  l += (1.0 - l) * uNight * 0.16; // walls stay readable under the moon

  float m = cvn(vW.xz * 0.06 + vW.y * 0.045) * 0.6 + cvn(vW.xz * 0.55 + vec2(vW.y * 0.7, -vW.y * 0.4)) * 0.4;

  vec3 sh;
  vec3 li;
  float masonry = 0.0;
  if (mat < 0.5) {            // plaster
    vec3 hue = plasterHue(tint);
    sh = mix(uShade, uLit, 0.2) * hue;
    li = paler(uLit, 0.14) * 1.07 * hue;
    masonry = 1.0;
  } else if (mat < 1.5) {     // roof surface: paler, a touch greyer, sun-bleached
    vec3 hue = plasterHue(tint);
    sh = mix(uShade, uLit, 0.26) * hue;
    li = paler(uLit, 0.22) * 1.09 * hue;
    masonry = 0.8;
  } else if (mat < 2.5) {     // dressed stone, nearer the rock palette
    float k = 0.3 + 0.2 * tint;
    sh = mix(uRockShade, uShade, k);
    li = mix(uRockLit, uLit, k) * 1.04;
    masonry = 1.0;
  } else if (mat < 3.5) {     // wood
    sh = uShade * vec3(0.55, 0.45, 0.38) * (0.85 + 0.3 * tint);
    li = uLit * vec3(0.52, 0.40, 0.31) * (0.85 + 0.3 * tint);
  } else if (mat < 4.5) {     // dark opening
    sh = uShade * 0.16 + uTop * 0.015;
    li = uShade * 0.24 + uTop * 0.02;
  } else if (mat < 5.5) {     // cloth
    vec3 d = dye(tint);
    if (vInfo.w > 0.5) {
      float st = step(0.5, fract(vUv.x * vInfo.w * 0.5));
      d = mix(d, tint < 0.75 ? vec3(0.96, 0.9, 0.8) : vec3(0.62, 0.36, 0.24), st * 0.8);
    }
    float lu = lum(uLit);
    sh = mix(d * uShade, d * lum(uShade), 0.5) * 1.15;
    li = mix(d * uLit, d * lu, 0.5) * 1.12;
  } else if (mat < 6.5) {     // plant
    float k = 0.8 + 0.4 * tint;
    sh = uShade * vec3(0.42, 0.52, 0.34) * k;
    li = uLit * vec3(0.46, 0.6, 0.3) * k;
  } else if (mat < 7.5) {     // lantern glass
    sh = uShade * 0.5;
    li = uLit * 0.7;
  } else if (mat < 8.5) {     // soil
    sh = uShade * 0.55;
    li = uLit * vec3(0.58, 0.52, 0.46);
  } else {                    // glazed dome: pale lime wash
    sh = paler(mix(uShade, uLit, 0.3), 0.3) * vec3(1.0, 1.0, 1.03);
    li = paler(uLit, 0.3) * 1.13;
    masonry = 0.6;
  }

  vec3 col = mix(sh, li, l);
  col *= 1.0 + (0.12 * m - 0.07) * masonry;

  float wall = 1.0 - abs(n.y);
  if (masonry > 0.0) {
    // dust and splash line at the foot of the walls
    float band = 1.0 - smoothstep(0.05, 0.55 + 0.5 * m, vH);
    col *= 1.0 - 0.17 * band * wall;
  }
  // sky bounce on upward faces, warm ground bounce low on the walls
  col += uTop * 0.06 * max(n.y, 0.0) * (1.0 - 0.6 * l);
  col += uLit * 0.08 * wall * exp(-max(vH, 0.0) * 0.3) * smoothstep(0.0, 0.3, uSunDir.y) * (1.0 - 0.5 * l);

  if (mat > 8.5) {
    vec3 rf = reflect(-V, n);
    col += uSunCol * pow(max(dot(rf, uSunDir), 0.0), 24.0) * 0.2 * sun * (1.0 - 0.7 * uNight);
    col = mix(col, uHorizon, pow(1.0 - max(dot(n, V), 0.0), 4.0) * 0.14);
  }

  // night lights in openings and lanterns
  float on = 0.0;
  if (mat > 3.5 && mat < 4.5 && seed > 0.002) {
    float th = 0.15 + 0.3 * fract(seed * 7.31);
    on = smoothstep(th, th + 0.1, uNight);
    float bright = 0.55 + 0.75 * fract(seed * 13.7);
    vec2 q = vUv - vec2(0.5, 0.45);
    float core = clamp(1.0 - dot(q, q) * 2.2, 0.35, 1.0);
    col = mix(col, vec3(1.0, 0.66, 0.33) * bright * core, on);
  } else if (mat > 6.5 && mat < 7.5) {
    on = smoothstep(0.08, 0.35, uNight);
    col = mix(col, vec3(1.0, 0.74, 0.42) * 1.25, on);
  }

  float fogA = 1.0 - exp(-dist * uFog);
  fogA *= 1.0 - 0.55 * on;
  col = mix(col, uFogCol, fogA);
  gl_FragColor = vec4(col, 1.0);
}
`;

const waterVert = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const waterFrag = /* glsl */ `
precision highp float;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uShade;
uniform vec3 uFogCol;
uniform float uFog;
uniform float uTime;
uniform float uNight;
varying vec3 vW;
${NOISE}
float rip(vec2 q) { return cvn(q + uTime * 0.05) + cvn(q * 2.3 - uTime * 0.07); }
void main() {
  vec3 v = normalize(cameraPosition - vW);
  vec2 q = vW.xz * 0.35;
  float e = 0.012;
  float r0 = rip(q);
  float rx = rip(q + vec2(e, 0.0));
  float rz = rip(q + vec2(0.0, e));
  vec3 n = normalize(vec3(-(rx - r0) / e * 0.015, 1.0, -(rz - r0) / e * 0.015));
  float c = clamp(dot(n, v), 0.0, 1.0);
  float fres = pow(1.0 - c, 3.0);
  vec3 col = mix(uTop, uHorizon, fres * 0.9 + 0.1);
  col = mix(col, uShade * 0.6, 0.2 * c);
  vec3 rf = reflect(-v, n);
  float g = pow(max(dot(rf, uSunDir), 0.0), 220.0);
  col += uSunCol * g * (1.0 - 0.6 * uNight) * 1.5;
  float dist = length(vW - cameraPosition);
  col = mix(col, uFogCol, 1.0 - exp(-dist * uFog));
  gl_FragColor = vec4(col, 1.0);
}
`;

const glowVert = /* glsl */ `
attribute vec2 aCorner;
attribute vec4 aGlow; // x radius (m), y kind (0 lamp, 1 window, 2 lantern), z seed 0..1, w brightness
uniform float uNight;
uniform float uFog;
uniform float uTime;
uniform float uViewH;
uniform float uMinPx;
varying vec2 vUv;
varying vec3 vCol;
varying float vSoft;
void main() {
  vec4 wc = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wc;
  float dist = length(wc.xyz - cameraPosition);
  float kind = aGlow.y;
  // windows use the same seeded threshold as the openings in the masonry shader
  float th = kind > 0.5 && kind < 1.5 ? 0.15 + 0.3 * fract(aGlow.z * 7.31) : 0.1 + 0.12 * aGlow.z;
  float on = smoothstep(th, th + 0.1, uNight);
#ifdef NEAR_GLOW
  // close up the window geometry itself glows; the points take over with distance
  if (kind > 0.5 && kind < 1.5) on *= smoothstep(160.0, 480.0, dist);
#endif
  float depth = max(-mv.z, 0.1);
  float px = 2.0 * depth / (projectionMatrix[1][1] * uViewH); // metres per pixel here
  float r = max(aGlow.x, uMinPx * px);
  float k = aGlow.x / r;
  vSoft = k;
  float fogA = (1.0 - exp(-dist * uFog)) * 0.5;
  float flick = kind < 0.5 ? 0.93 + 0.07 * sin(uTime * 3.0 + aGlow.z * 40.0) * sin(uTime * 4.3 + aGlow.z * 17.0) : 1.0;
  vec3 warm = mix(vec3(1.0, 0.68, 0.36), vec3(1.0, 0.8, 0.52), fract(aGlow.z * 3.7));
  vCol = warm * aGlow.w * on * max(k * k, 0.35) * (1.0 - fogA) * flick;
  mv.xy += aCorner * r;
  vUv = aCorner;
  gl_Position = on < 0.002 ? vec4(0.0, 0.0, 2.0, 1.0) : projectionMatrix * mv;
}
`;

const glowFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vCol;
varying float vSoft;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  // a soft halo when the glow is large on screen, a solid little point when it is clamped
  float a = mix(1.0 - r2 * r2, exp(-r2 * 4.5) * (1.0 - r2), vSoft);
  gl_FragColor = vec4(vCol * a, 1.0);
}
`;

// ------------------------------------------------------------------ materials

export interface MasonryOptions {
  /** Multiply direct light by cityShadow (near city only). */
  shadow: boolean;
  /** Double-sided with flipped normals on the back (cloth, plants). */
  twoSided: boolean;
  /** Plants: sway with the wind by aInfo.w. */
  sway: boolean;
}

export function createMasonryMaterial(shared: Uniforms, o: MasonryOptions): THREE.ShaderMaterial {
  const defines: Record<string, number> = {};
  if (o.shadow) defines.CITY_SHADOW = 1;
  if (o.twoSided) defines.TWO_SIDED = 1;
  if (o.sway) defines.SWAY = 1;
  return new THREE.ShaderMaterial({
    uniforms: withShared(shared, {}),
    vertexShader: masonryVert,
    fragmentShader: masonryFrag,
    defines,
    side: o.twoSided ? THREE.DoubleSide : THREE.FrontSide,
  });
}

export function createWaterMaterial(shared: Uniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: withShared(shared, {}),
    vertexShader: waterVert,
    fragmentShader: waterFrag,
  });
}

export function createGlowMaterial(shared: Uniforms, near: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: withShared(shared, { uViewH: { value: 1080 }, uMinPx: { value: 1.5 } }),
    vertexShader: glowVert,
    fragmentShader: glowFrag,
    defines: near ? { NEAR_GLOW: 1 } : {},
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const _size = new THREE.Vector2();

/** Keeps uViewH (pixels of the target being drawn) current so glows never shrink below uMinPx. */
export function trackViewport(mesh: THREE.Mesh, mat: THREE.ShaderMaterial): void {
  mesh.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    let h: number;
    let minPx = 1.5;
    if (rt) h = rt.height;
    else {
      h = renderer.getDrawingBufferSize(_size).y;
      minPx = 1.5 * Math.max(1, renderer.getPixelRatio() * 0.7);
    }
    mat.uniforms.uViewH.value = Math.max(1, h);
    mat.uniforms.uMinPx.value = minPx;
  };
}
