import type { ExploreTour } from '@internal/contracts';
import { loadConfig } from '@internal/web-kit';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { fakeAuth, LOCAL, renderSite } from '../__fixtures__/auth.js';
import { AuthEnvContext } from '../auth-context.js';
import { ConfigContext } from '../config-context.js';
import { routes } from '../routes.js';
import { EXPLORE_TITLE, MAX_EMPTY_PAGE_HOPS } from './Explore.js';

configure({ asyncUtilTimeout: 5000 });
beforeAll(async () => {
  await Promise.all([import('../Shell.js'), import('../pages.js')]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CDN = 'https://cdn.test/';
const config = loadConfig({
  VITE_SITE_ORIGIN: 'https://panote.test',
  VITE_CDN_BASE: CDN,
  VITE_API_BASE: 'https://api.test',
  VITE_AUTH0_DOMAIN: 'tenant.auth0.com',
  VITE_AUTH0_CLIENT_ID: 'YOUR_CLIENT',
  VITE_AUTH0_AUDIENCE: 'https://api.test',
});

const tour = (n: number, extra: Partial<ExploreTour> = {}): ExploreTour => ({
  tourId: `tour-${n}`,
  slug: `slug-${n}`,
  title: `Tour ${n}`,
  sceneCount: n,
  cover: { panoId: `pano-${n}`, version: 't1-abc', image: 'og' },
  publishedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...extra,
});

type Reply = { tours: ExploreTour[]; cursor: string | null } | number;

/** Answers /api/explore with `pages[cursor ?? '']`; a number is an error status. */
const stubExplore = (pages: Record<string, Reply>) => {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const reply = pages[url.searchParams.get('cursor') ?? ''];
    if (reply === undefined || typeof reply === 'number') {
      return Response.json({ error: 'nope' }, { status: typeof reply === 'number' ? reply : 404 });
    }
    return Response.json(reply);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

const renderExplore = () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/explore'] });
  render(
    <ConfigContext value={config}>
      <AuthEnvContext value={{ auth: fakeAuth(), origins: LOCAL }}>
        <RouterProvider router={router} />
      </AuthEnvContext>
    </ConfigContext>,
  );
  return router;
};

const grid = () => screen.getAllByRole('list').find((l) => l.className === 'explore__grid')!;

describe('/explore', () => {
  it('shows a loading state, then a card per tour linking to its share page', async () => {
    const fetch = stubExplore({ '': { tours: [tour(1), tour(3, { cover: null })], cursor: null } });
    renderExplore();
    expect(await screen.findByRole('status')).toBeTruthy();
    const first = await screen.findByRole('link', { name: /Tour 1/ });
    expect(first.getAttribute('href')).toBe('/s/slug-1');
    expect(within(first).getByText('1 scene')).toBeTruthy();
    expect(within(first).getByRole('presentation').getAttribute('src')).toBe(
      `${CDN}tiles/pano-1/t1-abc/og.jpg`,
    );
    const second = screen.getByRole('link', { name: /Tour 3/ });
    expect(within(second).getByText('3 scenes')).toBeTruthy();
    expect(second.querySelector('img')).toBeNull();
    expect(fetch).toHaveBeenCalledWith('https://api.test/api/explore', expect.anything());
    // No more pages: no Load more.
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(document.title).toBe(EXPLORE_TITLE);
  });

  it('loads the next page by cursor and appends it, once per tour', async () => {
    stubExplore({
      '': { tours: [tour(1), tour(2)], cursor: '8299999999999-tour-2' },
      '8299999999999-tour-2': { tours: [tour(2), tour(4)], cursor: null },
    });
    renderExplore();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByRole('link', { name: /Tour 4/ });
    expect(
      within(grid())
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/s/slug-1', '/s/slug-2', '/s/slug-4']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('keeps the cards when a later page fails, and lets the visitor retry', async () => {
    const pages: Record<string, Reply> = {
      '': { tours: [tour(1)], cursor: '8299999999999-tour-1' },
      '8299999999999-tour-1': 503,
    };
    stubExplore(pages);
    renderExplore();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load more');
    expect(screen.getByRole('link', { name: /Tour 1/ })).toBeTruthy();
    pages['8299999999999-tour-1'] = { tours: [tour(5)], cursor: null };
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('link', { name: /Tour 5/ });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('skips past empty pages that still have a cursor, up to a cap', async () => {
    const fetch = stubExplore({
      '': { tours: [], cursor: '0000000000001-a' },
      '0000000000001-a': { tours: [], cursor: '0000000000002-b' },
      '0000000000002-b': { tours: [tour(9)], cursor: null },
    });
    renderExplore();
    await screen.findByRole('link', { name: /Tour 9/ });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('heading', { name: 'No public tours yet' })).toBeNull();
  });

  it('stops following empty pages after MAX_EMPTY_PAGE_HOPS and offers Load more', async () => {
    const pages: Record<string, Reply> = {};
    const cursors = Array.from({ length: 6 }, (_, i) => `000000000000${i}-c`);
    pages[''] = { tours: [], cursor: cursors[0]! };
    cursors.forEach((c, i) => {
      pages[c] = { tours: [], cursor: cursors[i + 1] ?? null };
    });
    const fetch = stubExplore(pages);
    renderExplore();
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1 + MAX_EMPTY_PAGE_HOPS);
  });

  it('shows an empty state when nothing is listed', async () => {
    stubExplore({ '': { tours: [], cursor: null } });
    renderExplore();
    expect(await screen.findByRole('heading', { name: 'No public tours yet' })).toBeTruthy();
  });

  it('shows an error state with a retry when the first page fails', async () => {
    const pages: Record<string, Reply> = { '': 500 };
    stubExplore(pages);
    renderExplore();
    expect(await screen.findByRole('heading', { name: 'Couldn’t load tours' })).toBeTruthy();
    pages[''] = { tours: [tour(7)], cursor: null };
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('link', { name: /Tour 7/ });
  });

  it('a broken cover image falls back to the placeholder', async () => {
    stubExplore({ '': { tours: [tour(1)], cursor: null } });
    renderExplore();
    const card = await screen.findByRole('link', { name: /Tour 1/ });
    fireEvent.error(card.querySelector('img')!);
    await waitFor(() => expect(card.querySelector('img')).toBeNull());
  });

  it('cards name no owner', async () => {
    stubExplore({ '': { tours: [tour(1)], cursor: null } });
    renderExplore();
    const card = await screen.findByRole('link', { name: /Tour 1/ });
    expect(card.textContent).toBe('Tour 11 scene');
  });
});

describe('Explore with no app config', () => {
  it('shows the error state and has nothing to retry', async () => {
    renderSite('/explore');
    expect(await screen.findByRole('heading', { name: 'Couldn’t load tours' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('Explore in the site nav', () => {
  it('the header and the footer link to /explore', async () => {
    renderSite('/privacy');
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByRole('link', { name: 'Explore' }).getAttribute('href')).toBe(
      '/explore',
    );
    const product = screen.getByRole('navigation', { name: 'Product' });
    expect(within(product).getByRole('link', { name: 'Explore' }).getAttribute('href')).toBe(
      '/explore',
    );
  });
});

describe('Explore in the privacy page', () => {
  it('says what a public tour shows on Explore', async () => {
    renderSite('/privacy');
    await screen.findByRole('heading', { name: 'What we keep' });
    const text = screen.getByRole('article').textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('a public tour is also listed on Explore');
    expect(text).toContain('never your name');
  });
});
