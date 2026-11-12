// What the wanderer has been given and who they have met. One versioned key in
// localStorage; the world itself is seeded, so only the changes are stored.
//
// Testing: ?tools=board,carpet,pick grants tools for this visit without saving them,
// and ?reset clears the save before the game starts.

export type Tool = 'board' | 'carpet' | 'pick';
export const TOOLS: Tool[] = ['board', 'carpet', 'pick'];

/** Small things carried for a while, shown on the figure. */
export type Item = 'lamp' | 'relic';
export const ITEMS: Item[] = ['lamp', 'relic'];

/** People with something to ask and something to give. Each is 0 before, 1 asked (pending), 2 done. */
export type Role = 'miner';
export const ROLES: Role[] = ['miner'];

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
}

const KEY = 'aster.save';

const fresh = (): SaveData => ({
  v: 1,
  tools: { board: false, carpet: false, pick: false },
  talked: false,
  items: { lamp: false, relic: false },
  roles: { miner: 0 },
  opened: [],
  taken: [],
});

const keys = (v: unknown): number[] => (Array.isArray(v) ? v.filter((k): k is number => typeof k === 'number' && Number.isFinite(k)).slice(0, 4096) : []);

export class Save {
  readonly data: SaveData;
  /** Tools granted by the URL for this visit only. */
  private readonly lent = new Set<Tool>();

  constructor(qs: URLSearchParams) {
    if (qs.has('reset')) {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* storage unavailable; nothing to clear */
      }
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

  /** A relic has been lifted from its cavern: it does not come back. */
  take(key: number): void {
    if (this.data.taken.includes(key)) return;
    this.data.taken.push(key);
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
