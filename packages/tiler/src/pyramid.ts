import { ALLOWED_TILE_SIZES, MAX_FACE_SIZE, MAX_LEVEL_CAP } from '@panote/core';

export function nextPow2(n: number): number {
  return 2 ** Math.ceil(Math.log2(n));
}

export function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Hard cap on the *source* pixel count (width * height), enforced in
 * build() right after reading metadata and before the full-resolution raw
 * RGB decode (`sharp(opts.src).removeAlpha().raw().toBuffer()`).
 *
 * This protects a different thing than MAX_FACE_SIZE below, and one does not
 * substitute for the other: MAX_FACE_SIZE bounds the *output* — the face
 * size written to every level of the pyramid, and therefore R2 storage
 * spend. MAX_INPUT_PIXELS bounds the *input* decode itself, before any
 * resizing happens, because decoded-pixel count (not compressed file size)
 * is what actually determines libvips' peak memory for that toBuffer() call.
 *
 * The deployed backend (a separate service, not part of this package) also
 * rejects an original before it ever reaches the tiler, via an env var named
 * MAX_ORIGINAL_BYTES — but that is a cap on *compressed* file size (150
 * MiB), and its own comment describes it as sized for "the ~150 MP v1 cap".
 * That description doesn't hold: compression ratio varies enormously by
 * content, and at real panorama compression (~0.22 bytes/px measured on a
 * production sample) 150 MiB of compressed data can decode to roughly
 * 715 MP — nearly 5x what the comment implies. A byte cap on the compressed
 * input is a poor proxy for decode memory regardless of what number it's set
 * to. MAX_INPUT_PIXELS is a real, direct check on the quantity that actually
 * determines decode memory, enforced here so the tiler doesn't depend on an
 * upstream byte cap to have bounded it correctly.
 *
 * 150,000,000 (150 MP) mirrors the origin project's own spike-tested budget
 * (134 MP measured at ~2.08 GiB peak RSS for the full decode+tile pipeline,
 * per the pano-viewer backend plan doc), not an arbitrary guess. Container
 * memory limits happen to catch an oversized decode today too, but that's
 * instance sizing, not a bound this package can rely on — this check is the
 * actual guarantee.
 */
export const MAX_INPUT_PIXELS = 150_000_000;

/**
 * Native cube-face edge size in pixels. Derived from the equirect source width
 * (a face spans a quarter of the 360° width), rounded up to a power of two, and
 * never below tileSize. The maxSize cap is rounded DOWN to a power of two so
 * the cap is never exceeded.
 *
 * Defaults to MAX_FACE_SIZE (16384) so a very large source is gracefully
 * down-capped rather than silently producing an out-of-bounds faceSize. This
 * bounds the *output* face size; it is not a substitute for MAX_INPUT_PIXELS
 * above, which bounds the *input* decode and is what actually protects
 * decode memory.
 */
export function computeFaceSize(
  sourceWidth: number,
  tileSize: number,
  maxSize: number = MAX_FACE_SIZE,
): number {
  let faceSize = nextPow2(Math.ceil(sourceWidth / 4));
  const cap = 2 ** Math.floor(Math.log2(maxSize));
  faceSize = Math.min(faceSize, cap);
  if (faceSize < tileSize) faceSize = tileSize;
  return faceSize;
}

export function computeMaxLevel(faceSize: number, tileSize: number): number {
  return Math.round(Math.log2(faceSize / tileSize));
}

/**
 * Enforces the same pyramid bounds at write time that `@panote/core`'s
 * `parseManifest` enforces at read time (tileSize in ALLOWED_TILE_SIZES,
 * faceSize <= MAX_FACE_SIZE, maxLevel <= MAX_LEVEL_CAP), so the tiler can
 * never produce a pyramid the viewer will refuse to load.
 *
 * This matters more here than in the viewer: a read-time check protects one
 * browser tab, but only a write-time check protects the R2 bill, which is
 * the operator's actual exposure — an oversized pyramid costs real Class A
 * ops the moment it's written, whether or not any viewer ever accepts the
 * manifest.
 */
export function assertPyramidBounds(tileSize: number, faceSize: number, maxLevel: number): void {
  if (!(ALLOWED_TILE_SIZES as readonly number[]).includes(tileSize))
    throw new Error(`tileSize must be one of ${ALLOWED_TILE_SIZES.join(', ')} (got ${tileSize})`);
  if (faceSize > MAX_FACE_SIZE)
    throw new Error(`faceSize must be <= ${MAX_FACE_SIZE} (got ${faceSize})`);
  if (maxLevel > MAX_LEVEL_CAP)
    throw new Error(`maxLevel must be <= ${MAX_LEVEL_CAP} (got ${maxLevel})`);
}
