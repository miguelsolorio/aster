// Seeded 2D Perlin gradient noise.

/** Small fast seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 8 unit gradient directions (axes and diagonals).
const S = Math.SQRT1_2;
const GX = [1, -1, 0, 0, S, -S, S, -S];
const GY = [0, 0, 1, -1, S, S, -S, -S];

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Returns a noise function with output roughly in [-1, 1]. */
export function makeNoise(seed: number): (x: number, y: number) => number {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // Fisher-Yates shuffle
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  // Unit-gradient 2D Perlin peaks near +-sqrt(2)/2, so scale up to ~[-1, 1].
  const SCALE = Math.SQRT2;

  return (x: number, y: number): number => {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const xi = xf & 255;
    const yi = yf & 255;
    const dx = x - xf;
    const dy = y - yf;

    const g00 = perm[perm[xi] + yi] & 7;
    const g10 = perm[perm[xi + 1] + yi] & 7;
    const g01 = perm[perm[xi] + yi + 1] & 7;
    const g11 = perm[perm[xi + 1] + yi + 1] & 7;

    const n00 = GX[g00] * dx + GY[g00] * dy;
    const n10 = GX[g10] * (dx - 1) + GY[g10] * dy;
    const n01 = GX[g01] * dx + GY[g01] * (dy - 1);
    const n11 = GX[g11] * (dx - 1) + GY[g11] * (dy - 1);

    const u = fade(dx);
    const v = fade(dy);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * SCALE;
  };
}
