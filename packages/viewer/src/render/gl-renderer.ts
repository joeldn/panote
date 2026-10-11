import { frustumFromViewProj, intersectsSphere, type Mat4, type Sphere } from './projection.js';
import { QUAD_INDEX, type TileGeometry } from '../tile-geometry.js';
import { VIEWER_DEFAULTS } from '../defaults.js';
import { report } from '../report.js';
import { CONTEXT_ATTRIBUTES, WebGLUnavailableError } from '../webgl-support.js';

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
  /** Anisotropic filtering samples, or the device's maximum. */
  anisotropy?: number | 'max';
  /** Clear colour, 0..1 per channel. */
  background?: readonly [r: number, g: number, b: number];
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

// The shaders are written as one string literal per statement, with the
// comments in JS: the minifier drops the comments and folds the literals into
// one compact string, so the bundle carries no GLSL comments or indentation.
// Only the #version directive needs a line of its own.

const VERT_SRC =
  '#version 300 es\n' +
  'precision highp float;' +
  'uniform mat4 uViewProj;' +
  // Per-level depth (see rankDepth): finer levels sit in front.
  'uniform float uZ;' +
  'layout(location=0) in vec3 aPos;' +
  'layout(location=1) in vec2 aUv;' +
  'out vec2 vUv;' +
  'void main(){' +
  'vUv=aUv;' +
  'gl_Position=uViewProj*vec4(aPos,1.0);' +
  // Constant NDC z per draw (z/w = uZ), whatever the vertex depth. Clipping
  // in z then reduces to w > 0, so the effective near plane is w = 0, as
  // with the skybox xyww trick.
  'gl_Position.z=uZ*gl_Position.w;' +
  '}';

// Textures are plain RGBA8 holding sRGB-encoded bytes, and the canvas shows
// the bytes it is given as sRGB, so texels pass straight through. Filtering
// and mips work in gamma space, as browsers' own image scaling does.
const FRAG_SRC =
  '#version 300 es\n' +
  'precision highp float;' +
  'uniform sampler2D uTex;' +
  'in vec2 vUv;' +
  'out vec4 fragColor;' +
  'void main(){' +
  'fragColor=texture(uTex,vUv);' +
  '}';

export class GLRenderer {
  readonly canvas: HTMLCanvasElement;
  /** The anisotropy tiles are sampled with: the option, capped at the device's maximum. */
  maxAnisotropy = 1;
  maxTextureSize = 0;

