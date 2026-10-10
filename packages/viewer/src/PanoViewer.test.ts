import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FACES } from '@panote/core';
import { PanoViewer } from './PanoViewer.js';
import type { View } from './types.js';
import { TileLayer } from './tile-layer.js';
import { TileFailureMonitor, setSharedTileFailureMonitor } from './tile-retry.js';

// This package's vitest config runs under Node, not jsdom (see
// vitest.config.ts) — deliberately, so the package pays for no DOM test
// dependency. PanoViewer.ts is DOM/WebGL-driven throughout, so rather than
// building a full fake canvas/WebGL2 context (exercised instead by actually
// running the viewer — see the coverage `exclude` comment in
// vitest.config.ts), this file takes the same "minimal stand-in for exactly
// what's touched" approach as ui/info-hotspots.test.ts, and additionally
// swaps out GLRenderer for a lightweight fake via vi.mock so PanoViewer can
// be constructed at all without a real WebGL2 context.
//
// GLRenderer itself (the actual WebGL surface, including the
// WEBGL_lose_context dispose fix) is exercised directly in
// render/gl-renderer.test.ts using a fake WebGL2 context, not here.

// vi.mock's factory is hoisted above this file's imports, so it cannot close
// over any module-scope binding declared here — the fake class is therefore
// defined entirely inside the factory itself.
vi.mock('./render/gl-renderer.js', () => {
  class FakeGLRenderer {
    // Scaled 2x on resize to stand in for a devicePixelRatio-2 display — real
    // GLRenderer.resize() does exactly this scaling (see gl-renderer.ts).
    // The listener/style/tabIndex surface is what Controls attaches to once a
    // load succeeds (see controls.ts) — nothing here reads it back.
    canvas = {
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      tabIndex: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    };
    nextHandle = 1;
    maxTextureSize = 16384;
    dispose = vi.fn();
    uploadTile = vi.fn(() => this.nextHandle++);
    removeTile = vi.fn();
    resize(w: number, h: number): void {
      this.canvas.width = Math.round(w * 2);
      this.canvas.height = Math.round(h * 2);
    }
    setCamera(): void {}
    render = vi.fn();
    snapshot(): string {
      return 'data:image/png;base64,';
    }
  }
  return { GLRenderer: FakeGLRenderer };
});

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: unknown[] = [];
  disconnect = vi.fn();
  constructor(private cb: (entries: unknown[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: unknown): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  trigger(width: number, height: number): void {
    this.cb([{ contentRect: { width, height } }]);
  }
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed: unknown[] = [];
  disconnect = vi.fn();
  constructor(private cb: (entries: unknown[]) => void) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: unknown): void {
    this.observed.push(el);
  }
  trigger(isIntersecting: boolean): void {
    this.cb([{ isIntersecting }]);
  }
}

const FRAME_MS = 1000 / 60;

/**
 * requestAnimationFrame stand-in: callbacks queue up and run when the test
 * calls step(), at a clock that advances one 60 Hz frame per step unless the
 * test names the time.
 */
class FakeRaf {
  private queue = new Map<number, FrameRequestCallback>();
  private nextId = 1;
  now = 0;
  request = vi.fn((cb: FrameRequestCallback) => {
    const id = this.nextId++;
    this.queue.set(id, cb);
    return id;
  });
  cancel = vi.fn((id: number) => {
    this.queue.delete(id);
  });
  get pending(): number {
    return this.queue.size;
  }
  step(t = this.now + FRAME_MS): void {
    this.now = t;
    const due = [...this.queue.values()];
    this.queue.clear();
    for (const cb of due) cb(t);
  }
}

let raf: FakeRaf;

type Internals = {
  view: { yaw: number; pitch: number; fov: number };
  target: { yaw: number; pitch: number; fov: number };
  momentum: { yaw: number; pitch: number };
  dirty: boolean;
  invalidate: () => void;
  panByPixels: (dx: number, dy: number) => void;
  flick: (vx: number, vy: number) => void;
  stopMomentum: () => void;
  controls: unknown;
  pendingLayers: Set<{ dispose: () => void }>;
  layer: unknown;
  wasPending: boolean;
  renderer: {
    render: ReturnType<typeof vi.fn>;
    canvas: { addEventListener: ReturnType<typeof vi.fn> };
  };
};
const internals = (viewer: PanoViewer) => viewer as unknown as Internals;

/** Ask for a frame, as any change does, and draw it at `t` (default: one frame on). */
function tick(viewer: PanoViewer, t?: number): void {
  internals(viewer).invalidate();
  raf.step(t);
}

/** Run frames `ms` apart until the loop stops asking for them (or give up). */
function runUntilIdle(ms = FRAME_MS, max = 2000): number {
  let frames = 0;
  while (raf.pending > 0 && frames < max) {
    raf.step(raf.now + ms);
    frames++;
  }
  return frames;
}

/** The listener the viewer's Controls put on the canvas for `type`. */
function canvasListener(viewer: PanoViewer, type: string): (e: unknown) => void {
  const call = internals(viewer).renderer.canvas.addEventListener.mock.calls.find(
    (c) => c[0] === type,
  );
  if (!call) throw new Error(`no ${type} listener`);
  return call[1] as (e: unknown) => void;
}

function makeContainer(width: number, height: number): HTMLElement {
  return { clientWidth: width, clientHeight: height } as unknown as HTMLElement;
}

