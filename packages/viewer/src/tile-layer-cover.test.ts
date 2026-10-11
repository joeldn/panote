import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TileLayer } from './tile-layer.js';
import type { CubeTileSource, TileAddress } from './source.js';
import { viewProjection } from './render/projection.js';
import { dirFromYawPitch } from './project.js';
import { ContextLostError, type DrawItem, type GLRenderer } from './render/gl-renderer.js';
import { TileHttpError } from './tile-retry.js';
import { VIEWER_DEFAULTS } from './defaults.js';

/** The resolved defaults a viewer hands every layer it builds. */
const LAYER_DEFAULTS = {
  maxConcurrent: VIEWER_DEFAULTS.network.maxConcurrent,
  minResidentTiles: VIEWER_DEFAULTS.memory.minResidentTiles,
  lodBias: VIEWER_DEFAULTS.rendering.lodBias,
  retry: VIEWER_DEFAULTS.network.retry,
};

// A coarse tile whose every visible part is under resident finer tiles is
// left out of the draw list. The picture must stay exactly what drawing every
// resident level gave: wherever the view looks, the finest resident tile there
// is drawn. These tests check that after every frame, through partial loads,
// failures, evictions, uploads still queued and a lost context.

type Behaviour = 'ok' | 'hold' | 'missing';

const FRAME_MS = 1000 / 60;

interface Entry {
  key: string;
  level: number;
  item: DrawItem;
}

interface Internals {
  cache: Map<string, Entry>;
  desired: Set<string>;
  ready: Map<string, unknown>;
  maxTiles: number;
}

const internals = (layer: TileLayer): Internals => layer as unknown as Internals;

const parentKey = (key: string): string | undefined => {
  const [l, face, xy] = key.split('/') as [string, string, string];
  const level = Number(l);
  if (level === 0) return undefined;
  const [x, y] = xy.split('-').map(Number) as [number, number];
  return `${level - 1}/${face}/${x >> 1}-${y >> 1}`;
};

function drawnKeys(layer: TileLayer): Set<string> {
  const byItem = new Map<DrawItem, string>();
  for (const e of internals(layer).cache.values()) byItem.set(e.item, e.key);
  return new Set(layer.drawList().map((item) => byItem.get(item)!));
}

/**
 * The picture is unchanged: for every tile in view at the target level, the
 * finest resident tile over it (itself, or its nearest resident ancestor) is
 * drawn. Returns the number of tiles left out.
 */
function expectFinestDrawn(layer: TileLayer): number {
  const { cache, desired } = internals(layer);
  const drawn = drawnKeys(layer);
  // Runs after every frame, so it checks in plain code and only reaches for
  // expect() on a miss: an expect() and a message per tile per frame was most
  // of the time the random walks and the pan took.
  for (const key of desired) {
    let k: string | undefined = key;
    while (k !== undefined && !cache.has(k)) k = parentKey(k);
    if (k === undefined) expect.fail(`nothing resident over ${key}`);
    if (!drawn.has(k)) expect.fail(`${k} is the finest resident tile over ${key} but is not drawn`);
  }
  // The base is the floor under every seam: always drawn.
  for (const e of cache.values()) {
    if (e.level === 0 && !drawn.has(e.key)) expect.fail(`base tile ${e.key} is not drawn`);
  }
  let skipped = 0;
  for (const e of cache.values()) if (!drawn.has(e.key)) skipped++;
  return skipped;
}

