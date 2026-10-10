/**
 * How far past a level boundary the ideal level may go before the next level
 * is chosen. 0.2 accepts up to 2^0.2 ≈ 15 % magnification at the formula's
 * average density instead of fetching 4x the tiles for the last few percent.
 */
export const LOD_TOLERANCE = 0.2;

/**
 * Choose the pyramid level whose tile texel density matches screen pixel
 * density for the current vertical FOV. A face spans 90°; at level L a tile
 * spans 90/2^L degrees across `tileSize` texels. We want texel angular size ≤
 * screen pixel angular size (fov / viewportHeight):
 *
 *   (90 / 2^L) / tileSize ≤ fov / viewportHeight
 *   ⇒ 2^L ≥ 90 * viewportHeight / (tileSize * fov)
 *   ⇒ ideal = log2(90 * viewportHeight / (tileSize * fov))
 *
 * Rounding the ideal straight up costs 4x the tiles whenever it lands just
 * past an integer (a DPR-2, 800 px tall, 16:9 view sits at 2.05), so the
 * level is `ceil(ideal − tolerance)`.
 */
export function selectLevel(
  fovDeg: number,
  viewportHeight: number,
  tileSize: number,
  maxLevel: number,
  tolerance = LOD_TOLERANCE,
): number {
  if (!(fovDeg > 0) || !(tileSize > 0) || !(viewportHeight > 0)) return 0;
  const ideal = Math.log2((90 * viewportHeight) / (tileSize * fovDeg));
  if (!Number.isFinite(ideal)) return 0;
  return Math.max(0, Math.min(maxLevel, Math.ceil(ideal - tolerance)));
}
