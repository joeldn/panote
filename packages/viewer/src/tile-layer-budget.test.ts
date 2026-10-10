import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Manifest } from '@panote/core';
import { FACES } from './cube.js';
import { TileLayer } from './tile-layer.js';
import { defaultTextureBudgetMB } from './texture-budget.js';
import { viewProjection, effectiveVFovDeg } from './render/projection.js';
import { dirFromYawPitch } from './project.js';
import type { GLRenderer } from './render/gl-renderer.js';

// What this file measures, and why it is a separate harness from
// tile-layer.test.ts: nothing here fails, so there is no scripted status, no
// clock and no retry accounting — every request succeeds and the only thing
// under test is how much work the cache repeats while the camera pans.
//
// Node, no jsdom (see vitest.config.ts): fetch and createImageBitmap are
// hand-stubbed exactly as in tile-layer.test.ts.

/** 800 CSS px tall on a devicePixelRatio-2 display — what the renderer rasterises. */
const DEVICE_PIXEL_HEIGHT = 1600;
/** The same viewport measured the way PanoViewer measured it before 084c1ea. */
const CSS_PIXEL_HEIGHT = 800;
/** 1200 CSS px tall at devicePixelRatio 2: tall enough to select level 3. */
const TALL_PIXEL_HEIGHT = 2400;
/** 16:9, i.e. the 1422x800 CSS-pixel viewport the two heights above describe. */
const ASPECT = 16 / 9;
const REQUESTED_FOV_DEG = 70;
const MAX_HORIZONTAL_FOV_DEG = 100;
/** What PanoViewer's loop() passes to update() — the wide-screen cap applied. */
const FOV_DEG = effectiveVFovDeg(REQUESTED_FOV_DEG, MAX_HORIZONTAL_FOV_DEG, ASPECT);
const TILE_SIZE = 512;

/** A maxLevel-3 pyramid: 4096 px faces, i.e. a typical 16k equirect source. */
function deepManifest(): Manifest {
  return {
    pano: 'pano-a',
    faceSize: TILE_SIZE * 2 ** 3,
    tileSize: TILE_SIZE,
    maxLevel: 3,
    faces: FACES,
    quality: 82,
    format: 'jpg',
  };
}

class FakeRenderer {
  private next = 1;
  /**
   * Handles the fake GPU currently holds — a model of the resource, not a log
   * of calls on a mock. `uploads - live.size` is therefore the number of
   * textures that were decoded, uploaded and then thrown away, which is the
   * cost this budget exists to avoid paying twice.
   */
  live = new Set<number>();
  /** Tile URL behind each live handle, so a test can ask "is this tile resident?". */
  urls = new Map<number, string>();
  uploads = 0;
  uploadTile = (_geom: unknown, bitmap: { url: string }): number => {
    const handle = this.next++;
    this.uploads++;
    this.live.add(handle);
    this.urls.set(handle, bitmap.url);
    return handle;
  };
  removeTile = (handle: number): void => {
    this.live.delete(handle);
    this.urls.delete(handle);
  };
  residentUrls(): Set<string> {
    return new Set(this.urls.values());
  }
}

interface SweepResult {
  /** Every tile request issued during the sweep, base layer included. */
  fetches: number;
  /** Distinct tile URLs among them. */
  distinct: number;
  /** Requests for a tile that had already been fetched once: `fetches - distinct`. */
  refetches: number;
  /** Textures uploaded and later dropped: `uploads - live.size`. */
  evictions: number;
  /** Handles of the six level-0 tiles, which must survive the whole sweep. */
  baseHandles: Set<number>;
  /** Everything still resident at the end of the pan, before the layer is torn down. */
  liveAtEnd: Set<number>;
  /** Tiles requested for a view that were gone again while that view still held. */
  visibleEvicted: string[];
}

