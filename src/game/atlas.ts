// What the wanderer's map knows: the ground walked over or flown past, and the places come
// upon. The desert is endless, so the ground is kept as a set of square cells, and stored as
// runs along each row: a path walked is a few runs a row, however long it is. It has its own
// key in localStorage, apart from the save, because it grows with every step and is written
// on a timer, not at once.

/** The side of one cell of the map (m). */
export const ATLAS_CELL = 128;
/** Cells are numbered from the origin; this many either way can be told apart. */
const OFF = 32768;
const MAX_CELLS = 250000;
const MAX_PLACES = 2000;
const KEY = 'aster.map';

/** One number for a cell, good as a Set or Map key. */
export const cellKey = (cx: number, cz: number): number => (cx + OFF) * 65536 + (cz + OFF);
export const keyX = (key: number): number => Math.floor(key / 65536) - OFF;
export const keyZ = (key: number): number => (key % 65536) - OFF;

/** A place put on the map: a find by its kind, or a town as `city:<kind>`. `id` is unique per place. */
export interface Place {
  id: string;
  kind: string;
  x: number;
  z: number;
}

/** What someone has sent the wanderer after, that lies in one place. */
export const ERRANDS = ['rope', 'boots', 'feather'] as const;
export type Errand = (typeof ERRANDS)[number];

interface Stored {
  v: 1;
  /** For each row (z) that has anything: start, length, start, length... along x. */
  rows: Record<string, number[]>;
  places: Place[];
  // Added since the first maps were stored; one without it has no errands.
  errands?: Partial<Record<Errand, { x: number; z: number }>>;
}

const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const inRange = (c: number): boolean => c >= -OFF && c < OFF;

export class Atlas {
  readonly cells = new Set<number>();
  readonly places: Place[] = [];
  /** Where each thing the wanderer has been sent after was said to lie, until it is in hand. */
  readonly errands: Partial<Record<Errand, { x: number; z: number }>> = {};
  private readonly ids = new Set<string>();
  /** Something has changed since it was last stored. */
  dirty = false;

  has(cx: number, cz: number): boolean {
    return this.cells.has(cellKey(cx, cz));
  }