  private gl: WebGL2RenderingContext;
  // Everything below is per context: initGL() sets it again after a restore.
  private program!: WebGLProgram;
  private uViewProj!: WebGLUniformLocation;
  private uZ!: WebGLUniformLocation;
  // With KHR_parallel_shader_compile, the shaders of a program still being
  // compiled and linked off the main thread: its status is not asked for
  // (which would wait for it) until the first frame with something to draw.
  // Undefined once the program is checked and bound.
  private pendingShaders: WebGLShader[] | undefined;
  // The program failed its deferred check: nothing can be drawn.
  private programFailed = false;
  private anisoExt: EXT_texture_filter_anisotropic | null = null;
  /** One static IBO shared by every 4-vertex quad. */
  private quadIbo!: WebGLBuffer;
  private maxPixelRatio: number;
  private maxPixels: number;
  private anisotropy: number | 'max';
  private background: readonly [number, number, number];
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
    const d = VIEWER_DEFAULTS.rendering;
    this.maxPixelRatio = opts.maxPixelRatio ?? d.maxPixelRatio;
    this.maxPixels = opts.maxPixels ?? d.maxPixels;
    this.anisotropy = opts.anisotropy ?? d.anisotropy;
    this.background = opts.background ?? d.background;
    this.onContextLost = opts.onContextLost;
    this.onContextRestored = opts.onContextRestored;
    this.canvas = document.createElement('canvas');
    // Block, not inline: an inline canvas sits on a text baseline and makes
    // its line box a few px taller than itself. The cursor belongs to Controls.
    this.canvas.style.display = 'block';
    const gl = this.canvas.getContext('webgl2', {
      ...CONTEXT_ATTRIBUTES,
      antialias: opts.antialias ?? d.antialias,
    });
    if (!gl) throw new WebGLUnavailableError();
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
    try {
      this.initGL();
    } catch (err) {
      // The context went again, or the rebuild failed: stay lost, so nothing
      // draws or uploads, and never throw out of an event listener.
      report(err);
      return;
    }
    this.lost = false;
    this.onContextRestored?.();
  };

  /** Program, uniforms, extensions, the shared IBO and the static GL state. */
  private initGL(): void {
    const gl = this.gl;
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    const deviceMax: number = this.anisoExt
      ? gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
      : 1;
    this.maxAnisotropy =
      this.anisotropy === 'max' ? deviceMax : Math.max(1, Math.min(this.anisotropy, deviceMax));

    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    // Asking for a shader's or program's status waits for its compile. With
    // KHR_parallel_shader_compile the driver compiles off the main thread, so
    // the check is left to the first frame that draws: the base tiles load
    // in the meantime. Without it, the check is made here as it always was.
    const parallel = gl.getExtension('KHR_parallel_shader_compile') !== null;
    const vs = this.compile(gl.VERTEX_SHADER, VERT_SRC, !parallel);
    const fs = this.compile(gl.FRAGMENT_SHADER, FRAG_SRC, !parallel);
    const prog = gl.createProgram();
    if (!prog) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error('createProgram failed: context lost or resource exhaustion');
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    this.program = prog;
    this.programFailed = false;
    this.pendingShaders = [vs, fs];
    if (!parallel) this.useProgram();

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
    const [r, g, b] = this.background;
    gl.clearColor(r, g, b, 1);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** A compiled shader; with `check`, its compile status is checked now. */
  private compile(type: number, src: string, check: boolean): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) throw new Error('createShader failed: context lost or resource exhaustion');
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (check && !gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`shader compile failed: ${log}`);
    }
    return sh;
  }

  /**
   * Check the linked program and bind it with its uniforms, once per
   * context. One program and one texture unit for the context's whole life,
   * so they are bound here rather than every frame. Throws if it failed.
   */
  private useProgram(): void {
    const gl = this.gl;
    const shaders = this.pendingShaders;
    if (!shaders) return;
    this.pendingShaders = undefined;
    const prog = this.program;
    // A shader that did not compile fails the link too.
    const linked = gl.getProgramParameter(prog, gl.LINK_STATUS);
    const log = linked ? '' : gl.getProgramInfoLog(prog);
    for (const sh of shaders) gl.deleteShader(sh);
    if (!linked) {
      gl.deleteProgram(prog);
      throw new Error(`program link failed: ${log}`);
    }
    this.uViewProj = this.getUniform('uViewProj');
    this.uZ = this.getUniform('uZ');
    gl.useProgram(prog);
    gl.uniform1i(this.getUniform('uTex'), 0);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * useProgram() for a frame: false, reported once, if the program failed.
   * A lost context fails the link check too (its status reads null) before
   * the loss event has run; that is not reported, and the restore builds and
   * checks a new program.
   */
  private programReady(): boolean {
    if (this.programFailed) return false;
    try {
      this.useProgram();
      return true;
    } catch (err) {
      this.programFailed = true;
      if (!this.gl.isContextLost()) report(err);
      return false;
    }
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
    let vao: WebGLVertexArrayObject | null = null;
    let vbo: WebGLBuffer | null = null;
    let ibo: WebGLBuffer | null = null;
    let tex: WebGLTexture | null = null;
    try {
      // Record the vertex layout and index buffer in a VAO once, so a draw is
      // just bindVertexArray + bindTexture + drawElements.
      vao = gl.createVertexArray();
      if (!vao) throw this.createFailed('createVertexArray');
      gl.bindVertexArray(vao);
      vbo = this.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
      const stride = 5 * 4; // 5 floats × 4 bytes
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 3 * 4);
      if (count === 4 && isQuadIndex(geom.index)) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);
      } else {
        ibo = this.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.index, gl.STATIC_DRAW);
      }
      gl.bindVertexArray(null);

      tex = gl.createTexture();
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
      if (this.anisoExt && this.maxAnisotropy > 1) {
        gl.texParameterf(
          gl.TEXTURE_2D,
          this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT,
          this.maxAnisotropy,
        );
      }
    } catch (err) {
      // A throw part-way (a create under exhaustion, a texSubImage2D
      // SecurityError from a tainted image) must not leak what was made, or
      // leave it bound: the tile layer retries, and each attempt would leak.
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      if (vao) gl.deleteVertexArray(vao);
      if (vbo) gl.deleteBuffer(vbo);
      if (ibo) gl.deleteBuffer(ibo);
      if (tex) gl.deleteTexture(tex);
      throw err;
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

    // Cull here rather than in the layers, so tiles and preview patches
    // outside the view cost no draw call.
    const frustum = frustumFromViewProj(this.viewProj, this.frustum);
    const order = this.order;
    order.length = 0;
    for (const item of drawList) {
      const t = this.tiles.get(item.handle);
      if (t && intersectsSphere(frustum, t.bounds)) order.push(item);
    }
    // Nothing to draw needs no program: a parallel compile carries on.
    if (order.length === 0 || !this.programReady()) {
      order.length = 0;
      return;
    }
    gl.uniformMatrix4fv(this.uViewProj, false, this.viewProj);
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
   * Render, then copy the frame into a new 2D canvas at the canvas's CSS
   * size. The copy is made in the same task as the render, so it needs no
   * preserveDrawingBuffer, and drawImage stays on the GPU where a toDataURL
   * would encode a PNG on the main thread. Null while the context is lost.
   *
   * CSS size, not the backbuffer's device pixels: the copy is only faded out
   * over a scene change, which does not need the DPR detail, and at DPR 2 it
   * is a quarter of the memory and copy (a 1512×982 view: 5.9 MB, not 23.8).
   */
  snapshot(drawList: DrawItem[]): HTMLCanvasElement | null {
    if (this.lost) return null;
    this.render(drawList);
    const { width, height } = this.canvas;
    const w = Math.min(width, Math.max(1, Math.round(this.cssW)));
    const h = Math.min(height, Math.max(1, Math.round(this.cssH)));
    const copy = document.createElement('canvas');
    copy.width = w;
    copy.height = h;
    const ctx = copy.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(this.canvas, 0, 0, w, h);
    return copy;
  }

  dispose(): void {
    // First, so the loss loseContext() causes below arms no restore.
    this.disposed = true;
    for (const handle of [...this.tiles.keys()]) this.removeTile(handle);
    if (!this.lost) {
      this.gl.deleteBuffer(this.quadIbo);
      this.gl.deleteProgram(this.program);
      for (const sh of this.pendingShaders ?? []) this.gl.deleteShader(sh);
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