describe('texture budget while panning', () => {
  let renderer: FakeRenderer;
  let requests: string[];

  /** Drain every microtask chain update()/pump() started. */
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(() => {
    renderer = new FakeRenderer();
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        requests.push(url);
        return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ url }) });
      }),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn((blob: { url: string }) => Promise.resolve({ close: vi.fn(), url: blob.url })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Two full 360° laps at 15° per frame: load the base, then pan the whole way
   * round twice and count what the cache had to do over again. Every step is
   * rendered twice, the second time with the camera still, and every tile the
   * first frame asked for must still be resident after the second: those
   * tiles are on screen, and evicting one is the refetch loop.
   */
  async function sweep(budgetMB: number, viewportHeight: number): Promise<SweepResult> {
    const layer = new TileLayer(
      renderer as unknown as GLRenderer,
      deepManifest(),
      '/tiles/',
      budgetMB,
      () => {},
      8,
      () => 0,
      () => Promise.resolve(),
    );
    await layer.loadBase();
    const baseHandles = new Set(renderer.live);
    expect(baseHandles.size).toBe(FACES.length);

    const visibleEvicted: string[] = [];
    const steps = 24;
    for (let i = 0; i < steps * 2; i++) {
      const yaw = (i * 2 * Math.PI) / steps;
      const view = { yaw, pitch: 0, fov: REQUESTED_FOV_DEG };
      const render = (): void =>
        layer.update(
          viewProjection(view, ASPECT, MAX_HORIZONTAL_FOV_DEG),
          FOV_DEG,
          dirFromYawPitch(yaw, 0),
          viewportHeight,
        );
      const before = requests.length;
      render();
      await flush();
      const wanted = requests.slice(before);
      render();
      await flush();
      const resident = renderer.residentUrls();
      for (const url of wanted) if (!resident.has(url)) visibleEvicted.push(url);
    }

    const result: SweepResult = {
      fetches: requests.length,
      distinct: new Set(requests).size,
      refetches: requests.length - new Set(requests).size,
      evictions: renderer.uploads - renderer.live.size,
      baseHandles,
      liveAtEnd: new Set(renderer.live),
      visibleEvicted,
    };
    layer.dispose();
    return result;
  }

  /** A sweep on a fresh renderer and request log. */
  async function freshSweep(budgetMB: number, viewportHeight: number): Promise<SweepResult> {
    renderer = new FakeRenderer();
    requests = [];
    return sweep(budgetMB, viewportHeight);
  }

  it('keeps every visible tile when the visible set is bigger than the budget', async () => {
    // 1 MB is the 24-tile floor, against more on screen at level 3. Evicting by
    // overflow alone would drop visible tiles, refetch them next frame and
    // drop them again, forever, with the camera standing still.
    const layer = new TileLayer(
      renderer as unknown as GLRenderer,
      deepManifest(),
      '/tiles/',
      1,
      () => {},
      8,
      () => 0,
      () => Promise.resolve(),
    );
    await layer.loadBase();
    const view = { yaw: 0, pitch: 0, fov: REQUESTED_FOV_DEG };
    const still = (): void =>
      layer.update(
        viewProjection(view, ASPECT, MAX_HORIZONTAL_FOV_DEG),
        FOV_DEG,
        dirFromYawPitch(0, 0),
        TALL_PIXEL_HEIGHT,
      );
    still();
    for (let i = 0; i < 3; i++) await flush();
    const loaded = requests.length;
    const resident = new Set(renderer.live);
    expect(resident.size).toBeGreaterThan(24);

    for (let i = 0; i < 5; i++) {
      still();
      await flush();
    }
    expect(requests).toHaveLength(loaded);
    expect(renderer.live).toEqual(resident);
    layer.dispose();
  });

  it('never refetches when a whole lap fits in the budget', async () => {
    // At CSS-pixel height the lap touches far fewer tiles than 128 MB holds.
    const roomy = await sweep(128, CSS_PIXEL_HEIGHT);
    expect(roomy.refetches).toBe(0);
    expect(roomy.evictions).toBe(0);
  });

  it('refetches less as the budget grows, and not at all once the lap fits', async () => {
    // Same panorama, same pan, same tiles wanted at every budget.
    const budgets = [1, 64, 128, defaultTextureBudgetMB(2, 2), 512];
    const results: SweepResult[] = [];
    for (const budget of budgets) results.push(await freshSweep(budget, DEVICE_PIXEL_HEIGHT));

    for (const r of results) expect(r.distinct).toBe(results[0]!.distinct);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.refetches).toBeLessThanOrEqual(results[i - 1]!.refetches);
      expect(results[i]!.evictions).toBeLessThanOrEqual(results[i - 1]!.evictions);
    }
    // The floor budget really is under pressure, and 512 MB holds the lap.
    expect(results[0]!.refetches).toBeGreaterThan(0);
    expect(results.at(-1)!.refetches).toBe(0);
    expect(results.at(-1)!.evictions).toBe(0);
  });

  it('never evicts the level-0 base or a tile on screen, at any budget', async () => {
    // The floor the coarse fallback depends on: whatever the budget is, the six
    // level-0 tiles stay resident, so a missing finer tile degrades to soft
    // detail instead of to a hole. And a tile in view stays in view.
    for (const budget of [1, 128, defaultTextureBudgetMB(2, 2)]) {
      const r = await freshSweep(budget, DEVICE_PIXEL_HEIGHT);
      expect(r.visibleEvicted).toEqual([]);
      for (const handle of r.baseHandles) expect(r.liveAtEnd.has(handle)).toBe(true);
      if (budget === 1) expect(r.evictions).toBeGreaterThan(0); // eviction really did run
    }
  });
});
