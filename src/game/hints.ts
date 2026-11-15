// What the wanderer is told on walking onto the lit sand over a sealed cavern: that there is
// a room under it, and what to do about that. Each cavern says its piece once a visit, and
// once more to someone who went away without a pick and has come back with one.

/** Which thing to say: no pick to dig with, a pick and nothing opened yet, or a pick that has done this before. */
export type CavernHint = 'noPick' | 'dig' | 'again';

export class CavernHints {
  private readonly told = new Set<string>();

  /**
   * The hint for the cavern at (x, z), or null if it has already given this one. Asking counts
   * as telling, so ask only when the line can be shown.
   */
  take(x: number, z: number, hasPick: boolean, openedAny: boolean): CavernHint | null {
    const hint: CavernHint = !hasPick ? 'noPick' : openedAny ? 'again' : 'dig';
    // (someone with a pick is past being told to fetch one, whichever of the two lines they get)
    const key = `${x},${z},${hasPick}`;
    if (this.told.has(key)) return null;
    this.told.add(key);
    return hint;
  }
}
