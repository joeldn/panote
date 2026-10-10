import { FACES } from '@panote/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { prefetchPano } from './prefetch.js';

const BASE = 'https://cdn.test/tiles/';

const manifest = {
  pano: 'church',
  faceSize: 512,
  tileSize: 512,
  maxLevel: 0,
  faces: [...FACES],
  quality: 80,
  format: 'webp',
  version: 'v1',
};

const ok = (body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });

/** A fetch that rejects with an AbortError once its signal aborts, and never settles before. */
const hanging = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prefetchPano', () => {
  it('fetches the manifest and the six level-0 tiles at low priority', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith('manifest.json') ? ok(manifest) : ok('tile'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await prefetchPano(BASE, 'church');

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}church/manifest.json`,
      ...FACES.map((f) => `${BASE}church/v1/0/${f}/0-0.webp`),
    ]);
    for (const [, init] of fetchMock.mock.calls) expect(init?.priority).toBe('low');
  });

  it.each([
    ['save-data is on', { saveData: true }],
    ['the connection is 2g', { effectiveType: '2g' }],
    ['the connection is slow-2g', { effectiveType: 'slow-2g' }],
  ])('fetches nothing when %s', async (_, connection) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { connection });

    await prefetchPano(BASE, 'church');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefetches on a fast connection', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('manifest.json') ? ok(manifest) : ok('tile'),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { connection: { saveData: false, effectiveType: '4g' } });

    await prefetchPano(BASE, 'church');

    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('cancels every request in flight on abort, and resolves', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      url.endsWith('manifest.json') ? Promise.resolve(ok(manifest)) : hanging(url, init),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const done = prefetchPano(BASE, 'church', { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    controller.abort();

    await expect(done).resolves.toBeUndefined();
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBe(controller.signal);
      expect(init?.signal?.aborted).toBe(true);
    }
  });

  it('stops before the tiles when aborted during the manifest fetch', async () => {
    const fetchMock = vi.fn(hanging);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const done = prefetchPano(BASE, 'church', { signal: controller.signal });
    controller.abort();

    await expect(done).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches nothing once already aborted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await prefetchPano(BASE, 'church', { signal: AbortSignal.abort() });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves quietly when the manifest is missing or invalid', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(prefetchPano(BASE, 'church')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => ok({ pano: 'church' }));
    await expect(prefetchPano(BASE, 'church')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels the body of an error response for the manifest and the tiles', async () => {
    const cancelled: string[] = [];
    const failing = (url: string) => {
      const res = new Response('nope', { status: 404 });
      const cancel = res.body!.cancel.bind(res.body!);
      vi.spyOn(res.body!, 'cancel').mockImplementation((reason) => {
        cancelled.push(url);
        return cancel(reason);
      });
      return res;
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => failing(url)),
    );
    await prefetchPano(BASE, 'church');
    expect(cancelled).toEqual([`${BASE}church/manifest.json`]);

    cancelled.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('manifest.json')
          ? ok(manifest)
          : url.includes('/px/')
            ? failing(url)
            : ok('tile'),
      ),
    );
    await prefetchPano(BASE, 'church');
    expect(cancelled).toEqual([`${BASE}church/v1/0/px/0-0.webp`]);
  });

  it('resolves quietly when a tile fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('manifest.json')) return ok(manifest);
        if (url.includes('/px/')) throw new TypeError('network');
        return new Response('gone', { status: 404 });
      }),
    );
    await expect(prefetchPano(BASE, 'church')).resolves.toBeUndefined();
  });
});
