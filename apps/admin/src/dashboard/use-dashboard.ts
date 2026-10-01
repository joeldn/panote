import type { PanoSummary, TourSummary, Visibility } from './types.js';
import {
  ApiError,
  isAuthError,
  type AdminApi,
  type PublicApi,
  type TourDocInput,
} from '@internal/web-kit';
import { useCallback, useEffect, useRef, useState } from 'react';

const PAGE_LIMIT = 100;
// Bounds a runaway cursor loop; 50 pages of 100 is far beyond any real library.
const MAX_PAGES = 50;
const STATS_CONCURRENCY = 6;
const MAX_TITLE = 200;
const COPY_SUFFIX = ' (copy)';

type Page<T> = { items: T[]; cursor: string | null };

async function listAll<T>(page: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await page(cursor);
    out.push(...res.items);
    if (!res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}

const query = (cursor: string | undefined) => ({
  limit: PAGE_LIMIT,
  ...(cursor !== undefined ? { cursor } : {}),
});

const listAllTours = (api: AdminApi) =>
  listAll(async (c) => {
    const r = await api.listTours(query(c));
    return { items: r.tours, cursor: r.cursor };
  });

const listAllPanos = (api: AdminApi) =>
  listAll(async (c) => {
    const r = await api.listPanos(query(c));
    return { items: r.panos, cursor: r.cursor };
  });

const byNewest = (a: TourSummary, b: TourSummary) => b.updatedAt.localeCompare(a.updatedAt);

const isStatus = (e: unknown, status: number) => e instanceof ApiError && e.status === status;

const errorText = (e: unknown): string | undefined =>
  e instanceof ApiError && typeof e.body === 'object' && e.body !== null && 'error' in e.body
    ? String((e.body as { error: unknown }).error)
    : undefined;

export function copyTitle(title: string): string {
  return `${title.slice(0, MAX_TITLE - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
}

/** What the confirm modal shows when a tour delete fails; the modal stays open to retry. */
export function deleteErrorMessage(e: unknown): string {
  if (isAuthError(e)) return 'Your session ended. Sign in again, then retry.';
  if (isStatus(e, 409)) {
    return 'This tour is being changed somewhere else right now. Wait a moment and try again.';
  }
  if (isStatus(e, 412)) return 'This tour changed while it was being deleted. Try again.';
  return 'Couldn’t delete the tour. Check your connection and try again.';
}

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface Dashboard {
  status: LoadStatus;
  tours: TourSummary[];
  /** Live panos by id (tombstoned ones excluded); null until loaded or if the list failed. */
  panos: ReadonlyMap<string, PanoSummary> | null;
  /** Views per tour: absent while loading, null when the stats call failed. */
  views: Readonly<Record<string, number | null>>;
  /** Tombstoned panos whose interrupted delete is being re-issued. */
  resuming: readonly string[];
  /** Tombstoned panos whose resumed delete failed; `finishDeleting` retries them. */
  stuck: readonly string[];
  notice: string | null;
  dismissNotice(): void;
  reload(): void;
  finishDeleting(): Promise<void>;
  setVisibility(tour: TourSummary, visibility: Visibility): Promise<void>;
  duplicate(tour: TourSummary): Promise<void>;
  /** Rejects with a user-facing message; a 404 counts as already deleted. */
  deleteTour(tour: TourSummary): Promise<void>;
}

export function useDashboard(api: AdminApi, publicApi: PublicApi): Dashboard {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [tours, setTours] = useState<TourSummary[]>([]);
  const [panos, setPanos] = useState<ReadonlyMap<string, PanoSummary> | null>(null);
  const [views, setViews] = useState<Record<string, number | null>>({});
  const [resuming, setResuming] = useState<string[]>([]);
  const [stuck, setStuck] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Each tombstone is resumed automatically at most once per page load (plan 3.1).
  const resumed = useRef(new Set<string>());
  const statsRequested = useRef(new Set<string>());

  const resumeDeletes = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setStuck((s) => s.filter((id) => !ids.includes(id)));
      setResuming((r) => [...r, ...ids.filter((id) => !r.includes(id))]);
      const results = await Promise.allSettled(ids.map((id) => api.deletePano(id)));
      const failed = ids.filter((_, i) => {
        const r = results[i];
        return r?.status === 'rejected' && !isStatus(r.reason, 404);
      });
      setResuming((r) => r.filter((id) => !ids.includes(id)));
      setStuck((s) => [...s, ...failed.filter((id) => !s.includes(id))]);
    },
    [api],
  );

  const applyPanos = useCallback(
    (list: PanoSummary[]) => {
      setPanos(new Map(list.filter((p) => !p.deleting).map((p) => [p.panoId, p])));
      const fresh = list
        .filter((p) => p.deleting && !resumed.current.has(p.panoId))
        .map((p) => p.panoId);
      fresh.forEach((id) => resumed.current.add(id));
      void resumeDeletes(fresh);
    },
    [resumeDeletes],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [tourRes, panoRes] = await Promise.allSettled([listAllTours(api), listAllPanos(api)]);
      if (cancelled) return;
      if (panoRes.status === 'fulfilled') applyPanos(panoRes.value);
      if (tourRes.status === 'rejected') {
        setStatus('error');
        return;
      }
      setTours([...tourRes.value].sort(byNewest));
      setStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [api, applyPanos, reloadKey]);

  // Views per card from the public stats route; never cancelled, so StrictMode keeps them.
  useEffect(() => {
    const queue = tours.map((t) => t.tourId).filter((id) => !statsRequested.current.has(id));
    queue.forEach((id) => statsRequested.current.add(id));
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const tourId = id;
        const count = await publicApi.getStats(tourId).then(
          (s) => s.views,
          () => null,
        );
        setViews((v) => ({ ...v, [tourId]: count }));
      }
    };
    for (let i = 0; i < Math.min(STATS_CONCURRENCY, queue.length); i++) void worker();
  }, [tours, publicApi]);

  const removeTour = (tourId: string) => setTours((ts) => ts.filter((t) => t.tourId !== tourId));

  const refreshTours = useCallback(async () => {
    try {
      setTours([...(await listAllTours(api))].sort(byNewest));
    } catch {
      setNotice('Couldn’t refresh your tours. Reload the page to see the latest.');
    }
  }, [api]);

  const refreshPanos = useCallback(async () => {
    try {
      applyPanos(await listAllPanos(api));
    } catch {
      // Covers keep their last state; the next reload catches up.
    }
  }, [api, applyPanos]);

  const setVisibility = useCallback(
    async (tour: TourSummary, visibility: Visibility) => {
      const previous = tour.publish;
      if (!previous || previous.visibility === visibility) return;
      const patch = (publish: TourSummary['publish']) =>
        setTours((ts) => ts.map((t) => (t.tourId === tour.tourId ? { ...t, publish } : t)));
      patch({ ...previous, visibility });
      try {
        const res = await api.setVisibility(tour.tourId, visibility);
        patch({ ...previous, visibility: res.visibility });
      } catch (e) {
        if (isStatus(e, 404)) {
          removeTour(tour.tourId);
          setNotice(`“${tour.title}” no longer exists.`);
        } else if (isStatus(e, 409) && errorText(e) === 'not published') {
          patch(null);
          setNotice(`“${tour.title}” isn’t shared yet. Save it in the editor to get a link.`);
        } else {
          patch(previous);
          setNotice(`Couldn’t change who can see “${tour.title}”. Try again.`);
        }
      }
    },
    [api],
  );

  const duplicate = useCallback(
    async (tour: TourSummary) => {
      try {
        const res = await api.getTour(tour.tourId);
        if (res.status === 'not-found') {
          removeTour(tour.tourId);
          setNotice(`“${tour.title}” no longer exists.`);
          return;
        }
        if (res.status !== 'ok') throw new Error('unexpected not-modified');
        // POST mints a fresh tourId; publish state lives in publish.json, so it isn't copied.
        const doc: TourDocInput = { ...res.data.tour, title: copyTitle(res.data.tour.title) };
        delete doc.tourId;
        await api.createTour(doc);
      } catch {
        setNotice(`Couldn’t duplicate “${tour.title}”. Try again.`);
        return;
      }
      await refreshTours();
    },
    [api, refreshTours],
  );

  const deleteTour = useCallback(
    async (tour: TourSummary) => {
      try {
        await api.deleteTour(tour.tourId);
      } catch (e) {
        if (!isStatus(e, 404)) throw new Error(deleteErrorMessage(e), { cause: e });
      }
      removeTour(tour.tourId);
      // The server also deleted panos no other tour used.
      void refreshPanos();
    },
    [api, refreshPanos],
  );

  return {
    status,
    tours,
    panos,
    views,
    resuming,
    stuck,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    reload: useCallback(() => {
      setStatus('loading');
      setReloadKey((k) => k + 1);
    }, []),
    finishDeleting: useCallback(() => resumeDeletes([...stuck]), [resumeDeletes, stuck]),
    setVisibility,
    duplicate,
    deleteTour,
  };
}
