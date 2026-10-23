import {
  CDN_PURGE_DEAD_PREFIX,
  CDN_PURGE_FAILURE_KEY,
  CDN_PURGE_PENDING_PREFIX,
  CRON_STATUS_KEY,
  HEALTH_STATE_KEY,
  OpsMetricsSchema,
  backupCompleteKey,
  pubTourKey,
  type BackupProgress,
  type OpsSection,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import worker from '../index.js';
import { getOpsMetrics, opsResources, parseRange } from './index.js';
import { buildPipelineQueries } from './pipeline.js';
import { INCLUDED, r2ClassOf, usageLines } from './platform.js';
import { buildProductQueries } from './product.js';
import { healthSection } from './state.js';
import { bucketOf, opsWindow } from './window.js';

beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t === 'operator') return { sub: 'auth0|operator' };
    if (t === 'owner') return { sub: 'auth0|owner' };
    return Promise.reject(new Error('bad'));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date('2026-10-23T10:20:00.000Z');
const testEnv = { ...env, CF_ANALYTICS_TOKEN: 'test-token' } as Env;

type Answer = Record<string, unknown[]> | { errors: { message: string }[] };

/**
 * Cloudflare's three APIs, stubbed: GraphQL answers by the dataset the query names (a
 * function of the query text), the Queues API by its URL, and Analytics Engine by its SQL.
 */
const stubCloudflare = (graphql: (query: string) => Answer, opts: { queues?: boolean } = {}) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/graphql')) {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      const answer = graphql(query);
      if ('errors' in answer) return Response.json({ data: null, errors: answer.errors });
      return Response.json({ data: { viewer: { accounts: [answer] } }, errors: null });
    }
    if (url.includes('/queues')) {
      if (opts.queues === false) return Response.json({ success: false }, { status: 403 });
      return Response.json({
        result: [
          { queue_id: 'q1', queue_name: 'pano-uploads-dev' },
          { queue_id: 'q2', queue_name: 'pano-uploads-dlq-dev' },
          { queue_id: 'q9', queue_name: 'pano-uploads' },
        ],
      });
    }
    const sql = String(init?.body);
    if (sql.includes('FROM panote_ops_dev')) {
      const rows = pipelineAnswer(sql);
      if (rows === 'refuse')
        return Response.json({ errors: ['no such function'] }, { status: 422 });
      return Response.json({ meta: [], data: rows, rows: rows.length });
    }
    const data = sql.includes('GROUP BY type')
      ? [
          { type: 'view', n: '40' },
          { type: 'scene', n: 12 },
          { type: 'hotspot', n: 3 },
        ]
      : sql.includes("blob1 = 'dwell'")
        ? [{ avg: 5250.4, n: 2 }]
        : sql.includes('toStartOf')
          ? [{ t: '2026-10-23 09:00:00', n: 40 }]
          : sql.includes('GROUP BY tour')
            ? [
                { tour: 'tour-1', n: 30 },
                { tour: 'tour-gone', n: 10 },
              ]
            : [
                { surface: 'embed', n: 10 },
                { surface: 'page', n: 30 },
              ];
    return Response.json({ meta: [], data, rows: data.length });
  });

// The operator event stream's three queries (pipeline.ts).
let pipelineP95: 'answer' | 'refuse' = 'answer';
const pipelineAnswer = (sql: string): Record<string, unknown>[] | 'refuse' => {
  if (sql.includes('quantileExactWeighted')) {
    return pipelineP95 === 'refuse' ? 'refuse' : [{ p95: 41234.6, n: 3 }];
  }
  if (sql.includes('GROUP BY t, event')) {
    return [
      { t: '2026-10-23 09:00:00', event: 'upload-url', n: 4 },
      { t: '2026-10-23 09:00:00', event: 'tile-ok', n: 3 },
      { t: '2026-10-23 10:00:00', event: 'tile-dead', n: 1 },
      { t: '2026-10-23 10:00:00', event: 'tile-ok', n: '2' },
    ];
  }
  return [
    { event: 'upload-url', detail: 'new', service: 'upload-api', n: 4, value: 8e7 },
    { event: 'tile-ok', detail: '', service: 'tiler-consumer', n: 5, value: 100_000 },
    { event: 'rate-limited', detail: 'WRITE_LIMITER', service: 'admin-api', n: '2', value: 0 },
    // A name this build doesn't know (a newer Worker): left out, not an error.
    { event: 'tile-teleported', detail: '', service: 'tiler-consumer', n: 1, value: 0 },
  ];
};

