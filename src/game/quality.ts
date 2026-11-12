// Graphics tiers and automatic quality. The look is the same at every tier;
// lower tiers render fewer pixels, march shadows in fewer (longer) steps, bake
// a coarser heightmap, spawn less dust and trim optional fragment detail.
import type { Uniforms } from './contract';
import type { Clipmap } from '../world/clipmap';
import type { HeightBake } from '../world/heightBake';
import type { Dust } from '../world/dust';

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
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  high: { pixelBudget: 3.8e6, maxRatio: 2, samples: 4, shadowSteps: 30, clipLevels: 8, bakeSize: 2048, dust: 1, detail: 1 },
  low: { pixelBudget: 1.5e6, maxRatio: 1, samples: 0, shadowSteps: 22, clipLevels: 8, bakeSize: 2048, dust: 0.7, detail: 0.7 },
  // All 8 levels even here: level 8 is a thin band near the horizon (cheap), and
  // without it the ground ends 2-2.9 km out where fog is only ~55%, a hard edge.
  mobile: { pixelBudget: 0.95e6, maxRatio: 1.5, samples: 0, shadowSteps: 14, clipLevels: 8, bakeSize: 1024, dust: 0.4, detail: 0.4 },
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
export function applyQuality(q: QualitySettings, sys: { uniforms: Uniforms; clipmap: Clipmap; bake: HeightBake; dust: Dust }): void {
  setU(sys.uniforms, 'uShadowSteps', q.shadowSteps);
  setU(sys.uniforms, 'uDetail', q.detail);
  sys.clipmap.setLevels(q.clipLevels);
  sys.bake.setSize(q.bakeSize);
  sys.dust.setDensity(q.dust);
}

const SCALES = [1, 0.85, 0.7, 0.6];
const ORDER: QualityTier[] = ['high', 'low', 'mobile'];
const WINDOW_S = 2.5; // measuring window
const SETTLE_S = 1; // ignored after start and after any change
const MAX_FRAME_S = 0.25; // longer frames are tab switches or stalls
const FLOOR_FPS = 27;

/**
 * Watches real frame times and steps quality down when it cannot hold the floor.
 * First it lowers render scale (1 -> 0.85 -> 0.7 -> 0.6), then drops a tier (high -> low -> mobile) and resets scale to 1.
 * It measures over ~2.5 s windows, ignores the first second after start or after any change,
 * ignores frames longer than 250 ms (tab switches), and steps down when the average is below ~27 fps.
 * It never steps up on its own. After the user picks a tier by hand, call setTier and it restarts from there
 * (setTier does not call onChange; the caller applies the tier it picked).
 */
export class AutoQuality {
  private _tier: QualityTier;
  private scaleIdx = 0;
  private settle = SETTLE_S;
  private sum = 0;
  private frames = 0;
  private readonly onChange: (tier: QualityTier, renderScale: number) => void;

  constructor(tier: QualityTier, onChange: (tier: QualityTier, renderScale: number) => void) {
    this._tier = tier;
    this.onChange = onChange;
  }

  get tier(): QualityTier {
    return this._tier;
  }

  get renderScale(): number {
    return SCALES[this.scaleIdx];
  }

  /** Call once per displayed frame with the real (unclamped) frame time in seconds. */
  frame(realDtSeconds: number): void {
    const dt = realDtSeconds;
    if (!(dt > 0) || dt > MAX_FRAME_S) return;
    if (this.atFloor()) return;
    if (this.settle > 0) {
      this.settle -= dt;
      return;
    }
    this.sum += dt;
    this.frames++;
    if (this.sum < WINDOW_S) return;
    const fps = this.frames / this.sum;
    this.sum = 0;
    this.frames = 0;
    if (fps < FLOOR_FPS) this.stepDown();
  }

  setTier(tier: QualityTier): void {
    this._tier = tier;
    this.scaleIdx = 0;
    this.restart();
  }

  private atFloor(): boolean {
    return this._tier === 'mobile' && this.scaleIdx === SCALES.length - 1;
  }

  private stepDown(): void {
    if (this.scaleIdx < SCALES.length - 1) {
      this.scaleIdx++;
    } else {
      const i = ORDER.indexOf(this._tier);
      if (i < 0 || i >= ORDER.length - 1) return;
      this._tier = ORDER[i + 1];
      this.scaleIdx = 0;
    }
    this.restart();
    this.onChange(this._tier, this.renderScale);
  }

  private restart(): void {
    this.settle = SETTLE_S;
    this.sum = 0;
    this.frames = 0;
  }
}
