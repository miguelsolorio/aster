// The sky's calendar and its fixed stars. Everything here is worked out from the world clock
// and the time of day, so nothing about the sky is saved but what the wanderer has learned of it.
//
// The clock counts in-game days played; the time of day (0 midnight, 0.5 noon) runs beside it.
// A night is numbered by its midnight, so the number holds from dusk to dawn, and the moon's
// phase, a shower or a comet never change while you are looking at them.

/** Nights from one new moon to the next. Short, so a wanderer sees the moon change from night to night. */
export const MONTH = 8;
/** A shower falls on one night in this many. */
export const SHOWER_EVERY = 5;
/** A comet comes back after this many nights, and stays for COMET_NIGHTS. */
export const COMET_EVERY = 13;
export const COMET_NIGHTS = 3;
/** The sun is eclipsed on one day in this many. */
export const ECLIPSE_EVERY = 11;
/** The time of day at the middle of an eclipse, and how long before and after the moon is on the sun. */
export const ECLIPSE_AT = 0.46;
export const ECLIPSE_HALF = 0.055;

/** The number of the night this moment belongs to: the midnight just gone, or the one coming. */
export function nightOf(clock: number, day: number): number {
  return Math.round(clock - day) + (day >= 0.5 ? 1 : 0);
}

/** The number of the day this moment belongs to (the day begins at midnight). */
export function dayOf(clock: number, day: number): number {
  return Math.round(clock - day);
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** The moon's phase on a night: 0 new, 0.25 the first quarter, 0.5 full, 0.75 the last. A new save begins near full. */
export function moonPhase(night: number): number {
  return mod(night + 3, MONTH) / MONTH;
}

/** How much of the moon's face is lit, 0..1. */
export function moonLit(phase: number): number {
  return (1 - Math.cos(phase * Math.PI * 2)) / 2;
}

/** Whether the full moon of this night goes copper: every third full moon. */
export function bloodMoon(night: number): boolean {
  return moonPhase(night) === 0.5 && mod(Math.floor((night + 3) / MONTH), 3) === 1;
}

/** Whether meteors fall thick on this night. The second night of a new save is the first. */
export function shower(night: number): boolean {
  return mod(night, SHOWER_EVERY) === 2;
}

/** How bright the comet stands on this night, 0 when there is none: it grows, then goes. */
export function comet(night: number): number {
  const k = mod(night - 6, COMET_EVERY);
  if (k >= COMET_NIGHTS) return 0;
  return [0.55, 1, 0.6][k];
}

/**
 * The eclipse of the sun, if this is a day for one: how far the moon's disc stands from the
 * sun's, in sun radii along its path (0 is the middle of totality, beyond about 2.1 they are
 * apart), or null on any other day. The first is on the fourth day of a new save.
 */
export function eclipse(clock: number, day: number): number | null {
  if (mod(dayOf(clock, day), ECLIPSE_EVERY) !== 3) return null;
  const t = (day - ECLIPSE_AT) / ECLIPSE_HALF;
  if (Math.abs(t) > 1) return null;
  return t * 2.15;
}

/** How much of the sun an eclipse hides, 0..1, from the offset eclipse() gives. Total within a tenth of a radius. */
export function eclipsed(off: number | null): number {
  if (off === null) return 0;
  const a = Math.abs(off);
  if (a >= 2.05) return 0;
  if (a <= 0.12) return 1;
  const t = 1 - (a - 0.12) / (2.05 - 0.12);
  return t * t * (3 - 2 * t) * 0.97;
}

// ---------------------------------------------------------------- the fixed stars

/** One constellation: its stars as (x, y) degrees about its middle, the lines between them, and where it stands. */
export interface Constellation {
  id: string;
  name: string;
  /** Right ascension and declination of its middle, degrees, in the frame the stars turn in. */
  ra: number;
  dec: number;
  /** x to the east, y toward the pole, degrees; the third number is brightness 0..1. */
  stars: [number, number, number][];
  lines: [number, number][];
  /** What the keeper of a star house says when teaching it. */
  lesson: string;
}

export const CONSTELLATIONS: Constellation[] = [
  {
    id: 'well',
    name: 'The Well',
    ra: 0,
    dec: 34,
    stars: [[-4, -4, 0.8], [4, -4, 0.7], [4, 2, 0.9], [-4, 2, 0.75], [-4, 7.5, 0.6], [4, 7.5, 0.6]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [2, 5], [4, 5]],
    lesson: 'Four for the stones, two for the posts. That is the Well, and it never runs dry.',
  },
  {
    id: 'flute',
    name: 'The Flute',
    ra: 46,
    dec: 8,
    stars: [[-10, -2.5, 0.9], [-5, -1, 0.6], [-0.5, 0.2, 0.75], [4.5, 1, 0.6], [10, 3, 0.85]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
    lesson: 'Five in a row, a little bent. The Flute. The bright end is the one you blow.',
  },
  {
    id: 'caravan',
    name: 'The Caravan',
    ra: 92,
    dec: 48,
    stars: [[-10, 0, 0.7], [-7, 3.2, 0.85], [-4, 0, 0.6], [-1, 3.6, 0.9], [2, 0, 0.6], [5, 3, 0.8], [8.5, 0, 0.7]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]],
    lesson: 'Three humps, nose to tail. The Caravan walks round the Nail all night and never gets there.',
  },
  {
    id: 'oryx',
    name: 'The Oryx',
    ra: 138,
    dec: -4,
    stars: [[-5, 0, 0.7], [3, 0, 0.8], [4, 4, 0.75], [-4, 3, 0.6], [6.5, 6.5, 0.9], [9.5, 12.5, 0.7], [7, 13.5, 0.65], [-5, -5, 0.55], [3, -5, 0.55]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 0], [2, 4], [4, 5], [4, 6], [0, 7], [1, 8]],
    lesson: 'A box for the body, and two long stars for horns. The Oryx. It keeps low and to the south.',
  },
  {
    id: 'lantern',
    name: 'The Lantern',
    ra: 182,
    dec: 28,
    stars: [[0, -6, 0.7], [4.5, 0, 0.65], [0, 6, 0.7], [-4.5, 0, 0.65], [0, 10.5, 0.55], [0, 0, 1]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 0], [2, 4]],
    lesson: 'A diamond with a bright one burning inside it. The Lantern. Somebody hung it there.',
  },
  {
    id: 'ship',
    name: 'The Ship',
    ra: 226,
    dec: 4,
    stars: [[-8.5, 0.5, 0.7], [-4, -3, 0.75], [3, -3, 0.75], [8.5, 1, 0.8], [0, -3, 0.5], [0, 8.5, 0.9], [6, 2.5, 0.6]],
    lines: [[0, 1], [1, 4], [4, 2], [2, 3], [4, 5], [5, 6]],
    lesson: 'A hull, a mast and one sail. The Ship. Ask the storms where the rest of her went.',
  },
  {
    id: 'arch',
    name: 'The Arch',
    ra: 272,
    dec: 54,
    stars: [[-6, -5, 0.7], [-6, 2, 0.65], [-3, 7, 0.85], [3, 7, 0.85], [6, 2, 0.65], [6, -5, 0.7]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]],
    lesson: 'Up one side, over, and down the other. The Arch. The wind goes through it like the real ones.',
  },
  {
    id: 'wanderer',
    name: 'The Wanderer',
    ra: 316,
    dec: 18,
    stars: [[0, 9.5, 0.85], [0, 5, 0.6], [-4.5, -5.5, 0.75], [4.5, -5.5, 0.75], [7, 8, 0.65], [7, -6.5, 0.6]],
    lines: [[0, 1], [1, 2], [1, 3], [2, 3], [4, 5]],
    lesson: 'A head, a cloak, and a staff beside. The Wanderer. You will know that one.',
  },
];

