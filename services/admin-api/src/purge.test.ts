import {
  CDN_PURGE_DEAD_PREFIX,
  CDN_PURGE_FAILURE_KEY,
  CDN_PURGE_PENDING_PREFIX,
} from '@internal/contracts';
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  meteredBucket,
  mergePurges,
  OPERATOR_PENDING_PREFIX,
  PENDING_MAX_AGE_MS,
  QUEUE_DROP_PER_RUN,
  QUEUE_MAX_RECORDS,
  PENDING_RECORD_MAX_ITEMS,
  purgeCdn,
  RETRY_RUN_MAX_SUBREQUESTS,
  RETRY_RUN_REQUESTS,
  retryPendingPurges,
  type PurgeEnv,
} from './purge.js';
import { BACKUP_RUN_BUDGET } from './backup.js';

const TOKEN = 'secret-purge-token-value';
const ZONE = '0123456789abcdef0123456789abcdef';
const CONFIGURED: PurgeEnv = {
  CF_PURGE_TOKEN: TOKEN,
  CDN_ZONE_ID: ZONE,
  CDN_HOST: 'cdn.panote.dev',
};

type Call = { url: string; init: RequestInit };

const recordingFetch = (respond: () => Promise<Response> = async () => Response.json({})) => {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return await respond();
  }) as unknown as typeof fetch;
  return { fn, calls, bodies: () => calls.map((c) => JSON.parse(String(c.init.body))) };
};

const logSpies = () => ({
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
});

const allLogged = (spies: ReturnType<typeof logSpies>): string =>
  [...spies.error.mock.calls, ...spies.warn.mock.calls].flat().map(String).join('\n');

