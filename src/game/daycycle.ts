import * as THREE from 'three';
import type { Uniforms } from './contract';

const v = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

interface Key {
  el: number; // sun elevation (sine) this key sits at
  top: THREE.Vector3;
  horizon: THREE.Vector3;
  lit: THREE.Vector3;
  shade: THREE.Vector3;
  sun: THREE.Vector3;
  rockLit: THREE.Vector3;
  rockShade: THREE.Vector3;
  saltLit: THREE.Vector3;
  saltShade: THREE.Vector3;
  snowLit: THREE.Vector3;
  snowShade: THREE.Vector3;
  fog: number;
  glow: number;
}

const key = (el: number, c: string[], fog: number, glow: number): Key => ({
  el,
  top: v(c[0]),
  horizon: v(c[1]),
  lit: v(c[2]),
  shade: v(c[3]),
  sun: v(c[4]),
  rockLit: v(c[5]),
  rockShade: v(c[6]),
  saltLit: v(c[7]),
  saltShade: v(c[8]),
  snowLit: v(c[9]),
  snowShade: v(c[10]),
  fog,
  glow,
});

// The "35 mm" look across the day, keyed on how high the sun is.
// At the twilight key lit and shade nearly meet, which hides the hand-over from sun to moon.
const KEYS: Key[] = [
  key(-0.24, ['#050d1a', '#12303a', '#5f8a8c', '#0e1c24', '#d8f0e6', '#4a6a70', '#0c181e', '#8ab0b4', '#1a2a34', '#9cc2c8', '#1c3040'], 0.0004, 0.5),
  key(-0.07, ['#10304a', '#b8785e', '#5a5058', '#2c2a36', '#ffb070', '#4c4248', '#262430', '#7a7078', '#3a3644', '#8e8690', '#444056'], 0.00055, 0.0),
  key(0.09, ['#153a5c', '#e9a25a', '#d98a3c', '#4a2a22', '#ffcf8a', '#c46a34', '#3a2020', '#f0b888', '#6a4a48', '#ffd6a6', '#7c6a86'], 0.0006, 1.7),
  key(0.4, ['#0f4f6e', '#7fc3a6', '#d9a04e', '#6e4a24', '#fff1c9', '#a5643a', '#38211a', '#efe6d2', '#9a8c7a', '#f8f5ec', '#8fa6be'], 0.00042, 1.0),
];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Advances the time of day and writes the light and palette into the shared uniforms. */
export class DayCycle {
  /** 0..1: 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. */
  day: number;
  night = 0;
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  readonly lightDir = new THREE.Vector3();

  constructor(
    private u: Uniforms,
    start: number,
    /** Real seconds for one full day. */
    public length = 1200,
  ) {
    this.day = start;
    const vec = (name: string) => (u[name] ??= { value: new THREE.Vector3() });
    for (const n of ['uSunDir', 'uTop', 'uHorizon', 'uLit', 'uShade', 'uSunCol', 'uFogCol', 'uRockLit', 'uRockShade', 'uSaltLit', 'uSaltShade', 'uSnowLit', 'uSnowShade', 'uSunPos', 'uMoonPos', 'uFig', 'uFigLit']) {
      vec(n);
    }
    for (const n of ['uFog', 'uNight', 'uGlow', 'uStars', 'uMoonVis']) u[n] ??= { value: 0 };
    this.update(0);
  }

  update(dt: number) {
    const u = this.u;
    this.day = (this.day + dt / this.length) % 1;
    const a = (this.day - 0.25) * Math.PI * 2;
    this.sunDir.set(Math.cos(a), Math.sin(a) * 0.9, 0.36).normalize();
    // The moon rides opposite the sun, so it is up for the whole night.
    this.moonDir.set(-this.sunDir.x, -this.sunDir.y, 0.5).normalize();
    const el = this.sunDir.y;

    // Palette: piecewise-linear between keys.
    let i = 0;
    while (i < KEYS.length - 2 && el > KEYS[i + 1].el) i++;
    const k0 = KEYS[i];
    const k1 = KEYS[i + 1];
    const f = Math.min(1, Math.max(0, (el - k0.el) / (k1.el - k0.el)));
    const mix = (name: string, a0: THREE.Vector3, a1: THREE.Vector3) => (u[name].value as THREE.Vector3).copy(a0).lerp(a1, f);
    mix('uTop', k0.top, k1.top);
    mix('uHorizon', k0.horizon, k1.horizon);
    mix('uLit', k0.lit, k1.lit);
    mix('uShade', k0.shade, k1.shade);
    mix('uSunCol', k0.sun, k1.sun);
    mix('uRockLit', k0.rockLit, k1.rockLit);
    mix('uRockShade', k0.rockShade, k1.rockShade);
    mix('uSaltLit', k0.saltLit, k1.saltLit);
    mix('uSaltShade', k0.saltShade, k1.saltShade);
    mix('uSnowLit', k0.snowLit, k1.snowLit);
    mix('uSnowShade', k0.snowShade, k1.snowShade);
    (u.uFogCol.value as THREE.Vector3).copy(u.uHorizon.value);
    u.uFog.value = k0.fog + (k1.fog - k0.fog) * f;
    u.uGlow.value = k0.glow + (k1.glow - k0.glow) * f;

    this.night = smooth(0.02, -0.22, el);
    u.uNight.value = this.night;
    u.uStars.value = smooth(-0.02, -0.2, el);
    u.uMoonVis.value = smooth(-0.04, -0.14, el);

    // The light is the sun until twilight, then the moon. Never let it shine from below.
    const src = el > -0.07 ? this.sunDir : this.moonDir;
    this.lightDir.copy(src);
    this.lightDir.y = Math.max(this.lightDir.y, 0.05);
    this.lightDir.normalize();
    (u.uSunDir.value as THREE.Vector3).copy(this.lightDir);
    (u.uSunPos.value as THREE.Vector3).copy(this.sunDir);
    (u.uMoonPos.value as THREE.Vector3).copy(this.moonDir);

    (u.uFig.value as THREE.Vector3).set(0.11, 0.082, 0.07).lerp(u.uShade.value, 0.25);
    (u.uFigLit.value as THREE.Vector3).copy(u.uFig.value).lerp(u.uLit.value, 0.45);
  }
}
