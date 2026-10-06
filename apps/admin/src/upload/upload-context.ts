import type { StagePreview } from '@internal/ui';
import {
  clearForeignPendingUpload,
  clearPendingUpload,
  stashPendingUpload,
  takePendingUpload,
  type PreviewDecoder,
  type UploadState,
  type XhrLike,
} from '@internal/web-kit';
import { createContext, useContext } from 'react';

import type { ActiveUpload, FinalizeState } from './chip-model.js';
import type { UploadTarget } from './resume-store.js';

export type PanoTarget = Exclude<UploadTarget, { kind: 'new-tour' }>;

/** An upload into a tour that hasn't finished yet, for the editor's pending cards. */
export interface PendingUpload {
  /** Stable per upload job (a retry is a new job); the same key `previewFor` uses. */
  key: string;
  target: PanoTarget;
  fileName: string;
  /** The pano it lands as, once known: the replace target, or the presigned id. */
  panoId: string | null;
  machine: UploadState;
  /** An added pano's config and tour write, which run as soon as the image lands. */
  finalize: FinalizeState;
  /** A local preview is decoded: `previewFor(panoId)` returns it once `panoId` is known. */
  hasPreview: boolean;
}

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
  /**
   * The last pano appended to a tour, so an open editor can reload that tour. Set as
   * soon as the image lands (the scene is added before its tiles exist).
   */
  lastAdded: { tourId: string; panoId: string } | null;
  /**
   * The local preview of an upload of `panoId`, for `PanoStage`'s `preview`: from the
   * moment it is decoded until the upload is finished with (its tiles are ready and
   * reloaded) or cancelled. Null for a replace until its baseline version is known.
   */
  previewFor(panoId: string): StagePreview | null;
  /** Uploads into `tourId` still under way (or failed and not dismissed), oldest first. */
  pendingFor(tourId: string): PendingUpload[];
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

/** Test seams: the presigned PUT's XHR, the pending-file store, the tiles base, the preview decode. */
export interface UploadEnv {
  createXhr?: () => XhrLike;
  tilesBase?: string;
  pending?: PendingUploadStore;
  decodePreview?: PreviewDecoder;
  maxTextureSize?: number;
}

export const UploadEnvContext = createContext<UploadEnv>({});
