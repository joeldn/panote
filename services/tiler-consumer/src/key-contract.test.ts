import { describe, expect, it } from 'vitest';
import { originalKey, userPanosPrefix } from '@internal/contracts';
import { manifestUrl, tilePath } from '@panote/core';
import { deriveUploadTarget } from './upload-prefix.js';

// Pins the contract between the tiler container's uploads (container.ts, via
// deriveUploadTarget()) and the viewer's read-side URL builders
// (@panote/core's tilePath()/manifestUrl()). The two only agree if panoId is
// carried verbatim through keys.ts and the container derives its prefix
// byte-for-byte from the notification key's owner segment (upload-prefix.ts).
//
// Fed `originalKey(sub, pano)` below - the exact key the notification
// carries - so this pins the container's real derivation, not just
// keys.ts's own builders.
describe('tiler container upload key vs. viewer read URL', () => {
  const sub = 'auth0|me'; // contains "|", same case the R2 parity test uses
  const pano = '550e8400-e29b-41d4-a716-446655440000'; // a UUID, as crypto.randomUUID() produces

  it('the manifest key the container uploads to equals userPanosPrefix(sub) + the viewer manifest URL path', () => {
    const notificationKey = originalKey(sub, pano);
    const { prefix } = deriveUploadTarget(notificationKey);
    const uploadedManifestKey = `${prefix}manifest.json`;

    const requestedManifestPath = manifestUrl(userPanosPrefix(sub), pano);

    expect(requestedManifestPath).toBe(uploadedManifestKey);
  });

  it('a tile key the container uploads to equals userPanosPrefix(sub) + the viewer tile URL path', () => {
    // Relative path matches what walk(join(work, panoId)) reports for one tile.
    const level = 0;
    const face = 'px';
    const x = 0;
    const y = 0;
    const format = 'webp';
    const relativeFilePath = `${level}/${face}/${x}-${y}.${format}`;
    const notificationKey = originalKey(sub, pano);
    const { prefix } = deriveUploadTarget(notificationKey);
    const uploadedTileKey = prefix + relativeFilePath;

    const requestedTilePath = tilePath(userPanosPrefix(sub), pano, level, face, x, y, format);

    expect(requestedTilePath).toBe(uploadedTileKey);
  });
});
