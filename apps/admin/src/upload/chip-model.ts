import type { UploadMode, UploadState } from '@internal/web-kit';

import type { UploadTarget } from './resume-store.js';

/**
 * After the image lands: for an added pano, its config and tour write (run as soon as
 * the PUT completes, while tiling goes on); for a replace, the reload once it's ready.
 */
export type FinalizeState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done' }
  | { status: 'failed'; auth: boolean; message: string; retryable: boolean };

/** One upload as the provider tracks it; `machine` mirrors the upload machine's onChange. */
export interface ActiveUpload {
  key: number;
  fileName: string;
  /** False after a sign-in redirect: retrying the upload needs the file picked again. */
  hasFile: boolean;
  target: Exclude<UploadTarget, { kind: 'new-tour' }>;
  machine: UploadState;
  /** Set once the PUT completed, so a retry re-uploads over the same pano. */
  landed: { panoId: string; mode: UploadMode } | null;
  finalize: FinalizeState;
  /** Files picked with this one that wait for their turn (uploads run one at a time). */
  queued?: number;
  /** Files of its batch that never started: this one hit a limit or needs a sign-in. */
  skipped?: number;
  /** The presign was refused by an account limit (`quota`) or the rate limit (`rate`). */
  limited?: UploadLimit;
}

/**
 * Why a presign was refused: an account quota (`quota`), the per-minute rate limit
 * (`rate`), or an account that is disabled or deleted (`account`); null when it wasn't.
 */
export type UploadLimit = 'quota' | 'rate' | 'account' | null;

export type ChipActionId =
  'retry-upload' | 'retry-poll' | 'retry-finalize' | 'sign-in' | 'repick' | 'cancel-queue';

export interface ChipModel {
  tone: 'upload' | 'processing' | 'ready' | 'failed' | 'timed-out';
  title: string;
  /** The mono meta row: "Upload 66%", "Tiling Working…". */
  label: string | null;
  value: string | null;
  /** Determinate bar percentage; null = indeterminate (or no bar). */
  pct: number | null;
  bar: 'determinate' | 'indeterminate' | 'none';
  note: string;
  /** "3 more waiting": the rest of a batch, one line under the note. */
  queue: string | null;
  actions: Array<{ id: ChipActionId; label: string }>;
  dismissLabel: string;
}

const reupload = (a: ActiveUpload) =>
  a.hasFile
    ? ({ id: 'retry-upload', label: 'Try again' } as const)
    : ({ id: 'repick', label: 'Choose file' } as const);

const processing = (note: string): ChipModel => ({
  tone: 'processing',
  title: 'Processing on our side',
  label: 'Tiling',
  value: 'Working…',
  pct: null,
  bar: 'indeterminate',
  note,
  queue: null,
  actions: [],
  // Hiding never stops the work: it finishes in the background (UploadProvider.dismiss).
  dismissLabel: 'Hide (keeps processing)',
});

const failed = (title: string, note: string, actions: ChipModel['actions']): ChipModel => ({
  tone: 'failed',
  title,
  label: null,
  value: null,
  pct: null,
  bar: 'none',
  note,
  queue: null,
  actions,
  dismissLabel: 'Dismiss',
});

const SIGNED_OUT = 'You’ve been signed out';

/** The rest of a batch that a limit or a sign-in stopped: it has to be picked again. */
const skippedNote = (a: ActiveUpload, when: string | null): string => {
  if (!a.skipped) return '';
  const one = a.skipped === 1;
  const what = one ? '1 more photo wasn’t' : `${a.skipped} more photos weren’t`;
  return ` ${what} uploaded.` + (when ? ` Add ${one ? 'it' : 'them'} again ${when}.` : '');
};

const finalizeFailed = (f: Extract<FinalizeState, { status: 'failed' }>): ChipModel =>
  f.auth
    ? failed(SIGNED_OUT, 'Your photo is uploaded. Sign in again to add it to your tour.', [
        { id: 'sign-in', label: 'Sign in' },
      ])
    : failed(
        'Couldn’t add the pano to your tour',
        f.message,
        f.retryable ? [{ id: 'retry-finalize', label: 'Try again' }] : [],
      );

