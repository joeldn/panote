import type { MarkerOutcome } from './failure-marker.js';

export interface DeadLetteredItem {
  // null when the message carried no object.key
  key: string | null;
  messageId: string;
  marker: MarkerOutcome | 'none';
}

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
    await env.ALERT_EMAIL.send({
      to,
      from: env.ALERT_EMAIL_FROM,
      subject: `[panote] tiling failed permanently (${items.length}) - ${queue}`,
      text,
    });
  } catch (e) {
    // code and name only: the error message may echo the recipient address.
    const { code, name } = (e ?? {}) as { code?: unknown; name?: unknown };
    console.error(
      `failed to send DLQ alert for ${queue}: code=${typeof code === 'string' ? code : 'unknown'} name=${typeof name === 'string' ? name : 'unknown'}`,
    );
  }
};
