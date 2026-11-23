import { describe, expect, it } from 'vitest';
import { PlanAhead, type PlanWorker } from '../planAhead';
import type { CityPlan, CitySite } from '../types';

const site = (id: number): CitySite => ({ id, seed: id, cx: 0, cz: 0, radius: 400, groundY: 0, kind: 'trade', rot: 0, phase1: 0, phase2: 0, falloff: 1, aveA: 0, aveB: 0 });

/** A worker that answers when told to, with a plan that carries a copy of the site (as a real one does). */
function fakeWorker() {
  const posted: CitySite[] = [];
  const w: PlanWorker & { answer(): void; fail(): void; dead: boolean } = {
    onmessage: null,
    onerror: null,
    dead: false,
    postMessage: (s) => void posted.push(s as CitySite),
    terminate: () => void (w.dead = true),
    answer: () => {
      const s = posted.shift()!;
      w.onmessage?.({ data: { id: s.id, plan: { site: { ...s } } as CityPlan } });
    },
    fail: () => w.onerror?.(new Error('no')),
  };
  return { w, posted };
}

describe('PlanAhead', () => {
  it('hands a plan over once, with the site it was asked for', () => {
    const { w, posted } = fakeWorker();
    const plans = new PlanAhead(() => w);
    const s = site(7);
    plans.request(s);
    plans.request(s); // asked once only
    expect(posted.length).toBe(1);
    expect(plans.take(s)).toBeNull();
    w.answer();
    const plan = plans.take(s);
    expect(plan?.site).toBe(s);
    expect(plans.take(s)).toBeNull();
  });

  it('drops an answer nobody is waiting for', () => {
    const { w } = fakeWorker();
    const plans = new PlanAhead(() => w);
    const s = site(3);
    plans.request(s);
    plans.forget(s.id);
    w.answer();
    expect(plans.take(s)).toBeNull();
  });

  it('stops working when there is no worker, or the worker fails', () => {
    expect(new PlanAhead(() => null).working).toBe(false);
    const { w } = fakeWorker();
    const plans = new PlanAhead(() => w);
    plans.request(site(1));
    expect(plans.working).toBe(true);
    w.fail();
    expect(plans.working).toBe(false);
    expect(w.dead).toBe(true);
    expect(plans.take(site(1))).toBeNull();
  });

  it('gives the worker up when a site cannot be sent to it', () => {
    const { w } = fakeWorker();
    w.postMessage = () => {
      throw new Error('could not be cloned');
    };
    const plans = new PlanAhead(() => w);
    plans.request(site(2));
    expect(plans.working).toBe(false);
  });
});
