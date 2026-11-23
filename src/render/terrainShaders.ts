// Terrain shaders for the game: the clipmap surface (sand, rock, salt) in the
// chosen look, and the full-screen pass that bakes surface() into a heightmap.
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
import { MAX_TERRAIN_H, SURFACE_GLSL, TERRAIN } from '../world/surface';
import { DEEP_HOLE } from '../world/deep/types';
import { CITY_SHADOW_GLSL, CITY_SITES_GLSL } from '../city/cityGlsl';
import { ROUTE_GLSL } from '../city/routes';
import { FOOT_GLSL } from '../city/footpaths';
import { DETAIL_GLSL, STYLE_GLSL } from './styleGlsl';
import { WET_MAX } from './storm';

// The look's settings (see render/types.ts Params; the game's 35 mm look sets them
// to what used to be baked in here).
const LOOK = /* glsl */ `
uniform float uTermSharp; // 0 = lambert, 1 = hard light/dark split at the terminator
uniform float uShadowK;   // cast shadow hardness
uniform float uShadowAmt; // 0..1 cast shadow strength
uniform float uRipple;    // small wind ripples
uniform float uRippleBig; // large ripples
uniform float uSparkle;   // glints
uniform float uFlat;      // 1 = no ambient modulation or albedo noise
uniform float uContour;   // 0..1 height contour lines
uniform float uGrid;      // 0..1 world grid lines
uniform vec3 uLine;       // contour and grid line colour
${STYLE_GLSL}
const float TRAIL_NORMAL = 0.14; // depth 1.0 is roughly a 14 cm hollow
const float MAX_TERRAIN_H = ${MAX_TERRAIN_H}.0;
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

// Snow and high haze, shared by the terrain and the far massifs so the two agree where they meet.
const HIGH = /* glsl */ `
const float SNOW_LINE = ${TERRAIN.snowLine}.0;

// Haze lies low: it thins with height, so the high peaks stand clear of it.
float hazeAt(float y) {
  return mix(1.0, 0.3, smoothstep(250.0, 800.0, y));
}

// The frostland: (x, z) of its mountain, the radius inside which the ground is under snow, and
// the radius beyond which there is none (w = 0 turns it off). Between them the snow thins out.
uniform vec4 uFrost;

// 0 when the point is nowhere near the frostland, so the snow work can be skipped.
bool inFrost(vec3 p) {
  vec2 d = p.xz - uFrost.xy;
  return uFrost.w > 0.0 && dot(d, d) < uFrost.w * uFrost.w;
}

// Snow lying on open ground in the frostland, 0..1. Deep inside it is everywhere the ground is
// not steep. Toward the edge it thins: it breaks into drifts that settle in the dune troughs and
// on level ground, while the steeper faces and crests stay bare sand, then dwindles to dust.
float frostSnowAt(vec3 p, float ny) {
  float t = 1.0 - smoothstep(uFrost.z, uFrost.w, length(p.xz - uFrost.xy)); // 1 inside, 0 at the edge
  if (t <= 0.0) return 0.0;
  float n = 0.15 + 0.7 * fbm(p.xz * 0.0045 + vec2(3.1, 8.7)) + 0.15 * (vnoise(p.xz * 0.09) - 0.5);
  float th = 1.0 - t; // the noise must beat this for snow to settle
  float drift = 1.0 - smoothstep(n - 0.14, n + 0.14, th);
  float hold = mix(0.9, 0.45, t);
  return drift * smoothstep(hold - 0.07, hold + 0.07, ny);
}

