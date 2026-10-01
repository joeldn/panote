import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { FetchLike } from '@internal/web-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';
import type { PanoSummary, TourSummary } from './types.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const noContent = () => new Response(null, { status: 204 });

const tour = (over: Partial<TourSummary> = {}): TourSummary => ({
  tourId: 't1',
  title: 'St Lawrence Jewry',
  sceneCount: 3,
  coverPanoId: 'p1',
  updatedAt: '2026-09-29T12:00:00.000Z',
  etag: 'e1',
  publish: { slug: 'st-lawrence', visibility: 'public' },
  ...over,
});

const pano = (over: Partial<PanoSummary> = {}): PanoSummary => ({
  panoId: 'p1',
  title: 'Nave',
  hasConfig: true,
  hasOriginal: true,
  deleting: false,
  tiling: 'ready',
  manifest: { version: 't1-abc', format: 'webp', tileSize: 512, preview: true },
  updatedAt: '2026-09-29T12:00:00.000Z',
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

const lists = (tours: TourSummary[], panos: PanoSummary[] = [pano()]) => ({
  'GET /api/admin/tours': () => json({ tours, cursor: null }),
  'GET /api/admin/panos': () => json({ panoIds: panos.map((p) => p.panoId), panos, cursor: null }),
  'GET /api/tours/t1/stats': () => json({ views: 4400, likes: 3 }),
  'GET /api/tours/t2/stats': () => json({ views: 12, likes: 0 }),
});

const card = (title: string) => screen.getByRole('link', { name: title }).closest('article')!;

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('Dashboard', () => {
  it('shows an empty state that links to the upload flow', async () => {
    const { fetch } = server(lists([]));
    renderAdmin('/app/', { fetch });
    expect(await screen.findByRole('heading', { name: 'No tours yet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Upload a pano' }).getAttribute('href')).toBe(
      '/app/new',
    );
    expect(screen.getByRole('link', { name: 'New tour' }).getAttribute('href')).toBe('/app/new');
  });

  it('renders cards with totals, views and an editor link', async () => {
    const { fetch } = server(lists([tour(), tour({ tourId: 't2', title: 'Town Hall' })]));
    renderAdmin('/app/', { fetch, strict: true });
    const link = await screen.findByRole('link', { name: 'St Lawrence Jewry' });
    expect(link.getAttribute('href')).toBe('/app/t/t1');
    await waitFor(() => expect(card('St Lawrence Jewry').textContent).toContain('4.4k views'));
    expect(card('St Lawrence Jewry').textContent).toContain('3 panos');
    const totals = document.querySelector('.dash__totals')!;
    await waitFor(() => expect(totals.textContent).toContain('total views4.4k'));
    expect(totals.textContent).toContain('tours2');
    expect(totals.textContent).toContain('panos1');
  });

  it('builds covers from the pano manifest and falls back when one is missing', async () => {
    const { fetch } = server(
      lists(
        [
          tour(),
          tour({ tourId: 't2', title: 'No preview', coverPanoId: 'p2' }),
          tour({ tourId: 't3', title: 'Gone pano', coverPanoId: 'p-gone' }),
          tour({ tourId: 't4', title: 'Empty', coverPanoId: null, sceneCount: 0 }),
        ],
        [pano(), pano({ panoId: 'p2', manifest: { format: 'jpg', tileSize: 512 } })],
      ),
    );
    renderAdmin('/app/', { fetch });
    await screen.findByRole('link', { name: 'Gone pano' });
    const img = (title: string) => card(title).querySelector('img');
    expect(img('St Lawrence Jewry')?.getAttribute('src')).toBe(
      'https://cdn.panote.dev/tiles/p1/t1-abc/preview.webp',
    );
    expect(img('No preview')?.getAttribute('src')).toBe(
      'https://cdn.panote.dev/tiles/p2/0/pz/0-0.jpg',
    );
    expect(within(card('Gone pano')).getByTestId('cover-fallback')).toBeTruthy();
    expect(within(card('Empty')).getByTestId('cover-fallback')).toBeTruthy();

    fireEvent.error(img('St Lawrence Jewry')!);
    expect(within(card('St Lawrence Jewry')).getByTestId('cover-fallback')).toBeTruthy();
  });

  it('still renders tours when the pano list fails', async () => {
    const { fetch } = server({
      ...lists([tour()]),
      'GET /api/admin/panos': () => json({ error: 'boom' }, 500),
    });
    renderAdmin('/app/', { fetch });
    await screen.findByRole('link', { name: 'St Lawrence Jewry' });
    expect(within(card('St Lawrence Jewry')).getByTestId('cover-fallback')).toBeTruthy();
  });

  it('shows a retryable error when the tour list fails', async () => {
    let fail = true;
    const { fetch } = server({
      ...lists([tour()]),
      'GET /api/admin/tours': () =>
        fail ? json({ error: 'boom' }, 500) : json({ tours: [tour()], cursor: null }),
    });
    renderAdmin('/app/', { fetch });
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load your tours');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'St Lawrence Jewry' })).toBeTruthy();
  });

  it('follows the list cursor', async () => {
    const { fetch, calls } = server({
      ...lists([]),
      'GET /api/admin/tours': (url) =>
        url.searchParams.get('cursor') === 'c2'
          ? json({ tours: [tour({ tourId: 't2', title: 'Page two' })], cursor: null })
          : json({ tours: [tour()], cursor: 'c2' }),
    });
    renderAdmin('/app/', { fetch });
    expect(await screen.findByRole('link', { name: 'Page two' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'St Lawrence Jewry' })).toBeTruthy();
    expect(calls('GET /api/admin/tours')).toHaveLength(2);
  });

  describe('tombstoned panos', () => {
    it('re-issues the interrupted DELETE once, even under StrictMode', async () => {
      const { fetch, calls } = server({
        ...lists([tour()], [pano(), pano({ panoId: 'p-dead', deleting: true })]),
        'DELETE /api/admin/panos/p-dead': () => noContent(),
      });
      renderAdmin('/app/', { fetch, strict: true });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      await waitFor(() => expect(calls('DELETE /api/admin/panos/p-dead')).toHaveLength(1));
      await waitFor(() => expect(screen.queryByText(/Finishing an interrupted delete/)).toBeNull());
      expect(screen.queryByRole('button', { name: 'Finish deleting' })).toBeNull();
      // A tombstoned pano doesn't count towards the totals.
      expect(document.querySelector('.dash__totals')!.textContent).toContain('panos1');
    });

    it('does not auto-resume the same tombstone again on a later pano refresh', async () => {
      const { fetch, calls } = server({
        ...lists([tour()], [pano({ panoId: 'p-dead', deleting: true })]),
        'DELETE /api/admin/panos/p-dead': () => noContent(),
        'DELETE /api/admin/tours/t1': () => noContent(),
      });
      renderAdmin('/app/', { fetch });
      await waitFor(() => expect(calls('DELETE /api/admin/panos/p-dead')).toHaveLength(1));
      // Deleting a tour refreshes the pano list, which still reports the tombstone.
      fireEvent.click(screen.getByRole('button', { name: 'Delete “St Lawrence Jewry”' }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete tour' }));
      await waitFor(() => expect(calls('GET /api/admin/panos')).toHaveLength(2));
      expect(calls('DELETE /api/admin/panos/p-dead')).toHaveLength(1);
    });

    it('offers "Finish deleting" when the resumed DELETE fails', async () => {
      let ok = false;
      const { fetch, calls } = server({
        ...lists([tour()], [pano({ panoId: 'p-dead', deleting: true })]),
        'DELETE /api/admin/panos/p-dead': () => (ok ? noContent() : json({ error: 'boom' }, 500)),
      });
      renderAdmin('/app/', { fetch });
      const retry = await screen.findByRole('button', { name: 'Finish deleting' });
      ok = true;
      fireEvent.click(retry);
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Finish deleting' })).toBeNull(),
      );
      expect(calls('DELETE /api/admin/panos/p-dead')).toHaveLength(2);
    });
  });

  describe('visibility chip', () => {
    it('toggles Public to Unlisted through the visibility endpoint', async () => {
      const { fetch, calls } = server({
        ...lists([tour()]),
        'PATCH /api/admin/tours/t1/visibility': () => json({ visibility: 'unlisted' }),
      });
      renderAdmin('/app/', { fetch });
      fireEvent.click(await screen.findByRole('button', { name: /^Public\. Make/ }));
      expect(await screen.findByRole('button', { name: /^Unlisted\. Make/ })).toBeTruthy();
      const [, init] = calls('PATCH /api/admin/tours/t1/visibility')[0]!;
      expect(init?.body).toBe('{"visibility":"unlisted"}');
    });

    it('reverts and explains a failure', async () => {
      const { fetch } = server({
        ...lists([tour()]),
        'PATCH /api/admin/tours/t1/visibility': () => json({ error: 'boom' }, 500),
      });
      renderAdmin('/app/', { fetch });
      fireEvent.click(await screen.findByRole('button', { name: /^Public\. Make/ }));
      expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t change who');
      expect(screen.getByRole('button', { name: /^Public\. Make/ })).toBeTruthy();
    });

    it('drops to Draft on 409 not published', async () => {
      const { fetch } = server({
        ...lists([tour()]),
        'PATCH /api/admin/tours/t1/visibility': () => json({ error: 'not published' }, 409),
      });
      renderAdmin('/app/', { fetch });
      fireEvent.click(await screen.findByRole('button', { name: /^Public\. Make/ }));
      expect((await screen.findByRole('alert')).textContent).toContain('isn’t shared yet');
      expect(card('St Lawrence Jewry').textContent).toContain('Draft');
    });

    it('shows unpublished tours as a non-interactive Draft chip', async () => {
      const { fetch } = server(lists([tour({ publish: null })]));
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      expect(card('St Lawrence Jewry').textContent).toContain('Draft');
      expect(screen.queryByRole('button', { name: /Make/ })).toBeNull();
    });
  });

  it('duplicates into a new unpublished tour without reusing the tourId', async () => {
    let tours = [tour()];
    const { fetch, calls } = server({
      ...lists([]),
      'GET /api/admin/tours': () => json({ tours, cursor: null }),
      'GET /api/admin/tours/t1': () =>
        json({
          tour: { tourId: 't1', title: 'St Lawrence Jewry', scenes: [{ panoId: 'p1' }] },
          etag: 'e1',
          publish: { slug: 'st-lawrence', visibility: 'public', publishedAt: '2026-09-01' },
        }),
      'POST /api/admin/tours': () => {
        tours = [
          tour({ tourId: 't2', title: 'St Lawrence Jewry (copy)', publish: null }),
          ...tours,
        ];
        return json({ tourId: 't2' }, 201);
      },
    });
    renderAdmin('/app/', { fetch });
    fireEvent.click(await screen.findByRole('button', { name: 'Duplicate “St Lawrence Jewry”' }));
    expect(await screen.findByRole('link', { name: 'St Lawrence Jewry (copy)' })).toBeTruthy();
    const body = JSON.parse(String(calls('POST /api/admin/tours')[0]![1]?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ title: 'St Lawrence Jewry (copy)', scenes: [{ panoId: 'p1' }] });
    expect(card('St Lawrence Jewry (copy)').textContent).toContain('Draft');
  });

  describe('delete', () => {
    it('confirms, deletes once despite a double click, and removes the card', async () => {
      let release: () => void = () => {};
      const { fetch, calls } = server({
        ...lists([tour(), tour({ tourId: 't2', title: 'Town Hall' })]),
        'DELETE /api/admin/tours/t1': () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(noContent());
          }),
      });
      renderAdmin('/app/', { fetch });
      fireEvent.click(await screen.findByRole('button', { name: 'Delete “St Lawrence Jewry”' }));
      const dialog = screen.getByRole('dialog', { name: 'Delete this tour?' });
      expect(dialog.textContent).toContain('unless another of your tours uses them');
      expect(dialog.textContent).toContain('Its share link stops working');
      const confirm = within(dialog).getByRole('button', { name: 'Delete tour' });
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      await waitFor(() => expect(calls('DELETE /api/admin/tours/t1')).toHaveLength(1));
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveProperty(
        'disabled',
        true,
      );
      release();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.queryByRole('link', { name: 'St Lawrence Jewry' })).toBeNull();
      expect(screen.getByRole('link', { name: 'Town Hall' })).toBeTruthy();
      expect(calls('DELETE /api/admin/tours/t1')).toHaveLength(1);
    });

    it.each([
      [409, 'being changed somewhere else'],
      [412, 'changed while it was being deleted'],
      [500, 'Couldn’t delete the tour'],
    ])('keeps the dialog open with a message on %i', async (status, message) => {
      const { fetch } = server({
        ...lists([tour()]),
        'DELETE /api/admin/tours/t1': () => json({ error: 'nope' }, status),
      });
      renderAdmin('/app/', { fetch });
      fireEvent.click(await screen.findByRole('button', { name: 'Delete “St Lawrence Jewry”' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete tour' }));
      expect((await within(dialog).findByRole('alert')).textContent).toContain(message);
      expect(screen.getByRole('link', { name: 'St Lawrence Jewry' })).toBeTruthy();
    });

    it('treats a 404 as already deleted', async () => {
      const { fetch } = server({
        ...lists([tour()]),
        'DELETE /api/admin/tours/t1': () => json({ error: 'not found' }, 404),
      });
      renderAdmin('/app/', { fetch });
      fireEvent.click(await screen.findByRole('button', { name: 'Delete “St Lawrence Jewry”' }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete tour' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.queryByRole('link', { name: 'St Lawrence Jewry' })).toBeNull();
    });
  });

  it('marks the last tour opened in the editor as Current', async () => {
    window.localStorage.setItem('panote.currentTour', 't2');
    const { fetch } = server(lists([tour(), tour({ tourId: 't2', title: 'Town Hall' })]));
    renderAdmin('/app/', { fetch });
    await screen.findByRole('link', { name: 'Town Hall' });
    expect(card('Town Hall').textContent).toContain('Current');
    expect(card('St Lawrence Jewry').textContent).not.toContain('Current');
  });
});
