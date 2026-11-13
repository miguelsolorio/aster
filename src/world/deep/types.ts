// The deep: what lies under a cavern's sinkhole. The terrain is one height per spot, so nothing
// with a room over a room can be cut into it. A deep is its own closed shell of geometry far
// below the ground, with its own floors and ceilings to walk by, joined to the surface through
// a single hole in the floor of the sinkhole's antechamber.
//
// This file is the contract between the three parts: the deep itself (index.ts and the kinds),
// the world that places and owns one (discoveries.ts, player.ts, main.ts), and the sound.

import type * as THREE from 'three';

/** The five kinds, in the order sites are dealt them. */
export const DEEP_VAULT = 0; // an enormous pit of layered rock, colonnades and a temple door in the far wall
export const DEEP_HALL = 1; // a flooded domed hall: quay, stairs, a bridge, light from a hole in the roof
export const DEEP_STREET = 2; // a slot-canyon avenue of carved facades under a great mask
export const DEEP_WARREN = 3; // lived-in rooms and alcoves on winding stairs, lamps still lit
export const DEEP_LABYRINTH = 4; // tight hand-cut passages on several levels
export const DEEP_KINDS = 5;
export type DeepKind = 0 | 1 | 2 | 3 | 4;

/**
 * The hole in the antechamber floor, in the deep's own frame: a rectangle centred on the
 * origin, long along u. Inside it the terrain is not drawn and not walked on; the deep's own
 * stair is. The stair runs down toward +u and must be below `lid` by the far end of the hole.
 */
export const DEEP_HOLE = { halfU: 4, halfV: 1.8 } as const;

/**
 * Where a deep goes and what it is. Its frame: the origin is the middle of the hole, at the
 * height of the antechamber floor; u runs on from the sinkhole's ramp, the way the stair goes
 * down; v is across, (−dz, dx); y is up. So world = (x + u·dx − v·dz, y + ly, z + u·dz + v·dx).
 */
export interface DeepSpec {
  x: number;
  z: number;
  /** World height of the antechamber floor: local y = 0. */
  y: number;
  /** Unit direction of +u. */
  dx: number;
  dz: number;
  kind: DeepKind;
  /** Per-site seed: the same spec always builds the same place. */
  seed: number;
  /**
   * The room there is to build in, local metres: u from 0 to `u1`, v from `v0` to `v1`
   * (v0 < 0 < v1). At least 280 m each way, at most 360. Nothing may be cut outside it.
   */
  u1: number;
  v0: number;
  v1: number;
  /**
   * The highest local y anything may be cut to outside the hole (negative, −3 or lower): the
   * ground above dips this low somewhere over the room. Everything but the stair's first
   * flight stays under it.
   */
  lid: number;
  /** What the site rolled: a relic at the centrepiece, a mineral seam, carved slabs. */
  relic: boolean;
  vein: boolean;
  carvings: boolean;
  /** 0 high, 1 low, 2 mobile: how much detail to spend. */
  tier: 0 | 1 | 2;
}

/** A built deep. All positions in and out are world space. */
export interface Deep {
  readonly spec: DeepSpec;
  /** Everything to draw, already placed in the world. Add it to the scene; `dispose` frees it. */
  readonly group: THREE.Group;

  /**
   * The floor for feet at height y over (x, z), or null where the deep has no say and the
   * terrain's own height stands.
   *
   * It has a say everywhere inside the hole, and elsewhere over its room once y is under the
   * lid. There it answers with the floor of the lowest open space that still has headroom
   * above y: the one being stood in, or the next one up when (x, z) is solid at y. A floor
   * well above y is therefore a wall, exactly as a height is for the terrain, and solid rock
   * all the way up answers +Infinity.
   */
  floorAt(x: number, z: number, y: number): number | null;

  /** The ceiling over a point inside the deep, or +Infinity where there is none (or no say). */
  ceilAt(x: number, z: number, y: number): number;

  /** Whether a point is inside the deep's air: under the lid or down the hole. */
  inside(x: number, y: number, z: number): boolean;

  /**
   * How far a sight line from `from` toward `to` gets before it meets rock, 0..1 of the way.
   * For pulling the camera in so it never sits inside a wall.
   */
  sight(from: THREE.Vector3, to: THREE.Vector3): number;

  /**
   * The lamp (or other light) that matters most at a point, as position and reach in metres,
   * written to `out` as [x, y, z, reach]. False when nothing lights it. This is what lights
   * things that move (the figure), which the baked light cannot.
   */
  glowAt(x: number, y: number, z: number, out: number[]): boolean;

  /** Depth of standing water at a point (m), 0 where it is dry. */
  waterAt(x: number, z: number, y: number): number;

  /** 0..1: how much open water is near a point, for the sound of it. */
  wetness(x: number, y: number, z: number): number;

  /** Where the relic sits, or null if the site has none. */
  readonly relic: [number, number, number] | null;
  /** The centrepiece: reaching it is reaching the site. */
  readonly centre: [number, number, number];
  /** Where the dark passage opens onto the ledge above the main space. */
  readonly ledge: [number, number, number];

  /** Hide the relic once it has been taken. */
  takeRelic(): void;

  /**
   * Per frame: `time` in seconds for the flames, `day` 0 (night) .. 1 (noon) for the light that
   * falls from above, and the camera for anything that faces it.
   */
  update(time: number, day: number, camera: THREE.Camera): void;

  dispose(): void;
}
