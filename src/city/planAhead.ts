// Plans of cities worked out ahead of need, off the main thread. Planning a city is the longest
// single piece of work the game does (a tenth of a second and more), and a city comes into range
// kilometres before it can be made out, so its plan is asked for early and is ready by the time
// the skyline is wanted. Where there are no workers, or one fails, `take` returns null and the
// caller plans the city itself, as before.
import type { CityData } from './build';
import type { CityPlan, CitySite } from './types';

/** What the worker works out beyond the plan: the city's geometry, and its map's buildings' shade. */
export interface CityPrep {
  data: CityData;
  /** The contact shade of the buildings alone (see contactBase), and the city map packed from it. */
  shade: Float32Array;
  roof: Uint8Array;
}

/** The least of a Worker this needs (so a test can stand one in). */
export interface PlanWorker {
  onmessage: ((e: { data: { id: number; plan: CityPlan; prep?: CityPrep } }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  postMessage(site: CitySite): void;
  terminate(): void;
}

function startWorker(): PlanWorker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./planWorker.ts', import.meta.url), { type: 'module' }) as unknown as PlanWorker;
  } catch {
    return null;
  }
}

export class PlanAhead {
  private worker: PlanWorker | null;
  /** By site id: the site while its plan is being worked out, then the plan. */
  private readonly asked = new Map<number, CitySite>();
  private readonly ready = new Map<number, CityPlan>();
  private readonly preps = new Map<number, CityPrep>();

  constructor(make: () => PlanWorker | null = startWorker) {
    this.worker = make();
    if (!this.worker) return;
    this.worker.onmessage = (e) => {
      const { id, plan, prep } = e.data;
      const site = this.asked.get(id);
      if (!site) return; // no longer wanted
      this.asked.delete(id);
      plan.site = site; // the copy that came back is equal, but the game knows a site by the object
      this.ready.set(id, plan);
      if (prep) this.preps.set(id, prep);
    };
    this.worker.onerror = () => this.giveUp();
  }

  /** The worker is no use: whatever was asked for is planned on the page from now on. */
  private giveUp(): void {
    this.worker?.terminate();
    this.worker = null;
    this.asked.clear();
  }

  /** Whether plans are being worked out elsewhere at all. When not, `take` always returns null. */
  get working(): boolean {
    return this.worker !== null;
  }

  /** Starts on a site's plan, unless it is already asked for or done. */
  request(site: CitySite): void {
    if (!this.worker || this.asked.has(site.id) || this.ready.has(site.id)) return;
    this.asked.set(site.id, site);
    try {
      this.worker.postMessage(site);
    } catch {
      this.giveUp();
    }
  }

  /** The site's plan if it is done (it is then handed over and forgotten), else null. */
  take(site: CitySite): CityPlan | null {
    const plan = this.ready.get(site.id) ?? null;
    if (plan) this.ready.delete(site.id);
    return plan;
  }

  /** What was worked out beyond the plan just taken for this site, if anything (handed over once). */
  prep(id: number): CityPrep | null {
    const p = this.preps.get(id) ?? null;
    this.preps.delete(id);
    return p;
  }

  /** A plan no longer wanted: the wanderer has turned away from its city. */
  forget(id: number): void {
    this.asked.delete(id);
    this.ready.delete(id);
    this.preps.delete(id);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.asked.clear();
    this.ready.clear();
    this.preps.clear();
  }
}
