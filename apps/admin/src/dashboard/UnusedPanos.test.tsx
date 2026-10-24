import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { FetchLike } from '@internal/web-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';
import type { PanoSummary } from './types.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const noContent = () => new Response(null, { status: 204 });

const pano = (over: Partial<PanoSummary> = {}): PanoSummary => ({
  panoId: 'p1',
  title: 'Old nave',
  hasConfig: true,
  hasOriginal: true,
  deleting: false,
  tiling: 'ready',
  manifest: { version: 't1-abc', format: 'webp', tileSize: 512, preview: true },
  updatedAt: '2026-09-29T12:00:00.000Z',
  referenced: false,
  ...over,
});

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

/** Routes by `METHOD /path`; unmatched requests fail the test loudly. */
function server(routes: Record<string, Handler>) {
  const fetch = vi.fn<FetchLike>(async (input, init = {}) => {
    const url = new URL(String(input), 'https://panote.test');
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    const res = await routes[key]?.(url, init);
    if (!res) throw new Error(`unexpected ${key}`);
    return res;
  });
  const calls = (key: string) =>
    fetch.mock.calls.filter(
      ([input, init]) =>
        `${init?.method ?? 'GET'} ${new URL(String(input), 'https://panote.test').pathname}` ===
        key,
    );
  return { fetch, calls };
}

// The unused panos are a filter on the dashboard, which also lists tours and shared tours.
const listing = (panos: PanoSummary[]) => ({
  'GET /api/admin/tours': () => json({ tours: [], cursor: null }),
  'GET /api/admin/shared-tours': () => json({ tours: [] }),
  'GET /api/admin/panos': (url: URL) => {
    // Without the flag the server sends no `referenced`, and nothing may count as unused.
    const refs = url.searchParams.get('include') === 'references';
    const body = panos.map(({ referenced, ...p }) => (refs ? { ...p, referenced } : p));
    return json({ panoIds: panos.map((p) => p.panoId), panos: body, cursor: null });
  },
});

const row = (title: string) => screen.getByText(title).closest('li')!;
const UNUSED = '/app/?view=unused';

configure({ asyncUtilTimeout: 5000 });
// Pin the clock (Date only, so waitFor keeps real timers): the fixture's
// fixed updatedAt otherwise drifts from "2 days ago" to "last week".
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const openConfirm = async (title: string) => {
  fireEvent.click(await screen.findByRole('button', { name: `Delete “${title}”` }));
  return screen.getByRole('dialog', { name: 'Delete this pano?' });
};

