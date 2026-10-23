import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  FACES,
  PANO_PATTERN,
  type Face,
  type Manifest,
  type TileFormat,
  tilesPerEdge,
} from '@panote/core';
import { renderFace, type RgbImage } from './remap.js';
import { fillBands, MAX_ASPECT_RATIO, planEquirect } from './equirect.js';
import { SourceRejectedError } from './errors.js';
import { equirectSampler, OG_FILE, ogImage } from './og.js';
import {
  assertPyramidBounds,
  computeFaceSize,
  computeMaxLevel,
  MAX_INPUT_PIXELS,
} from './pyramid.js';
import { TILER_OUTPUT_VERSION } from './version.js';

/**
 * The formats build() tiles, as sharp's metadata() names them. The upload's
 * content-type is pinned, but nothing checks the bytes before here, and sharp
 * would otherwise decode whatever libvips can open (SVG, TIFF, HEIF, PDF...)
 * inside a container that holds bucket-wide R2 credentials.
 */
export const SOURCE_FORMATS: readonly string[] = ['jpeg', 'png', 'webp'];

/**
 * Input options for every sharp() that opens the source. limitInputPixels makes
 * libvips itself refuse a header over the cap, so the cap holds even if the
 * check after metadata() below were ever moved. failOn 'warning' is sharp's
 * default and its strictest level (it implies 'error' and 'truncated'), spelled
 * out so a corrupt or truncated source fails instead of tiling half-decoded.
 */
const SOURCE_INPUT: sharp.SharpOptions = {
  limitInputPixels: MAX_INPUT_PIXELS,
  failOn: 'warning',
};

/**
 * Sets the libvips worker-thread count for every sharp op in this process and
 * returns the value now in effect. sharp drops its default to 1 on glibc
 * Linux without jemalloc (node:24-slim is glibc), and that call wins over a
 * VIPS_CONCURRENCY env var, so a caller that wants more threads must call
 * this. Exposed here so callers don't need their own sharp dependency.
 */
export const setVipsConcurrency = (threads: number): number => {
  if (!Number.isInteger(threads) || threads < 1)
    throw new Error(`vips concurrency must be a positive integer (got ${threads})`);
  return sharp.concurrency(threads);
};

export interface BuildOptions {
  src: string;
  outDir: string; // tiles root (e.g. apps/demo/public/tiles)
  pano: string;
  tileSize?: number | undefined; // default 512
  maxSize?: number | undefined; // optional cap on faceSize (for fast dev pyramids)
  quality?: number | undefined; // default 70
  format?: TileFormat | undefined; // default 'webp'
  // Stamped into the manifest with tilerVersion when given; omitted, the
  // build writes a pre-versioning manifest, unchanged from today.
  version?: string | undefined;
  onProgress?: ((msg: string) => void) | undefined;
}

