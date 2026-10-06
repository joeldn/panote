import {
  clearForeignPendingUpload,
  clearPendingUpload,
  stashPendingUpload,
  takePendingUpload,
  type XhrLike,
} from '@internal/web-kit';
import { createContext, useContext } from 'react';

import type { ActiveUpload } from './chip-model.js';
import type { UploadTarget } from './resume-store.js';

export type PanoTarget = Exclude<UploadTarget, { kind: 'new-tour' }>;

export interface Uploads {
  active: ActiveUpload | null;
  /** True while an upload is in flight; a new one can't start until it settles. */
  busy: boolean;
  /**
   * Starts an upload (creating the tour first for `new-tour`). Resolves once it's
   * under way with the tour it lands in; rejects if it couldn't start.
   */
  begin(file: File, target: UploadTarget): Promise<{ tourId: string | null }>;
  /** Opens the picker for "Add pano" (`add`) or the camera icon (`replace`). */
  pick(target: PanoTarget): void;
  /** Set after a sign-in redirect lost the file: the target to re-pick it for. */
  repick: { target: UploadTarget; fileName: string; reason: 'signed-out' | 'retry' } | null;
  /** The user closed the re-pick prompt without choosing a file. */
  clearRepick(): void;
  /** The file stashed before a sign-in redirect (the landing's drop, or an auth failure), once. */
  takePendingFile(): Promise<File | null>;
  /** The new `manifest.version` of a pano replaced in this session: `PanoStage`'s `reloadKey`. */
  reloadKeyFor(panoId: string): string | undefined;
  /** The last pano appended to a tour, so an open editor can reload that tour. */
  lastAdded: { tourId: string; panoId: string } | null;
}

export const UploadsContext = createContext<Uploads | null>(null);

export function useUploads(): Uploads {
  const uploads = useContext(UploadsContext);
  if (!uploads) throw new Error('useUploads outside UploadProvider');
  return uploads;
}

/** Where a File waits out a sign-in redirect (IndexedDB, shared with the website's origin). */
export interface PendingUploadStore {
  /** Keeps `file` for `owner` (a user `sub`) across the redirect. */
  stash(file: File, owner: string): Promise<boolean>;
  /** The file, unless it belongs to another user (then it is dropped). */
  take(owner: string | null): Promise<File | null>;
  clear(): Promise<void>;
  /** Drops a stash `owner` can never take (another user's, or expired), so it doesn't linger. */
  dropForeign(owner: string): Promise<void>;
}

export const idbPendingUploads: PendingUploadStore = {
  stash: (file, owner) => stashPendingUpload(file, { owner }),
  take: (owner) => takePendingUpload(owner === null ? {} : { owner }),
  clear: () => clearPendingUpload(),
  dropForeign: async (owner) => {
    await clearForeignPendingUpload({ owner });
  },
};

/** Test seams: the presigned PUT's XHR, the pending-file store, and the tiles base. */
export interface UploadEnv {
  createXhr?: () => XhrLike;
  tilesBase?: string;
  pending?: PendingUploadStore;
}

export const UploadEnvContext = createContext<UploadEnv>({});
