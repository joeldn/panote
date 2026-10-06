import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  type DecodedPreview,
  type FetchLike,
  type PreviewDecoder,
  type PreviewSource,
} from '@internal/web-kit';
import { useEffect } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, LOCAL } from '../__fixtures__/auth.js';
import {
  fakeBackend,
  fakeDecoder,
  FakeXhr,
  manifest,
  pngFile,
  TILES,
} from '../__fixtures__/upload.js';
import { AuthEnvContext } from '../auth-context.js';
import { createSessionApi, createSessionUploadApi, SessionContext } from '../session.js';

import { readResumeRecord } from './resume-store.js';
import { UploadEnvContext, useUploads, type Uploads } from './upload-context.js';
import { STILL_TILING_MESSAGE, UploadProvider } from './UploadProvider.js';

// The provider's preview and pending-upload API, as the editor (P5) will use it.

const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const chip = () => screen.getByRole('region', { name: 'Upload status' });
const chipTitle = () => within(chip()).getByRole('status').textContent;

const probe: { uploads: Uploads | null } = { uploads: null };
function Probe() {
  const uploads = useUploads();
  useEffect(() => {
    probe.uploads = uploads;
  });
  return null;
}
const uploads = () => probe.uploads!;

/**
 * The provider alone. `gate.hold()` parks every manifest read (or whatever `match`
 * picks) until `release()`, so a test can look at the moment a request is out.
 */
function renderProvider(opts: { decoder?: ReturnType<typeof fakeDecoder> } = {}) {
  const backend = fakeBackend();
  const decoder = opts.decoder ?? fakeDecoder();
  let held: Array<() => void> | null = null;
  let match = (url: string, _init?: RequestInit) => url.startsWith(TILES);
  const fetch: FetchLike = (url, init) => {
    if (held && match(url, init)) {
      const list = held;
      return new Promise((resolve) => list.push(() => resolve(backend.fetch(url, init))));
    }
    return backend.fetch(url, init);
  };
  const gate = {
    hold: (pick?: (url: string, init?: RequestInit) => boolean) => {
      match = pick ?? ((url) => url.startsWith(TILES));
      held = [];
    },
    release: () => {
      const list = held ?? [];
      held = null;
      for (const go of list) go();
    },
  };
  const auth = fakeAuth();
  const sessionOpts = { baseUrl: '', fetch };
  const session = {
    user: { sub: 'u' },
    api: createSessionApi(auth, () => {}, sessionOpts),
    upload: createSessionUploadApi(auth, () => {}, sessionOpts),
    requestSignIn: vi.fn(),
    holdSignIn: vi.fn(),
    signOut: vi.fn(async () => {}),
  };
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <SessionContext value={session}>
            <UploadProvider>
              <Probe />
            </UploadProvider>
          </SessionContext>
        ),
      },
    ],
    { initialEntries: ['/t/tour-1'] },
  );
  render(
    <AuthEnvContext value={{ auth, origins: LOCAL, assign: vi.fn(), apiBase: '', fetch }}>
      <UploadEnvContext
        value={{
          tilesBase: TILES,
          createXhr: () => new FakeXhr(),
          decodePreview: decoder.decode,
          maxTextureSize: 8192,
        }}
      >
        <RouterProvider router={router} />
      </UploadEnvContext>
    </AuthEnvContext>,
  );
  return { backend, decoder, gate };
}

async function choose(target: Parameters<Uploads['pick']>[0], file = pngFile()) {
  act(() => uploads().pick(target));
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [file] } });
  await tick();
}
const add = () => choose({ kind: 'add', tourId: 'tour-1' });
const replace = (panoId = 'pano-9') => choose({ kind: 'replace', panoId, tourId: 'tour-1' });

