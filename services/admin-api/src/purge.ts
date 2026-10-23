// Cloudflare cache purge for cdn.<host> (plan 3.5, B6). Paths are R2 keys, which map
// 1:1 onto the CDN custom domain's URL paths. A purge that still fails after its
// retries is queued under ops/cdn-purge/pending/ and retried by the 15-minute cron
// (retryPendingPurges), so a 429 from the account-wide prefix budget only delays it.
// One Cloudflare would refuse again (a 4xx other than 401, 403 or 429) goes to ops/cdn-purge/dead/
// instead, for the operator: retrying it would only hold up the rest of the queue.
import {
  CDN_PURGE_DEAD_PREFIX,
  CDN_PURGE_FAILURE_KEY,
  CDN_PURGE_PENDING_PREFIX,
  CdnPurgePendingSchema,
  type CdnPurgeFailure,
  type CdnPurgeOutcome,
  type CdnPurgePending,
} from '@internal/contracts';

export type CdnPurge = { prefixes: string[]; files: string[] };

export const NO_PURGE: CdnPurge = { prefixes: [], files: [] };

export const mergePurges = (...purges: CdnPurge[]): CdnPurge => ({
  prefixes: [...new Set(purges.flatMap((p) => p.prefixes))],
  files: [...new Set(purges.flatMap((p) => p.files))],
});

export type PurgeEnv = {
  CF_PURGE_TOKEN?: string | undefined;
  CDN_ZONE_ID: string;
  CDN_HOST: string;
  // Where a failure is recorded for tiler-consumer's health check (docs/deploy.md,
  // "Monitoring and alerts"), and what didn't go through is queued for the cron.
  // Without it a failure is only logged.
  BUCKET?: R2Bucket;
};

export type PurgeOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Retries per request after a 429, a 5xx or a network error (default 2). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Purge API requests this call may send, retries included; what is left over is queued. */
  maxRequests?: number;
  /** Epoch ms by which every request (and its timeout) must be over; the rest is queued.
   * Default: DEFAULT_DEADLINE_MS from the call, inside waitUntil's 30 seconds. */
  deadline?: number;
  /** An operator takedown's: queued where the cron reads first (OPERATOR_PENDING_PREFIX). */
  priority?: boolean;
  /** Queue what didn't go through for the cron (default true). */
  queue?: boolean;
};

// The API's cap for both prefixes and files per request, on every plan.
export const MAX_PER_REQUEST = 100;
const TIMEOUT_MS = 5_000;
// Backoff between retries of one request: Retry-After when Cloudflare sends one (capped),
// else these. Short, since it runs in waitUntil; the cron is the long retry.
const BACKOFF_MS = [1_000, 4_000];
const MAX_RETRY_AFTER_MS = 10_000;
const ZONE_ID_RE = /^[0-9a-f]{32}$/;
const HOST_RE = /^[a-z0-9.-]+$/;
// Items per pending record, so a takedown's tens of thousands of tile URLs stay small records.
export const PENDING_RECORD_MAX_ITEMS = 1_000;
// How long purgeCdn may spend sending, by default: a purge in waitUntil (30 seconds after
// the response) must leave time to queue what it didn't get to and record the failure.
export const DEFAULT_DEADLINE_MS = 20_000;
// Operator takedowns' records: under pending/ (the cron lists the whole prefix) and named
// so they list before every timestamped record, so they are retried first.
export const OPERATOR_PENDING_PREFIX = `${CDN_PURGE_PENDING_PREFIX}0-op/`;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_PER_REQUEST) {
    out.push(items.slice(i, i + MAX_PER_REQUEST));
  }
  return out;
};

// Only the status and Cloudflare's error codes/messages are logged, never the request.
const describeFailure = async (res: Response): Promise<string> => {
  const body = await res
    .json<{ errors?: { code?: number; message?: string }[] }>()
    .catch(() => null);
  const errors = (body?.errors ?? []).map((e) => `${e.code ?? '?'} ${e.message ?? ''}`.trim());
  return `HTTP ${res.status}${errors.length ? `: ${errors.join('; ')}` : ''}`;
};

const retryAfterMs = (res: Response): number | null => {
  const seconds = Number(res.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS)
    : null;
};

type Failure = { reason: string; retryable: boolean; status: number | null };
type Budget = { requests: number; deadline: number };

