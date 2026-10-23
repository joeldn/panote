import {
  ACCOUNTS_ROOT,
  accountDeletionKey,
  AccountDeletionRecordSchema,
  accountSinceKey,
  MARKER_MAX_LINKED_SUBS,
  PANO_PATTERN,
  SlugRecordSchema,
  storedSlugKey,
  tilesPrefix,
  tourKey,
  tourOwnerKey,
  userPanosPrefix,
  userToursPrefix,
  userMembershipsPrefix,
  userUploadedForPrefix,
  userUploadLogPrefix,
  type AccountDeletionRecord,
} from '@internal/contracts';
import { deletePrefix, getJson, listChildren, putJson } from '@internal/worker-kit/r2-binding';

import { deletePano } from './delete-pano.js';
import { forgetMembers, leaveAllTours } from './members.js';
import { isAccountDisabled } from './operator.js';
import { deleteFromTrash } from './trash.js';
import { deletePlans } from './plans.js';
import { readPublishRecord } from './publish.js';
import { mergePurges, type CdnPurge } from './purge.js';
import { REFERENCE_CONCURRENCY } from './references.js';
import { holdSlug } from './slug-hold.js';

// How long a finished deletion's marker stays: the account stays read-only and
// the daily sweep keeps catching late writes (a presigned upload lives 600s).
// Matches the "sign-in record removed within 30 days" promise in the UI copy.
export const ACCOUNT_MARKER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Every log line about account deletion starts with this, so the operator can
// filter Workers observability for it. Lines never carry the sub or a key.
export const LOG_PREFIX = '[account-deletion]';

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

/**
 * The subs whose data goes with the account: its own, then the identities linked into it
 * (the token's linked subs, see "Account linking" in docs/deploy.md). Data made under one
 * of those before it was linked would otherwise be left behind with no way to reach it.
 * Linked subs a completed run already deleted (`completedLinkedSubs`) aren't included.
 */
export const ownersOf = (
  record: Pick<AccountDeletionRecord, 'sub' | 'linkedSubs' | 'completedLinkedSubs'>,
): string[] => {
  const done = new Set([record.sub, ...(record.completedLinkedSubs ?? [])]);
  return [record.sub, ...new Set((record.linkedSubs ?? []).filter((s) => !done.has(s)))];
};

/**
 * Read-modify-write of the marker, conditional on the ETag it read, so two writers (a
 * retry adding linked subs, the sweep stamping completedAt) can't drop each other's
 * change. `change` returns null to leave the marker as it is. On a lost race it reads
 * again and retries once, then throws. False when the marker is missing or unreadable.
 */
const updateMarker = async (
  bucket: R2Bucket,
  sub: string,
  change: (record: AccountDeletionRecord) => AccountDeletionRecord | null,
): Promise<boolean> => {
  const key = accountDeletionKey(sub);
  for (let attempt = 0; attempt < 2; attempt++) {
    const got = await getJson<unknown>(bucket, key).catch(() => null);
    const parsed = got ? AccountDeletionRecordSchema.safeParse(got.value) : null;
    if (!got || !parsed?.success) return false;
    const next = change(parsed.data);
    if (!next) return true;
    if ((await putJson(bucket, key, next, { etagMatches: got.etag })).ok) return true;
  }
  throw new Error('account deletion marker changed while it was being updated');
};

/**
 * Create-only, so a retry keeps the first requestedAt (and any completedAt). A retry
 * whose token names linked subs the marker doesn't have yet adds them. On a completed
 * marker it also takes off completedAt and moves the subs already done to
 * completedLinkedSubs, so the reopened delete covers the account and the new subs only.
 */
