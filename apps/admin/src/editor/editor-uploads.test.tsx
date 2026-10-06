import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';
import { viewerFactory, type FakeViewer } from '../__fixtures__/editor-server.js';
import {
  FakeXhr,
  fakeBackend,
  fakePending,
  manifest,
  pngFile,
  TILES,
} from '../__fixtures__/upload.js';
import { StageFactoryContext } from './stage-factory.js';

// The editor and the upload chip together: an "Add pano" or "Replace image" that
// finishes while the editor is open shows up in it without a reload or a 412.

const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

let viewers: FakeViewer[];

function setup(path: string) {
  const backend = fakeBackend();
  const factory = viewerFactory();
  viewers = factory.viewers;
  const app = renderAdmin(path, {
    fetch: backend.fetch,
    upload: { tilesBase: TILES, createXhr: () => new FakeXhr(), pending: fakePending() },
    wrap: (tree) => <StageFactoryContext value={factory.create}>{tree}</StageFactoryContext>,
  });
  return { backend, ...app };
}

/** From /app/new?tour=tour-1 to a finished PUT, back in the editor (the pano is still tiling). */
async function addPano(path = '/app/new?tour=tour-1') {
  const ctx = setup(path);
  await tick();
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [pngFile()] } });
  await tick();
  expect(ctx.router.state.location.pathname).toBe('/app/t/tour-1');
  FakeXhr.last.respond(200);
  await tick();
  return ctx;
}

async function renameTour(from: string, to: string) {
  fireEvent.click(screen.getByRole('button', { name: `Tour title: ${from}. Click to edit` }));
  const input = screen.getByRole('textbox', { name: 'Tour title' });
  fireEvent.change(input, { target: { value: to } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await tick();
}

const sceneNames = () =>
  Array.from(document.querySelectorAll('.ed-scene__name')).map((n) => n.textContent);
const tourPuts = (b: ReturnType<typeof fakeBackend>) =>
  b.state.calls.filter((c) => c.method === 'PUT' && c.url === '/api/admin/tours/tour-1');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  FakeXhr.all = [];
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('editor and the upload chip', () => {
  it('an added pano appears in the open editor', async () => {
    const { backend } = await addPano();
    expect(sceneNames()).toEqual([]);

    backend.state.manifests = [manifest('t1-abc')];
    await tick(1_000);
    await tick();
    expect(sceneNames()).toEqual(['Town hall']);
    // Nothing local changed, so there is nothing to save.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('keeps local edits and saves them over the new ETag, without a 412', async () => {
    const { backend } = await addPano();
    await renameTour('Town hall', 'Harbour walk');

    backend.state.manifests = [manifest('t1-abc')];
    await tick(1_000);
    await tick();
    // The chip appended the pano under If-Match "t1"; the editor picked up "t2".
    expect(tourPuts(backend)).toHaveLength(1);
    expect(sceneNames()).toEqual(['Town hall']);
    expect(
      screen.getByRole('button', { name: 'Tour title: Harbour walk. Click to edit' }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await tick();
    const save = tourPuts(backend)[1];
    expect(save?.headers['if-match']).toBe('"t2"');
    expect(save?.body).toMatchObject({ title: 'Harbour walk', scenes: [{ panoId: 'pano-1' }] });
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
  });

  it('falls back to the conflict banner when the tour also changed some other way', async () => {
    const { backend } = await addPano();
    await renameTour('Town hall', 'Harbour walk');
    // Another tab renamed it while this one was editing.
    backend.state.tour = { ...backend.state.tour, title: 'Renamed elsewhere' };
    backend.state.tourEtag = 't5';

    backend.state.manifests = [manifest('t1-abc')];
    await tick(1_000);
    await tick();
    expect(screen.getByText(/This tour changed elsewhere/)).toBeTruthy();
    // The new scene is still there to see; the tour doc waits for Reload or Overwrite.
    expect(sceneNames()).toEqual([]);
    expect(
      screen.getByRole('button', { name: 'Tour title: Harbour walk. Click to edit' }),
    ).toBeTruthy();
  });

  it('a replaced image reloads the pano on screen', async () => {
    const ctx = setup('/app/new?tour=tour-1&replace=pano-9');
    ctx.backend.state.tour.scenes = [{ panoId: 'pano-9' }];
    ctx.backend.state.configs['pano-9'] = { title: 'Hall' };
    ctx.backend.state.manifests = [manifest('t1-old', 'pano-9'), manifest('t1-new', 'pano-9')];
    await tick();
    fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [pngFile()] } });
    await tick();
    await tick();
    const viewer = viewers.at(-1)!;
    expect(viewer.load.mock.calls.map((c) => c[0])).toEqual(['pano-9']);

    FakeXhr.last.respond(200);
    await tick();
    await tick(1_000);
    expect(
      within(screen.getByRole('region', { name: 'Upload status' })).getByRole('status').textContent,
    ).toBe('Ready at full resolution');
    expect(viewer.load.mock.calls.map((c) => c[0])).toEqual(['pano-9', 'pano-9']);
  });
});
