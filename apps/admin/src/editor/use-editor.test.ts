import type { TourWithConfigsOk } from '@internal/contracts';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { ApiError } from '@internal/web-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DRAFT_MAX_AGE_MS, draftKey, writeDraft } from './draft.js';
import { editorReducer, fromServer } from './model.js';
import {
  AUTOSAVE_DELAY_MS,
  useEditor,
  type EditorApi,
  type EditorController,
} from './use-editor.js';

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

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
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

    let sync!: Promise<boolean>;
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

    let sync!: Promise<boolean>;
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

  it('resolves false and keeps the loaded tour when the tour is gone', async () => {
    // The tour was deleted elsewhere: the sync GET maps to not-found.
    const queue = [
      Promise.resolve(tourRes('t1', ['pano-1'])),
      Promise.resolve({ status: 'not-found' }),
    ];
    const api = { getTourWithConfigs: () => queue.shift()! } as unknown as EditorApi;

    const { result } = renderHook(() => useEditor(api, 'tour-1', 'user-1', null));
    await waitFor(() => expect(result.current.load.status).toBe('ready'));
    let synced: boolean | undefined;
    await act(async () => {
      synced = await result.current.syncAppended();
    });

    expect(synced).toBe(false);
    const { docs } = result.current;
    expect(docs!.tour.etag).toBe('t1');
    expect(Object.keys(docs!.scenes)).toEqual(['pano-1']);
    expect(result.current.conflicts).toEqual([]);
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

describe('useEditor and a tour whose owner stopped sharing', () => {
  const live = { slug: 's', visibility: 'unlisted' as const, publishedAt: 'x' };
  const stopped = new ApiError(409, { error: 'sharing stopped' });

  const setup = (publishTour: EditorApi['publishTour'], publish: typeof live | null = live) => {
    const res = tourRes('t1', ['p1']);
    const api = {
      getTourWithConfigs: async () => ({ ...res, data: { ...res.data, publish } }),
      putTour: async () => ({ etag: 't2' }),
      publishTour,
    } as unknown as EditorApi;
    return renderHook(() => useEditor(api, 'tour-1', 'user-1', null));
  };

  it('Save asks for an after-Save publish, and a refusal leaves the tour offline', async () => {
    const publishTour = vi.fn().mockRejectedValue(stopped);
    const { result } = setup(publishTour);
    await waitFor(() => expect(result.current.load.status).toBe('ready'));
    expect(result.current.publish).toEqual(live);
    act(() => result.current.dispatch({ type: 'tour/title', title: 'Renamed' }));
    await act(() => result.current.save());

    expect(publishTour).toHaveBeenCalledWith('tour-1', { afterSave: true });
    expect(result.current.publish).toBeNull();
    expect(result.current.dirty).toEqual([]);
    // It was live as far as this editor knew: say why the link didn't update.
    const notice = result.current.notices.find((n) => n.id === 'publish');
    expect(notice?.text).toMatch(/Sharing is off/);
    expect(notice?.tone).toBe('info');
  });

  it('says nothing when the editor already knew it was offline', async () => {
    const publishTour = vi.fn().mockRejectedValue(stopped);
    const { result } = setup(publishTour, null);
    await waitFor(() => expect(result.current.load.status).toBe('ready'));
    act(() => result.current.dispatch({ type: 'tour/title', title: 'Renamed' }));
    await act(() => result.current.save());
    expect(result.current.notices.find((n) => n.id === 'publish')).toBeUndefined();
  });

  it('follows the share modal: stopping and sharing again update the publish state', async () => {
    const { result } = setup(vi.fn());
    await waitFor(() => expect(result.current.load.status).toBe('ready'));
    act(() => result.current.setShared(null));
    expect(result.current.publish).toBeNull();
    act(() => result.current.setShared({ ...live, slug: 'back' }));
    expect(result.current.publish).toEqual({ ...live, slug: 'back' });
  });
});

describe('useEditor save after a 429 partway', () => {
  it('keeps the refused docs dirty, and Save again sends only those and completes', async () => {
    const rateLimited = new ApiError(429, { error: 'rate limited' });
    const putPanoConfig = vi
      .fn()
      .mockResolvedValueOnce({ etag: 'c-pano-1-v2' })
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce({ etag: 'c-pano-2-v2' });
    const putTour = vi
      .fn()
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce({ etag: 't2' });
    const publishTour = vi.fn(async () => ({
      slug: 's',
      visibility: 'unlisted',
      publishedAt: 'x',
    }));
    const api = {
      getTourWithConfigs: async () => tourRes('t1', ['pano-1', 'pano-2']),
      putPanoConfig,
      putTour,
      publishTour,
    } as unknown as EditorApi;

    const { result } = renderHook(() => useEditor(api, 'tour-1', 'user-1', null));
    await waitFor(() => expect(result.current.load.status).toBe('ready'));
    act(() => {
      result.current.dispatch({ type: 'scene/title', panoId: 'pano-1', title: 'One' });
      result.current.dispatch({ type: 'scene/title', panoId: 'pano-2', title: 'Two' });
      result.current.dispatch({ type: 'tour/title', title: 'Renamed' });
    });
    await act(() => result.current.save());
    // pano-1 landed; pano-2 and the tour were refused and stay dirty. Nothing published.
    expect(putPanoConfig).toHaveBeenCalledTimes(2);
    expect(publishTour).not.toHaveBeenCalled();
    expect(result.current.conflicts).toEqual([]);
    expect([...result.current.dirty].sort()).toEqual(['pano:pano-2', 'tour'].sort());

    await act(() => result.current.save());
    expect(putPanoConfig).toHaveBeenCalledTimes(3);
    expect(putPanoConfig).toHaveBeenLastCalledWith(
      'pano-2',
      expect.objectContaining({ title: 'Two' }),
      'c-pano-2',
    );
    expect(putTour).toHaveBeenLastCalledWith(
      'tour-1',
      expect.objectContaining({ title: 'Renamed' }),
      't1',
    );
    expect(result.current.dirty).toEqual([]);
    expect(publishTour).toHaveBeenCalledTimes(1);
  });
});

describe('useEditor draft autosave', () => {
  const USER = 'user-1';
  const KEY = draftKey(USER, 'tour-1');

  const memoryStorage = () => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: vi.fn((k: string) => map.get(k) ?? null),
      setItem: vi.fn((k: string, v: string) => void map.set(k, v)),
      removeItem: vi.fn((k: string) => void map.delete(k)),
    };
  };
  type MemoryStorage = ReturnType<typeof memoryStorage>;

  const stored = (storage: MemoryStorage) => {
    const raw = storage.map.get(KEY);
    return raw ? (JSON.parse(raw) as { tour: { etag: string; doc: { title: string } } }) : null;
  };

  /** A draft of a renamed tour, taken against tour ETag `etag`. */
  const parkDraft = (storage: MemoryStorage, etag = 't1', savedAt = new Date()) => {
    const docs = editorReducer(fromServer(tourRes(etag, ['p1']).data), {
      type: 'tour/title',
      title: 'Draft title',
    })!;
    writeDraft(storage, USER, docs, savedAt);
  };

  const setup = async (storage: MemoryStorage, serverEtag = 't1') => {
    const api = {
      getTourWithConfigs: vi.fn(async () => tourRes(serverEtag, ['p1'])),
      putTour: vi.fn(async () => ({ etag: 't9' })),
      publishTour: vi.fn(async () => ({ slug: 's', visibility: 'unlisted', publishedAt: 'x' })),
    };
    const hook = renderHook(() => useEditor(api as unknown as EditorApi, 'tour-1', USER, storage));
    await waitFor(() => expect(hook.result.current.load.status).toBe('ready'));
    return { ...hook, api };
  };

  const rename = (r: { current: EditorController }, title: string) =>
    act(() => r.current.dispatch({ type: 'tour/title', title }));

  const setVisibility = (state: DocumentVisibilityState) =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('writes the draft once, a second after the last edit', async () => {
    const storage = memoryStorage();
    const { result } = await setup(storage);
    vi.useFakeTimers();
    rename(result, 'One');
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 100));
    rename(result, 'Two');
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 100));
    expect(storage.setItem).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(stored(storage)?.tour).toMatchObject({ etag: 't1', doc: { title: 'Two' } });
  });

  it('writes at once when the page is hidden or unloaded', async () => {
    const storage = memoryStorage();
    const { result } = await setup(storage);
    rename(result, 'Hidden');
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(stored(storage)?.tour.doc.title).toBe('Hidden');

    rename(result, 'Gone');
    window.dispatchEvent(new Event('pagehide'));
    expect(stored(storage)?.tour.doc.title).toBe('Gone');
  });

  it('writes nothing while there are no unsaved edits', async () => {
    const storage = memoryStorage();
    await setup(storage);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('restores a stored draft on load, says so, and keeps it stored until saved', async () => {
    const storage = memoryStorage();
    parkDraft(storage);
    const { result } = await setup(storage);
    expect(result.current.docs?.tour.current.title).toBe('Draft title');
    expect(result.current.dirty).toEqual(['tour']);
    expect(result.current.conflicts).toEqual([]);
    expect(result.current.notices).toContainEqual(
      expect.objectContaining({ id: 'draft', action: 'discard-draft' }),
    );
    expect(stored(storage)?.tour.doc.title).toBe('Draft title');
  });

  it('clears the draft after a successful save', async () => {
    const storage = memoryStorage();
    const { result, api } = await setup(storage);
    rename(result, 'Saved title');
    window.dispatchEvent(new Event('pagehide'));
    expect(stored(storage)).not.toBeNull();
    await act(() => result.current.save());
    expect(api.putTour).toHaveBeenCalled();
    expect(storage.map.has(KEY)).toBe(false);
  });

  it('Discard drops the restored edits, reloads the saved tour and clears the draft', async () => {
    const storage = memoryStorage();
    parkDraft(storage);
    const { result, api } = await setup(storage);
    await act(() => result.current.discardDraft());
    expect(api.getTourWithConfigs).toHaveBeenCalledTimes(2);
    expect(result.current.docs?.tour.current.title).toBe('Town hall');
    expect(result.current.dirty).toEqual([]);
    expect(result.current.notices.find((n) => n.id === 'draft')).toBeUndefined();
    expect(storage.map.has(KEY)).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
    expect(storage.map.has(KEY)).toBe(false);
  });

  it('leaving without saving drops the draft and autosave stops until the next edit', async () => {
    const storage = memoryStorage();
    const { result } = await setup(storage);
    rename(result, 'Abandoned');
    window.dispatchEvent(new Event('pagehide'));
    act(() => result.current.forgetDraft());
    expect(storage.map.has(KEY)).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
    expect(storage.map.has(KEY)).toBe(false);
    rename(result, 'Back again');
    window.dispatchEvent(new Event('pagehide'));
    expect(stored(storage)?.tour.doc.title).toBe('Back again');
  });

  it('drops a draft older than a week instead of restoring it', async () => {
    const storage = memoryStorage();
    parkDraft(storage, 't1', new Date(Date.now() - DRAFT_MAX_AGE_MS - 60_000));
    const { result } = await setup(storage);
    expect(result.current.docs?.tour.current.title).toBe('Town hall');
    expect(result.current.notices).toEqual([]);
    expect(storage.map.has(KEY)).toBe(false);
  });

  it('opens the conflict banner when the server copy changed since the draft', async () => {
    const storage = memoryStorage();
    parkDraft(storage, 't1');
    const { result } = await setup(storage, 't2');
    expect(result.current.docs?.tour.current.title).toBe('Draft title');
    expect(result.current.conflicts).toEqual(['tour']);
    expect(result.current.notices.map((n) => n.id)).toContain('draft');
    // Save is blocked until the banner's Reload or Overwrite: nothing is overwritten.
    await act(() => result.current.save());
    expect(result.current.saving).toBe(false);
    expect(result.current.dirty).toEqual(['tour']);
  });

  it('keeps editing when storage refuses every write', async () => {
    const storage = memoryStorage();
    storage.setItem.mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const { result } = await setup(storage);
    vi.useFakeTimers();
    rename(result, 'Still editing');
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    window.dispatchEvent(new Event('pagehide'));
    expect(storage.setItem).toHaveBeenCalled();
    expect(result.current.docs?.tour.current.title).toBe('Still editing');
  });
});
