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
 * under the screen point at camera-space tangents (cx, cy).
 *
 * Two families of cameras do it, one each side of straight up or down. It
 * stays with the family the ray is in for the reference camera (yawRef,
 * pitchRef), the one on screen now: past the pole if the ray is past it,
 * otherwise in front. That keeps every step continuous. The other family is
 * exact too, but reaching it means turning the camera round (up to about
 * 70° for one wheel notch near a pole), which is a worse jump than the
 * point easing off.
 *
 * When that camera is exact and inside [minPitch, maxPitch] it is the
 * answer. Otherwise (the pitch it needs is past a limit, or the point is too
 * far off the vertical centre line to show a ray that near the pole) the
 * pitch is held at a limit, taking the held camera that lands the ray
 * nearest the point, so the point eases off instead of jumping. The yaw is
 * the one nearest yawRef, never wrapped across ±π (damping would swing the
 * long way round). Written into `out`.
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
  const srp = Math.sin(rayPitch);
  const crp = Math.cos(rayPitch);
  // Which side of the pole the ray is on now: its angle above the horizon
  // in the reference camera's vertical plane, past ±π/2 when past the pole.
  // (The ray in the reference camera: unturned by its yaw, then its pitch.)
  const spr = Math.sin(pitchRef);
  const cpr = Math.cos(pitchRef);
  const zr = -crp * Math.cos(rayYaw - yawRef);
  const was = pitchRef + Math.atan2(srp * cpr + zr * spr, srp * spr - zr * cpr);
  const side = was > Math.PI / 2 ? 1 : was < -Math.PI / 2 ? 2 : 0;
  // (cy, 1) is at angle atan(cy) above ahead with length r; pitched by p it
  // rises to r·sin(p + atan(cy)), which must match the ray's height. With
  // |s| > 1 no pitch reaches it.
  const len = Math.sqrt(cx * cx + cy * cy + 1);
  const r = Math.sqrt(cy * cy + 1) / len;
  const s = srp / r;
  const rise = Math.asin(s < -1 ? -1 : s > 1 ? 1 : s);
  const up = Math.atan(cy);
  let bestFit = -Infinity;
  for (let i = 0; i < 3; i++) {
    const angle = i === 0 ? rise : i === 1 ? Math.PI - rise : -Math.PI - rise;
    const exact = angle - up;
    const pitch = Math.min(maxPitch, Math.max(minPitch, exact));
    const inexact = s < -1 || s > 1 || exact !== pitch;
    // The other family's exact camera is a turn round: never taken.
    if (i !== side && !inexact) continue;
    // Then yaw it so the ray's heading matches too (for a held pitch, that
    // is also the yaw that brings the ray nearest the point).
    const yaw = rayYaw - Math.atan2(cx, Math.cos(pitch) - cy * Math.sin(pitch));
    if (i === side && !inexact) {
      out.yaw = yawRef + normalizeAngle(yaw - yawRef);
      out.pitch = pitch;
      return out;
    }
    // How near the ray lands to the point: the ray in this camera against
    // the point's direction.
    const dyaw = rayYaw - yaw;
    const x = crp * Math.sin(dyaw);
    const z = -crp * Math.cos(dyaw);
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    const fit = (x * cx + (srp * cp + z * sp) * cy + (srp * sp - z * cp)) / len;
    if (fit > bestFit) {
      bestFit = fit;
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
