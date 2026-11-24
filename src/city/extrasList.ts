import type { Extra, ExtraBuilder, ExtraCtx } from './extras';
import { water, waterJob } from './extra/water';
import { plants, plantsJob } from './extra/plants';
import { outskirts, outskirtsJob } from './extra/outskirts';
import { furniture, furnitureJob } from './extra/furniture';
import { life, lifeJob } from './extra/life';

/**
 * Everything added to a city beyond its buildings, in the order it is built.
 * Earlier entries claim ground first (ctx.claim), so large fixed things come before small ones.
 */
export const EXTRAS: ExtraBuilder[] = [water, plants, outskirts, furniture, life];

/**
 * The same, each as a job (see world/budget.ts) that yields between its parts and returns what
 * the builder does: built a step at a time on the frame budget, or finished at once.
 */
export const EXTRA_JOBS: Array<(ctx: ExtraCtx) => Generator<void, Extra>> = [waterJob, plantsJob, outskirtsJob, furnitureJob, lifeJob];
