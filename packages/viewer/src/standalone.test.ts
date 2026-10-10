import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FACES, type Face } from './cube.js';
import { PanoViewer } from './PanoViewer.js';
import type { CubeTileSource, SourceResolver, TileAddress } from './source.js';

// The viewer with nothing of panote's: no options, sources built here, and
// (for the loadTile cases) no network at all. Same harness as
// PanoViewer.test.ts: GLRenderer is faked, and window, rAF and the observers
// are the minimum the constructor touches.

vi.mock('./render/gl-renderer.js', () => {
  class ContextLostError extends Error {
    override name = 'ContextLostError';
  }
  class FakeGLRenderer {
    canvas = {
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      tabIndex: 0,
      focus: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    };
    nextHandle = 1;
    lost = false;
    dispose = vi.fn();
    uploadTile = vi.fn(() => {
      if (this.lost) throw new ContextLostError();
      return this.nextHandle++;
    });
    removeTile = vi.fn();
    constructor(
      _container: unknown,
      readonly opts: { onContextLost?: () => void; onContextRestored?: () => void } = {},
    ) {}
    resize = vi.fn((w: number, h: number): boolean => {
      this.canvas.width = w * 2;
      this.canvas.height = h * 2;
      return true;
    });
    setCamera(): void {}
    render = vi.fn();
    snapshot = vi.fn(() => null);
    loseContext(): void {
      this.lost = true;
      this.opts.onContextLost?.();
    }
    restoreContext(): void {
      this.lost = false;
      this.opts.onContextRestored?.();
    }
  }
  return { GLRenderer: FakeGLRenderer, ContextLostError };
});

type FakeRenderer = {
  uploadTile: ReturnType<typeof vi.fn>;
  loseContext(): void;
  restoreContext(): void;
};
const rendererOf = (v: PanoViewer) => (v as unknown as { renderer: FakeRenderer }).renderer;

