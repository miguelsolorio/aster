// Desertscape audio: fully synthesised generative ambient score, wind and
// footsteps, built on the Web Audio API with no samples and no libraries.
//
// Signal flow
//   pads ──┐                          ┌─ dry ─────────────┐
//   plucks ┼─ buses ─ sends ─ reverb ─┤                    ├─ music ─┐
//   chime ─┘          └─ delay ───────┘                    │         │
//   wind / sand hiss ─────────────────────────────────────────────── preMaster
//   footsteps / landings ─────────────────────────────────────────── ┘
//   preMaster → high-shelf cut → pause low-pass → pause duck → limiter
//             → start fade → volume → visibility gain → speakers

export interface AudioFrame {
  dt: number;
  day: number; // 0..1 fraction of day: 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset
  night: number; // 0 day .. 1 full night
  speed: number; // player horizontal speed m/s (walk ~5, run ~9, sliding up to ~25)
  sliding: boolean;
  grounded: boolean;
  gust: number; // 0..1 slow-varying wind strength
  altitude: number; // metres above the local base level, roughly 0..400
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
  windSrc: AudioBufferSourceNode;
  windBP: BiquadFilterNode;
  windGain: GainNode;
  whistleBP: BiquadFilterNode;
  whistleGain: GainNode;
  hissSrc: AudioBufferSourceNode;
  hissBP: BiquadFilterNode;
  hissGain: GainNode;
  noise: AudioBuffer; // short mono noise for one-shots
}

type MoodWeights = Record<MoodName, number>;

// ------------------------------------------------------------ the engine

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private g: Graph | null = null;
  private started = false;
  private disposed = false;
  private paused = false;
  private vol = 0.8;

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

  private paramTimer = 0;
  private clock = 0;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onVisibility = (): void => this.handleVisibility();

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  /** Must be called from a user gesture. Creates/resumes the context and fades in over ~4 s. */
  async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.g = this.build(this.ctx);
    }
    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        /* resume can reject outside a gesture; a later start() retries */
      }
    }
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

  setVolume(v: number): void {
    this.vol = clamp01(v);
    if (this.ctx && this.g) this.g.volume.gain.setTargetAtTime(this.vol, this.ctx.currentTime, 0.12);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (!this.ctx || !this.g) return;
    const now = this.ctx.currentTime;
    this.g.pauseGain.gain.setTargetAtTime(p ? 0.35 : 1, now, 0.25);
    this.g.pauseLP.frequency.setTargetAtTime(p ? 750 : 18000, now, 0.25);
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

    this.paramTimer += dt;
    if (this.paramTimer >= 0.1) {
      this.paramTimer = 0;
      this.applyParams(f, ctx.currentTime);
    }

    this.schedule(ctx.currentTime);
  }

  footstep(strength: number, onRock: boolean): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const s = clamp01(strength);
    if (s <= 0.01) return;
    const t = ctx.currentTime + 0.005;
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

  /** A soft rising figure of three or four bell notes in the current mode. */
  chime(): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const mood = MOODS[this.dominantMood()];
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    if (this.hideTimer) clearTimeout(this.hideTimer);
    const ctx = this.ctx;
    const g = this.g;
    if (g) {
      try {
        g.windSrc.stop();
        g.hissSrc.stop();
      } catch {
        /* already stopped */
      }
    }
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
    const padBus = gain(1);
    const padRev = gain(0.45);
    padBus.connect(music);
    padBus.connect(padRev).connect(reverbIn);

    // Plucks.
    const pluckBus = gain(1);
    const pluckDry = gain(0.7);
    const pluckRev = gain(0.5);
    const pluckDelay = gain(0.35);
    pluckBus.connect(pluckDry).connect(music);
    pluckBus.connect(pluckRev).connect(reverbIn);
    pluckBus.connect(pluckDelay).connect(delayIn);

    // Chime: mostly reverb.
    const chimeBus = gain(1);
    chimeBus.connect(gain(0.55)).connect(music);
    chimeBus.connect(gain(0.95)).connect(reverbIn);
    chimeBus.connect(gain(0.3)).connect(delayIn);

    // Footsteps and landings: mostly dry, a touch of space.
    const sfxBus = gain(1);
    sfxBus.connect(preMaster);
    sfxBus.connect(gain(0.08)).connect(reverbIn);

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
    windSrc.connect(windBP).connect(windGain).connect(preMaster);
    windSrc.connect(whistleBP).connect(whistleGain).connect(preMaster);
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
    hissSrc.connect(hissHP).connect(hissBP).connect(hissGain).connect(preMaster);
    hissSrc.start(0, 3 + Math.random() * 3);

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
      windSrc,
      windBP,
      windGain,
      whistleBP,
      whistleGain,
      hissSrc,
      hissBP,
      hissGain,
      noise: makeWhiteNoise(ctx, 2),
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
    const rush = clamp01((f.speed - 8) / 17);

    const windLevel = 0.025 + 0.07 * gust + 0.04 * alt + 0.015 * breathe + 0.07 * rush;
    const windFreq = 280 + 420 * gust + 260 * alt + 120 * breathe + 700 * rush;
    g.windGain.gain.setTargetAtTime(windLevel, now, 1.2);
    g.windBP.frequency.setTargetAtTime(windFreq, now, 1.5);
    g.whistleGain.gain.setTargetAtTime(0.006 * gust * (0.3 + alt) * breathe, now, 2);
    g.whistleBP.frequency.setTargetAtTime(700 + 500 * gust + 400 * alt + 200 * breathe, now, 2.5);

    const sand = f.sliding && f.grounded ? clamp01((f.speed - 2) / 16) : 0;
    g.hissGain.gain.setTargetAtTime(0.045 * sand, now, sand > 0 ? 0.25 : 0.6);
    g.hissBP.frequency.setTargetAtTime(4500 + 2500 * sand, now, 0.5);

    // Night: more reverb, less dry pluck.
    g.padRev.gain.setTargetAtTime(0.42 + 0.25 * wn, now, 3);
    g.pluckRev.gain.setTargetAtTime(0.5 + 0.35 * wn, now, 3);
    g.pluckDry.gain.setTargetAtTime(0.7 - 0.32 * wn, now, 3);
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
