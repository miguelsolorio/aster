import type { Pal, Style } from './types';

const P = (top: string, horizon: string, lit: string, shade: string, sun: string, extra: Partial<Pal> = {}): Pal => ({
  top,
  horizon,
  lit,
  shade,
  sun,
  ...extra,
});

// A neutral, believable desert used by styles whose look comes from post-processing.
const NATURAL = {
  day: P('#2f6fb0', '#c9dbe0', '#e2b77a', '#9a6a45', '#fff6dc'),
  sunset: P('#33486e', '#f2a65a', '#e98f47', '#5a2f3a', '#ffd08a'),
  night: P('#070b1c', '#1c2a4a', '#6f86b0', '#141c36', '#dfe8ff'),
};

export const STYLES: Style[] = [
  {
    id: 'film',
    name: '35 mm',
    blurb: 'Teal sky, gold sand, film grain and soft vignette.',
    pal: {
      day: P('#0f4f6e', '#7fc3a6', '#d9a04e', '#6e4a24', '#fff1c9'),
      sunset: P('#153a5c', '#e9a25a', '#d98a3c', '#4a2a22', '#ffcf8a'),
      night: P('#050d1a', '#12303a', '#5f8a8c', '#0e1c24', '#d8f0e6'),
    },
    p: { grain: 0.1, vig: 0.55, chroma: 0.003, sat: 0.92, ripple: 0.9, rippleBig: 0.45, termSharp: 0.6 },
  },
  {
    id: 'haze',
    name: 'Dust Haze',
    blurb: 'Low contrast, heavy air, a pale sun through blown sand.',
    pal: {
      day: P('#a39480', '#cbb99b', '#b08a62', '#7a5c42', '#fff3d6'),
      sunset: P('#7a6250', '#d9a877', '#b9794a', '#5e4034', '#ffe0a6'),
      night: P('#1b1d24', '#343640', '#6c6e78', '#2a2c34', '#e6e6e0'),
    },
    p: { fog: 0.004, glow: 2.6, grain: 0.06, vig: 0.4, mtn: 0.5, shadowK: 3, termSharp: 0.2, starAmt: 0.3 },
  },
  {
    id: 'golden',
    name: 'Golden Hour',
    blurb: 'Warm natural light, long shadows, glinting grains.',
    pal: {
      day: P('#4e86b8', '#e8d9b8', '#f0c27a', '#a8703f', '#fff7df'),
      sunset: P('#5b5f86', '#ffc070', '#f7a348', '#6a3a2e', '#ffe2a0'),
      night: P('#0a1026', '#26335a', '#8094ba', '#1a2342', '#eef2ff'),
    },
    p: { sparkle: 0.9, glow: 1.4, grain: 0.035, ripple: 0.7 },
  },
  {
    id: 'knife',
    name: 'Knife Edge',
    blurb: 'Hard split along every crest: burnt orange against near black.',
    pal: {
      day: P('#5d7f9e', '#b9c4c8', '#e08a2c', '#1f0d08', '#ffffff'),
      sunset: P('#2a2f4a', '#d9703a', '#e06a1c', '#140606', '#ffb86a'),
      night: P('#03040a', '#101830', '#7c8fb5', '#04050c', '#f0f4ff'),
    },
    p: { termSharp: 1, shadowK: 24, ripple: 0.25, rippleBig: 0.2, fog: 0.0003, contrast: 1.08, grain: 0.02, flat: 0.6 },
  },
  {
    id: 'ember',
    name: 'Ember',
    blurb: 'One hue only. Sky, sand and figure all burn orange.',
    pal: {
      day: P('#e8742a', '#f5a54a', '#f08a2e', '#a3401a', '#ffe9b0'),
      sunset: P('#b53a14', '#f07a22', '#d9581a', '#5c1a0e', '#ffd27a'),
      night: P('#2a0a06', '#6a1c0c', '#a8401a', '#2e0c08', '#ff9a4a'),
    },
    fig: '#2a0c06',
    p: { fog: 0.0016, glow: 2, grain: 0.05, vig: 0.4, starAmt: 0.25, sunScale: 1.6 },
  },
  {
    id: 'cobalt',
    name: 'Silver & Cobalt',
    blurb: 'Pale silver sand with deep blue shadows, cool at every hour.',
    pal: {
      day: P('#3b63a8', '#b8c8e8', '#dfe4f2', '#6f7fb0', '#ffffff'),
      sunset: P('#2c2f6e', '#e79ab0', '#f0c0c0', '#54508e', '#ffd9c8'),
      night: P('#050818', '#1a2a5c', '#8aa4e0', '#0c1434', '#f4f8ff'),
    },
    fig: '#101a3a',
    p: { sparkle: 0.6, termSharp: 0.7, starAmt: 1.4, grain: 0.025 },
  },
  {
    id: 'ripple',
    name: 'Red Ripple',
    blurb: 'Saturated red sand, violet shadows, ripples you can count.',
    pal: {
      day: P('#2c4fa0', '#c9b8c8', '#e2552a', '#5a1e3a', '#fff4e0'),
      sunset: P('#3a2a6a', '#f08a5a', '#f04a1c', '#3c1238', '#ffd0a0'),
      night: P('#0a0c2a', '#3a3470', '#c8462a', '#2a1038', '#ffd8c0'),
    },
    p: { ripple: 1.3, rippleBig: 1.5, termSharp: 0.75, starAmt: 1.3, sat: 1.08 },
  },
  {
    id: 'poster',
    name: 'Travel Poster',
    blurb: 'Flat two-tone dunes, banded sky and an oversized sun.',
    pal: {
      day: P('#2a9d8f', '#e9f0c9', '#f4a261', '#c8553d', '#fff8e7'),
      sunset: P('#264653', '#e76f51', '#f4a261', '#7a2e3a', '#ffe8b0'),
      night: P('#0b132b', '#1c2541', '#6b8fd6', '#1b2a5a', '#fdf6e3'),
    },
    fig: '#1d2433',
    p: { bands: 1, flat: 1, termSharp: 1, shadowK: 40, ripple: 0, rippleBig: 0, sunScale: 3, glow: 0.2, skyBands: 5, grain: 0, vig: 0, fog: 0.0004 },
  },
  {
    id: 'lowpoly',
    name: 'Low Poly',
    blurb: 'Faceted dunes like folded paper, flat colour per face.',
    pal: {
      day: P('#5aa9e6', '#dff3ff', '#f6cf8a', '#c98f55', '#ffffff'),
      sunset: P('#5a4a8a', '#ffb37a', '#f79a5a', '#8a4a52', '#ffe6b0'),
      night: P('#0d1330', '#2a3a6e', '#7a8fd0', '#25305e', '#f4f6ff'),
    },
    p: { facet: 1, flat: 1, shadowAmt: 0.55, shadowK: 3, ripple: 0, rippleBig: 0, grain: 0, vig: 0.1, glow: 0.6, termSharp: 0.2 },
  },
  {
    id: 'ink',
    name: 'Ink & Wash',
    blurb: 'Brush outlines over thin washes on warm paper.',
    pal: {
      day: P('#d8d2c2', '#efe9da', '#ead9b8', '#b59f82', '#fffaf0'),
      sunset: P('#c9b8a8', '#f0cfa8', '#e8c090', '#9a7a6a', '#fff0d0'),
      night: P('#3a4250', '#5a6470', '#8a94a0', '#4a525e', '#f0f0e8'),
    },
    ink: '#2a2420',
    p: { outline: 1, outlineW: 1.3, bands: 3, bandNoise: 0.5, flat: 1, paper: 0.6, wobble: 0.5, ripple: 0, rippleBig: 0.3, grain: 0.02, glow: 0.4, shadowK: 30, starAmt: 0.5 },
  },
  {
    id: 'map',
    name: 'Survey Map',
    blurb: 'Contour lines drawn over the terrain, like a walked-on map.',
    pal: {
      day: P('#e9e4d4', '#f4f0e4', '#f2e6c8', '#dcc9a0', '#ffffff', { line: '#8a5a34' }),
      sunset: P('#f0d0b0', '#f8e4c8', '#f6d8a8', '#e0a878', '#fff4d8', { line: '#8a3a24' }),
      night: P('#101828', '#182438', '#1c2a44', '#111a2e', '#cfe4ff', { line: '#7fb4e0' }),
    },
    fig: '#3a2418',
    p: { contour: 1, flat: 1, ripple: 0, rippleBig: 0, shadowAmt: 0.5, shadowK: 4, termSharp: 0.2, glow: 0.3, grain: 0.015, vig: 0.1, paper: 0.25, mtn: 0.5, starAmt: 0.4 },
  },
  {
    id: 'riso',
    name: 'Two-Ink Print',
    blurb: 'Halftone dots in pink and blue, slightly out of register.',
    pal: {
      day: P('#2f6fb0', '#c9dbe0', '#e2b77a', '#9a6a45', '#ffffff', { a: '#ff4f8b', b: '#2b4fc7' }),
      sunset: P('#33486e', '#f2a65a', '#e98f47', '#5a2f3a', '#ffe8c0', { a: '#ff5a3c', b: '#3a2f9a' }),
      night: P('#070b1c', '#1c2a4a', '#6f86b0', '#141c36', '#ffffff', { a: '#ff4f8b', b: '#1f2f8f' }),
    },
    paperCol: '#f6efe2',
    p: { mode: 1, bands: 3, flat: 1, ripple: 0, rippleBig: 0.4, paper: 0.35, grain: 0.03, vig: 0, glow: 0.5, termSharp: 0.8 },
  },
  {
    id: 'onebit',
    name: 'One Bit',
    blurb: 'Two colours and an ordered dither, like an early handheld.',
    pal: {
      day: { ...NATURAL.day, a: '#2b1d14', b: '#f0dfb8' },
      sunset: { ...NATURAL.sunset, a: '#3a1410', b: '#ffb86a' },
      night: { ...NATURAL.night, a: '#0b0f1e', b: '#a9b8e0' },
    },
    p: { mode: 2, pixelRows: 180, grain: 0, vig: 0, ripple: 0, rippleBig: 0.6, contrast: 2.1, sat: 0, termSharp: 0.8, glow: 0.4 },
  },
  {
    id: 'pixel',
    name: 'Pixel Mirage',
    blurb: 'Chunky pixels and a short palette with dithered blends.',
    pal: {
      day: P('#3a7bd5', '#bfe3f0', '#f2c078', '#b0703f', '#fffbe8'),
      sunset: P('#45396e', '#ff9a5a', '#f08a40', '#6a3040', '#ffe0a0'),
      night: NATURAL.night,
    },
    p: { pixelRows: 120, poster: 5, posterDither: 1, grain: 0, vig: 0, ripple: 0, rippleBig: 0.8, termSharp: 0.8, sat: 1.1 },
  },
  {
    id: 'sherbet',
    name: 'Sherbet',
    blurb: 'Peach sand, lilac shadows, mint sky. The playful one.',
    pal: {
      day: P('#9ad8d0', '#fde9d8', '#ffc9b8', '#c79ad0', '#ffffff'),
      sunset: P('#a890d8', '#ffc0a8', '#ffb098', '#9a70b8', '#fff0c0'),
      night: P('#2a2a5e', '#5a4a8e', '#9a9ae0', '#3a3470', '#fff4d8'),
    },
    fig: '#4a3468',
    p: { bands: 4, bandNoise: 0.15, flat: 1, sparkle: 0.8, ripple: 0, rippleBig: 0.35, sunScale: 1.8, glow: 0.8, grain: 0.012, vig: 0.08, shadowK: 14, starAmt: 1.5 },
  },
  {
    id: 'grid',
    name: 'Night Grid',
    blurb: 'Dark dunes wired with neon lines under a striped sun.',
    pal: {
      day: P('#1a1040', '#ff6ad5', '#3a1a6a', '#140a30', '#ffd319', { line: '#00e5ff' }),
      sunset: P('#12082e', '#ff3d77', '#2c1250', '#0e0622', '#ff9a1f', { line: '#ff4fd8' }),
      night: P('#03020c', '#2a1a6a', '#141034', '#06040f', '#c8d0ff', { line: '#5a7cff' }),
    },
    fig: '#05030c',
    p: { grid: 1, flat: 1, ripple: 0, rippleBig: 0, sunScale: 3.5, sunBands: 1, glow: 0.7, shadowAmt: 0.6, fog: 0.0009, grain: 0.03, vig: 0.4, chroma: 0.004, mtn: 0.7, starAmt: 1.2 },
  },
  {
    id: 'woodblock',
    name: 'Woodblock',
    blurb: 'Indigo and ochre in flat steps, keyline and paper grain.',
    pal: {
      day: P('#2f4f7a', '#efe2c2', '#e3b86a', '#a56a3a', '#f6e7c0'),
      sunset: P('#34406a', '#e8955a', '#d98a4a', '#7a3a2e', '#f4d8a0'),
      night: P('#10182e', '#2e4468', '#5e7896', '#1c2a44', '#f2ead2'),
    },
    ink: '#1f2a3a',
    fig: '#1f2a3a',
    p: { bands: 3, flat: 1, outline: 0.75, outlineW: 0.9, paper: 0.7, ripple: 0, rippleBig: 0.5, skyCurve: 0.8, sunScale: 1.6, glow: 0.15, grain: 0.02, vig: 0.1, shadowK: 30, sat: 0.92 },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    blurb: 'Pencil cross-hatching on paper; chalk on slate at night.',
    pal: {
      day: { ...NATURAL.day, a: '#2a2a2c', b: '#efece4' },
      sunset: { ...NATURAL.sunset, a: '#3a2a26', b: '#f2e4d0' },
      night: { ...NATURAL.night, a: '#dfe3ea', b: '#1a1c22' },
    },
    p: { mode: 3, outlineW: 1, ripple: 0, rippleBig: 0.5, paper: 0.4, wobble: 0.3, grain: 0.03, vig: 0.15, contrast: 1.15, glow: 0.5 },
  },
  {
    id: 'bleached',
    name: 'Bleached',
    blurb: 'Almost white. A small dark figure in a field of light.',
    pal: {
      day: P('#cfd6d8', '#f4f1ea', '#f7f2e6', '#cfc4b4', '#ffffff'),
      sunset: P('#d8c4c0', '#fbe6d0', '#fbe9d4', '#d0a898', '#fff6e0'),
      night: P('#20242c', '#3a4048', '#aeb6c2', '#4a5260', '#ffffff'),
    },
    fig: '#111111',
    p: { fog: 0.0014, ripple: 0.35, rippleBig: 0.3, mtn: 0.35, glow: 1.5, grain: 0.02, vig: 0.12, termSharp: 0.35, shadowK: 5, starAmt: 0.5 },
  },
  {
    id: 'storybook',
    name: 'Storybook',
    blurb: 'Gouache blocks with brushy edges and a wobbling hand.',
    pal: {
      day: P('#3f8fc4', '#f6e3b4', '#f5b95f', '#c56a3c', '#fff3c4'),
      sunset: P('#5a3f7a', '#f58a4b', '#f0803a', '#7a2f4a', '#ffe0a0'),
      night: P('#141a40', '#3a4a8a', '#7f94d8', '#232a5e', '#fff1c8'),
    },
    fig: '#2a1f3a',
    p: { bands: 4, bandNoise: 1, flat: 1, wobble: 0.7, paper: 0.3, ripple: 0, rippleBig: 0.4, sunScale: 2, glow: 0.5, grain: 0.03, vig: 0.15, shadowK: 20, skyBands: 7 },
  },
];
