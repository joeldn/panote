import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { build } from './build.js';

// Real sharp, real files: the kinds of image cameras and phones save, built in-test.
// build.test.ts covers the orchestration with sharp mocked.

let work: string;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'panote-tiler-inputs-'));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

const W = 512;
const H = 256;
const flat = (w: number, h: number, rgb: [number, number, number]) => {
  const data = Buffer.alloc(w * h * 3);
  for (let i = 0; i < data.length; i += 3) data.set(rgb, i);
  return sharp(data, { raw: { width: w, height: h, channels: 3 } });
};

/** The colour at (x, y) in pixels of an image file, as 8-bit RGB. */
async function pixel(path: string, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(path)
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return Array.from(data.subarray(o, o + 3));
}

async function tile(src: string, pano: string): Promise<string> {
  await build({ src, outDir: work, pano, maxSize: 512 });
  return join(work, pano);
}

// Each build renders six faces and og.jpg in JS: about a second each, more under coverage.
describe('build with real sources', { timeout: 30_000 }, () => {
  it.each([
    ['a greyscale JPEG', 'grey.jpg', () => flat(W, H, [120, 120, 120]).toColourspace('b-w').jpeg()],
    ['a greyscale PNG', 'grey.png', () => flat(W, H, [120, 120, 120]).toColourspace('b-w').png()],
    [
      'a greyscale PNG with alpha',
      'grey-alpha.png',
      () => flat(W, H, [120, 120, 120]).ensureAlpha(1).toColourspace('b-w').png(),
    ],
    [
      'a 16-bit greyscale PNG',
      'grey16.png',
      () => flat(W, H, [120, 120, 120]).toColourspace('grey16').png(),
    ],
    [
      'a 16-bit RGB PNG',
      'rgb16.png',
      () => flat(W, H, [120, 120, 120]).toColourspace('rgb16').png(),
    ],
  ])('tiles %s', async (_name, file, make) => {
    const src = join(work, file);
    await make().toFile(src);
    const meta = await sharp(src).metadata();
    // The fixture really is the format it claims to be.
    expect(meta.space === 'srgb' && meta.depth === 'uchar').toBe(false);

    const dir = await tile(src, file.replace('.', '-'));
    const [r, g, b] = await pixel(join(dir, '0', 'pz', '0-0.webp'), 256, 256);
    for (const c of [r, g, b]) expect(Math.abs(c! - 120)).toBeLessThanOrEqual(3);
    const og = await pixel(join(dir, 'og.jpg'), 600, 315);
    for (const c of og) expect(Math.abs(c - 120)).toBeLessThanOrEqual(3);
  });

  it('tiles a CMYK JPEG', async () => {
    const src = join(work, 'cmyk.jpg');
    await flat(W, H, [200, 60, 40]).toColourspace('cmyk').jpeg().toFile(src);
    expect((await sharp(src).metadata()).space).toBe('cmyk');
    const dir = await tile(src, 'cmyk');
    const [r, g, b] = await pixel(join(dir, '0', 'pz', '0-0.webp'), 256, 256);
    // Reddish: the colour conversion round trip isn't exact, but the hue survives.
    expect(r!).toBeGreaterThan(g! + 80);
    expect(r!).toBeGreaterThan(b! + 80);
  });

  it('puts a 4:1 strip on the horizon instead of stretching it over the sphere', async () => {
    // Four horizontal stripes, 32 rows each: red, green, blue, white.
    const stripes: Array<[number, number, number]> = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
    ];
    const data = Buffer.alloc(W * 128 * 3);
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < W; x++) data.set(stripes[Math.floor(y / 32)]!, (y * W + x) * 3);
    const src = join(work, 'strip.png');
    await sharp(data, { raw: { width: W, height: 128, channels: 3 } })
      .png()
      .toFile(src);

    const dir = await tile(src, 'strip');
    // Padded to 512x256, content on rows 64-191, so 30% of the way down is the red
    // stripe; stretched, it would be green. Read from the 1024x512 preview.
    const at30 = await pixel(join(dir, 'preview.webp'), 512, Math.round(0.3 * 512));
    expect(at30[0]).toBeGreaterThan(200);
    expect(at30[1]).toBeLessThan(60);
    // The horizon is the boundary between green and blue, as in the source.
    const above = await pixel(join(dir, 'preview.webp'), 512, 250);
    const below = await pixel(join(dir, 'preview.webp'), 512, 262);
    expect(above[1]).toBeGreaterThan(200);
    expect(below[2]).toBeGreaterThan(200);
    // The band below is filled from the white edge, not left black.
    const pole = await pixel(join(dir, 'preview.webp'), 512, 505);
    for (const c of pole) expect(c).toBeGreaterThan(240);
  });
});
