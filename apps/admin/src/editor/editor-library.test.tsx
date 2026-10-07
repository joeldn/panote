import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeAuth, renderAdmin } from '../__fixtures__/auth.js';
import { FakeServer, viewerFactory } from '../__fixtures__/editor-server.js';
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
