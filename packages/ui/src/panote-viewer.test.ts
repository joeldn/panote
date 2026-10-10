import { FACES, manifestUrl, tilePath, type Manifest } from '@panote/core';
import type { PanoViewer } from '@panote/viewer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  manifestOf,
  PANOTE_REQUEST_INIT,
  panoteSource,
  panoteSourceResolver,
  panoteViewerPreset,
  prefetchPano,
} from './panote-viewer.js';

const BASE = 'https://cdn.test/tiles/';

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  pano: 'church',
  faceSize: 2048,
  tileSize: 512,
  maxLevel: 2,
  faces: [...FACES],
  quality: 82,
  format: 'webp',
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('panoteSource', () => {
  // The website Worker preloads the manifest and the six level-0 tiles by
  // core's manifestUrl and tilePath (apps/website/worker/boot.ts). A preload
  // is only reused by a request for the same bytes, so the viewer's URLs must
  // be core's exactly.
  it.each([
    ['a versioned manifest', manifest({ version: 't1-abc123' })],
    ['an unversioned manifest', manifest()],
    ['a jpg manifest', manifest({ format: 'jpg', version: 'v2' })],
    // parseManifest never lets one through, but the URL must still be core's.
    ['ids that need encoding', manifest({ pano: 'st mary/ä', version: 'v 1', maxLevel: 1 })],
  ])("builds tile URLs byte for byte equal to core's tilePath for %s", (_, m) => {
    const s = panoteSource(BASE, m);
    for (let level = 0; level <= m.maxLevel; level++) {
      const n = 2 ** level;
      for (const face of FACES) {
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            expect(s.tileUrl!({ face, level, x, y })).toBe(
              tilePath(BASE, m.pano, level, face, x, y, m.format, m.version),
            );
          }
        }
      }
    }
  });

  it('pins the exact level-0 URL shape the preloads use', () => {
    const s = panoteSource(BASE, manifest({ version: 't1-abc' }));
    expect(s.tileUrl!({ face: 'nz', level: 0, x: 0, y: 0 })).toBe(
      'https://cdn.test/tiles/church/t1-abc/0/nz/0-0.webp',
    );
    expect(panoteSource(BASE, manifest()).tileUrl!({ face: 'px', level: 2, x: 3, y: 1 })).toBe(
      'https://cdn.test/tiles/church/2/px/3-1.webp',
    );
  });

  it('maps the manifest onto the source and keeps it as meta', () => {
    const m = manifest({ version: 'v9' });
    const s = panoteSource(BASE, m);
    expect(s).toMatchObject({ id: 'church', tileSize: 512, maxLevel: 2, version: 'v9' });
    expect(s.loadTile).toBeUndefined();
    expect(manifestOf(s)).toBe(m);
    expect(panoteSource(BASE, manifest()).version).toBeUndefined();
  });
});

describe('panoteSourceResolver', () => {
  const answer = (body: unknown, status = 200) =>
    vi.fn(async (_url: string, _init?: RequestInit) => Response.json(body, { status }));

  it("fetches core's manifestUrl with the preload-matching init and the load's signal", async () => {
    const fetchMock = answer(manifest({ version: 'v1' }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;

    const s = await panoteSourceResolver(BASE)('church', signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(manifestUrl(BASE, 'church'));
    expect(url).toBe('https://cdn.test/tiles/church/manifest.json');
    expect(init).toEqual({ mode: 'cors', credentials: 'same-origin', signal });
    expect(s.id).toBe('church');
    expect(s.tileUrl!({ face: 'px', level: 0, x: 0, y: 0 })).toBe(
      'https://cdn.test/tiles/church/v1/0/px/0-0.webp',
    );
  });

  it('passes a priority hint through (a prefetch asks for low)', async () => {
    const fetchMock = answer(manifest());
    vi.stubGlobal('fetch', fetchMock);
    await panoteSourceResolver(BASE)('church', new AbortController().signal, { priority: 'low' });
    expect(fetchMock.mock.calls[0]![1]?.priority).toBe('low');
  });

  it('rejects with the status for a manifest that is not there, dropping its body', async () => {
    const res = new Response('nope', { status: 404 });
    const cancel = vi.spyOn(res.body!, 'cancel');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    );
    await expect(panoteSourceResolver(BASE)('gone', new AbortController().signal)).rejects.toThrow(
      'manifest 404',
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('rejects a manifest that does not parse', async () => {
    vi.stubGlobal('fetch', answer({ pano: 'church' }));
    await expect(
      panoteSourceResolver(BASE)('church', new AbortController().signal),
    ).rejects.toThrow(/manifest\./);
  });

  it('rejects with the AbortError when the signal aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    const controller = new AbortController();
    const resolving = panoteSourceResolver(BASE)('church', controller.signal);
    controller.abort();
    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('panoteViewerPreset', () => {
  it('gives the viewer the resolver for the base and the preload-matching request init', async () => {
    const preset = panoteViewerPreset({ baseUrl: BASE });
    expect(Object.keys(preset).sort()).toEqual(['requestInit', 'resolveSource']);
    expect(preset.requestInit).toBe(PANOTE_REQUEST_INIT);
    expect(PANOTE_REQUEST_INIT).toEqual({ mode: 'cors', credentials: 'same-origin' });
    expect(Object.isFrozen(PANOTE_REQUEST_INIT)).toBe(true);

    const fetchMock = vi.fn(async () => Response.json(manifest()));
    vi.stubGlobal('fetch', fetchMock);
    await preset.resolveSource!('church', new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledWith(manifestUrl(BASE, 'church'), expect.anything());
  });
});

describe('prefetchPano', () => {
  const viewerWith = () => {
    const prefetch = vi.fn(async (_id: string, _o?: { signal?: AbortSignal }) => {});
    return { viewer: { prefetch } as unknown as PanoViewer, prefetch };
  };

  it("hands the pano to the viewer's prefetch with the signal", async () => {
    const { viewer, prefetch } = viewerWith();
    const signal = new AbortController().signal;
    await prefetchPano(viewer, 'church', { signal });
    expect(prefetch).toHaveBeenCalledExactlyOnceWith('church', { signal });
    await prefetchPano(viewer, 'tower');
    expect(prefetch).toHaveBeenLastCalledWith('tower', {});
  });

  it.each([
    ['save-data is on', { saveData: true }],
    ['the connection is 2g', { effectiveType: '2g' }],
    ['the connection is slow-2g', { effectiveType: 'slow-2g' }],
  ])('does nothing when %s', async (_, connection) => {
    vi.stubGlobal('navigator', { connection });
    const { viewer, prefetch } = viewerWith();
    await prefetchPano(viewer, 'church');
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('goes ahead on a 3g or better connection', async () => {
    vi.stubGlobal('navigator', { connection: { saveData: false, effectiveType: '3g' } });
    const { viewer, prefetch } = viewerWith();
    await prefetchPano(viewer, 'church');
    expect(prefetch).toHaveBeenCalledOnce();
  });

  it('does nothing for a signal that has already aborted', async () => {
    const { viewer, prefetch } = viewerWith();
    const controller = new AbortController();
    controller.abort();
    await prefetchPano(viewer, 'church', { signal: controller.signal });
    expect(prefetch).not.toHaveBeenCalled();
  });
});
