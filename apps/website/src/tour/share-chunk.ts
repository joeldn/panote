import type * as ShareExports from '@internal/ui/share';

import { importWithoutReload } from '../chunk-reload.js';

type ShareModule = typeof ShareExports;

/**
 * The visitor share sheet's chunk. Most visitors never open it, so it stays off the
 * tour's entry and loads on the first reach for Share. `load` is a test seam, and
 * `pending` the import in flight or done (cleared when it fails, so a retry fetches).
 */
export const shareChunk: {
  load: () => Promise<ShareModule>;
  pending: Promise<ShareModule> | null;
} = {
  load: () => import('@internal/ui/share'),
  pending: null,
};

/** The sheet module, fetched once; a failed fetch is forgotten so the next call retries. */
export function loadShare(): Promise<ShareModule> {
  shareChunk.pending ??= importWithoutReload(shareChunk.load).catch((err: unknown) => {
    shareChunk.pending = null;
    throw err;
  });
  return shareChunk.pending;
}

/** Starts fetching the sheet (pointer over, focus or touch on Share); never rejects. */
export function prefetchShareSheet(): void {
  loadShare().catch(() => {});
}
