import { describe, it, expect, vi } from 'vitest';
import { TileLayer } from './tile-layer.js';
import { type GLRenderer } from './render/gl-renderer.js';
import {
  useLayerFixture,
  LAYER_DEFAULTS,
  FRAME_MS,
  makeSource,
} from './test-support/tile-layer-fixture.js';

describe('TileLayer uploads', () => {
  const fx = useLayerFixture();
  const { advance, flush, makeLayer, frame, stayAt, withLevel1, readyCount } = fx;

  describe('upload batching', () => {
    /** Decodes held until released, each bitmap tracked. */
    function holdDecodes(): {
      bitmaps: { close: ReturnType<typeof vi.fn> }[];
      release: () => void;
    } {
      const bitmaps: { close: ReturnType<typeof vi.fn> }[] = [];
      const held: (() => void)[] = [];
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(
          () =>
            new Promise((resolve) => {
              const bitmap = { close: vi.fn() };
              bitmaps.push(bitmap);
              held.push(() => resolve(bitmap));
            }),
        ),
      );
      return { bitmaps, release: () => held.splice(0).forEach((r) => r()) };
    }

    /** A layer with a slot for each of the 16 tiles in view, so all 16 decode together. */
    const wideLayer = (): TileLayer =>
      new TileLayer(fx.renderer as unknown as GLRenderer, makeSource('pano-a'), () => {}, {
        ...LAYER_DEFAULTS,
        textureBudgetMB: 128,
        maxConcurrent: 16,
        now: () => fx.clock,
      });

    /** Uploads per frame while a burst of decoded tiles drains, each costing `ms`. */
    async function drainBurst(ms: number): Promise<number[]> {
      const decodes = holdDecodes();
      const layer = wideLayer();
      frame(layer, 0);
      await flush();
      expect(decodes.bitmaps).toHaveLength(16);
      decodes.release(); // all sixteen land together, as from the HTTP cache
      await flush();
      expect(fx.renderer.uploadTile).not.toHaveBeenCalled();
      fx.renderer.uploadTile.mockImplementation(() => {
        advance(ms);
        return fx.renderer.uploadTile.mock.calls.length;
      });
      const perFrame: number[] = [];
      while (readyCount(layer) > 0 && perFrame.length < 20) {
        const before = fx.renderer.uploadTile.mock.calls.length;
        advance(FRAME_MS);
        frame(layer, 0);
        perFrame.push(fx.renderer.uploadTile.mock.calls.length - before);
      }
      layer.dispose();
      return perFrame;
    }

    it('uploads a burst of quick uploads eight per frame', async () => {
      // 16 tiles from the HTTP cache at 0.3 ms each: two frames, not six.
      expect(await drainBurst(0.3)).toEqual([8, 8]);
    });

    it('uploads no more a frame than maxUploadsPerUpdate', async () => {
      // As the viewer builds the layer on a phone.
      const decodes = holdDecodes();
      const layer = new TileLayer(
        fx.renderer as unknown as GLRenderer,
        makeSource('pano-a'),
        () => {},
        {
          ...LAYER_DEFAULTS,
          textureBudgetMB: 128,
          maxConcurrent: 16,
          maxUploadsPerUpdate: 4,
          now: () => fx.clock,
        },
      );
      frame(layer, 0);
      await flush();
      decodes.release();
      await flush();
      const perFrame: number[] = [];
      while (readyCount(layer) > 0 && perFrame.length < 20) {
        const before = fx.renderer.uploadTile.mock.calls.length;
        advance(FRAME_MS);
        frame(layer, 0);
        perFrame.push(fx.renderer.uploadTile.mock.calls.length - before);
      }
      expect(perFrame).toEqual([4, 4, 4, 4]);
      layer.dispose();
    });

    it('still holds slow uploads to the frame time budget', async () => {
      // 1.5 ms each: the third starts at 3 ms, inside the 4 ms budget, and
      // no fourth starts after it.
      const perFrame = await drainBurst(1.5);
      expect(perFrame.slice(0, 5)).toEqual([3, 3, 3, 3, 3]);
      expect(perFrame.reduce((a, b) => a + b)).toBe(16);
    });

    it('stops uploading for the frame once the time budget is spent', async () => {
      const decodes = holdDecodes();
      const layer = makeLayer();
      frame(layer, 0);
      await flush();
      decodes.release();
      await flush();
      // Each upload takes 3 ms on the layer's clock: two fit in 4 ms, a third
      // would start after it.
      fx.renderer.uploadTile.mockImplementation(() => {
        advance(3);
        return fx.renderer.uploadTile.mock.calls.length;
      });
      frame(layer, 0);
      expect(fx.renderer.uploadTile).toHaveBeenCalledTimes(2);
      layer.dispose();
    });

    it('closes a decoded tile that left the view instead of uploading it', async () => {
      const layer = await withLevel1(makeLayer());
      const decodes = holdDecodes();
      frame(layer, 0);
      await flush();
      const first = [...decodes.bitmaps];
      decodes.release();
      await flush();
      // The decoded tiles are behind the camera now. They wait out the same
      // frames an in-flight load would, without being uploaded, then go.
      frame(layer, Math.PI);
      expect(readyCount(layer)).toBe(first.length);
      for (const bitmap of first) expect(bitmap.close).not.toHaveBeenCalled();
      stayAt(layer, Math.PI);
      expect(fx.renderer.uploadTile).not.toHaveBeenCalled();
      for (const bitmap of first) expect(bitmap.close).toHaveBeenCalledTimes(1);
      expect(readyCount(layer)).toBe(0);
      layer.dispose();
    });

    it('stays pending while decoded tiles wait, and asks for frames to upload them', async () => {
      const invalidate = vi.fn();
      const layer = makeLayer('pano-a', 128, invalidate);
      frame(layer, 0);
      // No further frames: every wanted tile is fetched and decoded, so
      // nothing is in flight or queued, and all of it waits to be uploaded.
      for (let i = 0; i < 5; i++) await flush();
      const { inflight } = layer as unknown as { inflight: Map<string, unknown> };
      expect(inflight.size).toBe(0);
      expect(readyCount(layer)).toBeGreaterThan(3);
      expect(layer.hasPending()).toBe(true);
      expect(invalidate).toHaveBeenCalled();
      for (let i = 0; i < 100 && readyCount(layer) > 0; i++) frame(layer, 0);
      expect(layer.hasPending()).toBe(false);
      layer.dispose();
    });

    it('closes queued bitmaps on dispose', async () => {
      const decodes = holdDecodes();
      const layer = makeLayer();
      frame(layer, 0);
      await flush();
      const queued = [...decodes.bitmaps];
      decodes.release();
      await flush();
      expect(readyCount(layer)).toBe(queued.length);
      layer.dispose();
      for (const bitmap of queued) expect(bitmap.close).toHaveBeenCalledTimes(1);
    });
  });
});
