// The night sky's furniture: the constellations as points with the lines a keeper has taught
// drawn between them, the sky's turning, the moon's phase, meteors, a comet, and the eclipse of
// the sun. The gradient, the small stars, the sun and the moon's disc are the sky shader's
// (gameSky.ts); this hands it the uniforms it needs and draws what stands over it.

import * as THREE from 'three';
import type { Uniforms } from '../game/contract';
import { CONSTELLATIONS, POLE_ALT, bloodMoon, comet, eclipse, eclipsed, moonPhase, nightOf, shower, skyTurn, starDir, starOf } from '../world/sky';

/** How far off the dome of fixed stars is drawn (inside the sky's own sphere). */
const R = 8000;
const METEORS = 2;

/** Adds the uniforms the sky shader reads for all of this. */
export function heavensUniforms(u: Uniforms): void {
  u.uSkyRot = { value: new THREE.Matrix3() };
  u.uMoonPhase = { value: 0.5 };
  u.uMoonTint = { value: new THREE.Vector3(1, 1, 1) };
  u.uEclipse = { value: 99 };
  u.uEclK = { value: 0 };
  u.uComet = { value: new THREE.Vector4(0, 1, 0, 0) };
  u.uCometTail = { value: new THREE.Vector3(1, 0, 0) };
  u.uMetA = { value: Array.from({ length: METEORS }, () => new THREE.Vector4(0, 1, 0, 0)) };
  u.uMetB = { value: Array.from({ length: METEORS }, () => new THREE.Vector4(0, 1, 0, 0.002)) };
  u.uFlash = { value: new THREE.Vector4(1, 0, 0, 0) };
}

const starVert = /* glsl */ `
attribute float aMag;
uniform float uPx;
uniform float uTime;
varying float vA;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 dir = normalize(wp.xyz - cameraPosition);
  float tw = 0.86 + 0.14 * sin(uTime * (1.1 + aMag * 2.3) + position.x * 0.01 + position.z * 0.013);
  vA = smoothstep(0.015, 0.16, dir.y) * tw * (0.75 + 0.45 * aMag);
  gl_PointSize = uPx * (4.5 + 5.5 * aMag);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const starFrag = /* glsl */ `
uniform float uStars;
varying float vA;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  // a hard little core in a soft halo, so it reads as a point at any size
  float a = smoothstep(0.2, 0.06, r2) * 1.2 + exp(-r2 * 5.0) * 0.5;
  gl_FragColor = vec4(vec3(1.0, 0.96, 0.86) * a * vA * uStars, 1.0);
}
`;
const lineVert = /* glsl */ `
attribute float aKnown;
varying float vA;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 dir = normalize(wp.xyz - cameraPosition);
  vA = aKnown * smoothstep(0.015, 0.16, dir.y);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const lineFrag = /* glsl */ `
uniform float uStars;
uniform float uRead;
varying float vA;
void main() {
  gl_FragColor = vec4(vec3(0.74, 0.86, 0.92) * vA * uStars * mix(0.26, 0.6, uRead), 1.0);
}
`;

interface Meteor {
  t: number;
  dur: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  bright: number;
  width: number;
  /** Called once when it has run its course (the one that lands). */
  done: (() => void) | null;
}

export class Heavens {
  readonly group = new THREE.Group();
  /** The name of the taught constellation the eye is on while the sky is being read, or ''. */
  reading = '';
  private readonly dome = new THREE.Group();
  private readonly lineKnown: THREE.BufferAttribute;
  /** For each constellation, the first vertex of its lines and how many. */
  private readonly lineSpan: [number, number][] = [];
  private readonly centres: THREE.Vector3[] = [];
  private readonly own: Uniforms;
  private readonly tilt = new THREE.Quaternion();
  private readonly spin = new THREE.Quaternion();
  private readonly m4 = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private readonly meteors: Meteor[] = [];
  private gap = 6;
  private knownKey = '?';
  private flash = 0;

