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
  storedSlugKey,
  SlugRecordSchema,
  SLUGS_ROOT,
  tourKey,
  DEFAULT_VISIBILITY,
  type Hotspot,
  type PublishedTour,
  type PublishFailureReason,
  type PublishRecord,
  type SceneConfig,
  type SlugRecord,
  type SlugRedirect,
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

// Link hotspots must stay inside the tour: a foreign target is dropped rather
// than 422'd, since every Save publishes.
const publicHotspots = (config: SceneConfig, sceneIds: ReadonlySet<string>): SceneConfig => ({
  ...config,
  hotspots: config.hotspots.flatMap((h): Hotspot[] => {
    if (h.targetPanoId === undefined || sceneIds.has(h.targetPanoId)) return [h];
    if (h.type === 'link') return [];
    const { targetPanoId: _dropped, ...rest } = h;
    return [rest];
  }),
});

export const buildBundle = (
  tour: TourDoc,
  configs: Map<string, SceneConfig>,
  state: { slug: string; visibility: Visibility; publishedAt: string },
): PublishedTour => {
  const sceneIds = new Set(tour.scenes.map((s) => s.panoId));
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
      config: publicHotspots(configs.get(s.panoId) as SceneConfig, sceneIds),
    })),
  };
};

type StoredSlug = { record: SlugRecord | null; etag: string };

// record is null for an unparsable object: it exists, so it's treated as taken.
const readSlug = async (bucket: R2Bucket, slug: string): Promise<StoredSlug | null> => {
  const key = storedSlugKey(slug);
  const got = key ? await getJson<unknown>(bucket, key) : null;
  if (!got) return null;
  const parsed = SlugRecordSchema.safeParse(got.value);
  return { record: parsed.success ? parsed.data : null, etag: got.etag };
};

// Reads the clock at check time (not op start), keeping the cron race to an instant.
const isExpired = (record: SlugRedirect): boolean => Date.parse(record.expiresAt) <= Date.now();

const pointerMetadata = { kind: 'tour' };

type ClaimResult = 'created' | 'ours' | 'taken';

// Makes `slug` a live pointer at `tourId`, create-only. Also ours: a live pointer
// here, or an unexpired alias of this tour that redirects to its current slug.
export const claimSlug = async (
  bucket: R2Bucket,
  slug: string,
  tourId: string,
  currentSlug: string | null,
): Promise<ClaimResult> => {
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
    if (created.ok) return 'created';
    const existing = await readSlug(bucket, slug);
    if (!existing) continue;
    const { record } = existing;
    if (!record || record.tourId !== tourId) return 'taken';
    if (record.kind === 'tour') return 'ours';
    // A stale caller (currentSlug out of date) or an expired alias must not revive it.
    if (record.redirect !== currentSlug || isExpired(record)) return 'taken';
    const reclaimed = await putJson(
      bucket,
      slugKey(slug),
      pointer,
      { etagMatches: existing.etag },
      pointerMetadata,
    );
    if (reclaimed.ok) return 'created';
  }
  return 'taken';
};

/** Default-slug path for a first publish: the first candidate this tour can claim. */
const claimDefaultSlug = async (
  bucket: R2Bucket,
  tourId: string,
  title: string,
): Promise<{ slug: string; result: ClaimResult } | null> => {
  for (const candidate of defaultSlugCandidates(title)) {
    const result = await claimSlug(bucket, candidate, tourId, null);
    if (result !== 'taken') return { slug: candidate, result };
  }
  return null;
};

// Tracked aliases per tour; older ones are re-pointed once more, then left to expire.
export const MAX_ALIASES = 20;

type AliasPlan = { slug: string; etag: string; record: SlugRecord }[];

// Previous slugs (newest first) that still belong to this tour and haven't expired.
const planAliases = async (
  bucket: R2Bucket,
  tourId: string,
  current: PublishRecord | null,
  newSlug: string,
): Promise<AliasPlan> => {
  const previous = current ? [current.slug, ...(current.aliases ?? [])] : [];
  const plan: AliasPlan = [];
  for (const slug of new Set(previous)) {
    if (slug === newSlug) continue;
    const existing = await readSlug(bucket, slug);
    const record = existing?.record;
    if (!existing || !record || record.tourId !== tourId) continue;
    if (record.kind === 'redirect' && isExpired(record)) continue;
    plan.push({ slug, etag: existing.etag, record });
  }
  return plan;
};

