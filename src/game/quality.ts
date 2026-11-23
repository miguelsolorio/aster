// Graphics tiers and automatic quality. The look is the same at every tier;
// lower tiers render fewer pixels, march shadows in fewer (longer) steps, bake
// a coarser heightmap, spawn less dust and trim optional fragment detail.
import type { Uniforms } from './contract';
import type { Clipmap } from '../world/clipmap';
import type { HeightBake } from '../world/heightBake';
import { cityShadowQ, cityShadowQFor } from '../city/cityGlsl';
import type { Dust } from '../world/dust';
import type { TrailField } from '../world/trailField';

export type QualityTier = 'mobile' | 'low' | 'high';

export interface QualitySettings {
  pixelBudget: number; // max rendered pixels
  maxRatio: number; // cap on devicePixelRatio
  samples: number; // MSAA samples for the scene render target (0 = off)
  shadowSteps: number; // heightmap ray-march steps in the terrain shader
  clipLevels: number; // how many clipmap levels to draw (view distance)
  bakeSize: number; // heightmap resolution (2048 or 1024)
  dust: number; // 0..1 particle density scale
  detail: number; // 0..1 scale for optional fragment work
  trailRes: number; // texels per side of the footprint maps (same ground covered)
  trailScroll: number; // the footprint window re-centres in steps of this many texels
  trailDecay: number; // decay passes run this many times less often
  dustCapacity: number; // particles in the dust pool (at most 2200)
  dustMaxPx: number; // largest dust point drawn, in pixels
  cityShadowSteps: number; // masonry shadow march steps (26 = full; fewer steps are longer, same reach)
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  high: { pixelBudget: 3.8e6, maxRatio: 2, samples: 4, shadowSteps: 30, clipLevels: 8, bakeSize: 2048, dust: 1, detail: 1, trailRes: 1024, trailScroll: 1, trailDecay: 1, dustCapacity: 2200, dustMaxPx: 72, cityShadowSteps: 26 },
  low: { pixelBudget: 1.5e6, maxRatio: 1, samples: 0, shadowSteps: 22, clipLevels: 8, bakeSize: 2048, dust: 0.7, detail: 0.7, trailRes: 1024, trailScroll: 1, trailDecay: 1, dustCapacity: 2200, dustMaxPx: 72, cityShadowSteps: 26 },
  // All 8 levels even here: level 8 is a thin band near the horizon (cheap), and
  // without it the ground ends 2-2.9 km out where fog is only ~55%, a hard edge.
  mobile: { pixelBudget: 0.95e6, maxRatio: 1.25, samples: 0, shadowSteps: 14, clipLevels: 8, bakeSize: 1024, dust: 0.4, detail: 0.4, trailRes: 512, trailScroll: 4, trailDecay: 2, dustCapacity: 900, dustMaxPx: 32, cityShadowSteps: 12 },
};

/** 'mobile' on phones and tablets (coarse primary pointer or touch points with a small screen, or a mobile user agent), else 'high'. */
export function defaultTier(): QualityTier {
  if (typeof window === 'undefined') return 'high';
  const nav = window.navigator;
  const ua = nav.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return 'mobile';
  let coarse = false;
  try {
    coarse = window.matchMedia('(pointer: coarse)').matches;
  } catch {
    /* no matchMedia */
  }
  if (coarse) return 'mobile';
  // iPadOS reports a desktop Mac user agent; it still has touch points and a tablet-sized screen.
  const s = window.screen;
  const lo = Math.min(s?.width || window.innerWidth, s?.height || window.innerHeight);
  const hi = Math.max(s?.width || window.innerWidth, s?.height || window.innerHeight);
  const small = lo <= 1100 && hi <= 1400;
  return (nav.maxTouchPoints || 0) > 0 && small ? 'mobile' : 'high';
}

/**
 * Device pixel ratio to render at for a tier and render scale: min(dpr, maxRatio),
 * capped so w*h*ratio^2 <= pixelBudget, then multiplied by renderScale.
 * (The same rule resize() in main.ts uses, plus the scale.)
 */
