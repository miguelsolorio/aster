// The gallery styles, turned into looks the game can wear.
//
// A gallery style has five colours at three times of day. The game's day cycle has
// four keys (night, twilight, sunset, day) of eleven colours each, plus fog and glow.
// The missing pieces are derived: rock, salt and snow are tinted off each key's lit
// and shade, and the twilight key is blended from sunset and night with lit pulled
// down toward shade (that is what hides the hand-over from sun to moon).
//
// "35 mm" is the game's own hand-tuned look and is not derived.
import * as THREE from 'three';
import { STYLES } from '../render/styles';
import { DEFAULTS, type Pal, type Params, type Style } from '../render/types';
import { FILM_LOOK, KEY_ELEVATIONS, hexV, type DayLook, type Key } from './daycycle';

/** The densest fog the game allows, so a city skyline stays findable about 2 km out. */
export const FOG_CAP = 0.0012;

// Fog and glow of the 35 mm keys, scaled by each style's fog and glow.
const FILM_FOG = [0.0004, 0.00055, 0.0006, 0.00042];
const FILM_GLOW = [0.5, 0, 1.7, 1.0];

// The game's 35 mm is the gallery's, plus the glints the sand has always had.
const FILM_GAME: Partial<Params> = { sparkle: 0.35 };

const INK = '#1a1410';
const PAPER = '#f4ecdc';
const FIG = '#1c1512';

export interface Look {
  id: string;
  name: string;
  params: Params;
  day: DayLook;
  ink: THREE.Vector3;
  paper: THREE.Vector3;
}

const WHITE = new THREE.Vector3(1, 1, 1);
const mixV = (a: THREE.Vector3, b: THREE.Vector3, t: number) => a.clone().lerp(b, t);

/** Fills rock, salt and snow from a key's sand and sky colours. */
function materials(k: Omit<Key, 'rockLit' | 'rockShade' | 'saltLit' | 'saltShade' | 'snowLit' | 'snowShade'>): Key {
  const rockLit = mixV(k.lit.clone().multiplyScalar(0.74), k.shade, 0.12);
  const rockShade = k.shade.clone().multiplyScalar(0.56);
  const saltLit = mixV(k.lit, WHITE, 0.72);
  const saltShade = mixV(k.shade, saltLit, 0.42);
  const snowLit = mixV(k.lit, mixV(k.sun, WHITE, 0.5), 0.88);
  const snowShade = mixV(mixV(k.shade, k.top, 0.5), snowLit, 0.4);
  return { ...k, rockLit, rockShade, saltLit, saltShade, snowLit, snowShade };
}

function palKey(i: number, pal: Pal, ink: string, paper: string, fogMul: number, glow: number): Key {
  return materials({
    el: KEY_ELEVATIONS[i],
    top: hexV(pal.top),
    horizon: hexV(pal.horizon),
    lit: hexV(pal.lit),
    shade: hexV(pal.shade),
    sun: hexV(pal.sun),
    fog: Math.min(FOG_CAP, FILM_FOG[i] * fogMul),
    glow: FILM_GLOW[i] * glow,
    a: hexV(pal.a ?? ink),
    b: hexV(pal.b ?? paper),
    line: hexV(pal.line ?? ink),
  });
}

function twilight(set: Key, night: Key, fogMul: number, glow: number): Key {
  const lit = mixV(set.lit, night.lit, 0.5);
  const shade = mixV(set.shade, night.shade, 0.5);
  return materials({
    el: KEY_ELEVATIONS[1],
    top: mixV(set.top, night.top, 0.5),
    horizon: mixV(set.horizon, night.horizon, 0.4),
    lit: lit.lerp(shade, 0.5),
    shade,
    sun: mixV(set.sun, night.sun, 0.25),
    fog: Math.min(FOG_CAP, FILM_FOG[1] * fogMul),
    glow: FILM_GLOW[1] * glow,
    a: mixV(set.a, night.a, 0.5),
    b: mixV(set.b, night.b, 0.5),
    line: mixV(set.line, night.line, 0.5),
  });
}

function build(style: Style): Look {
  const ink = style.ink ?? INK;
  const paper = style.paperCol ?? PAPER;
  if (style.id === 'film') {
    return { id: style.id, name: style.name, params: { ...DEFAULTS, ...style.p, ...FILM_GAME }, day: FILM_LOOK, ink: hexV(ink), paper: hexV(paper) };
  }
  const params: Params = { ...DEFAULTS, ...style.p };
  const fogMul = params.fog / DEFAULTS.fog;
  const night = palKey(0, style.pal.night, ink, paper, fogMul, params.glow);
  const sunset = palKey(2, style.pal.sunset, ink, paper, fogMul, params.glow);
  const day = palKey(3, style.pal.day, ink, paper, fogMul, params.glow);
  const keys = [night, twilight(sunset, night, fogMul, params.glow), sunset, day];
  return {
    id: style.id,
    name: style.name,
    params,
    day: { keys, stars: params.starAmt, fig: hexV(style.fig ?? FIG) },
    ink: hexV(ink),
    paper: hexV(paper),
  };
}

/** Every look, in gallery order. The first (35 mm) is the game's look. */
export const LOOKS: Look[] = STYLES.map(build);

export function lookIndex(id: string | null | undefined): number {
  const i = LOOKS.findIndex((l) => l.id === id);
  return i < 0 ? 0 : i;
}

const KEY_UNLOCK = 'aster.styles';

/**
 * The style picker is a hidden tool, not a player setting. ?styles turns it on for this
 * device (and it stays on); ?styles=0 turns it off again. While it is off the game is 35 mm.
 */
export function stylesUnlocked(qs: URLSearchParams): boolean {
  try {
    if (qs.has('styles')) {
      if (qs.get('styles') === '0') localStorage.removeItem(KEY_UNLOCK);
      else localStorage.setItem(KEY_UNLOCK, '1');
    }
    return localStorage.getItem(KEY_UNLOCK) === '1';
  } catch {
    return qs.has('styles') && qs.get('styles') !== '0';
  }
}
