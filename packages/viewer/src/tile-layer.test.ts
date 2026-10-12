import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FACES } from './cube.js';
import type { TileRetryBudget } from './tile-retry.js';
import { attemptsFor } from './test-support/oracles.js';
import { BaseTileLoadError, TileLayer } from './tile-layer.js';
import { ContextLostError, type GLRenderer } from './render/gl-renderer.js';
import {
  useLayerFixture,
  LAYER_DEFAULTS,
  TILE_COOLDOWN_MS,
  ABORT_GRACE_MS,
  makeSource,
  keyOf,
  drain,
} from './test-support/tile-layer-fixture.js';

describe('TileLayer', () => {
  const fx = useLayerFixture();
  const {
    advance,
    flush,
    makeLayer,
    baseUrl,
    frame,
    stayAt,
    withLevel1,
    level2,
    readyCount,
    render,
  } = fx;

  it('retries a tile that failed transiently once its cooldown has elapsed', async () => {
    const layer = makeLayer();
    fx.script = { status: 503 };

    await render(layer, 0);
    const firstPass = level2();
    expect(firstPass.length).toBeGreaterThan(0);

    // Same frame again, no time passed: the cooldown holds the retry back.
    await render(layer, 0);
    expect(level2()).toHaveLength(firstPass.length);

    advance(TILE_COOLDOWN_MS);
    await render(layer, 0);
    expect(level2()).toHaveLength(firstPass.length * 2);
    expect(new Set(level2()).size).toBe(firstPass.length); // the same tiles
  });

  it('retries a tile whose fetch was rejected outright (offline)', async () => {
    const layer = makeLayer();
    fx.script = { status: 0, network: true };

    await render(layer, 0);
    const firstPass = fx.requests.length;
    expect(firstPass).toBeGreaterThan(0);

    advance(TILE_COOLDOWN_MS);
    fx.script = { status: 200 };
    await render(layer, 0);
    expect(fx.requests.length).toBe(firstPass * 2);
    expect(fx.renderer.uploadTile).toHaveBeenCalledTimes(firstPass);
  });

  it('never retries a 404 — the tile does not exist', async () => {
    const layer = makeLayer();
    fx.script = { status: 404 };

    await render(layer, 0);
    const firstPass = level2().length;
    expect(firstPass).toBeGreaterThan(0);

    advance(60_000);
    await render(layer, 0);
    await render(layer, 0);
    expect(level2()).toHaveLength(firstPass);
  });

  it('never retries a 403 either — the same request cannot become authorised', async () => {
    const layer = makeLayer();
    fx.script = { status: 403 };

    await render(layer, 0);
    const firstPass = level2().length;
    advance(60_000);
    await render(layer, 0);
    expect(level2()).toHaveLength(firstPass);
  });

  it('stops retrying a tile once its attempt cap is spent', async () => {
    const layer = makeLayer();
    fx.script = { status: 500 };

    for (let i = 0; i < 6; i++) {
      await render(layer, 0);
      advance(60_000);
    }

    const perTile = new Map<string, number>();
    for (const url of fx.requests) perTile.set(url, (perTile.get(url) ?? 0) + 1);
    expect(perTile.size).toBeGreaterThan(0);
    for (const count of perTile.values()) expect(count).toBe(3);
  });

  it('refills the hole when a failed tile becomes visible again after a pan', async () => {
    const layer = makeLayer();
    fx.script = { status: 503 };

    await render(layer, 0);
    const facing = new Set(fx.requests);
    expect(facing.size).toBeGreaterThan(0);

    // Pan right round to the opposite direction: a different tile set, and the
    // failed ones drop out of the desired set entirely.
    advance(TILE_COOLDOWN_MS);
    fx.requests = [];
    await render(layer, Math.PI);
    const away = new Set(fx.requests);
    for (const url of away) expect(facing.has(url)).toBe(false);

    // The blip passes; pan back. The failed tiles still have attempts left,
    // so they load and draw instead of staying a hole.
    advance(TILE_COOLDOWN_MS);
    fx.script = { status: 200 };
    fx.requests = [];
    await render(layer, 0);
    expect(new Set(fx.requests)).toEqual(facing);
    // All of them are resident again, and the level-2 tiles in view draw (a
    // level-1 tile they all cover is left out of the draw list).
    const { cache } = layer as unknown as { cache: Map<string, unknown> };
    expect(cache.size).toBe(facing.size);
    const inView = [...facing].filter((u) => u.includes('/2/')).length;
    expect(inView).toBeGreaterThan(0);
    expect(layer.drawList().filter((d) => d.level === 2)).toHaveLength(inView);
  });

  describe('idle retry wake', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Fail exactly one non-base tile once, transiently; everything else loads. */
    function failOneTileOnce(): () => string | undefined {
      let failed: string | undefined;
      fx.respond = (url) => {
        if (failed === undefined && url.includes('/2/')) {
          failed = url;
          return { status: 503 };
        }
        return null;
      };
      return () => failed;
    }

    it('asks for a frame once a failed tile on a still view may be retried', async () => {
      const invalidate = vi.fn();
      const failed = failOneTileOnce();
      const layer = makeLayer('pano-a', 128, invalidate);
      frame(layer, 0);
      await drain();
      expect(failed()).toBeDefined();
      const calls = invalidate.mock.calls.length;

      // Nothing else is going to draw a frame: the view is still and every
      // other tile has landed. The cooldown has to end in a wake.
      advance(TILE_COOLDOWN_MS - 1);
      await vi.advanceTimersByTimeAsync(TILE_COOLDOWN_MS - 1);
      expect(invalidate).toHaveBeenCalledTimes(calls);
      advance(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(invalidate).toHaveBeenCalledTimes(calls + 1);

      // The frame that wake asks for retries the tile, which now loads, and
      // the frames after it upload what decoded.
      frame(layer, 0);
      await drain();
      for (let i = 0; i < 100 && readyCount(layer) > 0; i++) {
        frame(layer, 0);
        await drain();
      }
      expect(fx.requests.filter((u) => u === failed())).toHaveLength(2);
      expect(layer.hasPending()).toBe(false);
      layer.dispose();
    });

    it('does not wake for a failed tile that is no longer wanted', async () => {
      const invalidate = vi.fn();
      failOneTileOnce();
      const layer = makeLayer('pano-a', 128, invalidate);
      frame(layer, 0);
      frame(layer, Math.PI); // pan away before the failure lands
      await drain();
      // The loads the pan left behind get a wake to abort them; after that,
      // nothing.
      advance(ABORT_GRACE_MS);
      await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);
      const calls = invalidate.mock.calls.length;
      advance(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(invalidate).toHaveBeenCalledTimes(calls);
      layer.dispose();
    });

    it('wakes for a cooling tile that a pan brings back on screen', async () => {
      const invalidate = vi.fn();
      failOneTileOnce();
      const layer = makeLayer('pano-a', 128, invalidate);
      frame(layer, 0);
      frame(layer, Math.PI); // the failure lands while the tile is off screen
      await drain();
      advance(TILE_COOLDOWN_MS / 2);
      frame(layer, 0); // back on screen, still cooling, then the view rests
      await drain();
      const calls = invalidate.mock.calls.length;
      advance(TILE_COOLDOWN_MS / 2);
      await vi.advanceTimersByTimeAsync(TILE_COOLDOWN_MS / 2);
      expect(invalidate).toHaveBeenCalledTimes(calls + 1);
      layer.dispose();
    });

    it('moves the wake earlier when a later failure can retry sooner', async () => {
      // Tile A fails twice, so its next try is 2 s out. Tile B then fails for
      // the first time, 1 s cooldown, and must not wait behind A's timer.
      let a: string | undefined;
      let b: string | undefined;
      let failB: (() => void) | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          fx.requests.push(url);
          const reply = (status: number) => ({
            ok: status === 200,
            status,
            blob: () => Promise.resolve({}),
          });
          if (url.includes('/2/') && a === undefined) a = url;
          else if (url.includes('/2/') && b === undefined) b = url;
          if (url === a) return Promise.resolve(reply(503));
          if (url === b) return new Promise((resolve) => (failB = () => resolve(reply(503))));
          return Promise.resolve(reply(200));
        }),
      );
      const invalidate = vi.fn();
      const layer = makeLayer('pano-a', 128, invalidate);
      frame(layer, 0);
      await drain();
      expect(a).toBeDefined();
      expect(failB).toBeDefined();

      advance(TILE_COOLDOWN_MS);
      await vi.advanceTimersByTimeAsync(TILE_COOLDOWN_MS); // A's first wake
      frame(layer, 0); // retries A, which fails again: next wake in 2 s
      await drain();
      expect(fx.requests.filter((u) => u === a)).toHaveLength(2);

      advance(100);
      await vi.advanceTimersByTimeAsync(100);
      failB!(); // B's first failure: it may go again in 1 s
      await drain();
      const calls = invalidate.mock.calls.length;

      advance(TILE_COOLDOWN_MS - 1);
      await vi.advanceTimersByTimeAsync(TILE_COOLDOWN_MS - 1);
      expect(invalidate).toHaveBeenCalledTimes(calls);
      advance(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(invalidate).toHaveBeenCalledTimes(calls + 1);
      layer.dispose();
    });

    it('asks for a frame when the last pending tile fails for good', async () => {
      // One level-2 tile answers 404, and only after everything else is in.
      let missing: string | undefined;
      let fail: (() => void) | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          fx.requests.push(url);
          const reply = (status: number) => ({
            ok: status === 200,
            status,
            blob: () => Promise.resolve({}),
          });
          if (missing === undefined && url.includes('/2/')) {
            missing = url;
            return new Promise((resolve) => (fail = () => resolve(reply(404))));
          }
          return Promise.resolve(reply(200));
        }),
      );
      const invalidate = vi.fn();
      const layer = makeLayer('pano-a', 128, invalidate);
      frame(layer, 0);
      await drain();
      for (let i = 0; i < 100 && readyCount(layer) > 0; i++) {
        frame(layer, 0);
        await drain();
      }
      expect(fail).toBeDefined();
      expect(layer.hasPending()).toBe(true); // only the held tile is left
      const calls = invalidate.mock.calls.length;

      fail!();
      await drain();
      expect(layer.hasPending()).toBe(false);
      expect(invalidate).toHaveBeenCalledTimes(calls + 1);
      layer.dispose();
    });

    it('cancels a pending wake on dispose', async () => {
      const invalidate = vi.fn();
      failOneTileOnce();
      const layer = makeLayer('pano-a', 128, invalidate);
      frame(layer, 0);
      await drain();
      expect(vi.getTimerCount()).toBe(1);

      layer.dispose();
      expect(vi.getTimerCount()).toBe(0);
      const calls = invalidate.mock.calls.length;
      advance(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(invalidate).toHaveBeenCalledTimes(calls);
    });
  });

  it('leaves an aborted in-flight load fully re-queueable', async () => {
    const layer = await withLevel1(makeLayer());
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: { signal: AbortSignal }) => {
        fx.requests.push(url);
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }),
    );

    frame(layer, 0);
    // The exact tiles that are about to be aborted — identity, not a count.
    // A count alone proves nothing here: maxConcurrent (8) is smaller than the
    // candidate set, so eight brand-new tiles would satisfy it just as well as
    // the eight that were cancelled.
    const abortedTiles = [...fx.requests];
    expect(abortedTiles.length).toBeGreaterThan(0);
    stayAt(layer, Math.PI); // pans away — update() aborts what is no longer wanted
    await flush();

    // No attempt spent, no cooldown started, no evidence recorded: *these*
    // tiles come straight back. If an abort burned a retry attempt they would
    // be held off by their per-tile cooldown and the next-best candidates
    // would be fetched in their place, which is the same count and the wrong
    // tiles.
    fx.requests = [];
    stayAt(layer, 0); // and back, which in turn aborts the loads for PI
    await flush();
    expect(new Set(fx.requests)).toEqual(new Set(abortedTiles));
    expect(fx.requests).toHaveLength(abortedTiles.length);
    layer.dispose();
  });

  describe('low-resolution base layer', () => {
    it('counts the base as pending while it loads, before any frame has said what is in view', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {})),
      );
      const layer = makeLayer();
      void layer.loadBase();
      await flush();
      expect(layer.hasPending()).toBe(true);
      layer.dispose();
      expect(layer.hasPending()).toBe(false);
    });

    it('loads exactly one level-0 tile per cube face — the whole panorama, coarsely', async () => {
      const layer = makeLayer();

      await expect(layer.loadBase()).resolves.toBeUndefined();

      expect(fx.requests).toHaveLength(FACES.length);
      for (const face of FACES) expect(fx.requests).toContain(baseUrl(face));
      expect(fx.renderer.uploadTile).toHaveBeenCalledTimes(FACES.length);
      // Resident and drawable before a single frame has been rendered.
      expect(layer.drawList()).toHaveLength(FACES.length);
      expect(layer.drawList().every((d) => d.level === 0)).toBe(true);
    });

    it('does not resolve until every face is in, not just the first one', async () => {
      const layer = makeLayer();
      let releaseLast: (() => void) | undefined;
      const lastFace = FACES[FACES.length - 1]!;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          fx.requests.push(url);
          const body = { ok: true, status: 200, blob: () => Promise.resolve({}) };
          if (url !== baseUrl(lastFace)) return Promise.resolve(body);
          return new Promise((resolve) => {
            releaseLast = () => resolve(body);
          });
        }),
      );

      let settled = false;
      const load = layer.loadBase().then(() => {
        settled = true;
      });
      await flush();

      // Five faces are already uploaded — and the load is still outstanding.
      expect(fx.requests).toHaveLength(FACES.length);
      expect(fx.renderer.uploadTile).toHaveBeenCalledTimes(FACES.length - 1);
      expect(settled).toBe(false);

      releaseLast!();
      await load;
      expect(settled).toBe(true);
      expect(fx.renderer.uploadTile).toHaveBeenCalledTimes(FACES.length);
    });

    it('retries a transiently failing base tile and still resolves when the retry works', async () => {
      const layer = makeLayer();
      const flaky = baseUrl(FACES[0]!);
      let failuresLeft = 1;
      fx.respond = (url) =>
        url === flaky && failuresLeft-- > 0 ? { status: 503 } : { status: 200 };

      // A blip on one of six requests must not kill the load.
      await expect(layer.loadBase()).resolves.toBeUndefined();

      expect(fx.requests.filter((u) => u === flaky)).toHaveLength(2);
      expect(fx.sleeps).toEqual([TILE_COOLDOWN_MS]);
      expect(fx.renderer.uploadTile).toHaveBeenCalledTimes(FACES.length);
    });

    it('rejects once a base tile has exhausted its retry budget', async () => {
      const layer = makeLayer();
      const broken = baseUrl(FACES[2]!);
      fx.respond = (url) => (url === broken ? { status: 500 } : { status: 200 });

      // 500 is transient - retrying is still worth it, just not for this load.
      await expect(layer.loadBase()).rejects.toMatchObject({
        permanent: false,
      });

      // The full per-tile budget is spent first (1 initial + 2 retries), on the
      // same escalating cooldown every other tile uses.
      expect(fx.requests.filter((u) => u === broken)).toHaveLength(3);
      expect(fx.sleeps).toEqual([TILE_COOLDOWN_MS, TILE_COOLDOWN_MS * 2]);
    });

    it('rejects immediately on a permanent status, without spending retries', async () => {
      const layer = makeLayer();
      const missing = baseUrl(FACES[3]!);
      fx.respond = (url) => (url === missing ? { status: 404 } : { status: 200 });

      // 404: the panorama is not published, and no amount of retrying fixes that.
      await expect(layer.loadBase()).rejects.toMatchObject({
        message: expect.stringContaining('tile 404'),
        permanent: true,
      });

      expect(fx.requests.filter((u) => u === missing)).toHaveLength(1);
      expect(fx.sleeps).toHaveLength(0);
    });

    it('names the panorama and the face in the rejection', async () => {
      const layer = makeLayer('pano-a');
      fx.respond = (url) => (url === baseUrl('ny') ? { status: 410 } : { status: 200 });

      await expect(layer.loadBase()).rejects.toThrow(/tile source "pano-a".*face "ny"/);
    });

    it('rejects when the network is down entirely', async () => {
      const layer = makeLayer();
      fx.script = { status: 0, network: true };

      await expect(layer.loadBase()).rejects.toBeInstanceOf(BaseTileLoadError);
      // Every face got its full budget before the load was declared dead.
      expect(fx.requests).toHaveLength(FACES.length * 3);
    });

    it('is not aborted by a frame rendered while the base is still loading', async () => {
      // Level-0 keys are never in a deeper level's desired set, so a frame that
      // runs before the base has landed must leave those fetches alone.
      const signals = new Map<string, AbortSignal>();
      const pending: (() => void)[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: { signal: AbortSignal }) => {
          fx.requests.push(url);
          const body = { ok: true, status: 200, blob: () => Promise.resolve({}) };
          if (!url.includes('/0/')) return Promise.resolve(body);
          signals.set(url, init.signal);
          return new Promise((resolve, reject) => {
            pending.push(() => resolve(body));
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        }),
      );
      const layer = makeLayer();
      const load = layer.loadBase();
      await flush();
      expect(signals.size).toBe(FACES.length);

      await render(layer, 0); // level 2 at this fov and height
      expect(fx.requests.some((u) => u.includes('/2/'))).toBe(true);
      for (const signal of signals.values()) expect(signal.aborted).toBe(false);

      for (const release of pending) release();
      await expect(load).resolves.toBeUndefined();
      expect(fx.requests.filter((u) => u.includes('/0/'))).toHaveLength(FACES.length);
      layer.dispose();
    });

    it('does not reject when the layer is disposed mid-load', async () => {
      const layer = makeLayer();
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: { signal: AbortSignal }) => {
          fx.requests.push(url);
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        }),
      );

      const load = layer.loadBase();
      layer.dispose();
      await expect(load).resolves.toBeUndefined();
    });
  });

  describe('disposal', () => {
    /** fetch that never settles until its request is aborted. */
    function stubHangingFetch(): void {
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: { signal: AbortSignal }) => {
          fx.requests.push(url);
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        }),
      );
    }

    it('starts no further tile fetches once the layer is disposed', async () => {
      const layer = makeLayer();
      stubHangingFetch();

      frame(layer, 0);
      const started = fx.requests.length;
      expect(started).toBeGreaterThan(0);

      // update() left the rest of the candidate list queued behind the
      // concurrency limit. Disposing aborts what is in flight, and every abort
      // frees a slot — so without a disposed check the queue drains straight
      // into a second full round of fetches that are downloaded and decoded
      // only to be thrown away.
      layer.dispose();
      await flush();
      expect(fx.requests).toHaveLength(started);
    });

    it('re-queues nothing from a frame rendered after dispose', async () => {
      const layer = makeLayer();
      stubHangingFetch();

      layer.dispose();
      frame(layer, 0);
      await flush();
      expect(fx.requests).toHaveLength(0);
    });

    it('aborts a base-layer retry wait instead of sleeping it out', async () => {
      // The wait between base-tile attempts is seconds long. A disposal must be
      // noticed inside it, not after it: otherwise the loader wakes up in a
      // torn-down layer and issues another round of fetches (the measured
      // symptom was 3s of post-dispose fetch/sleep/retry activity).
      let waitSignal: AbortSignal | undefined;
      const layer = new TileLayer(
        fx.renderer as unknown as GLRenderer,
        makeSource('pano-a'),
        () => {},
        {
          ...LAYER_DEFAULTS,
          textureBudgetMB: 128,
          now: () => fx.clock,
          sleep: (ms: number, signal: AbortSignal) => {
            fx.sleeps.push(ms);
            waitSignal = signal;
            return new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        },
      );
      fx.script = { status: 503 };

      const load = layer.loadBase();
      await flush();
      // Every face failed its first attempt and is now waiting out a cooldown.
      expect(fx.requests).toHaveLength(FACES.length);
      expect(fx.sleeps).toHaveLength(FACES.length);
      expect(waitSignal?.aborted).toBe(false);

      layer.dispose();
      expect(waitSignal?.aborted).toBe(true);
      await expect(load).resolves.toBeUndefined();
      expect(fx.requests).toHaveLength(FACES.length);
      expect(fx.renderer.uploadTile).not.toHaveBeenCalled();
    });
  });

  describe('context loss', () => {
    const retryOf = (layer: TileLayer) => (layer as unknown as { retry: TileRetryBudget }).retry;

    it('spends no attempt on a tile whose upload hit a lost context', async () => {
      fx.renderer.uploadTile.mockImplementation(() => {
        throw new ContextLostError();
      });
      const layer = makeLayer();
      await render(layer, 0);
      const first = [...fx.requests];
      expect(first.length).toBeGreaterThan(0);
      for (const url of first) expect(attemptsFor(retryOf(layer), keyOf(url))).toBe(0);
      // Each went out again on the next frame, with no cooldown to wait out.
      expect(fx.requests.length).toBeGreaterThan(new Set(fx.requests).size);

      // Once uploads work again, they land.
      fx.renderer.uploadTile.mockImplementation(() => 1);
      await render(layer, 0);
      expect(layer.drawList().length).toBeGreaterThan(0);
      layer.dispose();
    });

    it('waits out a lost context instead of failing the base load', async () => {
      fx.renderer.uploadTile.mockImplementation(() => {
        throw new ContextLostError();
      });
      const layer = makeLayer();
      let outcome = 'pending';
      const base = layer.loadBase().then(
        () => (outcome = 'resolved'),
        () => (outcome = 'rejected'),
      );
      for (let i = 0; i < 5; i++) await flush();
      expect(outcome).toBe('pending');
      expect(fx.sleeps).toEqual([]); // no retry was spent on it
      expect(fx.requests.filter((u) => u.includes('/0/'))).toHaveLength(FACES.length);
      // The viewer replaces the layer once the context is back.
      layer.dispose();
      await base;
      expect(outcome).toBe('resolved');
    });
  });
});
