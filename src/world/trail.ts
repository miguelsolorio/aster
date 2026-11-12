import * as THREE from 'three';

/** Footprints stamped into a canvas texture (world-space top-down map). */
export class Trail {
  readonly texture: THREE.CanvasTexture;
  readonly rect: [number, number, number];
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly res: number;

  constructor(cx: number, cz: number, size = 96, res = 2048) {
    this.res = res;
    this.rect = [cx - size / 2, cz - size / 2, size];
    this.canvas = document.createElement('canvas');
    this.canvas.width = res;
    this.canvas.height = res;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Trail: 2D context unavailable');
    this.ctx = ctx;
    this.clear();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.flipY = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
  }

  /** Stamp one footprint; heading = atan2(dz, dx), side = -1 / +1 (left/right). */
  stamp(x: number, z: number, heading: number, side: -1 | 1): void {
    const [ox, oz, size] = this.rect;
    const ppm = this.res / size; // pixels per metre
    // sideways offset perpendicular to heading
    const px = (x - ox) * ppm + -Math.sin(heading) * 0.17 * side * ppm;
    const py = (z - oz) * ppm + Math.cos(heading) * 0.17 * side * ppm;

    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(px, py);
    ctx.rotate(heading);
    ctx.scale(0.21 * ppm, 0.11 * ppm); // semi-axes: 0.42 m long, 0.22 m wide
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this.texture.needsUpdate = true;
  }

  /** Stamp alternating footprints every `stride` metres along a polyline. */
  walk(points: Array<[number, number]>, stride = 0.75): void {
    let side: -1 | 1 = -1;
    let carry = 0; // distance already travelled since the last stamp
    for (let i = 0; i + 1 < points.length; i++) {
      const [x0, z0] = points[i];
      const [x1, z1] = points[i + 1];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len === 0) continue;
      const heading = Math.atan2(dz, dx);
      let d = stride - carry;
      while (d <= len) {
        const t = d / len;
        this.stamp(x0 + dx * t, z0 + dz * t, heading, side);
        side = side === -1 ? 1 : -1;
        d += stride;
      }
      carry = len - (d - stride);
    }
  }

  /** Reset the canvas to black. */
  clear(): void {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.res, this.res);
    if (this.texture) this.texture.needsUpdate = true;
  }
}
