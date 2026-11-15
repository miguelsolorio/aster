import { describe, expect, it } from 'vitest';
import { footVillageFolk, snowVillageFolk, type FolkMark } from '../villagers';

const frame = (yaw: number) => ({ Tx: Math.cos(yaw), Tz: Math.sin(yaw), Nx: -Math.sin(yaw), Nz: Math.cos(yaw) });
const count = (folk: FolkMark[], role: FolkMark['role']) => folk.filter((f) => f.role === role).length;
const apart = (folk: FolkMark[]) => {
  let least = Infinity;
  for (let i = 0; i < folk.length; i++) for (let k = i + 1; k < folk.length; k++) least = Math.min(least, Math.hypot(folk[i].u - folk[k].u, folk[i].v - folk[k].v));
  return least;
};

describe('the people of a foot village', () => {
  const plans = [5, 6].flatMap((slots) => [-1, 1].flatMap((endSign) => [0, 1.1, -2.4].map((yaw) => ({ ...frame(yaw), slots, endSign, gap: 10.6, x0: -((slots - 1) / 2) * 10.6, square: Math.floor(slots / 2) }))));

  it('has one watcher, one climber and a child among the rest', () => {
    for (const p of plans) {
      const folk = footVillageFolk(p);
      expect(count(folk, 'watcher')).toBe(1);
      expect(count(folk, 'climber')).toBe(1);
      expect(folk.filter((f) => f.small)).toHaveLength(1);
      expect(count(folk, 'villager')).toBeGreaterThanOrEqual(5);
    }
  });

  it('gives everyone room, inside the village, facing somewhere', () => {
    for (const p of plans) {
      const folk = footVillageFolk(p);
      expect(apart(folk)).toBeGreaterThan(1);
      for (const f of folk) {
        expect(Math.hypot(f.u, f.v)).toBeLessThan(62);
        expect(Math.hypot(f.fu - f.u, f.fv - f.v)).toBeGreaterThan(0.5);
      }
    }
  });

  it('stands the watcher past the end of the street the tower is at, looking down the slope', () => {
    for (const p of plans) {
      const w = footVillageFolk(p).find((f) => f.role === 'watcher')!;
      const along = w.u * p.Tx + w.v * p.Tz;
      expect(Math.sign(along)).toBe(p.endSign);
      expect(Math.abs(along)).toBeGreaterThan(-p.x0 + 5);
      // (N points down the slope, toward the sand)
      expect((w.fu - w.u) * p.Nx + (w.fv - w.v) * p.Nz).toBeGreaterThan(10);
    }
  });

  it('sits the climber at the fire in the square', () => {
    for (const p of plans) {
      const c = footVillageFolk(p).find((f) => f.role === 'climber')!;
      expect(c.sit).toBe(true);
      const d = Math.hypot(c.fu - c.u, c.fv - c.v);
      expect(d).toBeGreaterThan(1.6);
      expect(d).toBeLessThan(3);
    }
  });
});

describe('the people of a snow village', () => {
  const plan = (kind: 'gate' | 'mid' | 'high', yaw: number) => ({ ...frame(yaw), ox: 4, oz: -7, hw: 3, kind, hold: kind === 'high' ? ([4 + Math.cos(yaw) * 40, -7 + Math.sin(yaw) * 40] as [number, number]) : null });

  it('has a climber at the fire in every village, and no watcher', () => {
    for (const kind of ['gate', 'mid', 'high'] as const) {
      for (const yaw of [0, 0.9, 3]) {
        const folk = snowVillageFolk(plan(kind, yaw));
        expect(count(folk, 'climber')).toBe(1);
        expect(count(folk, 'watcher')).toBe(0);
        expect(apart(folk)).toBeGreaterThan(1);
      }
    }
  });

  it('has more people in the big village, and someone below the hold in the high one', () => {
    const gate = snowVillageFolk(plan('gate', 0.4));
    const mid = snowVillageFolk(plan('mid', 0.4));
    const high = snowVillageFolk(plan('high', 0.4));
    expect(mid.length).toBeGreaterThan(gate.length);
    expect(mid.some((f) => f.small)).toBe(true);
    expect(high.length).toBe(gate.length + 1);
  });

  it('keeps everyone off the middle of the road', () => {
    for (const kind of ['gate', 'mid', 'high'] as const) {
      const p = plan(kind, 1.3);
      for (const f of snowVillageFolk(p).slice(0, kind === 'high' ? -1 : undefined)) {
        const off = (f.u - p.ox) * p.Nx + (f.v - p.oz) * p.Nz;
        expect(Math.abs(off)).toBeGreaterThan(0.3);
      }
    }
  });
});
