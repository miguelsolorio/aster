// The kinds of thing the desert hides, as Discoveries names them when one is first come near
// (onReach). The world goes on for ever, so what can be counted is the kinds found, not the
// sites: the tracker reads "Discoveries 3 / 15". The lamp is left out: it is picked up, never
// come near, so it is never reached.

export const FIND_KINDS = [
  'temple',
  'hamlet',
  'ruins',
  'oasis',
  'grove',
  'arch',
  'balancing-stones',
  'standing-stones',
  'bones',
  'lantern',
  'sundial',
  'shell',
  'cavern',
  'cave',
  'spring',
  'summit',
] as const;

export type FindKind = (typeof FIND_KINDS)[number];

const NAMES: Record<FindKind, string> = {
  temple: 'Temple',
  hamlet: 'Hamlet',
  ruins: 'Ruins',
  oasis: 'Oasis',
  grove: 'Grove',
  arch: 'Stone arch',
  'balancing-stones': 'Balancing stones',
  'standing-stones': 'Standing stones',
  bones: 'Great bones',
  lantern: 'Lantern tower',
  sundial: 'Sundial',
  shell: 'Buried shell',
  cavern: 'Cavern',
  cave: 'Mountain cave',
  spring: 'Spring',
  summit: 'Summit',
};

export function isFindKind(k: unknown): k is FindKind {
  return typeof k === 'string' && (FIND_KINDS as readonly string[]).includes(k);
}

/** What a kind is called where the player reads it. */
export function findName(k: FindKind): string {
  return NAMES[k];
}

/** The tracker's line, and the same said in words for a screen reader. */
export function findsText(found: number, total: number = FIND_KINDS.length): { text: string; label: string } {
  const n = Math.max(0, Math.min(total, Math.floor(found)));
  return { text: `Discoveries ${n} / ${total}`, label: `Discoveries found: ${n} of ${total}` };
}
