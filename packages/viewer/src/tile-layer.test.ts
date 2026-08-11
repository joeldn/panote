import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FACES, type Manifest } from '@panote/core';
import { BaseTileLoadError, TileLayer } from './tile-layer.js';
import { TileFailureMonitor } from './tile-retry.js';
import { viewProjection } from './render/projection.js';
import { dirFromYawPitch } from './project.js';
import { sortDrawList, type GLRenderer } from './render/gl-renderer.js';

// This package's vitest config runs under Node, not jsdom (see
// vitest.config.ts) — deliberately, so the package pays for no DOM test
// dependency. TileLayer only reaches for three host globals (fetch,
// createImageBitmap, AbortController), so this file follows the same
// "minimal stand-in for exactly what's touched" approach as
// PanoViewer.test.ts and render/gl-renderer.test.ts: a hand-built fake
// renderer plus a scripted fetch, with no DOM anywhere.
//
// Time is injected: the failure monitor owns the clock TileLayer measures
// retry cooldowns against (see tile-retry.ts), so every delay in these tests
// is advanced by hand rather than waited on. No timers are faked and no test
// sleeps.

const TILE_COOLDOWN_MS = 1_000; // first per-tile retry delay (tile-retry.ts)
const BACKOFF_MS = 10_000; // overridden below so it dwarfs the tile cooldown

function makeManifest(pano: string): Manifest {
  return {
    pano,
    faceSize: 2048,
    tileSize: 512,
    maxLevel: 2,
    faces: FACES,
    quality: 82,
    format: 'jpg',
  };
}

class FakeRenderer {
  private next = 1;
  uploadTile = vi.fn(() => this.next++);
  removeTile = vi.fn();
}

interface Scripted {
  status: number;
  /** status 0 stands for "fetch rejected outright" (offline, DNS, reset). */
  network?: boolean;
}

