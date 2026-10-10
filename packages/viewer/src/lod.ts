/**
 * Choose the pyramid level whose tile texel density matches screen pixel
 * density for the current vertical FOV. A face spans 90°; at level L a tile
 * spans 90/2^L degrees across `tileSize` texels. We want texel angular size ≤
 * screen pixel angular size (fov / viewportHeight):
 *
 *   (90 / 2^L) / tileSize ≤ fov / viewportHeight
 *   ⇒ 2^L ≥ 90 * viewportHeight / (tileSize * fov)
 *   ⇒ L = ceil(log2(90 * viewportHeight / (tileSize * fov)))
 */
export function selectLevel(
  fovDeg: number,
  viewportHeight: number,
  tileSize: number,
  maxLevel: number,
): number {
  if (!(fovDeg > 0) || !(tileSize > 0) || !(viewportHeight > 0)) return 0;
  const ideal = Math.log2((90 * viewportHeight) / (tileSize * fovDeg));
  if (!Number.isFinite(ideal)) return 0;
  return Math.max(0, Math.min(maxLevel, Math.ceil(ideal)));
}
