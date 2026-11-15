import { describe, expect, it } from 'vitest';
import { CLIMBER, FOUND, SNOWFOLK, VILLAGER, WATCHER, type Line } from '../lines';
import { TOOLS } from '../save';

const str = (l: Line) => (typeof l === 'string' ? l : l.keys);
const places = (l: Line) => [str(l).split('{way}').length - 1, str(l).split('{far}').length - 1];

describe('what the village people say', () => {
  it('names a way and a distance once in each errand, and once in each reminder', () => {
    for (const ask of [WATCHER.ask, CLIMBER.boots, CLIMBER.feather]) {
      expect(ask.map(places).reduce((a, b) => [a[0] + b[0], a[1] + b[1]])).toEqual([1, 1]);
    }
    for (const l of [WATCHER.pending, CLIMBER.bootsPending, CLIMBER.featherPending]) expect(places(l)).toEqual([1, 1]);
  });

  it('leaves no placeholder in a line that is said as it stands', () => {
    const plain = [...Object.values(VILLAGER), ...Object.values(SNOWFOLK), WATCHER.after, WATCHER.rope, WATCHER.night, CLIMBER.after].flat();
    expect(plain.length).toBeGreaterThan(30);
    for (const l of plain) expect(l).not.toMatch(/[{}]/);
  });

  it('has the same pools for the snow villages as for the foot villages, less the hours they do not keep', () => {
    for (const k of ['any', 'ask', 'night', 'boots', 'feather', 'child'] as const) {
      expect(VILLAGER[k].length).toBeGreaterThan(0);
      expect(SNOWFOLK[k].length).toBeGreaterThan(0);
    }
  });

  it('has something to say over each thing the climber sends you for', () => {
    for (const t of ['boots', 'feather'] as const) {
      expect(TOOLS).toContain(t);
      expect(str(FOUND[t]).length).toBeGreaterThan(10);
    }
  });
});
