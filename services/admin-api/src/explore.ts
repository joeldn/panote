import {
  EXPLORE_INDEX_ROOT,
  EXPLORE_RANK_MAX,
  ExploreCoverSchema,
  exploreCursorOf,
  exploreEntryKey,
  exploreHiddenKey,
  ExplorePointerSchema,
  exploreTourKey,
  manifestKey,
  type ExploreCover,
  type ExploreEntry,
  type ExplorePointer,
  type PublishedTour,
} from '@internal/contracts';
import { getJson, putJson } from '@internal/worker-kit/r2-binding';

// The Explore index (decisions.md, "Explore index"): one small entry per listed
// tour under explore/index/, newest-listed first, and a pointer per tour so a
// removal needs only the tourId. Every write runs inside the tour's
// TourPublisher, after the bundle it describes. public-api reads it, and
// re-checks each entry against pub/ and the hidden marker, so a write that
// fails here can at worst leave a tour off the list, never on it.

type StoredPointer = { pointer: ExplorePointer | null };

// null: no pointer. { pointer: null }: one that doesn't parse, still to be removed.
const readPointer = async (bucket: R2Bucket, tourId: string): Promise<StoredPointer | null> => {
  const obj = await bucket.get(exploreTourKey(tourId));
  if (!obj) return null;
  const value: unknown = await obj.json().catch(() => null);
  const parsed = ExplorePointerSchema.safeParse(value);
  return { pointer: parsed.success ? parsed.data : null };
};

// The listing time an existing entry key encodes, so a re-list keeps its place.
const listedAtOf = (key: string): number | null => {
  const cursor = exploreCursorOf(key);
  return cursor === null ? null : EXPLORE_RANK_MAX - Number(cursor.slice(0, 13));
};

/**
 * The start scene's card image and whether that scene is ready. A start scene with
 * no manifest isn't ready, so the tour isn't listed (null); a ready one with
 * neither og.jpg nor preview.webp is listed with no cover.
 */
const readCover = async (
  bucket: R2Bucket,
  panoId: string,
): Promise<{ cover: ExploreCover | null } | null> => {
  const got = await getJson<unknown>(bucket, manifestKey(panoId)).catch(() => null);
  if (!got) return null;
  // Only the image fields are read; the viewer is the manifest's real validator.
  const m = (got.value ?? {}) as { version?: unknown; og?: unknown; preview?: unknown };
  const image = m.og === true ? 'og' : m.preview === true ? 'preview' : null;
  const cover = ExploreCoverSchema.safeParse({ panoId, version: m.version, image });
  return { cover: cover.success ? cover.data : null };
};

/**
 * Every index entry filed under this tour, found by listing the whole index. Only for a
 * pointer that doesn't parse (it can't say where the entry is): rare, so a full list is fine.
 */
const deleteEntriesByScan = async (bucket: R2Bucket, tourId: string): Promise<void> => {
  const suffix = `-${tourId}.json`;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: EXPLORE_INDEX_ROOT, ...(cursor ? { cursor } : {}) });
    const mine = page.objects.map((o) => o.key).filter((k) => k.endsWith(suffix));
    if (mine.length > 0) await bucket.delete(mine);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
};

/**
 * Takes the tour off Explore: its entry, then its pointer. Idempotent, and it
 * throws on an R2 error, so a takedown that can't finish says so and is retried.
 */
export const removeFromExplore = async (bucket: R2Bucket, tourId: string): Promise<void> => {
  const stored = await readPointer(bucket, tourId);
  if (!stored) return;
  if (stored.pointer) await bucket.delete(stored.pointer.key);
  else await deleteEntriesByScan(bucket, tourId);
  await bucket.delete(exploreTourKey(tourId));
};

/**
 * Brings the tour's entry in line with the bundle just written: listed while it is
 * Public, has a ready start scene and isn't hidden by the operator; removed
 * otherwise. Pointer before entry, so an entry never exists without one.
 */
export const syncExplore = async (bucket: R2Bucket, bundle: PublishedTour, now: Date) => {
  const { tourId } = bundle;
  const listable =
    bundle.visibility === 'public' &&
    bundle.scenes.length > 0 &&
    !(await bucket.head(exploreHiddenKey(tourId)));
  const ready = listable ? await readCover(bucket, bundle.startPanoId) : null;
  if (!ready) {
    await removeFromExplore(bucket, tourId);
    return;
  }
  const stored = await readPointer(bucket, tourId);
  // An unreadable pointer can't name its entry: drop whatever is filed under the tour first.
  if (stored && !stored.pointer) await deleteEntriesByScan(bucket, tourId);
  const kept = stored?.pointer ? listedAtOf(stored.pointer.key) : null;
  const listedAtMs = kept ?? now.getTime();
  const key = exploreEntryKey(listedAtMs, tourId);
  if (stored?.pointer?.key !== key) {
    // A pointer naming a malformed key: drop that object before replacing the pointer.
    if (stored?.pointer) await bucket.delete(stored.pointer.key);
    await putJson(bucket, exploreTourKey(tourId), { v: 1, key } satisfies ExplorePointer);
  }
  const entry: ExploreEntry = {
    v: 1,
    tourId,
    slug: bundle.slug,
    title: bundle.title,
    sceneCount: bundle.scenes.length,
    cover: ready.cover,
    publishedAt: bundle.publishedAt,
    listedAt: new Date(listedAtMs).toISOString(),
    updatedAt: now.toISOString(),
  };
  await putJson(bucket, key, entry);
};

/**
 * Best-effort syncExplore for publish, rename and visibility changes: a failure
 * is logged and leaves the publish itself standing. A tour it fails to list just
 * isn't on Explore yet; one it fails to remove is still dropped by public-api,
 * which re-reads the bundle's visibility.
 */
export const syncExploreQuietly = async (
  bucket: R2Bucket,
  bundle: PublishedTour,
  now: Date,
): Promise<void> => {
  try {
    await syncExplore(bucket, bundle, now);
  } catch (e) {
    // The name only: R2 error messages can carry keys.
    console.error('[explore] index update failed:', e instanceof Error ? e.name : 'unknown');
  }
};

/**
 * The operator's hide (and unhide). The marker comes first, so a tour is off the
 * list (public-api checks it) before its entry is even removed. Unhiding relists
 * a published Public tour from its current bundle.
 */
export const setExploreHidden = async (
  bucket: R2Bucket,
  tourId: string,
  hidden: boolean,
  now: Date,
  bundle: PublishedTour | null,
): Promise<void> => {
  if (hidden) {
    await putJson(bucket, exploreHiddenKey(tourId), { v: 1, hiddenAt: now.toISOString() });
    await removeFromExplore(bucket, tourId);
    return;
  }
  await bucket.delete(exploreHiddenKey(tourId));
  if (bundle) await syncExplore(bucket, bundle, now);
};
