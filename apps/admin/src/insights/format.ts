/** Average dwell as on the design's card: 45s, 2m 14s, 1h 5m. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A `YYYY-MM-DD` UTC day as "18 Sep"; parsed as text so no time zone can shift it. */
export function formatDay(date: string): string {
  const [, month = 1, day = 1] = date.split('-').map(Number);
  return `${day} ${MONTHS[month - 1] ?? ''}`;
}
