import { makeNoise } from './noise';

export type HeightFn = (x: number, z: number) => number;

// |n| clamped to 1
const absc = (n: number): number => Math.min(1, Math.abs(n));

/** Dune terrain height in metres. */
export function makeHeightFn(seed: number): HeightFn {
  const n1 = makeNoise((seed * 1 + 0x1234567) | 0);
  const n2 = makeNoise((seed * 3 + 0x9e3779b) | 0);
  const n3 = makeNoise((seed * 7 + 0x5bd1e99) | 0);

  return (x: number, z: number): number => {
    // domain warp
    const wx = x + 38 * n1(x * 0.004 + 11, z * 0.004);
    const wz = z + 38 * n1(x * 0.004, z * 0.004 + 7);
    // large sinuous ridged dunes
    const r1 = 1 - absc(n2(wx * 0.0065, wz * 0.0038));
    const big = Math.pow(r1, 2.2) * 30;
    // mid-scale ripples, stronger near big crests
    const r2 = 1 - absc(n3(wx * 0.017 + 50, wz * 0.011 + 50));
    const mid = Math.pow(r2, 2.0) * 7 * (0.4 + 0.6 * r1);
    // very low-frequency swell
    const swell = n1(x * 0.0015 + 100, z * 0.0015 + 100) * 30;
    return big + mid + swell;
  };
}
