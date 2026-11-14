import { describe, expect, it } from 'vitest';
import { EARLY_CELL, EARLY_CHANCE, WILD_CELL, WILD_CHANCE, wildAnchor, wildWanted } from '../wildcamps';

const h = (a: number, b: number, c: number, d: number) => {
  let x = (a * 374761393 + b * 668265263 + c * 2147483647 + d * 1274126177) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

describe('wild camps', () => {
  it('keeps the anchor inside its cell and is stable', () => {
    for (let cx = -5; cx < 5; cx++) {
      const a = wildAnchor(cx, 3, WILD_CELL, h, 7);
      expect(a.x).toBeGreaterThanOrEqual(cx * WILD_CELL);
      expect(a.x).toBeLessThanOrEqual((cx + 1) * WILD_CELL);
      expect(wildAnchor(cx, 3, WILD_CELL, h, 7)).toEqual(a);
    }
  });
  it('fills about the stated share of cells, more of them early', () => {
    let wild = 0;
    let early = 0;
    for (let i = 0; i < 2000; i++) {
      if (wildWanted(i, -i * 3, WILD_CHANCE, h, 1)) wild++;
      if (wildWanted(i, -i * 3, EARLY_CHANCE, h, 1)) early++;
    }
    expect(wild / 2000).toBeGreaterThan(0.45);
    expect(wild / 2000).toBeLessThan(0.65);
    expect(early).toBeGreaterThan(wild);
    expect(EARLY_CELL).toBeLessThan(WILD_CELL);
  });
});
