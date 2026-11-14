import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Save, clearProgress, clearSpawn, loadSpawn, saveSpawn } from '../save';

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
const qs = (s = '') => new URLSearchParams(s);

beforeEach(() => {
  store = new MemStorage();
  vi.stubGlobal('localStorage', store);
});

describe('Save', () => {
  it('starts fresh with empty storage', () => {
    const s = new Save(qs());
    expect(s.data.tools).toEqual({ board: false, carpet: false, pick: false });
    expect(s.data.talked).toBe(false);
    expect(s.data.roles.miner).toBe(0);
    expect(s.data.opened).toEqual([]);
    expect(s.data.introSeen).toBe(false);
    expect(s.data.found).toEqual([]);
  });

  it('round-trips everything', () => {
    const a = new Save(qs());
    a.give('board');
    a.setTalked();
    a.setItem('lamp', true);
    a.setRole('miner', 2);
    a.open(5);
    a.take(6);
    a.wake(7);
    a.setIntroSeen();
    a.find('oasis');
    a.find('temple');
    const b = new Save(qs());
    expect(b.data).toEqual(a.data);
    expect(b.has('board')).toBe(true);
    expect(b.has('pick')).toBe(false);
    expect(b.data.opened).toEqual([5]);
    expect(b.data.introSeen).toBe(true);
    expect(b.data.found).toEqual(['oasis', 'temple']);
  });

  it('counts each kind of find once, and ignores kinds it does not know', () => {
    const a = new Save(qs());
    expect(a.find('arch')).toBe(true);
    expect(a.find('arch')).toBe(false);
    expect(a.find('lamp')).toBe(false);
    expect(a.find('nowhere')).toBe(false);
    expect(new Save(qs()).data.found).toEqual(['arch']);
  });

  it('keeps the intro put away once it has been seen', () => {
    const a = new Save(qs());
    expect(a.data.introSeen).toBe(false);
    a.setIntroSeen();
    expect(new Save(qs()).data.introSeen).toBe(true);
    // ?reset starts a new journey, intro and all
    expect(new Save(qs('reset')).data.introSeen).toBe(false);
  });

  it('treats a save from before the intro as one that has seen it', () => {
    store.setItem('aster.save', JSON.stringify({ v: 1, talked: true }));
    expect(new Save(qs()).data.introSeen).toBe(true);
    store.setItem('aster.save', JSON.stringify({ v: 1, introSeen: false }));
    expect(new Save(qs()).data.introSeen).toBe(false);
    store.setItem('aster.save', JSON.stringify({ v: 1, introSeen: 'yes' }));
    expect(new Save(qs()).data.introSeen).toBe(false);
  });

  it('does not duplicate keys', () => {
    const a = new Save(qs());
    a.open(1);
    a.open(1);
    expect(new Save(qs()).data.opened).toEqual([1]);
  });

  it('falls back to fresh on corrupt JSON', () => {
    store.setItem('aster.save', '{not json');
    expect(new Save(qs()).data.talked).toBe(false);
  });

  it('ignores unknown versions and non-object values', () => {
    for (const raw of ['{"v":2,"talked":true}', '"hi"', '42', 'null', '[]']) {
      store.setItem('aster.save', raw);
      expect(new Save(qs()).data.talked).toBe(false);
    }
  });

  it('reads a v1 save missing newer fields, and sanitizes bad ones', () => {
    store.setItem(
      'aster.save',
      JSON.stringify({ v: 1, tools: { board: true, carpet: 'yes' }, talked: true, roles: { miner: 7 }, opened: [1, 'x', null, NaN, 2], taken: 'nope' }),
    );
    const d = new Save(qs()).data;
    expect(d.tools).toEqual({ board: true, carpet: false, pick: false });
    expect(d.talked).toBe(true);
    expect(d.items).toEqual({ lamp: false, relic: false });
    expect(d.roles.miner).toBe(0);
    expect(d.opened).toEqual([1, 2]);
    expect(d.taken).toEqual([]);
    expect(d.found).toEqual([]);
  });

  it('sanitizes the found kinds: known ones only, each once, in order', () => {
    store.setItem('aster.save', JSON.stringify({ v: 1, found: ['grove', 'lamp', 3, null, 'grove', 'summit'] }));
    expect(new Save(qs()).data.found).toEqual(['grove', 'summit']);
    store.setItem('aster.save', JSON.stringify({ v: 1, found: 'grove' }));
    expect(new Save(qs()).data.found).toEqual([]);
  });

  it('lends tools from the URL without saving them', () => {
    const s = new Save(qs('tools=board,pick,bogus'));
    expect(s.has('board')).toBe(true);
    expect(s.has('pick')).toBe(true);
    expect(s.has('carpet')).toBe(false);
    expect(s.data.tools.board).toBe(false);
    expect(store.getItem('aster.save')).toBeNull();
  });

  it('?reset clears save and spawn', () => {
    new Save(qs()).give('carpet');
    saveSpawn({ x: 1, z: 2, facing: 0 });
    const s = new Save(qs('reset'));
    expect(s.has('carpet')).toBe(false);
    expect(store.getItem('aster.save')).toBeNull();
    expect(loadSpawn()).toBeNull();
  });

  it('clearProgress keeps unrelated settings', () => {
    store.setItem('volume', '0.5');
    new Save(qs()).give('board');
    clearProgress();
    expect(store.getItem('aster.save')).toBeNull();
    expect(store.getItem('volume')).toBe('0.5');
  });

  it('survives unavailable storage', () => {
    const boom = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    const s = new Save(qs());
    expect(() => s.give('board')).not.toThrow();
    expect(s.has('board')).toBe(true);
    expect(() => clearProgress()).not.toThrow();
    expect(saveSpawn({ x: 0, z: 0, facing: 0 })).toBe(false);
    expect(loadSpawn()).toBeNull();
  });
});

describe('spawn', () => {
  it('round-trips and clears', () => {
    expect(saveSpawn({ x: 1.5, z: -2, facing: 3 })).toBe(true);
    expect(loadSpawn()).toEqual({ x: 1.5, z: -2, facing: 3 });
    clearSpawn();
    expect(loadSpawn()).toBeNull();
  });

  it('rejects missing, malformed, or non-finite spawns', () => {
    expect(loadSpawn()).toBeNull();
    for (const raw of ['{bad', '{"x":1,"z":2}', '{"x":"1","z":2,"facing":0}', '5', '[]']) {
      store.setItem('aster.spawn', raw);
      expect(loadSpawn()).toBeNull();
    }
    // JSON has no NaN/Infinity literal; 1e999 parses to Infinity.
    store.setItem('aster.spawn', '{"x":1e999,"z":2,"facing":0}');
    expect(loadSpawn()).toBeNull();
  });
});
