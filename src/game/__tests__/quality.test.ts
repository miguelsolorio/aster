import { describe, expect, it } from 'vitest';
import { AutoQuality, nextStep, type QualityTier } from '../quality';

// Feeds frames at a steady rate for a number of seconds.
function run(a: AutoQuality, fps: number, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / fps) a.frame(1 / fps);
}

describe('nextStep', () => {
  it('lowers render scale before the tier', () => {
    expect(nextStep('high', 0, false)).toEqual({ tier: 'high', scaleIdx: 1 });
    expect(nextStep('high', 2, false)).toEqual({ tier: 'high', scaleIdx: 3 });
  });

  it('drops one tier at the lowest scale and resets scale', () => {
    expect(nextStep('high', 3, false)).toEqual({ tier: 'low', scaleIdx: 0 });
    expect(nextStep('low', 3, false)).toEqual({ tier: 'mobile', scaleIdx: 0 });
  });

  it('stops at the floor', () => {
    expect(nextStep('mobile', 3, false)).toBeNull();
  });

  it('never changes a tier the player picked by hand', () => {
    expect(nextStep('high', 0, true)).toEqual({ tier: 'high', scaleIdx: 1 });
    expect(nextStep('high', 3, true)).toBeNull();
    expect(nextStep('low', 3, true)).toBeNull();
  });
});

describe('AutoQuality', () => {
  it('leaves quality alone at a healthy frame rate', () => {
    const changes: [QualityTier, number][] = [];
    const a = new AutoQuality('high', (t, s) => changes.push([t, s]));
    run(a, 60, 30);
    expect(changes).toEqual([]);
    expect(a.tier).toBe('high');
  });

  it('steps down only after a sustained slow window, never on a short dip', () => {
    const changes: [QualityTier, number][] = [];
    const a = new AutoQuality('high', (t, s) => changes.push([t, s]));
    run(a, 60, 2);
    run(a, 15, 1); // one slow second inside a 2.5 s window
    run(a, 60, 2);
    expect(changes).toEqual([]);
    run(a, 15, 4); // slow for a whole window
    expect(changes).toEqual([['high', 0.85]]);
  });

  it('walks down to a lower tier when frames stay slow, and never back up', () => {
    const a = new AutoQuality('high', () => {});
    run(a, 15, 60);
    expect(a.tier).toBe('mobile');
    run(a, 60, 30);
    expect(a.tier).toBe('mobile');
  });

  it('ignores long frames (tab switches)', () => {
    const changes: number[] = [];
    const a = new AutoQuality('high', (_t, s) => changes.push(s));
    for (let i = 0; i < 40; i++) a.frame(1);
    expect(changes).toEqual([]);
  });

  it('keeps a hand-picked tier and only lowers render scale', () => {
    const a = new AutoQuality('high', () => {});
    a.setTier('high', true);
    run(a, 15, 60);
    expect(a.tier).toBe('high');
    expect(a.renderScale).toBe(0.6);
  });

  it('may lower a restored tier that the game chose itself', () => {
    const a = new AutoQuality('high', () => {});
    a.setTier('low', false);
    run(a, 15, 60);
    expect(a.tier).toBe('mobile');
  });
});
