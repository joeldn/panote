import { describe, it, expect, vi } from 'vitest';
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

  describe('camera moves', () => {
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