export function pixelRatioFor(q: QualitySettings, renderScale: number, cssW: number, cssH: number, dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1): number {
  let ratio = Math.min(dpr, q.maxRatio);
  ratio = Math.min(ratio, Math.sqrt(q.pixelBudget / Math.max(1, cssW * cssH)));
  return ratio * renderScale;
}

function setU(u: Uniforms, name: string, value: number): void {
  const h = u[name];
  if (h) h.value = value;
  else u[name] = { value };
}

/**
 * Pushes a tier's settings into the systems. Safe to call repeatedly.
 * pixelBudget, maxRatio and samples belong to the caller's resize() (see pixelRatioFor).
 */
export function applyQuality(q: QualitySettings, sys: { uniforms: Uniforms; clipmap: Clipmap; bake: HeightBake; dust: Dust; trail?: TrailField }): void {
  setU(sys.uniforms, 'uShadowSteps', q.shadowSteps);
  setU(sys.uniforms, 'uDetail', q.detail);
  cityShadowQFor(q.cityShadowSteps, cityShadowQ.value);
  sys.clipmap.setLevels(q.clipLevels);
  sys.bake.setSize(q.bakeSize);
  sys.dust.setDensity(q.dust);
  sys.dust.setBudget(q.dustCapacity, q.dustMaxPx);
  sys.trail?.setQuality(q.trailRes, q.trailScroll, q.trailDecay);
}

const SCALES = [1, 0.85, 0.7, 0.6];
const ORDER: QualityTier[] = ['high', 'low', 'mobile'];
const DOWN_WINDOW_S = 3; // measuring window for stepping down
const SETTLE_S = 1; // ignored after start and after any change
const MAX_FRAME_S = 0.25; // longer frames are tab switches or stalls
const MISS_FRACTION = 0.1; // more than this share of frames missing the budget over a window steps down
const MISS_SLACK = 1.4; // a frame "misses" when it took longer than this many budgets (a skipped vsync is 2x)
const UNPACED_MISS_S = 1 / 27; // desktop (not paced): a frame slower than ~27 fps misses, as the old floor did
const UP_WINDOW_S = 10; // a good stretch this long (on top of the hold) before stepping up
const UP_HOLD_AFTER_DOWN_S = 30; // after any step down, no step-up evaluation for this long
const UP_MAX_MISS = 0.01; // up needs 99% of frames inside the budget over the stretch
const UP_WORK_FRACTION = 0.5; // ...and CPU+submit time (p90) under this share of the budget the new rung must hold
const PROBATION_S = 6; // a step down this soon after a step up means the up failed
const BACKOFF_START_S = 120;
const BACKOFF_MAX_S = 960;

export type Pace = 60 | 30;

/** Vsyncs per rendered frame for a pace target on a display refreshing every refreshS seconds (60 Hz: 1 and 2; 120 Hz: 2 and 4; 90 Hz: 1 and 3). */
export function paceDivisor(refreshS: number, pace: Pace): number {
  const hz = 1 / Math.max(0.002, refreshS);
  return Math.max(1, pace === 60 ? Math.floor(hz / 60 + 0.15) : Math.round(hz / 30));
}

interface Rung {
  tier: QualityTier;
  scaleIdx: number;
  pace: Pace;
}

/**
 * The next step down from (tier, scaleIdx), or null when there is nowhere left to go.
 * Render scale goes first (1 -> 0.85 -> 0.7 -> 0.6); at the lowest scale the tier drops
 * (high -> low -> mobile) and scale resets to 1. With lockTier (the player picked the tier
 * by hand) only the render scale is lowered and the tier is never changed.
 */
export function nextStep(tier: QualityTier, scaleIdx: number, lockTier: boolean): { tier: QualityTier; scaleIdx: number } | null {
  if (scaleIdx < SCALES.length - 1) return { tier, scaleIdx: scaleIdx + 1 };
  if (lockTier) return null;
  const i = ORDER.indexOf(tier);
  if (i < 0 || i >= ORDER.length - 1) return null;
  return { tier: ORDER[i + 1], scaleIdx: 0 };
}

