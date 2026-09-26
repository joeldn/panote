const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

export function clampPitch(pitch: number): number {
  const limit = HALF_PI - 0.001;
  return Math.min(limit, Math.max(-limit, pitch));
}

export function clampFov(fov: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, fov));
}

/** Radians of view rotation per screen pixel at the screen centre for a given fov (radians) across `dimensionPx`. */
export function anglePerPixel(fovRad: number, dimensionPx: number): number {
  return (2 * Math.tan(fovRad / 2)) / dimensionPx;
}

/**
 * Camera rotation (radians) needed along one axis to keep the world point at
 * normalized screen coord `ndc` (−1..1) fixed when the fov changes fov0→fov1 (radians).
 */
export function zoomAnchorDelta(ndc: number, fov0Rad: number, fov1Rad: number): number {
  return Math.atan(ndc * Math.tan(fov0Rad / 2)) - Math.atan(ndc * Math.tan(fov1Rad / 2));
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
