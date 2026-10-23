import { z } from 'zod';

import { OPS_EVENT_NAMES } from './ops-events.js';

// GET /api/admin/ops/metrics: the operator dashboard (admin-api ops-metrics/, the admin
// app's /app/ops). Each section comes from its own source and fails on its own: one
// Cloudflare dataset that refuses a query leaves the rest of the page standing.

export const OPS_RANGES = ['24h', '7d'] as const;
export type OpsRange = (typeof OPS_RANGES)[number];
export const DEFAULT_OPS_RANGE: OpsRange = '24h';

const count = () => z.number().nonnegative();
const iso = () => z.string();

/** A section's data, or why it couldn't be had (a status and a short reason, nothing else). */
const section = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), data }),
    z.object({ status: z.literal('unavailable'), reason: z.string() }),
  ]);

/** One point of a time series: an hour (24h) or a UTC day (7d), oldest first, zero-filled. */
const point = <T extends z.ZodRawShape>(shape: T) => z.object({ t: iso(), ...shape });

export const OpsHealthSchema = z.object({
  /** Checks failing as of the health check's last run, with how many runs in a row. */
  failing: z.array(z.object({ check: z.string(), failures: count() })),
  /** The checks the last alert email reported down; empty once it said all clear. */
  announcedDown: z.array(z.string()),
  /** When that email went out; null if none has. */
  lastAlertAt: iso().nullable(),
  dailyCron: z
    .object({ lastRunAt: iso(), lastOkAt: iso().nullable(), failed: z.array(z.string()) })
    .nullable(),
  tileGc: z.object({ lastRunAt: iso(), lastOkAt: iso().nullable() }).nullable(),
  cdnPurge: z.object({
    lastFailure: z.object({ at: iso(), detail: z.string() }).nullable(),
    /** Records waiting for the 15-minute retry; `capped` when there are at least that many. */
    pending: count(),
    pendingCapped: z.boolean(),
    /** Dead letters an operator has to purge by hand. */
    dead: count(),
    deadCapped: z.boolean(),
  }),
  backup: z.object({
    /** The newest day whose set is complete (YYYY-MM-DD). */
    lastCompleteDate: z.string().nullable(),
    /** Whole UTC days since that date; the backup runs daily, so 1 is on time. */
    lastCompleteDaysAgo: count().nullable(),
    /** The set being written (backup/progress.json), if one is: its day and objects so far. */
    inProgress: z.object({ date: z.string(), objects: count(), runs: count() }).nullable(),
  }),
});
export type OpsHealth = z.infer<typeof OpsHealthSchema>;

export const OpsWorkersSchema = z.object({
  scripts: z.array(
    z.object({
      script: z.string(),
      requests: count(),
      errors: count(),
      subrequests: count(),
      /** CPU time per invocation in milliseconds; null with no invocations. */
      cpuP50Ms: count().nullable(),
      cpuP99Ms: count().nullable(),
      /** Invocations by outcome (success, scriptThrewException, exceededResources, ...). */
      byStatus: z.record(z.string(), count()),
    }),
  ),
  series: z.array(point({ requests: count(), errors: count() })),
});
export type OpsWorkers = z.infer<typeof OpsWorkersSchema>;

export const OpsStorageSchema = z.object({
  buckets: z.array(
    z.object({
      bucket: z.string(),
      /** Latest sample in the range; null when Cloudflare had none. */
      objects: count().nullable(),
      bytes: count().nullable(),
      /** Operations in the range, by billing class (free: deletes and aborts). */
      classA: count(),
      classB: count(),
      free: count(),
      /** The busiest operations, most first. */
      topActions: z.array(z.object({ action: z.string(), requests: count() })),
    }),
  ),
});
export type OpsStorage = z.infer<typeof OpsStorageSchema>;

export const OpsQueuesSchema = z.object({
  queues: z.array(
    z.object({
      queueId: z.string(),
      /** Null when the token can't list queues; the id still identifies it. */
      name: z.string().nullable(),
      backlogAvg: count(),
      writes: count(),
      reads: count(),
      acked: count(),
      /** Messages moved to the dead-letter queue, and deliveries that failed. */
      dlq: count(),
      failed: count(),
      /** Average ms from write to consume; null with no reads. */
      lagMsAvg: count().nullable(),
      retriesAvg: count().nullable(),
    }),
  ),
});
export type OpsQueues = z.infer<typeof OpsQueuesSchema>;

