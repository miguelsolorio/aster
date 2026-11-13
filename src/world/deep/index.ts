// The deep: what lies under a cavern's sinkhole. See types.ts for the contract, builder.ts for
// how a kind is written, vault.ts for the first of them.

import type { Uniforms } from '../../game/contract';
import { DEEP_VAULT, type Deep, type DeepSpec } from './types';
import type { BuiltDeep } from './builder';
import { buildVault } from './vault';
import { buildHall } from './hall';
import { buildStreet } from './street';
import { buildWarren } from './warren';
import { buildLabyrinth } from './labyrinth';

export * from './types';
export { DeepBuilder, type BuiltDeep, type DeepStats, type BuilderOpts, type LampOpts, type PropOpts, type Marks } from './builder';
export { SpanGrid, OPEN, HEADROOM, type Pt, type CarveOut, type FillOut, type RunOpts } from './spans';

type Kind = (spec: DeepSpec, uniforms?: Uniforms) => BuiltDeep;

/** One builder per kind, in the order of the DEEP_* constants. */
const KINDS: Kind[] = [buildVault, buildHall, buildStreet, buildWarren, buildLabyrinth];

/**
 * Build the deep a spec describes. `uniforms` is the game's shared uniform object (palette and
 * style holders); without it the deep is drawn in fixed 35 mm colours and ignores ?style=.
 */
export function createDeep(spec: DeepSpec, uniforms?: Uniforms): Deep {
  return (KINDS[spec.kind] ?? KINDS[DEEP_VAULT])(spec, uniforms);
}
