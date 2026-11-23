// What the wanderer has been given and who they have met. One versioned key in
// localStorage; the world itself is seeded, so only the changes are stored.
//
// Testing: ?tools=board,carpet,pick,spyglass,flute,bedroll,rod,chart,rope,boots,feather grants tools for this visit without saving them,
// ?songs=waking,wind,rain,opening lends songs the same way, ?carry=water,flame,seed lends things to carry, and ?reset clears the save and the saved spawn before the game starts.

import { clearAtlas } from './atlas';
import { isFindKind, type FindKind } from './finds';
import type { Storm } from '../world/weather';
import { isSong, type Song } from './songs';
import { isCarry, isRevivable, type Carry, type Revived } from './restore';

export type Tool = 'board' | 'carpet' | 'pick' | 'spyglass' | 'flute' | 'bedroll' | 'rod' | 'chart' | 'rope' | 'boots' | 'feather';
export const TOOLS: Tool[] = ['board', 'carpet', 'pick', 'spyglass', 'flute', 'bedroll', 'rod', 'chart', 'rope', 'boots', 'feather'];

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
  /** Temples whose offering has been carried off (by site key): each gives once. */
  gathered: number[];
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
  /** The world clock: in-game days gone by while the game was being played. */
  days: number;
  /** The clock when the wanderer was last in the thick of a sandstorm (null: never). */
  stormDay: number | null;
  /** A storm that was sent for the wanderer and is not yet over. */
  sent: Storm | null;
  /** The clock when it last rained on the wanderer, or a rain was sent (null: never). */
  rainDay: number | null;
  /** A rain that was sent for the wanderer and is not yet over (or dry). */
  sentRain: Storm | null;
  /** Wrecks a storm uncovered and the wanderer reached: x, z and the way each lies, three numbers apiece. */
  wrecks: number[];
  /** Fallen stars the wanderer has reached or a shower brought down: x, z, two numbers apiece. */
  fallen: number[];
  /** Songs learned from places (the call comes with the flute and is not stored). */
  songs: Song[];
  /** The clock when the rain song last brought a rain (null: never). */
  rainSung: number | null;
  /** The constellations a star-house keeper has taught, by id ('nail' for the pole star). */
  stars: string[];
  /** The night (by number) of the last lesson: one a night. */
  lessonNight: number | null;
  /** The night a star last came down for the wanderer: one a shower. */
  fallNight: number | null;
  /** What the wanderer is carrying toward a place to bring back: one of each at most. */
  carry: Carry[];
  /** The places brought back, each once (by site key), and the clock when it was done. */
  revived: Revived[];
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

/** Forget the save, the spawn and the map. Settings (volume, graphics, style) are left alone. */
export function clearProgress(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable; nothing to clear */
  }
  clearSpawn();
  clearAtlas();
}

const fresh = (): SaveData => ({
  v: 1,
  tools: { board: false, carpet: false, pick: false, spyglass: false, flute: false, bedroll: false, rod: false, chart: false, rope: false, boots: false, feather: false },
  talked: false,
  items: { lamp: false, relic: false },
  roles: { miner: 0, weaver: 0 },
  opened: [],
  taken: [],
  woken: [],
  gathered: [],
  introSeen: false,
  found: [],
  deeds: { rode: false, dug: false },
  sighted: [],
  sightedAt: [],
  camp: null,
  days: 0,
  stormDay: null,
  sent: null,
  rainDay: null,
  sentRain: null,
  wrecks: [],
  fallen: [],
  songs: [],
  rainSung: null,
  stars: [],
  lessonNight: null,
  fallNight: null,
  carry: [],
  revived: [],
});

const keys = (v: unknown): number[] => (Array.isArray(v) ? v.filter((k): k is number => typeof k === 'number' && Number.isFinite(k)).slice(0, 4096) : []);

const readCamp = (v: unknown): Camp | null => {
  if (!v || typeof v !== 'object') return null;
  const { x, z, facing } = v as Partial<Camp>;
  if (typeof x !== 'number' || typeof z !== 'number' || typeof facing !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(facing)) return null;
  return { x, z, facing };
};

const STORM_FIELDS = ['id', 'x0', 'z0', 'hx', 'hz', 't0', 't1', 'width', 'depth', 'speed'] as const;
const readStorm = (v: unknown): Storm | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  for (const k of STORM_FIELDS) if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) return null;
  const s = o as unknown as Storm;
  return { kind: o.kind === 'rain' ? 'rain' : 'sand', id: s.id, x0: s.x0, z0: s.z0, hx: s.hx, hz: s.hz, t0: s.t0, t1: s.t1, width: s.width, depth: s.depth, speed: s.speed };
};
const WRECK_CAP = 64;
const FALLEN_CAP = 64;
const REVIVED_CAP = 1024;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** The places brought back, as far as they can be trusted: well formed, and each key once. */
const readRevived = (v: unknown): Revived[] => {
  if (!Array.isArray(v)) return [];
  const out: Revived[] = [];
  for (const r of v as unknown[]) {
    if (!r || typeof r !== 'object') continue;
    const { key, kind, x, z, day } = r as Partial<Revived>;
    if (!num(key) || !isRevivable(kind) || !num(x) || !num(z) || !num(day)) continue;
    if (out.some((o) => o.key === key)) continue;
    out.push({ key, kind, x, z, day });
    if (out.length >= REVIVED_CAP) break;
  }
  return out;
};
const CLOCK_EVERY = 10_000; // ms between writes of a clock that moves every frame