describe('TileLayer: coarse tiles covered by finer ones', () => {
  let clock: number;
  let behave: (t: TileAddress) => Behaviour;
  let held: (() => void)[];
  let uploadMs: number;
  let uploadThrows: ((key: string) => Error | undefined) | undefined;
  let renderer: { uploadTile: ReturnType<typeof vi.fn>; removeTile: ReturnType<typeof vi.fn> };

  // setImmediate, not setTimeout(0): it runs once the microtasks (every
  // load here settles in one) are drained, without the 1 ms timer floor that
  // made a 900-frame test spend most of its time asleep.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  };

  function makeLayer(maxConcurrent = 64, maxLevel = 3): TileLayer {
    const source: CubeTileSource = {
      id: 'pano',
      tileSize: 512,
      maxLevel,
      loadTile: (t, { signal }) =>
        new Promise((resolve, reject) => {
          const b = behave(t);
          const bitmap = { width: 512, height: 512, close: vi.fn(), key: tileId(t) };
          if (b === 'missing') reject(new TileHttpError(404));
          else if (b === 'ok') resolve(bitmap as unknown as ImageBitmap);
          else held.push(() => resolve(bitmap as unknown as ImageBitmap));
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    };
    return new TileLayer(renderer as unknown as GLRenderer, source, () => {}, {
      ...LAYER_DEFAULTS,
      textureBudgetMB: 512,
      maxConcurrent,
      now: () => clock,
      sleep: () => Promise.resolve(),
    });
  }

  const tileId = (t: TileAddress): string => `${t.level}/${t.face}/${t.x}-${t.y}`;

  /** A frame: 800 px tall selects level 1, and each doubling one level finer. */
  function frame(layer: TileLayer, yaw: number, height = 1600, pitch = 0): void {
    clock += FRAME_MS;
    const view = { yaw, pitch, fov: 70 };
    layer.update(viewProjection(view, 1, 100), 70, dirFromYawPitch(yaw, pitch), height);
  }

  /** Frames at one view until nothing more lands, checking the picture after each. */
  async function settle(layer: TileLayer, yaw: number, height = 1600, pitch = 0): Promise<void> {
    for (let i = 0; i < 60; i++) {
      frame(layer, yaw, height, pitch);
      expectFinestDrawn(layer);
      await flush();
    }
  }

  beforeEach(() => {
    clock = 1_000_000;
    behave = () => 'ok';
    held = [];
    uploadMs = 0;
    uploadThrows = undefined;
    let next = 1;
    renderer = {
      uploadTile: vi.fn((_geom: unknown, bitmap: { key: string }) => {
        clock += uploadMs;
        const err = uploadThrows?.(bitmap.key);
        if (err) throw err;
        return next++;
      }),
      removeTile: vi.fn(),
    };
  });

  it('leaves out the coarse tiles that finer resident tiles hide, but never the base', async () => {
    const layer = makeLayer();
    await layer.loadBase();
    await settle(layer, 0, 800); // level 1 in view
    await settle(layer, 0, 1600); // then level 2 over it
    const { cache, desired } = internals(layer);
    const drawn = drawnKeys(layer);
    // Every level-1 tile over the view has all its visible children: hidden.
    const parents = new Set([...desired].map((k) => parentKey(k)!));
    expect(parents.size).toBeGreaterThan(0);
    for (const p of parents) {
      expect(cache.has(p)).toBe(true);
      expect(drawn.has(p)).toBe(false);
    }
    for (const k of desired) expect(drawn.has(k)).toBe(true);
    expect(expectFinestDrawn(layer)).toBeGreaterThanOrEqual(parents.size);
    layer.dispose();
  });

  it('keeps drawing a parent while one of its children is missing for good', async () => {
    const layer = makeLayer();
    await layer.loadBase();
    await settle(layer, 0, 800);
    let hole: string | undefined;
    behave = (t) => {
      if (t.level !== 2) return 'ok';
      hole ??= tileId(t); // the first level-2 tile asked for: the one at the centre
      return tileId(t) === hole ? 'missing' : 'ok';
    };
    await settle(layer, 0, 1600);
    const drawn = drawnKeys(layer);
    expect(hole).toBeDefined();
    expect(internals(layer).cache.has(hole!)).toBe(false);
    expect(drawn.has(parentKey(hole!)!)).toBe(true);
    // Its siblings' parents are hidden as usual.
    const others = [...internals(layer).desired]
      .map((k) => parentKey(k)!)
      .filter((p) => p !== parentKey(hole!));
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) expect(drawn.has(p)).toBe(false);
    layer.dispose();
  });

  it('keeps drawing a parent while a child is decoded but not yet uploaded', async () => {
    const layer = makeLayer();
    await layer.loadBase();
    await settle(layer, 0, 800);
    // Each upload takes the whole frame's budget: one goes up per frame.
    uploadMs = 10;
    frame(layer, 0, 1600);
    await flush();
    frame(layer, 0, 1600);
    const { ready } = internals(layer);
    expect(ready.size).toBeGreaterThan(0);
    const drawn = drawnKeys(layer);
    for (const key of ready.keys()) expect(drawn.has(parentKey(key)!)).toBe(true);
    expectFinestDrawn(layer);
    layer.dispose();
  });

  it('draws the parent again when its child is evicted during a pan', async () => {
    const layer = makeLayer();
    await layer.loadBase();
    await settle(layer, 0, 800);
    await settle(layer, 0, 1600);
    const before = [...internals(layer).desired];
    // A budget only a little over one view: panning round evicts the tiles behind.
    internals(layer).maxTiles = 40;
    for (let yaw = 0; yaw <= Math.PI; yaw += 0.25) await settle(layer, yaw, 1600);
    // Coming back, the requests hang: the evicted children are not back yet.
    behave = () => 'hold';
    for (let yaw = Math.PI; yaw >= 0; yaw -= 0.25) {
      frame(layer, yaw, 1600);
      expectFinestDrawn(layer);
      await flush();
    }
    frame(layer, 0, 1600);
    const { cache } = internals(layer);
    const evicted = before.filter((k) => !cache.has(k));
    expect(evicted.length).toBeGreaterThan(0);
    const drawn = drawnKeys(layer);
    for (const k of evicted) {
      let a = parentKey(k);
      while (a !== undefined && !cache.has(a)) a = parentKey(a);
      expect(drawn.has(a!)).toBe(true);
    }
    expectFinestDrawn(layer);
    layer.dispose();
  });

  it('keeps the parents drawn when the context is lost under the children', async () => {
    const layer = makeLayer();
    await layer.loadBase();
    await settle(layer, 0, 800);
    uploadThrows = (key) => (key.startsWith('2/') ? new ContextLostError() : undefined);
    await settle(layer, 0, 1600);
    const { cache, desired } = internals(layer);
    for (const k of desired) expect(cache.has(k)).toBe(false);
    const drawn = drawnKeys(layer);
    for (const k of desired) expect(drawn.has(parentKey(k)!)).toBe(true);
    // Back: the children go up, and only then do the parents step aside.
    uploadThrows = undefined;
    await settle(layer, 0, 1600);
    const after = drawnKeys(layer);
    for (const k of desired) expect(after.has(parentKey(k)!)).toBe(false);
    layer.dispose();
  });

  it('evicts before it works out what is covered, so an evicted tile uncovers its parent', async () => {
    const layer = makeLayer(64, 5);
    await layer.loadBase();
    await settle(layer, 0, 800);
    await settle(layer, 0, 1600);
    // Level 3 to the sides and behind: a cache bigger than the level-4 view,
    // so the budget below has something to evict.
    for (const yaw of [Math.PI / 2, Math.PI, -Math.PI / 2]) await settle(layer, yaw, 3200);
    // Level 4 in view, nothing of it or of level 3 arriving: the finest
    // resident tile over each is a level-2 one, which hides level 1.
    behave = () => 'hold';
    frame(layer, 0, 6400);
    expectFinestDrawn(layer);
    const { cache, desired } = internals(layer);
    const level2 = [...cache.values()].filter((e) => e.level === 2);
    const inView = level2.find((e) =>
      [...desired].some((k) => parentKey(parentKey(k)!) === e.key),
    ) as (Entry & { lastUsed: number }) | undefined;
    expect(inView).toBeDefined();
    // It is the oldest, and the budget is one short: the next frame evicts
    // it. Covering first would hide its level-1 parent over a tile that is
    // then gone.
    for (const e of cache.values()) (e as Entry & { lastUsed: number }).lastUsed += 1;
    inView!.lastUsed = 0;
    internals(layer).maxTiles = cache.size - 1;
    expect(internals(layer).maxTiles).toBeGreaterThan(desired.size + 6);
    frame(layer, 0, 6400);
    expect(cache.has(inView!.key)).toBe(false);
    expectFinestDrawn(layer);
    expect(drawnKeys(layer).has(parentKey(inView!.key)!)).toBe(true);
    layer.dispose();
  });

  it('shows the finest resident tile at every level down to 5 through a random walk', async () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const layer = makeLayer(8, 5);
    await layer.loadBase();
    internals(layer).maxTiles = 80;
    behave = () => {
      const r = random();
      return r < 0.1 ? 'missing' : r < 0.4 ? 'hold' : 'ok';
    };
    let yaw = 0;
    let pitch = 0;
    for (let i = 0; i < 200; i++) {
      yaw += (random() - 0.5) * 0.4;
      pitch = Math.max(-1.4, Math.min(1.4, pitch + (random() - 0.5) * 0.3));
      const height = [800, 1600, 3200, 6400, 12800][Math.floor(random() * 5)]!;
      uploadMs = random() < 0.3 ? 5 : 0;
      frame(layer, yaw, height, pitch);
      expectFinestDrawn(layer);
      for (const release of held.splice(0, Math.floor(random() * held.length))) release();
      await flush();
    }
    layer.dispose();
  }, 30_000);

  it('shows the finest resident tile everywhere through a random walk', async () => {
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const layer = makeLayer(6);
    await layer.loadBase();
    internals(layer).maxTiles = 60;
    behave = () => {
      const r = random();
      return r < 0.1 ? 'missing' : r < 0.4 ? 'hold' : 'ok';
    };
    let yaw = 0;
    let pitch = 0;
    for (let i = 0; i < 400; i++) {
      yaw += (random() - 0.5) * 0.6;
      pitch = Math.max(-1.4, Math.min(1.4, pitch + (random() - 0.5) * 0.4));
      const height = [800, 1600, 3200][Math.floor(random() * 3)]!;
      uploadMs = random() < 0.3 ? 5 : 0;
      frame(layer, yaw, height, pitch);
      expectFinestDrawn(layer);
      // Release some held loads.
      for (const release of held.splice(0, Math.floor(random() * held.length))) release();
      await flush();
    }
    layer.dispose();
  });
});
