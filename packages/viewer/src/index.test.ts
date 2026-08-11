import { describe, it, expect } from 'vitest';
import { BaseTileLoadError } from './index.js';
import { BaseTileLoadError as InternalBaseTileLoadError } from './tile-layer.js';
import { TileHttpError } from './tile-retry.js';

// index.ts is the package's public entry point (see package.json `exports`).
// This file is the only thing asserting a symbol actually crosses that
// boundary — a class can be defined and exported from its own module and
// still never make it into src/index.ts, which is exactly the state
// BaseTileLoadError was in before this change (see tile-layer.ts).
describe('public entry point', () => {
  it('re-exports BaseTileLoadError as the exact class TileLayer throws', () => {
    // Not just "a class with the same name" - the same reference, so a
    // caller's `instanceof BaseTileLoadError` (imported from '@panote/viewer')
    // actually catches what loadBase()/load() reject with.
    expect(BaseTileLoadError).toBe(InternalBaseTileLoadError);
  });

  it('carries enough for a caller to tell "not published" from "origin unavailable" without string-matching cause', () => {
    const notPublished = new BaseTileLoadError('pano-a', 'px', new TileHttpError(404));
    const originDown = new BaseTileLoadError('pano-a', 'px', new TileHttpError(503));
    const networkDown = new BaseTileLoadError('pano-a', 'px', new TypeError('fetch failed'));

    expect(notPublished).toBeInstanceOf(BaseTileLoadError);
    expect(notPublished.permanent).toBe(true); // 404: retrying cannot help
    expect(originDown.permanent).toBe(false); // 503: transient, worth another try
    expect(networkDown.permanent).toBe(false); // dropped connection: also transient

    // The other half of the distinction: which panorama, which face.
    expect(notPublished.pano).toBe('pano-a');
    expect(notPublished.face).toBe('px');
    expect(notPublished.cause).toBeInstanceOf(TileHttpError);
  });
});
