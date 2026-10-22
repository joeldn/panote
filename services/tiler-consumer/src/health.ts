import {
  CDN_PURGE_FAILURE_KEY,
  CdnPurgeFailureSchema,
  CRON_STATUS_KEY,
  CronStatusSchema,
} from '@internal/contracts';
import { ALERT_THROTTLE_MS } from './alert.js';
import { buildProbes, runProbe, type CheckResult } from './health-probes.js';

// The 5-minute health check (docs/deploy.md, "Monitoring and alerts"). It lives in
// tiler-consumer because that Worker already holds the alert email binding and
// recipient, and panote.io is the only domain with Email Routing to send from.

/** A check has to fail this many runs in a row before it counts as down. */
export const FAILURES_TO_ALERT = 2;
/** admin-api's daily cron counts as failing once its last clean run is older than this. */
export const CRON_STALE_MS = 26 * 60 * 60 * 1000;
/** A failed CDN purge keeps its check failing this long, then it recovers on its own. */
export const PURGE_FAILURE_WINDOW_MS = 60 * 60 * 1000;

export const CRON_CHECK = 'admin-api daily cron';
export const PURGE_CHECK = 'cdn purge';

// Next to the DLQ alert's state under ops/: private, and no R2 notification watches it.
export const HEALTH_STATE_KEY = 'ops/health/state.json';

export interface HealthState {
  /** Consecutive failures per check that failed last run; a passing check is absent. */
  failures: Record<string, number>;
  /** The checks the last email that went out reported as down, sorted. */
  announced: string[];
  /** ms since the epoch of that email; 0 if none has gone out. */
  lastSentAt: number;
  /** When the check first found no cron status at all (a fresh bucket); null once it has. */
  cronMissingSince: number | null;
}

export const EMPTY_STATE: HealthState = {
  failures: {},
  announced: [],
  lastSentAt: 0,
  cronMissingSince: null,
};

export interface AlertPlan {
  down: string[];
  newlyDown: string[];
  recovered: string[];
}

