import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { FACES, type Face, type Manifest, type TileFormat, tilesPerEdge } from '@panote/core';
import { renderFace, type RgbImage } from './remap.js';
import { isPow2, computeFaceSize, computeMaxLevel } from './pyramid.js';

export interface BuildOptions {
  src: string;
  outDir: string; // tiles root (e.g. apps/demo/public/tiles)
  pano: string;
  tileSize?: number | undefined; // default 512
  maxSize?: number | undefined; // optional cap on faceSize (for fast dev pyramids)
  quality?: number | undefined; // default 70
  format?: TileFormat | undefined; // default 'webp'
  onProgress?: ((msg: string) => void) | undefined;
}

export async function build(opts: BuildOptions): Promise<Manifest> {
  const tileSize = opts.tileSize ?? 512;
  const quality = opts.quality ?? 70;
  const fmt = opts.format ?? 'webp';
  const log = opts.onProgress ?? (() => {});

  const encoder = (s: sharp.Sharp): sharp.Sharp =>
    fmt === 'webp' ? s.webp({ quality }) : s.jpeg({ quality, mozjpeg: true });

  if (!isPow2(tileSize)) throw new Error(`tileSize must be a power of two (got ${tileSize})`);

  const meta = await sharp(opts.src).metadata();
  if (!meta.width || !meta.height) throw new Error('source has no dimensions');

  const faceSize = computeFaceSize(meta.width, tileSize, opts.maxSize);
  const maxLevel = computeMaxLevel(faceSize, tileSize);

  log(`source ${meta.width}x${meta.height} → faceSize ${faceSize}, maxLevel ${maxLevel}`);

  // Load equirect as raw RGB once.
  const { data, info } = await sharp(opts.src)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const srcImg: RgbImage = {
    data,
    width: info.width,
    height: info.height,
    channels: 3,
  };

  const panoDir = join(opts.outDir, opts.pano);

  for (const face of FACES) {
    log(`rendering face ${face} at ${faceSize}px`);
    const faceRgb = renderFace(srcImg, face as Face, faceSize);
    const faceSharp = sharp(faceRgb, {
      raw: { width: faceSize, height: faceSize, channels: 3 },
    });

    for (let level = 0; level <= maxLevel; level++) {
      const levelPx = tileSize * tilesPerEdge(level);
      const perEdge = tilesPerEdge(level);
      // Resize the native face down to this level's full size, keep raw for cropping.
      const levelBuf = await faceSharp
        .clone()
        .resize(levelPx, levelPx, { fit: 'fill' })
        .png()
        .toBuffer();
      const levelSharp = sharp(levelBuf);
      const dir = join(panoDir, String(level), face);
      await mkdir(dir, { recursive: true });
      for (let ty = 0; ty < perEdge; ty++) {
        for (let tx = 0; tx < perEdge; tx++) {
          await encoder(
            levelSharp.clone().extract({
              left: tx * tileSize,
              top: ty * tileSize,
              width: tileSize,
              height: tileSize,
            }),
          ).toFile(join(dir, `${tx}-${ty}.${fmt}`));
        }
      }
    }
  }

  const manifest: Manifest = {
    pano: opts.pano,
    faceSize,
    tileSize,
    maxLevel,
    faces: FACES,
    quality,
    format: fmt,
  };
  await mkdir(panoDir, { recursive: true });
  await writeFile(join(panoDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`wrote manifest to ${join(panoDir, 'manifest.json')}`);
  return manifest;
}
