import { describe, expect, it } from 'vitest';
import { fillBands, planEquirect } from './equirect.js';
import { MAX_INPUT_PIXELS } from './pyramid.js';

describe('planEquirect', () => {
  it('leaves a 2:1 source as it is', () => {
    expect(planEquirect(8192, 4096)).toEqual({
      width: 8192,
      height: 4096,
      top: 0,
      contentHeight: 4096,
      scaled: false,
    });
  });

  it('leaves a source narrower than 2:1 as it is', () => {
    expect(planEquirect(3000, 2000)).toEqual({
      width: 3000,
      height: 2000,
      top: 0,
      contentHeight: 2000,
      scaled: false,
    });
  });

  it('pads a 4:1 strip to 2:1 with the content centred on the horizon', () => {
    expect(planEquirect(8000, 2000)).toEqual({
      width: 8000,
      height: 4000,
      top: 1000,
      contentHeight: 2000,
      scaled: false,
    });
  });

  it('puts an odd leftover row below the content', () => {
    const plan = planEquirect(1000, 497);
    expect(plan).toMatchObject({ width: 1000, height: 500, top: 1, contentHeight: 497 });
  });

  it('pads a source a row short of 2:1 by that row only', () => {
    expect(planEquirect(4000, 1999)).toMatchObject({ height: 2000, top: 0, contentHeight: 1999 });
  });

  it('downscales a strip whose padded size would go over the pixel cap', () => {
    // 30000 x 5000 is 150 MP, at the input cap; padded to 2:1 it would be 450 MP.
    const plan = planEquirect(30_000, 5000);
    expect(plan.scaled).toBe(true);
    expect(plan.width * plan.height).toBeLessThanOrEqual(MAX_INPUT_PIXELS);
    expect(plan.height).toBe(Math.round(plan.width / 2));
    expect(plan.contentHeight).toBe(Math.round((5000 * plan.width) / 30_000));
    expect(plan.top).toBe(Math.floor((plan.height - plan.contentHeight) / 2));
  });

  it('keeps the cap with a small one too', () => {
    const plan = planEquirect(1000, 100, 20_000);
    expect(plan).toEqual({ width: 200, height: 100, top: 40, contentHeight: 20, scaled: true });
  });

  it('keeps at least one content row for an extreme strip', () => {
    const plan = planEquirect(100_000, 1, 20_000);
    expect(plan.contentHeight).toBe(1);
    expect(plan.width * plan.height).toBeLessThanOrEqual(20_000);
  });
});

describe('fillBands', () => {
  const px = (data: Uint8Array, width: number, x: number, y: number) =>
    Array.from(data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3));

  it('fades each band from the edge row into its average colour', () => {
    // 2 wide, 10 tall, content on rows 4-5: top row red/blue, bottom row white/black.
    const width = 2;
    const height = 10;
    const data = new Uint8Array(width * height * 3);
    data.set([255, 0, 0, 0, 0, 255], 4 * width * 3);
    data.set([255, 255, 255, 0, 0, 0], 5 * width * 3);
    fillBands(data, width, height, 4, 2);

    // Content untouched.
    expect(px(data, width, 0, 4)).toEqual([255, 0, 0]);
    expect(px(data, width, 1, 5)).toEqual([0, 0, 0]);
    // A 4-row band fades over its first row (ceil(4 / 4)): already flat at the mean.
    for (const y of [0, 1, 2, 3]) {
      expect(px(data, width, 0, y)).toEqual([128, 0, 128]);
      expect(px(data, width, 1, y)).toEqual([128, 0, 128]);
    }
    for (const y of [6, 7, 8, 9]) expect(px(data, width, 0, y)).toEqual([128, 128, 128]);
  });

  it('blends the edge into the mean over a longer band', () => {
    const width = 2;
    const height = 18;
    const data = new Uint8Array(width * height * 3);
    data.set([200, 200, 200, 0, 0, 0], 8 * width * 3);
    data.set([200, 200, 200, 0, 0, 0], 9 * width * 3);
    fillBands(data, width, height, 8, 2);
    // Band of 8 rows fades over 2: row 7 is halfway, row 6 on is the mean.
    expect(px(data, width, 0, 7)).toEqual([150, 150, 150]);
    expect(px(data, width, 1, 7)).toEqual([50, 50, 50]);
    expect(px(data, width, 0, 6)).toEqual([100, 100, 100]);
    expect(px(data, width, 1, 0)).toEqual([100, 100, 100]);
    expect(px(data, width, 0, 10)).toEqual([150, 150, 150]);
    expect(px(data, width, 1, 17)).toEqual([100, 100, 100]);
  });

  it('does nothing when there are no bands', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    fillBands(data, 1, 2, 0, 2);
    expect(Array.from(data)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
