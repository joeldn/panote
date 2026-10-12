/**
 * Cube and equirect conventions the viewer renders with. Pure functions, no
 * DOM. The face convention must match whatever wrote the tiles; cube.test.ts
 * checks it against the tiler's copy so the two can't drift.
 */

import type { Vec3 } from './project.js';

export const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;
export type Face = (typeof FACES)[number];

/**
 * Map a face UV (u,v in [0,1], image-space: u left→right, v top→bottom) to a
 * direction on the unit cube (major axis = ±1, not normalised).
 */
export function faceUVToDir(face: Face, u: number, v: number): Vec3 {
  return faceUVInto({ x: 0, y: 0, z: 0 }, face, u, v);
}

/** {@link faceUVToDir} written into `out`, for loops that run per tile. */
export function faceUVInto(out: Vec3, face: Face, u: number, v: number): Vec3 {
  const sc = 2 * u - 1;
  const tc = 2 * v - 1;
  // Add 0 to each component to normalise -0 → +0 (JS quirk with toEqual).
  switch (face) {
    case 'px':
      return set(out, 1, -tc + 0, -sc + 0);
    case 'nx':
      return set(out, -1, -tc + 0, sc + 0);
    case 'py':
      return set(out, sc + 0, 1, tc + 0);
    case 'ny':
      return set(out, sc + 0, -1, -tc + 0);
    case 'pz':
      return set(out, sc + 0, -tc + 0, 1);
    case 'nz':
      return set(out, -sc + 0, -tc + 0, -1);
  }
}

function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

const TAU = Math.PI * 2;

/**
 * The unit direction an equirect UV samples: u = yaw/2π + 0.5 and
 * v = 0.5 − pitch/π, with yaw measured from −z towards +x and v = 0 at the top.
 */
export function equirectUVToDir(u: number, v: number): Vec3 {
  const lon = (u - 0.5) * TAU;
  const lat = (0.5 - v) * Math.PI;
  const c = Math.cos(lat);
  return { x: Math.sin(lon) * c, y: Math.sin(lat), z: -Math.cos(lon) * c };
}

/** Tiles along one face edge at a pyramid level. */
export function tilesPerEdge(level: number): number {
  return 2 ** level;
}
