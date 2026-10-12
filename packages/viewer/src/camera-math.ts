/** A whole turn, radians. */
export const TAU = Math.PI * 2;

/** `value` within [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
 * A screen point as camera-space tangents: x right and y up on the plane at
 * depth 1 ahead of the camera. NDC times the half-fov tangents.
 */
export interface Tangents {
  x: number;
  y: number;
}

/** Pitch limits, radians. */
export interface PitchLimits {
  minPitch: number;
  maxPitch: number;
}

/**
 * The world direction of the ray through the screen point `at` for
 * `camera`. The yaw is the one nearest the camera's. Written into `out`,
 * which may be `camera`.
 */
export function rayAt(out: YawPitch, camera: YawPitch, at: Tangents): YawPitch {
  const { yaw, pitch } = camera;
  const tx = at.x;
  const ty = at.y;
  // Turned by pitch about x and then by yaw about y into the world.
  const len = Math.sqrt(tx * tx + ty * ty + 1);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const wy = (ty * cp + sp) / len;
  const hz = ty * sp - cp; // camera-space z after the pitch, unscaled
  out.yaw = yaw + Math.atan2(tx, -hz);
  out.pitch = Math.asin(clamp(wy, -1, 1));
  return out;
}

/**
 * The camera that puts the world direction `ray` under the screen point
 * `at`.
 *
 * Two families of cameras do it, one each side of straight up or down. It
 * stays with the family the ray is in for the reference camera `ref`, the
 * one on screen now: past the pole if the ray is past it, otherwise in
 * front. That keeps every step continuous. The other family is exact too,
 * but reaching it means turning the camera round (up to about 70° for one
 * wheel notch near a pole), which is a worse jump than the point easing off.
 *
 * When that camera is exact and inside `limits` it is the answer. Otherwise
 * (the pitch it needs is past a limit, or the point is too far off the
 * vertical centre line to show a ray that near the pole) the pitch is held
 * at a limit, taking the held camera that lands the ray nearest the point,
 * so the point eases off instead of jumping. The yaw is the one nearest
 * `ref`'s, never wrapped across ±π (damping would swing the long way round).
 * Written into `out`, which may be `ray` or `ref`.
 */
export function aimRay(
  out: YawPitch,
  ray: YawPitch,
  at: Tangents,
  ref: YawPitch,
  limits: PitchLimits,
): YawPitch {
  const rayYaw = ray.yaw;
  const rayPitch = ray.pitch;
  const yawRef = ref.yaw;
  const pitchRef = ref.pitch;
  const { minPitch, maxPitch } = limits;
  const tx = at.x;
  const ty = at.y;
  const sinRayPitch = Math.sin(rayPitch);
  const cosRayPitch = Math.cos(rayPitch);
  // Which side of the pole the ray is on now: its angle above the horizon
  // in the reference camera's vertical plane, past ±π/2 when past the pole.
  // (The ray in the reference camera: unturned by its yaw, then its pitch.)
  const sinRefPitch = Math.sin(pitchRef);
  const cosRefPitch = Math.cos(pitchRef);
  const zr = -cosRayPitch * Math.cos(rayYaw - yawRef);
  const was =
    pitchRef +
    Math.atan2(
      sinRayPitch * cosRefPitch + zr * sinRefPitch,
      sinRayPitch * sinRefPitch - zr * cosRefPitch,
    );
  // The candidate pitches below, by which side of straight up or down the
  // camera ends up on: 0 in front, 1 past straight up, 2 past straight down.
  const side = was > Math.PI / 2 ? 1 : was < -Math.PI / 2 ? 2 : 0;
  // (ty, 1) is at angle atan(ty) above ahead with length r; pitched by p it
  // rises to r·sin(p + atan(ty)), which must match the ray's height. With
  // |s| > 1 no pitch reaches it.
  const len = Math.sqrt(tx * tx + ty * ty + 1);
  const r = Math.sqrt(ty * ty + 1) / len;
  const s = sinRayPitch / r;
  const rise = Math.asin(clamp(s, -1, 1));
  const up = Math.atan(ty);
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
    const yaw = rayYaw - Math.atan2(tx, Math.cos(pitch) - ty * Math.sin(pitch));
    if (i === side && !inexact) {
      out.yaw = yawRef + normalizeAngle(yaw - yawRef);
      out.pitch = pitch;
      return out;
    }
    // How near the ray lands to the point: the ray in this camera against
    // the point's direction.
    const dyaw = rayYaw - yaw;
    const x = cosRayPitch * Math.sin(dyaw);
    const z = -cosRayPitch * Math.cos(dyaw);
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    const fit = (x * tx + (sinRayPitch * cp + z * sp) * ty + (sinRayPitch * sp - z * cp)) / len;
    if (fit > bestFit) {
      bestFit = fit;
      out.yaw = yawRef + normalizeAngle(yaw - yawRef);
      out.pitch = pitch;
    }
  }
  return out;
}

/**
 * The camera that keeps the scene direction under a screen point at that
 * point through a zoom, from the camera `from`: the point is at tangents
 * `before` at the old fov and `after` at the new one. Exact anywhere on
 * screen and at any pitch; see {@link aimRay} for the pole and the pitch
 * limits. Written into `out`.
 */
export function zoomAnchorView(
  out: YawPitch,
  from: YawPitch,
  before: Tangents,
  after: Tangents,
  limits: PitchLimits,
): YawPitch {
  rayAt(out, from, before);
  return aimRay(out, out, after, from, limits);
}

/** Move `current` a fraction `factor` (0..1) toward `target`. */
export function damp(current: number, target: number, factor: number): number {
  return current + (target - current) * factor;
}

/**
 * Pinch zoom factor: the finger distance (or Safari gesture scale) when the
 * pinch started over the current one. Spreading the fingers gives a factor
 * below 1, which zooms in.
 */
export function pinchFactor(start: number, current: number): number {
  return start / current;
}

/** Wrap a radians angle into (−π, π]. */
export function normalizeAngle(angle: number): number {
  const wrapped = angle % TAU;
  if (wrapped > Math.PI) return wrapped - TAU;
  if (wrapped <= -Math.PI) return wrapped + TAU;
  return wrapped;
}

/** Compass heading (radians) of `north` relative to the current `yaw`, wrapped to (−π, π]. */
export function compassHeading(yaw: number, north: number): number {
  return normalizeAngle(north - yaw);
}
