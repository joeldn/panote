import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
// dependency. GLRenderer is DOM/WebGL-driven throughout its constructor, so
// this builds the minimal fake `document`/canvas/WebGL2-context stand-in for
// exactly what the constructor and dispose() touch, following the same
// approach as ui/info-hotspots.test.ts's fake document, rather than adding
// jsdom as a new devDependency. Rendering itself (uploadTile/render) is out
// of scope here — that's the DOM/GL surface exercised by running the viewer,
// not by assertions about mocks (see this suite's coverage `exclude` note).
describe('GLRenderer', () => {
  function makeFakeGl() {
    const loseContext = vi.fn();
    const extensions: Record<string, unknown> = {
      WEBGL_lose_context: { loseContext },
    };
    const gl = {
      // Constants — distinct arbitrary values, only ever compared for
      // reference equality against themselves within GLRenderer's own code.
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      LINK_STATUS: 4,
      DEPTH_TEST: 5,
      BLEND: 6,
      CULL_FACE: 7,

      getExtension: vi.fn((name: string) => extensions[name] ?? null),
      getParameter: vi.fn(() => 1),

      createShader: vi.fn(() => ({})),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      getShaderInfoLog: vi.fn(() => ''),
      deleteShader: vi.fn(),

      createProgram: vi.fn(() => ({})),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => true),
      getProgramInfoLog: vi.fn(() => ''),
      deleteProgram: vi.fn(),

      getUniformLocation: vi.fn(() => ({})),

      disable: vi.fn(),
      clearColor: vi.fn(),

      deleteBuffer: vi.fn(),
      deleteTexture: vi.fn(),

      MAX_TEXTURE_SIZE: 8,
      createBuffer: vi.fn(() => ({})),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      createTexture: vi.fn(() => ({})),
      bindTexture: vi.fn(),
      texStorage2D: vi.fn(),
      pixelStorei: vi.fn(),
      texSubImage2D: vi.fn(),
      generateMipmap: vi.fn(),
      texParameteri: vi.fn(),
      texParameterf: vi.fn(),
    };
    return { gl, loseContext };
  }

  function makeFakeDocumentAndContainer(gl: unknown) {
    const canvas = {
      style: {} as Record<string, string>,
      width: 0,
      height: 0,
      getContext: vi.fn((type: string) => (type === 'webgl2' ? gl : null)),
      remove: vi.fn(),
    };
    const container = { appendChild: vi.fn() };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    return { canvas, container };
  }

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
    const { gl, loseContext } = makeFakeGl();
    const { container } = makeFakeDocumentAndContainer(gl);
    const renderer = new GLRenderer(container as unknown as HTMLElement);

    expect(loseContext).not.toHaveBeenCalled();
    renderer.dispose();
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  describe('uploadTile', () => {
    function setup() {
      const { gl } = makeFakeGl();
      (gl.getParameter as ReturnType<typeof vi.fn>).mockImplementation((p: unknown) =>
        p === gl.MAX_TEXTURE_SIZE ? 8192 : 1,
      );
      const { container } = makeFakeDocumentAndContainer(gl);
      return { gl, renderer: new GLRenderer(container as unknown as HTMLElement) };
    }

    // A 3×3 vertex grid: more than the 4 vertices of a cube tile quad.
    const grid = () => {
      const pos = new Float32Array(27).map((_, i) => i);
      const uv = new Float32Array(18).map((_, i) => 100 + i);
      const index = new Uint16Array([0, 3, 1, 1, 3, 4, 4, 5, 8]);
      return { pos, uv, index };
    };

    it('reads MAX_TEXTURE_SIZE', () => {
      expect(setup().renderer.maxTextureSize).toBe(8192);
    });

    it('interleaves every vertex of N-vertex geometry', () => {
      const { gl, renderer } = setup();
      const image = { width: 64, height: 32 } as unknown as HTMLCanvasElement;
      renderer.uploadTile(grid(), image);
      const vbo = gl.bufferData.mock.calls[0]![1] as Float32Array;
      expect(vbo).toHaveLength(9 * 5);
      expect([...vbo.slice(40, 45)]).toEqual([24, 25, 26, 116, 117]);
      expect(gl.texStorage2D.mock.calls[0]!.slice(3)).toEqual([64, 32]);
      expect(gl.texSubImage2D.mock.calls[0]![8]).toBe(image);
    });

    it('rejects geometry whose uv and pos disagree on the vertex count', () => {
      const { renderer } = setup();
      const g = { ...grid(), uv: new Float32Array(16) };
      expect(() => renderer.uploadTile(g, {} as ImageBitmap)).toThrow(/vertex counts/);
    });

    it('frees the buffers and texture on removeTile', () => {
      const { gl, renderer } = setup();
      const h = renderer.uploadTile(grid(), { width: 4, height: 4 } as ImageBitmap);
      renderer.removeTile(h);
      expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
      expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    });
  });

  it('does not throw when WEBGL_lose_context is unsupported', () => {
    const { gl } = makeFakeGl();
    (gl.getExtension as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'WEBGL_lose_context' ? null : null,
    );
    const { container } = makeFakeDocumentAndContainer(gl);
    const renderer = new GLRenderer(container as unknown as HTMLElement);
    expect(() => renderer.dispose()).not.toThrow();
  });
});