function p90(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
}

/**
 * Watches real frame times and moves quality up and down, in terms of a pace target (60 or 30 fps).
 *
 * Down (measured over ~3 s windows): when more than 10% of frames miss the pace's budget,
 *  - at 60: lower render scale (1 -> 0.85 -> 0.7 -> 0.6); at the lowest scale switch the pace to 30 (scale back to 0.85,
 *    since 30 has twice the time);
 *  - at 30: lower render scale again, then drop a tier (high -> low -> mobile) and reset scale to 1.
 * Without pacing (desktop) there is no 30 rung: a frame misses when slower than ~27 fps, and scale then tier go down.
 *
 * Up: every step down is remembered. After ~30 s since the last down, a clean ~10 s stretch (99% of frames inside the budget
 * AND the frame's own CPU+submit time, 90th percentile, under half the budget the restored rung has to hold) undoes the
 * most recent step. Frame intervals alone cannot show headroom (a locked 30 looks perfect at any load), so the work time is
 * what says a step up is likely to hold; it is blind to GPU-bound cost, which is why the hysteresis exists: a step down
 * within 6 s of a step up counts as failed, and the next try waits 2 min, then 4, 8 ... (up to 16) until one survives.
 *
 * Ignores the first second after start or any change, and frames longer than 250 ms (tab switches).
 * After the user picks a tier by hand, call setTier(tier, true): it restarts from there at pace 60 and keeps that tier,
 * moving only render scale and pace (setTier does not call onChange; the caller applies the tier it picked).
 */
export class AutoQuality {
  private _tier: QualityTier;
  private scaleIdx = 0;
  private _pace: Pace = 60;
  private locked = false; // the player picked the tier by hand
  private _paced = true;
  private _refreshS = 1 / 60;
  private settle = SETTLE_S;
  private history: Rung[] = []; // rungs left behind by steps down, newest last
  private clock = 0; // seconds of counted frames, for probation
  private probationUntil = 0; // clock time until which a step down means the last step up failed
  private upHold = 0; // seconds before the step-up stretch starts counting
  private backoff = BACKOFF_START_S;
  // stepping-down window
  private dSum = 0;
  private dFrames = 0;
  private dMiss = 0;
  // stepping-up stretch
  private uSum = 0;
  private uFrames = 0;
  private uMiss = 0;
  private uWork: number[] = [];
  private readonly onChange: (tier: QualityTier, renderScale: number, pace: Pace) => void;

  constructor(tier: QualityTier, onChange: (tier: QualityTier, renderScale: number, pace: Pace) => void) {
    this._tier = tier;
    this.onChange = onChange;
  }

  get tier(): QualityTier {
    return this._tier;
  }

  get renderScale(): number {
    return SCALES[this.scaleIdx];
  }

  /** The frame-rate target: 60, or an even 30 (every other vsync of a 60 Hz display). Always 60 when not paced. */
  get pace(): Pace {
    return this._paced ? this._pace : 60;
  }

  get paced(): boolean {
    return this._paced;
  }

  get refreshS(): number {
    return this._refreshS;
  }

  /** Seconds between rendered frames at the current pace (the divisor times the display's refresh interval). */
  get targetIntervalS(): number {
    return paceDivisor(this._refreshS, this.pace) * this._refreshS;
  }

  /** The display's refresh interval, from rAF timestamps. */
  setRefresh(refreshS: number): void {
    if (refreshS > 0.002 && refreshS < 0.1) this._refreshS = refreshS;
  }

  /** Whether frames are paced (phones: yes; desktop: left as fast as the display goes). Turning it off puts the pace back to 60. */
  setPaced(paced: boolean): void {
    if (paced === this._paced) return;
    this._paced = paced;
    this.history = [];
    if (!paced && this._pace === 30) {
      this._pace = 60;
      this.scaleIdx = 1;
      this.onChange(this._tier, this.renderScale, this.pace);
    }
    this.restart();
  }

