import { describe, it, expect, vi } from 'vitest';
import { loadTileImage } from './tile-fetch.js';
import { TileHttpError } from './tile-retry.js';
import type { CubeTileSource } from './source.js';

const source: CubeTileSource = {
  id: 'p',
  tileSize: 512,
  maxLevel: 0,
  tileUrl: (t) => `/t/${t.level}/${t.face}/${t.x}-${t.y}.jpg`,
};
const tile = { face: 'pz', level: 0, x: 0, y: 0 } as const;

describe('loadTileImage', () => {
  it('cancels the body of an error response before rejecting', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const blob = vi.fn();
    const fetch = vi.fn(() => Promise.resolve({ ok: false, status: 503, body: { cancel }, blob }));
    const err = await loadTileImage(source, tile, new AbortController().signal, 'high', {
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TileHttpError);
    expect((err as TileHttpError).status).toBe(503);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(blob).not.toHaveBeenCalled();
  });

  it('rejects with the status when an error response has no body', async () => {
    const fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404, body: null }));
    await expect(
      loadTileImage(source, tile, new AbortController().signal, 'high', {
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
