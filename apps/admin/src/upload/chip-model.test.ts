import type { UploadState } from '@internal/web-kit';
import { describe, expect, it } from 'vitest';

import { chipModel, type ActiveUpload, type FinalizeState } from './chip-model.js';

const m = { pano: 'p1', faceSize: 1024, tileSize: 512, maxLevel: 1, faces: [], quality: 85 };
const active = (
  machine: UploadState,
  over: { hasFile?: boolean; finalize?: FinalizeState } = {},
): ActiveUpload => ({
  key: 1,
  fileName: 'a.jpg',
  hasFile: over.hasFile ?? true,
  target: { kind: 'add', tourId: 't1' },
  machine,
  landed: null,
  finalize: over.finalize ?? { status: 'idle' },
});
const actions = (a: ActiveUpload) => chipModel(a)?.actions.map((x) => x.id);

describe('chipModel', () => {
  it('upload: determinate bar from PUT progress, keep-the-tab-open note', () => {
    const c = chipModel(
      active({
        phase: 'upload',
        mode: { kind: 'fresh' },
        panoId: 'p1',
        loaded: 66,
        total: 100,
        pct: 66,
      }),
    );
    expect(c).toMatchObject({
      title: 'Uploading panorama',
      label: 'Upload',
      value: '66%',
      bar: 'determinate',
      pct: 66,
      note: 'Full-resolution original — keep this tab open',
      dismissLabel: 'Cancel upload',
    });
    expect(chipModel(active({ phase: 'preparing', mode: null }))).toMatchObject({ value: '0%' });
  });

  it('processing: indeterminate, never a percentage', () => {
    const c = chipModel(
      active({ phase: 'processing', mode: { kind: 'fresh' }, panoId: 'p1', startedAt: 0 }),
    );
    expect(c).toMatchObject({ title: 'Processing on our side', bar: 'indeterminate', pct: null });
  });

  it('ready waits for the tour write, and surfaces its failure', () => {
    const ready = { phase: 'ready', panoId: 'p1', manifest: m } as unknown as UploadState;
    expect(chipModel(active(ready, { finalize: { status: 'running' } }))?.title).toBe(
      'Processing on our side',
    );
    expect(chipModel(active(ready, { finalize: { status: 'done' } }))?.title).toBe(
      'Ready at full resolution',
    );
    const fail = (auth: boolean, retryable = true): FinalizeState => ({
      status: 'failed',
      auth,
      message: 'x',
      retryable,
    });
    expect(actions(active(ready, { finalize: fail(false) }))).toEqual(['retry-finalize']);
    // A full tour: retrying can't help, so there is nothing to press.
    expect(actions(active(ready, { finalize: fail(false, false) }))).toEqual([]);
    const signedOut = active(ready, { finalize: fail(true) });
    expect(actions(signedOut)).toEqual(['sign-in']);
  });

  it('timed-out offers a re-poll and a re-upload (a re-pick when the file is gone)', () => {
    const t = { phase: 'timed-out', mode: { kind: 'fresh' }, panoId: 'p1' } as UploadState;
    expect(actions(active(t))).toEqual(['retry-poll', 'retry-upload']);
    expect(actions(active(t, { hasFile: false }))).toEqual(['retry-poll', 'repick']);
  });

  it.each([
    ['upload', 'Upload failed'],
    ['presign', 'Couldn’t start the upload'],
    ['prepare', 'Couldn’t start the upload'],
    ['tiling', 'We couldn’t process this image'],
  ] as const)('failed at %s retries the upload', (stage, title) => {
    const f = { phase: 'failed', panoId: 'p1', stage, message: 'm' } as UploadState;
    expect(chipModel(active(f))).toMatchObject({ title, tone: 'failed' });
    expect(actions(active(f))).toEqual(['retry-upload']);
    expect(actions(active(f, { hasFile: false }))).toEqual(['repick']);
  });

  it('failed at auth asks to sign in, saying whether the photo already landed', () => {
    const before = { phase: 'failed', panoId: null, stage: 'auth', message: 'm' } as UploadState;
    expect(chipModel(active(before))?.note).toBe('Sign in again to finish uploading it.');
    const after = { ...before, panoId: 'p1', resumable: { kind: 'fresh' } } as UploadState;
    expect(chipModel(active(after))?.note).toContain('Your photo is uploaded');
    expect(actions(active(after))).toEqual(['sign-in']);
  });

  it('cancelled hides the chip', () => {
    expect(chipModel(active({ phase: 'cancelled', panoId: null }))).toBeNull();
  });
});
