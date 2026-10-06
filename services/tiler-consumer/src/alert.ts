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

// One email per DLQ batch. Never throws: alerting must not change ack
// behaviour, and the recipient address is never logged.
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
    const text = [
      `${items.length} tile job(s) failed permanently and were dead-lettered.`,
      '',
      `Queue: ${queue}`,
      `Time (UTC): ${new Date().toISOString()}`,
      '',
      'Keys:',
      ...items.map(itemLine),
      '',
      'Marker: written = tile-failed marker stored; skipped = original gone, superseded or',
      'unparseable (see the Worker logs); failed = the marker write errored.',
    ].join('\n');
    const result = await env.ALERT_EMAIL.send({
      to,
      from: env.ALERT_EMAIL_FROM,
      subject: `[panote] tiling failed permanently (${items.length}) - ${queue}`,
      text,
    });
    const messageId = result && typeof result.messageId === 'string' ? result.messageId : 'unknown';
    // repo lint policy allows only warn/error console methods, so a success
    // note also goes through warn.
    console.warn(`DLQ alert sent for ${queue} messageId=${messageId}`);
  } catch (e) {
    // code and name only: the error message may echo the recipient address.
    const { code, name } = (e ?? {}) as { code?: unknown; name?: unknown };
    console.error(
      `failed to send DLQ alert for ${queue}: code=${typeof code === 'string' ? code : 'unknown'} name=${typeof name === 'string' ? name : 'unknown'}`,
    );
  }
};
