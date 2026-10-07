import type { TourWithConfigsOk } from '@internal/contracts';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { ApiError } from '@internal/web-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useEditor, type EditorApi } from './use-editor.js';

type TourRes = { status: 'ok'; data: TourWithConfigsOk };

const tourRes = (
  etag: string,
  panoIds: string[],
  { tourId = 'tour-1', title = 'Town hall' } = {},
): TourRes => ({
  status: 'ok',
  data: {
    tour: { tourId, title, scenes: panoIds.map((panoId) => ({ panoId })) },
    etag,
    configs: Object.fromEntries(
      panoIds.map((panoId) => [
        panoId,
        { config: { panoId, title: panoId, hotspots: [] }, etag: `c-${panoId}` },
      ]),
    ),
  },
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(cleanup);

describe('useEditor syncAppended', () => {
  it('drops a response from a superseded sync that lands last', async () => {
    const queue = [Promise.resolve(tourRes('t1', []))];
    const older = deferred<TourRes>();
    const newer = deferred<TourRes>();
    queue.push(older.promise, newer.promise);
    const api = {
      getTourWithConfigs: () => queue.shift()!,
    } as unknown as EditorApi;

    const { result } = renderHook(() => useEditor(api, 'tour-1', 'user-1', null));
    await waitFor(() => expect(result.current.load.status).toBe('ready'));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.syncAppended();
      second = result.current.syncAppended();
    });
    await act(async () => {
      newer.resolve(tourRes('t3', ['pano-1', 'pano-2']));
      await second;
    });
    await act(async () => {
      older.resolve(tourRes('t2', ['pano-1']));
      await first;
    });

    const tour = result.current.docs!.tour;
    expect(tour.etag).toBe('t3');
    expect(tour.current.scenes.map((s) => s.panoId)).toEqual(['pano-1', 'pano-2']);
    expect(result.current.conflicts).toEqual([]);
  });

  it('drops a sync response requested before a save, then syncs again', async () => {
    const stale = deferred<TourRes>();
    const queue = [
      Promise.resolve(tourRes('t1', ['pano-1'])),
      stale.promise,
      Promise.resolve(tourRes('t2', ['pano-1'], { title: 'Renamed' })),
    ];
    let gets = 0;
    const api = {
      getTourWithConfigs: () => {
        gets++;
        return queue.shift()!;
      },
      putTour: async () => ({ etag: 't2' }),
      publishTour: async () => ({ slug: 's', visibility: 'unlisted', publishedAt: 'x' }),
    } as unknown as EditorApi;

    const { result } = renderHook(() => useEditor(api, 'tour-1', 'user-1', null));
    await waitFor(() => expect(result.current.load.status).toBe('ready'));

    let sync!: Promise<void>;
    act(() => {
      sync = result.current.syncAppended();
    });
    act(() => result.current.dispatch({ type: 'tour/title', title: 'Renamed' }));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.docs!.tour.etag).toBe('t2');

    await act(async () => {
      stale.resolve(tourRes('t1', ['pano-1']));
      await sync;
    });

    const tour = result.current.docs!.tour;
    expect(tour.etag).toBe('t2');
    expect(tour.current.title).toBe('Renamed');
    expect(result.current.dirty).toEqual([]);
    expect(result.current.conflicts).toEqual([]);
    // The dropped sync runs again once the save settles.
    await waitFor(() => expect(gets).toBe(3));
  });

  it('ignores a response carrying a tour ETag the editor already moved past', async () => {
    const queue = [
      Promise.resolve(tourRes('t1', ['pano-1'])),
      // A lagging read after the save: still the pre-save tour.
      Promise.resolve(tourRes('t1', ['pano-1'])),
    ];
    const api = {
      getTourWithConfigs: () => queue.shift()!,
      putTour: async () => ({ etag: 't2' }),
      publishTour: async () => ({ slug: 's', visibility: 'unlisted', publishedAt: 'x' }),
    } as unknown as EditorApi;

    const { result } = renderHook(() => useEditor(api, 'tour-1', 'user-1', null));
    await waitFor(() => expect(result.current.load.status).toBe('ready'));
    act(() => result.current.dispatch({ type: 'tour/title', title: 'Renamed' }));
    await act(async () => {
      await result.current.save();
    });
    await act(async () => {
      await result.current.syncAppended();
    });

    const tour = result.current.docs!.tour;
    expect(tour.etag).toBe('t2');
    expect(tour.current.title).toBe('Renamed');
  });

  it('drops a sync response for the previous tour after switching tours', async () => {
    const stale = deferred<TourRes>();
    const queue = [
      Promise.resolve(tourRes('a1', ['pano-1'])),
      stale.promise,
      Promise.resolve(tourRes('b1', ['pano-b'], { tourId: 'tour-2', title: 'Tour B' })),
    ];
    const api = { getTourWithConfigs: () => queue.shift()! } as unknown as EditorApi;

    const { result, rerender } = renderHook(({ id }) => useEditor(api, id, 'user-1', null), {
      initialProps: { id: 'tour-1' },
    });
    await waitFor(() => expect(result.current.load.status).toBe('ready'));

    let sync!: Promise<void>;
    act(() => {
      sync = result.current.syncAppended();
    });
    rerender({ id: 'tour-2' });
    await waitFor(() => expect(result.current.docs?.tour.etag).toBe('b1'));
    await act(async () => {
      stale.resolve(tourRes('a2', ['pano-1', 'pano-2']));
      await sync;
    });

    const { docs } = result.current;
    expect(docs!.tourId).toBe('tour-2');
    expect(docs!.tour.etag).toBe('b1');
    expect(docs!.tour.current.title).toBe('Tour B');
    expect(Object.keys(docs!.scenes)).toEqual(['pano-b']);
  });

  it('drops a sync response whose tour is not the one loaded', async () => {
    const queue = [
      Promise.resolve(tourRes('b1', ['pano-b'], { tourId: 'tour-2', title: 'Tour B' })),
      Promise.resolve(tourRes('a2', ['pano-1'])),
    ];
    const api = { getTourWithConfigs: () => queue.shift()! } as unknown as EditorApi;

    const { result } = renderHook(() => useEditor(api, 'tour-2', 'user-1', null));
    await waitFor(() => expect(result.current.load.status).toBe('ready'));
    await act(async () => {
      await result.current.syncAppended();
    });

    const { docs } = result.current;
    expect(docs!.tour.etag).toBe('b1');
    expect(Object.keys(docs!.scenes)).toEqual(['pano-b']);
  });
});

