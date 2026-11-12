// Dev-only: every board, carpet and pick, worn by the wanderer, to choose between.
// Served by the dev server at /equipment.html; it is not part of the production build.
//
// One canvas sits behind the page and draws each design into its tile, through the game's
// own shaders, day palette and post pass. Click a tile to choose it; the line at the top
// right is what to paste back. The hour and the look can be changed to check a choice.
import * as THREE from 'three';
import './equipment.css';
import type { PlayerState, Uniforms } from '../game/contract';
import { DayCycle } from '../game/daycycle';
import { Figure } from '../game/figure';
import { BOARDS, CARPETS, PICKS, type Design } from '../game/equipment';
import { LOOKS, type Look } from '../game/looks';
import { DEFAULTS, type Params } from '../render/types';
import { postFrag, postVert } from '../render/shaders';

type Kind = 'board' | 'carpet' | 'pick';
const KINDS: Array<{ kind: Kind; title: string; lede: string; list: Design[] }> = [
  { kind: 'board', title: 'Boards', lede: 'Left: riding. Right: carried on the back, with the cloak lying against it.', list: BOARDS },
  { kind: 'carpet', title: 'Carpets', lede: 'Left: unrolled in flight. Right: rolled and strapped low across the back.', list: CARPETS },
  { kind: 'pick', title: 'Picks', lede: 'Left: tucked across the back. Right: mid-swing.', list: PICKS },
];
const KEY = 'aster.equipment';

// ---- shared uniforms, as the game sets them up
const cap = (k: string) => 'u' + k[0].toUpperCase() + k.slice(1);
const u: Uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0) }, uFigPos: { value: new THREE.Vector3() } };
for (const n of ['uInk', 'uPaperCol', 'uA', 'uB', 'uLine']) u[n] = { value: new THREE.Vector3() };
for (const k of Object.keys(DEFAULTS) as Array<keyof Params>) {
  if (k !== 'glow' && k !== 'fog') u[cap(k)] = { value: DEFAULTS[k] };
}
const qs = new URLSearchParams(location.search);
const day = new DayCycle(u, qs.has('day') ? Number(qs.get('day')) : 0.4);
const applyLook = (l: Look) => {
  for (const k of Object.keys(DEFAULTS) as Array<keyof Params>) {
    if (k !== 'glow' && k !== 'fog') u[cap(k)].value = l.params[k];
  }
  (u.uInk.value as THREE.Vector3).copy(l.ink);
  (u.uPaperCol.value as THREE.Vector3).copy(l.paper);
  day.setLook(l.day);
};
applyLook(LOOKS[0]);

// ---- the ground each pair stands on
const groundVert = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const groundFrag = /* glsl */ `
precision highp float;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
varying vec3 vW;
void main() {
  vec3 col = mix(uShade, uLit, clamp(uSunDir.y * 1.25, 0.0, 1.0));
  col = mix(col, uHorizon, smoothstep(6.0, 40.0, length(vW.xz)));
  gl_FragColor = vec4(col, 1.0);
}
`;
const groundGeo = new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2);
const groundMat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: groundVert, fragmentShader: groundFrag });

// ---- one scene per design: two wanderers, one using the thing and one carrying it
interface Actor {
  figure: Figure;
  st: PlayerState;
  gliding: boolean;
  swings: boolean;
}
interface Tile {
  kind: Kind;
  index: number;
  design: Design;
  scene: THREE.Scene;
  actors: Actor[];
  stage: HTMLElement;
  button: HTMLButtonElement;
}

function actor(scene: THREE.Scene, x: number, y: number, st: Partial<PlayerState>, set: (f: Figure) => void, gliding = false, swings = false): Actor {
  const figure = new Figure(u);
  set(figure);
  scene.add(figure.group);
  return {
    figure,
    st: { pos: new THREE.Vector3(x, y, 0), vel: new THREE.Vector3(0, gliding ? -1 : 0, 0), speed: 0, grounded: true, sliding: false, running: false, onRock: 0, ...st },
    gliding,
    swings,
  };
}