// One batch, retried on a 429, a 5xx or a network error while the shared budget lasts.
// 'not-sent' when the budget or the deadline ran out before the first attempt.
const send = async (
  env: PurgeEnv,
  kind: 'prefixes' | 'files',
  values: string[],
  opts: PurgeOptions,
  budget: Budget,
): Promise<'ok' | 'not-sent' | Failure> => {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const retries = opts.retries ?? BACKOFF_MS.length;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  let last: Failure | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (budget.requests <= 0 || Date.now() + timeoutMs > budget.deadline) break;
    budget.requests--;
    let wait: number | null = null;
    try {
      const res = await doFetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CDN_ZONE_ID}/purge_cache`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.CF_PURGE_TOKEN ?? ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ [kind]: values }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (res.ok) return 'ok';
      // A 401/403 is the token (expired or revoked), not the batch: worth queueing for
      // once it's fixed, but not retrying now, and it stops the rest (sendAll).
      const auth = res.status === 401 || res.status === 403;
      const retryable = auth || res.status === 429 || res.status >= 500;
      last = { reason: await describeFailure(res), retryable, status: res.status };
      if (!retryable || auth) break;
      wait = retryAfterMs(res);
    } catch (e) {
      last = {
        reason: e instanceof Error ? e.name : 'unknown error',
        retryable: true,
        status: null,
      };
    }
    if (attempt < retries) {
      const ms = wait ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
      if (Date.now() + ms + timeoutMs > budget.deadline) break;
      await sleep(ms);
    }
  }
  if (last === null) return 'not-sent';
  console.error(`cdn purge failed (${kind}, ${values.length}): ${last.reason}`);
  return { ...last, reason: `${kind}, ${values.length}: ${last.reason}` };
};

// Overwrites the one failure marker; nothing reads it back here, so no race to lose.
const recordFailure = async (bucket: R2Bucket, detail: string): Promise<void> => {
  const body: CdnPurgeFailure = { at: new Date().toISOString(), detail };
  try {
    await bucket.put(CDN_PURGE_FAILURE_KEY, JSON.stringify(body), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (e) {
    console.error(`cdn purge failure not recorded: ${e instanceof Error ? e.name : 'unknown'}`);
  }
};

const recordKey = (prefix: string, at: Date): string =>
  `${prefix}${at.toISOString()}-${crypto.randomUUID()}.json`;

const putRecord = (bucket: R2Bucket, key: string, record: CdnPurgePending) =>
  bucket.put(key, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });

// Writes `items` under `prefix` (pending/ or dead/), in records of at most
// PENDING_RECORD_MAX_ITEMS. Returns how many items were written; an item whose record
// couldn't be written is lost (and logged).
const writeRecords = async (
  bucket: R2Bucket,
  prefix: string,
  items: CdnPurge,
  firstAt: string,
  reason?: string,
): Promise<number> => {
  const all = [
    ...items.prefixes.map((p) => ['prefixes', p] as const),
    ...items.files.map((f) => ['files', f] as const),
  ];
  let written = 0;
  for (let i = 0; i < all.length; i += PENDING_RECORD_MAX_ITEMS) {
    const slice = all.slice(i, i + PENDING_RECORD_MAX_ITEMS);
    const record: CdnPurgePending = {
      v: 1,
      firstAt,
      prefixes: slice.filter(([k]) => k === 'prefixes').map(([, v]) => v),
      files: slice.filter(([k]) => k === 'files').map(([, v]) => v),
      ...(reason === undefined ? {} : { reason }),
    };
    try {
      await putRecord(bucket, recordKey(prefix, new Date()), record);
      written += slice.length;
    } catch (e) {
      console.error(
        `cdn purge not ${prefix === CDN_PURGE_DEAD_PREFIX ? 'dead-lettered' : 'queued'}: ${e instanceof Error ? e.name : 'unknown'}`,
      );
    }
  }
  return written;
};

/**
 * Counts the calls made through `bucket` (each an R2 operation, so a subrequest), so a
 * caller can size what it does next to what the invocation has left.
 */
export const meteredBucket = (bucket: R2Bucket): { bucket: R2Bucket; calls: () => number } => {
  let n = 0;
  const counted = new Proxy(bucket, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        n += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { bucket: counted, calls: () => n };
};

const isConfigured = (env: PurgeEnv): boolean =>
  !!env.CF_PURGE_TOKEN && ZONE_ID_RE.test(env.CDN_ZONE_ID) && HOST_RE.test(env.CDN_HOST);

const empty = (): CdnPurge => ({ prefixes: [], files: [] });

type SendResult = {
  /** Went through. */
  done: CdnPurge;
  /** Failed in a way a retry may fix, or never sent: for the queue. */
  left: CdnPurge;
  /** Refused in a way a retry won't fix (a 4xx other than 401, 403 or 429): for the dead letters. */
  rejected: CdnPurge;
  /** Sent and failed this time (part of `left`). */
  tried: Set<string>;
  /** The last failure's detail, for the health check marker. */
  failed: string | null;
  rejectedReason: string | null;
};

const itemId = (kind: 'prefixes' | 'files', key: string) => `${kind}:${key}`;

// Sends prefixes first (a handful of requests at most), then files, within the budget:
// `maxRequests` attempts, retries included, and `deadline`. A batch that still fails
// after its retries stops the rest, since that is a rate limit or an outage, not the
// batch: a 429 stops only its own kind (prefix and URL purges have separate budgets),
// anything else stops both. The rest goes to `left` unsent.
const sendAll = async (env: PurgeEnv, purge: CdnPurge, opts: PurgeOptions): Promise<SendResult> => {
  const out: SendResult = {
    done: empty(),
    left: empty(),
    rejected: empty(),
    tried: new Set(),
    failed: null,
    rejectedReason: null,
  };
  const budget: Budget = {
    requests: opts.maxRequests ?? Infinity,
    deadline: opts.deadline ?? Date.now() + DEFAULT_DEADLINE_MS,
  };
  // Prefixes take no scheme; single-file purges take the full URL.
  const toUrl = {
    files: (k: string) => `https://${env.CDN_HOST}/${k}`,
    prefixes: (k: string) => `${env.CDN_HOST}/${k}`,
  };
  const stopped = new Set<'prefixes' | 'files'>();
  for (const kind of ['prefixes', 'files'] as const) {
    for (const batch of chunks(purge[kind])) {
      if (stopped.has(kind)) {
        out.left[kind].push(...batch);
        continue;
      }
      const r = await send(env, kind, batch.map(toUrl[kind]), opts, budget);
      if (r === 'ok') {
        out.done[kind].push(...batch);
      } else if (r === 'not-sent') {
        out.left[kind].push(...batch);
        stopped.add('prefixes').add('files');
      } else if (!r.retryable) {
        out.rejected[kind].push(...batch);
        out.failed = out.rejectedReason = r.reason;
      } else {
        out.left[kind].push(...batch);
        batch.forEach((k) => out.tried.add(itemId(kind, k)));
        out.failed = r.reason;
        if (r.status === 429) stopped.add(kind);
        else stopped.add('prefixes').add('files');
      }
    }
  }
  return out;
};

