import {
  decodeId,
  ExploreCoverSchema,
  exploreHiddenKey,
  exploreTourKey,
  ExploreEntrySchema,
  ExplorePointerSchema,
  manifestKey,
  PANO_PATTERN,
  PublishedTourSchema,
  pubTourKey,
  TourDocSchema,
  tourOwnerKey,
  type BackfillChange,
  type OperatorBackfillOk,
  type TourOwnerRecord,
} from '@internal/contracts';
import { putJson } from '@internal/worker-kit/r2-binding';

import { tourCustomMetadata } from './lists.js';

// The operator's backfill (scripts/backfill-covers.ts, "Cover and Explore backfill" in
// docs/deploy.md): what a tour saved or published before the current code lacks until its
// owner's next Save, done now. Idempotent: a tour already up to date needs nothing, so a
// second pass reports no changes.
// - cover: tour.json's customMetadata (title, sceneCount, coverPanoId), which the dashboard
//   reads for its cover. Tours saved before #111 name their first scene, not the starred
//   start scene; older ones carry none.
// - owner-pointer: tour-owners/<tourId>.json, written on create and publish only since
//   #121. The takedown and restore scripts and the plan sweep look owners up through it.
// - explore: a Public tour published before #126 has no Explore entry, and an entry's
//   cover names a tile version a re-tile may have replaced since. The TourPublisher
//   re-syncs it from the live bundle (explore.ts's syncExplore), as a publish would.

const TOUR_KEY_RE = /^tours\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/tour\.json$/;

export type ExploreRefresh = (tourId: string) => Promise<boolean>;

const readJson = async (bucket: R2Bucket, key: string): Promise<unknown> => {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return obj.json().catch(() => undefined);
};

const sameMetadata = (a: Record<string, string>, b: Record<string, string> | undefined) =>
  Object.keys(a).every((k) => b?.[k] === a[k]);

/** The cover Explore would show now for the bundle's start scene, as explore.ts derives it. */
const currentCover = async (bucket: R2Bucket, panoId: string) => {
  const m = (await readJson(bucket, manifestKey(panoId))) as {
    version?: unknown;
    og?: unknown;
    preview?: unknown;
  } | null;
  if (!m) return undefined;
  const image = m.og === true ? 'og' : m.preview === true ? 'preview' : null;
  const cover = ExploreCoverSchema.safeParse({ panoId, version: m.version, image });
  return cover.success ? cover.data : null;
};

/** Whether the tour's Explore entry is missing or out of date with its live bundle. */
const exploreStale = async (bucket: R2Bucket, tourId: string): Promise<boolean> => {
  const bundle = PublishedTourSchema.safeParse(await readJson(bucket, pubTourKey(tourId)));
  if (!bundle.success || bundle.data.visibility !== 'public' || bundle.data.scenes.length === 0) {
    return false;
  }
  if (await bucket.head(exploreHiddenKey(tourId))) return false;
  const cover = await currentCover(bucket, bundle.data.startPanoId);
  // A start scene with no manifest isn't ready: a publish wouldn't list it either.
  if (cover === undefined) return false;
  const pointer = ExplorePointerSchema.safeParse(await readJson(bucket, exploreTourKey(tourId)));
  if (!pointer.success) return true;
  const entry = ExploreEntrySchema.safeParse(await readJson(bucket, pointer.data.key));
  if (!entry.success) return true;
  return JSON.stringify(entry.data.cover) !== JSON.stringify(cover);
};

const backfillTour = async (
  bucket: R2Bucket,
  key: string,
  apply: boolean,
  refreshExplore: ExploreRefresh,
): Promise<OperatorBackfillOk['tours'][number]> => {
  const [, owner, tourId] = TOUR_KEY_RE.exec(key)!;
  const changes: BackfillChange[] = [];
  const sub = decodeId(owner!);
  if (sub === null || !PANO_PATTERN.test(tourId!)) {
    return { tourId: tourId!, changes, skipped: 'not a key the app writes' };
  }
  const obj = await bucket.get(key);
  if (!obj) return { tourId: tourId!, changes, skipped: 'deleted since the listing' };
  const body = await obj.text();
  let parsed;
  try {
    parsed = TourDocSchema.safeParse(JSON.parse(body));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) return { tourId: tourId!, changes, skipped: 'tour.json unreadable' };

  const metadata = tourCustomMetadata(parsed.data);
  if (!sameMetadata(metadata, obj.customMetadata)) {
    changes.push('cover');
    // Only over the body just read: a save since then already wrote the right metadata.
    if (apply) {
      await bucket.put(key, body, {
        httpMetadata: obj.httpMetadata ?? { contentType: 'application/json' },
        customMetadata: { ...obj.customMetadata, ...metadata },
        onlyIf: { etagMatches: obj.etag },
      });
    }
  }
  if (!(await bucket.head(tourOwnerKey(tourId!)))) {
    changes.push('owner-pointer');
    if (apply) {
      const record: TourOwnerRecord = { v: 1, sub };
      await putJson(bucket, tourOwnerKey(tourId!), record, { etagDoesNotMatch: '*' });
    }
  }
  if (await exploreStale(bucket, tourId!)) {
    changes.push('explore');
    if (apply) await refreshExplore(tourId!);
  }
  return { tourId: tourId!, changes };
};

/**
 * One page of the backfill: up to `limit` tours after `cursor`, in key order. Returns what
 * each needed (and, with `apply`, got), and the cursor for the next page.
 */
export const backfillTours = async (
  bucket: R2Bucket,
  req: { cursor?: string | undefined; limit: number; apply: boolean },
  refreshExplore: ExploreRefresh,
): Promise<OperatorBackfillOk> => {
  const tours: OperatorBackfillOk['tours'] = [];
  let startAfter = req.cursor;
  let last: string | undefined;
  for (;;) {
    const page = await bucket.list({
      prefix: 'tours/',
      ...(startAfter !== undefined ? { startAfter } : {}),
    });
    for (const o of page.objects) {
      if (!TOUR_KEY_RE.test(o.key)) continue;
      tours.push(await backfillTour(bucket, o.key, req.apply, refreshExplore));
      last = o.key;
      if (tours.length >= req.limit) return { tours, cursor: last };
    }
    if (!page.truncated) return { tours, cursor: null };
    startAfter = page.objects.at(-1)?.key;
  }
};
