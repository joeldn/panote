import {
  ACCOUNTS_ROOT,
  BACKUP_DATE_PATTERN,
  BACKUP_PROGRESS_KEY,
  BACKUP_ROOT,
  BACKUP_SOURCES,
  backupCompleteKey,
  BackupCompleteRecordSchema,
  backupKey,
  backupSetPrefix,
  BackupProgressSchema,
  encodeId,
  EXPLORE_ROOT,
  exploreCursorOf,
  PUB_TOURS_ROOT,
  SLUGS_ROOT,
  SlugRecordSchema,
  TOUR_OWNERS_ROOT,
  tourOwnerKey,
  tourIdOfPlanKey,
  TourOwnerRecordSchema,
  type BackupCompleteRecord,
  type BackupProgress,
  type OperatorRestoreOk,
} from '@internal/contracts';

// Daily backup of the JSON that defines user content, and the tours' floor-plan images
// (BACKUP_SOURCES in @internal/contracts), copied to backup/<YYYY-MM-DD>/<original key> in the same
// bucket and kept BACKUP_RETENTION_DAYS. It runs on its own cron (BACKUP_CRON,
// every 15 minutes), so it has an invocation's subrequest budget, shared only with the
// small, capped retry of queued CDN purges (purge.ts, RETRY_RUN_*).
// Each run does at most BACKUP_RUN_BUDGET R2 operations and records where it got
// to in backup/progress.json; the next run carries on from there, past midnight if
// it must, and a new day's set starts only once the last one is complete. Once a
// set is whole a run writes backup/<date>/complete.json and prunes old sets; after
// that, until the next UTC day, a run costs one GET and one HEAD. See "Backups" in
// docs/deploy.md for the limits and how to restore.
//
// Two runs never write the same set at once: a run takes a lease (`lockedUntil` in
// progress.json, a conditional PUT on the record it read) before it copies anything, and a
// run that finds a live lease does nothing. The lease outlasts any run, since Cloudflare
// stops a Cron Trigger invocation after 15 minutes of wall time; a run that dies keeps
// the next one (15 minutes later) out, and the one after carries on.

/** The cron expression (wrangler.jsonc, both envs) that runs the backup, not the daily sweeps. */
export const BACKUP_CRON = '*/15 * * * *';
export const BACKUP_RETENTION_DAYS = 30;
// R2 operations (each one a subrequest) one run makes at most: a copy is a GET and
// a PUT. Under the Workers per-invocation subrequest limit with room to spare, so a slow R2
// or a retry can't take a run over it.
export const BACKUP_RUN_BUDGET = 900;
// Objects copied at once. Every copy is read whole into memory, so with the size cap
// below a batch stays under the isolate's 128 MB (plan images, the largest objects
// copied, are at most 4 MiB, so a real batch is a few tens of MB at worst).
const COPY_BATCH = 10;
// An object larger than this is not copied (and is counted as skipped): nothing the
// app writes comes near it (a plan image is at most MAX_PLAN_BYTES, 4 MiB), so one would
// be a mistake that shouldn't sink the run.
export const BACKUP_MAX_OBJECT_BYTES = 8 * 1024 * 1024;
// How long a run's lease holds: longer than a Cron Trigger invocation may run (15 minutes).
export const BACKUP_LEASE_MS = 20 * 60 * 1000;
// A run saves its progress after passing this many objects (and after every listing page),
// so an invocation that dies part way loses at most this many objects' work. A run copies
// about 440 objects, so that is 4 extra PUTs at most.
export const BACKUP_SAVE_EVERY = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_PREFIX = '[backup]';

export const utcDate = (at: Date): string => at.toISOString().slice(0, 10);

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown error');

export type BackupSource = (typeof BACKUP_SOURCES)[number];

export interface BackupRunResult {
  /**
   * 'idle': today's set was already complete. 'partial': the budget ran out first.
   * 'busy': another run holds the lease on the set.
   */
  status: 'idle' | 'busy' | 'partial' | 'complete';
  date: string;
  /** Objects copied by this run. */
  copied: number;
  /** R2 operations this run made. */
  operations: number;
  /** Old sets this run deleted. */
  pruned: string[];
}