export const markAccountForDeletion = async (
  bucket: R2Bucket,
  sub: string,
  now: Date,
  linkedSubs: readonly string[] = [],
): Promise<void> => {
  const linked = ownersOf({ sub, linkedSubs: [...linkedSubs] }).slice(1);
  const record: AccountDeletionRecord = {
    v: 1,
    sub,
    requestedAt: now.toISOString(),
    ...(linked.length > 0 && { linkedSubs: linked }),
  };
  const created = await putJson(bucket, accountDeletionKey(sub), record, {
    etagDoesNotMatch: '*',
  });
  if (created.ok) return;
  const readable = await updateMarker(bucket, sub, (existing) => {
    const known = new Set(existing.linkedSubs);
    if (linked.every((s) => known.has(s))) return null;
    // Capped at the schema's bound, or the marker would stop parsing (the sweep would skip
    // it and the next request rewrite it). The ones already there are kept first.
    const all = [...new Set([...(existing.linkedSubs ?? []), ...linked])].filter((s) => s !== sub);
    if (all.length > MARKER_MAX_LINKED_SUBS) {
      console.error(
        `${LOG_PREFIX} more linked subs than a marker holds; the extra ones are left out`,
      );
    }
    const kept = all.slice(0, MARKER_MAX_LINKED_SUBS);
    if (kept.length === (existing.linkedSubs ?? []).length) return null;
    if (!existing.completedAt) return { ...existing, linkedSubs: kept };
    // Reopened: everything the marker named so far is done; only the new subs are pending.
    const { completedAt: _done, ...open } = existing;
    const completed = new Set([
      ...(existing.completedLinkedSubs ?? []),
      ...(existing.linkedSubs ?? []),
    ]);
    return {
      ...open,
      linkedSubs: kept,
      completedLinkedSubs: [...completed].slice(0, MARKER_MAX_LINKED_SUBS),
    };
  });
  // An unreadable marker still blocks writes; rewrite it so the sweep can read it.
  if (!readable) await putJson(bucket, accountDeletionKey(sub), record);
};

/**
 * Stamps completedAt once; later sweeps keep the first one, so retention runs from it.
 * `deleted` are the owners whose data was just deleted: if the marker names a linked sub
 * that isn't among them (a request added it meanwhile), it isn't stamped, and the next
 * sweep deletes that sub too.
 */
const markComplete = async (
  bucket: R2Bucket,
  sub: string,
  now: Date,
  deleted: readonly string[],
): Promise<void> => {
  const done = new Set(deleted);
  let stamped = false;
  await updateMarker(bucket, sub, (record) => {
    stamped = !record.completedAt && ownersOf(record).every((owner) => done.has(owner));
    return stamped ? { ...record, completedAt: now.toISOString() } : null;
  });
  if (!stamped) return;
  console.warn(
    `${LOG_PREFIX} account deleted: remove its Auth0 user within ${ACCOUNT_MARKER_DAYS} days (delete-account.ts --list)`,
  );
};

// Redirect aliases this tour still owns. unpublish releases them too; this keeps
// the account delete from depending on it for that.
const deleteAliases = async (bucket: R2Bucket, sub: string, tourId: string): Promise<string[]> => {
  const stored = await readPublishRecord(bucket, sub, tourId);
  const removed: string[] = [];
  for (const slug of stored?.value.aliases ?? []) {
    const key = storedSlugKey(slug);
    const record = key ? await readParsed(bucket, key, SlugRecordSchema) : null;
    if (key && record?.tourId === tourId) {
      // Held like any released slug, so nobody takes over the old share link.
      await holdSlug(bucket, sub, slug, new Date());
      await bucket.delete(key);
      removed.push(key);
    }
  }
  return removed;
};

// The name only: R2 error messages can carry keys, and keys carry the owner.
const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown error');

// What one sweep run deletes at most, counted in tours plus panos, and the most
// one account may take of it, so a huge account can't starve the others. What
// a run doesn't reach waits for the next day; nothing is lost.
export const SWEEP_ITEM_BUDGET = 400;
export const SWEEP_ACCOUNT_ITEM_BUDGET = 100;

/** Items still allowed; deleteAccountData counts it down. */
export type Budget = { items: number };

const take = (ids: readonly string[], budget: Budget | undefined): readonly string[] => {
  if (!budget) return ids;
  const taken = ids.slice(0, Math.max(0, budget.items));
  budget.items -= taken.length;
  return taken;
};

const inBatches = async (ids: readonly string[], run: (id: string) => Promise<void>) => {
  for (let i = 0; i < ids.length; i += REFERENCE_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + REFERENCE_CONCURRENCY).map(run));
  }
};