// A full, plausible answer for every dataset the dashboard asks for.
const platform = (query: string): Answer => {
  if (query.includes('byScript: workersInvocationsAdaptive')) {
    return {
      byScript: [
        {
          sum: { requests: 100, errors: 2, subrequests: 50 },
          quantiles: { cpuTimeP50: 1500, cpuTimeP99: 9000 },
          dimensions: { scriptName: 'panote-admin-api-dev' },
        },
      ],
      byStatus: [
        {
          sum: { requests: 98 },
          dimensions: { scriptName: 'panote-admin-api-dev', status: 'success' },
        },
        {
          sum: { requests: 2 },
          dimensions: { scriptName: 'panote-admin-api-dev', status: 'scriptThrewException' },
        },
      ],
      series: [
        { sum: { requests: 60, errors: 1 }, dimensions: { datetimeHour: '2026-10-23T09:00:00Z' } },
        { sum: { requests: 40, errors: 1 }, dimensions: { datetimeHour: '2026-10-23T10:00:00Z' } },
      ],
    };
  }
  if (query.includes('s0: r2StorageAdaptiveGroups') && query.includes('o0:')) {
    return {
      s0: [{ max: { objectCount: 1200, payloadSize: 5e9, metadataSize: 1e6 } }],
      o0: [
        { sum: { requests: 900 }, dimensions: { actionType: 'GetObject' } },
        { sum: { requests: 80 }, dimensions: { actionType: 'PutObject' } },
        { sum: { requests: 20 }, dimensions: { actionType: 'ListObjects' } },
        { sum: { requests: 5 }, dimensions: { actionType: 'DeleteObject' } },
      ],
    };
  }
  if (query.includes('queueBacklogAdaptiveGroups')) {
    return {
      backlog: [
        { avg: { messages: 3 }, dimensions: { queueId: 'q1' } },
        { avg: { messages: 7 }, dimensions: { queueId: 'q9' } },
      ],
      ops: [
        {
          count: 10,
          avg: {},
          dimensions: { queueId: 'q1', actionType: 'WriteMessage', outcome: '' },
        },
        {
          count: 10,
          avg: { lagTime: 2000, retryCount: 0 },
          dimensions: { queueId: 'q1', actionType: 'ReadMessage', outcome: '' },
        },
        {
          count: 8,
          avg: { retryCount: 0.5 },
          dimensions: { queueId: 'q1', actionType: 'DeleteMessage', outcome: 'success' },
        },
        {
          count: 2,
          avg: { retryCount: 3 },
          dimensions: { queueId: 'q1', actionType: 'DeleteMessage', outcome: 'dlq' },
        },
      ],
    };
  }
  if (query.includes('inv: durableObjectsInvocationsAdaptiveGroups')) {
    return {
      inv: [{ sum: { requests: 70, errors: 1 } }],
      stored: [{ max: { storedBytes: 4096 } }],
    };
  }
  if (query.includes('rows: containersMetricsAdaptiveGroups')) {
    return {
      rows: [
        {
          sum: { cpuTimeSec: 30 },
          max: { memory: 3e8 },
          quantiles: { cpuUtilizationP95: 0.4 },
          dimensions: { datetimeHour: '2026-10-23T09:00:00Z', instanceId: 'i1' },
        },
        {
          sum: { cpuTimeSec: 12 },
          max: { memory: 5e8 },
          quantiles: { cpuUtilizationP95: 0.9 },
          dimensions: { datetimeHour: '2026-10-23T10:00:00Z', instanceId: 'i2' },
        },
      ],
    };
  }
  if (query.includes('w: workersInvocationsAdaptive')) return { w: [{ sum: { requests: 2e6 } }] };
  if (query.includes('r2: r2OperationsAdaptiveGroups')) {
    return {
      r2: [
        { sum: { requests: 400 }, dimensions: { actionType: 'PutObject' } },
        { sum: { requests: 9000 }, dimensions: { actionType: 'GetObject' } },
      ],
    };
  }
  if (query.includes('s0: r2StorageAdaptiveGroups')) {
    return { s0: [{ max: { payloadSize: 6e9, metadataSize: 0 } }] };
  }
  if (query.includes('q: queueMessageOperationsAdaptiveGroups')) {
    return { q: [{ sum: { billableOperations: 300 } }] };
  }
  if (query.includes('d: durableObjectsInvocationsAdaptiveGroups')) {
    return { d: [{ sum: { requests: 900 } }] };
  }
  if (query.includes('c: containersUsageAdaptiveGroups')) {
    return { c: [{ sum: { cpuTimeSec: 600, allocatedMemory: 1e12 } }] };
  }
  throw new Error(`unexpected query: ${query.slice(0, 80)}`);
};

