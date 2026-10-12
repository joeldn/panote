import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FACES, type Face } from './cube.js';
import { BaseTileLoadError, TileLayer, type TileLayerOptions } from './tile-layer.js';
import { type CubeTileSource, type TileLoadInit } from './source.js';
import { viewProjection } from './render/projection.js';
import { type GLRenderer } from './render/gl-renderer.js';
import { TileHttpError } from './tile-retry.js';
import { dirFromYawPitch } from './test-support/oracles.js';
import { LAYER_DEFAULTS, makeSource, FakeRenderer } from './test-support/tile-layer-fixture.js';

describe('tile sources', () => {
  let renderer: FakeRenderer;
  let clock: number;

  beforeEach(() => {
    clock = 1_000_000;
    renderer = new FakeRenderer();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ close: vi.fn() })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const layerFor = (source: CubeTileSource, network = {}): TileLayer =>
    new TileLayer(renderer as unknown as GLRenderer, source, () => {}, {
      ...LAYER_DEFAULTS,
      textureBudgetMB: 128,
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;
        return Promise.resolve();
      },
      network,
    });

  it("requests exactly the URLs the source's tileUrl gives, with the request init", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const seen: Array<[string, RequestInit | undefined]> = [];
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      seen.push([url, init]);
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({}) });
    });
    const source: CubeTileSource = {
      id: 'scene-1',
      tileSize: 512,
      maxLevel: 2,
      tileUrl: (t) => `https://cdn.test/s1/v9/${t.level}/${t.face}/${t.x}-${t.y}.webp`,
    };
    const layer = layerFor(source, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      requestInit: { mode: 'cors', credentials: 'same-origin' },
    });
    await layer.loadBase();

    expect(seen.map(([url]) => url)).toEqual(
      FACES.map((f) => `https://cdn.test/s1/v9/0/${f}/0-0.webp`),
    );
    for (const [, init] of seen) {
      expect(init).toEqual({
        mode: 'cors',
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
        priority: 'high',
      });
    }
    expect(globalFetch).not.toHaveBeenCalled();
    layer.dispose();
  });

  it('sends a plain { signal, priority } through the global fetch without a request init', async () => {
    const fetch = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({}) }),
    );
    vi.stubGlobal('fetch', fetch);
    const layer = layerFor(makeSource('pano-a'));
    await layer.loadBase();
    expect(fetch).toHaveBeenCalledTimes(FACES.length);
    for (const [, init] of fetch.mock.calls) {
      expect(Object.keys(init!).sort()).toEqual(['priority', 'signal']);
    }
    layer.dispose();
  });

  it('loads through loadTile, with no fetch at all', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const decode = vi.mocked(createImageBitmap);
    const loadTile = vi.fn((_t: unknown, _init: TileLoadInit) =>
      Promise.resolve({ close: vi.fn() } as unknown as ImageBitmap),
    );
    const layer = layerFor({ id: 'gen', tileSize: 256, maxLevel: 1, loadTile });
    await layer.loadBase();

    expect(loadTile.mock.calls.map(([t]) => t)).toEqual(
      FACES.map((face) => ({ face, level: 0, x: 0, y: 0 })),
    );
    for (const [, init] of loadTile.mock.calls) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(['high', 'low']).toContain(init.priority);
    }
    // The first tiles a view needs go out at high priority, as a fetch would.
    expect(loadTile.mock.calls[0]![1].priority).toBe('high');
    expect(renderer.uploadTile).toHaveBeenCalledTimes(FACES.length);
    expect(fetch).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    layer.dispose();
  });

  it('classifies a TileHttpError from loadTile like a fetched status', async () => {
    const loadTile = vi.fn((t: { face: Face }) =>
      t.face === 'ny'
        ? Promise.reject(new TileHttpError(404))
        : Promise.resolve({ close: vi.fn() } as unknown as ImageBitmap),
    );
    const layer = layerFor({ id: 'gen', tileSize: 256, maxLevel: 0, loadTile });
    const err = await layer.loadBase().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaseTileLoadError);
    expect((err as BaseTileLoadError).sourceId).toBe('gen');
    expect((err as BaseTileLoadError).face).toBe('ny');
    expect((err as BaseTileLoadError).permanent).toBe(true);
    // Permanent: asked once, not retried.
    expect(loadTile.mock.calls.filter(([t]) => t.face === 'ny')).toHaveLength(1);
    layer.dispose();
  });

  it('releases an image loadTile hands back after the layer is gone', async () => {
    let finish: (img: ImageBitmap) => void = () => {};
    const loadTile = vi.fn(
      () =>
        new Promise<ImageBitmap>((resolve) => {
          finish = resolve;
        }),
    );
    const layer = layerFor({ id: 'gen', tileSize: 256, maxLevel: 0, loadTile });
    void layer.loadBase();
    layer.dispose();
    const close = vi.fn();
    finish({ close } as unknown as ImageBitmap);
    await new Promise((r) => setTimeout(r, 0));
    expect(close).toHaveBeenCalled();
    expect(renderer.uploadTile).not.toHaveBeenCalled();
  });
});

