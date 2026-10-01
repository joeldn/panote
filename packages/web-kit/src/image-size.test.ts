import { describe, expect, it } from 'vitest';

import { MAX_UPLOAD_PIXELS, readImageSize, validateUploadImage } from './image-size.js';

const bytes = (...parts: Array<number[] | string>): Uint8Array<ArrayBuffer> =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [...be16(Math.floor(n / 0x10000)), ...be16(n & 0xffff)];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [...le16(n & 0xffff), (n >> 16) & 0xff];

const blob = (data: Uint8Array<ArrayBuffer>, type: string) => new File([data], 'x', { type });

const png = (w: number, h: number) =>
  bytes(
    [0x89],
    'PNG',
    [0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    'IHDR',
    be32(w),
    be32(h),
    [8, 2, 0, 0, 0],
  );

// SOI, an APP1 (EXIF-like) block to skip, a fill byte, then SOF2 (progressive).
const jpeg = (w: number, h: number) =>
  bytes(
    [0xff, 0xd8],
    [0xff, 0xe1],
    be16(2 + 100),
    new Array<number>(100).fill(0),
    [0xff, 0xff, 0xc2],
    be16(17),
    [8],
    be16(h),
    be16(w),
    [3],
  );

const riff = (chunk: string, payload: number[]) =>
  bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [0, 0, 0, 0], payload);

describe('readImageSize', () => {
  it('reads PNG IHDR', async () => {
    expect(await readImageSize(blob(png(8000, 4000), 'image/png'))).toEqual({
      width: 8000,
      height: 4000,
    });
  });

  it('reads a JPEG SOF after skipping APP segments by length', async () => {
    expect(await readImageSize(blob(jpeg(12000, 6000), 'image/jpeg'))).toEqual({
      width: 12000,
      height: 6000,
    });
  });

  it('reads WebP VP8, VP8L and VP8X headers', async () => {
    const lossy = riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(4096), ...le16(2048)]);
    expect(await readImageSize(blob(lossy, 'image/webp'))).toEqual({ width: 4096, height: 2048 });

    const w = 2000 - 1;
    const h = 1000 - 1;
    const lossless = riff('VP8L', [
      0x2f,
      w & 0xff,
      ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
      (h >> 2) & 0xff,
      (h >> 10) & 0x0f,
    ]);
    expect(await readImageSize(blob(lossless, 'image/webp'))).toEqual({
      width: 2000,
      height: 1000,
    });

    const extended = riff('VP8X', [0, 0, 0, 0, ...le24(16384 - 1), ...le24(8192 - 1)]);
    expect(await readImageSize(blob(extended, 'image/webp'))).toEqual({
      width: 16384,
      height: 8192,
    });
  });

  it('returns null for unknown or truncated data', async () => {
    expect(await readImageSize(blob(bytes('GIF89a'), 'image/gif'))).toBeNull();
    expect(
      await readImageSize(blob(bytes([0xff, 0xd8, 0xff, 0xda, 0, 2]), 'image/jpeg')),
    ).toBeNull();
  });
});

describe('validateUploadImage', () => {
  it('rejects a source over the tiler pixel cap before any upload', async () => {
    // 17320 x 8660 = 149,991,200 px: just under the cap.
    expect(await validateUploadImage(blob(png(17320, 8660), 'image/png'))).toBeNull();
    const over = await validateUploadImage(blob(png(20000, 10000), 'image/png'));
    expect(over).toMatchObject({ code: 'pixels' });
    expect(over?.message).toContain(`${MAX_UPLOAD_PIXELS / 1e6}`);
  });

  it('runs the type and byte checks first, and passes an unreadable header', async () => {
    expect(await validateUploadImage(blob(png(10, 10), 'image/gif'))).toMatchObject({
      code: 'type',
    });
    expect(await validateUploadImage(blob(bytes('not an image'), 'image/jpeg'))).toBeNull();
  });
});
