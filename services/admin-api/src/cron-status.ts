import { CRON_STATUS_KEY, CronStatusSchema, type CronStatus } from '@internal/contracts';

// The daily Cron Trigger's tasks, by a stable name that shows up in the logs and
// in the status object tiler-consumer's health check reads.
export type CronTasks = Record<string, () => Promise<unknown>>;

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown error');

const readStatus = async (bucket: R2Bucket): Promise<CronStatus | null> => {
  try {
    const obj = await bucket.get(CRON_STATUS_KEY);
    if (!obj) return null;
    const parsed = CronStatusSchema.safeParse(await obj.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Runs every task to completion, side by side, then records the outcome at
 * CRON_STATUS_KEY. Each task that throws gets one `[cron] daily task failed` line (a
 * stable message to filter on). `lastOkAt` only moves on a run where none threw, so a
 * cron that keeps failing or stops running goes stale and the health check alerts
 * (docs/deploy.md, "Monitoring and alerts"). Never throws.
 */
export const runDailyCron = async (
  bucket: R2Bucket,
  now: Date,
  tasks: CronTasks,
): Promise<string[]> => {
  const names = Object.keys(tasks);
  // async, so a task that throws before returning a promise is a rejection like any other;
  // awaited, so a rejection is handled at once and never reported as unhandled.
  const results = await Promise.allSettled(names.map(async (name) => await tasks[name]!()));
  const failed: string[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') return;
    const name = names[i]!;
    failed.push(name);
    console.error(`[cron] daily task failed task=${name} error=${errorName(result.reason)}`);
  });
  try {
    const previous = await readStatus(bucket);
    const status: CronStatus = {
      lastRunAt: now.toISOString(),
      lastOkAt: failed.length === 0 ? now.toISOString() : (previous?.lastOkAt ?? null),
      failed,
    };
    await bucket.put(CRON_STATUS_KEY, JSON.stringify(status), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (e) {
    console.error(`[cron] daily status not saved: ${errorName(e)}`);
  }
  return failed;
};
