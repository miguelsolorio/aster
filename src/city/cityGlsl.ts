// GLSL shared by the terrain and the city shaders.

/** How many city sites the shaders consider at once (the nearest ones to the camera). */
export const MAX_SITES = 4;

/**
 * How far past radius * 1.2 + falloff a city may reshape the desert (the oasis dunes reach
 * furthest). Cities sit at least 1.8 km from their cell border, so this stays well inside it.
 */
export const CITY_REACH_EXTRA = 600;

/**
 * Where cities stand, for flattening the terrain and paving the ground.
 * uCityA[i] = (centre x, centre z, radius, plateau height); radius 0 means unused.
 * uCityB[i] = (edge phase 1, edge phase 2, falloff metres, kind: 1 hill, 2 canyon, 3 oasis, 4 trade).
 * uCityC[i] = (track bearing 1, track bearing 2, avenues A, avenues B): see cityAveLat.
 * cityPave returns the paved (built) mask 0..1, cheaply, for fragment shaders; cityRiser the
 * stone walls of hill terraces. The terrace and way-out helpers here are shared with cityBlend.
 */
export const CITY_SITES_GLSL = /* glsl */ `
uniform vec4 uCityA[${MAX_SITES}];
uniform vec4 uCityB[${MAX_SITES}];
uniform vec4 uCityC[${MAX_SITES}];

float cityPave(vec2 p) {
  float best = 0.0;
  for (int i = 0; i < ${MAX_SITES}; i++) {
    vec4 a = uCityA[i];
    if (a.z <= 0.0) continue;
    vec2 d = p - a.xy;
    float dist = length(d);
    if (dist > a.z * 1.2) continue;
    float ang = atan(d.y, d.x);
    float edge = a.z * (1.0 + 0.10 * sin(3.0 * ang + uCityB[i].x) + 0.06 * sin(5.0 * ang + uCityB[i].y));
    best = max(best, 1.0 - smoothstep(edge - 10.0, edge, dist));
  }
  return best;
}

const float CITY_TAU = 6.283185307;
const float CITY_PI = 3.141592654;

float cityWrap(float a) {
  return mod(a + CITY_PI, CITY_TAU) - CITY_PI;
}

// Lateral distance in metres from a point (bearing ang, dist from the centre) to the nearest avenue.
// c.z = 64 * s + 8 * n + base bearing; c.w = n 4-bit offsets q, avenue k at base + TAU k / n + (q - 7.5) * step.
float cityAveLat(float ang, float dist, vec4 c) {
  float s = floor(c.z / 64.0);
  float rem = c.z - s * 64.0;
  float n = floor(rem / 8.0);
  float base = rem - n * 8.0;
  float st = 0.008 * (s + 1.0);
  uint code = uint(c.w); // an exact integer below 2^24 (adding 0.5 would round it)
  float best = 1e6;
  for (int k = 0; k < 6; k++) {
    if (float(k) >= n) break;
    float q = float((code >> uint(4 * k)) & 15u);
    float a = base + CITY_TAU * float(k) / n + (q - 7.5) * st;
    best = min(best, abs(cityWrap(ang - a)));
  }
  return best * dist;
}

// The terrace coordinate down the slope of a hill town: k = warped u (0 at the plateau edge,
// 1 at the foot) times N, the number of terraces (4 to 7). Bench j is floor(k) = j; the riser
// below it is fract(k) in 0.9..1. dk = dk/du, for metric distances.
float cityTerraceK(float u, float ang, vec4 b, out float N, out float dk) {
  N = 4.0 + floor(fract(b.x * 1.37) * 4.0);
  float s2 = sin(2.0 * ang + b.y);
  float c3 = cos(3.0 * ang + b.x);
  float uw = u + 0.0584 * sin(9.424778 * u) * s2 + 0.0191 * sin(15.70796 * u) * c3;
  dk = (1.0 + 0.0584 * 9.424778 * cos(9.424778 * u) * s2 + 0.0191 * 15.70796 * cos(15.70796 * u) * c3) * N;
  return uw * N;
}

// How open the slope of a hill town is at a point: 1 on a ramp (a track or an avenue), 0 on terraces.
float cityRamp(float ang, float dist, vec4 c) {
  float tr = min(abs(cityWrap(ang - c.x)), abs(cityWrap(ang - c.y)));
  return max(1.0 - smoothstep(0.16, 0.28, tr), 1.0 - smoothstep(16.0, 34.0, cityAveLat(ang, dist, c)));
}

// The stone walls (risers) of a hill town's terraces, decided from the same terrace function that
// shapes the ground, so their edges are exact at any distance. aa = pixel footprint in metres.
// Returns stone 0..1; lip = a thin light line along the top edge of each wall, foot = a thin
// shadow line along its foot (both fade out once they are thinner than a pixel).
float cityRiser(vec2 p, float aa, out float lip, out float foot) {
  lip = 0.0;
  foot = 0.0;
  for (int i = 0; i < ${MAX_SITES}; i++) {
    vec4 a = uCityA[i];
    vec4 b = uCityB[i];
    if (a.z <= 0.0 || b.w > 1.5) continue;
    vec2 d = p - a.xy;
    float dist = length(d);
    if (dist < a.z * 0.8 || dist > a.z * 1.2 + b.z) continue;
    float ang = atan(d.y, d.x);
    float edge = a.z * (1.0 + 0.10 * sin(3.0 * ang + b.x) + 0.06 * sin(5.0 * ang + b.y));
    float F = b.z;
    float t = dist - edge;
    if (t <= 0.0 || t >= F) return 0.0;
    float N;
    float dk;
    float k = cityTerraceK(t / F, ang, b, N, dk);
    float kf = floor(k);
    float fr = k - kf;
    float mpf = F / max(dk, 0.05); // metres per unit of k
    float dTop = (fr - 0.9) * mpf; // metres past the lip of this bench's wall (< 0: still on the bench)
    float dFoot = (1.0 - fr) * mpf; // metres to the foot of that wall
    float dPast = fr * mpf; // metres past the foot of the wall above
    // where the warp stretches a wall into a long gentle slope, it is sand rather than stone
    float open = (1.0 - cityRamp(ang, dist, uCityC[i])) * smoothstep(0.2, 0.45, 24.0 / (N * 0.1 * mpf));
    // lower walls fade as the dunes come back in near the foot of the mound
    float sBelow = (kf + 1.0) / N;
    float sAbove = kf / N;
    float wHere = open * (1.0 - 0.6 * sBelow * sBelow * sBelow);
    float wAbove = open * (1.0 - 0.6 * sAbove * sAbove * sAbove) * step(0.5, kf);
    float e = max(aa, 0.04);
    float stone = smoothstep(-e, e, dTop) * smoothstep(-e, e, dFoot) * wHere + (1.0 - smoothstep(-e, e, dPast)) * wAbove;
    float lines = 1.0 - smoothstep(0.3, 0.9, aa);
    lip = (1.0 - smoothstep(0.0, 0.45, abs(dTop + 0.3))) * wHere * lines;
    foot = max(1.0 - smoothstep(0.0, 1.0, dPast), 1.0 - smoothstep(0.0, 0.6, dFoot)) * lines;
    foot *= dPast < dFoot ? wAbove : wHere;
    return stone;
  }
  return 0.0;
}
`;

