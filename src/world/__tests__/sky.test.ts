import { describe, expect, it } from 'vitest';
import { COMET_EVERY, COMET_NIGHTS, CONSTELLATIONS, MONTH, SHOWER_EVERY, bloodMoon, comet, dayOf, eclipse, eclipsed, moonLit, moonPhase, nextLesson, nightOf, shower, starOf } from '../sky';

describe('the night a moment belongs to', () => {
  it('holds from dusk to dawn', () => {
    // dusk of day 3, and the small hours after its midnight
    expect(nightOf(3.8, 0.8)).toBe(4);
    expect(nightOf(4.1, 0.1)).toBe(4);
    expect(nightOf(4.6, 0.6)).toBe(5);
    expect(dayOf(4.6, 0.6)).toBe(4);
  });
});

describe('the moon', () => {
  it('goes round once a month and is near full on a new save', () => {
    expect(moonPhase(0)).toBe(moonPhase(MONTH));
    expect(moonLit(moonPhase(1))).toBeGreaterThan(0.8);
    expect(moonLit(0)).toBe(0);
    expect(moonLit(0.5)).toBe(1);
  });

  it('goes copper only at a full moon, one month in three', () => {
    const blood = Array.from({ length: MONTH * 6 }, (_, n) => n).filter(bloodMoon);
    expect(blood).toHaveLength(2);
    for (const n of blood) expect(moonPhase(n)).toBe(0.5);
  });
});

describe('what happens up there', () => {
  it('has a shower on the second night and every fifth after', () => {
    expect(shower(2)).toBe(true);
    expect(shower(3)).toBe(false);
    expect(shower(2 + SHOWER_EVERY)).toBe(true);
  });

  it('keeps a comet for a few nights running, then none', () => {
    const lit = Array.from({ length: COMET_EVERY }, (_, n) => comet(n)).filter((c) => c > 0);
    expect(lit).toHaveLength(COMET_NIGHTS);
  });

  it('eclipses the sun only near the hour, on its day, and wholly at the middle', () => {
    expect(eclipse(3.46, 0.46)).toBeCloseTo(0);
    expect(eclipsed(eclipse(3.46, 0.46))).toBe(1);
    expect(eclipse(3.2, 0.2)).toBeNull();
    expect(eclipse(4.46, 0.46)).toBeNull();
    const part = eclipsed(eclipse(3.43, 0.43));
    expect(part).toBeGreaterThan(0);
    expect(part).toBeLessThan(1);
  });
});

describe('the constellations', () => {
  it('are drawn from their own stars and sit on the unit sphere', () => {
    for (const c of CONSTELLATIONS) {
      for (const [a, b] of c.lines) {
        expect(a).toBeLessThan(c.stars.length);
        expect(b).toBeLessThan(c.stars.length);
      }
      for (let i = 0; i < c.stars.length; i++) expect(Math.hypot(...starOf(c, i))).toBeCloseTo(1);
    }
    expect(new Set(CONSTELLATIONS.map((c) => c.id)).size).toBe(CONSTELLATIONS.length);
  });

  it('are taught in order until there are none left', () => {
    expect(nextLesson([])?.id).toBe(CONSTELLATIONS[0].id);
    expect(nextLesson(['nail', CONSTELLATIONS[0].id])?.id).toBe(CONSTELLATIONS[1].id);
    expect(nextLesson(CONSTELLATIONS.map((c) => c.id))).toBeNull();
  });
});
