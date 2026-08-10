import { describe, it, expect } from 'vitest';
import { nextPow2, isPow2, computeFaceSize, computeMaxLevel } from './pyramid.js';

describe('nextPow2', () => {
  it('returns the same value for exact powers of two', () => {
    expect(nextPow2(4096)).toBe(4096);
    expect(nextPow2(512)).toBe(512);
    expect(nextPow2(1)).toBe(1);
  });

  it('rounds up to the next power of two', () => {
    expect(nextPow2(4097)).toBe(8192);
    expect(nextPow2(3000)).toBe(4096);
    expect(nextPow2(2049)).toBe(4096);
  });
});

describe('isPow2', () => {
  it('returns true for powers of two', () => {
    expect(isPow2(1)).toBe(true);
    expect(isPow2(512)).toBe(true);
    expect(isPow2(4096)).toBe(true);
  });

  it('returns false for non-powers of two', () => {
    expect(isPow2(500)).toBe(false);
    expect(isPow2(3)).toBe(false);
    expect(isPow2(1023)).toBe(false);
  });

  it('returns false for zero and negative', () => {
    expect(isPow2(0)).toBe(false);
    expect(isPow2(-1)).toBe(false);
  });
});

describe('computeFaceSize', () => {
  it('computes face size from a power-of-two source width', () => {
    // 16384 / 4 = 4096 → nextPow2(4096) = 4096
    expect(computeFaceSize(16384, 512)).toBe(4096);
  });

  it('rounds up non-power-of-two widths', () => {
    // 12000 / 4 = 3000 → ceil(3000) = 3000 → nextPow2(3000) = 4096
    expect(computeFaceSize(12000, 512)).toBe(4096);
  });

  it('caps at maxSize rounded DOWN to power of two', () => {
    // width 16384 → faceSize 4096; maxSize 2048 → cap 2048
    expect(computeFaceSize(16384, 512, 2048)).toBe(2048);
    // maxSize 3000 → floor(log2(3000)) = 11 → 2**11 = 2048 (not 4096)
    expect(computeFaceSize(16384, 512, 3000)).toBe(2048);
  });

  it('never goes below tileSize', () => {
    // tiny width: 4 / 4 = 1 → nextPow2(1) = 1 → below tileSize 512 → 512
    expect(computeFaceSize(4, 512)).toBe(512);
    // also with maxSize below tileSize
    expect(computeFaceSize(4, 512, 256)).toBe(512);
  });
});

describe('computeMaxLevel', () => {
  it('computes the correct pyramid depth', () => {
    expect(computeMaxLevel(4096, 512)).toBe(3);
    expect(computeMaxLevel(2048, 512)).toBe(2);
    expect(computeMaxLevel(512, 512)).toBe(0);
  });
});

describe('contract invariant', () => {
  it('faceSize === tileSize * 2 ** maxLevel for various combos', () => {
    const cases: Array<[number, number, number | undefined]> = [
      [16384, 512, undefined],
      [16384, 512, 2048],
      [16384, 512, 3000],
      [12000, 512, undefined],
      [4, 512, undefined],
      [8192, 256, undefined],
      [8192, 256, 1024],
    ];
    for (const [width, tile, maxSize] of cases) {
      const faceSize = computeFaceSize(width, tile, maxSize);
      const maxLevel = computeMaxLevel(faceSize, tile);
      expect(faceSize).toBe(tile * 2 ** maxLevel);
    }
  });
});