describe('useEditor autoRepublish', () => {
  const notReady = (panoId: string) =>
    new ApiError(422, {
      error: 'scenes not publishable',
      scenes: [{ panoId, reason: 'not-ready' }],
    });
  const ok = { slug: 's', visibility: 'unlisted', publishedAt: 'x', url: '/s/s' };

  /** An editor whose first publish (Save) hit `not-ready` for p1. */
  async function waiting(publishTour: EditorApi['publishTour']) {
    const api = {
      getTourWithConfigs: async () => tourRes('t1', ['p1']),
      putTour: vi.fn(async () => ({ etag: 't2' })),
      putPanoConfig: async () => ({ etag: 'c2' }),
      publishTour,
    };
    const hook = renderHook(() => useEditor(api as unknown as EditorApi, 'tour-1', 'user-1', null));
    await waitFor(() => expect(hook.result.current.load.status).toBe('ready'));
    act(() => hook.result.current.dispatch({ type: 'tour/title', title: 'Renamed' }));
    await act(() => hook.result.current.save());
    expect(hook.result.current.awaitingTiles).toEqual(['p1']);
    return { ...hook, api };
  }

  it('does nothing unless the last publish waited on tiles', async () => {
    const publishTour = vi.fn(async () => ok);
    const api = {
      getTourWithConfigs: async () => tourRes('t1', ['p1']),
      publishTour,
    } as unknown as EditorApi;
    const { result } = renderHook(() => useEditor(api, 'tour-1', 'user-1', null));
    await waitFor(() => expect(result.current.load.status).toBe('ready'));
    await act(() => result.current.autoRepublish());
    expect(publishTour).not.toHaveBeenCalled();
  });

  it('does not start a second publish while one is out', async () => {
    const out = deferred<typeof ok>();
    const publishTour = vi
      .fn()
      .mockRejectedValueOnce(notReady('p1'))
      .mockReturnValueOnce(out.promise)
      .mockResolvedValue(ok);
    const { result } = await waiting(publishTour);
    let manual!: Promise<void>;
    act(() => {
      manual = result.current.republish();
    });
    await act(() => result.current.autoRepublish());
    expect(publishTour).toHaveBeenCalledTimes(2);
    await act(async () => {
      out.resolve(ok);
      await manual;
    });
    expect(result.current.awaitingTiles).toBeNull();
  });

  it('does not wait again when its own retry finds the same pano still not ready', async () => {
    const publishTour = vi.fn().mockRejectedValue(notReady('p1'));
    const { result } = await waiting(publishTour);
    await act(() => result.current.autoRepublish());
    expect(publishTour).toHaveBeenCalledTimes(2);
    // Not waiting (no loop): the notice offers Try again instead.
    expect(result.current.awaitingTiles).toBeNull();
    const notice = result.current.notices.find((n) => n.id === 'publish');
    expect(notice).toMatchObject({ tone: 'warn', action: 'republish' });
    await act(() => result.current.autoRepublish());
    expect(publishTour).toHaveBeenCalledTimes(2);
  });

  it('a save attempt stops waiting; a failed one keeps it from publishing', async () => {
    const publishTour = vi.fn().mockRejectedValueOnce(notReady('p1')).mockResolvedValue(ok);
    const { result, api } = await waiting(publishTour);
    // A save that fails: no publish, and no automatic one afterwards.
    api.putTour.mockRejectedValueOnce(new ApiError(500, { error: 'boom' }));
    act(() => result.current.dispatch({ type: 'tour/title', title: 'Again' }));
    await act(() => result.current.save());
    expect(api.putTour).toHaveBeenCalledTimes(2);
    expect(result.current.awaitingTiles).toBeNull();
    expect(Object.keys(result.current.failures)).toEqual(['tour']);
    await act(() => result.current.autoRepublish());
    expect(publishTour).toHaveBeenCalledTimes(1);
  });

  it('a publish superseded by a save does not apply its stale result', async () => {
    const autoOut = deferred<typeof ok>();
    let failSave!: (e: unknown) => void;
    const saveOut = new Promise<typeof ok>((_, reject) => (failSave = reject));
    const publishTour = vi
      .fn()
      .mockRejectedValueOnce(notReady('p1'))
      .mockReturnValueOnce(autoOut.promise)
      .mockReturnValueOnce(saveOut);
    const { result, api } = await waiting(publishTour);
    let auto!: Promise<void>;
    act(() => {
      auto = result.current.autoRepublish();
    });
    await waitFor(() => expect(publishTour).toHaveBeenCalledTimes(2));
    // The user saves while that publish is out: the save's PUT waits for it.
    act(() => result.current.dispatch({ type: 'tour/title', title: 'Again' }));
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save();
    });
    expect(result.current.awaitingTiles).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.putTour).toHaveBeenCalledTimes(1);
    await act(async () => {
      autoOut.resolve(ok);
      await auto;
    });
    await waitFor(() => expect(api.putTour).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(publishTour).toHaveBeenCalledTimes(3));
    // The older publish's "up to date" never shows: the save's own publish decides.
    expect(result.current.notices.some((n) => /up to date/.test(n.text))).toBe(false);
    await act(async () => {
      failSave(notReady('p2'));
      await saving;
    });
    expect(result.current.awaitingTiles).toEqual(['p2']);
    expect(result.current.notices.find((n) => n.id === 'publish')?.tone).toBe('info');
  });

  it('does not publish by itself while a sync found a conflict', async () => {
    const queue = [tourRes('t1', ['p1']), tourRes('t9', ['p1', 'p2'], { title: 'Elsewhere' })];
    const publishTour = vi.fn().mockRejectedValueOnce(notReady('p1')).mockResolvedValue(ok);
    const api = {
      getTourWithConfigs: async () => queue.shift() ?? tourRes('t9', ['p1', 'p2']),
      putTour: async () => ({ etag: 't2' }),
      publishTour,
    } as unknown as EditorApi;
    const { result } = renderHook(() => useEditor(api, 'tour-1', 'user-1', null));
    await waitFor(() => expect(result.current.load.status).toBe('ready'));
    act(() => result.current.dispatch({ type: 'tour/title', title: 'Renamed' }));
    await act(() => result.current.save());
    expect(result.current.awaitingTiles).toEqual(['p1']);
    // Edited again, and the tour changed elsewhere: the sync opens a conflict.
    act(() => result.current.dispatch({ type: 'tour/title', title: 'Mine' }));
    await act(() => result.current.syncAppended());
    expect(result.current.conflicts).toEqual(['tour']);
    await act(() => result.current.autoRepublish());
    expect(publishTour).toHaveBeenCalledTimes(1);
  });
});