describe('PanoViewer', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: vi.fn(() => ({ matches: false })),
    });
    raf = new FakeRaf();
    vi.stubGlobal('requestAnimationFrame', raf.request);
    vi.stubGlobal('cancelAnimationFrame', raf.cancel);
    FakeResizeObserver.instances = [];
    FakeIntersectionObserver.instances = [];
    // load() builds a TileLayer on the module-scoped failure monitor; drop it
    // so no backoff state survives from one test to the next.
    setSharedTileFailureMonitor();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSharedTileFailureMonitor();
  });

  describe('device-pixel-ratio-aware level selection', () => {
    it('passes the renderer canvas device-pixel height to the tile layer, not the CSS clientHeight', () => {
      // update() needs the framebuffer's device-pixel height, not CSS
      // height, or selectLevel() picks a level coarser than the screen can
      // show. FakeGLRenderer.resize() scales 2x, so clientHeight=800 must
      // produce canvas.height=1600 here.
      const container = makeContainer(400, 800);
      const viewer = new PanoViewer(container);

      const updateSpy = vi.fn();
      // Bypass load()'s fetch/parseManifest/TileLayer construction entirely —
      // only the loop()'s call arguments to layer.update() are under test.
      (viewer as unknown as { layer: unknown }).layer = {
        update: updateSpy,
        drawList: () => [],
        hasPending: () => false,
      };

      tick(viewer);

      expect(updateSpy).toHaveBeenCalledTimes(1);
      const viewportHeightArg = updateSpy.mock.calls[0]![3];
      expect(viewportHeightArg).toBe(1600);
      expect(viewportHeightArg).not.toBe(container.clientHeight);
    });

    it('falls back to 1 when the renderer canvas has zero height', () => {
      // The constructor's own `container.clientHeight || 1` guard means a
      // zero-height container never actually reaches resize() as 0 - so to
      // exercise loop()'s `this.renderer.canvas.height || 1` fallback
      // directly, force canvas.height to 0 on the (fake) renderer after
      // construction, as if some other code path had produced it.
      const container = makeContainer(400, 800);
      const viewer = new PanoViewer(container);
      (viewer as unknown as { renderer: { canvas: { height: number } } }).renderer.canvas.height =
        0;
      const updateSpy = vi.fn();
      (viewer as unknown as { layer: unknown }).layer = {
        update: updateSpy,
        drawList: () => [],
        hasPending: () => false,
      };
      tick(viewer);
      expect(updateSpy.mock.calls[0]![3]).toBe(1);
    });
  });

  describe('device-pixel-ratio-aware texture budget', () => {
    // The other half of the DPR fix. Selecting levels from device pixels means
    // a DPR-2 display holds four times as many tiles on screen, against a
    // budget that was calibrated when it held one quarter as many — so the
    // default budget scales with the ratio too (capped; see texture-budget.ts).
    // A caller-supplied budget is absolute and is passed through untouched.
    const manifest = {
      pano: 'pano-a',
      faceSize: 2048,
      tileSize: 512,
      maxLevel: 2,
      faces: [...FACES],
      quality: 82,
      format: 'jpg',
    };

    /** Stub a host whose display reports `dpr`, with every fetch succeeding. */
    function stubDisplay(dpr: number | undefined): void {
      vi.stubGlobal('window', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        matchMedia: vi.fn(() => ({ matches: false })),
        ...(dpr === undefined ? {} : { devicePixelRatio: dpr }),
      });
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) =>
          Promise.resolve(
            url.endsWith('manifest.json')
              ? { ok: true, status: 200, json: () => Promise.resolve(manifest) }
              : { ok: true, status: 200, blob: () => Promise.resolve({}) },
          ),
        ),
      );
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(() => Promise.resolve({ close: vi.fn() })),
      );
    }

    /**
     * The budget as the tile layer actually received it, in tiles. This
     * manifest's tileSize is 512, so one tile is 512 * 512 * 4 = 1 MiB and the
     * tile count equals the budget in MB — the layer having the right number of
     * them is the only thing the budget is for.
     */
    async function loadedMaxTiles(viewer: PanoViewer): Promise<number> {
      await viewer.load('pano-a');
      return (viewer as unknown as { layer: { maxTiles: number } }).layer.maxTiles;
    }

    it('doubles the default budget on a devicePixelRatio-2 display', async () => {
      stubDisplay(2);
      const viewer = new PanoViewer(makeContainer(1422, 800));
      expect(await loadedMaxTiles(viewer)).toBe(256);
      viewer.dispose();
    });

    it('leaves the default budget alone when the host reports no pixel ratio', async () => {
      stubDisplay(undefined);
      const viewer = new PanoViewer(makeContainer(1422, 800));
      expect(await loadedMaxTiles(viewer)).toBe(128);
      viewer.dispose();
    });

    it('does not scale past the cap on a devicePixelRatio-3 display', async () => {
      stubDisplay(3);
      const viewer = new PanoViewer(makeContainer(1422, 800));
      expect(await loadedMaxTiles(viewer)).toBe(256);
      viewer.dispose();
    });

    it('honours an explicit textureBudgetMB exactly, scaling it neither up nor down', async () => {
      // A caller who names a budget is naming an absolute one: it is not
      // multiplied by the pixel ratio, and it is not clamped to the cap the
      // default is subject to.
      stubDisplay(2);
      const small = new PanoViewer(makeContainer(1422, 800), { textureBudgetMB: 64 });
      expect(await loadedMaxTiles(small)).toBe(64);
      small.dispose();

      const large = new PanoViewer(makeContainer(1422, 800), { textureBudgetMB: 512 });
      expect(await loadedMaxTiles(large)).toBe(512);
      large.dispose();
    });
  });

  describe('resize observation', () => {
    it('observes the container with a ResizeObserver and disconnects it on dispose', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const container = makeContainer(400, 800);
      const viewer = new PanoViewer(container);

      expect(FakeResizeObserver.instances).toHaveLength(1);
      const observer = FakeResizeObserver.instances[0]!;
      expect(observer.observed).toContain(container);

      viewer.dispose();
      expect(observer.disconnect).toHaveBeenCalledTimes(1);
    });

    it('does not construct a ResizeObserver when it is unavailable in the environment', () => {
      // No ResizeObserver stubbed in this test (afterEach's unstubAllGlobals
      // from the previous test already cleared it) — construction must not
      // throw when the global is absent.
      const container = makeContainer(400, 800);
      expect(() => new PanoViewer(container)).not.toThrow();
    });
  });

  describe('manifest fetch error handling', () => {
    it('rejects when the manifest fetch response is not ok, instead of attempting to parse it as JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          json: () => Promise.reject(new Error('should not be called')),
        }),
      );
      const container = makeContainer(400, 800);
      const viewer = new PanoViewer(container);
      await expect(viewer.load('missing-pano')).rejects.toThrow(/404/);
    });
  });

  describe('blocking low-resolution base layer', () => {
    // Level 0 is exactly one tile per cube face, so the six of them are a
    // complete low-resolution copy of the panorama. load() is not allowed to
    // resolve until they are all resident, which is what makes "a failed
    // high-resolution tile degrades to blurry" a guarantee rather than a hope.
    const manifestFor = (pano: string) => ({
      pano,
      faceSize: 2048,
      tileSize: 512,
      maxLevel: 2,
      faces: [...FACES],
      quality: 82,
      format: 'jpg',
    });

    const tileBody = { ok: true, status: 200, blob: () => Promise.resolve({}) };
    const baseTileUrl = (face: string, pano = 'pano-a'): string =>
      `/tiles/${pano}/0/${face}/0-0.jpg`;

    /** Drain the microtask chains load() and the tile loader start. */
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    let tileRequests: string[];

    /**
     * Stub fetch so manifests always resolve and tiles are answered by
     * `onTile`, which returns either a response-ish object or a pending promise.
     */
    function stubFetch(onTile: (url: string, init: { signal: AbortSignal }) => unknown): void {
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: { signal: AbortSignal }) => {
          const manifest = /\/tiles\/([^/]+)\/manifest\.json$/.exec(url);
          if (manifest) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(manifestFor(manifest[1]!)),
            });
          }
          tileRequests.push(url);
          return onTile(url, init);
        }),
      );
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(() => Promise.resolve({ close: vi.fn() })),
      );
    }

    beforeEach(() => {
      tileRequests = [];
    });

    /** Level-0 requests; the arrival view's detail tiles are requested alongside them. */
    const baseRequests = (): string[] => tileRequests.filter((u) => u.includes('/0/'));

    it('resolves only once all six base tiles are in', async () => {
      let releaseLast: (() => void) | undefined;
      const lastFace = FACES[FACES.length - 1]!;
      stubFetch((url) => {
        if (url !== baseTileUrl(lastFace)) return Promise.resolve(tileBody);
        return new Promise((resolve) => {
          releaseLast = () => resolve(tileBody);
        });
      });

      const viewer = new PanoViewer(makeContainer(400, 800));
      const ready = vi.fn();
      viewer.on('ready', ready);

      let settled = false;
      const load = viewer.load('pano-a').then(() => {
        settled = true;
      });
      await flush();

      // Five faces are already uploaded, and the load is still outstanding —
      // "loaded" means the whole panorama, not most of it.
      expect(baseRequests()).toHaveLength(FACES.length);
      for (const face of FACES) expect(tileRequests).toContain(baseTileUrl(face));
      expect(settled).toBe(false);
      expect(ready).not.toHaveBeenCalled();

      releaseLast!();
      await load;
      expect(settled).toBe(true);
      expect(ready).toHaveBeenCalledTimes(1);
      viewer.dispose();
    });

    it("requests the arrival view's tiles while the base is still loading", async () => {
      const held: (() => void)[] = [];
      stubFetch((url) =>
        url.includes('/0/')
          ? new Promise((resolve) => held.push(() => resolve(tileBody)))
          : Promise.resolve(tileBody),
      );
      const update = vi.spyOn(TileLayer.prototype, 'update');
      try {
        const viewer = new PanoViewer(makeContainer(400, 800));
        const load = viewer.load('pano-a', { view: { yaw: 1, fov: 30 } });
        await flush();
        // Primed with the camera the pano will arrive with, before the base is in.
        expect(update).toHaveBeenCalledTimes(1);
        const [, fovDeg, fwd] = update.mock.calls[0]!;
        expect(fovDeg).toBeCloseTo(30, 10);
        expect(fwd.x).toBeCloseTo(Math.sin(1), 10);
        expect(tileRequests.some((u) => !u.includes('/0/'))).toBe(true);
        held.splice(0).forEach((release) => release());
        await expect(load).resolves.toBe(true);
        viewer.dispose();
      } finally {
        update.mockRestore();
      }
    });

    it('emits scene-change with the loaded panoId alongside ready', async () => {
      stubFetch(() => Promise.resolve(tileBody));
      const viewer = new PanoViewer(makeContainer(400, 800));
      const sceneChange = vi.fn();
      viewer.on('scene-change', sceneChange);

      await viewer.load('pano-a');

      expect(sceneChange).toHaveBeenCalledTimes(1);
      expect(sceneChange).toHaveBeenCalledWith('pano-a');
      viewer.dispose();
    });

    it('rejects when a base tile is permanently missing', async () => {
      stubFetch((url) =>
        url === baseTileUrl('py')
          ? Promise.resolve({ ok: false, status: 404, blob: () => Promise.resolve({}) })
          : Promise.resolve(tileBody),
      );

      const viewer = new PanoViewer(makeContainer(400, 800));
      const ready = vi.fn();
      viewer.on('ready', ready);

      await expect(viewer.load('pano-a')).rejects.toThrow(/low-resolution base tile for face "py"/);
      expect(ready).not.toHaveBeenCalled();
      viewer.dispose();
    });

    it('leaves no layer behind when the base load fails, and disposes cleanly', async () => {
      stubFetch(() => Promise.resolve({ ok: false, status: 404, blob: () => Promise.resolve({}) }));

      const viewer = new PanoViewer(makeContainer(400, 800));
      await expect(viewer.load('pano-a')).rejects.toThrow();

      expect((viewer as unknown as { layer: unknown }).layer).toBeUndefined();
      expect(() => viewer.dispose()).not.toThrow();
      // Idempotent: a second dispose after a failed load is still harmless.
      expect(() => viewer.dispose()).not.toThrow();
    });

    it('keeps the panorama already on screen when a later load fails', async () => {
      stubFetch(() => Promise.resolve(tileBody));
      const viewer = new PanoViewer(makeContainer(400, 800));
      await viewer.load('pano-a');
      const loaded = (viewer as unknown as { layer: unknown }).layer;
      expect(loaded).toBeDefined();

      stubFetch((url) =>
        url.startsWith('/tiles/pano-b/')
          ? Promise.resolve({ ok: false, status: 404, blob: () => Promise.resolve({}) })
          : Promise.resolve(tileBody),
      );
      await expect(viewer.load('pano-b')).rejects.toThrow();

      // The outgoing panorama is only torn down once the incoming one can
      // actually be drawn, so a failed load degrades to "still showing the old
      // pano", never to a black canvas.
      expect((viewer as unknown as { layer: unknown }).layer).toBe(loaded);
      viewer.dispose();
    });

    describe('dispose during an in-flight base load', () => {
      // Until its base is resident the incoming layer is only reachable from
      // load()'s local, so a dispose() that only reaches `this.layer` never
      // marks it disposed — every `if (this.disposed)` guard inside it is dead
      // code, and the six base fetches outlive the WebGL context they will
      // upload into.
      const fakeRendererOf = (viewer: PanoViewer) =>
        (viewer as unknown as { renderer: { uploadTile: ReturnType<typeof vi.fn> } }).renderer;

      it('aborts the in-flight base fetches and uploads nothing', async () => {
        stubFetch(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () => {
                reject(new DOMException('aborted', 'AbortError'));
              });
            }),
        );

        const viewer = new PanoViewer(makeContainer(400, 800));
        const ready = vi.fn();
        viewer.on('ready', ready);

        let settled = false;
        const load = viewer.load('pano-a').then(() => {
          settled = true;
        });
        await flush();
        expect(baseRequests()).toHaveLength(FACES.length);
        const before = tileRequests.length;

        viewer.dispose();
        // Resolving (not rejecting) is the deliberate choice: it matches every
        // other disposed/superseded exit in load(), and a caller that disposed
        // the viewer is not waiting to be told its load did not finish.
        await load;
        expect(settled).toBe(true);
        expect(tileRequests).toHaveLength(before);
        expect(fakeRendererOf(viewer).uploadTile).not.toHaveBeenCalled();
        expect(ready).not.toHaveBeenCalled();
        expect((viewer as unknown as { layer: unknown }).layer).toBeUndefined();
      });

      it('does not fetch, decode or upload after dispose while retrying', async () => {
        // Transient failures make it worse than a single wasted round: the base
        // loader sleeps and retries, so the traffic continues for seconds after
        // dispose() and finally uploads into a destroyed context.
        let status = 503;
        stubFetch(() =>
          Promise.resolve({
            ok: status === 200,
            status,
            blob: () => Promise.resolve({}),
          }),
        );

        const viewer = new PanoViewer(makeContainer(400, 800));
        const load = viewer.load('pano-a');
        await flush();
        // One failed attempt per face; each is now inside its retry cooldown.
        expect(baseRequests()).toHaveLength(FACES.length);
        const before = tileRequests.length;

        status = 200; // the origin recovers — a retry would now succeed
        viewer.dispose();
        await expect(load).resolves.toBe(false);
        await flush();

        expect(tileRequests).toHaveLength(before);
        expect(fakeRendererOf(viewer).uploadTile).not.toHaveBeenCalled();
      });
    });
  });

  describe('frame loop', () => {
    it('stops asking for frames once the camera settles, and asks again on a change', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      viewer.setView({ yaw: 1 });
      expect(runUntilIdle()).toBeGreaterThan(5);
      expect(internals(viewer).view.yaw).toBe(1);
      const requested = raf.request.mock.calls.length;
      for (let i = 0; i < 10; i++) raf.step();
      expect(raf.request.mock.calls.length).toBe(requested);
      expect(raf.pending).toBe(0);
      viewer.setNorth(0.3);
      expect(raf.pending).toBe(1);
      viewer.dispose();
    });

    it('draws no frames off screen, even auto-rotating, and restarts the rotation clock on return', () => {
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
      const container = makeContainer(400, 800);
      const viewer = new PanoViewer(container, {
        autoRotate: true,
        autoRotateSpeed: 1,
        damping: 1,
      });
      const io = FakeIntersectionObserver.instances[0]!;
      expect(io.observed).toEqual([container]);
      raf.step();
      raf.step();
      expect(raf.pending).toBe(1); // turning keeps the loop going

      io.trigger(false);
      expect(raf.pending).toBe(0);
      const yaw = internals(viewer).view.yaw;
      const requested = raf.request.mock.calls.length;
      viewer.setView({ pitch: 0.1 }); // waits until the viewer is back
      for (let i = 0; i < 10; i++) raf.step(raf.now + 1000);
      expect(raf.request.mock.calls.length).toBe(requested);
      expect(internals(viewer).view.yaw).toBe(yaw);

      io.trigger(true);
      expect(raf.pending).toBe(1);
      raf.step(raf.now + 5000); // no turn for the time spent away
      expect(internals(viewer).view.yaw).toBeCloseTo(yaw, 10);
      expect(internals(viewer).view.pitch).toBeCloseTo(0.1, 10);
      raf.step(raf.now + 50);
      expect(internals(viewer).view.yaw).toBeCloseTo(yaw + 0.05, 10);
      viewer.dispose();
      expect(io.disconnect).toHaveBeenCalled();
    });

    it('glides the same distance, at the same pace, at 30, 60 and 120 Hz', () => {
      const glide = (hz: number): { at200ms: number; total: number } => {
        const viewer = new PanoViewer(makeContainer(400, 800));
        runUntilIdle();
        internals(viewer).flick(30, 0);
        raf.step(); // the first frame after an idle spell steps one nominal frame
        const end = raf.now + 200;
        while (raf.now < end - 1e-6) raf.step(raf.now + 1000 / hz);
        // Where the glide has carried the target; the camera eases after it.
        const at200ms = internals(viewer).target.yaw;
        runUntilIdle(1000 / hz, 10_000);
        const total = internals(viewer).view.yaw;
        viewer.dispose();
        return { at200ms, total };
      };
      const at60 = glide(60);
      expect(Math.abs(at60.total)).toBeGreaterThan(0.1);
      expect(Math.abs(at60.at200ms)).toBeLessThan(Math.abs(at60.total) * 0.9);
      for (const hz of [30, 120]) {
        const g = glide(hz);
        expect(Math.abs(g.total / at60.total - 1)).toBeLessThan(0.02);
        expect(Math.abs(g.at200ms / at60.at200ms - 1)).toBeLessThan(0.02);
      }
    });

    it('eases toward a new view at the same pace at 30 and 120 Hz', () => {
      const after100ms = (hz: number): number => {
        const viewer = new PanoViewer(makeContainer(400, 800));
        runUntilIdle();
        viewer.setView({ yaw: 1 });
        raf.step(); // the first frame after an idle spell steps one nominal frame
        const end = raf.now + 100;
        while (raf.now < end - 1e-6) raf.step(raf.now + 1000 / hz);
        const yaw = internals(viewer).view.yaw;
        viewer.dispose();
        return yaw;
      };
      const at30 = after100ms(30);
      expect(at30).toBeGreaterThan(0.1);
      expect(at30).toBeLessThan(0.99);
      expect(after100ms(120)).toBeCloseTo(at30, 6);
    });

    it('reads no layout in frames, project(), directionAtPixel() or drags', () => {
      let reads = 0;
      const container = {
        get clientWidth() {
          reads++;
          return 400;
        },
        get clientHeight() {
          reads++;
          return 800;
        },
      } as unknown as HTMLElement;
      const viewer = new PanoViewer(container, { damping: 1 });
      reads = 0;
      let projected = 0;
      viewer.onRender(() => {
        viewer.project(0.1, 0);
        viewer.project(-0.1, 0.2);
        projected += 2;
      });
      for (let i = 0; i < 10; i++) {
        internals(viewer).panByPixels(5, 0);
        raf.step();
        viewer.directionAtPixel(10, 10);
      }
      expect(projected).toBe(20);
      expect(reads).toBe(0);
      const centre = viewer.project(internals(viewer).view.yaw, 0);
      expect(centre.x).toBeCloseTo(200, 3);
      expect(centre.y).toBeCloseTo(400, 3);
    });

    it('projects from the initial view before the first frame', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), { initialView: { yaw: Math.PI } });
      const ahead = viewer.project(Math.PI, 0);
      expect(ahead.behind).toBe(false);
      expect(ahead.x).toBeCloseTo(200, 3);
      expect(viewer.project(0, 0).behind).toBe(true);
      viewer.dispose();
    });

    it('takes the size from ResizeObserver entries', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const viewer = new PanoViewer(makeContainer(400, 800));
      FakeResizeObserver.instances[0]!.trigger(1000, 500);
      raf.step();
      const centre = viewer.project(0, 0);
      expect(centre.x).toBeCloseTo(500, 3);
      expect(centre.y).toBeCloseTo(250, 3);
      expect((internals(viewer).renderer.canvas as unknown as { width: number }).width).toBe(2000);
      viewer.dispose();
    });

    it('moves the target on an arrow key, so damping eases the camera after it', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      runUntilIdle();
      const { view, target } = internals(viewer);
      canvasListener(
        viewer,
        'keydown',
      )({
        key: 'ArrowRight',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      });
      expect(target.yaw).toBeGreaterThan(0);
      expect(view.yaw).toBe(0);
      raf.step();
      expect(view.yaw).toBeGreaterThan(0);
      expect(view.yaw).toBeLessThan(target.yaw);
      viewer.dispose();
    });

    it('hands render callbacks a copy of the view, which cannot move the camera', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), { initialView: { yaw: 0.3 } });
      const seen: number[] = [];
      viewer.onRender((v) => {
        seen.push(v.yaw);
        (v as View).yaw = 9;
      });
      raf.step();
      tick(viewer);
      expect(seen).toEqual([0.3, 0.3]);
      expect(internals(viewer).view.yaw).toBe(0.3);
      viewer.dispose();
    });

    it('reuses one view-projection matrix across frames', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      const renderer = internals(viewer).renderer as unknown as {
        setCamera: (m: Float32Array) => void;
      };
      const setCamera = vi.spyOn(renderer, 'setCamera');
      viewer.setView({ yaw: 1 });
      raf.step();
      raf.step();
      expect(setCamera).toHaveBeenCalledTimes(2);
      expect(setCamera.mock.calls[0]![0]).toBe(setCamera.mock.calls[1]![0]);
      viewer.dispose();
    });

    it("passes the wheel option to its controls, capturing every wheel unless it is 'engaged'", () => {
      const wheel = () => ({
        deltaY: 100,
        deltaX: 0,
        deltaMode: 0,
        ctrlKey: false,
        metaKey: false,
        clientX: 0,
        clientY: 0,
        preventDefault: vi.fn(),
      });
      const embedded = new PanoViewer(makeContainer(400, 800), { wheel: 'engaged' });
      const scrolls = wheel();
      canvasListener(embedded, 'wheel')(scrolls);
      expect(scrolls.preventDefault).not.toHaveBeenCalled();

      const plain = new PanoViewer(makeContainer(400, 800));
      const zooms = wheel();
      canvasListener(plain, 'wheel')(zooms);
      expect(zooms.preventDefault).toHaveBeenCalled();
      expect(plain.getView().fov).toBeGreaterThan(70);
      embedded.dispose();
      plain.dispose();
    });
  });

  describe('compass north offset and heading', () => {
    it('defaults to north=0 and heading tracking the initial yaw', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        initialView: { yaw: 0.4 },
      });
      expect(viewer.heading()).toBeCloseTo(-0.4, 10);
    });

    it('setNorth updates the heading immediately', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        initialView: { yaw: 0.4 },
      });
      viewer.setNorth(1.2);
      expect(viewer.heading()).toBeCloseTo(0.8, 10);
    });
  });

  describe('auto-rotate', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Fake timers would run requestAnimationFrame as time advances below;
      // restub it so these tests drive the loop only via tick() calls.
      vi.stubGlobal('requestAnimationFrame', raf.request);
      vi.stubGlobal('cancelAnimationFrame', raf.cancel);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** One frame at the fake timers' clock, so advanceTimersByTime is the frame gap. */
    function tick(viewer: PanoViewer): void {
      internals(viewer).invalidate();
      raf.step(performance.now());
    }

    function yawOf(viewer: PanoViewer): number {
      return internals(viewer).view.yaw;
    }

    it('does not rotate when disabled, where the same frames turn an enabled viewer', () => {
      const off = new PanoViewer(makeContainer(400, 800), { autoRotateSpeed: 1, damping: 1 });
      const on = new PanoViewer(makeContainer(400, 800), {
        autoRotate: true,
        autoRotateSpeed: 1,
        damping: 1,
      });
      tick(off); // timing baseline for both
      const offBefore = yawOf(off);
      const onBefore = yawOf(on);
      vi.advanceTimersByTime(50);
      tick(off); // steps both viewers' queued frames
      expect(yawOf(on)).toBeCloseTo(onBefore + 0.05, 10);
      expect(yawOf(off)).toBeCloseTo(offBefore, 10);
    });

    it('rotates the view forward once real time elapses between frames', () => {
      // damping: 1 snaps view straight to target, so a tick's delta is exactly
      // autoRotateSpeed times the elapsed seconds, with no easing to account for.
      const viewer = new PanoViewer(makeContainer(400, 800), {
        autoRotate: true,
        autoRotateSpeed: 1,
        damping: 1,
      });
      tick(viewer); // the first frame only sets the timing baseline
      const before = yawOf(viewer);
      vi.advanceTimersByTime(50); // well under the stalled-frame clamp
      tick(viewer);
      expect(yawOf(viewer)).toBeCloseTo(before + 0.05, 10);
    });

    it('pauses on interaction and resumes only after the idle window elapses', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        autoRotate: true,
        autoRotateSpeed: 1,
        autoRotateIdleMs: 1000,
        damping: 1,
      });
      tick(viewer);
      internals(viewer).stopMomentum(); // stands in for a real interaction's gesture start
      const paused = yawOf(viewer);

      vi.advanceTimersByTime(999);
      tick(viewer);
      expect(yawOf(viewer)).toBeCloseTo(paused, 10);

      vi.advanceTimersByTime(1); // the idle timer fires here, reactivating rotation
      tick(viewer); // first frame back only re-establishes the timing baseline
      expect(yawOf(viewer)).toBeCloseTo(paused, 10);

      vi.advanceTimersByTime(50);
      tick(viewer);
      expect(yawOf(viewer)).toBeCloseTo(paused + 0.05, 10);
    });

    it('setAutoRotate(false) cancels a pending resume and stops rotation', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        autoRotate: true,
        autoRotateSpeed: 1,
        autoRotateIdleMs: 1000,
        damping: 1,
      });
      internals(viewer).stopMomentum();
      viewer.setAutoRotate(false);
      const before = yawOf(viewer);

      vi.advanceTimersByTime(1000);
      tick(viewer);
      expect(yawOf(viewer)).toBeCloseTo(before, 10);
    });

    it('setAutoRotate(true) enables rotation immediately, with no idle wait', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        autoRotateSpeed: 1,
        autoRotateIdleMs: 5000, // much longer than the delay used below
        damping: 1,
      });
      viewer.setAutoRotate(true);
      tick(viewer); // establishes the timing baseline
      const before = yawOf(viewer);

      vi.advanceTimersByTime(50); // far short of autoRotateIdleMs
      tick(viewer);
      expect(yawOf(viewer)).toBeCloseTo(before + 0.05, 10);
    });

    it('does not wrap target.yaw across the ±π seam into a near-2π jump', () => {
      // Regression: normalizing target.yaw used to wrap +π to −π, which
      // damp() then eased view.yaw the long way around — almost a full turn.
      const viewer = new PanoViewer(makeContainer(400, 800), {
        initialView: { yaw: Math.PI - 0.05 },
        autoRotate: true,
        autoRotateSpeed: 1,
        damping: 1,
      });
      tick(viewer);
      let prev = yawOf(viewer);
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(20); // small, well under the stall clamp
        tick(viewer);
        const next = yawOf(viewer);
        expect(next).toBeGreaterThan(prev);
        expect(next - prev).toBeLessThan(0.1);
        prev = next;
      }
      // Keeps climbing past π instead of snapping back down near −π.
      expect(prev).toBeGreaterThan(Math.PI);
    });

    it('keeps target.yaw bounded via whole-turn shifts, without changing the rendered view', () => {
      const start = Math.PI * 1.9; // just under the 2π shift threshold
      const viewer = new PanoViewer(makeContainer(400, 800), {
        initialView: { yaw: start },
        autoRotate: true,
        autoRotateSpeed: 5, // one clamped 100ms tick crosses the threshold
        damping: 1,
      });
      tick(viewer);
      vi.advanceTimersByTime(200); // clamped to the 100ms stall cap => 0.5 rad
      tick(viewer);
      // Shifting target and view by the same whole 2π leaves the rendered
      // angle exactly what an unshifted (start + 0.5) would be, just wrapped.
      expect(yawOf(viewer)).toBeCloseTo(start + 0.5 - Math.PI * 2, 10);
      expect(Math.abs(yawOf(viewer))).toBeLessThan(Math.PI * 2);
    });
  });

  describe('hotspot-open reporting', () => {
    it('emits hotspot-open with the reported id', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      const hotspotOpen = vi.fn();
      viewer.on('hotspot-open', hotspotOpen);

      viewer.reportHotspotOpen('spot-1');

      expect(hotspotOpen).toHaveBeenCalledTimes(1);
      expect(hotspotOpen).toHaveBeenCalledWith('spot-1');
    });
  });

  describe('local preview', () => {
    type FakeRenderer = {
      uploadTile: ReturnType<typeof vi.fn>;
      removeTile: ReturnType<typeof vi.fn>;
      render: ReturnType<typeof vi.fn>;
      canvas: { addEventListener: ReturnType<typeof vi.fn> };
    };
    type Item = { handle: number; level: number };

    const rendererOf = (viewer: PanoViewer): FakeRenderer =>
      (viewer as unknown as { renderer: FakeRenderer }).renderer;
    const lastDrawList = (viewer: PanoViewer): Item[] =>
      rendererOf(viewer).render.mock.calls.at(-1)![0] as Item[];
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    /**
     * Two patches with a 2 px gutter, over a `width`×`width / 2` source. The
     * default 2048 is 512 px per face, level 0 of the 512 px tiles below.
     */
    function source(width = 2048) {
      const h = width / 2;
      const w = h + 2;
      const image = () => ({ width: w, height: h, close: vi.fn() }) as unknown as ImageBitmap;
      return {
        width,
        height: h,
        patches: [
          { x: 0, y: 0, w, h, image: image() },
          { x: h - 2, y: 0, w, h, image: image() },
        ],
      };
    }

    // Read when a manifest is served, so a test can change it between loads.
    let manifestVersion: string | undefined;
    beforeEach(() => {
      manifestVersion = undefined;
    });

    const manifestFor = (pano: string) => ({
      pano,
      faceSize: 2048,
      tileSize: 512,
      maxLevel: 2,
      faces: [...FACES],
      quality: 82,
      format: 'jpg',
      ...(manifestVersion === undefined ? {} : { version: manifestVersion }),
    });

    /** Tiles answer at once, except URLs `hold` matches, which wait for release(). */
    function stubTiles(hold: (url: string) => boolean = () => false) {
      const held: (() => void)[] = [];
      const body = { ok: true, status: 200, blob: () => Promise.resolve({}) };
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          const m = /\/tiles\/([^/]+)\/manifest\.json$/.exec(url);
          if (m) {
            const json = () => Promise.resolve(manifestFor(m[1]!));
            return Promise.resolve({ ok: true, status: 200, json });
          }
          if (!hold(url)) return Promise.resolve(body);
          return new Promise((resolve) => held.push(() => resolve(body)));
        }),
      );
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(() => Promise.resolve({ close: vi.fn() })),
      );
      return { release: () => held.splice(0).forEach((r) => r()) };
    }

    it('draws the preview, keeps the camera and emits scene-change', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      viewer.setView({ yaw: 1.2, pitch: 0.3, fov: 50 });
      const before = viewer.getView();
      const sceneChange = vi.fn();
      viewer.on('scene-change', sceneChange);

      viewer.showPreview('pano-a', source());
      tick(viewer);

      expect(sceneChange).toHaveBeenCalledWith('pano-a');
      expect(viewer.getView()).toEqual(before);
      expect(lastDrawList(viewer).map((d) => d.handle)).toEqual([1, 2]);
      viewer.dispose();
    });

    it('works with controls, project, directionAtPixel and north as on tiles', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), { damping: 1 });
      viewer.showPreview('pano-a', source());
      viewer.setView({ yaw: 0.5, pitch: 0.2 });
      viewer.setNorth(0.5);
      tick(viewer);

      expect(rendererOf(viewer).canvas.addEventListener).toHaveBeenCalledWith(
        'pointerdown',
        expect.any(Function),
      );
      const centre = viewer.directionAtPixel(200, 400);
      expect(centre.yaw).toBeCloseTo(0.5, 6);
      expect(centre.pitch).toBeCloseTo(0.2, 6);
      expect(viewer.heading()).toBeCloseTo(0, 6);

      const p = viewer.project(0.5, 0.2);
      expect(p.behind).toBe(false);
      expect(p.x).toBeCloseTo(200, 3);
      expect(p.y).toBeCloseTo(400, 3);
      expect(viewer.project(0.5 + Math.PI, -0.2).behind).toBe(true);
      viewer.dispose();
    });

    it('keeps the view and a non-empty draw list across load(), then frees the preview once tiles settle', async () => {
      const tiles = stubTiles((url) => url.includes('/0/'));
      const viewer = new PanoViewer(makeContainer(400, 800));
      viewer.setView({ yaw: -0.8, pitch: 0.1, fov: 60 });
      viewer.showPreview('pano-a', source());
      const before = viewer.getView();
      const settled = vi.fn();
      viewer.on('tiles-settled', settled);
      const renderer = rendererOf(viewer);

      const load = viewer.load('pano-a');
      for (let i = 0; i < 3; i++) {
        await flush();
        tick(viewer);
        expect(lastDrawList(viewer).length).toBeGreaterThan(0);
      }
      tiles.release();
      await load;
      expect(viewer.getView()).toEqual(before);

      // Swapped in: the preview paints over level 0 and under finer levels until tiles-settled.
      tick(viewer);
      const swapped = lastDrawList(viewer);
      expect(swapped.filter((d) => d.level === 0.5)).toHaveLength(2);
      expect(swapped.filter((d) => d.level === 0).length).toBeGreaterThanOrEqual(FACES.length);
      expect(renderer.removeTile).not.toHaveBeenCalledWith(1);

      for (let i = 0; i < 10 && settled.mock.calls.length === 0; i++) {
        await flush();
        tick(viewer);
        expect(lastDrawList(viewer).length).toBeGreaterThan(0);
      }
      expect(settled).toHaveBeenCalledTimes(1);
      expect(renderer.removeTile).toHaveBeenCalledWith(1);
      expect(renderer.removeTile).toHaveBeenCalledWith(2);
      expect(lastDrawList(viewer).some((d) => d.level === 0.5)).toBe(false);
      expect(viewer.getView()).toEqual(before);
      viewer.dispose();
    });

    it('drops the preview at the swap when a different pano loads', async () => {
      stubTiles();
      const viewer = new PanoViewer(makeContainer(400, 800));
      viewer.showPreview('pano-a', source());
      await viewer.load('pano-b');
      expect(rendererOf(viewer).removeTile).toHaveBeenCalledWith(1);
      expect(rendererOf(viewer).removeTile).toHaveBeenCalledWith(2);
      viewer.dispose();
    });

    it('replaces tiles already on screen, and supersedes a load in flight', async () => {
      const tiles = stubTiles((url) => url.includes('/pano-b/'));
      const viewer = new PanoViewer(makeContainer(400, 800));
      await viewer.load('pano-a');
      const renderer = rendererOf(viewer);
      const tileHandles = renderer.uploadTile.mock.results.map((r) => r.value as number);
      const pendingB = viewer.load('pano-b');
      await flush();

      viewer.showPreview('pano-c', source());
      for (const h of tileHandles) expect(renderer.removeTile).toHaveBeenCalledWith(h);
      tiles.release();
      await pendingB;
      tick(viewer);
      // Only the preview, at its default level: pano-b never swapped in.
      expect(lastDrawList(viewer).every((d) => d.level === 0)).toBe(true);
      expect(lastDrawList(viewer)).toHaveLength(2);
      viewer.dispose();
    });

    /** Holds every tile but the base, which a load primes alongside it. */
    const detailTile = (url: string) => !url.includes('/0/');

    /** Tick until tiles-settled has fired `n` times (or give up), checking each frame draws. */
    async function settle(viewer: PanoViewer, settled: ReturnType<typeof vi.fn>, n = 1) {
      for (let i = 0; i < 20 && settled.mock.calls.length < n; i++) {
        await flush();
        tick(viewer);
        expect(lastDrawList(viewer).length).toBeGreaterThan(0);
      }
    }
    const previewItems = (viewer: PanoViewer): Item[] =>
      lastDrawList(viewer).filter((d) => d.handle === 1 || d.handle === 2);

    it('keeps the preview on top of an older version of the same pano, past its tiles-settled', async () => {
      // A replace keeps the panoId: the manifest can still be the old image's.
      // Detail tiles wait, so the frames before they land can be checked.
      const tiles = stubTiles(detailTile);
      manifestVersion = 'v1';
      const viewer = new PanoViewer(makeContainer(400, 800));
      const settled = vi.fn();
      viewer.on('tiles-settled', settled);
      viewer.showPreview('pano-a', source(), { replacesVersion: 'v1' });

      await viewer.load('pano-a');
      tick(viewer);
      // Over every tile level, the finest (2) included.
      expect(previewItems(viewer)).toEqual([
        { handle: 1, level: 3 },
        { handle: 2, level: 3 },
      ]);
      tiles.release();
      await settle(viewer, settled);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(rendererOf(viewer).removeTile).not.toHaveBeenCalledWith(1);
      expect(previewItems(viewer)).toHaveLength(2);

      // The new version lands: now the tiles are the preview's own.
      manifestVersion = 'v2';
      await viewer.load('pano-a');
      tick(viewer);
      expect(previewItems(viewer).map((d) => d.level)).toEqual([0.5, 0.5]);
      tiles.release();
      await settle(viewer, settled, 2);
      expect(settled).toHaveBeenCalledTimes(2);
      expect(rendererOf(viewer).removeTile).toHaveBeenCalledWith(1);
      expect(rendererOf(viewer).removeTile).toHaveBeenCalledWith(2);
      expect(previewItems(viewer)).toEqual([]);
      viewer.dispose();
    });

    it('takes any manifest as its own without replacesVersion (a new pano)', async () => {
      const tiles = stubTiles(detailTile);
      manifestVersion = 'v7';
      const viewer = new PanoViewer(makeContainer(400, 800));
      const settled = vi.fn();
      viewer.on('tiles-settled', settled);
      viewer.showPreview('pano-a', source());
      await viewer.load('pano-a');
      tick(viewer);
      expect(previewItems(viewer).map((d) => d.level)).toEqual([0.5, 0.5]);
      tiles.release();
      await settle(viewer, settled);
      expect(rendererOf(viewer).removeTile).toHaveBeenCalledWith(1);
      viewer.dispose();
    });

    it('treats an unversioned old manifest as the replaced one when replacesVersion is empty', async () => {
      stubTiles();
      const viewer = new PanoViewer(makeContainer(400, 800));
      const settled = vi.fn();
      viewer.on('tiles-settled', settled);
      viewer.showPreview('pano-a', source(), { replacesVersion: '' });
      await viewer.load('pano-a');
      tick(viewer);
      expect(previewItems(viewer).map((d) => d.level)).toEqual([3, 3]);
      await settle(viewer, settled);
      expect(rendererOf(viewer).removeTile).not.toHaveBeenCalledWith(1);
      viewer.dispose();
    });

    it('places a sharper preview above the tile levels it out-resolves', async () => {
      // 8192 wide is 2048 px per face: level 2 of 512 px tiles. Levels 0 to 2
      // paint under it; a level-3 pyramid's finest level would paint over it.
      stubTiles(detailTile);
      manifestVersion = 'v2';
      const viewer = new PanoViewer(makeContainer(400, 800));
      // Four 2052×4096 patches (2 px gutters), each within the 4096 px cap.
      const image = () => ({ width: 2052, height: 4096, close: vi.fn() }) as unknown as ImageBitmap;
      const wide = {
        width: 8192,
        height: 4096,
        patches: [0, 1, 2, 3].map((i) => ({
          x: Math.max(0, i * 2048 - 2),
          y: 0,
          w: i === 0 || i === 3 ? 2050 : 2052,
          h: 4096,
          image: image(),
        })),
      };
      viewer.showPreview('pano-a', wide, { replacesVersion: 'v1' });
      await viewer.load('pano-a');
      tick(viewer);
      const levels = lastDrawList(viewer)
        .filter((d) => d.handle <= 4)
        .map((d) => d.level);
      expect(levels).toEqual([2.5, 2.5, 2.5, 2.5]);
      viewer.dispose();
    });

    it('keeps the preview while the backoff holds its tiles in the queue', async () => {
      let holding = true;
      stubTiles((url) => holding && !url.includes('/0/'));
      let clock = 0;
      const monitor = new TileFailureMonitor({ now: () => clock });
      setSharedTileFailureMonitor(monitor);
      const viewer = new PanoViewer(makeContainer(400, 800), { damping: 1 });
      const settled = vi.fn();
      viewer.on('tiles-settled', settled);
      viewer.showPreview('pano-a', source());
      await viewer.load('pano-a');

      // Two other panoramas fail: the backoff trips.
      monitor.fail(monitor.acquire()!, 'other-1', 'transient');
      monitor.fail(monitor.acquire()!, 'other-2', 'transient');
      expect(monitor.canStart()).toBe(false);
      const detailFetches = () =>
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/2/')).length;
      const started = detailFetches();
      // Turning away aborts the tiles the load primed, so only the queue, held
      // by the backoff, is left pending.
      viewer.setView({ yaw: Math.PI });
      holding = false;
      for (let i = 0; i < 3; i++) {
        await flush();
        tick(viewer);
      }
      expect(detailFetches()).toBe(started);
      expect(settled).not.toHaveBeenCalled();
      expect(previewItems(viewer)).toHaveLength(2);

      // The window passes: the held tiles start, land, and only then settle.
      clock += 60_000;
      tick(viewer);
      expect(detailFetches()).toBeGreaterThan(started);
      expect(settled).not.toHaveBeenCalled();
      await settle(viewer, settled);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(previewItems(viewer)).toEqual([]);
      viewer.dispose();
    });

    it('cancels a load of the same pano already in flight', async () => {
      let holding = true;
      const tiles = stubTiles(() => holding);
      const viewer = new PanoViewer(makeContainer(400, 800));
      const ready = vi.fn();
      viewer.on('ready', ready);
      const early = viewer.load('pano-a');
      await flush();

      viewer.showPreview('pano-a', source());
      tiles.release();
      await early;
      expect(ready).not.toHaveBeenCalled();
      tick(viewer);
      // Only the preview is drawn: the cancelled load swapped nothing in.
      expect(lastDrawList(viewer)).toEqual([
        { handle: 1, level: 0 },
        { handle: 2, level: 0 },
      ]);

      // Loading again is what brings the tiles in.
      holding = false;
      await viewer.load('pano-a');
      expect(ready).toHaveBeenCalledTimes(1);
      viewer.dispose();
    });

    it('leaves the viewer as it was when the source is rejected', async () => {
      stubTiles();
      const viewer = new PanoViewer(makeContainer(400, 800));
      await viewer.load('pano-a');
      const layer = (viewer as unknown as { layer: unknown }).layer;
      const sceneChange = vi.fn();
      viewer.on('scene-change', sceneChange);
      const bad = source();
      (bad.patches[0]!.image as unknown as { width: number }).width = 5000;

      expect(() => viewer.showPreview('pano-b', bad)).toThrow(/limit/);
      expect((viewer as unknown as { layer: unknown }).layer).toBe(layer);
      expect(sceneChange).not.toHaveBeenCalled();
      viewer.dispose();
    });

    it('frees the preview textures on dispose, and closes a source shown after dispose', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      viewer.showPreview('pano-a', source());
      viewer.dispose();
      expect(rendererOf(viewer).removeTile).toHaveBeenCalledWith(1);
      expect(rendererOf(viewer).removeTile).toHaveBeenCalledWith(2);

      const late = source();
      viewer.showPreview('pano-a', late);
      for (const p of late.patches) {
        expect(
          (p.image as unknown as { close: ReturnType<typeof vi.fn> }).close,
        ).toHaveBeenCalled();
      }
      expect(rendererOf(viewer).uploadTile).toHaveBeenCalledTimes(2);
    });
  });

  describe('loads and camera moves', () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    const manifestFor = (pano: string) => ({
      pano,
      faceSize: 2048,
      tileSize: 512,
      maxLevel: 2,
      faces: [...FACES],
      quality: 82,
      format: 'jpg',
    });

    /**
     * Manifests resolve at once unless `holdManifest` matches; tiles answer at
     * once unless `holdTile` matches. A held request waits for release(), and
     * rejects with an AbortError if its signal aborts first.
     */
    function stubNet(
      opts: { holdManifest?: (url: string) => boolean; holdTile?: (url: string) => boolean } = {},
    ) {
      const held: (() => void)[] = [];
      const signals = new Map<string, AbortSignal | undefined>();
      const body = { ok: true, status: 200, blob: () => Promise.resolve({}) };
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: { signal?: AbortSignal }) => {
          signals.set(url, init?.signal);
          const m = /\/tiles\/([^/]+)\/manifest\.json$/.exec(url);
          const answer = m
            ? { ok: true, status: 200, json: () => Promise.resolve(manifestFor(m[1]!)) }
            : body;
          const hold = m ? opts.holdManifest : opts.holdTile;
          if (!hold?.(url)) return Promise.resolve(answer);
          return new Promise((resolve, reject) => {
            held.push(() => resolve(answer));
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          });
        }),
      );
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(() => Promise.resolve({ close: vi.fn() })),
      );
      return {
        release: () => held.splice(0).forEach((r) => r()),
        signalOf: (url: string) => signals.get(url),
      };
    }

    /** A container and document that can take the transition overlay. */
    function stubOverlayDom() {
      const overlays: { style: Record<string, string>; remove: ReturnType<typeof vi.fn> }[] = [];
      vi.stubGlobal('document', {
        createElement: vi.fn(() => {
          const el = { style: {} as Record<string, string>, remove: vi.fn() };
          overlays.push(el);
          return el;
        }),
      });
      const container = {
        clientWidth: 400,
        clientHeight: 800,
        appendChild: vi.fn(),
      } as unknown as HTMLElement;
      return { container, overlays };
    }

    function source() {
      const image = () => ({ width: 1026, height: 1024, close: vi.fn() }) as unknown as ImageBitmap;
      return {
        width: 2048,
        height: 1024,
        patches: [
          { x: 0, y: 0, w: 1026, h: 1024, image: image() },
          { x: 1022, y: 0, w: 1026, h: 1024, image: image() },
        ],
      };
    }

    it('eases setView the short way round after the yaw has wound up several turns', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        initialView: { yaw: 4 * Math.PI + 0.1 },
      });
      const before = internals(viewer).view.yaw;
      viewer.setView({ yaw: 0.1 });
      tick(viewer);
      expect(Math.abs(internals(viewer).view.yaw - before)).toBeLessThan(0.1);
      expect(viewer.getView().yaw).toBeCloseTo(0.1, 10);
    });

    it('takes the short way across the seam', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        initialView: { yaw: Math.PI - 0.1 },
      });
      viewer.setView({ yaw: -Math.PI + 0.1 });
      // 0.2 rad forward across ±π, not 2π − 0.2 back.
      expect(internals(viewer).target.yaw).toBeCloseTo(Math.PI + 0.1, 10);
      expect(viewer.getView().yaw).toBeCloseTo(-Math.PI + 0.1, 10);
    });

    it('keeps yaw bounded when dragging round and round', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        initialView: { yaw: 2 * Math.PI - 0.01 },
      });
      internals(viewer).panByPixels(-100, 0); // drag left → look right, past 2π
      expect(Math.abs(internals(viewer).view.yaw)).toBeLessThan(2 * Math.PI);
      expect(internals(viewer).target.yaw).toBe(internals(viewer).view.yaw);
    });

    it('clamps initialView pitch and fov', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        initialView: { pitch: 3, fov: 500 },
        maxFov: 80,
      });
      const view = viewer.getView();
      expect(view.pitch).toBeLessThan(Math.PI / 2);
      expect(view.fov).toBe(80);
      expect(internals(viewer).view.pitch).toBe(view.pitch);
      expect(internals(viewer).view.fov).toBe(80);
    });

    it('clears momentum on setView', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      internals(viewer).flick(100, 50);
      expect(internals(viewer).momentum.yaw).not.toBe(0);
      viewer.setView({ yaw: 0.5 });
      expect(internals(viewer).momentum).toEqual({ yaw: 0, pitch: 0 });
    });

    it('clears momentum when a pano swaps in and when a preview goes up', async () => {
      stubNet();
      const viewer = new PanoViewer(makeContainer(400, 800));
      internals(viewer).flick(100, 50);
      await viewer.load('pano-a');
      expect(internals(viewer).momentum).toEqual({ yaw: 0, pitch: 0 });
      internals(viewer).flick(100, 50);
      viewer.showPreview('pano-b', source());
      expect(internals(viewer).momentum).toEqual({ yaw: 0, pitch: 0 });
      viewer.dispose();
    });

    it('does not settle while momentum is left, however small', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      // rad/ms: a step's travel is under the position settle threshold.
      internals(viewer).momentum.yaw = 2e-6;
      tick(viewer);
      expect(internals(viewer).dirty).toBe(true);
      expect(raf.pending).toBe(1);
    });

    it('keeps the same Controls across loads and previews', async () => {
      stubNet();
      const viewer = new PanoViewer(makeContainer(400, 800));
      const controls = internals(viewer).controls;
      expect(controls).toBeDefined();
      await viewer.load('pano-a');
      viewer.showPreview('pano-b', source());
      await viewer.load('pano-b');
      expect(internals(viewer).controls).toBe(controls);
      viewer.dispose();
    });

    it('resolves true when the load takes effect', async () => {
      stubNet();
      const viewer = new PanoViewer(makeContainer(400, 800));
      await expect(viewer.load('pano-a')).resolves.toBe(true);
      viewer.dispose();
    });

    it('applies load(pano, { view }) at the swap, with no easing', async () => {
      const net = stubNet({ holdTile: (url) => url.includes('/pano-b/') });
      const viewer = new PanoViewer(makeContainer(400, 800));
      await viewer.load('pano-a');
      internals(viewer).flick(100, 0);
      const loading = viewer.load('pano-b', { view: { yaw: 1, pitch: 0.2, fov: 50 } });
      await flush();
      // Not applied before the swap: the old pano keeps its camera.
      expect(viewer.getView().yaw).toBe(0);
      net.release();
      await expect(loading).resolves.toBe(true);
      expect(internals(viewer).target).toEqual({ yaw: 1, pitch: 0.2, fov: 50 });
      expect(internals(viewer).view).toEqual({ yaw: 1, pitch: 0.2, fov: 50 });
      expect(internals(viewer).momentum).toEqual({ yaw: 0, pitch: 0 });
      tick(viewer);
      expect(internals(viewer).view).toEqual({ yaw: 1, pitch: 0.2, fov: 50 });
      viewer.dispose();
    });

    it('disposes the pending layer and aborts the manifest fetch of a superseded load', async () => {
      const net = stubNet({
        holdTile: (url) => url.includes('/pano-a/'),
        holdManifest: (url) => url.includes('/pano-b/'),
      });
      const viewer = new PanoViewer(makeContainer(400, 800));
      const a = viewer.load('pano-a');
      await flush();
      const [layerA] = [...internals(viewer).pendingLayers];
      expect(layerA).toBeDefined();
      const disposeA = vi.spyOn(layerA!, 'dispose');

      const b = viewer.load('pano-b');
      expect(disposeA).toHaveBeenCalled();
      expect(internals(viewer).pendingLayers.size).toBe(0);
      await expect(a).resolves.toBe(false);

      const signalB = net.signalOf('/tiles/pano-b/manifest.json');
      expect(signalB?.aborted).toBe(false);
      viewer.showPreview('pano-c', source());
      expect(signalB?.aborted).toBe(true);
      await expect(b).resolves.toBe(false);
      viewer.dispose();
    });

    it('resolves false, without throwing, when a superseded manifest fetch rejects', async () => {
      const net = stubNet({ holdManifest: (url) => url.includes('/pano-a/') });
      const viewer = new PanoViewer(makeContainer(400, 800));
      const a = viewer.load('pano-a');
      await viewer.load('pano-b');
      expect(net.signalOf('/tiles/pano-a/manifest.json')?.aborted).toBe(true);
      await expect(a).resolves.toBe(false);
      viewer.dispose();
    });

    it('never applies a superseded transition view, and drops its overlay at once', async () => {
      const net = stubNet({ holdTile: (url) => /\/pano-[ab]\//.test(url) });
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container);
      await viewer.load('pano-0');
      tick(viewer);

      const a = viewer.transitionTo('pano-a', { yaw: 2 });
      await flush();
      expect(overlays).toHaveLength(1);
      expect(overlays[0]!.remove).not.toHaveBeenCalled();

      // Gone as soon as B starts, not when A's load finally gives up.
      const b = viewer.load('pano-b', { view: { yaw: -1 } });
      expect(overlays[0]!.remove).toHaveBeenCalled();

      // A settles first, while B is still loading: the camera stays put.
      await a;
      expect(viewer.getView().yaw).toBe(0);

      net.release();
      await expect(b).resolves.toBe(true);
      expect(viewer.getView().yaw).toBe(-1);
      viewer.dispose();
    });

    it('drops a transition overlay when a preview supersedes it', async () => {
      stubNet({ holdTile: (url) => url.includes('/pano-a/') });
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container);
      await viewer.load('pano-0');
      tick(viewer);

      const a = viewer.transitionTo('pano-a', { yaw: 2 });
      await flush();
      viewer.showPreview('pano-c', source());
      expect(overlays[0]!.remove).toHaveBeenCalled();
      await a;
      expect(viewer.getView().yaw).toBe(0);
      viewer.dispose();
    });

    it('keeps rendering when an onRender callback throws', () => {
      const report = vi.fn();
      vi.stubGlobal('reportError', report);
      const viewer = new PanoViewer(makeContainer(400, 800));
      const boom = new Error('boom');
      viewer.onRender(() => {
        throw boom;
      });
      const after = vi.fn();
      viewer.onRender(after);
      const render = internals(viewer).renderer.render;
      render.mockClear();

      expect(() => tick(viewer)).not.toThrow();
      expect(render).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(boom);
    });

    it('renders the frame before emitting tiles-settled, and reports a throwing listener', () => {
      const report = vi.fn();
      vi.stubGlobal('reportError', report);
      const viewer = new PanoViewer(makeContainer(400, 800));
      internals(viewer).layer = { update: vi.fn(), drawList: () => [], hasPending: () => false };
      internals(viewer).wasPending = true;
      const render = internals(viewer).renderer.render;
      render.mockClear();
      const boom = new Error('listener');
      viewer.on('tiles-settled', () => {
        expect(render).toHaveBeenCalledTimes(1);
        throw boom;
      });
      const after = vi.fn();
      viewer.onRender(after);
      expect(() => tick(viewer)).not.toThrow();
      expect(render).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(boom);
      // The frame carries on past the listener: render callbacks still run.
      expect(after).toHaveBeenCalledTimes(1);
    });

    describe('asks for exactly one frame, from idle, when', () => {
      type Row = [string, () => Promise<{ viewer: PanoViewer | undefined; fire: () => unknown }>];
      const idleViewer = (options = {}) => new PanoViewer(makeContainer(400, 800), options);
      const rows: Row[] = [
        [
          'a held tile lands',
          async () => {
            const net = stubNet({ holdTile: (url) => !url.includes('/0/') });
            const viewer = idleViewer();
            await viewer.load('pano-a');
            return {
              viewer,
              fire: async () => {
                runUntilIdle();
                net.release();
                await flush();
              },
            };
          },
        ],
        [
          'the ResizeObserver reports a new size',
          async () => {
            vi.stubGlobal('ResizeObserver', FakeResizeObserver);
            const viewer = idleViewer();
            return { viewer, fire: () => FakeResizeObserver.instances[0]!.trigger(500, 500) };
          },
        ],
        [
          'the window resizes (no ResizeObserver)',
          async () => {
            const viewer = idleViewer();
            const onResize = vi
              .mocked(window.addEventListener)
              .mock.calls.find((c) => c[0] === 'resize')![1] as () => void;
            return { viewer, fire: onResize };
          },
        ],
        [
          'a load swaps in',
          async () => {
            // The base resolves without uploading (whose own invalidations
            // would hide the swap's), and the primed detail tiles never land.
            stubNet({ holdTile: () => true });
            vi.spyOn(TileLayer.prototype, 'loadBase').mockResolvedValue();
            const viewer = idleViewer();
            return {
              viewer,
              fire: async () => {
                runUntilIdle();
                await expect(viewer.load('pano-a')).resolves.toBe(true);
              },
            };
          },
        ],
        [
          'a preview goes up',
          async () => {
            const viewer = idleViewer();
            return { viewer, fire: () => viewer.showPreview('pano-a', source()) };
          },
        ],
        [
          'auto-rotate resumes after the idle wait',
          async () => {
            vi.useFakeTimers();
            vi.stubGlobal('requestAnimationFrame', raf.request);
            vi.stubGlobal('cancelAnimationFrame', raf.cancel);
            const viewer = idleViewer({ autoRotate: true, autoRotateIdleMs: 1000 });
            internals(viewer).stopMomentum(); // an interaction pauses it
            return {
              viewer,
              fire: () => {
                runUntilIdle();
                vi.advanceTimersByTime(1000);
              },
            };
          },
        ],
        [
          'auto-rotate is switched on',
          async () => {
            const viewer = idleViewer();
            return { viewer, fire: () => viewer.setAutoRotate(true) };
          },
        ],
        [
          'a render callback subscribes',
          async () => {
            const viewer = idleViewer();
            return { viewer, fire: () => viewer.onRender(() => {}) };
          },
        ],
        [
          'the viewer is constructed',
          async () => {
            let viewer: PanoViewer | undefined;
            return {
              get viewer() {
                return viewer;
              },
              fire: () => {
                viewer = idleViewer();
              },
            };
          },
        ],
      ];

      afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
      });

      it.each(rows)('%s', async (_name, setup) => {
        const row = await setup();
        runUntilIdle();
        expect(raf.pending).toBe(0);
        await row.fire();
        expect(raf.pending).toBe(1);
        const viewer = row.viewer!;
        const render = internals(viewer).renderer.render;
        render.mockClear();
        raf.step();
        expect(render).toHaveBeenCalledTimes(1);
        viewer.dispose();
      });
    });

    it('listens to window resize only without a ResizeObserver', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const viewer = new PanoViewer(makeContainer(400, 800));
      expect(window.addEventListener).not.toHaveBeenCalledWith('resize', expect.anything());
      viewer.dispose();
    });

    it('steps one nominal 60 Hz frame for the first frame after an idle spell', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      runUntilIdle();
      viewer.setView({ yaw: 1 });
      raf.step(raf.now + 10_000);
      // damping 0.25 per 16.67 ms: one quarter of the way.
      expect(internals(viewer).view.yaw).toBeCloseTo(0.25, 10);
      viewer.dispose();
    });

    it('caps a stalled frame at 100 ms of motion', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      runUntilIdle();
      viewer.setView({ yaw: 1 });
      raf.step(); // running now, at 0.25
      raf.step(raf.now + 5000);
      // 100 ms is six 60 Hz frames of damping 0.25.
      expect(internals(viewer).view.yaw).toBeCloseTo(1 - 0.75 * 0.75 ** 6, 10);
      viewer.dispose();
    });

    it('lets the loop stop when auto-rotate is on at zero speed', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        autoRotate: true,
        autoRotateSpeed: 0,
      });
      expect(runUntilIdle()).toBeLessThan(10);
      expect(raf.pending).toBe(0);
      viewer.dispose();
    });

    it('zooms about the pointer through the canvas rect, CSS transforms included', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      runUntilIdle();
      // Scaled 2x by a CSS transform: the layout size is 400x800, the rect 800x1600.
      const canvas = internals(viewer).renderer.canvas as unknown as {
        getBoundingClientRect: () => DOMRect;
      };
      canvas.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 800, height: 1600 }) as DOMRect;
      canvasListener(
        viewer,
        'wheel',
      )({
        deltaY: -100,
        deltaX: 0,
        deltaMode: 0,
        ctrlKey: false,
        metaKey: false,
        clientX: 400, // the centre of the rect
        clientY: 800,
        preventDefault: vi.fn(),
      });
      const { target } = internals(viewer);
      expect(target.fov).toBeLessThan(70);
      expect(target.yaw).toBeCloseTo(0, 10);
      expect(target.pitch).toBeCloseTo(0, 10);
      viewer.dispose();
    });

    /** Let `p` finish, stepping frames for its fade. */
    async function finish(p: Promise<unknown>): Promise<void> {
      let done = false;
      void p.then(() => (done = true));
      for (let i = 0; i < 50 && !done; i++) {
        await flush();
        raf.step();
      }
      await p;
    }

    it('cuts only the axes load(pano, { view }) sets, leaving the others easing', async () => {
      stubNet();
      const viewer = new PanoViewer(makeContainer(400, 800));
      await viewer.load('pano-a');
      viewer.setView({ fov: 40 }); // not drawn yet: the camera is still at 70
      await viewer.load('pano-b', { view: { yaw: 1 } });
      expect(internals(viewer).view.yaw).toBe(1);
      expect(internals(viewer).view.fov).toBe(70);
      expect(internals(viewer).target.fov).toBe(40);
      viewer.dispose();
    });

    it('does not announce a scene change for a load a ready listener superseded', async () => {
      stubNet({ holdTile: (url) => url.includes('/pano-b/') });
      const viewer = new PanoViewer(makeContainer(400, 800));
      const sceneChange = vi.fn();
      viewer.on('scene-change', sceneChange);
      let b: Promise<boolean> | undefined;
      viewer.on('ready', (m) => {
        if (m.pano === 'pano-a') b = viewer.load('pano-b');
      });
      await expect(viewer.load('pano-a')).resolves.toBe(true);
      expect(b).toBeDefined();
      expect(sceneChange).not.toHaveBeenCalled();
      viewer.dispose();
      await expect(b).resolves.toBe(false);
    });

    it('does nothing when transitionTo is called after dispose', async () => {
      stubNet();
      const viewer = new PanoViewer(makeContainer(400, 800));
      viewer.dispose();
      await expect(viewer.transitionTo('pano-a', { yaw: 1 })).resolves.toBeUndefined();
      expect(window.matchMedia).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('hands over to a newer transitionTo: the older one applies nothing and loses its overlay', async () => {
      const net = stubNet({ holdTile: (url) => /\/pano-[ab]\//.test(url) });
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container, { transitionMs: 0 });
      await viewer.load('pano-0');
      tick(viewer);

      const a = viewer.transitionTo('pano-a', { yaw: 2 });
      await flush();
      const b = viewer.transitionTo('pano-b', { yaw: -1 });
      expect(overlays).toHaveLength(2);
      expect(overlays[0]!.remove).toHaveBeenCalled();
      expect(overlays[1]!.remove).not.toHaveBeenCalled();
      await a;
      expect(viewer.getView().yaw).toBe(0);

      net.release();
      await finish(b);
      expect(viewer.getView().yaw).toBe(-1);
      expect(overlays[1]!.style['opacity']).toBe('0');
      expect(overlays[1]!.remove).toHaveBeenCalled();
      viewer.dispose();
    });

    it('drops the overlay at once when disposed during the fade', async () => {
      stubNet();
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container, { transitionMs: 30 });
      await viewer.load('pano-0');
      tick(viewer);

      let done = false;
      const fading = viewer.transitionTo('pano-a').then(() => (done = true));
      for (let i = 0; i < 50 && overlays[0]?.style['opacity'] !== '0'; i++) {
        await flush();
        raf.step();
      }
      expect(overlays[0]!.style['opacity']).toBe('0');
      expect(overlays[0]!.remove).not.toHaveBeenCalled();
      viewer.dispose();
      expect(overlays[0]!.remove).toHaveBeenCalled();
      expect(done).toBe(false);
      await fading;
      expect(done).toBe(true);
    });

    it('runs an A→B→C chain of transitions to C alone', async () => {
      const net = stubNet({ holdTile: (url) => /\/pano-[abc]\//.test(url) });
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container, { transitionMs: 0 });
      await viewer.load('pano-0');
      tick(viewer);
      const sceneChange = vi.fn();
      viewer.on('scene-change', sceneChange);

      const a = viewer.transitionTo('pano-a', { yaw: 1 });
      await flush();
      const b = viewer.transitionTo('pano-b', { yaw: 2 });
      await flush();
      const c = viewer.transitionTo('pano-c', { yaw: -1 });
      expect(overlays).toHaveLength(3);
      expect(overlays[0]!.remove).toHaveBeenCalled();
      expect(overlays[1]!.remove).toHaveBeenCalled();
      expect(overlays[2]!.remove).not.toHaveBeenCalled();
      await Promise.all([a, b]);
      expect(viewer.getView().yaw).toBe(0);

      net.release();
      await finish(c);
      expect(viewer.getView().yaw).toBe(-1);
      expect(sceneChange.mock.calls).toEqual([['pano-c']]);
      expect(overlays[2]!.remove).toHaveBeenCalled();
      const layer = internals(viewer).layer as { manifest: { pano: string } };
      expect(layer.manifest.pano).toBe('pano-c');
      viewer.dispose();
    });
  });
});