export const OpsDurableObjectsSchema = z.object({
  /** Across the whole account: the datasets don't name the script. */
  requests: count(),
  errors: count(),
  storedBytes: count().nullable(),
});
export type OpsDurableObjects = z.infer<typeof OpsDurableObjectsSchema>;

export const OpsContainersSchema = z.object({
  /** Across the whole account (the tiler is the only container application). */
  cpuSeconds: count(),
  maxMemoryBytes: count().nullable(),
  cpuUtilizationP95: count().nullable(),
  instances: count(),
  series: z.array(point({ cpuSeconds: count() })),
});
export type OpsContainers = z.infer<typeof OpsContainersSchema>;

export const OpsUsageSchema = z.object({
  /** The calendar month so far (UTC), YYYY-MM. */
  month: z.string(),
  items: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      /** Null when its dataset couldn't be read; `reason` says why. */
      used: count().nullable(),
      reason: z.string().nullable(),
      /** What the Workers Paid plan includes each month. */
      included: count(),
      unit: z.enum(['count', 'bytes', 'seconds', 'byte-seconds']),
      /** Whose usage: this environment's resources, or the whole account's. */
      scope: z.enum(['env', 'account']),
    }),
  ),
});
export type OpsUsage = z.infer<typeof OpsUsageSchema>;

export const OpsProductSchema = z.object({
  views: count(),
  scenes: count(),
  hotspots: count(),
  dwellAvgMs: count().nullable(),
  series: z.array(point({ views: count() })),
  topTours: z.array(
    z.object({
      tourId: z.string(),
      views: count(),
      /** From the tour's public bundle; null once it's unpublished. */
      title: z.string().nullable(),
      slug: z.string().nullable(),
    }),
  ),
  /** Views by where the viewer ran: the tour page or an embed. */
  surfaces: z.array(z.object({ surface: z.string(), views: count() })),
});
export type OpsProduct = z.infer<typeof OpsProductSchema>;

/** The operator event stream (ops-events.ts) over the range. Sampled, like the viewer events. */
export const OpsPipelineSchema = z.object({
  /** Every event, detail and Worker seen, with its count and the sum of its values. */
  events: z.array(
    z.object({
      event: z.enum(OPS_EVENT_NAMES),
      detail: z.string(),
      service: z.string(),
      n: count(),
      value: count(),
    }),
  ),
  /** 95th percentile tiling time; null with no tiles, or if Analytics Engine can't say. */
  tileP95Ms: count().nullable(),
  series: z.array(point({ uploads: count(), tiled: count(), failed: count() })),
});
export type OpsPipeline = z.infer<typeof OpsPipelineSchema>;

export const OpsMetricsSchema = z.object({
  range: z.enum(OPS_RANGES),
  from: iso(),
  to: iso(),
  health: section(OpsHealthSchema),
  workers: section(OpsWorkersSchema),
  storage: section(OpsStorageSchema),
  queues: section(OpsQueuesSchema),
  durableObjects: section(OpsDurableObjectsSchema),
  containers: section(OpsContainersSchema),
  usage: section(OpsUsageSchema),
  product: section(OpsProductSchema),
  pipeline: section(OpsPipelineSchema),
});
export type OpsMetrics = z.infer<typeof OpsMetricsSchema>;
export type OpsSection<T> = { status: 'ok'; data: T } | { status: 'unavailable'; reason: string };

/**
 * admin-api's OPS_RESOURCES var: which of the account's Workers, buckets and queues are
 * this environment's (dev and production share one account). Names only, and only the
 * characters Cloudflare allows, since they go into analytics queries verbatim.
 */
const resourceName = () => z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const OpsResourcesSchema = z.object({
  workers: z.array(resourceName()).min(1),
  buckets: z.array(resourceName()).min(1),
  queues: z.array(resourceName()),
});
export type OpsResources = z.infer<typeof OpsResourcesSchema>;
