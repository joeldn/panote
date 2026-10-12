import { describe, it, expect } from 'vitest';
import { pickEvictions, type EvictCandidate } from './tile-cache.js';
import { selectEvictions } from './test-support/oracles.js';

/** A cached tile with key `key` (`level/face/x-y`) last used in frame `lastUsed`. */
function entry(key: string, lastUsed: number): EvictCandidate {
  return { key, level: Number(key.split('/')[0]), lastUsed };
}

describe('selectEvictions', () => {
  it('returns [] when cache is under budget', () => {
    const entries = [entry('0/front/0-0', 1), entry('1/front/0-0', 2)];
    expect(selectEvictions(entries, 5)).toEqual([]);
  });

  it('returns [] when cache is exactly at budget', () => {
    const entries = [entry('1/front/0-0', 1), entry('1/front/1-0', 2)];
    expect(selectEvictions(entries, 2)).toEqual([]);
  });

  it('never returns a level-0 key even if it is the oldest', () => {
    const entries = [
      entry('0/front/0-0', 1), // oldest
      entry('0/back/0-0', 2), // second oldest but also level-0
      entry('1/front/0-0', 3),
      entry('1/front/1-0', 4),
      entry('2/front/0-0', 5),
    ];
    // budget=4, overflow=1 → must evict non-level-0 LRU
    const result = selectEvictions(entries, 4);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('1/front/0-0');
    expect(result.every((k) => !k.startsWith('0/'))).toBe(true);
  });

  it('evicts the N oldest non-level-0 keys when over budget by N', () => {
    const entries = [
      entry('1/front/0-0', 10),
      entry('1/front/1-0', 30),
      entry('1/front/2-0', 20),
      entry('2/front/0-0', 40),
      entry('0/front/0-0', 5), // level-0, must not be evicted
    ];
    // budget=3, overflow=2 → evict 2 oldest non-level-0: lastUsed 10 and 20
    const result = selectEvictions(entries, 3);
    expect(result).toHaveLength(2);
    expect(result).toContain('1/front/0-0'); // lastUsed=10
    expect(result).toContain('1/front/2-0'); // lastUsed=20
    expect(result).not.toContain('0/front/0-0');
  });

  it('handles ties deterministically (sort is stable, first by lastUsed)', () => {
    const entries = [entry('1/front/0-0', 5), entry('1/front/1-0', 5), entry('1/front/2-0', 5)];
    // budget=2, overflow=1 → evict 1; since all tied, first in array order wins
    const result = selectEvictions(entries, 2);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('1/front/0-0');
  });

  it('never evicts a tile used in the current frame, even over budget', () => {
    const entries = [
      entry('1/front/0-0', 7),
      entry('1/front/1-0', 7),
      entry('1/front/2-0', 6),
      entry('0/front/0-0', 1),
    ];
    // budget=1, overflow=3 -> only the stale tile can go; the cache stays
    // over budget rather than dropping what is on screen.
    expect(selectEvictions(entries, 1, 7)).toEqual(['1/front/2-0']);
  });
});

describe('pickEvictions', () => {
  /** The sort-everything selection the partial one replaces. */
  function bySorting(entries: EvictCandidate[], overflow: number, frame: number): string[] {
    return entries
      .filter((e) => e.level !== 0 && e.lastUsed !== frame)
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, Math.max(0, overflow))
      .map((e) => e.key);
  }

  it('picks the same tiles, in the same order, as sorting the whole cache', () => {
    let seed = 1;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const out: EvictCandidate[] = [];
    for (let run = 0; run < 300; run++) {
      const n = 1 + Math.floor(random() * 250);
      const frame = 1 + Math.floor(random() * 40);
      const entries: EvictCandidate[] = Array.from({ length: n }, (_, i) =>
        entry(
          `${random() < 0.05 ? 0 : 1 + Math.floor(random() * 3)}/px/${i}-0`,
          // Few distinct stamps, so ties are common.
          1 + Math.floor(random() * frame),
        ),
      );
      const overflow = Math.floor(random() * (n + 5)) - 3;
      const picked = pickEvictions(entries, overflow, frame, out).map((e) => e.key);
      expect(picked).toEqual(bySorting(entries, overflow, frame));
    }
  });

  it('writes into the array it is given, so a frame allocates no candidate list', () => {
    const out: EvictCandidate[] = [];
    const entries = [entry('1/px/0-0', 3), entry('1/px/1-0', 1), entry('1/px/2-0', 2)];
    expect(pickEvictions(entries, 2, 9, out)).toBe(out);
    expect(out.map((e) => e.key)).toEqual(['1/px/1-0', '1/px/2-0']);
    expect(pickEvictions(entries, 0, 9, out)).toEqual([]);
  });
});
