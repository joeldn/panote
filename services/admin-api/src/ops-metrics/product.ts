import { isContentId, pubTourKey, type OpsProduct } from '@internal/contracts';

import { AnalyticsUnavailable, num, runSql, str } from '../insights.js';
import { OpsUnavailable } from './unavailable.js';
import { addTo, bucketOf, fillSeries, type OpsWindow } from './window.js';

// Viewer activity across every tour: the same Analytics Engine events the per-tour
// insights read (public-api's events.ts: index1 = tourId, blob1 = type, blob4 = surface,
// double1 = dwell ms), without the tour filter. Sampled, hence SUM(_sample_interval).

const DATASET_PATTERN = /^[A-Za-z0-9_]+$/;
export const TOP_TOURS = 10;

export const buildProductQueries = (dataset: string, w: OpsWindow) => {
  if (!DATASET_PATTERN.test(dataset)) {
    throw new OpsUnavailable(`AE_DATASET must match ${DATASET_PATTERN}`);
  }
  const since = w.from.toISOString().slice(0, 19).replace('T', ' ');
  const inRange = `timestamp >= toDateTime('${since}')`;
  const n = 'SUM(_sample_interval) AS n';
  const step = w.step === 'hour' ? 'toStartOfHour' : 'toStartOfDay';
  return {
    byType: `SELECT blob1 AS type, ${n} FROM ${dataset} WHERE ${inRange} GROUP BY type FORMAT JSON`,
    dwell: `SELECT SUM(double1 * _sample_interval) / SUM(_sample_interval) AS avg, ${n} FROM ${dataset} WHERE ${inRange} AND blob1 = 'dwell' FORMAT JSON`,
    series: `SELECT ${step}(timestamp) AS t, ${n} FROM ${dataset} WHERE ${inRange} AND blob1 = 'view' GROUP BY t ORDER BY t FORMAT JSON`,
    topTours: `SELECT index1 AS tour, ${n} FROM ${dataset} WHERE ${inRange} AND blob1 = 'view' GROUP BY tour ORDER BY n DESC LIMIT ${TOP_TOURS} FORMAT JSON`,
    surfaces: `SELECT blob4 AS surface, ${n} FROM ${dataset} WHERE ${inRange} AND blob1 = 'view' GROUP BY surface ORDER BY n DESC FORMAT JSON`,
  };
};

/** A tour's public title and slug, from its bundle; nulls once it's unpublished. */
const publicName = async (
  bucket: R2Bucket,
  tourId: string,
): Promise<{ title: string | null; slug: string | null }> => {
  if (!isContentId(tourId)) return { title: null, slug: null };
  try {
    const obj = await bucket.get(pubTourKey(tourId));
    const doc = obj ? ((await obj.json()) as { title?: unknown; slug?: unknown }) : null;
    return {
      title: typeof doc?.title === 'string' ? doc.title : null,
      slug: typeof doc?.slug === 'string' ? doc.slug : null,
    };
  } catch {
    return { title: null, slug: null };
  }
};

// AE answers "2026-10-23 09:00:00" in UTC.
const aeTime = (s: string): string => `${s.replace(' ', 'T')}Z`;

export const productSection = async (
  env: Env,
  bucket: R2Bucket,
  w: OpsWindow,
): Promise<OpsProduct> => {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID || !env.AE_DATASET) {
    throw new OpsUnavailable('analytics not configured');
  }
  const q = buildProductQueries(env.AE_DATASET, w);
  try {
    const [byType, dwell, series, top, surfaces] = await Promise.all([
      runSql(env, q.byType),
      runSql(env, q.dwell),
      runSql(env, q.series),
      runSql(env, q.topTours),
      runSql(env, q.surfaces),
    ]);
    const types = new Map(byType.map((r) => [str(r.type), Math.round(num(r.n))]));
    const sums = new Map<string, Record<'views', number>>();
    for (const r of series)
      addTo(sums, bucketOf(w, aeTime(str(r.t))), { views: Math.round(num(r.n)) });
    const dwellRow = dwell[0];
    const topTours = await Promise.all(
      top.map(async (r) => {
        const tourId = str(r.tour);
        return { tourId, views: Math.round(num(r.n)), ...(await publicName(bucket, tourId)) };
      }),
    );
    return {
      views: types.get('view') ?? 0,
      scenes: types.get('scene') ?? 0,
      hotspots: types.get('hotspot') ?? 0,
      dwellAvgMs: dwellRow && num(dwellRow.n) > 0 ? Math.round(num(dwellRow.avg)) : null,
      series: fillSeries(w, sums, ['views'] as const),
      topTours,
      surfaces: surfaces.map((r) => ({
        surface: str(r.surface) || 'page',
        views: Math.round(num(r.n)),
      })),
    };
  } catch (err) {
    if (err instanceof AnalyticsUnavailable) throw new OpsUnavailable(err.message);
    throw err;
  }
};
