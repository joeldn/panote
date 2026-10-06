import type { Manifest, PanoStatus, TilingStatus } from '@internal/contracts';

import type { UploadUrlOk } from './api/upload.js';
import { isAuthError } from './auth.js';

/** Processing gives up (timed-out, with retry) this long after the PUT completes. */
export const PROCESSING_TIMEOUT_MS = 10 * 60_000;
/** How often the pano status route is checked for `tiling: 'failed'`. */
export const STATUS_POLL_MS = 15_000;
export const MANIFEST_POLL_INITIAL_MS = 1_000;
export const MANIFEST_POLL_MAX_MS = 5_000;
const MANIFEST_POLL_FACTOR = 1.5;

/**
 * `fresh`: any manifest means ready. `replace`: ready only once the manifest's
 * version differs from the one captured before the presign (null = none existed).
 */
export type UploadMode = { kind: 'fresh' } | { kind: 'replace'; baselineVersion: string | null };

/** `auth`: the session expired (a 401 or a dead refresh token); sign in, then resume. */
export type UploadFailureStage = 'prepare' | 'presign' | 'upload' | 'tiling' | 'auth';

export type UploadState =
  | { phase: 'preparing'; mode: UploadMode | null }
  | {
      phase: 'upload';
      mode: UploadMode;
      panoId: string;
      loaded: number;
      total: number;
      pct: number;
    }
  | { phase: 'processing'; mode: UploadMode; panoId: string; startedAt: number }
  | { phase: 'ready'; panoId: string; manifest: Manifest }
  | {
      phase: 'failed';
      panoId: string | null;
      stage: UploadFailureStage;
      message: string;
      /** Set when the image already landed: `retryPoll()` resumes polling with this mode. */
      resumable?: UploadMode;
    }
  | { phase: 'timed-out'; mode: UploadMode; panoId: string }
  | { phase: 'cancelled'; panoId: string | null };

export type UploadPhase = UploadState['phase'];

export type UploadEvent =
  | { type: 'baseline'; mode: UploadMode }
  | { type: 'presigned'; panoId: string; total: number }
  | { type: 'resumed'; panoId: string; mode: UploadMode; at: number }
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'uploaded'; at: number }
  | { type: 'manifest'; manifest: Manifest | null; at: number }
  | { type: 'status'; tiling: TilingStatus; at: number }
  | { type: 'tick'; at: number }
  | { type: 'retry-poll'; at: number }
  | { type: 'error'; stage: Exclude<UploadFailureStage, 'tiling'>; message: string }
  | { type: 'auth-required'; message: string }
  | { type: 'cancel' };

export const initialUploadState = (): UploadState => ({ phase: 'preparing', mode: null });

/** `timed-out` and a resumable `failed` (auth) are not terminal: `retryPoll()` resumes them. */
export const isTerminal = (s: UploadState): boolean =>
  s.phase === 'ready' || s.phase === 'cancelled' || (s.phase === 'failed' && !s.resumable);

/** Whether `retryPoll()` can pick this state back up. */
export const canRetryPoll = (s: UploadState): boolean =>
  s.phase === 'timed-out' || (s.phase === 'failed' && s.resumable !== undefined);

const panoIdOf = (s: UploadState): string | null => ('panoId' in s ? s.panoId : null);

// An unversioned manifest (pre-versioning tiler output) compares as ''.
const versionOf = (m: Manifest): string => m.version ?? '';

export function isReadyManifest(mode: UploadMode, manifest: Manifest | null): manifest is Manifest {
  if (!manifest) return false;
  if (mode.kind === 'fresh') return true;
  return mode.baselineVersion === null || versionOf(manifest) !== mode.baselineVersion;
}

const pctOf = (loaded: number, total: number): number =>
  total > 0 ? Math.max(0, Math.min(100, Math.floor((loaded / total) * 100))) : 0;

/**
 * Pure phase computation. Every transition comes from an event carrying its own
 * timestamp, so nothing depends on requestAnimationFrame or on how often it runs.
 */
