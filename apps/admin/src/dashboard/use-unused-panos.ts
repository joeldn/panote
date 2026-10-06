import type { PanoSummary } from './types.js';
import { isAuthError, panoDeleteErrorOf, type AdminApi } from '@internal/web-kit';
import { useCallback, useEffect, useState } from 'react';

import { listAllPanos, type LoadStatus } from './use-dashboard.js';

/** Unused = the server says no tour of the owner has a scene on it. Unknown never counts. */
export const isUnused = (p: PanoSummary): boolean => p.referenced === false && !p.deleting;

/** Still tiling; the server refuses to delete it until it's ready (or clearly stalled). */
export const isProcessing = (p: PanoSummary): boolean => p.tiling === 'pending';

export const panoTitle = (p: PanoSummary): string => p.title ?? 'Untitled pano';

export interface UnusedPanos {
  status: LoadStatus;
  panos: PanoSummary[];
  notice: string | null;
  dismissNotice(): void;
  reload(): void;
  /** Resolves once the pano is gone or was kept because a tour uses it again
   * (a notice says so); rejects with a message to show in the confirm modal. */
  deletePano(pano: PanoSummary): Promise<void>;
}

export function deletePanoErrorMessage(e: unknown): string {
  if (isAuthError(e)) return 'Your session ended. Sign in again, then retry.';
  switch (panoDeleteErrorOf(e)) {
    case 'processing':
      return 'This pano is still processing. Try again once it’s ready.';
    case 'recent':
      return 'This pano was uploaded less than an hour ago, so it may still be joining a tour. Try again later.';
    default:
      return 'Couldn’t delete the pano. Check your connection and try again.';
  }
}

export function useUnusedPanos(api: AdminApi): UnusedPanos {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [panos, setPanos] = useState<PanoSummary[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listAllPanos(api, true).then(
      (list) => {
        if (cancelled) return;
        setPanos(list.filter(isUnused).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        setStatus('ready');
      },
      () => {
        if (!cancelled) setStatus('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, reloadKey]);

  const remove = (panoId: string) => setPanos((ps) => ps.filter((p) => p.panoId !== panoId));

  const deletePano = useCallback(
    async (pano: PanoSummary) => {
      try {
        await api.deletePano(pano.panoId);
      } catch (e) {
        const reason = panoDeleteErrorOf(e);
        if (reason === 'in-use') {
          // A tour started using it since the list loaded; the server kept it.
          remove(pano.panoId);
          setNotice(`“${panoTitle(pano)}” is used by a tour now, so it was kept.`);
          return;
        }
        if (reason !== 'not-found') throw new Error(deletePanoErrorMessage(e), { cause: e });
      }
      remove(pano.panoId);
    },
    [api],
  );

  return {
    status,
    panos,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    reload: useCallback(() => {
      setStatus('loading');
      setReloadKey((k) => k + 1);
    }, []),
    deletePano,
  };
}
