// Aster audio: fully synthesised generative ambient score, wind and
// footsteps, built on the Web Audio API with no samples and no libraries.
//
// Signal flow
//   pads ──┐                          ┌─ dry ─────────────┐
//   plucks ┼─ buses ─ sends ─ reverb ─┤                    ├─ music ─┐
//   chime ─┘          └─ delay ───────┘                    │         │
//   wind / sand hiss ─────────────────────────────────────────────── preMaster
//   footsteps / landings ─────────────────────────────────────────── ┘
//   city near (murmur, voices, steps) ─ cityBus ─┬─ dry ───────────── preMaster
//   city far (murmur, bell, drum) ─ cityFarBus ──┴─ mostly → reverb
//   ambience (water, leaves, mill, fire, birds) ─ ambBus ─┬─ dry ──── preMaster
//                                                          └─ a little → reverb
//   deep (room tone, trickle, drips + echo) ─ deep bus ─┬─ dry ────── preMaster
//     built lazily underground, freed on the surface    └─ some → reverb
//   Two player-facing levels are applied at the buses, ahead of the sends: music (pads, plucks)
//   and effects (everything else, the chime included).
//   preMaster → high-shelf cut → pause low-pass → pause duck → limiter
//             → start fade → volume → visibility gain → speakers

import type { Song } from '../game/songs';

export interface AudioFrame {
  dt: number;
  day: number; // 0..1 fraction of day: 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset
  night: number; // 0 day .. 1 full night
  speed: number; // player horizontal speed m/s (on foot ~13, a board ~30 on the flat and more downhill)
  sliding: boolean;
  rock?: boolean; // sliding over rock, not sand: a lower, duller scrape
  grounded: boolean;
  gust: number; // 0..1 slow-varying wind strength
  altitude: number; // metres above the local base level, roughly 0..400
  storm?: number; // 0..1 how thick the sandstorm is at the listener (0 underground or sheltered); absent = 0
  stormAhead?: number; // 0..1 rises over the minute before a storm arrives, 1 once inside; absent = 0
  rain?: number; // 0..1 how hard it is raining on the listener (0 underground or sheltered); absent = 0
}

/** How close/loud each ambient source is for the listener right now, each 0..1. */
export interface AmbienceLevels {
  water: number;
  leaves: number;
  mill: number;
  fire: number;
  birds: number;
}

// ---------------------------------------------------------------- helpers

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const pickOne = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
/** Smallest value used for exponential ramps (they cannot reach 0). */
const EPS = 0.0001;

// ------------------------------------------------------------------ moods

type MoodName = 'day' | 'dusk' | 'night';
const MOOD_NAMES: readonly MoodName[] = ['day', 'dusk', 'night'];

interface Mood {
  /** Pad voicings in semitones relative to D3. */
  chords: readonly (readonly number[])[];
  /** Pluck scale in semitones above the tonic D. */
  scale: readonly number[];
  /** MIDI note of scale index 0 (always a D). */
  base: number;
  /** Allowed scale-index range for the pluck melody. */
  lo: number;
  hi: number;
  padLevel: number;
  padCutoff: number;
  pluckLevel: number;
  pluckAttack: number;
  /** Upper partial ratio and level for the plucks (octave or twelfth). */
  partial: number;
  partialGain: number;
  phraseChance: number;
  /** Multiplier on the 2..9 s gap between plucks. */
  gapScale: number;
}

const D3 = 50;

const MOODS: Record<MoodName, Mood> = {
  // Day: D lydian pads, major-pentatonic plucks, open and warm.
  day: {
    chords: [
      [0, 7, 14, 16], // D add9
      [-7, 4, 9, 14], // G maj7(9)
      [-3, 4, 7, 12], // B m7
      [4, 11, 14, 18], // F# m7(add11) over lydian colour (G#)
    ],
    scale: [0, 2, 4, 7, 9],
    base: 62,
    lo: 0,
    hi: 7,
    padLevel: 0.042,
    padCutoff: 1150,
    pluckLevel: 0.07,
    pluckAttack: 0.012,
    partial: 2,
    partialGain: 0.16,
    phraseChance: 0.3,
    gapScale: 1,
  },
  // Dawn and dusk: suspended, no thirds, tender.
  dusk: {
    chords: [
      [0, 7, 14, 17], // D sus (A E G)
      [-5, 2, 7, 9], // A sus2
      [-7, 0, 9, 14], // G 6/9 shape
    ],
    scale: [0, 2, 5, 7, 9],
    base: 62,
    lo: 0,
    hi: 6,
    padLevel: 0.04,
    padCutoff: 950,
    pluckLevel: 0.062,
    pluckAttack: 0.02,
    partial: 3,
    partialGain: 0.07,
    phraseChance: 0.25,
    gapScale: 1.15,
  },
  // Night: D dorian, lower, sparser, soft distant glass.
  night: {
    chords: [
      [-12, -5, 3, 14], // D m9
      [-14, -7, 2, 9], // C maj7
      [-5, 0, 7, 10], // A m11
    ],
    scale: [0, 3, 5, 7, 10],
    base: 50,
    lo: 3,
    hi: 9,
    padLevel: 0.036,
    padCutoff: 700,
    pluckLevel: 0.05,
    pluckAttack: 0.035,
    partial: 2.0,
    partialGain: 0.07,
    phraseChance: 0.15,
    gapScale: 1.5,
  },
};

/** Scale index → MIDI note, extending the scale across octaves. */
const scaleNote = (m: Mood, idx: number): number => {
  const n = m.scale.length;
  const oct = Math.floor(idx / n);
  return m.base + 12 * oct + m.scale[((idx % n) + n) % n];
};

// ------------------------------------------------------------ the flute

/** The flute's lowest D (MIDI): D5, an octave over the plucks' day register. */
const FLUTE_D = 74;

/**
 * The flute's phrases: [scale index, seconds] per note, slurred, in the current mode's
 * pentatonic from FLUTE_D (index 5 is the octave). Each lasts 2 to 2.6 s; the last note is held.
 */
const FLUTE_PHRASES: readonly (readonly (readonly [number, number])[])[] = [
  // up to the octave and held there: a call
  [[0, 0.26], [1, 0.26], [2, 0.3], [4, 0.46], [5, 1.0]],
  // a turn round the middle, settling down a step
  [[2, 0.3], [3, 0.3], [4, 0.5], [3, 0.3], [2, 0.92]],
  // from the top, down and back up
  [[5, 0.48], [4, 0.26], [2, 0.3], [3, 1.06]],
  // a little rise and fall, and home to the tonic
  [[4, 0.34], [3, 0.2], [2, 0.2], [3, 0.38], [1, 0.3], [0, 0.98]],
  // two leaps up, an answer below
  [[1, 0.26], [2, 0.26], [4, 0.62], [2, 0.28], [4, 0.94]],
];

/**
 * The learned songs: one fixed melody each, so they are known by ear. Same format as above;
 * negative indices go below the tonic. 2.4 to 3.6 s, last note held. A place answers with the
 * same notes an octave lower and a quarter slower (see `answer`).
 */
const SONG_PHRASES: Record<Exclude<Song, 'call'>, readonly (readonly [number, number])[]> = {
  // slow and low: three long notes climbing by step, a fourth held: something being roused
  waking: [[0, 0.8], [1, 0.8], [2, 0.8], [3, 1.0]],
  // quick and light, running up past the octave and hanging there
  wind: [[0, 0.18], [1, 0.18], [2, 0.18], [3, 0.18], [4, 0.18], [5, 0.2], [6, 0.22], [7, 1.4]],
  // falling drop by drop, one note dripping twice, ending low
  rain: [[5, 0.4], [4, 0.3], [4, 0.3], [3, 0.4], [3, 0.3], [1, 0.4], [0, 1.0]],
  // a question (a leap up), a breath (a very short low note), the leap again a step higher
  opening: [[0, 0.3], [3, 0.9], [-3, 0.14], [1, 0.3], [4, 1.4]],
};

// ------------------------------------------------------------- the graph

interface Graph {
  preMaster: GainNode;
  pauseLP: BiquadFilterNode;
  pauseGain: GainNode;
  fade: GainNode;
  volume: GainNode;
  hide: GainNode;
  music: GainNode;
  reverbIn: GainNode;
  padBus: GainNode;
  padRev: GainNode;
  pluckBus: GainNode;
  pluckDry: GainNode;
  pluckRev: GainNode;
  chimeBus: GainNode;
  sfxBus: GainNode;
  // The two player-facing levels. Each is applied at the buses, ahead of the shared reverb and
  // delay sends, so turning one down takes its tails with it and leaves the other's alone.
  musicBuses: GainNode[]; // pads, plucks, drone
  fxBuses: GainNode[]; // everything else: player sounds, ambience, city, chime
  windSrc: AudioBufferSourceNode;
  windBP: BiquadFilterNode;
  windGain: GainNode;
  whistleBP: BiquadFilterNode;
  whistleGain: GainNode;
  hissSrc: AudioBufferSourceNode;
  hissBP: BiquadFilterNode;
  hissGain: GainNode;
  stormRumbleGain: GainNode;
  stormRoarGain: GainNode;
  rainBed: GainNode; // soft rain on sand (high band), level node
  rainBody: GainNode; // low-mid body under it
  noise: AudioBuffer; // short mono noise for one-shots
  cityBus: GainNode; // close city sounds: some dry, some space
  cityFarBus: GainNode; // distant city sounds: mostly reverb
  ambBus: GainNode; // ambience one-shots and beds
  ambWater: GainNode;
  ambLeaves: GainNode;
  ambWhoosh: GainNode;
  ambRumble: GainNode;
  ambSources: AudioScheduledSourceNode[];
}

type MoodWeights = Record<MoodName, number>;

// ------------------------------------------------------------- city sound

/** Seconds between city scheduler ticks (events are placed with jitter inside each tick). */
const CITY_TICK = 0.25;

/** One formant band of the crowd murmur bed. */
interface CityBand {
  f1: BiquadFilterNode;
  f2: BiquadFilterNode;
  level: GainNode;
  lfoA: OscillatorNode;
  lfoB: OscillatorNode;
  wander: number;
  timer: number;
}

/** The continuous murmur bed, built lazily the first time a city is near. */
interface CityBed {
  bands: CityBand[];
  nearGain: GainNode;
  farGain: GainNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}

/** The underground bed, built lazily the first time the listener goes below and freed back on the surface. */
interface DeepBed {
  bus: GainNode; // carries the effects level; registered in Graph.fxBuses while the bed lives
  room: GainNode; // low stone-room rumble
  air: GainNode; // faint moving air band above it
  trickle: GainNode; // lapping / trickle bed, follows wet
  dripIn: GainNode; // one-shot drips enter here: dry + cross-fed echo
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}

/** Large warm bell: [ratio, relative level, relative decay]. Low partials sit on D and A. */
const BELL_PARTIALS: readonly (readonly [number, number, number])[] = [
  [0.5, 0.5, 1.0], // hum
  [1.0, 1.0, 0.75], // strike tone
  [1.5, 0.2, 0.45], // fifth
  [2.006, 0.32, 0.4], // slightly wide octave
  [2.66, 0.11, 0.22], // inharmonic upper partials, short
  [3.94, 0.06, 0.14],
  [5.4, 0.03, 0.08],
];

