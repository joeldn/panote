import type { UploadMode, UploadState } from '@internal/web-kit';

import type { UploadTarget } from './resume-store.js';

/** The tour/config writes after the image is ready (adding a pano only). */
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
}

export type ChipActionId = 'retry-upload' | 'retry-poll' | 'retry-finalize' | 'sign-in' | 'repick';

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
  actions,
  dismissLabel: 'Dismiss',
});

const SIGNED_OUT = 'You’ve been signed out';

/** What the chip shows for an upload: copy, bar and the actions that apply. Pure. */
export function chipModel(a: ActiveUpload): ChipModel | null {
  const m = a.machine;
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
        actions: [],
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
        note: 'This is taking longer than usual. Check again, or upload the image again.',
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
      if (f.status === 'failed') {
        return f.auth
          ? failed(SIGNED_OUT, 'Your photo is processed. Sign in again to add it to your tour.', [
              { id: 'sign-in', label: 'Sign in' },
            ])
          : failed(
              'Couldn’t add the pano to your tour',
              f.message,
              f.retryable ? [{ id: 'retry-finalize', label: 'Try again' }] : [],
            );
      }
      if (f.status !== 'done') return processing('Almost there — adding it to your tour.');
      return {
        tone: 'ready',
        title: 'Ready at full resolution',
        label: null,
        value: null,
        pct: null,
        bar: 'none',
        note: 'Tiles cached · zoom into every pixel',
        actions: [],
        dismissLabel: 'Dismiss',
      };
    }
    case 'failed':
      switch (m.stage) {
        case 'auth':
          return failed(
            SIGNED_OUT,
            m.resumable
              ? 'Your photo is uploaded. Sign in again and we’ll pick up where we left off.'
              : 'Sign in again to finish uploading it.',
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
        default:
          return failed('Couldn’t start the upload', 'Something went wrong on our side.', [
            reupload(a),
          ]);
      }
  }
}
