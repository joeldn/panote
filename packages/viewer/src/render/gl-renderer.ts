import { frustumFromViewProj, intersectsSphere, type Mat4, type Sphere } from './projection.js';
import { QUAD_INDEX, type TileGeometry } from '../tile-geometry.js';
import { VIEWER_DEFAULTS } from '../defaults.js';

/** Opaque per-tile id. */
export type TileHandle = number;

/** Pixel sources the renderer can upload as a texture. */
export type TileImage = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

/** One entry in the per-frame draw list. */
export interface DrawItem {
  handle: TileHandle;
  level: number;
}

/**
 * The draw list in stacking order, back to front: coarse tiles (low level)
 * at the back, finer levels over them. Stable, pure. render() gets the same
 * result with the depth test while drawing in the reverse order.
 */
export function sortDrawList(list: DrawItem[]): DrawItem[] {
  return [...list].sort((a, b) => a.level - b.level);
}

// Finest level first. Array.prototype.sort is stable, so equal levels keep
// their list order.
function finestFirst(a: DrawItem, b: DrawItem): number {
  return b.level - a.level;
}

/**
 * Clip-space depth for the `rank`-th distinct level (0 = finest) out of
 * `count`. Strictly increasing with rank and strictly inside (-1, 1), so
 * every rank passes LESS against the cleared depth of 1.
 */
function rankDepth(rank: number, count: number): number {
  return -1 + (2 * (rank + 1)) / (count + 1);
}

/**
 * Thrown by uploadTile() while the WebGL context is lost. Not a tile failure:
 * the tile is fine and loads again once the context is back, so callers treat
 * it like an abort.
 */
export class ContextLostError extends Error {
  constructor() {
    super('WebGL context lost');
    this.name = 'ContextLostError';
  }
}

export interface GLRendererOptions {
  antialias?: boolean;
  maxPixelRatio?: number;
  /** Cap on backbuffer pixels; the pixel ratio drops to stay under it. */
  maxPixels?: number;
  /** The context was lost. Drawing and uploads are no-ops until it is restored. */
  onContextLost?: () => void;
  /**
   * The context is back, with the program rebuilt and every tile forgotten.
   * Handles from before the loss draw nothing; upload the tiles again.
   */
  onContextRestored?: () => void;
}

interface TileResources {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  /** Null when the tile draws from the shared quad IBO. */
  ibo: WebGLBuffer | null;
  tex: WebGLTexture;
  indexCount: number;
  /** Bounds of the vertices, for frustum culling. */
  bounds: Sphere;
}

/** Bounding sphere of xyz positions: their centroid and the farthest vertex. */
export function boundingSphere(pos: Float32Array): Sphere {
  const n = pos.length / 3;
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let i = 0; i < n; i++) {
    cx += pos[i * 3]!;
    cy += pos[i * 3 + 1]!;
    cz += pos[i * 3 + 2]!;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = pos[i * 3]! - cx,
      dy = pos[i * 3 + 1]! - cy,
      dz = pos[i * 3 + 2]! - cz;
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return { cx, cy, cz, r: Math.sqrt(r2) };
}

function isQuadIndex(index: Uint16Array): boolean {
  if (index === QUAD_INDEX) return true;
  if (index.length !== QUAD_INDEX.length) return false;
  for (let i = 0; i < index.length; i++) if (index[i] !== QUAD_INDEX[i]) return false;
  return true;
}

const VERT_SRC = `#version 300 es
precision highp float;
uniform mat4 uViewProj;
// Per-level depth (see rankDepth): finer levels sit in front.
uniform float uZ;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uViewProj * vec4(aPos, 1.0);
  // Constant NDC z per draw (z/w = uZ), whatever the vertex depth. Clipping
  // in z then reduces to w > 0, so the effective near plane is w = 0, as
  // with the skybox xyww trick.
  gl_Position.z = uZ * gl_Position.w;
}`;

