import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FACES } from '@panote/core';
import { PanoViewer } from './PanoViewer.js';
import { setSharedTileFailureMonitor } from './tile-retry.js';

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
  constructor(private cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: unknown): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  trigger(): void {
    this.cb();
  }
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
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    FakeResizeObserver.instances = [];
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

      // The constructor already runs loop() once (to draw the first frame),
      // which consumes the initial `dirty = true` and sets it back to false
      // once the frame settles — so it must be re-armed here for this
      // explicit call to run the render body instead of early-returning on
      // the `if (!this.dirty) return;` guard.
      (viewer as unknown as { dirty: boolean }).dirty = true;
      (viewer as unknown as { loop: () => void }).loop();

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
      (viewer as unknown as { dirty: boolean }).dirty = true;
      (viewer as unknown as { loop: () => void }).loop();
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
      expect(tileRequests).toHaveLength(FACES.length);
      for (const face of FACES) expect(tileRequests).toContain(baseTileUrl(face));
      expect(settled).toBe(false);
      expect(ready).not.toHaveBeenCalled();

      releaseLast!();
      await load;
      expect(settled).toBe(true);
      expect(ready).toHaveBeenCalledTimes(1);
      viewer.dispose();
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
        expect(tileRequests).toHaveLength(FACES.length);

        viewer.dispose();
        // Resolving (not rejecting) is the deliberate choice: it matches every
        // other disposed/superseded exit in load(), and a caller that disposed
        // the viewer is not waiting to be told its load did not finish.
        await load;
        expect(settled).toBe(true);
        expect(tileRequests).toHaveLength(FACES.length);
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
        expect(tileRequests).toHaveLength(FACES.length);

        status = 200; // the origin recovers — a retry would now succeed
        viewer.dispose();
        await expect(load).resolves.toBeUndefined();
        await flush();

        expect(tileRequests).toHaveLength(FACES.length);
        expect(fakeRendererOf(viewer).uploadTile).not.toHaveBeenCalled();
      });
    });
  });

  describe('compass north offset and heading', () => {
    it('defaults to north=0 and heading tracking the initial yaw', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        initialView: { yaw: 0.4 },
      });
      expect(viewer.getNorth()).toBe(0);
      expect(viewer.heading()).toBeCloseTo(-0.4, 10);
    });

    it('setNorth updates getNorth and heading immediately', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        initialView: { yaw: 0.4 },
      });
      viewer.setNorth(1.2);
      expect(viewer.getNorth()).toBe(1.2);
      expect(viewer.heading()).toBeCloseTo(0.8, 10);
    });
  });

  describe('auto-rotate', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Fake timers auto-invoke requestAnimationFrame as time advances below;
      // restub it inert so these tests drive the loop only via tick() calls.
      vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn(() => 1),
      );
      vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Force the loop out of its "nothing changed" early return and run one tick. */
    function tick(viewer: PanoViewer): void {
      (viewer as unknown as { dirty: boolean }).dirty = true;
      (viewer as unknown as { loop: () => void }).loop();
    }

    function yawOf(viewer: PanoViewer): number {
      return (viewer as unknown as { view: { yaw: number } }).view.yaw;
    }

    it('does not rotate when disabled', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      const before = yawOf(viewer);
      vi.advanceTimersByTime(50);
      tick(viewer);
      expect(yawOf(viewer)).toBeCloseTo(before, 10);
    });

    it('rotates the view forward once real time elapses between frames', () => {
      // damping: 1 snaps view straight to target, so a tick's delta is exactly
      // autoRotateSpeed times the elapsed seconds, with no easing to account for.
      const viewer = new PanoViewer(makeContainer(400, 800), {
        autoRotate: true,
        autoRotateSpeed: 1,
        damping: 1,
      });
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
      viewer.stopMomentum(); // stands in for a real interaction's gesture start
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
      viewer.stopMomentum();
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

    function tick(viewer: PanoViewer): void {
      (viewer as unknown as { dirty: boolean }).dirty = true;
      (viewer as unknown as { loop: () => void }).loop();
    }

    /** Two 1026×1024 patches with a 2 px gutter, over a 2048×1024 source. */
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

    const manifestFor = (pano: string) => ({
      pano,
      faceSize: 2048,
      tileSize: 512,
      maxLevel: 2,
      faces: [...FACES],
      quality: 82,
      format: 'jpg',
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
      expect(lastDrawList(viewer)).toEqual([
        { handle: 1, level: 0.5 },
        { handle: 2, level: 0.5 },
      ]);
      viewer.dispose();
    });

    it('works with controls, hotspots, directionAtPixel and north as on tiles', () => {
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

      const style: Record<string, string> = {};
      const el = { style, remove: vi.fn() } as unknown as HTMLElement;
      const container = viewer.el as unknown as { appendChild: (e: unknown) => void };
      container.appendChild = vi.fn();
      viewer.addHotspot(el, { yaw: 0.5, pitch: 0.2 });
      tick(viewer);
      expect(style['visibility']).toBe('visible');
      const [, x, y] = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)$/.exec(style['transform']!)!;
      expect(Number(x)).toBeCloseTo(200, 3);
      expect(Number(y)).toBeCloseTo(400, 3);
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
      expect(lastDrawList(viewer).every((d) => d.level === 0.5)).toBe(true);
      expect(lastDrawList(viewer)).toHaveLength(2);
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
});
