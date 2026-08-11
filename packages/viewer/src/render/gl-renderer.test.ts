import { describe, it, expect } from 'vitest';
import { sortDrawList, mipLevels, type DrawItem } from './gl-renderer.js';

describe('sortDrawList', () => {
  it('orders coarse levels before finer levels (ascending, stable)', () => {
    const list: DrawItem[] = [
      { handle: 1, level: 2 },
      { handle: 2, level: 0 },
      { handle: 3, level: 1 },
      { handle: 4, level: 0 },
    ];
    const sorted = sortDrawList(list);
    expect(sorted.map((d) => d.handle)).toEqual([2, 4, 3, 1]);
  });

  it('is stable for equal levels', () => {
    const list: DrawItem[] = [
      { handle: 10, level: 3 },
      { handle: 11, level: 3 },
      { handle: 12, level: 3 },
    ];
    expect(sortDrawList(list).map((d) => d.handle)).toEqual([10, 11, 12]);
  });

  it('returns [] for an empty list', () => {
    expect(sortDrawList([])).toEqual([]);
  });
});

describe('mipLevels', () => {
  it('is 1 for a 1×1 texture', () => {
    expect(mipLevels(1, 1)).toBe(1);
  });
  it('is 10 for a 512×512 texture', () => {
    expect(mipLevels(512, 512)).toBe(10);
  });
  it('keys off the larger dimension (non-square 512×256 → 10)', () => {
    expect(mipLevels(512, 256)).toBe(10);
  });
});
