export function nextPow2(n: number): number {
  return 2 ** Math.ceil(Math.log2(n));
}

export function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Native cube-face edge size in pixels. Derived from the equirect source width
 * (a face spans a quarter of the 360° width), rounded up to a power of two, and
 * never below tileSize. An optional maxSize cap is rounded DOWN to a power of two
 * so the cap is never exceeded.
 */
export function computeFaceSize(sourceWidth: number, tileSize: number, maxSize?: number): number {
  let faceSize = nextPow2(Math.ceil(sourceWidth / 4));
  if (maxSize !== undefined) {
    const cap = 2 ** Math.floor(Math.log2(maxSize));
    faceSize = Math.min(faceSize, cap);
  }
  if (faceSize < tileSize) faceSize = tileSize;
  return faceSize;
}

export function computeMaxLevel(faceSize: number, tileSize: number): number {
  return Math.round(Math.log2(faceSize / tileSize));
}
