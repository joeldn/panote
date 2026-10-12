import { describe, it, expect, afterEach, vi } from 'vitest';
import type { View, ViewerOptions } from './types.js';
import { TileLayer } from './tile-layer.js';
import {
  FakeResizeObserver,
  FakeIntersectionObserver,
  flushTasks as flush,
} from './test-support/fake-dom.js';
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

  describe('frame loop', () => {
    it('stops asking for frames once the camera settles, and asks again on a change', () => {
      const viewer = new TestViewer(makeContainer(400, 800));
      viewer.setView({ yaw: 1 });
      expect(runUntilIdle()).toBeGreaterThan(5);
      expect(internals(viewer).rig.view.yaw).toBe(1);
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
      const viewer = new TestViewer(container, {
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
      const yaw = internals(viewer).rig.view.yaw;
      const requested = raf.request.mock.calls.length;
      viewer.setView({ pitch: 0.1 }); // waits until the viewer is back
      for (let i = 0; i < 10; i++) raf.step(raf.now + 1000);
      expect(raf.request.mock.calls.length).toBe(requested);
      expect(internals(viewer).rig.view.yaw).toBe(yaw);

      io.trigger(true);
      expect(raf.pending).toBe(1);
      raf.step(raf.now + 5000); // no turn for the time spent away
      expect(internals(viewer).rig.view.yaw).toBeCloseTo(yaw, 10);
      expect(internals(viewer).rig.view.pitch).toBeCloseTo(0.1, 10);
      raf.step(raf.now + 50);
      expect(internals(viewer).rig.view.yaw).toBeCloseTo(yaw + 0.05, 10);
      viewer.dispose();
      expect(io.disconnect).toHaveBeenCalled();
    });

    it('glides the same distance, at the same pace, at 30, 60 and 120 Hz', () => {
      const glide = (hz: number): { at200ms: number; total: number } => {
        const viewer = new TestViewer(makeContainer(400, 800));
        runUntilIdle();
        internals(viewer).rig.flick(30, 0);
        raf.step(); // the first frame after an idle spell steps one nominal frame
        const end = raf.now + 200;
        while (raf.now < end - 1e-6) raf.step(raf.now + 1000 / hz);
        // Where the glide has carried the target; the camera eases after it.
        const at200ms = internals(viewer).rig.target.yaw;
        runUntilIdle(1000 / hz, 10_000);
        const total = internals(viewer).rig.view.yaw;
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

    it('glides a released drag on at its speed from the first frame at 60, 120 and 144 Hz', () => {
      // A drag at 0.6 px/ms, one move per display frame as Chrome sends them,
      // released mid-move; then the camera's yaw speed frame by frame.
      const glide = (hz: number) => {
        const viewer = new TestViewer(makeContainer(1422, 800));
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
        let before = 0;
        for (let i = 0; i < 20; i++) {
          x += 0.6 * period;
          canvasListener(viewer, 'pointermove')(ev(x, raf.now + period));
          if (i === 14) before = internals(viewer).rig.view.yaw;
          raf.step(raf.now + period);
        }
        canvasListener(viewer, 'pointerup')(ev(x, raf.now + 2, 0));
        const released = internals(viewer).rig.view.yaw;
        // The drag's speed on screen over its last five frames.
        const dragSpeed = Math.abs(released - before) / (5 * period);
        const speeds: number[] = [];
        let yaw = released;
        while (raf.pending > 0 && speeds.length < 5000) {
          raf.step(raf.now + period);
          const now = internals(viewer).rig.view.yaw;
          speeds.push(Math.abs(now - yaw) / period);
          yaw = now;
        }
        const total = Math.abs(internals(viewer).rig.view.yaw - released);
        viewer.dispose();
        return { speeds, total, dragSpeed };
      };
      const at60 = glide(60);
      expect(at60.speeds.length).toBeGreaterThan(30);
      for (const hz of [60, 120, 144]) {
        const { speeds, total, dragSpeed } = hz === 60 ? at60 : glide(hz);
        // No dip as the glide takes over: the first frame carries on at
        // about the drag's speed.
        expect(speeds[0]! / dragSpeed).toBeGreaterThanOrEqual(0.8);
        expect(speeds[0]! / dragSpeed).toBeLessThan(1.3);
        // Then only slows, and never stalls, until it settles.
        for (let i = 1; i < speeds.length - 1; i++) {
          expect(speeds[i]!).toBeLessThanOrEqual(speeds[i - 1]!);
          expect(speeds[i]!).toBeGreaterThan(0);
        }
        expect(Math.abs(total / at60.total - 1)).toBeLessThan(0.05);
        expect(Math.abs(speeds[0]! / at60.speeds[0]! - 1)).toBeLessThan(0.1);
      }
    });

    it('eases toward a new view at the same pace at 30 and 120 Hz', () => {
      const after100ms = (hz: number): number => {
        const viewer = new TestViewer(makeContainer(400, 800));
        runUntilIdle();
        viewer.setView({ yaw: 1 });
        raf.step(); // the first frame after an idle spell steps one nominal frame
        const end = raf.now + 100;
        while (raf.now < end - 1e-6) raf.step(raf.now + 1000 / hz);
        const yaw = internals(viewer).rig.view.yaw;
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
      const viewer = new TestViewer(container, { camera: { damping: 1 } });
      reads = 0;
      let projected = 0;
      viewer.onRender(() => {
        viewer.project(0.1, 0);
        viewer.project(-0.1, 0.2);
        projected += 2;
      });
      for (let i = 0; i < 10; i++) {
        internals(viewer).rig.panByPixels(5, 0);
        raf.step();
        viewer.directionAtPixel(10, 10);
      }
      expect(projected).toBe(20);
      expect(reads).toBe(0);
      const centre = viewer.project(internals(viewer).rig.view.yaw, 0);
      expect(centre.x).toBeCloseTo(200, 3);
      expect(centre.y).toBeCloseTo(400, 3);
    });

    it('projects into an object the caller passes, for a frame that allocates nothing', () => {
      const viewer = new TestViewer(makeContainer(400, 800), { initialView: { yaw: 0.2 } });
      const out = { x: -1, y: -1, behind: true };
      for (const [yaw, pitch] of [
        [0.3, 0.1],
        [Math.PI, 0],
        [-0.4, -0.3],
      ] as const) {
        expect(viewer.project(yaw, pitch, out)).toBe(out);
        expect(out).toEqual(viewer.project(yaw, pitch));
      }
      // Without one, each call gets its own: a caller may hold two at once.
      const a = viewer.project(0.1, 0);
      const b = viewer.project(-0.1, 0);
      expect(a).not.toBe(b);
      expect(a.x).toBeGreaterThan(b.x);
      viewer.dispose();
    });

    it('projects from the initial view before the first frame', () => {
      const viewer = new TestViewer(makeContainer(400, 800), { initialView: { yaw: Math.PI } });
      const ahead = viewer.project(Math.PI, 0);
      expect(ahead.behind).toBe(false);
      expect(ahead.x).toBeCloseTo(200, 3);
      expect(viewer.project(0, 0).behind).toBe(true);
      viewer.dispose();
    });

    it('takes the size from ResizeObserver entries', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const viewer = new TestViewer(makeContainer(400, 800));
      FakeResizeObserver.instances[0]!.trigger(1000, 500);
      raf.step();
      const centre = viewer.project(0, 0);
      expect(centre.x).toBeCloseTo(500, 3);
      expect(centre.y).toBeCloseTo(250, 3);
      expect((internals(viewer).renderer.canvas as unknown as { width: number }).width).toBe(2000);
      viewer.dispose();
    });

    it('moves the target on an arrow key, so damping eases the camera after it', () => {
      const viewer = new TestViewer(makeContainer(400, 800));
      runUntilIdle();
      const { view, target } = internals(viewer).rig;
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
      const viewer = new TestViewer(makeContainer(400, 800), { initialView: { yaw: 0.3 } });
      const seen: number[] = [];
      viewer.onRender((v) => {
        seen.push(v.yaw);
        (v as View).yaw = 9;
      });
      raf.step();
      viewer.requestRender();
      raf.step();
      expect(seen).toEqual([0.3, 0.3]);
      expect(internals(viewer).rig.view.yaw).toBe(0.3);
      viewer.dispose();
    });

    it('reuses one view-projection matrix across frames', () => {
      const viewer = new TestViewer(makeContainer(400, 800));
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
      const embedded = new TestViewer(makeContainer(400, 800), {
        interaction: { wheel: 'engaged' },
      });
      const scrolls = wheel();
      canvasListener(embedded, 'wheel')(scrolls);
      expect(scrolls.preventDefault).not.toHaveBeenCalled();

      const plain = new TestViewer(makeContainer(400, 800));
      const zooms = wheel();
      canvasListener(plain, 'wheel')(zooms);
      expect(zooms.preventDefault).toHaveBeenCalled();
      expect(plain.getView().fov).toBeGreaterThan(70);
      embedded.dispose();
      plain.dispose();
    });
  });

  describe('render callbacks and frames', () => {
    describe('render callbacks', () => {
      /** A viewer at rest with `cb` subscribed and its first call made. */
      async function atRest(cb: ReturnType<typeof vi.fn<(view: Readonly<View>) => void>>) {
        const net = stubNet({ holdTile: (url) => !url.includes('/0/') });
        const viewer = new TestViewer(makeContainer(400, 800));
        await viewer.load('pano-a');
        viewer.onRender(cb);
        runUntilIdle();
        expect(cb).toHaveBeenCalled();
        cb.mockClear();
        return { viewer, net };
      }

      it('skip a frame that only a tile landing asked for', async () => {
        const cb = vi.fn<(view: Readonly<View>) => void>();
        const { viewer, net } = await atRest(cb);
        const render = internals(viewer).renderer.render;
        render.mockClear();
        net.release();
        await flush();
        runUntilIdle();
        expect(render).toHaveBeenCalled(); // the tiles were drawn
        expect(cb).not.toHaveBeenCalled(); // nothing on screen moved
        viewer.dispose();
      });

      it('run on every frame the camera moves', async () => {
        const cb = vi.fn<(view: Readonly<View>) => void>();
        const { viewer } = await atRest(cb);
        viewer.setView({ yaw: 1 });
        const frames = runUntilIdle();
        expect(frames).toBeGreaterThan(1);
        expect(cb).toHaveBeenCalledTimes(frames);
        expect(cb.mock.calls.at(-1)![0]).toMatchObject({ yaw: 1 });
        viewer.dispose();
      });

      it('run when the host asks with requestRender', async () => {
        const cb = vi.fn<(view: Readonly<View>) => void>();
        const { viewer } = await atRest(cb);
        viewer.requestRender();
        runUntilIdle();
        expect(cb).toHaveBeenCalledTimes(1);
        viewer.dispose();
      });

      it('run after a resize, even one that leaves the camera matrix as it was', async () => {
        vi.stubGlobal('ResizeObserver', FakeResizeObserver);
        const cb = vi.fn<(view: Readonly<View>) => void>();
        const { viewer } = await atRest(cb);
        // Twice the size, the same aspect: the same matrix, other pixels.
        FakeResizeObserver.instances.at(-1)!.trigger(800, 1600);
        runUntilIdle();
        expect(cb).toHaveBeenCalledTimes(1);
        viewer.dispose();
      });

      it('run when another scene swaps in under a still camera', async () => {
        const cb = vi.fn<(view: Readonly<View>) => void>();
        const { viewer } = await atRest(cb);
        await viewer.load('pano-b');
        runUntilIdle();
        expect(cb).toHaveBeenCalledTimes(1);
        viewer.dispose();
      });

      it('run when north is set, which turns the compass', async () => {
        const cb = vi.fn<(view: Readonly<View>) => void>();
        const { viewer } = await atRest(cb);
        viewer.setNorth(1);
        runUntilIdle();
        expect(cb).toHaveBeenCalledTimes(1);
        viewer.dispose();
      });

      it('run a callback that just subscribed on the next frame', async () => {
        const cb = vi.fn<(view: Readonly<View>) => void>();
        const { viewer } = await atRest(cb);
        const late = vi.fn();
        viewer.onRender(late);
        runUntilIdle();
        expect(late).toHaveBeenCalledTimes(1);
        viewer.dispose();
      });
    });

    it('focus() focuses its canvas without scrolling the page', () => {
      const viewer = new TestViewer(makeContainer(400, 800));
      viewer.focus();
      expect(internals(viewer).renderer.canvas.focus).toHaveBeenCalledWith({ preventScroll: true });
      viewer.dispose();
    });

    it('keeps rendering when an onRender callback throws', () => {
      const report = vi.fn();
      vi.stubGlobal('reportError', report);
      const viewer = new TestViewer(makeContainer(400, 800));
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
      const viewer = new TestViewer(makeContainer(400, 800));
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
      type Row = [string, () => Promise<{ viewer: TestViewer | undefined; fire: () => unknown }>];
      const idleViewer = (options: ViewerOptions = {}) =>
        new TestViewer(makeContainer(400, 800), options);
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
            return { viewer, fire: () => viewer.showPreview('pano-a', previewSource()) };
          },
        ],
        [
          'auto-rotate resumes after the idle wait',
          async () => {
            vi.useFakeTimers();
            vi.stubGlobal('requestAnimationFrame', raf.request);
            vi.stubGlobal('cancelAnimationFrame', raf.cancel);
            const viewer = idleViewer({ autoRotate: { enabled: true, idleMs: 1000 } });
            internals(viewer).rig.stopMomentum(); // an interaction pauses it
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
            let viewer: TestViewer | undefined;
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
      const viewer = new TestViewer(makeContainer(400, 800));
      expect(window.addEventListener).not.toHaveBeenCalledWith('resize', expect.anything());
      viewer.dispose();
    });

    it('steps one nominal 60 Hz frame for the first frame after an idle spell', () => {
      const viewer = new TestViewer(makeContainer(400, 800));
      runUntilIdle();
      viewer.setView({ yaw: 1 });
      raf.step(raf.now + 10_000);
      // damping 0.25 per 16.67 ms: one quarter of the way.
      expect(internals(viewer).rig.view.yaw).toBeCloseTo(0.25, 10);
      viewer.dispose();
    });

    it('caps a stalled frame at 100 ms of motion', () => {
      const viewer = new TestViewer(makeContainer(400, 800));
      runUntilIdle();
      viewer.setView({ yaw: 1 });
      raf.step(); // running now, at 0.25
      raf.step(raf.now + 5000);
      // 100 ms is six 60 Hz frames of damping 0.25.
      expect(internals(viewer).rig.view.yaw).toBeCloseTo(1 - 0.75 * 0.75 ** 6, 10);
      viewer.dispose();
    });

    it('lets the loop stop when auto-rotate is on at zero speed', () => {
      const viewer = new TestViewer(makeContainer(400, 800), {
        autoRotate: { enabled: true, speed: 0 },
      });
      expect(runUntilIdle()).toBeLessThan(10);
      expect(raf.pending).toBe(0);
      viewer.dispose();
    });
  });
});
