// The marks the spyglass leaves: a thread of light standing over each place sighted, thin
// enough to be missed close by and tall enough to be found again from far off. A mark keeps
// the same size on the eye however far away it is, so the horizon holds them all alike.
import * as THREE from 'three';
import type { Uniforms } from './contract';

const MAX = 256;

const vert = /* glsl */ `
attribute vec3 aAt;
varying vec2 vP;
varying float vNear;
void main() {
  vec3 toCam = cameraPosition - aAt;
  float d = length(toCam.xz);
  vec2 side = d > 0.01 ? vec2(toCam.z, -toCam.x) / d : vec2(1.0, 0.0);
  float tall = clamp(d * 0.085, 10.0, 360.0);
  float wide = max(0.14, d * 0.0052);
  vec3 wp = aAt + vec3(side.x * position.x * wide, position.y * tall, side.y * position.x * wide);
  vP = position.xy;
  // gone by the time you are standing under it
  vNear = smoothstep(25.0, 140.0, d);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const frag = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uNight;
uniform vec3 uSunCol;
varying vec2 vP;
varying float vNear;
void main() {
  float across = 1.0 - abs(vP.x);
  // a bright core in a faint sheath
  float core = pow(across, 5.0) + 0.16 * across * across;
  // strongest a little above the ground, thinning away upward; slow beads of light climb it
  float along = smoothstep(0.0, 0.03, vP.y) * pow(1.0 - vP.y, 1.25);
  float bead = 0.8 + 0.2 * sin(vP.y * 26.0 - uTime * 1.3);
  // and one spark near its head, so it reads as a mark and not a trick of the haze
  vec2 sp = vec2(vP.x, (vP.y - 0.8) * 30.0);
  float spark = exp(-dot(sp, sp) * 2.2) * (0.75 + 0.25 * sin(uTime * 2.1));
  float a = min(1.0, (core * along * bead + spark) * vNear);
  vec3 col = mix(vec3(1.0, 0.94, 0.78), uSunCol, 0.2);
  // by day it is drawn over the sky, pale against the blue; by night it burns
  gl_FragColor = vec4(col * a * (0.9 + 0.3 * uNight), a * (0.85 - 0.6 * uNight));
}
`;

export class Marks {
  readonly group = new THREE.Group();
  private readonly at = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  private readonly geo = new THREE.InstancedBufferGeometry();

  constructor(u: Uniforms) {
    const quad = new THREE.PlaneGeometry(2, 1).translate(0, 0.5, 0);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('aAt', this.at);
    this.geo.instanceCount = 0;
    const mesh = new THREE.Mesh(
      this.geo,
      new THREE.ShaderMaterial({
        uniforms: u,
        vertexShader: vert,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    this.group.add(mesh);
  }

  /** Stand the marks at these places: x then z for each, and the height of the ground there. */
  set(at: readonly number[], height: (x: number, z: number) => number): void {
    const n = Math.min(MAX, at.length >> 1);
    const a = this.at.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const x = at[i * 2];
      const z = at[i * 2 + 1];
      a[i * 3] = x;
      a[i * 3 + 1] = height(x, z);
      a[i * 3 + 2] = z;
    }
    this.at.needsUpdate = true;
    this.geo.instanceCount = n;
  }
}
