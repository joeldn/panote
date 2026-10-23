import {
  act,
  cleanup,
  configure,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { FetchLike } from '@internal/web-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';
import type { PanoSummary, SharedTourSummary, TourSummary } from './types.js';
import { resetResumedTombstones } from './use-dashboard.js';

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

const shared = (over: Partial<SharedTourSummary> = {}): SharedTourSummary => ({
  ...tour({ tourId: 's1', title: 'Harbour walk', coverPanoId: null }),
  ownerEmail: 'ana@example.com',
  ...over,
});

const lists = (
  tours: TourSummary[],
  panos: PanoSummary[] = [pano({ referenced: true })],
  sharedTours: SharedTourSummary[] = [],
) => ({
  'GET /api/admin/tours': () => json({ tours, cursor: null }),
  'GET /api/admin/panos': () => json({ panoIds: panos.map((p) => p.panoId), panos, cursor: null }),
  'GET /api/admin/shared-tours': () => json({ tours: sharedTours }),
  'GET /api/tours/t1/stats': () => json({ views: 4400, likes: 3 }),
  'GET /api/tours/t2/stats': () => json({ views: 12, likes: 0 }),
  'GET /api/tours/s1/stats': () => json({ views: 7, likes: 0 }),
});

const card = (title: string) => screen.getByRole('link', { name: title }).closest('article')!;
/** The dashboard's own pano loads, not the later one that asks which are unused. */
const mainPanoLoads = (calls: (key: string) => unknown[][]) =>
  calls('GET /api/admin/panos').filter(([input]) => !String(input).includes('include='));
const totals = () => document.querySelector('.dash__totals')?.textContent;

/** Opens a card's "⋯" menu and returns it. */
const openMenu = (title: string) => {
  fireEvent.click(within(card(title)).getByRole('button', { name: `More for “${title}”` }));
  return within(card(title)).getByRole('menu');
};
const pickFromMenu = (title: string, item: string) =>
  fireEvent.click(within(openMenu(title)).getByRole('menuitem', { name: item }));

// The first render in a cold worker can exceed the 1s default under a loaded `turbo test`.
configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  window.localStorage.clear();
  resetResumedTombstones();
});
afterEach(cleanup);

