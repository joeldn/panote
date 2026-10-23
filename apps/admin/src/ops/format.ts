import type { OpsUsage } from '@internal/contracts';

import { formatBytes } from '../dashboard/format.js';

const nf = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

/** 512 B, 4 KB, 340 MB, 1.5 GB: binary units like the account page, down to bytes. */
export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return formatBytes(bytes);
};

/** 1,234,567: exact, for an operator reading counts. */
export const formatNumber = (n: number): string => nf.format(n);

/** "0.8%", "—" with nothing to divide by. */
export const formatPercent = (part: number, whole: number): string =>
  whole > 0 ? `${Number(((part / whole) * 100).toFixed(1))}%` : '—';

/** 0.4 ms, 12 ms, 1.6 s, 4.2 min. */
export const formatMs = (ms: number): string => {
  if (ms < 10) return `${Number(ms.toFixed(1))} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))} s`;
  return `${Number((ms / 60_000).toFixed(1))} min`;
};

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 23, 09:41" in UTC: the dashboard's times are all UTC, as its series are. */
export const formatTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/** A series point: "09:00" for an hour, "Oct 20" for a day (UTC). */
export const formatPoint = (iso: string, step: 'hour' | 'day'): string => {
  const d = new Date(iso);
  return step === 'hour'
    ? `${pad(d.getUTCHours())}:00`
    : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

/** A usage amount in its unit: counts, bytes, CPU minutes, memory GiB-hours. */
export const formatUsage = (n: number, unit: OpsUsage['items'][number]['unit']): string => {
  switch (unit) {
    // Decimal, as Cloudflare bills storage: the allowance reads "10 GB".
    case 'bytes':
      return n < 1e9 ? `${formatNumber(n / 1e6)} MB` : `${Number((n / 1e9).toFixed(2))} GB`;
    case 'seconds':
      return n < 120 ? `${Number(n.toFixed(1))} s` : `${formatNumber(n / 60)} min`;
    case 'byte-seconds':
      return `${Number((n / 2 ** 30 / 3600).toFixed(1))} GiB-h`;
    default:
      return formatNumber(n);
  }
};

// The backup runs daily, so 1 day ago is on time and more means runs have failed. No
// recent complete set is an alarm once it has run before; before that it's a new env.
export const backupTone = (
  daysAgo: number | null,
  hasRun: boolean,
): 'ok' | 'warn' | 'bad' | 'none' =>
  daysAgo === null
    ? hasRun
      ? 'bad'
      : 'none'
    : daysAgo <= 1
      ? 'ok'
      : daysAgo === 2
        ? 'warn'
        : 'bad';
