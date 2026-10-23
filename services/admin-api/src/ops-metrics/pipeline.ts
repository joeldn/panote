import {
  OPS_EVENT_NAMES,
  OPS_EVENTS_SCHEMA_VERSION,
  type OpsEventName,
  type OpsPipeline,
} from '@internal/contracts';

import { AnalyticsUnavailable, num, runSql, str, type Row } from '../insights.js';
import { OpsUnavailable } from './unavailable.js';
import { addTo, bucketOf, fillSeries, type OpsWindow } from './window.js';

// The pipeline section: the operator events every Worker writes (worker-kit's recordOps:
// blob1 = event, blob2 = detail, blob3 = service, blob4 = schema version, double1 = value),
// read from OPS_EVENTS_DATASET. Sampled, hence SUM(_sample_interval).

const DATASET_PATTERN = /^[A-Za-z0-9_]+$/;
/** Distinct (event, detail, service) rows; the details are a small fixed vocabulary. */
export const MAX_PIPELINE_ROWS = 500;

const SERIES_EVENTS = {
  'upload-url': 'uploads',
  'tile-ok': 'tiled',
  'tile-dead': 'failed',
} as const;

export const buildPipelineQueries = (dataset: string, w: OpsWindow) => {
  if (!DATASET_PATTERN.test(dataset)) {
    throw new OpsUnavailable(`OPS_EVENTS_DATASET must match ${DATASET_PATTERN}`);
  }
  const since = w.from.toISOString().slice(0, 19).replace('T', ' ');
  const where = `timestamp >= toDateTime('${since}') AND blob4 = '${OPS_EVENTS_SCHEMA_VERSION}'`;
  const n = 'SUM(_sample_interval) AS n';
  const step = w.step === 'hour' ? 'toStartOfHour' : 'toStartOfDay';
  const seriesEvents = Object.keys(SERIES_EVENTS)
    .map((e) => `'${e}'`)
    .join(', ');
  return {
    events: `SELECT blob1 AS event, blob2 AS detail, blob3 AS service, ${n}, SUM(double1 * _sample_interval) AS value FROM ${dataset} WHERE ${where} GROUP BY event, detail, service ORDER BY n DESC LIMIT ${MAX_PIPELINE_ROWS} FORMAT JSON`,
    tileP95: `SELECT quantileExactWeighted(0.95)(double1, _sample_interval) AS p95, ${n} FROM ${dataset} WHERE ${where} AND blob1 = 'tile-ok' FORMAT JSON`,
    series: `SELECT ${step}(timestamp) AS t, blob1 AS event, ${n} FROM ${dataset} WHERE ${where} AND blob1 IN (${seriesEvents}) GROUP BY t, event ORDER BY t FORMAT JSON`,
  };
};

const isEventName = (s: string): s is OpsEventName =>
  (OPS_EVENT_NAMES as readonly string[]).includes(s);

// AE answers "2026-10-23 09:00:00" in UTC.
const aeTime = (s: string): string => `${s.replace(' ', 'T')}Z`;

const p95Of = (rows: Row[] | null): number | null => {
  const row = rows?.[0];
  if (!row) return null;
  const n = Number(row.n);
  const p95 = Number(row.p95);
  return n > 0 && Number.isFinite(p95) ? Math.max(0, Math.round(p95)) : null;
};

export const pipelineSection = async (env: Env, w: OpsWindow): Promise<OpsPipeline> => {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID || !env.OPS_EVENTS_DATASET) {
    throw new OpsUnavailable('analytics not configured');
  }
  const q = buildPipelineQueries(env.OPS_EVENTS_DATASET, w);
  try {
    const [events, series, p95] = await Promise.all([
      runSql(env, q.events),
      runSql(env, q.series),
      // The percentile is a nicety: a dataset that won't answer it costs only this tile.
      runSql(env, q.tileP95).catch(() => null),
    ]);
    const sums = new Map<string, Record<'uploads' | 'tiled' | 'failed', number>>();
    for (const r of series) {
      const key = SERIES_EVENTS[str(r.event) as keyof typeof SERIES_EVENTS];
      if (!key) continue;
      const values = { uploads: 0, tiled: 0, failed: 0 };
      values[key] = Math.round(num(r.n));
      addTo(sums, bucketOf(w, aeTime(str(r.t))), values);
    }
    const tileP95Ms = p95Of(p95);
    return {
      events: events.flatMap((r) => {
        const event = str(r.event);
        if (!isEventName(event)) return [];
        return [
          {
            event,
            detail: str(r.detail),
            service: str(r.service),
            n: Math.round(num(r.n)),
            value: Math.max(0, num(r.value)),
          },
        ];
      }),
      tileP95Ms,
      series: fillSeries(w, sums, ['uploads', 'tiled', 'failed'] as const),
    };
  } catch (err) {
    if (err instanceof AnalyticsUnavailable) throw new OpsUnavailable(err.message);
    throw err;
  }
};