const fromOf = (s: PreviewSource) => (s as PreviewSource & { from: string }).from;
const closeOf = (s: PreviewSource) => s.patches[0]!.image as unknown as { close: () => void };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  FakeXhr.all = [];
  sessionStorage.clear();
  probe.uploads = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('previewFor and pendingFor', () => {
  it('an added pano: a keyed preview from presign on, pending until it is ready', async () => {
    const { backend, decoder } = renderProvider();
    await add();
    expect(decoder.decode).toHaveBeenCalledTimes(1);
    expect(decoder.decode.mock.calls[0]?.[1]).toMatchObject({ maxTextureSize: 8192 });

    const preview = uploads().previewFor('pano-1');
    // A new pano replaces nothing, so there's no replacesVersion.
    expect(preview).toEqual({ panoId: 'pano-1', key: 'upload-1', source: expect.any(Function) });
    expect(uploads().previewFor('pano-2')).toBeNull();
    expect(uploads().pendingFor('tour-1')).toEqual([
      {
        key: 'upload-1',
        target: { kind: 'add', tourId: 'tour-1' },
        fileName: 'Town_hall.png',
        panoId: 'pano-1',
        machine: expect.objectContaining({ phase: 'upload' }),
        finalize: { status: 'idle' },
        hasPreview: true,
      },
    ]);
    expect(uploads().pendingFor('tour-2')).toEqual([]);

    FakeXhr.last.respond(200);
    await tick();
    expect(uploads().pendingFor('tour-1')).toMatchObject([
      { machine: { phase: 'processing' }, finalize: { status: 'done' } },
    ]);
    // Same job, same decode: the same key, so the stage doesn't show it again.
    expect(uploads().previewFor('pano-1')?.key).toBe('upload-1');

    backend.state.manifests = [manifest('t1-abc')];
    await tick(1_000);
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(uploads().previewFor('pano-1')).toBeNull();
    expect(uploads().pendingFor('tour-1')).toEqual([]);
    expect(uploads().reloadKeyFor('pano-1')).toBe('t1-abc');
  });

  it('every show gets a fresh source: the first decode once, then the stash re-decoded', async () => {
    const { decoder } = renderProvider();
    await add();
    const preview = uploads().previewFor('pano-1')!;
    const a = await preview.source();
    const b = await preview.source();
    const c = await uploads().previewFor('pano-1')!.source();
    expect([fromOf(a), fromOf(b), fromOf(c)]).toEqual(['file', 'stash', 'stash']);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(decoder.decode.mock.calls.slice(1).map((call) => call[0])).toEqual([
      decoder.stash,
      decoder.stash,
    ]);
  });

  it('a replace hands out no preview until its baseline is known, then names it', async () => {
    const { backend, gate } = renderProvider();
    backend.state.manifests = [manifest('t1-old', 'pano-9')];
    gate.hold();
    await replace();
    // Decoded, but the baseline read is still out.
    expect(uploads().pendingFor('tour-1')).toMatchObject([{ panoId: 'pano-9', hasPreview: true }]);
    expect(uploads().previewFor('pano-9')).toBeNull();

    gate.release();
    await tick();
    expect(backend.presigns()).toHaveLength(1);
    expect(uploads().previewFor('pano-9')).toMatchObject({
      panoId: 'pano-9',
      key: 'upload-1',
      replacesVersion: 't1-old',
    });
  });

  it('a replace of a pano with no tiles yet replaces no version', async () => {
    renderProvider();
    await replace();
    const preview = uploads().previewFor('pano-9');
    expect(preview).not.toBeNull();
    expect(preview).not.toHaveProperty('replacesVersion');
  });

  it('an unversioned baseline is replaced as version ""', async () => {
    const { backend } = renderProvider();
    backend.state.manifests = [{ ...manifest('x', 'pano-9'), version: undefined } as never];
    await replace();
    expect(uploads().previewFor('pano-9')?.replacesVersion).toBe('');
  });

  it('a failed decode is only a missing preview: the upload goes on to ready', async () => {
    const { backend } = renderProvider({ decoder: fakeDecoder({ fail: true }) });
    await add();
    expect(uploads().previewFor('pano-1')).toBeNull();
    expect(uploads().pendingFor('tour-1')).toMatchObject([{ hasPreview: false }]);
    expect(chipTitle()).toBe('Uploading panorama');

    FakeXhr.last.respond(200);
    await tick();
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    backend.state.manifests = [manifest('t1-abc')];
    await tick(1_000);
    expect(chipTitle()).toBe('Ready at full resolution');
  });

  it('cancelling before landing drops the preview, frees its bitmaps, and appends nothing', async () => {
    const { backend, decoder } = renderProvider();
    await add();
    const first = decoder.sources[0]!;
    fireEvent.click(within(chip()).getByRole('button', { name: 'Cancel upload' }));
    await tick();
    expect(uploads().previewFor('pano-1')).toBeNull();
    expect(uploads().pendingFor('tour-1')).toEqual([]);
    expect(closeOf(first).close).toHaveBeenCalled();
    expect(backend.writes()).toEqual([]);
  });

  it('a failed tiling keeps its preview and stays pending until dismissed', async () => {
    const { backend } = renderProvider();
    await add();
    FakeXhr.last.respond(200);
    await tick();
    backend.state.tiling = 'failed';
    await tick(15_000);
    expect(chipTitle()).toBe('We couldn’t process this image');
    expect(uploads().previewFor('pano-1')?.key).toBe('upload-1');
    expect(uploads().pendingFor('tour-1')).toMatchObject([
      { machine: { phase: 'failed', stage: 'tiling' } },
    ]);

    fireEvent.click(within(chip()).getByRole('button', { name: 'Dismiss' }));
    await tick();
    expect(uploads().previewFor('pano-1')).toBeNull();
    expect(uploads().pendingFor('tour-1')).toEqual([]);
  });

  it('Try again with the same file reuses its decode under the new job key', async () => {
    const { decoder } = renderProvider();
    await add();
    FakeXhr.last.fail();
    await tick();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Try again' }));
    await tick();
    expect(decoder.decode).toHaveBeenCalledTimes(1);
    expect(uploads().previewFor('pano-1')?.key).toBe('upload-2');
    expect(uploads().pendingFor('tour-1')).toHaveLength(1);
  });

  it('only the newest preview keeps its full decode; an older one re-decodes its stash', async () => {
    const { backend, decoder } = renderProvider();
    await add();
    FakeXhr.last.respond(200);
    await tick();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Hide (keeps processing)' }));
    await tick();
    const older = decoder.sources[0]!;

    backend.state.newPanoId = 'pano-2';
    await choose({ kind: 'add', tourId: 'tour-1' }, pngFile('Second.png'));
    expect(closeOf(older).close).toHaveBeenCalled();
    expect(fromOf(await uploads().previewFor('pano-1')!.source())).toBe('stash');
    expect(fromOf(await uploads().previewFor('pano-2')!.source())).toBe('file');
    expect(
      uploads()
        .pendingFor('tour-1')
        .map((p) => p.panoId),
    ).toEqual(['pano-1', 'pano-2']);
  });
});

