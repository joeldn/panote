import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { PROCESSING_TIMEOUT_MS, SLOW_POLL_MS, STATUS_POLL_MS } from '@internal/web-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin } from '../__fixtures__/auth.js';
import { viewerFactory } from '../__fixtures__/editor-server.js';
import { StageFactoryContext } from '../editor/stage-factory.js';
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

function setup(path = '/app/new', pending = fakePending(), auth = fakeAuth()) {
  const backend = fakeBackend();
  const app = renderAdmin(path, {
    auth,
    fetch: backend.fetch,
    upload: { tilesBase: TILES, createXhr: () => new FakeXhr(), pending },
    // The editor under the chip shows the pano once it's added; jsdom has no WebGL.
    wrap: (tree) => (
      <StageFactoryContext value={viewerFactory().create}>{tree}</StageFactoryContext>
    ),
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
      headers: { 'if-none-match': '*' },
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

  it('an existing config (412 on the create-only write) still adds the pano to the tour', async () => {
    const { backend } = await uploadThroughPut();
    backend.state.hasConfig = true;
    backend.state.manifests = [manifest('t1-abc')];
    await tick(1_000);
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
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

  it('times out after 10 minutes but keeps checking; a late manifest lands on its own', async () => {
    const { backend } = await uploadThroughPut();
    await tick(PROCESSING_TIMEOUT_MS);
    expect(chipTitle()).toBe('Still processing');
    expect(chip().textContent).toContain('Taking longer than usual — we’ll keep checking.');
    const polls = backend.manifestPolls().length;
    await tick(SLOW_POLL_MS * 2);
    expect(backend.manifestPolls()).toHaveLength(polls + 2);

    // Minute 14: tiling finishes with no click, and the pano is added to the tour.
    await tick(3 * 60_000);
    backend.state.manifests = [manifest('t1-abc')];
    await tick(SLOW_POLL_MS);
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(backend.presigns()).toHaveLength(1);
  });

  it('times out after 10 minutes; Check again re-polls without re-uploading', async () => {
    const { backend } = await uploadThroughPut();
    await tick(PROCESSING_TIMEOUT_MS);
    expect(chipTitle()).toBe('Still processing');

    backend.state.manifests = [manifest('t1-abc')];
    fireEvent.click(within(chip()).getByRole('button', { name: 'Check again' }));
    await tick();
    expect(chipTitle()).toBe('Processing on our side');
    await tick(1_000);
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(backend.presigns()).toHaveLength(1);
  });

  it('cancelling before anything landed aborts the PUT and deletes the empty new tour', async () => {
    const { backend, router } = setup();
    await tick();
    await pick();
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
    fireEvent.click(within(chip()).getByRole('button', { name: 'Cancel upload' }));
    await tick();
    expect(FakeXhr.last.aborted).toBe(true);
    expect(screen.queryByRole('region', { name: 'Upload status' })).toBeNull();
    expect(backend.manifestPolls()).toHaveLength(0);
    // Re-read first: only a tour that still has no scenes is deleted.
    const tail = backend.state.calls.slice(-2).map((c) => `${c.method} ${c.url}`);
    expect(tail).toEqual(['GET /api/admin/tours/tour-1', 'DELETE /api/admin/tours/tour-1']);
    expect(router.state.location.pathname).toBe('/app');
  });

  it('never deletes a tour that has scenes, or one the upload did not create', async () => {
    const first = setup();
    first.backend.state.tour.scenes = [{ panoId: 'other' }];
    await tick();
    await pick();
    first.backend.state.tour.scenes = [{ panoId: 'other' }];
    fireEvent.click(within(chip()).getByRole('button', { name: 'Cancel upload' }));
    await tick();
    expect(first.backend.state.calls.some((c) => c.method === 'DELETE')).toBe(false);

    cleanup();
    const second = setup('/app/new?tour=tour-1');
    await tick();
    await pick();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Cancel upload' }));
    await tick();
    expect(second.backend.state.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('hiding the chip after the image landed still finishes: the pano reaches the tour', async () => {
    const { backend } = await uploadThroughPut();
    await tick(1_000);
    fireEvent.click(within(chip()).getByRole('button', { name: 'Hide (keeps processing)' }));
    await tick();
    expect(screen.queryByRole('region', { name: 'Upload status' })).toBeNull();

    backend.state.manifests = [manifest('t1-abc')];
    await tick(5_000);
    expect(backend.writes().map((w) => w.url)).toEqual([
      '/api/admin/panos/pano-1/config',
      '/api/admin/tours/tour-1',
    ]);
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    expect(screen.queryByRole('region', { name: 'Upload status' })).toBeNull();
  });

  it('a hidden upload that then fails brings the chip back', async () => {
    const { backend } = await uploadThroughPut();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Hide (keeps processing)' }));
    await tick();
    backend.state.tiling = 'failed';
    await tick(STATUS_POLL_MS);
    expect(chipTitle()).toBe('We couldn’t process this image');
  });

  it("a hidden upload finishing does not wipe another upload's saved sign-in state", async () => {
    const { backend, router, pending } = await uploadThroughPut();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Hide (keeps processing)' }));
    await tick();
    backend.state.presignStatus = 401;
    await act(() => router.navigate('/new?tour=tour-1'));
    await pick(pngFile('Second.png'));
    expect(readResumeRecord()).toMatchObject({ fileName: 'Second.png' });

    backend.state.manifests = [manifest('t1-abc')];
    await tick(5_000);
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    expect(readResumeRecord()).toMatchObject({ fileName: 'Second.png' });
    expect(pending.peek()?.name).toBe('Second.png');
  });

  it('a hidden upload does not block the next one', async () => {
    const { backend, router } = await uploadThroughPut();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Hide (keeps processing)' }));
    await tick();
    await act(() => router.navigate('/new?tour=tour-1'));
    expect(screen.getByRole('dialog', { name: 'Add pano' }).textContent).not.toContain(
      'Another upload',
    );
    await pick(pngFile('Second.png'));
    expect(backend.presigns()).toHaveLength(2);
    expect(chipTitle()).toBe('Uploading panorama');
  });
});

describe('editor links into /app/new', () => {
  it('?tour= adds the uploaded pano to that tour and returns to its editor', async () => {
    const { backend, router } = setup('/app/new?tour=tour-1');
    await tick();
    expect(screen.getByRole('dialog', { name: 'Add pano' })).toBeTruthy();
    await pick();
    expect(backend.state.calls.some((c) => c.url === '/api/admin/tours')).toBe(false);
    expect(backend.presigns()[0]?.body).toEqual({ contentType: 'image/png', size: 2000 });
    expect(router.state.location.pathname).toBe('/app/t/tour-1');

    backend.state.manifests = [manifest('t1-abc')];
    FakeXhr.last.respond(200);
    await tick(1_000);
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(backend.writes().map((w) => w.url)).toEqual([
      '/api/admin/panos/pano-1/config',
      '/api/admin/tours/tour-1',
    ]);
  });

  it('?tour=&replace= replaces that pano with a manifest.version baseline', async () => {
    const { backend, router } = setup('/app/new?tour=tour-1&replace=pano-9');
    backend.state.manifests = [manifest('t1-old', 'pano-9')];
    await tick();
    expect(screen.getByRole('dialog', { name: 'Replace image' })).toBeTruthy();
    await pick();
    const order = backend.state.calls.map((c) => (c.url.startsWith(TILES) ? 'manifest' : c.url));
    expect(order).toEqual(['manifest', '/api/upload-url']);
    expect(backend.presigns()[0]?.body).toMatchObject({ panoId: 'pano-9' });
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
  });

  it('a full tour is refused before anything is uploaded', async () => {
    const { backend } = setup('/app/new?tour=tour-1');
    backend.state.tour.scenes = Array.from({ length: 100 }, (_, i) => ({ panoId: `p${i}` }));
    await tick();
    await pick();
    expect(screen.getByRole('alert').textContent).toBe(
      'This tour already has the maximum number of panos.',
    );
    expect(backend.presigns()).toHaveLength(0);
    expect(FakeXhr.all).toHaveLength(0);
  });

  it('Cancel goes back to the editor', async () => {
    const { router } = setup('/app/new?tour=tour-1');
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await tick();
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
  });
});

describe('re-upload without the file in memory', () => {
  it('a resumed upload that times out re-uploads a re-picked file over the same pano', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({
        v: 1,
        owner: 'google-oauth2|1',
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
    // Starting clears any stash along with the record.
    expect(pending.clear).toHaveBeenCalled();
    expect(chipTitle()).toBe('Uploading panorama');
  });

  it('a 401 checking the tour from /app/new?tour= comes back to a single Add pano dialog', async () => {
    const { backend, pending } = setup('/app/new?tour=tour-1');
    backend.state.getTourStatus = 401;
    await tick();
    const file = pngFile();
    await pick(file);
    expect(readResumeRecord()).toMatchObject({ target: { kind: 'add', tourId: 'tour-1' } });
    expect(pending.peek()).toBe(file);

    cleanup();
    pending.take.mockImplementationOnce(async () => null);
    const back = setup('/app/new?tour=tour-1', pending);
    await tick();
    // The provider's re-pick prompt and the route overlay used to stack here.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Add pano' }).textContent).toContain(
      'Choose it again to continue.',
    );
    expect(pending.take).toHaveBeenCalledTimes(1);

    await pick(file);
    expect(back.backend.presigns()).toHaveLength(1);
    expect(back.router.state.location.pathname).toBe('/app/t/tour-1');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readResumeRecord()).toBeNull();
  });

  it('the same return with the file stashed starts the upload at once', async () => {
    const { backend, pending } = setup('/app/new?tour=tour-1');
    backend.state.getTourStatus = 401;
    await tick();
    const file = pngFile();
    await pick(file);

    cleanup();
    const back = setup('/app/new?tour=tour-1', pending);
    await tick();
    expect(pending.take).toHaveBeenCalledTimes(1);
    expect(FakeXhr.last.body).toBe(file);
    expect(back.router.state.location.pathname).toBe('/app/t/tour-1');
    expect(screen.queryByRole('dialog')).toBeNull();
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

  it('a different user signing in never gets the upload: the record is dropped, the stash refused', async () => {
    const { backend, pending } = setup();
    backend.state.presignStatus = 401;
    await tick();
    await pick();
    expect(readResumeRecord()).toMatchObject({ owner: 'google-oauth2|1' });
    expect(pending.stash).toHaveBeenCalledWith(expect.any(File), 'google-oauth2|1');
    pending.clear.mockClear();

    cleanup();
    const other = fakeAuth({ getUser: vi.fn(async () => ({ sub: 'google-oauth2|2', name: 'B' })) });
    const back = setup('/app/t/tour-1', pending, other);
    await tick();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Upload status' })).toBeNull();
    expect(back.backend.state.calls).toEqual([]);
    expect(FakeXhr.all).toHaveLength(0);
    expect(readResumeRecord()).toBeNull();
    // Their stash is cleared at boot rather than left waiting for them.
    expect(pending.dropForeign).toHaveBeenCalledWith('google-oauth2|2');
    expect(pending.peek()).toBeNull();
    expect(await pending.take('google-oauth2|2')).toBeNull();
  });

  it("another user's stash is cleared at boot even with no resume record; an own one stays", async () => {
    const theirs = fakePending(pngFile('Theirs.png'), 'google-oauth2|2');
    setup('/app/', theirs);
    await tick();
    expect(theirs.dropForeign).toHaveBeenCalledWith('google-oauth2|1');
    expect(theirs.peek()).toBeNull();

    cleanup();
    const mine = fakePending(pngFile('Mine.png'), 'google-oauth2|1');
    setup('/app/', mine);
    await tick();
    expect(mine.peek()?.name).toBe('Mine.png');
    expect(mine.take).not.toHaveBeenCalled();
  });

  it('an owned stash with no resume record never starts by itself from ?resume=upload', async () => {
    const stale = pngFile('Old.png');
    const { backend, pending } = setup(
      '/app/new?resume=upload',
      fakePending(stale, 'google-oauth2|1'),
    );
    await tick();
    // Only an unowned (landing) stash may start without a matching record.
    expect(pending.take).toHaveBeenCalledWith(null);
    expect(screen.getByRole('dialog', { name: 'New pano' }).textContent).toContain(
      'Choose your photo again to upload it.',
    );
    expect(backend.state.calls).toEqual([]);
    expect(FakeXhr.all).toHaveLength(0);
  });

  it('a different user does not resume polling a landed upload either', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({
        v: 1,
        owner: 'google-oauth2|1',
        fileName: 'Town_hall.png',
        target: { kind: 'add', tourId: 'tour-1' },
        landed: { panoId: 'pano-1', mode: { kind: 'fresh' } },
        savedAt: Date.now(),
      }),
    );
    const other = fakeAuth({ getUser: vi.fn(async () => ({ sub: 'google-oauth2|2' })) });
    const { backend } = setup('/app/t/tour-1', fakePending(), other);
    await tick(5_000);
    expect(backend.state.calls).toEqual([]);
    expect(readResumeRecord()).toBeNull();
  });

  it('the sign-in redirect waits until the file is stashed', async () => {
    const { backend, auth, pending } = setup();
    let finish!: (ok: boolean) => void;
    pending.stash.mockImplementation(() => new Promise<boolean>((r) => (finish = r)));
    backend.state.presignStatus = 401;
    await tick();
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await tick();
    expect(auth.signIn).not.toHaveBeenCalled();
    finish(true);
    await tick();
    expect(auth.signIn).toHaveBeenCalledWith({
      connection: 'google-oauth2',
      returnTo: '/app/t/tour-1',
    });
  });

  it('dismissing the signed-out chip drops the record and the stash', async () => {
    const { backend, pending } = setup();
    backend.state.presignStatus = 401;
    await tick();
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(chip()).getByRole('button', { name: 'Dismiss' }));
    await tick();
    expect(readResumeRecord()).toBeNull();
    expect(pending.peek()).toBeNull();
  });

  it('closing the re-pick prompt drops the record and the stash', async () => {
    const { backend, pending } = setup();
    backend.state.presignStatus = 401;
    vi.mocked(pending.stash).mockResolvedValue(false);
    await tick();
    await pick();

    cleanup();
    setup('/app/t/tour-1', pending);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await tick();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readResumeRecord()).toBeNull();
    expect(pending.clear).toHaveBeenCalled();
  });

  it('a resumed upload that times out forgets the record, so a reload does not run it again', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({
        v: 1,
        owner: 'google-oauth2|1',
        fileName: 'Town_hall.png',
        target: { kind: 'add', tourId: 'tour-1' },
        landed: { panoId: 'pano-1', mode: { kind: 'fresh' } },
        savedAt: Date.now(),
      }),
    );
    setup('/app/t/tour-1');
    await tick();
    expect(readResumeRecord()).not.toBeNull();
    await tick(PROCESSING_TIMEOUT_MS);
    expect(chipTitle()).toBe('Still processing');
    expect(readResumeRecord()).toBeNull();
  });

  it('a resumed upload whose tiling fails forgets the record too', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({
        v: 1,
        owner: 'google-oauth2|1',
        fileName: 'Town_hall.png',
        target: { kind: 'add', tourId: 'tour-1' },
        landed: { panoId: 'pano-1', mode: { kind: 'fresh' } },
        savedAt: Date.now(),
      }),
    );
    const { backend } = setup('/app/t/tour-1');
    backend.state.tiling = 'failed';
    await tick();
    await tick(STATUS_POLL_MS);
    expect(chipTitle()).toBe('We couldn’t process this image');
    expect(readResumeRecord()).toBeNull();
  });

  it('a resumed upload whose tour write fails for good forgets the record and offers no retry', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({
        v: 1,
        owner: 'google-oauth2|1',
        fileName: 'Town_hall.png',
        target: { kind: 'add', tourId: 'tour-gone' },
        landed: { panoId: 'pano-1', mode: { kind: 'fresh' } },
        savedAt: Date.now(),
      }),
    );
    const { backend } = setup('/app/t/tour-gone');
    backend.state.manifests = [manifest('t1-abc')];
    await tick();
    await tick(1_000);
    expect(chipTitle()).toBe('Couldn’t add the pano to your tour');
    expect(within(chip()).getByText('This tour no longer exists.')).toBeTruthy();
    expect(within(chip()).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(readResumeRecord()).toBeNull();
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
