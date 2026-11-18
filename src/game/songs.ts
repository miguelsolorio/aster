// The songs the flute knows. The call comes with the flute; the others are learned from places:
// play the flute there and the place answers with a melody of its own, which the wanderer then
// has. Nobody says so. Each does one thing, somewhere that suits it.
//
// A tap on the flute plays whatever suits where the wanderer stands (see `suited`). Holding it
// opens a ring of the songs known, to choose one.

import type { FindKind } from './finds';

export type Song = 'call' | 'waking' | 'wind' | 'rain' | 'opening';

/** In the order they sit round the ring, clockwise from the top. */
export const SONGS: readonly Song[] = ['call', 'waking', 'wind', 'rain', 'opening'];

export const isSong = (s: unknown): s is Song => typeof s === 'string' && (SONGS as readonly string[]).includes(s);

/** What each is called in the ring. */
export const SONG_NAMES: Record<Song, string> = {
  call: 'The call',
  waking: 'Waking song',
  wind: 'Wind song',
  rain: 'Rain song',
  opening: 'Opening song',
};

/** The kind of place that teaches each song (the call is not taught: it comes with the flute). */
export const TEACHERS: Record<Exclude<Song, 'call'>, FindKind> = {
  // stones that have stood since before anyone: they know how to wake their own kind
  waking: 'standing-stones',
  // the wind has been playing an arch for as long as it has been an arch
  wind: 'arch',
  // a shell keeps the sound of water in it, out here where there is none
  rain: 'shell',
  // a cave gives back what is played into it, changed
  opening: 'cave',
};

/** The song a kind of place teaches, if it teaches one. */
export function taughtBy(kind: string): Exclude<Song, 'call'> | null {
  for (const s of Object.keys(TEACHERS) as Exclude<Song, 'call'>[]) if (TEACHERS[s] === kind) return s;
  return null;
}

/** How near (m) the wanderer must stand to a place for it to hear the flute and answer. */
export const TEACH_R = 45;
/** How near (m) to standing stones the waking song must be played to wake them. */
export const WAKE_R = 45;
/** How long (s) the wind song holds the air up behind whoever played it. */
export const WIND_SECONDS = 14;
/** How long (real seconds) a rain called by the song takes to arrive. */
export const RAIN_ARRIVES = 150;
/** In-game days before the rain song will bring another. */
export const RAIN_REST = 3;

/** What is true of where the wanderer stands, for choosing a song. */
export interface Standing {
  /** A place within TEACH_R that teaches a song not yet known. */
  teacher: Exclude<Song, 'call'> | null;
  /** Over a sealed cavern. */
  sealed: boolean;
  /** Among standing stones. */
  stones: boolean;
  /** In the air: gliding, or on a carpet. */
  aloft: boolean;
}

/**
 * The song a tap plays: the one that suits the place, of those known. Rain is never played this
 * way: it is too large a thing to happen by accident.
 */
export function suited(known: (s: Song) => boolean, at: Standing): Song {
  if (at.sealed && known('opening')) return 'opening';
  if (at.stones && known('waking')) return 'waking';
  if (at.aloft && known('wind')) return 'wind';
  return 'call';
}

/** Said the moment a place has answered and its song is known. */
export const LEARNED: Record<Exclude<Song, 'call'>, string> = {
  waking: 'The stones hum it back, lower. You have their song now. Play it to stones and they wake.',
  wind: 'The arch plays it back on the wind. You have its song now. Play it in the air.',
  rain: 'The shell gives it back, like water. You have its song now. Play it under an open sky.',
  opening: 'The cave returns it, changed. You have its song now. Play it where the sand is lit from under.',
};

/** Said when a song is played and nothing comes of it. */
export const NOTHING: Record<Song, string> = {
  call: '',
  waking: 'Nothing here to wake.',
  wind: 'The wind song wants air under you.',
  rain: 'The sky isn\'t ready to be asked again.',
  opening: 'Nothing here to open.',
};
