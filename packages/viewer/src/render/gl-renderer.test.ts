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
    // Regression test: dispose() previously deleted buffers/textures/the
    // program but never released the context slot itself. Browsers cap live
    // WebGL contexts per page (commonly 8-16); without loseContext(), an app
    // that creates and destroys several PanoViewer instances (a gallery,
    // route changes) can exhaust that pool even though GPU memory was freed.
    const { gl, loseContext } = makeFakeGl();
    const { container } = makeFakeDocumentAndContainer(gl);
    const renderer = new GLRenderer(container as unknown as HTMLElement);

    expect(loseContext).not.toHaveBeenCalled();
    renderer.dispose();
    expect(loseContext).toHaveBeenCalledTimes(1);
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
