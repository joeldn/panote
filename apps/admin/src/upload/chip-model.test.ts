import type { UploadState } from '@internal/web-kit';
import { describe, expect, it } from 'vitest';

import { chipModel, type ActiveUpload, type FinalizeState } from './chip-model.js';

const m = { pano: 'p1', faceSize: 1024, tileSize: 512, maxLevel: 1, faces: [], quality: 85 };
const active = (
  machine: UploadState,
  over: Partial<Pick<ActiveUpload, 'hasFile' | 'finalize' | 'queued' | 'skipped' | 'limited'>> = {},
): ActiveUpload => ({
  ...over,
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

  it('processing after the tour write still reads as processing; its failure shows at once', () => {
    const processing: UploadState = {
      phase: 'processing',
      mode: { kind: 'fresh' },
      panoId: 'p1',
      startedAt: 0,
    };
    for (const status of ['running', 'done'] as const) {
      expect(chipModel(active(processing, { finalize: { status } }))?.title).toBe(
        'Processing on our side',
      );
    }
    const failedWrite: FinalizeState = {
      status: 'failed',
      auth: false,
      message: 'This tour no longer exists.',
      retryable: true,
    };
    expect(chipModel(active(processing, { finalize: failedWrite }))).toMatchObject({
      title: 'Couldn’t add the pano to your tour',
      note: 'This tour no longer exists.',
    });
    const timedOut: UploadState = { ...processing, phase: 'timed-out', checking: true };
    expect(actions(active(timedOut, { finalize: { ...failedWrite, auth: true } }))).toEqual([
      'sign-in',
    ]);
  });

  it('timed-out offers a re-poll and a re-upload (a re-pick when the file is gone)', () => {
    const t: UploadState = {
      phase: 'timed-out',
      mode: { kind: 'fresh' },
      panoId: 'p1',
      startedAt: 0,
      checking: true,
    };
    expect(actions(active(t))).toEqual(['retry-poll', 'retry-upload']);
    expect(actions(active(t, { hasFile: false }))).toEqual(['retry-poll', 'repick']);
  });

  it('timed-out says it keeps checking until the give-up cap, then asks the user', () => {
    const t: UploadState = {
      phase: 'timed-out',
      mode: { kind: 'fresh' },
      panoId: 'p1',
      startedAt: 0,
      checking: true,
    };
    expect(chipModel(active(t))).toMatchObject({
      title: 'Still processing',
      note: 'Taking longer than usual — we’ll keep checking.',
    });
    expect(chipModel(active({ ...t, checking: false }))?.note).toBe(
      'This is taking longer than usual. Check again, or upload the image again.',
    );
    expect(actions(active({ ...t, checking: false }))).toEqual(['retry-poll', 'retry-upload']);
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

  it('a batch: the files still waiting show under the note, and can be cancelled', () => {
    const up: UploadState = {
      phase: 'upload',
      mode: { kind: 'fresh' },
      panoId: 'p1',
      loaded: 1,
      total: 2,
      pct: 50,
    };
    expect(chipModel(active(up))).toMatchObject({ queue: null, actions: [] });
    expect(chipModel(active(up, { queued: 3 }))).toMatchObject({
      title: 'Uploading panorama',
      queue: '3 more waiting',
      dismissLabel: 'Cancel upload',
    });
    expect(actions(active(up, { queued: 3 }))).toEqual(['cancel-queue']);
  });

  it('a limit on presign says so, offers no retry for a quota, and counts what never started', () => {
    const f = {
      phase: 'failed',
      panoId: null,
      stage: 'presign',
      message:
        'This account has reached its daily upload limit. Try again later today or tomorrow.',
    } as UploadState;
    expect(chipModel(active(f, { limited: 'quota', skipped: 4 }))).toMatchObject({
      title: 'Upload limit reached',
      note: 'This account has reached its daily upload limit. Try again later today or tomorrow. 4 more photos weren’t uploaded. Add them again later.',
      actions: [],
    });
    expect(chipModel(active(f, { limited: 'quota', skipped: 1 }))?.note).toContain(
      '1 more photo wasn’t uploaded. Add it again later.',
    );
    // The rate limit clears within a minute: that one can be tried again.
    expect(actions(active(f, { limited: 'rate' }))).toEqual(['retry-upload']);
  });

  it('a disabled or deleted account gets its own title, no retry, and no "add again"', () => {
    const f = {
      phase: 'failed',
      panoId: null,
      stage: 'presign',
      message: 'This account has been deleted.',
    } as UploadState;
    expect(chipModel(active(f, { limited: 'account', skipped: 2 }))).toMatchObject({
      title: 'Uploads are off for this account',
      note: 'This account has been deleted. 2 more photos weren’t uploaded.',
      actions: [],
    });
  });

  it('a sign-in that stopped a batch says the rest has to be added again', () => {
    const f = { phase: 'failed', panoId: null, stage: 'auth', message: 'm' } as UploadState;
    expect(chipModel(active(f, { skipped: 2 }))?.note).toBe(
      'Sign in again to finish uploading it. 2 more photos weren’t uploaded. Add them again after you sign in.',
    );
  });

  it('cancelled hides the chip', () => {
    expect(chipModel(active({ phase: 'cancelled', panoId: null }))).toBeNull();
  });
});
