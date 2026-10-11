import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FACES } from './cube.js';
import { PanoViewer as BasePanoViewer } from './PanoViewer.js';
import { dirFromYawPitch } from './project.js';
import { effectiveVFovDeg } from './render/projection.js';
import type { CubeTileSource } from './source.js';
import type { View, ViewerOptions } from './types.js';
import { TileLayer } from './tile-layer.js';

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
  class ContextLostError extends Error {
    override name = 'ContextLostError';
  }
  class FakeGLRenderer {
    // The listener/style/tabIndex surface is what Controls attaches to once a
    // load succeeds (see controls.ts) — nothing here reads it back.
    canvas = {
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      tabIndex: 0,
      attributes: {} as Record<string, string>,
      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
      },
      focus: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    };
    nextHandle = 1;
    maxTextureSize = 16384;
    lost = false;
    dispose = vi.fn();
    uploadTile = vi.fn(() => {
      if (this.lost) throw new ContextLostError();
      return this.nextHandle++;
    });
    removeTile = vi.fn();
    constructor(
      _container: unknown,
      readonly opts: { onContextLost?: () => void; onContextRestored?: () => void } = {},
    ) {}
    // Scaled by the window's devicePixelRatio, 2 when it reports none, as
    // the real GLRenderer.resize() does (see gl-renderer.ts). Like it, says
    // whether anything changed.
    resize = vi.fn((w: number, h: number): boolean => {
      const dpr = (globalThis as { window?: { devicePixelRatio?: number } }).window
        ?.devicePixelRatio;
      const bw = Math.round(w * (dpr ?? 2));
      const bh = Math.round(h * (dpr ?? 2));
      if (bw === this.canvas.width && bh === this.canvas.height) return false;
      this.canvas.width = bw;
      this.canvas.height = bh;
      return true;
    });
    isContextLost(): boolean {
      return this.lost;
    }
    setCamera(): void {}
    render = vi.fn();
    snapshot = vi.fn((): unknown => document.createElement('canvas'));
    /** Stand-ins for the browser's webglcontextlost and webglcontextrestored. */
    loseContext(): void {
      this.lost = true;
      this.opts.onContextLost?.();
    }
    restoreContext(): void {
      this.lost = false;
      this.opts.onContextRestored?.();
    }
  }
  return { GLRenderer: FakeGLRenderer, ContextLostError };
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

/**
 * Most tests here load by id, against a host laid out like panote's: an id
 * resolves through a manifest at /tiles/<id>/manifest.json, fetched with the
 * load's signal, to a source whose tiles live under the same prefix (and
 * under the version, when the manifest has one). The tests stub fetch for
 * that layout.
 */
async function manifestResolver(id: string, signal: AbortSignal): Promise<CubeTileSource> {
  const res = await fetch(`/tiles/${id}/manifest.json`, { signal });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  const m = (await res.json()) as {
    pano: string;
    tileSize: number;
    maxLevel: number;
    format?: string;
    version?: string;
  };
  const prefix = `/tiles/${m.pano}/${m.version === undefined ? '' : `${m.version}/`}`;
  return {
    id: m.pano,
    tileSize: m.tileSize,
    maxLevel: m.maxLevel,
    version: m.version,
    meta: m,
    tileUrl: (t) => `${prefix}${t.level}/${t.face}/${t.x}-${t.y}.${m.format ?? 'jpg'}`,
  };
}

