import type { Mat4 } from './projection.js';
import type { TileGeometry } from '../tile-geometry.js';

/** Opaque per-tile id. */
export type TileHandle = number;

/** One entry in the per-frame draw list. */
export interface DrawItem {
  handle: TileHandle;
  level: number;
}

/**
 * Sort the draw list so coarse tiles (low level) paint first and finer levels
 * paint over them — replaces three's mesh.renderOrder = level. Stable, pure.
 */
export function sortDrawList(list: DrawItem[]): DrawItem[] {
  // Array.prototype.sort is stable in modern engines; key on level only.
  return [...list].sort((a, b) => a.level - b.level);
}

interface TileResources {
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  tex: WebGLTexture;
  indexCount: number;
}

const VERT_SRC = `#version 300 es
precision highp float;
uniform mat4 uViewProj;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

// Sampling happens in linear space (texture is SRGB8_ALPHA8, decoded on read),
// so convert linear→sRGB on output to match three's default renderer.
const FRAG_SRC = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 fragColor;
vec3 linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}
void main() {
  vec4 texel = texture(uTex, vUv);
  fragColor = vec4(linearToSRGB(texel.rgb), texel.a);
}`;

export class GLRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly maxAnisotropy: number;

  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uViewProj: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private anisoExt: EXT_texture_filter_anisotropic | null;
  private pixelRatio: number;
  private maxPixelRatio: number;
  private viewProj: Mat4 | null = null;
  private tiles = new Map<TileHandle, TileResources>();
  private nextHandle = 1;

  constructor(container: HTMLElement, opts: { antialias?: boolean; maxPixelRatio?: number } = {}) {
    this.maxPixelRatio = opts.maxPixelRatio ?? 2;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cursor = 'grab';
    const gl = this.canvas.getContext('webgl2', {
      antialias: opts.antialias ?? false,
      // three's WebGLRenderer defaulted to an opaque backbuffer (alpha:false);
      // this restores exact compositing parity, and depth/stencil are unused.
      alpha: false,
      depth: false,
      stencil: false,
      // no preserveDrawingBuffer — snapshot() reads back synchronously instead.
    });
    if (!gl) {
      throw new Error('WebGL2 is not available in this browser; the pano viewer requires WebGL2.');
    }
    this.gl = gl;
    container.appendChild(this.canvas);

    this.anisoExt =
      gl.getExtension('EXT_texture_filter_anisotropic') ??
      gl.getExtension('MOZ_EXT_texture_filter_anisotropic') ??
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    this.maxAnisotropy = this.anisoExt
      ? gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
      : 1;

    this.program = this.buildProgram(VERT_SRC, FRAG_SRC);
    this.uViewProj = this.getUniform('uViewProj');
    this.uTex = this.getUniform('uTex');

    this.pixelRatio = Math.min(window.devicePixelRatio, this.maxPixelRatio);

    // Static GL state — opaque tiles, painter's-order layering, interior faces.
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE); // quads visible from the origin looking outward
    gl.clearColor(0, 0, 0, 1);
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

  private getUniform(name: string): WebGLUniformLocation {
    const loc = this.gl.getUniformLocation(this.program, name);
    if (!loc) throw new Error(`uniform ${name} not found`);
    return loc;
  }

  resize(w: number, h: number): void {
    this.pixelRatio = Math.min(window.devicePixelRatio, this.maxPixelRatio);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.max(1, Math.round(w * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.round(h * this.pixelRatio));
  }

  setCamera(viewProj: Mat4): void {
    this.viewProj = viewProj;
  }

  uploadTile(geom: TileGeometry, bitmap: ImageBitmap): TileHandle {
    const gl = this.gl;
    // Interleave pos (3) + uv (2) into one VBO: [px,py,pz,u,v] × 4.
    const interleaved = new Float32Array(4 * 5);
    for (let i = 0; i < 4; i++) {
      interleaved[i * 5] = geom.pos[i * 3]!;
      interleaved[i * 5 + 1] = geom.pos[i * 3 + 1]!;
      interleaved[i * 5 + 2] = geom.pos[i * 3 + 2]!;
      interleaved[i * 5 + 3] = geom.uv[i * 2]!;
      interleaved[i * 5 + 4] = geom.uv[i * 2 + 1]!;
    }
    const vbo = gl.createBuffer();
    if (!vbo) throw new Error('createBuffer failed: context lost or resource exhaustion');
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);

    const ibo = gl.createBuffer();
    if (!ibo) throw new Error('createBuffer failed: context lost or resource exhaustion');
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.index, gl.STATIC_DRAW);

    const tex = gl.createTexture();
    if (!tex) throw new Error('createTexture failed: context lost or resource exhaustion');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // SRGB8_ALPHA8: the sampler-side decode on read is what's guaranteed to be
    // linear. Mip generation via generateMipmap for an sRGB texture is
    // implementation-defined (drivers may filter in encoded space); this matches
    // three's exposure exactly regardless — parity holds either way.
    gl.texStorage2D(
      gl.TEXTURE_2D,
      mipLevels(bitmap.width, bitmap.height),
      gl.SRGB8_ALPHA8,
      bitmap.width,
      bitmap.height,
    );
    // Bitmap was decoded with imageOrientation:'flipY' already — no unpack flip.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
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
    this.tiles.set(handle, { vbo, ibo, tex, indexCount: geom.index.length });
    return handle;
  }

  removeTile(handle: TileHandle): void {
    const t = this.tiles.get(handle);
    if (!t) return;
    this.gl.deleteBuffer(t.vbo);
    this.gl.deleteBuffer(t.ibo);
    this.gl.deleteTexture(t.tex);
    this.tiles.delete(handle);
  }

  render(drawList: DrawItem[]): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.viewProj) return;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uViewProj, false, this.viewProj);
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);

    const sorted = sortDrawList(drawList);
    const stride = 5 * 4; // 5 floats × 4 bytes
    for (const item of sorted) {
      const t = this.tiles.get(item.handle);
      if (!t) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, t.vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 3 * 4);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, t.ibo);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.drawElements(gl.TRIANGLES, t.indexCount, gl.UNSIGNED_SHORT, 0);
    }
  }

  /**
   * Render then read the framebuffer back to a PNG data URL synchronously in
   * the same task. Replaces preserveDrawingBuffer + domElement.toDataURL().
   */
  snapshot(drawList: DrawItem[]): string {
    this.render(drawList);
    // toDataURL reads the canvas top-down; this matches the old three.js path's
    // orientation (both share the same implicit flip), verified upright against
    // the pre-migration build.
    return this.canvas.toDataURL();
  }

  dispose(): void {
    for (const handle of [...this.tiles.keys()]) this.removeTile(handle);
    this.gl.deleteProgram(this.program);
    // Deleting individual resources frees GPU memory but does not release the
    // context slot itself — browsers cap live WebGL contexts per page
    // (commonly 8-16), and that slot is only reclaimed on GC. Explicitly
    // losing the context releases it immediately so an app that creates and
    // destroys many PanoViewer instances (a gallery, route changes) doesn't
    // exhaust the pool.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}

/** Full mip chain level count for a texture of the given dimensions. */
export function mipLevels(w: number, h: number): number {
  return 1 + Math.floor(Math.log2(Math.max(w, h)));
}
