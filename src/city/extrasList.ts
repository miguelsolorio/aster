import type { ExtraBuilder } from './extras';
import { water } from './extra/water';
import { plants } from './extra/plants';
import { outskirts } from './extra/outskirts';
import { furniture } from './extra/furniture';
import { life } from './extra/life';

/**
 * Everything added to a city beyond its buildings, in the order it is built.
 * Earlier entries claim ground first (ctx.claim), so large fixed things come before small ones.
 */
export const EXTRAS: ExtraBuilder[] = [water, plants, outskirts, furniture, life];
