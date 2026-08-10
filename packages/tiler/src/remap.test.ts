import { describe, it, expect } from 'vitest';
import { renderFace } from './remap.js';

// Build a 4x2 equirect where each pixel encodes its column in the red channel,
// so we can assert which source column a face center samples.
function makeSource(
  w: number,
  h: number,
  fill: (x: number, y: number) => [number, number, number],
) {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return { data, width: w, height: h, channels: 3 as const };
}

describe('renderFace', () => {
  it('produces a size*size*3 buffer', () => {
    const src = makeSource(8, 4, () => [10, 20, 30]);
    const face = renderFace(src, 'px', 4);
    expect(face.length).toBe(4 * 4 * 3);
    expect([...face.subarray(0, 3)]).toEqual([10, 20, 30]);
  });

  it('samples the front (u=0.5) for the nz face center', () => {
    // Red ramps with column; u=0.5 is the middle column.
    const w = 360;
    const src = makeSource(w, 2, (x) => [Math.round((x / (w - 1)) * 255), 0, 0]);
    const face = renderFace(src, 'nz', 2);
    // center pixel of a 2x2 face is pixel (1,1) approx; its red ≈ mid ramp.
    const i = (1 * 2 + 1) * 3;
    expect(face[i]).toBeGreaterThanOrEqual(108);
    expect(face[i]).toBeLessThan(160);
  });
});
