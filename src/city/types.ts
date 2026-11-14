// Shared contract for cities. Units are metres. +y is up.
//
// A city has a SITE (where it is and how the terrain is flattened for it) and a
// PLAN (streets, buildings, the places people use). Everything in a plan is in
// CITY-LOCAL coordinates: origin at the city centre, y = 0 at the plateau, and
// rotated by plan.rot about y relative to the world:
//
//   localX =  cos(rot) * (worldX - cx) + sin(rot) * (worldZ - cz)
//   localZ = -sin(rot) * (worldX - cx) + cos(rot) * (worldZ - cz)
//
// A THREE.Group at position (cx, groundY, cz) with rotation.y = -rot maps local to world
// (the integrator does this; builders only ever work in local space).
// Buildings have axis-aligned lots in local space with edges on the 1 m grid; the roof-height grid
// (used for collisions and shadows) stores the lots. Most are drawn rounder and smaller than their lot
// (Building.shape), never larger than it by more than a hand's breadth.

export type CityKind =
  | 'hill' // walled town on a raised mound, gates on the avenues
  | 'canyon' // cut into rock, hemmed in by cliffs
  | 'oasis' // around a pool in a shallow basin, with gardens
  | 'trade'; // flat, open trading city on a salt pan

export interface CitySite {
  /** Stable id (hash of the grid cell). */
  id: number;
  seed: number;
  cx: number;
  cz: number;
  /** Radius of the built area, 320..600 m. */
  radius: number;
  /** Height of the plateau the city stands on. */
  groundY: number;
  kind: CityKind;
  /** Rotation of the city's local frame about y, radians. */
  rot: number;
  /** Shape of the plateau edge and its blend into the desert (see cityBlend in cityGlsl.ts). */
  phase1: number;
  phase2: number;
  falloff: number;
  /**
   * Where the avenues leave town, packed for the terrain shader (uCityC.zw; see cityAveLat in
   * cityGlsl.ts): aveA = 64 * step index + 8 * count + base bearing, aveB = 4-bit offsets.
   */
  aveA: number;
  aveB: number;
}

export type RoofKind = 'flat' | 'parapet' | 'dome' | 'terrace' | 'windtower' | 'spire' | 'canopy' | 'none';
/** How a solid building is drawn inside its lot (see shape.ts). Absent means 'box'. */
export type BuildingShape = 'box' | 'slump' | 'dome' | 'mound' | 'tower' | 'tiered';
export type BuildingRole = 'house' | 'hall' | 'market' | 'landmark' | 'wall' | 'gate' | 'stall' | 'garden';

export interface Building {
  /** Centre in local metres. x - w/2, x + w/2, z - d/2 and z + d/2 are all whole numbers. */
  x: number;
  z: number;
  /** Footprint along local x and z, whole metres. */
  w: number;
  d: number;
  /** Height of the walkable roof above the plateau. This is what the height grid stores. */
  h: number;
  roof: RoofKind;
  role: BuildingRole;
  /** 0..1 seeded variation for colour and detail. */
  tint: number;
  /** False for things you can walk through (cloth canopies, stalls, garden beds): not in the height grid. */
  solid: boolean;
  /** Extra height drawn above h that is NOT walkable (dome, spire, wind tower shaft). Used for the skyline. */
  crown: number;
  /**
   * How the building is drawn inside its lot (shape.ts); absent means a plain box. The lot rectangle
   * above stays what the height grid stores: every shape is drawn inside it (a turned one may reach
   * shape.SLACK past it), so the grid may over-block but never under-blocks.
   */
  shape?: BuildingShape;
  /** Turn of a slumped house about its centre, radians (its body's +x axis points along (cos, sin)). Default 0. */
  rot?: number;
}

export type SpotKind = 'market' | 'shade' | 'gather' | 'stall' | 'bench' | 'well' | 'gate';

/** A place where people linger. */
export interface Spot {
  x: number;
  z: number;
  kind: SpotKind;
  /** Direction a person here faces, radians (0 = +z). */
  facing: number;
  /** How many people the spot holds comfortably. */
  capacity: number;
}

export interface CityPlan {
  site: CitySite;
  buildings: Building[];
  /** Main square: an open circle at or near the centre. */
  square: { x: number; z: number; r: number };
  /** Walkable network for people: nodes on street centre lines, edges between them. */
  nodes: Array<{ x: number; z: number }>;
  edges: Array<{ a: number; b: number; width: number }>;
  spots: Spot[];
  /** Lamp positions (local, y above the plateau) lit from dusk. */
  lamps: Array<{ x: number; y: number; z: number }>;
  /** Pool for oasis towns: an open circle of water, or null. */
  pool: { x: number; z: number; r: number } | null;
  /**
   * Roof heights above the plateau on a 1 m grid, row-major, gridSize x gridSize cells.
   * Cell (i, j) covers local x in [i - gridHalf, i + 1 - gridHalf) and z in [j - gridHalf, j + 1 - gridHalf).
   * 0 means open ground. Only solid buildings are written.
   */
  grid: Float32Array;
  gridSize: number;
  gridHalf: number;
}
