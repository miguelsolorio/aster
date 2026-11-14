import { describe, expect, it } from 'vitest';
import { inPen, PEN_GAP, PEN_MARGIN, penSpot, type PenShape } from '../pens';

function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// the smallest pen a canyon builds and a large trade-town one, trough and heap where pen() puts them
const PENS: PenShape[] = [
  { hw: 5, hd: 4, tu: 0.8, tv: 3.1, hu: -3.4, hv: -2.4 },
  { hw: 8, hd: 6.5, tu: -2, tv: 5.6, hu: -6.4, hv: -4.9 },
];

describe('pen wander targets', () => {
  it('stay inside the rails, clear of the trough, the heap and the other beasts', () => {
    const r = rand(7);
    const out = { u: 0, v: 0, yaw: 0 };
    for (const p of PENS) {
      // (one other beast in the small pen, two in the big one)
      const others = p.hw < 6 ? [2.5, 1.5] : [1.5, 0.5, -2, 1];
      let found = 0;
      for (let i = 0; i < 400; i++) {
        if (!penSpot(p, r, others, 0, out)) continue;
        found++;
        expect(inPen(p, out.u, out.v, PEN_MARGIN)).toBe(true);
        expect(Math.hypot(out.u - p.hu, out.v - p.hv)).toBeGreaterThan(2.7);
        for (let k = 0; k < others.length; k += 2) expect(Math.hypot(out.u - others[k], out.v - others[k + 1])).toBeGreaterThanOrEqual(PEN_GAP);
        expect(Number.isNaN(out.yaw)).toBe(true);
      }
      expect(found).toBeGreaterThan(40);
    }
  });

  it('put a beast that eats beside the trough or the heap, facing it, still inside', () => {
    const r = rand(11);
    const out = { u: 0, v: 0, yaw: 0 };
    for (const p of PENS) {
      for (const eat of [1, 2]) {
        let found = 0;
        for (let i = 0; i < 100; i++) {
          if (!penSpot(p, r, [], eat, out)) continue;
          found++;
          expect(inPen(p, out.u, out.v, PEN_MARGIN)).toBe(true);
          const [fx, fz] = eat === 1 ? [p.tu, p.tv] : [p.hu, p.hv];
          // facing it: the way it faces points toward the trough's line, or the heap
          const dot = Math.sin(out.yaw) * (fx - out.u) + Math.cos(out.yaw) * (fz - out.v);
          expect(dot).toBeGreaterThan(0);
        }
        expect(found).toBeGreaterThan(10);
      }
    }
  });

  it('gives up when there is no room', () => {
    const p = PENS[0];
    const crowd: number[] = [];
    for (let u = -4; u <= 4; u += 1) for (let v = -3; v <= 3; v += 1) crowd.push(u, v);
    expect(penSpot(p, rand(3), crowd, 0, { u: 0, v: 0, yaw: 0 })).toBe(false);
  });
});
