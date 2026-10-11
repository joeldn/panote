import sharp from 'sharp';
import { dirToEquirectUV, dirToFaceUV, FACES, type Face, type Vec3 } from '@panote/core';
import { sampleBilinear, type RgbImage } from './remap.js';

/**
 * The link-preview image (og.jpg): a normal-camera view of the pano, the size and
 * format scrapers expect (1.91:1 large card, JPEG).
 */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const OG_QUALITY = 80;
export const OG_FILE = 'og.jpg';

/** A camera: yaw and pitch in radians (the viewer's convention), horizontal fov in degrees. */
export interface View {
  yaw: number;
  pitch: number;
  hfovDeg: number;
}

/**
 * The first frame the viewer shows a scene with no start view on a wide screen: yaw 0
 * (facing -z, the nz face), level, and the viewer's default 70° vertical fov, which at
 * 1200x630 hits the viewer's 100° horizontal cap (packages/viewer/src/defaults.ts:
 * defaultFov 70, maxHorizontalFov 100). The start view is set later in the editor, so
 * the tiler can't know it.
 */
export const OG_VIEW: View = { yaw: 0, pitch: 0, hfovDeg: 100 };

/**
 * Rendered at this multiple of the output size, then downscaled by libvips with a
 * lanczos3 kernel (a low-pass resample, not a plain box average): each output pixel
 * draws on several bilinear samples, so fine detail in a large source softens to
 * its average colour instead of turning into moiré.
 */
const SUPERSAMPLE = 2;

/** Writes the colour seen in direction `dir` (any length) into `out`. */
export type Sampler = (dir: Vec3, out: [number, number, number]) => void;

export function equirectSampler(img: RgbImage): Sampler {
  return (dir, out) => {
    const { u, v } = dirToEquirectUV(dir);
    sampleBilinear(img, u, v, out, true);
  };
}

/** Samples cube faces stored the way the tiler writes them (faceUVToDir's layout). */
export function cubeSampler(faces: Partial<Record<Face, RgbImage>>): Sampler {
  return (dir, out) => {
    const { face, u, v } = dirToFaceUV(dir);
    const img = faces[face];
    if (!img) throw new Error(`cube sampler: face ${face} is in view but was not loaded`);
    sampleBilinear(img, u, v, out, false);
  };
}

const DEG = Math.PI / 180;

/**
 * Calls `visit` with the world direction through the centre of every pixel of a
 * width x height rectilinear image seen from `view`. The camera basis is the viewer's
 * (packages/viewer/src/render/projection.ts): forward (sin yaw·cos pitch, sin pitch,
 * -cos yaw·cos pitch), right (cos yaw, 0, sin yaw), up = right x forward.
 */
function forEachRay(
  width: number,
  height: number,
  view: View,
  visit: (dir: Vec3, x: number, y: number) => void,
): void {
  const cy = Math.cos(view.yaw);
  const sy = Math.sin(view.yaw);
  const cp = Math.cos(view.pitch);
  const sp = Math.sin(view.pitch);
  const f = { x: sy * cp, y: sp, z: -cy * cp };
  const r = { x: cy, y: 0, z: sy };
  const up = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
  const tx = Math.tan((view.hfovDeg * DEG) / 2);
  const ty = (tx * height) / width;
  const dir = { x: 0, y: 0, z: 0 };
  for (let y = 0; y < height; y++) {
    const b = (1 - (2 * (y + 0.5)) / height) * ty;
    for (let x = 0; x < width; x++) {
      const a = ((2 * (x + 0.5)) / width - 1) * tx;
      dir.x = f.x + a * r.x + b * up.x;
      dir.y = f.y + a * r.y + b * up.y;
      dir.z = f.z + a * r.z + b * up.z;
      visit(dir, x, y);
    }
  }
}

/** Renders `view` as raw RGB, width x height, one bilinear sample per pixel. */
export function renderView(sampler: Sampler, width: number, height: number, view: View): Buffer {
  const out = Buffer.alloc(width * height * 3);
  const px: [number, number, number] = [0, 0, 0];
  forEachRay(width, height, view, (dir, x, y) => {
    sampler(dir, px);
    const o = (y * width + x) * 3;
    out[o] = Math.round(px[0]);
    out[o + 1] = Math.round(px[1]);
    out[o + 2] = Math.round(px[2]);
  });
  return out;
}

/** The cube faces an OG render of `view` reads, in FACES order. */
export function facesInView(view: View): Face[] {
  const seen = new Set<Face>();
  forEachRay(OG_WIDTH * SUPERSAMPLE, OG_HEIGHT * SUPERSAMPLE, view, (dir) => {
    seen.add(dirToFaceUV(dir).face);
  });
  return FACES.filter((f) => seen.has(f));
}

/**
 * The cube face size whose pixels are no coarser than the supersampled render's at
 * the image centre (where a face is sparsest relative to the view). A face spans 2
 * units of tangent; the render spans 2·tan(hfov/2) over its supersampled width.
 */
export function ogFaceSize(view: View): number {
  return Math.ceil((OG_WIDTH * SUPERSAMPLE) / Math.tan((view.hfovDeg * DEG) / 2));
}

/**
 * The og.jpg pipeline for `view`: a supersampled render, area-filtered down to
 * 1200x630, JPEG q80 (mozjpeg). The caller ends it with toFile or toBuffer.
 */
export function ogImage(sampler: Sampler, view: View = OG_VIEW): sharp.Sharp {
  const w = OG_WIDTH * SUPERSAMPLE;
  const h = OG_HEIGHT * SUPERSAMPLE;
  return sharp(renderView(sampler, w, h, view), { raw: { width: w, height: h, channels: 3 } })
    .resize(OG_WIDTH, OG_HEIGHT, { fit: 'fill', kernel: 'lanczos3' })
    .jpeg({ quality: OG_QUALITY, mozjpeg: true });
}
