import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Manifest } from '@panote/core';
import { FACES, faceUVToDir, tileCornersUV, type Face } from './cube.js';
import { BaseTileLoadError, TileLayer } from './tile-layer.js';
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
// Time is injected: TileLayer takes the clock it measures retry cooldowns
// against, so every delay in these tests is advanced by hand rather than
// waited on, and no test sleeps. The wake timer tests fake setTimeout as well
// and advance both together.

const TILE_COOLDOWN_MS = 1_000; // first per-tile retry delay (tile-retry.ts)
const ABORT_AFTER_FRAMES = 10; // frames out of view before a load is aborted

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

  function makeLayer(
    pano = 'pano-a',
    textureBudgetMB = 128,
    onInvalidate: () => void = () => {},
  ): TileLayer {
    return new TileLayer(
      renderer as unknown as GLRenderer,
      makeManifest(pano),
      '/tiles/',
      textureBudgetMB,
      onInvalidate,
      8,
      () => clock,
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

  /**
   * One render frame at the given yaw, matching PanoViewer's loop() call: an
   * 800 px tall square view at devicePixelRatio 2, which selects level 2.
   */
  function frame(layer: TileLayer, yaw: number): void {
    const view = { yaw, pitch: 0, fov: 70 };
    layer.update(viewProjection(view, 1, 100), 70, dirFromYawPitch(yaw, 0), 1600);
  }

  /** Enough frames at `yaw` for loads from the previous view to be aborted. */
  function stayAt(layer: TileLayer, yaw: number): void {
    for (let i = 0; i <= ABORT_AFTER_FRAMES; i++) frame(layer, yaw);
  }

  /**
   * Load every level-1 tile, then forget the requests and uploads it took.
   * At level 2 the layer fetches a missing tile's level-1 parent first; with
   * them all resident, a test sees only level-2 requests.
   */
  async function withLevel1(layer: TileLayer): Promise<TileLayer> {
    const views = [
      [0, 0],
      [Math.PI / 2, 0],
      [Math.PI, 0],
      [-Math.PI / 2, 0],
      [0, 1.5],
      [0, -1.5],
    ] as const;
    for (const [yaw, pitch] of views) {
      const view = { yaw, pitch, fov: 70 };
      const at = (): void =>
        layer.update(viewProjection(view, 1, 100), 70, dirFromYawPitch(yaw, pitch), 800);
      at();
      await flush();
      for (let i = 0; i < 100 && readyCount(layer) > 0; i++) {
        at();
        await flush();
      }
    }
    const { cache } = layer as unknown as { cache: Map<string, unknown> };
    expect([...cache.keys()].filter((k) => k.startsWith('1/'))).toHaveLength(24);
    requests = [];
    renderer.uploadTile.mockClear();
    return layer;
  }

  /** Decoded tiles waiting for a frame to upload them. */
  const readyCount = (layer: TileLayer): number =>
    (layer as unknown as { ready: Map<string, unknown> }).ready.size;

  /**
   * One frame and the loads it starts, then the frames the layer asks for
   * while decoded tiles wait to be uploaded (a few go up per frame), as the
   * viewer's invalidate-driven loop would draw them.
   */
  async function render(layer: TileLayer, yaw: number): Promise<void> {
    frame(layer, yaw);
    await flush();
    for (let i = 0; i < 100 && readyCount(layer) > 0; i++) {
      frame(layer, yaw);
      await flush();
    }
  }

  beforeEach(() => {
    clock = 1_000_000;
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

  describe('idle retry wake', () => {
    // Fake timers for the wake itself; the retry clock is advanced alongside.
    // Microtasks are drained by hand, since flush() waits on a real timer.
    const drain = async (): Promise<void> => {
      for (let i = 0; i < 50; i++) await Promise.resolve();
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Fail exactly one non-base tile once, transiently; everything else loads. */
    function failOneTileOnce(): () => string | undefined {
      let failed: string | undefined;
      respond = (url) => {
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
      expect(requests.filter((u) => u === failed())).toHaveLength(2);
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
    stayAt(layer, Math.PI); // pans away — update() aborts what is no longer wanted
    await flush();

    // No attempt spent, no cooldown started, no evidence recorded: *these*
    // tiles come straight back. If an abort burned a retry attempt they would
    // be held off by their per-tile cooldown and the next-best candidates
    // would be fetched in their place, which is the same count and the wrong
    // tiles.
    requests = [];
    stayAt(layer, 0); // and back, which in turn aborts the loads for PI
    await flush();
    expect(new Set(requests)).toEqual(new Set(abortedTiles));
    expect(requests).toHaveLength(abortedTiles.length);
    layer.dispose();
  });

  describe('scheduling', () => {
    /** Unit direction through the centre of the tile a URL names. */
    function centreDir(url: string): { x: number; y: number; z: number } {
      const m = /\/(\d+)\/(\w+)\/(\d+)-(\d+)\.jpg$/.exec(url)!;
      const corners = tileCornersUV(Number(m[1]), Number(m[3]), Number(m[4]));
      const d = faceUVToDir(
        m[2] as Face,
        (corners[0]!.u + corners[1]!.u) / 2,
        (corners[0]!.v + corners[2]!.v) / 2,
      );
      const len = Math.hypot(d.x, d.y, d.z);
      return { x: d.x / len, y: d.y / len, z: d.z / len };
    }

    function facing(url: string, yaw: number): number {
      const c = centreDir(url);
      const f = dirFromYawPitch(yaw, 0);
      return c.x * f.x + c.y * f.y + c.z * f.z;
    }

    it('requests tiles nearest the centre of the view first', async () => {
      const layer = await withLevel1(makeLayer());
      await render(layer, 0);
      expect(requests.length).toBeGreaterThan(8);
      const dots = requests.map((u) => facing(u, 0));
      for (let i = 1; i < dots.length; i++) expect(dots[i]).toBeLessThanOrEqual(dots[i - 1]!);
      layer.dispose();
    });

    it('never requests a tile behind the camera', async () => {
      const layer = makeLayer();
      for (const yaw of [0, Math.PI / 2, Math.PI]) {
        requests = [];
        await render(layer, yaw);
        expect(requests.length).toBeGreaterThan(0);
        for (const url of requests) expect(facing(url, yaw)).toBeGreaterThan(0);
      }
      layer.dispose();
    });

    it('never has more than maxConcurrent loads open, even while aborted ones are still decoding', async () => {
      // createImageBitmap ignores the abort signal, so a load aborted after
      // its response arrived keeps decoding. Its slot is freed at the abort,
      // which is right: the layer only counts loads it can still cancel.
      const inflight = (l: TileLayer) =>
        (l as unknown as { inflight: Map<string, AbortController> }).inflight;
      const decoding = new Set<number>();
      const held: (() => void)[] = [];
      const signals: AbortSignal[] = [];
      let peak = 0;
      let overlapped = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: { signal: AbortSignal }) => {
          requests.push(url);
          const id = signals.push(init.signal) - 1;
          return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ id }) });
        }),
      );
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(
          ({ id }: { id: number }) =>
            new Promise((resolve) => {
              decoding.add(id);
              held.push(() => {
                decoding.delete(id);
                resolve({ close: vi.fn() });
              });
            }),
        ),
      );
      const layer = makeLayer();
      const check = (): void => {
        const live = [...decoding].filter((id) => !signals[id]!.aborted).length;
        overlapped = Math.max(overlapped, decoding.size - live);
        peak = Math.max(peak, inflight(layer).size);
        expect(inflight(layer).size).toBeLessThanOrEqual(8);
        expect(live).toBeLessThanOrEqual(8);
      };
      for (const yaw of [0, Math.PI, 0, Math.PI / 2, 0]) {
        stayAt(layer, yaw);
        await flush();
        check();
        // Release half the decodes, so aborted ones keep overlapping new loads.
        for (const release of held.splice(0, Math.ceil(held.length / 2))) release();
        await flush();
        check();
      }
      expect(peak).toBe(8);
      // Aborted loads really were still decoding next to eight live ones.
      expect(overlapped).toBeGreaterThan(0);
      layer.dispose();
    });
  });

  describe('in-flight ownership', () => {
    /** The layer's private maps, read to check its accounting directly. */
    function internals(layer: TileLayer): {
      cache: Map<string, unknown>;
      inflight: Map<string, AbortController>;
    } {
      return layer as unknown as {
        cache: Map<string, unknown>;
        inflight: Map<string, AbortController>;
      };
    }

    /** '/tiles/pano-a/2/px/1-0.jpg' -> '2/px/1-0', the layer's cache key. */
    const keyOf = (url: string): string =>
      url.replace(/^\/tiles\/[^/]+\//, '').replace(/\.jpg$/, '');

    it('does not leak a texture or lose track of a reload when a tile is aborted mid-decode', async () => {
      const live = new Set<number>();
      let next = 0;
      renderer.uploadTile.mockImplementation(() => {
        live.add(++next);
        return next;
      });
      renderer.removeTile.mockImplementation((handle: number) => {
        live.delete(handle);
      });
      const layer = await withLevel1(makeLayer());
      // Decodes are held until released, so an abort can land between the
      // response arriving and the bitmap being ready: createImageBitmap does
      // not take the abort signal.
      const held: (() => void)[] = [];
      let holding = true;
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(
          () =>
            new Promise((resolve) => {
              const done = (): void => resolve({ close: vi.fn() });
              if (holding) held.push(done);
              else done();
            }),
        ),
      );

      frame(layer, 0);
      await flush();
      const first = [...requests];
      expect(held).toHaveLength(first.length);

      // Pan away while those decode (aborting them), then back, which starts
      // a second load of each one.
      stayAt(layer, Math.PI);
      stayAt(layer, 0);
      await flush();
      for (const url of first) expect(requests.filter((u) => u === url)).toHaveLength(2);

      // The first, aborted round finishes decoding. The reloads are still in
      // flight and must stay tracked as such.
      const firstRound = held.splice(0, first.length);
      for (const release of firstRound) release();
      await flush();
      const { cache, inflight } = internals(layer);
      for (const url of first) expect(inflight.has(keyOf(url))).toBe(true);

      // Then everything else finishes.
      holding = false;
      for (const release of held.splice(0)) release();
      for (let i = 0; i < 5; i++) await flush();

      expect(inflight.size).toBe(0);
      // Every texture the renderer still holds is one the cache can free.
      expect(live.size).toBe(cache.size);
      layer.dispose();
      expect(live.size).toBe(0);
    });
  });

  describe('bitmap lifetime', () => {
    function trackBitmaps(): { close: ReturnType<typeof vi.fn> }[] {
      const bitmaps: { close: ReturnType<typeof vi.fn> }[] = [];
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(() => {
          const bitmap = { close: vi.fn() };
          bitmaps.push(bitmap);
          return Promise.resolve(bitmap);
        }),
      );
      return bitmaps;
    }

    it('closes every decoded bitmap once it is uploaded', async () => {
      const bitmaps = trackBitmaps();
      const layer = makeLayer();
      await render(layer, 0);
      expect(bitmaps.length).toBeGreaterThan(0);
      expect(bitmaps).toHaveLength(renderer.uploadTile.mock.calls.length);
      for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1);
      layer.dispose();
    });

    it('decodes tiles upright, with no flipY', async () => {
      const layer = makeLayer();
      const base = layer.loadBase();
      await render(layer, 0);
      await base;
      const decode = vi.mocked(createImageBitmap);
      expect(decode.mock.calls.length).toBeGreaterThan(FACES.length);
      for (const args of decode.mock.calls) {
        // Upright is the default; any option that flips it is a regression.
        expect(args).toHaveLength(1);
      }
      layer.dispose();
    });

    it('still closes the bitmap when the upload throws', async () => {
      const bitmaps = trackBitmaps();
      renderer.uploadTile.mockImplementation(() => {
        throw new Error('context lost');
      });
      const layer = makeLayer();
      await render(layer, 0);
      expect(bitmaps.length).toBeGreaterThan(0);
      for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1);
      layer.dispose();
    });
  });

  describe('fetch priority and parents', () => {
    /** The `priority` each tile request was made with, in request order. */
    function priorities(): { url: string; priority: unknown }[] {
      return vi
        .mocked(fetch)
        .mock.calls.map(([url, init]) => ({ url: String(url), priority: init?.priority }));
    }

    it('fetches the base at high priority', async () => {
      const layer = makeLayer();
      await layer.loadBase();
      const base = priorities().filter((r) => r.url.includes('/0/'));
      expect(base).toHaveLength(FACES.length);
      for (const r of base) expect(r.priority).toBe('high');
      layer.dispose();
    });

    it('fetches the four tiles nearest the centre at high priority and the rest low', async () => {
      const layer = await withLevel1(makeLayer());
      vi.mocked(fetch).mockClear();
      frame(layer, 0);
      const sent = priorities();
      expect(sent.length).toBe(8);
      expect(sent.map((r) => r.priority)).toEqual([
        'high',
        'high',
        'high',
        'high',
        'low',
        'low',
        'low',
        'low',
      ]);
      layer.dispose();
    });

    it('fetches the missing parent level first, once per parent', async () => {
      const layer = makeLayer(); // only level 2 is wanted, and no level 1 is resident
      await render(layer, 0);
      const levels = requests.map((u) => Number(/\/tiles\/[^/]+\/(\d+)\//.exec(u)![1]));
      expect(levels).toContain(1);
      expect(levels).toContain(2);
      // Every parent is asked for before the first level-2 tile.
      expect(levels.lastIndexOf(1)).toBeLessThan(levels.indexOf(2));
      expect(new Set(requests).size).toBe(requests.length);
      // Each level-2 tile's parent was among them.
      const parentOf = (u: string): string =>
        u.replace(/\/2\/(\w+)\/(\d+)-(\d+)\.jpg$/, (_m, f: string, x: string, y: string) => {
          return `/1/${f}/${Number(x) >> 1}-${Number(y) >> 1}.jpg`;
        });
      for (const u of requests.filter((r) => r.includes('/2/'))) {
        expect(requests).toContain(parentOf(u));
      }
      layer.dispose();
    });

    it('queues each parent once, however many of its children are missing', () => {
      const layer = makeLayer();
      frame(layer, 0);
      const { candidates } = layer as unknown as { candidates: { key: string }[] };
      const keys = candidates.map((c) => c.key);
      expect(keys.some((k) => k.startsWith('1/'))).toBe(true);
      expect(new Set(keys).size).toBe(keys.length);
      layer.dispose();
    });

    it('keeps a resident parent while it stands in for a missing child', async () => {
      const layer = await withLevel1(makeLayer());
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {})),
      );
      // Over budget by a few tiles. The level-1 tiles loaded first, the ones
      // facing yaw 0, are the least recently used.
      (layer as unknown as { maxTiles: number }).maxTiles = 20;
      frame(layer, 0);
      const { cache, desired } = layer as unknown as {
        cache: Map<string, unknown>;
        desired: Set<string>;
      };
      expect(cache.size).toBe(20); // four of the 24 went
      expect(desired.size).toBeGreaterThan(0);
      for (const key of desired) {
        const [, face, xy] = key.split('/') as [string, string, string];
        const [x, y] = xy.split('-').map(Number) as [number, number];
        expect(cache.has(`1/${face}/${x >> 1}-${y >> 1}`)).toBe(true);
      }
      layer.dispose();
    });

    it('skips the parents when they are already resident', async () => {
      const layer = await withLevel1(makeLayer());
      await render(layer, 0);
      expect(requests.length).toBeGreaterThan(0);
      for (const u of requests) expect(u).toContain('/2/');
      layer.dispose();
    });
  });

  describe('abort hysteresis', () => {
    /** Fetches that never answer, with each request's signal kept by URL. */
    function holdFetches(): Map<string, AbortSignal> {
      const signals = new Map<string, AbortSignal>();
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: { signal: AbortSignal }) => {
          requests.push(url);
          signals.set(url, init.signal);
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        }),
      );
      return signals;
    }

    /** A frame at yaw 0 with the given device-pixel height (800: level 1, 1600: level 2). */
    function frameAt(layer: TileLayer, yaw: number, height: number): void {
      const view = { yaw, pitch: 0, fov: 70 };
      layer.update(viewProjection(view, 1, 100), 70, dirFromYawPitch(yaw, 0), height);
    }

    it('aborts a load only after it has been out of view for more than ten frames', async () => {
      const layer = await withLevel1(makeLayer());
      const signals = holdFetches();
      frame(layer, 0);
      const first = [...requests];
      expect(first.length).toBeGreaterThan(0);

      frame(layer, Math.PI); // out for one frame of a pan
      frame(layer, 0);
      for (const url of first) expect(signals.get(url)!.aborted).toBe(false);

      for (let i = 0; i < ABORT_AFTER_FRAMES; i++) frame(layer, Math.PI);
      for (const url of first) expect(signals.get(url)!.aborted).toBe(false);
      frame(layer, Math.PI); // the eleventh
      for (const url of first) expect(signals.get(url)!.aborted).toBe(true);
      await flush();
      layer.dispose();
    });

    it('starts the count again when a tile comes back into view', () => {
      const signals = holdFetches();
      const layer = makeLayer();
      frame(layer, 0);
      const first = [...requests];
      for (let i = 0; i < 6; i++) frame(layer, Math.PI);
      frame(layer, 0);
      for (let i = 0; i < 6; i++) frame(layer, Math.PI);
      for (const url of first) expect(signals.get(url)!.aborted).toBe(false);
      layer.dispose();
    });

    it('keeps loading the level below after a zoom-in step', () => {
      const signals = holdFetches();
      const layer = makeLayer();
      frameAt(layer, 0, 800);
      const coarse = [...requests];
      expect(coarse.length).toBeGreaterThan(0);
      for (const url of coarse) expect(url).toContain('/1/');

      // One level finer: the level-1 tiles are out of the desired set, but
      // they still beat the base as a fallback until level 2 lands.
      for (let i = 0; i <= ABORT_AFTER_FRAMES * 2; i++) frameAt(layer, 0, 1600);
      for (const url of coarse) expect(signals.get(url)!.aborted).toBe(false);
      layer.dispose();
    });

    it('does not count loads that are only finishing out of view as pending', async () => {
      const layer = makeLayer();
      await render(layer, Math.PI); // everything behind is resident
      expect(layer.hasPending()).toBe(false);

      frame(layer, 0); // starts loads for the front
      frame(layer, Math.PI); // and turns straight back
      const { inflight } = layer as unknown as { inflight: Map<string, unknown> };
      expect(inflight.size).toBeGreaterThan(0);
      expect(layer.hasPending()).toBe(false);

      await flush(); // they land, decoded, while still out of view
      expect(readyCount(layer)).toBeGreaterThan(0);
      expect(layer.hasPending()).toBe(false);
      layer.dispose();
    });

    it('aborts the finer level after a zoom-out step', () => {
      const signals = holdFetches();
      const layer = makeLayer();
      frameAt(layer, 0, 1600);
      const fine = requests.filter((u) => u.includes('/2/'));
      expect(fine.length).toBeGreaterThan(0);
      for (let i = 0; i <= ABORT_AFTER_FRAMES; i++) frameAt(layer, 0, 800);
      for (const url of fine) expect(signals.get(url)!.aborted).toBe(true);
      layer.dispose();
    });
  });

  describe('upload batching', () => {
    /** Decodes held until released, each bitmap tracked. */
    function holdDecodes(): {
      bitmaps: { close: ReturnType<typeof vi.fn> }[];
      release: () => void;
    } {
      const bitmaps: { close: ReturnType<typeof vi.fn> }[] = [];
      const held: (() => void)[] = [];
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(
          () =>
            new Promise((resolve) => {
              const bitmap = { close: vi.fn() };
              bitmaps.push(bitmap);
              held.push(() => resolve(bitmap));
            }),
        ),
      );
      return { bitmaps, release: () => held.splice(0).forEach((r) => r()) };
    }

    it('uploads at most three decoded tiles per frame', async () => {
      const decodes = holdDecodes();
      const layer = makeLayer();
      frame(layer, 0);
      await flush();
      expect(decodes.bitmaps).toHaveLength(8);
      decodes.release(); // all eight land together
      await flush();
      expect(renderer.uploadTile).not.toHaveBeenCalled();

      const perFrame: number[] = [];
      for (let i = 0; i < 6; i++) {
        const before = renderer.uploadTile.mock.calls.length;
        frame(layer, 0);
        perFrame.push(renderer.uploadTile.mock.calls.length - before);
        decodes.release();
        await flush();
      }
      expect(perFrame[0]).toBe(3);
      for (const n of perFrame) expect(n).toBeLessThanOrEqual(3);
      layer.dispose();
    });

    it('stops uploading for the frame once the time budget is spent', async () => {
      const decodes = holdDecodes();
      const layer = makeLayer();
      frame(layer, 0);
      await flush();
      decodes.release();
      await flush();
      // Each upload takes 3 ms on the layer's clock: two fit in 4 ms, a third
      // would start after it.
      renderer.uploadTile.mockImplementation(() => {
        advance(3);
        return renderer.uploadTile.mock.calls.length;
      });
      frame(layer, 0);
      expect(renderer.uploadTile).toHaveBeenCalledTimes(2);
      layer.dispose();
    });

    it('closes a decoded tile that left the view instead of uploading it', async () => {
      const layer = await withLevel1(makeLayer());
      const decodes = holdDecodes();
      frame(layer, 0);
      await flush();
      const first = [...decodes.bitmaps];
      decodes.release();
      await flush();
      // The decoded tiles are behind the camera now. They wait out the same
      // frames an in-flight load would, without being uploaded, then go.
      frame(layer, Math.PI);
      expect(readyCount(layer)).toBe(first.length);
      for (const bitmap of first) expect(bitmap.close).not.toHaveBeenCalled();
      stayAt(layer, Math.PI);
      expect(renderer.uploadTile).not.toHaveBeenCalled();
      for (const bitmap of first) expect(bitmap.close).toHaveBeenCalledTimes(1);
      expect(readyCount(layer)).toBe(0);
      layer.dispose();
    });

    it('stays pending while decoded tiles wait, and asks for frames to upload them', async () => {
      const invalidate = vi.fn();
      const layer = makeLayer('pano-a', 128, invalidate);
      frame(layer, 0);
      // No further frames: every wanted tile is fetched and decoded, so
      // nothing is in flight or queued, and all of it waits to be uploaded.
      for (let i = 0; i < 5; i++) await flush();
      const { inflight } = layer as unknown as { inflight: Map<string, unknown> };
      expect(inflight.size).toBe(0);
      expect(readyCount(layer)).toBeGreaterThan(3);
      expect(layer.hasPending()).toBe(true);
      expect(invalidate).toHaveBeenCalled();
      for (let i = 0; i < 100 && readyCount(layer) > 0; i++) frame(layer, 0);
      expect(layer.hasPending()).toBe(false);
      layer.dispose();
    });

    it('closes queued bitmaps on dispose', async () => {
      const decodes = holdDecodes();
      const layer = makeLayer();
      frame(layer, 0);
      await flush();
      const queued = [...decodes.bitmaps];
      decodes.release();
      await flush();
      expect(readyCount(layer)).toBe(queued.length);
      layer.dispose();
      for (const bitmap of queued) expect(bitmap.close).toHaveBeenCalledTimes(1);
    });
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

    it('is not aborted by a frame rendered while the base is still loading', async () => {
      // Level-0 keys are never in a deeper level's desired set, so a frame that
      // runs before the base has landed must leave those fetches alone.
      const signals = new Map<string, AbortSignal>();
      const pending: (() => void)[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: { signal: AbortSignal }) => {
          requests.push(url);
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
      expect(requests.some((u) => u.includes('/2/'))).toBe(true);
      for (const signal of signals.values()) expect(signal.aborted).toBe(false);

      for (const release of pending) release();
      await expect(load).resolves.toBeUndefined();
      expect(requests.filter((u) => u.includes('/0/'))).toHaveLength(FACES.length);
      layer.dispose();
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
        () => clock,
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

    it('hands out the same draw items every frame instead of allocating new ones', async () => {
      const layer = makeLayer();
      await layer.loadBase();
      await render(layer, 0);
      const first = [...layer.drawList()];
      frame(layer, 0);
      const second = layer.drawList();
      expect(second).toHaveLength(first.length);
      for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]);
      layer.dispose();
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

describe('manifest version', () => {
  let clock: number;
  let renderer: FakeRenderer;
  let requests: string[];
  let sleeps: number[];

  beforeEach(() => {
    clock = 1_000_000;
    renderer = new FakeRenderer();
    requests = [];
    sleeps = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        requests.push(url);
        return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({}) });
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

  function makeLayerWithManifest(manifest: Manifest, textureBudgetMB = 128): TileLayer {
    return new TileLayer(
      renderer as unknown as GLRenderer,
      manifest,
      '/tiles/',
      textureBudgetMB,
      () => {},
      8,
      () => clock,
      (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    );
  }

  it('requests unversioned tile URLs when the manifest has no version', async () => {
    const manifest: Manifest = {
      pano: 'pano-a',
      faceSize: 2048,
      tileSize: 512,
      maxLevel: 2,
      faces: FACES,
      quality: 82,
      format: 'jpg',
    };
    const layer = makeLayerWithManifest(manifest);
    await layer.loadBase();

    for (const face of FACES) {
      expect(requests).toContain(`/tiles/pano-a/0/${face}/0-0.jpg`);
    }
  });

  it('requests tile URLs under the manifest version when present', async () => {
    const manifest: Manifest = {
      pano: 'pano-a',
      faceSize: 2048,
      tileSize: 512,
      maxLevel: 2,
      faces: FACES,
      quality: 82,
      format: 'jpg',
      version: 't1-abc123',
    };
    const layer = makeLayerWithManifest(manifest);
    await layer.loadBase();

    for (const face of FACES) {
      expect(requests).toContain(`/tiles/pano-a/t1-abc123/0/${face}/0-0.jpg`);
      expect(requests).not.toContain(`/tiles/pano-a/0/${face}/0-0.jpg`);
    }
  });
});
