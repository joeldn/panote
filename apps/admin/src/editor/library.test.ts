import { ApiError, ConflictError } from '@internal/web-kit';
import { describe, expect, it } from 'vitest';

import type { PanoSummary } from '../dashboard/types.js';
import { FinalizeError } from '../upload/finalize.js';
import { addErrorMessage, libraryOf } from './library.js';

const pano = (panoId: string, over: Partial<PanoSummary> = {}): PanoSummary => ({
  panoId,
  title: panoId,
  hasConfig: true,
  hasOriginal: true,
  deleting: false,
  tiling: 'ready',
  manifest: { version: 't1-x', format: 'webp', tileSize: 512 },
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('libraryOf', () => {
  it('keeps ready panos, addable ones first, each group newest first', () => {
    const lib = libraryOf(
      [
        pano('old', { updatedAt: '2026-01-01T00:00:00.000Z' }),
        pano('mine', { updatedAt: '2026-12-01T00:00:00.000Z' }),
        pano('new', { updatedAt: '2026-11-01T00:00:00.000Z' }),
        pano('tiling', { tiling: 'pending', manifest: null }),
        pano('broken', { tiling: 'failed', manifest: null }),
        pano('bare', { tiling: 'none', hasOriginal: false, manifest: null }),
        pano('deleting', { deleting: true }),
        pano('deleting-pending', { deleting: true, tiling: 'pending' }),
      ],
      ['mine'],
    );
    expect(lib.entries.map((e) => [e.pano.panoId, e.inTour])).toEqual([
      ['new', false],
      ['old', false],
      ['mine', true],
    ]);
    expect(lib.addable).toBe(2);
    // Being deleted is gone for good, not "not ready yet".
    expect(lib.notReady).toBe(3);
  });

  it('is empty for an empty library', () => {
    expect(libraryOf([], [])).toEqual({ entries: [], addable: 0, notReady: 0 });
  });
});

describe('addErrorMessage', () => {
  it('passes a finishing-step message through and names the rest', () => {
    expect(addErrorMessage(new FinalizeError('This pano is being deleted.', false))).toBe(
      'This pano is being deleted.',
    );
    expect(addErrorMessage(new ConflictError({}))).toMatch(/keeps changing elsewhere/);
    expect(addErrorMessage(new ApiError(500, {}))).toMatch(/Couldn’t add the pano/);
  });
});
