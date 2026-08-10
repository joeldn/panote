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

  // build() is the tiler's public library entry point; opts.pano is joined
  // into the output path below with no other sanitization. path.join
  // normalizes `..` segments, so an unvalidated pano (e.g. derived from an
  // upload name by a future caller) could write the pyramid outside outDir.
  // Every legitimate pano today (a developer-typed CLI slug, or a
  // server-generated crypto.randomUUID()) matches this charset.
  if (!/^[A-Za-z0-9_-]+$/.test(opts.pano))
    throw new Error(`pano must match /^[A-Za-z0-9_-]+$/ (got ${opts.pano})`);

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
  // removeAlpha() strips an alpha band if present; it does not force an RGB
  // colorspace. A grayscale source decodes to 1 channel, and remap.ts's
  // bilinear sampler indexes with a fixed stride of 3, so silently trusting
  // `channels: 3` here would read out of bounds and produce mostly-black
  // tiles with no error. Fail loudly instead.
  if (info.channels !== 3)
    throw new Error(`expected a 3-channel RGB source after removeAlpha, got ${info.channels}`);
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
