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
    // Upright images: TL samples (0,0), BR samples (1,1).
    expect([...uv]).toEqual([0, 0, 1, 0, 0, 1, 1, 1]);
    expect([...index]).toEqual([0, 2, 1, 1, 2, 3]);
  });

  it('shares one uv and index array across tiles', () => {
    const a = buildTileGeometry('pz', 0, 0, 0);
    const b = buildTileGeometry('nx', 2, 1, 3);
    expect(b.uv).toBe(a.uv);
    expect(b.index).toBe(a.index);
    expect(b.pos).not.toBe(a.pos);
  });
});
