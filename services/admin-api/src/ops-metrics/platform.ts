import type {
  OpsContainers,
  OpsDurableObjects,
  OpsQueues,
  OpsResources,
  OpsStorage,
  OpsUsage,
  OpsWorkers,
} from '@internal/contracts';

import { addTo, bucketOf, fillSeries, type OpsWindow } from './window.js';
import {
  at,
  between,
  dim,
  has,
  isSchemaRefusal,
  lit,
  queryAccount,
  weeks,
  type GqlRow,
} from './graphql.js';
import { OpsUnavailable } from './unavailable.js';

// The platform sections, one GraphQL request each (graphql.ts). Dataset and field names are
// Cloudflare's (developers.cloudflare.com/analytics/graphql-api); a name Cloudflare renames
// shows up as that one section's "unavailable" reason, not a broken page.

type CfEnv = Pick<Env, 'CF_ACCOUNT_ID' | 'CF_ANALYTICS_TOKEN'>;

const names = (list: readonly string[]): string => `[${list.map(lit).join(', ')}]`;

// workersInvocationsAdaptive's CPU quantiles are microseconds.
const US_PER_MS = 1000;

export const workersSection = async (
  env: CfEnv,
  w: OpsWindow,
  res: OpsResources,
): Promise<OpsWorkers> => {
  const filter = `filter: { scriptName_in: ${names(res.workers)}, ${between(w.from, w.to)} }`;
  const rows = await queryAccount(
    env,
    `byScript: workersInvocationsAdaptive(limit: 100, ${filter}) {
      sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { scriptName }
    }
    byStatus: workersInvocationsAdaptive(limit: 1000, ${filter}) {
      sum { requests } dimensions { scriptName status }
    }
    series: workersInvocationsAdaptive(limit: 10000, ${filter}) {
      sum { requests errors } dimensions { datetimeHour }
    }`,
  );
  const statuses = new Map<string, Record<string, number>>();
  for (const r of rows.byStatus ?? []) {
    const script = dim(r, 'scriptName');
    const by = statuses.get(script) ?? {};
    const status = dim(r, 'status') || 'unknown';
    by[status] = (by[status] ?? 0) + at(r, 'sum.requests');
    statuses.set(script, by);
  }
  const seen = new Map((rows.byScript ?? []).map((r) => [dim(r, 'scriptName'), r]));
  const cpu = (r: GqlRow | undefined, q: string) =>
    r && has(r, `quantiles.${q}`) && at(r, 'sum.requests') > 0
      ? at(r, `quantiles.${q}`) / US_PER_MS
      : null;
  // Every configured Worker, in config order, so one with no traffic still shows as 0.
  const scripts = res.workers.map((script) => {
    const r = seen.get(script);
    return {
      script,
      requests: r ? at(r, 'sum.requests') : 0,
      errors: r ? at(r, 'sum.errors') : 0,
      subrequests: r ? at(r, 'sum.subrequests') : 0,
      cpuP50Ms: cpu(r, 'cpuTimeP50'),
      cpuP99Ms: cpu(r, 'cpuTimeP99'),
      byStatus: statuses.get(script) ?? {},
    };
  });
  const sums = new Map<string, Record<'requests' | 'errors', number>>();
  for (const r of rows.series ?? []) {
    const hour = dim(r, 'datetimeHour');
    if (!hour) continue;
    addTo(sums, bucketOf(w, hour), {
      requests: at(r, 'sum.requests'),
      errors: at(r, 'sum.errors'),
    });
  }
  return { scripts, series: fillSeries(w, sums, ['requests', 'errors'] as const) };
};

// R2's billing classes (developers.cloudflare.com/r2/pricing). Anything not listed as
// Class B or free is counted as Class A, the dearer one, so a new operation is never
// under-counted.
const R2_CLASS_B = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);
const R2_FREE = new Set(['DeleteObject', 'DeleteObjects', 'DeleteBucket', 'AbortMultipartUpload']);
export const r2ClassOf = (action: string): 'classA' | 'classB' | 'free' =>
  R2_CLASS_B.has(action) ? 'classB' : R2_FREE.has(action) ? 'free' : 'classA';

const TOP_ACTIONS = 6;

