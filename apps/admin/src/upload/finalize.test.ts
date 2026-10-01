import { ApiError, ConflictError, MAX_TOUR_SCENES, type AdminApi } from '@internal/web-kit';
import { describe, expect, it, vi } from 'vitest';

import {
  addPanoToTour,
  assertTourHasRoom,
  FinalizeError,
  TOUR_FULL_MESSAGE,
  titleFromFileName,
} from './finalize.js';

type Api = Pick<AdminApi, 'createPanoConfig' | 'getTour' | 'putTour'>;

const tourOk = (scenes: Array<{ panoId: string }>, etag = 'e1') => ({
  status: 'ok' as const,
  data: { tour: { tourId: 't1', title: 'T', scenes }, etag },
});

function api(over: Partial<Api> = {}): Api {
  return {
    createPanoConfig: vi.fn(async () => ({ etag: 'c1' })),
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
  it('creates the config (create-only) and appends the scene under If-Match', async () => {
    const a = api();
    await addPanoToTour(a, 't1', 'p1', 'Hall');
    expect(a.createPanoConfig).toHaveBeenCalledWith('p1', { title: 'Hall' });
    expect(a.putTour).toHaveBeenCalledWith(
      't1',
      { tourId: 't1', title: 'T', scenes: [{ panoId: 'a' }, { panoId: 'p1' }] },
      'e1',
    );
  });

  it('is idempotent: a 412 (config exists) is fine, and a listed scene is left alone', async () => {
    const a = api({
      createPanoConfig: vi.fn<Api['createPanoConfig']>().mockRejectedValue(new ConflictError(null)),
      getTour: vi.fn(async () => tourOk([{ panoId: 'p1' }])),
    });
    await addPanoToTour(a, 't1', 'p1', 'Hall');
    expect(a.createPanoConfig).toHaveBeenCalledTimes(1);
    expect(a.putTour).not.toHaveBeenCalled();
  });

  it('a 412 on the config still appends the scene', async () => {
    const a = api({
      createPanoConfig: vi.fn<Api['createPanoConfig']>().mockRejectedValue(new ConflictError(null)),
    });
    await addPanoToTour(a, 't1', 'p1', 'Hall');
    expect(a.putTour).toHaveBeenCalledTimes(1);
  });

  it('other config failures stop before the tour write', async () => {
    const a = api({
      createPanoConfig: vi.fn<Api['createPanoConfig']>().mockRejectedValue(new ApiError(500, null)),
    });
    await expect(addPanoToTour(a, 't1', 'p1', 'Hall')).rejects.toBeInstanceOf(ApiError);
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
        // 409: a tombstone (delete in flight) refuses the config write.
        api({
          createPanoConfig: vi
            .fn<Api['createPanoConfig']>()
            .mockRejectedValue(new ApiError(409, { error: 'pano is being deleted' })),
        }),
        't1',
        'p1',
        'H',
      ),
    ).rejects.toThrow('being deleted');
  });
});

describe('scene cap', () => {
  const full = () =>
    tourOk(Array.from({ length: MAX_TOUR_SCENES }, (_, i) => ({ panoId: `p${i}` })));

  it('refuses to append to a full tour, without a retry', async () => {
    const a = api({ getTour: vi.fn(async () => full()) });
    const err = await addPanoToTour(a, 't1', 'new', 'H').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinalizeError);
    expect((err as FinalizeError).message).toBe(TOUR_FULL_MESSAGE);
    expect((err as FinalizeError).retryable).toBe(false);
    expect(a.putTour).not.toHaveBeenCalled();
  });

  it("maps the server's 400 on the tour PUT to the same message", async () => {
    const putTour = vi.fn<Api['putTour']>().mockRejectedValue(new ApiError(400, { error: 'x' }));
    const err = await addPanoToTour(api({ putTour }), 't1', 'p1', 'H').catch((e: unknown) => e);
    expect(err).toMatchObject({ message: TOUR_FULL_MESSAGE, retryable: false });
    expect(putTour).toHaveBeenCalledTimes(1);
  });

  it('assertTourHasRoom checks before any upload', async () => {
    await expect(
      assertTourHasRoom(api({ getTour: vi.fn(async () => full()) }), 't1'),
    ).rejects.toThrow(TOUR_FULL_MESSAGE);
    await expect(assertTourHasRoom(api(), 't1')).resolves.toBeUndefined();
    await expect(
      assertTourHasRoom(
        api({ getTour: vi.fn(async () => ({ status: 'not-found' }) as const) }),
        't1',
      ),
    ).rejects.toThrow('This tour no longer exists.');
  });
});
