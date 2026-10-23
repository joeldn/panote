import { flagKey, pubTourKey, type FlagRecord, type FlagRequest } from '@internal/contracts';

// POST /api/tours/:tourId/flag: a visitor flags one panorama of a published tour, with a
// reason (contracts moderation.ts). Stored under moderation/flags/ for the operator's review
// queue in admin-api; nothing about the visitor (no IP, no account, no client id) is kept.
// The only write public-api makes to R2.

/** The bundle's slug and scene ids, or null when the tour isn't published. */
const readBundle = async (
  bucket: R2Bucket,
  tourId: string,
): Promise<{ slug: string; panoIds: Set<string> } | null> => {
  const obj = await bucket.get(pubTourKey(tourId));
  if (!obj) return null;
  const body = (await obj.json<{ slug?: unknown; scenes?: unknown }>().catch(() => null)) ?? {};
  if (typeof body.slug !== 'string' || !Array.isArray(body.scenes)) return null;
  const panoIds = new Set(
    body.scenes
      .map((s: unknown) => (s as { panoId?: unknown } | null)?.panoId)
      .filter((id): id is string => typeof id === 'string'),
  );
  return { slug: body.slug, panoIds };
};

export type FlagOutcome = 'stored' | 'not-found';

/** Stores the flag when the pano is one of the published tour's scenes. */
export const storeFlag = async (
  bucket: R2Bucket,
  tourId: string,
  req: FlagRequest,
  now: Date,
): Promise<FlagOutcome> => {
  const bundle = await readBundle(bucket, tourId);
  if (!bundle || !bundle.panoIds.has(req.panoId)) return 'not-found';
  const flagId = crypto.randomUUID();
  const record: FlagRecord = {
    v: 1,
    flagId,
    source: 'viewer',
    tourId,
    slug: bundle.slug,
    panoId: req.panoId,
    reason: req.reason,
    ...(req.note ? { note: req.note } : {}),
    at: now.toISOString(),
  };
  await bucket.put(flagKey(now.getTime(), flagId), JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' },
  });
  return 'stored';
};