export interface Decision {
  /** The state to keep if no email goes out (or it fails to). */
  state: HealthState;
  /** What to email, or null when nothing changed or the throttle holds it back. */
  alert: AlertPlan | null;
  /** True when the down set changed but the throttle window is still open. */
  throttled: boolean;
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * The state machine. A check is down after FAILURES_TO_ALERT failures in a row and up
 * again after one pass. An email goes out whenever the set of down checks differs from
 * the set the last email reported, at most once per ALERT_THROTTLE_MS: a flap inside
 * the window that ends where it started sends nothing, and one that doesn't is
 * reported once the window closes, as it stands then.
 */
export const decide = (state: HealthState, results: CheckResult[], now: number): Decision => {
  const failures: Record<string, number> = {};
  for (const r of results) if (!r.ok) failures[r.name] = (state.failures[r.name] ?? 0) + 1;
  const down = Object.keys(failures)
    .filter((name) => (failures[name] ?? 0) >= FAILURES_TO_ALERT)
    .sort();
  const next = { ...state, failures };
  if (sameSet(down, state.announced)) return { state: next, alert: null, throttled: false };
  // A lastSentAt in the future (a clock that jumped back) counts as an expired window.
  const age = now - state.lastSentAt;
  if (state.lastSentAt && age >= 0 && age < ALERT_THROTTLE_MS) {
    return { state: next, alert: null, throttled: true };
  }
  return {
    state: next,
    alert: {
      down,
      newlyDown: down.filter((n) => !state.announced.includes(n)),
      recovered: state.announced.filter((n) => !down.includes(n)),
    },
    throttled: false,
  };
};

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown error');

const readJson = async (bucket: R2Bucket, key: string): Promise<unknown> => {
  const obj = await bucket.get(key);
  return obj ? await obj.json() : null;
};

/**
 * admin-api's daily cron: fails when its last clean run is over CRON_STALE_MS old, or
 * its last run had a task throw. A bucket with no status yet (just deployed) gets
 * CRON_STALE_MS from the first time this check saw that, before it fails.
 */
export const checkCron = async (
  bucket: R2Bucket,
  state: HealthState,
  now: number,
): Promise<{ result: CheckResult; cronMissingSince: number | null }> => {
  const fail = (detail: string, cronMissingSince: number | null = null) => ({
    result: { name: CRON_CHECK, ok: false, detail },
    cronMissingSince,
  });
  let raw: unknown;
  try {
    raw = await readJson(bucket, CRON_STATUS_KEY);
  } catch (e) {
    return fail(`status unreadable: ${errorName(e)}`, state.cronMissingSince);
  }
  if (raw === null) {
    const since = state.cronMissingSince ?? now;
    if (now - since > CRON_STALE_MS) {
      return fail(`no run recorded since ${new Date(since).toISOString()}`, since);
    }
    return {
      result: { name: CRON_CHECK, ok: true, detail: 'no run recorded yet' },
      cronMissingSince: since,
    };
  }
  const parsed = CronStatusSchema.safeParse(raw);
  if (!parsed.success) return fail('status malformed');
  const { lastRunAt, lastOkAt, failed } = parsed.data;
  // Stays failing until the next daily run comes back clean, about a day later.
  if (failed.length > 0) {
    return fail(
      `run at ${lastRunAt} failed: ${failed.join(', ')} (clears after the next successful daily run)`,
    );
  }
  const okAt = lastOkAt === null ? NaN : Date.parse(lastOkAt);
  if (!(now - okAt <= CRON_STALE_MS)) return fail(`last clean run ${lastOkAt ?? 'never'}`);
  return {
    result: { name: CRON_CHECK, ok: true, detail: `last clean run ${lastOkAt}` },
    cronMissingSince: null,
  };
};

/** CDN purges: fails while admin-api's last recorded purge failure is under an hour old. */
export const checkPurge = async (bucket: R2Bucket, now: number): Promise<CheckResult> => {
  let raw: unknown;
  try {
    raw = await readJson(bucket, CDN_PURGE_FAILURE_KEY);
  } catch (e) {
    return { name: PURGE_CHECK, ok: false, detail: `marker unreadable: ${errorName(e)}` };
  }
  if (raw === null) return { name: PURGE_CHECK, ok: true, detail: 'no failure recorded' };
  const parsed = CdnPurgeFailureSchema.safeParse(raw);
  if (!parsed.success) return { name: PURGE_CHECK, ok: false, detail: 'marker malformed' };
  const age = now - Date.parse(parsed.data.at);
  if (age >= 0 && age < PURGE_FAILURE_WINDOW_MS) {
    return {
      name: PURGE_CHECK,
      ok: false,
      detail: `failed at ${parsed.data.at}: ${parsed.data.detail}`,
    };
  }
  return { name: PURGE_CHECK, ok: true, detail: `last failure ${parsed.data.at}` };
};

const readState = async (bucket: R2Bucket): Promise<HealthState> => {
  try {
    const raw = (await readJson(bucket, HEALTH_STATE_KEY)) as Partial<HealthState> | null;
    if (!raw) return EMPTY_STATE;
    const failures: Record<string, number> = {};
    if (raw.failures && typeof raw.failures === 'object') {
      for (const [k, v] of Object.entries(raw.failures)) if (typeof v === 'number') failures[k] = v;
    }
    return {
      failures,
      announced: Array.isArray(raw.announced)
        ? raw.announced.filter((x): x is string => typeof x === 'string')
        : [],
      lastSentAt: typeof raw.lastSentAt === 'number' ? raw.lastSentAt : 0,
      cronMissingSince: typeof raw.cronMissingSince === 'number' ? raw.cronMissingSince : null,
    };
  } catch (e) {
    // Fail open: a lost state means an email too many, never none.
    console.error(`[health] state unreadable: ${errorName(e)}`);
    return EMPTY_STATE;
  }
};

const writeState = async (bucket: R2Bucket, state: HealthState): Promise<void> => {
  try {
    await bucket.put(HEALTH_STATE_KEY, JSON.stringify(state), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (e) {
    console.error(`[health] state not saved: ${errorName(e)}`);
  }
};

const siteHost = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export const alertEmail = (
  host: string,
  plan: AlertPlan,
  results: CheckResult[],
  failures: Record<string, number>,
  now: number,
): { subject: string; text: string } => {
  const detailOf = (name: string) => results.find((r) => r.name === name)?.detail ?? '';
  const subject =
    plan.down.length > 0
      ? `[panote] ${host} DOWN (${plan.down.length}): ${plan.down.join(', ')}`
      : `[panote] ${host} recovered: all checks pass`;
  const lines = [`Health check of ${host} at ${new Date(now).toISOString()}.`, ''];
  if (plan.down.length > 0) {
    lines.push('Down:');
    for (const name of plan.down) {
      const isNew = plan.newlyDown.includes(name) ? '' : ' (already reported)';
      lines.push(`- ${name}: ${detailOf(name)}, ${failures[name] ?? 0} checks in a row${isNew}`);
    }
    lines.push('');
  }
  if (plan.recovered.length > 0) {
    lines.push('Recovered:', ...plan.recovered.map((name) => `- ${name}`), '');
  }
  if (plan.down.length === 0) lines.push('Every check passes.', '');
  lines.push(
    `Checks run every 5 minutes from panote-tiler-consumer. A check is down after`,
    `${FAILURES_TO_ALERT} failures in a row. An email goes out when the set of down checks`,
    `changes, at most one per ${ALERT_THROTTLE_MS / 60_000} minutes. Logs: filter on "[health]".`,
    'This runs inside Cloudflare, so it cannot see a Cloudflare-wide outage.',
  );
  return { subject, text: lines.join('\n') };
};

const sendAlert = async (env: Env, subject: string, text: string): Promise<boolean> => {
  const to = env.ALERT_EMAIL_TO;
  if (!to || !env.ALERT_EMAIL || !env.ALERT_EMAIL_FROM) {
    console.warn(
      '[health] skip alert: ALERT_EMAIL_TO, ALERT_EMAIL_FROM or the ALERT_EMAIL binding is not set',
    );
    return false;
  }
  try {
    const result = await env.ALERT_EMAIL.send({ to, from: env.ALERT_EMAIL_FROM, subject, text });
    const messageId = result && typeof result.messageId === 'string' ? result.messageId : 'unknown';
    console.warn(`[health] alert sent messageId=${messageId}`);
    return true;
  } catch (e) {
    // code and name only: the error message may echo the recipient address.
    const { code, name } = (e ?? {}) as { code?: unknown; name?: unknown };
    console.error(
      `[health] failed to send alert: code=${typeof code === 'string' ? code : 'unknown'} name=${typeof name === 'string' ? name : 'unknown'}`,
    );
    return false;
  }
};

/** One run of the health check, from the Cron Trigger. Never throws. */
export const runHealthCheck = async (
  env: Env,
  now: number,
  publicFetch: typeof fetch = fetch,
): Promise<CheckResult[]> => {
  try {
    const state = await readState(env.BUCKET);
    const [probeResults, cron, purge] = await Promise.all([
      Promise.all(buildProbes(env, publicFetch).map((p) => runProbe(p))),
      checkCron(env.BUCKET, state, now),
      checkPurge(env.BUCKET, now),
    ]);
    const results = [...probeResults, cron.result, purge];
    for (const r of results) {
      if (!r.ok) console.error(`[health] check failed check=${r.name} detail=${r.detail}`);
    }
    const decision = decide({ ...state, cronMissingSince: cron.cronMissingSince }, results, now);
    let next = decision.state;
    if (decision.throttled) {
      console.warn('[health] alert throttled: the down checks changed inside the window');
    }
    if (decision.alert) {
      const { subject, text } = alertEmail(
        siteHost(env.HEALTH_SITE_ORIGIN),
        decision.alert,
        results,
        next.failures,
        now,
      );
      if (await sendAlert(env, subject, text)) {
        next = { ...next, announced: decision.alert.down, lastSentAt: now };
      }
    }
    // Most runs change nothing: skip the write then.
    if (JSON.stringify(next) !== JSON.stringify(state)) await writeState(env.BUCKET, next);
    return results;
  } catch (e) {
    console.error(`[health] run failed: ${errorName(e)}`);
    return [];
  }
};
