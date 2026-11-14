import { describe, expect, it } from 'vitest';
import { createWorld } from '../surface';
import { frostCover, frostLayout, frostRegion, frostUniform } from '../frost';

describe('frostland', () => {
  const w = createWorld(20261111);
  const region = frostRegion(w)!;
  const layout = frostLayout(w, region);

  it('wraps a snow massif a journey from the start', () => {
    expect(region).not.toBeNull();
    expect(Math.hypot(region.cx, region.cz)).toBeGreaterThan(6000);
    expect(region.kind).toBeLessThanOrEqual(1);
    expect(frostUniform(region).toArray()).toEqual([region.cx, region.cz, region.rIn, region.rOut]);
    expect(frostUniform(null).w).toBe(0);
  });

  it('keeps its snow off every city', () => {
    for (const c of w.cities.near(region.cx, region.cz).slice(0, 4)) {
      expect(frostCover(region, c.cx, c.cz)).toBe(0);
      expect(Math.hypot(c.cx - region.cx, c.cz - region.cz)).toBeGreaterThan(region.rOut + c.radius);
    }
  });

  it('thins from full snow to bare sand', () => {
    expect(frostCover(region, region.cx, region.cz)).toBe(1);
    expect(frostCover(region, region.cx + region.rOut + 1, region.cz)).toBe(0);
    const mid = frostCover(region, region.cx + (region.rIn + region.rOut) / 2, region.cz);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
  });

  it('lays a road out of the desert, up the mountain, with steady steps and finite ground', () => {
    const { way } = layout;
    expect(way.length).toBeGreaterThan(200);
    expect(frostCover(region, way[0].x, way[0].z)).toBe(0);
    expect(layout.gateAt).toBeGreaterThan(5);
    expect(layout.gateAt).toBeLessThan(layout.climbAt);
    let steepest = 0;
    for (let i = 1; i < way.length; i++) {
      expect(Number.isFinite(way[i].y)).toBe(true);
      steepest = Math.max(steepest, Math.abs(way[i].y - way[i - 1].y) / 12);
    }
    expect(steepest).toBeLessThan(0.75);
    // up the flank: a real climb
    expect(way[way.length - 1].y - way[layout.climbAt].y).toBeGreaterThan(200);
  });

  it('puts three villages on the road, each higher than the last', () => {
    const v = layout.villages;
    expect(v.map((x) => x.kind)).toEqual(['gate', 'mid', 'high']);
    expect(v[0].at).toBeLessThan(v[1].at);
    expect(v[1].at).toBeLessThan(v[2].at);
    expect(layout.way[v[1].at].y).toBeGreaterThan(layout.way[v[0].at].y);
    expect(layout.way[v[2].at].y).toBeGreaterThan(layout.way[v[1].at].y);
  });
});
