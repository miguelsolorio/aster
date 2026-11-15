import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATLAS_CELL, Atlas, areaAround, cellKey, clearAtlas, keyX, keyZ } from '../atlas';
import { clearProgress } from '../save';

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

let store: MemStorage;
beforeEach(() => {
  store = new MemStorage();
  vi.stubGlobal('localStorage', store);
});

describe('atlas', () => {
  it('numbers cells so they can be read back, either side of the origin', () => {
    for (const [cx, cz] of [[0, 0], [-1, -1], [12, -340], [-32768, 32767]]) {
      const k = cellKey(cx, cz);
      expect(keyX(k)).toBe(cx);
      expect(keyZ(k)).toBe(cz);
    }
  });

  it('starts with nothing seen', () => {
    const a = new Atlas();
    expect(a.cells.size).toBe(0);
    expect(a.has(0, 0)).toBe(false);
    expect(a.dirty).toBe(false);
  });

  it('reveals the round stood in, and only what is new the second time', () => {
    const a = new Atlas();
    const fresh: number[] = [];
    const n = a.reveal(0, 0, 480, fresh);
    // about the area of the round, in cells
    const want = (Math.PI * 480 * 480) / (ATLAS_CELL * ATLAS_CELL);
    expect(n).toBeGreaterThan(want * 0.8);
    expect(n).toBeLessThan(want * 1.2);
    expect(fresh).toHaveLength(n);
    expect(a.has(0, 0)).toBe(true);
    expect(a.has(-1, -1)).toBe(true);
    expect(a.has(5, 0)).toBe(false);
    expect(a.dirty).toBe(true);
    expect(a.reveal(0, 0, 480)).toBe(0);
    // a step on: a sliver of new ground, not the whole round again
    const more = a.reveal(ATLAS_CELL, 0, 480);
    expect(more).toBeGreaterThan(0);
    expect(more).toBeLessThan(n / 2);
  });

  it('takes no notice of a place that is nowhere', () => {
    const a = new Atlas();
    expect(a.reveal(Number.NaN, 0, 480)).toBe(0);
    expect(a.reveal(0, 0, 0)).toBe(0);
    expect(a.reveal(1e12, 0, 480)).toBe(0);
    expect(a.cells.size).toBe(0);
  });

  it('keeps each place once', () => {
    const a = new Atlas();
    expect(a.addPlace({ id: 's1', kind: 'oasis', x: 10.4, z: -20.6 })).toBe(true);
    expect(a.addPlace({ id: 's1', kind: 'oasis', x: 10, z: -20 })).toBe(false);
    expect(a.addPlace({ id: 's2', kind: 'temple', x: Number.NaN, z: 0 })).toBe(false);
    expect(a.places).toEqual([{ id: 's1', kind: 'oasis', x: 10, z: -21 }]);
  });

  it('round-trips through storage', () => {
    const a = new Atlas();
    a.reveal(300, -4000, 480);
    a.reveal(-90000, 12000, 900);
    a.addPlace({ id: 'c7', kind: 'city:oasis', x: 100, z: 200 });
    a.store();
    expect(a.dirty).toBe(false);
    const b = Atlas.load();
    expect([...b.cells].sort()).toEqual([...a.cells].sort());
    expect(b.places).toEqual(a.places);
    expect(b.dirty).toBe(false);
  });

  it('stores a walked path as runs, not cell by cell', () => {
    const a = new Atlas();
    for (let x = 0; x < 20000; x += 100) a.reveal(x, 0, 480);
    expect(a.cells.size).toBeGreaterThan(1000);
    expect(a.encode().length).toBeLessThan(400);
  });

  it('reads nothing from a map it cannot trust', () => {
    for (const bad of ['', 'nope', '{"v":2,"rows":{"0":[0,5]}}', '[]', 'null']) expect(Atlas.decode(bad).cells.size).toBe(0);
    const a = Atlas.decode('{"v":1,"rows":{"0":[0,2,"x",3,5,-1,9],"zz":[0,4],"1":7},"places":[{"id":"a","kind":"oasis","x":1,"z":2},{"id":3},null]}');
    expect([...a.cells].sort()).toEqual([cellKey(0, 0), cellKey(1, 0)].sort());
    expect(a.places).toEqual([{ id: 'a', kind: 'oasis', x: 1, z: 2 }]);
  });

  it('is forgotten with the rest of the journey', () => {
    const a = new Atlas();
    a.reveal(0, 0, 480);
    a.store();
    clearProgress();
    expect(Atlas.load().cells.size).toBe(0);
    a.dirty = true;
    a.store();
    clearAtlas();
    expect(Atlas.load().cells.size).toBe(0);
  });
});

describe('areaAround', () => {
  it('holds the spot, but not at its middle', () => {
    for (const [x, z] of [[0, 0], [1234, -5678], [-90211, 40.5], [7, 7]]) {
      const a = areaAround(x, z, 400);
      const d = Math.hypot(a.x - x, a.z - z);
      expect(d).toBeGreaterThan(400 * 0.2);
      expect(d).toBeLessThan(400 * 0.7);
      expect(a.r).toBe(400);
    }
  });

  it('gives the same spot the same round every time', () => {
    expect(areaAround(1234, -5678, 400)).toEqual(areaAround(1234, -5678, 400));
    expect(areaAround(1234, -5678, 400)).not.toEqual(areaAround(1334, -5678, 400));
  });
});
