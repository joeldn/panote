import type { Manifest } from '@internal/contracts';
import { FACES } from '@panote/core';

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const manifest = (version?: string, pano = 'pano-1'): Manifest => {
  const m: Manifest = {
    pano,
    faceSize: 1024,
    tileSize: 512,
    maxLevel: 1,
    faces: [...FACES],
    quality: 85,
    format: 'webp',
  };
  if (version !== undefined) m.version = version;
  return m;
};

/** A Blob whose PNG header says `width` x `height`; nothing past IHDR. */
export function pngHeaderFile(width: number, height: number): Blob {
  const b = new Uint8Array(32);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(b.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([b], { type: 'image/png' });
}
