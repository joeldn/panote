import { describe, it, expect } from 'vitest';
import { LOD_TOLERANCE, selectLevel } from './lod.js';
import { effectiveVFovDeg } from './render/projection.js';

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

  it('stays at the lower level until the ideal is a full tolerance past it', () => {
    // fov 90, tileSize 512: ideal = log2(height / 512).
    const at = (ideal: number) => selectLevel(90, 512 * 2 ** ideal, 512, 8);
    expect(at(2)).toBe(2);
    expect(at(2 + LOD_TOLERANCE - 0.01)).toBe(2);
    expect(at(2 + LOD_TOLERANCE + 0.01)).toBe(3);
    expect(at(3 - 0.01)).toBe(3);
  });

  it('rounds straight up with no tolerance', () => {
    expect(selectLevel(90, 512 * 2 ** 2.01, 512, 8, 0)).toBe(3);
    expect(selectLevel(90, 512 * 2 ** 2.01, 512, 8)).toBe(2);
  });

  it('picks level 2, not 3, for an 800 px tall 16:9 view at devicePixelRatio 2', () => {
    // The canonical laptop case: ideal is 2.05, just past level 2. Rounding
    // that straight up fetched level 3, 88 tiles on screen against 24.
    const fov = effectiveVFovDeg(70, 100, 16 / 9);
    expect(selectLevel(fov, 1600, 512, 3)).toBe(2);
    // One level coarser at DPR 1, as before.
    expect(selectLevel(fov, 800, 512, 3)).toBe(1);
  });
});
