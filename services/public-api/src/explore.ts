import {
  EXPLORE_INDEX_ROOT,
  EXPLORE_PAGE_SIZE,
  exploreCursorKey,
  exploreCursorOf,
  ExploreEntrySchema,
  exploreHiddenKey,
  pubTourKey,
  type ExplorePage,
  type ExploreTour,
} from '@internal/contracts';

// GET /api/explore: one page of the Explore index (admin-api's explore.ts writes
// it). The index is a hint, not the truth: each entry is checked against the
// tour's public bundle and the operator's hidden marker before it is shown, so
// an entry that outlived its tour (a failed removal, a race) is never listed.

// List calls per request at most, so a run of dropped entries can't make one
// request walk the whole index; what is left comes back as the next cursor.
const MAX_LIST_CALLS = 3;

/** The tour id an index key names (`<rank>-<tourId>.json`). */
const tourIdOf = (key: string): string | null => {
  const cursor = exploreCursorOf(key);
  return cursor === null ? null : cursor.slice(14);
};

// The bundle's visibility and slug: from its customMetadata (admin-api writes
// both), else from the bundle itself.
const readBundle = async (
  bucket: R2Bucket,
  tourId: string,
): Promise<{ visibility: string; slug: string } | null> => {
  const head = await bucket.head(pubTourKey(tourId));
  if (!head) return null;
  const meta = head.customMetadata;
  if (meta?.visibility && meta.slug) return { visibility: meta.visibility, slug: meta.slug };
  const obj = await bucket.get(pubTourKey(tourId));
  const body =
    (await obj?.json<{ visibility?: unknown; slug?: unknown }>().catch(() => null)) ?? {};
  return typeof body.visibility === 'string' && typeof body.slug === 'string'
    ? { visibility: body.visibility, slug: body.slug }
    : null;
};

/** The card for one index entry, or null if it must not be listed. Never names an owner. */
const checkEntry = async (bucket: R2Bucket, key: string): Promise<ExploreTour | null> => {
  const tourId = tourIdOf(key);
  if (tourId === null) return null;
  const [obj, bundle, hidden] = await Promise.all([
    bucket.get(key),
    readBundle(bucket, tourId),
    bucket.head(exploreHiddenKey(tourId)),
  ]);
  if (!obj || !bundle || bundle.visibility !== 'public' || hidden) return null;
  const parsed = ExploreEntrySchema.safeParse(await obj.json().catch(() => null));
  if (!parsed.success || parsed.data.tourId !== tourId || parsed.data.sceneCount < 1) return null;
  const e = parsed.data;
  // Field by field, so nothing else an entry might carry reaches the page.
  return {
    tourId,
    // The bundle's slug wins: it is what /s/<slug> resolves today.
    slug: bundle.slug,
    title: e.title,
    sceneCount: e.sceneCount,
    cover: e.cover,
    publishedAt: e.publishedAt,
    updatedAt: e.updatedAt,
  };
};

/** One page, newest-listed first, starting after `cursor` (an entry name; see contracts). */
export const listExplore = async (
  bucket: R2Bucket,
  cursor: string | undefined,
  limit = EXPLORE_PAGE_SIZE,
): Promise<ExplorePage> => {
  let startAfter = cursor === undefined ? undefined : (exploreCursorKey(cursor) ?? undefined);
  const tours: ExploreTour[] = [];
  const seen = new Set<string>();
  for (let call = 0; call < MAX_LIST_CALLS; call += 1) {
    const page = await bucket.list({
      prefix: EXPLORE_INDEX_ROOT,
      limit: limit - tours.length,
      ...(startAfter ? { startAfter } : {}),
    });
    const cards = await Promise.all(page.objects.map((o) => checkEntry(bucket, o.key)));
    for (const card of cards) {
      if (card && !seen.has(card.tourId)) {
        seen.add(card.tourId);
        tours.push(card);
      }
    }
    const last = page.objects.at(-1)?.key;
    if (!page.truncated || last === undefined) return { tours, cursor: null };
    startAfter = last;
    if (tours.length >= limit) break;
  }
  return { tours, cursor: startAfter ? exploreCursorOf(startAfter) : null };
};