const deleteOwnedTour = async (
  deps: AccountDeps,
  sub: string,
  tourId: string,
  purge: CdnPurge,
): Promise<void> => {
  const { bucket } = deps;
  // Tour ids come from the same crypto.randomUUID() and PANO_PATTERN check as pano
  // ids (POST and tourIdError in index.ts), so PANO_PATTERN is their validator too.
  // An id that fails it can't have a publish.json or a bundle (publishKey and
  // pubTourKey refuse it), so only its stats and its prefix are left to delete.
  if (PANO_PATTERN.test(tourId)) {
    const unpublish = async () => {
      purge.files.push(...(await deleteAliases(bucket, sub, tourId)));
      purge.files.push(...(await deps.unpublishTour(sub, tourId)));
    };
    await unpublish();
    // Its plan images are public and owner-free: they don't go with the owner's prefix.
    purge.files.push(...(await deletePlans(bucket, tourId)));
    // Editors' index entries live under their own prefixes; members.json goes with ours.
    await forgetMembers(bucket, sub, tourId);
    // While tour.json exists a retry lists this tour again, so stats go before it.
    await deps.clearStats(tourId);
    await bucket.delete(tourKey(sub, tourId));
    await bucket.delete(tourOwnerKey(tourId));
    // As tour delete does: a publish queued behind the first unpublish still saw
    // tour.json and republished. Any publish after this sees no tour.json and
    // unpublishes itself (publish.ts commit).
    await unpublish();
  }
  // Again for a valid id: counts a republished tour picked up in between.
  await deps.clearStats(tourId);
  await deletePrefix(bucket, `${userToursPrefix(sub)}${tourId}/`);
};

/**
 * Deletes every tour (with its slug, aliases, public bundle and stats), every
 * pano (original, to the trash unless the owner is disabled; config; tiles) the
 * owner has, and then upload-api's log of
 * the upload URLs it issued them (upload-log/<owner>/). Idempotent: each tour's or pano's
 * own key or prefix goes last, so after an interruption it still lists and a
 * rerun finishes it. Adds what to purge from the CDN to `purge` as it goes, so a
 * partial run's purge isn't lost. With a `budget`, stops after that many tours
 * and panos; returns whether it got through everything.
 */
export const deleteAccountData = async (
  deps: AccountDeps,
  sub: string,
  purge: CdnPurge,
  budget?: Budget,
): Promise<boolean> => {
  const { bucket } = deps;
  // Tours first: a published tour comes down before any of its images do.
  const tourIds = await listChildren(bucket, userToursPrefix(sub));
  const tours = take(tourIds, budget);
  await inBatches(tours, (tourId) => deleteOwnedTour(deps, sub, tourId, purge));
  if (tours.length < tourIds.length) return false;

  // Originals go to the trash, as for any other delete, unless the operator disabled the
  // owner: that is a takedown (takedown.ts --close-account needs --disable-owner), whose
  // quarantine already keeps what must be kept, so nothing it closes lingers in trash/.
  const options = { trash: !(await isAccountDisabled(bucket, sub)), now: new Date() };
  const panosRoot = userPanosPrefix(sub);
  const panoIds = await listChildren(bucket, panosRoot);
  const panos = take(panoIds, budget);
  await inBatches(panos, async (panoId) => {
    if (!PANO_PATTERN.test(panoId)) {
      await deletePrefix(bucket, `${panosRoot}${panoId}/`);
      return;
    }
    if ((await deletePano(bucket, sub, panoId, options)).tilesDeleted) {
      purge.prefixes.push(tilesPrefix(panoId));
    }
  });
  if (panos.length < panoIds.length) return false;
  // A closed account's originals the owner deleted before the takedown went to the trash.
  if (!options.trash) await deleteFromTrash(bucket, panosRoot);
  // Off every tour they edit for someone else; at most MAX_MEMBERSHIPS, so not budgeted.
  await leaveAllTours(bucket, sub);
  // Small records, one per pano an editor uploaded here: not counted against the budget.
  await deletePrefix(bucket, userUploadedForPrefix(sub));
  // Empty objects, at most about a day's worth: not counted against the budget.
  await deletePrefix(bucket, userUploadLogPrefix(sub));
  // The account's age (account-age.ts): a later sign-up under the same sub starts again.
  await bucket.delete(accountSinceKey(sub));
  return true;
};

export type AccountDeleteResult = { status: 'deleted' | 'pending'; purge: CdnPurge };

/** deleteAccountData for each owner in turn; true once every one is done. */
const deleteOwnersData = async (
  deps: AccountDeps,
  owners: readonly string[],
  purge: CdnPurge,
  budget?: Budget,
): Promise<boolean> => {
  for (const owner of owners) {
    if (!(await deleteAccountData(deps, owner, purge, budget))) return false;
  }
  return true;
};

/**
 * The owner's DELETE /api/admin/account. The marker goes first, so a request
 * that dies part way leaves a read-only account the daily sweep finishes.
 * `linkedSubs` (from the token) are deleted along with it.
 */
