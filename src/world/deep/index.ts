// The deep: what lies under a cavern's sinkhole. See types.ts for the contract, builder.ts for
// how a kind is written, vault.ts for the first of them.
//
// Building one is two parts: createDeepData (data.ts) carves, meshes and bakes it into plain
// arrays, which is nearly all the work and can be done on a worker (deepAhead.ts); and
// assembleDeep (assemble.ts) wraps those into meshes on the main thread, which is quick.

import type { Uniforms } from '../../game/contract';
import type { Deep, DeepSpec } from './types';
import { assembleDeep } from './assemble';
import { createDeepData } from './data';

export * from './types';
export { DeepBuilder, type BuiltDeep, type DeepData, type DeepStats, type BuilderOpts, type LampOpts, type PropOpts, type Marks } from './builder';
export { SpanGrid, OPEN, HEADROOM, type Pt, type CarveOut, type FillOut, type RunOpts } from './spans';
export { assembleDeep } from './assemble';
export { createDeepData } from './data';

/**
 * Build the deep a spec describes, all at once, here. `uniforms` is the game's shared uniform
 * object (palette and style holders); without it the deep is drawn in fixed 35 mm colours and
 * ignores ?style=.
 */
export function createDeep(spec: DeepSpec, uniforms?: Uniforms): Deep {
  return assembleDeep(createDeepData(spec), uniforms);
}
