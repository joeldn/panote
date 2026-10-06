import { describe, expect, it } from 'vitest';

import {
  MAX_PATCH_SIZE,
  PATCH_GUTTER,
  patchLimit,
  planPatches,
  previewSize,
  readDeviceHints,
  selectPreviewTier,
  type PatchRect,
} from './plan.js';

describe('selectPreviewTier', () => {
  it.each([
    [{ deviceMemory: 2, coarsePointer: false }, 'phone'],
    [{ deviceMemory: 4, coarsePointer: false }, 'phone'],
    [{ deviceMemory: 8, coarsePointer: true }, 'phone'],
    [{ coarsePointer: true }, 'phone'],
    [{ deviceMemory: 8, coarsePointer: false }, 'desktop'],
    [{ coarsePointer: false }, 'desktop'],
  ] as const)('%o -> %s', (hints, tier) => {
    expect(selectPreviewTier(hints)).toBe(tier);
  });
});

describe('readDeviceHints', () => {
  it('reads deviceMemory and the coarse pointer query', () => {
    const queries: string[] = [];
    const hints = readDeviceHints({
      navigator: { deviceMemory: 4 },
      matchMedia: (q) => (queries.push(q), { matches: true }),
    });
    expect(hints).toEqual({ deviceMemory: 4, coarsePointer: true });
    expect(queries).toEqual(['(pointer: coarse)']);
  });

  it('falls back when neither is exposed (Safari, Firefox, workers)', () => {
    expect(readDeviceHints({ navigator: {} })).toEqual({
      deviceMemory: undefined,
      coarsePointer: false,
    });
    expect(readDeviceHints({})).toEqual({ deviceMemory: undefined, coarsePointer: false });
  });
});

describe('previewSize', () => {
  it('fits a 150 MP pano into each tier', () => {
    const src = { width: 17320, height: 8660 };
    expect(previewSize(src, 'desktop')).toEqual({ width: 8192, height: 4096 });
    expect(previewSize(src, 'phone')).toEqual({ width: 4096, height: 2048 });
  });

  it('never upscales', () => {
    expect(previewSize({ width: 6000, height: 3000 }, 'desktop')).toEqual({
      width: 6000,
      height: 3000,
    });
    expect(previewSize({ width: 4096, height: 2048 }, 'phone')).toEqual({
      width: 4096,
      height: 2048,
    });
  });

  it('keeps the aspect of a non 2:1 source inside the tier box', () => {
    expect(previewSize({ width: 10000, height: 6000 }, 'desktop')).toEqual({
      width: 6827,
      height: 4096,
    });
  });

  it('honours a caller width cap', () => {
    expect(previewSize({ width: 17000, height: 8500 }, 'desktop', { maxWidth: 2048 })).toEqual({
      width: 2048,
      height: 1024,
    });
  });
});

describe('patchLimit', () => {
  it('is min(4096, MAX_TEXTURE_SIZE)', () => {
    expect(patchLimit()).toBe(MAX_PATCH_SIZE);
    expect(patchLimit({ maxTextureSize: 16384 })).toBe(4096);
    expect(patchLimit({ maxTextureSize: 2048 })).toBe(2048);
  });
});

/** Distinct spans along one axis, in order. */
function spans(rects: PatchRect[], axis: 'x' | 'y'): Array<[number, number]> {
  const size = axis === 'x' ? 'w' : 'h';
  const seen = new Map<number, number>();
  for (const r of rects) seen.set(r[axis], r[axis] + r[size]);
  return [...seen.entries()].sort((a, b) => a[0] - b[0]);
}

function expectAxis(list: Array<[number, number]>, length: number, max: number, gutter: number) {
  expect(list[0]?.[0]).toBe(0);
  expect(list.at(-1)?.[1]).toBe(length);
  for (const [start, end] of list) expect(end - start).toBeLessThanOrEqual(max);
  // Neighbours overlap by exactly two gutters, so every pixel is covered.
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const cur = list[i];
    expect(prev && cur && prev[1] - cur[0]).toBe(2 * gutter);
  }
}

describe('planPatches', () => {
  it('keeps a phone-tier preview in one patch', () => {
    expect(planPatches(4096, 2048, 4096)).toEqual([{ x: 0, y: 0, w: 4096, h: 2048 }]);
  });

  it('splits the desktop tier into 3 columns because gutters push 2 past 4096', () => {
    const rects = planPatches(8192, 4096, 4096);
    expect(rects).toHaveLength(3);
    expect(spans(rects, 'x')).toEqual([
      [0, 2733],
      [2729, 5463],
      [5459, 8192],
    ]);
    expect(spans(rects, 'y')).toEqual([[0, 4096]]);
  });

  it('puts no gutter on image borders', () => {
    const rects = planPatches(8192, 4096, 4096);
    expect(Math.min(...rects.map((r) => r.x))).toBe(0);
    expect(Math.min(...rects.map((r) => r.y))).toBe(0);
    expect(Math.max(...rects.map((r) => r.x + r.w))).toBe(8192);
    expect(Math.max(...rects.map((r) => r.y + r.h))).toBe(4096);
  });

  it.each([
    [8192, 4096, 4096],
    [8192, 4096, 2048],
    [4096, 2048, 2048],
    [6827, 4096, 4096],
    [7001, 3499, 1024],
    [5, 3, 5],
    [1, 1, 4096],
  ])('covers %ix%i with patches <= %i and 2px overlaps', (w, h, max) => {
    const rects = planPatches(w, h, max);
    expectAxis(spans(rects, 'x'), w, max, PATCH_GUTTER);
    expectAxis(spans(rects, 'y'), h, max, PATCH_GUTTER);
    // A full grid: every column meets every row.
    expect(rects).toHaveLength(spans(rects, 'x').length * spans(rects, 'y').length);
  });

  it('rejects a limit with no room beyond the gutters', () => {
    expect(() => planPatches(100, 100, 4)).toThrow(RangeError);
  });
});