describe('Dashboard', () => {
  describe('filters', () => {
    it('shows none when the owner’s own tours are all there is', async () => {
      const { fetch, calls } = server(lists([tour()]));
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      await waitFor(() => expect(calls('GET /api/admin/shared-tours')).toHaveLength(1));
      expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();
      expect(screen.queryByRole('button', { name: /Your tours/ })).toBeNull();
    });

    it('counts shared tours and unused panos, and hides a list with nothing in it', async () => {
      const { fetch } = server(
        lists(
          [tour()],
          [
            pano({ referenced: true }),
            pano({ panoId: 'p2', title: 'Old porch', referenced: false }),
          ],
          [shared()],
        ),
      );
      renderAdmin('/app/', { fetch });
      // The unused count comes in after the rest.
      await screen.findByRole('button', { name: 'Unused panos 1' });
      const filters = screen.getByRole('group', { name: 'Show' });
      const chips = within(filters).getAllByRole('button');
      expect(chips.map((c) => c.textContent)).toEqual([
        'Your tours 1',
        'Shared with you 1',
        'Unused panos 1',
      ]);
      expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');
      cleanup();

      const second = server(lists([tour()], [pano({ referenced: true })], [shared()]));
      renderAdmin('/app/', { fetch: second.fetch });
      const only = await screen.findByRole('group', { name: 'Show' });
      expect(
        within(only)
          .getAllByRole('button')
          .map((c) => c.textContent),
      ).toEqual(['Your tours 1', 'Shared with you 1']);
    });

    it('shows tours shared with this account as cards, with their owner and no owner actions', async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const { fetch } = server(lists([tour()], undefined, [shared()]));
      const { router } = renderAdmin('/app/', { fetch });
      fireEvent.click(await screen.findByRole('button', { name: 'Shared with you 1' }));
      await waitFor(() => expect(router.state.location.search).toBe('?view=shared'));

      const link = await screen.findByRole('link', { name: 'Harbour walk' });
      expect(link.getAttribute('href')).toBe('/app/t/s1');
      expect(screen.queryByRole('link', { name: 'St Lawrence Jewry' })).toBeNull();
      expect(card('Harbour walk').textContent).toContain('ana@example.com · updated');
      await waitFor(() => expect(card('Harbour walk').textContent).toContain('7 views'));

      fireEvent.click(
        within(card('Harbour walk')).getByRole('button', { name: 'Copy link to “Harbour walk”' }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith('https://panote.dev/s/st-lawrence'),
      );

      const menu = openMenu('Harbour walk');
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((i) => i.textContent),
      ).toEqual(['Open live', 'Insights']);
      // Insights keeps the filter, so closing it comes back here.
      expect(within(menu).getByRole('menuitem', { name: 'Insights' }).getAttribute('href')).toBe(
        '/app/insights/s1?view=shared',
      );
      expect(card('Harbour walk').textContent).not.toContain('Current');
    });

    it('calls a shared tour with no title “Untitled tour”', async () => {
      const { fetch } = server(lists([tour()], undefined, [shared({ title: '' })]));
      renderAdmin('/app/?view=shared', { fetch });
      const link = await screen.findByRole('link', { name: 'Untitled tour' });
      expect(link.getAttribute('href')).toBe('/app/t/s1');
      expect(
        within(card('Untitled tour')).getByRole('button', { name: 'More for “Untitled tour”' }),
      ).toBeTruthy();
    });

    it('still shows the shared tours when the owner’s own list fails', async () => {
      const { fetch } = server({
        ...lists([tour()], undefined, [shared()]),
        'GET /api/admin/tours': () => json({ error: 'boom' }, 500),
      });
      renderAdmin('/app/?view=shared', { fetch });
      expect(await screen.findByRole('link', { name: 'Harbour walk' })).toBeTruthy();
      expect(screen.queryByText('Couldn’t load your tours.')).toBeNull();
      // And the way back to the owner's tours, which says what went wrong.
      fireEvent.click(screen.getByRole('button', { name: 'Your tours' }));
      expect(await screen.findByText('Couldn’t load your tours.')).toBeTruthy();
    });

    it('says when the shared tours didn’t load, and retries', async () => {
      let fail = true;
      const { fetch, calls } = server({
        ...lists([tour()]),
        'GET /api/admin/shared-tours': () =>
          fail ? json({ error: 'boom' }, 500) : json({ tours: [shared()] }),
      });
      renderAdmin('/app/', { fetch });
      const said = await screen.findByText('Couldn’t load the tours shared with you.');
      // The owner's own tours are still there.
      expect(screen.getByRole('link', { name: 'St Lawrence Jewry' })).toBeTruthy();
      fail = false;
      fireEvent.click(within(said.parentElement!).getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('button', { name: 'Shared with you 1' })).toBeTruthy();
      expect(screen.queryByText('Couldn’t load the tours shared with you.')).toBeNull();
      expect(calls('GET /api/admin/shared-tours')).toHaveLength(2);
    });

    it('asks which panos are unused only after the tours show, then adds the chip', async () => {
      let release: () => void = () => {};
      const panos = [
        pano({ referenced: true }),
        pano({ panoId: 'p2', title: 'Old porch', referenced: false }),
      ];
      const body = () => json({ panoIds: ['p1', 'p2'], panos, cursor: null });
      const { fetch, calls } = server({
        ...lists([tour()], panos, [shared()]),
        'GET /api/admin/panos': (url) =>
          url.searchParams.get('include') === 'references'
            ? new Promise<Response>((resolve) => {
                release = () => resolve(body());
              })
            : body(),
      });
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      const include = (i: number) =>
        new URL(
          String(calls('GET /api/admin/panos')[i]![0]),
          'https://panote.test',
        ).searchParams.get('include');
      // The first load doesn't wait on reading every tour.
      expect(include(0)).toBeNull();
      await screen.findByRole('button', { name: 'Shared with you 1' });
      await waitFor(() => expect(calls('GET /api/admin/panos')).toHaveLength(2));
      expect(include(1)).toBe('references');
      expect(screen.queryByRole('button', { name: /Unused panos/ })).toBeNull();

      release();
      fireEvent.click(await screen.findByRole('button', { name: 'Unused panos 1' }));
      expect(await screen.findByText('Old porch')).toBeTruthy();
      expect(screen.queryByText('Nave')).toBeNull();
      expect(screen.queryByRole('link', { name: 'St Lawrence Jewry' })).toBeNull();
      // The view reuses that answer.
      expect(calls('GET /api/admin/panos')).toHaveLength(2);
    });

    it('leaves the unused chip out when that request fails', async () => {
      const panos = [pano({ panoId: 'p2', title: 'Old porch', referenced: false })];
      const { fetch, calls } = server({
        ...lists([tour()], panos, [shared()]),
        'GET /api/admin/panos': (url) =>
          url.searchParams.get('include') === 'references'
            ? json({ error: 'boom' }, 500)
            : json({ panoIds: ['p2'], panos, cursor: null }),
      });
      renderAdmin('/app/', { fetch });
      await screen.findByRole('button', { name: 'Shared with you 1' });
      await waitFor(() => expect(calls('GET /api/admin/panos')).toHaveLength(2));
      await Promise.resolve();
      expect(screen.queryByRole('button', { name: /Unused panos/ })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps the chip in use after its list empties, so there is a way back', async () => {
      const { fetch } = server({
        ...lists(
          [tour()],
          [
            pano({ referenced: true }),
            pano({ panoId: 'p2', title: 'Old porch', referenced: false }),
          ],
        ),
        'DELETE /api/admin/panos/p2': () => noContent(),
      });
      renderAdmin('/app/?view=unused', { fetch });
      fireEvent.click(await screen.findByRole('button', { name: 'Delete “Old porch”' }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete pano' }));
      expect(await screen.findByText('Every pano you’ve uploaded is in a tour.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Unused panos 0' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Your tours 1' }));
      expect(await screen.findByRole('link', { name: 'St Lawrence Jewry' })).toBeTruthy();
      expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();
    });
  });

  it('shows an empty state that starts the upload flow', async () => {
    const { fetch } = server(lists([]));
    renderAdmin('/app/', { fetch });
    expect(await screen.findByRole('heading', { name: 'No tours yet' })).toBeTruthy();
    // Someone with no tours is new here: no "Welcome back".
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Welcome to panote, Maya Larsson.',
    );
    // Both open the system's file dialog straight away, for a new tour.
    const browse = vi.spyOn(HTMLInputElement.prototype, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Upload a pano' }));
    fireEvent.click(screen.getByRole('button', { name: 'New tour' }));
    const picker = screen.getByTestId('upload-picker') as HTMLInputElement;
    expect(browse.mock.contexts).toEqual([picker, picker]);
    expect(picker.multiple).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    browse.mockRestore();
  });

  it('renders cards with a one-line total, views and an editor link', async () => {
    const { fetch } = server(lists([tour(), tour({ tourId: 't2', title: 'Town Hall' })]));
    renderAdmin('/app/', { fetch, strict: true });
    const link = await screen.findByRole('link', { name: 'St Lawrence Jewry' });
    expect(link.getAttribute('href')).toBe('/app/t/t1');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Welcome back, Maya Larsson.',
    );
    await waitFor(() => expect(card('St Lawrence Jewry').textContent).toContain('4.4k views'));
    expect(card('St Lawrence Jewry').textContent).toContain('3 panos');
    // Every card is a 360° tour; saying so on each told no one anything.
    expect(card('St Lawrence Jewry').textContent).not.toContain('360°');
    await waitFor(() => expect(totals()).toBe('2 tours · 1 pano · 4.4k views'));
  });

  describe('limits in the totals line', () => {
    const usage = (maxPanos: number | null) => ({
      panos: 1,
      bytes: 1024,
      uploadsToday: 0,
      limits: { maxPanos, maxBytes: null, maxUploadsPerDay: null },
    });

    it('adds them once the usage call answers, after the first paint', async () => {
      let release: () => void = () => {};
      const { fetch, calls } = server({
        ...lists([tour()]),
        'GET /api/upload-url': () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(json(usage(500)));
          }),
      });
      renderAdmin('/app/', { fetch });
      await waitFor(() => expect(totals()).toBe('1 tour · 1 pano · 4.4k views'));
      expect(calls('GET /api/upload-url')).toHaveLength(1);
      release();
      await waitFor(() => expect(totals()).toBe('1 / 200 tours · 1 / 500 panos · 4.4k views'));
      expect(totals()).not.toMatch(/unlimited/i);
    });

    it('leaves out a limit that isn’t set', async () => {
      const { fetch } = server({
        ...lists([tour()]),
        'GET /api/upload-url': () => json(usage(null)),
      });
      renderAdmin('/app/', { fetch });
      await waitFor(() => expect(totals()).toBe('1 / 200 tours · 1 pano · 4.4k views'));
    });

    it('keeps the plain counts when the usage call fails', async () => {
      const { fetch, calls } = server({
        ...lists([tour()]),
        'GET /api/upload-url': () => json({ error: 'boom' }, 500),
      });
      renderAdmin('/app/', { fetch });
      await waitFor(() => expect(calls('GET /api/upload-url')).toHaveLength(1));
      await waitFor(() => expect(totals()).toBe('1 tour · 1 pano · 4.4k views'));
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('leaves the totals out until there is something to count', async () => {
    const { fetch } = server(lists([], []));
    renderAdmin('/app/', { fetch });
    await screen.findByRole('heading', { name: 'No tours yet' });
    expect(totals()).toBeUndefined();
  });

  describe('card actions', () => {
    it('keeps Copy link on the card and the rest in its menu', async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const { fetch } = server(lists([tour()]));
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      const actions = within(card('St Lawrence Jewry'));
      // One visible action besides the menu: no row of icon buttons.
      expect(actions.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
        'Copy link to “St Lawrence Jewry”',
        'More for “St Lawrence Jewry”',
      ]);

      const copyButton = actions.getByRole('button', { name: 'Copy link to “St Lawrence Jewry”' });
      expect(copyButton.textContent).toBe('Copy link');
      fireEvent.click(copyButton);
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith('https://panote.dev/s/st-lawrence'),
      );
      const said = await actions.findByText('Copied ✓');
      // Its own live region, not text inside the labelled button.
      expect(said.getAttribute('role')).toBe('status');
      expect(said.closest('button')).toBeNull();
      expect(copyButton.textContent).toBe('Copied');

      const menu = openMenu('St Lawrence Jewry');
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((i) => i.textContent),
      ).toEqual(['Open live', 'Insights', 'Make unlisted', 'Duplicate', 'Delete']);
      const live = within(menu).getByRole('menuitem', { name: 'Open live' });
      expect(live.getAttribute('href')).toBe('https://panote.dev/s/st-lawrence');
      expect(live.getAttribute('target')).toBe('_blank');
      expect(within(menu).getByRole('menuitem', { name: 'Insights' }).getAttribute('href')).toBe(
        '/app/insights/t1',
      );
    });

    it('opens insights from the views count', async () => {
      const { fetch } = server(lists([tour()]));
      const { router } = renderAdmin('/app/', { fetch });
      // Named for its tour: "4.4k views" alone says nothing in a list of links.
      const views = await within(await screen.findByRole('article')).findByRole('link', {
        name: 'Insights for “St Lawrence Jewry”, 4.4k views',
      });
      expect(views.textContent).toBe('4.4k views');
      expect(views.getAttribute('href')).toBe('/app/insights/t1');
      fireEvent.click(views);
      await waitFor(() => expect(router.state.location.pathname).toBe('/app/insights/t1'));
    });

    it('offers no live link for a tour that isn’t shared, but still its insights', async () => {
      const { fetch } = server(lists([tour({ publish: null })]));
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      expect(
        within(card('St Lawrence Jewry')).queryByRole('button', { name: /Copy link/ }),
      ).toBeNull();
      const menu = openMenu('St Lawrence Jewry');
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((i) => i.textContent),
      ).toEqual(['Insights', 'Duplicate', 'Delete']);
    });

    it('works the menu from the keyboard and closes it with Escape', async () => {
      const { fetch } = server(lists([tour()]));
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      const button = within(card('St Lawrence Jewry')).getByRole('button', {
        name: 'More for “St Lawrence Jewry”',
      });
      expect(button.getAttribute('aria-haspopup')).toBe('menu');
      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');
      const menu = screen.getByRole('menu');
      const items = within(menu).getAllByRole('menuitem');
      await waitFor(() => expect(document.activeElement).toBe(items[0]));
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(menu, { key: 'ArrowUp' });
      fireEvent.keyDown(menu, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(items[items.length - 1]);
      fireEvent.keyDown(menu, { key: 'Home' });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(menu, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(button.getAttribute('aria-expanded')).toBe('false');
    });

    it('closes the menu on a press outside it', async () => {
      const { fetch } = server(lists([tour()]));
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      openMenu('St Lawrence Jewry');
      fireEvent.pointerDown(document.body);
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    });

    it('opens from the keyboard with ArrowDown or ArrowUp', async () => {
      const { fetch } = server(lists([tour()]));
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      const button = within(card('St Lawrence Jewry')).getByRole('button', {
        name: 'More for “St Lawrence Jewry”',
      });
      fireEvent.keyDown(button, { key: 'ArrowDown' });
      const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
      await waitFor(() => expect(document.activeElement).toBe(items[0]));
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.keyDown(button, { key: 'ArrowUp' });
      const again = within(screen.getByRole('menu')).getAllByRole('menuitem');
      await waitFor(() => expect(document.activeElement).toBe(again[again.length - 1]));
    });

    it('closes when focus moves out of it', async () => {
      const { fetch } = server(lists([tour()]));
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      const menu = openMenu('St Lawrence Jewry');
      const first = within(menu).getAllByRole('menuitem')[0]!;
      await waitFor(() => expect(document.activeElement).toBe(first));
      // Within the menu it stays open.
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(screen.getByRole('menu')).toBeTruthy();
      act(() => screen.getByRole('link', { name: 'St Lawrence Jewry' }).focus());
      expect(screen.queryByRole('menu')).toBeNull();
    });
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
      'https://cdn.panote.dev/tiles/p2/0/nz/0-0.jpg',
    );
    // A cube face is stored mirrored; the equirect preview isn't.
    expect(img('No preview')?.style.transform).toBe('scaleX(-1)');
    expect(img('St Lawrence Jewry')?.style.transform).toBe('');
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
    // Not knowing whether they have tours, it doesn't say "back".
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome, Maya Larsson.');
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
      expect(totals()).toContain('1 pano ·');
    });

    it('does not report a resumed delete the server rolled back (409) as stuck', async () => {
      const { fetch, calls } = server({
        ...lists([tour()], [pano({ panoId: 'p-back', deleting: true })]),
        'DELETE /api/admin/panos/p-back': () => json({ error: 'pano is in use' }, 409),
      });
      renderAdmin('/app/', { fetch });
      await waitFor(() => expect(calls('DELETE /api/admin/panos/p-back')).toHaveLength(1));
      await waitFor(() => expect(screen.queryByText(/Finishing an interrupted delete/)).toBeNull());
      expect(screen.queryByRole('button', { name: 'Finish deleting' })).toBeNull();
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
      pickFromMenu('St Lawrence Jewry', 'Delete');
      fireEvent.click(screen.getByRole('button', { name: 'Delete tour' }));
      await waitFor(() => expect(mainPanoLoads(calls)).toHaveLength(2));
      expect(calls('DELETE /api/admin/panos/p-dead')).toHaveLength(1);
    });

    it('resumes once per page load, not once per dashboard mount', async () => {
      const { fetch, calls } = server({
        ...lists([tour()], [pano({ panoId: 'p-dead', deleting: true })]),
        'DELETE /api/admin/panos/p-dead': () => noContent(),
      });
      renderAdmin('/app/', { fetch });
      await waitFor(() => expect(calls('DELETE /api/admin/panos/p-dead')).toHaveLength(1));
      cleanup();
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      await waitFor(() => expect(mainPanoLoads(calls)).toHaveLength(2));
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

  describe('visibility', () => {
    const chip = (title: string) => card(title).querySelector('.dash-card__vis')!;

    it('shows it on the cover, and changes it from the menu', async () => {
      const { fetch, calls } = server({
        ...lists([tour()]),
        'PATCH /api/admin/tours/t1/visibility': () => json({ visibility: 'unlisted' }),
      });
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      // A label, not a control hiding behind a tooltip.
      expect(chip('St Lawrence Jewry').tagName).toBe('SPAN');
      expect(chip('St Lawrence Jewry').textContent).toBe('Public');
      pickFromMenu('St Lawrence Jewry', 'Make unlisted');
      await waitFor(() => expect(chip('St Lawrence Jewry').textContent).toBe('Unlisted'));
      const [, init] = calls('PATCH /api/admin/tours/t1/visibility')[0]!;
      expect(init?.body).toBe('{"visibility":"unlisted"}');
      expect(
        within(openMenu('St Lawrence Jewry')).getByRole('menuitem', { name: 'Make public' }),
      ).toBeTruthy();
    });

    it('reverts and explains a failure', async () => {
      const { fetch } = server({
        ...lists([tour()]),
        'PATCH /api/admin/tours/t1/visibility': () => json({ error: 'boom' }, 500),
      });
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      pickFromMenu('St Lawrence Jewry', 'Make unlisted');
      expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t change who');
      expect(chip('St Lawrence Jewry').textContent).toBe('Public');
    });

    it('drops to Draft on 409 not published', async () => {
      const { fetch } = server({
        ...lists([tour()]),
        'PATCH /api/admin/tours/t1/visibility': () => json({ error: 'not published' }, 409),
      });
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      pickFromMenu('St Lawrence Jewry', 'Make unlisted');
      expect((await screen.findByRole('alert')).textContent).toContain('isn’t shared yet');
      expect(chip('St Lawrence Jewry').textContent).toBe('Draft');
    });

    it('shows an unpublished tour as Draft, with nothing to change', async () => {
      const { fetch } = server(lists([tour({ publish: null })]));
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      expect(chip('St Lawrence Jewry').textContent).toBe('Draft');
      expect(
        within(openMenu('St Lawrence Jewry')).queryByRole('menuitem', { name: /Make/ }),
      ).toBeNull();
    });
  });

  const settings = { controls: 'top', showMap: true, showCompass: false, autoRotate: true };

  it('duplicates into a new unpublished tour without reusing the tourId', async () => {
    let tours = [tour()];
    const { fetch, calls } = server({
      ...lists([]),
      'GET /api/admin/tours': () => json({ tours, cursor: null }),
      'GET /api/admin/tours/t1': () =>
        json({
          tour: {
            tourId: 't1',
            title: 'St Lawrence Jewry',
            scenes: [{ panoId: 'p1' }, { panoId: 'p2' }],
            startPanoId: 'p2',
            settings,
          },
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
    await screen.findByRole('link', { name: 'St Lawrence Jewry' });
    pickFromMenu('St Lawrence Jewry', 'Duplicate');
    expect(await screen.findByRole('link', { name: 'St Lawrence Jewry (copy)' })).toBeTruthy();
    const body = JSON.parse(String(calls('POST /api/admin/tours')[0]![1]?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      title: 'St Lawrence Jewry (copy)',
      scenes: [{ panoId: 'p1' }, { panoId: 'p2' }],
      startPanoId: 'p2',
      settings,
    });
    expect(card('St Lawrence Jewry (copy)').querySelector('.dash-card__vis')!.textContent).toBe(
      'Draft',
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'changes to a scene’s points show in both',
    );
  });

  it('says why a duplicate was refused at the tour limit', async () => {
    const { fetch } = server({
      ...lists([tour()]),
      'GET /api/admin/tours/t1': () =>
        json({
          tour: { tourId: 't1', title: 'St Lawrence Jewry', scenes: [] },
          etag: 'e1',
          publish: null,
        }),
      'POST /api/admin/tours': () => json({ error: 'tour limit reached' }, 403),
    });
    renderAdmin('/app/', { fetch });
    await screen.findByRole('link', { name: 'St Lawrence Jewry' });
    pickFromMenu('St Lawrence Jewry', 'Duplicate');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Couldn’t duplicate “St Lawrence Jewry”. This account has reached its limit of 200 tours.',
    );
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
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      pickFromMenu('St Lawrence Jewry', 'Delete');
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
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      pickFromMenu('St Lawrence Jewry', 'Delete');
      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete tour' }));
      expect((await within(dialog).findByRole('alert')).textContent).toContain(message);
      expect(screen.getByRole('link', { name: 'St Lawrence Jewry' })).toBeTruthy();
    });

    it('drops a deleted tour’s views from the total', async () => {
      const { fetch } = server({
        ...lists([tour(), tour({ tourId: 't2', title: 'Town Hall' })]),
        'DELETE /api/admin/tours/t1': () => noContent(),
      });
      renderAdmin('/app/', { fetch });
      await waitFor(() => expect(totals()).toBe('2 tours · 1 pano · 4.4k views'));
      pickFromMenu('St Lawrence Jewry', 'Delete');
      fireEvent.click(screen.getByRole('button', { name: 'Delete tour' }));
      await waitFor(() => expect(totals()).toBe('1 tour · 1 pano · 12 views'));
    });

    it('treats a 404 as already deleted', async () => {
      const { fetch } = server({
        ...lists([tour()]),
        'DELETE /api/admin/tours/t1': () => json({ error: 'not found' }, 404),
      });
      renderAdmin('/app/', { fetch });
      await screen.findByRole('link', { name: 'St Lawrence Jewry' });
      pickFromMenu('St Lawrence Jewry', 'Delete');
      fireEvent.click(screen.getByRole('button', { name: 'Delete tour' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.queryByRole('link', { name: 'St Lawrence Jewry' })).toBeNull();
    });
  });

  it('moves Current to an own tour opened from its card, but not to a shared one', async () => {
    window.localStorage.setItem('panote.currentTour', 't2');
    const { fetch } = server(
      lists([tour(), tour({ tourId: 't2', title: 'Town Hall' })], undefined, [shared()]),
    );
    const { router } = renderAdmin('/app/?view=shared', { fetch });
    fireEvent.click(await screen.findByRole('link', { name: 'Harbour walk' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/t/s1'));
    expect(window.localStorage.getItem('panote.currentTour')).toBe('t2');
    cleanup();

    const again = renderAdmin('/app/', { fetch });
    fireEvent.click(await screen.findByRole('link', { name: 'St Lawrence Jewry' }));
    await waitFor(() => expect(again.router.state.location.pathname).toBe('/app/t/t1'));
    expect(window.localStorage.getItem('panote.currentTour')).toBe('t1');
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
