import { describe, expect, it } from 'vitest';
import { createWorld } from '../../world/surface';
import { Discoveries } from '../../world/discoveries';
import { FIND_KINDS, findName, findsText, isFindKind } from '../finds';

describe('finds', () => {
  it('knows its kinds, and nothing else', () => {
    for (const k of FIND_KINDS) expect(isFindKind(k)).toBe(true);
    for (const k of ['lamp', '', 'Temple', 3, null, undefined]) expect(isFindKind(k)).toBe(false);
    expect(new Set(FIND_KINDS).size).toBe(FIND_KINDS.length);
  });

  it('names every kind in plain words', () => {
    for (const k of FIND_KINDS) expect(findName(k)).toMatch(/^[A-Z][a-z ]+$/);
  });

  it('reads the count as a short line and in words', () => {
    expect(findsText(3)).toEqual({ text: `Discoveries 3 / ${FIND_KINDS.length}`, label: `Discoveries found: 3 of ${FIND_KINDS.length}` });
    expect(findsText(0, 4).text).toBe('Discoveries 0 / 4');
    expect(findsText(9, 4).text).toBe('Discoveries 4 / 4');
    expect(findsText(-1, 4).text).toBe('Discoveries 0 / 4');
  });

  it('covers every kind the desert places on its surface', () => {
    const world = createWorld(1);
    const disc = new Discoveries(world, {});
    const seen = new Set(disc.surfaceSitesNear(0, 0, 30000, []).map((s) => s.kind));
    expect(seen.size).toBeGreaterThan(5);
    for (const k of seen) expect(isFindKind(k)).toBe(true);
  });
});
