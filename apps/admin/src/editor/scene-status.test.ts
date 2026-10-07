import type { UploadState } from '@internal/web-kit';
import { describe, expect, it } from 'vitest';

import type { PendingUpload } from '../upload/upload-context.js';
import {
  isLanding,
  isLookOnly,
  isPendingCard,
  pendingProblem,
  pendingLine,
  pendingPct,
  sceneStatusOf,
  tilingOf,
  tilingOfJob,
} from './scene-status.js';

const fresh = { kind: 'fresh' } as const;

const job = (machine: UploadState, over: Partial<PendingUpload> = {}): PendingUpload => ({
  key: 'upload-1',
  target: { kind: 'add', tourId: 't1' },
  fileName: 'Hall.jpg',
  panoId: 'p1',
  machine,
  finalize: { status: 'idle' },
  hasPreview: false,
  ...over,
});

describe('scene status', () => {
  it('reads an upload job’s phase', () => {
    expect(tilingOfJob(job({ phase: 'preparing', mode: null }))).toBe('uploading');
    expect(tilingOfJob(job({ phase: 'processing', mode: fresh, panoId: 'p1', startedAt: 0 }))).toBe(
      'processing',
    );
    expect(
      tilingOfJob(
        job({ phase: 'timed-out', mode: fresh, panoId: 'p1', startedAt: 0, checking: true }),
      ),
    ).toBe('timed-out');
    expect(tilingOfJob(job({ phase: 'failed', panoId: 'p1', stage: 'tiling', message: '' }))).toBe(
      'failed',
    );
    // A failed PUT leaves whatever was there before: the job says nothing about it.
    expect(tilingOfJob(job({ phase: 'failed', panoId: 'p1', stage: 'upload', message: '' }))).toBe(
      'unknown',
    );
    expect(
      tilingOfJob(
        job({ phase: 'failed', panoId: 'p1', stage: 'auth', message: '', resumable: fresh }),
      ),
    ).toBe('processing');
  });

  it('prefers the newest job, then the editor’s polls, then a reload this session', () => {
    const processing = job({ phase: 'processing', mode: fresh, panoId: 'p1', startedAt: 0 });
    const failed = job(
      { phase: 'failed', panoId: 'p1', stage: 'tiling', message: '' },
      { key: 'upload-2' },
    );
    expect(tilingOf('p1', [processing, failed], { state: 'ready' }, true)).toBe('failed');
    expect(tilingOf('p1', [], { state: 'pending' }, true)).toBe('processing');
    expect(tilingOf('p1', [], undefined, true)).toBe('ready');
    expect(tilingOf('p1', [], undefined, false)).toBe('unknown');
    expect(sceneStatusOf('ready')).toBeNull();
    expect(sceneStatusOf('unknown')).toBeNull();
    expect(sceneStatusOf('timed-out')).toBe('timed-out');
  });

  it('describes a pending card until its scene is in the tour', () => {
    const uploading = job({
      phase: 'upload',
      mode: fresh,
      panoId: 'p1',
      loaded: 3,
      total: 10,
      pct: 30,
    });
    expect(isPendingCard(uploading, [])).toBe(true);
    expect(isPendingCard(uploading, ['p1'])).toBe(false);
    expect(
      isPendingCard(
        job(uploading.machine, { target: { kind: 'replace', tourId: 't1', panoId: 'p1' } }),
        [],
      ),
    ).toBe(false);
    expect(pendingLine(uploading)).toBe('Uploading 30%');
    expect(pendingPct(uploading)).toBe(30);
    const landed = job(
      { phase: 'processing', mode: fresh, panoId: 'p1', startedAt: 0 },
      { finalize: { status: 'running' } },
    );
    expect(pendingLine(landed)).toBe('Adding to the tour…');
    expect(pendingPct(landed)).toBeNull();
    expect(
      pendingLine(
        job(landed.machine, {
          finalize: { status: 'failed', auth: false, message: 'x', retryable: true },
        }),
      ),
    ).toBe('Couldn’t add it to the tour');
  });

  it('is look-only only while the image uploads', () => {
    expect(isLookOnly('uploading')).toBe(true);
    expect(isLookOnly('processing')).toBe(false);
    expect(isLookOnly('failed')).toBe(false);
    expect(isLookOnly('timed-out')).toBe(false);
    expect(isLookOnly(null)).toBe(false);
  });

  it('drops the card once the tour write went through', () => {
    const appended = job(
      { phase: 'processing', mode: fresh, panoId: 'p1', startedAt: 0 },
      { finalize: { status: 'done' } },
    );
    expect(isPendingCard(appended, [])).toBe(false);
    // Not synced in yet: still on stage. Known to this editor (removed since): gone.
    expect(isLanding(appended, [], [])).toBe(true);
    expect(isLanding(appended, [], ['p1'])).toBe(false);
    expect(isLanding(appended, ['p1'], ['p1'])).toBe(false);
    expect(pendingProblem(appended)).toBe(false);
    expect(
      pendingProblem(job({ phase: 'failed', panoId: 'p1', stage: 'upload', message: '' })),
    ).toBe(true);
  });
});
