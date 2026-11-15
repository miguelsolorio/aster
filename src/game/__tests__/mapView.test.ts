import { describe, expect, it } from 'vitest';
import { FIND_KINDS } from '../finds';
import { groundInk, placeName, type Ground } from '../mapView';

const flat: Ground = { lit: 0, rock: 0, salt: 0, green: 0, snow: 0, water: false, town: 0 };
const rgb = (v: number) => [v >> 16, (v >> 8) & 255, v & 255];
const sum = (v: number) => rgb(v).reduce((a, b) => a + b, 0);

describe('the map\'s wash', () => {
  it('gives each kind of ground its own colour', () => {
    const inks = [flat, { ...flat, rock: 1 }, { ...flat, salt: 1 }, { ...flat, snow: 1 }, { ...flat, green: 1 }, { ...flat, town: 1 }, { ...flat, water: true }].map(groundInk);
    expect(new Set(inks).size).toBe(inks.length);
  });

  it('paints water bluer than it is red, and snow nearly white', () => {
    const [r, , b] = rgb(groundInk({ ...flat, water: true }));
    expect(b).toBeGreaterThan(r);
    for (const ch of rgb(groundInk({ ...flat, snow: 1 }))) expect(ch).toBeGreaterThan(230);
  });

  it('lights the slopes that face north-west and shades the ones that face away', () => {
    expect(sum(groundInk({ ...flat, lit: 0.15 }))).toBeGreaterThan(sum(groundInk(flat)));
    expect(sum(groundInk({ ...flat, lit: -0.15 }))).toBeLessThan(sum(groundInk(flat)));
    // however steep, never to black or past white
    for (const lit of [-50, 50]) for (const ch of rgb(groundInk({ ...flat, lit }))) {
      expect(ch).toBeGreaterThan(100);
      expect(ch).toBeLessThanOrEqual(255);
    }
  });

  it('is not thrown by values out of range', () => {
    expect(groundInk({ ...flat, rock: 7 })).toBe(groundInk({ ...flat, rock: 1 }));
    expect(groundInk({ ...flat, salt: -3 })).toBe(groundInk(flat));
  });
});

describe('place names', () => {
  it('names every kind of find, and every kind of town', () => {
    for (const k of FIND_KINDS) expect(placeName(k)).toMatch(/^[A-Z]/);
    for (const k of ['hill', 'canyon', 'oasis', 'trade']) expect(placeName(`city:${k}`)).toMatch(/ town$/);
    expect(placeName('city:other')).toBe('Town');
    expect(placeName('nonsense')).toBe('');
  });
});
