import { describe, it, expect, vi } from 'vitest';
import { FACES } from './cube.js';
import type { CubeTileSource } from './source.js';
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
  stubOverlayDom,
  finish,
} from './test-support/viewer-harness.js';

vi.mock('./render/gl-renderer.js', () => import('./test-support/fake-gl-renderer.js'));

describe('PanoViewer', () => {
  useViewerGlobals();

  describe('lifecycle', () => {
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
      const fakeOf = (viewer: TestViewer) => internals(viewer).renderer as unknown as Fake;
      const manifestFetches = () =>
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('manifest.json')).length;
      const layerPano = (viewer: TestViewer) =>
        (internals(viewer).layer as { source: CubeTileSource } | undefined)?.source.id;

      describe('context loss', () => {
        it('draws a restored scene from its base until its finer tiles are back', async () => {
          let holdFine = false;
          const net = stubNet({ holdTile: (url) => holdFine && !url.includes('/0/') });
          const viewer = new TestViewer(makeContainer(400, 800));
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

        it('stops drawing while lost, then loads the scene again from the source it holds', async () => {
          stubNet();
          const viewer = new TestViewer(makeContainer(400, 800));
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
          const viewer = new TestViewer(makeContainer(400, 800));
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
          expect(sceneChange.mock.calls).toEqual([[{ id: 'pano-b', kind: 'tiles' }]]);
          viewer.dispose();
        });

        it('emits load-error when the reload after a restore fails', async () => {
          stubNet();
          const viewer = new TestViewer(makeContainer(400, 800));
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
          const viewer = new TestViewer(makeContainer(400, 800));
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
          const viewer = new TestViewer(makeContainer(400, 800));
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
          const viewer = new TestViewer(makeContainer(400, 800));
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
          const viewer = new TestViewer(makeContainer(400, 800));
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
          const viewer = new TestViewer(makeContainer(400, 800), {
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
          const viewer = new TestViewer(makeContainer(400, 800));
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
          const viewer = new TestViewer(makeContainer(400, 800));
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
          const viewer = new TestViewer(container);
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
          const viewer = new TestViewer(makeContainer(400, 800));
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
          const viewer = new TestViewer(makeContainer(400, 800));
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
          expect(fakeOf(new TestViewer(makeContainer(400, 800))).opts.maxPixels).toBe(8_300_000);
          const viewer = new TestViewer(makeContainer(400, 800), { rendering: { maxPixels: 1e6 } });
          expect(fakeOf(viewer).opts.maxPixels).toBe(1e6);
        });
      });

      it('pauses the tile requests while off screen', async () => {
        vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
        stubNet();
        const viewer = new TestViewer(makeContainer(400, 800));
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
        const viewer = new TestViewer(container, { transition: { durationMs: 0 } });
        await viewer.load('pano-0');
        tick(viewer);
        const fake = fakeOf(viewer);
        await finish(viewer.load('pano-a', { transition: true }));
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
      const canvasOf = (viewer: TestViewer) =>
        internals(viewer).renderer.canvas as unknown as Canvas;
      const rendererOpts = (viewer: TestViewer) =>
        (internals(viewer).renderer as unknown as { opts: Record<string, unknown> }).opts;

      it('names the canvas as an application through attributes, and renames it', () => {
        const viewer = new TestViewer(makeContainer(400, 800));
        expect(canvasOf(viewer).attributes).toEqual({
          role: 'application',
          'aria-label': 'Panorama viewer',
        });
        viewer.setLabel('Town hall');
        expect(canvasOf(viewer).attributes['aria-label']).toBe('Town hall');
        viewer.dispose();

        const named = new TestViewer(makeContainer(400, 800), {
          interaction: { label: 'Old town: Square' },
        });
        expect(canvasOf(named).attributes['aria-label']).toBe('Old town: Square');
        named.dispose();
      });

      it('leaves the canvas unnamed with interaction.a11y off', () => {
        const viewer = new TestViewer(makeContainer(400, 800), { interaction: { a11y: false } });
        viewer.setLabel('Town hall');
        expect(canvasOf(viewer).attributes).toEqual({});
        viewer.dispose();
      });

      it('takes no input with interaction.enabled off, and is an image to assistive tech', () => {
        const viewer = new TestViewer(makeContainer(400, 800), { interaction: { enabled: false } });
        expect(internals(viewer).controls).toBeUndefined();
        expect(canvasOf(viewer).addEventListener).not.toHaveBeenCalledWith(
          'pointerdown',
          expect.any(Function),
        );
        expect(canvasOf(viewer).attributes['role']).toBe('img');
        viewer.dispose();
      });

      it('hands the interaction options to its controls', () => {
        const viewer = new TestViewer(makeContainer(400, 800), { interaction: { wheel: 'off' } });
        expect(() => canvasListener(viewer, 'wheel')).toThrow('no wheel listener');
        viewer.dispose();
      });

      it('starts at camera.defaultFov, and keeps pitch inside camera.minPitch/maxPitch', () => {
        const viewer = new TestViewer(makeContainer(400, 800), {
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
        const viewer = new TestViewer(makeContainer(400, 800), {
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
        const viewer = new TestViewer(makeContainer(400, 800), { rendering: { lodBias: 0.5 } });
        await viewer.load('pano-a');
        const layer = internals(viewer).layer as { lodTolerance: number };
        expect(layer.lodTolerance).toBeCloseTo(0.7, 10);
        viewer.dispose();
      });

      it('crossfades for a reduced-motion visitor with transition.respectReducedMotion off', async () => {
        stubNet();
        const { container } = stubOverlayDom();
        const viewer = new TestViewer(container, {
          transition: { durationMs: 0, respectReducedMotion: false },
        });
        await viewer.load('pano-0');
        tick(viewer);
        await finish(viewer.load('pano-a', { transition: true }));
        expect(window.matchMedia).not.toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
        viewer.dispose();
      });
    });
  });
});
