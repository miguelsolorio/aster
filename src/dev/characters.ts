// Dev-only review sheet: the characters standing in a row at day, golden hour and night.
// Served by the dev server at /characters.html; it is not part of the production build.
// ?still=1 freezes the animation. ?people shows the townsfolk instead of the hero, one row per
// kind of city (hill, canyon, oasis, trade); add &day=0..1 to change the hour. ?animals shows the
// desert animals at noon, golden hour and midnight: oryx standing, walking, grazing and running,
// then a fox, a hare, a lizard (drawn four times its size) and a vulture.
import * as THREE from 'three';
import type { PlayerState, Uniforms } from '../game/contract';
import { DayCycle } from '../game/daycycle';
import { Figure } from '../game/figure';
import { townsfolkSheet, type SheetPerson } from '../city/people';
import type { CityKind } from '../city/types';
import { FOX, HARE, LIZARD, ORYX, VULTURE, faunaSheet, type SheetAnimal } from '../world/fauna';

const qs = new URLSearchParams(location.search);
const still = qs.has('still');
const KINDS: CityKind[] = ['hill', 'canyon', 'oasis', 'trade'];
const showPeople = qs.has('people');
const showAnimals = qs.has('animals');
const peopleDay = qs.has('day') ? Number(qs.get('day')) : 0.5;
const TIMES = showPeople ? KINDS.map(() => peopleDay) : [0.5, 0.268, 0.0]; // noon, golden hour, midnight

const SIDE = Math.PI / 2;
const ANIMALS: SheetAnimal[] = [
  { sp: ORYX, x: -6.6, z: 0, facing: 0.5, gait: 0 },
  { sp: ORYX, x: -4.4, z: 0, facing: SIDE, gait: 1 },
  { sp: ORYX, x: -2.3, z: 0, facing: SIDE + 0.3, gait: 0, pose: 1 },
  { sp: ORYX, x: -0.1, z: 0, facing: SIDE, gait: 2 },
  { sp: FOX, x: 1.6, z: 0, facing: 0.5, gait: 0 },
  { sp: FOX, x: 2.5, z: 0, facing: SIDE, gait: 1 },
  { sp: HARE, x: 3.4, z: 0, facing: 0.5, gait: 0 },
  { sp: HARE, x: 4.2, z: 0, facing: SIDE, gait: 2 },
  { sp: LIZARD, x: 5.1, z: 0, facing: SIDE, gait: 1, scale: 4 },
  { sp: VULTURE, x: 7.0, z: 0, facing: SIDE - 0.4, gait: 0 },
];

// Each silhouette three times (front, side walking, from behind), then a child.
const CROWD: SheetPerson[] = [];
for (let shape = 0; shape < 4; shape++) {
  for (let k = 0; k < 3; k++) {
    CROWD.push({ x: -6.3 + (shape * 3 + k) * 1.0 + shape * 0.25, z: 0, facing: [0.35, Math.PI / 2, Math.PI][k], shape, walk: k === 1, seed: 0 });
  }
}
CROWD.push({ x: 6.6, z: 0, facing: 0.4, shape: 0, child: true, seed: 0 });

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

interface Slot {
  x: number;
  facing: number;
  y: number;
  st: Partial<PlayerState>;
  gliding?: boolean;
}

// front three-quarter, side walk, from behind (the usual game view), sand-surfing, gliding
const SLOTS: Slot[] = [
  { x: -3.6, facing: 0.5, y: 0, st: { speed: 0, grounded: true } },
  { x: -1.8, facing: Math.PI / 2, y: 0, st: { speed: 2.2, grounded: true } },
  { x: 0, facing: Math.PI, y: 0, st: { speed: 0, grounded: true } },
  { x: 1.9, facing: Math.PI / 2, y: 0, st: { speed: 10, grounded: true, sliding: true } },
  { x: 4.0, facing: Math.PI / 2 - 0.5, y: 0.25, st: { speed: 9, grounded: false }, gliding: true },
];

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setScissorTest(true);
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(24, 1, 0.5, 400);
const wind = new THREE.Vector2(1, 0);

const panels = TIMES.map((time, row) => {
  const u: Uniforms = { uTime: { value: 0 } };
  const day = new DayCycle(u, time);
  const scene = new THREE.Scene();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ uniforms: u, vertexShader: groundVert, fragmentShader: groundFrag }));
  scene.add(ground);
  if (showPeople) scene.add(townsfolkSheet(u, KINDS[row], CROWD.map((p, i) => ({ ...p, seed: 1 + row * 97 + i * 13 }))));
  const animals = showAnimals ? faunaSheet(u, ANIMALS) : null;
  if (animals) scene.add(animals.group);
  const figures = (showPeople || showAnimals ? [] : SLOTS).map((slot) => {
    const figure = new Figure(u);
    scene.add(figure.group);
    const st: PlayerState = {
      pos: new THREE.Vector3(slot.x, slot.y, 0),
      vel: new THREE.Vector3(0, slot.gliding ? -1 : 0, 0),
      speed: 0,
      grounded: true,
      sliding: false,
      running: false,
      onRock: 1,
      ...slot.st,
    };
    return { figure, slot, st };
  });
  return { u, day, scene, figures, animals };
});

function resize() {
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);
resize();

let last = performance.now();
let warm = 120; // settle the eased poses before a frozen frame
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const w = innerWidth;
  const h = innerHeight / panels.length;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  camera.position.set(0.2, showAnimals ? 1.6 : 1.35, showPeople || showAnimals ? 12 : 7.2);
  camera.lookAt(0.2, 1.0, 0);
  panels.forEach((p, i) => {
    const step = still && warm <= 0 ? 0 : still ? 1 / 30 : dt;
    p.u.uTime.value += step;
    p.animals?.update(step);
    for (const f of p.figures) {
      f.figure.update(step, f.st, f.slot.facing, wind, 0.3, { turn: 0, slopeAlong: 0, gliding: !!f.slot.gliding, lifting: false, alt: 5 });
    }
    const hor = p.u.uHorizon.value as THREE.Vector3;
    renderer.setClearColor(new THREE.Color(hor.x, hor.y, hor.z));
    const y = innerHeight - h * (i + 1);
    renderer.setViewport(0, y, w, h);
    renderer.setScissor(0, y, w, h);
    renderer.render(p.scene, camera);
  });
  if (warm > 0) warm--;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