describe('layer options', () => {
  let renderer: FakeRenderer;
  let urls: string[];
  const fetch = (url: string) => {
    urls.push(url);
    return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({}) });
  };

  beforeEach(() => {
    renderer = new FakeRenderer();
    urls = [];
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ close: vi.fn() })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const layerWith = (opts: Partial<TileLayerOptions>): TileLayer =>
    new TileLayer(renderer as unknown as GLRenderer, makeSource('pano-a'), () => {}, {
      ...LAYER_DEFAULTS,
      textureBudgetMB: 128,
      now: () => 0,
      sleep: () => Promise.resolve(),
      network: { fetch: fetch as unknown as typeof globalThis.fetch },
      ...opts,
    });

  /** The finest level a 70° frame `height` device px tall asks for. */
  async function levelFor(opts: Partial<TileLayerOptions>, height: number): Promise<number> {
    const layer = layerWith(opts);
    await layer.loadBase();
    urls.length = 0;
    const view = { yaw: 0, pitch: 0, fov: 70 };
    layer.update(viewProjection(view, 1, 100), 70, dirFromYawPitch(0, 0), height);
    layer.dispose();
    // /tiles/pano-a/<level>/<face>/<x>-<y>.jpg
    return Math.max(...urls.map((u) => Number(u.split('/')[3])));
  }

  // The ideal level is log2(90 · height / (tileSize · fov)): 1.30 for 980 px
  // and 0.81 for 700 px at 512 px tiles and 70°. The level asked for is
  // ceil(ideal − 0.2 tolerance − lodBias).
  it('adds lodBias to the LOD tolerance: positive is coarser, negative finer', async () => {
    expect(await levelFor({}, 980)).toBe(2);
    expect(await levelFor({ lodBias: 0 }, 980)).toBe(2);
    expect(await levelFor({ lodBias: 0.2 }, 980)).toBe(1);
    expect(await levelFor({}, 700)).toBe(1);
    expect(await levelFor({ lodBias: -0.5 }, 700)).toBe(2);
  });

  it('decodes through network.decode when given', async () => {
    const decode = vi.fn((_blob: Blob) =>
      Promise.resolve({ close: vi.fn() } as unknown as ImageBitmap),
    );
    const layer = layerWith({
      network: { fetch: fetch as unknown as typeof globalThis.fetch, decode },
    });
    await layer.loadBase();
    expect(decode).toHaveBeenCalledTimes(FACES.length);
    expect(createImageBitmap).not.toHaveBeenCalled();
    layer.dispose();
  });

  it('keeps at least minResidentTiles, however small the budget', () => {
    const maxTiles = (layer: TileLayer) => (layer as unknown as { maxTiles: number }).maxTiles;
    expect(maxTiles(layerWith({ textureBudgetMB: 0 }))).toBe(24);
    expect(maxTiles(layerWith({ textureBudgetMB: 0, minResidentTiles: 40 }))).toBe(40);
  });

  it('spends the retry budget it is given', async () => {
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.resolve({ ok: false, status: 503, body: null });
    };
    const layer = layerWith({
      network: { fetch: failing as unknown as typeof globalThis.fetch },
      retry: { maxAttempts: 2, baseDelayMs: 10 },
    });
    await expect(layer.loadBase()).rejects.toBeInstanceOf(BaseTileLoadError);
    // Six faces, two attempts each.
    expect(calls).toBe(FACES.length * 2);
    layer.dispose();
  });
});
