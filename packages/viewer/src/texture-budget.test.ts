import { describe, it, expect } from 'vitest';
import {
  BASE_TEXTURE_BUDGET_MB,
  MAX_BUDGET_PIXEL_RATIO,
  defaultTextureBudgetMB,
} from './texture-budget.js';

describe('defaultTextureBudgetMB', () => {
  it('keeps the pre-scaling budget on a devicePixelRatio-1 display', () => {
    expect(defaultTextureBudgetMB(1, 2)).toBe(BASE_TEXTURE_BUDGET_MB);
    expect(defaultTextureBudgetMB(1, 2)).toBe(128);
  });

  it('doubles the budget on a devicePixelRatio-2 display', () => {
    // The reason the whole change exists: at DPR 2 the pyramid selects one
    // level finer, which is 4x the tiles on screen. 2x the budget is the
    // bounded answer to that (see texture-budget.ts).
    expect(defaultTextureBudgetMB(2, 2)).toBe(256);
  });

  it('scales continuously between the two, rather than stepping', () => {
    expect(defaultTextureBudgetMB(1.5, 2)).toBe(192);
    expect(defaultTextureBudgetMB(1.25, 2)).toBe(160);
  });

  it('stops scaling past the cap, however dense the display', () => {
    // Phones report 3 and 4. Their GPUs are the ones that can least afford
    // 384-512 MB of resident textures, so the ladder stops at 2x.
    expect(defaultTextureBudgetMB(3, 2)).toBe(256);
    expect(defaultTextureBudgetMB(4, 2)).toBe(256);
    expect(defaultTextureBudgetMB(10, 2)).toBe(BASE_TEXTURE_BUDGET_MB * MAX_BUDGET_PIXEL_RATIO);
  });

  it('caps independently of maxPixelRatio, which is a rendering choice not a memory one', () => {
    // Raising maxPixelRatio asks for a sharper framebuffer. It must not also
    // silently authorise 384 MB of textures.
    expect(defaultTextureBudgetMB(3, 3)).toBe(256);
    expect(defaultTextureBudgetMB(4, 8)).toBe(256);
  });

  it('does not scale past what the viewer will actually render at', () => {
    // maxPixelRatio 1 renders a CSS-pixel framebuffer, so level selection sees
    // exactly what it saw before the DPR fix and the old budget still fits.
    expect(defaultTextureBudgetMB(2, 1)).toBe(BASE_TEXTURE_BUDGET_MB);
    expect(defaultTextureBudgetMB(3, 1.5)).toBe(192);
  });

  it('falls back to the unscaled budget when the host reports no pixel ratio', () => {
    // A non-browser host, or one that does not define devicePixelRatio at all.
    expect(defaultTextureBudgetMB(undefined, 2)).toBe(BASE_TEXTURE_BUDGET_MB);
    expect(defaultTextureBudgetMB(Number.NaN, 2)).toBe(BASE_TEXTURE_BUDGET_MB);
    expect(defaultTextureBudgetMB(0, 2)).toBe(BASE_TEXTURE_BUDGET_MB);
    expect(defaultTextureBudgetMB(-2, 2)).toBe(BASE_TEXTURE_BUDGET_MB);
    expect(defaultTextureBudgetMB(Number.POSITIVE_INFINITY, 2)).toBe(BASE_TEXTURE_BUDGET_MB);
  });

  it('never returns less than the unscaled budget, whatever it is handed', () => {
    // A sub-1 ratio renders fewer device pixels than CSS pixels, but level
    // selection floors at 0 and the base layer is pinned - there is nothing to
    // reclaim by going below the DPR-1 budget.
    expect(defaultTextureBudgetMB(0.5, 2)).toBe(BASE_TEXTURE_BUDGET_MB);
    expect(defaultTextureBudgetMB(2, Number.NaN)).toBe(256);
    expect(defaultTextureBudgetMB(2, 0)).toBe(256);
  });
});
