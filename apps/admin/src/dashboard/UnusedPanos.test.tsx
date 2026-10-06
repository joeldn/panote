import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { FetchLike } from '@internal/web-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const listing = (panos: PanoSummary[]) => ({
  'GET /api/admin/panos': (url: URL) => {
    // Without the flag the server sends no `referenced`, and nothing may count as unused.
    const refs = url.searchParams.get('include') === 'references';
    const body = panos.map(({ referenced, ...p }) => (refs ? { ...p, referenced } : p));
    return json({ panoIds: panos.map((p) => p.panoId), panos: body, cursor: null });
  },
});

const row = (title: string) => screen.getByText(title).closest('li')!;

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const openConfirm = async (title: string) => {
  fireEvent.click(await screen.findByRole('button', { name: `Delete “${title}”` }));
  return screen.getByRole('dialog', { name: 'Delete this pano?' });
};

describe('Unused panos', () => {
  it('lists only panos no tour uses, with preview, title and date', async () => {
    const { fetch, calls } = server(
      listing([
        pano(),
        pano({ panoId: 'p-used', title: 'In a tour', referenced: true }),
        pano({ panoId: 'p-dead', title: 'Being deleted', deleting: true }),
        pano({ panoId: 'p-raw', title: null, manifest: null, tiling: 'pending' }),
      ]),
    );
    renderAdmin('/app/panos/unused', { fetch, strict: true });

    expect(await screen.findByRole('heading', { name: 'Unused panos' })).toBeTruthy();
    await screen.findByText('Old nave');
    expect(screen.queryByText('In a tour')).toBeNull();
    expect(screen.queryByText('Being deleted')).toBeNull();
    expect(screen.getByText('2 unused panos')).toBeTruthy();

    expect(row('Old nave').querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.panote.dev/tiles/p1/t1-abc/preview.webp',
    );
    expect(row('Old nave').textContent).toMatch(/Updated .+ago/);
    expect(within(row('Untitled pano')).getByTestId('thumb-fallback')).toBeTruthy();
    expect(row('Untitled pano').textContent).toContain('Still processing');

    const url = new URL(String(calls('GET /api/admin/panos')[0]![0]), 'https://panote.test');
    expect(url.searchParams.get('include')).toBe('references');
  });

  it('shows an empty state when every pano is in a tour', async () => {
    const { fetch } = server(listing([pano({ referenced: true })]));
    renderAdmin('/app/panos/unused', { fetch });
    expect(await screen.findByText('Every pano you’ve uploaded is in a tour.')).toBeTruthy();
  });

  it('confirms, deletes once despite a double click, and drops the row', async () => {
    const { fetch, calls } = server({
      ...listing([pano(), pano({ panoId: 'p2', title: 'Porch' })]),
      'DELETE /api/admin/panos/p1': () => noContent(),
    });
    renderAdmin('/app/panos/unused', { fetch });
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
    renderAdmin('/app/panos/unused', { fetch });
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
    renderAdmin('/app/panos/unused', { fetch });
    const dialog = await openConfirm('Old nave');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete pano' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status').textContent).toContain(
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
    renderAdmin('/app/panos/unused', { fetch });
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
    renderAdmin('/app/panos/unused', { fetch });
    const dialog = await openConfirm('Old nave');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete pano' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Old nave')).toBeNull();
  });

  it('offers a retry when the list fails to load', async () => {
    let fail = true;
    const { fetch } = server({
      'GET /api/admin/panos': () =>
        fail
          ? json({ error: 'boom' }, 500)
          : json({ panoIds: ['p1'], panos: [pano()], cursor: null }),
    });
    renderAdmin('/app/panos/unused', { fetch });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText('Old nave')).toBeTruthy();
  });
});
