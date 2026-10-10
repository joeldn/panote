import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';
import { viewerFactory, type FakeViewer } from '../__fixtures__/editor-server.js';
import {
  fakeDecoder,
  FakeXhr,
  fakeBackend,
  fakePending,
  manifest,
  pngFile,
  TILES,
} from '../__fixtures__/upload.js';
import { StageFactoryContext } from './stage-factory.js';

// The editor and the upload chip together: an "Add pano" whose image lands, or a
// "Replace image" that finishes, while the editor is open shows up in it without a
// reload or a 412.

const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

let viewers: FakeViewer[];

/** `tilesMissing`: every viewer's load rejects (a manifest 404) while it returns true. */
function setup(path: string, tilesMissing?: () => boolean) {
  const backend = fakeBackend();
  const factory = viewerFactory();
  const decoder = fakeDecoder();
  viewers = factory.viewers;
  const create: typeof factory.create = (host, options) => {
    const v = factory.create(host, options);
    const fake = factory.viewers.at(-1)!;
    if (tilesMissing) {
      fake.load.mockImplementation(async (pano: string) => {
        if (tilesMissing()) throw new Error('manifest 404');
        fake.emit('scene-change', pano);
        return true;
      });
    }
    return v;
  };
  const app = renderAdmin(path, {
    fetch: backend.fetch,
    upload: {
      tilesBase: TILES,
      createXhr: () => new FakeXhr(),
      pending: fakePending(),
      decodePreview: decoder.decode,
    },
    wrap: (tree) => <StageFactoryContext value={create}>{tree}</StageFactoryContext>,
  });
  return { backend, decoder, ...app };
}

/** From /app/new?tour=tour-1 to a picked file, back in the editor, with the PUT still going. */
async function pickPano(path = '/app/new?tour=tour-1', tilesMissing?: () => boolean) {
  const ctx = setup(path, tilesMissing);
  await tick();
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [pngFile()] } });
  await tick();
  expect(ctx.router.state.location.pathname).toBe('/app/t/tour-1');
  return ctx;
}

/** The PUT lands: the chip appends the scene and the editor syncs it in. */
async function land() {
  FakeXhr.last.respond(200);
  await tick();
  await tick();
}

const chipTitle = () =>
  within(screen.getByRole('region', { name: 'Upload status' })).getByRole('status').textContent;

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
  vi.restoreAllMocks();
});

describe('editor and the upload chip', () => {
  it('an added pano appears in the open editor as soon as its image lands, before its tiles', async () => {
    const { backend } = await pickPano();
    expect(sceneNames()).toEqual([]);

    await land();
    expect(sceneNames()).toEqual(['Town hall']);
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    expect(chipTitle()).toBe('Processing on our side');
    // Nothing local changed, so there is nothing to save.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    const viewer = viewers.at(-1)!;
    expect(viewer.load.mock.calls.map((c) => c[0])).toEqual(['pano-1']);

    // Ready: the reload key moves, so the stage loads the tiles again.
    backend.state.manifests = [manifest('t1-abc')];
    await tick(1_000);
    await tick();
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(sceneNames()).toEqual(['Town hall']);
    expect(viewer.load.mock.calls.map((c) => c[0])).toEqual(['pano-1', 'pano-1']);
  });

  it('shows the local preview on stage for the landed scene, then loads its tiles', async () => {
    const { decoder } = await pickPano();
    await land();
    const viewer = viewers.at(-1)!;
    // A new pano: there are no old tiles for the preview to stand in for.
    expect(viewer.showPreview).toHaveBeenCalledTimes(1);
    expect(viewer.showPreview).toHaveBeenCalledWith('pano-1', decoder.sources[0], {});
    expect(decoder.sources[0]?.from).toBe('file');
  });

  it('says the scene is processing until its tiles are in, then loads them', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let tiled = false;
    const { backend } = await pickPano('/app/new?tour=tour-1', () => !tiled);
    await land();
    expect(screen.getByText(/Processing this pano/)).toBeTruthy();
    // The upload is watching it: no tile-load error, and no polling of its own.
    expect(screen.queryByText(/tiles aren’t ready yet/)).toBeNull();
    expect(error).not.toHaveBeenCalled();

    tiled = true;
    backend.state.manifests = [manifest('t1-abc')];
    await tick(1_000);
    await tick();
    expect(viewers.at(-1)!.load).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Processing this pano/)).toBeNull();
  });

  it('keeps local edits and saves them over the new ETag, without a 412', async () => {
    const { backend } = await pickPano();
    await renameTour('Town hall', 'Harbour walk');

    await land();
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
    const { backend } = await pickPano();
    await renameTour('Town hall', 'Harbour walk');
    // Another tab renamed it while this one was editing.
    backend.state.tour = { ...backend.state.tour, title: 'Renamed elsewhere' };
    backend.state.tourEtag = 't5';

    await land();
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
    // The new image covers the old tiles at once, named as replacing the baseline version.
    expect(viewer.showPreview).toHaveBeenCalledTimes(1);
    expect(viewer.showPreview).toHaveBeenCalledWith('pano-9', ctx.decoder.sources[0], {
      replacesVersion: 't1-old',
    });
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
