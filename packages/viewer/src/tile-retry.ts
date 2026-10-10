/**
 * Tile fetch failure policy, free of any DOM or network dependency so it is
 * unit-testable under plain Node.
 *
 * `TileRetryBudget` is per tile and per panorama load: it answers "may this
 * tile be fetched again yet?" from an attempt count and a per-tile cooldown.
 * `TileLayer` is rebuilt for every load (see PanoViewer.load()), so the budget
 * is scoped to one load. The attempt cap is what bounds the traffic during an
 * outage: at most visible × attempts requests per load.
 */

/** How a failed tile fetch should be treated. */
export type FailureKind = 'transient' | 'permanent';

/** Thrown by the tile loader when a tile response status is not ok. */
export class TileHttpError extends Error {
  constructor(readonly status: number) {
    super(`tile ${status}`);
    this.name = 'TileHttpError';
  }
}

/**
 * True for the abort a cancelled in-flight load produces. Aborts are ordinary
 * churn (the user panned away), not failures: they must not consume a retry
 * attempt.
 *
 * DOMException extends Error, so the `Error` check covers both the DOM's
 * AbortError and any host that rejects with a plain named Error instead.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Classify an HTTP status.
 *
 * Transient — worth another request, because the same URL can plausibly
 * succeed later: 408 (request timeout), 425 (too early), 429 (rate limited)
 * and every 5xx.
 *
 * Permanent — everything else, which is every remaining 4xx:
 *  - 404/410: the tile does not exist. Retrying can only ever produce another
 *    404, so a retry loop would hammer the origin (and burn R2 Class B
 *    operations) forever for a hole that will never fill. The coarser parent
 *    tile already painted underneath is the fallback.
 *  - 401/403: the request is unauthenticated or forbidden. Nothing in the
 *    viewer refreshes a credential between attempts, so re-issuing the
 *    identical request is guaranteed to produce the identical status — it is
 *    exactly as wasteful as retrying a 404. Recovery happens by loading the
 *    panorama again (with a fresh credential), which builds a new TileLayer
 *    and therefore a clean retry budget.
 */
export function classifyStatus(status: number): FailureKind {
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'transient';
  return 'permanent';
}

/**
 * Classify a rejection from the tile load path. Anything that is not a status
 * we decided is permanent is treated as transient: a `TypeError` from fetch (a
 * dropped connection, DNS failure, offline), a timeout, or a decode failure on
 * a truncated body. Those are the cases a retry is for, and the per-tile
 * attempt cap bounds the cost when the guess is wrong (e.g. a genuinely
 * corrupt tile, which costs a small fixed number of requests and then stops).
 */
export function classifyFailure(err: unknown): FailureKind {
  if (err instanceof TileHttpError) return classifyStatus(err.status);
  return 'transient';
}

/** Total attempts allowed per tile per panorama load (1 initial + 2 retries). */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** First per-tile cooldown; doubles per attempt (1s, then 2s). */
export const DEFAULT_TILE_DELAY_MS = 1_000;

export interface TileRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
}

interface AttemptRecord {
  count: number;
  nextAt: number;
}

/**
 * Per-tile retry accounting for a single panorama load.
 *
 * Replaces the old permanent `failed` set. A tile that fails transiently stays
 * eligible until it has used its attempt budget; a tile that fails permanently
 * is never fetched again for this load.
 *
 * The per-tile cooldown matters as much as the cap does: `update()` rebuilds
 * the candidate list every frame, so without it a tile that is still on screen
 * would burn its whole budget within three frames (~50 ms) of a blip — no
 * better in practice than the blacklist it replaces. Spacing attempts by 1s
 * then 2s means a tile only exhausts its budget after ~3s of sustained
 * failure, and a pan back seconds later still finds attempts left.
 */
export class TileRetryBudget {
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly permanent = new Set<string>();
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(
    private readonly now: () => number = () => performance.now(),
    options: TileRetryOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_TILE_DELAY_MS;
  }

  /** May this tile be (re)queued right now? */
  eligible(key: string): boolean {
    if (this.permanent.has(key)) return false;
    const record = this.attempts.get(key);
    if (!record) return true;
    if (record.count >= this.maxAttempts) return false;
    return this.now() >= record.nextAt;
  }

  recordFailure(key: string, kind: FailureKind): void {
    if (kind === 'permanent') {
      this.permanent.add(key);
      this.attempts.delete(key);
      return;
    }
    const record = this.attempts.get(key) ?? { count: 0, nextAt: 0 };
    record.count += 1;
    record.nextAt = this.now() + this.baseDelayMs * 2 ** (record.count - 1);
    this.attempts.set(key, record);
  }

  /** A tile that loaded gets its history dropped — it is in the cache now. */
  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  /** Attempts spent on a tile so far (0 when it has never failed). */
  attemptsFor(key: string): number {
    return this.attempts.get(key)?.count ?? 0;
  }

  /**
   * How long until this tile may be fetched again: 0 when it may go now,
   * `Infinity` when it never may again (permanent status, or the attempt cap
   * is spent).
   *
   * `eligible()` answers the same question as a boolean, which is all the
   * per-frame path needs — it simply skips the tile and asks again next frame.
   * The base-layer load has no next frame to fall back on: it must *wait* the
   * cooldown out before its next attempt, and must be able to tell "not yet"
   * from "never" so it can fail the panorama load immediately on a 404 instead
   * of sleeping through a budget that will never allow another request.
   */
  waitMs(key: string): number {
    if (this.permanent.has(key)) return Infinity;
    const record = this.attempts.get(key);
    if (!record) return 0;
    if (record.count >= this.maxAttempts) return Infinity;
    return Math.max(0, record.nextAt - this.now());
  }

  clear(): void {
    this.attempts.clear();
    this.permanent.clear();
  }
}
