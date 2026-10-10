import {
  manifestKey,
  PANO_PATTERN,
  PublishedTourSchema,
  pubTourKey,
  type PublishedTour,
  type SlugPointer,
} from '@internal/contracts';
import { FACES, manifestUrl, parseManifest, tilePath, type Manifest } from '@panote/core';

import type { SlugPath } from './redirect.js';

/** Everything the tour page can be primed with, read from R2 for one request. */
export interface TourBoot {
  slug: string;
  record: SlugPointer;
  tour: PublishedTour;
  /** The scene the SPA will open first, or null when it will show "unavailable". */
  start: string | null;
  /** The start scene's manifest; null when it is missing or unreadable. */
  manifest: Manifest | null;
}

type Reader = Pick<R2Bucket, 'get'>;

async function readJson(bucket: Reader, key: string): Promise<unknown> {
  const object = await bucket.get(key);
  return object ? await object.json() : null;
}

/**
 * Mirrors TourView's choice of first scene: a valid `?pano=` wins, an embed pinned to an
 * unknown scene shows nothing, otherwise the tour's start (or its first scene).
 */
export function startScene(tour: PublishedTour, path: SlugPath, url: URL): string | null {
  const scenes = new Set(tour.scenes.map((s) => s.panoId));
  const requested = url.searchParams.get('pano');
  if (requested !== null && scenes.has(requested)) return requested;
  if (path.embed && requested !== null) return null;
  if (scenes.has(tour.startPanoId)) return tour.startPanoId;
  return tour.scenes[0]?.panoId ?? null;
}

/**
 * Reads `pub/tours/<tourId>.json`, then the start scene's manifest. Null when the bundle
 * is missing or invalid (the SPA then shows the same "unavailable" it would have).
 * Throws on R2 errors; the caller fails open.
 */
export async function readTourBoot(
  bucket: Reader,
  path: SlugPath,
  record: SlugPointer,
  url: URL,
): Promise<TourBoot | null> {
  if (!PANO_PATTERN.test(record.tourId)) return null;
  const parsed = PublishedTourSchema.safeParse(await readJson(bucket, pubTourKey(record.tourId)));
  if (!parsed.success || parsed.data.tourId !== record.tourId) return null;
  const tour = parsed.data;
  const start = startScene(tour, path, url);
  let manifest: Manifest | null = null;
  if (start !== null && PANO_PATTERN.test(start)) {
    try {
      manifest = parseManifest(await readJson(bucket, manifestKey(start)));
    } catch {
      // Not tiled yet, or corrupt: the viewer reports it itself; the tour data still helps.
    }
  }
  return { slug: path.slug, record, tour, start, manifest };
}

/** The exact URLs the viewer fetches first: the manifest, then the six level-0 faces. */
export function preloadUrls(tilesBase: string, manifest: Manifest): string[] {
  const { pano, format, version } = manifest;
  return [
    manifestUrl(tilesBase, pano),
    ...FACES.map((face) => tilePath(tilesBase, pano, 0, face, 0, 0, format, version)),
  ];
}

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * `crossorigin` (anonymous) matches the viewer's plain CORS `fetch()`, so the browser
 * reuses the preloaded response instead of fetching twice.
 */
export const preloadLinks = (urls: readonly string[]): string =>
  urls.map((u) => `<link rel="preload" as="fetch" href="${escapeAttr(u)}" crossorigin>`).join('');

/** JSON for a `<script type="application/json">`: no `<`, so no `</script>` breakout. */
export const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c');
