import {
  contentIdError,
  DEFAULT_INSIGHTS_DAYS,
  isContentId,
  MAX_INSIGHTS_DAYS,
  MIN_INSIGHTS_DAYS,
  PANO_PATTERN,
  resolveTourAccess,
  type InsightsOk,
} from '@internal/contracts';
import { authenticate, rateLimit } from '@internal/worker-kit';
import type { Context } from 'hono';

import { WRITE_RATE_PERIOD_SECONDS } from './limits.js';
import { bindingStore } from './members.js';

// Tour insights (unit B5): Workers Analytics Engine via its SQL API. The
// event schema is written by public-api's events.ts (blob1 = type, etc.).

const DAY_MS = 86_400_000;
const DATASET_PATTERN = /^[A-Za-z0-9_]+$/;
const TOP_HOTSPOTS = 5;
const MAX_BY_PANO = 100;
export const SQL_TIMEOUT_MS = 10_000;
// How long one tour's answer for one `days` is reused (in this Cloudflare location's
// cache), so reopening or refreshing Insights doesn't run the 4 SQL queries again.
export const INSIGHTS_CACHE_SECONDS = 60;

export class AnalyticsUnavailable extends Error {}

export const parseDays = (raw: string | undefined): number | null => {
  if (raw === undefined) return DEFAULT_INSIGHTS_DAYS;
  if (!/^\d{1,2}$/.test(raw)) return null;
  const days = Number(raw);
  return days >= MIN_INSIGHTS_DAYS && days <= MAX_INSIGHTS_DAYS ? days : null;
};

// `days` whole UTC days ending today; `from` is 00:00 UTC of the first one.
export const insightsWindow = (days: number, now: Date): { from: Date; dates: string[] } => {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(today - (days - 1) * DAY_MS);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(from.getTime() + i * DAY_MS).toISOString().slice(0, 10),
  );
  return { from, dates };
};

export interface InsightsQueries {
  daily: string;
  avgDwell: string;
  byPano: string;
  topHotspots: string;
}

// The SQL API has no bind parameters, so both interpolated values are
// charset-checked here, right where they're interpolated.
export const buildInsightsQueries = (
  dataset: string,
  tourId: string,
  from: Date,
): InsightsQueries => {
  // A bad var is a config fault: surface it as the route's 502, not a 500.
  if (!DATASET_PATTERN.test(dataset)) {
    throw new AnalyticsUnavailable(`AE_DATASET must match ${DATASET_PATTERN}`);
  }
  if (!PANO_PATTERN.test(tourId)) throw new Error(`tourId must match ${PANO_PATTERN}`);
  const since = from.toISOString().slice(0, 19).replace('T', ' ');
  const where = (type: string) =>
    `index1 = '${tourId}' AND blob1 = '${type}' AND timestamp >= toDateTime('${since}')`;
  const n = 'SUM(_sample_interval) AS n';
  return {
    daily: `SELECT toStartOfDay(timestamp) AS d, ${n} FROM ${dataset} WHERE ${where('view')} GROUP BY d ORDER BY d FORMAT JSON`,
    avgDwell: `SELECT SUM(double1 * _sample_interval) / SUM(_sample_interval) AS avg, ${n} FROM ${dataset} WHERE ${where('dwell')} FORMAT JSON`,
    byPano: `SELECT blob2 AS p, ${n} FROM ${dataset} WHERE ${where('view')} AND blob2 != '' GROUP BY p ORDER BY n DESC LIMIT ${MAX_BY_PANO} FORMAT JSON`,
    topHotspots: `SELECT blob2 AS p, blob3 AS h, ${n} FROM ${dataset} WHERE ${where('hotspot')} AND blob3 != '' GROUP BY p, h ORDER BY n DESC LIMIT ${TOP_HOTSPOTS} FORMAT JSON`,
  };
};

type Row = Record<string, unknown>;

// FORMAT JSON returns { meta, data, rows }; 64-bit ints may come back quoted.
const runSql = async (env: Env, sql: string): Promise<Row[]> => {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: sql,
    signal: AbortSignal.timeout(SQL_TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new AnalyticsUnavailable(`SQL API fetch failed: ${String(err)}`);
  });
  if (!res.ok) throw new AnalyticsUnavailable(`SQL API ${res.status}`);
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!body || !Array.isArray(body.data)) throw new AnalyticsUnavailable('SQL API: no data array');
  return body.data as Row[];
};

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new AnalyticsUnavailable(`SQL API: non-numeric ${String(v)}`);
  return n;
};