describe('replace while tiling', () => {
  it('refuses a second replace of a pano still tiling, and allows it once ready', async () => {
    const { backend } = renderProvider();
    backend.state.manifests = [manifest('t1-old', 'pano-9')];
    await replace();
    FakeXhr.last.respond(200);
    await tick();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Hide (keeps processing)' }));
    await tick();

    await expect(
      uploads().begin(pngFile(), { kind: 'replace', panoId: 'pano-9', tourId: 'tour-1' }),
    ).rejects.toThrow(STILL_TILING_MESSAGE);
    expect(backend.presigns()).toHaveLength(1);

    backend.state.manifests = [manifest('t1-new', 'pano-9')];
    await tick(1_000);
    expect(uploads().reloadKeyFor('pano-9')).toBe('t1-new');
    await act(() =>
      uploads().begin(pngFile(), { kind: 'replace', panoId: 'pano-9', tourId: 'tour-1' }),
    );
    expect(backend.presigns()).toHaveLength(2);
  });

  it('refuses replacing an added pano that is still tiling', async () => {
    renderProvider();
    await add();
    FakeXhr.last.respond(200);
    await tick();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Hide (keeps processing)' }));
    await tick();
    await expect(
      uploads().begin(pngFile(), { kind: 'replace', panoId: 'pano-1', tourId: 'tour-1' }),
    ).rejects.toThrow(STILL_TILING_MESSAGE);
  });

  it('a replace never appends a scene, at landing or at ready', async () => {
    const { backend } = renderProvider();
    backend.state.manifests = [manifest('t1-old', 'pano-9')];
    await replace();
    FakeXhr.last.respond(200);
    await tick();
    expect(chipTitle()).toBe('Processing on our side');
    expect(backend.writes()).toEqual([]);
    backend.state.manifests = [manifest('t1-new', 'pano-9')];
    await tick(1_000);
    expect(chipTitle()).toBe('Ready at full resolution');
    expect(backend.writes()).toEqual([]);
    expect(uploads().lastAdded).toBeNull();
  });
});

