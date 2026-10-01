import type { Manifest, TilingStatus } from '@internal/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { manifest } from './__fixtures__/helpers.js';
import { AuthRequiredError } from './auth.js';
import {
  canRetryPoll,
  initialUploadState,
  isTerminal,
  isReadyManifest,
  PROCESSING_TIMEOUT_MS,
  startUpload,
  STATUS_POLL_MS,
  uploadReducer,
  type UploadDeps,
  type UploadEvent,
  type UploadState,
} from './upload-machine.js';

const run = (events: UploadEvent[], from: UploadState = initialUploadState()): UploadState =>
  events.reduce(uploadReducer, from);

describe('uploadReducer', () => {
  const processing = (mode: Extract<UploadState, { phase: 'processing' }>['mode']) =>
    run([
      { type: 'baseline', mode },
      { type: 'presigned', panoId: 'p1', total: 100 },
      { type: 'uploaded', at: 1_000 },
    ]);

  it('goes preparing -> upload -> processing -> ready for a fresh upload', () => {
    const s = run([
      { type: 'presigned', panoId: 'p1', total: 200 },
      { type: 'progress', loaded: 50, total: 200 },
    ]);
    expect(s).toMatchObject({ phase: 'upload', panoId: 'p1', pct: 25, loaded: 50 });
    const p = uploadReducer(s, { type: 'uploaded', at: 5 });
    expect(p).toEqual({ phase: 'processing', mode: { kind: 'fresh' }, panoId: 'p1', startedAt: 5 });
    expect(uploadReducer(p, { type: 'manifest', manifest: null, at: 6 })).toBe(p);
    expect(uploadReducer(p, { type: 'manifest', manifest: manifest('t1-a'), at: 7 })).toMatchObject(
      { phase: 'ready', panoId: 'p1' },
    );
  });

  it('never moves the upload bar backwards', () => {
    const s = run([
      { type: 'presigned', panoId: 'p1', total: 100 },
      { type: 'progress', loaded: 80, total: 100 },
      { type: 'progress', loaded: 40, total: 100 },
    ]);
    expect(s).toMatchObject({ pct: 80, loaded: 80 });
  });

  it('clamps progress beyond total to 100%', () => {
    const s = run([
      { type: 'presigned', panoId: 'p1', total: 100 },
      { type: 'progress', loaded: 500, total: 100 },
    ]);
    expect(s).toMatchObject({ pct: 100, loaded: 100 });
  });

  it('replace-image: an unchanged manifest version is not ready', () => {
    const p = processing({ kind: 'replace', baselineVersion: 't1-old' });
    expect(uploadReducer(p, { type: 'manifest', manifest: manifest('t1-old'), at: 2_000 })).toBe(p);
    expect(
      uploadReducer(p, { type: 'manifest', manifest: manifest('t1-new'), at: 3_000 }),
    ).toMatchObject({ phase: 'ready', manifest: { version: 't1-new' } });
  });

  it('replace-image with no prior manifest is ready on the first manifest', () => {
    const p = processing({ kind: 'replace', baselineVersion: null });
    expect(
      uploadReducer(p, { type: 'manifest', manifest: manifest('t1-a'), at: 2_000 }),
    ).toMatchObject({ phase: 'ready' });
  });

  it('isReadyManifest treats an unversioned manifest as version ""', () => {
    expect(isReadyManifest({ kind: 'replace', baselineVersion: '' }, manifest())).toBe(false);
    expect(isReadyManifest({ kind: 'replace', baselineVersion: '' }, manifest('t1-x'))).toBe(true);
    expect(isReadyManifest({ kind: 'fresh' }, null)).toBe(false);
  });

  it('times out exactly 10 minutes after processing started, from event timestamps', () => {
    const p = processing({ kind: 'fresh' });
    const at = 1_000 + PROCESSING_TIMEOUT_MS;
    expect(uploadReducer(p, { type: 'tick', at: at - 1 })).toBe(p);
    expect(uploadReducer(p, { type: 'tick', at })).toMatchObject({
      phase: 'timed-out',
      panoId: 'p1',
    });
    expect(uploadReducer(p, { type: 'manifest', manifest: null, at })).toMatchObject({
      phase: 'timed-out',
    });
  });

  it('a ready manifest wins over the timeout on the same event', () => {
    const p = processing({ kind: 'fresh' });
    const s = uploadReducer(p, {
      type: 'manifest',
      manifest: manifest('t1-a'),
      at: 1_000 + PROCESSING_TIMEOUT_MS * 2,
    });
    expect(s.phase).toBe('ready');
  });

  it("fails on tiling 'failed' and ignores other statuses", () => {
    const p = processing({ kind: 'fresh' });
    for (const tiling of ['ready', 'pending', 'none'] as TilingStatus[]) {
      expect(uploadReducer(p, { type: 'status', tiling, at: 2_000 })).toBe(p);
    }
    expect(uploadReducer(p, { type: 'status', tiling: 'failed', at: 2_000 })).toMatchObject({
      phase: 'failed',
      stage: 'tiling',
      panoId: 'p1',
    });
  });

  it('auth-required during processing is a resumable failure', () => {
    const f = uploadReducer(processing({ kind: 'replace', baselineVersion: 'v1' }), {
      type: 'auth-required',
      message: 'sign-in required',
    });
    expect(f).toEqual({
      phase: 'failed',
      panoId: 'p1',
      stage: 'auth',
      message: 'sign-in required',
      resumable: { kind: 'replace', baselineVersion: 'v1' },
    });
    expect(isTerminal(f)).toBe(false);
    expect(canRetryPoll(f)).toBe(true);
    expect(uploadReducer(f, { type: 'error', stage: 'upload', message: 'x' })).toBe(f);
    expect(uploadReducer(f, { type: 'retry-poll', at: 42 })).toEqual({
      phase: 'processing',
      mode: { kind: 'replace', baselineVersion: 'v1' },
      panoId: 'p1',
      startedAt: 42,
    });
    const nonResumable = run([{ type: 'error', stage: 'auth', message: 'x' }]);
    expect(isTerminal(nonResumable)).toBe(true);
    expect(uploadReducer(nonResumable, { type: 'retry-poll', at: 1 })).toBe(nonResumable);
  });

  it('retry-poll restarts processing with a fresh timeout window', () => {
    const t = uploadReducer(processing({ kind: 'fresh' }), {
      type: 'tick',
      at: 1_000 + PROCESSING_TIMEOUT_MS,
    });
    const r = uploadReducer(t, { type: 'retry-poll', at: 9_999_999 });
    expect(r).toMatchObject({ phase: 'processing', startedAt: 9_999_999 });
  });

  it('records the failing stage for presign and upload errors', () => {
    expect(run([{ type: 'error', stage: 'presign', message: 'nope' }])).toEqual({
      phase: 'failed',
      panoId: null,
      stage: 'presign',
      message: 'nope',
    });
    expect(
      run([
        { type: 'presigned', panoId: 'p1', total: 1 },
        { type: 'error', stage: 'upload', message: 'net' },
      ]),
    ).toMatchObject({ phase: 'failed', panoId: 'p1', stage: 'upload' });
  });

  it('ignores events once terminal, and cancel keeps the panoId', () => {
    const ready = uploadReducer(processing({ kind: 'fresh' }), {
      type: 'manifest',
      manifest: manifest('v'),
      at: 2,
    });
    expect(uploadReducer(ready, { type: 'cancel' })).toBe(ready);
    expect(uploadReducer(ready, { type: 'error', stage: 'upload', message: 'x' })).toBe(ready);
    expect(uploadReducer(processing({ kind: 'fresh' }), { type: 'cancel' })).toEqual({
      phase: 'cancelled',
      panoId: 'p1',
    });
  });
});