// Textures are plain RGBA8 holding sRGB-encoded bytes, and the canvas shows
// the bytes it is given as sRGB, so texels pass straight through. Filtering
// and mips work in gamma space, as browsers' own image scaling does.
const FRAG_SRC = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = texture(uTex, vUv);
}`;

export class GLRenderer {
  readonly canvas: HTMLCanvasElement;
  maxAnisotropy = 1;
  maxTextureSize = 0;

  private gl: WebGL2RenderingContext;
  // Everything below is per context: initGL() sets it again after a restore.
  private program!: WebGLProgram;
  private uViewProj!: WebGLUniformLocation;
  private uZ!: WebGLUniformLocation;
  private anisoExt: EXT_texture_filter_anisotropic | null = null;
  /** One static IBO shared by every 4-vertex quad. */
  private quadIbo!: WebGLBuffer;
  private maxPixelRatio: number;
  private maxPixels: number;
  // The CSS size the backbuffer was last sized for.
  private cssW = 0;
  private cssH = 0;
  private viewProj: Mat4 | null = null;
  private tiles = new Map<TileHandle, TileResources>();
  // Never reset, not even on a restore, so a handle from before a context loss
  // can never name a tile uploaded after it.
  private nextHandle = 1;
  /** Reused every frame: the frustum and the culled, sorted draw order. */
  private frustum = new Float32Array(24);
  private order: DrawItem[] = [];
  private lost = false;
  private disposed = false;
  private onContextLost: (() => void) | undefined;
  private onContextRestored: (() => void) | undefined;

  constructor(container: HTMLElement, opts: GLRendererOptions = {}) {
    this.maxPixelRatio = opts.maxPixelRatio ?? VIEWER_DEFAULTS.maxPixelRatio;
    this.maxPixels = opts.maxPixels ?? VIEWER_DEFAULTS.maxPixels;
    this.onContextLost = opts.onContextLost;
    this.onContextRestored = opts.onContextRestored;
    this.canvas = document.createElement('canvas');
    // Block, not inline: an inline canvas sits on a text baseline and makes
    // its line box a few px taller than itself. The cursor belongs to Controls.
    this.canvas.style.display = 'block';
    const gl = this.canvas.getContext('webgl2', {
      antialias: opts.antialias ?? false,
      // Opaque backbuffer. Depth lets finer levels reject the coarser
      // fragments behind them (see render()). Stencil is unused.
      alpha: false,
      depth: true,
      stencil: false,
      // no preserveDrawingBuffer — snapshot() copies the frame in the same task instead.
    });
    if (!gl) {
      throw new Error('WebGL2 is not available in this browser; the pano viewer requires WebGL2.');
    }
    this.gl = gl;
    container.appendChild(this.canvas);
    this.canvas.addEventListener('webglcontextlost', this.onLost);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.initGL();
  }

  /** True between a context loss and its restore. */
  isContextLost(): boolean {
    return this.lost;
  }

  // Without preventDefault the browser never restores the context. A loss
  // that dispose() caused on purpose is left alone, so no restore is armed.
  private onLost = (e: Event): void => {
    if (this.disposed) return;
    e.preventDefault();
    this.lost = true;
    this.onContextLost?.();
  };

  private onRestored = (): void => {
    if (this.disposed) return;
    // Every GL object died with the old context.
    this.tiles.clear();
    // Still lost if this throws (the context went again): nothing is drawn.
    this.initGL();
    this.lost = false;
    this.onContextRestored?.();
  };

  /** Program, uniforms, extensions, the shared IBO and the static GL state. */
  private initGL(): void {
    const gl = this.gl;
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    this.maxAnisotropy = this.anisoExt
      ? gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
      : 1;

    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    this.program = this.buildProgram(VERT_SRC, FRAG_SRC);
    this.uViewProj = this.getUniform('uViewProj');
    this.uZ = this.getUniform('uZ');
    // One program and one texture unit for the context's whole life, so
    // bind them once here rather than every frame.
    gl.useProgram(this.program);
    gl.uniform1i(this.getUniform('uTex'), 0);
    gl.activeTexture(gl.TEXTURE0);

    // No VAO is bound here, so this binding is not captured by one.
    this.quadIbo = this.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, QUAD_INDEX, gl.STATIC_DRAW);

    // Static GL state: opaque tiles, layered by depth (see render()), and
    // interior faces.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE); // quads visible from the origin looking outward
    gl.clearColor(0, 0, 0, 1);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private buildProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error('createShader failed: context lost or resource exhaustion');
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`shader compile failed: ${log}`);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    if (!prog) throw new Error('createProgram failed: context lost or resource exhaustion');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`program link failed: ${log}`);
    }
    return prog;
  }

  private createBuffer(): WebGLBuffer {
    const buf = this.gl.createBuffer();
    if (!buf) throw this.createFailed('createBuffer');
    return buf;
  }

  // A null from a create call is what a lost context returns, and the loss
  // event may not have been dispatched yet.
  private createFailed(what: string): Error {
    if (this.gl.isContextLost()) return new ContextLostError();
    return new Error(`${what} failed: resource exhaustion`);
  }

  private getUniform(name: string): WebGLUniformLocation {
    const loc = this.gl.getUniformLocation(this.program, name);
    if (!loc) throw new Error(`uniform ${name} not found`);
    return loc;
  }

  /**
   * Size the canvas to `w` × `h` CSS pixels. The backbuffer gets the device
   * pixel ratio, capped at `maxPixelRatio` and lowered further so it stays
   * within `maxPixels`. Returns whether anything changed: a resize clears the
   * drawing buffer, so a caller that gets true has to draw again, and one that
   * gets false has nothing to do.
   */
  resize(w: number, h: number): boolean {
    const wanted = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    const budget = Math.sqrt(this.maxPixels / (w * h));
    // Rounded down under the pixel cap, so rounding cannot take it over.
    const fit = budget < wanted ? Math.floor : Math.round;
    const ratio = Math.min(wanted, budget);
    const bw = Math.max(1, fit(w * ratio));
    const bh = Math.max(1, fit(h * ratio));
    const canvas = this.canvas;
    if (w === this.cssW && h === this.cssH && bw === canvas.width && bh === canvas.height) {
      return false;
    }
    if (w !== this.cssW || h !== this.cssH) {
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      this.cssW = w;
      this.cssH = h;
    }
    // Each write reallocates (and clears) the drawing buffer, even an unchanged one.
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    if (!this.lost) this.gl.viewport(0, 0, bw, bh);
    return true;
  }

  setCamera(viewProj: Mat4): void {
    this.viewProj = viewProj;
  }

  /** Upload N-vertex geometry and its texture. The image goes up unflipped, so
   *  `geom.uv` must address its first row as v = 0. */
  uploadTile(geom: TileGeometry, bitmap: TileImage): TileHandle {
    if (this.lost) throw new ContextLostError();
    const gl = this.gl;
    const count = geom.pos.length / 3;
    if (!Number.isInteger(count) || geom.uv.length !== count * 2) {
      throw new Error('uploadTile: pos and uv describe different vertex counts');
    }
    if (count > 65536) throw new Error(`uploadTile: ${count} vertices exceed 16-bit indices`);
    // Interleave pos (3) + uv (2) into one VBO: [px,py,pz,u,v] × N.
    const interleaved = new Float32Array(count * 5);
    for (let i = 0; i < count; i++) {
      interleaved[i * 5] = geom.pos[i * 3]!;
      interleaved[i * 5 + 1] = geom.pos[i * 3 + 1]!;
      interleaved[i * 5 + 2] = geom.pos[i * 3 + 2]!;
      interleaved[i * 5 + 3] = geom.uv[i * 2]!;
      interleaved[i * 5 + 4] = geom.uv[i * 2 + 1]!;
    }
    // Record the vertex layout and index buffer in a VAO once, so a draw is
    // just bindVertexArray + bindTexture + drawElements.
    const vao = gl.createVertexArray();
    if (!vao) throw this.createFailed('createVertexArray');
    gl.bindVertexArray(vao);
    const vbo = this.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
    const stride = 5 * 4; // 5 floats × 4 bytes
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 3 * 4);
    let ibo: WebGLBuffer | null = null;
    if (count === 4 && isQuadIndex(geom.index)) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);
    } else {
      ibo = this.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.index, gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);

    const tex = gl.createTexture();
    if (!tex) throw this.createFailed('createTexture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(
      gl.TEXTURE_2D,
      mipLevels(bitmap.width, bitmap.height),
      gl.RGBA8,
      bitmap.width,
      bitmap.height,
    );
    // UNPACK_FLIP_Y_WEBGL stays at its default (false). Tiles and preview
    // patches are both decoded upright (row 0 = top) and their UVs address
    // row 0 as v = 0, so nothing is flipped anywhere.
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      bitmap.width,
      bitmap.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bitmap,
    );
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.anisoExt) {
      gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, this.maxAnisotropy);
    }

    const handle = this.nextHandle++;
    this.tiles.set(handle, {
      vao,
      vbo,
      ibo,
      tex,
      indexCount: geom.index.length,
      bounds: boundingSphere(geom.pos),
    });
    return handle;
  }

  removeTile(handle: TileHandle): void {
    const t = this.tiles.get(handle);
    if (!t) return;
    if (this.lost) {
      // Its GL objects went with the context.
      this.tiles.delete(handle);
      return;
    }
    this.gl.deleteVertexArray(t.vao);
    this.gl.deleteBuffer(t.vbo);
    if (t.ibo) this.gl.deleteBuffer(t.ibo);
    this.gl.deleteTexture(t.tex);
    this.tiles.delete(handle);
  }

  render(drawList: DrawItem[]): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.viewProj) return;
    gl.uniformMatrix4fv(this.uViewProj, false, this.viewProj);

    // Cull here rather than in the layers, so tiles and preview patches
    // outside the view cost no draw call.
    const frustum = frustumFromViewProj(this.viewProj, this.frustum);
    const order = this.order;
    order.length = 0;
    for (const item of drawList) {
      const t = this.tiles.get(item.handle);
      if (t && intersectsSphere(frustum, t.bounds)) order.push(item);
    }
    // Every resident level covers the screen, so painting coarse-first would
    // shade each pixel once per level. Instead draw finest-first, with each
    // distinct level (rank) at its own depth, finer in front: coarser
    // fragments behind a finer tile then fail the depth test early and are
    // never shaded. Ranks, not raw levels, so fractional preview levels such
    // as -0.5 or 2.5 slot in between. Tiles of one level never overlap, so
    // sharing a depth within a level is fine.
    order.sort(finestFirst);
    let ranks = 0;
    for (let i = 0; i < order.length; i++) {
      if (i === 0 || order[i]!.level !== order[i - 1]!.level) ranks++;
    }

    let rank = -1;
    for (let i = 0; i < order.length; i++) {
      const item = order[i]!;
      if (i === 0 || item.level !== order[i - 1]!.level) {
        gl.uniform1f(this.uZ, rankDepth(++rank, ranks));
      }
      const t = this.tiles.get(item.handle)!;
      gl.bindVertexArray(t.vao);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.drawElements(gl.TRIANGLES, t.indexCount, gl.UNSIGNED_SHORT, 0);
    }
    order.length = 0;
  }

  /**
   * Render, then copy the frame into a new 2D canvas of the same size. The
   * copy is made in the same task as the render, so it needs no
   * preserveDrawingBuffer, and drawImage stays on the GPU where a toDataURL
   * would encode a PNG on the main thread. Null while the context is lost.
   */
  snapshot(drawList: DrawItem[]): HTMLCanvasElement | null {
    if (this.lost) return null;
    this.render(drawList);
    const copy = document.createElement('canvas');
    copy.width = this.canvas.width;
    copy.height = this.canvas.height;
    const ctx = copy.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(this.canvas, 0, 0);
    return copy;
  }

  dispose(): void {
    // First, so the loss loseContext() causes below arms no restore.
    this.disposed = true;
    for (const handle of [...this.tiles.keys()]) this.removeTile(handle);
    if (!this.lost) {
      this.gl.deleteBuffer(this.quadIbo);
      this.gl.deleteProgram(this.program);
    }
    // Deleting individual resources frees GPU memory but does not release the
    // context slot itself — browsers cap live WebGL contexts per page
    // (commonly 8-16), and that slot is only reclaimed on GC. Explicitly
    // losing the context releases it immediately so an app that creates and
    // destroys many PanoViewer instances (a gallery, route changes) doesn't
    // exhaust the pool.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.canvas.remove();
  }
}

/** Full mip chain level count for a texture of the given dimensions. */
export function mipLevels(w: number, h: number): number {
  return 1 + Math.floor(Math.log2(Math.max(w, h)));
}
