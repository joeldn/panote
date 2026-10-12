import { describe, it, expect, vi } from 'vitest';
import { FACES, faceUVToDir, type Face } from './cube.js';
import { TileLayer } from './tile-layer.js';
import { type GLRenderer } from './render/gl-renderer.js';
import { dirFromYawPitch, tileCornersUV } from './test-support/oracles.js';
import {
  useLayerFixture,
  LAYER_DEFAULTS,
  TILE_COOLDOWN_MS,
  ABORT_GRACE_MS,
  FRAME_MS,
  ABORT_AFTER_FRAMES,
  makeSource,
  keyOf,
  drain,
} from './test-support/tile-layer-fixture.js';

describe('TileLayer scheduling', () => {
  const fx = useLayerFixture();
  const { advance, flush, makeLayer, frame, nextFrame, stayAt, withLevel1, readyCount, render } =
    fx;

  describe('scheduling', () => {
    /** Unit direction through the centre of the tile a URL names. */
    function centreDir(url: string): { x: number; y: number; z: number } {
      const m = /\/(\d+)\/(\w+)\/(\d+)-(\d+)\.jpg$/.exec(url)!;
      const corners = tileCornersUV(Number(m[1]), Number(m[3]), Number(m[4]));
      const d = faceUVToDir(
        m[2] as Face,
        (corners[0]!.u + corners[1]!.u) / 2,
        (corners[0]!.v + corners[2]!.v) / 2,
      );
      const len = Math.hypot(d.x, d.y, d.z);
      return { x: d.x / len, y: d.y / len, z: d.z / len };
    }

    function facing(url: string, yaw: number): number {
      const c = centreDir(url);
      const f = dirFromYawPitch(yaw, 0);
      return c.x * f.x + c.y * f.y + c.z * f.z;
    }

    it('requests tiles nearest the centre of the view first', async () => {
      const layer = await withLevel1(makeLayer());
      await render(layer, 0);
      expect(fx.requests.length).toBeGreaterThan(8);
      const dots = fx.requests.map((u) => facing(u, 0));
      for (let i = 1; i < dots.length; i++) expect(dots[i]).toBeLessThanOrEqual(dots[i - 1]!);
      layer.dispose();
    });

    it('never fx.requests a tile behind the camera', async () => {
      const layer = makeLayer();
      for (const yaw of [0, Math.PI / 2, Math.PI]) {
        fx.requests = [];
        await render(layer, yaw);
        expect(fx.requests.length).toBeGreaterThan(0);
        for (const url of fx.requests) expect(facing(url, yaw)).toBeGreaterThan(0);
      }
      layer.dispose();
    });

    it('never has more than maxConcurrent loads open, even while aborted ones are still decoding', async () => {
      // createImageBitmap ignores the abort signal, so a load aborted after
      // its response arrived keeps decoding. Its slot is freed at the abort,
      // which is right: the layer only counts loads it can still cancel.
      const inflight = (l: TileLayer) =>
        (l as unknown as { inflight: Map<string, unknown> }).inflight;
      const decoding = new Set<number>();
      const held: (() => void)[] = [];
      const signals: AbortSignal[] = [];
      let peak = 0;
      let overlapped = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: { signal: AbortSignal }) => {
          fx.requests.push(url);
          const id = signals.push(init.signal) - 1;
          return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ id }) });
        }),
      );
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(
          ({ id }: { id: number }) =>
            new Promise((resolve) => {
              decoding.add(id);
              held.push(() => {
                decoding.delete(id);
                resolve({ close: vi.fn() });
              });
            }),
        ),
      );
      const layer = makeLayer();
      const check = (): void => {
        const live = [...decoding].filter((id) => !signals[id]!.aborted).length;
        overlapped = Math.max(overlapped, decoding.size - live);
        peak = Math.max(peak, inflight(layer).size);
        expect(inflight(layer).size).toBeLessThanOrEqual(8);
        expect(live).toBeLessThanOrEqual(8);
      };
      for (const yaw of [0, Math.PI, 0, Math.PI / 2, 0]) {
        stayAt(layer, yaw);
        await flush();
        check();
        // Release half the decodes, so aborted ones keep overlapping new loads.
        for (const release of held.splice(0, Math.ceil(held.length / 2))) release();
        await flush();
        check();
      }
      expect(peak).toBe(8);
      // Aborted loads really were still decoding next to eight live ones.
      expect(overlapped).toBeGreaterThan(0);
      layer.dispose();
    });
  });

  describe('in-flight ownership', () => {
    /** The layer's private maps, read to check its accounting directly. */
    function internals(layer: TileLayer): {
      cache: Map<string, unknown>;
      inflight: Map<string, unknown>;
    } {
      return layer as unknown as {
        cache: Map<string, unknown>;
        inflight: Map<string, unknown>;
      };
    }

    it('does not leak a texture or lose track of a reload when a tile is aborted mid-decode', async () => {
      const live = new Set<number>();
      let next = 0;
      fx.renderer.uploadTile.mockImplementation(() => {
        live.add(++next);
        return next;
      });
      fx.renderer.removeTile.mockImplementation((handle: number) => {
        live.delete(handle);
      });
      const layer = await withLevel1(makeLayer());
      // Decodes are held until released, so an abort can land between the
      // response arriving and the bitmap being ready: createImageBitmap does
      // not take the abort signal.
      const held: (() => void)[] = [];
      let holding = true;
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(
          () =>
            new Promise((resolve) => {
              const done = (): void => resolve({ close: vi.fn() });
              if (holding) held.push(done);
              else done();
            }),
        ),
      );

      frame(layer, 0);
      await flush();
      const first = [...fx.requests];
      expect(held).toHaveLength(first.length);

      // Pan away while those decode (aborting them), then back, which starts
      // a second load of each one.
      stayAt(layer, Math.PI);
      stayAt(layer, 0);
      await flush();
      for (const url of first) expect(fx.requests.filter((u) => u === url)).toHaveLength(2);

      // The first, aborted round finishes decoding. The reloads are still in
      // flight and must stay tracked as such.
      const firstRound = held.splice(0, first.length);
      for (const release of firstRound) release();
      await flush();
      const { cache, inflight } = internals(layer);
      for (const url of first) expect(inflight.has(keyOf(url))).toBe(true);

      // Then everything else finishes.
      holding = false;
      for (const release of held.splice(0)) release();
      for (let i = 0; i < 5; i++) await flush();

      expect(inflight.size).toBe(0);
      // Every texture the renderer still holds is one the cache can free.
      expect(live.size).toBe(cache.size);
      layer.dispose();
      expect(live.size).toBe(0);
    });
  });

  describe('bitmap lifetime', () => {
    function trackBitmaps(): { close: ReturnType<typeof vi.fn> }[] {
      const bitmaps: { close: ReturnType<typeof vi.fn> }[] = [];
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(() => {
          const bitmap = { close: vi.fn() };
          bitmaps.push(bitmap);
          return Promise.resolve(bitmap);
        }),
      );
      return bitmaps;
    }

    it('closes every decoded bitmap once it is uploaded', async () => {
      const bitmaps = trackBitmaps();
      const layer = makeLayer();
      await render(layer, 0);
      expect(bitmaps.length).toBeGreaterThan(0);
      expect(bitmaps).toHaveLength(fx.renderer.uploadTile.mock.calls.length);
      for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1);
      layer.dispose();
    });

    it('decodes tiles upright, with no flipY', async () => {
      const layer = makeLayer();
      const base = layer.loadBase();
      await render(layer, 0);
      await base;
      const decode = vi.mocked(createImageBitmap);
      expect(decode.mock.calls.length).toBeGreaterThan(FACES.length);
      for (const args of decode.mock.calls) {
        // Upright is the default; any option that flips it is a regression.
        expect(args).toHaveLength(1);
      }
      layer.dispose();
    });

    it('still closes the bitmap when the upload throws', async () => {
      const bitmaps = trackBitmaps();
      fx.renderer.uploadTile.mockImplementation(() => {
        throw new Error('context lost');
      });
      const layer = makeLayer();
      await render(layer, 0);
      expect(bitmaps.length).toBeGreaterThan(0);
      for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1);
      layer.dispose();
    });
  });

  describe('fetch priority and parents', () => {
    /** The `priority` each tile request was made with, in request order. */
    function priorities(): { url: string; priority: unknown }[] {
      return vi
        .mocked(fetch)
        .mock.calls.map(([url, init]) => ({ url: String(url), priority: init?.priority }));
    }

    it('fetches the base at high priority', async () => {
      const layer = makeLayer();
      await layer.loadBase();
      const base = priorities().filter((r) => r.url.includes('/0/'));
      expect(base).toHaveLength(FACES.length);
      for (const r of base) expect(r.priority).toBe('high');
      layer.dispose();
    });

    it('fetches the four tiles nearest the centre at high priority and the rest low', async () => {
      const layer = await withLevel1(makeLayer());
      vi.mocked(fetch).mockClear();
      frame(layer, 0);
      const sent = priorities();
      expect(sent.length).toBe(8);
      expect(sent.map((r) => r.priority)).toEqual([
        'high',
        'high',
        'high',
        'high',
        'low',
        'low',
        'low',
        'low',
      ]);
      layer.dispose();
    });

    it('asks for every tile at the target level before any parent on a first view', async () => {
      // Only level 2 is wanted, nothing finer than the base is resident, and
      // the view needs more tiles than there are request slots.
      const layer = new TileLayer(
        fx.renderer as unknown as GLRenderer,
        makeSource('pano-a'),
        () => {},
        { ...LAYER_DEFAULTS, textureBudgetMB: 128, maxConcurrent: 3, now: () => fx.clock },
      );
      await layer.loadBase();
      fx.requests = [];
      await render(layer, 0);
      for (let i = 0; i < 10 && layer.hasPending(); i++) await render(layer, 0);
      const levels = fx.requests.map((u) => Number(/\/tiles\/[^/]+\/(\d+)\//.exec(u)![1]));
      const { desired } = layer as unknown as { desired: Set<string> };
      expect(levels.length).toBe(desired.size);
      expect(levels.every((l) => l === 2)).toBe(true);
      layer.dispose();
    });

    it('queues the parent of a tile that failed ahead of the tiles still to go', async () => {
      const layer = new TileLayer(
        fx.renderer as unknown as GLRenderer,
        makeSource('pano-a'),
        () => {},
        { ...LAYER_DEFAULTS, textureBudgetMB: 128, maxConcurrent: 1, now: () => fx.clock },
      );
      await layer.loadBase();
      fx.requests = [];
      // The first level-2 tile (the centre one) fails and cools down; the
      // rest never answer.
      let failing: string | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          fx.requests.push(url);
          failing ??= url;
          if (url !== failing) return new Promise(() => {});
          return Promise.resolve({ ok: false, status: 503, blob: () => Promise.resolve({}) });
        }),
      );
      frame(layer, 0);
      await flush();
      frame(layer, 0);
      const { candidates, queueHead } = layer as unknown as {
        candidates: { key: string }[];
        queueHead: number;
      };
      const [, face, xy] = /\/2\/(\w+)\/(\d+-\d+)\.jpg$/.exec(failing!)!;
      const [x, y] = xy!.split('-').map(Number) as [number, number];
      // Next in line for the one slot: the failed tile's parent, then the
      // level-2 tiles nearest the centre. With one slot this view is many
      // rounds, so the edges' parents follow those as their fallback.
      expect(queueHead).toBe(0);
      const failedParent = `1/${face}/${x >> 1}-${y >> 1}`;
      expect(candidates[0]!.key).toBe(failedParent);
      const firstOther = candidates.findIndex((c, i) => i > 0 && c.key.startsWith('1/'));
      expect(firstOther).toBeGreaterThan(1);
      expect(candidates.slice(1, firstOther).every((c) => c.key.startsWith('2/'))).toBe(true);
      expect(candidates.filter((c) => c.key === failedParent)).toHaveLength(1);
      layer.dispose();
    });

    it('fetches the parent of a tile that is missing for good', async () => {
      const layer = makeLayer();
      await layer.loadBase();
      fx.requests = [];
      fx.respond = (url) => (url.endsWith('/2/nz/1-1.jpg') ? { status: 404 } : null);
      await render(layer, 0);
      await render(layer, 0);
      expect(fx.requests).toContain('/tiles/pano-a/1/nz/0-0.jpg');
      expect(fx.requests.filter((u) => u.includes('/1/'))).toHaveLength(1);
      const { cache } = layer as unknown as { cache: Map<string, unknown> };
      expect(cache.has('1/nz/0-0')).toBe(true);
      layer.dispose();
    });

    it('queues each parent once, however many of its children are missing', async () => {
      const layer = makeLayer();
      fx.script = { status: 503 };
      await render(layer, 0); // every level-2 tile fails and cools down
      frame(layer, 0);
      const { candidates } = layer as unknown as { candidates: { key: string }[] };
      const keys = candidates.map((c) => c.key);
      expect(keys.some((k) => k.startsWith('1/'))).toBe(true);
      expect(new Set(keys).size).toBe(keys.length);
      layer.dispose();
    });

    it('keeps a resident parent while it stands in for a missing child', async () => {
      // Slots for every tile in view, so the second frame below has all the
      // children in flight and none still queued.
      const layer = await withLevel1(
        new TileLayer(fx.renderer as unknown as GLRenderer, makeSource('pano-a'), () => {}, {
          ...LAYER_DEFAULTS,
          textureBudgetMB: 128,
          maxConcurrent: 64,
          now: () => fx.clock,
        }),
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {})),
      );
      // Over budget by a few tiles. The level-1 tiles loaded first, the ones
      // facing yaw 0, are the least recently used.
      (layer as unknown as { maxTiles: number }).maxTiles = 20;
      frame(layer, 0);
      const { cache, desired } = layer as unknown as {
        cache: Map<string, unknown>;
        desired: Set<string>;
      };
      expect(cache.size).toBe(20); // four of the 24 went
      expect(desired.size).toBeGreaterThan(0);
      const parentsResident = (): void => {
        for (const key of desired) {
          const [, face, xy] = key.split('/') as [string, string, string];
          const [x, y] = xy.split('-').map(Number) as [number, number];
          expect(cache.has(`1/${face}/${x >> 1}-${y >> 1}`)).toBe(true);
        }
      };
      parentsResident();

      // Next frame the children are in flight rather than queued; their
      // parents still stand in for them, so they are stamped as used again.
      frame(layer, 0);
      const { inflight } = layer as unknown as { inflight: Map<string, unknown> };
      for (const key of desired) expect(inflight.has(key)).toBe(true);
      const frameNo = (layer as unknown as { clock: number }).clock;
      for (const key of desired) {
        const [, face, xy] = key.split('/') as [string, string, string];
        const [x, y] = xy.split('-').map(Number) as [number, number];
        const parent = cache.get(`1/${face}/${x >> 1}-${y >> 1}`) as { lastUsed: number };
        expect(parent.lastUsed).toBe(frameNo);
      }
      layer.dispose();
    });

    it('skips the parents when they are already resident', async () => {
      const layer = await withLevel1(makeLayer());
      await render(layer, 0);
      expect(fx.requests.length).toBeGreaterThan(0);
      for (const u of fx.requests) expect(u).toContain('/2/');
      layer.dispose();
    });
  });

  describe('abort hysteresis', () => {
    /** Fetches that never answer, with each request's signal kept by URL. */
    function holdFetches(): Map<string, AbortSignal> {
      const signals = new Map<string, AbortSignal>();
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: { signal: AbortSignal }) => {
          fx.requests.push(url);
          signals.set(url, init.signal);
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        }),
      );
      return signals;
    }

    it('aborts a load only after it has been out of view for ten 60 Hz frames', async () => {
      const layer = await withLevel1(makeLayer());
      const signals = holdFetches();
      frame(layer, 0);
      const first = [...fx.requests];
      expect(first.length).toBeGreaterThan(0);

      nextFrame(layer, Math.PI); // out for one frame of a pan
      nextFrame(layer, 0);
      for (const url of first) expect(signals.get(url)!.aborted).toBe(false);

      for (let i = 0; i < ABORT_AFTER_FRAMES; i++) nextFrame(layer, Math.PI);
      for (const url of first) expect(signals.get(url)!.aborted).toBe(false);
      nextFrame(layer, Math.PI); // ten frame intervals after the first one out
      for (const url of first) expect(signals.get(url)!.aborted).toBe(true);
      await flush();
      layer.dispose();
    });

    it('counts the grace in time, not frames', async () => {
      const layer = await withLevel1(makeLayer());
      const signals = holdFetches();
      frame(layer, 0);
      const first = [...fx.requests];
      // Two frames, a grace apart: a 30 Hz device, or a frame after a stall.
      frame(layer, Math.PI);
      advance(ABORT_GRACE_MS);
      frame(layer, Math.PI);
      for (const url of first) expect(signals.get(url)!.aborted).toBe(true);
      await flush();
      layer.dispose();
    });

    it('aborts a load left out of view when the frames stop, by waking for it', async () => {
      const invalidate = vi.fn();
      const layer = await withLevel1(makeLayer('pano-a', 128, invalidate));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const signals = holdFetches();
        frame(layer, 0);
        const first = [...fx.requests];
        // One frame of the pan, and the view stops: no frame is coming.
        frame(layer, Math.PI);
        invalidate.mockClear();
        advance(ABORT_GRACE_MS - 1);
        vi.advanceTimersByTime(ABORT_GRACE_MS - 1);
        expect(invalidate).not.toHaveBeenCalled();
        advance(1);
        vi.advanceTimersByTime(1);
        expect(invalidate).toHaveBeenCalledTimes(1);
        // The frame the wake asked for aborts them.
        frame(layer, Math.PI);
        for (const url of first) expect(signals.get(url)!.aborted).toBe(true);
        layer.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('starts the count again when a tile comes back into view', () => {
      const signals = holdFetches();
      const layer = makeLayer();
      frame(layer, 0);
      const first = [...fx.requests];
      for (let i = 0; i < 6; i++) nextFrame(layer, Math.PI);
      nextFrame(layer, 0);
      for (let i = 0; i < 6; i++) nextFrame(layer, Math.PI);
      for (const url of first) expect(signals.get(url)!.aborted).toBe(false);
      layer.dispose();
    });

    it('keeps loading the level below after a zoom-in step', () => {
      const signals = holdFetches();
      const layer = makeLayer();
      frame(layer, 0, 800);
      const coarse = [...fx.requests];
      expect(coarse.length).toBeGreaterThan(0);
      for (const url of coarse) expect(url).toContain('/1/');

      // One level finer: the level-1 tiles are out of the desired set, but
      // they still beat the base as a fallback until level 2 lands.
      for (let i = 0; i <= ABORT_AFTER_FRAMES * 2; i++) {
        advance(FRAME_MS);
        frame(layer, 0, 1600);
      }
      for (const url of coarse) expect(signals.get(url)!.aborted).toBe(false);
      layer.dispose();
    });

    it('does not count loads that are only finishing out of view as pending', async () => {
      const layer = makeLayer();
      await render(layer, Math.PI); // everything behind is resident
      expect(layer.hasPending()).toBe(false);

      frame(layer, 0); // starts loads for the front
      frame(layer, Math.PI); // and turns straight back
      const { inflight } = layer as unknown as { inflight: Map<string, unknown> };
      expect(inflight.size).toBeGreaterThan(0);
      expect(layer.hasPending()).toBe(false);

      await flush(); // they land, decoded, while still out of view
      expect(readyCount(layer)).toBeGreaterThan(0);
      expect(layer.hasPending()).toBe(false);
      layer.dispose();
    });

    it('aborts the finer level after a zoom-out step', () => {
      const signals = holdFetches();
      const layer = makeLayer();
      frame(layer, 0, 1600);
      const fine = fx.requests.filter((u) => u.includes('/2/'));
      expect(fine.length).toBeGreaterThan(0);
      for (let i = 0; i <= ABORT_AFTER_FRAMES; i++) {
        advance(FRAME_MS);
        frame(layer, 0, 800);
      }
      for (const url of fine) expect(signals.get(url)!.aborted).toBe(true);
      layer.dispose();
    });
  });

  describe('coarse fallback', () => {
    it('keeps drawing the base where a deeper tile is missing, instead of nothing', async () => {
      const layer = makeLayer();
      await layer.loadBase();
      const base = new Set(layer.drawList().map((d) => d.handle));
      expect(base.size).toBe(FACES.length);

      // Every tile below the base is gone for good — the worst case this whole
      // change exists for.
      fx.respond = (url) => (url.includes('/0/') ? { status: 200 } : { status: 404 });
      await render(layer, 0);

      const list = layer.drawList();
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((d) => d.handle))).toEqual(base);
      expect(list.every((d) => d.level === 0)).toBe(true);
    });

    it('refines the base with deeper levels rather than replacing it', async () => {
      const layer = makeLayer();
      await layer.loadBase();
      await render(layer, 0);

      const list = layer.drawList();
      expect(list.some((d) => d.level === 0)).toBe(true);
      expect(list.some((d) => d.level > 0)).toBe(true);
      // Painter's order: the base paints first and the finer levels over it, so
      // a hole at any deeper level shows soft base texels, never the clear
      // colour.
      const levels = list.map((d) => d.level).sort((a, b) => a - b);
      expect(levels[0]).toBe(0);
      expect(levels[levels.length - 1]).toBeGreaterThan(0);
    });

    it('hands out the same draw items every frame instead of allocating new ones', async () => {
      const layer = makeLayer();
      await layer.loadBase();
      await render(layer, 0);
      const first = [...layer.drawList()];
      frame(layer, 0);
      const second = layer.drawList();
      expect(second).toHaveLength(first.length);
      for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]);
      layer.dispose();
    });

    it('never evicts the base, however much finer detail is loaded', async () => {
      // A budget small enough that a full sweep at maximum detail overflows it
      // — the whole pyramid at maxLevel 2 fits inside the default one.
      const layer = makeLayer('pano-a', 1);
      await layer.loadBase();
      const base = new Set(layer.drawList().map((d) => d.handle));

      // Sweep the whole sphere at full detail to push the cache past budget.
      for (let i = 0; i < 8; i++) await render(layer, (i * Math.PI) / 4);

      expect(fx.renderer.removeTile).toHaveBeenCalled();
      const drawn = new Set(layer.drawList().map((d) => d.handle));
      for (const handle of base) expect(drawn.has(handle)).toBe(true);
    });
  });

  describe('queue upkeep', () => {
    it('closes a bitmap whose load was aborted mid-decode instead of queueing it', async () => {
      const layer = await withLevel1(makeLayer());
      const held: { url: string; release: () => void; close: ReturnType<typeof vi.fn> }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          fx.requests.push(url);
          return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ url }) });
        }),
      );
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(
          ({ url }: { url: string }) =>
            new Promise((resolve) => {
              const bitmap = { close: vi.fn() };
              held.push({ url, release: () => resolve(bitmap), close: bitmap.close });
            }),
        ),
      );
      frame(layer, 0);
      await flush();
      const first = held.splice(0);
      expect(first.length).toBeGreaterThan(0);
      stayAt(layer, Math.PI); // out of view long enough to be aborted
      for (const { release } of first) release();
      await flush();
      for (const { url, close } of first) {
        expect(close).toHaveBeenCalledTimes(1);
        expect((layer as unknown as { ready: Map<string, unknown> }).ready.has(keyOf(url))).toBe(
          false,
        );
      }
      layer.dispose();
    });

    it('asks for another frame while only unwanted bitmaps wait in the queue', async () => {
      const invalidate = vi.fn();
      const layer = await withLevel1(makeLayer('pano-a', 128, invalidate));
      const held: (() => void)[] = [];
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(() => new Promise((resolve) => held.push(() => resolve({ close: vi.fn() })))),
      );
      frame(layer, 0);
      await flush();
      for (const release of held.splice(0)) release();
      await flush();
      expect(readyCount(layer)).toBeGreaterThan(0);

      // Turned away: nothing queued is wanted, and nothing goes up, but the
      // queue still needs frames to age out and be dropped.
      invalidate.mockClear();
      frame(layer, Math.PI);
      expect(fx.renderer.uploadTile).not.toHaveBeenCalled();
      expect(readyCount(layer)).toBeGreaterThan(0);
      expect(invalidate).toHaveBeenCalled();
      layer.dispose();
    });

    it('wakes when a parent cooling down after a failure may go again', async () => {
      const invalidate = vi.fn();
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          fx.requests.push(url);
          // The level-2 tiles are missing for good, so their parents are
          // fetched and wake nothing of their own; the parents fail once.
          const status = url.includes('/1/') ? 503 : 404;
          return Promise.resolve({ ok: false, status, blob: () => Promise.resolve({}) });
        }),
      );
      const layer = makeLayer('pano-a', 128, invalidate);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        frame(layer, 0);
        await drain();
        frame(layer, 0); // the level-2 tiles are gone: their parents go
        await drain();
        expect(fx.requests.some((u) => u.includes('/1/'))).toBe(true);
        frame(layer, 0); // the parents are cooling down now
        invalidate.mockClear();
        advance(TILE_COOLDOWN_MS);
        await vi.advanceTimersByTimeAsync(TILE_COOLDOWN_MS);
        expect(invalidate).toHaveBeenCalled();
        layer.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('fetches no parents on a steady pan', async () => {
      const layer = makeLayer();
      await layer.loadBase();
      await render(layer, 0);
      fx.requests = [];
      for (let yaw = 0.05; yaw < 1.5; yaw += 0.05) await render(layer, yaw);
      const byLevel = [0, 1, 2].map((l) => fx.requests.filter((u) => u.includes(`/${l}/`)).length);
      expect(byLevel[2]).toBeGreaterThan(0);
      expect(byLevel[1]).toBe(0);
      layer.dispose();
    });

    it('starts no fx.requests while paused, and catches up when resumed', async () => {
      const layer = makeLayer();
      layer.setPaused(true);
      frame(layer, 0);
      await flush();
      expect(fx.requests).toEqual([]);
      expect(layer.hasPending()).toBe(true);
      layer.setPaused(false);
      expect(fx.requests).toHaveLength(8);
      layer.dispose();
    });
  });
});
