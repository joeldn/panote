import type { AdminApi, FetchLike } from '@internal/web-kit';
import { isAuthError, refreshManifestCache } from '@internal/web-kit';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PolledTiling } from './scene-status.js';

/** How often a pano that is still tiling is checked. */
export const WATCH_POLL_MS = 10_000;
/** How often once it's taking longer than usual. */
export const WATCH_SLOW_POLL_MS = 30_000;
/** Pending this long after the editor started watching: shown as taking longer than usual. */
export const WATCH_TIMEOUT_MS = 10 * 60_000;
/** Pending this long: the editor stops checking until the user asks it to. */
export const WATCH_GIVE_UP_MS = 60 * 60_000;

interface Watch {
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The loop is live: a request is out or the next one is scheduled. */
  active: boolean;
  /** Bumped on every start and stop: a response for an older run is dropped. */
  run: number;
}

export interface TilingWatch {
  /** The last status poll per pano, for panos the editor has watched. */
  polled: Record<string, PolledTiling>;
  /** A pano that turned ready while watched: `PanoStage`'s `reloadKey`, to load its tiles. */
  reloadKeys: Record<string, string>;
  /** Start over on a pano that timed out (the overlay's Check again). */
  checkAgain(panoId: string): void;
  /** Drop what is known about a pano: an upload in this tab speaks for it now. */
  forget(panoId: string): void;
}

const settled = (p: PolledTiling | undefined): boolean =>
  p?.state === 'ready' || p?.state === 'failed' || (p?.state === 'timed-out' && !p.checking);

/**
 * Polls `GET /api/admin/panos/:id?status=1` for each of `targets` (scenes whose tiles
 * aren't ready and that no upload in this tab is watching) until each is ready or
 * failed, or has been pending for `WATCH_GIVE_UP_MS`. A pano that turns ready gets
 * its CDN manifest refreshed and a reload key, so the stage loads its tiles.
 */
export function useTilingWatch(opts: {
  api: Pick<AdminApi, 'getPanoStatus'>;
  targets: readonly string[];
  tilesBase: string;
  fetch?: FetchLike | undefined;
}): TilingWatch {
  const { api, targets, tilesBase, fetch } = opts;
  const [polled, setPolled] = useState<Record<string, PolledTiling>>({});
  const polledRef = useRef(polled);
  const [reloadKeys, setReloadKeys] = useState<Record<string, string>>({});
  const watches = useRef(new Map<string, Watch>());
  const live = useRef({ api, tilesBase, fetch });
  useEffect(() => {
    live.current = { api, tilesBase, fetch };
  });

  const put = useCallback((panoId: string, p: PolledTiling | null) => {
    const next = { ...polledRef.current };
    if (p) next[panoId] = p;
    else delete next[panoId];
    polledRef.current = next;
    setPolled(next);
  }, []);

  const stop = useCallback((panoId: string) => {
    const w = watches.current.get(panoId);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = null;
    w.active = false;
    w.run++;
  }, []);

  const start = useCallback(
    (panoId: string) => {
      const prev = watches.current.get(panoId);
      if (prev?.timer) clearTimeout(prev.timer);
      const w: Watch = {
        startedAt: Date.now(),
        timer: null,
        active: true,
        run: (prev?.run ?? 0) + 1,
      };
      watches.current.set(panoId, w);
      const run = w.run;
      const current = () => watches.current.get(panoId) === w && w.run === run;
      const done = (p: PolledTiling | null) => {
        w.active = false;
        if (p) put(panoId, p);
      };
      const later = (ms: number) => {
        w.timer = setTimeout(() => {
          w.timer = null;
          void tick();
        }, ms);
      };
      const tick = async () => {
        const elapsed = Date.now() - w.startedAt;
        let tiling: string;
        let version: string | undefined;
        try {
          const status = await live.current.api.getPanoStatus(panoId);
          tiling = status.tiling;
          version = status.manifest?.version;
        } catch (e) {
          if (!current()) return;
          // Signed out: nothing more to learn until the user signs in again.
          if (isAuthError(e)) {
            done(null);
            return;
          }
          later(elapsed > WATCH_TIMEOUT_MS ? WATCH_SLOW_POLL_MS : WATCH_POLL_MS);
          return;
        }
        if (!current()) return;
        if (tiling === 'ready') {
          const { tilesBase: base, fetch: f } = live.current;
          // The CDN may still hold the 404 the stage got before the tiles existed.
          await refreshManifestCache(base, panoId, f ? { fetch: f } : {}).catch(() => {});
          if (!current()) return;
          done({ state: 'ready' });
          setReloadKeys((r) => ({ ...r, [panoId]: version ?? `ready-${Date.now()}` }));
          return;
        }
        // 'none': the image itself is gone, so no tiles are coming.
        if (tiling === 'failed' || tiling === 'none') {
          done({ state: 'failed' });
          return;
        }
        if (elapsed >= WATCH_GIVE_UP_MS) {
          done({ state: 'timed-out', checking: false });
          return;
        }
        if (elapsed >= WATCH_TIMEOUT_MS) {
          put(panoId, { state: 'timed-out', checking: true });
          later(WATCH_SLOW_POLL_MS);
          return;
        }
        put(panoId, { state: 'pending' });
        later(WATCH_POLL_MS);
      };
      void tick();
    },
    [put],
  );

  const targetKey = targets.join('\n');
  useEffect(() => {
    const wanted = new Set(targetKey ? targetKey.split('\n') : []);
    for (const panoId of wanted) {
      const w = watches.current.get(panoId);
      if (!w?.active && !settled(polledRef.current[panoId])) start(panoId);
    }
    for (const [panoId, w] of watches.current) {
      if (!wanted.has(panoId) && w.active) stop(panoId);
    }
  }, [targetKey, start, stop]);

  // Unmount: no timer or response outlives the editor.
  useEffect(() => {
    const all = watches.current;
    return () => {
      for (const w of all.values()) {
        if (w.timer) clearTimeout(w.timer);
        w.active = false;
        w.run++;
      }
      all.clear();
    };
  }, []);

  const checkAgain = useCallback(
    (panoId: string) => {
      put(panoId, null);
      start(panoId);
    },
    [put, start],
  );

  const forget = useCallback(
    (panoId: string) => {
      stop(panoId);
      watches.current.delete(panoId);
      if (polledRef.current[panoId]) put(panoId, null);
    },
    [stop, put],
  );

  return { polled, reloadKeys, checkAgain, forget };
}
