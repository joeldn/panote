import {
  configKey,
  DEFAULT_TOUR_SETTINGS,
  defaultSlugCandidates,
  deletingKey,
  manifestKey,
  originalKey,
  pickTranslations,
  publishKey,
  pubTourKey,
  sharingStoppedKey,
  slugKey,
  storedSlugKey,
  SlugRecordSchema,
  SLUGS_ROOT,
  tourKey,
  translationLanguages,
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

import { removeFromExplore, syncExploreQuietly } from './explore.js';

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

// Only the tour's own languages are published: a config is per pano, so it can hold
// translations another tour of the owner added.
function keepTranslations<T extends { i18n?: Record<string, unknown> | undefined }>(
  doc: T,
  keep: ReadonlySet<string>,
): T {
  if (!doc.i18n) return doc;
  const { i18n, ...rest } = doc;
  const kept = pickTranslations(i18n, keep);
  return (kept ? { ...rest, i18n: kept } : rest) as T;
}

// Link hotspots must stay inside the tour: a foreign target is dropped rather
// than 422'd, since every Save publishes.
const publicHotspots = (
  config: SceneConfig,
  sceneIds: ReadonlySet<string>,
  langs: ReadonlySet<string>,
): SceneConfig => ({
  ...keepTranslations(config, langs),
  hotspots: config.hotspots.flatMap((hotspot): Hotspot[] => {
    const h = keepTranslations(hotspot, langs);
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
  const langs = translationLanguages(tour.languages);
  const i18n = pickTranslations(tour.i18n, langs);
  return {
    v: 1,
    tourId: tour.tourId,
    title: tour.title,
    // A blank description is no description: leave it out, so readers have one case.
    ...(tour.description ? { description: tour.description } : {}),
    visibility: state.visibility,
    slug: state.slug,
    publishedAt: state.publishedAt,
    settings: tour.settings ?? DEFAULT_TOUR_SETTINGS,
    ...(tour.languages && { languages: tour.languages }),
    ...(i18n && { i18n }),
    startPanoId,
    scenes: tour.scenes.map((s) => ({
      panoId: s.panoId,
      ...(s.mapX !== undefined ? { mapX: s.mapX } : {}),
      ...(s.mapY !== undefined ? { mapY: s.mapY } : {}),
      config: publicHotspots(configs.get(s.panoId) as SceneConfig, sceneIds, langs),
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
  // The tour's own current slug was valid when claimed: a word reserved since
  // (RESERVED_SLUGS) must not stop it republishing. A new slug is checked in full.
  const key = slug === currentSlug ? storedSlugKey(slug) : slugKey(slug);
  if (!key) return 'taken';
  // Bounded retry: each loop only repeats after the key changed under us.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = await putJson(bucket, key, pointer, { etagDoesNotMatch: '*' }, pointerMetadata);
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
      key,
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

// Most redirect aliases one tour may hold at once: a slug change that would make
// one more is refused (TOO_MANY_RENAMES) until the oldest expires, so a tour can't
// squat slugs by renaming. Every alias stays tracked in publish.json (Q6 redirects
// last SLUG_ALIAS_DAYS), and unpublish releases them.
export const MAX_ALIASES = 5;

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
const SHARING_STOPPED = { status: 409, body: { error: 'sharing stopped' } } as const;
const TOO_MANY_RENAMES = { status: 409, body: { error: 'too many renames' } } as const;

// A slug change leaves the current slug behind as one more alias.
const overAliasCap = (plan: AliasPlan, from: string | undefined, to: string): boolean =>
  from !== undefined && from !== to && plan.length > MAX_ALIASES;

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
  // The metadata lets public-api's Explore check a listed tour with a HEAD.
  await putJson(bucket, pubTourKey(tourId), c.bundle, undefined, {
    visibility: c.bundle.visibility,
    slug: c.bundle.slug,
  });
  // A tour deleted meanwhile (the delete itself isn't serialized) must not stay public.
  if (!(await bucket.head(tourKey(sub, tourId)))) {
    await unpublish(bucket, sub, tourId);
    return { ok: false, status: 404 };
  }
  await syncExploreQuietly(bucket, c.bundle, new Date());
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
export type PublishRequest = {
  slug?: string | undefined;
  visibility?: Visibility | undefined;
  afterSave?: boolean | undefined;
};

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
  // Q3 still holds for a tour never shared; one the owner stopped sharing stays off
  // until they share it again from the share modal.
  const stopped = sharingStoppedKey(sub, tourId);
  if (req.afterSave && (await bucket.head(stopped))) return SHARING_STOPPED;
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
  // Planned before the claim, so a refused rename claims nothing. A default slug
  // only happens on a first publish, which has no aliases to plan.
  const plan = target !== undefined ? await planAliases(bucket, tourId, cur, target) : [];
  if (target !== undefined && overAliasCap(plan, cur?.slug, target)) return TOO_MANY_RENAMES;
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

  // Cleared before the commit: a crash between the two leaves the tour unshared
  // with no marker, and the owner asked to share it, so the next Save may publish.
  if (!req.afterSave) await bucket.delete(stopped);
  const record: PublishRecord = {
    slug,
    visibility: req.visibility ?? cur?.visibility ?? DEFAULT_VISIBILITY,
    publishedAt: cur?.publishedAt ?? clock.now.toISOString(),
    aliases: plan.map((a) => a.slug),
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
  const plan = await planAliases(bucket, tourId, cur, target);
  if (overAliasCap(plan, cur.slug, target)) return TOO_MANY_RENAMES;
  const result = await claimSlug(bucket, target, tourId, cur.slug);
  if (result === 'taken') return SLUG_TAKEN;
  const record: PublishRecord = { ...cur, slug: target, aliases: plan.map((a) => a.slug) };
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

// Idempotent; needs tour.json or publish.json as proof (pub/ is owner-free). Deletes the
// slug only if it's a live pointer here, and the tracked aliases still naming this tour:
// they redirect to a slug that is gone, and left in place they would hold their names
// for SLUG_ALIAS_DAYS after every publish, rename, unpublish cycle. Returns the public
// keys to purge (B6). `stopSharing` (the owner's "Stop sharing", or a takedown) also
// leaves the sharing-stopped marker, so the editor's next Save doesn't publish it again.
export const unpublish = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
  { stopSharing = false }: { stopSharing?: boolean } = {},
): Promise<string[]> => {
  const [stored, tour] = await Promise.all([
    readPublishRecord(bucket, sub, tourId),
    bucket.head(tourKey(sub, tourId)),
  ]);
  if (!stored && !tour) return [];
  // First, so a crash partway still leaves the tour off for the next Save.
  if (stopSharing && tour) {
    await putJson(bucket, sharingStoppedKey(sub, tourId), { stoppedAt: new Date().toISOString() });
  }
  const removed: string[] = [];
  if (stored) {
    const existing = await readSlug(bucket, stored.value.slug);
    const key = storedSlugKey(stored.value.slug);
    if (key && existing?.record?.kind === 'tour' && existing.record.tourId === tourId) {
      await bucket.delete(key);
      removed.push(key);
    }
    // At most MAX_ALIASES (legacy records up to 20), so all at once.
    const released = await Promise.all(
      [...new Set(stored.value.aliases ?? [])].map(async (alias) => {
        const aliasKey = storedSlugKey(alias);
        const record = aliasKey ? (await readSlug(bucket, alias))?.record : null;
        if (!aliasKey || record?.kind !== 'redirect' || record.tourId !== tourId) return null;
        await bucket.delete(aliasKey);
        return aliasKey;
      }),
    );
    for (const key of released) if (key) removed.push(key);
  }
  await bucket.delete(pubTourKey(tourId));
  // Not best-effort: an error leaves publish.json, so a retry still finds the tour.
  await removeFromExplore(bucket, tourId);
  await bucket.delete(publishKey(sub, tourId));
  return [pubTourKey(tourId), ...removed];
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
