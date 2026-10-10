import { equirectUVToDir } from './cube.js';
import type { DrawItem, GLRenderer, TileHandle } from './render/gl-renderer.js';
import { RADIUS, type TileGeometry } from './tile-geometry.js';

/** One piece of a {@link PreviewSource}: an image covering a source-pixel rect. */
export interface PreviewPatch {
  /** Left edge of the rect, in source pixels. */
  x: number;
  /** Top edge of the rect, in source pixels. */
  y: number;
  /** Rect width in source pixels. */
  w: number;
  /** Rect height in source pixels. */
  h: number;
  /** Pixels of the rect, top row first, at most {@link PREVIEW_MAX_PATCH_PX} on a side. */
  image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
}

/**
 * A decoded equirectangular panorama, split into patches, for
 * `PanoViewer.showPreview`.
 *
 * Contract for producers:
 * - `width` × `height` is the (possibly downscaled) equirect size the patch
 *   rects are measured in; it should be 2:1, but nothing depends on that.
 * - Each patch's `image` holds exactly the source rect `x, y, w, h`: image pixel
 *   (0, 0) is source pixel (x, y). The image may be smaller or larger than the
 *   rect, in which case it is stretched over it, but normally it is `w` × `h`.
 * - Images are upright (top row first). Do not decode with `imageOrientation:
 *   'flipY'`.
 * - Neither image side may exceed {@link PREVIEW_MAX_PATCH_PX} (4096), nor the
 *   GPU's MAX_TEXTURE_SIZE; `showPreview` throws otherwise.
 * - Together the patches should tile the whole source. To hide seams, interior
 *   edges carry a gutter: neighbouring rects overlap by
 *   2 × {@link PREVIEW_GUTTER_PX} pixels (each side reaches 2 px into the
 *   other). The layer draws each patch only up to the middle of every overlap,
 *   so any overlap works, and abutting rects with no overlap work too. Edges on
 *   the source border (including the 0/1 wrap seam) need no gutter.
 *
 * Ownership: `showPreview` takes the patches over. Each ImageBitmap is closed
 * once it is on the GPU, so a source can be shown only once. Canvases are left
 * as they are.
 */
export interface PreviewSource {
  /** Width of the equirect the rects are measured in, in pixels. */
  width: number;
  /** Height of the equirect the rects are measured in, in pixels. */
  height: number;
  patches: PreviewPatch[];
}

/** Largest patch side a {@link PreviewSource} may use. */
export const PREVIEW_MAX_PATCH_PX = 4096;

/** Gutter each interior patch edge carries, in source pixels. */
export const PREVIEW_GUTTER_PX = 2;

/**
 * Draw-list level for a preview under a pyramid of `tileSize` tiles, levels
 * 0..`maxLevel`.
 *
 * The rule: the preview draws just above the finest tile level that is no
 * sharper than it, and below every level that is sharper. Level L holds
 * `tileSize * 2^L` texels per 90° face edge (the same density `selectLevel`
 * assumes), and an equirect `width` px wide holds `width / 4` per 90°. With k
 * the largest L where `tileSize * 2^L <= width / 4`, the preview sits at
 * k + 0.5: an 8192-wide preview over 512 px tiles (2048 per face) is 2.5, so
 * levels 0 to 2 paint under it and level 3 over it. A preview softer than
 * level 0 sits at -0.5, under everything; one at least as sharp as `maxLevel`
 * sits at `maxLevel + 0.5`, over everything.
 */
export function previewDrawLevel(width: number, tileSize: number, maxLevel: number): number {
  const ratio = width / 4 / tileSize;
  if (!(ratio > 0) || !Number.isFinite(ratio)) return -0.5;
  // The epsilon keeps an exact power of two (2048 / 512 = 4) from rounding
  // down to the level below.
  const k = Math.floor(Math.log2(ratio) + 1e-9);
  return Math.min(Math.max(k, -1), maxLevel) + 0.5;
}

