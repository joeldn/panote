import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PanoViewer } from './PanoViewer.js';

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
    canvas: { width: number; height: number } = { width: 0, height: 0 };
    dispose = vi.fn();
    resize(w: number, h: number): void {
      this.canvas.width = Math.round(w * 2);
      this.canvas.height = Math.round(h * 2);
    }
    setCamera(): void {}
    render(): void {}
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('device-pixel-ratio-aware level selection', () => {
    it('passes the renderer canvas device-pixel height to the tile layer, not the CSS clientHeight', () => {
      // Regression test for the DPR quality bug: selectLevel() (see
      // packages/core/src/lod.ts, used from tile-layer.ts's update()) needs
      // the framebuffer's device-pixel height. Before the fix, PanoViewer
      // passed container.clientHeight (CSS pixels) straight through, so on
      // any DPR>1 display the pyramid picked one level coarser than the
      // screen could actually show. FakeGLRenderer.resize() scales by 2x, so
      // clientHeight=800 (CSS) means canvas.height=1600 (device pixels) —
      // the update() call must receive 1600, not 800.
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
});