  constructor(private readonly u: Uniforms) {
    const pos: number[] = [];
    const mag: number[] = [];
    const lpos: number[] = [];
    const d: [number, number, number] = [0, 0, 0];
    for (const c of CONSTELLATIONS) {
      const at: THREE.Vector3[] = [];
      for (let i = 0; i < c.stars.length; i++) {
        starOf(c, i, d);
        at.push(new THREE.Vector3(d[0] * R, d[1] * R, d[2] * R));
        pos.push(d[0] * R, d[1] * R, d[2] * R);
        mag.push(c.stars[i][2]);
      }
      this.lineSpan.push([lpos.length / 3, c.lines.length * 2]);
      for (const [a, b] of c.lines) {
        // (a line stops short of the stars it joins, as on a chart)
        const pa = at[a].clone().lerp(at[b], 0.13);
        const pb = at[b].clone().lerp(at[a], 0.13);
        lpos.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      }
      starDir(c.ra, c.dec, d);
      this.centres.push(new THREE.Vector3(d[0], d[1], d[2]));
    }
    // the Nail, at the pole
    pos.push(0, R, 0);
    mag.push(1);

    this.own = { uStars: u.uStars, uTime: u.uTime, uPx: { value: 1 }, uRead: { value: 0 } };
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pg.setAttribute('aMag', new THREE.Float32BufferAttribute(mag, 1));
    const flat = { transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending };
    const points = new THREE.Points(pg, new THREE.ShaderMaterial({ uniforms: this.own, vertexShader: starVert, fragmentShader: starFrag, ...flat }));
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lpos, 3));
    this.lineKnown = new THREE.Float32BufferAttribute(new Float32Array(lpos.length / 3), 1);
    lg.setAttribute('aKnown', this.lineKnown);
    const lines = new THREE.LineSegments(lg, new THREE.ShaderMaterial({ uniforms: this.own, vertexShader: lineVert, fragmentShader: lineFrag, ...flat }));
    for (const o of [lines, points]) {
      o.frustumCulled = false;
      o.renderOrder = -9; // over the sky, under everything in the world
      this.dome.add(o);
    }
    this.group.add(this.dome);
    // the pole stands POLE_ALT over the northern horizon (north is -z)
    this.tilt.setFromUnitVectors(this.v.set(0, 1, 0), this.w.set(0, Math.sin(POLE_ALT), -Math.cos(POLE_ALT)));
    for (let i = 0; i < METEORS; i++) this.meteors.push({ t: 1, dur: 1, from: new THREE.Vector3(0, 1, 0), to: new THREE.Vector3(0, 1, 0), bright: 0, width: 0.002, done: null });
  }

  /** Which constellations have their lines drawn. */
  setKnown(known: readonly string[]): void {
    const key = known.join();
    if (key === this.knownKey) return;
    this.knownKey = key;
    const a = this.lineKnown.array as Float32Array;
    CONSTELLATIONS.forEach((c, i) => {
      const [from, n] = this.lineSpan[i];
      a.fill(known.includes(c.id) ? 1 : 0, from, from + n);
    });
    this.lineKnown.needsUpdate = true;
  }

  /** Where a constellation's middle stands in the world's sky now. */
  where(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.centres[i]).applyQuaternion(this.dome.quaternion);
  }

  /**
   * One star falls all the way down, toward the horizon over (dx, dz) from where the wanderer
   * stands: slower and brighter than the rest, and `landed` is called as it goes out.
   */
  fall(dx: number, dz: number, landed: () => void): void {
    const m = this.meteors[METEORS - 1];
    const len = Math.hypot(dx, dz) || 1;
    const ax = dx / len;
    const az = dz / len;
    m.to.set(ax, 0.015, az).normalize();
    // from high up and a little to one side, so it crosses the sky on a slant
    m.from.set(ax * 0.45 - az * 0.42, 0.78, az * 0.45 + ax * 0.42).normalize();
    m.t = 0;
    m.dur = 2.8;
    m.bright = 2.6;
    m.width = 0.0042;
    m.done = () => {
      this.flash = 1;
      (this.u.uFlash.value as THREE.Vector4).set(m.to.x, m.to.y, m.to.z, 1);
      landed();
    };
  }

  /**
   * Once a frame, after the day cycle has written the light and before the weather dims it.
   * `read` is 0..1 how far the sky is being read (the spyglass up), `look` the way the eye faces,
   * `open` 0..1 how much sky there is to see (0 underground).
   */
  update(dt: number, clock: number, day: number, camera: THREE.PerspectiveCamera, px: number, read: number, open: number, known: readonly string[]): void {
    const u = this.u;
    const night = nightOf(clock, day);
    this.group.position.copy(camera.position);
    this.spin.setFromAxisAngle(this.v.set(0, 1, 0), -skyTurn(clock, day));
    this.dome.quaternion.copy(this.tilt).multiply(this.spin);
    // the sky shader wants the way back: a world direction into the stars' own frame
    (u.uSkyRot.value as THREE.Matrix3).setFromMatrix4(this.m4.makeRotationFromQuaternion(this.spin.copy(this.dome.quaternion).invert()));
    this.own.uPx.value = px;
    this.own.uRead.value = read;
    this.setKnown(known);

    // ---- the moon
    u.uMoonPhase.value = moonPhase(night);
    const tint = u.uMoonTint.value as THREE.Vector3;
    if (bloodMoon(night)) {
      // copper while it is high: it goes into the shadow after dusk and is out of it before dawn
      const deep = Math.max(0, 1 - Math.abs((day < 0.5 ? day : day - 1) / 0.13));
      tint.set(1, 1, 1).lerp(this.v.set(0.92, 0.42, 0.28), Math.min(1, deep * 1.6));
    } else tint.set(1, 1, 1);

    // ---- the eclipse of the sun: the day goes to a deep dusk, and the stars come out
    const off = eclipse(clock, day);
    const k = eclipsed(off);
    u.uEclipse.value = off ?? 99;
    u.uEclK.value = k;
    if (k > 0.001) {
      const dim = (name: string, to: THREE.Vector3, by: number) => (u[name]?.value as THREE.Vector3 | undefined)?.lerp(to, by);
      const shade = u.uShade.value as THREE.Vector3;
      for (const n of ['uLit', 'uRockLit', 'uSaltLit', 'uSnowLit']) {
        const sh = (u[n.replace('Lit', 'Shade')]?.value as THREE.Vector3 | undefined) ?? shade;
        dim(n, this.v.copy(sh).multiplyScalar(0.8), k * 0.86);
      }
      for (const n of ['uShade', 'uRockShade', 'uSaltShade', 'uSnowShade']) (u[n]?.value as THREE.Vector3 | undefined)?.multiplyScalar(1 - 0.45 * k);
      dim('uTop', this.v.set(0.02, 0.05, 0.11), k * 0.9);
      // (all round the horizon it is still day somewhere, and that light comes in low and warm)
      dim('uHorizon', this.v.set(0.5, 0.33, 0.26), k * 0.8);
      (u.uFogCol.value as THREE.Vector3).copy(u.uHorizon.value as THREE.Vector3);
      (u.uSunCol.value as THREE.Vector3).multiplyScalar(1 - 0.5 * k);
      u.uGlow.value = (u.uGlow.value as number) * (1 - 0.9 * k);
      u.uStars.value = Math.max(u.uStars.value as number, k * k * k * 0.85);
    }
    const stars = (u.uStars.value as number) * open;

    // ---- the comet: fixed among the stars for its few nights, its tail away from the sun
    const cm = u.uComet.value as THREE.Vector4;
    const cs = comet(night);
    if (cs > 0) {
      const d = starDir(205 + (night % 3) * 4, 30 + (night % 3) * 5);
      this.v.set(d[0], d[1], d[2]).applyQuaternion(this.dome.quaternion);
      cm.set(this.v.x, this.v.y, this.v.z, cs * stars);
      const sun = u.uSunPos.value as THREE.Vector3;
      const tail = u.uCometTail.value as THREE.Vector3;
      tail.copy(this.v).multiplyScalar(this.v.dot(sun)).sub(sun);
      if (tail.lengthSq() < 1e-6) tail.set(0, 1, 0);
      tail.normalize();
    } else cm.w = 0;

    // ---- meteors: one now and then on any night, a rain of them on a shower's
    const thick = shower(night);
    if (stars > 0.4 && (this.gap -= dt) <= 0) {
      this.gap = thick ? 0.5 + Math.random() * 3 : 18 + Math.random() * 50;
      const m = this.meteors[0];
      if (m.t >= 1) {
        if (thick) {
          // out of the Lantern, every way from it
          this.where(4, m.from);
          const a = Math.random() * Math.PI * 2;
          this.w.set(Math.cos(a), Math.sin(a) * 0.8, Math.sin(a * 1.7 + 1)).cross(m.from).normalize();
          m.from.addScaledVector(this.w, 0.15 + Math.random() * 0.5).normalize();
          m.to.copy(m.from).addScaledVector(this.w, 0.18 + Math.random() * 0.22).normalize();
        } else {
          const a = Math.random() * Math.PI * 2;
          const el = 0.35 + Math.random() * 0.9;
          m.from.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
          const b = a + 1.2 + Math.random() * 1.2;
          m.to.copy(m.from).add(this.w.set(Math.cos(b) * 0.24, -0.12 - Math.random() * 0.12, Math.sin(b) * 0.24)).normalize();
        }
        if (m.from.y > 0.1) {
          m.t = 0;
          m.dur = 0.45 + Math.random() * 0.5;
          m.bright = 0.7 + Math.random() * 0.7;
          m.width = 0.0016;
          m.done = null;
        }
      }
    }
    const A = u.uMetA.value as THREE.Vector4[];
    const B = u.uMetB.value as THREE.Vector4[];
    for (let i = 0; i < METEORS; i++) {
      const m = this.meteors[i];
      if (m.t >= 1) {
        A[i].w = 0;
        continue;
      }
      m.t = Math.min(1, m.t + dt / m.dur);
      const head = this.v.copy(m.from).lerp(m.to, m.t).normalize();
      A[i].set(head.x, head.y, head.z, m.bright * Math.sin(Math.PI * Math.min(1, m.t * 1.15)) ** 0.6 * Math.max(stars, i === METEORS - 1 ? 0.6 * open : 0));
      const tail = this.w.copy(m.from).lerp(m.to, Math.max(0, m.t - 0.4)).normalize();
      B[i].set(tail.x, tail.y, tail.z, m.width);
      if (m.t >= 1 && m.done) {
        const done = m.done;
        m.done = null;
        done();
      }
    }
    this.flash = Math.max(0, this.flash - dt / 1.6);
    (u.uFlash.value as THREE.Vector4).w = this.flash * this.flash * open;

    // ---- what the eye is on, while the sky is being read
    this.reading = '';
    if (read > 0.5 && stars > 0.4) {
      camera.getWorldDirection(this.v);
      let best = 0.975; // within about 13 degrees
      for (let i = 0; i < CONSTELLATIONS.length; i++) {
        if (!known.includes(CONSTELLATIONS[i].id)) continue;
        const dot = this.where(i, this.w).dot(this.v);
        if (dot > best && this.w.y > 0.03) {
          best = dot;
          this.reading = CONSTELLATIONS[i].name;
        }
      }
    }
  }

  dispose(): void {
    this.dome.traverse((o) => {
      const m = o as THREE.Points;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }
}
