/**
 * The fixture the tile-layer*.test.ts files share: a fake renderer, a
 * scripted fetch and an injected clock. TileLayer takes the clock it
 * measures retry cooldowns against, so every delay is advanced by hand and no
 * test sleeps; the wake-timer tests fake setTimeout as well and advance both.
 * Node, not jsdom: see vitest.config.ts.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { VIEWER_DEFAULTS } from '../defaults.js';
import type { GLRenderer } from '../render/gl-renderer.js';
import { viewProjection } from '../render/projection.js';
import { urlTemplateSource, type CubeTileSource } from '../source.js';
import { TileLayer } from '../tile-layer.js';
import { dirFromYawPitch } from './oracles.js';

/** The resolved defaults a viewer hands every layer it builds. */
export const LAYER_DEFAULTS = {
  maxConcurrent: VIEWER_DEFAULTS.network.maxConcurrent,
  minResidentTiles: VIEWER_DEFAULTS.memory.minResidentTiles,
  lodBias: VIEWER_DEFAULTS.rendering.lodBias,
  retry: VIEWER_DEFAULTS.network.retry,
};

/** The first per-tile retry wait, ms (the default `network.retry.baseDelayMs`). */
export const TILE_COOLDOWN_MS = VIEWER_DEFAULTS.network.retry.baseDelayMs;
/** How long a load may be out of view before it is aborted, ms (tile-layer.ts). */
export const ABORT_GRACE_MS = 160;
export const FRAME_MS = 1000 / 60;
/** 60 Hz frames the abort grace lasts. */
export const ABORT_AFTER_FRAMES = 10;

/** A maxLevel-2 source whose tiles are at `/tiles/<id>/<level>/<face>/<x>-<y>.jpg`. */
export function makeSource(id: string): CubeTileSource {
  return urlTemplateSource({
    id,
    template: `/tiles/${id}/{level}/{face}/{x}-{y}.jpg`,
    tileSize: 512,
    maxLevel: 2,
  });
}

export class FakeRenderer {
  private next = 1;
  uploadTile = vi.fn(() => this.next++);
  removeTile = vi.fn();
}

/** How the scripted fetch answers: a response with `status`, or with `network`, a rejected fetch (offline, DNS, reset). */
export interface Scripted {
  status: number;
  network?: boolean;
}

