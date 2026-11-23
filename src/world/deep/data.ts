// A deep as plain data: built from its spec alone, by the same code on the page or on a worker
// (deepWorker.ts), and packed to cross between them with its big arrays handed over, not copied.
// Nothing here may touch the page: no materials, no textures, no meshes (see assemble.ts).

import { DEEP_VAULT, type DeepSpec } from './types';
import type { DeepData } from './builder';
import { SpanGrid } from './spans';
import { buildVault } from './vault';
import { buildHall } from './hall';
import { buildStreet } from './street';
import { buildWarren } from './warren';
import { buildLabyrinth } from './labyrinth';

/** One builder per kind, in the order of the DEEP_* constants. */
const KINDS: ((spec: DeepSpec) => DeepData)[] = [buildVault, buildHall, buildStreet, buildWarren, buildLabyrinth];

/** Everything the deep a spec describes is made of: carved, meshed and baked. The same spec always gives the same data. */
export function createDeepData(spec: DeepSpec): DeepData {
  return (KINDS[spec.kind] ?? KINDS[DEEP_VAULT])(spec);
}

/** The buffers under every typed array in a deep's data, each once: what a postMessage can hand over. */
export function deepBuffers(d: DeepData): ArrayBuffer[] {
  const g = d.grid;
  const arrays: (ArrayBufferView | null)[] = [g.n, g.f, g.c, g.su, g.sv, g.fp, g.cp, g.fl, g.mask, g.rough, g.water];
  arrays.push(d.rock.pos, d.rock.tint, d.rock.light, d.rock.index);
  if (d.water) arrays.push(d.water.pos, d.water.light);
  if (d.beams) arrays.push(d.beams.pos, d.beams.fade);
  for (const gl of [d.glows, d.relic?.glow]) if (gl) arrays.push(gl.pos, gl.corner, gl.size, gl.col, gl.phase, gl.index);
  if (d.relic) arrays.push(d.relic.pos, d.relic.tint);
  const out = new Set<ArrayBuffer>();
  for (const a of arrays) if (a) out.add(a.buffer as ArrayBuffer);
  return [...out];
}

/**
 * A deep's data as it arrives from the other side of a postMessage (structured clone keeps the
 * fields and arrays but not what class an object was): made whole again. The grid is the only
 * class instance in it; everything else is plain already.
 */
export function reviveDeepData(d: DeepData): DeepData {
  if (!(d.grid instanceof SpanGrid)) d.grid = SpanGrid.revive(d.grid);
  return d;
}
