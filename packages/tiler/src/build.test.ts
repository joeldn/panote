import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, setVipsConcurrency } from './build.js';
import { SourceRejectedError } from './errors.js';
import { TILER_OUTPUT_VERSION } from './version.js';
import type { Manifest } from '@panote/core';
import type * as OgModule from './og.js';
import type * as RemapModule from './remap.js';

// build.ts hardcodes `channels: 3` on the RgbImage it builds from sharp's raw
// decode of opts.src. It asks for that explicitly (toColourspace('srgb') +
// removeAlpha()), and build-inputs.test.ts runs real greyscale, CMYK and
// 16-bit sources through it. The channel guard in build.ts is defence in
// depth against that ever being false (a sharp upgrade, an unusual input):
// remap.ts's bilinear sampler uses a fixed stride of 3 and would otherwise
// silently read out of bounds and write mostly-black tiles with no error.
// No real fixture can trigger it, so this test mocks sharp's decode to
// return an off-spec channel count and asserts build() fails loudly.
const toBuffer = vi.fn();
const metadata = vi.fn();
// Shared across every sharp()/resize()/toFile() call, so a test can tell the
// face pyramid's calls apart from the preview's (dims, args, output path).
const resizeCalls: unknown[][] = [];
const toFileCalls: string[] = [];
const sharpCalls: unknown[][] = [];
const extendCalls: unknown[][] = [];

function chainable(): Record<string, unknown> {
  const self: Record<string, unknown> = {
    removeAlpha: () => self,
    toColourspace: () => self,
    extend: (...args: unknown[]) => {
      extendCalls.push(args);
      return self;
    },
    raw: () => self,
    resize: (...args: unknown[]) => {
      resizeCalls.push(args);
      return self;
    },
    extract: () => self,
    clone: () => self,
    webp: () => self,
    jpeg: () => self,
    png: () => self,
    metadata,
    toBuffer,
    toFile: (path: string) => {
      toFileCalls.push(path);
      return Promise.resolve(undefined);
    },
  };
  return self;
}

const concurrency = vi.fn((n: number) => n);

vi.mock('sharp', () => ({
  default: Object.assign(
    vi.fn((...args: unknown[]) => {
      sharpCalls.push(args);
      return chainable();
    }),
    { concurrency: (n: number) => concurrency(n) },
  ),
}));

// The pixel work build() hands to remap.ts and og.ts is stubbed here: sharp is
// mocked, so every face and og.jpg pixel would be thrown away unread, and that
// work (millions of JS samples, slow under coverage) made these the suite's
// slowest tests. renderFace and the og render are checked for real in
// remap.test.ts, og.test.ts and backfill-og.test.ts (which runs a real build).
// ogImage itself stays real, so its resize and encode calls still reach the
// sharp mock below; only the sampler it reads is a no-op.
const renderFace = vi.fn((_src: unknown, _face: string, size: number) =>
  Buffer.alloc(size * size * 3),
);
const equirectSampler = vi.fn((_img: unknown) => (_dir: unknown, out: number[]) => out.fill(0));

vi.mock('./remap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RemapModule>()),
  renderFace: (src: unknown, face: string, size: number) => renderFace(src, face, size),
}));

vi.mock('./og.js', async (importOriginal) => ({
  ...(await importOriginal<typeof OgModule>()),
  equirectSampler: (img: unknown) => equirectSampler(img),
}));

describe('setVipsConcurrency', () => {
  afterEach(() => {
    concurrency.mockClear();
  });

  it('passes the thread count to sharp.concurrency and returns what sharp reports', () => {
    concurrency.mockReturnValueOnce(4);
    expect(setVipsConcurrency(4)).toBe(4);
    expect(concurrency).toHaveBeenCalledWith(4);
  });

  it.each([0, -1, 2.5, Number.NaN])('rejects %s without touching sharp', (n) => {
    expect(() => setVipsConcurrency(n)).toThrow('vips concurrency must be a positive integer');
    expect(concurrency).not.toHaveBeenCalled();
  });
});

