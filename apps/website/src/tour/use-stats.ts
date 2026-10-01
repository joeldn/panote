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

  useEffect(() => {
    if (recorded.current === tourId) return;
    recorded.current = tourId;
    // No cleanup guard: under StrictMode the second run returns early and must still see this.
    api
      .recordView(tourId, firstView.current)
      .catch(() => api.getStats(tourId))
      .then(setStats, () => {});
  }, [api, tourId]);

  const like = useCallback(() => {
    if (liked) return;
    setLiked(true);
    api.like(tourId).then(
      (s) => {
        rememberLike(tourId);
        setStats(s);
      },
      () => setLiked(false),
    );
  }, [api, liked, tourId]);

  return { stats, liked, like };
}