const ok = <T>(s: OpsSection<T>): T => {
  if (s.status !== 'ok') throw new Error(`section unavailable: ${s.reason}`);
  return s.data;
};

describe('opsWindow', () => {
  it('24h is this hour and the 23 before it, hour-aligned', () => {
    const w = opsWindow('24h', NOW);
    expect(w.points).toHaveLength(24);
    expect(w.points[23]).toBe('2026-10-23T10:00:00.000Z');
    expect(w.from.toISOString()).toBe('2026-10-22T11:00:00.000Z');
    expect(w.monthStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('7d is today and the 6 days before, UTC', () => {
    const w = opsWindow('7d', NOW);
    expect(w.points).toEqual([
      '2026-10-17T00:00:00.000Z',
      '2026-10-18T00:00:00.000Z',
      '2026-10-19T00:00:00.000Z',
      '2026-10-20T00:00:00.000Z',
      '2026-10-21T00:00:00.000Z',
      '2026-10-22T00:00:00.000Z',
      '2026-10-23T00:00:00.000Z',
    ]);
    expect(bucketOf(w, '2026-10-20T13:00:00Z')).toBe('2026-10-20T00:00:00.000Z');
  });
});

describe('parseRange and opsResources', () => {
  it('takes 24h or 7d, 24h by default', () => {
    expect(parseRange(undefined)).toBe('24h');
    expect(parseRange('7d')).toBe('7d');
    expect(parseRange('30d')).toBeNull();
  });

  it('refuses a missing or unsafe resource list', () => {
    expect(typeof opsResources(undefined)).toBe('string');
    expect(typeof opsResources({ workers: ['a" }'], buckets: ['b'], queues: [] })).toBe('string');
    expect(opsResources({ workers: ['a'], buckets: ['b'], queues: [] })).toEqual({
      workers: ['a'],
      buckets: ['b'],
      queues: [],
    });
  });
});

describe('r2ClassOf', () => {
  it('follows R2 pricing, and counts an unknown operation as Class A', () => {
    expect(r2ClassOf('GetObject')).toBe('classB');
    expect(r2ClassOf('HeadObject')).toBe('classB');
    expect(r2ClassOf('PutObject')).toBe('classA');
    expect(r2ClassOf('ListObjects')).toBe('classA');
    expect(r2ClassOf('DeleteObject')).toBe('free');
    expect(r2ClassOf('SomethingNew')).toBe('classA');
  });
});

describe('usageLines', () => {
  const line = {
    key: 'k',
    label: 'K',
    included: 1,
    unit: 'count' as const,
    scope: 'account' as const,
  };

  it('blanks only its own lines on an unexpected error, and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await usageLines(async () => {
      throw new TypeError('odd shape');
    }, [line]);
    expect(out).toEqual([{ ...line, used: null, reason: 'internal error' }]);
    expect(log).toHaveBeenCalledWith('ops metrics: usage line failed', 'TypeError');
  });
});

describe('buildProductQueries', () => {
  it('reads every tour in the window, and refuses a bad dataset name', () => {
    const q = buildProductQueries('panote_events_dev', opsWindow('24h', NOW));
    expect(q.byType).toContain("timestamp >= toDateTime('2026-10-22 11:00:00')");
    expect(q.byType).not.toContain('index1 =');
    expect(q.series).toContain('toStartOfHour');
    expect(buildProductQueries('x', opsWindow('7d', NOW)).series).toContain('toStartOfDay');
    expect(() => buildProductQueries('x; DROP', opsWindow('24h', NOW))).toThrow();
  });
});

describe('buildPipelineQueries', () => {
  it('reads only this schema version in the window, and refuses a bad dataset name', () => {
    const q = buildPipelineQueries('panote_ops_dev', opsWindow('24h', NOW));
    for (const sql of Object.values(q)) {
      expect(sql).toContain("timestamp >= toDateTime('2026-10-22 11:00:00')");
      expect(sql).toContain("blob4 = 'o1'");
      expect(sql).toContain('FROM panote_ops_dev');
    }
    expect(q.series).toContain('toStartOfHour');
    expect(q.series).toContain("blob1 IN ('upload-url', 'tile-ok', 'tile-dead')");
    expect(buildPipelineQueries('x', opsWindow('7d', NOW)).series).toContain('toStartOfDay');
    expect(() => buildPipelineQueries('x; DROP', opsWindow('24h', NOW))).toThrow();
  });
});