export const storageSection = async (
  env: CfEnv,
  w: OpsWindow,
  res: OpsResources,
): Promise<OpsStorage> => {
  const parts = res.buckets.map(
    (bucket, i) => `
    s${i}: r2StorageAdaptiveGroups(limit: 1, orderBy: [datetime_DESC],
      filter: { bucketName: ${lit(bucket)}, ${between(w.from, w.to)} }) {
      max { objectCount payloadSize metadataSize } dimensions { datetime }
    }
    o${i}: r2OperationsAdaptiveGroups(limit: 100,
      filter: { bucketName: ${lit(bucket)}, ${between(w.from, w.to)} }) {
      sum { requests } dimensions { actionType }
    }`,
  );
  const rows = await queryAccount(env, parts.join('\n'));
  const buckets = res.buckets.map((bucket, i) => {
    const latest = rows[`s${i}`]?.[0];
    const classes = { classA: 0, classB: 0, free: 0 };
    const actions = (rows[`o${i}`] ?? []).map((r) => ({
      action: dim(r, 'actionType') || 'unknown',
      requests: at(r, 'sum.requests'),
    }));
    for (const a of actions) classes[r2ClassOf(a.action)] += a.requests;
    actions.sort((a, b) => b.requests - a.requests);
    return {
      bucket,
      objects: latest ? at(latest, 'max.objectCount') : null,
      bytes: latest ? at(latest, 'max.payloadSize') + at(latest, 'max.metadataSize') : null,
      ...classes,
      topActions: actions.slice(0, TOP_ACTIONS),
    };
  });
  return { buckets };
};

/**
 * The account's queues by id. The analytics only know ids; their names come from the
 * Queues API, which the analytics token may not be allowed to call. Null then: the
 * section still shows every queue in the account, by id.
 */
