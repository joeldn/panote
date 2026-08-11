export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** NDC (x,y in [-1,1], y up) → CSS pixels (y down) within w×h. */
export function ndcToPixel(
  ndcX: number,
  ndcY: number,
  w: number,
  h: number,
): { x: number; y: number } {
  return { x: (ndcX * 0.5 + 0.5) * w, y: (-ndcY * 0.5 + 0.5) * h };
}

/** Direction is behind the camera when it opposes the forward vector. */
export function isBehind(dir: Vec3, forward: Vec3): boolean {
  return dir.x * forward.x + dir.y * forward.y + dir.z * forward.z <= 0;
}

/** Unit direction for a (yaw,pitch), matching the camera convention. */
export function dirFromYawPitch(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}
