import { describe, it, expect } from 'vitest';
import { selectLevel } from './lod.js';

describe('selectLevel', () => {
  it('uses level 0 when a single base tile already matches screen density', () => {
    // 90° face / 512 texels vs 90° fov / 512 px => ideal log2(1)=0
    expect(selectLevel(90, 512, 512, 4)).toBe(0);
  });

  it('increases the level as fov shrinks (zoom in)', () => {
    expect(selectLevel(45, 1024, 512, 8)).toBe(2);
    expect(selectLevel(22.5, 1024, 512, 8)).toBe(3);
  });

  it('never exceeds maxLevel', () => {
    expect(selectLevel(1, 4000, 512, 4)).toBe(4);
  });

  it('never goes below 0', () => {
    expect(selectLevel(120, 200, 512, 4)).toBe(0);
  });

  it('returns 0 for non-positive inputs instead of NaN', () => {
    expect(selectLevel(0, 512, 512, 4)).toBe(0);
    expect(selectLevel(90, 0, 512, 4)).toBe(0);
    expect(selectLevel(90, 512, 0, 4)).toBe(0);
  });

  it('returns 0 for NaN or Infinity fov instead of NaN', () => {
    expect(selectLevel(NaN, 512, 512, 4)).toBe(0);
    expect(selectLevel(Infinity, 512, 512, 4)).toBe(0);
  });

  it('ceil rounds up when ideal is just above an integer level', () => {
    // fov=44: 90*1024/(512*44) ≈ 4.091 → log2 ≈ 2.034 → ceil = 3
    expect(selectLevel(44, 1024, 512, 8)).toBe(3);
  });

  it('ceil stays at the lower level when ideal is just below the boundary', () => {
    // fov=46: 90*1024/(512*46) ≈ 3.913 → log2 ≈ 1.968 → ceil = 2
    expect(selectLevel(46, 1024, 512, 8)).toBe(2);
  });
});
