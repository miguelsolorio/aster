// Shared contract between styles, shaders, the stage and the gallery.
// All colours are authored in sRGB hex and passed to shaders as plain vec3 in
// display space. No shader does colour-space conversion.

/** One palette for one time of day. */
export interface Pal {
  top: string; // sky zenith
  horizon: string; // sky at the horizon
  lit: string; // sand in direct light
  shade: string; // sand in shadow
  sun: string; // sun or moon disc and glow
  fog?: string; // distance haze, defaults to horizon
  line?: string; // contour / grid lines, defaults to style ink
  a?: string; // post-mode colour A (ink), defaults to style ink
  b?: string; // post-mode colour B (paper), defaults to style paperCol
}

/** Numeric knobs. Each key K maps to a float uniform named "u" + Capitalised(K). */
export interface Params {
  // sand
  bands: number; // 0 = smooth light, N = cel shading with N steps
  bandNoise: number; // 0..1 brushy wobble on band edges
  termSharp: number; // 0 = lambert, 1 = hard light/dark split at the terminator
  shadowK: number; // cast shadow hardness (higher = sharper)
  shadowAmt: number; // 0..1 cast shadow strength
  ripple: number; // small wind ripples (0.5 m wavelength)
  rippleBig: number; // large ripples (2.6 m wavelength)
  sparkle: number; // glints
  contour: number; // 0..1 height contour lines
  grid: number; // 0..1 world grid lines
  facet: number; // 1 = flat faceted normals (low-poly mesh is used)
  flat: number; // 1 = no ambient modulation or albedo noise
  fog: number; // exponential fog density per metre
  // sky
  sunScale: number; // multiplier on disc radius
  glow: number; // multiplier on sun glow
  skyBands: number; // 0 = smooth gradient, N = stepped
  sunBands: number; // 1 = striped lower half of disc
  mtn: number; // 0..1 distant mountain silhouettes
  skyCurve: number; // gradient exponent
  starAmt: number; // multiplier on stars
  // post
  mode: number; // 0 none, 1 two-ink halftone, 2 one-bit dither, 3 cross-hatch
  grain: number;
  vig: number;
  chroma: number;
  sat: number;
  contrast: number;
  poster: number; // 0 = off, N = colour levels per channel
  posterDither: number; // 0..1 ordered dither mixed into posterize
  pixelRows: number; // 0 = off, N = screen is N chunky pixels tall
  outline: number; // 0..1 depth-edge ink line
  outlineW: number; // line width in units of (screenHeight / 500) px
  paper: number; // 0..1 paper texture
  wobble: number; // 0..1 hand-drawn UV wobble
}

export const DEFAULTS: Params = {
  bands: 0,
  bandNoise: 0,
  termSharp: 0.5,
  shadowK: 8,
  shadowAmt: 1,
  ripple: 0.6,
  rippleBig: 0.3,
  sparkle: 0,
  contour: 0,
  grid: 0,
  facet: 0,
  flat: 0,
  fog: 0.0006,
  sunScale: 1,
  glow: 1,
  skyBands: 0,
  sunBands: 0,
  mtn: 1,
  skyCurve: 0.5,
  starAmt: 1,
  mode: 0,
  grain: 0.03,
  vig: 0.25,
  chroma: 0,
  sat: 1,
  contrast: 1,
  poster: 0,
  posterDither: 0,
  pixelRows: 0,
  outline: 0,
  outlineW: 1,
  paper: 0,
  wobble: 0,
};

export interface Style {
  id: string;
  name: string;
  blurb: string;
  pal: { day: Pal; sunset: Pal; night: Pal };
  fig?: string; // figure colour, default #1c1512
  ink?: string; // outline / line colour, default #1a1410
  paperCol?: string; // paper tint, default #f4ecdc
  p?: Partial<Params>;
}

/*
Uniform contract (every shader may declare any of these; all are shared):

  float uTime
  vec3  uSunDir        normalised, points from the ground toward the sun or moon
  vec3  uTop uHorizon uLit uShade uSunCol uFogCol uLine uFig uFigLit
  vec3  uInk uPaperCol uA uB
  float uSunSize       disc angular radius in radians (already scaled)
  float uGlow uStars   already scaled for time of day
  float u<Param>       one per key of Params, e.g. uBands, uTermSharp, uPixelRows
  vec3  uFigPos        world position of the figure's feet
  vec2  uWind          horizontal wind direction, normalised (x, z)

Sand only:
  sampler2D uHeightMap  R channel = terrain height in metres, linear filtered
  vec3      uRect       (originX, originZ, size): uv = (xz - origin) / size
  float     uTexel      metres per heightmap texel
  sampler2D uTrail      R channel = footprint depth 0..1
  vec3      uTrailRect  (originX, originZ, size), same mapping

Post only:
  sampler2D tColor, tDepth   (tDepth is the raw perspective depth buffer)
  vec2      uRes             render size in pixels
*/
