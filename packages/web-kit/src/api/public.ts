import { ManifestSchema, PANO_PATTERN, type Manifest } from '@internal/contracts';
import { manifestUrl } from '@panote/core';
import { z } from 'zod';

import { ApiError, parseWith, readJson, type FetchLike } from './http.js';

// Mirrors the TourStats DO's `Counts` (services/public-api/src/stats.ts).
export const TourStatsSchema = z.object({
  views: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
});
export type TourStats = z.infer<typeof TourStatsSchema>;

export interface PublicApiOptions {
  /** API origin; `''` (default) is same-origin. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Anonymous like identity (`X-Client-Id`), typically a UUID kept in localStorage. */
  clientId?: () => string;
}

export interface PublicApi {
  getStats(tourId: string): Promise<TourStats>;
  recordView(tourId: string): Promise<TourStats>;
  like(tourId: string): Promise<TourStats>;
}

const tourPath = (tourId: string, rest: string): string => {
  if (!PANO_PATTERN.test(tourId)) throw new TypeError(`tourId must match ${PANO_PATTERN}`);
  return `/api/tours/${tourId}/${rest}`;
};

export function createPublicApi(opts: PublicApiOptions = {}): PublicApi {
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function call(path: string, init: RequestInit): Promise<TourStats> {
    const url = `${base}${path}`;
    const res = await doFetch(url, init);
    const body = await readJson(res);
    if (!res.ok) throw new ApiError(res.status, body);
    return parseWith(TourStatsSchema, url, body);
  }

  return {
    getStats: async (tourId) => call(tourPath(tourId, 'stats'), { method: 'GET' }),
    recordView: async (tourId) => call(tourPath(tourId, 'view'), { method: 'POST' }),
    like: async (tourId) => {
      const headers: Record<string, string> = {};
      const id = opts.clientId?.();
      if (id) headers['X-Client-Id'] = id;
      return call(tourPath(tourId, 'like'), { method: 'POST', headers });
    },
  };
}

export interface FetchManifestOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * Read `<tilesBase><panoId>/manifest.json` from the CDN, bypassing the HTTP
 * cache. Returns null on 404 (not tiled yet); throws on anything else.
 */
export async function fetchManifest(
  tilesBase: string,
  panoId: string,
  opts: FetchManifestOptions = {},
): Promise<Manifest | null> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const url = manifestUrl(tilesBase, panoId);
  const init: RequestInit = { cache: 'no-store' };
  if (opts.signal) init.signal = opts.signal;
  const res = await doFetch(url, init);
  if (res.status === 404) return null;
  const body = await readJson(res);
  if (!res.ok) throw new ApiError(res.status, body);
  return parseWith(ManifestSchema, url, body);
}

/**
 * Re-fetch the manifest into the browser HTTP cache (`cache: 'reload'`). The CDN sends it with
 * max-age=30, so after a replace the viewer's plain fetch would otherwise reuse the old copy.
 */
export async function refreshManifestCache(
  tilesBase: string,
  panoId: string,
  opts: FetchManifestOptions = {},
): Promise<void> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const init: RequestInit = { cache: 'reload' };
  if (opts.signal) init.signal = opts.signal;
  const res = await doFetch(manifestUrl(tilesBase, panoId), init);
  // Read it fully: a cancelled body may never be committed to the cache.
  await res.arrayBuffer();
}
