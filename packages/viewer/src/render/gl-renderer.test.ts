import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Face } from '@panote/core';
import {
  boundingSphere,
  sortDrawList,
  mipLevels,
  GLRenderer,
  ContextLostError,
  type DrawItem,
} from './gl-renderer.js';
import { viewProjection } from './projection.js';
import { buildTileGeometry } from '../tile-geometry.js';

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

describe('boundingSphere', () => {
  it('centres on the vertex centroid and reaches the farthest vertex', () => {
    const s = boundingSphere(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0]));
    expect(s).toEqual({ cx: 1, cy: 1, cz: 0, r: Math.SQRT2 });
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
  'isContextLost',
] as const;

type FakeGl = typeof GL_CONSTANTS & Record<(typeof GL_METHODS)[number], Mock> & { __log: string[] };

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
    isContextLost: () => false,
  };
  const gl: Record<string, unknown> = { ...GL_CONSTANTS };
  for (const name of GL_METHODS) {
    const impl = impls[name] as ((...args: unknown[]) => unknown) | undefined;
    gl[name] = vi.fn((...args: unknown[]) => {
      log.push(name);
      return impl?.(...args);
    });
  }
  gl['__log'] = log;
  return { gl: gl as FakeGl, log, loseContext, extensions };
}

type Listener = (e: { preventDefault: () => void }) => void;

function makeFakeDocumentAndContainer(gl: unknown) {
  const listeners = new Map<string, Set<Listener>>();
  // Every write to width and height, which reallocates the drawing buffer.
  const sizeWrites: string[] = [];
  let width = 0;
  let height = 0;
  const canvas = {
    style: {} as Record<string, string>,
    get width() {
      return width;
    },
    set width(v: number) {
      sizeWrites.push('width');
      width = v;
    },
    get height() {
      return height;
    },
    set height(v: number) {
      sizeWrites.push('height');
      height = v;
    },
    getContext: vi.fn((type: string, _attrs?: unknown) => (type === 'webgl2' ? gl : null)),
    remove: vi.fn(),
    toDataURL: vi.fn(() => 'data:image/png;base64,'),
    addEventListener: vi.fn((type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    }),
  };
  /** Dispatch `type` at the canvas; true when a listener called preventDefault. */
  const fire = (type: string): boolean => {
    let prevented = false;
    const e = { preventDefault: () => (prevented = true) };
    for (const fn of listeners.get(type) ?? []) fn(e);
    return prevented;
  };
  // 2D canvases snapshot() creates, each with its drawImage calls.
  const copies: {
    width: number;
    height: number;
    drawImage: Mock;
    toDataURL: Mock;
  }[] = [];
  const container = { appendChild: vi.fn() };
  let created = false;
  vi.stubGlobal('document', {
    createElement: vi.fn(() => {
      if (copies.length === 0 && !created) {
        created = true;
        return canvas;
      }
      const drawImage = vi.fn();
      const copy = {
        width: 0,
        height: 0,
        drawImage,
        toDataURL: vi.fn(),
        getContext: vi.fn((type: string) => (type === '2d' ? { drawImage } : null)),
      };
      copies.push(copy);
      return copy;
    }),
  });
  return { canvas, container, fire, sizeWrites, copies };
}

