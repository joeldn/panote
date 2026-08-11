import { describe, it, expect } from 'vitest';
import { BaseTileLoadError, TileHttpError } from './index.js';
import { BaseTileLoadError as InternalBaseTileLoadError } from './tile-layer.js';
import { TileHttpError as InternalTileHttpError } from './tile-retry.js';

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

  it('re-exports TileHttpError, the `cause` type its own doc points callers at', () => {
    // BaseTileLoadError's doc tells callers to inspect `cause` and names
    // TileHttpError as what they will find. Leaving that class unexported left
    // the advice unfollowable from outside the package — the only way to name
    // it was to reach past the entry point into './tile-retry.js'.
    expect(TileHttpError).toBe(InternalTileHttpError);

    const err = new BaseTileLoadError('pano-a', 'px', new TileHttpError(401));
    expect(err.cause).toBeInstanceOf(TileHttpError);
    // The status is the point: `permanent` is true for both 401 and 404, but
    // "sign in" and "no such panorama" are not the same thing to a caller.
    expect((err.cause as TileHttpError).status).toBe(401);
    expect(err.permanent).toBe(true);
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
    expect(notPublished.cause).toBeInstanceOf(InternalTileHttpError);
  });
});
