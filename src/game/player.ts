import * as THREE from 'three';
import type { PlayerState, SurfaceSample, World } from './contract';
import { BOARD, BOARD_BOOST, BOOTS, CARPET_LIFT, flightSpeed, RUN, RUN_SAND, WALK } from './speeds';

const GRAVITY = 20;
const LIFT_TIME = 3.5; // seconds of climbing in the reserve; refilled on landing
const LIFT_SPEED = 8; // climb rate while jump is held
const ROPE_CLIMB = 2.6; // metres a second up a face on the rope, along the rock
const LIFT_DELAY = 0.2; // a jump held this long turns into a climb; shorter is a plain jump
const GLIDE_SINK = 1.1; // steady sink in a glide: about a metre down for every eight forward
const HOVER_SINK = 4.5; // sink with no direction held: he stops and settles down
const MAX_SPEED = 60;
export const STEP = 0.9; // waist high: the most the figure steps up onto without jumping
const REACH = 0.38; // how far ahead of the feet a wall is felt
const BOOTS_GRIP = 1.5; // and hold on rock this steep (rise over run) before it is a cliff; bare feet give up at CLIFF
const BOOTS_STEEP = 4.2; // the most they make (m/s over the ground) on rock that bare feet could not stand on
const CLIFF = 1.15;
const CLIMB = 16; // the most a board gains up a face, metres of height a second
const CLIMB_BOOST = 24; // with Shift
const ROCK_DRAG = 5; // rock bites a board that is not being driven: let go and it soon stops
const REST = 0.32; // sand steeper than this (rise over run) will not hold a board at rest
const FEATHER = 0.6; // an eagle's feather in the hood: the glide sinks this much as fast
const TAP_GRACE = 0.12; // in flight a press waits this long before climbing, so a double tap can drop instead
const DOUBLE_TAP = 0.3; // two presses this close together in flight drop you

/** The wall test behind Player.walled, on any height query: something above `step` underfoot, at arm's length, or between. */
export function wallAhead(top: (x: number, z: number) => number, x: number, z: number, dx: number, dz: number, step: number): boolean {
  return top(x, z) > step || top(x + dx * 0.5, z + dz * 0.5) > step || top(x + dx, z + dz) > step;
}

/** Metres per step on rock. Running lengthens the stride with speed so the step rate stays put. */
export const strideLength = (speed: number, running: boolean) => (running ? Math.max(1.15, speed / 8.3) : 0.8);

export interface PlayerInput {
  x: number; // strafe, -1..1 (right positive)
  z: number; // forward, -1..1
  run: boolean;
  jump: boolean; // true on the frame the key went down
  lift: boolean; // jump held: climb while the reserve lasts
  drop: boolean; // descend held: fall at full gravity (a double tap of jump in flight drops too)
  wind: THREE.Vector2; // unit world wind direction
}

export interface PlayerEvents {
  step(x: number, z: number, heading: number, side: -1 | 1, slope: number): void;
  jump(): void;
  land(strength: number): void;
  /** A climb has just started. */
  lift?(): void;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The wanderer starts on foot. A board, once given, surfs whatever is under the open sky:
 * momentum carries, turns are carved, and a slope gives or takes speed. It rides rock as
 * it rides sand, up a mountain and up a cliff face too, and rock holds it still where
 * feet could stand. Only underground is walked. A held jump climbs and letting go
 * glides; a carpet, once given, does both faster.
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
  /** True while airborne and floating down on the glide (jump released after a climb). */
  gliding = false;
  /** True while jump is held and the reserve is carrying the figure upward. */
  lifting = false;
  /** Seconds of climb left; refilled on landing. */
  reserve = LIFT_TIME;
  /** Multiplier on the climb reserve: grows with each waking stone woken. */
  lift = 1;
  /** Flight path angle in radians: positive climbing, negative diving. */
  climb = 0;
  /** Height above the ground, metres. */
  alt = 0;
  /** 0..1 walk-cycle phase on rock. */
  stride = 0;
  /** Standing on a board: the ground is ridden instead of walked. */
  board = false;
  /** On the board and where it can be ridden (anywhere but underground), whether moving or not. */
  riding = false;
  /** Has a carpet: flying is faster and the climb lasts longer. */
  carpet = false;
  /** Has a rope and hook: rock too steep to walk is climbed. */
  rope = false;
  /** Climbing a face on the rope this step. */
  roping = false;
  /** Wears nailed boots: quicker on rock, and sure on steeper rock. */
  boots = false;
  /** Has an eagle's feather: the glide sinks slower. */
  feather = false;

