/**
 * The harness the PanoViewer.*.test.ts files share. GLRenderer is faked (see
 * fake-gl-renderer.ts; each test file mocks it), and window, rAF and the
 * observers are the minimum the viewer touches. Node, not jsdom: see
 * vitest.config.ts.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { PanoViewer } from '../PanoViewer.js';
import { FACES } from '../cube.js';
import type { CubeTileSource } from '../source.js';
import type { ViewerOptions } from '../types.js';
import {
  FRAME_MS,
  FakeIntersectionObserver,
  FakeRaf,
  FakeResizeObserver,
  flushTasks,
} from './fake-dom.js';

/** The animation frame clock of the test running now (see useViewerGlobals). */
export let raf: FakeRaf;

/**
 * Stub the globals a viewer touches before each test, and restore them after:
 * a window, the rAF clock (`raf`), which performance.now() follows too.
 */
export function useViewerGlobals(): void {
  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: vi.fn(() => ({ matches: false })),
    });
    raf = new FakeRaf();
    vi.stubGlobal('requestAnimationFrame', raf.request);
    vi.stubGlobal('cancelAnimationFrame', raf.cancel);
    // One clock for frames and everything else (the tile layer's grace
    // periods), as rAF timestamps and performance.now() share an origin.
    vi.spyOn(performance, 'now').mockImplementation(() => raf.now);
    FakeResizeObserver.instances = [];
    FakeIntersectionObserver.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

/**
 * Most tests here load by id, against a host laid out like panote's: an id
 * resolves through a manifest at /tiles/<id>/manifest.json, fetched with the
 * load's signal, to a source whose tiles live under the same prefix (and
 * under the version, when the manifest has one). The tests stub fetch for
 * that layout.
 */
export async function manifestResolver(id: string, signal: AbortSignal): Promise<CubeTileSource> {
  const res = await fetch(`/tiles/${id}/manifest.json`, { signal });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  const m = (await res.json()) as {
    pano: string;
    tileSize: number;
    maxLevel: number;
    format?: string;
    version?: string;
  };
  const prefix = `/tiles/${m.pano}/${m.version === undefined ? '' : `${m.version}/`}`;
  return {
    id: m.pano,
    tileSize: m.tileSize,
    maxLevel: m.maxLevel,
    version: m.version,
    meta: m,
    tileUrl: (t) => `${prefix}${t.level}/${t.face}/${t.x}-${t.y}.${m.format ?? 'jpg'}`,
  };
}

/**
 * The viewer under test: a PanoViewer with that resolver unless a test passes
 * its own.
 */
export class TestViewer extends PanoViewer {
  constructor(container: HTMLElement, options: ViewerOptions = {}) {
    super(container, { resolveSource: manifestResolver, ...options });
  }
}

export type Internals = {
  view: { yaw: number; pitch: number; fov: number };
  target: { yaw: number; pitch: number; fov: number };
  momentum: { yaw: number; pitch: number };
  dirty: boolean;
  invalidate: () => void;
  panByPixels: (dx: number, dy: number) => void;
  flick: (vx: number, vy: number) => void;
  stopMomentum: () => void;
  controls: unknown;
  pendingLayers: Set<{ dispose: () => void }>;
  layer: unknown;
  wasPending: boolean;
  renderer: {
    render: ReturnType<typeof vi.fn>;
    canvas: { addEventListener: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
  };
};
export const internals = (viewer: TestViewer) => viewer as unknown as Internals;

/** Ask for a frame, as any change does, and draw it at `t` (default: one frame on). */
export function tick(viewer: TestViewer, t?: number): void {
  internals(viewer).invalidate();
  raf.step(t);
}

/** Run frames `ms` apart until the loop stops asking for them (or give up). */
export function runUntilIdle(ms = FRAME_MS, max = 2000): number {
  let frames = 0;
  while (raf.pending > 0 && frames < max) {
    raf.step(raf.now + ms);
    frames++;
  }
  return frames;
}

/** The listener the viewer's Controls put on the canvas for `type`. */
export function canvasListener(viewer: TestViewer, type: string): (e: unknown) => void {
  const call = internals(viewer).renderer.canvas.addEventListener.mock.calls.find(
    (c) => c[0] === type,
  );
  if (!call) throw new Error(`no ${type} listener`);
  return call[1] as (e: unknown) => void;
}

export function makeContainer(width: number, height: number): HTMLElement {
  return { clientWidth: width, clientHeight: height } as unknown as HTMLElement;
}

const manifestFor = (pano: string) => ({
  pano,
  faceSize: 2048,
  tileSize: 512,
  maxLevel: 2,
  faces: [...FACES],
  quality: 82,
  format: 'jpg',
});

/**
 * Manifests resolve at once unless `holdManifest` matches; tiles answer at
 * once unless `holdTile` matches. A held request waits for release(), and
 * rejects with an AbortError if its signal aborts first.
 */
export function stubNet(
  opts: { holdManifest?: (url: string) => boolean; holdTile?: (url: string) => boolean } = {},
) {
  const held: (() => void)[] = [];
  const signals = new Map<string, AbortSignal | undefined>();
  const body = { ok: true, status: 200, blob: () => Promise.resolve({}) };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      signals.set(url, init?.signal);
      const m = /\/tiles\/([^/]+)\/manifest\.json$/.exec(url);
      const answer = m
        ? { ok: true, status: 200, json: () => Promise.resolve(manifestFor(m[1]!)) }
        : body;
      const hold = m ? opts.holdManifest : opts.holdTile;
      if (!hold?.(url)) return Promise.resolve(answer);
      return new Promise((resolve, reject) => {
        held.push(() => resolve(answer));
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ close: vi.fn() })),
  );
  return {
    release: () => held.splice(0).forEach((r) => r()),
    signalOf: (url: string) => signals.get(url),
  };
}

/** A container and document that can take the transition overlay. */
export function stubOverlayDom() {
  const overlays: { style: Record<string, string>; remove: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('document', {
    createElement: vi.fn(() => {
      const el = { style: {} as Record<string, string>, remove: vi.fn() };
      overlays.push(el);
      return el;
    }),
  });
  const container = {
    clientWidth: 400,
    clientHeight: 800,
    appendChild: vi.fn(),
  } as unknown as HTMLElement;
  return { container, overlays };
}

export function previewSource() {
  const image = () => ({ width: 1026, height: 1024, close: vi.fn() }) as unknown as ImageBitmap;
  return {
    width: 2048,
    height: 1024,
    patches: [
      { x: 0, y: 0, w: 1026, h: 1024, image: image() },
      { x: 1022, y: 0, w: 1026, h: 1024, image: image() },
    ],
  };
}

/** Let `p` finish, stepping frames for its fade. */
export async function finish(p: Promise<unknown>): Promise<void> {
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 50 && !done; i++) {
    await flushTasks();
    raf.step();
  }
  await p;
}