  /**
   * Call once per rendered frame with the real (unclamped) time since the previous rendered frame in seconds,
   * and the frame's own CPU+submit time (update + render calls) in seconds when known.
   */
  frame(realDtSeconds: number, workSeconds = 0): void {
    const dt = realDtSeconds;
    if (!(dt > 0) || dt > MAX_FRAME_S) return;
    const canDown = this.nextDown() !== null;
    const canUp = this.history.length > 0;
    if (!canDown && !canUp) return;
    if (this.settle > 0) {
      this.settle -= dt;
      return;
    }
    this.clock += dt;
    const miss = dt > this.missLimit() ? 1 : 0;

    if (canDown) {
      this.dSum += dt;
      this.dFrames++;
      this.dMiss += miss;
      if (this.dSum >= DOWN_WINDOW_S) {
        const bad = this.dMiss / this.dFrames > MISS_FRACTION;
        this.dSum = this.dFrames = this.dMiss = 0;
        if (bad) {
          this.stepDown();
          return;
        }
      }
    }

    if (canUp) {
      if (this.upHold > 0) {
        this.upHold -= dt;
        return;
      }
      this.uSum += dt;
      this.uFrames++;
      this.uMiss += dt > this.upMissLimit() ? 1 : 0;
      this.uWork.push(workSeconds);
      if (this.uSum >= UP_WINDOW_S) {
        const target = this.history[this.history.length - 1];
        const budget = paceDivisor(this._refreshS, this._paced ? target.pace : 60) * this._refreshS;
        const good = this.uMiss / this.uFrames <= UP_MAX_MISS && p90(this.uWork) <= UP_WORK_FRACTION * budget;
        this.resetUp();
        if (good) this.stepUp();
      }
    }
  }

  setTier(tier: QualityTier, manual = false): void {
    this._tier = tier;
    this.locked = manual;
    this.scaleIdx = 0;
    this._pace = 60;
    this.history = [];
    this.restart();
  }

  private missLimit(): number {
    return this._paced ? this.targetIntervalS * MISS_SLACK : UNPACED_MISS_S;
  }

  private upMissLimit(): number {
    return this._paced ? this.targetIntervalS * MISS_SLACK : 1 / 40;
  }

  private nextDown(): Rung | null {
    if (this._paced && this._pace === 60 && this.scaleIdx >= SCALES.length - 1) return { tier: this._tier, scaleIdx: 1, pace: 30 };
    const n = nextStep(this._tier, this.scaleIdx, this.locked);
    return n ? { ...n, pace: this._pace } : null;
  }

  private stepDown(): void {
    const next = this.nextDown();
    if (!next) return;
    this.history.push({ tier: this._tier, scaleIdx: this.scaleIdx, pace: this._pace });
    if (this.clock < this.probationUntil) {
      // a step up that did not hold: wait much longer before the next try
      this.upHold = this.backoff;
      this.backoff = Math.min(BACKOFF_MAX_S, this.backoff * 2);
      this.probationUntil = 0;
    } else {
      this.upHold = UP_HOLD_AFTER_DOWN_S;
    }
    this.apply(next);
  }

  private stepUp(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.probationUntil = this.clock + PROBATION_S;
    this.upHold = 0;
    this.apply(prev);
  }

  private apply(r: Rung): void {
    this._tier = r.tier;
    this.scaleIdx = r.scaleIdx;
    this._pace = r.pace;
    this.restart();
    this.onChange(this._tier, this.renderScale, this.pace);
  }

  private resetUp(): void {
    this.uSum = this.uFrames = this.uMiss = 0;
    this.uWork.length = 0;
  }

  private restart(): void {
    this.settle = SETTLE_S;
    this.dSum = this.dFrames = this.dMiss = 0;
    this.resetUp();
    // a successful step up was proven by surviving its probation: forget the back-off
    if (this.clock >= this.probationUntil) this.backoff = BACKOFF_START_S;
  }
}
