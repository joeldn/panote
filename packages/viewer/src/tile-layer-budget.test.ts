import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FACES, selectLevel, type Manifest } from '@panote/core';
import { TileLayer } from './tile-layer.js';
import { TileFailureMonitor } from './tile-retry.js';
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
  uploads = 0;
  uploadTile = (): number => {
    const handle = this.next++;
    this.uploads++;
    this.live.add(handle);
    return handle;
  };
  removeTile = (handle: number): void => {
    this.live.delete(handle);
  };
}

interface SweepResult {
  /** Tiles at the selected level the first frame had to fetch — the visible set. */
  visibleSet: number;
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

  /**
   * Two full 360° laps at 15° per frame: load the base, then pan the whole way
   * round twice and count what the cache had to do over again.
   */
  async function sweep(budgetMB: number, viewportHeight: number): Promise<SweepResult> {
    const layer = new TileLayer(
      renderer as unknown as GLRenderer,
      deepManifest(),
      '/tiles/',
      budgetMB,
      () => {},
      8,
      // A private monitor: this file's fetches all succeed, so no backoff can
      // trip, but sharing module state between sweeps would be a hidden input.
      new TileFailureMonitor(),
      () => Promise.resolve(),
    );
    await layer.loadBase();
    const baseHandles = new Set(renderer.live);
    expect(baseHandles.size).toBe(FACES.length);
    const afterBase = requests.length;

    const steps = 24;
    let visibleSet = 0;
    for (let i = 0; i < steps * 2; i++) {
      const yaw = (i * 2 * Math.PI) / steps;
      const view = { yaw, pitch: 0, fov: REQUESTED_FOV_DEG };
      layer.update(
        viewProjection(view, ASPECT, MAX_HORIZONTAL_FOV_DEG),
        FOV_DEG,
        dirFromYawPitch(yaw, 0),
        viewportHeight,
      );
      await flush();
      // Frame 1 starts from a cache holding only the base, so every tile it
      // fetches is one the frustum wants: that count is the visible set.
      if (i === 0) visibleSet = requests.length - afterBase;
    }

    const result: SweepResult = {
      visibleSet,
      fetches: requests.length,
      distinct: new Set(requests).size,
      refetches: requests.length - new Set(requests).size,
      evictions: renderer.uploads - renderer.live.size,
      baseHandles,
      liveAtEnd: new Set(renderer.live),
    };
    layer.dispose();
    return result;
  }

  it('selects one pyramid level finer on a DPR-2 display', () => {
    // The premise the rest of this file rests on, and the change 084c1ea made:
    // the same viewport picks level 2 from CSS pixels and level 3 from device
    // pixels, and level 3 is 4x the tiles per face.
    expect(selectLevel(FOV_DEG, CSS_PIXEL_HEIGHT, TILE_SIZE, 3)).toBe(2);
    expect(selectLevel(FOV_DEG, DEVICE_PIXEL_HEIGHT, TILE_SIZE, 3)).toBe(3);
  });

  it('had headroom to spare while levels were selected from CSS pixels', async () => {
    // The calibration 084c1ea invalidated: 128 MB is 128 tiles at tileSize 512
    // (512 * 512 * 4 = 1 MiB each), and level 2 puts 24 on screen — 5.3x the
    // visible set, so two full laps never evict anything and never refetch.
    const before = await sweep(128, CSS_PIXEL_HEIGHT);
    expect(before.visibleSet).toBe(24);
    expect(before.fetches).toBe(78);
    expect(before.refetches).toBe(0);
    expect(before.evictions).toBe(0);
  });

  it('thrashes on a DPR-2 display if the budget stays at the DPR-1 default', async () => {
    // Same panorama, same pan, same 128 MB — but level 3 puts 88 tiles on
    // screen, so the budget is 1.45x the visible set and the pan is spent
    // evicting tiles that are about to be wanted again.
    const unscaled = await sweep(128, DEVICE_PIXEL_HEIGHT);
    expect(unscaled.visibleSet).toBe(88);
    expect(unscaled.distinct).toBe(270);
    expect(unscaled.fetches).toBe(602);
    expect(unscaled.refetches).toBe(332);
    expect(unscaled.evictions).toBe(460);
  });

  it('cuts the refetching sharply once the budget scales with the pixel ratio', async () => {
    const unscaled = await sweep(128, DEVICE_PIXEL_HEIGHT);
    renderer = new FakeRenderer();
    requests = [];
    const scaled = await sweep(defaultTextureBudgetMB(2, 2), DEVICE_PIXEL_HEIGHT);

    // Same panorama, same pan, same tiles wanted — 256 MB is 256 tiles, 2.9x
    // the 88-tile visible set against 1.45x before.
    expect(scaled.visibleSet).toBe(unscaled.visibleSet);
    expect(scaled.distinct).toBe(unscaled.distinct);
    expect(scaled.fetches).toBe(370);
    expect(scaled.refetches).toBe(100);
    expect(scaled.evictions).toBe(112);

    // 3.3x fewer refetches and 4.1x fewer evictions, i.e. that much less
    // repeated decode-and-upload work per lap.
    expect(scaled.refetches * 3).toBeLessThan(unscaled.refetches);
    expect(scaled.evictions * 4).toBeLessThan(unscaled.evictions);
  });

  it('reduces the thrash rather than eliminating it, which is the cap being paid for', async () => {
    // Honesty about the residual: two full laps touch 270 distinct tiles and
    // 256 holds fewer, so the far side of a lap still displaces the near side.
    const scaled = await sweep(defaultTextureBudgetMB(2, 2), DEVICE_PIXEL_HEIGHT);
    expect(scaled.distinct).toBeGreaterThan(256);
    expect(scaled.refetches).toBeGreaterThan(0);

    // Eliminating it outright takes 3x, not 2x — the whole lap resident at
    // once. That is ~384 MB of base-level textures (~512 MB with mip levels)
    // on a display that is as likely to be a phone as a laptop, which is the
    // trade MAX_BUDGET_PIXEL_RATIO deliberately declines to make.
    renderer = new FakeRenderer();
    requests = [];
    const uncapped = await sweep(384, DEVICE_PIXEL_HEIGHT);
    expect(uncapped.refetches).toBe(0);
    expect(uncapped.evictions).toBe(0);
  });

  it('still never evicts the level-0 base under the scaled budget', async () => {
    // The floor the coarse fallback depends on: whatever the budget is, the six
    // level-0 tiles stay resident, so a missing finer tile degrades to soft
    // detail instead of to a hole.
    const scaled = await sweep(defaultTextureBudgetMB(2, 2), DEVICE_PIXEL_HEIGHT);
    expect(scaled.evictions).toBeGreaterThan(0); // eviction really did run
    for (const handle of scaled.baseHandles) expect(scaled.liveAtEnd.has(handle)).toBe(true);
  });
});
