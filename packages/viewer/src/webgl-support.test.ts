import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWebGL2Supported, WebGLUnavailableError } from './webgl-support.js';

/** A document whose canvases answer getContext('webgl2') with `gl`. */
function stubCanvas(getContext: (type: string) => unknown) {
  vi.stubGlobal('document', { createElement: vi.fn(() => ({ getContext: vi.fn(getContext) })) });
}

describe('isWebGL2Supported', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is true when a canvas gives a WebGL2 context, and frees that context', () => {
    const loseContext = vi.fn();
    const gl = { getExtension: vi.fn(() => ({ loseContext })) };
    stubCanvas((type) => (type === 'webgl2' ? gl : null));
    expect(isWebGL2Supported()).toBe(true);
    expect(gl.getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('is false when the canvas gives no WebGL2 context (blocklisted GPU, disabled)', () => {
    stubCanvas(() => null);
    expect(isWebGL2Supported()).toBe(false);
  });

  it('is false when getContext throws', () => {
    stubCanvas(() => {
      throw new Error('no');
    });
    expect(isWebGL2Supported()).toBe(false);
  });

  it('is false without a document (a worker, a server render)', () => {
    vi.stubGlobal('document', undefined);
    expect(isWebGL2Supported()).toBe(false);
  });
});

describe('WebGLUnavailableError', () => {
  it('is an Error with its own name, for instanceof and logs alike', () => {
    const err = new WebGLUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WebGLUnavailableError');
    expect(err.message).toBe('PanoViewer needs WebGL2, which this browser does not provide.');
  });
});
