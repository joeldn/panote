import { describe, it, expect } from 'vitest';
import { selectEvictions } from './tile-cache.js';

describe('selectEvictions', () => {
  it('returns [] when cache is under budget', () => {
    const entries = [
      { key: '0/front/0-0', lastUsed: 1 },
      { key: '1/front/0-0', lastUsed: 2 },
    ];
    expect(selectEvictions(entries, 5)).toEqual([]);
  });

  it('returns [] when cache is exactly at budget', () => {
    const entries = [
      { key: '1/front/0-0', lastUsed: 1 },
      { key: '1/front/1-0', lastUsed: 2 },
    ];
    expect(selectEvictions(entries, 2)).toEqual([]);
  });

  it('never returns a level-0 key even if it is the oldest', () => {
    const entries = [
      { key: '0/front/0-0', lastUsed: 1 }, // oldest
      { key: '0/back/0-0', lastUsed: 2 }, // second oldest but also level-0
      { key: '1/front/0-0', lastUsed: 3 },
      { key: '1/front/1-0', lastUsed: 4 },
      { key: '2/front/0-0', lastUsed: 5 },
    ];
    // budget=4, overflow=1 → must evict non-level-0 LRU
    const result = selectEvictions(entries, 4);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('1/front/0-0');
    expect(result.every((k) => !k.startsWith('0/'))).toBe(true);
  });

  it('evicts the N oldest non-level-0 keys when over budget by N', () => {
    const entries = [
      { key: '1/front/0-0', lastUsed: 10 },
      { key: '1/front/1-0', lastUsed: 30 },
      { key: '1/front/2-0', lastUsed: 20 },
      { key: '2/front/0-0', lastUsed: 40 },
      { key: '0/front/0-0', lastUsed: 5 }, // level-0, must not be evicted
    ];
    // budget=3, overflow=2 → evict 2 oldest non-level-0: lastUsed 10 and 20
    const result = selectEvictions(entries, 3);
    expect(result).toHaveLength(2);
    expect(result).toContain('1/front/0-0'); // lastUsed=10
    expect(result).toContain('1/front/2-0'); // lastUsed=20
    expect(result).not.toContain('0/front/0-0');
  });

  it('handles ties deterministically (sort is stable, first by lastUsed)', () => {
    const entries = [
      { key: '1/front/0-0', lastUsed: 5 },
      { key: '1/front/1-0', lastUsed: 5 },
      { key: '1/front/2-0', lastUsed: 5 },
    ];
    // budget=2, overflow=1 → evict 1; since all tied, first in array order wins
    const result = selectEvictions(entries, 2);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('1/front/0-0');
  });
});