// Mesh density: 256 segments per full turn of yaw, 128 per half turn of pitch.
const SEGMENTS_U = 256;
const SEGMENTS_V = 128;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The part of each patch the layer draws: its rect, cut back to mid-overlap. */
export function patchCoreRects(
  patches: readonly Pick<PreviewPatch, 'x' | 'y' | 'w' | 'h'>[],
): Rect[] {
  return patches.map((p) => {
    const core: Rect = { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
    for (const q of patches) {
      if (q === p) continue;
      const qx1 = q.x + q.w;
      const qy1 = q.y + q.h;
      const rowsOverlap = q.y < p.y + p.h && p.y < qy1;
      const colsOverlap = q.x < p.x + p.w && p.x < qx1;
      if (rowsOverlap) {
        if (q.x < p.x && p.x < qx1) core.x0 = Math.max(core.x0, (p.x + qx1) / 2);
        if (q.x < p.x + p.w && p.x + p.w < qx1) core.x1 = Math.min(core.x1, (q.x + p.x + p.w) / 2);
      }
      if (colsOverlap) {
        if (q.y < p.y && p.y < qy1) core.y0 = Math.max(core.y0, (p.y + qy1) / 2);
        if (q.y < p.y + p.h && p.y + p.h < qy1) core.y1 = Math.min(core.y1, (q.y + p.y + p.h) / 2);
      }
    }
    return core;
  });
}

/** A sphere-patch mesh over `core` (source px), with UVs into the patch's own image. */
export function buildEquirectPatchGeometry(
  width: number,
  height: number,
  patch: Pick<PreviewPatch, 'x' | 'y' | 'w' | 'h'>,
  core: Rect,
): TileGeometry {
  const u0 = core.x0 / width;
  const u1 = core.x1 / width;
  const v0 = core.y0 / height;
  const v1 = core.y1 / height;
  const cols = Math.max(1, Math.ceil((u1 - u0) * SEGMENTS_U));
  const rows = Math.max(1, Math.ceil((v1 - v0) * SEGMENTS_V));
  const count = (cols + 1) * (rows + 1);
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let k = 0;
  for (let j = 0; j <= rows; j++) {
    const v = v0 + ((v1 - v0) * j) / rows;
    for (let i = 0; i <= cols; i++) {
      const u = u0 + ((u1 - u0) * i) / cols;
      const d = equirectUVToDir(u, v);
      pos[k * 3] = d.x * RADIUS;
      pos[k * 3 + 1] = d.y * RADIUS;
      pos[k * 3 + 2] = d.z * RADIUS;
      uv[k * 2] = (u * width - patch.x) / patch.w;
      uv[k * 2 + 1] = (v * height - patch.y) / patch.h;
      k++;
    }
  }
  const index = new Uint16Array(cols * rows * 6);
  let n = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + cols + 1;
      index[n++] = a;
      index[n++] = b;
      index[n++] = a + 1;
      index[n++] = a + 1;
      index[n++] = b;
      index[n++] = b + 1;
    }
  }
  return { pos, uv, index };
}

type PreviewRenderer = Pick<GLRenderer, 'uploadTile' | 'removeTile' | 'maxTextureSize'>;

function closeImage(image: PreviewPatch['image']): void {
  if ('close' in image && typeof image.close === 'function') image.close();
}

/** Close every ImageBitmap in a source; canvases are left alone. */
export function closePreviewSource(source: PreviewSource): void {
  for (const p of source.patches) closeImage(p.image);
}

function validate(source: PreviewSource, limit: number): void {
  const { width, height, patches } = source;
  if (!(width > 0 && height > 0)) throw new RangeError('preview source has no size');
  if (patches.length === 0) throw new RangeError('preview source has no patches');
  for (const p of patches) {
    if (!(
      p.w > 0 &&
      p.h > 0 &&
      p.x >= 0 &&
      p.y >= 0 &&
      p.x + p.w <= width &&
      p.y + p.h <= height
    )) {
      throw new RangeError(
        `preview patch ${p.x},${p.y} ${p.w}x${p.h} is outside ${width}x${height}`,
      );
    }
    const { width: iw, height: ih } = p.image;
    if (!(iw > 0 && ih > 0)) throw new RangeError('preview patch image is empty or already closed');
    if (iw > limit || ih > limit) {
      throw new RangeError(`preview patch image ${iw}x${ih} exceeds the ${limit}px limit`);
    }
  }
}

/** Draws a {@link PreviewSource} as sphere-patch meshes, one texture per patch. */
export class EquirectLayer {
  private handles: TileHandle[] = [];
  private items: DrawItem[] = [];
  /** Width of the source equirect, in pixels; what {@link previewDrawLevel} needs. */
  readonly width: number;

  constructor(
    private renderer: PreviewRenderer,
    source: PreviewSource,
  ) {
    this.width = source.width;
    try {
      validate(source, Math.min(PREVIEW_MAX_PATCH_PX, renderer.maxTextureSize));
      const cores = patchCoreRects(source.patches);
      source.patches.forEach((p, i) => {
        const geom = buildEquirectPatchGeometry(source.width, source.height, p, cores[i]!);
        this.handles.push(renderer.uploadTile(geom, p.image));
      });
    } catch (err) {
      this.dispose();
      throw err;
    } finally {
      // The textures own the pixels now; free the CPU copies straight away.
      closePreviewSource(source);
    }
    // Level 0 until a load() places it: with no tiles on screen the level
    // orders nothing.
    this.items = this.handles.map((handle) => ({ handle, level: 0 }));
  }

  drawList(): DrawItem[] {
    return this.items;
  }

  /** Set the draw-list level the patches paint at; see {@link previewDrawLevel}. */
  setLevel(level: number): void {
    for (const item of this.items) item.level = level;
  }

  dispose(): void {
    for (const h of this.handles) this.renderer.removeTile(h);
    this.handles = [];
    this.items = [];
  }
}