export function uploadReducer(state: UploadState, event: UploadEvent): UploadState {
  if (event.type === 'cancel') {
    return isTerminal(state) ? state : { phase: 'cancelled', panoId: panoIdOf(state) };
  }
  if (event.type === 'error') {
    // Errors only come from the steps before the image lands.
    if (state.phase !== 'preparing' && state.phase !== 'upload') return state;
    return { phase: 'failed', panoId: panoIdOf(state), stage: event.stage, message: event.message };
  }
  switch (state.phase) {
    case 'preparing':
      if (event.type === 'baseline') return { phase: 'preparing', mode: event.mode };
      if (event.type === 'resumed') {
        return { phase: 'processing', mode: event.mode, panoId: event.panoId, startedAt: event.at };
      }
      if (event.type === 'presigned') {
        return {
          phase: 'upload',
          mode: state.mode ?? { kind: 'fresh' },
          panoId: event.panoId,
          loaded: 0,
          total: event.total,
          pct: 0,
        };
      }
      return state;
    case 'upload':
      if (event.type === 'progress') {
        // Progress never moves backwards, even if events arrive out of order.
        const loaded = Math.max(state.loaded, Math.min(event.loaded, event.total));
        const pct = Math.max(state.pct, pctOf(loaded, event.total));
        if (loaded === state.loaded && pct === state.pct && event.total === state.total)
          return state;
        return { ...state, loaded, total: event.total, pct };
      }
      if (event.type === 'uploaded') {
        return { phase: 'processing', mode: state.mode, panoId: state.panoId, startedAt: event.at };
      }
      return state;
    case 'processing': {
      if (event.type === 'manifest' && isReadyManifest(state.mode, event.manifest)) {
        return { phase: 'ready', panoId: state.panoId, manifest: event.manifest };
      }
      if (event.type === 'status' && event.tiling === 'failed') {
        return {
          phase: 'failed',
          panoId: state.panoId,
          stage: 'tiling',
          message: 'Tiling failed for this image.',
        };
      }
      if (event.type === 'auth-required') {
        return {
          phase: 'failed',
          panoId: state.panoId,
          stage: 'auth',
          message: event.message,
          resumable: state.mode,
        };
      }
      if (
        (event.type === 'manifest' || event.type === 'status' || event.type === 'tick') &&
        event.at - state.startedAt >= PROCESSING_TIMEOUT_MS
      ) {
        return { phase: 'timed-out', mode: state.mode, panoId: state.panoId };
      }
      return state;
    }
    case 'timed-out':
      if (event.type === 'retry-poll') {
        return { phase: 'processing', mode: state.mode, panoId: state.panoId, startedAt: event.at };
      }
      return state;
    case 'failed':
      if (event.type === 'retry-poll' && state.resumable && state.panoId !== null) {
        const { resumable: mode, panoId } = state;
        return { phase: 'processing', mode, panoId, startedAt: event.at };
      }
      return state;
    default:
      return state;
  }
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface UploadDeps {
  presign(req: { contentType: string; size: number; panoId?: string }): Promise<UploadUrlOk>;
  put(
    url: string,
    file: Blob,
    opts: {
      contentType: string;
      onProgress: (loaded: number, total: number) => void;
      signal: AbortSignal;
    },
  ): Promise<void>;
  fetchManifest(panoId: string, opts: { signal: AbortSignal }): Promise<Manifest | null>;
  getPanoStatus(panoId: string): Promise<Pick<PanoStatus, 'tiling'>>;
  timers?: Timers;
}

export interface UploadFileSource {
  file: Blob;
  /** Defaults to `file.type`. */
  contentType?: string;
  /** Replace this pano's image instead of creating a new pano. */
  replacePanoId?: string;
}

/** An image that already landed (e.g. before a sign-in redirect): only poll for readiness. */
export interface UploadResumeSource {
  resume: { panoId: string; mode: UploadMode };
}

export type StartUploadOptions = (UploadFileSource | UploadResumeSource) & {
  onChange?: (state: UploadState) => void;
};

export interface UploadController {
  getState(): UploadState;
  /** From `timed-out`, or `failed` at stage `auth` after re-auth: poll again for a full window. */
  retryPoll(): void;
  /** Poll right away, e.g. when a backgrounded tab (with throttled timers) is shown again. */
  pollNow(): void;
  cancel(): void;
  /** Settles with the terminal state: ready, failed or cancelled. */
  readonly settled: Promise<UploadState>;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Presign, PUT with progress, then poll the manifest (backoff 1s→5s) and the
 * pano status (every 15s). Driven by XHR events and timers only, never rAF.
 */
export function startUpload(deps: UploadDeps, opts: StartUploadOptions): UploadController {
  const timers = deps.timers ?? defaultTimers;
  const abort = new AbortController();
  let state = initialUploadState();
  // A function, not `state.phase`: TS would keep a narrowing across dispatch().
  const phase = (): UploadPhase => state.phase;
  let pollAbort = new AbortController();
  const handles = new Set<unknown>();
  // Set while polling: runs both polls now instead of at their next scheduled slot.
  let kickPolls: (() => void) | null = null;
  let resolveSettled!: (s: UploadState) => void;
  const settled = new Promise<UploadState>((r) => (resolveSettled = r));

  const dispatch = (event: UploadEvent): void => {
    const next = uploadReducer(state, event);
    if (next === state) return;
    const wasPolling = state.phase === 'processing';
    state = next;
    if (wasPolling && state.phase !== 'processing') stopPolling();
    if (isTerminal(state)) abort.abort();
    opts.onChange?.(state);
    if (isTerminal(state)) resolveSettled(state);
  };

  const later = (fn: () => void, ms: number): unknown => {
    const h = timers.setTimeout(() => {
      handles.delete(h);
      fn();
    }, ms);
    handles.add(h);
    return h;
  };

  function stopPolling(): void {
    for (const h of handles) timers.clearTimeout(h);
    handles.clear();
    pollAbort.abort();
    kickPolls = null;
  }

  function startPolling(): void {
    pollAbort = new AbortController();
    const signal = pollAbort.signal;
    const panoId = (state as Extract<UploadState, { phase: 'processing' }>).panoId;
    let delay = MANIFEST_POLL_INITIAL_MS;
    let manifestTimer: unknown = null;
    let manifestInFlight = false;

    const pollManifest = async (): Promise<void> => {
      if (signal.aborted) return;
      manifestTimer = null;
      manifestInFlight = true;
      try {
        const manifest = await deps.fetchManifest(panoId, { signal });
        if (signal.aborted) return;
        dispatch({ type: 'manifest', manifest, at: timers.now() });
      } catch {
        if (signal.aborted) return;
        // A failed poll is not a failed upload; the timeout bounds retries.
        dispatch({ type: 'tick', at: timers.now() });
      } finally {
        manifestInFlight = false;
      }
      if (signal.aborted || phase() !== 'processing') return;
      delay = Math.min(MANIFEST_POLL_MAX_MS, delay * MANIFEST_POLL_FACTOR);
      manifestTimer = later(() => void pollManifest(), delay);
    };

    let statusTimer: unknown = null;
    let statusInFlight = false;

    const pollStatus = async (): Promise<void> => {
      if (signal.aborted) return;
      statusTimer = null;
      statusInFlight = true;
      try {
        const { tiling } = await deps.getPanoStatus(panoId);
        if (signal.aborted) return;
        dispatch({ type: 'status', tiling, at: timers.now() });
      } catch (e) {
        if (signal.aborted) return;
        // Polling can't continue without a session; the image itself is safe.
        if (isAuthError(e)) dispatch({ type: 'auth-required', message: messageOf(e) });
        else dispatch({ type: 'tick', at: timers.now() });
      } finally {
        statusInFlight = false;
      }
      if (signal.aborted || phase() !== 'processing') return;
      statusTimer = later(() => void pollStatus(), STATUS_POLL_MS);
    };

    const cancelTimer = (h: unknown): void => {
      if (h === null) return;
      timers.clearTimeout(h);
      handles.delete(h);
    };
    kickPolls = () => {
      if (signal.aborted) return;
      if (!manifestInFlight) {
        cancelTimer(manifestTimer);
        void pollManifest();
      }
      if (!statusInFlight) {
        cancelTimer(statusTimer);
        void pollStatus();
      }
    };

    manifestTimer = later(() => void pollManifest(), MANIFEST_POLL_INITIAL_MS);
    statusTimer = later(() => void pollStatus(), STATUS_POLL_MS);
    // Fires even if a poll request hangs; the reducer compares timestamps.
    later(() => dispatch({ type: 'tick', at: timers.now() }), PROCESSING_TIMEOUT_MS);
  }

  const run = async (): Promise<void> => {
    if ('resume' in opts) {
      dispatch({ type: 'resumed', ...opts.resume, at: timers.now() });
      if (phase() === 'processing') startPolling();
      return;
    }
    const contentType = opts.contentType ?? opts.file.type;
    if (opts.replacePanoId !== undefined) {
      let current: Manifest | null;
      try {
        current = await deps.fetchManifest(opts.replacePanoId, { signal: abort.signal });
      } catch (e) {
        dispatch({ type: 'error', stage: 'prepare', message: messageOf(e) });
        return;
      }
      const baselineVersion = current ? versionOf(current) : null;
      dispatch({ type: 'baseline', mode: { kind: 'replace', baselineVersion } });
    }
    if (phase() !== 'preparing') return;

    let presigned: UploadUrlOk;
    try {
      const req: { contentType: string; size: number; panoId?: string } = {
        contentType,
        size: opts.file.size,
      };
      if (opts.replacePanoId !== undefined) req.panoId = opts.replacePanoId;
      presigned = await deps.presign(req);
    } catch (e) {
      dispatch({
        type: 'error',
        stage: isAuthError(e) ? 'auth' : 'presign',
        message: messageOf(e),
      });
      return;
    }
    if (phase() !== 'preparing') return;
    dispatch({ type: 'presigned', panoId: presigned.panoId, total: opts.file.size });

    try {
      await deps.put(presigned.url, opts.file, {
        contentType,
        signal: abort.signal,
        onProgress: (loaded, total) => dispatch({ type: 'progress', loaded, total }),
      });
    } catch (e) {
      dispatch({ type: 'error', stage: 'upload', message: messageOf(e) });
      return;
    }
    dispatch({ type: 'uploaded', at: timers.now() });
    if (phase() === 'processing') startPolling();
  };

  opts.onChange?.(state);
  void run();

  return {
    getState: () => state,
    retryPoll: () => {
      if (!canRetryPoll(state)) return;
      dispatch({ type: 'retry-poll', at: timers.now() });
      if (phase() === 'processing') startPolling();
    },
    pollNow: () => {
      if (phase() !== 'processing') return;
      // A throttled timeout timer may be late; the reducer compares timestamps.
      dispatch({ type: 'tick', at: timers.now() });
      kickPolls?.();
    },
    cancel: () => {
      stopPolling();
      dispatch({ type: 'cancel' });
    },
    settled,
  };
}