/** '/tiles/pano-a/2/px/1-0.jpg' -> '2/px/1-0', the layer's cache key. */
export const keyOf = (url: string): string =>
  url.replace(/^\/tiles\/[^/]+\//, '').replace(/\.jpg$/, '');

/** Microtasks only: for tests that fake setTimeout, where flush() would hang. */
export const drain = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

export interface LayerFixture {
  /** The layer's clock, ms. */
  clock: number;
  renderer: FakeRenderer;
  /** Every URL fetched, in order. */
  requests: string[];
  /** How every request is answered, unless `respond` says otherwise. */
  script: Scripted;
  /** Per-URL answer; falls back to `script` when it returns null. */
  respond: ((url: string) => Scripted | null) | undefined;
  /** Every base-layer wait between attempts, in order. */
  sleeps: number[];
  advance(ms: number): void;
  /** Drain every pending microtask chain started by update()/pump(). */
  flush(): Promise<void>;
  makeLayer(pano?: string, textureBudgetMB?: number, onInvalidate?: () => void): TileLayer;
  /** URL of the level-0 base tile for a face. */
  baseUrl(face: string, pano?: string): string;
  /**
   * One frame at `yaw` as the viewer's loop draws it: an 800 px tall square
   * view at devicePixelRatio 2 (`height` 1600), which selects level 2.
   */
  frame(layer: TileLayer, yaw: number, height?: number): void;
  /** One 60 Hz frame later on the layer's clock, at `yaw`. */
  nextFrame(layer: TileLayer, yaw: number): void;
  /** Enough 60 Hz frames at `yaw` for loads from the previous view to be aborted. */
  stayAt(layer: TileLayer, yaw: number): void;
  /**
   * Load every level-1 tile, then forget the requests and uploads it took.
   * At level 2 the layer fetches a missing tile's level-1 parent first; with
   * them all resident, a test sees only level-2 requests.
   */
  withLevel1(layer: TileLayer): Promise<TileLayer>;
  /**
   * Requests for level-2 tiles, the level these frames want. A level-2 tile
   * that fails also has its level-1 parent fetched in its place, which the
   * per-tile retry tests leave out of their counts.
   */
  level2(): string[];
  /** Decoded tiles waiting for a frame to upload them. */
  readyCount(layer: TileLayer): number;
  /**
   * One frame and the loads it starts, then the frames the layer asks for
   * while decoded tiles wait to be uploaded (a few go up per frame), as the
   * viewer's invalidate-driven loop would draw them.
   */
  render(layer: TileLayer, yaw: number): Promise<void>;
}

/** Register the fixture's beforeEach/afterEach in the calling describe, and return it. */
export function useLayerFixture(): LayerFixture {
  const fx: LayerFixture = {
    clock: 0,
    renderer: new FakeRenderer(),
    requests: [],
    script: { status: 200 },
    respond: undefined,
    sleeps: [],
    advance: (ms) => {
      fx.clock += ms;
    },
    flush: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    makeLayer: (pano = 'pano-a', textureBudgetMB = 128, onInvalidate = () => {}) =>
      new TileLayer(fx.renderer as unknown as GLRenderer, makeSource(pano), onInvalidate, {
        ...LAYER_DEFAULTS,
        textureBudgetMB,
        now: () => fx.clock,
        // The injected sleep advances the same clock the retry budget measures
        // its cooldowns against, so a base-layer retry is exercised for real
        // without any test waiting on a real timer.
        sleep: (ms: number) => {
          fx.sleeps.push(ms);
          fx.clock += ms;
          return Promise.resolve();
        },
      }),
    baseUrl: (face, pano = 'pano-a') => `/tiles/${pano}/0/${face}/0-0.jpg`,
    frame: (layer, yaw, height = 1600) => {
      const view = { yaw, pitch: 0, fov: 70 };
      layer.update(viewProjection(view, 1, 100), 70, dirFromYawPitch(yaw, 0), height);
    },
    nextFrame: (layer, yaw) => {
      fx.advance(FRAME_MS);
      fx.frame(layer, yaw);
    },
    stayAt: (layer, yaw) => {
      for (let i = 0; i <= ABORT_AFTER_FRAMES; i++) fx.nextFrame(layer, yaw);
    },
    withLevel1: async (layer) => {
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
        await fx.flush();
        for (let i = 0; i < 100 && fx.readyCount(layer) > 0; i++) {
          at();
          await fx.flush();
        }
      }
      const { cache } = layer as unknown as { cache: Map<string, unknown> };
      expect([...cache.keys()].filter((k) => k.startsWith('1/'))).toHaveLength(24);
      fx.requests = [];
      fx.renderer.uploadTile.mockClear();
      return layer;
    },
    level2: () => fx.requests.filter((u) => u.includes('/2/')),
    readyCount: (layer) => (layer as unknown as { ready: Map<string, unknown> }).ready.size,
    render: async (layer, yaw) => {
      fx.frame(layer, yaw);
      await fx.flush();
      for (let i = 0; i < 100 && fx.readyCount(layer) > 0; i++) {
        fx.frame(layer, yaw);
        await fx.flush();
      }
    },
  };

  beforeEach(() => {
    fx.clock = 1_000_000;
    fx.renderer = new FakeRenderer();
    fx.requests = [];
    fx.sleeps = [];
    fx.respond = undefined;
    fx.script = { status: 200 };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fx.requests.push(url);
        const scripted = fx.respond?.(url) ?? fx.script;
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

  return fx;
}