/** The star the sky turns about. It does not move, and it stands in the north. */
export const NAIL = { name: 'The Nail', lesson: 'That one does not move. The Nail. Everything else is hung from it, and it stands in the north.' };

/** How high the pole stands over the northern horizon (radians). */
export const POLE_ALT = (38 * Math.PI) / 180;

/** A unit vector in the stars' own frame (the pole along +y) for right ascension and declination in degrees. */
export function starDir(ra: number, dec: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const a = (ra * Math.PI) / 180;
  const d = (dec * Math.PI) / 180;
  out[0] = Math.cos(d) * Math.cos(a);
  out[1] = Math.sin(d);
  out[2] = Math.cos(d) * Math.sin(a);
  return out;
}

/** Where a constellation's star stands in the stars' own frame: its (x, y) degrees laid on the sky about the middle. */
export function starOf(c: Constellation, i: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const [x, y] = c.stars[i];
  const cd = Math.max(0.2, Math.cos((c.dec * Math.PI) / 180));
  return starDir(c.ra + x / cd, c.dec + y, out);
}

/** How far the stars have turned, in radians: once a day, and a little further each night, so the sky of one season is not the next one's. */
export function skyTurn(clock: number, day: number): number {
  return (day + dayOf(clock, day) / 61) * Math.PI * 2;
}

/** The next constellation a keeper would teach someone who knows `known`, or null when they know them all. */
export function nextLesson(known: readonly string[]): Constellation | null {
  return CONSTELLATIONS.find((c) => !known.includes(c.id)) ?? null;
}
