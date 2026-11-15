import { describe, expect, it } from 'vitest';
import { OFFERINGS, offeringAt, type Offering } from '../offerings';
import { TOOLS } from '../save';
import { flightSpeed } from '../player';

const key = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

describe('temple offerings', () => {
  it('are all tools, and leave the carpet to the caverns', () => {
    for (const t of OFFERINGS) expect(TOOLS).toContain(t);
    expect(OFFERINGS as readonly string[]).not.toContain('carpet');
  });

  it('gives nothing once a temple has given', () => {
    expect(offeringAt(key(3, 4), () => false, true)).toBeNull();
  });

  it('gives nothing to someone who has everything', () => {
    expect(offeringAt(key(3, 4), () => true, false)).toBeNull();
  });

  it('never offers a tool already in hand', () => {
    for (const owned of OFFERINGS) {
      for (let c = 0; c < 12; c++) expect(offeringAt(key(c, -c * 3), (t) => t === owned, false)).not.toBe(owned);
    }
  });

  it('starts different temples on different things', () => {
    const seen = new Set<Offering | null>();
    for (let c = -6; c < 6; c++) for (let d = -6; d < 6; d++) seen.add(offeringAt(key(c, d), () => false, false));
    expect(seen).toEqual(new Set(OFFERINGS));
  });

  it('can all be gathered, one from each temple visited', () => {
    const have = new Set<Offering>();
    let visits = 0;
    for (let c = 0; have.size < OFFERINGS.length && c < 50; c++) {
      const t = offeringAt(key(c, 7), (x) => have.has(x), false);
      expect(t).not.toBeNull();
      have.add(t!);
      visits++;
    }
    expect(visits).toBe(OFFERINGS.length);
  });
});

describe('the carpet', () => {
  it('flies faster than flying without one, gliding and boosted', () => {
    expect(flightSpeed(true, false)).toBeGreaterThan(flightSpeed(false, false) * 1.5);
    expect(flightSpeed(true, true)).toBeGreaterThan(flightSpeed(false, true) * 1.5);
  });
});