const container = () => ({ clientWidth: 400, clientHeight: 800 }) as unknown as HTMLElement;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let frames: FrameRequestCallback[];
let fetchSpy: ReturnType<typeof vi.fn>;
let decodeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: vi.fn(() => ({ matches: false })),
  });
  frames = [];
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => frames.push(cb)),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  // Any fetch or decode the viewer makes on its own shows up here.
  fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
  decodeSpy = vi.fn(() => Promise.reject(new Error('no decode in this test')));
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('createImageBitmap', decodeSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Run the frames asked for so far, and the ones those ask for, a few rounds deep. */
function runFrames(rounds = 5): void {
  for (let i = 0; i < rounds && frames.length > 0; i++) {
    const due = frames.splice(0);
    for (const cb of due) cb(performance.now());
  }
}

/** A generated source: every tile is a stub image made on the spot. */
function generated(id = 'gen', maxLevel = 2) {
  const images: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const loadTile = vi.fn((_tile: TileAddress, _signal: AbortSignal) => {
    const image = { close: vi.fn() };
    images.push(image);
    return Promise.resolve(image as unknown as ImageBitmap);
  });
  const source: CubeTileSource = { id, tileSize: 256, maxLevel, loadTile };
  return { source, loadTile, images };
}

describe('PanoViewer with no options and a loadTile source', () => {
  it('loads, announces the source and renders, without a single fetch or decode', async () => {
    const { source, loadTile, images } = generated();
    const viewer = new PanoViewer(container());
    const ready = vi.fn();
    const sceneChange = vi.fn();
    const loading = vi.fn();
    viewer.on('ready', ready);
    viewer.on('scene-change', sceneChange);
    viewer.on('loading', loading);

    await expect(viewer.load(source)).resolves.toBe(true);

    expect(loadTile.mock.calls.slice(0, 6).map(([t]) => t)).toEqual(
      FACES.map((face) => ({ face, level: 0, x: 0, y: 0 })),
    );
    expect(rendererOf(viewer).uploadTile).toHaveBeenCalledTimes(6);
    expect(loading).toHaveBeenCalledWith('gen');
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0]![0]).toBe(source);
    expect(sceneChange).toHaveBeenCalledWith('gen');

    // Frames ask for the finer levels through the same loadTile.
    runFrames();
    await flush();
    runFrames();
    expect(loadTile.mock.calls.some(([t]) => t.level > 0)).toBe(true);
    // Every image handed over is released once uploaded.
    const uploads = rendererOf(viewer).uploadTile.mock.calls.length;
    expect(images.filter((i) => i.close.mock.calls.length > 0)).toHaveLength(uploads);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(decodeSpy).not.toHaveBeenCalled();
    viewer.dispose();
  });

  it('crossfades to a source with transitionTo', async () => {
    const a = generated('a');
    const b = generated('b');
    const viewer = new PanoViewer(container());
    const sceneChange = vi.fn();
    viewer.on('scene-change', sceneChange);
    await viewer.load(a.source);
    await viewer.transitionTo(b.source, { yaw: 1 });
    expect(sceneChange.mock.calls).toEqual([['a'], ['b']]);
    expect(viewer.getView().yaw).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    viewer.dispose();
  });

  it('reloads the held source after a context restore, asking it for its base again', async () => {
    const { source, loadTile } = generated();
    const resolveSource = vi.fn<SourceResolver>();
    const viewer = new PanoViewer(container(), { resolveSource });
    await viewer.load(source);
    const before = loadTile.mock.calls.length;

    rendererOf(viewer).loseContext();
    rendererOf(viewer).restoreContext();
    await flush();

    const base = loadTile.mock.calls.slice(before).filter(([t]) => t.level === 0);
    expect(base).toHaveLength(6);
    expect(resolveSource).not.toHaveBeenCalled();
    viewer.dispose();
  });

  it('rejects an id when there is no resolveSource, fetching nothing', async () => {
    const viewer = new PanoViewer(container());
    await expect(viewer.load('pano-a')).rejects.toThrow(/no resolveSource/);
    expect(fetchSpy).not.toHaveBeenCalled();
    viewer.dispose();
  });

  it('rejects a malformed source and keeps the scene on screen', async () => {
    const good = generated('good');
    const viewer = new PanoViewer(container());
    await viewer.load(good.source);
    const layer = (viewer as unknown as { layer: unknown }).layer;
    const bad = { id: 'bad', tileSize: 256, maxLevel: 2 } as CubeTileSource;
    await expect(viewer.load(bad)).rejects.toThrow(TypeError);
    expect((viewer as unknown as { layer: unknown }).layer).toBe(layer);
    viewer.dispose();
  });

  it('reports a failing base tile with the source id', async () => {
    const viewer = new PanoViewer(container());
    const source: CubeTileSource = {
      id: 'broken',
      tileSize: 256,
      maxLevel: 0,
      loadTile: (t) =>
        t.face === 'py'
          ? Promise.reject(Object.assign(new Error('gone'), { name: 'TileHttpError' }))
          : Promise.resolve({ close() {} } as unknown as ImageBitmap),
    };
    // A plain error is transient: three attempts, 1 s then 2 s apart.
    vi.useFakeTimers();
    try {
      const failed = viewer.load(source).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const err = (await failed) as { name: string; sourceId: string; face: Face };
      expect(err.name).toBe('BaseTileLoadError');
      expect(err.sourceId).toBe('broken');
      expect(err.face).toBe('py');
    } finally {
      vi.useRealTimers();
    }
    viewer.dispose();
  });
});

