import { describe, expect, it } from 'vitest';
import { SONGS, TEACHERS, suited, taughtBy, type Song, type Standing } from '../songs';

const at = (o: Partial<Standing> = {}): Standing => ({ teacher: null, sealed: false, stones: false, aloft: false, ...o });
const all = () => true;
const only = (...s: Song[]) => (x: Song) => x === 'call' || s.includes(x);

describe('suited', () => {
  it('plays the call where nothing suits', () => {
    expect(suited(all, at())).toBe('call');
  });

  it('opens over a sealed cavern before anything else', () => {
    expect(suited(all, at({ sealed: true, stones: true, aloft: true }))).toBe('opening');
  });

  it('wakes stones, then wind aloft', () => {
    expect(suited(all, at({ stones: true, aloft: true }))).toBe('waking');
    expect(suited(all, at({ aloft: true }))).toBe('wind');
  });

  it('only plays songs that are known', () => {
    expect(suited(only(), at({ sealed: true, stones: true, aloft: true }))).toBe('call');
    expect(suited(only('wind'), at({ sealed: true, stones: true, aloft: true }))).toBe('wind');
    expect(suited(only('waking'), at({ sealed: true, stones: true }))).toBe('waking');
  });

  it('never plays rain on a tap', () => {
    for (const sealed of [false, true])
      for (const stones of [false, true])
        for (const aloft of [false, true]) expect(suited(only('rain'), at({ sealed, stones, aloft }))).not.toBe('rain');
  });
});

describe('taughtBy', () => {
  it('maps each teaching kind back to its song', () => {
    for (const s of SONGS) if (s !== 'call') expect(taughtBy(TEACHERS[s])).toBe(s);
    expect(taughtBy('standing-stones')).toBe('waking');
    expect(taughtBy('arch')).toBe('wind');
    expect(taughtBy('shell')).toBe('rain');
    expect(taughtBy('cave')).toBe('opening');
  });

  it('teaches nothing elsewhere', () => {
    expect(taughtBy('cavern')).toBeNull();
    expect(taughtBy('')).toBeNull();
  });
});
