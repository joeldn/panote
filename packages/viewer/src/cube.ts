import type { Vec3 } from './project.js';

/**
 * Cube and equirect conventions the viewer renders with. Pure functions, no
 * DOM. The face convention must match whatever wrote the tiles; cube.test.ts
 * checks it against the tiler's copy so the two can't drift.
 */

export const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;
export type Face = (typeof FACES)[number];

/**
 * Map a face UV (u,v in [0,1], image-space: u left→right, v top→bottom) to a
 * direction on the unit cube (major axis = ±1, not normalised).
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

/** Four UV corners in top-left, top-right, bottom-left, bottom-right order. */
export function tileCornersUV(
  level: number,
  x: number,
  y: number,
): [
  { u: number; v: number },
  { u: number; v: number },
  { u: number; v: number },
  { u: number; v: number },
] {
  const g = tilesPerEdge(level);
  const u0 = x / g;
  const v0 = y / g;
  const u1 = (x + 1) / g;
  const v1 = (y + 1) / g;
  return [
    { u: u0, v: v0 },
    { u: u1, v: v0 },
    { u: u0, v: v1 },
    { u: u1, v: v1 },
  ];
}