// ------------------------------------------------------------ the engine

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private g: Graph | null = null;
  private started = false;
  private disposed = false;
  private paused = false;
  private vol = 0.8;
  private musicVol = 1;
  private fxVol = 0.7;
  private previewing = false;

  // Smoothed mood weights (sum to 1) and whether they have been seeded.
  private w: MoodWeights = { day: 1, dusk: 0, night: 0 };
  private wReady = false;

  // Scheduler state, in AudioContext time.
  private nextPad = 0;
  private nextPluck = 0;
  private nextDrone = 0;
  private chordMood: MoodName = 'day';
  private chordIdx = -1;
  private melodyIdx = 3;

  // City: raw targets from setCity(), smoothed values used by the engine.
  private cityNearT = 0;
  private cityBustleT = 0;
  private cityPaved = false;
  private cityNear = 0;
  private cityBustle = 0;
  private cityNight = 0;
  private cityDay = 0.5;
  private bed: CityBed | null = null;
  private bedIdle = 0;
  private nextCityTick = 0;
  /** Time of the next bell or drum; 0 while not armed (away from any city). */
  private nextCityBell = 0;
  private duskBellDone = false;

  // Ambience: raw targets from setAmbience(), smoothed values used by the engine.
  private ambT: AmbienceLevels = { water: 0, leaves: 0, mill: 0, fire: 0, birds: 0 };
  private amb: AmbienceLevels = { water: 0, leaves: 0, mill: 0, fire: 0, birds: 0 };
  private ambGust = 0;
  // Sandstorm: smoothed levels (storm = thickness here, ahead = approach) and the music duck.
  private storm = 0;
  private stormAhead = 0;
  // Rain: smoothed level, and the next thunder time (0 while unarmed).
  private rain = 0;
  private nextThunder = 0;
  private musicDuck = 1;
  private ambNight = 0;
  private nextAmbTick = 0;
  private nextBird = 0;
  private nextCreak = 0;

  // Underground: raw targets from setDeep(), smoothed values used by the engine.
  private deepT = 0;
  private wetT = 0;
  private deep = 0;
  private wet = 0;
  private deepBed: DeepBed | null = null;
  private deepIdle = 0;
  /** Time of the next drip; 0 while not armed (on the surface). */
  private nextDrip = 0;

  private paramTimer = 0;
  private clock = 0;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onVisibility = (): void => this.handleVisibility();
  private readonly onGesture = (): void => this.unlock();

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
      // Kept for the engine's whole life: a phone can suspend the context again at any time
      // (a call, the app switcher), and only a gesture brings it back.
      for (const type of UNLOCK_EVENTS) window.addEventListener(type, this.onGesture, UNLOCK_OPTS);
    }
  }

  /**
   * Creates/resumes the context and fades in over ~4 s. Best called from a user gesture; when it
   * is not, the sound begins on the first one after it.
   */
  start(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      playThroughSilentSwitch();
      this.ctx = new Ctor();
      this.g = this.build(this.ctx);
    }
    const ctx = this.ctx;
    // Not awaited: outside a gesture a phone leaves this pending until unlock() gets one, and
    // the score must be set up by then. Nothing below plays while the context is suspended.
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    if (!this.started && this.g) {
      this.started = true;
      const now = ctx.currentTime;
      const fade = this.g.fade.gain;
      fade.cancelScheduledValues(now);
      fade.setValueAtTime(0, now);
      fade.linearRampToValueAtTime(1, now + 4);
      this.nextPad = now + 0.1;
      this.nextPluck = now + rand(4, 8);
      this.nextDrone = now + rand(20, 40);
    }
  }

  /**
   * Called on every real user gesture. Browsers only let a context run after one, and the game
   * can begin without one (the title card puts itself away), so this is what makes sound on a
   * phone. Does nothing while the context is running.
   */
  private unlock(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed || document.hidden || ctx.state === 'running') return;
    void ctx.resume().then(
      () => {
        if (this.ctx !== ctx || !this.g || document.hidden) return;
        this.g.hide.gain.setTargetAtTime(1, ctx.currentTime, 0.6);
      },
      () => undefined,
    );
  }

  setVolume(v: number): void {
    this.vol = clamp01(v);
    if (this.ctx && this.g) this.g.volume.gain.setTargetAtTime(this.vol, this.ctx.currentTime, 0.12);
  }

  /** Level of the score alone, 0..1. 1 is the mix as tuned. */
  setMusicVolume(v: number): void {
    this.musicVol = clamp01(v);
    this.applyBusLevel(this.g?.musicBuses, this.musicVol * this.musicDuck);
  }

  /** Level of everything that is not the score, 0..1. 1 is the mix as tuned. */
  setEffectsVolume(v: number): void {
    this.fxVol = clamp01(v);
    this.applyBusLevel(this.g?.fxBuses, this.fxVol);
  }

  private applyBusLevel(buses: GainNode[] | undefined, v: number): void {
    if (!this.ctx || !buses) return;
    for (const b of buses) b.gain.setTargetAtTime(v, this.ctx.currentTime, 0.06);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.applyDuck();
  }

  /**
   * While a level is being adjusted in the pause menu, lift the pause duck so the mix is heard
   * as it will sound in play.
   */
  setPreview(on: boolean): void {
    if (this.previewing === on) return;
    this.previewing = on;
    this.applyDuck();
  }

  private applyDuck(): void {
    if (!this.ctx || !this.g) return;
    const ducked = this.paused && !this.previewing;
    const now = this.ctx.currentTime;
    const tc = this.previewing ? 0.08 : 0.25;
    this.g.pauseGain.gain.setTargetAtTime(ducked ? 0.35 : 1, now, tc);
    this.g.pauseLP.frequency.setTargetAtTime(ducked ? 750 : 18000, now, tc);
  }

  /**
   * Call once per frame alongside update().
   * near: 0 far from any city .. 1 inside one (the game ramps this from about 900 m out to the city edge and on to the centre).
   * bustle: 0..1 how many people are close to the listener right now.
   * paved: true when the listener is walking on city streets or roofs.
   */
  setCity(near: number, bustle: number, paved: boolean): void {
    this.cityNearT = Number.isFinite(near) ? clamp01(near) : 0;
    this.cityBustleT = Number.isFinite(bustle) ? clamp01(bustle) : 0;
    this.cityPaved = !!paved;
  }

  /**
   * Quiet background sources, each 0..1 (already distance-weighted by the game).
   * water: trickling stream. leaves: rustling foliage (follows the wind gust). mill: creaking
   * wooden mill. fire: crackling camp fire. birds: sparse daytime calls (fade out at night).
   */
  setAmbience(a: AmbienceLevels): void {
    const v = (x: number): number => (Number.isFinite(x) ? clamp01(x) : 0);
    this.ambT = { water: v(a.water), leaves: v(a.leaves), mill: v(a.mill), fire: v(a.fire), birds: v(a.birds) };
  }

  /**
   * Call once per frame alongside update().
   * amount: 0 on the surface .. 1 fully underground (a very large cavern or a carved city).
   * wet: 0..1 how much open water is nearby down there.
   * Fades in a quiet stone room tone and sparse drips (more of them, plus a faint lapping bed, as
   * wet rises) and ducks what belongs to the open air: wind, leaves, birds, the mill and the far
   * city. Nothing runs for it while amount is 0.
   */
  setDeep(amount: number, wet: number): void {
    this.deepT = Number.isFinite(amount) ? clamp01(amount) : 0;
    this.wetT = Number.isFinite(wet) ? clamp01(wet) : 0;
  }

  /** Once per frame. Cheap: smoothing in JS, AudioParams touched at ~10 Hz. */
  update(f: AudioFrame): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || !this.started || ctx.state !== 'running') return;
    const dt = Math.min(Math.max(f.dt, 0), 0.25);
    this.clock += dt;

    // Mood weights from time of day, smoothed over about a minute.
    const target = moodTarget(f.day, f.night);
    if (!this.wReady) {
      this.w = target;
      this.wReady = true;
    } else {
      const k = 1 - Math.exp(-dt / 50);
      for (const m of MOOD_NAMES) this.w[m] += (target[m] - this.w[m]) * k;
    }

    // City presence, smoothed over a couple of seconds on top of the game's own ramp.
    // Underground, smoothed over about a second on top of the game's own ramp.
    this.deep += (this.deepT - this.deep) * (1 - Math.exp(-dt / 0.9));
    this.wet += (this.wetT - this.wet) * (1 - Math.exp(-dt / 1.5));
    if (this.deepT === 0 && this.deep < 1e-4) this.deep = 0;
    if (this.wetT === 0 && this.wet < 1e-4) this.wet = 0;

    // The far-off city does not carry through rock; people close by (bustle) still do.
    const cityNearT = this.cityNearT * (1 - 0.85 * this.deep);
    this.cityNear += (cityNearT - this.cityNear) * (1 - Math.exp(-dt / 1.5));
    this.cityBustle += (this.cityBustleT - this.cityBustle) * (1 - Math.exp(-dt / 2.5));
    if (cityNearT === 0 && this.cityNear < 1e-4) this.cityNear = 0;
    if (this.cityBustleT === 0 && this.cityBustle < 1e-4) this.cityBustle = 0;
    this.cityNight = clamp01(f.night);
    this.cityDay = f.day;

    // Ambience levels, smoothed over about half a second.
    const ka = 1 - Math.exp(-dt / 0.5);
    const at = this.ambT;
    const am = this.amb;
    am.water += (at.water - am.water) * ka;
    am.leaves += (at.leaves - am.leaves) * ka;
    am.mill += (at.mill - am.mill) * ka;
    am.fire += (at.fire - am.fire) * ka;
    am.birds += (at.birds - am.birds) * ka;
    if (at.water === 0 && am.water < 1e-4) am.water = 0;
    if (at.leaves === 0 && am.leaves < 1e-4) am.leaves = 0;
    if (at.mill === 0 && am.mill < 1e-4) am.mill = 0;
    if (at.fire === 0 && am.fire < 1e-4) am.fire = 0;
    if (at.birds === 0 && am.birds < 1e-4) am.birds = 0;
    this.ambGust = clamp01(f.gust);
    // Sandstorm: ease in and out over a few seconds (absent or bad values count as 0).
    const stT = Number.isFinite(f.storm) ? clamp01(f.storm as number) : 0;
    const ahT = Math.max(stT, Number.isFinite(f.stormAhead) ? clamp01(f.stormAhead as number) : 0);
    const ks = 1 - Math.exp(-dt / 1.8);
    this.storm += (stT - this.storm) * ks;
    this.stormAhead += (ahT - this.stormAhead) * ks;
    if (stT === 0 && this.storm < 1e-4) this.storm = 0;
    if (ahT === 0 && this.stormAhead < 1e-4) this.stormAhead = 0;
    // Rain: ease in and out over a few seconds.
    const rnT = Number.isFinite(f.rain) ? clamp01(f.rain as number) : 0;
    this.rain += (rnT - this.rain) * (1 - Math.exp(-dt / 2.5));
    if (rnT === 0 && this.rain < 1e-4) this.rain = 0;
    this.ambNight = clamp01(f.night);

    this.paramTimer += dt;
    if (this.paramTimer >= 0.1) {
      this.paramTimer = 0;
      this.applyParams(f, ctx.currentTime);
    }

    this.schedule(ctx.currentTime);
  }

  footstep(strength: number, onRock: boolean, paved = this.cityPaved): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const s = clamp01(strength);
    if (s <= 0.01) return;
    const t = ctx.currentTime + 0.005;
    if (paved) {
      // Stone or packed earth: a short bright tick with a small resonant body.
      this.stoneStep(t, s, 1, null, g.sfxBus);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.playbackRate.value = rand(0.85, 1.15);
    const filt = ctx.createBiquadFilter();
    const env = ctx.createGain();
    let att: number;
    let dec: number;
    let peak: number;
    if (onRock) {
      // Brighter, shorter tap.
      filt.type = 'bandpass';
      filt.frequency.value = rand(1300, 2100);
      filt.Q.value = 1.1;
      att = 0.004;
      dec = rand(0.04, 0.06);
      peak = 0.05 * s;
    } else {
      // Soft dry "pff" in sand.
      filt.type = 'lowpass';
      filt.frequency.value = rand(450, 750) * (0.8 + 0.4 * s);
      filt.Q.value = 0.4;
      att = 0.014;
      dec = rand(0.08, 0.13);
      peak = 0.07 * s;
    }
    env.gain.setValueAtTime(EPS, t);
    env.gain.exponentialRampToValueAtTime(Math.max(peak, 2 * EPS), t + att);
    env.gain.exponentialRampToValueAtTime(EPS, t + att + dec);
    src.connect(filt).connect(env).connect(g.sfxBus);
    const end = t + att + dec + 0.03;
    src.start(t, Math.random() * (g.noise.duration - 0.4));
    src.stop(end);
    src.onended = () => disconnectAll(src, filt, env);
  }

  /** The start of a climb: a soft swell of cloth catching air. */
  lift(): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.playbackRate.value = rand(0.7, 0.9);
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.value = 0.7;
    filt.frequency.setValueAtTime(rand(320, 420), t);
    filt.frequency.exponentialRampToValueAtTime(rand(900, 1200), t + 0.28);
    filt.frequency.exponentialRampToValueAtTime(500, t + 0.7);
    const env = ctx.createGain();
    env.gain.setValueAtTime(EPS, t);
    env.gain.exponentialRampToValueAtTime(0.06, t + 0.2);
    env.gain.exponentialRampToValueAtTime(EPS, t + 0.75);
    src.connect(filt).connect(env).connect(g.sfxBus);
    src.start(t, Math.random() * (g.noise.duration - 1));
    src.stop(t + 0.8);
    src.onended = () => disconnectAll(src, filt, env);
  }

  /** Someone speaking: a few soft syllables with no words in them, at the speaker's pitch. */
  murmur(pitch: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    let t = ctx.currentTime + 0.02;
    const count = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const f = pitch * rand(0.88, 1.14);
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * rand(0.9, 1.06), t + 0.11);
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.Q.value = 2.5;
      filt.frequency.value = rand(500, 1100);
      const env = ctx.createGain();
      env.gain.setValueAtTime(EPS, t);
      env.gain.exponentialRampToValueAtTime(0.05, t + 0.025);
      env.gain.exponentialRampToValueAtTime(EPS, t + 0.13);
      osc.connect(filt).connect(env).connect(g.sfxBus);
      osc.start(t);
      osc.stop(t + 0.15);
      osc.onended = () => disconnectAll(osc, filt, env);
      t += rand(0.09, 0.15);
    }
  }

  /** A fennec fox barking somewhere out in the dark: two or three thin, rising yips, quieter with distance (m). */
  yip(dist: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const level = 0.035 * Math.max(0.15, 1 - dist / 260);
    let t = ctx.currentTime + 0.05;
    const count = 2 + Math.floor(Math.random() * 2);
    const base = rand(900, 1150);
    for (let i = 0; i < count; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base * 0.75, t);
      osc.frequency.exponentialRampToValueAtTime(base * rand(1.2, 1.35), t + 0.07);
      osc.frequency.exponentialRampToValueAtTime(base * 0.9, t + 0.16);
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 3200 - Math.min(dist, 250) * 8;
      const env = ctx.createGain();
      env.gain.setValueAtTime(EPS, t);
      env.gain.exponentialRampToValueAtTime(level, t + 0.03);
      env.gain.exponentialRampToValueAtTime(EPS, t + 0.17);
      osc.connect(filt).connect(env).connect(g.chimeBus);
      osc.start(t);
      osc.stop(t + 0.2);
      osc.onended = () => disconnectAll(osc, filt, env);
      t += rand(0.22, 0.32);
    }
  }

  land(strength: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const s = clamp01(strength);
    if (s <= 0.01) return;
    const t = ctx.currentTime + 0.005;

    // Deep soft thump: a falling sine through a low-pass.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(rand(95, 115), t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.2);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(EPS, t);
    tg.gain.exponentialRampToValueAtTime(0.03 + 0.12 * s, t + 0.006);
    tg.gain.exponentialRampToValueAtTime(EPS, t + 0.45);
    osc.connect(lp).connect(tg).connect(g.sfxBus);
    osc.start(t);
    osc.stop(t + 0.5);
    osc.onended = () => disconnectAll(osc, lp, tg);

    // Sand spray hiss.
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.playbackRate.value = rand(0.9, 1.1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rand(1800, 2600);
    bp.Q.value = 0.6;
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.3, 0.3);
    const sg = ctx.createGain();
    const dec = 0.4 + 0.5 * s;
    sg.gain.setValueAtTime(EPS, t);
    sg.gain.exponentialRampToValueAtTime(0.008 + 0.04 * s, t + 0.03);
    sg.gain.exponentialRampToValueAtTime(EPS, t + 0.03 + dec);
    src.connect(bp).connect(pan).connect(sg).connect(g.sfxBus);
    src.start(t, Math.random() * (g.noise.duration - dec - 0.2));
    src.stop(t + dec + 0.08);
    src.onended = () => disconnectAll(src, bp, pan, sg);
  }

  /**
   * Water thrown up by a foot or a landing: a slap of noise that falls in pitch, a wash after
   * it, and a few drops falling back. 0.2 is a wading step, 1 a drop from the sky.
   */
  splash(strength: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const s = clamp01(strength);
    if (s <= 0.01) return;
    const t = ctx.currentTime + 0.005;
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.25, 0.25);
    pan.connect(g.sfxBus);

    // the slap
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.playbackRate.value = rand(0.9, 1.15);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(rand(2600, 3400), t);
    bp.frequency.exponentialRampToValueAtTime(rand(700, 950), t + 0.12 + 0.2 * s);
    const env = ctx.createGain();
    const dec = 0.12 + 0.4 * s;
    env.gain.setValueAtTime(EPS, t);
    env.gain.exponentialRampToValueAtTime(0.02 + 0.09 * s, t + 0.008);
    env.gain.exponentialRampToValueAtTime(EPS, t + 0.008 + dec);
    src.connect(bp).connect(env).connect(pan);
    src.start(t, Math.random() * (g.noise.duration - dec - 0.3));
    src.stop(t + dec + 0.06);

    // the wash: lower and slower, only for a real splash
    const nodes: AudioNode[] = [src, bp, env, pan];
    let last: AudioScheduledSourceNode = src;
    let end = t + dec + 0.06;
    if (s > 0.35) {
      const w = ctx.createBufferSource();
      w.buffer = g.noise;
      w.playbackRate.value = rand(0.6, 0.8);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = rand(900, 1300);
      const we = ctx.createGain();
      const wd = 0.35 + 0.6 * s;
      we.gain.setValueAtTime(EPS, t);
      we.gain.exponentialRampToValueAtTime(0.05 * s, t + 0.06);
      we.gain.exponentialRampToValueAtTime(EPS, t + 0.06 + wd);
      w.connect(lp).connect(we).connect(pan);
      w.start(t, Math.random() * (g.noise.duration - wd - 0.3));
      w.stop(t + wd + 0.1);
      nodes.push(w, lp, we);
      if (t + wd + 0.1 > end) {
        end = t + wd + 0.1;
        last = w;
      }
    }

    // drops falling back
    const drops = 1 + Math.round(s * 4 + Math.random());
    for (let i = 0; i < drops; i++) {
      const dt = t + 0.03 + Math.random() * (0.12 + 0.45 * s);
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f = rand(700, 1700);
      o.frequency.setValueAtTime(f, dt);
      o.frequency.exponentialRampToValueAtTime(f * rand(1.4, 1.9), dt + 0.06);
      const de = ctx.createGain();
      de.gain.setValueAtTime(0, dt);
      de.gain.linearRampToValueAtTime((0.006 + 0.014 * s) * rand(0.5, 1), dt + 0.008);
      de.gain.exponentialRampToValueAtTime(EPS, dt + 0.085);
      o.connect(de).connect(pan);
      o.start(dt);
      o.stop(dt + 0.1);
      nodes.push(o, de);
      if (dt + 0.1 > end) {
        end = dt + 0.1;
        last = o;
      }
    }
    last.onended = () => disconnectAll(...nodes);
  }

  /**
   * A foot on something hard that is not the ground: a stone, or old bone. Bone is dry and
   * hollow, a knock with a little ring in it; stone is the duller tap of rock underfoot.
   */
  knock(strength: number, bone: boolean): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const s = clamp01(strength);
    if (s <= 0.01) return;
    const t = ctx.currentTime + 0.005;
    // the contact itself
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.playbackRate.value = rand(0.9, 1.1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = bone ? rand(2400, 3200) : rand(1300, 1900);
    bp.Q.value = 1.2;
    const ce = ctx.createGain();
    ce.gain.setValueAtTime(EPS, t);
    ce.gain.exponentialRampToValueAtTime(Math.max(0.04 * s, 2 * EPS), t + 0.002);
    ce.gain.exponentialRampToValueAtTime(EPS, t + 0.002 + rand(0.02, 0.035));
    src.connect(bp).connect(ce).connect(g.sfxBus);
    src.start(t, Math.random() * (g.noise.duration - 0.4));
    src.stop(t + 0.08);
    // what it is made of: two partials that are not in tune with each other
    const nodes: AudioNode[] = [src, bp, ce];
    const base = bone ? rand(430, 560) : rand(150, 210);
    const ratios = bone ? [1, 1.68] : [1, 1.31];
    let last: OscillatorNode | null = null;
    for (let i = 0; i < ratios.length; i++) {
      const o = ctx.createOscillator();
      o.type = bone ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(base * ratios[i] * 1.06, t);
      o.frequency.exponentialRampToValueAtTime(base * ratios[i], t + 0.02);
      const e = ctx.createGain();
      const dec = (bone ? 0.11 : 0.07) / (1 + i * 0.6);
      e.gain.setValueAtTime(EPS, t);
      e.gain.exponentialRampToValueAtTime(Math.max((bone ? 0.03 : 0.035) * s / (1 + i), 2 * EPS), t + 0.003);
      e.gain.exponentialRampToValueAtTime(EPS, t + 0.003 + dec);
      o.connect(e).connect(g.sfxBus);
      o.start(t);
      o.stop(t + 0.2);
      nodes.push(o, e);
      last = o;
    }
    if (last) last.onended = () => disconnectAll(...nodes);
  }

  /** Coming down on stone or bone: the thump of a landing with no sand to soften it, and the knock of what you hit. */
  thud(strength: number, bone: boolean): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const s = clamp01(strength);
    if (s <= 0.01) return;
    const t = ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(rand(120, 140), t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(EPS, t);
    tg.gain.exponentialRampToValueAtTime(0.03 + 0.11 * s, t + 0.004);
    tg.gain.exponentialRampToValueAtTime(EPS, t + 0.25);
    osc.connect(tg).connect(g.sfxBus);
    osc.start(t);
    osc.stop(t + 0.3);
    osc.onended = () => disconnectAll(osc, tg);
    this.knock(0.5 + 0.5 * s, bone);
  }

  /**
   * The pick coming down. On sand it is a dull chop; on rock or stone a bright clink. Over a
   * hollow (0..1, how near the buried chamber is) the ground answers with a low, ringing boom
   * that lasts longer the closer you are.
   */
  strike(ground: 'sand' | 'rock', hollow: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.005;
    const h = clamp01(hollow);
    const nodes: AudioNode[] = [];
    // the bite of the point
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.playbackRate.value = rand(0.9, 1.1);
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = ground === 'rock' ? rand(2600, 3400) : rand(700, 1000);
    filt.Q.value = ground === 'rock' ? 1.6 : 0.7;
    const ne = ctx.createGain();
    ne.gain.setValueAtTime(EPS, t);
    ne.gain.exponentialRampToValueAtTime(ground === 'rock' ? 0.07 : 0.1, t + 0.003);
    ne.gain.exponentialRampToValueAtTime(EPS, t + (ground === 'rock' ? 0.05 : 0.11));
    src.connect(filt).connect(ne).connect(g.sfxBus);
    src.start(t, Math.random() * (g.noise.duration - 0.4));
    src.stop(t + 0.2);
    nodes.push(src, filt, ne);
    // what it lands in: iron ringing off stone, or a thump the sand swallows; a hollow sings on
    const parts: Array<[number, number, number, OscillatorType]> =
      ground === 'rock'
        ? [[rand(1700, 2000), 0.035, 0.16, 'triangle'], [rand(2900, 3300), 0.02, 0.1, 'sine']]
        : [[rand(95, 115), 0.12 * (1 - 0.4 * h), 0.09, 'sine']];
    if (h > 0.02) {
      const base = 74 - 16 * h + rand(-2, 2);
      parts.push([base, 0.05 + 0.2 * h, 0.25 + 0.9 * h, 'sine'], [base * 1.52, 0.02 + 0.08 * h, 0.18 + 0.5 * h, 'sine'], [base * 2.7, 0.03 * h, 0.12 + 0.3 * h, 'triangle']);
    }
    let last: OscillatorNode | null = null;
    let longest = 0;
    for (const [freq, level, dec, type] of parts) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq * 1.25, t);
      o.frequency.exponentialRampToValueAtTime(freq, t + 0.03);
      const e = ctx.createGain();
      e.gain.setValueAtTime(EPS, t);
      e.gain.exponentialRampToValueAtTime(Math.max(level, 2 * EPS), t + 0.006);
      e.gain.exponentialRampToValueAtTime(EPS, t + 0.006 + dec);
      o.connect(e).connect(g.sfxBus);
      o.start(t);
      o.stop(t + dec + 0.08);
      nodes.push(o, e);
      if (dec >= longest) {
        longest = dec;
        last = o;
      }
    }
    if (last) last.onended = () => disconnectAll(...nodes);
  }

  /** The crust over a hollow giving way a little more: dry snaps, more of them and lower each time (level 1..3). */
  crack(level: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const n = 2 + Math.round(level) * 2;
    let t = ctx.currentTime + 0.06;
    for (let i = 0; i < n; i++) {
      const src = ctx.createBufferSource();
      src.buffer = g.noise;
      src.playbackRate.value = rand(0.7, 1.3);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = rand(1400, 3600) / (1 + 0.25 * level);
      bp.Q.value = 2.2;
      const e = ctx.createGain();
      e.gain.setValueAtTime(EPS, t);
      e.gain.exponentialRampToValueAtTime(rand(0.04, 0.08) * (0.7 + 0.2 * level), t + 0.002);
      e.gain.exponentialRampToValueAtTime(EPS, t + rand(0.03, 0.07));
      src.connect(bp).connect(e).connect(g.sfxBus);
      src.start(t, Math.random() * (g.noise.duration - 0.4));
      src.stop(t + 0.12);
      src.onended = () => disconnectAll(src, bp, e);
      t += rand(0.03, 0.14);
    }
    // the slab settling
    const o = ctx.createOscillator();
    o.type = 'sine';
    const t0 = ctx.currentTime + 0.05;
    o.frequency.setValueAtTime(58 - 4 * level, t0);
    o.frequency.exponentialRampToValueAtTime(38, t0 + 0.5);
    const oe = ctx.createGain();
    oe.gain.setValueAtTime(EPS, t0);
    oe.gain.exponentialRampToValueAtTime(0.05 + 0.04 * level, t0 + 0.03);
    oe.gain.exponentialRampToValueAtTime(EPS, t0 + 0.55);
    o.connect(oe).connect(g.sfxBus);
    o.start(t0);
    o.stop(t0 + 0.6);
    o.onended = () => disconnectAll(o, oe);
  }

  /** Sand pouring away into a hollow for `sec` seconds: a long hiss over a rumble, rising and then running out. */
  drain(sec: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.01;
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'bandpass';
    lp.Q.value = 0.5;
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1500, t + sec * 0.5);
    lp.frequency.linearRampToValueAtTime(700, t + sec);
    const e = ctx.createGain();
    e.gain.setValueAtTime(EPS, t);
    e.gain.exponentialRampToValueAtTime(0.11, t + sec * 0.25);
    e.gain.setValueAtTime(0.11, t + sec * 0.6);
    e.gain.exponentialRampToValueAtTime(EPS, t + sec + 0.6);
    src.connect(lp).connect(e).connect(g.sfxBus);
    src.start(t, Math.random() * (g.noise.duration - 0.4));
    src.stop(t + sec + 0.7);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(46, t);
    o.frequency.linearRampToValueAtTime(34, t + sec);
    const oe = ctx.createGain();
    oe.gain.setValueAtTime(EPS, t);
    oe.gain.exponentialRampToValueAtTime(0.16, t + 0.3);
    oe.gain.setValueAtTime(0.16, t + sec * 0.5);
    oe.gain.exponentialRampToValueAtTime(EPS, t + sec + 0.3);
    o.connect(oe).connect(g.sfxBus);
    o.start(t);
    o.stop(t + sec + 0.4);
    src.onended = () => disconnectAll(src, lp, e, o, oe);
  }

  /** A soft rising figure of three or four bell notes in the current mode. */
  chime(kind?: 'learned' | 'woke' | 'opened'): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const mood = MOODS[this.dominantMood()];
    if (kind) {
      // a short quiet confirmation, on the same soft bell, under a second
      const lift = 12 * Math.round((FLUTE_D - mood.base) / 12);
      const figure = { learned: [2, 4, 5], woke: [-3, 0], opened: [1, 3, 4] }[kind];
      let t = ctx.currentTime + 0.05;
      for (const idx of figure) {
        this.bell(t, midiHz(scaleNote(mood, idx) + lift), mood.pluckLevel * 0.7, 0.75, mood, g.chimeBus, rand(-0.2, 0.2));
        t += 0.16;
      }
      return;
    }
    const count = Math.random() < 0.5 ? 3 : 4;
    let idx = Math.max(mood.lo, Math.min(mood.hi - 3, this.melodyIdx - 1));
    let t = ctx.currentTime + 0.05;
    for (let i = 0; i < count; i++) {
      const level = mood.pluckLevel * 1.1 * (1 - i * 0.08);
      this.bell(t, midiHz(scaleNote(mood, idx)), level, rand(5.5, 7.5), mood, g.chimeBus, rand(-0.35, 0.35));
      idx += Math.random() < 0.65 ? 1 : 2;
      t += rand(0.26, 0.38);
    }
  }

  /**
   * A place playing a song's melody back, once, starting about half a second from now (call it as
   * the wanderer's own phrase ends): the same notes an octave lower and a quarter slower, in the
   * voice of the place: standing stones hum, an arch breathes, a shell drips, a cave echoes.
   * Returns the seconds until it is over. Before audio has started it plays nothing and still
   * returns the time.
   */
  answer(song: Exclude<Song, 'call'>): number {
    const phrase = SONG_PHRASES[song];
    const slow = 1.25;
    let len = 0;
    for (const [, d] of phrase) len += d * slow;
    const tail = { waking: 2.2, wind: 1.2, rain: 1.6, opening: 1.4 }[song];
    const total = 0.5 + len + tail;
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return total;
    const mood = MOODS[this.dominantMood()];
    const lift = 12 * Math.round((FLUTE_D - mood.base) / 12) - 12;
    const t0 = ctx.currentTime + 0.5;
    const stop = t0 + total;
    const nodes: AudioNode[] = [];
    const srcs: (OscillatorNode | AudioBufferSourceNode)[] = [];
    const osc = (type: OscillatorType, f: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      srcs.push(o);
      nodes.push(o);
      return o;
    };
    const gn = (v: number): GainNode => {
      const n = ctx.createGain();
      n.gain.value = v;
      nodes.push(n);
      return n;
    };
    const filt = (type: BiquadFilterType, f: number, q: number): BiquadFilterNode => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      nodes.push(n);
      return n;
    };
    const noise = (): AudioBufferSourceNode => {
      const n = ctx.createBufferSource();
      n.buffer = g.noise;
      n.loop = true;
      srcs.push(n);
      nodes.push(n);
      return n;
    };
    const delay = (sec: number): DelayNode => {
      const n = ctx.createDelay(2);
      n.delayTime.value = sec;
      nodes.push(n);
      return n;
    };
    const room = gn(0.3);
    room.connect(g.chimeBus);
    const out = gn(1);
    out.connect(g.sfxBus);
    out.connect(room);
    // each note's pitch, start time and length (slowed)
    const notes: { f: number; t: number; d: number }[] = [];
    let at = t0;
    for (const [idx, d] of phrase) {
      notes.push({ f: midiHz(scaleNote(mood, idx) + lift), t: at, d: d * slow });
      at += d * slow;
    }

    if (song === 'waking') {
      // a low hum: a slightly detuned pair that beats, a little triangle, slow to rise, long to ring
      for (const { f, t, d } of notes) {
        const env = gn(0);
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(0.045, t + 0.45);
        env.gain.setTargetAtTime(0, t + Math.max(0.5, d * 0.7), 0.7);
        osc('sine', f).connect(env);
        osc('sine', f * 1.005).connect(env);
        osc('triangle', f * 0.998).connect(gn(0.3)).connect(env);
        env.connect(out);
      }
    } else if (song === 'wind') {
      // breath, not tone: noise swept to each pitch, a soft whistle under it
      const bp = filt('bandpass', notes[0].f, 14);
      const na = gn(0);
      const wh = osc('sine', notes[0].f);
      const wa = gn(0);
      noise().connect(bp).connect(na).connect(out);
      wh.connect(wa).connect(out);
      let prev = notes[0].f;
      notes.forEach(({ f, t, d }, i) => {
        const glide = i === 0 ? 0.05 : 0.12;
        bp.frequency.setValueAtTime(prev, t);
        bp.frequency.exponentialRampToValueAtTime(f, t + glide);
        wh.frequency.setValueAtTime(prev, t);
        wh.frequency.exponentialRampToValueAtTime(f, t + glide);
        na.gain.setTargetAtTime(0.5, t, 0.08);
        wa.gain.setTargetAtTime(0.012, t, 0.1);
        if (i === notes.length - 1) {
          na.gain.setTargetAtTime(0, t + d * 0.5, 0.35);
          wa.gain.setTargetAtTime(0, t + d * 0.5, 0.35);
        }
        prev = f;
      });
    } else if (song === 'rain') {
      // hollow and watery: a pitch that droops, a wash of noise, a couple of delayed copies
      const dry = gn(1);
      dry.connect(out);
      for (const [dt, lv] of [[0.19, 0.4], [0.37, 0.22]]) dry.connect(delay(dt)).connect(gn(lv)).connect(filt('lowpass', 1400, 0.5)).connect(out);
      for (const { f, t, d } of notes) {
        const o = osc('sine', f * 1.14);
        o.frequency.setValueAtTime(f * 1.14, t);
        o.frequency.exponentialRampToValueAtTime(f, t + 0.14);
        const env = gn(0);
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(0.05, t + 0.012);
        env.gain.setTargetAtTime(0, t + 0.03, Math.max(0.12, d * 0.3));
        o.connect(env).connect(dry);
        const ne = gn(0);
        ne.gain.setValueAtTime(0, t);
        ne.gain.linearRampToValueAtTime(0.1, t + 0.015);
        ne.gain.setTargetAtTime(0, t + 0.02, 0.05);
        noise().connect(filt('bandpass', f * 3, 1.8)).connect(ne).connect(dry);
      }
    } else {
      // the flute's own voice, far off: rounded off, with a few quieter echoes behind it
      const wave = ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0, 0]), new Float32Array([0, 1, 0.2, 0.07, 0.025]));
      const dry = gn(1);
      const lp = filt('lowpass', 900, 0.5);
      dry.connect(lp).connect(out);
      for (const [dt, lv] of [[0.3, 0.45], [0.6, 0.25], [0.9, 0.12]]) lp.connect(delay(dt)).connect(gn(lv)).connect(out);
      for (const { f, t, d } of notes) {
        const o = osc('sine', f);
        o.setPeriodicWave(wave);
        const env = gn(0);
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(0.04, t + 0.12);
        env.gain.setTargetAtTime(0, t + Math.max(0.15, d - 0.2), 0.12);
        o.connect(env).connect(dry);
      }
    }

    for (const s of srcs) {
      s.start(t0);
      s.stop(stop);
    }
    srcs[0].onended = () => disconnectAll(...nodes);
    return total;
  }

  private rodHum: { amp: GainNode; trem: OscillatorNode; depth: GainNode; tone: OscillatorNode } | null = null;
  /**
   * The dowsing rod's pull, 0..1, called every frame: a low hum felt more than heard, that
   * rises a little and beats faster as the fork is drawn down. Silent at 0.
   */
  dowse(level: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    let h = this.rodHum;
    if (!h) {
      if (level <= 0.01) return;
      const tone = ctx.createOscillator();
      tone.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.35, 0.12])));
      const amp = ctx.createGain();
      amp.gain.value = 0;
      // the beat: the level rides up and down under a slow wobble
      const beat = ctx.createGain();
      beat.gain.value = 0.7;
      const trem = ctx.createOscillator();
      const depth = ctx.createGain();
      depth.gain.value = 0.3;
      trem.connect(depth).connect(beat.gain);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 520;
      tone.connect(beat).connect(lp).connect(amp).connect(g.sfxBus);
      tone.start();
      trem.start();
      h = this.rodHum = { amp, trem, depth, tone };
    }
    const l = Math.min(1, Math.max(0, level));
    const t = ctx.currentTime;
    h.amp.gain.setTargetAtTime(l <= 0.01 ? 0 : 0.012 + 0.05 * l * l, t, 0.15);
    h.tone.frequency.setTargetAtTime(98 + 49 * l, t, 0.25);
    h.trem.frequency.setTargetAtTime(1.2 + 9 * l * l, t, 0.2);
  }

  /**
   * A short phrase on a reed flute, played by the wanderer: four to six slurred notes, breathy,
   * in the current mode's pentatonic an octave over the plucks, never the same phrase twice
   * running. A learned song plays its one fixed melody instead. Returns how long it lasts (s). Before audio has started it plays nothing and still
   * returns the length.
   */
  flute(song: Song = 'call'): number {
    let phrase: readonly (readonly [number, number])[];
    if (song !== 'call') phrase = SONG_PHRASES[song];
    else {
      let k: number;
      if (this.lastFlute < 0) k = Math.floor(Math.random() * FLUTE_PHRASES.length);
      else {
        k = Math.floor(Math.random() * (FLUTE_PHRASES.length - 1));
        if (k >= this.lastFlute) k++;
      }
      this.lastFlute = k;
      phrase = FLUTE_PHRASES[k];
    }
    let len = 0;
    for (const [, d] of phrase) len += d;
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return len;
    const mood = MOODS[this.dominantMood()];
    // from D5 up whatever the mode's own register: a flute sits over the plucks and the chime
    const lift = 12 * Math.round((FLUTE_D - mood.base) / 12);
    const note = (idx: number): number => midiHz(scaleNote(mood, idx) + lift);
    const t0 = ctx.currentTime + 0.04;
    const end = t0 + len;
    const peak = 0.05;

    // the tone: a soft fundamental with a little of the octave and twelfth, rounded off
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0, 0]), new Float32Array([0, 1, 0.2, 0.07, 0.025])));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    lp.Q.value = 0.3;
    const amp = ctx.createGain();
    // vibrato, eased in on each note so only the held ones waver
    const vib = ctx.createOscillator();
    vib.frequency.value = rand(4.6, 5.4);
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 0;
    vib.connect(vibDepth).connect(osc.detune);
    // breath: noise in a band round each note, and a softer airy hiss over it
    const air = ctx.createBufferSource();
    air.buffer = g.noise;
    air.loop = true;
    const airBP = ctx.createBiquadFilter();
    airBP.type = 'bandpass';
    airBP.Q.value = 1.6;
    const airHP = ctx.createBiquadFilter();
    airHP.type = 'highpass';
    airHP.frequency.value = 3200;
    const airHG = ctx.createGain();
    airHG.gain.value = 0.15;
    const airAmp = ctx.createGain();
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.08, 0.08);
    const space = ctx.createGain();
    space.gain.value = 0.3;

    osc.connect(lp).connect(amp).connect(pan);
    air.connect(airBP).connect(airAmp);
    air.connect(airHP).connect(airHG).connect(airAmp);
    airAmp.connect(pan);
    pan.connect(g.sfxBus);
    pan.connect(space).connect(g.chimeBus); // a little of the chime's room round it

    let t = t0;
    let prev = 0;
    amp.gain.setValueAtTime(0, t0);
    airAmp.gain.setValueAtTime(0, t0);
    for (let i = 0; i < phrase.length; i++) {
      const [idx, d] = phrase[i];
      const f = note(idx) * Math.pow(2, rand(-4, 4) / 1200);
      const last = i === phrase.length - 1;
      const lvl = peak * (last ? 0.92 : rand(0.85, 1)) * Math.min(1.1, Math.pow(700 / f, 0.25));
      if (i === 0) {
        // a soft start, scooped up from a little flat
        osc.frequency.setValueAtTime(f * 0.97, t);
        osc.frequency.exponentialRampToValueAtTime(f, t + 0.09);
        amp.gain.linearRampToValueAtTime(lvl, t + 0.11);
      } else {
        // slurred: a quick glide and a small dip, as a finger lifts
        osc.frequency.setValueAtTime(prev, t);
        osc.frequency.exponentialRampToValueAtTime(f, t + 0.035);
        amp.gain.setTargetAtTime(lvl * 0.6, t - 0.02, 0.012);
        amp.gain.setTargetAtTime(lvl, t + 0.025, 0.03);
      }
      airBP.frequency.setValueAtTime(f * 1.5, t);
      // a puff of breath at each note's start, settling to a thread under it
      const breath = lvl * (i === 0 ? 0.9 : 0.55);
      airAmp.gain.setTargetAtTime(breath, t - 0.01, 0.012);
      airAmp.gain.setTargetAtTime(lvl * 0.22, t + 0.05, 0.06);
      vibDepth.gain.setValueAtTime(0, t);
      if (d > 0.35) vibDepth.gain.linearRampToValueAtTime(rand(9, 14), t + Math.min(d, 0.9) * 0.85);
      if (last) {
        // swell a touch, then let the breath go
        amp.gain.setTargetAtTime(lvl * 1.06, t + 0.08, d * 0.3);
        amp.gain.setTargetAtTime(0, end - 0.32, 0.09);
        airAmp.gain.setTargetAtTime(0, end - 0.3, 0.07);
      }
      prev = f;
      t += d;
    }
    const stop = end + 0.5;
    for (const s of [osc, vib, air]) {
      s.start(t0);
      s.stop(stop);
    }
    osc.onended = () => disconnectAll(osc, lp, amp, vib, vibDepth, air, airBP, airHP, airHG, airAmp, pan, space);
    return len;
  }
  private lastFlute = -1;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      for (const type of UNLOCK_EVENTS) window.removeEventListener(type, this.onGesture, UNLOCK_OPTS);
    }
    if (this.hideTimer) clearTimeout(this.hideTimer);
    const ctx = this.ctx;
    const g = this.g;
    if (g) {
      try {
        g.windSrc.stop();
        g.hissSrc.stop();
        for (const s of g.ambSources) s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.teardownBed();
    this.teardownDeep();
    this.ctx = null;
    this.g = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  // ------------------------------------------------------------ building

  private build(ctx: AudioContext): Graph {
    const gain = (v: number): GainNode => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };

    // Master chain.
    const preMaster = gain(1);
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 3800;
    shelf.gain.value = -7;
    const pauseLP = ctx.createBiquadFilter();
    pauseLP.type = 'lowpass';
    pauseLP.frequency.value = this.paused ? 750 : 18000;
    pauseLP.Q.value = 0.5;
    const pauseGain = gain(this.paused ? 0.35 : 1);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.3;
    const fade = gain(0);
    const volume = gain(this.vol);
    const hide = gain(1);
    preMaster.connect(shelf).connect(pauseLP).connect(pauseGain).connect(limiter);
    limiter.connect(fade).connect(volume).connect(hide).connect(ctx.destination);

    // Music bus, reverb and delay.
    const music = gain(0.75);
    music.connect(preMaster);
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, 5.2);
    const reverbIn = gain(1);
    const reverbOut = gain(0.85);
    reverbIn.connect(reverb).connect(reverbOut).connect(music);

    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.62;
    const fb = gain(0.38);
    const fbLP = ctx.createBiquadFilter();
    fbLP.type = 'lowpass';
    fbLP.frequency.value = 1900;
    const delayIn = gain(1);
    const delayOut = gain(0.5);
    delayIn.connect(delay);
    delay.connect(fbLP).connect(fb).connect(delay);
    fbLP.connect(delayOut);
    delayOut.connect(music);
    delayOut.connect(gain(0.5)).connect(reverbIn);

    // Pads.
    const padBus = gain(this.musicVol);
    const padRev = gain(0.45);
    padBus.connect(music);
    padBus.connect(padRev).connect(reverbIn);

    // Plucks.
    const pluckBus = gain(this.musicVol);
    const pluckDry = gain(0.7);
    const pluckRev = gain(0.5);
    const pluckDelay = gain(0.35);
    pluckBus.connect(pluckDry).connect(music);
    pluckBus.connect(pluckRev).connect(reverbIn);
    pluckBus.connect(pluckDelay).connect(delayIn);

    // Chime: mostly reverb. Voiced like the score but it answers the player, so it follows the
    // effects level.
    const chimeBus = gain(this.fxVol);
    chimeBus.connect(gain(0.55)).connect(music);
    chimeBus.connect(gain(0.95)).connect(reverbIn);
    chimeBus.connect(gain(0.3)).connect(delayIn);

    // Footsteps and landings: mostly dry, a touch of space.
    const sfxBus = gain(this.fxVol);
    sfxBus.connect(preMaster);
    sfxBus.connect(gain(0.08)).connect(reverbIn);

    // City: near sounds partly dry; distant sounds mostly reverb (heard across rooftops).
    const cityBus = gain(this.fxVol);
    cityBus.connect(gain(0.6)).connect(preMaster);
    cityBus.connect(gain(0.4)).connect(reverbIn);
    const cityFarBus = gain(this.fxVol);
    cityFarBus.connect(gain(0.3)).connect(preMaster);
    cityFarBus.connect(gain(0.7)).connect(reverbIn);

    // Wind: stereo pink noise loop through a broad band-pass plus a faint whistle band.
    const windBuf = makePinkNoise(ctx, 7, 2);
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = windBuf;
    windSrc.loop = true;
    const windBP = ctx.createBiquadFilter();
    windBP.type = 'bandpass';
    windBP.frequency.value = 400;
    windBP.Q.value = 0.7;
    const windGain = gain(0);
    const whistleBP = ctx.createBiquadFilter();
    whistleBP.type = 'bandpass';
    whistleBP.frequency.value = 900;
    whistleBP.Q.value = 5;
    const whistleGain = gain(0);
    // Wind and sand hiss have no sends; this bus exists only to carry the effects level.
    const bedBus = gain(this.fxVol);
    bedBus.connect(preMaster);
    windSrc.connect(windBP).connect(windGain).connect(bedBus);
    windSrc.connect(whistleBP).connect(whistleGain).connect(bedBus);
    windSrc.start(0, Math.random() * 6);

    // Sand hiss: a higher band, separate loop offset for decorrelation.
    const hissSrc = ctx.createBufferSource();
    hissSrc.buffer = windBuf;
    hissSrc.loop = true;
    const hissHP = ctx.createBiquadFilter();
    hissHP.type = 'highpass';
    hissHP.frequency.value = 2400;
    hissHP.Q.value = 0.5;
    const hissBP = ctx.createBiquadFilter();
    hissBP.type = 'lowpass';
    hissBP.frequency.value = 6000;
    hissBP.Q.value = 0.4;
    const hissGain = gain(0);
    hissSrc.connect(hissHP).connect(hissBP).connect(hissGain).connect(bedBus);
    hissSrc.start(0, 3 + Math.random() * 3);

    // Sandstorm: a far low rumble and a mid-band roar that surges. Both run silent at gain 0 and
    // only their gains move. The slow LFOs are detuned so the swells never line up or repeat.
    const stormSrcs: AudioScheduledSourceNode[] = [];
    const rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = windBuf;
    rumbleSrc.loop = true;
    const rumbleLP = ctx.createBiquadFilter();
    rumbleLP.type = 'lowpass';
    rumbleLP.frequency.value = 90;
    rumbleLP.Q.value = 0.7;
    const stormRumbleGain = gain(0);
    const rumbleWobble = gain(0.35); // multiplies the rumble level, slowly
    rumbleSrc.connect(rumbleLP).connect(rumbleWobble).connect(stormRumbleGain).connect(bedBus);
    rumbleSrc.start(0, Math.random() * 6);
    stormSrcs.push(rumbleSrc);
    const stormLfo = (hz: number, depth: number, target: AudioParam): void => {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      const d = gain(depth);
      o.connect(d).connect(target);
      o.start();
      stormSrcs.push(o);
    };
    stormLfo(0.17, 0.2, rumbleWobble.gain);
    const roarSrc = ctx.createBufferSource();
    roarSrc.buffer = windBuf;
    roarSrc.loop = true;
    const roarBP = ctx.createBiquadFilter();
    roarBP.type = 'bandpass';
    roarBP.frequency.value = 400;
    roarBP.Q.value = 0.8;
    const roarLP = ctx.createBiquadFilter(); // nothing harsh up top
    roarLP.type = 'lowpass';
    roarLP.frequency.value = 3000;
    const roarSwell = gain(0.62);
    const stormRoarGain = gain(0);
    roarSrc.connect(roarBP).connect(roarLP).connect(roarSwell).connect(stormRoarGain).connect(bedBus);
    roarSrc.start(0, 1 + Math.random() * 5);
    stormSrcs.push(roarSrc);
    stormLfo(0.071, 0.16, roarSwell.gain);
    stormLfo(0.113, 0.12, roarSwell.gain);
    stormLfo(0.187, 0.08, roarSwell.gain);
    stormLfo(0.043, 80, roarBP.frequency); // the band drifts a little, 320..480 Hz

    // Ambience: beds are always running (silent at level 0) and only their gains move.
    const ambBus = gain(this.fxVol);
    ambBus.connect(gain(0.85)).connect(preMaster);
    ambBus.connect(gain(0.22)).connect(reverbIn);
    const ambSources: AudioScheduledSourceNode[] = [...stormSrcs]; // stopped on dispose
    const ambNoise = makePinkNoise(ctx, 8, 2);
    const noiseSrc = (): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = ambNoise;
      s.loop = true;
      s.start(0, Math.random() * 7);
      ambSources.push(s);
      return s;
    };
    const lfo = (hz: number, depth: number, target: AudioParam): void => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      const d = gain(depth);
      o.connect(d).connect(target);
      o.start(0);
      ambSources.push(o);
    };
    // Water: two band-passed noise bands (body and sparkle); incommensurate LFOs on the
    // centre frequency and level make it burble instead of hiss. Level node is ambWater.
    const ambWater = gain(0);
    {
      const body = ctx.createBiquadFilter();
      body.type = 'bandpass';
      body.frequency.value = 1500;
      body.Q.value = 1;
      const bodyAmp = gain(0.6);
      const spark = ctx.createBiquadFilter();
      spark.type = 'bandpass';
      spark.frequency.value = 3300;
      spark.Q.value = 3;
      const sparkAmp = gain(0.3);
      const src = noiseSrc();
      src.connect(body).connect(bodyAmp).connect(ambWater);
      src.connect(spark).connect(sparkAmp).connect(ambWater);
      lfo(0.37, 450, body.frequency);
      lfo(1.31, 250, body.frequency);
      lfo(0.83, 700, spark.frequency);
      lfo(2.3, 0.22, bodyAmp.gain);
      lfo(5.1, 0.12, bodyAmp.gain);
      lfo(3.7, 0.12, sparkAmp.gain);
      ambWater.connect(ambBus);
    }
    // Leaves: high-passed noise with a quick flutter.
    const ambLeaves = gain(0);
    {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2000;
      hp.Q.value = 0.5;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 7000;
      lp.Q.value = 0.4;
      const flutter = gain(0.7);
      noiseSrc().connect(hp).connect(lp).connect(flutter).connect(ambLeaves);
      lfo(0.9, 0.2, flutter.gain);
      lfo(3.1, 0.1, flutter.gain);
      ambLeaves.connect(ambBus);
    }
    // Mill whoosh: slow low-passed noise swell (the creaks are scheduled one-shots).
    const ambWhoosh = gain(0);
    {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 320;
      lp.Q.value = 0.6;
      const swell = gain(0.65);
      noiseSrc().connect(lp).connect(swell).connect(ambWhoosh);
      lfo(0.23, 0.3, swell.gain);
      lfo(0.31, 90, lp.frequency);
      ambWhoosh.connect(ambBus);
    }
    // Fire rumble: low noise under the scheduled crackles.
    const ambRumble = gain(0);
    {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 150;
      lp.Q.value = 0.5;
      const flick = gain(0.75);
      noiseSrc().connect(lp).connect(flick).connect(ambRumble);
      lfo(0.6, 0.15, flick.gain);
      lfo(1.7, 0.1, flick.gain);
      ambRumble.connect(ambBus);
    }

    // Rain: a soft high band (2 to 5 kHz, rolled off by 7 kHz) and a low-mid body, each breathing on
    // slow detuned LFOs. Silent at gain 0; only rainBed and rainBody move. Drops and thunder are
    // scheduled one-shots.
    const rainBed = gain(0);
    {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1500;
      hp.Q.value = 0.5;
      const bp = ctx.createBiquadFilter();
      bp.type = 'peaking';
      bp.frequency.value = 3400;
      bp.Q.value = 0.6;
      bp.gain.value = 5;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 7000;
      lp.Q.value = 0.4;
      const breath = gain(0.85);
      noiseSrc().connect(hp).connect(bp).connect(lp).connect(breath).connect(rainBed);
      lfo(0.09, 0.1, breath.gain);
      lfo(0.23, 0.05, breath.gain);
      rainBed.connect(ambBus);
    }
    const rainBody = gain(0);
    {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 520;
      bp.Q.value = 0.5;
      const breath = gain(0.8);
      noiseSrc().connect(bp).connect(breath).connect(rainBody);
      lfo(0.07, 0.12, breath.gain);
      lfo(0.17, 0.06, breath.gain);
      lfo(0.05, 120, bp.frequency); // 400..640 Hz
      rainBody.connect(ambBus);
    }

    return {
      preMaster,
      pauseLP,
      pauseGain,
      fade,
      volume,
      hide,
      music,
      reverbIn,
      padBus,
      padRev,
      pluckBus,
      pluckDry,
      pluckRev,
      chimeBus,
      sfxBus,
      musicBuses: [padBus, pluckBus],
      fxBuses: [chimeBus, sfxBus, bedBus, cityBus, cityFarBus, ambBus],
      windSrc,
      windBP,
      windGain,
      whistleBP,
      whistleGain,
      hissSrc,
      hissBP,
      hissGain,
      stormRumbleGain,
      stormRoarGain,
      rainBed,
      rainBody,
      noise: makeWhiteNoise(ctx, 2),
      cityBus,
      cityFarBus,
      ambBus,
      ambWater,
      ambLeaves,
      ambWhoosh,
      ambRumble,
      ambSources,
    };
  }

  // ---------------------------------------------------- continuous params

  private applyParams(f: AudioFrame, now: number): void {
    const g = this.g;
    if (!g) return;
    const wn = this.w.night;
    const alt = clamp01(f.altitude / 400);
    const gust = clamp01(f.gust);
    // Slow internal breathing so steady gusts still move a little.
    const c = this.clock;
    const breathe = 0.5 + 0.5 * Math.sin(c * 0.11) * Math.sin(c * 0.067 + 1.3);
    // Air rushing past when moving fast (sliding, launched).
    const rush = clamp01((f.speed - 14) / 24);

    // Buildings shelter you: duck the wind a little as a city closes around you (1 when no city).
    // Rock shuts it out altogether: underground only the air you move through yourself is left.
    const open = 1 - this.deep;
    const shelter = (1 - 0.35 * this.cityNear) * open;
    const ahead = this.stormAhead;
    const storm = this.storm;
    const calm = 1 - 0.92 * ahead; // calm beds (birds, leaves, water, mill) fade as a storm builds
    const windLevel =
      ((0.025 + 0.07 * gust + 0.04 * alt + 0.015 * breathe) * shelter + 0.07 * rush * (1 - 0.5 * this.deep)) *
      (1 + 0.5 * ahead + 0.6 * storm);
    const windFreq = (280 + 420 * gust + 260 * alt + 120 * breathe + 700 * rush) * (1 - 0.2 * ahead - 0.15 * storm);
    g.windGain.gain.setTargetAtTime(windLevel, now, 1.2);
    g.windBP.frequency.setTargetAtTime(windFreq, now, 1.5);
    g.whistleGain.gain.setTargetAtTime(0.006 * gust * (0.3 + alt) * breathe * shelter, now, 2);
    g.whistleBP.frequency.setTargetAtTime(700 + 500 * gust + 400 * alt + 200 * breathe, now, 2.5);

    const sand = f.sliding && f.grounded ? clamp01((f.speed - 2) / 28) : 0;
    g.hissGain.gain.setTargetAtTime(
      (f.rock ? 0.03 : 0.045) * sand + 0.05 * storm * (1 - this.deep),
      now,
      sand > 0 || storm > 0 ? 0.4 : 0.6,
    );
    const hissHz = f.rock ? 1700 + 900 * sand : 4500 + 2500 * sand;
    g.hissBP.frequency.setTargetAtTime(hissHz + (4200 - hissHz) * storm, now, f.rock ? 0.15 : 0.5); // soft above ~5 kHz

    // Sandstorm layers: far rumble from the approach on, roar once inside, both with slow smoothing.
    const open2 = 1 - this.deep;
    g.stormRumbleGain.gain.setTargetAtTime(0.32 * Math.max(0.45 * ahead, storm) * open2, now, 1.5);
    g.stormRoarGain.gain.setTargetAtTime(0.16 * storm * storm * open2, now, 1.5);
    // Score and mood layers duck by about half in the thick of it (and barely at all in rain).
    const duck = (1 - 0.5 * storm - 0.1 * ahead * (1 - storm)) * (1 - 0.15 * this.rain);
    if (Math.abs(duck - this.musicDuck) > 0.002) {
      this.musicDuck = duck;
      this.applyBusLevel(g.musicBuses, this.musicVol * duck);
    }

    // Night: more reverb, less dry pluck.
    g.padRev.gain.setTargetAtTime(0.42 + 0.25 * wn, now, 3);
    g.pluckRev.gain.setTargetAtTime(0.5 + 0.35 * wn, now, 3);
    g.pluckDry.gain.setTargetAtTime(0.7 - 0.32 * wn, now, 3);

    this.applyCity(now, 0.1);

    // Ambience beds. Peak gains are conservative: at level 1 each sits well below the pads/plucks
    // (music bus 0.75 x ~0.04..0.07 per voice) and the city murmur (0.24).
    const am = this.amb;
    // Rain: a gift, well under the storm. Rain on sand; nothing of it gets underground.
    const rain = this.rain;
    g.rainBed.gain.setTargetAtTime(0.06 * rain * open2, now, 0.6);
    g.rainBody.gain.setTargetAtTime(0.035 * rain * open2, now, 0.6);
    const wetCalm = 1 - 0.3 * rain; // leaves and the mill duck a little; water stays
    g.ambWater.gain.setTargetAtTime(0.05 * am.water * (0.4 + 0.6 * calm), now, 0.25);
    // Leaves and the mill are open-air sounds and go with the wind underground; water and fire stay.
    g.ambLeaves.gain.setTargetAtTime(0.05 * am.leaves * (0.25 + 0.75 * this.ambGust) * open * calm * wetCalm, now, 0.3);
    g.ambWhoosh.gain.setTargetAtTime(0.03 * am.mill * open * calm * wetCalm, now, 0.3);
    g.ambRumble.gain.setTargetAtTime(0.03 * am.fire, now, 0.3);

    this.applyDeep(now, 0.1);
  }

  /** Underground bed levels; builds the bed on the way down and frees it back on the surface. */
  private applyDeep(now: number, dt: number): void {
    const deep = this.deep;
    const active = deep > 0.002;
    if (!this.deepBed) {
      if (!active) return;
      this.deepBed = this.buildDeepBed();
      if (!this.deepBed) return;
    }
    const bed = this.deepBed;
    if (!active) {
      // Free the bed once it has faded to silence and the drip echoes have rung out.
      this.deepIdle += dt;
      if (this.deepIdle > 6) {
        this.teardownDeep();
        return;
      }
    } else {
      this.deepIdle = 0;
    }
    // Quiet: the room sits under the wind it replaces (0.025..0.2) and well under the score.
    bed.room.gain.setTargetAtTime(0.085 * deep, now, 0.8);
    bed.air.gain.setTargetAtTime(0.016 * deep, now, 0.8);
    bed.trickle.gain.setTargetAtTime(0.02 * deep * this.wet * this.wet, now, 0.8);
  }

  /**
   * A big stone space: pink noise low-passed to a rumble, a faint mid band of moving air above it
   * and a lapping/trickle bed, all drifting on very slow incommensurate LFOs (nothing pitched).
   * Drips are scheduled one-shots into dripIn, which adds two cross-fed, darkening echoes.
   */
  private buildDeepBed(): DeepBed | null {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return null;
    const now = ctx.currentTime;
    const buf = g.windSrc.buffer; // the stereo pink loop already made for the wind
    if (!buf) return null;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const mk = <T extends AudioNode>(n: T): T => {
      nodes.push(n);
      return n;
    };
    const gain = (v: number): GainNode => {
      const n = mk(ctx.createGain());
      n.gain.value = v;
      return n;
    };
    const filter = (type: BiquadFilterType, freq: number, q: number): BiquadFilterNode => {
      const n = mk(ctx.createBiquadFilter());
      n.type = type;
      n.frequency.value = freq;
      n.Q.value = q;
      return n;
    };
    const noiseSrc = (): AudioBufferSourceNode => {
      const s = mk(ctx.createBufferSource());
      s.buffer = buf;
      s.loop = true;
      s.start(now, Math.random() * (buf.duration - 0.5));
      sources.push(s);
      return s;
    };
    const lfo = (hz: number, depth: number, target: AudioParam): void => {
      const o = mk(ctx.createOscillator());
      o.type = 'sine';
      o.frequency.value = hz;
      o.connect(gain(depth)).connect(target);
      o.start(now);
      sources.push(o);
    };

    const bus = gain(this.fxVol);
    bus.connect(gain(0.8)).connect(g.preMaster);
    bus.connect(gain(0.45)).connect(g.reverbIn);

    // Room tone.
    const src = noiseSrc();
    const room = gain(0);
    const roomHP = filter('highpass', 40, 0.5);
    const roomLP = filter('lowpass', 170, 0.5);
    const swell = gain(0.72);
    src.connect(roomHP).connect(roomLP).connect(swell).connect(room).connect(bus);
    lfo(0.043, 0.18, swell.gain);
    lfo(0.071, 0.1, swell.gain);
    lfo(0.029, 45, roomLP.frequency);
    const air = gain(0);
    const airBP = filter('bandpass', 430, 0.6);
    const airAmp = gain(0.55);
    src.connect(airBP).connect(airAmp).connect(air).connect(bus);
    lfo(0.037, 130, airBP.frequency);
    lfo(0.059, 0.3, airAmp.gain);
    lfo(0.113, 0.15, airAmp.gain);

    // Water lying somewhere in the dark: a slow lapping band and a thin far-off trickle.
    const trickle = gain(0);
    const wsrc = noiseSrc();
    const lapBP = filter('bandpass', 520, 0.9);
    const lapAmp = gain(0.5);
    const runBP = filter('bandpass', 1700, 1.6);
    const runAmp = gain(0.3);
    const far = filter('lowpass', 2600, 0.5);
    wsrc.connect(lapBP).connect(lapAmp).connect(far);
    wsrc.connect(runBP).connect(runAmp).connect(far);
    far.connect(trickle).connect(bus);
    lfo(0.21, 0.3, lapAmp.gain);
    lfo(0.34, 0.18, lapAmp.gain);
    lfo(0.17, 110, lapBP.frequency);
    lfo(0.47, 420, runBP.frequency);
    lfo(1.9, 0.14, runAmp.gain);
    lfo(3.3, 0.1, runAmp.gain);

    // Drips: dry, plus two cross-fed echoes off far walls, each pass darker and quieter.
    const dripIn = gain(1);
    dripIn.connect(bus);
    const dl = mk(ctx.createDelay(1));
    dl.delayTime.value = 0.29;
    const dr = mk(ctx.createDelay(1));
    dr.delayTime.value = 0.43;
    const lpL = filter('lowpass', 2200, 0.5);
    const lpR = filter('lowpass', 1500, 0.5);
    const panL = mk(ctx.createStereoPanner());
    panL.pan.value = -0.6;
    const panR = mk(ctx.createStereoPanner());
    panR.pan.value = 0.6;
    dripIn.connect(dl).connect(lpL);
    lpL.connect(gain(0.45)).connect(dr).connect(lpR);
    lpR.connect(gain(0.4)).connect(dl);
    lpL.connect(gain(0.5)).connect(panL).connect(bus);
    lpR.connect(gain(0.4)).connect(panR).connect(bus);

    g.fxBuses.push(bus);
    this.deepIdle = 0;
    return { bus, room, air, trickle, dripIn, sources, nodes };
  }

  private teardownDeep(): void {
    const bed = this.deepBed;
    if (!bed) return;
    this.deepBed = null;
    this.nextDrip = 0;
    const buses = this.g?.fxBuses;
    const i = buses ? buses.indexOf(bed.bus) : -1;
    if (buses && i >= 0) buses.splice(i, 1);
    for (const s of bed.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    disconnectAll(...bed.nodes);
  }

  /**
   * One water drop: a short sine plink chirping upward, over a small low plop when it lands in
   * standing water. Random pitch every time so it never settles into a note.
   */
  private drip(t: number, level: number): void {
    const ctx = this.ctx;
    const bed = this.deepBed;
    if (!ctx || !bed) return;
    const wet = this.wet;
    const f = rand(850, 2100);
    const dur = rand(0.06, 0.12);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 0.8, t);
    o.frequency.exponentialRampToValueAtTime(f * rand(1.25, 1.6), t + dur);
    const env = ctx.createGain();
    const peak = Math.max(0.03 * level * rand(0.45, 1), 2 * EPS);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.004);
    env.gain.exponentialRampToValueAtTime(EPS, t + dur);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.7, 0.7);
    o.connect(env).connect(pan).connect(bed.dripIn);
    o.start(t);
    o.stop(t + dur + 0.03);
    const body = ctx.createOscillator();
    body.type = 'sine';
    const bf = rand(300, 480);
    body.frequency.setValueAtTime(bf, t);
    body.frequency.exponentialRampToValueAtTime(bf * 0.6, t + 0.07);
    const benv = ctx.createGain();
    benv.gain.setValueAtTime(0, t);
    benv.gain.linearRampToValueAtTime(Math.max(peak * (0.25 + 0.6 * wet), 2 * EPS), t + 0.006);
    benv.gain.exponentialRampToValueAtTime(EPS, t + 0.08);
    body.connect(benv).connect(pan);
    body.start(t);
    body.stop(t + 0.1);
    o.onended = () => disconnectAll(o, env, body, benv, pan);
  }

  /** Murmur bed levels and the slow wander of its formant bands. */
  private applyCity(now: number, dt: number): void {
    const near = this.cityNear;
    const bustle = this.cityBustle;
    const night = this.cityNight;
    const active = near > 0.002 || bustle > 0.002;
    if (!this.bed) {
      if (!active) return;
      this.bed = this.buildCityBed();
      if (!this.bed) return;
    }
    const bed = this.bed;
    if (!active) {
      // Free the bed once it has long since faded to silence.
      this.bedIdle += dt;
      if (this.bedIdle > 30) {
        this.teardownBed();
        return;
      }
    } else {
      this.bedIdle = 0;
    }

    // Close crowd follows bustle; the far-off city follows near. Night empties the streets.
    const nearLvl = 0.24 * bustle * (1 - 0.8 * night);
    const farLvl = 0.18 * Math.pow(near, 1.5) * (1 - 0.6 * bustle) * (1 - 0.75 * night);
    bed.nearGain.gain.setTargetAtTime(nearLvl, now, 1.5);
    bed.farGain.gain.setTargetAtTime(farLvl, now, 2.5);

    // More people, more independent bands audible.
    const density = Math.max(bustle, 0.6 * near);
    bed.bands.forEach((b, i) => {
      b.timer -= dt;
      if (b.timer <= 0) {
        b.timer = rand(1.2, 3.5);
        b.wander = rand(0.45, 1);
        b.f1.frequency.setTargetAtTime(rand(320, 780), now, rand(0.6, 1.4));
        b.f2.frequency.setTargetAtTime(rand(950, 2300), now, rand(0.6, 1.4));
        b.lfoA.frequency.setTargetAtTime(rand(2.6, 4.8), now, 1.5);
        b.lfoB.frequency.setTargetAtTime(rand(0.6, 1.6), now, 2);
      }
      const weight = clamp01((density - i * 0.15) / 0.3);
      b.level.gain.setTargetAtTime(weight * b.wander, now, 1.2);
    });
  }

  /**
   * Crowd murmur bed: four decorrelated pink-noise bands, each through two vowel-region
   * band-passes, amplitude-modulated at syllable-ish rates by two incommensurate LFOs.
   */
  private buildCityBed(): CityBed | null {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return null;
    const now = ctx.currentTime;
    const buf = makePinkNoise(ctx, 6, 1);
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const mk = <T extends AudioNode>(n: T): T => {
      nodes.push(n);
      return n;
    };

    const hp = mk(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 180;
    hp.Q.value = 0.5;
    const nearLP = mk(ctx.createBiquadFilter());
    nearLP.type = 'lowpass';
    nearLP.frequency.value = 1700;
    nearLP.Q.value = 0.5;
    const farLP = mk(ctx.createBiquadFilter());
    farLP.type = 'lowpass';
    farLP.frequency.value = 420;
    farLP.Q.value = 0.5;
    const nearGain = mk(ctx.createGain());
    nearGain.gain.value = 0;
    const farGain = mk(ctx.createGain());
    farGain.gain.value = 0;
    hp.connect(nearLP).connect(nearGain).connect(g.cityBus);
    hp.connect(farLP).connect(farGain).connect(g.cityFarBus);

    const pans = [-0.65, -0.22, 0.22, 0.65];
    const bands: CityBand[] = pans.map((p) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      sources.push(src);
      nodes.push(src);
      const f1 = mk(ctx.createBiquadFilter());
      f1.type = 'bandpass';
      f1.frequency.value = rand(320, 780);
      f1.Q.value = 3;
      const f2 = mk(ctx.createBiquadFilter());
      f2.type = 'bandpass';
      f2.frequency.value = rand(950, 2300);
      f2.Q.value = 4;
      const f2g = mk(ctx.createGain());
      f2g.gain.value = 0.55;
      // Syllabic amplitude: 0.5 ± (0.28 + 0.2), never below zero.
      const amp = mk(ctx.createGain());
      amp.gain.value = 0.5;
      const lfoA = ctx.createOscillator();
      lfoA.type = 'sine';
      lfoA.frequency.value = rand(2.6, 4.8);
      const depthA = mk(ctx.createGain());
      depthA.gain.value = 0.28;
      const lfoB = ctx.createOscillator();
      lfoB.type = 'sine';
      lfoB.frequency.value = rand(0.6, 1.6);
      const depthB = mk(ctx.createGain());
      depthB.gain.value = 0.2;
      sources.push(lfoA, lfoB);
      nodes.push(lfoA, lfoB);
      lfoA.connect(depthA).connect(amp.gain);
      lfoB.connect(depthB).connect(amp.gain);
      const level = mk(ctx.createGain());
      level.gain.value = 0;
      const pan = mk(ctx.createStereoPanner());
      pan.pan.value = p;
      src.connect(f1).connect(amp);
      src.connect(f2).connect(f2g).connect(amp);
      amp.connect(level).connect(pan).connect(hp);
      src.start(now, Math.random() * 5);
      lfoA.start(now);
      lfoB.start(now);
      return { f1, f2, level, lfoA, lfoB, wander: rand(0.45, 1), timer: rand(0, 2) };
    });
    this.bedIdle = 0;
    return { bands, nearGain, farGain, sources, nodes };
  }

  private teardownBed(): void {
    const bed = this.bed;
    if (!bed) return;
    this.bed = null;
    for (const s of bed.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    disconnectAll(...bed.nodes);
  }

  // ------------------------------------------------------------ scheduler

  /** Look-ahead scheduling against currentTime; events are sparse so a short window suffices. */
  private schedule(now: number): void {
    const horizon = now + 0.3;
    // If the loop stalled (tab throttled), restart from now rather than bursting.
    if (this.nextPad < now - 1) this.nextPad = now + 0.05;
    if (this.nextPluck < now - 1) this.nextPluck = now + rand(1, 3);
    if (this.nextDrone < now - 1) this.nextDrone = now + rand(10, 30);

    while (this.nextPad < horizon) {
      const t = Math.max(this.nextPad, now + 0.02);
      this.nextPad = t + this.playChord(t);
    }
    while (this.nextPluck < horizon) {
      const t = Math.max(this.nextPluck, now + 0.02);
      this.nextPluck = t + this.playPhrase(t);
    }
    while (this.nextDrone < horizon) {
      const t = Math.max(this.nextDrone, now + 0.02);
      this.nextDrone = t + this.playDrone(t);
    }
    if (this.nextAmbTick < now - 1) this.nextAmbTick = now + 0.05;
    while (this.nextAmbTick < horizon) {
      const t = Math.max(this.nextAmbTick, now + 0.02);
      this.ambienceTick(t);
      this.nextAmbTick = t + CITY_TICK;
    }
    // Drips: single drops seconds apart in dry rock, every second or two beside open water.
    if (this.deepBed && this.deep > 0.12) {
      if (this.nextDrip < now - 1) this.nextDrip = now + rand(1.5, 5);
      while (this.nextDrip < horizon) {
        const t = Math.max(this.nextDrip, now + 0.02);
        const wet = this.wet;
        this.drip(t, this.deep);
        // Now and then a second, smaller drop right behind the first.
        if (Math.random() < 0.12 + 0.2 * wet) this.drip(t + rand(0.13, 0.3), this.deep * 0.5);
        const gap = rand(4.5, 13) * (1 - wet) + rand(0.7, 2.6) * wet;
        this.nextDrip = t + gap;
      }
    } else {
      this.nextDrip = 0;
    }
    if (this.nextCityTick < now - 1) this.nextCityTick = now + 0.05;
    while (this.nextCityTick < horizon) {
      const t = Math.max(this.nextCityTick, now + 0.02);
      this.cityTick(t);
      this.nextCityTick = t + CITY_TICK;
    }
  }

  // ------------------------------------------------------------- ambience

  /** One ambience scheduler tick: random sparse one-shots for water, fire, mill and birds. */
  private ambienceTick(t: number): void {
    const am = this.amb;
    const jit = (): number => t + rand(0, CITY_TICK);
    // Expected count over one tick (rate in events per second), Bernoulli on the remainder.
    const count = (rate: number): number => {
      const e = rate * CITY_TICK;
      return Math.floor(e) + (Math.random() < e - Math.floor(e) ? 1 : 0);
    };

    if (am.water > 0.04) {
      for (let i = count(3.5 * am.water); i > 0; i--) this.waterBloop(jit(), am.water);
    }
    if (am.fire > 0.04) {
      for (let i = count(2 + 9 * am.fire); i > 0; i--) this.fireCrackle(jit(), am.fire);
    }
    if (am.mill > 0.04) {
      if (this.nextCreak < t - 1) this.nextCreak = t + rand(0.5, 2);
      if (this.nextCreak <= t + CITY_TICK) {
        this.millCreak(Math.max(this.nextCreak, t), am.mill * (1 - this.deep));
        this.nextCreak = Math.max(this.nextCreak, t) + rand(2.6, 6.5);
      }
    } else {
      this.nextCreak = 0;
    }
    this.rainTick(t, jit, count);
    // No daylight and no birds below ground (or in the rain).
    const day = (1 - this.ambNight) * (1 - this.deep) * (1 - this.stormAhead) * (1 - clamp01(this.rain * 5));
    if (am.birds > 0.03 && day > 0.05) {
      if (this.nextBird < t - 1) this.nextBird = t + rand(1, 4);
      if (this.nextBird <= t + CITY_TICK) {
        const at = Math.max(this.nextBird, t);
        const lvl = am.birds * day;
        this.birdCall(at, lvl, rand(-0.85, 0.85));
        // Now and then a second bird answers from elsewhere.
        if (Math.random() < 0.3) this.birdCall(at + rand(0.8, 2), lvl * 0.7, rand(-0.85, 0.85));
        this.nextBird = at + rand(2.5, 8) / (0.35 + 0.65 * am.birds);
      }
    } else {
      this.nextBird = 0;
    }
  }

  /** Rain one-shots: sparse single drops while it rains, and rare distant thunder. */
  private rainTick(t: number, jit: () => number, count: (rate: number) => number): void {
    const rain = this.rain;
    const open = 1 - this.deep;
    if (rain > 0.1 && open > 0.1) {
      for (let i = count((0.8 + 3.2 * rain) * (0.6 + 0.4 * Math.random())); i > 0; i--) {
        this.rainDrop(jit(), rain * open);
      }
    }
    if (rain > 0.3 && open > 0.5) {
      if (this.nextThunder < t - 1) this.nextThunder = t + rand(25, 70);
      if (this.nextThunder <= t + CITY_TICK) {
        this.thunder(Math.max(this.nextThunder, t), open);
        this.nextThunder = Math.max(this.nextThunder, t) + rand(25, 70);
      }
    } else {
      this.nextThunder = 0;
    }
  }

  /** One rain drop: a very short filtered noise tick, sometimes with a tiny pitched blip. */
  private rainDrop(t: number, level: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.9, 0.9);
    pan.connect(g.ambBus);
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.playbackRate.value = rand(0.8, 1.4);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rand(1800, 5200);
    bp.Q.value = rand(1, 3);
    const env = ctx.createGain();
    const dec = rand(0.006, 0.02);
    const peak = Math.max(0.02 * level * rand(0.3, 1), 2 * EPS);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.001);
    env.gain.exponentialRampToValueAtTime(EPS, t + 0.001 + dec);
    src.connect(bp).connect(env).connect(pan);
    src.start(t, Math.random() * (g.noise.duration - 0.2));
    src.stop(t + dec + 0.02);
    const nodes: AudioNode[] = [src, bp, env];
    let last: AudioScheduledSourceNode = src;
    if (Math.random() < 0.3) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f = rand(1800, 3800);
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * rand(0.6, 0.85), t + 0.04);
      const oe = ctx.createGain();
      oe.gain.setValueAtTime(0, t);
      oe.gain.linearRampToValueAtTime(Math.max(0.004 * level * rand(0.3, 1), 2 * EPS), t + 0.002);
      oe.gain.exponentialRampToValueAtTime(EPS, t + 0.05);
      o.connect(oe).connect(pan);
      o.start(t);
      o.stop(t + 0.06);
      nodes.push(o, oe);
      last = o;
    }
    last.onended = () => disconnectAll(...nodes, pan);
  }

  /**
   * Distant thunder: low-passed noise (under ~200 Hz) with a soft fast attack and two or three
   * overlapping swells that fade unevenly over 4 to 8 seconds. Never a crack.
   */
  private thunder(t: number, open: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const total = rand(4.5, 8);
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(rand(150, 200), t);
    lp.frequency.exponentialRampToValueAtTime(70, t + total);
    lp.Q.value = 0.6;
    const env = ctx.createGain();
    const peak = 0.32 * open * rand(0.7, 1);
    env.gain.setValueAtTime(0, t);
    // Swells: the first leads, later ones come in on the tail of the one before, smaller each time.
    const swells = Math.random() < 0.5 ? 2 : 3;
    let at = t;
    let amp = 1;
    for (let i = 0; i < swells; i++) {
      const rise = rand(0.25, 0.6);
      const hold = rand(0.3, 0.9);
      env.gain.linearRampToValueAtTime(Math.max(peak * amp, 2 * EPS), at + rise);
      const dip = at + rise + hold + rand(0.5, 1.2);
      env.gain.linearRampToValueAtTime(Math.max(peak * amp * rand(0.25, 0.45), 2 * EPS), dip);
      at = dip;
      amp *= rand(0.55, 0.85);
    }
    env.gain.setTargetAtTime(0, at, Math.max(0.6, (t + total - at) / 3));
    env.gain.setValueAtTime(0, t + total + 0.8);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.7, 0.7);
    src.connect(lp).connect(env).connect(pan).connect(g.ambBus);
    src.start(t, Math.random() * (g.noise.duration - 0.1));
    src.stop(t + total + 1);
    src.onended = () => disconnectAll(src, lp, env, pan);
  }

  /** A small water bubble: a short rising sine blip. */
  private waterBloop(t: number, level: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f = rand(600, 1500);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * rand(1.4, 1.9), t + 0.07);
    const env = ctx.createGain();
    const peak = Math.max(0.005 * level * rand(0.4, 1), 2 * EPS);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.008);
    env.gain.exponentialRampToValueAtTime(EPS, t + 0.09);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.4, 0.4);
    o.connect(env).connect(pan).connect(g.ambBus);
    o.start(t);
    o.stop(t + 0.12);
    o.onended = () => disconnectAll(o, env, pan);
  }

  /** One fire crackle: a very short noise tick through a low-pass; sometimes a tiny double. */
  private fireCrackle(t: number, level: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.25, 0.25);
    pan.connect(g.ambBus);
    const hits = Math.random() < 0.25 ? 2 : 1;
    let last: AudioBufferSourceNode | null = null;
    const nodes: AudioNode[] = [pan];
    for (let i = 0; i < hits; i++) {
      const at = t + i * rand(0.02, 0.06);
      const src = ctx.createBufferSource();
      src.buffer = g.noise;
      src.playbackRate.value = rand(0.8, 1.3);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = rand(1500, 4500);
      bp.Q.value = 0.8;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 4200;
      lp.Q.value = 0.5;
      const env = ctx.createGain();
      const dec = rand(0.008, 0.03);
      const peak = Math.max(0.03 * level * rand(0.2, 1) * (i ? 0.6 : 1), 2 * EPS);
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + 0.001);
      env.gain.exponentialRampToValueAtTime(EPS, at + 0.001 + dec);
      src.connect(bp).connect(lp).connect(env).connect(pan);
      src.start(at, Math.random() * (g.noise.duration - 0.2));
      src.stop(at + dec + 0.02);
      nodes.push(src, bp, lp, env);
      last = src;
    }
    if (last) last.onended = () => disconnectAll(...nodes);
  }

  /** A slow wooden creak: a gliding sawtooth with stick-slip tremolo through a narrow band-pass. */
  private millCreak(t: number, level: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const dur = rand(0.55, 1.1);
    const f0 = rand(140, 260);
    const f1 = f0 * rand(0.78, 1.3);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f1, t + dur);
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.frequency.setValueAtTime(f0 * 1.51, t);
    o2.frequency.linearRampToValueAtTime(f1 * 1.51, t + dur);
    const o2g = ctx.createGain();
    o2g.gain.value = 0.4;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(rand(600, 900), t);
    bp.frequency.linearRampToValueAtTime(rand(500, 1100), t + dur);
    bp.Q.value = 4;
    // Stick-slip: fast irregular tremolo on its own node.
    const trem = ctx.createGain();
    trem.gain.value = 0.6;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rand(18, 38);
    const lfoD = ctx.createGain();
    lfoD.gain.value = 0.4;
    lfo.connect(lfoD).connect(trem.gain);
    const env = ctx.createGain();
    const peak = Math.max(0.014 * level * rand(0.7, 1), 2 * EPS);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + dur * 0.3);
    env.gain.linearRampToValueAtTime(peak * 0.7, t + dur * 0.7);
    env.gain.linearRampToValueAtTime(0, t + dur);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.3, 0.3);
    o.connect(bp);
    o2.connect(o2g).connect(bp);
    bp.connect(trem).connect(env).connect(pan).connect(g.ambBus);
    const end = t + dur + 0.05;
    for (const n of [o, o2, lfo]) {
      n.start(t);
      n.stop(end);
    }
    o.onended = () => disconnectAll(o, o2, o2g, bp, trem, lfo, lfoD, env, pan);
  }

  /** A short soft bird call, one of four invented kinds, panned somewhere in the stereo field. */
  private birdCall(t: number, level: number, panV: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const pan = ctx.createStereoPanner();
    pan.pan.value = panV;
    pan.connect(g.ambBus);
    const nodes: AudioNode[] = [pan];
    let lastOsc: OscillatorNode | null = null;
    const peakBase = 0.014 * level;
    const note = (at: number, f0: number, f1: number, dur: number, peak: number, vibHz = 0, vibDepth = 0): void => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, at);
      o.frequency.exponentialRampToValueAtTime(f1, at + dur);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(Math.max(peak, 2 * EPS), at + Math.min(0.012, dur * 0.3));
      env.gain.exponentialRampToValueAtTime(EPS, at + dur);
      o.connect(env).connect(pan);
      nodes.push(o, env);
      o.start(at);
      o.stop(at + dur + 0.02);
      if (vibHz > 0) {
        const l = ctx.createOscillator();
        l.frequency.value = vibHz;
        const d = ctx.createGain();
        d.gain.value = vibDepth;
        l.connect(d).connect(o.frequency);
        nodes.push(l, d);
        l.start(at);
        l.stop(at + dur + 0.02);
      }
      lastOsc = o;
    };
    const kind = Math.floor(Math.random() * 4);
    if (kind === 0) {
      // "tsi-tsi-tsit": two or three short rising tweets.
      const n = Math.random() < 0.5 ? 2 : 3;
      let f = rand(3200, 4200);
      for (let i = 0; i < n; i++) {
        note(t + i * 0.11, f, f * rand(1.1, 1.25), rand(0.06, 0.09), peakBase * (1 - i * 0.12));
        f *= rand(0.95, 1.05);
      }
    } else if (kind === 1) {
      // A soft trill: one tone wobbling quickly.
      const f = rand(2800, 3600);
      note(t, f, f * rand(0.9, 1.1), rand(0.35, 0.55), peakBase * 0.8, rand(24, 36), rand(300, 450));
    } else if (kind === 2) {
      // A falling whistle with a lower after-note.
      const f = rand(3800, 4300);
      note(t, f, f * 0.72, rand(0.2, 0.28), peakBase);
      note(t + 0.3, f * 0.7, f * 0.62, rand(0.1, 0.15), peakBase * 0.7);
    } else {
      // "pee-oo": a gentle two-note call, lower and rounder.
      const f = rand(1800, 2400);
      note(t, f, f * 1.28, rand(0.12, 0.16), peakBase);
      note(t + 0.19, f * 1.28, f * 0.9, rand(0.16, 0.22), peakBase * 0.85);
    }
    if (lastOsc) (lastOsc as OscillatorNode).onended = () => disconnectAll(...nodes);
  }

  // ---------------------------------------------------------------- city

  /** One city scheduler tick: random sparse events, each jittered within the tick. */
  private cityTick(t: number): void {
    const near = this.cityNear;
    const bustle = this.cityBustle;
    const night = this.cityNight;

    // Dusk bell bookkeeping runs everywhere so the figure sounds at most once per dusk.
    const d = ((this.cityDay % 1) + 1) % 1;
    const inDusk = d > 0.735 && d < 0.79;
    if (d < 0.7 || d > 0.83) this.duskBellDone = false;

    if (near < 0.002 && bustle < 0.002) {
      this.nextCityBell = 0;
      return;
    }
    const ns = 1 - 0.8 * night;
    const jit = (): number => t + rand(0, CITY_TICK);

    // Speaking voices: close ones follow bustle; distant ones follow near.
    const rNear = 1.5 * bustle * ns;
    const rFar = 0.35 * Math.pow(near, 1.5) * (1 - 0.5 * bustle) * (1 - 0.7 * night);
    if (Math.random() < rNear * CITY_TICK) this.cityVoice(jit(), false);
    if (Math.random() < rFar * CITY_TICK) this.cityVoice(jit(), true);
    // Other people walking past and small activity sounds.
    if (Math.random() < 0.22 * bustle * ns * CITY_TICK) this.cityWalker(jit());
    if (Math.random() < 0.3 * bustle * ns * CITY_TICK) this.cityActivity(jit());

    // Bell or drum from somewhere in the city.
    if (near <= 0.3) {
      this.nextCityBell = 0;
      return;
    }
    if (inDusk && !this.duskBellDone) {
      this.duskBellDone = true;
      this.duskBells(t + rand(1, 4));
      this.nextCityBell = t + rand(50, 120);
      return;
    }
    if (this.nextCityBell === 0) {
      this.nextCityBell = t + rand(8, 35); // heard soon after arriving
      return;
    }
    if (t >= this.nextCityBell) {
      if (Math.random() < 0.5 + 0.3 * night) {
        const root = Math.random() < 0.6 ? midiHz(D3) : midiHz(D3 - 5); // D3 or A2
        this.cityBell(t, root, rand(0.045, 0.06), rand(-0.6, 0.6), rand(7, 10));
      } else {
        this.cityDrum(t);
      }
      this.nextCityBell = t + rand(40, 120);
    }
  }

  /** A short wordless spoken gesture: 1..3 formant syllables with a gentle pitch contour. */
  private cityVoice(t: number, far: boolean): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const r = Math.random();
    let f0 = r < 0.12 ? rand(260, 380) : r < 0.55 ? rand(105, 150) : rand(175, 255);
    const syllables = Math.random() < 0.55 ? 1 : Math.random() < 0.7 ? 2 : 3;
    // Statements mostly fall; some rise.
    const contour = Math.random() < 0.7 ? -1 : 1;
    const peakBase = (far ? 0.03 : 0.04) * rand(0.35, 1);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = far ? 750 : 2000;
    lp.Q.value = 0.5;
    const pan = ctx.createStereoPanner();
    pan.pan.value = far ? rand(-0.5, 0.5) : rand(-0.8, 0.8);
    lp.connect(pan).connect(far ? g.cityFarBus : g.cityBus);

    let at = t;
    for (let i = 0; i < syllables; i++) {
      const dur = rand(0.15, 0.4);
      const ratio = Math.pow(2, (contour * rand(1, 3)) / 12);
      const voiced = Math.random() < 0.75;
      let src: AudioScheduledSourceNode;
      if (voiced) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f0 * rand(0.97, 1.03), at);
        o.frequency.exponentialRampToValueAtTime(f0 * ratio, at + dur);
        src = o;
      } else {
        // Breathy, noise-excited syllable.
        const n = ctx.createBufferSource();
        n.buffer = g.noise;
        src = n;
      }
      const f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.Q.value = 5;
      f1.frequency.setValueAtTime(rand(350, 800), at);
      f1.frequency.linearRampToValueAtTime(rand(350, 800), at + dur);
      const f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.Q.value = 7;
      f2.frequency.setValueAtTime(rand(1000, 2300), at);
      f2.frequency.linearRampToValueAtTime(rand(1000, 2300), at + dur);
      const f2g = ctx.createGain();
      f2g.gain.value = 0.45;
      const env = ctx.createGain();
      const peak = Math.max(peakBase * (voiced ? 1 : 2) * (i === 0 ? 1 : 0.8), 2 * EPS);
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + dur * 0.35);
      env.gain.exponentialRampToValueAtTime(EPS, at + dur);
      src.connect(f1).connect(env);
      src.connect(f2).connect(f2g).connect(env);
      env.connect(lp);
      const last = i === syllables - 1;
      if (src instanceof AudioBufferSourceNode) src.start(at, Math.random() * (g.noise.duration - 0.6));
      else src.start(at);
      src.stop(at + dur + 0.05);
      // Syllables are sequential, so the last one to end also frees the shared nodes.
      src.onended = () => {
        disconnectAll(src, f1, f2, f2g, env);
        if (last) disconnectAll(lp, pan);
      };
      f0 *= ratio * rand(0.97, 1.03);
      at += dur + rand(0.03, 0.12);
    }
  }

  /** Stone footstep: a bright short tick plus a small resonant body. */
  private stoneStep(t: number, s: number, scale: number, panV: number | null, dest: AudioNode): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.playbackRate.value = rand(0.9, 1.12);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rand(2000, 2900);
    bp.Q.value = 1.3;
    const ce = ctx.createGain();
    const cPeak = Math.max(0.042 * s * scale, 2 * EPS);
    ce.gain.setValueAtTime(EPS, t);
    ce.gain.exponentialRampToValueAtTime(cPeak, t + 0.002);
    ce.gain.exponentialRampToValueAtTime(EPS, t + 0.002 + rand(0.025, 0.04));

    const body = ctx.createOscillator();
    body.type = 'sine';
    const bf = rand(170, 250);
    body.frequency.setValueAtTime(bf * 1.15, t);
    body.frequency.exponentialRampToValueAtTime(bf, t + 0.02);
    const be = ctx.createGain();
    const bPeak = Math.max(0.02 * s * scale, 2 * EPS);
    be.gain.setValueAtTime(EPS, t);
    be.gain.exponentialRampToValueAtTime(bPeak, t + 0.003);
    be.gain.exponentialRampToValueAtTime(EPS, t + 0.003 + rand(0.05, 0.08));

    let out: AudioNode = dest;
    const extra: AudioNode[] = [];
    if (panV !== null) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = panV;
      pan.connect(dest);
      out = pan;
      extra.push(pan);
    }
    src.connect(bp).connect(ce).connect(out);
    body.connect(be).connect(out);
    const end = t + 0.13;
    src.start(t, Math.random() * (g.noise.duration - 0.4));
    src.stop(end);
    body.start(t);
    body.stop(end);
    body.onended = () => disconnectAll(src, bp, ce, body, be, ...extra);
  }

  /** Someone else walking past: a few quiet stone steps drifting across the stereo field. */
  private cityWalker(t: number): void {
    const g = this.g;
    if (!g) return;
    const steps = 3 + Math.floor(Math.random() * 5);
    const gap = rand(0.45, 0.6);
    let p = rand(-0.9, 0.9);
    const dp = (p > 0 ? -1 : 1) * rand(0.02, 0.07);
    const level = rand(0.2, 0.45);
    for (let i = 0; i < steps; i++) {
      this.stoneStep(t + i * gap + rand(-0.02, 0.02), rand(0.7, 1), level, p, g.cityBus);
      p = Math.max(-1, Math.min(1, p + dp));
    }
  }

  /** Small sounds of people busy nearby: cloth, a clay pot, a wooden knock, a tick. */
  private cityActivity(t: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const kind = pickOne(['rustle', 'rustle', 'pot', 'wood', 'tick'] as const);
    const dist = rand(0.4, 1);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.85, 0.85);
    pan.connect(g.cityBus);

    const noiseHit = (at: number, freq: number, q: number, att: number, dec: number, peak: number, rate = 1): void => {
      const src = ctx.createBufferSource();
      src.buffer = g.noise;
      src.playbackRate.value = rate;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = q;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(Math.max(peak, 2 * EPS), at + att);
      env.gain.exponentialRampToValueAtTime(EPS, at + att + dec);
      src.connect(bp).connect(env).connect(pan);
      src.start(at, Math.random() * (g.noise.duration - 0.6));
      src.stop(at + att + dec + 0.03);
      src.onended = () => disconnectAll(src, bp, env);
    };
    const tone = (at: number, freq: number, dec: number, peak: number): void => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(Math.max(peak, 2 * EPS), at + 0.002);
      env.gain.exponentialRampToValueAtTime(EPS, at + 0.002 + dec);
      o.connect(env).connect(pan);
      o.start(at);
      o.stop(at + dec + 0.03);
      o.onended = () => disconnectAll(o, env);
    };

    let end = t;
    if (kind === 'rustle') {
      const att = rand(0.06, 0.12);
      const dec = rand(0.15, 0.3);
      noiseHit(t, rand(2200, 3800), 0.8, att, dec, 0.02 * dist, rand(0.7, 1));
      end = t + att + dec;
    } else if (kind === 'pot') {
      const f = rand(320, 520);
      tone(t, f, 0.18, 0.012 * dist);
      tone(t, f * 2.7, 0.08, 0.004 * dist);
      end = t + 0.2;
    } else if (kind === 'wood') {
      const knocks = Math.random() < 0.35 ? 2 : 1;
      for (let k = 0; k < knocks; k++) {
        const at = t + k * rand(0.12, 0.2);
        const f = rand(600, 1000);
        noiseHit(at, f, 6, 0.002, 0.05, 0.05 * dist);
        tone(at, f, 0.06, 0.01 * dist);
        end = at + 0.06;
      }
    } else {
      noiseHit(t, rand(2600, 3400), 1, 0.001, 0.015, 0.012 * dist);
      end = t + 0.02;
    }
    // The shared panner outlives every hit; free it shortly after the last one.
    const keeper = ctx.createConstantSource();
    keeper.offset.value = 0;
    keeper.start(t);
    keeper.stop(end + 0.1);
    keeper.onended = () => disconnectAll(keeper, pan);
  }

  /** A large warm bell heard across the rooftops, tuned to D (or A). Mostly reverb. */
  private cityBell(t: number, freq: number, level: number, panV: number, decay: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    lp.Q.value = 0.5;
    const pan = ctx.createStereoPanner();
    pan.pan.value = panV;
    lp.connect(pan).connect(g.cityFarBus);
    const end = t + decay + 0.2;
    const nodes: AudioNode[] = [lp, pan];
    const oscs: OscillatorNode[] = [];
    const partial = (ratio: number, gl: number, dl: number, detuneHz: number): void => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * ratio + detuneHz;
      const env = ctx.createGain();
      const att = ratio < 1 ? 0.02 : 0.006;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(Math.max(level * gl, 2 * EPS), t + att);
      env.gain.exponentialRampToValueAtTime(EPS, t + att + decay * dl);
      o.connect(env).connect(lp);
      oscs.push(o);
      nodes.push(o, env);
    };
    for (const [r, gl, dl] of BELL_PARTIALS) partial(r, gl, dl, 0);
    // A slightly detuned twin of the strike tone gives the slow warm beat of a big bell.
    partial(1, 0.4, 0.7, rand(0.6, 1.2));
    for (const o of oscs) {
      o.start(t);
      o.stop(end);
    }
    oscs[0].onended = () => disconnectAll(...nodes);
  }

  /** Dusk: one slow tolling figure from a single tower, D and A. */
  private duskBells(t: number): void {
    const pattern = pickOne([
      [0, -5, 0, -5, 0],
      [0, 0, -5, 0],
      [-5, 0, -5, 0, 0],
    ]);
    const panV = rand(-0.5, 0.5);
    let at = t;
    pattern.forEach((semi, i) => {
      const lastOne = i === pattern.length - 1;
      this.cityBell(at, midiHz(D3 + semi), 0.055 * (1 - i * 0.05), panV, lastOne ? 11 : rand(7.5, 9));
      at += rand(2.6, 3.4);
    });
  }

  /** Two to four soft frame-drum strokes: low "dum" thumps and lighter rim taps. */
  private cityDrum(t: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const pattern = pickOne([
      [0, 0.5],
      [0, 0.36, 0.72],
      [0, 0.3, 0.45, 0.9],
      [0, 0.6, 0.9],
    ]);
    const tempo = rand(0.9, 1.2);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = rand(900, 1400);
    lp.Q.value = 0.5;
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.6, 0.6);
    lp.connect(pan).connect(g.cityFarBus);
    const base = rand(95, 130);
    let latest: AudioScheduledSourceNode | null = null;
    let latestEnd = 0;

    pattern.forEach((offset, i) => {
      const at = t + offset * tempo;
      const dum = i === 0 || Math.random() < 0.45;
      const lvl = (dum ? 0.07 : 0.035) * (i === 0 ? 1 : rand(0.6, 0.85));
      const nodes: AudioNode[] = [];
      // Pitched thump.
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f = dum ? base : base * 2.3;
      o.frequency.setValueAtTime(f * 1.6, at);
      o.frequency.exponentialRampToValueAtTime(f, at + 0.03);
      const oe = ctx.createGain();
      const od = dum ? 0.3 : 0.08;
      oe.gain.setValueAtTime(0, at);
      oe.gain.linearRampToValueAtTime(lvl, at + 0.004);
      oe.gain.exponentialRampToValueAtTime(EPS, at + 0.004 + od);
      o.connect(oe).connect(lp);
      // Skin noise.
      const n = ctx.createBufferSource();
      n.buffer = g.noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = dum ? rand(180, 320) : rand(1100, 1600);
      bp.Q.value = dum ? 1.2 : 1.5;
      const ne = ctx.createGain();
      const nd = dum ? 0.12 : 0.07;
      ne.gain.setValueAtTime(0, at);
      ne.gain.linearRampToValueAtTime(dum ? 0.12 : 0.05, at + 0.003);
      ne.gain.exponentialRampToValueAtTime(EPS, at + 0.003 + nd);
      n.connect(bp).connect(ne).connect(lp);
      const end = at + Math.max(od, nd) + 0.05;
      o.start(at);
      o.stop(end);
      n.start(at, Math.random() * (g.noise.duration - 0.5));
      n.stop(end);
      nodes.push(o, oe, n, bp, ne);
      o.onended = () => disconnectAll(...nodes);
      if (end > latestEnd) {
        latestEnd = end;
        latest = n;
      }
    });
    // Free the shared filter and panner when the last-ending stroke finishes.
    if (latest) {
      (latest as AudioScheduledSourceNode).onended = () => disconnectAll(lp, pan);
    }
  }

  /** Weighted random mood, so transitions blend chord by chord. Lightly sticky. */
  private pickMood(prev: MoodName): MoodName {
    const ws: MoodWeights = { ...this.w };
    ws[prev] = ws[prev] * 1.3 + 0.02;
    const sum = ws.day + ws.dusk + ws.night;
    let r = Math.random() * sum;
    for (const m of MOOD_NAMES) {
      r -= ws[m];
      if (r <= 0) return m;
    }
    return prev;
  }

  private dominantMood(): MoodName {
    let best: MoodName = 'day';
    for (const m of MOOD_NAMES) if (this.w[m] > this.w[best]) best = m;
    return best;
  }

  /** Starts a new pad chord at t; returns its duration before the next chord. */
  private playChord(t: number): number {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return 30;
    const moodName = this.pickMood(this.chordMood);
    const mood = MOODS[moodName];
    let idx = Math.floor(Math.random() * mood.chords.length);
    if (moodName === this.chordMood && idx === this.chordIdx) idx = (idx + 1) % mood.chords.length;
    // Return home to the first chord fairly often so harmony stays rooted.
    if (Math.random() < 0.3 && !(moodName === this.chordMood && this.chordIdx === 0)) idx = 0;
    this.chordMood = moodName;
    this.chordIdx = idx;

    const dur = rand(22, 38);
    // Blend the cutoff toward the global mood mix for smoother colour shifts.
    const mixCutoff =
      this.w.day * MOODS.day.padCutoff + this.w.dusk * MOODS.dusk.padCutoff + this.w.night * MOODS.night.padCutoff;
    const cutoff = 0.5 * mood.padCutoff + 0.5 * mixCutoff;
    for (const semi of mood.chords[idx]) {
      this.padVoice(t, midiHz(D3 + semi), dur, mood.padLevel, cutoff, g.padBus);
    }
    return dur;
  }

  /** One pad voice: detuned sine + triangle → drifting low-pass → slow envelope. */
  private padVoice(t: number, freq: number, dur: number, level: number, cutoff: number, dest: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const attack = rand(7, 11);
    const release = rand(7, 12);
    const end = t + dur + release + 1;
    const det = rand(3, 8);

    const a = ctx.createOscillator();
    a.type = 'sine';
    a.frequency.value = freq;
    a.detune.value = -det;
    const b = ctx.createOscillator();
    b.type = 'triangle';
    b.frequency.value = freq;
    b.detune.value = det;
    const bg = ctx.createGain();
    bg.gain.value = 0.45;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.4;
    const c0 = cutoff * rand(0.75, 1.1);
    lp.frequency.setValueAtTime(c0, t);
    lp.frequency.setTargetAtTime(cutoff * rand(0.8, 1.25), t + attack * 0.5, dur * 0.35);

    // Slow amplitude drift on its own node, so the envelope still reaches silence.
    const drift = ctx.createGain();
    drift.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rand(0.02, 0.07);
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = rand(0.12, 0.25);
    lfo.connect(lfoDepth).connect(drift.gain);

    // Quieter for higher notes so the voicing stays dark.
    const lvl = level * Math.min(1.2, Math.pow(220 / freq, 0.3));
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(lvl, t + attack);
    env.gain.setValueAtTime(lvl, t + dur);
    env.gain.setTargetAtTime(0, t + dur, release / 5);

    a.connect(lp);
    b.connect(bg).connect(lp);
    lp.connect(drift).connect(env).connect(dest);
    for (const o of [a, b, lfo]) {
      o.start(t);
      o.stop(end);
    }
    a.onended = () => disconnectAll(a, b, bg, lp, drift, lfo, lfoDepth, env);
  }

  /** One to three plucked notes; returns the gap until the next phrase. */
  private playPhrase(t: number): number {
    const g = this.g;
    if (!g) return 5;
    const mood = MOODS[this.pickMood(this.chordMood)];
    const count = Math.random() < mood.phraseChance ? (Math.random() < 0.6 ? 2 : 3) : 1;
    const dir = Math.random() < 0.5 ? -1 : 1;
    let at = t;
    for (let i = 0; i < count; i++) {
      // Melody wanders by small steps; phrases move in one direction.
      const step = i === 0 ? pickOne([-2, -1, -1, 1, 1, 2, 3, -3]) : dir * (Math.random() < 0.7 ? 1 : 2);
      let idx = this.melodyIdx + step;
      if (idx < mood.lo) idx = mood.lo + (mood.lo - idx);
      if (idx > mood.hi) idx = mood.hi - (idx - mood.hi);
      this.melodyIdx = Math.max(mood.lo, Math.min(mood.hi, idx));
      const level = mood.pluckLevel * rand(0.6, 1) * (i === 0 ? 1 : 0.8);
      this.bell(at, midiHz(scaleNote(mood, this.melodyIdx)), level, rand(3, 6), mood, g.pluckBus, rand(-0.5, 0.5));
      at += rand(0.35, 0.9);
    }
    return at - t + rand(2, 9) * mood.gapScale;
  }

  /** Soft plucked bell: sine plus a quiet upper partial, fast soft attack, exponential decay. */
  private bell(t: number, freq: number, level: number, decay: number, mood: Mood, dest: AudioNode, panV: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const att = mood.pluckAttack * rand(0.8, 1.3);
    const end = t + att + decay + 0.05;

    const pan = ctx.createStereoPanner();
    pan.pan.value = panV;

    const o1 = ctx.createOscillator();
    o1.type = 'sine';
    o1.frequency.value = freq;
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0, t);
    g1.gain.linearRampToValueAtTime(level, t + att);
    g1.gain.exponentialRampToValueAtTime(EPS, t + att + decay);

    // Upper partial decays faster, like a struck string or glass.
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq * mood.partial;
    o2.detune.value = rand(-4, 4);
    const g2 = ctx.createGain();
    const pl = Math.max(level * mood.partialGain, 2 * EPS);
    g2.gain.setValueAtTime(0, t);
    g2.gain.linearRampToValueAtTime(pl, t + att);
    g2.gain.exponentialRampToValueAtTime(EPS, t + att + decay * 0.4);

    o1.connect(g1).connect(pan);
    o2.connect(g2).connect(pan);
    pan.connect(dest);
    o1.start(t);
    o2.start(t);
    o1.stop(end);
    o2.stop(end);
    o1.onended = () => disconnectAll(o1, o2, g1, g2, pan);
  }

  /** Occasional very quiet D pedal; returns the wait until the next one. */
  private playDrone(t: number): number {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return 60;
    if (Math.random() < 0.55) {
      const hold = rand(20, 40);
      const atk = 10;
      const rel = 10;
      const end = t + atk + hold + rel + 1;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = midiHz(D3 - 12); // D2, ~73 Hz
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = midiHz(D3);
      o2.detune.value = 4;
      const g2 = ctx.createGain();
      g2.gain.value = 0.25;
      const env = ctx.createGain();
      const lvl = 0.03 + 0.01 * this.w.night;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(lvl, t + atk);
      env.gain.setValueAtTime(lvl, t + atk + hold);
      env.gain.setTargetAtTime(0, t + atk + hold, rel / 5);
      o.connect(env);
      o2.connect(g2).connect(env);
      env.connect(g.padBus);
      o.start(t);
      o2.start(t);
      o.stop(end);
      o2.stop(end);
      o.onended = () => disconnectAll(o, o2, g2, env);
      return atk + hold + rel + rand(15, 45);
    }
    return rand(30, 70);
  }

  // ----------------------------------------------------------- visibility

  private handleVisibility(): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || !this.started || this.disposed) return;
    const now = ctx.currentTime;
    if (document.hidden) {
      // Fade out, then suspend so nothing plays (or drifts) in the background.
      g.hide.gain.setTargetAtTime(0, now, 0.08);
      if (this.hideTimer) clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        if (this.ctx && document.hidden && this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined);
      }, 400);
    } else {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
      const fadeBack = (): void => {
        if (!this.ctx || !this.g) return;
        this.g.hide.gain.setTargetAtTime(1, this.ctx.currentTime, 0.6);
      };
      if (ctx.state !== 'running') void ctx.resume().then(fadeBack, () => undefined);
      else fadeBack();
    }
  }
}

