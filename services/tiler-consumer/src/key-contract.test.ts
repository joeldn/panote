import { describe, expect, it } from 'vitest';
import { manifestKey, originalKey, tileVersionPrefix } from '@internal/contracts';
import { manifestUrl, tilePath } from '@panote/core';
import { deriveUploadTarget } from './upload-prefix.js';

// Pins that the container's uploads and the viewer's read URLs agree under
// the owner-free 'tiles/' layout, with panoId carried verbatim.
describe('tiler container upload key vs. viewer read URL (owner-free)', () => {
  const pano = '550e8400-e29b-41d4-a716-446655440000'; // a UUID, as crypto.randomUUID() produces
  const version = 't1-abc123';

  it('the manifest key the container uploads to equals the viewer manifest URL under baseUrl "tiles/"', () => {
    const notificationKey = originalKey('auth0|me', pano);
    const { panoId } = deriveUploadTarget(notificationKey);
    const uploadedManifestKey = manifestKey(panoId);

    const requestedManifestPath = manifestUrl('tiles/', pano);

    expect(requestedManifestPath).toBe(uploadedManifestKey);
  });

  it('a versioned tile key the container uploads to equals the viewer versioned tile URL under baseUrl "tiles/"', () => {
    const level = 0;
    const face = 'px';
    const x = 0;
    const y = 0;
    const format = 'webp';
    const relativeFilePath = `${level}/${face}/${x}-${y}.${format}`;
    const notificationKey = originalKey('auth0|me', pano);
    const { panoId } = deriveUploadTarget(notificationKey);
    const uploadedTileKey = tileVersionPrefix(panoId, version) + relativeFilePath;

    const requestedTilePath = tilePath('tiles/', pano, level, face, x, y, format, version);

    expect(requestedTilePath).toBe(uploadedTileKey);
  });

  it('two different owner subs with the same panoId produce identical output keys', () => {
    const keyA = deriveUploadTarget(originalKey('auth0|me', pano));
    const keyB = deriveUploadTarget(originalKey('google-oauth2|123', pano));

    expect(manifestKey(keyA.panoId)).toBe(manifestKey(keyB.panoId));
    expect(tileVersionPrefix(keyA.panoId, version)).toBe(tileVersionPrefix(keyB.panoId, version));
  });
});
