import { ConflictError, type AdminApi } from '@internal/web-kit';
import { describe, expect, it, vi } from 'vitest';

import { addPanoToTour, titleFromFileName } from './finalize.js';

type Api = Pick<AdminApi, 'getPano' | 'putPanoConfig' | 'getTour' | 'putTour'>;

const tourOk = (scenes: Array<{ panoId: string }>, etag = 'e1') => ({
  status: 'ok' as const,
  data: { tour: { tourId: 't1', title: 'T', scenes }, etag },
});

function api(over: Partial<Api> = {}): Api {
  return {
    getPano: vi.fn(
      async () => ({ status: 'not-found', deleting: false, hasOriginal: true }) as const,
    ),
    putPanoConfig: vi.fn(async () => ({ etag: 'c1' })),
    getTour: vi.fn(async () => tourOk([{ panoId: 'a' }])),
    putTour: vi.fn(async () => ({ etag: 'e2' })),
    ...over,
  } as Api;
}

describe('titleFromFileName', () => {
  it('drops the extension and underscores, with a fallback', () => {
    expect(titleFromFileName('IMG_2041__town hall.JPG', 'x')).toBe('IMG 2041 town hall');
    expect(titleFromFileName('.png', 'Untitled')).toBe('Untitled');
    expect(titleFromFileName('a'.repeat(300), 'x')).toHaveLength(100);
  });
});

describe('addPanoToTour', () => {
  it('creates the missing config and appends the scene under If-Match', async () => {
    const a = api();
    await addPanoToTour(a, 't1', 'p1', 'Hall');
    expect(a.putPanoConfig).toHaveBeenCalledWith('p1', { title: 'Hall' }, '*');
    expect(a.putTour).toHaveBeenCalledWith(
      't1',
      { tourId: 't1', title: 'T', scenes: [{ panoId: 'a' }, { panoId: 'p1' }] },
      'e1',
    );
  });

  it('is idempotent: an existing config and an already-listed scene are left alone', async () => {
    const a = api({
      getPano: vi.fn(async () => ({ status: 'ok', data: {} }) as never),
      getTour: vi.fn(async () => tourOk([{ panoId: 'p1' }])),
    });
    await addPanoToTour(a, 't1', 'p1', 'Hall');
    expect(a.putPanoConfig).not.toHaveBeenCalled();
    expect(a.putTour).not.toHaveBeenCalled();
  });

  it('re-reads and retries on 412, up to three tries', async () => {
    const putTour = vi
      .fn<Api['putTour']>()
      .mockRejectedValueOnce(new ConflictError(null))
      .mockResolvedValueOnce({ etag: 'e3' });
    const getTour = vi
      .fn<Api['getTour']>()
      .mockResolvedValueOnce(tourOk([]))
      .mockResolvedValueOnce(tourOk([{ panoId: 'b' }], 'e2'));
    await addPanoToTour(api({ putTour, getTour }), 't1', 'p1', 'Hall');
    expect(putTour).toHaveBeenLastCalledWith(
      't1',
      expect.objectContaining({ scenes: [{ panoId: 'b' }, { panoId: 'p1' }] }),
      'e2',
    );

    const always = vi.fn<Api['putTour']>().mockRejectedValue(new ConflictError(null));
    await expect(addPanoToTour(api({ putTour: always }), 't1', 'p1', 'H')).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(always).toHaveBeenCalledTimes(3);
  });

  it('fails clearly for a deleted tour or a pano being deleted', async () => {
    await expect(
      addPanoToTour(
        api({ getTour: vi.fn(async () => ({ status: 'not-found' }) as const) }),
        't1',
        'p1',
        'H',
      ),
    ).rejects.toThrow('This tour no longer exists.');
    await expect(
      addPanoToTour(
        api({
          getPano: vi.fn(
            async () => ({ status: 'not-found', deleting: true, hasOriginal: true }) as const,
          ),
        }),
        't1',
        'p1',
        'H',
      ),
    ).rejects.toThrow('being deleted');
  });
});
