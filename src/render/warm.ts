import * as THREE from 'three';

// Shader warm-up. Every material the game can draw is compiled while the title card is up, so
// the first city, find, deep or rain shower does not stall a frame linking its programs.
//
// Each system registers what it draws: its real material instances (warmMaterial), or, for
// materials it only makes later (one per city, per site), a source asked at warm-up time that
// returns sample objects made by the same factories. A program is shared by every material
// with the same shaders, defines and draw state, so a sample stands in for all its later twins,
// as long as it is drawn on the same kind of object (mesh, points, lines) and its geometry has
// a normal attribute exactly when the real one does: both are part of the program's key.
// Samples are never disposed: disposing the last material on a program deletes the program.

export type WarmKind = 'mesh' | 'points' | 'lines';

export interface WarmHow {
  /** What it is drawn as (default a mesh). */
  kind?: WarmKind;
  /** Whether the geometry it is drawn with has a normal attribute (default true for meshes). */
  normals?: boolean;
}

type Source = () => THREE.Object3D[];

const sources: Source[] = [];
const geos = new Map<string, THREE.BufferGeometry>();

function tinyGeometry(normals: boolean): THREE.BufferGeometry {
  const key = normals ? 'n' : '-';
  let g = geos.get(key);
  if (!g) {
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    if (normals) g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    geos.set(key, g);
  }
  return g;
}

/** A throwaway object drawing `material` as the game would. */
export function warmObject(material: THREE.Material, how: WarmHow = {}): THREE.Object3D {
  const kind = how.kind ?? 'mesh';
  const g = tinyGeometry(how.normals ?? kind === 'mesh');
  const o = kind === 'points' ? new THREE.Points(g, material) : kind === 'lines' ? new THREE.LineSegments(g, material) : new THREE.Mesh(g, material);
  o.frustumCulled = false;
  return o;
}

/** Registers materials that exist now, drawn as `how` says. */
export function warmMaterial(materials: THREE.Material | readonly THREE.Material[], how: WarmHow = {}): void {
  const list = Array.isArray(materials) ? [...materials] : [materials as THREE.Material];
  sources.push(() => list.map((m) => warmObject(m, how)));
}

/** Registers the drawables of real objects (their own geometry and material), e.g. a system's group. */
export function warmObjects(...objects: THREE.Object3D[]): void {
  sources.push(() => {
    const out: THREE.Object3D[] = [];
    for (const root of objects)
      root.traverse((o) => {
        const d = o as THREE.Mesh;
        if (!(d.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) || !d.material) return;
        // a stand-in of the same type over the same geometry (the real object stays where it is)
        const c = (o as THREE.Points).isPoints ? new THREE.Points(d.geometry, d.material) : (o as THREE.LineSegments).isLineSegments ? new THREE.LineSegments(d.geometry, d.material) : new THREE.Mesh(d.geometry, d.material);
        out.push(c);
      });
    return out;
  });
}

/** Registers a source asked at warm-up time: for materials made later, return samples from the same factories. */
export function warmSource(source: Source): void {
  sources.push(source);
}

export interface WarmReport {
  /** Programs before and after the warm-up. */
  before: number;
  after: number;
  /** How many objects were warmed. */
  objects: number;
  ms: number;
  timedOut: boolean;
}

let warmed: Promise<WarmReport> | null = null;

/**
 * Compiles every registered material against the real scene (its lights, fog) and the render
 * target the scene is drawn into (its colour space), off the frame where the driver allows it
 * (KHR_parallel_shader_compile). Resolves when all are linked, or after `timeoutMs` regardless.
 */
export function warmUp(renderer: THREE.WebGLRenderer, camera: THREE.Camera, target: THREE.Scene, rt: THREE.WebGLRenderTarget | null, timeoutMs = 8000): Promise<WarmReport> {
  if (warmed) return warmed;
  const t0 = performance.now();
  const before = renderer.info.programs?.length ?? 0;
  const scene = new THREE.Scene();
  for (const s of sources) {
    try {
      for (const o of s()) scene.add(o);
    } catch (e) {
      console.warn('[warm] a source failed', e);
    }
  }
  const objects = scene.children.length;
  const prev = renderer.getRenderTarget();
  let compiled: Promise<unknown>;
  renderer.setRenderTarget(rt);
  try {
    compiled = renderer.compileAsync(scene, camera, target);
  } catch (e) {
    console.warn('[warm] compile failed', e);
    compiled = Promise.resolve();
  } finally {
    renderer.setRenderTarget(prev);
  }
  let timer = 0;
  const late = new Promise<boolean>((res) => (timer = window.setTimeout(() => res(true), timeoutMs)));
  warmed = Promise.race([compiled.then(() => false), late]).then((timedOut) => {
    window.clearTimeout(timer);
    // Without the parallel-compile extension a program reads as ready at once and links on first
    // use: finish that here, while nothing is moving, rather than in the first frame that draws it.
    if (!timedOut) {
      for (const p of renderer.info.programs ?? []) {
        p.getUniforms();
        p.getAttributes();
      }
    }
    scene.clear();
    return { before, after: renderer.info.programs?.length ?? 0, objects, ms: Math.round(performance.now() - t0), timedOut };
  });
  return warmed;
}

/**
 * Dev aid: once the warm-up is done, logs each program linked later, with what drew it, so a
 * missing or mismatched registration shows up as "[warm] late program ...". Call per frame.
 */
export function lateProgramWatch(renderer: THREE.WebGLRenderer, scene: THREE.Scene): () => void {
  let seen = -1;
  return () => {
    const list = renderer.info.programs;
    if (!list) return;
    if (seen < 0) {
      seen = list.length;
      return;
    }
    if (list.length <= seen) {
      seen = list.length;
      return;
    }
    const fresh = new Set(list.slice(seen));
    seen = list.length;
    const found = new Set<unknown>();
    scene.traverse((o) => {
      const d = o as THREE.Mesh;
      if (!d.material) return;
      for (const m of Array.isArray(d.material) ? d.material : [d.material]) {
        const p = (renderer.properties.get(m) as { currentProgram?: unknown }).currentProgram;
        if (!p || !fresh.has(p as never) || found.has(p)) continue;
        found.add(p);
        const sm = m as THREE.ShaderMaterial;
        const head = (sm.vertexShader ?? '').replace(/\s+/g, ' ').slice(0, 70);
        console.info(`[warm] late program: ${o.type} "${o.name}" normals=${!!d.geometry?.attributes.normal} ${m.type} defines=${JSON.stringify(sm.defines ?? {})} side=${m.side} | ${head}`);
      }
    });
    for (const p of fresh) if (!found.has(p)) console.info(`[warm] late program not in the scene: ${p.name} ${String(p.cacheKey).slice(0, 120)}`);
  };
}