export class Save {
  readonly data: SaveData;
  /** Tools granted by the URL for this visit only. */
  private readonly lent = new Set<Tool>();
  /** Songs lent by the URL for this visit only. */
  private readonly lentSongs = new Set<Song>();
  /** Things to carry lent by the URL for this visit only. */
  private readonly lentCarry = new Set<Carry>();

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
        this.data.gathered = keys(raw.gathered);
        // A save from before the intro existed belongs to someone who has already played.
        this.data.introSeen = raw.introSeen === undefined ? true : raw.introSeen === true;
        if (Array.isArray(raw.found)) this.data.found = [...new Set((raw.found as unknown[]).filter(isFindKind))];
        for (const d of DEEDS) this.data.deeds[d] = raw.deeds?.[d] === true;
        this.data.sighted = keys(raw.sighted).slice(-SIGHTED_CAP);
        this.data.sightedAt = keys(raw.sightedAt).slice(-SIGHTED_CAP * 2);
        // a mark with no place to stand it is no mark
        if (this.data.sightedAt.length !== this.data.sighted.length * 2) this.data.sighted = this.data.sightedAt = [];
        this.data.camp = readCamp(raw.camp);
        this.data.days = typeof raw.days === 'number' && Number.isFinite(raw.days) && raw.days > 0 ? raw.days : 0;
        this.data.stormDay = typeof raw.stormDay === 'number' && Number.isFinite(raw.stormDay) ? raw.stormDay : null;
        this.data.sent = readStorm(raw.sent);
        this.data.rainDay = typeof raw.rainDay === 'number' && Number.isFinite(raw.rainDay) ? raw.rainDay : null;
        this.data.sentRain = readStorm(raw.sentRain);
        const wr = keys(raw.wrecks);
        this.data.wrecks = wr.slice(0, Math.floor(Math.min(wr.length, WRECK_CAP * 3) / 3) * 3);
        const fl = keys(raw.fallen);
        this.data.fallen = fl.slice(0, Math.floor(Math.min(fl.length, FALLEN_CAP * 2) / 2) * 2);
        if (Array.isArray(raw.songs)) this.data.songs = [...new Set((raw.songs as unknown[]).filter(isSong))].filter((s) => s !== 'call');
        this.data.rainSung = typeof raw.rainSung === 'number' && Number.isFinite(raw.rainSung) ? raw.rainSung : null;
        if (Array.isArray(raw.stars)) this.data.stars = [...new Set((raw.stars as unknown[]).filter((s): s is string => typeof s === 'string'))].slice(0, 32);
        this.data.lessonNight = typeof raw.lessonNight === 'number' && Number.isFinite(raw.lessonNight) ? raw.lessonNight : null;
        this.data.fallNight = typeof raw.fallNight === 'number' && Number.isFinite(raw.fallNight) ? raw.fallNight : null;
        if (Array.isArray(raw.carry)) this.data.carry = [...new Set((raw.carry as unknown[]).filter(isCarry))];
        this.data.revived = readRevived(raw.revived);
      }
    } catch {
      /* unreadable save: start again */
    }
    for (const t of (qs.get('tools') ?? '').split(',')) {
      if ((TOOLS as string[]).includes(t)) this.lent.add(t as Tool);
    }
    for (const s of (qs.get('songs') ?? '').split(',')) {
      if (isSong(s) && s !== 'call') this.lentSongs.add(s);
    }
    for (const c of (qs.get('carry') ?? '').split(',')) {
      if (isCarry(c)) this.lentCarry.add(c);
    }
  }

  /** Whether a thing is being carried (one lent by the URL counts). */
  carries(c: Carry): boolean {
    return this.data.carry.includes(c) || this.lentCarry.has(c);
  }

  /** Pick a thing up, or hand it on (a lent one is handed on too, and not lent again this visit). */
  setCarry(c: Carry, held: boolean): void {
    if (!held) this.lentCarry.delete(c);
    if (this.data.carry.includes(c) === held) return;
    if (held) this.data.carry.push(c);
    else this.data.carry = this.data.carry.filter((k) => k !== c);
    this.write();
  }

  /** A place has been brought back: it stays so. Once for each place. */
  revive(r: Revived): void {
    if (this.data.revived.some((o) => o.key === r.key)) return;
    this.data.revived.push({ key: r.key, kind: r.kind, x: r.x, z: r.z, day: r.day });
    this.write();
  }

  /** Whether a song is known: the call with the flute (lent or owned), the rest once learned (or lent). */
  knows(s: Song): boolean {
    if (s === 'call') return this.has('flute');
    return this.data.songs.includes(s) || this.lentSongs.has(s);
  }

  /** A place has answered and its song is known for good. */
  learn(s: Song): void {
    if (s === 'call' || this.data.songs.includes(s)) return;
    this.data.songs.push(s);
    this.write();
  }

  /** A keeper has taught a constellation, on this night. */
  learnStar(id: string, night: number): void {
    if (!this.data.stars.includes(id)) this.data.stars.push(id);
    this.data.lessonNight = night;
    this.write();
  }

  /** A star has come down for the wanderer on this night. */
  setFallNight(night: number | null): void {
    this.data.fallNight = night;
    this.write();
  }

  /** The rain song has brought a rain at this clock. */
  setRainSung(day: number | null): void {
    this.data.rainSung = day;
    this.write();
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

  /** A temple's offering has been carried off: nothing more is left there. */
  gather(key: number): void {
    if (this.data.gathered.includes(key)) return;
    this.data.gathered.push(key);
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

  /** The world clock has moved on. It moves every frame, so it is written only now and then (and by flush). */
  setDays(days: number): void {
    this.data.days = days;
    const now = Date.now();
    if (now - this.clockWritten < CLOCK_EVERY) return;
    this.clockWritten = now;
    this.write();
  }
  private clockWritten = Date.now();

  /** Write what is held now: the page is going away. */
  flush(): void {
    this.cancelIdle();
    this.writeNow();
  }

  /**
   * Hold writes back and make them in one go when the browser is idle (or after a moment), however many
   * changes came in meanwhile. Off by default (and in tests): every change is written at once.
   */
  deferWrites(on = true): void {
    this.deferred = on;
  }
  /** Progress was cleared on purpose: nothing held may be written back. */
  discard(): void {
    this.cancelIdle();
    this.dead = true;
  }
  private dead = false;
  private deferred = false;
  private idleHandle = 0;
  private idleIsCallback = false;

  private cancelIdle(): void {
    if (!this.idleHandle) return;
    if (this.idleIsCallback) (window as unknown as { cancelIdleCallback: (h: number) => void }).cancelIdleCallback(this.idleHandle);
    else clearTimeout(this.idleHandle);
    this.idleHandle = 0;
  }

  /** The wanderer is in the thick of a storm at this clock. */
  setStormDay(day: number): void {
    this.data.stormDay = day;
    this.write();
  }

  /** A storm has been sent for the wanderer, or the one that was is over (null). */
  setSent(s: Storm | null): void {
    this.data.sent = s;
    this.write();
  }

  /** It has rained on the wanderer at this clock, or a rain was sent. */
  setRainDay(day: number): void {
    this.data.rainDay = day;
    this.write();
  }

  /** A rain has been sent for the wanderer, or the one that was is over (null). */
  setSentRain(s: Storm | null): void {
    this.data.sentRain = s;
    this.write();
  }

  /** A wreck has been reached: it stays where it lies. */
  keepWreck(x: number, z: number, rot: number): void {
    const w = this.data.wrecks;
    for (let i = 0; i < w.length; i += 3) if (Math.hypot(w[i] - x, w[i + 1] - z) < 1) return;
    w.push(x, z, rot);
    if (w.length > WRECK_CAP * 3) w.splice(0, w.length - WRECK_CAP * 3);
    this.write();
  }

  /** A star has come down at (x, z): it stays where it lies. */
  keepFallen(x: number, z: number): void {
    const f = this.data.fallen;
    for (let i = 0; i < f.length; i += 2) if (Math.hypot(f[i] - x, f[i + 1] - z) < 1) return;
    f.push(x, z);
    if (f.length > FALLEN_CAP * 2) f.splice(0, f.length - FALLEN_CAP * 2);
    this.write();
  }

  private write(): void {
    if (!this.deferred) {
      this.writeNow();
      return;
    }
    if (this.idleHandle) return;
    const run = () => {
      this.idleHandle = 0;
      this.writeNow();
    };
    const w = typeof window !== 'undefined' ? (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }) : null;
    if (w?.requestIdleCallback) {
      this.idleIsCallback = true;
      this.idleHandle = w.requestIdleCallback(run, { timeout: 3000 });
    } else {
      this.idleIsCallback = false;
      this.idleHandle = window.setTimeout(run, 400);
    }
  }

  private writeNow(): void {
    if (this.dead) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable; the visit still works */
    }
  }
}
