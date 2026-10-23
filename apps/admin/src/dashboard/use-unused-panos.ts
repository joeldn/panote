import type { PanoSummary } from './types.js';
import { isAuthError, panoDeleteErrorOf } from '@internal/web-kit';

/** Unused = the server says no tour of the owner has a scene on it. Unknown never counts. */
export const isUnused = (p: PanoSummary): boolean => p.referenced === false && !p.deleting;

/** Still tiling; the server refuses to delete it until it's ready (or clearly stalled). */
export const isProcessing = (p: PanoSummary): boolean => p.tiling === 'pending';

export const panoTitle = (p: PanoSummary): string => p.title ?? 'Untitled pano';

/** The owner's unused panos, newest first. */
export const unusedPanos = (panos: Iterable<PanoSummary>): PanoSummary[] =>
  [...panos].filter(isUnused).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export function deletePanoErrorMessage(e: unknown): string {
  if (isAuthError(e)) return 'Your session ended. Sign in again, then retry.';
  switch (panoDeleteErrorOf(e)) {
    case 'processing':
      return 'This pano is still processing. Try again once it’s ready.';
    case 'recent':
      return 'This pano was uploaded less than an hour ago, so it may still be joining a tour. Try again later.';
    default:
      return 'Couldn’t delete the pano. Check your connection and try again.';
  }
}
