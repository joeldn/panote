import { describe, expect, it, vi } from 'vitest';

import { json, manifest } from './__fixtures__/helpers.js';
import type { XhrLike } from './api/upload.js';
import { createUploadDeps } from './upload-deps.js';

describe('createUploadDeps', () => {
  it('wires presign, XHR PUT, CDN manifest and pano status', async () => {
    const presign = vi.fn(async () => ({ panoId: 'p1', key: 'k', url: 'https://r2.test/put' }));
    const getPanoStatus = vi.fn(async () => ({
      hasConfig: false,
      hasOriginal: true,
      deleting: false,
      tiling: 'pending' as const,
      manifest: null,
      updatedAt: 'x',
    }));
    const fetch = vi.fn(async (_u: string, _i?: RequestInit) => json(manifest('t1-a', 'p1')));
    const xhr = {
      status: 200,
      upload: { onprogress: null },
      onload: null,
      onerror: null,
      onabort: null,
      ontimeout: null,
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      abort: vi.fn(),
      send: vi.fn(function (this: XhrLike) {
        queueMicrotask(() => xhr.onload?.());
      }),
    } as XhrLike & { send: ReturnType<typeof vi.fn> };
    const deps = createUploadDeps({
      uploadApi: { presign },
      adminApi: { getPanoStatus },
      tilesBase: 'https://cdn.test/tiles/',
      fetch,
      createXhr: () => xhr,
    });

    await deps.presign({ contentType: 'image/png', size: 3 });
    expect(presign).toHaveBeenCalledWith({ contentType: 'image/png', size: 3 });
    const signal = new AbortController().signal;
    await deps.put('https://r2.test/put', new Blob(['abc']), {
      contentType: 'image/png',
      onProgress: () => {},
      signal,
    });
    expect(xhr.open).toHaveBeenCalledWith('PUT', 'https://r2.test/put');
    await expect(deps.fetchManifest('p1', { signal })).resolves.toMatchObject({ version: 't1-a' });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://cdn.test/tiles/p1/manifest.json');
    await expect(deps.getPanoStatus('p1')).resolves.toMatchObject({ tiling: 'pending' });
  });
});
