import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from './build.js';

// build.ts hardcodes `channels: 3` on the RgbImage it builds from sharp's raw
// decode of opts.src, on the assumption that removeAlpha() + raw() always
// yields 3-channel RGB. Empirically, with the sharp version this repo pins
// (0.34.2), that assumption holds by default: .raw() normalizes any decoded
// image -- grayscale, CMYK, with or without alpha -- to sRGB, so no real
// source file reaches build.ts with info.channels !== 3. (Verified directly:
// a genuine 1-channel grayscale JPEG built with ImageMagick still decodes to
// 3 channels through `sharp(src).removeAlpha().raw().toBuffer()`.)
//
// The guard added in build.ts is defence-in-depth against that assumption
// ever becoming false (a sharp upgrade, an unusual input this wasn't tested
// against, etc.) -- remap.ts's bilinear sampler uses a fixed stride of 3 and
// would otherwise silently read out of bounds and write mostly-black tiles
// with no error. Since no real fixture can trigger it today, this test
// mocks sharp's decode to return an off-spec channel count and asserts
// build() fails loudly instead of proceeding.
const toBuffer = vi.fn();
const metadata = vi.fn();

function chainable(): Record<string, unknown> {
  const self: Record<string, unknown> = {
    removeAlpha: () => self,
    raw: () => self,
    resize: () => self,
    extract: () => self,
    clone: () => self,
    webp: () => self,
    jpeg: () => self,
    png: () => self,
    metadata,
    toBuffer,
    toFile: vi.fn().mockResolvedValue(undefined),
  };
  return self;
}

vi.mock('sharp', () => ({
  default: vi.fn(() => chainable()),
}));

describe('build', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tmp(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'panote-tiler-'));
    dirs.push(d);
    return d;
  }

  describe('pano validation', () => {
    // The path-separator/`..` checks below throw before build() ever touches
    // opts.src, so a nonexistent source path is fine for exercising them.

    it('rejects a pano that path-traverses out of outDir', async () => {
      const outDir = await tmp();
      await expect(
        build({ src: '/nonexistent/src.png', outDir, pano: '../../../etc/cron.d' }),
      ).rejects.toThrow(/pano must match/);
    });

    it('rejects a pano of ".."', async () => {
      const outDir = await tmp();
      await expect(build({ src: '/nonexistent/src.png', outDir, pano: '..' })).rejects.toThrow(
        /pano must match/,
      );
    });

    it('rejects a pano containing a path separator', async () => {
      const outDir = await tmp();
      await expect(
        build({ src: '/nonexistent/src.png', outDir, pano: 'a/../../b' }),
      ).rejects.toThrow(/pano must match/);
    });

    it('accepts a UUID-shaped pano (fails later, for the missing source, not the pano)', async () => {
      const outDir = await tmp();
      let message = '';
      try {
        await build({
          src: '/nonexistent/src.png',
          outDir,
          pano: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toMatch(/pano must match/);
    });
  });

  describe('pyramid bounds enforcement', () => {
    // These throw before the raw RGB decode (see build.ts), so metadata is
    // the only sharp call that needs a resolved value — toBuffer is never
    // reached.

    it('rejects a tileSize outside the allowed set', async () => {
      const outDir = await tmp();
      metadata.mockResolvedValue({ width: 8192, height: 4096 });
      await expect(
        build({ src: 'fake-source.png', outDir, pano: 'ok-pano', tileSize: 128 }),
      ).rejects.toThrow(/tileSize/);
    });

    it('rejects an explicit maxSize that would push faceSize above the derived cap', async () => {
      // computeFaceSize's own default caps at 16384, but a caller can still
      // pass an explicit maxSize above that -- assertPyramidBounds is what
      // makes that unable to produce an out-of-bounds pyramid.
      const outDir = await tmp();
      metadata.mockResolvedValue({ width: 200_000, height: 100_000 });
      await expect(
        build({ src: 'fake-source.png', outDir, pano: 'ok-pano', maxSize: 32768 }),
      ).rejects.toThrow(/faceSize/);
    });

    it('rejects the exact gap the old validator left: tileSize 128 reaching faceSize 16384 at maxLevel 7', async () => {
      const outDir = await tmp();
      // width chosen so computeFaceSize(width, 128) lands exactly on 16384:
      // width / 4 = 16384 → width = 65536.
      metadata.mockResolvedValue({ width: 65_536, height: 32_768 });
      await expect(
        build({ src: 'fake-source.png', outDir, pano: 'ok-pano', tileSize: 128 }),
      ).rejects.toThrow(/tileSize/);
    });
  });

  describe('build channel-count guard', () => {
    it('throws instead of silently corrupting output when the decode is not 3-channel RGB', async () => {
      metadata.mockResolvedValue({ width: 8, height: 4 });
      toBuffer.mockResolvedValue({
        data: Buffer.alloc(8 * 4),
        info: { width: 8, height: 4, channels: 1 },
      });
      const { build } = await import('./build.js');
      await expect(
        build({
          src: 'fake-source.png',
          outDir: '/tmp/panote-build-guard-test',
          pano: 'ok-pano',
        }),
      ).rejects.toThrow(/3-channel/);
    });
  });
});
