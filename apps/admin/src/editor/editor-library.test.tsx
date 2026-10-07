import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MAX_TOUR_SCENES } from '@internal/web-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, renderAdmin } from '../__fixtures__/auth.js';
import { FakeServer, viewerFactory, type Recorded } from '../__fixtures__/editor-server.js';
import {
  fakeBackend,
  fakeDecoder,
  fakePending,
  FakeXhr,
  pngFile,
  TILES,
} from '../__fixtures__/upload.js';
import { StageFactoryContext } from './stage-factory.js';

// "Add pano → from library": an already uploaded, ready pano joins the open tour the
// same way an upload does (config create-only, If-Match append), without a reload.

afterEach(cleanup);

let server: FakeServer;
let create: ReturnType<typeof viewerFactory>['create'];

const summary = (panoId: string, over: Record<string, unknown> = {}) => ({
  panoId,
  title: null,
  hasConfig: false,
  hasOriginal: true,
  deleting: false,
  tiling: 'ready',
  manifest: { version: 't1-abc', format: 'webp', tileSize: 512 },
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  server = new FakeServer();
  server.setTour({
    tourId: 't1',
    title: 'Old town',
    scenes: [{ panoId: 'square' }],
    startPanoId: 'square',
  });
  server.setConfig('square', { title: 'Square', hotspots: [] });
  server.setConfig('bridge', { title: 'Bridge', hotspots: [] });
  server.library = [
    summary('square', { title: 'Square', hasConfig: true }),
    summary('bridge', { title: 'Bridge', hasConfig: true, updatedAt: '2026-09-01T00:00:00.000Z' }),
    summary('loft'),
    summary('cellar', { title: 'Cellar', tiling: 'pending', manifest: null }),
    summary('attic', { title: 'Attic', tiling: 'failed', manifest: null }),
    summary('gone', { title: 'Gone', deleting: true }),
  ];
  ({ create } = viewerFactory());
});

function openEditor() {
  const r = renderAdmin('/app/t/t1', {
    auth: fakeAuth(),
    fetch: server.fetch,
    wrap: (tree) => <StageFactoryContext value={create}>{tree}</StageFactoryContext>,
  });
  return { ...r, ui: within(r.container) };
}