/** The tour PUT: the append's last write. */
const tourPut = (url: string, init?: RequestInit) =>
  init?.method === 'PUT' && url.endsWith('/api/admin/tours/tour-1');

describe('review follow-ups', () => {
  it('a dismissed upload whose tour write failed is dropped and frees its preview', async () => {
    const { backend, decoder } = renderProvider();
    await add();
    backend.state.getTourStatus = 404;
    FakeXhr.last.respond(200);
    await tick();
    expect(chipTitle()).toBe('Couldn’t add the pano to your tour');
    fireEvent.click(within(chip()).getByRole('button', { name: 'Dismiss' }));
    await tick();

    backend.state.manifests = [manifest('v1')];
    await tick(60_000);
    expect(uploads().pendingFor('tour-1')).toEqual([]);
    expect(uploads().previewFor('pano-1')).toBeNull();
    expect(closeOf(decoder.sources[0]!).close).toHaveBeenCalled();
    // Dropped, so it stopped polling as well.
    const polls = backend.manifestPolls().length;
    await tick(60_000);
    expect(backend.manifestPolls()).toHaveLength(polls);
  });

  it('a record saved by a 401 while the tour write is out is marked appended once it lands', async () => {
    const { backend, gate } = renderProvider();
    await add();
    gate.hold(tourPut);
    FakeXhr.last.respond(200);
    await tick();
    backend.state.statusStatus = 401;
    await tick(15_000);
    expect(readResumeRecord()).toMatchObject({ landed: { panoId: 'pano-1' } });
    expect(readResumeRecord()).not.toHaveProperty('appended');

    gate.release();
    await tick();
    expect(backend.state.tour.scenes).toEqual([{ panoId: 'pano-1' }]);
    expect(readResumeRecord()).toMatchObject({ landed: { panoId: 'pano-1' }, appended: true });
  });

  it('warns before unload while the tour write is out, not after', async () => {
    const { gate } = renderProvider();
    await add();
    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    gate.hold(tourPut);
    FakeXhr.last.respond(200);
    await tick();
    expect(chipTitle()).toBe('Processing on our side');
    expect(unload()).toBe(true);

    gate.release();
    await tick();
    expect(unload()).toBe(false);
  });

  it('a tour write that outlives its job never bumps the reload key', async () => {
    const { backend, gate } = renderProvider();
    await add();
    gate.hold(tourPut);
    FakeXhr.last.respond(200);
    await tick();
    backend.state.manifests = [manifest('t1-first')];
    await tick(1_000);
    // Ready, still waiting on the tour write: hidden, it carries on.
    fireEvent.click(within(chip()).getByRole('button', { name: 'Hide (keeps processing)' }));
    await tick();

    // A replace of that pano starts and takes it over.
    await act(() =>
      uploads().begin(pngFile(), { kind: 'replace', panoId: 'pano-1', tourId: 'tour-1' }),
    );
    gate.release();
    await tick();
    expect(uploads().reloadKeyFor('pano-1')).toBeUndefined();
    expect(uploads().pendingFor('tour-1')).toMatchObject([{ target: { kind: 'replace' } }]);
  });

  it('Try again before the first decode lands still frees the older full decode', async () => {
    const base = fakeDecoder();
    let finish: (() => void) | null = null;
    const decode = vi.fn<PreviewDecoder>(async (blob, options) => {
      // The second upload's decode waits for the test.
      if (base.decode.mock.calls.length === 1) {
        await new Promise<void>((r) => (finish = r));
      }
      return (await base.decode(blob, options)) as DecodedPreview;
    });
    const { backend } = renderProvider({ decoder: { ...base, decode } });
    await add();
    FakeXhr.last.respond(200);
    await tick();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Hide (keeps processing)' }));
    await tick();
    const older = base.sources[0]!;

    backend.state.newPanoId = 'pano-2';
    await choose({ kind: 'add', tourId: 'tour-1' }, pngFile('Second.png'));
    FakeXhr.last.fail();
    await tick();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Try again' }));
    await tick();
    expect(uploads().previewFor('pano-2')).toBeNull();

    act(() => finish!());
    await tick();
    expect(closeOf(older).close).toHaveBeenCalled();
    expect(uploads().previewFor('pano-2')?.key).toBe('upload-3');
  });
});