export async function build(opts: BuildOptions): Promise<Manifest> {
  const tileSize = opts.tileSize ?? 512;
  const quality = opts.quality ?? 70;
  const fmt = opts.format ?? 'webp';
  const log = opts.onProgress ?? (() => {});

  const encoder = (s: sharp.Sharp): sharp.Sharp =>
    fmt === 'webp' ? s.webp({ quality }) : s.jpeg({ quality, mozjpeg: true });

  // build() is the tiler's public library entry point; opts.pano is joined
  // into the output path below with no other sanitization. path.join
  // normalizes `..` segments, so an unvalidated pano (e.g. derived from an
  // upload name by a future caller) could write the pyramid outside outDir.
  // Every legitimate pano today (a developer-typed CLI slug, or a
  // server-generated crypto.randomUUID()) matches this charset.
  if (!PANO_PATTERN.test(opts.pano))
    throw new Error(`pano must match ${PANO_PATTERN} (got ${opts.pano})`);

  // BuildOptions exposes maxSize/quality/format as public API with defaults,
  // but only tileSize was actually checked (via assertPyramidBounds below).
  // Validate the rest here too, up front, so a bad value fails loudly and
  // fast instead of producing undefined behaviour (a non-integer maxSize
  // feeding computeFaceSize's Math.log2/pow2 math) or a corrupt manifest
  // (an out-of-range quality, or a format @panote/core's parseManifest
  // would reject on read) — the tiler must not be able to emit a pyramid
  // its own reader would refuse.
  if (!Number.isFinite(quality) || quality <= 0 || quality > 100)
    throw new Error(`quality must be a finite number in (0, 100] (got ${quality})`);
  if (fmt !== 'jpg' && fmt !== 'webp')
    throw new Error(`format must be 'jpg' or 'webp' (got ${String(fmt)})`);
  if (opts.maxSize !== undefined && (!Number.isInteger(opts.maxSize) || opts.maxSize <= 0))
    throw new Error(`maxSize must be a positive integer (got ${opts.maxSize})`);
  // Validated here too (parseManifest checks it again on read) so a bad
  // version fails the job loudly instead of producing an unreadable manifest.
  if (opts.version !== undefined && !PANO_PATTERN.test(opts.version))
    throw new Error(`version must match ${PANO_PATTERN} (got ${opts.version})`);

  let meta: sharp.Metadata;
  try {
    meta = await sharp(opts.src, SOURCE_INPUT).metadata();
  } catch (e) {
    // Only the header is read here, from a local file: a failure means these
    // bytes aren't an image sharp can open (or are over limitInputPixels).
    throw new SourceRejectedError(
      `source could not be read as an image: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!SOURCE_FORMATS.includes(meta.format))
    throw new SourceRejectedError(
      `source format ${String(meta.format)} is not one of ${SOURCE_FORMATS.join(', ')}`,
    );
  if (!meta.width || !meta.height) throw new SourceRejectedError('source has no dimensions');
  // Enforced before the raw RGB decode below, not after: MAX_FACE_SIZE (via
  // computeFaceSize/assertPyramidBounds) only bounds the pyramid's *output*
  // face size, not this decode. sharp(opts.src).removeAlpha().raw() decodes
  // the source at its *native* resolution regardless of any output cap, so
  // decode memory scales with meta.width * meta.height, not with faceSize.
  // See MAX_INPUT_PIXELS's doc comment in pyramid.ts for why this is a real
  // check rather than relying on the deployed backend's byte-based cap.
  if (meta.width * meta.height > MAX_INPUT_PIXELS)
    throw new SourceRejectedError(
      `source is ${meta.width}x${meta.height} (${meta.width * meta.height} px), which exceeds the ${MAX_INPUT_PIXELS}px decode cap`,
    );
  // See MAX_ASPECT_RATIO in equirect.ts: nothing a camera saves is this far
  // from square, and planEquirect already bounds the work either way.
  if (meta.width > MAX_ASPECT_RATIO * meta.height || meta.height > MAX_ASPECT_RATIO * meta.width)
    throw new SourceRejectedError(
      `source is ${meta.width}x${meta.height}, more than ${MAX_ASPECT_RATIO}:1 on its long side`,
    );

  // Partial panoramas (wider than 2:1) are padded to 2:1 so they aren't
  // stretched over the sphere; see equirect.ts. The padded size is planned
  // here, before the decode, and held to the same pixel cap.
  const plan = planEquirect(meta.width, meta.height);
  const faceSize = computeFaceSize(plan.width, tileSize, opts.maxSize);
  const maxLevel = computeMaxLevel(faceSize, tileSize);
  assertPyramidBounds(tileSize, faceSize, maxLevel);

  log(`source ${meta.width}x${meta.height} → faceSize ${faceSize}, maxLevel ${maxLevel}`);
  if (plan.height !== plan.contentHeight)
    log(
      `partial panorama: padded to ${plan.width}x${plan.height}${plan.scaled ? ' (downscaled to fit the decode cap)' : ''}`,
    );

  // Load the equirect as raw 8-bit sRGB once. toColourspace('srgb') makes the
  // conversion explicit for greyscale, CMYK and 16-bit sources (removeAlpha()
  // only strips an alpha band), so remap.ts's fixed 3-channel stride holds.
  let decode = sharp(opts.src, SOURCE_INPUT).toColourspace('srgb').removeAlpha();
  if (plan.scaled) decode = decode.resize(plan.width, plan.contentHeight, { fit: 'fill' });
  if (plan.height !== plan.contentHeight)
    decode = decode.extend({
      top: plan.top,
      bottom: plan.height - plan.top - plan.contentHeight,
      background: { r: 0, g: 0, b: 0 },
    });
  const { data, info } = await decode.raw().toBuffer({ resolveWithObject: true });
  // Defence in depth: if a source ever decoded to anything but 3 channels,
  // remap.ts would read out of bounds and write mostly-black tiles with no
  // error. Fail loudly instead.
  if (info.channels !== 3)
    throw new Error(`expected a 3-channel RGB source after removeAlpha, got ${info.channels}`);
  if (plan.height !== plan.contentHeight)
    fillBands(data, info.width, info.height, plan.top, plan.contentHeight);
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

  await mkdir(panoDir, { recursive: true });
  log('rendering preview image');
  // Fixed 1024x512 and always webp regardless of tile format, so dashboard
  // cards get a stable, small asset alongside the tile pyramid.
  await sharp(srcImg.data, { raw: { width: srcImg.width, height: srcImg.height, channels: 3 } })
    .resize(1024, 512, { fit: 'fill' })
    .webp({ quality })
    .toFile(join(panoDir, 'preview.webp'));

  // The link-preview image: a normal-camera view of the default start direction,
  // sampled from the full-resolution source rather than the 1024px preview.
  const ogT0 = performance.now();
  await ogImage(equirectSampler(srcImg)).toFile(join(panoDir, OG_FILE));
  log(`rendered ${OG_FILE} in ${Math.round(performance.now() - ogT0)}ms`);

  const manifest: Manifest = {
    pano: opts.pano,
    faceSize,
    tileSize,
    maxLevel,
    faces: FACES,
    quality,
    format: fmt,
    preview: true,
    og: true,
    ...(opts.version !== undefined
      ? { version: opts.version, tilerVersion: TILER_OUTPUT_VERSION }
      : {}),
  };
  await writeFile(join(panoDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`wrote manifest to ${join(panoDir, 'manifest.json')}`);
  return manifest;
}
