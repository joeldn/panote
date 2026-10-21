import {
  ACCOUNTS_ROOT,
  accountDeletionKey,
  AccountDeletionRecordSchema,
  PANO_PATTERN,
  SlugRecordSchema,
  storedSlugKey,
  tilesPrefix,
  userPanosPrefix,
  userToursPrefix,
  type AccountDeletionRecord,
} from '@internal/contracts';
import { deletePrefix, getJson, listChildren, putJson } from '@internal/worker-kit/r2-binding';

import { deletePano } from './delete-pano.js';
import { readPublishRecord } from './publish.js';
import { mergePurges, type CdnPurge } from './purge.js';
import { REFERENCE_CONCURRENCY } from './references.js';

// How long a finished deletion's marker stays: the account stays read-only and
// the daily sweep keeps catching late writes (a presigned upload lives 900s).
// Matches the "sign-in record removed within 30 days" promise in the UI copy.
export const ACCOUNT_MARKER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AccountDeps = {
  bucket: R2Bucket;
  /** Through the tour's TourPublisher, as tour delete does; returns keys to purge. */
  unpublishTour: (sub: string, tourId: string) => Promise<string[]>;
  /** Clears public-api's view/like counters for the tour. */
  clearStats: (tourId: string) => Promise<void>;
};

// Null for a missing or unparsable object, instead of getJson's throw.
const readParsed = async <T>(
  bucket: R2Bucket,
  key: string,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
): Promise<T | null> => {
  const got = await getJson<unknown>(bucket, key).catch(() => null);
  const parsed = got ? schema.safeParse(got.value) : null;
  return parsed?.success ? parsed.data : null;
};

const readMarker = (bucket: R2Bucket, sub: string): Promise<AccountDeletionRecord | null> =>
  readParsed(bucket, accountDeletionKey(sub), AccountDeletionRecordSchema);

/** True once the owner asked for deletion: every owner write is refused from then on. */
export const isAccountDeleted = async (bucket: R2Bucket, sub: string): Promise<boolean> =>
  !!(await bucket.head(accountDeletionKey(sub)));

/** Create-only, so a retry keeps the first requestedAt (and any completedAt). */
export const markAccountForDeletion = async (
  bucket: R2Bucket,
  sub: string,
  now: Date,
): Promise<void> => {
  const record: AccountDeletionRecord = { v: 1, sub, requestedAt: now.toISOString() };
  const created = await putJson(bucket, accountDeletionKey(sub), record, {
    etagDoesNotMatch: '*',
  });
  // An unreadable marker still blocks writes; rewrite it so the sweep can read it.
  if (!created.ok && !(await readMarker(bucket, sub))) {
    await putJson(bucket, accountDeletionKey(sub), record);
  }
};

/** Stamps completedAt once; later sweeps keep the first one, so retention runs from it. */
const markComplete = async (bucket: R2Bucket, sub: string, now: Date): Promise<void> => {
  const record = await readMarker(bucket, sub);
  if (!record || record.completedAt) return;
  await putJson(bucket, accountDeletionKey(sub), { ...record, completedAt: now.toISOString() });
};

// Redirect aliases this tour still owns. unpublish only removes the live slug and
// leaves aliases to expire; an account delete removes them now.
const deleteAliases = async (bucket: R2Bucket, sub: string, tourId: string): Promise<string[]> => {
  const stored = await readPublishRecord(bucket, sub, tourId);
  const removed: string[] = [];
  for (const slug of stored?.value.aliases ?? []) {
    const key = storedSlugKey(slug);
    const record = key ? await readParsed(bucket, key, SlugRecordSchema) : null;
    if (key && record?.tourId === tourId) {
      await bucket.delete(key);
      removed.push(key);
    }
  }
  return removed;
};

// The name only: R2 error messages can carry keys, and keys carry the owner.
const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown error');

const inBatches = async (ids: readonly string[], run: (id: string) => Promise<void>) => {
  for (let i = 0; i < ids.length; i += REFERENCE_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + REFERENCE_CONCURRENCY).map(run));
  }
};

/**
 * Deletes every tour (with its slug, aliases, public bundle and stats) and every
 * pano (original, config, tiles) the owner has. Idempotent: each tour's or pano's
 * own prefix goes last, so after an interruption it still lists and a rerun
 * finishes it. Adds what to purge from the CDN to `purge` as it goes, so a
 * partial run's purge isn't lost.
 */
export const deleteAccountData = async (
  deps: AccountDeps,
  sub: string,
  purge: CdnPurge,
): Promise<void> => {
  const { bucket } = deps;
  const toursRoot = userToursPrefix(sub);
  // Tours first: a published tour comes down before any of its images do.
  await inBatches(await listChildren(bucket, toursRoot), async (tourId) => {
    // An id no route could have written can't be published either.
    if (PANO_PATTERN.test(tourId)) {
      purge.files.push(...(await deleteAliases(bucket, sub, tourId)));
      purge.files.push(...(await deps.unpublishTour(sub, tourId)));
      await deps.clearStats(tourId);
    }
    await deletePrefix(bucket, `${toursRoot}${tourId}/`);
  });
  const panosRoot = userPanosPrefix(sub);
  await inBatches(await listChildren(bucket, panosRoot), async (panoId) => {
    if (!PANO_PATTERN.test(panoId)) {
      await deletePrefix(bucket, `${panosRoot}${panoId}/`);
      return;
    }
    if ((await deletePano(bucket, sub, panoId)).tilesDeleted) {
      purge.prefixes.push(tilesPrefix(panoId));
    }
  });
};

export type AccountDeleteResult = { status: 'deleted' | 'pending'; purge: CdnPurge };

/**
 * The owner's DELETE /api/admin/account. The marker goes first, so a request
 * that dies part way leaves a read-only account the daily sweep finishes.
 */
export const deleteAccount = async (
  deps: AccountDeps,
  sub: string,
  now: Date,
): Promise<AccountDeleteResult> => {
  await markAccountForDeletion(deps.bucket, sub, now);
  const purge: CdnPurge = { prefixes: [], files: [] };
  try {
    await deleteAccountData(deps, sub, purge);
  } catch (e) {
    // Never log the sub. The sweep retries the whole account.
    console.error('account delete interrupted, the daily sweep resumes it:', errorName(e));
    return { status: 'pending', purge: mergePurges(purge) };
  }
  await markComplete(deps.bucket, sub, now);
  return { status: 'deleted', purge: mergePurges(purge) };
};

/**
 * Daily cron: reruns every marked account (finishing interrupted deletes and
 * catching late uploads), and drops markers ACCOUNT_MARKER_DAYS after completion.
 * One account failing doesn't stop the others.
 */
export const sweepAccountDeletions = async (deps: AccountDeps, now: Date): Promise<CdnPurge> => {
  const purge: CdnPurge = { prefixes: [], files: [] };
  let cursor: string | undefined;
  do {
    const page = await deps.bucket.list({ prefix: ACCOUNTS_ROOT, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) {
      const record = await readParsed(deps.bucket, obj.key, AccountDeletionRecordSchema);
      if (!record) {
        console.error('account deletion marker unreadable, skipped');
        continue;
      }
      const { sub, completedAt } = record;
      if (completedAt && now.getTime() - Date.parse(completedAt) >= ACCOUNT_MARKER_DAYS * DAY_MS) {
        await deps.bucket.delete(obj.key);
        continue;
      }
      try {
        await deleteAccountData(deps, sub, purge);
        await markComplete(deps.bucket, sub, now);
      } catch (e) {
        console.error('account deletion sweep failed for one account:', errorName(e));
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return mergePurges(purge);
};