describe('build', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
    resizeCalls.length = 0;
    toFileCalls.length = 0;
    sharpCalls.length = 0;
    extendCalls.length = 0;
    toBuffer.mockReset();
    metadata.mockReset();
    renderFace.mockClear();
    equirectSampler.mockClear();
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
      metadata.mockResolvedValue({ format: 'png', width: 8192, height: 4096 });
      await expect(
        build({ src: 'fake-source.png', outDir, pano: 'ok-pano', tileSize: 128 }),
      ).rejects.toThrow(/tileSize/);
    });

    it('sizes the pyramid from the padded decode, so a very wide strip stays in bounds', async () => {
      // 48000 x 3000 (16:1, 144 MP) would ask for 16384px faces from its width,
      // and maxSize 32768 would allow them. Padded to 2:1 it is downscaled to fit
      // the decode cap (equirect.ts), which takes the faces down to the 8192 a
      // real 150 MP 2:1 panorama gets.
      const outDir = await tmp();
      metadata.mockResolvedValue({ format: 'png', width: 48_000, height: 3000 });
      // Left to fail the decode: only what build() asked sharp for matters here.
      toBuffer.mockRejectedValue(new Error('decode stopped by test'));
      const log: string[] = [];
      await expect(
        build({
          src: 'fake-source.png',
          outDir,
          pano: 'ok-pano',
          maxSize: 32768,
          onProgress: (m) => log.push(m),
        }),
      ).rejects.toThrow('decode stopped by test');
      const [w, h] = resizeCalls[0] as [number, number];
      expect(w).toBeLessThan(48_000);
      expect(h).toBe(Math.round((3000 * w) / 48_000));
      const [ext] = extendCalls[0] as [{ top: number; bottom: number }];
      expect(w * (h + ext.top + ext.bottom)).toBeLessThanOrEqual(150_000_000);
      expect(h + ext.top + ext.bottom).toBe(Math.round(w / 2));
      expect(log[0]).toMatch(/faceSize 8192,/);
    });

    it('rejects a tileSize outside the allowed set on a wide strip too', async () => {
      const outDir = await tmp();
      // A 16:1 strip, the widest accepted, under the pixel cap; tileSize 128 is
      // refused by the allowlist before anything is decoded.
      metadata.mockResolvedValue({ format: 'png', width: 32_768, height: 2048 });
      await expect(
        build({ src: 'fake-source.png', outDir, pano: 'ok-pano', tileSize: 128 }),
      ).rejects.toThrow(/tileSize/);
    });
  });

  describe('source checks', () => {
    // All of these throw before the raw decode: toBuffer is left unresolved.

    it('opens the source with the pixel limit and failOn, for metadata and the decode', async () => {
      const outDir = await tmp();
      metadata.mockResolvedValue({ format: 'jpeg', width: 2048, height: 1024 });
      toBuffer.mockRejectedValue(new Error('decode stopped by test'));
      await expect(build({ src: 'fake-source.jpg', outDir, pano: 'ok-pano' })).rejects.toThrow(
        'decode stopped by test',
      );
      const opened = sharpCalls.filter(([src]) => src === 'fake-source.jpg');
      expect(opened).toHaveLength(2);
      for (const [, options] of opened)
        expect(options).toEqual({ limitInputPixels: 150_000_000, failOn: 'warning' });
    });

    it.each(['svg', 'tiff', 'heif', 'gif', 'pdf', undefined])(
      'rejects a %s source as a SourceRejectedError',
      async (format) => {
        const outDir = await tmp();
        metadata.mockResolvedValue({ format, width: 2048, height: 1024 });
        const err = await build({ src: 'fake-source.png', outDir, pano: 'ok-pano' }).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(SourceRejectedError);
        expect((err as Error).message).toMatch(/is not one of jpeg, png, webp/);
        expect(toBuffer).not.toHaveBeenCalled();
      },
    );

    it('turns a source sharp cannot open into a SourceRejectedError', async () => {
      const outDir = await tmp();
      metadata.mockRejectedValue(new Error('Input image exceeds pixel limit'));
      const err = await build({ src: 'fake-source.png', outDir, pano: 'ok-pano' }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SourceRejectedError);
      expect((err as Error).message).toMatch(/exceeds pixel limit/);
    });

    it.each([
      [65_536, 2288],
      [16_001, 1000],
      [1000, 16_001],
    ])('rejects a %sx%s source, past 16:1', async (width, height) => {
      const outDir = await tmp();
      metadata.mockResolvedValue({ format: 'png', width, height });
      const err = await build({ src: 'fake-source.png', outDir, pano: 'ok-pano' }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SourceRejectedError);
      expect((err as Error).message).toMatch(/more than 16:1/);
      expect(toBuffer).not.toHaveBeenCalled();
    });

    it.each([
      [16_000, 1000],
      [1000, 16_000],
    ])('accepts a %sx%s source, exactly 16:1', async (width, height) => {
      const outDir = await tmp();
      metadata.mockResolvedValue({ format: 'png', width, height });
      toBuffer.mockRejectedValue(new Error('decode stopped by test'));
      await expect(build({ src: 'fake-source.png', outDir, pano: 'ok-pano' })).rejects.toThrow(
        'decode stopped by test',
      );
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
      metadata.mockResolvedValue({ format: 'png', width: 20_000, height: 10_000 });
      const err = await build({ src: 'fake-source.png', outDir, pano: 'ok-pano' }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SourceRejectedError);
      expect((err as Error).message).toMatch(/exceeds the 150000000px decode cap/);
    });

    it('does not reject a source exactly at the pixel cap (only over it)', async () => {
      const outDir = await tmp();
      // 15,000 x 10,000 = 150,000,000 px, exactly at MAX_INPUT_PIXELS, not
      // over it. Reuses the channel-count guard's mock shape (channels: 1)
      // so this proves the pixel-cap check let it through by observing it
      // fail for that *later*, unrelated reason instead -- without actually
      // running a 150-megapixel image through the real remap/tiling loop,
      // which the mocked `sharp` in this file does not simulate anyway.
      metadata.mockResolvedValue({ format: 'png', width: 15_000, height: 10_000 });
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

    it('rejects a version containing a character outside PANO_PATTERN', async () => {
      const outDir = await tmp();
      await expect(
        build({ src: '/nonexistent/src.png', outDir, pano: 'ok-pano', version: 't1/abc' }),
      ).rejects.toThrow(/version/);
    });
  });

  describe('version stamping', () => {
    // Runs the full pipeline through the manifest write, with sharp mocked and
    // the face and og sampling stubbed (see the mocks at the top of the file).
    const WIDTH = 2048;
    const HEIGHT = 1024;

    function mockSuccessfulDecode(): void {
      metadata.mockResolvedValue({ format: 'png', width: WIDTH, height: HEIGHT });
      toBuffer.mockResolvedValue({
        data: Buffer.alloc(WIDTH * HEIGHT * 3),
        info: { width: WIDTH, height: HEIGHT, channels: 3 },
      });
    }

    async function readManifest(outDir: string, pano: string): Promise<Manifest> {
      const raw = await readFile(join(outDir, pano, 'manifest.json'), 'utf8');
      return JSON.parse(raw) as Manifest;
    }

    it('writes version and tilerVersion into the manifest when a version is given', async () => {
      const outDir = await tmp();
      mockSuccessfulDecode();
      await build({
        src: 'fake-source.png',
        outDir,
        pano: 'ok-pano',
        tileSize: 512,
        maxSize: 512,
        version: 't1-abc123',
      });
      const manifest = await readManifest(outDir, 'ok-pano');
      expect(manifest.version).toBe('t1-abc123');
      expect(manifest.tilerVersion).toBe(TILER_OUTPUT_VERSION);
      expect(manifest.preview).toBe(true);
      expect(resizeCalls).toContainEqual([1024, 512, { fit: 'fill' }]);
      expect(toFileCalls.some((p) => p.endsWith('ok-pano/preview.webp'))).toBe(true);
      // The preview's sharp() call must decode at the source's native
      // dims (WIDTH/HEIGHT), not the (unrelated) 512px face size.
      const previewSharpCall = sharpCalls.find((args) => {
        const opts = args[1] as { raw?: { width: number; height: number } } | undefined;
        return opts?.raw?.width === WIDTH && opts.raw.height === HEIGHT;
      });
      expect(previewSharpCall).toBeDefined();
      // The link-preview image: a 1200x630 JPEG next to preview.webp, flagged in the manifest.
      expect(manifest.og).toBe(true);
      expect(toFileCalls.some((p) => p.endsWith('ok-pano/og.jpg'))).toBe(true);
      expect(resizeCalls).toContainEqual([1200, 630, { fit: 'fill', kernel: 'lanczos3' }]);
      // Every face at the capped face size, and og.jpg sampled from the
      // full-resolution source rather than a face or the 1024px preview.
      expect(renderFace.mock.calls.map(([, face, size]) => [face, size])).toEqual(
        ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((f) => [f, 512]),
      );
      const [ogSource] = equirectSampler.mock.calls[0] as [{ width: number; height: number }];
      expect(equirectSampler).toHaveBeenCalledTimes(1);
      expect([ogSource.width, ogSource.height]).toEqual([WIDTH, HEIGHT]);
    });

    it('omits version and tilerVersion from the manifest when no version is given', async () => {
      const outDir = await tmp();
      mockSuccessfulDecode();
      await build({
        src: 'fake-source.png',
        outDir,
        pano: 'ok-pano-unversioned',
        tileSize: 512,
        maxSize: 512,
      });
      const manifest = await readManifest(outDir, 'ok-pano-unversioned');
      expect(manifest.version).toBeUndefined();
      expect(manifest.tilerVersion).toBeUndefined();
      expect(manifest.preview).toBe(true);
      expect(manifest.og).toBe(true);
    });
  });

  describe('partial panoramas', () => {
    it('pads a 4:1 strip to 2:1 before the faces, preview and og.jpg are cut from it', async () => {
      const outDir = await tmp();
      metadata.mockResolvedValue({ format: 'png', width: 2048, height: 512 });
      toBuffer.mockResolvedValue({
        data: Buffer.alloc(2048 * 1024 * 3),
        info: { width: 2048, height: 1024, channels: 3 },
      });
      const manifest = await build({ src: 'fake-source.png', outDir, pano: 'strip', maxSize: 512 });
      expect(extendCalls).toEqual([[{ top: 256, bottom: 256, background: { r: 0, g: 0, b: 0 } }]]);
      // Not downscaled: the strip fits the cap once padded.
      expect(resizeCalls.some(([w, h]) => w === 2048 && h === 512)).toBe(false);
      const [ogSource] = equirectSampler.mock.calls[0] as [{ width: number; height: number }];
      expect([ogSource.width, ogSource.height]).toEqual([2048, 1024]);
      expect(manifest).toMatchObject({ faceSize: 512, preview: true, og: true });
    });

    it('does not pad a 2:1 source', async () => {
      const outDir = await tmp();
      metadata.mockResolvedValue({ format: 'png', width: 2048, height: 1024 });
      toBuffer.mockResolvedValue({
        data: Buffer.alloc(2048 * 1024 * 3),
        info: { width: 2048, height: 1024, channels: 3 },
      });
      await build({ src: 'fake-source.png', outDir, pano: 'full', maxSize: 512 });
      expect(extendCalls).toEqual([]);
    });
  });

  describe('build channel-count guard', () => {
    it('throws instead of silently corrupting output when the decode is not 3-channel RGB', async () => {
      metadata.mockResolvedValue({ format: 'png', width: 8, height: 4 });
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
