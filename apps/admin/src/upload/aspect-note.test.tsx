import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin } from '../__fixtures__/auth.js';
import { viewerFactory } from '../__fixtures__/editor-server.js';
import {
  FakeXhr,
  fakeBackend,
  fakePending,
  manifest,
  pngFile,
  TILES,
} from '../__fixtures__/upload.js';
import { StageFactoryContext } from '../editor/stage-factory.js';

import { aspectNote, NARROW_NOTE, WIDE_NOTE } from './aspect-note.js';
import { chipModel, type ActiveUpload } from './chip-model.js';
import { UploadChip } from './UploadChip.js';

describe('aspectNote', () => {
  it.each([
    [8000, 4000, null],
    [8000, 3960, null], // 2.02:1, a stitcher a few px off
    [8000, 4080, null], // 1.96:1
    [8000, 2000, WIDE_NOTE],
    [8000, 3800, WIDE_NOTE],
    [4000, 3000, NARROW_NOTE],
    [4000, 4000, NARROW_NOTE],
  ])('%ix%i', (width, height, note) => {
    expect(aspectNote({ width, height })).toBe(note);
  });

  it('says nothing when the size is unknown', () => {
    expect(aspectNote(null)).toBeNull();
    expect(aspectNote({ width: 0, height: 0 })).toBeNull();
  });
});

describe('UploadChip aspect note', () => {
  afterEach(cleanup);

  const active = (machine: ActiveUpload['machine']): ActiveUpload => ({
    key: 1,
    fileName: 'a.png',
    hasFile: true,
    target: { kind: 'add', tourId: 't1' },
    machine,
    landed: null,
    finalize: { status: 'idle' },
  });
  const uploading = active({
    phase: 'upload',
    mode: { kind: 'fresh' },
    panoId: 'p1',
    loaded: 1,
    total: 2,
    pct: 50,
  });
  const show = async (a: ActiveUpload, file: Blob | null) => {
    render(
      <UploadChip model={chipModel(a)!} file={file} onAction={() => {}} onDismiss={() => {}} />,
    );
    // The header read is async.
    await act(async () => {});
  };

  it('shows the note for a photo wider than 2:1', async () => {
    await show(uploading, pngFile('strip.png', 8000, 2000));
    expect(screen.getByRole('note').textContent).toBe(WIDE_NOTE);
  });

  it('shows nothing for a 2:1 photo, or with no file', async () => {
    await show(uploading, pngFile('full.png', 8000, 4000));
    expect(screen.queryByRole('note')).toBeNull();
    cleanup();
    await show(uploading, null);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('drops the note once the upload has failed', async () => {
    const failed = active({ phase: 'failed', panoId: 'p1', stage: 'upload', message: 'm' });
    await show(failed, pngFile('strip.png', 8000, 2000));
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('the upload chip, for a picked photo that isn’t 2:1', () => {
  const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
  const chip = () => screen.getByRole('region', { name: 'Upload status' });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    FakeXhr.all = [];
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('says it will be padded while it uploads and tiles, and stops once it is ready', async () => {
    const backend = fakeBackend();
    renderAdmin('/app/new', {
      auth: fakeAuth(),
      fetch: backend.fetch,
      upload: { tilesBase: TILES, createXhr: () => new FakeXhr(), pending: fakePending() },
      wrap: (tree) => (
        <StageFactoryContext value={viewerFactory().create}>{tree}</StageFactoryContext>
      ),
    });
    await tick();
    fireEvent.change(screen.getByTestId('upload-input'), {
      target: { files: [pngFile('Harbour.png', 8000, 2000)] },
    });
    await tick();
    expect(within(chip()).getByRole('note').textContent).toBe(WIDE_NOTE);

    FakeXhr.last.respond(200);
    await tick();
    expect(within(chip()).getByRole('status').textContent).toBe('Processing on our side');
    expect(within(chip()).getByRole('note').textContent).toBe(WIDE_NOTE);

    backend.state.manifests = [manifest('t2-abc')];
    await tick(1_000);
    expect(within(chip()).getByRole('status').textContent).toBe('Ready at full resolution');
    expect(within(chip()).queryByRole('note')).toBeNull();
  });
});
