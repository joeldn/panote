import { describe, it, expect } from 'vitest';
import { buildTileGeometry, RADIUS } from './tile-geometry.js';

describe('buildTileGeometry', () => {
  it('produces a flat 4-vert quad on the cube face as plain typed arrays', () => {
    const { pos, uv, index } = buildTileGeometry('pz', 0, 0, 0);
    expect(pos).toBeInstanceOf(Float32Array);
    expect(uv).toBeInstanceOf(Float32Array);
    expect(index).toBeInstanceOf(Uint16Array);
    expect(pos.length).toBe(12); // 4 verts × 3
    // pz face, full tile: corners on the flat cube face at ±RADIUS.
    expect([...pos]).toEqual([
      -RADIUS,
      RADIUS,
      RADIUS,
      RADIUS,
      RADIUS,
      RADIUS,
      -RADIUS,
      -RADIUS,
      RADIUS,
      RADIUS,
      -RADIUS,
      RADIUS,
    ]);
    expect([...uv]).toEqual([0, 1, 1, 1, 0, 0, 1, 0]);
    expect([...index]).toEqual([0, 2, 1, 1, 2, 3]);
  });
});
