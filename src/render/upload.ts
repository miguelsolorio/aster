import * as THREE from 'three';

// Sends the buffers of hidden meshes to the GPU ahead of the frame they are first shown in, one
// mesh a frame. A city's full detail is built hidden kilometres out and shown all at once at
// 1.5 km; without this its 100k-plus triangles go up in that one frame.
//
// The trick: for the frame's render, the queued mesh (and the hidden groups above it, with
// everything else under them kept hidden) is let through with a draw range of one triangle whose
// every fragment fails the depth test. three uploads its attributes and index and binds its
// program, and the driver builds its pipeline for that vertex layout and blend (ANGLE on Metal
// does that at the first real draw, which a draw of nothing skips), and nothing is drawn. A
// material that does not depth-test gets a draw range of nothing instead. All is put back right
// after the render.

export class Uploader {
  private readonly queue: THREE.Object3D[] = [];
  private readonly done = new WeakSet<THREE.BufferGeometry>();
  private readonly flipped: THREE.Object3D[] = [];
  private readonly hidden: THREE.Object3D[] = [];
  private cur: { o: THREE.Mesh; count: number; culled: boolean; mats: Array<{ m: THREE.Material; f: THREE.DepthModes }> } | null = null;

  /** Queues every mesh, points or lines under root whose geometry has not been sent yet. */
  add(root: THREE.Object3D): void {
    root.traverse((o) => {
      const d = o as THREE.Mesh;
      if (!(d.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) || !d.geometry || this.done.has(d.geometry)) return;
      this.queue.push(o);
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Call just before the frame's render. */
  before(): void {
    let o: THREE.Mesh | undefined;
    while (this.queue.length > 0) {
      const c = this.queue.shift() as THREE.Mesh;
      // (gone from the scene, or already sent through a shared geometry)
      if (this.done.has(c.geometry) || !inScene(c)) continue;
      o = c;
      break;
    }
    if (!o) return;
    this.done.add(o.geometry);
    // the hidden groups above it are let through, with all else under the highest of them kept hidden
    const path: THREE.Object3D[] = [];
    let top = -1;
    for (let a: THREE.Object3D | null = o; a; a = a.parent) {
      if (!a.visible) top = path.length;
      path.push(a);
    }
    if (top < 0) return; // shown anyway: it is drawn and sent as it is
    for (let i = 0; i <= top; i++) {
      const a = path[i];
      if (!a.visible) {
        a.visible = true;
        this.flipped.push(a);
      }
      if (i === 0) continue;
      for (const s of a.children) {
        if (s === path[i - 1] || !s.visible) continue;
        s.visible = false;
        this.hidden.push(s);
      }
    }
    for (const s of o.children) {
      if (!s.visible) continue;
      s.visible = false;
      this.hidden.push(s);
    }
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const hidden = (o as THREE.Mesh).isMesh && list.every((m) => m.depthTest);
    this.cur = { o, count: o.geometry.drawRange.count, culled: o.frustumCulled, mats: hidden ? list.map((m) => ({ m, f: m.depthFunc })) : [] };
    if (hidden) for (const m of list) m.depthFunc = THREE.NeverDepth;
    o.geometry.drawRange.count = hidden ? 3 : 0;
    o.frustumCulled = false;
  }

  /** Call right after the frame's render. */
  after(): void {
    for (const o of this.flipped) o.visible = false;
    for (const o of this.hidden) o.visible = true;
    this.flipped.length = 0;
    this.hidden.length = 0;
    const c = this.cur;
    if (!c) return;
    c.o.geometry.drawRange.count = c.count;
    c.o.frustumCulled = c.culled;
    for (const { m, f } of c.mats) m.depthFunc = f;
    this.cur = null;
  }
}

function inScene(o: THREE.Object3D): boolean {
  let a: THREE.Object3D | null = o;
  while (a.parent) a = a.parent;
  return (a as THREE.Scene).isScene === true;
}