describe('TileLayer failure handling', () => {
  let clock: number;
  let monitor: TileFailureMonitor;
  let renderer: FakeRenderer;
  let requests: string[];
  let script: Scripted;
  /** Per-URL response override; falls back to `script` when it returns null. */
  let respond: ((url: string) => Scripted | null) | undefined;
  /** Every base-layer inter-attempt wait, in order, for exact assertions. */
  let sleeps: number[];

  const advance = (ms: number): void => {
    clock += ms;
  };

  /** Drain every pending microtask chain started by update()/pump(). */
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  function makeLayer(pano = 'pano-a', textureBudgetMB = 128): TileLayer {
    return new TileLayer(
      renderer as unknown as GLRenderer,
      makeManifest(pano),
      '/tiles/',
      textureBudgetMB,
      () => {},
      8,
      monitor,
      // The injected sleep advances the same clock the retry budget measures
      // its cooldowns against, so a base-layer retry is exercised for real
      // without any test waiting on a real timer.
      (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    );
  }

  /** URL of the level-0 base tile for a face. */
  function baseUrl(face: string, pano = 'pano-a'): string {
    return `/tiles/${pano}/0/${face}/0-0.jpg`;
  }

  /** One render frame at the given yaw, matching PanoViewer's loop() call. */
  function frame(layer: TileLayer, yaw: number): void {
    const view = { yaw, pitch: 0, fov: 70 };
    layer.update(viewProjection(view, 1, 100), 70, dirFromYawPitch(yaw, 0), 800);
  }

  async function render(layer: TileLayer, yaw: number): Promise<void> {
    frame(layer, yaw);
    await flush();
  }

  beforeEach(() => {
    clock = 1_000_000;
    monitor = new TileFailureMonitor({ now: () => clock, baseDelayMs: BACKOFF_MS });
    renderer = new FakeRenderer();
    requests = [];
    sleeps = [];
    respond = undefined;
    script = { status: 200 };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        requests.push(url);
        const scripted = respond?.(url) ?? script;
        if (scripted.network) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({
          ok: scripted.status >= 200 && scripted.status < 300,
          status: scripted.status,
          blob: () => Promise.resolve({}),
        });
      }),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ close: vi.fn() })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries a tile that failed transiently once its cooldown has elapsed', async () => {
    const layer = makeLayer();
    script = { status: 503 };

    await render(layer, 0);
    const firstPass = [...requests];
    expect(firstPass.length).toBeGreaterThan(0);

    // Same frame again, no time passed: the cooldown holds the retry back.
    await render(layer, 0);
    expect(requests).toHaveLength(firstPass.length);

    advance(TILE_COOLDOWN_MS);
    await render(layer, 0);
    expect(requests).toHaveLength(firstPass.length * 2);
    expect(new Set(requests).size).toBe(firstPass.length); // the same tiles
  });

  it('retries a tile whose fetch was rejected outright (offline)', async () => {
    const layer = makeLayer();
    script = { status: 0, network: true };

    await render(layer, 0);
    const firstPass = requests.length;
    expect(firstPass).toBeGreaterThan(0);

    advance(TILE_COOLDOWN_MS);
    script = { status: 200 };
    await render(layer, 0);
    expect(requests.length).toBe(firstPass * 2);
    expect(renderer.uploadTile).toHaveBeenCalledTimes(firstPass);
  });

  it('never retries a 404 — the tile does not exist', async () => {
    const layer = makeLayer();
    script = { status: 404 };

    await render(layer, 0);
    const firstPass = requests.length;
    expect(firstPass).toBeGreaterThan(0);

    advance(60_000);
    await render(layer, 0);
    await render(layer, 0);
    expect(requests).toHaveLength(firstPass);
  });

  it('never retries a 403 either — the same request cannot become authorised', async () => {
    const layer = makeLayer();
    script = { status: 403 };

    await render(layer, 0);
    const firstPass = requests.length;
    advance(60_000);
    await render(layer, 0);
    expect(requests).toHaveLength(firstPass);
  });

  it('stops retrying a tile once its attempt cap is spent', async () => {
    const layer = makeLayer();
    script = { status: 500 };

    for (let i = 0; i < 6; i++) {
      await render(layer, 0);
      advance(60_000);
    }

    const perTile = new Map<string, number>();
    for (const url of requests) perTile.set(url, (perTile.get(url) ?? 0) + 1);
    expect(perTile.size).toBeGreaterThan(0);
    for (const count of perTile.values()) expect(count).toBe(3);
  });

  it('refills the hole when a failed tile becomes visible again after a pan', async () => {
    const layer = makeLayer();
    script = { status: 503 };

    await render(layer, 0);
    const facing = new Set(requests);
    expect(facing.size).toBeGreaterThan(0);

    // Pan right round to the opposite direction: a different tile set, and the
    // failed ones drop out of the desired set entirely.
    advance(TILE_COOLDOWN_MS);
    requests = [];
    await render(layer, Math.PI);
    const away = new Set(requests);
    for (const url of away) expect(facing.has(url)).toBe(false);

    // The blip passes; pan back. The old blacklist would have left these tiles
    // as a permanent hole — now they load and draw.
    advance(TILE_COOLDOWN_MS);
    script = { status: 200 };
    requests = [];
    await render(layer, 0);
    expect(new Set(requests)).toEqual(facing);
    expect(layer.drawList()).toHaveLength(facing.size);
  });

  it('does NOT trip the global backoff when failures stay in one panorama', async () => {
    const layer = makeLayer();
    script = { status: 500 };

    for (let i = 0; i < 4; i++) {
      await render(layer, 0);
      advance(5_000);
    }

    expect(monitor.backingOff()).toBe(false);
    expect(monitor.escalationLevel).toBe(0);
  });

  it('trips the global backoff when failures span two panoramas', async () => {
    // Panorama A's layer is disposed before B's is built, exactly as
    // PanoViewer.load() does it — only the shared monitor spans the two.
    const layerA = makeLayer('pano-a');
    script = { status: 500 };
    await render(layerA, 0);
    expect(monitor.backingOff()).toBe(false);
    layerA.dispose();

    const layerB = makeLayer('pano-b');
    await render(layerB, 0);
    expect(monitor.backingOff()).toBe(true);
    expect(monitor.escalationLevel).toBe(1);

    // New fetches are suppressed while the window is open.
    const before = requests.length;
    advance(TILE_COOLDOWN_MS);
    await render(layerB, 0);
    expect(requests).toHaveLength(before);
  });

  it('suppresses a pan-triggered retry while the backoff is active, then probes once', async () => {
    const layerA = makeLayer('pano-a');
    script = { status: 500 };
    await render(layerA, 0);
    const facing = new Set(requests);

    const layerB = makeLayer('pano-b');
    await render(layerB, 0);
    expect(monitor.backingOff()).toBe(true);

    // Pan away and back on A. Its tiles are past their cooldown and would be
    // retried on their own — the global backoff is the only thing stopping
    // them, and the owner was explicit that it must.
    advance(TILE_COOLDOWN_MS + 1);
    await render(layerA, Math.PI);
    requests = [];
    await render(layerA, 0);
    expect(requests).toHaveLength(0);

    // Halfway through the window exactly one probe is allowed through, so a
    // recovered network is noticed without waiting the whole delay out. This
    // one still fails, which is proof the outage continues: the ladder goes up
    // a rung and a fresh, longer window opens.
    advance(BACKOFF_MS / 2);
    await render(layerA, 0);
    expect(requests).toHaveLength(1);
    expect(facing.has(requests[0]!)).toBe(true);
    expect(monitor.escalationLevel).toBe(2);
    expect(monitor.backoffRemainingMs()).toBe(BACKOFF_MS * 2);

    // Next window, next probe — this time the origin is back, so the probe
    // succeeds, the backoff clears and normal loading resumes in the same
    // frame instead of waiting the remaining delay out.
    advance(BACKOFF_MS);
    script = { status: 200 };
    requests = [];
    await render(layerA, 0);
    expect(monitor.backingOff()).toBe(false);
    expect(requests.length).toBeGreaterThan(1);
  });

  it('does not spend an attempt on a tile whose fetch was suppressed', async () => {
    const layerA = makeLayer('pano-a');
    script = { status: 500 };
    await render(layerA, 0);
    const layerB = makeLayer('pano-b');
    await render(layerB, 0);
    expect(monitor.backingOff()).toBe(true);

    // Frames keep coming while the window is open; none of them may consume
    // the tiles' remaining attempts.
    for (let i = 0; i < 5; i++) await render(layerB, 0);

    advance(BACKOFF_MS);
    script = { status: 200 };
    requests = [];
    await render(layerB, 0);
    expect(requests.length).toBeGreaterThan(0);
    expect(renderer.uploadTile).toHaveBeenCalledTimes(requests.length);
  });

  it('leaves an aborted in-flight load fully re-queueable', async () => {
    const layer = makeLayer();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: { signal: AbortSignal }) => {
        requests.push(url);
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
    const abortedTiles = [...requests];
    expect(abortedTiles.length).toBeGreaterThan(0);
    frame(layer, Math.PI); // pans away — update() aborts what is no longer wanted
    await flush();

    // No attempt spent, no cooldown started, no evidence recorded: *these*
    // tiles come straight back. If an abort burned a retry attempt they would
    // be held off by their per-tile cooldown and the next-best candidates
    // would be fetched in their place, which is the same count and the wrong
    // tiles.
    requests = [];
    frame(layer, 0);
    await flush();
    expect(new Set(requests)).toEqual(new Set(abortedTiles));
    expect(requests).toHaveLength(abortedTiles.length);
    expect(monitor.escalationLevel).toBe(0);
    layer.dispose();
  });

  describe('low-resolution base layer', () => {
    it('loads exactly one level-0 tile per cube face — the whole panorama, coarsely', async () => {
      const layer = makeLayer();

      await expect(layer.loadBase()).resolves.toBeUndefined();

      expect(requests).toHaveLength(FACES.length);
      for (const face of FACES) expect(requests).toContain(baseUrl(face));
      expect(renderer.uploadTile).toHaveBeenCalledTimes(FACES.length);
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
          requests.push(url);
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
      expect(requests).toHaveLength(FACES.length);
      expect(renderer.uploadTile).toHaveBeenCalledTimes(FACES.length - 1);
      expect(settled).toBe(false);

      releaseLast!();
      await load;
      expect(settled).toBe(true);
      expect(renderer.uploadTile).toHaveBeenCalledTimes(FACES.length);
    });

    it('retries a transiently failing base tile and still resolves when the retry works', async () => {
      const layer = makeLayer();
      const flaky = baseUrl(FACES[0]!);
      let failuresLeft = 1;
      respond = (url) => (url === flaky && failuresLeft-- > 0 ? { status: 503 } : { status: 200 });

      // A blip on one of six requests must not kill the load.
      await expect(layer.loadBase()).resolves.toBeUndefined();

      expect(requests.filter((u) => u === flaky)).toHaveLength(2);
      expect(sleeps).toEqual([TILE_COOLDOWN_MS]);
      expect(renderer.uploadTile).toHaveBeenCalledTimes(FACES.length);
    });

    it('rejects once a base tile has exhausted its retry budget', async () => {
      const layer = makeLayer();
      const broken = baseUrl(FACES[2]!);
      respond = (url) => (url === broken ? { status: 500 } : { status: 200 });

      // 500 is transient - retrying is still worth it, just not for this load.
      await expect(layer.loadBase()).rejects.toMatchObject({
        permanent: false,
      });

      // The full per-tile budget is spent first (1 initial + 2 retries), on the
      // same escalating cooldown every other tile uses.
      expect(requests.filter((u) => u === broken)).toHaveLength(3);
      expect(sleeps).toEqual([TILE_COOLDOWN_MS, TILE_COOLDOWN_MS * 2]);
    });

    it('rejects immediately on a permanent status, without spending retries', async () => {
      const layer = makeLayer();
      const missing = baseUrl(FACES[3]!);
      respond = (url) => (url === missing ? { status: 404 } : { status: 200 });

      // 404: the panorama is not published, and no amount of retrying fixes that.
      await expect(layer.loadBase()).rejects.toMatchObject({
        message: expect.stringContaining('tile 404'),
        permanent: true,
      });

      expect(requests.filter((u) => u === missing)).toHaveLength(1);
      expect(sleeps).toHaveLength(0);
    });

    it('names the panorama and the face in the rejection', async () => {
      const layer = makeLayer('pano-a');
      respond = (url) => (url === baseUrl('ny') ? { status: 410 } : { status: 200 });

      await expect(layer.loadBase()).rejects.toThrow(/panorama "pano-a".*face "ny"/);
    });

    it('rejects when the network is down entirely', async () => {
      const layer = makeLayer();
      script = { status: 0, network: true };

      await expect(layer.loadBase()).rejects.toBeInstanceOf(BaseTileLoadError);
      // Every face got its full budget before the load was declared dead.
      expect(requests).toHaveLength(FACES.length * 3);
    });

    it('still feeds base failures to the shared monitor for cross-panorama detection', async () => {
      script = { status: 500 };

      const layerA = makeLayer('pano-a');
      await expect(layerA.loadBase()).rejects.toBeInstanceOf(BaseTileLoadError);
      // One panorama failing is bad tiles, not a bad origin.
      expect(monitor.escalationLevel).toBe(0);
      layerA.dispose();

      const layerB = makeLayer('pano-b');
      await expect(layerB.loadBase()).rejects.toBeInstanceOf(BaseTileLoadError);
      expect(monitor.escalationLevel).toBeGreaterThan(0);
      layerB.dispose();
    });

    it('is not suppressed by an active global backoff', async () => {
      // Trip the backoff the ordinary way, from two panoramas' per-frame loads.
      script = { status: 500 };
      const layerA = makeLayer('pano-a');
      await render(layerA, 0);
      layerA.dispose();
      const layerB = makeLayer('pano-b');
      await render(layerB, 0);
      expect(monitor.backingOff()).toBe(true);
      layerB.dispose();

      // A new load's base layer is six bounded, user-initiated requests, and it
      // is the difference between a viewer that shows something and one that
      // errors — so the backoff must not be allowed to decide it fails.
      script = { status: 200 };
      requests = [];
      const layerC = makeLayer('pano-c');
      await expect(layerC.loadBase()).resolves.toBeUndefined();
      expect(requests).toHaveLength(FACES.length);
    });

    it('does not reject when the layer is disposed mid-load', async () => {
      const layer = makeLayer();
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: { signal: AbortSignal }) => {
          requests.push(url);
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
          requests.push(url);
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
      const started = requests.length;
      expect(started).toBeGreaterThan(0);

      // update() left the rest of the candidate list queued behind the
      // concurrency limit. Disposing aborts what is in flight, and every abort
      // frees a slot — so without a disposed check the queue drains straight
      // into a second full round of fetches that are downloaded and decoded
      // only to be thrown away.
      layer.dispose();
      await flush();
      expect(requests).toHaveLength(started);
    });

    it('re-queues nothing from a frame rendered after dispose', async () => {
      const layer = makeLayer();
      stubHangingFetch();

      layer.dispose();
      frame(layer, 0);
      await flush();
      expect(requests).toHaveLength(0);
    });

    it('aborts a base-layer retry wait instead of sleeping it out', async () => {
      // The wait between base-tile attempts is seconds long. A disposal must be
      // noticed inside it, not after it: otherwise the loader wakes up in a
      // torn-down layer and issues another round of fetches (the measured
      // symptom was 3s of post-dispose fetch/sleep/retry activity).
      let waitSignal: AbortSignal | undefined;
      const layer = new TileLayer(
        renderer as unknown as GLRenderer,
        makeManifest('pano-a'),
        '/tiles/',
        128,
        () => {},
        8,
        monitor,
        (ms: number, signal: AbortSignal) => {
          sleeps.push(ms);
          waitSignal = signal;
          return new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      );
      script = { status: 503 };

      const load = layer.loadBase();
      await flush();
      // Every face failed its first attempt and is now waiting out a cooldown.
      expect(requests).toHaveLength(FACES.length);
      expect(sleeps).toHaveLength(FACES.length);
      expect(waitSignal?.aborted).toBe(false);

      layer.dispose();
      expect(waitSignal?.aborted).toBe(true);
      await expect(load).resolves.toBeUndefined();
      expect(requests).toHaveLength(FACES.length);
      expect(renderer.uploadTile).not.toHaveBeenCalled();
    });
  });

  describe('coarse fallback', () => {
    it('keeps drawing the base where a deeper tile is missing, instead of nothing', async () => {
      const layer = makeLayer();
      await layer.loadBase();
      const base = new Set(layer.drawList().map((d) => d.handle));
      expect(base.size).toBe(FACES.length);

      // Every tile below the base is gone for good — the worst case this whole
      // change exists for.
      respond = (url) => (url.includes('/0/') ? { status: 200 } : { status: 404 });
      await render(layer, 0);

      const list = layer.drawList();
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((d) => d.handle))).toEqual(base);
      expect(list.every((d) => d.level === 0)).toBe(true);
    });

    it('refines the base with deeper levels rather than replacing it', async () => {
      const layer = makeLayer();
      await layer.loadBase();
      await render(layer, 0);

      const list = layer.drawList();
      expect(list.some((d) => d.level === 0)).toBe(true);
      expect(list.some((d) => d.level > 0)).toBe(true);
      // Painter's order: the base paints first and the finer levels over it, so
      // a hole at any deeper level shows soft base texels, never the clear
      // colour.
      const levels = sortDrawList(list).map((d) => d.level);
      expect(levels[0]).toBe(0);
      expect(levels[levels.length - 1]).toBeGreaterThan(0);
    });

    it('never evicts the base, however much finer detail is loaded', async () => {
      // A budget small enough that a full sweep at maximum detail overflows it
      // — the whole pyramid at maxLevel 2 fits inside the default one.
      const layer = makeLayer('pano-a', 1);
      await layer.loadBase();
      const base = new Set(layer.drawList().map((d) => d.handle));

      // Sweep the whole sphere at full detail to push the cache past budget.
      for (let i = 0; i < 8; i++) await render(layer, (i * Math.PI) / 4);

      expect(renderer.removeTile).toHaveBeenCalled();
      const drawn = new Set(layer.drawList().map((d) => d.handle));
      for (const handle of base) expect(drawn.has(handle)).toBe(true);
    });
  });
});