describe('getOpsMetrics', () => {
  it('puts every source together', async () => {
    await env.BUCKET.put(
      pubTourKey('tour-1'),
      JSON.stringify({ title: 'Old Town', slug: 'old-town', tourId: 'tour-1' }),
    );
    stubCloudflare(platform);
    const m = OpsMetricsSchema.parse(await getOpsMetrics(testEnv, '24h', NOW));

    const workers = ok(m.workers);
    expect(workers.scripts).toHaveLength(6);
    const api = workers.scripts.find((s) => s.script === 'panote-admin-api-dev');
    expect(api).toMatchObject({ requests: 100, errors: 2, cpuP50Ms: 1.5, cpuP99Ms: 9 });
    expect(api?.byStatus).toEqual({ success: 98, scriptThrewException: 2 });
    expect(workers.scripts.find((s) => s.script === 'panote-website-dev')).toMatchObject({
      requests: 0,
      cpuP50Ms: null,
    });
    expect(workers.series).toHaveLength(24);
    expect(workers.series.at(-2)).toEqual({
      t: '2026-10-23T09:00:00.000Z',
      requests: 60,
      errors: 1,
    });
    expect(workers.series[0]).toMatchObject({ requests: 0, errors: 0 });

    const storage = ok(m.storage);
    expect(storage.buckets[0]).toMatchObject({ classA: 100, classB: 900, free: 5, bytes: 5.001e9 });

    // Only this env's queues once their names are known: q9 is production's.
    const queues = ok(m.queues);
    expect(queues.queues.map((q) => q.name)).toEqual(['pano-uploads-dev']);
    expect(queues.queues[0]).toMatchObject({
      backlogAvg: 3,
      writes: 10,
      reads: 10,
      acked: 8,
      dlq: 2,
      lagMsAvg: 2000,
    });

    expect(ok(m.durableObjects)).toEqual({ requests: 70, errors: 1, storedBytes: 4096 });
    expect(ok(m.containers)).toMatchObject({
      cpuSeconds: 42,
      maxMemoryBytes: 5e8,
      cpuUtilizationP95: 0.9,
      instances: 2,
    });

    const usage = ok(m.usage);
    expect(usage.month).toBe('2026-10');
    const used = Object.fromEntries(usage.items.map((i) => [i.key, i.used]));
    expect(used).toMatchObject({
      'worker-requests': 2e6,
      'r2-class-a': 400,
      'r2-class-b': 9000,
      'r2-storage': 6e9,
      'queue-ops': 300,
      'do-requests': 900,
      'container-cpu': 600,
      'container-memory': 1e12,
    });
    expect(usage.items.find((i) => i.key === 'worker-requests')?.included).toBe(
      INCLUDED.workerRequests,
    );

    const product = ok(m.product);
    expect(product).toMatchObject({ views: 40, scenes: 12, hotspots: 3, dwellAvgMs: 5250 });
    expect(product.topTours).toEqual([
      { tourId: 'tour-1', views: 30, title: 'Old Town', slug: 'old-town' },
      { tourId: 'tour-gone', views: 10, title: null, slug: null },
    ]);
    expect(product.series.at(-2)).toEqual({ t: '2026-10-23T09:00:00.000Z', views: 40 });

    const pipeline = ok(m.pipeline);
    expect(pipeline.events).toEqual([
      { event: 'upload-url', detail: 'new', service: 'upload-api', n: 4, value: 8e7 },
      { event: 'tile-ok', detail: '', service: 'tiler-consumer', n: 5, value: 100_000 },
      { event: 'rate-limited', detail: 'WRITE_LIMITER', service: 'admin-api', n: 2, value: 0 },
    ]);
    expect(pipeline.tileP95Ms).toBe(41235);
    expect(pipeline.series).toHaveLength(24);
    expect(pipeline.series.slice(-3)).toEqual([
      { t: '2026-10-23T08:00:00.000Z', uploads: 0, tiled: 0, failed: 0 },
      { t: '2026-10-23T09:00:00.000Z', uploads: 4, tiled: 3, failed: 0 },
      { t: '2026-10-23T10:00:00.000Z', uploads: 0, tiled: 2, failed: 1 },
    ]);
  });

  it('keeps the pipeline when Analytics Engine refuses the percentile', async () => {
    pipelineP95 = 'refuse';
    try {
      stubCloudflare(platform);
      const pipeline = ok((await getOpsMetrics(testEnv, '24h', NOW)).pipeline);
      expect(pipeline.tileP95Ms).toBeNull();
      expect(pipeline.events).toHaveLength(3);
    } finally {
      pipelineP95 = 'answer';
    }
  });

  it('reads storage from the latest sample, not only this month', async () => {
    const queries: string[] = [];
    stubCloudflare((query) => {
      queries.push(query);
      return platform(query);
    });
    const early = new Date('2026-11-01T00:20:00.000Z');
    await getOpsMetrics(testEnv, '24h', early);
    const storage = queries.filter((q) => q.includes('s0: r2StorageAdaptiveGroups'));
    expect(storage.some((q) => q.includes('datetime_geq: "2026-10-30T00:20:00.000Z"'))).toBe(true);
    for (const q of storage) expect(q).not.toContain('2026-11-01T00:00:00.000Z');
  });

  it('shows every queue by id when the token cannot list queues', async () => {
    stubCloudflare(platform, { queues: false });
    const m = await getOpsMetrics(testEnv, '24h', NOW);
    const queues = ok(m.queues);
    expect(queues.queues.map((q) => [q.queueId, q.name])).toEqual([
      ['q1', null],
      ['q9', null],
    ]);
  });

  it('a dataset Cloudflare refuses blanks only its own section, with the reason', async () => {
    stubCloudflare((query) =>
      query.includes('containersMetricsAdaptiveGroups') || query.includes('containersUsage')
        ? { errors: [{ message: 'unknown field "containersMetricsAdaptiveGroups"' }] }
        : platform(query),
    );
    const m = await getOpsMetrics(testEnv, '7d', NOW);
    expect(m.containers).toEqual({
      status: 'unavailable',
      reason: 'GraphQL: unknown field "containersMetricsAdaptiveGroups"',
    });
    expect(m.workers.status).toBe('ok');
    const usage = ok(m.usage);
    expect(usage.items.find((i) => i.key === 'container-cpu')).toMatchObject({
      used: null,
      reason: expect.stringContaining('GraphQL'),
    });
    expect(usage.items.find((i) => i.key === 'worker-requests')?.used).toBe(2e6);
  });

  it('says what is missing when analytics are not configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const m = await getOpsMetrics({ ...env, CF_ANALYTICS_TOKEN: '' } as Env, '24h', NOW);
    expect(m.workers).toEqual({
      status: 'unavailable',
      reason: 'CF_ANALYTICS_TOKEN or CF_ACCOUNT_ID not set',
    });
    expect(m.product).toEqual({ status: 'unavailable', reason: 'analytics not configured' });
    expect(m.pipeline).toEqual({ status: 'unavailable', reason: 'analytics not configured' });
    expect(m.health.status).toBe('ok');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says so when OPS_RESOURCES is broken', async () => {
    stubCloudflare(platform);
    const m = await getOpsMetrics(
      { ...testEnv, OPS_RESOURCES: { workers: [] } } as Env,
      '24h',
      NOW,
    );
    expect(m.storage).toEqual({
      status: 'unavailable',
      reason: 'OPS_RESOURCES is missing or malformed',
    });
    expect(m.durableObjects.status).toBe('ok');
  });
});

