import {
  DEFAULT_OPS_RANGE,
  OPS_RANGES,
  OpsResourcesSchema,
  type OpsAccounts,
  type OpsMetrics,
  type OpsRange,
  type OpsResources,
  type OpsSection,
} from '@internal/contracts';
import { rateLimit } from '@internal/worker-kit';
import type { Context } from 'hono';

import { WRITE_RATE_PERIOD_SECONDS } from '../limits.js';
import {
  containersSection,
  durableObjectsSection,
  queuesSection,
  storageSection,
  usageSection,
  workersSection,
} from './platform.js';
import { accountsSection } from './accounts.js';
import { moderationSection } from './moderation.js';
import { pipelineSection } from './pipeline.js';
import { productSection } from './product.js';
import { healthSection } from './state.js';
import { OpsUnavailable } from './unavailable.js';
import { opsWindow } from './window.js';

// GET /api/admin/ops/metrics (operators only, ops-gate.ts): the operator dashboard.
// docs/deploy.md, "Operator pages".

export const OPS_METRICS_PATH = '/api/admin/ops/metrics';
// One answer per range is reused this long (this location's cache): a page load is up
// to about thirty GraphQL node queries and 75 R2 list pages, and GraphQL allows 300
// queries per 5 minutes per user.
export const OPS_METRICS_CACHE_SECONDS = 60;
// The accounts section lists the bucket (Class A operations) and is the same whatever the
// range, so it has its own entry, kept longer: stocks move slowly.
export const OPS_ACCOUNTS_CACHE_SECONDS = 300;

/** accountsSection, from this location's cache when `origin` names one (the route's). */
export const cachedAccounts = async (
  bucket: R2Bucket,
  now: Date,
  origin?: string,
): Promise<OpsAccounts> => {
  if (!origin) return accountsSection(bucket, now);
  const key = new Request(new URL(`${OPS_METRICS_PATH}/accounts`, origin).toString());
  const hit = await caches.default.match(key);
  if (hit) return hit.json<OpsAccounts>();
  const data = await accountsSection(bucket, now);
  await caches.default.put(
    key,
    Response.json(data, { headers: { 'Cache-Control': `max-age=${OPS_ACCOUNTS_CACHE_SECONDS}` } }),
  );
  return data;
};

export const parseRange = (raw: string | undefined): OpsRange | null =>
  raw === undefined
    ? DEFAULT_OPS_RANGE
    : (OPS_RANGES as readonly string[]).includes(raw)
      ? (raw as OpsRange)
      : null;

/** The env's resources from OPS_RESOURCES, or why not. */
export const opsResources = (raw: unknown): OpsResources | string => {
  const parsed = OpsResourcesSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'OPS_RESOURCES is missing or malformed';
};

/** Runs one section; a source that fails becomes that section's reason. */
const settle = async <T>(work: () => Promise<T>): Promise<OpsSection<T>> => {
  try {
    return { status: 'ok', data: await work() };
  } catch (err) {
    if (err instanceof OpsUnavailable) return { status: 'unavailable', reason: err.message };
    console.error('ops metrics: section failed', err instanceof Error ? err.name : 'unknown');
    return { status: 'unavailable', reason: 'internal error' };
  }
};

/** Every section for `range`; with `origin`, the accounts section comes through its cache. */
export const getOpsMetrics = async (
  env: Env,
  range: OpsRange,
  now: Date,
  origin?: string,
): Promise<OpsMetrics> => {
  const w = opsWindow(range, now);
  const resources = opsResources(env.OPS_RESOURCES);
  // Every Cloudflare section needs the token; most also need this env's resource names.
  const account = async <T>(work: () => Promise<T>): Promise<T> => {
    if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
      throw new OpsUnavailable('CF_ANALYTICS_TOKEN or CF_ACCOUNT_ID not set');
    }
    return work();
  };
  const cf = <T>(work: (r: OpsResources) => Promise<T>): Promise<T> =>
    account(() => {
      if (typeof resources === 'string') throw new OpsUnavailable(resources);
      return work(resources);
    });
  const [
    health,
    workers,
    storage,
    queues,
    durableObjects,
    containers,
    usage,
    product,
    pipeline,
    moderation,
    accounts,
  ] = await Promise.all([
    settle(() => healthSection(env.BUCKET, now)),
    settle(() => cf((r) => workersSection(env, w, r))),
    settle(() => cf((r) => storageSection(env, w, r))),
    settle(() => cf((r) => queuesSection(env, w, r))),
    settle(() => account(() => durableObjectsSection(env, w))),
    settle(() => account(() => containersSection(env, w))),
    settle(() => cf((r) => usageSection(env, w, r))),
    settle(() => productSection(env, env.BUCKET, w)),
    settle(() => pipelineSection(env, w)),
    settle(() => moderationSection(env.BUCKET)),
    settle(() => cachedAccounts(env.BUCKET, now, origin)),
  ]);
  return {
    range,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    health,
    workers,
    storage,
    queues,
    durableObjects,
    containers,
    usage,
    product,
    pipeline,
    moderation,
    accounts,
  };
};

export const opsMetricsRoute = async (
  c: Context<{ Bindings: Env; Variables: { sub: string | undefined } }>,
) => {
  // The gate (requireOperator) has run, so there is a sub. Insights' budget: each uncached
  // answer is many analytics calls too.
  const limited = await rateLimit(
    c.env.INSIGHTS_LIMITER,
    c.get('sub') ?? 'operator',
    WRITE_RATE_PERIOD_SECONDS,
    { sink: c.env.OPS_EVENTS, service: 'admin-api', limiter: 'INSIGHTS_LIMITER' },
  );
  if (limited) return limited;
  const range = parseRange(c.req.query('range'));
  if (!range) return c.json({ error: `range must be one of ${OPS_RANGES.join(', ')}` }, 400);
  // Operators only reach here, and they all see the same thing: one entry per range.
  const key = new Request(new URL(`${OPS_METRICS_PATH}?range=${range}`, c.req.url).toString());
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return c.json(await hit.json<OpsMetrics>());
  const metrics = await getOpsMetrics(c.env, range, new Date(), c.req.url);
  const stored = Response.json(metrics, {
    headers: { 'Cache-Control': `max-age=${OPS_METRICS_CACHE_SECONDS}` },
  });
  c.executionCtx.waitUntil(cache.put(key, stored));
  return c.json(metrics);
};