/** What the chip shows for an upload: copy, bar and the actions that apply. Pure. */
export function chipModel(a: ActiveUpload): ChipModel | null {
  const m = a.machine;
  // The tour write runs while tiling goes on: its failure is the one the user can act on.
  if ((m.phase === 'processing' || m.phase === 'timed-out') && a.finalize.status === 'failed') {
    return finalizeFailed(a.finalize);
  }
  switch (m.phase) {
    case 'cancelled':
      return null;
    case 'preparing':
    case 'upload': {
      const pct = m.phase === 'upload' ? m.pct : 0;
      return {
        tone: 'upload',
        title: 'Uploading panorama',
        label: 'Upload',
        value: `${pct}%`,
        pct,
        bar: 'determinate',
        note: 'Full-resolution original — keep this tab open',
        queue: a.queued ? `${a.queued} more waiting` : null,
        actions: a.queued ? [{ id: 'cancel-queue', label: 'Cancel the rest' }] : [],
        dismissLabel: 'Cancel upload',
      };
    }
    case 'processing':
      return processing('Tiling takes a moment. We’ll switch over the second it lands.');
    case 'timed-out':
      return {
        tone: 'timed-out',
        title: 'Still processing',
        label: null,
        value: null,
        pct: null,
        bar: 'none',
        queue: null,
        // Still slow-polling until the give-up cap; a manifest switches over on its own.
        note: m.checking
          ? 'Taking longer than usual — we’ll keep checking.'
          : 'This is taking longer than usual. Check again, or upload the image again.',
        actions: [
          { id: 'retry-poll', label: 'Check again' },
          a.hasFile
            ? { id: 'retry-upload', label: 'Re-upload' }
            : { id: 'repick', label: 'Re-upload' },
        ],
        dismissLabel: 'Dismiss',
      };
    case 'ready': {
      const f = a.finalize;
      if (f.status === 'failed') return finalizeFailed(f);
      if (f.status !== 'done') return processing('Almost there — adding it to your tour.');
      return {
        tone: 'ready',
        title: 'Ready at full resolution',
        label: null,
        value: null,
        pct: null,
        bar: 'none',
        note: 'Tiles cached · zoom into every pixel',
        queue: null,
        actions: [],
        dismissLabel: 'Dismiss',
      };
    }
    case 'failed':
      switch (m.stage) {
        case 'auth':
          return failed(
            SIGNED_OUT,
            (m.resumable
              ? 'Your photo is uploaded. Sign in again and we’ll pick up where we left off.'
              : 'Sign in again to finish uploading it.') + skippedNote(a, 'after you sign in'),
            [{ id: 'sign-in', label: 'Sign in' }],
          );
        case 'tiling':
          return failed(
            'We couldn’t process this image',
            'Make sure it’s an equirectangular JPG, PNG or WebP, then try again.',
            [reupload(a)],
          );
        case 'upload':
          return failed(
            'Upload failed',
            'The upload didn’t finish. Check your connection and try again.',
            [reupload(a)],
          );
        case 'presign':
          // An account limit: the server's message says which, and retrying can't help.
          // The rate limit clears within a minute, so that one can be tried again.
          // Disabled or deleted: the server's message says which, and what to do.
          if (a.limited === 'account') {
            return failed('Uploads are off for this account', m.message + skippedNote(a, null), []);
          }
          if (a.limited) {
            return failed(
              'Upload limit reached',
              m.message + skippedNote(a, 'later'),
              a.limited === 'rate' ? [reupload(a)] : [],
            );
          }
          return failed('Couldn’t start the upload', 'Something went wrong on our side.', [
            reupload(a),
          ]);
        default:
          return failed('Couldn’t start the upload', 'Something went wrong on our side.', [
            reupload(a),
          ]);
      }
  }
}