describe('healthSection', () => {
  it('is all empty on a fresh bucket', async () => {
    expect(await healthSection(env.BUCKET, new Date('2026-10-23T12:00:00Z'))).toEqual({
      failing: [],
      announcedDown: [],
      lastAlertAt: null,
      dailyCron: null,
      tileGc: null,
      cdnPurge: { lastFailure: null, pending: 0, pendingCapped: false, dead: 0, deadCapped: false },
      backup: {
        lastCompleteDate: null,
        lastCompleteDaysAgo: null,
        hasRun: false,
        inProgress: null,
      },
    });
  });

  it('reads what the crons, the purge queue, the backup and the health check recorded', async () => {
    const put = (key: string, v: unknown) => env.BUCKET.put(key, JSON.stringify(v));
    await Promise.all([
      put(HEALTH_STATE_KEY, {
        failures: { 'website /': 3, 'cdn purge': 1 },
        announced: ['website /'],
        lastSentAt: Date.parse('2026-10-23T09:00:00Z'),
        cronMissingSince: null,
      }),
      put(CRON_STATUS_KEY, {
        lastRunAt: '2026-10-23T03:17:00.000Z',
        lastOkAt: '2026-10-22T03:17:00.000Z',
        failed: ['trash'],
      }),
      put(CDN_PURGE_FAILURE_KEY, { at: '2026-10-23T08:00:00.000Z', detail: '429' }),
      put(`${CDN_PURGE_PENDING_PREFIX}a.json`, {}),
      put(`${CDN_PURGE_PENDING_PREFIX}b.json`, {}),
      put(`${CDN_PURGE_DEAD_PREFIX}c.json`, {}),
      put(backupCompleteKey('2026-10-19'), {}),
      // Older than last month: never listed, however many sets are kept.
      put(backupCompleteKey('2026-08-30'), {}),
      put(backupCompleteKey('2026-10-21'), {}),
      put('backup/2026-10-22/tours/x.json', {}),
      put('backup/progress.json', {
        v: 1,
        date: '2026-10-22',
        startedAt: '2026-10-22T03:00:00.000Z',
        objects: 1234,
        bytes: 5_000_000,
        failed: 0,
        skipped: 0,
        runs: 2,
        source: 1,
        startAfter: 'tours/x.json',
      } satisfies BackupProgress),
    ]);
    const h = await healthSection(env.BUCKET, new Date('2026-10-23T12:00:00Z'));
    expect(h.failing).toEqual([
      { check: 'cdn purge', failures: 1 },
      { check: 'website /', failures: 3 },
    ]);
    expect(h.announcedDown).toEqual(['website /']);
    expect(h.lastAlertAt).toBe('2026-10-23T09:00:00.000Z');
    expect(h.dailyCron?.failed).toEqual(['trash']);
    expect(h.cdnPurge).toEqual({
      lastFailure: { at: '2026-10-23T08:00:00.000Z', detail: '429' },
      pending: 2,
      pendingCapped: false,
      dead: 1,
      deadCapped: false,
    });
    expect(h.backup).toEqual({
      lastCompleteDate: '2026-10-21',
      lastCompleteDaysAgo: 2,
      hasRun: true,
      inProgress: { date: '2026-10-22', objects: 1234, runs: 2 },
    });
  });
});

