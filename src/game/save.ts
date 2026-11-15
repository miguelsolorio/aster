// What the wanderer has been given and who they have met. One versioned key in
// localStorage; the world itself is seeded, so only the changes are stored.
//
// Testing: ?tools=board,carpet,pick,spyglass,flute,bedroll,rod,chart,rope grants tools for this visit without saving them,
// and ?reset clears the save and the saved spawn before the game starts.

import { isFindKind, type FindKind } from './finds';

export type Tool = 'board' | 'carpet' | 'pick' | 'spyglass' | 'flute' | 'bedroll' | 'rod' | 'chart' | 'rope';
export const TOOLS: Tool[] = ['board', 'carpet', 'pick', 'spyglass', 'flute', 'bedroll', 'rod', 'chart', 'rope'];

/** Small things carried for a while, shown on the figure. */
export type Item = 'lamp' | 'relic';
export const ITEMS: Item[] = ['lamp', 'relic'];

/** People with something to ask and something to give. Each is 0 before, 1 asked (pending), 2 done. */
export type Role = 'miner' | 'weaver';
export const ROLES: Role[] = ['miner', 'weaver'];

/** Things the wanderer has done once, that people ask about. */
export type Deed = 'rode' | 'dug';
export const DEEDS: Deed[] = ['rode', 'dug'];

const SIGHTED_CAP = 256;

/** Where the bedroll is laid, and which way the wanderer faced. */
export interface Camp {
  x: number;
  z: number;
  facing: number;
}

export interface SaveData {
  v: 1;
  tools: Record<Tool, boolean>;
  /** Someone has been spoken to, so talking is a thing the player knows about. */
  talked: boolean;
  // Added since the first v1 saves; a save without them reads as none of each.
  items: Record<Item, boolean>;
  roles: Record<Role, number>;
  /** The world is fixed by its seed, so what has changed in it is a short list: caverns opened (by site key). */
  opened: number[];
  /** Relics lifted from their caverns (by site key). */
  taken: number[];
  /** Waking stones touched in their deeps (by site key). */
  woken: number[];
  /** The first-run intro (controls and what to do) has been seen and put away. */
  introSeen: boolean;
  /** The kinds of discovery come upon so far, each once, in the order they were found. */
  found: FindKind[];
  /** Things the wanderer has done once. */
  deeds: Record<Deed, boolean>;
  /** Sites marked through the spyglass (by site key), oldest first. */
  sighted: number[];
  /** Where each of those lies: x then z, a pair for every key, in the same order. */
  sightedAt: number[];
  /** Where the bedroll is laid, if it is. */
  camp: Camp | null;
}

const KEY = 'aster.save';
const KEY_SPAWN = 'aster.spawn';

/** A place the wanderer chose to arrive at: where, and which way to face. Height is read from the terrain on load. */
export interface Spawn {
  x: number;
  z: number;
  facing: number;
}

/** The saved spawn, or null if there is none or it cannot be trusted. */
export function loadSpawn(): Spawn | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_SPAWN) ?? 'null') as Partial<Spawn> | null;
    if (!raw || typeof raw !== 'object') return null;
    const { x, z, facing } = raw;
    if (typeof x !== 'number' || typeof z !== 'number' || typeof facing !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(facing)) return null;
    return { x, z, facing };
  } catch {
    return null;
  }
}

/** Remember a spawn. Returns false if it could not be stored. */
export function saveSpawn(s: Spawn): boolean {
  try {
    localStorage.setItem(KEY_SPAWN, JSON.stringify({ x: s.x, z: s.z, facing: s.facing }));
    return true;
  } catch {
    return false;
  }
}

export function clearSpawn(): void {
  try {
    localStorage.removeItem(KEY_SPAWN);
  } catch {
    /* storage unavailable; nothing to clear */
  }
}

/** Forget the save and the spawn. Settings (volume, graphics, style) are left alone. */
export function clearProgress(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable; nothing to clear */
  }
  clearSpawn();
}

const fresh = (): SaveData => ({
  v: 1,
  tools: { board: false, carpet: false, pick: false, spyglass: false, flute: false, bedroll: false, rod: false, chart: false, rope: false },
  talked: false,
  items: { lamp: false, relic: false },
  roles: { miner: 0, weaver: 0 },
  opened: [],
  taken: [],
  woken: [],
  introSeen: false,
  found: [],
  deeds: { rode: false, dug: false },
  sighted: [],
  sightedAt: [],
  camp: null,
});

const keys = (v: unknown): number[] => (Array.isArray(v) ? v.filter((k): k is number => typeof k === 'number' && Number.isFinite(k)).slice(0, 4096) : []);

const readCamp = (v: unknown): Camp | null => {
  if (!v || typeof v !== 'object') return null;
  const { x, z, facing } = v as Partial<Camp>;
  if (typeof x !== 'number' || typeof z !== 'number' || typeof facing !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(facing)) return null;
  return { x, z, facing };
};

