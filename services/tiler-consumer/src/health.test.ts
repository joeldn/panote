import {
  CDN_PURGE_FAILURE_KEY,
  CRON_STATUS_KEY,
  type CdnPurgeFailure,
  type CronStatus,
} from '@internal/contracts';
import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_THROTTLE_MS } from './alert.js';
import worker from './consumer.js';
import {
  checkCron,
  checkPurge,
  CRON_CHECK,
  CRON_STALE_MS,
  decide,
  EMPTY_STATE,
  HEALTH_STATE_KEY,
  PURGE_CHECK,
  PURGE_FAILURE_WINDOW_MS,
  runHealthCheck,
  type HealthState,
} from './health.js';
import type { CheckResult } from './health-probes.js';

const T0 = new Date('2026-10-20T10:00:00.000Z').getTime();
const MIN = 60_000;

const ok = (name: string): CheckResult => ({ name, ok: true, detail: 'ok' });
const bad = (name: string, detail = 'HTTP 500'): CheckResult => ({ name, ok: false, detail });

describe('decide', () => {
  // Runs results through decide as the scheduler would, sending every alert it plans.
  const run = (state: HealthState, results: CheckResult[], now: number) => {
    const d = decide(state, results, now);
    const next = d.alert ? { ...d.state, announced: d.alert.down, lastSentAt: now } : d.state;
    return { ...d, next };
  };

  it('alerts only after two failures in a row', () => {
    const first = run(EMPTY_STATE, [bad('a'), ok('b')], T0);
    expect(first.alert).toBeNull();
    expect(first.next.failures).toEqual({ a: 1 });
    const second = run(first.next, [bad('a'), ok('b')], T0 + 5 * MIN);
    expect(second.alert).toEqual({ down: ['a'], newlyDown: ['a'], recovered: [] });
    // Still down: nothing new to say.
    const third = run(second.next, [bad('a'), ok('b')], T0 + 10 * MIN);
    expect(third.alert).toBeNull();
    expect(third.next.failures).toEqual({ a: 3 });
  });

  it('forgets a single failure once the check passes again', () => {
    const first = run(EMPTY_STATE, [bad('a')], T0);
    const second = run(first.next, [ok('a')], T0 + 5 * MIN);
    expect(second.next.failures).toEqual({});
    expect(run(second.next, [bad('a')], T0 + 10 * MIN).alert).toBeNull();
  });

  it('sends a recovery once the throttle window has passed', () => {
    let s = run(EMPTY_STATE, [bad('a')], T0).next;
    s = run(s, [bad('a')], T0 + 5 * MIN).next;
    expect(s.announced).toEqual(['a']);
    // Back up inside the window: held back.
    const early = run(s, [ok('a')], T0 + 10 * MIN);
    expect(early.alert).toBeNull();
    expect(early.throttled).toBe(true);
    // Still up after it: the recovery goes out.
    const later = run(early.next, [ok('a')], T0 + 5 * MIN + ALERT_THROTTLE_MS);
    expect(later.alert).toEqual({ down: [], newlyDown: [], recovered: ['a'] });
    expect(later.next.announced).toEqual([]);
  });

  it('sends nothing for a flap that ends where the last email left it', () => {
    let s = run(EMPTY_STATE, [bad('a')], T0).next;
    s = run(s, [bad('a')], T0 + 5 * MIN).next;
    s = run(s, [ok('a')], T0 + 10 * MIN).next;
    s = run(s, [bad('a')], T0 + 15 * MIN).next;
    const back = run(s, [bad('a')], T0 + 20 * MIN);
    expect(back.alert).toBeNull();
    expect(back.throttled).toBe(false);
  });

  it('reports a second check going down alongside the one already reported', () => {
    let s = run(EMPTY_STATE, [bad('a'), ok('b')], T0).next;
    s = run(s, [bad('a'), ok('b')], T0 + 5 * MIN).next;
    s = run(s, [bad('a'), bad('b')], T0 + ALERT_THROTTLE_MS).next;
    const d = run(s, [bad('a'), bad('b')], T0 + ALERT_THROTTLE_MS + 5 * MIN);
    expect(d.alert).toEqual({ down: ['a', 'b'], newlyDown: ['b'], recovered: [] });
  });

  it('treats a lastSentAt in the future as an expired window', () => {
    const state: HealthState = { ...EMPTY_STATE, failures: { a: 1 }, lastSentAt: T0 + 60 * MIN };
    expect(decide(state, [bad('a')], T0).alert?.down).toEqual(['a']);
  });
});

