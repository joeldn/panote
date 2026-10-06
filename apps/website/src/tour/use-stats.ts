import type { ViewBeacon } from '@internal/contracts';
import { createPublicApi, type TourStats } from '@internal/web-kit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useConfig } from '../config-context.js';
import { clientId, hasLiked, rememberLike } from './identity.js';

export interface TourStatsState {
  stats: TourStats | null;
  liked: boolean;
  like: () => void;
}

/**
 * Records one view per mounted tour (with the first shown scene and surface, read
 * once), then exposes the counts and the like action.
 */
export function useTourStats(tourId: string, view?: ViewBeacon): TourStatsState {
  const { apiBase } = useConfig();
  const api = useMemo(() => createPublicApi({ baseUrl: apiBase, clientId }), [apiBase]);
  const [stats, setStats] = useState<TourStats | null>(null);
  const [liked, setLiked] = useState(() => hasLiked(tourId));
  // StrictMode runs effects twice on the same instance; the ref keeps it to one view.
  const recorded = useRef<string | null>(null);
  const firstView = useRef(view);
  // Requests are numbered as they start, and a response older than the last one applied is
  // dropped, so a slow view POST can't undo the likes from a like that landed before it.
  const sent = useRef(0);
  const applied = useRef(0);
  const applyFrom = useCallback((seq: number) => {
    return (s: TourStats) => {
      if (seq < applied.current) return;
      applied.current = seq;
      setStats(s);
    };
  }, []);

  useEffect(() => {
    if (recorded.current === tourId) return;
    recorded.current = tourId;
    const apply = applyFrom(++sent.current);
    // No cleanup guard: under StrictMode the second run returns early and must still see this.
    api
      .recordView(tourId, firstView.current)
      .catch(() => api.getStats(tourId))
      .then(apply, () => {});
  }, [api, applyFrom, tourId]);

  const like = useCallback(() => {
    if (liked) return;
    setLiked(true);
    const apply = applyFrom(++sent.current);
    api.like(tourId).then(
      (s) => {
        rememberLike(tourId);
        apply(s);
      },
      () => setLiked(false),
    );
  }, [api, applyFrom, liked, tourId]);

  return { stats, liked, like };
}
