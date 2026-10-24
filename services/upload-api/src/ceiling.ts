import { LIMIT_ERRORS } from '@internal/contracts';
import { WorkerError } from '@internal/worker-kit';
import { DurableObject } from 'cloudflare:workers';

import { parseLimit } from './quota.js';

// The global daily ceiling: upload URLs and declared bytes issued per UTC day across
// every owner, counted by one UploadCeiling instance. The per-owner quotas (quota.ts)
// stop one account; this stops many accounts together, and is the kill switch: at the
// limit (or a limit of 0) every upload URL is refused until 00:00 UTC.

export interface CeilingEnv {
  /** Most upload URLs issued per UTC day across all owners, counting this one. */
  MAX_UPLOADS_PER_DAY_GLOBAL?: string | undefined;
  /** Most declared bytes of uploads issued per UTC day across all owners, counting this one. */
  MAX_UPLOAD_BYTES_PER_DAY_GLOBAL?: string | undefined;
}

export interface CeilingLimits {
  maxUploads: number | null;
  maxBytes: number | null;
}

export const ceilingLimits = (env: CeilingEnv): CeilingLimits => ({
  maxUploads: parseLimit('MAX_UPLOADS_PER_DAY_GLOBAL', env.MAX_UPLOADS_PER_DAY_GLOBAL),
  maxBytes: parseLimit('MAX_UPLOAD_BYTES_PER_DAY_GLOBAL', env.MAX_UPLOAD_BYTES_PER_DAY_GLOBAL),
});

/** The UTC day `now` falls in, as YYYY-MM-DD: the counter's key. */
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** Whole seconds from `now` to the next 00:00 UTC, when the counter starts again. */
export const secondsToNextDay = (now: number): number => {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
};

export interface DayCount {
  day: string;
  uploads: number;
  bytes: number;
  /** The first refusal of the day was logged. */
  warned: boolean;
}

/** What a reservation holds, so a URL that is never issued can give it back. */
export interface Held {
  day: string;
  bytes: number;
}

const COUNT_KEY = 'count';

// One instance (idFromName('global')): every reservation runs through it. Each method
// reads and writes through the synchronous SQLite-backed KV API, with no await at all,
// so a reservation is checked and counted in one uninterrupted step and parallel
// requests can't both take the last slot. (With the async get/put, concurrent calls
// interleaved between the read and the write and overshot the limit.)
export class UploadCeiling extends DurableObject<Env> {
  private current(day: string): DayCount {
    const stored = this.ctx.storage.kv.get<DayCount>(COUNT_KEY);
    // A new day starts from zero; the old day's count is simply overwritten.
    return stored?.day === day ? stored : { day, uploads: 0, bytes: 0, warned: false };
  }

  /**
   * Reserves one upload URL of `bytes` for the UTC day of `now`: counted at once if it
   * fits under both limits, else refused (and nothing counted). A null limit is no limit.
   */
  async reserve(bytes: number, limits: CeilingLimits, now: number): Promise<Held | null> {
    const day = utcDay(now);
    const c = this.current(day);
    const fits =
      (limits.maxUploads === null || c.uploads + 1 <= limits.maxUploads) &&
      (limits.maxBytes === null || c.bytes + bytes <= limits.maxBytes);
    if (!fits) {
      if (!c.warned) {
        // Once a day, so the logs show when the switch tripped without one line per refusal.
        console.warn(
          'upload ceiling reached: refusing uploads that would pass it until 00:00 UTC',
          {
            day,
            uploads: c.uploads,
            bytes: c.bytes,
            ...limits,
          },
        );
        this.ctx.storage.kv.put(COUNT_KEY, { ...c, warned: true });
      }
      return null;
    }
    this.ctx.storage.kv.put(COUNT_KEY, { ...c, uploads: c.uploads + 1, bytes: c.bytes + bytes });
    return { day, bytes };
  }

  /** Gives back a reservation whose URL was never issued. A past day's is dropped. */
  async release(held: Held): Promise<void> {
    const stored = this.ctx.storage.kv.get<DayCount>(COUNT_KEY);
    if (stored?.day !== held.day) return;
    this.ctx.storage.kv.put(COUNT_KEY, {
      ...stored,
      uploads: Math.max(0, stored.uploads - 1),
      bytes: Math.max(0, stored.bytes - held.bytes),
    });
  }

  /** Today's count, for tests and for an operator reading it with wrangler tail. */
  async count(now: number): Promise<DayCount> {
    return this.current(utcDay(now));
  }
}

const ceiling = (env: Env) => env.UPLOAD_CEILING.get(env.UPLOAD_CEILING.idFromName('global'));

// When the DO can't be reached: a blip fails open (the per-owner quotas still hold, so
// that is no worse than before the ceiling existed), but this many failures in a row in
// one isolate fail closed until a call gets through again. The count is per isolate and
// lost when the isolate goes, so during a lasting outage each new isolate still lets its
// first few requests through: it limits how far an outage lifts the ceiling, it doesn't
// close it.
export const CEILING_FAILURES_BEFORE_CLOSED = 3;
let failuresInARow = 0;

/**
 * One more upload URL of `size` bytes against the global daily ceiling: `'paused'` when
 * it is reached, else what was reserved (null when no limit is set or the DO was
 * unreachable and the call failed open). Throws a 502 once the DO keeps failing.
 */
export async function reserveCeiling(
  env: Env,
  size: number,
  now: number,
): Promise<Held | 'paused' | null> {
  const limits = ceilingLimits(env);
  if (limits.maxUploads === null && limits.maxBytes === null) return null;
  let held: Held | null;
  try {
    held = await ceiling(env).reserve(size, limits, now);
  } catch (e) {
    failuresInARow += 1;
    console.error('upload ceiling unreachable', { failuresInARow, error: String(e) });
    if (failuresInARow >= CEILING_FAILURES_BEFORE_CLOSED) {
      throw new WorkerError('storage unavailable', 502);
    }
    return null;
  }
  failuresInARow = 0;
  return held ?? 'paused';
}

/** Best-effort: gives a reservation back when its URL is not issued after all. */
export const releaseLater = (env: Env, held: Held | null, ctx: ExecutionContext): void => {
  if (held)
    ctx.waitUntil(
      ceiling(env)
        .release(held)
        .catch(() => undefined),
    );
};

/** The 503 every upload URL gets while the ceiling is reached, until 00:00 UTC. */
export const pausedResponse = (now: number): Response =>
  Response.json(
    { error: LIMIT_ERRORS.paused },
    { status: 503, headers: { 'Retry-After': String(secondsToNextDay(now)) } },
  );