const queueNames = async (env: CfEnv): Promise<Map<string, string> | null> => {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/queues?per_page=100`,
      {
        headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { queue_id?: unknown; queue_name?: unknown }[] };
    const map = new Map<string, string>();
    for (const q of body.result ?? []) {
      if (typeof q.queue_id === 'string' && typeof q.queue_name === 'string') {
        map.set(q.queue_id, q.queue_name);
      }
    }
    return map;
  } catch {
    return null;
  }
};

// Cloudflare's Queues docs spell the id dimension both `queueId` and `queueID`, and the
// backlog dataset both `queueBacklog…` and `queuesBacklog…`: each spelling is tried in turn,
// and the first GraphQL accepts is used. Only a refusal by GraphQL itself moves on.
const QUEUE_ID_FIELDS = ['queueId', 'queueID'] as const;
const QUEUE_BACKLOG_DATASETS = ['queueBacklogAdaptiveGroups', 'queuesBacklogAdaptiveGroups'];

/** The first of `tries` GraphQL accepts; if none does, the first one's refusal. */
const firstAccepted = async <T, R>(tries: readonly T[], run: (t: T) => Promise<R>) => {
  let first: unknown;
  for (const t of tries) {
    try {
      return { used: t, rows: await run(t) };
    } catch (err) {
      if (!isSchemaRefusal(err)) throw err;
      first ??= err;
    }
  }
  throw first;
};

export const queuesSection = async (
  env: CfEnv,
  w: OpsWindow,
  res: OpsResources,
): Promise<OpsQueues> => {
  const range = between(w.from, w.to);
  const [ops, named] = await Promise.all([
    firstAccepted(QUEUE_ID_FIELDS, (id) =>
      queryAccount(
        env,
        `ops: queueMessageOperationsAdaptiveGroups(limit: 1000, filter: { ${range} }) {
          count avg { lagTime retryCount } dimensions { ${id} actionType outcome }
        }`,
      ),
    ),
    queueNames(env),
  ]);
  const idField = ops.used;
  // The backlog is a nicety next to the operations: a dataset that refuses costs only it.
  const backlog = await firstAccepted(QUEUE_BACKLOG_DATASETS, (dataset) =>
    queryAccount(
      env,
      `backlog: ${dataset}(limit: 1000, filter: { ${range} }) {
        avg { messages } dimensions { ${idField} }
      }`,
    ),
  ).catch((err: unknown) => {
    if (err instanceof OpsUnavailable) return null;
    throw err;
  });
  const rows = { ops: ops.rows.ops ?? [], backlog: backlog?.rows.backlog ?? null };
  type Acc = OpsQueues['queues'][number] & { lagWeight: number; retryWeight: number };
  const byId = new Map<string, Acc>();
  const get = (queueId: string): Acc => {
    let q = byId.get(queueId);
    if (!q) {
      q = {
        queueId,
        name: named?.get(queueId) ?? null,
        backlogAvg: rows.backlog === null ? null : 0,
        writes: 0,
        reads: 0,
        acked: 0,
        dlq: 0,
        failed: 0,
        lagMsAvg: null,
        retriesAvg: null,
        lagWeight: 0,
        retryWeight: 0,
      };
      byId.set(queueId, q);
    }
    return q;
  };
  for (const r of rows.backlog ?? []) {
    const id = dim(r, idField);
    if (id) get(id).backlogAvg = Math.max(get(id).backlogAvg ?? 0, at(r, 'avg.messages'));
  }
  for (const r of rows.ops) {
    const id = dim(r, idField);
    if (!id) continue;
    const q = get(id);
    const n = at(r, 'count');
    const action = dim(r, 'actionType');
    if (action === 'WriteMessage') q.writes += n;
    if (action === 'ReadMessage') {
      q.reads += n;
      if (has(r, 'avg.lagTime')) {
        q.lagMsAvg =
          ((q.lagMsAvg ?? 0) * q.lagWeight + at(r, 'avg.lagTime') * n) / (q.lagWeight + n || 1);
        q.lagWeight += n;
      }
    }
    if (action === 'DeleteMessage') {
      const outcome = dim(r, 'outcome');
      if (outcome === 'dlq') q.dlq += n;
      else if (outcome === 'fail') q.failed += n;
      else q.acked += n;
      if (has(r, 'avg.retryCount')) {
        q.retriesAvg =
          ((q.retriesAvg ?? 0) * q.retryWeight + at(r, 'avg.retryCount') * n) /
          (q.retryWeight + n || 1);
        q.retryWeight += n;
      }
    }
  }
  const mine = new Set(res.queues);
  const queues = [...byId.values()]
    // With names, only this environment's queues; without, every queue (ids only).
    .filter((q) => named === null || (q.name !== null && mine.has(q.name)))
    .map(({ lagWeight: _l, retryWeight: _r, ...q }) => q)
    .sort((a, b) => (a.name ?? a.queueId).localeCompare(b.name ?? b.queueId));
  return { queues };
};

/** A query whose answer is a nicety: null when GraphQL refuses it, not the whole section. */
const optional = async <T>(work: () => Promise<T>): Promise<T | null> => {
  try {
    return await work();
  } catch (err) {
    if (err instanceof OpsUnavailable) return null;
    throw err;
  }
};

// Three requests, not one: `errors` on invocations isn't in Cloudflare's docs, and the
// storage dataset is a separate one, so either refusing leaves the request count standing.
export const durableObjectsSection = async (
  env: CfEnv,
  w: OpsWindow,
): Promise<OpsDurableObjects> => {
  const day = w.from.toISOString().slice(0, 10);
  const filter = `filter: { ${between(w.from, w.to)} }`;
  const [inv, errors, stored] = await Promise.all([
    queryAccount(
      env,
      `inv: durableObjectsInvocationsAdaptiveGroups(limit: 100, ${filter}) { sum { requests } }`,
    ),
    optional(() =>
      queryAccount(
        env,
        `err: durableObjectsInvocationsAdaptiveGroups(limit: 100, ${filter}) { sum { errors } }`,
      ),
    ),
    optional(() =>
      queryAccount(
        env,
        `stored: durableObjectsStorageGroups(limit: 1, orderBy: [date_DESC], filter: { date_geq: ${lit(day)} }) {
          max { storedBytes } dimensions { date }
        }`,
      ),
    ),
  ]);
  const latest = stored?.stored?.[0];
  return {
    requests: (inv.inv ?? []).reduce((s, r) => s + at(r, 'sum.requests'), 0),
    errors: errors ? (errors.err ?? []).reduce((s, r) => s + at(r, 'sum.errors'), 0) : null,
    storedBytes: latest ? at(latest, 'max.storedBytes') : null,
  };
};

export const containersSection = async (env: CfEnv, w: OpsWindow): Promise<OpsContainers> => {
  const rows = await queryAccount(
    env,
    `rows: containersMetricsAdaptiveGroups(limit: 10000, filter: { ${between(w.from, w.to)} }) {
      sum { cpuTimeSec } max { memory } quantiles { cpuUtilizationP95 }
      dimensions { datetimeHour instanceId }
    }`,
  );
  const instances = new Set<string>();
  const sums = new Map<string, Record<'cpuSeconds', number>>();
  let cpuSeconds = 0;
  let maxMemory: number | null = null;
  let cpuP95: number | null = null;
  for (const r of rows.rows ?? []) {
    const id = dim(r, 'instanceId');
    if (id) instances.add(id);
    const cpu = at(r, 'sum.cpuTimeSec');
    cpuSeconds += cpu;
    if (has(r, 'max.memory')) maxMemory = Math.max(maxMemory ?? 0, at(r, 'max.memory'));
    if (has(r, 'quantiles.cpuUtilizationP95')) {
      cpuP95 = Math.max(cpuP95 ?? 0, at(r, 'quantiles.cpuUtilizationP95'));
    }
    const hour = dim(r, 'datetimeHour');
    if (hour) addTo(sums, bucketOf(w, hour), { cpuSeconds: cpu });
  }
  return {
    cpuSeconds,
    maxMemoryBytes: maxMemory,
    cpuUtilizationP95: cpuP95,
    instances: instances.size,
    series: fillSeries(w, sums, ['cpuSeconds'] as const),
  };
};

// What the Workers Paid plan includes each month (Cloudflare's pricing pages, checked
// 2026-10-23). The allowance is the account's, so these count every Worker, bucket and
// queue in it, dev included; only storage is this environment's bucket.
const GB = 1e9;
const GIB = 2 ** 30;
export const INCLUDED = {
  workerRequests: 10_000_000,
  r2StorageBytes: 10 * GB,
  r2ClassA: 1_000_000,
  r2ClassB: 10_000_000,
  queueOps: 1_000_000,
  doRequests: 1_000_000,
  containerMemoryByteSeconds: 25 * GIB * 3600,
  containerCpuSeconds: 375 * 60,
} as const;

type UsageItem = OpsUsage['items'][number];

/** One usage line: its own query, so a dataset that refuses only blanks its own lines. */
export const usageLines = async (
  run: () => Promise<Omit<UsageItem, 'reason'>[]>,
  fallback: Omit<UsageItem, 'reason' | 'used'>[],
): Promise<UsageItem[]> => {
  try {
    return (await run()).map((item) => ({ ...item, reason: null }));
  } catch (err) {
    // Anything else (an answer in a shape this code doesn't expect) blanks only these
    // lines too, logged the way settle() logs a section.
    if (!(err instanceof OpsUnavailable)) {
      console.error('ops metrics: usage line failed', err instanceof Error ? err.name : 'unknown');
    }
    const reason = err instanceof OpsUnavailable ? err.message : 'internal error';
    return fallback.map((item) => ({ ...item, used: null, reason }));
  }
};

const STORAGE_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

export const usageSection = async (
  env: CfEnv,
  w: OpsWindow,
  res: OpsResources,
): Promise<OpsUsage> => {
  const month = between(w.monthStart, w.to);
  // Workers' invocations answer at most a week per query; the queue and Durable Object
  // datasets don't document theirs, so they get the same weeks to be safe.
  const monthWeeks = weeks(w.monthStart, w.to);
  const perWeek = (alias: string, dataset: string, fields: string) =>
    monthWeeks
      .map((f, i) => `${alias}${i}: ${dataset}(limit: 10, filter: { ${f} }) { sum { ${fields} } }`)
      .join('\n');
  const weekly = (rows: Record<string, GqlRow[]>, alias: string, path: string) =>
    monthWeeks.reduce((sum, _f, i) => sum + total(rows[`${alias}${i}`], path), 0);
  // Storage is a level, not a month's sum: the latest sample, which early on the 1st may
  // still be last month's.
  const recent = between(new Date(w.to.getTime() - STORAGE_LOOKBACK_MS), w.to);
  const day = w.monthStart.toISOString().slice(0, 10);
  const total = (rows: GqlRow[] | undefined, path: string) =>
    (rows ?? []).reduce((s, r) => s + at(r, path), 0);
  const line = (
    key: string,
    label: string,
    included: number,
    unit: UsageItem['unit'],
    scope: UsageItem['scope'] = 'account',
  ) => ({ key, label, included, unit, scope });

  const workers = line('worker-requests', 'Worker requests', INCLUDED.workerRequests, 'count');
  const classA = line('r2-class-a', 'R2 Class A operations', INCLUDED.r2ClassA, 'count');
  const classB = line('r2-class-b', 'R2 Class B operations', INCLUDED.r2ClassB, 'count');
  const storage = line('r2-storage', 'R2 storage now', INCLUDED.r2StorageBytes, 'bytes', 'env');
  const queues = line('queue-ops', 'Queue operations', INCLUDED.queueOps, 'count');
  const dos = line('do-requests', 'Durable Object requests', INCLUDED.doRequests, 'count');
  const cpu = line('container-cpu', 'Container CPU', INCLUDED.containerCpuSeconds, 'seconds');
  const memory = line(
    'container-memory',
    'Container memory',
    INCLUDED.containerMemoryByteSeconds,
    'byte-seconds',
  );

  const groups = await Promise.all([
    usageLines(async () => {
      const rows = await queryAccount(env, perWeek('w', 'workersInvocationsAdaptive', 'requests'));
      return [{ ...workers, used: weekly(rows, 'w', 'sum.requests') }];
    }, [workers]),
    usageLines(async () => {
      const rows = await queryAccount(
        env,
        `r2: r2OperationsAdaptiveGroups(limit: 100, filter: { ${month} }) {
          sum { requests } dimensions { actionType }
        }`,
      );
      const by = { classA: 0, classB: 0, free: 0 };
      for (const r of rows.r2 ?? []) by[r2ClassOf(dim(r, 'actionType'))] += at(r, 'sum.requests');
      return [
        { ...classA, used: by.classA },
        { ...classB, used: by.classB },
      ];
    }, [classA, classB]),
    usageLines(async () => {
      const rows = await queryAccount(
        env,
        res.buckets
          .map(
            (bucket, i) => `s${i}: r2StorageAdaptiveGroups(limit: 1, orderBy: [datetime_DESC],
              filter: { bucketName: ${lit(bucket)}, ${recent} }) {
              max { payloadSize metadataSize } dimensions { datetime }
            }`,
          )
          .join('\n'),
      );
      const used = res.buckets.reduce((sum, _b, i) => {
        const latest = rows[`s${i}`]?.[0];
        return sum + (latest ? at(latest, 'max.payloadSize') + at(latest, 'max.metadataSize') : 0);
      }, 0);
      return [{ ...storage, used }];
    }, [storage]),
    usageLines(async () => {
      const rows = await queryAccount(
        env,
        perWeek('q', 'queueMessageOperationsAdaptiveGroups', 'billableOperations'),
      );
      return [{ ...queues, used: weekly(rows, 'q', 'sum.billableOperations') }];
    }, [queues]),
    usageLines(async () => {
      const rows = await queryAccount(
        env,
        perWeek('d', 'durableObjectsInvocationsAdaptiveGroups', 'requests'),
      );
      return [{ ...dos, used: weekly(rows, 'd', 'sum.requests') }];
    }, [dos]),
    usageLines(async () => {
      const rows = await queryAccount(
        env,
        `c: containersUsageAdaptiveGroups(limit: 100, filter: { date_geq: ${lit(day)} }) {
          sum { cpuTimeSec allocatedMemory }
        }`,
      );
      return [
        { ...cpu, used: total(rows.c, 'sum.cpuTimeSec') },
        { ...memory, used: total(rows.c, 'sum.allocatedMemory') },
      ];
    }, [cpu, memory]),
  ]);
  return { month: w.monthStart.toISOString().slice(0, 7), items: groups.flat() };
};
