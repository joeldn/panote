/**
 * Thrown by `new PanoViewer()` when the browser gives no WebGL2 context:
 * too old, WebGL disabled, or a blocklisted GPU. A host catches it to show
 * a fallback instead of a viewer.
 */
export class WebGLUnavailableError extends Error {
  override name = 'WebGLUnavailableError';

  constructor() {
    super('PanoViewer needs WebGL2, which this browser does not provide.');
  }
}

/**
 * Whether this browser can run a viewer, checked by asking a throwaway canvas
 * for a WebGL2 context (feature detection alone misses a blocklisted GPU).
 * The context is released at once. `new PanoViewer()` throws
 * `WebGLUnavailableError` where this is false.
 */
export function isWebGL2Supported(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