// Snow cover 0..1: above a wandering snow line, on ground gentle enough to hold it, and over the
// ground of the frostland. The higher the snow line, the steeper the slope snow clings to.
float snowAt(vec3 p, float ny) {
  float s = 0.0;
  if (p.y > SNOW_LINE - 50.0) {
    float sh = p.y + 70.0 * (fbm(p.xz * 0.006 + vec2(9.2, -4.4)) - 0.5) + 14.0 * (vnoise(p.xz * 0.07) - 0.5);
    s = smoothstep(SNOW_LINE, SNOW_LINE + 70.0, sh);
    float hold = mix(0.8, 0.52, smoothstep(SNOW_LINE, SNOW_LINE + 260.0, p.y));
    s *= smoothstep(hold - 0.05, hold + 0.05, ny);
  }
  if (inFrost(p)) s = max(s, frostSnowAt(p, ny));
  return s;
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
uniform vec2 uInnerCenter; // centre of the next finer level
uniform float uInnerHalf;  // its half-size minus the overlap margin; < 0 = none
uniform vec3 uRect;        // the heightmap bake: xz corner, size (0 = none)

varying vec3 vW;
varying vec3 vN;
varying vec4 vMask; // rock, salt, signed distance to the river (m), river presence 0..1
varying float vCave; // 1 under a cave roof, rising to 2 deep in a cavern where no daylight reaches; below 0, a laid road (how trodden)

void main() {
  // A cell of the frame round a ring's hole (y = 1 + its corner, x + 2 z; see world/clipmap.ts):
  // where the finer level covers it this frame, all four corners go to one point outside the
  // view, so it draws nothing.
  if (position.y > 0.5) {
    float k = position.y - 1.0;
    vec2 corner = vec2(mod(k, 2.0), floor(k * 0.5));
    vec2 dd = abs(uLevelCenter + (position.xz - corner + 0.5) * uCell - uInnerCenter);
    if (max(dd.x, dd.y) < uInnerHalf) {
      vW = vec3(0.0);
      vN = vec3(0.0, 1.0, 0.0);
      vMask = vec4(0.0);
      vCave = 0.0;
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
  }
  vec2 xz = uLevelCenter + position.xz * uCell;
  vec4 s = surface(xz);
  vec2 river = vec2(sfRiverD, sfRiverS); // read now: the next calls overwrite them
  vCave = sfCave;
  // Past 400 m, inside the heightmap bake, terrainFrag lights the ground from the heightmap
  // alone and never reads vN. Where every triangle round this vertex lies there (a margin of
  // 1.5 cells covers a cell's diagonal), the two extra surface() calls are skipped.
  float m = 1.5 * uCell;
  vec2 hc = abs(xz - (uRect.xy + 0.5 * uRect.z));
  if (uRect.z >= 1.0 && max(hc.x, hc.y) < 0.4975 * uRect.z - m && length(xz - cameraPosition.xz) > 400.0 + m) {
    vN = vec3(0.0, 1.0, 0.0);
  } else {
    float hx = surfaceH(xz + vec2(uCell, 0.0));
    float hz = surfaceH(xz + vec2(0.0, uCell));
    vN = normalize(vec3(s.x - hx, uCell, s.x - hz));
  }
  vMask = vec4(s.yz, river);
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
uniform vec3 uSnowLit;
uniform vec3 uSnowShade;
uniform vec3 uSunCol;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uFogCol;

${CITY_SITES_GLSL}
${CITY_SHADOW_GLSL}

// The nearest caverns (see sfCaverns in surface.ts), for the mark a sealed one leaves on the
// sand, and the hole in an open one's floor.
uniform vec4 uCavA[4];
uniform vec4 uCavB[4];
uniform vec4 uCavC[4];
uniform vec4 uCavD[4];

// What glows in the nearest open cavern: where it is, and how far its light carries (0 = nothing).
uniform vec4 uCavGlow;
uniform vec3 uCavGlowCol;

uniform sampler2D uDetailMap;  // baked grain (render/art.ts): G limewash, read for snow
uniform sampler2D uDetailMap2; // baked grain: R sand, G rock strata, B wood

varying vec3 vW;
varying vec3 vN;
varying vec4 vMask;
varying float vCave;

${LOOK}
${DETAIL_GLSL}
${COMMON}
${HIGH}
${ROUTE_GLSL}
${FOOT_GLSL}

// Explicit LOD everywhere: these run inside loops and branches.
// The heightmap holds raw metres in both the 32-bit and the 16-bit float bake.
float H(vec2 xz) {
  return textureLod(uHeightMap, (xz - uRect.xy) / uRect.z, 0.0).r;
}

// Low Poly: one flat face per triangle of a fixed world grid, lit from the heightmap at
// its corners, so the faces stay put while the clipmap rings move with the player.
const float FACET = 28.0;
vec3 facetNormal(vec2 xz) {
  vec2 c = floor(xz / FACET);
  vec2 f = xz / FACET - c;
  vec2 a = c * FACET;
  float h00 = H(a);
  float h11 = H(a + FACET);
  vec3 n;
  if (f.x > f.y) {
    float h10 = H(a + vec2(FACET, 0.0));
    n = vec3(h00 - h10, FACET, h10 - h11);
  } else {
    float h01 = H(a + vec2(0.0, FACET));
    n = vec3(h01 - h11, FACET, h00 - h01);
  }
  return normalize(n);
}

// What rain has left: the stretches of ground it passed over (see render/storm.ts). Each is the
// strip its cloud swept: from where it was born, along its heading, as far as it has got.
uniform vec4 uWetA[${WET_MAX}]; // born at x, z; heading x, z
uniform vec4 uWetB[${WET_MAX}]; // metres travelled, half width, half depth, how wet still (0..1)
uniform float uWetBloom[${WET_MAX}]; // how much of its flowering is left
uniform float uFlood; // 0..1 the salt pans stand in water (the night of the new moon)
uniform float uStars;
uniform float uRainK; // raining on the eye now

// x: how wet the ground is here. y: how much of it is in flower.
vec2 rainedOn(vec2 xz) {
  vec2 r = vec2(0.0);
  for (int i = 0; i < ${WET_MAX}; i++) {
    vec4 B = uWetB[i];
    if (B.w <= 0.001) continue;
    vec4 A = uWetA[i];
    vec2 d = xz - A.xy;
    float a = dot(d, A.zw);
    float c = abs(dot(d, vec2(-A.w, A.z)));
    float k = smoothstep(-B.z, -B.z + 500.0, a) * (1.0 - smoothstep(B.x + B.z - 400.0, B.x + B.z, a)) * (1.0 - smoothstep(B.y - 700.0, B.y, c));
    // the flowers are a few hours behind the rain: nothing where its front has only just been
    // (a rain crosses the ground at about seven metres a second; an hour of the day is fifty)
    float since = (B.x + B.z - a) / 7.0;
    r = max(r, k * vec2(B.w, uWetBloom[i] * smoothstep(140.0, 380.0, since)));
  }
  if (r.x <= 0.0) return r;
  // rain does not fall evenly, and its edge is no line on the ground
  return clamp(r * 1.35 - 0.35 * vnoise(xz * 0.0031 + 4.7), 0.0, 1.0);
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
  // thin legs below the hem, then the robe narrowing to the head and hood
  float r = mix(0.06, mix(0.3, 0.13, clamp((y - 0.4) / 1.25, 0.0, 1.0)), smoothstep(0.3, 0.46, y));
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
  float pave = cityPave(p.xz);
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
  vec2 fwXZv = fwidth(p.xz);
  float fwXZ = max(fwXZv.x, fwXZv.y); // pixel footprint on the ground, metres
  vec2 sc = p.xz / 0.03;
  vec2 fwScV = fwidth(sc);
  float fwSc = max(max(fwScV.x, fwScV.y), 1e-4);
  vec3 dpX = dFdx(p);
  vec3 dpY = dFdy(p);
  vec3 meshFace = cross(dpX, dpY); // Low Poly off the heightmap: the mesh's own triangles

  // ---- the hole in the floor of an open cavern: the way down to the deep. The floor is level
  // round it, so the ground is simply not drawn inside the rectangle. (Only the floor: the sand
  // roof over it is drawn with this shader too, and stays whole.)
  for (int i = 0; i < 4; i++) {
    if (uCavC[i].w <= 0.0 || uCavB[i].z < 1.0 || uCavD[i].y <= 0.0) continue;
    vec2 hd = p.xz - uCavA[i].xy;
    if (abs(dot(hd, uCavA[i].zw) - uCavD[i].y) < ${DEEP_HOLE.halfU.toFixed(2)} && abs(dot(hd, vec2(-uCavA[i].w, uCavA[i].z))) < ${DEEP_HOLE.halfV.toFixed(2)} && p.y < uCavB[i].y + 0.5) discard;
  }

  // ---- the worn paths between cities (and the camps along them), and the fainter footpaths out
  // to the finds, on sand and salt alike
  float track = 0.0;
  if (sandW + salt > 0.01) track = max(routePaths(p.xz, fwXZ, dist), footPaths(p.xz, fwXZ, dist)) * (sandW + 0.75 * salt);
  // a strip of road laid over the ground (the frostland's): it says how trodden it is in vCave, below zero
  float paved = clamp(-vCave, 0.0, 1.0);
  paved = paved * paved * (3.0 - 2.0 * paved);
  track = max(track, paved * (1.0 - 0.5 * rock));

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
  if (uFacet > 0.5) {
    vec3 fm = dot(meshFace, meshFace) > 1e-14 ? normalize(meshFace) : n0;
    if (fm.y < 0.0) fm = -fm;
    n0 = hOk > 0.5 ? facetNormal(p.xz) : fm;
  }
  vec3 n = n0;

  // The terrace walls around a hill town: stone, from the terrace function itself.
  float stoneLip;
  float stoneFoot;
  float stone = cityRiser(p.xz, fwXZ, stoneLip, stoneFoot);
  if (stone > 0.0) {
    rock = max(rock, stone);
    salt *= 1.0 - stone;
    sandW = (1.0 - rock) * (1.0 - salt) * (1.0 - pave);
  }

  // Optional work shrinks toward the camera at low detail (1.0 at full detail).
  float dk = mix(0.45, 1.0, clamp(uDetail, 0.0, 1.0));

  // Baked close-up grain (detail maps, see render/art.ts). Read with explicit gradients from
  // dpX / dpY because the reads sit in branches; each one is skipped where its fade is zero.
  float grainOn = 1.0 - uFlat;
  float sandFade = detailFade(dist, 12.0 * dk, 40.0 * dk) * grainOn;
  float rockFade = detailFade(dist, 30.0 * dk, 90.0 * dk) * grainOn;

  // ---- sand ripples, two scales (analytic derivative along the wind)
  float rip = sandW * (1.0 - 0.85 * track) * (1.0 - smoothstep(0.35, 0.75, 1.0 - n0.y));
  if (rip > 0.001 && dist < 360.0) {
    vec2 g = vec2(0.0);
    float k1 = 6.2831853 / 0.5;
    float aa1 = 1.0 - smoothstep(1.2, 2.8, fwAlong * k1 * 1.3);
    float fade1 = 1.0 - smoothstep(6.0, 45.0 * dk, dist);
    if (fade1 * aa1 > 0.0) {
      // small ripples: their warp fbm is only paid for where they show
      float ph1 = along * k1 + fbm(p.xz * 0.45) * 9.0;
      float pat1 = 0.25 + 0.75 * smoothstep(0.25, 0.75, vnoise(p.xz * 0.05 + vec2(3.7, 1.3)));
      g += w * cos(ph1) * (0.35 * uRipple * fade1 * aa1 * pat1);
    }

    float k2 = 6.2831853 / 2.6;
    float ph2 = along * k2 + fbm(p.xz * 0.08 + vec2(11.0, 4.0)) * 10.0;
    float aa2 = 1.0 - smoothstep(1.2, 2.8, fwAlong * k2 * 1.3);
    float fade2 = 1.0 - smoothstep(40.0, 350.0, dist);
    float pat2 = 0.3 + 0.7 * smoothstep(0.3, 0.7, vnoise(p.xz * 0.012 + vec2(-5.1, 8.2)));
    g += w * cos(ph2) * (0.35 * uRippleBig * fade2 * aa2 * pat2);

    n.xz -= g * rip;
    n = normalize(n);
  }

  // ---- rock: break the smooth mesh normal into crags and ledges
  // (detail > 0.55: both octaves; 0.2..0.55: the large one only; below: none)
  float cragFar = 2500.0 * dk;
  if (rock > 0.01 && dist < cragFar && uDetail > 0.2 && uFacet < 0.5) {
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

  // ---- light, before the cast shadow
  float l = mix(clamp(ndl * 1.25, 0.0, 1.0), smoothstep(-0.02, 0.12, ndl), uTermSharp);

  // (wet ground and the river, which reflect the light whether or not the ground is lit)
  float rd = abs(vMask.z);
  float bank = clamp(vMask.w, 0.0, 1.0) * (1.0 - smoothstep(${TERRAIN.riverHalf}.0, ${TERRAIN.riverFloor + 12}.0, rd)) * (1.0 - pave);
  vec2 rained = rainedOn(p.xz);
  // on the night of the new moon the pans flood from below, rain or none
  float flooded = uFlood * smoothstep(0.25, 0.7, salt) * (1.0 - rock);
  rained.x = max(rained.x, flooded);

  // ---- cast shadow: ray-march the heightmap toward the light. Ground the light does not reach
  // (l == 0) is dark however much is in the way, so it is only marched for where it shows: in
  // the glint on water.
  float shadow = 1.0;
  float sIn = step(1.0, uRect.z) * (1.0 - smoothstep(0.82, 0.97, he));
  if (sIn > 0.0 && ndl > -0.05 && uSunDir.y > -0.1 && (l > 0.0 || bank > 0.003 || rained.x > 0.002)) {
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
      res = min(res, uShadowK * hh / t);
      if (res <= 0.0 || q.y > MAX_TERRAIN_H) break;
      t += max(minStep, t * grow);
    }
    shadow = mix(1.0, clamp(res, 0.0, 1.0), sIn);
  }

  float fs = figShadow(p);

  // ---- light
  l *= mix(1.0, shadow, uShadowAmt);
  // under a cave roof no sun reaches the floor, whatever the heightmap says
  l *= 1.0 - 0.94 * clamp(vCave, 0.0, 1.0);
  l *= cityShadow(p, uSunDir);
  l *= 1.0 - fs * 0.85;
  l *= 1.0 - tr * 0.22;
  l = styleBandsW(l, p.xz, 0.08);
  float amb = 0.5 + 0.5 * n.y;
  // flat looks drop the ambient shading and the albedo noise
  float ambS = mix(1.0, 0.5 + 0.5 * n.y, 1.0 - uFlat);
  // moonlight: keep a little more ambient so the ground stays readable
  l += (1.0 - l) * uNight * 0.14 * amb;

  // ---- sand
  vec3 sandCol = mix(uShade * (0.82 + 0.18 * ambS), uLit, l);
  if (uFlat < 0.999) sandCol *= mix(0.965 + 0.07 * fbm(p.xz * 0.3 + vec2(2.3, 7.1)), 1.0, uFlat);
  // wind-sorted grain: one tile per 0.9 m on the ground plane
  if (sandFade > 0.0 && sandW > 0.01) {
    const float SAND_TILE = 1.0 / 0.9;
    float g = textureGrad(uDetailMap2, p.xz * SAND_TILE, dpX.xz * SAND_TILE, dpY.xz * SAND_TILE).r - 0.5;
    sandCol *= detailMul(g, 0.16, sandFade);
  }

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
    rockCol = mix(uRockShade * (0.8 + 0.2 * ambS), uRockLit, l) * mix(tone, 0.94, uFlat * 0.85);
    // bedding, joints and pits, one tile per 3 m: on cliffs the plane's second axis is height, so
    // the strata run level (the smooth mesh normal picks the plane, so crags do not flicker it)
    if (rockFade > 0.0) {
      const float ROCK_TILE = 1.0 / 3.0;
      vec2 ruv = detailPlane(p, n0) * ROCK_TILE;
      vec2 rdx = detailPlane(dpX, n0) * ROCK_TILE;
      vec2 rdy = detailPlane(dpY, n0) * ROCK_TILE;
      float g = textureGrad(uDetailMap2, ruv, rdx, rdy).g - 0.5;
      rockCol *= detailMul(g, 0.22, rockFade);
    }
  }

  // ---- salt: pale crust with polygonal cracks
  vec3 saltCol = vec3(0.0);
  if (salt > 0.001) {
    saltCol = mix(uSaltShade * (0.86 + 0.14 * ambS), uSaltLit, l);
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
  // trodden ground is flatter, darker and a little browner than the dunes around it, with grit
  // and small stones kicked up along it close by
  if (track > 0.001) {
    float grit = 1.0;
    if (dist < 80.0) {
      float g = vnoise(p.xz * 3.1) * 0.6 + vnoise(p.xz * 9.0) * 0.4;
      grit = 1.0 + (g - 0.5) * 0.16 * (1.0 - smoothstep(30.0, 80.0, dist));
    }
    vec3 worn = col * vec3(0.87, 0.83, 0.78) * grit;
    col = mix(col, worn, track);
  }
  // ---- snow on the high peaks
  if (p.y > SNOW_LINE - 50.0 || inFrost(p)) {
    float snow = snowAt(p, n.y);
    vec3 snowCol = mix(uSnowShade * (0.85 + 0.15 * ambS), uSnowLit, l);
    // a very faint, matte grain in the crust close by (detail.png G: no glints)
    if (sandFade > 0.0 && snow > 0.01) {
      const float SNOW_TILE = 1.0 / 1.2;
      float g = textureGrad(uDetailMap, p.xz * SNOW_TILE, dpX.xz * SNOW_TILE, dpY.xz * SNOW_TILE).g - 0.5;
      snowCol *= detailMul(g, 0.08, sandFade);
    }
    col = mix(col, snowCol, snow);
    // where the road runs through it the snow is packed down: greyer, bluer, scuffed close by
    if (paved > 0.001) {
      float scuff = 0.9 + 0.2 * (vnoise(p.xz * 2.3) * 0.6 + vnoise(p.xz * 7.0) * 0.4);
      col = mix(col, col * vec3(0.7, 0.75, 0.83) * scuff, paved * snow * 0.9);
    }
  }
  // terrace walls: a slightly darker dressed stone, a light cap along the lip, a shadow at the foot
  col *= 1.0 - 0.1 * stone;
  col = mix(col, col * 1.16 + vec3(0.015), stoneLip);
  col *= 1.0 - 0.3 * stoneFoot;

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
    // packed grit underfoot: the sand grain, a little coarser and fainter
    if (sandFade > 0.0) {
      const float PAVE_TILE = 1.0 / 1.3;
      float g = textureGrad(uDetailMap2, p.xz * PAVE_TILE, dpX.xz * PAVE_TILE, dpY.xz * PAVE_TILE).r - 0.5;
      paveCol *= detailMul(g, 0.12, sandFade);
    }
    col = mix(col, paveCol, pave);
  }
  // the ground darkens softly where it meets the walls and under the tree crowns
  col *= 1.0 - 0.42 * cityContact(p);

  // ---- sparkle on sand only
  float spk = sandW * (1.0 - track) * (1.0 - smoothstep(25.0 * dk, 60.0 * dk, dist));
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
    col += uSunCol * (on * dotc * (0.15 + 1.6 * spec) * tw * l * spk * uSparkle);
  }

  // ---- rivers: green, damp banks, and the water itself painted on the flat bed. The distance
  // to the river is signed, so it interpolates straight through the water even where the mesh
  // is far coarser than the river is wide.
  if (bank > 0.003) {
    // growth is thick at the water and breaks into patches further up the bank
    float grow = (1.0 - rock) * smoothstep(0.5, 0.74, fbm(p.xz * 0.11 + vec2(6.4, 1.9)) * (0.55 + 0.45 * bank) + 0.42 * bank * bank);
    vec3 grassCol = mix(uShade * (0.8 + 0.2 * amb), uLit, l) * vec3(0.56, 0.72, 0.36);
    grassCol *= 0.86 + 0.28 * vnoise(p.xz * 1.7);
    // nothing grows up the headwall where a river springs from a mountain
    float low = 1.0 - smoothstep(${TERRAIN.waterY + 4}.0, ${TERRAIN.waterY + 14}.0, p.y);
    col = mix(col, grassCol, 0.72 * grow * low * smoothstep(0.0, 0.15, bank));
    // wet sand at the water's edge
    col *= 1.0 - 0.3 * (1.0 - smoothstep(${TERRAIN.riverHalf}.0, ${TERRAIN.riverHalf + 5}.0, rd)) * smoothstep(0.3, 0.6, bank);
    // The water ends cleanly: at a spring it starts at the lip of the notch in the headwall, no
    // wider than the notch, and spreads to the river's full width by the pool.
    float hw = mix(${TERRAIN.springHalf - 1.5}, ${TERRAIN.riverHalf - 1.2}, smoothstep(${TERRAIN.springLip + 0.02}, 0.97, vMask.w));
    float wa = (1.0 - smoothstep(hw, hw + 1.5, rd)) * smoothstep(${TERRAIN.springLip}, ${TERRAIN.springLip + 0.03}, vMask.w) * (1.0 - pave);
    // the notch itself: dark inside, wet at the bottom. It stops at the notch's back wall, so
    // none of it shows on the cliff above the rock that caps the notch.
    float mouth = (1.0 - smoothstep(${TERRAIN.springHalf - 1.5}, ${TERRAIN.springHalf + 0.5}, rd)) * smoothstep(${TERRAIN.springBack - 0.045}, ${TERRAIN.springBack - 0.01}, vMask.w) * (1.0 - smoothstep(${TERRAIN.springLip}, ${TERRAIN.springLip + 0.03}, vMask.w)) * smoothstep(${TERRAIN.waterY + 8}.0, ${TERRAIN.waterY + 14}.0, p.y);
    col = mix(col, mix(uShade * 0.16, uTop * vec3(0.3, 0.5, 0.48), 0.25), 0.94 * mouth);
    if (wa > 0.001) {
      vec3 V = toCam / max(dist, 1e-4);
      vec2 wq = p.xz * 0.3;
      float wt = uTime * 0.25;
      float w0 = vnoise(wq + wt) + vnoise(wq * 2.3 - wt * 1.3);
      float wx = vnoise(wq + vec2(0.08, 0.0) + wt) + vnoise((wq + vec2(0.08, 0.0)) * 2.3 - wt * 1.3);
      float wz = vnoise(wq + vec2(0.0, 0.08) + wt) + vnoise((wq + vec2(0.0, 0.08)) * 2.3 - wt * 1.3);
      float calm = 1.0 - smoothstep(80.0, 400.0, dist);
      vec3 wn = normalize(vec3(-(wx - w0) * 0.9 * calm, 1.0, -(wz - w0) * 0.9 * calm));
      float c = clamp(dot(wn, V), 0.0, 1.0);
      float fres = pow(1.0 - c, 3.0);
      // looking down shows the deep green of the water; a grazing view mirrors the sky
      vec3 deep = mix(uTop, uShade, 0.25) * vec3(0.55, 1.0, 0.86);
      vec3 wcol = mix(deep, mix(uTop, uHorizon, 0.75), 0.15 + 0.85 * fres);
      wcol *= 0.78 + 0.22 * l;
      vec3 rf = reflect(-V, wn);
      wcol += uSunCol * pow(max(dot(rf, uSunDir), 0.0), 180.0) * (1.0 - 0.6 * uNight) * 1.2 * shadow;
      // shallows: the bed shows through near the bank
      float shal = smoothstep(${TERRAIN.riverHalf - 7}.0, ${TERRAIN.riverHalf}.0, rd);
      wcol = mix(wcol, col * 0.8, 0.35 * shal * c);
      // above the water level this is the fall where the river springs from the mountainside
      float fall = smoothstep(${TERRAIN.waterY + 0.4}, ${TERRAIN.waterY + 2}.0, p.y);
      if (fall > 0.001) {
        // Strands of white water: narrow across the fall (the signed distance to the river's
        // centre line runs across it), long down it, and sliding downward at different speeds.
        float fu = vMask.z;
        float s1 = vnoise(vec2(fu * 1.7, p.y * 0.1 + uTime * 2.6));
        float s2 = vnoise(vec2(fu * 4.3 + 7.0, p.y * 0.22 + uTime * 4.1));
        float s3 = vnoise(vec2(fu * 0.6 - 3.0, p.y * 0.05 + uTime * 1.5));
        float strand = smoothstep(0.42, 0.74, 0.45 * s1 + 0.3 * s2 + 0.35 * s3);
        // clumps that break up as they drop
        float lump = vnoise(vec2(fu * 0.9, p.y * 0.6 + uTime * 5.0));
        float lum = dot(mix(uShade * 1.5, uLit, 0.3 + 0.7 * l), vec3(0.3, 0.6, 0.1));
        vec3 veil = vec3(0.74, 0.88, 1.0) * lum; // the thin sheet between the strands
        vec3 foam = vec3(0.96, 0.98, 1.0) * (lum * 1.25 + 0.1);
        vec3 fcol = mix(veil, foam, strand * (0.65 + 0.35 * lump));
        // thinner at its edges, so the rock shows through
        fcol = mix(col, fcol, 0.55 + 0.45 * (1.0 - smoothstep(${TERRAIN.riverHalf - 5}.0, ${TERRAIN.riverHalf}.0, abs(fu))) * (0.6 + 0.4 * strand));
        // spray where it lands
        float spray = 1.0 - smoothstep(${TERRAIN.waterY + 2}.0, ${TERRAIN.waterY + 10}.0, p.y);
        fcol = mix(fcol, foam, 0.7 * spray * (0.55 + 0.45 * vnoise(vec2(fu * 0.8, uTime * 3.0))));
        wcol = mix(wcol, fcol, fall);
      }
      col = mix(col, wcol, wa);
    }
  }

  // ---- after rain. Sand drinks it and goes dark; on the salt it cannot soak in, so it stands a
  // finger deep and the pan is a mirror; and some hours on, the dunes it fell on are in flower.
  vec2 flc = p.xz * 3.0;
  float fwFl = max(fwidth(flc.x), fwidth(flc.y));
  if (rained.x > 0.002) {
    float wet = rained.x;
    vec3 V = toCam / max(dist, 1e-4);
    float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 4.0);
    float soak = wet * (1.0 - 0.6 * rock) * (1.0 - salt) * (1.0 - 0.5 * pave);
    col = mix(col, col * vec3(0.66, 0.64, 0.66), soak);
    // wet ground takes a little of the sky at a low angle
    col += mix(uHorizon, uTop, 0.35) * (fres * 0.2 * wet * (1.0 - salt));
    float pan = wet * smoothstep(0.25, 0.7, salt) * (1.0 - rock);
    if (pan > 0.002) {
      // still, unless it is raining on it now
      vec2 wq = p.xz * 0.55;
      float wt = uTime * 0.2;
      float calm = 1.0 - smoothstep(60.0, 300.0, dist);
      float w0 = vnoise(wq + wt) + vnoise(wq * 3.1 - wt * 2.0) * uRainK;
      float wx = vnoise(wq + vec2(0.1, 0.0) + wt) + vnoise((wq + vec2(0.1, 0.0)) * 3.1 - wt * 2.0) * uRainK;
      float wz = vnoise(wq + vec2(0.0, 0.1) + wt) + vnoise((wq + vec2(0.0, 0.1)) * 3.1 - wt * 2.0) * uRainK;
      float rough = (0.22 + 1.6 * uRainK) * calm;
      vec3 wn = normalize(vec3(-(wx - w0) * rough, 1.0, -(wz - w0) * rough));
      float fr = 0.14 + 0.86 * pow(1.0 - clamp(dot(wn, V), 0.0, 1.0), 3.0);
      vec3 rf = reflect(-V, wn);
      vec3 sky = mix(uHorizon, uTop, pow(clamp(rf.y, 0.0, 1.0), 0.55));
      sky += uSunCol * pow(max(dot(rf, uSunDir), 0.0), 220.0) * (1.0 - 0.6 * uNight) * 1.3 * shadow;
      // and by night it holds the stars
      if (uStars > 0.01) {
        vec2 sq = rf.xz / (abs(rf.y) + 0.3) * 30.0;
        vec2 sc = floor(sq);
        vec2 sf = fract(sq) - 0.5 - (hash22(sc) - 0.5) * 0.6;
        float sfw = max(fwidth(sq.x), fwidth(sq.y));
        float star = step(0.8, hash21(sc + 7.3)) * (1.0 - smoothstep(0.05, 0.1 + sfw, length(sf))) * min(1.0, 0.12 / max(sfw, 1e-3));
        sky += vec3(0.9, 0.95, 1.0) * star * uStars * 1.1;
      }
      // looking straight down, the cracked crust shows through the water
      col = mix(col, mix(col * 0.72, sky, fr), pan * 0.94);
    }
  }
  if (rained.y > 0.002) {
    float bloom = rained.y * sandW * (1.0 - track) * (1.0 - pave);
    // they come up in drifts, thick in one hollow and thin on the next rise
    float cover = bloom * smoothstep(0.36, 0.68, fbm(p.xz * 0.035 + vec2(9.2, -4.4)) + 0.22 * bloom - 0.06);
    if (cover > 0.002) {
      // one kind of flower holds each stretch of ground
      float which = vnoise(p.xz * 0.011 + 13.7);
      vec3 pet = which < 0.36 ? vec3(1.0, 0.86, 0.3) : which < 0.6 ? vec3(0.74, 0.52, 0.92) : which < 0.82 ? vec3(0.98, 0.96, 0.9) : vec3(0.96, 0.5, 0.62);
      float lum = mix(dot(uShade, vec3(0.333)) * 1.4, dot(uLit, vec3(0.333)) * 1.25, l);
      // leaf first: a low green over the sand
      col = mix(col, mix(uShade, uLit, l) * vec3(0.5, 0.68, 0.34), 0.22 * cover);
      float nearK = 1.0 - smoothstep(35.0, 95.0, dist);
      float dots = 0.0;
      if (nearK > 0.001) {
        vec2 id = floor(flc);
        vec2 ff = fract(flc) - 0.5;
        vec2 off = (vec2(hash21(id + 11.9), hash21(id + 27.1)) - 0.5) * 0.6;
        float rad = 0.1 + 0.08 * hash21(id + 41.0);
        dots = (1.0 - smoothstep(rad - fwFl, rad + fwFl, length(ff - off))) * step(1.0 - 0.62 * cover, hash21(id + 3.3)) * (1.0 - smoothstep(0.5, 1.2, fwFl)) * nearK;
      }
      // far off they run together into a wash of the one colour
      col = mix(col, pet * lum, max(dots, 0.32 * cover * (1.0 - 0.65 * nearK)));
    }
  }

  // ---- contour lines every 4 m, every 5th thicker (derivatives taken up front)
  if (uContour > 0.001) {
    float y = p.y / 4.0;
    float fy = max(fwY / 4.0, 1e-5);
    float dl = abs(fract(y + 0.5) - 0.5) / fy;
    float major = 1.0 - step(0.5, mod(floor(y + 0.5), 5.0));
    float hw = mix(0.5, 1.1, major);
    float ln = 1.0 - smoothstep(hw - 0.5, hw + 0.5, dl);
    ln *= mix(1.0 - smoothstep(0.12, 0.3, fy), 1.0 - smoothstep(0.6, 1.5, fy), major);
    col = mix(col, uLine, ln * uContour);
  }

  // ---- world grid every 8 m
  if (uGrid > 0.001) {
    vec2 gg = p.xz / 8.0;
    vec2 fg = max(fwXZv / 8.0, vec2(1e-5));
    vec2 dg = abs(fract(gg + 0.5) - 0.5) / fg;
    vec2 lg = (1.0 - smoothstep(vec2(0.0), vec2(1.0), dg)) * (1.0 - smoothstep(vec2(0.12), vec2(0.3), fg));
    col = mix(col, uLine, max(lg.x, lg.y) * uGrid);
  }

  // ---- over a sealed cavern the crust has sunk and split: a round patch of darker sand,
  // crazed like dried mud, that says there is something under here to break into
  for (int i = 0; i < 4; i++) {
    if (uCavC[i].w <= 0.0 || uCavB[i].z >= 1.0 || sandW < 0.01) continue;
    vec2 cd = p.xz - (uCavA[i].xy + uCavA[i].zw * uCavD[i].w);
    float cr = length(cd);
    float seal = (1.0 - uCavB[i].z) * sandW;
    // the cracks are only worked out close to the spot; further out there is just the glow
    vec2 cv = cr < 9.0 ? cells(p.xz / 0.75 + float(i) * 3.7) : vec2(1.0);
    if (cr <= 5.5) {
      float edge = 3.6 + 0.9 * vnoise(vec2(atan(cd.y, cd.x) * 2.5, float(i) * 9.1));
      // it fades out into the sand over half its width, and drifts of sand lie across it, so
      // the cracks show in patches rather than as a clean disc
      float k = (1.0 - smoothstep(edge - 2.6, edge, cr)) * seal * (1.0 - smoothstep(60.0, 140.0, dist));
      float bare = smoothstep(0.46, 0.66, fbm(p.xz * 0.8 + float(i) * 5.3) + 0.12 * k) * k;
      float crack = 1.0 - smoothstep(0.03, 0.09 + 0.6 * fwXZ, cv.x);
      col *= 1.0 - k * (0.07 + bare * (0.07 + 0.04 * cv.y + 0.4 * crack * (1.0 - smoothstep(12.0, 45.0, dist))));
    }
    // and so that it is not walked past, light leaks up through the cracks: every seam in the
    // crust glows gold from below, brightest over the spot the pick must strike, in a pulse
    // that runs outward. It shows from much further off than the dark cracks do, where the
    // seams run together into one warm patch, and it lights the sand at night.
    float gk = seal * (1.0 - smoothstep(280.0, 440.0, dist));
    if (cr < 14.0 && gk > 0.0) {
      vec3 gold = vec3(1.0, 0.76, 0.3);
      float breathe = 0.5 + 0.5 * sin(uTime * 1.6 + float(i) * 2.1);
      float wave = 0.5 + 0.5 * sin(uTime * 1.5 - cr * 1.15 + float(i) * 2.1);
      float fall = exp(-cr * cr / 15.0);
      float halo = exp(-cr * cr / 50.0);
      float seam = 1.0 - smoothstep(0.02, 0.1 + 0.7 * fwXZ, cv.x);
      col *= 1.0 - 0.1 * fall * gk;
      col = mix(col, gold * 1.12, clamp(seam * fall * (0.45 + 0.55 * wave) * 1.25, 0.0, 1.0) * gk);
      float g = fall * (0.07 + 0.07 * wave) + exp(-cr * cr / 2.0) * 0.12;
      col += gold * gk * (g + halo * uNight * (0.12 + 0.1 * breathe + 0.25 * g));
    }
  }

  // ---- deep in a cavern: past the daylight from its mouth the rock is nearly black, and
  // whatever glows down there is all that lights it
  float deep = clamp(vCave - 1.0, 0.0, 1.0);
  if (deep > 0.001) {
    col *= 1.0 - 0.86 * deep;
    if (uCavGlow.w > 0.0) {
      vec3 gd = uCavGlow.xyz - p;
      float g2 = dot(gd, gd);
      float ga = 1.0 / (1.0 + g2 / (0.16 * uCavGlow.w * uCavGlow.w));
      ga *= 0.45 + 0.55 * max(dot(n, gd * inversesqrt(g2 + 1e-3)), 0.0);
      ga *= 0.92 + 0.08 * sin(uTime * 0.9);
      col += uCavGlowCol * (0.85 * ga * smoothstep(0.0, 0.35, deep));
    }
  }

  // ---- fog (the haze of the open desert does not hang underground)
  col = mix(col, uFogCol, (1.0 - exp(-dist * uFog * hazeAt(p.y))) * (1.0 - deep));

  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------- ROCK CAPS

// The rock over a cave or a spring's notch is a small mesh of its own (the ground cannot
// overhang). It is drawn with terrainFrag, fed the same values the ground would give it, so the
// cliff carries on across it unbroken.
export const rockCapVert = /* glsl */ `
precision highp float;

attribute vec2 aMask; // rock, salt
attribute float aCave; // 1 on faces inside the hollow

varying vec3 vW;
varying vec3 vN;
varying vec4 vMask;
varying float vCave;

void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vW = wp;
  vN = normal;
  vMask = vec4(aMask, 300.0, 0.0); // far from any river
  vCave = aCave;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * (wp - cameraPosition), 1.0);
}
`;

// ---------------------------------------------------------------- FAR MASSIFS

// A coarse mesh of each massif, drawn only beyond the reach of the clipmap.
export const massifVert = /* glsl */ `
attribute float aRock;
varying vec3 vW;
varying vec3 vN;
varying float vRock;

void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vW = wp;
  vN = normal;
  vRock = aRock;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * (wp - cameraPosition), 1.0);
}
`;

export const massifFrag = /* glsl */ `
precision highp float;

uniform vec3 uSunDir;
uniform float uNight;
uniform float uFog;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uRockLit;
uniform vec3 uRockShade;
uniform vec3 uSnowLit;
uniform vec3 uSnowShade;
uniform vec3 uFogCol;
uniform vec3 uNear; // xz centre and half-size of the square the clipmap covers

varying vec3 vW;
varying vec3 vN;
varying float vRock;

${LOOK}
${COMMON}
${HIGH}

void main() {
  vec2 dc = abs(vW.xz - uNear.xy);
  if (max(dc.x, dc.y) < uNear.z) discard;
  vec3 n = normalize(vN);
  float ndl = dot(n, uSunDir);
  float l = mix(clamp(ndl * 1.25, 0.0, 1.0), smoothstep(-0.02, 0.12, ndl), uTermSharp);
  l = styleBandsW(l, vW.xz, 0.08);
  float amb = 0.5 + 0.5 * n.y;
  l += (1.0 - l) * uNight * 0.14 * amb;
  float ambS = mix(1.0, amb, 1.0 - uFlat);
  vec3 sandCol = mix(uShade * (0.82 + 0.18 * ambS), uLit, l);
  vec3 rockCol = mix(uRockShade * (0.8 + 0.2 * ambS), uRockLit, l) * 0.94;
  vec3 col = mix(sandCol, rockCol, clamp(vRock, 0.0, 1.0));
  col = mix(col, mix(uSnowShade * (0.85 + 0.15 * ambS), uSnowLit, l), snowAt(vW, n.y));
  col = mix(col, uFogCol, 1.0 - exp(-length(cameraPosition - vW) * uFog * hazeAt(vW.y)));
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
  gl_FragColor = surface(xz);
}
`;
