import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FACES, type Manifest } from '@panote/core';
import { TileLayer } from './tile-layer.js';
import { TileFailureMonitor } from './tile-retry.js';
import { viewProjection } from './render/projection.js';
import { dirFromYawPitch } from './project.js';
import type { GLRenderer } from './render/gl-renderer.js';

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

  const advance = (ms: number): void => {
    clock += ms;
  };

  /** Drain every pending microtask chain started by update()/pump(). */
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  function makeLayer(pano = 'pano-a'): TileLayer {
    return new TileLayer(
      renderer as unknown as GLRenderer,
      makeManifest(pano),
      '/tiles/',
      128,
      () => {},
      8,
      monitor,
    );
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
    script = { status: 200 };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        requests.push(url);
        if (script.network) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({
          ok: script.status >= 200 && script.status < 300,
          status: script.status,
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
    let release: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: { signal: AbortSignal }) => {
        requests.push(url);
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            release = undefined;
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }),
    );

    frame(layer, 0);
    const started = requests.length;
    expect(started).toBeGreaterThan(0);
    frame(layer, Math.PI); // pans away — update() aborts what is no longer wanted
    await flush();
    expect(release).toBeUndefined();

    // No attempt spent, no evidence recorded: the tiles come straight back.
    requests = [];
    frame(layer, 0);
    expect(requests).toHaveLength(started);
    expect(monitor.escalationLevel).toBe(0);
    layer.dispose();
  });
});
