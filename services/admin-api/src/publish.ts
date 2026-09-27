import {
  configKey,
  DEFAULT_TOUR_SETTINGS,
  defaultSlugCandidates,
  deletingKey,
  manifestKey,
  originalKey,
  publishKey,
  pubTourKey,
  slugKey,
  SlugRecordSchema,
  SLUGS_ROOT,
  tourKey,
  type PublishedTour,
  type PublishFailureReason,
  type PublishRecord,
  type SceneConfig,
  type SlugRecord,
  type TourDoc,
  type Visibility,
} from '@internal/contracts';
import { getJson, putJson } from '@internal/worker-kit/r2-binding';

export const DEFAULT_SLUG_ALIAS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCENE_CHECK_CONCURRENCY = 8;

/** SLUG_ALIAS_DAYS as a positive number, else the default. */
export const parseAliasDays = (raw: string | undefined): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0
    ? n
    : DEFAULT_SLUG_ALIAS_DAYS;
};

export type SceneFailure = { panoId: string; reason: PublishFailureReason };

// Ownership proof per scene: an original under the caller's prefix and no
// tombstone. A config alone proves nothing, since foreign-panoId configs are allowed.
export const checkScenes = async (
  bucket: R2Bucket,
  sub: string,
  panoIds: readonly string[],
): Promise<{ failures: SceneFailure[]; configs: Map<string, SceneConfig> }> => {
  const unique = [...new Set(panoIds)];
  const failures: SceneFailure[] = [];
  const configs = new Map<string, SceneConfig>();
  for (let i = 0; i < unique.length; i += SCENE_CHECK_CONCURRENCY) {
    const batch = unique.slice(i, i + SCENE_CHECK_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (panoId): Promise<SceneFailure | null> => {
        const [original, tombstone, config] = await Promise.all([
          bucket.head(originalKey(sub, panoId)),
          bucket.head(deletingKey(sub, panoId)),
          getJson<SceneConfig>(bucket, configKey(sub, panoId)),
        ]);
        if (tombstone) return { panoId, reason: 'deleting' };
        if (!original) return { panoId, reason: config ? 'not-owned' : 'missing' };
        if (!config) return { panoId, reason: 'missing' };
        // The owner-free manifest is only probed after the ownership proof above.
        if (!(await bucket.head(manifestKey(panoId)))) return { panoId, reason: 'not-ready' };
        configs.set(panoId, config.value);
        return null;
      }),
    );
    for (const r of results) if (r) failures.push(r);
  }
  return { failures, configs };
};

export const buildBundle = (
  tour: TourDoc,
  configs: Map<string, SceneConfig>,
  state: { slug: string; visibility: Visibility; publishedAt: string },
): PublishedTour => {
  const firstPanoId = tour.scenes[0]?.panoId ?? '';
  const startPanoId =
    tour.startPanoId && tour.scenes.some((s) => s.panoId === tour.startPanoId)
      ? tour.startPanoId
      : firstPanoId;
  return {
    v: 1,
    tourId: tour.tourId,
    title: tour.title,
    visibility: state.visibility,
    slug: state.slug,
    publishedAt: state.publishedAt,
    settings: tour.settings ?? DEFAULT_TOUR_SETTINGS,
    startPanoId,
    scenes: tour.scenes.map((s) => ({
      panoId: s.panoId,
      ...(s.mapX !== undefined ? { mapX: s.mapX } : {}),
      ...(s.mapY !== undefined ? { mapY: s.mapY } : {}),
      config: configs.get(s.panoId) as SceneConfig,
    })),
  };
};

type StoredSlug = { record: SlugRecord | null; etag: string };

// record is null for an unparsable object: it exists, so it's treated as taken.
const readSlug = async (bucket: R2Bucket, slug: string): Promise<StoredSlug | null> => {
  const got = await getJson<unknown>(bucket, slugKey(slug));
  if (!got) return null;
  const parsed = SlugRecordSchema.safeParse(got.value);
  return { record: parsed.success ? parsed.data : null, etag: got.etag };
};

const pointerMetadata = { kind: 'tour' };

/**
 * Makes `slug` a live pointer at `tourId`. Create-only first; an existing
 * pointer at this tour, or an alias this tour left behind, also counts as ours.
 */
export const claimSlug = async (
  bucket: R2Bucket,
  slug: string,
  tourId: string,
): Promise<boolean> => {
  const pointer: SlugRecord = { v: 1, kind: 'tour', tourId };
  // Bounded retry: each loop only repeats after the key changed under us.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = await putJson(
      bucket,
      slugKey(slug),
      pointer,
      { etagDoesNotMatch: '*' },
      pointerMetadata,
    );
    if (created.ok) return true;
    const existing = await readSlug(bucket, slug);
    if (!existing) continue;
    const { record } = existing;
    if (!record || record.tourId !== tourId) return false;
    if (record.kind === 'tour') return true;
    const reclaimed = await putJson(
      bucket,
      slugKey(slug),
      pointer,
      { etagMatches: existing.etag },
      pointerMetadata,
    );
    if (reclaimed.ok) return true;
  }
  return false;
};