const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new AnalyticsUnavailable('SQL API: non-string column');
  return v;
};

export const getInsights = async (
  env: Env,
  tourId: string,
  days: number,
  now: Date,
): Promise<InsightsOk> => {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID || !env.AE_DATASET) {
    throw new AnalyticsUnavailable('analytics not configured');
  }
  const { from, dates } = insightsWindow(days, now);
  const q = buildInsightsQueries(env.AE_DATASET, tourId, from);
  const [daily, dwell, byPano, top] = await Promise.all([
    runSql(env, q.daily),
    runSql(env, q.avgDwell),
    runSql(env, q.byPano),
    runSql(env, q.topHotspots),
  ]);
  const perDay = new Map<string, number>();
  for (const r of daily) perDay.set(str(r.d).slice(0, 10), num(r.n));
  const series = dates.map((date) => ({ date, views: Math.round(perDay.get(date) ?? 0) }));
  const dwellRow = dwell[0];
  const dwellCount = dwellRow ? num(dwellRow.n) : 0;
  return {
    days,
    from: from.toISOString(),
    to: now.toISOString(),
    totalViews: series.reduce((sum, d) => sum + d.views, 0),
    avgDwellMs: dwellRow && dwellCount > 0 ? Math.round(num(dwellRow.avg)) : null,
    daily: series,
    byPano: byPano.map((r) => ({ panoId: str(r.p), views: Math.round(num(r.n)) })),
    topHotspots: top.map((r) => ({
      panoId: str(r.p),
      hotspotId: str(r.h),
      opens: Math.round(num(r.n)),
    })),
  };
};

// The cache key: this route's own URL with nothing but `days`, plus the owner, so made-up
// query parameters can't skip the cache and one owner's entry is never another's. The owner
// goes in as a SHA-256 of the sub, never the sub itself (it decodes to the Auth0 id). The
// route also checks the caller owns the tour before it looks here, and admin-api owns this
// path, so the CDN never answers it from this cache itself.
const insightsCacheKey = async (
  reqUrl: string,
  sub: string,
  tourId: string,
  days: number,
): Promise<Request> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub));
  const owner = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const url = new URL(`/api/admin/tours/${tourId}/insights`, reqUrl);
  url.searchParams.set('days', String(days));
  url.searchParams.set('owner', owner);
  return new Request(url.toString());
};

export const insightsRoute = async (
  c: Context<{ Bindings: Env; Variables: { sub: string | undefined } }>,
  tourId: string,
) => {
  const sub = c.get('sub') ?? (await authenticate(c.req.raw, c.env)).sub;
  c.header('Cache-Control', 'private, no-store');
  // Its own, tighter budget per owner, on top of the read limit every GET has.
  const limited = await rateLimit(c.env.INSIGHTS_LIMITER, sub, WRITE_RATE_PERIOD_SECONDS);
  if (limited) return limited;
  if (!isContentId(tourId)) return c.json({ error: contentIdError('tourId') }, 400);
  const days = parseDays(c.req.query('days'));
  if (days === null) {
    return c.json(
      { error: `days must be an integer between ${MIN_INSIGHTS_DAYS} and ${MAX_INSIGHTS_DAYS}` },
      400,
    );
  }
  // Access first, every time (the owner or one of the tour's editors): the cache below is
  // shared by everyone who asks.
  if (!(await resolveTourAccess(bindingStore(c.env.BUCKET), sub, tourId))) {
    return c.json({ error: 'not found' }, 404);
  }
  const cache = caches.default;
  const key = await insightsCacheKey(c.req.url, sub, tourId, days);
  const hit = await cache.match(key);
  if (hit) return c.json(await hit.json<InsightsOk>());
  let insights: InsightsOk;
  try {
    insights = await getInsights(c.env, tourId, days, new Date());
  } catch (err) {
    if (!(err instanceof AnalyticsUnavailable)) throw err;
    console.error('insights: analytics unavailable', { tourId, reason: err.message });
    return c.json({ error: 'analytics unavailable' }, 502);
  }
  // Only a full answer is kept; the browser still gets private, no-store.
  const stored = Response.json(insights, {
    headers: { 'Cache-Control': `max-age=${INSIGHTS_CACHE_SECONDS}` },
  });
  c.executionCtx.waitUntil(cache.put(key, stored));
  return c.json(insights);
};
