import type { MarkerOutcome } from './failure-marker.js';

export interface DeadLetteredItem {
  // null when the message carried no object.key
  key: string | null;
  messageId: string;
  marker: MarkerOutcome | 'none';
}

// The full key stays in the email on purpose, unlike the log lines. The
// email goes to one operator address held as a secret, not to shared logs,
// and the re-tile procedure (docs/deploy.md) needs the whole
// panos/<owner>/<panoId>/original key, with no quick way back from a
// panoId to its owner.
const itemLine = (item: DeadLetteredItem): string =>
  item.key === null
    ? `- <no object.key> (message ${item.messageId})`
    : `- ${item.key} (marker: ${item.marker})`;

/** At most one DLQ alert email per queue in this window; the rest are counted. */
export const ALERT_THROTTLE_MS = 30 * 60 * 1000;

// Throttle state lives in the content bucket under ops/, a prefix the CDN's WAF
// rule never serves and no R2 notification watches. One object per queue; the
// DLQ consumer runs with max_concurrency 1, so read-then-write doesn't race.
export const alertThrottleKey = (queue: string): string => `ops/dlq-alert/${queue}.json`;

export interface AlertThrottleState {
  // ms since the epoch of the last email that went out; 0 if none has yet.
  lastSentAt: number;
  // dead-lettered items since then that no email has listed.
  held: number;
}

// Name only, like the send failure below: a message could carry anything.
const errorName = (e: unknown): string =>
  e instanceof Error ? e.name : typeof e === 'string' ? 'string' : 'unknown';

const readThrottle = async (bucket: R2Bucket, queue: string): Promise<AlertThrottleState> => {
  const none = { lastSentAt: 0, held: 0 };
  try {
    const obj = await bucket.get(alertThrottleKey(queue));
    if (!obj) return none;
    const { lastSentAt, held } = (await obj.json()) as Partial<AlertThrottleState>;
    return {
      lastSentAt: typeof lastSentAt === 'number' ? lastSentAt : 0,
      held: typeof held === 'number' ? held : 0,
    };
  } catch (e) {
    // Fail open: an unreadable state means an email too many, never none.
    console.error(`DLQ alert throttle unreadable for ${queue}: ${errorName(e)}`);
    return none;
  }
};

