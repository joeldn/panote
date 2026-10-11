export type Vec3 = { x: number; y: number; z: number };

export const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;
export type Face = (typeof FACES)[number];

/**
 * The face straight ahead at yaw 0, pitch 0: the viewer looks along -z there, which is
 * the middle column of the equirect. The admin's covers fall back to its level-0 tile,
 * flipped left to right: a face laid out by faceUVToDir is mirrored when shown flat.
 */
export const FRONT_FACE: Face = 'nz';

/**
 * Map a face UV (u,v in [0,1], image-space: u left→right, v top→bottom) to a
 * direction on the unit cube. Convention is shared by the tiler and the viewer
 * so generated faces and rendered faces always agree.
 */
export function faceUVToDir(face: Face, u: number, v: number): Vec3 {
  const sc = 2 * u - 1;
  const tc = 2 * v - 1;
  // Add 0 to each component to normalise -0 → +0 (JS quirk with toEqual).
  switch (face) {
    case 'px':
      return { x: 1, y: -tc + 0, z: -sc + 0 };
    case 'nx':
      return { x: -1, y: -tc + 0, z: sc + 0 };
    case 'py':
      return { x: sc + 0, y: 1, z: tc + 0 };
    case 'ny':
      return { x: sc + 0, y: -1, z: -tc + 0 };
    case 'pz':
      return { x: sc + 0, y: -tc + 0, z: 1 };
    case 'nz':
      return { x: -sc + 0, y: -tc + 0, z: -1 };
  }
}

/**
 * The inverse of faceUVToDir: the face a direction (any length, not zero) hits and
 * the image-space UV on it. Ties on a cube edge go to x, then y, then z.
 */
export function dirToFaceUV(dir: Vec3): { face: Face; u: number; v: number } {
  const ax = Math.abs(dir.x);
  const ay = Math.abs(dir.y);
  const az = Math.abs(dir.z);
  // Each case solves faceUVToDir's component formulas for sc and tc, after
  // scaling the direction so its major axis is ±1.
  let face: Face;
  let sc: number;
  let tc: number;
  if (ax >= ay && ax >= az) {
    if (dir.x > 0) {
      face = 'px';
      sc = -dir.z / ax;
    } else {
      face = 'nx';
      sc = dir.z / ax;
    }
    tc = -dir.y / ax;
  } else if (ay >= az) {
    sc = dir.x / ay;
    if (dir.y > 0) {
      face = 'py';
      tc = dir.z / ay;
    } else {
      face = 'ny';
      tc = -dir.z / ay;
    }
  } else {
    tc = -dir.y / az;
    if (dir.z > 0) {
      face = 'pz';
      sc = dir.x / az;
    } else {
      face = 'nz';
      sc = -dir.x / az;
    }
  }
  return { face, u: (sc + 1) / 2, v: (tc + 1) / 2 };
}

const TAU = Math.PI * 2;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Map a direction to equirect UV (u in [0,1), v in [0,1], top=+y). */
export function dirToEquirectUV(dir: Vec3): { u: number; v: number } {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const lon = Math.atan2(dir.x, -dir.z); // [-π, π]
  const lat = Math.asin(clamp(dir.y / len, -1, 1)); // [-π/2, π/2]
  let u = lon / TAU + 0.5;
  u = ((u % 1) + 1) % 1; // wrap into [0,1)
  const v = 0.5 - lat / Math.PI;
  return { u, v };
}
