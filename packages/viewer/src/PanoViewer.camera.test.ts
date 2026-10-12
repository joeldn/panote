import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { effectiveVFovDeg } from './render/projection.js';
import type { ViewerOptions } from './types.js';
import type { ControlHost } from './controls.js';
import { FakeResizeObserver } from './test-support/fake-dom.js';
import {
  useViewerGlobals,
  raf,
  TestViewer,
  internals,
  tick,
  runUntilIdle,
  canvasListener,
  makeContainer,
  stubNet,
  previewSource,
} from './test-support/viewer-harness.js';

vi.mock('./render/gl-renderer.js', () => import('./test-support/fake-gl-renderer.js'));

describe('PanoViewer', () => {
  useViewerGlobals();

  describe('fov limit at wide aspects', () => {
    // The drawn vertical fov is capped by camera.maxHorizontalFov (100°), so
    // on a wide viewport it tops out below camera.maxFov (80°). The requested
    // fov stays what was asked for, whatever the aspect; user zoom steps are
    // taken from the fov drawn, so none of them is lost above the cap.
    const MAX_H = 100;
    const cap = (w: number, h: number) => effectiveVFovDeg(80, MAX_H, w / h);

    function sizedViewer(w: number, h: number, options: ViewerOptions = {}): TestViewer {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const viewer = new TestViewer(makeContainer(w, h), options);
      const canvas = internals(viewer).renderer.canvas as unknown as {
        getBoundingClientRect: () => DOMRect;
      };
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h }) as DOMRect;
      runUntilIdle();
      return viewer;
    }

    const resize = (w: number, h: number) => FakeResizeObserver.instances[0]!.trigger(w, h);

    /** The vertical fov drawn this frame. */
    const drawn = (viewer: TestViewer, w: number, h: number) =>
      effectiveVFovDeg(internals(viewer).rig.view.fov, MAX_H, w / h);

    /** The ControlHost the viewer gave its Controls: input in client coordinates. */
    const host = (viewer: TestViewer) => (internals(viewer).controls as { host: ControlHost }).host;

    describe('keeps the requested fov through', () => {
      it('a widen and back', () => {
        const viewer = sizedViewer(1000, 1000);
        resize(2100, 900);
        resize(1000, 1000);
        expect(viewer.getView().fov).toBe(70);
        expect(internals(viewer).rig.view.fov).toBe(70);
        viewer.dispose();
      });

      it('a zero-height blip', () => {
        const viewer = sizedViewer(1600, 900);
        resize(800, 0);
        runUntilIdle();
        resize(1600, 900);
        runUntilIdle();
        expect(viewer.getView().fov).toBe(70);
        expect(internals(viewer).rig.view.fov).toBe(70);
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
        expect(internals(viewer).rig.view.fov).toBe(75);
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
    const stepsIn: [string, (viewer: TestViewer, w: number, h: number) => void][] = [
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
      const viewer = new TestViewer(makeContainer(400, 800), { initialView: { yaw: 0.4 } });
      expect(viewer.heading()).toBeCloseTo(-0.4, 10);
    });

    it('setNorth updates the heading immediately', () => {
      const viewer = new TestViewer(makeContainer(400, 800), { initialView: { yaw: 0.4 } });
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
    function tick(viewer: TestViewer): void {
      internals(viewer).invalidate();
      raf.step(performance.now());
    }

    function yawOf(viewer: TestViewer): number {
      return internals(viewer).rig.view.yaw;
    }

    it('does not rotate when disabled, where the same frames turn an enabled viewer', () => {
      const off = new TestViewer(makeContainer(400, 800), {
        autoRotate: { speed: 1 },
        camera: { damping: 1 },
      });
      const on = new TestViewer(makeContainer(400, 800), {
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
      const viewer = new TestViewer(makeContainer(400, 800), {
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
      const viewer = new TestViewer(makeContainer(400, 800), {
        autoRotate: { enabled: true, speed: 1, idleMs: 1000 },
        camera: { damping: 1 },
      });
      tick(viewer);
      internals(viewer).rig.stopMomentum(); // stands in for a real interaction's gesture start
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
      const viewer = new TestViewer(makeContainer(400, 800), {
        autoRotate: { enabled: true, speed: 1, idleMs: 1000 },
        camera: { damping: 1 },
      });
      internals(viewer).rig.stopMomentum();
      viewer.setAutoRotate(false);
      const before = yawOf(viewer);

      vi.advanceTimersByTime(1000);
      tick(viewer);
      expect(yawOf(viewer)).toBeCloseTo(before, 10);
    });

    it('setAutoRotate(true) enables rotation immediately, with no idle wait', () => {
      const viewer = new TestViewer(makeContainer(400, 800), {
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
      const viewer = new TestViewer(makeContainer(400, 800), {
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
      const viewer = new TestViewer(makeContainer(400, 800), {
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

  describe('camera moves', () => {
    it('eases setView the short way round after the yaw has wound up several turns', () => {
      const viewer = new TestViewer(makeContainer(400, 800), {
        initialView: { yaw: 4 * Math.PI + 0.1 },
      });
      const before = internals(viewer).rig.view.yaw;
      viewer.setView({ yaw: 0.1 });
      tick(viewer);
      expect(Math.abs(internals(viewer).rig.view.yaw - before)).toBeLessThan(0.1);
      expect(viewer.getView().yaw).toBeCloseTo(0.1, 10);
    });

    it('takes the short way across the seam', () => {
      const viewer = new TestViewer(makeContainer(400, 800), {
        initialView: { yaw: Math.PI - 0.1 },
      });
      viewer.setView({ yaw: -Math.PI + 0.1 });
      // 0.2 rad forward across ±π, not 2π − 0.2 back.
      expect(internals(viewer).rig.target.yaw).toBeCloseTo(Math.PI + 0.1, 10);
      expect(viewer.getView().yaw).toBeCloseTo(-Math.PI + 0.1, 10);
    });

    it('keeps yaw bounded when dragging round and round', () => {
      const viewer = new TestViewer(makeContainer(400, 800), {
        initialView: { yaw: 2 * Math.PI - 0.01 },
      });
      internals(viewer).rig.panByPixels(-100, 0); // drag left → look right, past 2π
      expect(Math.abs(internals(viewer).rig.view.yaw)).toBeLessThan(2 * Math.PI);
      expect(internals(viewer).rig.target.yaw).toBe(internals(viewer).rig.view.yaw);
    });

    it('clamps initialView pitch and fov', () => {
      const viewer = new TestViewer(makeContainer(400, 800), {
        initialView: { pitch: 3, fov: 500 },
        camera: { maxFov: 80 },
      });
      const view = viewer.getView();
      expect(view.pitch).toBeLessThan(Math.PI / 2);
      expect(view.fov).toBe(80);
      expect(internals(viewer).rig.view.pitch).toBe(view.pitch);
      expect(internals(viewer).rig.view.fov).toBe(80);
    });

    it('clears momentum on setView', () => {
      const viewer = new TestViewer(makeContainer(400, 800));
      internals(viewer).rig.flick(100, 50);
      expect(internals(viewer).rig.momentum.yaw).not.toBe(0);
      viewer.setView({ yaw: 0.5 });
      expect(internals(viewer).rig.momentum).toEqual({ yaw: 0, pitch: 0 });
    });

    it('clears momentum when a pano swaps in and when a preview goes up', async () => {
      stubNet();
      const viewer = new TestViewer(makeContainer(400, 800));
      internals(viewer).rig.flick(100, 50);
      await viewer.load('pano-a');
      expect(internals(viewer).rig.momentum).toEqual({ yaw: 0, pitch: 0 });
      internals(viewer).rig.flick(100, 50);
      viewer.showPreview('pano-b', previewSource());
      expect(internals(viewer).rig.momentum).toEqual({ yaw: 0, pitch: 0 });
      viewer.dispose();
    });

    it('does not settle while momentum is left, however small', () => {
      const viewer = new TestViewer(makeContainer(400, 800));
      // rad/ms: a step's travel is under the position settle threshold.
      internals(viewer).rig.momentum.yaw = 2e-6;
      tick(viewer);
      expect(internals(viewer).dirty).toBe(true);
      expect(raf.pending).toBe(1);
    });

    it('keeps the same Controls across loads and previews', async () => {
      stubNet();
      const viewer = new TestViewer(makeContainer(400, 800));
      const controls = internals(viewer).controls;
      expect(controls).toBeDefined();
      await viewer.load('pano-a');
      viewer.showPreview('pano-b', previewSource());
      await viewer.load('pano-b');
      expect(internals(viewer).controls).toBe(controls);
      viewer.dispose();
    });
  });
});
