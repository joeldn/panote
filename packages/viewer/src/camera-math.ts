import { VIEWER_DEFAULTS } from './defaults.js';

const TWO_PI = Math.PI * 2;

/** `pitch` within [min, max]; the defaults stop just short of straight up and down. */
export function clampPitch(
  pitch: number,
  min: number = VIEWER_DEFAULTS.camera.minPitch,
  max: number = VIEWER_DEFAULTS.camera.maxPitch,
): number {
  return Math.min(max, Math.max(min, pitch));
}

export function clampFov(fov: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, fov));
}

/** Radians of view rotation per screen pixel at the screen centre for a given fov (radians) across `dimensionPx`. */
export function anglePerPixel(fovRad: number, dimensionPx: number): number {
  return (2 * Math.tan(fovRad / 2)) / dimensionPx;
}

/**
 * The camera (yaw, pitch) that keeps the scene direction under the screen
 * point (nx, ny) (NDC, −1..1, y up) at that point through a zoom: from
 * (yaw0, pitch0) with half-fov tangents (tx0, ty0) to tangents (tx1, ty1).
 * Exact anywhere on screen and at any pitch, not only on the centre lines.
 * The pitch is held to [minPitch, maxPitch], and the yaw is then the best one
 * for that pitch, so the clamp eases the point off rather than jumping it.
 * Written into `out`; the yaw is the one nearest yaw0.
 */
export function zoomAnchorView(
  out: { yaw: number; pitch: number },
  yaw0: number,
  pitch0: number,
  nx: number,
  ny: number,
  tx0: number,
  ty0: number,
  tx1: number,
  ty1: number,
  minPitch: number,
  maxPitch: number,
): { yaw: number; pitch: number } {
  // The point's ray before the zoom, camera space (x right, y up, −z ahead),
  // turned by pitch0 about x and then by yaw0 about y into the world.
  const cx = nx * tx0;
  const cy = ny * ty0;
  const len0 = Math.sqrt(cx * cx + cy * cy + 1);
  const sp0 = Math.sin(pitch0);
  const cp0 = Math.cos(pitch0);
  const wy = (cy * cp0 + sp0) / len0;
  const hz = cy * sp0 - cp0; // camera-space z after the pitch, unscaled
  const heading = yaw0 + Math.atan2(cx, -hz); // the ray's world yaw

  // The point's ray after the zoom. Pitch it so its height matches the
  // world ray's: (cy1, 1) at angle atan(cy1) above ahead, of length r,
  // pitched by p rises to r·sin(p + atan(cy1)). Of the two angles with that
  // sine, take the one on the same side of straight up (or down) as the ray
  // was, so a ray past the pole stays past it instead of the pitch jumping.
  const cx1 = nx * tx1;
  const cy1 = ny * ty1;
  const len1 = Math.sqrt(cx1 * cx1 + cy1 * cy1 + 1);
  const r = Math.sqrt(cy1 * cy1 + 1) / len1;
  const s = wy / r;
  const rise = Math.asin(s < -1 ? -1 : s > 1 ? 1 : s);
  const was = pitch0 + Math.atan(cy);
  const angle = was > Math.PI / 2 ? Math.PI - rise : was < -Math.PI / 2 ? -Math.PI - rise : rise;
  const pitch = Math.min(maxPitch, Math.max(minPitch, angle - Math.atan(cy1)));
  // Then yaw it so the ray's heading matches too.
  const hz1 = cy1 * Math.sin(pitch) - Math.cos(pitch);
  const yaw = heading - Math.atan2(cx1, -hz1);
  out.yaw = yaw0 + normalizeAngle(yaw - yaw0);
  out.pitch = pitch;
  return out;
}

/** Move `current` a fraction `factor` (0..1) toward `target`. */
export function damp(current: number, target: number, factor: number): number {
  return current + (target - current) * factor;
}

/** Pinch zoom factor: ratio of previous to current pointer distance (pinch-in zooms out). */
export function pinchFactor(prevDist: number, dist: number): number {
  return prevDist / dist;
}

/** Wrap a radians angle into (−π, π]. */
export function normalizeAngle(angle: number): number {
  const wrapped = angle % TWO_PI;
  if (wrapped > Math.PI) return wrapped - TWO_PI;
  if (wrapped <= -Math.PI) return wrapped + TWO_PI;
  return wrapped;
}

/** Compass heading (radians) of `north` relative to the current `yaw`, wrapped to (−π, π]. */
export function compassHeading(yaw: number, north: number): number {
  return normalizeAngle(north - yaw);
}
