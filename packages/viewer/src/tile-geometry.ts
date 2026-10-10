import { faceUVToDir, tileCornersUV, type Face } from '@panote/core';

// Builds flat cube-face quad geometry for a tile: a 4-vert quad on the cube
// face at RADIUS, textured with the tile's colour. No depth/displacement.

/** Sphere/cube radius the tiles sit on (shared with tile-layer.ts). */
export const RADIUS = 10;

/** Plain typed-array geometry consumed by the WebGL2 renderer: N vertices
 *  (N ≤ 65536, the indices are 16-bit) as xyz positions and texture UVs. */
export interface TileGeometry {
  pos: Float32Array; // N verts × 3 floats (a cube tile quad has N = 4)
  uv: Float32Array; // N verts × 2 floats
  index: Uint16Array; // triangle list, 3 indices per triangle
}

/** Quad UVs (TL,TR,BL,BR), v flipped. Shared by every tile; never mutate. */
const QUAD_UV = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);

/** Quad triangle list. Shared by every tile; never mutate. The renderer
 *  draws 4-vertex geometry from one shared index buffer with this content. */
export const QUAD_INDEX = new Uint16Array([0, 2, 1, 1, 2, 3]);

/**
 * Build the flat 4-vert quad (TL,TR,BL,BR) for a tile on the cube face at
 * RADIUS. Only `pos` is new per tile; `uv` and `index` are the shared
 * QUAD_UV and QUAD_INDEX.
 */
export function buildTileGeometry(face: Face, level: number, x: number, y: number): TileGeometry {
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
  return { pos, uv: QUAD_UV, index: QUAD_INDEX };
}
