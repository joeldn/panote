import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { sortDrawList, mipLevels, GLRenderer, type DrawItem } from './gl-renderer.js';

describe('sortDrawList', () => {
  it('orders coarse levels before finer levels (ascending, stable)', () => {
    const list: DrawItem[] = [
      { handle: 1, level: 2 },
      { handle: 2, level: 0 },
      { handle: 3, level: 1 },
      { handle: 4, level: 0 },
    ];
    const sorted = sortDrawList(list);
    expect(sorted.map((d) => d.handle)).toEqual([2, 4, 3, 1]);
  });

  it('is stable for equal levels', () => {
    const list: DrawItem[] = [
      { handle: 10, level: 3 },
      { handle: 11, level: 3 },
      { handle: 12, level: 3 },
    ];
    expect(sortDrawList(list).map((d) => d.handle)).toEqual([10, 11, 12]);
  });

  it('returns [] for an empty list', () => {
    expect(sortDrawList([])).toEqual([]);
  });
});

describe('mipLevels', () => {
  it('is 1 for a 1×1 texture', () => {
    expect(mipLevels(1, 1)).toBe(1);
  });
  it('is 10 for a 512×512 texture', () => {
    expect(mipLevels(512, 512)).toBe(10);
  });
  it('keys off the larger dimension (non-square 512×256 → 10)', () => {
    expect(mipLevels(512, 256)).toBe(10);
  });
});

// This package's vitest config runs under Node, not jsdom (see
// vitest.config.ts) — deliberately, so the package pays for no DOM test
// dependency. GLRenderer is DOM/WebGL-driven throughout, so this builds a
// minimal fake `document`/canvas/WebGL2-context stand-in, following the same
// approach as ui/info-hotspots.test.ts's fake document, rather than adding
// jsdom as a new devDependency. Every GL method is a vi.fn that also appends
// its name to `log`, so tests can count the calls a frame makes.
const GL_CONSTANTS = {
  VERTEX_SHADER: 1,
  FRAGMENT_SHADER: 2,
  COMPILE_STATUS: 3,
  LINK_STATUS: 4,
  DEPTH_TEST: 5,
  BLEND: 6,
  CULL_FACE: 7,
  MAX_TEXTURE_SIZE: 8,
  ARRAY_BUFFER: 9,
  ELEMENT_ARRAY_BUFFER: 10,
  STATIC_DRAW: 11,
  TEXTURE_2D: 12,
  TEXTURE0: 13,
  RGBA: 14,
  RGBA8: 15,
  SRGB8_ALPHA8: 16,
  UNSIGNED_BYTE: 17,
  UNSIGNED_SHORT: 18,
  FLOAT: 19,
  TRIANGLES: 20,
  LESS: 21,
  COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x100,
} as const;

const GL_METHODS = [
  'getExtension',
  'getParameter',
  'createShader',
  'shaderSource',
  'compileShader',
  'getShaderParameter',
  'getShaderInfoLog',
  'deleteShader',
  'createProgram',
  'attachShader',
  'linkProgram',
  'getProgramParameter',
  'getProgramInfoLog',
  'deleteProgram',
  'useProgram',
  'getUniformLocation',
  'uniform1i',
  'uniform1f',
  'uniformMatrix4fv',
  'activeTexture',
  'enable',
  'disable',
  'depthFunc',
  'clearColor',
  'clear',
  'viewport',
  'createBuffer',
  'bindBuffer',
  'bufferData',
  'deleteBuffer',
  'createVertexArray',
  'bindVertexArray',
  'deleteVertexArray',
  'enableVertexAttribArray',
  'vertexAttribPointer',
  'createTexture',
  'bindTexture',
  'texStorage2D',
  'pixelStorei',
  'texSubImage2D',
  'generateMipmap',
  'texParameteri',
  'texParameterf',
  'deleteTexture',
  'drawElements',
] as const;

type FakeGl = typeof GL_CONSTANTS & Record<(typeof GL_METHODS)[number], Mock>;

function makeFakeGl() {
  const log: string[] = [];
  const loseContext = vi.fn();
  const extensions: Record<string, unknown> = { WEBGL_lose_context: { loseContext } };
  let nextId = 1;
  const object = () => ({ id: nextId++ });
  const impls: Partial<Record<(typeof GL_METHODS)[number], (...args: never[]) => unknown>> = {
    getExtension: (name: string) => extensions[name] ?? null,
    getParameter: (p: number) => (p === GL_CONSTANTS.MAX_TEXTURE_SIZE ? 8192 : 1),
    createShader: object,
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: object,
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    getUniformLocation: (_prog: unknown, name: string) => ({ name }),
    createBuffer: object,
    createVertexArray: object,
    createTexture: object,
  };
  const gl: Record<string, unknown> = { ...GL_CONSTANTS };
  for (const name of GL_METHODS) {
    const impl = impls[name] as ((...args: unknown[]) => unknown) | undefined;
    gl[name] = vi.fn((...args: unknown[]) => {
      log.push(name);
      return impl?.(...args);
    });
  }
  return { gl: gl as FakeGl, log, loseContext, extensions };
}