/** The progress record, if readable, and the etag of what is there (for the lease). */
const readProgress = async (
  bucket: R2Bucket,
): Promise<{ progress: BackupProgress | null; etag: string | null }> => {
  const obj = await bucket.get(BACKUP_PROGRESS_KEY);
  if (!obj) return { progress: null, etag: null };
  let body: unknown;
  try {
    body = JSON.parse(await obj.text());
  } catch {
    body = null;
  }
  const parsed = BackupProgressSchema.safeParse(body);
  if (!parsed.success || !BACKUP_DATE_PATTERN.test(parsed.data.date)) {
    // Starting the day's set again is safe: a copy just overwrites itself.
    console.error(`${LOG_PREFIX} progress record unreadable, starting a new set`);
    return { progress: null, etag: obj.etag };
  }
  return { progress: parsed.data, etag: obj.etag };
};

const putJsonRecord = (bucket: R2Bucket, key: string, value: unknown) =>
  bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });

type CopyOutcome = 'copied' | 'gone' | 'skipped' | 'failed';

/** Copies one object into the set, body and both kinds of metadata, as the binding stores them. */
const copyOne = async (
  bucket: R2Bucket,
  date: string,
  key: string,
): Promise<{ outcome: CopyOutcome; bytes: number }> => {
  try {
    const obj = await bucket.get(key);
    // Deleted since the listing: it isn't part of the content any more.
    if (!obj) return { outcome: 'gone', bytes: 0 };
    if (obj.size > BACKUP_MAX_OBJECT_BYTES) {
      await obj.body.cancel();
      return { outcome: 'skipped', bytes: 0 };
    }
    const body = await obj.arrayBuffer();
    await bucket.put(backupKey(date, key), body, {
      httpMetadata: obj.httpMetadata ?? {},
      customMetadata: obj.customMetadata ?? {},
    });
    return { outcome: 'copied', bytes: body.byteLength };
  } catch (e) {
    // The name only: R2 error messages can carry keys, and keys carry the owner.
    console.error(`${LOG_PREFIX} one copy failed:`, errorName(e));
    return { outcome: 'failed', bytes: 0 };
  }
};

/** Deletes `prefix` page by page while the budget lasts; true once it's all gone. */
const deletePrefixWithin = async (
  bucket: R2Bucket,
  prefix: string,
  spend: (n: number) => boolean,
): Promise<boolean> => {
  for (;;) {
    if (!spend(2)) return false;
    const page = await bucket.list({ prefix });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return true;
  }
};

/** A set worth keeping: complete, with every copy made and something in it. */
const isGoodSet = (record: BackupCompleteRecord | null): boolean =>
  record !== null && record.failed === 0 && record.objects > 0;

