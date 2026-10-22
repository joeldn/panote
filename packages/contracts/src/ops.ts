import { z } from 'zod';

// Operational markers one Worker writes and tiler-consumer's health check reads
// (docs/deploy.md, "Monitoring and alerts"). They live under ops/, which the CDN's
// WAF rule never serves (only /tiles/, /pub/ and /slugs/) and no R2 notification
// watches (that one is panos/ only).

/** admin-api's daily Cron Trigger: when it last ran, and when every task last succeeded. */
export const CRON_STATUS_KEY = 'ops/cron/admin-api-daily.json';

export const CronStatusSchema = z.object({
  /** ISO time of the last run's scheduled time. */
  lastRunAt: z.string(),
  /** ISO time of the last run in which no task threw; null if none has yet. */
  lastOkAt: z.string().nullable(),
  /** Names of the tasks that threw in the last run; empty when it was clean. */
  failed: z.array(z.string()),
});
export type CronStatus = z.infer<typeof CronStatusSchema>;

/** The latest failed CDN purge. Each failure overwrites it; nothing clears it. */
export const CDN_PURGE_FAILURE_KEY = 'ops/cdn-purge/last-failure.json';

export const CdnPurgeFailureSchema = z.object({
  /** ISO time of the failure. */
  at: z.string(),
  /** Status and Cloudflare error codes only, as the purge's own log line has them. */
  detail: z.string(),
});
export type CdnPurgeFailure = z.infer<typeof CdnPurgeFailureSchema>;
