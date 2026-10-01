import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { PROCESSING_TIMEOUT_MS, STATUS_POLL_MS } from '@internal/web-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';
import {
  FakeXhr,
  fakeBackend,
  fakePending,
  manifest,
  PUT_URL,
  pngFile,
  TILES,
} from '../__fixtures__/upload.js';

import { readResumeRecord } from './resume-store.js';
import { READY_CHIP_MS } from './UploadProvider.js';

const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

const chip = () => screen.getByRole('region', { name: 'Upload status' });
const chipTitle = () => within(chip()).getByRole('status').textContent;

function setup(path = '/app/new', pending = fakePending()) {
  const backend = fakeBackend();
  const app = renderAdmin(path, {
    fetch: backend.fetch,
    upload: { tilesBase: TILES, createXhr: () => new FakeXhr(), pending },
  });
  return { backend, pending, ...app };
}

async function pick(file: File = pngFile()) {
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [file] } });
  await tick();
}

/** From /app/new through a completed PUT: the chip is processing. */
async function uploadThroughPut(file?: File) {
  const ctx = setup();
  await tick();
  await pick(file);
  FakeXhr.last.respond(200);
  await tick();
  return ctx;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-01T09:00:00Z'));
  // A backgrounded tab: rAF exists but never runs. Nothing may depend on it.
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  FakeXhr.all = [];
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fresh upload from /app/new', () => {
  it('creates the tour, presigns, PUTs with the pinned type, polls the manifest, then adds the pano', async () => {
    const { backend, router } = setup();
    await tick();
    const file = pngFile('Town_hall.png', 8000, 4000, 4000);
    await pick(file);

    // The tour exists first, and the overlay hands over to its editor.
    expect(backend.state.calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/admin/tours',
      body: { title: 'Town hall', scenes: [] },
    });
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(backend.presigns()[0]?.body).toEqual({ contentType: 'image/png', size: 4000 });
    expect(backend.presigns()[0]?.headers.authorization).toBe('Bearer jwt-token');
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe(PUT_URL);
    expect(xhr.headers['content-type']).toBe('image/png');
    expect(xhr.body).toBe(file);
    expect(chipTitle()).toBe('Uploading panorama');

    xhr.progress(2640, 4000);
    await tick();
    expect(within(chip()).getByText('66%')).toBeTruthy();
    expect(
      within(chip())
        .getByRole('progressbar', { name: 'Upload progress' })
        .getAttribute('aria-valuenow'),
    ).toBe('66');

    backend.state.manifests = [null, manifest('t1-abc')];
    xhr.respond(200);
    await tick();
    expect(chipTitle()).toBe('Processing on our side');
    expect(within(chip()).getByText('Working…')).toBeTruthy();

    await tick(1_000);
    expect(chipTitle()).toBe('Processing on our side');
    await tick(1_500);
    expect(chipTitle()).toBe('Ready at full resolution');

    // Readiness reads bypass the HTTP cache.
    expect(backend.manifestPolls().every((c) => c.cache === 'no-store')).toBe(true);
    const [config, tour] = backend.writes();
    expect(config).toMatchObject({
      url: '/api/admin/panos/pano-1/config',
      headers: { 'if-match': '*' },
      body: { title: 'Town hall' },
    });
    expect(tour).toMatchObject({
      url: '/api/admin/tours/tour-1',
      headers: { 'if-match': '"t1"' },
      body: { tourId: 'tour-1', title: 'Town hall', scenes: [{ panoId: 'pano-1' }] },
    });

    await tick(READY_CHIP_MS);
    expect(screen.queryByRole('region', { name: 'Upload status' })).toBeNull();
  });

  it('rejects a wrong type, an oversized file and too many pixels before any request', async () => {
    const { backend } = setup();
    await tick();
    await pick(new File(['GIF89a'], 'a.gif', { type: 'image/gif' }));
    expect(screen.getByRole('alert').textContent).toBe('Use a JPG, PNG or WebP image.');

    const big = pngFile();
    Object.defineProperty(big, 'size', { value: 150 * 1024 * 1024 + 1 });
    await pick(big);
    expect(screen.getByRole('alert').textContent).toBe('This file is larger than 150 MB.');

    await pick(pngFile('huge.png', 20_000, 10_000));
    expect(screen.getByRole('alert').textContent).toContain('200 megapixels');

    expect(backend.state.calls).toEqual([]);
    expect(FakeXhr.all).toEqual([]);
  });

  it('a failed PUT offers Try again, which presigns and uploads again', async () => {
    const { backend } = setup();
    await tick();
    await pick();
    FakeXhr.last.fail();
    await tick();
    expect(chipTitle()).toBe('Upload failed');

    fireEvent.click(within(chip()).getByRole('button', { name: 'Try again' }));
    await tick();
    expect(backend.presigns()).toHaveLength(2);
    expect(backend.presigns()[1]?.body).toEqual({ contentType: 'image/png', size: 2000 });
    expect(FakeXhr.all).toHaveLength(2);
    expect(chipTitle()).toBe('Uploading panorama');
  });

  it('a tiling failure re-uploads over the same pano on Try again', async () => {
    const { backend } = await uploadThroughPut();
    backend.state.tiling = 'failed';
    await tick(STATUS_POLL_MS);
    expect(chipTitle()).toBe('We couldn’t process this image');

    fireEvent.click(within(chip()).getByRole('button', { name: 'Try again' }));
    await tick();
    // Replace-presign the landed panoId rather than orphan it with a new one.
    expect(backend.presigns()[1]?.body).toEqual({
      contentType: 'image/png',
      size: 2000,
      panoId: 'pano-1',
    });
    expect(chipTitle()).toBe('Uploading panorama');
  });

  it('times out after 10 minutes; Check again re-polls without re-uploading', async () => {
    const { backend } = await uploadThroughPut();
    await tick(PROCESSING_TIMEOUT_MS);
    expect(chipTitle()).toBe('Still processing');
    const polls = backend.manifestPolls().length;
    await tick(60_000);
    expect(backend.manifestPolls()).toHaveLength(polls);

    backend.state.manifests = [manifest('t1-abc')];
    fireEvent.click(within(chip()).getByRole('button', { name: 'Check again' }));
    await tick();
    expect(chipTitle()).toBe('Processing on our side');
    await tick(1_000);
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(backend.presigns()).toHaveLength(1);
  });

  it('dismissing aborts the PUT; dismissing while processing stops the polls', async () => {
    const { backend } = setup();
    await tick();
    await pick();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Cancel upload' }));
    await tick();
    expect(FakeXhr.last.aborted).toBe(true);
    expect(screen.queryByRole('region', { name: 'Upload status' })).toBeNull();
    expect(backend.manifestPolls()).toHaveLength(0);

    cleanup();
    const next = await uploadThroughPut();
    await tick(1_000);
    const polls = next.backend.manifestPolls().length;
    fireEvent.click(within(chip()).getByRole('button', { name: 'Stop watching' }));
    await tick(60_000);
    expect(next.backend.manifestPolls()).toHaveLength(polls);
  });
});

