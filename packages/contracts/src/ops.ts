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

/**
 * admin-api's superseded-tile sweep, which runs on the 15-minute cron after the
 * backup. The daily cron's `tile-gc` task reads it and fails when the sweep has
 * not finished cleanly for a while, so the health check's daily cron status
 * still covers it.
 */
export const TILE_GC_STATUS_KEY = 'ops/cron/admin-api-tile-gc.json';

export const TileGcStatusSchema = z.object({
  /** ISO time of the last sweep that ran (cleanly or not). */
  lastRunAt: z.string(),
  /** ISO time of the last sweep that finished without throwing; null if none has yet. */
  lastOkAt: z.string().nullable(),
});
export type TileGcStatus = z.infer<typeof TileGcStatusSchema>;

/** The latest failed CDN purge. Each failure overwrites it; nothing clears it. */
export const CDN_PURGE_FAILURE_KEY = 'ops/cdn-purge/last-failure.json';

export const CdnPurgeFailureSchema = z.object({
  /** ISO time of the failure. */
  at: z.string(),
  /** Status and Cloudflare error codes only, as the purge's own log line has them. */
  detail: z.string(),
});
export type CdnPurgeFailure = z.infer<typeof CdnPurgeFailureSchema>;

/**
 * Where admin-api queues a CDN purge that still failed after its retries (or didn't fit in
 * the request's budget), one record per key, named by time so a listing is oldest first.
 * Its 15-minute cron retries them and deletes each once everything in it went through.
 */
export const CDN_PURGE_PENDING_PREFIX = 'ops/cdn-purge/pending/';

export const CdnPurgePendingSchema = z.object({
  v: z.literal(1),
  /** ISO time it was first queued; a record is dropped a week after that. */
  firstAt: z.string(),
  /** R2 key prefixes and keys, as the purge was asked for them (no host). */
  prefixes: z.array(z.string()),
  files: z.array(z.string()),
  /** Dead letters only: why Cloudflare refused them (status and error codes). */
  reason: z.string().optional(),
});
export type CdnPurgePending = z.infer<typeof CdnPurgePendingSchema>;

/**
 * Purges admin-api gave up on, in the same shape as a pending record: refused by
 * Cloudflare with a 4xx other than 401, 403 or 429 (a retry would fail the same way; a
 * 401/403 is the token, and stays queued), or still
 * failing a week after they were queued. Nothing retries them; the operator purges them
 * by hand and deletes the record (docs/deploy.md, CDN purge on delete).
 */
export const CDN_PURGE_DEAD_PREFIX = 'ops/cdn-purge/dead/';