function makeScene(kind: Kind, i: number): { scene: THREE.Scene; actors: Actor[] } {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(groundGeo, groundMat));
  const actors: Actor[] = [];
  if (kind === 'board') {
    const wear = (on: boolean) => (f: Figure) => {
      f.board = true;
      f.boardOn = on;
      f.setBoard(i);
    };
    actors.push(actor(scene, -0.75, 0, { speed: 10, sliding: true }, wear(true)));
    actors.push(actor(scene, 0.75, 0, { speed: 0 }, wear(false)));
  } else if (kind === 'carpet') {
    const wear = (f: Figure) => {
      f.carpet = true;
      f.setCarpet(i);
    };
    actors.push(actor(scene, -0.85, 0.55, { speed: 14, grounded: false }, wear, true));
    actors.push(actor(scene, 1.0, 0, { speed: 0 }, wear));
  } else {
    const wear = (f: Figure) => {
      f.pick = true;
      f.setPick(i);
    };
    actors.push(actor(scene, -0.6, 0, { speed: 0 }, wear));
    actors.push(actor(scene, 0.6, 0, { speed: 0 }, wear, false, true));
  }
  return { scene, actors };
}

// ---- page
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<Kind, number>>;
  } catch {
    return {};
  }
})();
const chosen: Record<Kind, number | null> = { board: saved.board ?? null, carpet: saved.carpet ?? null, pick: saved.pick ?? null };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const page = el('div', 'eq');
const bar = el('div', 'eq-bar');
bar.append(el('h1', undefined, 'Equipment'));

const hour = el('input');
hour.type = 'range';
hour.min = '0';
hour.max = '1';
hour.step = '0.005';
hour.value = String(day.day);
const hourLabel = el('label', undefined, 'Hour');
hourLabel.append(hour);
hour.addEventListener('input', () => {
  day.day = Number(hour.value);
  day.update(0);
});

const lookSel = el('select');
LOOKS.forEach((l, i) => {
  const o = el('option', undefined, l.name);
  o.value = String(i);
  lookSel.append(o);
});
const lookLabel = el('label', undefined, 'Look');
lookLabel.append(lookSel);
lookSel.addEventListener('change', () => applyLook(LOOKS[Number(lookSel.value)]));

const pickBox = el('div', 'eq-pick');
const pickLine = el('code');
const copy = el('button', undefined, 'Copy');
copy.type = 'button';
copy.addEventListener('click', () => {
  void navigator.clipboard?.writeText(pickLine.textContent ?? '');
  copy.textContent = 'Copied';
  setTimeout(() => (copy.textContent = 'Copy'), 1200);
});
pickBox.append(pickLine, copy);
bar.append(hourLabel, lookLabel, pickBox);

const main = el('div', 'eq-main');
const side = el('aside', 'eq-side');
const sideStage = el('div', 'eq-stage');
const sideInfo = el('div', 'eq-info');
const sideName = el('h3');
const sideNote = el('p');
sideInfo.append(sideName, sideNote);
side.append(sideStage, sideInfo);
page.append(bar, main, side);

const tiles: Tile[] = [];
let focus: Tile | null = null;
let hover: Tile | null = null;

const syncPick = () => {
  const part = (k: Kind) => `${k} ${chosen[k] === null ? '?' : (chosen[k] as number) + 1}`;
  pickLine.textContent = `${part('board')}, ${part('carpet')}, ${part('pick')}`;
  for (const t of tiles) t.button.setAttribute('aria-pressed', String(chosen[t.kind] === t.index));
  try {
    localStorage.setItem(KEY, JSON.stringify(chosen));
  } catch {
    /* storage unavailable */
  }
};
const show = (t: Tile) => {
  sideName.textContent = `${t.kind} ${t.index + 1} · ${t.design.name}`;
  sideNote.textContent = t.design.note;
};