const writeThrottle = async (
  bucket: R2Bucket,
  queue: string,
  state: AlertThrottleState,
): Promise<void> => {
  try {
    await bucket.put(alertThrottleKey(queue), JSON.stringify(state), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (e) {
    console.error(`DLQ alert throttle not saved for ${queue}: ${errorName(e)}`);
  }
};

// Sends the email; true once it went out. Never throws.
const send = async (
  env: Env,
  to: string,
  from: string,
  queue: string,
  items: DeadLetteredItem[],
  held: AlertThrottleState,
): Promise<boolean> => {
  try {
    const earlier =
      held.held > 0
        ? [
            '',
            `Plus ${held.held} earlier failure(s) not emailed${
              held.lastSentAt ? ` since ${new Date(held.lastSentAt).toISOString()}` : ''
            }:`,
            `alerts are throttled to one email per ${ALERT_THROTTLE_MS / 60_000} minutes. Their`,
            'keys are in the Worker logs (tile job dead-lettered) and their tile-failed markers.',
          ]
        : [];
    const text = [
      `${items.length} tile job(s) failed permanently and were dead-lettered.`,
      '',
      `Queue: ${queue}`,
      `Time (UTC): ${new Date().toISOString()}`,
      '',
      'Keys:',
      ...items.map(itemLine),
      ...earlier,
      '',
      'Marker: written = tile-failed marker stored; skipped = original gone, superseded or',
      'unparseable (see the Worker logs); failed = R2 errored checking or writing it.',
    ].join('\n');
    const count = held.held > 0 ? `${items.length} + ${held.held} earlier` : `${items.length}`;
    const result = await env.ALERT_EMAIL.send({
      to,
      from,
      subject: `[panote] tiling failed permanently (${count}) - ${queue}`,
      text,
    });
    const messageId = result && typeof result.messageId === 'string' ? result.messageId : 'unknown';
    // repo lint policy allows only warn/error console methods, so a success
    // note also goes through warn.
    console.warn(`DLQ alert sent for ${queue} messageId=${messageId}`);
    return true;
  } catch (e) {
    // code and name only: the error message may echo the recipient address.
    const { code, name } = (e ?? {}) as { code?: unknown; name?: unknown };
    console.error(
      `failed to send DLQ alert for ${queue}: code=${typeof code === 'string' ? code : 'unknown'} name=${typeof name === 'string' ? name : 'unknown'}`,
    );
    return false;
  }
};

// One email per DLQ batch, at most one per ALERT_THROTTLE_MS per queue; a
// throttled batch is counted and the next email says how many it left out. An
// email that fails to send counts as not sent, so its items carry over too.
// Never throws: alerting must not change ack behaviour, and the recipient
// address is never logged.
export const sendDlqAlert = async (
  env: Env,
  queue: string,
  items: DeadLetteredItem[],
): Promise<void> => {
  if (items.length === 0) return;
  try {
    const to = env.ALERT_EMAIL_TO;
    if (!to || !env.ALERT_EMAIL || !env.ALERT_EMAIL_FROM) {
      console.warn(
        `skip DLQ alert for ${queue}: ALERT_EMAIL_TO, ALERT_EMAIL_FROM or the ALERT_EMAIL binding is not set`,
      );
      return;
    }
    const state = await readThrottle(env.BUCKET, queue);
    const now = Date.now();
    // A lastSentAt in the future (a clock that jumped back, a hand-edited state)
    // counts as an expired window, or it would mute alerts until the clock caught up.
    const age = now - state.lastSentAt;
    if (state.lastSentAt && age >= 0 && age < ALERT_THROTTLE_MS) {
      const held = state.held + items.length;
      console.warn(
        `DLQ alert throttled for ${queue}: ${items.length} failure(s) held, ${held} since the last email`,
      );
      await writeThrottle(env.BUCKET, queue, { lastSentAt: state.lastSentAt, held });
      return;
    }
    const sent = await send(env, to, env.ALERT_EMAIL_FROM, queue, items, state);
    await writeThrottle(
      env.BUCKET,
      queue,
      sent
        ? { lastSentAt: now, held: 0 }
        : { lastSentAt: state.lastSentAt, held: state.held + items.length },
    );
  } catch (e) {
    console.error(`DLQ alert for ${queue} failed: ${errorName(e)}`);
  }
};

/**
 * Every 5 minutes (the health check's cron): emails the failures the throttle held back once
 * their window has passed, so they no longer wait for a later batch that may never come.
 * One GET per queue when nothing is held. Never throws. Unconfigured email sends nothing and
 * says nothing (sendDlqAlert already warns when a batch arrives). The DLQ consumer could write
 * the state between this read and write; at worst one failure is counted twice or once less.
 */
export const flushHeldDlqAlerts = async (
  env: Env,
  now: number,
  queues: Iterable<string>,
): Promise<void> => {
  const to = env.ALERT_EMAIL_TO;
  const from = env.ALERT_EMAIL_FROM;
  if (!to || !from || !env.ALERT_EMAIL) return;
  for (const queue of queues) {
    try {
      const state = await readThrottle(env.BUCKET, queue);
      const age = now - state.lastSentAt;
      // A lastSentAt ahead of this clock is skipped too: the DLQ batch path, which treats it
      // as an expired window, sends it with the next failure.
      if (state.held === 0 || (state.lastSentAt && age < ALERT_THROTTLE_MS)) continue;
      const since = state.lastSentAt ? ` since ${new Date(state.lastSentAt).toISOString()}` : '';
      const text = [
        `${state.held} tile job(s) failed permanently and were dead-lettered${since}, held back`,
        `by the alert throttle (one email per ${ALERT_THROTTLE_MS / 60_000} minutes) with no later`,
        'failure to carry them.',
        '',
        `Queue: ${queue}`,
        `Time (UTC): ${new Date(now).toISOString()}`,
        '',
        'Their keys are in the Worker logs (tile job dead-lettered) and their tile-failed markers.',
      ].join('\n');
      await env.ALERT_EMAIL.send({
        to,
        from,
        subject: `[panote] tiling failed permanently (${state.held} earlier) - ${queue}`,
        text,
      });
      console.warn(`DLQ alert sent for ${queue}: ${state.held} held failure(s)`);
      await writeThrottle(env.BUCKET, queue, { lastSentAt: now, held: 0 });
    } catch (e) {
      // The name only: the error message may echo the recipient address.
      console.error(`DLQ held alert for ${queue} failed: ${errorName(e)}`);
    }
  }
};