// --- driver --------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
const deferred = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

interface Harness {
  deps: UploadDeps;
  calls: string[];
  put: Deferred<void>;
  progress: (loaded: number, total: number) => void;
  putSignal: () => AbortSignal;
  manifests: Array<Manifest | null | Error>;
  statuses: TilingStatus[];
}

function harness(): Harness {
  const h = {
    calls: [] as string[],
    put: deferred<void>(),
    manifests: [] as Array<Manifest | null | Error>,
    statuses: [] as TilingStatus[],
  } as Harness;
  let onProgress: ((l: number, t: number) => void) | undefined;
  let signal: AbortSignal | undefined;
  h.progress = (l, t) => onProgress?.(l, t);
  h.putSignal = () => signal as AbortSignal;
  h.deps = {
    presign: vi.fn(async (req) => {
      h.calls.push(`presign:${req.panoId ?? 'new'}`);
      return { panoId: req.panoId ?? 'p1', key: 'k', url: 'https://r2.example/put' };
    }),
    put: vi.fn((_url, _file, o) => {
      h.calls.push('put');
      onProgress = o.onProgress;
      signal = o.signal;
      return h.put.promise;
    }),
    fetchManifest: vi.fn(async () => {
      h.calls.push('manifest');
      const next = h.manifests.length > 1 ? h.manifests.shift() : h.manifests[0];
      if (next instanceof Error) throw next;
      return next ?? null;
    }),
    getPanoStatus: vi.fn(async () => {
      h.calls.push('status');
      const tiling = h.statuses.length > 1 ? h.statuses.shift() : h.statuses[0];
      return { tiling: tiling ?? 'pending' };
    }),
  };
  return h;
}

