import * as THREE from 'three';
import type { PlayerState, SurfaceSample, World } from './contract';

const CRUISE = 8.5; // glide speed you can hold on the flat
const BOOST = 13.5; // with Shift
const WALK = 5.2; // on rock
const RUN = 9.5;
const GRAVITY = 20;
const JUMP = 7.5;
const MAX_SPEED = 34;

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

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The wanderer surfs the sand: momentum carries, turns are carved, and dune
 * faces give or take speed. On bare rock there is nothing to glide on, so it walks.
 */
export class Player {
  readonly state: PlayerState = {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    speed: 0,
    grounded: true,
    sliding: false, // true while gliding on sand
    running: false,
    onRock: 0,
  };
  /** Direction the figure faces, radians around y. */
  facing = 0;
  /** Unit downhill direction (x, z) and slope steepness (rise over run) under the feet. */
  readonly downhill = new THREE.Vector2();
  slope = 0;
  /** Smoothed turning rate in rad/s, positive to the figure's left. Drives banking and spray. */
  turn = 0;
  /** 0..1 walk-cycle phase on rock. */
  stride = 0;

  private n = new THREE.Vector3();
  private s: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private wish = new THREE.Vector2();
  private stepDist = 0;
  private side: -1 | 1 = 1;

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
    if (dt <= 0) return;

    w.sample(pos.x, pos.z, this.s);
    w.normal(pos.x, pos.z, this.n);
    const gx = -this.n.x / this.n.y; // uphill gradient
    const gz = -this.n.z / this.n.y;
    const slope = Math.hypot(gx, gz);
    this.slope = slope;
    if (slope > 1e-4) this.downhill.set(-gx / slope, -gz / slope);
    st.onRock = this.s.rock;
    const rock = this.s.rock > 0.5;

    // Wish direction in world space, relative to the camera.
    const fx = -Math.sin(camYaw);
    const fz = -Math.cos(camYaw);
    this.wish.set(fx * input.z - fz * input.x, fz * input.z + fx * input.x);
    const wl = this.wish.length();
    if (wl > 1) this.wish.multiplyScalar(1 / wl);
    const wishing = wl > 0.1;
    st.running = input.run && wishing;
    let turned = 0;

    if (st.grounded) {
      let hs = Math.hypot(vel.x, vel.z);

      if (rock) {
        // ---- walking on rock
        st.sliding = false;
        const climb = this.wish.x * gx + this.wish.y * gz;
        const factor = Math.min(1.2, Math.max(0.35, 1 - climb * 0.9));
        const target = (input.run ? RUN : WALK) * factor;
        const rate = 1 - Math.exp(-dt * 6);
        vel.x += (this.wish.x * target - vel.x) * rate;
        vel.z += (this.wish.y * target - vel.z) * rate;
        // Cliffs are barriers: cancel motion into them.
        if (slope > 1.15) {
          const up = (vel.x * gx + vel.z * gz) / slope;
          if (up > 0) {
            vel.x -= (gx / slope) * up;
            vel.z -= (gz / slope) * up;
          }
          vel.x += this.downhill.x * 2.5 * dt;
          vel.z += this.downhill.y * 2.5 * dt;
        }
      } else {
        // ---- gliding on sand
        // The slope pulls you along it. Climbing under power is eased so dunes
        // can be crested; standing still on gentle ground does not creep.
        const along = (GRAVITY * slope) / Math.sqrt(1 + slope * slope);
        const velDown = hs > 0.2 ? (vel.x * this.downhill.x + vel.z * this.downhill.y) / hs : 0;
        let pull = 0.85;
        if (velDown < 0 && wishing) pull = 0.22;
        else if (hs < 1.2 && !wishing && slope < 0.32) pull = 0;
        vel.x += this.downhill.x * along * pull * dt;
        vel.z += this.downhill.y * along * pull * dt;

        if (wishing) {
          if (hs > 0.8) {
            // Carve: swing the direction of travel toward where you point, keeping speed.
            const cur = Math.atan2(vel.x, vel.z);
            const d = wrap(Math.atan2(this.wish.x, this.wish.y) - cur);
            if (Math.abs(d) > 2.3) {
              // Pointing back the way you came: dig in and brake.
              const k = Math.max(0, hs - 10 * dt) / hs;
              vel.x *= k;
              vel.z *= k;
            } else {
              const maxRate = 2.7 - 1.3 * Math.min(1, hs / 22);
              const rate = Math.min(maxRate, Math.max(-maxRate, d * 3.2));
              const a = rate * dt;
              turned = rate;
              const ca = Math.cos(a);
              const sa = Math.sin(a);
              const scrub = 1 - 0.1 * Math.abs(a);
              const vx = (vel.x * ca + vel.z * sa) * scrub;
              const vz = (-vel.x * sa + vel.z * ca) * scrub;
              vel.x = vx;
              vel.z = vz;
              // Push toward cruising speed; the push fades as you reach it.
              const cruise = input.run ? BOOST : CRUISE;
              const sp = Math.hypot(vx, vz);
              const push = 8 * Math.max(0, 1 - sp / cruise) * Math.max(0.25, Math.cos(d));
              vel.x += (vx / sp) * push * dt;
              vel.z += (vz / sp) * push * dt;
            }
          } else {
            // Push off from rest.
            vel.x += this.wish.x * 7 * dt;
            vel.z += this.wish.y * 7 * dt;
          }
        }

        // Sand drag: light while you ride, firmer when you let go.
        hs = Math.hypot(vel.x, vel.z);
        if (hs > 1e-3) {
          const drag = (wishing ? 0.25 : 1.0) + 0.006 * hs * hs;
          const k = Math.max(0, hs - drag * dt) / hs;
          vel.x *= k;
          vel.z *= k;
        }
        st.sliding = Math.hypot(vel.x, vel.z) > 1.2;
      }

      const sp2 = Math.hypot(vel.x, vel.z);
      if (sp2 > MAX_SPEED) {
        vel.x *= MAX_SPEED / sp2;
        vel.z *= MAX_SPEED / sp2;
      }

      if (input.jump) {
        vel.y = Math.max(vel.y, 0) * 0.5 + JUMP;
        st.grounded = false;
        ev.jump();
      } else {
        const nx = pos.x + vel.x * dt;
        const nz = pos.z + vel.z * dt;
        const nh = w.height(nx, nz);
        const follow = (nh - pos.y) / dt;
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

      // Footsteps only where you walk.
      if (st.grounded && rock) {
        const strideLen = st.running ? 1.15 : 0.8;
        this.stepDist += Math.hypot(vel.x, vel.z) * dt;
        this.stride = this.stepDist / strideLen;
        if (this.stepDist >= strideLen) {
          this.stepDist -= strideLen;
          this.side = this.side === 1 ? -1 : 1;
          ev.step(pos.x, pos.z, Math.atan2(vel.z, vel.x), this.side, slope);
        }
      }
    } else {
      // ---- airborne: ballistic with a little air control
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
        ev.land(Math.min(1, Math.max(0, into / 14)));
      }
    }

    this.turn += (turned - this.turn) * (1 - Math.exp(-dt * 6));
    st.speed = Math.hypot(vel.x, vel.z);
    if (st.speed > 0.4) {
      const d = wrap(Math.atan2(vel.x, vel.z) - this.facing);
      this.facing += d * (1 - Math.exp(-dt * 10));
    }
  }
}
