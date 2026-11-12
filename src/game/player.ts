import * as THREE from 'three';
import type { PlayerState, SurfaceSample, World } from './contract';

const WALK = 5.2;
const RUN = 9.5;
const GRAVITY = 20;
const JUMP = 7.5;
const MAX_SPEED = 32;

export interface PlayerInput {
  x: number; // strafe, -1..1 (right positive)
  z: number; // forward, -1..1
  run: boolean;
  jump: boolean; // true on the frame the key went down
}

export interface PlayerEvents {
  step(x: number, z: number, heading: number, side: -1 | 1, slope: number): void;
  jump(): void;
  land(strength: number): void;
}

/** Walk, run, jump and slide on the terrain. Steep sand turns into a slide automatically. */
export class Player {
  readonly state: PlayerState = {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    speed: 0,
    grounded: true,
    sliding: false,
    running: false,
    onRock: 0,
  };
  /** Direction the figure faces, radians around y. */
  facing = 0;
  /** Unit downhill direction (x, z) and slope steepness (rise over run) under the feet. */
  readonly downhill = new THREE.Vector2();
  slope = 0;
  /** 0..1 walk-cycle phase, for the body bob. */
  stride = 0;

  private n = new THREE.Vector3();
  private s: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private wish = new THREE.Vector2();
  private stepDist = 0;
  private side: -1 | 1 = 1;
  private slideGrace = 0;

  constructor(private world: World) {}

  place(x: number, z: number) {
    const st = this.state;
    st.pos.set(x, this.world.height(x, z), z);
    st.vel.set(0, 0, 0);
    st.grounded = true;
    st.sliding = false;
  }

