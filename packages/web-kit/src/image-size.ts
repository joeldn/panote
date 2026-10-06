import { validateUploadFile, type UploadValidationError } from './api/upload.js';

/** Must match the tiler's decode cap (MAX_INPUT_PIXELS, packages/tiler/src/pyramid.ts). */
export const MAX_UPLOAD_PIXELS = 150_000_000;

export interface ImageSize {
  width: number;
  height: number;
}

type Reader = (offset: number, length: number) => Promise<Uint8Array>;

const ascii = (b: Uint8Array, at: number, len: number): string =>
  String.fromCharCode(...b.subarray(at, at + len));
const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number): number => u16le(b, at) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number): number => u16be(b, at) * 0x10000 + u16be(b, at + 2);

function pngSize(head: Uint8Array): ImageSize | null {
  if (head.length < 24 || ascii(head, 12, 4) !== 'IHDR') return null;
  return { width: u32be(head, 16), height: u32be(head, 20) };
}

function webpSize(head: Uint8Array): ImageSize | null {
  const chunk = ascii(head, 12, 4);
  if (chunk === 'VP8 ' && head.length >= 30) {
    return { width: u16le(head, 26) & 0x3fff, height: u16le(head, 28) & 0x3fff };
  }
  if (chunk === 'VP8L' && head.length >= 25) {
    const [b1, b2, b3, b4] = [head[21] ?? 0, head[22] ?? 0, head[23] ?? 0, head[24] ?? 0];
    return {
      width: 1 + (b1 | ((b2 & 0x3f) << 8)),
      height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
    };
  }
  if (chunk === 'VP8X' && head.length >= 30) {
    return { width: 1 + u24le(head, 24), height: 1 + u24le(head, 27) };
  }
  return null;
}

// SOF0-15 minus DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
const isSof = (m: number): boolean =>
  m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

async function jpegSize(read: Reader, size: number): Promise<ImageSize | null> {
  let offset = 2;
  // Walks segment headers only (EXIF/XMP blocks are skipped by length, never read).
  for (let i = 0; i < 512 && offset + 4 <= size; i++) {
    const seg = await read(offset, 9);
    if (seg[0] !== 0xff) return null;
    const marker = seg[1] ?? 0;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // scan data before any SOF
    if (isSof(marker)) {
      if (seg.length < 9) return null;
      return { width: u16be(seg, 7), height: u16be(seg, 5) };
    }
    offset += 2 + u16be(seg, 2);
  }
  return null;
}

/**
 * Pixel size of a JPEG, PNG or WebP from its header bytes, without decoding
 * the image. Null when the format or header isn't recognised.
 */
export async function readImageSize(file: Blob): Promise<ImageSize | null> {
  const read: Reader = async (offset, length) =>
    new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  const head = await read(0, 32);
  if (head[0] === 0x89 && ascii(head, 1, 3) === 'PNG') return pngSize(head);
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return webpSize(head);
  if (head[0] === 0xff && head[1] === 0xd8) return jpegSize(read, file.size);
  return null;
}

export type ImageValidationError = UploadValidationError | { code: 'pixels'; message: string };

/**
 * Everything checkable before a presign: type, bytes, then pixel count. An
 * unreadable header passes, since the tiler is the final judge.
 */
export async function validateUploadImage(
  file: Blob & { type: string },
): Promise<ImageValidationError | null> {
  const basic = validateUploadFile(file);
  if (basic) return basic;
  const dims = await readImageSize(file).catch(() => null);
  if (dims && dims.width * dims.height > MAX_UPLOAD_PIXELS) {
    const mp = Math.round((dims.width * dims.height) / 1e6);
    return {
      code: 'pixels',
      message: `This image is ${mp} megapixels; the limit is ${MAX_UPLOAD_PIXELS / 1e6}.`,
    };
  }
  return null;
}
