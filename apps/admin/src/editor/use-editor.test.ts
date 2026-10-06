import type { TourWithConfigsOk } from '@internal/contracts';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

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