describe('Unused panos', () => {
  it('opens at /panos/unused too, the page it used to be', async () => {
    const { fetch } = server(listing([pano()]));
    const { router } = renderAdmin('/app/panos/unused', { fetch });
    expect(await screen.findByText('Old nave')).toBeTruthy();
    expect(router.state.location.search).toBe('?view=unused');
  });

  it('lists only panos no tour uses, with preview, title and date', async () => {
    const { fetch, calls } = server(
      listing([
        pano(),
        pano({ panoId: 'p-used', title: 'In a tour', referenced: true }),
        pano({ panoId: 'p-dead', title: 'Being deleted', deleting: true }),
        pano({ panoId: 'p-raw', title: null, manifest: null, tiling: 'pending' }),
      ]),
    );
    renderAdmin(UNUSED, { fetch, strict: true });

    await screen.findByText('Old nave');
    expect(screen.getByRole('button', { name: 'Unused panos 2', pressed: true })).toBeTruthy();
    expect(screen.queryByText('In a tour')).toBeNull();
    expect(screen.queryByText('Being deleted')).toBeNull();

    expect(row('Old nave').querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.panote.dev/tiles/p1/t1-abc/preview.webp',
    );
    expect(row('Old nave').textContent).toBe('Old naveUpdated 2 days agoDelete');
    expect(within(row('Untitled pano')).getByTestId('thumb-fallback')).toBeTruthy();
    expect(row('Untitled pano').textContent).toContain('Still processing');

    // The dashboard's own list first, then the one that knows which panos are used.
    const include = calls('GET /api/admin/panos').map((c) =>
      new URL(String(c[0]), 'https://panote.test').searchParams.get('include'),
    );
    expect(include[0]).toBeNull();
    expect(include).toContain('references');
  });

  it('flips a face-tile thumbnail back the right way round, and leaves a preview alone', async () => {
    const face = { version: 't1-abc', format: 'jpg', tileSize: 512 } as const;
    const { fetch } = server(
      listing([pano(), pano({ panoId: 'p-face', title: 'Crypt', manifest: face })]),
    );
    renderAdmin(UNUSED, { fetch, strict: true });
    await screen.findByText('Crypt');
    const img = (title: string) => row(title).querySelector('img');
    expect(img('Crypt')?.getAttribute('src')).toBe(
      'https://cdn.panote.dev/tiles/p-face/t1-abc/0/nz/0-0.jpg',
    );
    expect(img('Crypt')?.style.transform).toBe('scaleX(-1)');
    expect(img('Old nave')?.style.transform).toBe('');
  });

  it('shows an empty state when every pano is in a tour', async () => {
    const { fetch } = server(listing([pano({ referenced: true })]));
    renderAdmin(UNUSED, { fetch });
    expect(await screen.findByText(/^Every pano you’ve uploaded is in a tour\./)).toBeTruthy();
  });

  it('confirms, deletes once despite a double click, and drops the row', async () => {
    const { fetch, calls } = server({
      ...listing([pano(), pano({ panoId: 'p2', title: 'Porch' })]),
      'DELETE /api/admin/panos/p1': () => noContent(),
    });
    renderAdmin(UNUSED, { fetch });
    const dialog = await openConfirm('Old nave');
    expect(dialog.textContent).toContain('“Old nave” isn’t in any of your tours.');
    const confirm = within(dialog).getByRole('button', { name: 'Delete pano' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Old nave')).toBeNull();
    expect(screen.getByText('Porch')).toBeTruthy();
    expect(calls('DELETE /api/admin/panos/p1')).toHaveLength(1);
  });

  it('cancel deletes nothing', async () => {
    const { fetch, calls } = server(listing([pano()]));
    renderAdmin(UNUSED, { fetch });
    const dialog = await openConfirm('Old nave');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Old nave')).toBeTruthy();
    expect(calls('DELETE /api/admin/panos/p1')).toHaveLength(0);
  });

  it('keeps a pano a tour started using, says so, and closes the confirm', async () => {
    const { fetch } = server({
      ...listing([pano()]),
      'DELETE /api/admin/panos/p1': () => json({ error: 'pano is in use' }, 409),
    });
    renderAdmin(UNUSED, { fetch });
    const dialog = await openConfirm('Old nave');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete pano' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('alert').textContent).toContain(
      '“Old nave” is used by a tour now, so it was kept.',
    );
    expect(screen.queryByRole('button', { name: 'Delete “Old nave”' })).toBeNull();
  });

  it.each([
    [409, { error: 'pano was uploaded recently' }, 'uploaded less than an hour ago'],
    [409, { error: 'pano is processing' }, 'still processing'],
    [500, { error: 'boom' }, 'Couldn’t delete the pano'],
  ])('a %i %j keeps the confirm open with a message', async (code, body, message) => {
    const { fetch } = server({
      ...listing([pano()]),
      'DELETE /api/admin/panos/p1': () => json(body, code),
    });
    renderAdmin(UNUSED, { fetch });
    const dialog = await openConfirm('Old nave');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete pano' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(message);
    expect(screen.getByText('Old nave', { selector: '.unused__title' })).toBeTruthy();
  });

  it('treats a 404 as already deleted', async () => {
    const { fetch } = server({
      ...listing([pano()]),
      'DELETE /api/admin/panos/p1': () => json({ error: 'not found' }, 404),
    });
    renderAdmin(UNUSED, { fetch });
    const dialog = await openConfirm('Old nave');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete pano' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Old nave')).toBeNull();
  });

  it('offers a retry when the list fails to load', async () => {
    let fail = true;
    const { fetch } = server({
      ...listing([]),
      'GET /api/admin/panos': () =>
        fail
          ? json({ error: 'boom' }, 500)
          : json({ panoIds: ['p1'], panos: [pano()], cursor: null }),
    });
    renderAdmin(UNUSED, { fetch });
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load your panos.');
    const retry = screen.getByRole('button', { name: 'Try again' });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText('Old nave')).toBeTruthy();
  });
});
