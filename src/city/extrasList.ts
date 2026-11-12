import type { ExtraBuilder } from './extras';
import { water } from './extra/water';
import { plants } from './extra/plants';

/**
 * Everything added to a city beyond its buildings, in the order it is built.
 * Earlier entries claim ground first (ctx.claim), so large fixed things come before small ones.
 */
export const EXTRAS: ExtraBuilder[] = [water, plants];
