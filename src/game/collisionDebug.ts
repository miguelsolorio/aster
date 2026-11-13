// A toggleable overlay that shows what the wanderer would bump into. It samples the same solid
// query the player's roof uses (so it covers finds, city extras and props alike) on a fine grid
// around the feet and draws a flat tile at each top it finds: red where the top is higher than a
// step above the feet (a wall), green where it can be stepped onto. Nothing runs while it is off.
import * as THREE from 'three';
import { STEP } from './player';

const RADIUS = 30;
const CELL = 0.5;
const N = Math.ceil((RADIUS * 2) / CELL);
const REFRESH = 0.2; // seconds between scans
const MIN_ABOVE_GROUND = 0.15;

export class CollisionOverlay {
  on = false;
  private mesh: THREE.InstancedMesh | null = null;
  private t = 0;
  private readonly m = new THREE.Matrix4();
  private readonly red = new THREE.Color(0xff3030);
  private readonly green = new THREE.Color(0x30ff60);

  constructor(
    private readonly scene: THREE.Scene,
    /** Absolute height of the top of whatever solid stands over (x, z) for feet at y, or -Infinity. */
    private readonly query: (x: number, z: number, y: number) => number,
    private readonly ground: (x: number, z: number) => number,
  ) {}

  toggle(): boolean {
    this.on = !this.on;
    if (this.on) this.build();
    else this.dispose();
    this.t = 0;
    return this.on;
  }

  private build() {
    const geo = new THREE.BoxGeometry(CELL, 0.1, CELL);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthTest: false, depthWrite: false });
    const mesh = new THREE.InstancedMesh(geo, mat, N * N);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 9999;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh = mesh;
    this.scene.add(mesh);
  }

  private dispose() {
    const mesh = this.mesh;
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    mesh.dispose();
    this.mesh = null;
  }

  update(dt: number, px: number, py: number, pz: number) {
    const mesh = this.mesh;
    if (!this.on || !mesh) return;
    this.t -= dt;
    if (this.t > 0) return;
    this.t = REFRESH;
    const x0 = Math.floor((px - RADIUS) / CELL) * CELL;
    const z0 = Math.floor((pz - RADIUS) / CELL) * CELL;
    let n = 0;
    for (let j = 0; j < N; j++) {
      const z = z0 + (j + 0.5) * CELL;
      for (let i = 0; i < N; i++) {
        const x = x0 + (i + 0.5) * CELL;
        const dx = x - px;
        const dz = z - pz;
        if (dx * dx + dz * dz > RADIUS * RADIUS) continue;
        const top = this.query(x, z, py);
        if (!Number.isFinite(top) || top < this.ground(x, z) + MIN_ABOVE_GROUND) continue;
        this.m.makeTranslation(x, top + 0.05, z);
        mesh.setMatrixAt(n, this.m);
        mesh.setColorAt(n, top > py + STEP ? this.red : this.green);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}
