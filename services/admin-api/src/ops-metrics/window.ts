import type { OpsRange } from '@internal/contracts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface OpsWindow {
  range: OpsRange;
  from: Date;
  to: Date;
  /** The series' buckets, oldest first: hours for 24h, UTC days for 7d. */
  step: 'hour' | 'day';
  points: string[];
  /** 00:00 UTC on the 1st of `to`'s month, for the month-so-far usage. */
  monthStart: Date;
}

/** 24h: the current hour and the 23 before it. 7d: today (UTC) and the 6 days before. */
export const opsWindow = (range: OpsRange, now: Date): OpsWindow => {
  const t = now.getTime();
  const step = range === '24h' ? 'hour' : 'day';
  const size = step === 'hour' ? HOUR_MS : DAY_MS;
  const n = step === 'hour' ? 24 : 7;
  const last = Math.floor(t / size) * size;
  const from = new Date(last - (n - 1) * size);
  const points = Array.from({ length: n }, (_, i) =>
    new Date(from.getTime() + i * size).toISOString(),
  );
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { range, from, to: now, step, points, monthStart };
};

/** The series bucket a timestamp falls in (an ISO hour or day start). */
export const bucketOf = (w: Pick<OpsWindow, 'step'>, at: string | Date): string => {
  const t = new Date(at).getTime();
  const size = w.step === 'hour' ? HOUR_MS : DAY_MS;
  return new Date(Math.floor(t / size) * size).toISOString();
};

/** Zero-filled series over the window's points, from rows already keyed by bucket. */
export const fillSeries = <K extends string>(
  w: Pick<OpsWindow, 'points'>,
  sums: Map<string, Record<K, number>>,
  keys: readonly K[],
): ({ t: string } & Record<K, number>)[] =>
  w.points.map((t) => {
    const got = sums.get(t);
    const row = { t } as { t: string } & Record<K, number>;
    for (const k of keys) (row as Record<K, number>)[k] = got?.[k] ?? 0;
    return row;
  });

/** Adds `values` into the bucket `t` of `sums`. */
export const addTo = <K extends string>(
  sums: Map<string, Record<K, number>>,
  t: string,
  values: Record<K, number>,
): void => {
  const got = sums.get(t);
  if (!got) {
    sums.set(t, { ...values });
    return;
  }
  for (const k of Object.keys(values) as K[]) got[k] += values[k];
};
