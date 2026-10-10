export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * NDC (x,y in [-1,1], y up) → CSS pixels (y down) within w×h. Writes into
 * `out` when given, so a caller can skip the allocation.
 */
export function ndcToPixel(
  ndcX: number,
  ndcY: number,
  w: number,
  h: number,
): { x: number; y: number };
export function ndcToPixel<T extends { x: number; y: number }>(
  ndcX: number,
  ndcY: number,
  w: number,
  h: number,
  out: T,
): T;
export function ndcToPixel(
  ndcX: number,
  ndcY: number,
  w: number,
  h: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  out.x = (ndcX * 0.5 + 0.5) * w;
  out.y = (-ndcY * 0.5 + 0.5) * h;
  return out;
}

/** Direction is behind the camera when it opposes the forward vector. */
export function isBehind(dir: Vec3, forward: Vec3): boolean {
  return dir.x * forward.x + dir.y * forward.y + dir.z * forward.z <= 0;
}

/** Unit direction for a (yaw,pitch), matching the camera convention. */
export function dirFromYawPitch(yaw: number, pitch: number): Vec3 {
  return dirInto({ x: 0, y: 0, z: 0 }, yaw, pitch);
}

/** {@link dirFromYawPitch} written into `out`. */
export function dirInto(out: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  out.x = Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}