  private n = new THREE.Vector3();
  private s: SurfaceSample = { h: 0, rock: 0, salt: 0 };
  private wish = new THREE.Vector2();
  private stepDist = 0;
  private side: -1 | 1 = 1;
  private dodge: -1 | 1 = 1; // which way the figure last turned to get round something
  private holdT = 0; // how long jump has been held since leaving the ground
  private armed = true; // false just after a jump, until the hold is long enough to be a climb
  private flew = false; // a climb has happened this flight, so releasing glides
  private clock = 0;
  private lastTap = -1; // clock at the last jump press made in flight; -1 when there is none to pair with
  private dropping = false; // double-tapped: falling until landing or until jump is held again
  private released = false; // jump has been let go since the drop began, so a fresh hold can catch you

  /** Optional: absolute height of a roof over (x, z) for feet at height y, or -Infinity where the ground is open. */
  roof: ((x: number, z: number, y: number) => number) | null = null;

  /** Optional: whether feet at (x, z, y) stand on something hard that is not the ground: a stone, a bone. */
  hard: ((x: number, z: number, y: number) => boolean) | null = null;

  /** Optional: whether feet at (x, z, y) stand on sand whatever the ground far below them is: the roof left over a cavern. */
  soft: ((x: number, z: number, y: number) => boolean) | null = null;

  /** Optional: whether an animal stands at (x, z). It is a wall on foot, never a floor. */
  beast: ((x: number, z: number) => boolean) | null = null;
  /** Standing inside one already (it walked onto you): let the feet out rather than stick. */
  private inBeast = false;

  constructor(private world: World) {}

  /** Optional: how far the ground is sunk below the terrain at (x, z), e.g. the bed of a pool. */
  dip: ((x: number, z: number) => number) | null = null;

  /**
   * Optional: the floor for feet at height y over (x, z) where something other than the terrain
   * decides it (the deep under a cavern, which has rooms over rooms), or null where the terrain's
   * own height stands. A floor far above y is a wall; solid rock all the way up is +Infinity.
   */
  floor: ((x: number, z: number, y: number) => number | null) | null = null;

  /** True while the feet are where `floor` has the say: underground, on cut rock. */
  under = false;

  /** The ground itself: the terrain, or the bed of a pool sunk into it. */
  private ground(x: number, z: number): number {
    return this.world.height(x, z) - (this.dip ? this.dip(x, z) : 0);
  }

  /** The surface you can stand on: a floor underground, else the terrain (or a pool bed), or a roof above it. */
  private top(x: number, z: number): number {
    if (this.floor) {
      const f = this.floor(x, z, this.state.pos.y);
      if (f !== null) return f;
    }
    const h = this.ground(x, z);
    return this.roof ? Math.max(h, this.roof(x, z, this.state.pos.y)) : h;
  }

  /**
   * How high whatever might stop you stands at (x, z). On foot that is the surface, so ground
   * rising more than a step is a wall. A board rides up any ground, however steep: to it only
   * what stands on the ground is in the way, and bare ground is no height at all.
   */
  private block(x: number, z: number): number {
    const t = this.top(x, z);
    return this.riding && !this.isUnder(x, z) && t <= this.ground(x, z) + 0.05 ? -Infinity : t;
  }

  /** Whether feet at (x, z), at the height they are now, are where `floor` has the say. */
  private isUnder(x: number, z: number): boolean {
    return !!this.floor && this.floor(x, z, this.state.pos.y) !== null;
  }

