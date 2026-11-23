import { describe, expect, it } from 'vitest';
import { AutoQuality, nextStep, paceDivisor, type Pace, type QualityTier } from '../quality';

// Feeds frames at a steady rate for a number of seconds.
function run(a: AutoQuality, fps: number, seconds: number, work = 0.004): void {
  for (let t = 0; t < seconds; t += 1 / fps) a.frame(1 / fps, work);
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

describe('paceDivisor', () => {
  it('picks vsyncs per frame from the refresh rate', () => {
    expect(paceDivisor(1 / 60, 60)).toBe(1);
    expect(paceDivisor(1 / 60, 30)).toBe(2);
    expect(paceDivisor(1 / 120, 60)).toBe(2);
    expect(paceDivisor(1 / 120, 30)).toBe(4);
    expect(paceDivisor(1 / 90, 60)).toBe(1);
    expect(paceDivisor(1 / 90, 30)).toBe(3);
    expect(paceDivisor(1 / 144, 60)).toBe(2);
  });
});

type Change = [QualityTier, number, Pace];
function make(tier: QualityTier = 'high'): { a: AutoQuality; changes: Change[] } {
  const changes: Change[] = [];
  const a = new AutoQuality(tier, (t, s, p) => changes.push([t, s, p]));
  return { a, changes };
}

// Feeds slow frames (every one misses the 60 budget) until exactly one more change has happened.
function oneStepDown(a: AutoQuality, changes: Change[]): void {
  const n = changes.length;
  for (let i = 0; i < 2000 && changes.length === n; i++) a.frame(1 / 30, 0.004);
}

describe('AutoQuality', () => {
  it('leaves quality alone at a healthy frame rate', () => {
    const { a, changes } = make();
    run(a, 60, 30);
    expect(changes).toEqual([]);
    expect(a.tier).toBe('high');
    expect(a.pace).toBe(60);
  });

  it('steps down only after a sustained slow window, never on a short dip', () => {
    const { a, changes } = make();
    run(a, 60, 2);
    run(a, 30, 0.2); // a few slow frames inside a window: well under 10% of frames
    run(a, 60, 4);
    expect(changes).toEqual([]);
    run(a, 30, 5); // every frame misses the 60 budget
    expect(changes[0]).toEqual(['high', 0.85, 60]);
  });

  it('lowers scale at 60, then locks to 30, then lowers further and drops tiers', () => {
    const { a, changes } = make();
    run(a, 15, 60);
    expect(changes.slice(0, 5)).toEqual([
      ['high', 0.85, 60],
      ['high', 0.7, 60],
      ['high', 0.6, 60],
      ['high', 0.85, 30],
      ['high', 0.7, 30],
    ]);
    expect(a.tier).toBe('mobile');
    expect(a.pace).toBe(30);
  });

  it('holds an even 30 without further steps when 30 is met', () => {
    const { a, changes } = make();
    run(a, 30, 40); // misses 60 every frame, meets 30 once pace is 30
    expect(changes.map((c) => c[2])).toContain(30);
    const n = changes.length;
    run(a, 30, 25, 0.02); // work too heavy to try 60 again
    expect(changes.length).toBe(n);
    expect(a.pace).toBe(30);
  });

  it('judges the budget by the display: 120 Hz at pace 60 is every 2nd vsync', () => {
    const { a, changes } = make();
    a.setRefresh(1 / 120);
    run(a, 60, 30);
    expect(changes).toEqual([]);
    run(a, 30, 5);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('ignores long frames (tab switches)', () => {
    const { a, changes } = make();
    for (let i = 0; i < 40; i++) a.frame(1);
    expect(changes).toEqual([]);
  });

  it('keeps a hand-picked tier and only moves scale and pace', () => {
    const { a } = make();
    a.setTier('high', true);
    run(a, 10, 80);
    expect(a.tier).toBe('high');
    expect(a.renderScale).toBe(0.6);
    expect(a.pace).toBe(30);
  });

  it('may lower a restored tier that the game chose itself', () => {
    const { a } = make();
    a.setTier('low', false);
    run(a, 10, 80);
    expect(a.tier).toBe('mobile');
  });

  it('steps back up after a long good stretch with light work, undoing the last step', () => {
    const { a, changes } = make();
    oneStepDown(a, changes);
    const downs = changes.length;
    expect(a.renderScale).toBe(0.85);
    run(a, 60, 20, 0.003); // hold (30 s) not over yet
    expect(changes.length).toBe(downs);
    run(a, 60, 30, 0.003);
    expect(changes.length).toBeGreaterThan(downs);
    expect(a.renderScale).toBe(1);
  });

  it('does not step up when the frame work is heavy even if frames are on time', () => {
    const { a, changes } = make();
    oneStepDown(a, changes);
    const scale = a.renderScale;
    run(a, 60, 120, 0.012);
    expect(a.renderScale).toBe(scale);
  });

  it('backs off for minutes after a step up that fails', () => {
    const { a, changes } = make();
    oneStepDown(a, changes);
    const n0 = changes.length;
    for (let i = 0; i < 20000 && changes.length === n0; i++) a.frame(1 / 60, 0.003); // goes back up
    const up = changes.length;
    expect(a.renderScale).toBe(1);
    oneStepDown(a, changes); // the step up failed: down again
    expect(changes.length).toBe(up + 1);
    const after = changes.length;
    run(a, 60, 100, 0.003); // 100 s of good frames: still inside the 2 min back-off
    expect(changes.length).toBe(after);
    run(a, 60, 60, 0.003);
    expect(changes.length).toBeGreaterThan(after); // tries again
  });

  it('never moves a locked tier when stepping down or up', () => {
    const { a } = make();
    a.setTier('low', true);
    run(a, 10, 80);
    run(a, 60, 200, 0.003);
    expect(a.tier).toBe('low');
  });

  it('puts the pace back to 60 when pacing is turned off', () => {
    const { a } = make();
    run(a, 10, 40);
    expect(a.pace).toBe(30);
    a.setPaced(false);
    expect(a.pace).toBe(60);
  });
});
