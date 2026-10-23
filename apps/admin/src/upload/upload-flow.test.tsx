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

// Each test drives the whole app from /app/new through presign, PUT and polling: under
// 1 s alone, but CI's Coverage job runs every package's suite at once under V8 coverage,
// and there the file's first test ran past 5 s (PR #138's run on 2046170). A test that
// times out keeps running behind the next ones, so every later test in the file failed
// too, stuck at the sign-in check. Same reasoning as Editor.test.tsx.
vi.setConfig({ testTimeout: 15_000 });

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
  it('New tour on the dashboard opens the file dialog and lands in the editor, asking for a name', async () => {
    const browse = vi.spyOn(HTMLInputElement.prototype, 'click');
    const { backend, router } = setup('/app/');
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'New tour' }));
    const picker = screen.getByTestId('upload-picker');
    expect(browse.mock.contexts).toContain(picker);
    browse.mockRestore();
    fireEvent.change(picker, { target: { files: [pngFile('IMG_2041.JPG')] } });
    await tick();
    expect(backend.state.calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/admin/tours',
      body: { title: 'Untitled tour', scenes: [] },
    });
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
    // The camera's name said nothing: the title is open for typing, all selected.
    await tick();
    const title = screen.getByRole('textbox', { name: 'Tour title' }) as HTMLInputElement;
    expect(title.value).toBe('Untitled tour');
    expect(document.activeElement).toBe(title);
  });

  it('photos dropped on the dashboard start a new tour', async () => {
    const { backend, router } = setup('/app/');
    await tick();
    expect(screen.getByRole('button', { name: 'New tour' })).toBeTruthy();
    const files = [pngFile('Hall.png')];
    const dataTransfer = { types: ['Files'], files };
    fireEvent.dragEnter(window, { dataTransfer });
    expect(screen.getByText('Drop 360° photos to start a new tour')).toBeTruthy();
    fireEvent.drop(window, { dataTransfer });
    await tick();
    expect(screen.queryByText('Drop 360° photos to start a new tour')).toBeNull();
    expect(backend.state.calls[0]).toMatchObject({ method: 'POST', url: '/api/admin/tours' });
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
  });

  it('creates the tour, presigns, PUTs with the pinned type, adds the pano once it lands, then polls', async () => {
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

    expect(backend.presigns()[0]?.body).toEqual({
      contentType: 'image/png',
      size: 4000,
      tourId: 'tour-1',
    });
    expect(backend.presigns()[0]?.headers.authorization).toBe('Bearer jwt-token');
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe(PUT_URL);
    // The signed headers from the presign, condition included.
    expect(xhr.headers).toEqual({ 'content-type': 'image/png', 'if-none-match': '*' });
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
    // The scene joins the tour the moment the image lands, before any tiles exist.
    expect(backend.manifestPolls()).toHaveLength(0);
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    expect(chipTitle()).toBe('Processing on our side');
    expect(within(chip()).getByText('Working…')).toBeTruthy();

    await tick(1_000);
    expect(chipTitle()).toBe('Processing on our side');
    await tick(1_500);
    expect(chipTitle()).toBe('Ready at full resolution');

    // Readiness reads bypass the HTTP cache; once ready, the viewer's copy is refreshed.
    expect(backend.manifestPolls().every((c) => c.cache === 'no-store')).toBe(true);
    expect(backend.manifestRefreshes()).toHaveLength(1);
    expect(backend.writes()).toHaveLength(2);
    const [config, tour] = backend.writes();
    expect(config).toMatchObject({
      url: '/api/admin/panos/pano-1/config?tourId=tour-1',
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

  it('rejects a wrong type, an oversized file, too many pixels and a thin strip before any request', async () => {
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

    // Past 16:1 the tiler refuses it, so the admin does too, instead of promising padding.
    await pick(pngFile('strip.png', 40_000, 2000));
    expect(screen.getByRole('alert').textContent).toBe(
      'This photo is too long and thin to show as a panorama: one side is more than 16 times the other.',
    );

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
    expect(backend.presigns()[1]?.body).toEqual({
      contentType: 'image/png',
      size: 2000,
      tourId: 'tour-1',
    });
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
      tourId: 'tour-1',
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
    // Nothing landed, so nothing joined the tour.
    expect(backend.writes()).toEqual([]);
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
      '/api/admin/panos/pano-1/config?tourId=tour-1',
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

describe('several photos at once', () => {
  const pickMany = async (files: File[]) => {
    fireEvent.change(screen.getByTestId('upload-input'), { target: { files } });
    await tick();
  };
  const three = () => ['Hall.png', 'Kitchen.png', 'Cellar.png'].map((n) => pngFile(n));

  it('a new tour from several photos: one tour, one PUT at a time, scenes in the order picked', async () => {
    const { backend, router } = setup();
    backend.state.newPanoIds = ['pano-a', 'pano-b', 'pano-c'];
    await tick();
    expect(screen.getByTestId('upload-input').hasAttribute('multiple')).toBe(true);
    await pickMany(three());

    // One tour, named after the first photo.
    const creates = backend.state.calls.filter((c) => c.url === '/api/admin/tours');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toEqual({ title: 'Hall', scenes: [] });
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
    expect(backend.presigns()).toHaveLength(1);
    expect(FakeXhr.all).toHaveLength(1);
    expect(chipTitle()).toBe('Uploading panorama');
    expect(within(chip()).getByText('2 more waiting')).toBeTruthy();

    // Each landing starts the next upload; the landed one tiles on, hidden.
    FakeXhr.last.respond(200);
    await tick();
    expect(FakeXhr.all).toHaveLength(2);
    expect(FakeXhr.last.body).toMatchObject({ name: 'Kitchen.png' });
    expect(within(chip()).getByText('1 more waiting')).toBeTruthy();
    FakeXhr.last.respond(200);
    await tick();
    expect(FakeXhr.all).toHaveLength(3);
    expect(within(chip()).queryByText(/more waiting/)).toBeNull();
    FakeXhr.last.respond(200);
    await tick();

    expect(backend.state.tour.scenes).toEqual([
      { panoId: 'pano-a' },
      { panoId: 'pano-b' },
      { panoId: 'pano-c' },
    ]);
    expect(
      backend
        .writes()
        .filter((w) => w.url.endsWith('/config?tourId=tour-1'))
        .map((w) => w.body),
    ).toEqual([{ title: 'Hall' }, { title: 'Kitchen' }, { title: 'Cellar' }]);
    expect(chipTitle()).toBe('Processing on our side');

    // All three finish, hidden or not.
    backend.state.manifests = [manifest('t1-abc')];
    await tick(5_000);
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(backend.manifestRefreshes()).toHaveLength(3);
  });

  it('a waiting photo shows as a card in the editor until its turn', async () => {
    const { backend } = setup();
    backend.state.newPanoIds = ['pano-a', 'pano-b'];
    await tick();
    await pickMany(three().slice(0, 2));
    await tick();
    const card = screen.getByText('Kitchen.png').closest('li')!;
    expect(within(card).getByText('Waiting')).toBeTruthy();
    expect(within(card).queryByRole('progressbar')).toBeNull();
  });

  it('Add pano takes several photos into an existing tour, after a room check for all of them', async () => {
    const { backend } = setup('/app/new?tour=tour-1');
    backend.state.tour.scenes = Array.from({ length: 98 }, (_, i) => ({ panoId: `p${i}` }));
    await tick();
    await pickMany(three());
    expect(screen.getByRole('alert').textContent).toBe(
      'This tour has room for 2 more panos. Choose fewer photos.',
    );
    expect(backend.presigns()).toHaveLength(0);

    backend.state.tour.scenes = [];
    await pickMany(three());
    expect(backend.state.calls.some((c) => c.url === '/api/admin/tours')).toBe(false);
    expect(backend.presigns()).toHaveLength(1);
    expect(within(chip()).getByText('2 more waiting')).toBeTruthy();
  });

  it('the room check counts photos already uploading or waiting for that tour', async () => {
    const { backend, router } = setup('/app/new?tour=tour-1');
    backend.state.tour.scenes = Array.from({ length: 96 }, (_, i) => ({ panoId: `p${i}` }));
    await tick();
    await pickMany(three());
    expect(backend.presigns()).toHaveLength(1);

    // 96 in the tour and 3 on their way: room for 1 more, not 4.
    await act(() => router.navigate('/new?tour=tour-1'));
    await pickMany([pngFile('Attic.png'), pngFile('Roof.png')]);
    expect(screen.getByRole('alert').textContent).toBe(
      'This tour has room for 1 more pano. Choose fewer photos.',
    );
    await pickMany([pngFile('Attic.png')]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(chip()).getByText('3 more waiting')).toBeTruthy();

    await act(() => router.navigate('/new?tour=tour-1'));
    await pickMany([pngFile('Roof.png')]);
    expect(screen.getByRole('alert').textContent).toBe(
      'This tour will be full once the photos already uploading are in.',
    );
    expect(backend.presigns()).toHaveLength(1);
  });

  it('two photos with the same name and problem are both listed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    setup();
    await tick();
    const gif = () => new File(['GIF89a'], 'Loft.gif', { type: 'image/gif' });
    await pickMany([gif(), pngFile('Hall.png'), gif()]);
    expect(within(screen.getByRole('alert')).getAllByRole('listitem')).toHaveLength(2);
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    errors.mockRestore();
  });

  it('one photo failing the checks is left out, and the rest upload', async () => {
    const { backend } = setup();
    await tick();
    const files = three();
    files.splice(1, 0, new File(['GIF89a'], 'Loft.gif', { type: 'image/gif' }));
    await pickMany(files);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The other photos are uploading. This one was left out:');
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Loft.gif: Use a JPG, PNG or WebP image.']);
    expect(backend.presigns()).toHaveLength(1);
    expect(within(chip()).getByText('2 more waiting')).toBeTruthy();
  });

  it('nothing is sent when no photo passes the checks', async () => {
    const { backend } = setup();
    await tick();
    const gif = (name: string) => new File(['GIF89a'], name, { type: 'image/gif' });
    await pickMany([gif('Loft.gif'), gif('Roof.gif')]);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('None of these photos could be uploaded:');
    expect(within(alert).getAllByRole('listitem')).toHaveLength(2);
    expect(backend.state.calls).toEqual([]);
  });

  it('a limit on a later presign stops the rest, once, with how many never started', async () => {
    const { backend } = setup();
    backend.state.newPanoIds = ['pano-a', 'pano-b', 'pano-c'];
    await tick();
    await pickMany([...three(), pngFile('Attic.png')]);
    backend.state.presignStatus = 403;
    backend.state.presignError = 'daily upload limit reached';
    FakeXhr.last.respond(200);
    await tick();

    expect(chipTitle()).toBe('Upload limit reached');
    expect(within(chip()).getByText(/daily upload limit/).textContent).toBe(
      'This account has reached its daily upload limit. Try again later today or tomorrow. 2 more photos weren’t uploaded. Add them again later.',
    );
    expect(within(chip()).queryByRole('button', { name: 'Try again' })).toBeNull();
    // Kitchen asked once; Cellar and Attic never did.
    expect(backend.presigns()).toHaveLength(2);
    expect(FakeXhr.all).toHaveLength(1);
    // The one that landed still joins the tour.
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-a' }]);

    fireEvent.click(within(chip()).getByRole('button', { name: 'Dismiss' }));
    await tick();
    expect(backend.presigns()).toHaveLength(2);
  });

  it('uploads paused for everyone stop the rest, and say to try again tomorrow', async () => {
    const { backend } = setup();
    backend.state.newPanoIds = ['pano-a', 'pano-b'];
    await tick();
    await pickMany(three());
    backend.state.presignStatus = 503;
    backend.state.presignError = 'uploads paused';
    FakeXhr.last.respond(200);
    await tick();

    expect(chipTitle()).toBe('Uploads paused');
    expect(within(chip()).getByText(/paused for today/).textContent).toBe(
      'Uploads are paused for today. Try again tomorrow. 1 more photo wasn’t uploaded. Add it again tomorrow.',
    );
    expect(within(chip()).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(backend.presigns()).toHaveLength(2);
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-a' }]);
  });

  it('a disabled account stops the rest under its own title, not as a limit', async () => {
    const { backend } = setup();
    backend.state.newPanoIds = ['pano-a'];
    await tick();
    await pickMany(three());
    backend.state.presignStatus = 403;
    backend.state.presignError = 'account disabled';
    FakeXhr.last.respond(200);
    await tick();
    expect(chipTitle()).toBe('Uploads are off for this account');
    expect(within(chip()).getByText(/disabled/).textContent).toContain(
      '1 more photo wasn’t uploaded.',
    );
    expect(backend.presigns()).toHaveLength(2);
  });

  it('a failed PUT mid-batch lets the rest go on; its Try again shows once the chip is free', async () => {
    const { backend } = setup();
    backend.state.newPanoIds = ['pano-a', 'pano-c'];
    await tick();
    await pickMany(three());
    FakeXhr.last.respond(200);
    await tick();
    FakeXhr.last.fail();
    await tick();
    // Kitchen failed; Cellar goes anyway, and Kitchen's card says so.
    expect(FakeXhr.all).toHaveLength(3);
    expect(chipTitle()).toBe('Uploading panorama');
    const card = screen.getByText('Kitchen.png').closest('li')!;
    expect(within(card).getByText('Upload failed')).toBeTruthy();

    FakeXhr.last.respond(200);
    await tick();
    backend.state.manifests = [manifest('t1-abc')];
    await tick(5_000);
    expect(chipTitle()).toBe('Ready at full resolution');
    await tick(READY_CHIP_MS);
    expect(chipTitle()).toBe('Upload failed');
    fireEvent.click(within(chip()).getByRole('button', { name: 'Try again' }));
    await tick();
    expect(FakeXhr.last.body).toMatchObject({ name: 'Kitchen.png' });
  });

  it('Cancel the rest drops the waiting photos and keeps the one uploading', async () => {
    const { backend } = setup();
    await tick();
    await pickMany(three());
    fireEvent.click(within(chip()).getByRole('button', { name: 'Cancel the rest' }));
    await tick();
    expect(within(chip()).queryByText(/more waiting/)).toBeNull();
    expect(screen.queryByText('Kitchen.png')).toBeNull();
    FakeXhr.last.respond(200);
    await tick();
    expect(FakeXhr.all).toHaveLength(1);
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
  });

  it('cancelling the first photo of a new tour moves on to the next, and keeps the tour', async () => {
    const { backend, router } = setup();
    backend.state.newPanoIds = ['pano-b'];
    await tick();
    await pickMany(three().slice(0, 2));
    fireEvent.click(within(chip()).getByRole('button', { name: 'Cancel upload' }));
    await tick();
    expect(FakeXhr.all[0]?.aborted).toBe(true);
    expect(FakeXhr.all).toHaveLength(2);
    expect(backend.state.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(router.state.location.pathname).toBe('/app/t/tour-1');
  });
});

describe('editor links into /app/new', () => {
  it('?tour= adds the uploaded pano to that tour and returns to its editor', async () => {
    const { backend, router } = setup('/app/new?tour=tour-1');
    await tick();
    expect(screen.getByRole('dialog', { name: 'Add pano' })).toBeTruthy();
    await pick();
    expect(backend.state.calls.some((c) => c.url === '/api/admin/tours')).toBe(false);
    expect(backend.presigns()[0]?.body).toEqual({
      contentType: 'image/png',
      size: 2000,
      tourId: 'tour-1',
    });
    expect(router.state.location.pathname).toBe('/app/t/tour-1');

    backend.state.manifests = [manifest('t1-abc')];
    FakeXhr.last.respond(200);
    await tick(1_000);
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(backend.writes().map((w) => w.url)).toEqual([
      '/api/admin/panos/pano-1/config?tourId=tour-1',
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
    expect(screen.getByRole('dialog', { name: 'New tour' }).textContent).toContain(
      'You’re signed in. Choose your photo again to upload it.',
    );
    expect(backend.state.calls).toEqual([]);
  });

  it('?resume=upload from the landing beats an own record for another tour, and drops it', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({
        v: 1,
        owner: 'google-oauth2|1',
        fileName: 'Old.png',
        target: { kind: 'add', tourId: 'tour-9' },
        landed: null,
        savedAt: Date.now(),
      }),
    );
    const file = pngFile('Harbour.png');
    const { backend, pending } = setup('/app/new?resume=upload', fakePending(file));
    await tick();
    expect(pending.take).toHaveBeenCalledWith(null);
    // A new tour from the landing's file, not an Add pano into tour-9.
    expect(backend.state.calls[0]).toMatchObject({
      url: '/api/admin/tours',
      body: { title: 'Harbour' },
    });
    expect(FakeXhr.last.body).toBe(file);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readResumeRecord()).toBeNull();
  });

  it('?resume=upload from the landing beats a landed own record, which finishes in the background', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({
        v: 1,
        owner: 'google-oauth2|1',
        fileName: 'Old.png',
        target: { kind: 'add', tourId: 'tour-1' },
        landed: { panoId: 'pano-old', mode: { kind: 'fresh' } },
        savedAt: Date.now(),
      }),
    );
    const file = pngFile('Harbour.png');
    const { backend } = setup('/app/new?resume=upload', fakePending(file));
    await tick();
    // The landing's file starts a new tour rather than being refused as a second upload.
    expect(backend.state.calls.find((c) => c.url === '/api/admin/tours')).toMatchObject({
      body: { title: 'Harbour' },
    });
    expect(FakeXhr.last.body).toBe(file);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    await tick(STATUS_POLL_MS);
    // The older image is still polled, out of sight.
    expect(backend.manifestPolls().some((c) => c.url.includes('pano-old'))).toBe(true);
  });

  const OLD_LANDED = {
    v: 1,
    owner: 'google-oauth2|1',
    fileName: 'Old.png',
    target: { kind: 'add', tourId: 'tour-1' },
    landed: { panoId: 'pano-old', mode: { kind: 'fresh' } },
  };
  const bgRecords = (): Array<{ fileName: string; landed: { panoId: string } }> =>
    JSON.parse(sessionStorage.getItem('panote.upload.resume.bg') ?? '[]') as never;

  it('the landing upload starting keeps the background record of a landed one', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({ ...OLD_LANDED, savedAt: Date.now() }),
    );
    setup('/app/new?resume=upload', fakePending(pngFile('Harbour.png')));
    await tick();
    expect(FakeXhr.last.body).not.toBeNull();
    expect(bgRecords()).toMatchObject([{ fileName: 'Old.png', landed: { panoId: 'pano-old' } }]);
  });

  it('a reload with a foreground and a background record resumes both', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({
        ...OLD_LANDED,
        fileName: 'Town_hall.png',
        landed: { panoId: 'pano-1', mode: { kind: 'fresh' } },
        savedAt: Date.now(),
      }),
    );
    sessionStorage.setItem(
      'panote.upload.resume.bg',
      JSON.stringify([{ ...OLD_LANDED, savedAt: Date.now() }]),
    );
    const { backend } = setup('/app/t/tour-1');
    await tick();
    await tick(STATUS_POLL_MS);
    const polled = backend.manifestPolls().map((c) => c.url);
    expect(polled.some((u) => u.includes('pano-1'))).toBe(true);
    expect(polled.some((u) => u.includes('pano-old'))).toBe(true);
    // One chip, for the foreground one.
    expect(chipTitle()).toBe('Processing on our side');
  });

  it("one upload's sign-in record doesn't overwrite the other's", async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({ ...OLD_LANDED, savedAt: Date.now() }),
    );
    const { backend } = setup('/app/new?resume=upload', fakePending(pngFile('Harbour.png')));
    backend.state.presignStatus = 401;
    backend.state.statusStatus = 401;
    await tick();
    await tick(STATUS_POLL_MS);
    expect(readResumeRecord()).toMatchObject({ fileName: 'Harbour.png', landed: null });
    expect(bgRecords()).toMatchObject([{ fileName: 'Old.png', landed: { panoId: 'pano-old' } }]);
  });

  it('a background upload that fails while the chip is busy is shown once the chip is free', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({ ...OLD_LANDED, savedAt: Date.now() }),
    );
    const { backend } = setup('/app/new?resume=upload', fakePending(pngFile('Harbour.png')));
    backend.state.tiling = 'failed';
    await tick();
    await tick(STATUS_POLL_MS);
    expect(chipTitle()).toBe('Uploading panorama');

    fireEvent.click(within(chip()).getByRole('button', { name: 'Cancel upload' }));
    await tick();
    expect(chipTitle()).toBe('We couldn’t process this image');
  });

  it('a background upload clears its own record once it reaches its tour', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({ ...OLD_LANDED, savedAt: Date.now() }),
    );
    const { backend } = setup('/app/new?resume=upload', fakePending(pngFile('Harbour.png')));
    await tick();
    expect(bgRecords()).toHaveLength(1);
    backend.state.manifests = [manifest('t1-abc', 'pano-old')];
    await tick(5_000);
    expect(backend.writes().map((w) => w.url)).toContain('/api/admin/tours/tour-1');
    expect(bgRecords()).toEqual([]);
  });

  it("hiding the chip doesn't clear the sign-in record of the waiting upload it shows next", async () => {
    const { backend, router } = await uploadThroughPut();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Hide (keeps processing)' }));
    await tick();
    await act(() => router.navigate('/new?tour=tour-1'));
    await pick(pngFile('Second.png'));
    expect(chipTitle()).toBe('Uploading panorama');

    // The hidden upload's status poll needs a sign-in: it waits behind the busy chip.
    backend.state.statusStatus = 401;
    await tick(STATUS_POLL_MS);
    expect(readResumeRecord()).toMatchObject({ fileName: 'Town_hall.png', appended: true });

    fireEvent.click(within(chip()).getByRole('button', { name: 'Cancel upload' }));
    await tick();
    expect(within(chip()).getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(readResumeRecord()).toMatchObject({ fileName: 'Town_hall.png' });
  });

  it('a resumed replace goes back to the tour in its record, not the one in the URL', async () => {
    const { backend, pending } = setup('/app/new?tour=tour-1&replace=pano-9');
    backend.state.manifests = [manifest('t1-old', 'pano-9')];
    backend.state.presignStatus = 401;
    await tick();
    const file = pngFile();
    await pick(file);
    expect(readResumeRecord()).toMatchObject({
      target: { kind: 'replace', panoId: 'pano-9', tourId: 'tour-1' },
    });

    cleanup();
    const back = setup('/app/new?tour=tour-2&replace=pano-9', pending);
    back.backend.state.manifests = [manifest('t1-old', 'pano-9')];
    await tick();
    expect(FakeXhr.last.body).toBe(file);
    expect(back.backend.presigns()[0]?.body).toMatchObject({ panoId: 'pano-9' });
    expect(back.router.state.location.pathname).toBe('/app/t/tour-1');
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
    expect(screen.getByRole('dialog', { name: 'New tour' }).textContent).toContain(
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

  it('a 401 starting several photos keeps the first through sign-in and names the rest', async () => {
    const { backend, pending } = setup();
    backend.state.createTourStatus = 401;
    await tick();
    const files = ['Hall.png', 'Kitchen.png', 'Cellar.png'].map((n) => pngFile(n));
    fireEvent.change(screen.getByTestId('upload-input'), { target: { files } });
    await tick();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('You’ve been signed out');
    expect(alert.textContent).toContain(
      'Only “Hall.png” is kept while you sign in: there’s room for one photo. Add these again after:',
    );
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Kitchen.png', 'Cellar.png']);
    expect(pending.peek()).toBe(files[0]);
    expect(readResumeRecord()).toMatchObject({ fileName: 'Hall.png', landed: null });
  });

  it('a 401 while polling resumes polling after sign-in, with no file and no re-upload', async () => {
    const { backend } = await uploadThroughPut();
    // The scene went into the tour at landing, before the session ran out.
    expect(backend.writes().map((w) => w.url)).toEqual([
      '/api/admin/panos/pano-1/config?tourId=tour-1',
      '/api/admin/tours/tour-1',
    ]);
    backend.state.statusStatus = 401;
    await tick(STATUS_POLL_MS);
    expect(chipTitle()).toBe('You’ve been signed out');
    expect(readResumeRecord()).toMatchObject({
      target: { kind: 'add', tourId: 'tour-1' },
      landed: { panoId: 'pano-1', mode: { kind: 'fresh' } },
      appended: true,
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
    // Already appended: the resume only polls, so a scene removed meanwhile stays removed.
    expect(back.backend.writes()).toEqual([]);
    expect(readResumeRecord()).toBeNull();
  });
});

describe('the scene joins its tour when the image lands', () => {
  const LANDED = {
    v: 1,
    owner: 'google-oauth2|1',
    fileName: 'Town_hall.png',
    target: { kind: 'add', tourId: 'tour-1' },
    landed: { panoId: 'pano-1', mode: { kind: 'fresh' } },
  };
  const tourPuts = (b: ReturnType<typeof fakeBackend>) =>
    b.writes().filter((w) => w.url === '/api/admin/tours/tour-1');

  it('a reload with a landed record appends at once, while it tiles, then reloads at ready', async () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      JSON.stringify({ ...LANDED, savedAt: Date.now() }),
    );
    const { backend } = setup('/app/t/tour-1');
    await tick();
    expect(backend.manifestPolls()).toHaveLength(0);
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    expect(chipTitle()).toBe('Processing on our side');

    backend.state.manifests = [manifest('t1-abc')];
    await tick(1_000);
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(tourPuts(backend)).toHaveLength(1);
    expect(backend.manifestRefreshes()).toHaveLength(1);
    expect(readResumeRecord()).toBeNull();
  });

  it('a background record appends at once too; one already appended only polls', async () => {
    sessionStorage.setItem(
      'panote.upload.resume.bg',
      JSON.stringify([
        { ...LANDED, savedAt: Date.now() },
        {
          ...LANDED,
          fileName: 'Old.png',
          landed: { panoId: 'pano-old', mode: { kind: 'fresh' } },
          appended: true,
          savedAt: Date.now(),
        },
      ]),
    );
    const { backend } = setup('/app/t/tour-1');
    await tick();
    // pano-old was appended before the reload (and may have been removed since).
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    expect(backend.writes().map((w) => w.url)).toEqual([
      '/api/admin/panos/pano-1/config?tourId=tour-1',
      '/api/admin/tours/tour-1',
    ]);
    // pano-1's slot is marked too, so another reload won't append it again.
    const slots = JSON.parse(sessionStorage.getItem('panote.upload.resume.bg') ?? '[]') as Array<{
      landed: { panoId: string };
      appended?: boolean;
    }>;
    expect(slots.map((r) => [r.landed.panoId, r.appended])).toEqual([
      ['pano-old', true],
      ['pano-1', true],
    ]);
    // Hidden: the chip stays free, and both are still polled.
    expect(screen.queryByRole('region', { name: 'Upload status' })).toBeNull();
    await tick(1_000);
    const polled = backend.manifestPolls().map((c) => c.url);
    expect(polled.some((u) => u.includes('pano-1'))).toBe(true);
    expect(polled.some((u) => u.includes('pano-old'))).toBe(true);
  });

  it('a 401 on the tour write at landing asks to sign in, and the resume appends', async () => {
    const { backend } = setup();
    await tick();
    await pick();
    backend.state.getTourStatus = 401;
    FakeXhr.last.respond(200);
    await tick();
    expect(chipTitle()).toBe('You’ve been signed out');
    expect(chip().textContent).toContain('Sign in again to add it to your tour.');
    expect(backend.state.tour.scenes).toEqual([]);
    const rec = readResumeRecord();
    expect(rec).toMatchObject({ landed: { panoId: 'pano-1', mode: { kind: 'fresh' } } });
    expect(rec).not.toHaveProperty('appended');

    cleanup();
    const back = setup('/app/t/tour-1');
    await tick();
    expect(back.backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    expect(back.backend.presigns()).toHaveLength(0);
    expect(chipTitle()).toBe('Processing on our side');
    // A reload from here on only polls: a scene removed meanwhile stays removed.
    expect(readResumeRecord()).toMatchObject({ landed: { panoId: 'pano-1' }, appended: true });
    back.backend.state.manifests = [manifest('t1-abc')];
    await tick(1_000);
    expect(chipTitle()).toBe('Ready at full resolution');
  });

  it('a failed tour write while tiling offers Try again, which appends', async () => {
    const { backend } = setup();
    await tick();
    await pick();
    backend.state.getTourStatus = 500;
    FakeXhr.last.respond(200);
    await tick();
    expect(chipTitle()).toBe('Couldn’t add the pano to your tour');

    backend.state.getTourStatus = 200;
    fireEvent.click(within(chip()).getByRole('button', { name: 'Try again' }));
    await tick();
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    expect(chipTitle()).toBe('Processing on our side');
  });

  it('cancelling after landing leaves the scene, and the re-upload over it appends nothing new', async () => {
    const { backend } = await uploadThroughPut();
    expect(tourPuts(backend)).toHaveLength(1);
    await tick(PROCESSING_TIMEOUT_MS);
    expect(chipTitle()).toBe('Still processing');

    // Re-upload cancels the stuck job and goes over the same pano.
    fireEvent.click(within(chip()).getByRole('button', { name: 'Re-upload' }));
    await tick();
    expect(backend.presigns()[1]?.body).toMatchObject({ panoId: 'pano-1' });
    FakeXhr.last.respond(200);
    await tick();
    // Already in the tour: the idempotent append finds it there and writes no tour.
    expect(tourPuts(backend)).toHaveLength(1);
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    expect(chipTitle()).toBe('Processing on our side');
  });

  it('a failed tiling keeps the scene in the tour', async () => {
    const { backend } = await uploadThroughPut();
    backend.state.tiling = 'failed';
    await tick(STATUS_POLL_MS);
    expect(chipTitle()).toBe('We couldn’t process this image');
    fireEvent.click(within(chip()).getByRole('button', { name: 'Dismiss' }));
    await tick();
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    expect(backend.state.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('dismissing the signed-out chip of a tour write keeps the record, so sign-in still adds it', async () => {
    const { backend } = setup();
    await tick();
    await pick();
    backend.state.getTourStatus = 401;
    FakeXhr.last.respond(200);
    await tick();
    expect(chipTitle()).toBe('You’ve been signed out');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(chip()).getByRole('button', { name: 'Dismiss' }));
    await tick();
    expect(screen.queryByRole('region', { name: 'Upload status' })).toBeNull();
    expect(readResumeRecord()).toMatchObject({ landed: { panoId: 'pano-1' } });

    cleanup();
    const back = setup('/app/t/tour-1');
    await tick();
    expect(back.backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
  });
});
