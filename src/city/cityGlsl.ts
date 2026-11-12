// GLSL shared by the terrain and the city shaders.

/** How many city sites the shaders consider at once (the nearest ones to the camera). */
export const MAX_SITES = 4;

/**
 * Where cities stand, for flattening the terrain and paving the ground.
 * uCityA[i] = (centre x, centre z, radius, plateau height); radius 0 means unused.
 * uCityB[i] = (edge phase 1, edge phase 2, falloff metres, unused).
 * cityBlend returns (flatten 0..1, paved 0..1) and the plateau height of the strongest site.
 * The TypeScript twin is cityBlendAt in placement.ts: keep them identical.
 */
export const CITY_SITES_GLSL = /* glsl */ `
uniform vec4 uCityA[${MAX_SITES}];
uniform vec4 uCityB[${MAX_SITES}];

vec2 cityBlend(vec2 p, out float ground) {
  vec2 best = vec2(0.0);
  ground = 0.0;
  for (int i = 0; i < ${MAX_SITES}; i++) {
    vec4 a = uCityA[i];
    if (a.z <= 0.0) continue;
    vec2 d = p - a.xy;
    float dist = length(d);
    float reach = a.z * 1.2 + uCityB[i].z;
    if (dist > reach) continue;
    float ang = atan(d.y, d.x);
    float edge = a.z * (1.0 + 0.10 * sin(3.0 * ang + uCityB[i].x) + 0.06 * sin(5.0 * ang + uCityB[i].y));
    float m = 1.0 - smoothstep(edge, edge + uCityB[i].z, dist);
    if (m > best.x) {
      best = vec2(m, 1.0 - smoothstep(edge - 10.0, edge, dist));
      ground = a.w;
    }
  }
  return best;
}
`;

/**
 * Shadows cast by the buildings of the one city that is loaded in full.
 * uCityMap: R = roof height above the plateau, in units of 0.25 m per 1/255 (so up to 63.75 m), 1 m texels.
 * uCityRect = (centre x, centre z, half size in metres, rotation); half size 0 means no city is loaded.
 * uCityGround = plateau height.
 * cityShadow(worldPos) returns 1 in light and 0 in the shadow of a building.
 */
export const CITY_SHADOW_GLSL = /* glsl */ `
uniform sampler2D uCityMap;
uniform vec4 uCityRect;
uniform float uCityGround;

vec2 cityLocal(vec2 xz) {
  vec2 d = xz - uCityRect.xy;
  float c = cos(uCityRect.w);
  float s = sin(uCityRect.w);
  return vec2(c * d.x + s * d.y, -s * d.x + c * d.y);
}

float cityRoof(vec2 l) {
  vec2 uv = l / (2.0 * uCityRect.z) + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return textureLod(uCityMap, uv, 0.0).r * 63.75;
}

float cityShadow(vec3 p, vec3 sunDir) {
  if (uCityRect.z <= 0.0) return 1.0;
  vec2 l = cityLocal(p.xz);
  if (max(abs(l.x), abs(l.y)) > uCityRect.z + 90.0) return 1.0;
  float c = cos(uCityRect.w);
  float s = sin(uCityRect.w);
  vec2 dl = vec2(c * sunDir.x + s * sunDir.z, -s * sunDir.x + c * sunDir.z);
  float y = p.y - uCityGround + 0.2;
  float lit = 1.0;
  float t = 0.7;
  for (int i = 0; i < 26; i++) {
    float gap = (y + sunDir.y * t) - cityRoof(l + dl * t);
    lit = min(lit, clamp(gap * 1.4 + 0.5, 0.0, 1.0));
    if (lit <= 0.0 || y + sunDir.y * t > 64.0) break;
    t += 0.9 + t * 0.12;
  }
  return lit;
}
`;
