/**
 * A stand-in for render/gl-renderer.js, so a PanoViewer can be built under
 * Node with no WebGL2 context. Swap it in with
 *
 *   vi.mock('./render/gl-renderer.js', () => import('./test-support/fake-gl-renderer.js'));
 *
 * GLRenderer itself is tested against a fake WebGL2 context in
 * render/gl-renderer.test.ts.
 */
import { vi } from 'vitest';

export class ContextLostError extends Error {
  override name = 'ContextLostError';
}

export class GLRenderer {
  // The listener, style and attribute surface Controls and the viewer touch.
  canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    tabIndex: 0,
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    focus: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
  nextHandle = 1;
  maxTextureSize = 16384;
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
  /**
   * The backbuffer at the window's devicePixelRatio, or 2 when the stubbed
   * window has none. Simpler than the real resize(), which also caps it by
   * maxPixelRatio and maxPixels. Like it, says whether anything changed.
   */
  resize = vi.fn((w: number, h: number): boolean => {
    const dpr = (globalThis as { window?: { devicePixelRatio?: number } }).window?.devicePixelRatio;
    const bw = Math.round(w * (dpr ?? 2));
    const bh = Math.round(h * (dpr ?? 2));
    if (bw === this.canvas.width && bh === this.canvas.height) return false;
    this.canvas.width = bw;
    this.canvas.height = bh;
    return true;
  });
  setCamera(): void {}
  render = vi.fn();
  /** A canvas from the stubbed document, or null (no snapshot) without one. */
  snapshot = vi.fn((): unknown =>
    typeof document === 'undefined' ? null : document.createElement('canvas'),
  );
  /** Stand-ins for the browser's webglcontextlost and webglcontextrestored. */
  loseContext(): void {
    this.lost = true;
    this.opts.onContextLost?.();
  }
  restoreContext(): void {
    this.lost = false;
    this.opts.onContextRestored?.();
  }
}
