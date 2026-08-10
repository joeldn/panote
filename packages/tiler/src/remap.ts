import { faceUVToDir, dirToEquirectUV, type Face } from '@panote/core';

export interface RgbImage {
  data: Buffer | Uint8Array;
  width: number;
  height: number;
  channels: 3;
}

function sampleBilinear(src: RgbImage, u: number, v: number, out: [number, number, number]): void {
  // u in [0,1) wraps horizontally; v in [0,1] clamps vertically.
  const fx = u * src.width - 0.5;
  const fy = v * src.height - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const dx = fx - x0;
  const dy = fy - y0;
  const wrapX = (x: number) => ((x % src.width) + src.width) % src.width;
  const clampY = (y: number) => Math.min(src.height - 1, Math.max(0, y));
  const [px0, px1] = [wrapX(x0), wrapX(x0 + 1)];
  const [py0, py1] = [clampY(y0), clampY(y0 + 1)];
  for (let c = 0; c < 3; c++) {
    const i00 = (py0 * src.width + px0) * 3 + c;
    const i10 = (py0 * src.width + px1) * 3 + c;
    const i01 = (py1 * src.width + px0) * 3 + c;
    const i11 = (py1 * src.width + px1) * 3 + c;
    // px*/py* are wrapped/clamped in-bounds and c < 3, so these reads are
    // always defined; assert to avoid per-pixel nullish-coalescing branches.
    const s00 = src.data[i00] as number;
    const s10 = src.data[i10] as number;
    const s01 = src.data[i01] as number;
    const s11 = src.data[i11] as number;
    const top = s00 * (1 - dx) + s10 * dx;
    const bot = s01 * (1 - dx) + s11 * dx;
    out[c] = top * (1 - dy) + bot * dy;
  }
}

/** Render a single cube face (size×size, RGB) from an equirect source. */
export function renderFace(src: RgbImage, face: Face, size: number): Buffer {
  const out = Buffer.alloc(size * size * 3);
  const sample: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < size; j++) {
    const v = (j + 0.5) / size;
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;
      const dir = faceUVToDir(face, u, v);
      const eq = dirToEquirectUV(dir);
      sampleBilinear(src, eq.u, eq.v, sample);
      const o = (j * size + i) * 3;
      out[o] = Math.round(sample[0]);
      out[o + 1] = Math.round(sample[1]);
      out[o + 2] = Math.round(sample[2]);
    }
  }
  return out;
}