const readCompleteRecord = async (
  bucket: R2Bucket,
  date: string,
): Promise<BackupCompleteRecord | null> => {
  const obj = await bucket.get(backupCompleteKey(date));
  if (!obj) return null;
  try {
    const parsed = BackupCompleteRecordSchema.safeParse(JSON.parse(await obj.text()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Deletes every dated set older than BACKUP_RETENTION_DAYS before `now`, but never the
 * newest good set (complete, with no failed copy and at least one object), however old:
 * a backup that has been failing, or copying nothing, for a month still leaves its last
 * good set behind. With no good set at all, or no budget to find it, deletes nothing.
 * Returns the dates deleted in full.
 */
export const pruneBackups = async (
  bucket: R2Bucket,
  now: Date,
  spend: (n: number) => boolean = () => true,
): Promise<string[]> => {
  const oldest = utcDate(new Date(now.getTime() - BACKUP_RETENTION_DAYS * DAY_MS));
  const all: string[] = [];
  let cursor: string | undefined;
  do {
    if (!spend(1)) return [];
    const page = await bucket.list({
      prefix: BACKUP_ROOT,
      delimiter: '/',
      ...(cursor ? { cursor } : {}),
    });
    for (const p of page.delimitedPrefixes) {
      const date = p.slice(BACKUP_ROOT.length, -1);
      if (BACKUP_DATE_PATTERN.test(date)) all.push(date);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  all.sort();
  if (!all.some((d) => d < oldest)) return [];
  // Newest first: usually the set that just completed, so one GET.
  let keep: string | undefined;
  for (const date of [...all].reverse()) {
    if (!spend(1)) return [];
    if (isGoodSet(await readCompleteRecord(bucket, date))) {
      keep = date;
      break;
    }
  }
  if (keep === undefined) {
    console.error(`${LOG_PREFIX} no good set to keep; nothing pruned`);
    return [];
  }
  const pruned: string[] = [];
  for (const date of all.filter((d) => d < oldest && d !== keep)) {
    if (!(await deletePrefixWithin(bucket, backupSetPrefix(date), spend))) break;
    pruned.push(date);
  }
  return pruned;
};

/**
 * One cron run: carries on with the set in backup/progress.json, or starts today's
 * if today has no complete set yet, and copies until the set is done or `budget`
 * R2 operations are spent. A copy that fails is counted and left out of the set
 * rather than retried forever; the next day's set has another go at it.
 */
export const runBackup = async (
  bucket: R2Bucket,
  now: Date,
  budget = BACKUP_RUN_BUDGET,
  sources: readonly BackupSource[] = BACKUP_SOURCES,
): Promise<BackupRunResult> => {
  let operations = 0;
  // Always leaves one operation over, for the progress write that ends a partial run.
  const spend = (n: number): boolean => {
    if (operations + n + 1 > budget) return false;
    operations += n;
    return true;
  };
  const today = utcDate(now);

  operations += 1;
  const read = await readProgress(bucket);
  let progress = read.progress;
  if (progress?.lockedUntil !== undefined && progress.lockedUntil > now.toISOString()) {
    console.warn(`${LOG_PREFIX} set ${progress.date}: another run holds the lease; skipping`);
    return { status: 'busy', date: progress.date, copied: 0, operations, pruned: [] };
  }
  if (!progress) {
    operations += 1;
    if (await bucket.head(backupCompleteKey(today))) {
      return { status: 'idle', date: today, copied: 0, operations, pruned: [] };
    }
    progress = {
      v: 1,
      date: today,
      startedAt: now.toISOString(),
      objects: 0,
      bytes: 0,
      failed: 0,
      skipped: 0,
      runs: 0,
      source: 0,
    };
  } else if (progress.date < utcDate(new Date(now.getTime() - DAY_MS))) {
    console.warn(
      `${LOG_PREFIX} set ${progress.date} is still being written; the backup is falling behind (docs/deploy.md, Backups)`,
    );
  }
  const state = progress;
  state.runs += 1;
  const { date } = state;
  let copied = 0;

  // The lease: written only over the record this run read (or where there was none), so
  // of two runs that read the same record, one gets the set and the other stops here.
  state.lockedUntil = new Date(now.getTime() + BACKUP_LEASE_MS).toISOString();
  operations += 1;
  const leased = await bucket.put(BACKUP_PROGRESS_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: 'application/json' },
    onlyIf: read.etag === null ? { etagDoesNotMatch: '*' } : { etagMatches: read.etag },
  });
  if (!leased) {
    console.warn(`${LOG_PREFIX} set ${date}: another run took the lease first; skipping`);
    return { status: 'busy', date, copied: 0, operations, pruned: [] };
  }

  const stop = async (): Promise<BackupRunResult> => {
    operations += 1;
    delete state.lockedUntil;
    await putJsonRecord(bucket, BACKUP_PROGRESS_KEY, state);
    console.warn(
      `${LOG_PREFIX} set ${date}: ${copied} object(s) copied this run, ${state.objects} so far; the next run carries on`,
    );
    return { status: 'partial', date, copied, operations, pruned: [] };
  };

  const oversized = (o: R2Object) => o.size > BACKUP_MAX_OBJECT_BYTES;
  let unsaved = 0;
  while (state.source < sources.length) {
    const source = sources[state.source]!;
    let cursor: string | undefined;
    for (;;) {
      if (!spend(1)) return stop();
      const page = await bucket.list({
        prefix: source.prefix,
        ...(cursor
          ? { cursor }
          : state.startAfter !== undefined
            ? { startAfter: state.startAfter }
            : {}),
      });
      const wanted = page.objects.filter((o) => source.match.test(o.key));
      // Oversized objects are counted, not read, so they cost nothing. Each is counted as
      // startAfter passes it, never before, so a run that stops short of one leaves it
      // to the run that resumes there and it is counted once.
      let next = 0;
      for (;;) {
        // A full batch, or as much of one as the budget still covers.
        const room = Math.min(COPY_BATCH, Math.floor((budget - operations - 1) / 2));
        // The next small objects in the page, `end` just past the last of them.
        const batch: R2Object[] = [];
        let end = next;
        for (let j = next; j < wanted.length && batch.length < Math.max(room, 1); j++) {
          if (oversized(wanted[j]!)) continue;
          batch.push(wanted[j]!);
          end = j + 1;
        }
        if (batch.length === 0) break;
        if (room === 0 || !spend(2 * batch.length)) return stop();
        const results = await Promise.all(batch.map((o) => copyOne(bucket, date, o.key)));
        for (const r of results) {
          if (r.outcome === 'copied') {
            copied += 1;
            state.objects += 1;
            state.bytes += r.bytes;
          } else if (r.outcome === 'failed') {
            state.failed += 1;
          } else if (r.outcome === 'skipped') {
            state.skipped += 1;
          }
        }
        // Only the oversized ones before the batch's last key: any after it are passed later.
        state.skipped += wanted.slice(next, end).filter(oversized).length;
        state.startAfter = batch.at(-1)!.key;
        unsaved += end - next;
        next = end;
        if (unsaved >= BACKUP_SAVE_EVERY) {
          if (!spend(1)) return stop();
          await putJsonRecord(bucket, BACKUP_PROGRESS_KEY, state);
          unsaved = 0;
        }
      }
      state.skipped += wanted.slice(next).filter(oversized).length;
      const last = page.objects.at(-1);
      if (last) state.startAfter = last.key;
      if (!page.truncated) break;
      cursor = page.cursor;
      // After every page too, so a resume never lists a finished page again.
      if (!spend(1)) return stop();
      await putJsonRecord(bucket, BACKUP_PROGRESS_KEY, state);
      unsaved = 0;
    }
    state.source += 1;
    delete state.startAfter;
  }

  const record: BackupCompleteRecord = {
    v: 1,
    date,
    startedAt: state.startedAt,
    completedAt: now.toISOString(),
    objects: state.objects,
    bytes: state.bytes,
    failed: state.failed,
    skipped: state.skipped,
    runs: state.runs,
  };
  // The marker and the progress delete: one from the budget, one from its reserve.
  if (!spend(1)) return stop();
  operations += 1;
  await putJsonRecord(bucket, backupCompleteKey(date), record);
  await bucket.delete(BACKUP_PROGRESS_KEY);
  // Whatever budget is left; a prune cut short finishes after the next set.
  const pruned = await pruneBackups(bucket, now, spend);
  const problems =
    state.failed || state.skipped
      ? `; ${state.failed} failed and ${state.skipped} over ${BACKUP_MAX_OBJECT_BYTES} bytes are NOT in it`
      : '';
  const log = state.failed || state.skipped ? console.error : console.warn;
  log(
    `${LOG_PREFIX} set ${date} complete: ${state.objects} object(s), ${state.bytes} bytes, in ${state.runs} run(s)${problems}; pruned ${pruned.length} old set(s)`,
  );
  return { status: 'complete', date, copied, operations, pruned };
};

// The tourId a public or index key belongs to, from its name; null for any other key.
const tourIdOfKey = (key: string): string | null => {
  const name = (prefix: string) =>
    key.startsWith(prefix) && key.endsWith('.json')
      ? key.slice(prefix.length, -'.json'.length)
      : null;
  const cursor = exploreCursorOf(key);
  if (cursor !== null) return cursor.slice(cursor.indexOf('-') + 1);
  return (
    name(PUB_TOURS_ROOT) ??
    name(`${EXPLORE_ROOT}tours/`) ??
    name(`${EXPLORE_ROOT}hidden/`) ??
    tourIdOfPlanKey(key)
  );
};

const parseJson = (body: ArrayBuffer): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
};

/**
 * The operator restore route's work: copies backup/<date>/<key> back to <key>, body
 * and metadata, for each key. Create-only unless `overwrite`, so by default nothing
 * that exists now is touched. Keys of an owner whose account is marked for deletion
 * are refused: the daily sweep would only delete them again. The owner of a key outside
 * tours/ and panos/ (a bundle, a plan image, Explore) is found through its tour's owner
 * pointer (tour-owners/<tourId>.json, the set's copy or else the live one; a slug's tour
 * from the backed-up slug record, a pointer's owner from its own body), and a key whose
 * owner can't be found is refused too. A key whose R2 call throws is `failed`, and the rest still go through. Keys must
 * already be checked with isRestorableKey (the request schema does).
 */
export const restoreFromBackup = async (
  bucket: R2Bucket,
  date: string,
  keys: readonly string[],
  overwrite: boolean,
): Promise<OperatorRestoreOk> => {
  const out: OperatorRestoreOk = {
    restored: [],
    existing: [],
    missing: [],
    refused: [],
    failed: [],
  };
  const cached = <T>(cache: Map<string, Promise<T>>, id: string, load: () => Promise<T>) => {
    let hit = cache.get(id);
    if (!hit) {
      hit = load();
      cache.set(id, hit);
    }
    return hit;
  };
  const deletedOwners = new Map<string, Promise<boolean>>();
  const ownerDeleted = (owner: string) =>
    cached(
      deletedOwners,
      owner,
      async () => !!(await bucket.head(`${ACCOUNTS_ROOT}${owner}/deletion.json`)),
    );
  const ownerOfSub = (record: unknown): string | null => {
    const parsed = TourOwnerRecordSchema.safeParse(record);
    return parsed.success ? encodeId(parsed.data.sub) : null;
  };
  const tourOwners = new Map<string, Promise<string | null>>();
  const ownerOfTour = (tourId: string) =>
    cached(tourOwners, tourId, async () => {
      let key: string;
      try {
        key = tourOwnerKey(tourId);
      } catch {
        return null;
      }
      const obj = (await bucket.get(backupKey(date, key))) ?? (await bucket.get(key));
      return obj ? ownerOfSub(parseJson(await obj.arrayBuffer())) : null;
    });
  // The owner segment of `key`, given its backed-up body; null if it can't be found.
  const ownerOf = async (key: string, body: ArrayBuffer): Promise<string | null> => {
    const own = /^(?:tours|panos)\/([^/]+)\//.exec(key)?.[1];
    if (own) return own;
    if (key.startsWith(TOUR_OWNERS_ROOT)) return ownerOfSub(parseJson(body));
    if (key.startsWith(SLUGS_ROOT)) {
      const slug = SlugRecordSchema.safeParse(parseJson(body));
      return slug.success ? ownerOfTour(slug.data.tourId) : null;
    }
    const tourId = tourIdOfKey(key);
    return tourId === null ? null : ownerOfTour(tourId);
  };
  const restoreOne = async (key: string): Promise<Exclude<keyof OperatorRestoreOk, 'failed'>> => {
    const obj = await bucket.get(backupKey(date, key));
    if (!obj) return 'missing';
    const body = await obj.arrayBuffer();
    const owner = await ownerOf(key, body);
    if (owner === null || (await ownerDeleted(owner))) return 'refused';
    const written = await bucket.put(key, body, {
      httpMetadata: obj.httpMetadata ?? {},
      customMetadata: obj.customMetadata ?? {},
      ...(overwrite ? {} : { onlyIf: { etagDoesNotMatch: '*' } }),
    });
    return written ? 'restored' : 'existing';
  };
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += COPY_BATCH) {
    const batch = unique.slice(i, i + COPY_BATCH);
    const outcomes = await Promise.allSettled(batch.map(restoreOne));
    outcomes.forEach((o, j) => {
      if (o.status === 'fulfilled') {
        out[o.value].push(batch[j]!);
      } else {
        // The name only: R2 error messages can carry keys, and keys carry the owner.
        console.error(`${LOG_PREFIX} one restore failed:`, errorName(o.reason));
        out.failed.push(batch[j]!);
      }
    });
  }
  return out;
};
