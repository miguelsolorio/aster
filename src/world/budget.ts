// One time budget a frame for building world content: the finds, the city rooms, the props.
// main.ts opens it at the top of each frame with a few milliseconds (fewer on a phone); every
// builder that can wait draws on it and leaves the rest for the next frame. Heavy builders are
// written as jobs (generators that yield between small pieces of work), so no single step is long.
// What the wanderer could walk into before the job is done is not left to the budget: its owner
// finishes it at once (see `finish`).

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A piece of work that can be stopped between steps: each `next()` does one small step. */
export type Job<T = unknown> = Iterator<unknown, T>;

export class FrameBudget {
  // Until a frame opens it (headless, tests) the budget is unlimited, so work runs straight through.
  private left = Infinity;
  private spentMs = 0;

  constructor(private readonly now: () => number = clock) {}

  /** Opens a frame with `ms` milliseconds to spend. */
  begin(ms: number): void {
    this.left = ms;
    this.spentMs = 0;
  }

  /** Milliseconds still to spend this frame (0 once spent). */
  get remaining(): number {
    return Math.max(0, this.left);
  }

  /** Whether any of this frame's budget is left. */
  get open(): boolean {
    return this.left > 0;
  }

  /**
   * Whether a frame has opened the budget (false headless and in tests, where it is unlimited):
   * work that is only ever done ahead of need, and could as well not be done, waits for this.
   */
  get framed(): boolean {
    return this.left !== Infinity;
  }

  /** Milliseconds spent since the frame opened. */
  get spent(): number {
    return this.spentMs;
  }

  /** Takes `ms` off what is left, for work the caller timed itself. */
  spend(ms: number): void {
    this.left -= ms;
    this.spentMs += ms;
  }

  /** The current time, from the clock this budget measures with. */
  time(): number {
    return this.now();
  }

  /**
   * Steps `job` while the budget lasts. Returns true once the job has finished (now or before
   * this call), false if it is still under way. Takes no step at all when nothing is left.
   */
  run(job: Job): boolean {
    if (this.left <= 0) return false;
    const t0 = this.now();
    let done = false;
    for (;;) {
      if (job.next().done) {
        done = true;
        break;
      }
      if (this.now() - t0 >= this.left) break;
    }
    this.spend(this.now() - t0);
    return done;
  }
}

/** A job whose answer is wanted: run it a little each frame until `done`, then read `value`. */
export class Task<T> {
  done = false;
  value: T | undefined;
  private readonly it: Job<void>;

  constructor(job: Job<T>) {
    const self = this;
    this.it = (function* (): Generator<void, void> {
      for (;;) {
        const r = job.next();
        if (r.done) {
          self.value = r.value;
          return;
        }
        yield;
      }
    })();
  }

  /** Steps the job on `budget`; returns whether it has finished. */
  run(budget: FrameBudget = frameBudget): boolean {
    if (!this.done && budget.run(this.it)) this.done = true;
    return this.done;
  }

  /** Runs the job to its end now, whatever the budget (for what must exist this frame); returns its answer. */
  finish(): T {
    if (!this.done) {
      finish(this.it);
      this.done = true;
    }
    return this.value as T;
  }
}

/** The game's one budget. */
export const frameBudget = new FrameBudget();

/** Milliseconds a frame gives to building: a little less on a phone, which has less frame to spare. */
export function budgetFor(tier: 'mobile' | 'low' | 'high'): number {
  return tier === 'mobile' ? 3 : 4;
}

/** Runs a job to its end now, whatever the budget (for what must exist this frame). Returns its result. */
export function finish<T>(job: Job<T>): T {
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}
