import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PROCESSING_GIVE_UP_MS, PROCESSING_TIMEOUT_MS } from '@internal/web-kit';
import { useEffect } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth, LOCAL } from '../__fixtures__/auth.js';
import { FakeXhr, fakeBackend, manifest, pngFile, TILES } from '../__fixtures__/upload.js';
import { AuthEnvContext } from '../auth-context.js';
import { createSessionApi, createSessionUploadApi, SessionContext } from '../session.js';

import { UploadEnvContext, useUploads, type Uploads } from './upload-context.js';
import { UploadProvider } from './UploadProvider.js';

const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const chipTitle = () =>
  within(screen.getByRole('region', { name: 'Upload status' })).getByRole('status').textContent;

const probe: { uploads: Uploads | null } = { uploads: null };
function Probe() {
  const uploads = useUploads();
  useEffect(() => {
    probe.uploads = uploads;
  });
  return <p data-testid="reload-key">{uploads.reloadKeyFor('pano-9') ?? 'none'}</p>;
}

/** The provider alone, as the editor would use it: pick({ kind: 'replace' }). */
function renderProvider() {
  const backend = fakeBackend();
  const auth = fakeAuth();
  const opts = { baseUrl: '', fetch: backend.fetch };
  const session = {
    user: { sub: 'u' },
    api: createSessionApi(auth, () => {}, opts),
    upload: createSessionUploadApi(auth, () => {}, opts),
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
    <AuthEnvContext
      value={{ auth, origins: LOCAL, assign: vi.fn(), apiBase: '', fetch: backend.fetch }}
    >
      <UploadEnvContext value={{ tilesBase: TILES, createXhr: () => new FakeXhr() }}>
        <RouterProvider router={router} />
      </UploadEnvContext>
    </AuthEnvContext>,
  );
  return { backend };
}

async function replaceWith(file = pngFile('new.png')) {
  act(() => probe.uploads?.pick({ kind: 'replace', panoId: 'pano-9' }));
  expect(screen.getByRole('dialog', { name: 'Replace image' })).toBeTruthy();
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [file] } });
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  FakeXhr.all = [];
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('replace image', () => {
  it('captures manifest.version before the presign and is ready only once it changes', async () => {
    const { backend } = renderProvider();
    backend.state.manifests = [
      manifest('t1-old', 'pano-9'), // baseline, read before the presign
      manifest('t1-old', 'pano-9'), // the old tiles are still live
      manifest('t1-new', 'pano-9'),
    ];
    await replaceWith();

    const order = backend.state.calls.map((c) => (c.url.startsWith(TILES) ? 'manifest' : c.url));
    expect(order.slice(0, 2)).toEqual(['manifest', '/api/upload-url']);
    expect(backend.presigns()[0]?.body).toEqual({
      contentType: 'image/png',
      size: 2000,
      panoId: 'pano-9',
    });
    expect(FakeXhr.last.headers['content-type']).toBe('image/png');
    expect(screen.queryByRole('dialog')).toBeNull();

    FakeXhr.last.respond(200);
    await tick();
    await tick(1_000);
    expect(chipTitle()).toBe('Processing on our side');
    expect(screen.getByTestId('reload-key').textContent).toBe('none');

    await tick(1_500);
    expect(chipTitle()).toBe('Ready at full resolution');
    // The viewer reloads on the new version, and its plain fetch gets the fresh manifest.
    expect(screen.getByTestId('reload-key').textContent).toBe('t1-new');
    const last = backend.state.calls.at(-1);
    expect(last).toMatchObject({ url: `${TILES}pano-9/manifest.json`, cache: 'reload' });
    // Replacing touches neither the config nor the tour.
    expect(backend.writes()).toEqual([]);
    expect(
      backend
        .manifestPolls()
        .filter((c) => c.cache !== 'reload')
        .every((c) => c.cache === 'no-store'),
    ).toBe(true);
  });

  it('identical bytes (same version) never report ready, time out, and stop at the cap', async () => {
    const { backend } = renderProvider();
    backend.state.manifests = [manifest('t1-same', 'pano-9')];
    // The status route would even say "ready" here; it only ever signals failure.
    backend.state.tiling = 'ready';
    await replaceWith();
    FakeXhr.last.respond(200);
    await tick();

    const seen = new Set<string | null>();
    for (let t = 0; t < PROCESSING_TIMEOUT_MS; t += 30_000) {
      await tick(30_000);
      seen.add(chipTitle());
    }
    expect(seen.has('Ready at full resolution')).toBe(false);
    expect(chipTitle()).toBe('Still processing');
    expect(screen.getByTestId('reload-key').textContent).toBe('none');
    expect(backend.manifestPolls().length).toBeGreaterThan(60);

    // Slow polling carries on to the cap and never flips to ready.
    for (let t = PROCESSING_TIMEOUT_MS; t < PROCESSING_GIVE_UP_MS; t += 60_000) {
      await tick(60_000);
      seen.add(chipTitle());
    }
    expect(seen.has('Ready at full resolution')).toBe(false);
    expect(chipTitle()).toBe('Still processing');
    const polls = backend.manifestPolls().length;
    await tick(5 * 60_000);
    expect(backend.manifestPolls()).toHaveLength(polls);

    // Re-upload from the timed-out chip: a fresh baseline, then a new presign for the same pano.
    fireEvent.click(screen.getByRole('button', { name: 'Re-upload' }));
    await tick();
    expect(backend.presigns()).toHaveLength(2);
    expect(backend.presigns()[1]?.body).toMatchObject({ panoId: 'pano-9' });
  });

  it('only one upload runs at a time', async () => {
    renderProvider();
    await replaceWith();
    await expect(
      probe.uploads!.begin(pngFile(), { kind: 'add', tourId: 'tour-1' }),
    ).rejects.toThrow('already in progress');
    act(() => probe.uploads?.pick({ kind: 'add', tourId: 'tour-1' }));
    expect(screen.getByRole('dialog', { name: 'Add pano' }).textContent).toContain(
      'Another upload is still in progress',
    );
  });
});