function setup(opts: ConstructorParameters<typeof GLRenderer>[1] = {}) {
  const fake = makeFakeGl();
  const dom = makeFakeDocumentAndContainer(fake.gl);
  // The real WEBGL_lose_context dispatches the loss at the canvas.
  fake.loseContext.mockImplementation(() => dom.fire('webglcontextlost'));
  const renderer = new GLRenderer(dom.container as unknown as HTMLElement, opts);
  return { ...fake, ...dom, renderer };
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
    const calls = gl.viewport.mock.calls.length;
    renderer.setCamera(new Float32Array(16));
    renderer.render([]);
    expect(gl.viewport).toHaveBeenCalledTimes(calls);
  });

  describe('resize', () => {
    const dpr = (ratio: number) => vi.stubGlobal('window', { devicePixelRatio: ratio });

    it('keeps a 5K screen at DPR 2 within maxPixels', () => {
      dpr(2);
      const { canvas, renderer } = setup();
      renderer.resize(2560, 1440);
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(8_300_000);
      expect(canvas.width * canvas.height).toBeGreaterThan(8_000_000);
      // Lowered evenly, not clipped: same aspect, still sharper than DPR 1.
      expect(canvas.width / canvas.height).toBeCloseTo(2560 / 1440, 2);
      expect(canvas.width).toBeGreaterThan(2560);
      expect(canvas.style['width']).toBe('2560px');
    });

    it("leaves a 14-inch MacBook's default scaling at DPR 2 at the full ratio", () => {
      dpr(2);
      const { canvas, renderer } = setup();
      renderer.resize(1512, 982);
      expect([canvas.width, canvas.height]).toEqual([3024, 1964]);
    });

    it('leaves a phone at DPR 2 at the full ratio', () => {
      dpr(2);
      const { canvas, renderer } = setup();
      renderer.resize(390, 844);
      expect([canvas.width, canvas.height]).toEqual([780, 1688]);
    });

    it('takes maxPixels as an option', () => {
      dpr(1);
      const { canvas, renderer } = setup({ maxPixels: 10_000 });
      renderer.resize(200, 200);
      expect([canvas.width, canvas.height]).toEqual([100, 100]);
    });

    it('writes nothing when neither the size nor the pixel ratio changed', () => {
      dpr(2);
      const { renderer, sizeWrites, gl } = setup();
      expect(renderer.resize(100, 50)).toBe(true);
      const writes = sizeWrites.length;
      const viewports = gl.viewport.mock.calls.length;
      expect(renderer.resize(100, 50)).toBe(false);
      expect(sizeWrites).toHaveLength(writes);
      expect(gl.viewport).toHaveBeenCalledTimes(viewports);
    });

    it('resizes the backbuffer when only the pixel ratio changed', () => {
      dpr(2);
      const { canvas, renderer } = setup();
      renderer.resize(100, 50);
      dpr(1);
      expect(renderer.resize(100, 50)).toBe(true);
      expect([canvas.width, canvas.height]).toEqual([100, 50]);
    });
  });

  describe('snapshot', () => {
    it('copies the frame into a 2D canvas without encoding it', () => {
      const { canvas, renderer, copies, gl } = setup();
      renderer.resize(100, 50);
      renderer.setCamera(new Float32Array(16));
      gl.clear.mockClear();
      const snap = renderer.snapshot([]);
      expect(copies).toHaveLength(1);
      expect(snap).toBe(copies[0]);
      expect([copies[0]!.width, copies[0]!.height]).toEqual([100, 50]);
      // Rendered first, then copied in the same call.
      expect(gl.clear).toHaveBeenCalledTimes(1);
      expect(copies[0]!.drawImage).toHaveBeenCalledExactlyOnceWith(canvas, 0, 0);
      expect(canvas.toDataURL).not.toHaveBeenCalled();
    });
  });

  describe('context loss', () => {
    it('prevents the default on webglcontextlost, so the browser restores the context', () => {
      const onContextLost = vi.fn();
      const { renderer, fire } = setup({ onContextLost });
      expect(fire('webglcontextlost')).toBe(true);
      expect(renderer.isContextLost()).toBe(true);
      expect(onContextLost).toHaveBeenCalledTimes(1);
    });

    it('issues no GL calls while lost, and uploads throw ContextLostError', () => {
      const { renderer, fire, log, gl } = setup();
      const before = renderer.uploadTile(grid(), image());
      renderer.setCamera(viewProjection({ yaw: 0, pitch: 0, fov: 90 }, 1, 179));
      fire('webglcontextlost');
      const start = log.length;
      renderer.render([{ handle: before, level: 0 }]);
      expect(() => renderer.uploadTile(grid(), image())).toThrow(ContextLostError);
      expect(renderer.snapshot([])).toBeNull();
      renderer.removeTile(before);
      renderer.resize(300, 200);
      expect(log.slice(start)).toEqual([]);
      expect(gl.drawElements).not.toHaveBeenCalled();
    });

    it('reports a failed create on a lost context as ContextLostError', () => {
      const { renderer, gl } = setup();
      // Lost, with the event not dispatched yet.
      gl.isContextLost.mockReturnValue(true);
      gl.createVertexArray.mockReturnValue(null);
      expect(() => renderer.uploadTile(grid(), image())).toThrow(ContextLostError);
    });

    it('rebuilds the program and forgets every tile on restore', () => {
      const onContextRestored = vi.fn();
      const { renderer, fire, gl } = setup({ onContextRestored });
      renderer.resize(100, 50);
      const old = renderer.uploadTile(grid(), image());
      fire('webglcontextlost');
      expect(gl.createProgram).toHaveBeenCalledTimes(1);
      fire('webglcontextrestored');
      expect(renderer.isContextLost()).toBe(false);
      expect(onContextRestored).toHaveBeenCalledTimes(1);
      expect(gl.createProgram).toHaveBeenCalledTimes(2);
      expect(gl.useProgram).toHaveBeenCalledTimes(2);
      expect(gl.viewport).toHaveBeenLastCalledWith(0, 0, 100, 50);
      // The shared quad IBO is made again for the new context.
      expect(gl.bufferData.mock.calls.at(-1)![0]).toBe(gl.ELEMENT_ARRAY_BUFFER);
      // A handle from before the loss names nothing, and is never reused.
      renderer.setCamera(viewProjection({ yaw: 0, pitch: 0, fov: 90 }, 1, 179));
      renderer.render([{ handle: old, level: 0 }]);
      expect(gl.drawElements).not.toHaveBeenCalled();
      expect(renderer.uploadTile(grid(), image())).not.toBe(old);
    });

    it('stays lost and reports, without throwing, when the rebuild on restore fails', () => {
      const report = vi.fn();
      vi.stubGlobal('reportError', report);
      const onContextRestored = vi.fn();
      const { renderer, fire, gl } = setup({ onContextRestored });
      fire('webglcontextlost');
      gl.createProgram.mockReturnValue(null);
      expect(() => fire('webglcontextrestored')).not.toThrow();
      expect(report).toHaveBeenCalledTimes(1);
      expect(renderer.isContextLost()).toBe(true);
      expect(onContextRestored).not.toHaveBeenCalled();
      expect(() => renderer.uploadTile(grid(), image())).toThrow(ContextLostError);
    });

    it('does not prevent the loss dispose() causes, so no restore is armed', () => {
      const onContextLost = vi.fn();
      const { renderer, loseContext, canvas } = setup({ onContextLost });
      const listener = canvas.addEventListener.mock.calls.find(
        (c) => c[0] === 'webglcontextlost',
      )![1] as Listener;
      let prevented = false;
      loseContext.mockImplementation(() => listener({ preventDefault: () => (prevented = true) }));
      renderer.dispose();
      expect(loseContext).toHaveBeenCalledTimes(1);
      expect(prevented).toBe(false);
      expect(onContextLost).not.toHaveBeenCalled();
      expect(canvas.removeEventListener).toHaveBeenCalledWith('webglcontextlost', listener);
    });
  });

  describe('uploadTile', () => {
    it('reads MAX_TEXTURE_SIZE', () => {
      expect(setup().renderer.maxTextureSize).toBe(8192);
    });

    it('interleaves every vertex of N-vertex geometry', () => {
      const { gl, renderer } = setup();
      const img = image(64, 32);
      renderer.uploadTile(grid(), img);
      const vbo = gl.bufferData.mock.calls.find(
        (c) => c[0] === gl.ARRAY_BUFFER,
      )![1] as Float32Array;
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

    it('frees the buffers, texture and VAO on removeTile', () => {
      const { gl, renderer } = setup();
      const h = renderer.uploadTile(grid(), image());
      const vao = gl.createVertexArray.mock.results[0]!.value as unknown;
      renderer.removeTile(h);
      expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
      expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
      expect(gl.deleteVertexArray).toHaveBeenCalledExactlyOnceWith(vao);
    });

    it('draws 4-vertex quads from one shared index buffer', () => {
      const { gl, renderer } = setup();
      const shared = gl.createBuffer.mock.calls.length;
      expect(shared).toBe(1); // the static quad IBO, made once
      renderer.uploadTile(buildTileGeometry('pz', 1, 0, 0), image());
      renderer.uploadTile(buildTileGeometry('nx', 1, 1, 1), image());
      // One VBO per quad tile, no per-tile IBO.
      expect(gl.createBuffer).toHaveBeenCalledTimes(shared + 2);
      // N-vertex patches still get their own IBO.
      renderer.uploadTile(grid(), image());
      expect(gl.createBuffer).toHaveBeenCalledTimes(shared + 4);
    });

    it('frees only the VBO of a quad tile, never the shared index buffer', () => {
      const { gl, renderer } = setup();
      renderer.removeTile(renderer.uploadTile(buildTileGeometry('pz', 0, 0, 0), image()));
      expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
      renderer.dispose();
      expect(gl.deleteBuffer).toHaveBeenCalledTimes(2); // the shared IBO, on dispose
    });
  });

  describe('render', () => {
    // Yaw 0 looks down -z, so the nz face is in front and pz is behind.
    const camera = () => viewProjection({ yaw: 0, pitch: 0, fov: 90 }, 1, 179);

    function drawnTextures(gl: FakeGl): unknown[] {
      // The texture bound right before each draw call.
      const out: unknown[] = [];
      let bound: unknown;
      let bindCall = 0;
      for (const name of gl.__log) {
        if (name === 'bindTexture') bound = gl.bindTexture.mock.calls[bindCall++]![1];
        if (name === 'drawElements') out.push(bound);
      }
      return out;
    }

    function tile(renderer: GLRenderer, gl: FakeGl, face: Face, level = 0, x = 0, y = 0) {
      const handle = renderer.uploadTile(buildTileGeometry(face, level, x, y), image());
      const tex = gl.createTexture.mock.results.at(-1)!.value as unknown;
      return { handle, level, tex };
    }

    it('does not draw a tile whose bounding sphere is behind the camera', () => {
      const { gl, renderer } = setup();
      // Level 2 tiles near the face centres: a whole level-0 face is large
      // enough that its sphere reaches past the camera.
      const front = tile(renderer, gl, 'nz', 2, 1, 1);
      const behind = tile(renderer, gl, 'pz', 2, 1, 1);
      renderer.setCamera(camera());
      renderer.render([front, behind]);
      expect(gl.drawElements).toHaveBeenCalledTimes(1);
      expect(drawnTextures(gl)).toEqual([front.tex]);
    });

    it('requests a depth buffer and depth-tests with LESS', () => {
      const { gl, canvas } = setup();
      expect(canvas.getContext.mock.calls[0]![1]).toMatchObject({ depth: true });
      expect(gl.enable).toHaveBeenCalledWith(gl.DEPTH_TEST);
      expect(gl.depthFunc).toHaveBeenCalledWith(gl.LESS);
      expect(gl.disable).not.toHaveBeenCalledWith(gl.DEPTH_TEST);
    });

    it('sets a constant per-draw NDC depth from uZ in the vertex shader', () => {
      const { gl } = setup();
      const sources = gl.shaderSource.mock.calls.map((c) => c[1] as string);
      const vert = sources.find((src) => src.includes('gl_Position'));
      expect(vert).toMatch(/gl_Position\.z\s*=\s*uZ\s*\*\s*gl_Position\.w\s*;/);
    });

    it('clears colour and depth every frame', () => {
      const { gl, renderer } = setup();
      renderer.setCamera(camera());
      renderer.render([]);
      expect(gl.clear).toHaveBeenCalledWith(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    });

    it('draws finest-first with a strictly larger depth per coarser rank', () => {
      const { gl, renderer, log } = setup();
      // All in front of the camera, near the nz face centre. 1.5 is a
      // preview's fractional level, between tile levels 1 and 2.
      const l0 = tile(renderer, gl, 'nz', 0);
      const l1 = tile(renderer, gl, 'nz', 1, 1, 1);
      const l2a = tile(renderer, gl, 'nz', 2, 1, 1);
      const l2b = tile(renderer, gl, 'nz', 2, 2, 2);
      const preview = tile(renderer, gl, 'nz', 1, 0, 0);
      const previewItem = { handle: preview.handle, level: 1.5, tex: preview.tex };
      renderer.setCamera(camera());
      const start = log.length;
      let texCall = gl.bindTexture.mock.calls.length;
      gl.uniform1f.mockClear();
      renderer.render([l0, l2a, previewItem, l1, l2b]);

      // Pair each draw with the texture and uZ in effect at that point.
      const draws: { tex: unknown; z: number }[] = [];
      let tex: unknown;
      let z = Number.NaN;
      let zCall = 0;
      for (const name of log.slice(start)) {
        if (name === 'bindTexture') tex = gl.bindTexture.mock.calls[texCall++]![1];
        if (name === 'uniform1f') z = gl.uniform1f.mock.calls[zCall++]![1] as number;
        if (name === 'drawElements') draws.push({ tex, z });
      }
      expect(draws.map((d) => d.tex)).toEqual([l2a.tex, l2b.tex, preview.tex, l1.tex, l0.tex]);
      const zs = draws.map((d) => d.z);
      // Same level, same depth; each coarser rank strictly deeper; all
      // inside the clip range and short of the cleared depth.
      expect(zs[0]).toBe(zs[1]);
      for (let i = 2; i < zs.length; i++) expect(zs[i]!).toBeGreaterThan(zs[i - 1]!);
      for (const v of zs) {
        expect(v).toBeGreaterThan(-1);
        expect(v).toBeLessThan(1);
      }
    });

    it('skips handles that are not resident', () => {
      const { gl, renderer } = setup();
      const front = tile(renderer, gl, 'nz');
      renderer.setCamera(camera());
      renderer.render([{ handle: 999, level: 0 }, front]);
      expect(gl.drawElements).toHaveBeenCalledTimes(1);
    });

    it('issues at most 3 GL calls per visible tile', () => {
      const { gl, renderer, log } = setup();
      renderer.setCamera(camera());
      const g = 4; // level 2: 4×4 tiles per face
      const tiles = [];
      for (let y = 0; y < g; y++)
        for (let x = 0; x < g; x++) tiles.push(tile(renderer, gl, 'nz', 2, x, y));
      const callsFor = (list: DrawItem[]) => {
        const start = log.length;
        renderer.render(list);
        return log.length - start;
      };
      const one = callsFor(tiles.slice(0, 1));
      const all = callsFor(tiles);
      expect(gl.drawElements).toHaveBeenCalledTimes(1 + tiles.length);
      expect(all - one).toBeLessThanOrEqual(3 * (tiles.length - 1));
    });
  });
});