describe('re-upload without the file in memory', () => {
  it('a resumed upload that times out re-uploads a re-picked file over the same pano', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({
        v: 1,
        fileName: 'Town_hall.png',
        target: { kind: 'add', tourId: 'tour-1' },
        landed: { panoId: 'pano-1', mode: { kind: 'fresh' } },
        savedAt: Date.now(),
      }),
    );
    const { backend } = setup('/app/t/tour-1');
    await tick();
    await tick(PROCESSING_TIMEOUT_MS);
    expect(chipTitle()).toBe('Still processing');

    fireEvent.click(within(chip()).getByRole('button', { name: 'Re-upload' }));
    await tick();
    expect(screen.getByRole('dialog', { name: 'Add pano' }).textContent).toContain(
      'Choose “Town_hall.png” again to upload it.',
    );
    await pick();
    expect(backend.presigns()[0]?.body).toMatchObject({ panoId: 'pano-1' });
  });
});

describe('background tab', () => {
  it('polls as soon as a hidden tab is shown again, without waiting for throttled timers', async () => {
    const { backend } = await uploadThroughPut();
    await tick(1_000);
    expect(backend.manifestPolls()).toHaveLength(1);

    backend.state.manifests = [manifest('t1-abc')];
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(backend.manifestPolls()).toHaveLength(1);

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(backend.manifestPolls()).toHaveLength(2);
    expect(chipTitle()).toBe('Ready at full resolution');
  });

  it('times out on return when the timers never fired while hidden', async () => {
    await uploadThroughPut();
    vi.setSystemTime(Date.now() + PROCESSING_TIMEOUT_MS);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(chipTitle()).toBe('Still processing');
  });
});