describe('checkCron', () => {
  beforeEach(() => env.BUCKET.delete(CRON_STATUS_KEY));
  const putStatus = (s: CronStatus) => env.BUCKET.put(CRON_STATUS_KEY, JSON.stringify(s));
  const iso = (ms: number) => new Date(ms).toISOString();

  it('passes a clean run inside 26 hours', async () => {
    await putStatus({
      lastRunAt: iso(T0 - 20 * 60 * MIN),
      lastOkAt: iso(T0 - 20 * 60 * MIN),
      failed: [],
    });
    const { result, cronMissingSince } = await checkCron(env.BUCKET, EMPTY_STATE, T0);
    expect(result.ok).toBe(true);
    expect(cronMissingSince).toBeNull();
  });

  it('fails once the last clean run is over 26 hours old', async () => {
    const at = T0 - CRON_STALE_MS - MIN;
    await putStatus({ lastRunAt: iso(at), lastOkAt: iso(at), failed: [] });
    const { result } = await checkCron(env.BUCKET, EMPTY_STATE, T0);
    expect(result).toEqual({ name: CRON_CHECK, ok: false, detail: `last clean run ${iso(at)}` });
  });

  it('fails when the last run had a task throw, naming the tasks', async () => {
    await putStatus({
      lastRunAt: iso(T0 - MIN),
      lastOkAt: iso(T0 - 24 * 60 * MIN),
      failed: ['tile-gc'],
    });
    const { result } = await checkCron(env.BUCKET, EMPTY_STATE, T0);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(
      `run at ${iso(T0 - MIN)} failed: tile-gc (clears after the next successful daily run)`,
    );
  });

  it('fails a status that never had a clean run, or is malformed', async () => {
    await putStatus({ lastRunAt: iso(T0 - MIN), lastOkAt: null, failed: [] });
    expect((await checkCron(env.BUCKET, EMPTY_STATE, T0)).result.detail).toBe(
      'last clean run never',
    );
    await env.BUCKET.put(CRON_STATUS_KEY, '{"lastRunAt":1}');
    expect((await checkCron(env.BUCKET, EMPTY_STATE, T0)).result.detail).toBe('status malformed');
  });

  it('gives a fresh bucket 26 hours from first sight before failing', async () => {
    const first = await checkCron(env.BUCKET, EMPTY_STATE, T0);
    expect(first.result.ok).toBe(true);
    expect(first.cronMissingSince).toBe(T0);
    const state = { ...EMPTY_STATE, cronMissingSince: first.cronMissingSince };
    expect((await checkCron(env.BUCKET, state, T0 + CRON_STALE_MS)).result.ok).toBe(true);
    const late = await checkCron(env.BUCKET, state, T0 + CRON_STALE_MS + MIN);
    expect(late.result.ok).toBe(false);
    expect(late.cronMissingSince).toBe(T0);
  });
});

describe('checkPurge', () => {
  beforeEach(() => env.BUCKET.delete(CDN_PURGE_FAILURE_KEY));
  const putFailure = (f: CdnPurgeFailure) =>
    env.BUCKET.put(CDN_PURGE_FAILURE_KEY, JSON.stringify(f));

  it('passes with no failure recorded', async () => {
    expect((await checkPurge(env.BUCKET, T0)).ok).toBe(true);
  });

  it('fails for an hour after a failure, then passes again', async () => {
    const at = new Date(T0 - 10 * MIN).toISOString();
    await putFailure({ at, detail: 'prefixes, 1: HTTP 429' });
    const recent = await checkPurge(env.BUCKET, T0);
    expect(recent).toEqual({
      name: PURGE_CHECK,
      ok: false,
      detail: `failed at ${at}: prefixes, 1: HTTP 429`,
    });
    expect((await checkPurge(env.BUCKET, T0 - 10 * MIN + PURGE_FAILURE_WINDOW_MS)).ok).toBe(true);
  });
});