for (const group of KINDS) {
  main.append(el('h2', undefined, group.title), el('p', 'eq-lede', group.lede));
  const grid = el('div', 'eq-grid');
  group.list.forEach((design, index) => {
    const button = el('button', 'eq-tile');
    button.type = 'button';
    button.setAttribute('aria-label', `${group.kind} ${index + 1}: ${design.name}. ${design.note}`);
    const stage = el('div', 'eq-stage');
    const capEl = el('div', 'eq-cap');
    capEl.append(el('b', undefined, String(index + 1)), el('span', undefined, design.name));
    button.append(stage, capEl);
    grid.append(button);
    const tile: Tile = { kind: group.kind, index, design, ...makeScene(group.kind, index), stage, button };
    tiles.push(tile);
    button.addEventListener('click', () => {
      chosen[tile.kind] = tile.index;
      focus = tile;
      show(tile);
      syncPick();
    });
    button.addEventListener('pointerenter', () => {
      hover = tile;
      show(tile);
    });
    button.addEventListener('pointerleave', () => {
      if (hover === tile) hover = null;
      if (focus) show(focus);
    });
    button.addEventListener('focus', () => {
      hover = tile;
      show(tile);
    });
  });
  main.append(grid);
}
focus = tiles.find((t) => chosen[t.kind] === t.index) ?? tiles[0];
show(focus);
syncPick();

// ---- renderer: the scenes go into one target, tile by tile, then the look's post pass
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(1);
renderer.autoClear = false;
renderer.domElement.className = 'eq-canvas';
document.body.append(renderer.domElement, page);

const postU: Uniforms = { ...u, tColor: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } };
const postScene = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: postU, vertexShader: postVert, fragmentShader: postFrag, depthTest: false, depthWrite: false }));
quad.frustumCulled = false;
postScene.add(quad);

let rt: THREE.WebGLRenderTarget | null = null;
let ratio = 1;
function resize() {
  ratio = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(2, Math.round(innerWidth * ratio));
  const h = Math.max(2, Math.round(innerHeight * ratio));
  renderer.setSize(w, h, false);
  rt?.depthTexture?.dispose();
  rt?.dispose();
  rt = new THREE.WebGLRenderTarget(w, h, { samples: 4, depthBuffer: true });
  rt.depthTexture = new THREE.DepthTexture(w, h);
  postU.tColor.value = rt.texture;
  postU.tDepth.value = rt.depthTexture;
  (postU.uRes.value as THREE.Vector2).set(w, h);
}
addEventListener('resize', resize);
resize();

const camera = new THREE.PerspectiveCamera(22, 1, 0.5, 400);
const wind = new THREE.Vector2(1, 0);
const bg = new THREE.Color('#14100d');
const sky = new THREE.Color();
let time = 0;

function draw(t: Tile, stage: HTMLElement, close: boolean) {
  const r = stage.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.width < 4) return;
  const x = Math.round(r.left * ratio);
  const y = Math.round((innerHeight - r.bottom) * ratio);
  const w = Math.round(r.width * ratio);
  const h = Math.round(r.height * ratio);
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
  renderer.setClearColor(sky);
  renderer.clear();
  // a slow turn about the pair, from a little above
  const a = time * 0.35 + (close ? 0 : t.index * 0.4);
  const d = (t.kind === 'pick' ? 4.9 : t.kind === 'carpet' ? 7.4 : 6.3) * (close ? 1.25 : 1);
  const lookY = t.kind === 'carpet' ? 1.0 : t.kind === 'pick' ? 0.85 : 0.9;
  camera.aspect = w / h;
  camera.position.set(Math.sin(a) * d, lookY + 0.9, Math.cos(a) * d);
  camera.lookAt(0, lookY, 0);
  camera.updateProjectionMatrix();
  renderer.render(t.scene, camera);
}

let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;
  u.uTime.value = time;
  const hor = u.uHorizon.value as THREE.Vector3;
  sky.setRGB(hor.x, hor.y, hor.z);

  for (const t of tiles) {
    for (const a of t.actors) {
      if (a.swings) a.figure.swing = (time * 0.55 + t.index * 0.13) % 1;
      a.figure.update(dt, a.st, 0, wind, 0.3, { turn: 0, slopeAlong: 0, gliding: a.gliding, lifting: false, alt: 5 });
    }
  }

  renderer.setRenderTarget(rt);
  renderer.setScissorTest(false);
  renderer.setClearColor(bg);
  renderer.clear();
  renderer.setScissorTest(true);
  for (const t of tiles) draw(t, t.stage, false);
  const big = hover ?? focus;
  if (big && side.offsetParent !== null) draw(big, sideStage, true);
  renderer.setScissorTest(false);
  renderer.setRenderTarget(null);
  renderer.setViewport(0, 0, renderer.domElement.width, renderer.domElement.height);
  renderer.clear();
  renderer.render(postScene, postCam);
}
requestAnimationFrame(frame);
