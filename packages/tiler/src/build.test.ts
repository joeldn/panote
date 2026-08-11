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
      // width chosen so computeFaceSize(width, 512, 32768) lands exactly on
      // 32768 (width / 4 = 32768 -> width = 131072); height kept small so
      // width * height stays under the MAX_INPUT_PIXELS decode cap and this
      // test exercises assertPyramidBounds's faceSize check specifically,
      // not the separate pixel-cap check.
      const outDir = await tmp();
      metadata.mockResolvedValue({ width: 131_072, height: 1024 });
      await expect(
        build({ src: 'fake-source.png', outDir, pano: 'ok-pano', maxSize: 32768 }),
      ).rejects.toThrow(/faceSize/);
    });

    it('rejects the exact gap the old validator left: tileSize 128 reaching faceSize 16384 at maxLevel 7', async () => {
      const outDir = await tmp();
      // width chosen so computeFaceSize(width, 128) lands exactly on 16384:
      // width / 4 = 16384 → width = 65536. height kept small (not the
      // realistic 2:1 equirect ratio) so width * height stays under the
      // MAX_INPUT_PIXELS decode cap and this test exercises the tileSize
      // check specifically, not the separate pixel-cap check.
      metadata.mockResolvedValue({ width: 65_536, height: 2048 });
      await expect(
        build({ src: 'fake-source.png', outDir, pano: 'ok-pano', tileSize: 128 }),
      ).rejects.toThrow(/tileSize/);
    });
  });

  describe('input pixel cap', () => {
    // This must throw before the raw RGB decode (toBuffer), same as the
    // pyramid-bounds tests above -- toBuffer is deliberately left unresolved
    // so a regression that moved this check too late would fail with a
    // TypeError instead of the expected message, not silently pass.
    it('rejects a source whose decoded pixel count exceeds MAX_INPUT_PIXELS', async () => {
      const outDir = await tmp();
      // 20,000 x 10,000 = 200,000,000 px > MAX_INPUT_PIXELS (150,000,000).
      metadata.mockResolvedValue({ width: 20_000, height: 10_000 });
      await expect(build({ src: 'fake-source.png', outDir, pano: 'ok-pano' })).rejects.toThrow(
        /exceeds the 150000000px decode cap/,
      );
    });

    it('does not reject a source exactly at the pixel cap (only over it)', async () => {
      const outDir = await tmp();
      // 15,000 x 10,000 = 150,000,000 px, exactly at MAX_INPUT_PIXELS, not
      // over it. Reuses the channel-count guard's mock shape (channels: 1)
      // so this proves the pixel-cap check let it through by observing it
      // fail for that *later*, unrelated reason instead -- without actually
      // running a 150-megapixel image through the real remap/tiling loop,
      // which the mocked `sharp` in this file does not simulate anyway.
      metadata.mockResolvedValue({ width: 15_000, height: 10_000 });
      toBuffer.mockResolvedValue({
        data: Buffer.alloc(8),
        info: { width: 15_000, height: 10_000, channels: 1 },
      });
      await expect(build({ src: 'fake-source.png', outDir, pano: 'ok-pano' })).rejects.toThrow(
        /3-channel/,
      );
    });
  });

  describe('option validation', () => {
    // These throw before sharp is ever touched, same as the pano checks
    // above, so no metadata mock is needed.

    it('rejects a quality below the valid range', async () => {
      const outDir = await tmp();
      await expect(
        build({ src: '/nonexistent/src.png', outDir, pano: 'ok-pano', quality: -3 }),
      ).rejects.toThrow(/quality/);
    });

    it('rejects a quality above the valid range', async () => {
      const outDir = await tmp();
      await expect(
        build({ src: '/nonexistent/src.png', outDir, pano: 'ok-pano', quality: 500 }),
      ).rejects.toThrow(/quality/);
    });

    it('rejects a non-finite quality', async () => {
      const outDir = await tmp();
      await expect(
        build({ src: '/nonexistent/src.png', outDir, pano: 'ok-pano', quality: NaN }),
      ).rejects.toThrow(/quality/);
    });

    it('rejects an unsupported format', async () => {
      const outDir = await tmp();
      await expect(
        build({
          src: '/nonexistent/src.png',
          outDir,
          pano: 'ok-pano',
          format: 'png' as unknown as 'jpg' | 'webp',
        }),
      ).rejects.toThrow(/format/);
    });

    it('rejects a non-integer maxSize', async () => {
      const outDir = await tmp();
      await expect(
        build({ src: '/nonexistent/src.png', outDir, pano: 'ok-pano', maxSize: 100.5 }),
      ).rejects.toThrow(/maxSize/);
    });

    it('rejects a non-positive maxSize', async () => {
      const outDir = await tmp();
      await expect(
        build({ src: '/nonexistent/src.png', outDir, pano: 'ok-pano', maxSize: 0 }),
      ).rejects.toThrow(/maxSize/);
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
