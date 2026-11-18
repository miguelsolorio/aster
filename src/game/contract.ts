// Shared contract for the game. Every system codes against these types.
// Units are metres and seconds. +y is up. The world is endless and seeded.
import type * as THREE from 'three';

/** What the ground is at a point. */
export interface SurfaceSample {
  h: number; // height in metres
  rock: number; // 0 = sand, 1 = bare rock (mountains, mesas)
  salt: number; // 0..1 cracked salt pan
  green?: number; // 0..1 damp, growing ground beside a river
}

/** CPU view of the terrain. Must match the GLSL `surface()` function to within a few millimetres. */
export interface World {
  readonly seed: number;
  height(x: number, z: number): number;
  sample(x: number, z: number, out: SurfaceSample): SurfaceSample;
  /** Unit surface normal from central differences (1 m baseline). */
  normal(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
}

export type Uniforms = Record<string, THREE.IUniform>;

/*
Shared uniforms. ONE object of { value } holders is created by the game and
handed to every system; put these straight into ShaderMaterial.uniforms (spread
the shared object, then add your own). Never replace a holder, only read it.
Colours are display-space vec3 (no colour-space conversion anywhere; write
gl_FragColor directly, do not include three's colorspace chunks).

  float uTime        seconds
  float uSeed        world seed (integer value in a float)
  vec3  uSunDir      unit vector from the ground toward the current light (sun by day, moon at night)
  vec3  uLit         sand colour in direct light        vec3 uShade      sand colour in shadow
  vec3  uRockLit     rock in light                      vec3 uRockShade  rock in shadow
  vec3  uSaltLit     salt pan in light                  vec3 uSaltShade  salt pan in shadow
  vec3  uTop         sky zenith                         vec3 uHorizon    sky at horizon
  vec3  uSunCol      colour of the light / disc         vec3 uFogCol     distance haze colour
  float uFog         exponential fog density per metre: col = mix(col, uFogCol, 1.0 - exp(-dist * uFog))
  float uNight       0 in daylight .. 1 at full night
  vec2  uWind        unit horizontal wind direction (x, z)
  vec3  uFigPos      world position of the player's feet
  vec3  uFig, uFigLit  figure cloth colours (shadow, lit)

Set by HeightBake (terrain system):
  sampler2D uHeightMap   R = height (m), G = rock, B = salt. Float texture, linear filtered.
  vec3      uRect        (originX, originZ, size): uv = (xz - origin) / size
  float     uTexel       metres per texel

Set by TrailField (sand reaction system):
  sampler2D uTrailNear   R = depth of disturbance 0..1, about 5 cm per texel
  vec3      uTrailNearRect  (originX, originZ, size)
  sampler2D uTrailFar    same, about 40 cm per texel
  vec3      uTrailFarRect

Look: the chosen style is "35 mm": teal-to-green sky, gold sand, brown shadows,
soft film look. Props and effects should use the shared colours above so they sit
in the same light at every hour: typically mix(shadeColour, litColour, light) then fog.
*/

export interface PlayerState {
  pos: THREE.Vector3; // feet
  vel: THREE.Vector3;
  speed: number; // horizontal speed, m/s
  grounded: boolean;
  sliding: boolean;
  running: boolean;
  onRock: number; // 0..1
}

/**
 * How the back of a ridden animal moves under its rider this frame: where the saddle is from the
 * point straight above the animal's feet (world metres), how far the body has rolled to its right
 * (radians), and where in its bob it is (-1..1), scaled by how hard it is going.
 */
export interface SaddleSway {
  x: number;
  y: number;
  z: number;
  roll: number;
  rock: number;
}

/** Passed to every system once per frame. Treat as read-only. */
export interface FrameState {
  dt: number; // seconds, clamped to 0.05
  time: number; // seconds since start
  day: number; // 0..1 fraction of the day: 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset
  night: number; // 0 day .. 1 full night
  sunDir: THREE.Vector3; // true sun direction (may be below the horizon)
  lightDir: THREE.Vector3; // same as uSunDir
  wind: THREE.Vector2; // unit direction (x, z)
  gust: number; // 0..1 slow-varying wind strength
  camera: THREE.PerspectiveCamera;
  player: PlayerState;
}
