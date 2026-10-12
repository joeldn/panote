import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FACES } from './cube.js';
import { TileLayer } from './tile-layer.js';
import { FakeResizeObserver, flushTasks as flush } from './test-support/fake-dom.js';
import {
  useViewerGlobals,
  TestViewer,
  tick,
  makeContainer,
} from './test-support/viewer-harness.js';

vi.mock('./render/gl-renderer.js', () => import('./test-support/fake-gl-renderer.js'));

describe('PanoViewer', () => {
  useViewerGlobals();

  describe('device-pixel-ratio-aware level selection', () => {
    it('passes the renderer canvas device-pixel height to the tile layer, not the CSS clientHeight', () => {
      // update() needs the framebuffer's device-pixel height, not CSS
      // height, or selectLevel() picks a level coarser than the screen can
      // show. FakeGLRenderer.resize() scales 2x, so clientHeight=800 must
      // produce canvas.height=1600 here.
      const container = makeContainer(400, 800);
      const viewer = new TestViewer(container);

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
      const viewer = new TestViewer(container);
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

    /**
     * Stub a host whose display reports `dpr`, with every fetch succeeding;
     * `phone` makes it a touch-first 390 × 844 screen.
     */
    function stubDisplay(dpr: number | undefined, phone = false): void {
      vi.stubGlobal('window', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        matchMedia: vi.fn((q: string) => ({ matches: phone && q === '(pointer: coarse)' })),
        screen: phone ? { width: 390, height: 844 } : { width: 1512, height: 982 },
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
     * manifest's tileSize is 512, so one tile with its mips is 4/3 MiB and the
     * tile count is three quarters of the budget in MB — the layer having the
     * right number of them is the only thing the budget is for.
     */
    async function loadedMaxTiles(viewer: TestViewer): Promise<number> {
      await viewer.load('pano-a');
      return (viewer as unknown as { layer: { maxTiles: number } }).layer.maxTiles;
    }

    it('doubles the default budget on a devicePixelRatio-2 display', async () => {
      stubDisplay(2);
      const viewer = new TestViewer(makeContainer(1422, 800));
      expect(await loadedMaxTiles(viewer)).toBe(192);
      viewer.dispose();
    });

    it('leaves the default budget alone when the host reports no pixel ratio', async () => {
      stubDisplay(undefined);
      const viewer = new TestViewer(makeContainer(1422, 800));
      expect(await loadedMaxTiles(viewer)).toBe(96);
      viewer.dispose();
    });

    it('does not scale past the cap on a devicePixelRatio-3 display', async () => {
      stubDisplay(3);
      const viewer = new TestViewer(makeContainer(1422, 800));
      expect(await loadedMaxTiles(viewer)).toBe(192);
      viewer.dispose();
    });

    it('holds a phone to the base budget whatever its pixel ratio', async () => {
      stubDisplay(3, true);
      const viewer = new TestViewer(makeContainer(390, 844));
      expect(await loadedMaxTiles(viewer)).toBe(96);
      viewer.dispose();
    });

    it('uploads four decoded tiles a frame on a phone, eight elsewhere', async () => {
      const maxUploads = async (viewer: TestViewer): Promise<number> => {
        await viewer.load('pano-a');
        return (viewer as unknown as { layer: { maxUploads: number } }).layer.maxUploads;
      };
      stubDisplay(3, true);
      const phone = new TestViewer(makeContainer(390, 844));
      expect(await maxUploads(phone)).toBe(4);
      phone.dispose();
      stubDisplay(2);
      const laptop = new TestViewer(makeContainer(1422, 800));
      expect(await maxUploads(laptop)).toBe(8);
      laptop.dispose();
    });

    it('gives a phone the budget its host names', async () => {
      stubDisplay(3, true);
      const viewer = new TestViewer(makeContainer(390, 844), {
        memory: { textureBudgetMB: 256 },
      });
      expect(await loadedMaxTiles(viewer)).toBe(192);
      viewer.dispose();
    });

    it('honours an explicit textureBudgetMB exactly, scaling it neither up nor down', async () => {
      // A caller who names a budget is naming an absolute one: it is not
      // multiplied by the pixel ratio, and it is not clamped to the cap the
      // default is subject to.
      stubDisplay(2);
      const small = new TestViewer(makeContainer(1422, 800), { memory: { textureBudgetMB: 64 } });
      expect(await loadedMaxTiles(small)).toBe(48);
      small.dispose();

      const large = new TestViewer(makeContainer(1422, 800), { memory: { textureBudgetMB: 512 } });
      expect(await loadedMaxTiles(large)).toBe(384);
      large.dispose();
    });
  });

  describe('resize observation', () => {
    it('observes the container with a ResizeObserver and disconnects it on dispose', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const container = makeContainer(400, 800);
      const viewer = new TestViewer(container);

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
      expect(() => new TestViewer(container)).not.toThrow();
    });
  });

  describe('source resolution', () => {
    it("rejects with the resolver's error when resolveSource rejects", async () => {
      const failure = new Error('no such panorama');
      const viewer = new TestViewer(makeContainer(400, 800), {
        resolveSource: () => Promise.reject(failure),
      });
      await expect(viewer.load('missing-pano')).rejects.toBe(failure);
      viewer.dispose();
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

      const viewer = new TestViewer(makeContainer(400, 800));
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
        const viewer = new TestViewer(makeContainer(400, 800));
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
      const viewer = new TestViewer(makeContainer(400, 800));
      const sceneChange = vi.fn();
      viewer.on('scene-change', sceneChange);

      await viewer.load('pano-a');

      expect(sceneChange).toHaveBeenCalledTimes(1);
      expect(sceneChange).toHaveBeenCalledWith({ id: 'pano-a', kind: 'tiles' });
      viewer.dispose();
    });

    it('rejects when a base tile is permanently missing', async () => {
      stubFetch((url) =>
        url === baseTileUrl('py')
          ? Promise.resolve({ ok: false, status: 404, blob: () => Promise.resolve({}) })
          : Promise.resolve(tileBody),
      );

      const viewer = new TestViewer(makeContainer(400, 800));
      const ready = vi.fn();
      viewer.on('ready', ready);

      await expect(viewer.load('pano-a')).rejects.toThrow(/low-resolution base tile for face "py"/);
      expect(ready).not.toHaveBeenCalled();
      viewer.dispose();
    });

    it('leaves no layer behind when the base load fails, and disposes cleanly', async () => {
      stubFetch(() => Promise.resolve({ ok: false, status: 404, blob: () => Promise.resolve({}) }));

      const viewer = new TestViewer(makeContainer(400, 800));
      await expect(viewer.load('pano-a')).rejects.toThrow();

      expect((viewer as unknown as { layer: unknown }).layer).toBeUndefined();
      expect(() => viewer.dispose()).not.toThrow();
      // Idempotent: a second dispose after a failed load is still harmless.
      expect(() => viewer.dispose()).not.toThrow();
    });

    it('keeps the panorama already on screen when a later load fails', async () => {
      stubFetch(() => Promise.resolve(tileBody));
      const viewer = new TestViewer(makeContainer(400, 800));
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
      // Until its base is resident the incoming layer is not `this.layer`:
      // dispose() reaches it through `pendingLayers`, so its six base fetches
      // stop before the WebGL context they would upload into is gone.
      const fakeRendererOf = (viewer: TestViewer) =>
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

        const viewer = new TestViewer(makeContainer(400, 800));
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

        const viewer = new TestViewer(makeContainer(400, 800));
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
});
