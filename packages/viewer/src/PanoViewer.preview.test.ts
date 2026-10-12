import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FACES } from './cube.js';
import { flushTasks as flush } from './test-support/fake-dom.js';
import {
  useViewerGlobals,
  TestViewer,
  internals,
  tick,
  makeContainer,
} from './test-support/viewer-harness.js';

vi.mock('./render/gl-renderer.js', () => import('./test-support/fake-gl-renderer.js'));

describe('PanoViewer', () => {
  useViewerGlobals();

  describe('local preview', () => {
    type FakeRenderer = {
      uploadTile: ReturnType<typeof vi.fn>;
      removeTile: ReturnType<typeof vi.fn>;
      render: ReturnType<typeof vi.fn>;
      canvas: { addEventListener: ReturnType<typeof vi.fn> };
    };
    type Item = { handle: number; level: number };

    const rendererOf = (viewer: TestViewer): FakeRenderer =>
      (viewer as unknown as { renderer: FakeRenderer }).renderer;
    const lastDrawList = (viewer: TestViewer): Item[] =>
      rendererOf(viewer).render.mock.calls.at(-1)![0] as Item[];

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
      const viewer = new TestViewer(makeContainer(400, 800));
      viewer.setView({ yaw: 1.2, pitch: 0.3, fov: 50 });
      const before = viewer.getView();
      const sceneChange = vi.fn();
      viewer.on('scene-change', sceneChange);

      viewer.showPreview('pano-a', source());
      tick(viewer);

      expect(sceneChange).toHaveBeenCalledWith({ id: 'pano-a', kind: 'preview' });
      expect(viewer.getView()).toEqual(before);
      expect(lastDrawList(viewer).map((d) => d.handle)).toEqual([1, 2]);
      viewer.dispose();
    });

    it('cuts to options.view as the preview goes up, and keeps easing the other axes', () => {
      const viewer = new TestViewer(makeContainer(400, 800));
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
      const viewer = new TestViewer(makeContainer(400, 800), { camera: { damping: 1 } });
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
      const viewer = new TestViewer(makeContainer(400, 800));
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
      const viewer = new TestViewer(makeContainer(400, 800));
      viewer.showPreview('pano-a', source());
      await viewer.load('pano-b');
      expect(rendererOf(viewer).removeTile).toHaveBeenCalledWith(1);
      expect(rendererOf(viewer).removeTile).toHaveBeenCalledWith(2);
      viewer.dispose();
    });

    it('replaces tiles already on screen, and supersedes a load in flight', async () => {
      const tiles = stubTiles((url) => url.includes('/pano-b/'));
      const viewer = new TestViewer(makeContainer(400, 800));
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
    async function settle(viewer: TestViewer, settled: ReturnType<typeof vi.fn>, n = 1) {
      for (let i = 0; i < 20 && settled.mock.calls.length < n; i++) {
        await flush();
        tick(viewer);
        expect(lastDrawList(viewer).length).toBeGreaterThan(0);
      }
    }
    const previewItems = (viewer: TestViewer): Item[] =>
      lastDrawList(viewer).filter((d) => d.handle === 1 || d.handle === 2);

    it('keeps the preview on top of an older version of the same pano, past its tiles-settled', async () => {
      // A replace keeps the panoId: the manifest can still be the old image's.
      // Detail tiles wait, so the frames before they land can be checked.
      let holding = true;
      const tiles = stubTiles((url) => holding && detailTile(url));
      manifestVersion = 'v1';
      const viewer = new TestViewer(makeContainer(400, 800));
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
      const viewer = new TestViewer(makeContainer(400, 800));
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
      const viewer = new TestViewer(makeContainer(400, 800));
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
      const viewer = new TestViewer(makeContainer(400, 800));
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
      const viewer = new TestViewer(makeContainer(400, 800));
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
      const viewer = new TestViewer(makeContainer(400, 800));
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
      const viewer = new TestViewer(makeContainer(400, 800));
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
