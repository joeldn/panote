import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeXhr } from '../__fixtures__/upload.js';
import {
  checkPlanFile,
  MAX_PLAN_INPUT_BYTES,
  PLAN_EDGE,
  PlanImageError,
  planSize,
  uploadPlanImage,
} from './plan-image.js';

afterEach(() => {
  FakeXhr.all = [];
});

describe('planSize', () => {
  it('keeps a small image as it is and scales a big one to PLAN_EDGE on its long side', () => {
    expect(planSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(planSize(4096, 2048)).toEqual({ width: PLAN_EDGE, height: 1024 });
    expect(planSize(1000, 5000)).toEqual({ width: 410, height: PLAN_EDGE });
    expect(planSize(10_000, 1)).toEqual({ width: PLAN_EDGE, height: 1 });
  });
});

describe('checkPlanFile', () => {
  it('takes JPG, PNG and WebP up to 30 MB', () => {
    expect(() => checkPlanFile({ type: 'image/png', size: MAX_PLAN_INPUT_BYTES })).not.toThrow();
    expect(() => checkPlanFile({ type: 'image/svg+xml', size: 10 })).toThrow(PlanImageError);
    expect(() => checkPlanFile({ type: 'image/gif', size: 10 })).toThrow(
      'Use a JPG, PNG or WebP image.',
    );
    expect(() => checkPlanFile({ type: 'image/jpeg', size: 0 })).toThrow('This file is empty.');
    expect(() => checkPlanFile({ type: 'image/jpeg', size: MAX_PLAN_INPUT_BYTES + 1 })).toThrow(
      'larger than 30 MB',
    );
  });
});

describe('uploadPlanImage', () => {
  it('uploads the redrawn image, not the file, and returns the plan to save', async () => {
    const redrawn = new Blob(['webp-bytes'], { type: 'image/webp' });
    const prepare = vi.fn(async () => ({
      blob: redrawn,
      type: 'image/webp' as const,
      width: 1600,
      height: 900,
    }));
    const presignPlan = vi.fn(async () => ({
      planId: 'plan-1',
      key: 'pub/plans/t1/plan-1.webp',
      url: 'https://r2.test/put?sig',
    }));
    const file = new File(['original-with-exif'], 'plan.jpg', { type: 'image/jpeg' });
    const done = uploadPlanImage(
      { upload: { presignPlan }, prepare, createXhr: () => new FakeXhr() },
      't1',
      file,
    );
    await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://r2.test/put?sig');
    expect(xhr.headers['content-type']).toBe('image/webp');
    expect(xhr.body).toBe(redrawn);
    xhr.respond(200);
    await expect(done).resolves.toEqual({
      id: 'plan-1',
      type: 'image/webp',
      width: 1600,
      height: 900,
    });
    expect(prepare).toHaveBeenCalledWith(file);
    expect(presignPlan).toHaveBeenCalledWith({
      tourId: 't1',
      contentType: 'image/webp',
      size: redrawn.size,
    });
  });

  it('asks for no URL when the image can’t be prepared', async () => {
    const presignPlan = vi.fn();
    const prepare = vi.fn(async () => {
      throw new PlanImageError('Use a JPG, PNG or WebP image.');
    });
    await expect(
      uploadPlanImage({ upload: { presignPlan }, prepare }, 't1', new File([''], 'x.gif')),
    ).rejects.toBeInstanceOf(PlanImageError);
    expect(presignPlan).not.toHaveBeenCalled();
  });
});
