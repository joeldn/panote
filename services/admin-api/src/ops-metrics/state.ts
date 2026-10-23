import {
  BACKUP_DATE_PATTERN,
  BACKUP_PROGRESS_KEY,
  BACKUP_ROOT,
  backupCompleteKey,
  CDN_PURGE_DEAD_PREFIX,
  CDN_PURGE_FAILURE_KEY,
  CDN_PURGE_PENDING_PREFIX,
  CdnPurgeFailureSchema,
  CRON_STATUS_KEY,
  CronStatusSchema,
  HEALTH_STATE_KEY,
  TILE_GC_STATUS_KEY,
  TileGcStatusSchema,
  type OpsHealth,
} from '@internal/contracts';

// The health section: what the crons, the CDN purge queue, the backup and tiler-consumer's
// health check already record under ops/ and backup/ (docs/deploy.md, "Monitoring and
// alerts"). Read only; a record that's missing or unreadable reads as null, not an error.

/** Listing stops here: past this many records the count shows as "at least". */
export const QUEUE_COUNT_CAP = 1000;

const readJson = async (bucket: R2Bucket, key: string): Promise<unknown> => {
  try {
    const obj = await bucket.get(key);
    return obj ? await obj.json() : null;
  } catch {
    return null;
  }
};

const countUnder = async (
  bucket: R2Bucket,
  prefix: string,
): Promise<{ n: number; capped: boolean }> => {
  // One page: R2 lists up to 1,000 keys a call, which is the cap.
  const page = await bucket.list({ prefix, limit: QUEUE_COUNT_CAP });
  return { n: page.objects.length, capped: page.truncated };
};

/** The newest day under backup/ whose set has its complete marker, checking at most 3. */
const lastCompleteBackup = async (bucket: R2Bucket): Promise<string | null> => {
  const page = await bucket.list({ prefix: BACKUP_ROOT, delimiter: '/' });
  const dates = page.delimitedPrefixes
    .map((p) => p.slice(BACKUP_ROOT.length, -1))
    .filter((d) => BACKUP_DATE_PATTERN.test(d))
    .sort()
    .reverse()
    .slice(0, 3);
  for (const date of dates) {
    if (await bucket.head(backupCompleteKey(date))) return date;
  }
  return null;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const healthSection = async (bucket: R2Bucket): Promise<OpsHealth> => {
  const [health, cron, tileGc, purgeFailure, pending, dead, backup, progress] = await Promise.all([
    readJson(bucket, HEALTH_STATE_KEY),
    readJson(bucket, CRON_STATUS_KEY),
    readJson(bucket, TILE_GC_STATUS_KEY),
    readJson(bucket, CDN_PURGE_FAILURE_KEY),
    countUnder(bucket, CDN_PURGE_PENDING_PREFIX),
    countUnder(bucket, CDN_PURGE_DEAD_PREFIX),
    lastCompleteBackup(bucket),
    readJson(bucket, BACKUP_PROGRESS_KEY),
  ]);
  // tiler-consumer owns this shape (health.ts); read it loosely.
  const failures = isObject(health) && isObject(health.failures) ? health.failures : {};
  const failing = Object.entries(failures)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
    .map(([check, n]) => ({ check, failures: n }))
    .sort((a, b) => a.check.localeCompare(b.check));
  const announced =
    isObject(health) && Array.isArray(health.announced)
      ? health.announced.filter((c): c is string => typeof c === 'string')
      : [];
  const sentAt = isObject(health) && typeof health.lastSentAt === 'number' ? health.lastSentAt : 0;
  const cronStatus = CronStatusSchema.safeParse(cron);
  const gcStatus = TileGcStatusSchema.safeParse(tileGc);
  const failure = CdnPurgeFailureSchema.safeParse(purgeFailure);
  const inProgress =
    isObject(progress) && typeof progress.date === 'string' && typeof progress.status === 'string'
      ? { date: progress.date, status: progress.status }
      : null;
  return {
    failing,
    announcedDown: announced,
    lastAlertAt: sentAt > 0 ? new Date(sentAt).toISOString() : null,
    dailyCron: cronStatus.success ? cronStatus.data : null,
    tileGc: gcStatus.success ? gcStatus.data : null,
    cdnPurge: {
      lastFailure: failure.success ? failure.data : null,
      pending: pending.n,
      pendingCapped: pending.capped,
      dead: dead.n,
      deadCapped: dead.capped,
    },
    backup: { lastCompleteDate: backup, inProgress },
  };
};
