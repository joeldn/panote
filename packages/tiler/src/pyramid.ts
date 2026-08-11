import { ALLOWED_TILE_SIZES, MAX_FACE_SIZE, MAX_LEVEL_CAP } from '@panote/core';

export function nextPow2(n: number): number {
  return 2 ** Math.ceil(Math.log2(n));
}

export function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Native cube-face edge size in pixels. Derived from the equirect source width
 * (a face spans a quarter of the 360° width), rounded up to a power of two, and
 * never below tileSize. The maxSize cap is rounded DOWN to a power of two so
 * the cap is never exceeded.
 *
 * Defaults to MAX_FACE_SIZE (16384) so a very large source is gracefully
 * down-capped rather than silently producing an out-of-bounds faceSize. The
 * ingest byte cap (MAX_ORIGINAL_BYTES in the deployed backend) is not a pixel
 * cap — a compressible source can decode to well over 16384 worth of face
 * size within that byte budget — so this default is the actual pixel bound,
 * not the byte one.
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