export class Save {
  readonly data: SaveData;
  /** Tools granted by the URL for this visit only. */
  private readonly lent = new Set<Tool>();

  constructor(qs: URLSearchParams) {
    if (qs.has('reset')) {
      clearProgress();
    }
    this.data = fresh();
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<SaveData> | null;
      if (raw && raw.v === 1) {
        for (const t of TOOLS) this.data.tools[t] = raw.tools?.[t] === true;
        this.data.talked = raw.talked === true;
        for (const i of ITEMS) this.data.items[i] = raw.items?.[i] === true;
        for (const r of ROLES) {
          const st = raw.roles?.[r];
          this.data.roles[r] = st === 1 || st === 2 ? st : 0;
        }
        this.data.opened = keys(raw.opened);
        this.data.taken = keys(raw.taken);
        this.data.woken = keys(raw.woken);
        // A save from before the intro existed belongs to someone who has already played.
        this.data.introSeen = raw.introSeen === undefined ? true : raw.introSeen === true;
        if (Array.isArray(raw.found)) this.data.found = [...new Set((raw.found as unknown[]).filter(isFindKind))];
        for (const d of DEEDS) this.data.deeds[d] = raw.deeds?.[d] === true;
        this.data.sighted = keys(raw.sighted).slice(-SIGHTED_CAP);
        this.data.sightedAt = keys(raw.sightedAt).slice(-SIGHTED_CAP * 2);
        // a mark with no place to stand it is no mark
        if (this.data.sightedAt.length !== this.data.sighted.length * 2) this.data.sighted = this.data.sightedAt = [];
        this.data.camp = readCamp(raw.camp);
      }
    } catch {
      /* unreadable save: start again */
    }
    for (const t of (qs.get('tools') ?? '').split(',')) {
      if ((TOOLS as string[]).includes(t)) this.lent.add(t as Tool);
    }
  }

  has(t: Tool): boolean {
    return this.data.tools[t] || this.lent.has(t);
  }

  /** How many of the tools are in hand (lent ones count). */
  toolCount(): number {
    return TOOLS.filter((t) => this.has(t)).length;
  }

  give(t: Tool): void {
    this.data.tools[t] = true;
    this.write();
  }

  setTalked(): void {
    if (this.data.talked) return;
    this.data.talked = true;
    this.write();
  }

  /** Pick an item up, or hand it on. */
  setItem(i: Item, held: boolean): void {
    if (this.data.items[i] === held) return;
    this.data.items[i] = held;
    this.write();
  }

  setRole(r: Role, state: 0 | 1 | 2): void {
    if (this.data.roles[r] === state) return;
    this.data.roles[r] = state;
    this.write();
  }

  /** A cavern has been opened: it stays open. */
  open(key: number): void {
    if (this.data.opened.includes(key)) return;
    this.data.opened.push(key);
    this.write();
  }

  /** A waking stone has been touched: it stays awake. */
  wake(key: number): void {
    if (this.data.woken.includes(key)) return;
    this.data.woken.push(key);
    this.write();
  }

  /** A relic has been lifted from its cavern: it does not come back. */
  take(key: number): void {
    if (this.data.taken.includes(key)) return;
    this.data.taken.push(key);
    this.write();
  }

  /** The intro has been put away: it is not shown again. */
  setIntroSeen(): void {
    if (this.data.introSeen) return;
    this.data.introSeen = true;
    this.write();
  }

  /** A kind of discovery has been come upon. True the first time for each kind. */
  find(kind: string): boolean {
    if (!isFindKind(kind) || this.data.found.includes(kind)) return false;
    this.data.found.push(kind);
    this.write();
    return true;
  }

  /** Something done for the first time. */
  setDeed(d: Deed): void {
    if (this.data.deeds[d]) return;
    this.data.deeds[d] = true;
    this.write();
  }

  /** A site has been marked through the spyglass. True if it was newly marked. */
  sight(key: number, x: number, z: number): boolean {
    if (this.data.sighted.includes(key)) return false;
    this.data.sighted.push(key);
    this.data.sightedAt.push(x, z);
    const over = this.data.sighted.length - SIGHTED_CAP;
    if (over > 0) {
      this.data.sighted.splice(0, over);
      this.data.sightedAt.splice(0, over * 2);
    }
    this.write();
    return true;
  }

  unsight(key: number): void {
    const i = this.data.sighted.indexOf(key);
    if (i < 0) return;
    this.data.sighted.splice(i, 1);
    this.data.sightedAt.splice(i * 2, 2);
    this.write();
  }

  /** Lay the bedroll here, or pick it up (null). */
  setCamp(c: Camp | null): void {
    this.data.camp = c ? { x: c.x, z: c.z, facing: c.facing } : null;
    this.write();
  }

  private write(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable; the visit still works */
    }
  }
}
