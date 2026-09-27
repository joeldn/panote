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
