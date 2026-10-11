import { VIEWER_DEFAULTS } from './defaults.js';
import { describe, it, expect } from 'vitest';
import {
  BASE_TEXTURE_BUDGET_MB,
  CONSTRAINED_TEXTURE_BUDGET_MB,
  MAX_BUDGET_PIXEL_RATIO,
  defaultTextureBudgetMB,
  isConstrainedDevice,
  maxTilesForBudget,
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

describe('the phone cap', () => {
  it('holds a constrained device to 128 MB whatever its pixel ratio', () => {
    expect(CONSTRAINED_TEXTURE_BUDGET_MB).toBe(128);
    expect(defaultTextureBudgetMB(3, 2, true)).toBe(128);
    expect(defaultTextureBudgetMB(2, 2, true)).toBe(128);
    expect(defaultTextureBudgetMB(1, 2, true)).toBe(128);
    expect(defaultTextureBudgetMB(3, 2, false)).toBe(256);
  });

  /** A window with a `coarse` or fine pointer and a `w` × `h` screen. */
  const win = (coarse: boolean, w: number, h: number) => ({
    matchMedia: (q: string) => ({ matches: coarse && q === '(pointer: coarse)' }),
    screen: { width: w, height: h },
  });

  it('counts a small touch-first screen, or a low memory hint, as constrained', () => {
    // Phones, portrait or landscape, and a small tablet or a folded phone.
    expect(isConstrainedDevice(win(true, 390, 844), {})).toBe(true);
    expect(isConstrainedDevice(win(true, 844, 390), {})).toBe(true);
    expect(isConstrainedDevice(win(true, 744, 1133), {})).toBe(true);
    // Chrome's navigator.deviceMemory, in GB: 4 or less.
    expect(isConstrainedDevice(undefined, { deviceMemory: 4 })).toBe(true);
    expect(isConstrainedDevice(win(false, 1920, 1080), { deviceMemory: 2 })).toBe(true);
  });

  it('leaves desktops, laptops and full-size tablets their full budget', () => {
    expect(isConstrainedDevice(win(false, 1512, 982), {})).toBe(false);
    // A small screen with a fine pointer is not a phone.
    expect(isConstrainedDevice(win(false, 600, 800), {})).toBe(false);
    // A touch laptop or a full-size tablet.
    expect(isConstrainedDevice(win(true, 820, 1180), {})).toBe(false);
    expect(isConstrainedDevice(win(true, 1366, 1024), {})).toBe(false);
    expect(isConstrainedDevice(win(false, 1512, 982), { deviceMemory: 8 })).toBe(false);
  });

  it('counts a host that says nothing, or throws, as unconstrained', () => {
    expect(isConstrainedDevice(undefined, undefined)).toBe(false);
    expect(isConstrainedDevice({}, {})).toBe(false);
    expect(isConstrainedDevice({ screen: { width: 390, height: 844 } }, {})).toBe(false);
    const throwing = {
      screen: { width: 390, height: 844 },
      matchMedia: () => {
        throw new Error('nope');
      },
    };
    expect(isConstrainedDevice(throwing, {})).toBe(false);
  });
});

describe('maxTilesForBudget', () => {
  it('counts the mip chain, so a tile costs 4/3 of its base level', () => {
    // 512² × 4 bytes is 1 MiB at the base level and 1.33 MiB with mips.
    expect(maxTilesForBudget(256, 512)).toBe(192);
    expect(maxTilesForBudget(128, 512)).toBe(96);
    expect(maxTilesForBudget(256, 1024)).toBe(48);
  });

  it('never goes below the resident-tile floor', () => {
    expect(maxTilesForBudget(1, 512)).toBe(VIEWER_DEFAULTS.memory.minResidentTiles);
    expect(maxTilesForBudget(0, 1024)).toBe(VIEWER_DEFAULTS.memory.minResidentTiles);
  });
});
