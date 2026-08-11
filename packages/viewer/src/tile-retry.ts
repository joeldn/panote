/**
 * Tile fetch failure policy.
 *
 * Two independent mechanisms live here, both deliberately free of any DOM or
 * network dependency so they are unit-testable under plain Node:
 *
 *  - `TileRetryBudget` — per-tile, per-panorama-load. Answers "may this tile be
 *    fetched again yet?" from an attempt count and a per-tile cooldown.
 *  - `TileFailureMonitor` — process-wide. Watches transient failures across
 *    *panoramas*; when two or more distinct panoramas fail inside a recency
 *    window it trips an escalating global backoff that suppresses new fetches.
 *
 * `TileLayer` is rebuilt from scratch every time the viewer loads a panorama
 * (see PanoViewer.load()), so per-tile state is naturally scoped to one load,
 * while the monitor must outlive the layer to be able to observe that two
 * different panoramas are failing. Hence the module-level shared instance
 * below, injectable so tests never share state.
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
 * churn (the user panned away), not failures: they must neither consume a
 * retry attempt nor count towards the global backoff.
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
    private readonly now: () => number,
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

  clear(): void {
    this.attempts.clear();
    this.permanent.clear();
  }
}

/** Backoff ladder: 1s, 2s, 4s, 8s, 16s, then capped at 30s. */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;
/** How long a panorama stays "recently failing" for cross-panorama detection. */
export const DEFAULT_FAILURE_WINDOW_MS = 10_000;
/** Distinct panoramas that must be failing before the backoff trips. */
export const DEFAULT_MIN_PANOS = 2;

export interface TileFailureMonitorOptions {
  now?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  windowMs?: number;
  minPanos?: number;
}

/**
 * Permission to start one tile fetch, handed out by `TileFailureMonitor`.
 * `probe` marks the single fetch allowed through an active backoff window.
 */
export interface TileFetchPermit {
  readonly probe: boolean;
  settled: boolean;
}

/**
 * Process-wide watchdog for tile fetch failures.
 *
 * Failures inside one panorama mean bad tiles and are handled entirely by the
 * per-tile budget. Failures spanning two or more panoramas within `windowMs`
 * mean the network or the origin is unhealthy — no amount of per-tile retrying
 * will help, and continuing to fetch just adds load to something already
 * struggling. That is what trips the backoff.
 *
 * Escalation is per *trip*, not per failure: entering backoff uses the current
 * ladder rung and advances it, and further failures inside the same window do
 * not escalate again. A successful fetch resets the ladder to the bottom and
 * clears the window.
 *
 * While a window is active new fetches are suppressed, except for exactly one
 * probe, released halfway through the window. The probe is what makes recovery
 * cheap: a network that comes back 600 ms into a 16s window is noticed at the
 * 8s mark instead of the 16s mark, and a probe that fails is proof the outage
 * continues, so it escalates and re-arms the window immediately rather than
 * letting the rest of the window expire into another full-rate burst.
 */
export class TileFailureMonitor {
  private readonly clock: () => number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly windowMs: number;
  private readonly minPanos: number;

  /** pano id → timestamp of its most recent transient failure. */
  private readonly failingPanos = new Map<string, number>();
  private level = 0;
  private backoffUntil = 0;
  private probeAllowedAt = 0;
  private probeUsed = false;
  private probeInFlight = false;

  constructor(options: TileFailureMonitorOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.windowMs = options.windowMs ?? DEFAULT_FAILURE_WINDOW_MS;
    this.minPanos = options.minPanos ?? DEFAULT_MIN_PANOS;
  }

  /** The clock the monitor runs on — shared with per-tile cooldowns. */
  now(): number {
    return this.clock();
  }

  /** Escalation rung: 0 before the first trip, +1 per trip, reset by success. */
  get escalationLevel(): number {
    return this.level;
  }

  /** Milliseconds left in the active backoff window; 0 when not backing off. */
  backoffRemainingMs(): number {
    return Math.max(0, this.backoffUntil - this.now());
  }

  backingOff(): boolean {
    return this.now() < this.backoffUntil;
  }

  /** Non-consuming peek: would `acquire()` hand out a permit right now? */
  canStart(): boolean {
    const now = this.now();
    return now >= this.backoffUntil || this.probeReady(now);
  }

  /** Take permission to start one fetch, or null while suppressed. */
  acquire(): TileFetchPermit | null {
    const now = this.now();
    if (now >= this.backoffUntil) return { probe: false, settled: false };
    if (!this.probeReady(now)) return null;
    this.probeUsed = true;
    this.probeInFlight = true;
    return { probe: true, settled: false };
  }

  /** The fetch loaded: the origin is healthy, so drop all failure state. */
  succeed(permit: TileFetchPermit): void {
    if (this.settle(permit)) return;
    this.failingPanos.clear();
    this.level = 0;
    this.backoffUntil = 0;
    this.probeAllowedAt = 0;
    this.probeUsed = false;
    this.probeInFlight = false;
  }

  /** The fetch failed. Only transient failures are evidence of ill health. */
  fail(permit: TileFetchPermit, pano: string, kind: FailureKind): void {
    const wasProbe = permit.probe;
    if (this.settle(permit)) return;
    if (kind !== 'transient') return;
    const now = this.now();
    this.failingPanos.set(pano, now);
    for (const [id, at] of this.failingPanos) {
      if (now - at >= this.windowMs) this.failingPanos.delete(id);
    }
    // A failed probe is direct evidence the outage is ongoing — escalate now
    // instead of waiting for the rest of the window to expire.
    if (wasProbe) {
      this.trip(now, true);
      return;
    }
    if (this.failingPanos.size >= this.minPanos) this.trip(now, false);
  }

  /** Release a permit without recording an outcome (abort, disposal). */
  release(permit: TileFetchPermit): void {
    this.settle(permit);
  }

  /** Drop every scrap of state — used by tests and by shared-instance resets. */
  reset(): void {
    this.failingPanos.clear();
    this.level = 0;
    this.backoffUntil = 0;
    this.probeAllowedAt = 0;
    this.probeUsed = false;
    this.probeInFlight = false;
  }

  private probeReady(now: number): boolean {
    return !this.probeUsed && !this.probeInFlight && now >= this.probeAllowedAt;
  }

  /** Marks a permit spent. Returns true if it had already been settled. */
  private settle(permit: TileFetchPermit): boolean {
    if (permit.settled) return true;
    permit.settled = true;
    if (permit.probe) this.probeInFlight = false;
    return false;
  }

  private trip(now: number, force: boolean): void {
    if (!force && now < this.backoffUntil) return; // already inside a window
    const delay = Math.min(this.baseDelayMs * 2 ** this.level, this.maxDelayMs);
    // Bounded so a very long outage cannot inflate 2 ** level into Infinity.
    this.level = Math.min(this.level + 1, 32);
    this.backoffUntil = now + delay;
    this.probeAllowedAt = now + Math.floor(delay / 2);
    this.probeUsed = false;
    this.probeInFlight = false;
  }
}

let shared: TileFailureMonitor | undefined;

/**
 * The monitor every `TileLayer` uses unless one is injected. It is module
 * scoped on purpose: it is only able to notice that panorama A and panorama B
 * are both failing because it outlives the per-panorama layers.
 */
export function sharedTileFailureMonitor(): TileFailureMonitor {
  shared ??= new TileFailureMonitor();
  return shared;
}

/**
 * Replace (or, with no argument, discard) the shared monitor. Exported so
 * tests can guarantee no backoff state leaks between files.
 */
export function setSharedTileFailureMonitor(monitor?: TileFailureMonitor): void {
  shared = monitor;
}