describe('sign-in during an upload', () => {
  it('a 401 on presign stashes the file; after sign-in the upload restarts with it', async () => {
    const { backend, pending } = setup();
    backend.state.presignStatus = 401;
    await tick();
    const file = pngFile();
    await pick(file);
    expect(chipTitle()).toBe('You’ve been signed out');
    // The session wrapper opened the sign-in prompt as well.
    expect(screen.getByRole('dialog', { name: 'Your session has ended' })).toBeTruthy();
    expect(readResumeRecord()).toMatchObject({
      fileName: 'Town_hall.png',
      target: { kind: 'add', tourId: 'tour-1' },
      landed: null,
    });
    expect(pending.peek()).toBe(file);

    // The Auth0 redirect reloads the page and returns here: the record and the stash survive.
    cleanup();
    const back = setup('/app/t/tour-1', pending);
    await tick();
    expect(pending.take).toHaveBeenCalledTimes(1);
    expect(back.backend.presigns()).toHaveLength(1);
    // Same tour: no second tour is created.
    expect(back.backend.state.calls.some((c) => c.url === '/api/admin/tours')).toBe(false);
    expect(FakeXhr.last.body).toBe(file);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readResumeRecord()).toBeNull();
    expect(chipTitle()).toBe('Uploading panorama');
  });

  it('falls back to asking for the file again when the stash is empty', async () => {
    const { backend, pending } = setup();
    backend.state.presignStatus = 401;
    vi.mocked(pending.stash).mockResolvedValue(false);
    await tick();
    await pick();
    pending.take.mockResolvedValue(null);

    cleanup();
    const back = setup('/app/t/tour-1', pending);
    await tick();
    const dialog = screen.getByRole('dialog', { name: 'Add pano' });
    expect(dialog.textContent).toContain(
      'You were signed out before “Town_hall.png” finished uploading. Choose it again to continue.',
    );

    await pick();
    expect(back.backend.presigns()).toHaveLength(1);
    expect(readResumeRecord()).toBeNull();
    expect(chipTitle()).toBe('Uploading panorama');
  });

  it('/app/new?resume=upload starts at once with the file stashed on the landing', async () => {
    const file = pngFile('Harbour.png');
    const { backend, router } = setup('/app/new?resume=upload', fakePending(file));
    await tick();
    expect(backend.state.calls[0]).toMatchObject({
      url: '/api/admin/tours',
      body: { title: 'Harbour' },
    });
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
    expect(FakeXhr.last.body).toBe(file);
    expect(chipTitle()).toBe('Uploading panorama');
  });

  it('/app/new?resume=upload with nothing stashed asks for the photo', async () => {
    const { backend } = setup('/app/new?resume=upload');
    await tick();
    expect(screen.getByRole('dialog', { name: 'New pano' }).textContent).toContain(
      'You’re signed in. Choose your photo again to upload it.',
    );
    expect(backend.state.calls).toEqual([]);
  });

  it('a stashed file still goes through the type and size checks', async () => {
    const gif = new File(['GIF89a'], 'a.gif', { type: 'image/gif' });
    const { backend } = setup('/app/new?resume=upload', fakePending(gif));
    await tick();
    expect(screen.getByRole('alert').textContent).toBe('Use a JPG, PNG or WebP image.');
    expect(backend.state.calls).toEqual([]);
  });

  it('a 401 creating the tour returns to /app/new?resume=upload and starts with the stashed file', async () => {
    const { backend, pending } = setup();
    backend.state.createTourStatus = 401;
    await tick();
    const file = pngFile();
    await pick(file);
    expect(screen.getByRole('alert').textContent).toContain('You’ve been signed out');
    expect(readResumeRecord()).toMatchObject({ target: { kind: 'new-tour' }, landed: null });
    expect(pending.peek()).toBe(file);

    cleanup();
    const back = setup('/app/', pending);
    await tick();
    expect(back.backend.state.calls[0]?.url).toBe('/api/admin/tours');
    expect(back.router.state.location.pathname).toBe('/app/t/tour-1');
    expect(FakeXhr.last.body).toBe(file);
  });

  it('a 401 while polling resumes polling after sign-in, with no file and no re-upload', async () => {
    const { backend } = await uploadThroughPut();
    backend.state.statusStatus = 401;
    await tick(STATUS_POLL_MS);
    expect(chipTitle()).toBe('You’ve been signed out');
    expect(readResumeRecord()).toMatchObject({
      target: { kind: 'add', tourId: 'tour-1' },
      landed: { panoId: 'pano-1', mode: { kind: 'fresh' } },
    });
    fireEvent.click(within(chip()).getByRole('button', { name: 'Sign in' }));
    await tick();
    expect(screen.getByRole('dialog', { name: 'Your session has ended' })).toBeTruthy();

    cleanup();
    const back = setup('/app/t/tour-1');
    back.backend.state.manifests = [manifest('t1-abc')];
    await tick();
    // The image already landed, so there is no file to take back.
    expect(back.pending.take).not.toHaveBeenCalled();
    expect(chipTitle()).toBe('Processing on our side');
    await tick(1_000);
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(back.backend.presigns()).toHaveLength(0);
    expect(back.backend.writes().map((w) => w.url)).toEqual([
      '/api/admin/panos/pano-1/config',
      '/api/admin/tours/tour-1',
    ]);
    expect(readResumeRecord()).toBeNull();
  });
});