  /**
   * The ground within r of (x, z) has been seen: every cell whose centre lies in that round.
   * The keys of the cells that are new are added to `fresh`. Returns how many were new.
   */
  reveal(x: number, z: number, r: number, fresh?: number[]): number {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(r > 0)) return 0;
    let n = 0;
    const c0x = Math.floor((x - r) / ATLAS_CELL);
    const c1x = Math.floor((x + r) / ATLAS_CELL);
    const c0z = Math.floor((z - r) / ATLAS_CELL);
    const c1z = Math.floor((z + r) / ATLAS_CELL);
    for (let cz = c0z; cz <= c1z; cz++) {
      const dz = (cz + 0.5) * ATLAS_CELL - z;
      for (let cx = c0x; cx <= c1x; cx++) {
        const dx = (cx + 0.5) * ATLAS_CELL - x;
        if (dx * dx + dz * dz > r * r || !inRange(cx) || !inRange(cz)) continue;
        const key = cellKey(cx, cz);
        if (this.cells.has(key) || this.cells.size >= MAX_CELLS) continue;
        this.cells.add(key);
        fresh?.push(key);
        n++;
      }
    }
    if (n > 0) this.dirty = true;
    return n;
  }

  /** Put a place on the map. False if it was there already. */
  addPlace(p: Place): boolean {
    if (this.ids.has(p.id) || this.places.length >= MAX_PLACES) return false;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
    this.ids.add(p.id);
    this.places.push({ id: p.id, kind: p.kind, x: Math.round(p.x), z: Math.round(p.z) });
    this.dirty = true;
    return true;
  }

  /** Someone has said where a thing lies, or (null) it has been found. */
  setErrand(what: Errand, at: { x: number; z: number } | null): void {
    if (!at) {
      if (!this.errands[what]) return;
      delete this.errands[what];
    } else {
      if (!Number.isFinite(at.x) || !Number.isFinite(at.z)) return;
      this.errands[what] = { x: Math.round(at.x), z: Math.round(at.z) };
    }
    this.dirty = true;
  }

  /** The map as it is stored. */
  encode(): string {
    const byRow = new Map<number, number[]>();
    for (const key of this.cells) {
      const cz = keyZ(key);
      let row = byRow.get(cz);
      if (!row) byRow.set(cz, (row = []));
      row.push(keyX(key));
    }
    const rows: Record<string, number[]> = {};
    for (const [cz, xs] of byRow) {
      xs.sort((a, b) => a - b);
      const runs: number[] = [];
      for (let i = 0; i < xs.length; ) {
        let j = i + 1;
        while (j < xs.length && xs[j] === xs[j - 1] + 1) j++;
        runs.push(xs[i], j - i);
        i = j;
      }
      rows[cz] = runs;
    }
    const out: Stored = { v: 1, rows, places: this.places, errands: this.errands };
    return JSON.stringify(out);
  }

  /** Read a stored map back. Anything that cannot be trusted is left out. */
  static decode(text: string | null): Atlas {
    const a = new Atlas();
    try {
      const raw = JSON.parse(text ?? 'null') as Partial<Stored> | null;
      if (!raw || raw.v !== 1) return a;
      if (raw.rows && typeof raw.rows === 'object') {
        for (const [k, runs] of Object.entries(raw.rows)) {
          const cz = Number(k);
          if (!Number.isInteger(cz) || !inRange(cz) || !Array.isArray(runs)) continue;
          for (let i = 0; i + 1 < runs.length; i += 2) {
            const start = runs[i];
            const len = runs[i + 1];
            if (!whole(start) || !whole(len) || len <= 0) continue;
            for (let cx = start; cx < start + len && a.cells.size < MAX_CELLS; cx++) {
              if (inRange(cx)) a.cells.add(cellKey(cx, cz));
            }
          }
        }
      }
      if (Array.isArray(raw.places)) {
        for (const p of raw.places as Partial<Place>[]) {
          if (p && typeof p.id === 'string' && typeof p.kind === 'string' && typeof p.x === 'number' && typeof p.z === 'number') {
            a.addPlace({ id: p.id, kind: p.kind, x: p.x, z: p.z });
          }
        }
      }
      for (const e of ERRANDS) {
        const at = raw.errands?.[e];
        if (at && typeof at.x === 'number' && typeof at.z === 'number') a.setErrand(e, at);
      }
    } catch {
      /* an unreadable map is an empty one */
    }
    a.dirty = false;
    return a;
  }

  /** The map kept from earlier visits, or an empty one. */
  static load(): Atlas {
    try {
      return Atlas.decode(localStorage.getItem(KEY));
    } catch {
      return new Atlas();
    }
  }

  /** Store the map if it has changed. */
  store(): void {
    if (!this.dirty) return;
    try {
      localStorage.setItem(KEY, this.encode());
      this.dirty = false;
    } catch {
      /* storage unavailable or full: the map still works for this visit */
    }
  }
}

/** Forget the stored map. */
export function clearAtlas(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable; nothing to clear */
  }
}

/** Somewhere to look, as the map draws it: a round the thing lies in, and what it is. */
export interface Area {
  x: number;
  z: number;
  r: number;
}

/**
 * A round of radius r that has (x, z) somewhere in it, but not at its middle: the map says
 * roughly where a thing is, and leaves the finding. The same spot always gets the same round.
 */
export function areaAround(x: number, z: number, r: number): Area {
  let h = (Math.imul(Math.round(x), 0x9e3779b1) ^ Math.imul(Math.round(z), 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  const a = ((h & 0xffff) / 0x10000) * Math.PI * 2;
  const d = (0.25 + 0.4 * ((h >>> 16) / 0x10000)) * r;
  return { x: x + Math.cos(a) * d, z: z + Math.sin(a) * d, r };
}