const count = (p: CdnPurge): number => p.prefixes.length + p.files.length;

/**
 * Never throws. Each request is retried briefly on a 429, a 5xx or a network error,
 * within `maxRequests` and `deadline`. What still fails, or doesn't fit, is queued for
 * the cron when there is a bucket; what Cloudflare refuses outright is dead-lettered;
 * either failure is recorded for the health check. The outcome says which.
 */
export const purgeCdn = async (
  env: PurgeEnv,
  purge: CdnPurge,
  opts: PurgeOptions = {},
): Promise<CdnPurgeOutcome> => {
  const total = count(purge);
  if (total === 0) return { status: 'none', purged: 0, pending: 0, failed: 0 };
  if (!isConfigured(env)) {
    console.warn('cdn purge skipped: CF_PURGE_TOKEN, CDN_ZONE_ID or CDN_HOST not configured');
    return { status: 'skipped', purged: 0, pending: 0, failed: total };
  }
  const { done, left, rejected, failed, rejectedReason } = await sendAll(env, purge, opts);
  const purged = count(done);
  const leftCount = count(left);
  if (leftCount === 0 && count(rejected) === 0) {
    return { status: 'purged', purged, pending: 0, failed: 0 };
  }
  const at = new Date().toISOString();
  let pending = 0;
  if (env.BUCKET) {
    // The queue first: it's what gets the tiles purged in the end.
    if (opts.queue !== false) {
      const prefix = opts.priority ? OPERATOR_PENDING_PREFIX : CDN_PURGE_PENDING_PREFIX;
      pending = await writeRecords(env.BUCKET, prefix, left, at);
    }
    if (count(rejected) > 0) {
      await writeRecords(
        env.BUCKET,
        CDN_PURGE_DEAD_PREFIX,
        rejected,
        at,
        rejectedReason ?? undefined,
      );
    }
    if (failed !== null) await recordFailure(env.BUCKET, failed);
  }
  const failedCount = leftCount - pending + count(rejected);
  return { status: failedCount > 0 ? 'failed' : 'pending', purged, pending, failed: failedCount };
};

