// Style hooks shared by every lit material in the game, so props, people and the
// figure take the chosen look along with the ground. All are neutral at their
// default values (no bands, smooth normals), which is the game's 35 mm look.
//
// Call styleFacet() in uniform control flow (it takes screen-space derivatives),
// then pass the finished 0..1 light amount through styleBands().
export const STYLE_GLSL = /* glsl */ `
uniform float uBands;     // 0 = smooth light, N = cel shading with N steps
uniform float uBandNoise; // 0..1 brushy wobble on band edges
uniform float uFacet;     // 1 = flat faceted normals (Low Poly)

float stHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float stNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(stHash(i), stHash(i + vec2(1.0, 0.0)), u.x), mix(stHash(i + vec2(0.0, 1.0)), stHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// floor(x) with a one-pixel ramp at each step so band edges do not stair-step.
float stFloor(float x) {
  float w = clamp(fwidth(x), 1e-4, 1.0);
  return floor(x) + smoothstep(1.0 - w, 1.0, fract(x));
}

// Steps a 0..1 light amount into uBands levels; xz drives the brushy edge noise.
float styleBandX(float l, vec2 xz) {
  float wob = (stNoise(xz * 0.6) * 0.6 + stNoise(xz * 1.7 + 7.3) * 0.4 - 0.5) * uBandNoise;
  return l * max(uBands, 1.0) + 0.5 + wob;
}

// (uBands is a uniform, so the early return keeps control flow uniform for fwidth.)
float styleBands(float l, vec2 xz) {
  if (uBands < 0.5) return l;
  return clamp(stFloor(styleBandX(l, xz)) / uBands, 0.0, 1.0);
}

// The same, with a fixed edge ramp w (in band units) for shaders that may not take
// derivatives at this point (after a discard).
float styleBandsW(float l, vec2 xz, float w) {
  if (uBands < 0.5) return l;
  float x = styleBandX(l, xz);
  return clamp((floor(x) + smoothstep(1.0 - w, 1.0, fract(x))) / uBands, 0.0, 1.0);
}

// Low Poly: the flat normal of the triangle under this pixel, facing the same way as n.
vec3 styleFacet(vec3 n, vec3 w) {
  vec3 f = cross(dFdx(w), dFdy(w));
  if (uFacet < 0.5 || dot(f, f) < 1e-14) return n;
  f = normalize(f);
  return dot(f, n) < 0.0 ? -f : f;
}
`;

// Baked detail maps (render/art.ts detailTexture / detailTexture2): mid-grey on average, read as
// (texel - 0.5) and turned into an albedo multiplier before lighting, faded out with distance so
// nothing tiles or shimmers far off. Shaders declare their own sampler uniforms.
export const DETAIL_GLSL = /* glsl */ `
// World-space plane across the dominant axis of n: xz on floors, and on walls a plane whose
// second coordinate is height, so anything laid along the texture's x runs level.
vec2 detailPlane(vec3 w, vec3 n) {
  vec3 a = abs(n);
  return a.y >= a.x && a.y >= a.z ? w.xz : a.x >= a.z ? w.zy : w.xy;
}
// 1 up to near, 0 past far.
float detailFade(float d, float near, float far) { return 1.0 - smoothstep(near, far, d); }
// The albedo multiplier for a centred texel value t (texel - 0.5) at strength k, faded by f.
float detailMul(float t, float k, float f) { return 1.0 + t * k * f; }
`;
