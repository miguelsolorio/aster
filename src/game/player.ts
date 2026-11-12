import * as THREE from 'three';
import type { PlayerState, SurfaceSample, World } from './contract';

const CRUISE = 11; // glide speed you can hold on the flat
const BOOST = 17; // with Shift
const WALK = 5.2; // on rock
const RUN = 9.5;
const GRAVITY = 20;
const GLIDE_GRAVITY = 12; // arms spread: the fall is slower
const LIFT = 0.08; // lift per speed squared; glide trims near 12 m/s
const MAX_SPEED = 34;

export interface PlayerInput {
  x: number; // strafe, -1..1 (right positive)
  z: number; // forward, -1..1
  run: boolean;
  jump: boolean; // true on the frame the key went down
  glide: boolean; // Space held
  wind: THREE.Vector2; // unit world wind direction
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
  /** True while airborne with arms spread (Space held). */
  gliding = false;
  /** Flight path angle in radians: positive climbing, negative diving. */
  climb = 0;
  /** Height above the ground, metres. */
  alt = 0;
  /** 0..1 walk-cycle phase on rock. */
  stride = 0;

  private n = new THREE.Vector3();
  private s: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private wish = new THREE.Vector2();
  private stepDist = 0;
  private side: -1 | 1 = 1;
  private pull = 0;

  /** Optional: absolute height of a roof over (x, z), or -Infinity where the ground is open. */
  roof: ((x: number, z: number) => number) | null = null;

  constructor(private world: World) {}

  /** The surface you can stand on: the terrain, or a roof above it. */
  private top(x: number, z: number): number {
    const h = this.world.height(x, z);
    return this.roof ? Math.max(h, this.roof(x, z)) : h;
  }

