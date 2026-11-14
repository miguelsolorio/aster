// Camps out in the open desert, away from any road or city: a fire, beasts kneeling, a few people.
// They sit on a fixed grid, one candidate per cell, decided by the cell alone so a camp is always
// where it was. A second, finer grid is switched on while the wanderer has no board yet, so that
// someone who gives one is never far to find.

/** Metres across a cell of the everyday grid, and of the finer one used before the first board. */
export const WILD_CELL = 1500;
export const EARLY_CELL = 800;
/** The share of cells that hold a camp. */
export const WILD_CHANCE = 0.55;
export const EARLY_CHANCE = 0.8;
/** The early camps are only kept within this of the player (m), so they never crowd the draw caps. */
export const EARLY_R = 1900;
/** Camps keep this far (m) clear of a city's walls. */
export const CITY_CLEAR = 300;

/** Where in its cell a camp is first tried, as fractions of the cell (0.2..0.8). */
export function wildAnchor(cx: number, cz: number, cell: number, h: (a: number, b: number, c: number, d: number) => number, seed: number): { x: number; z: number } {
  return {
    x: (cx + 0.2 + 0.6 * h(cx, cz, seed, 81)) * cell,
    z: (cz + 0.2 + 0.6 * h(cx, cz, seed, 82)) * cell,
  };
}

/** Whether the cell has a camp at all. */
export function wildWanted(cx: number, cz: number, chance: number, h: (a: number, b: number, c: number, d: number) => number, seed: number): boolean {
  return h(cx, cz, seed, 80) < chance;
}

/** Offsets tried from the anchor, nearest first, looking for level ground (m). */
export const WILD_TRIES: [number, number][] = [
  [0, 0], [60, 0], [-60, 0], [0, 60], [0, -60], [140, 100], [-140, -100], [140, -100], [-140, 100], [260, 0], [-260, 0], [0, 260], [0, -260],
];