// Rewrites every planned slug into a redirect at `newSlug` (Q6, chain collapse).
// A slug leaving live gets `freshExpiresAt`; an existing alias keeps its expiry.
const applyAliases = async (
  bucket: R2Bucket,
  tourId: string,
  plan: AliasPlan,
  newSlug: string,
  freshExpiresAt: string,
): Promise<Map<string, string>> => {
  const expiries = new Map<string, string>();
  for (const { slug, etag, record } of plan) {
    const expiresAt = record.kind === 'redirect' ? record.expiresAt : freshExpiresAt;
    if (record.kind === 'tour' || record.redirect !== newSlug) {
      const alias: SlugRecord = { v: 1, kind: 'redirect', tourId, redirect: newSlug, expiresAt };
      const res = await putJson(
        bucket,
        storedSlugKey(slug) as string,
        alias,
        { etagMatches: etag },
        { kind: 'redirect', expiresAt },
      );
      // Lost a race (e.g. the sweep deleted it): the slug is no longer ours.
      if (!res.ok) continue;
    }
    expiries.set(slug, expiresAt);
  }
  return expiries;
};

type StoredRecord = { value: PublishRecord; etag: string };

export const readPublishRecord = (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
): Promise<StoredRecord | null> => getJson<PublishRecord>(bucket, publishKey(sub, tourId));

export type Outcome<T> =
  | { status: 200; body: T }
  | { status: 404 | 409 | 422; body: { error: string; scenes?: SceneFailure[] } };

export const NOT_FOUND = { status: 404, body: { error: 'not found' } } as const;
const SLUG_LOST = { status: 409, body: { error: 'slug lost' } } as const;
const SLUG_TAKEN = { status: 409, body: { error: 'slug taken' } } as const;
const CONFLICT = { status: 409, body: { error: 'conflict' } } as const;
const NOT_PUBLISHED = { status: 409, body: { error: 'not published' } } as const;

type Commit = {
  current: StoredRecord | null;
  record: PublishRecord;
  plan: AliasPlan;
  bundle: PublishedTour;
  freshExpiresAt: string;
};

// Callers run one at a time per tour (TourPublisher). Order keeps a crash
// retryable: publish.json, then aliases, then the bundle, then the tour re-check.
const commit = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
  c: Commit,
): Promise<{ ok: true; expiries: Map<string, string> } | { ok: false; status: 404 | 409 }> => {
  // Belt and braces: serialization means this precondition should always hold.
  const wrote = await putJson(
    bucket,
    publishKey(sub, tourId),
    c.record,
    c.current ? { etagMatches: c.current.etag } : { etagDoesNotMatch: '*' },
    { slug: c.record.slug, visibility: c.record.visibility },
  );
  if (!wrote.ok) return { ok: false, status: 409 };
  const expiries = await applyAliases(bucket, tourId, c.plan, c.record.slug, c.freshExpiresAt);
  await putJson(bucket, pubTourKey(tourId), c.bundle);
  // A tour deleted meanwhile (the delete itself isn't serialized) must not stay public.
  if (!(await bucket.head(tourKey(sub, tourId)))) {
    await unpublish(bucket, sub, tourId);
    return { ok: false, status: 404 };
  }
  return { ok: true, expiries };
};

export type Clock = { now: Date; aliasDays: number };

const freshExpiry = ({ now, aliasDays }: Clock): string =>
  new Date(now.getTime() + aliasDays * DAY_MS).toISOString();

const failed = (status: 404 | 409) => (status === 404 ? NOT_FOUND : CONFLICT);

export type PublishBody = {
  slug: string;
  visibility: Visibility;
  url: string;
  publishedAt: string;
};
export type PublishRequest = { slug?: string | undefined; visibility?: Visibility | undefined };