describe('resolveSource', () => {
  it('turns an id into a source with the load signal, and no hints', async () => {
    const { source } = generated('hall');
    const resolveSource = vi.fn<SourceResolver>(() => Promise.resolve(source));
    const viewer = new PanoViewer(container(), { resolveSource });
    const ready = vi.fn();
    viewer.on('ready', ready);
    await expect(viewer.load('hall')).resolves.toBe(true);
    expect(resolveSource).toHaveBeenCalledTimes(1);
    const [id, signal, hints] = resolveSource.mock.calls[0]!;
    expect(id).toBe('hall');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(hints).toBeUndefined();
    expect(ready.mock.calls[0]![0]).toBe(source);
    viewer.dispose();
  });

  it('aborts the resolve of a superseded load', async () => {
    const signals: AbortSignal[] = [];
    const resolveSource = vi.fn<SourceResolver>(
      (_id, signal) =>
        new Promise((_, reject) => {
          signals.push(signal);
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const viewer = new PanoViewer(container(), { resolveSource });
    const first = viewer.load('a');
    const second = viewer.load('b');
    await expect(first).resolves.toBe(false);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    viewer.dispose();
    await expect(second).resolves.toBe(false);
  });
});

describe('prefetch', () => {
  const ok = (body = 'tile') => {
    const res = new Response(body, { status: 200 });
    vi.spyOn(res, 'arrayBuffer');
    return res;
  };

  /** A URL source, fetched through an injected fetch with a request init. */
  function urlViewer(respond: (url: string) => Response | Promise<Response> = () => ok()) {
    const net = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(respond(url)));
    const source: CubeTileSource = {
      id: 'church',
      tileSize: 512,
      maxLevel: 3,
      tileUrl: (t) => `https://cdn.test/church/${t.level}/${t.face}/${t.x}-${t.y}.webp`,
    };
    const resolveSource = vi.fn<SourceResolver>(() => Promise.resolve(source));
    const viewer = new PanoViewer(container(), {
      resolveSource,
      fetch: net as unknown as typeof fetch,
      requestInit: { mode: 'cors', credentials: 'same-origin' },
    });
    return { viewer, net, resolveSource, source };
  }

  it('resolves an id at low priority and warms the six base tiles through the load path', async () => {
    const { viewer, net, resolveSource } = urlViewer();
    const loading = vi.fn();
    viewer.on('loading', loading);

    await viewer.prefetch('church');

    expect(resolveSource).toHaveBeenCalledWith('church', expect.any(AbortSignal), {
      priority: 'low',
    });
    expect(net.mock.calls.map(([url]) => url)).toEqual(
      FACES.map((f) => `https://cdn.test/church/0/${f}/0-0.webp`),
    );
    for (const [, init] of net.mock.calls) {
      expect(init).toEqual({
        mode: 'cors',
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
        priority: 'low',
      });
    }
    // Nothing about the scene changed.
    expect(loading).not.toHaveBeenCalled();
    expect((viewer as unknown as { layer: unknown }).layer).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    viewer.dispose();
  });

  it('reads ok bodies to the end and drops error bodies unread', async () => {
    const responses: Response[] = [];
    const { viewer } = urlViewer((url) => {
      const res = url.includes('/nx/') ? new Response('no', { status: 404 }) : ok();
      if (url.includes('/nx/')) vi.spyOn(res.body!, 'cancel');
      responses.push(res);
      return res;
    });
    await viewer.prefetch('church');
    for (const res of responses) {
      if (res.status === 200) expect(res.arrayBuffer).toHaveBeenCalled();
      else expect(res.body!.cancel).toHaveBeenCalled();
    }
    viewer.dispose();
  });

  it('takes a source directly, and asks a loadTile source for its base', async () => {
    const { source, loadTile, images } = generated();
    const viewer = new PanoViewer(container());
    await viewer.prefetch(source);
    expect(loadTile.mock.calls.map(([t]) => t)).toEqual(
      FACES.map((face) => ({ face, level: 0, x: 0, y: 0 })),
    );
    for (const image of images) expect(image.close).toHaveBeenCalled();
    expect(rendererOf(viewer).uploadTile).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    viewer.dispose();
  });

  it('never rejects', async () => {
    const failing = urlViewer(() => Promise.reject(new TypeError('offline')));
    await expect(failing.viewer.prefetch('church')).resolves.toBeUndefined();
    failing.resolveSource.mockRejectedValueOnce(new Error('manifest 404'));
    await expect(failing.viewer.prefetch('gone')).resolves.toBeUndefined();
    failing.viewer.dispose();

    const bare = new PanoViewer(container());
    await expect(bare.prefetch('church')).resolves.toBeUndefined();
    await expect(
      bare.prefetch({ id: 'bad', tileSize: 0, maxLevel: 0 } as CubeTileSource),
    ).resolves.toBeUndefined();
    bare.dispose();
  });

  it('does nothing for an aborted signal, and aborts what is in flight when it aborts', async () => {
    const signals: AbortSignal[] = [];
    const { viewer, net } = urlViewer();
    net.mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => {
          signals.push(init!.signal!);
          init!.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const done = new AbortController();
    done.abort();
    await viewer.prefetch('church', { signal: done.signal });
    expect(net).not.toHaveBeenCalled();

    const controller = new AbortController();
    const warming = viewer.prefetch('church', { signal: controller.signal });
    await flush();
    expect(signals).toHaveLength(6);
    controller.abort();
    await expect(warming).resolves.toBeUndefined();
    expect(signals.every((s) => s.aborted)).toBe(true);
    viewer.dispose();
  });

  it('is aborted by dispose()', async () => {
    const signals: AbortSignal[] = [];
    const { viewer, net } = urlViewer();
    net.mockImplementation((_url, init) => {
      signals.push(init!.signal!);
      return new Promise(() => {});
    });
    void viewer.prefetch('church');
    await flush();
    expect(signals).toHaveLength(6);
    viewer.dispose();
    expect(signals.every((s) => s.aborted)).toBe(true);
    await viewer.prefetch('church');
    expect(signals).toHaveLength(6);
  });
});