// One cron run reads at most this many pending records and sends at most this many purge
// requests, no retries inside the run (the next run is the retry).
export const RETRY_RUN_RECORDS = 20;
export const RETRY_RUN_REQUESTS = 30;
// Records the queue may hold; past that each run drops the oldest owner records (not
// operator ones) beyond its own, QUEUE_DROP_PER_RUN at a time, in one batch delete.
export const QUEUE_MAX_RECORDS = 1_000;
export const QUEUE_DROP_PER_RUN = 200;
// The run's purge requests stop starting after this (no in-run retries, 5 s timeouts).
const RETRY_RUN_DEADLINE_MS = 5 * 60_000;
// Subrequests one cron run can make at most: the listing, the queue cap's delete, two
// failure markers, a GET and up to two writes (a PUT under a new key and the DELETE of the
// old one) per record, the purge requests, and the dead-letter records for what they had
// refused. The cron runs it first and gives the backup (and
// whatever shares the backup's budget) BACKUP_RUN_BUDGET less this, so the invocation's
// total stays BACKUP_RUN_BUDGET: the cap holds because both sides are capped.
export const RETRY_RUN_MAX_SUBREQUESTS =
  // The listing, the queue cap's delete, and at most two failure markers (one before any
  // pending record changes, one after a record is given up on).
  4 +
  RETRY_RUN_RECORDS * 3 +
  RETRY_RUN_REQUESTS +
  Math.ceil((RETRY_RUN_REQUESTS * MAX_PER_REQUEST) / PENDING_RECORD_MAX_ITEMS);
// A record still failing after this long is dead-lettered (logged): something is broken
// that a retry won't fix, such as a revoked token, and the health check has been failing.
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The cron's retry of queued purges (every 15 minutes, beside the backup). Reads the
 * oldest records, merges them (so a burst of pano deletes becomes one prefix request per
 * hundred panos), sends what fits in the run's budget, and then per record: deletes it
 * once everything in it went through; dead-letters what Cloudflare refused outright, or
 * the whole record after PENDING_MAX_AGE_MS; moves a record that failed this run to the
 * back of the queue (a new key), so it can't hold up the records behind it; and trims a
 * record in place to what wasn't tried. Never throws for a purge failure; an R2 error
 * throws (the cron logs it).
 */
