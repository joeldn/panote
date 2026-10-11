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

/** A direction as yaw and pitch, or a camera's yaw and pitch. */
export interface YawPitch {
  yaw: number;
  pitch: number;
}

/**
 * The world direction (yaw, pitch) of the ray through the screen point at
 * camera-space tangents (cx, cy) (x right, y up, at depth 1 ahead), for a
 * camera at (yaw, pitch). The yaw is the one nearest the camera's.
 * Written into `out`.
 */
export function rayAt(out: YawPitch, yaw: number, pitch: number, cx: number, cy: number): YawPitch {
  // Turned by pitch about x and then by yaw about y into the world.
  const len = Math.sqrt(cx * cx + cy * cy + 1);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const wy = (cy * cp + sp) / len;
  const hz = cy * sp - cp; // camera-space z after the pitch, unscaled
  out.yaw = yaw + Math.atan2(cx, -hz);
  out.pitch = Math.asin(wy < -1 ? -1 : wy > 1 ? 1 : wy);
  return out;
}

/**
 * The camera (yaw, pitch) that puts the world direction (rayYaw, rayPitch)
 * under the screen point at camera-space tangents (cx, cy). Of the cameras
 * that do (one each side of straight up or down), it takes the one nearest
 * the reference camera (yawRef, pitchRef), so a ray past the pole stays past
 * it rather than the camera flipping. The pitch is held to
 * [minPitch, maxPitch] and the yaw is then the best one for that pitch, so
 * the clamp eases the point off instead of jumping it. The yaw is the one
 * nearest yawRef, never wrapped across ±π (damping would swing the long way
 * round). Written into `out`.
 */
export function aimRay(
  out: YawPitch,
  rayYaw: number,
  rayPitch: number,
  cx: number,
  cy: number,
  yawRef: number,
  pitchRef: number,
  minPitch: number,
  maxPitch: number,
): YawPitch {
  // (cy, 1) is at angle atan(cy) above ahead with length r; pitched by p it
  // rises to r·sin(p + atan(cy)), which must match the ray's height.
  const len = Math.sqrt(cx * cx + cy * cy + 1);
  const r = Math.sqrt(cy * cy + 1) / len;
  const s = Math.sin(rayPitch) / r;
  const rise = Math.asin(s < -1 ? -1 : s > 1 ? 1 : s);
  const up = Math.atan(cy);
  const spr = Math.sin(pitchRef);
  const cpr = Math.cos(pitchRef);
  let best = -Infinity;
  for (let i = 0; i < 3; i++) {
    const angle = i === 0 ? rise : i === 1 ? Math.PI - rise : -Math.PI - rise;
    const pitch = Math.min(maxPitch, Math.max(minPitch, angle - up));
    // Then yaw it so the ray's heading matches too.
    const yaw = rayYaw - Math.atan2(cx, Math.cos(pitch) - cy * Math.sin(pitch));
    const near = Math.cos(pitch) * cpr * Math.cos(yaw - yawRef) + Math.sin(pitch) * spr;
    if (near > best) {
      best = near;
      out.yaw = yawRef + normalizeAngle(yaw - yawRef);
      out.pitch = pitch;
    }
  }
  return out;
}

/**
 * The camera (yaw, pitch) that keeps the scene direction under the screen
 * point (nx, ny) (NDC, −1..1, y up) at that point through a zoom: from
 * (yaw0, pitch0) with half-fov tangents (tx0, ty0) to tangents (tx1, ty1).
 * Exact anywhere on screen and at any pitch; see {@link aimRay} for the
 * pole and the pitch limits. Written into `out`.
 */
export function zoomAnchorView(
  out: YawPitch,
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
): YawPitch {
  rayAt(out, yaw0, pitch0, nx * tx0, ny * ty0);
  return aimRay(out, out.yaw, out.pitch, nx * tx1, ny * ty1, yaw0, pitch0, minPitch, maxPitch);
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
