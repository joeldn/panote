import {
  AnalyticsEventSchema,
  MAX_EVENTS_PER_BATCH,
  type AnalyticsEvent,
  type AnalyticsSurface,
} from '@internal/contracts';
import { useEffect, useMemo } from 'react';

import { useConfig } from '../config-context.js';

// The viewer analytics beacon (docs/wave6-plan.md 3.3): scene, hotspot and dwell
// events batched to public-api's /events ingest. Content ids only, no client id.

export type ViewerEvent =
  { type: 'scene'; panoId: string } | { type: 'hotspot'; panoId: string; hotspotId: string };

export type BeaconSend = (url: string, body: string) => void;

/** sendBeacon (a text/plain string, no preflight), else a keepalive fetch without cookies. */
export const sendBeaconOrFetch: BeaconSend = (url, body) => {
  try {
    if (navigator.sendBeacon?.(url, body)) return;
  } catch {
    // Some browsers throw instead of returning false (e.g. over the queue quota).
  }
  globalThis
    .fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit' })
    .catch(() => {});
};

export interface ViewerBeaconOptions {
  /** API origin without a trailing slash; `''` is same-origin. */
  baseUrl: string;
  tourId: string;
  surface: AnalyticsSurface;
  send?: BeaconSend;
  now?: () => number;
  /** How long a scene/hotspot event may wait for others before its batch is sent. */
  flushDelayMs?: number;
}

export interface ViewerBeacon {
  track(event: ViewerEvent): void;
  /** Starts dwell timing and the hidden/pagehide listeners; call once a scene is shown. */
  attach(): void;
  /** Ends the dwell segment, sends everything queued and removes the listeners. */
  detach(): void;
  flush(): void;
}

export function createViewerBeacon(opts: ViewerBeaconOptions): ViewerBeacon {
  const send = opts.send ?? sendBeaconOrFetch;
  const now = opts.now ?? (() => performance.now());
  const delay = opts.flushDelayMs ?? 5000;
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/tours/${encodeURIComponent(opts.tourId)}/events`;
  let queue: AnalyticsEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attached = false;
  let visibleSince: number | null = null;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    while (queue.length > 0) {
      send(url, JSON.stringify({ events: queue.slice(0, MAX_EVENTS_PER_BATCH) }));
      queue = queue.slice(MAX_EVENTS_PER_BATCH);
    }
  };

  // Invalid events (e.g. a hotspot id outside [A-Za-z0-9_-]{1,64}) are dropped
  // here, since one bad event would make public-api 400 the whole batch.
  const push = (event: AnalyticsEvent) => {
    const parsed = AnalyticsEventSchema.safeParse(event);
    if (!parsed.success) return;
    queue.push(parsed.data);
    if (queue.length >= MAX_EVENTS_PER_BATCH) flush();
    else timer ??= setTimeout(flush, delay);
  };

  const startDwell = () => {
    if (attached && visibleSince === null && document.visibilityState === 'visible') {
      visibleSince = now();
    }
  };
  const endDwell = () => {
    if (visibleSince === null) return;
    const ms = Math.round(now() - visibleSince);
    visibleSince = null;
    if (ms > 0) push({ type: 'dwell', ms, surface: opts.surface });
  };
  const onHide = () => {
    endDwell();
    flush();
  };
  const onVisibility = () => (document.visibilityState === 'hidden' ? onHide() : startDwell());

  return {
    track: (event) => push({ ...event, surface: opts.surface }),
    attach() {
      if (attached) return;
      attached = true;
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', onHide);
      window.addEventListener('pageshow', startDwell);
      startDwell();
    },
    detach() {
      if (!attached) return;
      onHide();
      attached = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', startDwell);
    },
    flush,
  };
}

/** One beacon per mounted tour; dwell only runs once `shown` (a scene is on screen). */
export function useViewerAnalytics(
  tourId: string,
  surface: AnalyticsSurface,
  shown: boolean,
): ViewerBeacon['track'] {
  const { apiBase } = useConfig();
  const beacon = useMemo(
    () => createViewerBeacon({ baseUrl: apiBase, tourId, surface }),
    [apiBase, tourId, surface],
  );
  useEffect(() => {
    if (!shown) return;
    beacon.attach();
    return () => beacon.detach();
  }, [beacon, shown]);
  return beacon.track;
}
