import {
  ExploreApprovalSchema,
  exploreApprovedKey,
  EXPLORE_INDEX_ROOT,
  EXPLORE_PENDING_ROOT,
  EXPLORE_RANK_MAX,
  ExploreCoverSchema,
  exploreCursorOf,
  exploreEntryKey,
  exploreHiddenKey,
  explorePendingKey,
  ExplorePendingSchema,
  ExplorePointerSchema,
  exploreTourKey,
  manifestKey,
  type ExploreApproval,
  type ExploreCover,
  type ExploreEntry,
  type ExplorePending,
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
//
// A tour is listed only with the operator's approval (explore/approved/), which names
// the fingerprint of the bundle approved. A listable tour without a matching one waits
// in the queue (explore/pending/) instead, so any change to what a listed tour shows
// takes it off the list until the operator has looked again.

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
 * `keepPlace` keeps a readable pointer: the entry key it names is the tour's
 * listing time, so listing the tour again puts it back where it was rather than
 * on top as new (a spammer can't bump a tour by switching it off and on).
 */
export const removeFromExplore = async (
  bucket: R2Bucket,
  tourId: string,
  {
    keepPlace = false,
    keepApproval = keepPlace,
  }: { keepPlace?: boolean; keepApproval?: boolean } = {},
): Promise<void> => {
  // Out of the queue either way. A tour leaving for good (delete, takedown) loses its
  // approval too; one only paused (Unlisted, Stop sharing, a scene not ready) keeps it, so
  // the same content listed again needs no second look.
  await bucket.delete(
    keepApproval
      ? explorePendingKey(tourId)
      : [explorePendingKey(tourId), exploreApprovedKey(tourId)],
  );
  await removeEntry(bucket, tourId, keepPlace);
};

// The entry and (unless keepPlace) its pointer; removeFromExplore's second half.
const removeEntry = async (bucket: R2Bucket, tourId: string, keepPlace: boolean) => {
  const stored = await readPointer(bucket, tourId);
  if (!stored) return;
  if (stored.pointer) await bucket.delete(stored.pointer.key);
  else await deleteEntriesByScan(bucket, tourId);
  if (keepPlace && stored.pointer) return;
  await bucket.delete(exploreTourKey(tourId));
};

/** JSON with object keys sorted at every level, so equal content always reads the same. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/**
 * What the operator approves: SHA-256 (hex) of everything a visitor sees in the bundle.
 * Left out: Public or Unlisted (only decides whether it is listed), the first publish
 * time, and the new-account hold, none of which change the content.
 */
export const bundleFingerprint = async (bundle: PublishedTour): Promise<string> => {
  const { visibility: _v, publishedAt: _p, heldUntil: _h, ...content } = bundle;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(content)),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const readApproval = async (bucket: R2Bucket, tourId: string): Promise<ExploreApproval | null> => {
  const got = await getJson<unknown>(bucket, exploreApprovedKey(tourId));
  const parsed = got ? ExploreApprovalSchema.safeParse(got.value) : null;
  return parsed?.success ? parsed.data : null;
};

/**
 * Deletes the tour's approval unless it names this bundle. Publish runs it before writing
 * the bundle, and lets an error fail the publish: public-api lists any tour with an
 * approval, so one for other content must be gone before the new content goes live.
 */
export const revokeStaleApproval = async (
  bucket: R2Bucket,
  bundle: PublishedTour,
): Promise<boolean> => {
  const key = exploreApprovedKey(bundle.tourId);
  const got = await getJson<unknown>(bucket, key);
  if (!got) return false;
  const parsed = ExploreApprovalSchema.safeParse(got.value);
  if (parsed.success && parsed.data.fingerprint === (await bundleFingerprint(bundle))) return false;
  await bucket.delete(key);
  return true;
};

// Puts the tour in the operator's queue, or refreshes its place there; queuedAt is kept.
const queueForApproval = async (
  bucket: R2Bucket,
  bundle: PublishedTour,
  cover: ExploreCover | null,
  fingerprint: string,
  reason: ExplorePending['reason'],
  now: Date,
): Promise<void> => {
  const key = explorePendingKey(bundle.tourId);
  const got = await getJson<unknown>(bucket, key).catch(() => null);
  const prior = got ? ExplorePendingSchema.safeParse(got.value) : null;
  const pending: ExplorePending = {
    v: 1,
    tourId: bundle.tourId,
    slug: bundle.slug,
    title: bundle.title,
    sceneCount: bundle.scenes.length,
    cover,
    fingerprint,
    // A tour already waiting as changed stays changed: it was approved once.
    reason: prior?.success && prior.data.reason === 'changed' ? 'changed' : reason,
    queuedAt: prior?.success ? prior.data.queuedAt : now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await putJson(bucket, key, pending);
};

/**
 * Brings the tour's entry in line with the bundle just written: listed while it is
 * Public, has a ready start scene and isn't hidden by the operator; removed
 * otherwise, keeping its place for when it is listed again. Pointer before entry,
 * so an entry never exists without one. A first listing is filed at the bundle's
 * heldUntil when that is later than now (a new account): public-api only lists
 * entries filed at or before the current time, so the tour shows up, as new, once
 * the hold ends, with no Save needed.
 */
export const syncExplore = async (
  bucket: R2Bucket,
  bundle: PublishedTour,
  now: Date,
  // The caller has just revoked an approval for other content (revokeStaleApproval).
  { revoked = false }: { revoked?: boolean } = {},
) => {
  const { tourId } = bundle;
  const listable =
    bundle.visibility === 'public' &&
    bundle.scenes.length > 0 &&
    !(await bucket.head(exploreHiddenKey(tourId)));
  if (!listable) {
    await removeFromExplore(bucket, tourId, { keepPlace: true });
    return;
  }
  const ready = await readCover(bucket, bundle.startPanoId);
  if (!ready) {
    // Only paused until its start scene is ready: it keeps its approval, or its place in
    // the queue.
    await removeEntry(bucket, tourId, true);
    return;
  }
  const fingerprint = await bundleFingerprint(bundle);
  const approval = await readApproval(bucket, tourId);
  if (approval?.fingerprint !== fingerprint) {
    // The approval goes first: public-api lists nothing without one, so the tour is off
    // the list even if removing its entry fails below.
    if (approval) await bucket.delete(exploreApprovedKey(tourId));
    await removeEntry(bucket, tourId, true);
    await queueForApproval(
      bucket,
      bundle,
      ready.cover,
      fingerprint,
      approval || revoked ? 'changed' : 'new',
      now,
    );
    return;
  }
  await bucket.delete(explorePendingKey(tourId));
  const stored = await readPointer(bucket, tourId);
  // An unreadable pointer can't name its entry: drop whatever is filed under the tour first.
  if (stored && !stored.pointer) await deleteEntriesByScan(bucket, tourId);
  const kept = stored?.pointer ? listedAtOf(stored.pointer.key) : null;
  const held = bundle.heldUntil ? Date.parse(bundle.heldUntil) : NaN;
  const listedAtMs = kept ?? (held > now.getTime() ? held : now.getTime());
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
  opts: { revoked?: boolean } = {},
): Promise<void> => {
  try {
    await syncExplore(bucket, bundle, now, opts);
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

/** The operator's queue: every tour waiting for approval, oldest first. */
export const listApprovalQueue = async (bucket: R2Bucket): Promise<ExplorePending[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: EXPLORE_PENDING_ROOT, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const read = await Promise.all(
    keys.map(async (key) => {
      const got = await getJson<unknown>(bucket, key).catch(() => null);
      const parsed = got ? ExplorePendingSchema.safeParse(got.value) : null;
      return parsed?.success ? parsed.data : null;
    }),
  );
  return read
    .filter((p): p is ExplorePending => p !== null)
    .sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0));
};

export type DecisionOutcome = 'done' | 'stale';

/** Whether the tour waits in the queue as the operator saw it (`fingerprint`). */
const waitsAs = async (bucket: R2Bucket, tourId: string, fingerprint: string) => {
  const got = await getJson<unknown>(bucket, explorePendingKey(tourId));
  const parsed = got ? ExplorePendingSchema.safeParse(got.value) : null;
  return parsed?.success === true && parsed.data.fingerprint === fingerprint;
};

/**
 * The operator's approval of the version they looked at (`fingerprint`): recorded, then
 * the tour listed from it. Stale when the tour no longer waits as that version (changed,
 * hidden, unpublished) or its live bundle differs. Runs in the tour's TourPublisher, so
 * no publish or hide lands between the checks and the write.
 */
export const approveForExplore = async (
  bucket: R2Bucket,
  bundle: PublishedTour | null,
  fingerprint: string,
  now: Date,
): Promise<DecisionOutcome> => {
  if (!bundle || !(await waitsAs(bucket, bundle.tourId, fingerprint))) return 'stale';
  if ((await bundleFingerprint(bundle)) !== fingerprint) return 'stale';
  const approval: ExploreApproval = { v: 1, approvedAt: now.toISOString(), fingerprint };
  await putJson(bucket, exploreApprovedKey(bundle.tourId), approval);
  await syncExplore(bucket, bundle, now);
  return 'done';
};

/**
 * The operator's rejection of the version they looked at: the hide (setExploreHidden).
 * Stale, and nothing hidden, when the tour no longer waits as that version. In the
 * TourPublisher, like approve.
 */
export const rejectForExplore = async (
  bucket: R2Bucket,
  tourId: string,
  fingerprint: string,
  now: Date,
): Promise<DecisionOutcome> => {
  if (!(await waitsAs(bucket, tourId, fingerprint))) return 'stale';
  await setExploreHidden(bucket, tourId, true, now, null);
  return 'done';
};
