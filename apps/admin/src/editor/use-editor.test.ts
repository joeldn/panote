import type { TourWithConfigsOk } from '@internal/contracts';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useEditor, type EditorApi } from './use-editor.js';

type TourRes = { status: 'ok'; data: TourWithConfigsOk };

const tourRes = (etag: string, panoIds: string[]): TourRes => ({
  status: 'ok',
  data: {
    tour: { tourId: 'tour-1', title: 'Town hall', scenes: panoIds.map((panoId) => ({ panoId })) },
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
});
