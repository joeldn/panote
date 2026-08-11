import { faceUVToDir, tileCornersUV, type Face } from '@panote/core';

// Builds flat cube-face quad geometry for a tile: a 4-vert quad on the cube
// face at RADIUS, textured with the tile's colour. No depth/displacement.

/** Sphere/cube radius the tiles sit on (shared with tile-layer.ts). */
export const RADIUS = 10;

/** Plain typed-array geometry consumed by the WebGL2 renderer. */
export interface TileGeometry {
  pos: Float32Array; // 4 verts × 3 = 12 floats
  uv: Float32Array; // 4 verts × 2 = 8 floats
  index: Uint16Array; // 2 tris × 3 = 6 indices
}

/** The flat 4-vert quad (TL,TR,BL,BR) on the cube face at RADIUS. */
function buildFlatQuad(face: Face, level: number, x: number, y: number): TileGeometry {
  const corners = tileCornersUV(level, x, y); // TL, TR, BL, BR
  const pos = new Float32Array(4 * 3);
  corners.forEach((c, i) => {
    // faceUVToDir returns a point on the unit CUBE (major axis = ±1). Place the
    // quad on the flat cube face (scaled by RADIUS) — do NOT normalize onto a
    // sphere, or the gnomonic cube-face texture gets bowed.
    const d = faceUVToDir(face, c.u, c.v);
    pos[i * 3] = d.x * RADIUS;
    pos[i * 3 + 1] = d.y * RADIUS;
    pos[i * 3 + 2] = d.z * RADIUS;
  });
  const uv = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]); // TL,TR,BL,BR, v flipped
  const index = new Uint16Array([0, 2, 1, 1, 2, 3]);
  return { pos, uv, index };
}

/** Build the flat 4-vert quad geometry for a tile on the cube face. */
export function buildTileGeometry(face: Face, level: number, x: number, y: number): TileGeometry {
  return buildFlatQuad(face, level, x, y);
}