describe('the last complete backup', () => {
  it('finds last month’s set early in a month', async () => {
    await env.BUCKET.put(backupCompleteKey('2026-11-30'), '{}');
    const h = await healthSection(env.BUCKET, new Date('2026-12-01T01:00:00Z'));
    expect(h.backup.lastCompleteDate).toBe('2026-11-30');
    expect(h.backup.lastCompleteDaysAgo).toBe(1);
  });

  it('says it has run when the only complete sets are older than last month', async () => {
    await env.BUCKET.delete('backup/progress.json');
    const h = await healthSection(env.BUCKET, new Date('2027-06-01T01:00:00Z'));
    expect(h.backup).toMatchObject({ lastCompleteDate: null, hasRun: true, inProgress: null });
  });
});

describe('GET /api/admin/ops/metrics', () => {
  const get = (path: string, token: string) =>
    worker.fetch(
      new Request(`https://x${path}`, { headers: { Authorization: `Bearer ${token}` } }),
      testEnv,
      createExecutionContext(),
    );

  it('is a plain 404 for anyone but an operator, before any analytics call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await get('/api/admin/ops/metrics', 'owner');
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers an operator, uncached by the browser', async () => {
    stubCloudflare(platform);
    const res = await get('/api/admin/ops/metrics?range=7d', 'operator');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = OpsMetricsSchema.parse(await res.json());
    expect(body.range).toBe('7d');
  });

  it('caches each range on its own for a minute', async () => {
    const fetchSpy = stubCloudflare(platform);
    const load = async (range: string) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`https://x/api/admin/ops/metrics?range=${range}`, {
          headers: { Authorization: 'Bearer operator' },
        }),
        testEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return OpsMetricsSchema.parse(await res.json());
    };
    expect((await load('24h')).range).toBe('24h');
    const calls = fetchSpy.mock.calls.length;
    expect((await load('24h')).range).toBe('24h');
    expect(fetchSpy.mock.calls.length).toBe(calls);
    expect((await load('7d')).range).toBe('7d');
  });

  it('400s an unknown range', async () => {
    const res = await get('/api/admin/ops/metrics?range=1y', 'operator');
    expect(res.status).toBe(400);
  });
});
