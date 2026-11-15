// The light over a sealed cavern: a soft shaft of gold standing on the spot the pick must
// strike, tall enough to show over the dunes between. It reads the same short list of caverns
// the ground is cut by (see cavernUniforms in world/surface.ts), so it stands exactly where the
// ring on the sand lies, and goes out as the sand drains away.
import * as THREE from 'three';
import { MAX_CAVERNS } from '../world/surface';
import type { Uniforms } from './contract';

const vert = /* glsl */ `
uniform vec4 uCavA[${MAX_CAVERNS}];
uniform vec4 uCavB[${MAX_CAVERNS}];
uniform vec4 uCavC[${MAX_CAVERNS}];
uniform vec4 uCavD[${MAX_CAVERNS}];
attribute float aIdx;
varying vec2 vP;
varying float vK;
varying float vSeed;
void main() {
  int i = int(aIdx + 0.5);
  vec4 ca = uCavA[i];
  vec4 cb = uCavB[i];
  vec3 at = vec3(ca.x + ca.z * uCavD[i].w, cb.x - uCavD[i].z, ca.y + ca.w * uCavD[i].w);
  vec3 toCam = cameraPosition - at;
  float d = length(toCam.xz);
  vec2 side = d > 0.01 ? vec2(toCam.z, -toCam.x) / d : vec2(1.0, 0.0);
  // a little taller and wider on the eye the further off it is, so it is not lost
  float tall = clamp(d * 0.24, 18.0, 150.0);
  float wide = max(2.4, d * 0.011);
  vec3 wp = at + vec3(side.x * position.x * wide, position.y * tall, side.y * position.x * wide);
  vP = position.xy;
  // on while the cavern is there and sealed; faint for whoever stands in it, gone far away
  float on = uCavC[i].w > 0.0 ? 1.0 - smoothstep(0.0, 0.5, cb.z) : 0.0;
  vK = on * mix(0.3, 1.0, smoothstep(6.0, 70.0, d)) * (1.0 - smoothstep(520.0, 760.0, d));
  vSeed = aIdx * 2.1;
  gl_Position = vK > 0.0 ? projectionMatrix * viewMatrix * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const frag = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uNight;
varying vec2 vP;
varying float vK;
varying float vSeed;
void main() {
  float across = 1.0 - abs(vP.x);
  // a soft column with a brighter heart, strongest at the sand and thinning away upward
  float body = across * across * (0.35 + 0.65 * across * across);
  float along = smoothstep(0.0, 0.02, vP.y) * pow(1.0 - vP.y, 1.8);
  // slow bands of light climb it
  float band = 0.82 + 0.18 * sin(vP.y * 22.0 - uTime * 1.1 + vSeed);
  float breathe = 0.85 + 0.15 * sin(uTime * 1.6 + vSeed);
  float a = body * along * band * breathe * vK;
  // gold, paler at its heart
  vec3 gold = mix(vec3(1.0, 0.78, 0.32), vec3(1.0, 0.95, 0.72), across * across * across);
  // by day it is laid over the sand and the sky, a bright warm veil; by night it burns
  gl_FragColor = vec4(gold * a * (0.95 + 0.2 * uNight), a * (0.55 - 0.45 * uNight));
}
`;

export class Beacons {
  readonly group = new THREE.Group();

  constructor(u: Uniforms) {
    const quad = new THREE.PlaneGeometry(2, 1).translate(0, 0.5, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute(
      'aIdx',
      new THREE.InstancedBufferAttribute(
        Float32Array.from({ length: MAX_CAVERNS }, (_, i) => i),
        1,
      ),
    );
    geo.instanceCount = MAX_CAVERNS;
    const mesh = new THREE.Mesh(
      geo,
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
}
