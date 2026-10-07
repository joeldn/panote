import type { PanoStatus } from '@internal/contracts';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTilingWatch, WATCH_POLL_MS } from './use-tiling-watch.js';

const status = (tiling: PanoStatus['tiling']): PanoStatus => ({
  hasConfig: true,
  hasOriginal: true,
  deleting: false,
  tiling,
  manifest: null,
  updatedAt: '2026-10-01T00:00:00Z',
});

const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useTilingWatch', () => {
  it('checks a pano that is not a target once on Check again, then stops', async () => {
    const getPanoStatus = vi.fn(async () => status('pending'));
    const { result } = renderHook(() =>
      useTilingWatch({ api: { getPanoStatus }, targets: [], tilesBase: 'https://cdn.test/' }),
    );
    act(() => result.current.checkAgain('p1'));
    await tick();
    expect(getPanoStatus).toHaveBeenCalledTimes(1);
    expect(result.current.polled.p1).toEqual({ state: 'pending' });
    await tick(WATCH_POLL_MS * 5);
    expect(getPanoStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps polling a target until it settles', async () => {
    const getPanoStatus = vi
      .fn()
      .mockResolvedValueOnce(status('pending'))
      .mockResolvedValue(status('failed'));
    const { result } = renderHook(() =>
      useTilingWatch({ api: { getPanoStatus }, targets: ['p1'], tilesBase: 'https://cdn.test/' }),
    );
    await tick();
    expect(result.current.polled.p1).toEqual({ state: 'pending' });
    await tick(WATCH_POLL_MS);
    expect(result.current.polled.p1).toEqual({ state: 'failed' });
    await tick(WATCH_POLL_MS * 5);
    expect(getPanoStatus).toHaveBeenCalledTimes(2);
  });
});