/**
 * The ground a city makes around itself. Needs CITY_SITES_GLSL and sfNoise (surface.ts) first.
 * Inside the plateau edge the ground is flat at the plateau height, exactly as it always was;
 * outside it each kind shapes its surroundings, leaving ways out along the avenues and tracks:
 *   hill    the mound steps down in 4 to 7 terraces with short rocky risers, ramps on the ways out
 *   canyon  a broken ring of rock buttes and cliffs 20 to 60 m high, with gaps on the ways out
 *   oasis   a ring of sheltering dunes 250 to 450 m out, saddled where the tracks cross it
 *   trade   a barely raised rim around the salt pan
 * cityBlend(p, base, key, h, rock): base = the raw desert height at p, key = noise key.
 * (The hill risers are not rock to the player: they are drawn as stone, see cityRiser.)
 * Returns (flatten 0..1, paved 0..1); h = the new height; rock = rock mask added there.
 * The TypeScript twin is cityBlendAt in placement.ts: keep them identical, operation for operation.
 */
export const CITY_SHAPE_GLSL = /* glsl */ `
vec2 cityBlend(vec2 p, float base, uint key, out float h, out float rock) {
  h = base;
  rock = 0.0;
  for (int i = 0; i < ${MAX_SITES}; i++) {
    vec4 a = uCityA[i];
    if (a.z <= 0.0) continue;
    vec4 b = uCityB[i];
    vec2 d = p - a.xy;
    float dist = length(d);
    if (dist > a.z * 1.2 + b.z + ${CITY_REACH_EXTRA}.0) continue;
    // Sites are kilometres apart, so this is the only one in reach.
    vec4 c = uCityC[i];
    float ang = atan(d.y, d.x);
    float edge = a.z * (1.0 + 0.10 * sin(3.0 * ang + b.x) + 0.06 * sin(5.0 * ang + b.y));
    float F = b.z;
    float m = 1.0 - smoothstep(edge, edge + F, dist);
    float paved = 1.0 - smoothstep(edge - 10.0, edge, dist);
    h = mix(base, a.w, m);
    float t = dist - edge;
    if (t > 0.0) {
      float tr = min(abs(cityWrap(ang - c.x)), abs(cityWrap(ang - c.y)));
      float av = cityAveLat(ang, dist, c);
      if (b.w < 1.5) {
        // hill: terraces of irregular width, ramps on the ways out
        if (t < F) {
          float N;
          float dk;
          float k = cityTerraceK(t / F, ang, b, N, dk);
          float kf = floor(k);
          float fr = k - kf;
          float st = (kf + smoothstep(0.9, 1.0, fr)) / N;
          // level benches stepping down to the desert's mean level (the mound is 24 m high),
          // the dunes coming back in only near the foot
          float ht = mix(a.w - 24.0 * st, base, st * st * st);
          float ramp = max(1.0 - smoothstep(0.16, 0.28, tr), 1.0 - smoothstep(16.0, 34.0, av));
          h = mix(ht, h, ramp);
        }
      } else if (b.w < 2.5) {
        // canyon: buttes and cliffs, densest just outside the edge
        float gap = min(smoothstep(0.2, 0.32, tr), smoothstep(20.0, 45.0, av));
        float band = smoothstep(4.0, 30.0, t) * (1.0 - smoothstep(F + 40.0, F + 140.0, t));
        if (gap * band > 0.0) {
          float wall = 1.0 - smoothstep(40.0, 120.0, t);
          float v = sfNoise(d * ${1 / 85} + b.xy * 3.0, key) + 0.45 * wall - 0.1;
          float s = smoothstep(0.06, 0.14, v) * band * gap;
          float top = a.w + 20.0 + 40.0 * smoothstep(0.14, 0.6, v);
          h = h + (max(h, top) - h) * s;
          rock = smoothstep(0.0, 0.3, s);
        }
      } else if (b.w < 3.5) {
        // oasis: a ring of dunes, gentle to windward and steep to leeward, saddled at the tracks
        float sw = (d.x * 0.7648 + d.y * 0.6442) / dist;
        float cr = 350.0 + 70.0 * sin(2.0 * ang + b.x) + 30.0 * sin(5.0 * ang + b.y);
        float x = t - cr;
        float prof = x < 0.0 ? smoothstep(-(140.0 + 60.0 * sw), 0.0, x) : 1.0 - smoothstep(0.0, 170.0 - 90.0 * sw, x);
        float H = (25.0 + 10.0 * sin(3.0 * ang + b.y + 1.0)) * (1.0 - 0.75 * (1.0 - smoothstep(0.06, 0.3, tr)));
        h += H * prof;
      } else {
        // trade: a barely raised rim
        float rim = smoothstep(25.0, 70.0, t) * (1.0 - smoothstep(90.0, 170.0, t)) * min(smoothstep(0.1, 0.2, tr), smoothstep(12.0, 28.0, av));
        h += 1.2 * rim;
      }
    }
    return vec2(m, paved);
  }
  return vec2(0.0);
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
    // Only buildings cast shadows here: the ground around the plateau can lie below it
    // (terraces, basins), and must not be shaded by the empty plateau level.
    float roof = cityRoof(l + dl * t);
    if (roof > 0.0) lit = min(lit, clamp((y + sunDir.y * t - roof) * 1.4 + 0.5, 0.0, 1.0));
    if (lit <= 0.0 || y + sunDir.y * t > 64.0) break;
    t += 0.9 + t * 0.12;
  }
  return lit;
}
`;
