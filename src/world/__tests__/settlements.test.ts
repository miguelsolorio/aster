import { describe, expect, it } from 'vitest';
import { createWorld } from '../surface';
import { Discoveries } from '../discoveries';
import { SETTLEMENT_KINDS, isSettlement } from '../settlementKinds';
import { TERRAIN } from '../surface';

const world = createWorld(1);
const CELL = 675;

describe('the settlements', () => {
  const d = new Discoveries(world, {});
  const all = d.surfaceSitesNear(0, 0, 16000, []).filter((s) => isSettlement(s.kind));
  const count = (k: string): number => all.filter((s) => s.kind === k).length;

  it('every kind stands somewhere within a few hours of the start', () => {
    console.log(SETTLEMENT_KINDS.map((k) => `${k} ${count(k)}`).join(', '));
    for (const k of SETTLEMENT_KINDS) expect(count(k), k).toBeGreaterThan(0);
  });

  it('the small ones are commoner than the big ones', () => {
    expect(count('well-camp') + count('glass-kilns')).toBeGreaterThan(count('wind-towers') + count('stepped-city'));
  });

  it('a bridge stands on its river and the dyers a little back from one', () => {
    for (const s of all) {
      if (s.kind === 'bridge') expect(world.river(s.x, s.z)).toBeLessThan(3);
      if (s.kind === 'dyers-town') expect(world.river(s.x, s.z)).toBeGreaterThan(TERRAIN.riverFloor);
    }
  });

  it('each kind builds, with its people and one of them to stop for', () => {
    const build = d as unknown as { buildSite(cx: number, cz: number): void; villages(out: unknown[]): { kind: string; folk: { role: string }[] }[] };
    for (const k of SETTLEMENT_KINDS) {
      const s = all.find((a) => a.kind === k)!;
      const cx = Math.floor(s.key / 65536) - 32768;
      const cz = (s.key % 65536) - 32768;
      expect(Math.abs(cx * CELL - s.x)).toBeLessThan(CELL * 1.5);
      build.buildSite(cx, cz);
    }
    const vils = build.villages([]);
    for (const k of SETTLEMENT_KINDS) {
      const v = vils.find((a) => a.kind === k);
      expect(v, k).toBeDefined();
      expect(v!.folk.filter((f) => f.role === 'host').length, k).toBe(1);
      expect(v!.folk.length, k).toBeGreaterThanOrEqual(6);
    }
  });
});