  place(x: number, z: number) {
    const st = this.state;
    st.pos.set(x, this.top(x, z), z);
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
      this.alt = 0;
      this.climb = 0;
      this.gliding = false;
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
              const push = 10 * Math.max(0, 1 - sp / cruise) * Math.max(0.25, Math.cos(d));
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
          const drag = (wishing ? 0.25 : 1.0) + 0.003 * hs * hs;
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
        // A hop from rest; with momentum, a launch that scales with speed.
        const hsJ = Math.hypot(vel.x, vel.z);
        vel.y = Math.max(vel.y, 0) * 0.5 + (hsJ < 6 ? 5.5 : Math.min(14, 5 + 0.42 * hsJ));
        st.grounded = false;
        ev.jump();
      } else {
        let nx = pos.x + vel.x * dt;
        let nz = pos.z + vel.z * dt;
        let nh = this.top(nx, nz);
        // A wall: anything more than a step higher than where you stand. Slide along it.
        if (nh > pos.y + 0.55) {
          const hx = this.top(nx, pos.z);
          const hz = this.top(pos.x, nz);
          if (hx <= pos.y + 0.55) {
            nz = pos.z;
            vel.z = 0;
            nh = hx;
          } else if (hz <= pos.y + 0.55) {
            nx = pos.x;
            vel.x = 0;
            nh = hz;
          } else {
            nx = pos.x;
            nz = pos.z;
            vel.x = 0;
            vel.z = 0;
            nh = pos.y;
          }
        }
        const follow = (nh - pos.y) / dt;
        // If the ground falls away faster than we can follow, we are airborne.
        if (vel.y - follow > GRAVITY * dt * 2 + 1.7) {
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
      // ---- airborne
      let hs = Math.hypot(vel.x, vel.z);
      let dx = hs > 0.3 ? vel.x / hs : Math.sin(this.facing);
      let dz = hs > 0.3 ? vel.z / hs : Math.cos(this.facing);
      let vy = vel.y;
      const V = Math.hypot(hs, vy);
      this.gliding = input.glide && V > 3;

      // A and D bank the flight round; much less authority with arms folded.
      const yaw = -input.x * (this.gliding ? 1.5 : 0.6);
      turned = yaw;
      const ca = Math.cos(yaw * dt);
      const sa = Math.sin(yaw * dt);
      const ndx = dx * ca + dz * sa;
      dz = -dx * sa + dz * ca;
      dx = ndx;

      const gh = this.top(pos.x, pos.z);
      this.alt = Math.max(0, pos.y - gh);

      if (this.gliding) {
        // A small glider: lift across the direction of flight, drag along it.
        // S pulls up (more lift, more drag), W tucks into a dive.
        const want = input.z < 0 ? 1 : input.z > 0 ? -0.8 : 0;
        this.pull += (want - this.pull) * (1 - Math.exp(-dt * 4));
        // Below trim speed the arms open further to hold the glide, up to a limit.
        const hold = Math.min(2.5, Math.max(1, 150 / Math.max(V * V, 1)));
        const cl = LIFT * hold * (1 + 0.75 * this.pull);
        const cd = 0.003 + 0.62 * cl * cl;
        const gamma = Math.atan2(vy, Math.max(hs, 0.01));
        let aL = Math.min(cl * V * V, GLIDE_GRAVITY * 1.8);
        // ease off as the nose comes up so a fast launch becomes a climb, not a loop
        if (this.pull <= 0.2 && gamma > 0.3) aL *= Math.max(0.25, 1 - (gamma - 0.3) * 2);
        const aD = cd * V * V;
        let ah = (-aD * hs - aL * vy) / Math.max(V, 0.01);
        let ay = (-aD * vy + aL * hs) / Math.max(V, 0.01) - GLIDE_GRAVITY;
        // Rising air where the wind meets a slope.
        w.normal(pos.x, pos.z, this.n);
        const up = Math.min(0.7, Math.max(0, (-this.n.x * input.wind.x - this.n.z * input.wind.y) / this.n.y));
        ay += 10 * up * Math.max(0, 1 - this.alt / 35);
        // A cushion of air just above the sand lets you skim.
        // It only holds you while you still have speed.
        if (this.alt < 1.3 && vy < 0) ay += (1.3 - this.alt) * 7 * Math.min(1, (hs * hs) / 144);
        hs = Math.max(0.5, hs + ah * dt);
        vy += ay * dt;
      } else {
        this.pull += (0 - this.pull) * (1 - Math.exp(-dt * 4));
        vy -= GRAVITY * dt;
        hs *= 1 - 0.03 * dt;
      }

      vel.set(dx * hs, vy, dz * hs);
      this.climb = Math.atan2(vy, Math.max(hs, 0.01));
      // Flying into the side of a building: stop against the wall instead of popping onto its roof.
      {
        const ax = pos.x + vel.x * dt;
        const az = pos.z + vel.z * dt;
        const ay = pos.y + vel.y * dt;
        if (this.top(ax, az) > ay + 0.5 && this.top(ax, az) > gh + 0.6) {
          if (this.top(ax, pos.z) <= ay + 0.5) vel.z = 0;
          else if (this.top(pos.x, az) <= ay + 0.5) vel.x = 0;
          else {
            vel.x = 0;
            vel.z = 0;
          }
        }
      }
      pos.addScaledVector(vel, dt);
      const h = this.top(pos.x, pos.z);
      if (pos.y <= h) {
        w.normal(pos.x, pos.z, this.n);
        const into = -(vel.x * this.n.x + vel.y * this.n.y + vel.z * this.n.z);
        pos.y = h;
        vel.y = 0;
        st.grounded = true;
        this.gliding = false;
        // A shallow touchdown keeps its speed; a steep one digs in.
        if (into > 7) {
          const keep = Math.max(0.45, 1 - (into - 7) * 0.06);
          vel.x *= keep;
          vel.z *= keep;
        }
        if (w.sample(pos.x, pos.z, this.s).rock > 0.5) {
          const sp = Math.hypot(vel.x, vel.z);
          if (sp > WALK) {
            vel.x *= WALK / sp;
            vel.z *= WALK / sp;
          }
        }
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