function makeFakeDocumentAndContainer(gl: unknown) {
  const canvas = {
    style: {} as Record<string, string>,
    width: 0,
    height: 0,
    getContext: vi.fn((type: string, _attrs?: unknown) => (type === 'webgl2' ? gl : null)),
    remove: vi.fn(),
  };
  const container = { appendChild: vi.fn() };
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  return { canvas, container };
}

function setup() {
  const fake = makeFakeGl();
  const { canvas, container } = makeFakeDocumentAndContainer(fake.gl);
  const renderer = new GLRenderer(container as unknown as HTMLElement);
  return { ...fake, canvas, renderer };
}

const image = (w = 4, h = 4) => ({ width: w, height: h }) as unknown as HTMLCanvasElement;

// A 3×3 vertex grid: more than the 4 vertices of a cube tile quad.
const grid = () => {
  const pos = new Float32Array(27).map((_, i) => i);
  const uv = new Float32Array(18).map((_, i) => 100 + i);
  const index = new Uint16Array([0, 3, 1, 1, 3, 4, 4, 5, 8]);
  return { pos, uv, index };
};

describe('GLRenderer', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('releases the WebGL context on dispose via WEBGL_lose_context', () => {
    // dispose() must call loseContext(), not just free buffers/textures/
    // program - browsers cap live WebGL contexts per page (commonly 8-16),
    // and freeing GPU memory alone doesn't release a context slot.
    const { renderer, loseContext } = setup();
    expect(loseContext).not.toHaveBeenCalled();
    renderer.dispose();
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('does not throw when WEBGL_lose_context is unsupported', () => {
    const { renderer, extensions } = setup();
    delete extensions['WEBGL_lose_context'];
    expect(() => renderer.dispose()).not.toThrow();
  });

  it('makes the canvas block-level and leaves the cursor to Controls', () => {
    const { canvas } = setup();
    expect(canvas.style['display']).toBe('block');
    expect(canvas.style['cursor']).toBeUndefined();
  });

  it('binds the program and texture unit once, not per frame', () => {
    const { gl, renderer } = setup();
    renderer.resize(100, 50);
    renderer.setCamera(new Float32Array(16));
    const before = gl.useProgram.mock.calls.length;
    renderer.render([]);
    renderer.render([]);
    expect(before).toBe(1);
    expect(gl.useProgram).toHaveBeenCalledTimes(1);
    expect(gl.uniform1i).toHaveBeenCalledTimes(1);
    expect(gl.activeTexture).toHaveBeenCalledTimes(1);
  });

  it('sets the viewport on resize, not per frame', () => {
    const { gl, renderer } = setup();
    renderer.resize(100, 50);
    expect(gl.viewport).toHaveBeenLastCalledWith(0, 0, 100, 50);
    renderer.setCamera(new Float32Array(16));
    renderer.render([]);
    expect(gl.viewport).toHaveBeenCalledTimes(1);
  });

  describe('uploadTile', () => {
    it('reads MAX_TEXTURE_SIZE', () => {
      expect(setup().renderer.maxTextureSize).toBe(8192);
    });

    it('interleaves every vertex of N-vertex geometry', () => {
      const { gl, renderer } = setup();
      const img = image(64, 32);
      renderer.uploadTile(grid(), img);
      const vbo = gl.bufferData.mock.calls[0]![1] as Float32Array;
      expect(vbo).toHaveLength(9 * 5);
      expect([...vbo.slice(40, 45)]).toEqual([24, 25, 26, 116, 117]);
      expect(gl.texStorage2D.mock.calls[0]!.slice(3)).toEqual([64, 32]);
      expect(gl.texSubImage2D.mock.calls[0]![8]).toBe(img);
    });

    it('stores textures as plain RGBA8, not sRGB', () => {
      const { gl, renderer } = setup();
      renderer.uploadTile(grid(), image());
      expect(gl.texStorage2D.mock.calls[0]![2]).toBe(gl.RGBA8);
      expect(gl.pixelStorei).not.toHaveBeenCalled();
    });

    it('rejects geometry whose uv and pos disagree on the vertex count', () => {
      const { renderer } = setup();
      const g = { ...grid(), uv: new Float32Array(16) };
      expect(() => renderer.uploadTile(g, {} as ImageBitmap)).toThrow(/vertex counts/);
    });

    it('frees the buffers and texture on removeTile', () => {
      const { gl, renderer } = setup();
      const h = renderer.uploadTile(grid(), image());
      renderer.removeTile(h);
      expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
      expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    });
  });
});