export const retryPendingPurges = async (
  env: PurgeEnv & { BUCKET: R2Bucket },
  now: Date,
  opts: PurgeOptions = {},
): Promise<{ records: number; purged: number; left: number; dead: number }> => {
  const none = { records: 0, purged: 0, left: 0, dead: 0 };
  if (!isConfigured(env)) return none;
  const bucket = env.BUCKET;
  // One listing serves both the run (its first records: operator takedowns, then oldest
  // first) and the queue cap.
  const listed = await bucket.list({ prefix: CDN_PURGE_PENDING_PREFIX, limit: QUEUE_MAX_RECORDS });
  // For the health check's marker, written once, before any pending record changes.
  const problems: string[] = [];
  if (listed.truncated) {
    // Over the cap: drop the oldest owner records past this run's, never a takedown's.
    const drop = listed.objects
      .slice(RETRY_RUN_RECORDS)
      .map((o) => o.key)
      .filter((k) => !k.startsWith(OPERATOR_PENDING_PREFIX))
      .slice(0, QUEUE_DROP_PER_RUN);
    if (drop.length > 0) {
      await bucket.delete(drop);
      console.error(
        `cdn purge queue over ${QUEUE_MAX_RECORDS} records: dropped ${drop.length}; their edge copies stay until their TTL`,
      );
      problems.push(`queue over ${QUEUE_MAX_RECORDS} records, ${drop.length} dropped`);
    }
  }
  const records: { key: string; record: CdnPurgePending }[] = [];
  for (const { key } of listed.objects.slice(0, RETRY_RUN_RECORDS)) {
    const obj = await bucket.get(key);
    const parsed = CdnPurgePendingSchema.safeParse(obj ? await obj.json().catch(() => null) : null);
    if (parsed.success) records.push({ key, record: parsed.data });
    else {
      console.error('cdn purge record unreadable; dropped');
      await bucket.delete(key);
      problems.push('a queued record was unreadable and was dropped');
    }
  }
  if (records.length === 0) {
    if (problems.length > 0) await recordFailure(bucket, problems.join('; '));
    return none;
  }
  const merged = mergePurges(...records.map((r) => r.record));
  const sent = await sendAll(env, merged, {
    ...opts,
    retries: 0,
    maxRequests: RETRY_RUN_REQUESTS,
    deadline: Date.now() + RETRY_RUN_DEADLINE_MS,
  });
  const ids = (p: CdnPurge) =>
    new Set([
      ...p.prefixes.map((k) => itemId('prefixes', k)),
      ...p.files.map((k) => itemId('files', k)),
    ]);
  const done = ids(sent.done);
  // Dead letters first, from the refused items (unique: `merged` is deduped), before any
  // pending record changes: a refused item is only trimmed from pending/ once every dead
  // record holding it is written, so whatever fails below, it is in one or the other.
  const deadTotal = count(sent.rejected);
  let deadWritten = 0;
  if (deadTotal > 0) {
    deadWritten = await writeRecords(
      bucket,
      CDN_PURGE_DEAD_PREFIX,
      sent.rejected,
      now.toISOString(),
      sent.rejectedReason ?? undefined,
    );
    if (deadWritten === deadTotal) {
      console.error(`cdn purge dead-lettered ${deadTotal} item(s) under ${CDN_PURGE_DEAD_PREFIX}`);
    } else problems.push(`${deadTotal} refused item(s) not dead-lettered; kept queued`);
  }
  const rejected = deadWritten === deadTotal ? ids(sent.rejected) : new Set<string>();
  if (sent.failed !== null) problems.push(sent.failed);
  else if (deadTotal > 0) problems.push(`${deadTotal} item(s) dead-lettered`);
  if (problems.length > 0) await recordFailure(bucket, problems.join('; '));
  let left = 0;
  let gaveUp = 0;
  for (const { key, record } of records) {
    const keep = (kind: 'prefixes' | 'files') => (k: string) => {
      const id = itemId(kind, k);
      return !done.has(id) && !rejected.has(id);
    };
    const rest: CdnPurgePending = {
      ...record,
      prefixes: record.prefixes.filter(keep('prefixes')),
      files: record.files.filter(keep('files')),
    };
    const restCount = count(rest);
    if (restCount === 0) {
      await bucket.delete(key);
    } else if (now.getTime() - Date.parse(record.firstAt) > PENDING_MAX_AGE_MS) {
      console.error(
        `cdn purge given up after 7 days: ${restCount} item(s) moved to ${CDN_PURGE_DEAD_PREFIX}`,
      );
      await putRecord(bucket, recordKey(CDN_PURGE_DEAD_PREFIX, now), {
        ...rest,
        reason: 'still failing 7 days after it was queued',
      });
      await bucket.delete(key);
      gaveUp += restCount;
    } else {
      left += restCount;
      const failedHere = [
        ...rest.prefixes.map((k) => itemId('prefixes', k)),
        ...rest.files.map((k) => itemId('files', k)),
      ].some((id) => sent.tried.has(id));
      if (failedHere) {
        // To the back of the queue, so the records behind it get their turn.
        const queue = key.startsWith(OPERATOR_PENDING_PREFIX)
          ? OPERATOR_PENDING_PREFIX
          : CDN_PURGE_PENDING_PREFIX;
        await putRecord(bucket, recordKey(queue, now), rest);
        await bucket.delete(key);
      } else if (restCount < count(record)) {
        await putRecord(bucket, key, rest);
      }
    }
  }
  if (gaveUp > 0 && problems.length === 0) {
    await recordFailure(bucket, `${gaveUp} item(s) dead-lettered after 7 days`);
  }
  const deadCount = (deadWritten === deadTotal ? deadTotal : 0) + gaveUp;
  return { records: records.length, purged: count(sent.done), left, dead: deadCount };
};