  update(dt: number, input: PlayerInput, camYaw: number, ev: PlayerEvents) {
    const st = this.state;
    const { pos, vel } = st;
    const w = this.world;

    w.sample(pos.x, pos.z, this.s);
    w.normal(pos.x, pos.z, this.n);
    const gx = -this.n.x / this.n.y; // uphill gradient
    const gz = -this.n.z / this.n.y;
    const slope = Math.hypot(gx, gz);
    this.slope = slope;
    if (slope > 1e-4) this.downhill.set(-gx / slope, -gz / slope);
    st.onRock = this.s.rock;
    const rock = this.s.rock > 0.5;

    // Wish direction in world space. Camera looks along (sin yaw, cos yaw) from behind.
    const fx = -Math.sin(camYaw);
    const fz = -Math.cos(camYaw);
    this.wish.set(fx * input.z - fz * input.x, fz * input.z + fx * input.x);
    const wl = this.wish.length();
    if (wl > 1) this.wish.multiplyScalar(1 / wl);
    st.running = input.run && wl > 0.1;

    if (st.grounded) {
      const hs = Math.hypot(vel.x, vel.z);
      const downSpeed = vel.x * this.downhill.x + vel.z * this.downhill.y;
      const wishDown = this.wish.x * this.downhill.x + this.wish.y * this.downhill.y;

      // Enter or leave a slide.
      if (!st.sliding) {
        if (!rock && slope > 0.42 && (downSpeed > 1.5 || (wl > 0.1 && wishDown > 0.35))) st.sliding = true;
      } else {
        const keep = slope > 0.3 || hs > 6.5;
        this.slideGrace = keep ? 0.25 : this.slideGrace - dt;
        if (this.slideGrace <= 0 || rock) st.sliding = false;
      }

      if (st.sliding) {
        // Gravity along the slope, light friction, and steering.
        const along = (GRAVITY * slope) / Math.sqrt(1 + slope * slope);
        vel.x += this.downhill.x * along * dt;
        vel.z += this.downhill.y * along * dt;
        // Steering turns the slide but never pushes it faster: drop the part of the
        // input that points along the direction of travel.
        let sx = this.wish.x;
        let sz = this.wish.y;
        if (hs > 0.5) {
          const fwd = (sx * vel.x + sz * vel.z) / hs;
          if (fwd > 0) {
            sx -= (vel.x / hs) * fwd;
            sz -= (vel.z / hs) * fwd;
          }
        }
        vel.x += sx * 9 * dt;
        vel.z += sz * 9 * dt;
        const sp = Math.hypot(vel.x, vel.z);
        if (sp > 1e-3) {
          const drag = Math.max(0, sp - (1.6 + 0.012 * sp * sp) * dt) / sp;
          vel.x *= drag;
          vel.z *= drag;
        }
      } else {
        // Walking: slower uphill, a touch faster downhill.
        const climb = this.wish.x * gx + this.wish.y * gz;
        const factor = Math.min(1.25, Math.max(0.35, 1 - climb * 0.9));
        const target = (input.run ? RUN : WALK) * factor;
        const rate = 1 - Math.exp(-dt * (rock ? 12 : 8));
        vel.x += (this.wish.x * target - vel.x) * rate;
        vel.z += (this.wish.y * target - vel.z) * rate;
        // Very steep sand gives way under you.
        if (!rock && slope > 0.6) {
          vel.x += this.downhill.x * 3 * dt;
          vel.z += this.downhill.y * 3 * dt;
        }
      }

      // Cliffs on rock are barriers: cancel motion into them.
      if (rock && slope > 1.15) {
        const up = (vel.x * gx + vel.z * gz) / slope;
        if (up > 0) {
          vel.x -= (gx / slope) * up;
          vel.z -= (gz / slope) * up;
        }
        vel.x += this.downhill.x * 2.5 * dt;
        vel.z += this.downhill.y * 2.5 * dt;
      }

      const sp2 = Math.hypot(vel.x, vel.z);
      if (sp2 > MAX_SPEED) {
        vel.x *= MAX_SPEED / sp2;
        vel.z *= MAX_SPEED / sp2;
      }

      if (input.jump) {
        vel.y = Math.max(vel.y, 0) * 0.5 + JUMP;
        st.grounded = false;
        st.sliding = false;
        ev.jump();
      } else {
        const nx = pos.x + vel.x * dt;
        const nz = pos.z + vel.z * dt;
        const nh = w.height(nx, nz);
        const follow = (nh - pos.y) / Math.max(dt, 1e-4);
        // If the ground falls away faster than we can follow, we are airborne.
        if (vel.y - follow > GRAVITY * dt * 2 + 2.2) {
          st.grounded = false;
          pos.x = nx;
          pos.z = nz;
          pos.y += vel.y * dt;
          vel.y -= GRAVITY * dt;
        } else {
          pos.set(nx, nh, nz);
          vel.y = follow;
        }
      }

      // Footsteps.
      if (st.grounded && !st.sliding) {
        const moved = Math.hypot(vel.x, vel.z) * dt;
        const strideLen = st.running ? 1.15 : 0.8;
        this.stepDist += moved;
        this.stride = this.stepDist / strideLen;
        if (this.stepDist >= strideLen) {
          this.stepDist -= strideLen;
          this.side = this.side === 1 ? -1 : 1;
          ev.step(pos.x, pos.z, Math.atan2(vel.z, vel.x), this.side, slope);
        }
      }
    } else {
      // Airborne: ballistic with a little air control.
      vel.x += this.wish.x * 4 * dt;
      vel.z += this.wish.y * 4 * dt;
      vel.y -= GRAVITY * dt;
      pos.addScaledVector(vel, dt);
      const h = w.height(pos.x, pos.z);
      if (pos.y <= h) {
        w.normal(pos.x, pos.z, this.n);
        const into = -(vel.x * this.n.x + vel.y * this.n.y + vel.z * this.n.z);
        pos.y = h;
        vel.y = 0;
        st.grounded = true;
        const s2 = Math.hypot(this.n.x, this.n.z) / this.n.y;
        if (s2 > 0.35 && w.sample(pos.x, pos.z, this.s).rock < 0.5) {
          st.sliding = true;
          this.slideGrace = 0.25;
        }
        ev.land(Math.min(1, Math.max(0, into / 14)));
      }
    }

    st.speed = Math.hypot(vel.x, vel.z);
    if (st.speed > 0.4) {
      const want = Math.atan2(vel.x, vel.z);
      let d = want - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.facing += d * (1 - Math.exp(-dt * 10));
    }
  }
}