// POST …/publish: idempotent, safe to retry (plan 3.2).
export const publishTour = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
  req: PublishRequest,
  clock: Clock,
): Promise<Outcome<PublishBody>> => {
  const tour = await getJson<TourDoc>(bucket, tourKey(sub, tourId));
  if (!tour) return NOT_FOUND;
  if (tour.value.scenes.length === 0) {
    return { status: 422, body: { error: 'tour has no scenes', scenes: [] } };
  }
  const panoIds = tour.value.scenes.map((s) => s.panoId);
  const { failures, configs } = await checkScenes(bucket, sub, panoIds);
  if (failures.length > 0) {
    return { status: 422, body: { error: 'scenes not publishable', scenes: failures } };
  }

  const current = await readPublishRecord(bucket, sub, tourId);
  const cur = current?.value ?? null;
  const target = req.slug ?? cur?.slug;
  let slug: string;
  let result: ClaimResult;
  if (target !== undefined) {
    result = await claimSlug(bucket, target, tourId, cur?.slug ?? null);
    slug = target;
  } else {
    const claimed = await claimDefaultSlug(bucket, tourId, tour.value.title);
    if (!claimed) return SLUG_TAKEN;
    ({ slug, result } = claimed);
  }
  // Another tour holds the current slug; retrying won't help, so say so.
  if (result === 'taken') return req.slug === undefined ? SLUG_LOST : SLUG_TAKEN;

  const plan = await planAliases(bucket, tourId, cur, slug);
  const record: PublishRecord = {
    slug,
    visibility: req.visibility ?? cur?.visibility ?? DEFAULT_VISIBILITY,
    publishedAt: cur?.publishedAt ?? clock.now.toISOString(),
    aliases: plan.slice(0, MAX_ALIASES).map((a) => a.slug),
  };
  const done = await commit(bucket, sub, tourId, {
    current,
    record,
    plan,
    bundle: buildBundle(tour.value, configs, record),
    freshExpiresAt: freshExpiry(clock),
  });
  if (!done.ok) return failed(done.status);
  return {
    status: 200,
    body: {
      slug,
      visibility: record.visibility,
      url: `/s/${slug}`,
      publishedAt: record.publishedAt,
    },
  };
};

// What a slug or visibility change edits in place: the caller's published tour.
const loadPublished = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
): Promise<
  | { ok: true; current: StoredRecord; bundle: { value: PublishedTour } }
  | { ok: false; outcome: typeof NOT_FOUND | typeof NOT_PUBLISHED }
> => {
  if (!(await bucket.head(tourKey(sub, tourId)))) return { ok: false, outcome: NOT_FOUND };
  const current = await readPublishRecord(bucket, sub, tourId);
  const bundle = current ? await getJson<PublishedTour>(bucket, pubTourKey(tourId)) : null;
  if (!current || !bundle) return { ok: false, outcome: NOT_PUBLISHED };
  return { ok: true, current, bundle };
};

// PUT …/slug: rename, leaving the old slug as a redirect alias (Q6).
export const renameSlug = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
  target: string,
  clock: Clock,
): Promise<Outcome<{ slug: string; oldSlugRedirectsUntil: string | null }>> => {
  const loaded = await loadPublished(bucket, sub, tourId);
  if (!loaded.ok) return loaded.outcome;
  const cur = loaded.current.value;
  const result = await claimSlug(bucket, target, tourId, cur.slug);
  if (result === 'taken') return SLUG_TAKEN;
  const plan = await planAliases(bucket, tourId, cur, target);
  const record: PublishRecord = {
    ...cur,
    slug: target,
    aliases: plan.slice(0, MAX_ALIASES).map((a) => a.slug),
  };
  const done = await commit(bucket, sub, tourId, {
    current: loaded.current,
    record,
    plan,
    bundle: { ...loaded.bundle.value, slug: target },
    freshExpiresAt: freshExpiry(clock),
  });
  if (!done.ok) return failed(done.status);
  const changed = cur.slug !== target;
  return {
    status: 200,
    body: {
      slug: target,
      oldSlugRedirectsUntil: changed ? (done.expiries.get(cur.slug) ?? null) : null,
    },
  };
};

// PATCH …/visibility.
export const setVisibility = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
  visibility: Visibility,
  clock: Clock,
): Promise<Outcome<{ visibility: Visibility }>> => {
  const loaded = await loadPublished(bucket, sub, tourId);
  if (!loaded.ok) return loaded.outcome;
  const done = await commit(bucket, sub, tourId, {
    current: loaded.current,
    record: { ...loaded.current.value, visibility },
    plan: [],
    bundle: { ...loaded.bundle.value, visibility },
    freshExpiresAt: freshExpiry(clock),
  });
  if (!done.ok) return failed(done.status);
  return { status: 200, body: { visibility } };
};

// Idempotent. Needs tour.json or publish.json under the caller as proof,
// since pub/ is owner-free. Deletes the slug only if it's a live pointer here.
export const unpublish = async (bucket: R2Bucket, sub: string, tourId: string): Promise<void> => {
  const [stored, tour] = await Promise.all([
    readPublishRecord(bucket, sub, tourId),
    bucket.head(tourKey(sub, tourId)),
  ]);
  if (!stored && !tour) return;
  if (stored) {
    const existing = await readSlug(bucket, stored.value.slug);
    const key = storedSlugKey(stored.value.slug);
    if (key && existing?.record?.kind === 'tour' && existing.record.tourId === tourId) {
      await bucket.delete(key);
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
