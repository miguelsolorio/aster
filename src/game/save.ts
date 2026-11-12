// What the wanderer has been given and who they have met. One versioned key in
// localStorage; the world itself is seeded, so only the changes are stored.
//
// Testing: ?tools=board,carpet,pick grants tools for this visit without saving them,
// and ?reset clears the save before the game starts.

export type Tool = 'board' | 'carpet' | 'pick';
export const TOOLS: Tool[] = ['board', 'carpet', 'pick'];

export interface SaveData {
  v: 1;
  tools: Record<Tool, boolean>;
  /** Someone has been spoken to, so talking is a thing the player knows about. */
  talked: boolean;
}

const KEY = 'aster.save';

const fresh = (): SaveData => ({ v: 1, tools: { board: false, carpet: false, pick: false }, talked: false });

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

  private write(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable; the visit still works */
    }
  }
}
