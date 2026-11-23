/**
 * Soft contact shade on the ground of a city, 0..1 per 1 m cell of the roof grid: the building
 * footprints (weighted by how tall they stand) blurred a few metres out, so the street darkens
 * where it meets a wall and more so in corners and narrow lanes, plus a soft pool under each
 * tree crown. The terrain reads it from the G channel of the city map (see cityContact).
 *
 * crowns: city-local x, z, radius triples.
 */
export function contactShade(grid: Float32Array, size: number, half: number, crowns: ArrayLike<number>): Float32Array {
  const a = contactBase(grid, size);
  shadeCrowns(a, size, half, crowns);
  return a;
}

/** The buildings' part of the contact shade alone (the plan worker works it out ahead). */
export function contactBase(grid: Float32Array, size: number): Float32Array {
  const S = size | 0;
  const a = new Float32Array(S * S);
  for (let k = 0; k < a.length; k++) a[k] = grid[k] > 0 ? Math.min(1, 0.35 + grid[k] / 4) : 0;
  const tmp = new Float32Array(S);
  // two box passes of radius 2 each way: a tent about 4 m to a side
  for (let pass = 0; pass < 2; pass++) {
    blurRows(a, S, 2, tmp);
    blurCols(a, S, 2, tmp);
  }
  return a;
}

/**
 * Adds the pools under tree crowns from triple `from` on (an index into crowns), in order, so
 * crowns added a few at a time come out as if all were added at once. Where `map` is given (the
 * packed city map, see roofBytes) the cells touched are repacked into its G channel too.
 */
export function shadeCrowns(a: Float32Array, size: number, half: number, crowns: ArrayLike<number>, from = 0, map?: Uint8Array): void {
  const S = size | 0;
  for (let i = from; i + 2 < crowns.length; i += 3) {
    const cx = crowns[i] + half, cz = crowns[i + 1] + half, r = crowns[i + 2];
    const i0 = Math.max(0, Math.floor(cx - r)), i1 = Math.min(S - 1, Math.ceil(cx + r));
    const j0 = Math.max(0, Math.floor(cz - r)), j1 = Math.min(S - 1, Math.ceil(cz + r));
    for (let j = j0; j <= j1; j++) {
      for (let q = i0; q <= i1; q++) {
        const d = Math.hypot(q + 0.5 - cx, j + 0.5 - cz) / r;
        if (d >= 1) continue;
        const t = 1 - d;
        const v = 0.7 * t * t * (3 - 2 * t);
        const k = j * S + q;
        a[k] = 1 - (1 - a[k]) * (1 - v);
        if (map) map[2 * k + 1] = Math.min(255, Math.round(a[k] * 255));
      }
    }
  }
}

/** The city map's texels: R roof height (0.25 m steps), G the contact shade. */
export function roofBytes(grid: Float32Array, shade: Float32Array): Uint8Array {
  const n = shade.length;
  const data = new Uint8Array(n * 2);
  for (let k = 0; k < n; k++) {
    data[2 * k] = Math.min(255, Math.round(grid[k] * 4));
    data[2 * k + 1] = Math.min(255, Math.round(shade[k] * 255));
  }
  return data;
}

function blurRows(a: Float32Array, S: number, r: number, tmp: Float32Array): void {
  const w = 2 * r + 1;
  for (let j = 0; j < S; j++) {
    const row = j * S;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += a[row + Math.min(S - 1, Math.max(0, i))];
    for (let i = 0; i < S; i++) {
      tmp[i] = sum / w;
      sum += a[row + Math.min(S - 1, i + r + 1)] - a[row + Math.max(0, i - r)];
    }
    a.set(tmp, row);
  }
}

function blurCols(a: Float32Array, S: number, r: number, tmp: Float32Array): void {
  const w = 2 * r + 1;
  for (let i = 0; i < S; i++) {
    let sum = 0;
    for (let j = -r; j <= r; j++) sum += a[Math.min(S - 1, Math.max(0, j)) * S + i];
    for (let j = 0; j < S; j++) {
      tmp[j] = sum / w;
      sum += a[Math.min(S - 1, j + r + 1) * S + i] - a[Math.max(0, j - r) * S + i];
    }
    for (let j = 0; j < S; j++) a[j * S + i] = tmp[j];
  }
}