const noSleep = async () => {};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('purgeCdn', () => {
  it('purges a prefix without a scheme, via the zone purge endpoint', async () => {
    const f = recordingFetch();
    await purgeCdn(
      CONFIGURED,
      { prefixes: ['tiles/p1/'], files: [] },
      { fetch: f.fn, sleep: noSleep },
    );
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`);
    expect(f.calls[0]?.init.method).toBe('POST');
    expect(new Headers(f.calls[0]?.init.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(f.bodies()).toEqual([{ prefixes: ['cdn.panote.dev/tiles/p1/'] }]);
  });

  it('purges files by full URL, in a separate request from prefixes', async () => {
    const f = recordingFetch();
    await purgeCdn(
      CONFIGURED,
      { prefixes: ['tiles/p1/'], files: ['pub/tours/t1.json', 'slugs/s1.json'] },
      { fetch: f.fn, sleep: noSleep },
    );
    expect(f.bodies()).toEqual([
      { prefixes: ['cdn.panote.dev/tiles/p1/'] },
      {
        files: ['https://cdn.panote.dev/pub/tours/t1.json', 'https://cdn.panote.dev/slugs/s1.json'],
      },
    ]);
  });

  it('batches prefixes 100 per request', async () => {
    const f = recordingFetch();
    const prefixes = Array.from({ length: 150 }, (_, i) => `tiles/p${i}/`);
    await purgeCdn(CONFIGURED, { prefixes, files: [] }, { fetch: f.fn, sleep: noSleep });
    expect(f.bodies().map((b: { prefixes: string[] }) => b.prefixes.length)).toEqual([100, 50]);
  });

  it('makes no call for an empty purge', async () => {
    const f = recordingFetch();
    const spies = logSpies();
    await purgeCdn(CONFIGURED, { prefixes: [], files: [] }, { fetch: f.fn, sleep: noSleep });
    expect(f.calls).toHaveLength(0);
    expect(spies.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['the token is unset', { ...CONFIGURED, CF_PURGE_TOKEN: undefined }],
    ['the token is empty', { ...CONFIGURED, CF_PURGE_TOKEN: '' }],
    ['the zone id is a placeholder', { ...CONFIGURED, CDN_ZONE_ID: 'YOUR_PANOTE_DEV_ZONE_ID' }],
    ['the host is empty', { ...CONFIGURED, CDN_HOST: '' }],
  ])('makes no call and warns when %s', async (_, env) => {
    const f = recordingFetch();
    const spies = logSpies();
    await purgeCdn(env, { prefixes: ['tiles/p1/'], files: [] }, { fetch: f.fn, sleep: noSleep });
    expect(f.calls).toHaveLength(0);
    expect(spies.warn).toHaveBeenCalledOnce();
    expect(allLogged(spies)).not.toContain(TOKEN);
  });

  it.each([
    [
      'a 400',
      () =>
        Promise.resolve(
          Response.json(
            { success: false, errors: [{ code: 1012, message: 'Request must contain one of' }] },
            { status: 400 },
          ),
        ),
      'HTTP 400: 1012 Request must contain one of',
    ],
    ['a 429', () => Promise.resolve(new Response('slow down', { status: 429 })), 'HTTP 429'],
  ])('logs %s without throwing or leaking the token', async (_, respond, expected) => {
    const f = recordingFetch(respond);
    const spies = logSpies();
    await expect(
      purgeCdn(
        CONFIGURED,
        { prefixes: ['tiles/p1/'], files: ['a.json'] },
        { fetch: f.fn, sleep: noSleep, retries: 0 },
      ),
    ).resolves.toEqual({ status: 'failed', purged: 0, pending: 0, failed: 2 });
    // Neither stops the other kind: a 400 is that batch's, a 429 that kind's budget.
    expect(f.calls).toHaveLength(2);
    expect(spies.error).toHaveBeenCalledTimes(2);
    expect(allLogged(spies)).toContain(expected);
    expect(allLogged(spies)).not.toContain(TOKEN);
  });

  it.each([401, 403])(
    'treats a %i as the token: one request, everything queued, nothing dead-lettered',
    async (status) => {
      const spies = logSpies();
      const listed = await env.BUCKET.list({ prefix: 'ops/cdn-purge/' });
      if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
      const f = recordingFetch(async () =>
        Response.json(
          { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
          { status },
        ),
      );
      const out = await purgeCdn(
        { ...CONFIGURED, BUCKET: env.BUCKET },
        { prefixes: ['tiles/p1/'], files: ['a.json'] },
        { fetch: f.fn, sleep: noSleep },
      );
      expect(f.calls).toHaveLength(1);
      expect(out).toEqual({ status: 'pending', purged: 0, pending: 2, failed: 0 });
      expect((await env.BUCKET.list({ prefix: CDN_PURGE_PENDING_PREFIX })).objects).toHaveLength(1);
      expect((await env.BUCKET.list({ prefix: CDN_PURGE_DEAD_PREFIX })).objects).toHaveLength(0);
      expect(await env.BUCKET.head(CDN_PURGE_FAILURE_KEY)).not.toBeNull();
      expect(allLogged(spies)).toContain(`HTTP ${status}: 10000 Authentication error`);
      expect(allLogged(spies)).not.toContain(TOKEN);
    },
  );

  it('logs a rejected fetch without leaking the token, and stops there', async () => {
    const f = recordingFetch(() => Promise.reject(new TypeError(`boom ${TOKEN}`)));
    const spies = logSpies();
    await expect(
      purgeCdn(
        CONFIGURED,
        { prefixes: ['tiles/p1/'], files: ['a.json'] },
        { fetch: f.fn, sleep: noSleep, retries: 0 },
      ),
    ).resolves.toEqual({ status: 'failed', purged: 0, pending: 0, failed: 2 });
    expect(f.calls).toHaveLength(1);
    expect(allLogged(spies)).toContain('TypeError');
    expect(allLogged(spies)).not.toContain(TOKEN);
  });

  it('times out a hung purge request', async () => {
    const hung = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const spies = logSpies();
    await expect(
      purgeCdn(
        CONFIGURED,
        { prefixes: ['tiles/p1/'], files: [] },
        { fetch: hung, timeoutMs: 20, retries: 0 },
      ),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(allLogged(spies)).toContain('TimeoutError');
  });
});

describe('purgeCdn failure marker', () => {
  const WITH_BUCKET: PurgeEnv = { ...CONFIGURED, BUCKET: env.BUCKET };
  const marker = async () =>
    (await (await env.BUCKET.get(CDN_PURGE_FAILURE_KEY))?.json()) as
      { at: string; detail: string } | undefined;
  beforeEach(() => env.BUCKET.delete(CDN_PURGE_FAILURE_KEY));

  it('records the last failure for the health check, status and error codes only', async () => {
    logSpies();
    const f = recordingFetch(async () =>
      Response.json({ errors: [{ code: 1015, message: 'rate limited' }] }, { status: 429 }),
    );
    const before = Date.now();
    await purgeCdn(
      WITH_BUCKET,
      { prefixes: ['tiles/p1/'], files: [] },
      { fetch: f.fn, sleep: noSleep },
    );
    const m = await marker();
    expect(m?.detail).toBe('prefixes, 1: HTTP 429: 1015 rate limited');
    expect(Date.parse(m?.at ?? '')).toBeGreaterThanOrEqual(before);
    expect(JSON.stringify(m)).not.toContain(TOKEN);
  });

  it('records nothing when every request goes through', async () => {
    await purgeCdn(
      WITH_BUCKET,
      { prefixes: ['tiles/p1/'], files: ['a.json'] },
      { fetch: recordingFetch().fn, sleep: noSleep },
    );
    expect(await marker()).toBeUndefined();
  });

  it('records nothing when the purge is skipped as unconfigured', async () => {
    logSpies();
    const f = recordingFetch(async () => new Response('', { status: 500 }));
    await purgeCdn(
      { ...WITH_BUCKET, CF_PURGE_TOKEN: undefined },
      { prefixes: ['tiles/p1/'], files: [] },
      { fetch: f.fn, sleep: noSleep },
    );
    expect(f.calls).toHaveLength(0);
    expect(await marker()).toBeUndefined();
  });

  it('still never throws when the marker cannot be written', async () => {
    const spies = logSpies();
    const broken = {
      put: () => Promise.reject(new Error('r2 down')),
    } as unknown as R2Bucket;
    await expect(
      purgeCdn(
        { ...CONFIGURED, BUCKET: broken },
        { prefixes: ['tiles/p1/'], files: [] },
        {
          fetch: recordingFetch(async () => new Response('', { status: 500 })).fn,
          sleep: noSleep,
        },
      ),
    ).resolves.toEqual({ status: 'failed', purged: 0, pending: 0, failed: 1 });
    expect(allLogged(spies)).toContain('cdn purge failure not recorded: Error');
    expect(allLogged(spies)).toContain('cdn purge not queued: Error');
  });
});

describe('mergePurges', () => {
  it('unions and dedupes', () => {
    expect(
      mergePurges(
        { prefixes: ['tiles/a/'], files: ['x.json'] },
        { prefixes: ['tiles/a/', 'tiles/b/'], files: ['x.json'] },
      ),
    ).toEqual({ prefixes: ['tiles/a/', 'tiles/b/'], files: ['x.json'] });
  });
});

describe('purgeCdn retries', () => {
  // Answers each call in turn from `statuses`, then 200.
  const sequence = (statuses: number[], headers: Record<string, string> = {}) => {
    let i = 0;
    return recordingFetch(async () => {
      const status = statuses[i++] ?? 200;
      return status === 200 ? Response.json({}) : new Response('', { status, headers });
    });
  };

  it.each([429, 500, 503])('retries a %i with backoff, and succeeds', async (status) => {
    logSpies();
    const f = sequence([status, status]);
    const sleeps: number[] = [];
    const out = await purgeCdn(
      CONFIGURED,
      { prefixes: ['tiles/p1/'], files: [] },
      { fetch: f.fn, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(f.calls).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 4_000]);
    expect(out).toEqual({ status: 'purged', purged: 1, pending: 0, failed: 0 });
  });

  it('waits what Retry-After says, capped', async () => {
    logSpies();
    const sleeps: number[] = [];
    await purgeCdn(
      CONFIGURED,
      { prefixes: ['tiles/p1/'], files: [] },
      {
        fetch: sequence([429], { 'Retry-After': '3' }).fn,
        sleep: async (ms) => void sleeps.push(ms),
      },
    );
    expect(sleeps).toEqual([3_000]);
    sleeps.length = 0;
    await purgeCdn(
      CONFIGURED,
      { prefixes: ['tiles/p1/'], files: [] },
      {
        fetch: sequence([429], { 'Retry-After': '600' }).fn,
        sleep: async (ms) => void sleeps.push(ms),
      },
    );
    expect(sleeps).toEqual([10_000]);
  });

  it('retries a network error', async () => {
    logSpies();
    let calls = 0;
    const fn = (async () => {
      if (calls++ === 0) throw new TypeError('network');
      return Response.json({});
    }) as unknown as typeof fetch;
    const out = await purgeCdn(
      CONFIGURED,
      { prefixes: [], files: ['a.json'] },
      { fetch: fn, sleep: noSleep },
    );
    expect(calls).toBe(2);
    expect(out.status).toBe('purged');
  });

  it('never retries a 4xx other than 429', async () => {
    logSpies();
    const f = sequence([403, 403, 403]);
    await purgeCdn(
      CONFIGURED,
      { prefixes: ['tiles/p1/'], files: [] },
      { fetch: f.fn, sleep: noSleep },
    );
    expect(f.calls).toHaveLength(1);
  });
});

describe('purgeCdn queue', () => {
  const WITH_BUCKET: PurgeEnv = { ...CONFIGURED, BUCKET: env.BUCKET };
  const pending = async () => {
    const listed = await env.BUCKET.list({ prefix: CDN_PURGE_PENDING_PREFIX });
    return Promise.all(
      listed.objects.map(
        async (o) =>
          (await (await env.BUCKET.get(o.key))!.json()) as {
            firstAt: string;
            prefixes: string[];
            files: string[];
          },
      ),
    );
  };
  const clear = async () => {
    const listed = await env.BUCKET.list({ prefix: 'ops/cdn-purge/' });
    if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
  };
  beforeEach(clear);

  it('queues what still failed after its retries, as R2 keys', async () => {
    logSpies();
    const f = recordingFetch(async () => new Response('', { status: 429 }));
    const out = await purgeCdn(
      WITH_BUCKET,
      { prefixes: ['tiles/p1/'], files: ['pub/tours/t1.json'] },
      { fetch: f.fn, sleep: noSleep },
    );
    expect(out).toEqual({ status: 'pending', purged: 0, pending: 2, failed: 0 });
    const records = await pending();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ prefixes: ['tiles/p1/'], files: ['pub/tours/t1.json'] });
  });

  it('queues only the batches that failed', async () => {
    logSpies();
    // Prefixes go first: that request 429s, the files one goes through.
    let i = 0;
    const f = recordingFetch(async () =>
      i++ < 3 ? new Response('', { status: 429 }) : Response.json({}),
    );
    const out = await purgeCdn(
      WITH_BUCKET,
      { prefixes: ['tiles/p1/'], files: ['a.json', 'b.json'] },
      { fetch: f.fn, sleep: noSleep },
    );
    expect(out).toEqual({ status: 'pending', purged: 2, pending: 1, failed: 0 });
    expect(await pending()).toMatchObject([{ prefixes: ['tiles/p1/'], files: [] }]);
  });

  it('sends at most maxRequests and queues the rest without sending it', async () => {
    const f = recordingFetch();
    const files = Array.from({ length: 2_550 }, (_, i) => `tiles/p/t/${i}.webp`);
    const out = await purgeCdn(
      WITH_BUCKET,
      { prefixes: [], files },
      { fetch: f.fn, maxRequests: 5 },
    );
    expect(f.calls).toHaveLength(5);
    expect(f.bodies().every((b: { files: string[] }) => b.files.length === 100)).toBe(true);
    expect(out).toEqual({ status: 'pending', purged: 500, pending: 2_050, failed: 0 });
    // In records of at most PENDING_RECORD_MAX_ITEMS.
    const records = await pending();
    expect(records.map((r) => r.files.length).sort((a, b) => b - a)).toEqual([
      PENDING_RECORD_MAX_ITEMS,
      PENDING_RECORD_MAX_ITEMS,
      50,
    ]);
    expect(records.flatMap((r) => r.files).sort()).toEqual(files.slice(500).sort());
    // Nothing failed, so nothing to alert on.
    expect(await env.BUCKET.head(CDN_PURGE_FAILURE_KEY)).toBeNull();
  });

  it('queues nothing when told not to', async () => {
    logSpies();
    const f = recordingFetch(async () => new Response('', { status: 429 }));
    const out = await purgeCdn(
      WITH_BUCKET,
      { prefixes: ['tiles/p1/'], files: [] },
      { fetch: f.fn, sleep: noSleep, queue: false },
    );
    expect(out.status).toBe('failed');
    expect(await pending()).toEqual([]);
  });

  it('reports a skipped purge as such, and queues nothing', async () => {
    logSpies();
    const out = await purgeCdn(
      { ...WITH_BUCKET, CF_PURGE_TOKEN: undefined },
      { prefixes: ['tiles/p1/'], files: [] },
    );
    expect(out).toEqual({ status: 'skipped', purged: 0, pending: 0, failed: 1 });
    expect(await pending()).toEqual([]);
  });

  it('reports none for an empty purge', async () => {
    expect(await purgeCdn(WITH_BUCKET, { prefixes: [], files: [] })).toEqual({
      status: 'none',
      purged: 0,
      pending: 0,
      failed: 0,
    });
  });
});

describe('retryPendingPurges', () => {
  const WITH_BUCKET = { ...CONFIGURED, BUCKET: env.BUCKET };
  const NOW = new Date('2026-10-23T12:00:00.000Z');
  let n = 0;
  const queue = async (
    prefixes: string[],
    files: string[],
    firstAt = new Date(NOW.getTime() - 60_000).toISOString(),
  ) => {
    const key = `${CDN_PURGE_PENDING_PREFIX}${firstAt}-${String(n++).padStart(4, '0')}.json`;
    await env.BUCKET.put(key, JSON.stringify({ v: 1, firstAt, prefixes, files }));
    return key;
  };
  const keys = async () =>
    (await env.BUCKET.list({ prefix: CDN_PURGE_PENDING_PREFIX })).objects.map((o) => o.key);
  beforeEach(async () => {
    const listed = await env.BUCKET.list({ prefix: 'ops/cdn-purge/' });
    if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
  });

  it('folds a burst of single-pano records into one prefix request, then deletes them', async () => {
    for (let i = 0; i < 12; i++) await queue([`tiles/p${i}/`], []);
    const f = recordingFetch();
    const out = await retryPendingPurges(WITH_BUCKET, NOW, { fetch: f.fn });
    expect(f.calls).toHaveLength(1);
    expect(f.bodies()[0].prefixes).toHaveLength(12);
    expect(out).toEqual({ records: 12, purged: 12, left: 0, dead: 0 });
    expect(await keys()).toEqual([]);
  });

  it('keeps a record that still fails, without retrying inside the run, and alerts', async () => {
    logSpies();
    const key = await queue(['tiles/p1/'], []);
    const f = recordingFetch(async () => new Response('', { status: 429 }));
    const out = await retryPendingPurges(WITH_BUCKET, NOW, { fetch: f.fn, sleep: noSleep });
    expect(f.calls).toHaveLength(1);
    expect(out).toEqual({ records: 1, purged: 0, left: 1, dead: 0 });
    // Moved to the back of the queue, under a new key.
    const now = await keys();
    expect(now).toHaveLength(1);
    expect(now[0]).not.toBe(key);
    expect(now[0]! > key).toBe(true);
    expect(await env.BUCKET.head(CDN_PURGE_FAILURE_KEY)).not.toBeNull();
  });

  it('a record failing at the head of the queue lets the ones behind it go next run', async () => {
    logSpies();
    // RETRY_RUN_RECORDS records, all failing; one more behind them.
    for (let i = 0; i < 20; i++) await queue([`tiles/stuck${i}/`], []);
    const behind = await queue(
      [],
      ['pub/tours/behind.json'],
      new Date(NOW.getTime() - 1).toISOString(),
    );
    const failing = recordingFetch(async () => new Response('', { status: 429 }));
    await retryPendingPurges(WITH_BUCKET, NOW, { fetch: failing.fn });
    const later = new Date(NOW.getTime() + 15 * 60_000);
    const f = recordingFetch();
    await retryPendingPurges(WITH_BUCKET, later, { fetch: f.fn });
    expect(f.bodies()).toContainEqual({ files: ['https://cdn.panote.dev/pub/tours/behind.json'] });
    expect(await keys()).not.toContain(behind);
  });

  it('keeps every record in pending/ on a 403 (the token), sending one request', async () => {
    logSpies();
    await queue(['tiles/a/'], []);
    await queue([], ['pub/tours/t.json']);
    const f = recordingFetch(async () => new Response('', { status: 403 }));
    const out = await retryPendingPurges(WITH_BUCKET, NOW, { fetch: f.fn });
    expect(f.calls).toHaveLength(1);
    expect(out).toEqual({ records: 2, purged: 0, left: 2, dead: 0 });
    expect(await keys()).toHaveLength(2);
    expect((await env.BUCKET.list({ prefix: CDN_PURGE_DEAD_PREFIX })).objects).toHaveLength(0);
    expect(await env.BUCKET.head(CDN_PURGE_FAILURE_KEY)).not.toBeNull();
  });

  it('dead-letters what Cloudflare refuses outright, and keeps the rest going', async () => {
    const spies = logSpies();
    await queue(['tiles/ok/'], ['bad url']);
    const f = recordingFetch(async () => new Response('', { status: 400 }));
    const out = await retryPendingPurges(WITH_BUCKET, NOW, { fetch: f.fn });
    expect(out.dead).toBe(2);
    expect(await keys()).toEqual([]);
    const dead = await env.BUCKET.list({ prefix: CDN_PURGE_DEAD_PREFIX });
    expect(dead.objects).toHaveLength(1);
    const record = (await (await env.BUCKET.get(dead.objects[0]!.key))!.json()) as {
      prefixes: string[];
      files: string[];
      reason: string;
    };
    expect(record).toMatchObject({ prefixes: ['tiles/ok/'], files: ['bad url'] });
    expect(record.reason).toContain('HTTP 400');
    expect(allLogged(spies)).toContain('dead-lettered 2 item(s)');
    expect(await env.BUCKET.head(CDN_PURGE_FAILURE_KEY)).not.toBeNull();
  });

  it("takes a small, fixed share of the 15-minute invocation's budget", () => {
    // The cron gives the backup BACKUP_RUN_BUDGET less this, so the invocation stays
    // within BACKUP_RUN_BUDGET (under the 1,000 subrequest limit) and the backup keeps most of it.
    expect(RETRY_RUN_MAX_SUBREQUESTS).toBe(97);
    expect(BACKUP_RUN_BUDGET - RETRY_RUN_MAX_SUBREQUESTS).toBeGreaterThanOrEqual(800);
  });

  it('trims a record to what did not go through', async () => {
    logSpies();
    const key = await queue(['tiles/p1/'], ['pub/tours/t1.json']);
    // The prefix request (first) 429s; the files one goes through.
    let i = 0;
    const f = recordingFetch(async () =>
      i++ === 0 ? new Response('', { status: 429 }) : Response.json({}),
    );
    await retryPendingPurges(WITH_BUCKET, NOW, { fetch: f.fn });
    expect(await env.BUCKET.head(key)).toBeNull();
    const [moved] = await keys();
    const rest = (await (await env.BUCKET.get(moved!))!.json()) as {
      prefixes: string[];
      files: string[];
    };
    expect(rest).toMatchObject({ prefixes: ['tiles/p1/'], files: [] });
  });

  it(`sends at most ${RETRY_RUN_REQUESTS} requests a run; the next run carries on`, async () => {
    const files = Array.from({ length: (RETRY_RUN_REQUESTS + 5) * 100 }, (_, i) => `tiles/p/${i}`);
    for (let i = 0; i < files.length; i += PENDING_RECORD_MAX_ITEMS) {
      await queue([], files.slice(i, i + PENDING_RECORD_MAX_ITEMS));
    }
    const f = recordingFetch();
    const first = await retryPendingPurges(WITH_BUCKET, NOW, { fetch: f.fn });
    expect(f.calls).toHaveLength(RETRY_RUN_REQUESTS);
    expect(first.left).toBe(500);
    const second = await retryPendingPurges(WITH_BUCKET, NOW, { fetch: f.fn });
    expect(second).toEqual({ records: 1, purged: 500, left: 0, dead: 0 });
    expect(await keys()).toEqual([]);
  });

  it('never loses a refused item when a later R2 write fails', async () => {
    logSpies();
    await queue(['tiles/refused/'], ['pub/tours/retry.json']);
    // The prefix batch is refused (400); the files batch fails and is retried, so its
    // record is rotated, and that PUT throws.
    const fn = (async (_url: string, init: RequestInit) =>
      'prefixes' in (JSON.parse(String(init.body)) as object)
        ? new Response('', { status: 400 })
        : new Response('', { status: 503 })) as unknown as typeof fetch;
    const broken = new Proxy(env.BUCKET, {
      get(target, prop) {
        if (prop === 'put') {
          return (key: string, ...rest: unknown[]) =>
            key.startsWith(CDN_PURGE_PENDING_PREFIX)
              ? Promise.reject(new Error('r2 down'))
              : (target.put as (...a: unknown[]) => unknown).call(target, key, ...rest);
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      retryPendingPurges({ ...CONFIGURED, BUCKET: broken }, NOW, { fetch: fn }),
    ).rejects.toThrow('r2 down');
    const deadKeys = (await env.BUCKET.list({ prefix: CDN_PURGE_DEAD_PREFIX })).objects;
    const dead = await Promise.all(
      deadKeys.map(
        async (o) => (await (await env.BUCKET.get(o.key))!.json()) as { prefixes: string[] },
      ),
    );
    const pending = await Promise.all(
      (await keys()).map(
        async (k) => (await (await env.BUCKET.get(k))!.json()) as { prefixes: string[] },
      ),
    );
    const everywhere = [...dead, ...pending].flatMap((r) => r.prefixes);
    expect(everywhere).toContain('tiles/refused/');
    expect(await env.BUCKET.head(CDN_PURGE_FAILURE_KEY)).not.toBeNull();
  });

  it('keeps refused items queued when their dead letter cannot be written', async () => {
    logSpies();
    const key = await queue(['tiles/refused/'], []);
    const broken = new Proxy(env.BUCKET, {
      get(target, prop) {
        if (prop === 'put') {
          return (k: string, ...rest: unknown[]) =>
            k.startsWith(CDN_PURGE_DEAD_PREFIX)
              ? Promise.reject(new Error('r2 down'))
              : (target.put as (...a: unknown[]) => unknown).call(target, k, ...rest);
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const f = recordingFetch(async () => new Response('', { status: 400 }));
    const out = await retryPendingPurges({ ...CONFIGURED, BUCKET: broken }, NOW, { fetch: f.fn });
    expect(out.dead).toBe(0);
    expect(await keys()).toEqual([key]);
    const marker = (await (await env.BUCKET.get(CDN_PURGE_FAILURE_KEY))!.json()) as {
      detail: string;
    };
    expect(marker.detail).toContain('not dead-lettered');
  });

  it('alerts when it drops an unreadable record', async () => {
    logSpies();
    await env.BUCKET.put(`${CDN_PURGE_PENDING_PREFIX}junk2.json`, 'not json');
    await retryPendingPurges(WITH_BUCKET, NOW, { fetch: recordingFetch().fn });
    expect(await env.BUCKET.head(CDN_PURGE_FAILURE_KEY)).not.toBeNull();
  });

  it('dead-letters a record that has failed for over a week, loudly', async () => {
    const spies = logSpies();
    await queue(['tiles/old/'], [], new Date(NOW.getTime() - PENDING_MAX_AGE_MS - 1).toISOString());
    const f = recordingFetch(async () => new Response('', { status: 429 }));
    await retryPendingPurges(WITH_BUCKET, NOW, { fetch: f.fn });
    expect(await keys()).toEqual([]);
    expect((await env.BUCKET.list({ prefix: CDN_PURGE_DEAD_PREFIX })).objects).toHaveLength(1);
    expect(allLogged(spies)).toContain('cdn purge given up');
  });

  it('drops an unreadable record', async () => {
    const spies = logSpies();
    await env.BUCKET.put(`${CDN_PURGE_PENDING_PREFIX}junk.json`, 'not json');
    const f = recordingFetch();
    expect(await retryPendingPurges(WITH_BUCKET, NOW, { fetch: f.fn })).toEqual({
      records: 0,
      purged: 0,
      left: 0,
      dead: 0,
    });
    expect(f.calls).toHaveLength(0);
    expect(await keys()).toEqual([]);
    expect(allLogged(spies)).toContain('unreadable');
  });

  it('leaves the queue alone while the purge is not configured', async () => {
    const key = await queue(['tiles/p1/'], []);
    const f = recordingFetch();
    await retryPendingPurges({ ...WITH_BUCKET, CF_PURGE_TOKEN: undefined }, NOW, { fetch: f.fn });
    expect(f.calls).toHaveLength(0);
    expect(await keys()).toEqual([key]);
  });
});

describe('purgeCdn bounds', () => {
  it('stops at the first batch that still fails after its retries, and queues the rest unsent', async () => {
    logSpies();
    const f = recordingFetch(async () => new Response('', { status: 503 }));
    const files = Array.from({ length: 500 }, (_, i) => `tiles/p/${i}`);
    const out = await purgeCdn(
      { ...CONFIGURED, BUCKET: env.BUCKET },
      { prefixes: ['tiles/p/'], files },
      { fetch: f.fn, sleep: noSleep },
    );
    // One batch, three attempts: an outage, so nothing else is sent.
    expect(f.calls).toHaveLength(3);
    expect(out).toEqual({ status: 'pending', purged: 0, pending: 501, failed: 0 });
  });

  it('a 429 stops only its own kind: URL purges have their own budget', async () => {
    logSpies();
    const calls: string[] = [];
    const fn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(Object.keys(body)[0]!);
      return 'prefixes' in body ? new Response('', { status: 429 }) : Response.json({});
    }) as unknown as typeof fetch;
    const prefixes = Array.from({ length: 150 }, (_, i) => `tiles/p${i}/`);
    const out = await purgeCdn(
      { ...CONFIGURED, BUCKET: env.BUCKET },
      { prefixes, files: ['a.json'] },
      { fetch: fn, sleep: noSleep, retries: 0 },
    );
    expect(calls).toEqual(['prefixes', 'files']);
    expect(out).toMatchObject({ purged: 1, pending: 150 });
  });

  it('counts retries against maxRequests', async () => {
    logSpies();
    let i = 0;
    const f = recordingFetch(async () =>
      i++ === 0 ? new Response('', { status: 500 }) : Response.json({}),
    );
    const files = Array.from({ length: 300 }, (_, n) => `tiles/p/${n}`);
    const out = await purgeCdn(
      { ...CONFIGURED, BUCKET: env.BUCKET },
      { prefixes: [], files },
      { fetch: f.fn, sleep: noSleep, maxRequests: 3 },
    );
    // A failed attempt and its retry use two of the three: two batches go through.
    expect(f.calls).toHaveLength(3);
    expect(out).toEqual({ status: 'pending', purged: 200, pending: 100, failed: 0 });
  });

  it('starts nothing that could run past the deadline', async () => {
    const f = recordingFetch();
    const out = await purgeCdn(
      { ...CONFIGURED, BUCKET: env.BUCKET },
      { prefixes: [], files: ['a.json'] },
      { fetch: f.fn, deadline: Date.now() + 1_000, timeoutMs: 5_000 },
    );
    expect(f.calls).toHaveLength(0);
    expect(out).toEqual({ status: 'pending', purged: 0, pending: 1, failed: 0 });
  });

  it('skips a backoff that would run past the deadline', async () => {
    logSpies();
    const sleeps: number[] = [];
    const f = recordingFetch(async () => new Response('', { status: 429 }));
    await purgeCdn(
      { ...CONFIGURED, BUCKET: env.BUCKET },
      { prefixes: ['tiles/p/'], files: [] },
      {
        fetch: f.fn,
        sleep: async (ms) => void sleeps.push(ms),
        deadline: Date.now() + 5_500,
        timeoutMs: 5_000,
      },
    );
    expect(f.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('dead-letters what Cloudflare refuses outright, instead of queueing it', async () => {
    logSpies();
    const listed = await env.BUCKET.list({ prefix: 'ops/cdn-purge/' });
    if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
    const f = recordingFetch(async () => new Response('', { status: 400 }));
    const out = await purgeCdn(
      { ...CONFIGURED, BUCKET: env.BUCKET },
      { prefixes: [], files: ['bad'] },
      { fetch: f.fn, sleep: noSleep },
    );
    expect(f.calls).toHaveLength(1);
    expect(out).toEqual({ status: 'failed', purged: 0, pending: 0, failed: 1 });
    expect((await env.BUCKET.list({ prefix: CDN_PURGE_PENDING_PREFIX })).objects).toEqual([]);
    expect((await env.BUCKET.list({ prefix: CDN_PURGE_DEAD_PREFIX })).objects).toHaveLength(1);
  });
});

describe('purge bounds by default, priority and the queue cap', () => {
  const clear = async () => {
    let listed = await env.BUCKET.list({ prefix: 'ops/cdn-purge/' });
    while (listed.objects.length) {
      await env.BUCKET.delete(listed.objects.map((o) => o.key));
      listed = await env.BUCKET.list({ prefix: 'ops/cdn-purge/' });
    }
  };
  beforeEach(clear);

  it('sends nothing that could run past the default 20 s deadline, and queues it', async () => {
    const f = recordingFetch();
    const out = await purgeCdn(
      { ...CONFIGURED, BUCKET: env.BUCKET },
      { prefixes: ['tiles/p/'], files: [] },
      { fetch: f.fn, timeoutMs: 25_000 },
    );
    expect(f.calls).toHaveLength(0);
    expect(out.status).toBe('pending');
  });

  it("queues a takedown's leftovers where the cron reads first", async () => {
    logSpies();
    await purgeCdn(
      { ...CONFIGURED, BUCKET: env.BUCKET },
      { prefixes: [], files: ['tiles/p/1.webp'] },
      { fetch: recordingFetch(async () => new Response('', { status: 503 })).fn, sleep: noSleep },
    );
    await purgeCdn(
      { ...CONFIGURED, BUCKET: env.BUCKET },
      { prefixes: [], files: ['tiles/op/1.webp'] },
      {
        fetch: recordingFetch(async () => new Response('', { status: 503 })).fn,
        sleep: noSleep,
        priority: true,
      },
    );
    const keys = (await env.BUCKET.list({ prefix: CDN_PURGE_PENDING_PREFIX })).objects.map(
      (o) => o.key,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]!.startsWith(OPERATOR_PENDING_PREFIX)).toBe(true);
  });

  it(`drops the oldest owner records past ${QUEUE_MAX_RECORDS}, never a takedown's`, async () => {
    const spies = logSpies();
    const body = (prefixes: string[]) =>
      JSON.stringify({ v: 1, firstAt: new Date().toISOString(), prefixes, files: [] });
    await env.BUCKET.put(
      `${OPERATOR_PENDING_PREFIX}2026-01-01T00:00:00.000Z-op.json`,
      body(['tiles/op/']),
    );
    const owner = Array.from(
      { length: QUEUE_MAX_RECORDS + 10 },
      (_, i) =>
        `${CDN_PURGE_PENDING_PREFIX}2026-01-01T00:00:00.000Z-${String(i).padStart(5, '0')}.json`,
    );
    for (let i = 0; i < owner.length; i += 100) {
      await Promise.all(owner.slice(i, i + 100).map((k) => env.BUCKET.put(k, body(['tiles/x/']))));
    }
    await retryPendingPurges({ ...CONFIGURED, BUCKET: env.BUCKET }, new Date(), {
      fetch: recordingFetch().fn,
    });
    const left = new Set(
      (await env.BUCKET.list({ prefix: CDN_PURGE_PENDING_PREFIX, limit: 1000 })).objects.map(
        (o) => o.key,
      ),
    );
    // The run's own records went through; the next QUEUE_DROP_PER_RUN owner ones were dropped.
    expect(left.has(`${OPERATOR_PENDING_PREFIX}2026-01-01T00:00:00.000Z-op.json`)).toBe(false);
    const dropped = owner.slice(19, 19 + QUEUE_DROP_PER_RUN);
    expect(dropped.some((k) => left.has(k))).toBe(false);
    expect(left.has(owner[19 + QUEUE_DROP_PER_RUN]!)).toBe(true);
    expect(allLogged(spies)).toContain(`cdn purge queue over ${QUEUE_MAX_RECORDS} records`);
  }, 30_000);

  it('meteredBucket counts every call made through it', async () => {
    const m = meteredBucket(env.BUCKET);
    await m.bucket.put('meter/a', 'x');
    await m.bucket.head('meter/a');
    await m.bucket.delete('meter/a');
    expect(m.calls()).toBe(3);
  });
});