/** The viewer under test, with that resolver unless a test passes its own. */
class PanoViewer extends BasePanoViewer {
  constructor(container: HTMLElement, options: ViewerOptions = {}) {
    super(container, { resolveSource: manifestResolver, ...options });
  }
}

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
    canvas: { addEventListener: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
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
    // One clock for frames and everything else (the tile layer's grace
    // periods), as rAF timestamps and performance.now() share an origin.
    vi.spyOn(performance, 'now').mockImplementation(() => raf.now);
    FakeResizeObserver.instances = [];
    FakeIntersectionObserver.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
     * manifest's tileSize is 512, so one tile with its mips is 4/3 MiB and the
     * tile count is three quarters of the budget in MB — the layer having the
     * right number of them is the only thing the budget is for.
     */
    async function loadedMaxTiles(viewer: PanoViewer): Promise<number> {
      await viewer.load('pano-a');
      return (viewer as unknown as { layer: { maxTiles: number } }).layer.maxTiles;
    }

    it('doubles the default budget on a devicePixelRatio-2 display', async () => {
      stubDisplay(2);
      const viewer = new PanoViewer(makeContainer(1422, 800));
      expect(await loadedMaxTiles(viewer)).toBe(192);
      viewer.dispose();
    });

    it('leaves the default budget alone when the host reports no pixel ratio', async () => {
      stubDisplay(undefined);
      const viewer = new PanoViewer(makeContainer(1422, 800));
      expect(await loadedMaxTiles(viewer)).toBe(96);
      viewer.dispose();
    });

    it('does not scale past the cap on a devicePixelRatio-3 display', async () => {
      stubDisplay(3);
      const viewer = new PanoViewer(makeContainer(1422, 800));
      expect(await loadedMaxTiles(viewer)).toBe(192);
      viewer.dispose();
    });

    it('honours an explicit textureBudgetMB exactly, scaling it neither up nor down', async () => {
      // A caller who names a budget is naming an absolute one: it is not
      // multiplied by the pixel ratio, and it is not clamped to the cap the
      // default is subject to.
      stubDisplay(2);
      const small = new PanoViewer(makeContainer(1422, 800), { memory: { textureBudgetMB: 64 } });
      expect(await loadedMaxTiles(small)).toBe(48);
      small.dispose();

      const large = new PanoViewer(makeContainer(1422, 800), { memory: { textureBudgetMB: 512 } });
      expect(await loadedMaxTiles(large)).toBe(384);
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
        autoRotate: { enabled: true, speed: 1 },
        camera: { damping: 1 },
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

    it('glides a released drag smoothly from its first frame at 60, 120 and 144 Hz', () => {
      // A drag at 0.6 px/ms, one move per display frame as Chrome sends them,
      // released mid-move; then the camera's yaw speed frame by frame.
      const glide = (hz: number) => {
        const viewer = new PanoViewer(makeContainer(1422, 800));
        runUntilIdle();
        const period = 1000 / hz;
        const ev = (x: number, t: number, buttons = 1) => ({
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons,
          clientX: x,
          clientY: 300,
          timeStamp: t,
        });
        let x = 300;
        canvasListener(viewer, 'pointerdown')(ev(x, raf.now));
        for (let i = 0; i < 20; i++) {
          x += 0.6 * period;
          canvasListener(viewer, 'pointermove')(ev(x, raf.now + period));
          raf.step(raf.now + period);
        }
        canvasListener(viewer, 'pointerup')(ev(x, raf.now + 2, 0));
        const speeds: number[] = [];
        const released = internals(viewer).view.yaw;
        let yaw = released;
        while (raf.pending > 0 && speeds.length < 5000) {
          raf.step(raf.now + period);
          const now = internals(viewer).view.yaw;
          speeds.push(Math.abs(now - yaw) / period);
          yaw = now;
        }
        const total = Math.abs(internals(viewer).view.yaw - released);
        viewer.dispose();
        return { speeds, total };
      };
      const at60 = glide(60);
      expect(at60.speeds.length).toBeGreaterThan(30);
      for (const hz of [60, 120, 144]) {
        const { speeds, total } = hz === 60 ? at60 : glide(hz);
        // Eases in: the first frame moves no faster than the next ones.
        expect(speeds[0]!).toBeLessThan(speeds[1]!);
        const peak = speeds.indexOf(Math.max(...speeds));
        for (let i = 1; i <= peak; i++) expect(speeds[i]!).toBeGreaterThanOrEqual(speeds[i - 1]!);
        // Then only slows, and never stalls, until it settles.
        for (let i = peak + 1; i < speeds.length - 1; i++) {
          expect(speeds[i]!).toBeLessThanOrEqual(speeds[i - 1]!);
          expect(speeds[i]!).toBeGreaterThan(0);
        }
        expect(Math.abs(total / at60.total - 1)).toBeLessThan(0.05);
        expect(Math.abs(Math.max(...speeds) / Math.max(...at60.speeds) - 1)).toBeLessThan(0.1);
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
      const viewer = new PanoViewer(container, { camera: { damping: 1 } });
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
      const embedded = new PanoViewer(makeContainer(400, 800), {
        interaction: { wheel: 'engaged' },
      });
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

  describe('fov limit at wide aspects', () => {
    // The drawn vertical fov is capped by camera.maxHorizontalFov (100°), so
    // on a wide viewport it tops out below camera.maxFov (80°). The requested
    // fov stays what was asked for, whatever the aspect; user zoom steps are
    // taken from the fov drawn, so none of them is lost above the cap.
    const MAX_H = 100;
    const cap = (w: number, h: number) => effectiveVFovDeg(80, MAX_H, w / h);

    function sizedViewer(w: number, h: number, options: ViewerOptions = {}): PanoViewer {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const viewer = new PanoViewer(makeContainer(w, h), options);
      const canvas = internals(viewer).renderer.canvas as unknown as {
        getBoundingClientRect: () => DOMRect;
      };
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h }) as DOMRect;
      runUntilIdle();
      return viewer;
    }

    const resize = (w: number, h: number) => FakeResizeObserver.instances[0]!.trigger(w, h);

    /** The vertical fov drawn this frame. */
    const drawn = (viewer: PanoViewer, w: number, h: number) =>
      effectiveVFovDeg(internals(viewer).view.fov, MAX_H, w / h);

    const host = (viewer: PanoViewer) =>
      internals(viewer) as unknown as {
        pinchStart: (x: number, y: number) => void;
        pinchTo: (s: number, x: number, y: number) => void;
        zoomAt: (s: number, x: number, y: number) => void;
      };

    describe('keeps the requested fov through', () => {
      it('a widen and back', () => {
        const viewer = sizedViewer(1000, 1000);
        resize(2100, 900);
        resize(1000, 1000);
        expect(viewer.getView().fov).toBe(70);
        expect(internals(viewer).view.fov).toBe(70);
        viewer.dispose();
      });

      it('a zero-height blip', () => {
        const viewer = sizedViewer(1600, 900);
        resize(800, 0);
        runUntilIdle();
        resize(1600, 900);
        runUntilIdle();
        expect(viewer.getView().fov).toBe(70);
        expect(internals(viewer).view.fov).toBe(70);
        viewer.dispose();
      });

      it('a zoom during a zero-height blip, stepped from the last real aspect', () => {
        const viewer = sizedViewer(1600, 900);
        resize(800, 0);
        viewer.zoomBy(0.8);
        // Not minFov, as an aspect of 800:1 would give.
        expect(viewer.getView().fov).toBeCloseTo(cap(1600, 900) * 0.8, 6);
        viewer.dispose();
      });

      it('construction in a zero-height container', () => {
        const viewer = sizedViewer(800, 0);
        expect(viewer.getView().fov).toBe(70);
        resize(800, 600);
        runUntilIdle();
        expect(viewer.getView().fov).toBe(70);
        viewer.dispose();
      });

      it('an initialView above the cap, then a turn to portrait', () => {
        const viewer = sizedViewer(1600, 900, { initialView: { fov: 75 } });
        expect(viewer.getView().fov).toBe(75);
        resize(900, 1600);
        runUntilIdle();
        expect(viewer.getView().fov).toBe(75);
        expect(internals(viewer).view.fov).toBe(75);
        viewer.dispose();
      });

      it('setView, so a host persists what it set (admin "Start here" at 16:9)', () => {
        const viewer = sizedViewer(1600, 900);
        expect(viewer.getView().fov).toBe(70);
        viewer.setView({ fov: 78 });
        runUntilIdle();
        expect(viewer.getView().fov).toBe(78);
        viewer.dispose();
      });
    });

    /** Every user zoom input, one step in (toward a smaller fov) at the centre. */
    const stepsIn: [string, (viewer: PanoViewer, w: number, h: number) => void][] = [
      [
        'wheel',
        (viewer, w, h) =>
          canvasListener(
            viewer,
            'wheel',
          )({
            deltaY: -100,
            deltaX: 0,
            deltaMode: 0,
            ctrlKey: false,
            metaKey: false,
            clientX: w / 2,
            clientY: h / 2,
            timeStamp: raf.now,
            preventDefault: vi.fn(),
          }),
      ],
      [
        'pinch',
        (viewer, w, h) => {
          host(viewer).pinchStart(w / 2, h / 2);
          host(viewer).pinchTo(0.9, w / 2, h / 2);
        },
      ],
      ['zoomBy (the zoom buttons)', (viewer) => viewer.zoomBy(0.8)],
      [
        'key',
        (viewer) =>
          canvasListener(
            viewer,
            'keydown',
          )({
            key: '=',
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            preventDefault: vi.fn(),
          }),
      ],
      [
        'double-click',
        (viewer, w, h) =>
          canvasListener(
            viewer,
            'dblclick',
          )({ clientX: w / 2, clientY: h / 2, preventDefault: vi.fn() }),
      ],
    ];

    describe.each([
      { name: '16:9', w: 1600, h: 900 },
      { name: '21:9', w: 2100, h: 900 },
    ])('at $name', ({ w, h }) => {
      it.each(stepsIn)('changes the drawn fov on every %s step in from fully out', (_, step) => {
        const viewer = sizedViewer(w, h);
        // Fully out, asked for by a host: above what the aspect can draw.
        viewer.setView({ fov: 80 });
        runUntilIdle();
        let prev = drawn(viewer, w, h);
        expect(prev).toBeCloseTo(cap(w, h), 6);
        // Three steps: a double-click's 0.6 reaches minFov on the fourth.
        for (let i = 0; i < 3; i++) {
          step(viewer, w, h);
          runUntilIdle();
          const now = drawn(viewer, w, h);
          expect(now).toBeLessThan(prev - 0.5);
          prev = now;
        }
        viewer.dispose();
      });

      it('stops a zoom out at the cap, so the next zoom in is seen at once', () => {
        const viewer = sizedViewer(w, h);
        for (let i = 0; i < 5; i++) viewer.zoomBy(1 / 0.8);
        runUntilIdle();
        expect(viewer.getView().fov).toBeCloseTo(cap(w, h), 6);
        viewer.zoomBy(0.8);
        runUntilIdle();
        expect(drawn(viewer, w, h)).toBeCloseTo(cap(w, h) * 0.8, 6);
        viewer.dispose();
      });
    });

    it('never stores a fov under minFov, even where the cap is under it', () => {
      // 10:1: the cap (13.6°) is narrower than minFov (15°).
      const viewer = sizedViewer(2000, 200);
      viewer.zoomBy(0.5);
      expect(viewer.getView().fov).toBe(15);
      host(viewer).zoomAt(0.5, 1000, 100);
      expect(viewer.getView().fov).toBe(15);
      viewer.dispose();
    });

    it('zooms from the requested fov where it is under the cap', () => {
      const viewer = sizedViewer(1000, 1000);
      viewer.zoomBy(0.5);
      expect(viewer.getView().fov).toBe(35);
      viewer.zoomBy(10);
      expect(viewer.getView().fov).toBe(80);
      viewer.dispose();
    });
  });

  describe('compass north offset and heading', () => {
    it('defaults to north=0 and heading tracking the initial yaw', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), { initialView: { yaw: 0.4 } });
      expect(viewer.heading()).toBeCloseTo(-0.4, 10);
    });

    it('setNorth updates the heading immediately', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), { initialView: { yaw: 0.4 } });
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
      const off = new PanoViewer(makeContainer(400, 800), {
        autoRotate: { speed: 1 },
        camera: { damping: 1 },
      });
      const on = new PanoViewer(makeContainer(400, 800), {
        autoRotate: { enabled: true, speed: 1 },
        camera: { damping: 1 },
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
        autoRotate: { enabled: true, speed: 1 },
        camera: { damping: 1 },
      });
      tick(viewer); // the first frame only sets the timing baseline
      const before = yawOf(viewer);
      vi.advanceTimersByTime(50); // well under the stalled-frame clamp
      tick(viewer);
      expect(yawOf(viewer)).toBeCloseTo(before + 0.05, 10);
    });

    it('pauses on interaction and resumes only after the idle window elapses', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), {
        autoRotate: { enabled: true, speed: 1, idleMs: 1000 },
        camera: { damping: 1 },
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
        autoRotate: { enabled: true, speed: 1, idleMs: 1000 },
        camera: { damping: 1 },
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
        autoRotate: { speed: 1, idleMs: 5000 }, // idle much longer than the delay used below
        camera: { damping: 1 },
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
        autoRotate: { enabled: true, speed: 1 },
        camera: { damping: 1 },
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
        autoRotate: { enabled: true, speed: 5 }, // one clamped 100ms tick crosses the threshold
        camera: { damping: 1 },
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

    it('cuts to options.view as the preview goes up, and keeps easing the other axes', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      viewer.setView({ pitch: 0.3 });
      viewer.showPreview('pano-a', source(), { view: { yaw: 1, fov: 50 } });
      const { view } = internals(viewer);
      expect(view.yaw).toBe(1);
      expect(view.fov).toBe(50);
      // Pitch was on its way to 0.3 and is left to get there.
      expect(view.pitch).toBe(0);
      expect(viewer.getView()).toEqual({ yaw: 1, pitch: 0.3, fov: 50 });
      viewer.dispose();
    });

    it('works with controls, project, directionAtPixel and north as on tiles', () => {
      const viewer = new PanoViewer(makeContainer(400, 800), { camera: { damping: 1 } });
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
      let holding = true;
      const tiles = stubTiles((url) => holding && detailTile(url));
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
      holding = false; // parents queued after the release must not wait either
      tiles.release();
      await settle(viewer, settled);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(rendererOf(viewer).removeTile).not.toHaveBeenCalledWith(1);
      expect(previewItems(viewer)).toHaveLength(2);

      // The new version lands: now the tiles are the preview's own.
      manifestVersion = 'v2';
      holding = true;
      await viewer.load('pano-a');
      tick(viewer);
      expect(previewItems(viewer).map((d) => d.level)).toEqual([0.5, 0.5]);
      holding = false;
      tiles.release();
      await settle(viewer, settled, 2);
      expect(settled).toHaveBeenCalledTimes(2);
      expect(rendererOf(viewer).removeTile).toHaveBeenCalledWith(1);
      expect(rendererOf(viewer).removeTile).toHaveBeenCalledWith(2);
      expect(previewItems(viewer)).toEqual([]);
      viewer.dispose();
    });

    it('takes any manifest as its own without replacesVersion (a new pano)', async () => {
      let holding = true;
      const tiles = stubTiles((url) => holding && detailTile(url));
      manifestVersion = 'v7';
      const viewer = new PanoViewer(makeContainer(400, 800));
      const settled = vi.fn();
      viewer.on('tiles-settled', settled);
      viewer.showPreview('pano-a', source());
      await viewer.load('pano-a');
      tick(viewer);
      expect(previewItems(viewer).map((d) => d.level)).toEqual([0.5, 0.5]);
      holding = false;
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
        camera: { maxFov: 80 },
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

    it('never applies a superseded transition view, and puts up no overlay for it', async () => {
      const net = stubNet({ holdTile: (url) => /\/pano-[ab]\//.test(url) });
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container);
      await viewer.load('pano-0');
      tick(viewer);

      const a = viewer.transitionTo('pano-a', { yaw: 2 });
      await flush();
      const b = viewer.load('pano-b', { view: { yaw: -1 } });

      // A settles first, while B is still loading: the camera stays put.
      await a;
      expect(viewer.getView().yaw).toBe(0);

      net.release();
      await expect(b).resolves.toBe(true);
      expect(viewer.getView().yaw).toBe(-1);
      // A never swapped, and a plain load does not crossfade.
      expect(overlays).toHaveLength(0);
      viewer.dispose();
    });

    it('drops a transition overlay at once when a preview supersedes its fade', async () => {
      stubNet();
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container, { transition: { durationMs: 30 } });
      await viewer.load('pano-0');
      tick(viewer);

      const a = viewer.transitionTo('pano-a', { yaw: 2 });
      for (let i = 0; i < 50 && overlays[0]?.style['opacity'] !== '0'; i++) {
        await flush();
        raf.step();
      }
      expect(overlays[0]!.remove).not.toHaveBeenCalled();
      viewer.showPreview('pano-c', source());
      expect(overlays[0]!.remove).toHaveBeenCalled();
      await a;
      viewer.dispose();
    });

    it('focus() focuses its canvas without scrolling the page', () => {
      const viewer = new PanoViewer(makeContainer(400, 800));
      viewer.focus();
      expect(internals(viewer).renderer.canvas.focus).toHaveBeenCalledWith({ preventScroll: true });
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
      const idleViewer = (options: ViewerOptions = {}) =>
        new PanoViewer(makeContainer(400, 800), options);
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
            const viewer = idleViewer({ autoRotate: { enabled: true, idleMs: 1000 } });
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
        autoRotate: { enabled: true, speed: 0 },
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

    describe('zoom to the cursor', () => {
      // The scene direction under the cursor when a zoom starts must stay
      // under it, frame after frame, until the zoom settles; off the screen's
      // centre lines and with the camera pitched too, not only on the axes.
      const W = 1200;
      const H = 800;
      const TOL = 1e-6;

      /** Angle (rad) between two view directions. */
      function angleBetween(
        a: { yaw: number; pitch: number },
        b: { yaw: number; pitch: number },
      ): number {
        const u = dirFromYawPitch(a.yaw, a.pitch);
        const v = dirFromYawPitch(b.yaw, b.pitch);
        const dot = u.x * v.x + u.y * v.y + u.z * v.z;
        return Math.acos(Math.min(1, Math.max(-1, dot)));
      }

      function zoomViewer(view: View): PanoViewer {
        const viewer = new PanoViewer(makeContainer(W, H));
        const canvas = internals(viewer).renderer.canvas as unknown as {
          getBoundingClientRect: () => DOMRect;
        };
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H }) as DOMRect;
        viewer.setView(view);
        runUntilIdle();
        return viewer;
      }

      const wheelAt = (viewer: PanoViewer, x: number, y: number, deltaY: number, deltaX = 0) =>
        canvasListener(
          viewer,
          'wheel',
        )({
          deltaY,
          deltaX,
          deltaMode: 0,
          ctrlKey: false,
          metaKey: false,
          clientX: x,
          clientY: y,
          timeStamp: raf.now,
          preventDefault: vi.fn(),
        });

      /** Step frames `ms` apart until the camera settles, checking the cursor every frame. */
      function settleKeepingAnchor(
        viewer: PanoViewer,
        x: number,
        y: number,
        anchor: { yaw: number; pitch: number },
        ms: number,
      ): number {
        let worst = 0;
        let frames = 0;
        while (raf.pending > 0 && frames < 2000) {
          raf.step(raf.now + ms);
          frames++;
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(x, y), anchor));
        }
        return worst;
      }

      it.each([
        {
          name: 'zoom in, level, 16 ms frames',
          x: 1050,
          y: 120,
          pitch: 0,
          fov: 70,
          dy: -100,
          ms: 16,
        },
        {
          name: 'zoom in, pitched up, 16 ms frames',
          x: 1050,
          y: 120,
          pitch: 0.6,
          fov: 70,
          dy: -100,
          ms: 16,
        },
        {
          name: 'zoom in, pitched down, 8 ms frames',
          x: 150,
          y: 700,
          pitch: -0.5,
          fov: 70,
          dy: -100,
          ms: 8,
        },
        {
          name: 'zoom out, pitched up, 16 ms frames',
          x: 1000,
          y: 650,
          pitch: 0.4,
          fov: 20,
          dy: 100,
          ms: 16,
        },
        {
          name: 'zoom out, pitched down, 8 ms frames',
          x: 200,
          y: 100,
          pitch: -0.4,
          fov: 20,
          dy: 100,
          ms: 8,
        },
        {
          name: 'zoom in from the horizontal fov cap',
          x: 1150,
          y: 60,
          pitch: 0.3,
          fov: 80,
          dy: -100,
          ms: 16,
        },
      ])('keeps the wheel anchor under the cursor: $name', ({ x, y, pitch, fov, dy, ms }) => {
        const viewer = zoomViewer({ yaw: 0.3, pitch, fov });
        const anchor = viewer.directionAtPixel(x, y);
        let worst = 0;
        // A burst: several wheel events a frame, then frames between bursts.
        for (let burst = 0; burst < 8; burst++) {
          for (let i = 0; i < 3; i++) wheelAt(viewer, x, y, dy);
          raf.step(raf.now + ms);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(x, y), anchor));
        }
        worst = Math.max(worst, settleKeepingAnchor(viewer, x, y, anchor, ms));
        expect(internals(viewer).view.fov).not.toBeCloseTo(fov, 1);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('keeps the anchor through a scroll-zoom that jitters sideways', () => {
        const viewer = zoomViewer({ yaw: 0.3, pitch: 0.3, fov: 75 });
        const x = 980;
        const y = 180;
        const anchor = viewer.directionAtPixel(x, y);
        let worst = 0;
        // A two-finger scroll is never exactly vertical, and its momentum
        // tail keeps sending small deltaX values.
        const jitter = [0.5, -0.4, 1.2, -0.8, 3, 0.2, -2.5, 0.7];
        for (let i = 0; i < 30; i++) {
          wheelAt(viewer, x, y, -8, jitter[i % jitter.length]!);
          raf.step(raf.now + 16);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(x, y), anchor));
        }
        worst = Math.max(worst, settleKeepingAnchor(viewer, x, y, anchor, 16));
        expect(internals(viewer).view.fov).toBeLessThan(60);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('pans on a mostly sideways swipe without zooming', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0, fov: 70 });
        wheelAt(viewer, 600, 400, 4, 40);
        runUntilIdle();
        expect(internals(viewer).view.fov).toBe(70);
        expect(internals(viewer).view.yaw).toBeGreaterThan(0); // a deltaX right turns right
        viewer.dispose();
      });

      it('stops a fling glide when a zoom starts, so the anchor holds', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0.3, fov: 70 });
        internals(viewer).flick(25, 5);
        raf.step(raf.now + 16);
        const x = 1000;
        const y = 200;
        const anchor = viewer.directionAtPixel(x, y);
        for (let i = 0; i < 4; i++) wheelAt(viewer, x, y, -100);
        expect(internals(viewer).momentum).toEqual({ yaw: 0, pitch: 0 });
        expect(settleKeepingAnchor(viewer, x, y, anchor, 16)).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('anchors on the fov on screen when a wheel zoom lands mid fov glide', () => {
        const viewer = zoomViewer({ yaw: 0.2, pitch: 0.4, fov: 75 });
        viewer.setView({ fov: 30 }); // a button zoom: the fov eases toward 30
        raf.step(raf.now + 16);
        raf.step(raf.now + 16);
        const { view, target } = internals(viewer);
        expect(view.fov).not.toBeCloseTo(target.fov, 1);
        const x = 200;
        const y = 650;
        const anchor = viewer.directionAtPixel(x, y);
        wheelAt(viewer, x, y, -100);
        expect(settleKeepingAnchor(viewer, x, y, anchor, 8)).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('re-anchors on the new cursor position when the cursor moves', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0.5, fov: 75 });
        for (let i = 0; i < 4; i++) wheelAt(viewer, 1000, 150, -100);
        settleKeepingAnchor(viewer, 1000, 150, viewer.directionAtPixel(1000, 150), 16);
        const moved = viewer.directionAtPixel(250, 600);
        for (let i = 0; i < 4; i++) {
          wheelAt(viewer, 250, 600, -100);
          raf.step(raf.now + 16);
          expect(angleBetween(viewer.directionAtPixel(250, 600), moved)).toBeLessThan(TOL);
        }
        expect(settleKeepingAnchor(viewer, 250, 600, moved, 16)).toBeLessThan(TOL);
        viewer.dispose();
      });

      /** Two touch pointers on the viewer's canvas, moved one event at a time. */
      function fingers(viewer: PanoViewer, a: [number, number], b: [number, number]) {
        const pos = { 1: a, 2: b };
        const send = (type: string, id: 1 | 2) =>
          canvasListener(
            viewer,
            type,
          )({
            pointerId: id,
            pointerType: 'touch',
            button: 0,
            clientX: pos[id][0],
            clientY: pos[id][1],
            timeStamp: raf.now,
          });
        send('pointerdown', 1);
        send('pointerdown', 2);
        return {
          mid: (): [number, number] => [(pos[1][0] + pos[2][0]) / 2, (pos[1][1] + pos[2][1]) / 2],
          move(id: 1 | 2, x: number, y: number) {
            pos[id] = [x, y];
            send('pointermove', id);
          },
          lift(id: 1 | 2) {
            send('pointerup', id);
          },
          at: (id: 1 | 2) => pos[id],
        };
      }

      /**
       * A pinch whose fingers move one event at a time, unevenly, while their
       * midpoint also travels. After every event the scene direction that was
       * under the midpoint at the start must be under the midpoint now.
       */
      function pinchTracking(
        viewer: PanoViewer,
        start: [[number, number], [number, number]],
        steps: number,
        spread: number,
        travel: [number, number],
      ): number {
        const f = fingers(viewer, start[0], start[1]);
        const [mx, my] = f.mid();
        const anchor = viewer.directionAtPixel(mx, my);
        let worst = 0;
        for (let i = 0; i < steps; i++) {
          // Finger 1 moves out by more than finger 2, and each takes its turn.
          const [x1, y1] = f.at(1);
          f.move(1, x1 - spread * 1.6 + travel[0], y1 + travel[1] - spread * 0.3);
          raf.step(raf.now + 8);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(...f.mid()), anchor));
          const [x2, y2] = f.at(2);
          f.move(2, x2 + spread * 0.4 + travel[0], y2 + travel[1] + spread * 0.2);
          raf.step(raf.now + 8);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(...f.mid()), anchor));
        }
        return Math.max(worst, settleKeepingAnchor(viewer, ...f.mid(), anchor, 8));
      }

      it('keeps the pinch start direction under the moving midpoint', () => {
        const viewer = zoomViewer({ yaw: 0.2, pitch: 0.4, fov: 75 });
        const worst = pinchTracking(
          viewer,
          [
            [700, 300],
            [800, 320],
          ],
          20,
          6,
          [4, 3],
        );
        expect(internals(viewer).view.fov).toBeLessThan(40);
        expect(internals(viewer).view.fov).toBeGreaterThan(15);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('keeps tracking the midpoint once the pinch hits the fov limit', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: -0.2, fov: 40 });
        const worst = pinchTracking(
          viewer,
          [
            [500, 500],
            [560, 500],
          ],
          30,
          12,
          [-3, -4],
        );
        expect(internals(viewer).view.fov).toBe(15);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('keeps tracking the midpoint through a pinch near the zenith', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 1.2, fov: 70 });
        // The midpoint's direction is past straight up when the pinch starts.
        const worst = pinchTracking(
          viewer,
          [
            [560, 150],
            [640, 150],
          ],
          12,
          4,
          [2, 1],
        );
        expect(internals(viewer).view.fov).toBeLessThan(50);
        // Exact, and by pitching on over the top, not by turning around.
        expect(Math.abs(internals(viewer).view.yaw)).toBeLessThan(0.5);
        expect(internals(viewer).view.pitch).toBeGreaterThan(1.2);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('zooms out on a pinch in, tracking the midpoint', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0.3, fov: 30 });
        const worst = pinchTracking(
          viewer,
          [
            [300, 200],
            [700, 300],
          ],
          15,
          -6,
          [5, 2],
        );
        expect(internals(viewer).view.fov).toBeGreaterThan(40);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('hands a pinch to a drag without a jump when a finger lifts', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0.3, fov: 70 });
        const f = fingers(viewer, [700, 300], [800, 300]);
        f.move(2, 900, 310);
        f.move(1, 650, 300);
        runUntilIdle();
        const before = { ...internals(viewer).view };
        f.lift(1);
        runUntilIdle();
        expect(internals(viewer).view).toEqual(before);
        // The finger left drags by what it moves, not by where the midpoint was.
        f.move(2, 902, 310);
        runUntilIdle();
        const { view } = internals(viewer);
        expect(view.fov).toBe(before.fov);
        expect(Math.abs(view.yaw - before.yaw)).toBeGreaterThan(0);
        expect(Math.abs(view.yaw - before.yaw)).toBeLessThan(0.01);
        expect(view.pitch).toBeCloseTo(before.pitch, 12);
        viewer.dispose();
      });

      /**
       * Whether a pitch inside the limits shows the direction `dir` exactly
       * at NDC (nx, ny) at `fov` without crossing to the other side of the
       * pole from `was` (its angle above the horizon in the camera's vertical
       * plane now). Scans for a root of the height match.
       */
      function exactOnSideExists(
        dir: { pitch: number },
        nx: number,
        ny: number,
        fov: number,
        was: number,
      ): boolean {
        const limit = Math.PI / 2 - 0.001;
        const ty = Math.tan((effectiveVFovDeg(fov, 100, W / H) * Math.PI) / 360);
        const cx = nx * ty * (W / H);
        const cy = ny * ty;
        const r = Math.sqrt(cy * cy + 1) / Math.sqrt(cx * cx + cy * cy + 1);
        const up = Math.atan(cy);
        const side = (p: number) => (p + up > Math.PI / 2 ? 1 : p + up < -Math.PI / 2 ? 2 : 0);
        const want = was > Math.PI / 2 ? 1 : was < -Math.PI / 2 ? 2 : 0;
        const f = (p: number) => r * Math.sin(p + up) - Math.sin(dir.pitch);
        for (let i = 0; i < 4000; i++) {
          const a = -limit + (2 * limit * i) / 4000;
          const b = -limit + (2 * limit * (i + 1)) / 4000;
          if (f(a) * f(b) < 0 && side(a) === want && side(b) === want) return true;
        }
        return false;
      }

      /** The angle above the horizon, in the camera's vertical plane, of the point at NDC y. */
      const wasAt = (viewer: PanoViewer, ny: number) => {
        const { view } = internals(viewer);
        const ty = Math.tan((effectiveVFovDeg(view.fov, 100, W / H) * Math.PI) / 360);
        return view.pitch + Math.atan(ny * ty);
      };

      const nearPole: [number, number, number][] = [];
      for (const pitch of [1.28, 1.36, 1.48, -1.28, -1.36, -1.48]) {
        for (const x of [60, 360, 960])
          for (const y of [8, 40, 760, 792]) nearPole.push([pitch, x, y]);
      }

      it.each([
        {
          name: 'a wheel notch',
          fire: (v: PanoViewer, x: number, y: number) => wheelAt(v, x, y, -100),
        },
        {
          name: 'a capped wheel event',
          fire: (v: PanoViewer, x: number, y: number) => wheelAt(v, x, y, -300),
        },
        {
          name: 'a double-click',
          fire: (v: PanoViewer, x: number, y: number) =>
            canvasListener(v, 'dblclick')({ clientX: x, clientY: y, preventDefault: vi.fn() }),
        },
      ])('keeps the anchor exact near the poles for $name whenever it can', ({ fire }) => {
        let exact = 0;
        for (const [pitch, x, y] of nearPole) {
          const viewer = zoomViewer({ yaw: 0, pitch, fov: 78 });
          const nx = (x / W) * 2 - 1;
          const ny = -((y / H) * 2 - 1);
          const anchor = viewer.directionAtPixel(x, y);
          const was = wasAt(viewer, ny);
          fire(viewer, x, y);
          runUntilIdle();
          const { view } = internals(viewer);
          const drift = angleBetween(viewer.directionAtPixel(x, y), anchor);
          const at = `pitch ${pitch} at (${x}, ${y})`;
          if (exactOnSideExists(anchor, nx, ny, view.fov, was)) {
            exact++;
            expect(drift, at).toBeLessThan(TOL);
          } else {
            // Held at the limit: the point eases off, the camera never turns round.
            expect(Math.abs(view.pitch), at).toBeCloseTo(Math.PI / 2 - 0.001, 9);
          }
          expect(Math.abs(view.yaw), at).toBeLessThan(Math.PI / 2);
          viewer.dispose();
        }
        expect(exact).toBeGreaterThanOrEqual(nearPole.length / 2);
      });

      it('keeps a pinch exact toward the pitch limit, then eases off without a jump', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 1.3, fov: 70 });
        const f = fingers(viewer, [560, 300], [640, 300]);
        const anchor = viewer.directionAtPixel(...f.mid());
        let exactSteps = 0;
        let heldSteps = 0;
        let prev = { ...internals(viewer).view };
        // Drag the midpoint down while spreading: the camera has to pitch up
        // to keep the start direction under it, until the limit holds it.
        for (let i = 0; i < 40; i++) {
          const id = i % 2 ? 2 : 1;
          const [x, y] = f.at(id);
          const [, my] = f.mid();
          const was = wasAt(viewer, -((my / H) * 2 - 1));
          f.move(id, x + (id === 1 ? -1 : 1), y + 24);
          raf.step(raf.now + 8);
          const [mx2, my2] = f.mid();
          const { view } = internals(viewer);
          const nx = (mx2 / W) * 2 - 1;
          const ny = -((my2 / H) * 2 - 1);
          if (exactOnSideExists(anchor, nx, ny, view.fov, was)) {
            exactSteps++;
            expect(angleBetween(viewer.directionAtPixel(mx2, my2), anchor)).toBeLessThan(TOL);
          } else {
            heldSteps++;
            expect(view.pitch).toBeCloseTo(Math.PI / 2 - 0.001, 9);
          }
          // No step turns the camera round.
          expect(angleBetween(view, prev)).toBeLessThan(0.1);
          prev = { ...view };
        }
        expect(exactSteps).toBeGreaterThan(5);
        expect(heldSteps).toBeGreaterThan(5);
        viewer.dispose();
      });

      it('stops a fling glide when a Safari pinch starts', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0, fov: 70 });
        internals(viewer).flick(25, 5);
        canvasListener(
          viewer,
          'gesturestart',
        )({ scale: 1, clientX: 300, clientY: 300, preventDefault: vi.fn() });
        expect(internals(viewer).momentum).toEqual({ yaw: 0, pitch: 0 });
        viewer.dispose();
      });

      it('keeps a Safari trackpad pinch anchored where it began', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: -0.3, fov: 70 });
        const at = { x: 300, y: 650 };
        const anchor = viewer.directionAtPixel(at.x, at.y);
        const gesture = (type: string, scale: number, x: number, y: number) =>
          canvasListener(viewer, type)({ scale, clientX: x, clientY: y, preventDefault: vi.fn() });
        gesture('gesturestart', 1, at.x, at.y);
        let worst = 0;
        // Changes report a wandering point; the pinch stays where it began.
        for (let i = 1; i <= 25; i++) {
          gesture('gesturechange', 1 + i * 0.08, at.x + i * 3, at.y - i * 2);
          raf.step(raf.now + 16);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(at.x, at.y), anchor));
        }
        gesture('gestureend', 3, at.x, at.y);
        worst = Math.max(worst, settleKeepingAnchor(viewer, at.x, at.y, anchor, 16));
        expect(internals(viewer).view.fov).toBeLessThan(30);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('never pans on the sideways jitter of a decaying scroll-zoom tail', () => {
        const viewer = zoomViewer({ yaw: 0.3, pitch: 0.2, fov: 75 });
        const x = 950;
        const y = 600;
        const anchor = viewer.directionAtPixel(x, y);
        let worst = 0;
        // Momentum: deltaY decays well below the steady deltaX of 2 px.
        for (let i = 0; i < 40; i++) {
          wheelAt(viewer, x, y, -30 * 0.88 ** i, 2);
          raf.step(raf.now + 16);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(x, y), anchor));
        }
        worst = Math.max(worst, settleKeepingAnchor(viewer, x, y, anchor, 16));
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('never zooms on the vertical jitter of a sideways swipe', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0, fov: 70 });
        for (let i = 0; i < 40; i++) {
          wheelAt(viewer, 600, 400, i % 2 ? 1.5 : -1.5, 30 * 0.88 ** i);
          raf.step(raf.now + 16);
          expect(internals(viewer).view.fov).toBe(70);
        }
        expect(internals(viewer).view.yaw).toBeGreaterThan(0.1);
        viewer.dispose();
      });

      it.each([
        { name: 'zoom in past the zenith', y: 40, pitch: 1.45, dy: -100 },
        { name: 'zoom in toward the zenith', y: 120, pitch: 1.3, dy: -100 },
        { name: 'zoom out by the zenith', y: 80, pitch: 1.45, dy: 100 },
      ])('keeps pitch in its limits without jumping the cursor: $name', ({ y, pitch, dy }) => {
        const limit = Math.PI / 2 - 0.001;
        const viewer = zoomViewer({ yaw: 0, pitch, fov: dy < 0 ? 80 : 30 });
        const x = 650;
        let prev = viewer.directionAtPixel(x, y);
        for (let i = 0; i < 20; i++) {
          wheelAt(viewer, x, y, dy);
          raf.step(raf.now + 16);
          const now = viewer.directionAtPixel(x, y);
          expect(internals(viewer).view.pitch).toBeLessThanOrEqual(limit);
          // Pinned, or (once the clamp holds the camera) a small step, never a jump.
          expect(angleBetween(now, prev)).toBeLessThan(0.05);
          expect(Math.abs(internals(viewer).view.yaw)).toBeLessThan(Math.PI / 2); // no flip over the pole
          prev = now;
        }
        viewer.dispose();
      });
    });

    describe("with the tile layer's upload queue", () => {
      type Queue = { ready: Map<string, unknown> };
      const readyOf = (viewer: PanoViewer) => (internals(viewer).layer as Queue).ready;
      const uploads = (viewer: PanoViewer) =>
        (internals(viewer).renderer as unknown as { uploadTile: ReturnType<typeof vi.fn> })
          .uploadTile.mock.calls.length;

      it('never aborts the base fetches of a slow load, however many frames run', async () => {
        const net = stubNet({ holdTile: (url) => url.includes('/0/') });
        const viewer = new PanoViewer(makeContainer(400, 800), {
          autoRotate: { enabled: true, speed: 1 },
        });
        const loading = viewer.load('pano-a', { view: { yaw: 2 } });
        await flush();
        // The prime has run update() with the base in flight; now well past
        // the abort grace, turning all the while.
        for (let i = 0; i < 15; i++) raf.step();
        const baseSignals = FACES.map((f) => net.signalOf(`/tiles/pano-a/0/${f}/0-0.jpg`));
        for (const signal of baseSignals) {
          expect(signal).toBeDefined();
          expect(signal!.aborted).toBe(false);
        }
        net.release();
        await expect(loading).resolves.toBe(true);
        viewer.dispose();
      });

      it('asks for another frame while decoded tiles are still queued', async () => {
        let holding = true;
        const net = stubNet({ holdTile: (url) => holding && !url.includes('/0/') });
        const viewer = new PanoViewer(makeContainer(400, 800));
        await viewer.load('pano-a');
        runUntilIdle();
        const base = uploads(viewer);
        holding = false;
        net.release();
        await flush();
        const decoded = readyOf(viewer).size;
        expect(decoded).toBeGreaterThan(3); // more than one frame uploads
        expect(raf.pending).toBe(1);

        raf.step();
        // Some went up; the rest wait, and the frame asked for the next one.
        expect(uploads(viewer)).toBeGreaterThan(base);
        expect(readyOf(viewer).size).toBeGreaterThan(0);
        expect(raf.pending).toBe(1);

        runUntilIdle();
        expect(readyOf(viewer).size).toBe(0);
        expect(uploads(viewer)).toBeGreaterThanOrEqual(base + decoded);
        expect(raf.pending).toBe(0);
        viewer.dispose();
      });

      it('keeps drawing frames until a queue of unwanted tiles is dropped', async () => {
        // Level 2 only: level-1 tiles are the parents, wanted from any angle.
        const net = stubNet({ holdTile: (url) => url.includes('/2/') });
        const viewer = new PanoViewer(makeContainer(400, 800), { camera: { damping: 1 } });
        await viewer.load('pano-a');
        runUntilIdle();
        const base = uploads(viewer);
        net.release(); // decode into the queue, without a frame yet
        await flush();
        expect(readyOf(viewer).size).toBeGreaterThan(0);

        // Turn away before any of them goes up: none is wanted any more.
        viewer.setView({ yaw: Math.PI });
        const frames = runUntilIdle();
        expect(frames).toBeGreaterThan(1);
        expect(frames).toBeLessThan(100);
        expect(readyOf(viewer).size).toBe(0);
        expect(uploads(viewer)).toBe(base);
        expect(raf.pending).toBe(0);
        viewer.dispose();
      });
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

    it('resolves true and still emits scene-change when a ready listener throws', async () => {
      stubNet();
      const reportError = vi.fn();
      vi.stubGlobal('reportError', reportError);
      const viewer = new PanoViewer(makeContainer(400, 800));
      const boom = new Error('boom');
      const sceneChange = vi.fn();
      viewer.on('ready', () => {
        throw boom;
      });
      viewer.on('scene-change', sceneChange);
      await expect(viewer.load('pano-a')).resolves.toBe(true);
      expect(sceneChange).toHaveBeenCalledExactlyOnceWith('pano-a');
      expect(reportError).toHaveBeenCalledExactlyOnceWith(boom);
      viewer.dispose();
    });

    it('does not announce a scene change for a load a ready listener superseded', async () => {
      stubNet({ holdTile: (url) => url.includes('/pano-b/') });
      const viewer = new PanoViewer(makeContainer(400, 800));
      const sceneChange = vi.fn();
      viewer.on('scene-change', sceneChange);
      let b: Promise<boolean> | undefined;
      viewer.on('ready', (m) => {
        if (m.id === 'pano-a') b = viewer.load('pano-b');
      });
      await expect(viewer.load('pano-a')).resolves.toBe(true);
      expect(b).toBeDefined();
      expect(sceneChange).not.toHaveBeenCalled();
      viewer.dispose();
      await expect(b).resolves.toBe(false);
    });

    it('keeps the old scene live and uncovered while a transition loads, and snapshots it at the swap', async () => {
      const net = stubNet({ holdTile: (url) => url.includes('/pano-a/') });
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container, { transition: { durationMs: 0 } });
      await viewer.load('pano-0');
      runUntilIdle();
      const fake = internals(viewer).renderer as unknown as {
        render: ReturnType<typeof vi.fn>;
        snapshot: ReturnType<typeof vi.fn>;
      };

      const done = viewer.transitionTo('pano-a');
      await flush();
      // Nothing covers the old scene while the new one loads.
      expect(overlays).toHaveLength(0);
      expect(container.appendChild).not.toHaveBeenCalled();

      // A drag still moves what the visitor sees.
      const yaw0 = internals(viewer).view.yaw;
      fake.render.mockClear();
      internals(viewer).panByPixels(300, 0);
      raf.step();
      expect(internals(viewer).view.yaw).not.toBeCloseTo(yaw0, 3);
      expect(fake.render).toHaveBeenCalledTimes(1);
      const drawn = fake.render.mock.calls[0]![0] as unknown[];
      expect(drawn.length).toBeGreaterThan(0);
      expect(fake.snapshot).not.toHaveBeenCalled();

      // The snapshot goes up at the swap, of the old scene where it was left.
      net.release();
      await finish(done);
      expect(fake.snapshot).toHaveBeenCalledTimes(1);
      expect(fake.snapshot.mock.calls[0]![0]).toHaveLength(drawn.length);
      expect(overlays).toHaveLength(1);
      expect(overlays[0]!.remove).toHaveBeenCalled();
      expect((internals(viewer).layer as { source: CubeTileSource }).source.id).toBe('pano-a');
      viewer.dispose();
    });

    it('does not fade a snapshot that a ready listener has already dropped', async () => {
      const net = stubNet({ holdTile: (url) => url.includes('/pano-b/') });
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container, { transition: { durationMs: 0 } });
      await viewer.load('pano-0');
      runUntilIdle();
      // Moving on as soon as A is ready supersedes the transition's fade.
      viewer.on('ready', (src) => {
        if (src.id === 'pano-a') void viewer.load('pano-b');
      });
      let done = false;
      const t = viewer.transitionTo('pano-a').then(() => (done = true));
      for (let i = 0; i < 10 && !done; i++) await flush();
      // Settled with no frame drawn: nothing waited on a fade.
      expect(done).toBe(true);
      await t;
      expect(overlays).toHaveLength(1);
      expect(overlays[0]!.remove).toHaveBeenCalled();
      expect(overlays[0]!.style['opacity']).toBeUndefined();
      net.release();
      viewer.dispose();
    });

    it('puts up no snapshot when a context restore finishes a transition that has given up', async () => {
      const net = stubNet({ holdTile: (url) => url.includes('/pano-a/') });
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container, { transition: { durationMs: 0 } });
      await viewer.load('pano-0');
      runUntilIdle();
      const fake = internals(viewer).renderer as unknown as {
        loseContext(): void;
        restoreContext(): void;
      };
      const done = viewer.transitionTo('pano-a');
      await flush();
      fake.loseContext();
      await done;
      fake.restoreContext();
      net.release();
      for (let i = 0; i < 20; i++) {
        await flush();
        raf.step();
      }
      expect((internals(viewer).layer as { source: CubeTileSource }).source.id).toBe('pano-a');
      expect(overlays).toHaveLength(0);
      viewer.dispose();
    });

    describe('cancelLoad', () => {
      const layerId = (viewer: PanoViewer) =>
        (internals(viewer).layer as { source: CubeTileSource } | undefined)?.source.id;

      it('resolves a load waiting on its base to false and keeps the scene on screen', async () => {
        const net = stubNet({ holdTile: (url) => url.includes('/pano-b/') });
        const viewer = new PanoViewer(makeContainer(400, 800));
        await viewer.load('pano-a');
        runUntilIdle();
        const sceneChange = vi.fn();
        viewer.on('scene-change', sceneChange);
        const b = viewer.load('pano-b', { view: { yaw: 1 } });
        await flush();
        viewer.cancelLoad();
        await expect(b).resolves.toBe(false);
        expect(net.signalOf('/tiles/pano-b/0/pz/0-0.jpg')?.aborted).toBe(true);
        net.release();
        await flush();
        expect(layerId(viewer)).toBe('pano-a');
        expect(viewer.getView().yaw).toBe(0);
        expect(sceneChange).not.toHaveBeenCalled();
        expect(internals(viewer).pendingLayers.size).toBe(0);
        viewer.dispose();
      });

      it('aborts a source resolve in flight', async () => {
        const net = stubNet({ holdManifest: (url) => url.includes('/pano-b/') });
        const viewer = new PanoViewer(makeContainer(400, 800));
        await viewer.load('pano-a');
        const b = viewer.load('pano-b');
        await flush();
        viewer.cancelLoad();
        expect(net.signalOf('/tiles/pano-b/manifest.json')?.aborted).toBe(true);
        await expect(b).resolves.toBe(false);
        expect(layerId(viewer)).toBe('pano-a');
        viewer.dispose();
      });

      it('cancels a transition before its swap: no snapshot, no view change', async () => {
        const net = stubNet({ holdTile: (url) => url.includes('/pano-b/') });
        const { container, overlays } = stubOverlayDom();
        const viewer = new PanoViewer(container, { transition: { durationMs: 0 } });
        await viewer.load('pano-a');
        runUntilIdle();
        const t = viewer.transitionTo('pano-b', { yaw: 2 });
        await flush();
        viewer.cancelLoad();
        await t;
        net.release();
        await flush();
        expect(layerId(viewer)).toBe('pano-a');
        expect(viewer.getView().yaw).toBe(0);
        expect(overlays).toHaveLength(0);
        viewer.dispose();
      });

      it('drops a load a context loss is holding, so the restore brings back the old scene', async () => {
        const net = stubNet({ holdTile: (url) => url.includes('/pano-b/') });
        const viewer = new PanoViewer(makeContainer(400, 800));
        await viewer.load('pano-a');
        const fake = internals(viewer).renderer as unknown as {
          loseContext(): void;
          restoreContext(): void;
        };
        const b = viewer.load('pano-b');
        await flush();
        fake.loseContext();
        await expect(b).resolves.toBe(false);
        viewer.cancelLoad();
        fake.restoreContext();
        net.release();
        for (let i = 0; i < 10; i++) await flush();
        expect(layerId(viewer)).toBe('pano-a');
        viewer.dispose();
      });

      it("leaves a context restore's reload of the scene on screen alone", async () => {
        let hold = false;
        const net = stubNet({ holdTile: (url) => hold && url.includes('/pano-a/') });
        const viewer = new PanoViewer(makeContainer(400, 800));
        await viewer.load('pano-a');
        const fake = internals(viewer).renderer as unknown as {
          loseContext(): void;
          restoreContext(): void;
        };
        fake.loseContext();
        hold = true;
        fake.restoreContext();
        await flush();
        const baseFetches = () =>
          vi.mocked(fetch).mock.calls.filter(([url]) => url === '/tiles/pano-a/0/pz/0-0.jpg')
            .length;
        const before = baseFetches();
        viewer.cancelLoad();
        // Not cancelled and fetched again: left to finish.
        expect(net.signalOf('/tiles/pano-a/0/pz/0-0.jpg')?.aborted).toBe(false);
        net.release();
        for (let i = 0; i < 10; i++) await flush();
        expect(baseFetches()).toBe(before);
        expect(layerId(viewer)).toBe('pano-a');
        viewer.dispose();
      });

      it('brings the scene back when it cancels the load a restore was finishing', async () => {
        const net = stubNet({ holdTile: (url) => url.includes('/pano-b/') });
        const viewer = new PanoViewer(makeContainer(400, 800));
        await viewer.load('pano-a');
        const fake = internals(viewer).renderer as unknown as {
          loseContext(): void;
          restoreContext(): void;
        };
        const b = viewer.load('pano-b');
        await flush();
        fake.loseContext();
        await expect(b).resolves.toBe(false);
        // The restore loads B again; cancelling it must not leave the stage blank.
        fake.restoreContext();
        await flush();
        viewer.cancelLoad();
        net.release();
        for (let i = 0; i < 10; i++) await flush();
        expect(layerId(viewer)).toBe('pano-a');
        viewer.dispose();
      });

      it('changes nothing with no load in flight, and after dispose', async () => {
        stubNet();
        const viewer = new PanoViewer(makeContainer(400, 800));
        await viewer.load('pano-a');
        viewer.cancelLoad();
        expect(layerId(viewer)).toBe('pano-a');
        // A later load still works.
        await expect(viewer.load('pano-b')).resolves.toBe(true);
        viewer.dispose();
        expect(() => viewer.cancelLoad()).not.toThrow();
      });
    });

    it('does nothing when transitionTo is called after dispose', async () => {
      stubNet();
      const viewer = new PanoViewer(makeContainer(400, 800));
      viewer.dispose();
      await expect(viewer.transitionTo('pano-a', { yaw: 1 })).resolves.toBeUndefined();
      expect(window.matchMedia).not.toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('hands over to a newer transitionTo: the older one applies nothing and loses its overlay', async () => {
      const net = stubNet({ holdTile: (url) => /\/pano-[ab]\//.test(url) });
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container, { transition: { durationMs: 0 } });
      await viewer.load('pano-0');
      tick(viewer);

      const a = viewer.transitionTo('pano-a', { yaw: 2 });
      await flush();
      const b = viewer.transitionTo('pano-b', { yaw: -1 });
      await a;
      expect(viewer.getView().yaw).toBe(0);
      expect(overlays).toHaveLength(0);

      net.release();
      await finish(b);
      expect(viewer.getView().yaw).toBe(-1);
      // One snapshot, B's, at its swap.
      expect(overlays).toHaveLength(1);
      expect(overlays[0]!.style['opacity']).toBe('0');
      expect(overlays[0]!.remove).toHaveBeenCalled();
      viewer.dispose();
    });

    it('drops the overlay at once when disposed during the fade', async () => {
      stubNet();
      const { container, overlays } = stubOverlayDom();
      const viewer = new PanoViewer(container, { transition: { durationMs: 30 } });
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
      const viewer = new PanoViewer(container, { transition: { durationMs: 0 } });
      await viewer.load('pano-0');
      tick(viewer);
      const sceneChange = vi.fn();
      viewer.on('scene-change', sceneChange);

      const a = viewer.transitionTo('pano-a', { yaw: 1 });
      await flush();
      const b = viewer.transitionTo('pano-b', { yaw: 2 });
      await flush();
      const c = viewer.transitionTo('pano-c', { yaw: -1 });
      await Promise.all([a, b]);
      expect(viewer.getView().yaw).toBe(0);
      expect(overlays).toHaveLength(0);

      net.release();
      await finish(c);
      expect(viewer.getView().yaw).toBe(-1);
      expect(sceneChange.mock.calls).toEqual([['pano-c']]);
      expect(overlays).toHaveLength(1);
      expect(overlays[0]!.remove).toHaveBeenCalled();
      const layer = internals(viewer).layer as { source: CubeTileSource };
      expect(layer.source.id).toBe('pano-c');
      viewer.dispose();
    });

    describe('canvas lifecycle', () => {
      type Fake = {
        opts: { maxPixels?: number };
        loseContext(): void;
        restoreContext(): void;
        uploadTile: ReturnType<typeof vi.fn>;
        removeTile: ReturnType<typeof vi.fn>;
        render: ReturnType<typeof vi.fn>;
        resize: ReturnType<typeof vi.fn>;
        snapshot: ReturnType<typeof vi.fn>;
        canvas: { width: number; height: number };
      };
      const fakeOf = (viewer: PanoViewer) => internals(viewer).renderer as unknown as Fake;
      const manifestFetches = () =>
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('manifest.json')).length;
      const layerPano = (viewer: PanoViewer) =>
        (internals(viewer).layer as { source: CubeTileSource } | undefined)?.source.id;

      describe('context loss', () => {
        it('draws a restored scene from its base until its finer tiles are back', async () => {
          let holdFine = false;
          const net = stubNet({ holdTile: (url) => holdFine && !url.includes('/0/') });
          const viewer = new PanoViewer(makeContainer(400, 800));
          await viewer.load('pano-a');
          for (let i = 0; i < 10; i++) {
            runUntilIdle();
            await flush();
          }
          const fake = fakeOf(viewer);
          const lastList = () =>
            fake.render.mock.calls.at(-1)![0] as { handle: number; level: number }[];
          const levelsOf = (list: { level: number }[]) => list.map((d) => d.level).sort();
          const before = lastList();
          expect(before.filter((d) => d.level === 2).length).toBeGreaterThan(0);
          const lastHandle = Math.max(...before.map((d) => d.handle));

          fake.loseContext();
          holdFine = true;
          fake.restoreContext();
          for (let i = 0; i < 10; i++) {
            await flush();
            runUntilIdle();
          }
          // Only the new layer's base: nothing from before the loss, and
          // nothing hidden behind finer tiles that are not there yet.
          const restored = lastList();
          expect(levelsOf(restored)).toEqual(FACES.map(() => 0));
          for (const d of restored) expect(d.handle).toBeGreaterThan(lastHandle);

          net.release();
          for (let i = 0; i < 10; i++) {
            await flush();
            runUntilIdle();
          }
          expect(levelsOf(lastList())).toEqual(levelsOf(before));
          viewer.dispose();
        });

        it('stops drawing while lost, then loads the scene again from its held manifest', async () => {
          stubNet();
          const viewer = new PanoViewer(makeContainer(400, 800));
          await viewer.load('pano-a');
          runUntilIdle();
          viewer.setView({ yaw: 1, pitch: 0.2, fov: 50 });
          runUntilIdle();
          const view = viewer.getView();
          const events: string[] = [];
          for (const type of [
            'context-lost',
            'context-restored',
            'ready',
            'scene-change',
          ] as const) {
            viewer.on(type, () => events.push(type));
          }
          const fake = fakeOf(viewer);
          const before = internals(viewer).layer;

          fake.loseContext();
          expect(events).toEqual(['context-lost']);
          fake.render.mockClear();
          viewer.setView({ yaw: 2 });
          raf.step();
          expect(fake.render).not.toHaveBeenCalled();
          expect(raf.pending).toBe(0);

          const fetches = manifestFetches();
          const uploads = fake.uploadTile.mock.calls.length;
          viewer.setView(view);
          fake.restoreContext();
          await flush();
          expect(events).toEqual(['context-lost', 'context-restored']);
          // The same scene, a new layer, its base uploaded again, no manifest fetch.
          expect(manifestFetches()).toBe(fetches);
          expect(internals(viewer).layer).not.toBe(before);
          expect(layerPano(viewer)).toBe('pano-a');
          expect(fake.uploadTile.mock.calls.length).toBeGreaterThanOrEqual(uploads + FACES.length);
          runUntilIdle();
          expect(fake.render).toHaveBeenCalled();
          expect(viewer.getView()).toEqual(view);
          viewer.dispose();
        });

        it('cancels a load in flight when the context is lost, and finishes it on restore', async () => {
          const net = stubNet({ holdTile: (url) => url.includes('/pano-b/') });
          const viewer = new PanoViewer(makeContainer(400, 800));
          await viewer.load('pano-a');
          const sceneChange = vi.fn();
          viewer.on('scene-change', sceneChange);
          const loading = viewer.load('pano-b', { view: { yaw: 1.5 } });
          await flush();
          fakeOf(viewer).loseContext();
          await expect(loading).resolves.toBe(false);
          const fetches = manifestFetches();

          fakeOf(viewer).restoreContext();
          net.release();
          for (let i = 0; i < 5; i++) await flush();
          expect(manifestFetches()).toBe(fetches);
          expect(layerPano(viewer)).toBe('pano-b');
          expect(viewer.getView().yaw).toBeCloseTo(1.5, 10);
          expect(sceneChange.mock.calls).toEqual([['pano-b']]);
          viewer.dispose();
        });

        it('emits load-error when the reload after a restore fails', async () => {
          stubNet();
          const viewer = new PanoViewer(makeContainer(400, 800));
          await viewer.load('pano-a');
          const loadError = vi.fn();
          viewer.on('load-error', loadError);
          const fake = fakeOf(viewer);
          fake.loseContext();
          // The base tiles are gone from the origin by the time it comes back.
          const notFound = { ok: false, status: 404, blob: () => Promise.resolve({}) };
          vi.mocked(fetch).mockImplementation(() => Promise.resolve(notFound as Response));
          fake.restoreContext();
          for (let i = 0; i < 5; i++) await flush();
          expect(loadError).toHaveBeenCalledTimes(1);
          const { error, id } = loadError.mock.calls[0]![0] as { error: Error; id: string };
          expect(id).toBe('pano-a');
          expect(error.name).toBe('BaseTileLoadError');
          viewer.dispose();
        });

        it('reports a load-error listener that throws instead of rejecting', async () => {
          // Without the catch, vitest fails the run on the unhandled rejection.
          stubNet();
          const report = vi.fn();
          vi.stubGlobal('reportError', report);
          const viewer = new PanoViewer(makeContainer(400, 800));
          await viewer.load('pano-a');
          const boom = new Error('listener');
          viewer.on('load-error', () => {
            throw boom;
          });
          const fake = fakeOf(viewer);
          fake.loseContext();
          const notFound = { ok: false, status: 404, blob: () => Promise.resolve({}) };
          vi.mocked(fetch).mockImplementation(() => Promise.resolve(notFound as Response));
          fake.restoreContext();
          for (let i = 0; i < 5; i++) await flush();
          expect(report).toHaveBeenCalledWith(boom);
          viewer.dispose();
        });

        it('drops the preview, whose pixels are gone with the context', () => {
          const viewer = new PanoViewer(makeContainer(400, 800));
          const image = () =>
            ({ width: 1026, height: 1024, close: vi.fn() }) as unknown as ImageBitmap;
          viewer.showPreview('pano-c', {
            width: 2048,
            height: 1024,
            patches: [
              { x: 0, y: 0, w: 1026, h: 1024, image: image() },
              { x: 1022, y: 0, w: 1026, h: 1024, image: image() },
            ],
          });
          const fake = fakeOf(viewer);
          fake.loseContext();
          expect(fake.removeTile).toHaveBeenCalledTimes(2);
          fake.restoreContext();
          raf.step();
          expect(fake.render.mock.calls.at(-1)![0]).toEqual([]);
          viewer.dispose();
        });
      });

      describe('isSettled', () => {
        it('is true from the frame that settles the tiles until the next change', async () => {
          const net = stubNet({ holdTile: (url) => !url.includes('/0/') });
          const viewer = new PanoViewer(makeContainer(400, 800));
          const settled = vi.fn(() => viewer.isSettled());
          viewer.on('tiles-settled', settled);
          await viewer.load('pano-a');
          expect(viewer.isSettled()).toBe(false); // nothing drawn for it yet
          runUntilIdle();
          expect(viewer.isSettled()).toBe(false); // tiles still to come
          net.release();
          await flush();
          runUntilIdle();
          expect(settled).toHaveReturnedWith(true);
          expect(viewer.isSettled()).toBe(true);
          viewer.dispose();
        });

        it('is false until the frame that emits tiles-settled has run', () => {
          const viewer = new PanoViewer(makeContainer(400, 800));
          runUntilIdle();
          internals(viewer).layer = {
            update: vi.fn(),
            drawList: () => [],
            hasPending: () => false,
          };
          // As a load leaves it: tiles were pending at the swap.
          internals(viewer).wasPending = true;
          const settled = vi.fn(() => viewer.isSettled());
          viewer.on('tiles-settled', settled);
          expect(viewer.isSettled()).toBe(false);
          tick(viewer);
          expect(settled).toHaveReturnedWith(true);
          expect(viewer.isSettled()).toBe(true);
        });

        it('follows the tiles alone, settled while auto-rotate turns', () => {
          const viewer = new PanoViewer(makeContainer(400, 800), {
            autoRotate: { enabled: true, speed: 1 },
          });
          let pending = true;
          internals(viewer).layer = {
            update: vi.fn(),
            drawList: () => [],
            hasPending: () => pending,
          };
          internals(viewer).wasPending = true;
          const settled = vi.fn(() => viewer.isSettled());
          viewer.on('tiles-settled', settled);
          raf.step();
          raf.step();
          expect(viewer.isSettled()).toBe(false);
          pending = false;
          raf.step();
          // The camera is still turning, and the tiles are settled all the same.
          expect(raf.pending).toBe(1);
          expect(settled).toHaveReturnedWith(true);
          expect(viewer.isSettled()).toBe(true);
          pending = true; // the turn brings new tiles into view
          expect(viewer.isSettled()).toBe(false);
        });
      });

      describe('resizing', () => {
        it('draws a new size in the same call, with no frame of cleared canvas', () => {
          vi.stubGlobal('ResizeObserver', FakeResizeObserver);
          const viewer = new PanoViewer(makeContainer(400, 800));
          runUntilIdle();
          const fake = fakeOf(viewer);
          fake.render.mockClear();
          FakeResizeObserver.instances[0]!.trigger(500, 300);
          expect(fake.render).toHaveBeenCalledTimes(1);
          expect(fake.canvas.width).toBe(1000);
          expect(raf.pending).toBe(0);
          expect(viewer.project(0, 0).x).toBe(250);
          viewer.dispose();
        });

        it('does nothing when the size reported has not changed', () => {
          vi.stubGlobal('ResizeObserver', FakeResizeObserver);
          const viewer = new PanoViewer(makeContainer(400, 800));
          runUntilIdle();
          const fake = fakeOf(viewer);
          fake.render.mockClear();
          FakeResizeObserver.instances[0]!.trigger(400, 800);
          expect(fake.render).not.toHaveBeenCalled();
          expect(raf.pending).toBe(0);
          viewer.dispose();
        });

        it('draws a window resize in the same call too (no ResizeObserver)', () => {
          const container = makeContainer(400, 800);
          const viewer = new PanoViewer(container);
          runUntilIdle();
          const onResize = vi
            .mocked(window.addEventListener)
            .mock.calls.find((c) => c[0] === 'resize')![1] as () => void;
          const fake = fakeOf(viewer);
          fake.render.mockClear();
          (container as { clientWidth: number }).clientWidth = 600;
          onResize();
          expect(fake.render).toHaveBeenCalledTimes(1);
          viewer.dispose();
        });

        it('keeps going from a resize mid-motion without stepping the camera', () => {
          vi.stubGlobal('ResizeObserver', FakeResizeObserver);
          const viewer = new PanoViewer(makeContainer(400, 800));
          runUntilIdle();
          viewer.setView({ yaw: 1 });
          raf.step();
          const yaw = internals(viewer).view.yaw;
          FakeResizeObserver.instances[0]!.trigger(500, 300);
          expect(internals(viewer).view.yaw).toBe(yaw);
          expect(raf.pending).toBe(1);
          viewer.dispose();
        });

        it('follows the device pixel ratio through a re-armed matchMedia query', () => {
          type Query = {
            media: string;
            listeners: Set<() => void>;
            addEventListener: (t: string, fn: () => void) => void;
            removeEventListener: (t: string, fn: () => void) => void;
          };
          const queries: Query[] = [];
          const win = {
            devicePixelRatio: 2,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            matchMedia: vi.fn((media: string) => {
              const q: Query = {
                media,
                listeners: new Set(),
                addEventListener: (_t, fn) => q.listeners.add(fn),
                removeEventListener: (_t, fn) => q.listeners.delete(fn),
              };
              queries.push(q);
              return q;
            }),
          };
          vi.stubGlobal('window', win);
          const viewer = new PanoViewer(makeContainer(400, 800));
          runUntilIdle();
          const fake = fakeOf(viewer);
          const first = queries.find((q) => q.media.startsWith('(resolution'))!;
          expect(first.media).toBe('(resolution: 2dppx)');
          expect(first.listeners.size).toBe(1);

          // Dragged to a DPR-1 display: same CSS size, half the backbuffer.
          win.devicePixelRatio = 1;
          fake.render.mockClear();
          for (const fn of [...first.listeners]) fn();
          expect(fake.canvas.height).toBe(800);
          expect(fake.render).toHaveBeenCalledTimes(1);
          expect(first.listeners.size).toBe(0);
          const second = queries.at(-1)!;
          expect(second.media).toBe('(resolution: 1dppx)');
          expect(second.listeners.size).toBe(1);

          viewer.dispose();
          expect(second.listeners.size).toBe(0);
        });

        it('passes maxPixels to the renderer, 8.3 Mpx unless set', () => {
          expect(fakeOf(new PanoViewer(makeContainer(400, 800))).opts.maxPixels).toBe(8_300_000);
          const viewer = new PanoViewer(makeContainer(400, 800), { rendering: { maxPixels: 1e6 } });
          expect(fakeOf(viewer).opts.maxPixels).toBe(1e6);
        });
      });

      it('pauses the tile requests while off screen', async () => {
        vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
        stubNet();
        const viewer = new PanoViewer(makeContainer(400, 800));
        await viewer.load('pano-a');
        const layer = internals(viewer).layer as { paused: boolean };
        FakeIntersectionObserver.instances[0]!.trigger(false);
        expect(layer.paused).toBe(true);
        FakeIntersectionObserver.instances[0]!.trigger(true);
        expect(layer.paused).toBe(false);
        viewer.dispose();
      });

      it('fades a GPU copy of the frame, not an encoded image', async () => {
        stubNet();
        const { container, overlays } = stubOverlayDom();
        const viewer = new PanoViewer(container, { transition: { durationMs: 0 } });
        await viewer.load('pano-0');
        tick(viewer);
        const fake = fakeOf(viewer);
        await finish(viewer.transitionTo('pano-a'));
        expect(fake.snapshot).toHaveBeenCalledTimes(1);
        const overlay = overlays[0]!;
        expect(fake.snapshot.mock.results[0]!.value).toBe(overlay);
        expect(container.appendChild).toHaveBeenCalledWith(overlay);
        expect(overlay.style['cssText']).toContain('width:100%');
        expect(overlay.remove).toHaveBeenCalled();
        // Its backing store is released at once, not left for GC.
        expect([
          (overlay as { width?: number }).width,
          (overlay as { height?: number }).height,
        ]).toEqual([0, 0]);
        viewer.dispose();
      });
    });

    describe('options', () => {
      type Canvas = {
        attributes: Record<string, string>;
        addEventListener: ReturnType<typeof vi.fn>;
      };
      const canvasOf = (viewer: PanoViewer) =>
        internals(viewer).renderer.canvas as unknown as Canvas;
      const rendererOpts = (viewer: PanoViewer) =>
        (internals(viewer).renderer as unknown as { opts: Record<string, unknown> }).opts;

      it('names the canvas as an application through attributes, and renames it', () => {
        const viewer = new PanoViewer(makeContainer(400, 800));
        expect(canvasOf(viewer).attributes).toEqual({
          role: 'application',
          'aria-label': 'Panorama viewer',
        });
        viewer.setLabel('Town hall');
        expect(canvasOf(viewer).attributes['aria-label']).toBe('Town hall');
        viewer.dispose();

        const named = new PanoViewer(makeContainer(400, 800), {
          interaction: { label: 'Old town: Square' },
        });
        expect(canvasOf(named).attributes['aria-label']).toBe('Old town: Square');
        named.dispose();
      });

      it('leaves the canvas unnamed with interaction.a11y off', () => {
        const viewer = new PanoViewer(makeContainer(400, 800), { interaction: { a11y: false } });
        viewer.setLabel('Town hall');
        expect(canvasOf(viewer).attributes).toEqual({});
        viewer.dispose();
      });

      it('takes no input with interaction.enabled off, and is an image to assistive tech', () => {
        const viewer = new PanoViewer(makeContainer(400, 800), { interaction: { enabled: false } });
        expect(internals(viewer).controls).toBeUndefined();
        expect(canvasOf(viewer).addEventListener).not.toHaveBeenCalledWith(
          'pointerdown',
          expect.any(Function),
        );
        expect(canvasOf(viewer).attributes['role']).toBe('img');
        viewer.dispose();
      });

      it('hands the interaction options to its controls', () => {
        const viewer = new PanoViewer(makeContainer(400, 800), { interaction: { wheel: 'off' } });
        expect(() => canvasListener(viewer, 'wheel')).toThrow('no wheel listener');
        viewer.dispose();
      });

      it('starts at camera.defaultFov, and keeps pitch inside camera.minPitch/maxPitch', () => {
        const viewer = new PanoViewer(makeContainer(400, 800), {
          camera: { defaultFov: 50, minPitch: -0.5, maxPitch: 0.25 },
        });
        expect(viewer.getView().fov).toBe(50);
        viewer.setView({ pitch: 1 });
        expect(viewer.getView().pitch).toBe(0.25);
        viewer.setView({ pitch: -1 });
        expect(viewer.getView().pitch).toBe(-0.5);
        viewer.dispose();
      });

      it('hands the rendering options to the renderer', () => {
        const viewer = new PanoViewer(makeContainer(400, 800), {
          rendering: { anisotropy: 4, background: [0.05, 0.05, 0.04], antialias: true },
        });
        expect(rendererOpts(viewer)).toMatchObject({
          anisotropy: 4,
          background: [0.05, 0.05, 0.04],
          antialias: true,
          maxPixelRatio: 2,
          maxPixels: 8_300_000,
        });
        viewer.dispose();
      });

      it('builds its layers with rendering.lodBias on top of the tolerance', async () => {
        stubNet();
        const viewer = new PanoViewer(makeContainer(400, 800), { rendering: { lodBias: 0.5 } });
        await viewer.load('pano-a');
        const layer = internals(viewer).layer as { lodTolerance: number };
        expect(layer.lodTolerance).toBeCloseTo(0.7, 10);
        viewer.dispose();
      });

      it('crossfades for a reduced-motion visitor with transition.respectReducedMotion off', async () => {
        stubNet();
        const { container } = stubOverlayDom();
        const viewer = new PanoViewer(container, {
          transition: { durationMs: 0, respectReducedMotion: false },
        });
        await viewer.load('pano-0');
        tick(viewer);
        await finish(viewer.transitionTo('pano-a'));
        expect(window.matchMedia).not.toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
        viewer.dispose();
      });
    });
  });
});
