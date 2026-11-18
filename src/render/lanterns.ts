// The lantern festival: paper lanterns let go from every lived-in place on the night of the full
// moon. Each is a warm point that rises slowly, leans with the wind and burns out high up, so a
// city far off shows as a slow column of lights.

import * as THREE from 'three';
import type { Uniforms } from '../game/contract';

/** Somewhere lanterns are let go from: its middle, the height of its ground, how far out it reaches, and its share of them. */
export interface LanternSource {
  x: number;
  y: number;
  z: number;
  r: number;
  weight: number;
}

const MAX = 260;

const vert = /* glsl */ `
attribute vec4 aLife; // age 0..1, seed, size, alive
uniform float uPx;
uniform float uTime;
varying float vA;
varying float vSeed;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  float dist = length(mv.xyz);
  float age = aLife.x;
  // lit over a few seconds, steady, then guttering out
  float a = smoothstep(0.0, 0.03, age) * (1.0 - smoothstep(0.82, 1.0, age));
  a *= 0.82 + 0.18 * sin(uTime * (2.0 + aLife.y * 3.0) + aLife.y * 40.0);
  vA = a * aLife.w;
  vSeed = aLife.y;
  // a metre of paper near to, and never less than a point of light however far
  gl_PointSize = clamp(uPx * aLife.z * 620.0 / max(dist, 1.0), uPx * 3.0, uPx * 46.0);
  gl_Position = projectionMatrix * mv;
}
`;
const frag = /* glsl */ `
varying float vA;
varying float vSeed;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  // the paper: a soft upright lozenge, brighter low down where the flame is
  float body = 1.0 - smoothstep(0.0, 1.0, abs(p.x) * 2.1 + abs(p.y + 0.05) * 1.25);
  float flame = exp(-((p.x * p.x) * 9.0 + (p.y - 0.25) * (p.y - 0.25) * 7.0));
  float halo = exp(-r2 * 3.2) * 0.35;
  vec3 paper = mix(vec3(1.0, 0.52, 0.2), vec3(1.0, 0.78, 0.36), fract(vSeed * 7.3));
  paper = mix(paper, vec3(1.0, 0.36, 0.26), step(0.8, fract(vSeed * 3.1)));
  vec3 col = paper * (body * 1.15 + halo * 1.6) + vec3(1.0, 0.8, 0.45) * flame * 0.3;
  gl_FragColor = vec4(col * vA, 1.0);
}
`;

export class Lanterns {
  readonly group = new THREE.Group();
  private readonly pos = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX * 4);
  private readonly rise = new Float32Array(MAX);
  private readonly span = new Float32Array(MAX);
  private readonly posAttr: THREE.BufferAttribute;
  private readonly lifeAttr: THREE.BufferAttribute;
  private readonly own: Uniforms;
  private readonly points: THREE.Points;
  private acc = 0;
  private next = 0;
  private alive = 0;

  constructor(u: Uniforms) {
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.lifeAttr = new THREE.BufferAttribute(this.life, 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.lifeAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aLife', this.lifeAttr);
    this.own = { uTime: u.uTime, uPx: { value: 1 } };
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: this.own, vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 11;
    this.points.visible = false;
    this.group.add(this.points);
  }

  /**
   * k: 0..1 how far the festival is on (0 lets none go; the ones up already burn out in their own
   * time). sources: where they are let go from. wind: the way it blows (unit x, z).
   */
  update(dt: number, k: number, sources: readonly LanternSource[], wind: THREE.Vector2, gust: number, px: number): void {
    this.own.uPx.value = px;
    let total = 0;
    for (const s of sources) total += s.weight;
    if (k > 0.02 && total > 0) {
      // (never more than can burn out before their places are wanted again)
      this.acc += dt * k * Math.min(MAX / 115, 0.4 + total * 0.2);
      while (this.acc >= 1) {
        this.acc -= 1;
        let pick = Math.random() * total;
        let s = sources[0];
        for (const c of sources) {
          s = c;
          if ((pick -= c.weight) <= 0) break;
        }
        const i = this.next;
        this.next = (this.next + 1) % MAX;
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * s.r;
        this.pos[i * 3] = s.x + Math.cos(a) * d;
        this.pos[i * 3 + 1] = s.y + 2 + Math.random() * 7;
        this.pos[i * 3 + 2] = s.z + Math.sin(a) * d;
        this.life[i * 4] = 0;
        this.life[i * 4 + 1] = Math.random();
        this.life[i * 4 + 2] = 0.8 + Math.random() * 0.5;
        this.life[i * 4 + 3] = 1;
        this.rise[i] = 0.9 + Math.random() * 0.9;
        this.span[i] = 70 + Math.random() * 70;
      }
    }
    let n = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i * 4 + 3] === 0) continue;
      const age = this.life[i * 4] + dt / this.span[i];
      if (age >= 1) {
        this.life[i * 4 + 3] = 0;
        continue;
      }
      n++;
      this.life[i * 4] = age;
      const seed = this.life[i * 4 + 1];
      // the wind has more of them the higher they go
      const lean = (0.25 + gust * 0.9) * (0.4 + age * 1.6);
      this.pos[i * 3] += (wind.x * lean + Math.sin(age * 40 + seed * 30) * 0.12) * dt;
      this.pos[i * 3 + 1] += this.rise[i] * (1 - 0.45 * age) * dt;
      this.pos[i * 3 + 2] += (wind.y * lean + Math.cos(age * 33 + seed * 50) * 0.12) * dt;
    }
    if (n > 0 || this.alive > 0) {
      this.posAttr.needsUpdate = true;
      this.lifeAttr.needsUpdate = true;
    }
    this.alive = n;
    this.points.visible = n > 0;
  }

  /** How many are in the air now. */
  get count(): number {
    return this.alive;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
