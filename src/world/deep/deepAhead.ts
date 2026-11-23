// Deeps built ahead of need, off the main thread. Carving, meshing and baking a deep is a tenth
// of a second and more on a desktop (half a second on a phone), all of it in one piece, so it is
// asked for from further off than the deep is needed, and handed over ready to be made into
// meshes. One is worked on at a time, nearest first; one no longer wanted is dropped from the
// queue, or, if it is already being worked on, its answer is thrown away.
//
// Where there are no workers, or the worker fails, `take` returns null and the caller builds the
// deep itself, as before.
import type { DeepData } from './builder';
import { reviveDeepData } from './data';
import type { DeepSpec } from './types';

export interface DeepAsk {
  id: number;
  spec: DeepSpec;
}
export interface DeepAnswer {
  id: number;
  /** Null when the build failed there: it is made on the page instead. */
  data: DeepData | null;
}

/** The least of a Worker this needs (so a test can stand one in). */
export interface DeepWorker {
  onmessage: ((e: { data: DeepAnswer }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  postMessage(ask: DeepAsk): void;
  terminate(): void;
}

function startWorker(): DeepWorker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./deepWorker.ts', import.meta.url), { type: 'module' }) as unknown as DeepWorker;
  } catch {
    return null;
  }
}

/** Whether two specs build the same place. */
export function sameSpec(a: DeepSpec, b: DeepSpec): boolean {
  for (const k of Object.keys(a) as (keyof DeepSpec)[]) if (a[k] !== b[k]) return false;
  return Object.keys(a).length === Object.keys(b).length;
}

interface Job {
  key: number;
  spec: DeepSpec;
}

export class DeepAhead {
  private worker: DeepWorker | null;
  /** Asked for and not yet sent, nearest (or most urgent) first. */
  private queue: Job[] = [];
  /** The one being worked on, and the id its answer will carry. Its key is -1 once nobody wants it. */
  private flying: (Job & { id: number }) | null = null;
  private nextId = 1;
  private readonly ready = new Map<number, DeepData>();

  constructor(make: () => DeepWorker | null = startWorker) {
    this.worker = make();
    if (!this.worker) return;
    this.worker.onmessage = (e) => {
      const { id, data } = e.data;
      const job = this.flying;
      if (!job || job.id !== id) return;
      this.flying = null;
      if (data && job.key >= 0 && sameSpec(data.spec, job.spec)) this.ready.set(job.key, reviveDeepData(data));
      this.pump();
    };
    this.worker.onerror = () => this.giveUp();
  }

  /** The worker is no use: whatever was asked for is built on the page from now on. */
  private giveUp(): void {
    this.worker?.terminate();
    this.worker = null;
    this.queue = [];
    this.flying = null;
    this.ready.clear();
  }

  /** Whether deeps are being built elsewhere at all. When not, `take` always returns null. */
  get working(): boolean {
    return this.worker !== null;
  }

  private pump(): void {
    if (!this.worker || this.flying) return;
    const job = this.queue.shift();
    if (!job) return;
    this.flying = { ...job, id: this.nextId++ };
    try {
      this.worker.postMessage({ id: this.flying.id, spec: job.spec });
    } catch {
      this.giveUp();
    }
  }

  /** Whether the deep for `key` has been asked for (and is not yet taken), with this spec. */
  asked(key: number, spec: DeepSpec): boolean {
    const r = this.ready.get(key);
    if (r) return sameSpec(r.spec, spec);
    if (this.flying && this.flying.key === key) return sameSpec(this.flying.spec, spec);
    const q = this.queue.find((j) => j.key === key);
    return q ? sameSpec(q.spec, spec) : false;
  }

  /**
   * Starts on the deep for `key`, unless it is already asked for with the same spec (a different
   * one replaces it). `urgent` puts it at the head of the queue.
   */
  request(key: number, spec: DeepSpec, urgent = false): void {
    if (!this.worker) return;
    if (this.asked(key, spec)) {
      if (urgent) {
        const i = this.queue.findIndex((j) => j.key === key);
        if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
      }
      return;
    }
    this.forget(key);
    const job = { key, spec: { ...spec } };
    if (urgent) this.queue.unshift(job);
    else this.queue.push(job);
    this.pump();
  }

  /** Whether the deep for `key` is ready, built from this spec. */
  has(key: number, spec: DeepSpec): boolean {
    const r = this.ready.get(key);
    return !!r && sameSpec(r.spec, spec);
  }

  /** The deep's data if it is ready and built from this spec (it is then handed over and forgotten), else null. */
  take(key: number, spec: DeepSpec): DeepData | null {
    const r = this.ready.get(key) ?? null;
    if (!r) return null;
    this.ready.delete(key);
    return sameSpec(r.spec, spec) ? r : null;
  }

  /** A deep no longer wanted: dropped from the queue, its answer ignored, or its data let go. */
  forget(key: number): void {
    this.queue = this.queue.filter((j) => j.key !== key);
    if (this.flying && this.flying.key === key) this.flying.key = -1;
    this.ready.delete(key);
  }

  /** Forget every deep but these. */
  keep(keys: ReadonlySet<number>): void {
    if (this.queue.some((j) => !keys.has(j.key))) this.queue = this.queue.filter((j) => keys.has(j.key));
    if (this.flying && !keys.has(this.flying.key)) this.flying.key = -1;
    for (const k of [...this.ready.keys()]) if (!keys.has(k)) this.ready.delete(k);
  }

  dispose(): void {
    this.giveUp();
  }
}