/**
 * Turns this tour's previous slugs into redirects at `newSlug` (Q6). The
 * slug just left gets a fresh expiry; older aliases keep theirs (chain collapse).
 */
const redirectOldSlugs = async (
  bucket: R2Bucket,
  tourId: string,
  oldSlugs: readonly string[],
  newSlug: string,
  freshExpiresAt: string,
  now: Date,
): Promise<{ aliases: string[]; expiries: Map<string, string> }> => {
  const aliases: string[] = [];
  const expiries = new Map<string, string>();
  for (const slug of new Set(oldSlugs)) {
    if (slug === newSlug) continue;
    const existing = await readSlug(bucket, slug);
    const record = existing?.record;
    if (!existing || !record || record.tourId !== tourId) continue;
    if (record.kind === 'redirect' && Date.parse(record.expiresAt) <= now.getTime()) continue;
    const expiresAt = record.kind === 'redirect' ? record.expiresAt : freshExpiresAt;
    if (record.kind === 'tour' || record.redirect !== newSlug) {
      const alias: SlugRecord = { v: 1, kind: 'redirect', tourId, redirect: newSlug, expiresAt };
      const res = await putJson(
        bucket,
        slugKey(slug),
        alias,
        { etagMatches: existing.etag },
        { kind: 'redirect', expiresAt },
      );
      // Lost a race (e.g. the sweep deleted it): the slug is no longer ours.
      if (!res.ok) continue;
    }
    aliases.push(slug);
    expiries.set(slug, expiresAt);
  }
  return { aliases, expiries };
};

export type SlugChange =
  | { ok: true; slug: string; aliases: string[]; oldSlugRedirectsUntil: string | null }
  | { ok: false };

/** Claims `target` for the tour, then redirects the previous slug(s) to it. */
export const moveToSlug = async (
  bucket: R2Bucket,
  tourId: string,
  current: PublishRecord | null,
  target: string,
  now: Date,
  aliasDays: number,
): Promise<SlugChange> => {
  if (!(await claimSlug(bucket, target, tourId))) return { ok: false };
  const previous = current ? [current.slug, ...(current.aliases ?? [])] : [];
  const freshExpiresAt = new Date(now.getTime() + aliasDays * DAY_MS).toISOString();
  const { aliases, expiries } = await redirectOldSlugs(
    bucket,
    tourId,
    previous,
    target,
    freshExpiresAt,
    now,
  );
  const changed = !!current && current.slug !== target;
  return {
    ok: true,
    slug: target,
    aliases,
    oldSlugRedirectsUntil: changed ? (expiries.get(current.slug) ?? null) : null,
  };
};

/** Default-slug path for a first publish: the first candidate this tour can claim. */
export const claimDefaultSlug = async (
  bucket: R2Bucket,
  tourId: string,
  title: string,
): Promise<string | null> => {
  for (const candidate of defaultSlugCandidates(title)) {
    if (await claimSlug(bucket, candidate, tourId)) return candidate;
  }
  return null;
};

// publish.json's customMetadata is what the tours list reads (lists.ts).
export const writePublishState = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
  record: PublishRecord,
  bundle: PublishedTour,
): Promise<void> => {
  // publish.json first, so an interrupted publish can still be found and unpublished.
  await putJson(bucket, publishKey(sub, tourId), record, undefined, {
    slug: record.slug,
    visibility: record.visibility,
  });
  await putJson(bucket, pubTourKey(tourId), bundle);
};

export const readPublishRecord = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
): Promise<PublishRecord | null> =>
  (await getJson<PublishRecord>(bucket, publishKey(sub, tourId)))?.value ?? null;

/**
 * Idempotent. Needs tour.json or publish.json under the caller as proof,
 * since pub/ is owner-free. Deletes the slug only if it's a live pointer here.
 */
export const unpublish = async (bucket: R2Bucket, sub: string, tourId: string): Promise<void> => {
  const [record, tour] = await Promise.all([
    readPublishRecord(bucket, sub, tourId),
    bucket.head(tourKey(sub, tourId)),
  ]);
  if (!record && !tour) return;
  if (record) {
    const existing = await readSlug(bucket, record.slug);
    if (existing?.record?.kind === 'tour' && existing.record.tourId === tourId) {
      await bucket.delete(slugKey(record.slug));
    }
  }
  await bucket.delete(pubTourKey(tourId));
  await bucket.delete(publishKey(sub, tourId));
};

/** Daily cron: deletes every redirect alias past its expiresAt (Q6). */
export const sweepExpiredAliases = async (bucket: R2Bucket, now: Date): Promise<string[]> => {
  const expired = (meta: Record<string, string> | undefined): boolean =>
    meta?.kind === 'redirect' && !!meta.expiresAt && Date.parse(meta.expiresAt) <= now.getTime();
  const deleted: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: SLUGS_ROOT,
      include: ['customMetadata'],
      ...(cursor ? { cursor } : {}),
    });
    for (const obj of page.objects) {
      if (!expired(obj.customMetadata)) continue;
      // Re-check just before deleting: the slug may have been reclaimed since the list.
      const fresh = await bucket.head(obj.key);
      if (!fresh || !expired(fresh.customMetadata)) continue;
      await bucket.delete(obj.key);
      deleted.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
};
