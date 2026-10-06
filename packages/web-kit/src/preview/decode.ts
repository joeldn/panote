import { readImageSize, type ImageSize } from '../image-size.js';
import {
  patchLimit,
  PHONE_FULL_DECODE_MAX_PIXELS,
  planPatches,
  previewSize,
  type PreviewLimits,
  type PreviewPatch,
  type PreviewSource,
  type PreviewTier,
} from './plan.js';

/** Browser surface the decode needs; injected so tests can fake it. */
export interface DecodeEnv {
  createImageBitmap: typeof globalThis.createImageBitmap;
  /** Absent where `OffscreenCanvas` isn't supported. */
  createCanvas?: ((width: number, height: number) => OffscreenCanvas) | undefined;
  now?: (() => number) | undefined;
}

export interface DecodeRequest {
  tier: PreviewTier;
  limits?: PreviewLimits | undefined;
  /** False skips encoding the stash image (`stash` is then null), e.g. when decoding a stash. */
  stash?: boolean | undefined;
}

/** How the preview was scaled: at decode time, on a canvas, or not at all. */
export type ResizeMethod = 'decode' | 'canvas' | 'none';

export interface PreviewStats {
  sourceWidth: number;
  sourceHeight: number;
  resize: ResizeMethod;
  /** Decode plus any canvas downscale. */
  decodeMs: number;
  totalMs: number;
}

export interface DecodedPreview {
  /** Every patch image is an `ImageBitmap`; `closePreview` frees them. */
  source: PreviewSource;
  /** A small WebP (JPEG where WebP can't be encoded) for stashing; null if encoding failed. */
  stash: Blob | null;
  stats: PreviewStats;
}

/** Longest edges of the stash image, to land it around 2-3 MB. */
export const STASH_SIZE: ImageSize = { width: 4096, height: 2048 };
export const STASH_QUALITY = 0.8;

// A 2x2 grayscale PNG: decoding it with a 1x1 resize shows whether the options are honoured.
const PROBE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAAAAABX3VL4AAAAC0lEQVR4nGNgAAEAAAYAAf6MZ8gAAAAASUVORK5CYII=';

/** Whether `createImageBitmap(blob, { resizeWidth })` really resizes, judged by output width. */
export async function supportsDecodeResize(env: DecodeEnv): Promise<boolean> {
  const bytes = Uint8Array.from(atob(PROBE_PNG), (c) => c.charCodeAt(0));
  try {
    const probe = await env.createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
      resizeWidth: 1,
      resizeHeight: 1,
      resizeQuality: 'high',
    });
    const ok = probe.width === 1 && probe.height === 1;
    probe.close();
    return ok;
  } catch {
    return false;
  }
}

function drawScaled(
  env: DecodeEnv,
  bitmap: ImageBitmap,
  size: ImageSize,
): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  if (!env.createCanvas) throw new Error('OffscreenCanvas is not available');
  const canvas = env.createCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context is not available');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  return { canvas, ctx };
}

async function encodeStash(env: DecodeEnv, bitmap: ImageBitmap): Promise<Blob | null> {
  if (!env.createCanvas) return null;
  const size = previewSize({ width: bitmap.width, height: bitmap.height }, 'phone', {
    maxWidth: STASH_SIZE.width,
  });
  try {
    const { canvas } = drawScaled(env, bitmap, size);
    let blob = await canvas.convertToBlob({ type: 'image/webp', quality: STASH_QUALITY });
    // Safari can't encode WebP and silently hands back a PNG instead.
    if (blob.type !== 'image/webp') {
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: STASH_QUALITY });
    }
    canvas.width = canvas.height = 0;
    return blob;
  } catch {
    return null;
  }
}

/**
 * Decode `file` into a tier-sized, patched preview. Null when the image can't
 * be previewed safely here. Every bitmap it made is closed on abort or error.
 */
export async function decodePreviewImage(
  file: Blob,
  request: DecodeRequest,
  env: DecodeEnv,
  signal?: AbortSignal,
): Promise<DecodedPreview | null> {
  const now = env.now ?? (() => performance.now());
  const started = now();
  const owned: ImageBitmap[] = [];
  const kept = new Set<unknown>();
  const own = (b: ImageBitmap) => (owned.push(b), b);
  const release = (b: ImageBitmap) => {
    b.close();
    owned.splice(owned.indexOf(b), 1);
  };

  try {
    const size = await readImageSize(file);
    signal?.throwIfAborted();
    if (!size) return null;
    const target = previewSize(size, request.tier, request.limits);
    const shrink = target.width !== size.width || target.height !== size.height;
    const atDecode = shrink && (await supportsDecodeResize(env));
    if (shrink && !atDecode) {
      if (!env.createCanvas) return null;
      // Without decode-time resize the full image sits in memory; phones can't afford big ones.
      if (request.tier === 'phone' && size.width * size.height > PHONE_FULL_DECODE_MAX_PIXELS) {
        return null;
      }
    }
    signal?.throwIfAborted();

    let bitmap = own(
      atDecode
        ? await env.createImageBitmap(file, {
            resizeWidth: target.width,
            resizeHeight: target.height,
            resizeQuality: 'high',
          })
        : await env.createImageBitmap(file),
    );
    signal?.throwIfAborted();
    let resize: ResizeMethod = shrink ? 'decode' : 'none';
    if (bitmap.width !== target.width || bitmap.height !== target.height) {
      if (!env.createCanvas) return null;
      const { canvas } = drawScaled(env, bitmap, target);
      release(bitmap);
      bitmap = own(canvas.transferToImageBitmap());
      resize = 'canvas';
    }
    const decodeMs = now() - started;
    signal?.throwIfAborted();

    const stash = request.stash === false ? null : await encodeStash(env, bitmap);
    signal?.throwIfAborted();

    const rects = planPatches(target.width, target.height, patchLimit(request.limits));
    const patches: PreviewPatch[] = [];
    for (const rect of rects) {
      const image =
        rects.length === 1
          ? bitmap
          : own(await env.createImageBitmap(bitmap, rect.x, rect.y, rect.w, rect.h));
      signal?.throwIfAborted();
      patches.push({ ...rect, image });
    }
    for (const p of patches) kept.add(p.image);

    return {
      source: { width: target.width, height: target.height, patches },
      stash,
      stats: {
        sourceWidth: size.width,
        sourceHeight: size.height,
        resize,
        decodeMs,
        totalMs: now() - started,
      },
    };
  } finally {
    for (const b of owned) if (!kept.has(b)) b.close();
  }
}

/** Free every patch image that can be freed. */
export function closePreview(source: PreviewSource): void {
  for (const { image } of source.patches) {
    if ('close' in image) image.close();
    else image.width = image.height = 0;
  }
}

interface DecodeGlobals {
  createImageBitmap: typeof globalThis.createImageBitmap;
  OffscreenCanvas?: typeof OffscreenCanvas | undefined;
}

/** The real browser (or worker) environment. */
export function browserDecodeEnv(
  g: DecodeGlobals = globalThis as unknown as DecodeGlobals,
): DecodeEnv {
  const Canvas = g.OffscreenCanvas;
  return {
    createImageBitmap: g.createImageBitmap.bind(g),
    createCanvas: Canvas ? (w, h) => new Canvas(w, h) : undefined,
  };
}