async function openPicker() {
  const app = openEditor();
  fireEvent.click(await app.ui.findByRole('button', { name: 'From library' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add from library' });
  return { ...app, dialog: within(dialog) };
}

const sceneNames = () =>
  Array.from(document.querySelectorAll('.ed-scene__name')).map((n) => n.textContent);

describe('editor: add from library', () => {
  it('lists ready panos only, newest first, with the ones already in the tour marked', async () => {
    const { dialog } = await openPicker();
    const list = await dialog.findByRole('list', { name: 'Your panos' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.ed-lib__title')?.textContent)).toEqual([
      'Untitled pano',
      'Bridge',
      'Square',
    ]);
    expect(within(rows[2]!).getByText('In this tour')).toBeTruthy();
    expect(within(rows[2]!).queryByRole('button')).toBeNull();
    // Processing and failed panos are counted, not listed; one being deleted isn't either.
    expect(dialog.getByText(/2 panos aren’t shown/)).toBeTruthy();
    expect(dialog.queryByText('Cellar')).toBeNull();
    expect(dialog.queryByText('Gone')).toBeNull();
  });

  it('appends the pick to the saved tour and opens it, with nothing left to save', async () => {
    const tourEtag = server.tour!.etag;
    const { dialog, router } = await openPicker();
    fireEvent.click(await dialog.findByRole('button', { name: 'Add “Bridge” to this tour' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.tour?.body.scenes).toEqual([{ panoId: 'square' }, { panoId: 'bridge' }]);
    const put = server.writes().find((w) => w.path === '/api/admin/tours/t1');
    expect(put?.ifMatch).toBe(`"${tourEtag}"`);
    expect(sceneNames()).toEqual(['Square', 'Bridge']);
    expect(router.state.location.search).toBe('?pano=bridge');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('gives an untitled pano a config create-only before it joins', async () => {
    const { dialog } = await openPicker();
    fireEvent.click(
      await dialog.findByRole('button', { name: 'Add “Untitled pano” to this tour' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const config = server.writes().find((w) => w.path === '/api/admin/panos/loft/config');
    expect(config?.ifNoneMatch).toBe('*');
    expect(config?.body).toEqual({ title: 'Untitled pano' });
    expect(sceneNames()).toEqual(['Square', 'Untitled pano']);
  });

  it('waits for unsaved changes to be saved first', async () => {
    const { ui } = openEditor();
    fireEvent.click(await ui.findByRole('button', { name: /Tour title: Old town/ }));
    const input = ui.getByRole('textbox', { name: 'Tour title' });
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const button = await ui.findByRole('button', { name: 'From library' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('Save your changes first');
  });

  it('says when the list couldn’t load, and retries', async () => {
    server.libraryBroken = true;
    const { dialog } = await openPicker();
    expect((await dialog.findByRole('alert')).textContent).toContain('Couldn’t load your panos.');

    server.libraryBroken = false;
    fireEvent.click(dialog.getByRole('button', { name: 'Try again' }));
    expect(await dialog.findByRole('list', { name: 'Your panos' })).toBeTruthy();
  });

  it('has an empty state when nothing else is ready', async () => {
    server.library = [summary('square', { title: 'Square', hasConfig: true })];
    const { dialog } = await openPicker();
    expect(
      await dialog.findByText('Every pano in your library is already in this tour.'),
    ).toBeTruthy();

    cleanup();
    server.library = [];
    const again = await openPicker();
    expect(await again.dialog.findByText(/None of your panos are ready to add yet/)).toBeTruthy();
  });

  it('shows why an add failed and keeps the picker open', async () => {
    // The tour was deleted elsewhere between opening the picker and picking.
    const { dialog } = await openPicker();
    const add = await dialog.findByRole('button', { name: 'Add “Untitled pano” to this tour' });
    server.tour = null;
    fireEvent.click(add);
    expect((await dialog.findByRole('alert')).textContent).toBe('This tour no longer exists.');
    expect(screen.getByRole('dialog', { name: 'Add from library' })).toBeTruthy();
  });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Holds requests matching `match` until the returned release is called. */
function hold(match: (r: Recorded) => boolean) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  server.intercept = async (r) => {
    if (match(r)) await gate;
  };
  return () => release();
}

const isConfigPut = (r: Recorded) => r.method === 'PUT' && r.path.endsWith('/config');

describe('editor: add from library, edge cases', () => {
  it('disables Add and says so when the tour is full', async () => {
    const scenes = Array.from({ length: MAX_TOUR_SCENES }, (_, i) => ({ panoId: `p${i}` }));
    server.setTour({ tourId: 't1', title: 'Old town', scenes, startPanoId: 'p0' });
    const { dialog } = await openPicker();
    const add = await dialog.findByRole('button', { name: 'Add “Bridge” to this tour' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(dialog.getByRole('note').textContent).toBe(
      'This tour already has the maximum number of panos.',
    );
  });

  it('can’t be closed, and takes no second pick, while an add is out', async () => {
    const release = hold(isConfigPut);
    const { dialog } = await openPicker();
    const add = await dialog.findByRole('button', { name: 'Add “Bridge” to this tour' });
    fireEvent.click(add);
    await waitFor(() => expect(server.writes()).toHaveLength(1));

    // A second click on it, or on another pano, sends nothing.
    fireEvent.click(add);
    fireEvent.click(dialog.getByRole('button', { name: 'Add “Untitled pano” to this tour' }));
    expect(
      (
        dialog.getByRole('button', {
          name: 'Add “Untitled pano” to this tour',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    // Neither Escape nor the header × closes it, and the × looks disabled.
    fireEvent.keyDown(document, { key: 'Escape' });
    const close = dialog.getByRole('button', { name: 'Close' }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.click(close);
    expect(screen.getByRole('dialog', { name: 'Add from library' })).toBeTruthy();

    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      server
        .writes()
        .filter(isConfigPut)
        .map((w) => w.path),
    ).toEqual(['/api/admin/panos/bridge/config']);
    expect(server.tour?.body.scenes).toEqual([{ panoId: 'square' }, { panoId: 'bridge' }]);
  });

  it('retries the append on a 412 and keeps the other edit', async () => {
    let raced = false;
    server.intercept = (r) => {
      // Another tab renames the tour just before our PUT lands.
      if (!raced && r.method === 'PUT' && r.path === '/api/admin/tours/t1') {
        raced = true;
        server.setTour({ ...server.tour!.body, title: 'Renamed elsewhere' });
      }
    };
    const { dialog, ui } = await openPicker();
    fireEvent.click(await dialog.findByRole('button', { name: 'Add “Bridge” to this tour' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const puts = server.writes().filter((w) => w.path === '/api/admin/tours/t1');
    expect(puts).toHaveLength(2);
    expect(server.tour?.body.title).toBe('Renamed elsewhere');
    expect(server.tour?.body.scenes).toEqual([{ panoId: 'square' }, { panoId: 'bridge' }]);
    expect(sceneNames()).toEqual(['Square', 'Bridge']);
    expect(ui.getByRole('button', { name: /Tour title: Renamed elsewhere/ })).toBeTruthy();
  });

  it('says so when the add landed but the editor couldn’t refresh', async () => {
    const { dialog, ui, router } = await openPicker();
    let added = false;
    server.intercept = (r) => {
      if (r.method === 'PUT' && r.path === '/api/admin/tours/t1') added = true;
      else if (added && r.path === '/api/admin/tours/t1?include=configs') {
        return json({ error: 'boom' }, 500);
      }
    };
    fireEvent.click(await dialog.findByRole('button', { name: 'Add “Bridge” to this tour' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(server.tour?.body.scenes).toEqual([{ panoId: 'square' }, { panoId: 'bridge' }]);
    expect(router.state.location.search).toBe('?pano=bridge');
    expect(sceneNames()).toEqual(['Square']);
    expect(
      await ui.findByText(/“Bridge” was added to the tour, but the editor couldn’t refresh/),
    ).toBeTruthy();
  });
});

describe('editor: add from library while an upload is on its way', () => {
  const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    FakeXhr.all = [];
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('marks the uploading pano as in this tour, with no Add', async () => {
    const backend = fakeBackend();
    backend.state.library = [
      summary('pano-1', { title: 'Town hall', hasConfig: true }),
      summary('other', { title: 'Other', hasConfig: true }),
    ];
    const factory = viewerFactory();
    const ui = within(
      renderAdmin('/app/new?tour=tour-1', {
        fetch: backend.fetch,
        upload: {
          tilesBase: TILES,
          createXhr: () => new FakeXhr(),
          pending: fakePending(),
          decodePreview: fakeDecoder().decode,
        },
        wrap: (tree) => <StageFactoryContext value={factory.create}>{tree}</StageFactoryContext>,
      }).container,
    );
    await tick();
    fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [pngFile()] } });
    await tick();
    // The image PUT is still out: no scene yet, only the pending card.
    expect(backend.state.tour.scenes).toEqual([]);

    fireEvent.click(ui.getByRole('button', { name: 'From library' }));
    await tick();
    const list = within(screen.getByRole('list', { name: 'Your panos' }));
    const rows = list.getAllByRole('listitem');
    const uploading = rows.find((r) => r.textContent?.includes('Town hall'))!;
    expect(within(uploading).getByText('In this tour')).toBeTruthy();
    expect(within(uploading).queryByRole('button')).toBeNull();
    expect(list.getByRole('button', { name: 'Add “Other” to this tour' })).toBeTruthy();
  });
});