export const deleteAccount = async (
  deps: AccountDeps,
  sub: string,
  now: Date,
  linkedSubs: readonly string[] = [],
): Promise<AccountDeleteResult> => {
  await markAccountForDeletion(deps.bucket, sub, now, linkedSubs);
  const purge: CdnPurge = { prefixes: [], files: [] };
  let owners = ownersOf({ sub, linkedSubs: [...linkedSubs] });
  try {
    // While the delete is open, from the marker, so a retry also covers linked subs an
    // earlier request named. Once complete, only what this token names: a linked sub on
    // the marker that this user no longer has may be a new, separate user by now.
    const record = await readMarker(deps.bucket, sub);
    if (record && !record.completedAt) owners = ownersOf(record);
    await deleteOwnersData(deps, owners, purge);
  } catch (e) {
    console.error(`${LOG_PREFIX} delete interrupted, the daily sweep resumes it:`, errorName(e));
    return { status: 'pending', purge: mergePurges(purge) };
  }
  await markComplete(deps.bucket, sub, now, owners);
  return { status: 'deleted', purge: mergePurges(purge) };
};

// One cheap LIST per prefix: whether anything is left (a late upload, say).
const hasData = async (bucket: R2Bucket, owners: readonly string[]): Promise<boolean> => {
  for (const sub of owners) {
    for (const prefix of [
      userToursPrefix(sub),
      userPanosPrefix(sub),
      userUploadLogPrefix(sub),
      userMembershipsPrefix(sub),
      userUploadedForPrefix(sub),
    ]) {
      if ((await bucket.list({ prefix, limit: 1 })).objects.length > 0) return true;
    }
  }
  return false;
};

type Marker = { key: string; record: AccountDeletionRecord };

const listMarkers = async (bucket: R2Bucket): Promise<Marker[]> => {
  const markers: Marker[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: ACCOUNTS_ROOT, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) {
      // accounts/<owner>/ also holds the operator's disabled.json, which isn't ours.
      if (!obj.key.endsWith('/deletion.json')) continue;
      const record = await readParsed(bucket, obj.key, AccountDeletionRecordSchema);
      // The sub decides which prefixes get deleted, so it must be this marker's own.
      if (!record || accountDeletionKey(record.sub) !== obj.key) {
        console.error(`${LOG_PREFIX} marker unreadable or misfiled, skipped`);
        continue;
      }
      markers.push({ key: obj.key, record });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Interrupted deletes first, oldest request first; finished ones after them.
  return markers.sort(
    (a, b) =>
      Number(!!a.record.completedAt) - Number(!!b.record.completedAt) ||
      a.record.requestedAt.localeCompare(b.record.requestedAt),
  );
};

/**
 * Daily cron: finishes interrupted deletes, catches anything written after a
 * finished one (a finished account only costs a LIST per prefix unless something
 * is there), and drops a marker ACCOUNT_MARKER_DAYS after completion, once the
 * account is still empty. One account failing doesn't stop the others.
 */
export const sweepAccountDeletions = async (
  deps: AccountDeps,
  now: Date,
  budget: Budget = { items: SWEEP_ITEM_BUDGET },
  perAccount = SWEEP_ACCOUNT_ITEM_BUDGET,
): Promise<CdnPurge> => {
  const purge: CdnPurge = { prefixes: [], files: [] };
  let retained = 0;
  for (const { key, record } of await listMarkers(deps.bucket)) {
    const { sub, completedAt } = record;
    // Linked subs only until the delete completes. After that, data under one of them can
    // only come from a new, separate user with that provider id (the Auth0 user was
    // removed and they signed up again, or the operator unlinked it): not ours to delete.
    const owners = completedAt ? [sub] : ownersOf(record);
    try {
      let done = true;
      if (!completedAt || (await hasData(deps.bucket, owners))) {
        const mine: Budget = { items: Math.min(budget.items, perAccount) };
        const allowed = mine.items;
        done = await deleteOwnersData(deps, owners, purge, mine);
        budget.items -= allowed - mine.items;
      }
      if (!done) continue;
      const expired =
        !!completedAt && now.getTime() - Date.parse(completedAt) >= ACCOUNT_MARKER_DAYS * DAY_MS;
      if (expired) {
        await deps.bucket.delete(key);
        continue;
      }
      if (!completedAt) await markComplete(deps.bucket, sub, now, owners);
      retained += 1;
    } catch (e) {
      console.error(`${LOG_PREFIX} sweep failed for one account:`, errorName(e));
    }
  }
  if (retained > 0) {
    console.warn(
      `${LOG_PREFIX} ${retained} deleted account(s) in their ${ACCOUNT_MARKER_DAYS}-day window: check each Auth0 user is removed (delete-account.ts --list)`,
    );
  }
  return mergePurges(purge);
};
