// What the deep is drawn with. One material for all the rock and everything standing on it:
// nearly black where no light was baked, warm where a lamp reaches, the day's own rock colour
// under a sky shaft. No sun, no fog. Colours are display-space, written straight out, and the
// light goes through the shared style hooks so a ?style= look still holds underground.

import * as THREE from 'three';
import type { Uniforms } from '../../game/contract';
import { DETAIL_GLSL, STYLE_GLSL } from '../../render/styleGlsl';
import { detailTexture2 } from '../../render/art';

const NOISE = /* glsl */ `
float dh21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float dvn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dh21(i), dh21(i + vec2(1.0, 0.0)), u.x),
             mix(dh21(i + vec2(0.0, 1.0)), dh21(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const deepVert = /* glsl */ `
attribute vec4 aLight;
attribute vec4 aTint;
varying vec3 vL;
varying vec3 vV;
varying vec4 vLight;
varying vec3 vTint;
varying float vKind;
void main() {
  vL = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = mv.xyz;
  vLight = aLight;
  vTint = aTint.rgb;
  vKind = floor(aTint.a * 255.0 + 0.5);
  gl_Position = projectionMatrix * mv;
}
`;

// kinds, as the surface's stone has them: 0 rock, 1 pale (salt palette), 2 sand palette (wood,
// cloth), 3 flame, 4 glowing mineral; 5, the patch of sky a shaft falls from; and 6, the marks
// on the waking stone, dark until it is touched.
const deepFrag = /* glsl */ `
uniform vec3 uRockLit;
uniform vec3 uRockShade;
uniform vec3 uSaltLit;
uniform vec3 uSaltShade;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uTop;
uniform vec3 uSunCol;
uniform float uDeepTime;
uniform float uDeepSky;
uniform float uDeepWake;
uniform vec3 uDeepStone;
uniform sampler2D uDetailMap2; // baked grain (render/art.ts): G rock strata
varying vec3 vL;
varying vec3 vV;
varying vec4 vLight;
varying vec3 vTint;
varying float vKind;
${NOISE}
${STYLE_GLSL}
${DETAIL_GLSL}
void main() {
  // the face's normal in the mesh's own frame, for the grain's projection (vL.y is height)
  vec3 nl = cross(dFdx(vL), dFdy(vL));
  // flat shading: the triangle's own normal, which in view space always faces the eye
  vec3 nv = cross(dFdx(vV), dFdy(vV));
  nv = normalize(nv + vec3(0.0, 0.0, 1e-12));
  vec3 n = nv * mat3(viewMatrix);
  float facet = 0.8 + 0.2 * dot(n, vec3(0.37, 0.82, 0.43));

  vec3 sh = uShade;
  vec3 li = uLit;
  float tone = 1.0;
  if (vKind < 0.5) {
    // strata: bands of colour by height, a few of them the sand's colour rather than the rock's
    float sy = vL.y * 0.21 + dvn(vL.xz * 0.035) * 1.3;
    float b1 = dh21(vec2(floor(sy), 3.0));
    float b2 = dh21(vec2(floor(sy * 3.3 + 0.5), 11.0));
    float sel = step(0.62, b1) * 0.7;
    tone = 0.72 + 0.3 * b1 + 0.14 * b2;
    sh = mix(uRockShade, uShade * 0.85, sel);
    li = mix(uRockLit, uLit * 0.85, sel);
    // bedding, joints and pits close by, one tile per 3 m, level on the walls
    float gf = detailFade(length(vV), 20.0, 60.0);
    if (gf > 0.0) tone *= detailMul(texture2D(uDetailMap2, detailPlane(vL, nl) / 3.0).g - 0.5, 0.22, gf);
  } else if (vKind < 1.5) {
    sh = mix(uRockShade, uSaltShade, 0.7);
    li = uSaltLit;
  }
  float m = dvn(vL.xz * 0.45 + vec2(vL.y * 0.6, -vL.y * 0.3)) * 0.6 + dvn(vL.xz * 1.7 + vL.y) * 0.4;
  vec3 tint = vTint * tone * (0.88 + 0.24 * m);

  // unlit: nearly black, never quite
  vec3 base = sh * tint * 0.3;

  // lamplight: the lamp's own colour on the stone's hue
  vec3 lamp = vLight.rgb * vLight.rgb * 2.0;
  float lum = max(lamp.r, max(lamp.g, lamp.b));
  lamp *= styleBands(clamp(lum, 0.0, 1.0), vL.xz) / max(lum, 1e-4);
  float lm = max(li.r, max(li.g, li.b));
  vec3 alb = mix(li / max(lm, 0.04), vec3(1.0), 0.45);
  vec3 col = base + alb * tint * lamp * (facet * 0.85);
  // eyes used to the dark: what is near is always faintly seen, so an unlit tunnel can be walked
  float near = 1.0 - smoothstep(5.0, 24.0, length(vV));
  col += alb * tint * (facet * 0.2 * near * near);

  // the waking stone: light spreads out from it and stays
  float wake = uDeepWake;
  float front = max(0.0, wake - 2.0) * 22.0;
  float dS = length(vL - uDeepStone);
  float inside = wake < 0.0 ? 0.0 : 1.0 - smoothstep(front - 1.0, front + 1.0, dS);
  if (inside > 0.0) {
    col += alb * tint * facet * 0.16 * inside;
    float band = (1.0 - smoothstep(0.0, 6.0, abs(dS - front))) * step(0.001, front) * step(dS, front + 3.0);
    col += vec3(0.3, 0.95, 0.82) * tint * 0.25 * band;
  }

  // daylight from a shaft: the rock as the sun would show it at this hour
  float sky = styleBands(clamp(vLight.a * vLight.a * 2.0 * uDeepSky, 0.0, 1.0), vL.xz);
  col = mix(col, max(col, li * tint * facet), sky);

  if (vKind > 5.5) {
    // each mark takes the light in its turn over the first two and a half seconds
    float at = dh21(floor(vL.xz * 3.0) + floor(vL.y * 3.0) * 7.0) * 2.0;
    float lit = wake < 0.0 ? 0.0 : smoothstep(at, at + 0.5, wake);
    vec3 live = vec3(0.3, 0.95, 0.82) * vTint * (0.8 + 0.2 * sin(uDeepTime * 0.9 + vL.y * 2.0));
    col = mix(vTint * 0.05, live, lit);
  } else if (vKind > 4.5) {
    col = mix(uTop, uSunCol, 0.55) * (0.03 + 1.07 * uDeepSky);
  } else if (vKind > 3.5) {
    float k4 = wake < 0.0 ? 0.25 : mix(0.25, 1.0, inside);
    col = vec3(0.3, 0.95, 0.82) * vTint * (0.8 + 0.2 * sin(uDeepTime * 0.9 + vL.y * 2.0)) * k4;
  } else if (vKind > 2.5) {
    float ph = dot(floor(vL * 0.7), vec3(1.3, 2.1, 3.7));
    float fl = 0.92 + 0.12 * sin(uDeepTime * 9.0 + ph) * sin(uDeepTime * 5.3 + ph * 1.7);
    col = vec3(1.0, 0.78, 0.46) * vTint * (1.15 * fl);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

// Flames and other small lights: soft discs that face the eye, added over the dark.
const glowVert = /* glsl */ `
uniform float uDeepTime;
attribute vec2 aCorner;
attribute float aSize;
attribute vec3 aCol;
attribute float aPhase;
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // a phase below zero is a steady light
  float fl = 1.0;
  if (aPhase >= 0.0) {
    fl = 0.9 + 0.1 * sin(uDeepTime * 9.0 + aPhase) * sin(uDeepTime * 5.3 + aPhase * 1.7) + 0.04 * sin(uDeepTime * 23.0 + aPhase * 3.1);
  }
  // grow a little with distance so a far lamp still reads as a point of light
  float s = aSize * (1.0 + length(mv.xyz) / 300.0) * (0.9 + 0.1 * fl);
  mv.xy += aCorner * s;
  vUv = aCorner;
  vCol = aCol * fl;
  gl_Position = projectionMatrix * mv;
}
`;

const glowFrag = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 5.0) * (1.0 - r2);
  gl_FragColor = vec4(vCol * a, 1.0);
}
`;

// Lit dust in a sky shaft.
const beamVert = /* glsl */ `
attribute float aFade;
varying float vFade;
varying vec3 vL;
void main() {
  vL = position;
  vFade = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const beamFrag = /* glsl */ `
uniform vec3 uSunCol;
uniform float uDeepTime;
uniform float uDeepSky;
varying float vFade;
varying vec3 vL;
${NOISE}
void main() {
  float dust = 0.7 + 0.3 * dvn(vL.xz * 0.5 + vec2(uDeepTime * 0.04, vL.y * 0.25));
  gl_FragColor = vec4(uSunCol * (0.07 * vFade * vFade * dust * uDeepSky), 1.0);
}
`;

// Still water underground: dark, with a sheen that takes the colour of whatever light was baked over it.
const waterVert = /* glsl */ `
attribute vec4 aLight;
varying vec3 vL;
varying vec3 vV;
varying vec4 vLight;
void main() {
  vL = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = mv.xyz;
  vLight = aLight;
  gl_Position = projectionMatrix * mv;
}
`;

const waterFrag = /* glsl */ `
uniform vec3 uRockShade;
uniform vec3 uTop;
uniform vec3 uSunCol;
uniform float uDeepTime;
uniform float uDeepSky;
varying vec3 vL;
varying vec3 vV;
varying vec4 vLight;
${NOISE}
void main() {
  vec2 q = vL.xz * 0.35;
  float e = 0.012;
  float r0 = dvn(q + uDeepTime * 0.05) + dvn(q * 2.3 - uDeepTime * 0.07);
  float rx = dvn(q + vec2(e, 0.0) + uDeepTime * 0.05) + dvn((q + vec2(e, 0.0)) * 2.3 - uDeepTime * 0.07);
  float rz = dvn(q + vec2(0.0, e) + uDeepTime * 0.05) + dvn((q + vec2(0.0, e)) * 2.3 - uDeepTime * 0.07);
  vec3 n = normalize(vec3(-(rx - r0) * 1.25, 1.0, -(rz - r0) * 1.25));
  vec3 up = mat3(viewMatrix) * n;
  float c = clamp(dot(up, normalize(-vV)), 0.0, 1.0);
  float fres = pow(1.0 - c, 3.0);
  vec3 lamp = vLight.rgb * vLight.rgb * 2.0;
  float sky = clamp(vLight.a * vLight.a * 2.0 * uDeepSky, 0.0, 1.0);
  vec3 col = uRockShade * 0.1;
  col += lamp * vec3(1.0, 0.9, 0.75) * (0.08 + 0.5 * fres);
  col += mix(uTop, uSunCol, 0.4) * sky * (0.12 + 0.6 * fres);
  // under daylight the water itself shows: green, and most where it is looked down into
  col += vec3(0.06, 0.34, 0.2) * sky * sky * (1.0 - 0.6 * fres);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** The shared holders, plus defaults for anything the deep needs that was not handed in. */
function withDefaults(shared: Uniforms | undefined, own: Uniforms): Uniforms {
  const v3 = (x: number, y: number, z: number) => ({ value: new THREE.Vector3(x, y, z) });
  const d: Uniforms = {
    uRockLit: v3(0.62, 0.44, 0.3),
    uRockShade: v3(0.25, 0.16, 0.13),
    uSaltLit: v3(0.92, 0.86, 0.78),
    uSaltShade: v3(0.42, 0.34, 0.32),
    uLit: v3(0.86, 0.62, 0.36),
    uShade: v3(0.42, 0.27, 0.22),
    uTop: v3(0.16, 0.42, 0.5),
    uSunCol: v3(1.0, 0.9, 0.7),
    uBands: { value: 0 },
    uBandNoise: { value: 0 },
    uFacet: { value: 0 },
  };
  return { ...d, ...(shared ?? {}), ...own };
}

export interface DeepMaterials {
  rock: THREE.ShaderMaterial;
  glow: THREE.ShaderMaterial;
  beam: THREE.ShaderMaterial;
  water: THREE.ShaderMaterial;
  /** Seconds, for flames. */
  time: THREE.IUniform<number>;
  /** 0..1: how much daylight the shafts carry. */
  sky: THREE.IUniform<number>;
  /** Seconds since the stone woke, -1 asleep. */
  wake: THREE.IUniform<number>;
  /** The stone, in the mesh's local frame. */
  stone: THREE.IUniform<THREE.Vector3>;
  dispose(): void;
}

export function deepMaterials(shared?: Uniforms): DeepMaterials {
  const time = { value: 0 };
  const sky = { value: 1 };
  const wake = { value: -1 };
  const stone = { value: new THREE.Vector3(0, -1e4, 0) };
  const own: Uniforms = { uDeepTime: time, uDeepSky: sky, uDeepWake: wake, uDeepStone: stone };
  const u = withDefaults(shared, own);
  u.uDetailMap2 = { value: detailTexture2() };
  // seen only from inside, so either face will do; this spares every builder the winding
  const rock = new THREE.ShaderMaterial({ uniforms: u, vertexShader: deepVert, fragmentShader: deepFrag, side: THREE.DoubleSide });
  const add = { blending: THREE.AdditiveBlending, depthWrite: false, transparent: true } as const;
  const glow = new THREE.ShaderMaterial({ uniforms: own, vertexShader: glowVert, fragmentShader: glowFrag, ...add });
  const beam = new THREE.ShaderMaterial({ uniforms: u, vertexShader: beamVert, fragmentShader: beamFrag, side: THREE.DoubleSide, ...add });
  const water = new THREE.ShaderMaterial({ uniforms: u, vertexShader: waterVert, fragmentShader: waterFrag });
  return {
    rock,
    glow,
    beam,
    water,
    time,
    sky,
    wake,
    stone,
    dispose() {
      rock.dispose();
      glow.dispose();
      beam.dispose();
      water.dispose();
    },
  };
}