// ----------------------------------------------------------- free helpers

/**
 * The events that count as a user gesture for audio. On a touch screen the start of a touch
 * (pointerdown, touchstart) does not; only its end does.
 */
const UNLOCK_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'] as const;
const UNLOCK_OPTS = { capture: true, passive: true } as const;

/**
 * On an iPhone, Web Audio is silenced by the ring/silent switch unless the page says it is
 * playing media. The game has its own volume controls, so it asks to be heard.
 */
function playThroughSilentSwitch(): void {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (!session) return;
  try {
    session.type = 'playback';
  } catch {
    /* not supported here: the switch keeps its say */
  }
}

function disconnectAll(...nodes: AudioNode[]): void {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

/** Target mood weights from the time of day: suspended moods around 0.25 and 0.75. */
function moodTarget(day: number, night: number): MoodWeights {
  const d = ((day % 1) + 1) % 1;
  const dist = Math.min(Math.abs(d - 0.25), Math.abs(d - 0.75));
  const tw = clamp01(1 - dist / 0.08);
  const n = clamp01(night);
  const w: MoodWeights = { day: (1 - n) * (1 - tw), dusk: tw, night: n * (1 - tw) };
  const sum = w.day + w.dusk + w.night || 1;
  w.day /= sum;
  w.dusk /= sum;
  w.night /= sum;
  return w;
}

/** Stereo decorrelated decaying noise, darkening over time, for the convolver. */
function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let y = 0;
    for (let i = 0; i < len; i++) {
      const p = i / len;
      const env = Math.exp(-6.9 * p) * Math.min(1, i / (sr * 0.012)); // -60 dB at the end, soft onset
      const k = 0.55 * Math.pow(1 - p, 1.5) + 0.03; // one-pole low-pass that closes over the tail
      y += k * (Math.random() * 2 - 1 - y);
      data[i] = y * env;
    }
  }
  return buf;
}

function makeWhiteNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** Pink-ish noise (Paul Kellet's economy filter), independent per channel, with a crossfaded loop seam. */
function makePinkNoise(ctx: BaseAudioContext, seconds: number, channels: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(channels, len, sr);
  const xf = Math.floor(sr * 0.5);
  for (let ch = 0; ch < channels; ch++) {
    // Generate len + xf samples; the extra tail is crossfaded into the head,
    // so sample len-1 flows straight into sample 0 when looping.
    const gen = new Float32Array(len + xf);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < gen.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      gen[i] = (b0 + b1 + b2 + white * 0.1848) * 0.18;
    }
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      if (i < xf) {
        const a = i / xf;
        data[i] = gen[i] * a + gen[len + i] * (1 - a);
      } else {
        data[i] = gen[i];
      }
    }
  }
  return buf;
}
