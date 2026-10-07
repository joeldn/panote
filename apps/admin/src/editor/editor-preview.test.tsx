import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';
import { FakeServer, viewerFactory, type FakeViewer } from '../__fixtures__/editor-server.js';
import {
  fakeBackend,
  fakeDecoder,
  fakePending,
  FakeXhr,
  manifest,
  pngFile,
  TILES,
} from '../__fixtures__/upload.js';
import { StageFactoryContext } from './stage-factory.js';
import {
  WATCH_GIVE_UP_MS,
  WATCH_POLL_MS,
  WATCH_SLOW_POLL_MS,
  WATCH_TIMEOUT_MS,
} from './use-tiling-watch.js';

// The editor while a scene's image is on its way: the pending card before it has a
// scene, the local preview on stage, look-only editing, the processing / failed /
// timed-out states, publishing once the tiles are in, and the editor's own status
// polls after a reload (when no upload in this tab is watching the pano).

const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  FakeXhr.all = [];
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const stageCard = () => document.querySelector<HTMLElement>('.ed-stage-card');
const sceneRow = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name}`) }).closest('li')!;
const addPoint = () => screen.getByRole('button', { name: 'Add point' });
const startHere = () => screen.getByRole('button', { name: /Start here/ });
const northHere = () => screen.getByRole('button', { name: /North is here/ });
const lookOnlyNote = () => screen.queryByText(/Look-only while the image uploads/);

describe('editor: an upload in this tab', () => {
  let viewers: FakeViewer[];

  function setup(path = '/app/new?tour=tour-1') {
    const backend = fakeBackend();
    const factory = viewerFactory();
    const decoder = fakeDecoder();
    viewers = factory.viewers;
    const app = renderAdmin(path, {
      fetch: backend.fetch,
      upload: {
        tilesBase: TILES,
        createXhr: () => new FakeXhr(),
        pending: fakePending(),
        decodePreview: decoder.decode,
      },
      wrap: (tree) => <StageFactoryContext value={factory.create}>{tree}</StageFactoryContext>,
    });
    return { backend, decoder, ...app };
  }

  /** Picks a file in the upload overlay; back in the editor with the PUT going. */
  async function pick() {
    const ctx = setup();
    await tick();
    fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [pngFile()] } });
    await tick();
    await tick();
    expect(ctx.router.state.location.pathname).toBe('/app/t/tour-1');
    return ctx;
  }

  async function land() {
    FakeXhr.last.respond(200);
    await tick();
    await tick();
  }

  async function tilesReady(backend: ReturnType<typeof fakeBackend>) {
    backend.state.manifests = [manifest('t1-abc')];
    await tick(1_000);
    await tick();
  }

  async function saveRenamed(title: string) {
    fireEvent.click(screen.getByRole('button', { name: /^Tour title: / }));
    const input = screen.getByRole('textbox', { name: 'Tour title' });
    fireEvent.change(input, { target: { value: title } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await tick();
    await tick();
  }

  const publishes = (b: ReturnType<typeof fakeBackend>) =>
    b.state.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/publish'));

  it('shows an upload with no scene yet as a pending card, with its preview on stage', async () => {
    const { router, decoder } = await pick();
    FakeXhr.last.progress(43, 100);
    await tick();

    const card = document.querySelector('.ed-scene--pending') as HTMLElement;
    expect(within(card).getByText('Uploading 43%')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Uploading Town_hall.png' });
    expect(bar.getAttribute('aria-valuenow')).toBe('43');
    // On stage at once, as its local preview, look-only.
    expect(router.state.location.search).toBe('?pano=pano-1');
    expect(within(card).getByText('Current')).toBeTruthy();
    const viewer = viewers.at(-1)!;
    expect(viewer.showPreview).toHaveBeenCalledWith('pano-1', decoder.sources[0], {});
    expect(screen.getByText(/Uploading 43%\. Look around while it uploads/)).toBeTruthy();
    expect(lookOnlyNote()).toBeTruthy();
    expect((addPoint() as HTMLButtonElement).disabled).toBe(true);

    // Landed: the card gives way to the scene, which stays on stage without a reload.
    await land();
    expect(document.querySelector('.ed-scene--pending')).toBeNull();
    expect(within(sceneRow('Town hall')).getByText('Processing…')).toBeTruthy();
    expect(viewer.load.mock.calls.map((c) => c[0])).toEqual(['pano-1']);
    expect(viewer.setView).not.toHaveBeenCalled();
  });

  it('keeps a processing scene editable; a point placed on the preview survives the swap', async () => {
    const { backend } = await pick();
    await land();
    expect(screen.getByText(/Processing this pano\. You can keep editing/)).toBeTruthy();
    expect(lookOnlyNote()).toBeNull();
    expect((startHere() as HTMLButtonElement).disabled).toBe(false);
    expect((northHere() as HTMLButtonElement).disabled).toBe(false);
    // A second image can't go over one that is still tiling.
    const replace = within(sceneRow('Town hall')).getByRole('button', {
      name: 'Replace the image of Town hall',
    });
    expect((replace as HTMLButtonElement).disabled).toBe(true);

    // Place a point on the preview and save it while the pano tiles.
    fireEvent.click(addPoint());
    fireEvent.click(document.querySelector('.ed-placing')!);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await tick();
    await tick();
    const configPuts = backend.state.calls.filter(
      (c) => c.method === 'PUT' && c.url.endsWith('/api/admin/panos/pano-1/config'),
    );
    const saved = configPuts.at(-1)?.body as { hotspots: unknown[] };
    expect(saved.hotspots).toEqual([
      { id: expect.any(String), type: 'info', yaw: 0.5, pitch: 0.1, title: 'New point' },
    ]);

    // Ready: the stage reloads onto the tiles, and the point is where it was.
    await tilesReady(backend);
    const viewer = viewers.at(-1)!;
    expect(viewer.load.mock.calls.map((c) => c[0])).toEqual(['pano-1', 'pano-1']);
    expect(screen.queryByText(/Processing this pano/)).toBeNull();
    const list = document.querySelector('.ed-points__list') as HTMLElement;
    expect(within(list).getByRole('button', { name: /New point/ })).toBeTruthy();
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(
      within(sceneRow('Town hall')).getByRole('link', { name: 'Replace the image of Town hall' }),
    ).toBeTruthy();
  });

  it('a scene whose tiling failed offers Replace image and Remove from tour', async () => {
    const { backend } = await pick();
    await land();
    backend.state.tiling = 'failed';
    await tick(15_000);
    await tick();

    const card = stageCard()!;
    expect(
      within(card).getByRole('heading', { name: 'We couldn’t process this image' }),
    ).toBeTruthy();
    expect(within(sceneRow('Town hall')).getByText('Couldn’t process')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Replace image' }).getAttribute('href')).toBe(
      '/app/new?tour=tour-1&replace=pano-1',
    );
    // Nothing to wait for: the scene stays editable while the user decides.
    expect((addPoint() as HTMLButtonElement).disabled).toBe(false);

    // Remove is the editor's own: confirm, then it's an unsaved change to the tour.
    fireEvent.click(within(card).getByRole('button', { name: 'Remove from tour' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove from tour' }),
    );
    await tick();
    expect(screen.queryByRole('button', { name: /^Town hall/ })).toBeNull();
    expect(stageCard()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await tick();
    expect(backend.state.tour.scenes).toEqual([]);
    // Its finished upload doesn't come back as a card, nor put the pano back on stage.
    await tick(60_000);
    expect(document.querySelector('.ed-scene--pending')).toBeNull();
    expect(screen.queryByText(/Town_hall\.png/)).toBeNull();
    expect(screen.queryByRole('application', { name: /Town hall/ })).toBeNull();
  });

  it('a not-ready publish reads calmly, then publishes by itself once the tiles are in', async () => {
    const { backend } = await pick();
    await land();
    backend.state.publishNotReady = ['pano-1'];
    await saveRenamed('Harbour walk');
    expect(publishes(backend)).toHaveLength(1);
    const calm = screen.getByText(/Publishing as soon as “Town hall” finishes processing\./);
    expect(calm.closest('.ed-banner')?.classList.contains('ed-banner--info')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    backend.state.publishNotReady = [];
    await tilesReady(backend);
    await tick();
    expect(publishes(backend)).toHaveLength(2);
    expect(screen.getByText(/share link is up to date/)).toBeTruthy();
    expect(screen.queryByText(/Publishing as soon as/)).toBeNull();
  });

  it('does not publish by itself when a waited-on scene fails, and says so', async () => {
    const { backend } = await pick();
    await land();
    backend.state.publishNotReady = ['pano-1'];
    await saveRenamed('Harbour walk');
    expect(screen.getByText(/Publishing as soon as/)).toBeTruthy();

    backend.state.tiling = 'failed';
    await tick(15_000);
    await tick();
    const notice = screen
      .getByText(/“Town hall” couldn’t be processed, so the share link wasn’t updated/)
      .closest('.ed-banner') as HTMLElement;
    expect(notice.classList.contains('ed-banner--warn')).toBe(true);
    expect(within(notice).getByRole('button', { name: 'Try again' })).toBeTruthy();
    // Even tiles turning up later don't publish without the user.
    backend.state.manifests = [manifest('t1-abc')];
    await tick(60_000);
    expect(publishes(backend)).toHaveLength(1);
  });

  it('says a pending upload failed instead of spinning, and points at the chip', async () => {
    await pick();
    FakeXhr.last.fail();
    await tick();
    const note = screen.getByText(/Upload failed\. Try again or dismiss it from the upload status/);
    expect(note.getAttribute('role')).toBe('alert');
    expect(screen.queryByText(/Look around while it uploads/)).toBeNull();
  });

  it('a replace whose PUT is in flight locks every edit on that scene, until it lands', async () => {
    const ctx = setup('/app/new?tour=tour-1&replace=pano-9');
    ctx.backend.state.tour.scenes = [{ panoId: 'pano-9' }];
    ctx.backend.state.configs['pano-9'] = { title: 'Hall' };
    ctx.backend.state.manifests = [manifest('t1-old', 'pano-9'), manifest('t1-new', 'pano-9')];
    await tick();
    fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [pngFile()] } });
    await tick();
    await tick();
    expect(ctx.router.state.location.pathname).toBe('/app/t/tour-1');
    expect(lookOnlyNote()).toBeTruthy();
    expect(screen.getByText(/Uploading the new image\. Look around while it uploads/)).toBeTruthy();
    expect((addPoint() as HTMLButtonElement).disabled).toBe(true);
    expect((startHere() as HTMLButtonElement).disabled).toBe(true);
    expect((northHere() as HTMLButtonElement).disabled).toBe(true);
    const name = screen.getByRole('button', { name: /^Pano name: Hall/ }) as HTMLButtonElement;
    expect(name.disabled).toBe(true);
    const row = sceneRow('Hall');
    const star = within(row).getByRole('button', { name: 'Start the tour at Hall' });
    expect((star as HTMLButtonElement).disabled).toBe(true);
    expect(
      (within(row).getByRole('button', { name: 'Replace the image of Hall' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Landed: editable while it tiles, but still no second image over it.
    ctx.backend.state.manifests = [manifest('t1-old', 'pano-9')];
    FakeXhr.last.respond(200);
    await tick();
    expect(lookOnlyNote()).toBeNull();
    expect((addPoint() as HTMLButtonElement).disabled).toBe(false);
    expect(
      (screen.getByRole('button', { name: /^Pano name: Hall/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (
        within(sceneRow('Hall')).getByRole('button', {
          name: 'Replace the image of Hall',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe('editor: scenes still tiling after a reload', () => {
  let server: FakeServer;
  let viewers: FakeViewer[];

  beforeEach(() => {
    server = new FakeServer();
    server.setTour({
      tourId: 't1',
      title: 'Old town',
      scenes: [{ panoId: 'square' }, { panoId: 'church' }],
      startPanoId: 'square',
    });
    server.setConfig('square', { title: 'Square', hotspots: [] });
    server.setConfig('church', {
      title: 'Church',
      initialView: { yaw: 1, pitch: 0, fov: 60 },
      hotspots: [{ id: 'i1', type: 'info', yaw: 0.2, pitch: 0.1, title: 'Altar' }],
    });
  });

  /** Opens the editor fresh (no upload job); the viewer 404s a pano until it's ready. */
  async function open(path = '/app/t/t1?pano=church') {
    const factory = viewerFactory();
    viewers = factory.viewers;
    const create: typeof factory.create = (host, options) => {
      const v = factory.create(host, options);
      const fake = factory.viewers.at(-1)!;
      fake.load.mockImplementation(async (pano: string) => {
        if ((server.tiling.get(pano) ?? 'ready') !== 'ready') throw new Error('manifest 404');
        fake.emit('scene-change', pano);
      });
      return v;
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = renderAdmin(path, {
      fetch: server.fetch,
      wrap: (tree) => <StageFactoryContext value={create}>{tree}</StageFactoryContext>,
    });
    await tick();
    await tick();
    return app;
  }

  const statusPolls = (panoId: string) =>
    server.requests.filter((r) => r.path === `/api/admin/panos/${panoId}?status=1`);
  const publishes = () =>
    server.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/publish'));

  it('polls a scene whose tiles 404, keeps it editable, and loads it once ready', async () => {
    server.tiling.set('church', 'pending');
    await open();
    expect(statusPolls('church')).toHaveLength(1);
    expect(screen.getByText(/Processing this pano/)).toBeTruthy();
    expect(screen.queryByText(/tiles aren’t ready yet/)).toBeNull();
    expect(lookOnlyNote()).toBeNull();
    expect((addPoint() as HTMLButtonElement).disabled).toBe(false);
    const list = document.querySelector('.ed-points__list') as HTMLElement;
    expect(
      (within(list).getByRole('button', { name: /Altar/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(within(sceneRow('Church')).getByText('Processing…')).toBeTruthy();
    // The square is fine: it's never polled.
    expect(statusPolls('square')).toHaveLength(0);

    await tick(WATCH_POLL_MS);
    expect(statusPolls('church')).toHaveLength(2);

    server.tiling.set('church', 'ready');
    await tick(WATCH_POLL_MS);
    await tick();
    expect(statusPolls('church')).toHaveLength(3);
    const viewer = viewers.at(-1)!;
    expect(viewer.load.mock.calls.map((c) => c[0])).toEqual(['church', 'church']);
    // The reload keeps the camera: setView only ran for the first load.
    expect(viewer.setView).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Processing this pano/)).toBeNull();
    expect((addPoint() as HTMLButtonElement).disabled).toBe(false);

    // Ready: polling stops.
    await tick(WATCH_GIVE_UP_MS);
    expect(statusPolls('church')).toHaveLength(3);
  });

  it('says so when a status poll needs a sign-in, and stops polling', async () => {
    server.tiling.set('church', 'pending');
    await open();
    expect(statusPolls('church')).toHaveLength(1);
    server.unauthorized = true;
    await tick(WATCH_POLL_MS);
    expect(statusPolls('church')).toHaveLength(2);
    expect(screen.getByText(/Sign in again to see whether this pano has finished/)).toBeTruthy();
    expect(screen.queryByText(/Processing this pano/)).toBeNull();
    expect(within(sceneRow('Church')).queryByText('Processing…')).toBeNull();
    await tick(WATCH_POLL_MS * 3);
    expect(statusPolls('church')).toHaveLength(2);
  });

  it('shows a failed scene with Replace image and Remove, and stops polling', async () => {
    server.tiling.set('church', 'failed');
    await open();
    const card = stageCard()!;
    expect(
      within(card).getByRole('heading', { name: 'We couldn’t process this image' }),
    ).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Replace image' }).getAttribute('href')).toBe(
      '/app/new?tour=t1&replace=church',
    );
    expect(within(card).getByRole('button', { name: 'Remove from tour' })).toBeTruthy();
    await tick(WATCH_POLL_MS * 3);
    expect(statusPolls('church')).toHaveLength(1);
  });

  it('times out after a while, keeps checking slowly, then offers Check again', async () => {
    server.tiling.set('church', 'pending');
    await open();
    await tick(WATCH_TIMEOUT_MS);
    const card = stageCard()!;
    expect(within(card).getByRole('heading', { name: 'Still processing' })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(within(card).getByRole('link', { name: 'Replace image' })).toBeTruthy();
    const slow = statusPolls('church').length;
    await tick(WATCH_SLOW_POLL_MS);
    expect(statusPolls('church')).toHaveLength(slow + 1);

    await tick(WATCH_GIVE_UP_MS);
    const stopped = statusPolls('church').length;
    await tick(WATCH_SLOW_POLL_MS * 4);
    expect(statusPolls('church')).toHaveLength(stopped);
    server.tiling.set('church', 'ready');
    fireEvent.click(within(stageCard()!).getByRole('button', { name: 'Check again' }));
    await tick();
    await tick();
    expect(statusPolls('church')).toHaveLength(stopped + 1);
    expect(stageCard()).toBeNull();
    expect(viewers.at(-1)!.load).toHaveBeenCalledTimes(2);
  });

  it('a not-ready publish polls the panos it waits on and republishes once they are in', async () => {
    server.tiling.set('church', 'pending');
    server.publishScript = () =>
      new Response(
        JSON.stringify({
          error: 'scenes not publishable',
          scenes: [{ panoId: 'church', reason: 'not-ready' }],
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    // On the square: the church's tiles never 404 on stage, the publish is what finds it.
    await open('/app/t/t1');
    fireEvent.click(screen.getByRole('button', { name: /Tour title: Old town/ }));
    const input = screen.getByRole('textbox', { name: 'Tour title' });
    fireEvent.change(input, { target: { value: 'New town' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await tick();
    await tick();
    expect(screen.getByText(/Publishing as soon as “Church” finishes processing\./)).toBeTruthy();
    expect(statusPolls('church')).toHaveLength(1);
    expect(within(sceneRow('Church')).getByText('Processing…')).toBeTruthy();

    server.publishScript = null;
    server.tiling.set('church', 'ready');
    await tick(WATCH_POLL_MS);
    await tick();
    expect(publishes()).toHaveLength(2);
    expect(screen.getByText(/share link is up to date/)).toBeTruthy();
  });

  it('does not republish by itself after a not-ready publish when the pano fails', async () => {
    server.tiling.set('church', 'pending');
    server.publishScript = () =>
      new Response(
        JSON.stringify({
          error: 'scenes not publishable',
          scenes: [{ panoId: 'church', reason: 'not-ready' }],
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    await open('/app/t/t1');
    fireEvent.click(screen.getByRole('button', { name: /Tour title: Old town/ }));
    const input = screen.getByRole('textbox', { name: 'Tour title' });
    fireEvent.change(input, { target: { value: 'New town' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await tick();
    await tick();

    server.tiling.set('church', 'failed');
    await tick(WATCH_POLL_MS);
    await tick();
    expect(screen.getByText(/“Church” couldn’t be processed/)).toBeTruthy();
    expect(publishes()).toHaveLength(1);
    server.publishScript = null;
    server.tiling.set('church', 'ready');
    await tick(WATCH_POLL_MS * 3);
    expect(publishes()).toHaveLength(1);
  });
});
