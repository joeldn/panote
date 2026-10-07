import { ConflictError, isAuthError } from '@internal/web-kit';

import type { PanoSummary } from '../dashboard/types.js';
import { FinalizeError } from '../upload/finalize.js';

export interface LibraryEntry {
  pano: PanoSummary;
  /** Already a scene of this tour: listed, but can't be added again. */
  inTour: boolean;
}

export interface Library {
  /** Ready panos, the ones that can be added first, each group newest first. */
  entries: LibraryEntry[];
  /** How many can be added right now. */
  addable: number;
  /** Panos left out because they aren't ready (processing, failed, no image). */
  notReady: number;
}

/** Only tiled panos can join a tour from the library; ones being deleted are left out. */
export const isPickable = (p: PanoSummary): boolean => p.tiling === 'ready' && !p.deleting;

/** The picker's view of the owner's panos, given the panoIds this tour already has. */
export function libraryOf(panos: readonly PanoSummary[], tourPanoIds: readonly string[]): Library {
  const inTour = new Set(tourPanoIds);
  const ready = panos
    .filter(isPickable)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((pano) => ({ pano, inTour: inTour.has(pano.panoId) }));
  const entries = [...ready.filter((e) => !e.inTour), ...ready.filter((e) => e.inTour)];
  return {
    entries,
    addable: entries.filter((e) => !e.inTour).length,
    notReady: panos.filter((p) => !p.deleting && p.tiling !== 'ready').length,
  };
}

/** What the picker says when adding a pano failed; the picker stays open to retry. */
export function addErrorMessage(e: unknown): string {
  if (e instanceof FinalizeError) return e.message;
  if (isAuthError(e)) return 'Your session ended. Sign in again, then retry.';
  if (e instanceof ConflictError) return 'This tour keeps changing elsewhere. Try again.';
  return 'Couldn’t add the pano. Check your connection and try again.';
}
