import { describe, expect, it } from 'vitest';
import { CavernHints } from '../hints';

describe('cavern hints', () => {
  it('sends someone with no pick to find one', () => {
    expect(new CavernHints().take(10, 20, false, false)).toBe('noPick');
    expect(new CavernHints().take(10, 20, false, true)).toBe('noPick');
  });

  it('says how to dig until a first cavern has been opened, and less after', () => {
    expect(new CavernHints().take(10, 20, true, false)).toBe('dig');
    expect(new CavernHints().take(10, 20, true, true)).toBe('again');
  });

  it('speaks once over each cavern', () => {
    const h = new CavernHints();
    expect(h.take(10, 20, true, false)).toBe('dig');
    expect(h.take(10, 20, true, false)).toBeNull();
    expect(h.take(10, 20, true, true)).toBeNull();
    expect(h.take(30, 20, true, true)).toBe('again');
  });

  it('speaks again to someone who comes back with a pick', () => {
    const h = new CavernHints();
    expect(h.take(10, 20, false, false)).toBe('noPick');
    expect(h.take(10, 20, false, false)).toBeNull();
    expect(h.take(10, 20, true, false)).toBe('dig');
    expect(h.take(10, 20, true, false)).toBeNull();
  });
});