describe('runHealthCheck', () => {
  type Sent = { to: string; from: string; subject: string; text: string };
  const ADDRESS = 'owner@example.com';
  let sent: Sent[];
  let sendFails: boolean;
  let status: number;

  const page = (body = '<!doctype html>') =>
    new Response(body, { status, headers: { 'content-type': 'text/html' } });
  const fetcher = (respond: (req: Request) => Response) =>
    ({ fetch: async (req: Request) => respond(req) }) as unknown as Fetcher;
  const testEnv = (overrides: Record<string, unknown> = {}) =>
    ({
      ...env,
      HEALTH_SITE_ORIGIN: 'https://panote.dev',
      HEALTH_TOUR_SLUG: '',
      HEALTH_PUBLIC_PROBES: 'false',
      WEBSITE: fetcher(() => page()),
      ADMIN_APP: fetcher(() => page()),
      PUBLIC_API: fetcher(() => Response.json({ tours: [], cursor: null }, { status })),
      ADMIN_API: fetcher(() => Response.json({}, { status: status === 200 ? 401 : status })),
      UPLOAD_API: fetcher(() => Response.json({}, { status: status === 200 ? 401 : status })),
      ALERT_EMAIL_TO: ADDRESS,
      ALERT_EMAIL: {
        send: async (m: Sent) => {
          if (sendFails) throw Object.assign(new Error(`bad ${ADDRESS}`), { code: 'E_X' });
          sent.push(m);
          return { messageId: `m${sent.length}` };
        },
      },
      ...overrides,
    }) as unknown as typeof env;
  const state = async () =>
    (await (await env.BUCKET.get(HEALTH_STATE_KEY))?.json()) as HealthState | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sent = [];
    sendFails = false;
    status = 200;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await env.BUCKET.delete([HEALTH_STATE_KEY, CRON_STATUS_KEY, CDN_PURGE_FAILURE_KEY]);
    await env.BUCKET.put(
      CRON_STATUS_KEY,
      JSON.stringify({
        lastRunAt: new Date(T0).toISOString(),
        lastOkAt: new Date(T0).toISOString(),
        failed: [],
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes everything on a healthy site, emails nothing and writes no state', async () => {
    const results = await runHealthCheck(testEnv(), T0 + MIN);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.name)).toContain(CRON_CHECK);
    expect(results.map((r) => r.name)).toContain(PURGE_CHECK);
    expect(sent).toEqual([]);
    expect(await state()).toBeUndefined();
  });

  it('emails once on the second failing run and once on recovery, from the alert sender', async () => {
    status = 502;
    await runHealthCheck(testEnv(), T0);
    expect(sent).toHaveLength(0);
    await runHealthCheck(testEnv(), T0 + 5 * MIN);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(ADDRESS);
    expect(sent[0]?.from).toBe('tiler-alerts@panote.io');
    expect(sent[0]?.subject).toMatch(/^\[panote\] panote\.dev DOWN \(6\): /);
    expect(sent[0]?.text).toContain('- website /: HTTP 502, 2 checks in a row');
    expect(sent[0]?.text).toContain('- admin-api /api/admin/panos: HTTP 502, expected 401');
    expect(errorSpy).toHaveBeenCalledWith('[health] check failed check=website / detail=HTTP 502');
    await runHealthCheck(testEnv(), T0 + 10 * MIN);
    expect(sent).toHaveLength(1);

    status = 200;
    await runHealthCheck(testEnv(), T0 + 15 * MIN);
    expect(sent).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[health] alert throttled: the down checks changed inside the window',
    );
    await runHealthCheck(testEnv(), T0 + 5 * MIN + ALERT_THROTTLE_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.subject).toBe('[panote] panote.dev recovered: all checks pass');
    expect(sent[1]?.text).toContain('Recovered:\n- admin app /app/');
    expect((await state())?.announced).toEqual([]);
  });

  it('alerts on a stale daily cron and a failed purge', async () => {
    await env.BUCKET.put(
      CRON_STATUS_KEY,
      JSON.stringify({
        lastRunAt: new Date(T0 - CRON_STALE_MS - MIN).toISOString(),
        lastOkAt: new Date(T0 - CRON_STALE_MS - MIN).toISOString(),
        failed: [],
      }),
    );
    await env.BUCKET.put(
      CDN_PURGE_FAILURE_KEY,
      JSON.stringify({ at: new Date(T0).toISOString(), detail: 'files, 2: HTTP 403' }),
    );
    await runHealthCheck(testEnv(), T0);
    await runHealthCheck(testEnv(), T0 + 5 * MIN);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe(`[panote] panote.dev DOWN (2): ${CRON_CHECK}, ${PURGE_CHECK}`);
  });

  it('retries a failed send on the next run, never logging the address', async () => {
    status = 500;
    sendFails = true;
    await runHealthCheck(testEnv(), T0);
    await runHealthCheck(testEnv(), T0 + 5 * MIN);
    expect(errorSpy).toHaveBeenCalledWith('[health] failed to send alert: code=E_X name=Error');
    expect((await state())?.announced).toEqual([]);
    sendFails = false;
    await runHealthCheck(testEnv(), T0 + 10 * MIN);
    expect(sent).toHaveLength(1);
    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join('\n');
    expect(logged).not.toContain(ADDRESS);
  });

  it('warns and sends nothing when ALERT_EMAIL_TO is unset', async () => {
    status = 500;
    const e = testEnv({ ALERT_EMAIL_TO: undefined });
    await runHealthCheck(e, T0);
    await runHealthCheck(e, T0 + 5 * MIN);
    expect(sent).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[health] skip alert'));
  });

  it('never throws, even when the bucket does', async () => {
    const broken = {
      get: () => Promise.reject(new Error('r2 down')),
      put: () => Promise.reject(new Error('r2 down')),
    };
    await expect(runHealthCheck(testEnv({ BUCKET: broken }), T0)).resolves.toBeInstanceOf(Array);
  });

  it('runs from the Cron Trigger', async () => {
    status = 503;
    const ctx = createExecutionContext();
    worker.scheduled(
      createScheduledController({ scheduledTime: T0, cron: '*/5 * * * *' }),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect((await state())?.failures['website /']).toBe(1);
  });
});