const file = (size = 1000): Blob => new Blob([new Uint8Array(size)], { type: 'image/jpeg' });
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('startUpload (background-tab safe: no requestAnimationFrame)', () => {
  let raf: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    // A backgrounded tab: rAF exists but its callbacks never run.
    raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
  });

  afterEach(() => {
    expect(raf).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fresh upload: presign -> PUT progress -> poll manifest -> ready', async () => {
    const h = harness();
    h.manifests = [null, null, manifest('t1-a')];
    const phases: string[] = [];
    const ctl = startUpload(h.deps, {
      file: file(200),
      onChange: (s) => phases.push(s.phase === 'upload' ? `upload:${s.pct}` : s.phase),
    });
    await flush();
    expect(ctl.getState()).toMatchObject({ phase: 'upload', panoId: 'p1', pct: 0 });
    expect(h.deps.presign).toHaveBeenCalledWith({ contentType: 'image/jpeg', size: 200 });

    h.progress(100, 200);
    h.progress(200, 200);
    h.put.resolve();
    await flush();
    expect(ctl.getState().phase).toBe('processing');
    expect(h.deps.fetchManifest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctl.getState().phase).toBe('processing');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(ctl.getState().phase).toBe('processing');
    await vi.advanceTimersByTimeAsync(2_250);
    expect(ctl.getState()).toMatchObject({ phase: 'ready', panoId: 'p1' });
    await expect(ctl.settled).resolves.toMatchObject({ phase: 'ready' });
    expect(phases).toEqual([
      'preparing',
      'upload:0',
      'upload:50',
      'upload:100',
      'processing',
      'ready',
    ]);

    // Polling stops once ready.
    const polls = vi.mocked(h.deps.fetchManifest).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.fetchManifest).toHaveBeenCalledTimes(polls);
    expect(h.deps.getPanoStatus).not.toHaveBeenCalled();
  });

  it('backs off manifest polls from 1s to a 5s ceiling', async () => {
    const h = harness();
    h.manifests = [null];
    startUpload(h.deps, { file: file() });
    await flush();
    h.put.resolve();
    await flush();
    const at: number[] = [];
    vi.mocked(h.deps.fetchManifest).mockImplementation(async () => {
      at.push(Date.now());
      return null;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const gaps = at.slice(1).map((t, i) => t - (at[i] as number));
    expect(gaps.slice(0, 4)).toEqual([1_500, 2_250, 3_375, 5_000]);
    expect(Math.max(...gaps)).toBe(5_000);
  });

  it('replace-image: captures manifest.version before presign; ready only when it changes', async () => {
    const h = harness();
    h.manifests = [manifest('t1-old')];
    const ctl = startUpload(h.deps, { file: file(), replacePanoId: 'p9' });
    await flush();
    expect(h.calls.slice(0, 2)).toEqual(['manifest', 'presign:p9']);
    expect(ctl.getState()).toMatchObject({
      phase: 'upload',
      panoId: 'p9',
      mode: { kind: 'replace', baselineVersion: 't1-old' },
    });

    h.put.resolve();
    await flush();
    // The old manifest keeps coming back while the re-tile runs.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctl.getState().phase).toBe('processing');

    h.manifests = [manifest('t1-new')];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctl.getState()).toMatchObject({ phase: 'ready', manifest: { version: 't1-new' } });
  });

  it('replace-image with identical bytes (same version) times out after 10 minutes, then can re-poll', async () => {
    const h = harness();
    h.manifests = [manifest('t1-same')];
    const ctl = startUpload(h.deps, { file: file(), replacePanoId: 'p9' });
    await flush();
    h.put.resolve();
    await flush();

    await vi.advanceTimersByTimeAsync(PROCESSING_TIMEOUT_MS - 1);
    expect(ctl.getState().phase).toBe('processing');
    await vi.advanceTimersByTimeAsync(1);
    expect(ctl.getState()).toMatchObject({ phase: 'timed-out', panoId: 'p9' });

    const polls = vi.mocked(h.deps.fetchManifest).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.fetchManifest).toHaveBeenCalledTimes(polls);

    ctl.retryPoll();
    expect(ctl.getState().phase).toBe('processing');
    h.manifests = [manifest('t1-later')];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctl.getState().phase).toBe('ready');
  });

  it('times out on wall-clock time even when a throttled timer fires late', async () => {
    const h = harness();
    h.manifests = [null];
    const ctl = startUpload(h.deps, { file: file() });
    await flush();
    h.put.resolve();
    await flush();
    // The tab was suspended: the clock jumps, then the next poll fires once.
    vi.setSystemTime(Date.now() + PROCESSING_TIMEOUT_MS + 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctl.getState().phase).toBe('timed-out');
  });

  it('times out even if a manifest request never settles', async () => {
    const h = harness();
    vi.mocked(h.deps.fetchManifest).mockImplementation(() => new Promise(() => {}));
    vi.mocked(h.deps.getPanoStatus).mockImplementation(() => new Promise(() => {}));
    const ctl = startUpload(h.deps, { file: file() });
    await flush();
    h.put.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(PROCESSING_TIMEOUT_MS);
    expect(ctl.getState().phase).toBe('timed-out');
  });

  it("fails when the status route reports tiling 'failed' (every 15s)", async () => {
    const h = harness();
    h.manifests = [null];
    h.statuses = ['pending', 'failed'];
    const ctl = startUpload(h.deps, { file: file() });
    await flush();
    h.put.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(h.deps.getPanoStatus).toHaveBeenCalledTimes(1);
    expect(ctl.getState().phase).toBe('processing');
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(ctl.getState()).toMatchObject({ phase: 'failed', stage: 'tiling', panoId: 'p1' });
    const polls = vi.mocked(h.deps.fetchManifest).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.fetchManifest).toHaveBeenCalledTimes(polls);
  });

  it('keeps polling through transient manifest/status errors', async () => {
    const h = harness();
    h.manifests = [new Error('net'), new Error('net'), manifest('t1-a')];
    vi.mocked(h.deps.getPanoStatus).mockRejectedValue(new Error('500'));
    const ctl = startUpload(h.deps, { file: file() });
    await flush();
    h.put.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctl.getState().phase).toBe('ready');
  });

  it('presign failure -> failed(presign); PUT failure -> failed(upload)', async () => {
    const a = harness();
    vi.mocked(a.deps.presign).mockRejectedValue(new Error('403'));
    const ca = startUpload(a.deps, { file: file() });
    await expect(ca.settled).resolves.toMatchObject({
      phase: 'failed',
      stage: 'presign',
      message: '403',
    });
    expect(a.deps.put).not.toHaveBeenCalled();

    const b = harness();
    const cb = startUpload(b.deps, { file: file() });
    await flush();
    b.put.reject(new Error('upload network error'));
    await expect(cb.settled).resolves.toMatchObject({ phase: 'failed', stage: 'upload' });
  });

  it('replace-image fails in prepare if the baseline manifest cannot be read', async () => {
    const h = harness();
    h.manifests = [new Error('cdn down')];
    const ctl = startUpload(h.deps, { file: file(), replacePanoId: 'p9' });
    await expect(ctl.settled).resolves.toMatchObject({ phase: 'failed', stage: 'prepare' });
    expect(h.deps.presign).not.toHaveBeenCalled();
  });

  it('an expired session during status polling fails at stage auth; retryPoll resumes after re-auth', async () => {
    const h = harness();
    h.manifests = [null];
    vi.mocked(h.deps.getPanoStatus).mockRejectedValueOnce(new AuthRequiredError());
    const ctl = startUpload(h.deps, { file: file(), replacePanoId: 'p9' });
    let settled = false;
    void ctl.settled.then(() => (settled = true));
    await flush();
    h.put.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(ctl.getState()).toMatchObject({
      phase: 'failed',
      stage: 'auth',
      panoId: 'p9',
      resumable: { kind: 'replace', baselineVersion: null },
    });
    // Polling stops while signed out, and the upload is not settled.
    const polls = vi.mocked(h.deps.fetchManifest).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.fetchManifest).toHaveBeenCalledTimes(polls);
    expect(settled).toBe(false);

    // After signing in again, the same controller picks polling back up.
    ctl.retryPoll();
    expect(ctl.getState()).toMatchObject({ phase: 'processing', panoId: 'p9' });
    h.manifests = [manifest('t1-new')];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctl.getState().phase).toBe('ready');
    expect(h.deps.presign).toHaveBeenCalledTimes(1);
    await expect(ctl.settled).resolves.toMatchObject({ phase: 'ready' });
  });

  it('a 401 on presign fails at stage auth and is terminal (nothing uploaded)', async () => {
    const h = harness();
    vi.mocked(h.deps.presign).mockRejectedValue(new AuthRequiredError());
    const ctl = startUpload(h.deps, { file: file() });
    await expect(ctl.settled).resolves.toEqual({
      phase: 'failed',
      panoId: null,
      stage: 'auth',
      message: 'sign-in required',
    });
    ctl.retryPoll();
    expect(ctl.getState().phase).toBe('failed');
  });

  it('pollNow polls the manifest at once, e.g. when a backgrounded tab is shown again', async () => {
    const h = harness();
    h.manifests = [null];
    const ctl = startUpload(h.deps, { file: file() });
    await flush();
    h.put.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.deps.fetchManifest).toHaveBeenCalledTimes(1);
    // The next poll is 1.5s away; the tab comes back and kicks it now.
    h.manifests = [manifest('t1-a')];
    ctl.pollNow();
    await flush();
    expect(h.deps.fetchManifest).toHaveBeenCalledTimes(2);
    expect(ctl.getState().phase).toBe('ready');
    ctl.pollNow();
    await flush();
    expect(h.deps.fetchManifest).toHaveBeenCalledTimes(2);
  });

  it('pollNow times out a throttled tab whose timers never fired', async () => {
    const h = harness();
    h.manifests = [null];
    const ctl = startUpload(h.deps, { file: file() });
    await flush();
    h.put.resolve();
    await flush();
    // Timers stalled (background throttling): only wall-clock time moves on.
    vi.setSystemTime(Date.now() + PROCESSING_TIMEOUT_MS);
    ctl.pollNow();
    expect(ctl.getState()).toMatchObject({ phase: 'timed-out', panoId: 'p1' });
  });

  it('pollNow does not double up an in-flight manifest request', async () => {
    const h = harness();
    const pending = deferred<Manifest | null>();
    const ctl = startUpload(h.deps, { file: file() });
    await flush();
    h.put.resolve();
    await flush();
    vi.mocked(h.deps.fetchManifest).mockImplementation(() => pending.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    ctl.pollNow();
    ctl.pollNow();
    expect(h.deps.fetchManifest).toHaveBeenCalledTimes(1);
    pending.resolve(manifest('t1-a'));
    await flush();
    expect(ctl.getState().phase).toBe('ready');
  });

  it('resume: an image that already landed only polls, with no presign or PUT', async () => {
    const h = harness();
    h.manifests = [manifest('t1-old'), manifest('t1-new')];
    const phases: string[] = [];
    const ctl = startUpload(h.deps, {
      resume: { panoId: 'p9', mode: { kind: 'replace', baselineVersion: 't1-old' } },
      onChange: (s) => phases.push(s.phase),
    });
    await flush();
    expect(ctl.getState()).toMatchObject({ phase: 'processing', panoId: 'p9' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctl.getState().phase).toBe('processing');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(ctl.getState()).toMatchObject({ phase: 'ready', panoId: 'p9' });
    expect(h.deps.presign).not.toHaveBeenCalled();
    expect(h.deps.put).not.toHaveBeenCalled();
    expect(phases).toEqual(['preparing', 'processing', 'ready']);
  });

  it('cancel aborts the PUT and stops everything', async () => {
    const h = harness();
    const ctl = startUpload(h.deps, { file: file() });
    await flush();
    ctl.cancel();
    expect(h.putSignal().aborted).toBe(true);
    await expect(ctl.settled).resolves.toEqual({ phase: 'cancelled', panoId: 'p1' });
    h.put.reject(new Error('aborted'));
    await flush();
    expect(ctl.getState().phase).toBe('cancelled');
  });
});
