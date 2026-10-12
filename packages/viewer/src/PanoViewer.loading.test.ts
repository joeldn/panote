import { describe, it, expect, vi } from 'vitest';
import { FACES } from './cube.js';
import type { CubeTileSource } from './source.js';
import { flushTasks as flush } from './test-support/fake-dom.js';
import {
  useViewerGlobals,
  raf,
  TestViewer,
  internals,
  tick,
  runUntilIdle,
  makeContainer,
  stubNet,
  stubOverlayDom,
  previewSource,
  finish,
} from './test-support/viewer-harness.js';

vi.mock('./render/gl-renderer.js', () => import('./test-support/fake-gl-renderer.js'));

describe('PanoViewer', () => {
  useViewerGlobals();

  describe('loads', () => {
    it('resolves true when the load takes effect', async () => {
      stubNet();
      const viewer = new TestViewer(makeContainer(400, 800));
      await expect(viewer.load('pano-a')).resolves.toBe(true);
      viewer.dispose();
    });

    it('applies load(pano, { view }) at the swap, with no easing', async () => {
      const net = stubNet({ holdTile: (url) => url.includes('/pano-b/') });
      const viewer = new TestViewer(makeContainer(400, 800));
      await viewer.load('pano-a');
      internals(viewer).rig.flick(100, 0);
      const loading = viewer.load('pano-b', { view: { yaw: 1, pitch: 0.2, fov: 50 } });
      await flush();
      // Not applied before the swap: the old pano keeps its camera.
      expect(viewer.getView().yaw).toBe(0);
      net.release();
      await expect(loading).resolves.toBe(true);
      expect(internals(viewer).rig.target).toEqual({ yaw: 1, pitch: 0.2, fov: 50 });
      expect(internals(viewer).rig.view).toEqual({ yaw: 1, pitch: 0.2, fov: 50 });
      expect(internals(viewer).rig.momentum).toEqual({ yaw: 0, pitch: 0 });
      tick(viewer);
      expect(internals(viewer).rig.view).toEqual({ yaw: 1, pitch: 0.2, fov: 50 });
      viewer.dispose();
    });

    it('disposes the pending layer and aborts the manifest fetch of a superseded load', async () => {
      const net = stubNet({
        holdTile: (url) => url.includes('/pano-a/'),
        holdManifest: (url) => url.includes('/pano-b/'),
      });
      const viewer = new TestViewer(makeContainer(400, 800));
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
      viewer.showPreview('pano-c', previewSource());
      expect(signalB?.aborted).toBe(true);
      await expect(b).resolves.toBe(false);
      viewer.dispose();
    });

    it('resolves false, without throwing, when a superseded manifest fetch rejects', async () => {
      const net = stubNet({ holdManifest: (url) => url.includes('/pano-a/') });
      const viewer = new TestViewer(makeContainer(400, 800));
      const a = viewer.load('pano-a');
      await viewer.load('pano-b');
      expect(net.signalOf('/tiles/pano-a/manifest.json')?.aborted).toBe(true);
      await expect(a).resolves.toBe(false);
      viewer.dispose();
    });

    it('never applies a superseded transition view, and puts up no overlay for it', async () => {
      const net = stubNet({ holdTile: (url) => /\/pano-[ab]\//.test(url) });
      const { container, overlays } = stubOverlayDom();
      const viewer = new TestViewer(container);
      await viewer.load('pano-0');
      tick(viewer);

      const a = viewer.load('pano-a', { view: { yaw: 2 }, transition: true });
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
      const viewer = new TestViewer(container, { transition: { durationMs: 30 } });
      await viewer.load('pano-0');
      tick(viewer);

      const a = viewer.load('pano-a', { view: { yaw: 2 }, transition: true });
      for (let i = 0; i < 50 && overlays[0]?.style['opacity'] !== '0'; i++) {
        await flush();
        raf.step();
      }
      expect(overlays[0]!.remove).not.toHaveBeenCalled();
      viewer.showPreview('pano-c', previewSource());
      expect(overlays[0]!.remove).toHaveBeenCalled();
      await a;
      viewer.dispose();
    });

    describe("with the tile layer's upload queue", () => {
      type Queue = { ready: Map<string, unknown> };
      const readyOf = (viewer: TestViewer) => (internals(viewer).layer as Queue).ready;
      const uploads = (viewer: TestViewer) =>
        (internals(viewer).renderer as unknown as { uploadTile: ReturnType<typeof vi.fn> })
          .uploadTile.mock.calls.length;

      it('never aborts the base fetches of a slow load, however many frames run', async () => {
        const net = stubNet({ holdTile: (url) => url.includes('/0/') });
        const viewer = new TestViewer(makeContainer(400, 800), {
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
        // Wide: a request slot for every tile in view, so they all decode at once.
        const viewer = new TestViewer(makeContainer(800, 800), { network: { maxConcurrent: 64 } });
        await viewer.load('pano-a');
        runUntilIdle();
        const base = uploads(viewer);
        holding = false;
        net.release();
        await flush();
        const decoded = readyOf(viewer).size;
        expect(decoded).toBeGreaterThan(8); // more than one frame uploads
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
        const viewer = new TestViewer(makeContainer(400, 800), { camera: { damping: 1 } });
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

    it('cuts only the axes load(pano, { view }) sets, leaving the others easing', async () => {
      stubNet();
      const viewer = new TestViewer(makeContainer(400, 800));
      await viewer.load('pano-a');
      viewer.setView({ fov: 40 }); // not drawn yet: the camera is still at 70
      await viewer.load('pano-b', { view: { yaw: 1 } });
      expect(internals(viewer).rig.view.yaw).toBe(1);
      expect(internals(viewer).rig.view.fov).toBe(70);
      expect(internals(viewer).rig.target.fov).toBe(40);
      viewer.dispose();
    });

    it('resolves true and still emits scene-change when a ready listener throws', async () => {
      stubNet();
      const reportError = vi.fn();
      vi.stubGlobal('reportError', reportError);
      const viewer = new TestViewer(makeContainer(400, 800));
      const boom = new Error('boom');
      const sceneChange = vi.fn();
      viewer.on('ready', () => {
        throw boom;
      });
      viewer.on('scene-change', sceneChange);
      await expect(viewer.load('pano-a')).resolves.toBe(true);
      expect(sceneChange).toHaveBeenCalledExactlyOnceWith({ id: 'pano-a', kind: 'tiles' });
      expect(reportError).toHaveBeenCalledExactlyOnceWith(boom);
      viewer.dispose();
    });

    it('does not announce a scene change for a load a ready listener superseded', async () => {
      stubNet({ holdTile: (url) => url.includes('/pano-b/') });
      const viewer = new TestViewer(makeContainer(400, 800));
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
      const viewer = new TestViewer(container, { transition: { durationMs: 0 } });
      await viewer.load('pano-0');
      runUntilIdle();
      const fake = internals(viewer).renderer as unknown as {
        render: ReturnType<typeof vi.fn>;
        snapshot: ReturnType<typeof vi.fn>;
      };

      const done = viewer.load('pano-a', { transition: true });
      await flush();
      // Nothing covers the old scene while the new one loads.
      expect(overlays).toHaveLength(0);
      expect(container.appendChild).not.toHaveBeenCalled();

      // A drag still moves what the visitor sees.
      const yaw0 = internals(viewer).rig.view.yaw;
      fake.render.mockClear();
      internals(viewer).rig.panByPixels(300, 0);
      raf.step();
      expect(internals(viewer).rig.view.yaw).not.toBeCloseTo(yaw0, 3);
      expect(fake.render).toHaveBeenCalledTimes(1);
      const drawn = fake.render.mock.calls[0]![0] as unknown[];
      expect(drawn.length).toBeGreaterThan(0);
      expect(fake.snapshot).not.toHaveBeenCalled();

      // The snapshot goes up at the swap, of the old scene where it was left.
      net.release();
      await finish(done);
      // Settled once the fade is over, as a load that took effect.
      await expect(done).resolves.toBe(true);
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
      const viewer = new TestViewer(container, { transition: { durationMs: 0 } });
      await viewer.load('pano-0');
      runUntilIdle();
      // Moving on as soon as A is ready supersedes the transition's fade.
      viewer.on('ready', (src) => {
        if (src.id === 'pano-a') void viewer.load('pano-b');
      });
      let done = false;
      const t = viewer.load('pano-a', { transition: true }).then(() => (done = true));
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
      const viewer = new TestViewer(container, { transition: { durationMs: 0 } });
      await viewer.load('pano-0');
      runUntilIdle();
      const fake = internals(viewer).renderer as unknown as {
        loseContext(): void;
        restoreContext(): void;
      };
      const done = viewer.load('pano-a', { transition: true });
      await flush();
      fake.loseContext();
      await expect(done).resolves.toBe(false);
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
      const layerId = (viewer: TestViewer) =>
        (internals(viewer).layer as { source: CubeTileSource } | undefined)?.source.id;

      it('resolves a load waiting on its base to false and keeps the scene on screen', async () => {
        const net = stubNet({ holdTile: (url) => url.includes('/pano-b/') });
        const viewer = new TestViewer(makeContainer(400, 800));
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
        const viewer = new TestViewer(makeContainer(400, 800));
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
        const viewer = new TestViewer(container, { transition: { durationMs: 0 } });
        await viewer.load('pano-a');
        runUntilIdle();
        const t = viewer.load('pano-b', { view: { yaw: 2 }, transition: true });
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
        const viewer = new TestViewer(makeContainer(400, 800));
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
        const viewer = new TestViewer(makeContainer(400, 800));
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
        const viewer = new TestViewer(makeContainer(400, 800));
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
        const viewer = new TestViewer(makeContainer(400, 800));
        await viewer.load('pano-a');
        viewer.cancelLoad();
        expect(layerId(viewer)).toBe('pano-a');
        // A later load still works.
        await expect(viewer.load('pano-b')).resolves.toBe(true);
        viewer.dispose();
        expect(() => viewer.cancelLoad()).not.toThrow();
      });
    });

    it('does nothing for a transition load after dispose', async () => {
      stubNet();
      const viewer = new TestViewer(makeContainer(400, 800));
      viewer.dispose();
      await expect(viewer.load('pano-a', { view: { yaw: 1 }, transition: true })).resolves.toBe(
        false,
      );
      expect(window.matchMedia).not.toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('hands over to a newer transition: the older one applies nothing and loses its overlay', async () => {
      const net = stubNet({ holdTile: (url) => /\/pano-[ab]\//.test(url) });
      const { container, overlays } = stubOverlayDom();
      const viewer = new TestViewer(container, { transition: { durationMs: 0 } });
      await viewer.load('pano-0');
      tick(viewer);

      const a = viewer.load('pano-a', { view: { yaw: 2 }, transition: true });
      await flush();
      const b = viewer.load('pano-b', { view: { yaw: -1 }, transition: true });
      await expect(a).resolves.toBe(false);
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
      const viewer = new TestViewer(container, { transition: { durationMs: 30 } });
      await viewer.load('pano-0');
      tick(viewer);

      let done = false;
      const fading = viewer.load('pano-a', { transition: true }).then(() => (done = true));
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
      const viewer = new TestViewer(container, { transition: { durationMs: 0 } });
      await viewer.load('pano-0');
      tick(viewer);
      const sceneChange = vi.fn();
      viewer.on('scene-change', sceneChange);

      const a = viewer.load('pano-a', { view: { yaw: 1 }, transition: true });
      await flush();
      const b = viewer.load('pano-b', { view: { yaw: 2 }, transition: true });
      await flush();
      const c = viewer.load('pano-c', { view: { yaw: -1 }, transition: true });
      await expect(Promise.all([a, b])).resolves.toEqual([false, false]);
      expect(viewer.getView().yaw).toBe(0);
      expect(overlays).toHaveLength(0);

      net.release();
      await finish(c);
      expect(viewer.getView().yaw).toBe(-1);
      expect(sceneChange.mock.calls).toEqual([[{ id: 'pano-c', kind: 'tiles' }]]);
      expect(overlays).toHaveLength(1);
      expect(overlays[0]!.remove).toHaveBeenCalled();
      const layer = internals(viewer).layer as { source: CubeTileSource };
      expect(layer.source.id).toBe('pano-c');
      viewer.dispose();
    });
  });
});
