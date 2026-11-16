// The lived-in places out in the open desert, smallest to largest. Each stands on ground that
// suits it (see settle.ts for where, settlements.ts for what is built there).

export const SETTLEMENT_KINDS = [
  'well-camp', // black tents round one well, on open sand
  'star-house', // an observatory on a lone hilltop
  'salt-works', // pools and stacked salt, out on a pan
  'glass-kilns', // three kilns that glow from dusk, among pale dunes
  'ledge', // houses stacked against a rock face
  'bridge', // houses along a bridge over a river
  'caravanserai', // one walled house, half way along a route
  'dyers-town', // cloth lines and dye vats, on a slope above a river
  'wind-towers', // a town on a flat plain, its water brought in underground
  'stepped-city', // five tiers up to a gold dome
] as const;

export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

export function isSettlement(k: unknown): k is SettlementKind {
  return typeof k === 'string' && (SETTLEMENT_KINDS as readonly string[]).includes(k);
}