  /**
   * Whether standing at (x, z) and facing along (dx, dz) puts a wall in the way: anything
   * above `step` under the feet, at arm's length, or between the two. The point between is
   * what catches a thing thinner than the reach, which the far point alone would look past.
   */
  private walled(x: number, z: number, dx: number, dz: number, step: number): boolean {
    if (this.beast && !this.inBeast && (this.beast(x, z) || this.beast(x + dx * 0.5, z + dz * 0.5) || this.beast(x + dx, z + dz))) return true;
    return wallAhead((px, pz) => this.block(px, pz), x, z, dx, dz, step);
  }

  place(x: number, z: number) {
    const st = this.state;
    const h = this.top(x, z);
    st.pos.set(x, Number.isFinite(h) ? h : this.world.height(x, z), z);
    st.vel.set(0, 0, 0);
    st.grounded = true;
    st.sliding = false;
  }

  update(dt: number, input: PlayerInput, camYaw: number, ev: PlayerEvents) {
    this.roping = false;
    const st = this.state;
    const { pos, vel } = st;
    const w = this.world;
    if (dt <= 0) return;
    this.clock += dt;

    // Underground the ground is cut rock, and level as far as riding and sliding go: the
    // terrain overhead, and whatever slope it has, is nothing to do with the feet.
    const under = (this.under = !!this.floor && this.floor(pos.x, pos.z, pos.y) !== null);
    if (under) {
      this.s.rock = 1;
      this.s.salt = 0;
      this.n.set(0, 1, 0);
    } else {
      w.sample(pos.x, pos.z, this.s);
      w.normal(pos.x, pos.z, this.n);
    }
    const gx = -this.n.x / this.n.y; // uphill gradient
    const gz = -this.n.z / this.n.y;
    const slope = Math.hypot(gx, gz);
    this.slope = slope;
    if (slope > 1e-4) this.downhill.set(-gx / slope, -gz / slope);
    // A stone or a bone underfoot is walked on like rock, whatever the ground beneath it is.
    st.onRock = under ? 1 : st.grounded && this.hard?.(pos.x, pos.z, pos.y) ? 1 : this.soft?.(pos.x, pos.z, pos.y) ? 0 : this.s.rock;
    const rock = st.onRock > 0.5;
    const riding = (this.riding = this.board && !under);

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
      this.lifting = false;
      this.reserve = LIFT_TIME * this.lift * (this.carpet ? CARPET_LIFT : 1);
      this.holdT = 0;
      this.armed = true;
      this.flew = false;
      this.lastTap = -1;
      this.dropping = false;
      let hs = Math.hypot(vel.x, vel.z);

      if (!riding) {
        // ---- walking: until there is a board to ride, and underground
        st.sliding = false;
        const climb = this.wish.x * gx + this.wish.y * gz;
        // Sand gives underfoot: a dune face is slower going up than rock of the same pitch.
        const shod = rock && this.boots;
        const factor = rock ? Math.min(1.2, Math.max(0.35, 1 - climb * 0.9)) : Math.min(1.12, Math.max(0.3, 1 - climb * 1.3));
        let target = (input.run ? (rock ? RUN : RUN_SAND) : WALK) * factor * (shod ? BOOTS : 1);
        // Nailed boots hold where bare feet slide off, but nobody runs up such a face.
        const cliff = shod ? BOOTS_GRIP : CLIFF;
        if (shod && slope > CLIFF) target = Math.min(target, BOOTS_STEEP);
        const rate = 1 - Math.exp(-dt * 6);
        vel.x += (this.wish.x * target - vel.x) * rate;
        vel.z += (this.wish.y * target - vel.z) * rate;
        // Cliffs are barriers: cancel motion into them. With a rope and hook they are climbed
        // instead: slowly, hand over hand, and held wherever the climbing stops.
        if (slope > cliff && this.rope) {
          const sp = wishing ? ROPE_CLIMB / Math.sqrt(1 + slope * slope) : 0;
          vel.x = this.wish.x * sp;
          vel.z = this.wish.y * sp;
          this.roping = wishing && climb > 0;
        } else if (slope > cliff) {
          const up = (vel.x * gx + vel.z * gz) / slope;
          if (up > 0) {
            vel.x -= (gx / slope) * up;
            vel.z -= (gz / slope) * up;
          }
          vel.x += this.downhill.x * 2.5 * dt;
          vel.z += this.downhill.y * 2.5 * dt;
        }
      } else {
        // ---- gliding, on sand and on rock alike
        // The slope pulls you along it. Climbing under power is eased so dunes
        // can be crested; standing still on gentle ground does not creep.
        // Rock grips where sand gives: let go on it and the board is not pulled downhill
        // at all, on anything feet could stand on (boots stand on steeper, a rope on any).
        const along = (GRAVITY * slope) / Math.sqrt(1 + slope * slope);
        const velDown = hs > 0.2 ? (vel.x * this.downhill.x + vel.z * this.downhill.y) / hs : 0;
        const grip = this.rope ? Infinity : this.boots ? BOOTS_GRIP : CLIFF;
        const wishDown = this.wish.x * this.downhill.x + this.wish.y * this.downhill.y;
        let pull = 0.85;
        // (driving uphill counts from a standstill and against a slide too, or a steep face could never be started up)
        if (wishing && (velDown < 0 || wishDown < -0.1)) pull = 0.22;
        else if (!wishing && (rock ? slope < grip : hs < 1.2 && slope < REST)) pull = 0;
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
              const sp = Math.hypot(vx, vz);
              const rise = (vx * gx + vz * gz) / sp;
              const cruise = Math.min(input.run ? BOARD_BOOST : BOARD, (input.run ? CLIMB_BOOST : CLIMB) / Math.max(rise, 1e-3));
              // Boosting also cancels most of the speed-squared drag, so Shift can hold its higher speed.
              const hold = input.run && sp < cruise ? 0.003 * sp * sp : 0;
              const push = (10 * Math.max(0, 1 - sp / cruise) + hold) * Math.max(0.25, Math.cos(d));
              vel.x += (vx / sp) * push * dt;
              vel.z += (vz / sp) * push * dt;
            }
          } else {
            // Push off from rest.
            vel.x += this.wish.x * 7 * dt;
            vel.z += this.wish.y * 7 * dt;
          }
        }

        // A face is climbed no faster than the board can gain height, so a cliff is ridden
        // up at a crawl over the ground and speed carried into one is soon spent.
        hs = Math.hypot(vel.x, vel.z);
        if (hs > 1e-3) {
          const rise = (vel.x * gx + vel.z * gz) / hs;
          const climb = input.run && wishing ? CLIMB_BOOST : CLIMB;
          const most = climb / Math.max(rise, 1e-3);
          // (the rise the ground gave last step is held to the same, so slowing on a face does not throw you off it)
          vel.y = Math.min(vel.y, climb);
          if (hs > most) {
            const k = (most + (hs - most) * Math.exp(-dt * 6)) / hs;
            vel.x *= k;
            vel.z *= k;
          }
        }

        // Drag: light while you ride, firmer when you let go, and firmer still on rock.
        hs = Math.hypot(vel.x, vel.z);
        if (hs > 1e-3) {
          const drag = (wishing ? 0.25 : rock ? ROCK_DRAG : 1.0) + 0.003 * hs * hs;
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
        this.armed = false;
        ev.jump();
      } else {
        let nx = pos.x + vel.x * dt;
        let nz = pos.z + vel.z * dt;
        let nh = this.top(nx, nz);
        // A wall: anything more than waist high above where you stand. Lower than that is
        // stepped up onto; higher has to be jumped. Look a body's width ahead so the figure
        // stops short of it, and slide along it.
        const spd = Math.hypot(vel.x, vel.z);
        const ox = spd > 1e-3 ? (vel.x / spd) * REACH : 0;
        const oz = spd > 1e-3 ? (vel.z / spd) * REACH : 0;
        const step = pos.y + STEP;
        this.inBeast = !!this.beast && this.beast(pos.x, pos.z);
        if (this.walled(nx, nz, ox, oz, step)) {
          if (!this.walled(nx, pos.z, ox, 0, step) && this.block(nx + ox, pos.z + oz) <= step) {
            nz = pos.z;
            vel.z = 0;
          } else if (!this.walled(pos.x, nz, 0, oz, step) && this.block(pos.x + ox, nz + oz) <= step) {
            nx = pos.x;
            vel.x = 0;
          } else {
            nx = pos.x;
            nz = pos.z;
            vel.x = 0;
            vel.z = 0;
          }
          // Meeting something square on leaves no way along it by x or z alone. Turn aside
          // instead, as little as clears it, and keep to the side already chosen so the
          // figure walks round a post rather than dithering in front of it.
          const dist = spd * dt;
          if (spd > 0.3 && Math.hypot(nx - pos.x, nz - pos.z) < dist * 0.35) {
            const ux = ox / REACH; // the way it was heading before the wall took that from it
            const uz = oz / REACH;
            turn: for (const a of [0.45, 0.9, 1.3]) {
              for (const side of [this.dodge, -this.dodge]) {
                const ca = Math.cos(a * side);
                const sa = Math.sin(a * side);
                const rx = ux * ca - uz * sa;
                const rz = ux * sa + uz * ca;
                const cx = pos.x + rx * dist;
                const cz = pos.z + rz * dist;
                if (this.walled(cx, cz, rx * REACH, rz * REACH, step)) continue;
                this.dodge = side as -1 | 1;
                nx = cx;
                nz = cz;
                const keep = spd * Math.cos(a * 0.7);
                vel.x = rx * keep;
                vel.z = rz * keep;
                break turn;
              }
            }
          }
          nh = this.top(nx, nz);
          // (stood where the rock is solid all the way up, which nothing should allow: stay level, do not climb it)
          // (and ground a board has ridden up is stood on at its own height, not a step's)
          nh = nh === Infinity ? pos.y : this.block(nx, nz) === -Infinity ? nh : Math.min(nh, step);
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
          // The ground's own rise is kept, so a crest taken fast throws you off it. A step
          // up onto a roof, a stone or a bone is not a slope and throws nobody.
          // Nor is a stair underground.
          vel.y = follow > 0 && (this.isUnder(nx, nz) || nh > w.height(nx, nz) + 0.05) ? 0 : follow;
        }
      }

      // Footsteps only where you walk.
      if (st.grounded && !riding) {
        const sp = Math.hypot(vel.x, vel.z);
        const strideLen = strideLength(sp, st.running);
        this.stepDist += sp * dt;
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

      const gh = this.top(pos.x, pos.z);
      this.alt = Math.max(0, pos.y - gh);

      // Holding jump climbs on the reserve. Straight after a jump the hold has to last a
      // moment first, so a tap stays a jump; once in the air a press climbs at once.
      if (input.lift) {
        this.holdT += dt;
        if (this.holdT >= LIFT_DELAY) this.armed = true;
      } else {
        this.holdT = 0;
        this.armed = true;
        if (this.dropping) this.released = true;
      }

      // Two quick presses in flight drop you. Only counts once you are flying, so hops never drop.
      if (input.jump && this.flew) {
        if (this.lastTap >= 0 && this.clock - this.lastTap <= DOUBLE_TAP) {
          this.dropping = true;
          this.released = false;
          this.lastTap = -1;
        } else {
          this.lastTap = this.clock;
        }
      }
      // A fresh hold, long enough not to be a tap, catches the drop.
      if (this.dropping && this.released && input.lift && this.holdT >= LIFT_DELAY) this.dropping = false;
      const drop = input.drop || this.dropping;

      const wasLifting = this.lifting;
      const grace = this.flew ? TAP_GRACE : 0;
      this.lifting = input.lift && this.armed && this.holdT >= grace && this.reserve > 0 && !drop;
      if (this.lifting) {
        this.flew = true;
        this.lastTap = -1; // a press held into a climb is not the first half of a double tap
        if (!wasLifting) ev.lift?.();
      }
      this.gliding = this.flew && !this.lifting && !drop;

      // Steering: the same as on the ground. Swing the heading toward where the stick points.
      const flying = this.flew;
      if (wishing) {
        if (hs > 0.3) {
          const d = wrap(Math.atan2(this.wish.x, this.wish.y) - Math.atan2(dx, dz));
          const maxRate = flying ? 6.5 : 3;
          const rate = Math.min(maxRate, Math.max(-maxRate, d * 5));
          turned = rate;
          const ca = Math.cos(rate * dt);
          const sa = Math.sin(rate * dt);
          const ndx = dx * ca + dz * sa;
          dz = -dx * sa + dz * ca;
          dx = ndx;
        } else {
          dx = this.wish.x / wl;
          dz = this.wish.y / wl;
        }
      }

      if (flying) {
        // Speed: pushing a direction brings you up to glide speed, scaled by how far the
        // stick is pushed. Let go and he eases to a stop in the air and settles straight
        // down, so you can come to rest over a roof. Extra speed from a fast launch bleeds off.
        // Shift raises the glide speed. Either is reached in about a second.
        const full = flightSpeed(this.carpet, input.run);
        const want = wishing ? full * Math.min(1, wl) : 0;
        if (hs > want) hs += (want - hs) * (1 - Math.exp(-dt * (wishing ? 0.8 : 2.2)));
        else hs = Math.min(want, hs + full * dt);
      } else {
        hs *= 1 - 0.03 * dt;
      }

      if (this.lifting) {
        // The climb weakens through its last second and tips over into the glide.
        const strength = Math.min(1, this.reserve);
        this.reserve = Math.max(0, this.reserve - dt);
        const target = LIFT_SPEED * strength - GLIDE_SINK * (1 - strength);
        if (vy > target) vy = Math.max(target, vy - GRAVITY * 0.5 * dt); // a hard launch coasts up
        else vy += (target - vy) * (1 - Math.exp(-dt * 5));
      } else if (this.gliding) {
        // A steady, gentle sink. Rising air where the wind meets a slope holds you up,
        // and the last metre and a half is slower still, for a soft touchdown.
        if (under) this.n.set(0, 1, 0);
        else w.normal(pos.x, pos.z, this.n);
        const up = Math.min(0.7, Math.max(0, (-this.n.x * input.wind.x - this.n.z * input.wind.y) / this.n.y));
        const ridge = 6 * up * Math.max(0, 1 - this.alt / 35);
        const near = Math.min(1, this.alt / 1.5);
        // Hovering in place comes down faster than a forward glide, but still gently.
        const still = 1 - Math.min(1, hs / 6);
        const target = -(GLIDE_SINK + (HOVER_SINK - GLIDE_SINK) * still) * (this.feather ? FEATHER : 1) * (0.6 + 0.4 * near) + ridge * (1 - still);
        if (vy > target) vy = Math.max(target, vy - GRAVITY * 0.5 * dt); // float over the top
        else vy += (target - vy) * (1 - Math.exp(-dt * 3.5)); // catch a fall
      } else {
        vy = Math.max(-45, vy - GRAVITY * dt);
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
      const bx = pos.x;
      const by = pos.y;
      const bz = pos.z;
      pos.addScaledVector(vel, dt);
      let h = this.top(pos.x, pos.z);
      if (h === Infinity) {
        // into solid rock (underground, a wall with nothing over it): the move is not made
        pos.set(bx, Math.min(by, pos.y), bz);
        vel.x = 0;
        vel.z = 0;
        h = this.top(bx, bz);
        if (h === Infinity) h = -Infinity;
      }
      if (pos.y <= h) {
        const below = this.isUnder(pos.x, pos.z);
        if (below) this.n.set(0, 1, 0);
        else w.normal(pos.x, pos.z, this.n);
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
        st.onRock = below ? 1 : this.hard?.(pos.x, pos.z, pos.y) ? 1 : this.soft?.(pos.x, pos.z, pos.y) ? 0 : w.sample(pos.x, pos.z, this.s).rock;
        const onRock = st.onRock > 0.5;
        if (below || !this.board) {
          const sp = Math.hypot(vel.x, vel.z);
          const cap = input.run ? (onRock ? RUN : RUN_SAND) : WALK;
          if (sp > cap) {
            vel.x *= cap / sp;
            vel.z *= cap / sp;
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
